/**
 * Genuine reader input on a scroll container (#155): wheel, touch, scroll keys outside
 * editable fields, a pointer pressed in the container, or focus moved into it. Layout (late
 * previews, scroll anchoring, a resized composer) and the app's own scroll writes are not
 * input, so they must never be mistaken for the reader moving the view.
 *
 * One tracker per element is shared by everything that positions that element. It stays
 * attached for the element's lifetime, so input is not forgotten when an effect re-runs.
 */
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
/** How long after input a scroll that the app did not write still counts as the reader's. */
export const READER_INPUT_MS = 500;

interface Tracker { last: number; listeners: Set<() => void> }
const trackers = new WeakMap<HTMLElement, Tracker>();

function attach(element: HTMLElement): Tracker {
  const tracker: Tracker = { last: Number.NEGATIVE_INFINITY, listeners: new Set() };
  const input = () => { tracker.last = performance.now(); for (const listener of [...tracker.listeners]) listener(); };
  const wheel = (event: WheelEvent) => { if ((event.deltaY || event.deltaX) && !event.ctrlKey) input(); };
  const key = (event: KeyboardEvent) => {
    if (event.target instanceof HTMLElement && event.target.closest('input,textarea,select,[contenteditable="true"]')) return;
    if (SCROLL_KEYS.has(event.key)) input();
  };
  // Focus moved to something inside (keyboard, assistive technology, a reader's script) brings
  // it into view; the container receiving focus itself is the app restoring a position.
  const focus = (event: FocusEvent) => { if (event.target !== element) input(); };
  element.addEventListener('wheel', wheel, { passive: true });
  element.addEventListener('touchstart', input, { passive: true });
  element.addEventListener('touchmove', input, { passive: true });
  element.addEventListener('pointerdown', input, { passive: true });
  element.addEventListener('keydown', key);
  element.addEventListener('focusin', focus);
  return tracker;
}

/** Track input on `element`; `onInput` (optional) hears each input until the returned release. */
export function watchReaderInput(element: HTMLElement, onInput?: () => void): () => void {
  let tracker = trackers.get(element);
  if (!tracker) { tracker = attach(element); trackers.set(element, tracker); }
  const listeners = tracker.listeners;
  const listener = onInput ? () => onInput() : null;
  if (listener) listeners.add(listener);
  return () => { if (listener) listeners.delete(listener); };
}

/** When the reader last gave input on `element` (performance.now() time), if it is tracked. */
export function lastReaderInput(element: HTMLElement): number {
  return trackers.get(element)?.last ?? Number.NEGATIVE_INFINITY;
}

/** Whether the reader gave input on `element` within the last READER_INPUT_MS. */
export function readerActive(element: HTMLElement, now = performance.now()): boolean {
  return now - lastReaderInput(element) <= READER_INPUT_MS;
}
