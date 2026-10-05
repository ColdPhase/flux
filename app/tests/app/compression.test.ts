import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { test } from 'node:test';
import { brotliDecompressSync } from 'node:zlib';
import { AUTH_BASE_PATH, filePath, PROJECT_EXPORT_BUNDLE_QUERY, projectExportPath, type Conversation, type StagedFile } from '@flux/contracts';
import { apiUrl } from './support/http.js';
import { expectStatus, person, project, workspace, type Person } from './support/people.js';

// Compression as wired into the running API (#266 item 9): node:http shows the bytes as sent,
// where fetch would decode them.
function raw(path: string, encoding: string, who?: Person, method = 'GET') {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; bytes: Buffer }>((resolve, reject) => {
    const headers: Record<string, string> = { 'accept-encoding': encoding };
    if (who) headers.cookie = who.browser.cookieHeader();
    httpRequest(new URL(path, apiUrl), { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, bytes: Buffer.concat(chunks) }));
    }).on('error', reject).end();
  });
}
const varies = (headers: Record<string, string | string[] | undefined>) => /\baccept-encoding\b/i.test(String(headers.vary ?? ''));

test('a large JSON answer is Brotli encoded with Vary; auth, file and export answers are not compressed', async () => {
  const owner = await person('Compression owner');
  const ws = await workspace(owner, 'Compression');
  const place = await project(owner, ws.id, 'Compressed reads', 'restricted');
  const body = Array.from({ length: 80 }, (_, line) => `- Line ${line}: capacitive probe readings for the raised beds by the fence`).join('\n');
  const doc = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/docs`,
    { body: { title: 'Sensor notes', body, reason: 'Compression check' }, headers: { 'idempotency-key': randomUUID() } }), 201) as { id: string };

  const plain = await raw(`/api/v1/docs/${doc.id}`, 'identity', owner);
  assert.equal(plain.status, 200);
  assert.ok(plain.bytes.length >= 2048, `the answer is large enough to compress (${plain.bytes.length} bytes)`);
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.ok(varies(plain.headers), 'an uncompressed answer still varies by encoding');
  const br = await raw(`/api/v1/docs/${doc.id}`, 'gzip, deflate, br', owner);
  assert.equal(br.headers['content-encoding'], 'br');
  assert.ok(varies(br.headers));
  assert.deepEqual(JSON.parse(brotliDecompressSync(br.bytes).toString()), JSON.parse(plain.bytes.toString()));
  assert.ok(br.bytes.length < plain.bytes.length / 3, `${br.bytes.length} of ${plain.bytes.length} bytes`);
  const head = await raw(`/api/v1/docs/${doc.id}`, 'br', owner, 'HEAD');
  assert.ok(varies(head.headers), 'HEAD varies like GET');

  const session = await raw(`${AUTH_BASE_PATH}/get-session`, 'br', owner);
  assert.equal(session.status, 200);
  assert.equal(session.headers['content-encoding'], undefined, 'auth answers are never compressed');

  const upload = await fetch(new URL(`/api/v1/projects/${place.id}/files?uploadId=${randomUUID()}&name=readings.txt`, apiUrl), {
    method: 'POST', headers: { 'content-type': 'application/octet-stream', cookie: owner.browser.cookieHeader(), origin: owner.browser.defaultOrigin },
    body: Buffer.from(body),
  });
  const staged = await upload.json() as StagedFile;
  expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`,
    { body: { body: '', attachmentIds: [staged.id], clientMessageId: randomUUID() } }), 201) as Conversation;
  const file = await raw(filePath(staged.id), 'br', owner);
  assert.equal(file.status, 200);
  assert.equal(file.headers['content-encoding'], undefined, 'files pass through unchanged');
  assert.equal(file.bytes.toString(), body);

  const bundle = await raw(`${projectExportPath(place.id)}?${PROJECT_EXPORT_BUNDLE_QUERY}`, 'br', owner);
  assert.equal(bundle.status, 200);
  assert.match(String(bundle.headers['content-type']), /^application\/gzip/);
  assert.equal(bundle.headers['content-encoding'], undefined, 'the export bundle passes through unchanged');
});
