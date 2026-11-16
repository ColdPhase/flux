import { ApiError } from '../api/client.js';
import { whenPageLive, pageLeaving } from '../api/pageLeaving.js';

/**
 * An answer with Undo (#342, F-026 S14). A proposal is not held: it reaches everyone at once and its Undo withdraws it (founder decision L,
 * #1424), and neither is Accept: it applies at once and its Undo takes the acceptance back (round 8, #1424, `work/acceptDecision`). An
 * agent's question is answered once (its reply is the person's message), so "Answered · Undo" is a delayed command: the card leaves at
 * once, the command is sent when the Undo window ends, and Undo within it simply never sends it. The window is the Undo toast's (#1424): the command is sent
 * when its toast leaves (`send`, from the toast's `onLeave`: its 10 s, ×, a newer toast, another place). Nothing is lost by
 * leaving: leaving the page (hiding the tab, closing it) sends every waiting command at once, with `keepalive` so the browser
 * finishes it after the page is gone.
 */

export type AcceptOutcome = 'accepted' | 'conflict' | 'failed';

interface Waiting {
  /** `question:<id>`. */
  id: string;
  /** One idempotency key per intent, so a resend after a lost answer never applies twice. */
  key: string;
  run: (key: string, keepalive: boolean) => Promise<unknown>;
  /** Only for a fixed window; a command whose window is its toast's has none and waits for `send`. */
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Set while the Undo window has ended on a page being left: stops waiting for the page to be live. */
  held?: () => void;
  settle: (outcome: AcceptOutcome) => void;
}

const waiting = new Map<string, Waiting>();
/** Questions being answered by this person, from the click until the server answered. */
const answering = new Set<string>();
export const answeringIds = (): ReadonlySet<string> => answering;
/**
 * Decisions being accepted by this person, from the click until the server answered (`work/acceptDecision`): every queue and count of the
 * tab leaves them out meanwhile, so a read that started before the accept never shows the proposal again (#541).
 */
const accepting = new Set<string>();
export const acceptingIds = (): ReadonlySet<string> => accepting;
/** Lists a decision as being accepted; the returned function ends that (once). */
export function holdAccepting(decisionId: string): () => void {
  accepting.add(decisionId);
  changed();
  let ended = false;
  return () => { if (ended) return; ended = true; if (accepting.delete(decisionId)) changed(); };
}

/** Told when a question or decision starts or stops being answered or accepted here: the Inbox count leaves it out at once. */
const changes = new Set<() => void>();
export function onAcceptingChange(listener: () => void) { changes.add(listener); return () => { changes.delete(listener); }; }
function changed() { for (const listener of [...changes]) listener(); }

/** The set a waiting command is listed in. */
const listOf = (kind: string) => (kind === 'question' ? answering : null);
const release = (id: string) => {
  const [kind, value] = id.split(':') as [string, string];
  if (listOf(kind)?.delete(value)) changed();
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
    // The question was answered already or can no longer be: nothing was applied by this click.
    entry.settle(error instanceof ApiError && (error.status === 409 || error.status === 404 || error.status === 403) ? 'conflict' : 'failed');
  }
}

function start(id: string, run: Waiting['run'], settle: (outcome: AcceptOutcome) => void, delay: number | null) {
  const existing = waiting.get(id);
  if (existing) { clearTimeout(existing.timer); existing.held?.(); waiting.delete(id); release(id); }
  const entry: Waiting = { id, key: crypto.randomUUID(), run, settle, timer: undefined };
  if (delay !== null) entry.timer = setTimeout(() => dispatch(entry), delay);
  waiting.set(id, entry);
  const [kind, value] = id.split(':') as [string, string];
  const list = listOf(kind);
  if (list) { list.add(value); changed(); }
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
    /** The window ended (its toast left): sent now, unless it was undone or already sent. */
    send() {
      if (waiting.get(id) !== entry) return;
      clearTimeout(entry.timer);
      dispatch(entry);
    },
  };
}

/**
 * Starts the delayed answer of an agent's question with one of its ready-made answers (S14): `answer` sends it with the
 * intent's idempotency key. `undo()` cancels it while it waits.
 */
export function startAnswer(questionId: string, answer: (key: string, keepalive: boolean) => Promise<unknown>, settle: (outcome: AcceptOutcome) => void, delay: number | null = null) {
  return start(`question:${questionId}`, answer, settle, delay);
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
