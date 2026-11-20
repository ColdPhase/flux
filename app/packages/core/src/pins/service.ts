import { PIN_LIST_LIMIT, PIN_PARTS, PINS_CHANGED_EVENTS, type PinnedMessage, type PinnedMessages, type PinPart, type PinPlace } from '@flux/contracts';
import { ForbiddenError, InvalidInputError, NotFoundError } from '../access/errors.js';
import { takeAsk } from '../agent-tasks/ask.js';
import { withoutCitationMarks } from '../personal-runs/answer-marks.js';
import type { Principal } from '../principal.js';
import type { PinPorts, PinUnitOfWork } from './ports.js';

// Pinned messages (C-74, #1615; founder decision, Hubert, 2026-11-20). One rule: a pin belongs to the conversation and everyone in it sees
// the same list; it is not a personal bookmark.
//
// - Whoever may write in the conversation may pin and unpin (a guest who may write too); whoever may read it reads the list. In an agent's
//   chat that is its owner alone. Agents never pin: only a signed-in person does, and no MCP tool pins.
// - Pinning a pinned message, and unpinning one that is not pinned, change nothing and record nothing, so a retry is safe.
// - A pin notifies nobody, writes no line and makes no Inbox item. Its one event (ids only) tells the open screens to read the list again.
// - Access is decided on every read: someone who lost the conversation sees nothing of it. A deleted message is never listed.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function placeOf(place: PinPlace): PinPlace {
  if (!place || !['project', 'dm', 'agent'].includes(place.type) || typeof place.id !== 'string' || !UUID.test(place.id)) throw new NotFoundError('Conversation', 'CONVERSATION_NOT_FOUND');
  return { type: place.type, id: place.id.toLowerCase() } as PinPlace;
}

function partOf(place: PinPlace, part: unknown): PinPart | null {
  if (part === undefined || part === null || part === '') return null;
  if (place.type !== 'agent' || !PIN_PARTS.includes(part as PinPart)) throw new InvalidInputError('part is prompt or answer, and only in an agent’s chat');
  return part as PinPart;
}

/** What a list shows of an agent's answer: its words without the question it asked and without its `[n]` source marks, as its chat's line does. */
function shown(item: PinnedMessage & { sources?: number }): PinnedMessage {
  const { sources, ...rest } = item;
  return sources === undefined ? rest : { ...rest, body: withoutCitationMarks(takeAsk(rest.body).body, sources).trim() };
}

export function createPinUseCases(unit: PinUnitOfWork) {
  const list = async (ports: PinPorts, place: PinPlace, workspaceId: string): Promise<PinnedMessages> =>
    ({ items: (await ports.pins.list(place, workspaceId, PIN_LIST_LIMIT)).map(shown) });

  async function change(principal: Principal, rawPlace: PinPlace, messageId: unknown, rawPart: unknown, pin: boolean): Promise<PinnedMessages> {
    if (principal.kind !== 'human') throw new ForbiddenError('Only a person pins a message', 'PIN_NOT_ALLOWED');
    const place = placeOf(rawPlace);
    const part = partOf(place, rawPart);
    if (typeof messageId !== 'string' || !UUID.test(messageId)) throw new NotFoundError('Message', 'MESSAGE_NOT_FOUND');
    return unit.run(async (ports) => {
      const { workspaceId, ownerUserId } = await ports.access.require(principal, place, 'write');
      const target = await ports.pins.target(place, workspaceId, messageId.toLowerCase(), part);
      if (!target) throw new NotFoundError('Message', 'MESSAGE_NOT_FOUND');
      const changed = pin ? await ports.pins.pin(target, principal.id) : await ports.pins.unpin(target);
      const answer = await list(ports, place, workspaceId);
      // Last: recording an event takes the stream's sequence lock. An agent's chat is its owner's alone, so its event is about them.
      if (changed) await ports.events.record(principal, workspaceId, PINS_CHANGED_EVENTS[place.type], place.type === 'agent' ? ownerUserId ?? principal.id : place.id,
        { messageId: target.messageId, ...(place.type === 'agent' ? { agentId: place.id } : {}) });
      return answer;
    });
  }

  return {
    /** The conversation's pinned messages, newest pin first, for whoever may read it now. */
    async list(principal: Principal, rawPlace: PinPlace): Promise<PinnedMessages> {
      const place = placeOf(rawPlace);
      return unit.run(async (ports) => list(ports, place, (await ports.access.require(principal, place, 'read')).workspaceId));
    },
    pin: (principal: Principal, place: PinPlace, messageId: unknown, part?: unknown) => change(principal, place, messageId, part, true),
    unpin: (principal: Principal, place: PinPlace, messageId: unknown, part?: unknown) => change(principal, place, messageId, part, false),
  };
}
