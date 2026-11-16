import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import type { NeedsYouItem } from '@flux/contracts';
import { Button, ErrorState, Kreska, MEDIA, Spinner, useMediaQuery, useRowMotion } from '../ui';
import { useSmallMoments } from '../app/smallMoments';
import { NotAvailable } from '../app/NotAvailable';
import { useShellData } from '../app/data';
import { remember, usePlaceState, useArrival } from '../place/memory';
import { announceInboxChange, getInboxItem, markInboxRead } from './api';
import { NeedsYouCard, itemKeys, type CardHandlers } from './NeedsYouCard';
import { useNeedsYou } from './needsYou';
import { SecurityNotices } from '../encryption/SecurityNotices';
import { useNeedsYouActions } from './useNeedsYouActions';
import { InboxAside } from './InboxAside';
import { inboxSettled, inboxSettling } from './settle';
import { ApiError } from '../api/client';
import { awaitField, focusFieldMatching, isTyping } from '../ui/keys';
import './notifications.css';
import './needs-you.css';

/** From this width the detail panel is no longer an overlay, and the Inbox shows the list and the open item side by side (README §7 Inbox). */
const TWO_COLUMNS = '(min-width: 1001px)';

/** The row of an item in the list: its title is the control that selects or opens it. */
const rowControl = (key: string) => document.querySelector<HTMLElement>(`.nyq__list .nyc[data-key="${CSS.escape(key)}"] .nyc__open`);

/**
 * Keys of the queue (F-026 §4): outside fields and dialogs, J and K move, A accepts, R replies, E marks done, S is Not now, each only where
 * the open item shows that button (`itemKeys`). R moves focus to the reply field, and every key typed from R until that field has it is the
 * reply (`awaitField` in `open`): "Sure" typed at once never becomes S and E on the items here (#1424).
 */
