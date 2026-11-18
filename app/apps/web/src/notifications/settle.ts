/**
 * One press, one action (F-026 §7 Inbox, personas-34 P2 3). An action that takes the open item out of the Inbox (Accept, Done, Not now,
 * Approve all, an answer, Unblock) swaps its neighbour in at once, under the pointer and under the keys: the second click of a double-click,
 * a double tap or a key pressed twice landed on that neighbour and acted on an item nobody had looked at. For a moment after such an action
 * every Inbox action does nothing, until the person chooses an item themselves (J, K, a click on a row) or takes the action back (Undo, Z).
 */
export const SETTLE_MS = 450;

let until = 0;

/** True while the item that swapped in after an action is still too new to act on. */
export const inboxSettling = () => performance.now() < until;

/** An action took the open item out: its neighbour takes no action for a moment. */
export const inboxActed = () => { until = performance.now() + SETTLE_MS; };

/** The person chose what is open (J, K, a click on a row) or took the action back: the next action is theirs at once. */
export const inboxSettled = () => { until = 0; };
