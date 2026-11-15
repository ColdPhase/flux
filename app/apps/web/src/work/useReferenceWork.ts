import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigation, useRevalidator } from 'react-router';
import type { NativeWorkRow, WorkReferenceRows } from '@flux/contracts';
import { getWorkReferenceRows, workReferenceReadUrl } from './read-api';
import { selectReferenceWindow } from './reference-window';
import type { ReadState } from './read-state';
import { useWorkRead } from './useWorkRead';

/** Metadata for the actual visible references, not a project collection/cache.
 * All answer text and native destination buttons remain mounted outside this window.
 */
export function useReferenceWork(accountId: string, projectId: string, available: string[], node: HTMLElement | null, authorized: boolean) {
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const [selected, setSelected] = useState('');
  const [revision, setRevision] = useState(0);
  const availableKey = available.join(',');
  const allowed = useMemo(() => new Set(availableKey ? availableKey.split(',') : []), [availableKey]);
  useEffect(() => {
    if (!node) return;
    let frame = 0;
    let interacted: string | null = null;
    const measure = () => {
      const bounds = node.getBoundingClientRect();
      const elements = [...node.querySelectorAll<HTMLElement>('[data-native-ref]')];
      const visible = elements.filter((element) => {
        const row = element.getBoundingClientRect();
        return row.bottom > bounds.top && row.top < bounds.bottom;
      });
      const focused = elements.find((element) => element.contains(document.activeElement))?.dataset.nativeRef;
      // Citation labels stay limited to what is visible (see selectReferenceWindow).
      const refs = selectReferenceWindow({ focused, interacted, visible: visible.map((element) => element.dataset.nativeRef!) }, allowed).join(',');
      setSelected((previous) => previous === refs ? previous : refs);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    const interact = (event: Event) => {
      const element = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-native-ref]') : null;
      if (element && allowed.has(element.dataset.nativeRef!)) interacted = element.dataset.nativeRef!;
      schedule();
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    node.addEventListener('scroll', schedule, { passive: true });
    node.addEventListener('focusin', interact); node.addEventListener('pointerdown', interact);
    schedule();
    return () => {
      cancelAnimationFrame(frame); observer.disconnect();
      node.removeEventListener('scroll', schedule); node.removeEventListener('focusin', interact); node.removeEventListener('pointerdown', interact);
    };
  }, [allowed, node]);
  // Retire old reads during identity revalidation. Pausing dispatch alone would
  // allow an abort-ignoring response to resurrect actionable metadata meanwhile.
  const identityReady = authorized && navigation.state === 'idle' && revalidator.state === 'idle';
  const objects = selected.split(',').filter((value) => allowed.has(value)).join(',');
  const selector = objects ? workReferenceReadUrl(projectId, objects) : null;
  const scope = useMemo(() => identityReady && selector ? { accountId, projectId, selector } : null, [identityReady, selector, accountId, projectId]);
  const load = useCallback((signal: AbortSignal) => getWorkReferenceRows(projectId, objects, signal), [projectId, objects]);
  const state = useWorkRead(scope, load, revision);
  // Retained values during an ordinary refresh may label citations, but never authorize commands.
  const observation = state.phase === 'ready' || state.phase === 'refreshing' ? state.value : null;
  // Each card shows the last answer the server gave for it while it is read again (scrolling changes the visible window, so the
  // selector and its scope; identity revalidation pauses the read): never a blank card between two reads, nothing shifts. A card
  // changes only on a real answer: its new row, unavailable (the announced form, no current row), or every card's row dropped when
  // a read fails. Another account or space, or access lost (`authorized` false), starts from nothing.
  const owner = authorized ? JSON.stringify([accountId, projectId]) : null;
  const [kept, setKept] = useState<Kept>(() => keptFor(owner));
  let shown = kept.owner === owner ? kept : keptFor(owner);
  if (owner !== null && (state.phase === 'ready' || state.phase === 'unavailable') && state.generation > shown.generation) shown = answered(shown, state, allowed);
  if (shown !== kept) setKept(shown);
  const { rows, unavailable } = shown;
  return {
    state, rows, unavailable, observation, identityReady,
    actionable: identityReady && state.phase === 'ready',
    readingRevision: `${state.phase}:${state.generation}:${observation?.observedAt ?? ''}`,
    refresh: () => setRevision((value) => value + 1),
  };
}

interface Kept {
  readonly owner: string | null;
  /** The read generation of the last answer merged in: an answer is merged once, and never after a newer one. */
  readonly generation: number;
  readonly rows: ReadonlyMap<string, NativeWorkRow>;
  readonly unavailable: ReadonlySet<string>;
}

const keptFor = (owner: string | null): Kept => ({ owner, generation: -1, rows: new Map(), unavailable: new Set() });

/** The kept rows after one answer: what it returned replaces what was kept for those cards. Only references still in the view are kept
 * (at most the view's references, never a project collection). */
function answered(kept: Kept, answer: Extract<ReadState<WorkReferenceRows>, { phase: 'ready' | 'unavailable' }>, allowed: ReadonlySet<string>): Kept {
  if (answer.phase === 'unavailable') return { owner: kept.owner, generation: answer.generation, rows: new Map(), unavailable: new Set() };
  const rows = new Map([...kept.rows].filter(([ref]) => allowed.has(ref)));
  const unavailable = new Set([...kept.unavailable].filter((ref) => allowed.has(ref)));
  for (const row of answer.value.items) {
    const ref = `${row.kind}:${row.id}`;
    rows.set(ref, row); unavailable.delete(ref);
  }
  for (const item of answer.value.unavailable) {
    const ref = `${item.kind}:${item.id}`;
    rows.delete(ref); unavailable.add(ref);
  }
  return { owner: kept.owner, generation: answer.generation, rows, unavailable };
}
