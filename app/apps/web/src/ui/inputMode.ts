/**
 * Which input the person used last, as `data-input` on <html>: `pointer` after a tap or a click, `keys` after a key
 * (founder direction, Hubert 2026-11-17, #1424), and `field` after a tap or a click in a text field (the caret is going there, so its
 * ring shows). ui.css makes every focus ring (`--ring`) transparent while it is `pointer`, so a script that moves the focus after a tap
 * (the phone Inbox's expanded title, a window's first field, the composer of a conversation just opened) frames nothing, and the next
 * key or a click in that field brings the ring back where the focus is (visual review 2026-11-17: every conversation opened framed).
 * Before the first event there is no attribute and rings show as the browser decides.
 */
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Fn', 'FnLock', 'Hyper', 'Super', 'OS']);
const FIELD = 'textarea, select, [contenteditable]:not([contenteditable="false"]), input:not([type="checkbox"], [type="radio"], [type="range"], [type="button"], [type="submit"], [type="reset"], [type="color"], [type="file"], [type="image"])';

function set(mode: 'pointer' | 'keys' | 'field') {
  const root = document.documentElement;
  if (root.dataset.input !== mode) root.dataset.input = mode;
}

/** The press was on the field itself, its label or the box drawn around it (the composer's card, a picker's row). */
function pressedOn(target: EventTarget | null, field: Element | null): boolean {
  if (!(target instanceof Element) || !field?.matches(FIELD)) return false;
  return field.contains(target) || target === field.parentElement || target === field.parentElement?.parentElement
    || !!target.closest('label')?.contains(field);
}

export function installInputMode() {
  let pressed: EventTarget | null = null;
  // Capture on the window, before any handler can stop the event or move the focus in answer to it.
  window.addEventListener('pointerdown', (event) => {
    pressed = event.target;
    set(pressedOn(pressed, document.activeElement) ? 'field' : 'pointer');
  }, { capture: true, passive: true });
  // A field that takes the focus from the press itself (not from a script after it) shows its ring.
  window.addEventListener('focusin', (event) => {
    if (document.documentElement.dataset.input === 'pointer' && pressedOn(pressed, event.target as Element)) set('field');
  }, { capture: true });
  window.addEventListener('keydown', (event) => { if (!MODIFIERS.has(event.key)) set('keys'); }, { capture: true, passive: true });
}
