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

/** A probe result shared for a few seconds, so a busy sign-in page does not hammer the provider. */
export function cachedReachability(oidc: Pick<OidcConfig, 'issuer'>, ttlMs = 5000, probe: () => Promise<boolean> = () => discoveryReachable(oidc), now: () => number = Date.now) {
  let cached: { at: number; value: Promise<boolean> } | null = null;
  return () => {
    if (!cached || now() - cached.at >= ttlMs) cached = { at: now(), value: probe() };
    return cached.value;
  };
}
