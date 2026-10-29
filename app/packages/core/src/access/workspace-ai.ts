import { ASSISTANT_RUN_CHANGED_EVENT, ASSISTANT_WORKING_EVENT, WORKSPACE_AI_POLICY_CHANGED_EVENT } from '@flux/contracts';
import type { SetWorkspaceAiPolicyCommand, SetWorkspaceAiPolicyResult, WorkspaceAiPolicy, WorkspaceAiSweepJob, WorkspaceAiSwept, WorkspaceRole } from '@flux/contracts';
import { recordEvent } from '../events.js';
import type { Database, Executor, Principal } from '../types.js';
import { eventPorts } from './common.js';
import { ConflictError, ForbiddenError, InvalidInputError, NotFoundError, PreconditionRequiredError, VersionConflictError } from './errors.js';
import { evaluateWorkspace, isUuid } from './policy.js';
import type { AccessPorts, WorkspaceAiSweepRows } from './repositories.js';
import { oneOf } from './validation.js';

// The workspace AI lock (F-029, #614, S2): the switch, its flip and the turn-off sweep.

const MISSING_AI_POLICY: WorkspaceAiPolicy = { state: 'blocked', version: 0, changedAt: new Date(0).toISOString(), changedBy: null, fixed: null };

/**
 * The AI policy of each workspace as its reader sees it (F-029): the state for every member, and who
 * changed it only for a reader with `workspace.read_members` (owners, admins, members; not guests or agents).
 */
export async function workspaceAiViews(db: Executor, ports: Pick<AccessPorts, 'workspaces'>,
  readers: { workspaceId: string; role: WorkspaceRole | null }[]): Promise<Map<string, WorkspaceAiPolicy>> {
  const ids = [...new Set(readers.map((reader) => reader.workspaceId))];
  if (!ids.length) return new Map();
  const rows = await ports.workspaces(db).aiPolicies(ids);
  const byId = new Map(rows.map((row) => [row.workspaceId, row]));
  const views = new Map<string, WorkspaceAiPolicy>();
  for (const { workspaceId, role } of readers) {
    const row = byId.get(workspaceId);
    if (!row) { views.set(workspaceId, MISSING_AI_POLICY); continue; }
    const named = role !== null && role !== 'guest' && row.changedBy !== null && row.changedByName !== null;
    views.set(workspaceId, { state: row.state, version: row.version, changedAt: row.changedAt.toISOString(),
      changedBy: named ? { id: row.changedBy!, name: row.changedByName! } : null, fixed: null });
  }
  return views;
}

/** The transaction-bound queue the flip sends its sweep job through, so the job commits with the flip or not at all. */
export type WorkspaceAiSweepQueue = (tx: Executor, job: WorkspaceAiSweepJob) => Promise<void>;

/**
 * Turns AI off or on for a whole workspace (owners and admins, `workspace.manage_ai`). One short transaction, the flip:
 * the policy row `FOR UPDATE` first, then the caller's membership under `lock`, the version check, the new state with the
 * next epoch and version, the sweep job (when turning off) and the event last. It touches no AI work row, so it cannot
 * deadlock with a check that holds one and waits for the policy row. Setting the current state again changes nothing.
 * The caller runs the sweep after the commit too ({@link sweepWorkspaceAi}); the job makes sure a crash cannot skip it.
 */
