import { PRESS_ID, duration, motionAllowed, token } from './motion';

/**
 * The one press (#863, docs/design/motion.md rule 7): a press is colour. A pressed control changes its fill or colour (the
 * `:hover` and `:active` rules of ui.css) within one frame, and rows, cards, list items, links and sidebar items never scale.
 * Only a small button or icon button, up to `SMALL` px on its longest side, also scales to --press (.98) as it is pressed and
 * returns to full size over --dur-1 on --ease-out, with no spring. It animates the individual `scale` property, so it composes
 * with a control's own `transform` (a swipe's offset, a centring translate). Reduced motion zeroes --dur-1 and sets --press to 1:
 * nothing runs.
 *
 * It takes a real button, not a disabled one, and not what opts out with `data-no-press` (a drag handle, the map's own nodes).
 */
const PRESSABLE = 'button, [role="button"]';
const SKIP = ':disabled, [aria-disabled="true"], [data-no-press], [data-no-press] *, .ui-vh, .sk-plane *';
/** The longest side of a control that may scale, in px (proposed in docs/design/motion.md; rows and cards are larger or never scale at all). */
const SMALL = 64;

function pressTarget(node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  const el = node.closest<HTMLElement>(PRESSABLE);
  if (!el || el.matches(SKIP)) return null;
  // Only a small control scales; a row that happens to be a button changes colour instead. An inline one has no box to scale.
  if (getComputedStyle(el).display === 'inline') return null;
  return Math.max(el.offsetWidth, el.offsetHeight) <= SMALL ? el : null;
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
  const ms = duration('--dur-1');
  if (!ms || !motionAllowed()) return;
  const back = el.animate([{ scale: from }, { scale: '1' }], { duration: ms, easing: token('--ease-out') || 'ease-out' });
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
    // Space presses a button, Enter a button; a text field's keys are not a press.
    if (el && !(event.target as Element).matches('input, textarea, select, [role="combobox"], [contenteditable]')) press(el);
  }, { capture: true, passive: true });
  document.addEventListener('keyup', (event) => { if (event.key === ' ' || event.key === 'Enter') release(); }, { capture: true, passive: true });
}
