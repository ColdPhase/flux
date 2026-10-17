import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import type { InboxItem, NeedsYouItem, NeedsYouKind } from '@flux/contracts';
import { createPortal } from 'react-dom';
import { Button, ErrorState, Icon, Kreska, MEDIA, Spinner, Tabs, useMediaQuery, type TabItem } from '../ui';
import { useShellActions } from '../app/shellContext';
import { useSmallMoments } from '../app/smallMoments';
import { useShellData } from '../app/data';
import { usePlaceState, useArrival } from '../place/memory';
import { announceInboxChange, getInboxItem, markInboxRead } from './api';
import { AssistantJoinReview } from './AssistantJoinReview';
import { NeedsYouCard, type CardHandlers } from './NeedsYouCard';
import { useNeedsYou } from './needsYou';
import { useNeedsYouActions } from './useNeedsYouActions';
import './notifications.css';
import './needs-you.css';

type Filter = 'all' | NeedsYouKind;
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'decision', label: 'Decisions' }, { id: 'question', label: 'Questions' },
  { id: 'blocked', label: 'Blocked' }, { id: 'mention', label: 'Mentions' },
];
const ASKING: Record<Filter, string> = {
  all: 'Nothing needs you right now', decision: 'No decisions wait for you', question: 'No questions wait for you',
  blocked: 'None of your tasks is blocked', mention: 'No mentions wait for you',
};

/** Keys of the queue (F-026 §4): outside fields and dialogs, J and K move, A accepts, E marks done, S asks when. */
function useQueueKeys(items: NeedsYouItem[], selected: string | null, select: (key: string) => void, handlers: CardHandlers, openMenu: (key: string) => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], #details')) return;
      const key = event.key.toLowerCase();
      const at = items.findIndex((item) => item.key === selected);
      const current = items[at] ?? null;
      if (key === 'j' || key === 'k') {
        event.preventDefault();
        const next = items[key === 'j' ? Math.min(items.length - 1, at + 1) : Math.max(0, at < 0 ? 0 : at - 1)];
        if (next) select(next.key);
      } else if (key === 'a' && current?.kind === 'decision') { event.preventDefault(); handlers.accept(current); }
      else if (key === 'e' && current) { event.preventDefault(); handlers.done(current); }
      else if (key === 's' && current) { event.preventDefault(); openMenu(current.key); }
      // Enter on the page itself opens the item; on a button or link it does what that control does.
      else if (event.key === 'Enter' && current && (!target || target === document.body || target.id === 'content')) { event.preventDefault(); handlers.open(current); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [items, selected, select, handlers, openMenu]);
}

/**
 * The Inbox (#342, F-026 S1): "Needs you" is the one queue. Decisions you can accept, questions to you,
 * your blocked tasks and mentions, across projects, with the filters All, Decisions, Questions, Blocked
 * and Mentions. There is no Decisions view: a decision waits here until someone accepts it.
 */
