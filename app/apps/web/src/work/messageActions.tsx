import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { ConversationMessage } from '@flux/contracts';
import { Icon, Kreska, useMediaQuery, useToast, type IconName } from '../ui';
import { useShellActions } from '../app/shellContext';
import { useShellData } from '../app/data';
import { useNeedsYou } from '../notifications/needsYou';
import { useNeedsYouActions } from '../notifications/useNeedsYouActions';
import './message-actions.css';

// Actions on one message (F-026 S6). On a computer they appear on hover and focus: reply in a thread,
// create a task, and a menu with the rest. On a phone they are two gestures, a long press (the message menu)
// and a swipe right (Reply in thread), plus the same menu for keyboards and screen readers (founder direction
// 2026-10-16 on #343). A message has no done or snooze state, so nothing swipes left; Done and Not now are in
// the menu only for a message that is waiting in the person's Inbox. Decisions and results stay in the menu.

/**
 * A private direct-message bubble (#536, #537): reply in its thread and create a task from an excerpt. Nothing
 * else is offered (no decision, result, hand-off or Details), because none of those exist for a private message.
 */
export interface DmActionOptions {
  kind: 'dm';
  /** The message, to find the Inbox item it raised (a question or an @mention), if any. */
  messageId?: string;
  /** The message text, for Copy text. */
  body: string;
  /** False when the conversation takes no new messages (a 1:1 whose other person left). */
  writable: boolean;
  /** Creating a task needs a project the person can change; the preview says so when there is none. */
  onCreateWork: () => void;
  onReply?: () => void;
  onCite?: undefined;
}

export interface MessageActionOptions {
  kind?: 'project';
  projectId: string;
  message: ConversationMessage;
  writable: boolean;
  /** A task is being made from this message. */
  /** Makes a task from the message and opens it in Details. */
  onCreateWork: () => void;
  /** Opens the thread beside the stream for a reply, or focuses the reply field. */
  onReply?: () => void;
  /** Quotes the message into the composer. */
  onCite?: () => void;
  /** Opens the project map with this message ready to become a thought. */
  onAddToMap?: () => void;
}

const messageOf = (options: MessageActionOptions | DmActionOptions) => options.kind === 'dm' ? options.messageId ?? null : options.message.id;

interface MenuItem { id: string; label: string; icon: IconName | 'kreska'; run: () => void; disabled?: boolean; secondary?: boolean }

/** The menu's items, in the drawn order: reply, task, hand off, cite, copy; then what makes objects. */
function useMenuItems(options: MessageActionOptions | DmActionOptions | null, touch: boolean): MenuItem[] {
  const { openDetails } = useShellActions();
  const { me } = useShellData();
  const toast = useToast();
  if (!options) return [];
  const text = options.kind === 'dm' ? options.body : options.message.body;
  const copy = () => {
    const done = () => toast({ message: 'Copied', timeout: 2000 });
    const failed = () => toast({ message: 'Could not copy this text', tone: 'danger' });
    if (!navigator.clipboard) { failed(); return; }
    navigator.clipboard.writeText(text).then(done, failed);
  };
  const copyItem: MenuItem[] = text ? [{ id: 'copy', label: 'Copy text', icon: 'copy', run: copy }] : [];
  if (options.kind === 'dm') {
    return [
      ...(options.writable && options.onReply ? [{ id: 'reply', label: 'Reply in thread', icon: 'reply' as const, run: options.onReply }] : []),
      ...(options.writable ? [{ id: 'task', label: 'Create task', icon: 'plus-circle' as const, run: options.onCreateWork }] : []),
      ...copyItem,
    ];
  }
  const { projectId, message, writable, onCreateWork, onReply, onCite, onAddToMap } = options;
  const source = { messageId: message.id, text: message.body };
  const details: MenuItem = { id: 'details', label: 'Details', icon: 'panel', secondary: true,
    run: () => openDetails({ kind: 'overview', messageId: message.id, selection: { accountId: me.user.id, projectId, message } }) };
  if (!writable) return [...copyItem, details];
  return [
    ...(onReply ? [{ id: 'reply', label: 'Reply in thread', icon: 'reply' as const, run: onReply }] : []),
    ...(touch ? [{ id: 'task', label: 'Create task', icon: 'plus-circle' as const, run: onCreateWork }] : []),
    ...(onAddToMap ? [{ id: 'map', label: 'Add to map', icon: 'map' as const, run: onAddToMap }] : []),
    // There is no hand-off command yet (#347): a hand-off is a task, so it is made and opened in Details,
    // where its owner is chosen.
    { id: 'handoff', label: 'Hand off to an agent', icon: 'kreska', run: onCreateWork },
    ...(onCite ? [{ id: 'cite', label: 'Cite', icon: 'cite' as const, run: onCite }] : []),
    ...copyItem,
    { id: 'decision', label: 'Propose a decision', icon: 'rule', secondary: true, run: () => openDetails({ kind: 'propose-decision', projectId, source }) },
    { id: 'result', label: 'Attach a result', icon: 'result', secondary: true, run: () => openDetails({ kind: 'attach-result', projectId, source }) },
    details,
  ];
}

