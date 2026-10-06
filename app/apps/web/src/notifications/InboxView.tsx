import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { InboxItem, NotificationReason } from '@flux/contracts';
import { AgentOrb, AiBadge, Avatar, Button, EmptyState, ErrorState, Icon, IconButton, MEDIA, Spinner, useMediaQuery, useToast, type IconName } from '../ui';
import { announceInboxChange, getInbox, getInboxItem, markAllInboxRead, markInboxRead } from './api';
import './notifications.css';

/** Why an item is here, in words, with a quiet icon (#116: every notification has a reason). */
export const REASONS: Record<NotificationReason, { label: string; icon: IconName }> = {
  mention: { label: 'Mentioned you', icon: 'people' },
  question: { label: 'Asked you', icon: 'chat' },
  reply: { label: 'Reply', icon: 'chat' },
  dm: { label: 'Direct message', icon: 'mail' },
  assigned: { label: 'Assigned to you', icon: 'tasks' },
  review: { label: 'For your review', icon: 'rule' },
  invitation: { label: 'Invited you', icon: 'people' },
};

const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const day = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

export function when(iso: string, now = new Date()) {
  const date = new Date(iso);
  const minutes = Math.round((now.getTime() - date.getTime()) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes} min`;
  if (date.toDateString() === now.toDateString()) return time.format(date);
  return day.format(date);
}

/**
 * One notification. On phones (F-025 PA-2) a row an agent caused leads with the agent's orb and names it with an
 * "AI" badge; a person's row leads with their neutral initials. Tablet and desktop keep the reason's icon.
 */
function Row({ item, onRead, phone }: { item: InboxItem; onRead: (id: string) => void; phone: boolean }) {
  const reason = item.reason ? REASONS[item.reason] : { label: 'Update', icon: 'bell' as IconName };
  const unread = !item.readAt;
  const actor = phone ? item.actor : null;
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0) return;
    if (unread) onRead(item.id);
  };
  const meta = <>{reason.label}<span aria-hidden="true"> · </span><time dateTime={item.createdAt}>{when(item.createdAt)}</time></>;
  return (
    <li className={`inbox__row${unread ? ' is-unread' : ''}`} data-actor={actor?.kind}>
      <Link to={item.url ?? `/inbox/${item.id}`} className="inbox__item" onClick={open}>
        {actor?.kind === 'agent' ? <span className="inbox__face"><AgentOrb agentId={actor.id} size="lg" /></span>
          : actor ? <span className="inbox__face"><Avatar name={actor.name} size="lg" /></span>
            : <span className={`inbox__ic inbox__ic--${item.reason ?? 'other'}`} aria-hidden="true"><Icon name={reason.icon} size={14} /></span>}
        <span className="inbox__text">
          {actor ? <span className="inbox__who"><b>{actor.name}</b>{actor.kind === 'agent' ? <AiBadge /> : null}<span className="inbox__meta"><span aria-hidden="true"> · </span>{meta}</span></span> : null}
          <span className="inbox__title">{item.title}</span>
          {item.body ? <span className="inbox__body">{item.body}</span> : null}
          {actor ? null : <span className="inbox__meta">{meta}</span>}
        </span>
        {unread ? <span className="inbox__dot"><span className="ui-vh">, unread</span></span> : null}
      </Link>
      {unread ? <IconButton icon="check" label="Mark as read" className="inbox__read" onClick={() => onRead(item.id)} /> : null}
    </li>
  );
}

/**
 * The inbox (#116): what involves you, newest first, each with why it matters and a link to
 * the exact source. Opening an item marks it read. Nothing has to be cleared; there is no count.
 */
export function InboxView() {
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const toast = useToast();
  const phone = useMediaQuery(MEDIA.phone);
  const fetchInbox = useCallback((signal?: AbortSignal) => {
    getInbox(signal).then((inbox) => { setFailed(false); setItems(inbox.items); }, (error: unknown) => {
      if (!(error instanceof DOMException && error.name === 'AbortError')) setFailed(true);
    });
  }, []);
  const load = () => { setFailed(false); fetchInbox(); };
  useEffect(() => {
    const controller = new AbortController();
    fetchInbox(controller.signal);
    const onFocus = () => fetchInbox();
    window.addEventListener('focus', onFocus);
    return () => { controller.abort(); window.removeEventListener('focus', onFocus); };
  }, [fetchInbox]);

  const read = (id: string) => {
    const at = new Date().toISOString();
    setItems((list) => list?.map((item) => (item.id === id ? { ...item, readAt: item.readAt ?? at } : item)) ?? null);
    void markInboxRead(id).then(announceInboxChange, () => undefined);
  };
  const readAll = () => {
    const at = new Date().toISOString();
    setItems((list) => list?.map((item) => ({ ...item, readAt: item.readAt ?? at })) ?? null);
    void markAllInboxRead().then(announceInboxChange, () => toast({ message: 'Could not mark everything read. Try again.', tone: 'danger' }));
  };

  const fresh = items?.filter((item) => !item.readAt) ?? [];
  const earlier = items?.filter((item) => item.readAt) ?? [];
  return (
    <div className="pane-scroll"><div className="pane-in inbox">
      <div className="inbox__head">
        <div>
          <p>Mentions, questions, replies, direct messages, and work or reviews for you. Nothing here needs clearing.</p>
        </div>
        <div className="inbox__tools">
          {fresh.length ? <Button variant="quiet" icon="check" onClick={readAll}>Mark all read</Button> : null}
          <Link className="ui-btn ui-btn--secondary" to="/settings/notifications"><Icon name="bell" size={14} />Settings</Link>
        </div>
      </div>
      {failed ? (
        <ErrorState title="The inbox could not load" actions={<Button onClick={() => load()}>Retry</Button>}>
          <p>Check your connection. Nothing was lost.</p>
        </ErrorState>
      ) : items === null ? (
        <p className="inbox__loading"><Spinner label="Loading the inbox" /></p>
      ) : !items.length ? (
        <div className="view-empty">
          <EmptyState icon="inbox" title="Nothing for you yet" action={<Link className="ui-btn ui-btn--secondary" to="/settings/notifications">Choose what reaches you</Link>}>
            <p>When someone mentions you, asks you something, replies in your conversation, writes to you directly or hands you work, it appears here.</p>
          </EmptyState>
        </div>
      ) : (
        <>
          {fresh.length ? (
            <section aria-labelledby="inbox-new">
              <h3 className="inbox__h" id="inbox-new">New</h3>
              <ul className="inbox__list">{fresh.map((item) => <Row key={item.id} item={item} onRead={read} phone={phone} />)}</ul>
            </section>
          ) : null}
          {earlier.length ? (
            <section aria-labelledby="inbox-earlier">
              {fresh.length ? null : <p className="inbox__caught">All caught up. Everything below stays here as long as you can open it.</p>}
              <h3 className="inbox__h" id="inbox-earlier">Earlier</h3>
              <ul className="inbox__list">{earlier.map((item) => <Row key={item.id} item={item} onRead={read} phone={phone} />)}</ul>
            </section>
          ) : null}
        </>
      )}
    </div></div>
  );
}

/**
 * `/inbox/:id`, the link in notification email and the service worker's fallback: asks the
 * server (which rechecks access), marks it read and opens the exact source. An item the person
 * can no longer read answers like one that never existed.
 */
export function InboxOpen() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [gone, setGone] = useState(false);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    getInboxItem(id).then((item) => {
      void markInboxRead(item.id).then(announceInboxChange, () => undefined);
      navigate(item.url ?? '/inbox', { replace: true });
    }, () => setGone(true));
  }, [id, navigate]);
  return (
    <div className="pane-scroll"><div className="pane-in">
      {gone ? (
        <div className="inbox-gone">
          <Icon name="lock" size={16} />
          <div>
            <h2>This is not available to you</h2>
            <p>It may have been removed, or you no longer have access to where it happened.</p>
            <Link className="ui-btn ui-btn--secondary" to="/inbox">Go to your inbox</Link>
          </div>
        </div>
      ) : <p className="inbox__loading"><Spinner label="Opening" /></p>}
    </div></div>
  );
}
