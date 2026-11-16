import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useStreamEvents } from '../api/stream';
import type { NeedsYouItem } from '@flux/contracts';
import { INBOX_CHANGED, NEEDS_YOU_ACCEPTED, NEEDS_YOU_RETURNED, type AcceptedInboxItem } from './api';
import { answeringIds, onAcceptingChange } from './pendingAccept';
import { getNeedsYou } from './needsYou';

/** The spaces that hold something that needs the person, from the same read as the count (#1250): the sidebar's dot. */
let holding: { identity: string; spaces: ReadonlySet<string> } = { identity: '', spaces: new Set() };
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const NONE: ReadonlySet<string> = new Set();
export function useNeedsYouSpaces(identity: string): ReadonlySet<string> {
  const now = useSyncExternalStore(subscribe, () => holding, () => holding);
  return now.identity === identity ? now.spaces : NONE;
}

/**
 * How many things wait for you, for the sidebar's count and the phone's Inbox tab (F-026 §4, #342): the Inbox is the one place
 * that counts them (#865). Notifications are written by the worker shortly after the event, so a stream event refreshes it after a
 * short pause; it also refreshes on focus, when the inbox changes and every two minutes.
 */
export function useInboxDot(identity: string, pathname: string): { count: number; notifying: number } {
  const [unread, setUnread] = useState<{ identity: string; count: number; notifying: number; items: readonly NeedsYouItem[] } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Accepted or answered here: the count leaves them out at once, as the Inbox does, and until a read no longer has them. An acceptance
  // taken back with Undo (round 8, #1424) counts again at once.
  const [left, setLeft] = useState<ReadonlySet<string>>(new Set());
  const [, recount] = useState(0);
  useEffect(() => onAcceptingChange(() => recount((n) => n + 1)), []);
  useEffect(() => {
    const onAccepted = (event: Event) => {
      const detail = (event as CustomEvent<AcceptedInboxItem>).detail;
      if (detail.ownerId === identity) setLeft((keys) => new Set([...keys, detail.key]));
    };
    const onReturned = (event: Event) => {
      const detail = (event as CustomEvent<AcceptedInboxItem>).detail;
      if (detail.ownerId === identity) setLeft((keys) => (keys.has(detail.key) ? new Set([...keys].filter((key) => key !== detail.key)) : keys));
    };
    window.addEventListener(NEEDS_YOU_ACCEPTED, onAccepted);
    window.addEventListener(NEEDS_YOU_RETURNED, onReturned);
    return () => { window.removeEventListener(NEEDS_YOU_ACCEPTED, onAccepted); window.removeEventListener(NEEDS_YOU_RETURNED, onReturned); };
  }, [identity]);
  const read = useCallback((fresh: boolean) => {
    void getNeedsYou(undefined, fresh).then((queue) => {
      setUnread({ identity, count: queue.count, notifying: queue.notifying ?? 0, items: queue.items });
      setLeft((keys) => {
        if (!keys.size) return keys;
        const still = queue.items.filter((item) => keys.has(item.key)).map((item) => item.key);
        return still.length === keys.size ? keys : new Set(still);
      });
      holding = { identity, spaces: new Set(queue.items.flatMap((item) => (item.project ? [item.project.id] : []))) };
      for (const listener of [...listeners]) listener();
    }, () => undefined);
  }, [identity]);
  // A refresh (focus, an event, a change of the Inbox, the two-minute poll) reads; a new page shares one read with its own queue (#862).
  const refresh = useCallback(() => read(true), [read]);
  const soon = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(refresh, 1500);
  }, [refresh]);

  useEffect(() => { read(false); }, [read, identity, pathname]);
  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener(INBOX_CHANGED, refresh);
    window.addEventListener('focus', onFocus);
    // Also while the live stream is open (#862): an item handled on another device, an item back from Later and a notification written late
    // send this tab no event. Half a request a minute.
    const interval = setInterval(refresh, 120_000);
    return () => {
      window.removeEventListener(INBOX_CHANGED, refresh);
      window.removeEventListener('focus', onFocus);
      clearInterval(interval);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [refresh]);
  // Someone seeing a message changes nothing that waits for this person (#862).
  useStreamEvents(identity, (event) => { if (!event.kind.endsWith('observed.v1')) soon(); }, refresh);
  if (unread?.identity !== identity) return { count: 0, notifying: 0 };
  const answering = answeringIds();
  const handled = unread.items.filter((item) => left.has(item.key) || (item.agentQuestion && answering.has(item.agentQuestion.id))).length;
  return { count: Math.max(0, unread.count - handled), notifying: unread.notifying };
}
