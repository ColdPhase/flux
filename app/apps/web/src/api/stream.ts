import { useEffect, useRef } from 'react';
import { STREAM_CLOSE_UNAUTHENTICATED, STREAM_PATH, type StreamEvent, type StreamMessage, type StreamRunText } from '@flux/contracts';
import { reconnectDelay } from './busy.js';
import { forgetKeptFor, forgetKeptReads } from './client.js';
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

/** A tick of the sleep check, and how long away (hidden, or asleep) means the socket may be gone (#862). */
const TICK_MS = 15_000;
const AWAY_MS = 60_000;

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
  // Events may have been missed, so neither a kept answer nor a read already on its way may show the change (#1023, #862).
  forgetKeptReads();
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
  // While the API says it is busy (429, #838), a socket does not add to it.
  timer = window.setTimeout(() => { timer = null; connect(); }, reconnectDelay(delay));
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
    // The asker's live view of their own run (#1248): not an event, no cursor, never held or replayed.
    if (data.type === 'run_text') { for (const listener of [...runTextListeners]) listener(data); return; }
    cursor = data.cursor;
    retry = 0;
    if (data.type !== 'event' || seen.has(data.id)) return;
    seen.add(data.id);
    if (seen.size > 500) seen.delete(seen.values().next().value!);
    // A change somewhere else has arrived: neither a kept answer it can change nor a read that began before it may answer a re-read that
    // this event causes (#1023, #862). This is when the event arrives, not when it is delivered, so a held event (a page being left or
    // hidden) forgets them too.
    forgetKeptFor(data);
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

/**
 * Opens the stream again now, from the last cursor, so whatever it missed is replayed (#862). For a socket the browser still reports open
 * although its connection may be gone (a laptop that slept, a network that changed): the server's pings cannot be seen from a page, and
 * with no timers while the stream is open, a dead one would leave the tab with nothing.
 */
function reopen() {
  if (!subscriptions.size) return;
  const old = socket;
  socket = null;
  if (old) { old.onopen = null; old.onmessage = null; old.onclose = null; old.close(1000); }
  retry = 0;
  clearTimer();
  connect();
}

if (typeof window !== 'undefined') {
  // Back online: the connection may have changed under an open socket, and a reconnect waiting out its backoff happens now.
  window.addEventListener('online', reopen);
  // Back after a long time hidden, or after the machine slept (a timer that fired far later than it was set for): opened again.
  let hiddenAt: number | null = null;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
    const away = hiddenAt === null ? 0 : Date.now() - hiddenAt;
    hiddenAt = null;
    if (away > AWAY_MS && socket) reopen();
  });
  let tick = Date.now();
  const sleepCheck = setInterval(() => {
    const late = Date.now() - tick - TICK_MS;
    tick = Date.now();
    if (late > AWAY_MS && socket) reopen();
  }, TICK_MS);
  // Outside a browser (Node runs the client in tests) a timer must not keep the process alive (#752).
  (sleepCheck as unknown as { unref?: () => void }).unref?.();
  document.addEventListener('visibilitychange', release);
}
onPageLive(release);

/** A change to a space's work, decisions or results: what Tasks and the space's work summary show (#862). */
export const WORK_EVENT = /^project\.(work_|decision_|result_|assistant_change_undone|agent_stopped|question_)/;

/**
 * Whether the live stream is open now (#862). While it is, it tells every view what changed (and a reconnect replays what a drop
 * missed), so a view reads on an event, a resync, focus or a move, never on a timer; a timer is the fallback for while it is not.
 */
export function streamLive(): boolean {
  return socket !== null && typeof WebSocket !== 'undefined' && socket.readyState === WebSocket.OPEN;
}

const runTextListeners = new Set<(piece: StreamRunText) => void>();

/**
 * The words of the person's own runs as they are written (#1248), while the stream is open (a view that shows them also listens for
 * events, which keeps it open). Pieces missed while it was closed are not replayed: the run's answer replaces them when it is done.
 */
export function onRunText(listener: (piece: StreamRunText) => void) {
  runTextListeners.add(listener);
  return () => { runTextListeners.delete(listener); };
}

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
