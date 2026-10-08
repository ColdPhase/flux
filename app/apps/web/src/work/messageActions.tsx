import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { ConversationMessage } from '@flux/contracts';
import { Icon, Kreska, useMediaQuery, useToast, type IconName } from '../ui';
import { useShellActions } from '../app/shellContext';
import { useShellData } from '../app/data';
import './message-actions.css';

// Actions on one message (F-026 S6). On a computer they appear on hover and focus: reply in a thread,
// create a task, and a menu with the rest. On a phone they are two gestures, swipe left (reply, task,
// hand off) and long press (the message menu), plus the same menu for keyboards and screen readers.
// Nothing swipes right. Decisions and results stay reachable from the menu, so no object is lost.

export interface MessageActionOptions {
  projectId: string;
  message: ConversationMessage;
  writable: boolean;
  /** A task is being made from this message. */
  busy: boolean;
  /** Makes a task from the message and opens it in Details. */
  onCreateWork: () => void;
  /** Opens the thread beside the stream for a reply, or focuses the reply field. */
  onReply?: () => void;
  /** Quotes the message into the composer. */
  onCite?: () => void;
}

interface MenuItem { id: string; label: string; icon: IconName | 'kreska'; run: () => void; disabled?: boolean; secondary?: boolean }

/** The menu's items, in the drawn order: reply, task, hand off, cite, copy; then what makes objects. */
function useMenuItems(options: MessageActionOptions | null): MenuItem[] {
  const { openDetails } = useShellActions();
  const { me } = useShellData();
  const toast = useToast();
  if (!options) return [];
  const { projectId, message, writable, busy, onCreateWork, onReply, onCite } = options;
  const source = { messageId: message.id, text: message.body };
  const copy = () => {
    const done = () => toast({ message: 'Copied', timeout: 2000 });
    const failed = () => toast({ message: 'Could not copy this text', tone: 'danger' });
    if (!navigator.clipboard) { failed(); return; }
    navigator.clipboard.writeText(message.body).then(done, failed);
  };
  const details: MenuItem = { id: 'details', label: 'Details', icon: 'panel', secondary: true,
    run: () => openDetails({ kind: 'overview', messageId: message.id, selection: { accountId: me.user.id, projectId, message } }) };
  const copyItem: MenuItem[] = message.body ? [{ id: 'copy', label: 'Copy text', icon: 'copy', run: copy }] : [];
  if (!writable) return [...copyItem, details];
  return [
    ...(onReply ? [{ id: 'reply', label: 'Reply in thread', icon: 'reply' as const, run: onReply }] : []),
    { id: 'task', label: busy ? 'Creating…' : 'Create task', icon: 'plus-circle', run: onCreateWork, disabled: busy },
    // There is no hand-off command yet (#347): a hand-off is a task, so it is made and opened in Details,
    // where its owner is chosen.
    { id: 'handoff', label: 'Hand off to an agent', icon: 'kreska', run: onCreateWork, disabled: busy },
    ...(onCite ? [{ id: 'cite', label: 'Cite', icon: 'cite' as const, run: onCite }] : []),
    ...copyItem,
    { id: 'decision', label: 'Propose a decision', icon: 'rule', secondary: true, run: () => openDetails({ kind: 'propose-decision', projectId, source }) },
    { id: 'result', label: 'Attach a result', icon: 'result', secondary: true, run: () => openDetails({ kind: 'attach-result', projectId, source }) },
    details,
  ];
}

