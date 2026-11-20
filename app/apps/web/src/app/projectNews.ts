import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router';
import type { ReturnItem } from '@flux/contracts';
import { getReturnSummary } from '../returns/api';
import { useStreamEvents } from '../api/stream';
import { useShellData } from './data';

/**
 * Whether a project has something new for this person (#763 H11-4): what others did there since they last left its
 * conversation, from the same return-point summary the project reads. A space with news is unread (#1250: its name is bold in
 * the sidebar, unless it is muted, #1249). Nothing else set `hasNew`, so Home called every project "quiet" after a week of
 * activity. Read once per project and kept for a minute; the project the person is in is read again when they leave it, since
 * leaving moves its return point. "Mark all as read" forgets what was kept (`forgetProjectNews`). The dot is not this: it is for
 * what needs the person (`useNeedsYouSpaces`).
 *
 * The same read also says which of the news are messages and what the newest one was, for Home's "New messages" (#1548): a conversation
 * with a message from someone else that the person has not read, with its time and a line of it. It is read once for both.
 */
const TTL = 60_000;

/** What a space has that is new: every kind of thing (the sidebar's bold), and the messages among them (Home). */
export interface ProjectNews {
  news: number;
  /** How many conversations of it have something new, and the newest of them. */
  messages: number;
  latest: { at: string; actor: string | null; line: string } | null;
}
const NOTHING: ProjectNews = { news: 0, messages: 0, latest: null };
const known = new Map<string, { at: number; read: ProjectNews }>();
const reading = new Map<string, Promise<ProjectNews>>();
const listeners = new Set<() => void>();
/** Counts the times the kept answers were dropped: a read that began before one must not put its answer back. */
let epoch = 0;

/** A conversation's new messages, as one line: a question asked of the person says so itself; any other starts with who wrote it ("Maja: I moved…"). */
function lineOf(item: ReturnItem) {
  if (item.kind !== 'message') return item.text;
  const first = item.actor?.trim().split(/\s+/)[0];
  return item.detail ? (first ? `${first}: ${item.detail}` : item.detail) : item.text;
}

function summarize(items: readonly ReturnItem[]): ProjectNews {
  // The summary is newest first. A question put to the person is a message too: it is in "Waiting for you", and its conversation is new as well.
  const messages = items.filter((item) => item.source.type === 'message');
  const newest = messages[0];
  return { news: items.length, messages: messages.length, latest: newest ? { at: newest.at, actor: newest.actor, line: lineOf(newest) } : null };
}

/** Kept per account: nothing one person read about a project is shown to the next one in this tab. */
function read(userId: string, projectId: string): Promise<ProjectNews> {
  const id = `${userId}:${projectId}`;
  const cached = known.get(id);
  if (cached && Date.now() - cached.at < TTL) return Promise.resolve(cached.read);
  let pending = reading.get(id);
  if (!pending) {
    const began = epoch;
    pending = getReturnSummary({ type: 'project', id: projectId })
      .then((summary) => summarize(summary.items), () => NOTHING)
      .then((found) => { if (began === epoch) known.set(id, { at: Date.now(), read: found }); reading.delete(id); return found; });
    reading.set(id, pending);
  }
  return pending;
}

/** A message arrived in (or was removed from) a space: what was kept of it is stale. Only Home asks for this (`live`), so the sidebar stays as it was. */
const stale = new Set<string>();
const MESSAGE_EVENTS = new Set(['project.conversation_created.v1', 'project.message_sent.v1', 'project.message_removed.v1']);

/** Drops everything kept and tells the lists to read again (after "Mark all as read" and its Undo, #1250). */
export function forgetProjectNews() {
  epoch += 1;
  known.clear();
  reading.clear();
  for (const listener of [...listeners]) listener();
}

/** At most this many projects are asked about, in the order given (the sidebar's and Home's order). */
const LIMIT = 24;

/**
 * Each project with something new, with what that is. `live` reads a project again soon after a message arrives in it (Home's "New messages" is
 * live, #1548); without it a read is kept for a minute, which is all the sidebar needs.
 */
function useProjectReads(projectIds: readonly string[], live: boolean): { news: ReadonlyMap<string, ProjectNews>; settled: boolean } {
  const userId = useShellData().me.user.id;
  const here = useLocation().pathname.match(/^\/projects\/([^/]+)/)?.[1] ?? null;
  const key = projectIds.slice(0, LIMIT).join(',');
  const [again, setAgain] = useState(0);
  // False until every project of the list has been read once: what Home puts under its rows waits for that, so nothing moves when they arrive.
  const [settled, setSettled] = useState(false);
  const [news, setNews] = useState<ReadonlyMap<string, ProjectNews>>(() => new Map(projectIds.flatMap((id) => { const found = known.get(`${userId}:${id}`)?.read; return found && found.news ? [[id, found] as const] : []; })));
  useEffect(() => {
    const listener = () => setAgain((count) => count + 1);
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
  // A message in a space the list has read: what was kept of it is stale. The list reads it again once the burst has passed (at most one read in 800 ms).
  const [poked, setPoked] = useState(0);
  useStreamEvents(userId, (event) => {
    if (!live || event.objectType !== 'project' || !MESSAGE_EVENTS.has(event.kind)) return;
    const id = `${userId}:${event.objectId}`;
    if (!known.has(id) && !reading.has(id)) return;
    stale.add(id);
    setPoked((count) => count + 1);
  });
  useEffect(() => {
    if (!poked) return undefined;
    const timer = window.setTimeout(() => {
      // Dropped now, not when the message arrived: a read that was already on its way would have put its older answer back.
      for (const id of stale) { known.delete(id); reading.delete(id); }
      stale.clear();
      setAgain((count) => count + 1);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [poked]);
  useEffect(() => {
    let alive = true;
    const list = key ? key.split(',') : [];
    // The open project is what the person is reading: it is not "new" now, nor for a minute after they leave it
    // (leaving saves its return point).
    if (here) known.set(`${userId}:${here}`, { at: Date.now(), read: NOTHING });
    void Promise.all(list.map(async (id) => [id, id === here ? NOTHING : await read(userId, id)] as const)).then((found) => {
      if (!alive) return;
      setNews(new Map(found.filter(([, one]) => one.news > 0)));
      setSettled(true);
    });
    return () => { alive = false; };
  }, [key, here, userId, again]);
  return { news, settled };
}

/** The projects with something new, each with how many things (the quiet count of a muted place, #1249; the others are bold). */
export function useProjectNews(projectIds: readonly string[]): ReadonlyMap<string, number> {
  const { news } = useProjectReads(projectIds, false);
  return useMemo(() => new Map([...news].map(([id, one]) => [id, one.news] as const)), [news]);
}

/**
 * The projects with a conversation that has something new (Home's "New messages", #1548), each with the newest message of it. Live. `settled`:
 * every project has been read once, so what is known is all of it.
 */
export function useProjectMessages(projectIds: readonly string[]): { messages: ReadonlyMap<string, ProjectNews>; settled: boolean } {
  const { news, settled } = useProjectReads(projectIds, true);
  const messages = useMemo(() => new Map([...news].filter(([, one]) => one.messages > 0)), [news]);
  return { messages, settled };
}
