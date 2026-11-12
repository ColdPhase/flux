import { useMemo, useRef } from 'react';
import { Link } from 'react-router';
import { useProjectNews } from './projectNews';
import { Avatar, Button, Icon, Kreska, MEDIA, useMediaQuery } from '../ui';
import { useKeyboardMove, useReorder } from '../ui/reorder';
import { MoreMenu, type MoreItem } from './HeaderParts';
import { useNeedsYouSpaces } from '../notifications/dot';
import { spaceRowLabel, useOrderedProjects, useSpaceMoves } from './spaceOrder';
import { useLiveSpaces } from '../live/spaces';
import { lockedLine, useEncryptedWorkspaceIds } from '../encryption/state';
import { usePlaceMutes } from '../notifications/mutes';
import { useShellData } from './data';
import { useShellActions } from './shellContext';
import { SpaceFace } from '../ui/SpaceFace';
import './settings.css';

/**
 * Projects (#266 PF-1): the list the phone's Projects place opens, like a messenger's list of chats.
 * On the phone it also holds the direct messages (#341).
 * Each row opens the project on its conversation. A space with news is bold (not when muted: a quiet count then), and a dot says
 * something there needs the person (#1250). The order is the person's own and a row's ⋯ moves it (always shown on touch).
 */
export function ProjectsIndex() {
  const { me, directMessages, agents, lockedWorkspaces } = useShellData();
  const projects = useOrderedProjects();
  const { openCreate } = useShellActions();
  const news = useProjectNews(useMemo(() => projects.map((project) => project.id), [projects]));
  // A muted space has the small muted mark after its name and a quiet count where the others are bold (#1249).
  const { muted } = usePlaceMutes();
  // The dot is for what needs the person, whatever is unread (#1250).
  const needing = useNeedsYouSpaces(me.user.id);
  // The same order as the sidebar's, moved the same way (#1250): a long press then a drag on touch, a drag with a mouse, ⋯ for the keyboard.
  const list = useRef<HTMLUListElement>(null);
  const moves = useSpaceMoves(projects);
  const rows = 'li[data-space-id]';
  useReorder(list, { rows, idOf: (row) => row.dataset.spaceId ?? '', fixed: moves.fixed, onMove: moves.moveTo, enabled: projects.length - moves.fixed > 1 });
  const move = useKeyboardMove(list, rows);
  const moveBy = (id: string, step: -1 | 1) => move(() => { moves.moveTo(id, projects.findIndex((project) => project.id === id) + step); }, `[data-space-id="${CSS.escape(id)}"] .proj-index__more`);
  const moveItems = (id: string, at: number): MoreItem[] => [
    ...(at > moves.fixed ? [{ label: 'Move up', run: () => moveBy(id, -1) }] : []),
    ...(at < projects.length - 1 ? [{ label: 'Move down', run: () => moveBy(id, 1) }] : []),
  ];
  const phone = useMediaQuery(MEDIA.phone);
  // An encrypted space has a small lock after its name, as in the sidebar (F-026 §4).
  const encryptedIn = useEncryptedWorkspaceIds();
  // A call is on in the space (F-041): the call glyph after its name, as in the sidebar.
  const calls = useLiveSpaces();
  return (
    <div className="pane-scroll">
      <div className="pane-in set">
        <div className="proj-index__head">
          <p className="proj-index__lead">Each space has one conversation, tasks, a map and a wiki.</p>
          <Button variant="secondary" onClick={() => openCreate({ kind: 'space' })}><Icon name="plus" />New space</Button>
        </div>
        {projects.length || lockedWorkspaces.length ? (
          <ul className="set-card proj-index__spaces" aria-label="Spaces" ref={list}>
            {projects.map((project, at) => {
              const encrypted = !!project.workspaceId && encryptedIn.has(project.workspaceId);
              const quiet = muted.has(`project:${project.id}`);
              const fresh = news.get(project.id) ?? 0;
              // Unread is bold; a muted space is never bold, its unread is the quiet count (#1249, #1250).
              const unread = fresh > 0 && !quiet;
              const label = spaceRowLabel(project.name, { encrypted, quiet, fresh, needsYou: needing.has(project.id), call: calls.has(project.id) });
              const items = at < moves.fixed ? [] : moveItems(project.id, at);
              return (
              <li key={project.id} className="proj-index__row" data-space-id={project.id} data-everyone={at < moves.fixed ? '' : undefined}>
                <Link to={`/projects/${project.id}`} className={`set-row${unread ? ' is-unread' : ''}`} aria-label={label} data-encrypted={encrypted ? '' : undefined} draggable={false}>
                  {/* The same tile as the sidebar and Home (#763 NV-6; its icon, F-040); a sparkle would read as AI. */}
                  <span className="set-row__ic proj-index__tile" aria-hidden="true"><SpaceFace name={project.name} icon={project.icon} size={32} /></span>
                  <span className="set-row__b">
                    <span className="set-row__t">{project.name}{encrypted ? <Icon name="lock" size={12} className="proj-index__lock" /> : null}{calls.has(project.id) ? <Icon name="call" size={12} className="proj-index__live" data-call-mark="" /> : null}{quiet ? <Icon name="quiet" size={12} className="proj-index__lock" data-muted-mark="" /> : null}</span>
                  </span>
                  {fresh && quiet ? <span className="proj-index__quiet" aria-hidden="true">{fresh}</span> : needing.has(project.id) ? <span className="proj-index__dot" aria-hidden="true" /> : null}
                  <Icon name="chevron-right" size={14} className="set-row__go" />
                </Link>
                {items.length ? <MoreMenu label={`More for ${project.name}`} size={14} className="proj-index__more" items={items} /> : null}
              </li>
              );
            })}
            {/* An encrypted space that waits to be unlocked is one row in place of its spaces (F-030, #655). */}
            {lockedWorkspaces.map((space) => (
              <li key={space.id}>
                <Link to={`/spaces/${space.id}`} className="set-row" data-locked-space={space.id}>
                  <span className="set-row__ic" aria-hidden="true"><Icon name="lock" size={16} /></span>
                  <span className="set-row__b">
                    <span className="set-row__t">{space.name}</span>
                    <span className="set-row__s">{lockedLine(space)}</span>
                  </span>
                  <Icon name="chevron-right" size={14} className="set-row__go" />
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <div className="proj-index__empty">
            <p>No spaces yet. Create one, or it appears here when someone adds you to theirs.</p>
            <Button variant="primary" onClick={() => openCreate({ kind: 'space' })}><Icon name="plus" />Create a space</Button>
          </div>
        )}
        <span className="ui-vh" role="status" aria-live="polite">{moves.status}</span>
        {/* Direct messages live in Projects on the phone, below the spaces (F-026 S2). */}
        {phone ? (
          <section className="proj-index__dms" aria-labelledby="proj-index-dms">
            <h2 id="proj-index-dms">Direct messages</h2>
            {/* The same card and grid as the spaces, with a fixed time column, so a long preview never pushes the date out (#763 NV-5). */}
            {directMessages.length || agents.length ? (
              <ul className="set-card proj-index__dmlist" aria-label="Conversations">
                {agents.map((agent, index) => (
                  <li key={agent.id}>
                    <Link to={`/agents/${agent.id}`} className="set-row" data-agent={agent.id}>
                      <Kreska size={36} hue={agent.colour} />
                      <span className="set-row__b">
                        <span className="set-row__t proj-index__one">{agent.name}</span>
                        <span className="set-row__s proj-index__one">{index === 0 ? 'Your agent · answers /ai' : 'Your agent'}</span>
                      </span>
                    </Link>
                  </li>
                ))}
                {directMessages.map((dm) => (
                  <li key={dm.id}>
                    <Link to={`/dm/${dm.id}`} className="set-row" aria-label={muted.has(`dm:${dm.id}`) ? `${dm.title}, muted` : undefined}>
                      <Avatar name={dm.kind === 'group' ? dm.title : dm.people[0] ?? dm.title} id={dm.kind === 'pair' ? dm.peopleIds[0] : null} size="lg" />
                      <span className="set-row__b">
                        <span className="set-row__t proj-index__one">{dm.title}</span>
                        <span className="set-row__s proj-index__one">{dm.preview ?? 'No messages yet'}</span>
                      </span>
                      {muted.has(`dm:${dm.id}`) ? <Icon name="quiet" size={12} className="proj-index__muted" data-muted-mark="" /> : null}
                      {dm.lastAt ? <time className="proj-index__time" dateTime={dm.lastAt}>{new Date(dm.lastAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time> : null}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : <p className="proj-index__lead">No conversations yet. Only the people in each one can read it.</p>}
            <Link to="/dm/new" className="ui-btn ui-btn--secondary"><Icon name="plus" />New message</Link>
          </section>
        ) : null}
      </div>
    </div>
  );
}
