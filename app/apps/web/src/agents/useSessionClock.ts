import { useEffect, useState } from 'react';
import type { ProjectAgentConnection } from '@flux/contracts';
import { nextSessionExpiry } from './roster';

/** Age known session evidence without another API observation or a polling clock. */
export function useSessionClock(connections: readonly ProjectAgentConnection[] | undefined, observedNow: number): number {
  const [agedNow, setAgedNow] = useState(() => observedNow);
  const now = Math.max(observedNow, agedNow);
  useEffect(() => {
    const expiry = nextSessionExpiry(connections, now);
    if (expiry === null) return undefined;
    const at = Date.now();
    // Keep a deadline that crossed since render: the displayed facts need an immediate ageing tick.
    const delay = expiry <= at ? 0 : Math.min(expiry - at + 1, 2_147_483_647);
    const timer = window.setTimeout(() => setAgedNow(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [connections, now]);
  return now;
}
