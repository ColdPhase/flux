import { useEffect, useId, useRef, useState } from 'react';
import type { LiveSession, ProjectPerson } from '@flux/contracts';
import { Avatar, Button, useLoopPause } from '../ui';
import { useProjectShell } from '../project/data';
import { anchorLabel, KIND_WORD, sameContext, type LiveAnchor } from './anchors';
import { sessionAt, useLive, useLiveHere, useProjectSessions } from './LiveProvider';
import { Popover } from './Popover';

/** The live mark; its breathing ring runs only while it can be seen (#155 AC-4) and never with reduced motion. */
export function LiveDot({ on }: { on: boolean }) {
  const loop = useLoopPause<HTMLSpanElement>();
  return <span ref={on ? loop : undefined} className={`lv-dot${on ? ' lv-dot--on' : ''}`} aria-hidden="true" />;
}

function firstName(name: string) { return name.trim().split(/\s+/)[0] || name; }

export function namesLine(ids: string[], nameOf: (id: string) => string, meId: string): string {
  const others = ids.filter((id) => id !== meId).map((id) => firstName(nameOf(id)));
  const withMe = ids.includes(meId) ? [...others, 'you'] : others;
  if (!withMe.length) return 'Nobody yet';
  if (withMe.length === 1) return withMe[0]!.replace(/^you$/, 'You');
  if (withMe.length <= 3) return `${withMe.slice(0, -1).join(', ')} and ${withMe.at(-1)}`;
  return `${withMe.slice(0, 2).join(', ')} and ${withMe.length - 2} others`;
}

/** Who may join: everyone who can open the anchor, which is the project's audience. */
export function audienceOf(people: ProjectPerson[] | null | undefined, meId: string): string {
  const humans = (people ?? []).filter((person) => person.kind === 'human' && person.id !== meId).map((person) => firstName(person.name));
  if (!humans.length) return 'Only you can join';
  if (humans.length === 1) return `${humans[0]} can join`;
  if (humans.length <= 3) return `${humans.slice(0, -1).join(', ')} and ${humans.at(-1)} can join`;
  return `${humans.slice(0, 2).join(', ')} and ${humans.length - 2} others can join`;
}

/**
 * “Work on this together” where the work is (#59 §1): one action starts a session at the
 * current task, map, doc or conversation, joins it with every device off and tells the
 * project's people quietly. A running session at this anchor becomes “Join”.
 */
