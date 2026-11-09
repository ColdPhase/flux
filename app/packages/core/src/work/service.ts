import { createHash, randomUUID } from 'node:crypto';
import {
  WORK_LIMITS,
  waitingPhrase,
  type CreateObjectLinkCommand,
  type CreateWorkCommand,
  type Decision,
  type NamedPrincipal,
  type ObjectLink,
  type ObjectRef,
  type Page,
  type PageQuery,
  type ProposeDecisionCommand,
  type UpdateWorkCommand,
  type WaitingOn,
  type WorkItem,
  type WorkObjectType,
  type TaskActivityPage,
  type TaskActivityQuery,
  type ObjectNotice,
  type TaskCreationNotice,
  type TaskCreationUndoEligibility,
  type UndoTaskCreationCommand,
  type UndoTaskCreationResult,
} from '@flux/contracts';
import { ConflictError, ForbiddenError, InvalidInputError, NotFoundError, RuleViolationError, VersionConflictError, SpaceAiOffError } from '../access/errors.js';
import type { Principal } from '../principal.js';
import type { ActorRef, DecisionRecord, NativeCommandReceipt, ObjectLinkRecord, NewObjectLink, TaskChangeVia, TaskPlanRecord, WorkChanges, WorkPorts, WorkRecord, WorkRepository, WorkUnitOfWork } from './ports.js';
import { assertNoDependencyCycle, assertPrerequisitesMet, creationFingerprint, decidePlanIntent, directPrerequisiteIds, ELIGIBLE_STATUSES,
  lockProjectGraphs, sortedIds } from './task-graph.js';
import * as valid from './validation.js';
import { creationUndoEligibility, mayUndoTaskCreation, type TaskCreationUndoFacts } from './creation-undo.js';
import { presentGithubRule, type GithubRuleReading } from '../github/rules.js';
import { readTaskActivity } from './task-activity.js';

// Work and decision use cases (issue #101). Each runs in one unit of work: it asks the
// access port first (reads: project read; changes: project write with the access rows locked),
// then checks versions and references, changes rows and records exactly one project event, so
// the decision, the change and the stream event commit together.
//
// Rules: agents act through their #29 project grants and may create work and
// propose decisions; only a person accepts a decision. Accepting a decision that replaces an
// earlier one only marks the earlier one superseded (kept, with its reason). Flux never moves or
// parks work because a decision changed: people decide about the tasks themselves (#871).
//
// Task plans (#152): a task carries criteria, direct same-project prerequisites and an optional
// immutable plan intent. Writers that touch the graph or an intent take their locks in one order:
// project access rows -> the plan material row -> the command identity -> the project task-graph lock
// -> the complete task rows in ascending id -> everything else. Starting or finishing a task needs every
// prerequisite done. Nothing infers that listed criteria are satisfied.
//
// Explicit effects on a task's canonical thread (#154): an explicitly saved nonempty blocker and the
// "what came of it" line contribute through the mandatory `ports.contributions` hook, inside the same unit
// of work, in that same order: the command's durable identity is the native receipt and then every
// derived message identity (sorted), before the graph lock; the complete sorted task set (the linked
// tasks together with the prerequisites a finishing task reads, in ONE ascending pass) precedes the
// domain writes, the canonical appends, the receipt, and the events last (one final batch owned by the
// caller's unit of work).

const LABEL: Record<WorkObjectType, string> = { work: 'Work item', decision: 'Decision' };
const CODE: Record<WorkObjectType, string> = { work: 'WORK_NOT_FOUND', decision: 'DECISION_NOT_FOUND' };
const FINISHED = new Set(['done']);

const iso = (date: Date) => date.toISOString();
const key = (actor: ActorRef) => `${actor.kind}:${actor.id}`;

function actor(principal: Principal): ActorRef {
  if (principal.kind === 'fixture' || !principal.id) throw new InvalidInputError('A signed-in person or agent is required');
  return { kind: principal.kind, id: principal.id };
}

function notFound(type: WorkObjectType) {
  return new NotFoundError(LABEL[type], CODE[type]);
}

/**
 * The links from or to `ids`, with the current titles of both ends, as a lookup per id. Titles
 * come only from each link's own project, so a link never shows something outside it.
 */
export async function linkReader(repo: Pick<WorkRepository, 'links' | 'titles'>, ids: string[]): Promise<(id: string) => ObjectLink[]> {
  const links = ids.length ? await repo.links(ids) : [];
  const target = (link: ObjectLinkRecord): ObjectRef =>
    (link.toType === 'material' ? { type: 'material', id: link.toId, version: link.toVersion! } : { type: link.toType, id: link.toId }) as ObjectRef;
  const byProject = new Map<string, ObjectRef[]>();
  for (const link of links) {
    const refs = byProject.get(link.projectId) ?? [];
    refs.push({ type: link.fromType, id: link.fromId } as ObjectRef, target(link));
    byProject.set(link.projectId, refs);
  }
  const titles = new Map<string, { title: string; conversationId?: string; sketchId?: string }>();
  for (const [projectId, refs] of byProject) for (const [ref, title] of await repo.titles(projectId, refs)) titles.set(ref, title);
  return (id: string): ObjectLink[] => links.filter((link) => link.fromId === id || link.toId === id).map((link) => {
    const to = target(link);
    const toTitle = titles.get(valid.refKey(to));
    return {
      id: link.id, projectId: link.projectId, role: link.role, from: { type: link.fromType, id: link.fromId }, to,
      fromTitle: titles.get(`${link.fromType}:${link.fromId}`)?.title ?? '', toTitle: toTitle?.title ?? '',
      conversationId: toTitle?.conversationId ?? null, sketchId: toTitle?.sketchId ?? null, createdAt: iso(link.createdAt),
    };
  });
}

const NO_PLAN: TaskPlanRecord = { prerequisites: [], planIntent: null };

