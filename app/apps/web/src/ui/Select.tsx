import {
  Children, Fragment, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState,
  type ComponentProps, type KeyboardEvent, type ReactElement, type ReactNode, type Ref,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { MEDIA, useMediaQuery } from './motion';
import { Overlay } from './Overlay';
import { usePop } from './pop';
import './select.css';

// The one select of the application (#695, Prostota "menus"): a button that shows the chosen option and opens its
// choices, replacing every native <select>, whose system list ignores the tokens, the dark theme and the phone sheet.
//
// ARIA: the select-only combobox pattern. The trigger is a `<button role="combobox" aria-haspopup="listbox">`, so a
// `<label htmlFor>` or a wrapping `<label>` still names it, and it keeps `disabled`. While the list is open on a
// computer focus stays on the trigger and `aria-activedescendant` names the option the arrow keys are on. On a phone
// (and any narrow window) the choices open in the same bottom sheet as the other phone menus, a modal dialog whose
// listbox takes focus; Esc, the scrim and choosing close it and focus returns to the trigger.
//
// Keys: Down, Up, Home, End and Page keys move; Enter and Space choose; Esc closes without choosing and, while the list
// is closed, is left to the panel around the select; typing a few letters jumps to the option that starts with them.
// Closed, Down, Up, Home, End and a letter open the list. Nothing here changes the layout: the list is a layer over the
// page, so opening it never moves the control or what is around it.

export interface OptionProps {
  value: string | number;
  disabled?: boolean;
  children?: ReactNode;
}
export interface OptionGroupProps {
  label: string;
  children?: ReactNode;
  'data-ai-surface'?: string;
}

/** One choice. It renders nothing itself: the `Select` that holds it reads its props. */
export function Option(props: OptionProps): null { void props; return null; }
/** A named group of choices ("People", "Agents"). */
export function OptionGroup(props: OptionGroupProps): null { void props; return null; }

interface Group { label: string; ai?: string }
interface Choice { value: string; label: string; content: ReactNode; disabled: boolean; group: Group | null }

/** What typing is compared on: no case, and a space and an underscore are the same ("America/New York" is typed "america/new_york"). */
const fold = (text: string) => text.toLowerCase().replace(/[\s_]+/g, ' ').trimStart();

const textOf = (node: ReactNode): string => {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return isValidElement<{ children?: ReactNode }>(node) ? textOf(node.props.children) : '';
};

function collect(children: ReactNode, group: Group | null, into: Choice[]): Choice[] {
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    if (child.type === Option) {
      const { value, disabled, children: content } = (child as ReactElement<OptionProps>).props;
      into.push({ value: String(value), label: textOf(content).replace(/\s+/g, ' ').trim(), content, disabled: !!disabled, group });
    } else if (child.type === OptionGroup) {
      const props = (child as ReactElement<OptionGroupProps>).props;
      collect(props.children, { label: props.label, ai: props['data-ai-surface'] }, into);
    } else if (child.type === Fragment) {
      collect((child as ReactElement<{ children?: ReactNode }>).props.children, group, into);
    }
  });
  return into;
}

/** The select's accessible name as plain text, for the list that opens from it: its own label, or the label(s) around it. */
function nameOf(button: HTMLButtonElement): string {
  const own = button.getAttribute('aria-label');
  if (own) return own;
  const by = button.getAttribute('aria-labelledby');
  if (by) return by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ').replace(/\s+/g, ' ').trim();
  return [...(button.labels ?? [])].map((label) => {
    const copy = label.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('.ui-select, button, input, select, textarea').forEach((node) => node.remove());
    return copy.textContent ?? '';
  }).join(' ').replace(/\s+/g, ' ').trim();
}

