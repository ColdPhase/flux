/**
 * Typing that runs ahead of a new page (#1171). From the moment Create page (or Enter in the title) is pressed until the new page's
 * editor has the caret, focus is on nothing the person can type into: the title field is disabled while the page is made, the
 * closing window gives focus back to its opener, and the page's route still loads. Keys typed then were lost, or reached the
 * opener (Space or Enter on "New" opened the Create window again).
 *
 * While a page is being opened to write, this holds those keys instead: printable characters, Enter as a new line and Backspace,
 * with their default action stopped. The new page's editor takes the held text when it opens and puts it where its caret starts.
 * A key while composing goes on as usual. Tab, Escape, a Ctrl or Cmd shortcut (Search, say) or a click end the hold and drop what it
 * held: the person has moved on. So does a page that does not open in time.
 */

/** How long a hold waits for its page at most, from Create page; a page that takes longer (or does not open) leaves typing as it was. */
const HOLD_MS = 3_000;

interface Hold { text: string; end: () => void }

let current: Hold | null = null;

/** One typed character: a single grapheme with no Ctrl or Cmd shortcut held (AltGr and Option still type characters). */
function character(event: KeyboardEvent): string | null {
  if (event.isComposing || event.metaKey || (event.ctrlKey && !event.altKey)) return null;
  if (event.key === 'Enter') return '\n';
  return [...event.key].length === 1 ? event.key : null;
}

/** Starts holding what is typed until the new page's editor takes it. Returns how to end the hold when no page opens (its text is dropped). */
export function holdTyping(): () => void {
  current?.end();
  const hold: Hold = { text: '', end: () => undefined };
  const onKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) return;
    if (event.key === 'Tab' || event.key === 'Escape' || ((event.metaKey || event.ctrlKey) && !(event.ctrlKey && event.altKey))) { stop(); return; }
    if (event.key === 'Backspace' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      hold.text = [...hold.text].slice(0, -1).join('');
    } else {
      const typed = character(event);
      if (typed === null) return;
      hold.text += typed;
    }
    event.preventDefault();
    event.stopPropagation();
  };
  // A Space or Enter whose keydown was held does not click the opener on its keyup either (Firefox activates a button on keyup).
  const onKeyUp = (event: KeyboardEvent) => { if (event.key === ' ' || event.key === 'Enter') event.preventDefault(); };
  const onPointer = () => stop();
  const timer = window.setTimeout(() => stop(), HOLD_MS);
  function stop() {
    window.clearTimeout(timer);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('pointerdown', onPointer, true);
    if (current === hold) current = null;
  }
  hold.end = stop;
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('pointerdown', onPointer, true);
  current = hold;
  return stop;
}

/** The text typed ahead of the page that is opening, which ends the hold; empty when nothing was held. */
export function takeHeldTyping(): string {
  const hold = current;
  if (!hold) return '';
  hold.end();
  return hold.text;
}
