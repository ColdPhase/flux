import { RUN_TEXT_PIECE_CHARS } from '@flux/contracts';
import type { RunLiveText, RunRecord } from './ports.js';
import { redactSecrets } from './redaction.js';

// The asker's live view of a run (#1248): the words the agent writes, sent to the run's owner over the live stream as they come, at
// most one batch about every 150 ms, and the Flux tool it uses now. Nothing here is stored: the run's answer is still the final text,
// cleaned at the end. What is sent is what a reader may see of the words so far: token-shaped strings removed (AG-11), and a word only
// once it is complete, so a secret never shows half-typed before the pattern that removes it can match. When the removal changes text
// already sent, the piece starts where the two differ (`at`), and the client cuts its text there.

/** How often the asker's view is sent the new words (#1248). */
export const LIVE_TEXT_MS = 150;

export interface LiveText {
  /** The agent starts another turn (`n`, or the next one): its words start again. */
  turn(n?: number): void;
  /** More of the current turn's words, as the model wrote them. */
  push(delta: string): void;
  /** The Flux tool the agent uses now, for the working line. */
  step(tool: string): void;
  /** The current turn's words so far, whole and as the model wrote them (for a stop that keeps them). */
  readonly written: string;
  /** The asker may no longer see the run (#1248): nothing more is sent, not even what is gathered; the words stop growing. */
  abandon(): void;
  /** Sends what is gathered, then no more pieces; resolves once they are delivered. */
  close(): Promise<void>;
}

/** The longest piece that does not end inside a UTF-16 surrogate pair. */
function pieces(text: string): string[] {
  const out: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + RUN_TEXT_PIECE_CHARS);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    out.push(text.slice(start, end));
    start = end;
  }
  return out;
}

/** Up to and including the last white space: the words that are complete. */
function completeWords(text: string): string {
  const match = /\s(?=\S*$)/.exec(text);
  return match ? text.slice(0, match.index + 1) : '';
}

export function liveText(port: RunLiveText | undefined, run: Pick<RunRecord, 'id' | 'ownerUserId'>,
  options: { intervalMs?: number; secrets?: readonly string[]; now?: () => number } = {}): LiveText {
  const { intervalMs = LIVE_TEXT_MS, secrets = [], now = Date.now } = options;
  let turn = 0;
  let raw = '';
  let sent = '';
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last = 0;
  let chain: Promise<void> = Promise.resolve();
  const deliver = (piece: Parameters<RunLiveText['send']>[1]) => {
    if (!port) return;
    chain = chain.then(() => port.send(run.ownerUserId, piece)).catch(() => undefined);
  };
  const flush = () => {
    timer = null;
    if (closed) return;
    last = now();
    const shown = redactSecrets(completeWords(raw), secrets).text;
    let at = 0;
    const same = Math.min(shown.length, sent.length);
    while (at < same && shown.charCodeAt(at) === sent.charCodeAt(at)) at += 1;
    if (at === shown.length && at === sent.length) return;
    sent = shown;
    const rest = shown.slice(at);
    if (!rest) { deliver({ runId: run.id, turn, at, text: '' }); return; }
    let offset = at;
    for (const text of pieces(rest)) {
      deliver({ runId: run.id, turn, at: offset, text });
      offset += text.length;
    }
  };
  return {
    turn(n) {
      const next = n ?? turn + 1;
      if (next === turn) return;
      if (timer) { clearTimeout(timer); timer = null; }
      turn = next;
      raw = '';
      sent = '';
    },
    push(delta) {
      if (closed || !delta) return;
      if (turn === 0) turn = 1;
      raw += delta;
      if (!port || timer) return;
      timer = setTimeout(flush, Math.max(0, last + intervalMs - now()));
      (timer as { unref?: () => void }).unref?.();
    },
    step(tool) {
      if (!closed) deliver({ runId: run.id, step: tool });
    },
    get written() { return raw; },
    abandon() {
      closed = true;
      if (timer) { clearTimeout(timer); timer = null; }
    },
    async close() {
      // The words gathered since the last batch go out first: the answer follows them.
      if (timer && !closed) { clearTimeout(timer); flush(); }
      closed = true;
      await chain;
    },
  };
}
