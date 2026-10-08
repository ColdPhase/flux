import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { ProjectPerson } from '@flux/contracts';
import { Avatar, Icon, IconButton, Kreska } from '../ui';
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

/** "N needs you" as an inverted pill; it opens what needs you in this project. */
export function NeedsYouChip({ count, open, onToggle }: { count: number; open: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="ui-pill ui-pill--inv top__needs" aria-expanded={open} aria-controls={open ? 'details' : undefined} onClick={onToggle}>
      <span className="top__needs-dot" aria-hidden="true" />{count} needs you
    </button>
  );
}

/** Focus on: the one thing the header says, and the way out (`F`). */
export function FocusPill({ until, onEnd }: { until: Date; onEnd: () => void }) {
  return (
    <span className="top__focus">
      <button type="button" className="ui-pill ui-pill--inv top__focus-pill" aria-keyshortcuts="F" onClick={onEnd}
        title="End focus (F)">
        <Icon name="focus" size={13} />Focus · notifications paused until <time dateTime={until.toISOString()}>{clock(until)}</time>
        <span className="ui-vh">. End focus</span>
      </button>
      <kbd aria-hidden="true">F</kbd>
    </span>
  );
}

export interface MoreItem { label: string; run: () => void; keys?: string; checked?: boolean }

/** More (⋯): the place's quieter actions, each with its key shown (F-026 §4, S18). */
export function MoreMenu({ items }: { items: MoreItem[] }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return undefined;
    menu.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
    const away = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  const close = () => { setOpen(false); button.current?.focus(); };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const entries = [...(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
    const at = entries.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); entries[(at + 1) % entries.length]?.focus(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); entries[(at - 1 + entries.length) % entries.length]?.focus(); }
    else if (event.key === 'Tab') setOpen(false);
  };
  return (
    <span className="top__more">
      <IconButton ref={button} icon="more" label="More" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
        onClick={() => setOpen((value) => !value)} />
      {open ? (
        <div ref={menu} id={id} className="newmenu__menu top__more-menu" role="menu" aria-label="More" onKeyDown={onKeyDown}>
          {items.map((item) => (
            <button key={item.label} type="button" role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={item.checked}
              className="newmenu__item" aria-keyshortcuts={item.keys} onClick={() => { button.current?.focus(); setOpen(false); item.run(); }}>
              <span>{item.label}</span>{item.keys ? <kbd aria-hidden="true">{item.keys}</kbd> : null}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}
