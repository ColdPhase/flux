import { useId, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Avatar, BottomNav, FluxLogo, Icon, IconButton, Overlay, type BottomNavItem, type IconName } from '../ui';
import type { ProjectSummary } from './data';

/**
 * The phone's chrome (F-026 §4 Phone, S2): one floating tab capsule Home · Projects · Inbox with a
 * round Search beside it, one floating "+" above it, and a header whose title is the view menu.
 * A conversation gets the whole screen: the dock is not rendered there.
 */

/** The places of the tab capsule; Messages live inside Projects. */
export function phonePlaces(pathname: string, inboxUnread: number): BottomNavItem[] {
  const home = /^\/(map|tasks|docs)?(\/|$)/.test(pathname);
  const inbox = /^\/inbox(\/|$)/.test(pathname);
  const projects = /^\/(projects|dm)(\/|$)/.test(pathname);
  return [
    { id: 'home', label: 'Home', to: '/', icon: 'home', current: home },
    { id: 'projects', label: 'Projects', to: '/projects', icon: 'board', current: projects },
    { id: 'inbox', label: 'Inbox', to: '/inbox', icon: 'inbox', current: inbox, ...(inboxUnread ? { countLabel: ', something new', dot: true } : {}) },
  ];
}

/** Where the dock is not drawn: a conversation (a project's, a direct message), and forms that start something. */
export function phoneHidesDock(pathname: string): boolean {
  if (/^\/projects\/new$/.test(pathname) || pathname === '/dm/new') return true;
  if (/^\/projects\/[^/]+(\/conversations\/[^/]+)?$/.test(pathname)) return true;
  return /^\/dm\/[^/]+$/.test(pathname);
}

/** The places that offer "+": lists and views, not editors, sketches, settings or Search. */
export function phoneOffersCreate(pathname: string): boolean {
  return /^\/(inbox|dm|projects|tasks|map|docs)?$/.test(pathname) || /^\/projects\/[^/]+\/(tasks|map|docs|agents)$/.test(pathname);
}

export function PhoneDock({ places, onSearch, onCreate, create }: { places: BottomNavItem[]; onSearch: () => void; onCreate: () => void; create: boolean }) {
  return (
    <div className="phone-dock app__viewbar">
      {create ? (
        <button type="button" className="phone-fab" aria-label="Create" aria-haspopup="dialog" onClick={onCreate}>
          <Icon name="plus" size={24} />
        </button>
      ) : null}
      <BottomNav className="phone-dock__bar" label="Main places" items={places} />
      <button type="button" className="phone-dock__search" aria-label="Search" onClick={onSearch}><Icon name="search" size={22} /></button>
    </div>
  );
}

/** A round button that leads back to where the person came from. */
export function PhoneBack({ onBack }: { onBack: () => void }) {
  return <IconButton icon="chevron-left" label="Back" size={20} className="phead__round phead__back" data-tip-align="start" onClick={onBack} />;
}

export interface PhoneMenuItem { id: string; label: string; to: string; icon: IconName; note?: string; current?: boolean; end?: boolean }

/**
 * The title is the view menu: it names the project (or Home, or the conversation) and the view
 * shown, and opens the places inside it. "Details, goal and people" is the last row.
 */
export function PhoneTitleMenu({ title, subtitle, items, onDetails, detailsLabel = 'Details, goal and people', lead, matters }: {
  title: string; subtitle: ReactNode; items: PhoneMenuItem[]; onDetails: (() => void) | null; detailsLabel?: string; lead?: ReactNode;
  /** A project's "What matters" (#133), kept reachable below Details now that the state row is gone. */
  matters?: { count: number; run: () => void };
}) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const menuId = useId();
  const firstRef = useRef<HTMLAnchorElement>(null);
  return (
    <div className="phead__id">
      {lead}
      <div className="phead__title">
        <h1 id={titleId}>
          <button type="button" className="phead__menu" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={() => setOpen(true)}>
            <span className="phead__name">{title}</span><Icon name="chevron-down" size={14} />
          </button>
        </h1>
        <p className="phead__sub">{subtitle}</p>
      </div>
      <Overlay open={open} onClose={() => setOpen(false)} placement="center" labelledBy={`${menuId}-t`} id={menuId} className="phone-menu" initialFocus={firstRef}>
        <h2 className="phone-menu__t" id={`${menuId}-t`}>{title}<span className="ui-vh">, views</span></h2>
        <ul className="phone-menu__list">
          {items.map((item, index) => (
            <li key={item.id}>
              <Link ref={index === 0 ? firstRef : undefined} to={item.to} className="phone-menu__item" aria-current={item.current ? 'page' : undefined} onClick={() => setOpen(false)}>
                <Icon name={item.icon} size={20} /><span className="phone-menu__l">{item.label}</span>
                {item.note ? <span className="phone-menu__n">{item.note}</span> : null}
                {item.current ? <Icon name="check" size={18} className="phone-menu__ok" /> : null}
              </Link>
            </li>
          ))}
        </ul>
        {onDetails ? (
          <button type="button" className="phone-menu__item phone-menu__details" onClick={() => { setOpen(false); onDetails(); }}>
            <Icon name="panel" size={20} /><span className="phone-menu__l">{detailsLabel}</span>
          </button>
        ) : null}
        {matters ? (
          <button type="button" className="phone-menu__item phone-menu__quiet" onClick={() => { setOpen(false); matters.run(); }}>
            <Icon name="leaf" size={20} /><span className="phone-menu__l">What matters</span>
            {matters.count ? <span className="phone-menu__n">{matters.count} {matters.count === 1 ? 'needs' : 'need'} you</span> : null}
          </button>
        ) : null}
      </Overlay>
    </div>
  );
}

