import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import type { Project, WorkItem, WorkStatus } from '@flux/contracts';
import { ApiError, NetworkError } from '../api/client';
import { Button, Icon, IconButton, initials, type IconName } from '../ui';
import { createWork, updateWork, type ProjectWork } from './api';
import { isFinished, linked } from './format';
import './board.css';

// The Tasks board (#136, UI116-4): three columns over the existing statuses, no new status and no
// card order. A card moves by dragging with a mouse or pen, by keyboard (Space, arrows, Space) or
// with its "Move to…" menu on any device; every move is the existing versioned status command.

export type ColumnId = 'open' | 'in_progress' | 'done';

interface Column { id: ColumnId; label: string; status: WorkStatus }

export const COLUMNS: Column[] = [
  { id: 'open', label: 'Open', status: 'open' },
  { id: 'in_progress', label: 'In progress', status: 'in_progress' },
  { id: 'done', label: 'Done', status: 'done' },
];
const LABEL: Record<ColumnId, string> = { open: 'Open', in_progress: 'In progress', done: 'Done' };

/** Blocked work stays with the work in progress; work that is not pursued is finished with the done work. */
export const columnOf = (status: WorkStatus): ColumnId =>
  status === 'open' ? 'open' : status === 'in_progress' || status === 'blocked' ? 'in_progress' : 'done';

/** A short, stable label of the task's own id; the full id is its title and in Details. */
export const shortId = (id: string) => id.replace(/-/g, '').slice(0, 8).toUpperCase();

/** The board's search: the title, owner, what it waits for, or its id. */
export function matchesTask(item: WorkItem, query: string) {
  if (!query) return true;
  const q = query.toLowerCase();
  return [item.title, item.owner?.name ?? '', item.blocker ?? '', shortId(item.id), item.id].some((text) => text.toLowerCase().includes(q));
}

/** Where the task came from: its source message, thought or material version, else its plan revision. */
function origin(item: WorkItem, projectId: string): { to: string; kind: string; icon: IconName; title: string } | null {
  for (const link of item.links) {
    if (link.from.id !== item.id || link.role !== 'source') continue;
    if (link.to.type === 'message' && link.conversationId)
      return { to: `/projects/${projectId}/conversations/${link.conversationId}#message-${link.to.id}`, kind: 'From a message', icon: 'chat', title: link.toTitle };
    if (link.to.type === 'thought' && link.sketchId)
      return { to: `/projects/${projectId}/map/${link.sketchId}#thought-${link.to.id}`, kind: 'From a thought', icon: 'map', title: link.toTitle };
    if (link.to.type === 'material')
      return { to: `/materials/${link.to.id}/versions/${link.to.version}`, kind: `From material version ${link.to.version}`, icon: 'doc', title: link.toTitle };
  }
  if (item.planIntent)
    return { to: `/materials/${item.planIntent.materialId}/versions/${item.planIntent.version}`, kind: 'Planned in', icon: 'doc', title: `plan revision ${item.planIntent.version}` };
  return null;
}

/** A calm sentence for a refused or failed move; the board then shows the stored state. */
function moveError(error: unknown, title: string) {
  if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') return `“${title}” was changed by someone else a moment ago, so it was not moved. The board shows its current state.`;
  if (error instanceof ApiError && error.code === 'TASK_PREREQUISITES_UNMET') return `“${title}” was not moved: it can start or finish only when every task it waits for is done.`;
  if (error instanceof ApiError && error.status === 404) return `“${title}” is no longer available to you.`;
  if (error instanceof ApiError && error.status === 403) return 'You can read this project but not change it.';
  if (error instanceof NetworkError) return `Flux could not be reached, so “${title}” was not moved. Try again when you are online.`;
  return `“${title}” could not be moved. Its current state is shown; try again.`;
}

/** A keyboard or menu move keeps focus on its card for this long while the card is redrawn. */
const focusDeadline = () => performance.now() + 5000;

const without = <T,>(record: Record<string, T>, key: string) => {
  const next = { ...record };
  delete next[key];
  return next;
};

