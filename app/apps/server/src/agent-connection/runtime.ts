import { randomUUID } from 'node:crypto';
import type { AuthenticatedAgentRuntime } from '@flux/contracts';
import { agentExecutionRows } from '@flux/db';
import { DomainError, isUuid, type Transaction } from '@flux/core';
import { agentConnectionInTransaction, type FluxMcpClaims } from './context.js';

/** Runtime creation/recovery never derives identity or authority from MCP clientInfo/ACK. */
export async function agentRuntimeInTransaction(tx: Transaction, claims: FluxMcpClaims, clientSessionId: string) {
  if (!isUuid(clientSessionId)) throw new DomainError(400, 'INVALID_INPUT', 'A client session UUID is required');
  const current = await agentConnectionInTransaction(tx, claims, 'flux.context.read', null);
  if (!claims.grantReferenceId?.startsWith('flux-grant:') || !claims.clientId)
    throw new DomainError(403, 'ACTION_BINDING_REQUIRED', 'Connect again to create a current authenticated runtime');
  const rows = agentExecutionRows(tx);
  const bindingId = claims.grantReferenceId.slice('flux-grant:'.length);
  const binding = await rows.lockBinding(bindingId);
  if (!binding || binding.ownerUserId !== claims.ownerUserId || binding.connectionId !== claims.connectionId || binding.clientId !== claims.clientId)
    throw new DomainError(404, 'CONNECTION_NOT_FOUND', 'Connection not found');
  const now = await rows.now();
  const row = await rows.ensureRuntime({ id: randomUUID(), bindingId, bindingGeneration: binding.generation,
    clientSessionId: clientSessionId.toLowerCase(), workspaceId: current.workspaceId, connectionId: claims.connectionId,
    ownerUserId: claims.ownerUserId, agentId: current.principal.id, scopes: [...current.connection.scopes].sort(),
    expiresAt: new Date(now.getTime() + 3_600_000) });
  // Reusing a client session observes its original server-issued identity; it never renews expiry.
  const fresh = await rows.now();
  if (row.revokedAt || row.expiresAt <= fresh || row.bindingGeneration !== binding.generation
    || row.workspaceId !== current.workspaceId || row.ownerUserId !== claims.ownerUserId || row.agentId !== current.principal.id
    || JSON.stringify([...row.scopes].sort()) !== JSON.stringify([...current.connection.scopes].sort()))
    throw new DomainError(409, 'RUNTIME_UNAVAILABLE', 'The runtime is no longer compatible; start a new client session');
  const runtime: AuthenticatedAgentRuntime = { id: row.id, workspaceId: row.workspaceId, connectionId: row.connectionId,
    ownerUserId: row.ownerUserId, agentId: row.agentId, clientId: binding.clientId, grantReferenceId: claims.grantReferenceId,
    bindingGeneration: row.bindingGeneration, scopes: [...current.connection.scopes],
    createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString() };
  return { runtime, connection: current.connection };
}
