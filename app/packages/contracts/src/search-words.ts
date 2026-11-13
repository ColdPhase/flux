/**
 * The words of a search, folded the way the BM25 index folds them (F-042, #1293): lower case with the accents gone ("piątek" is
 * "piatek", "Łódź" is "lodz"). The index's own analyzer folds the words it indexes; a word the statement puts in a pattern (the word a
 * person is still typing) is folded here, so "piat" finds "piątek" and "lod" finds "Łódź".
 */
const LETTERS: Record<string, string> = { ł: 'l', ø: 'o', đ: 'd', ð: 'd', þ: 'th', ß: 'ss', æ: 'ae', œ: 'oe', ı: 'i' };

export function foldSearchWord(word: string): string {
  return word.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[łøđðþßæœı]/gu, (letter) => LETTERS[letter] ?? letter);
}

/**
 * How much of a query word a longer form of it keeps: "czujnik" is also "czujników" and "calibrate" also "calibrated" and
 * "calibration". A word of four or five letters loses its last letter and a longer one its last two; a shorter word is exact. The
 * statement's snippets (`ts_headline` on a prefix) and the result text marks (`markSearchWords`) share this rule.
 */
export function searchWordStem(word: string): string {
  const folded = foldSearchWord(word);
  const letters = [...folded];
  return letters.length >= 6 ? letters.slice(0, -2).join('') : letters.length >= 4 ? letters.slice(0, -1).join('') : folded;
}