interface Drag {
  id: string; title: string; from: ColumnId; pointerId: number;
  x0: number; y0: number; dx: number; dy: number; width: number;
  started: boolean; cancelled: boolean; over: ColumnId | null;
}

interface Notice { tone: 'ok' | 'error'; text: string }

/** One card's "Move to…" menu: the three columns, the current one checked, then Details. */
function MoveMenu({ item, column, busy, buttonRef, onMove, onOpen, onClose }: {
  item: WorkItem; column: ColumnId; busy: boolean; buttonRef: RefObject<HTMLButtonElement | null>;
  onMove: (to: ColumnId) => void; onOpen: () => void; onClose: (restore: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; });
  useEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const choices = [...menu.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')];
    (choices.find((choice) => choice.getAttribute('aria-checked') === 'false') ?? choices[0])?.focus();
    const onPointer = (event: PointerEvent) => {
      if (!menu.contains(event.target as Node) && !buttonRef.current?.contains(event.target as Node)) close.current(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [buttonRef]);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const choices = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)') ?? [])];
    const index = choices.indexOf(document.activeElement as HTMLButtonElement);
    const focus = (next: number) => { event.preventDefault(); choices[(next + choices.length) % choices.length]?.focus(); };
    if (event.key === 'ArrowDown') focus(index + 1);
    else if (event.key === 'ArrowUp') focus(index - 1);
    else if (event.key === 'Home') focus(0);
    else if (event.key === 'End') focus(choices.length - 1);
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(true); }
    else if (event.key === 'Tab') onClose(false);
  };
  return (
    <div ref={ref} className="tb-menu" role="menu" aria-label={`Move “${item.title}”`} onKeyDown={onKeyDown}>
      <p className="tb-menu__k" aria-hidden="true">Move to</p>
      {COLUMNS.map((choice) => (
        <button key={choice.id} type="button" role="menuitemradio" className="tb-menu__i" tabIndex={-1} aria-checked={choice.id === column}
          disabled={busy} onClick={() => onMove(choice.id)}>
          <span className={`tb-ring tb-ring--${choice.id}`} aria-hidden="true" /><span>{choice.label}</span>
          {choice.id === column ? <Icon name="check" size={14} className="tb-menu__check" /> : null}
        </button>
      ))}
      <div className="tb-menu__sep" role="separator" />
      <button type="button" role="menuitem" className="tb-menu__i" tabIndex={-1} onClick={onOpen}><Icon name="panel" size={14} /><span>Open details</span></button>
    </div>
  );
}

interface CardProps {
  item: WorkItem; column: ColumnId; projectId: string; meId: string; writable: boolean; hintId: string;
  saving: boolean; dragged: boolean; lifted: boolean; arrived: boolean; menuOpen: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLLIElement>) => void;
  onClickCapture: (event: ReactMouseEvent) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onKeyUp: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onBlur: () => void;
  onOpen: () => void;
  onMenu: (open: boolean, restore?: boolean) => void;
  onMove: (to: ColumnId) => void;
}

