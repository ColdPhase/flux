import { AGENT_SUMMARY_LIMITS } from '@flux/contracts';
import { InvalidInputError } from '../access/errors.js';
import { agentSearchTime } from './agent.js';

// `flux_summarize` (F-042, AG-12, #1292): what was said in one place in a range of time, as a compact digest that the calling agent
// summarises itself, in its own run, so that its owner pays and nothing is stored. Core states what a range, a page and a cursor are and
// how a message reads in the digest; the server decides, on every call, which place the caller may read (never this file).

/** What the tool is asked, as the model writes it, before anything is checked. */
export interface AgentSummaryInput {
  /** A date (`2026-09-01`, from midnight UTC) or a time with its offset: the range starts here, this moment included. */
  after: string;
  /** The same: the range ends here, this moment not included. */
  before?: string | undefined;
  /** The `next` an earlier answer gave: where to go on. */
  next?: string | undefined;
}

export interface SummaryRange { since: Date; until: Date | null; cursor: SummaryCursor | null }

/** Where an answer stopped: the stored time of the last message read (PostgreSQL's text, with its microseconds) and its id. */
export interface SummaryCursor { at: string; id: string }

const CURSOR = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d{1,6})?[+-]\d\d(?::?\d\d)?)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export const summaryCursorText = (cursor: SummaryCursor) => `${cursor.at}|${cursor.id}`;

/** The range of a call, refused in words the model can fix. */
export function summaryRange(input: AgentSummaryInput): SummaryRange {
  const since = agentSearchTime(input.after, 'after');
  const until = input.before ? agentSearchTime(input.before, 'before') : null;
  if (until && since >= until) throw new InvalidInputError('after must be earlier than before', 'INVALID_TIME');
  let cursor: SummaryCursor | null = null;
  if (input.next) {
    const match = CURSOR.exec(input.next.trim());
    if (!match) throw new InvalidInputError('next is the next of an earlier answer of this tool, passed back as it was given', 'INVALID_CURSOR');
    cursor = { at: match[1]!, id: match[2]! };
  }
  return { since, until, cursor };
}

/** One message as the digest tells it. */
export interface DigestMessage {
  id: string;
  at: Date;
  /** PostgreSQL's own text of the stored time, for the cursor: a `Date` keeps milliseconds, a row has microseconds. */
  atKey: string;
  /** Who wrote it, as people see them in this place (#1160): never the stored name. */
  author: string;
  text: string;
  files: number;
  /** What a task's contribution is, when it is more than text: a blocker, a handoff or what came of it. */
  contribution?: 'blocker' | 'handoff' | 'came_of_it';
  /** A space's main conversation only: the thread the message is in and its opening words, null when its author deleted them. */
  thread?: { id: string; opening: string | null };
}

export interface DigestPage {
  digest: string;
  count: number;
  /** The last message in the digest: the page ends here. */
  last: DigestMessage | null;
}

/** A message on one line: a line break in it would let its text pass as another message of the digest, so it is a visible mark. */
function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ⏎ ').replace(/[^\S\n]{2,}/g, ' ').trim();
}

const cut = (text: string, chars: number) => {
  const letters = [...text];
  return letters.length > chars ? { text: letters.slice(0, chars).join('').trimEnd(), more: letters.length - chars } : { text, more: 0 };
};

/**
 * The digest of these messages, oldest first, as many as fit one answer: a heading for each day (UTC), one for each thread of a space's
 * main conversation where the thread changes, and a line for each message, "10:02 Ada Nowak: words". A message that is longer than
 * `messageChars` is cut and says how much is left and which tool reads it whole. At least one message is always given.
 */
export function digestPage(messages: readonly DigestMessage[], limits: { pageChars: number; messageChars: number; pageMessages: number } = AGENT_SUMMARY_LIMITS): DigestPage {
  const lines: string[] = [];
  let chars = 0; let count = 0; let day = ''; let thread: string | undefined; let last: DigestMessage | null = null;
  for (const message of messages) {
    const block: string[] = [];
    const date = message.at.toISOString().slice(0, 10);
    if (date !== day) block.push(`## ${date}`);
    if (message.thread && message.thread.id !== thread) block.push(`# thread ${message.thread.opening ? `“${cut(oneLine(message.thread.opening), 80).text}”` : '(its opening message was deleted)'}`);
    const body = cut(oneLine(message.text), limits.messageChars);
    const text = [...(message.contribution ? [`[${message.contribution.replace(/_/g, ' ')}]`] : []), body.text, ...(message.files ? [`[${message.files === 1 ? '1 file' : `${message.files} files`}]`] : []),
      ...(body.more ? [`… (+${body.more} characters; flux_read_around with messageId ${message.id} reads it whole)`] : [])].filter(Boolean).join(' ');
    block.push(`${message.at.toISOString().slice(11, 16)} ${oneLine(message.author) || 'Unknown'}: ${text}`);
    const size = block.reduce((sum, line) => sum + line.length + 1, 0);
    if (count > 0 && (chars + size > limits.pageChars || count >= limits.pageMessages)) break;
    lines.push(...block);
    chars += size; count += 1; day = date; thread = message.thread?.id ?? thread; last = message;
  }
  return { digest: lines.join('\n'), count, last };
}

/** What the answer says about where it stopped and how to go on, in words a model follows. */
export function summaryNote(page: DigestPage, remaining: number, range: SummaryRange): string {
  if (!page.count) return 'No messages in this range. Say so; do not guess what was said.';
  if (!remaining) return `These are all the messages from ${range.since.toISOString()}${range.until ? ` until ${range.until.toISOString()}` : ' on'}. Summarise them now.`;
  return `Stopped early: this answer ends at ${page.last!.at.toISOString()} and ${remaining} later message${remaining === 1 ? ' is' : 's are'} not in it. `
    + 'To go on, call this tool again with the same arguments and next. Summarise what you have read so far in your own words and add what the rest says; '
    + 'if you do not read on, say that the summary stops at that time.';
}
