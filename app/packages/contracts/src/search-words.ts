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

/**
 * A word written with a hyphen is one word to search (v0.2.1 personas round: "mockup" did not find "mock-up"): the hyphens between two
 * letters or digits go, so "mock-up", "mock‐up" and "mockup" are the same word. The BM25 index holds the same joined form of every title
 * and body (migration 0085, `flux_joined_words`, the same rule in SQL), and the in-memory index of an encrypted space indexes it too.
 */
export function joinHyphenatedWords(text: string): string {
  return text.replace(/([\p{L}\p{N}])[-‐‑]+(?=[\p{L}\p{N}])/gu, '$1');
}

/**
 * The little words of English and Polish that join a sentence and say nothing of what it is about ("the", "by", "w", "na"), folded
 * as `foldSearchWord` folds them. People's search of several words (⌘K, persona round 6: "barrel by the shed" listed 20 messages that held
 * only "the" or "by") does not list a hit that holds only these of its words while the search has other words; a search of these words
 * alone still finds them. Both the BM25 statement and the in-memory index of encrypted workspaces read this one list.
 */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has', 'have', 'i', 'if', 'in', 'into', 'is', 'it', 'its',
  'me', 'my', 'of', 'on', 'or', 'our', 'so', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'to',
  'us', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'will', 'with', 'you', 'your',
  'aby', 'ale', 'albo', 'bo', 'by', 'czy', 'dla', 'do', 'i', 'ich', 'ja', 'jak', 'jest', 'juz', 'lub', 'na', 'nad', 'o', 'od', 'po',
  'pod', 'przez', 'przy', 'sa', 'sie', 'ta', 'tak', 'te', 'to', 'tu', 'w', 'we', 'z', 'za', 'ze',
]);

export function isSearchStopWord(word: string): boolean {
  return STOP_WORDS.has(foldSearchWord(word));
}
