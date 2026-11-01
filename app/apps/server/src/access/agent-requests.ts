import type { FastifyInstance } from 'fastify';
import type { PgBoss } from 'pg-boss';
import { AGENTS_PATH, PROJECTS_PATH, type AgentProjectAccess, type CreateAgentAccessRequestCommand, type RespondAgentAccessRequestCommand } from '@flux/contracts';
import { accessPorts, accessReader, agentAccessRequestRows, type Database } from '@flux/db';
import { ConflictError, NotFoundError, assertAuthorized, createNotification, evaluateProject, getProject, isUuid,
  listProjects, requireWorkspaceAi, type Principal } from '@flux/core';
import { grantProjectWithAssistant } from '../assistant/project-membership.js';
import { notificationUnitOfWork, pgBossQueue } from '../push/adapters.js';
import type { AccessContext } from './context.js';

/**
 * #763 FT-1: a person asks a project's managers to let their own agent in, and a manager answers in one step
 * (docs/development/access-policy.md#agent-access-requests). Asking grants nothing. Allow is the ordinary agent grant
 * made by that manager (`project.manage`), so the agent is still capped at its owner's own access; Decline only closes.
 */
const DECLINE_COOLDOWN_MS = 24 * 3_600_000;
const missing = () => new NotFoundError('Agent access request', 'AGENT_REQUEST_NOT_FOUND');
const human = (principal: Principal) => { if (principal.kind !== 'human') throw missing(); return principal; };
/** The manager's notice links to the project's People, where the request is answered. */
export const agentRequestUrl = (projectId: string, requestId: string) => `/projects/${projectId}?open=people&agentRequest=${requestId}`;

