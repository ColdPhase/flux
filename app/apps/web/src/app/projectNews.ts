import { useEffect, useState } from 'react';
import { useLocation } from 'react-router';
import { getReturnSummary } from '../returns/api';
import { useShellData } from './data';

/**
 * Whether a project has something new for this person (#763 H11-4): what others did there since they last left its
 * conversation, from the same return-point summary the project reads. Nothing else set `hasNew`, so Home called every
 * project "quiet" after a week of activity. Read once per project and kept for a minute; the project the person is in is
 * read again when they leave it, since leaving moves its return point.
 */
const TTL = 60_000;
const known = new Map<string, { at: number; news: number }>();
const reading = new Map<string, Promise<number>>();

/** Kept per account: nothing one person read about a project is shown to the next one in this tab. */
function read(userId: string, projectId: string): Promise<number> {
  const id = `${userId}:${projectId}`;
  const cached = known.get(id);
  if (cached && Date.now() - cached.at < TTL) return Promise.resolve(cached.news);
  let pending = reading.get(id);
  if (!pending) {
    pending = getReturnSummary({ type: 'project', id: projectId })
      .then((summary) => summary.items.length, () => 0)
      .then((news) => { known.set(id, { at: Date.now(), news }); reading.delete(id); return news; });
    reading.set(id, pending);
  }
  return pending;
}

/** At most this many projects are asked about, in the order given (the sidebar's and Home's order). */
const LIMIT = 24;

/** The projects with something new, each with how many things (the quiet count of a muted place, #1249; the others show a dot). */
export function useProjectNews(projectIds: readonly string[]): ReadonlyMap<string, number> {
  const userId = useShellData().me.user.id;
  const here = useLocation().pathname.match(/^\/projects\/([^/]+)/)?.[1] ?? null;
  const key = projectIds.slice(0, LIMIT).join(',');
  const [news, setNews] = useState<ReadonlyMap<string, number>>(() => new Map(projectIds.flatMap((id) => { const count = known.get(`${userId}:${id}`)?.news ?? 0; return count ? [[id, count] as const] : []; })));
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
  }, [key, here, userId]);
  return news;
}
