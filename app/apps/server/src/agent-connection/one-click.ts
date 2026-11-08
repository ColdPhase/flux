import type { ExternalClientDesignation } from '@flux/contracts';
import { createAgent, ForbiddenError, oauthRedirectTarget, type AgentOauthFlow, type AgentOauthGrant } from '@flux/core';
import { accessPorts, agentConnectionRepository, oauthClientName, type Database } from '@flux/db';

/** The label a client's own name suggests (a recognition aid only; it grants nothing and proves nothing, #763 AG-6). */
function designationOf(name: string | null): ExternalClientDesignation {
  return name && /claude/i.test(name) ? 'claude_code' : name && /codex/i.test(name) ? 'codex' : 'other';
}

/**
 * Signing in a local client is one decision (F-036 LC-1, #859). The person approves once; Flux then holds one connection for that
 * client, with an agent of the person's own behind it. The agent has exactly the person's rights (checked again at every call) and
 * does what its "What it may do" says. Nothing the client asks for widens that: it asks for no scope Flux would weigh, and there is
 * no project list or capability switch to fill in.
 */
export function createOneClickSignIn(db: Database) {
  const connections = agentConnectionRepository(db);
  return {
    /** The connection this person's client already holds, if any. Writes nothing, so it is safe to ask before the person has approved. */
    held(ownerUserId: string, clientId: string): Promise<AgentOauthGrant | null> {
      return db.transaction((tx) => connections.held(tx, ownerUserId, clientId));
    },

    /** Whether approving would give this person a connection: they already hold one, or belong to a company to make an agent in. */
    available(ownerUserId: string, clientId: string): Promise<boolean> {
      return db.transaction(async (tx) => !!await connections.held(tx, ownerUserId, clientId) || !!await connections.personalWorkspaceId(tx, ownerUserId));
    },

    /**
     * The grant the approved sign-in continues with: the connection the client holds, or a new one with its agent. Only an approval
     * (never the first look at a request, never a refusal) reaches this, and a second approval of the same client by the same person
     * finds the first one's connection.
     */
    async connect(ownerUserId: string, flow: AgentOauthFlow): Promise<AgentOauthGrant> {
      return db.transaction(async (tx) => {
        await connections.lockClient(tx, ownerUserId, flow.clientId);
        const held = await connections.held(tx, ownerUserId, flow.clientId);
        if (held) return held;
        const workspaceId = await connections.personalWorkspaceId(tx, ownerUserId);
        if (!workspaceId) throw new ForbiddenError('Only a member of the company can connect an agent client', 'AGENT_CONNECTION_UNAVAILABLE');
        const clientName = await oauthClientName(tx, flow.clientId);
        const clientDesignation = designationOf(clientName);
        const label = clientDesignation === 'claude_code' ? 'Claude Code' : clientDesignation === 'codex' ? 'Codex' : clientName?.trim().slice(0, 100) || 'Agent client';
        // Signing in again after a disconnect gives the client's earlier agent back: its tasks and history stay with one identity.
        const agentId = await connections.reusableAgent(tx, ownerUserId, flow.clientId, workspaceId)
          ?? (await createAgent({ kind: 'human', id: ownerUserId }, workspaceId, { name: label, owner: 'self' }, tx, accessPorts)).id;
        const name = oauthRedirectTarget(flow.redirectUri).kind === 'loopback' ? `${label} on this computer` : label;
        const grant = await connections.connect(tx, ownerUserId, { id: agentId, workspaceId }, { clientId: flow.clientId, name, clientDesignation });
        if (grant === 'AGENT_NOT_FOUND' || grant === 'CLIENT_NOT_FOUND')
          throw new ForbiddenError('This agent client is unavailable', 'AGENT_CONNECTION_UNAVAILABLE');
        return grant;
      });
    },
  };
}
