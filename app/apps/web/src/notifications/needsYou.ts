import { useCallback, useEffect, useRef, useState } from 'react';
import {
  NEEDS_YOU_PATH,
  needsYouItemPath,
  type NeedsYouItem,
  type NeedsYouResolved,
  type NeedsYouResponse,
  type ResolveNeedsYouCommand,
} from '@flux/contracts';
import { request } from '../api/client';
import { noteLockedWorkspaces } from '../encryption/api';
import { useStreamEvents } from '../api/stream';
import { INBOX_CHANGED, NEEDS_YOU_ACCEPTED, announceInboxChange, type AcceptedInboxItem } from './api';
import { acceptingIds } from './pendingAccept';
import { onPlacesForgotten } from '../place/memory';
import { useProjectAiBlocked } from '../ai/workspaceAi';

/** The Inbox "Needs you" queue (#342): what asks something of you, computed for you alone. */
export const getNeedsYou = (signal?: AbortSignal) => request<NeedsYouResponse>(NEEDS_YOU_PATH, { signal }).then(noteLockedWorkspaces);
export const resolveNeedsYou = (key: string, command: ResolveNeedsYouCommand) =>
  request<NeedsYouResolved>(needsYouItemPath(key), { method: 'POST', body: command });
/** Undo of `resolveNeedsYou`: the item is back as it was. */
export const restoreNeedsYou = (key: string) => request<void>(needsYouItemPath(key), { method: 'DELETE' });

export interface LocalQueueChange { isCurrent: () => boolean }

export interface Queue {
  userId: string;
  /** Null until the first answer; the last good answer stays while a later read fails. */
  items: NeedsYouItem[] | null;
  count: number;
  later: number;
  doneToday: number;
  failed: boolean;
  reload: () => void;
  /**
   * Removes an item at once (it was handled here). `settled`, when given, is the server write for it: until that
   * settles (success or failure), reads preserve this item’s local state while applying unrelated updates.
   */
  hide: (key: string, settled?: Promise<unknown>) => LocalQueueChange;
  /**
   * Puts an item back at its place without waiting for the next read (Undo). `settled` is the server write Undo
   * sends, if any; the same rule as for `hide` applies until it settles.
   */
  show: (item: NeedsYouItem, settled?: Promise<unknown>) => LocalQueueChange;
}

const sorted = (items: NeedsYouItem[]) => {
  const order = { decision: 0, question: 1, blocked: 2, mention: 3 } as const;
  return [...items].sort((a, b) => order[a.kind] - order[b.kind] || b.at.localeCompare(a.at));
};

/**
 * The queue for Inbox and Home: read on mount, when the tab becomes visible, on stream events and when
 * something else changed the Inbox, so both places agree. Nothing is kept between accounts.
 */
/** The last answer this tab read, for the one person who read it: shown at once when they return to the Inbox (#592). Never stored. */
let lastRead: { userId: string; response: NeedsYouResponse } | null = null;
onPlacesForgotten(() => { lastRead = null; });

