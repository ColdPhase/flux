import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { webSourcesLine } from '@flux/core';
import { loadWebReadsConfig } from '../../apps/server/src/web-reads/config.js';
import { READ_TEXT_MAX, readablePage } from '../../apps/server/src/web-reads/readable.js';
import { READS_AT_ONCE, READS_PER_MINUTE, webReader } from '../../apps/server/src/web-reads/reader.js';

// An agent reads a web page (#918, F-036 AG-8): the text it gets, the bounds, the switch, and how the run keeps its sources. No network.

const PAGE = `<!doctype html><html><head><title>Harbour &amp; Co: winter timetable</title><script>var s = 'SCRIPT TEXT';</script><style>.x { content: 'STYLE TEXT' }</style></head>
<body><nav>Menu</nav><h1>Winter timetable</h1><p>The last boat leaves at 17:40 &mdash; check the board.</p><ul><li>First</li><li>Second</li></ul>
<textarea>TEXTAREA TEXT</textarea><noscript>NOSCRIPT TEXT</noscript><!-- SECRET COMMENT --><svg><text>SVG TEXT</text></svg><p>A&nbsp;&lt;b&gt;tag&lt;/b&gt; &#x41; &#66;</p></body></html>`;

describe('the text of a page for an agent', () => {
  test('keeps the words and drops script, style, comments, forms and markup', () => {
    const page = readablePage(PAGE, true);
    assert.equal(page.title, 'Harbour & Co: winter timetable');
    assert.equal(page.truncated, false);
    for (const wanted of ['Winter timetable', 'The last boat leaves at 17:40 — check the board.', 'First', 'Second', 'A <b>tag</b> A B']) assert.ok(page.text.includes(wanted), `${wanted} in ${JSON.stringify(page.text)}`);
    for (const dropped of ['doctype', 'SCRIPT TEXT', 'STYLE TEXT', 'TEXTAREA TEXT', 'NOSCRIPT TEXT', 'SECRET COMMENT', 'SVG TEXT', '<p>', '<script']) assert.ok(!page.text.includes(dropped), `${dropped} is not text`);
    assert.ok(page.text.split('\n').length >= 5, 'block elements are lines');
  });

  test('plain text is read as it is, cleaned of control characters and bidirectional overrides', () => {
    const page = readablePage('Plain notes.\nSecond line with   spaces.' + String.fromCharCode(0, 0x202e) + 'evil' + String.fromCharCode(0x202c) + '\r\n\r\n\r\n\r\nThird', false);
    assert.equal(page.title, null);
    assert.equal(page.text, 'Plain notes.\nSecond line with spaces. evil\n\nThird');
  });

  test('is cut at the bound, and says so', () => {
    const long = readablePage(`<p>${'word '.repeat(5_000)}</p>`, true);
    assert.equal(long.truncated, true);
    assert.ok([...long.text].length <= READ_TEXT_MAX);
    assert.equal(readablePage('<p>short</p>', true).truncated, false);
  });

  test('a hostile page cannot make the pass slow', () => {
    for (const hostile of ['<a '.repeat(150_000), `<p>${'<'.repeat(300_000)}`, `<script>${'x'.repeat(500_000)}`, `<!--${'-'.repeat(300_000)}`, `<div ${'"'.repeat(200_001)}`, '<p>x</p>'.repeat(60_000), '&amp;'.repeat(200_000)]) {
      const started = Date.now();
      readablePage(hostile, true);
      assert.ok(Date.now() - started < 1_000, `took ${Date.now() - started} ms`);
    }
  });
});