function useQueueKeys(items: NeedsYouItem[], selected: string | null, select: (key: string) => void, handlers: CardHandlers) {
  // The keys act on the item shown open now: read when the page is drawn, never from the listener of an earlier draw (an item that came back
  // with Z is open on screen while S still acted on its neighbour, persona round 31).
  const latest = useRef({ items, selected, select, handlers });
  useLayoutEffect(() => { latest.current = { items, selected, select, handlers }; });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const { items, selected, select, handlers } = latest.current;
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (isTyping(target) || target?.closest('[role="dialog"], [role="menu"], #details')) return;
      const key = event.key.toLowerCase();
      const at = items.findIndex((item) => item.key === selected);
      const current = items[at] ?? null;
      const offers = current ? itemKeys(current, !!handlers.answer) : null;
      // A key pressed again on the item that has just swapped in does nothing (personas-34 P2 3), nor do the letters typed with it.
      if ((key === 'a' || key === 'r' || key === 'e' || key === 's' || event.key === 'Enter') && current && inboxSettling() && (!target || target === document.body || target.id === 'content' || !!target.closest('.nyq'))) {
        event.preventDefault();
        return;
      }
      if (key === 'j' || key === 'k') {
        event.preventDefault();
        const next = items[key === 'j' ? Math.min(items.length - 1, at + 1) : Math.max(0, at < 0 ? 0 : at - 1)];
        if (next) select(next.key);
      } else if (key === 'a' && current?.kind === 'decision') { event.preventDefault(); handlers.accept(current); }
      // R writes (F-026 §4, persona round 28 P2 3): a Reply, a decision's Discuss, a task's own discussion. Where there is nothing to write
      // to, what is typed next is held and dropped, never run as Accept, Done or Not now.
      else if (key === 'r' && current) {
        event.preventDefault();
        if (offers?.reply) handlers.open(current, true);
        else if (current.kind === 'decision') { awaitField(); handlers.discuss(current); }
        else if (current.kind === 'blocked') { handlers.open(current); focusFieldMatching('#details .composer textarea, #details .composer__box textarea'); }
        // Nothing to write to: only the letters typed with R are held, for a moment, then the keys are the Inbox's again (persona round 31).
        else awaitField(500);
      }
      else if (key === 'e' && current && offers?.done) { event.preventDefault(); handlers.done(current); }
      else if (key === 's' && current && offers?.notNow) { event.preventDefault(); handlers.snooze(current, 'tomorrow'); }
      // Enter on the page itself, or on the open item's row (where G I puts focus), opens the item; on another button or link it does what
      // that control does.
      else if (event.key === 'Enter' && current && (!target || target === document.body || target.id === 'content' || target === rowControl(current.key))) { event.preventDefault(); handlers.open(current); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
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
  const touch = useMediaQuery(MEDIA.touch);
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
  // Where the open item stood, kept with the entry too: an item opened from here that left the Inbox (a given task) gives its place to
  // its neighbour when the person comes back, never to the top (persona round 31).
  const [keptIndex, setKeptIndex] = usePlaceState<number>('inbox.index', () => 0, arrival, (value): value is number => typeof value === 'number');
  const [place, setPlace] = useState({ key: selected, index: keptIndex });
  if (at >= 0 && (place.key !== selected || place.index !== at)) setPlace({ key: selected, index: at });
  useEffect(() => { setKeptIndex(place.index); }, [place.index, setKeptIndex]);
  const current = at >= 0 ? shown[at]! : shown[Math.min(place.index, shown.length - 1)] ?? null;
  // The open item is chosen, never implied (persona round 31 P2 1): from the first moment the one shown open is the selected one, so an
  // item that arrives live at the top never takes its place under the ring, and E never acts on what was not seen. When the chosen item
  // leaves, its neighbour at its place is chosen in its turn.
  const currentKey = current?.key ?? null;
  useEffect(() => {
    if (currentKey && currentKey !== selected) setSelected(currentKey);
  }, [currentKey, selected, setSelected]);
  const select = useCallback((key: string) => {
    // The person chose this item: it acts at once, also right after an action (`settle.ts`).
    inboxSettled();
    setSelected(key);
    document.querySelector<HTMLElement>(`.nyc[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest' });
    // Focus in the list goes with the selection, so a keyboard or screen reader user is on the item J or K chose.
    if (document.activeElement?.closest('.nyq__list')) rowControl(key)?.focus({ preventScroll: true });
  }, [setSelected]);
  useQueueKeys(shown, current?.key ?? null, select, handlers);
  // What "done today" or "for later" put back has the ring and is the open item, on the phone the expanded card (F-026 §4, personas-34 P2 2):
  // the ring and the open item stay together, so E acts on what came back.
  const cameBack = useCallback((key: string) => {
    inboxSettled();
    setSelected(key);
    rowControl(key)?.focus({ preventScroll: false });
  }, [setSelected]);
  // The open column: when what had focus in it leaves with its item (Accept, Not now, Done), focus goes to the next open item, not to the start
  // of the page, so a keyboard or screen reader user goes on from there.
  const paneRef = useRef<HTMLElement>(null);
  const paneFocused = useRef(false);
  // The same in the list: when the focused row leaves with its item, the row of the item that is open now takes focus.
  const listFocused = useRef(false);
  const openKey = current?.key ?? null;
  // An item a key or a button took out (A, E, S, Accept) leaves focus nowhere: the next open item's row takes it, and with nothing left the
  // empty Inbox's heading does, so focus is never on the page's body (persona round 26: A on the last decision left it there).
  const clearRef = useRef<HTMLHeadingElement>(null);
  const lastOpen = useRef(openKey);
  useEffect(() => {
    const left = lastOpen.current !== null && !shown.some((item) => item.key === lastOpen.current);
    lastOpen.current = openKey;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    if (paneFocused.current && paneRef.current) paneRef.current.focus({ preventScroll: true });
    else if ((listFocused.current || left) && openKey) rowControl(openKey)?.focus({ preventScroll: true });
    else if (left && !openKey) clearRef.current?.focus({ preventScroll: true });
    // When the open item changes; the list it is read from is the one of that render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openKey]);
  // An item that comes back (Z or Undo after S, A or E) is the open one again and takes the focus, so the next key acts on the item the person
  // sees (persona round 29 P2 3): focus stayed on another row, and S snoozed, A accepted, what was not looked at.
  const keysShown = shown.map((item) => item.key).join('\n');
  const seenKeys = useRef<Set<string> | null>(null);
  const goneKeys = useRef(new Set<string>());
  useEffect(() => {
    const now = new Set(shown.map((item) => item.key));
    const before = seenKeys.current;
    seenKeys.current = now;
    if (!before) return;
    for (const key of before) if (!now.has(key)) goneKeys.current.add(key);
    const back = [...goneKeys.current].find((key) => now.has(key));
    for (const key of [...goneKeys.current]) if (now.has(key)) goneKeys.current.delete(key);
    if (!back) return;
    // On a touch screen the item that came back is the expanded card (F-026 §4, C6 of sweep 34); no focus moves there, as nothing was typed.
    if (touch) { setSelected(back); return; }
    const active = document.activeElement;
    if (active && active !== document.body && active.id !== 'content' && !active.closest('.nyq')) return;
    setSelected(back);
    requestAnimationFrame(() => rowControl(back)?.focus({ preventScroll: true }));
    // When the list's items change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keysShown]);
  // Arriving with focus nowhere (G I, a link that keeps no focus): the open item's row takes it, so the keyboard starts in the list, never on
  // the page's body. A field, a button or a link that has focus keeps it.
  const ready = queue.items !== null;
  useEffect(() => {
    if (!ready || touch) return;
    const active = document.activeElement;
    // An empty Inbox (G I with nothing waiting): its heading takes the focus, never the page body (F-026 §4). On every arrival, G I in the
    // Inbox and a return from an item opened from it (Esc, Back) included, the open item has the focus: a sidebar link or a row that
    // kept it from before would let E act on another item than the one open (persona round 30 P2 3). A field keeps it.
    const onOpenItem = !!openKey && !!active && (!!active.closest(`.nyc[data-key="${CSS.escape(openKey)}"]`) || !!active.closest('.nyq__col--open'));
    // The panel of the page just left (Back from a task or a decision opened with R or Discuss) still holds its field while it closes: that
    // is not a field of the Inbox, so the open item takes the focus as it does after Esc (C10, sweep 34), never the page once the panel goes.
    const leaving = !!active?.closest('#details');
    if (!active || active === document.body || active.id === 'content' || leaving || (!isTyping(active) && !onOpenItem)) {
      (openKey ? rowControl(openKey) : clearRef.current)?.focus({ preventScroll: true });
    }
    // Once per arrival: later changes of the list leave focus where the person put it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, location.key]);

  // A card opened from the list (a tap on its title, its Reply or Open on the phone) is the open item too, so closing what it opened (×, Esc,
  // Back) returns to the Inbox with that item open and focused (F-026 §4, personas-34 P2 1). Kept with the entry now, as it is left at once.
  const cardHandlers = useMemo<CardHandlers>(() => ({ ...handlers, open: (item, reply) => {
    if (!inboxSettling() && item.key !== currentKey) { remember('inbox.selected', item.key); setSelected(item.key); }
    handlers.open(item, reply);
  } }), [handlers, currentKey, setSelected]);
  // Put off for later and done today, said under the list; each opens its list (#1424 E).
  const later = <InboxAside queue={queue} onBack={cameBack} />;
  const list = (
    <ul className="nyq__list" aria-label="Needs you" onFocus={() => { listFocused.current = true; }}
      onBlur={(event) => { if (event.relatedTarget) listFocused.current = event.currentTarget.contains(event.relatedTarget as Node); }}>
      {shown.map((item) => (
        <NeedsYouCard key={item.key} item={item} selected={item.key === current?.key} handlers={cardHandlers}
          compact={two || item.key !== current?.key} list={two} onSelect={() => { inboxSettled(); setSelected(item.key); }} />
      ))}
    </ul>
  );
  const empty = queue.items !== null && !shown.length;
  const clear = (
    <div className="nyq__clear">
      {moments ? <Kreska size={96} expression="done" /> : null}
      <h2 ref={clearRef} tabIndex={-1}>Nothing needs you right now</h2>
      <p>When someone asks you something, it shows up here.</p>
      <div className="nyq__clear-actions">
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
