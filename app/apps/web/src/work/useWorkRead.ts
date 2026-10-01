import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { readStateForScope, ScopedReadStore, type ReadScope, type ReadState } from './read-state';

/**
 * Callers pass a stable loader (useCallback) for this exact selector. A scope change
 * hides the old observation during render, before effects can cancel its request.
 * Private editor state lives in the caller and is never reset by a read refresh.
 */
export function useWorkRead<T>(scope: ReadScope | null, load: (signal: AbortSignal) => Promise<T>, refresh: number = 0, enabled = true): ReadState<T> {
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
  useEffect(() => {
    if (!captured) store.clear();
    else if (enabled) void store.read(captured, load, true);
  }, [store, captured, load, refresh, enabled]);
  return readStateForScope(state, scope);
}
