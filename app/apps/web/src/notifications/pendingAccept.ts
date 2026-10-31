import { ApiError } from '../api/client.js';
import { whenPageLive, pageLeaving } from '../api/pageLeaving.js';
import { acceptDecision } from '../work/api.js';

/**
 * Accept and answer with Undo (#342, F-026 S9/S11/S14). A decision cannot be un-accepted (O-009 DA-3: a change of
 * direction is a new proposal), and an agent's question is answered once (its reply is the person's message), so
 * "Accepted · Undo" and "Answered · Undo" are delayed commands: the card leaves at once, the command is sent when the
 * Undo window ends, and Undo within it simply never sends it. Nothing is lost by leaving: leaving the page (navigation,
 * hiding the tab, closing it) sends every waiting command at once, with `keepalive` so the browser finishes it after the
 * page is gone.
 */

/** How long Undo is offered. */
export const ACCEPT_UNDO_MS = 6000;

export type AcceptOutcome = 'accepted' | 'conflict' | 'failed';

interface Waiting {
  /** `decision:<id>` or `question:<id>`. */
  id: string;
  /** One idempotency key per intent, so a resend after a lost answer never applies twice. */
  key: string;
  run: (key: string, keepalive: boolean) => Promise<unknown>;
  timer: ReturnType<typeof setTimeout>;
  /** Set while the Undo window has ended on a page being left: stops waiting for the page to be live. */
  held?: () => void;
  settle: (outcome: AcceptOutcome) => void;
}

const waiting = new Map<string, Waiting>();
/** Decisions being accepted and questions being answered by this person, from the click until the server answered. */
const accepting = new Set<string>();
const answering = new Set<string>();
export const acceptingIds = (): ReadonlySet<string> => accepting;
export const answeringIds = (): ReadonlySet<string> => answering;

/** The set a waiting command is listed in; a held proposal (`proposal:<key>`) is in none. */
const listOf = (kind: string) => (kind === 'decision' ? accepting : kind === 'question' ? answering : null);
const release = (id: string) => {
  const [kind, value] = id.split(':') as [string, string];
  listOf(kind)?.delete(value);
};

/**
 * The Undo window ended. On a page being left the request would wait for the page to be live (#471), and
 * if the page is then unloaded it would be lost, so the command stays listed: the leaving flush sends it
 * with `keepalive`, and a page that stays sends it once it is live again.
 */
function dispatch(entry: Waiting) {
  if (waiting.get(entry.id) !== entry) return;
  if (pageLeaving()) { entry.held = whenPageLive(() => dispatch(entry)); return; }
  waiting.delete(entry.id);
  void send(entry, false);
}

async function send(entry: Waiting, keepalive: boolean) {
  try {
    await entry.run(entry.key, keepalive);
    release(entry.id);
    entry.settle('accepted');
  } catch (error) {
    release(entry.id);
    // Someone else decided first, the decision changed or the question was answered: nothing was applied by this click.
    entry.settle(error instanceof ApiError && (error.status === 409 || error.status === 404 || error.status === 403) ? 'conflict' : 'failed');
  }
}

function start(id: string, run: Waiting['run'], settle: (outcome: AcceptOutcome) => void, delay: number) {
  const existing = waiting.get(id);
  if (existing) { clearTimeout(existing.timer); existing.held?.(); waiting.delete(id); release(id); }
  const entry: Waiting = { id, key: crypto.randomUUID(), run, settle, timer: setTimeout(() => dispatch(entry), delay) };
  waiting.set(id, entry);
  const [kind, value] = id.split(':') as [string, string];
  listOf(kind)?.add(value);
  return {
    /** True when the command had not been sent yet and now never will be. */
    undo(): boolean {
      if (waiting.get(id) !== entry) return false;
      clearTimeout(entry.timer);
      entry.held?.();
      waiting.delete(id);
      release(id);
      return true;
    },
  };
}

/** Starts the delayed accept of one decision; `undo()` cancels it while it still waits. */
export function startAccept(decision: { id: string; version: number }, settle: (outcome: AcceptOutcome) => void, delay = ACCEPT_UNDO_MS) {
  return start(`decision:${decision.id}`, (key, keepalive) => acceptDecision(decision, {}, key, keepalive), settle, delay);
}

/**
 * Starts the delayed answer of an agent's question with one of its ready-made answers (S14): `answer` sends it with the
 * intent's idempotency key. `undo()` cancels it while it waits.
 */
export function startAnswer(questionId: string, answer: (key: string, keepalive: boolean) => Promise<unknown>, settle: (outcome: AcceptOutcome) => void, delay = ACCEPT_UNDO_MS) {
  return start(`question:${questionId}`, answer, settle, delay);
}

/**
 * Starts a held proposal of a decision (#763 WF-3): "Decision proposed · Undo" for the same window, and it reaches the
 * people who can accept it (their Inbox) only when the window ends. `undo()` cancels it while it waits.
 */
export function startProposal(propose: (key: string, keepalive: boolean) => Promise<unknown>, settle: (outcome: AcceptOutcome) => void, delay = ACCEPT_UNDO_MS) {
  return start(`proposal:${crypto.randomUUID()}`, propose, settle, delay);
}

/** Sends every waiting command now. Called when the person leaves the place that showed them. */
export function flushAccepts(keepalive = false) {
  for (const [id, entry] of [...waiting]) {
    clearTimeout(entry.timer);
    entry.held?.();
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
