import { KeyringUnavailableError } from './errors.js';
import { fromB64url } from './primitives.js';

/**
 * The client of `@flux/keyring` (F-030 Unlock lifecycle): a process holding one random boot key in RAM only, reached
 * over the internal single-host `keyring` network with a bearer token. DEKs are sealed under the boot key and stored
 * in `workspace_unlocks`; a keyring restart makes every unlock row unopenable, which locks every sealed workspace.
 */
export interface KeyringPort {
  /** The keyring's boot id (the heartbeat). Throws {@link KeyringUnavailableError}. */
  boot(): Promise<string>;
  /** Seals a DEK under the boot key. */
  seal(workspaceId: string, keyVersion: number, dek: Buffer): Promise<{ bootId: string; sealed: string }>;
  /** Opens a sealed DEK of this boot; {@link StaleBootError} when `bootId` is another boot's. The caller zeroes the DEK. */
  open(workspaceId: string, keyVersion: number, bootId: string, sealed: string): Promise<Buffer>;
}

/** The unlock row was sealed by another keyring boot: the workspace is locked. */
export class StaleBootError extends Error {
  constructor() { super('The unlock row belongs to another keyring boot'); this.name = 'StaleBootError'; }
}

export interface KeyringClientOptions { url: string; token: string; timeoutMs?: number }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function httpKeyring({ url, token, timeoutMs = 2_000 }: KeyringClientOptions): KeyringPort {
  async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> | null }> {
    let response: Response;
    try {
      response = await fetch(new URL(path, url), {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new KeyringUnavailableError();
    }
    let json: Record<string, unknown> | null = null;
    try { json = await response.json() as Record<string, unknown>; } catch { json = null; }
    return { status: response.status, json };
  }
  const bootOf = (json: Record<string, unknown> | null) => {
    const bootId = json?.bootId;
    if (typeof bootId !== 'string' || !UUID.test(bootId)) throw new KeyringUnavailableError();
    return bootId;
  };
  return {
    async boot() {
      const { status, json } = await call('GET', '/v1/boot');
      if (status !== 200) throw new KeyringUnavailableError();
      return bootOf(json);
    },
    async seal(workspaceId, keyVersion, dek) {
      const { status, json } = await call('POST', '/v1/seal', { workspaceId, keyVersion, dek: dek.toString('base64url') });
      if (status !== 200 || typeof json?.sealed !== 'string') throw new KeyringUnavailableError();
      return { bootId: bootOf(json), sealed: json.sealed };
    },
    async open(workspaceId, keyVersion, bootId, sealed) {
      const { status, json } = await call('POST', '/v1/open', { workspaceId, keyVersion, bootId, sealed });
      if (status === 409) throw new StaleBootError();
      if (status !== 200) throw new KeyringUnavailableError();
      const dek = fromB64url(json?.dek);
      if (dek.length !== 32) { dek.fill(0); throw new KeyringUnavailableError(); }
      return dek;
    },
  };
}

/**
 * The keyring of this process from its environment: `FLUX_KEYRING=off`, or no token, means none (every sealed
 * workspace stays locked and creation answers `503 KEYRING_UNAVAILABLE`). `FLUX_KEYRING_URL` defaults to the
 * Compose service on the `keyring` network.
 */
export function keyringFromEnv(env: Readonly<Record<string, string | undefined>>): KeyringPort | null {
  if (env.FLUX_KEYRING === 'off') return null;
  const token = env.FLUX_KEYRING_TOKEN?.trim();
  if (!token) return null;
  return httpKeyring({ url: env.FLUX_KEYRING_URL || 'http://keyring:8090', token });
}
