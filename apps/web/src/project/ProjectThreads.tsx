import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router';
import type { ConversationSummary } from '@flux/contracts';
import { Button, Icon } from '../ui';
import { listConversations } from '../app/conversation-api';

const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const day = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
function when(iso: string) {
  const date = new Date(iso);
  return new Date().toDateString() === date.toDateString() ? time.format(date) : day.format(date);
}

/**
 * The open project's conversations in the sidebar (#117, direction C): the place's contents
 * sit beside the rail, so the centre keeps one reading column. Newest first; the rest load on
 * request. The list refreshes when the person returns to the page or opens another thread.
 */
export function ProjectThreads({ projectId, onNavigate }: { projectId: string; onNavigate?: () => void }) {
  const location = useLocation();
  const [items, setItems] = useState<ConversationSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const apply = useCallback((page: { items: ConversationSummary[]; total: number }) => {
    setItems((current) => [...page.items, ...current.filter((item) => !page.items.some((latest) => latest.id === item.id))]);
    setTotal(page.total);
    setLoaded((current) => Math.max(current, page.items.length));
    setFailed(false);
  }, []);
  const refresh = useCallback(() => {
    listConversations(projectId).then(apply, () => setFailed(true));
  }, [apply, projectId]);

  // The sidebar is keyed by project, so a new project starts from an empty list.
  useEffect(() => {
    const controller = new AbortController();
    listConversations(projectId, controller.signal).then(apply, (error: unknown) => {
      if (!(error instanceof DOMException && error.name === 'AbortError')) setFailed(true);
    });
    return () => controller.abort();
  }, [apply, projectId, location.pathname]);
  useEffect(() => {
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refresh]);

  async function more() {
    if (busy || loaded >= total) return;
    setBusy(true);
    try {
      const page = await listConversations(projectId, undefined, loaded);
      setItems((current) => [...current, ...page.items.filter((item) => !current.some((existing) => existing.id === item.id))]);
      setLoaded((current) => current + page.items.length);
      setTotal(page.total);
    } catch { setFailed(true); }
    finally { setBusy(false); }
  }

  const base = `/projects/${projectId}`;
  const selected = location.pathname.match(/\/conversations\/([^/]+)/)?.[1]
    ?? (location.pathname === base && !new URLSearchParams(location.search).has('new') ? items[0]?.id : undefined);
  const starting = location.pathname === base && new URLSearchParams(location.search).has('new');
  return (
    <section className="side__sec" aria-labelledby="side-threads">
      <h2 className="side__h" id="side-threads">Conversations<span className="side__count">{total || null}</span></h2>
      <Link to={`${base}?new=1`} className={`side__item side__capture project-convo__thread${starting ? ' is-current' : ''}`} aria-current={starting ? 'page' : undefined} onClick={onNavigate}>
        <Icon name="plus" className="side__ic" />New conversation
      </Link>
      <ul className="side__list">
        {items.map((thread) => {
          const current = thread.id === selected;
          return (
            <li key={thread.id}>
              <Link to={`${base}/conversations/${thread.id}`} className={`side__item side__thread project-convo__thread${current ? ' is-current' : ''}`} aria-current={current ? 'page' : undefined} onClick={onNavigate} title={thread.firstMessageBody}>
                <Icon name="chat" className="side__ic" /><span className="side__label">{thread.firstMessageBody || 'Conversation'}</span><small className="side__when">{when(thread.lastMessageAt)}</small>
              </Link>
            </li>
          );
        })}
      </ul>
      {failed ? <p className="side__empty">Conversations couldn’t be loaded. <button type="button" className="ui-link" onClick={refresh}>Retry</button></p> : null}
      {loaded < total ? <Button variant="quiet" busy={busy} onClick={() => void more()}>Load more conversations</Button> : null}
    </section>
  );
}
