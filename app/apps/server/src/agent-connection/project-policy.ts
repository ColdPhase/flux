import type { FastifyInstance } from 'fastify';
import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/server';
import { AGENT_POLICY_LIMITS, agentProjectPolicyPath, type PublishAgentProjectPolicyCommand } from '@flux/contracts';
import { agentPolicyRows } from '@flux/db';
import { agentPolicyUseCases, enforce, evaluateProject, recordEvent, renderAgentPolicy, type AgentPolicyUnitOfWork,
  type Database, type Executor } from '@flux/core';
import type { SessionResolver } from '../identity/index.js';
import { commandRunner, requires, useDomainErrors } from '../http/commands.js';
import { withAgentConnection, type FluxMcpClaims } from './context.js';

/**
 * The policy use cases over one transaction: the access policy, the policy rows and project events. A
 * command passes its own connection, so an idempotent publish commits with its key (nested savepoint).
 */
export function agentPolicyUnitOfWork(db: Database): AgentPolicyUnitOfWork {
  return { run: (work) => db.transaction((tx) => work(policyPorts(tx))) };
}

function policyPorts(tx: Executor) {
  return {
    async requireProject(principal: Parameters<typeof evaluateProject>[0], projectId: string, action: 'project.read' | 'project.manage') {
      const checked = enforce(await evaluateProject(principal, action, projectId, tx, { lock: action === 'project.manage' }), 'project');
      return { workspaceId: checked.project!.workspaceId };
    },
    rows: agentPolicyRows(tx),
    events: { record: async (principal: Parameters<typeof recordEvent>[1], workspaceId: string, kind: string, projectId: string, data: Record<string, unknown>) => {
      await recordEvent(tx, principal, workspaceId, kind, projectId, data);
    } },
  };
}

const text = { type: 'string', maxLength: AGENT_POLICY_LIMITS.fieldCharacters } as const;

/**
 * `GET` / `PUT /api/v1/projects/:projectId/agent-policy` (#160): project readers see the approved policy,
 * project managers publish the next revision from the one they saw (`expectedRevision`, 0 for none).
 */
export async function agentPolicyRoutes(app: FastifyInstance, { db, sessions }: { db: Database; sessions: SessionResolver }) {
  useDomainErrors(app);
  const { principal, command } = commandRunner(db, sessions);
  const policy = agentPolicyUseCases(agentPolicyUnitOfWork(db));
  app.get<{ Params: { projectId: string } }>(agentProjectPolicyPath(':projectId'), async (request, reply) =>
    reply.header('cache-control', 'no-store').send({ policy: await policy.current(await principal(request), request.params.projectId) }));
  app.put<{ Params: { projectId: string }; Body: PublishAgentProjectPolicyCommand }>(agentProjectPolicyPath(':projectId'), {
    schema: { body: { type: 'object', additionalProperties: false, required: ['scope', 'priorities', 'reviewCriteria', 'allowedWork', 'expectedRevision'],
      properties: { scope: text, priorities: text, reviewCriteria: text, allowedWork: text, expectedRevision: { type: 'integer', minimum: 0 } } } },
  }, async (request, reply) => command(request, reply, {
    operation: `PUT ${agentProjectPolicyPath(':projectId')}`, scope: { type: 'project', id: request.params.projectId }, status: 201,
    run: (actor, conn) => agentPolicyUseCases(agentPolicyUnitOfWork(conn)).publish(actor, request.params.projectId, request.body),
    replay: requires('project', 'project.read', () => request.params.projectId),
  }));
}

/**
 * `flux://policy/{projectId}/{revision}` for connected agents: one stored revision, read through the
 * verified connection's current project access. Bootstrap's `approvedPolicy.retrievalReference` names it.
 */
export function registerAgentPolicyResource(server: McpServer, db: Database, claims: FluxMcpClaims) {
  server.registerResource('flux_project_policy', new ResourceTemplate('flux://policy/{projectId}/{revision}', { list: undefined }), {
    title: 'Approved project policy',
    description: 'A revision of the policy a project manager published for connected agents. It narrows work inside your grants and never widens them.',
    mimeType: 'text/markdown',
  }, async (uri, variables) => {
    const projectId = String(variables.projectId ?? '');
    // Only the canonical decimal form names a revision; anything else is simply not one.
    const raw = String(variables.revision ?? '');
    const revision = /^[1-9]\d{0,9}$/.test(raw) ? Number(raw) : 0;
    const value = await withAgentConnection(db, claims, 'flux.context.read', projectId, async ({ tx, principal }) =>
      agentPolicyUseCases({ run: (work) => work(policyPorts(tx)) }).revision(principal, projectId, revision));
    return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: renderAgentPolicy(value) }] };
  });
}
