import type { AssistantAnswer, Conversation, ObjectNotice } from '@flux/contracts';

/** Replies by id in sequence order: a newer read of a reply replaces the copy already shown. */
export function mergeMessages(current: Conversation['messages'], incoming: Conversation['messages']) {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.sequence - b.sequence);
}

export type FeedEntry =
  | { type: 'message'; key: string; at: string; message: Conversation['messages'][number] }
  | { type: 'answer'; key: string; at: string; answer: AssistantAnswer }
  | { type: 'object'; key: string; at: string; notice: ObjectNotice };

/**
 * Messages and committed assistant answers in one chronological feed. While earlier messages
 * are not loaded, answers from before the first loaded message wait with them.
 */
export function feedEntries(messages: Conversation['messages'], answers: AssistantAnswer[], hasOlder: boolean, objects: ObjectNotice[] = []): FeedEntry[] {
  const first = messages[0]?.createdAt ?? null;
  const entries: FeedEntry[] = [
    ...messages.map((message) => ({ type: 'message' as const, key: message.id, at: message.createdAt, message })),
    ...answers.filter((answer) => !hasOlder || !first || answer.committedAt >= first)
      .map((answer) => ({ type: 'answer' as const, key: `answer-${answer.runId}`, at: answer.committedAt, answer })),
    ...objects.filter((notice) => !hasOlder || !first || notice.createdAt >= first)
      .map((notice) => ({ type: 'object' as const, key: `object-${notice.id}`, at: notice.createdAt, notice })),
  ];
  const rank = { message: 0, object: 1, answer: 2 } as const;
  return entries.sort((a, b) => a.at.localeCompare(b.at) || rank[a.type] - rank[b.type]);
}
