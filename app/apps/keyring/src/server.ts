import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/**
 * `@flux/keyring` (F-030, #655; docs/product/encrypted-workspaces.md#the-keyring-appskeyring). One random boot key and
 * boot id in RAM, created at start; nothing written, no volume, no other state. Three routes, each behind the bearer
 * token, compared in constant time over SHA-256 digests:
 *   GET  /v1/boot                                        → { bootId }
 *   POST /v1/seal { workspaceId, keyVersion, dek }       → { bootId, sealed }   AES-256-GCM under the boot key,
 *                                                          AAD [flux unlock v1, workspace id, boot id, key version]
 *   POST /v1/open { workspaceId, keyVersion, bootId, sealed } → { dek }, or 409 when bootId is another boot's
 * Bodies are read up to 4 KiB; anything malformed gets a fixed answer with nothing echoed. Each request logs only its
 * method, path, status and duration.
 */
export interface KeyringOptions {
  token: string;
  log?: (line: string) => void;
  /**
   * TEST ONLY (`scripts/check_encryption.sh`): `GET /v1/test/boot-key` answers the boot key, so the log scan can search for
   * it. Only in a test deployment with `FLUX_KEYRING_REVEAL_BOOT_KEY=true`; otherwise the route does not exist.
   */
  revealBootKey?: boolean;
}

const MAX_BODY = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B64URL = /^[A-Za-z0-9_-]+$/;
const FIXED = {
  unauthorized: [401, { error: 'unauthorized' }],
  notFound: [404, { error: 'not_found' }],
  badRequest: [400, { error: 'bad_request' }],
  tooLarge: [413, { error: 'too_large' }],
  staleBoot: [409, { error: 'stale_boot', code: 'STALE_BOOT' }],
} as const;

/** Each component as its UTF-8 bytes preceded by a 4-byte big-endian length (the contract's context encoding). */
function encodeContext(parts: readonly (string | number)[]): Buffer {
  return Buffer.concat(parts.flatMap((part) => {
    const bytes = Buffer.from(String(part), 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return [length, bytes];
  }));
}

const digest = (value: string) => createHash('sha256').update(value).digest();

/** Whether the request carries the token; the time taken does not depend on the token. */
export function tokenMatches(header: string | undefined, token: string): boolean {
  return timingSafeEqual(digest(header ?? ''), digest(`Bearer ${token}`));
}

export function createKeyring({ token, log = (line) => process.stdout.write(`${line}\n`), revealBootKey = false }: KeyringOptions) {
  if (token.length < 32) throw new Error('FLUX_KEYRING_TOKEN must be at least 32 characters');
  const bootKey = randomBytes(32);
  const bootId = randomUUID();
  const aad = (workspaceId: string, boot: string, keyVersion: number) => encodeContext(['flux unlock v1', workspaceId.toLowerCase(), boot, keyVersion]);

  function seal(workspaceId: string, keyVersion: number, dek: Buffer): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', bootKey, nonce, { authTagLength: 16 });
    cipher.setAAD(aad(workspaceId, bootId, keyVersion));
    const body = Buffer.concat([cipher.update(dek), cipher.final()]);
    return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString('base64url');
  }

  function open(workspaceId: string, keyVersion: number, sealed: string): Buffer | null {
    const bytes = Buffer.from(sealed, 'base64url');
    if (bytes.length !== 12 + 32 + 16) return null;
    const decipher = createDecipheriv('aes-256-gcm', bootKey, bytes.subarray(0, 12), { authTagLength: 16 });
    decipher.setAAD(aad(workspaceId, bootId, keyVersion));
    decipher.setAuthTag(bytes.subarray(44));
    try { return Buffer.concat([decipher.update(bytes.subarray(12, 44)), decipher.final()]); } catch { return null; }
  }

  async function readBody(request: IncomingMessage): Promise<Buffer | 'too_large'> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) return 'too_large';
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  function parse(body: Buffer): Record<string, unknown> | null {
    try {
      const value = JSON.parse(body.toString('utf8')) as unknown;
      return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
    } catch { return null; } finally { body.fill(0); }
  }

  const keyVersionOf = (value: unknown) => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : null);

  async function route(request: IncomingMessage): Promise<readonly [number, unknown]> {
    if (!tokenMatches(request.headers.authorization, token)) return FIXED.unauthorized;
    const path = (request.url ?? '').split('?')[0];
    if (request.method === 'GET' && path === '/v1/boot') return [200, { bootId }];
    if (revealBootKey && request.method === 'GET' && path === '/v1/test/boot-key') return [200, { bootKey: bootKey.toString('base64url') }];
    if (request.method !== 'POST' || (path !== '/v1/seal' && path !== '/v1/open')) return FIXED.notFound;
    const raw = await readBody(request);
    if (raw === 'too_large') return FIXED.tooLarge;
    const body = parse(raw);
    const workspaceId = typeof body?.workspaceId === 'string' && UUID.test(body.workspaceId) ? body.workspaceId : null;
    const keyVersion = keyVersionOf(body?.keyVersion);
    if (!body || !workspaceId || !keyVersion) return FIXED.badRequest;
    if (path === '/v1/seal') {
      if (typeof body.dek !== 'string' || !B64URL.test(body.dek)) return FIXED.badRequest;
      const dek = Buffer.from(body.dek, 'base64url');
      try {
        if (dek.length !== 32) return FIXED.badRequest;
        return [200, { bootId, sealed: seal(workspaceId, keyVersion, dek) }];
      } finally { dek.fill(0); }
    }
    if (typeof body.bootId !== 'string' || typeof body.sealed !== 'string' || !B64URL.test(body.sealed)) return FIXED.badRequest;
    if (body.bootId !== bootId) return FIXED.staleBoot;
    const dek = open(workspaceId, keyVersion, body.sealed);
    if (!dek) return FIXED.badRequest;
    try { return [200, { dek: dek.toString('base64url') }]; } finally { dek.fill(0); }
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const started = process.hrtime.bigint();
    let status = 500;
    try {
      const [code, body] = await route(request).catch(() => FIXED.badRequest);
      status = code;
      response.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...(code === 413 ? { connection: 'close' } : {}) });
      response.end(JSON.stringify(body));
    } finally {
      const ms = Number((process.hrtime.bigint() - started) / 1_000_000n);
      log(`${request.method ?? '-'} ${(request.url ?? '').split('?')[0]?.slice(0, 64)} ${status} ${ms}ms`);
    }
  }

  const server: Server = createServer((request, response) => { void handle(request, response); });
  // Bound what a client can make the keyring hold.
  server.headersTimeout = 5_000;
  server.requestTimeout = 5_000;
  server.maxHeadersCount = 32;
  return {
    bootId,
    server,
    /** Zeroes the boot key; every unlock row sealed under it becomes unopenable. */
    close: () => new Promise<void>((resolve) => { bootKey.fill(0); server.close(() => resolve()); server.closeAllConnections(); }),
  };
}
