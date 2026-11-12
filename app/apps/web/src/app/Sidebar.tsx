import { useEffect, useMemo, useRef } from 'react';
import { Link, NavLink, useLocation, useNavigation } from 'react-router';
import { useProjectNews } from './projectNews';
import { Avatar, FluxLogo, Icon, IconButton, Kreska, choosesInPlace, useTravelingHighlight } from '../ui';
import type { MyAgent } from '@flux/contracts';
import { type DirectMessageSummary, type ProjectSummary, type WorkspaceSummary } from './data';
import { placeOf } from './place';
import { UserMenu } from './UserMenu';
import { useShellActions } from './shellContext';
import { WorkingAgent } from './WorkingAgent';
import { NewMenu } from './NewMenu';
import { useAgentUnread } from '../my-agents/AgentChatDots';
import { lockedLine, useEncryptedWorkspaceIds, useLockedWorkspaces } from '../encryption/state';
import { usePlaceMutes } from '../notifications/mutes';

export interface SidebarProps {
  workspace: WorkspaceSummary | null;
  projects: ProjectSummary[];
  directMessages: DirectMessageSummary[];
  /** The person's agents, the first (Assistant) pinned at the top of Messages. */
  agents?: MyAgent[];
  user: { name: string; email: string };
  /** In the drawer: a close button and closing after navigation. */
  onClose?: () => void;
  /** How many Inbox items are unread; 0 shows no count. */
  inboxUnread?: number;
  titleId?: string;
  /** The computer's 64px rail (`[`, F-026 S19): icons only. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

/** A space's letter tile, as the final design draws them (F-026 §4). */
function ProjectTile({ name, size = 20 }: { name: string; size?: number }) {
  return <span className="side__pj" style={{ width: size, height: size }} aria-hidden="true">{(name.trim()[0] ?? '?').toUpperCase()}</span>;
}

/** The tile of a space that waits to be unlocked: the lock glyph where a project has its letter (F-030, #655). */
function LockTile({ size = 20 }: { size?: number }) {
  return <span className="side__pj side__pj--lock" style={{ width: size, height: size }} aria-hidden="true"><Icon name="lock" size={Math.round(size * 0.6)} /></span>;
}

/**
 * The sidebar (F-026 §4, F-037): the logo and the collapse control; New (C) and Search (⌘K); Home, Inbox, My tasks
 * and My map; Spaces, one flat list of the spaces the person was added to; then Messages; the working agent with Stop;
 * the account and Settings. Collapsed, it is the 64px rail of icons. A space has one conversation (UI116-1): its roots
 * and threads live in its Conversation view, not in this list. A space never reveals another's contents.
 */
export function Sidebar({ projects, directMessages, agents = [], user, onClose, titleId, inboxUnread = 0, collapsed = false, onToggleCollapsed }: SidebarProps) {
  const { openSearch, openCreate } = useShellActions();
  // Encrypted spaces that wait to be unlocked (F-030, #655): one row each, in place of their projects.
  const locked = useLockedWorkspaces();
  // An encrypted space has a small lock after its name (F-026 §4); its link's name says so.
  const encryptedIn = useEncryptedWorkspaceIds();
  const encrypted = (project: ProjectSummary) => !!project.workspaceId && encryptedIn.has(project.workspaceId);
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  const location = useLocation();
  const place = placeOf(location.pathname);
  const projectId = location.pathname.match(/^\/projects\/([^/]+)/)?.[1];
  const news = useProjectNews(useMemo(() => projects.map((project) => project.id), [projects]));
  // The places this person muted (#1249): a small muted mark after the name; what is new there is a quiet count, not the dot.
  const { muted } = usePlaceMutes();
  const navigate = onClose ? () => onClose() : undefined;
  const sketchbook = place === 'home' && /^\/map(\/|$)/.test(location.pathname);
  // Home is current only on Home (#763 NV-1): a page reached from it (the Wiki, New space, a missing page) is no place
  // of the sidebar, so nothing is marked current there.
  const home = location.pathname === '/';
  const myTasks = location.pathname === '/tasks';
  const inbox = /^\/inbox(\/|$)/.test(location.pathname);
  // Subtle navigation feedback (#155, UI116-5): the highlight travels to a chosen project at once, while
  // the project loads; the row becomes current (aria-current) when its content shows. A newer choice
  // retargets it, and a navigation that ends elsewhere (refused, cancelled) returns it.
  const navigation = useNavigation();
  const pendingProject = navigation.state !== 'idle' ? navigation.location?.pathname.match(/^\/projects\/([^/]+)/)?.[1] ?? null : null;
  const projectList = useRef<HTMLUListElement>(null);
  const glide = useRef<HTMLLIElement>(null);
  const glideTo = useTravelingHighlight(projectList, glide, ['.side__project[data-pending]', '.side__project.is-open']);
  // The collapsed rail (a tablet's sidebar, or `[` on a computer) has the same highlight over its project tiles; only one
  // of the two lists is rendered at a time, and the other's refs are empty.
  // Where the rail's middle band can scroll (a short window, #727), its lower edge fades softly, so a cut tile reads as
  // "more below"; the fade is static, set only when the band's size or contents change.
  const railMiddle = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const band = railMiddle.current;
    if (!band) return undefined;
    const check = () => band.toggleAttribute('data-scrolls', band.scrollHeight > band.clientHeight + 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(band);
    for (const child of band.children) observer.observe(child);
    return () => observer.disconnect();
  }, [collapsed, onClose, projects.length, directMessages.length, agents.length]);
  const railProjects = useRef<HTMLElement>(null);
  const railGlide = useRef<HTMLSpanElement>(null);
  const glideRailTo = useTravelingHighlight(railProjects, railGlide, ['.side__rail-project[data-pending]', '.side__rail-project.is-open']);
  const searchKeys = mac ? 'Meta+K' : 'Control+K';
  useEffect(() => {
    // "C" opens New from anywhere outside a field or dialog (F-026 §4 keyboard); the drawer has its own.
    if (onClose) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'c' || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [role="combobox"], [role="listbox"], [contenteditable="true"], [role="dialog"]')) return;
      event.preventDefault();
      openCreate(projectId ? { projectId } : {});
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, openCreate, projectId]);
  const onNew = () => openCreate(projectId ? { projectId } : {});

