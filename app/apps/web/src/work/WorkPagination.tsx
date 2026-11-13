import type { WorkPage } from '@flux/contracts';
import { Button } from '../ui';

/**
 * `compactComplete`: a complete single page shows no actions. `stepsWhenPaged`: Previous and Next show only when
 * there is another page (single-page pagination is not shown, Spokój rule 4). Refresh shows only with `onRefresh`: a list that updates live
 * (the Tasks List, #1419) has none.
 */
export function WorkPagination({ page, busy, onCursor, onRefresh, label = 'Work pages', noun = 'objects', caption, compactComplete = false, stepsWhenPaged = false }: {
  page: WorkPage<unknown> | null; busy: boolean;
  onCursor: (cursor: string) => void; onRefresh?: () => void;
  label?: string; noun?: string; caption?: string; compactComplete?: boolean; stepsWhenPaged?: boolean;
}) {
  // Plain words (#1372): a whole list says how many it holds ("9 tasks"), a page of a longer one says where it is ("1–50 of 123 tasks"), and an empty one says nothing.
  const one = !!page && !page.before && !page.previousCursor && !page.nextCursor;
  const singular = noun.replace(/(ch|sh|x)es$/, '$1').replace(/s$/, '');
  // A failed read is said by the page itself, with its Try again (#1369); the bar does not say it a second time.
  const range = !page ? busy ? 'Loading…' : ''
    : !page.total ? ''
    : !page.items.length ? `Nothing on this page · ${page.total} ${page.total === 1 ? singular : noun} in all`
    : one && page.items.length === page.total ? `${page.total} ${page.total === 1 ? singular : noun}`
    : `${page.before + 1}–${page.before + page.items.length} of ${page.total} ${noun}`;
  return <nav className="ws-pages" aria-label={label} aria-busy={busy}>
    <span className="ws-pages__range" role="status">{caption ? `${caption} · ` : ''}{range}</span>
    {!compactComplete || !page || page.previousCursor || page.nextCursor ? <div className="ws-pages__actions">
      {!stepsWhenPaged || page?.previousCursor || page?.nextCursor ? <>
        <Button variant="secondary" size="sm" disabled={!busy && !page?.previousCursor} aria-disabled={busy || !page?.previousCursor} onClick={() => { if (!busy && page?.previousCursor) onCursor(page.previousCursor); }}>Previous</Button>
        <Button variant="secondary" size="sm" disabled={!busy && !page?.nextCursor} aria-disabled={busy || !page?.nextCursor} onClick={() => { if (!busy && page?.nextCursor) onCursor(page.nextCursor); }}>Next</Button>
      </> : null}
      {onRefresh ? <Button variant="secondary" size="sm" onClick={onRefresh}>Refresh</Button> : null}
    </div> : null}
  </nav>;
}
