import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type ComponentProps, type FocusEvent, type KeyboardEvent, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { Button, IconButton } from './Button';
import { Icon } from './Icon';
import { MEDIA, useMediaQuery } from './motion';
import { Overlay, trapTab } from './Overlay';
import { containPointer, nameOfField, useAnchoredLayer } from './pickerPlace';
import { addDays, addMonths, dateOf, firstWeekday, formatDay, makeDay, monthTitle, parseDay, spokenDay, splitDay, today, weekdays } from './pickerText';
import { usePop } from './pop';
import './select.css';
import './picker.css';

// The one date field of the application (#1251, Prostota "Date and time pickers"): a text field you can type in ("14 Nov",
// "2026-11-14", "tomorrow") with a chevron that opens a month. It replaces `<input type="date">`, whose popup the browser
// draws outside the tokens, the dark theme and the phone sheet. The value is `YYYY-MM-DD` (or empty), as the native input's.
//
// ARIA: the date picker dialog pattern. The field is a labelled text field; its chevron is a button that opens a dialog named
// by the field: a month title, previous and next month buttons, a `grid` of day buttons that read in full ("Saturday, 14
// November 2026") and a footer (Today, Tomorrow, Clear). Focus moves to the day the arrows are on, Tab stays inside the dialog,
// Esc closes it and focus returns to where it came from. On a phone (and any narrow window) the dialog is the select's bottom
// sheet. Enter and leaving the field commit what is typed; Esc puts the last value back.

export interface DateFieldProps extends Omit<ComponentProps<'input'>, 'value' | 'onChange' | 'type' | 'role' | 'ref' | 'children' | 'defaultValue' | 'size' | 'list' | 'min' | 'max'> {
  /** `YYYY-MM-DD`, or '' while there is none. */
  value: string;
  /** The new day, or '' when it was cleared. */
  onChange: (value: string) => void;
  /** A date may be empty: the picker offers Clear and an emptied field is a clear. */
  clearable?: boolean;
  /** The earliest and the latest day that can be chosen (`YYYY-MM-DD`). */
  min?: string;
  max?: string;
  /** Opens the picker as the field appears (a value edited in place), with the caret in the field on a computer. */
  defaultOpen?: boolean;
  /** The picker closed without a new value (Esc, a press outside, the same day again). */
  onDismiss?: () => void;
  /** Classes of the field's frame (the box with the chevron), not of the text inside it. */
  className?: string;
  ref?: Ref<HTMLInputElement>;
}

const clamp = (day: string, min: string, max: string) => (day < min ? min : day > max ? max : day);

