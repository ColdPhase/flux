import { createHash } from 'node:crypto';
import type { AgentCommandReceipt, AgentExecutionCommand, AgentOperation, AgentPostcondition, AuthenticatedAgentRuntime } from '@flux/contracts';
import { agentExecutionRows, agentProjectObjectRows } from '@flux/db';
import { agentOutcomeFingerprint, DomainError, enforce, evaluateProject, normalizeAgentExecution, validateAgentPostconditions,
  type AgentExecutionOutcome, type AgentExecutionPort, type AgentExecutionScope,
  type NormalizedAgentExecutionCommand, type Transaction } from '@flux/core';
import { agentConnectionInTransaction, type FluxMcpClaims } from './context.js';

type StoredRuntime = NonNullable<Awaited<ReturnType<ReturnType<typeof agentExecutionRows>['lockRuntime']>>>;
type StoredGrant = NonNullable<Awaited<ReturnType<ReturnType<typeof agentExecutionRows>['lockGrant']>>>;
interface Prepared {
  command: NormalizedAgentExecutionCommand;
  fingerprint: string;
  runtime: StoredRuntime;
  grant: StoredGrant;
  context: AuthenticatedAgentRuntime;
  replay: AgentCommandReceipt | null;
  closed: boolean;
}
export interface AgentExecutionDomainChecks {
  /** #153 verifies typed claim post-state directly against its canonical rows in this transaction. */
  coordinationPostcondition?(tx: Transaction, context: AuthenticatedAgentRuntime, command: NormalizedAgentExecutionCommand,
    condition: Extract<AgentPostcondition, { kind: 'cowork.claim_state' }>): Promise<boolean>;
}
function denied(code = 'AGENT_EXECUTION_UNAVAILABLE') {
  return new DomainError(403, code, 'Current runtime, action grant or project authority is unavailable');
}
/** One trusted port bound to this exact caller-owned TX. It never commits, flushes events or opens a receipt TX. */
export function agentExecutionInTransaction(tx: Transaction, claims: FluxMcpClaims,
  domain: AgentExecutionDomainChecks = {}): AgentExecutionPort<Transaction> {
  claims = Object.freeze({ ...claims, scopes: Object.freeze([...claims.scopes]) });
  const rows = agentExecutionRows(tx);
  const handles = new WeakMap<AgentExecutionScope<Transaction>, Prepared>();
  const recheck = async (prepared: Prepared, requireUnused: boolean) => {
    const { command, runtime, grant, context } = prepared;
    await agentConnectionInTransaction(tx, claims, 'flux.action.execute', command.projectId);
    enforce(await evaluateProject({ kind: 'agent', id: context.agentId }, 'project.write', command.projectId, tx, { lock: true }), 'project');
    for (const source of command.sources) if (await rows.sourceVersion(context.workspaceId, command.projectId, source.materialId) !== source.version)
      throw new DomainError(409, 'SOURCE_VERSION_CONFLICT', 'A referenced source changed; recover before continuing');
    const binding = await rows.lockBinding(runtime.bindingId);
    const liveRuntime = await rows.lockRuntime(runtime.id);
    const liveGrant = await rows.lockGrant(grant.id);
    const now = await rows.now(); // fresh DB wall time after every relevant lock wait
    if (!binding || binding.generation !== context.bindingGeneration || !liveRuntime || liveRuntime.revokedAt || liveRuntime.expiresAt <= now
      || liveRuntime.bindingId !== runtime.bindingId || liveRuntime.bindingGeneration !== context.bindingGeneration
      || liveRuntime.connectionId !== context.connectionId || liveRuntime.ownerUserId !== context.ownerUserId
      || liveRuntime.agentId !== context.agentId || liveRuntime.workspaceId !== context.workspaceId
      || JSON.stringify([...liveRuntime.scopes].sort()) !== JSON.stringify([...context.scopes].sort())
      || !liveGrant || liveGrant.generation !== grant.generation || liveGrant.revokedAt || liveGrant.expiresAt <= now
      || liveGrant.connectionId !== context.connectionId || liveGrant.ownerUserId !== context.ownerUserId
      || liveGrant.workspaceId !== context.workspaceId || liveGrant.projectId !== command.projectId
      || liveGrant.operation !== command.operation || liveGrant.peerRequestClass !== command.peerRequestClass
      || liveGrant.objectId !== null && liveGrant.objectId !== command.objectId
      || requireUnused && liveGrant.used >= liveGrant.maximumUses) throw denied();
    return now;
  };
  const postState = async (prepared: Prepared, conditions: AgentPostcondition[]) => {
    validateAgentPostconditions(prepared.command.operation, conditions);
    const ordered = [...conditions].sort((a, b) => {
      const rank = (item: AgentPostcondition) => item.kind === 'map' || item.kind === 'map_checkpoint' ? 0 : 1;
      return rank(a) - rank(b) || ('id' in a ? a.id : a.unitId).localeCompare('id' in b ? b.id : b.unitId);
    });
    for (const condition of ordered) {
      const target = prepared.command.objectId;
      if (target && (condition.kind === 'work' || condition.kind === 'map' || condition.kind === 'map_checkpoint') && condition.id !== target
        || target && condition.kind === 'cowork.claim_state' && condition.unitId !== target)
        throw new DomainError(409, 'COMMAND_POSTSTATE_INVALID', 'The produced post-state belongs to another target');
      if (condition.kind === 'cowork.claim_state' && (condition.workspaceId !== prepared.context.workspaceId
        || condition.projectId !== prepared.command.projectId || condition.connectionId !== prepared.context.connectionId
        || condition.role !== prepared.command.peerRequestClass
        || condition.leaseSessionId !== null && condition.leaseSessionId !== prepared.context.id))
        throw new DomainError(409, 'COMMAND_POSTSTATE_INVALID', 'The claim post-state belongs to another context or role');
      const allowed = condition.kind === 'cowork.claim_state'
        ? !!domain.coordinationPostcondition && await domain.coordinationPostcondition(tx, prepared.context, prepared.command, condition)
        : await rows.nativePostcondition(prepared.context.workspaceId, prepared.command.projectId, condition,
          prepared.command.operation === 'map.positions.update' || prepared.command.operation === 'map.thought.create'
            || prepared.command.operation === 'map.thought.update' ? prepared.command.objectId ?? undefined : undefined);
      if (!allowed) throw new DomainError(409, 'COMMAND_POSTSTATE_STALE', 'The produced object changed; recover before continuing');
    }
  };
  return {
    async prepare(command) {
      // The trusted adapter still recomputes identity; a caller-supplied hash cannot hide changed payloads.
      const input = Object.fromEntries(Object.entries(command).filter(([key]) => key !== 'fingerprint')) as unknown as AgentExecutionCommand;
      command = normalizeAgentExecution(input);
      const current = await agentConnectionInTransaction(tx, claims, 'flux.action.execute', command.projectId);
      if (!claims.grantReferenceId?.startsWith('flux-grant:') || !claims.clientId) throw denied('ACTION_BINDING_REQUIRED');
      const bindingId = claims.grantReferenceId.slice('flux-grant:'.length);
      const binding = await rows.lockBinding(bindingId);
      const runtime = await rows.lockRuntime(command.runtimeSessionId);
      if (!binding || !runtime || runtime.bindingId !== bindingId || runtime.bindingGeneration !== binding.generation
        || binding.ownerUserId !== claims.ownerUserId || binding.connectionId !== claims.connectionId || binding.clientId !== claims.clientId
        || runtime.ownerUserId !== claims.ownerUserId || runtime.connectionId !== claims.connectionId || runtime.agentId !== current.principal.id
        || runtime.workspaceId !== current.workspaceId || !runtime.scopes.includes('flux.action.execute')
        || runtime.scopes.some((scope) => !current.connection.scopes.includes(scope as 'flux.context.read' | 'flux.proposal.write' | 'flux.action.execute')))
        throw denied();
      const grant = await rows.lockGrant(command.grantId);
      if (!grant || grant.connectionId !== claims.connectionId || grant.ownerUserId !== claims.ownerUserId
        || grant.workspaceId !== current.workspaceId || grant.projectId !== command.projectId
        || grant.operation !== command.operation || grant.peerRequestClass !== command.peerRequestClass
        || grant.objectId !== null && grant.objectId !== command.objectId) throw denied();
      const initialNow = await rows.now();
      if (runtime.revokedAt || runtime.expiresAt <= initialNow || grant.revokedAt || grant.expiresAt <= initialNow) throw denied();
      const context: AuthenticatedAgentRuntime = Object.freeze({ id: runtime.id, workspaceId: runtime.workspaceId,
        connectionId: runtime.connectionId, ownerUserId: runtime.ownerUserId, agentId: runtime.agentId,
        clientId: binding.clientId, grantReferenceId: claims.grantReferenceId, bindingGeneration: binding.generation,
        scopes: [...runtime.scopes] as AuthenticatedAgentRuntime['scopes'], createdAt: runtime.createdAt.toISOString(), expiresAt: runtime.expiresAt.toISOString() });
      Object.freeze(context.scopes);
      const fingerprint = createHash('sha256').update(JSON.stringify([command.fingerprint, context.ownerUserId,
        context.connectionId, context.agentId, context.workspaceId, context.clientId, context.grantReferenceId,
        context.bindingGeneration, [...context.scopes].sort(), [...claims.scopes].sort()])).digest('hex');
      await rows.lockCommand(claims.connectionId, command.clientCommandId);
      const stored = await rows.receipt(claims.connectionId, command.clientCommandId);
      if (stored && (stored.fingerprint !== fingerprint || stored.runtimeSessionId !== runtime.id
        || stored.grantId !== grant.id || stored.grantGeneration !== grant.generation
        || stored.bindingId !== bindingId || stored.bindingGeneration !== binding.generation))
        throw new DomainError(409, 'IDEMPOTENCY_CONFLICT', 'This command ID belongs to another execution context or payload');
      const replay: AgentCommandReceipt | null = stored ? { clientCommandId: stored.clientCommandId,
        runtimeSessionId: stored.runtimeSessionId, operation: stored.operation, projectId: stored.projectId,
        value: stored.value, postconditions: stored.postconditions, completedAt: stored.completedAt.toISOString() } : null;
      if (command.objectId && command.operation === 'work.update'
        && !await agentProjectObjectRows(tx).scopeOf('work', command.objectId, { workspaceId: context.workspaceId, projectId: command.projectId }, false))
        throw new DomainError(404, 'OBJECT_NOT_FOUND', 'Project object not found');
      const mapChanges: AgentOperation[] = ['map.rename', 'map.thought.create', 'map.thought.update', 'map.thought.delete',
        'map.positions.update', 'map.link.create', 'map.link.delete'];
      if (command.objectId && mapChanges.includes(command.operation)
        && !await agentProjectObjectRows(tx).scopeOf('sketch', command.objectId, { workspaceId: context.workspaceId, projectId: command.projectId }, false))
        throw new DomainError(404, 'OBJECT_NOT_FOUND', 'Project object not found');
      const prepared: Prepared = { command, fingerprint, runtime, grant, context, replay, closed: false };
      const now = await recheck(prepared, replay === null);
      // Coordination acquires its complete sorted task/unit lock set after this authorization.
      // Its post-state callback runs at complete, after those locks, never early during prepare.
      const scope = Object.freeze({ transaction: tx, context, now, replay: replay ? structuredClone(replay) : null });
      handles.set(scope, prepared);
      return scope;
    },
    async complete(scope, outcome: AgentExecutionOutcome) {
      const prepared = handles.get(scope);
      if (!prepared || scope.transaction !== tx || prepared.closed) throw new DomainError(409, 'EXECUTION_SCOPE_INVALID', 'Unknown or completed execution scope');
      if (prepared.replay && agentOutcomeFingerprint(outcome) !== agentOutcomeFingerprint(prepared.replay))
        throw new DomainError(409, 'IDEMPOTENCY_CONFLICT', 'A replay must retain its original result and post-state');
      await postState(prepared, outcome.postconditions);
      const completedAt = await recheck(prepared, prepared.replay === null);
      if (!prepared.replay) {
        if (!await rows.debit(prepared.grant.id, prepared.grant.generation)) throw denied();
        await rows.saveReceipt({ connectionId: prepared.context.connectionId, clientCommandId: prepared.command.clientCommandId,
          runtimeSessionId: prepared.context.id, grantId: prepared.grant.id, grantGeneration: prepared.grant.generation,
          bindingId: prepared.runtime.bindingId, bindingGeneration: prepared.context.bindingGeneration,
          fingerprint: prepared.fingerprint, operation: prepared.command.operation, projectId: prepared.command.projectId,
          value: outcome.value, postconditions: outcome.postconditions, completedAt });
      }
      prepared.closed = true;
    },
  };
}
