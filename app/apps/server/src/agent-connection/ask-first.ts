import { randomUUID } from 'node:crypto';
import { ASSISTANT_CHANGE_LIMITS, assistantChangeWords, type AgentPostcondition, type AssistantObjectType } from '@flux/contracts';
import { assistantChangeRows, eventRepository, type DbExecutor, type Transaction } from '@flux/db';
import { DomainError, principalKey, WAITING_CHANGE_EVENT } from '@flux/core';
import { assistantCallFingerprint, redactCall, type AssistantCall, type AssistantText } from './assistant-changes.js';
import { agentConnectionInTransaction, type FluxMcpClaims } from './context.js';

/**
 * Ask me first for a local client's own work (#1419, coordinator decision 2026-11-13 under the founder's rule "Ask me first covers
 * changes in Flux"). The change tools wait through the change executor; these tools do not go through it, because they are the client's
 * own work on a task rather than a change to a person's things: a line in a task's discussion, a question to someone other than its owner,
 * a pull-request link, a proposal, and taking, pausing, finishing or declining a co-work unit. Other people see them or they change shared
 * Flux state, so with Ask me first on each of them waits for the owner's OK like any change (AG-3, C-18, LC-2). A question to the owner
 * alone never waits: asking the owner is how a client gets its OK. Renewing a claim the owner let it make does not wait either.
 *
 * The waiting change keeps the exact call and the client's sign-in; the owner's Approve repeats it through the same tool as that client
 * (`reexecuteChange`), with every check again, and this gate then marks the change as made in the effect's own transaction.
 */
export interface AskFirstTarget {
  /** The tool and its arguments exactly as the client sent them (never the re-execution's own `assistantCall`). */
  tool: string;
  args: Record<string, unknown>;
  projectId: string;
  clientCommandId: string;
  /** How the waiting change reads: "Post message …", "Take task #4 …". */
  operation: string;
  objectType: AssistantObjectType;
  objectId: string | null;
  title: string;
}
export interface AskFirstStep {
  /** After the effect, in its transaction: an Approve's change is made. Nothing to do when it did not wait. */
  done(produced: { value: unknown; postconditions?: AgentPostcondition[] }, made?: { objectId?: string | null; conversationId?: string | null }): Promise<void>;
}
const NOTHING: AskFirstStep = { async done() { /* it did not wait */ } };
export const isWaiting = (value: unknown): value is AssistantText => !!value && typeof value === 'object' && typeof (value as AssistantText).assistantText === 'string';

/** A re-execution carries its saved call as `assistantCall`; the call it repeats is the arguments without it. */
export function sentArgs<T extends Record<string, unknown>>(args: T): Omit<T, 'assistantCall'> {
  const { assistantCall: _saved, ...sent } = args as T & { assistantCall?: unknown };
  void _saved;
  return sent;
}

/** Whether this client's change must wait under its Ask me first now; read without a lock, the gate decides again under it. */
export async function asksFirst(db: DbExecutor, claims: FluxMcpClaims): Promise<boolean> {
  if (claims.run || claims.approval) return false;
  const client = await assistantChangeRows(db).connection(claims.connectionId);
  return !!client && client.mayDo === 'ask';
}

