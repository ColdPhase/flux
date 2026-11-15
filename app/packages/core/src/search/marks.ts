import { foldSearchWord, joinHyphenatedWords, searchWordStem, type SearchText } from '@flux/contracts';

// Which words of a result's text the BM25 search found it by (F-042, #1293). The statement marks what its snippet query names; this marks
// the rest, so a result reads the way it matched: a word the query names in another form ("czujnik" and "czujników", "calibrate" and
// "calibrated"), with its accents ("piatek" and "piątek") or as far as it was typed ("compar" and "comparison").

const TOKEN = /[\p{L}\p{N}]+/gu;
/** A word with its hyphens ("mock-up"): marked whole when its joined form is what the query names ("mockup"), else word by word. */
const COMPOUND = /[\p{L}\p{N}]+(?:[-\u2010\u2011]+[\p{L}\p{N}]+)*/gu;

/** The words and the word being typed that a text is marked by. `typing` is the last word, when the query ends in a letter or digit. */
export interface SearchMarks { words: readonly string[]; typing: string | null }

/** The plain parts of a text, split so that every word the query names, in any longer form or accent, is a matched part of its own. */
export function markSearchWords(parts: SearchText, marks: SearchMarks): SearchText {
  const named = marks.words.map((word) => ({ word: foldSearchWord(word), stem: searchWordStem(word) }));
  const typed = marks.typing ? foldSearchWord(marks.typing) : null;
  const matches = (token: string) => {
    const folded = foldSearchWord(token);
    return named.some(({ word, stem }) => folded === word || (stem !== word && folded.startsWith(stem))) || (typed !== null && folded.startsWith(typed));
  };
  const out: SearchText = [];
  const push = (text: string, match: boolean) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.match === match) last.text += text;
    else out.push({ text, match });
  };
  for (const part of parts) {
    if (part.match) { push(part.text, true); continue; }
    let from = 0;
    for (const compound of part.text.matchAll(COMPOUND)) {
      const at = compound.index;
      push(part.text.slice(from, at), false);
      from = at + compound[0].length;
      const joined = joinHyphenatedWords(compound[0]);
      if (joined !== compound[0] && matches(joined)) { push(compound[0], true); continue; }
      let inner = 0;
      for (const token of compound[0].matchAll(TOKEN)) {
        push(compound[0].slice(inner, token.index), false);
        push(token[0], matches(token[0]));
        inner = token.index + token[0].length;
      }
      push(compound[0].slice(inner), false);
    }
    push(part.text.slice(from), false);
  }
  return out;
}
