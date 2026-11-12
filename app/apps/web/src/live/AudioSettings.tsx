import { useEffect, useId, useRef, useState } from 'react';
import '../app/settings.css';
import { Button, Icon, IconButton, MEDIA, Option, Select, Sheet, Slider, useMediaQuery, useStripOnlyModal, useToast } from '../ui';
import { SwitchRow } from '../ui/SwitchRow';
import { closeAudioSettings, openAudioSettings, toggleAudioSettings, useAudioSettingsOpen, useAudioSnapshot } from './audio-settings-state';
import { meterWord } from './audio-prefs';
import type { CallAudio, MeterState } from './call-audio';
import { DeviceButton } from './DeviceButton';
import type { LiveValue } from './LiveProvider';
import { Popover } from './Popover';
import './audio-settings.css';

/** Words for a meter that is not running; "Speaking" and "Quiet" come from the level itself. */
const METER_WORDS: Partial<Record<MeterState, string>> = {
  idle: 'Starting…',
  starting: 'Starting…',
  blocked: 'The browser blocks the microphone. Allow it in the site settings.',
  none: 'No microphone was found on this device.',
  unavailable: 'The level meter is not available in this browser.',
};

/** The input level: a bar that follows the voice, and one word that is its text alternative. */
function Meter({ audio, state, sending }: { audio: CallAudio; state: MeterState; sending: boolean }) {
  const fill = useRef<HTMLSpanElement>(null);
  const [word, setWord] = useState<'Speaking' | 'Quiet'>('Quiet');
  useEffect(() => {
    if (state !== 'live') return undefined;
    let frame = 0;
    let loudAt = -Infinity;
    let shown: 'Speaking' | 'Quiet' = 'Quiet';
    const tick = (now: number) => {
      const level = audio.level();
      fill.current?.style.setProperty('--level', level.toFixed(3));
      if (meterWord(level) === 'Speaking') loudAt = now;
      // Speaking holds for a moment, so the word does not flicker between syllables.
      const next = now - loudAt < 700 ? 'Speaking' : 'Quiet';
      if (next !== shown) { shown = next; setWord(next); }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frame); setWord('Quiet'); };
  }, [audio, state]);

  if (state === 'ask') {
    return (
      <div className="lv-meter lv-meter--ask">
        <Button variant="secondary" icon="mic" onClick={() => void audio.testMicrophone()}>Test microphone</Button>
        <span className="lv-meter__note">Only you hear this check. Nothing is sent.</span>
      </div>
    );
  }
  if (state !== 'live') return <p className="lv-meter__note" role="status">{METER_WORDS[state] ?? ''}</p>;
  return (
    <div className="lv-meter">
      <span className="lv-meter__row">
        <span className="lv-meter__track" role="img" aria-label={`Microphone level: ${word}`}><span ref={fill} className="lv-meter__fill" /></span>
        <span className="lv-meter__word" aria-hidden="true">{word}</span>
      </span>
      {!sending ? <span className="lv-meter__note">Only you hear this check. Nothing is sent.</span> : null}
    </div>
  );
}

/**
 * Microphone and speakers of the call (#1244), in a popover under the strip or a sheet. Everything here is this person's own and
 * local: nothing is sent to anyone, and the meter listens only while this is open.
 */
