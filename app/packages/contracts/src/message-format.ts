import { LINK_URL_SOURCE } from './conversation.js';

// The text of a message, read (#1247, F-026 §6): the one parser of the small Markdown subset that a message, a direct message, a thread
// reply, a task's discussion, an agent's chat and an agent's answer share. It reads text and returns plain data: the web app turns the
// data into React elements (never into HTML), the server turns it into the plain words of a preview. The stored body is never changed.
//
// The subset, and nothing else:
//   inline   `**bold**`, `*italic*`, `` `code` ``
//   block    a fenced code block (``` on its own line), `- ` and `1. ` lists, `> ` quotes (an attribution line "Name:" first)
// Headings, tables, images, links written as `[text](url)`, HTML and `_`/`~` marks stay as the text that was typed.

export type MessageInline =
  | { kind: 'text'; text: string }
  | { kind: 'bold' | 'italic'; children: MessageInline[] }
  | { kind: 'code'; text: string };

export type MessageBlock =
  /** Lines of text with their line breaks, as typed. */
  | { kind: 'text'; inline: MessageInline[] }
  /** `author` is the first line when it reads "Name:", else null. */
  | { kind: 'quote'; author: string | null; inline: MessageInline[] }
  /** One level: an indented item is an item of the same list. `start` is the number the first item was written with. */
  | { kind: 'list'; ordered: boolean; start: number; items: MessageInline[][] }
  /** `lang` is the first word after the opening fence (```js), when it is a short name. */
  | { kind: 'code'; text: string; lang: string | null };

/** Marks nested deeper than this stay as typed. */
const MAX_DEPTH = 4;

const WORD = /[\p{L}\p{N}]/u;
/** Scripts written without spaces between words: a mark may stand right against them. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;
const SPACE = /\s/;
const isWord = (char: string | undefined) => char !== undefined && WORD.test(char) && !UNSPACED.test(char);
const isSpace = (char: string | undefined) => char === undefined || SPACE.test(char);

const URL_AT = new RegExp(LINK_URL_SOURCE, 'y');
const WIKI_AT = /\[\[[^\]\n]{1,120}\]\]/y;

/** The length of a web address or a `[[Wiki page]]` that starts at `at`: either is read as it is, so its marks are never formatting. */
function atomLength(text: string, at: number): number {
  const char = text[at];
  if (char === 'h' && (text.startsWith('http://', at) || text.startsWith('https://', at))) {
    URL_AT.lastIndex = at;
    return URL_AT.exec(text)?.[0].length ?? 0;
  }
  if (char === '[' && text[at + 1] === '[') {
    WIKI_AT.lastIndex = at;
    return WIKI_AT.exec(text)?.[0].length ?? 0;
  }
  return 0;
}

/** A code span that opens with the backtick run at `at` and closes with the next run of the same length; none when it never closes. */
function codeSpan(text: string, at: number): { text: string; end: number } | null {
  let open = at;
  while (text[open] === '`') open++;
  const width = open - at;
  for (let k = open; k < text.length; k++) {
    if (text[k] !== '`') continue;
    let close = k;
    while (text[close] === '`') close++;
    if (close - k === width) {
      const inner = text.slice(open, k);
      // One space on each side is the way to write a span that starts or ends with a backtick; it is not part of the code.
      const padded = inner.length > 2 && inner.startsWith(' ') && inner.endsWith(' ') && inner.trim() !== '';
      return { text: padded ? inner.slice(1, -1) : inner, end: close };
    }
    k = close - 1;
  }
  return null;
}

const runOfStars = (text: string, at: number) => { let end = at; while (text[end] === '*') end++; return end - at; };

/** A run of stars at `at` of `width` that may open a mark: not glued to a word before it and followed by something that is not a space. */
const opens = (text: string, at: number, width: number) => !isWord(text[at - 1]) && !isSpace(text[at + width]);
/** A run that may close one: right after something that is not a space and not glued to a word after it. */
const closes = (text: string, at: number, width: number) => at > 0 && !isSpace(text[at - 1]) && !isWord(text[at + width]);

