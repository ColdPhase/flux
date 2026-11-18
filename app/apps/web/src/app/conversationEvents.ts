import type { ConversationMessage, ConversationRoot, ObjectRef, ReturnSummary, TaskCreationNotice } from '@flux/contracts';
import { day } from './messageParts';

interface StreamEntryLike { kind: string; key: string; at: string }

// What the stream says about task creation (F-026 S8, P5): one line per task with its source, and
// several in a row folded into one expandable line. Pure functions; the stream renders them.

/** Fewest consecutive announcements (one day, no message between) that fold into one line (S8). */
export const FOLD_AT = 3;

/** Where a task came from, as the announcement says it. */
export type NoticeSource =
  | { kind: 'message'; messageId: string; author: string | null }
  | { kind: 'map' }
  | { kind: 'none' }
  | { kind: 'material' }
  | { kind: 'other' };

/** The first source decides; a message wins over a thought, a thought over the rest. */
export function noticeSource(notice: Pick<TaskCreationNotice, 'sources'>, authorOf: (messageId: string) => string | null): NoticeSource {
  const pick = (type: ObjectRef['type']) => notice.sources.find((source) => source.type === type);
  const message = pick('message');
  if (message) return { kind: 'message', messageId: message.id, author: authorOf(message.id) };
  if (pick('thought') || pick('sketch')) return { kind: 'map' };
  if (pick('material')) return { kind: 'material' };
  // No source is not "made in Tasks": a task typed in the conversation or sent through the API has none either.
  return notice.sources.length ? { kind: 'other' } : { kind: 'none' };
}

/** "Jonas" for "Jonas Berg": the possessive reads as speech, not a form field. */
export function possessive(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? name;
  return `${first}’s`;
}

/**
 * Whose message, said to the reader (#763 WF-2): the actor's own message is "your message" when the reader is the actor
 * and "their own message" otherwise; anyone else's is "Jonas’s message".
 */
export function messageOf(author: string, actor?: { name: string; mine: boolean }): string {
  if (actor && author === actor.name) return actor.mine ? 'your message' : 'their own message';
  return `${possessive(author)} message`;
}

/** The part after the creator's name for one task: "created a task from", "created a task", ... A new task is always "created" (#1424). */
export function sourcePhrase(source: NoticeSource, actor?: { name: string; mine: boolean }): { lead: string; link?: string } {
  switch (source.kind) {
    case 'message': return source.author ? { lead: 'created a task from', link: messageOf(source.author, actor) } : { lead: 'created a task from', link: 'a message' };
    case 'map': return { lead: 'created a task from the map' };
    case 'material': return { lead: 'created a task from a source' };
    default: return { lead: 'created a task' };
  }
}

/**
 * Plain words for the folded line, each person named once (persona round 6): "Ada created 2 tasks, Claude Code created a task from the map",
 * "Stefan Nowak created 2 tasks and updated a task". Where every task of a person came from one place it is said ("from a message", "from the
 * map"); tasks from several places are only counted.
 */
export function foldSummary(notices: TaskCreationNotice[], authorOf: (messageId: string) => string | null, nameOf: (notice: TaskCreationNotice) => string): string {
  const people = new Map<string, { name: string; created: number; wheres: Set<string>; messages: Set<string>; updated: Set<string> }>();
  for (const notice of notices) {
    const key = `${notice.createdBy.kind}:${notice.createdBy.id}`;
    const person = people.get(key) ?? { name: nameOf(notice), created: 0, wheres: new Set<string>(), messages: new Set<string>(), updated: new Set<string>() };
    people.set(key, person);
    // A blocked or unblocked line (#550) is an update of a task, not a new one; two updates of one task are one task updated (personas-26).
    if (notice.kind === 'task.blocked' || notice.kind === 'task.unblocked' || notice.kind === 'task.resumed') { person.updated.add(notice.workId); continue; }
    const source = noticeSource(notice, authorOf);
    person.created += 1;
    person.wheres.add(source.kind === 'map' ? ' from the map' : source.kind === 'message' ? '\0message' : source.kind === 'material' ? ' from a source' : '');
    if (source.kind === 'message') person.messages.add(source.messageId);
  }
  const count = (n: number) => (n === 1 ? 'a task' : `${n} tasks`);
  return [...people.values()].map((person) => {
    const only = person.wheres.size === 1 ? [...person.wheres][0]! : '';
    // From one message it is "from a message", from several "from messages" (personas-27: never "from messages" for one).
    const from = only === '\0message' ? (person.messages.size === 1 ? ' from a message' : ' from messages') : only;
    const did = [person.created ? `created ${count(person.created)}${from}` : null, person.updated.size ? `updated ${count(person.updated.size)}` : null].filter(Boolean);
    return `${person.name} ${did.join(' and ')}`;
  }).join(', ');
}

/** The stream as drawn: roots, single announcements and folded runs of announcements. */
export type DisplayEntry<Root extends StreamEntryLike, Notice extends StreamEntryLike> =
  | Root
  | Notice
  | { kind: 'fold'; key: string; at: string; notices: Notice[] };

/**
 * Folds runs of at least {@link FOLD_AT} announcements of one day with no root between them (S8).
 * Runs are decided on the entries alone, so the same entries always fold the same way.
 */
export function foldEntries<Root extends StreamEntryLike, Notice extends StreamEntryLike & { kind: 'notice' }>(entries: (Root | Notice)[]): DisplayEntry<Root, Notice>[] {
  const out: DisplayEntry<Root, Notice>[] = [];
  let run: Notice[] = [];
  const flush = () => {
    if (run.length >= FOLD_AT) out.push({ kind: 'fold', key: `fold-${run[0]!.key}`, at: run[0]!.at, notices: run });
    else out.push(...run);
    run = [];
  };
  for (const entry of entries) {
    if (entry.kind !== 'notice') { flush(); out.push(entry); continue; }
    if (run.length && day(run[0]!.at) !== day(entry.at)) flush();
    run.push(entry as Notice);
  }
  flush();
  return out;
}

/** The first thing unread that the stream can show, oldest first; items arrive newest first. */
/** The first unread item; decisions count too (#763 H11-3), so Jump never lands after an accepted rule. */
export type UnreadTarget = { messageId: string; conversationId: string | null } | { workId: string } | { objectKind: 'decision'; objectId: string };
export function firstUnread(summary: Pick<ReturnSummary, 'items'>, roots: ConversationRoot[]): UnreadTarget | null {
  const rootIds = new Set(roots.map((root) => root.message.id));
  for (const item of [...summary.items].reverse()) {
    const source = item.source;
    if (source.type === 'message') return { messageId: source.messageId, conversationId: rootIds.has(source.messageId) ? null : source.conversationId };
    if (source.type === 'work') return { workId: source.id };
    if (source.type === 'decision') return { objectKind: source.type, objectId: source.id };
  }
  return null;
}

/** The author of a loaded root's message, by id, for "from Jonas’s message". */
export function rootAuthor(roots: ConversationRoot[], author: (message: ConversationMessage) => string) {
  const byId = new Map(roots.map((root) => [root.message.id, root.message]));
  return (messageId: string) => { const message = byId.get(messageId); return message ? author(message) : null; };
}
