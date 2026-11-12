import { addressesIn, joinsAddress } from './web-addresses.js';

// What a model writes around its answer that Flux's own list makes noise (#1222, founder decision 2026-11-12): citation marks that point at
// nothing Flux supplied, and a "Sources:" block that repeats the addresses Flux lists under the answer anyway. Both are taken out when the
// answer is stored, on every engine, so every reader (the asker's card, a posted message, a later run's context) reads the same words.

/** Text between code (a fence, or a span on one line) is never changed: `items[0]` and a literal "[1]" in code stay. */
const CODE = /(```[\s\S]*?```|`[^`\n]*`)/;

/** One mark: `[8]`, `[S3]` (numbers from 1: `items[0]` is never one); a run of them (`[1][2]`, `[1] [2]`) is one place the model cited. A list, `[S1, S2]`, is one mark too. */
const MARK = String.raw`(?:\[(?:S[1-9]\d{0,2}|[1-9]\d{0,2})\]|\[S[1-9]\d{0,2}(?:[ \t]*,[ \t]*S?[1-9]\d{0,2})+\])`;
const RUN = new RegExp(String.raw`([ \t]?)(${MARK}(?:[ \t]?${MARK})*)([ \t]?)`, 'g');
/** ChatGPT-style marks, `【3†source】`: never a sentence's own text. */
const LENTICULAR = /[ \t]?【[^】\n]{0,80}】/g;
const SENTENCE_END = /[.,;:!?…)"”’»]/;
const WORD = /[\p{L}\p{N}_]/u;

/**
 * The answer without the citation marks no source Flux supplied answers to: `[8]`, `[S2]`, `[S1, S2]` and `【3†source】`, in the text and not
 * in code. `labels` holds the supplied sources' labels (`S1`, …) of an API-key run, whose marks the commit turns into `[1]`, `[2]` after this
 * (`parseOutput`); the CLI engines supply none, so every mark of theirs is the model's own. A bare number is never a supplied source's mark at
 * this point. A mark stands only where one is written: after a space, at the start of a line, after a sentence's punctuation or right after a
 * word and before its punctuation ("published[8]."); `items[0].name`, `arr[1] is` and a mark inside a web address stay. A mark taken out never
 * joins the text on its sides into a web address that was not there (#1149): then a space stands in its place.
 */
export function withoutInventedMarks(text: string, labels: ReadonlySet<string> = new Set()): string {
  if (!text.includes('[') && !text.includes('【')) return text;
  const taken = (gap: string) => text.split(CODE).map((part, index) => (index % 2 ? part : part
    .replace(LENTICULAR, gap)
    .replace(RUN, (match, lead: string, run: string, trail: string, at: number, whole: string) => {
      // A run holding a supplied source's label is the commit's to number (`parseOutput`).
      if ([...run.matchAll(/\[S(\d{1,3})\]/g)].some((found) => labels.has(`S${found[1]}`))) return match;
      const markAt = at + lead.length;
      if (!placed(whole, markAt, run.length)) return match;
      // At the start of a line the space after the mark goes with it; elsewhere the one before it does.
      return !lead && (markAt === 0 || whole[markAt - 1] === '\n') ? gap : `${gap}${trail}`;
    }))).join('');
  const plain = taken('');
  return joinsAddress(text, plain) ? taken(' ') : plain;
}

/** Whether the marks `whole.slice(at, at + length)` stand where a model cites (see `withoutInventedMarks`). */
function placed(whole: string, at: number, length: number): boolean {
  const before = whole[at - 1] ?? '\n';
  const after = whole[at + length] ?? '';
  if (/\S*$/.exec(whole.slice(0, at))![0].includes('://')) return false;
  // The mark ends a sentence, a line or the text: "[8].", "[8] and", "[8]" ; never "[8].name", "[8](x)" or "[8]=".
  const ends = after === '' || after === '\n' || after === ' ' || after === '\t' || (SENTENCE_END.test(after) && !WORD.test(whole[at + length + 1] ?? ''));
  if (before === '\n') return after !== ':' && ends;
  // Glued to a word, a mark needs a sentence's punctuation or the end of the line after it: "published[8]." but not "arr[1] is".
  if (WORD.test(before)) return ends && after !== ' ' && after !== '\t';
  return ends;
}

/** The headings of a model's own list of sources, alone on their line. */
const OWN_HEADING = /^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*|__)?[ \t]*(?:sources?(?: used| cited)?|references?|citations?|bibliography|further reading|links|źródła|źródło|zrodla|linki|literatura|quellen|fuentes|sources)[ \t]*:?[ \t]*(?:\*\*|__)?[ \t]*:?[ \t]*(.*)$/i;

/**
 * The answer without a trailing "Sources:" (or "Źródła:", "References:", …) block of the model's own when Flux lists everything in it anyway
 * (#1222): the heading, then only lines that each name a web address, all of them addresses in `listed` (normalized, as `addressesIn` gives
 * them). A block with a line that names none (a source in words only), or an address Flux does not list, stays whole: that is the model's
 * information, not Flux's list again. An answer that is only such a block is left as it is.
 */
export function withoutOwnSources(answer: string, listed: ReadonlySet<string>): string {
  if (!listed.size) return answer;
  const lines = answer.split('\n');
  for (let at = lines.length - 1; at >= 0; at--) {
    const heading = OWN_HEADING.exec(lines[at]!);
    if (!heading) continue;
    const rest = [heading[1]!, ...lines.slice(at + 1)].filter((line) => line.trim());
    const named = rest.map((line) => addressesIn(line));
    if (!rest.length || named.some((found) => !found.length || found.some((address) => !listed.has(address)))) return answer;
    // A rule above the block (`---`) is part of it.
    const before = lines.slice(0, at).join('\n').trimEnd().replace(/(?:^|\n)[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/, '').trimEnd();
    return before ? before : answer;
  }
  return answer;
}
