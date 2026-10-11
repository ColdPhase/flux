import { and, eq, inArray } from 'drizzle-orm';
import type { DecisionRowProjection, NamedPrincipal, NativeWorkRow, PrincipalRef, ResultRowProjection, WorkDetailObject, WorkRowProjection } from '@flux/contracts';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';
import { workRows } from './work.js';
import { taskGraphRows } from './task-graph.js';
import { nativePrerequisiteCounts } from './work-read-task-plans.js';
import { nativeWorkVisibilityRows, type NativeWorkReadObject } from './work-read-visibility.js';

const w = schema.projectWorkItems, d = schema.projectDecisions, r = schema.projectResults;
const base = (table: typeof w | typeof d | typeof r) => ({ id: table.id, workspaceId: table.workspaceId, projectId: table.projectId, title: table.title, createdAt: table.createdAt });
const workFields = { ...base(w), number: w.number, status: w.status, blocker: w.blocker, ownerUserId: w.ownerUserId, ownerAgentId: w.ownerAgentId, parkedByDecisionId: w.parkedByDecisionId, parkedAt: w.parkedAt, version: w.version, updatedAt: w.updatedAt,
  revertedAt: w.creationRevertedAt, revertedByKind: w.creationRevertedByKind, revertedById: w.creationRevertedById, reversionNoticeId: w.creationReversionNoticeId };
const decisionFields = { ...base(d), status: d.status, proposedByKind: d.proposedByKind, proposedById: d.proposedById, decidedBy: d.decidedBy, decidedAt: d.decidedAt, supersedesId: d.supersedesId, supersededById: d.supersededById, supersededAt: d.supersededAt, version: d.version, updatedAt: d.updatedAt };
const resultFields = { ...base(r), finding: r.finding, createdByKind: r.createdByKind, createdById: r.createdById };
const iso = (date: Date) => date.toISOString();
const audience = (record: { projectId: string; createdAt: Date }) => ({ audience: { kind: 'project' as const, projectId: record.projectId }, createdAt: iso(record.createdAt) });
const actorKey = (ref: PrincipalRef) => `${ref.kind}:${ref.id}`;