/** Where the marks `delimiter` opened before `from` close, or -1. Code spans, addresses and `[[pages]]` are skipped as they are; a mark inside the text opens and closes on its own. */
function findClose(text: string, from: number, delimiter: string, failed: Map<string, number>, nest = 0): number {
  const known = failed.get(delimiter);
  if (known !== undefined && from >= known) return -1;
  for (let k = from; k < text.length;) {
    const char = text[k];
    if (char === '`') {
      const span = codeSpan(text, k);
      if (span) { k = span.end; continue; }
      while (text[k] === '`') k++;
      continue;
    }
    const atom = atomLength(text, k);
    if (atom) { k += atom; continue; }
    if (char !== '*') { k++; continue; }
    const run = runOfStars(text, k);
    if (k > from && run >= delimiter.length && closes(text, k, run)) return k;
    if (nest < MAX_DEPTH && opens(text, k, run)) {
      // A mark opened inside this one: skip to where it closes, if it does.
      const width = Math.min(run, 2);
      const inner = findClose(text, k + width, '*'.repeat(width), failed, nest + 1);
      if (inner >= 0) { k = inner + width; continue; }
    }
    k += run;
  }
  failed.set(delimiter, Math.min(failed.get(delimiter) ?? from, from));
  return -1;
}

/** One line of text, or several, as marks and text. */
export function parseInline(text: string, depth = 0): MessageInline[] {
  const out: MessageInline[] = [];
  let pending = '';
  const flush = () => { if (pending) { out.push({ kind: 'text', text: pending }); pending = ''; } };
  const failed = new Map<string, number>();
  for (let i = 0; i < text.length;) {
    const char = text[i]!;
    if (char === '`') {
      const span = codeSpan(text, i);
      if (span) { flush(); out.push({ kind: 'code', text: span.text }); i = span.end; continue; }
      let end = i;
      while (text[end] === '`') end++;
      pending += text.slice(i, end); i = end;
      continue;
    }
    const atom = atomLength(text, i);
    if (atom) { pending += text.slice(i, i + atom); i += atom; continue; }
    if (char !== '*') { pending += char; i++; continue; }
    const run = runOfStars(text, i);
    if (depth < MAX_DEPTH && opens(text, i, Math.min(run, 3))) {
      if (run >= 3) {
        const close = findClose(text, i + 3, '***', failed);
        if (close >= 0) {
          flush();
          out.push({ kind: 'bold', children: [{ kind: 'italic', children: parseInline(text.slice(i + 3, close), depth + 2) }] });
          i = close + 3;
          continue;
        }
      }
      if (run >= 2) {
        const close = findClose(text, i + 2, '**', failed);
        if (close >= 0) { flush(); out.push({ kind: 'bold', children: parseInline(text.slice(i + 2, close), depth + 1) }); i = close + 2; continue; }
        pending += text.slice(i, i + run); i += run;
        continue;
      }
      const close = findClose(text, i + 1, '*', failed);
      if (close >= 0) { flush(); out.push({ kind: 'italic', children: parseInline(text.slice(i + 1, close), depth + 1) }); i = close + 1; continue; }
    }
    pending += text.slice(i, i + run); i += run;
  }
  flush();
  return out;
}

const FENCE_OPEN = /^ {0,3}(`{3,})([^`]*)$/;
const QUOTE = /^>\s?/;
const BULLET = /^[ \t]*- +(\S.*)$/;
const NUMBERED = /^[ \t]*(\d{1,3})\. +(\S.*)$/;
const INDENTED = /^(?: {2,}|\t)\S/;

type Run = { kind: 'lines'; lines: string[] } | MessageBlock;

