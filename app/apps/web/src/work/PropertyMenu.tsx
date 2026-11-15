import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon, MEDIA, Overlay, useMediaQuery, usePop } from '../ui';
import { containPointer, useAnchoredLayer } from '../ui/pickerPlace';

/** The tallest a computer's menu grows before it scrolls: 20 lines of the root size, so it grows with the system's text size. */
const menuCap = () => 20 * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);

/** One choice of a property: what it shows, the value it sets and, for the state, its key. */
export interface PropertyOption {
  value: string;
  label: string;
  /** The glyph or face before the label. */
  icon?: ReactNode;
  /** A key that picks it while the menu is open (the state's `1`-`5`). */
  key?: string;
  /** A small heading before the first option of a group ("People", "Agents"). */
  group?: string;
}

/**
 * A property edited where it is read (F-026 S10): its value is a quiet button, a click or the arrow opens its choices,
 * choosing saves at once. The state, the owner and the person a blocker waits for all use it, so they open, move and close
 * the same way on a computer and on a phone. Esc closes the menu, never the panel; the key of a choice picks it. On a phone the choices open in
 * the same bottom sheet as the Select's (#1359): a pop-over inside the half-height task sheet ran off a 320 px window. On a computer the
 * choices are a layer over the page, as the Select's list is: under the value, or over it when there is no room below, never past the
 * window's edge, and scrolling when they are taller than the room. Inside the task panel they were cut by the panel's composer at 200 %
 * text, so Blocked and Done could not be reached.
 */
export function PropertyMenu({ label, value, options, disabled, onChoose, onOpen, onClose, children }: {
  /** The property's name: the button's and the menu's accessible name. */
  label: string;
  value: string;
  options: PropertyOption[];
  disabled?: boolean;
  onChoose: (value: string) => void;
  /** The menu opened or closed without a choice: the version of what the person saw is kept from the first. */
  onOpen?: () => void;
  onClose?: () => void;
  /** What the button shows: the current value. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const sheet = useMediaQuery(MEDIA.phone);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const place = useAnchoredLayer(open, !sheet, button, layer, open && !sheet ? menuCap() : 0, options.length);
  const pop = usePop(open, { from: place?.side ?? 'below' });
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const first = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open || sheet) return;
    const away = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node) && !layer.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open, sheet]);
  // A computer's menu takes focus once it is in place (it is hidden until then); the sheet takes it through the overlay.
  const placed = sheet || place !== null;
  // In the same commit as the layer is shown (as the DateField's popover does): a later focus left WebKit's focus on the value's button.
  // The menu scrolls itself to the row; the page never scrolls for it.
  useLayoutEffect(() => {
    const item = open && placed ? items.current[active] : null;
    if (!item) return;
    item.focus({ preventScroll: true });
    const list = item.closest<HTMLElement>('[role="menu"]');
    if (!list) return;
    const row = item.getBoundingClientRect();
    const box = list.getBoundingClientRect();
    if (row.top < box.top) list.scrollTop -= box.top - row.top;
    else if (row.bottom > box.bottom) list.scrollTop += row.bottom - box.bottom;
  }, [open, active, placed]);
  const was = useRef(false);
  useEffect(() => {
    if (open && !was.current) onOpen?.();
    else if (!open && was.current) onClose?.();
    was.current = open;
  });

  const choose = (next: string) => {
    setOpen(false);
    button.current?.focus({ preventScroll: true });
    if (next !== value) onChoose(next);
  };
  const openMenu = () => { setActive(Math.max(0, options.findIndex((option) => option.value === value))); setOpen(true); };
  const onMenuKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); setOpen(false); button.current?.focus({ preventScroll: true }); return; }
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((at) => (at + 1) % options.length); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); setActive((at) => (at + options.length - 1) % options.length); return; }
    // The layer is at the end of the page: Tab goes on from the value's button, as if the menu were not there.
    if (event.key === 'Tab') { button.current?.focus({ preventScroll: true }); setOpen(false); return; }
    const picked = options.find((option) => option.key !== undefined && option.key === event.key);
    if (picked) { event.preventDefault(); event.stopPropagation(); choose(picked.value); }
  };

  const rows = options.map((option, index) => (
    <div key={option.value} role="none">
      {option.group && option.group !== options[index - 1]?.group ? <p className="wd-menu__group" role="presentation">{option.group}</p> : null}
      <button ref={(node) => { items.current[index] = node; if (index === active) first.current = node; }} type="button" role="menuitemradio" aria-checked={option.value === value} tabIndex={index === active ? 0 : -1}
        className="wd-menu__item" onClick={() => choose(option.value)} onMouseMove={() => setActive(index)}>
        {option.icon}<span>{option.label}</span>{option.key ? <kbd>{option.key}</kbd> : null}
      </button>
    </div>
  ));
  const style = place ? { top: place.top, left: place.left, minWidth: Math.max(220, place.minWidth), maxHeight: place.maxHeight } : { top: 0, left: 0, visibility: 'hidden' as const };

  return (
    <div className="wd-menu" ref={root}>
      <button ref={button} type="button" className="wd-state" aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        // While the menu is open its keys work from the value too: a key pressed as the menu arrives, before focus is in it, still
        // closes it (Esc) or picks a state, and never reaches the panel.
        onKeyDown={(event) => { if (open) { onMenuKey(event); return; } if (event.key === 'ArrowDown') { event.preventDefault(); openMenu(); } }}>
        {children}<Icon name="chevron-down" size={14} className="wd-state__go" />
      </button>
      {sheet ? (
        <Overlay open={open} onClose={() => setOpen(false)} placement="bottom" label={label} className="ui-select-sheet" initialFocus={first}>
          <div className="ui-select-sheet__body">
            <span className="ui-select-sheet__grab" aria-hidden="true" />
            <h2 className="ui-select-sheet__title" aria-hidden="true">{label}</h2>
            <div className="wd-menu__list wd-menu__list--sheet" role="menu" id={menuId} aria-label={label} onKeyDown={onMenuKey}>{rows}</div>
          </div>
        </Overlay>
      ) : pop.mounted ? createPortal(
        <div {...pop.props} {...containPointer} ref={layer} style={style} data-side={place?.side} className="wd-menu__list" role="menu" id={menuId} aria-label={label} onKeyDown={onMenuKey}>{rows}</div>,
        document.body) : null}
    </div>
  );
}