/** Bounded native row/detail projection; not the legacy full object/link presenter. */
/** The composing adapter adds a task's "Let linked PRs move this task" rule (#74 G-1a), presented by core. */
export type NativeWorkDetailObject = Exclude<WorkDetailObject, { kind: 'work' }> | Omit<Extract<WorkDetailObject, { kind: 'work' }>, 'githubRule'>;
export function nativeWorkObjectRows(db: DbExecutor) {
  async function names(refs: PrincipalRef[]) {
    const found = await workRows(db).names(refs);
    return (ref: PrincipalRef): NamedPrincipal => ({ ...ref, name: found.get(actorKey(ref)) ?? (ref.kind === 'agent' ? 'Agent' : 'Former member') });
  }
  async function rows(projectId: string, objects: readonly NativeWorkReadObject[]): Promise<NativeWorkRow[]> {
    if (objects.length > 100) throw new Error('Native work hydration exceeds the global bound');
    if (!objects.length) return [];
    // Snapshot the ordered input before any asynchronous operation.
    const requested = objects.map((object) => ({ ...object }));
    const ids = (kind: NativeWorkReadObject['kind']) => requested.filter((ref) => ref.kind === kind).map((ref) => ref.id);
    const workIds = ids('work'), decisionIds = ids('decision'), resultIds = ids('result');
    const works = workIds.length ? await db.select(workFields).from(w).where(and(eq(w.projectId, projectId), inArray(w.id, workIds))) : [];
    const decisions = decisionIds.length ? await db.select(decisionFields).from(d).where(and(eq(d.projectId, projectId), inArray(d.id, decisionIds))) : [];
    const results = resultIds.length ? await db.select(resultFields).from(r).where(and(eq(r.projectId, projectId), inArray(r.id, resultIds))) : [];
    const prerequisites = await nativePrerequisiteCounts(db, projectId, workIds);
    const actors: PrincipalRef[] = [];
    for (const work of works) {
      if (work.ownerUserId) actors.push({ kind: 'human', id: work.ownerUserId });
      else if (work.ownerAgentId) actors.push({ kind: 'agent', id: work.ownerAgentId });
      if (work.revertedByKind && work.revertedById) actors.push({ kind: work.revertedByKind, id: work.revertedById });
    }
    for (const decision of decisions) {
      actors.push({ kind: decision.proposedByKind, id: decision.proposedById });
      if (decision.decidedBy) actors.push({ kind: 'human', id: decision.decidedBy });
    }
    for (const result of results) actors.push({ kind: result.createdByKind, id: result.createdById });
    const named = await names(actors);
    const facts = new Map((await nativeWorkVisibilityRows(db).relations(projectId, requested)).map((fact) => [`${fact.kind}:${fact.id}`, fact]));
    const parkedIds = [...new Set(works.filter((work) => work.parkedAt && work.parkedByDecisionId).map((work) => work.parkedByDecisionId!))];
    const parked = parkedIds.length ? await db.select({ id: d.id, title: d.title }).from(d).where(and(eq(d.projectId, projectId), inArray(d.id, parkedIds))) : [];
    const byId = new Map<string, NativeWorkRow>();
    const counts = (kind: NativeWorkReadObject['kind'], id: string) => {
      const fact = facts.get(`${kind}:${id}`);
      if (!fact) throw new Error('Missing native relation aggregates');
      return { edges: fact.edges, sourceMessages: fact.sourceMessages, sourceMaterials: fact.sourceMaterials, decisions: fact.decisions, results: fact.results };
    };
    for (const work of works) {
      const ref = parked.find((decision) => decision.id === work.parkedByDecisionId);
      const projected: WorkRowProjection = { kind: 'work', id: work.id, number: work.number, projectId: work.projectId, workspaceId: work.workspaceId, title: work.title,
        status: work.status, blocker: work.blocker, version: work.version, ...audience(work), relations: counts('work', work.id),
        prerequisiteCounts: prerequisites.get(work.id)!,
        owner: work.ownerUserId ? named({ kind: 'human', id: work.ownerUserId }) : work.ownerAgentId ? named({ kind: 'agent', id: work.ownerAgentId }) : null,
        parked: work.parkedAt && work.parkedByDecisionId ? { decisionId: work.parkedByDecisionId, at: iso(work.parkedAt) } : null,
        parkedBy: ref ? { kind: 'decision', ...ref } : null, rule: facts.get(`work:${work.id}`)!.rule, updatedAt: iso(work.updatedAt),
        // An existing reference to a task whose creation was undone (#238) names it as history.
        lifecycle: work.revertedAt && work.revertedByKind && work.revertedById && work.reversionNoticeId
          ? { state: 'creation_reverted', noticeId: work.reversionNoticeId, revertedAt: iso(work.revertedAt), revertedBy: named({ kind: work.revertedByKind, id: work.revertedById }) }
          : { state: 'active' } };
      byId.set(`work:${work.id}`, projected);
    }
    for (const decision of decisions) {
      const projected: DecisionRowProjection = { kind: 'decision', id: decision.id, projectId: decision.projectId, workspaceId: decision.workspaceId, title: decision.title, ...audience(decision), relations: counts('decision', decision.id),
        status: decision.status, proposedBy: named({ kind: decision.proposedByKind, id: decision.proposedById }), decidedBy: decision.decidedBy ? named({ kind: 'human', id: decision.decidedBy }) : null,
        decidedAt: decision.decidedAt ? iso(decision.decidedAt) : null, supersedes: decision.supersedesId, supersededBy: decision.supersededById, supersededAt: decision.supersededAt ? iso(decision.supersededAt) : null,
        version: decision.version, updatedAt: iso(decision.updatedAt) };
      byId.set(`decision:${decision.id}`, projected);
    }
    for (const result of results) {
      const projected: ResultRowProjection = { kind: 'result', id: result.id, projectId: result.projectId, workspaceId: result.workspaceId, title: result.title, ...audience(result), relations: counts('result', result.id),
        finding: result.finding, createdBy: named({ kind: result.createdByKind, id: result.createdById }) };
      byId.set(`result:${result.id}`, projected);
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
      const refs = await db.select({ id: d.id, title: d.title }).from(d).where(and(eq(d.projectId, projectId), inArray(d.id, ordered)));
      return ordered.flatMap((id) => { const ref = refs.find((ref) => ref.id === id); return ref ? [{ kind: 'decision' as const, ...ref }] : []; });
    },
    /** Full own fields for exactly one native object. No links are implicitly loaded. */
    async detail(projectId: string, object: NativeWorkReadObject): Promise<NativeWorkDetailObject | null> {
      const requested = { ...object };
      const table = requested.kind === 'work' ? w : requested.kind === 'decision' ? d : r;
      const exists = await db.select({ id: table.id }).from(table).where(and(eq(table.projectId, projectId), eq(table.id, requested.id)));
      if (!exists.length) return null;
      const row = (await rows(projectId, [requested]))[0]!;
      if (row.kind === 'work') {
        const [own] = await db.select({ outcome: w.outcome, criteria: w.criteria, createdByKind: w.createdByKind, createdById: w.createdById }).from(w).where(and(eq(w.projectId, projectId), eq(w.id, row.id)));
        if (!own) throw new Error('Missing native work detail');
        const named = await names([{ kind: own.createdByKind, id: own.createdById }]);
        const plan = (await taskGraphRows(db).taskPlans([row.id])).get(row.id) ?? { prerequisites: [], planIntent: null };
        const prerequisites = plan.prerequisites.map((item) => ({ ...item, met: item.status === 'done' && !item.parked }));
        if (prerequisites.length !== row.prerequisiteCounts.total || prerequisites.filter((item) => !item.met).length !== row.prerequisiteCounts.unmet)
          throw new Error('Inconsistent native task detail');
        const { relations: _relations, parkedBy: _parked, rule: _rule, prerequisiteCounts: _counts, ...work } = row;
        void _relations; void _parked; void _rule; void _counts;
        return { ...work, kind: 'work', outcome: own.outcome, criteria: own.criteria,
          dependencyIds: prerequisites.map(({ id }) => id), prerequisites, planIntent: plan.planIntent,
          createdBy: named({ kind: own.createdByKind, id: own.createdById }) };
      }
      if (row.kind === 'decision') {
        const [own] = await db.select({ rationale: d.rationale }).from(d).where(and(eq(d.projectId, projectId), eq(d.id, row.id)));
        if (!own) throw new Error('Missing native decision detail');
        const { relations: _relations, ...decision } = row;
        void _relations;
        return { ...decision, kind: 'decision', rationale: own.rationale };
      }
      const [own] = await db.select({ evidence: r.evidence }).from(r).where(and(eq(r.projectId, projectId), eq(r.id, row.id)));
      if (!own) throw new Error('Missing native result detail');
      const { relations: _relations, ...result } = row;
      void _relations;
      return { ...result, kind: 'result', evidence: own.evidence };
    },
  };
}
