import { z } from 'zod';
import { AGENT_OPERATION_CLASSES, WORK_LIMITS, WORK_STATUSES, type AgentJsonValue, type AgentOperation, type CreateResultCommand,
  type CreateWorkCommand, type ProposeDecisionCommand, type UpdateWorkCommand } from '@flux/contracts';
import type { Database } from '@flux/core';
import { actionAnnotations as annotations, actionId as id, actionInput as execution, actionVersion as version, materialSources,
  nativeActionExecutor } from './action-execution.js';
import type { FluxMcpClaims } from './context.js';
import type { AgentToolRegistry } from './tool-registry.js';
import { toolError, toolResult } from './tool-results.js';

const text = (maximum: number) => z.string().min(1).max(maximum);
const ids = z.array(id).max(WORK_LIMITS.links);
const criteria = z.array(text(WORK_LIMITS.criterion)).max(WORK_LIMITS.criteria);
const dependencyIds = z.array(id).max(WORK_LIMITS.dependencies);

/** Standing-grant native work actions through the shared one-transaction executor (`action-execution.ts`). */
export function registerAgentWorkActions(tools: AgentToolRegistry, db: Database, claims: FluxMcpClaims) {
  const execute = nativeActionExecutor(db, claims);
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
      return toolResult(await execute(input, 'work.create', null, created as unknown as AgentJsonValue, async ({ work: native, agent }) => {
        const work = await native.createWork(agent, input.projectId, created);
        return { value: { workId: work.id, number: work.number, version: work.version }, postconditions: [{ kind: 'work', id: work.id, version: work.version }] };
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
        async ({ work: native, agent }) => {
          const work = await native.updateWork(agent, workId, update, expectedVersion);
          return { value: { workId: work.id, number: work.number, version: work.version }, postconditions: [{ kind: 'work', id: work.id, version: work.version }] };
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
      return toolResult(await execute(input, 'result.record', null, recorded as unknown as AgentJsonValue, async ({ work: native, agent }) => {
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
      return toolResult(await execute(input, 'decision.propose', null, proposed as unknown as AgentJsonValue, async ({ work: native, agent }) => {
        const created = await native.proposeDecision(agent, input.projectId, proposed);
        return { value: { decisionId: created.id, version: created.version },
          postconditions: [{ kind: 'decision', id: created.id, version: created.version }] };
      }));
    } catch (error) { return toolError(error); }
  });
}
