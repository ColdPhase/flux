/**
 * Which input the person used last, as `data-input` on <html>: `pointer` after a tap or a click, `keys` after a key
 * (founder direction, Hubert 2026-11-17, #1424). ui.css makes every focus ring (`--ring`) transparent while it is `pointer`,
 * so a script that moves the focus after a tap (the phone Inbox's expanded title) frames nothing, and the next key brings
 * the ring back where the focus is. Before the first event there is no attribute and rings show as the browser decides.
 */
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Fn', 'FnLock', 'Hyper', 'Super', 'OS']);

function set(mode: 'pointer' | 'keys') {
  const root = document.documentElement;
  if (root.dataset.input !== mode) root.dataset.input = mode;
}

export function installInputMode() {
  // Capture on the window, before any handler can stop the event or move the focus in answer to it.
  window.addEventListener('pointerdown', () => set('pointer'), { capture: true, passive: true });
  window.addEventListener('keydown', (event) => { if (!MODIFIERS.has(event.key)) set('keys'); }, { capture: true, passive: true });
}
