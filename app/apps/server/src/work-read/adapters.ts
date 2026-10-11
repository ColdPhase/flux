import type { IncomingHttpHeaders } from 'node:http';
import { githubRows, nativeWorkReadKeys, nativeWorkObjectRows, nativeWorkReferenceRows, nativeWorkThoughtRows, nativeWorkVisibilityRows, nativeWorkSummaryRows, nativeWorkAssociationRows, workRows, type DbExecutor, type NativeReadKeyPage, type NativeWorkDetailObject } from '@flux/db';
import {
  accessName, createBoundedWorkReads, DomainError, enforce, evaluateProject, NotFoundError, presentGithubRule,
  type Database, type Principal, type WorkReadAccess, type WorkReadFinalFence,
  type WorkReadRepository, type WorkReadUnitOfWork,
} from '@flux/core';
import type { NamedPrincipal, NativeWorkRow, WorkDetailObject, WorkObjectType } from '@flux/contracts';
import type { SessionContext, SessionResolver } from '../identity/index.js';
import { projectAuthorOwners } from '../conversation/author-owners.js';

export function nativeWorkReadAccess(db: DbExecutor): WorkReadAccess {
  return { requireProject: async (principal, projectId) => {
    const checked = enforce(await evaluateProject(principal, 'project.read', projectId, db), 'project');
    const access = accessName(checked.level);
    if (!access || !checked.project) throw new NotFoundError('Project', 'PROJECT_NOT_FOUND');
    return { workspaceId: checked.project.workspaceId, access };
  } };
}
const boundary = (key: { rank: number; createdAt: string; id: string }) => ({ rank: key.rank, createdAt: key.createdAt, id: key.id });

/** The principals a native row names, in the fields the overview and task details present. */
function namedPrincipals(item: NativeWorkRow | NativeWorkDetailObject): (NamedPrincipal | null)[] {
  switch (item.kind) {
    case 'work': return [item.owner, ...('createdBy' in item ? [item.createdBy] : [])];
    case 'decision': return [item.proposedBy, item.decidedBy];
    case 'result': return [item.createdBy];
  }
}

/**
 * Agents named by a native row carry their owner only from the current authorized project audience
 * (#339 AC-2), the same boundary as preserved message history (`projectAuthorOwners`). A revoked
 * agent keeps its name; its owner is shown only while that human still has project read access.
 */
async function withAgentOwners<T extends NativeWorkRow | NativeWorkDetailObject>(db: DbExecutor, items: T[]): Promise<T[]> {
  const agents = [...new Set(items.flatMap((item) => namedPrincipals(item).flatMap((who) => who?.kind === 'agent' ? [who.id] : [])))];
  if (!items.length || !agents.length) return items;
  // Native rows are bounded to 100 per read and each names at most two agents, so the helper's window holds.
  const { projectId, workspaceId } = items[0]!;
  const owners = await projectAuthorOwners(db, projectId, workspaceId, agents);
  const scope = (who: NamedPrincipal): NamedPrincipal => {
    const projectOwner = who.kind === 'agent' ? owners.get(who.id) : undefined;
    return projectOwner ? { ...who, projectOwner } : who;
  };
  const scopeOne = (who: NamedPrincipal | null) => who ? scope(who) : null;
  return items.map((item) => {
    switch (item.kind) {
      case 'work': return { ...item, owner: scopeOne(item.owner), ...('createdBy' in item ? { createdBy: scope(item.createdBy) } : {}) } as T;
      case 'decision': return { ...item, proposedBy: scope(item.proposedBy), decidedBy: scopeOne(item.decidedBy) } as T;
      case 'result': return { ...item, createdBy: scope(item.createdBy) } as T;
    }
  });
}

/** A task's "Let linked PRs move this task" rule (#74 G-1a) is part of its native detail, presented as for every reader. */
async function withGithubRule(db: DbExecutor, object: NativeWorkDetailObject): Promise<WorkDetailObject> {
  if (object.kind !== 'work') return object;
  const rule = (await githubRows(db).taskRules([object.id])).get(object.id);
  if (!rule) return { ...object, githubRule: null };
  const author = rule.authorUserId;
  const names = author ? await workRows(db).names([{ kind: 'human', id: author }]) : new Map<string, string>();
  return { ...object, githubRule: { ...presentGithubRule(rule, { version: object.version, status: object.status, blocker: object.blocker, parked: !!object.parked }),
    setUpBy: author ? { kind: 'human', id: author, name: names.get(`human:${author}`) ?? 'Former member' } : null } };
}

