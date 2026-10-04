import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link, useLocation, useRevalidator, type NavigateFunction } from 'react-router';
import type { Draft } from '@flux/contracts';
import { Button, EmptyState, Icon, IconButton, MEDIA, duration, sendsOnEnter, useMediaQuery, type IconName } from '../ui';
import { createPrivateDraft, listDrafts } from './conversation-api';
import { captureExists, clearMoveTarget, moveKey, moveTarget, noteTitle, removeCapture, useCaptures } from './captures';
import { AccountChangedError, assertSignedInAs, ensurePersonalSpace } from './personalSpace';
import { useIntentKeys } from '../api/intent-keys';
import { useShellData } from './data';
import { useDraft, useReadingPosition } from './drafts';
import { useShellActions } from './shellContext';
import { SinceYouLeftHome } from '../returns/SinceYouLeft';
import { HomeTasks } from './HomeTasks';
import { getAssistantStatus } from '../assistant/api';

/** Home's views in the same order and words as a project's (Studio 11.6, #136). */
export const VIEWS = [
  { id: 'conversation', label: 'Conversation', path: '/' },
  { id: 'map', label: 'Map', path: '/map' },
  { id: 'tasks', label: 'Tasks', path: '/tasks' },
  { id: 'docs', label: 'Wiki', path: '/docs' },
] as const;

export function viewIndex(pathname: string): number {
  const index = VIEWS.findIndex((view) => view.path !== '/' && pathname.startsWith(view.path));
  return index < 0 ? 0 : index;
}

