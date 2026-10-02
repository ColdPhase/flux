import { z } from 'zod';
import { AGENT_OPERATION_CLASSES, WORK_LIMITS, WORK_STATUSES, type AgentExecutionCommand, type AgentJsonValue,
  type AgentOperation, type AgentPostcondition, type CreateResultCommand, type CreateWorkCommand, type ObjectRef,
  type ProposeDecisionCommand, type UpdateWorkCommand } from '@flux/contracts';
import { agentExecutionUseCases, type Database, type Principal } from '@flux/core';
import { nativeWorkInTransaction } from '../work/adapters.js';
import type { FluxMcpClaims } from './context.js';
import { agentExecutionInTransaction } from './execution.js';
import type { AgentToolRegistry } from './tool-registry.js';
import { toolError, toolResult } from './tool-results.js';

const id = z.uuid();
const version = z.int().min(1).max(2_147_483_647);
const text = (maximum: number) => z.string().min(1).max(maximum);
const ids = z.array(id).max(WORK_LIMITS.links);
/** Exact current material revisions the action relies on; each must still be current when it commits. */
const sources = z.array(z.strictObject({ materialId: id, version })).max(50).default([]);
const execution = <C extends readonly ['execute', ...('execute' | 'plan')[]]>(classes: C) => ({
  projectId: id,
  runtimeSessionId: id.describe('The runtime ID returned by flux_bootstrap for this client session.'),
  grantId: id.describe('A live standing grant from flux_bootstrap for this exact operation, project and class.'),
  clientCommandId: id.describe('One UUID per intended effect; reuse it only to retry that same effect.'),
  peerRequestClass: z.enum(classes).describe('The class of the standing grant being used.'),
  sources,
});
const criteria = z.array(text(WORK_LIMITS.criterion)).max(WORK_LIMITS.criteria);
const dependencyIds = z.array(id).max(WORK_LIMITS.dependencies);
const annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true };

type ExecutionInput = { projectId: string; runtimeSessionId: string; grantId: string; clientCommandId: string;
  peerRequestClass: 'execute' | 'plan'; sources: { materialId: string; version: number }[] };
type Native = ReturnType<typeof nativeWorkInTransaction>;
type Produced<T> = { value: T; postconditions: AgentPostcondition[] };

/** The authorized material revisions become the object's sources; nothing else is linked implicitly. */
const materialSources = (input: ExecutionInput): { sources?: ObjectRef[] } => input.sources.length
  ? { sources: input.sources.map((source) => ({ type: 'material' as const, id: source.materialId, version: source.version })) } : {};

/**
 * Standing-grant native work actions. Each call is one caller-owned transaction: the #152 receipt port
 * authorizes the exact runtime/grant/source versions, the canonical native work command makes the change
 * as the agent, the receipt and debit are written, and only then the single final event batch is flushed.
 * A retry with the same command ID returns the stored outcome without a second effect, debit or event.
 */
