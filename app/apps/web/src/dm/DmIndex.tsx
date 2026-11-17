import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { DM_LIMITS, type MyAgent, type WorkspaceMember } from '@flux/contracts';
import { ApiError } from '../api/client';
import { openDm } from '../api/direct-messages';
import { listWorkspaceMembers } from '../project/api';
import { useShellData } from '../app/data';
import { useAgentUnread } from '../my-agents/AgentChatDots';
import { useDmUnread } from './dmUnread';
import { usePlaceMutes } from '../notifications/mutes';
import { Avatar, Button, EmptyState, Icon, Kreska, MEDIA, useMediaQuery } from '../ui';
import { focusField, stopAwaitingField, waitForField } from '../ui/keys';
import { GUEST_NO_DMS, audienceOf } from './names';
import { startsConversations } from '../people/api';
import '../app/settings.css';
import './dm.css';
import { lastSaid } from '../app/timeFormat';

/**
 * The rows of conversations with people: one list for the Messages page and the phone's Spaces tab (#341), in the card and rows of the
 * Spaces list (visual review 2026-11-17: a flat list here, a card there, for the same conversations). A long preview never pushes the
 * time out (#763 NV-5).
 */
export function DmRows() {
  const { directMessages, agents } = useShellData();
  // Unread is bold, as a space's; a muted conversation is never bold, its unread is the quiet count (#1424 decision 10, #1249).
  const unread = useDmUnread();
  const { muted } = usePlaceMutes();
  return (
    <ul className="set-card proj-index__dmlist dm-index" aria-label="Conversations">
      {/* Your agents come first, Assistant at the top (F-036 AG-4). */}
      {agents.map((agent, index) => <AgentRow key={agent.id} agent={agent} first={index === 0} />)}
      {directMessages.map((dm) => {
        const quiet = muted.has(`dm:${dm.id}`);
        const fresh = unread.get(dm.id) ?? 0;
        return (
        <li key={dm.id}>
          <Link to={`/dm/${dm.id}`} className={`set-row dm-index__item${fresh && !quiet ? ' is-unread' : ''}`} aria-label={quiet ? `${dm.title}, muted` : fresh ? `${dm.title}, new messages` : undefined}>
            <Avatar name={dm.kind === 'group' ? dm.title : dm.people[0] ?? dm.title} id={dm.kind === 'pair' ? dm.peopleIds[0] : null} size="lg" />
            <span className="set-row__b dm-index__text"><b className="set-row__t proj-index__one">{dm.title}</b><span className="set-row__s proj-index__one">{dm.preview ?? 'No messages yet'}</span></span>
            {quiet ? <Icon name="quiet" size={12} className="proj-index__muted" data-muted-mark="" /> : null}
            {quiet && fresh ? <span className="proj-index__quiet" aria-hidden="true">{fresh}</span> : null}
            {dm.lastAt ? <time className="proj-index__time" dateTime={dm.lastAt}>{lastSaid(dm.lastAt)}</time> : null}
          </Link>
        </li>
        );
      })}
    </ul>
  );
}

/** One of your agents in the list; its name is bold while its chat has an answer or a report you have not read (#919, #1424 decision 10). */
function AgentRow({ agent, first }: { agent: MyAgent; first: boolean }) {
  const unread = useAgentUnread(agent.id);
  return (
    <li>
      <Link to={`/agents/${agent.id}`} className={`set-row dm-index__item${unread ? ' is-unread' : ''}`} data-agent={agent.id} aria-label={unread ? `${agent.name}, new messages` : undefined}>
        <Kreska size={36} hue={agent.colour} />
        <span className="set-row__b dm-index__text"><b className="set-row__t proj-index__one">{agent.name}</b><span className="set-row__s proj-index__one">{first ? 'Your agent · answers /ai' : 'Your agent'}</span></span>
      </Link>
    </li>
  );
}

/** Direct messages (#107): the list of conversations with people, outside any project. */
export function DmIndex() {
  const { directMessages, agents, workspace } = useShellData();
  // A guest replies in conversations they are added to and starts none (F-037): nothing here offers them New message (#1424).
  const starts = startsConversations(workspace);
  if (!directMessages.length && !agents.length) {
    return (
      <div className="pane-scroll"><div className="pane-in">
        <div className="view-empty">
          <EmptyState icon="chat" title="No messages yet" action={starts ? <Link className="ui-btn ui-btn--primary" to="/dm/new"><Icon name="plus" size={14} />New message</Link> : undefined}>
            <p>{starts ? 'Talk with someone one to one, or with a few people, outside any space. Only the people in a conversation can see it, not the company’s owners or admins.'
              : GUEST_NO_DMS}</p>
          </EmptyState>
        </div>
      </div></div>
    );
  }
  return (
    <div className="pane-scroll"><div className="pane-in set dm-index-page">
      {/* The Spaces list's layout: the card, then New message under it, as on the phone's Spaces tab (visual review 2026-11-17). */}
      <DmRows />
      <div className="dm-index__foot">
        {starts ? <Link className="ui-btn ui-btn--secondary" to="/dm/new"><Icon name="plus" size={14} />New message</Link> : null}
        <p className="proj-index__lead">Only the people in each conversation can read it.</p>
      </div>
    </div></div>
  );
}

