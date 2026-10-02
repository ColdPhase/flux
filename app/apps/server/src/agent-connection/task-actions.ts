import { z } from 'zod';
import { AGENT_OPERATION_CLASSES, WORK_LIMITS, WORK_STATUSES, type AgentExecutionCommand, type AgentJsonValue,
  type CreateWorkCommand, type UpdateWorkCommand } from '@flux/contracts';
import { agentExecutionUseCases, type Database, type Principal } from '@flux/core';
import { nativeWorkInTransaction } from '../work/adapters.js';
import type { FluxMcpClaims } from './context.js';
import { agentExecutionInTransaction } from './execution.js';
import type { AgentToolRegistry } from './tool-registry.js';
import { toolError, toolResult } from './tool-results.js';

const id = z.uuid();
const version = z.int().min(1).max(2_147_483_647);
const text = (maximum: number) => z.string().min(1).max(maximum);
/** Exact current material revisions the action relies on; each must still be current when it commits. */
const sources = z.array(z.strictObject({ materialId: id, version })).max(50).default([]);
const execution = {
  projectId: id,
  runtimeSessionId: id.describe('The runtime ID returned by flux_bootstrap for this client session.'),
  grantId: id.describe('A live standing grant from flux_bootstrap for this exact operation, project and class.'),
  clientCommandId: id.describe('One UUID per intended effect; reuse it only to retry that same effect.'),
  peerRequestClass: z.enum(['execute', 'plan']).describe('The class of the standing grant being used.'),
  sources,
};
const criteria = z.array(text(WORK_LIMITS.criterion)).max(WORK_LIMITS.criteria);
const dependencyIds = z.array(id).max(WORK_LIMITS.dependencies);

type ExecutionInput = { projectId: string; runtimeSessionId: string; grantId: string; clientCommandId: string;
  peerRequestClass: 'execute' | 'plan'; sources: { materialId: string; version: number }[] };
type WorkReceipt = { workId: string; version: number };

/**
 * Standing-grant native task actions. Each call is one caller-owned transaction: the #152 receipt port
 * authorizes the exact runtime/grant/source versions, the canonical native work command makes the change
 * as the agent, the receipt and debit are written, and only then the single final event batch is flushed.
 * A retry with the same command ID returns the stored outcome without a second effect, debit or event.
 */
export function registerAgentTaskActions(tools: AgentToolRegistry, db: Database, claims: FluxMcpClaims) {
  async function execute(input: ExecutionInput, operation: 'work.create' | 'work.update', objectId: string | null,
    payload: AgentJsonValue, effect: (native: ReturnType<typeof nativeWorkInTransaction>, agent: Principal) => Promise<WorkReceipt>) {
    const command: AgentExecutionCommand = { runtimeSessionId: input.runtimeSessionId, grantId: input.grantId,
      clientCommandId: input.clientCommandId, projectId: input.projectId, operation, peerRequestClass: input.peerRequestClass,
      audience: { kind: 'project', projectId: input.projectId }, objectId, sources: input.sources, payload };
    return db.transaction(async (tx) => {
      const native = nativeWorkInTransaction(tx);
      let replayed = false;
      const value = await agentExecutionUseCases(agentExecutionInTransaction(tx, claims)).run(command, async (scope) => {
        if (scope.replay) {
          replayed = true;
          return { value: scope.replay.value, postconditions: scope.replay.postconditions };
        }
        const done = await effect(native, { kind: 'agent', id: scope.context.agentId });
        return { value: done, postconditions: [{ kind: 'work' as const, id: done.workId, version: done.version }] };
      });
      await native.flushEvents();
      return { ...(value as WorkReceipt), replayed };
    });
  }

  tools.forScope('flux.action.execute', { operation: 'work.create', classes: AGENT_OPERATION_CLASSES['work.create'] })
    .registerTool('flux_create_task', {
      title: 'Create a project task under a standing grant',
      description: 'Create one native Flux task with optional done-when criteria, same-project prerequisites and a plan intent. '
        + 'Needs a live work.create standing grant and the runtime from flux_bootstrap. A plan intent names one exact current '
        + 'plan material revision and a key: repeating the same task for it returns the existing task instead of a duplicate. '
        + 'The cited source material revisions are linked to the task and must still be current.',
      inputSchema: z.strictObject({ ...execution, task: z.strictObject({
        title: text(WORK_LIMITS.title), outcome: z.string().max(WORK_LIMITS.outcome).optional(),
        status: z.enum(WORK_STATUSES).optional(), blocker: z.string().max(WORK_LIMITS.blocker).optional(),
        criteria: criteria.optional(), dependencyIds: dependencyIds.optional(),
        planIntent: z.strictObject({ materialId: id, version, intentKey: text(WORK_LIMITS.intentKey) }).optional(),
      }) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    }, async ({ task, ...input }) => {
      try {
        // The task links exactly the material revisions the command was authorized against.
        const created: CreateWorkCommand = { ...task, ...(input.sources.length
          ? { sources: input.sources.map((source) => ({ type: 'material' as const, id: source.materialId, version: source.version })) } : {}) };
        return toolResult(await execute(input, 'work.create', null, created as unknown as AgentJsonValue, async (native, agent) => {
          const work = await native.createWork(agent, input.projectId, created);
          return { workId: work.id, version: work.version };
        }));
      } catch (error) { return toolError(error); }
    });

  tools.forScope('flux.action.execute', { operation: 'work.update', classes: AGENT_OPERATION_CLASSES['work.update'] })
    .registerTool('flux_update_task', {
      title: 'Change a project task under a standing grant',
      description: 'Change one existing native Flux task at the exact version you last read: title, outcome, status, blocker, '
        + 'done-when criteria (replaces the list) or prerequisites (replaces the set). Needs a live work.update standing grant '
        + 'for this task or project and the runtime from flux_bootstrap. A changed task is a version conflict; read it again. '
        + 'Starting or finishing requires every prerequisite to be done. A plan intent cannot be changed.',
      inputSchema: z.strictObject({ ...execution, workId: id, expectedVersion: version, changes: z.strictObject({
        title: text(WORK_LIMITS.title).optional(), outcome: z.string().max(WORK_LIMITS.outcome).optional(),
        status: z.enum(WORK_STATUSES).optional(), blocker: z.string().max(WORK_LIMITS.blocker).nullable().optional(),
        criteria: criteria.optional(), dependencyIds: dependencyIds.optional(),
      }) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    }, async ({ workId, expectedVersion, changes, ...input }) => {
      try {
        const update: UpdateWorkCommand = changes;
        return toolResult(await execute(input, 'work.update', workId, { expectedVersion, changes: update } as unknown as AgentJsonValue,
          async (native, agent) => {
            const work = await native.updateWork(agent, workId, update, expectedVersion);
            return { workId: work.id, version: work.version };
          }));
      } catch (error) { return toolError(error); }
    });
}
