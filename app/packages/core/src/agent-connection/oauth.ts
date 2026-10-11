import type { AgentConnection, AgentOauthConsentContext, AgentOauthRedirect } from '@flux/contracts';
import { isUuid } from '../access/policy.js';

/** Constructed only after the provider-signed query has been verified at ingress. */
export interface AgentOauthFlow {
  fingerprint: string;
  clientId: string;
  /** The signed request's redirect URI, which the provider matched to the client's registration before signing. */
  redirectUri: string;
  scopes: readonly string[];
  expiresAt: Date;
}
export interface AgentOauthGrant {
  referenceId: string;
  clientId: string | null;
  connection: AgentConnection;
}
/** The adapter's part of the consent screen; the use case adds where the authorization goes. */
export type AgentOauthConsentRecord = Omit<AgentOauthConsentContext, 'clientIdHost' | 'redirect'>;
/** The adapter owns transactions; the callback never reads a browser-global selection. */
export interface AgentOauthPort {
  chooseFlow(ownerId: string, sessionId: string, connectionId: string, flow: AgentOauthFlow):
    Promise<'SELECTED' | 'CONNECTION_NOT_FOUND' | 'ALREADY_SELECTED'>;
  flowForOauth(ownerId: string, sessionId: string, fingerprint: string): Promise<AgentOauthGrant | null>;
  consentForOauth(ownerId: string, sessionId: string, flow: AgentOauthFlow): Promise<AgentOauthConsentRecord | null>;
  grantForOauth(ownerId: string, referenceId: string): Promise<AgentOauthGrant | null>;
  /** The live connection this owner last bound to this client, so a client that must authorize again is offered it first (#312). */
  heldConnectionId(ownerId: string, clientId: string): Promise<string | null>;
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

/** Public choice validation is shared by every transport; selection remains atomic in the adapter. */
export function agentOauthUseCases(port: AgentOauthPort) {
  return {
    chooseFlow(ownerId: string, sessionId: string, connectionId: string, flow: AgentOauthFlow) {
      if (!ownerId || !sessionId || !isUuid(connectionId)) return Promise.resolve('CONNECTION_NOT_FOUND' as const);
      return port.chooseFlow(ownerId, sessionId, connectionId, flow);
    },
    async consentForOauth(ownerId: string, sessionId: string, flow: AgentOauthFlow): Promise<AgentOauthConsentContext | null> {
      const record = await port.consentForOauth(ownerId, sessionId, flow);
      return record && { ...record, clientIdHost: oauthClientIdHost(flow.clientId), redirect: oauthRedirectTarget(flow.redirectUri) };
    },
    flowForOauth: (ownerId: string, sessionId: string, fingerprint: string) => port.flowForOauth(ownerId, sessionId, fingerprint),
    grantForOauth: (ownerId: string, referenceId: string) => port.grantForOauth(ownerId, referenceId),
    heldConnectionId: (ownerId: string, clientId: string) => port.heldConnectionId(ownerId, clientId),
  };
}
