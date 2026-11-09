import { useRef, type KeyboardEvent } from 'react';
import { Icon, Overlay } from '../ui';
import type { MenuItem } from './messageActions';
import './message-sheet.css';

/**
 * A phone's actions on one message (F-026 S6, `phone-actions-create.webp`, #1013): one bottom sheet with the message at the top and its
 * actions below, in the computer's order (Reply in thread and Create task, then the ⋯ menu's list, a line apart before Edit and Delete).
 * A long press and the quiet ⋯ both open it. The list is the one the computer's menu shows (`useMenuItems`), never a copy of it.
 * A tap on the dimmed screen, Esc or a drag down on the grabber closes it; an item closes it and does its action. Opened by the keyboard or a
 * screen reader (`focusFirst`) it puts focus on the first action; a touch leaves it on the sheet, which then shows no focus ring (a ring
 * round the whole sheet is for the keyboard), so no row looks selected before it is tapped.
 */
export function MessageSheet({ open, items, preview, focusFirst, onClose }: { open: boolean; items: MenuItem[]; preview: string; focusFirst: boolean; onClose: (restoreFocus: boolean) => void }) {
  const menu = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const primary = items.filter((item) => !item.secondary);
  const secondary = items.filter((item) => item.secondary);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = [...menu.current!.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')];
    const at = buttons.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => { event.preventDefault(); buttons[(to + buttons.length) % buttons.length]?.focus(); };
    if (event.key === 'ArrowDown') move(at + 1);
    else if (event.key === 'ArrowUp') move(at < 0 ? -1 : at - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(-1);
  };
  const render = (item: MenuItem) => (
    <button key={item.id} ref={item === items[0] ? first : undefined} type="button" role="menuitem" className="ui-list-sheet__row" data-action={item.id} disabled={item.disabled}
      onClick={() => { onClose(false); item.run(); }}>
      <span className="ui-list-sheet__tile" aria-hidden="true"><Icon name={item.icon} size={20} /></span>{item.label}
    </button>
  );
  return (
    <Overlay open={open} onClose={() => onClose(true)} placement="bottom" label="Message" initialFocus={focusFirst ? first : undefined} className={`ui-list-sheet msg-sheet${focusFirst ? '' : ' msg-sheet--touch'}`}>
      <div className="ui-grabber" aria-hidden="true"><span /></div>
      {preview ? <div className="msg-sheet__message"><p>{preview}</p></div> : null}
      <div ref={menu} role="menu" aria-label="Message actions" className="ui-list-sheet__rows" onKeyDown={onKeyDown}>
        {primary.map(render)}
        {secondary.length && primary.length ? <div className="ui-list-sheet__sep" role="separator" /> : null}
        {secondary.map(render)}
      </div>
    </Overlay>
  );
}
