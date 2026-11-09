import { ApiError, NetworkError } from '../api/client.js';

/**
 * A page that is shown keeps what it shows when the read that refreshes it fails (#1141). The stream says something changed, the person
 * comes back to the tab, a retry runs: the router reads the page's data again in the background, and if that one read gets a 503 or no
 * answer, the page used to be replaced by the error screen until Try again. Now the loader that failed gives back what it last read for
 * this same page, and asks again by itself, quietly and with a short backoff (and the next event or focus asks too).
 *
 * The error screen is for a read that has nothing shown to keep (the page's first load, or a different page) and for answers that say
 * the data is gone or closed: 401, 403, 404, 423, a redirect to sign in. Only "the server or the network failed" is kept through:
 * no answer, a 5xx, or 429 after the client has waited and asked again (api/busy.ts).
 *
 * One place: `keepPagesOnRefresh` wraps every loader of a route tree (including those a lazy route brings), so a page needs nothing.
 */

/** What a loader is asked: the router's `LoaderFunctionArgs` has these (this file takes no part of the router, so tests can run it). */
export interface PageArgs { params: Readonly<Record<string, string | undefined>>; request: Request }
/** Any loader of the router. */
type Loader = (args: never, context?: unknown) => unknown;
/** A route of the router's tree, as far as this file reads it. */
interface RouteLike { loader?: unknown; lazy?: unknown; children?: RouteLike[] }

/** The waits before the quiet retries after a read gave back what it kept: five tries over half a minute, then the next event or focus. */
export const KEEP_RETRY_MS = [1000, 2000, 4000, 8000, 16_000];
/** A failure this long after the last one starts the waits over. */
const FRESH_AFTER_MS = 60_000;

/** What each wrapped loader last read, and for which page (its params and search): that is what its page shows now. */
const shown = new Map<symbol, { page: string; data: unknown }>();
let refresh: (() => unknown) | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let tries = 0;
let lastKept = 0;

const pageOf = ({ params, request }: PageArgs) => JSON.stringify([params, new URL(request.url).search]);

/** The server or the network failed: nothing here says the page is gone or closed. */
function failedToAnswer(error: unknown): boolean {
  if (error instanceof NetworkError) return true;
  return error instanceof ApiError && (error.status >= 500 || error.status === 408 || error.status === 429);
}

function retrySoon() {
  const now = Date.now();
  if (now - lastKept > FRESH_AFTER_MS) tries = 0;
  lastKept = now;
  if (timer !== undefined || !refresh || tries >= KEEP_RETRY_MS.length) return;
  timer = setTimeout(() => { timer = undefined; tries += 1; void refresh?.(); }, KEEP_RETRY_MS[tries]);
}

/** Wraps one loader: when it fails to get an answer while its own page is the one it last read, it gives that back and retries. */
export function keepOnRefresh<L extends Loader>(loader: L): L {
  const id = Symbol('loader');
  const read = loader as unknown as (args: PageArgs, context?: unknown) => unknown;
  const kept = async (args: PageArgs, context?: unknown) => {
    const page = pageOf(args);
    try {
      const data = await read(args, context);
      // A redirect is an answer for this call alone; what it replaces is not shown any more.
      if (data instanceof Response) shown.delete(id); else shown.set(id, { page, data });
      return data;
    } catch (error) {
      // A read that was stopped (the next one, a navigation) says nothing about the page.
      if (args.request.signal.aborted) throw error;
      const last = shown.get(id);
      if (last && last.page === page && failedToAnswer(error)) { retrySoon(); return last.data; }
      shown.delete(id);
      throw error;
    }
  };
  return kept as unknown as L;
}

/** Wraps every loader of the route and of its children, and of the lazy routes that bring one. */
export function keepPagesOnRefresh<R extends RouteLike>(route: R): R {
  const next: RouteLike = { ...route };
  if (typeof route.loader === 'function') next.loader = keepOnRefresh(route.loader as Loader);
  const lazy = route.lazy;
  if (typeof lazy === 'function') {
    next.lazy = async () => {
      const loaded = await (lazy as () => Promise<RouteLike>)();
      return typeof loaded.loader === 'function' ? { ...loaded, loader: keepOnRefresh(loaded.loader as Loader) } : loaded;
    };
  } else if (lazy && typeof (lazy as RouteLike).loader === 'function') {
    // The object form: `lazy: { loader: () => Promise<loader> }`.
    const load = (lazy as { loader: () => Promise<unknown> }).loader;
    next.lazy = { ...lazy, loader: async () => { const loader = await load(); return typeof loader === 'function' ? keepOnRefresh(loader as Loader) : loader; } };
  }
  if (route.children) next.children = route.children.map((child) => keepPagesOnRefresh(child));
  return next as R;
}

/** The read that asks the page's loaders again, for the quiet retries (the router's `revalidate`). */
export function retryKeptPagesWith(revalidate: () => unknown) {
  refresh = revalidate;
}

/** Nothing shown is kept any more, and no retry is waiting: another person's session, or none. */
export function forgetKeptPages() {
  shown.clear();
  clearTimeout(timer);
  timer = undefined;
  tries = 0;
}
