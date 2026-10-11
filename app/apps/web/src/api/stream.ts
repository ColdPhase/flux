import { useEffect, useRef } from 'react';
import { STREAM_CLOSE_UNAUTHENTICATED, STREAM_PATH, type StreamEvent, type StreamMessage } from '@flux/contracts';
import { onPageLive, pageLeaving } from './pageLeaving.js';

/**
 * The authorized event stream (#29) as a small shared subscription. One WebSocket per tab,
 * opened while at least one listener exists; it reconnects with the last cursor it was given,
 * so events missed during a drop are replayed. Events carry identifiers only: listeners
 * refetch what changed through the HTTP API.
 *
 * Cursors are issued to one person. The stream state therefore belongs to one identity: when
 * a different account subscribes in the same tab (sign-out, then sign-in), or on sign-out, the
 * cursor, the dedupe set and the socket are dropped. A browser cannot read the HTTP status of a
 * refused upgrade, so a connection that closes before it opened while resuming from a cursor is
 * treated as a rejected cursor (`400 CURSOR_INVALID`): the cursor is dropped and it reconnects
 * from the head. It never retries the same cursor. The same close also happens while the network
 * is down, so listeners are told to refetch only once a connection from the head has opened: a
 * refetch during an outage would fail, and a failed route reload replaces the whole app with its
 * error page. When the browser reports it is online again, a waiting reconnect happens at once.
 */
export interface StreamListener {
  onEvent(event: StreamEvent): void;
  /** Events may have been missed (a cursor could not be resumed): refetch what is shown. */
  onResync?(): void;
}

interface Subscription { identity: string; listener: StreamListener }

const subscriptions = new Set<Subscription>();
let identity: string | null = null;
let socket: WebSocket | null = null;
let cursor: string | null = null;
let retry = 0;
let timer: number | null = null;
let seen = new Set<string>();
/** A cursor was dropped: events since then were not replayed, so the next open asks for a refetch. */
let resyncOnOpen = false;

// While the page is being left (see pageLeaving) or is hidden, listeners must not start refetches:
// the browser may cancel them and report it as a page error (#471). Events are held and delivered in
// order once the page is live again. A refetch that listeners are asked for (a reconnect from the
// head, or more events than can be held) is held the same way as one coalesced request, and runs
// once for the same document when it is live. Nothing here outlives the identity or its listeners.
const HOLD_MAX = 200;
let held: StreamEvent[] = [];
let resyncWanted = false;

/** Read from the document each time, never remembered: a visible page can never be held back. */
function paused() {
  return pageLeaving() || (typeof document !== 'undefined' && document.visibilityState === 'hidden');
}

function forgetHeld() {
  held = [];
  resyncWanted = false;
}

/** Tells listeners to refetch what they show, now or, while paused, once when live again. */
function requestResync() {
  if (paused()) { resyncWanted = true; return; }
  for (const { listener } of [...subscriptions]) listener.onResync?.();
}

function deliver(event: StreamEvent) {
  if (!paused()) {
    release(); // anything still held comes first, so order is kept
    for (const { listener } of [...subscriptions]) listener.onEvent(event);
    return;
  }
  if (resyncWanted) return;
  if (held.length >= HOLD_MAX) { held = []; resyncWanted = true; return; }
  held.push(event);
}

/** Delivers what was held, in order; a wanted refetch comes first and is asked for once. */
function release() {
  if (paused()) return;
  const batch = held;
  const resync = resyncWanted;
  forgetHeld();
  if (resync) requestResync();
  for (const event of batch) for (const { listener } of [...subscriptions]) listener.onEvent(event);
}

function clearTimer() {
  if (timer !== null) { window.clearTimeout(timer); timer = null; }
}

/** Forgets everything bound to the current identity and closes its socket. */
export function resetStream() {
  clearTimer();
  const current = socket;
  socket = null;
  current?.close(1000);
  cursor = null;
  retry = 0;
  seen = new Set();
  resyncOnOpen = false;
  forgetHeld();
  identity = null;
}

function schedule(delay: number) {
  clearTimer();
  timer = window.setTimeout(() => { timer = null; connect(); }, delay);
}

function connect() {
  if (socket || !subscriptions.size || typeof WebSocket === 'undefined') return;
  const url = new URL(STREAM_PATH, window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const resumed = cursor;
  if (resumed) url.searchParams.set('cursor', resumed);
  const ws = new WebSocket(url);
  socket = ws;
  let opened = false;
  ws.onopen = () => {
    opened = true;
    if (!resyncOnOpen) return;
    resyncOnOpen = false;
    requestResync();
  };
  ws.onmessage = (message) => {
    let data: StreamMessage;
    try { data = JSON.parse(String(message.data)) as StreamMessage; } catch { return; }
    cursor = data.cursor;
    retry = 0;
    if (data.type !== 'event' || seen.has(data.id)) return;
    seen.add(data.id);
    if (seen.size > 500) seen.delete(seen.values().next().value!);
    deliver(data);
  };
  ws.onclose = (event) => {
    if (socket !== ws) return;
    socket = null;
    if (event.code === STREAM_CLOSE_UNAUTHENTICATED) { cursor = null; return; }
    if (!subscriptions.size) return;
    if (!opened && resumed && cursor === resumed) {
      // Refused while resuming: a cursor this person cannot use, or no network. Start from the head;
      // listeners refetch when that connection opens (see onopen), never while it cannot.
      cursor = null;
      resyncOnOpen = true;
      schedule(0);
      return;
    }
    schedule(Math.min(15_000, 500 * 2 ** retry++));
  };
}

// Back online: a reconnect waiting out its backoff happens now, not up to 15 s later.
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    if (socket || !subscriptions.size) return;
    retry = 0;
    clearTimer();
    connect();
  });
  document.addEventListener('visibilitychange', release);
}
onPageLive(release);

/** One listener for the signed-in person `owner`; `useStreamEvents` is the way components use it. */
export function subscribe(owner: string, listener: StreamListener) {
  if (identity !== owner) {
    // Another account in this tab: nothing of the previous one may be reused.
    resetStream();
    identity = owner;
  }
  const subscription = { identity: owner, listener };
  subscriptions.add(subscription);
  connect();
  return () => {
    subscriptions.delete(subscription);
    if (subscriptions.size) return;
    forgetHeld();
    clearTimer();
    socket?.close(1000);
    socket = null;
  };
}

/**
 * Calls `onEvent` for every stream event the signed-in person (`identity`, their account id)
 * may see while the component is mounted, and `onResync` when events may have been missed.
 */
export function useStreamEvents(identity: string, onEvent: StreamListener['onEvent'], onResync?: () => void) {
  const handlers = useRef({ onEvent, onResync });
  useEffect(() => { handlers.current = { onEvent, onResync }; });
  useEffect(() => subscribe(identity, {
    onEvent: (event) => handlers.current.onEvent(event),
    onResync: () => handlers.current.onResync?.(),
  }), [identity]);
}