/**
 * Done and Not now for a message that is waiting in the person's Inbox (a question to them or an @mention),
 * acting on that item exactly as the Inbox does (#343, founder direction 2026-10-16). Other messages get
 * nothing: Inbox stays the one queue and a message has no state of its own. Read when the menu opens.
 */
function useWaiting(messageId: string | null): MenuItem[] {
  const { me } = useShellData();
  const queue = useNeedsYou(me.user.id);
  const handlers = useNeedsYouActions(queue);
  const item = messageId ? queue.items?.find((entry) => entry.url.endsWith(`#message-${messageId}`)) : undefined;
  if (!item) return [];
  return [
    { id: 'inbox-done', label: 'Done', icon: 'check', secondary: true, run: () => handlers.done(item) },
    { id: 'inbox-later', label: 'Not now', icon: 'clock', secondary: true, run: () => handlers.snooze(item, 'tomorrow') },
  ];
}

/** A menu under its anchor: arrow keys, Escape and a click outside close or move; focus returns to the opener. */
function MessageMenu({ items: own, anchor, press, onClose, label, messageId }: { items: MenuItem[]; anchor: HTMLElement; press: boolean; onClose: (restoreFocus: boolean) => void; label: string; messageId: string | null }) {
  const items = [...own, ...useWaiting(messageId)];
  const menu = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<CSSProperties>({ top: 0, left: 0, opacity: 0 });
  useLayoutEffect(() => {
    const node = menu.current;
    if (!node) return;
    const box = anchor.getBoundingClientRect();
    const { offsetWidth: width, offsetHeight: height } = node;
    const left = Math.max(12, Math.min(press ? box.left : box.right - width, window.innerWidth - width - 12));
    const below = box.bottom + 8;
    const top = below + height > window.innerHeight - 12 ? Math.max(12, box.top - height - 8) : below;
    setPlace({ top, left });
  }, [anchor, items.length, press]);
  useEffect(() => { menu.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true }); }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = [...menu.current!.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')];
    const at = buttons.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => { event.preventDefault(); buttons[(to + buttons.length) % buttons.length]?.focus(); };
    if (event.key === 'ArrowDown') move(at + 1);
    else if (event.key === 'ArrowUp') move(at < 0 ? -1 : at - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(-1);
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(true); }
    else if (event.key === 'Tab') { event.preventDefault(); onClose(true); }
  };
  const primary = items.filter((item) => !item.secondary);
  const secondary = items.filter((item) => item.secondary);
  const render = (item: MenuItem) => (
    <button key={item.id} type="button" role="menuitem" className="msg-menu__item" data-action={item.id} disabled={item.disabled}
      onClick={() => { onClose(false); item.run(); }}>
      {item.icon === 'kreska' ? <Kreska size={18} /> : <Icon name={item.icon} size={18} />}{item.label}
    </button>
  );
  return createPortal(
    <>
      <div className={`msg-menu__scrim${press ? ' is-press' : ''}`} onPointerDown={() => onClose(false)} />
      <div ref={menu} className={`msg-menu${press ? ' is-press' : ''}`} role="menu" aria-label={label} style={place} onKeyDown={onKeyDown}>
        {primary.map(render)}
        {secondary.length && primary.length ? <div className="msg-menu__sep" role="separator" /> : null}
        {secondary.map(render)}
      </div>
    </>,
    document.body,
  );
}

