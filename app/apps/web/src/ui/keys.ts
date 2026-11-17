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
  return writesHere(target) || inComposer(target);
}

/** A place the letters of a key go into (a text box, a list being picked from, an editable page), not a composer's button. */
function writesHere(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (target instanceof HTMLElement && target.isContentEditable) || target.closest(FIELD) !== null;
}

/** How long a field asked for may take to arrive (a thread's route read on a slow line) before keys are shortcuts again. */
const FIELD_WAIT_MS = 4000;
let fieldDue = 0;
let watching = false;
/** What was typed while the field was on its way: it goes into the field when the field takes focus. */
let typed = '';
/** The end of the wait the kept letters belong to; a cancelled wait (`focusField`'s cleanup) keeps them for the wait that follows at once. */
let keptUntil = 0;
/** An Enter typed after the kept letters, pressed in the field once they are in it. */
let enterKept = false;
/**
 * The field the press that asked for another field was made in, which still has focus while that field is on its way (`/decide …` and Tab or
 * Enter in a composer, personas-37 P3-1): what is typed there meanwhile belongs to the field that comes, never to the one being left.
 */
let leavingField: Element | null = null;

const fieldOnItsWay = () => fieldDue > performance.now();

/** Puts what was typed before the field arrived at the end of the field, as typing would (React hears it as input). */
function typeInto(field: EventTarget | null, text: string) {
  if (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) {
    // An email or number field has no selection to place (setSelectionRange throws there, persona round 30): the letters go at its end.
    const selectable = field instanceof HTMLTextAreaElement || /^(text|search|url|tel|password)$/.test(field.type);
    if (selectable) { const end = field.value.length; field.setSelectionRange(end, end); }
    if (document.execCommand('insertText', false, text)) return;
    if (selectable) {
      const end = field.value.length;
      field.setRangeText(text, end, end, 'end');
    } else {
      // The value's own setter, so React hears the change as typing.
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set;
      setter?.call(field, `${field.value}${text}`);
    }
    field.dispatchEvent(new Event('input', { bubbles: true }));
  } else if (field instanceof HTMLElement && field.isContentEditable) document.execCommand('insertText', false, text);
}

/**
 * A press that asks for a field (Reply, R, opening a thread to reply) moves focus there, often after a route read. From the press until that
 * field has focus, keys are typing, never shortcuts: "Sure…" typed at once must not become R on the message the link arrived at, or S and E
 * in the Inbox (#1424). What is typed meanwhile is kept and goes into the field when it has focus, so no letter is lost. The wait ends when a
 * field takes focus, when the person presses somewhere (what was kept is dropped), or after a few seconds.
 */
export function awaitField(ms = FIELD_WAIT_MS, leaving: Element | null = null) {
  typed = '';
  enterKept = false;
  waitForField(ms);
  leavingField = leaving;
}

/** A field that was asked for will not come (opening the conversation failed): keys are shortcuts again, and what was kept is dropped. */
export function stopAwaitingField() {
  fieldDue = 0;
  typed = '';
  enterKept = false;
  leavingField = null;
}

/**
 * The wait itself; what was typed so far is kept (the field that a press asked for is focused by the page it opens, `focusField`). A page
 * that a press led to and that opens the conversation itself (New message › a person's name) continues the press's wait with it.
 */
export function waitForField(ms = FIELD_WAIT_MS) {
  const now = performance.now();
  // Kept only within the wait it was typed in: a wait that ran out never hands its letters to a later field.
  if (now > keptUntil) { typed = ''; enterKept = false; }
  fieldDue = now + ms;
  keptUntil = fieldDue;
  if (watching || typeof document === 'undefined') return;
  watching = true;
  // On the window, as the quiet keys of a view switch are (`useQuietViewKeys`, which stops them there): a key typed while the page changes is kept.
  window.addEventListener('keydown', (event) => {
    // Letters typed on a composer's button are kept too (personas-36: `/decide …`, Tab to Send, Space, and the rest of the sentence while
    // the window opened was lost on Send).
    if (!fieldOnItsWay() || (writesHere(event.target) && event.target !== leavingField) || event.metaKey || event.ctrlKey || event.altKey) return;
    // Enter after a sentence typed on the way sends it once it is in the field ("Message Piotr", then "can I swap…" and Enter, persona round
    // 28): it is kept too, never a press on the button that still has focus.
    if (event.key === 'Enter' && !event.shiftKey && typed) { event.preventDefault(); enterKept = true; return; }
    if (event.key.length !== 1) return;
    event.preventDefault();
    typed += event.key;
  }, true);
  document.addEventListener('focusin', (event) => {
    if (!inField(event.target) || event.target === leavingField) return;
    leavingField = null;
    const text = fieldOnItsWay() ? typed : '';
    const enter = text && enterKept;
    fieldDue = 0;
    typed = '';
    enterKept = false;
    if (text) typeInto(event.target, text);
    const field = event.target;
    // Once the field holds the words (the next frames), the Enter that followed them is pressed in it.
    if (enter && field instanceof HTMLElement) requestAnimationFrame(() => requestAnimationFrame(() => {
      if (document.activeElement === field) field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    }));
  }, true);
  document.addEventListener('pointerdown', () => { fieldDue = 0; typed = ''; enterKept = false; leavingField = null; }, true);
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
  return focusFieldBy(() => document.getElementById(id));
}

