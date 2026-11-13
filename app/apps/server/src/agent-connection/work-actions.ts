import { z } from 'zod';
import { AGENT_OPERATION_CLASSES, WORK_LIMITS, WORK_STATUSES, type AgentJsonValue, type AgentOperation,
  type CreateWorkCommand, type ProposeDecisionCommand, type UpdateWorkCommand } from '@flux/contracts';
import type { Database } from '@flux/db';
import { actionAnnotations as annotations, actionId as id, actionInput as execution, actionVersion as version, materialSources, nativeActionExecutor,
  type ActionInput } from './action-execution.js';
import type { AgentToolRegistry, ToolCall } from './tool-registry.js';
import { InvalidInputError, taskDueOn } from '@flux/core';
import { spacePerson } from './space-person.js';
import { toolError, toolResult } from './tool-results.js';

const text = (maximum: number) => z.string().min(1).max(maximum);
const ids = z.array(id).max(WORK_LIMITS.links);
const criteria = z.array(text(WORK_LIMITS.criterion)).max(WORK_LIMITS.criteria);
const dependencyIds = z.array(id).max(WORK_LIMITS.dependencies);

/** Native work actions through the shared one-transaction executor (`action-execution.ts`): the owner's rights, Ask me first and the change log. */
const waitingOnDecisionId = id.describe('Optional: the one decision (of this project, still proposed) a blocked task waits for. When it is accepted the task goes back to Doing by itself. Blocked tasks only; a task waits for one thing.');
const waitingOnTaskId = id.describe('Optional: the one other task (of this project, not done) a blocked task waits for. When it is done the task goes back to Doing by itself. Blocked tasks only; a task waits for one thing.');
/** The one thing a task waits for besides a person (#868), from the two ids a tool takes; `undefined` leaves it, `null` clears it. */
function waitingOnOf(decision: string | null | undefined, task: string | null | undefined): { kind: 'decision' | 'task'; id: string } | null | undefined {
  if (decision && task) throw new InvalidInputError('A task waits for one thing: give a decision or a task, not both');
  if (decision) return { kind: 'decision', id: decision };
  if (task) return { kind: 'task', id: task };
  return decision === null || task === null ? null : undefined;
}
/** A person of the space by name or user id (#1160), resolved by `spacePerson` before the change is prepared. */
const person = z.string().min(1).max(200);
const waitingFor = person.describe('Optional: the one person a blocked task waits for, a person of this space by their name as Flux shows it or their user id. They get an Inbox item. Blocked tasks only.');
/** The day a task is due (#488), as a person sets it: checked by the same rule (a real calendar day, 1970-9999). */
const dueOn = z.string().max(10).describe('Optional: the day the task is due, as YYYY-MM-DD.');

/**
 * A task change's fields as the change keeps them: the people it names as ids (#1160), a name resolved among the people of the space now, so
 * the call the owner's Approve repeats is the one they saw (an Approve resolves nothing again), and its due day checked (#1161).
 */
async function people<T extends Record<string, unknown>>(db: Database, call: ToolCall, projectId: string, fields: T, keys: readonly (keyof T & string)[]): Promise<T> {
  // A due day is checked as a person's is (#488) before anything is prepared, so a change that would wait never waits for a date it cannot set.
  if (fields.dueOn !== undefined) taskDueOn(fields.dueOn);
  if (call.claims.approval) return fields;
  const resolved: Record<string, unknown> = { ...fields };
  for (const key of keys) if (typeof fields[key] === 'string') resolved[key] = await spacePerson(db, call.claims, projectId, fields[key] as string);
  return resolved as T;
}
/** The input with the people it names as ids, and the call the change keeps with them (`assistantCall`, set by the change tool's wrapper). */
function withPeople(input: ActionInput, part: 'task' | 'changes', fields: Record<string, unknown>): ActionInput {
  const call = input.assistantCall;
  return call ? { ...input, assistantCall: { ...call, args: { ...call.args, [part]: { ...(call.args[part] as Record<string, unknown>), ...fields } } } } : input;
}