export function InboxView() {
  const { me } = useShellData();
  const moments = useSmallMoments();
  const { actionSlot } = useShellActions();
  const phone = useMediaQuery(MEDIA.navDrawer);
  // A return to the Inbox shows the list it had at once, while it is read again (#592).
  const arrival = useArrival();
  const queue = useNeedsYou(me.user.id, !!arrival);
  const handlers = useNeedsYouActions(queue);
  // `?show=decisions` is where the retired Decisions view's links lead.
  const [asked, setAsked] = useSearchParams();
  // A replace on this page keeps the entry's state, so the origin it was followed from stays (#592).
  const location = useLocation();
  // The filter and the selected item come back as they were left.
  const [filter, setFilter] = usePlaceState<Filter>('inbox.filter', () => FILTERS.find((entry) => `${entry.id}s` === asked.get('show') || entry.id === asked.get('show'))?.id ?? 'all', arrival,
    (value): value is Filter => FILTERS.some((entry) => entry.id === value));
  const [selected, setSelected] = usePlaceState<string | null>('inbox.selected', () => null, arrival, (value): value is string | null => value === null || typeof value === 'string');
  const [menu, setMenu] = useState<string | null>(null);

  const all = useMemo(() => queue.items ?? [], [queue.items]);
  const reviewing = all.find((item) => item.assistantRequestIdentity && item.project?.id === asked.get('assistantProject')
    && item.assistantRequestIdentity.joinRequestId === asked.get('assistantRequest')
    && String(item.assistantRequestIdentity.openingVersion) === asked.get('openingVersion'));
  const counts = useMemo(() => {
    const result: Record<Filter, number> = { all: all.length, decision: 0, question: 0, blocked: 0, mention: 0 };
    for (const item of all) result[item.kind] += 1;
    return result;
  }, [all]);
  const shown = useMemo(() => (filter === 'all' ? all : all.filter((item) => item.kind === filter)), [all, filter]);
  // The selection stays on its item, and moves to the neighbour at its place when that item leaves.
  const at = shown.findIndex((item) => item.key === selected);
  const [place, setPlace] = useState({ key: selected, index: 0 });
  if (at >= 0 && (place.key !== selected || place.index !== at)) setPlace({ key: selected, index: at });
  const current = at >= 0 ? shown[at]! : shown[Math.min(place.index, shown.length - 1)] ?? null;
  const select = useCallback((key: string) => {
    setSelected(key);
    document.querySelector<HTMLElement>(`.nyc[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [setSelected]);
  const openMenu = useCallback((key: string) => { setSelected(key); setMenu((open) => (open === key ? null : key)); }, [setSelected]);
  useQueueKeys(shown, current?.key ?? null, select, handlers, openMenu);

  const tabs: TabItem[] = FILTERS.map((entry) => ({ id: entry.id, label: entry.label, count: counts[entry.id], countLabel: `, ${counts[entry.id]}` }));
  const summary = queue.items === null ? '' : counts.all ? `${counts.all} need${counts.all === 1 ? 's' : ''} you · all projects` : 'all clear · all projects';

  return (
    <div className="pane-scroll"><div className="pane-in nyq">
      {/* On the computer the summary and the filters sit in the header row, as drawn; on a phone they head the list. */}
      {(() => {
        // An empty Inbox is only Kreska, one sentence and the settings link (E06): nothing to filter yet. Snoozed items keep the summary, which says how many are for later.
        const bar = queue.items?.length === 0 && filter === 'all' && !queue.later ? null : (
          <>
            <p className="nyq__summary" aria-live="polite">{summary}{queue.later ? ` · ${queue.later} for later` : ''}</p>
            <Tabs variant="segmented" className="nyq__filters" label="Show" items={tabs} value={filter} onChange={(id) => setFilter(id as Filter)} />
          </>
        );
        if (!bar) return null;
        return !phone && actionSlot ? createPortal(<div className="nyq__bar nyq__bar--head">{bar}</div>, actionSlot) : <div className="nyq__bar">{bar}</div>;
      })()}
      {queue.failed && queue.items === null ? (
        <ErrorState title="The Inbox could not load" actions={<Button onClick={queue.reload}>Retry</Button>}>
          <p>Check your connection. Nothing was lost.</p>
        </ErrorState>
      ) : queue.items === null ? (
        <p className="inbox__loading"><Spinner label="Loading the Inbox" /></p>
      ) : !shown.length ? (
        <div className="nyq__clear">
          {moments ? <Kreska size={96} expression="done" /> : null}
          <h2>{ASKING[filter]}</h2>
          <p>{filter === 'all' ? 'Enjoy the quiet. Flux will ping you when a decision or question comes in.' : 'Everything else is under All.'}</p>
          <div className="nyq__clear-actions">
            {filter === 'all' && queue.doneToday ? <span className="nyq__done">{queue.doneToday} done today</span> : null}
            {filter !== 'all' ? <Button variant="secondary" onClick={() => setFilter('all')}>Show all</Button> : null}
            <Link className="ui-btn ui-btn--quiet" to="/settings/notifications">Notification settings</Link>
          </div>
        </div>
      ) : (
        <>
          <ul className="nyq__list" aria-label="Needs you">
            {shown.map((item) => (
              <NeedsYouCard key={item.key} item={item} selected={item.key === current?.key} handlers={handlers}
                menuOpen={menu === item.key} onMenuOpen={(open) => setMenu(open ? item.key : null)} />
            ))}
          </ul>
          <p className="nyq__keys" aria-hidden="true">
            <span><kbd>J</kbd><kbd>K</kbd> move</span><span><kbd>A</kbd> accept</span><span><kbd>E</kbd> done</span><span><kbd>S</kbd> not now</span><span><kbd>↵</kbd> open</span>
          </p>
        </>
      )}
      {reviewing ? <AssistantJoinReview key={`${reviewing.key}:${reviewing.assistantRequestIdentity!.openingVersion}`} item={reviewing} onClose={() => {
        const next = new URLSearchParams(asked); next.delete('assistantProject'); next.delete('assistantRequest'); next.delete('openingVersion');
        setAsked(next, { replace: true, state: location.state }); announceInboxChange();
      }} /> : null}
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
  const [gone, setGone] = useState(false);
  const [notification, setNotification] = useState<InboxItem | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    getInboxItem(id, controller.signal).then((item) => {
      if (controller.signal.aborted) return;
      if (item.assistantRequestIdentity && item.source.type === 'project') { setNotification(item); return; }
      if (!item.assistantRequestIdentity) void markInboxRead(item.id).then(announceInboxChange, () => undefined);
      navigate(item.url ?? '/inbox', { replace: true, state: stateRef.current });
    }, () => { if (!controller.signal.aborted) setGone(true); });
    return () => controller.abort();
  }, [id, navigate]);
  return (
    <div className="pane-scroll"><div className="pane-in">
      {notification?.id === id && notification.assistantRequestIdentity && notification.source.type === 'project' ?
        <AssistantJoinReview key={id} item={{ assistantRequestIdentity: notification.assistantRequestIdentity,
          project: { id: notification.source.id, name: notification.body.replace(/ · Requested contributor access\.$/, '') } }}
          onClose={() => { announceInboxChange(); void navigate('/inbox', { replace: true, state: stateRef.current }); }} />
        : gone ? (
        <div className="inbox-gone">
          <Icon name="lock" size={16} />
          <div>
            <h2>This is not available to you</h2>
            <p>It may have been removed, or you no longer have access to where it happened.</p>
            <Link className="ui-btn ui-btn--secondary" to="/inbox">Go to your inbox</Link>
          </div>
        </div>
      ) : <p className="inbox__loading"><Spinner label="Opening" /></p>}
    </div></div>
  );
}
