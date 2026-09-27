import { createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';

/**
 * A local stand-in for a browser push service, for tests only (issue #41). It accepts Web Push
 * requests over https on :8443, checks the VAPID Authorization header (ES256 JWT signed by the
 * key in `k=`), records each request and answers by path prefix:
 *   /push/<id> 201, /gone/<id> 410, /missing/<id> 404, /busy/<id> 503, /bad/<id> 400.
 * GET http://pushmock:8081/requests?id=<id> returns what was recorded for <id>.
 */
export interface RecordedPush {
  id: string;
  kind: string;
  status: number;
  headers: Record<string, string | string[] | undefined>;
  bodyBase64: string;
  vapid: { ok: boolean; error?: string; publicKey?: string; claims?: { aud?: string; exp?: number; sub?: string } };
}

const STATUS: Record<string, number> = { push: 201, gone: 410, missing: 404, busy: 503, bad: 400 };
const ORIGIN = 'https://pushmock:8443';
const recorded: RecordedPush[] = [];

function checkVapid(header: string | undefined): RecordedPush['vapid'] {
  const match = header?.match(/^vapid t=([^,\s]+),\s*k=([A-Za-z0-9_-]+)$/);
  if (!match) return { ok: false, error: `unexpected Authorization header: ${header}` };
  const [, token, publicKey] = match as unknown as [string, string, string];
  const [head, payload, signature] = token.split('.');
  if (!head || !payload || !signature) return { ok: false, error: 'malformed JWT', publicKey };
  const raw = Buffer.from(publicKey, 'base64url');
  if (raw.length !== 65 || raw[0] !== 4) return { ok: false, error: 'k is not an uncompressed P-256 key', publicKey };
  const key = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') } });
  const header_ = JSON.parse(Buffer.from(head, 'base64url').toString()) as { alg?: string };
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { aud?: string; exp?: number; sub?: string };
  if (header_.alg !== 'ES256') return { ok: false, error: `alg ${header_.alg}`, publicKey, claims };
  const valid = verify('sha256', Buffer.from(`${head}.${payload}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'));
  if (!valid) return { ok: false, error: 'bad signature', publicKey, claims };
  const now = Math.floor(Date.now() / 1000);
  if (claims.aud !== ORIGIN) return { ok: false, error: `aud ${claims.aud}`, publicKey, claims };
  if (!claims.exp || claims.exp <= now || claims.exp > now + 24 * 3600 + 60) return { ok: false, error: `exp ${claims.exp}`, publicKey, claims };
  if (!claims.sub || !/^(mailto:|https:)/.test(claims.sub)) return { ok: false, error: `sub ${claims.sub}`, publicKey, claims };
  return { ok: true, publicKey, claims };
}

https.createServer({ key: readFileSync('/tls/key.pem'), cert: readFileSync('/tls/cert.pem') }, (request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    const [, kind = '', id = ''] = (request.url ?? '').split('?')[0]!.split('/');
    const status = request.method === 'POST' ? STATUS[kind] ?? 404 : 405;
    recorded.push({
      id, kind, status,
      headers: request.headers,
      bodyBase64: Buffer.concat(chunks).toString('base64'),
      vapid: checkVapid(request.headers.authorization),
    });
    response.writeHead(status, { 'content-type': 'text/plain' }).end(status === 201 ? '' : `mock ${status}`);
  });
}).listen(8443, '0.0.0.0');

http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://pushmock');
  if (url.pathname === '/health') return response.writeHead(200).end('ok');
  if (url.pathname === '/requests') {
    const id = url.searchParams.get('id');
    return response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(recorded.filter((entry) => entry.id === id)));
  }
  response.writeHead(404).end();
}).listen(8081, '0.0.0.0');

console.log('push mock listening on https :8443 and http :8081');