/** The blocks of a message body, in order. A body with none of the marks is one text block, exactly as typed. */
export function parseMessage(body: string): MessageBlock[] {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const runs: Run[] = [];
  let text: string[] = [];
  const endText = () => { if (text.length) { runs.push({ kind: 'lines', lines: text }); text = []; } };
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!;
    const fence = FENCE_OPEN.exec(line);
    if (fence && i + 1 < lines.length) {
      // The block ends at a line of at least as many backticks, or with the message: a fence is never left open for the next one.
      const close = new RegExp(`^ {0,3}\`{${fence[1]!.length},}[ \\t]*$`);
      let end = i + 1;
      while (end < lines.length && !close.test(lines[end]!)) end++;
      endText();
      const lang = /^[\w+#.-]{1,20}$/.exec(fence[2]!.trim().split(/\s+/)[0] ?? '')?.[0] ?? null;
      runs.push({ kind: 'code', text: lines.slice(i + 1, end).join('\n'), lang });
      i = end + 1;
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) quoted.push(lines[i++]!.replace(QUOTE, ''));
      const first = quoted[0] ?? '';
      const author = /^.{1,120}:$/.test(first) ? first.slice(0, -1) : null;
      endText();
      runs.push({ kind: 'quote', author, inline: parseInline((author ? quoted.slice(1) : quoted).join('\n')) });
      continue;
    }
    const item = BULLET.exec(line) ?? NUMBERED.exec(line);
    if (item) {
      const ordered = NUMBERED.test(line) && !BULLET.test(line);
      const kind = ordered ? NUMBERED : BULLET;
      const items: string[] = [];
      const start = ordered ? Number(NUMBERED.exec(line)![1]) : 1;
      while (i < lines.length) {
        const here = kind.exec(lines[i]!);
        if (here) { items.push(here[here.length - 1]!); i++; continue; }
        // A line indented under an item continues it; a blank line between two items of the list keeps it going.
        if (items.length && INDENTED.test(lines[i]!) && !BULLET.test(lines[i]!) && !NUMBERED.test(lines[i]!)) { items[items.length - 1] += `\n${lines[i]!.trim()}`; i++; continue; }
        let next = i;
        while (next < lines.length && lines[next]!.trim() === '') next++;
        if (next > i && next < lines.length && kind.test(lines[next]!)) { i = next; continue; }
        break;
      }
      endText();
      runs.push({ kind: 'list', ordered, start, items: items.map((entry) => parseInline(entry)) });
      continue;
    }
    text.push(line);
    i++;
  }
  endText();
  return runs.map((run, index): MessageBlock => {
    if (run.kind !== 'lines') return run;
    // Beside another block a paragraph gives up its blank edge lines: the block's own margin separates them.
    let part = run.lines;
    if (index > 0) while (part.length && part[0]!.trim() === '') part = part.slice(1);
    if (index < runs.length - 1) while (part.length && part[part.length - 1]!.trim() === '') part = part.slice(0, -1);
    return { kind: 'text', inline: parseInline(part.join('\n')) };
  }).filter((block) => !(block.kind === 'text' && !block.inline.length && runs.length > 1));
}

const inlineText = (nodes: MessageInline[]): string => nodes.map((node) => (node.kind === 'text' || node.kind === 'code' ? node.text : inlineText(node.children))).join('');

/**
 * What a reader sees, as plain text and with none of the marks: `**bold**` is bold, a fence is its code, a quote has no `>` and keeps
 * its attribution line, a list keeps "- " and "1. ". Previews, notifications and Copy text use it; nothing is added to the words.
 */
export function plainMessageText(body: string): string {
  return parseMessage(body).map((block) => {
    switch (block.kind) {
      case 'text': return inlineText(block.inline);
      case 'quote': return [block.author === null ? null : `${block.author}:`, inlineText(block.inline)].filter((line) => line !== null).join('\n');
      case 'list': return block.items.map((entry, index) => `${block.ordered ? `${block.start + index}.` : '-'} ${inlineText(entry)}`).join('\n');
      case 'code': return block.text;
    }
  }).join('\n');
}
