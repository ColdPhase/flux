import { Fragment, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { ProjectPerson } from '@flux/contracts';
import { Avatar, IconButton, Kreska, usePop } from '../ui';
import { activeFirst } from '../people/lastActive';

/**
 * The people and agents of a project as faces, one button to the space's people (F-026 §4 header).
 * People are grey circles with initials; agents are Kreska, monochrome outside the Agents view. The faces touch, side by side as drawn, and
 * what does not fit is one "+N" face. The button hugs them and ends at the slot's right edge; the slot (`top__faces-slot`) keeps the width the
 * header's other controls rely on whatever the number of faces (#873), so no pill is wider than its faces (#1236). A header pane of 70 rem
 * and up has room for three people, the agent and "+N"; a narrower one for two people, the agent and "+N" (a two-digit one too), so both
 * counts are drawn and the pane's width chooses (project-header.css). The order is the space's own: people first, then the agent.
 */
export function HeaderFaces({ people, meId, audience, onOpen }: { people: ProjectPerson[]; meId: string; audience: string; onOpen: () => void }) {
  // The people active now come first (#1236, #1225), then the others as the list has them, and an agent last.
  const ordered = activeFirst(people, meId);
  const humans = ordered.filter((person) => person.kind === 'human');
  const agents = ordered.filter((person) => person.kind === 'agent');
  const shown = [...humans.slice(0, 3), ...agents.slice(0, 1)];
  const narrow = Math.min(humans.length, 2) + Math.min(agents.length, 1);
  /** What is left beyond `faces` drawn: "+5", and "99+" from a hundred so it stays as wide as "+99". */
  const rest = (faces: number) => people.length - faces;
  const count = (faces: number) => (rest(faces) > 99 ? '99+' : `+${rest(faces)}`);
  return (
    <span className="top__faces-slot">
      <button type="button" className="top__audience top__faces" onClick={onOpen} aria-haspopup="dialog" title={audience}>
        <span className="ui-vh">{audience}, who can see this space</span>
        {shown.map((person, at) => person.kind === 'agent'
          ? <Kreska key={person.id} size={20} className="top__face" />
          : <span key={person.id} className={`top__face${at === 2 ? ' top__face--wide' : ''}`}><Avatar name={person.name} id={person.id} size="sm" /></span>)}
        {rest(narrow) > 0 ? <span className="top__more-faces top__more-faces--narrow" aria-hidden="true">{count(narrow)}</span> : null}
        {rest(shown.length) > 0 ? <span className="top__more-faces top__more-faces--wide" aria-hidden="true">{count(shown.length)}</span> : null}
      </button>
    </span>
  );
}

/**
 * `narrow`: offered here only when the header has no room for it (Spokój rule 3). `hint`: one small line under the label that says what the row
 * does (Mute: what still arrives, #1249). `node` is a row that keeps its own
 * state (the header's Call); a click on its enabled `[data-more-row]` closes the menu.
 */
export type MoreItem = { label: string; run: () => void; keys?: string; checked?: boolean; narrow?: boolean | 'people'; hint?: string }
  | { label: string; node: ReactNode };

/** The menu's rows that are shown: rows a wide header keeps in its own row are in the menu but hidden, and the keys skip them. */
const shownRows = (menu: HTMLElement | null) => [...(menu?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])].filter((el) => el.getClientRects().length > 0);

/** More (⋯): the place's quieter actions, each with its key shown (F-026 §4, S18). `cue` is a small mark on the button (a call is live). */
export function MoreMenu({ items, label = 'More', icon = 'more', className, size, cue }: { items: MoreItem[]; label?: string; icon?: 'more' | 'plus'; className?: string; size?: number; cue?: (id: string, buttonId: string) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const buttonId = useId();
  const cueId = useId();
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
      {/* A mark on the button (a call is live) adds its words to the button's name: "More, a call is live in this space". */}
      <IconButton ref={button} id={buttonId} icon={icon} label={label} size={size} className={className} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
        onClick={() => setOpen((value) => !value)} />
      {cue ? cue(cueId, buttonId) : null}
      {pop.mounted ? (
        <div {...pop.props} ref={menu} id={id} className="newmenu__menu top__more-menu" role="menu" aria-label={label} onKeyDown={onKeyDown}
          onClick={(event) => { if ((event.target as Element).closest('[data-more-row]:not([aria-disabled="true"])')) close(); }}>
          {items.map((item) => 'node' in item ? <Fragment key={item.label}>{item.node}</Fragment> : (
            <button key={item.label} type="button" role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={item.checked}
              className={`newmenu__item${item.narrow ? ' top__more-narrow' : ''}${item.narrow === 'people' ? ' top__more-people' : ''}`} aria-keyshortcuts={item.keys} onClick={() => { button.current?.focus(); setOpen(false); item.run(); }}>
              {item.hint ? <span className="top__more-text"><span>{item.label}</span><small>{item.hint}</small></span> : <span>{item.label}</span>}
              {item.keys ? <kbd aria-hidden="true">{item.keys}</kbd> : null}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}
