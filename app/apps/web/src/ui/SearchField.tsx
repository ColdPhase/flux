import { forwardRef, useRef, type InputHTMLAttributes, type MouseEvent, type ReactNode } from 'react';
import { IconButton } from './Button';
import { Icon } from './Icon';

export interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange' | 'className'> {
  value: string;
  /** The typed text, and '' when the clear × is pressed. */
  onValue: (value: string) => void;
  /** The wrapper's class: the place's own look on the computer and the tablet. On the phone every search field is `.ui-search`'s one pill. */
  className?: string;
  /** The input's own class, for a place's rules on its text (Search's `jump__input`). */
  inputClassName?: string;
  /** Pass the 16 or 14 px glyph the place always had; the phone's pill draws it at 16. */
  iconSize?: number;
  /** A field that never had a magnifier on the computer (a plain box there) shows it on the phone only. */
  phoneIcon?: boolean;
  /** Between the text and the clear ×: Search's spinner. */
  children?: ReactNode;
}

/**
 * The one search field (README §4 Phone, "Search fields"): the magnifier, the input, and a clear × while there is text. On the phone it is a flat
 * `--sub` pill of 44 px with no edge and no shadow, whichever screen it is on; wider than 640 px each place keeps the look it was drawn with
 * through `className`. Its input is `type="search"` with the search key on a phone's keyboard; the browser's own cross is hidden in this field
 * on the phone, where the clear is ours (a 44 px target that keeps the keyboard up).
 */
export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField(
  { value, onValue, className, inputClassName, iconSize = 16, phoneIcon = false, children, ...input }, ref,
) {
  const own = useRef<HTMLInputElement | null>(null);
  const setRefs = (element: HTMLInputElement | null) => {
    own.current = element;
    if (typeof ref === 'function') ref(element); else if (ref) ref.current = element;
  };
  // A press on the pill itself (its padding, the magnifier) is a press in the field: the caret goes in, as a label's would take it.
  const focusInput = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target === own.current || target.closest('button')) return;
    event.preventDefault();
    own.current?.focus();
  };
  return (
    <div className={['ui-search', phoneIcon ? 'ui-search--phone-icon' : '', className].filter(Boolean).join(' ')} onMouseDown={focusInput}>
      <Icon name="search" size={iconSize} className="ui-search__icon" />
      <input enterKeyHint="search" {...input} ref={setRefs} className={inputClassName} type="search" value={value} onChange={(event) => onValue(event.target.value)} />
      {children}
      {/* Not drawn on the computer or the tablet (their fields keep the browser's cross). mousedown never takes the focus off the field. */}
      {value ? <IconButton icon="x" label="Clear search" size={16} className="ui-search__clear" data-tip={undefined} onMouseDown={(event) => event.preventDefault()} onClick={() => onValue('')} /> : null}
    </div>
  );
});
