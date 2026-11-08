import type { PgBoss } from 'pg-boss';
import type { FastifyInstance } from 'fastify';
import { TASK_TAKING_PATH, taskAgentPath, taskAgentRetryPath, taskAgentStopPath, taskPeoplePath, type SetTaskTaking, type TaskPeople } from '@flux/contracts';
import { agentLabel, createTaskTaking, enforce, evaluateProject, NotFoundError, ConflictError, ForbiddenError, stopRunBy, taskAgentState, type Principal } from '@flux/core';
import { agentTaskRows, accessReader, listen, sql, workRows, type Database, type Transaction } from '@flux/db';
import type { SessionResolver } from '../identity/index.js';
import { useDomainErrors } from '../http/commands.js';
import { pgBossPersonalRunQueue, personalRunPorts, type PersonalRunComposition } from '../personal-runs/adapters.js';
import { policyWorkAccess } from '../work/access.js';
import { createAgentTaskDrain } from './drain.js';

// The routes and the listener of people's agents taking tasks (#856, F-036 AG-5). The setting and the state line are read and
// written here; the work itself is drained from `agent_task_events` (drain.ts) whenever the database says there is something.

const CHANNEL = 'flux_agent_tasks';
const IN_FLIGHT = ['queued', 'reading', 'dispatching'];
const missing = () => new NotFoundError('Task', 'WORK_NOT_FOUND');

interface Options {
  db: Database; sessions: SessionResolver; boss: Pick<PgBoss, 'send'>; connectionString: string;
  composition: Omit<PersonalRunComposition, 'queue'>;
}