/** Links and names needed to present a set of records to one reader. `plans` adds the task graph of work. */
async function presenter(ports: WorkPorts, ids: string[], actors: (ActorRef | null)[], plans = false, waits: readonly { kind: 'decision' | 'task'; id: string }[] = []) {
  const rules = plans && ids.length ? await ports.work.githubRules(ids) : new Map<string, GithubRuleReading>();
  const ruleAuthors = [...rules.values()].flatMap((rule): ActorRef[] => rule.authorUserId ? [{ kind: 'human', id: rule.authorUserId }] : []);
  const [linksOf, names, planOf, waitingOn] = await Promise.all([
    linkReader(ports.work, ids),
    ports.work.names([...actors.filter((item): item is ActorRef => item !== null), ...ruleAuthors]),
    plans && ids.length ? ports.work.taskPlans(ids) : Promise.resolve(new Map<string, TaskPlanRecord>()),
    waits.length ? ports.work.waitingTargets(waits) : Promise.resolve(new Map<string, WaitingOn>()),
  ]);
  const named = (ref: ActorRef): NamedPrincipal => ({ ...ref, name: names.get(key(ref)) ?? (ref.kind === 'agent' ? 'Agent' : 'Former member') });
  const base = (record: { id: string; projectId: string; workspaceId: string; createdAt: Date }) => ({
    id: record.id, projectId: record.projectId, workspaceId: record.workspaceId,
    audience: { kind: 'project' as const, projectId: record.projectId }, links: linksOf(record.id), createdAt: iso(record.createdAt),
  });
  const githubRule = (record: WorkRecord): WorkItem['githubRule'] => {
    const rule = rules.get(record.id);
    return rule ? { ...presentGithubRule(rule, record),
      setUpBy: rule.authorUserId ? named({ kind: 'human', id: rule.authorUserId }) : null } : null;
  };
  return {
    work: (record: WorkRecord): WorkItem => {
      const plan = planOf.get(record.id) ?? NO_PLAN;
      return {
        ...base(record), number: record.number, title: record.title, outcome: record.outcome, criteria: record.criteria, status: record.status, blocker: record.blocker,
        waitingFor: record.waitingFor ? named(record.waitingFor) : null,
        waitingOn: record.waitingOn ? waitingOn.get(`${record.waitingOn.kind}:${record.waitingOn.id}`) ?? null : null,
        dropped: record.dropped, cameOfIt: record.cameOfIt,
        dueOn: record.dueOn,
        dependencyIds: plan.prerequisites.map((item) => item.id),
        prerequisites: plan.prerequisites.map((item) => ({ ...item, met: item.status === 'done' })),
        planIntent: plan.planIntent,
        owner: record.owner ? named(record.owner) : null,
        lifecycle: record.creationRevertedAt && record.creationRevertedBy && record.creationReversionNoticeId
          ? { state: 'creation_reverted', noticeId: record.creationReversionNoticeId, revertedAt: iso(record.creationRevertedAt), revertedBy: named(record.creationRevertedBy) } : { state: 'active' },
        createdBy: named(record.createdBy), githubRule: githubRule(record), version: record.version, updatedAt: iso(record.updatedAt),
      };
    },
    decision: (record: DecisionRecord): Decision => ({
      ...base(record), title: record.title, rationale: record.rationale, status: record.status,
      proposedBy: named(record.proposedBy), decidedBy: record.decidedBy ? named({ kind: 'human', id: record.decidedBy }) : null,
      decidedAt: record.decidedAt ? iso(record.decidedAt) : null, supersedes: record.supersedesId, supersededBy: record.supersededById,
      supersededAt: record.supersededAt ? iso(record.supersededAt) : null, version: record.version, updatedAt: iso(record.updatedAt),
    }),
  };
}

const waitsOf = (records: WorkRecord[]) => records.flatMap((record) => record.waitingOn ? [record.waitingOn] : []);
const workActors = (records: WorkRecord[]) => records.flatMap((record) => [record.owner, record.waitingFor, record.createdBy, record.creationRevertedBy ?? null]);
const decisionActors = (records: DecisionRecord[]) => records.flatMap((record) => [record.proposedBy, record.decidedBy ? { kind: 'human' as const, id: record.decidedBy } : null]);

async function presentWork(ports: WorkPorts, record: WorkRecord) {
  return (await presenter(ports, [record.id], workActors([record]), true, waitsOf([record]))).work(record);
}
async function presentDecision(ports: WorkPorts, record: DecisionRecord) {
  return (await presenter(ports, [record.id], decisionActors([record]))).decision(record);
}

/**
 * Finds the project of an object and asks the policy. An object in a project the caller cannot
 * see is reported exactly like a missing one, so its existence never leaks.
 */
async function authorized(ports: WorkPorts, principal: Principal, type: WorkObjectType, objectId: unknown, action: 'read' | 'write') {
  if (!valid.isId(objectId)) throw notFound(type);
  const located = await ports.work.locate(type, objectId.toLowerCase());
  if (!located) throw notFound(type);
  try {
    const { workspaceId } = await ports.access.requireProject(principal, action, located.projectId, { lock: action === 'write' });
    return { id: objectId.toLowerCase(), projectId: located.projectId, workspaceId };
  } catch (error) {
    if (error instanceof NotFoundError) throw notFound(type);
    throw error;
  }
}

/**
 * Whether the cited objects exist in this project. Every write that cites one calls it again right after taking the project graph
 * lock: the assistant's Undo of a decision, map or message it made holds that lock while it looks for use and removes the
 * object, so a citation is either committed before that look or finds the object gone (#68). No row is locked for this, so it cannot
 * cross a writer that locks the object's own row first (a map's thoughts, for instance).
 */
async function requireTargets(ports: WorkPorts, projectId: string, targets: ObjectRef[]) {
  for (const target of targets) {
    if (!(await ports.work.targetExists(projectId, target)))
      throw new RuleViolationError(`The linked ${target.type} is not part of this space`, 'LINK_TARGET_NOT_FOUND');
  }
}

/** Under the retained project graph: do not lock a guessed or foreign prerequisite. */
async function requireDependencyTargets(ports: WorkPorts, projectId: string, ids: readonly string[]) {
  for (const id of ids) {
    if ((await ports.work.locate('work', id))?.projectId !== projectId)
      throw new RuleViolationError('Every prerequisite must be a task of this space', 'TASK_DEPENDENCY_NOT_FOUND');
  }
}

/** Revalidate the current scope returned by the ONE complete sorted task pass. */
function requireDependencyScope(projectIds: readonly string[], projectId: string) {
  if (projectIds.some((id) => id !== projectId))
    throw new RuleViolationError('Every prerequisite must be a task of this space', 'TASK_DEPENDENCY_NOT_FOUND');
}

async function requireOwner(ports: WorkPorts, projectId: string, owner: ActorRef | null, by: Principal) {
  // F-029: no task is handed to an agent while AI is off in the workspace (people stay assignable).
  if (owner?.kind === 'agent' && !(await ports.access.aiAllowed(projectId))) throw new SpaceAiOffError();
  // #904 (AG-5): a task is given to your own agent, never to someone else's. Another person's agent takes it only through that person.
  if (owner?.kind === 'agent' && !(await ports.access.ownsAgent?.(by, owner.id)))
    throw new RuleViolationError('Give a task to one of your own agents. To reach another person\'s agent, give the task to that person.', 'OWNER_NOT_YOUR_AGENT');
  if (owner && !(await ports.access.canRead(owner, projectId)))
    throw new RuleViolationError('The owner needs current access to this space', 'OWNER_WITHOUT_ACCESS');
}

const sameOwner = (a: ActorRef | null, b: ActorRef | null) => a?.kind === b?.kind && a?.id === b?.id;

/** The one person a blocked task waits for: a person who can read the project (#550). */
async function requireWaitingFor(ports: WorkPorts, projectId: string, waitingFor: ActorRef | null) {
  if (waitingFor && !(await ports.access.canRead(waitingFor, projectId)))
    throw new RuleViolationError('The person waited on needs current access to this space', 'WAITING_FOR_WITHOUT_ACCESS');
}

/**
 * What a blocked task waits for besides a person (#868): a decision still proposed, or a task not yet done, of the same space; never the
 * task itself and never a task that already waits for it, however far round. Read under the project's graph lock, so a decision that is
 * accepted or a task that is done meanwhile is either seen here or resumes this task after it.
 */
