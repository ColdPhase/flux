import type { FastifyInstance } from 'fastify';
import type { PgBoss } from 'pg-boss';
import {
  AGENTS_PATH,
  DRAFTS_PATH,
  PROJECTS_PATH,
  WORKSPACES_PATH,
  type AddMemberCommand,
  type ChangeRoleCommand,
  type CreateAgentCommand,
  type CreateDraftCommand,
  type CreateProjectCommand,
  type CreateWorkspaceCommand,
  type DraftListQuery,
  type GrantProjectCommand,
  type MoveDraftCommand,
  type PageQuery,
  type ShareDraftCommand,
  type UpdateDraftCommand,
} from '@flux/contracts';
import {
  addMember,
  changeRole,
  createAgent,
  createDraft,
  createProject,
  createWorkspace,
  getDraft,
  getProject,
  getWorkspace,
  grantProject,
  listAgents,
  listDrafts,
  listMembers,
  listProjectGrants,
  listProjectPeople,
  listProjects,
  listWorkspaces,
  moveDraft,
  removeMember,
  revokeAgent,
  revokeProjectGrant,
  shareDraft,
  updateDraft,
  getDraftSummary,
  listDraftSummaries,
  requestDraftSummary,
  type Database,
  type ResourceRef,
} from '@flux/core';
import type { SessionResolver } from '../identity/index.js';
import { bodyId, commandRunner, expectedVersion, requires, useDomainErrors, versionEtag } from '../http/commands.js';

export interface AccessRouteOptions {
  db: Database;
  sessions: SessionResolver;
  boss: Pick<PgBoss, 'send'>;
}

const nameSchema = { type: 'string', minLength: 1, maxLength: 200 } as const;
const versionSchema = { type: 'integer', minimum: 1 } as const;
const pageQuery = {
  type: 'object',
  additionalProperties: false,
  properties: { limit: { type: 'integer' }, offset: { type: 'integer' } },
} as const;
const roleSchema = { type: 'string', enum: ['owner', 'admin', 'member', 'guest'] } as const;
const visibilitySchema = { type: 'string', enum: ['private', 'project', 'workspace'] } as const;

/**
 * `/api/v1` workspace, project, grant, agent and draft routes. Each handler resolves the
 * current session (no caching) and calls one core domain method, which authorizes.
 * POST/PATCH commands accept `Idempotency-Key`; draft update/share/move need `If-Match`.
 */
