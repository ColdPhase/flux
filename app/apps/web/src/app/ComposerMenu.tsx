import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ProjectPerson } from '@flux/contracts';
import { Avatar, usePop } from '../ui';
import './composer-menu.css';

// "@" mentions people and "/" runs one of four actions in the composer (F-026 S5, #1419), in place of separate Ask and Cite buttons.
// The menu is a listbox the field controls; the field keeps focus throughout.

export type SlashId = 'task' | 'decide' | 'file' | 'ai';

export interface ComposerOption {
  id: string;
  kind: 'action' | 'person' | 'suggestion';
  /** "/task", or the person's name. */
  label: string;
  /** A person's user id: their avatar's photo (F-039). */
  personId?: string;
  hint: string;
  /** What replaces the typed trigger when it is chosen. */
  insert: string;
  slash?: SlashId;
  /** A suggestion under `/ai` (#1224): the words it asks the assistant, in this place, as soon as it is chosen. */
  ask?: string;
}
/** Whether an action is AI (F-029): it is not offered while the space's AI is off. */
const AI_ACTIONS: ReadonlySet<SlashId> = new Set(['ai']);

export interface ComposerTrigger { char: '@' | '/'; query: string; start: number }

/** The trigger the caret is in: "@" after a space or at the start, "/" only at the start of the draft. */
export function composerTrigger(value: string, caret: number): ComposerTrigger | null {
  const before = value.slice(0, caret);
  const at = /(^|\s)@([^\s@]*)$/.exec(before);
  if (at) return { char: '@', query: at[2]!, start: before.length - at[2]!.length - 1 };
  const slash = /^\/([a-z]*)$/i.exec(before);
  return slash ? { char: '/', query: slash[1]!, start: 0 } : null;
}

const ACTIONS: { id: SlashId; hint: string }[] = [
  { id: 'task', hint: 'Create a task' },
  { id: 'decide', hint: 'Propose a decision' },
  { id: 'file', hint: 'Attach a file or link' },
  { id: 'ai', hint: 'Ask your assistant' },
];

/**
 * The options for a trigger: actions by command name, or the people of the project by name (agents are not members, #1419). `suggestions` are the assistant's,
 * for this place: they follow the `/ai` row (#1224). `only` narrows the actions to some commands (a task's composer has `/ai` alone).
 */
export function composerOptions(trigger: ComposerTrigger, { people, meId, aiOff = false, suggestions = [], only }: { people: ProjectPerson[] | null; meId: string; aiOff?: boolean; suggestions?: readonly string[]; only?: readonly SlashId[] }): ComposerOption[] {
  const query = trigger.query.toLowerCase();
  if (trigger.char === '/') {
    return ACTIONS.filter((action) => !(aiOff && AI_ACTIONS.has(action.id)) && (!only || only.includes(action.id)) && action.id.startsWith(query))
      .flatMap((action) => [
        { id: `slash-${action.id}`, kind: 'action' as const, label: `/${action.id}`, hint: action.hint, insert: `/${action.id} `, slash: action.id },
        ...(action.id === 'ai' ? suggestions.map((text, index) => ({ id: `ask-${index}`, kind: 'suggestion' as const, label: text, hint: '', insert: '', ask: text })) : []),
      ]);
  }
  return (people ?? []).filter((person) => person.kind === 'human' && person.id !== meId && person.name.toLowerCase().includes(query))
    .sort((a, b) => Number(b.name.toLowerCase().startsWith(query)) - Number(a.name.toLowerCase().startsWith(query)) || a.name.localeCompare(b.name))
    .slice(0, 8)
    .map((person) => ({ id: `mention-human-${person.id}`, kind: 'person' as const, personId: person.id, label: person.name, hint: 'Person', insert: `@${person.name} ` }));
}

/** The menu above the composer's box. `active` is the option the keys act on. */
interface ComposerMenuProps { id: string; options: ComposerOption[]; active: number; onPick: (option: ComposerOption) => void; onHover: (index: number) => void; trigger: ComposerTrigger['char'] }

/**
 * The menu leaves as it came (#593 AC-1): the composer keeps it mounted, `open` false, and it fades for --dur-out from what it
 * showed last, inert, while the field keeps focus and its keys. A closed menu with nothing shown yet renders nothing.
 */