  if (collapsed && !onClose) {
    return (
      <div className="side side--rail">
        {/* The toggle is in the top row, where the expanded sidebar's collapse control is (S1, Spokój anchors). */}
        <IconButton icon="sidebar" label="Expand sidebar" aria-keyshortcuts="[" className="side__toggle" onClick={onToggleCollapsed} />
        <NewMenu compact onNew={onNew} />
        {/* Places and the lists share one middle band: on a short window (a phone on its side) the whole band scrolls, so
            projects keep room; the toggle, New, Stop and the account stay put outside it, and their menus are not clipped (#727). */}
        <div className="side__rail-middle" ref={railMiddle}>
        <nav className="side__rail-places" aria-label="Places">
          <button type="button" className="side__ib" aria-label="Search" aria-keyshortcuts={searchKeys} onClick={openSearch}><Icon name="search" size={18} /></button>
          <Link to="/" className="side__ib" aria-label="Home" aria-current={home ? 'page' : undefined}><Icon name="home" size={18} /></Link>
          <Link to="/inbox" className="side__ib" aria-label={inboxUnread ? `Inbox, ${inboxUnread} new` : 'Inbox'} aria-current={inbox ? 'page' : undefined}>
            <Icon name="inbox" size={18} />{inboxUnread ? <span className="side__count side__count--rail" aria-hidden="true">{inboxUnread}</span> : null}
          </Link>
          <Link to="/tasks" className="side__ib" aria-label="My tasks" aria-current={myTasks ? 'page' : undefined}><Icon name="tasks" size={18} /></Link>
          <Link to="/map" className="side__ib" aria-label="My map" title="Only you can see your map" aria-current={sketchbook ? 'page' : undefined}><Icon name="map" size={18} /></Link>
        </nav>
        <div className="side__rail-scroll">
        <nav className="side__rail-projects" aria-label="Spaces" ref={railProjects}>
          <span className="side__rail-glide" ref={railGlide} aria-hidden="true" />
          {projects.map((project) => (
            <NavLink key={project.id} to={`/projects/${project.id}`} end={false} className={`side__rail-project${project.id === projectId ? ' is-open' : ''}`} aria-label={`${project.name}${encrypted(project) ? ', encrypted' : ''}${muted.has(`project:${project.id}`) ? ', muted' : ''}`} title={`${project.name}${encrypted(project) ? ' · Encrypted' : ''}${muted.has(`project:${project.id}`) ? ' · Muted' : ''}`}
              onClick={(event) => { if (choosesInPlace(event)) glideRailTo(event.currentTarget); }}
              data-glide-id={project.id} data-pending={pendingProject === project.id && project.id !== projectId ? '' : undefined}>
              <ProjectTile name={project.name} size={28} />
            </NavLink>
          ))}
          {locked.map((space) => (
            <NavLink key={space.id} to={`/spaces/${space.id}`} end={false} className="side__rail-project side__rail-locked" aria-label={`${space.name}, ${lockedLine(space).toLowerCase()}`} title={`${space.name} · ${lockedLine(space)}`}>
              <LockTile size={28} />
            </NavLink>
          ))}
        </nav>
        <nav className="side__rail-dms" aria-label="Private conversations">
          <Link to="/dm" className="side__ib" aria-label="Messages" aria-current={location.pathname === '/dm' ? 'page' : undefined}><Icon name="chat" size={18} /></Link>
          {agents.map((agent) => <RailAgent key={agent.id} agent={agent} />)}
          {directMessages.map((dm) => (
            <NavLink key={dm.id} to={`/dm/${dm.id}`} end={false} className="side__rail-dm"
              aria-label={`${dm.title}${muted.has(`dm:${dm.id}`) ? ', muted' : ''}${dm.hasNew && !muted.has(`dm:${dm.id}`) ? ', new messages' : ''}`} title={`${dm.title}${muted.has(`dm:${dm.id}`) ? ' · Muted' : ''}`}>
              <Avatar name={dm.kind === 'group' ? dm.title : dm.people[0] ?? dm.title} size="lg" />
              {dm.hasNew && !muted.has(`dm:${dm.id}`) ? <span className="side__dot" aria-hidden="true" /> : null}
            </NavLink>
          ))}
        </nav>
        </div>
        </div>
        <WorkingAgent compact />
        <UserMenu compact name={user.name} email={user.email} />
      </div>
    );
  }

