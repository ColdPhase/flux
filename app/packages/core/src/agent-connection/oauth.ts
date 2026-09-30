import type { AgentConnection, AgentOauthConsentContext } from '@flux/contracts';
import { isUuid } from '../access/policy.js';

/** Constructed only after the provider-signed query has been verified at ingress. */
export interface AgentOauthFlow {
  fingerprint: string;
  clientId: string;
  scopes: readonly string[];
  expiresAt: Date;
}
export interface AgentOauthGrant {
  referenceId: string;
  clientId: string | null;
  connection: AgentConnection;
}
/** The adapter owns transactions; the callback never reads a browser-global selection. */
export interface AgentOauthPort {
  chooseFlow(ownerId: string, sessionId: string, connectionId: string, flow: AgentOauthFlow):
    Promise<'SELECTED' | 'CONNECTION_NOT_FOUND' | 'ALREADY_SELECTED'>;
  flowForOauth(ownerId: string, sessionId: string, fingerprint: string): Promise<AgentOauthGrant | null>;
  consentForOauth(ownerId: string, sessionId: string, flow: AgentOauthFlow): Promise<AgentOauthConsentContext | null>;
  grantForOauth(ownerId: string, referenceId: string): Promise<AgentOauthGrant | null>;
}

/** Public choice validation is shared by every transport; selection remains atomic in the adapter. */
export function agentOauthUseCases(port: AgentOauthPort) {
  return {
    chooseFlow(ownerId: string, sessionId: string, connectionId: string, flow: AgentOauthFlow) {
      if (!ownerId || !sessionId || !isUuid(connectionId)) return Promise.resolve('CONNECTION_NOT_FOUND' as const);
      return port.chooseFlow(ownerId, sessionId, connectionId, flow);
    },
    consentForOauth: (ownerId: string, sessionId: string, flow: AgentOauthFlow) => port.consentForOauth(ownerId, sessionId, flow),
    flowForOauth: (ownerId: string, sessionId: string, fingerprint: string) => port.flowForOauth(ownerId, sessionId, fingerprint),
    grantForOauth: (ownerId: string, referenceId: string) => port.grantForOauth(ownerId, referenceId),
  };
}