async function requireWaitingOn(ports: WorkPorts, projectId: string, taskId: string | null, on: { kind: 'decision' | 'task'; id: string }) {
  if (on.kind === 'decision') {
    const decision = await ports.work.findDecision(on.id);
    if (!decision || decision.projectId !== projectId) throw new RuleViolationError('The decision is not part of this space', 'WAITING_ON_NOT_FOUND');
    if (decision.status !== 'proposed') throw new RuleViolationError('That decision is already decided; there is nothing to wait for', 'WAITING_ON_RESOLVED');
    return;
  }
  if (taskId && on.id === taskId) throw new RuleViolationError('A task cannot wait for itself', 'WAITING_ON_ITSELF');
  const task = await ports.work.findWork(on.id);
  if (!task || task.projectId !== projectId || task.creationRevertedAt) throw new RuleViolationError('The task is not part of this space', 'WAITING_ON_NOT_FOUND');
  if (task.status === 'done') throw new RuleViolationError('That task is already done; there is nothing to wait for', 'WAITING_ON_RESOLVED');
  // What that task waits for in turn, as far as the chain goes: back at this one would leave both blocked for good.
  if (taskId && await ports.work.waitsFor(task.id, taskId)) throw new RuleViolationError('That task is waiting for this one', 'WAITING_ON_CYCLE');
}

const waitingForOf = (value: unknown): ActorRef | null => {
  const person = valid.owner(value ?? null);
  if (person && person.kind !== 'human') throw new InvalidInputError('Only a person can be waited for');
  return person;
};

/**
 * What was waited for is resolved (#868): each blocked task that still waits for it goes back to Doing by itself (To do when a prerequisite is
 * still open, since Doing needs every prerequisite done), the stream says "#4 can continue: the decision was accepted", and its owner is
 * told once: a person in their Inbox, an agent by taking the task up again. `ids` are the tasks found under the graph lock, locked by the
 * caller; each is read again, locked, and left alone if it no longer waits. Every path that finishes a task goes through here: a person's change,
 * a decision's acceptance and a pull request's rule (#1055).
 */
export async function resumeWaiting(ports: Pick<WorkPorts, 'work' | 'events'>, principal: Principal, by: ActorRef, ids: readonly string[], stillWaits: (task: WorkRecord) => boolean,
  because: { said: string; token: 'decision' | 'work' | 'person'; taskId?: string }): Promise<void> {
  for (const id of ids) {
    const task = await ports.work.findWork(id, { lock: true });
    if (!task || task.creationRevertedAt || task.status !== 'blocked' || !stillWaits(task)) continue;
    let status: 'in_progress' | 'open' = 'in_progress';
    try { await assertPrerequisitesMet(ports.work, task.workspaceId, id); } catch (error) { if (!(error instanceof ConflictError)) throw error; status = 'open'; }
    // Leaving Blocked also clears why it was blocked (a blocker is for blocked work only).
    const record = await ports.work.updateWork(id, { status, blocker: null }, by, 'wait_resolved');
    await ports.work.insertTaskUpdate(record, { kind: 'task.resumed', by, waitingFor: null, reason: because.said });
    await ports.events.record(principal, task.workspaceId, 'project.work_updated.v1', task.projectId, { workId: id,
      ...(task.owner?.kind === 'human' ? { resumedFor: task.owner.id, reason: because.token, ...(because.taskId ? { taskId: because.taskId } : {}) } : {}) });
  }
}

function linkRows(scope: { workspaceId: string; projectId: string }, from: NewObjectLink['from'], role: NewObjectLink['role'], targets: ObjectRef[], by: ActorRef): NewObjectLink[] {
  return targets.map((to) => ({ id: randomUUID(), ...scope, role, from, to, createdBy: by }));
}

const workRefs = (ids: string[]): ObjectRef[] => ids.map((id) => ({ type: 'work', id }));

const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** A retry of the same client command: the same intent returns its stored outcome, another intent conflicts. */
function sameCommand(earlier: NativeCommandReceipt, fingerprint: string) {
  if (earlier.fingerprint !== fingerprint) throw new ConflictError('This clientCommandId was used for another command', 'IDEMPOTENCY_CONFLICT');
}
const stale = () => new ConflictError('The result of this command changed afterwards; review the current state', 'COMMAND_POSTSTATE_STALE');
const invalidPostState = () => new ConflictError('The stored outcome of this command is no longer intact', 'COMMAND_POSTSTATE_INVALID');

/** The facts of {@link creationUndoEligibility} for one task record; `lock` retains the creator agent's owner row. */
async function undoFacts(ports: WorkPorts, record: WorkRecord, lock = false): Promise<TaskCreationUndoFacts> {
  const nativeAgent = record.creationOrigin === 'native_agent' && record.createdBy.kind === 'agent';
  const prerequisites = (await ports.work.taskPlans([record.id])).get(record.id)?.prerequisites.length ?? 0;
  return { reverted: !!record.creationRevertedAt, origin: record.creationOrigin ?? null, baselineVersion: record.creationBaselineVersion ?? null,
    version: record.version, used: !!record.firstPersistedUseAt, baselineMatches: await ports.work.creationBaselineMatches(record.id), prerequisites,
    createdBy: record.createdBy, owner: record.owner, creatorAgentOwnerUserId: nativeAgent ? await ports.work.creatorAgentOwner(record.createdBy.id, { lock }) : null };
}
async function undoEligibility(ports: WorkPorts, principal: Principal, record: WorkRecord): Promise<TaskCreationUndoEligibility> {
  let canWrite = true;
  try { await ports.access.requireProject(principal, 'write', record.projectId); }
  catch (error) { if (error instanceof ForbiddenError || error instanceof NotFoundError) canWrite = false; else throw error; }
  return creationUndoEligibility(await undoFacts(ports, record), principal, canWrite);
}