  return (
    <div className="side">
      <div className="side__brand">
        {/* The wordmark names the drawer; Home is the first place below, so the mark is not a second link. */}
        <span className="side__logo">
          <span className="side__glyph" role="img" aria-label="Flux" id={titleId}><FluxLogo size={24} /></span>
          <span className="side__word" aria-hidden="true">flux</span>
        </span>
        {onClose ? <IconButton icon="x" label="Close navigation" onClick={onClose} />
          : <IconButton icon="sidebar" label="Collapse sidebar" aria-keyshortcuts="[" className="side__toggle" onClick={onToggleCollapsed} />}
      </div>
      <div className="side__actions">
        <NewMenu onNew={onNew} />
        <button type="button" className="side__search" aria-label="Search" aria-keyshortcuts={searchKeys} title={mac ? 'Search (⌘K)' : 'Search (Ctrl K)'} onClick={() => { onClose?.(); openSearch(); }}>
          <Icon name="search" size={16} />
        </button>
      </div>
      <div className="side__scroll">
        <nav className="side__places" aria-label="Places">
          {/* Plain links with an explicit current place: NavLink would also mark a parent path current. */}
          <Link to="/" className="side__item" aria-current={home ? 'page' : undefined} onClick={navigate}>
            <Icon name="home" className="side__ic" /><span className="side__label">Home</span>
          </Link>
          <Link to="/inbox" className="side__item" aria-label={inboxUnread ? `Inbox, ${inboxUnread} new` : 'Inbox'} aria-current={inbox ? 'page' : undefined} onClick={navigate}>
            <Icon name="inbox" className="side__ic" /><span className="side__label">Inbox</span>
            {inboxUnread ? <span className="side__count" aria-hidden="true">{inboxUnread}</span> : null}
          </Link>
          <Link to="/tasks" className="side__item" aria-current={myTasks ? 'page' : undefined} onClick={navigate}>
            <Icon name="tasks" className="side__ic" /><span className="side__label">My tasks</span>
          </Link>
          <Link to="/map" className="side__item" aria-current={sketchbook ? 'page' : undefined} onClick={navigate} title="Only you can see your map">
            <Icon name="map" className="side__ic" /><span className="side__label">My map</span>
          </Link>
        </nav>

        {/* An empty section is not shown (Spokój rule 4, #763 FR-4); the narrow drawer keeps its heading for its "+". A space
            waiting to be unlocked is a row of it (F-030). */}
        {projects.length || locked.length || onClose ? <nav className="side__sec" aria-labelledby="side-projects">
          <div className="side__head">
            <h2 className="side__h" id="side-projects">Spaces</h2>
            {/* On the computer New (C) creates; the narrow-tablet drawer keeps its own "+". */}
            {onClose ? <button type="button" className="side__add" aria-label="New space" onClick={() => { onClose(); openCreate({ kind: 'space' }); }}><Icon name="plus" size={14} /></button> : null}
          </div>
          {projects.length || locked.length ? (
            <ul className="side__list" ref={projectList}>
              <li className="side__glide" ref={glide} aria-hidden="true" role="none" />
              {projects.map((project) => {
                const open = project.id === projectId;
                const quiet = muted.has(`project:${project.id}`);
                const fresh = news.get(project.id) ?? 0;
                return (
                  <li key={project.id}>
                    <NavLink to={`/projects/${project.id}`} end={false} className={`side__item side__project${open ? ' is-open' : ''}`} onClick={(event) => { if (choosesInPlace(event)) glideTo(event.currentTarget); navigate?.(); }}
                      data-glide-id={project.id} data-pending={pendingProject === project.id && !open ? '' : undefined}
                      title={project.name}
                      aria-label={fresh || quiet || encrypted(project) ? `${project.name}${encrypted(project) ? ', encrypted' : ''}${quiet ? ', muted' : ''}${fresh ? (quiet ? `, ${fresh} new` : ', new activity') : ''}` : undefined}
                      data-encrypted={encrypted(project) ? '' : undefined}>
                      <ProjectTile name={project.name} />
                      <span className="side__label">{project.name}</span>
                      {encrypted(project) ? <Icon name="lock" size={12} className="side__lock" /> : null}
                      {quiet ? <Icon name="quiet" size={12} className="side__muted" data-muted-mark="" /> : null}
                      {fresh ? (quiet ? <span className="side__quiet" aria-hidden="true">{fresh}</span> : <span className="side__dot" aria-hidden="true" />) : null}
                    </NavLink>
                  </li>
                );
              })}
              {locked.map((space) => (
                <li key={space.id}>
                  <NavLink to={`/spaces/${space.id}`} end={false} className="side__item side__locked" onClick={navigate} title={`${space.name} · ${lockedLine(space)}`} data-locked-space={space.id}>
                    <LockTile />
                    <span className="side__names">
                      <span className="side__label">{space.name}</span>
                      <span className="side__sub">{lockedLine(space)}</span>
                    </span>
                  </NavLink>
                </li>
              ))}
            </ul>
          ) : (
            <p className="side__empty">No spaces yet. Use + to start one, or it appears here when someone adds you to one.</p>
          )}
        </nav> : null}

        <nav className="side__sec" aria-labelledby="side-dms">
          <div className="side__head">
            <h2 className="side__h" id="side-dms"><Link to="/dm" className="side__h-link" aria-current={location.pathname === '/dm' ? 'page' : undefined} onClick={navigate}>Messages</Link></h2>
            {onClose ? <Link to="/dm/new" className="side__add" aria-label="New message" onClick={navigate}><Icon name="plus" size={14} /></Link> : null}
          </div>
          {directMessages.length || agents.length ? (
            <ul className="side__list">
              {agents.map((agent, index) => <ListAgent key={agent.id} agent={agent} pinned={index === 0} onNavigate={navigate} />)}
              {directMessages.map((dm) => (
                <li key={dm.id}>
                  <NavLink to={`/dm/${dm.id}`} end={false} className="side__item side__dm" onClick={navigate} title={dm.title}
                    aria-label={muted.has(`dm:${dm.id}`) ? `${dm.title}, muted` : undefined}>
                    <Avatar name={dm.kind === 'group' ? dm.title : dm.people[0] ?? dm.title} size="sm" /><span className="side__label">{dm.title}</span>
                    {muted.has(`dm:${dm.id}`) ? <Icon name="quiet" size={12} className="side__muted" data-muted-mark="" />
                      : dm.hasNew ? <span className="side__dot"><span className="ui-vh">, new messages</span></span> : null}
                  </NavLink>
                </li>
              ))}
            </ul>
          ) : null /* Its heading leads to Messages; an empty list says nothing (#763 FR-4). */}
        </nav>
      </div>
      <WorkingAgent />
      <UserMenu name={user.name} email={user.email} asLink={!!onClose} onNavigate={onClose} />
    </div>
  );
}

