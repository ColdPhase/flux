import { WorkPagination } from './WorkPagination';
import type { useMessageWork } from './useMessageWork';

export function MessageWorkPages({ read }: { read: ReturnType<typeof useMessageWork> }) {
  if (read.state.phase === 'idle') return null;
  if (read.state.phase === 'unavailable') return <div className="ws-message-pages" role="alert">Linked work could not be loaded. Your reply is kept. <button type="button" className="ws-none__b" onClick={read.refreshObjects}>Refresh linked work</button></div>;
  const page = read.page;
  if (page && !page.nextCursor && !page.previousCursor && !page.edges.nextCursor && !page.edges.previousCursor && page.items.length) return null;
  if (page && !page.total && !page.previousCursor && !page.nextCursor) return null;
  return <div className="ws-message-pages" data-associations-observed-at={page?.observedAt}>
    <WorkPagination page={page} busy={read.busy} label="Linked object pages" caption="Objects" onCursor={read.moveObjects} onRefresh={read.refreshObjects} />
    {page && (page.edges.nextCursor || page.edges.previousCursor || page.edges.total) ? <WorkPagination page={page.edges} busy={read.busy} label="Message link pages" caption="Message links" noun="links" compactComplete onCursor={read.moveEdges} onRefresh={read.refreshEdges} /> : null}
  </div>;
}
