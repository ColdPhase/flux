import { TASK_ACTIVITY_PAGE, type NamedPrincipal, type TaskActivityEntry, type TaskActivityPage, type TaskActivityQuery } from '@flux/contracts';
import { InvalidInputError } from '../access/errors.js';
import type { ActorRef, TaskActivityPosition, TaskActivityRecord, WorkPorts } from './ports.js';

// Reading a task's activity (#488). The repository keeps one entry per changed status, owner, due date or title in the
// transaction of the change (`WorkRepository.updateWork`); this turns the stored entries into the wire page with names.

const key = (actor: ActorRef) => `${actor.kind}:${actor.id}`;
const CURSOR = /^[A-Za-z0-9_-]{1,200}$/;
const POSITION = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** An opaque cursor: the position of the last entry of a page. */
export const encodeActivityCursor = (position: TaskActivityPosition): string => Buffer.from(JSON.stringify({ t: position.position, i: position.id })).toString('base64url');

function decodeActivityCursor(value: string): TaskActivityPosition {
  const refused = () => new InvalidInputError('before must be the nextBefore of an earlier page', 'INVALID_CURSOR');
  if (!CURSOR.test(value)) throw refused();
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { t?: unknown; i?: unknown };
    if (typeof parsed.t !== 'string' || typeof parsed.i !== 'string' || !POSITION.test(parsed.t) || !UUID.test(parsed.i)) throw refused();
    return { position: parsed.t, id: parsed.i };
  } catch (error) {
    throw error instanceof InvalidInputError ? error : refused();
  }
}

/** `limit` 1-50 (30 when omitted) and an optional cursor; anything else is refused, never clamped. */
export function activityWindow(query: TaskActivityQuery | undefined) {
  const limit = query?.limit === undefined ? TASK_ACTIVITY_PAGE.default : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > TASK_ACTIVITY_PAGE.max) throw new InvalidInputError(`limit must be an integer from 1 to ${TASK_ACTIVITY_PAGE.max}`);
  if (query?.before !== undefined && typeof query.before !== 'string') throw new InvalidInputError('before must be the nextBefore of an earlier page', 'INVALID_CURSOR');
  return { limit, before: query?.before === undefined ? null : decodeActivityCursor(query.before) };
}

/**
 * One newest-first page of `workId`'s activity. People and agents are named as the task names its owner and creator: a
 * person who has left shows as a former member, and an agent carries its owner only from the current project audience.
 * The caller has already authorized reading the task.
 */
export async function readTaskActivity(ports: WorkPorts, task: { id: string; projectId: string; workspaceId: string }, query: TaskActivityQuery | undefined): Promise<TaskActivityPage> {
  const window = activityWindow(query);
  const { items, hasMore } = await ports.work.listTaskActivity(task.id, window);
  const waiting = (record: TaskActivityRecord): ActorRef | null => record.kind === 'status' && record.waitingForUserId ? { kind: 'human', id: record.waitingForUserId } : null;
  const people = items.flatMap((record) => [record.by, waiting(record), ...(record.kind === 'owner' ? [record.from, record.to] : [])].filter((who): who is ActorRef => who !== null));
  const names = people.length ? await ports.work.names(people) : new Map<string, string>();
  const agentIds = [...new Set(people.filter((who) => who.kind === 'agent').map((who) => who.id))];
  const owners = agentIds.length && ports.work.agentOwners ? await ports.work.agentOwners(task.projectId, task.workspaceId, agentIds) : new Map();
  const named = (who: ActorRef): NamedPrincipal => {
    const projectOwner = who.kind === 'agent' ? owners.get(who.id) : undefined;
    return { ...who, name: names.get(key(who)) ?? (who.kind === 'agent' ? 'Agent' : 'Former member'), ...(projectOwner ? { projectOwner } : {}) };
  };
  const namedOrNull = (who: ActorRef | null) => who ? named(who) : null;
  const entries = items.map((record): TaskActivityEntry => {
    const base = { id: record.id, kind: record.kind, at: record.at.toISOString(), actor: named(record.by), ...(record.automation ? { automation: record.automation } : {}) };
    switch (record.kind) {
      case 'status': return { ...base, status: { from: record.from, to: record.to, blocker: record.blocker, waitingFor: namedOrNull(waiting(record)) } };
      case 'owner': return { ...base, owner: { from: namedOrNull(record.from), to: namedOrNull(record.to) } };
      case 'due': return { ...base, due: { from: record.from, to: record.to } };
      case 'title': return { ...base, title: { from: record.from, to: record.to } };
    }
  });
  const last = items.at(-1);
  return { workId: task.id, items: entries, nextBefore: hasMore && last ? encodeActivityCursor({ position: last.position, id: last.id }) : null };
}
