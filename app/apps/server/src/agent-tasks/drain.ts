import { AGENT_TASK_EVENT_ATTEMPTS, agentTaskRows, personalRunRows, workRows, type Database, type Transaction } from '@flux/db';
import { agentLabel, answerLines, askableLines, createPersonalRunUseCases, DomainError, MAX_EXCHANGE_TURNS, noPersonalConnections, resolveAsked, stopRunBy, TAKEN_WORDS, takeAsk, taskRunClientId,
  taskRunPrompt, uuidFrom, type AgentQuestion, type Askable, type Principal, type TaskStart, type WorkRecord } from '@flux/core';
import { personalRunPorts, type PersonalRunComposition, type PersonalRunQueueFactory } from '../personal-runs/adapters.js';
import { taskDiscussionUseCases } from '../work/task-discussions.js';
import { workUseCases } from '../work/adapters.js';

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
// later each time. Every event takes its locks in one order, before it reads or writes anything else: the space's task-graph lock,
// then the enablement rows of the people whose agents may start a run (ascending), then the task and run rows. The work use cases and
// the worker take the same locks in the same order, so two drains, a drain and a person's request or the worker cannot wait for each other.

const human = (id: string): Principal => ({ kind: 'human', id });
const agent = (id: string): Principal => ({ kind: 'agent', id });
const FINISHED = new Set(['done', 'not_pursued']);
const IN_FLIGHT = ['queued', 'reading', 'dispatching'];

type Event = NonNullable<Awaited<ReturnType<ReturnType<typeof agentTaskRows>['claimNext']>>>;
type RunRow = NonNullable<Awaited<ReturnType<ReturnType<typeof personalRunRows>['findRun']>>>;
export interface AgentTaskDrain {
  /** Handles every event waiting; a call while one is running makes it look again before it stops. */
  drain(): Promise<void>;
}

/** The step was refused by the start itself, and the savepoint holding the agent's first words is rolled back with it. */
class Refused extends Error { constructor(readonly line: string) { super(line); } }

