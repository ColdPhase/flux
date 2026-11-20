// Pinned messages (C-74, #1615; founder decision, Hubert, 2026-11-20). One rule: a pin belongs to the conversation, and everyone in it sees
// the same list. It is not a personal bookmark. Every conversation has one list: a space (its stream and its threads), a direct message (a
// group too) and a person's chat with their own agent. Whoever may write in the conversation may pin and unpin; a reader sees the list; an
// agent never pins and reads the list with `flux_list_pinned`. Pinning notifies nobody, writes no line and makes no Inbox item: the stream's
// event (ids only) tells the open screens to read the list again.
import type { AgentColour } from './agents.js';
import type { MessageFile } from './files.js';

/** The conversation a list belongs to: a space, a direct message, or the chat with one of the caller's agents. */
export type PinPlace = { type: 'project'; id: string } | { type: 'dm'; id: string } | { type: 'agent'; id: string };

/** In an agent's chat a request and its answer are one run: which of the two a pin names (`?part=` of the pin's address). */
export type PinPart = 'prompt' | 'answer';
export const PIN_PARTS: readonly PinPart[] = ['prompt', 'answer'];

/** The newest pins a list answers; a conversation keeps more only in theory. */
export const PIN_LIST_LIMIT = 200;

/** `GET` the list, newest pin first. */
export const pinsPath = (place: PinPlace) => place.type === 'project' ? `/api/v1/projects/${place.id}/pins`
  : place.type === 'dm' ? `/api/v1/dms/${place.id}/pins` : `/api/v1/agent-chats/${place.id}/pins`;
/** `PUT` pins the message, `DELETE` unpins it; both answer the list. Pinning a pinned message and unpinning one that is not pinned change nothing. */
export const pinPath = (place: PinPlace, messageId: string, part?: PinPart) => `${pinsPath(place)}/${messageId}${part ? `?part=${part}` : ''}`;

/** One pinned message as everyone in the conversation sees it. */
export interface PinnedMessage {
  /** The message: a space's or a direct message's message, or in an agent's chat its run (with `part`) or one of its lines. */
  messageId: string;
  part?: PinPart;
  /** A space's message: the conversation it belongs to (the root's thread). */
  conversationId?: string;
  /** Present for a reply in a thread: the thread's root message. The list says "in a thread" and the message opens in its thread. */
  threadRootId?: string;
  author: { kind: 'human' | 'agent'; id: string; name: string; colour?: AgentColour };
  /** The message's words (an encrypted space's, opened as its stream is); empty for a message of files alone. */
  body: string;
  /** Its files, each shown as its chip. */
  files?: MessageFile[];
  createdAt: string;
  pinnedBy: { id: string; name: string };
  pinnedAt: string;
}

export interface PinnedMessages { items: PinnedMessage[] }

/**
 * The stream's events of a changed list: object the space, the direct message, or the agent's owner (the chat is theirs alone), data
 * `{ messageId }` (and `agentId` for a chat). Ids only, which is all an encrypted space allows.
 */
export const PINS_CHANGED_EVENTS = { project: 'project.pins_changed.v1', dm: 'dm.pins_changed.v1', agent: 'person.pins_changed.v1' } as const;
