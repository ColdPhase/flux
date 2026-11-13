import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, beforeEach, describe, test } from 'node:test';
import { assistantChangeActionPath, assistantRunShowPath, filePath, imageTypeOf, pictureBounds, type ShowAnswerResult } from '@flux/contracts';
import { type PersonalComputeResult } from '@flux/core';
import { pool } from './support/db.js';
import { expectStatus } from './support/people.js';
import { assistantScene, changesOf, human, result, text, type AssistantScene } from './support/assistant-scene.js';
import { png } from './support/pictures.js';
import { assertSamePixels } from './support/picture-pixels.js';
// The pictures are read back with the same sharp the server uses (its own dependency, not the test workspace's).
import sharp from '../../apps/server/node_modules/sharp/dist/index.mjs';

// An agent attaches a picture to its answer (#1217, F-036 AG-8, C-59), on the real /mcp route with a run's token and through the real worker
// loop with a fake provider. The API of the check stack reaches the link mock as `public.test` (a closed world: every other address, and
// every IP literal, is not public). The server downloads the picture, keeps only the picture, stages it for the asker, and Show everyone
// posts it with the answer, where every member of the space can open it. Every refusal is plain words, and nothing is kept.

const SITE = process.env.FLUX_LINK_MOCK_URL ?? 'http://linkmock:8098';
const at = (path: string) => `http://public.test${path}`;
const hits = async (prefix = '/pic') => (await (await fetch(`${SITE}/__hits?prefix=${encodeURIComponent(prefix)}`)).json()) as { path: string }[];
const usage = { inputTokens: 300, outputTokens: 20 };
const calls = (...list: { name: string; input: Record<string, unknown> }[]): PersonalComputeResult => ({ kind: 'completed', text: 'working', stopReason: 'tool_use', usage,
  toolCalls: list.map((call, index) => ({ id: `call-${index}-${randomUUID()}`, name: call.name, input: call.input })) });
const answer = (words: string): PersonalComputeResult => ({ kind: 'completed', text: words, stopReason: 'end_turn', usage });
const stagedFor = async (userId: string) => (await pool.query(`SELECT id, name, size, message_id, uploader_id, uploader_agent_id FROM project_files
  WHERE uploader_id = $1 AND message_id IS NULL ORDER BY created_at`, [userId])).rows as { id: string; name: string; size: number; message_id: string | null; uploader_id: string | null; uploader_agent_id: string | null }[];
const pictureChanges = async (runId: string) => (await changesOf(runId)).filter((row) => row.operation === 'answer.picture.attach');
const download = async (who: AssistantScene['owner'], id: string) => {
  const response = await fetch(new URL(filePath(id), who.browser.base), { headers: { cookie: who.browser.cookieHeader() } });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { status: response.status, bytes, text: bytes.toString('latin1') };
};