/** No legacy links()/whole-list presenter: only bounded keys and native scalar/batch queries. */
export function nativeWorkReadRepository(db: DbExecutor): WorkReadRepository {
  const keys = nativeWorkReadKeys(db), objects = nativeWorkObjectRows(db), visibility = nativeWorkVisibilityRows(db), summary = nativeWorkSummaryRows(db), associations = nativeWorkAssociationRows(db);
  const requireObjects = async (projectId: string, refs: Parameters<typeof associations.objectsExist>[1]) => {
    if (!await associations.objectsExist(projectId, refs)) throw new NotFoundError('Work object', 'WORK_OBJECT_NOT_FOUND');
  };
  const hydrate = async (projectId: string, page: NativeReadKeyPage<WorkObjectType>) => {
    const rows = await withAgentOwners(db, await objects.rows(projectId, page.items.map(({ kind, id }) => ({ kind, id }))));
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
    async selectedWork(projectId, id) { await requireObjects(projectId, [{ kind: 'work', id }]); return (await withAgentOwners(db, await objects.rows(projectId, [{ kind: 'work', id }])))[0]!; },
    async references(projectId, refs) {
      const requested = refs.map((ref) => ({ ...ref }));
      const available = await nativeWorkReferenceRows(db).available(projectId, requested);
      const found = new Set(available.map(({ kind, id }) => `${kind}:${id}`));
      return { items: await withAgentOwners(db, await objects.rows(projectId, available)), unavailable: requested.filter(({ kind, id }) => !found.has(`${kind}:${id}`)) };
    },
    thoughtTasks: (projectId, thoughtIds) => nativeWorkThoughtRows(db).observe(projectId, thoughtIds),
    async detail(projectId, ref) {
      const found = await objects.detail(projectId, ref);
      if (!found) throw new NotFoundError('Work object', 'WORK_OBJECT_NOT_FOUND');
      const [own] = await withAgentOwners(db, [found]);
      const object = await withGithubRule(db, own!);
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
  return { check: async (principal, projectId, fingerprint, required) => {
    await requireSession(principal);
    await nativeWorkReadAccess(db).requireProject(principal, projectId);
    const sources = required?.sources;
    if (sources) await nativeWorkReadRepository(db).requireSources(projectId, sources);
    if (required?.objects && !await nativeWorkAssociationRows(db).objectsExist(projectId, required.objects)) throw new NotFoundError('Work object', 'WORK_OBJECT_NOT_FOUND');
    if (required?.parkedDecisionId) {
      const decision = await nativeWorkObjectRows(db).decision(projectId, required.parkedDecisionId);
      if (!decision || decision.status === 'proposed') throw new NotFoundError('Decision', 'DECISION_NOT_FOUND');
    }
    if (required?.references) {
      const { objects, available } = required.references;
      const current = await nativeWorkReferenceRows(db).available(projectId, objects);
      if (current.length !== available.length || current.some((ref, i) => ref.kind !== available[i]?.kind || ref.id !== available[i]?.id))
        throw new DomainError(409, 'work_read_changed', 'Work changed; refresh this view');
    }
    if (required?.thoughts) {
      const { requested, visible } = required.thoughts;
      const current = await nativeWorkThoughtRows(db).visible(projectId, requested);
      if (current.length !== visible.length || current.some((id, i) => id !== visible[i]))
        throw new DomainError(409, 'work_read_changed', 'Thoughts changed; refresh this view');
    }
    const current = await nativeWorkVisibilityRows(db).fingerprint(projectId, sources);
    if (current !== fingerprint) throw new DomainError(409, 'work_read_changed', 'Work sources changed; refresh this view');
    // Bracket the final current policy query with exact native session checks.
    await requireSession(principal);
    const access = await nativeWorkReadAccess(db).requireProject(principal, projectId);
    await requireSession(principal);
    return access.access;
  } };
}

export const nativeWorkReadUseCases = (db: Database, sessions: SessionResolver, initial: SessionContext, headers: IncomingHttpHeaders) =>
  createBoundedWorkReads(nativeWorkReadUnitOfWork(db), nativeWorkReadFinalFence(db, sessions, initial, headers));
