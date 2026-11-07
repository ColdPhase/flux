import { agentTaskRows, personalRunRows, workRows, type Database, type Transaction } from '@flux/db';
import { createPersonalRunUseCases, noPersonalConnections, TAKEN_WORDS, taskRunClientId, taskRunPrompt, uuidFrom, type Principal, type TaskStart, type WorkRecord } from '@flux/core';
import { personalRunPorts, type PersonalRunComposition, type PersonalRunQueueFactory } from '../personal-runs/adapters.js';
import { taskDiscussionUseCases } from '../work/task-discussions.js';
import { workUseCases } from '../work/adapters.js';

// The server's side of people's agents taking tasks (#856, F-036 AG-5). `agent_task_events` holds what happened in the
// transaction that caused it; this drains it as soon as the API is told (NOTIFY), so a task is taken within seconds and
// nothing is polled while idle:
//   `assigned`  a task was given to an agent, or to a person who chose an agent. In the second case the person's setting
//               gives it to that agent (an owner change on their behalf); in the first the agent says it is on it and its run
//               is queued. The run is the same run as any other of the agent.
//   `finished`  a run on a task ended. The agent's report goes into the task's discussion, and the task follows the agent's
//               "What it may do": Done with "Do it and tell me", back with its owner to check otherwise (C-1). A task Stopped
//               or left because AI went off goes back to its owner; a run that failed keeps its task, with Try again.
// Every step is checked again as the person or agent it acts for: nothing here bypasses the work use cases.

const human = (id: string): Principal => ({ kind: 'human', id });
const agent = (id: string): Principal => ({ kind: 'agent', id });
const FINISHED = new Set(['done', 'not_pursued']);

type Event = NonNullable<Awaited<ReturnType<ReturnType<typeof agentTaskRows>['claimNext']>>>;
export interface AgentTaskDrain {
  /** Handles every event waiting; a call while one is running makes it look again before it stops. */
  drain(): Promise<void>;
}

