import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { DecisionRowProjection, NamedPrincipal, NativeWorkRow, PrincipalRef, WorkDetailObject, WorkRowProjection } from '@flux/contracts';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';
import { workRows } from './work.js';
import { openRows } from '../sealing.js';
import { taskGraphRows } from './task-graph.js';
import { nativePrerequisiteCounts } from './work-read-task-plans.js';
import { nativeWorkVisibilityRows, type NativeWorkReadObject } from './work-read-visibility.js';

const w = schema.projectWorkItems, d = schema.projectDecisions;
const base = (table: typeof w | typeof d) => ({ id: table.id, workspaceId: table.workspaceId, projectId: table.projectId, title: table.title, createdAt: table.createdAt });
const workFields = { ...base(w), number: w.number, status: w.status, blocker: w.blocker, waitingForUserId: w.waitingForUserId, waitingForDecisionId: w.waitingForDecisionId, waitingForWorkId: w.waitingForWorkId, dropped: w.dropped, cameOfIt: w.cameOfIt, dueOn: w.dueOn, ownerUserId: w.ownerUserId, ownerAgentId: w.ownerAgentId, version: w.version, updatedAt: w.updatedAt,
  revertedAt: w.creationRevertedAt, revertedByKind: w.creationRevertedByKind, revertedById: w.creationRevertedById, reversionNoticeId: w.creationReversionNoticeId };
const decisionFields = { ...base(d), rationale: d.rationale, status: d.status, proposedByKind: d.proposedByKind, proposedById: d.proposedById, decidedBy: d.decidedBy, decidedAt: d.decidedAt, supersedesId: d.supersedesId, supersededById: d.supersededById, supersededAt: d.supersededAt, version: d.version, updatedAt: d.updatedAt };
const iso = (date: Date) => date.toISOString();
const audience = (record: { projectId: string; createdAt: Date }) => ({ audience: { kind: 'project' as const, projectId: record.projectId }, createdAt: iso(record.createdAt) });
const actorKey = (ref: PrincipalRef) => `${ref.kind}:${ref.id}`;

