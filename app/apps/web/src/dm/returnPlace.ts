import { useEffect, useRef, useState } from 'react';
import { currentEntry, isBooted, recall, useArrival } from '../place/memory';
import { threadPlace, type ThreadPlace } from '../work/readingPosition';

/** A place that never loads is given up after this long, and the feed opens as it always does. */
const GIVE_UP_MS = 6000;

/**
 * The place a direct message's feed was left, when this screen is a return to it (#592): Back, Forward or the origin control.
 * A reload, a link or a first visit opens the feed as it always opens. A reader who was at the end is following it, so that
 * also opens as always (at the latest); only a place with an earlier message in view is kept. A thread opens on a screen that
 * is already on show, so it also finds the place it had under that entry (`here`); `skip` is for a link that names a message.
 */
export function useLeftPlace(slot: string, { here = false, skip = false }: { here?: boolean; skip?: boolean } = {}): ThreadPlace | null {
  const arrival = useArrival();
  const [wanted] = useState(() => {
    const from = skip ? null : arrival ?? (here && isBooted() ? currentEntry() : null);
    const place = from ? threadPlace(recall(slot, from)) : null;
    return place && !place.atEnd ? place : null;
  });
  return wanted;
}

/**
 * Brings a left place back once the message it names is loaded: it is read back through the older pages when it is older than
 * the newest window, and given up (the feed opens at its latest) when it never loads, is gone, or was a queued message.
 * `pending` holds the feed back (hidden, not positioned) while that happens, so nothing shows in another place first.
 */
export function useReturnPlace({ wanted, loaded, have, hasOlder, seek }: {
  wanted: ThreadPlace | null;
  /** The feed's own first read is in: until then there is nothing to look for. */
  loaded: boolean;
  /** Whether the message with this element id is loaded. */
  have: (elementId: string) => boolean;
  /** Whether there are older pages to read. */
  hasOlder: boolean;
  /** Reads older pages until the message with this element id is loaded; false when it is not found. */
  seek: (elementId: string) => Promise<boolean>;
}): { restore: ThreadPlace | null; pending: boolean } {
  const present = !!wanted && have(wanted.id);
  const [lost, setLost] = useState(false);
  const started = useRef(false);
  const settled = !wanted || present || lost || (loaded && !hasOlder);
  useEffect(() => {
    if (!wanted || settled || !loaded || started.current) return;
    started.current = true;
    void seek(wanted.id).then((found) => { if (!found) setLost(true); }, () => setLost(true));
  }, [wanted, settled, loaded, seek]);
  useEffect(() => {
    if (settled) return;
    const timer = window.setTimeout(() => setLost(true), GIVE_UP_MS);
    return () => window.clearTimeout(timer);
  }, [settled]);
  return { restore: wanted && present ? wanted : null, pending: !settled };
}
