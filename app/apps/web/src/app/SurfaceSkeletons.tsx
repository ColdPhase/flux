import { Icon } from '../ui';
import { SEARCH_HINT } from '../search/hint';
import '../search/search.css';
import './surface-skeletons.css';

/**
 * What a deferred surface shows while its code or its reads arrive (#863 rule 6): its own layout in quiet bars, at the heights the
 * content will have, so nothing jumps when the content takes its place. They live in the eager bundle with their own stylesheet,
 * because the surface's code and styles are what is being waited for.
 */

/**
 * The Details panel while its reads arrive. It draws only layout it knows. A task whose title the opener knew (`title`, from the row or card
 * that was pressed) gets the real title in the real title box, however many lines it takes, and below it four property rows, an action
 * row and a section, whose heights do not depend on anything unknown: nothing in it moves when the content takes its place. Every other
 * opening (a task opened from a link, a decision, any other view) shows a title bar and some quiet lines: the heights below a
 * title that wraps, or a decision's lead of unknown length, are not known, so no rows or sections are drawn at guessed places.
 */
export function DetailsSkeleton({ title }: { title?: string }) {
  if (title) {
    return (
      <div className="details wd wd--task wd-skeleton wd-skeleton--task" aria-busy="true">
        <div className="wd__scroll">
          <span className="ui-vh" role="status">Loading…</span>
          {/* The "#4 · Rain barrel monitor" line above the title (#1364), one line of the same text size, so the title does not move. */}
          <p className="wd-skeleton__ref" aria-hidden="true"><i />&nbsp;</p>
          <h3 className="details__title wd-skeleton__name"><span>{title}</span></h3>
          <div className="wd-skeleton__rows">{[0, 1, 2, 3].map((row) => <div key={row} className="wd-skeleton__row"><i /><i /></div>)}</div>
          <div className="wd-skeleton__actions"><i /><i /><i /></div>
          <div className="wd-skeleton__sec"><i /><i /><i /></div>
        </div>
      </div>
    );
  }
  return (
    <div className="details wd wd-skeleton" aria-busy="true">
      <span className="ui-vh" role="status">Loading…</span>
      <div className="wd-skeleton__bar"><i /></div>
      <div className="wd-skeleton__sec"><i /><i /><i /><i /></div>
    </div>
  );
}

/**
 * Search (⌘K) while its code arrives, in the final size by construction: it is the dialog's own markup and classes (`search/search.css` is
 * loaded with it) with bars where the labels are. What decides the dialog's height is known before the code is here: the number of recent
 * places (up to four, minus the one in view), the spaces waiting to be unlocked, and the actions (Go to Inbox; on the computer the sidebar; and "Ask my assistant…" when it is ready), and on the computer the footer's sentence. The close control sits in the
 * field row, as the real one does.
 */
export function JumpSkeleton({ places, locked, phone, ask, onClose }: { places: number; locked: number; phone: boolean; ask: boolean; onClose: () => void }) {
  const bars = (count: number, offset: number) => Array.from({ length: count }, (_, index) => (
    <li key={index} className="jump__opt jump-skeleton__opt"><i /><b style={{ width: `${[46, 58, 38, 52, 44, 60, 40][(index + offset) % 7]}%` }} /></li>
  ));
  return (
    <div className="jump__in jump-skeleton" aria-busy="true">
      <span className="ui-vh" role="status">Opening search…</span>
      {phone ? <h2 className="jump__title">Search</h2> : null}
      <div className="jump__field">
        <Icon name="search" size={16} className="jump__icon" />
        <span className="jump-skeleton__input"><b /></span>
        <button type="button" className="jump__close" onClick={onClose}>{phone ? 'Cancel' : <><span className="ui-vh">Close</span><kbd aria-hidden="true">Esc</kbd></>}</button>
      </div>
      <div className="jump__body" aria-hidden="true">
        {phone && !places ? <p className="jump__hint">{SEARCH_HINT}</p> : null}
        <ul className="jump__list">
          {places ? <><li className="jump__sh">Recent</li>{bars(places, 0)}</> : null}
          {locked ? <><li className="jump__sh">Waiting to be unlocked</li>{bars(locked, 3)}</> : null}
          <li className="jump__sh">Actions</li>{bars((phone ? 1 : 2) + (ask ? 1 : 0), 1)}
        </ul>
      </div>
      {phone ? null : (
        <p className="jump__foot" aria-hidden="true">
          <span className="jump__hint-line">{SEARCH_HINT}</span>
          <span className="jump__keyhint"><kbd>↑</kbd><kbd>↓</kbd> move</span><span className="jump__keyhint"><kbd>↵</kbd> open</span>
        </p>
      )}
    </div>
  );
}