export async function setWorkspaceAiPolicy(principal: Principal, workspaceId: string, command: SetWorkspaceAiPolicyCommand, db: Database,
  ports: Pick<AccessPorts, 'workspaces' | 'access' | 'events' | 'encryption'>, queue: WorkspaceAiSweepQueue): Promise<SetWorkspaceAiPolicyResult & { sweep: WorkspaceAiSweepJob | null }> {
  const state = oneOf(command?.state, ['allowed', 'blocked'] as const, 'state');
  return db.transaction(async (tx) => {
    const current = isUuid(workspaceId) ? await ports.workspaces(tx).lockAiPolicy(workspaceId) : null;
    const decision = await evaluateWorkspace(principal, 'workspace.manage_ai', workspaceId, ports.access(tx), { lock: true });
    if (!decision.visible || !current) throw new NotFoundError('Workspace', 'WORKSPACE_NOT_FOUND');
    // F-030: AI is always off in an encrypted workspace, before any other check that could pass.
    if (await ports.encryption(tx).sealed(workspaceId)) throw new ConflictError('AI is always off in an encrypted workspace', 'WORKSPACE_ENCRYPTED_AI_OFF');
    if (!decision.allowed) throw new ForbiddenError('Only workspace owners and admins can turn AI on or off', 'WORKSPACE_AI_ADMIN_REQUIRED');
    const expected = command.expectedVersion;
    if (expected === undefined || expected === null) throw new PreconditionRequiredError();
    if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 1) throw new InvalidInputError('expectedVersion must be a positive integer');
    const view = async () => (await workspaceAiViews(tx, ports, [{ workspaceId, role: decision.actor.role }])).get(workspaceId)!;
    if (current.version !== expected) throw new VersionConflictError(current.version, await view());
    if (current.state === state) return { ai: await view(), changed: false, stopped: null, sweep: null };
    const updated = await ports.workspaces(tx).updateAiPolicy(workspaceId, state, principal.id);
    const sweep = state === 'blocked' ? { workspaceId, epoch: updated.epoch } : null;
    if (sweep) await queue(tx, sweep);
    await recordEvent(eventPorts(ports, tx), principal, workspaceId, WORKSPACE_AI_POLICY_CHANGED_EVENT, workspaceId, { state });
    return { ai: await view(), changed: true, stopped: null, sweep };
  });
}

/**
 * The turn-off sweep (F-029): ends or stops every AI work item of the workspace admitted under an epoch older than `epoch`,
 * whatever the policy's current state, and tells each run's owner. Idempotent; the API runs it right after the flip and the
 * worker again from the job. Nothing is deleted.
 */
export async function sweepWorkspaceAi(job: WorkspaceAiSweepJob, db: Database, ports: Pick<AccessPorts, 'aiSweep' | 'access' | 'events'>): Promise<WorkspaceAiSwept> {
  if (!isUuid(job.workspaceId) || !Number.isSafeInteger(job.epoch) || job.epoch < 1) throw new InvalidInputError('A workspace and an epoch are required');
  const { workspaceId, epoch } = job;
  // One transaction per step: a step that fails (a constraint, a lock timeout) cannot roll the others back or stall the cutover.
  const steps: [Exclude<keyof WorkspaceAiSwept, 'failed'>, (rows: WorkspaceAiSweepRows, tx: Executor) => Promise<number>][] = [
    ['runs', async (rows, tx) => {
      const ended = await rows.endQueuedRuns(workspaceId, epoch);
      const stopping = await rows.stopInFlightRuns(workspaceId, epoch);
      // The owner's progress events, as for any other end or stop request of a run (events are written last).
      for (const run of [...ended, ...stopping]) {
        await recordEvent(eventPorts(ports, tx), { kind: 'human', id: run.ownerUserId }, run.workspaceId, ASSISTANT_RUN_CHANGED_EVENT, run.id, { status: run.status });
        if (run.status === 'stopped') await recordEvent(eventPorts(ports, tx), { kind: 'agent', id: run.agentId }, run.workspaceId, ASSISTANT_WORKING_EVENT, run.projectId,
          { conversationId: run.conversationId });
      }
      return ended.length + stopping.length;
    }],
    ['tokens', (rows) => rows.closeRunTokens(workspaceId, epoch)],
    ['comparisons', (rows) => rows.endComparisons(workspaceId, epoch)],
    ['reactions', (rows) => rows.skipReactionEvents(workspaceId, epoch)],
    ['requests', (rows) => rows.cancelRequests(workspaceId, epoch)],
    ['units', (rows) => rows.stopUnits(workspaceId, epoch)],
    ['sessions', (rows) => rows.revokeSessions(workspaceId, epoch)],
  ];
  const swept: WorkspaceAiSwept = { runs: 0, tokens: 0, comparisons: 0, reactions: 0, requests: 0, units: 0, sessions: 0, failed: [] };
  const errors: unknown[] = [];
  for (const [name, step] of steps) {
    try { swept[name] = await db.transaction((tx) => step(ports.aiSweep(tx), tx)); }
    catch (error) { swept.failed.push(name); errors.push(error); }
  }
  if (errors.length) throw new WorkspaceAiSweepIncomplete(swept, errors);
  return swept;
}

/** Some sweep steps failed; the others committed. The worker's job retries the whole (idempotent) sweep. */
export class WorkspaceAiSweepIncomplete extends AggregateError {
  constructor(readonly swept: WorkspaceAiSwept, errors: unknown[]) {
    super(errors, `The AI sweep did not finish: ${swept.failed.join(', ')}`);
    this.name = 'WorkspaceAiSweepIncomplete';
  }
}