/** A view's scroll area. Its reading position is kept per account and view across switches and reloads. */
function Pane({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const { me } = useShellData();
  useReadingPosition(ref, me.user.id, useLocation().pathname);
  return (
    <div className="pane-scroll" ref={ref}>
      <div className="pane-in" data-shift>{children}</div>
    </div>
  );
}

function ViewEmpty({ icon, title, level = 2, children }: { icon: IconName; title: string; level?: 2 | 3; children: ReactNode }) {
  return <div className="view-empty"><EmptyState icon={icon} title={title} level={level}>{children}</EmptyState></div>;
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

/** Your own private drafts: the only drafts Home lists. */
const ownPrivate = (userId: string) => (item: Draft) => item.visibility === 'private' && item.owner.kind === 'human' && item.owner.id === userId;

function when(iso: string) {
  const date = new Date(iso);
  const today = new Date().toDateString() === date.toDateString();
  return today ? timeFormat.format(date) : `${dayFormat.format(date)}, ${timeFormat.format(date)}`;
}

/** Focus the Home composer, e.g. from "+ New note". */
export function startCapture(navigate: NavigateFunction) {
  const composer = document.getElementById('composer');
  if (composer && window.location.pathname === '/') { composer.focus(); return; }
  navigate('/', { state: { capture: Date.now() } });
}

/**
 * Home: the personal return view. Its conversation is your private notes, saved as private
 * drafts in your space (HOME-3, #190); the first note creates that space. The composer always
 * shows the audience ("Only you"). Notes an account once kept only in this browser are offered,
 * explicitly, to move into the account. Project conversations and direct messages (#36) open from
 * the sidebar.
 */
/** Home's notes. Everything it holds (space, drafts, a move in progress) is one account's: another starts afresh. */
export function ConversationView() {
  const { me } = useShellData();
  return <HomeNotes key={me.user.id} />;
}

function HomeNotes() {
  // Touch devices add a line with Enter and send with the button (#189).
  const touch = useMediaQuery(MEDIA.touch);
  const hintId = useId();
  const audienceId = useId();
  const askId = useId();
  const { me, workspaces } = useShellData();
  const { openDetails } = useShellActions();
  const { items, remove } = useCaptures(me.user.id);
  const revalidator = useRevalidator();
  // Unsent text is kept per account and context, so a view switch or reload never loses it.
  const draft = useDraft(me.user.id, 'home');
  const [selectedWorkspace, setSelectedWorkspace] = useState(workspaces.length === 1 ? workspaces[0]!.id : '');
  // A space created by the first note (or a sketch) arrives with the shell's next answer.
  const [spacesSeen, setSpacesSeen] = useState(workspaces);
  if (spacesSeen !== workspaces) {
    setSpacesSeen(workspaces);
    if (!selectedWorkspace && workspaces.length === 1) setSelectedWorkspace(workspaces[0]!.id);
  }
  const [serverDrafts, setServerDrafts] = useState<Draft[]>([]);
  const [draftsTotal, setDraftsTotal] = useState(0);
  // The list API pages over every draft the person can read; only their own private ones are shown,
  // so the next page starts after all drafts read so far, not after the shown ones.
  const [draftsRead, setDraftsRead] = useState(0);
  // Drafts saved here while a list read was in flight: that older answer must not hide them.
  const savedHere = useRef<{ draft: Draft; seq: number }[]>([]);
  const saves = useRef(0);
  const [draftsReload, setDraftsReload] = useState(0);
  // Saving and moving belong to the account that started them: a sign-out stops them (HOME-3).
  const work = useRef<AbortController>(new AbortController());
  useEffect(() => {
    const controller = new AbortController();
    work.current = controller;
    return () => controller.abort();
  }, [me.user.id]);
  const [move, setMove] = useState<{ state: 'idle' | 'busy' | 'done' | 'partial'; moved: number; of: number }>({ state: 'idle', moved: 0, of: 0 });
  const [notNow, setNotNow] = useState(false);
  const [saveState, setSaveState] = useState('');
  const [saving, setSaving] = useState(false);
  // Without an assistant of your own, its button leads to "Connect your AI" (#189); it stays owner-only.
  const [noAssistant, setNoAssistant] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    getAssistantStatus(controller.signal).then((status) => setNoAssistant(status.state === 'not_enabled'), () => undefined);
    return () => controller.abort();
  }, [me.user.id]);
  const intents = useIntentKeys();
  // With changes to return to, the "nothing here yet" empty state would contradict them.
  const [returning, setReturning] = useState(false);
  useEffect(() => {
    if (!selectedWorkspace) return;
    const controller = new AbortController();
    const since = saves.current;
    listDrafts(selectedWorkspace, controller.signal)
      .then((page) => {
        const fetched = page.items.filter(ownPrivate(me.user.id));
        // Only saves newer than this read can be missing from it; older ones it answers for.
        savedHere.current = savedHere.current.filter((saved) => saved.seq > since);
        const missing = savedHere.current.map((saved) => saved.draft)
          .filter((item) => item.workspaceId === selectedWorkspace && !fetched.some((had) => had.id === item.id));
        setServerDrafts([...missing, ...fetched]);
        setDraftsRead(page.items.length);
        setDraftsTotal(page.total);
      })
      .catch(() => { if (!controller.signal.aborted) setSaveState('Could not load private drafts.'); });
    return () => controller.abort();
  }, [selectedWorkspace, me.user.id, draftsReload]);
  const [moreBusy, setMoreBusy] = useState(false);
  const loadMoreDrafts = async () => {
    if (!selectedWorkspace || moreBusy) return;
    setMoreBusy(true);
    try {
      const page = await listDrafts(selectedWorkspace, work.current.signal, draftsRead);
      setServerDrafts((current) => [...current, ...page.items.filter(ownPrivate(me.user.id)).filter((item) => !current.some((had) => had.id === item.id))]);
      setDraftsRead((read) => read + page.items.length);
      setDraftsTotal(page.total);
    } catch { /* the button stays for another try */ } finally { setMoreBusy(false); }
  };
  // Ask mode targets the signed-in person's own assistant (#57). No compute path exists yet,
  // so it only explains how to connect one and never pretends to answer.
  const [askOn, setAsking] = useState(false);
  // A tap before the status loaded never leaves ask mode on for someone without an assistant.
  const asking = askOn && !noAssistant;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const firstName = me.user.name.trim().split(/\s+/)[0] || me.user.name;
  const canSend = draft.text.trim().length > 0 && !asking && !saving;
  const { state: routeState, hash } = useLocation();
  const captureRequest = (routeState as { capture?: number } | null)?.capture;
  // A search result (#114) opens Home on that private draft.
  const arrivedDraft = hash.startsWith('#draft-') ? hash.slice('#draft-'.length) : null;
  useEffect(() => {
    const anchor = arrivedDraft ? document.getElementById(`draft-${arrivedDraft}`) : null;
    if (anchor) { anchor.scrollIntoView({ block: 'center' }); anchor.focus({ preventScroll: true }); }
  }, [arrivedDraft, serverDrafts]);
  useEffect(() => { if (captureRequest) textareaRef.current?.focus(); }, [captureRequest]);

  const autosize = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  };
  // A restored draft gets its full height on the first paint.
  useLayoutEffect(autosize, []);
  /**
   * The space a note goes to: the chosen one, or the personal space (created on the first note).
   * When the server already has several spaces the shell has not seen yet (created in another tab,
   * or an invitation), the shell reads them again so the person can choose one (#211 HOME-3).
   */
  const spaceForNotes = async (signal: AbortSignal) => {
    if (selectedWorkspace) return selectedWorkspace;
    if (workspaces.length > 1) return null;
    const space = await ensurePersonalSpace(me.user.id, signal);
    if (!signal.aborted) revalidator.revalidate();
    if (space) setSelectedWorkspace(space);
    return space;
  };
  const send = async () => {
    if (!canSend) return;
    if (workspaces.length > 1 && !selectedWorkspace) { setSaveState('Choose a space for this private draft.'); return; }
    const { signal } = work.current;
    setSaving(true); setSaveState('Saving…');
    try {
      const body = draft.text.trim();
      const space = await spaceForNotes(signal);
      if (signal.aborted) return;
      if (!space) { setSaveState('Choose a space for this private draft.'); return; }
      // One stable key per text and space (#178): a retry after a lost answer returns the same draft.
      const intent = `draft:${space}:${body}`;
      await assertSignedInAs(me.user.id, signal);
      const created = await createPrivateDraft(space, noteTitle(body), body, intents.keyFor(intent), signal);
      if (signal.aborted) return;
      intents.settle(intent);
      saves.current += 1;
      savedHere.current = [{ draft: created, seq: saves.current }, ...savedHere.current.filter((saved) => saved.draft.id !== created.id)];
      setServerDrafts((current) => [created, ...current.filter((item) => item.id !== created.id)]);
      draft.clear();
      setSaveState('Saved privately to your space');
      requestAnimationFrame(() => { autosize(); endRef.current?.scrollIntoView({ block: 'end', behavior: duration('--dur-1') ? 'smooth' : 'auto' }); });
    } catch (cause) {
      // The text stays in the composer: nothing falls back to this browser.
      if (signal.aborted) return;
      if (cause instanceof AccountChangedError) { setSaveState(cause.message); revalidator.revalidate(); return; }
      setSaveState('Save failed. Your text is still here; retry when ready.');
    } finally { setSaving(false); }
  };
  // Notes this account once kept only in this browser move into the account only on request: one
  // private draft per note, in order, each removed here once the server confirmed it.
  const moveNotes = async () => {
    if (move.state === 'busy' || !items.length) return;
    const { signal } = work.current;
    const userId = me.user.id;
    const notes = [...items];
    setMove({ state: 'busy', moved: 0, of: notes.length });
    let moved = 0;
    let failed = 0;
    try {
      const space = await spaceForNotes(signal);
      if (!space) { setMove({ state: 'idle', moved: 0, of: 0 }); setSaveState('Choose a space for these notes first.'); return; }
      for (const note of notes) {
        if (signal.aborted) return;
        // Another tab may have moved or deleted it meanwhile.
        if (!captureExists(userId, note.id)) continue;
        const target = moveTarget(userId, note.id, space);
        // Another account signed in elsewhere: stop before writing this account's notes into it.
        await assertSignedInAs(userId, signal);
        try {
          await createPrivateDraft(target, noteTitle(note.text), note.text, moveKey(note), signal);
          if (signal.aborted) return;
          removeCapture(userId, note.id);
          clearMoveTarget(userId, note.id);
          moved += 1;
          setMove({ state: 'busy', moved, of: notes.length });
        } catch {
          if (signal.aborted) return;
          failed += 1;
        }
      }
    } catch (cause) {
      if (signal.aborted) return;
      if (cause instanceof AccountChangedError) {
        setMove({ state: moved ? 'partial' : 'idle', moved, of: moved ? notes.length : 0 });
        setSaveState(cause.message);
        revalidator.revalidate();
        return;
      }
      failed = notes.length - moved;
    }
    setMove({ state: failed ? 'partial' : 'done', moved, of: notes.length });
    setDraftsReload((n) => n + 1);
  };
  const targetName = selectedWorkspace ? workspaces.find((space) => space.id === selectedWorkspace)?.name ?? 'your space'
    : workspaces.length === 0 ? 'Personal' : null;
  const stopAsking = () => { setAsking(false); textareaRef.current?.focus(); };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape' && asking) { event.preventDefault(); event.stopPropagation(); stopAsking(); return; }
    if (sendsOnEnter(event, touch)) { event.preventDefault(); void send(); }
  };
  const hasDraft = draft.text.length > 0;

  return (
    <div className="convo">
      <Pane>
        <div className="intro">
          <h2>Welcome, {firstName}</h2>
          <p>Jot down a note, a link or a half-formed idea. It stays with you until you choose to share it.</p>
        </div>
        <SinceYouLeftHome onShown={setReturning} />
        {serverDrafts.length ? (
          <section className="notes" aria-label="Private drafts">
            <p className="notes__h"><Icon name="lock" size={13} />Private drafts · saved in your space</p>
            <ol className="notes__list">{serverDrafts.map((item) => <li className={`note${arrivedDraft === item.id ? ' is-arrived' : ''}`} key={item.id} id={`draft-${item.id}`} tabIndex={-1}><p className="note__text">{item.body}</p><div className="note__meta">You · v{item.version} · <time dateTime={item.updatedAt}>{when(item.updatedAt)}</time></div></li>)}</ol>
            {draftsRead < draftsTotal ? <Button variant="quiet" busy={moreBusy} onClick={() => void loadMoreDrafts()}>Show more drafts</Button> : null}
          </section>
        ) : null}
        {move.state === 'done' && !items.length ? <p className="notes__moved" role="status">Moved {move.moved} {move.moved === 1 ? 'note' : 'notes'} into {targetName ?? 'your space'}.</p> : null}
        {items.length ? (
          <section className="notes" aria-label="Notes in this browser">
            <p className="notes__h"><Icon name="lock" size={13} />Only in this browser · only you can see these</p>
            {!notNow || move.state !== 'idle' ? (
              <div className="notes__move">
                <p>{targetName
                  ? <>Move {items.length} {items.length === 1 ? 'note' : 'notes'} from this browser into {targetName}. They become private drafts only you can open: not readable by other members, workspace owners or admins, or agents.</>
                  : <>Choose a space below, then move these notes from this browser into your account as private drafts only you can open.</>}</p>
                <div className="notes__move-actions">
                  <Button variant="secondary" icon="send" busy={move.state === 'busy'} disabled={!targetName} onClick={() => void moveNotes()}>
                    {`Move ${items.length} ${items.length === 1 ? 'note' : 'notes'} into ${targetName ?? 'a space'}`}</Button>
                  {move.state === 'idle' ? <Button variant="quiet" onClick={() => setNotNow(true)}>Not now</Button> : null}
                </div>
                <p className="notes__move-state" role="status">{move.state === 'busy' ? `Moving ${move.moved + 1} of ${move.of}…`
                  : move.state === 'partial' ? `Moved ${move.moved} of ${move.of}. The rest stay in this browser; try again.` : ''}</p>
              </div>
            ) : null}
            <ol className="notes__list">
              {items.map((item) => (
                <li key={item.id} className="note" id={`capture-${item.id}`}>
                  <p className="note__text">{item.text}</p>
                  <div className="note__meta">
                    <time dateTime={item.createdAt}>{when(item.createdAt)}</time>
                    <button type="button" className="note__del" onClick={() => remove(item.id)} aria-label={`Delete note: ${item.text.slice(0, 40)}`}>Delete</button>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        ) : !serverDrafts.length && !returning ? (
          <ViewEmpty icon="chat" title="Nothing here yet" level={3}>
            <p>Write your first note below. When you’re added to a project or someone messages you, those conversations open from the sidebar.</p>
          </ViewEmpty>
        ) : null}
        <div ref={endRef} />
      </Pane>
      <div className="composer">
        <div className="composer__in" data-shift>
          {asking ? (
            <div className="ask" id={askId}>
              <span className="ask__who"><Icon name="spark" size={13} />Your assistant
                <IconButton icon="x" size={12} label="Stop asking your assistant" className="ask__off" onClick={stopAsking} />
              </span>
              <span className="ask__note">Your assistant answers in project conversations. Notes here stay private and are never sent.</span>
              <button type="button" className="ui-link ask__connect" onClick={() => openDetails('connect-ai')}>Connect your AI</button>
            </div>
          ) : (
            <p className="composer__audience" id={audienceId}><Icon name="lock" size={13} />Only you<span aria-hidden="true"> · </span><span className="composer__where">private draft in {selectedWorkspace ? `${workspaces.find((space) => space.id === selectedWorkspace)?.name ?? 'your space'}, which only you can open` : workspaces.length ? 'a space you choose' : 'your personal space'}</span></p>
          )}
          {workspaces.length > 1 ? <label className="composer__space">Save in <select value={selectedWorkspace} onChange={(event) => { setSelectedWorkspace(event.target.value); setServerDrafts([]); setSaveState(''); }}><option value="">Choose a space</option>{workspaces.map((space) => <option key={space.id} value={space.id}>{space.name}</option>)}</select></label> : null}
          <div className="composer__box">
            <label className="ui-vh" htmlFor="composer">Private note</label>
            <button type="button" className="composer__ask" aria-pressed={noAssistant ? undefined : asking} aria-label={noAssistant ? 'Connect your AI' : 'Ask my assistant'}
              data-tip={noAssistant ? 'Connect your AI' : 'Ask my assistant'} data-tip-align="start"
              onClick={() => { if (noAssistant) { openDetails('connect-ai'); return; } setAsking(!asking); textareaRef.current?.focus(); }}>
              <Icon name="spark" />
            </button>
            <textarea id="composer" ref={textareaRef} rows={1} value={draft.text} disabled={saving} placeholder={asking ? 'Ask your assistant…' : 'Write a note…'}
              aria-describedby={`${asking ? askId : audienceId} ${hintId}`} onChange={(event) => { draft.setText(event.target.value); autosize(); }} onKeyDown={onKeyDown} />
            <button type="button" className="composer__send" aria-label={asking ? 'Send to your assistant' : 'Save note'} aria-disabled={!canSend} onClick={() => void send()}><Icon name="send" /></button>
          </div>
          <p className="composer__hint" id={hintId}>
            <span className="composer__keys">Enter saves · Shift+Enter for a new line · </span>
            <span className="composer__state" aria-live="polite">
              {hasDraft
                ? (draft.storage === 'device' ? 'Draft kept on this device' : 'Draft kept until you close this tab')
                : 'Private until you explicitly publish a selected version'}
            </span>
          </p>
          {saveState ? <p className="composer__hint" role="status">{saveState}</p> : null}
        </div>
      </div>
    </div>
  );
}

/** Home's Tasks: the work you own across your projects (#190 HOME-2). */
export function TasksView() {
  return <Pane><HomeTasks /></Pane>;
}

export function NotFoundView() {
  return (
    <Pane>
      <div className="view-empty">
        <EmptyState icon="search" title="This page doesn’t exist" action={<Link className="ui-btn ui-btn--secondary" to="/">Go to Home</Link>}>
          <p>The address may be mistyped, or what it pointed to was moved.</p>
        </EmptyState>
      </div>
    </Pane>
  );
}
