import {
  MAX_SNOOZE_DAYS,
  type NeedsYouItem,
  type NeedsYouKind,
  type NeedsYouResolved,
  type NeedsYouResponse,
  type NeedsYouTaskRef,
  type ResolveNeedsYouCommand,
} from '@flux/contracts';
import { ForbiddenError, InvalidInputError, NotFoundError } from '../access/errors.js';
import type { Principal } from '../principal.js';
import { linkReader } from '../work/service.js';
import type { WorkRecord } from '../work/ports.js';
import type { NeedsYouPorts, StoredNeedsYou } from './ports.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^(decision|blocked|note):[0-9a-f-]{36}$/i;
/** Mentions older than this no longer ask for an answer; they stay in the notification history. */
const MENTION_DAYS = 14;
/** Most items of the queue; a project with more proposals than this still has them in Details. */
const MAX_ITEMS = 300;
const MAX_DECISIONS = 200;
const MAX_ACCEPTERS = 6;
const OVER = new Set(['done', 'not_pursued']);

const iso = (date: Date) => date.toISOString();
const excerpt = (text: string, max = 200) => {
  const line = text.trim().replace(/\s+/g, ' ');
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};
const ref = (work: Pick<WorkRecord, 'id' | 'number' | 'title'>): NeedsYouTaskRef => ({ id: work.id, number: work.number, title: work.title });
const ORDER: Record<NeedsYouKind, number> = { decision: 0, question: 1, blocked: 2, mention: 3 };

function human(principal: Principal) {
  if (principal.kind !== 'human' || !principal.id) throw new ForbiddenError('Only a signed-in person has an Inbox', 'NEEDS_YOU_NEEDS_PERSON');
  return principal.id;
}

/** Whether a stored state still holds at `now`, given the status of the task it may wait for. */
function holds(state: StoredNeedsYou, now: Date, statuses: Map<string, string>) {
  if (state.state !== 'snoozed') return true;
  if (state.until) return state.until.getTime() > now.getTime();
  // A task that is finished, set aside or no longer there ends the wait.
  const status = state.untilWorkId ? statuses.get(state.untilWorkId) : undefined;
  return status !== undefined && !OVER.has(status);
}

/**
 * The Inbox "Needs you" queue (#342, F-026 S1/S11). What needs a person is computed from current rows
 * for them alone: proposed decisions they can accept (O-009 DA-2: one person with write access
 * accepts), people's questions to them, their blocked tasks and unread mentions. Only what the person
 * did with an item is stored. Every list is filtered by the access policy at the moment of reading.
 */
