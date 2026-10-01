import type { WorkPage } from '@flux/contracts';

export function WorkPagination({ page, busy, onCursor, onRefresh }: {
  page: WorkPage<unknown> | null; busy: boolean;
  onCursor: (cursor: string) => void; onRefresh: () => void;
}) {
  const range = page ? page.items.length ? `${page.before + 1}–${page.before + page.items.length} of ${page.total} objects` : `No rows on this page · ${page.total} objects total` : busy ? 'Loading work…' : 'Work unavailable';
  return <nav className="ws-pages" aria-label="Work pages" aria-busy={busy}>
    <span className="ws-pages__range" role="status">{range}</span>
    <div className="ws-pages__actions">
      <button type="button" disabled={!busy && !page?.previousCursor} aria-disabled={busy || !page?.previousCursor} onClick={() => { if (!busy && page?.previousCursor) onCursor(page.previousCursor); }}>Previous</button>
      <button type="button" disabled={!busy && !page?.nextCursor} aria-disabled={busy || !page?.nextCursor} onClick={() => { if (!busy && page?.nextCursor) onCursor(page.nextCursor); }}>Next</button>
      <button type="button" onClick={onRefresh}>Refresh</button>
    </div>
  </nav>;
}
