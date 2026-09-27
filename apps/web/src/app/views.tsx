import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, type NavigateFunction } from 'react-router';
import { Button, EmptyState, Icon, duration, type IconName } from '../ui';
import { useCaptures } from './captures';
import { useShellData } from './data';

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

function Pane({ children }: { children: ReactNode }) {
  return (
    <div className="pane-scroll">
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
  const { me } = useShellData();
  const { items, add, remove } = useCaptures(me.user.id);
  const [draft, setDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const firstName = me.user.name.trim().split(/\s+/)[0] || me.user.name;
  const canSend = draft.trim().length > 0;
  const captureRequest = (useLocation().state as { capture?: number } | null)?.capture;
  useEffect(() => { if (captureRequest) textareaRef.current?.focus(); }, [captureRequest]);

  const autosize = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  };
  const send = () => {
    if (!canSend) return;
    add(draft.trim());
    setDraft('');
    requestAnimationFrame(() => { autosize(); endRef.current?.scrollIntoView({ block: 'end', behavior: duration('--dur-1') ? 'smooth' : 'auto' }); });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); }
  };

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
          <p className="composer__audience" id={audienceId}><Icon name="lock" size={13} />Only you<span aria-hidden="true"> · </span><span className="composer__where">private note</span></p>
          <div className="composer__box">
            <label className="ui-vh" htmlFor="composer">Private note</label>
            <textarea id="composer" ref={textareaRef} rows={1} value={draft} placeholder="Capture a thought…"
              aria-describedby={`${audienceId} ${hintId}`} onChange={(event) => { setDraft(event.target.value); autosize(); }} onKeyDown={onKeyDown} />
            <button type="button" className="composer__send" aria-label="Save note" aria-disabled={!canSend} onClick={send}><Icon name="send" /></button>
          </div>
          <p className="composer__hint" id={hintId}><span className="composer__keys">Enter saves · Shift+Enter for a new line · </span>Kept in this browser until sharing arrives</p>
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

export function MapView() {
  const navigate = useNavigate();
  return (
    <Pane>
      <div className="view-empty">
        <EmptyState icon="map" title="Start a sketch"
          action={<Button variant="primary" icon="plus" onClick={() => startCapture(navigate)}>New thought</Button>}>
          <p>Maps are for thinking out loud: put thoughts down, connect them and move them around. Nothing on a map has to become work.</p>
          <p>Sketching on a canvas is on its way; for now a new thought is saved to your private notes.</p>
        </EmptyState>
      </div>
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
