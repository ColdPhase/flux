import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Icon, usePop } from '../ui';

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
 * the same way on a computer and on a phone. Esc closes the menu, never the panel; the key of a choice picks it.
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
  const pop = usePop(open);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  useEffect(() => { if (open) items.current[active]?.focus({ preventScroll: false }); }, [open, active]);
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
  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); setOpen(false); button.current?.focus({ preventScroll: true }); return; }
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((at) => (at + 1) % options.length); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); setActive((at) => (at + options.length - 1) % options.length); return; }
    if (event.key === 'Tab') { setOpen(false); return; }
    const picked = options.find((option) => option.key !== undefined && option.key === event.key);
    if (picked) { event.preventDefault(); event.stopPropagation(); choose(picked.value); }
  };

  return (
    <div className="wd-menu" ref={root}>
      <button ref={button} type="button" className="wd-state" aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={(event) => { if (event.key === 'ArrowDown') { event.preventDefault(); openMenu(); } }}>
        {children}<Icon name="chevron-down" size={14} className="wd-state__go" />
      </button>
      {pop.mounted ? (
        <div {...pop.props} className="wd-menu__list" role="menu" id={menuId} aria-label={label} onKeyDown={onMenuKey}>
          {options.map((option, index) => (
            <div key={option.value} role="none">
              {option.group && option.group !== options[index - 1]?.group ? <p className="wd-menu__group" role="presentation">{option.group}</p> : null}
              <button ref={(node) => { items.current[index] = node; }} type="button" role="menuitemradio" aria-checked={option.value === value} tabIndex={index === active ? 0 : -1}
                className="wd-menu__item" onClick={() => choose(option.value)} onMouseMove={() => setActive(index)}>
                {option.icon}<span>{option.label}</span>{option.key ? <kbd>{option.key}</kbd> : null}
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
