import { Fragment, useCallback, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import type { NeedsYouAsideEntry, NeedsYouItem } from '@flux/contracts';
import { Button, IconButton, MEDIA, Overlay, Spinner, useLeaveUndoToasts, useMediaQuery, useToast } from '../ui';
import { Face, kindWord } from './NeedsYouCard';
import { announceInboxChange } from './api';
import { ApiError } from '../api/client';
import { getNeedsYouAside, restoreNeedsYou, type Queue } from './needsYou';
import './inbox-aside.css';

type Which = 'later' | 'done';

// Which list is open lives outside the component: the line is drawn in a full and in an empty Inbox, so a put-back item that turns an empty
// Inbox into a list mounts the line again, and its window must stay as it was.
let openList: Which | null = null;
const listeners = new Set<() => void>();
const setOpenList = (which: Which | null) => { openList = which; listeners.forEach((listener) => listener()); };
const useOpenList = () => useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => openList, () => null);
/** The item put back last: its row in the Inbox takes focus once the window has closed and the row is there (F-026 §4). */
let focusKey: string | null = null;
/** How many lines are mounted: one, or none when the Inbox is not shown. */
let mounted = 0;

const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const date = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
/** "today at 14:20", "tomorrow at 08:00", "yesterday at 09:10", "Mon 17 Nov at 08:00". */
function moment(iso: string, now = new Date()) {
  const at = new Date(iso);
  const days = Math.round((new Date(at).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000);
  const day = days === 0 ? 'today' : days === 1 ? 'tomorrow' : days === -1 ? 'yesterday' : date.format(at);
  return `${day} at ${time.format(at)}`;
}

/** When it comes back, or when it was done: the line under a row's title. */
function whenLine(entry: NeedsYouAsideEntry) {
  if (entry.state === 'snoozed') return entry.until ? `Back ${moment(entry.until)}` : entry.untilTask ? `Back when #${entry.untilTask.number} is done` : 'Back later';
  return `${entry.state === 'declined' ? 'Declined' : 'Done'} ${moment(entry.at)}`;
}

/** "Kind · who · space", as every Inbox row starts (README §7 Inbox). */
function rowLine(item: NeedsYouItem) {
  const run = item.assistantChanges ?? null;
  return [run ? run.agentName : kindWord(item), run ? 'Your agent' : item.from?.name ?? (item.kind === 'blocked' ? 'your task' : null), item.about ? `about “${item.about.title}”` : item.project?.name ?? null]
    .filter(Boolean).join(' · ');
}

const TITLE: Record<Which, string> = { later: 'For later', done: 'Done today' };
const ACTION: Record<Which, string> = { later: 'Bring back now', done: 'Put back' };

/**
 * The line under the Inbox, "2 for later · 4 done today" (founder decision, Hubert, 2026-11-15, #1424 E), and the lists it opens: what Not now
 * put off, with when it comes back and Bring back now, and what was marked done in the last 24 hours, with Put back. Both are Undo of the
 * person's own choice (`DELETE /api/v1/needs-you/:key`). Nothing here touches the Inbox's own keys: while the window is open the Inbox is inert.
 */
export function InboxAside({ queue }: { queue: Queue }) {
  const which = useOpenList();
  // Once the window is closed and the item it put back is in the list, that item's row takes focus (never the page itself).
  useEffect(() => {
    if (!focusKey || which) return;
    const row = document.querySelector<HTMLElement>(`.nyq__list .nyc[data-key="${CSS.escape(focusKey)}"] .nyc__open`);
    if (!row) return;
    focusKey = null;
    row.focus({ preventScroll: false });
  });
  // A window left open when the Inbox goes (another page) does not reopen when the Inbox is next shown; the line mounted again in another
  // place of the same Inbox keeps it.
  useEffect(() => {
    mounted += 1;
    return () => {
      mounted -= 1;
      setTimeout(() => { if (!mounted && openList) setOpenList(null); }, 0);
    };
  }, []);
  const parts: { which: Which; label: string }[] = [
    ...(queue.later ? [{ which: 'later' as const, label: `${queue.later} for later` }] : []),
    ...(queue.doneToday ? [{ which: 'done' as const, label: `${queue.doneToday} done today` }] : []),
  ];
  return (
    <>
      {parts.length ? (
        <p className="nyq__later nyq-aside__line">
          {parts.map((part, at) => (
            <Fragment key={part.which}>
              {at ? <span aria-hidden="true"> · </span> : null}
              <Button variant="link" size="sm" className="nyq-aside__open" aria-haspopup="dialog" onClick={() => setOpenList(part.which)}>{part.label}</Button>
            </Fragment>
          ))}
        </p>
      ) : null}
      <AsideWindow which={which} queue={queue} />
    </>
  );
}

function AsideWindow({ which, queue }: { which: Which | null; queue: Queue }) {
  const phone = useMediaQuery(MEDIA.phone);
  const close = useCallback(() => setOpenList(null), []);
  // The window has its own way back (Bring back now, Put back): an Undo toast leaves as it opens, and never floats over its rows.
  const leaveUndo = useLeaveUndoToasts();
  useEffect(() => { if (which) leaveUndo(); }, [which, leaveUndo]);
  return (
    <Overlay open={which !== null} onClose={close} placement={phone ? 'bottom' : 'center'} labelledBy="nyq-aside-title" className="nyq-aside-win">
      {which ? <AsideList key={which} which={which} queue={queue} onClose={close} /> : null}
    </Overlay>
  );
}

function AsideList({ which, queue, onClose }: { which: Which; queue: Queue; onClose: () => void }) {
  const toast = useToast();
  const [entries, setEntries] = useState<NeedsYouAsideEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  // What was put back here: shown in the Inbox when the window closes, so the Inbox behind it does not change while it is open.
  const back = useRef<{ item: NeedsYouItem; restored: Promise<unknown> }[]>([]);
  const latest = useRef(queue);
  useEffect(() => { latest.current = queue; });

  useEffect(() => {
    const controller = new AbortController();
    getNeedsYouAside(controller.signal).then((response) => {
      if (controller.signal.aborted) return;
      setEntries(response[which]);
      setFailed(false);
    }, (error: unknown) => { if (!controller.signal.aborted && !(error instanceof DOMException && error.name === 'AbortError')) setFailed(true); });
    return () => controller.abort();
  }, [which, attempt]);

  // The window opens with its first row's button focused (F-026 §4: a list opens on its first control), once the rows are there.
  const loaded = entries !== null;
  useEffect(() => {
    if (!loaded) return;
    const active = document.activeElement;
    if (!active || active === document.body || active.classList.contains('ui-overlay__surface')) listRef.current?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
  }, [loaded]);

  // Closing (Esc, ×, the scrim, or the last row leaving) puts what came back into the Inbox and reads it again.
  useEffect(() => () => {
    const brought = back.current;
    back.current = [];
    if (!brought.length) return;
    for (const { item, restored } of brought) latest.current.show(item, restored);
    focusKey = brought.at(-1)!.item.key;
    void Promise.allSettled(brought.map((entry) => entry.restored)).then(announceInboxChange);
  }, []);

  const bring = (entry: NeedsYouAsideEntry, button: HTMLElement) => {
    if (!entries) return;
    const at = entries.indexOf(entry);
    const rest = entries.filter((other) => other !== entry);
    // Focus goes to the next row's button where it was, else the previous one (F-026 §4); with no row left, the window closes.
    const buttons = [...(listRef.current?.querySelectorAll<HTMLElement>('.nyq-aside__act') ?? [])];
    const next = buttons[at + 1] ?? buttons[at - 1] ?? null;
    if (next && next !== button) next.focus({ preventScroll: true });
    setEntries(rest);
    const restored = restoreNeedsYou(entry.item.key);
    back.current.push({ item: entry.item, restored });
    restored.catch((error: unknown) => {
      back.current = back.current.filter((other) => other.item.key !== entry.item.key);
      setEntries((list) => (list && !list.includes(entry) ? [...list.slice(0, at), entry, ...list.slice(at)] : list));
      // A task changed since its Done says so in its own words (personas-33).
      toast({ message: error instanceof ApiError && error.code === 'NEEDS_YOU_TASK_CHANGED' ? error.message : 'That did not work. Try again.', tone: 'danger' });
    });
    if (!rest.length) onClose();
  };

  // The arrow keys move between the rows' buttons, as Tab does.
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = [...(listRef.current?.querySelectorAll<HTMLElement>('.nyq-aside__act') ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLElement);
    const next = buttons[event.key === 'ArrowDown' ? Math.min(buttons.length - 1, at + 1) : Math.max(0, at - 1)];
    if (!next) return;
    event.preventDefault();
    next.focus();
  };

  return (
    <div className="nyq-aside">
      <div className="nyq-aside__head">
        <h2 id="nyq-aside-title">{TITLE[which]}</h2>
        <IconButton icon="x" label={`Close ${TITLE[which].toLowerCase()}`} onClick={onClose} />
      </div>
      {failed && !entries ? (
        <p className="nyq-aside__note" role="alert">This couldn’t be loaded. <Button variant="link" size="sm" onClick={() => setAttempt((n) => n + 1)}>Try again</Button></p>
      ) : !entries ? (
        <p className="nyq-aside__note"><Spinner label="Loading" /></p>
      ) : !entries.length ? (
        <p className="nyq-aside__note">{which === 'later' ? 'Nothing is put off.' : 'Nothing was marked done today.'}</p>
      ) : (
        <ul className="nyq-aside__list" ref={listRef} onKeyDown={onKeyDown} aria-labelledby="nyq-aside-title">
          {entries.map((entry) => (
            <li key={entry.item.key} className="nyq-aside__row" data-key={entry.item.key}>
              <Face item={entry.item} />
              <div className="nyq-aside__b">
                <span className="nyq-aside__k">{rowLine(entry.item)}</span>
                <span className="nyq-aside__t">{entry.item.title}</span>
                <span className="nyq-aside__k">{whenLine(entry)}</span>
              </div>
              <Button variant="secondary" size="sm" className="nyq-aside__act" aria-label={`${ACTION[which]}: ${entry.item.title}`}
                onClick={(event) => bring(entry, event.currentTarget)}>{ACTION[which]}</Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
