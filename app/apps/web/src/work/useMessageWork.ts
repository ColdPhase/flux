import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useRevalidator } from 'react-router';
import type { WorkAssociationQuery } from '@flux/contracts';
import { getWorkAssociations, workAssociationReadUrl } from './read-api';
import { messageWorkPreviews, visibleMessageBatch } from './message-associations';
import { useWorkRead } from './useWorkRead';

interface Position { cursor: string | null; edgeCursor: string | null }
const positions = new Map<string, Position>();
function remembered(key: string): Position {
  const memory = positions.get(key);
  if (memory) return memory;
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (value && typeof value === 'object' && 'cursor' in value && 'edgeCursor' in value &&
        [value.cursor, value.edgeCursor].every((cursor) => cursor === null || typeof cursor === 'string' && cursor.length > 0 && cursor.length <= 512)) {
      return { cursor: value.cursor as string | null, edgeCursor: value.edgeCursor as string | null };
    }
  } catch { /* Visit-local navigation remains available. */ }
  return { cursor: null, edgeCursor: null };
}

function useMessageBatch(ref: RefObject<HTMLElement | null>, ids: string[], node: HTMLElement | null) {
  const [retained, setRetained] = useState(() => ids.slice(-100));
  const available = useMemo(() => {
    const valid = new Set(ids);
    return retained.length && retained.every((id) => valid.has(id)) ? retained : ids.slice(-100);
  }, [ids, retained]);
  useEffect(() => {
    const pane = ref.current;
    if (!pane || pane !== node) return;
    let frame = 0;
    const measure = () => {
      const bounds = pane.getBoundingClientRect();
      const visible = [...pane.querySelectorAll<HTMLElement>('[data-message-id]')].filter((message) => {
        const row = message.getBoundingClientRect();
        return row.bottom > bounds.top && row.top < bounds.bottom;
      }).map((message) => message.dataset.messageId!);
      setRetained((previous) => {
        const next = visibleMessageBatch(ids, visible, previous);
        return next.join(',') === previous.join(',') ? previous : next;
      });
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    const resize = new ResizeObserver(schedule);
    resize.observe(pane);
    if (pane.firstElementChild) resize.observe(pane.firstElementChild);
    pane.addEventListener('scroll', schedule, { passive: true });
    schedule();
    return () => { cancelAnimationFrame(frame); resize.disconnect(); pane.removeEventListener('scroll', schedule); };
  }, [ref, ids, node]);
  return available;
}

function useMessageReadingPosition(ref: RefObject<HTMLElement | null>, node: HTMLElement | null, ready: boolean, observedAt?: string) {
  const anchor = useRef<{ id: string; offset: number; top: number; atEnd: boolean } | null>(null);
  const readerMoved = useRef(false);
  // The scrollTop this hook last wrote. Any other scroll (wheel, keys, scrollIntoView, focus,
  // find-in-page) is the reader's position and is kept even while a new message batch loads.
  const ownScroll = useRef<number | null>(null);
  const save = useCallback((intent = false) => {
    const pane = ref.current;
    if (!pane || !ready && !readerMoved.current && !intent) return;
    const top = pane.getBoundingClientRect().top;
    const message = [...pane.querySelectorAll<HTMLElement>('[data-message-id],[data-answer-run]')].find((row) => row.getBoundingClientRect().bottom > top);
    // A reader at the end keeps following new content; anyone else keeps their row.
    const atEnd = pane.scrollHeight - pane.clientHeight - pane.scrollTop <= 8;
    if (message) anchor.current = { id: message.id, offset: message.getBoundingClientRect().top - top, top: pane.scrollTop, atEnd };
  }, [ref, ready]);
  useLayoutEffect(() => {
    const pane = ref.current;
    if (!pane || pane !== node) return;
    const stored = anchor.current;
    if (stored && (ready || !readerMoved.current)) {
      const message = [...pane.querySelectorAll<HTMLElement>('[data-message-id],[data-answer-run]')].find((row) => row.id === stored.id);
      const target = stored.atEnd ? pane.scrollHeight - pane.clientHeight
        : message ? pane.scrollTop + message.getBoundingClientRect().top - pane.getBoundingClientRect().top - stored.offset : stored.top;
      // Even a no-op scrollTop assignment interrupts native smooth key/touch scrolling.
      if (Math.abs(target - pane.scrollTop) > 0.5) { pane.scrollTop = target; ownScroll.current = pane.scrollTop; }
    }
    // Intent survives intermediate observations in the same native gesture.
    // During an active gesture let native scroll anchoring preserve the message;
    // writing scrollTop on a loading transition would interrupt smooth scrolling.
    const wheel = (event: WheelEvent) => { if (event.deltaY && !event.ctrlKey) readerMoved.current = true; };
    const touch = () => { readerMoved.current = true; };
    const key = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest('input,textarea,select,[contenteditable="true"]')) return;
      if (['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key)) readerMoved.current = true;
    };
    const pointer = (event: PointerEvent) => { if (event.target === pane) readerMoved.current = true; };
    if (ready) save();
    const scrolled = () => {
      const own = ownScroll.current;
      ownScroll.current = null;
      save(own === null || Math.abs(pane.scrollTop - own) > 1);
    };
    pane.addEventListener('scroll', scrolled, { passive: true });
    pane.addEventListener('wheel', wheel, { passive: true }); pane.addEventListener('touchstart', touch, { passive: true });
    pane.addEventListener('keydown', key); pane.addEventListener('pointerdown', pointer);
    return () => {
      pane.removeEventListener('scroll', scrolled); pane.removeEventListener('wheel', wheel); pane.removeEventListener('touchstart', touch);
      pane.removeEventListener('keydown', key); pane.removeEventListener('pointerdown', pointer);
    };
  }, [ref, node, ready, observedAt, save]);
  return save;
}

/** One batch for the actual message window; object and matched-edge pages stay independent. */
export function useMessageWork(accountId: string, projectId: string, conversationId: string | null, messageIds: string[], ref: RefObject<HTMLElement | null>, node: HTMLElement | null, referenceRevision = '') {
  const selected = useMessageBatch(ref, messageIds, node).slice().sort().join(',');
  const base = `flux:message-work:${JSON.stringify([accountId, projectId, conversationId, selected])}`;
  const [stored, setPosition] = useState(() => ({ base, ...remembered(base) }));
  const position = stored.base === base ? stored : { base, ...remembered(base) };
  const [revision, setRevision] = useState(0);
  const revalidator = useRevalidator();
  const query = useMemo<WorkAssociationQuery>(() => ({ messageIds: selected, relation: 'source', ...(position.cursor ? { cursor: position.cursor } : {}), ...(position.edgeCursor ? { edgeCursor: position.edgeCursor } : {}) }), [selected, position.cursor, position.edgeCursor]);
  const selector = selected && conversationId ? workAssociationReadUrl(projectId, query) : null;
  const scope = useMemo(() => selector ? { accountId, projectId, selector } : null, [accountId, projectId, selector]);
  const load = useCallback((signal: AbortSignal) => getWorkAssociations(projectId, query, signal), [projectId, query]);
  const state = useWorkRead(scope, load, revision, revalidator.state === 'idle');
  const page = state.phase === 'ready' || state.phase === 'refreshing' ? state.value : null;
  const previews = useMemo(() => page ? messageWorkPreviews(page) : null, [page]);
  const saveReading = useMessageReadingPosition(ref, node, page !== null, `${page?.observedAt ?? ''}:${referenceRevision}`);
  useEffect(() => {
    const value = { cursor: position.cursor, edgeCursor: position.edgeCursor };
    positions.set(base, value);
    try { sessionStorage.setItem(base, JSON.stringify(value)); } catch { /* Keep this visit's page. */ }
  }, [base, position.cursor, position.edgeCursor]);
  const move = (cursor: string | null, edgeCursor: string | null) => {
    saveReading(); setPosition({ base, cursor, edgeCursor });
  };
  return {
    state, page, previews,
    busy: state.phase !== 'ready' && state.phase !== 'unavailable' || revalidator.state !== 'idle',
    moveObjects: (cursor: string) => move(cursor, null),
    moveEdges: (edgeCursor: string) => move(position.cursor, edgeCursor),
    refreshObjects: () => { move(null, null); setRevision((value) => value + 1); },
    refreshEdges: () => { move(position.cursor, null); setRevision((value) => value + 1); },
  };
}
