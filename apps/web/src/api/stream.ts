import { useEffect, useRef } from 'react';
import { STREAM_CLOSE_UNAUTHENTICATED, STREAM_PATH, type StreamEvent, type StreamMessage } from '@flux/contracts';

/**
 * The authorized event stream (#29) as a small shared subscription. One WebSocket per tab,
 * opened while at least one listener exists; it reconnects with the last cursor it was given,
 * so events missed during a drop are replayed. Events carry identifiers only: listeners
 * refetch what changed through the HTTP API. A 4401 close means the session ended.
 */
type Listener = (event: StreamEvent) => void;

const listeners = new Set<Listener>();
let socket: WebSocket | null = null;
let cursor: string | null = null;
let retry = 0;
let timer: number | null = null;
const seen = new Set<string>();

function connect() {
  if (socket || !listeners.size || typeof WebSocket === 'undefined') return;
  const url = new URL(STREAM_PATH, window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  if (cursor) url.searchParams.set('cursor', cursor);
  const ws = new WebSocket(url);
  socket = ws;
  ws.onmessage = (message) => {
    let data: StreamMessage;
    try { data = JSON.parse(String(message.data)) as StreamMessage; } catch { return; }
    cursor = data.cursor;
    retry = 0;
    if (data.type !== 'event' || seen.has(data.id)) return;
    seen.add(data.id);
    if (seen.size > 500) seen.delete(seen.values().next().value!);
    for (const listener of [...listeners]) listener(data);
  };
  ws.onclose = (event) => {
    if (socket === ws) socket = null;
    if (event.code === STREAM_CLOSE_UNAUTHENTICATED || !listeners.size) return;
    const delay = Math.min(15_000, 500 * 2 ** retry++);
    timer = window.setTimeout(() => { timer = null; connect(); }, delay);
  };
}

function subscribe(listener: Listener) {
  listeners.add(listener);
  connect();
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    if (timer !== null) { window.clearTimeout(timer); timer = null; }
    socket?.close(1000);
    socket = null;
  };
}

/** Calls `onEvent` for every stream event this person may see while the component is mounted. */
export function useStreamEvents(onEvent: Listener) {
  const handler = useRef(onEvent);
  useEffect(() => { handler.current = onEvent; });
  useEffect(() => subscribe((event) => handler.current(event)), []);
}