/** `focusField` for a field known by where it is (a panel's composer, whose id is its own): the first match of `selector`. */
export function focusFieldMatching(selector: string): () => void {
  return focusFieldBy(() => document.querySelector<HTMLElement>(selector));
}

/** How long a field that was given the focus keeps it against the page taking it away as it settles (a sheet still opening, personas-35). */
const HOLD_MS = 1200;

/**
 * Keeps `field` focused for a moment after it took the focus: a sheet or panel that finishes opening around it can leave the focus on the page
 * (a phone's first Reply from the Inbox left it there, personas-33/35). Only focus that fell to the page is put back; a press anywhere, or the
 * focus moving to another control, ends it. Returns the end.
 */
function holdFocus(field: HTMLElement): () => void {
  const until = performance.now() + HOLD_MS;
  let frame = 0;
  const end = () => {
    cancelAnimationFrame(frame);
    window.clearTimeout(timer);
    field.removeEventListener('focusout', lost);
    document.removeEventListener('pointerdown', end, true);
  };
  // The page, or the surface around the field (a sheet that focuses its body as it opens, WebKit), took it: not a place the person chose.
  const around = (element: Element | null) => !element || element === document.body || (element !== field && element.contains(field));
  const lost = (event: FocusEvent) => {
    if (!around(event.relatedTarget as Element | null)) { end(); return; }
    frame = requestAnimationFrame(() => {
      // Another field asked for meanwhile (New message's Enter blurs its search for the conversation's composer) is left to come.
      if (performance.now() > until || !field.isConnected || fieldOnItsWay()) { end(); return; }
      if (around(document.activeElement)) field.focus({ preventScroll: true }); else end();
    });
  };
  const timer = window.setTimeout(end, HOLD_MS);
  field.addEventListener('focusout', lost);
  document.addEventListener('pointerdown', end, true);
  return end;
}

/** Focus that is nowhere a person put it: the page, the content pane (a navigation's own place) or none. */
const nowhere = (element: Element | null) => !element || element === document.body || element === document.getElementById('content') || element.tagName === 'MAIN';

/**
 * What had the focus when the person last navigated (Back or Forward, a press, an Enter). The page a navigation opens is drawn
 * after its reads, so its arrival focus can come late: by then the person may have moved on (F-026 §4: arrival focus never takes focus the
 * person moved themselves).
 */
let focusAtNavigation: Element | null = null;
/** Whether the person has moved the focus themselves since then (a key that moves it, or a press): the page's own focus moves do not count. */
let movedSinceNavigation = false;
const MOVING_KEYS = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'F6']);
let navigationWatched = false;
function watchNavigation() {
  if (navigationWatched || typeof window === 'undefined') return;
  navigationWatched = true;
  const note = () => { focusAtNavigation = document.activeElement; movedSinceNavigation = false; };
  window.addEventListener('popstate', note, true);
  // A press or an Enter is what navigates (a link, a row, New message's search): the focus then is where it was asked from.
  document.addEventListener('click', note, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') note();
    else if (MOVING_KEYS.has(event.key)) movedSinceNavigation = true;
  }, true);
  document.addEventListener('pointerdown', () => { movedSinceNavigation = true; }, true);
}
if (typeof window !== 'undefined') watchNavigation();

