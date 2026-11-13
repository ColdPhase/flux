import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, beforeEach, describe, test } from 'node:test';
import { filePath } from '@flux/contracts';
import { pool } from './support/db.js';
import type { Person } from './support/people.js';
import { assistantScene, changesOf, human, result, text, type AssistantScene } from './support/assistant-scene.js';
import { png } from './support/pictures.js';
import { assertSamePixels } from './support/picture-pixels.js';

// Founder decision on #1217 (2026-11-12): pictures work in the agent's private chat too, at once and with no Undo (the chat changes nothing).
// On the real /mcp route with a run's token; the closed world's `public.test` is the link mock.

const SITE = process.env.FLUX_LINK_MOCK_URL ?? 'http://linkmock:8098';
const at = (path: string) => `http://public.test${path}`;
const download = async (who: Person, id: string) => {
  const response = await fetch(new URL(filePath(id), who.browser.base), { headers: { cookie: who.browser.cookieHeader() } });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { status: response.status, bytes, text: bytes.toString('latin1') };
};
const pictures = async (runId: string) => (await pool.query(`SELECT id, name, position FROM personal_run_pictures WHERE run_id = $1 ORDER BY position`, [runId])).rows as
  { id: string; name: string; position: number }[];

describe('pictures in the agent\'s private chat (#1217)', () => {
  let scene: AssistantScene;
  before(async () => { scene = await assistantScene('chp'); });
  beforeEach(async () => { await scene.reset(); await fetch(`${SITE}/__reset`); });

  const chatRun = async (prompt = 'show me a raised bed') => {
    const started = await scene.runs.invoke(human(scene.owner), { kind: 'chat', agentId: scene.agentId }, { clientRunId: randomUUID(), kind: 'ask', prompt });
    return scene.liveOf(started.run.id);
  };

  test('the chat\'s answer carries the picture at once, only its owner opens it, and it shows with the run', async () => {
    const run = await chatRun();
    assert.ok(run.tools.includes('flux_attach_image'), 'the chat run has the tool');
    const command = randomUUID();
    const said = await run.call('flux_attach_image', { clientCommandId: command, url: at('/pic/raised-bed.png'), caption: 'Raised bed' });
    assert.equal(result(said.message)?.isError, undefined, text(said.message));
    assert.match(text(said.message), /only your owner sees it/);
    const again = await run.call('flux_attach_image', { clientCommandId: command, url: at('/pic/raised-bed.png'), caption: 'Raised bed' });
    assert.match(text(again.message), /"replayed":true/, 'a retry of the same call attaches nothing more');
    const [picture, ...more] = await pictures(run.runId);
    assert.deepEqual([picture!.name, more.length], ['Raised bed.png', 0]);
    assert.deepEqual((await changesOf(run.runId)), [], 'no change log in a chat: it changes nothing');
    const own = await download(scene.owner, picture!.id);
    assert.equal(own.status, 200);
    await assertSamePixels(own.bytes, png(96, 64), 'only the picture, decoded and written again');
    for (const secret of ['Ada Nowak', 'GPS', 'tIME', 'PK\x03\x04', '<script>']) assert.ok(!own.text.includes(secret), `${secret} is gone`);
    assert.equal((await download(scene.peer, picture!.id)).status, 404, 'nobody else opens it');
    await scene.complete(run.runId);
    const view = await scene.runs.get(human(scene.owner), run.runId);
    assert.deepEqual(view.pictures, [{ id: picture!.id, name: 'Raised bed.png', size: own.bytes.length }]);
  });

  test('two calls of the same id at once save one picture, and neither takes the other\'s bytes away', async () => {
    const run = await chatRun();
    const command = randomUUID();
    const call = () => run.call('flux_attach_image', { clientCommandId: command, url: at('/pic/leaf.webp') });
    const both = await Promise.all([call(), call()]);
    for (const said of both) assert.equal(result(said.message)?.isError, undefined, text(said.message));
    const saved = await pictures(run.runId);
    assert.equal(saved.length, 1);
    assert.equal((await download(scene.owner, saved[0]!.id)).status, 200, 'its bytes are there');
    await scene.complete(run.runId);
  });

  test('in the chat too a refusal is plain words, and nothing is kept', async () => {
    const run = await chatRun();
    for (const [url, words] of [[at('/pic/drawing.svg'), /SVG drawing/], ['http://127.0.0.1/a.png', /only pictures at public web addresses/], [at('/pic/to-private'), /only pictures at public web addresses/]] as const) {
      const said = await run.call('flux_attach_image', { url });
      assert.equal(result(said.message)?.isError, true, url);
      assert.match(text(said.message), words, url);
    }
    assert.deepEqual(await pictures(run.runId), []);
    // A chat's place is no space: naming one is refused like any change outside the run's place.
    assert.match(text((await run.call('flux_attach_image', { projectId: scene.place.id, url: at('/pic/leaf.webp') })).message), /OUTSIDE_RUN_PLACE/);
    await scene.complete(run.runId);
  });
});
