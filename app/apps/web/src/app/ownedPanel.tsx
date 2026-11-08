import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { trapTab } from '../ui';
import { useShellActions, type OwnedPanel } from './shellContext';

/**
 * Puts a view's own object (a thread, an agent) into the one panel (F-026 S4, #488). The view keeps its state, address
 * and drafts; the panel only gives it a place, a head with its kind, a way back and the one close. Pass `null` while
 * nothing is open. It returns the panel's slot while this panel is the one showing, and the view renders into it with
 * `createPortal`; it is null while the panel shows something else (a task over the thread) or before the slot exists.
 */
export function useOwnedPanel(panel: OwnedPanel | null): HTMLElement | null {
  const { showPanel, hidePanel, panelSlot, panelKey } = useShellActions();
  const latest = useRef(panel);
  useEffect(() => { latest.current = panel; });
  const key = panel?.key ?? null;
  const chip = panel?.chip;
  const label = panel?.label;
  const closeLabel = panel?.closeLabel;
  const backLabel = panel?.back?.label;
  const originLabel = panel?.origin?.label;
  const startFull = panel?.startFull;
  useEffect(() => {
    if (!key || !chip || !label) return;
    // The handlers read the view's latest closures, so a re-render never re-registers the panel.
    showPanel({
      key, chip, label, closeLabel, startFull,
      ...(backLabel ? { back: { label: backLabel, run: () => latest.current?.back?.run() } } : {}),
      ...(originLabel ? { origin: { label: originLabel, run: () => latest.current?.origin?.run() } } : {}),
      onClose: (options) => latest.current?.onClose(options),
    });
  }, [showPanel, key, chip, label, closeLabel, backLabel, originLabel, startFull]);
  useEffect(() => (key ? () => hidePanel(key) : undefined), [hidePanel, key]);
  return key && panelKey === key ? panelSlot : null;
}

/**
 * What a view renders into its panel's slot. A portal's events reach the view's own React ancestors, not the panel the
 * content sits in, so the panel's keys are handled here: Esc closes the whole panel, and in a modal sheet or overlay Tab
 * stays inside it, as it does for every other content of the panel.
 */
export function OwnedPanelContent({ slot, className, id, children }: { slot: HTMLElement; className?: string; id?: string; children: ReactNode }) {
  const { closePanel } = useShellActions();
  const ref = useRef<HTMLDivElement>(null);
  // Content that takes the place of another in an open panel (an agent's thread over its agent) keeps focus in the panel:
  // the control that was pressed is gone. A panel that has just opened already holds focus.
  useLayoutEffect(() => {
    const el = ref.current;
    // A copy left by the content this replaces goes at once: only a closing panel shows it (below).
    for (const copy of slot.querySelectorAll(':scope > [data-exiting]')) copy.remove();
    if (el && !el.closest('.ui-panel')?.contains(document.activeElement)) el.focus({ preventScroll: true });
    // The panel leaves with what it showed (#901, motion rule 3): the view takes its content away in the same moment the panel
    // starts its 120 ms exit, so an inert copy stands in the slot until the panel is gone or other content takes its place.
    return () => {
      if (!el || !slot.isConnected) return;
      const copy = el.cloneNode(true) as HTMLElement;
      copy.removeAttribute('id');
      copy.setAttribute('data-exiting', '');
      copy.setAttribute('aria-hidden', 'true');
      copy.inert = true;
      slot.appendChild(copy);
      window.setTimeout(() => copy.remove(), 400);
    };
  }, [slot]);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      // An Escape that a field or a menu inside already used, or that ends an input method's composition, is not a request to close.
      if (event.defaultPrevented || event.nativeEvent.isComposing) return;
      event.stopPropagation();
      closePanel();
      return;
    }
    const surface = event.currentTarget.closest<HTMLElement>('.ui-overlay__surface');
    if (surface) trapTab(event, surface);
  };
  return createPortal(<div ref={ref} tabIndex={-1} className={className} id={id} onKeyDown={onKeyDown}>{children}</div>, slot);
}
