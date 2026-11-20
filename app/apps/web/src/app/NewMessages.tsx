import { useMemo, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Avatar } from '../ui';
import { SpaceFace } from '../ui/SpaceFace';
import { useDmUnread } from '../dm/dmUnread';
import { usePlaceMutes } from '../notifications/mutes';
import { useShellData } from './data';
import { useProjectMessages } from './projectNews';
import { lastSaid } from './timeFormat';

/**
 * Home's "New messages" (founder direction, Hubert, 2026-11-19, #1548; docs/design/final/README.md "Home"): the conversations that have something
 * new, newest first: every space and direct message of the person with a message from someone else they have not read, muted places left out. A
 * row opens the conversation, which opens at its first new message (S23); reading it takes the row away. It is no part of the Inbox.
 */
const SHOWN = 5;

interface Row { key: string; to: string; name: string; line: string; at: string; face: ReactNode }

/** The rows, newest first, and how many conversations have news (the rows are at most `SHOWN` of them). */
export function useNewMessages(): { rows: Row[]; total: number } {
  const { projects, directMessages } = useShellData();
  const { muted } = usePlaceMutes();
  const unread = useDmUnread();
  const news = useProjectMessages(useMemo(() => projects.map((project) => project.id), [projects]));
  return useMemo(() => {
    const all: Row[] = [
      ...projects.flatMap((project): Row[] => {
        const latest = news.get(project.id)?.latest;
        if (!latest || muted.has(`project:${project.id}`)) return [];
        return [{ key: `project:${project.id}`, to: `/projects/${project.id}`, name: project.name, line: latest.line, at: latest.at,
          face: <span className="home__tile" aria-hidden="true"><SpaceFace name={project.name} icon={project.icon} size={32} /></span> }];
      }),
      ...directMessages.flatMap((dm): Row[] => {
        if (!(unread.get(dm.id) ?? 0) || muted.has(`dm:${dm.id}`)) return [];
        return [{ key: `dm:${dm.id}`, to: `/dm/${dm.id}`, name: dm.title, line: dm.preview ?? '', at: dm.lastAt ?? '',
          face: <Avatar name={dm.kind === 'group' ? dm.title : dm.people[0] ?? dm.title} id={dm.kind === 'pair' ? dm.peopleIds[0] : null} size="lg" /> }];
      }),
    ].sort((a, b) => Date.parse(b.at || '0') - Date.parse(a.at || '0'));
    return { rows: all.slice(0, SHOWN), total: all.length };
  }, [projects, directMessages, news, muted, unread]);
}

/** The part under Waiting for you; nothing at all (no heading, no empty line) while no conversation has something new. */
export function NewMessages() {
  const { rows, total } = useNewMessages();
  if (!rows.length) return null;
  return (
    <section className="home__news" aria-labelledby="home-news" data-new-messages="">
      <div className="home__sech">
        <h3 id="home-news">New messages<span className="home__n">{total}</span></h3>
        {total > rows.length ? <Link className="ui-btn ui-btn--quiet ui-btn--sm" to="/projects">Show all</Link> : null}
      </div>
      <ul className="home__rows" aria-label="Conversations with something new">
        {rows.map((row) => (
          <li key={row.key}>
            <Link className="home__row home__row--chat" to={row.to} data-new-message={row.key}>
              <span className="nyc__face">{row.face}</span>
              <span className="home__row-b">
                <span className="home__row-t home__row-one">{row.name}<span className="ui-vh">, new messages</span></span>
                {row.line ? <span className="home__row-k home__row-one">{row.line}</span> : null}
              </span>
              <span className="home__row-end">
                {row.at ? <time dateTime={row.at}>{lastSaid(row.at)}</time> : null}
                <span className="home__dot" aria-hidden="true" />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
