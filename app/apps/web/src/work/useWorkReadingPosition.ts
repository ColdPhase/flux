import { useCallback, useLayoutEffect, type RefObject } from 'react';

interface Position { top: number; anchor: { kind: string; id: string; offset: number } | null }
const positions = new Map<string, Position>();

function readPosition(key: string): Position | null {
  const retained = positions.get(key);
  if (retained) return retained;
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as Position;
    if (!Number.isFinite(value.top) || value.top < 0) return null;
    if (value.anchor && (typeof value.anchor.id !== 'string' || !['work', 'decision', 'result'].includes(value.anchor.kind) || !Number.isFinite(value.anchor.offset))) return null;
    positions.set(key, value);
    return value;
  } catch { return null; }
}

/** Restore after the bounded page arrives; loading DOM must never erase a saved anchor. */
export function useWorkReadingPosition(ref: RefObject<HTMLElement | null>, key: string, ready: boolean, observation?: string) {
  const save = useCallback(() => {
    const pane = ref.current;
    if (!pane || !ready) return;
    const top = pane.getBoundingClientRect().top;
    const controls = pane.querySelector<HTMLElement>('.ws-task-controls');
    const visibleTop = Math.max(top, controls?.getBoundingClientRect().bottom ?? top);
    const row = [...pane.querySelectorAll<HTMLElement>('[data-work-kind][data-work-id]')].find((element) => element.getBoundingClientRect().bottom > visibleTop);
    const position: Position = {
      top: pane.scrollTop,
      anchor: row ? { kind: row.dataset.workKind!, id: row.dataset.workId!, offset: row.getBoundingClientRect().top - top } : null,
    };
    positions.set(key, position);
    try { sessionStorage.setItem(key, JSON.stringify(position)); } catch { /* Retain this visit's position. */ }
  }, [ref, key, ready]);

  useLayoutEffect(() => {
    const pane = ref.current;
    if (!pane || !ready) return;
    const stored = readPosition(key);
    if (stored) {
      const row = stored.anchor ? [...pane.querySelectorAll<HTMLElement>('[data-work-kind][data-work-id]')].find((element) => element.dataset.workKind === stored.anchor!.kind && element.dataset.workId === stored.anchor!.id) : null;
      pane.scrollTop = row && stored.anchor
        ? pane.scrollTop + row.getBoundingClientRect().top - pane.getBoundingClientRect().top - stored.anchor.offset
        : stored.top;
    } else pane.scrollTop = 0;
    save();
    // Native focus scrolling does not account for a sticky overlay. Keep keyboard rows exposed
    // without changing private inputs or scrolling a different pane.
    const controls = pane.querySelector<HTMLElement>('.ws-task-controls');
    let frame = 0;
    const expose = (target: HTMLElement) => {
      if (document.activeElement !== target || !pane.contains(target)) return;
      const bounds = pane.getBoundingClientRect();
      const top = Math.max(bounds.top, controls?.getBoundingClientRect().bottom ?? bounds.top) + 8;
      const row = target.getBoundingClientRect();
      if (row.top < top) pane.scrollTop += row.top - top;
      else if (row.bottom > bounds.bottom) pane.scrollTop += row.bottom - bounds.bottom;
    };
    const focus = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.closest('[data-work-kind][data-work-id]')) return;
      expose(target);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => expose(target));
    };
    pane.addEventListener('scroll', save, { passive: true });
    pane.addEventListener('focusin', focus);
    return () => {
      pane.removeEventListener('scroll', save); pane.removeEventListener('focusin', focus);
      cancelAnimationFrame(frame);
    };
  }, [ref, key, ready, save, observation]);
  return save;
}
