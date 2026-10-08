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
  | { kind: 'tasks' }
  | { kind: 'material' }
  | { kind: 'other' };

/** The first source decides; a message wins over a thought, a thought over the rest. */
export function noticeSource(notice: Pick<TaskCreationNotice, 'sources'>, authorOf: (messageId: string) => string | null): NoticeSource {
  const pick = (type: ObjectRef['type']) => notice.sources.find((source) => source.type === type);
  const message = pick('message');
  if (message) return { kind: 'message', messageId: message.id, author: authorOf(message.id) };
  if (pick('thought') || pick('sketch')) return { kind: 'map' };
  if (pick('material')) return { kind: 'material' };
  return notice.sources.length ? { kind: 'other' } : { kind: 'tasks' };
}

/** "Jonas" for "Jonas Berg": the possessive reads as speech, not a form field. */
export function possessive(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? name;
  return `${first}’s`;
}

/** The part after the creator's name for one task: "made a task from", "added a task in Tasks", ... */
export function sourcePhrase(source: NoticeSource): { lead: string; link?: string } {
  switch (source.kind) {
    case 'message': return source.author ? { lead: 'made a task from', link: `${possessive(source.author)} message` } : { lead: 'made a task from', link: 'a message' };
    case 'map': return { lead: 'added a task on the Map' };
    case 'material': return { lead: 'made a task from a source' };
    case 'other': return { lead: 'added a task' };
    default: return { lead: 'added a task in Tasks' };
  }
}

/** Plain words for the folded line: "Ada made 2 tasks, Claude Code added 1 task on the Map". */
export function foldSummary(notices: TaskCreationNotice[], authorOf: (messageId: string) => string | null, nameOf: (notice: TaskCreationNotice) => string): string {
  const groups = new Map<string, { name: string; count: number; where: string }>();
  for (const notice of notices) {
    const source = noticeSource(notice, authorOf);
    const where = source.kind === 'map' ? ' on the Map' : source.kind === 'tasks' ? '' : source.kind === 'message' ? ' from messages' : source.kind === 'material' ? ' from a source' : '';
    const name = nameOf(notice);
    const key = `${notice.createdBy.kind}:${notice.createdBy.id}:${where}`;
    const group = groups.get(key) ?? { name, count: 0, where };
    group.count += 1;
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => `${group.name} added ${group.count === 1 ? 'a task' : `${group.count} tasks`}${group.where}`).join(', ');
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

/** The words of "Since you left: …" from the summary's items: messages, task updates, decisions, results. */
export function sinceLine(summary: Pick<ReturnSummary, 'items' | 'more'>): string {
  const count = (kinds: string[]) => summary.items.filter((item) => kinds.includes(item.kind)).length;
  const plus = summary.more ? '+' : '';
  const part = (n: number, one: string, many: string) => n ? `${n}${plus} ${n === 1 && !plus ? one : many}` : null;
  return [part(count(['message']), 'message', 'messages'), part(count(['work', 'question']), 'task update', 'task updates'),
    part(count(['decision']), 'decision', 'decisions'), part(count(['result']), 'result', 'results'),
    part(count(['material', 'sketch', 'doc']), 'other change', 'other changes')].filter(Boolean).join(' · ');
}

/** The first thing unread that the stream can show, oldest first; items arrive newest first. */
export function firstUnread(summary: Pick<ReturnSummary, 'items'>, roots: ConversationRoot[]): { messageId: string; conversationId: string | null } | { workId: string } | null {
  const rootIds = new Set(roots.map((root) => root.message.id));
  for (const item of [...summary.items].reverse()) {
    const source = item.source;
    if (source.type === 'message') return { messageId: source.messageId, conversationId: rootIds.has(source.messageId) ? null : source.conversationId };
    if (source.type === 'work') return { workId: source.id };
  }
  return null;
}

/** The author of a loaded root's message, by id, for "from Jonas’s message". */
export function rootAuthor(roots: ConversationRoot[], author: (message: ConversationMessage) => string) {
  const byId = new Map(roots.map((root) => [root.message.id, root.message]));
  return (messageId: string) => { const message = byId.get(messageId); return message ? author(message) : null; };
}
