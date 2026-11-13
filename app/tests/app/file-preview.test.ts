import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { filePreviewPath, type Conversation, type StagedFile } from '@flux/contracts';
import { inertHead } from '../../apps/server/src/files/routes.js';
import { addMember, expectStatus, grant, person, project, removeFromSpace, workspace, type Person } from './support/people.js';

// File previews (C-60, #1252): someone else's HTML or PDF is served only to a frame of a Flux page, sandboxed to an opaque origin by its
// own policy, under the download's access check. The browser half (nothing runs, nothing leaves) is tests/ui/test_file_preview.py.

const FRAME = { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' };
const HTML = Buffer.concat([Buffer.from('<!doctype html><META http-equiv="x-dns-prefetch-control" content="on"><link rel=preconnect href="https://leak.example">'
  + '<LINK\nrel="dns-prefetch" href="//leak.example"/><title>Range</title><h1>Gateway range</h1><script>parent.postMessage("hi", "*")</script><p>'),
Buffer.from('Zażółć', 'utf8'), Buffer.from(' <linked> <metadata> '), Buffer.from([0xff, 0xfe]), Buffer.from('</p>')]);
/** What the preview sends: every `<link>` and `<meta>` inert, every other byte as stored (C-60). */
const SENT = Buffer.from(HTML.toString('latin1').replace('<META', '<x-META').replace('<link', '<x-link').replace('<LINK', '<x-LINK'), 'latin1');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

async function upload(who: Person, projectId: string, bytes: Uint8Array, name: string) {
  const response = await fetch(new URL(`/api/v1/projects/${projectId}/files?uploadId=${randomUUID()}&name=${encodeURIComponent(name)}`, who.browser.base), {
    method: 'POST', headers: { 'content-type': 'application/octet-stream', cookie: who.browser.cookieHeader(), origin: who.browser.defaultOrigin },
    body: Buffer.from(bytes),
  });
  assert.equal(response.status, 201);
  return await response.json() as StagedFile;
}
const preview = (who: Person, id: string, headers: Record<string, string> = FRAME, scripts = false) =>
  fetch(new URL(filePreviewPath(id, scripts), who.browser.base), { headers: { cookie: who.browser.cookieHeader(), ...headers } });

const PAGE16 = '<link rel="preconnect" href="https://leak.example"><LINK rel=preload as=fetch href="https://leak.example/p">'
  + '<meta http-equiv="refresh" content="0;url=https://leak.example/m"><h1>sixteen bit: Zażółć</h1>';
const utf16be = (text: string) => { const le = Buffer.from(text, 'utf16le'); for (let i = 0; i + 1 < le.length; i += 2) [le[i], le[i + 1]] = [le[i + 1]!, le[i]!]; return le; };
/** A page with a UTF-16 byte-order mark, which the browser decodes as UTF-16 whatever the header says. */
const HTML16 = { le: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(PAGE16, 'utf16le')]), be: Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be(PAGE16)]) };

/**
 * A nested document needs no fetch (#1349): an iframe's `srcdoc` is entity-encoded text the browser decodes into an `about:srcdoc` page,
 * and WebKit acts on that page's `<link rel=preconnect>` without asking the policy, to any depth. The preview makes every element that
 * can hold one inert, so the rewrite never has to read encoded text.
 */
const encode = (markup: string) => markup.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const HINT = '<link rel=preconnect href=http://leak.example/>';
const NESTED = [
  // The audit's pages: one level, and a srcdoc inside a srcdoc.
  [`<iframe hidden srcdoc="${encode(HINT)}"></iframe>`, `<x-iframe hidden x-srcdoc="${encode(HINT)}"></iframe>`],
  [`<iframe srcdoc="${encode(`<iframe srcdoc='${encode(HINT)}'></iframe>`)}"></iframe>`,
    `<x-iframe x-srcdoc="${encode(`<iframe srcdoc='${encode(HINT)}'></iframe>`)}"></iframe>`],
  // Case, whitespace (a newline, a slash, tabs) and quoting of the tag and the attribute.
  [`<IFRAME\nSRCDOC\t=\t'${encode(HINT)}'></IFRAME>`, `<x-IFRAME\nx-srcdoc\t=\t'${encode(HINT)}'></IFRAME>`],
  [`<iFrame/srcDoc=${encode(HINT).replace(/["\s]/g, '')}>`, `<x-iFrame/x-srcdoc=${encode(HINT).replace(/["\s]/g, '')}>`],
  [`<iframe a="b"srcdoc="${encode(HINT)}">`, `<x-iframe a="b"x-srcdoc="${encode(HINT)}">`],
  // Every other element that can hold a document, in a noscript (parsed as elements when scripts are off) too.
  ['<frame src="data:text/html,x"><object data="data:text/html,x"></object><embed src="data:text/html,x"><portal src="//leak.example/"></portal><fencedframe></fencedframe>',
    '<x-frame src="data:text/html,x"><x-object data="data:text/html,x"></object><x-embed src="data:text/html,x"><x-portal src="//leak.example/"></portal><x-fencedframe></fencedframe>'],
  [`<noscript><iframe srcdoc="${encode(HINT)}"></iframe></noscript>`, `<noscript><x-iframe x-srcdoc="${encode(HINT)}"></iframe></noscript>`],
  // Not those elements: other names, other attributes, an already inert tag.
  ['<iframeset><framework><objects><embedded><portals><p data-srcdoc="x" xsrcdoc=y srcdocs>iframe srcdoc</p><x-iframe x-srcdoc="x">',
    '<iframeset><framework><objects><embedded><portals><p data-srcdoc="x" xsrcdoc=y srcdocs>iframe srcdoc</p><x-iframe x-srcdoc="x">'],
] as const;

