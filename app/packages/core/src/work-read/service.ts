import {
  WORK_GROUPS, WORK_READ_LIMITS, type NativeWorkRow, type PrincipalRef, type ProjectWorkSummary,
  type ProjectWorkView, type WorkAssociations, type WorkDetailProjection, type WorkRelations,
} from '@flux/contracts';
import { DomainError, ServiceUnavailableError } from '../access/errors.js';
import type { Principal } from '../principal.js';
import { decodeWorkReadCursor, presentWorkReadPage, workReadScope } from './cursor.js';
import type { WorkReadFinalFence, WorkReadPorts, WorkReadRequirements, WorkReadUnitOfWork, WorkSummaryObservation } from './ports.js';
import {
  assertEmptyWorkReadQuery, parseWorkAssociationRead, parseWorkRelationRead, parseWorkViewRead,
  workReadId, workReadInvalid, workReadKind,
} from './query.js';

function caller(principal: Principal): PrincipalRef {
  if ((principal.kind !== 'human' && principal.kind !== 'agent') || !principal.id) return workReadInvalid('A signed-in native principal is required');
  return { kind: principal.kind, id: principal.id };
}
const count = (value: number) => Number.isSafeInteger(value) && value >= 0;
function requireFact(value: boolean) { if (!value) throw new Error('Inconsistent native work observation'); }

function summaryFacts(value: WorkSummaryObservation, projectId: string, observedAt: string) {
  requireFact(value.projectId === projectId && value.observedAt === observedAt);
  for (const group of WORK_GROUPS) requireFact(count(value.all[group]) && count(value.mine[group]) && value.mine[group] <= value.all[group]);
  requireFact(value.mine.needs === value.all.needs && value.mine.rules === 0);
  requireFact(value.workTotal === value.all.in_progress + value.all.blocked + value.all.open + value.all.parked + value.all.finished);
  requireFact(value.unfinishedTotal === value.all.in_progress + value.all.blocked + value.all.open);
  const active = value.state.active;
  requireFact(active.count === value.all.in_progress && value.state.blocked.count === value.all.blocked);
  requireFact(count(active.ownerTotal) && active.ownerTotal <= active.count && active.owners.length <= WORK_READ_LIMITS.owners && active.owners.length <= active.ownerTotal);
  requireFact(new Set(active.owners.map((owner) => `${owner.kind}:${owner.id}`)).size === active.owners.length);
  requireFact((active.count === 0) === (active.first === null) && (value.state.blocked.count === 0) === (value.state.blocked.first === null));
}

function rowFacts(rows: readonly NativeWorkRow[], projectId: string, workspaceId: string) {
  requireFact(new Set(rows.map((row) => `${row.kind}:${row.id}`)).size === rows.length);
  for (const row of rows) requireFact(row.projectId === projectId && row.workspaceId === workspaceId && row.audience.kind === 'project' && row.audience.projectId === projectId && !('links' in row));
}