/**
 * The computer's actions on one message: reply in thread, create a task and a menu. They appear over the
 * message's corner on hover and focus and take no room in the stream; a phone has gestures instead.
 */
export function MessageActions(options: MessageActionOptions | DmActionOptions) {
  const touch = useMediaQuery('(hover: none)');
  const items = useMenuItems(options, touch);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const more = useRef<HTMLButtonElement>(null);
  const group = useRef<HTMLDivElement>(null);
  const { writable, onCreateWork, onReply } = options;
  // Guide §4: R replies in the thread and T makes a task while focus is inside this message (not in a field).
  useEffect(() => {
    const row = group.current?.parentElement;
    if (!row) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.repeat || event.defaultPrevented) return;
      if ((event.target as Element | null)?.closest?.('input, textarea, select, [contenteditable], [role="menu"]')) return;
      const key = event.key.toLowerCase();
      if (key === 'r' && writable && onReply) { event.preventDefault(); onReply(); }
      else if (key === 't' && writable) { event.preventDefault(); onCreateWork(); }
    };
    row.addEventListener('keydown', onKey);
    return () => row.removeEventListener('keydown', onKey);
  }, [touch, writable, onReply, onCreateWork]);
  if (touch) return null;
  return (
    <div ref={group} className="msg-acts" role="group" aria-label={options.kind === 'dm' ? 'Actions on this message' : 'Message actions'}>
      {writable && onReply ? <button type="button" className="msg-acts__b" aria-label="Reply in thread" data-tip="Reply in thread (R)" aria-keyshortcuts="R" onClick={onReply}><Icon name="reply" size={16} /></button> : null}
      {writable ? <button type="button" className="msg-acts__b" aria-label="Create task" data-tip="Create task (T)" aria-keyshortcuts="T" onClick={onCreateWork}><Icon name="plus-circle" size={16} /></button> : null}
      <button ref={more} type="button" className="msg-acts__b" aria-label="More actions" data-tip="More actions" aria-haspopup="menu" aria-expanded={!!anchor} onClick={(event) => setAnchor(anchor ? null : event.currentTarget)}><Icon name="more" size={16} /></button>
      {anchor ? <MessageMenu items={items} anchor={anchor} press={false} label="Message actions" messageId={messageOf(options)}
        onClose={(restore) => { setAnchor(null); if (restore) more.current?.focus(); }} /> : null}
    </div>
  );
}

/** A swipe right this far replies in the thread; the row follows the finger up to REPLY_MAX and springs back. */
const REPLY_AT = 64;
const REPLY_MAX = 88;
const HOLD_MS = 450;
const MOVE_SLOP = 10;

interface TouchProps<E extends HTMLElement> {
  ref: RefObject<E | null>;
  className: string;
  style?: CSSProperties;
  onPointerDown?: (event: ReactPointerEvent<E>) => void;
  onPointerMove?: (event: ReactPointerEvent<E>) => void;
  onPointerUp?: (event: ReactPointerEvent<E>) => void;
  onPointerCancel?: () => void;
  onContextMenu?: (event: MouseEvent<E>) => void;
  onClickCapture?: (event: MouseEvent<E>) => void;
}

/**
 * The phone's gestures on one message (S6, founder direction 2026-10-16): a swipe right opens Reply in thread
 * (the WhatsApp, Telegram and iMessage habit) and a long press opens the message menu. Both belong to the touch
 * pointer only; nothing swipes left. The returned props go on the message's list item and `node` inside it.
 * A visually hidden button opens the same menu for keyboards and screen readers, who cannot long press, and a
 * computer's Reply button does the same as the swipe, so a gesture is never the only way to an action.
 */