/** A menu under its anchor: arrow keys, Escape and a click outside close or move; focus returns to the opener. */
function MessageMenu({ items, anchor, press, onClose, label }: { items: MenuItem[]; anchor: HTMLElement; press: boolean; onClose: (restoreFocus: boolean) => void; label: string }) {
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
export function MessageActions(options: MessageActionOptions) {
  const touch = useMediaQuery('(hover: none)');
  const items = useMenuItems(options);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const more = useRef<HTMLButtonElement>(null);
  if (touch) return null;
  const { writable, busy, onCreateWork, onReply } = options;
  return (
    <div className="msg-acts" role="group" aria-label="Message actions">
      {writable && onReply ? <button type="button" className="msg-acts__b" aria-label="Reply in thread" data-tip="Reply in thread" onClick={onReply}><Icon name="reply" size={16} /></button> : null}
      {writable ? <button type="button" className="msg-acts__b" aria-label="Create task" data-tip="Create task" aria-busy={busy || undefined} disabled={busy} onClick={onCreateWork}><Icon name="plus-circle" size={16} /></button> : null}
      <button ref={more} type="button" className="msg-acts__b" aria-label="More actions" data-tip="More actions" aria-haspopup="menu" aria-expanded={!!anchor} onClick={(event) => setAnchor(anchor ? null : event.currentTarget)}><Icon name="more" size={16} /></button>
      {anchor ? <MessageMenu items={items} anchor={anchor} press={false} label="Message actions"
        onClose={(restore) => { setAnchor(null); if (restore) more.current?.focus(); }} /> : null}
    </div>
  );
}

const REVEAL = 168;
const HOLD_MS = 450;
const MOVE_SLOP = 10;

interface TouchProps {
  ref: RefObject<HTMLLIElement | null>;
  className: string;
  style?: CSSProperties;
  onPointerDown?: (event: ReactPointerEvent<HTMLLIElement>) => void;
  onPointerMove?: (event: ReactPointerEvent<HTMLLIElement>) => void;
  onPointerUp?: (event: ReactPointerEvent<HTMLLIElement>) => void;
  onPointerCancel?: () => void;
  onContextMenu?: (event: MouseEvent<HTMLLIElement>) => void;
  onClickCapture?: (event: MouseEvent<HTMLLIElement>) => void;
}

/**
 * The phone's gestures on one message (S6): swipe left reveals Reply in thread, Create task and Hand off;
 * a long press opens the message menu. Both belong to the touch pointer only; nothing swipes right. The
 * returned props go on the message's list item and `node` inside it. A visually hidden button opens the same
 * menu for keyboards and screen readers, who cannot long press.
 */
export function useTouchActions(options: MessageActionOptions | null): { props: TouchProps; node: ReactNode } {
  const touch = useMediaQuery('(hover: none)');
  const items = useMenuItems(options);
  const ref = useRef<HTMLLIElement>(null);
  const [menu, setMenu] = useState<{ kind: 'press' | 'button'; anchor: HTMLElement } | null>(null);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const gesture = useRef<{ x: number; y: number; mode: 'idle' | 'swipe' | 'dead'; timer: number; interactive: boolean } | null>(null);
  const swallow = useRef(false);
  const opener = useRef<HTMLElement | null>(null);
  const { onCreateWork, onReply, writable, busy } = options ?? { onCreateWork: undefined, onReply: undefined, writable: false, busy: false };

  const clearTimer = () => { if (gesture.current) window.clearTimeout(gesture.current.timer); };
  const close = useCallback(() => { setRevealed(false); setOffset(0); }, []);
  // A revealed row closes when the person touches elsewhere or scrolls.
  useEffect(() => {
    if (!revealed) return;
    const away = (event: Event) => { if (!ref.current?.contains(event.target as Node)) close(); };
    const key = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') close(); };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('scroll', close, true);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('scroll', close, true); document.removeEventListener('keydown', key); };
  }, [revealed, close]);
  useEffect(() => () => clearTimer(), []);

  if (!touch || !options) return { props: { ref, className: '' }, node: null };

  const openPress = (row: HTMLElement) => {
    opener.current = row;
    setMenu({ kind: 'press', anchor: row.querySelector<HTMLElement>(':scope > p') ?? row });
    try { navigator.vibrate?.(8); } catch { /* optional */ }
  };
  const props = {
    ref,
    className: `msg-touch${dragging ? ' is-dragging' : ''}${revealed || offset ? ' is-swiped' : ''}`,
    style: offset ? { transform: `translateX(${offset}px)` } : undefined,
    onPointerDown: (event: ReactPointerEvent<HTMLLIElement>) => {
      swallow.current = false;
      if (event.pointerType !== 'touch') return;
      const row = event.currentTarget;
      const interactive = !!(event.target as Element).closest('a, button, input, textarea, select, [role="button"]');
      const timer = interactive ? 0 : window.setTimeout(() => {
        if (gesture.current?.mode === 'idle') { gesture.current.mode = 'dead'; openPress(row); }
      }, HOLD_MS);
      gesture.current = { x: event.clientX, y: event.clientY, mode: 'idle', timer, interactive };
    },
    onPointerMove: (event: ReactPointerEvent<HTMLLIElement>) => {
      const g = gesture.current;
      if (!g || g.mode === 'dead' || event.pointerType !== 'touch') return;
      const dx = event.clientX - g.x;
      const dy = event.clientY - g.y;
      if (g.mode === 'idle') {
        if (Math.abs(dy) > MOVE_SLOP && Math.abs(dy) > Math.abs(dx)) { clearTimer(); g.mode = 'dead'; return; }
        if (dx < -MOVE_SLOP && Math.abs(dx) > Math.abs(dy) * 1.5) { clearTimer(); g.mode = 'swipe'; setDragging(true); }
        else { if (Math.abs(dx) > MOVE_SLOP) clearTimer(); return; }
      }
      // Only leftwards: a rightward drag only closes a revealed row.
      setOffset(Math.max(-REVEAL, Math.min(0, (revealed ? -REVEAL : 0) + dx)));
    },
    onPointerUp: (event: ReactPointerEvent<HTMLLIElement>) => {
      const g = gesture.current;
      gesture.current = null;
      if (!g) return;
      clearTimer();
      if (g.mode !== 'swipe') return;
      setDragging(false);
      swallow.current = true;
      const dx = event.clientX - g.x;
      const final = Math.max(-REVEAL, Math.min(0, (revealed ? -REVEAL : 0) + dx));
      if (final <= -REVEAL / 2) { setRevealed(true); setOffset(-REVEAL); } else close();
    },
    onPointerCancel: () => { clearTimer(); gesture.current = null; if (dragging) { setDragging(false); if (!revealed) setOffset(0); else setOffset(-REVEAL); } },
    // Android raises a context menu after a long press: the message menu is the answer, not the browser's.
    onContextMenu: (event: MouseEvent<HTMLLIElement>) => { event.preventDefault(); if (!menu) openPress(event.currentTarget); },
    onClickCapture: (event: MouseEvent<HTMLLIElement>) => { if (swallow.current) { swallow.current = false; event.preventDefault(); event.stopPropagation(); } },
  };
  const swipeAction = (run: (() => void) | undefined) => () => { close(); run?.(); };
  const node = (
    <>
      <div className="msg-swipe" role="group" aria-label="Swipe actions" hidden={!revealed && !offset} inert={!revealed}>
        {writable && onReply ? <button type="button" className="msg-swipe__b" onClick={swipeAction(onReply)}><Icon name="reply" size={20} />Reply in thread</button> : null}
        {writable ? <button type="button" className="msg-swipe__b" disabled={busy} onClick={swipeAction(onCreateWork)}><Icon name="plus-circle" size={20} />Create task</button> : null}
        {writable ? <button type="button" className="msg-swipe__b" disabled={busy} onClick={swipeAction(onCreateWork)}><Kreska size={20} />Hand off</button> : null}
      </div>
      <button type="button" className="msg-touch__sr" aria-haspopup="menu" aria-expanded={menu?.kind === 'button'} onClick={(event) => { opener.current = event.currentTarget; setMenu({ kind: 'button', anchor: event.currentTarget.parentElement?.querySelector<HTMLElement>(':scope > p') ?? event.currentTarget }); }}>Message actions</button>
      {menu ? <MessageMenu items={items} anchor={menu.anchor} press={menu.kind === 'press'} label="Message actions"
        onClose={(restore) => { setMenu(null); if (restore) opener.current?.focus({ preventScroll: true }); }} /> : null}
    </>
  );
  return { props, node };
}
