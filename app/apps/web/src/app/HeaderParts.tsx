import { Fragment, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { ProjectPerson } from '@flux/contracts';
import { Avatar, Icon, IconButton, Kreska, usePop } from '../ui';
import { clock } from './focus';

/**
 * The people and agents of a project as faces, one button to "Who can see this" (F-026 §4 header).
 * People are grey circles with initials; agents are Kreska, monochrome outside the Agents view.
 */
export function HeaderFaces({ people, audience, onOpen }: { people: ProjectPerson[]; audience: string; onOpen: () => void }) {
  const humans = people.filter((person) => person.kind === 'human');
  const agents = people.filter((person) => person.kind === 'agent');
  const shown = [...humans.slice(0, 3), ...agents.slice(0, 1)];
  const more = people.length - shown.length;
  return (
    <button type="button" className="top__audience top__faces" onClick={onOpen} aria-haspopup="dialog" title={audience}>
      <span className="ui-vh">{audience}, who can see this project</span>
      {shown.map((person) => person.kind === 'agent'
        ? <Kreska key={person.id} size={22} className="top__face" />
        : <span key={person.id} className="top__face"><Avatar name={person.name} size="sm" /></span>)}
      {more > 0 ? <span className="top__more-faces" aria-hidden="true">+{more}</span> : null}
    </button>
  );
}

/** "N needs you" as a quiet text link (direction C, #763): this project's items of the Inbox's queue, and it opens the Inbox on them (#763 A2). */
export function NeedsYouChip({ count, project, onOpen }: { count: number; project: string | null; onOpen: () => void }) {
  return (
    <button type="button" className="top__needs" onClick={onOpen} title={project ? `Open what needs you in ${project}, in the Inbox` : 'Open in the Inbox'}>
      {count} needs you
    </button>
  );
}

/** Focus on: the one thing the header says, and the way out (`F`). */
export function FocusPill({ until, onEnd, uncertain = false }: { until: Date; onEnd: () => void; uncertain?: boolean }) {
  return (
    <span className="top__focus">
      <button type="button" className="ui-pill ui-pill--inv top__focus-pill" aria-keyshortcuts="F" onClick={onEnd}
        title={uncertain ? 'Check current notification pause (F)' : 'End focus (F)'}>
        <Icon name="focus" size={13} />Focus · {uncertain ? 'last confirmed pause until ' : 'notifications paused until '}<time dateTime={until.toISOString()}>{clock(until)}</time>
        <span className="ui-vh">{uncertain ? '. Check current notification pause' : '. End focus'}</span>
      </button>
      <kbd aria-hidden="true">F</kbd>
    </span>
  );
}

/**
 * `narrow`: offered here only when the header has no room for it (Spokój rule 3). `node` is a row that keeps its own
 * state (the header's Together); a click on its enabled `[data-more-row]` closes the menu.
 */
export type MoreItem = { label: string; run: () => void; keys?: string; checked?: boolean; narrow?: boolean }
  | { label: string; node: ReactNode };

/** The menu's rows that are shown: rows a wide header keeps in its own row are in the menu but hidden, and the keys skip them. */
const shownRows = (menu: HTMLElement | null) => [...(menu?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])].filter((el) => el.getClientRects().length > 0);

/** More (⋯): the place's quieter actions, each with its key shown (F-026 §4, S18). */
export function MoreMenu({ items, label = 'More', icon = 'more' }: { items: MoreItem[]; label?: string; icon?: 'more' | 'plus' }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const pop = usePop(open);
  useEffect(() => {
    if (!open) return undefined;
    shownRows(menu.current)[0]?.focus();
    const away = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  const close = () => { setOpen(false); button.current?.focus(); };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const shown = shownRows(menu.current);
    const at = shown.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); shown[(at + 1) % shown.length]?.focus(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); shown[(at - 1 + shown.length) % shown.length]?.focus(); }
    else if (event.key === 'Tab') setOpen(false);
  };
  return (
    <span className="top__more">
      <IconButton ref={button} icon={icon} label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
        onClick={() => setOpen((value) => !value)} />
      {pop.mounted ? (
        <div {...pop.props} ref={menu} id={id} className="newmenu__menu top__more-menu" role="menu" aria-label={label} onKeyDown={onKeyDown}
          onClick={(event) => { if ((event.target as Element).closest('[data-more-row]:not([aria-disabled="true"])')) close(); }}>
          {items.map((item) => 'node' in item ? <Fragment key={item.label}>{item.node}</Fragment> : (
            <button key={item.label} type="button" role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={item.checked}
              className={`newmenu__item${item.narrow ? ' top__more-narrow' : ''}`} aria-keyshortcuts={item.keys} onClick={() => { button.current?.focus(); setOpen(false); item.run(); }}>
              <span>{item.label}</span>{item.keys ? <kbd aria-hidden="true">{item.keys}</kbd> : null}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}
