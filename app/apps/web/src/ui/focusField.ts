/**
 * No keyboard without a tap, on a touch screen (#1546, founder direction, Hubert, 2026-11-19). A text field the app focuses by itself raises
 * the on-screen keyboard over the screen the person is looking at, so on a touch screen nothing focuses one by itself: not opening a screen,
 * a window or a conversation, not choosing a tab, not a sheet closing. The keyboard comes when the person taps a field, or after an action whose
 * whole point is to write now (Reply, Edit, Rename, Change, Add, a new thought from the map's dot). A computer keeps its focus as it was:
 * keyboard users rely on it.
 *
 * Every focus of a text field that is not a tap goes through here: `autoFocus={writeNow}` or `autoFocus={focusesOnOpen()}` on a field, and
 * `focusToWrite(field)` or `focusOnOpen(field)` in code. ESLint refuses a bare `autoFocus` on a text field, and the touch sweep
 * (app/tests/ui/test_no_keyboard_on_touch.py) opens every screen, window and sheet and asserts that no editable element has focus.
 */

/** Touch-first, as the rest of the app asks it (`MEDIA.touch`): there is no hovering pointer, so a focused field raises the keyboard. */
export const touchFirst = () => typeof window !== 'undefined' && window.matchMedia('(hover: none)').matches;

/** `autoFocus` for a field the person asked to write in now (Edit, Rename, Change, Add): focused on every screen. */
export const writeNow = true;

/** `autoFocus` for a field that is only there because a screen, a window or a tab opened: focused on a computer, never on a touch screen. */
export const focusesOnOpen = () => !touchFirst();

/** Focuses a field the person asked to write in now: on every screen. */
export function focusToWrite(field: HTMLElement | null | undefined, options?: FocusOptions) {
  field?.focus(options);
}

/** Focuses a field that opened with its screen, window or tab: on a computer only. */
export function focusOnOpen(field: HTMLElement | null | undefined, options?: FocusOptions) {
  if (!touchFirst()) field?.focus(options);
}
