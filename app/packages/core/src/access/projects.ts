import { randomUUID } from 'node:crypto';
import { PROJECT_TEMPLATES, PROJECT_VIEWS, TEMPLATE_VIEWS } from '@flux/contracts';
import type { AddProjectViewCommand, CreateProjectCommand, Page, PageQuery, Project, ProjectPerson, ProjectViewId } from '@flux/contracts';
import { recordEvent } from '../events.js';
import { presentProjectGoal } from '../project-goals/service.js';
import type { Database, Executor, Principal } from '../types.js';
import { eventPorts, type DomainEventSink } from './common.js';
import { enforce, evaluateProject, evaluateWorkspace, accessName, LEVEL } from './policy.js';
import type { AccessPorts } from './repositories.js';
import type { ProjectRecord } from './records.js';
import { oneOf, name, parsePage, PROJECT_VISIBILITIES } from './validation.js';

// Projects: create, add a view, list, read and the audience (issues #46, #91). Grants are in ./grants.ts.

type ProjectPorts = Pick<AccessPorts, 'projects' | 'access' | 'events'>;

export function toProject(row: ProjectRecord, level: number, goal: Project['goal'] = null): Project {
  const access = accessName(level);
  if (!access) throw new Error('Invisible project serialized');
  return { id: row.id, workspaceId: row.workspaceId, name: row.name, visibility: row.visibility, access, views: row.views as ProjectViewId[], goal, version: row.version, createdAt: row.createdAt.toISOString() };
}

/** The goal each project shows (#520): its current goal, or else its most recently reached one. */
async function shownGoals(db: Executor, ports: Pick<AccessPorts, 'projects'>, projectIds: string[]): Promise<Map<string, Project['goal']>> {
  const rows = await ports.projects(db).shownGoals(projectIds);
  return new Map([...rows].map(([id, row]) => [id, presentProjectGoal(row)]));
}

export async function createProject(principal: Principal, workspaceId: string, command: CreateProjectCommand, db: Database, ports: ProjectPorts, eventSink?: DomainEventSink): Promise<Project> {
  const projectName = name(command?.name);
  const visibility = command.visibility === undefined ? 'workspace' : oneOf(command.visibility, PROJECT_VISIBILITIES, 'visibility');
  // Without a template (the API, agents, a promoted sketch) a project shows every view, as every project did before (#351).
  const template = command.template === undefined ? null : oneOf(command.template, PROJECT_TEMPLATES, 'template');
  return db.transaction(async (tx) => {
    enforce(await evaluateWorkspace(principal, 'project.create', workspaceId, ports.access(tx), { lock: true }), 'workspace');
    const id = randomUUID();
    const row = await ports.projects(tx).insert({ id, workspaceId, name: projectName, visibility, views: [...(template ? TEMPLATE_VIEWS[template] : PROJECT_VIEWS)], createdBy: principal.id });
    if (eventSink) await eventSink.record(principal, workspaceId, 'project.created.v1', id, { visibility });
    else await recordEvent(eventPorts(ports, tx), principal, workspaceId, 'project.created.v1', id, { visibility });
    return toProject(row, LEVEL.manager);
  });
}

/** Adds an optional view (Map, Wiki or Agents) to a project; whoever can write there may (#351). */
export async function addProjectView(principal: Principal, projectId: string, command: AddProjectViewCommand, db: Database, ports: ProjectPorts): Promise<Project> {
  const view = oneOf(command?.view, PROJECT_VIEWS, 'view');
  return db.transaction(async (tx) => {
    // The same exclusive project lock a grant change takes, before the read: two additions then queue and
    // the second reads the first's array, instead of both holding FOR SHARE and deadlocking on the update.
    await ports.projects(tx).lockForGrantChange(projectId);
    const { project, level } = enforce(await evaluateProject(principal, 'project.write', projectId, ports.access(tx), { lock: true }), 'project');
    const goal = (await shownGoals(tx, ports, [projectId])).get(projectId) ?? null;
    if (project!.views.includes(view)) return toProject(project!, level, goal);
    const row = await ports.projects(tx).setViews(projectId, [...project!.views, view]);
    await recordEvent(eventPorts(ports, tx), principal, project!.workspaceId, 'project.view_added.v1', projectId, { view });
    return toProject(row, level, goal);
  });
}

/** Projects the principal can see, filtered before count and pagination. */
export async function listProjects(principal: Principal, workspaceId: string, query: PageQuery, db: Database, ports: ProjectPorts): Promise<Page<Project>> {
  const page = parsePage(query);
  const { actor } = enforce(await evaluateWorkspace(principal, 'workspace.read', workspaceId, ports.access(db)), 'workspace');
  const { total, rows } = await ports.projects(db).listVisible(actor, page);
  const goals = await shownGoals(db, ports, rows.map((row) => row.project.id));
  return { items: rows.map((row) => toProject(row.project, row.level, goals.get(row.project.id) ?? null)), total, ...page };
}

export async function getProject(principal: Principal, projectId: string, db: Database, ports: ProjectPorts): Promise<Project> {
  const { project, level } = enforce(await evaluateProject(principal, 'project.read', projectId, ports.access(db)), 'project');
  return toProject(project!, level, (await shownGoals(db, ports, [projectId])).get(projectId) ?? null);
}

/**
 * The audience of a project (#117): every person and agent who can read it now. The caller
 * needs `project.read`. Each candidate's level is decided by the access policy itself
 * (`evaluateProject`), never re-derived here, so a deny, a revoked agent or a removed
 * member is left out exactly as on their own next request. The candidates are the
 * workspace's members and agents; a project that nobody else can read lists only its managers.
 */
export async function listProjectPeople(principal: Principal, projectId: string, db: Database, ports: ProjectPorts): Promise<ProjectPerson[]> {
  const { project } = enforce(await evaluateProject(principal, 'project.read', projectId, ports.access(db)), 'project');
  const workspaceId = project!.workspaceId;
  const projects = ports.projects(db);
  const humans = await projects.members(workspaceId);
  const agents = await projects.audienceAgents(principal, projectId, workspaceId);
  const candidates = [
    ...humans.map((row) => ({ kind: 'human' as const, id: row.id, name: row.name })),
    ...agents.map((row) => ({ kind: 'agent' as const, id: row.id, name: row.name })),
  ];
  const people: ProjectPerson[] = [];
  for (const candidate of candidates) {
    const decision = await evaluateProject({ kind: candidate.kind, id: candidate.id }, 'project.read', projectId, ports.access(db));
    const access = decision.allowed ? accessName(decision.level) : null;
    if (access) people.push({ ...candidate, access });
  }
  // Owner names reuse the authorized audience, never the workspace candidate roster.
  const visibleHumans = new Map(people.filter((person) => person.kind === 'human').map((person) => [person.id, person.name]));
  for (const person of people) {
    if (person.kind !== 'agent') continue;
    const agent = agents.find((candidate) => candidate.id === person.id)!;
    if (!agent.ownerUserId) person.agentOwner = { kind: 'workspace' };
    else {
      const name = visibleHumans.get(agent.ownerUserId);
      if (name) person.agentOwner = { kind: 'human', id: agent.ownerUserId, name };
    }
  }
  return people.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) || a.id.localeCompare(b.id) : a.kind === 'human' ? -1 : 1));
}
