import { addressesIn, joinsAddress } from './web-addresses.js';

// What a model writes around its answer that Flux's own list makes noise (#1222, founder decision 2026-11-12): citation marks that point at
// nothing Flux supplied, and a "Sources:" block that repeats the addresses Flux lists under the answer anyway. Both are taken out when the
// answer is stored, on every engine, so every reader (the asker's card, a posted message, a later run's context) reads the same words.
// Everything here is linear in the text (no nested or repeated whitespace quantifiers, no scan back to the start of a line): an answer of
// 100 000 characters is steered by web content, and the model's text must never stall the process (CodeQL js/polynomial-redos).

/** Text between code (a fence, or a span on one line) is never changed: `items[0]` and a literal "[1]" in code stay. */
const CODE = /(```[\s\S]*?```|`[^`\n]*`)/;

/** One mark: `[8]`, `[S3]` (numbers from 1: `items[0]` is never one). A list, `[S1, S2]`, is one mark too. */
const NUMBER = String.raw`[1-9]\d{0,2}`;
const MARK = String.raw`(?:\[S?${NUMBER}\]|\[S${NUMBER}(?:,[ \t]?S${NUMBER})+\])`;
const RUN = new RegExp(String.raw`([ \t]?)(${MARK}(?:[ \t]?${MARK})*)([ \t]?)`, 'g');
/** ChatGPT-style marks, `【3†source】`: never a sentence's own text. */
const LENTICULAR = /[ \t]?【[^】\n]{0,80}】/g;
/** A web address as the mark check sees one: a run of non-blank characters that starts with a scheme. */
const WEB = /https?:\/\/\S+/gi;
const SENTENCE_END = /[.,;:!?…)"”’»]/;
const FULL_STOP = /[.!?…]/;
const WORD = /[\p{L}\p{N}_]/u;

/** Words that make a bracketed number the writer's own reference ("option [1]", "step [2]"), not a citation. */
const REFERENCE_WORDS = new Set(['option', 'options', 'step', 'steps', 'item', 'items', 'section', 'sections', 'figure', 'fig', 'table', 'point', 'points',
  'case', 'cases', 'line', 'lines', 'page', 'pages', 'chapter', 'number', 'key', 'press', 'version', 'no']);
/** What stands between two of the writer's own references: "[1] or [2]", "[1], [2]", "[1] and/or [2]". */
const BETWEEN_REFERENCES = /^(?:[,;/][ \t]?|[ \t])?(?:(?:or|and|nor|and\/or)[ \t]+)?$/i;

/**
 * The answer without the citation marks no source Flux supplied answers to: `[8]`, `[S2]`, `[S1, S2]` and `【3†source】`, in the text and not
 * in code. `labels` holds the supplied sources' labels (`S1`, …) of an API-key run, whose marks the commit turns into `[1]`, `[2]` after this
 * (`parseOutput`): a mark or a list of them keeps the supplied ones (`[S1, S9]` becomes `[S1]`, `[S1, S2]` becomes `[S1][S2]`) and loses the
 * rest; the CLI engines supply none, so every mark of theirs is the model's own. A bare number is never a supplied source's mark at this
 * point. A mark stands only where one is written: after a space, at the start of a line, after a sentence's punctuation or right after a
 * word and before the sentence's end ("published[8]."). Not a mark: `items[0].name`, `arr[1] is`, `sum(a[1], a[2])`, a mark inside a web
 * address, and the writer's own reference after a word such as "option" ("Choose option [1] or [2]."). A mark taken out never joins the
 * text on its sides into a web address that was not there (#1149): then a space stands in its place.
 */
export function withoutInventedMarks(text: string, labels: ReadonlySet<string> = new Set()): string {
  if (!text.includes('[') && !text.includes('【')) return text;
  const taken = (gap: string) => text.split(CODE).map((part, index) => (index % 2 ? part : marksOut(part, gap, labels))).join('');
  const plain = taken('');
  return joinsAddress(text, plain) ? taken(' ') : plain;
}

function marksOut(part: string, gap: string, labels: ReadonlySet<string>): string {
  const text = part.replace(LENTICULAR, gap);
  // The addresses are found once, so a mark inside one is told in a step and not by looking back along the text.
  const addresses = [...text.matchAll(WEB)].map((found) => [found.index, found.index + found[0].length] as const);
  let at = 0;
  let keptEnd = -1;
  return text.replace(RUN, (match, lead: string, run: string, trail: string, offset: number, whole: string) => {
    // The supplied sources' marks of the run stay (the commit numbers them); the rest of it goes.
    const supplied = [...run.matchAll(/\[([^\]]*)\]/g)].flatMap((found) => found[1]!.split(',').map((label) => label.trim())).filter((label) => labels.has(label));
    if (supplied.length) return `${lead}${supplied.map((label) => `[${label}]`).join('')}${trail}`;
    const markAt = offset + lead.length;
    while (at < addresses.length && addresses[at]![1] <= markAt) at++;
    if (at < addresses.length && addresses[at]![0] <= markAt) return match;
    if (!placed(whole, markAt, run.length) || ownReference(whole, markAt, run, keptEnd)) {
      keptEnd = markAt + run.length;
      return match;
    }
    // At the start of a line the space after the mark goes with it; elsewhere the one before it does.
    return !lead && (markAt === 0 || whole[markAt - 1] === '\n') ? gap : `${gap}${trail}`;
  });
}

/** Whether the marks `whole.slice(at, at + length)` stand where a model cites (see `withoutInventedMarks`). */
function placed(whole: string, at: number, length: number): boolean {
  const before = whole[at - 1] ?? '\n';
  const after = whole[at + length] ?? '';
  const next = whole[at + length + 1] ?? '';
  // The mark ends a sentence, a line or the text: "[8].", "[8] and", "[8]"; never "[8].name", "[8](x)" or "[8]=".
  const ends = after === '' || after === '\n' || after === ' ' || after === '\t' || (SENTENCE_END.test(after) && !WORD.test(next));
  if (before === '\n') return after !== ':' && ends;
  // Glued to a word, a mark needs the end of a sentence or of the line after it: "published[8]." but not "arr[1] is" or "sum(a[1], a[2])".
  if (WORD.test(before)) return after === '' || after === '\n' || (FULL_STOP.test(after) && !WORD.test(next));
  return ends;
}

/** The writer's own reference, not a citation: "Choose option [1] or [2].", "Press [1] to continue." (a bare number after a word such as "option"). */
function ownReference(whole: string, at: number, run: string, keptEnd: number): boolean {
  if (run.includes('S')) return false;
  const before = whole[at - 1];
  if (before !== ' ' && before !== '\t') return false;
  if (keptEnd >= 0 && at - keptEnd <= 12 && BETWEEN_REFERENCES.test(whole.slice(keptEnd, at))) return true;
  const word = /(\p{L}{1,12})$/u.exec(whole.slice(Math.max(0, at - 14), at - 1));
  return !!word && REFERENCE_WORDS.has(word[1]!.toLowerCase());
}

/** The headings of a model's own list of sources, longest first. */
const OWN_LABELS = ['sources used', 'sources cited', 'further reading', 'bibliography', 'references', 'reference', 'citations', 'citation', 'literatura', 'sources',
  'source', 'źródła', 'źródło', 'zrodla', 'quellen', 'fuentes', 'linki', 'links'];
/** The longest line that may be part of such a block: an address is at most 2048 characters (`ADDRESS_MAX`), and a title is short. */
const LINE_MAX = 3_000;
const ADDRESS = /https?:\/\/[^\s<>"'`\\^{}|]+/gi;
const MARKER = /^(?:[-*•+–]|\d{1,3}[.)]|\[\d{1,3}\])[ \t]+/;
/** What may stand between listed addresses on a line of addresses only. */
const SEPARATORS = /^[\s,;|•·()<>[\].]*$/;
const CLOSING = /^[\s)\]>.,;]*$/;
const TITLE_MAX = 200;