export function registerAgentWorkActions(tools: AgentToolRegistry, db: Database) {
  const execute = ({ claims }: ToolCall) => nativeActionExecutor(db, claims);
  const register = (operation: AgentOperation) => tools.forAccess('write', { operation, classes: AGENT_OPERATION_CLASSES[operation] });

  register('work.create').registerTool('flux_create_task', {
    title: 'Create a project task',
    description: 'Create one native Flux task with an optional owner (a person of this space, by name or user id), due day, done-when criteria, '
      + 'same-project prerequisites and a plan intent. A plan intent names one exact current '
      + 'plan material revision and a key: repeating the same task for it returns the existing task instead of a duplicate. '
      + 'The cited source material revisions are linked to the task and must still be current.',
    inputSchema: z.strictObject({ ...execution(), task: z.strictObject({
      title: text(WORK_LIMITS.title), outcome: z.string().max(WORK_LIMITS.outcome).optional(),
      status: z.enum(WORK_STATUSES).optional(), blocker: z.string().max(WORK_LIMITS.blocker).optional(),
      owner: person.describe('Optional: the person responsible, a person of this space by their name as Flux shows it ("Bogdan Wiśniewski", or "Bogdan" '
        + 'when nobody else there is called that) or their user id. A task for anyone but your owner waits for your owner\'s OK.').optional(),
      waitingFor: waitingFor.optional(), waitingOnDecisionId: waitingOnDecisionId.optional(), waitingOnTaskId: waitingOnTaskId.optional(),
      dueOn: dueOn.optional(), criteria: criteria.optional(), dependencyIds: dependencyIds.optional(),
      parentTaskId: id.describe('Optional: make this a subtask of this task of the project. A subtask for another person waits for your owner\'s OK.').optional(),
      sourceMessageId: id.describe('Optional: the message of this project this task was made from. It is kept as the task\'s source, so the task opens it in context and the message shows the task.').optional(),
      planIntent: z.strictObject({ materialId: id, version, intentKey: text(WORK_LIMITS.intentKey) }).optional(),
    }) }),
    annotations,
  }, async ({ task: { waitingOnDecisionId: onDecision, waitingOnTaskId: onTask, sourceMessageId, parentTaskId, ...named }, ...called }, call) => {
    try {
      const { owner, waitingFor: waiting, ...task } = await people(db, call, called.projectId, named, ['owner', 'waitingFor']);
      const input = withPeople(called, 'task', { ...(owner ? { owner } : {}), ...(waiting ? { waitingFor: waiting } : {}) });
      const waitingOn = waitingOnOf(onDecision, onTask);
      // #844: a task made from a message keeps it as its source, for people and agents alike (the message must be in this project).
      const sources = [...(materialSources(input).sources ?? []), ...(sourceMessageId ? [{ type: 'message' as const, id: sourceMessageId }] : [])];
      const created: CreateWorkCommand = { ...task, ...(owner ? { owner: { kind: 'human', id: owner } } : {}),
        ...(waiting ? { waitingFor: { kind: 'human', id: waiting } } : {}), ...(waitingOn ? { waitingOn } : {}), ...(sources.length ? { sources } : {}), ...(parentTaskId ? { parentId: parentTaskId } : {}) };
      return toolResult(await execute(call)(input, 'work.create', null, created as unknown as AgentJsonValue, async ({ work: native, agent }) => {
        const work = await native.createWork(agent, input.projectId, created);
        return { value: { workId: work.id, number: work.number, version: work.version }, postconditions: [{ kind: 'work', id: work.id, version: work.version }] };
      }));
    } catch (error) { return toolError(error); }
  });

  register('work.update').registerTool('flux_update_task', {
    title: 'Change a project task',
    description: 'Change one existing native Flux task at the exact version you last read: title, outcome, status, blocker, who it waits for (waitingFor, a person of this space by name or user id, or waitingOnDecisionId / waitingOnTaskId; blocked tasks only, one thing: the task goes back to Doing by itself when it is resolved), '
      + 'its due day (dueOn, YYYY-MM-DD; null clears it), finishing it with an optional one-line cameOfIt (dropped: true when it was dropped, not finished), '
      + 'done-when criteria (replaces the list) or prerequisites (replaces the set). '
      + 'A changed task is a version conflict; read it again. '
      + 'Starting or finishing requires every prerequisite to be done. A plan intent cannot be changed.',
    inputSchema: z.strictObject({ ...execution(), workId: id, expectedVersion: version, changes: z.strictObject({
      title: text(WORK_LIMITS.title).optional(), outcome: z.string().max(WORK_LIMITS.outcome).optional(),
      status: z.enum(WORK_STATUSES).optional(), blocker: z.string().max(WORK_LIMITS.blocker).nullable().optional(),
      waitingFor: waitingFor.nullable().optional(), waitingOnDecisionId: waitingOnDecisionId.nullable().optional(), waitingOnTaskId: waitingOnTaskId.nullable().optional(),
      dueOn: dueOn.nullable().optional(),
      dropped: z.boolean().optional().describe('With status done: the task was dropped, not finished.'),
      cameOfIt: z.string().max(WORK_LIMITS.cameOfIt).nullable().optional().describe('With status done: one line, what came of it. It is also written in the task\'s discussion.'),
      criteria: criteria.optional(), dependencyIds: dependencyIds.optional(),
    }) }),
    annotations,
  }, async ({ workId, expectedVersion, changes: named, ...called }, call) => {
    try {
      const changes = await people(db, call, called.projectId, named, ['waitingFor']);
      const input = withPeople(called, 'changes', changes.waitingFor ? { waitingFor: changes.waitingFor } : {});
      const { waitingFor: waiting, waitingOnDecisionId: onDecision, waitingOnTaskId: onTask, ...rest } = changes;
      const waitingOn = waitingOnOf(onDecision, onTask);
      const update: UpdateWorkCommand = { ...rest, ...(waiting === undefined ? {} : { waitingFor: waiting === null ? null : { kind: 'human', id: waiting } }),
        ...(waitingOn === undefined ? {} : { waitingOn }) };
      return toolResult(await execute(call)(input, 'work.update', workId, { expectedVersion, changes: update } as unknown as AgentJsonValue,
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
  }, async ({ workId, expectedVersion, ...input }, call) => {
    try {
      return toolResult(await execute(call)(input, 'work.creation.revert', workId, { expectedVersion }, async ({ work: native, agent }) => {
        const reverted = await native.undoTaskCreation(agent, workId, { clientCommandId: input.clientCommandId, expectedVersion });
        return { value: { workId, number: reverted.work.number, noticeId: reverted.noticeId, clientCommandId: reverted.clientCommandId, version: reverted.work.version },
          postconditions: [{ kind: 'work', id: workId, version: reverted.work.version }] };
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
  }, async ({ decision, ...input }, call) => {
    try {
      const proposed: ProposeDecisionCommand = { ...decision, ...materialSources(input) };
      return toolResult(await execute(call)(input, 'decision.propose', null, proposed as unknown as AgentJsonValue, async ({ work: native, agent }) => {
        const created = await native.proposeDecision(agent, input.projectId, proposed);
        return { value: { decisionId: created.id, version: created.version },
          postconditions: [{ kind: 'decision', id: created.id, version: created.version }] };
      }));
    } catch (error) { return toolError(error); }
  });
}
