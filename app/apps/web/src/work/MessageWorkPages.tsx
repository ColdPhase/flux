import { useEffect, useRef } from 'react';
import { Button } from '../ui';
import { onFluxAnswered, useConnection } from '../composer/connection';
import { WorkPagination } from './WorkPagination';
import type { MessageWorkRead } from './useMessageWork';

/** `typed`: a reply is written in the field, so the line says it is kept; with none it says nothing of one (round 15 confirm S4). */
export function MessageWorkPages({ read, typed }: { read: MessageWorkRead; typed: boolean }) {
  const connection = useConnection();
  const unavailable = read.state.phase === 'unavailable';
  // The read that failed while Flux could not be reached is made again once it answers: nothing was wrong with the linked work.
  const refresh = useRef(read.refreshObjects);
  useEffect(() => { refresh.current = read.refreshObjects; });
  useEffect(() => (unavailable ? onFluxAnswered(() => refresh.current()) : undefined), [unavailable]);
  if (read.state.phase === 'idle') return null;
  // Offline, the composer's own line already says Messages send when you're back; a second line about linked work would only repeat it
  // (round 15 confirm S4), and it is read again when Flux answers.
  if (unavailable && connection !== 'online') return null;
  if (unavailable) return <div className="ws-message-pages" role="alert">Linked work could not be loaded.{typed ? ' Your reply is kept.' : ''} <Button variant="link" size="sm" onClick={read.refreshObjects}>Refresh linked work</Button></div>;
  const page = read.page;
  // Before the first page there is nothing to page through: a placeholder bar would only appear
  // and vanish under the feed. While moving between pages the controls stay (busy).
  if (!page && !read.paged) return null;
  if (page && !page.nextCursor && !page.previousCursor && !page.edges.nextCursor && !page.edges.previousCursor && page.items.length) return null;
  if (page && !page.total && !page.previousCursor && !page.nextCursor) return null;
  return <div className="ws-message-pages" data-associations-observed-at={page?.observedAt}>
    <WorkPagination page={page} busy={read.busy} label="Linked object pages" caption="Objects" onCursor={read.moveObjects} onRefresh={read.refreshObjects} />
    {page && (page.edges.nextCursor || page.edges.previousCursor || page.edges.total) ? <WorkPagination page={page.edges} busy={read.busy} label="Message link pages" caption="Message links" noun="links" compactComplete onCursor={read.moveEdges} onRefresh={read.refreshEdges} /> : null}
  </div>;
}
