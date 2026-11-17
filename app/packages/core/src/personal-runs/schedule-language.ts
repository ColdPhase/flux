import { ASSISTANT_JOB_LIMITS } from '@flux/contracts';
import { titleFromText } from '../assistant/jobs.js';
import type { ScheduleRequest } from '../assistant/schedule-block.js';

// A schedule's name and instruction are in the language its owner asked in (AG-9). The brief says so, and a real model still wrote one in the
// language of the owner's name and time zone once in four tries (v0.2.1 release gate round 15, ai P2-6). Flux holds it to the rule: when the
// language of what the model prepared is plainly not the one the owner wrote in, the schedule takes the owner's own words instead.

/** The everyday words and letters that tell the languages Flux's people write in apart; a word shared by two counts for both. */
const LANGUAGES: Record<string, { words: ReadonlySet<string>; letters: RegExp }> = {
  en: { words: new Set('the and of to is are for with on that what which me my each every tell give list new open tasks at it from or not this any have still there'.split(' ')), letters: /(?!)/g },
  pl: { words: new Set('i w z na się nie do że jest które który która co jak dla oraz czy każdy każdego każdą mi mnie zadania zadanie otwarte sprawdź wypisz podaj są od po przez lub jeszcze nowe'.split(' ')), letters: /[ąćęłńśźż]/g },
  de: { words: new Set('der die das und ist nicht mit für auf ein eine zu von im den dem mir jeden jede welche sind oder aufgaben noch neue'.split(' ')), letters: /[äöüß]/g },
  fr: { words: new Set('le la les et est des du pour avec une un dans qui que sur chaque moi sont ou tâches encore nouvelles'.split(' ')), letters: /[àâçèêëîïôûœ]/g },
  es: { words: new Set('el la los las y es de del que en un una para con por cada son tareas qué cuáles todavía nuevas'.split(' ')), letters: /[ñ¿¡]/g },
  it: { words: new Set('il lo la gli le e è di che per con un una del della ogni sono attività ancora nuove'.split(' ')), letters: /(?!)/g },
  pt: { words: new Set('o a os as e é de do da que em um uma para com por cada são tarefas ainda novas'.split(' ')), letters: /[ãõ]/g },
  nl: { words: new Set('de het en is van een voor met op niet dat die elke mij zijn of taken nog nieuwe'.split(' ')), letters: /(?!)/g },
};

/** The language a text is plainly written in, or null when it is too short or too mixed to say (or there is no text). */
export function languageOf(text: string | null | undefined): string | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  const words = lower.split(/[^\p{L}]+/u).filter(Boolean);
  const scores = Object.entries(LANGUAGES).map(([code, language]) => {
    const hits = words.filter((word) => language.words.has(word)).length;
    const letters = (lower.match(language.letters) ?? []).length;
    return { code, score: hits + 2 * Math.min(letters, 5) };
  }).sort((a, b) => b.score - a.score);
  const [first, second] = [scores[0]!, scores[1]!];
  return first.score >= 3 && first.score >= 1.5 * second.score ? first.code : null;
}

/**
 * The schedule as it is kept: the model's when both are plainly in one language (or either cannot be told), otherwise the owner's own words as
 * its instruction and its name (their first words, as a schedule without a name takes them), so it is never in a language they did not use.
 */
export function inOwnersLanguage(schedule: ScheduleRequest, ownerWords: string | null | undefined): ScheduleRequest {
  const asked = languageOf(ownerWords);
  const prepared = languageOf(`${schedule.title ?? ''}\n${schedule.text}`);
  if (!ownerWords || !asked || !prepared || asked === prepared) return schedule;
  const text = ownerWords.trim().slice(0, ASSISTANT_JOB_LIMITS.text);
  return { ...schedule, text, title: titleFromText(text) };
}
