import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import type { NeedsYouItem } from '@flux/contracts';
import { Button, ErrorState, Kreska, Spinner, useMediaQuery, useRowMotion } from '../ui';
import { useSmallMoments } from '../app/smallMoments';
import { NotAvailable } from '../app/NotAvailable';
import { useShellData } from '../app/data';
import { usePlaceState, useArrival } from '../place/memory';
import { announceInboxChange, getInboxItem, markInboxRead } from './api';
import { NeedsYouCard, type CardHandlers } from './NeedsYouCard';
import { useNeedsYou } from './needsYou';
import { SecurityNotices } from '../encryption/SecurityNotices';
import { useNeedsYouActions } from './useNeedsYouActions';
import { ApiError } from '../api/client';
import './notifications.css';
import './needs-you.css';

/** From this width the detail panel is no longer an overlay, and the Inbox shows the list and the open item side by side (README §7 Inbox). */
const TWO_COLUMNS = '(min-width: 1001px)';

/** Keys of the queue (F-026 §4): outside fields and dialogs, J and K move, A accepts, E marks done, S is Not now. */
function useQueueKeys(items: NeedsYouItem[], selected: string | null, select: (key: string) => void, handlers: CardHandlers) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [role="combobox"], [role="listbox"], [contenteditable="true"], [role="dialog"], [role="menu"], #details')) return;
      const key = event.key.toLowerCase();
      const at = items.findIndex((item) => item.key === selected);
      const current = items[at] ?? null;
      if (key === 'j' || key === 'k') {
        event.preventDefault();
        const next = items[key === 'j' ? Math.min(items.length - 1, at + 1) : Math.max(0, at < 0 ? 0 : at - 1)];
        if (next) select(next.key);
      } else if (key === 'a' && current?.kind === 'decision') { event.preventDefault(); handlers.accept(current); }
      else if (key === 'e' && current) { event.preventDefault(); handlers.done(current); }
      else if (key === 's' && current) { event.preventDefault(); handlers.snooze(current, 'tomorrow'); }
      // Enter on the page itself opens the item; on a button or link it does what that control does.
      else if (event.key === 'Enter' && current && (!target || target === document.body || target.id === 'content')) { event.preventDefault(); handlers.open(current); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [items, selected, select, handlers]);
}

/**
 * The Inbox (#342, F-026 S1): "Needs you" is the one queue. Decisions you can accept, questions to you, your blocked tasks,
 * mentions and calls, across spaces, as one list with no filters (§7, #1367). Where there is room the list is the left column and the open
 * item the right one; in one column the open item is the card expanded in the list. There is no Decisions view: a decision waits
 * here until someone accepts it.
 */
