import { AsyncLocalStorage } from 'node:async_hooks';

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
  /** Set when Flux refused the sign-in itself; the bridge tells the browser why. */
  refused?: 'no_refresh_token' | 'email_held' | 'email_claim' | 'linked' | 'identity_held' | 'already_linked' | 'link_expired';
  /** A link round trip for this password session's intent (#315): the callback attaches the subject, signs nobody in. */
  link?: { id: string; userId: string };
  /** The callback carried a link cookie that matches no pending intent of this session (#315). */
  linkRejected?: boolean;
  /** With `email_claim`: the secret for the browser that completed the provider sign-in (#313). Set as a cookie by the bridge. */
  claimToken?: string;
}
export const createSignIns = () => new AsyncLocalStorage<SignInFacts>();
export type SignIns = ReturnType<typeof createSignIns>;
