import type { AgentConnection, AgentOauthConsentContext, AgentOauthRedirect } from '@flux/contracts';

/** Constructed only after the provider-signed query has been verified at ingress. */
export interface AgentOauthFlow {
  clientId: string;
  /** The signed request's redirect URI, which the provider matched to the client's registration before signing. */
  redirectUri: string;
}
export interface AgentOauthGrant {
  referenceId: string;
  clientId: string | null;
  connection: AgentConnection;
}
/** The adapter owns transactions. A sign-in is one decision: the connection a client already holds, or the one this makes. */
export interface AgentOauthPort {
  /** The name of the connection this person's client already holds, or null when approving makes a new one. */
  heldConnectionName(ownerId: string, clientId: string): Promise<string | null>;
  grantForOauth(ownerId: string, referenceId: string): Promise<AgentOauthGrant | null>;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

/**
 * Where the code and tokens of an approved request go (#287; MCP 2026-07-28 security considerations:
 * the authorization server must clearly show the redirect URI's host). Only a loopback address keeps
 * them on the person's own computer.
 */
export function oauthRedirectTarget(redirectUri: string): AgentOauthRedirect {
  let url: URL;
  try { url = new URL(redirectUri); } catch { return { kind: 'app', host: redirectUri }; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:' || !url.hostname) return { kind: 'app', host: redirectUri };
  return { kind: LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) ? 'loopback' : 'web', host: url.host };
}

/** The host of a Client ID Metadata Document client_id (an https URL); null for any other client_id. */
export function oauthClientIdHost(clientId: string): string | null {
  try {
    const url = new URL(clientId);
    return url.protocol === 'https:' && url.hostname ? url.host : null;
  } catch { return null; }
}

/** What the consent screen shows: who asks, where access goes, and the connection that already exists, if any. */
export function agentOauthUseCases(port: AgentOauthPort) {
  return {
    async consentContext(ownerId: string, flow: AgentOauthFlow, clientName: string): Promise<AgentOauthConsentContext> {
      return { clientName, clientIdHost: oauthClientIdHost(flow.clientId), redirect: oauthRedirectTarget(flow.redirectUri),
        connectionName: await port.heldConnectionName(ownerId, flow.clientId) };
    },
    grantForOauth: (ownerId: string, referenceId: string) => port.grantForOauth(ownerId, referenceId),
  };
}
