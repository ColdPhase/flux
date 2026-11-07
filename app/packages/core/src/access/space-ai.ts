import { ASSISTANT_RUN_CHANGED_EVENT, ASSISTANT_WORKING_EVENT, SPACE_AI_POLICY_CHANGED_EVENT } from '@flux/contracts';
import type { SetSpaceAiCommand, SetSpaceAiResult, SpaceAiState, SpaceAiSweepJob, SpaceAiSwept } from '@flux/contracts';
import { recordEvent } from '../events.js';
import type { Database, Executor, Principal } from '../types.js';
import { eventPorts } from './common.js';
import { ConflictError, ForbiddenError, InvalidInputError, NotFoundError } from './errors.js';
import { evaluateProject, isUuid } from './policy.js';
import type { AccessPorts, SpaceAiSweepRows } from './repositories.js';
import { oneOf } from './validation.js';

// The AI switch of a space (F-037, #874, AG-10; it replaces the workspace AI lock of F-029): its flip and the turn-off sweep.
// Each space has its own switch, on by default. A space admin controls it, and the company's owners and admins can change it
// in any space (they are managers of every space). There is no global switch.

/** The AI switch of each space as its list shows it. A missing row reads as off (fail closed). */
export async function spaceAiStates(db: Executor, ports: Pick<AccessPorts, 'projects'>, projectIds: string[]): Promise<Map<string, SpaceAiState>> {
  const ids = [...new Set(projectIds)];
  const rows = await ports.projects(db).aiPolicies(ids);
  const byId = new Map(rows.map((row) => [row.projectId, row.state]));
  return new Map(ids.map((id) => [id, byId.get(id) ?? 'blocked']));
}

/** The transaction-bound queue the flip sends its sweep job through, so the job commits with the flip or not at all. */
export type SpaceAiSweepQueue = (tx: Executor, job: SpaceAiSweepJob) => Promise<void>;

/**
 * Turns AI off or on in one space (its admins and the company's owners and admins, `project.manage`). One short transaction, the
 * flip: the policy row `FOR UPDATE` first, then the caller's membership and grants under `lock`, the new state with the next
 * epoch, the sweep job (when turning off) and the event last. It touches no AI work row, so it cannot deadlock with a check that
 * holds one and waits for the policy row. Setting the current state again changes nothing. The caller runs the sweep after the
 * commit too ({@link sweepSpaceAi}); the job makes sure a crash cannot skip it.
 */
export async function setSpaceAi(principal: Principal, projectId: string, command: SetSpaceAiCommand, db: Database,
  ports: Pick<AccessPorts, 'projects' | 'access' | 'events' | 'encryption'>, queue: SpaceAiSweepQueue): Promise<SetSpaceAiResult & { sweep: SpaceAiSweepJob | null }> {
  const state = oneOf(command?.state, ['allowed', 'blocked'] as const, 'state');
  return db.transaction(async (tx) => {
    const projects = ports.projects(tx);
    const current = isUuid(projectId) ? await projects.lockAiPolicy(projectId) : null;
    const decision = await evaluateProject(principal, 'project.manage', projectId, ports.access(tx), { lock: true });
    if (!decision.visible || !current) throw new NotFoundError('Space', 'PROJECT_NOT_FOUND');
    const workspaceId = decision.project!.workspaceId;
    // F-030: AI is always off in an encrypted space, before any other check that could pass.
    if (await ports.encryption(tx).sealed(workspaceId)) throw new ConflictError('AI is always off in an encrypted space', 'WORKSPACE_ENCRYPTED_AI_OFF');
    if (!decision.allowed || principal.kind !== 'human') throw new ForbiddenError('Only a space admin or a company admin can turn AI on or off here', 'SPACE_AI_ADMIN_REQUIRED');
    if (current.state === state) return { ai: state, changed: false, stopped: null, sweep: null };
    const updated = await projects.updateAiPolicy(projectId, state, principal.id);
    const sweep = state === 'blocked' ? { projectId, epoch: updated.epoch } : null;
    if (sweep) await queue(tx, sweep);
    await recordEvent(eventPorts(ports, tx), principal, workspaceId, SPACE_AI_POLICY_CHANGED_EVENT, projectId, { state });
    return { ai: state, changed: true, stopped: null, sweep };
  });
}

/**
 * The turn-off sweep (AG-10): ends or stops every AI work item of the space admitted under an epoch older than `epoch`,
 * whatever the switch's current state, and tells each run's owner. A run in progress is asked to stop at once, and its next
 * check (it holds the policy row `FOR SHARE` at its admission epoch) refuses, so it writes nothing more; what it had already
 * written stays. Idempotent; the API runs it right after the flip and the worker again from the job. Nothing is deleted.
 */
export async function sweepSpaceAi(job: SpaceAiSweepJob, db: Database, ports: Pick<AccessPorts, 'aiSweep' | 'access' | 'events'>): Promise<SpaceAiSwept> {
  if (!isUuid(job.projectId) || !Number.isSafeInteger(job.epoch) || job.epoch < 1) throw new InvalidInputError('A space and an epoch are required');
  const { projectId, epoch } = job;
  // One transaction per step: a step that fails (a constraint, a lock timeout) cannot roll the others back or stall the cutover.
  const steps: [Exclude<keyof SpaceAiSwept, 'failed'>, (rows: SpaceAiSweepRows, tx: Executor) => Promise<number>][] = [
    ['runs', async (rows, tx) => {
      const ended = await rows.endQueuedRuns(projectId, epoch);
      const stopping = await rows.stopInFlightRuns(projectId, epoch);
      // The owner's progress events, as for any other end or stop request of a run (events are written last).
      for (const run of [...ended, ...stopping]) {
        await recordEvent(eventPorts(ports, tx), { kind: 'human', id: run.ownerUserId }, run.workspaceId, ASSISTANT_RUN_CHANGED_EVENT, run.id, { status: run.status });
        if (run.status === 'stopped') await recordEvent(eventPorts(ports, tx), { kind: 'agent', id: run.agentId }, run.workspaceId, ASSISTANT_WORKING_EVENT, run.projectId,
          { conversationId: run.conversationId });
      }
      return ended.length + stopping.length;
    }],
    ['tokens', (rows) => rows.closeRunTokens(projectId, epoch)],
    ['comparisons', (rows) => rows.endComparisons(projectId, epoch)],
    ['reactions', (rows) => rows.skipReactionEvents(projectId, epoch)],
    ['requests', (rows) => rows.cancelRequests(projectId, epoch)],
    ['units', (rows) => rows.stopUnits(projectId, epoch)],
  ];
  const swept: SpaceAiSwept = { runs: 0, tokens: 0, comparisons: 0, reactions: 0, requests: 0, units: 0, failed: [] };
  const errors: unknown[] = [];
  for (const [name, step] of steps) {
    try { swept[name] = await db.transaction((tx) => step(ports.aiSweep(tx), tx)); }
    catch (error) { swept.failed.push(name); errors.push(error); }
  }
  if (errors.length) throw new SpaceAiSweepIncomplete(swept, errors);
  return swept;
}

/** Some sweep steps failed; the others committed. The worker's job retries the whole (idempotent) sweep. */
export class SpaceAiSweepIncomplete extends AggregateError {
  constructor(readonly swept: SpaceAiSwept, errors: unknown[]) {
    super(errors, `The AI sweep did not finish: ${swept.failed.join(', ')}`);
    this.name = 'SpaceAiSweepIncomplete';
  }
}
