import { AsyncLocalStorage } from 'node:async_hooks';
import type { OfflineGrant } from './standing.js';

/**
 * What the request that is creating a session knows about how the person signed in (#310). The bridge
 * opens one per auth request; the provider's ID-token check fills it in, and the session hook records it.
 * Without a provider, the session was created by the password.
 */
export interface SignInFacts {
  providerId?: string;
  idpSid?: string;
  /** The provider's offline refresh token from this sign-in, for the standing check (S4, #311). Never logged or stored here. */
  refreshToken?: string;
  /** What the silent offline-access step brought back; the bridge sets it before resuming the held callback (S1, revised 2026-10-09). */
  offline?: OfflineGrant;
  /** Set when Flux refused the sign-in itself; the bridge tells the browser why. */
  refused?: 'no_refresh_token';
}
export const createSignIns = () => new AsyncLocalStorage<SignInFacts>();
export type SignIns = ReturnType<typeof createSignIns>;
