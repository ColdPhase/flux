import { memo, useEffect, type ReactNode } from 'react';
import { useSharedWiki, WikiPresence } from './WikiEditor';

/** What the reader shows of the shared working copy of the current page (#228). */
export interface LiveReadingState {
  working: { generation: string; sequence: number; savedVersion: number; text: string; html: string; presence: ReactNode } | null;
  problem: string | null;
}
export interface LiveReadingProps { docId: string; userId: string; onState(state: LiveReadingState | null): void }

/**
 * Loaded lazily, and only when this API's live capability is configured (#239 review): the
 * CRDT bundle it needs is never evaluated by an ordinary wiki. It renders nothing: it hands the
 * working copy to the reader that is already on screen (#683), so that reader is not replaced when
 * this bundle arrives. It re-renders only when the shared copy changes (`memo`, a stable `onState`),
 * and publishes after each such render.
 */
export const LiveReading = memo(function LiveReading({ docId, userId, onState }: LiveReadingProps) {
  const live = useSharedWiki(docId, userId, false);
  const working = live?.id === docId && live.text && live.status !== 'unavailable' && live.status !== 'private' ? live : null;
  const state: LiveReadingState = {
    working: working ? { generation: working.head.generation, sequence: working.htmlSequence, savedVersion: working.head.savedVersion,
      text: working.text.toString(), html: working.html, presence: <WikiPresence client={working} /> } : null,
    problem: live?.problem ?? null,
  };
  useEffect(() => { onState(state); });
  useEffect(() => () => onState(null), [onState]);
  return null;
});
