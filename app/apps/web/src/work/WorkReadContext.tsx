import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useLocation, useRevalidator } from 'react-router';
import { projectWorkSummaryPath, type ProjectWorkView } from '@flux/contracts';
import { getProjectWorkSummary } from './read-api';
import { ProjectWorkFacetStore, readStateForScope, type ReadScope, type ReadState } from './read-state';

interface WorkReadContextValue { accountId: string; projectId: string | null; store: ProjectWorkFacetStore }
const WorkReadContext = createContext<WorkReadContextValue | null>(null);

/** One shared observation for the current account/project, including the outer header. */
export function WorkReadProvider({ accountId, projectId, children }: { accountId: string; projectId: string | null; children: ReactNode }) {
  // A fresh store per account/project: no observation outlives the identity that made it.
  const owner = JSON.stringify([accountId, projectId]);
  const { store } = useMemo(() => ({ owner, store: new ProjectWorkFacetStore() }), [owner]);
  const value = useMemo(() => ({ accountId, projectId, store }), [accountId, projectId, store]);
  const location = useLocation();
  const revalidator = useRevalidator();
  const tasks = projectId !== null && location.pathname.replace(/\/$/, '') === `/projects/${projectId}/tasks`;
  useEffect(() => () => { store.clear(); }, [store]);
  useEffect(() => {
    if (!projectId || tasks || revalidator.state !== 'idle') return;
    const scope = { accountId, projectId, selector: projectWorkSummaryPath(projectId) };
    const refresh = () => { if (document.visibilityState === 'visible') void store.readSummary(scope, (signal) => getProjectWorkSummary(projectId, signal)); };
    refresh();
    window.addEventListener('focus', refresh);
    const interval = window.setInterval(refresh, 15000);
    return () => { window.removeEventListener('focus', refresh); window.clearInterval(interval); };
  }, [accountId, projectId, tasks, revalidator.state, store]);
  return <WorkReadContext.Provider value={value}>{children}</WorkReadContext.Provider>;
}

function useWorkReadContext() {
  const value = useContext(WorkReadContext);
  if (!value) throw new Error('Project work reads require the authenticated work provider');
  return value;
}

export function useProjectWorkSummary() {
  const { accountId, projectId, store } = useWorkReadContext();
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  if (!projectId || !state.scope || state.scope.accountId !== accountId || state.scope.projectId !== projectId) return { phase: 'loading' as const, summary: null };
  if (state.phase !== 'ready' && state.phase !== 'refreshing') return { phase: state.phase, summary: null };
  return { phase: state.phase, summary: state.value.kind === 'page' ? state.value.page.summary : state.value.summary };
}

/** Tasks is the sole writer of its combined page and the shared summary facet. */
export function useProjectWorkPage(projectId: string, selector: string, load: (signal: AbortSignal) => Promise<ProjectWorkView>) {
  const context = useWorkReadContext();
  const { accountId, store } = context;
  const revalidator = useRevalidator();
  const [revision, setRevision] = useState(0);
  const scope = useMemo<ReadScope | null>(() => context.projectId === projectId ? { accountId, projectId, selector } : null,
    [context.projectId, accountId, projectId, selector]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const leaseRef = useRef<ReturnType<ProjectWorkFacetStore['claimPage']> | null>(null);
  useEffect(() => {
    if (!scope) return;
    const lease = store.claimPage(scope);
    leaseRef.current = lease;
    return () => { leaseRef.current = null; store.releasePage(lease); };
  }, [store, scope]);
  useEffect(() => {
    if (scope && leaseRef.current && revalidator.state === 'idle') void store.readPage(leaseRef.current, scope, load);
  }, [store, scope, load, revision, revalidator.state]);
  const visible = readStateForScope(state, scope);
  let page: ReadState<ProjectWorkView>;
  if (visible.phase === 'ready' || visible.phase === 'refreshing') {
    page = visible.value.kind === 'page'
      ? { ...visible, value: visible.value.page }
      : { phase: 'loading', scope: visible.scope, generation: visible.generation };
  } else page = visible;
  const refresh = useCallback(() => { setRevision((current) => current + 1); }, []);
  return { page, refresh };
}