async function scene() {
  const owner = await person('Preview owner');
  const reader = await person('Preview reader');
  const outsider = await person('Preview outsider');
  const ws = await workspace(owner, 'Previews');
  for (const other of [reader, outsider]) await addMember(owner, ws.id, other, 'member');
  const place = await project(owner, ws.id, 'Private previews', 'restricted');
  await grant(owner, place.id, reader, 'contributor');
  const html = await upload(owner, place.id, HTML, 'range report.html');
  const pdf = await upload(owner, place.id, PDF, 'probe.pdf');
  const text = await upload(owner, place.id, Buffer.from('plain'), 'notes.txt');
  expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`,
    { body: { body: 'Three files', attachmentIds: [html.id, pdf.id, text.id], clientMessageId: randomUUID() } }), 201) as Conversation;
  return { owner, reader, outsider, place, html, pdf, text };
}

test('an HTML preview is a sandboxed, network-less page for a frame of a Flux page only', async () => {
  const f = await scene();
  const response = await preview(f.reader, f.html.id);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(response.headers.get('content-security-policy'),
    "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
  assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.match(response.headers.get('content-disposition')!, /^inline; filename="preview"; filename\*=UTF-8''range%20report\.html$/);
  assert.match(response.headers.get('permissions-policy')!, /^camera=\(\), microphone=\(\), display-capture=\(\)/);
  const sent = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(sent, SENT, 'links and metas are inert; <linked>, <metadata> and every other byte are untouched');
  assert.equal(Number(response.headers.get('content-length')), SENT.byteLength);
  assert.doesNotMatch(sent.toString('latin1'), /<(link|meta)[\s/>]/i);
  assert.ok(sent.includes(Buffer.from('Zażółć', 'utf8')) && sent.includes(Buffer.from([0xff, 0xfe])), 'UTF-8 and stray bytes pass unchanged');

  const scripts = await preview(f.reader, f.html.id, FRAME, true);
  assert.equal(scripts.status, 200);
  assert.equal(scripts.headers.get('content-security-policy'),
    "sandbox allow-scripts; default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline' 'unsafe-eval'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
    'Run scripts adds inline scripts only: still an opaque origin, still no connect-src');
  assert.equal((await fetch(new URL(`${filePreviewPath(f.html.id)}?scripts=yes`, f.reader.browser.base), { headers: { cookie: f.reader.browser.cookieHeader(), ...FRAME } })).status, 400);

  // A tab, a link from another site, the preview navigating itself (an opaque origin is cross-site) or a fetch never get the page.
  for (const headers of [{}, { ...FRAME, 'sec-fetch-dest': 'document' }, { ...FRAME, 'sec-fetch-site': 'cross-site' }, { ...FRAME, 'sec-fetch-site': 'same-site' },
    { ...FRAME, 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors' }]) {
    const refused = await preview(f.reader, f.html.id, headers, true);
    assert.equal(refused.status, 403, JSON.stringify(headers));
    assert.equal((await refused.json() as { code: string }).code, 'PREVIEW_FRAME_ONLY');
    assert.equal(refused.headers.get('x-frame-options'), 'DENY');
  }
});

test('a UTF-16 page is decoded, made inert and sent as UTF-8 without its byte-order mark', async () => {
  const owner = await person('Preview sixteen');
  const ws = await workspace(owner, 'Sixteen');
  const place = await project(owner, ws.id, 'Sixteen-bit pages', 'restricted');
  for (const [order, bytes] of Object.entries(HTML16)) {
    const file = await upload(owner, place.id, bytes, `u16${order}.html`);
    const response = await preview(owner, file.id);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    const sent = Buffer.from(await response.arrayBuffer());
    assert.equal(Number(response.headers.get('content-length')), sent.byteLength);
    assert.notDeepEqual([...sent.subarray(0, 2)], [0xff, 0xfe], order);
    assert.notDeepEqual([...sent.subarray(0, 2)], [0xfe, 0xff], order);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(sent);
    assert.equal(text, PAGE16.replace(/<(link|meta)/gi, '<x-$1'), `${order}: every link and meta inert, the rest as written`);
  }
});

test('every element that can hold a nested document is made inert, whatever its case, spacing or quoting (#1349)', () => {
  for (const [page, inertPage] of NESTED) {
    const sent = inertHead(Buffer.from(`<!doctype html><h1>Report</h1>${page}<p>Zażółć</p>`)).toString('utf8');
    assert.equal(sent, `<!doctype html><h1>Report</h1>${inertPage}<p>Zażółć</p>`);
    assert.equal(inertHead(Buffer.from(sent)).toString('utf8'), sent, 'the rewrite is idempotent');
  }
});

test('a nested document in a UTF-16 page is made inert too, and the preview of the page is served that way (#1349)', async () => {
  const markup = `<!doctype html><h1>sixteen</h1>${NESTED.map(([page]) => page).join('\n')}`;
  const sixteen = { le: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(markup, 'utf16le')]), be: Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be(markup)]) };
  const expected = `<!doctype html><h1>sixteen</h1>${NESTED.map(([, inertPage]) => inertPage).join('\n')}`;
  const owner = await person('Preview nested');
  const ws = await workspace(owner, 'Nested');
  const place = await project(owner, ws.id, 'Nested pages', 'restricted');
  for (const [name, bytes] of [['utf8', Buffer.from(markup)], ['le', sixteen.le], ['be', sixteen.be]] as const) {
    const file = await upload(owner, place.id, bytes, `nested-${name}.html`);
    const response = await preview(owner, file.id);
    assert.equal(response.status, 200);
    const sent = Buffer.from(await response.arrayBuffer());
    assert.equal(sent.toString('utf8'), expected, name);
    assert.doesNotMatch(sent.toString('latin1'), /<(link|meta|iframe|frame|object|embed|portal|fencedframe)[\s/>]|(?<![\w-])srcdoc\s*=/i, name);
  }
});

test('a PDF is not served by the preview route (Flux draws it, #1350); other files have none; the download is unchanged', async () => {
  const f = await scene();
  // A browser's own PDF viewer follows a link in the file in the top window, so a PDF is never framed: the viewer reads the download's bytes.
  const pdf = await preview(f.reader, f.pdf.id, FRAME, true);
  assert.equal(pdf.status, 404);
  assert.equal((await pdf.json() as { code: string }).code, 'FILE_NO_PREVIEW');
  const bytes = await fetch(new URL(`/api/v1/files/${f.pdf.id}`, f.reader.browser.base), { headers: { cookie: f.reader.browser.cookieHeader() } });
  assert.equal(bytes.status, 200);
  assert.deepEqual(Buffer.from(await bytes.arrayBuffer()), PDF, 'the viewer gets the stored bytes through the download route');
  const text = await preview(f.reader, f.text.id);
  assert.equal(text.status, 404);
  assert.equal((await text.json() as { code: string }).code, 'FILE_NO_PREVIEW');

  const download = await fetch(new URL(`/api/v1/files/${f.html.id}`, f.reader.browser.base), { headers: { cookie: f.reader.browser.cookieHeader(), ...FRAME } });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'application/octet-stream');
  assert.match(download.headers.get('content-disposition')!, /^attachment;/);
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(download.headers.get('content-security-policy'), 'sandbox');
  assert.equal(download.headers.get('x-frame-options'), 'DENY');
  const head = await fetch(new URL(`/api/v1/files/${f.html.id}`, f.reader.browser.base), { method: 'HEAD', headers: { cookie: f.reader.browser.cookieHeader() } });
  assert.equal(head.status, 200, 'the HTML viewer asks for access with a HEAD of the download');
});

test('a preview is refused to someone without access and after their access is removed (#592)', async () => {
  const f = await scene();
  for (const id of [f.html.id, f.pdf.id]) {
    assert.equal((await preview(f.outsider, id)).status, 404);
    assert.equal((await fetch(new URL(filePreviewPath(id), f.outsider.browser.base), { headers: FRAME })).status, 401, 'no session, no preview');
  }
  assert.equal((await preview(f.reader, f.html.id)).status, 200);
  await removeFromSpace(f.owner, f.place.id, f.reader);
  for (const id of [f.html.id, f.pdf.id]) {
    assert.equal((await preview(f.reader, id)).status, 404);
    assert.equal((await fetch(new URL(`/api/v1/files/${id}`, f.reader.browser.base), { method: 'HEAD', headers: { cookie: f.reader.browser.cookieHeader() } })).status, 404);
  }
  // An unsent file is its uploader's only, as for the download.
  const staged = await upload(f.owner, f.place.id, HTML, 'draft.html');
  assert.equal((await preview(f.owner, staged.id)).status, 200);
  assert.equal((await preview(f.outsider, staged.id)).status, 404);
});
