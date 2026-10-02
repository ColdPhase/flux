import { z } from 'zod';
import type { AgentExecutionCommand, AgentJsonValue, AgentOperation, AgentPostcondition, AuthenticatedAgentRuntime,
  ObjectRef } from '@flux/contracts';
import { sketchRows } from '@flux/db';
import { agentExecutionUseCases, type Database, type Principal } from '@flux/core';
import { nativeSketchInEventSession } from '../sketches/adapters.js';
import { nativeWorkInEventSession } from '../work/adapters.js';
import { transactionEventSession } from '../work/transaction-events.js';
import type { FluxMcpClaims } from './context.js';
import { agentExecutionInTransaction } from './execution.js';

export const actionId = z.uuid();
export const actionVersion = z.int().min(1).max(2_147_483_647);
/** The standing-grant execution fields every native action tool takes. */
export const actionInput = <C extends readonly ['execute', ...('execute' | 'plan')[]]>(classes: C) => ({
  projectId: actionId,
  runtimeSessionId: actionId.describe('The runtime ID returned by flux_bootstrap for this client session.'),
  grantId: actionId.describe('A live standing grant from flux_bootstrap for this exact operation, project, class and target.'),
  clientCommandId: actionId.describe('One UUID per intended effect; reuse it only to retry that same effect.'),
  peerRequestClass: z.enum(classes).describe('The class of the standing grant being used.'),
  /** Exact current material revisions the action relies on; each must still be current when it commits. */
  sources: z.array(z.strictObject({ materialId: actionId, version: actionVersion })).max(50).default([]),
});
export const actionAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true };

export type ActionInput = { projectId: string; runtimeSessionId: string; grantId: string; clientCommandId: string;
  peerRequestClass: 'execute' | 'plan'; sources: { materialId: string; version: number }[] };
export interface NativeActions {
  work: ReturnType<typeof nativeWorkInEventSession>;
  maps: ReturnType<typeof nativeSketchInEventSession>;
  /** The acting agent, from the server-issued runtime, never from tool input. */
  agent: Principal;
  runtime: AuthenticatedAgentRuntime;
  /** The map's change checkpoint as this transaction leaves it: the produced post-state of a map change. */
  mapCheckpoint(mapId: string): Promise<Extract<AgentPostcondition, { kind: 'map_checkpoint' }>>;
}
export type Produced<T> = { value: T; postconditions: AgentPostcondition[] };

/** The authorized material revisions become the object's sources; nothing else is linked implicitly. */
export const materialSources = (input: ActionInput): { sources?: ObjectRef[] } => input.sources.length
  ? { sources: input.sources.map((source) => ({ type: 'material' as const, id: source.materialId, version: source.version })) } : {};

/**
 * One caller-owned transaction per native action: the #152 receipt port authorizes the exact runtime,
 * grant, target and source versions; the canonical native command changes the project as the agent;
 * the produced post-state is checked, the grant debited and the receipt stored; only then is the single
 * final event batch flushed. A retry with the same command ID returns the stored outcome without a
 * second effect, debit or event.
 */
export function nativeActionExecutor(db: Database, claims: FluxMcpClaims) {
  return async function execute<T extends { [key: string]: AgentJsonValue }>(input: ActionInput, operation: AgentOperation,
    objectId: string | null, payload: AgentJsonValue, effect: (native: NativeActions) => Promise<Produced<T>>) {
    const command: AgentExecutionCommand = { runtimeSessionId: input.runtimeSessionId, grantId: input.grantId,
      clientCommandId: input.clientCommandId, projectId: input.projectId, operation, peerRequestClass: input.peerRequestClass,
      audience: { kind: 'project', projectId: input.projectId }, objectId, sources: input.sources, payload };
    return db.transaction(async (tx) => {
      const session = transactionEventSession(tx);
      let replayed = false;
      const value = await agentExecutionUseCases(agentExecutionInTransaction(tx, claims)).run(command, async (scope) => {
        if (scope.replay) {
          replayed = true;
          return { value: scope.replay.value, postconditions: scope.replay.postconditions };
        }
        return effect({ work: nativeWorkInEventSession(tx, session), maps: nativeSketchInEventSession(tx, session),
          agent: { kind: 'agent', id: scope.context.agentId }, runtime: scope.context,
          async mapCheckpoint(mapId) {
            const map = await sketchRows(tx).findSketch(mapId);
            if (!map) throw new Error('A changed map vanished inside its transaction');
            return { kind: 'map_checkpoint', id: map.id, updatedAt: map.updatedAt.toISOString() };
          } });
      });
      await session.flushEvents();
      return { ...(value as T), replayed };
    });
  };
}
