import type { ReactNode } from 'react';
import { useSharedWiki, WikiPresence } from './WikiEditor';

/** What the reader shows of the shared working copy of the current page (#228). */
export interface LiveReadingState {
  working: { generation: string; sequence: number; savedVersion: number; text: string; html: string; presence: ReactNode } | null;
  problem: string | null;
}
export interface LiveReadingProps { docId: string; userId: string; render(live: LiveReadingState | null): ReactNode }

/**
 * Loaded lazily, and only when this API's live capability is configured (#239 review): the
 * CRDT bundle it needs is never evaluated by an ordinary wiki.
 */
export function LiveReading({ docId, userId, render }: LiveReadingProps) {
  const live = useSharedWiki(docId, userId, false);
  const working = live?.id === docId && live.text && live.status !== 'unavailable' && live.status !== 'private' ? live : null;
  return <>{render({
    working: working ? { generation: working.head.generation, sequence: working.htmlSequence, savedVersion: working.head.savedVersion,
      text: working.text.toString(), html: working.html, presence: <WikiPresence client={working} /> } : null,
    problem: live?.problem ?? null,
  })}</>;
}
