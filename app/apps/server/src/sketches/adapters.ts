import { sketchRows, type DbExecutor } from '@flux/db';
import type { PromotionPerson } from '@flux/contracts';
import {
  authorize,
  createProject,
  createSketchUseCases,
  ForbiddenError,
  getProject,
  grantProject,
  listMembers,
  listProjectPeople,
  listProjects,
  policySketchAccess,
  recordEvent,
  RuleViolationError,
  visibleFilter,
  type Database,
  type Principal,
  type SketchPorts,
  type SketchPromotion,
  type SketchRepository,
  type SketchUnitOfWork,
  type Transaction,
} from '@flux/core';
import type { TransactionEventSession } from '../work/transaction-events.js';

// Adapters that connect the core sketch use cases to Drizzle, the access policy and the event
// log (issue #69; #46: core defines the ports, the server assembles them).

function author(principal: Principal): { kind: 'human' | 'agent'; id: string } {
  if (principal.kind === 'fixture') throw new Error('A fixture principal cannot author sketch content');
  return { kind: principal.kind, id: principal.id };
}

export function sketchRepository(db: DbExecutor): SketchRepository {
  const rows = sketchRows(db);
  return {
    ...rows,
    /** The policy's own list condition (`visibleFilter`) is applied before the limit and in the total. */
    async listVisible(principal, workspaceId, filter, page) {
      return rows.list(workspaceId, await visibleFilter(principal, workspaceId, 'sketch', db), filter, page);
    },
    insertSketch: (sketch) => rows.insertSketch({ ...sketch, createdBy: author(sketch.createdBy) }),
    insertThought: (thought) => rows.insertThought({ ...thought, createdBy: author(thought.createdBy) }),
    insertLink: (link) => rows.insertLink({ ...link, createdBy: author(link.createdBy) }),
  };
}

const isManager = (role: string) => role === 'owner' || role === 'admin';

/**
 * Promotion of a DM sketch (#96) through the core project use cases, so every check, grant and
 * event is theirs: `project.create` for a new project, `project.write` for an existing one, and
 * the project's people from `listProjectPeople` (the access policy per person).
 */
export function sketchPromotion(tx: Database): SketchPromotion {
  return {
    async targets(principal, workspaceId) {
      const create = await authorize(principal, 'project.create', { type: 'workspace', id: workspaceId }, tx);
      const projects: { id: string; name: string }[] = [];
      for (let offset = 0; ; offset += 100) {
        const page = await listProjects(principal, workspaceId, { limit: 100, offset }, tx);
        projects.push(...page.items.filter((p) => p.access === 'contributor' || p.access === 'manager').map((p) => ({ id: p.id, name: p.name })));
        if (offset + page.items.length >= page.total || !page.items.length) break;
      }
      projects.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      return { canCreateProject: create.allowed, projects };
    },

    async audience(principal, workspaceId, participants, target) {
      if (target.kind === 'existing') {
        const project = await getProject(principal, target.projectId, tx);
        if (project.workspaceId !== workspaceId) throw new RuleViolationError('The project belongs to another workspace', 'CROSS_WORKSPACE');
        if (project.access === 'viewer') throw new ForbiddenError('Not allowed to perform this action on the project');
        const people = await listProjectPeople(principal, project.id, tx);
        return { people: people.map((p): PromotionPerson => ({ kind: p.kind, id: p.id, name: p.name, reason: 'project' })), projectName: project.name };
      }
      // A new restricted project: read by its grantees (the participants) and by the workspace's
      // owners and admins, who manage every project. No agent has a grant on it.
      const inDm = new Set(participants.map((p) => p.id));
      const people = (await listMembers(principal, workspaceId, tx))
        .filter((m) => inDm.has(m.userId) || isManager(m.role))
        .map((m): PromotionPerson => ({ kind: 'human', id: m.userId, name: m.name, reason: inDm.has(m.userId) ? 'participant' : 'manager' }))
        .sort((a, b) => Number(a.reason !== 'participant') - Number(b.reason !== 'participant') || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      return { people, projectName: null };
    },

    async createProject(principal, workspaceId, name, participantIds) {
      const project = await createProject(principal, workspaceId, { name, visibility: 'restricted' }, tx);
      const roles = new Map((await listMembers(principal, workspaceId, tx)).map((m) => [m.userId, m.role]));
      for (const id of participantIds) {
        const role = roles.get(id);
        if (!role || isManager(role)) continue;
        await grantProject(principal, project.id, { principal: { kind: 'human', id }, role: 'contributor' }, tx);
      }
      return { id: project.id, name: project.name };
    },
  };
}

/** The ports of one unit of work (exported for the concurrency tests). */
export function sketchPorts(tx: Database): SketchPorts {
  return {
    access: policySketchAccess(tx),
    sketches: sketchRepository(tx as DbExecutor),
    promotion: sketchPromotion(tx),
    events: { record: async (principal, workspaceId, kind, sketchId, data) => { await recordEvent(tx, principal, workspaceId, kind, sketchId, data); } },
  };
}

/** One transaction per use case; on an open transaction (an idempotency scope) it nests as a savepoint. */
export function sketchUnitOfWork(db: Database): SketchUnitOfWork {
  return { run: (work) => db.transaction((tx) => work(sketchPorts(tx))) };
}

/** The sketch use cases bound to a connection or transaction. */
export const sketchUseCases = (db: Database) => createSketchUseCases(sketchUnitOfWork(db));

/** Sketch commands sharing a composing caller's transaction and single final event batch (#152 map actions). */
export function nativeSketchInEventSession(tx: Transaction, session: TransactionEventSession) {
  const ports: SketchPorts = { ...sketchPorts(tx), events: session };
  return createSketchUseCases({ run: (action) => session.run(() => action(ports)) });
}
