import { useMemo, useRef } from 'react';
import { Link } from 'react-router';
import { useProjectNews } from './projectNews';
import { previewLine, useSpacePreviews } from './spacePreviews';
import { lastSaid } from './timeFormat';
import { Button, EmptyState, Icon, MEDIA, useMediaQuery } from '../ui';
import { useKeyboardMove, useReorder } from '../ui/reorder';
import { MoreMenu, type MoreItem } from './HeaderParts';
import { useNeedsYouSpaces } from '../notifications/dot';
import { spaceRowLabel, useOrderedProjects, useSpaceMoves } from './spaceOrder';
import { useLiveSpaces } from '../live/spaces';
import { lockedLine, useEncryptedWorkspaceIds } from '../encryption/state';
import { usePlaceMutes } from '../notifications/mutes';
import { useShellData } from './data';
import { startsConversations, startsSpaces } from '../people/api';
import { useShellActions } from './shellContext';
import { SpaceFace } from '../ui/SpaceFace';
import { DmRows } from '../dm/DmIndex';
import './settings.css';

/**
 * Projects (#266 PF-1): the list the phone's Projects place opens, like a messenger's list of chats.
 * On the phone it also holds the direct messages (#341).
 * Each row opens the project on its conversation. A space with news is bold (not when muted: a quiet count then), and a dot says
 * something there needs the person (#1250). The order is the person's own and a row's ⋯ moves it (always shown on touch).
 */
export function ProjectsIndex() {
  const { me, directMessages, agents, lockedWorkspaces, removedFrom, workspace } = useShellData();
  const projects = useOrderedProjects();
  const { openCreate } = useShellActions();
  const ids = useMemo(() => projects.map((project) => project.id), [projects]);
  const news = useProjectNews(ids);
  // Each space's newest message and its time, as a conversation's row has them (round 15 look-2 P3-11).
  const previews = useSpacePreviews(ids);
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
    ...(at > moves.fixed ? [{ label: 'Move up', icon: 'chevron-up' as const, run: () => moveBy(id, -1) }] : []),
    ...(at < projects.length - 1 ? [{ label: 'Move down', icon: 'chevron-down' as const, run: () => moveBy(id, 1) }] : []),
  ];
  const phone = useMediaQuery(MEDIA.phone);
  // An encrypted space has a small lock after its name, as in the sidebar (F-026 §4).
  const encryptedIn = useEncryptedWorkspaceIds();
  // A call is on in the space (F-041): the call glyph after its name, as in the sidebar.
  const calls = useLiveSpaces();
  return (
    <div className="pane-scroll">
      <div className="pane-in set">
        {projects.length || lockedWorkspaces.length ? (
          <ul className="set-card proj-index__spaces" aria-label="Spaces" ref={list}>
            {projects.map((project, at) => {
              const encrypted = !!project.workspaceId && encryptedIn.has(project.workspaceId);
              const quiet = muted.has(`project:${project.id}`);
              const fresh = news.get(project.id) ?? 0;
              // Unread is bold; a muted space is never bold, its unread is the quiet count (#1249, #1250).
              const unread = fresh > 0 && !quiet;
              const label = spaceRowLabel(project.name, { encrypted, quiet, fresh, needsYou: needing.has(project.id), call: calls.has(project.id) });
              const preview = previews.get(project.id);
              const said = preview ? previewLine(preview, me.user.id) : '';
              const items = at < moves.fixed ? [] : moveItems(project.id, at);
              return (
              <li key={project.id} className="proj-index__row" data-space-id={project.id} data-everyone={at < moves.fixed ? '' : undefined}>
                <Link to={`/projects/${project.id}`} className={`set-row${unread ? ' is-unread' : ''}`} aria-label={said ? `${label ?? project.name}. ${said}` : label} data-encrypted={encrypted ? '' : undefined} draggable={false}>
                  {/* The same tile as the sidebar and Home (#763 NV-6; its icon, F-040); a sparkle would read as AI. */}
                  <span className="set-row__ic proj-index__tile" aria-hidden="true"><SpaceFace name={project.name} icon={project.icon} size={32} /></span>
                  <span className="set-row__b">
                    <span className="set-row__t">{project.name}{encrypted ? <Icon name="lock" size={12} className="proj-index__lock" /> : null}{calls.has(project.id) ? <Icon name="call" size={12} className="proj-index__live" data-call-mark="" /> : null}{quiet ? <Icon name="quiet" size={12} className="proj-index__lock" data-muted-mark="" /> : null}</span>
                    {said ? <span className="set-row__s proj-index__one">{said}</span> : null}
                  </span>
                  {fresh && quiet ? <span className="proj-index__quiet" aria-hidden="true">{fresh}</span> : needing.has(project.id) ? <span className="proj-index__dot" aria-hidden="true" /> : null}
                  {preview ? <time className="proj-index__time" dateTime={preview.at}>{lastSaid(preview.at)}</time> : null}
                  {/* No chevron: a row of this list ends in its dot and its ⋯, as a Messages row below ends in its time; a dot, a chevron and a
                      ⋯ in a row were three ends (round 14, look-b P20). */}
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
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          // The one empty state, centred like every other (README "One look for one element"), not a paragraph of its own.
          <div className="view-empty proj-index__empty">
            {removedFrom ? (
              <EmptyState icon="grid" title={`You’re no longer in ${removedFrom}`}><p>Ask an owner or admin of the company for an invite link to come back.</p></EmptyState>
            ) : (
              /* A guest does not start spaces (#1424): their line says only how one reaches them. */
              <EmptyState icon="grid" title="No spaces yet"
                action={startsSpaces(workspace) ? <Button variant="primary" onClick={() => openCreate({ kind: 'space' })}><Icon name="plus" />Create a space</Button> : undefined}>
                <p>{startsSpaces(workspace) ? 'Create one, or it appears here when someone adds you to theirs.' : 'A space appears here when someone adds you to it.'}</p>
              </EmptyState>
            )}
          </div>
        )}
        <span className="ui-vh" role="status" aria-live="polite">{moves.status}</span>
        {/* Direct messages live in Projects on the phone, below the spaces (F-026 S2). A guest with no conversation and no agent has no
            Messages heading over nothing, as in the sidebar (audit P3 5, persona round 6): the first one someone starts with them brings it. */}
        {phone && (directMessages.length || agents.length || (!!workspace && startsConversations(workspace))) ? (
          <section className="proj-index__dms" aria-labelledby="proj-index-dms">
            <h2 id="proj-index-dms">Messages</h2>
            {/* The same list as the Messages page (dm/DmIndex.tsx): the spaces' card and grid, with a fixed time column (#763 NV-5). */}
            {directMessages.length || agents.length ? (
              <DmRows />
            ) : <p className="proj-index__lead">No messages yet. Only the people in each conversation can read it.</p>}
            {/* A guest replies in conversations they are added to and starts none (#1424): no New message for them. */}
            {(!!workspace && startsConversations(workspace)) ? <Link to="/dm/new" className="ui-btn ui-btn--secondary"><Icon name="plus" />New message</Link> : null}
          </section>
        ) : null}
      </div>
    </div>
  );
}
