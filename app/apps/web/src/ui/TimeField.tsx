import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type ComponentProps, type FocusEvent, type KeyboardEvent, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { MEDIA, useMediaQuery } from './motion';
import { Overlay } from './Overlay';
import { containPointer, nameOfField, useAnchoredLayer } from './pickerPlace';
import { formatTime, parseTime, timeSteps } from './pickerText';
import { usePop } from './pop';
import './select.css';
import './picker.css';

// The one time field of the application (#1251, Prostota "Date and time pickers"): a text field you can type in ("9:00",
// "9 pm", "21:15") with a chevron that opens the day in 30-minute steps. It replaces `<input type="time">`, whose popup the
// browser draws outside the tokens, the dark theme and the phone sheet. The value is `HH:MM` (or empty), as the native input's.
//
// ARIA: the editable combobox with a listbox popup. Focus stays in the text field while the list is open on a computer and
// `aria-activedescendant` names the time the arrows are on, which the field shows as it moves. On a phone (and any narrow
// window) the list is the select's bottom sheet, a modal dialog whose listbox takes focus; Esc, the scrim and choosing close
// it and focus returns to the field's chevron. Enter and leaving the field commit what is typed; Esc puts the last value back.
// The list reuses the select's classes (`ui-select__*`), so it is the same surface in both themes.

export interface TimeFieldProps extends Omit<ComponentProps<'input'>, 'value' | 'onChange' | 'type' | 'role' | 'ref' | 'children' | 'defaultValue' | 'size' | 'list'> {
  /** `HH:MM`, or '' while there is none. */
  value: string;
  onChange: (value: string) => void;
  /** Classes of the field's frame (the box with the chevron), not of the text inside it. */
  className?: string;
  ref?: Ref<HTMLInputElement>;
}

const NAVIGATION = new Set(['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp']);
const DEFAULT_START = '09:00';