export function useTouchActions<E extends HTMLElement = HTMLLIElement>(options: MessageActionOptions | DmActionOptions | null): { props: TouchProps<E>; node: ReactNode } {
  const touch = useMediaQuery('(hover: none)');
  const items = useMenuItems(options, touch);
  const ref = useRef<E>(null);
  const [menu, setMenu] = useState<{ kind: 'press' | 'button'; anchor: HTMLElement } | null>(null);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const gesture = useRef<{ x: number; y: number; mode: 'idle' | 'swipe' | 'dead'; timer: number; interactive: boolean } | null>(null);
  const swallow = useRef(false);
  const opener = useRef<HTMLElement | null>(null);
  const { onReply, writable } = options ?? { onReply: undefined, writable: false };
  const replies = !!(writable && onReply);

  // A gesture's own timer is cancelled before the gesture is dropped, and a timer only acts for the gesture that set it.
  const clearTimer = (g = gesture.current) => { if (g) window.clearTimeout(g.timer); };
  useEffect(() => () => clearTimer(), []);

  if (!touch || !options) return { props: { ref, className: '' }, node: null };

  const openPress = (row: HTMLElement) => {
    opener.current = row;
    setMenu({ kind: 'press', anchor: row.querySelector<HTMLElement>('.message-bubble > .message-body, .dm-msg__body') ?? row });
    try { navigator.vibrate?.(8); } catch { /* optional */ }
  };
  const props = {
    ref,
    className: `msg-touch${dragging ? ' is-dragging' : ''}${offset ? ' is-swiped' : ''}`,
    style: offset ? { transform: `translateX(${offset}px)` } : undefined,
    onPointerDown: (event: ReactPointerEvent<E>) => {
      swallow.current = false;
      if (event.pointerType !== 'touch') return;
      const row = event.currentTarget;
      const interactive = !!(event.target as Element).closest('a, button, input, textarea, select, [role="button"]');
      clearTimer();
      const g: NonNullable<typeof gesture.current> = { x: event.clientX, y: event.clientY, mode: 'idle', timer: 0, interactive };
      if (!interactive) g.timer = window.setTimeout(() => {
        if (gesture.current === g && g.mode === 'idle') { g.mode = 'dead'; openPress(row); }
      }, HOLD_MS);
      gesture.current = g;
    },
    onPointerMove: (event: ReactPointerEvent<E>) => {
      const g = gesture.current;
      if (!g || g.mode === 'dead' || event.pointerType !== 'touch') return;
      const dx = event.clientX - g.x;
      const dy = event.clientY - g.y;
      if (g.mode === 'idle') {
        if (Math.abs(dy) > MOVE_SLOP && Math.abs(dy) > Math.abs(dx)) { clearTimer(); g.mode = 'dead'; return; }
        if (replies && dx > MOVE_SLOP && Math.abs(dx) > Math.abs(dy) * 1.5) { clearTimer(); g.mode = 'swipe'; setDragging(true); }
        else { if (Math.abs(dx) > MOVE_SLOP) clearTimer(); return; }
      }
      // Only rightwards, and only as far as the hint needs.
      setOffset(Math.max(0, Math.min(REPLY_MAX, dx)));
    },
    onPointerUp: (event: ReactPointerEvent<E>) => {
      const g = gesture.current;
      gesture.current = null;
      if (!g) return;
      clearTimer(g);
      if (g.mode !== 'swipe') return;
      setDragging(false);
      swallow.current = true;
      setOffset(0);
      if (event.clientX - g.x >= REPLY_AT) onReply?.();
    },
    onPointerCancel: () => { clearTimer(); gesture.current = null; if (dragging) { setDragging(false); setOffset(0); } },
    // Android raises a context menu after a long press: the message menu is the answer, not the browser's.
    onContextMenu: (event: MouseEvent<E>) => { event.preventDefault(); if (!menu) openPress(event.currentTarget); },
    onClickCapture: (event: MouseEvent<E>) => { if (swallow.current) { swallow.current = false; event.preventDefault(); event.stopPropagation(); } },
  };
  const node = (
    <>
      <span className={`msg-swipe${offset >= REPLY_AT ? ' is-ready' : ''}`} aria-hidden="true" hidden={!offset}><Icon name="reply" size={20} /></span>
      <button type="button" className="msg-touch__sr" aria-haspopup="menu" aria-expanded={menu?.kind === 'button'} onClick={(event) => { opener.current = event.currentTarget; setMenu({ kind: 'button', anchor: event.currentTarget.parentElement?.querySelector<HTMLElement>('.message-bubble > .message-body, .dm-msg__body') ?? event.currentTarget }); }}>Message actions</button>
      {menu ? <MessageMenu items={items} anchor={menu.anchor} press={menu.kind === 'press'} label="Message actions" messageId={messageOf(options)}
        onClose={(restore) => { setMenu(null); if (restore) opener.current?.focus({ preventScroll: true }); }} /> : null}
    </>
  );
  return { props, node };
}
