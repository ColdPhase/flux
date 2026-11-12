import { useEffect, useState } from 'react';
import { useStreamEvents } from '../api/stream';
import { liveSpaces } from './api';
import { LIVE_CHANGED_EVENT, useLive } from './LiveProvider';

/**
 * The spaces where a call is on with someone in it (F-041 point 3): the live dot after a space's name in the sidebar and the Spaces list.
 * Read once, then again only when a call of one of your spaces starts, changes its people or ends (`project.live_changed.v1`), or when
 * the live stream may have missed something. No timer (#862).
 */
export function useLiveSpaces(): ReadonlySet<string> {
  const { capability, meId } = useLive();
  const enabled = capability === 'configured';
  const [tick, setTick] = useState(0);
  const [ids, setIds] = useState<{ meId: string; set: ReadonlySet<string> }>({ meId, set: new Set() });
  useStreamEvents(meId, (event) => { if (enabled && event.kind === LIVE_CHANGED_EVENT) setTick((n) => n + 1); },
    () => { if (enabled) setTick((n) => n + 1); });
  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    liveSpaces(controller.signal).then((page) => setIds({ meId, set: new Set(page.projectIds) }), () => undefined);
    return () => controller.abort();
  }, [enabled, meId, tick]);
  return ids.meId === meId && enabled ? ids.set : EMPTY;
}

const EMPTY: ReadonlySet<string> = new Set();