export function ComposerMenu({ open, ...props }: ComposerMenuProps & { open: boolean }) {
  // What it shows while open is what it fades with: the last open render, kept whenever what is drawn changes.
  const drawn = `${props.id}|${props.trigger}|${props.active}|${props.options.map((option) => option.id).join(',')}`;
  const [kept, setKept] = useState<{ drawn: string; props: ComposerMenuProps } | null>(open ? { drawn, props } : null);
  if (open && kept?.drawn !== drawn) setKept({ drawn, props });
  const pop = usePop(open, { from: 'above' });
  const data = open ? props : kept?.props;
  if (!pop.mounted || !data) return null;
  return <ComposerMenuList {...data} popProps={pop.props} />;
}

function ComposerMenuList({ id, options, active, onPick, onHover, trigger, popProps }: ComposerMenuProps & { popProps: ReturnType<typeof usePop>['props'] }) {
  const list = useRef<HTMLDivElement>(null);
  // The menu is never taller than the room above its box inside whatever clips it (a phone's thread sheet is short): `--cmenu-room` is that room,
  // and the CSS takes the smaller of it and the menu's own height; what does not fit scrolls inside the menu.
  useLayoutEffect(() => {
    const menu = list.current;
    const box = menu?.parentElement;
    if (!menu || !box) return undefined;
    const measure = () => {
      let top = window.visualViewport?.offsetTop ?? 0;
      for (let element = box.parentElement; element; element = element.parentElement) {
        if (getComputedStyle(element).overflowY !== 'visible') top = Math.max(top, element.getBoundingClientRect().top);
      }
      menu.style.setProperty('--cmenu-room', `${Math.max(0, Math.floor(box.getBoundingClientRect().top - top - 16))}px`);
    };
    measure();
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    return () => { window.removeEventListener('resize', measure); window.visualViewport?.removeEventListener('resize', measure); };
  }, [options.length]);
  // The arrow keys reach the rows at the end of a long list: the row they act on stays in view. Only this menu scrolls, and no row
  // reads the pointer the scroll left under it as a hover.
  const activeId = options[active] ? `${id}-${options[active]!.id}` : null;
  useEffect(() => {
    const menu = list.current;
    const row = activeId ? document.getElementById(activeId) : null;
    if (!menu || !row || menu.scrollHeight <= menu.clientHeight) return;
    if (row.offsetTop < menu.scrollTop) menu.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > menu.scrollTop + menu.clientHeight) menu.scrollTop = row.offsetTop + row.offsetHeight - menu.clientHeight;
  }, [activeId]);
  // Only a pointer that really moved chooses a row: the browser repeats the last mouse move after a scroll or a layout change.
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const hover = (index: number) => (event: { clientX: number; clientY: number; movementX: number; movementY: number }) => {
    const last = pointer.current;
    pointer.current = { x: event.clientX, y: event.clientY };
    if (event.movementX === 0 && event.movementY === 0) return;
    if (last && last.x === event.clientX && last.y === event.clientY) return;
    if (index !== active) onHover(index);
  };
  return (
    <div {...popProps} ref={list} className="cmenu" id={id} role="listbox" aria-label={trigger === '@' ? 'Mention' : 'Actions'}
      // The field keeps focus: choosing never moves it, so the press must not blur the field.
      onMouseDown={(event) => event.preventDefault()}>
      <div className="cmenu__h" aria-hidden="true">{trigger === '@' ? 'Mention' : 'Actions'}</div>
      {options.map((option, index) => (
        <div key={option.id} id={`${id}-${option.id}`} role="option" aria-selected={index === active}
          className={`cmenu__o${option.kind === 'suggestion' ? ' cmenu__o--ask' : ''}${index === active ? ' is-active' : ''}`}
          data-ai-surface={option.kind === 'suggestion' || option.slash && AI_ACTIONS.has(option.slash) ? 'composer-ai-option' : undefined}
          aria-label={option.kind === 'suggestion' ? `Ask your assistant: ${option.label}` : undefined}
          onMouseMove={hover(index)} onClick={() => onPick(option)}>
          {option.kind === 'action' ? <code className="cmenu__cmd">{option.label}</code>
            : option.kind === 'suggestion' ? <span className="cmenu__name">{option.label}</span>
              : <Fragment><Avatar name={option.label} id={option.personId} size="md" /><span className="cmenu__name">{option.label}</span></Fragment>}
          {option.kind === 'suggestion' ? null : <span className="cmenu__hint">{option.hint}</span>}
          {index === active ? <kbd className="cmenu__kbd" aria-hidden="true">↵</kbd> : null}
        </div>
      ))}
    </div>
  );
}
