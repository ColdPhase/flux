/** The five owner-only sentences of F-027 AST-7. Labels are product copy; ids never appear in the UI. */
export const ASSISTANT_REACTION_EVENTS = [
  { id: 'assigned', label: 'a new task is assigned to me', actions: ['tell', 'suggest_plan', 'plan'] },
  { id: 'blocked', label: 'one of my tasks is blocked', actions: ['tell', 'suggest_fix', 'next_steps'] },
  { id: 'failed_result', label: 'a result fails on my task', actions: ['tell', 'suggest_fix'] },
  { id: 'mentioned', label: 'someone mentions me', actions: ['tell', 'draft_reply'] },
  { id: 'pr_ready', label: 'a pull request is ready on my task', actions: ['tell', 'check_task'] },
] as const;
export type AssistantReactionEvent = typeof ASSISTANT_REACTION_EVENTS[number]['id'];
export type AssistantReactionAction = typeof ASSISTANT_REACTION_EVENTS[number]['actions'][number];
export const ASSISTANT_REACTION_ACTIONS: Record<AssistantReactionAction, string> = {
  tell: 'tell me', suggest_plan: 'suggest a plan', plan: 'plan it', suggest_fix: 'suggest a fix', next_steps: 'add next steps', draft_reply: 'draft a reply', check_task: 'check it against the task',
};
export interface AssistantReaction {
  id: string; workspaceId: string; projectId: string; projectName: string; event: AssistantReactionEvent; action: AssistantReactionAction;
  enabled: boolean; dailyLimit: number; version: number;
  last: { line: string; at: string } | null;
}
export interface SaveAssistantReaction {
  projectId: string; event: AssistantReactionEvent; action: AssistantReactionAction; enabled: boolean; dailyLimit?: number; expectedVersion?: number; noteVersion?: string;
}
export const assistantReactionsPath = (workspaceId: string, ownerId: string) => `/api/v1/workspaces/${workspaceId}/people/${ownerId}/assistant/when`;
export const assistantReactionPath = (workspaceId: string, ownerId: string, id: string) => `${assistantReactionsPath(workspaceId, ownerId)}/${id}`;
export const assistantReactionsHistoryPath = (workspaceId: string, ownerId: string) => `${assistantReactionsPath(workspaceId, ownerId)}/history`;
export const assistantReactionDraftPath = (notificationId: string) => `/api/v1/inbox/${notificationId}/assistant-draft`;
export interface AssistantReplyDraft { ownerUserId: string; body: string; projectId: string; conversationId: string; url: string }

export interface AssistantReactionRecent { id: string; at: string; line: string; name: string }
