import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link, useLocation, type NavigateFunction } from 'react-router';
import { EmptyState, Icon, IconButton, duration, type IconName } from '../ui';
import { useCaptures } from './captures';
import { useShellData } from './data';
import { useDraft, useReadingPosition } from './drafts';
import { useShellActions } from './shellContext';

export const VIEWS = [
  { id: 'conversation', label: 'Conversation', path: '/' },
  { id: 'tasks', label: 'Tasks', path: '/tasks' },
  { id: 'map', label: 'Map', path: '/map' },
  { id: 'docs', label: 'Docs', path: '/docs' },
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

function when(iso: string) {
  const date = new Date(iso);
  const today = new Date().toDateString() === date.toDateString();
  return today ? timeFormat.format(date) : `${dayFormat.format(date)}, ${timeFormat.format(date)}`;
}

/** Focus the Home composer, e.g. from "+ New thought". */
export function startCapture(navigate: NavigateFunction) {
  const composer = document.getElementById('composer');
  if (composer && window.location.pathname === '/') { composer.focus(); return; }
  navigate('/', { state: { capture: Date.now() } });
}

/**
 * Home: the personal return view. Its conversation is your private notes: the composer
 * always shows the audience ("Only you"), and nothing leaves this device until sharing exists.
 * Project conversations and direct messages (#36) open from the sidebar.
 */
export function ConversationView() {
  const hintId = useId();
  const audienceId = useId();
  const askId = useId();
  const { me } = useShellData();
  const { openDetails } = useShellActions();
  const { items, add, remove } = useCaptures(me.user.id);
  // Unsent text is kept per account and context, so a view switch or reload never loses it.
  const draft = useDraft(me.user.id, 'home');
  // Ask mode targets the signed-in person's own assistant (#57). No compute path exists yet,
  // so it only explains how to connect one and never pretends to answer.
  const [asking, setAsking] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const firstName = me.user.name.trim().split(/\s+/)[0] || me.user.name;
  const canSend = draft.text.trim().length > 0 && !asking;
  const captureRequest = (useLocation().state as { capture?: number } | null)?.capture;
  useEffect(() => { if (captureRequest) textareaRef.current?.focus(); }, [captureRequest]);

  const autosize = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  };
  // A restored draft gets its full height on the first paint.
  useLayoutEffect(autosize, []);
  const send = () => {
    if (!canSend) return;
    add(draft.text.trim());
    draft.clear();
    requestAnimationFrame(() => { autosize(); endRef.current?.scrollIntoView({ block: 'end', behavior: duration('--dur-1') ? 'smooth' : 'auto' }); });
  };
  const stopAsking = () => { setAsking(false); textareaRef.current?.focus(); };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape' && asking) { event.preventDefault(); event.stopPropagation(); stopAsking(); return; }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); }
  };
  const hasDraft = draft.text.length > 0;

  return (
    <div className="convo">
      <Pane>
        <div className="intro">
          <h2>Welcome, {firstName}</h2>
          <p>Jot down a thought, a link or a half-formed idea. It stays with you until you choose to share it.</p>
        </div>
        {items.length ? (
          <section className="notes" aria-label="Your private notes">
            <p className="notes__h"><Icon name="lock" size={13} />Only you can see these</p>
            <ol className="notes__list" role="log" aria-live="polite">
              {items.map((item) => (
                <li key={item.id} className="note">
                  <p className="note__text">{item.text}</p>
                  <div className="note__meta">
                    <time dateTime={item.createdAt}>{when(item.createdAt)}</time>
                    <button type="button" className="note__del" onClick={() => remove(item.id)} aria-label={`Delete note: ${item.text.slice(0, 40)}`}>Delete</button>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        ) : (
          <ViewEmpty icon="chat" title="Nothing here yet" level={3}>
            <p>Write your first thought below. When you’re added to a project or someone messages you, those conversations open from the sidebar.</p>
          </ViewEmpty>
        )}
        <div ref={endRef} />
      </Pane>
      <div className="composer">
        <div className="composer__in" data-shift>
          {asking ? (
            <div className="ask" id={askId}>
              <span className="ask__who"><Icon name="spark" size={13} />Your assistant
                <IconButton icon="x" size={12} label="Stop asking your assistant" className="ask__off" onClick={stopAsking} />
              </span>
              <span className="ask__note">You haven’t connected an assistant, so nothing will be sent.</span>
              <button type="button" className="ui-link ask__connect" onClick={() => openDetails('connect-ai')}>Connect your AI</button>
            </div>
          ) : (
            <p className="composer__audience" id={audienceId}><Icon name="lock" size={13} />Only you<span aria-hidden="true"> · </span><span className="composer__where">private note</span></p>
          )}
          <div className="composer__box">
            <label className="ui-vh" htmlFor="composer">Private note</label>
            <button type="button" className="composer__ask" aria-pressed={asking} aria-label="Ask my assistant" data-tip="Ask my assistant" data-tip-align="start"
              onClick={() => { setAsking(!asking); textareaRef.current?.focus(); }}>
              <Icon name="spark" />
            </button>
            <textarea id="composer" ref={textareaRef} rows={1} value={draft.text} placeholder={asking ? 'Ask your assistant…' : 'Capture a thought…'}
              aria-describedby={`${asking ? askId : audienceId} ${hintId}`} onChange={(event) => { draft.setText(event.target.value); autosize(); }} onKeyDown={onKeyDown} />
            <button type="button" className="composer__send" aria-label={asking ? 'Send to your assistant' : 'Save note'} aria-disabled={!canSend} onClick={send}><Icon name="send" /></button>
          </div>
          <p className="composer__hint" id={hintId}>
            <span className="composer__keys">Enter saves · Shift+Enter for a new line · </span>
            <span className="composer__state" aria-live="polite">
              {hasDraft
                ? (draft.storage === 'device' ? 'Draft kept on this device' : 'Draft kept until you close this tab')
                : 'Notes stay in this browser until sharing arrives'}
            </span>
          </p>
        </div>
      </div>
    </div>
  );
}

export function TasksView() {
  return (
    <Pane>
      <ViewEmpty icon="tasks" title="No tasks yet">
        <p>When a thought turns into something to do, its task shows up here, linked to where it came from. Nothing is due, and nothing needs clearing.</p>
      </ViewEmpty>
    </Pane>
  );
}

export function DocsView() {
  return (
    <Pane>
      <ViewEmpty icon="doc" title="No docs yet">
        <p>Notes worth keeping, what you learned from an experiment, and how things work, written with the people in your projects, will collect here.</p>
      </ViewEmpty>
    </Pane>
  );
}

/** Direct messages: private conversations with people, independent of any project (#36). */
export function DirectMessagesView() {
  return (
    <Pane>
      <ViewEmpty icon="chat" title="No direct messages yet">
        <p>When you talk with someone one to one, or with a few people outside a project, the conversation lives here. Only the people in it can see it.</p>
        <p>Messaging people directly isn’t available in this version yet.</p>
      </ViewEmpty>
    </Pane>
  );
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
