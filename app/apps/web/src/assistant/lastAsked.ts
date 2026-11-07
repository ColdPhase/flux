// The conversation the person last asked their assistant in (F-027 AST-10 Journey 2, step 9): "Ask my assistant…" outside a
// conversation lists it first. Per person and browser; nothing is sent anywhere.

const key = (userId: string) => `flux.assistant-last-asked.${userId}`;
export interface AskedConversation { projectId: string; conversationId: string }

export function lastAskedConversation(userId: string): AskedConversation | null {
  try {
    const value = JSON.parse(localStorage.getItem(key(userId)) ?? 'null') as Partial<AskedConversation> | null;
    return value && typeof value.projectId === 'string' && typeof value.conversationId === 'string' ? { projectId: value.projectId, conversationId: value.conversationId } : null;
  } catch { return null; }
}

// A run that ended because AI was turned off in its space says so in its thread until the person dismisses it (AG-10). The dismissal is
// per person and browser, like the line itself is per person; nothing is sent anywhere.
const dismissedKey = (userId: string) => `flux.assistant-ai-off-dismissed.${userId}`;
export function aiOffDismissed(userId: string, runId: string): boolean {
  try { return (JSON.parse(localStorage.getItem(dismissedKey(userId)) ?? '[]') as unknown[]).includes(runId); } catch { return false; }
}
export function dismissAiOff(userId: string, runId: string) {
  try { localStorage.setItem(dismissedKey(userId), JSON.stringify([...(JSON.parse(localStorage.getItem(dismissedKey(userId)) ?? '[]') as string[]), runId].slice(-50))); }
  catch { /* the line comes back after a reload; dismissing it again is enough */ }
}

export function rememberAskedConversation(userId: string, projectId: string, conversationId: string) {
  try { localStorage.setItem(key(userId), JSON.stringify({ projectId, conversationId })); } catch { /* the chooser lists recent conversations instead */ }
}
