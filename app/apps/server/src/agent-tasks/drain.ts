import { createHash, randomUUID } from 'node:crypto';
import { AGENT_TASK_EVENT_ATTEMPTS, AGENT_TASK_GIVE_UP_ATTEMPTS, agentTaskRows, assistantChangeRows, assistantRemovalRows, personalRunRows, personalRunWebReadRows, workRows, type Database, type DbExecutor, type Transaction } from '@flux/db';
import { agentLabel, answerLines, askableLines, createPersonalRunUseCases, DomainError, MAX_EXCHANGE_TURNS, noPersonalConnections, reportTaskRun, resolveAsked, stopRunBy, TAKEN_WORDS, takeAsk, taskRunClientId, webSourcesLine,
  taskRunPrompt, uuidFrom, type AgentQuestion, type Askable, type Principal, type TaskStart, type UndoRecord, type WorkRecord } from '@flux/core';
import { personalRunPorts, type PersonalRunComposition, type PersonalRunQueueFactory } from '../personal-runs/adapters.js';
import { taskDiscussionUseCases } from '../work/task-discussions.js';
import { workUseCases } from '../work/adapters.js';
import { policyWorkAccess } from '../work/access.js';

// The server's side of people's agents taking tasks (#856, F-036 AG-5). `agent_task_events` holds what happened in the
// transaction that caused it; this drains it as soon as the API is told (NOTIFY), so a task is taken within seconds and
// nothing is polled while idle:
//   `assigned`  a task was given to an agent, or to a person who chose an agent. In the second case the person's setting
//               gives it to that agent (an owner change on their behalf); in the first the agent says it is on it and its run
//               is queued. The run is the same run as any other of the agent.
//   `started`   the agent's run began working: the task is Doing from then, not while it waits for room (AgentStates 1).
//   `released`  someone took the task away from an agent that was working on it: its run stops.
//   `finished`  a run on a task ended. The agent's report goes into the task's discussion, and the task follows the agent's
//               "What it may do": Done with "Do it and tell me", back with its owner to check otherwise (C-1). A task Stopped
//               or left because AI went off goes back to its owner; a run that failed keeps its task, with Try again.
// Every step is checked again as the person or agent it acts for: nothing here bypasses the work use cases.
//
// An event is one transaction. A rule's refusal (a `DomainError`: the task changed, a person lost access, AI is off) ends that step and
// the event is still done; anything else (a deadlock, a lost connection) rolls the whole event back and it is tried again, a little
// later each time (1, 4, 9, 16 seconds). An event that failed five times is not tried again and not left silent: the next claim of it
// is `giveUp`, in the same transaction that ends it, so the task's owner is told in the task. If that fails too the event stays and
// the give-up is tried again later; it is never dropped.
//
// Locks, in the one order the worker and the work and run use cases already take them: the per-owner lock (`lockAssistantOwner`,
// which `enablement(..., { lock })` takes first) of the people whose agents may start a run (ascending), then the space's task-graph
// lock, then the task and run rows. The worker checks the
// owner's setup before it fences the task (processor.ts `recheck`, then `prepareTaskUse`), a person's own request does the same
// (service.ts `start`), and task-targets.ts records it ("authority fences, then graphs, then tasks"). An event that took the graph
// first would wait for a row the worker holds while the worker waits for the graph: a deadlock, the loser's dispatch lost.

const human = (id: string): Principal => ({ kind: 'human', id });
const agent = (id: string): Principal => ({ kind: 'agent', id });
const FINISHED = new Set(['done']);
const IN_FLIGHT = ['queued', 'reading', 'dispatching'];
/** The person's own line when "Give it to" could not give them the task because the agent they named has no access to this space. */
const notTakenWords = (agentName: string) => `My agent ${agentName} can't work in this space, so it hasn't taken this task. It's still with me.`;

type Event = NonNullable<Awaited<ReturnType<ReturnType<typeof agentTaskRows>['claimNext']>>>;
type RunRow = NonNullable<Awaited<ReturnType<ReturnType<typeof personalRunRows>['findRun']>>>;
export interface AgentTaskDrain {
  /** Handles every event waiting; a call while one is running makes it look again before it stops. */
  drain(): Promise<void>;
}

