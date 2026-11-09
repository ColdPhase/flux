import { randomUUID } from 'node:crypto';
import type { CreateProjectCommand, Page, PageQuery, Project, ProjectPerson, ProjectVisibility, RenameProjectCommand, SpaceAiState } from '@flux/contracts';
import { recordEvent } from '../events.js';
import type { Database, Executor, Principal } from '../types.js';
import { eventPorts, type DomainEventSink } from './common.js';
import { ConflictError, InvalidInputError, RuleViolationError } from './errors.js';
import { enforce, evaluateProject, evaluateWorkspace, accessName, LEVEL } from './policy.js';
import type { AccessPorts } from './repositories.js';
import type { ProjectRecord } from './records.js';
import { oneOf, name, parsePage, PROJECT_VISIBILITIES } from './validation.js';

// Projects, which people call spaces (F-037, #874): create, list, read and the audience (issues #46, #91).
// A space's people are its grants (./grants.ts): `manager` is a space admin, `contributor` a space member.

type ProjectPorts = Pick<AccessPorts, 'projects' | 'workspaces' | 'access' | 'events'>;

/** `ai` is the space's switch; a missing row reads as off (fail closed). */
export function toProject(row: ProjectRecord, level: number, ai: SpaceAiState | null): Project {
  const access = accessName(level);
  if (!access) throw new Error('Invisible project serialized');
  return { id: row.id, workspaceId: row.workspaceId, name: row.name, visibility: row.visibility, access, ai: ai ?? 'blocked',
    version: row.version, createdAt: row.createdAt.toISOString() };
}

async function aiOf(db: Executor, ports: Pick<AccessPorts, 'projects'>, projectId: string): Promise<SpaceAiState> {
  return (await ports.projects(db).aiPolicies([projectId]))[0]?.state ?? 'blocked';
}

/**
 * Writes a new space and makes its creator its first space admin (F-037). Every space shows Conversation, Tasks,
 * Map and Wiki; there are no templates, no goal and nothing stored about which views it has. The caller has authorized `project.create` in this transaction.
 */
export async function insertSpace(tx: Executor, ports: Pick<AccessPorts, 'projects'>, row: { workspaceId: string; name: string; visibility: ProjectVisibility; createdBy: string }): Promise<ProjectRecord> {
  const projects = ports.projects(tx);
  const project = await projects.insert({ id: randomUUID(), ...row });
  const grant = await projects.insertGrant({ id: randomUUID(), workspaceId: row.workspaceId, projectId: project.id, role: 'manager', createdBy: row.createdBy,
    userId: row.createdBy });
  if ('conflict' in grant) throw new Error(`The creator of a new space could not be its admin (${grant.conflict})`);
  return project;
}

/** The people a new space starts with, besides its creator: distinct ids, at most this many. */
const NEW_SPACE_PEOPLE_MAX = 200;

/**
 * Creates a space; only people who are not guests create spaces. Its creator is its first space admin (F-037); the people named
 * in the command are added as members, and AI is on unless the command says otherwise. All of it commits together.
 */
export async function createProject(principal: Principal, workspaceId: string, command: CreateProjectCommand, db: Database, ports: ProjectPorts, eventSink?: DomainEventSink): Promise<Project> {
  const projectName = name(command?.name);
  const visibility = command.visibility === undefined ? 'restricted' : oneOf(command.visibility, PROJECT_VISIBILITIES, 'visibility');
  if (command.ai !== undefined && typeof command.ai !== 'boolean') throw new InvalidInputError('ai must be true or false');
  if (command.people !== undefined && (!Array.isArray(command.people) || command.people.some((id) => typeof id !== 'string' || !id) || command.people.length > NEW_SPACE_PEOPLE_MAX)) {
    throw new InvalidInputError(`people must be a list of at most ${NEW_SPACE_PEOPLE_MAX} account ids`);
  }
  const people = [...new Set(command.people ?? [])].filter((id) => id !== principal.id);
  return db.transaction(async (tx) => {
    const { actor } = enforce(await evaluateWorkspace(principal, 'project.create', workspaceId, ports.access(tx), { lock: true }), 'workspace');
    // F-037: only Everyone holds the whole company, and setup makes it; any other space holds the people added to it.
    if (visibility === 'workspace' && (await ports.workspaces(tx).company())?.id === workspaceId) {
      throw new RuleViolationError('A new space holds only the people added to it', 'SPACE_NOT_FOR_EVERYONE');
    }
    // An encrypted space (an internal workspace of the company, F-030) holds exactly one space: the one made with it (C-24).
    if (await ports.workspaces(tx).companyOf(workspaceId)) {
      // Made with the encrypted space, by its owner: another member of it cannot get in first (review of #976).
      if (actor.role !== 'owner') throw new RuleViolationError('An encrypted space\'s space is made with it, by its owner', 'ENCRYPTED_SPACE_HOLDS_ONE');
      await ports.workspaces(tx).lock(workspaceId);
      if (await ports.workspaces(tx).hasProject(workspaceId)) throw new RuleViolationError('An encrypted space holds one space', 'ENCRYPTED_SPACE_HOLDS_ONE');
    }
    const projects = ports.projects(tx);
    const row = await insertSpace(tx, ports, { workspaceId, name: projectName, visibility, createdBy: principal.id });
    const added: { grantId: string; userId: string }[] = [];
    for (const userId of people) {
      const member = await projects.member(workspaceId, userId);
      if (!member) throw new RuleViolationError('Only people in the company can be added to a space', 'NOT_A_MEMBER');
      const grant = await projects.insertGrant({ id: randomUUID(), workspaceId, projectId: row.id, role: 'contributor', createdBy: principal.id, userId });
      if ('conflict' in grant) throw new ConflictError('This person is no longer in the company', 'GRANTEE_REMOVED');
      added.push({ grantId: grant.grant.id, userId });
    }
    // The switch starts on (the row exists from the moment the space does); an encrypted space is already off.
    if (command.ai === false) {
      await projects.lockAiPolicy(row.id);
      await projects.updateAiPolicy(row.id, 'blocked', principal.id);
    }
    const record = async (kind: string, objectId: string, data: Record<string, unknown>) => {
      if (eventSink) await eventSink.record(principal, workspaceId, kind, objectId, data);
      else await recordEvent(eventPorts(ports, tx), principal, workspaceId, kind, objectId, data);
    };
    await record('project.created.v1', row.id, { visibility });
    for (const { grantId, userId } of added) await record('project.grant_set.v1', row.id, { grantId, principal: { kind: 'human', id: userId }, role: 'contributor' });
    return toProject(row, LEVEL.manager, command.ai === false ? 'blocked' : await aiOf(tx, ports, row.id));
  });
}

