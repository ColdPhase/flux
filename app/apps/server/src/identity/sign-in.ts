import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * What the request that is creating a session knows about how the person signed in (#310). The bridge
 * opens one per auth request; the provider's ID-token check fills it in, and the session hook records it.
 * Without a provider, the session was created by the password.
 */
export interface SignInFacts { providerId?: string; idpSid?: string }
export const createSignIns = () => new AsyncLocalStorage<SignInFacts>();
export type SignIns = ReturnType<typeof createSignIns>;
