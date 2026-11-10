
// What the ask bar remembers on this device: whether Home's old set-up card was dismissed, and how often the assistant was used.
// Connecting AI in Settings gives a person their Assistant (F-036 AG-1), so there is no set-up card on Home any more.

const key = (userId: string) => `flux.meet-assistant.${userId}`;
export const meetAssistantDismissed = (userId: string) => { try { return localStorage.getItem(key(userId)) === '1'; } catch { return false; } };

// Three suggestions for this place, shown only where the assistant can work, until it has been used three times (Journey 1 step 5).
const usesKey = (userId: string) => `flux.assistant-uses.${userId}`;
export const assistantUses = (userId: string) => { try { return Number(localStorage.getItem(usesKey(userId))) || 0; } catch { return 0; } };
export const noteAssistantUse = (userId: string) => { try { localStorage.setItem(usesKey(userId), String(assistantUses(userId) + 1)); } catch { /* shown again */ } };
const SUGGESTIONS = ['Catch me up', 'Turn this thread into tasks', 'Tidy this space\'s tasks'];

export function AssistantSuggestions({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="assistant-suggestions" role="group" aria-label="Suggestions for your assistant" data-ai-surface="assistant-suggestions">
      {SUGGESTIONS.map((text) => <button key={text} type="button" className="assistant-suggestions__chip" onClick={() => onPick(text)}>{text}</button>)}
    </div>
  );
}
