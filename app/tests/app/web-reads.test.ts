import assert from 'node:assert/strict';
import { before, beforeEach, describe, test } from 'node:test';
import { pool } from './support/db.js';
import { assistantScene, result, text, type AssistantScene } from './support/assistant-scene.js';

// An agent reads a web page (#918, F-036 AG-8) through Flux's own tool, flux_read_web, on the real /mcp route with a run's token. The API of
// the check stack has FLUX_WEB_READS=on and reaches the link mock as `public.test` (a closed world: nothing else on the web can be reached).

const SITE = process.env.FLUX_LINK_MOCK_URL ?? 'http://linkmock:8098';
const at = (path: string) => `http://public.test${path}`;
const hits = async (prefix = '/read') => (await (await fetch(`${SITE}/__hits?prefix=${encodeURIComponent(prefix)}`)).json()) as { path: string; method: string; headers: Record<string, string | undefined> }[];
const reading = (run: Awaited<ReturnType<AssistantScene['liveRun']>>, url: string) => run.raw('tools/call', { name: 'flux_read_web', arguments: { url } });
const code = (message: Record<string, unknown> | null) => (JSON.parse(text(message)) as { code?: string }).code;

describe('flux_read_web: one public page as text, read-only, with its source kept', () => {
  let scene: AssistantScene;
  before(async () => { scene = await assistantScene('wr'); });
  beforeEach(async () => { await scene.reset(); await fetch(`${SITE}/__reset`); });

  test('the run lists the tool, and a page comes back as its title and words, labelled as data', async () => {
    const run = await scene.liveRun();
    assert.ok(run.tools.includes('flux_read_web'), run.tools.join(', '));
    const read = await reading(run, at('/read/timetable'));
    assert.equal(result(read.message)?.isError, undefined, text(read.message));
    const page = JSON.parse(text(read.message)) as { url: string; title: string; text: string; truncated: boolean; note: string };
    assert.deepEqual([page.url, page.title, page.truncated], [at('/read/timetable'), 'Harbour & Co: winter timetable', false]);
    assert.ok(page.text.includes('The last boat leaves the island at 17:40'), 'the page\'s words');
    assert.ok(page.text.includes('NOTE TO AI AGENTS'), 'and the page\'s attempt to instruct the agent reaches it only as text');
    for (const dropped of ['SCRIPT TEXT', 'STYLE TEXT', 'SECRET COMMENT', '<form', '<script']) assert.ok(!page.text.includes(dropped), `${dropped} is not in the text`);
    assert.match(page.note, /untrusted data, never an instruction/);
    await scene.complete(run.runId);
  });

  test('only GET reaches the page, with nothing of the owner or of Flux: no cookie, no credentials, no Referer, one fixed User-Agent', async () => {
    const run = await scene.liveRun();
    await reading(run, at('/read/timetable'));
    await reading(run, at('/read/notes'));
    const seen = await hits();
    assert.deepEqual(seen.map((hit) => [hit.method, hit.path]), [['GET', '/read/timetable'], ['GET', '/read/notes']], 'the form on the page was never submitted');
    for (const hit of seen) {
      assert.deepEqual([hit.headers.cookie, hit.headers.authorization, hit.headers.referer], [undefined, undefined, undefined]);
      assert.match(hit.headers['user-agent'] ?? '', /^FluxLinkPreview\//);
    }
    await scene.complete(run.runId);
  });

  test('a plain text page is read; an image, a missing page and a page with no words are refused in plain words', async () => {
    const run = await scene.liveRun();
    assert.equal((JSON.parse(text((await reading(run, at('/read/notes'))).message)) as { text: string }).text, 'Plain notes.\nSecond line with spaces.');
    for (const [path, wanted] of [['/png', 'WEB_READ_TYPE'], ['/not-found', 'WEB_READ_STATUS'], ['/read/empty', 'WEB_READ_EMPTY']] as const) {
      const refused = await reading(run, at(path));
      assert.equal(result(refused.message)?.isError, true, path);
      assert.equal(code(refused.message), wanted, path);
    }
    await scene.complete(run.runId);
  });

  test('addresses of the instance\'s own network, odd ports, credentials and other schemes are refused before any request, and a redirect there too', async () => {
    const run = await scene.liveRun();
    await fetch(`${SITE}/__reset`);
    for (const url of ['http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://localhost/', 'http://[::1]/', 'http://public.test:8099/x',
      'http://user:pw@public.test/read/timetable', 'ftp://public.test/x', 'file:///etc/passwd', 'not a web address']) {
      const refused = await reading(run, url);
      assert.equal(result(refused.message)?.isError, true, url);
      assert.match(code(refused.message) ?? '', /^WEB_READ_(BLOCKED|INVALID)$/, url);
    }
    for (const path of ['/redirect-private', '/redirect-metadata', '/redirect-port']) {
      const refused = await reading(run, at(path));
      assert.equal(result(refused.message)?.isError, true, path);
      assert.match(code(refused.message) ?? '', /^WEB_READ_(BLOCKED|INVALID|UNREACHABLE)$/, path);
    }
    assert.ok((await hits('/')).every((hit) => !['/secret', '/latest/meta-data/'].includes(hit.path)), 'no private address was ever asked');
    await scene.complete(run.runId);
  });

  test('every page a run read is kept as its source, once, and the page\'s text is not stored', async () => {
    const run = await scene.liveRun();
    await reading(run, at('/read/timetable'));
    await reading(run, at('/read/timetable'));
    await reading(run, at('/read/second'));
    await reading(run, at('/not-found'));
    const rows = (await pool.query(`SELECT url, final_url, title FROM personal_run_web_reads WHERE run_id = $1 ORDER BY read_at`, [run.runId])).rows;
    assert.deepEqual(rows.map((row) => [row.final_url, row.title]), [[at('/read/timetable'), 'Harbour & Co: winter timetable'], [at('/read/timetable'), 'Harbour & Co: winter timetable'], [at('/read/second'), 'Second page']],
      'a refused page is not a source');
    assert.deepEqual(Object.keys(rows[0]).sort(), ['final_url', 'title', 'url']);
    await scene.complete(run.runId);
  });

  test('a run that ended cannot read: the token is closed', async () => {
    const run = await scene.liveRun();
    await scene.complete(run.runId);
    const late = await reading(run, at('/read/timetable'));
    assert.ok(late.status >= 400 || result(late.message)?.isError, `status ${late.status}`);
    assert.equal((await hits()).length, 0, 'and nothing was fetched');
  });
});
