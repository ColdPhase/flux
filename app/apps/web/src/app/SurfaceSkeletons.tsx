import './surface-skeletons.css';

/**
 * What a deferred surface shows while its code or its reads arrive (#863 rule 6): its own layout in quiet bars, at the heights the
 * content will have, so nothing jumps when the content takes its place. They live in the eager bundle with their own stylesheet,
 * because the surface's code and styles are what is being waited for.
 */

export type DetailsSkeletonKind = 'work' | 'decision' | 'result' | 'plain';

/**
 * The Details panel, at the heights its content has: a task (`work`: a title, four property rows, an action row and a section), a
 * decision or a result (an identity block, a lead, the decide box, a row and a section), or any other view as a title and some lines.
 * The title is one line high: a task's title is one line in nearly every case, and a skeleton cannot know when it is two.
 */
export function DetailsSkeleton({ kind = 'work' }: { kind?: DetailsSkeletonKind }) {
  if (kind === 'decision' || kind === 'result') {
    return (
      <div className="details wd wd-skeleton wd-skeleton--decision" aria-busy="true">
        <span className="ui-vh" role="status">Loading…</span>
        <div className="wd-skeleton__identity"><i /><i /><i /></div>
        <div className="wd-skeleton__lead"><i /><i /></div>
        <div className="wd-skeleton__box" />
        <div className="wd-skeleton__rows"><div className="wd-skeleton__row"><i /><i /></div></div>
        <div className="wd-skeleton__sec"><i /><i /><i /></div>
      </div>
    );
  }
  return (
    <div className={`details wd wd--task wd-skeleton wd-skeleton--${kind}`} aria-busy="true">
      <div className="wd__scroll">
        <span className="ui-vh" role="status">Loading…</span>
        <div className="wd-skeleton__title"><i /></div>
        {kind === 'work' ? <>
          <div className="wd-skeleton__rows">{[0, 1, 2, 3].map((row) => <div key={row} className="wd-skeleton__row"><i /><i /></div>)}</div>
          <div className="wd-skeleton__actions"><i /><i /><i /></div>
          <div className="wd-skeleton__sec"><i /><i /><i /></div>
        </> : <div className="wd-skeleton__sec"><i /><i /><i /><i /></div>}
      </div>
    </div>
  );
}

/** Jump to… (⌘K): the field's row and the rows of its first list, in the dialog's final size. */
export function JumpSkeleton() {
  return (
    <div className="jump-skeleton" aria-busy="true">
      <span className="ui-vh" role="status">Opening search…</span>
      <div className="jump-skeleton__field"><i /><b /></div>
      <div className="jump-skeleton__body">{[0, 1, 2, 3, 4, 5, 6].map((row) => <div key={row} className="jump-skeleton__row"><i /><b style={{ width: `${[46, 58, 38, 52, 44, 60, 40][row]}%` }} /></div>)}</div>
    </div>
  );
}
