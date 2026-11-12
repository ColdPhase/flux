
// What the ask bar remembers on this device: whether Home's old set-up card was dismissed, and how often the assistant was used.
// Connecting AI in Settings gives a person their Assistant (F-036 AG-1), so there is no set-up card on Home any more.

const key = (userId: string) => `flux.meet-assistant.${userId}`;
export const meetAssistantDismissed = (userId: string) => { try { return localStorage.getItem(key(userId)) === '1'; } catch { return false; } };

// What the assistant suggests in the `/` menu, under `/ai` (#1224): only what fits the place, understand first and then act, until it has
// been used three times (Journey 1 step 5). A direct message has none.
const usesKey = (userId: string) => `flux.assistant-uses.${userId}`;
export const assistantUses = (userId: string) => { try { return Number(localStorage.getItem(usesKey(userId))) || 0; } catch { return 0; } };
export const noteAssistantUse = (userId: string) => { try { localStorage.setItem(usesKey(userId), String(assistantUses(userId) + 1)); } catch { /* shown again */ } };

export type SuggestionPlace = 'thread' | 'space' | 'task' | 'dm';
const SUGGESTIONS: Record<SuggestionPlace, readonly string[]> = {
  thread: ['Catch me up on this thread', 'Turn this thread into tasks'],
  space: ['Catch me up', 'Tidy this space\'s tasks'],
  task: ['Summarise this task', 'What\'s left?'],
  dm: [],
};

/** The suggestions of a place; none once the person has used the assistant three times, or while it is not ready to be asked. */
export const assistantSuggestions = (place: SuggestionPlace, userId: string, ready: boolean): readonly string[] => ready && assistantUses(userId) < 3 ? SUGGESTIONS[place] : [];