/** The text after a line that is a heading of the model's own list ("Sources:", "**Źródła**", "## References"), or null when the line is none. */
function headingRest(line: string): string | null {
  if (line.length > LINE_MAX) return null;
  const text = line.trim();
  let i = 0;
  while (i < text.length && i < 6 && text[i] === '#') i++;
  const skip = (from: number) => { let at = from; while (text[at] === ' ' || text[at] === '\t') at++; return at; };
  const emphasis = (from: number) => (text.startsWith('**', from) || text.startsWith('__', from) ? from + 2 : from);
  i = emphasis(skip(i));
  const low = text.slice(i).toLowerCase();
  const label = OWN_LABELS.find((candidate) => low.startsWith(candidate));
  if (!label) return null;
  let j = i + label.length;
  if (j < text.length && WORD.test(text[j]!)) return null;
  j = skip(emphasis(skip(j)));
  if (text[j] === ':') j = skip(emphasis(skip(j + 1)));
  return text.slice(j).trim();
}

/** Whether `text` is listed addresses and nothing else but separators. */
function onlyAddresses(text: string, listed: ReadonlySet<string>): boolean {
  const found = addressesIn(text);
  return found.length > 0 && found.every((address) => listed.has(address)) && SEPARATORS.test(text.replace(ADDRESS, ''));
}

