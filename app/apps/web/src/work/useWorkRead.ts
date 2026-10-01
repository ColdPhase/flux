import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { readStateForScope, ScopedReadStore, type ReadScope, type ReadState } from './read-state';

/**
 * Callers pass a stable loader (useCallback) for this exact selector. A scope change
 * hides the old observation during render, before effects can cancel its request.
 * Private editor state lives in the caller and is never reset by a read refresh.
 */
export function useWorkRead<T>(scope: ReadScope | null, load: (signal: AbortSignal) => Promise<T>, refresh: number = 0): ReadState<T> {
  const store = useMemo(() => new ScopedReadStore<T>(), []);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const { accountId, projectId, selector } = scope ?? {};
  const captured = useMemo(() => accountId === undefined || projectId === undefined || selector === undefined
    ? null : { accountId, projectId, selector }, [accountId, projectId, selector]);
  useEffect(() => {
    if (captured) void store.read(captured, load);
    else store.clear();
    return () => { store.clear(); };
  }, [store, captured, load, refresh]);
  return readStateForScope(state, scope);
}
