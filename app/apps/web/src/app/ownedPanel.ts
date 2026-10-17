import { useEffect, useRef } from 'react';
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
  const backLabel = panel?.back?.label;
  const startFull = panel?.startFull;
  useEffect(() => {
    if (!key || !chip || !label) return;
    // The handlers read the view's latest closures, so a re-render never re-registers the panel.
    showPanel({
      key, chip, label, startFull,
      ...(backLabel ? { back: { label: backLabel, run: () => latest.current?.back?.run() } } : {}),
      onClose: (options) => latest.current?.onClose(options),
    });
  }, [showPanel, key, chip, label, backLabel, startFull]);
  useEffect(() => (key ? () => hidePanel(key) : undefined), [hidePanel, key]);
  return key && panelKey === key ? panelSlot : null;
}