function focusFieldBy(find: () => HTMLElement | null, arrival = false): () => void {
  waitForField();
  let frame = 0;
  let release: (() => void) | null = null;
  // An arrival's focus (F-026 §4) never takes focus the person moved themselves since they navigated: only from nowhere, from what had it when
  // they navigated, or from where the page itself put it (a panel opening).
  const attempt = () => {
    const field = find();
    const active = document.activeElement;
    if (arrival && movedSinceNavigation && active !== field && active !== focusAtNavigation && !nowhere(active)) {
      // The person went on (Tab to a chip, a link or a button while the conversation was still being drawn): the arrival leaves them there.
      frame = 0; fieldDue = 0;
      return;
    }
    if (field && document.activeElement !== field) {
      field.focus({ preventScroll: true });
      // At the end of what it holds (a kept draft): typing goes on from there, never in front of it (persona round 27, P2 3).
      if (document.activeElement === field && (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement)) {
        const end = field.value.length;
        try { field.setSelectionRange(end, end); } catch { /* a field with no selection */ }
      }
    }
    // The field has focus (perhaps it had it already, and no focus came to end the wait): keys are its own from now on.
    if (field && document.activeElement === field) {
      frame = 0; fieldDue = 0;
      // On a touch screen the sheet the field is in may still be opening around it.
      if (window.matchMedia('(hover: none)').matches) release = holdFocus(field);
      return;
    }
    if (!fieldOnItsWay()) { frame = 0; return; }
    frame = requestAnimationFrame(attempt);
  };
  attempt();
  return () => {
    release?.();
    if (!frame) return;
    cancelAnimationFrame(frame);
    fieldDue = 0;
  };
}

/**
 * The one rule for arriving in a conversation on a computer (persona round 26, P2 #2): a space, a direct message or a thread opened from
 * anywhere (the sidebar, New message, a person's name, Home) puts the cursor in its composer, as joining does. Focus left on the link that
 * was followed, or on the page body, made a sentence typed at once into shortcuts: "can I swap my Friday shift…" in a new direct message
 * opened Create with C and Enter made a task in a shared space. The same for a sidebar row chosen with Enter (round 27, P2 1); only a view
 * tab chosen from the keyboard keeps its focus (Left and Right go on along the tabs, F-026 §4).
 */
export function focusComposerOnArrival(id: string): () => void {
  const active = typeof document === 'undefined' ? null : document.activeElement;
  // A view tab chosen from the keyboard keeps the focus, so Left and Right go on along the tabs (F-026 §4); one clicked is a press on a link
  // to the conversation (`watchConversationLinks`).
  if (active instanceof Element && active.closest(KEYBOARD_ROWS) && !fieldOnItsWay()) return () => undefined;
  return focusFieldBy(() => document.getElementById(id), true);
}

/** Where a keyboard choice keeps its focus: the view tabs. */
const KEYBOARD_ROWS = '[role="tab"]';

/** The address of a conversation as a link names it: a space (its conversation), a thread, a direct message or an agent's chat. */
const CONVERSATION_PATH = /^\/(?:projects\/[^/]+(?:\/conversations\/[^/]+)?|dm\/[^/]+|agents\/[^/]+)\/?$/;

/**
 * A press on a link to a conversation on a computer is a field on its way (`awaitField`): the conversation puts the cursor in its composer
 * once it is drawn (`focusComposerOnArrival`), and what is typed in between (WebKit leaves focus on the page as the link is followed) is
 * kept for it, never a shortcut. A link that names a message or opens an object (`#message-…`, `?open=…`) is not one: the message takes the
 * focus. Neither is the direct message already open, which does not open again. A person's name (the direct message with them) is one.
 * Returns the cleanup.
 */
export function watchConversationLinks(): () => void {
  const onClick = (event: MouseEvent) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (window.matchMedia('(hover: none)').matches) return;
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!(link instanceof HTMLAnchorElement) || (link.target && link.target !== '_self') || link.origin !== window.location.origin) return;
    // A person's name opens the direct message with them (`/dm/new?with=…`), made at once when there is none.
    const direct = link.pathname === '/dm/new' && new URLSearchParams(link.search).has('with');
    if (!direct && (link.hash || link.search || !CONVERSATION_PATH.test(link.pathname))) return;
    if (!link.pathname.startsWith('/projects/') && link.pathname === window.location.pathname) return;
    // Enter on a view tab (no pointer) keeps the focus there (F-026 §4 underline tabs).
    if (event.detail === 0 && link.closest(KEYBOARD_ROWS)) return;
    awaitField();
  };
  document.addEventListener('click', onClick, true);
  return () => document.removeEventListener('click', onClick, true);
}

/**
 * A message a link or a return arrives at takes focus (F-026 rule 6), but never from a field the person is typing in or a field on its way:
 * an Inbox Reply lands on the mention and in the reply field, and the field keeps the focus.
 */