export function useNeedsYou(userId: string, fromMemory = false): Queue {
  const aiOff = useProjectAiBlocked();
  const [state, setState] = useState<{ userId: string; response: NeedsYouResponse | null; failed: boolean }>(() => ({ userId, response: fromMemory && lastRead?.userId === userId ? lastRead.response : null, failed: false }));
  const [version, setVersion] = useState(0);
  // Showing an item again re-renders even when the answer already holds it (it was only filtered out).
  const [, redraw] = useState(0);
  // Item-scoped intent survives reads made before its write settles (#519, #541).
  const scope = useRef({ userId, changes: new Map<string, { item: NeedsYouItem | null; pending: boolean }>() });
  const active = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reload = useCallback(() => setVersion((n) => n + 1), []);
  const soon = useCallback(() => {
    if (!active.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(reload, 1200);
  }, [reload]);
  useEffect(() => {
    scope.current = { userId, changes: new Map() };
    active.current = true;
    return () => { active.current = false; if (timer.current) clearTimeout(timer.current); };
  }, [userId]);
  const change = useCallback((key: string, item: NeedsYouItem | null, settled?: Promise<unknown>) => {
    const owner = scope.current;
    if (!active.current || owner.userId !== userId) return { isCurrent: () => false };
    const entry = { item, pending: !!settled };
    owner.changes.set(key, entry);
    if (settled) {
      const end = () => {
        // An earlier write must not clear the later Undo's protection.
        entry.pending = false;
        if (scope.current === owner) soon();
      };
      settled.then(end, end);
    }
    return { isCurrent: () => active.current && scope.current === owner && owner.changes.get(key) === entry };
  }, [userId, soon]);

  useEffect(() => {
    const controller = new AbortController();
    const changes = scope.current.changes;
    // Remember which intents this read can authoritatively reconcile. A write may settle before its answer.
    const started = new Map([...changes].filter(([, entry]) => !entry.pending));
    getNeedsYou(controller.signal).then((response) => {
      if (controller.signal.aborted) return;
      const items = new Map(response.items.map((item) => [item.key, item]));
      for (const [key, entry] of changes) {
        if (!entry.pending && started.get(key) === entry) {
          changes.delete(key);
        } else if (entry.item) {
          items.set(key, entry.item);
        } else {
          items.delete(key);
        }
      }
      const reconciled = sorted([...items.values()]);
      lastRead = { userId, response: { ...response, items: reconciled, count: reconciled.length } };
      setState({ userId, response: lastRead.response, failed: false });
    }, (error: unknown) => {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return;
      setState((previous) => ({ userId, response: previous.userId === userId ? previous.response : null, failed: true }));
    });
    return () => controller.abort();
  }, [userId, version]);
  const hide = useCallback((key: string, settled?: Promise<unknown>) => { const intent = change(key, null, settled); setState((previous) => previous.userId === userId && previous.response
    ? { ...previous, response: { ...previous.response, items: previous.response.items.filter((item) => item.key !== key), count: Math.max(0, previous.response.count - 1) } } : previous); return intent; }, [change, userId]);
  const show = useCallback((item: NeedsYouItem, settled?: Promise<unknown>) => { const intent = change(item.key, item, settled); redraw((n) => n + 1); setState((previous) => previous.userId === userId && previous.response && !previous.response.items.some((entry) => entry.key === item.key)
    ? { ...previous, response: { ...previous.response, items: sorted([...previous.response.items, item]), count: previous.response.count + 1 } } : previous); return intent; }, [change, userId]);
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') reload(); };
    const onAccepted = (event: Event) => {
      const detail = (event as CustomEvent<AcceptedInboxItem>).detail;
      if (detail.ownerId === userId) hide(detail.key);
    };
    window.addEventListener(NEEDS_YOU_ACCEPTED, onAccepted);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', reload);
    window.addEventListener(INBOX_CHANGED, reload);
    return () => {
      window.removeEventListener(NEEDS_YOU_ACCEPTED, onAccepted);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', reload);
      window.removeEventListener(INBOX_CHANGED, reload);
    };
  }, [reload, hide, userId]);
  useStreamEvents(userId, soon, reload);

  const mine = state.userId === userId ? state : { userId, response: null, failed: false };
  // A decision this person just accepted is not shown while the accept is waiting or on its way.
  const accepting = acceptingIds();
  // F-029 (#614): what an agent or assistant asks in a workspace whose AI is off is not shown, even from a read made before it was turned off.
  const items = mine.response ? mine.response.items.filter((item) => !(item.decision && accepting.has(item.decision.id))
    && !(item.project && aiOff(item.project.id) && (item.from?.kind === 'agent' || item.key.startsWith('assistant:')))) : null;
  return { userId, items, count: items?.length ?? 0, later: mine.response?.later ?? 0, doneToday: mine.response?.doneToday ?? 0, failed: mine.failed, reload, hide, show };
}

export { announceInboxChange };