export interface SelectProps extends Omit<ComponentProps<'button'>, 'onChange' | 'value' | 'children' | 'type' | 'role' | 'onKeyDown' | 'onKeyUp' | 'onClick' | 'onBlur' | 'ref'> {
  value: string | number;
  onChange: (value: string) => void;
  /** `Option`s, alone or in `OptionGroup`s. */
  children?: ReactNode;
  /** Shown when no option has the current value. */
  placeholder?: string;
  /** Sent with a form under this name (a hidden field carries the value). */
  name?: string;
  /** The browser's own form check: submitting with no value is refused. */
  required?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

const NAVIGATION = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp']);

export function Select({ value, onChange, children, placeholder, name, required, disabled, className, ref, ...rest }: SelectProps) {
  const choices = collect(children, null, []);
  const current = String(value);
  const selected = choices.findIndex((choice) => choice.value === current);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [title, setTitle] = useState('');
  const [place, setPlace] = useState<{ top: number; left: number; minWidth: number; maxHeight: number; side: 'below' | 'above' } | null>(null);
  // An open list follows the window: it becomes the phone's sheet when the window narrows to phone width, and the popover
  // again when it widens, with the same option under the arrows.
  const sheet = useMediaQuery(MEDIA.phone);
  const pop = usePop(open, { from: place?.side ?? 'below' });
  const button = useRef<HTMLButtonElement | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: '', timer: 0 });
  const spaceDown = useRef(false);
  const swallowClick = useRef(false);
  const base = useId();
  const optionId = (index: number) => `${base}-o${index}`;
  const listId = `${base}-list`;

  const setRefs = (node: HTMLButtonElement | null) => {
    button.current = node;
    if (typeof ref === 'function') ref(node); else if (ref) ref.current = node;
  };

  const enabled = (from: number, step: 1 | -1) => {
    for (let at = from; at >= 0 && at < choices.length; at += step) if (!choices[at]!.disabled) return at;
    return -1;
  };
  const first = () => enabled(0, 1);
  const last = () => enabled(choices.length - 1, -1);

  const close = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus && !sheet) button.current?.focus({ preventScroll: true });
  };
  const openAt = (at?: number) => {
    if (disabled || open || !choices.length) return;
    const target = button.current;
    // A tap does not focus a button in Safari: focus it, so the sheet (or the list's close) returns here.
    target?.focus({ preventScroll: true });
    if (target) setTitle(nameOf(target));
    setActive(at ?? (selected >= 0 && !choices[selected]!.disabled ? selected : first()));
    setPlace(null);
    setOpen(true);
  };
  const choose = (index: number) => {
    const choice = choices[index];
    if (!choice || choice.disabled) return;
    close();
    if (choice.value !== current) onChange(choice.value);
  };

  const move = (to: number) => { if (to >= 0) setActive(to); };
  const step = (from: number, by: 1 | -1) => {
    const next = enabled(from + by, by);
    return next >= 0 ? next : from;
  };
  const typeAhead = (character: string) => {
    window.clearTimeout(typed.current.timer);
    typed.current.timer = window.setTimeout(() => { typed.current.text = ''; }, 600);
    typed.current.text += character.toLowerCase();
    const text = typed.current.text;
    const same = [...text].every((letter) => letter === text[0]);
    const start = open ? Math.max(active, 0) : Math.max(selected, 0);
    // One key (or the same key again) goes on to the next option that starts with it; several different keys narrow down.
    const needle = fold(same ? text[0]! : text);
    if (!needle) return -1;
    const from = same ? start + 1 : start;
    for (let n = 0; n < choices.length; n += 1) {
      const index = (from + n) % choices.length;
      const choice = choices[index]!;
      if (!choice.disabled && fold(choice.label).startsWith(needle)) return index;
    }
    return -1;
  };

  const onKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    const { key } = event;
    const printable = key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
    if (!open) {
      if (event.target !== button.current) return;
      const home = key === 'Home' ? first() : key === 'End' ? last() : undefined;
      // Keys the select takes do not reach what is around it (a page that moves focus with the arrow keys), as with the system's.
      if (key === 'ArrowDown' || key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); openAt(); }
      else if (home !== undefined) { event.preventDefault(); event.stopPropagation(); openAt(home); }
      else if (printable && key !== ' ') { const match = typeAhead(key); if (match >= 0) { event.preventDefault(); event.stopPropagation(); openAt(match); } }
      return;
    }
    if (key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (key === 'Tab') {
      // On a computer Tab keeps its way on and chooses what the arrows are on; in the sheet focus stays in it.
      if (sheet) { event.preventDefault(); return; }
      if (active >= 0) choose(active); else close(false);
      return;
    }
    if (key === 'Enter' || (key === ' ' && !typed.current.text)) {
      event.preventDefault(); event.stopPropagation();
      if (key === ' ') spaceDown.current = true;
      choose(active);
      return;
    }
    if (key === 'ArrowDown' && event.altKey) { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (key === 'ArrowUp' && event.altKey) { event.preventDefault(); event.stopPropagation(); choose(active); return; }
    if (NAVIGATION.has(key)) {
      event.preventDefault(); event.stopPropagation();
      if (key === 'ArrowDown') move(step(active, 1));
      else if (key === 'ArrowUp') move(step(active, -1));
      else if (key === 'Home') move(first());
      else if (key === 'End') move(last());
      else { let to = active; for (let n = 0; n < 10; n += 1) to = step(to, key === 'PageDown' ? 1 : -1); move(to); }
      return;
    }
    if (printable) {
      event.preventDefault(); event.stopPropagation();
      move(typeAhead(key));
    }
  };

  // Space chooses on key down; the click a browser then adds on key up must not open the list again.
  const onKeyUp = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== ' ' || !spaceDown.current) return;
    spaceDown.current = false;
    event.preventDefault();
    swallowClick.current = true;
    window.setTimeout(() => { swallowClick.current = false; }, 0);
  };

  // A click outside closes it; the trigger toggles it itself.
  useEffect(() => {
    if (!open) return undefined;
    const away = (event: Event) => {
      const target = event.target as Node;
      if (button.current?.contains(target) || list.current?.contains(target)) return;
      if (sheet) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [open, sheet]);
  useEffect(() => () => window.clearTimeout(typed.current.timer), []);

  // The list is a layer under the page's own menus: it sits under the trigger, or over it when there is no room below.
  const placeList = () => {
    const trigger = button.current;
    const pane = list.current;
    if (!trigger || !pane) return;
    const box = trigger.getBoundingClientRect();
    const margin = 12;
    pane.style.maxHeight = 'none';
    const natural = pane.scrollHeight;
    const below = window.innerHeight - box.bottom - margin;
    const above = box.top - margin;
    const side = natural > below && above > below ? 'above' : 'below';
    const maxHeight = Math.max(120, Math.min(side === 'above' ? above : below, 340));
    const height = Math.min(natural, maxHeight);
    const minWidth = Math.round(box.width);
    const width = Math.max(pane.offsetWidth, minWidth);
    setPlace({
      side, maxHeight, minWidth,
      top: Math.round(side === 'above' ? box.top - 4 - height : box.bottom + 4),
      left: Math.round(Math.max(8, Math.min(box.left, window.innerWidth - width - 8))),
    });
  };
  useLayoutEffect(() => {
    if (!open || sheet) return undefined;
    placeList();
    const again = (event?: Event) => { if (!(event?.target instanceof Node && list.current?.contains(event.target))) placeList(); };
    window.addEventListener('resize', again);
    document.addEventListener('scroll', again, true);
    return () => { window.removeEventListener('resize', again); document.removeEventListener('scroll', again, true); };
  }, [open, sheet, choices.length]);
  // What the arrows are on stays in view; the one already chosen opens centred.
  const opened = useRef(false);
  const activeId = open && active >= 0 ? `${base}-o${active}` : null;
  const positioned = place !== null;
  useLayoutEffect(() => {
    if (!open) { opened.current = false; return; }
    const node = activeId ? document.getElementById(activeId) : null;
    node?.scrollIntoView({ block: opened.current ? 'nearest' : 'center' });
    if (node) opened.current = true;
  }, [open, activeId, positioned]);

  // Like the system's select, the control is as wide as its widest option, so choosing never changes its width or moves
  // what is beside it (CSS reserves the room; a very long list, like time zones, does not).
  const widest = choices.length <= 60 ? choices.reduce((longest, choice) => (choice.label.length > longest.length ? choice.label : longest), placeholder ?? '') : '';
  const groups: { group: Group | null; items: { choice: Choice; index: number }[] }[] = [];
  choices.forEach((choice, index) => {
    const tail = groups[groups.length - 1];
    if (tail && tail.group?.label === choice.group?.label) tail.items.push({ choice, index });
    else groups.push({ group: choice.group, items: [{ choice, index }] });
  });
  const renderOption = ({ choice, index }: { choice: Choice; index: number }) => (
    <div key={optionId(index)} id={optionId(index)} role="option" className="ui-select__opt" aria-selected={index === selected}
      aria-disabled={choice.disabled || undefined} data-value={choice.value} data-active={index === active ? '' : undefined}
      onMouseMove={() => { if (!choice.disabled && index !== active) setActive(index); }} onClick={() => choose(index)}>
      <span className="ui-select__tick" aria-hidden="true">{index === selected ? <Icon name="check" size={14} /> : null}</span>
      <span className="ui-select__text">{choice.content}</span>
    </div>
  );
  const listbox = (extra: ComponentProps<'div'>) => (
    <div ref={list} id={listId} role="listbox" aria-label={title || undefined} tabIndex={-1} {...extra}
      onKeyDown={onKey} onMouseDown={(event) => { if (!sheet && (event.target as HTMLElement).closest('.ui-select__opt')) event.preventDefault(); }}>
      {groups.map(({ group, items }, at) => group ? (
        <div key={`${group.label}-${at}`} role="group" aria-labelledby={`${base}-g${at}`} data-ai-surface={group.ai}>
          <div id={`${base}-g${at}`} className="ui-select__group" role="presentation">{group.label}</div>
          {items.map(renderOption)}
        </div>
      ) : items.map(renderOption))}
    </div>
  );
  // The list lives in a portal and React events cross portals: what it handles must not reach a drawer or panel around the select.
  const contain = {
    onPointerDown: (event: { stopPropagation: () => void }) => event.stopPropagation(),
    onPointerMove: (event: { stopPropagation: () => void }) => event.stopPropagation(),
    onPointerUp: (event: { stopPropagation: () => void }) => event.stopPropagation(),
    onPointerCancel: (event: { stopPropagation: () => void }) => event.stopPropagation(),
  };

  return (
    <>
      <button ref={setRefs} type="button" role="combobox" aria-haspopup="listbox" aria-expanded={open}
        aria-controls={open ? listId : undefined} aria-activedescendant={open && !sheet && active >= 0 ? optionId(active) : undefined}
        aria-required={required || undefined} disabled={disabled} className={['ui-select', className].filter(Boolean).join(' ')}
        data-value={current} data-placeholder={selected < 0 ? '' : undefined} {...rest}
        onClick={() => {
          if (swallowClick.current) { swallowClick.current = false; return; }
          if (open) close(); else openAt();
        }}
        onKeyDown={onKey} onKeyUp={onKeyUp}
        onBlur={(event) => { if (open && !sheet && !list.current?.contains(event.relatedTarget as Node | null)) setOpen(false); }}>
        <span className="ui-select__value" data-widest={widest || undefined}>{selected >= 0 ? choices[selected]!.label : placeholder ?? ''}</span>
        <Icon name="chevron-down" size={14} className="ui-select__chev" />
      </button>
      {name || required ? (
        <input className="ui-select__field" name={name} value={current} required={required} disabled={disabled} tabIndex={-1} aria-hidden="true"
          onChange={() => undefined} onInvalid={() => button.current?.focus()} />
      ) : null}
      {sheet ? (
        <Overlay open={open} onClose={() => close()} placement="bottom" label={title || 'Choose'} className="ui-select-sheet" initialFocus={list}>
          <div className="ui-select-sheet__body" {...contain}>
            <span className="ui-select-sheet__grab" aria-hidden="true" />
            {title ? <h2 className="ui-select-sheet__title" aria-hidden="true">{title}</h2> : null}
            {listbox({ className: 'ui-select__list ui-select__list--sheet', 'aria-activedescendant': active >= 0 ? optionId(active) : undefined })}
          </div>
        </Overlay>
      ) : pop.mounted ? createPortal(
        <div {...pop.props} className="ui-select__pop" {...contain}
          style={place ? { top: place.top, left: place.left, minWidth: place.minWidth, maxHeight: place.maxHeight } : { top: 0, left: 0, visibility: 'hidden' }}>
          {listbox({ className: 'ui-select__list' })}
        </div>,
        document.body,
      ) : null}
    </>
  );
}