/** The step was refused by the start itself, and the savepoint holding the agent's first words is rolled back with it. */
class Refused extends Error { constructor(readonly line: string) { super(line); } }

export function createAgentTaskDrain(db: Database, queue: PersonalRunQueueFactory, composition: Omit<PersonalRunComposition, 'queue'>,
  log: { warn(object: unknown, message: string): void; error?(object: unknown, message: string): void } = { warn: () => undefined }): AgentTaskDrain {

  /** A step a rule may refuse is logged and left; any other failure is not swallowed: it rolls the event back, to be tried again. */
  async function attempt<T>(what: string, step: () => Promise<T>): Promise<T | null> {
    try { return await step(); } catch (error) {
      if (error instanceof DomainError) { log.warn({ error, what }, 'An agent task step was refused'); return null; }
      throw error;
    }
  }

  /**
   * An agent's line in the task's discussion. A line that is the content of a run (its report, its question, its answer) is also that
   * run's change, so its owner can delete it at any time, whoever answered it since (TA-3, #923, #938); a status line is not.
   * Flux writes these lines for the agent (`byFlux`): they are bounded by the run and by TA-3's exchange limit, so the five-in-a-row
   * limit of the discussion never refuses one and does not count it (C-51). A report after five agent messages is still posted.
   */
  async function say(tx: Transaction, work: WorkRecord, as: string, body: string, key: string, madeBy?: RunRow) {
    const message = await attempt('say', () => taskDiscussionUseCases(tx as unknown as Database).contribute(agent(as), work.id,
      { body, clientMessageId: uuidFrom(`agent-task:${key}`) }, { byFlux: true }));
    if (message && madeBy) await recordPost(tx, madeBy, message, key);
  }

  /** The message as the run's applied change (`conversation.reply`): the owner's delete turns it into a marker that keeps its place. */
  async function recordPost(tx: Transaction, run: RunRow, message: { id: string; body: string }, key: string) {
    const rows = assistantChangeRows(tx as unknown as DbExecutor);
    const clientCommandId = uuidFrom(`agent-task:change:${key}`);
    if (await rows.byCommand(run.id, clientCommandId)) return;
    if (!(await assistantRemovalRows(tx as unknown as DbExecutor).messageIsUndoable(message.id, run.agentId))) return;
    const title = message.body.replace(/\s+/g, ' ').trim().slice(0, 80);
    // `thread`: a line of the task's thread, deleted by its owner with no condition. The plan keeps no excerpt of the line: once it is
    // deleted nothing of its text should be left (`after` is cleared with it).
    const undo: UndoRecord = { plan: { kind: 'removal', thread: true }, before: null, after: title || null };
    await rows.insert({ id: randomUUID(), workspaceId: run.workspaceId, projectId: run.projectId!, runId: run.id, ownerUserId: run.ownerUserId, agentId: run.agentId,
      clientCommandId, fingerprint: createHash('sha256').update(`agent-task:change:${key}`).digest('hex'), tool: 'flux_task_post', operation: 'conversation.reply',
      objectType: 'message', objectId: message.id, objectTitle: title, state: 'applied', authority: 'owner_request', preparedCommand: { tool: 'flux_task_post', args: {} },
      receipt: { undo, runId: run.id, ownerUserId: run.ownerUserId, agentId: run.agentId }, createdAt: new Date() });
  }

  /**
   * The task goes back to the person who owns the agent. `by` is who changes it; `asAgent` names the agent that hands it back for
   * review, which tells its owner (an Inbox item and a notification, AG-7), and falls back to the person if the agent cannot write.
   */
  async function giveBack(tx: Transaction, work: WorkRecord, ownerId: string, by: string, asAgent?: string) {
    const current = (await workRows(tx).findWork(work.id, { lock: true }))!;
    if (current.owner?.kind !== 'agent') return;
    const give = (principal: Principal) => attempt('give back', () => workUseCases(tx as unknown as Database).updateWork(principal, work.id,
      { owner: { kind: 'human', id: ownerId } }, current.version, 'agent_rule'));
    if (asAgent && await give(agent(asAgent))) return;
    await give(human(by));
  }

  /** The task's people changed between reading them and the graph lock: the event starts over, counted as no failure. */
  class Relock extends Error { constructor() { super('The task\'s people changed'); } }

  /**
   * The locks of an event, in the one order (see the top of this file): what names the owners is read without a lock, their
   * per-owner locks are taken (ascending), and only then the task graph. Returns false when the task is gone.
   */
  async function lockInOrder(tx: Transaction, event: Event): Promise<boolean> {
    const rows = agentTaskRows(tx);
    const work = await workRows(tx).findWork(event.workId);
    if (!work) return false;
    const owners = new Set<string>();
    if (event.kind === 'assigned' && event.ownerAgentId) {
      const holder = await rows.agent(event.ownerAgentId);
      if (holder?.ownerUserId) owners.add(holder.ownerUserId);
    }
    let people = false;
    if (event.kind === 'finished' && event.runId) {
      // A run that asked a question, or answers one, starts the other agent's run: the owners of both are locked now, in order.
      const run = await personalRunRows(tx).findRun(event.runId);
      if (run && (run.kind === 'task_answer' || run.answerBody?.includes('<ask>'))) {
        people = true;
        owners.add(run.ownerUserId);
        for (const person of await rows.taskPeople(event.workId)) owners.add(person);
        const asked = run.askedByRunId ? await personalRunRows(tx).findRun(run.askedByRunId) : null;
        if (asked) owners.add(asked.ownerUserId);
      }
    }
    for (const owner of [...owners].sort()) await personalRunRows(tx).lockOwner(owner);
    await workRows(tx).lockTaskGraphs([work.projectId]);
    // Everything that writes in the task's thread takes the graph lock, so its people cannot change from here. Someone who wrote
    // between the first read and the lock has no row locked yet: starting over reads them first, and the order stays one.
    if (people && (await rows.taskPeople(event.workId)).some((person) => !owners.has(person))) throw new Relock();
    return true;
  }

  /**
   * An event that failed every time must not leave the task silent: its owner reads that in the task and has the task back, in the
   * transaction that ends the event. A `released` event that gave up leaves the owner as the person made it; only its run, which
   * would go on spending and report to a task that is no longer its own, is stopped, whether or not the agent holds the task again.
   */
  async function giveUp(tx: Transaction, event: Event) {
    const rows = agentTaskRows(tx);
    const work = await workRows(tx).findWork(event.workId);
    if (!work) return;
    await workRows(tx).lockTaskGraphs([work.projectId]);
    const run = event.runId ? await personalRunRows(tx).findRun(event.runId) : null;
    const agentId = event.ownerAgentId ?? run?.agentId ?? (event.ownerUserId ? await rows.taking(event.ownerUserId) : null);
    const holder = agentId ? await rows.agent(agentId) : null;
    if (!holder?.ownerUserId) return;
    const ports = personalRunPorts(tx, queue);
    // A person's Stop names them; the system giving up is recorded for the owner and is not reported to the chat as a stop by them.
    const stopRuns = async (ofAgent: string, by: string, before?: Date, system = false) => {
      for (const going of await rows.runsOfWork(work.id, 8))
        if (going.agentId === ofAgent && IN_FLIGHT.includes(going.status) && (!before || going.createdAt <= before)) await stopRunBy(ports, going.id, by, { system });
    };
    if (run?.kind === 'task_answer') {
      // The answering agent's run ended and its answer could not be handled: the agent that asked still holds the task and waits for it,
      // with no run and no line. It says so and the task goes back to its owner.
      const asked = run.askedByRunId ? await personalRunRows(tx).findRun(run.askedByRunId) : null;
      const asker = asked ? await rows.agent(asked.agentId) : null;
      if (!asker?.ownerUserId || FINISHED.has(work.status)) return;
      const current = (await workRows(tx).findWork(work.id, { lock: true }))!;
      if (current.owner?.kind !== 'agent' || current.owner.id !== asker.id) return;
      await say(tx, current, asker.id, 'I couldn\'t get an answer. It\'s back with you.', `gave-up:${event.id}`);
      await giveBack(tx, current, asker.ownerUserId, asker.ownerUserId);
      await stopRuns(asker.id, asker.ownerUserId, undefined, true);
      return;
    }
    if (event.kind === 'released') {
      // Only the runs that were going when the task was taken away: a run started since is a later assignment's.
      await stopRuns(holder.id, event.byKind === 'human' && event.byId ? event.byId : holder.ownerUserId, event.createdAt, !(event.byKind === 'human' && event.byId));
      return;
    }
    if (FINISHED.has(work.status)) return;
    const current = (await workRows(tx).findWork(work.id, { lock: true }))!;
    const held = current.owner?.kind === 'agent' && current.owner.id === holder.id;
    if (held) {
      await say(tx, current, holder.id, 'I couldn\'t take care of this. It\'s back with you.', `gave-up:${event.id}`);
      await giveBack(tx, current, holder.ownerUserId, holder.ownerUserId);
      // A rule's hand-back writes no `released` event, so the run is stopped here.
      await stopRuns(holder.id, holder.ownerUserId, undefined, true);
    } else if (event.kind === 'assigned' && event.ownerUserId && current.owner?.kind === 'human' && current.owner.id === holder.ownerUserId) {
      // The person chose this agent and the setting could not give it: the task is as it was, and they are told.
      await say(tx, current, holder.id, 'I couldn\'t take this. It\'s still with you.', `gave-up:${event.id}`);
    }
  }

  /**
   * The agents of the task's people that an agent may ask (TA-3): both owners are among the task's people, and the asker's own owner
   * is one of them, so their other agents are asked too; an agent never asks itself. Only an agent that
   * can read the space is offered (`found`): the agent of a company owner or admin who wrote in the task without being added to the
   * space has no level there (C-15), and its answer run would be refused (#955). Those agents are kept apart (`outside`), so a question
   * to one is answered with the true reason and not "they are not in this task": their owner is.
   */
  async function askable(tx: Transaction, work: { id: string; projectId: string }, askerAgentId: string): Promise<{ found: Askable[]; outside: Askable[] }> {
    const rows = agentTaskRows(tx);
    const access = policyWorkAccess(tx);
    const found: Askable[] = [];
    const outside: Askable[] = [];
    for (const person of await rows.taskPeople(work.id)) {
      const ownerName = (await rows.personName(person)) ?? 'Former member';
      for (const other of (await rows.ownServerAgents(person)).filter((candidate) => candidate.id !== askerAgentId))
        (await access.canRead({ kind: 'agent', id: other.id }, work.projectId) ? found : outside).push({ id: other.id, name: other.name, ownerId: person, ownerName });
    }
    // Always in the same order, so a line that names two agents reads the same each time.
    const ordered = (list: Askable[]) => list.sort((a, b) => a.ownerName.localeCompare(b.ownerName) || a.name.localeCompare(b.name));
    return { found: ordered(found), outside: ordered(outside) };
  }

  async function assigned(tx: Transaction, event: Event) {
    const rows = agentTaskRows(tx);
    const work = await workRows(tx).findWork(event.workId, { lock: true });
    if (!work || FINISHED.has(work.status)) return;
    if (event.ownerUserId) {
      // A person was given the task and chose an agent: their setting gives it to that agent, as them.
      if (work.owner?.kind !== 'human' || work.owner.id !== event.ownerUserId) return;
      const agentId = await rows.taking(event.ownerUserId);
      if (!agentId || !(await rows.isOwnServerAgent(event.ownerUserId, agentId))) return;
      try {
        await workUseCases(tx as unknown as Database).updateWork(human(event.ownerUserId), work.id, { owner: { kind: 'agent', id: agentId } }, work.version, 'agent_rule');
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        log.warn({ error, what: 'give' }, 'An agent task step was refused');
        // The agent of a company owner or admin who was not added to this space has no access here (C-15), so it cannot speak: the
        // line is the person's own. The task stays with them, and now they know why it was not taken (#955).
        // Once for the task and the agent: giving the task to the person again, and again, is the same refusal and the same line.
        if (error.code === 'OWNER_WITHOUT_ACCESS') {
          const named = await rows.agent(agentId);
          await attempt('say', () => taskDiscussionUseCases(tx as unknown as Database).contribute(human(event.ownerUserId!), work.id,
            { body: notTakenWords(named?.name ?? 'Assistant'), clientMessageId: uuidFrom(`agent-task:not-taken:${work.id}:${agentId}`) }));
        }
      }
      return;
    }
    if (!event.ownerAgentId || work.owner?.kind !== 'agent' || work.owner.id !== event.ownerAgentId) return;
    const holder = await rows.agent(event.ownerAgentId);
    if (!holder?.ownerUserId || holder.revokedAt) return;
    const ownerId = holder.ownerUserId;
    // One run at a time per task: a run still working (a duplicate event, a second click) is the one that counts.
    const [latest] = await rows.runsOfWork(work.id, 1);
    if (latest && IN_FLIGHT.includes(latest.status)) return;
    // An agent that does not run on the server (a local client holding the task by co-work) is not this module's to start.
    if (!(await rows.isOwnServerAgent(ownerId, holder.id))) return;
    // The agent says it is on it first: that is what opens the task's discussion, where its run is anchored. No model is called for it.
    // If the start is then refused, the words are taken back with it, so the discussion opens with the refusal and not with a promise.
    let refusal: string | null = null;
    try {
      await tx.transaction(async (inner) => {
        const { ports, runs } = useCases(inner);
        await say(inner, work, holder.id, TAKEN_WORDS, `taken:${event.id}`);
        const place = await taskDiscussionUseCases(inner as unknown as Database).getDiscussionRoot(human(ownerId), work.id).catch(() => null);
        const started: TaskStart = place
          ? await runs.startTask(ports, { ownerUserId: ownerId, agentId: holder.id, workId: work.id, projectId: work.projectId, conversationId: place.conversationId,
            prompt: (taskRunPrompt(work) + askableLines((await askable(inner, work, holder.id)).found.map((other) => ({ name: other.name, owner: other.ownerName })))).slice(0, 3900),
            clientRunId: taskRunClientId(event.id) })
          : { started: false, line: 'I can\'t start: this task has no discussion yet.' };
        if (!started.started) throw new Refused(started.line);
      });
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      refusal = error.line;
    }
    if (refusal !== null) {
      await say(tx, work, holder.id, refusal, `refused:${event.id}`);
      await giveBack(tx, work, ownerId, ownerId);
    }
  }

  const useCases = (tx: Transaction) => {
    const ports = personalRunPorts(tx, queue);
    return { ports, runs: createPersonalRunUseCases({ uow: { run: (job) => job(ports) }, connections: composition.connections ?? noPersonalConnections,
      providerEnabled: composition.providerEnabled ?? false, ...(composition.runtime ? { runtime: composition.runtime } : {}) }) };
  };

  /** The agent's run really began: the task is Doing from now (it stayed To do while the agent waited for room). */
  async function started(tx: Transaction, event: Event) {
    const run = event.runId ? await personalRunRows(tx).findRun(event.runId) : null;
    if (!run || run.kind !== 'task' || !run.workId) return;
    const work = await workRows(tx).findWork(run.workId, { lock: true });
    if (!work || work.status !== 'open' || work.owner?.kind !== 'agent' || work.owner.id !== run.agentId) return;
    await attempt('doing', () => workUseCases(tx as unknown as Database).updateWork(agent(run.agentId), work.id, { status: 'in_progress' }, work.version));
  }

  /** Someone took the task away from an agent while it worked: the run stops (the report would have nowhere to go). */
  async function released(tx: Transaction, event: Event) {
    if (!event.ownerAgentId) return;
    const ports = personalRunPorts(tx, queue);
    // Only the runs that were going when the task was taken away: a retried release must not stop a later assignment's run.
    for (const run of await agentTaskRows(tx).runsOfWork(event.workId, 8))
      if (run.agentId === event.ownerAgentId && IN_FLIGHT.includes(run.status) && run.createdAt <= event.createdAt)
        await stopRunBy(ports, run.id, event.byKind === 'human' && event.byId ? event.byId : run.ownerUserId, { system: !(event.byKind === 'human' && event.byId) });
  }

  async function finished(tx: Transaction, event: Event) {
    const rows = agentTaskRows(tx);
    const run = event.runId ? await personalRunRows(tx).findRun(event.runId, { lock: true }) : null;
    if (!run || (run.kind !== 'task' && run.kind !== 'task_answer') || !run.workId) return;
    const work = await workRows(tx).findWork(run.workId, { lock: true });
    if (!work) return;
    // A run that ended without an answer still says the web addresses it asked for (#953) and what it searched (#954), whoever holds the task now: the discussion is
    // where the people of the task read what the agent did, and nothing else would show them.
    if (run.status !== 'completed' && run.status !== 'truncated' && run.endReason !== 'ai_off') {
      const line = webSourcesLine(await personalRunWebReadRows(tx).forRun(run.id), await personalRunWebReadRows(tx).searches(run.id));
      if (line) await say(tx, work, run.agentId, line, `web:${run.id}`);
    }
    if (FINISHED.has(work.status)) return;
    if (run.kind === 'task_answer') return answered(tx, work, run);
    // The task is still the agent's. If its owner took it back or gave it away meanwhile, there is nothing to finish.
    const holds = work.owner?.kind === 'agent' && work.owner.id === run.agentId;
    const ended = run.status;
    if (ended === 'completed' || ended === 'truncated') {
      if (!holds) return;
      // A report may end with a question for another person's agent (TA-3); the task then waits for the answer instead of finishing.
      const { body, ask } = takeAsk(run.answerBody ?? '');
      if (body || !ask) await say(tx, work, run.agentId, body || '(No answer text.)', `report:${run.id}`, run);
      if (ask) return asking(tx, work, run, ask);
      const mayDo = await personalRunRows(tx).assistantMayDo(run.ownerUserId, run.workspaceId);
      const current = (await workRows(tx).findWork(work.id, { lock: true }))!;
      // A task that is Blocked when the run ends stays Blocked, with the agent, in both modes (#868, C-52): it is waiting for something, so it is
      // not Done and not handed back, and the tasks waiting for it do not resume. When what it waits for is resolved the agent takes it up again.
      if (current.status === 'blocked') {
        await reportTaskRun(personalRunPorts(tx, queue), run, 'blocked');
        return;
      }
      // With "Do it and tell me" it marks the task Done; with "Ask me first" or "Only read" it hands it back to check (C-1), which
      // reaches its owner's Inbox as one item for the run (AG-7).
      // The agent's chat hears what became of the task, once the run's outcome is known (#919): Done, or back with the owner to check.
      if (mayDo === 'act') {
        await attempt('done', () => workUseCases(tx as unknown as Database).updateWork(agent(run.agentId), work.id, { status: 'done' }, current.version));
        await reportTaskRun(personalRunPorts(tx, queue), run, 'done');
      } else {
        await giveBack(tx, work, run.ownerUserId, run.ownerUserId, run.agentId);
        await reportTaskRun(personalRunPorts(tx, queue), run, 'back');
      }
      return;
    }
    if (ended === 'stopped') {
      if (!holds) return;
      const by = run.stopRequestedBy ? await rows.personName(run.stopRequestedBy) : null;
      // With AI off the agent cannot write here any more: the state line tells its owner (C-17), and the task goes back.
      if (run.endReason !== 'ai_off') await say(tx, work, run.agentId, `Stopped${by ? ` by ${by}` : ''}.`, `stopped:${run.id}`);
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

  /** An exchange that stops returns to the people: one line, and the task goes back to its owner. */
  async function toThePeople(tx: Transaction, work: WorkRecord, asker: { id: string; ownerUserId: string }, line: string, key: string) {
    await say(tx, work, asker.id, line, key);
    await giveBack(tx, work, asker.ownerUserId, asker.ownerUserId);
  }

  /** Agent A asked agent B: both owners must be among the task's people, the exchange is bounded, and B only answers. */
  async function asking(tx: Transaction, work: WorkRecord, run: RunRow, ask: AgentQuestion) {
    const asker = { id: run.agentId, ownerUserId: run.ownerUserId };
    if (run.exchangeTurn >= MAX_EXCHANGE_TURNS) return toThePeople(tx, work, asker, 'We have gone back and forth for long enough. This needs a person.', `asked-out:${run.id}`);
    const people = await askable(tx, work, run.agentId);
    const resolved = resolveAsked(ask, people.found);
    if ('none' in resolved) {
      // An agent whose owner is in the task but cannot use the space (not added to it, made a guest, or no longer in the company)
      // cannot work here: say that, not a reason that may not be the true one (#978).
      const shut = resolveAsked(ask, people.outside);
      if ('found' in shut) return toThePeople(tx, work, asker, `I can't ask ${agentLabel(shut.found)}: that agent can't work in this space. This needs a person.`, `asked-outside:${run.id}`);
      return toThePeople(tx, work, asker, `I can't ask ${ask.agent}${ask.owner ? ` (${ask.owner}'s agent)` : ''}: they are not in this task. This needs a person.`, `asked-nobody:${run.id}`);
    }
    // Never a guess: two agents of that name, and the block did not say whose, is a question for the people.
    if ('ambiguous' in resolved) return toThePeople(tx, work, asker, `There is more than one agent called ${ask.agent} in this task: ${resolved.ambiguous.map(agentLabel).join(' and ')}. Say whose you mean. This needs a person.`, `asked-ambiguous:${run.id}`);
    const target = resolved.found;
    await say(tx, work, run.agentId, `@${agentLabel(target)}, ${ask.question}`, `asked:${run.id}`, run);
    const { ports, runs } = useCases(tx);
    const started = await runs.startTask(ports, { kind: 'task_answer', ownerUserId: target.ownerId, agentId: target.id, workId: work.id, projectId: work.projectId,
      conversationId: run.conversationId!, prompt: ask.question, clientRunId: uuidFrom(`agent-task:answer:${run.id}`), askedByRunId: run.id,
      exchangeTurn: run.exchangeTurn + 1, audience: await agentTaskRows(tx).taskPeople(work.id) });
    if (!started.started) await toThePeople(tx, work, asker, `${agentLabel(target)} can't answer now. This needs a person.`, `asked-refused:${run.id}`);
  }

  /** Agent B's run ended: its answer goes in the discussion as B's, and A, which asked, goes on with it. */
  async function answered(tx: Transaction, work: WorkRecord, run: RunRow) {
    const rows = agentTaskRows(tx);
    // The provider's limit paused the answer: its continuation (a run of the same question) answers when it resumes.
    if (run.endReason === 'plan_limit' && await rows.successor(run.id)) return;
    const asked = run.askedByRunId ? await personalRunRows(tx).findRun(run.askedByRunId) : null;
    if (!asked) return;
    // A took the task back, or it went elsewhere, while B answered: the answer is still posted (B's owner paid, the people can read it),
    // but nobody goes on with it.
    const holds = work.owner?.kind === 'agent' && work.owner.id === asked.agentId;
    const asker = { id: asked.agentId, ownerUserId: asked.ownerUserId };
    const label = agentLabel({ name: (await rows.agent(run.agentId))?.name ?? 'The other agent', ownerName: (await rows.personName(run.ownerUserId)) ?? 'Former member' });
    if (run.status !== 'completed' && run.status !== 'truncated') {
      // Whoever stopped it is said, as for any run that is stopped (AG-5).
      if (run.status === 'stopped' && run.endReason !== 'ai_off') {
        const by = run.stopRequestedBy ? await rows.personName(run.stopRequestedBy) : null;
        await say(tx, work, run.agentId, `Stopped${by ? ` by ${by}` : ''}.`, `answer-stopped:${run.id}`);
      }
      if (holds) await toThePeople(tx, work, asker, `${label} didn't answer. This needs a person.`, `unanswered:${run.id}`);
      return;
    }
    // An answer asks nothing: a block it ends with is taken out of what people read and of what the asker is given, so it is not shown
    // as markup and does not start another question (#924).
    const answer = takeAsk(run.answerBody ?? '').body || '(No answer text.)';
    await say(tx, work, run.agentId, answer, `answer:${run.id}`, run);
    if (!holds) return;
    const { ports, runs } = useCases(tx);
    const started = await runs.startTask(ports, { ownerUserId: asker.ownerUserId, agentId: asker.id, workId: work.id, projectId: work.projectId, conversationId: run.conversationId!,
      prompt: (asked.prompt.slice(0, 2000) + answerLines({ agent: label, question: run.prompt }, answer)).slice(0, 3900), clientRunId: uuidFrom(`agent-task:continue:${run.id}`),
      exchangeTurn: run.exchangeTurn });
    if (!started.started) await toThePeople(tx, work, asker, started.line, `continue-refused:${run.id}`);
  }

  let draining = false;
  let again = false;
  let timer: NodeJS.Timeout | undefined;
  /** Set when even the count of a failure could not be written: the database is not answering, so look again soon. */
  let retryIn: number | null = null;
  /** Looks again when the next failed event is due, with no polling in between; one timer, always for the earliest. */
  const lookAgainIn = (seconds: number | null) => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (seconds === null) return;
    timer = setTimeout(() => { timer = undefined; void drain(); }, Math.ceil(seconds * 1000) + 250);
    timer.unref();
  };

  async function handleOne(): Promise<boolean> {
    const claimed: { event: Event | null } = { event: null };
    try {
      return await db.transaction(async (tx) => {
        const rows = agentTaskRows(tx);
        const event = await rows.claimNext();
        if (!event) return false;
        claimed.event = event;
        if (event.attempts >= AGENT_TASK_EVENT_ATTEMPTS) {
          log.warn({ event: event.id, kind: event.kind, workId: event.workId }, 'An agent task event is given up after repeated failures');
          await giveUp(tx, event);
        } else if (await lockInOrder(tx, event)) {
          if (event.kind === 'assigned') await assigned(tx, event);
          else if (event.kind === 'started') await started(tx, event);
          else if (event.kind === 'released') await released(tx, event);
          else await finished(tx, event);
        }
        await rows.markHandled(event.id);
        return true;
      });
    } catch (error) {
      const event = claimed.event;
      if (error instanceof Relock) return true;
      if (!event) { log.warn({ error }, 'An agent task event failed'); return false; }
      // Counted only while nobody has handled it: another replica may have taken it just after this try failed and done it.
      const counted = await agentTaskRows(db).failed(event.id).then((result) => ({ attempts: result?.attempts ?? null }), () => null);
      log.warn({ error, event: event.id, kind: event.kind, workId: event.workId, attempts: counted?.attempts ?? null }, 'An agent task event failed and will be tried again');
      if (!counted) { retryIn = 5; return false; }
      // Even the give-up failed every time: the event is left as it is, with its count, and says so here once.
      if (counted.attempts !== null && counted.attempts >= AGENT_TASK_EVENT_ATTEMPTS + AGENT_TASK_GIVE_UP_ATTEMPTS)
        (log.error ?? log.warn).call(log, { event: event.id, kind: event.kind, workId: event.workId, attempts: counted.attempts }, 'An agent task event could not be given up and is left unhandled');
      return true;
    }
  }

  async function drain() {
    if (draining) { again = true; return; }
    draining = true;
    try {
      do {
        again = false;
        while (await handleOne()) { /* each event is its own transaction */ }
      } while (again);
      await agentTaskRows(db).prune().catch(() => undefined);
      // An event that failed waits for its time: the timer is set from the database, so one waiting at start is found too.
      const waiting = await agentTaskRows(db).nextDueIn().catch(() => null);
      const soonest = [waiting, retryIn].filter((seconds): seconds is number => seconds !== null);
      retryIn = null;
      lookAgainIn(soonest.length ? Math.min(...soonest) : null);
    } finally { draining = false; }
  }

  return { drain };
}
