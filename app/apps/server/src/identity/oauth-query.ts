import { constantTimeEqual, makeSignature } from 'better-auth/crypto';
import { createHash } from 'node:crypto';
import type { AgentOauthFlow } from '@flux/core';

const TRANSPORT = new Set(['sig', 'exp', 'ba_iat', 'ba_pl', 'ba_param']);
/** All semantic parameters survive in this versioned fingerprint, including unknown extensions. */
export function oauthFingerprint(params: URLSearchParams): string {
  const entries = [...params.entries()].filter(([key]) => !TRANSPORT.has(key))
    .sort(([a, av], [b, bv]) => a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0);
  return createHash('sha256').update(`flux.oauth-flow.v1\n${new URLSearchParams(entries).toString()}`).digest('hex');
}

export function oauthFlow(params: URLSearchParams, resource: string): AgentOauthFlow | null {
  for (const key of new Set(params.keys())) if (key !== 'resource' && key !== 'ba_param' && params.getAll(key).length !== 1) return null;
  const clientId = params.get('client_id');
  // The provider matched it to the client's registration before signing; consent shows its host (#287).
  const redirectUri = params.get('redirect_uri');
  const scopes = (params.get('scope') ?? '').split(' ').filter(Boolean);
  const resources = params.getAll('resource');
  const expiry = Number(params.get('exp'));
  if (!clientId || !redirectUri || params.get('response_type') !== 'code' || params.get('code_challenge_method') !== 'S256' || !params.get('code_challenge')
    || !scopes.length || new Set(scopes).size !== scopes.length
    || scopes.some((scope) => !['flux.context.read', 'flux.proposal.write', 'flux.action.execute', 'offline_access'].includes(scope))
    || resources.length !== 1 || resources[0] !== resource || params.has('request') || params.has('request_uri')
    || !Number.isSafeInteger(expiry) || expiry <= 0) return null;
  return { fingerprint: oauthFingerprint(params), clientId, redirectUri, scopes, expiresAt: new Date(expiry * 1000) };
}

/**
 * Better Auth 1.7.6 signs its redirect query, but does not export its verifier.
 * Keep this in sync with the pinned provider's signed-query canonicalization.
 */
export async function verifiedOauthQuery(raw: string, secret: string): Promise<URLSearchParams | null> {
  if (!raw || raw.length > 8192) return null;
  const params = new URLSearchParams(raw);
  const signatures = params.getAll('sig');
  const expiry = Number(params.get('exp'));
  if (signatures.length !== 1 || !signatures[0] || params.getAll('exp').length !== 1 || !Number.isSafeInteger(expiry) || expiry * 1000 < Date.now()) return null;
  params.delete('sig');
  const canonical = new URLSearchParams([...params.entries()].sort(([keyA, valueA], [keyB, valueB]) =>
    keyA < keyB ? -1 : keyA > keyB ? 1 : valueA < valueB ? -1 : valueA > valueB ? 1 : 0));
  const expected = await makeSignature(canonical.toString(), secret);
  return constantTimeEqual(signatures[0], expected) ? params : null;
}
