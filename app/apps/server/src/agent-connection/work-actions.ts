import { z } from 'zod';
import { AGENT_OPERATION_CLASSES, WORK_LIMITS, WORK_STATUSES, type AgentJsonValue, type AgentOperation, type CreateResultCommand,
  type CreateWorkCommand, type ProposeDecisionCommand, type UpdateWorkCommand } from '@flux/contracts';
import type { Database } from '@flux/db';
import { actionAnnotations as annotations, actionId as id, actionInput as execution, actionVersion as version, materialSources, nativeActionExecutor } from './action-execution.js';
import type { FluxMcpClaims } from './context.js';
import type { AgentToolRegistry } from './tool-registry.js';
import { InvalidInputError } from '@flux/core';
import { toolError, toolResult } from './tool-results.js';

const text = (maximum: number) => z.string().min(1).max(maximum);
const ids = z.array(id).max(WORK_LIMITS.links);
const criteria = z.array(text(WORK_LIMITS.criterion)).max(WORK_LIMITS.criteria);
const dependencyIds = z.array(id).max(WORK_LIMITS.dependencies);

/** Native work actions through the shared one-transaction executor (`action-execution.ts`): the owner's rights, "What it may do" and the change log. */
const waitingOnDecisionId = id.describe('Optional: the one decision (of this project, still proposed) a blocked task waits for. When it is accepted the task goes back to Doing by itself. Blocked tasks only; a task waits for one thing.');
const waitingOnTaskId = id.describe('Optional: the one other task (of this project, not done) a blocked task waits for. When it is done the task goes back to Doing by itself. Blocked tasks only; a task waits for one thing.');
/** The one thing a task waits for besides a person (#868), from the two ids a tool takes; `undefined` leaves it, `null` clears it. */
function waitingOnOf(decision: string | null | undefined, task: string | null | undefined): { kind: 'decision' | 'task'; id: string } | null | undefined {
  if (decision && task) throw new InvalidInputError('A task waits for one thing: give a decision or a task, not both');
  if (decision) return { kind: 'decision', id: decision };
  if (task) return { kind: 'task', id: task };
  return decision === null || task === null ? null : undefined;
}
const waitingForUserId = z.string().min(1).max(200).describe('Optional: the one person a blocked task waits for, by user id. They get an Inbox item. Blocked tasks only.');

