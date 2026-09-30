import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentOauthFlow } from '@flux/core';
import { oauthFingerprint, oauthFlow, verifiedOauthQuery } from './oauth-query.js';

export interface OauthRequestContext { fingerprint: string; flow: AgentOauthFlow | null; clearedSessionId: string | null }
/** Composed per auth instance, never populated from an incoming header or shared mutable value. */
export const createOauthRequests = () => new AsyncLocalStorage<Readonly<OauthRequestContext>>();
export type OauthRequests = ReturnType<typeof createOauthRequests>;

export async function oauthRequestContext(url: URL, body: unknown, secret: string, resource: string): Promise<OauthRequestContext | undefined> {
  const form = typeof body === 'string' ? new URLSearchParams(body) : null;
  if (form && form.getAll('oauth_query').length > 1) throw new Error('Invalid OAuth query');
  const value = form ? Object.fromEntries(form) : body;
  const query = value && typeof value === 'object' && 'oauth_query' in value ? (value as { oauth_query?: unknown }).oauth_query : undefined;
  if (query !== undefined) {
    if (typeof query !== 'string') throw new Error('Invalid OAuth query');
    const params = await verifiedOauthQuery(query, secret);
    const flow = params ? oauthFlow(params, resource) : null;
    if (!params || !flow) throw new Error('Invalid OAuth query');
    return { fingerprint: flow.fingerprint, flow, clearedSessionId: params.get('ba_pl') };
  }
  if (url.pathname.endsWith('/oauth2/authorize'))
    return { fingerprint: oauthFingerprint(url.searchParams), flow: null, clearedSessionId: null };
  return undefined;
}
