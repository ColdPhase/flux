import { z } from 'zod';
import { AGENT_OPERATION_CLASSES, AGENT_PEER_REQUEST_CLASSES, type AgentExecutionCommand, type AgentJsonValue,
  type AgentOperation, type AgentPeerRequestClass } from '@flux/contracts';
import { COWORK_CHECKPOINT_LIMITS, InvalidInputError } from '@flux/core';
import { assistantChangeRows, type Database, type DbExecutor, type Transaction } from '@flux/db';
import { ownerAssistantUnitCreationInTransaction } from '../co-work/assistant-units.js';
import { coWorkClaimCheckpoint, coWorkClaimInTransaction } from '../co-work/claims.js';
import { COWORK_CLAIM_POLICY, COWORK_UNIT_POLICY } from '../co-work/policy.js';
import { coWorkUnitTransitionInTransaction } from '../co-work/transitions.js';
import { coWorkUnitCreateInTransaction, coWorkUnitOutcome } from '../co-work/units.js';
import { actionAnnotations as annotations, actionId as id, actionVersion as version, nativeActionExecutor, type ActionInput } from './action-execution.js';
import type { FluxMcpClaims } from './context.js';
import type { AgentToolRegistry } from './tool-registry.js';
import { toolError, toolResult } from './tool-results.js';
import { agentSourceCheckpointSchema } from './bootstrap.js';

/** The fields of a co-work tool; the class is the role of the unit the command acts on. */
const execution = {
  projectId: id,
  runtimeSessionId: id.describe('The runtime ID returned by flux_bootstrap for this client session.'),
  clientCommandId: id.describe('One UUID per intended effect; reuse it only to retry that same effect.'),
  peerRequestClass: z.enum(AGENT_PEER_REQUEST_CLASSES).describe('The role of the unit the command acts on.'),
};
type Execution = { projectId: string; runtimeSessionId: string; clientCommandId: string;
  peerRequestClass: AgentPeerRequestClass };
/** Your live claim on your own unit, at the unit version you last read. */
const unitFence = {
  unitId: id.describe('Your own unit.'),
  expectedVersion: version.describe('The unit version you last read (from the claim, renewal or creation result).'),
  generation: version.describe('The generation of your live claim on that unit.'),
  leaseId: id.describe('The lease ID of your live claim on that unit.'),
};
const checkpointText = (maximum: number) => z.string().min(1).max(maximum);
/** One exact native reference; GitHub outcomes wait for the #74 recipient adapter. */
const outcomeRef = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('message'), id }),
  z.strictObject({ type: z.enum(['material', 'doc', 'work', 'thought']), id, version }),
]);
type Source = { materialId: string; version: number };

function command({ projectId, runtimeSessionId, clientCommandId, peerRequestClass }: Execution, operation: AgentOperation,
  objectId: string, payload: AgentJsonValue, sources: Source[] = []): AgentExecutionCommand {
  return { runtimeSessionId, clientCommandId, projectId, operation, peerRequestClass,
    audience: { kind: 'project', projectId }, objectId, sources, payload };
}

/** Whether a connection is another person's: what a client gives to it is another person's thing. Unknown connections fall to the ordinary refusal. */
async function forAnotherPerson(db: Database, claims: FluxMcpClaims, connectionId: string): Promise<boolean> {
  const connection = await assistantChangeRows(db as DbExecutor).connection(connectionId);
  return !!connection && connection.ownerUserId !== claims.ownerUserId;
}

/**
 * Co-work tools (#153) over the existing internal compositions, one transaction per call. Each composition runs #152's
 * prepare/complete itself (current runtime, owner rights, command ledger, receipt) and writes no stream event. Unit claims,
 * renewal, release, completion and transfer are tools since 2026-10-06 ("Unit claims over MCP"). Requests between clients, the inbox and
 * the review verdict were tools too until #973 removed them (docs/development/cowork-coordination.md).
 */
