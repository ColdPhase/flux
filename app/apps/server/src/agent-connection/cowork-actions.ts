import { z } from 'zod';
import { AGENT_OPERATION_CLASSES, AGENT_PEER_REQUEST_CLASSES, type AgentExecutionCommand, type AgentJsonValue,
  type AgentOperation, type AgentPeerRequestClass } from '@flux/contracts';
import { COWORK_DECLINE_REASONS, type Database } from '@flux/core';
import { COWORK_RESPONSES_WITHOUT_PUBLICATION, COWORK_UNIT_POLICY } from '../co-work/policy.js';
import { coWorkRequestResponseInTransaction } from '../co-work/responses.js';
import { coWorkUnitCreateInTransaction } from '../co-work/units.js';
import { actionAnnotations as annotations, actionId as id, actionVersion as version } from './action-execution.js';
import type { FluxMcpClaims } from './context.js';
import type { AgentToolRegistry } from './tool-registry.js';
import { toolError, toolResult } from './tool-results.js';

/** The standing-grant fields of a co-work tool; the class is the role of the unit the command acts on. */
const execution = {
  projectId: id,
  runtimeSessionId: id.describe('The runtime ID returned by flux_bootstrap for this client session.'),
  grantId: id.describe('A live standing grant from flux_bootstrap for this exact operation, project, class and target.'),
  clientCommandId: id.describe('One UUID per intended effect; reuse it only to retry that same effect.'),
  peerRequestClass: z.enum(AGENT_PEER_REQUEST_CLASSES).describe('The class of the standing grant being used: the unit\'s role.'),
};
type Execution = { projectId: string; runtimeSessionId: string; grantId: string; clientCommandId: string;
  peerRequestClass: AgentPeerRequestClass };
/** The recipient's live claim on its own unit plus the exact request it acts on. */
const requestFence = {
  unitId: id.describe('Your own unit the request is addressed to.'),
  generation: version.describe('The generation of your live claim on that unit.'),
  leaseId: id.describe('The lease ID of your live claim on that unit.'),
  requestId: id,
  expectedRequestVersion: version.describe('The request version you last read.'),
};

function command({ projectId, runtimeSessionId, grantId, clientCommandId, peerRequestClass }: Execution, operation: AgentOperation,
  objectId: string, payload: AgentJsonValue): AgentExecutionCommand {
  return { runtimeSessionId, grantId, clientCommandId, projectId, operation, peerRequestClass,
    audience: { kind: 'project', projectId }, objectId, sources: [], payload };
}

/**
 * Co-work tools (#153) over the existing internal compositions, one transaction per call. Each composition runs #152's
 * prepare/complete itself (current runtime, grant, command ledger, receipt) and writes no stream event. Resolving a
 * request with a response, claiming/renewing/releasing a unit, request admission, the inbox, completion and transfer
 * are not exposed yet (docs/development/cowork-coordination.md "MCP exposure").
 */
export function registerAgentCoworkActions(tools: AgentToolRegistry, db: Database, claims: FluxMcpClaims) {
  const register = (operation: AgentOperation) => tools.forScope('flux.action.execute', { operation, classes: AGENT_OPERATION_CLASSES[operation] });
  const run = (handler: () => Promise<unknown>) => handler().then(toolResult, toolError);

  register('cowork.unit.create').registerTool('flux_create_unit', {
    title: 'Take a task or open a co-work unit on it under a standing grant',
    description: 'Open one co-work unit (execute, review or plan) on a native task at the exact task version you last read. '
      + 'Needs a live cowork.unit.create grant whose class is the unit\'s role, and the runtime from flux_bootstrap. A root unit '
      + '(parent null) opens your own run on the task and is assigned to you; it is refused with COWORK_UNIT_TAKEN while another '
      + 'open unit of that role exists on the task, so it is the atomic way to take a task (or, for a plan unit, to be its sole '
      + 'plan writer). A child unit needs your live claim on a unit of the same task and may be assigned to another eligible '
      + 'connection. Creating a unit grants nobody a claim: its assignee claims it with its own owner\'s grant. The same unitKey '
      + 'returns the existing unit (status existing).',
    inputSchema: z.strictObject({ ...execution,
      taskId: id.describe('The native task the unit is for.'),
      unitKey: z.string().regex(/^[a-zA-Z0-9_:.-]{1,200}$/).describe('A stable key for this unit, for example "take" or "review-1".'),
      expectedTaskVersion: version.describe('The task version you last read.'),
      assignmentConnectionId: id.describe('Your own connection for a root unit; for a child, the connection that should do it.'),
      parent: z.strictObject({ unitId: id, generation: version, leaseId: id }).nullable()
        .describe('null for a root unit; otherwise your live claim on a unit of the same task.') }),
    annotations,
  }, ({ taskId, unitKey, expectedTaskVersion, assignmentConnectionId, parent, ...input }) => run(() =>
    db.transaction((tx) => coWorkUnitCreateInTransaction(tx, claims, command(input, 'cowork.unit.create', taskId,
      { unitKey, expectedTaskVersion, assignmentConnectionId, parent }), COWORK_UNIT_POLICY))));

  register('cowork.request.claim').registerTool('flux_claim_request', {
    title: 'Pick up a request addressed to your unit under a standing grant',
    description: 'Claim one request addressed to your own unit, at the request version you last read, under your live claim on '
      + 'that unit. Needs a live cowork.request.claim grant whose class is your unit\'s role, and the runtime from flux_bootstrap. '
      + 'A request is claimed once per live claim; after your claim is lost it can be claimed again. Without a live unit claim this '
      + 'is refused with COWORK_CLAIM_LOST.',
    inputSchema: z.strictObject({ ...execution, ...requestFence }), annotations,
  }, ({ unitId, generation, leaseId, requestId, expectedRequestVersion, ...input }) => run(() =>
    db.transaction((tx) => coWorkRequestResponseInTransaction(tx, claims, command(input, 'cowork.request.claim', unitId,
      { generation, leaseId, requestId, expectedRequestVersion }), COWORK_RESPONSES_WITHOUT_PUBLICATION))));

  register('cowork.request.respond').registerTool('flux_decline_request', {
    title: 'Decline a request you picked up under a standing grant',
    description: 'Decline one request you claimed under your live unit claim, with a bounded reason: capability, policy, scope '
      + 'or source_changed. The sender sees the outcome; it is never a silent drop. Needs a live cowork.request.respond grant '
      + 'whose class is your unit\'s role, and the runtime from flux_bootstrap. Resolving a request with a response is not '
      + 'available on this server yet.',
    inputSchema: z.strictObject({ ...execution, ...requestFence, reason: z.enum(COWORK_DECLINE_REASONS) }), annotations,
  }, ({ unitId, generation, leaseId, requestId, expectedRequestVersion, reason, ...input }) => run(() =>
    db.transaction((tx) => coWorkRequestResponseInTransaction(tx, claims, command(input, 'cowork.request.respond', unitId,
      { generation, leaseId, requestId, expectedRequestVersion, outcome: 'declined', reason }), COWORK_RESPONSES_WITHOUT_PUBLICATION))));
}
