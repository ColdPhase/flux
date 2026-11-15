/**
 * Where a key is the composer's, never an app shortcut (#1424): anywhere inside a composer, not only its text field. After a file is attached
 * the focus can be on the paperclip, Send or a file's remove button, and typing there ("check") opened New with "heck" in its title and went to
 * the Inbox.
 */
function inComposer(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('.composer, .composer__box, .composer-files') !== null;
}

const FIELD = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="combobox"], [role="listbox"], [role="textbox"]';

function inField(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (target instanceof HTMLElement && target.isContentEditable) || target.closest(FIELD) !== null || inComposer(target);
}

/** How long a field asked for may take to arrive (a thread's route read on a slow line) before keys are shortcuts again. */
const FIELD_WAIT_MS = 4000;
let fieldDue = 0;
let watching = false;
/** What was typed while the field was on its way: it goes into the field when the field takes focus. */
let typed = '';
/** The end of the wait the kept letters belong to; a cancelled wait (`focusField`'s cleanup) keeps them for the wait that follows at once. */
let keptUntil = 0;

const fieldOnItsWay = () => fieldDue > performance.now();

/** Puts what was typed before the field arrived at the end of the field, as typing would (React hears it as input). */
function typeInto(field: EventTarget | null, text: string) {
  if (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) {
    const end = field.value.length;
    field.setSelectionRange(end, end);
    if (!document.execCommand('insertText', false, text)) {
      field.setRangeText(text, end, end, 'end');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
  } else if (field instanceof HTMLElement && field.isContentEditable) document.execCommand('insertText', false, text);
}

/**
 * A press that asks for a field (Reply, R, opening a thread to reply) moves focus there, often after a route read. From the press until that
 * field has focus, keys are typing, never shortcuts: "Sure…" typed at once must not become R on the message the link arrived at, or S and E
 * in the Inbox (#1424). What is typed meanwhile is kept and goes into the field when it has focus, so no letter is lost. The wait ends when a
 * field takes focus, when the person presses somewhere (what was kept is dropped), or after a few seconds.
 */
export function awaitField() {
  typed = '';
  waitForField();
}

/** The wait itself; what was typed so far is kept (the field that a press asked for is focused by the page it opens, `focusField`). */
function waitForField() {
  const now = performance.now();
  // Kept only within the wait it was typed in: a wait that ran out never hands its letters to a later field.
  if (now > keptUntil) typed = '';
  fieldDue = now + FIELD_WAIT_MS;
  keptUntil = fieldDue;
  if (watching || typeof document === 'undefined') return;
  watching = true;
  document.addEventListener('keydown', (event) => {
    if (!fieldOnItsWay() || inField(event.target) || event.metaKey || event.ctrlKey || event.altKey || event.key.length !== 1) return;
    event.preventDefault();
    typed += event.key;
  }, true);
  document.addEventListener('focusin', (event) => {
    if (!inField(event.target)) return;
    const text = fieldOnItsWay() ? typed : '';
    fieldDue = 0;
    typed = '';
    if (text) typeInto(event.target, text);
  }, true);
  document.addEventListener('pointerdown', () => { fieldDue = 0; typed = ''; }, true);
}

/**
 * The one rule for single-key shortcuts (F-026 §4 keyboard: C, G then I, [, J, K, E, S, A, Z, R, T, 1–4, End): a key is typing, never a
 * shortcut, while focus is in a field (a text box, a list being picked from, an editable page) or anywhere in a composer, and while focus is on
 * its way to a field (`awaitField`). Every single-key shortcut asks this before it acts.
 */
export function isTyping(target: EventTarget | null): boolean {
  return inField(target) || fieldOnItsWay();
}

/**
 * Puts focus in a field that may not be ready yet (a thread's reply field while its panel opens): now, then each frame until it has it, for
 * as long as the wait of `awaitField` lasts. Returns a cancel, which also ends the wait.
 */
export function focusField(id: string): () => void {
  waitForField();
  let frame = 0;
  const attempt = () => {
    const field = document.getElementById(id);
    if (field && document.activeElement !== field) field.focus({ preventScroll: true });
    if ((field && document.activeElement === field) || !fieldOnItsWay()) { frame = 0; return; }
    frame = requestAnimationFrame(attempt);
  };
  attempt();
  return () => {
    if (!frame) return;
    cancelAnimationFrame(frame);
    fieldDue = 0;
  };
}

/**
 * A message a link or a return arrives at takes focus (F-026 rule 6), but never from a field the person is typing in or a field on its way:
 * an Inbox Reply lands on the mention and in the reply field, and the field keeps the focus.
 */
export function focusArrival(element: HTMLElement) {
  if (isTyping(document.activeElement)) return;
  element.focus({ preventScroll: true });
}
