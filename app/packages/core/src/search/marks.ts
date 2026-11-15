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
  // The text as one string with a mark for each character: the statement's marks, then the words this marks. A hyphenated word is
  // judged whole, across the statement's parts ("mock" of "mock-up" marked by the statement's `mock:*`, the rest here).
  const text = parts.map((part) => part.text).join('');
  const marked: boolean[] = [];
  for (const part of parts) for (let i = 0; i < part.text.length; i++) marked.push(part.match);
  const mark = (from: number, length: number) => { for (let i = from; i < from + length; i++) marked[i] = true; };
  for (const compound of text.matchAll(COMPOUND)) {
    const joined = joinHyphenatedWords(compound[0]);
    if (joined !== compound[0] && matches(joined)) { mark(compound.index, compound[0].length); continue; }
    for (const token of compound[0].matchAll(TOKEN)) if (matches(token[0])) mark(compound.index + token.index, token[0].length);
  }
  const out: SearchText = [];
  for (let i = 0; i < text.length; i++) {
    const last = out[out.length - 1];
    if (last && last.match === marked[i]) last.text += text[i];
    else out.push({ text: text[i]!, match: marked[i]! });
  }
  return out;
}
