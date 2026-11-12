import { BUSY_RETRIES, busyWaitMs, waitOutBusy } from './busy.js';
import { pageIsLive, pageLeaving } from './pageLeaving.js';

/** Same-origin JSON requests. Session cookies are HttpOnly; the browser sends them itself. */
export class ApiError extends Error {
  /** `body` is the parsed error body, e.g. the latest version in a 409 VERSION_CONFLICT. */
  constructor(readonly status: number, readonly code: string | null, message: string, readonly body: unknown = null) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The server could not be reached at all (offline, DNS, server down). */
export class NetworkError extends Error {
  constructor() {
    super('Flux could not be reached');
    this.name = 'NetworkError';
  }
}

export interface ApiRequestInit {
  method?: string;
  body?: unknown;
  /** Raw bytes to send instead of a JSON `body`, with their own type (a profile photo, F-039). */
  bytes?: Blob;
  signal?: AbortSignal;
  /** Extra request headers such as If-Match or Idempotency-Key. */
  headers?: Record<string, string>;
  /** Lets the request finish after the page is left (a delayed command sent on the way out). */
  keepalive?: boolean;
  /** The browser cache mode, e.g. `no-store` for a file or a reachability check that must not be served from cache. */
  cache?: RequestCache;
  /**
   * A plain read that other callers of the same address may join while it is in flight (see `sharedRead`). Only for reads whose callers
   * all want the latest answer and none relies on its own request being ordered against another's (#850): the project shell's.
   */
  share?: boolean;
  /**
   * With `share`: how long (ms) a successful answer is kept and given to later callers of the same address without a request (#862: a
   * navigation asked for the same people, project and needs-you from its layout, its loaders and its components, one after the other).
   * A kept answer is forgotten on any write, any event of the live stream, a resync, sign-out, a refusal that says access changed, and
   * when the browser comes back online or the person comes back to the window (`forgetKeptReads`), so it is never older than the last
   * thing that could have changed it.
   */
  keep?: number;
  /**
   * A write that cannot change what any kept read holds (where the person stopped reading, which messages they saw): it leaves kept answers
   * and shared reads alone. Every other write forgets them.
   */
  leavesReads?: true;
  /**
   * With `keep`: a refresh the person or the stream asked for (focus, a poll, an event, a change of the Inbox), or the entry into a space,
   * does not take a kept answer; it reads, other callers of the address join it, and it keeps what it gets for the next view that opens.
   */
  fresh?: boolean;
  /**
   * With `keep`: the answer is given only on the page where it was read. For the person's own list that changes without an event
   * reaching this tab and holds things to act on (the Inbox, whose item may have been handled on another device): the sidebar and the
   * view that ask one after the other share one read, and the next page reads again.
   */
  onePage?: true;
  /**
   * A view read (#1109): the parts of its answer, by the addresses of their own reads (`handOver`). When nothing could have changed
   * them while the view was read, each part answers the next read of its address once, without a request.
   */
  parts?: (data: never) => Record<string, unknown>;
}

/** How long the reads that every view of a space or the shell asks for are kept (#862). */
export const KEEP_MS = 30_000;

// A read starts in a task of its own, after the work that asked for it (#716). A view opening asks for half a dozen reads from
// its effects; each `fetch` call costs milliseconds on the main thread of a phone, and made in the commit's own task they
// were a third of the longest frame of a view change. One port message batches every read asked for in the same task.
const later = typeof MessageChannel === 'undefined' ? null : new MessageChannel();
const waiting: (() => void)[] = [];
if (later) {
  later.port1.onmessage = () => { for (const start of waiting.splice(0)) start(); };
  // Outside a browser (Node runs the client in tests and tools) a port with a listener keeps the process alive; a
  // scheduler must not, so it is unreferenced where that exists (#752). Browsers have no such thing.
  (later.port1 as MessagePort & { unref?: () => void }).unref?.();
}
const nextTask = () => new Promise<void>((resolve) => {
  if (!later) { setTimeout(resolve, 0); return; }
  if (!waiting.length) later.port2.postMessage(0);
  waiting.push(resolve);
});

/** Plain reads in flight, by address, that later callers of the same address join (see `sharedRead`). */
interface SharedRead { answer: Promise<Answer>; callers: number; abort: AbortController }
interface Answer { ok: boolean; status: number; statusText: string; text: string }
const inFlight = new Map<string, SharedRead>();
/** Answers kept for later callers (`keep`), by address, and the generation that a write, an event or sign-out advances. */
const kept = new Map<string, { answer: Answer; until: number; page: string | null }>();
/** The page an answer was read on, for `onePage`. */
const page = () => (typeof location === 'undefined' ? '' : location.pathname);
let keptGeneration = 0;
/**
 * The parts of a view read (#1109), by the address of each part's own read: the next plain read of the address takes its part once,
 * instead of a request, while it is younger than `KEEP_MS`. Anything that forgets kept answers forgets these too, so a part is never
 * older than the last thing that could have changed it.
 */
const handed = new Map<string, { answer: Answer; until: number }>();

/**
 * Forgets every kept answer and every shared read in flight (#862): a write, an event of the live stream, a resync or sign-out could have
 * changed what they hold. An answer that arrives after this is not kept either.
 */
export function forgetKeptReads() {
  kept.clear();
  handed.clear();
  endSharedReads();
  keptGeneration += 1;
}

/** An event of the live stream, as `forgetKeptFor` reads it: its kind and what it is about, identifiers only. */
export interface KeptEventRef { kind: string; objectType: string; objectId: string; workspaceId: string }

/**
 * The kept answers an event can change (#862), by the addresses they were read from: `null` is all of them. Messages, tasks, decisions,
 * results, sources, calls and agents' answers change nothing that is kept (a space, its people, the members, the space's docs, the agents' chats),
 * so the reads a view makes on such an event are answered from what is kept where they can be; the Inbox is read once per page anyway.
 * Anything not named here (a space renamed, its people or AI switch changed, a company change, an agent made or revoked) forgets all.
 */
function keptChangedBy(event: KeptEventRef): string[] | null {
  const kind = event.kind;
  if (/^project\.doc_/.test(kind)) return [`/api/v1/projects/${event.objectId}/docs`];
  if (/^project\.(messages?_|conversation_created|material_|work_|decision_|result_|proposal_|question_|link_created|live_invited|live_changed|assistant_|agent_stopped)/.test(kind)) return [];
  if (/^(dm|sketch)\./.test(kind)) return [];
  if (/^assistant_run\./.test(kind)) return ['/api/v1/agent-chats'];
  return null;
}

/**
 * An event of the live stream arrived (#862, #1023): every read in flight ends (it may have begun before the change), and the kept answers
 * the event can change are forgotten, the others stay. An answer read across the event is not kept.
 */
export function forgetKeptFor(event: KeptEventRef) {
  const changed = keptChangedBy(event);
  if (changed === null) { forgetKeptReads(); return; }
  // A view's parts are read together: any event may have changed one of them, and they are taken at once anyway.
  handed.clear();
  endSharedReads();
  keptGeneration += 1;
  for (const path of [...kept.keys()]) if (changed.some((prefix) => path === prefix || path.startsWith(`${prefix}?`) || path.startsWith(`${prefix}/`))) kept.delete(path);
}

// What may have changed unseen is read again rather than taken from a kept answer (#862): the browser coming back online, the person
// coming back to the tab or the window. Registered when the client loads, so before any view's own refresh on the same event.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('online', forgetKeptReads);
  window.addEventListener('focus', forgetKeptReads);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') forgetKeptReads(); });
}