export function AudioPanel({ live, onClose }: { live: LiveValue; onClose(): void }) {
  const audio = live.audio;
  const snap = useAudioSnapshot(audio);
  const micId = useId();
  const outId = useId();
  const sending = !!live.media?.people.find((person) => person.local)?.mic;
  useEffect(() => {
    void audio?.startMeter();
    return () => audio?.stopMeter();
  }, [audio]);
  if (!audio || !snap) return null;
  const { support, prefs } = snap;
  const switches = support.noiseSuppression || support.echoCancellation || support.autoGain;

  return (
    <div className="lv-panel lv-audio">
      <header className="lv-panel__head">
        <IconButton icon="x" label="Close audio settings" onClick={onClose} className="lv-panel__close" />
        <h2 className="lv-panel__t">Audio</h2>
      </header>
      {snap.notice ? <p className="lv-audio__notice" role="status"><Icon name="alert" size={14} />{snap.notice}</p> : null}

      <section className="lv-panel__sec" aria-labelledby={micId}>
        <h3 id={micId}>Microphone</h3>
        <Select aria-label="Microphone" className="lv-audio__select" value={snap.inputId} onChange={(id) => void audio.setMicDevice(id)} data-autofocus>
          {snap.inputs.map((device) => <Option key={device.id} value={device.id}>{device.label}</Option>)}
        </Select>
        <Meter audio={audio} state={snap.meter} sending={sending} />
        {support.gain ? <Slider label="Microphone volume" value={prefs.micVolume} onChange={(value) => void audio.setMicVolume(value)} /> : null}
        {switches ? (
          <div className="lv-audio__switches">
            {support.noiseSuppression ? <SwitchRow label="Reduce background noise" checked={prefs.noiseSuppression} onChange={(on) => void audio.setSwitch('noiseSuppression', on)} /> : null}
            {support.echoCancellation ? <SwitchRow label="Cancel echo" checked={prefs.echoCancellation} onChange={(on) => void audio.setSwitch('echoCancellation', on)} /> : null}
            {support.autoGain ? <SwitchRow label="Even out my volume" checked={prefs.autoGain} onChange={(on) => void audio.setSwitch('autoGain', on)} /> : null}
          </div>
        ) : null}
      </section>

      <section className="lv-panel__sec" aria-labelledby={outId}>
        <h3 id={outId}>Speakers or headphones</h3>
        <div className="lv-audio__out">
          {support.chooseOutput ? (
            snap.askOutput
              ? <Button variant="secondary" onClick={() => void audio.chooseOutputWithBrowser()}>Choose speakers or headphones</Button>
              : (
                <Select aria-label="Speakers or headphones" className="lv-audio__select" value={snap.outputId} onChange={(id) => void audio.setSpeaker(id)}>
                  {snap.outputs.map((device) => <Option key={device.id} value={device.id}>{device.label}</Option>)}
                </Select>
              )
          ) : null}
          <Button variant="quiet" icon="hearing" aria-disabled={snap.testing || undefined} onClick={() => void audio.testSound()}>{snap.testing ? 'Playing…' : 'Test sound'}</Button>
        </div>
        {support.outputVolume ? (
          <Slider label="Everything you hear" max={100} value={prefs.masterVolume} onChange={(value) => audio.setMaster(value)} />
        ) : null}
        {!support.chooseOutput || !support.outputVolume ? (
          <p className="lv-help">
            <Icon name="hearing" size={14} />
            <span>{support.outputVolume ? 'This browser plays sound through the output chosen in your system settings.' : 'Use your phone’s volume buttons.'}</span>
          </p>
        ) : null}
      </section>
    </div>
  );
}

/**
 * The strip's microphone: its button, and on a computer a small arrow that opens Audio settings. The settings are a popover under
 * the strip, or a sheet where the strip's popovers cannot reach (a phone, or a thread sheet covering the work).
 */
export function MicControl({ live }: { live: LiveValue }) {
  const phone = useMediaQuery(MEDIA.phone);
  const stripOnly = useStripOnlyModal();
  const open = useAudioSettingsOpen();
  const snap = useAudioSnapshot(live.audio);
  const toast = useToast();
  const arrow = useRef<HTMLButtonElement>(null);
  const [as, setAs] = useState<'sheet' | 'popover'>('popover');
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setAs(phone || stripOnly ? 'sheet' : 'popover');
  }
  // A popover would sit under a thread sheet's frame: it closes when one opens (the strip's other popover does the same).
  useEffect(() => { if (open && as === 'popover' && stripOnly && !phone) closeAudioSettings(); }, [open, as, stripOnly, phone]);
  // Closed with the strip's devices (Quiet, leaving): nothing stays open for the next call.
  useEffect(() => () => closeAudioSettings(), []);
  // A device that disappeared says so once, however the settings are closed.
  const seen = useRef(snap?.alert?.id ?? 0);
  const alertId = snap?.alert?.id ?? 0;
  const alertMessage = snap?.alert?.message;
  useEffect(() => {
    if (alertId > seen.current && alertMessage) toast({ message: alertMessage });
    seen.current = alertId;
  }, [alertId, alertMessage, toast]);

  const panel = <AudioPanel live={live} onClose={closeAudioSettings} />;
  return (
    <>
      <DeviceButton kind="mic" live={live} />
      {!phone && live.audio ? (
        <IconButton ref={arrow} icon="chevron-down" size={12} label="Audio settings" className="lv-mic__more" aria-haspopup="dialog" aria-expanded={open}
          onClick={toggleAudioSettings} />
      ) : null}
      {live.audio ? (
        as === 'sheet'
          ? <Sheet open={open} onClose={closeAudioSettings} label="Audio settings" className="lv-sheet">{panel}</Sheet>
          : <Popover open={open} onClose={closeAudioSettings} anchorRef={arrow} label="Audio settings" className="lv-pop--audio">{panel}</Popover>
      ) : null}
    </>
  );
}

/** ⋯'s row: the same settings from every device, including the phone, which has no arrow beside its microphone. */
export function AudioSettingsRow({ onOpen }: { onOpen(): void }) {
  return (
    <button type="button" className="lv-audio-row" aria-haspopup="dialog" onClick={() => { onOpen(); openAudioSettings(); }}>
      <Icon name="hearing" size={16} />
      <span className="lv-audio-row__b"><b>Audio settings</b><span>Microphone, speakers and volumes</span></span>
      <Icon name="chevron-right" size={14} />
    </button>
  );
}