export function createWorkUseCases(uow: WorkUnitOfWork) {
  async function list<T, R>(principal: Principal, projectId: string, query: PageQuery | undefined,
    read: (ports: WorkPorts, projectId: string, page: ReturnType<typeof valid.page>) => Promise<{ items: R[]; total: number }>,
    present: (ports: WorkPorts, items: R[]) => Promise<T[]>): Promise<Page<T>> {
    const window = valid.page(query);
    const project = valid.id(projectId, 'projectId');
    return uow.run(async (ports) => {
      await ports.access.requireProject(principal, 'read', project);
      const { items, total } = await read(ports, project, window);
      return { items: await present(ports, items), total, ...window };
    });
  }
  const presentWorks = async (ports: WorkPorts, items: WorkRecord[]) => { const view = await presenter(ports, items.map((i) => i.id), workActors(items), true, waitsOf(items)); return items.map(view.work); };
  const presentDecisions = async (ports: WorkPorts, items: DecisionRecord[]) => { const view = await presenter(ports, items.map((i) => i.id), decisionActors(items)); return items.map(view.decision); };

  return {
    listWork: (principal: Principal, projectId: string, query?: PageQuery) =>
      list(principal, projectId, query, (ports, project, window) => ports.work.listWork(project, window), presentWorks),
    listDecisions: (principal: Principal, projectId: string, query?: PageQuery) =>
      list(principal, projectId, query, (ports, project, window) => ports.work.listDecisions(project, window), presentDecisions),
    listTaskNotices: (principal: Principal, projectId: string, query?: PageQuery): Promise<Page<TaskCreationNotice>> =>
      list(principal, projectId, query, (ports, project, window) => ports.work.listTaskNotices(project, window), async (ports, items) => {
        const found = await ports.work.findWorks(items.map((item) => item.workId));
        const records = items.map((item) => found.get(item.workId) ?? null);
        const names = await ports.work.names([...items.map((item) => item.createdBy), ...items.flatMap((item) => item.waitingFor ? [item.waitingFor] : []), ...records.flatMap((record) => record?.creationRevertedBy ? [record.creationRevertedBy] : [])]);
        return items.map((item, index) => {
          const record = records[index];
          const { waitingFor, reason, ...notice } = item;
          return { ...notice, createdAt: iso(item.createdAt),
            ...(item.kind === 'task.blocked' ? { reason: reason ?? null, waitingFor: waitingFor ? { ...waitingFor, name: names.get(key(waitingFor)) ?? 'Former member' } : null }
              : item.kind === 'task.resumed' ? { reason: reason ?? null } : {}),
            lifecycle: record?.creationRevertedAt && record.creationRevertedBy && record.creationReversionNoticeId
              ? { state: 'creation_reverted' as const, noticeId: record.creationReversionNoticeId, revertedAt: iso(record.creationRevertedAt),
                revertedBy: { ...record.creationRevertedBy, name: names.get(key(record.creationRevertedBy)) ?? 'Former member' } }
              : { state: 'active' as const },
            createdBy: { ...item.createdBy, name: names.get(key(item.createdBy)) ?? (item.createdBy.kind === 'agent' ? 'Agent' : 'Former member') } };
        });
      }),

    /** What the conversation says about decisions (#694): the project's audience reads it, no one else. */
    listObjectNotices: (principal: Principal, projectId: string, query?: PageQuery): Promise<Page<ObjectNotice>> =>
      list(principal, projectId, query, (ports, project, window) => ports.work.listObjectNotices(project, window), async (ports, items) => {
        const names = await ports.work.names(items.map((item) => item.by));
        return items.map((item) => ({ ...item, createdAt: iso(item.createdAt),
          by: { ...item.by, name: names.get(key(item.by)) ?? (item.by.kind === 'agent' ? 'Agent' : 'Former member') } }));
      }),

    /** The caller's unfinished work across the projects of a workspace they can currently read. */
    async listAssigned(principal: Principal, workspaceId: string, query?: PageQuery): Promise<Page<WorkItem>> {
      const window = valid.page(query);
      const workspace = valid.id(workspaceId, 'workspaceId');
      const owner = actor(principal);
      return uow.run(async (ports) => {
        await ports.access.requireWorkspace(principal, workspace);
        const { items, total } = await ports.work.listAssignedVisible(principal, workspace, owner, window);
        return { items: await presentWorks(ports, items), total, ...window };
      });
    },

    getWork: (principal: Principal, workId: string) => uow.run(async (ports) => {
      const { id } = await authorized(ports, principal, 'work', workId, 'read');
      const record = (await ports.work.findWork(id))!;
      return { ...await presentWork(ports, record), creationUndo: await undoEligibility(ports, principal, record) };
    }),
    /**
     * The history of a task's status, owner, due date and title (#488), newest first: who changed it and when. It is
     * readable by exactly those who can read the task, including a task whose creation was undone.
     */
    getTaskActivity: (principal: Principal, workId: string, query?: TaskActivityQuery): Promise<TaskActivityPage> => uow.run(async (ports) => {
      const task = await authorized(ports, principal, 'work', workId, 'read');
      return readTaskActivity(ports, task, query);
    }),
    getDecision: (principal: Principal, decisionId: string) => uow.run(async (ports) => {
      const { id } = await authorized(ports, principal, 'decision', decisionId, 'read');
      return presentDecision(ports, (await ports.work.findDecision(id))!);
    }),

    async undoTaskCreation(principal: Principal, workId: string, command: UndoTaskCreationCommand): Promise<UndoTaskCreationResult> {
      const by = actor(principal);
      const commandId = valid.id(command?.clientCommandId, 'clientCommandId');
      const version = valid.expectedVersion(command?.expectedVersion);
      return uow.run(async (ports) => {
        const { id, projectId, workspaceId } = await authorized(ports, principal, 'work', workId, 'write');
        const located = (await ports.work.findWork(id))!;
        await undoFacts(ports, located, true); // Retain the current creator-agent ownership before graph/task locks.
        const fingerprint = sha256({ operation: 'work.creation.revert', workId: id, expectedVersion: version });
        const earlier = await ports.work.creationUndoReceipt(projectId, by, commandId);
        if (earlier && (earlier.fingerprint !== fingerprint || earlier.workId !== id)) throw new ConflictError('This clientCommandId was used for another creation Undo', 'IDEMPOTENCY_CONFLICT');
        // Same graph/task serialization point as every first persisted use. No use latch on Undo or replay.
        await lockProjectGraphs(ports.work, [projectId]);
        await ports.work.lockTasks(workspaceId, [id]);
        const current = (await ports.work.findWork(id))!;
        if (!mayUndoTaskCreation(await undoFacts(ports, current), principal)) throw new ForbiddenError('You cannot undo this task creation', 'TASK_CREATION_UNDO_FORBIDDEN');
        if (earlier) {
          if (!current.creationRevertedAt || current.creationReversionNoticeId !== earlier.noticeId) throw invalidPostState();
          return { work: await presentWork(ports, current), noticeId: earlier.noticeId, clientCommandId: commandId };
        }
        const eligibility = await undoEligibility(ports, principal, current);
        if (!eligibility.eligible) throw new ConflictError('Task creation cannot be undone', eligibility.reason === 'eligibility_unknown' ? 'TASK_CREATION_ELIGIBILITY_UNKNOWN' : 'TASK_CREATION_UNDO_REFUSED');
        if (current.version !== version) throw new VersionConflictError(current.version, await presentWork(ports, current));
        const result = await ports.work.revertCreation(current, by, commandId, fingerprint);
        await ports.events.record(principal, workspaceId, 'project.work_updated.v1', projectId, { workId: id, taskNoticeId: result.noticeId, lifecycle: 'creation_reverted' });
        return { work: await presentWork(ports, result.work), noticeId: result.noticeId, clientCommandId: commandId };
      });
    },

    /**
     * Creates work in one action, e.g. from a message; the source is linked and stays where it is. With
     * `criteria`, `dependencyIds` and a `planIntent` it is the one native planning command for people,
     * the API and (later) agents; see the lock order at the top of this file.
     */
    async createWork(principal: Principal, projectId: string, command: CreateWorkCommand): Promise<WorkItem> {
      const by = actor(principal);
      if (!command || typeof command !== 'object') throw new InvalidInputError('Work item is required');
      const project = valid.id(projectId, 'projectId');
      const title = valid.title(command.title);
      const outcome = valid.text(command.outcome, 'outcome', WORK_LIMITS.outcome);
      const status = command.status === undefined ? 'open' : valid.status(command.status);
      const blocker = command.blocker === undefined || command.blocker === '' ? null : valid.text(command.blocker, 'blocker', WORK_LIMITS.blocker) || null;
      if (blocker && status !== 'blocked') throw new InvalidInputError('A blocker applies to blocked work only');
      const owner = command.owner === undefined ? null : valid.owner(command.owner);
      const waitingFor = waitingForOf(command.waitingFor);
      if (waitingFor && status !== 'blocked') throw new InvalidInputError('A person to wait for applies to blocked work only');
      const waitingOn = command.waitingOn === undefined ? null : valid.waitingOn(command.waitingOn);
      if (waitingOn && waitingFor) throw new InvalidInputError('A task waits for one thing');
      if (waitingOn && status !== 'blocked') throw new InvalidInputError('Something to wait for applies to blocked work only');
      const dueOn = valid.dueOn(command.dueOn ?? null);
      const sources = valid.refs(command.sources, valid.SOURCE_TYPES, 'sources');
      const related = valid.refs(command.related, valid.ANY_TYPES, 'related');
      const criteria = valid.criteria(command.criteria);
      const dependencyIds = valid.dependencyIds(command.dependencyIds);
      const planIntent = valid.planIntent(command.planIntent);
      // #841: a subtask is part of one task of this space; the parent does not wait for it.
      const parent: ObjectRef[] = command.parentId === undefined ? [] : [{ type: 'work', id: valid.id(command.parentId, 'parentId') }];
      const clientCommandId = command.clientCommandId === undefined ? undefined : valid.id(command.clientCommandId, 'clientCommandId');
      // The retry fingerprint holds the plan fields only when present. The intent fingerprint is the canonical creation,
      // without retry identity.
      const plan = { ...(criteria.length ? { criteria } : {}), ...(dependencyIds.length ? { dependencyIds } : {}), ...(planIntent ? { planIntent } : {}), ...(parent.length ? { parentId: parent[0]!.id } : {}) };
      const requestFingerprint = clientCommandId ? createHash('sha256').update(JSON.stringify({ title, outcome, status, blocker, owner, ...(waitingFor ? { waitingFor } : {}), ...(waitingOn ? { waitingOn } : {}), ...(dueOn ? { dueOn } : {}), sources, related, ...plan })).digest('hex') : undefined;
      const intentFingerprint = planIntent ? creationFingerprint({ title, outcome, status, blocker, owner, dueOn, sources, related, criteria, dependencyIds }) : undefined;
      return uow.run(async (ports) => {
        const { workspaceId } = await ports.access.requireProject(principal, 'write', project, { lock: true });
        // The plan material's row lock precedes the command identity and the graph lock, like every source.
        if (planIntent) {
          const source = await ports.work.lockPlanSource(workspaceId, project, planIntent.materialId);
          if (!source) throw new RuleViolationError('The plan source is not part of this space', 'PLAN_SOURCE_NOT_FOUND');
          if (source.currentVersion !== planIntent.version) {
            const error = new ConflictError('The plan changed since this revision; read it again before creating tasks', 'SOURCE_VERSION_CONFLICT');
            error.details = { materialId: planIntent.materialId, requestedVersion: planIntent.version, currentVersion: source.currentVersion };
            throw error;
          }
        }
        if (clientCommandId) {
          const earlier = await ports.work.createdWork(project, by, clientCommandId);
          if (earlier) {
            if (earlier.fingerprint !== requestFingerprint) throw new ConflictError('This clientCommandId was used for another task creation', 'IDEMPOTENCY_CONFLICT');
            if (earlier.work.creationRevertedAt) throw new ConflictError('Task creation was undone; open its history', 'TASK_CREATION_REVERTED');
            return presentWork(ports, earlier.work);
          }
        }
        await requireOwner(ports, project, owner, principal);
        await requireWaitingFor(ports, project, waitingFor);
        await requireTargets(ports, project, [...sources, ...related, ...parent]);
        await lockProjectGraphs(ports.work, [project]);
        await requireTargets(ports, project, [...sources, ...related, ...parent]);
        if (waitingOn) await requireWaitingOn(ports, project, null, waitingOn);
        if (planIntent) {
          const existing = await ports.work.findPlanIntent(project, planIntent);
          const produced = existing ? await ports.work.findWork(existing.taskId, { lock: true }) : null;
          const decision = decidePlanIntent(existing, intentFingerprint!, produced);
          // The same canonical creation of an unchanged task: the original task, actor and times, no new notice or event.
          if (decision.kind === 'replay') return presentWork(ports, produced!);
        }
        await requireDependencyTargets(ports, project, dependencyIds);
        // A task that something waits for is in use (#868): its creation can no longer be undone from under the one that waits.
        const existingTargets = [...new Set([...dependencyIds, ...(waitingOn?.kind === 'task' ? [waitingOn.id] : []), ...await ports.work.taskUseTargets([...sources, ...related, ...parent])])].sort();
        const useFence = await ports.work.lockPreparedTaskUse(existingTargets);
        requireDependencyScope(useFence.projectIds, project);

        const scope = { workspaceId, projectId: project };
        const record = await ports.work.insertWork({ id: randomUUID(), ...scope, title, outcome, status, blocker, waitingFor, waitingOn, dueOn, owner, createdBy: by, criteria, clientCommandId, requestFingerprint });
        // A brand-new task cannot be anyone's prerequisite yet, so these edges cannot close a cycle.
        if (dependencyIds.length) {
          await ports.work.replaceDependencies(scope, record.id, dependencyIds);
          if (ELIGIBLE_STATUSES.has(status)) await assertPrerequisitesMet(ports.work, workspaceId, record.id);
        }
        if (planIntent) await ports.work.insertPlanIntent(scope, planIntent, { taskId: record.id, fingerprint: intentFingerprint!, taskVersion: record.version });
        const from = { type: 'work' as const, id: record.id };
        await ports.work.insertLinks([...linkRows(scope, from, 'source', sources, by), ...linkRows(scope, from, 'related', related, by), ...linkRows(scope, from, 'part_of', parent, by)]);
        await ports.work.insertCreationNotice(record, sources);
        await useFence.mark();
        await ports.work.recordCreationBaseline(record);
        const fresh = (await ports.work.findWork(record.id))!;
        const view = { ...await presentWork(ports, fresh), creationUndo: await undoEligibility(ports, principal, fresh) };
        // `assignedTo` names a person given this work by someone else (notifications, #116).
        const assignedTo = owner?.kind === 'human' && owner.id !== by.id ? owner.id : undefined;
        await ports.events.record(principal, workspaceId, 'project.work_created.v1', project, { workId: record.id, ...(assignedTo ? { assignedTo } : {}), ...(waitingFor ? { waitingFor: waitingFor.id } : {}) });
        return view;
      });
    },

    /**
     * Changes a task at the version its author saw. A nonempty explicitly saved blocker is also one authored
     * contribution to the task's canonical thread, with exactly the saved text, in the same unit; clearing a
     * blocker or changing only status/owner/text contributes nothing. With `clientCommandId` an exact retry
     * returns the original outcome without contributing again.
     */
    async updateWork(principal: Principal, workId: string, command: UpdateWorkCommand, expected: number | undefined, via?: TaskChangeVia,
      /** `endsClientHold`: a person's change of Owner in Details also ends the units of a local client that held the task (#985). */
      options: { endsClientHold?: boolean } = {}): Promise<WorkItem> {
      const by = actor(principal);
      if (!command || typeof command !== 'object') throw new InvalidInputError('Change is required');
      if ((command as { planIntent?: unknown }).planIntent !== undefined) throw new InvalidInputError('A task keeps the plan intent it was created with', 'PLAN_INTENT_IMMUTABLE');
      const version = valid.expectedVersion(expected);
      const clientCommandId = command.clientCommandId === undefined ? undefined : valid.id(command.clientCommandId, 'clientCommandId');
      const changes: WorkChanges = {};
      if (command.title !== undefined) changes.title = valid.title(command.title);
      if (command.outcome !== undefined) changes.outcome = valid.text(command.outcome, 'outcome', WORK_LIMITS.outcome);
      if (command.status !== undefined) changes.status = valid.status(command.status);
      if (command.owner !== undefined) changes.owner = valid.owner(command.owner);
      if (command.blocker !== undefined) changes.blocker = command.blocker === null || command.blocker === '' ? null : valid.text(command.blocker, 'blocker', WORK_LIMITS.blocker) || null;
      if (command.waitingFor !== undefined) changes.waitingFor = waitingForOf(command.waitingFor);
      if (command.waitingOn !== undefined) changes.waitingOn = valid.waitingOn(command.waitingOn);
      if (changes.waitingFor && changes.waitingOn) throw new InvalidInputError('A task waits for one thing');
      if (command.dropped !== undefined) {
        if (typeof command.dropped !== 'boolean') throw new InvalidInputError('dropped must be true or false');
        changes.dropped = command.dropped;
      }
      if (command.cameOfIt !== undefined) changes.cameOfIt = valid.cameOfIt(command.cameOfIt);
      if (command.dueOn !== undefined) changes.dueOn = valid.dueOn(command.dueOn);
      if (command.restore !== undefined && command.restore !== true) throw new InvalidInputError('restore can only be true');
      if (command.criteria !== undefined) changes.criteria = valid.criteria(command.criteria);
      const dependencyIds = command.dependencyIds === undefined ? undefined : valid.dependencyIds(command.dependencyIds);
      if (!Object.keys(changes).length && dependencyIds === undefined) throw new InvalidInputError('Nothing to change');
      // Status and blocker are what a GitHub rule moves; changing either, also to the same value, overrides it.
      const overrides = command.status !== undefined || command.blocker !== undefined;
      const ruleRevision = command.expectedGithubRuleRevision;
      if (ruleRevision !== undefined && (!Number.isSafeInteger(ruleRevision) || ruleRevision < 0)) throw new InvalidInputError('expectedGithubRuleRevision must be a non-negative integer');
      // The exact text the person explicitly saved; undefined/cleared/empty contribute nothing.
      // An Undo puts back what was there: it never authors the same blocker again.
      const savedBlocker = command.restore ? null : changes.blocker || null;
      // The one line at Done is also written in the task's discussion, as what came of it (#868); an Undo puts the line back without writing it again.
      const savedCameOfIt = command.restore ? null : changes.cameOfIt || null;
      return uow.run(async (ports) => {
        const { id, projectId, workspaceId } = await authorized(ports, principal, 'work', workId, 'write');
        if (dependencyIds?.includes(id)) throw new RuleViolationError('A task cannot depend on itself', 'TASK_SELF_DEPENDENCY');
        // Prerequisites are a set: their order is not part of the intent.
        const fingerprint = sha256({ operation: 'work.update', workId: id, expectedVersion: version, changes, ...(command.restore ? { restore: true } : {}),
          ...(ruleRevision !== undefined ? { expectedGithubRuleRevision: ruleRevision } : {}),
          ...(dependencyIds !== undefined ? { dependencyIds: [...dependencyIds].sort() } : {}) });
        if (clientCommandId) {
          // The command identity precedes every other lock below. An exact retry rechecks the current
          // authorization (above), the produced task state and the stored contributions, and writes nothing.
          const earlier = await ports.work.nativeCommand(projectId, by, 'work.update', clientCommandId);
          if (earlier) {
            sameCommand(earlier, fingerprint);
            const current = await ports.work.findWork(id);
            if (!current || earlier.object.type !== 'work' || current.version !== earlier.object.version) throw stale();
            if (!await ports.contributions.confirm(principal, projectId, earlier.messageIds)) throw invalidPostState();
            return presentWork(ports, current);
          }
        }
        // A blocker is for blocked work and the line for done work, so a command has at most one of the two.
        const contribution = savedBlocker || savedCameOfIt ? await ports.contributions.prepare(principal, projectId,
          { operation: 'work.update', commandId: clientCommandId ?? randomUUID() },
          [savedBlocker ? { workId: id, kind: 'blocker', body: savedBlocker } : { workId: id, kind: 'came_of_it', body: savedCameOfIt! }]) : null;
        // A person taking the task from an agent also ends a local client's hold (#936, #985). Claims take the agent's connection slots
        // before the graph and the task, so they are taken first here too. The owner is read without a lock: if it changes before the
        // task is locked, the version check below refuses the change.
        const takenFrom = options.endsClientHold && by.kind === 'human' && changes.owner !== undefined && ports.work.lockAgentSlots
          ? (await ports.work.findWork(id))?.owner : null;
        const heldBy = takenFrom?.kind === 'agent' && !sameOwner(takenFrom, changes.owner ?? null) ? takenFrom.id : null;
        if (heldBy) await ports.work.lockAgentSlots!(workspaceId, heldBy);
        // Replacing prerequisites, or starting/finishing a task, is a graph writer: graph lock (after the command
        // and message identities above), then every task it reads in one ascending pass (itself and the
        // prerequisites it will have).
        await lockProjectGraphs(ports.work, [projectId]);
        if (dependencyIds !== undefined) await requireDependencyTargets(ports, projectId, dependencyIds);
        const previous = await directPrerequisiteIds(ports.work, workspaceId, [id]);
        // Finishing a task resumes the tasks that wait for it (#868): they are found under the graph lock and locked with it.
        const waiters = changes.status === 'done' ? await ports.work.waiters({ kind: 'task', id }) : [];
        // A task that something waits for is in use (#868). One that is not a task of this space is left out here and refused below, with its own reason.
        const waitTarget = changes.waitingOn?.kind === 'task' ? await ports.work.findWork(changes.waitingOn.id) : null;
        const waitedFor = waitTarget && waitTarget.projectId === projectId && !waitTarget.creationRevertedAt ? [waitTarget.id] : [];
        const used = [...new Set([id, ...previous, ...(dependencyIds ?? []), ...waitedFor])].sort();
        const useFence = await ports.work.lockPreparedTaskUse([...new Set([...used, ...waiters])].sort());
        requireDependencyScope(useFence.projectIds, projectId);
        const current = contribution ? (await ports.contributions.lockTasks(contribution))[0]! : (await ports.work.findWork(id))!;
        if (current.version !== version) throw new VersionConflictError(current.version, await presentWork(ports, current));
        if (ruleRevision !== undefined && ((await ports.work.githubRules([id])).get(id)?.revision ?? 0) !== ruleRevision)
          throw new VersionConflictError(current.version, await presentWork(ports, current));
        const nextStatus = changes.status ?? current.status;
        if (nextStatus !== 'blocked') {
          if (changes.blocker) throw new InvalidInputError('A blocker applies to blocked work only');
          changes.blocker = null;
          if (changes.waitingFor || changes.waitingOn) throw new InvalidInputError('Something to wait for applies to blocked work only');
          changes.waitingFor = null;
          changes.waitingOn = null;
        } else if (changes.waitingFor !== undefined || changes.waitingOn !== undefined) {
          // A task waits for one thing: naming one clears the other, and clearing one leaves what the task still waits for.
          const person = changes.waitingFor !== undefined ? changes.waitingFor : changes.waitingOn ? null : current.waitingFor;
          const thing = changes.waitingOn !== undefined ? changes.waitingOn : changes.waitingFor ? null : current.waitingOn;
          changes.waitingFor = person;
          changes.waitingOn = thing;
        }
        if (nextStatus !== 'done') {
          if (changes.dropped || changes.cameOfIt) throw new InvalidInputError('"Dropped" and "what came of it" apply to done work only');
          delete changes.dropped;
          delete changes.cameOfIt;
        }
        if (changes.owner !== undefined && !sameOwner(current.owner, changes.owner)) await requireOwner(ports, projectId, changes.owner, principal);
        if (changes.waitingFor) await requireWaitingFor(ports, projectId, changes.waitingFor);
        if (changes.waitingOn && !(current.waitingOn?.kind === changes.waitingOn.kind && current.waitingOn.id === changes.waitingOn.id))
          await requireWaitingOn(ports, projectId, id, changes.waitingOn);
        if (dependencyIds !== undefined) await assertNoDependencyCycle(ports.work, workspaceId, id, dependencyIds);
        const record = await ports.work.updateWork(id, changes, by, via);
        if (heldBy && current.owner?.kind === 'agent' && current.owner.id === heldBy) {
          const ended = await ports.work.endAgentHold?.({ workspaceId, projectId, taskId: id, agentId: heldBy, stoppedBy: principal.id });
          // As for Stop: the project's readers and the agent's owner are told who stopped it (AG-5).
          if (ended) await ports.events.record(principal, workspaceId, 'project.agent_stopped.v1', projectId, { stopId: ended.stopId, taskId: id, agentId: heldBy });
        }
        // A person's override suspends the task's rule now, not at the next delivery. Finishing work leaves it: a rule
        // never acts on finished work, and its one-tap Done is how "Ready to close" ends.
        if (overrides && !FINISHED.has(nextStatus)) await ports.work.suspendGithubRule({ id, fromStatus: current.status, status: record.status, version: record.version });
        if (dependencyIds !== undefined) await ports.work.replaceDependencies({ workspaceId, projectId }, id, dependencyIds);
        // The tasks that waited for this one can continue now that it is done (#868).
        if (record.status === 'done' && current.status !== 'done' && waiters.length)
          await resumeWaiting(ports, principal, by, waiters, (task) => task.waitingOn?.kind === 'task' && task.waitingOn.id === id,
            { said: `#${record.number} ${record.dropped ? 'was dropped' : 'is done'}`, token: 'work', taskId: id });
        // It starts or finishes only with every prerequisite done, and keeps that while it
        // is active. The check reads the edges as just replaced; a failure rolls back the whole change.
        if (ELIGIBLE_STATUSES.has(nextStatus) && (dependencyIds !== undefined || nextStatus !== current.status)) await assertPrerequisitesMet(ports.work, workspaceId, id);
        await useFence.mark(used);
        const view = await presentWork(ports, record);
        const newOwner = changes.owner;
        const assignedTo = newOwner?.kind === 'human' && newOwner.id !== principal.id
          && !(current.owner?.kind === 'human' && current.owner.id === newOwner.id) ? newOwner.id : undefined;
        // Naming a person to wait for tells them once; an Undo that puts the same name back does not tell them again.
        const newlyWaitedOn = record.waitingFor && record.waitingFor.id !== current.waitingFor?.id && !command.restore ? record.waitingFor.id : undefined;
        await ports.events.record(principal, workspaceId, 'project.work_updated.v1', projectId, { workId: id, ...(assignedTo ? { assignedTo } : {}), ...(newlyWaitedOn ? { waitingFor: newlyWaitedOn } : {}) });
        // One short line in the project conversation when a task becomes blocked or unblocked; not for edits of the reason alone.
        if ((current.status === 'blocked') !== (record.status === 'blocked')) {
          // A task that waits for a decision or a task says so in the line, as the card does: "waiting for #7".
          const waitedOn = record.status === 'blocked' && record.waitingOn ? (await ports.work.waitingTargets([record.waitingOn])).get(`${record.waitingOn.kind}:${record.waitingOn.id}`) : undefined;
          await ports.work.insertTaskUpdate(record, { kind: record.status === 'blocked' ? 'task.blocked' : 'task.unblocked', by,
            waitingFor: record.waitingFor, reason: record.status === 'blocked' ? (waitedOn ? `waiting for ${waitingPhrase(waitedOn)}` : record.blocker) : null });
        }
        const messageIds = contribution ? await ports.contributions.append(contribution) : [];
        if (clientCommandId) await ports.work.recordNativeCommand({ workspaceId, projectId }, by,
          { operation: 'work.update', commandId: clientCommandId, fingerprint, object: { type: 'work', id, version: record.version }, messageIds });
        return view;
      });
    },

    /**
     * The person a blocked task waits for says they are done (#868): the task goes back to Doing by itself, the stream says "#4 can continue:
     * Jonas is done" and its owner is told. Only that person can, and reading the space is enough: they may be asked for something without
     * being able to change the task otherwise. A stale version is a conflict, and a task that no longer waits for them is a 409.
     */
    async resolveWaiting(principal: Principal, workId: string, expected: number | undefined): Promise<WorkItem> {
      const by = actor(principal);
      if (by.kind !== 'human') throw new ForbiddenError('Only the person a task waits for can say they are done', 'WAITING_DONE_NEEDS_PERSON');
      const version = valid.expectedVersion(expected);
      return uow.run(async (ports) => {
        const { id, projectId } = await authorized(ports, principal, 'work', workId, 'read');
        await lockProjectGraphs(ports.work, [projectId]);
        await ports.work.lockPreparedTaskUse([id]);
        const current = await ports.work.findWork(id, { lock: true });
        if (!current) throw notFound('work');
        if (current.version !== version) throw new VersionConflictError(current.version, await presentWork(ports, current));
        if (current.status !== 'blocked' || current.waitingFor?.id !== by.id) throw new ConflictError('This task no longer waits for you', 'NOT_WAITING_FOR_YOU');
        const name = (await ports.work.names([by])).get(key(by)) ?? 'Someone';
        await resumeWaiting(ports, principal, by, [id], (task) => task.waitingFor?.id === by.id, { said: `${name} is done`, token: 'person' });
        return presentWork(ports, (await ports.work.findWork(id))!);
      });
    },

    /** People and agents may propose; the proposal names its sources and the work it affects. */
    async proposeDecision(principal: Principal, projectId: string, command: ProposeDecisionCommand): Promise<Decision> {
      const by = actor(principal);
      if (!command || typeof command !== 'object') throw new InvalidInputError('Decision is required');
      const project = valid.id(projectId, 'projectId');
      const title = valid.title(command.title);
      const rationale = valid.text(command.rationale, 'rationale', WORK_LIMITS.rationale);
      const supersedes = command.supersedes === undefined ? null : valid.id(command.supersedes, 'supersedes');
      const sources = valid.refs(command.sources, valid.SOURCE_TYPES, 'sources');
      const affects = workRefs(valid.ids(command.affects, 'affects'));
      return uow.run(async (ports) => {
        const { workspaceId } = await ports.access.requireProject(principal, 'write', project, { lock: true });
        if (supersedes) {
          const earlier = await ports.work.findDecision(supersedes);
          if (!earlier || earlier.projectId !== project || earlier.status !== 'accepted')
            throw new RuleViolationError('Only an accepted decision of this space can be superseded', 'SUPERSEDES_NOT_CURRENT');
        }
        await requireTargets(ports, project, [...sources, ...affects]);
        await lockProjectGraphs(ports.work, [project]);
        await requireTargets(ports, project, [...sources, ...affects]);
        const useFence = await ports.work.lockPreparedTaskUse(sortedIds([...affects.map((ref) => ref.id), ...await ports.work.taskUseTargets(sources)], 'taskIds'));
        const scope = { workspaceId, projectId: project };
        const record = await ports.work.insertDecision({ id: randomUUID(), ...scope, title, rationale, proposedBy: by, supersedesId: supersedes });
        const from = { type: 'decision' as const, id: record.id };
        await ports.work.insertLinks([...linkRows(scope, from, 'source', sources, by), ...linkRows(scope, from, 'affects', affects, by)]);
        await ports.work.artifactUsed?.(scope,{kind:'decision',id:record.id,revision:`${record.version}:${record.status}`},useFence);
        await useFence.mark();
        const view = await presentDecision(ports, record);
        await ports.events.record(principal, workspaceId, 'project.decision_proposed.v1', project, { decisionId: record.id });
        return view;
      });
    },

    /**
     * A person with write access accepts a proposal. If it replaces an accepted decision, the earlier one is
     * marked superseded (kept, with its rationale). Nothing else changes: no task is moved (#871).
     */
    async acceptDecision(principal: Principal, decisionId: string, expected: number | undefined): Promise<Decision> {
      const by = actor(principal);
      const version = valid.expectedVersion(expected);
      return uow.run(async (ports) => {
        const { id, projectId, workspaceId } = await authorized(ports, principal, 'decision', decisionId, 'write');
        if (by.kind !== 'human') throw new ForbiddenError('Only a person can accept a decision; agents can propose', 'DECISION_NEEDS_PERSON');
        // The assistant's Undo may take back a proposal it made, until it is accepted: gone before or while this waits for the graph is a 404.
        const located = await ports.work.findDecision(id);
        if (!located) throw notFound('decision');
        await lockProjectGraphs(ports.work, [projectId]);
        // The tasks that wait for this decision (#868) go back to Doing below: found under the graph lock, locked with the others.
        const waiters = await ports.work.waiters({ kind: 'decision', id });
        const used = sortedIds(await ports.work.taskUseTargets([{ type: 'decision', id },...(located.supersedesId?[{type:'decision' as const,id:located.supersedesId}]:[])]), 'taskIds');
        const useFence = await ports.work.lockPreparedTaskUse(sortedIds([...used, ...waiters], 'taskIds'));
        const decisionRows = new Map<string, DecisionRecord>();
        for (const decisionId of [...new Set([id, ...(located.supersedesId ? [located.supersedesId] : [])])].sort()) {
          const retained = await ports.work.findDecision(decisionId, { lock: true });
          if (retained) decisionRows.set(decisionId, retained);
        }
        const current = decisionRows.get(id);
        if (!current) throw notFound('decision');
        if (current.version !== version) throw new VersionConflictError(current.version, await presentDecision(ports, current));
        if (current.status !== 'proposed') throw new ConflictError('This decision is no longer a proposal', 'DECISION_NOT_PROPOSED');
        const now = new Date();
        if (current.supersedesId) {
          const earlier = decisionRows.get(current.supersedesId);
          if (!earlier || earlier.status !== 'accepted')
            throw new ConflictError('The decision this one replaces has changed; check it again', 'SUPERSEDED_DECISION_CHANGED');
          const superseded=await ports.work.updateDecision(earlier.id, { status: 'superseded', supersededById: id, supersededAt: now });
          await ports.work.artifactUsed?.({workspaceId,projectId},{kind:'decision',id:superseded.id,revision:`${superseded.version}:${superseded.status}`},useFence);
        }
        const record = await ports.work.updateDecision(id, { status: 'accepted', decidedBy: by.id, decidedAt: now });
        const scope = { workspaceId, projectId };
        await ports.work.artifactUsed?.(scope,{kind:'decision',id:record.id,revision:`${record.version}:${record.status}`},useFence);
        await useFence.mark(used);
        await resumeWaiting(ports, principal, by, waiters, (task) => task.waitingOn?.kind === 'decision' && task.waitingOn.id === id, { said: 'the decision was accepted', token: 'decision' });
        const view = await presentDecision(ports, record);
        await ports.events.record(principal, workspaceId, 'project.decision_accepted.v1', projectId, { decisionId: id });
        return view;
      });
    },

    /** Connects a work item or decision to anything else in the project. */
    async createLink(principal: Principal, projectId: string, command: CreateObjectLinkCommand): Promise<ObjectLink> {
      const by = actor(principal);
      if (!command || typeof command !== 'object') throw new InvalidInputError('Link is required');
      const project = valid.id(projectId, 'projectId');
      const from = valid.ref(command.from, ['work', 'decision'], 'from') as { type: WorkObjectType; id: string };
      const to = valid.ref(command.to, valid.ANY_TYPES, 'to');
      if (from.type === to.type && from.id === to.id) throw new InvalidInputError('An object cannot link to itself');
      return uow.run(async (ports) => {
        const { workspaceId } = await ports.access.requireProject(principal, 'write', project, { lock: true });
        await requireTargets(ports, project, [from, to]);
        await lockProjectGraphs(ports.work, [project]);
        await requireTargets(ports, project, [from, to]);
        const useFence = await ports.work.lockPreparedTaskUse(await ports.work.taskUseTargets([from, to]));
        const inserted = await ports.work.insertLinks(linkRows({ workspaceId, projectId: project }, from, 'related', [to], by));
        const link = (await ports.work.links([from.id])).find((item) => item.fromId === from.id && item.role === 'related' && item.toId === to.id
          && (to.type !== 'material' || item.toVersion === to.version));
        if (!link) throw new Error('Link was not stored');
        if (inserted.length) await useFence.mark();
        const titles = await ports.work.titles(project, [from, to]);
        if (inserted.length) await ports.events.record(principal, workspaceId, 'project.link_created.v1', project, { from: from.id });
        return { id: link.id, projectId: project, role: link.role, from, to, fromTitle: titles.get(valid.refKey(from))?.title ?? '',
          toTitle: titles.get(valid.refKey(to))?.title ?? '', conversationId: titles.get(valid.refKey(to))?.conversationId ?? null,
          sketchId: titles.get(valid.refKey(to))?.sketchId ?? null, createdAt: iso(link.createdAt) };
      });
    },
  };
}
