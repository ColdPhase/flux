import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { whenPageLive } from '../api/pageLeaving';
import { readStateForScope, ScopedReadStore, type ReadScope, type ReadState } from './read-state';

/**
 * Callers pass a stable loader (useCallback) for this exact selector. A scope change
 * hides the old observation during render, before effects can cancel its request.
 * Private editor state lives in the caller and is never reset by a read refresh.
 */
export function useWorkRead<T>(scope: ReadScope | null, load: (signal: AbortSignal) => Promise<T>, refresh: number | string = 0, enabled = true): ReadState<T> {
  const store = useMemo(() => new ScopedReadStore<T>(), []);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const { accountId, projectId, selector } = scope ?? {};
  const captured = useMemo(() => accountId === undefined || projectId === undefined || selector === undefined
    ? null : { accountId, projectId, selector }, [accountId, projectId, selector]);
  // Scope ownership must retire even while router auth revalidation pauses new dispatch.
  useEffect(() => {
    store.clear();
    return () => { store.clear(); };
  }, [store, captured]);
  // The first read of a scope opens the view and starts at once. A later refresh of the same scope is
  // background work: while the page is being left it waits until the page is live (#471), so WebKit
  // does not report the cancelled request as a page error.
  const opened = useRef<typeof captured>(null);
  useEffect(() => {
    if (!captured) { store.clear(); opened.current = null; return undefined; }
    if (!enabled) return undefined;
    const run = () => { opened.current = captured; void store.read(captured, load, true); };
    if (opened.current !== captured) { run(); return undefined; }
    return whenPageLive(run);
  }, [store, captured, load, refresh, enabled]);
  return readStateForScope(state, scope);
}
