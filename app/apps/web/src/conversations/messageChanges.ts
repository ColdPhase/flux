import type { ConversationMessage } from '@flux/contracts';
import { editMessage, removeMessage } from './api';

// A message its author edited or deleted (#1006), announced once it is stored: the lists that hold it (the stream's roots, an open
// thread, a direct message and its thread) replace it by id, so the author sees the change at once and nobody reads the whole list
// again. Other people's tabs learn of it from the stream's `project.message_edited.v1`, `project.message_removed.v1` and their `dm.` twins events.
type Listener = (message: ConversationMessage) => void;
const listeners = new Set<Listener>();

export function announceMessageChanged(message: ConversationMessage) {
  for (const listener of [...listeners]) listener(message);
}

export function onMessageChanged(listener: Listener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** What saving and deleting a space's message does for its author: store it, then announce the stored message (#1006). */
export function projectMessageEdits(message: { id: string; conversationId: string }) {
  return {
    save: async (body: string) => announceMessageChanged(await editMessage(message.conversationId, message.id, body)),
    remove: async () => announceMessageChanged(await removeMessage(message.conversationId, message.id)),
  };
}