export function registerAgentCoworkActions(tools: AgentToolRegistry, db: Database, claims: FluxMcpClaims) {
  const execute = nativeActionExecutor(db, claims);
  const register = (operation: AgentOperation) => tools.forAccess('write', { operation, classes: AGENT_OPERATION_CLASSES[operation] });
  const run = (handler: () => Promise<unknown>) => handler().then(toolResult, toolError);

  register('cowork.unit.create').registerTool('flux_create_unit', {
    title: 'Take a task or open a co-work unit on it',
    description: 'Open one co-work unit (execute, review or plan) on a native task at the exact task version you last read. '
      + 'Needs the runtime from flux_bootstrap. A root unit '
      + '(parent null) opens your own run on the task and is assigned to you; it is refused with COWORK_UNIT_TAKEN while another '
      + 'open unit of that role exists on the task, so it is the atomic way to take a task (or, for a plan unit, to be its sole '
      + 'plan writer). A child unit needs your live claim on a unit of the same task and may be assigned to another eligible '
      + 'connection. Creating a unit grants nobody a claim: its assignee claims it as its own owner. The same unitKey '
      + 'returns the existing unit (status existing).',
    inputSchema: z.strictObject({ ...execution,
      taskId: id.describe('The native task the unit is for.'),
      unitKey: z.string().regex(/^[a-zA-Z0-9_:.-]{1,200}$/).describe('A stable key for this unit, for example "take" or "review-1".'),
      expectedTaskVersion: version.describe('The task version you last read.'),
      assignmentConnectionId: id.describe('Your own connection for a root unit; for a child, the connection that should do it.'),
      parent: z.strictObject({ unitId: id, generation: version, leaseId: id }).nullable()
        .describe('null for a root unit; otherwise your live claim on a unit of the same task.') }),
    annotations,
  }, ({ taskId, unitKey, expectedTaskVersion, assignmentConnectionId, parent, ...input }) => run(async () => {
    // An assistant run, or the owner's Apply of its saved hand-off, is the only caller of the owner-assistant adapter: the server
    // chose it from the verified run context (claims), never from this input. Every other caller keeps the unchanged ordinary path.
    if (claims.run || claims.approval?.runId) {
      if (parent !== null) throw new InvalidInputError('A hand-off from your assistant has no parent unit');
      return execute(input as unknown as ActionInput, 'cowork.unit.create', taskId,
        { unitKey, expectedTaskVersion, assignmentConnectionId, parent: null, peerRequestClass: input.peerRequestClass },
        async ({ transaction, runtime }) => {
          const creation = await ownerAssistantUnitCreationInTransaction(transaction, runtime, input.projectId,
            { taskId, role: input.peerRequestClass, unitKey, expectedTaskVersion, assignmentConnectionId, parent: null },
            COWORK_UNIT_POLICY);
          return coWorkUnitOutcome(creation, { workspaceId: runtime.workspaceId, projectId: input.projectId });
        });
    }
    const create = async (tx: Transaction) => coWorkUnitCreateInTransaction(tx, claims, command(input, 'cowork.unit.create', taskId,
      { unitKey, expectedTaskVersion, assignmentConnectionId, parent }), COWORK_UNIT_POLICY);
    // A child unit given to another person's client is another person's thing: it waits for the owner's OK like a task for someone
    // else (C-18, #859), and Approve repeats this call as the client's own, while its runtime session and parent claim stay live.
    if (parent !== null && (claims.approval || await forAnotherPerson(db, claims, assignmentConnectionId)))
      return execute({ ...input, sources: [] } as unknown as ActionInput, 'cowork.unit.create', taskId,
        { unitKey, expectedTaskVersion, assignmentConnectionId, parent, peerRequestClass: input.peerRequestClass },
        async ({ transaction, runtime }) => coWorkUnitOutcome(await create(transaction), { workspaceId: runtime.workspaceId, projectId: input.projectId }));
    return db.transaction(create);
  }));

  register('cowork.claim').registerTool('flux_claim_unit', {
    title: 'Claim your co-work unit',
    description: 'Take the live lease on one unit assigned to you, at the unit version you last read: only one connection and '
      + 'one runtime session hold it, for 300 seconds. Needs the '
      + 'runtime from flux_bootstrap. One connection holds one live unit at a time (COWORK_CONNECTION_BUSY): release or complete '
      + 'it first. The task must be open (COWORK_TASK_CLOSED), and an execute unit needs every prerequisite done '
      + '(TASK_PREREQUISITES_UNMET). The result has the generation and lease ID that later unit tools need, and the '
      + 'unit\'s last checkpoint (summary, next action, blocker and the source versions it covered), if any.',
    inputSchema: z.strictObject({ ...execution, unitId: unitFence.unitId, expectedVersion: unitFence.expectedVersion }), annotations,
  }, ({ unitId, expectedVersion, ...input }) => run(() => db.transaction(async (tx) => {
    const outcome = await coWorkClaimInTransaction(tx, claims, command(input, 'cowork.claim', unitId, { expectedVersion }), COWORK_CLAIM_POLICY);
    return { ...outcome, checkpoint: await coWorkClaimCheckpoint(tx, { projectId: input.projectId, unitId: outcome.unitId },
      outcome.checkpointId) };
  })));

  register('cowork.renew').registerTool('flux_renew_unit', {
    title: 'Renew your live claim on a co-work unit',
    description: 'Extend your live lease on your own unit by another 300 seconds from now, before it ends. A lease that already ended, another runtime session or a stale '
      + 'version is refused with COWORK_CLAIM_LOST or COWORK_VERSION_CONFLICT: claim the unit again instead. If the task '
      + 'closed or a prerequisite reopened meanwhile, renewal is refused: release the unit with a checkpoint or complete it.',
    inputSchema: z.strictObject({ ...execution, ...unitFence }), annotations,
  }, ({ unitId, expectedVersion, generation, leaseId, ...input }) => run(() => db.transaction((tx) =>
    coWorkClaimInTransaction(tx, claims, command(input, 'cowork.renew', unitId, { expectedVersion, generation, leaseId }), COWORK_CLAIM_POLICY))));

  register('cowork.release').registerTool('flux_release_unit', {
    title: 'Pause your co-work unit with a checkpoint',
    description: 'Release your live claim at a safe boundary and leave the unit paused with a durable checkpoint: what you '
      + 'observably did (changed artifacts, checks you actually ran), the next action and any blocker. The source material '
      + 'revisions you relied on are recorded with it and must still be current. Never put a prompt, hidden reasoning or a '
      + 'transcript in it. Needs the runtime from flux_bootstrap. Whoever claims the unit next '
      + 'receives this checkpoint.',
    inputSchema: z.strictObject({ ...execution, ...unitFence,
      checkpoint: z.strictObject({ summary: checkpointText(COWORK_CHECKPOINT_LIMITS.summary),
        nextAction: checkpointText(COWORK_CHECKPOINT_LIMITS.nextAction),
        blocker: checkpointText(COWORK_CHECKPOINT_LIMITS.blocker).nullable(),
        orientation: z.strictObject({ known: z.array(agentSourceCheckpointSchema).max(50), gaps: z.array(checkpointText(500)).max(10) }).optional()
          .describe('Source checkpoints actually covered and missing context. Client-reported coverage, never authority.') }),
      sources: z.array(z.strictObject({ materialId: id, version })).max(50).default([])
        .describe('The exact current material revisions this checkpoint relies on.') }), annotations,
  }, ({ unitId, expectedVersion, generation, leaseId, checkpoint, sources, ...input }) => run(() => db.transaction((tx) =>
    coWorkClaimInTransaction(tx, claims, command(input, 'cowork.release', unitId, { expectedVersion, generation, leaseId, checkpoint }, sources),
      COWORK_CLAIM_POLICY))));

  register('cowork.unit.complete').registerTool('flux_complete_unit', {
    title: 'Complete your co-work unit with its outcome',
    description: 'Finish your own unit under your live claim, naming its outcome: one exact native record that exists now (a '
      + 'result or message ID, or a material, doc, task or thought at its version). Completion is final. It does not change '
      + 'the task or approve anything. '
      + 'Needs the runtime from flux_bootstrap. '
      + 'unit\'s role.',
    inputSchema: z.strictObject({ ...execution, ...unitFence, outcome: outcomeRef }), annotations,
  }, ({ unitId, expectedVersion, generation, leaseId, outcome, ...input }) => run(() => db.transaction(async (tx) =>
    coWorkUnitTransitionInTransaction(tx, claims, command(input, 'cowork.unit.complete', unitId,
      { expectedVersion, generation, leaseId, outcome })))));

  register('cowork.unit.transfer').registerTool('flux_transfer_unit', {
    title: 'Hand your co-work unit to another connection',
    description: 'Reassign your own unit, under your live claim, to another live connection of this company that has this '
      + 'project selected. The unit becomes pending for it and your claim ends; it claims the unit as its own owner '
      + 'and receives the unit\'s last checkpoint. An author never hands review of its own work to itself '
      + '(COWORK_REVIEW_SEPARATION).',
    inputSchema: z.strictObject({ ...execution, ...unitFence,
      assignmentConnectionId: id.describe('The connection that should continue the unit.') }), annotations,
  }, ({ unitId, expectedVersion, generation, leaseId, assignmentConnectionId, ...input }) => run(async () => {
    const payload = { expectedVersion, generation, leaseId, assignmentConnectionId };
    const transfer = async (tx: Transaction) => coWorkUnitTransitionInTransaction(tx, claims, command(input, 'cowork.unit.transfer', unitId, payload));
    // Handing the unit to another person's client is giving it another person's work: it waits for the owner's OK (C-18, #859).
    if (claims.approval || await forAnotherPerson(db, claims, assignmentConnectionId))
      return execute({ ...input, sources: [] } as unknown as ActionInput, 'cowork.unit.transfer', unitId, payload,
        async ({ transaction }) => ({ value: { ...await transfer(transaction) } as unknown as { [key: string]: AgentJsonValue }, postconditions: [] }));
    return db.transaction(transfer);
  }));

  register('cowork.unit.decline').registerTool('flux_decline_unit', {
    title: 'Hand a unit transferred to you back to the connection that sent it',
    description: 'Refuse a unit another connection transferred to you, before you claimed it and so before any artifact of yours '
      + 'exists. It returns paused to the connection that handed it over, with its last checkpoint and instruction untouched, '
      + 'and it can claim it again. Only the latest transfer can be declined, and only while you have not claimed the unit '
      + '(COWORK_DECLINE_REFUSED). Authorship of anything '
      + 'already completed never changes. Needs the runtime from flux_bootstrap.',
    inputSchema: z.strictObject({ ...execution, unitId: unitFence.unitId, expectedVersion: unitFence.expectedVersion }), annotations,
  }, ({ unitId, expectedVersion, ...input }) => run(() => db.transaction(async (tx) =>
    coWorkUnitTransitionInTransaction(tx, claims, command(input, 'cowork.unit.decline', unitId, { expectedVersion })))));
}