/** F-034: a decision's short reason for its card, the first sentence of the rationale as plain words. */
export function shortReason(rationale: string, max = 160): string {
  // A rationale may be 20,000 characters and the link pattern is quadratic in what it reads (v0.2.1 audit #1270): the first sentence needs far fewer.
  const flat = rationale.slice(0, 2_000).replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '').replace(/[*_`~\\]/g, '').replace(/\s+/g, ' ').trim();
  const sentence = /^(.+?[.!?])(\s|$)/.exec(flat)?.[1] ?? flat;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

/** Bounded native row/detail projection; not the legacy full object/link presenter. */
/** The composing adapter adds a task's "Let linked PRs move this task" rule (#74 G-1a), presented by core. */
export type NativeWorkDetailObject = Exclude<WorkDetailObject, { kind: 'work' }> | Omit<Extract<WorkDetailObject, { kind: 'work' }>, 'githubRule'>;
export function nativeWorkObjectRows(db: DbExecutor) {
  async function names(refs: PrincipalRef[]) {
    const found = await workRows(db).names(refs);
    return (ref: PrincipalRef): NamedPrincipal => ({ ...ref, name: found.get(actorKey(ref)) ?? (ref.kind === 'agent' ? 'Agent' : 'Former member') });
  }
  /** The tasks that are part of this one (#841), by number; a task whose creation was undone is no longer one. At most 50. */
  async function subtasks(projectId: string, parentId: string) {
    const l = schema.projectObjectLinks;
    const children = await openRows(db, 'project_work_items', await db.select({ id: w.id, workspaceId: w.workspaceId, number: w.number, status: w.status, title: w.title,
      ownerUserId: w.ownerUserId, ownerAgentId: w.ownerAgentId }).from(l).innerJoin(w, eq(w.id, l.fromId))
      .where(and(eq(l.projectId, projectId), eq(l.role, 'part_of'), eq(l.toType, 'work'), eq(l.toId, parentId), isNull(w.creationRevertedAt))).orderBy(asc(w.number)).limit(50));
    const owners = children.flatMap((child): PrincipalRef[] => child.ownerUserId ? [{ kind: 'human' as const, id: child.ownerUserId }] : child.ownerAgentId ? [{ kind: 'agent' as const, id: child.ownerAgentId }] : []);
    const named = await names(owners);
    return children.map((child) => ({ id: child.id, number: child.number, title: child.title, status: child.status,
      owner: child.ownerUserId ? named({ kind: 'human', id: child.ownerUserId }) : child.ownerAgentId ? named({ kind: 'agent', id: child.ownerAgentId }) : null }));
  }
  async function rows(projectId: string, objects: readonly NativeWorkReadObject[]): Promise<NativeWorkRow[]> {
    if (objects.length > 100) throw new Error('Native work hydration exceeds the global bound');
    if (!objects.length) return [];
    // Snapshot the ordered input before any asynchronous operation.
    const requested = objects.map((object) => ({ ...object }));
    const ids = (kind: NativeWorkReadObject['kind']) => requested.filter((ref) => ref.kind === kind).map((ref) => ref.id);
    const workIds = ids('work'), decisionIds = ids('decision');
    const works = workIds.length ? await openRows(db, 'project_work_items', await db.select(workFields).from(w).where(and(eq(w.projectId, projectId), inArray(w.id, workIds)))) : [];
    const decisions = decisionIds.length ? await openRows(db, 'project_decisions', await db.select(decisionFields).from(d).where(and(eq(d.projectId, projectId), inArray(d.id, decisionIds)))) : [];
    const prerequisites = await nativePrerequisiteCounts(db, projectId, workIds);
    const actors: PrincipalRef[] = [];
    for (const work of works) {
      if (work.waitingForUserId) actors.push({ kind: 'human', id: work.waitingForUserId });
      if (work.ownerUserId) actors.push({ kind: 'human', id: work.ownerUserId });
      else if (work.ownerAgentId) actors.push({ kind: 'agent', id: work.ownerAgentId });
      if (work.revertedByKind && work.revertedById) actors.push({ kind: work.revertedByKind, id: work.revertedById });
    }
    for (const decision of decisions) {
      actors.push({ kind: decision.proposedByKind, id: decision.proposedById });
      if (decision.decidedBy) actors.push({ kind: 'human', id: decision.decidedBy });
    }
    const named = await names(actors);
    const facts = new Map((await nativeWorkVisibilityRows(db).relations(projectId, requested)).map((fact) => [`${fact.kind}:${fact.id}`, fact]));
    const waitingOn = await workRows(db).waitingTargets(works.flatMap((work): { kind: 'decision' | 'task'; id: string }[] => work.waitingForDecisionId ? [{ kind: 'decision' as const, id: work.waitingForDecisionId }]
      : work.waitingForWorkId ? [{ kind: 'task' as const, id: work.waitingForWorkId }] : []));
    const byId = new Map<string, NativeWorkRow>();
    const counts = (kind: NativeWorkReadObject['kind'], id: string) => {
      const fact = facts.get(`${kind}:${id}`);
      if (!fact) throw new Error('Missing native relation aggregates');
      return { edges: fact.edges, sourceMessages: fact.sourceMessages, sourceMaterials: fact.sourceMaterials, decisions: fact.decisions };
    };
    for (const work of works) {
      const projected: WorkRowProjection = { kind: 'work', id: work.id, number: work.number, projectId: work.projectId, workspaceId: work.workspaceId, title: work.title,
        status: work.status, blocker: work.blocker, waitingFor: work.waitingForUserId ? named({ kind: 'human', id: work.waitingForUserId }) : null,
        waitingOn: waitingOn.get(work.waitingForDecisionId ? `decision:${work.waitingForDecisionId}` : `task:${work.waitingForWorkId}`) ?? null, dropped: work.dropped, cameOfIt: work.cameOfIt, dueOn: work.dueOn, version: work.version, ...audience(work), relations: counts('work', work.id),
        prerequisiteCounts: prerequisites.get(work.id)!,
        owner: work.ownerUserId ? named({ kind: 'human', id: work.ownerUserId }) : work.ownerAgentId ? named({ kind: 'agent', id: work.ownerAgentId }) : null,
        rule: facts.get(`work:${work.id}`)!.rule, updatedAt: iso(work.updatedAt),
        // An existing reference to a task whose creation was undone (#238) names it as history.
        lifecycle: work.revertedAt && work.revertedByKind && work.revertedById && work.reversionNoticeId
          ? { state: 'creation_reverted', noticeId: work.reversionNoticeId, revertedAt: iso(work.revertedAt), revertedBy: named({ kind: work.revertedByKind, id: work.revertedById }) }
          : { state: 'active' } };
      byId.set(`work:${work.id}`, projected);
    }
    for (const decision of decisions) {
      const projected: DecisionRowProjection = { kind: 'decision', id: decision.id, projectId: decision.projectId, workspaceId: decision.workspaceId, title: decision.title, ...audience(decision), relations: counts('decision', decision.id),
        reason: shortReason(decision.rationale), status: decision.status, proposedBy: named({ kind: decision.proposedByKind, id: decision.proposedById }), decidedBy: decision.decidedBy ? named({ kind: 'human', id: decision.decidedBy }) : null,
        decidedAt: decision.decidedAt ? iso(decision.decidedAt) : null, supersedes: decision.supersedesId, supersededBy: decision.supersededById, supersededAt: decision.supersededAt ? iso(decision.supersededAt) : null,
        version: decision.version, updatedAt: iso(decision.updatedAt) };
      byId.set(`decision:${decision.id}`, projected);
    }
    return requested.map((ref) => {
      const row = byId.get(`${ref.kind}:${ref.id}`);
      if (!row) throw new Error('Missing required native row in hydration');
      return row;
    });
  }

  return {
    rows,
    async decision(projectId: string, id: string) {
      const [decision] = await db.select({ id: d.id, status: d.status }).from(d).where(and(eq(d.projectId, projectId), eq(d.id, id)));
      return decision ?? null;
    },
    async decisionRefs(projectId: string, ids: readonly string[]) {
      if (ids.length > 3) throw new Error('Native detail context exceeds its bound');
      if (!ids.length) return [];
      const ordered = [...new Set(ids)];
      const refs = (await openRows(db, 'project_decisions', await db.select({ id: d.id, workspaceId: d.workspaceId, title: d.title }).from(d).where(and(eq(d.projectId, projectId), inArray(d.id, ordered))))).map(({ id, title }) => ({ id, title }));
      return ordered.flatMap((id) => { const ref = refs.find((ref) => ref.id === id); return ref ? [{ kind: 'decision' as const, ...ref }] : []; });
    },
    /** Full own fields for exactly one native object. No links are implicitly loaded. */
    async detail(projectId: string, object: NativeWorkReadObject): Promise<NativeWorkDetailObject | null> {
      const requested = { ...object };
      const table = requested.kind === 'work' ? w : d;
      const exists = await db.select({ id: table.id }).from(table).where(and(eq(table.projectId, projectId), eq(table.id, requested.id)));
      if (!exists.length) return null;
      const row = (await rows(projectId, [requested]))[0]!;
      if (row.kind === 'work') {
        const [own] = await openRows(db, 'project_work_items', await db.select({ id: w.id, workspaceId: w.workspaceId, outcome: w.outcome, criteria: w.criteria, createdByKind: w.createdByKind, createdById: w.createdById }).from(w).where(and(eq(w.projectId, projectId), eq(w.id, row.id))));
        if (!own) throw new Error('Missing native work detail');
        const named = await names([{ kind: own.createdByKind, id: own.createdById }]);
        const plan = (await taskGraphRows(db).taskPlans([row.id])).get(row.id) ?? { prerequisites: [], planIntent: null };
        const prerequisites = plan.prerequisites.map((item) => ({ ...item, met: item.status === 'done' }));
        if (prerequisites.length !== row.prerequisiteCounts.total || prerequisites.filter((item) => !item.met).length !== row.prerequisiteCounts.unmet)
          throw new Error('Inconsistent native task detail');
        const { relations: _relations, rule: _rule, prerequisiteCounts: _counts, ...work } = row;
        void _relations; void _rule; void _counts;
        return { ...work, kind: 'work', outcome: own.outcome, criteria: own.criteria,
          dependencyIds: prerequisites.map(({ id }) => id), prerequisites, subtasks: await subtasks(projectId, row.id), planIntent: plan.planIntent,
          createdBy: named({ kind: own.createdByKind, id: own.createdById }) };
      }
      const [own] = await openRows(db, 'project_decisions', await db.select({ id: d.id, workspaceId: d.workspaceId, rationale: d.rationale }).from(d).where(and(eq(d.projectId, projectId), eq(d.id, row.id))));
      if (!own) throw new Error('Missing native decision detail');
      const { relations: _relations, ...decision } = row;
      void _relations;
      return { ...decision, kind: 'decision', rationale: own.rationale };
    },
  };
}