/**
 * Whether one line of a block is a list entry of listed addresses: an address alone, "- Title: address", "1. [Title](address)" or "Title — address",
 * with a short title; a sentence that merely holds an address is prose.
 */
function listedLine(line: string, listed: ReadonlySet<string>): boolean {
  if (line.length > LINE_MAX) return false;
  const text = line.trim();
  const found = addressesIn(text);
  if (!found.length || found.some((address) => !listed.has(address))) return false;
  if (text.replace(ADDRESS, '').length > TITLE_MAX) return false;
  if (MARKER.test(text)) return true;
  const first = text.search(ADDRESS);
  const last = [...text.matchAll(ADDRESS)].at(-1)!;
  return CLOSING.test(text.slice(last.index + last[0].length)) && (first === 0 || /(?:[:–—(-]|\]\()[ \t]*$/.test(text.slice(0, first).trimEnd() + (text[first - 1] === ' ' ? ' ' : '')));
}

/**
 * The answer without a trailing "Sources:" (or "Źródła:", "References:", …) block of the model's own when Flux lists everything in it anyway
 * (#1222): the heading, then to the end of the answer only list entries that each name addresses in `listed` (normalized, as `addressesIn` gives
 * them), with a short title at most. A block that is followed by a paragraph, has a line that is a sentence or names no address, an address
 * Flux does not list, or a heading with words after it ("References: see X and Y for the full analysis") is the model's information, not
 * Flux's list again: the answer stays whole, so nothing the model wrote is ever cut. An answer that is only such a block is left as it is.
 */
export function withoutOwnSources(answer: string, listed: ReadonlySet<string>): string {
  if (!listed.size) return answer;
  const lines = answer.split('\n');
  let named = false;
  for (let at = lines.length - 1; at >= 0; at--) {
    const line = lines[at]!;
    if (!line.trim()) continue;
    const rest = headingRest(line);
    if (rest === null) {
      if (listedLine(line, listed)) { named = true; continue; }
      return answer;
    }
    if (rest ? !onlyAddresses(rest, listed) : !named) return answer;
    // A rule above the block (`---`) is part of it.
    const before = lines.slice(0, at).join('\n').trimEnd().replace(/(?:^|\n)[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/, '').trimEnd();
    return before ? before : answer;
  }
  return answer;
}