export function InboxView() {
  const { me } = useShellData();
  const moments = useSmallMoments();
  const two = useMediaQuery(TWO_COLUMNS);
  // A return to the Inbox shows the list it had at once, while it is read again (#592).
  const arrival = useArrival();
  const queue = useNeedsYou(me.user.id, !!arrival);
  const handlers = useNeedsYouActions(queue);
  const location = useLocation();
  // The selected item comes back as it was left. A row of Home's top three arrives with its item selected (#865).
  // The link of a notification about one item opens on it too: an agent waiting for your OK on its card (`?item=assistant:<run>`, #1186).
  const [selected, setSelected] = usePlaceState<string | null>('inbox.selected', () => (location.state as { select?: unknown } | null)?.select as string | null
    ?? new URLSearchParams(location.search).get('item'), arrival, (value): value is string | null => value === null || typeof value === 'string');
  const listRef = useRef<HTMLDivElement>(null);
  // A decision accepted, a question answered or a task marked done collapses where it stood; the next one comes up (#593 AC-4).
  useRowMotion(listRef, '.nyc[data-key]', (el) => el.dataset.key, queue.items === null ? 'loading' : 'ready');

  const shown = useMemo(() => queue.items ?? [], [queue.items]);
  // The selection stays on its item, and moves to the neighbour at its place when that item leaves.
  const at = shown.findIndex((item) => item.key === selected);
  const [place, setPlace] = useState({ key: selected, index: 0 });
  if (at >= 0 && (place.key !== selected || place.index !== at)) setPlace({ key: selected, index: at });
  const current = at >= 0 ? shown[at]! : shown[Math.min(place.index, shown.length - 1)] ?? null;
  const select = useCallback((key: string) => {
    setSelected(key);
    document.querySelector<HTMLElement>(`.nyc[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [setSelected]);
  useQueueKeys(shown, current?.key ?? null, select, handlers);
  // The open column: when what had focus in it leaves with its item (Accept, Not now, Done), focus goes to the next open item, not to the start
  // of the page, so a keyboard or screen reader user goes on from there.
  const paneRef = useRef<HTMLElement>(null);
  const paneFocused = useRef(false);
  const openKey = current?.key ?? null;
  useEffect(() => {
    if (!paneFocused.current) return;
    const active = document.activeElement;
    if (!active || active === document.body) paneRef.current?.focus({ preventScroll: true });
  }, [openKey]);

  // Put off for later: what Not now took out of the list, said under it (it returns tomorrow morning).
  const later = queue.later ? <p className="nyq__later">{queue.later} for later</p> : null;
  const list = (
    <ul className="nyq__list" aria-label="Needs you">
      {shown.map((item) => (
        <NeedsYouCard key={item.key} item={item} selected={item.key === current?.key} handlers={handlers}
          compact={two || item.key !== current?.key} list={two} onSelect={() => setSelected(item.key)} />
      ))}
    </ul>
  );
  const empty = queue.items !== null && !shown.length;
  const clear = (
    <div className="nyq__clear">
      {moments ? <Kreska size={96} expression="done" /> : null}
      <h2>Nothing needs you right now</h2>
      <p>Enjoy the quiet. Flux will ping you when a decision or question comes in.</p>
      <div className="nyq__clear-actions">
        {queue.doneToday ? <span className="nyq__done">{queue.doneToday} done today</span> : null}
        <Link className="ui-btn ui-btn--quiet" to="/settings/notifications">Notification settings</Link>
      </div>
      {later}
    </div>
  );
  const state = queue.failed && queue.items === null ? (
    <ErrorState title="The Inbox couldn’t be loaded" actions={<Button onClick={queue.reload}>Try again</Button>}>
      <p>Check your connection. Nothing was lost.</p>
    </ErrorState>
  ) : queue.items === null ? <p className="inbox__loading"><Spinner label="Loading the Inbox" /></p> : null;

  // The page scrolls as one (`.pane-scroll`, so its place is remembered); the open item stays in view beside the list.
  if (two && !state && !empty && current) {
    return (
      <div className="pane-scroll"><div className="pane-in nyq nyq--two">
        <div className="nyq__col nyq__col--list" ref={listRef}>
          {/* F-030 (#655): security notices about encrypted spaces are rare and read first, above the queue. */}
          <SecurityNotices userId={me.user.id} />
          {list}
          {later}
        </div>
        <section className="nyq__col nyq__col--open" aria-label="Open item" ref={paneRef} tabIndex={-1}
          onFocus={() => { paneFocused.current = true; }} onBlur={(event) => { if (event.relatedTarget) paneFocused.current = paneRef.current?.contains(event.relatedTarget as Node) ?? false; }}>
          <div className="nyq__sticky"><NeedsYouCard key={current.key} item={current} pane handlers={handlers} /></div>
        </section>
      </div></div>
    );
  }
  return (
    <div className="pane-scroll"><div className="pane-in nyq" ref={listRef}>
      <SecurityNotices userId={me.user.id} />
      {state ?? (empty ? clear : (<>{list}{later}</>))}
    </div></div>
  );
}

/**
 * `/inbox/:id`, the link in notification email and the service worker's fallback: asks the
 * server (which rechecks access), marks it read and opens the exact source. An item the person
 * can no longer read answers like one that never existed.
 */
export function InboxOpen() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  // The reference was followed from somewhere: the page it redirects to keeps that origin (#592).
  const arrivalState = useLocation().state as unknown;
  const stateRef = useRef(arrivalState);
  // Gone or closed to this person is the one "not available" page (#1371); a read that failed for now says so, with Try again (#1369).
  const [failure, setFailure] = useState<'gone' | 'failed' | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    getInboxItem(id, controller.signal).then(async (item) => {
      if (controller.signal.aborted) return;
      void markInboxRead(item.id).then(announceInboxChange, () => undefined);
      navigate(item.url ?? '/inbox', { replace: true, state: stateRef.current });
    }, (error: unknown) => {
      if (!controller.signal.aborted) setFailure(error instanceof ApiError && (error.status === 404 || error.status === 403) ? 'gone' : 'failed');
    });
    return () => controller.abort();
  }, [id, navigate, attempt]);
  if (failure === 'gone') return <NotAvailable title="This isn’t available to you" back={{ to: '/inbox', label: 'Back to the Inbox' }} />;
  return (
    <div className="pane-scroll"><div className="pane-in">
      {failure === 'failed' ? (
        <ErrorState title="This couldn’t be loaded" actions={<Button variant="secondary" icon="refresh" onClick={() => { setFailure(null); setAttempt((n) => n + 1); }}>Try again</Button>}>
          <p>Nothing was lost.</p>
        </ErrorState>
      ) : <p className="inbox__loading"><Spinner label="Opening" /></p>}
    </div></div>
  );
}