describe('flux_attach_image: an agent attaches a public picture to its answer', () => {
  let scene: AssistantScene;
  before(async () => { scene = await assistantScene('pic'); });
  beforeEach(async () => {
    await scene.reset();
    await fetch(`${SITE}/__reset`);
    scene.compute.dispatched.length = 0;
    await pool.query(`DELETE FROM project_files WHERE uploader_id = $1 AND message_id IS NULL`, [scene.owner.id]);
  });

  test('/ai "find a picture of a raised garden bed and show it": the picture is the asker\'s until Show everyone, then every member sees it', async () => {
    const replies = [calls({ name: 'flux_attach_image', input: { clientCommandId: randomUUID(), url: at('/pic/raised-bed.png'), caption: 'Raised garden bed' } }),
      answer('Here is a raised garden bed made of larch boards, from public.test.')];
    scene.compute.respond = async () => replies.shift()!;
    const started = await scene.runs.invoke(human(scene.owner), scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'find a picture of a raised garden bed and show it' });
    assert.equal(await scene.processor.process(started.run.id), 'completed');
    // The provider was offered the tool, and told how to use it; the tool's words came back as plain text.
    assert.ok(scene.compute.dispatched[0]!.tools?.some((tool) => tool.name === 'flux_attach_image'), 'offered on /ai in a space');
    assert.match(scene.compute.dispatched[0]!.system, /attach it to your answer with flux_attach_image/);
    assert.match(JSON.stringify(scene.compute.dispatched[1]!.turns), /The picture is attached to your answer/);
    // One applied change, its line, and the file: the asker's, staged, with only the picture in it.
    const [change] = await pictureChanges(started.run.id);
    assert.deepEqual([change!.state, change!.object_title], ['applied', 'Raised garden bed from public.test/pic/raised-bed.png'], 'its line names where it comes from');
    const [file] = await stagedFor(scene.owner.id);
    assert.deepEqual([file!.name, file!.message_id, file!.uploader_agent_id, change!.object_id], ['Raised garden bed.png', null, null, file!.id]);
    const own = await download(scene.owner, file!.id);
    assert.equal(own.status, 200);
    const bytes = own.bytes;
    assert.equal(imageTypeOf(bytes), 'image/png');
    // The picture is decoded and written again (#1343): the same pixels, with none of its text chunks and nothing that was appended to it.
    await assertSamePixels(bytes, png(96, 64), 'the picture as the site sent it');
    for (const secret of ['Ada Nowak', 'GPS', 'tIME', 'PK\x03\x04', '<script>']) assert.ok(!own.text.includes(secret), `${secret} is gone`);
    assert.equal((await download(scene.peer, file!.id)).status, 404, 'nobody else sees a private answer\'s picture');
    // Show everyone: the asker's own message, "via" the agent, with the picture as its attachment.
    const shown = expectStatus(await scene.owner.browser.request('POST', assistantRunShowPath(started.run.id)), 200) as ShowAnswerResult;
    const attached = (await pool.query(`SELECT id, position FROM project_files WHERE message_id = $1`, [shown.messageId])).rows;
    assert.deepEqual(attached, [{ id: file!.id, position: 0 }]);
    const posted = (await pool.query(`SELECT author_id, via, attachment_count FROM project_messages WHERE id = $1`, [shown.messageId])).rows[0];
    assert.deepEqual([posted.author_id, posted.attachment_count], [scene.owner.id, 1]);
    assert.ok(posted.via, 'marked via the agent');
    assert.equal((await download(scene.peer, file!.id)).status, 200, 'every member of the space opens it now');
    assert.equal((await download(scene.stranger, file!.id)).status, 404, 'and nobody outside the space');
    // Undo after Show everyone takes nothing from the asker's own message.
    const undone = expectStatus(await scene.owner.browser.request('POST', assistantChangeActionPath(change!.id, 'undo'), { body: {} }), 200) as { message: string | null };
    assert.match(undone.message ?? '', /Already posted with Show everyone/);
    assert.equal((await download(scene.peer, file!.id)).status, 200);
  });

  test('Undo before Show everyone removes the picture, and Show everyone then posts the answer without it', async () => {
    const run = await scene.liveRun(undefined, 'show me a leaf');
    const said = await run.call('flux_attach_image', { url: at('/pic/leaf.webp') });
    assert.equal(result(said.message)?.isError, undefined, text(said.message));
    const [change] = await pictureChanges(run.runId);
    const [file] = await stagedFor(scene.owner.id);
    assert.equal(file!.name, 'leaf.webp', 'named after the address when there is no caption');
    expectStatus(await scene.owner.browser.request('POST', assistantChangeActionPath(change!.id, 'undo'), { body: {} }), 200);
    assert.deepEqual(await stagedFor(scene.owner.id), [], 'the file is gone');
    assert.equal((await pictureChanges(run.runId))[0]!.state, 'undone');
    await scene.complete(run.runId);
    const shown = expectStatus(await scene.owner.browser.request('POST', assistantRunShowPath(run.runId)), 200) as ShowAnswerResult;
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM project_files WHERE message_id = $1`, [shown.messageId])).rows[0].n, 0);
  });

  test('a JPEG loses its EXIF location and comments; an untyped body that is a picture is kept as one; a redirect to a public picture follows', async () => {
    const run = await scene.liveRun(undefined, 'pictures please');
    for (const path of ['/pic/photo.jpg', '/pic/untyped', '/pic/moved.png']) {
      const said = await run.call('flux_attach_image', { url: at(path) });
      assert.equal(result(said.message)?.isError, undefined, `${path}: ${text(said.message)}`);
    }
    const files = await stagedFor(scene.owner.id);
    assert.deepEqual(files.map((file) => file.name), ['photo.jpg', 'untyped.png', 'raised-bed.png'], 'the extension is the real type\'s, the name the picture\'s own');
    const jpeg = await download(scene.owner, files[0]!.id);
    for (const secret of ['GPS', 'Ada Nowak', 'Taken at home', 'Exif']) assert.ok(!jpeg.text.includes(secret), `${secret} is gone`);
    // Every address the server asked for is one of the run's sources, the redirect hop too.
    const asked = (await pool.query(`SELECT final_url, outcome FROM personal_run_web_reads WHERE run_id = $1 ORDER BY read_at, id`, [run.runId])).rows;
    assert.deepEqual(asked.map((row) => [row.final_url, row.outcome]), [[at('/pic/photo.jpg'), 'read'], [at('/pic/untyped'), 'read'],
      [at('/pic/moved.png'), 'redirected'], [at('/pic/raised-bed.png'), 'read']]);
    await scene.complete(run.runId);
  });

  test('a stored picture is decoded and written again: a turned JPEG is upright without its EXIF or what hid in it, a GIF keeps its frames, a WebP is the picture it says (#1343)', async () => {
    const run = await scene.liveRun(undefined, 'pictures please');
    for (const path of ['/pic/jpeg-turned.jpg', '/pic/jpeg-thumbnail.jpg', '/pic/moving.gif', '/pic/solid-64x48.webp']) {
      const said = await run.call('flux_attach_image', { url: at(path) });
      assert.equal(result(said.message)?.isError, undefined, `${path}: ${text(said.message)}`);
    }
    const files = await stagedFor(scene.owner.id);
    assert.deepEqual(files.map((file) => file.name), ['jpeg-turned.jpg', 'jpeg-thumbnail.jpg', 'moving.gif', 'solid-64x48.webp']);
    const [turned, thumbnail, moving, small] = await Promise.all(files.map((file) => download(scene.owner, file.id)));
    // What libvips reads from each stored file is what the server reported and every header of the file says: nothing else is left to draw.
    const sizes = await Promise.all([turned!, thumbnail!, moving!, small!].map(async ({ bytes }) => {
      const meta = await sharp(bytes).metadata();
      assert.deepEqual(pictureBounds(bytes), { width: meta.width, height: meta.height }, 'no header claims another size');
      return [meta.format, meta.width, meta.height, meta.pages ?? 1];
    }));
    assert.deepEqual(sizes, [['jpeg', 8, 16, 1], ['jpeg', 16, 8, 1], ['gif', 1, 1, 3], ['webp', 64, 48, 1]], 'the 16×8 picture was held a quarter turn');
    for (const secret of ['Exif', 'GPS', 'Ada Nowak', 'xmpmeta', 'Taken at home', '<script>']) assert.ok(!turned!.text.includes(secret), `${secret} is gone`);
    assert.ok(!thumbnail!.text.includes('Exif'), 'the thumbnail with a size of its own went with the EXIF');
    assert.ok(moving!.text.includes('NETSCAPE2.0') && !moving!.text.includes('GPS'), 'the animation loops, its comment is gone');
    await scene.complete(run.runId);
  });

  test('every refusal is plain words, nothing is kept and no change is made: private addresses and redirects to them, non-pictures, SVG, too large, a bomb', async () => {
    const run = await scene.liveRun(undefined, 'attach these');
    const refusals: [string, RegExp, boolean][] = [
      // Private, local and metadata addresses, as written and as a redirect hop (IPv6 loopback and an IPv4-mapped IPv6 address included).
      ['http://127.0.0.1/pic/raised-bed.png', /only pictures at public web addresses/, false],
      ['http://169.254.169.254/latest/meta-data/', /only pictures at public web addresses/, false],
      ['http://[::1]/a.png', /only pictures at public web addresses/, false],
      ['http://[::ffff:127.0.0.1]/a.png', /only pictures at public web addresses/, false],
      ['http://linkmock/pic/raised-bed.png', /only pictures at public web addresses/, false],
      ['http://localhost/a.png', /only pictures at public web addresses/, false],
      ['http://public.test:8098/pic/raised-bed.png', /only pictures at public web addresses/, false],
      ['file:///etc/passwd', /only pictures at public web addresses/, false],
      [at('/pic/to-private'), /only pictures at public web addresses/, true],
      [at('/pic/to-loopback'), /only pictures at public web addresses/, true],
      [at('/pic/to-metadata'), /only pictures at public web addresses/, true],
      [at('/pic/to-ipv6'), /only pictures at public web addresses/, true],
      [at('/pic/to-mapped'), /only pictures at public web addresses/, true],
      [at('/pic/to-port'), /only pictures at public web addresses/, true],
      // What must never become a picture.
      [at('/pic/page.html'), /not a picture: only PNG, JPEG, WebP and GIF/, true],
      [at('/pic/drawing.svg'), /SVG drawing, which cannot be attached/, true],
      [at('/pic/disguised.png'), /SVG drawing, which cannot be attached/, true],
      [at('/pic/huge.png'), /larger than 5 MB/, true],
      [at('/pic/huge-declared.png'), /larger than 5 MB/, true],
      [at('/pic/bomb.png'), /too big to show: at most 8,000 pixels/, true],
      // #1343, the audit of #1270: files a header check and a decoder read differently. None of them is stored, whatever a browser would draw.
      [at('/pic/two-chunks.webp'), /damaged and cannot be read/, true],
      [at('/pic/two-chunks-reversed.webp'), /damaged and cannot be read/, true],
      [at('/pic/two-lossy-chunks.webp'), /damaged and cannot be read/, true],
      [at('/pic/vp8x-still.webp'), /damaged and cannot be read/, true],
      [at('/pic/vp8x-anim.webp'), /damaged and cannot be read/, true],
      [at('/pic/apng-wide.png'), /damaged and cannot be read/, true],
      [at('/pic/solid-16383.webp'), /too big to show: at most 8,000 pixels/, true],
      [at('/pic/jpeg-bomb.jpg'), /too big to show: at most 8,000 pixels/, true],
      [at('/pic/missing.png'), /did not answer with the picture/, true],
      ['not an address', /not a web address/, false],
    ];
    for (const [url, words, sent] of refusals) {
      await fetch(`${SITE}/__reset`);
      const said = await run.call('flux_attach_image', { url });
      assert.equal(result(said.message)?.isError, true, url);
      assert.match(text(said.message), /^Not attached\. /, `${url}: plain words, not a code: ${text(said.message)}`);
      assert.match(text(said.message), words, `${url}: ${text(said.message)}`);
      assert.ok(!/[A-Z_]{8,}|"code"/.test(text(said.message)), `${url}: no raw tool error`);
      if (!sent) assert.deepEqual(await hits('/'), [], `${url}: nothing reached the site`);
      if (url.includes('/pic/to-private')) assert.deepEqual((await hits('/')).map((hit) => hit.path), ['/pic/to-private'], 'the private hop itself was never asked');
    }
    assert.deepEqual(await stagedFor(scene.owner.id), [], 'nothing was kept');
    assert.deepEqual(await pictureChanges(run.runId), [], 'and no change was made');
    await scene.complete(run.runId);
  });

  test('an address carrying private Flux text the run read is refused before anything is sent (C-30)', async () => {
    expectStatus(await scene.peer.browser.request('POST', `/api/v1/conversations/${scene.thread.id}/messages`,
      { body: { body: 'The alarm code is 4471-PANDA-OAK, keep it here', clientMessageId: randomUUID() } }), 201);
    const run = await scene.liveRun(undefined, 'show a picture');
    // The run reads the conversation first, so the message is text it read.
    const talk = await run.call('flux_get_conversation', { projectId: scene.place.id, id: scene.thread.id });
    assert.equal(result(talk.message)?.isError, undefined, text(talk.message));
    const said = await run.call('flux_attach_image', { url: at('/pic/raised-bed.png?c=4471-PANDA-OAK') });
    assert.equal(result(said.message)?.isError, true);
    assert.match(text(said.message), /nothing from Flux may go into a web address/);
    assert.deepEqual(await hits('/'), []);
    await scene.complete(run.runId);
  });

  test('Ask me first: nothing is fetched until the owner\'s Approve, which downloads and attaches it; Only read is never offered the tool', async () => {
    await scene.setMayDo('ask');
    const run = await scene.liveRun(undefined, 'show a garden bed');
    const said = await run.call('flux_attach_image', { url: at('/pic/raised-bed.png'), caption: 'A bed' });
    assert.match(text(said.message), /^Waiting for .+'s OK: attach picture A bed from public\.test\/pic\/raised-bed\.png\./, text(said.message));
    assert.deepEqual(await hits('/'), [], 'the site was not asked');
    assert.deepEqual(await stagedFor(scene.owner.id), []);
    const [waiting] = await pictureChanges(run.runId);
    assert.equal(waiting!.state, 'waiting');
    await scene.complete(run.runId);
    expectStatus(await scene.owner.browser.request('POST', assistantChangeActionPath(waiting!.id, 'apply'), { body: {} }), 200);
    assert.equal((await pictureChanges(run.runId))[0]!.state, 'applied_after_wait');
    assert.deepEqual((await stagedFor(scene.owner.id)).map((file) => file.name), ['A bed.png']);
    assert.deepEqual((await hits('/')).map((hit) => hit.path), ['/pic/raised-bed.png']);
    await scene.setMayDo('read');
    const reading = await scene.liveRun(undefined, 'show a garden bed');
    assert.ok(!reading.tools.includes('flux_attach_image'), 'Only read: no tool');
    await scene.complete(reading.runId);
  });

  test('Ask me first: an address carrying private Flux text is refused at once and never waits (review of #1288, P1)', async () => {
    await scene.setMayDo('ask');
    expectStatus(await scene.peer.browser.request('POST', `/api/v1/conversations/${scene.thread.id}/messages`,
      { body: { body: 'The alarm code is 4471-PANDA-OAK, keep it here', clientMessageId: randomUUID() } }), 201);
    const run = await scene.liveRun(undefined, 'show a picture');
    const talk = await run.call('flux_get_conversation', { projectId: scene.place.id, id: scene.thread.id });
    assert.equal(result(talk.message)?.isError, undefined, text(talk.message));
    const said = await run.call('flux_attach_image', { url: at('/pic/raised-bed.png?c=4471-PANDA-OAK'), caption: 'Raised garden bed' });
    assert.equal(result(said.message)?.isError, true);
    assert.match(text(said.message), /^Not attached\. .*nothing from Flux may go into a web address/);
    assert.deepEqual(await pictureChanges(run.runId), [], 'nothing waits');
    assert.deepEqual(await hits('/'), []);
    await scene.complete(run.runId);
  });

  test('Ask me first: the run keeps its private text while a picture waits; Approve refuses a redirect hop that carries it and lists what it asked', async () => {
    await scene.setMayDo('ask');
    expectStatus(await scene.peer.browser.request('POST', `/api/v1/conversations/${scene.thread.id}/messages`,
      { body: { body: 'The gate code is 5582-OTTER-ELM, keep it here', clientMessageId: randomUUID() } }), 201);
    const run = await scene.liveRun(undefined, 'show the bed picture');
    const talk = await run.call('flux_get_conversation', { projectId: scene.place.id, id: scene.thread.id });
    assert.equal(result(talk.message)?.isError, undefined, text(talk.message));
    // A site that unpacks what it was sent (written backwards) and redirects to it: the first address carries no private text, its hop does.
    const target = `${at('/pic/raised-bed.png')}?c=5582-OTTER-ELM`;
    const url = at(`/unpack/${encodeURIComponent([...target].reverse().join(''))}`);
    assert.match(text((await run.call('flux_attach_image', { url })).message), /^Waiting for /);
    await scene.complete(run.runId);
    const kept = async () => (await pool.query(`SELECT count(*)::int AS n FROM personal_run_private_texts WHERE run_id = $1`, [run.runId])).rows[0].n as number;
    assert.ok(await kept() > 0, 'the run ended, and its private text is kept while the picture waits');
    const [waiting] = await pictureChanges(run.runId);
    // Approve answers with the reason it was not made, and the change is closed (it needs Ask again, never a second Approve).
    const decided = await scene.owner.browser.request('POST', assistantChangeActionPath(waiting!.id, 'apply'), { body: {} });
    assert.equal(decided.status, 403, decided.text);
    assert.match((decided.json as { error: string }).error, /nothing from Flux may go into a web address/);
    const asked = (await hits('/')).map((hit) => hit.path);
    assert.equal(asked.length, 1, `only the first address was asked: ${asked.join(', ')}`);
    assert.ok(asked[0]!.startsWith('/unpack/'), 'the hop with the private text never was');
    assert.equal((await pictureChanges(run.runId))[0]!.state, 'refused');
    assert.equal(await kept(), 0, 'decided, and the run over: the private text goes');
    const listed = (await pool.query(`SELECT final_url FROM personal_run_web_reads WHERE run_id = $1`, [run.runId])).rows.map((row) => row.final_url as string);
    assert.ok(listed.some((address) => address.includes('/unpack/')), 'Approve lists what it asked with the run\'s sources');
  });

  test('a picture still waiting when its answer is shown or put away is closed, and the run\'s kept private text goes (privacy)', async () => {
    await scene.setMayDo('ask');
    const kept = async (runId: string) => (await pool.query(`SELECT count(*)::int AS n FROM personal_run_private_texts WHERE run_id = $1`, [runId])).rows[0].n as number;
    for (const end of ['show', 'dismiss'] as const) {
      const run = await scene.liveRun(undefined, `a picture (${end})`);
      const talk = await run.call('flux_get_conversation', { projectId: scene.place.id, id: scene.thread.id });
      assert.equal(result(talk.message)?.isError, undefined, text(talk.message));
      assert.match(text((await run.call('flux_attach_image', { url: at('/pic/leaf.webp') })).message), /^Waiting for /);
      await scene.complete(run.runId);
      assert.ok(await kept(run.runId) > 0, `${end}: kept while the picture waits`);
      expectStatus(await scene.owner.browser.request('POST', end === 'show' ? assistantRunShowPath(run.runId) : `/api/v1/assistant-runs/${run.runId}/dismiss`), 200);
      const [closed] = await pictureChanges(run.runId);
      assert.equal(closed!.state, 'refused', end);
      assert.match(closed!.refusal ?? '', end === 'show' ? /shown to everyone before this picture was approved/ : /put away before this picture was approved/);
      assert.equal(await kept(run.runId), 0, `${end}: the run's private text goes`);
    }
    assert.deepEqual(await hits('/'), [], 'nothing was ever fetched');
  });

  test('Ask me first: Approve fetches a plain picture and lists it with the run\'s sources', async () => {
    await scene.setMayDo('ask');
    const run = await scene.liveRun(undefined, 'show a leaf');
    assert.match(text((await run.call('flux_attach_image', { url: at('/pic/leaf.webp') })).message), /^Waiting for /);
    await scene.complete(run.runId);
    const [waiting] = await pictureChanges(run.runId);
    expectStatus(await scene.owner.browser.request('POST', assistantChangeActionPath(waiting!.id, 'apply'), { body: {} }), 200);
    assert.equal((await pictureChanges(run.runId))[0]!.state, 'applied_after_wait');
    const listed = (await pool.query(`SELECT final_url, outcome FROM personal_run_web_reads WHERE run_id = $1`, [run.runId])).rows;
    assert.deepEqual(listed.map((row) => [row.final_url, row.outcome]), [[at('/pic/leaf.webp'), 'read']]);
  });

  test('only an answer to /ai in a space: a task\'s run has no tool, and an answer already shown takes none', async () => {
    const live = await scene.liveRun(undefined, 'a picture');
    assert.ok(live.tools.includes('flux_attach_image'));
    await scene.complete(live.runId);
    expectStatus(await scene.owner.browser.request('POST', assistantRunShowPath(live.runId)), 200);
    // The same run's token is closed; a still-live run whose answer was shown is refused in words.
    await pool.query(`UPDATE personal_runs SET status = 'reading', completed_at = NULL, run_token_closed_at = NULL, run_token_expires_at = now() + interval '5 minutes' WHERE id = $1`, [live.runId]);
    const said = await live.call('flux_attach_image', { url: at('/pic/leaf.webp') });
    assert.match(text(said.message), /already posted or put away/);
    await scene.complete(live.runId);
    // A run of the same space whose kind is a task's (its report goes to the task's discussion, for everyone, with no Show everyone).
    const taskRun = (await scene.runs.invoke(human(scene.owner), scene.thread.id, { clientRunId: randomUUID(), kind: 'ask', prompt: 'a picture' })).run.id;
    const work = await scene.task(scene.owner, 'Build the raised beds');
    await pool.query(`UPDATE personal_runs SET kind = 'task', work_id = $2 WHERE id = $1`, [taskRun, work.id]);
    const onTask = await scene.liveOf(taskRun);
    assert.ok(!onTask.tools.includes('flux_attach_image'), 'a task\'s report carries no picture');
    await scene.complete(taskRun);
  });

  test('never in an encrypted space: refused in words before anything is sent', async () => {
    const run = await scene.liveRun(undefined, 'a picture');
    // Encryption is chosen when a space is made and never changes (a trigger holds it): here it is set under the trigger, as a guard test.
    const encrypted = async (value: boolean) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN'); await client.query('SET LOCAL session_replication_role = replica');
        await client.query('UPDATE workspaces SET encrypted = $2 WHERE id = $1', [scene.ws.id, value]); await client.query('COMMIT');
      } finally { client.release(); }
    };
    await encrypted(true);
    try {
      const said = await run.call('flux_attach_image', { url: at('/pic/raised-bed.png') });
      assert.match(text(said.message), /^Not attached\. This space is encrypted/);
      assert.deepEqual(await hits('/'), []);
    } finally { await encrypted(false); }
    await scene.complete(run.runId);
  });
});