export function createNeedsYou(ports: NeedsYouPorts, now: () => Date = () => new Date()) {
  async function candidates(principal: Principal): Promise<NeedsYouItem[]> {
    const userId = human(principal);
    const items: NeedsYouItem[] = [];
    const workspaceIds = await ports.access.workspaceIds(principal);
    const projects = new Set<string>();
    const blocked: WorkRecord[] = [];
    for (const workspaceId of workspaceIds) {
      for (const id of await ports.access.visibleProjects(principal, workspaceId)) projects.add(id);
      const page = await ports.work.listAssignedVisible(principal, workspaceId, { kind: 'human', id: userId }, { limit: 200, offset: 0 });
      blocked.push(...page.items.filter((work) => work.status === 'blocked'));
    }

    // Proposed decisions the person can accept now.
    const proposed = await ports.repository.proposedDecisions([...projects], MAX_DECISIONS);
    const acceptable = new Map<string, boolean>();
    for (const projectId of new Set(proposed.map((decision) => decision.projectId))) acceptable.set(projectId, await ports.access.canAccept(principal, projectId));
    const decisions = proposed.filter((decision) => acceptable.get(decision.projectId));
    const links = await linkReader(ports.work, decisions.map((decision) => decision.id));
    const authors = await ports.work.names(decisions.map((decision) => decision.proposedBy));
    const projectNames = await ports.access.projectNames([...new Set([...decisions.map((d) => d.projectId), ...blocked.map((w) => w.projectId)])]);
    const accepters = new Map<string, { id: string; name: string; you: boolean }[]>();
    for (const projectId of new Set(decisions.map((decision) => decision.projectId))) {
      const people = (await ports.access.accepters(projectId, MAX_ACCEPTERS + 1)).map((person) => ({ ...person, you: person.id === userId }));
      accepters.set(projectId, [...people.filter((person) => person.you), ...people.filter((person) => !person.you)].slice(0, MAX_ACCEPTERS));
    }
    const works = new Map<string, WorkRecord | null>();
    const work = async (id: string) => {
      if (!works.has(id)) works.set(id, await ports.work.findWork(id));
      return works.get(id) ?? null;
    };
    for (const decision of decisions) {
      const related = links(decision.id).filter((link) => link.from.id === decision.id);
      const basedOn = related.filter((link) => link.role === 'source' && link.toTitle).map((link) => link.toTitle).slice(0, 4);
      const affects: NeedsYouTaskRef[] = [];
      for (const link of related.filter((entry) => entry.role === 'affects' && entry.to.type === 'work').slice(0, 4)) {
        const task = await work(link.to.id);
        // Only work in this decision's project, and only work still to do, is worth waiting for.
        if (task && task.projectId === decision.projectId && !OVER.has(task.status)) affects.push(ref(task));
      }
      const by = decision.proposedBy;
      const name = authors.get(`${by.kind}:${by.id}`) ?? (by.kind === 'agent' ? 'Agent' : 'Someone');
      const supersedes = decision.supersedesId ? (await ports.work.findDecision(decision.supersedesId))?.title ?? null : null;
      items.push({
        key: `decision:${decision.id}`, kind: 'decision', title: decision.title, detail: excerpt(decision.rationale),
        project: { id: decision.projectId, name: projectNames.get(decision.projectId) ?? 'Project' },
        from: { kind: by.kind, id: by.id, name }, at: iso(decision.createdAt),
        url: `/projects/${decision.projectId}/tasks?open=decision:${decision.id}`,
        decision: {
          id: decision.id, version: decision.version, proposedBy: { kind: by.kind, id: by.id, name }, basedOn, affects,
          accepters: accepters.get(decision.projectId) ?? [], canAccept: true, supersedes,
        },
        blocked: null, reason: null, snoozeTask: affects[0] ?? null,
      });
    }

    // The person's blocked tasks.
    const plans = blocked.length ? await ports.work.taskPlans(blocked.map((task) => task.id)) : new Map();
    for (const task of blocked) {
      const waiting = plans.get(task.id)?.prerequisites.find((item: { status: string; parked: boolean; id: string }) => !OVER.has(item.status));
      const waitingTask = waiting ? await work(waiting.id) : null;
      items.push({
        key: `blocked:${task.id}`, kind: 'blocked', title: task.blocker?.trim() ? `#${task.number} is blocked: ${excerpt(task.blocker, 120)}` : `#${task.number} ${task.title} is blocked`,
        detail: task.title, project: { id: task.projectId, name: projectNames.get(task.projectId) ?? 'Project' },
        from: null, at: iso(task.updatedAt), url: `/projects/${task.projectId}/tasks?open=work:${task.id}`,
        decision: null, reason: null,
        blocked: { workId: task.id, number: task.number, version: task.version, blocker: task.blocker, since: iso(task.updatedAt), waitingFor: waitingTask ? ref(waitingTask) : null },
        snoozeTask: waitingTask ? ref(waitingTask) : null,
      });
    }

    // People's questions and mentions, still unread.
    const since = now().getTime() - MENTION_DAYS * 86_400_000;
    const inbox = await ports.inbox.listReadable(userId, 100);
    for (const note of inbox.items) {
      if ((note.reason !== 'mention' && note.reason !== 'question' && note.reason !== 'invitation') || note.readAt || note.createdAt.getTime() < since) continue;
      // Someone asking you something, or to join them, is a question; a mention is a mention.
      const kind: NeedsYouKind = note.reason === 'mention' ? 'mention' : 'question';
      items.push({
        key: `note:${note.id}`, kind, title: note.title, detail: excerpt(note.body), project: null, from: null,
        at: iso(note.createdAt), url: note.url ?? `/inbox/${note.id}`, decision: null, blocked: null, reason: note.reason, snoozeTask: null,
      });
    }
    return items.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || b.at.localeCompare(a.at));
  }

  /** The queue after the person's own choices; also forgets choices that no longer mean anything. */
  async function queue(principal: Principal) {
    const userId = human(principal);
    const all = await candidates(principal);
    const stored = await ports.repository.states(userId);
    const statuses = await ports.repository.workStatuses(stored.flatMap((entry) => (entry.untilWorkId ? [entry.untilWorkId] : [])));
    const at = now();
    const byKey = new Map(stored.map((entry) => [entry.key, entry]));
    const shown: NeedsYouItem[] = [];
    let later = 0;
    for (const item of all) {
      const entry = byKey.get(item.key);
      if (!entry || !holds(entry, at, statuses)) { shown.push(item); continue; }
      if (entry.state === 'snoozed') later += 1;
    }
    // A snooze that ended, and a choice about a decision or task that is no longer a need, are forgotten.
    const keys = new Set(all.map((item) => item.key));
    const stale = stored.filter((entry) => (entry.state === 'snoozed' && !holds(entry, at, statuses))
      || (!entry.key.startsWith('note:') && !keys.has(entry.key))).map((entry) => entry.key);
    await ports.repository.deleteStates(userId, stale);
    const dayAgo = at.getTime() - 86_400_000;
    const doneToday = stored.filter((entry) => entry.state !== 'snoozed' && entry.updatedAt.getTime() >= dayAgo && (entry.key.startsWith('note:') || keys.has(entry.key))).length;
    return { items: shown.slice(0, MAX_ITEMS), all, later, doneToday };
  }

  return {
    async list(principal: Principal): Promise<NeedsYouResponse> {
      const { items, later, doneToday } = await queue(principal);
      return { items, count: items.length, later, doneToday };
    },

    async resolve(principal: Principal, key: string, command: ResolveNeedsYouCommand): Promise<NeedsYouResolved> {
      const userId = human(principal);
      if (!KEY.test(key)) throw new NotFoundError('Inbox item', 'NEEDS_YOU_NOT_FOUND');
      const item = (await candidates(principal)).find((entry) => entry.key === key.toLowerCase());
      if (!item) throw new NotFoundError('Inbox item', 'NEEDS_YOU_NOT_FOUND');
      let value: { state: 'done' | 'declined' | 'snoozed'; until: Date | null; untilWorkId: string | null };
      const extra = (command as { until?: unknown; untilWorkId?: unknown });
      if (command.action !== 'snooze' && (extra.until !== undefined || extra.untilWorkId !== undefined)) throw new InvalidInputError('Only a snooze has a time or a task');
      if (command.action === 'snooze' && (extra.until === undefined) === (extra.untilWorkId === undefined)) throw new InvalidInputError('Snooze until a time or until a task is done, not both', 'NEEDS_YOU_SNOOZE_CHOICE');
      if (command.action === 'done') value = { state: 'done', until: null, untilWorkId: null };
      else if (command.action === 'decline') value = { state: 'declined', until: null, untilWorkId: null };
      else if (typeof extra.untilWorkId === 'string') {
        if (!UUID.test(extra.untilWorkId) || item.snoozeTask?.id !== extra.untilWorkId) throw new InvalidInputError('This item has no such task to wait for', 'NEEDS_YOU_TASK_UNKNOWN');
        value = { state: 'snoozed', until: null, untilWorkId: extra.untilWorkId };
      } else {
        const until = new Date(String(extra.until));
        const ahead = until.getTime() - now().getTime();
        if (Number.isNaN(until.getTime()) || ahead < 60_000 || ahead > MAX_SNOOZE_DAYS * 86_400_000) {
          throw new InvalidInputError(`Choose a time from a minute to ${MAX_SNOOZE_DAYS} days ahead`, 'NEEDS_YOU_SNOOZE_RANGE');
        }
        value = { state: 'snoozed', until, untilWorkId: null };
      }
      await ports.repository.putState(userId, item.key, value);
      // Done is also "read" for a mention or question, so the notification history agrees.
      if (item.key.startsWith('note:') && value.state !== 'snoozed') await ports.repository.setNotificationRead(userId, item.key.slice(5), true);
      return { key: item.key, state: value.state, until: value.until ? iso(value.until) : null, untilWorkId: value.untilWorkId };
    },

    /** Undo of `resolve`: the item is back as it was. Only the person's own choice is touched. */
    async restore(principal: Principal, key: string): Promise<void> {
      const userId = human(principal);
      if (!KEY.test(key)) throw new NotFoundError('Inbox item', 'NEEDS_YOU_NOT_FOUND');
      const lower = key.toLowerCase();
      const own = (await ports.repository.states(userId)).find((entry) => entry.key === lower);
      if (!own) return;
      await ports.repository.deleteStates(userId, [lower]);
      if (lower.startsWith('note:') && own.state !== 'snoozed') await ports.repository.setNotificationRead(userId, lower.slice(5), false);
    },
  };
}

export type NeedsYouUseCases = ReturnType<typeof createNeedsYou>;