describe('the reader', () => {
  const ok = async (address: string) => ({ ok: true as const, url: address, html: '<title>T</title><p>Words.</p>', type: 'text/html' });

  test('is off unless the operator turned it on, and then reads nothing and fetches nothing', async () => {
    let fetched = 0;
    const off = webReader({ enabled: false, fetch: async (address) => { fetched++; return ok(address); } });
    assert.deepEqual(await off.read('ada', 'https://example.org/'), { ok: false, reason: 'off' });
    assert.equal(fetched, 0);
    const env = (extra: Record<string, string> = {}) => ({ ...process.env, ...extra });
    assert.equal(loadWebReadsConfig(env({ FLUX_WEB_READS: '' })).enabled, false, 'off is the default');
    assert.equal(loadWebReadsConfig(env({ FLUX_WEB_READS: 'off' })).enabled, false);
    assert.equal(loadWebReadsConfig(env({ FLUX_WEB_READS: 'on' })).enabled, true);
    assert.throws(() => loadWebReadsConfig(env({ FLUX_WEB_READS: 'sometimes' })), /FLUX_WEB_READS must be on or off/);
  });

  test('reads a page as text with where it ended, and a page with no words as nothing', async () => {
    const reader = webReader({ enabled: true, fetch: async (address) => address.endsWith('/empty') ? { ok: true, url: address, html: '<script>x</script>', type: 'text/html' } : { ...(await ok(address)), url: 'https://example.org/final' } });
    assert.deepEqual(await reader.read('ada', 'https://example.org/start'), { ok: true, url: 'https://example.org/start', finalUrl: 'https://example.org/final', title: 'T', text: 'Words.', truncated: false });
    assert.deepEqual(await reader.read('ada', 'https://example.org/empty'), { ok: false, reason: 'empty' });
  });

  test('a refusal of the guard is passed on in its own words, never a way round', async () => {
    const reader = webReader({ enabled: true, fetch: async () => ({ ok: false, reason: 'blocked' }) });
    assert.deepEqual(await reader.read('ada', 'http://169.254.169.254/'), { ok: false, reason: 'blocked' });
  });

  test('an address the guard refuses from its text alone costs no read: no network is used, so no rate is spent', async () => {
    let fetched = 0;
    const reader = webReader({ enabled: true, fetch: async (address) => { fetched++; return ok(address); } });
    for (let i = 0; i < READS_PER_MINUTE + 5; i++)
      for (const address of ['http://127.0.0.1/', 'http://localhost/x', 'ftp://example.org/', 'https://user:pw@example.org/', 'https://example.org:8443/', 'not a web address'])
        assert.equal((await reader.read('ada', address)).ok, false);
    assert.equal(fetched, 0);
    assert.equal((await reader.read('ada', 'https://example.org/real')).ok, true, 'and the owner can still read');
  });

  test('one owner\'s agents read a bounded number of pages a minute, and the server a bounded number at once', async () => {
    let clock = 1_000_000;
    const reader = webReader({ enabled: true, now: () => clock, fetch: ok });
    for (let i = 0; i < READS_PER_MINUTE; i++) assert.equal((await reader.read('ada', `https://example.org/${i}`)).ok, true);
    assert.deepEqual(await reader.read('ada', 'https://example.org/one-more'), { ok: false, reason: 'busy' });
    assert.equal((await reader.read('jonas', 'https://example.org/jonas')).ok, true, 'another owner is not held back');
    clock += 61_000;
    assert.equal((await reader.read('ada', 'https://example.org/later')).ok, true, 'a minute later');
    let release = () => undefined as void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const slow = webReader({ enabled: true, fetch: async (address) => { await hold; return ok(address); } });
    const reading = Array.from({ length: READS_AT_ONCE }, (_, i) => slow.read(`owner-${i}`, `https://example.org/${i}`));
    assert.deepEqual(await slow.read('another', 'https://example.org/x'), { ok: false, reason: 'busy' });
    release();
    assert.ok((await Promise.all(reading)).every((result) => result.ok));
  });
});

describe('the pages a run read, in its answer', () => {
  test('are listed at its end in Flux\'s words: each once, five at most, long lines cut', () => {
    assert.equal(webSourcesLine([]), '');
    assert.equal(webSourcesLine([{ finalUrl: 'https://example.org/a', title: 'Timetable' }, { finalUrl: 'https://example.org/b', title: null }]),
      'Read on the web:\n- Timetable: https://example.org/a\n- https://example.org/b');
    const many = Array.from({ length: 7 }, (_, i) => ({ finalUrl: `https://example.org/${i}`, title: null }));
    assert.equal(webSourcesLine(many).split('\n').length, 1 + 5 + 1);
    assert.ok(webSourcesLine(many).endsWith('- and 2 more'));
    assert.ok(webSourcesLine([{ finalUrl: `https://example.org/${'x'.repeat(500)}`, title: null }]).split('\n')[1]!.length <= 202);
  });
});
