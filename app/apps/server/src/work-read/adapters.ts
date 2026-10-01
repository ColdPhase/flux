import type { IncomingHttpHeaders } from 'node:http';
import { nativeWorkReadKeys, nativeWorkObjectRows, nativeWorkVisibilityRows, nativeWorkSummaryRows, nativeWorkAssociationRows, type DbExecutor, type NativeReadKeyPage } from '@flux/db';
import {
  accessName, createBoundedWorkReads, DomainError, enforce, evaluateProject, NotFoundError,
  type Database, type Principal, type WorkReadAccess, type WorkReadFinalFence,
  type WorkReadRepository, type WorkReadUnitOfWork,
} from '@flux/core';
import type { WorkObjectType } from '@flux/contracts';
import type { SessionContext, SessionResolver } from '../identity/index.js';

export function nativeWorkReadAccess(db: DbExecutor): WorkReadAccess {
  return { requireProject: async (principal, projectId) => {
    const checked = enforce(await evaluateProject(principal, 'project.read', projectId, db), 'project');
    const access = accessName(checked.level);
    if (!access || !checked.project) throw new NotFoundError('Project', 'PROJECT_NOT_FOUND');
    return { workspaceId: checked.project.workspaceId, access };
  } };
}
const boundary = (key: { rank: number; createdAt: string; id: string }) => ({ rank: key.rank, createdAt: key.createdAt, id: key.id });

/** No legacy links()/whole-list presenter: only bounded keys and native scalar/batch queries. */
export function nativeWorkReadRepository(db: DbExecutor): WorkReadRepository {
  const keys = nativeWorkReadKeys(db), objects = nativeWorkObjectRows(db), visibility = nativeWorkVisibilityRows(db), summary = nativeWorkSummaryRows(db), associations = nativeWorkAssociationRows(db);
  const requireObjects = async (projectId: string, refs: Parameters<typeof associations.objectsExist>[1]) => {
    if (!await associations.objectsExist(projectId, refs)) throw new NotFoundError('Work object', 'WORK_OBJECT_NOT_FOUND');
  };
  const hydrate = async (projectId: string, page: NativeReadKeyPage<WorkObjectType>) => {
    const rows = await objects.rows(projectId, page.items.map(({ kind, id }) => ({ kind, id })));
    return { ...page, items: page.items.map((key, i) => ({ key: boundary(key), value: rows[i]! })) };
  };
  const hydrateEdges = async (projectId: string, page: NativeReadKeyPage<'edge'>) => {
    const rows = await associations.edges(projectId, page.items.map(({ id }) => id));
    return { ...page, items: page.items.map((key, i) => ({ key: boundary(key), value: rows[i]! })) };
  };
  return {
    sourceVisibilityFingerprint: visibility.fingerprint,
    summary: summary.summary, observedAt: summary.observedAt,
    async view(projectId, principal, selection, limit, cursor) {
      if (selection.purpose === 'choices' && selection.choice === 'parked_work') {
        const decision = await objects.decision(projectId, selection.decisionId);
        if (!decision || decision.status === 'proposed') throw new NotFoundError('Decision', 'DECISION_NOT_FOUND');
      }
      if (selection.purpose === 'choices' && selection.choice === 'result_work' && selection.selected) await requireObjects(projectId, [{ kind: 'work', id: selection.selected }]);
      return hydrate(projectId, await keys.view(projectId, principal, selection, limit, cursor));
    },
    async selectedWork(projectId, id) { await requireObjects(projectId, [{ kind: 'work', id }]); return (await objects.rows(projectId, [{ kind: 'work', id }]))[0]!; },
    async detail(projectId, ref) {
      const object = await objects.detail(projectId, ref);
      if (!object) throw new NotFoundError('Work object', 'WORK_OBJECT_NOT_FOUND');
      const [facts] = await visibility.relations(projectId, [ref]);
      if (!facts) throw new Error('Missing native detail counts');
      const refs = object.kind === 'decision' ? [object.supersedes, object.supersededBy] : object.kind === 'work' ? [object.parked?.decisionId ?? null] : [];
      return { object, observedAt: await summary.observedAt(), relations: { edges: facts.edges, sourceMessages: facts.sourceMessages, sourceMaterials: facts.sourceMaterials, decisions: facts.decisions, results: facts.results },
        context: await objects.decisionRefs(projectId, refs.filter((id): id is string => id !== null)) };
    },
    async relations(projectId, selection, limit, cursor) {
      await requireObjects(projectId, selection.objects);
      return { page: await hydrateEdges(projectId, await associations.relationKeys(projectId, selection, limit, cursor)), observedAt: await summary.observedAt() };
    },
    async requireSources(projectId, selection) {
      if (!await associations.sourcesExist(projectId, selection)) throw new NotFoundError('Source', 'WORK_SOURCE_NOT_FOUND');
    },
    async associationObjects(projectId, selection, limit, cursor) { return hydrate(projectId, await associations.objectKeys(projectId, selection, limit, cursor)); },
    associationSources: associations.sourceCounts,
    async associationEdges(projectId, selection, refs, limit, cursor) { return hydrateEdges(projectId, await associations.associationEdgeKeys(projectId, selection, refs, limit, cursor)); },
    associationEdgeTotal: associations.edgeTotal,
  };
}

export function nativeWorkReadUnitOfWork(db: Database): WorkReadUnitOfWork {
  return { run: (read) => db.transaction((tx) => read({ access: nativeWorkReadAccess(tx), rows: nativeWorkReadRepository(tx) }), { isolationLevel: 'repeatable read', accessMode: 'read only' }) };
}

/** Per-request exact session binding. Neither cookie cache nor the snapshot is authority. */
export function nativeWorkReadFinalFence(db: Database, sessions: SessionResolver, initial: SessionContext, headers: IncomingHttpHeaders): WorkReadFinalFence {
  const sessionId = initial.sessionId, actor = { ...initial.principal }, cookie = headers.cookie;
  const requireSession = async (principal: Principal) => {
    const current = await sessions.resolveSession({ cookie });
    if (!current || current.sessionId !== sessionId || current.principal.kind !== actor.kind || current.principal.id !== actor.id || principal.kind !== actor.kind || principal.id !== actor.id)
      throw new DomainError(401, 'UNAUTHENTICATED', 'Authentication required');
  };
  return { check: async (principal, projectId, fingerprint, sources) => {
    await requireSession(principal);
    await nativeWorkReadAccess(db).requireProject(principal, projectId);
    if (sources) await nativeWorkReadRepository(db).requireSources(projectId, sources);
    const current = await nativeWorkVisibilityRows(db).fingerprint(projectId, sources);
    if (current !== fingerprint) throw new DomainError(409, 'work_read_changed', 'Work sources changed; refresh this view');
    // Re-resolve after the potentially substantial current visibility query.
    await requireSession(principal);
    return (await nativeWorkReadAccess(db).requireProject(principal, projectId)).access;
  } };
}

export const nativeWorkReadUseCases = (db: Database, sessions: SessionResolver, initial: SessionContext, headers: IncomingHttpHeaders) =>
  createBoundedWorkReads(nativeWorkReadUnitOfWork(db), nativeWorkReadFinalFence(db, sessions, initial, headers));