export async function askMeFirst(tx: Transaction, claims: FluxMcpClaims, target: AskFirstTarget): Promise<AssistantText | AskFirstStep> {
  // A run never has these tools (ASSISTANT_RUN_EFFECT_TOOLS); its changes go through the change executor.
  if (claims.run) return NOTHING;
  const rows = assistantChangeRows(tx as DbExecutor);
  const call: AssistantCall = { tool: target.tool, args: target.args };
  const fingerprint = assistantCallFingerprint(call);
  const approval = claims.approval;
  if (approval) {
    const prepared = await rows.lock(approval.changeId);
    if (!prepared || prepared.state !== 'waiting' || prepared.fingerprint !== fingerprint || prepared.runId !== null
      || prepared.connectionId !== claims.connectionId || prepared.ownerUserId !== claims.ownerUserId)
      throw new DomainError(409, 'ASSISTANT_CHANGE_UNAVAILABLE', 'This change is no longer waiting');
    return {
      async done(produced, made = {}) {
        // A task-discussion line records itself (its owner's delete); then nothing is left waiting here.
        const now = await rows.lock(prepared.id);
        if (!now || now.state !== 'waiting') return;
        await rows.update(prepared.id, { state: 'applied_after_wait', waitReason: null, authority: 'owner_approval', decidedBy: approval.decidedBy,
          decidedAt: new Date(), objectId: made.objectId ?? prepared.objectId, ...(made.conversationId ? { conversationId: made.conversationId } : {}),
          receipt: { value: produced.value, postconditions: produced.postconditions ?? [], authority: 'owner_approval', runId: null, engine: 'client',
            payer: 'Your own client', ownerUserId: claims.ownerUserId, agentId: prepared.agentId, assistantConnectionId: claims.connectionId,
            preparedBy: prepared.agentId, approvedBy: approval.decidedBy } as unknown as Record<string, unknown> });
      },
    };
  }
  // The owner's rights, the space's AI and the client's sign-in now, with the connection row held: nothing waits that could not be made.
  const context = await agentConnectionInTransaction(tx, claims, 'write', target.projectId);
  if (context.mayDo !== 'ask') return NOTHING;
  const stored = await rows.byConnectionCommand(claims.connectionId, target.clientCommandId);
  if (stored) {
    if (stored.fingerprint !== fingerprint) throw new DomainError(409, 'IDEMPOTENCY_CONFLICT', 'This command ID belongs to another change');
    // Made (at once, or after its Approve): the tool's own receipt answers the retry.
    if (stored.state === 'applied' || stored.state === 'applied_after_wait') return NOTHING;
    return { assistantText: stored.state === 'skipped' ? 'Your owner skipped this change' : stored.state === 'undone' ? 'Your owner undid this change'
      : stored.refusal ?? 'This change is waiting for your owner\'s OK' };
  }
  const prepared: AssistantCall = { ...call, bearer: { clientId: claims.clientId, grantReferenceId: claims.grantReferenceId } };
  if (await rows.preparedBytes(prepared) > ASSISTANT_CHANGE_LIMITS.preparedBytes)
    throw new DomainError(413, 'ASSISTANT_CHANGE_TOO_LARGE', 'This change is too large to keep for your OK');
  const source = { connectionId: claims.connectionId };
  const startsWaiting = !(await rows.waits(source));
  const id = randomUUID();
  const title = redactCall(target.title).slice(0, 200);
  await rows.insert({ id, workspaceId: context.workspaceId, projectId: target.projectId, ...source, ownerUserId: claims.ownerUserId,
    agentId: context.principal.id, clientCommandId: target.clientCommandId, fingerprint, tool: target.tool, operation: target.operation,
    objectType: target.objectType, objectId: target.objectId, objectTitle: title, state: 'waiting', waitReason: 'ask', preparedCommand: prepared,
    beforeVersion: null, otherUserId: null, toldUserId: null, createdAt: new Date() });
  // The owner is told once that the client waits for them (#1186), as for a waiting change of the executor.
  if (startsWaiting) await eventRepository(tx as DbExecutor).insert({ id: randomUUID(), kind: WAITING_CHANGE_EVENT, objectId: target.projectId,
    actorId: principalKey({ kind: 'agent', id: context.principal.id }), data: { changeId: id }, workspaceId: context.workspaceId },
  [principalKey({ kind: 'human', id: claims.ownerUserId })]);
  const ownerName = (await rows.names([claims.ownerUserId])).get(claims.ownerUserId) ?? 'your owner';
  const words = assistantChangeWords(target.operation);
  return { assistantText: `Waiting for ${ownerName}'s OK: ${words.phrase} ${words.noun}${title ? ` ${title}` : ''}.` };
}
