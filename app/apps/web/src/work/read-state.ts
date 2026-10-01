import type { ProjectWorkSummary, ProjectWorkView } from '@flux/contracts';

export interface ReadScope {
  readonly accountId: string;
  readonly projectId: string;
  /** Canonical endpoint + all selectors, including the current continuation. */
  readonly selector: string;
}

export const readScopeKey = (scope: ReadScope) => JSON.stringify([scope.accountId, scope.projectId, scope.selector]);

export type ReadState<T> =
  | { phase: 'idle'; scope: null; generation: number }
  | { phase: 'loading'; scope: ReadScope; generation: number }
  | { phase: 'ready'; scope: ReadScope; generation: number; value: T }
  | { phase: 'refreshing'; scope: ReadScope; generation: number; value: T }
  | { phase: 'unavailable'; scope: ReadScope; generation: number; error: unknown };

/** Render-time fence: effect cancellation has not necessarily run for a new scope. */
export function readStateForScope<T>(state: ReadState<T>, scope: ReadScope | null): ReadState<T> {
  if (!scope) return { phase: 'idle', scope: null, generation: state.generation };
  if (!state.scope || readScopeKey(state.scope) !== readScopeKey(scope)) return { phase: 'loading', scope, generation: state.generation };
  return state;
}

/** One current observation, never an accumulating cache of pages or accounts. */
export class ScopedReadStore<T> {
  private state: ReadState<T> = { phase: 'idle', scope: null, generation: 0 };
  private controller: AbortController | null = null;
  private listeners = new Set<() => void>();

  getSnapshot = (): ReadState<T> => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(state: ReadState<T>) {
    this.state = state;
    for (const listener of [...this.listeners]) listener();
  }

  /** Abort is advisory; the generation check also fences transports that ignore it. */
  async read(scope: ReadScope, load: (signal: AbortSignal) => Promise<T>, retainCurrent = false): Promise<void> {
    const previous = this.controller;
    const controller = new AbortController();
    this.controller = controller;
    const captured = Object.freeze({ ...scope });
    const generation = this.state.generation + 1;
    const current = () => this.controller === controller && !controller.signal.aborted && this.state.generation === generation;
    const prior = this.state;
    this.publish(retainCurrent && (prior.phase === 'ready' || prior.phase === 'refreshing') && readScopeKey(prior.scope) === readScopeKey(captured)
      ? { phase: 'refreshing', scope: captured, generation, value: prior.value }
      : { phase: 'loading', scope: captured, generation });
    // Abort listeners run synchronously and may start another read. Establish this
    // operation first, then let a newer reentrant operation retain ownership.
    previous?.abort();
    if (!current()) return;
    try {
      const value = await load(controller.signal);
      if (current()) this.publish({ phase: 'ready', scope: captured, generation, value });
    } catch (error) {
      if (current()) this.publish({ phase: 'unavailable', scope: captured, generation, error });
    }
  }

  clear() {
    const previous = this.controller;
    this.controller = null;
    this.publish({ phase: 'idle', scope: null, generation: this.state.generation + 1 });
    previous?.abort();
  }
}

export type WorkFacet =
  | { kind: 'summary'; summary: ProjectWorkSummary }
  | { kind: 'page'; page: ProjectWorkView };

interface PageLease { readonly accountId: string; readonly projectId: string }

/**
 * Shared project state has one writer at a time. While Tasks owns a page lease,
 * standalone summaries cannot start, finish, or replace that combined observation.
 * The page and its summary are stored as one value, including on refresh/failure.
 */
export class ProjectWorkFacetStore {
  private readonly reads = new ScopedReadStore<WorkFacet>();
  private pageLease: PageLease | null = null;
  readonly getSnapshot = this.reads.getSnapshot;
  readonly subscribe = this.reads.subscribe;

  readSummary(scope: ReadScope, load: (signal: AbortSignal) => Promise<ProjectWorkSummary>) {
    if (this.pageLease) return Promise.resolve();
    return this.reads.read(scope, async (signal) => ({ kind: 'summary', summary: await load(signal) }), true);
  }

  claimPage(scope: Pick<ReadScope, 'accountId' | 'projectId'>) {
    const lease = Object.freeze({ accountId: scope.accountId, projectId: scope.projectId });
    this.pageLease = lease;
    // Invalidate a summary already in flight before the page can be published.
    this.reads.clear();
    return lease;
  }

  readPage(lease: PageLease, scope: ReadScope, load: (signal: AbortSignal) => Promise<ProjectWorkView>) {
    if (this.pageLease !== lease || lease.accountId !== scope.accountId || lease.projectId !== scope.projectId) return Promise.resolve();
    return this.reads.read(scope, async (signal) => ({ kind: 'page', page: await load(signal) }), true);
  }

  releasePage(lease: PageLease) {
    if (this.pageLease !== lease) return;
    this.pageLease = null;
    this.reads.clear();
  }

  clear() {
    this.pageLease = null;
    this.reads.clear();
  }
}