/**
 * A refusal that says access changed (signed out, the place is gone or hidden, locked): nothing kept from before it is still to be shown.
 * Not a 403, which refuses what a role may not do in a place the person still opens (a guest's read of the members, an AI read in a
 * space whose AI is off); a change of role reaches the person as an event.
 */
const ACCESS_CHANGED = new Set([401, 404, 410, 423]);

/**
 * Nothing in flight is joined any more: a read asked for from now on is a request of its own. Called when something changed that a read
 * already on its way may not show: a write of this tab (`send`), and an event of the live stream, which is another tab's write or another
 * person's change (the stream, #1023); both through `forgetKeptReads`, which forgets the kept answers too (#862). The callers already
 * waiting keep their answer.
 */
export function endSharedReads() {
  inFlight.clear();
}

/**
 * The one transport to the Flux API (#93): every call of the web app, JSON or not, goes through here.
 * Answers the raw response of any status; only a request that got no answer throws (`NetworkError`, or the
 * caller's `AbortError`). `accept` is sent only when given, so a file read keeps the browser's default;
 * `batchRead` starts a GET in the next task with the other reads of this one (#716), as every JSON read does.
 */
export async function send(path: string, init: ApiRequestInit & { accept?: string; batchRead?: boolean } = {}): Promise<Response> {
  // A read starts in a task of its own (#716), so the page is checked after that wait, in the same breath as `fetch`: a
  // navigation can begin in the task between, and a read asked for just before it, with the gate checked first, started
  // after `beforeunload` (#758, #759: working-agents, needs-you and the other shell reads of a page that is left).
  if (init.batchRead && (!init.method || init.method === 'GET')) await nextTask();
  // A write ends the sharing: a read that started before it must not answer a caller that asks after it (nor one that started while it ran).
  const writes = !!init.method && init.method !== 'GET' && !init.leavesReads;
  if (writes) forgetKeptReads();
  const attempt = async (): Promise<Response> => {
    // A page being left starts no request (#471): the browser has stopped its loads, and WebKit reports a
    // fetch that starts now as an uncaught page error. It starts when the page is live again, never sooner
    // than a click or key press proves the person is still here; an unloaded page never starts it.
    if (pageLeaving() && !init.keepalive) await pageIsLive(init.signal);
    try {
      return await fetch(path, {
        method: init.method ?? 'GET',
        credentials: 'same-origin',
        headers: { ...(init.accept ? { accept: init.accept } : {}), ...(init.bytes ? { 'content-type': init.bytes.type || 'application/octet-stream' }
          : init.body === undefined ? {} : { 'content-type': 'application/json' }), ...init.headers },
        body: init.bytes ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
        signal: init.signal,
        keepalive: init.keepalive,
        cache: init.cache,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new NetworkError();
    }
  };
  try {
    let response = await attempt();
    // The API is busy (429 with Retry-After, the floor of rate limits): a read is asked again after the wait, with the page saying so
    // (#838). Only a read: a write could have been done, and the person decides whether to send it again. A shared read is one request,
    // so it waits and retries once for all the callers that joined it.
    const readOnly = (!init.method || init.method === 'GET' || init.method === 'HEAD') && init.body === undefined && !init.bytes && !init.keepalive;
    for (let tries = 0; response.status === 429 && readOnly && tries < BUSY_RETRIES; tries += 1) {
      await waitOutBusy(busyWaitMs(response), init.signal);
      response = await attempt();
    }
    return response;
  } finally {
    if (writes) forgetKeptReads();
  }
}

/** The `ApiError` of a failed response, read from its JSON error body when it has one. */
export function responseError(response: Pick<Response, 'status' | 'statusText'>, data: unknown): ApiError {
  // The next read of a kept address asks the server, so the place that shows it hears the same refusal (a locked workspace's panel, #655).
  if (ACCESS_CHANGED.has(response.status)) forgetKeptReads();
  const record = (data && typeof data === 'object' ? data : {}) as { code?: unknown; message?: unknown; error?: unknown };
  const code = typeof record.code === 'string' ? record.code : null;
  const message = typeof record.message === 'string' ? record.message : typeof record.error === 'string' ? record.error : response.statusText;
  // AG-10: the space's AI was turned off since the shell last read it; the shell reads it again.
  if (response.status === 403 && code === 'SPACE_AI_OFF' && typeof window !== 'undefined') window.dispatchEvent(new Event('flux:space-ai-off'));
  // F-030 (#655): the workspace is an encrypted one that waits to be unlocked; the shell reads the workspaces again and the page turns into the locked panel.
  if (response.status === 423 && code === 'WORKSPACE_LOCKED' && typeof window !== 'undefined') {
    const details = (data as { details?: { workspaceId?: unknown } } | null)?.details;
    window.dispatchEvent(new CustomEvent('flux:workspace-locked', { detail: { workspaceId: typeof details?.workspaceId === 'string' ? details.workspaceId : null } }));
  }
  return new ApiError(response.status, code, message, data);
}

async function read(path: string, init: ApiRequestInit): Promise<Answer> {
  const response = await send(path, { ...init, accept: 'application/json', batchRead: true });
  return { ok: response.ok, status: response.status, statusText: response.statusText, text: await response.text() };
}

/**
 * Reads that ask to share (`share: true`) and are of the same address in flight together are one request (#850, #862: a navigation asked
 * for the same project and people up to four times, from its route loaders and its components). Sharing alone gives only what is in flight,
 * never an answer that has already arrived (that takes `keep`), and a write ends the sharing, so nothing is served stale; each caller parses
 * its own copy of the text, and aborting stops the request only when every caller that wanted it has aborted. Reads that do not ask are never shared: several
 * views hold or reorder their own reads and need each answer to be its own.
 */
function startSharedRead(path: string): SharedRead {
  const abort = new AbortController();
  const created: SharedRead = { answer: read(path, { signal: abort.signal }), callers: 0, abort };
  const finish = () => { if (inFlight.get(path) === created) inFlight.delete(path); };
  created.answer.then(finish, finish);
  inFlight.set(path, created);
  return created;
}

function sharedRead(path: string, signal: AbortSignal | undefined): Promise<Answer> {
  const entry = inFlight.get(path) ?? startSharedRead(path);
  entry.callers += 1;
  return new Promise<Answer>((resolve, reject) => {
    let left = false;
    const leave = () => {
      if (left) return;
      left = true;
      signal?.removeEventListener('abort', onAbort);
      entry.callers -= 1;
      if (entry.callers === 0) { if (inFlight.get(path) === entry) inFlight.delete(path); entry.abort.abort(); }
    };
    const onAbort = () => { leave(); reject(new DOMException('The operation was aborted.', 'AbortError')); };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    entry.answer.then((answer) => { if (!left) { left = true; signal?.removeEventListener('abort', onAbort); entry.callers -= 1; resolve(answer); } },
      (error: unknown) => { if (!left) { left = true; signal?.removeEventListener('abort', onAbort); entry.callers -= 1; reject(error); } });
  });
}

function handOver(response: Answer, parts: (data: unknown) => Record<string, unknown>) {
  let data: unknown;
  try { data = JSON.parse(response.text); } catch { return; }
  const until = Date.now() + KEEP_MS;
  for (const [path, value] of Object.entries(parts(data))) {
    if (value === null || value === undefined) continue;
    handed.set(path, { answer: { ok: true, status: 200, statusText: 'OK', text: JSON.stringify(value) }, until });
  }
}

/** A JSON request: the parsed body of a 2xx answer, or an `ApiError`. */
export async function request<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
  const plainRead = init.share === true && (!init.method || init.method === 'GET') && !init.headers && !init.keepalive && init.cache === undefined;
  const keep = plainRead && init.keep ? init.keep : 0;
  // A fresh read drops what was kept, so a caller that asks while it is on its way joins it instead of taking the older answer.
  if (keep && init.fresh) kept.delete(path);
  const held = keep && !init.fresh ? kept.get(path) : undefined;
  // The part of a view read that this address answers (#1109), once; a read that must be fresh asks the server.
  const plainGet = (!init.method || init.method === 'GET') && !init.headers && !init.keepalive && init.cache === undefined;
  const part = plainGet && !init.fresh ? handed.get(path) : undefined;
  if (part && part.until <= Date.now()) handed.delete(path);
  let response: Answer;
  if (part && part.until > Date.now() && !init.signal?.aborted) {
    handed.delete(path);
    response = part.answer;
    if (keep) kept.set(path, { answer: response, until: part.until, page: init.onePage ? page() : null });
  } else if (held && held.until > Date.now() && (held.page === null || held.page === page())) {
    if (init.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    response = held.answer;
  } else {
    const generation = keptGeneration;
    response = plainRead ? await sharedRead(path, init.signal) : await read(path, init);
    // Kept only when nothing could have changed it while it was read.
    if (keep && response.ok && generation === keptGeneration) kept.set(path, { answer: response, until: Date.now() + keep, page: init.onePage ? page() : null });
    if (init.parts && response.ok && generation === keptGeneration) handOver(response, init.parts as (data: unknown) => Record<string, unknown>);
  }
  let data: unknown = null;
  if (response.text) {
    try { data = JSON.parse(response.text); } catch { data = null; }
  }
  if (!response.ok) throw responseError(response, data);
  return data as T;
}
