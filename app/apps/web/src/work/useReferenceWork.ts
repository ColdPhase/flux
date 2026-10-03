import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigation, useRevalidator } from 'react-router';
import type { NativeWorkRow } from '@flux/contracts';
import { getWorkReferenceRows, workReferenceReadUrl } from './read-api';
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
      // A visible target's authority matters before ancillary citation labels.
      const priorities = [focused, interacted,
        ...visible.filter((element) => element.dataset.proposalTarget !== undefined).map((element) => element.dataset.nativeRef),
        ...visible.map((element) => element.dataset.nativeRef)];
      const refs = [...new Set(priorities.filter((value): value is string => !!value && allowed.has(value)))].slice(0, 100).sort().join(',');
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
