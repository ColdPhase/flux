import { useEffect, useId, useRef, useState } from 'react';
import type { LiveSession, ProjectPerson } from '@flux/contracts';
import { Avatar, Button, Icon, useLoopPause } from '../ui';
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
export function LiveEntry({ variant = 'header', anchor: given }: { variant?: 'header' | 'inline'; anchor?: LiveAnchor | null }) {
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

  if (!anchor || live.capability === 'loading') return null;
  const inSession = live.phase === 'in' || live.phase === 'joining' || live.phase === 'rejoining' || live.phase === 'starting';
  const busy = live.phase === 'starting' || live.phase === 'joining';
  const here_ = sessionAt(items, anchor);
  const others = items.filter((item) => !sameContext(item.context, anchor.context));
  const word = KIND_WORD[anchor.context.type];
  const audience = audienceOf(projectPeople, live.meId);

  if (!configured) {
    // Explained once, behind the header's "Together" (#189): a task does not repeat it.
    if (variant === 'inline') return null;
    return (
      <span className="lv-entry">
        <Button ref={buttonRef} variant="quiet" icon="together" className="lv-entry__btn" aria-expanded={open} aria-haspopup="dialog" aria-label="Together" onClick={() => setOpen((v) => !v)}>
          <span className="lv-entry__label">Together</span>
        </Button>
        <Popover open={open} onClose={() => setOpen(false)} anchorRef={buttonRef} label="Live sessions" className="lv-pop--narrow">
          <p className="lv-pop__title">Live sessions are not available here</p>
          <p className="lv-pop__text">This Flux server has no media server configured, so voice, camera and screen sharing are off for everyone. Conversations, tasks, maps and docs work as usual.</p>
        </Popover>
      </span>
    );
  }

  if (inSession) {
    if (live.session && sameContext(live.session.context, anchor.context))
      return variant === 'inline' ? <p className="lv-inline-note lv-inline-note--on"><span className="lv-dot" aria-hidden="true" />You are in the live session for this {word}.</p> : null;
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
      {others.length && !joinable ? (
        <>
          <Button ref={buttonRef} variant="quiet" className="lv-entry__live" aria-expanded={open} aria-haspopup="dialog" aria-label={`Live now, ${others.length} ${others.length === 1 ? 'session' : 'sessions'} in this project`} onClick={() => setOpen((v) => !v)}>
            <span className="lv-dot" aria-hidden="true" /><span className="lv-entry__label">Live now</span><span className="ui-vh">, {others.length} {others.length === 1 ? 'session' : 'sessions'} in this project</span>
          </Button>
          <Popover open={open} onClose={() => setOpen(false)} anchorRef={buttonRef} label="Live in this project">
            <p className="lv-pop__title">Live in this project</p>
            <ul className="lv-pop__list">
              {others.map((item) => <OtherSession key={item.id} session={item} nameOf={nameOf} meId={live.meId} onJoin={(resolved) => { setOpen(false); void live.join(item, resolved); }} />)}
            </ul>
            <div className="lv-pop__foot">
              <Button variant="secondary" icon="together" onClick={() => { setOpen(false); act(); }} data-autofocus>Work on this {word} together</Button>
              <p className="lv-pop__text">{audience}. Nothing turns on until you choose.</p>
            </div>
          </Popover>
        </>
      ) : null}
      <Button variant={joinable ? 'primary' : 'quiet'} icon={joinable ? undefined : 'together'} busy={busy} className={`lv-entry__btn${joinable ? ' lv-entry__btn--join' : ''}`}
        onClick={act} data-tip={joinable ? 'Join with microphone and camera off' : `${audience}. Nothing turns on until you choose.`} aria-describedby={noteId}
        aria-label={joinable ? 'Join' : 'Together'}>
        {joinable ? <LiveDot on /> : null}
        {joinable && present.length ? <span className="lv-faces" aria-hidden="true">{present.slice(0, 3).map((id) => <Avatar key={id} name={live.fullName(id)} size="sm" />)}</span> : null}
        <span className="lv-entry__label">{joinable ? 'Join' : 'Together'}</span>
      </Button>
      <span id={noteId} className="ui-vh">{joinable ? `${label}. Microphone and camera stay off.` : `Work on this ${word} together. ${audience}. Nothing turns on until you choose.`}</span>
    </span>
  );
}

function OtherSession({ session, nameOf, meId, onJoin }: { session: LiveSession; nameOf: (id: string) => string; meId: string; onJoin: (anchor: LiveAnchor) => void }) {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    anchorLabel(session.projectId, session.context, controller.signal).then(setLabel, () => undefined);
    return () => controller.abort();
  }, [session.projectId, session.context]);
  if (label === null) return null;
  const present = (session.participants ?? []).map((p) => p.userId);
  return (
    <li className="lv-pop__item">
      <span className="lv-pop__what"><Icon name={session.context.type === 'work' ? 'tasks' : session.context.type === 'sketch' ? 'map' : session.context.type === 'doc' ? 'doc' : 'chat'} size={14} />
        <span><b>{label}</b><span>{session.participants === null ? 'Presence unknown' : namesLine(present, nameOf, meId)}</span></span></span>
      <Button variant="secondary" onClick={() => onJoin({ projectId: session.projectId, context: session.context, label })}>Join</Button>
    </li>
  );
}
