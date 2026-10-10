import { z } from 'zod';
import { AGENT_SOURCE_KINDS, type AgentBootstrap, type AgentSourceCheckpoint } from '@flux/contracts';
import { agentOrientationUseCases, agentPolicyReference, agentSourcePage, coworkPlaybookReference, DomainError, getProject, type Database } from '@flux/core';
import { agentExecutionRows, agentOrientationRows, agentPlaybookRows, agentPolicyRows } from '@flux/db';
import { requireMcpSourceKinds, withAgentConnection, type FluxMcpClaims } from './context.js';
import { agentRuntimeInTransaction } from './runtime.js';
import type { AgentToolRegistry } from './tool-registry.js';
import { toolError, toolResult } from './tool-results.js';

const page = { limit: z.int().min(1).max(50).default(20), offset: z.int().min(0).max(10_000).default(0) };
const checkpoint = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.enum(['doc', 'material', 'work', 'decision']), id: z.uuid(), version: z.int().min(1).max(2_147_483_647) }),
  z.strictObject({ kind: z.literal('result'), id: z.uuid() }),
  z.strictObject({ kind: z.literal('conversation'), id: z.uuid(), sequence: z.int().min(0).max(2_147_483_647) }),
  z.strictObject({ kind: z.literal('map'), id: z.uuid(), version: z.int().min(1).max(2_147_483_647), updatedAt: z.iso.datetime() }),
]);

/** Registered read tools use the same verified bearer/current policy boundary as canonical content readers. */
export function registerAgentBootstrap(tools: AgentToolRegistry, db: Database, claims: FluxMcpClaims) {
  const read = tools.forScope('flux.context.read');
  read.registerTool('flux_bootstrap', { title: 'Recover authenticated project context',
    description: 'Recover the original server runtime, current project, bounded grants/tool catalog and the trusted co-work playbook version. Missing policy, coordination and repository providers are explicit setup gaps; this does not prove instruction loading or grant action authority.',
    inputSchema: z.strictObject({ clientSessionId: z.uuid(), projectId: z.uuid(), grantLimit: page.limit.optional(), grantOffset: page.offset.optional() }),
    annotations: { readOnlyHint: true, idempotentHint: true } }, async ({ clientSessionId, projectId, grantLimit, grantOffset }) => {
    try {
      const value = await withAgentConnection(db, claims, 'flux.context.read', projectId, async ({ tx, principal, mcpPolicy }) => {
        if (!mcpPolicy) throw new DomainError(403, 'MCP_ENTRY_UNAVAILABLE', 'This capability is unavailable');
        const project = await getProject(principal, projectId, tx);
        const { runtime } = await agentRuntimeInTransaction(tx, claims, clientSessionId);
        const rows = agentExecutionRows(tx);
        const observedAt = await rows.now();
        const grants = await rows.liveProjectGrants(runtime.ownerUserId, runtime.connectionId, projectId, observedAt,
          agentSourcePage({ limit: grantLimit, offset: grantOffset }));
        // The playbook and the approved project policy are #160's; #153/#74 providers are not yet handed off.
        // No client input or wiki prose fills these fields: only a manager's publish writes policy.
        const playbook = coworkPlaybookReference();
        const policy = await agentPolicyRows(tx).current(projectId);
        const acknowledged = await agentPlaybookRows(tx).acknowledgment(runtime.id);
        const current = !!acknowledged && acknowledged.bundleId === playbook.bundleId && acknowledged.version === playbook.version
          && acknowledged.digest === playbook.digest;
        const result: AgentBootstrap = { contractVersion: 1, observedAt: observedAt.toISOString(), runtime,
          project: { id: project.id, workspaceId: project.workspaceId, name: project.name }, grants,
          capabilities: tools.capabilities(runtime.scopes, mcpPolicy),
          trusted: { playbook, approvedPolicy: policy ? agentPolicyReference(policy) : null, coordination: null, repositoryReferences: null },
          playbookAcknowledgment: acknowledged ? { ...acknowledged, current } : null,
          gaps: [...(policy ? [] : ['approved_policy_unavailable' as const]), 'coordination_unavailable',
            'verified_repository_context_unavailable', 'goal_plan_classification_unavailable', 'dependency_index_unavailable'],
          readiness: { state: 'pending', meaning: 'server_context_available_only' },
          coverage: { projectIndex: 'bounded_canonical_metadata', changesSince: 'supplied_references_only', instructionLoading: current ? 'client_acknowledged' : 'unverified', modelObedience: 'unverified' } };
        return result;
      });
      return toolResult(value);
    } catch (error) { return toolError(error); }
  });
  read.registerTool('flux_project_orientation', { title: 'Index selected project sources',
    description: 'A bounded page of canonical IDs, labels and exact versions/checkpoints for one source kind. No bodies, private maps/DMs/draft provenance or guessed goal/plan classifications.',
    inputSchema: z.strictObject({ projectId: z.uuid(), kind: z.enum(AGENT_SOURCE_KINDS), ...page }), annotations: { readOnlyHint: true } },
  async ({ projectId, kind, ...query }) => {
    requireMcpSourceKinds(claims, [kind]);
    try { return toolResult(await withAgentConnection(db, claims, 'flux.context.read', projectId, async ({ tx, principal, connection, workspaceId }) => {
      await getProject(principal, projectId, tx);
      return agentOrientationUseCases(agentOrientationRows(tx)).list(connection, { workspaceId, projectId }, kind, query);
    })); } catch (error) { return toolError(error); }
  });
  read.registerTool('flux_changes_since', { title: 'Compare recorded source checkpoints',
    description: 'Compare at most 50 recorded canonical checkpoints under current authorization. Returns changed metadata, unchanged identities and content-free unavailable outcomes. This does not discover every new or removed project object; use project orientation for discovery.',
    inputSchema: z.strictObject({ projectId: z.uuid(), known: z.array(checkpoint).max(50) }), annotations: { readOnlyHint: true } },
  async ({ projectId, known }) => {
    requireMcpSourceKinds(claims, known.map((item) => item.kind));
    try { return toolResult(await withAgentConnection(db, claims, 'flux.context.read', projectId, async ({ tx, principal, connection, workspaceId }) => {
      await getProject(principal, projectId, tx);
      return agentOrientationUseCases(agentOrientationRows(tx)).changes(connection, { workspaceId, projectId }, known as AgentSourceCheckpoint[]);
    })); } catch (error) { return toolError(error); }
  });
}
