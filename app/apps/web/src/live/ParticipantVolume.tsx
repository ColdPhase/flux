import { useRef, useState, type ReactNode } from 'react';
import '../app/settings.css';
import { Button, Icon, Slider } from '../ui';
import { SwitchRow } from '../ui/SwitchRow';
import { personSound } from './audio-prefs';
import { useAudioSnapshot } from './audio-settings-state';
import type { CallAudio } from './call-audio';
import type { LiveValue } from './LiveProvider';
import type { MediaPerson } from './media';
import { Popover } from './Popover';
import './audio-settings.css';

/**
 * One person's sound for me (#1244): their volume and Mute for me. Both are local to this browser; nobody is told and nobody
 * else's sound changes. Where the browser cannot set the media volume (iOS) only Mute for me is offered.
 */
function PersonSoundBody({ audio, userId, name }: { audio: CallAudio; userId: string; name: string | null }) {
  const snap = useAudioSnapshot(audio);
  if (!snap) return null;
  const sound = personSound(snap.prefs, userId);
  return (
    <div className="lv-person-sound">
      {name ? <p className="lv-person-sound__name">{name}</p> : null}
      {snap.support.outputVolume ? (
        <Slider label="Volume" labelWidth="4.5rem" max={snap.boost ? 200 : 100} value={Math.min(sound.volume, snap.boost ? 200 : 100)}
          onChange={(value) => audio.setPerson(userId, { volume: value })} />
      ) : null}
      <SwitchRow label="Mute for me" checked={sound.muted} onChange={(on) => audio.setPerson(userId, { muted: on })} />
      <p className="lv-person-sound__note">Only you hear this change.</p>
    </div>
  );
}

/**
 * A remote person's face in the strip becomes a button that opens their sound; your own face and a call without sound settings
 * are shown as they were. A person muted for you shows the quiet mark in place of the microphone's.
 */
export function FaceSound({ live, person, children }: { live: LiveValue; person: MediaPerson; children: ReactNode }) {
  const audio = live.audio;
  const snap = useAudioSnapshot(audio);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  if (person.local || !audio || !snap) return <>{children}</>;
  const name = live.fullName(person.userId);
  const muted = personSound(snap.prefs, person.userId).muted;
  return (
    <span className="lv-facesound">
      <button ref={button} type="button" className="lv-facesound__btn" aria-haspopup="dialog" aria-expanded={open}
        aria-label={`Sound from ${name}${muted ? ', muted for you' : ''}`} data-tip={`Sound from ${name}`} onClick={() => setOpen((value) => !value)}>
        {children}
        {muted ? <span className="lv-face__muted lv-face__quiet" aria-hidden="true"><Icon name="quiet" size={9} /></span> : null}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={button} align="start" label={`Sound from ${name}`} className="lv-pop--person">
        <PersonSoundBody audio={audio} userId={person.userId} name={name} />
      </Popover>
    </span>
  );
}

/** The same two rows under a person in ⋯ › Here now, behind a quiet Volume button, so every device reaches them. */
export function PersonSound({ live, person }: { live: LiveValue; person: MediaPerson }) {
  const audio = live.audio;
  const snap = useAudioSnapshot(audio);
  const [open, setOpen] = useState(false);
  if (person.local || !audio || !snap) return null;
  const muted = personSound(snap.prefs, person.userId).muted;
  const name = live.fullName(person.userId);
  return (
    <>
      <Button variant="quiet" icon={muted ? 'quiet' : 'hearing'} aria-expanded={open} aria-label={`Sound from ${name}${muted ? ', muted for you' : ''}`}
        onClick={() => setOpen((value) => !value)}>{muted ? 'Muted' : 'Volume'}</Button>
      {open ? <div className="lv-person__sound"><PersonSoundBody audio={audio} userId={person.userId} name={null} /></div> : null}
    </>
  );
}
