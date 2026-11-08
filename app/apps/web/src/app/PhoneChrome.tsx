import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Avatar, BottomNav, FluxLogo, Icon, IconButton, Overlay, publishTopEdge, type BottomNavItem, type IconName } from '../ui';
import { useShellActions } from './shellContext';
import { useShellData, type ProjectSummary } from './data';

/**
 * The phone's chrome (F-026 §4 Phone, S2): one floating tab capsule Home · Projects · Inbox with a
 * round Search beside it, one floating "+" above it, and a header of round controls. A space's views are the
 * segmented control in the header's second row (#873); a direct message's one view is named by its title menu.
 * A conversation gets the whole screen: the dock is not rendered there.
 */

/** The places of the tab capsule; Messages live inside Projects. */
export function phonePlaces(pathname: string, inboxUnread: number): BottomNavItem[] {
  // Only Home itself is Home (#763 NV-1); My tasks and My map are pages reached from its rows, with "‹ Home".
  const home = pathname === '/';
  const inbox = /^\/inbox(\/|$)/.test(pathname);
  const projects = /^\/(projects|dm)(\/|$)/.test(pathname);
  return [
    { id: 'home', label: 'Home', to: '/', icon: 'home', current: home },
    { id: 'projects', label: 'Spaces', to: '/projects', icon: 'board', current: projects },
    { id: 'inbox', label: 'Inbox', to: '/inbox', icon: 'inbox', current: inbox, ...(inboxUnread ? { countLabel: ', something new', dot: true } : {}) },
  ];
}

/** Where the dock is not drawn: a conversation (a project's, a direct message), and forms that start something. */
export function phoneHidesDock(pathname: string): boolean {
  if (pathname === '/dm/new') return true;
  if (/^\/projects\/[^/]+(\/conversations\/[^/]+)?$/.test(pathname)) return true;
  // Spokój (rule 7): a project's views keep the header's Search, not the capsule.
  if (/^\/projects\/[^/]+\/(tasks|map|docs|agents)(\/|$)/.test(pathname)) return true;
  return /^\/dm\/[^/]+$/.test(pathname);
}

/** The places that offer "+": lists and views, not editors, sketches, settings or Search. */
export function phoneOffersCreate(pathname: string): boolean {
  return /^\/(inbox|dm|projects|tasks|map)?$/.test(pathname) || /^\/projects\/[^/]+\/(tasks|map|docs|agents)$/.test(pathname);
}

/**
 * The floating capsule (places and round Search) and the "+" above it. Inside a project's views and a direct
 * message's sketches (Spokój rule 7) the capsule steps aside: Search is in the header, and only the "+" floats.
 */
export function PhoneDock({ places, onSearch, onCreate, create, capsule = true }: { places: BottomNavItem[]; onSearch: () => void; onCreate: () => void; create: boolean; capsule?: boolean }) {
  const fab = useRef<HTMLButtonElement>(null);
  // Feedback (the toast) stays 8 px clear of the "+" wherever it really is: above the capsule, or alone above the
  // bottom safe area. Publish its top edge instead of assuming the dock's padding and the "+" size (#639).
  useLayoutEffect(() => {
    const node = fab.current;
    return node ? publishTopEdge(node, '--ui-fab-inset', node.parentElement ? [node.parentElement] : []) : undefined;
  }, [create]);
  return (
    <div className={`phone-dock app__viewbar${capsule ? '' : ' phone-dock--solo'}`}>
      {create ? (
        <button ref={fab} type="button" className="phone-fab" aria-label="Create" aria-haspopup="dialog" onClick={onCreate}>
          <Icon name="plus" size={24} />
        </button>
      ) : null}
      {capsule ? (
        <>
          <BottomNav className="phone-dock__bar" label="Main places" items={places} />
          <button type="button" className="phone-dock__search" aria-label="Search" onClick={onSearch}><Icon name="search" size={22} /></button>
        </>
      ) : null}
    </div>
  );
}

