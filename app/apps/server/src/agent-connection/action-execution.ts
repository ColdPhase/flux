import { z } from 'zod';
import type { AgentExecutionCommand, AgentJsonValue, AgentOperation, AgentPostcondition, AuthenticatedAgentRuntime,
  ObjectRef } from '@flux/contracts';
import { sketchRows, type Database, type Transaction } from '@flux/db';
import { agentExecutionUseCases, requestHash, type Principal } from '@flux/core';
import { nativeConversationsInEventSession } from '../conversation/store.js';
import { nativeDocsInEventSession } from '../docs/adapters.js';
import { nativeSketchInEventSession } from '../sketches/adapters.js';
import { nativeWorkInEventSession } from '../work/adapters.js';
import { transactionEventSession } from '../work/transaction-events.js';
import type { FluxMcpClaims } from './context.js';
import { agentExecutionInTransaction } from './execution.js';
import { assistantChangeExecutor, type AssistantCall } from './assistant-changes.js';

export const actionId = z.uuid();
export const actionVersion = z.int().min(1).max(2_147_483_647);
/** What every change tool of a person's things takes: the project, one UUID per intended effect and the exact material revisions it cites. */
export const actionInput = () => ({
  projectId: actionId,
  clientCommandId: actionId.describe('One UUID per intended effect; reuse it only to retry that same effect.'),
  /** Exact current material revisions the action relies on; each must still be current when it commits. */
  sources: z.array(z.strictObject({ materialId: actionId, version: actionVersion })).max(50).default([]),
});
/** What a coordination command also names: the runtime of this client session from flux_bootstrap, which its receipt is bound to. */
export const coordinationInput = () => ({
  ...actionInput(),
  runtimeSessionId: actionId.describe('The runtime ID returned by flux_bootstrap for this client session.'),
});
export const actionAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true };

export type ActionInput = { projectId: string; clientCommandId: string; sources: { materialId: string; version: number }[];
  /** Set by the change tool's wrapper (tool-registry): the exact call, kept redacted when the change waits for its owner. */
  assistantCall?: AssistantCall };
export type CoordinationActionInput = ActionInput & { runtimeSessionId: string };
export interface NativeActions {
  work: ReturnType<typeof nativeWorkInEventSession>;
  maps: ReturnType<typeof nativeSketchInEventSession>;
  /** The project doc commands with the agent as real author (`agentAuthors`), in this transaction. */
  docs: ReturnType<typeof nativeDocsInEventSession>;
  /** The project conversation start/reply commands with the agent as real author, in this transaction. */
  conversations: ReturnType<typeof nativeConversationsInEventSession>;
  /** This action's transaction and event session, for a native effect that composes its own ports (the question card). */
  transaction: Transaction;
  events: ReturnType<typeof transactionEventSession>;
  /** The acting agent, from the server-issued runtime, never from tool input. */
  agent: Principal;
  runtime: AuthenticatedAgentRuntime;
  /** The map's change checkpoint as this transaction leaves it: the produced post-state of a map change. */
  mapCheckpoint(mapId: string): Promise<Extract<AgentPostcondition, { kind: 'map_checkpoint' }>>;
}
export type Produced<T> = { value: T; postconditions: AgentPostcondition[] };
type Execute<I> = <T extends { [key: string]: AgentJsonValue }>(input: I, operation: AgentOperation, objectId: string | null,
  payload: AgentJsonValue, effect: (native: NativeActions) => Promise<Produced<T>>) => Promise<T & { replayed: boolean }>;

/** The authorized material revisions become the object's sources; nothing else is linked implicitly. */
export const materialSources = (input: ActionInput): { sources?: ObjectRef[] } => input.sources.length
  ? { sources: input.sources.map((source) => ({ type: 'material' as const, id: source.materialId, version: source.version })) } : {};

/**
 * The effect path of a change to a person's things, for the assistant's runs and for a local client alike (F-036 AG-3, mcp-cowork
 * LC-2): the owner's rights now, "What it may do", and the change log in the same transaction. It applies the change, makes it wait
 * for the owner's OK (deleting, other people's things, a task for someone else, everything under Ask me first), or refuses it. The
 * result of a waiting change is plain words, which the tool wrapper hands back as text.
 */
export function nativeActionExecutor(db: Database, claims: FluxMcpClaims): Execute<ActionInput> {
  return assistantChangeExecutor(db, claims) as unknown as Execute<ActionInput>;
}

/**
 * The effect path of coordination (a question, a task-thread post, a pull request link, undoing one's own unused task): the agent's
 * own words or claim on a task, not a change to anyone's things, so nothing waits. One caller-owned transaction: the owner's rights
 * and the runtime are checked, the canonical command runs as the agent, its produced post-state is checked and the receipt stored;
 * only then is the single final event batch flushed. A retry with the same command ID returns the stored outcome without a second
 * effect or event.
 */
export function coordinationExecutor(db: Database, claims: FluxMcpClaims, privateTarget?: 'task-discussion/v1'): Execute<CoordinationActionInput> {
  return async function execute<T extends { [key: string]: AgentJsonValue }>(input: CoordinationActionInput, operation: AgentOperation,
    objectId: string | null, payload: AgentJsonValue, effect: (native: NativeActions) => Promise<Produced<T>>) {
    const command: AgentExecutionCommand = { runtimeSessionId: input.runtimeSessionId, clientCommandId: input.clientCommandId,
      projectId: input.projectId, operation, peerRequestClass: 'execute', audience: { kind: 'project', projectId: input.projectId },
      objectId, sources: input.sources, payload };
    return db.transaction(async (tx) => {
      const session = transactionEventSession(tx);
      let replayed = false;
      const value = await agentExecutionUseCases(agentExecutionInTransaction(tx, claims, {}, privateTarget)).run(command, async (scope) => {
        if (scope.replay) {
          replayed = true;
          return { value: scope.replay.value, postconditions: scope.replay.postconditions };
        }
        return effect({ work: nativeWorkInEventSession(tx, session),
          maps: nativeSketchInEventSession(tx, session, { prepared: false, commandId: input.clientCommandId, operation: `native-agent:${operation}`, fingerprint: requestHash(command), retainUntil: () => undefined }),
          docs: nativeDocsInEventSession(tx, session), conversations: nativeConversationsInEventSession(tx, session),
          transaction: tx, events: session, agent: { kind: 'agent', id: scope.context.agentId }, runtime: scope.context,
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
