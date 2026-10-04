import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigation, useRevalidator } from 'react-router';
import type { NativeWorkRow } from '@flux/contracts';
import { getWorkReferenceRows, workReferenceReadUrl } from './read-api';
import { selectReferenceWindow } from './reference-window';
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
      // A proposal's authority (Accept/Dismiss) does not depend on where the reader has scrolled
      // while the loaded window has at most 98 proposal targets; beyond that the nearest are read
      // first (see selectReferenceWindow). Citation labels stay limited to what is visible.
      const proposals = elements.filter((element) => element.dataset.proposalTarget !== undefined && element.dataset.nativeRef).map((element) => {
        const row = element.getBoundingClientRect();
        return { ref: element.dataset.nativeRef!, distance: row.bottom < bounds.top ? bounds.top - row.bottom : row.top > bounds.bottom ? row.top - bounds.bottom : 0 };
      });
      const refs = selectReferenceWindow({ focused, interacted, proposals, visible: visible.map((element) => element.dataset.nativeRef!) }, allowed).join(',');
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
  const rows = useMemo(() => new Map<string, NativeWorkRow>(observation?.items.map((row) => [`${row.kind}:${row.id}`, row]) ?? []), [observation]);
  const unavailable = useMemo(() => new Set(observation?.unavailable.map((ref) => `${ref.kind}:${ref.id}`) ?? []), [observation]);
  return {
    state, rows, unavailable, observation, identityReady,
    actionable: identityReady && state.phase === 'ready',
    readingRevision: `${state.phase}:${state.generation}:${observation?.observedAt ?? ''}`,
    refresh: () => setRevision((value) => value + 1),
  };
}
