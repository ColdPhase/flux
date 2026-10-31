import { useEffect, useState } from 'react';
import { useLocation } from 'react-router';
import { getReturnSummary } from '../returns/api';

/**
 * Whether a project has something new for this person (#763 H11-4): what others did there since they last left its
 * conversation, from the same "Since you left" summary the project shows. Nothing else set `hasNew`, so Home called every
 * project "quiet" after a week of activity. Read once per project and kept for a minute; the project the person is in is
 * read again when they leave it, since leaving moves its return point.
 */
const TTL = 60_000;
const known = new Map<string, { at: number; news: boolean }>();
const reading = new Map<string, Promise<boolean>>();

function read(projectId: string): Promise<boolean> {
  const cached = known.get(projectId);
  if (cached && Date.now() - cached.at < TTL) return Promise.resolve(cached.news);
  let pending = reading.get(projectId);
  if (!pending) {
    pending = getReturnSummary({ type: 'project', id: projectId })
      .then((summary) => summary.items.length > 0, () => false)
      .then((news) => { known.set(projectId, { at: Date.now(), news }); reading.delete(projectId); return news; });
    reading.set(projectId, pending);
  }
  return pending;
}

/** At most this many projects are asked about, in the order given (the sidebar's and Home's order). */
const LIMIT = 24;

export function useProjectNews(projectIds: readonly string[]): ReadonlySet<string> {
  const here = useLocation().pathname.match(/^\/projects\/([^/]+)/)?.[1] ?? null;
  const key = projectIds.slice(0, LIMIT).join(',');
  const [news, setNews] = useState<ReadonlySet<string>>(() => new Set(projectIds.filter((id) => known.get(id)?.news)));
  useEffect(() => {
    let live = true;
    const ids = key ? key.split(',') : [];
    // The open project is what the person is reading: it is not "new" now, nor for a minute after they leave it
    // (leaving saves its return point).
    if (here) known.set(here, { at: Date.now(), news: false });
    void Promise.all(ids.map(async (id) => (id !== here && await read(id) ? id : null))).then((found) => {
      if (live) setNews(new Set(found.filter((id): id is string => !!id)));
    });
    return () => { live = false; };
  }, [key, here]);
  return news;
}
