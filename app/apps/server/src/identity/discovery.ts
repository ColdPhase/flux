import type { OidcConfig } from './config.js';

type Fetch = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** Whether the provider's discovery document answers now, with the endpoints Flux needs (#310 AC-4). */
export async function discoveryReachable(oidc: Pick<OidcConfig, 'issuer'>, fetcher: Fetch = fetch, timeoutMs = 3000): Promise<boolean> {
  try {
    const response = await fetcher(`${oidc.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return false;
    const document = await response.json() as Record<string, unknown> | null;
    return typeof document?.authorization_endpoint === 'string' && typeof document.token_endpoint === 'string' && typeof document.jwks_uri === 'string';
  } catch {
    return false;
  }
}

/** Retries with backoff (delay, 2x, ... capped) so an IdP that starts a little after Flux is still used. */
export async function waitForDiscovery(oidc: Pick<OidcConfig, 'issuer'>, options: {
  attempts?: number; delayMs?: number; maxDelayMs?: number; probe?: () => Promise<boolean>; sleep?: (ms: number) => Promise<void>;
} = {}): Promise<boolean> {
  const { attempts = 6, delayMs = 500, maxDelayMs = 5000, probe = () => discoveryReachable(oidc), sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)) } = options;
  let delay = delayMs;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (await probe()) return true;
    if (attempt < attempts) { await sleep(delay); delay = Math.min(delay * 2, maxDelayMs); }
  }
  return false;
}

/**
 * A probe result shared for a few seconds, so a busy sign-in page does not hammer the provider. Only the very first answer waits for
 * a probe: after that an expired result is answered at once with the last known one while a new probe runs in the background
 * (#847), so a sign-in page never waits for the provider's discovery document (about half a second on a real install). A page that
 * asks again every few seconds while the provider is down sees it come back one answer later. `known` seeds the first answer with what
 * startup already found out (the provider's discovery document was read, or was not, a moment ago), so even the first sign-in page after a
 * start never waits for a probe (up to 3 s when the provider is down; #1023).
 */
export function cachedReachability(oidc: Pick<OidcConfig, 'issuer'>, ttlMs = 5000, probe: () => Promise<boolean> = () => discoveryReachable(oidc), now: () => number = Date.now) {
  let cached: { at: number; value: Promise<boolean> } | null = null;
  let last: boolean | null = null;
  // A probe that was running when `known` told the answer must not overwrite it when it ends.
  let told = 0;
  const reachable = () => {
    if (!cached || now() - cached.at >= ttlMs) {
      const asked = told;
      cached = { at: now(), value: probe().then((value) => { if (asked === told) last = value; return value; }, () => { if (asked === told) last = false; return false; }) };
    }
    return last === null ? cached.value : Promise.resolve(last);
  };
  return Object.assign(reachable, {
    known(value: boolean) { told += 1; last = value; cached = { at: now(), value: Promise.resolve(value) }; },
  });
}
