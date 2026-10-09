import { ApiError } from '../api/client';
import { acceptDecision } from '../work/api';

/**
 * Accept with Undo (#342, F-026 S9/S11). A decision cannot be un-accepted (O-009 DA-3: a change of
 * direction is a new proposal), so "Accepted · Undo" is a delayed command: the card shows accepted at
 * once, the command is sent when the Undo window ends, and Undo within it simply never sends it.
 * Nothing is lost by leaving: leaving the page (navigation, hiding the tab, closing it) sends every
 * waiting accept at once, with `keepalive` so the browser finishes it after the page is gone.
 */

/** How long Undo is offered. */
export const ACCEPT_UNDO_MS = 6000;

export type AcceptOutcome = 'accepted' | 'conflict' | 'failed';

interface Waiting {
  decision: { id: string; version: number };
  /** One idempotency key per intent, so a resend after a lost answer never accepts twice. */
  key: string;
  timer: ReturnType<typeof setTimeout>;
  settle: (outcome: AcceptOutcome) => void;
}

const waiting = new Map<string, Waiting>();
/** Decisions being accepted by this person, from the click until the server answered. */
const accepting = new Set<string>();
export const acceptingIds = (): ReadonlySet<string> => accepting;

async function send(entry: Waiting, keepalive: boolean) {
  try {
    await acceptDecision(entry.decision, {}, entry.key, keepalive);
    accepting.delete(entry.decision.id);
    entry.settle('accepted');
  } catch (error) {
    accepting.delete(entry.decision.id);
    // Someone else decided first, or the decision changed: nothing was accepted by this click.
    entry.settle(error instanceof ApiError && (error.status === 409 || error.status === 404 || error.status === 403) ? 'conflict' : 'failed');
  }
}

/** Starts the delayed accept of one decision; `undo()` cancels it while it still waits. */
export function startAccept(decision: { id: string; version: number }, settle: (outcome: AcceptOutcome) => void, delay = ACCEPT_UNDO_MS) {
  const existing = waiting.get(decision.id);
  if (existing) { clearTimeout(existing.timer); waiting.delete(decision.id); accepting.delete(decision.id); }
  const entry: Waiting = {
    decision, key: crypto.randomUUID(), settle,
    timer: setTimeout(() => { waiting.delete(decision.id); void send(entry, false); }, delay),
  };
  waiting.set(decision.id, entry);
  accepting.add(decision.id);
  return {
    /** True when the accept had not been sent yet and now never will be. */
    undo(): boolean {
      if (waiting.get(decision.id) !== entry) return false;
      clearTimeout(entry.timer);
      waiting.delete(decision.id);
      accepting.delete(decision.id);
      return true;
    },
  };
}

/** Sends every waiting accept now. Called when the person leaves the place that showed them. */
export function flushAccepts(keepalive = false) {
  for (const [id, entry] of [...waiting]) {
    clearTimeout(entry.timer);
    waiting.delete(id);
    void send(entry, keepalive);
  }
}

export const hasWaitingAccepts = () => waiting.size > 0;

if (typeof window !== 'undefined') {
  // The page is being left or hidden: finish what was said, in a request the browser keeps alive.
  window.addEventListener('pagehide', () => flushAccepts(true));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushAccepts(true); });
}
