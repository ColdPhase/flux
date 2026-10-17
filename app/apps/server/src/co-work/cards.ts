import { sql } from 'drizzle-orm';
import type { CoWorkHandoffPacket, CoWorkOriginalMessage, CoWorkPacketReference, CoWorkSourceRef, TaskCoordination,
  TaskCoordinationRequest, CancelCoWorkRequestCommand } from '@flux/contracts';
import { coworkCardRows, coworkReviewRows, referenceKey, type CoWorkCardRow, type CoWorkReferenceFact } from '@flux/db';
import { canCancelCoWorkRequest, enforce, evaluateProject, ForbiddenError, isUuid, NotFoundError, recordEvent, requireCoWorkCancel,
  type CoWorkCancelActor, type Database, type Executor, type Principal } from '@flux/core';
import { ConflictError } from '@flux/core';
import { eventPorts } from '../events.js';
import { workUseCases } from '../work/adapters.js';

// A task's request cards, handoff packet and cancellation for its people (#153 AC-2/AC-4, #400 AC-4). Whoever can read
// the task reads its cards; only a project manager or the owner of the sender or recipient agent cancels one. Nothing
// here claims, resolves, acknowledges or defers a request, and no credential, grant, lease or fingerprint is read.

const requestId = (value: string) => {
  if (!isUuid(value)) throw new NotFoundError('Request', 'COWORK_REQUEST_UNAVAILABLE');
  return value.toLowerCase();
};

/** The reader's standing now: a person who may write, and whether that includes managing the project. */
async function cancelActor(tx: Executor, principal: Principal, projectId: string): Promise<CoWorkCancelActor> {
  if (principal.kind !== 'human') return { userId: principal.id, writer: false, manager: false };
  const writer = (await evaluateProject(principal, 'project.write', projectId, tx)).allowed;
  const manager = writer && (await evaluateProject(principal, 'project.manage', projectId, tx)).allowed;
  return { userId: principal.id, writer, manager };
}

const referenceOf = (fact: CoWorkReferenceFact): CoWorkPacketReference => {
  const { ref } = fact;
  return ref.type === 'github_pr' ? { type: 'github_pr', id: null, version: null, title: null, available: false }
    : { type: ref.type, id: ref.id, version: 'version' in ref ? ref.version : null, title: fact.title, available: fact.available };
};

/** The first message a request names that the reader may open: its target, else a source. */
function originalMessage(row: CoWorkCardRow, facts: Map<string, CoWorkReferenceFact>): CoWorkOriginalMessage | null {
  for (const ref of [row.target, ...row.sourceRefs]) {
    if (ref.type !== 'message') continue;
    const fact = facts.get(referenceKey(ref));
    if (fact?.available && fact.message) return { messageId: ref.id, conversationId: fact.message.conversationId, space: fact.message.space, taskId: fact.message.taskId };
  }
  return null;
}

async function describeAll(tx: Executor, scope: { workspaceId: string; projectId: string }, refs: CoWorkSourceRef[]) {
  const unique = [...new Map(refs.map((ref) => [referenceKey(ref), ref])).values()];
  const facts = await coworkCardRows(tx).describe(scope, unique);
  return new Map(facts.map((fact) => [referenceKey(fact.ref), fact]));
}

function present(row: CoWorkCardRow, facts: Map<string, CoWorkReferenceFact>, actor: CoWorkCancelActor): TaskCoordinationRequest {
  const target = facts.get(referenceKey(row.target));
  return { id: row.id, kind: row.kind, state: row.state, version: row.version, status: row.status, reason: row.reason, nextBoundary: row.nextBoundary,
    target: row.target, targetTitle: target?.available ? target.title : null, targetAvailable: target?.available === true, responseRef: row.responseRef,
    originalMessage: originalMessage(row, facts),
    sender: { connectionId: row.senderConnectionId, name: row.senderName, ownerName: row.senderOwnerName },
    recipient: { connectionId: row.recipientConnectionId, name: row.recipientName, ownerName: row.recipientOwnerName },
    cancelledBy: row.cancelledByName ? { name: row.cancelledByName } : null,
    canCancel: canCancelCoWorkRequest(actor, { senderOwnerId: row.senderOwnerId, recipientOwnerId: row.recipientOwnerId, state: row.state, version: row.version }),
    createdAt: row.createdAt, updatedAt: row.updatedAt, expiresAt: row.expiresAt };
}

/** The task's request cards and review verdicts, for whoever can read the task. */
export async function readTaskCoordination(db: Database, principal: Principal, workId: string): Promise<TaskCoordination> {
  const task = await workUseCases(db).getWork(principal, workId);
  const scope = { workspaceId: task.workspaceId, projectId: task.projectId, taskId: task.id };
  const rows = await coworkCardRows(db).requests(scope);
  const verdicts = await coworkReviewRows(db).verdicts(task.workspaceId, task.projectId, task.id);
  const actor = await cancelActor(db, principal, task.projectId);
  const facts = await describeAll(db, scope, rows.flatMap((row) => [row.target, ...row.sourceRefs.filter((ref) => ref.type === 'message')]));
  return {
    taskId: task.id,
    requests: rows.map((row) => present(row, facts, actor)),
    verdicts: verdicts.map((row) => ({ requestId: row.requestId, verdict: row.verdict, target: row.target,
      criteriaRefs: row.criteriaRefs, evidenceRef: row.evidenceRef, current: row.current, createdAt: row.createdAt,
      reviewer: { connectionId: row.reviewerConnectionId, name: row.reviewerName },
      author: { connectionId: row.authorConnectionId, name: row.authorName } })),
  };
}