export function TimeField({ value, onChange, className, disabled, ref, onKeyDown, onBlur, ...rest }: TimeFieldProps) {
  const steps = useMemo(() => timeSteps(value), [value]);
  const selected = steps.indexOf(value);
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [title, setTitle] = useState('');
  const sheet = useMediaQuery(MEDIA.phone);
  const frame = useRef<HTMLSpanElement>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const chevron = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const base = useId();
  const optionId = (index: number) => `${base}-o${index}`;
  const listId = `${base}-list`;
  const hintId = `${base}-hint`;
  const place = useAnchoredLayer(open, !sheet, frame, list, 340, steps.length);
  const pop = usePop(open, { from: place?.side ?? 'below' });

  const setRefs = (node: HTMLInputElement | null) => {
    input.current = node;
    if (typeof ref === 'function') ref(node); else if (ref) ref.current = node;
  };

  /** The step that is this time, else the first one after it, else the last. */
  const nearest = (time: string) => {
    const exact = steps.indexOf(time);
    if (exact >= 0) return exact;
    const after = steps.findIndex((step) => step > time);
    return after >= 0 ? after : steps.length - 1;
  };

  const settle = () => { setDraft(null); setInvalid(false); };
  /** Reads the text; a time that is not one keeps the text and says so. */
  const commit = (text: string): boolean => {
    const parsed = parseTime(text);
    if (parsed === null) { setInvalid(true); return false; }
    settle();
    if (parsed !== value) onChange(parsed);
    return true;
  };
  const close = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus && !sheet) input.current?.focus({ preventScroll: true });
  };
  const openList = () => {
    if (disabled || open) return;
    // A tap does not focus a button in Safari, and a phone must not raise its keyboard for a list: the sheet's opener is the chevron.
    (sheet ? chevron.current : input.current)?.focus({ preventScroll: true });
    setTitle(nameOfField(input.current));
    setActive(nearest(parseTime(draft ?? '') ?? (value || DEFAULT_START)));
    // The phone's sheet covers the field: what was typed is kept (or put back) before it opens, so closing the sheet with no
    // choice never leaves text in the field that was not committed.
    if (sheet && draft !== null && !commit(draft)) settle();
    setOpen(true);
  };
  const choose = (index: number) => {
    const time = steps[index];
    if (!time) return;
    settle();
    close();
    if (time !== value) onChange(time);
  };
  const move = (to: number) => {
    const next = Math.max(0, Math.min(steps.length - 1, to));
    setActive(next);
    return next;
  };

  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    const { key } = event;
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault(); event.stopPropagation();
      if (!open) { openList(); return; }
      const next = move(active + (key === 'ArrowDown' ? 1 : -1));
      // The field shows the time the arrows are on, so Enter and Tab keep it.
      setDraft(formatTime(steps[next]!)); setInvalid(false);
      return;
    }
    if (open && (key === 'PageDown' || key === 'PageUp')) {
      event.preventDefault(); event.stopPropagation();
      const next = move(active + (key === 'PageDown' ? 10 : -10));
      setDraft(formatTime(steps[next]!)); setInvalid(false);
      return;
    }
    if (key === 'Enter') {
      // A field with nothing to commit leaves Enter to the form around it.
      if (!open && draft === null) return;
      event.preventDefault(); event.stopPropagation();
      if (commit(draft ?? formatTime(value))) close();
      return;
    }
    if (key === 'Escape' && (open || draft !== null)) {
      event.preventDefault(); event.stopPropagation();
      settle();
      setOpen(false);
    }
  };

  const onType = (event: ChangeEvent<HTMLInputElement>) => {
    const text = event.target.value;
    setDraft(text);
    setInvalid(false);
    const parsed = parseTime(text);
    if (open && parsed) setActive(nearest(parsed));
  };

  const onLeave = (event: FocusEvent<HTMLInputElement>) => {
    onBlur?.(event);
    const next = event.relatedTarget as Node | null;
    if (next && (list.current?.contains(next) || chevron.current === next)) return;
    // The sheet takes focus from the field while it is open; it is not a leaving.
    if (open && sheet) return;
    if (draft !== null && !commit(draft)) settle();
    setOpen(false);
  };

  // A press outside the field and its list closes the list.
  useEffect(() => {
    if (!open || sheet) return undefined;
    const away = (event: Event) => {
      const target = event.target as Node;
      if (frame.current?.contains(target) || list.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [open, sheet]);

  // What the arrows are on stays in view; the one already chosen opens centred.
  const opened = useRef(false);
  const activeId = open && active >= 0 ? optionId(active) : null;
  const positioned = place !== null;
  useLayoutEffect(() => {
    if (!open) { opened.current = false; return; }
    const node = activeId ? document.getElementById(activeId) : null;
    node?.scrollIntoView({ block: opened.current ? 'nearest' : 'center' });
    if (node) opened.current = true;
  }, [open, activeId, positioned]);

  // In the sheet the list itself has focus and takes the keys.
  const onListKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    const { key } = event;
    if (key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (key === 'Enter' || key === ' ') { event.preventDefault(); event.stopPropagation(); choose(active); return; }
    if (key === 'Tab') { event.preventDefault(); return; }
    if (!NAVIGATION.has(key) && key !== 'Home' && key !== 'End') return;
    event.preventDefault(); event.stopPropagation();
    if (key === 'Home') move(0);
    else if (key === 'End') move(steps.length - 1);
    else move(active + (key === 'ArrowDown' ? 1 : key === 'ArrowUp' ? -1 : key === 'PageDown' ? 10 : -10));
  };

  const text = draft ?? formatTime(value);
  const listbox = (extra: ComponentProps<'div'>) => (
    <div ref={list} id={listId} role="listbox" aria-label={title || undefined} tabIndex={-1} {...extra}
      onKeyDown={onListKey} onMouseDown={(event) => { if (!sheet && (event.target as HTMLElement).closest('.ui-select__opt')) event.preventDefault(); }}>
      {steps.map((step, index) => (
        <div key={step} id={optionId(index)} role="option" className="ui-select__opt" aria-selected={index === selected} data-value={step}
          data-active={index === active ? '' : undefined} onMouseMove={() => { if (index !== active) setActive(index); }} onClick={() => choose(index)}>
          <span className="ui-select__tick" aria-hidden="true">{index === selected ? <Icon name="check" size={14} /> : null}</span>
          <span className="ui-select__text">{formatTime(step)}</span>
        </div>
      ))}
    </div>
  );

  return (
    <span ref={frame} className={['ui-pick', 'ui-pick--time', className].filter(Boolean).join(' ')} data-open={open ? '' : undefined} data-invalid={invalid ? '' : undefined} data-disabled={disabled ? '' : undefined}>
      <input {...rest} ref={setRefs} type="text" role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-autocomplete="none"
        aria-controls={open ? listId : undefined} aria-activedescendant={open && !sheet && active >= 0 ? optionId(active) : undefined}
        aria-invalid={invalid || undefined} aria-describedby={[rest['aria-describedby'], hintId].filter(Boolean).join(' ')}
        autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} disabled={disabled} className="ui-pick__input"
        value={text} placeholder={rest.placeholder ?? formatTime('09:00')} onChange={onType} onKeyDown={onKey} onBlur={onLeave} />
      <button ref={chevron} type="button" tabIndex={-1} className="ui-pick__btn" aria-label="Choose a time" aria-haspopup="listbox" aria-expanded={open}
        aria-controls={open ? listId : undefined} disabled={disabled} onMouseDown={(event) => { if (!sheet) event.preventDefault(); }}
        onClick={() => { if (open) close(); else openList(); }}>
        <Icon name="chevron-down" size={14} className="ui-pick__chev" />
      </button>
      <span id={hintId} className="ui-vh">Type a time, for example 9:00 or 9 pm.</span>
      <span role="status" className="ui-vh">{invalid ? 'Not a time. Try 9:00 or 9 pm.' : ''}</span>
      {sheet ? (
        <Overlay open={open} onClose={() => close()} placement="bottom" label={title || 'Choose a time'} className="ui-select-sheet" initialFocus={list}>
          <div className="ui-select-sheet__body" {...containPointer}>
            <span className="ui-select-sheet__grab" aria-hidden="true" />
            {title ? <h2 className="ui-select-sheet__title" aria-hidden="true">{title}</h2> : null}
            {listbox({ className: 'ui-select__list ui-select__list--sheet', 'aria-activedescendant': active >= 0 ? optionId(active) : undefined })}
          </div>
        </Overlay>
      ) : pop.mounted ? createPortal(
        <div {...pop.props} className="ui-select__pop" {...containPointer}
          style={place ? { top: place.top, left: place.left, minWidth: place.minWidth, maxHeight: place.maxHeight } : { top: 0, left: 0, visibility: 'hidden' }}>
          {listbox({ className: 'ui-select__list' })}
        </div>,
        document.body,
      ) : null}
    </span>
  );
}