/** Renames a space; its admins and the company's owners and admins may (F-037). */
export async function renameProject(principal: Principal, projectId: string, command: RenameProjectCommand, db: Database, ports: ProjectPorts): Promise<Project> {
  const projectName = name(command?.name);
  return db.transaction(async (tx) => {
    await ports.projects(tx).lockForGrantChange(projectId);
    const { project, level } = enforce(await evaluateProject(principal, 'project.manage', projectId, ports.access(tx), { lock: true }), 'project');
    const row = await ports.projects(tx).rename(projectId, project!.workspaceId, projectName);
    await recordEvent(eventPorts(ports, tx), principal, project!.workspaceId, 'project.renamed.v1', projectId, {});
    return toProject(row, level, await aiOf(tx, ports, projectId));
  });
}

/** Projects the principal can see, filtered before count and pagination. */
export async function listProjects(principal: Principal, workspaceId: string, query: PageQuery, db: Database, ports: ProjectPorts): Promise<Page<Project>> {
  const page = parsePage(query);
  const { actor } = enforce(await evaluateWorkspace(principal, 'workspace.read', workspaceId, ports.access(db)), 'workspace');
  const { total, rows } = await ports.projects(db).listVisible(actor, page);
  return { items: rows.map((row) => ({ ...toProject(row.project, row.level, row.ai), member: row.member })), total, ...page };
}

export async function getProject(principal: Principal, projectId: string, db: Database, ports: ProjectPorts): Promise<Project> {
  const { project, level } = enforce(await evaluateProject(principal, 'project.read', projectId, ports.access(db)), 'project');
  return toProject(project!, level, await aiOf(db, ports, projectId));
}

/**
 * The audience of a project (#117): every person and agent who can read it now. The caller
 * needs `project.read`. Each candidate's level is decided by the access policy itself
 * (`evaluateProject`), never re-derived here, so a revoked agent or a removed
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
    const name = visibleHumans.get(agent.ownerUserId);
    if (name) person.agentOwner = { kind: 'human', id: agent.ownerUserId, name };
  }
  return people.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) || a.id.localeCompare(b.id) : a.kind === 'human' ? -1 : 1));
}

/**
 * The people in a space (F-037): the people it was added to; in the Everyone space, the whole company. A company owner or admin who
 * was not added reaches the space but is not one of its people, so the Owner field, mentions, the faces in the header and the settings
 * page all show the same list. An agent is listed with its owner, when its owner is listed.
 */
export async function listSpacePeople(principal: Principal, projectId: string, db: Database, ports: ProjectPorts): Promise<ProjectPerson[]> {
  const audience = await listProjectPeople(principal, projectId, db, ports);
  const { project } = enforce(await evaluateProject(principal, 'project.read', projectId, ports.access(db)), 'project');
  if (project!.visibility === 'workspace') return audience;
  const added = new Set((await ports.projects(db).listGrants(principal, projectId)).map((grant) => grant.userId));
  const humans = audience.filter((person) => person.kind === 'human' && added.has(person.id));
  const listed = new Set(humans.map((person) => person.id));
  return [...humans, ...audience.filter((person) => person.kind === 'agent' && person.agentOwner && listed.has(person.agentOwner.id))];
}
