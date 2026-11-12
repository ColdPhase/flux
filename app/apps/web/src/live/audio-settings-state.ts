import { useSyncExternalStore } from 'react';
import type { AudioSnapshot, CallAudio } from './call-audio';

/**
 * Whether the Audio settings are open (#1244). Two places open them, the microphone's arrow in the strip and a row of ⋯, and the
 * strip's microphone control shows them, so the open state sits here rather than in either.
 */
let open = false;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const read = () => open;

function set(next: boolean) {
  if (open === next) return;
  open = next;
  for (const listener of listeners) listener();
}

export const openAudioSettings = () => set(true);
export const closeAudioSettings = () => set(false);
export const toggleAudioSettings = () => set(!open);
export const useAudioSettingsOpen = () => useSyncExternalStore(subscribe, read, () => false);

const noSubscription = () => () => undefined;
const nothing = () => null;

/** The sound settings of the call as plain values, or `null` before a call has a connection. */
export function useAudioSnapshot(audio: CallAudio | null): AudioSnapshot | null {
  return useSyncExternalStore(audio?.subscribe ?? noSubscription, audio?.getSnapshot ?? nothing);
}
