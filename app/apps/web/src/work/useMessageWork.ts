import { useCallback, useEffect, useMemo, useState, type RefObject } from 'react';
import { useRevalidator } from 'react-router';
import type { WorkAssociationQuery } from '@flux/contracts';
import { getWorkAssociations, workAssociationReadUrl } from './read-api';
import { messageWorkPreviews, visibleMessageBatch } from './message-associations';
import { useWorkRead } from './useWorkRead';
import { threadPlace, useMessageReadingPosition, type ThreadPlace } from './readingPosition';

export { threadPlace, type ThreadPlace };

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

/**
 * One bounded association read (#155) for the messages around the viewport (at most 100): their
 * object chips and matched-edge pages. It reads, it never positions the feed. `scopeKey` names where
 * the batch belongs (a conversation id, or the project's stream of roots); null reads nothing.
 */
export function useMessageWorkRead(accountId: string, projectId: string, scopeKey: string | null, messageIds: string[], ref: RefObject<HTMLElement | null>, node: HTMLElement | null) {
  const selected = useMessageBatch(ref, messageIds, node).slice().sort().join(',');
  const base = `flux:message-work:${JSON.stringify([accountId, projectId, scopeKey, selected])}`;
  const [stored, setPosition] = useState(() => ({ base, ...remembered(base) }));
  const position = stored.base === base ? stored : { base, ...remembered(base) };
  const [revision, setRevision] = useState(0);
  const revalidator = useRevalidator();
  const query = useMemo<WorkAssociationQuery>(() => ({ messageIds: selected, relation: 'source', ...(position.cursor ? { cursor: position.cursor } : {}), ...(position.edgeCursor ? { edgeCursor: position.edgeCursor } : {}) }), [selected, position.cursor, position.edgeCursor]);
  const selector = selected && scopeKey ? workAssociationReadUrl(projectId, query) : null;
  const scope = useMemo(() => selector ? { accountId, projectId, selector } : null, [accountId, projectId, selector]);
  const load = useCallback((signal: AbortSignal) => getWorkAssociations(projectId, query, signal), [projectId, query]);
  const state = useWorkRead(scope, load, revision, revalidator.state === 'idle');
  const page = state.phase === 'ready' || state.phase === 'refreshing' ? state.value : null;
  const previews = useMemo(() => page ? messageWorkPreviews(page) : null, [page]);
  useEffect(() => {
    const value = { cursor: position.cursor, edgeCursor: position.edgeCursor };
    positions.set(base, value);
    try { sessionStorage.setItem(base, JSON.stringify(value)); } catch { /* Keep this visit's page. */ }
  }, [base, position.cursor, position.edgeCursor]);
  const move = (cursor: string | null, edgeCursor: string | null) => setPosition({ base, cursor, edgeCursor });
  return {
    state, page, previews,
    /** The reader has moved off the first object or link page. */
    paged: !!(position.cursor || position.edgeCursor),
    busy: state.phase !== 'ready' && state.phase !== 'unavailable' || revalidator.state !== 'idle',
    moveObjects: (cursor: string) => move(cursor, null),
    moveEdges: (edgeCursor: string) => move(position.cursor, edgeCursor),
    refreshObjects: () => { move(null, null); setRevision((value) => value + 1); },
    refreshEdges: () => { move(position.cursor, null); setRevision((value) => value + 1); },
  };
}
export type MessageWorkRead = ReturnType<typeof useMessageWorkRead>;

/**
 * The read above for one conversation's feed, which this hook also positions: it is that feed's one
 * reading-position owner. A feed with its own owner (the project's stream, #195) uses the read alone.
 */
export function useMessageWork(accountId: string, projectId: string, conversationId: string | null, messageIds: string[], ref: RefObject<HTMLElement | null>, node: HTMLElement | null, referenceRevision = '', restore: ThreadPlace | null = null): MessageWorkRead {
  const read = useMessageWorkRead(accountId, projectId, conversationId, messageIds, ref, node);
  const saveReading = useMessageReadingPosition(ref, node, read.page !== null, `${read.page?.observedAt ?? ''}:${referenceRevision}`, restore);
  return {
    ...read,
    moveObjects: (cursor: string) => { saveReading(); read.moveObjects(cursor); },
    moveEdges: (edgeCursor: string) => { saveReading(); read.moveEdges(edgeCursor); },
    refreshObjects: () => { saveReading(); read.refreshObjects(); },
    refreshEdges: () => { saveReading(); read.refreshEdges(); },
  };
}
