import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Avatar, Button, Icon, IconButton, MEDIA, Sheet, Spinner, useMediaQuery } from '../ui';
import { anchorPath, KIND_WORD } from './anchors';
import { useLive, useLiveHere, type LiveValue } from './LiveProvider';
import { canPublishScreen, type MediaPerson } from './media';
import { DeviceButton } from './DeviceButton';
import { LivePanel } from './LivePanel';
import { Popover } from './Popover';
import { namesLine } from './LiveEntry';

function Face({ person, name }: { person: MediaPerson; name: string }) {
  return (
    <span className={`lv-face${person.speaking ? ' is-speaking' : ''}${person.quality === 'poor' || person.quality === 'lost' ? ' is-weak' : ''}`}>
      <Avatar name={name} size="sm" tone={person.local ? 'me' : 'neutral'} />
      {!person.mic ? <span className="lv-face__muted" aria-hidden="true"><Icon name="mic-off" size={9} /></span> : null}
    </span>
  );
}

/**
 * The compact live strip (#59 §2) between the view tabs and the work. It stays in the
 * document flow, so it never covers the composer, result actions or the edited material.
 * One row of controls, and one quiet line for what someone shows; the rest is in “More”.
 */
export function LiveBar() {
  const live = useLive();
  const { presentable } = useLiveHere();
  const navigate = useNavigate();
  const phone = useMediaQuery(MEDIA.phone);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [showBusy, setShowBusy] = useState(false);

  // An invitation you opened: one card, three calm answers.
  if (live.phase === 'idle' && live.invitation) {
    const invitation = live.invitation;
    return (
      <section className="lv-bar lv-bar--invite" aria-label="Invitation to work together">
        <div className="lv-row">
          <span className="lv-row__lead"><Avatar name={live.nameOf(invitation.inviterId)} size="sm" /></span>
          <p className="lv-row__text"><b>{live.nameOf(invitation.inviterId)}</b> asked you to work together on <b>“{invitation.anchor.label}”</b>
            <span className="lv-row__muted"> · {KIND_WORD[invitation.anchor.context.type]}, microphone and camera stay off</span></p>
          <span className="lv-row__acts">
            <Button variant="primary" onClick={() => void live.answerInvitation('join')}>Join</Button>
            <Button variant="quiet" onClick={() => void live.answerInvitation('later')}>Later</Button>
            <Button variant="quiet" icon="chat" onClick={() => void live.answerInvitation('text')}>Reply in text</Button>
          </span>
        </div>
      </section>
    );
  }

  if (live.phase === 'ended' && live.notice) {
    return (
      <section className="lv-bar lv-bar--ended" aria-label="Live session">
        <div className="lv-row" role="status">
          <span className="lv-row__lead"><Icon name="together" size={16} /></span>
          <p className="lv-row__text">{live.notice}</p>
          <span className="lv-row__acts"><Button variant="quiet" onClick={live.dismissNotice}>Dismiss</Button></span>
        </div>
      </section>
    );
  }

  if (live.phase === 'idle' || live.phase === 'ended' || !live.anchor) return null;

  const media = live.media;
  const people = media?.people ?? [];
  const connecting = live.phase === 'starting' || live.phase === 'joining';
  const reconnecting = live.phase === 'rejoining' || media?.connection === 'reconnecting';
  const others = people.filter((person) => !person.local);
  const screens = people.filter((person) => person.screen && !person.local);
  const cameras = people.filter((person) => person.camera);
  const me = people.find((person) => person.local);
  const soundBlocked = !!media && media.connection === 'connected' && !media.canPlayAudio && !live.quiet && others.some((person) => person.mic);
  const shown = live.shown;
  const followingName = live.following ? live.nameOf(live.following) : null;
  const where = live.anchor;
  const status = connecting ? 'Connecting…' : reconnecting ? 'Reconnecting…' : live.quiet ? 'Quiet' : 'Live';

  const showThis = async () => {
    if (!presentable || showBusy) return;
    setShowBusy(true);
    try { await live.present(presentable); } finally { setShowBusy(false); }
  };

  const faces = (
    <span className="lv-faces lv-faces--room" aria-label={`In the session: ${namesLine(people.map((p) => p.userId), live.nameOf, live.meId)}`}>
      {people.slice(0, phone ? 3 : 5).map((person) => <Face key={person.userId} person={person} name={person.local ? live.nameOf(live.meId) : live.nameOf(person.userId)} />)}
      {people.length > (phone ? 3 : 5) ? <span className="lv-face lv-face--more">+{people.length - (phone ? 3 : 5)}</span> : null}
    </span>
  );

  const panel = <LivePanel live={live} presentable={presentable} onShow={() => { setMoreOpen(false); void showThis(); }} onClose={() => setMoreOpen(false)} />;

  return (
    <section className={`lv-bar${live.quiet ? ' is-quiet' : ''}${reconnecting ? ' is-reconnecting' : ''}`} aria-label="Live session">
      <div className="lv-row">
        <span className="lv-row__lead" role="status" aria-live="polite">
          {connecting || reconnecting ? <Spinner /> : <span className={`lv-dot${live.quiet ? '' : ' lv-dot--on'}`} aria-hidden="true" />}
          <span className="lv-status">{status}</span>
        </span>
        <button type="button" className="lv-where" onClick={() => navigate(anchorPath(where), { state: { liveFollow: true } })}
          title={`Back to “${where.label}”`}>
          <span className="lv-where__t">{where.label}</span>
          <span className="lv-where__k">{KIND_WORD[where.context.type]}</span>
        </button>
        {!phone ? faces : null}
        <span className="lv-row__acts">
          {live.quiet ? (
            <Button variant="secondary" icon="hearing" onClick={() => live.setQuiet(false)}>Return</Button>
          ) : (
            <>
              {soundBlocked ? <Button variant="secondary" icon="hearing" onClick={() => void live.startAudio()}>Turn on sound</Button> : null}
              {!phone && presentable ? (
                <Button variant="quiet" icon="show" busy={showBusy} onClick={() => void showThis()} aria-disabled={live.phase !== 'in' || undefined}
                  data-tip={`Show “${presentable.label}” to everyone here`}>Show this</Button>
              ) : null}
              {!phone && screens.length ? (
                <Button variant="quiet" icon="screen" aria-pressed={live.stage.open} onClick={() => (live.stage.open ? live.closeStage() : live.openStage(screens[0]!.userId))}>
                  {screens.length === 1 ? `${live.nameOf(screens[0]!.userId).split(' ')[0]}’s screen` : `${screens.length} screens`}
                </Button>
              ) : !phone && cameras.length && !screens.length ? (
                <Button variant="quiet" icon="video" aria-pressed={live.stage.open} onClick={() => (live.stage.open ? live.closeStage() : live.openStage(null))}>Cameras</Button>
              ) : null}
              <DeviceButton kind="mic" live={live} />
              {!phone ? <DeviceButton kind="camera" live={live} /> : null}
              {!phone && canPublishScreen() ? <DeviceButton kind="screen" live={live} /> : null}
            </>
          )}
          <IconButton ref={moreRef} icon="more" label="Session details and more" aria-expanded={moreOpen} aria-haspopup="dialog" onClick={() => setMoreOpen((open) => !open)} />
          <Button variant="danger" icon={phone ? undefined : 'leave'} className="lv-leave" onClick={() => void live.leave()}>Leave</Button>
        </span>
      </div>

      {me?.screen ? (
        <div className="lv-line lv-line--sharing" role="status">
          <span className="lv-dot lv-dot--share" aria-hidden="true" />
          <span className="lv-line__text">You are sharing your screen. Everyone in the session can see it.</span>
          <Button variant="quiet" onClick={() => void live.setDevice('screen', false)}>Stop sharing</Button>
        </div>
      ) : null}
      {phone && (screens.length || cameras.length) ? (
        <div className="lv-line">
          <Icon name={screens.length ? 'screen' : 'video'} size={14} />
          <span className="lv-line__text">{screens.length ? `${namesLine(screens.map((p) => p.userId), live.nameOf, live.meId)} ${screens.length === 1 ? 'is' : 'are'} sharing a screen` : 'Cameras are on'}</span>
          <Button variant="quiet" onClick={() => live.openStage(screens[0]?.userId ?? null)}>View</Button>
        </div>
      ) : null}
      {shown && (shown.fresh || live.following) ? (
        <ShownLine live={live} />
      ) : null}
      {followingName && !(shown && shown.fresh) ? (
        <div className="lv-line" role="status">
          <Icon name="follow" size={14} />
          <span className="lv-line__text">Following {followingName}: you’ll open what they show. Moving on your own stops it.</span>
          <Button variant="quiet" onClick={() => live.follow(null)}>Stop following</Button>
        </div>
      ) : null}

      {phone ? (
        <Sheet open={moreOpen} onClose={() => setMoreOpen(false)} label="Live session" className="lv-sheet">{panel}</Sheet>
      ) : (
        <Popover open={moreOpen} onClose={() => setMoreOpen(false)} anchorRef={moreRef} label="Live session" className="lv-pop--panel">{panel}</Popover>
      )}
    </section>
  );
}

