import { useEffect, useState } from 'react';
import { useLocation } from 'react-router';
import { getReturnSummary } from '../returns/api';
import { useShellData } from './data';

/**
 * Whether a project has something new for this person (#763 H11-4): what others did there since they last left its
 * conversation, from the same return-point summary the project reads. A space with news is unread (#1250: its name is bold in
 * the sidebar, unless it is muted, #1249). Nothing else set `hasNew`, so Home called every project "quiet" after a week of
 * activity. Read once per project and kept for a minute; the project the person is in is read again when they leave it, since
 * leaving moves its return point. "Mark all as read" forgets what was kept (`forgetProjectNews`). The dot is not this: it is for
 * what needs the person (`useNeedsYouSpaces`).
 */
const TTL = 60_000;
const known = new Map<string, { at: number; news: number }>();
const reading = new Map<string, Promise<number>>();
const listeners = new Set<() => void>();
/** Counts the times the kept answers were dropped: a read that began before one must not put its answer back. */
let epoch = 0;

/** Kept per account: nothing one person read about a project is shown to the next one in this tab. */
function read(userId: string, projectId: string): Promise<number> {
  const id = `${userId}:${projectId}`;
  const cached = known.get(id);
  if (cached && Date.now() - cached.at < TTL) return Promise.resolve(cached.news);
  let pending = reading.get(id);
  if (!pending) {
    const began = epoch;
    pending = getReturnSummary({ type: 'project', id: projectId })
      .then((summary) => summary.items.length, () => 0)
      .then((news) => { if (began === epoch) known.set(id, { at: Date.now(), news }); reading.delete(id); return news; });
    reading.set(id, pending);
  }
  return pending;
}

/** Drops everything kept and tells the lists to read again (after "Mark all as read" and its Undo, #1250). */
export function forgetProjectNews() {
  epoch += 1;
  known.clear();
  reading.clear();
  for (const listener of [...listeners]) listener();
}

/** At most this many projects are asked about, in the order given (the sidebar's and Home's order). */
const LIMIT = 24;

/** The projects with something new, each with how many things (the quiet count of a muted place, #1249; the others are bold). */
export function useProjectNews(projectIds: readonly string[]): ReadonlyMap<string, number> {
  const userId = useShellData().me.user.id;
  const here = useLocation().pathname.match(/^\/projects\/([^/]+)/)?.[1] ?? null;
  const key = projectIds.slice(0, LIMIT).join(',');
  const [again, setAgain] = useState(0);
  const [news, setNews] = useState<ReadonlyMap<string, number>>(() => new Map(projectIds.flatMap((id) => { const count = known.get(`${userId}:${id}`)?.news ?? 0; return count ? [[id, count] as const] : []; })));
  useEffect(() => {
    const listener = () => setAgain((count) => count + 1);
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
  useEffect(() => {
    let live = true;
    const ids = key ? key.split(',') : [];
    // The open project is what the person is reading: it is not "new" now, nor for a minute after they leave it
    // (leaving saves its return point).
    if (here) known.set(`${userId}:${here}`, { at: Date.now(), news: 0 });
    void Promise.all(ids.map(async (id) => [id, id === here ? 0 : await read(userId, id)] as const)).then((found) => {
      if (live) setNews(new Map(found.filter(([, count]) => count > 0)));
    });
    return () => { live = false; };
  }, [key, here, userId, again]);
  return news;
}
