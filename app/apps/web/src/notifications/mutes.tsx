import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DM_NOTIFICATIONS_CHANGED_EVENT, PROJECT_NOTIFICATIONS_CHANGED_EVENT, type MutablePlaceType, type StreamEvent } from '@flux/contracts';
import { ApiError } from '../api/client';
import { useStreamEvents } from '../api/stream';
import { useToast } from '../ui';
import { getMutedPlaces, setMute } from './api';

// The places this person muted, for the sidebar's mark and the ⋯ menus' Mute and Unmute (#1249). It is the same state Settings lists
// and the Inbox, push and email read (`GET`/`PUT /notification-preferences/mutes`): there is no copy of it. A change made here, in
// Settings or in another tab of the same person arrives as a stream event and is read again; nothing polls.

/** A mute or a follow changed for this person, in this tab or another (one event of the place, to them alone). */
export const notificationsChanged = (event: Pick<StreamEvent, 'kind'>) =>
  event.kind === PROJECT_NOTIFICATIONS_CHANGED_EVENT || event.kind === DM_NOTIFICATIONS_CHANGED_EVENT;

const key = (type: MutablePlaceType, id: string) => `${type}:${id}`;

interface Mutes {
  muted: ReadonlySet<string>;
  /** Mutes or unmutes a place now (the mark and the menu change at once) and tells the server; a failure puts it back and says so. */
  set(type: MutablePlaceType, id: string, muted: boolean): Promise<void>;
}

const NONE: Mutes = { muted: new Set(), set: async () => undefined };
const MutesContext = createContext<Mutes>(NONE);

export function PlaceMutesProvider({ identity, children }: { identity: string; children: ReactNode }) {
  const [known, setKnown] = useState<{ identity: string; keys: ReadonlySet<string> } | null>(null);
  const toast = useToast();
  // A newer read or write is the truth: an older answer arriving late never undoes it.
  const version = useRef(0);
  const read = useCallback(() => {
    const mine = ++version.current;
    void getMutedPlaces().then((answer) => {
      if (mine === version.current) setKnown({ identity, keys: new Set(answer.muted.map((place) => key(place.type, place.id))) });
    }, () => undefined);
  }, [identity]);
  useEffect(read, [read]);
  useStreamEvents(identity, (event) => { if (notificationsChanged(event)) read(); }, read);

  const muted = useMemo(() => (known?.identity === identity ? known.keys : new Set<string>()), [known, identity]);
  const mutedNow = useRef(muted);
  useEffect(() => { mutedNow.current = muted; });
  const set = useCallback(async (type: MutablePlaceType, id: string, on: boolean) => {
    const before = mutedNow.current;
    const mine = ++version.current;
    const next = new Set(before);
    if (on) next.add(key(type, id)); else next.delete(key(type, id));
    setKnown({ identity, keys: next });
    try {
      const answer = await setMute({ type, id, muted: on });
      if (mine === version.current) setKnown({ identity, keys: new Set(answer.muted.map((place) => key(place.type, place.id))) });
    } catch (error) {
      if (mine === version.current) setKnown({ identity, keys: before });
      toast({ message: error instanceof ApiError && error.status < 500 && error.status !== 404 ? error.message : on ? 'Could not mute. Try again.' : 'Could not unmute. Try again.', tone: 'danger' });
    }
  }, [identity, toast]);

  const value = useMemo<Mutes>(() => ({ muted, set }), [muted, set]);
  return <MutesContext.Provider value={value}>{children}</MutesContext.Provider>;
}

/** Whether this person muted the place, as the shell last saw it. */
export const useIsMuted = (type: MutablePlaceType, id: string | null | undefined) => useContext(MutesContext).muted.has(key(type, id ?? ''));

/** The places' state and the one way to change it, for the ⋯ menus. */
export const usePlaceMutes = () => useContext(MutesContext);

/** The Mute row of a place's menu: its label, the line under it and what it does. The words are the design's (docs/design/final). */
export function useMuteRow(type: MutablePlaceType, id: string | null | undefined) {
  const { muted, set } = useContext(MutesContext);
  const on = !!id && muted.has(key(type, id));
  const noun = type === 'project' ? 'space' : 'conversation';
  return useMemo(() => !id ? null : {
    muted: on,
    label: on ? `Unmute ${noun}` : `Mute ${noun}`,
    hint: on ? 'Muted. What needs you still arrives.' : 'Quiet for ordinary messages. What needs you still arrives.',
    run: () => void set(type, id, !on),
  }, [on, noun, id, type, set]);
}