export function registerAgentWorkActions(tools: AgentToolRegistry, db: Database, claims: FluxMcpClaims) {
  async function execute<T extends { [key: string]: AgentJsonValue }>(input: ExecutionInput, operation: AgentOperation,
    objectId: string | null, payload: AgentJsonValue, effect: (native: Native, agent: Principal) => Promise<Produced<T>>) {
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
        return effect(native, { kind: 'agent', id: scope.context.agentId });
      });
      await native.flushEvents();
      return { ...(value as T), replayed };
    });
  }
  const register = (operation: AgentOperation) => tools.forScope('flux.action.execute', { operation, classes: AGENT_OPERATION_CLASSES[operation] });

  register('work.create').registerTool('flux_create_task', {
    title: 'Create a project task under a standing grant',
    description: 'Create one native Flux task with optional done-when criteria, same-project prerequisites and a plan intent. '
      + 'Needs a live work.create standing grant and the runtime from flux_bootstrap. A plan intent names one exact current '
      + 'plan material revision and a key: repeating the same task for it returns the existing task instead of a duplicate. '
      + 'The cited source material revisions are linked to the task and must still be current.',
    inputSchema: z.strictObject({ ...execution(['execute', 'plan']), task: z.strictObject({
      title: text(WORK_LIMITS.title), outcome: z.string().max(WORK_LIMITS.outcome).optional(),
      status: z.enum(WORK_STATUSES).optional(), blocker: z.string().max(WORK_LIMITS.blocker).optional(),
      criteria: criteria.optional(), dependencyIds: dependencyIds.optional(),
      planIntent: z.strictObject({ materialId: id, version, intentKey: text(WORK_LIMITS.intentKey) }).optional(),
    }) }),
    annotations,
  }, async ({ task, ...input }) => {
    try {
      const created: CreateWorkCommand = { ...task, ...materialSources(input) };
      return toolResult(await execute(input, 'work.create', null, created as unknown as AgentJsonValue, async (native, agent) => {
        const work = await native.createWork(agent, input.projectId, created);
        return { value: { workId: work.id, version: work.version }, postconditions: [{ kind: 'work', id: work.id, version: work.version }] };
      }));
    } catch (error) { return toolError(error); }
  });

  register('work.update').registerTool('flux_update_task', {
    title: 'Change a project task under a standing grant',
    description: 'Change one existing native Flux task at the exact version you last read: title, outcome, status, blocker, '
      + 'done-when criteria (replaces the list) or prerequisites (replaces the set). Needs a live work.update standing grant '
      + 'for this task or project and the runtime from flux_bootstrap. A changed task is a version conflict; read it again. '
      + 'Starting or finishing requires every prerequisite to be done. A plan intent cannot be changed.',
    inputSchema: z.strictObject({ ...execution(['execute', 'plan']), workId: id, expectedVersion: version, changes: z.strictObject({
      title: text(WORK_LIMITS.title).optional(), outcome: z.string().max(WORK_LIMITS.outcome).optional(),
      status: z.enum(WORK_STATUSES).optional(), blocker: z.string().max(WORK_LIMITS.blocker).nullable().optional(),
      criteria: criteria.optional(), dependencyIds: dependencyIds.optional(),
    }) }),
    annotations,
  }, async ({ workId, expectedVersion, changes, ...input }) => {
    try {
      const update: UpdateWorkCommand = changes;
      return toolResult(await execute(input, 'work.update', workId, { expectedVersion, changes: update } as unknown as AgentJsonValue,
        async (native, agent) => {
          const work = await native.updateWork(agent, workId, update, expectedVersion);
          return { value: { workId: work.id, version: work.version }, postconditions: [{ kind: 'work', id: work.id, version: work.version }] };
        }));
    } catch (error) { return toolError(error); }
  });

  register('result.record').registerTool('flux_record_result', {
    title: 'Record a project result under a standing grant',
    description: 'Record one observed result: a positive or negative finding with its evidence, linked to the tasks and decisions '
      + 'it concerns. It can finish one of those tasks at the version you last read. Needs a live result.record grant (class '
      + 'execute) and the runtime from flux_bootstrap. The cited source material revisions are linked and must still be current. '
      + 'Record only what was actually observed.',
    inputSchema: z.strictObject({ ...execution(['execute']), result: z.strictObject({
      title: text(WORK_LIMITS.title), finding: z.enum(['positive', 'negative']), evidence: z.string().max(WORK_LIMITS.evidence).optional(),
      workIds: ids.optional(), decisionIds: ids.optional(),
      finishes: z.strictObject({ workId: id, expectedVersion: version }).optional()
        .describe('A task among workIds that this result completes, at the version you last read.'),
    }) }),
    annotations,
  }, async ({ result: { workIds, decisionIds, finishes, ...result }, ...input }) => {
    try {
      const recorded: CreateResultCommand = { ...result, ...materialSources(input), ...(workIds ? { work: workIds } : {}),
        ...(decisionIds ? { decisions: decisionIds } : {}), ...(finishes ? { finishes: { id: finishes.workId, expectedVersion: finishes.expectedVersion } } : {}) };
      return toolResult(await execute(input, 'result.record', null, recorded as unknown as AgentJsonValue, async (native, agent) => {
        const created = await native.createResult(agent, input.projectId, recorded);
        return { value: { resultId: created.id }, postconditions: [{ kind: 'result', id: created.id }] };
      }));
    } catch (error) { return toolError(error); }
  });

  register('decision.propose').registerTool('flux_propose_decision', {
    title: 'Propose a project decision under a standing grant',
    description: 'Propose one decision with its rationale, the tasks it affects and, optionally, the accepted decision it would '
      + 'replace. It stays proposed: an agent can never accept or reject a decision; a person with write access decides. Needs a '
      + 'live decision.propose grant and the runtime from flux_bootstrap. The cited source material revisions are linked and must '
      + 'still be current.',
    inputSchema: z.strictObject({ ...execution(['execute', 'plan']), decision: z.strictObject({
      title: text(WORK_LIMITS.title), rationale: z.string().max(WORK_LIMITS.rationale).optional(),
      supersedes: id.optional(), affects: ids.optional(),
    }) }),
    annotations,
  }, async ({ decision, ...input }) => {
    try {
      const proposed: ProposeDecisionCommand = { ...decision, ...materialSources(input) };
      return toolResult(await execute(input, 'decision.propose', null, proposed as unknown as AgentJsonValue, async (native, agent) => {
        const created = await native.proposeDecision(agent, input.projectId, proposed);
        return { value: { decisionId: created.id, version: created.version },
          postconditions: [{ kind: 'decision', id: created.id, version: created.version }] };
      }));
    } catch (error) { return toolError(error); }
  });
}