export async function accessRoutes(app: FastifyInstance, { db, sessions, boss }: AccessRouteOptions) {
  useDomainErrors(app);
  const { principal, command } = commandRunner(db, sessions);

  const workspaceScope = (id: string): ResourceRef => ({ type: 'workspace', id });
  const projectScope = (id: string): ResourceRef => ({ type: 'project', id });
  const draftScope = (id: string): ResourceRef => ({ type: 'draft', id });

  // Workspaces and membership
  app.get(WORKSPACES_PATH, async (request) => listWorkspaces(await principal(request), db));
  app.post<{ Body: CreateWorkspaceCommand }>(WORKSPACES_PATH, {
    schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: nameSchema } } },
  }, async (request, reply) => command(request, reply, {
    operation: `POST ${WORKSPACES_PATH}`, scope: null, status: 201,
    run: (actor, conn) => createWorkspace(actor, request.body, conn),
    replay: requires('workspace', 'workspace.read', bodyId),
  }));
  app.get<{ Params: { workspaceId: string } }>(`${WORKSPACES_PATH}/:workspaceId`, async (request) =>
    getWorkspace(await principal(request), request.params.workspaceId, db));

  app.get<{ Params: { workspaceId: string } }>(`${WORKSPACES_PATH}/:workspaceId/members`, async (request) =>
    listMembers(await principal(request), request.params.workspaceId, db));
  app.post<{ Params: { workspaceId: string }; Body: AddMemberCommand }>(`${WORKSPACES_PATH}/:workspaceId/members`, {
    schema: { body: { type: 'object', required: ['role'], additionalProperties: false, properties: { userId: { type: 'string' }, email: { type: 'string' }, role: roleSchema } } },
  }, async (request, reply) => command(request, reply, {
    operation: `POST ${WORKSPACES_PATH}/:workspaceId/members`, scope: workspaceScope(request.params.workspaceId), status: 201,
    run: (actor, conn) => addMember(actor, request.params.workspaceId, request.body, conn),
    replay: requires('workspace', 'workspace.read_members', () => request.params.workspaceId),
  }));
  app.patch<{ Params: { workspaceId: string; userId: string }; Body: ChangeRoleCommand }>(`${WORKSPACES_PATH}/:workspaceId/members/:userId`, {
    schema: { body: { type: 'object', required: ['role'], additionalProperties: false, properties: { role: roleSchema } } },
  }, async (request, reply) => command(request, reply, {
    operation: `PATCH ${WORKSPACES_PATH}/:workspaceId/members/:userId`, scope: workspaceScope(request.params.workspaceId),
    run: (actor, conn) => changeRole(actor, request.params.workspaceId, request.params.userId, request.body, conn),
    replay: requires('workspace', 'workspace.read_members', () => request.params.workspaceId),
  }));
  app.delete<{ Params: { workspaceId: string; userId: string } }>(`${WORKSPACES_PATH}/:workspaceId/members/:userId`, async (request, reply) => {
    await removeMember(await principal(request), request.params.workspaceId, request.params.userId, db);
    return reply.code(204).send();
  });

  // Projects and grants
  app.get<{ Params: { workspaceId: string }; Querystring: PageQuery }>(`${WORKSPACES_PATH}/:workspaceId/projects`, { schema: { querystring: pageQuery } }, async (request) =>
    listProjects(await principal(request), request.params.workspaceId, request.query, db));
  app.post<{ Params: { workspaceId: string }; Body: CreateProjectCommand }>(`${WORKSPACES_PATH}/:workspaceId/projects`, {
    schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: nameSchema, visibility: { type: 'string', enum: ['workspace', 'restricted'] } } } },
  }, async (request, reply) => command(request, reply, {
    operation: `POST ${WORKSPACES_PATH}/:workspaceId/projects`, scope: workspaceScope(request.params.workspaceId), status: 201,
    run: (actor, conn) => createProject(actor, request.params.workspaceId, request.body, conn),
    replay: requires('project', 'project.read', bodyId),
  }));
  app.get<{ Params: { projectId: string } }>(`${PROJECTS_PATH}/:projectId`, async (request) =>
    getProject(await principal(request), request.params.projectId, db));
  app.get<{ Params: { projectId: string } }>(`${PROJECTS_PATH}/:projectId/grants`, async (request) =>
    listProjectGrants(await principal(request), request.params.projectId, db));
  app.get<{ Params: { projectId: string } }>(`${PROJECTS_PATH}/:projectId/people`, async (request) =>
    listProjectPeople(await principal(request), request.params.projectId, db));
  app.post<{ Params: { projectId: string }; Body: GrantProjectCommand }>(`${PROJECTS_PATH}/:projectId/grants`, {
    schema: {
      body: {
        type: 'object', required: ['principal', 'role'], additionalProperties: false,
        properties: {
          principal: { type: 'object', required: ['kind', 'id'], additionalProperties: false, properties: { kind: { type: 'string', enum: ['human', 'agent'] }, id: { type: 'string', minLength: 1 } } },
          role: { type: 'string', enum: ['contributor', 'viewer', 'denied'] },
        },
      },
    },
  }, async (request, reply) => command(request, reply, {
    operation: `POST ${PROJECTS_PATH}/:projectId/grants`, scope: projectScope(request.params.projectId), status: 201,
    run: (actor, conn) => grantProject(actor, request.params.projectId, request.body, conn),
    replay: requires('project', 'project.manage', () => request.params.projectId),
  }));
  app.delete<{ Params: { projectId: string; grantId: string } }>(`${PROJECTS_PATH}/:projectId/grants/:grantId`, async (request, reply) => {
    await revokeProjectGrant(await principal(request), request.params.projectId, request.params.grantId, db);
    return reply.code(204).send();
  });

  // Agent identities
  app.get<{ Params: { workspaceId: string } }>(`${WORKSPACES_PATH}/:workspaceId/agents`, async (request) =>
    listAgents(await principal(request), request.params.workspaceId, db));
  app.post<{ Params: { workspaceId: string }; Body: CreateAgentCommand }>(`${WORKSPACES_PATH}/:workspaceId/agents`, {
    schema: { body: { type: 'object', required: ['name', 'owner'], additionalProperties: false, properties: { name: nameSchema, owner: { type: 'string', enum: ['self', 'workspace'] } } } },
  }, async (request, reply) => command(request, reply, {
    operation: `POST ${WORKSPACES_PATH}/:workspaceId/agents`, scope: workspaceScope(request.params.workspaceId), status: 201,
    run: (actor, conn) => createAgent(actor, request.params.workspaceId, request.body, conn),
    replay: requires('agent', 'agent.read', bodyId),
  }));
  app.delete<{ Params: { agentId: string } }>(`${AGENTS_PATH}/:agentId`, async (request) =>
    revokeAgent(await principal(request), request.params.agentId, db));

  // Drafts
  app.get<{ Params: { workspaceId: string }; Querystring: DraftListQuery }>(`${WORKSPACES_PATH}/:workspaceId/drafts`, {
    schema: { querystring: { ...pageQuery, properties: { ...pageQuery.properties, projectId: { type: 'string' } } } },
  }, async (request) => listDrafts(await principal(request), request.params.workspaceId, request.query, db));
  app.post<{ Params: { workspaceId: string }; Body: CreateDraftCommand }>(`${WORKSPACES_PATH}/:workspaceId/drafts`, {
    schema: { body: { type: 'object', required: ['title'], additionalProperties: false, properties: { title: nameSchema, body: { type: 'string', maxLength: 100_000 }, projectId: { type: 'string' } } } },
  }, async (request, reply) => command(request, reply, {
    operation: `POST ${WORKSPACES_PATH}/:workspaceId/drafts`, scope: workspaceScope(request.params.workspaceId), status: 201, etag: true,
    run: (actor, conn) => createDraft(actor, request.params.workspaceId, request.body, conn),
    replay: requires('draft', 'draft.read', bodyId),
  }));
  app.get<{ Params: { draftId: string } }>(`${DRAFTS_PATH}/:draftId`, async (request, reply) => {
    const draft = await getDraft(await principal(request), request.params.draftId, db);
    return reply.header('etag', versionEtag(draft)).send(draft);
  });
  app.patch<{ Params: { draftId: string }; Body: UpdateDraftCommand }>(`${DRAFTS_PATH}/:draftId`, {
    schema: { body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { title: nameSchema, body: { type: 'string', maxLength: 100_000 }, expectedVersion: versionSchema } } },
  }, async (request, reply) => command(request, reply, {
    operation: `PATCH ${DRAFTS_PATH}/:draftId`, scope: draftScope(request.params.draftId), etag: true,
    run: (actor, conn) => updateDraft(actor, request.params.draftId, { ...request.body, expectedVersion: expectedVersion(request) }, conn),
    replay: requires('draft', 'draft.read', () => request.params.draftId),
  }));
  app.post<{ Params: { draftId: string }; Body: ShareDraftCommand }>(`${DRAFTS_PATH}/:draftId/share`, {
    schema: { body: { type: 'object', required: ['scope'], additionalProperties: false, properties: { scope: visibilitySchema, projectId: { type: 'string' }, expectedVersion: versionSchema } } },
  }, async (request, reply) => command(request, reply, {
    operation: `POST ${DRAFTS_PATH}/:draftId/share`, scope: draftScope(request.params.draftId), etag: true,
    run: (actor, conn) => shareDraft(actor, request.params.draftId, { ...request.body, expectedVersion: expectedVersion(request) }, conn),
    replay: requires('draft', 'draft.read', () => request.params.draftId),
  }));
  app.post<{ Params: { draftId: string }; Body: MoveDraftCommand }>(`${DRAFTS_PATH}/:draftId/move`, {
    schema: { body: { type: 'object', required: ['projectId', 'visibility'], additionalProperties: false, properties: { projectId: { type: ['string', 'null'] }, visibility: visibilitySchema, expectedVersion: versionSchema } } },
  }, async (request, reply) => command(request, reply, {
    operation: `POST ${DRAFTS_PATH}/:draftId/move`, scope: draftScope(request.params.draftId), etag: true,
    run: (actor, conn) => moveDraft(actor, request.params.draftId, { ...request.body, expectedVersion: expectedVersion(request) }, conn),
    replay: requires('draft', 'draft.read', () => request.params.draftId),
  }));

  // Background job results
  app.post<{ Params: { draftId: string } }>(`${DRAFTS_PATH}/:draftId/summaries`, async (request, reply) => command(request, reply, {
    operation: `POST ${DRAFTS_PATH}/:draftId/summaries`, scope: draftScope(request.params.draftId), status: 202,
    run: (actor, conn) => requestDraftSummary(actor, request.params.draftId, conn, boss),
    replay: requires('draft', 'draft.read', () => request.params.draftId),
  }));
  app.get<{ Params: { draftId: string } }>(`${DRAFTS_PATH}/:draftId/summaries`, async (request) =>
    listDraftSummaries(await principal(request), request.params.draftId, db));
  app.get<{ Params: { draftId: string; resultId: string } }>(`${DRAFTS_PATH}/:draftId/summaries/:resultId`, async (request) =>
    getDraftSummary(await principal(request), request.params.draftId, request.params.resultId, db));
}