function ShownLine({ live }: { live: LiveValue }) {
  const shown = live.shown!;
  const mine = shown.presentation.createdBy === live.meId;
  const who = live.nameOf(shown.presentation.createdBy);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Arrives calmly: a short fade and rise, no sound and no focus change.
    ref.current?.animate?.([{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dur-2')) || 0, easing: 'ease-out' });
  }, [shown.presentation.id]);
  const following = live.following === shown.presentation.createdBy;
  return (
    <div ref={ref} className="lv-line lv-line--shown" role="status" aria-live="polite">
      <Icon name="show" size={14} />
      <span className="lv-line__text">
        {mine ? 'You are showing ' : `${who} is showing `}<b>“{shown.fragment.label}”</b><span className="lv-row__muted"> · {shown.fragment.what}</span>
      </span>
      {!mine && shown.fragment.path ? (
        <span className="lv-line__acts">
          <Button variant="secondary" onClick={() => live.view(shown)}>View</Button>
          {following
            ? <Button variant="quiet" onClick={() => live.follow(null)}>Stop following</Button>
            : <Button variant="quiet" icon="follow" onClick={() => live.follow(shown.presentation.createdBy)}>Follow {who.split(' ')[0]}</Button>}
        </span>
      ) : null}
    </div>
  );
}
