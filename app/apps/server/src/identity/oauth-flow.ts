import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentOauthFlow } from '@flux/core';
import { oauthFlow, verifiedOauthQuery } from './oauth-query.js';

export interface OauthRequestContext { clientId: string; flow: AgentOauthFlow | null; clearedSessionId: string | null;
  /** The person's decision on the consent page: only an approval may make a connection (#859). */
  consenting: boolean }
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
    return { clientId: flow.clientId, flow, clearedSessionId: params.get('ba_pl'), consenting: url.pathname.endsWith('/oauth2/consent') };
  }
  const clientId = url.pathname.endsWith('/oauth2/authorize') ? url.searchParams.get('client_id') : null;
  if (clientId) return { clientId, flow: null, clearedSessionId: null, consenting: false };
  return undefined;
}