export function LiveEntry({ variant = 'header', anchor: given, onAction }: {
  /** `more`: the header's Call as a row of More (⋯), where a narrow header moves it (Spokój rule 3). */
  variant?: 'header' | 'inline' | 'more'; anchor?: LiveAnchor | null; onAction?(): void;
}) {
  const live = useLive();
  const here = useLiveHere();
  const anchor = given ?? here.anchor;
  const shell = useProjectShell();
  const projectPeople = shell && anchor && shell.project.id === anchor.projectId ? shell.people : null;
  const configured = live.capability === 'configured';
  const { items } = useProjectSessions(anchor?.projectId, configured);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const noteId = useId();
  const nameOf = (id: string) => projectPeople?.find((person) => person.id === id)?.name ?? live.nameOf(id);

  // Spokój rule 7: the header's Call keeps its place in every view. Where there is nothing to work on together
  // (nothing open to anchor a session, a session already joined, or still checking) it stays, and a click says why
  // (#763 sweep: a permanently greyed button read as broken).
  const dimmed = (reason: string) => variant === 'more' ? (
    <button type="button" role="menuitem" className="newmenu__item top__more-narrow" data-more-row aria-disabled="true" aria-describedby={noteId}>
      <span>Call</span><span id={noteId} className="ui-vh">{reason}</span>
    </button>
  ) : variant === 'header' ? (
    <span className="lv-entry">
      <Button ref={buttonRef} variant="quiet" icon="call" className="lv-entry__btn lv-entry__btn--why" aria-label="Call" aria-describedby={noteId}
        aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((value) => !value)}>
        <span className="lv-entry__label">Call</span>
      </Button>
      <span id={noteId} className="ui-vh">{reason}</span>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={buttonRef} label="Call" className="lv-pop--narrow">
        <p className="lv-pop__text">{reason}</p>
      </Popover>
    </span>
  ) : null;
  if (live.capability === 'loading') return dimmed('Checking whether live sessions are available.');
  if (!anchor) return dimmed('Open a conversation, task, map or page to work on it together.');
  const inSession = live.phase === 'in' || live.phase === 'joining' || live.phase === 'rejoining' || live.phase === 'starting';
  const busy = live.phase === 'starting' || live.phase === 'joining';
  const here_ = sessionAt(items, anchor);
  const word = KIND_WORD[anchor.context.type];
  const audience = audienceOf(projectPeople, live.meId);

  if (!configured) {
    // Explained once, behind the header's "Call" (#189): a task does not repeat it.
    if (variant === 'inline') return null;
    if (variant === 'more') return dimmed('Live sessions are not available on this Flux server.');
    return (
      <span className="lv-entry">
        <Button ref={buttonRef} variant="quiet" icon="call" className="lv-entry__btn" aria-expanded={open} aria-haspopup="dialog" aria-label="Call" onClick={() => setOpen((v) => !v)}>
          <span className="lv-entry__label">Call</span>
        </Button>
        <Popover open={open} onClose={() => setOpen(false)} anchorRef={buttonRef} label="Live sessions" className="lv-pop--narrow">
          <p className="lv-pop__title">Live sessions are not available here</p>
          <p className="lv-pop__text">This Flux server has no media server configured, so voice, camera and screen sharing are off for everyone. Conversations, tasks, maps and docs work as usual.</p>
        </Popover>
      </span>
    );
  }

  if (inSession) {
    if (variant === 'header' || variant === 'more') return dimmed('You are in a live session.');
    if (live.session && sameContext(live.session.context, anchor.context))
      return <p className="lv-inline-note lv-inline-note--on"><span className="lv-dot" aria-hidden="true" />You are in the live session for this {word}.</p>;
    return null;
  }

  const joinable = here_ && here_.state === 'available';
  const present = joinable ? (here_.participants ?? []).map((p) => p.userId) : [];
  const label = joinable
    ? present.length ? `Join ${namesLine(present, nameOf, live.meId)}` : 'Join the session'
    : 'Work on this together';

  const act = () => {
    if (joinable) void live.join(here_, anchor);
    else void live.start(anchor);
  };

  if (variant === 'more') return (
    <button type="button" role="menuitem" className="newmenu__item top__more-narrow" data-more-row aria-describedby={noteId} onClick={() => { onAction?.(); act(); }}>
      <span>{joinable ? 'Join' : 'Call'}</span><span id={noteId} className="ui-vh">{joinable ? `${label}. Microphone and camera stay off.` : `Work on this ${word} together. ${audience}.`}</span>
    </button>
  );

  if (variant === 'inline') {
    return (
      <div className="lv-inline">
        <Button variant={joinable ? 'primary' : 'secondary'} icon="together" busy={busy} onClick={act} aria-describedby={noteId}>{label}</Button>
        <p id={noteId} className="lv-inline__note">{joinable ? `${present.length ? 'Live now · ' : ''}microphone and camera stay off until you turn them on` : `${audience} · nothing turns on until you choose`}</p>
      </div>
    );
  }

  return (
    <span className="lv-entry">
      <Button variant={joinable ? 'primary' : 'quiet'} icon={joinable ? undefined : 'call'} busy={busy} className={`lv-entry__btn${joinable ? ' lv-entry__btn--join' : ''}`}
        onClick={act} data-tip={joinable ? 'Join with microphone and camera off' : `${audience}. Nothing turns on until you choose.`} aria-describedby={noteId}
        aria-label={joinable ? 'Join' : 'Call'}>
        {joinable ? <LiveDot on /> : null}
        {joinable && present.length ? <span className="lv-faces" aria-hidden="true">{present.slice(0, 2).map((id) => <Avatar key={id} name={live.fullName(id)} id={id} size="sm" />)}</span> : null}
        <span className="lv-entry__label">{joinable ? 'Join' : 'Call'}</span>
      </Button>
      <span id={noteId} className="ui-vh">{joinable ? `${label}. Microphone and camera stay off.` : `Work on this ${word} together. ${audience}. Nothing turns on until you choose.`}</span>
    </span>
  );
}

/** Whether the header has folded Call and Join into More, as the CSS decides it: a phone under 360 px, or a header under 44 rem (48.5 rem from 1001 px). */
function useCallFolded(): boolean {
  const measure = () => {
    const main = document.querySelector('.app__main');
    if (!main) return false;
    if (document.querySelector('header.phead')) return window.innerWidth <= 359;
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    return main.clientWidth / rem <= (window.innerWidth >= 1001 ? 48.5 : 44);
  };
  const [folded, setFolded] = useState(measure);
  useEffect(() => {
    const main = document.querySelector('.app__main');
    if (!main) return undefined;
    const update = () => setFolded(measure());
    update();
    const observer = new ResizeObserver(update);
    observer.observe(main);
    return () => observer.disconnect();
  }, []);
  return folded;
}

