import { useId, useState, type KeyboardEvent } from 'react';
import { Avatar, Icon } from '../ui';
import './waiting-field.css';

/** One thing a blocked task can wait for: a person (`human:<id>`), or in the task panel a decision (`decision:<id>`) or a task (`task:<id>`). */
export interface WaitingChoice { value: string; label: string; group?: string }

const MOST = 8;
const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();

/**
 * Blocked is one field (#1438 point 12): "Waiting for" takes the reason as typed words, or a person (in the panel also a decision or a task)
 * picked from the list under it. A pick fills the field as a face and name with a remove, and the typed words stay beside it, so a task that
 * has both keeps both. The list is the composer's `@` list's model: arrows move, Enter picks the row the arrows chose (with none chosen it keeps
 * the words and leaves Enter to the form), Escape closes the list and never the window around it. It lists everything when the field is entered
 * and what the words typed after that match; words that match nothing are simply a reason.
 */
export function WaitingField({ label = 'Waiting for', choices, choice, choiceLabel, text, onChoice, onText, disabled, maxLength, autoFocus }: {
  label?: string;
  choices: readonly WaitingChoice[];
  /** The value of what is picked, or ''. */
  choice: string;
  /** Its name, for a pick the list does not hold (a task another person was waiting for). */
  choiceLabel?: string;
  text: string;
  onChoice: (value: string) => void;
  onText: (text: string) => void;
  disabled?: boolean;
  maxLength: number;
  autoFocus?: boolean;
}) {
  const id = useId();
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(-1);
  // The words already in the field are the reason, not a search: the list narrows only by what is typed after the field is entered.
  const [typed, setTyped] = useState(false);
  const needle = typed ? fold(text.trim()) : '';
  const shown = choice ? [] : choices.filter((item) => !needle || fold(item.label).includes(needle)).slice(0, MOST);
  const open = focused && !dismissed && !disabled && shown.length > 0;
  const picked = choices.find((item) => item.value === choice);
  const pickedName = picked?.label ?? choiceLabel ?? '';
  // Words typed to find the choice were a search, so they go; the reason that was already there stays beside the pick.
  const pick = (item: WaitingChoice) => { onChoice(item.value); if (typed) onText(''); setTyped(false); setActive(-1); setDismissed(false); };
  const optionId = (index: number) => `${id}-o${index}`;
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!shown.length) return;
      event.preventDefault();
      setDismissed(false);
      setActive((current) => (event.key === 'ArrowDown' ? (current + 1) % shown.length : (current <= 0 ? shown.length - 1 : current - 1)));
    } else if (event.key === 'Enter' && open && active >= 0 && shown[active]) {
      event.preventDefault(); event.stopPropagation(); pick(shown[active]!);
    } else if (event.key === 'Escape' && open) {
      event.preventDefault(); event.stopPropagation(); setDismissed(true); setActive(-1);
    } else if (event.key === 'Backspace' && choice && !event.currentTarget.value) {
      event.preventDefault(); onChoice('');
    }
  }
  return (
    <div className="ui-field waiting">
      <div className="ui-field__top"><label className="ui-field__label" htmlFor={id}>{label}</label></div>
      <div className="waiting__box" data-disabled={disabled ? '' : undefined}>
        {choice ? (
          <span className="waiting__pick">
            {choice.startsWith('human:') ? <Avatar name={pickedName} id={choice.slice('human:'.length)} size="sm" /> : <Icon name={choice.startsWith('decision:') ? 'flag' : 'tasks'} size={14} />}
            <span className="waiting__name">{pickedName}</span>
            <button type="button" className="waiting__x" aria-label={`Stop waiting for ${pickedName}`} disabled={disabled} onClick={() => { onChoice(''); document.getElementById(id)?.focus(); }}><Icon name="x" size={12} /></button>
          </span>
        ) : null}
        <input id={id} className="waiting__input" type="text" role="combobox" autoComplete="off" value={text} maxLength={maxLength} disabled={disabled} autoFocus={autoFocus}
          placeholder={choice ? 'Add a reason (optional)' : 'A person, or what it is waiting for'}
          aria-expanded={open} aria-autocomplete="list" aria-controls={open ? `${id}-list` : undefined} aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
          onChange={(event) => { onText(event.target.value); setTyped(true); setActive(-1); setDismissed(false); }}
          onFocus={() => setFocused(true)} onBlur={() => { setFocused(false); setTyped(false); setActive(-1); setDismissed(false); }} onKeyDown={onKeyDown} />
      </div>
      {open ? (
        // The field keeps focus: a press on a row must not blur it.
        <div id={`${id}-list`} className="waiting__list" role="listbox" aria-label={label} onMouseDown={(event) => event.preventDefault()}>
          {shown.map((item, index) => {
            const head = item.group && item.group !== shown[index - 1]?.group ? item.group : null;
            return (
              <div key={item.value}>
                {head ? <div className="waiting__h" aria-hidden="true">{head}</div> : null}
                <div id={optionId(index)} role="option" aria-selected={index === active} className={`waiting__o${index === active ? ' is-active' : ''}`}
                  onMouseMove={() => { if (index !== active) setActive(index); }} onClick={() => pick(item)}>
                  {item.value.startsWith('human:') ? <Avatar name={item.label} id={item.value.slice('human:'.length)} size="sm" /> : <Icon name={item.value.startsWith('decision:') ? 'flag' : 'tasks'} size={14} />}
                  <span className="waiting__name">{item.label}</span>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
