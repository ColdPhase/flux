import { PRESS_ID, duration, motionAllowed, token } from './motion';

/**
 * The one press (#593 AC-5, final design guide §2): a pressable control scales to --press (.97) as it is pressed and
 * springs back over --dur-press (250 ms, --ease-spring) as it is let go. Chips, rows that open something, icon buttons,
 * the send button, menu items and swipe actions all take it from here, so no screen restyles it and the scale is the same
 * everywhere. It animates the individual `scale` property, so it composes with a control's own `transform` (a swipe's
 * offset, a centring translate) instead of replacing it. Reduced motion zeroes the durations: nothing runs.
 *
 * Pressable means a real control: a button, a link, or an element with a button-like role; not a disabled one, not text
 * flowing inline in a sentence, and not what opts out with `data-no-press` (a drag handle, the map's own nodes).
 */
const PRESSABLE = 'button, a[href], [role="button"], [role="tab"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], summary';
const SKIP = ':disabled, [aria-disabled="true"], [data-no-press], [data-no-press] *, .ui-vh, .sk-plane *';

function pressTarget(node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  const el = node.closest<HTMLElement>(PRESSABLE);
  if (!el || el.matches(SKIP)) return null;
  // An inline link inside a sentence has no box to scale.
  const display = getComputedStyle(el).display;
  return display === 'inline' ? null : el;
}

const scaleNow = (el: Element) => getComputedStyle(el).scale;

function begin(el: HTMLElement) {
  const ms = duration('--dur-1');
  const to = parseFloat(token('--press'));
  if (!ms || !motionAllowed() || !(to > 0) || to >= 1) return;
  const from = scaleNow(el);
  el.getAnimations().filter((animation) => animation.id === PRESS_ID).forEach((animation) => animation.cancel());
  const animation = el.animate([{ scale: from }, { scale: String(to) }], { duration: ms, easing: token('--ease-out') || 'ease-out', fill: 'forwards' });
  animation.id = PRESS_ID;
}

function end(el: HTMLElement) {
  const running = el.getAnimations().filter((animation) => animation.id === PRESS_ID);
  if (!running.length) return;
  const from = scaleNow(el);
  running.forEach((animation) => animation.cancel());
  const ms = duration('--dur-press');
  if (!ms || !motionAllowed()) return;
  const back = el.animate([{ scale: from }, { scale: '1' }], { duration: ms, easing: token('--ease-spring') || 'ease-out' });
  back.id = PRESS_ID;
}

/** Installs the press for the whole document; called once, before the first render. */
let installed = false;
export function installPress() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  let held: HTMLElement | null = null;
  const release = () => { if (held) { end(held); held = null; } };
  const press = (el: HTMLElement | null) => { release(); if (el) { held = el; begin(el); } };
  document.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
    press(pressTarget(event.target));
  }, { capture: true, passive: true });
  for (const type of ['pointerup', 'pointercancel', 'dragstart']) document.addEventListener(type, release, { capture: true, passive: true });
  window.addEventListener('blur', release);
  document.addEventListener('keydown', (event) => {
    if (event.repeat || (event.key !== ' ' && event.key !== 'Enter')) return;
    const el = pressTarget(event.target);
    // Space presses a button, Enter a link or a button; a text field's keys are not a press.
    if (el && !(event.target as Element).matches('input, textarea, select, [contenteditable]')) press(el);
  }, { capture: true, passive: true });
  document.addEventListener('keyup', (event) => { if (event.key === ' ' || event.key === 'Enter') release(); }, { capture: true, passive: true });
}
