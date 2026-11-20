import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PINS_CHANGED_EVENTS, type PinnedMessage, type PinPart, type PinPlace } from '@flux/contracts';
import { useStreamEvents } from '../api/stream';
import { getPins, setPin } from './api';
import { useToast } from '../ui';

// Pinned messages (C-74, #1615): one list per conversation, the same for everyone in it. The shell reads the list of the place it shows (a
// space, a direct message, an agent's chat) once and keeps it here, so the header's count, each message's "Pinned by" line, the ⋯ menu's
// Pin / Unpin and the Pinned panel all read the same list. The stream's event (ids only) reads it again on every screen that shows it.

/** The key of one pinned message in its list: an agent's chat pins a run's request and its answer apart. */
export const pinKey = (messageId: string, part?: PinPart) => (part ? `${messageId}:${part}` : messageId);

export interface Pins {
  place: PinPlace | null;
  /** Null until the list is read. */
  items: PinnedMessage[] | null;
  /** Whether the person may write here, and so pin and unpin (a 1:1 whose other person left takes no new messages: its list is read only). */
  canPin: boolean;
  pinOf(messageId: string, part?: PinPart): PinnedMessage | null;
  /** Pins or unpins; a failure says so in a toast and changes nothing. */
  toggle(messageId: string, part?: PinPart): void;
}

const NONE: Pins = { place: null, items: null, canPin: false, pinOf: () => null, toggle: () => undefined };
const PinsContext = createContext<Pins>(NONE);

/** The list of the conversation the shell shows, for everything inside it. */
export const usePins = () => useContext(PinsContext);

// A delete takes its pin and an edit changes the words the list shows: both read the list again.
const CHANGES_A_PIN = new Set(['project.message_removed.v1', 'dm.message_removed.v1', 'project.message_edited.v1', 'dm.message_edited.v1']);

/** The list of `place`, read now and again on its stream events; the shell gives it to everything inside it with {@link PinsScope}. */
export function usePinList(place: PinPlace | null, identity: string, canPin: boolean): Pins {
  const key = place ? `${place.type}:${place.id}` : '';
  const [list, setList] = useState<{ key: string; items: PinnedMessage[] } | null>(null);
  const toast = useToast();
  const current = useRef(key);
  useEffect(() => { current.current = key; }, [key]);
  const read = useCallback(() => {
    if (!place) return;
    const asked = key;
    void getPins(place).then((items) => { if (current.current === asked) setList({ key: asked, items }); }, () => undefined);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the place is its key
  }, [key]);
  useEffect(() => { read(); }, [read]);
  useStreamEvents(identity, (event) => {
    if (!place) return;
    const mine = place.type === 'agent' ? event.kind === PINS_CHANGED_EVENTS.agent
      : event.objectId === place.id && (event.kind === PINS_CHANGED_EVENTS[place.type] || CHANGES_A_PIN.has(event.kind));
    if (mine) read();
  }, read);
  const items = list?.key === key ? list.items : null;
  const value = useMemo<Pins>(() => {
    if (!place) return NONE;
    const byKey = new Map((items ?? []).map((item) => [pinKey(item.messageId, item.part), item]));
    return {
      place, items, canPin,
      pinOf: (messageId, part) => byKey.get(pinKey(messageId, part)) ?? null,
      toggle: (messageId, part) => {
        const pinned = byKey.has(pinKey(messageId, part));
        void setPin(place, messageId, part, !pinned).then((next) => { if (current.current === key) setList({ key, items: next }); },
          () => toast({ message: pinned ? 'Could not unpin the message' : 'Could not pin the message', tone: 'danger' }));
      },
    };
  }, [place?.type, place?.id, items, key, toast, canPin]); // eslint-disable-line react-hooks/exhaustive-deps
  return value;
}

export function PinsScope({ value, children }: { value: Pins; children: ReactNode }) {
  return <PinsContext.Provider value={value}>{children}</PinsContext.Provider>;
}