export function focusArrival(element: HTMLElement) {
  if (isTyping(document.activeElement)) return;
  element.focus({ preventScroll: true });
}

const FOCUSABLE = 'a[href], button, input:not([type="hidden"]), textarea, select, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
/** A control a person can be put on: still in the page, shown, enabled and not behind a window. */
function usable(element: Element | null | undefined): element is HTMLElement {
  return element instanceof HTMLElement && element.isConnected && !(element as HTMLButtonElement).disabled && element.getAttribute('aria-hidden') !== 'true'
    && !element.closest('[inert], [hidden]') && element.getClientRects().length > 0;
}
/** Up to `count` controls before or after `from` in the page's order, as they are now. */
function neighbours(from: Element, forward: boolean, count: number): HTMLElement[] {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  walker.currentNode = from;
  const found: HTMLElement[] = [];
  for (let step = 0; step < 600 && found.length < count; step += 1) {
    const node = forward ? walker.nextNode() : walker.previousNode();
    if (!node) break;
    if (node instanceof HTMLElement && !from.contains(node) && !node.contains(from) && node.matches(FOCUSABLE) && usable(node)) found.push(node);
  }
  return found;
}

/**
 * Never the page itself (F-026 §4 "After an action removes what had focus", persona round 27): when what had focus goes away under it (Add
 * people, Undo in a toast, Z, Propose decision, New map, Esc from a panel opened with the mouse) and nothing else took the focus, it goes to
 * the next control where it was (the next row of the same list), else the one before it, else back to where the person was before (a toast's
 * Undo gives it back to the control that made the change), else the nearest place still there. A press elsewhere, a new page, or a window
 * that is open is left alone. Returns the cleanup.
 */
/** A window, a calendar or a menu is open and owns the focus and Esc; one that is closing (the Create window after `/task`) no longer does. */
export function windowOrMenuOpen(): boolean {
  if (document.querySelector('.ui-overlay[data-state="open"], [role="menu"]:not([inert])')) return true;
  return [...document.querySelectorAll('[role="dialog"]')].some((dialog) => dialog.id !== 'details' && !dialog.closest('[inert], .ui-overlay[data-state="closing"]'));
}

export function watchLostFocus(): () => void {
  let last: { element: Element; place: string; next: HTMLElement[]; previous: HTMLElement[]; ancestors: Element[] } | null = null;
  let before: Element[] = [];
  let timer = 0;
  const place = () => `${window.location.pathname}${window.location.search}`;
  const onFocusIn = (event: FocusEvent) => {
    const element = event.target;
    if (!(element instanceof Element) || element === document.body) return;
    if (last && last.element !== element) before = [last.element, ...before.filter((item) => item !== last!.element && item !== element)].slice(0, 6);
    const ancestors: Element[] = [];
    for (let up = element.parentElement; up && up !== document.body && ancestors.length < 8; up = up.parentElement) ancestors.push(up);
    last = { element, place: place(), next: neighbours(element, true, 2), previous: neighbours(element, false, 2), ancestors };
  };
  const onPointer = () => { last = null; };
  const check = () => {
    timer = 0;
    const active = document.activeElement;
    // Still there (a toast fading out): asked again when it goes.
    if (!last || (active && active !== document.body) || usable(last.element)) return;
    if (last.place !== place()) { last = null; return; }
    // A window, a calendar or a menu that is open owns the focus while it is there; asked again when it goes.
    if (windowOrMenuOpen()) return;
    const kept = last;
    last = null;
    const ancestor = kept.ancestors.find((element) => element.isConnected && element !== document.getElementById('root'));
    const near = [...kept.next, ...kept.previous].find((element) => usable(element) && !!ancestor?.contains(element));
    const inside = ancestor ? [...ancestor.querySelectorAll(FOCUSABLE)].find((element) => usable(element)) : undefined;
    const target = near ?? before.find(usable) ?? inside ?? document.getElementById('content');
    target?.focus({ preventScroll: true });
  };
  // After the others have had their turn (a window or a panel hands focus back at once, a field asked for takes it within frames).
  const soon = () => { if (!timer && last) timer = window.setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(check)), 150); };
  const observer = new MutationObserver(soon);
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled', 'hidden', 'inert'] });
  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('pointerdown', onPointer, true);
  return () => {
    observer.disconnect();
    window.clearTimeout(timer);
    document.removeEventListener('focusin', onFocusIn, true);
    document.removeEventListener('pointerdown', onPointer, true);
  };
}