/**
 * Start a conversation: pick one person (their 1:1 DM opens, created once) or a few (a new group).
 * `?workspace=<id>&with=<userId>` opens the 1:1 DM with that person directly, e.g. from a name.
 */
export function NewDm() {
  const { me, workspace } = useShellData();
  const guest = !startsConversations(workspace);
  const navigate = useNavigate();
  const arrivalState = useLocation().state as unknown;
  const [params] = useSearchParams();
  const direct = params.get('with');
  // Direct messages are with people in the company (F-037).
  const workspaceId = params.get('workspace') ?? workspace?.id ?? '';
  const [loaded, setLoaded] = useState<{ workspaceId: string; list: WorkspaceMember[]; note: string } | null>(null);
  const members = loaded?.workspaceId === workspaceId ? loaded.list : null;
  const membersNote = loaded?.workspaceId === workspaceId ? loaded.note : '';
  const touch = useMediaQuery(MEDIA.touch);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>(direct ? [direct] : []);
  const chosenNow = useRef(selected);
  useEffect(() => { chosenNow.current = selected; }, [selected]);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** The other person left the 1:1 (or the company): a calm explanation instead of a thread. */
  const [notice, setNotice] = useState('');
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  const autoOpened = useRef(false);

  useEffect(() => {
    if (!workspaceId || guest) return;
    const controller = new AbortController();
    listWorkspaceMembers(workspaceId, controller.signal)
      .then((list) => setLoaded({ workspaceId, list: list.filter((member) => member.userId !== me.user.id), note: '' }))
      .catch(() => {
        if (controller.signal.aborted) return;
        setLoaded({ workspaceId, list: [], note: 'Could not load people. Try again.' });
      });
    return () => controller.abort();
  }, [workspaceId, me.user.id, guest]);

  async function start(ids = selected) {
    if (!workspaceId || !ids.length || busy) return;
    const name = ids.length > 1 ? title.trim() : '';
    const signature = JSON.stringify([workspaceId, [...ids].sort(), name]);
    // The same attempt reuses its Idempotency-Key, so a retry after a lost response opens one group.
    if (attempt.current?.signature !== signature) attempt.current = { signature, key: crypto.randomUUID() };
    setBusy(true); setError(''); setNotice('');
    // What is typed while the conversation opens is its first message (P2 #2): kept until its composer takes focus, never a shortcut, with
    // what was typed since the person's name that led here was pressed.
    // Enter in Find people opens it while focus is still in that field, where the next keys would go and be lost with the page (persona
    // round 29 P2 1: "Kasia, the oven…" was sent as "asia, the oven…"): the field is left at once, so they are kept for the composer.
    const searching = document.activeElement?.id === 'dm-people-search';
    if (!touch) { if (searching) (document.activeElement as HTMLElement).blur(); waitForField(); }
    try {
      const dm = await openDm(workspaceId, ids, attempt.current.key, name || undefined);
      // The conversation takes this page's place in the history: Back from it goes to where the person started, never to the picker they
      // used (personas-34). A person's name keeps the origin it was followed from (#592).
      navigate(`/dm/${dm.id}`, { replace: true, ...(direct ? { state: arrivalState } : {}) });
    } catch (cause) {
      stopAwaitingField();
      if (searching) document.getElementById('dm-people-search')?.focus();
      if (cause instanceof ApiError && (cause.code === 'DM_RECIPIENT_LEFT' || cause.code === 'DM_RECIPIENT_UNAVAILABLE')) {
        setNotice(cause.message); setBusy(false); return;
      }
      setError(cause instanceof ApiError && cause.code === 'DM_PARTICIPANT_UNAVAILABLE'
        ? 'Someone you chose is no longer in the company.'
        : cause instanceof ApiError && cause.status === 403 ? 'You can’t start conversations here.' : 'Could not open the conversation. Try again.');
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!direct || !workspaceId || guest || autoOpened.current) return;
    autoOpened.current = true;
    void start([direct]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [direct, workspaceId]);

  // A picker opens on its first field (F-026 §4, round 27 P2 2): a name typed at once is the search, never a shortcut.
  const picking = !!workspaceId && !direct;
  useLayoutEffect(() => (picking && !touch ? focusField('dm-people-search') : undefined), [picking, touch]);

  // Enter typed while the people still load ("Mar", Enter, Enter and a sentence at once, persona round 31): it is kept with the words it
  // followed and acted on when they are here, as it would have been. Meanwhile the keys after it wait for the field they lead to.
  const queued = useRef<{ text: string; enters: number; stop: () => void } | null>(null);
  const startNow = useRef(start);
  useEffect(() => { startNow.current = start; });
  function holdEnter(search: HTMLInputElement) {
    if (queued.current) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || !queued.current || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      queued.current.enters += 1;
    };
    window.addEventListener('keydown', onKey, true);
    queued.current = { text: search.value, enters: 1, stop: () => window.removeEventListener('keydown', onKey, true) };
    search.blur();
    waitForField();
  }
  useEffect(() => () => queued.current?.stop(), []);
  useEffect(() => {
    const waiting = queued.current;
    if (!waiting || members === null) return;
    queued.current = null;
    waiting.stop();
    const needle = waiting.text.trim().toLowerCase();
    const found = members.filter((member) => !needle || member.name.toLowerCase().includes(needle) || member.email.toLowerCase().includes(needle));
    const one = found.length === 1 ? found[0]! : null;
    if (one) {
      chosenNow.current = [...chosenNow.current.filter((id) => id !== one.userId), one.userId];
      setSelected(chosenNow.current);
      if (waiting.enters >= 2 && chosenNow.current.length === 1) { void startNow.current([one.userId]); return; }
    }
    // Back in Find people: what was typed after the Enter goes into it, as it would have.
    document.getElementById('dm-people-search')?.focus();
  }, [members]);
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

  // Reached by address (nothing in the app leads a guest here): the one rule, and the way back, instead of a form that refuses at its end.
  if (guest) {
    return (
      <div className="pane-scroll"><div className="pane-in dm-gone" role="status">
        <Icon name="lock" size={16} />
        <div><h2>Guests don’t start conversations</h2><p>You can reply in conversations you’re added to.</p>
          <Link className="ui-btn ui-btn--secondary" to="/dm">Back to Messages</Link></div>
      </div></div>
    );
  }
  if (notice) {
    return (
      <div className="pane-scroll"><div className="pane-in dm-gone" role="status">
        <Icon name="lock" size={16} />
        <div><h2>No one to message here</h2><p>{notice}</p>
          <Link className="ui-btn ui-btn--secondary" to="/dm">Back to Messages</Link></div>
      </div></div>
    );
  }
  if (direct && !error) {
    return <div className="pane-scroll"><div className="pane-in"><p className="dm-new__opening" role="status">Opening your conversation…</p></div></div>;
  }
  return (
    <div className="pane-scroll"><div className="pane-in dm-new">
      {/* The header already names the page, "New message": the page does not say it again. */}
      <p className="dm-new__lead">Pick one person for a one-to-one conversation, or a few for a small group. It stays outside every space.</p>
      {!workspaceId ? <p className="dm-new__note">You’re not in a company on this Flux yet. Ask an admin for an invite link.</p> : null}
      {workspaceId ? (
        <>
          <label className="ui-vh" htmlFor="dm-people-search">Find people</label>
          <input id="dm-people-search" className="dm-new__search" type="search" placeholder="Find people by name or email" value={query} onChange={(event) => setQuery(event.target.value)} autoComplete="off"
            // One person found is picked by Enter or the down arrow (persona round 28); Enter again opens the conversation. The down arrow
            // otherwise moves into the list.
            // The keys read the choice as it is now, not as the page last drew it: "Mar", Enter, Enter typed at once opened nothing and left
            // the sentence after them in Find people (persona round 31).
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== 'ArrowDown') return;
              if (event.key === 'Enter' && members === null) { event.preventDefault(); holdEnter(event.currentTarget); return; }
              const one = shown.length === 1 ? shown[0]! : null;
              const now = chosenNow.current;
              if (event.key === 'Enter' && one && now.includes(one.userId) && now.length === 1) { event.preventDefault(); void start([one.userId]); return; }
              if (one && !now.includes(one.userId)) { event.preventDefault(); chosenNow.current = [...now, one.userId]; toggle(one.userId); return; }
              if (event.key === 'ArrowDown') { event.preventDefault(); event.currentTarget.closest('.dm-new')?.querySelector<HTMLInputElement>('.dm-new__people input')?.focus(); }
            }} />
          {members === null ? <p className="dm-new__note" role="status">Loading people…</p> : null}
          {membersNote ? <p className="dm-new__note">{membersNote}</p> : null}
          {members && !members.length && !membersNote ? <p className="dm-new__note">Nobody else is in the company yet.</p> : null}
          <ul className="dm-new__people" aria-label="People">
            {shown.map((member) => {
              const checked = selected.includes(member.userId);
              return (
                <li key={member.userId}>
                  <label className={`dm-new__person${checked ? ' is-on' : ''}`}>
                    <input type="checkbox" checked={checked} onChange={() => toggle(member.userId)} />
                    <Avatar name={member.name} id={member.userId} size="md" />
                    <span className="dm-new__name"><b>{member.name}</b><span>{member.email}{member.role === 'guest' ? ' · Guest' : ''}</span></span>
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