export function createAgentTaskDrain(db: Database, queue: PersonalRunQueueFactory, composition: Omit<PersonalRunComposition, 'queue'>,
  log: { warn(object: unknown, message: string): void } = { warn: () => undefined }): AgentTaskDrain {

  /** A step that may be refused (the task changed, the person lost access): it is logged and the event is still done. */
  async function attempt<T>(what: string, step: () => Promise<T>): Promise<T | null> {
    try { return await step(); } catch (error) { log.warn({ error, what }, 'An agent task step was refused'); return null; }
  }

  async function say(tx: Transaction, work: WorkRecord, as: string, body: string, key: string) {
    await attempt('say', () => taskDiscussionUseCases(tx as unknown as Database).contribute(agent(as), work.id, { body, clientMessageId: uuidFrom(`agent-task:${key}`) }));
  }

  /** The owner's answer about whom a task goes back to: the person who owns the agent. */
  async function giveBack(tx: Transaction, work: WorkRecord, ownerId: string, by: string) {
    const current = (await workRows(tx).findWork(work.id, { lock: true }))!;
    if (current.owner?.kind !== 'agent') return;
    await attempt('give back', () => workUseCases(tx as unknown as Database).updateWork(human(by), work.id, { owner: { kind: 'human', id: ownerId } }, current.version, 'agent_rule'));
  }

  async function assigned(tx: Transaction, event: Event) {
    const rows = agentTaskRows(tx);
    const work = await workRows(tx).findWork(event.workId, { lock: true });
    if (!work || FINISHED.has(work.status) || work.parked) return;
    if (event.ownerUserId) {
      // A person was given the task and chose an agent: their setting gives it to that agent, as them.
      if (work.owner?.kind !== 'human' || work.owner.id !== event.ownerUserId) return;
      const agentId = await rows.taking(event.ownerUserId);
      if (!agentId || !(await rows.isOwnServerAgent(event.ownerUserId, agentId))) return;
      await attempt('give', () => workUseCases(tx as unknown as Database).updateWork(human(event.ownerUserId!), work.id,
        { owner: { kind: 'agent', id: agentId } }, work.version, 'agent_rule'));
      return;
    }
    if (!event.ownerAgentId || work.owner?.kind !== 'agent' || work.owner.id !== event.ownerAgentId) return;
    const holder = await rows.agent(event.ownerAgentId);
    if (!holder?.ownerUserId || holder.revokedAt) return;
    const ownerId = holder.ownerUserId;
    // One run at a time per task: a run still working (a duplicate event, a second click) is the one that counts.
    const [latest] = await rows.runsOfWork(work.id, 1);
    if (latest && ['queued', 'reading', 'dispatching'].includes(latest.status)) return;
    if (!(await rows.isOwnServerAgent(ownerId, holder.id))) {
      await giveBack(tx, work, ownerId, ownerId);
      return;
    }
    const ports = personalRunPorts(tx, queue);
    const runs = createPersonalRunUseCases({ uow: { run: (job) => job(ports) }, connections: composition.connections ?? noPersonalConnections,
      providerEnabled: composition.providerEnabled ?? false, ...(composition.runtime ? { runtime: composition.runtime } : {}) });
    // The agent says it is on it first: that is what opens the task's discussion, where its run is anchored. No model is called for it.
    await say(tx, work, holder.id, TAKEN_WORDS, `taken:${event.id}`);
    const place = await taskDiscussionUseCases(tx as unknown as Database).getDiscussionRoot(human(ownerId), work.id).catch(() => null);
    const started: TaskStart = place
      ? await runs.startTask(ports, { ownerUserId: ownerId, agentId: holder.id, workId: work.id, projectId: work.projectId, conversationId: place.conversationId,
        prompt: taskRunPrompt(work), clientRunId: taskRunClientId(event.id) })
      : { started: false, line: 'I can\'t start: this task has no discussion yet.' };
    if (!started.started) {
      await say(tx, work, holder.id, started.line, `refused:${event.id}`);
      await giveBack(tx, work, ownerId, ownerId);
      return;
    }
    // It is Doing from the moment the agent takes it (AgentStates 2).
    if (work.status === 'open') {
      const current = (await workRows(tx).findWork(work.id, { lock: true }))!;
      await attempt('doing', () => workUseCases(tx as unknown as Database).updateWork(agent(holder.id), work.id, { status: 'in_progress' }, current.version));
    }
  }

  async function finished(tx: Transaction, event: Event) {
    const rows = agentTaskRows(tx);
    const run = event.runId ? await personalRunRows(tx).findRun(event.runId, { lock: true }) : null;
    if (!run || run.kind !== 'task' || !run.workId) return;
    const work = await workRows(tx).findWork(run.workId, { lock: true });
    if (!work || FINISHED.has(work.status)) return;
    // The task is still the agent's. If its owner took it back or gave it away meanwhile, there is nothing to finish.
    const holds = work.owner?.kind === 'agent' && work.owner.id === run.agentId;
    const ended = run.status;
    if (ended === 'completed' || ended === 'truncated') {
      if (!holds) return;
      await say(tx, work, run.agentId, run.answerBody ?? '(No answer text.)', `report:${run.id}`);
      const mayDo = await personalRunRows(tx).assistantMayDo(run.ownerUserId, run.workspaceId);
      const current = (await workRows(tx).findWork(work.id, { lock: true }))!;
      // With "Do it and tell me" it marks the task Done; with "Ask me first" or "Only read" it hands it back to check (C-1).
      if (mayDo === 'act') await attempt('done', () => workUseCases(tx as unknown as Database).updateWork(agent(run.agentId), work.id, { status: 'done' }, current.version));
      else await giveBack(tx, work, run.ownerUserId, run.ownerUserId);
      return;
    }
    if (ended === 'stopped') {
      if (!holds) return;
      const by = run.stopRequestedBy ? await rows.personName(run.stopRequestedBy) : null;
      const words = run.endReason === 'ai_off' ? 'AI was turned off in this space, so I stopped.' : `Stopped${by ? ` by ${by}` : ''}.`;
      await say(tx, work, run.agentId, words, `stopped:${run.id}`);
      await giveBack(tx, work, run.ownerUserId, run.stopRequestedBy ?? run.ownerUserId);
      return;
    }
    // The provider's limit paused it: its continuation is queued and starts by itself.
    if (run.endReason === 'plan_limit' && await rows.successor(run.id)) return;
    if (!holds) return;
    if (ended === 'paused' || ended === 'revoked' || ended === 'denied') {
      await say(tx, work, run.agentId, ended === 'paused' ? 'I can\'t work on this: your agent is paused.' : 'I can\'t work on this: I\'m no longer allowed here.', `ended:${run.id}`);
      await giveBack(tx, work, run.ownerUserId, run.ownerUserId);
      return;
    }
    // A run that failed keeps the task with the agent: its owner chooses Try again or Take it back.
    await say(tx, work, run.agentId, 'I couldn\'t finish this.', `failed:${run.id}`);
  }

  let draining = false;
  let again = false;
  async function handleOne(): Promise<boolean> {
    let claimed: string | null = null;
    try {
      return await db.transaction(async (tx) => {
        const rows = agentTaskRows(tx);
        const event = await rows.claimNext();
        if (!event) return false;
        claimed = event.id;
        if (event.kind === 'assigned') await assigned(tx, event); else await finished(tx, event);
        await rows.markHandled(event.id);
        return true;
      });
    } catch (error) {
      log.warn({ error, event: claimed }, 'An agent task event failed and will be tried again');
      if (claimed) await agentTaskRows(db).failed(claimed).catch(() => undefined);
      return claimed !== null;
    }
  }

  return {
    async drain() {
      if (draining) { again = true; return; }
      draining = true;
      try {
        do {
          again = false;
          while (await handleOne()) { /* each event is its own transaction */ }
        } while (again);
        await agentTaskRows(db).prune().catch(() => undefined);
      } finally { draining = false; }
    },
  };
}

