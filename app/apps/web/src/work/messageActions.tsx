import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { ConversationMessage } from '@flux/contracts';
import { Icon, useMediaQuery, usePop, useToast, type IconName } from '../ui';
import './message-actions.css';

// Actions on one message (F-026 S6, #867). On a computer they appear on hover and focus: Reply in thread, Create task and ⋯. On a phone
// they are two gestures, a long press (the message menu) and a swipe right (Reply in thread), plus the same menu for keyboards and
// screen readers (founder direction 2026-10-16 on #343). A message has no done or snooze state, so nothing swipes left.
// The ⋯ menu is one level, in the same order everywhere: Add to map, Copy link, then (on your own messages) Edit and Delete.
// The phone's list starts with the two actions the computer shows beside the message.

/**
 * A private direct-message bubble (#536, #537): reply in its thread, create a task from an excerpt, add its words to My map and copy
 * its link. Nothing else is offered, because nothing else exists for a private message.
 */
export interface DmActionOptions {
  kind: 'dm';
  dmId: string;
  messageId?: string;
  /** The message text, for Add to map. */
  body: string;
  /** False when the conversation takes no new messages (a 1:1 whose other person left). */
  writable: boolean;
  /** Creating a task needs a project the person can change; the preview says so when there is none. */
  onCreateWork: () => void;
  onReply?: () => void;
  /** Puts the words on My map. */
  onAddToMap?: () => void;
}

export interface MessageActionOptions {
  kind?: 'project';
  projectId: string;
  message: ConversationMessage;
  writable: boolean;
  /** Makes a task from the message and opens it in Details. */
  onCreateWork: () => void;
  /** Opens the thread beside the stream for a reply, or focuses the reply field. */
  onReply?: () => void;
  /** Opens the project map with this message ready to become a thought. */
  onAddToMap?: () => void;
}

/** `secondary` items sit below a line, apart from the rest (Edit and Delete, on a person's own messages). */
interface MenuItem { id: string; label: string; icon: IconName; run: () => void; disabled?: boolean; secondary?: boolean }

/** A message's own address: a project's message opens in its thread, a private one in its conversation. */
const linkOf = (options: MessageActionOptions | DmActionOptions) => `${window.location.origin}${options.kind === 'dm'
  ? `/dm/${options.dmId}${options.messageId ? `#message-${options.messageId}` : ''}`
  : `/projects/${options.projectId}/messages/${options.message.id}`}`;

/**
 * The menu's items, in the one order: Reply in thread and Create task (only where the message has no toolbar beside it, that is on a
 * phone), then Add to map and Copy link. The same list on every device and for every kind of message.
 */
function useMenuItems(options: MessageActionOptions | DmActionOptions | null, touch: boolean): MenuItem[] {
  const toast = useToast();
  if (!options) return [];
  const copy = () => {
    const done = () => toast({ message: 'Link copied', timeout: 2000 });
    const failed = () => toast({ message: 'Could not copy the link', tone: 'danger' });
    if (!navigator.clipboard) { failed(); return; }
    navigator.clipboard.writeText(linkOf(options)).then(done, failed);
  };
  const { writable, onCreateWork, onReply, onAddToMap } = options;
  return [
    ...(touch && writable && onReply ? [{ id: 'reply', label: 'Reply in thread', icon: 'reply' as const, run: onReply }] : []),
    ...(touch && writable ? [{ id: 'task', label: 'Create task', icon: 'plus-circle' as const, run: onCreateWork }] : []),
    ...(writable && onAddToMap ? [{ id: 'map', label: 'Add to map', icon: 'map' as const, run: onAddToMap }] : []),
    { id: 'link', label: 'Copy link', icon: 'link' as const, run: copy },
  ];
}

