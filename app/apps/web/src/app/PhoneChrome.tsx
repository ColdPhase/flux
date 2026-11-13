import { useId, useLayoutEffect, useRef } from 'react';
import { Link } from 'react-router';
import { Avatar, BottomNav, FluxLogo, Icon, IconButton, Overlay, publishTopEdge, type BottomNavItem, type IconName } from '../ui';
import { useShellActions } from './shellContext';
import { useShellData, type ProjectSummary } from './data';

/**
 * The phone's chrome (F-026 §4 Phone, S2): one floating tab capsule Home · Projects · Inbox with a
 * round Search beside it, one floating "+" above it, and a header of plain icons. A space's views are the
 * underline tabs in the header's second row (#873, #1239); a direct message's header is a space's without them (#1374).
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
    { id: 'projects', label: 'Spaces', to: '/projects', icon: 'grid', current: projects },
    { id: 'inbox', label: 'Inbox', to: '/inbox', icon: 'inbox', current: inbox, ...(inboxUnread ? { countLabel: ', something new', dot: true } : {}) },
  ];
}

/** Where the dock is not drawn: a conversation (a project's, a direct message, an agent's chat), and forms that start something. */
export function phoneHidesDock(pathname: string): boolean {
  if (pathname === '/dm/new') return true;
  if (/^\/agents\/[^/]+$/.test(pathname)) return true;
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

/** A plain chevron (no fill, a 44 px hit area) that leads back to where the person came from. */
export function PhoneBack({ onBack }: { onBack: () => void }) {
  return <IconButton icon="chevron-left" label="Back" size={24} className="phead__round phead__back" data-tip-align="start" onClick={onBack} />;
}

/** The account's round avatar: Settings, the account and signing out live behind it. */
export function PhoneAvatar({ id, name }: { id: string; name: string }) {
  return <Link to="/settings" className="phead__avatar" aria-label="Settings and account"><Avatar name={name} id={id} size="md" /></Link>;
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
    { id: 'decision', label: 'Decision', icon: 'flag', run: chosen ? create({ kind: 'decision', projectId: chosen.id }) : null, hint: 'needs a space' },
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
    </Overlay>
  );
}
