import { pinPath, pinsPath, type PinnedMessages, type PinPart, type PinPlace } from '@flux/contracts';
import { request } from '../api/client';

// Pinned messages (C-74, #1615): the conversation's list, and pinning or unpinning one message; both changes answer the list.

export const getPins = (place: PinPlace, signal?: AbortSignal) => request<PinnedMessages>(pinsPath(place), { signal }).then((list) => list.items);
export const setPin = (place: PinPlace, messageId: string, part: PinPart | undefined, pinned: boolean) =>
  request<PinnedMessages>(pinPath(place, messageId, part), { method: pinned ? 'PUT' : 'DELETE' }).then((list) => list.items);
