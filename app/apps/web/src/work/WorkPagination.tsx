import type { WorkPage } from '@flux/contracts';

export function WorkPagination({ page, busy, onCursor, onRefresh, label = 'Work pages', noun = 'objects', caption, compactComplete = false }: {
  page: WorkPage<unknown> | null; busy: boolean;
  onCursor: (cursor: string) => void; onRefresh: () => void;
  label?: string; noun?: string; caption?: string; compactComplete?: boolean;
}) {
  const range = page ? page.items.length ? `${page.before + 1}–${page.before + page.items.length} of ${page.total} ${noun}` : `No rows on this page · ${page.total} ${noun} total` : busy ? 'Loading work…' : 'Work unavailable';
  return <nav className="ws-pages" aria-label={label} aria-busy={busy}>
    <span className="ws-pages__range" role="status">{caption ? `${caption} · ` : ''}{range}</span>
    {!compactComplete || !page || page.previousCursor || page.nextCursor ? <div className="ws-pages__actions">
      <button type="button" disabled={!busy && !page?.previousCursor} aria-disabled={busy || !page?.previousCursor} onClick={() => { if (!busy && page?.previousCursor) onCursor(page.previousCursor); }}>Previous</button>
      <button type="button" disabled={!busy && !page?.nextCursor} aria-disabled={busy || !page?.nextCursor} onClick={() => { if (!busy && page?.nextCursor) onCursor(page.nextCursor); }}>Next</button>
      <button type="button" onClick={onRefresh}>Refresh</button>
    </div> : null}
  </nav>;
}