/** Read orchestration owns validation, global windows, coherent observations and the final fence. */
export function createBoundedWorkReads(unit: WorkReadUnitOfWork, finalFence: WorkReadFinalFence) {
  async function observe<T>(principal: PrincipalRef, projectId: string,
    read: (ports: WorkReadPorts, observedAt: string, workspaceId: string) => Promise<T>, required?: WorkReadRequirements) {
    const sources = required?.sources;
    let observation: { value: T; sourceVisibility: string };
    try {
      observation = await unit.run(async (ports) => {
        const access = await ports.access.requireProject(principal, projectId);
        if (sources) await ports.rows.requireSources(projectId, sources);
        const observedAt = await ports.rows.observedAt();
        const sourceVisibility = await ports.rows.sourceVisibilityFingerprint(projectId, sources);
        requireFact(/^[0-9a-f]{64}$/.test(sourceVisibility));
        return { value: await read(ports, observedAt, access.workspaceId), sourceVisibility };
      });
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new ServiceUnavailableError('Native work could not be read', 'WORK_READ_UNAVAILABLE');
    }
    // Deliberately outside the read transaction; the adapter re-resolves the exact session.
    try {
      const access = await finalFence.check(principal, projectId, observation.sourceVisibility, required);
      return { value: observation.value, access };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new ServiceUnavailableError('Current work access could not be checked', 'WORK_READ_UNAVAILABLE');
    }
  }

  return {
    async summary(principal: Principal, rawProjectId: string, query = new URLSearchParams()): Promise<ProjectWorkSummary> {
      const actor = caller(principal), projectId = workReadId(rawProjectId);
      assertEmptyWorkReadQuery(new URLSearchParams(query));
      const response = await observe(actor, projectId, async ({ rows }, observedAt) => {
        const summary = await rows.summary(projectId, actor);
        summaryFacts(summary, projectId, observedAt);
        return summary;
      });
      return { ...response.value, access: response.access };
    },

    async view(principal: Principal, rawProjectId: string, query: URLSearchParams): Promise<ProjectWorkView> {
      const actor = caller(principal), projectId = workReadId(rawProjectId);
      const input = parseWorkViewRead(new URLSearchParams(query));
      const scope = workReadScope('work-view', projectId, actor, input.selection, input.limit);
      const cursor = decodeWorkReadCursor(input.cursor, scope);
      const response = await observe(actor, projectId, async ({ rows }, observedAt, workspaceId) => {
        const slice = await rows.view(projectId, actor, input.selection, input.limit, cursor);
        const page = presentWorkReadPage(slice, input.limit, scope, cursor);
        rowFacts(page.items, projectId, workspaceId);
        const summary = await rows.summary(projectId, actor);
        summaryFacts(summary, projectId, observedAt);
        const selectedId = input.selection.purpose === 'choices' && input.selection.choice === 'result_work' ? input.selection.selected : undefined;
        const selected = selectedId ? await rows.selectedWork(projectId, selectedId) : null;
        if (selected) {
          requireFact(selected.kind === 'work' && selected.id === selectedId);
          rowFacts([selected], projectId, workspaceId);
        }
        return { ...page, summary, selected };
      }, input.selection.purpose !== 'choices' ? undefined : input.selection.choice === 'parked_work'
        ? { parkedDecisionId: input.selection.decisionId } : input.selection.choice === 'result_work' && input.selection.selected
          ? { objects: [{ kind: 'work', id: input.selection.selected }] } : undefined);
      return { ...response.value, summary: { ...response.value.summary, access: response.access } };
    },

    async associations(principal: Principal, rawProjectId: string, query: URLSearchParams): Promise<WorkAssociations> {
      const actor = caller(principal), projectId = workReadId(rawProjectId);
      const input = parseWorkAssociationRead(new URLSearchParams(query));
      const scope = workReadScope('work-associations', projectId, actor, input.selection, input.limit);
      const cursor = decodeWorkReadCursor(input.cursor, scope);
      const sourceScope = workReadScope('work-association-sources', projectId, actor, input.selection, WORK_READ_LIMITS.sourceIds);
      const sourceCursor = decodeWorkReadCursor(input.sourceCursor, sourceScope);
      const response = await observe(actor, projectId, async ({ rows }, observedAt, workspaceId) => {
        const page = presentWorkReadPage(await rows.associationObjects(projectId, input.selection, input.limit, cursor), input.limit, scope, cursor);
        rowFacts(page.items, projectId, workspaceId);
        const objects = page.items.map(({ kind, id }) => ({ kind, id }));
        const edgeScope = workReadScope('work-association-edges', projectId, actor, input.selection, input.limit, objects);
        const edgeCursor = decodeWorkReadCursor(input.edgeCursor, edgeScope);
        const edges = presentWorkReadPage(await rows.associationEdges(projectId, input.selection, objects, input.limit, edgeCursor), input.limit, edgeScope, edgeCursor);
        const sources = presentWorkReadPage(await rows.associationSources(projectId, input.selection, sourceCursor), WORK_READ_LIMITS.sourceIds, sourceScope, sourceCursor);
        requireFact(new Set(sources.items.map((source) => source.messageId)).size === sources.items.length);
        for (const source of sources.items) requireFact([source.work, source.decisions, source.results, source.edges].every(count));
        if ('messageIds' in input.selection) requireFact(sources.total === input.selection.messageIds.length && sources.before === 0 && !sources.nextCursor && !sources.previousCursor && sources.items.length === input.selection.messageIds.length && sources.items.every((source) => 'messageIds' in input.selection && input.selection.messageIds.includes(source.messageId)));
        const edgeTotal = await rows.associationEdgeTotal(projectId, input.selection);
        requireFact(count(edgeTotal) && edges.total <= edgeTotal);
        for (const edge of edges.items) requireFact(edge.projectId === projectId && edge.to.type === 'message' && objects.some((object) => object.kind === edge.from.type && object.id === edge.from.id) && (input.selection.relation === 'any' || edge.role === 'source'));
        return { ...page, observedAt, sources: sources.items, sourceTotal: sources.total,
          sourceNextCursor: sources.nextCursor, sourcePreviousCursor: sources.previousCursor, edges, edgeTotal };
      }, { sources: input.selection });
      return response.value;
    },

    async relations(principal: Principal, rawProjectId: string, query: URLSearchParams): Promise<WorkRelations> {
      const actor = caller(principal), projectId = workReadId(rawProjectId);
      const input = parseWorkRelationRead(new URLSearchParams(query));
      const scope = workReadScope('work-relations', projectId, actor, input.selection, input.limit);
      const cursor = decodeWorkReadCursor(input.cursor, scope);
      const response = await observe(actor, projectId, async ({ rows }, observedAt) => {
        const result = await rows.relations(projectId, input.selection, input.limit, cursor);
        requireFact(result.observedAt === observedAt);
        const page = presentWorkReadPage(result.page, input.limit, scope, cursor);
        for (const edge of page.items) requireFact(edge.projectId === projectId && (!input.selection.role || edge.role === input.selection.role) && input.selection.objects.some((object) => (edge.from.type === object.kind && edge.from.id === object.id) || (edge.to.type === object.kind && edge.to.id === object.id)));
        return { ...page, observedAt };
      }, { objects: input.selection.objects });
      return response.value;
    },

    async detail(principal: Principal, rawProjectId: string, kind: string, id: string, query = new URLSearchParams()): Promise<WorkDetailProjection> {
      const actor = caller(principal), projectId = workReadId(rawProjectId);
      const object = { kind: workReadKind(kind), id: workReadId(id) };
      assertEmptyWorkReadQuery(new URLSearchParams(query));
      const response = await observe(actor, projectId, async ({ rows }, observedAt, workspaceId) => {
        const detail = await rows.detail(projectId, object);
        requireFact(detail.observedAt === observedAt && detail.object.kind === object.kind && detail.object.id === object.id && detail.object.projectId === projectId && detail.object.workspaceId === workspaceId && detail.object.audience.kind === 'project' && detail.object.audience.projectId === projectId && !('links' in detail.object) && detail.context.length <= 3);
        return detail;
      }, { objects: [object] });
      return { ...response.value, access: response.access };
    },
  };
}
