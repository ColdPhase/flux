import { createHash, randomUUID } from 'node:crypto';
import {
  WORK_LIMITS,
  type AcceptDecisionCommand,
  type CreateObjectLinkCommand,
  type CreateResultCommand,
  type CreateWorkCommand,
  type Decision,
  type NamedPrincipal,
  type ObjectLink,
  type ObjectRef,
  type Page,
  type PageQuery,
  type ProposeDecisionCommand,
  type UpdateWorkCommand,
  type WorkItem,
  type WorkObjectType,
  type WorkResult,
  type TaskCreationNotice,
} from '@flux/contracts';
import { ConflictError, ForbiddenError, InvalidInputError, NotFoundError, RuleViolationError, VersionConflictError } from '../access/errors.js';
import type { Principal } from '../principal.js';
import type { ActorRef, DecisionRecord, NativeCommandReceipt, ObjectLinkRecord, NewObjectLink, ResultRecord, TaskPlanRecord, WorkChanges, WorkPorts, WorkRecord, WorkRepository, WorkUnitOfWork } from './ports.js';
import { assertNoDependencyCycle, assertPrerequisitesMet, creationFingerprint, decidePlanIntent, directPrerequisiteIds, ELIGIBLE_STATUSES,
  lockProjectGraphs, sortedIds } from './task-graph.js';
import * as valid from './validation.js';
import { presentGithubRule, type GithubRuleReading } from '../github/rules.js';

// Work, decision and result use cases (issue #101). Each runs in one unit of work: it asks the
// access port first (reads: project read; changes: project write with the access rows locked),
// then checks versions and references, changes rows and records exactly one project event, so
// the decision, the change and the stream event commit together.
//
// Rules: agents act through their #29 project grants and may create work and results and
// propose decisions; only a person accepts a decision. Accepting a decision that supersedes an
// earlier one is a pivot: the earlier decision is kept as superseded, work that still applies
// is linked to the new decision and obsolete work is parked, keeping its status.
//
// Task plans (#152): a task carries criteria, direct same-project prerequisites and an optional
// immutable plan intent. Writers that touch the graph or an intent take their locks in one order:
// project access rows -> the plan material row -> the command identity -> the project task-graph lock
// -> the complete task rows in ascending id -> everything else. Starting or finishing a task needs every
// prerequisite done and unparked. Nothing infers that listed criteria are satisfied.
//
// Explicit effects on a task's canonical thread (#154): an explicitly saved nonempty blocker and a
// published result contribute through the mandatory `ports.contributions` hook, inside the same unit
// of work, in that same order: the command's durable identity is the native receipt and then every
// derived message identity (sorted), before the graph lock; the complete sorted task set (the linked
// tasks together with the prerequisites a finishing task reads, in ONE ascending pass) precedes the
// domain writes, the canonical appends, the receipt, and the events last (one final batch owned by the
// caller's unit of work).