export function agentRequestUseCases(db: Database, boss: Pick<PgBoss, 'send'>) {
  return {
    async create(principal: Principal, projectId: string, command: CreateAgentAccessRequestCommand) {
      const owner = human(principal);
      if (!isUuid(projectId) || !isUuid(command?.agentId)) throw missing();
      return db.transaction(async (tx) => {
        const rows = agentAccessRequestRows(tx);
        const project = await getProject(owner, projectId, tx, accessPorts);
        await requireWorkspaceAi(accessReader(tx), project.workspaceId);
        const agent = await rows.ownAgent(owner.id, command.agentId.toLowerCase());
        if (!agent || agent.workspaceId !== project.workspaceId) throw new NotFoundError('Agent', 'AGENT_NOT_FOUND');
        if ((await evaluateProject(owner, 'project.manage', projectId, accessReader(tx), { lock: true })).allowed)
          throw new ConflictError('You manage this project: give your agent access yourself', 'AGENT_REQUEST_MANAGER');
        // The request never asks for more than the owner has: a reader's agent can only read.
        const canWrite = (await evaluateProject(owner, 'project.write', projectId, accessReader(tx), { lock: true })).allowed;
        const role = canWrite && command.role !== 'viewer' ? 'contributor' : 'viewer';
        const current = await rows.grantOf(projectId, agent.id);
        if (current === 'contributor' || (current === 'viewer' && role === 'viewer'))
          throw new ConflictError('Your agent already has this access here', 'AGENT_ALREADY_IN_PROJECT');
        // A declined request can be asked again only after a day, so a "no" is not answered with a fresh notice each minute.
        const previous = await rows.current(agent.id, projectId);
        if (previous?.state === 'declined' && Date.now() - previous.updatedAt.getTime() < DECLINE_COOLDOWN_MS)
          throw new ConflictError('A project manager declined this a moment ago; you can ask again tomorrow', 'AGENT_REQUEST_DECLINED');
        const { row, created } = await rows.open({ workspaceId: project.workspaceId, projectId, agentId: agent.id, ownerUserId: owner.id, role });
        const notified: { id: string; name: string }[] = [];
        if (created) {
          const [request] = await rows.view([row]);
          for (const candidate of await rows.candidates(project.workspaceId)) {
            if (candidate.userId === owner.id) continue;
            if (!(await evaluateProject({ kind: 'human', id: candidate.userId }, 'project.manage', projectId, accessReader(tx), { lock: true })).allowed) continue;
            const notification = await createNotification(notificationUnitOfWork(tx, pgBossQueue(boss)), {
              userId: candidate.userId, source: { type: 'project', id: projectId },
              title: `${request!.owner.name} asks to let their agent ${request!.agent.name} into ${project.name}`.slice(0, 200),
              body: role === 'contributor' ? 'It would read and write here, never beyond what its owner can do. Allow it in People.'
                : 'It would only read here. Allow it in People.',
              url: agentRequestUrl(projectId, row.id), aiOrigin: false,
            });
            await rows.markQuestion(notification.id);
            notified.push({ id: candidate.userId, name: (await rows.names([candidate.userId])).get(candidate.userId) ?? 'A manager' });
          }
        }
        const [view] = await rows.view([row]);
        return { ...view!, notified };
      });
    },
    async list(principal: Principal, projectId: string) {
      const person = human(principal);
      if (!isUuid(projectId)) throw missing();
      return db.transaction(async (tx) => {
        await getProject(person, projectId, tx, accessPorts);
        const manager = (await evaluateProject(person, 'project.manage', projectId, accessReader(tx))).allowed;
        const rows = agentAccessRequestRows(tx);
        return rows.view(await rows.pending(projectId, manager ? undefined : person.id));
      });
    },
    /** `conn`: the connection a project change runs on (the media fence holds its lock there). */
    respond(principal: Principal, projectId: string, requestId: string, command: RespondAgentAccessRequestCommand, conn: Database = db) {
      const manager = human(principal);
      if (!isUuid(projectId) || !isUuid(requestId)) throw missing();
      return conn.transaction(async (tx) => {
        await assertAuthorized(manager, 'project.manage', { type: 'project', id: projectId }, accessReader(tx));
        const rows = agentAccessRequestRows(tx);
        const request = await rows.find(projectId, requestId, true);
        if (!request) throw missing();
        if (request.state !== 'pending') return (await rows.view([request]))[0]!;
        if (command.allow) {
          // The ordinary manager grant: it rechecks project management under its own locks and that the agent is active.
          await grantProjectWithAssistant(manager, projectId, { principal: { kind: 'agent', id: request.agentId }, role: request.role }, tx);
        }
        const closed = await rows.close(request.id, command.allow ? 'accepted' : 'declined', manager.id);
        await rows.settleNotices(projectId, agentRequestUrl(projectId, request.id));
        const [view] = await rows.view([closed]);
        const project = await getProject(manager, projectId, tx, accessPorts);
        // The owner hears the answer in their Inbox; a notice they can no longer read is simply not written.
        try {
          await createNotification(notificationUnitOfWork(tx, pgBossQueue(boss)), {
            userId: request.ownerUserId, source: { type: 'project', id: projectId },
            title: (command.allow ? `${view!.agent.name} can now ${request.role === 'contributor' ? 'work' : 'read'} in ${project.name}`
              : `${view!.agent.name} was not let into ${project.name}`).slice(0, 200),
            body: command.allow ? 'A project manager allowed your request. Select the project for your agent in Connect.' : 'A project manager declined your request.',
            url: '/settings/agents/connect', aiOrigin: false,
          });
        } catch (error) { if (!(error instanceof NotFoundError)) throw error; }
        return view!;
      });
    },
    /** The owner's own agent in each project of its workspace that the owner can open now. */
    async projectAccess(principal: Principal, agentId: string): Promise<AgentProjectAccess[]> {
      const owner = human(principal);
      if (!isUuid(agentId)) throw new NotFoundError('Agent', 'AGENT_NOT_FOUND');
      return db.transaction(async (tx) => {
        const rows = agentAccessRequestRows(tx);
        const agent = await rows.ownAgent(owner.id, agentId.toLowerCase());
        if (!agent) throw new NotFoundError('Agent', 'AGENT_NOT_FOUND');
        const readable: string[] = [];
        let offset = 0;
        for (;;) {
          const page = await listProjects(owner, agent.workspaceId, { limit: 100, offset }, tx, accessPorts);
          readable.push(...page.items.map((project) => project.id));
          if (page.items.length < 100) break;
          offset += 100;
        }
        const { grants, requests } = await rows.ofAgent(agent.id);
        return readable.map((projectId) => {
          const request = requests.find((item) => item.projectId === projectId);
          return { projectId, grant: grants.find((item) => item.projectId === projectId)?.role ?? null,
            request: request ? { id: request.id, role: request.role } : null };
        });
      });
    },
  };
}

export function agentRequestRoutes(app: FastifyInstance, { db, principal, projectChange }: AccessContext, boss: Pick<PgBoss, 'send'>) {
  const cases = agentRequestUseCases(db, boss);
  app.get<{ Params: { projectId: string } }>(`${PROJECTS_PATH}/:projectId/agent-requests`, async (request) =>
    cases.list(await principal(request), request.params.projectId));
  app.post<{ Params: { projectId: string }; Body: CreateAgentAccessRequestCommand }>(`${PROJECTS_PATH}/:projectId/agent-requests`, {
    schema: { body: { type: 'object', required: ['agentId'], additionalProperties: false, properties: {
      agentId: { type: 'string', maxLength: 64 }, role: { type: 'string', enum: ['contributor', 'viewer'] } } } },
  }, async (request, reply) => reply.code(201).send(await cases.create(await principal(request), request.params.projectId, request.body)));
  app.post<{ Params: { projectId: string; requestId: string }; Body: RespondAgentAccessRequestCommand }>(`${PROJECTS_PATH}/:projectId/agent-requests/:requestId`, {
    schema: { body: { type: 'object', required: ['allow'], additionalProperties: false, properties: { allow: { type: 'boolean' } } } },
  }, async (request) => {
    const actor = await principal(request);
    return projectChange(request.params.projectId, (conn) => cases.respond(actor, request.params.projectId, request.params.requestId, request.body, conn));
  });
  app.get<{ Params: { agentId: string } }>(`${AGENTS_PATH}/:agentId/project-access`, async (request) =>
    cases.projectAccess(await principal(request), request.params.agentId));
}