export function createAgentTaskDrain(db: Database, queue: PersonalRunQueueFactory, composition: Omit<PersonalRunComposition, 'queue'>,
  log: { warn(object: unknown, message: string): void } = { warn: () => undefined }): AgentTaskDrain {

  /** A step a rule may refuse is logged and left; any other failure is not swallowed: it rolls the event back, to be tried again. */
  async function attempt<T>(what: string, step: () => Promise<T>): Promise<T | null> {
    try { return await step(); } catch (error) {
      if (error instanceof DomainError) { log.warn({ error, what }, 'An agent task step was refused'); return null; }
      throw error;
    }
  }

  async function say(tx: Transaction, work: WorkRecord, as: string, body: string, key: string) {
    await attempt('say', () => taskDiscussionUseCases(tx as unknown as Database).contribute(agent(as), work.id, { body, clientMessageId: uuidFrom(`agent-task:${key}`) }));
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

  /** The locks of an event, in the one order (see the top of this file). Returns false when the task is gone. */
  async function lockInOrder(tx: Transaction, event: Event): Promise<boolean> {
    const rows = agentTaskRows(tx);
    const work = await workRows(tx).findWork(event.workId);
    if (!work) return false;
    await workRows(tx).lockTaskGraphs([work.projectId]);
    const owners = new Set<string>();
    if (event.kind === 'assigned' && event.ownerAgentId) {
      const holder = await rows.agent(event.ownerAgentId);
      if (holder?.ownerUserId) owners.add(holder.ownerUserId);
    }
    if (event.kind === 'finished' && event.runId) {
      // A run that asked a question, or answers one, starts the other agent's run: the owners of both are locked now, in order.
      const run = await personalRunRows(tx).findRun(event.runId);
      if (run && (run.kind === 'task_answer' || run.answerBody?.includes('<ask>'))) {
        owners.add(run.ownerUserId);
        for (const person of await rows.taskPeople(event.workId)) owners.add(person);
        const asked = run.askedByRunId ? await personalRunRows(tx).findRun(run.askedByRunId) : null;
        if (asked) owners.add(asked.ownerUserId);
      }
    }
    for (const owner of [...owners].sort()) await personalRunRows(tx).enablement(owner, { lock: true });
    return true;
  }

  /** The agents of the task's other people that an agent may ask (TA-3): both owners are among the task's people. */
  async function askable(tx: Transaction, workId: string, askerOwner: string): Promise<Askable[]> {
    const rows = agentTaskRows(tx);
    const found: Askable[] = [];
    for (const person of (await rows.taskPeople(workId)).filter((id) => id !== askerOwner)) {
      const ownerName = (await rows.personName(person)) ?? 'Former member';
      for (const other of await rows.ownServerAgents(person)) found.push({ id: other.id, name: other.name, ownerId: person, ownerName });
    }
    // Always in the same order, so a line that names two agents reads the same each time.
    return found.sort((a, b) => a.ownerName.localeCompare(b.ownerName) || a.name.localeCompare(b.name));
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
            prompt: (taskRunPrompt(work) + askableLines((await askable(inner, work.id, ownerId)).map((other) => ({ name: other.name, owner: other.ownerName })))).slice(0, 3900),
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
    for (const run of await agentTaskRows(tx).runsOfWork(event.workId, 8))
      if (run.agentId === event.ownerAgentId && IN_FLIGHT.includes(run.status)) await stopRunBy(ports, run.id, event.byKind === 'human' && event.byId ? event.byId : run.ownerUserId);
  }

  async function finished(tx: Transaction, event: Event) {
    const rows = agentTaskRows(tx);
    const run = event.runId ? await personalRunRows(tx).findRun(event.runId, { lock: true }) : null;
    if (!run || (run.kind !== 'task' && run.kind !== 'task_answer') || !run.workId) return;
    const work = await workRows(tx).findWork(run.workId, { lock: true });
    if (!work || FINISHED.has(work.status)) return;
    if (run.kind === 'task_answer') return answered(tx, work, run);
    // The task is still the agent's. If its owner took it back or gave it away meanwhile, there is nothing to finish.
    const holds = work.owner?.kind === 'agent' && work.owner.id === run.agentId;
    const ended = run.status;
    if (ended === 'completed' || ended === 'truncated') {
      if (!holds) return;
      // A report may end with a question for another person's agent (TA-3); the task then waits for the answer instead of finishing.
      const { body, ask } = takeAsk(run.answerBody ?? '');
      if (body || !ask) await say(tx, work, run.agentId, body || '(No answer text.)', `report:${run.id}`);
      if (ask) return asking(tx, work, run, ask);
      const mayDo = await personalRunRows(tx).assistantMayDo(run.ownerUserId, run.workspaceId);
      const current = (await workRows(tx).findWork(work.id, { lock: true }))!;
      // With "Do it and tell me" it marks the task Done; with "Ask me first" or "Only read" it hands it back to check (C-1), which
      // reaches its owner's Inbox as one item for the run (AG-7).
      if (mayDo === 'act') await attempt('done', () => workUseCases(tx as unknown as Database).updateWork(agent(run.agentId), work.id, { status: 'done' }, current.version));
      else await giveBack(tx, work, run.ownerUserId, run.ownerUserId, run.agentId);
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
    const resolved = resolveAsked(ask, await askable(tx, work.id, run.ownerUserId));
    if ('none' in resolved) return toThePeople(tx, work, asker, `I can't ask ${ask.agent}${ask.owner ? ` (${ask.owner}'s agent)` : ''}: they are not in this task. This needs a person.`, `asked-nobody:${run.id}`);
    // Never a guess: two agents of that name, and the block did not say whose, is a question for the people.
    if ('ambiguous' in resolved) return toThePeople(tx, work, asker, `There is more than one agent called ${ask.agent} in this task: ${resolved.ambiguous.map(agentLabel).join(' and ')}. Say whose you mean. This needs a person.`, `asked-ambiguous:${run.id}`);
    const target = resolved.found;
    await say(tx, work, run.agentId, `@${agentLabel(target)}, ${ask.question}`, `asked:${run.id}`);
    const { ports, runs } = useCases(tx);
    const started = await runs.startTask(ports, { kind: 'task_answer', ownerUserId: target.ownerId, agentId: target.id, workId: work.id, projectId: work.projectId,
      conversationId: run.conversationId, prompt: ask.question, clientRunId: uuidFrom(`agent-task:answer:${run.id}`), askedByRunId: run.id,
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
    const answer = run.answerBody ?? '(No answer text.)';
    await say(tx, work, run.agentId, answer, `answer:${run.id}`);
    if (!holds) return;
    const { ports, runs } = useCases(tx);
    const started = await runs.startTask(ports, { ownerUserId: asker.ownerUserId, agentId: asker.id, workId: work.id, projectId: work.projectId, conversationId: run.conversationId,
      prompt: (asked.prompt.slice(0, 2000) + answerLines({ agent: label, question: run.prompt }, answer)).slice(0, 3900), clientRunId: uuidFrom(`agent-task:continue:${run.id}`),
      exchangeTurn: run.exchangeTurn });
    if (!started.started) await toThePeople(tx, work, asker, started.line, `continue-refused:${run.id}`);
  }

  let draining = false;
  let again = false;
  /** After a failed event: look again when it is due, with no polling in between. */
  const retryAfter = (seconds: number) => { setTimeout(() => { void drain(); }, seconds * 1000).unref(); };

  async function handleOne(): Promise<boolean> {
    const claimed: { event: Event | null } = { event: null };
    try {
      return await db.transaction(async (tx) => {
        const rows = agentTaskRows(tx);
        const event = await rows.claimNext();
        if (!event) return false;
        claimed.event = event;
        if (await lockInOrder(tx, event)) {
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
      log.warn({ error, event: event?.id }, 'An agent task event failed and will be tried again');
      if (event) {
        const { attempts, waitSeconds } = await agentTaskRows(db).failed(event.id).catch(() => ({ attempts: 0, waitSeconds: 5 }));
        if (attempts >= AGENT_TASK_EVENT_ATTEMPTS) {
          // Given up: it is written down and no longer waits, so a lost assignment is in the log and not silent.
          log.warn({ event: event.id, kind: event.kind, workId: event.workId }, 'An agent task event was given up after repeated failures');
          await agentTaskRows(db).markHandled(event.id).catch(() => undefined);
        } else retryAfter(waitSeconds);
      }
      return event !== null;
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
    } finally { draining = false; }
  }

  return { drain };
}