function Card({ item, column, projectId, meId, writable, hintId, saving, dragged, lifted, arrived, menuOpen, onPointerDown, onClickCapture, onKeyDown, onKeyUp, onBlur, onOpen, onMenu, onMove }: CardProps) {
  const menuButton = useRef<HTMLButtonElement>(null);
  const from = origin(item, projectId);
  const blocked = item.status === 'blocked';
  const waiting = isFinished(item) ? 0 : item.prerequisites.filter((prerequisite) => !prerequisite.met).length;
  const results = linked(item.links, item.id, 'result').length;
  const owner = item.owner;
  const state = saving ? 'Saving…' : blocked ? 'Blocked' : item.status === 'not_pursued' ? 'Not pursued' : null;
  const classes = ['tb-card', blocked && 'tb-card--blocked', item.status === 'not_pursued' && 'tb-card--set-aside',
    dragged && 'is-dragging', lifted && 'is-lifted', arrived && 'is-arrived', saving && 'is-saving', menuOpen && 'has-menu'].filter(Boolean).join(' ');
  return (
    <li className={classes} data-card-id={item.id} aria-busy={saving || undefined}
      onPointerDown={onPointerDown} onClickCapture={onClickCapture} onDragStart={(event) => event.preventDefault()}>
      <div className="tb-card__top">
        <span className="tb-card__id" title={`Task ${item.id}`}><span className="ui-vh">Task ID </span>{shortId(item.id)}</span>
        {state ? <span className={`tb-card__state${blocked ? ' tb-card__state--blocked' : ''}`}>{blocked ? <Icon name="alert" size={12} /> : null}{state}</span> : null}
        {writable ? (
          <IconButton ref={menuButton} icon="more" size={15} label="Move to…" className="tb-card__menu" aria-haspopup="menu" aria-expanded={menuOpen}
            onClick={() => onMenu(!menuOpen)} />
        ) : null}
      </div>
      <h3 className="tb-card__t">
        <button type="button" className="tb-card__open" onClick={onOpen} onKeyDown={onKeyDown} onKeyUp={onKeyUp} onBlur={onBlur}
          aria-describedby={writable ? hintId : undefined}><span className="tb-card__title">{item.title}</span></button>
      </h3>
      {blocked ? <p className="tb-card__blocker">{item.blocker ? `Waiting for ${item.blocker}` : 'Blocked; nobody wrote down what it waits for yet.'}</p> : null}
      {from ? (
        <Link className="tb-card__from" to={from.to} draggable={false} title={`${from.kind}: ${from.title}`}>
          <Icon name={from.icon} size={12} /><span><span className="ui-vh">{from.kind}: </span>{from.title}</span>
        </Link>
      ) : null}
      <div className="tb-card__foot">
        {owner ? (
          <span className={`tb-card__owner${owner.kind === 'agent' ? ' tb-card__owner--agent' : ''}`}>
            <span className="tb-av" aria-hidden="true">{owner.kind === 'agent' ? <Icon name="agent" size={12} /> : initials(owner.name)}</span>
            <span className="tb-card__name">{owner.name}{owner.kind === 'agent' ? <span className="tb-card__kind"> · agent</span> : owner.id === meId ? <span className="tb-card__kind"> · you</span> : null}</span>
          </span>
        ) : <span className="tb-card__owner tb-card__owner--none">No owner</span>}
        {waiting || results ? (
          <span className="tb-card__facts">
            {waiting ? <span>Waits for {waiting}</span> : null}
            {results ? <span>{results} {results === 1 ? 'result' : 'results'}</span> : null}
          </span>
        ) : null}
      </div>
      {menuOpen ? (
        <MoveMenu item={item} column={column} busy={saving} buttonRef={menuButton}
          onMove={(to) => { onMenu(false); onMove(to); }}
          onOpen={() => { onMenu(false); onOpen(); }}
          onClose={(restore) => { onMenu(false); if (restore) menuButton.current?.focus(); }} />
      ) : null}
    </li>
  );
}

/** Adds a task in one column through the same creation command as the List, then opens it. */
function NewTask({ projectId, column, onDone, onCancel }: { projectId: string; column: Column; onDone: (item: WorkItem) => void; onCancel: () => void }) {
  const inputId = useId();
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  const [title, setTitle] = useState('');
  const [attempt, setAttempt] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const cancel = () => { onCancel(); opener?.focus(); };
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const item = await createWork(projectId, { title: title.trim(), ...(column.status === 'open' ? {} : { status: column.status }) }, attempt);
      setTitle(''); setAttempt(crypto.randomUUID());
      onDone(item);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not add the task.'); }
    finally { setBusy(false); }
  }
  return (
    <form className="tb-new" onSubmit={(event) => void submit(event)}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); } }}>
      <label className="ui-vh" htmlFor={inputId}>New task in {column.label}</label>
      {/* Opened on purpose by "+ Task" or a column's "+", so the field takes focus. */}
      <input id={inputId} className="ui-input tb-new__in" value={title} maxLength={200} autoFocus placeholder="What needs doing?"
        onChange={(event) => { setTitle(event.target.value); setAttempt(crypto.randomUUID()); setError(''); }} />
      <div className="tb-new__acts">
        <Button type="submit" variant="primary" busy={busy} disabled={!title.trim()}>Add task</Button>
        <Button variant="quiet" onClick={cancel}>Cancel</Button>
      </div>
      {error ? <p className="wd-error" role="alert">{error}</p> : null}
    </form>
  );
}