/** An agent in the collapsed rail: a dot while its chat has something unread (its answers and the reports of its work, #919). */
function RailAgent({ agent }: { agent: MyAgent }) {
  const unread = useAgentUnread(agent.id);
  return (
    <NavLink to={`/agents/${agent.id}`} end={false} className="side__rail-dm side__rail-agent" aria-label={unread ? `${agent.name}, your agent, new messages` : `${agent.name}, your agent`} title={`${agent.name} · Your agent`}>
      <Kreska size={28} hue={agent.colour} />
      {unread ? <span className="side__dot" aria-hidden="true" /> : null}
    </NavLink>
  );
}

/** An agent in Messages, with a dot while its chat has something unread. */
function ListAgent({ agent, pinned, onNavigate }: { agent: MyAgent; pinned: boolean; onNavigate?: () => void }) {
  const unread = useAgentUnread(agent.id);
  return (
    <li>
      <NavLink to={`/agents/${agent.id}`} end={false} className="side__item side__dm side__agent" onClick={onNavigate} title={`${agent.name} · Your agent`} data-agent={agent.id}>
        <Kreska size={20} hue={agent.colour} /><span className="side__label">{agent.name}</span>
        {pinned ? <Icon name="pin" size={12} className="side__pin" aria-label="Pinned" /> : null}
        {unread ? <span className="side__dot"><span className="ui-vh">, new messages</span></span> : null}
      </NavLink>
    </li>
  );
}