/** A menu under its anchor: arrow keys, Escape and a click outside close or move; focus returns to the opener. */
function MessageMenu({ items, anchor, press, onClose, label, popProps }: { items: MenuItem[]; anchor: HTMLElement; press: boolean; onClose: (restoreFocus: boolean) => void; label: string; popProps: ReturnType<typeof usePop>['props'] }) {
  const menu = useRef<HTMLDivElement>(null);
  const lift = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<CSSProperties>({ top: 0, left: 0, opacity: 0 });
  const [lifted, setLifted] = useState<CSSProperties | null>(null);
  // A long press lifts the pressed bubble above the blur and anchors the menu directly under it (F-026
  // `phone-messagemenu.webp`, #763 B3): a copy of the bubble, so the stream itself never moves or re-stacks.
  useLayoutEffect(() => {
    const node = menu.current;
    if (!node) return;
    const { offsetWidth: width, offsetHeight: height } = node;
    const bubble = press ? anchor.closest<HTMLElement>('.message-bubble, .dm-msg__bubble') ?? anchor : null;
    if (bubble && lift.current) {
      const box = bubble.getBoundingClientRect();
      const copy = bubble.cloneNode(true) as HTMLElement;
      copy.removeAttribute('id');
      for (const element of copy.querySelectorAll('[id]')) element.removeAttribute('id');
      for (const element of copy.querySelectorAll<HTMLElement>('a, button, input, textarea, select, [tabindex]')) element.setAttribute('tabindex', '-1');
      // The copy leaves the rules that styled it through its ancestors behind, so it carries its own look.
      const look = getComputedStyle(bubble);
      for (const name of ['background-color', 'color', 'border-radius', 'padding', 'font', 'box-shadow', 'border', 'line-height'] as const) copy.style.setProperty(name, look.getPropertyValue(name));
      copy.style.margin = '0';
      copy.style.width = `${box.width}px`;
      copy.style.maxWidth = 'none';
      lift.current.replaceChildren(copy);
      const tall = Math.min(box.height, Math.round(window.innerHeight * 0.4));
      const gap = 8;
      const top = Math.max(12, Math.min(box.top, window.innerHeight - 12 - tall - gap - height));
      const left = Math.max(12, Math.min(box.left, window.innerWidth - width - 12));
      setLifted({ top, left: box.left, width: box.width, height: tall, borderRadius: look.borderRadius });
      setPlace({ top: top + tall + gap, left });
      return;
    }
    const box = anchor.getBoundingClientRect();
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
    <button key={item.id} type="button" role="menuitem" className="msg-menu__item" data-action={item.id} disabled={item.disabled} onClick={() => { onClose(false); item.run(); }}>
      <Icon name={item.icon} size={18} />{item.label}
    </button>
  );
  return createPortal(
    <>
      <div {...popProps} data-pop-fade="" className={`msg-menu__scrim${press ? ' is-press' : ''}`} onPointerDown={() => onClose(false)} />
      {press ? <div {...popProps} data-pop-fade="" ref={lift} className="msg-menu__lift" aria-hidden="true" style={lifted ?? { opacity: 0 }} onPointerDown={() => onClose(false)} /> : null}
      <div {...popProps} ref={menu} className={`msg-menu${press ? ' is-press' : ''}`} role="menu" aria-label={label} style={place} onKeyDown={onKeyDown}>
        {primary.map(render)}
        {secondary.length && primary.length ? <div className="msg-menu__sep" role="separator" /> : null}
        {secondary.map(render)}
      </div>
    </>,
    document.body,
  );
}

/**
 * The menu and its scrim leave as they came (#593 AC-1): the opener keeps the last anchor and says whether the menu is `open`; a
 * closed menu stays mounted for --dur-out, inert, while focus is already back on its opener.
 */
function MessageMenuHost({ open, ...props }: { open: boolean; items: MenuItem[]; anchor: HTMLElement; press: boolean; onClose: (restoreFocus: boolean) => void; label: string }) {
  const pop = usePop(open);
  return pop.mounted ? <MessageMenu {...props} popProps={pop.props} /> : null;
}

/**
 * The computer's actions on one message: reply in thread, create a task and a menu. They appear over the
 * message's corner on hover and focus and take no room in the stream; a phone has gestures instead.
 */
export function MessageActions(options: MessageActionOptions | DmActionOptions) {
  const touch = useMediaQuery('(hover: none)');
  const items = useMenuItems(options, touch);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const group = useRef<HTMLDivElement>(null);
  const { writable, onCreateWork, onReply } = options;
  // Guide §4: R replies in the thread and T makes a task while focus is inside this message (not in a field).
  useEffect(() => {
    const row = group.current?.parentElement;
    if (!row) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.repeat || event.defaultPrevented) return;
      if ((event.target as Element | null)?.closest?.('input, textarea, select, [role="combobox"], [role="listbox"], [contenteditable], [role="menu"]')) return;
      const key = event.key.toLowerCase();
      if (key === 'r' && writable && onReply) { event.preventDefault(); onReply(); }
      else if (key === 't' && writable) { event.preventDefault(); onCreateWork(); }
    };
    row.addEventListener('keydown', onKey);
    return () => row.removeEventListener('keydown', onKey);
  }, [touch, writable, onReply, onCreateWork]);
  if (touch) return null;
  return (
    <div ref={group} className="msg-acts ui-reveal" role="group" aria-label={options.kind === 'dm' ? 'Actions on this message' : 'Message actions'}>
      {writable && onReply ? <button type="button" className="msg-acts__b" aria-label="Reply in thread" data-tip="Reply in thread (R)" aria-keyshortcuts="R" onClick={onReply}><Icon name="reply" size={16} /></button> : null}
      {writable ? <button type="button" className="msg-acts__b" aria-label="Create task" data-tip="Create task (T)" aria-keyshortcuts="T" onClick={onCreateWork}><Icon name="plus-circle" size={16} /></button> : null}
      <button ref={more} type="button" className="msg-acts__b" aria-label="More actions" data-tip="More actions" aria-haspopup="menu" aria-expanded={open} onClick={(event) => { if (open) setOpen(false); else { setAnchor(event.currentTarget); setOpen(true); } }}><Icon name="more" size={16} /></button>
      {anchor ? <MessageMenuHost open={open} items={items} anchor={anchor} press={false} label="Message actions"
        onClose={(restore) => { setOpen(false); if (restore) more.current?.focus(); }} /> : null}
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
  // The last menu stays (inert) while it leaves; `menu` is the open one, if any.
  const [last, setLast] = useState<{ kind: 'press' | 'button'; anchor: HTMLElement } | null>(null);
  const [shown, setShown] = useState(false);
  const menu = shown ? last : null;
  const setMenu = (next: { kind: 'press' | 'button'; anchor: HTMLElement } | null) => { if (next) { setLast(next); setShown(true); } else setShown(false); };
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
      <button type="button" className="msg-touch__sr" aria-haspopup="menu" aria-expanded={menu?.kind === 'button'} onClick={(event) => { opener.current = event.currentTarget; setMenu({ kind: 'button', anchor: event.currentTarget.parentElement?.querySelector<HTMLElement>('.message-bubble > .message-body, .dm-msg__body') ?? event.currentTarget }); }}><Icon name="more" size={16} /><span className="msg-touch__label">Message actions</span></button>
      {last ? <MessageMenuHost open={shown} items={items} anchor={last.anchor} press={last.kind === 'press'} label="Message actions"
        onClose={(restore) => { setMenu(null); if (restore) opener.current?.focus({ preventScroll: true }); }} /> : null}
    </>
  );
  return { props, node };
}