/**
 * The reference packet of one request, bounded and read for this person now: identities, titles that still exist at the
 * named versions, the recipient unit's last checkpoint and the verdict. It copies no source content and holds no
 * credential, grant, lease, fingerprint or prompt.
 */
export async function readHandoffPacket(db: Database, principal: Principal, workId: string, requested: string): Promise<CoWorkHandoffPacket> {
  const task = await workUseCases(db).getWork(principal, workId);
  const scope = { workspaceId: task.workspaceId, projectId: task.projectId, taskId: task.id };
  const [row] = await coworkCardRows(db).requests(scope, { requestId: requestId(requested) });
  if (!row) throw new NotFoundError('Request', 'COWORK_REQUEST_UNAVAILABLE');
  const refs = [row.target, ...row.sourceRefs, ...row.criteriaRefs, ...(row.responseRef ? [row.responseRef] : [])];
  const facts = await describeAll(db, scope, refs);
  const reference = (ref: CoWorkSourceRef) => referenceOf(facts.get(referenceKey(ref))!);
  const checkpoint = await coworkCardRows(db).checkpoint(scope, row.unitId);
  const [verdict] = await coworkReviewRows(db).verdicts(task.workspaceId, task.projectId, task.id, { requestId: row.id });
  return {
    schema: 'flux.cowork.packet/1', generatedAt: new Date().toISOString(),
    request: { id: row.id, kind: row.kind, state: row.state, status: row.status, reason: row.reason, nextBoundary: row.nextBoundary,
      priority: row.priority, peerUnblocking: row.peerUnblocking, createdAt: row.createdAt, expiresAt: row.expiresAt,
      sender: { name: row.senderName, ownerName: row.senderOwnerName }, recipient: { name: row.recipientName, ownerName: row.recipientOwnerName } },
    task: { id: task.id, number: task.number, title: task.title, status: task.status, version: task.version },
    target: reference(row.target), sources: row.sourceRefs.map(reference), criteria: row.criteriaRefs.map(reference),
    response: row.responseRef ? reference(row.responseRef) : null,
    originalMessage: originalMessage(row, facts),
    checkpoint,
    verdict: verdict ? { verdict: verdict.verdict, current: verdict.current, createdAt: verdict.createdAt } : null,
  };
}

/**
 * Cancels an open request at the version this person saw. The request row is locked and re-read, so a cancel and a
 * concurrent claim, deferral, response or supersession serialize on it: whichever commits first wins, and the other is
 * told the committed state. A repeated cancel succeeds without a change. Writing in the project is required, so a viewer or
 * a person whose access was just removed is refused before the request's state is revealed.
 */
export async function cancelCoWorkRequest(db: Database, principal: Principal, workId: string, requested: string,
  command: CancelCoWorkRequestCommand): Promise<TaskCoordinationRequest> {
  const id = requestId(requested);
  if (!isUuid(workId)) throw new NotFoundError('Work item', 'WORK_NOT_FOUND');
  if (principal.kind !== 'human') throw new ForbiddenError('Only a person can cancel a request', 'COWORK_CANCEL_NEEDS_PERSON');
  return db.transaction(async (tx) => {
    const located = (await tx.execute<{ workspace_id: string; project_id: string }>(sql`
      SELECT workspace_id, project_id FROM project_work_items WHERE id = ${workId.toLowerCase()}::uuid`)).rows[0];
    if (!located) throw new NotFoundError('Work item', 'WORK_NOT_FOUND');
    const projectId = located.project_id, workspaceId = located.workspace_id;
    // The same 404 for an unknown task and for one the person cannot read; 403 for a viewer. Access rows are locked against
    // a concurrent removal.
    const access = await evaluateProject(principal, 'project.write', projectId, tx, { lock: true });
    if (!access.visible) throw new NotFoundError('Work item', 'WORK_NOT_FOUND');
    enforce(access, 'project');
    const actor = await cancelActor(tx, principal, projectId);
    const scope = { workspaceId, projectId, taskId: workId.toLowerCase() };
    const rows = coworkCardRows(tx);
    if (!await rows.lockRequest(scope, id)) throw new NotFoundError('Request', 'COWORK_REQUEST_UNAVAILABLE');
    const [current] = await rows.requests(scope, { requestId: id });
    if (!current) throw new NotFoundError('Request', 'COWORK_REQUEST_UNAVAILABLE');
    const decision = requireCoWorkCancel(actor, { senderOwnerId: current.senderOwnerId, recipientOwnerId: current.recipientOwnerId,
      state: current.state, version: current.version }, command.expectedVersion);
    if (decision === 'cancel') {
      if (!await rows.cancel(scope, id, command.expectedVersion, principal.id))
        throw new ConflictError('The request changed; read it again', 'COWORK_VERSION_CONFLICT');
      await recordEvent(eventPorts(tx), principal, workspaceId, 'project.cowork_request_cancelled.v1', projectId, { requestId: id, taskId: scope.taskId });
    }
    const [stored] = await rows.requests(scope, { requestId: id });
    const facts = await describeAll(tx, scope, [stored!.target, ...stored!.sourceRefs.filter((ref) => ref.type === 'message')]);
    return present(stored!, facts, actor);
  });
}