export function DateField({ value, onChange, clearable, min = '1970-01-01', max = '9999-12-31', defaultOpen, onDismiss, className, disabled, ref, onKeyDown, onBlur, ...rest }: DateFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [open, setOpen] = useState(!!defaultOpen && !disabled);
  const [cursor, setCursor] = useState(() => clamp(splitDay(value) ? value : today(), min, max));
  const [title, setTitle] = useState('');
  const sheet = useMediaQuery(MEDIA.phone);
  const first = useMemo(() => firstWeekday(), []);
  const frame = useRef<HTMLSpanElement>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const chevron = useRef<HTMLButtonElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  const cursorButton = useRef<HTMLButtonElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const takeFocus = useRef(false);
  const base = useId();
  const popId = `${base}-pop`;
  const hintId = `${base}-hint`;
  const headId = `${base}-head`;
  const place = useAnchoredLayer(open, !sheet, frame, pane, 460, cursor.slice(0, 7));
  const pop = usePop(open, { from: place?.side ?? 'below' });
  const now = today();

  const setRefs = (node: HTMLInputElement | null) => {
    input.current = node;
    if (typeof ref === 'function') ref(node); else if (ref) ref.current = node;
  };

  const settle = () => { setDraft(null); setInvalid(false); };
  const inRange = (day: string) => day >= min && day <= max;
  /** Reads the text; a day that is not one (or is out of range) keeps the text and says so. */
  const commit = (text: string): boolean => {
    const trimmed = text.trim();
    if (!trimmed) { settle(); if (clearable && value) onChange(''); return true; }
    const parsed = parseDay(trimmed);
    if (parsed === null || !inRange(parsed)) { setInvalid(true); return false; }
    settle();
    if (parsed !== value) onChange(parsed);
    return true;
  };

  /** Closes the picker; `dismissed` is a close with no new value, and `restore` puts focus back where it came from. */
  const close = ({ dismissed = false, restore = true } = {}) => {
    if (!open) return;
    setOpen(false);
    if (restore && !sheet) (returnTo.current ?? input.current)?.focus({ preventScroll: true });
    if (dismissed) onDismiss?.();
  };
  const openPicker = (from: HTMLElement | null, focusDay = true) => {
    if (disabled || open) return;
    returnTo.current = from;
    takeFocus.current = focusDay;
    const parsed = draft === null ? null : parseDay(draft);
    setCursor(clamp(parsed ?? (splitDay(value) ? value : now), min, max));
    setOpen(true);
  };
  const choose = (day: string) => {
    if (day && !inRange(day)) return;
    settle();
    const changed = day !== value;
    close({ dismissed: !changed });
    if (changed) onChange(day);
  };

  // The caret goes into the field as a value edited in place appears, but not on a phone, where it would raise the keyboard
  // over the sheet.
  useLayoutEffect(() => {
    if (defaultOpen && !sheet && !disabled) input.current?.focus({ preventScroll: true });
    // Only as the field appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useLayoutEffect(() => { if (open) setTitle(nameOfField(input.current)); }, [open]);

  // A computer's popover takes focus once it is in place (it is hidden until then); the sheet takes it through the overlay.
  const positioned = place !== null;
  useLayoutEffect(() => {
    if (!open || sheet || !positioned || !takeFocus.current) return;
    takeFocus.current = false;
    cursorButton.current?.focus({ preventScroll: true });
  }, [open, sheet, positioned]);
  // A key moved the day the arrows are on; focus follows it.
  const follow = useRef(false);
  useLayoutEffect(() => {
    if (!follow.current) return;
    follow.current = false;
    cursorButton.current?.focus({ preventScroll: true });
  }, [cursor]);

  // A press outside the field and its popover closes it; so does focus leaving them (Tab).
  useEffect(() => {
    if (!open || sheet) return undefined;
    const away = (event: Event) => {
      const target = event.target as Node;
      if (frame.current?.contains(target) || pane.current?.contains(target)) return;
      if (draft !== null) commit(draft);
      close({ dismissed: true, restore: false });
    };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
    // `commit` and `close` read what is current at the press.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sheet, draft, value]);
  const onFocusOut = (event: FocusEvent<HTMLElement>) => {
    const next = event.relatedTarget as Node | null;
    if (!open || sheet || !next || frame.current?.contains(next) || pane.current?.contains(next)) return;
    close({ dismissed: true, restore: false });
  };

  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    const { key } = event;
    if (key === 'ArrowDown' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault(); event.stopPropagation();
      if (!open) openPicker(input.current);
      else if (!sheet) cursorButton.current?.focus({ preventScroll: true });
      return;
    }
    if (key === 'Tab' && open && !sheet && !event.shiftKey && pane.current) {
      // The popover is a layer at the end of the page: Tab goes into it, not past it.
      event.preventDefault();
      cursorButton.current?.focus({ preventScroll: true });
      return;
    }
    if (key === 'Enter') {
      // A field with nothing to commit leaves Enter to the form around it.
      if (!open && draft === null) return;
      event.preventDefault(); event.stopPropagation();
      if (draft === null) { close({ dismissed: true }); return; }
      if (commit(draft)) close();
      return;
    }
    if (key === 'Escape' && (open || draft !== null)) {
      event.preventDefault(); event.stopPropagation();
      settle();
      close({ dismissed: true });
    }
  };
  const onType = (event: ChangeEvent<HTMLInputElement>) => {
    const text = event.target.value;
    setDraft(text);
    setInvalid(false);
    // The month follows what is typed.
    const parsed = parseDay(text);
    if (open && parsed && inRange(parsed)) setCursor(parsed);
  };
  const onLeave = (event: FocusEvent<HTMLInputElement>) => {
    onBlur?.(event);
    const next = event.relatedTarget as Node | null;
    if (next && (pane.current?.contains(next) || chevron.current === next)) return;
    if (open && sheet) return;
    if (draft !== null && !commit(draft)) settle();
  };

  // Keys inside the calendar: the day the arrows are on, by day, week, month and year.
  const weekStart = (day: string) => addDays(day, -((((dateOf(day).getDay() + 6) % 7) + 1 - first + 7) % 7));
  const onGridKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    let next: string | null = null;
    // From the day that has focus (a click may have focused a day of the next month, which does not move the month).
    const from = (event.target as HTMLElement).closest<HTMLElement>('[data-day]')?.dataset.day ?? cursor;
    switch (event.key) {
      case 'ArrowLeft': next = addDays(from, -1); break;
      case 'ArrowRight': next = addDays(from, 1); break;
      case 'ArrowUp': next = addDays(from, -7); break;
      case 'ArrowDown': next = addDays(from, 7); break;
      case 'Home': next = weekStart(from); break;
      case 'End': next = addDays(weekStart(from), 6); break;
      case 'PageUp': next = addMonths(from, event.shiftKey ? -12 : -1); break;
      case 'PageDown': next = addMonths(from, event.shiftKey ? 12 : 1); break;
      default: return;
    }
    event.preventDefault(); event.stopPropagation();
    follow.current = true;
    setCursor(clamp(next, min, max));
  };
  const onPaneKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close({ dismissed: true }); return; }
    if (!sheet) trapTab(event, pane.current);
  };
  const step = (months: number) => setCursor(clamp(addMonths(cursor, months), min, max));

  const parts = splitDay(cursor)!;
  const firstOfMonth = makeDay(parts.year, parts.month, 1)!;
  const gridStart = addDays(firstOfMonth, -(((((dateOf(firstOfMonth).getDay() + 6) % 7) + 1) - first + 7) % 7));
  const weeks = Array.from({ length: 6 }, (_, week) => Array.from({ length: 7 }, (_, day) => addDays(gridStart, week * 7 + day)));
  const names = weekdays(first);
  const tomorrow = addDays(now, 1);

  const calendar = (
    <div className="ui-cal">
      <div className="ui-cal__head">
        <IconButton icon="chevron-left" label="Previous month" size={14} className="ui-cal__nav" data-tip={undefined} onClick={() => step(-1)} />
        <h2 id={headId} className="ui-cal__title" aria-live="polite">{monthTitle(firstOfMonth)}</h2>
        <IconButton icon="chevron-right" label="Next month" size={14} className="ui-cal__nav" data-tip={undefined} onClick={() => step(1)} />
      </div>
      <table className="ui-cal__grid" role="grid" aria-labelledby={headId} onKeyDown={onGridKey}>
        <thead>
          <tr>{names.map((name) => <th key={name.long} scope="col" abbr={name.long} className="ui-cal__dow">{name.short.slice(0, 2)}</th>)}</tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week[0]}>
              {week.map((day) => {
                const isCursor = day === cursor;
                const isToday = day === now;
                const selected = day === value;
                return (
                  <td key={day} role="gridcell" aria-selected={selected}>
                    <button ref={isCursor ? cursorButton : undefined} type="button" className="ui-cal__day" tabIndex={isCursor ? 0 : -1} data-day={day}
                      data-today={isToday ? '' : undefined} data-selected={selected ? '' : undefined} data-outside={day.slice(0, 7) !== cursor.slice(0, 7) ? '' : undefined}
                      aria-current={isToday ? 'date' : undefined} aria-label={`${spokenDay(day)}${isToday ? ', today' : ''}`}
                      disabled={!inRange(day)} onClick={() => choose(day)} onFocus={() => { if (!isCursor && day.slice(0, 7) === cursor.slice(0, 7)) setCursor(day); }}>
                      {Number(day.slice(8))}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="ui-cal__foot">
        <Button variant="secondary" size="sm" disabled={!inRange(now)} onClick={() => choose(now)}>Today</Button>
        <Button variant="secondary" size="sm" disabled={!inRange(tomorrow)} onClick={() => choose(tomorrow)}>Tomorrow</Button>
        {clearable ? <Button variant="secondary" size="sm" className="ui-cal__clear" disabled={!value} onClick={() => choose('')}>Clear</Button> : null}
      </div>
    </div>
  );

  const text = draft ?? (value ? formatDay(value) : '');
  return (
    <span ref={frame} className={['ui-pick', 'ui-pick--date', className].filter(Boolean).join(' ')} data-open={open ? '' : undefined} data-invalid={invalid ? '' : undefined}
      data-disabled={disabled ? '' : undefined} onBlur={onFocusOut}>
      <input {...rest} ref={setRefs} type="text" aria-invalid={invalid || undefined} aria-describedby={[rest['aria-describedby'], hintId].filter(Boolean).join(' ')}
        autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} disabled={disabled} className="ui-pick__input"
        value={text} placeholder={rest.placeholder ?? ''} onChange={onType} onKeyDown={onKey} onBlur={onLeave} />
      <button ref={chevron} type="button" className="ui-pick__btn" aria-label="Choose a date" aria-haspopup="dialog" aria-expanded={open}
        aria-controls={open ? popId : undefined} disabled={disabled}
        onClick={() => { if (open) close({ dismissed: true }); else openPicker(chevron.current); }}>
        <Icon name="chevron-down" size={14} className="ui-pick__chev" />
      </button>
      <span id={hintId} className="ui-vh">Type a date, for example 14 Nov or 2026-11-14.</span>
      <span role="status" className="ui-vh">{invalid ? 'Not a date. Try 14 Nov or 2026-11-14.' : ''}</span>
      {sheet ? (
        <Overlay open={open} onClose={() => close({ dismissed: true })} placement="bottom" label={title || 'Choose a date'} className="ui-select-sheet ui-cal-sheet" initialFocus={cursorButton}>
          <div id={popId} className="ui-select-sheet__body" onKeyDown={onPaneKey} {...containPointer}>
            <span className="ui-select-sheet__grab" aria-hidden="true" />
            {title ? <h2 className="ui-select-sheet__title" aria-hidden="true">{title}</h2> : null}
            {calendar}
          </div>
        </Overlay>
      ) : pop.mounted ? createPortal(
        <div ref={pane} {...pop.props} id={popId} role="dialog" aria-label={title || 'Choose a date'} className="ui-select__pop ui-cal-pop" onKeyDown={onPaneKey} onBlur={onFocusOut} {...containPointer}
          style={place ? { top: place.top, left: place.left, minWidth: place.minWidth, maxHeight: place.maxHeight } : { top: 0, left: 0, visibility: 'hidden' }}>
          {calendar}
        </div>,
        document.body,
      ) : null}
    </span>
  );
}
