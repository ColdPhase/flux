import { useEffect, useRef } from 'react';
import { STREAM_CLOSE_UNAUTHENTICATED, STREAM_PATH, type StreamEvent, type StreamMessage } from '@flux/contracts';

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
 * treated as a rejected cursor (`400 CURSOR_INVALID`): the cursor is dropped, listeners are
 * told to refetch, and it reconnects once from the head. It never retries the same cursor.
 * The same close also happens while the network is down, when that refetch fails too, so
 * listeners are told to refetch again once a connection from the head opens.
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
    for (const { listener } of [...subscriptions]) listener.onResync?.();
  };
  ws.onmessage = (message) => {
    let data: StreamMessage;
    try { data = JSON.parse(String(message.data)) as StreamMessage; } catch { return; }
    cursor = data.cursor;
    retry = 0;
    if (data.type !== 'event' || seen.has(data.id)) return;
    seen.add(data.id);
    if (seen.size > 500) seen.delete(seen.values().next().value!);
    for (const { listener } of [...subscriptions]) listener.onEvent(data);
  };
  ws.onclose = (event) => {
    if (socket !== ws) return;
    socket = null;
    if (event.code === STREAM_CLOSE_UNAUTHENTICATED) { cursor = null; return; }
    if (!subscriptions.size) return;
    if (!opened && resumed && cursor === resumed) {
      // Refused while resuming: most likely a cursor this person cannot use. Start from the head once.
      cursor = null;
      resyncOnOpen = true;
      for (const { listener } of [...subscriptions]) listener.onResync?.();
      schedule(0);
      return;
    }
    schedule(Math.min(15_000, 500 * 2 ** retry++));
  };
}

function subscribe(owner: string, listener: StreamListener) {
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
