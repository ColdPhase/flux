import type { Conversation, ObjectNotice } from '@flux/contracts';

/** Replies by id in sequence order: a newer read of a reply replaces the copy already shown. */
export function mergeMessages(current: Conversation['messages'], incoming: Conversation['messages']) {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.sequence - b.sequence);
}

export type FeedEntry =
  | { type: 'message'; key: string; at: string; message: Conversation['messages'][number] }
  | { type: 'object'; key: string; at: string; notice: ObjectNotice };

/**
 * Messages and what came of them in one chronological feed. While earlier messages are not loaded,
 * what came of them before the first loaded message waits with them.
 */
export function feedEntries(messages: Conversation['messages'], hasOlder: boolean, objects: ObjectNotice[] = []): FeedEntry[] {
  const first = messages[0]?.createdAt ?? null;
  const entries: FeedEntry[] = [
    ...messages.map((message) => ({ type: 'message' as const, key: message.id, at: message.createdAt, message })),
    ...objects.filter((notice) => !hasOlder || !first || notice.createdAt >= first)
      .map((notice) => ({ type: 'object' as const, key: `object-${notice.id}`, at: notice.createdAt, notice })),
  ];
  const rank = { message: 0, object: 1 } as const;
  return entries.sort((a, b) => a.at.localeCompare(b.at) || rank[a.type] - rank[b.type]);
}
