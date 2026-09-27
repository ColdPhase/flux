import type { FastifyError, FastifyInstance } from 'fastify';
import {
  AGENTS_PATH,
  DRAFTS_PATH,
  PROJECTS_PATH,
  WORKSPACES_PATH,
  type AddMemberCommand,
  type ApiError,
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
  DomainError,
  getDraft,
  getProject,
  getWorkspace,
  grantProject,
  listAgents,
  listDrafts,
  listMembers,
  listProjectGrants,
  listProjects,
  listWorkspaces,
  moveDraft,
  removeMember,
  revokeAgent,
  revokeProjectGrant,
  shareDraft,
  updateDraft,
  type Database,
} from '@flux/core';
import type { SessionResolver } from '../identity/index.js';

export interface AccessRouteOptions {
  db: Database;
  sessions: SessionResolver;
}

const nameSchema = { type: 'string', minLength: 1, maxLength: 200 } as const;
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
 */
export async function accessRoutes(app: FastifyInstance, { db, sessions }: AccessRouteOptions) {
  app.setErrorHandler((error: FastifyError | DomainError, request, reply) => {
    if (error instanceof DomainError) {
      const payload: ApiError = { error: error.message, code: error.code };
      return reply.code(error.status).send(payload);
    }
    if ((error as FastifyError).statusCode === 401) {
      return reply.code(401).send({ error: 'Authentication required', code: 'UNAUTHENTICATED' } satisfies ApiError);
    }
    throw error;
  });

  const principal = async (request: Parameters<SessionResolver['requirePrincipal']>[0]) => (await sessions.requirePrincipal(request)).principal;

  // Workspaces and membership
  app.get(WORKSPACES_PATH, async (request) => listWorkspaces(await principal(request), db));
  app.post<{ Body: CreateWorkspaceCommand }>(WORKSPACES_PATH, {
    schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: nameSchema } } },
  }, async (request, reply) => reply.code(201).send(await createWorkspace(await principal(request), request.body, db)));
  app.get<{ Params: { workspaceId: string } }>(`${WORKSPACES_PATH}/:workspaceId`, async (request) =>
    getWorkspace(await principal(request), request.params.workspaceId, db));

  app.get<{ Params: { workspaceId: string } }>(`${WORKSPACES_PATH}/:workspaceId/members`, async (request) =>
    listMembers(await principal(request), request.params.workspaceId, db));
  app.post<{ Params: { workspaceId: string }; Body: AddMemberCommand }>(`${WORKSPACES_PATH}/:workspaceId/members`, {
    schema: { body: { type: 'object', required: ['role'], additionalProperties: false, properties: { userId: { type: 'string' }, email: { type: 'string' }, role: roleSchema } } },
  }, async (request, reply) => reply.code(201).send(await addMember(await principal(request), request.params.workspaceId, request.body, db)));
  app.patch<{ Params: { workspaceId: string; userId: string }; Body: ChangeRoleCommand }>(`${WORKSPACES_PATH}/:workspaceId/members/:userId`, {
    schema: { body: { type: 'object', required: ['role'], additionalProperties: false, properties: { role: roleSchema } } },
  }, async (request) => changeRole(await principal(request), request.params.workspaceId, request.params.userId, request.body, db));
  app.delete<{ Params: { workspaceId: string; userId: string } }>(`${WORKSPACES_PATH}/:workspaceId/members/:userId`, async (request, reply) => {
    await removeMember(await principal(request), request.params.workspaceId, request.params.userId, db);
    return reply.code(204).send();
  });

  // Projects and grants
  app.get<{ Params: { workspaceId: string }; Querystring: PageQuery }>(`${WORKSPACES_PATH}/:workspaceId/projects`, { schema: { querystring: pageQuery } }, async (request) =>
    listProjects(await principal(request), request.params.workspaceId, request.query, db));
  app.post<{ Params: { workspaceId: string }; Body: CreateProjectCommand }>(`${WORKSPACES_PATH}/:workspaceId/projects`, {
    schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: nameSchema, visibility: { type: 'string', enum: ['workspace', 'restricted'] } } } },
  }, async (request, reply) => reply.code(201).send(await createProject(await principal(request), request.params.workspaceId, request.body, db)));
  app.get<{ Params: { projectId: string } }>(`${PROJECTS_PATH}/:projectId`, async (request) =>
    getProject(await principal(request), request.params.projectId, db));
  app.get<{ Params: { projectId: string } }>(`${PROJECTS_PATH}/:projectId/grants`, async (request) =>
    listProjectGrants(await principal(request), request.params.projectId, db));
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
  }, async (request, reply) => reply.code(201).send(await grantProject(await principal(request), request.params.projectId, request.body, db)));
  app.delete<{ Params: { projectId: string; grantId: string } }>(`${PROJECTS_PATH}/:projectId/grants/:grantId`, async (request, reply) => {
    await revokeProjectGrant(await principal(request), request.params.projectId, request.params.grantId, db);
    return reply.code(204).send();
  });

  // Agent identities
  app.get<{ Params: { workspaceId: string } }>(`${WORKSPACES_PATH}/:workspaceId/agents`, async (request) =>
    listAgents(await principal(request), request.params.workspaceId, db));
  app.post<{ Params: { workspaceId: string }; Body: CreateAgentCommand }>(`${WORKSPACES_PATH}/:workspaceId/agents`, {
    schema: { body: { type: 'object', required: ['name', 'owner'], additionalProperties: false, properties: { name: nameSchema, owner: { type: 'string', enum: ['self', 'workspace'] } } } },
  }, async (request, reply) => reply.code(201).send(await createAgent(await principal(request), request.params.workspaceId, request.body, db)));
  app.delete<{ Params: { agentId: string } }>(`${AGENTS_PATH}/:agentId`, async (request) =>
    revokeAgent(await principal(request), request.params.agentId, db));

  // Drafts
  app.get<{ Params: { workspaceId: string }; Querystring: DraftListQuery }>(`${WORKSPACES_PATH}/:workspaceId/drafts`, {
    schema: { querystring: { ...pageQuery, properties: { ...pageQuery.properties, projectId: { type: 'string' } } } },
  }, async (request) => listDrafts(await principal(request), request.params.workspaceId, request.query, db));
  app.post<{ Params: { workspaceId: string }; Body: CreateDraftCommand }>(`${WORKSPACES_PATH}/:workspaceId/drafts`, {
    schema: { body: { type: 'object', required: ['title'], additionalProperties: false, properties: { title: nameSchema, body: { type: 'string', maxLength: 100_000 }, projectId: { type: 'string' } } } },
  }, async (request, reply) => reply.code(201).send(await createDraft(await principal(request), request.params.workspaceId, request.body, db)));
  app.get<{ Params: { draftId: string } }>(`${DRAFTS_PATH}/:draftId`, async (request) =>
    getDraft(await principal(request), request.params.draftId, db));
  app.patch<{ Params: { draftId: string }; Body: UpdateDraftCommand }>(`${DRAFTS_PATH}/:draftId`, {
    schema: { body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { title: nameSchema, body: { type: 'string', maxLength: 100_000 } } } },
  }, async (request) => updateDraft(await principal(request), request.params.draftId, request.body, db));
  app.post<{ Params: { draftId: string }; Body: ShareDraftCommand }>(`${DRAFTS_PATH}/:draftId/share`, {
    schema: { body: { type: 'object', required: ['scope'], additionalProperties: false, properties: { scope: visibilitySchema, projectId: { type: 'string' } } } },
  }, async (request) => shareDraft(await principal(request), request.params.draftId, request.body, db));
  app.post<{ Params: { draftId: string }; Body: MoveDraftCommand }>(`${DRAFTS_PATH}/:draftId/move`, {
    schema: { body: { type: 'object', required: ['projectId', 'visibility'], additionalProperties: false, properties: { projectId: { type: ['string', 'null'] }, visibility: visibilitySchema } } },
  }, async (request) => moveDraft(await principal(request), request.params.draftId, request.body, db));
}
