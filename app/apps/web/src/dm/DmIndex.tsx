import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { DM_LIMITS, type WorkspaceMember } from '@flux/contracts';
import { ApiError } from '../api/client';
import { openDm } from '../api/direct-messages';
import { listWorkspaceMembers } from '../app/conversation-api';
import { useShellData } from '../app/data';
import { Avatar, Button, EmptyState, Icon } from '../ui';
import { audienceOf } from './names';
import './dm.css';

/** Direct messages (#107): the list of conversations with people, outside any project. */
export function DmIndex() {
  const { directMessages } = useShellData();
  if (!directMessages.length) {
    return (
      <div className="pane-scroll"><div className="pane-in">
        <div className="view-empty">
          <EmptyState icon="chat" title="No direct messages yet" action={<Link className="ui-btn ui-btn--primary" to="/dm/new"><Icon name="plus" size={14} />New message</Link>}>
            <p>Talk with someone one to one, or with a few people, outside any project. Only the people in a conversation can see it, not workspace owners or admins.</p>
          </EmptyState>
        </div>
      </div></div>
    );
  }
  return (
    <div className="pane-scroll"><div className="pane-in">
      <div className="dm-index__head">
        <div><h2>Direct messages</h2><p>Only the people in each conversation can read it.</p></div>
        <Link className="ui-btn ui-btn--secondary" to="/dm/new"><Icon name="plus" size={14} />New message</Link>
      </div>
      <ul className="dm-index" aria-label="Conversations">
        {directMessages.map((dm) => (
          <li key={dm.id}>
            <Link to={`/dm/${dm.id}`} className="dm-index__item">
              <Avatar name={dm.kind === 'group' ? dm.title : dm.people[0] ?? dm.title} size="lg" />
              <span className="dm-index__text"><b>{dm.title}</b><span>{dm.preview ?? 'No messages yet'}</span></span>
              {dm.lastAt ? <time dateTime={dm.lastAt}>{new Date(dm.lastAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time> : null}
            </Link>
          </li>
        ))}
      </ul>
    </div></div>
  );
}

/**
 * Start a conversation: pick one person (their 1:1 DM opens, created once) or a few (a new group).
 * `?workspace=<id>&with=<userId>` opens the 1:1 DM with that person directly, e.g. from a name.
 */
export function NewDm() {
  const { me, workspaces } = useShellData();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const direct = params.get('with');
  const [workspaceId, setWorkspaceId] = useState(params.get('workspace') ?? (workspaces.length === 1 ? workspaces[0]!.id : ''));
  const [loaded, setLoaded] = useState<{ workspaceId: string; list: WorkspaceMember[]; note: string } | null>(null);
  const members = loaded?.workspaceId === workspaceId ? loaded.list : null;
  const membersNote = loaded?.workspaceId === workspaceId ? loaded.note : '';
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>(direct ? [direct] : []);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** The other person left the 1:1 (or the workspace): a calm explanation instead of a thread. */
  const [notice, setNotice] = useState('');
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  const autoOpened = useRef(false);

  useEffect(() => {
    if (!workspaceId) return;
    const controller = new AbortController();
    listWorkspaceMembers(workspaceId, controller.signal)
      .then((list) => setLoaded({ workspaceId, list: list.filter((member) => member.userId !== me.user.id), note: '' }))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setLoaded({ workspaceId, list: [], note: cause instanceof ApiError && cause.status === 403
          ? 'Guests can reply in conversations they are added to, but cannot start one.'
          : 'Could not load people. Try again.' });
      });
    return () => controller.abort();
  }, [workspaceId, me.user.id]);

  async function start(ids = selected) {
    if (!workspaceId || !ids.length || busy) return;
    const name = ids.length > 1 ? title.trim() : '';
    const signature = JSON.stringify([workspaceId, [...ids].sort(), name]);
    // The same attempt reuses its Idempotency-Key, so a retry after a lost response opens one group.
    if (attempt.current?.signature !== signature) attempt.current = { signature, key: crypto.randomUUID() };
    setBusy(true); setError(''); setNotice('');
    try {
      const dm = await openDm(workspaceId, ids, attempt.current.key, name || undefined);
      navigate(`/dm/${dm.id}`, { replace: Boolean(direct) });
    } catch (cause) {
      if (cause instanceof ApiError && (cause.code === 'DM_RECIPIENT_LEFT' || cause.code === 'DM_RECIPIENT_UNAVAILABLE')) {
        setNotice(cause.message); setBusy(false); return;
      }
      setError(cause instanceof ApiError && cause.code === 'DM_PARTICIPANT_UNAVAILABLE'
        ? 'Someone you chose is no longer in this workspace.'
        : cause instanceof ApiError && cause.status === 403 ? 'You can’t start conversations in this workspace.' : 'Could not open the conversation. Try again.');
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!direct || !workspaceId || autoOpened.current) return;
    autoOpened.current = true;
    void start([direct]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [direct, workspaceId]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (members ?? []).filter((member) => !needle || member.name.toLowerCase().includes(needle) || member.email.toLowerCase().includes(needle));
  }, [members, query]);
  const nameOf = (id: string) => members?.find((member) => member.userId === id)?.name ?? '';
  const toggle = (id: string) => {
    setError(''); setNotice('');
    setSelected((current) => current.includes(id) ? current.filter((item) => item !== id)
      : current.length >= DM_LIMITS.others ? current : [...current, id]);
  };
  const only = selected.length === 1 ? nameOf(selected[0]!) : '';
  const audience = selected.length ? audienceOf(selected.map(nameOf)) : 'Choose who can read it';

  if (notice) {
    return (
      <div className="pane-scroll"><div className="pane-in dm-gone" role="status">
        <Icon name="lock" size={16} />
        <div><h2>No one to message here</h2><p>{notice}</p>
          <Link className="ui-btn ui-btn--secondary" to="/dm">Back to direct messages</Link></div>
      </div></div>
    );
  }
  if (direct && !error) {
    return <div className="pane-scroll"><div className="pane-in"><p className="dm-new__opening" role="status">Opening your conversation…</p></div></div>;
  }
  return (
    <div className="pane-scroll"><div className="pane-in dm-new">
      <h2>New message</h2>
      <p className="dm-new__lead">Pick one person for a one-to-one conversation, or a few for a small group. It stays outside every project.</p>
      {workspaces.length > 1 ? (
        <label className="dm-new__space">People in <select value={workspaceId} onChange={(event) => { setWorkspaceId(event.target.value); setSelected([]); }}>
          <option value="">Choose a space</option>{workspaces.map((space) => <option key={space.id} value={space.id}>{space.name}</option>)}
        </select></label>
      ) : null}
      {!workspaces.length ? <p className="dm-new__note">Join or create a space first; direct messages are with people in the same space.</p> : null}
      {workspaceId ? (
        <>
          <label className="ui-vh" htmlFor="dm-people-search">Find people</label>
          <input id="dm-people-search" className="dm-new__search" type="search" placeholder="Find people by name or email" value={query} onChange={(event) => setQuery(event.target.value)} autoComplete="off" />
          {members === null ? <p className="dm-new__note" role="status">Loading people…</p> : null}
          {membersNote ? <p className="dm-new__note">{membersNote}</p> : null}
          {members && !members.length && !membersNote ? <p className="dm-new__note">Nobody else is in this space yet.</p> : null}
          <ul className="dm-new__people" aria-label="People">
            {shown.map((member) => {
              const checked = selected.includes(member.userId);
              return (
                <li key={member.userId}>
                  <label className={`dm-new__person${checked ? ' is-on' : ''}`}>
                    <input type="checkbox" checked={checked} onChange={() => toggle(member.userId)} />
                    <Avatar name={member.name} size="md" />
                    <span className="dm-new__name"><b>{member.name}</b><span>{member.email}{member.role === 'guest' ? ' · guest' : ''}</span></span>
                    {checked ? <Icon name="check" size={14} className="dm-new__tick" /> : null}
                  </label>
                </li>
              );
            })}
          </ul>
          {selected.length > 1 ? (
            <label className="dm-new__title">Group name (optional)<input type="text" maxLength={DM_LIMITS.title} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Lamp prototype" /></label>
          ) : null}
          <div className="dm-new__bar">
            <p className="dm-new__audience"><Icon name="lock" size={13} />{audience}</p>
            <Button variant="primary" busy={busy} disabled={!selected.length} onClick={() => void start()}>
              {selected.length > 1 ? 'Start group' : only ? `Message ${only.split(/\s+/)[0]}` : 'Open conversation'}
            </Button>
          </div>
        </>
      ) : null}
      {error ? <p className="dm__error" role="alert"><Icon name="alert" size={13} />{error}</p> : null}
    </div></div>
  );
}
