import { z } from 'zod';
import { AGENT_SOURCE_KINDS, type AgentBootstrap, type AgentSourceCheckpoint } from '@flux/contracts';
import { agentOrientationUseCases, agentPolicyReference, agentSourcePage, coworkPlaybookReference, DomainError, getProject } from '@flux/core';
import { accessPorts, agentExecutionRows, agentOrientationRows, agentPlaybookRows, agentPolicyRows, coworkUnitRows, type Database } from '@flux/db';
import { requireMcpSourceKinds, withAgentConnection, type FluxMcpClaims } from './context.js';
import { agentRuntimeInTransaction } from './runtime.js';
import type { AgentToolRegistry } from './tool-registry.js';
import { toolError, toolResult } from './tool-results.js';

const page = { limit: z.int().min(1).max(50).default(20), offset: z.int().min(0).max(10_000).default(0) };
export const agentSourceCheckpointSchema = z.discriminatedUnion('kind', [
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
    inputSchema: z.strictObject({ clientSessionId: z.uuid(), projectId: z.uuid(), grantLimit: page.limit.optional(), grantOffset: page.offset.optional(),
      includeWorkRecovery: z.boolean().optional().describe('Recover this connection’s own open units for Start/Resume; also needs project.work.read.'),
      workLimit: page.limit.optional(), workOffset: page.offset.optional() }),
    annotations: { readOnlyHint: true, idempotentHint: true } }, async ({ clientSessionId, projectId, grantLimit, grantOffset,
      includeWorkRecovery, workLimit, workOffset }) => {
    if (includeWorkRecovery) requireMcpSourceKinds(claims, ['work']);
    try {
      const value = await withAgentConnection(db, claims, 'flux.context.read', projectId, async ({ tx, principal, mcpPolicy }) => {
        if (!mcpPolicy) throw new DomainError(403, 'MCP_ENTRY_UNAVAILABLE', 'This capability is unavailable');
        const project = await getProject(principal, projectId, tx, accessPorts);
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
        const work = includeWorkRecovery ? await coworkUnitRows(tx).recovery({ workspaceId: project.workspaceId, projectId,
          connectionId: runtime.connectionId, runtimeSessionId: runtime.id }, agentSourcePage({ limit: workLimit, offset: workOffset })) : undefined;
        const active = work?.units.find((unit) => unit.lease !== null);
        const checkpoint = work?.units.find((unit) => unit.checkpointId !== null);
        const result: AgentBootstrap = { contractVersion: 1, observedAt: observedAt.toISOString(), runtime,
          project: { id: project.id, workspaceId: project.workspaceId, name: project.name }, grants,
          capabilities: tools.capabilities(runtime.scopes, mcpPolicy),
          trusted: { playbook, approvedPolicy: policy ? agentPolicyReference(policy) : null,
            coordination: { activeClaimReference: active?.id ?? null, checkpointReference: checkpoint?.checkpointId ?? null,
              inboxContinuation: null, ...(work ? { work } : {}) }, repositoryReferences: null },
          playbookAcknowledgment: acknowledged ? { ...acknowledged, current } : null,
          gaps: [...(policy ? [] : ['approved_policy_unavailable' as const]),
            'verified_repository_context_unavailable', 'goal_plan_classification_unavailable', 'dependency_index_unavailable'],
          readiness: { state: 'pending', meaning: 'server_context_available_only' },
          coverage: { projectIndex: 'bounded_canonical_metadata', changesSince: 'supplied_references_only', instructionLoading: current ? 'client_acknowledged' : 'unverified', modelObedience: 'unverified' } };
        return result;
      });
      return toolResult(value);
    } catch (error) { return toolError(error); }
  });
  read.registerTool('flux_project_orientation', { title: 'Index selected project sources',
    description: 'A page of IDs, labels and exact versions or checkpoints for one source kind. No bodies, private maps, DMs or drafts, and no guessed goal or plan classes.',
    inputSchema: z.strictObject({ projectId: z.uuid(), kind: z.enum(AGENT_SOURCE_KINDS), ...page }), annotations: { readOnlyHint: true } },
  async ({ projectId, kind, ...query }) => {
    requireMcpSourceKinds(claims, [kind]);
    try { return toolResult(await withAgentConnection(db, claims, 'flux.context.read', projectId, async ({ tx, principal, connection, workspaceId }) => {
      await getProject(principal, projectId, tx, accessPorts);
      return agentOrientationUseCases(agentOrientationRows(tx)).list(connection, { workspaceId, projectId }, kind, query);
    })); } catch (error) { return toolError(error); }
  });
  read.registerTool('flux_changes_since', { title: 'Compare recorded source checkpoints',
    description: 'Compare up to 50 recorded checkpoints under current authorization: changed metadata, unchanged identities and content-free unavailable outcomes. It does not discover new or removed objects; use project orientation for that.',
    inputSchema: z.strictObject({ projectId: z.uuid(), known: z.array(agentSourceCheckpointSchema).max(50) }), annotations: { readOnlyHint: true } },
  async ({ projectId, known }) => {
    requireMcpSourceKinds(claims, known.map((item) => item.kind));
    try { return toolResult(await withAgentConnection(db, claims, 'flux.context.read', projectId, async ({ tx, principal, connection, workspaceId }) => {
      await getProject(principal, projectId, tx, accessPorts);
      return agentOrientationUseCases(agentOrientationRows(tx)).changes(connection, { workspaceId, projectId }, known as AgentSourceCheckpoint[]);
    })); } catch (error) { return toolError(error); }
  });
}