export function registerAgentWorkActions(tools: AgentToolRegistry, db: Database, claims: FluxMcpClaims) {
  const execute = nativeActionExecutor(db, claims);
  const register = (operation: AgentOperation) => tools.forAccess('write', { operation, classes: AGENT_OPERATION_CLASSES[operation] });

  register('work.create').registerTool('flux_create_task', {
    title: 'Create a project task',
    description: 'Create one native Flux task with optional done-when criteria, same-project prerequisites and a plan intent. '
      + 'A plan intent names one exact current '
      + 'plan material revision and a key: repeating the same task for it returns the existing task instead of a duplicate. '
      + 'The cited source material revisions are linked to the task and must still be current.',
    inputSchema: z.strictObject({ ...execution(), task: z.strictObject({
      title: text(WORK_LIMITS.title), outcome: z.string().max(WORK_LIMITS.outcome).optional(),
      status: z.enum(WORK_STATUSES).optional(), blocker: z.string().max(WORK_LIMITS.blocker).optional(),
      ownerUserId: z.string().min(1).max(200).describe('Optional: the person responsible, by user id. A task for anyone but your owner waits for your owner\'s OK.').optional(),
      waitingForUserId: waitingForUserId.optional(), waitingOnDecisionId: waitingOnDecisionId.optional(), waitingOnTaskId: waitingOnTaskId.optional(),
      criteria: criteria.optional(), dependencyIds: dependencyIds.optional(),
      parentTaskId: id.describe('Optional: make this a subtask of this task of the project. A subtask for another person waits for your owner\'s OK.').optional(),
      sourceMessageId: id.describe('Optional: the message of this project this task was made from. It is kept as the task\'s source, so the task opens it in context and the message shows the task.').optional(),
      planIntent: z.strictObject({ materialId: id, version, intentKey: text(WORK_LIMITS.intentKey) }).optional(),
    }) }),
    annotations,
  }, async ({ task: { waitingForUserId: waiting, waitingOnDecisionId: onDecision, waitingOnTaskId: onTask, ownerUserId, sourceMessageId, parentTaskId, ...task }, ...input }) => {
    try {
      const waitingOn = waitingOnOf(onDecision, onTask);
      // #844: a task made from a message keeps it as its source, for people and agents alike (the message must be in this project).
      const sources = [...(materialSources(input).sources ?? []), ...(sourceMessageId ? [{ type: 'message' as const, id: sourceMessageId }] : [])];
      const created: CreateWorkCommand = { ...task, ...(ownerUserId ? { owner: { kind: 'human', id: ownerUserId } } : {}),
        ...(waiting ? { waitingFor: { kind: 'human', id: waiting } } : {}), ...(waitingOn ? { waitingOn } : {}), ...(sources.length ? { sources } : {}), ...(parentTaskId ? { parentId: parentTaskId } : {}) };
      return toolResult(await execute(input, 'work.create', null, created as unknown as AgentJsonValue, async ({ work: native, agent }) => {
        const work = await native.createWork(agent, input.projectId, created);
        return { value: { workId: work.id, number: work.number, version: work.version }, postconditions: [{ kind: 'work', id: work.id, version: work.version }] };
      }));
    } catch (error) { return toolError(error); }
  });

  register('work.update').registerTool('flux_update_task', {
    title: 'Change a project task',
    description: 'Change one existing native Flux task at the exact version you last read: title, outcome, status, blocker, who it waits for (waitingForUserId, a project member, or waitingOnDecisionId / waitingOnTaskId; blocked tasks only, one thing: the task goes back to Doing by itself when it is resolved), '
      + 'finishing it with an optional one-line cameOfIt (dropped: true when it was dropped, not finished), '
      + 'done-when criteria (replaces the list) or prerequisites (replaces the set). '
      + 'A changed task is a version conflict; read it again. '
      + 'Starting or finishing requires every prerequisite to be done. A plan intent cannot be changed.',
    inputSchema: z.strictObject({ ...execution(), workId: id, expectedVersion: version, changes: z.strictObject({
      title: text(WORK_LIMITS.title).optional(), outcome: z.string().max(WORK_LIMITS.outcome).optional(),
      status: z.enum(WORK_STATUSES).optional(), blocker: z.string().max(WORK_LIMITS.blocker).nullable().optional(),
      waitingForUserId: waitingForUserId.nullable().optional(), waitingOnDecisionId: waitingOnDecisionId.nullable().optional(), waitingOnTaskId: waitingOnTaskId.nullable().optional(),
      dropped: z.boolean().optional().describe('With status done: the task was dropped, not finished.'),
      cameOfIt: z.string().max(WORK_LIMITS.cameOfIt).nullable().optional().describe('With status done: one line, what came of it. It is also written in the task\'s discussion.'),
      criteria: criteria.optional(), dependencyIds: dependencyIds.optional(),
    }) }),
    annotations,
  }, async ({ workId, expectedVersion, changes, ...input }) => {
    try {
      const { waitingForUserId: waiting, waitingOnDecisionId: onDecision, waitingOnTaskId: onTask, ...rest } = changes;
      const waitingOn = waitingOnOf(onDecision, onTask);
      const update: UpdateWorkCommand = { ...rest, ...(waiting === undefined ? {} : { waitingFor: waiting === null ? null : { kind: 'human', id: waiting } }),
        ...(waitingOn === undefined ? {} : { waitingOn }) };
      return toolResult(await execute(input, 'work.update', workId, { expectedVersion, changes: update } as unknown as AgentJsonValue,
        async ({ work: native, agent }) => {
          const work = await native.updateWork(agent, workId, update, expectedVersion);
          return { value: { workId: work.id, number: work.number, version: work.version }, postconditions: [{ kind: 'work', id: work.id, version: work.version }] };
        }));
    } catch (error) { return toolError(error); }
  });

  register('work.creation.revert').registerTool('flux_undo_task_creation', {
    title: 'Undo your unused task creation',
    description: 'Undo only a native task you created, while its complete creation baseline is unchanged and no persisted use exists. '
      + 'Needs the current task version. Taking a task back is a deletion, so it waits for your owner\'s OK. '
      + 'The task remains as read-only history with a creation-undone notice; repeating the same command returns its receipt.',
    inputSchema: z.strictObject({ ...execution(), workId: id, expectedVersion: version }),
    annotations: { ...annotations, destructiveHint: true },
  }, async ({ workId, expectedVersion, ...input }) => {
    try {
      return toolResult(await execute(input, 'work.creation.revert', workId, { expectedVersion }, async ({ work: native, agent }) => {
        const reverted = await native.undoTaskCreation(agent, workId, { clientCommandId: input.clientCommandId, expectedVersion });
        return { value: { workId, number: reverted.work.number, noticeId: reverted.noticeId, clientCommandId: reverted.clientCommandId, version: reverted.work.version },
          postconditions: [{ kind: 'work', id: workId, version: reverted.work.version }] };
      }));
    } catch (error) { return toolError(error); }
  });

  register('result.record').registerTool('flux_record_result', {
    title: 'Record a project result',
    description: 'Record one observed result: a positive or negative finding with its evidence, linked to the tasks and decisions '
      + 'it concerns. It can finish one of those tasks at the version you last read. The cited source material revisions are linked and must still be current. '
      + 'Record only what was actually observed.',
    inputSchema: z.strictObject({ ...execution(), result: z.strictObject({
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
    title: 'Propose a project decision',
    description: 'Propose one decision with its rationale, the tasks it affects and, optionally, the accepted decision it would '
      + 'replace. It stays proposed: an agent can never accept or reject a decision; a person with write access decides. The cited source material revisions are linked and must '
      + 'still be current.',
    inputSchema: z.strictObject({ ...execution(), decision: z.strictObject({
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