/**
 * The sessions of this space that are not at the place the person is (and none while they are in one) and are not empty: a call stays
 * joinable for a while after everyone left it, and is not "live now" then. Also whether a call is here to join.
 */
function useElsewhere() {
  const live = useLive();
  const here = useLiveHere();
  const shell = useProjectShell();
  const { items } = useProjectSessions(shell?.project.id, live.capability === 'configured');
  const inSession = live.phase === 'in' || live.phase === 'joining' || live.phase === 'rejoining' || live.phase === 'starting';
  const joinable = !inSession && sessionAt(items, here.anchor)?.state === 'available';
  const others = inSession ? [] : items.filter((item) => !sameContext(item.context, here.anchor?.context) && (item.participants === null || item.participants.length > 0));
  const people = shell?.people;
  const nameOf = (id: string) => people?.find((person) => person.id === id)?.name ?? live.nameOf(id);
  return { live, others, joinable, nameOf };
}

const placeLabels = new Map<string, string>();
const labelKey = (session: LiveSession) => `${session.projectId}:${session.context.type}:${session.context.id}`;

/** The place's title, read once and kept: More opens with its rows already named, so none appears above the one focused (#873). */
function useWarmLabel(session: LiveSession): string | null {
  const key = labelKey(session);
  const [label, setLabel] = useState<string | null>(placeLabels.get(key) ?? null);
  useEffect(() => {
    const controller = new AbortController();
    anchorLabel(session.projectId, session.context, controller.signal).then((title) => { if (title) { placeLabels.set(key, title); setLabel(title); } }, () => undefined);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return label;
}

/**
 * A call elsewhere in the space (#873): one row each in More to join it, with where it is and who is in it, so the header's row never grows
 * when one starts and nothing in it moves. Starting a call here stays Call's one click.
 */
export function LiveNowRows() {
  const { others, nameOf } = useElsewhere();
  return <>{others.map((session) => <LiveNowRow key={session.id} session={session} nameOf={nameOf} />)}</>;
}

function LiveNowRow({ session, nameOf }: { session: LiveSession; nameOf: (id: string) => string }) {
  const live = useLive();
  const label = useWarmLabel(session);
  // The row is there from the first frame (the place's title may be a moment behind): it never appears above a row that has focus.
  const place = label ? `“${label}”` : `the ${KIND_WORD[session.context.type]}`;
  const who = session.participants === null ? 'presence unknown' : namesLine(session.participants.map((p) => p.userId), nameOf, live.meId);
  return (
    <button type="button" role="menuitem" className="newmenu__item lv-now" data-more-row
      onClick={() => void live.join(session, { projectId: session.projectId, context: session.context, label: label ?? KIND_WORD[session.context.type] })}>
      <LiveDot on /><span className="lv-now__t">Join {place} · {who}</span><span className="ui-vh">, live now in this space</span>
    </button>
  );
}

/**
 * The live mark on More while a call is live in the space and the header has no room for its own Join (#873), and its words, which
 * More's name carries (`id`): "More live now in this space". They avoid "call" and "join", so a name match on Call or Join in the row
 * never lands on More. The rows are in More; this warms the places' titles for them.
 */
export function LiveCue({ id, buttonId }: { id: string; buttonId: string }) {
  const { others, joinable } = useElsewhere();
  const folded = useCallFolded();
  const shown = others.length > 0 || (joinable && folded);
  useEffect(() => {
    const button = document.getElementById(buttonId);
    if (!shown || !button) return undefined;
    button.setAttribute('aria-labelledby', `${buttonId} ${id}`);
    return () => button.removeAttribute('aria-labelledby');
  }, [shown, buttonId, id]);
  if (!shown) return null;
  return (
    <span className="top__live-cue" id={id}>
      <LiveDot on />
      <span className="ui-vh">{others.length ? 'live now in this space' : 'live session here'}</span>
      {others.map((session) => <LabelWarm key={session.id} session={session} />)}
    </span>
  );
}

function LabelWarm({ session }: { session: LiveSession }) {
  useWarmLabel(session);
  return null;
}