/** The account's round avatar: Settings, the account and signing out live behind it. */
export function PhoneAvatar({ name }: { name: string }) {
  return <Link to="/settings" className="phead__avatar" aria-label="Settings and account"><Avatar name={name} size="md" /></Link>;
}

export function PhoneHomeLead() {
  return <span className="phead__logo"><FluxLogo size={28} /></span>;
}

interface Tile { id: string; label: string; icon: IconName; run: (() => void) | null; hint?: string }

/**
 * "+" Create (F-026 S2): Task, Thought, Message, Decision, File or link, Sketch. Until the full Create
 * window (#345) lands, each tile opens the place where that thing is made today; the project the
 * thing belongs to is the one you are in, or the one chosen here.
 */
export function PhoneCreate({ open, onClose, projects, projectId, go, onThought }: {
  open: boolean; onClose: () => void; projects: ProjectSummary[]; projectId: string | undefined;
  go: (to: string) => void; onThought: () => void;
}) {
  const titleId = useId();
  const [picked, setPicked] = useState<string | null>(null);
  const chosen = projects.find((project) => project.id === (picked ?? projectId)) ?? projects[0];
  const to = (path: string | null) => (path ? () => { onClose(); go(path); } : null);
  const inProject = chosen ? `/projects/${chosen.id}` : null;
  const tiles: Tile[] = [
    { id: 'task', label: 'Task', icon: 'plus', run: to(inProject && `${inProject}/tasks?new=task`), hint: 'needs a project' },
    { id: 'thought', label: 'Thought', icon: 'edit', run: () => { onClose(); onThought(); } },
    { id: 'message', label: 'Message', icon: 'chat', run: to('/dm/new') },
    { id: 'decision', label: 'Decision', icon: 'rule', run: to(inProject), hint: 'needs a project' },
    { id: 'file', label: 'File or link', icon: 'clip', run: to(inProject), hint: 'needs a project' },
    { id: 'sketch', label: 'Sketch', icon: 'shape', run: to(inProject ? `${inProject}/map` : '/map') },
  ];
  return (
    <Overlay open={open} onClose={onClose} placement="bottom" labelledBy={titleId} className="phone-create">
      <span className="phone-create__grab" aria-hidden="true" />
      <div className="phone-create__head">
        <h2 id={titleId}>Create</h2>
        {projects.length ? (
          <label className="phone-create__project">
            <span className="phone-create__tile" aria-hidden="true">{(chosen?.name.trim()[0] ?? '?').toUpperCase()}</span>
            <span className="ui-vh">Project</span>
            <select value={chosen?.id ?? ''} onChange={(event) => setPicked(event.target.value)}>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
            <Icon name="chevron-down" size={12} />
          </label>
        ) : null}
      </div>
      <ul className="phone-create__grid">
        {tiles.map((tile) => (
          <li key={tile.id}>
            <button type="button" className="phone-create__item" aria-disabled={tile.run ? undefined : true}
              onClick={() => { if (tile.run) tile.run(); }}>
              <Icon name={tile.icon} size={24} /><span>{tile.label}</span>
              {!tile.run && tile.hint ? <small>{tile.hint}</small> : null}
            </button>
          </li>
        ))}
      </ul>
    </Overlay>
  );
}
