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

export function rememberAskedConversation(userId: string, projectId: string, conversationId: string) {
  try { localStorage.setItem(key(userId), JSON.stringify({ projectId, conversationId })); } catch { /* the chooser lists recent conversations instead */ }
}