const LABEL: Record<WorkObjectType, string> = { work: 'Work item', decision: 'Decision', result: 'Result' };
const CODE: Record<WorkObjectType, string> = { work: 'WORK_NOT_FOUND', decision: 'DECISION_NOT_FOUND', result: 'RESULT_NOT_FOUND' };
const FINISHED = new Set(['done', 'not_pursued']);

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
export async function linkReader(repo: WorkRepository, ids: string[]): Promise<(id: string) => ObjectLink[]> {
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
async function presenter(ports: WorkPorts, ids: string[], actors: (ActorRef | null)[], plans = false) {
  const rules = plans && ids.length ? await ports.work.githubRules(ids) : new Map<string, GithubRuleReading>();
  const ruleAuthors = [...rules.values()].flatMap((rule): ActorRef[] => rule.authorUserId ? [{ kind: 'human', id: rule.authorUserId }] : []);
  const [linksOf, names, planOf] = await Promise.all([
    linkReader(ports.work, ids),
    ports.work.names([...actors.filter((item): item is ActorRef => item !== null), ...ruleAuthors]),
    plans && ids.length ? ports.work.taskPlans(ids) : Promise.resolve(new Map<string, TaskPlanRecord>()),
  ]);
  const named = (ref: ActorRef): NamedPrincipal => ({ ...ref, name: names.get(key(ref)) ?? (ref.kind === 'agent' ? 'Agent' : 'Former member') });
  const base = (record: { id: string; projectId: string; workspaceId: string; createdAt: Date }) => ({
    id: record.id, projectId: record.projectId, workspaceId: record.workspaceId,
    audience: { kind: 'project' as const, projectId: record.projectId }, links: linksOf(record.id), createdAt: iso(record.createdAt),
  });
  const githubRule = (record: WorkRecord): WorkItem['githubRule'] => {
    const rule = rules.get(record.id);
    return rule ? { ...presentGithubRule(rule, { ...record, parked: !!record.parked }),
      setUpBy: rule.authorUserId ? named({ kind: 'human', id: rule.authorUserId }) : null } : null;
  };
  return {
    work: (record: WorkRecord): WorkItem => {
      const plan = planOf.get(record.id) ?? NO_PLAN;
      return {
        ...base(record), number: record.number, title: record.title, outcome: record.outcome, criteria: record.criteria, status: record.status, blocker: record.blocker,
        dependencyIds: plan.prerequisites.map((item) => item.id),
        prerequisites: plan.prerequisites.map((item) => ({ ...item, met: item.status === 'done' && !item.parked })),
        planIntent: plan.planIntent,
        owner: record.owner ? named(record.owner) : null,
        parked: record.parked ? { decisionId: record.parked.decisionId, at: iso(record.parked.at) } : null,
        createdBy: named(record.createdBy), githubRule: githubRule(record), version: record.version, updatedAt: iso(record.updatedAt),
      };
    },
    decision: (record: DecisionRecord): Decision => ({
      ...base(record), title: record.title, rationale: record.rationale, status: record.status,
      proposedBy: named(record.proposedBy), decidedBy: record.decidedBy ? named({ kind: 'human', id: record.decidedBy }) : null,
      decidedAt: record.decidedAt ? iso(record.decidedAt) : null, supersedes: record.supersedesId, supersededBy: record.supersededById,
      supersededAt: record.supersededAt ? iso(record.supersededAt) : null, version: record.version, updatedAt: iso(record.updatedAt),
    }),
    result: (record: ResultRecord): WorkResult => ({
      ...base(record), title: record.title, finding: record.finding, evidence: record.evidence, createdBy: named(record.createdBy),
    }),
  };
}

const workActors = (records: WorkRecord[]) => records.flatMap((record) => [record.owner, record.createdBy]);
const decisionActors = (records: DecisionRecord[]) => records.flatMap((record) => [record.proposedBy, record.decidedBy ? { kind: 'human' as const, id: record.decidedBy } : null]);

async function presentWork(ports: WorkPorts, record: WorkRecord) {
  return (await presenter(ports, [record.id], workActors([record]), true)).work(record);
}
async function presentDecision(ports: WorkPorts, record: DecisionRecord) {
  return (await presenter(ports, [record.id], decisionActors([record]))).decision(record);
}
async function presentResult(ports: WorkPorts, record: ResultRecord) {
  return (await presenter(ports, [record.id], [record.createdBy])).result(record);
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

async function requireTargets(ports: WorkPorts, projectId: string, targets: ObjectRef[]) {
  for (const target of targets) {
    if (!(await ports.work.targetExists(projectId, target)))
      throw new RuleViolationError(`The linked ${target.type} is not part of this project`, 'LINK_TARGET_NOT_FOUND');
  }
}

async function requireOwner(ports: WorkPorts, projectId: string, owner: ActorRef | null) {
  if (owner && !(await ports.access.canRead(owner, projectId)))
    throw new RuleViolationError('The owner needs current access to this project', 'OWNER_WITHOUT_ACCESS');
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
  const presentWorks = async (ports: WorkPorts, items: WorkRecord[]) => { const view = await presenter(ports, items.map((i) => i.id), workActors(items), true); return items.map(view.work); };
  const presentDecisions = async (ports: WorkPorts, items: DecisionRecord[]) => { const view = await presenter(ports, items.map((i) => i.id), decisionActors(items)); return items.map(view.decision); };
  const presentResults = async (ports: WorkPorts, items: ResultRecord[]) => { const view = await presenter(ports, items.map((i) => i.id), items.map((i) => i.createdBy)); return items.map(view.result); };

  return {
    listWork: (principal: Principal, projectId: string, query?: PageQuery) =>
      list(principal, projectId, query, (ports, project, window) => ports.work.listWork(project, window), presentWorks),
    listDecisions: (principal: Principal, projectId: string, query?: PageQuery) =>
      list(principal, projectId, query, (ports, project, window) => ports.work.listDecisions(project, window), presentDecisions),
    listResults: (principal: Principal, projectId: string, query?: PageQuery) =>
      list(principal, projectId, query, (ports, project, window) => ports.work.listResults(project, window), presentResults),
    listTaskNotices: (principal: Principal, projectId: string, query?: PageQuery): Promise<Page<TaskCreationNotice>> =>
      list(principal, projectId, query, (ports, project, window) => ports.work.listTaskNotices(project, window), async (ports, items) => {
        const names = await ports.work.names(items.map((item) => item.createdBy));
        return items.map((item) => ({ ...item, kind: 'task.created', createdAt: iso(item.createdAt),
          createdBy: { ...item.createdBy, name: names.get(key(item.createdBy)) ?? (item.createdBy.kind === 'agent' ? 'Agent' : 'Former member') } }));
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
      return presentWork(ports, (await ports.work.findWork(id))!);
    }),
    getDecision: (principal: Principal, decisionId: string) => uow.run(async (ports) => {
      const { id } = await authorized(ports, principal, 'decision', decisionId, 'read');
      return presentDecision(ports, (await ports.work.findDecision(id))!);
    }),
    getResult: (principal: Principal, resultId: string) => uow.run(async (ports) => {
      const { id } = await authorized(ports, principal, 'result', resultId, 'read');
      return presentResult(ports, (await ports.work.findResult(id))!);
    }),

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
      const sources = valid.refs(command.sources, valid.SOURCE_TYPES, 'sources');
      const related = valid.refs(command.related, valid.ANY_TYPES, 'related');
      const criteria = valid.criteria(command.criteria);
      const dependencyIds = valid.dependencyIds(command.dependencyIds);
      const planIntent = valid.planIntent(command.planIntent);
      const clientCommandId = command.clientCommandId === undefined ? undefined : valid.id(command.clientCommandId, 'clientCommandId');
      // The retry fingerprint keeps its original shape (older stored creations still match) and adds the plan
      // fields only when present. The intent fingerprint is the canonical creation, without retry identity.
      const plan = { ...(criteria.length ? { criteria } : {}), ...(dependencyIds.length ? { dependencyIds } : {}), ...(planIntent ? { planIntent } : {}) };
      const requestFingerprint = clientCommandId ? createHash('sha256').update(JSON.stringify({ title, outcome, status, blocker, owner, sources, related, ...plan })).digest('hex') : undefined;
      const intentFingerprint = planIntent ? creationFingerprint({ title, outcome, status, blocker, owner, sources, related, criteria, dependencyIds }) : undefined;
      return uow.run(async (ports) => {
        const { workspaceId } = await ports.access.requireProject(principal, 'write', project, { lock: true });
        // The plan material's row lock precedes the command identity and the graph lock, like every source.
        if (planIntent) {
          const source = await ports.work.lockPlanSource(workspaceId, project, planIntent.materialId);
          if (!source) throw new RuleViolationError('The plan source is not part of this project', 'PLAN_SOURCE_NOT_FOUND');
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
            return presentWork(ports, earlier.work);
          }
        }
        await requireOwner(ports, project, owner);
        await requireTargets(ports, project, [...sources, ...related]);
        if (planIntent || dependencyIds.length) await lockProjectGraphs(ports.work, [project]);
        if (planIntent) {
          const existing = await ports.work.findPlanIntent(project, planIntent);
          const produced = existing ? await ports.work.findWork(existing.taskId, { lock: true }) : null;
          const decision = decidePlanIntent(existing, intentFingerprint!, produced);
          // The same canonical creation of an unchanged task: the original task, actor and times, no new notice or event.
          if (decision.kind === 'replay') return presentWork(ports, produced!);
        }
        if (dependencyIds.length) {
          const locked = await ports.work.lockTasks(workspaceId, dependencyIds);
          if (locked.length !== dependencyIds.length || locked.some((task) => task.projectId !== project))
            throw new RuleViolationError('A prerequisite is not a task of this project', 'TASK_DEPENDENCY_NOT_FOUND');
        }
        const scope = { workspaceId, projectId: project };
        const record = await ports.work.insertWork({ id: randomUUID(), ...scope, title, outcome, status, blocker, owner, createdBy: by, criteria, clientCommandId, requestFingerprint });
        // A brand-new task cannot be anyone's prerequisite yet, so these edges cannot close a cycle.
        if (dependencyIds.length) {
          await ports.work.replaceDependencies(scope, record.id, dependencyIds);
          if (ELIGIBLE_STATUSES.has(status)) await assertPrerequisitesMet(ports.work, workspaceId, record.id);
        }
        if (planIntent) await ports.work.insertPlanIntent(scope, planIntent, { taskId: record.id, fingerprint: intentFingerprint!, taskVersion: record.version });
        const from = { type: 'work' as const, id: record.id };
        await ports.work.insertLinks([...linkRows(scope, from, 'source', sources, by), ...linkRows(scope, from, 'related', related, by)]);
        await ports.work.insertCreationNotice(record, sources);
        const view = await presentWork(ports, record);
        // `assignedTo` names a person given this work by someone else (notifications, #116).
        const assignedTo = owner?.kind === 'human' && owner.id !== by.id ? owner.id : undefined;
        await ports.events.record(principal, workspaceId, 'project.work_created.v1', project, { workId: record.id, ...(assignedTo ? { assignedTo } : {}) });
        return view;
      });
    },

    /**
     * Changes a task at the version its author saw. A nonempty explicitly saved blocker is also one authored
     * contribution to the task's canonical thread, with exactly the saved text, in the same unit; clearing a
     * blocker or changing only status/owner/text contributes nothing. With `clientCommandId` an exact retry
     * returns the original outcome without contributing again.
     */
    async updateWork(principal: Principal, workId: string, command: UpdateWorkCommand, expected: number | undefined): Promise<WorkItem> {
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
      if (command.parked !== undefined) {
        if (command.parked !== false) throw new InvalidInputError('parked can only be set to false; a pivot parks work');
        changes.parked = null;
      }
      if (command.criteria !== undefined) changes.criteria = valid.criteria(command.criteria);
      const dependencyIds = command.dependencyIds === undefined ? undefined : valid.dependencyIds(command.dependencyIds);
      if (!Object.keys(changes).length && dependencyIds === undefined) throw new InvalidInputError('Nothing to change');
      // Status, blocker and parking are what a GitHub rule moves; changing any of them, also to the same value, overrides it.
      const overrides = command.status !== undefined || command.blocker !== undefined || command.parked !== undefined;
      const ruleRevision = command.expectedGithubRuleRevision;
      if (ruleRevision !== undefined && (!Number.isSafeInteger(ruleRevision) || ruleRevision < 0)) throw new InvalidInputError('expectedGithubRuleRevision must be a non-negative integer');
      // The exact text the person explicitly saved; undefined/cleared/empty contribute nothing.
      const savedBlocker = changes.blocker || null;
      return uow.run(async (ports) => {
        const { id, projectId, workspaceId } = await authorized(ports, principal, 'work', workId, 'write');
        if (dependencyIds?.includes(id)) throw new RuleViolationError('A task cannot depend on itself', 'TASK_SELF_DEPENDENCY');
        // Prerequisites are a set: their order is not part of the intent.
        const fingerprint = sha256({ operation: 'work.update', workId: id, expectedVersion: version, changes,
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
        const contribution = savedBlocker ? await ports.contributions.prepare(principal, projectId,
          { operation: 'work.update', commandId: clientCommandId ?? randomUUID() }, [{ workId: id, kind: 'blocker', body: savedBlocker }]) : null;
        // Replacing prerequisites, or starting/finishing a task, is a graph writer: graph lock (after the command
        // and message identities above), then every task it reads in one ascending pass (itself and the
        // prerequisites it will have).
        if (dependencyIds !== undefined || (changes.status !== undefined && ELIGIBLE_STATUSES.has(changes.status))) {
          await lockProjectGraphs(ports.work, [projectId]);
          const prerequisites = dependencyIds ?? await directPrerequisiteIds(ports.work, workspaceId, [id]);
          const wanted = sortedIds([id, ...prerequisites], 'taskIds');
          const locked = await ports.work.lockTasks(workspaceId, wanted);
          if (locked.length !== wanted.length || locked.some((task) => task.projectId !== projectId))
            throw new RuleViolationError('A prerequisite is not a task of this project', 'TASK_DEPENDENCY_NOT_FOUND');
        }
        // The task itself (already held after a graph pass, locked here otherwise); the contribution handle
        // completes its stage so the append can only follow the complete task set.
        const current = contribution ? (await ports.contributions.lockTasks(contribution))[0]! : (await ports.work.findWork(id, { lock: true }))!;
        if (current.version !== version) throw new VersionConflictError(current.version, await presentWork(ports, current));
        if (ruleRevision !== undefined && ((await ports.work.githubRules([id])).get(id)?.revision ?? 0) !== ruleRevision)
          throw new VersionConflictError(current.version, await presentWork(ports, current));
        const nextStatus = changes.status ?? current.status;
        // A person who explicitly finishes parked work with its current version also takes it
        // out of the parked list; work is never both finished and parked.
        if ((nextStatus === 'done' || nextStatus === 'not_pursued') && current.parked) changes.parked = null;
        if (nextStatus !== 'blocked') {
          if (changes.blocker) throw new InvalidInputError('A blocker applies to blocked work only');
          changes.blocker = null;
        }
        if (changes.owner !== undefined) await requireOwner(ports, projectId, changes.owner);
        if (dependencyIds !== undefined) await assertNoDependencyCycle(ports.work, workspaceId, id, dependencyIds);
        const record = await ports.work.updateWork(id, changes);
        // A person's override suspends the task's rule now, not at the next delivery. Finishing work leaves it: a rule
        // never acts on finished work, and its one-tap Done is how "Ready to close" ends.
        if (overrides && !FINISHED.has(nextStatus)) await ports.work.suspendGithubRule({ id, fromStatus: current.status, status: record.status, version: record.version });
        if (dependencyIds !== undefined) await ports.work.replaceDependencies({ workspaceId, projectId }, id, dependencyIds);
        // It starts or finishes only with every prerequisite done and unparked, and keeps that while it
        // is active. The check reads the edges as just replaced; a failure rolls back the whole change.
        if (ELIGIBLE_STATUSES.has(nextStatus) && (dependencyIds !== undefined || nextStatus !== current.status)) await assertPrerequisitesMet(ports.work, workspaceId, id);
        const view = await presentWork(ports, record);
        const newOwner = changes.owner;
        const assignedTo = newOwner?.kind === 'human' && newOwner.id !== principal.id
          && !(current.owner?.kind === 'human' && current.owner.id === newOwner.id) ? newOwner.id : undefined;
        await ports.events.record(principal, workspaceId, 'project.work_updated.v1', projectId, { workId: id, ...(assignedTo ? { assignedTo } : {}) });
        const messageIds = contribution ? await ports.contributions.append(contribution) : [];
        if (clientCommandId) await ports.work.recordNativeCommand({ workspaceId, projectId }, by,
          { operation: 'work.update', commandId: clientCommandId, fingerprint, object: { type: 'work', id, version: record.version }, messageIds });
        return view;
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
            throw new RuleViolationError('Only an accepted decision of this project can be superseded', 'SUPERSEDES_NOT_CURRENT');
        }
        await requireTargets(ports, project, [...sources, ...affects]);
        const scope = { workspaceId, projectId: project };
        const record = await ports.work.insertDecision({ id: randomUUID(), ...scope, title, rationale, proposedBy: by, supersedesId: supersedes });
        const from = { type: 'decision' as const, id: record.id };
        await ports.work.insertLinks([...linkRows(scope, from, 'source', sources, by), ...linkRows(scope, from, 'affects', affects, by)]);
        const view = await presentDecision(ports, record);
        await ports.events.record(principal, workspaceId, 'project.decision_proposed.v1', project, { decisionId: record.id });
        return view;
      });
    },

    /**
     * A person with write access accepts a proposal. If it supersedes an accepted decision this is
     * a pivot: the earlier decision is marked superseded (kept, with its rationale), `stillApplies`
     * work is linked to the new decision and `park` work is parked without changing its status.
     */
    async acceptDecision(principal: Principal, decisionId: string, command: AcceptDecisionCommand = {}, expected: number | undefined): Promise<Decision> {
      const by = actor(principal);
      const version = valid.expectedVersion(expected);
      const stillApplies = valid.ids(command?.stillApplies, 'stillApplies');
      const park = valid.ids(command?.park, 'park');
      if (stillApplies.some((id) => park.includes(id))) throw new InvalidInputError('Work cannot both still apply and be parked');
      return uow.run(async (ports) => {
        const { id, projectId, workspaceId } = await authorized(ports, principal, 'decision', decisionId, 'write');
        if (by.kind !== 'human') throw new ForbiddenError('Only a person can accept a decision; agents can propose', 'DECISION_NEEDS_PERSON');
        const current = (await ports.work.findDecision(id, { lock: true }))!;
        if (current.version !== version) throw new VersionConflictError(current.version, await presentDecision(ports, current));
        if (current.status !== 'proposed') throw new ConflictError('This decision is no longer a proposal', 'DECISION_NOT_PROPOSED');
        if ((stillApplies.length || park.length) && !current.supersedesId)
          throw new RuleViolationError('Only a decision that supersedes an earlier one is a pivot', 'PIVOT_NEEDS_EARLIER_DECISION');
        const parked: WorkRecord[] = [];
        for (const workId of [...stillApplies, ...park].sort()) {
          const work = await ports.work.findWork(workId, { lock: true });
          if (!work || work.projectId !== projectId) throw new RuleViolationError('The work is not part of this project', 'LINK_TARGET_NOT_FOUND');
          if (park.includes(workId)) {
            if (FINISHED.has(work.status)) throw new RuleViolationError('Finished work keeps its result and is not parked', 'WORK_ALREADY_FINISHED');
            parked.push(work);
          }
        }
        const now = new Date();
        if (current.supersedesId) {
          const earlier = await ports.work.findDecision(current.supersedesId, { lock: true });
          if (!earlier || earlier.status !== 'accepted')
            throw new ConflictError('The decision this one replaces has changed; review it again', 'SUPERSEDED_DECISION_CHANGED');
          await ports.work.updateDecision(earlier.id, { status: 'superseded', supersededById: id, supersededAt: now });
        }
        const record = await ports.work.updateDecision(id, { status: 'accepted', decidedBy: by.id, decidedAt: now });
        for (const work of parked) await ports.work.updateWork(work.id, { parked: { decisionId: id, at: now } });
        const scope = { workspaceId, projectId };
        await ports.work.insertLinks(linkRows(scope, { type: 'decision', id }, 'still_applies', workRefs(stillApplies), by));
        const view = await presentDecision(ports, record);
        await ports.events.record(principal, workspaceId, 'project.decision_accepted.v1', projectId, { decisionId: id });
        return view;
      });
    },

    /**
     * A positive or negative finding with evidence. It can finish one of the work items it reports on. One
     * canonical result is created; every task it reports on (`work`) also gets one authored contribution that
     * names that exact result, with the result title as its text, made by the creating principal. A result
     * with no linked task creates no task thread. With `clientCommandId` an exact retry returns the original
     * result without a second result or message.
     */
    async createResult(principal: Principal, projectId: string, command: CreateResultCommand): Promise<WorkResult> {
      const by = actor(principal);
      if (!command || typeof command !== 'object') throw new InvalidInputError('Result is required');
      const project = valid.id(projectId, 'projectId');
      const title = valid.title(command.title);
      const finding = valid.finding(command.finding);
      const evidence = valid.text(command.evidence, 'evidence', WORK_LIMITS.evidence);
      const sources = valid.refs(command.sources, valid.SOURCE_TYPES, 'sources');
      const workIds = valid.ids(command.work, 'work');
      const decisions: ObjectRef[] = valid.ids(command.decisions, 'decisions').map((id) => ({ type: 'decision', id }));
      const clientCommandId = command.clientCommandId === undefined ? undefined : valid.id(command.clientCommandId, 'clientCommandId');
      let finishes: { id: string; version: number } | null = null;
      if (command.finishes !== undefined) {
        const raw = command.finishes as { id?: unknown; expectedVersion?: unknown } | null;
        if (!raw || typeof raw !== 'object') throw new InvalidInputError('finishes must be { id, expectedVersion }');
        finishes = { id: valid.id(raw.id, 'finishes.id'), version: valid.expectedVersion(raw.expectedVersion) };
        if (!workIds.includes(finishes.id)) throw new InvalidInputError('finishes must be one of the linked work items');
      }
      const fingerprint = sha256({ operation: 'result.create', projectId: project, title, finding, evidence, sources: sources.map(valid.refKey).sort(),
        work: [...workIds].sort(), decisions: decisions.map((decision) => decision.id).sort(), finishes });
      return uow.run(async (ports) => {
        const { workspaceId } = await ports.access.requireProject(principal, 'write', project, { lock: true });
        if (clientCommandId) {
          // Command identity before any task lock. An exact retry rechecks current authorization (above), the
          // canonical sources and the stored result and contributions, and writes nothing.
          const earlier = await ports.work.nativeCommand(project, by, 'result.create', clientCommandId);
          if (earlier) {
            sameCommand(earlier, fingerprint);
            await requireTargets(ports, project, [...sources, ...workRefs(workIds), ...decisions]);
            const stored = earlier.object.type === 'result' ? await ports.work.findResult(earlier.object.id) : null;
            if (!stored || stored.projectId !== project || !await ports.contributions.confirm(principal, project, earlier.messageIds)) throw invalidPostState();
            return presentResult(ports, stored);
          }
        }
        await requireTargets(ports, project, [...sources, ...workRefs(workIds), ...decisions]);
        const resultId = randomUUID();
        // Every message identity (derived from this result and its task) is locked before the first task lock,
        // then the complete sorted task set, so overlapping results lock in one order and cannot deadlock.
        const contributions = workIds.length ? await ports.contributions.prepare(principal, project, { operation: 'result.create', resultId },
          workIds.map((workId) => ({ workId, kind: 'result' as const, body: title, resultId }))) : null;
        // Finishing is also a start/finish transition: graph lock, then ONE ascending pass over the linked tasks
        // together with the finishing task's prerequisites, so no other pass can lock them in another order.
        if (finishes) {
          await lockProjectGraphs(ports.work, [project]);
          const wanted = sortedIds([...workIds, ...await directPrerequisiteIds(ports.work, workspaceId, [finishes.id])], 'taskIds');
          const held = await ports.work.lockTasks(workspaceId, wanted);
          if (held.length !== wanted.length || held.some((task) => task.projectId !== project))
            throw new RuleViolationError('A prerequisite is not a task of this project', 'TASK_DEPENDENCY_NOT_FOUND');
        }
        // The linked tasks are now all held (a plain pass when nothing finishes); the handle completes its stage.
        const locked = contributions ? await ports.contributions.lockTasks(contributions) : [];
        // Finishing changes someone's work: it needs the version the author saw and a status
        // that can become done. A parked or not-pursued item is another person's disposition.
        const finished = finishes ? locked.find((row) => row.id === finishes!.id)! : null;
        if (finished && finishes) {
          if (finished.version !== finishes.version) throw new VersionConflictError(finished.version, await presentWork(ports, finished));
          if (finished.parked) throw new ConflictError('Parked work must be brought back into the plan before a result finishes it', 'WORK_NOT_FINISHABLE');
          if (finished.status === 'not_pursued') throw new ConflictError('Work that is not pursued cannot be finished by a result', 'WORK_NOT_FINISHABLE');
        }
        const scope = { workspaceId, projectId: project };
        const record = await ports.work.insertResult({ id: resultId, ...scope, title, finding, evidence, createdBy: by });
        const from = { type: 'result' as const, id: record.id };
        await ports.work.insertLinks([...linkRows(scope, from, 'source', sources, by), ...linkRows(scope, from, 'about', [...workRefs(workIds), ...decisions], by)]);
        if (finished && finished.status !== 'done') {
          await ports.work.updateWork(finished.id, { status: 'done', blocker: null });
          await assertPrerequisitesMet(ports.work, workspaceId, finished.id);
        }
        const view = await presentResult(ports, record);
        if (finding === 'negative' && by.kind === 'human')
          await ports.backgroundComparison.enqueueHumanNegative(record.id, project, by.id);
        await ports.events.record(principal, workspaceId, 'project.result_recorded.v1', project, { resultId: record.id });
        const messageIds = contributions ? await ports.contributions.append(contributions) : [];
        if (clientCommandId) await ports.work.recordNativeCommand(scope, by,
          { operation: 'result.create', commandId: clientCommandId, fingerprint, object: { type: 'result', id: record.id }, messageIds });
        return view;
      });
    },

    /** Connects a work item, decision or result to anything else in the project. */
    async createLink(principal: Principal, projectId: string, command: CreateObjectLinkCommand): Promise<ObjectLink> {
      const by = actor(principal);
      if (!command || typeof command !== 'object') throw new InvalidInputError('Link is required');
      const project = valid.id(projectId, 'projectId');
      const from = valid.ref(command.from, ['work', 'decision', 'result'], 'from') as { type: WorkObjectType; id: string };
      const to = valid.ref(command.to, valid.ANY_TYPES, 'to');
      if (from.type === to.type && from.id === to.id) throw new InvalidInputError('An object cannot link to itself');
      return uow.run(async (ports) => {
        const { workspaceId } = await ports.access.requireProject(principal, 'write', project, { lock: true });
        await requireTargets(ports, project, [from, to]);
        await ports.work.insertLinks(linkRows({ workspaceId, projectId: project }, from, 'related', [to], by));
        const link = (await ports.work.links([from.id])).find((item) => item.fromId === from.id && item.role === 'related' && item.toId === to.id
          && (to.type !== 'material' || item.toVersion === to.version));
        if (!link) throw new Error('Link was not stored');
        const titles = await ports.work.titles(project, [from, to]);
        await ports.events.record(principal, workspaceId, 'project.link_created.v1', project, { from: from.id });
        return { id: link.id, projectId: project, role: link.role, from, to, fromTitle: titles.get(valid.refKey(from))?.title ?? '',
          toTitle: titles.get(valid.refKey(to))?.title ?? '', conversationId: titles.get(valid.refKey(to))?.conversationId ?? null,
          sketchId: titles.get(valid.refKey(to))?.sketchId ?? null, createdAt: iso(link.createdAt) };
      });
    },
  };
}

export type WorkUseCases = ReturnType<typeof createWorkUseCases>;
