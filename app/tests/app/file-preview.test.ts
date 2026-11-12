import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { filePreviewPath, type Conversation, type StagedFile } from '@flux/contracts';
import { addMember, expectStatus, grant, person, project, removeFromSpace, workspace, type Person } from './support/people.js';

// File previews (C-58, #1252): someone else's HTML or PDF is served only to a frame of a Flux page, sandboxed to an opaque origin by its
// own policy, under the download's access check. The browser half (nothing runs, nothing leaves) is tests/ui/test_file_preview.py.

const FRAME = { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' };
const HTML = Buffer.from('<!doctype html><title>Range</title><h1>Gateway range</h1><script>parent.postMessage("hi", "*")</script>');
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
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), HTML);

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

test('a PDF preview is sandboxed by its policy; other files have none; the download is unchanged', async () => {
  const f = await scene();
  const pdf = await preview(f.reader, f.pdf.id, FRAME, true);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(pdf.headers.get('content-security-policy'), "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
    'a PDF never gets scripts, whatever the query says');
  assert.deepEqual(Buffer.from(await pdf.arrayBuffer()), PDF);
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
  assert.equal(head.status, 200, 'the viewer asks for access with a HEAD of the download');
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