export interface TaskBoardProps {
  project: Project;
  lists: ProjectWork;
  meId: string;
  mine: boolean;
  /** Lowercased search text; empty shows everything. */
  query: string;
  writable: boolean;
  adding: ColumnId | null;
  onAdding: (column: ColumnId | null) => void;
  openWork: (id: string) => void;
  refresh: () => void;
  clearFilters: () => void;
}

export function TaskBoard({ project, lists, meId, mine, query, writable, adding, onAdding, openWork, refresh, clearFilters }: TaskBoardProps) {
  const hintId = useId();
  const boardRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  // Moves in flight (shown in their target column) and the stored result of each finished move
  // until the project's own data catches up with that version.
  const [pending, setPending] = useState<Record<string, ColumnId>>({});
  const [confirmed, setConfirmed] = useState<Record<string, WorkItem>>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  const [spoken, setSpoken] = useState('');
  const [arrived, setArrived] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [picked, setPicked] = useState<ColumnId | null>(null);
  const [dragging, setDragging] = useState<{ id: string; title: string; width: number; x: number; y: number } | null>(null);
  const [over, setOver] = useState<ColumnId | null>(null);
  const [lifted, setLifted] = useState<{ id: string; from: ColumnId; to: ColumnId } | null>(null);
  const drag = useRef<Drag | null>(null);
  const suppressClick = useRef(false);
  const spaceLift = useRef(false);
  const focusCard = useRef<{ id: string; until: number } | null>(null);
  const attempts = useRef(new Map<string, string>());
  const timers = useRef<{ notice?: number; arrived?: number }>({});
  const latest = useRef<WorkItem[]>([]);

  useEffect(() => {
    const pending = timers.current;
    return () => { window.clearTimeout(pending.notice); window.clearTimeout(pending.arrived); };
  }, []);

  // After a keyboard or menu move the card is drawn in another column (and again if the move is
  // refused): keep focus on it for a moment, unless the person has moved on to something else.
  useLayoutEffect(() => {
    const wanted = focusCard.current;
    if (!wanted) return;
    const active = document.activeElement;
    if (performance.now() > wanted.until || (active && active !== document.body && !active.closest(`[data-card-id="${wanted.id}"]`))) {
      focusCard.current = null;
      return;
    }
    const button = boardRef.current?.querySelector<HTMLButtonElement>(`[data-card-id="${wanted.id}"] .tb-card__open`);
    if (button && active !== button) button.focus();
  });

  const items = lists.work
    .map((item) => { const saved = confirmed[item.id]; return saved && saved.version > item.version ? saved : item; })
    // Work a pivot parked is set aside, not part of the plan: the List shows it.
    .filter((item) => !item.parked || isFinished(item));
  useEffect(() => { latest.current = items; });
  const shown = items.filter((item) => (!mine || item.owner?.id === meId) && matchesTask(item, query));
  const columnFor = (item: WorkItem) => pending[item.id] ?? columnOf(item.status);
  const cards: Record<ColumnId, WorkItem[]> = { open: [], in_progress: [], done: [] };
  for (const item of shown) cards[columnFor(item)].push(item);
  // Blocked work leads its column so it is never lost below the rest; otherwise the stored order.
  cards.in_progress.sort((a, b) => Number(b.status === 'blocked' && !(b.id in pending)) - Number(a.status === 'blocked' && !(a.id in pending)));
  const blocked = cards.in_progress.filter((item) => item.status === 'blocked' && !(item.id in pending)).length;
  // On a narrow board one column shows at a time: the one chosen, else active work, else what is open.
  const current: ColumnId = adding ?? picked ?? (cards.in_progress.length ? 'in_progress' : cards.open.length ? 'open' : 'in_progress');
  const highlight = dragging ? over : lifted && lifted.to !== lifted.from ? lifted.to : null;
  const filtered = !!query || mine;

  const say = (text: string) => setSpoken(text);
  const show = (next: Notice | null) => {
    window.clearTimeout(timers.current.notice);
    setNotice(next);
    if (next?.tone === 'ok') timers.current.notice = window.setTimeout(() => setNotice((now) => now === next ? null : now), 6000);
  };

  async function move(item: WorkItem, to: ColumnId, keepFocus: boolean) {
    const from = columnOf(item.status);
    if (from === to || item.id in pending) return;
    const status = COLUMNS.find((column) => column.id === to)!.status;
    // A retry of the same change of the same version reuses its command id (#154); another change gets a new one.
    const key = JSON.stringify([item.id, item.version, status]);
    const commandId = attempts.current.get(key) ?? crypto.randomUUID();
    attempts.current.set(key, commandId);
    if (keepFocus) focusCard.current = { id: item.id, until: focusDeadline() };
    setPending((now) => ({ ...now, [item.id]: to }));
    show(null);
    try {
      const saved = await updateWork(item, { status }, commandId);
      attempts.current.delete(key);
      setConfirmed((now) => ({ ...now, [item.id]: saved }));
      window.clearTimeout(timers.current.arrived);
      setArrived(item.id);
      timers.current.arrived = window.setTimeout(() => setArrived(null), 1200);
      show({ tone: 'ok', text: `Moved “${item.title}” to ${LABEL[to]}.` });
    } catch (cause) {
      // A refusal is final for this version; a lost response keeps its id so a retry cannot apply twice.
      if (cause instanceof ApiError) attempts.current.delete(key);
      const text = moveError(cause, item.title);
      show({ tone: 'error', text });
    } finally {
      setPending((now) => without(now, item.id));
      refresh();
    }
  }

  // ---------------------------------------------------------------- pointer dragging (mouse and pen)

  const columnAt = (x: number, y: number): ColumnId | null => {
    const hit = document.elementFromPoint(x, y);
    const column = hit instanceof Element ? hit.closest<HTMLElement>('[data-column]') : null;
    return column && boardRef.current?.contains(column) ? column.dataset.column as ColumnId : null;
  };

  const startDrag = (event: ReactPointerEvent<HTMLLIElement>, item: WorkItem, from: ColumnId) => {
    // Touch scrolls the board; touch moves use "Move to…". Links and the menu keep their own actions.
    if (!writable || event.button !== 0 || event.pointerType === 'touch' || item.id in pending || drag.current) return;
    if ((event.target as Element).closest('a, .tb-card__menu, .tb-menu')) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const state: Drag = { id: item.id, title: item.title, from, pointerId: event.pointerId, x0: event.clientX, y0: event.clientY,
      dx: event.clientX - rect.left, dy: event.clientY - rect.top, width: rect.width, started: false, cancelled: false, over: null };
    drag.current = state;
    const scroller = boardRef.current?.closest<HTMLElement>('.pane-scroll') ?? null;
    const clear = () => {
      document.documentElement.classList.remove('tb-is-dragging');
      setDragging(null);
      setOver(null);
    };
    const cancel = () => {
      if (!state.started || state.cancelled) return;
      state.cancelled = true;
      state.over = null;
      clear();
      say(`Cancelled. “${state.title}” stays in ${LABEL[state.from]}.`);
    };
    const onMove = (pointer: PointerEvent) => {
      if (pointer.pointerId !== state.pointerId || state.cancelled) return;
      if (!state.started) {
        if (Math.hypot(pointer.clientX - state.x0, pointer.clientY - state.y0) < 6) return;
        state.started = true;
        window.getSelection()?.removeAllRanges();
        document.documentElement.classList.add('tb-is-dragging');
        setMenuFor(null);
        setLifted(null);
        setDragging({ id: state.id, title: state.title, width: state.width, x: pointer.clientX - state.dx, y: pointer.clientY - state.dy });
      }
      pointer.preventDefault();
      if (ghostRef.current) ghostRef.current.style.transform = `translate(${pointer.clientX - state.dx}px, ${pointer.clientY - state.dy}px)`;
      const target = columnAt(pointer.clientX, pointer.clientY);
      const next = target && target !== state.from ? target : null;
      if (next !== state.over) { state.over = next; setOver(next); }
      // Near the top or bottom edge, the board scrolls so a long column stays reachable.
      if (scroller) {
        const box = scroller.getBoundingClientRect();
        if (pointer.clientY < box.top + 40) scroller.scrollTop -= 14;
        else if (pointer.clientY > box.bottom - 40) scroller.scrollTop += 14;
      }
    };
    const onKey = (key: KeyboardEvent) => {
      if (key.key !== 'Escape' || !state.started || state.cancelled) return;
      key.preventDefault();
      key.stopPropagation();
      cancel();
    };
    const finish = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onCancel);
      drag.current = null;
    };
    const onCancel = () => { cancel(); finish(); };
    const onUp = (pointer: PointerEvent) => {
      if (pointer.pointerId !== state.pointerId) return;
      finish();
      if (!state.started) return;
      // The click that ends a drag must not also open the card.
      suppressClick.current = true;
      window.setTimeout(() => { suppressClick.current = false; }, 0);
      if (state.cancelled) return;
      const target = state.over;
      clear();
      const now = latest.current.find((candidate) => candidate.id === state.id);
      // Dropped outside a column, or back on its own: nothing changes.
      if (target && now) void move(now, target, false);
      else say(`“${state.title}” stays in ${LABEL[state.from]}.`);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onCancel);
  };

  // Position the ghost where the drag started; later pointer moves place it directly.
  useLayoutEffect(() => {
    if (dragging && ghostRef.current) ghostRef.current.style.transform = `translate(${dragging.x}px, ${dragging.y}px)`;
  }, [dragging]);

  // ---------------------------------------------------------------- keyboard: Space, arrows, Space

  const onCardKey = (event: ReactKeyboardEvent<HTMLButtonElement>, item: WorkItem, from: ColumnId) => {
    if (!writable) return;
    if (!lifted || lifted.id !== item.id) {
      if (event.key !== ' ' || event.repeat || item.id in pending) return;
      event.preventDefault();
      spaceLift.current = true;
      setMenuFor(null);
      setLifted({ id: item.id, from, to: from });
      say(`Picked up “${item.title}” in ${LABEL[from]}. Left and Right arrows choose a column, Space moves it there, Escape cancels.`);
      return;
    }
    const index = COLUMNS.findIndex((column) => column.id === lifted.to);
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const next = COLUMNS[Math.min(COLUMNS.length - 1, Math.max(0, index + (event.key === 'ArrowRight' ? 1 : -1)))]!.id;
      setLifted({ ...lifted, to: next });
      say(next === lifted.from ? `${LABEL[next]}, where it is now.` : `${LABEL[next]}.`);
    } else if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      if (event.key === ' ') spaceLift.current = true;
      setLifted(null);
      if (lifted.to === lifted.from) say(`“${item.title}” stays in ${LABEL[lifted.from]}.`);
      else void move(item, lifted.to, true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setLifted(null);
      say(`Cancelled. “${item.title}” stays in ${LABEL[lifted.from]}.`);
    } else if (event.key === 'Tab') {
      setLifted(null);
    }
  };
  const onCardKeyUp = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    // The Space that lifts or drops a card is not also a click that opens it.
    if (event.key === ' ' && spaceLift.current) { event.preventDefault(); spaceLift.current = false; }
  };

  const dismissAdding = () => onAdding(null);
  const totals: Record<ColumnId, number> = { open: cards.open.length, in_progress: cards.in_progress.length, done: cards.done.length };

  return (
    <div className="tb-wrap">
      <p id={hintId} className="ui-vh">Space picks the task up to move it between columns. “Move to…” offers the same choices.</p>
      <p className="ui-vh" aria-live="polite">{spoken}</p>
      {/* A narrow board shows one column at a time; this overview names every status and what is blocked. */}
      <nav className="tb-overview" aria-label="Task status">
        {COLUMNS.map((column) => (
          <button key={column.id} type="button" className="tb-ov" aria-pressed={current === column.id} onClick={() => { setPicked(column.id); if (adding && adding !== column.id) dismissAdding(); }}>
            <span className="tb-ov__l"><span className={`tb-ring tb-ring--${column.id}`} aria-hidden="true" />{column.label}</span>
            <span className="tb-ov__n">{totals[column.id]}<span className="ui-vh"> {totals[column.id] === 1 ? 'task' : 'tasks'}</span>
              {column.id === 'in_progress' && blocked ? <span className="tb-ov__b"><Icon name="alert" size={12} />{blocked} blocked</span> : null}
            </span>
          </button>
        ))}
      </nav>
      {/* A confirmed move is confirmed in words; a refused one says why, calmly, until dismissed. */}
      <div className="tb-notes" role="status">
        {notice?.tone === 'ok' ? <p className="tb-note tb-note--ok"><Icon name="check" size={14} /><span>{notice.text}</span></p> : null}
      </div>
      {notice?.tone === 'error' ? (
        <div className="tb-note tb-note--error" role="alert">
          <Icon name="alert" size={14} /><span>{notice.text}</span>
          <button type="button" className="tb-note__x" onClick={() => show(null)}>Dismiss</button>
        </div>
      ) : null}
      {filtered && !shown.length ? (
        <p className="tb-none" role="status">
          {query ? `No task${mine ? ' of yours' : ''} matches “${query}”.` : 'Nothing of yours on the board.'}{' '}
          <button type="button" className="ws-none__b" onClick={clearFilters}>Show every task</button>
        </p>
      ) : null}
      <div className={`tb-board${writable ? ' tb-board--movable' : ''}`} ref={boardRef} data-current={current}>
        {COLUMNS.map((column) => {
          const list = cards[column.id];
          const headingId = `${hintId}-${column.id}`;
          return (
            <section key={column.id} className="tb-col" data-column={column.id} aria-labelledby={headingId}>
              <div className="tb-col__head">
                <span className={`tb-ring tb-ring--${column.id}`} aria-hidden="true" />
                <h2 className="tb-col__h" id={headingId}>{column.label}</h2>
                <span className="tb-col__n">{list.length}<span className="ui-vh"> {list.length === 1 ? 'task' : 'tasks'}</span></span>
                {column.id === 'in_progress' && blocked ? <span className="tb-col__b"><Icon name="alert" size={12} />{blocked} blocked</span> : null}
                {writable && column.id !== 'done' ? (
                  <IconButton icon="plus" size={15} label={`New task in ${column.label}`} className="tb-col__add" onClick={() => onAdding(column.id)} />
                ) : null}
              </div>
              <div className={`tb-col__cards${highlight === column.id ? ' is-over' : ''}`}>
                {adding === column.id ? (
                  <NewTask key={column.id} projectId={project.id} column={column} onCancel={dismissAdding}
                    onDone={(item) => { onAdding(null); refresh(); openWork(item.id); }} />
                ) : null}
                {list.length ? (
                  <ol className="tb-col__list">
                    {list.map((item) => (
                      <Card key={item.id} item={item} column={column.id} projectId={project.id} meId={meId} writable={writable} hintId={hintId}
                        saving={item.id in pending} dragged={dragging?.id === item.id} lifted={lifted?.id === item.id}
                        arrived={arrived === item.id} menuOpen={menuFor === item.id}
                        onPointerDown={(event) => startDrag(event, item, column.id)}
                        onClickCapture={(event) => { if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); } }}
                        onKeyDown={(event) => onCardKey(event, item, column.id)} onKeyUp={onCardKeyUp}
                        onBlur={() => { if (lifted?.id === item.id) { setLifted(null); say(`Cancelled. “${item.title}” stays in ${LABEL[lifted.from]}.`); } }}
                        onOpen={() => { if (lifted?.id !== item.id) openWork(item.id); }}
                        onMenu={(open) => setMenuFor(open ? item.id : null)}
                        onMove={(to) => void move(item, to, true)} />
                    ))}
                  </ol>
                ) : adding === column.id ? null : <p className="tb-col__empty">{filtered ? 'Nothing here matches.' : 'Nothing here yet.'}</p>}
              </div>
            </section>
          );
        })}
      </div>
      {dragging ? createPortal(
        <div ref={ghostRef} className="tb-ghost" aria-hidden="true" style={{ width: dragging.width }}>
          <span className="tb-card__id">{shortId(dragging.id)}</span>
          <span className="tb-ghost__t">{dragging.title}</span>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