/** A round button that leads back to where the person came from. */
export function PhoneBack({ onBack }: { onBack: () => void }) {
  return <IconButton icon="chevron-left" label="Back" size={20} className="phead__round phead__back" data-tip-align="start" onClick={onBack} />;
}

export interface PhoneMenuItem { id: string; label: string; to: string; icon: IconName; note?: ReactNode; current?: boolean; end?: boolean }

/**
 * A direct message's title menu: it names the conversation and opens the places inside it. "Message info" is the last row.
 * (A space's title is plain: its views are the segmented control, #873.)
 */
export function PhoneTitleMenu({ title, subtitle, items, onDetails, detailsLabel = 'Message info', lead }: {
  title: string; subtitle: ReactNode; items: PhoneMenuItem[]; onDetails: (() => void) | null; detailsLabel?: string; lead?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const menuId = useId();
  const firstRef = useRef<HTMLAnchorElement>(null);
  return (
    <div className="phead__id">
      {lead}
      <div className="phead__title">
        <h1 id={titleId} title={title}>
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

interface Row { id: string; label: string; icon: IconName; run: (() => void) | null; hint?: string }

/**
 * "+" Create (F-026 S2, S3, #867, #1013): the same five types as the computer's New (C), as five rows: Task, Thought, Decision, Page and
 * Space. A row opens the one Create window on that type, in the space you are in or your first one (the window has the space picker; a
 * thought needs none, and a space is made in the company, so a guest does not start spaces). Writing a message and attaching a file or
 * link happen in the composer.
 */
export function PhoneCreate({ open, onClose, projects, projectId }: {
  open: boolean; onClose: () => void; projects: ProjectSummary[]; projectId: string | undefined;
}) {
  const titleId = useId();
  const { workspace } = useShellData();
  const { openCreate } = useShellActions();
  const chosen = projects.find((project) => project.id === projectId) ?? projects[0];
  const create = (request: Parameters<typeof openCreate>[0]) => () => { onClose(); requestAnimationFrame(() => openCreate(request)); };
  const rows: Row[] = [
    { id: 'task', label: 'Task', icon: 'tasks', run: chosen ? create({ kind: 'task', projectId: chosen.id }) : null, hint: 'needs a space' },
    { id: 'thought', label: 'Thought', icon: 'chat', run: create({ kind: 'thought' }) },
    { id: 'decision', label: 'Decision', icon: 'goal', run: chosen ? create({ kind: 'decision', projectId: chosen.id }) : null, hint: 'needs a space' },
    { id: 'page', label: 'Page', icon: 'doc', run: chosen ? create({ kind: 'page', projectId: chosen.id }) : null, hint: 'needs a space' },
    { id: 'space', label: 'Space', icon: 'grid', run: workspace?.role === 'guest' ? null : create({ kind: 'space' }), hint: 'not for guests' },
  ];
  return (
    <Overlay open={open} onClose={onClose} placement="bottom" labelledBy={titleId} className="ui-list-sheet phone-create">
      <div className="ui-grabber" aria-hidden="true"><span /></div>
      <h2 id={titleId} className="ui-list-sheet__title">Create</h2>
      <ul className="ui-list-sheet__rows phone-create__rows">
        {rows.map((row) => (
          <li key={row.id}>
            <button type="button" className="ui-list-sheet__row" aria-disabled={row.run ? undefined : true} onClick={() => { row.run?.(); }}>
              <span className="ui-list-sheet__tile" aria-hidden="true"><Icon name={row.icon} size={20} /></span>
              <span>{row.label}</span>
              {!row.run && row.hint ? <small className="ui-list-sheet__note">{row.hint}</small> : null}
            </button>
          </li>
        ))}
      </ul>
      <p className="ui-list-sheet__foot">The same five on the computer (C).</p>
    </Overlay>
  );
}