export async function agentTaskRoutes(app: FastifyInstance, { db, sessions, boss, connectionString, composition }: Options) {
  useDomainErrors(app);
  const who = async (request: Parameters<SessionResolver['requirePrincipal']>[0]) => (await sessions.requirePrincipal(request)).principal;
  const queue = pgBossPersonalRunQueue(boss);
  const drain = createAgentTaskDrain(db, queue, composition, app.log);
  const taking = createTaskTaking({ run: (work) => db.transaction((tx) => {
    const rows = agentTaskRows(tx);
    return work({ agents: (userId) => rows.ownServerAgents(userId), taking: (userId) => rows.taking(userId), setTaking: (userId, agentId) => rows.setTaking(userId, agentId) });
  }) });

  app.get(TASK_TAKING_PATH, async (request, reply) => reply.header('cache-control', 'no-store').send(await taking.get(await who(request))));
  app.put<{ Body: SetTaskTaking }>(TASK_TAKING_PATH, { schema: { body: { type: 'object', required: ['agentId'], additionalProperties: false,
    properties: { agentId: { type: ['string', 'null'] } } } } }, async (request, reply) =>
    reply.header('cache-control', 'no-store').send(await taking.set(await who(request), request.body)));

  /** The task, its project and what this reader may do about its agent, read in one transaction. */
  async function read(tx: Transaction, principal: Principal, workId: string) {
    const work = await workRows(tx).findWork(workId);
    if (!work) throw missing();
    await policyWorkAccess(tx).requireProject(principal, 'read', work.projectId).catch((error) => { throw error instanceof NotFoundError ? missing() : error; });
    const rows = agentTaskRows(tx);
    const recent = await rows.runsOfWork(workId, 8);
    const holder = work.owner?.kind === 'agent' ? work.owner.id : recent[0]?.agentId ?? null;
    // The holder's own latest run says its state; another agent's answer in flight (#841) says it is waiting for it.
    const run = recent.find((candidate) => candidate.agentId === holder && candidate.kind === 'task') ?? null;
    const answering = recent.find((candidate) => candidate.kind === 'task_answer' && IN_FLIGHT.includes(candidate.status)) ?? null;
    const answeringAgent = answering ? await rows.agent(answering.agentId) : null;
    // Whose agent it is, as the thread says it ("Fieldbot (Carl's agent)"): every person's first agent has the same name.
    const answeringLabel = answeringAgent ? agentLabel({ name: answeringAgent.name, ownerName: (await rows.personName(answering!.ownerUserId)) ?? 'Former member' }) : null;
    const agent = holder ? await rows.agent(holder) : null;
    const owner = agent?.ownerUserId ? { id: agent.ownerUserId, name: (await rows.personName(agent.ownerUserId)) ?? 'Former member' } : null;
    const admin = (await evaluateProject(principal, 'project.manage', work.projectId, accessReader(tx))).allowed;
    return { work, run, inFlight: recent.find((candidate) => IN_FLIGHT.includes(candidate.status)) ?? null, waitingForAnswer: answering && answeringLabel ? { name: answeringLabel, ownerId: answering.ownerUserId,
        run: { status: answering.status, engine: answering.engine, provider: answering.provider, endReason: answering.endReason, resumeAt: answering.resumeAt } } : null, rows,
      agent: agent && owner ? { id: agent.id, name: agent.name, owner } : null, admin };
  }

  app.get<{ Params: { workId: string } }>(taskAgentPath(':workId'), async (request, reply) => {
    const principal = await who(request);
    const state = await db.transaction(async (tx) => {
      const { work, run, waitingForAnswer, rows, agent, admin } = await read(tx, principal, request.params.workId);
      const stopper = run?.stopRequestedBy ? { id: run.stopRequestedBy, name: (await rows.personName(run.stopRequestedBy)) ?? 'Former member' } : null;
      const waiting = run ? await tx.execute<{ n: number }>(rawCount(run.id)) : null;
      const lastOwner = await rows.lastOwnerChange(work.id);
      // Someone who is not the agent's owner may hold the task now (they took it): the line says who.
      const holderOfTask = work.owner?.kind === 'human' && work.owner.id !== agent?.owner.id ? (await rows.personName(work.owner.id)) ?? 'Former member' : null;
      return taskAgentState({
        taskOwnerName: holderOfTask,
        viewerId: principal.id, viewerIsAdmin: admin,
        task: { ownerUserId: work.owner?.kind === 'human' ? work.owner.id : null, ownerAgentId: work.owner?.kind === 'agent' ? work.owner.id : null, status: work.status },
        agent, successor: run ? await rows.successor(run.id) : null, waitingChanges: Number(waiting?.rows[0]?.n ?? 0), waitingForAnswer,
        handedBackByAgent: lastOwner?.kind === 'agent' && lastOwner.id === agent?.id,
        run: run && { id: run.id, status: run.status, engine: run.engine, provider: run.provider, endReason: run.endReason, resumeAt: run.resumeAt,
          stopRequestedAt: run.stopRequestedAt, stopRequestedBy: stopper, planLimitResetsAt: run.planLimitResetsAt },
      });
    });
    return reply.header('cache-control', 'no-store').send(state);
  });

  // Who is in the task and their agents (TA-1): the people of the task, as everyone who can read it sees them. Someone who can no longer
  // read the space (removed, left, or a guest who was not added) is not in it now, nor are their agents (#924).
  app.get<{ Params: { workId: string } }>(taskPeoplePath(':workId'), async (request, reply) => {
    const principal = await who(request);
    const body = await db.transaction(async (tx): Promise<TaskPeople> => {
      const { work, rows } = await read(tx, principal, request.params.workId);
      const access = policyWorkAccess(tx);
      const people: TaskPeople['people'] = [];
      for (const id of await rows.taskPeople(work.id)) {
        if (!(await access.canRead({ kind: 'human', id }, work.projectId))) continue;
        const agents: TaskPeople['people'][number]['agents'] = [];
        for (const agent of await rows.ownServerAgents(id))
          if (await access.canRead({ kind: 'agent', id: agent.id }, work.projectId)) agents.push({ id: agent.id, name: agent.name });
        people.push({ id, name: (await rows.personName(id)) ?? 'Former member', agents });
      }
      return { people: people.sort((a, b) => a.name.localeCompare(b.name)) };
    });
    return reply.header('cache-control', 'no-store').send(body);
  });

  // Stop: the agent's owner or the space admin, at any time. The next call of the run is refused, what it changed stays with
  // Undo, and the task goes back to its owner, who is told who stopped it (the state line and the agent's message).
  app.post<{ Params: { workId: string } }>(taskAgentStopPath(':workId'), async (request, reply) => {
    const principal = await who(request);
    await db.transaction(async (tx) => {
      const { work, inFlight: run, agent, admin } = await read(tx, principal, request.params.workId);
      if (!run || !agent || work.owner?.id !== agent.id) throw new ConflictError('No agent is working on this task', 'AGENT_NOT_WORKING');
      // The run that is working is stopped by its own agent's owner or a space admin (AG-5): when an agent is waiting for another's answer,
      // that is the answering agent's owner, not the one who asked.
      if (run.ownerUserId !== principal.id && !admin) throw new ForbiddenError('Only the owner of the agent that is working, or a space admin, can stop it', 'AGENT_STOP_FORBIDDEN');
      enforce(await evaluateProject(principal, 'project.write', work.projectId, accessReader(tx), { lock: true }), 'project');
      await stopRunBy(personalRunPorts(tx, queue), run.id, principal.id);
    });
    void drain.drain();
    return reply.code(202).send({ ok: true });
  });

  // Try again, after it failed: only the agent's owner. It is the same as giving the task to the agent again.
  app.post<{ Params: { workId: string } }>(taskAgentRetryPath(':workId'), async (request, reply) => {
    const principal = await who(request);
    await db.transaction(async (tx) => {
      const { work, inFlight, rows, agent } = await read(tx, principal, request.params.workId);
      if (!agent || agent.owner.id !== principal.id) throw new ForbiddenError('Only the agent\'s owner can try again', 'AGENT_RETRY_FORBIDDEN');
      if (work.owner?.kind !== 'agent' || work.owner.id !== agent.id || inFlight) throw new ConflictError('Nothing to try again', 'AGENT_NOT_FAILED');
      await rows.noteAssigned(work.id, { kind: 'agent', id: agent.id }, { kind: 'human', id: principal.id });
    });
    void drain.drain();
    return reply.code(202).send({ ok: true });
  });

  // Whatever the database says there is to do is done at once: when a transaction wrote an event (NOTIFY), when the listener
  // reconnects, and once at start for anything left by a stop. Nothing is polled while idle.
  const listener = listen(connectionString, CHANNEL, () => { void drain.drain(); }, () => { void drain.drain(); }, (error) => app.log.warn({ error }, 'Agent task listener interrupted'));
  app.addHook('onClose', async () => listener.close());
  void drain.drain();
}

const rawCount = (runId: string) => sql`SELECT count(*)::int AS n FROM assistant_changes WHERE run_id = ${runId}::uuid AND state = 'waiting'`;
