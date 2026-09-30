import { useEffect, useState } from 'react';
import { getRecap } from './api';

/**
 * How many things in a project need the signed-in person (#133), for the quiet count on
 * "What matters". Read again when the panel closes (it may have moved the return point) and when
 * the tab becomes visible; nothing is kept between projects or accounts.
 */
export function useNeedsYou(projectId: string | null, panelOpen: boolean): number {
  const [state, setState] = useState<{ projectId: string; count: number } | null>(null);
  const [visible, setVisible] = useState(0);
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') setVisible((value) => value + 1); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);
  useEffect(() => {
    if (!projectId || panelOpen) return;
    const controller = new AbortController();
    getRecap({ projectId, scope: 'all', period: 'last-visit', until: null, digest: false }, controller.signal)
      .then((summary) => { if (!controller.signal.aborted) setState({ projectId, count: summary.needsYou }); })
      .catch(() => { /* the entry works without its count */ });
    return () => controller.abort();
  }, [projectId, panelOpen, visible]);
  return state && state.projectId === projectId ? state.count : 0;
}
