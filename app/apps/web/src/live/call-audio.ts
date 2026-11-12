import { createLocalAudioTrack, TrackEvent, type AudioCaptureOptions, type LocalAudioTrack, type Room } from 'livekit-client';
import {
  MAX_MASTER, MAX_VOLUME, clampVolume, meterLevel, missingDeviceNote, readPrefs, resolveDevice, withPerson, writePrefs,
  type AudioPrefs, type DeviceChoice, type PersonSound,
} from './audio-prefs.js';
import { GainProcessor, LevelTap } from './mic-gain.js';
import { Playback } from './playback.js';

/**
 * Sound settings of a call (#1244), all local to this browser: which microphone and speakers, how loud the microphone is and how
 * loud each voice plays, the browser's noise, echo and gain handling, a level meter and a test sound. It is the only module that
 * changes capture or playback for them; the interface reads a plain snapshot and calls a few verbs, like `LiveMediaConnection`.
 * Devices still open only from a person's own action: the meter listens only while the settings are open and never sends.
 */

export type MeterState = 'idle' | 'starting' | 'live' | 'ask' | 'blocked' | 'none' | 'unavailable';

export interface AudioSupport {
  /** `setSinkId` exists and the platform lets the page choose where sound plays. */
  chooseOutput: boolean;
  /** The page can set the media volume (not on iOS: the hardware buttons own it). */
  outputVolume: boolean;
  /** Firefox lists output devices only after the person allows them (`selectAudioOutput`). */
  selectOutput: boolean;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGain: boolean;
  /** Web Audio is there: microphone volume and a voice above 100 %. */
  gain: boolean;
}

export interface AudioSnapshot {
  prefs: AudioPrefs;
  inputs: DeviceChoice[];
  outputs: DeviceChoice[];
  /** What the two selects show: a device id, or `default`. */
  inputId: string;
  outputId: string;
  support: AudioSupport;
  /** The speakers' list needs the browser's own permission first. */
  askOutput: boolean;
  /** A voice may go above 100 %: false where a boosted voice could not reach the chosen speakers. */
  boost: boolean;
  /** A calm sentence to keep in view while the settings are open. */
  notice: string | null;
  /** The newest one-time message (a toast); its id changes with each. */
  alert: { id: number; message: string } | null;
  meter: MeterState;
  testing: boolean;
}

export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function volumeSettable(): boolean {
  try {
    const probe = new Audio();
    probe.volume = 0.5;
    return probe.volume === 0.5;
  } catch { return false; }
}

/** Asked of the browser, not read from a table; the table with dates is in docs/product/live-collaboration.md. */
export function detectSupport(): AudioSupport {
  const devices = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  const constraints = devices?.getSupportedConstraints?.() ?? {};
  const ios = isIOS();
  return {
    chooseOutput: typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype && !ios,
    outputVolume: !ios && typeof Audio !== 'undefined' && volumeSettable(),
    selectOutput: !!devices && 'selectAudioOutput' in devices,
    noiseSuppression: !!constraints.noiseSuppression,
    echoCancellation: !!constraints.echoCancellation,
    autoGain: !!constraints.autoGainControl,
    gain: typeof AudioContext !== 'undefined',
  };
}

type SinkContext = AudioContext & { setSinkId?(id: string): Promise<void> };

function storage(): Storage | null {
  try { return localStorage; } catch { return null; }
}

async function micPermission(): Promise<'granted' | 'denied' | 'ask'> {
  try {
    const status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
    return status.state === 'granted' ? 'granted' : status.state === 'denied' ? 'denied' : 'ask';
  } catch { return 'ask'; }
}

const errorName = (error: unknown) => (error instanceof DOMException || error instanceof Error ? error.name : '');

/** The real devices of a kind: usable ids only, and no "communications" duplicate of the default. */
function realDevices(list: MediaDeviceInfo[], kind: MediaDeviceKind): DeviceChoice[] {
  return list.filter((device) => device.kind === kind && device.deviceId !== '' && device.deviceId !== 'communications')
    .map((device) => ({ id: device.deviceId, label: device.label }));
}

/** What a select lists: the default first, then each device under its name, or "Microphone 2" while the browser hides names. */
function listed(real: DeviceChoice[], word: string): DeviceChoice[] {
  let count = 0;
  const named = real.map((device) => ({ id: device.id, label: device.label || `${word} ${++count}` }));
  const fallback = named.find((device) => device.id === 'default') ?? { id: 'default', label: 'Default' };
  return [fallback, ...named.filter((device) => device.id !== 'default')];
}

export class CallAudio {
  readonly playback: Playback;
  private readonly support = detectSupport();
  private prefs: AudioPrefs;
  private knownInputs: DeviceChoice[] = [];
  private knownOutputs: DeviceChoice[] = [];
  private notice: string | null = null;
  private alert: { id: number; message: string } | null = null;
  private meter: MeterState = 'idle';
  private testing = false;
  private context: SinkContext | null = null;
  private mic: LocalAudioTrack | null = null;
  private processor: GainProcessor | null = null;
  private tap: { tap: LevelTap; owner: 'published' | 'preview'; factor: () => number } | null = null;
  private preview: MediaStream | null = null;
  private meterWanted = false;
  private meterRun = 0;
  private snapshot: AudioSnapshot;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly room: Room, hearing: () => boolean) {
    this.prefs = readPrefs(storage());
    this.playback = new Playback({
      prefs: () => this.prefs,
      hearing,
      support: () => ({ volume: this.support.outputVolume }),
      limit: () => (this.canBoost() ? 2 : 1),
      context: () => this.runningNow(),
    });
    this.snapshot = this.build();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = () => this.snapshot;

  /** How loud the capture is now, 0 to 1, for the meter. Reading it changes nothing. */
  level(): number {
    return this.tap ? meterLevel(this.tap.tap.rms(), this.tap.factor() * 100) : 0;
  }

  // ---- Devices ----

  async refreshDevices(): Promise<void> {
    let list: MediaDeviceInfo[];
    try { list = await navigator.mediaDevices.enumerateDevices(); } catch { return; }
    this.knownInputs = realDevices(list, 'audioinput');
    this.knownOutputs = realDevices(list, 'audiooutput');
    // A remembered device that is no longer there: the default, and one calm sentence.
    const mic = resolveDevice(this.knownInputs, this.prefs.micId);
    if (mic.missing) {
      const label = this.prefs.micLabel;
      this.prefs = { ...this.prefs, micId: null, micLabel: null };
      this.save();
      this.say(missingDeviceNote('microphone', label));
    }
    const speaker = resolveDevice(this.knownOutputs, this.prefs.speakerId);
    if (speaker.missing) {
      const label = this.prefs.speakerLabel;
      this.prefs = { ...this.prefs, speakerId: null, speakerLabel: null };
      this.save();
      this.say(missingDeviceNote('speakers', label));
      await this.applySink(null);
    }
    this.emit();
  }

  /** A call starts (or starts again after a rejoin): the remembered speakers play from the first voice. */
  async joined(): Promise<void> {
    await this.refreshDevices();
    if (this.prefs.speakerId) await this.applySink(this.prefs.speakerId);
  }

  /** Options for capturing the microphone with what the person chose. A restart always names a device, or LiveKit drops the rest. */
  private captureOptions(restart = false): AudioCaptureOptions {
    const { micId, echoCancellation, noiseSuppression, autoGain } = this.prefs;
    const options: AudioCaptureOptions = { echoCancellation, noiseSuppression, autoGainControl: autoGain };
    if (micId) options.deviceId = { exact: micId };
    else if (restart) options.deviceId = 'default';
    return options;
  }

  /** Captures the microphone for publishing. A chosen device that cannot start falls back to the default one. */
  async captureMic(): Promise<LocalAudioTrack> {
    await this.refreshDevices();
    try { return await createLocalAudioTrack(this.captureOptions()); }
    catch (error) {
      if (!this.prefs.micId || !['OverconstrainedError', 'NotFoundError'].includes(errorName(error))) throw error;
      this.forgetMic('That microphone could not start. Flux uses the default microphone.');
      return createLocalAudioTrack(this.captureOptions());
    }
  }

  private forgetMic(message: string) {
    this.prefs = { ...this.prefs, micId: null, micLabel: null };
    this.save();
    this.say(message);
  }

  // ---- The published microphone ----

  /** The microphone is published: apply its volume and listen to it for the meter. Never throws. */
  async attachMic(track: LocalAudioTrack): Promise<void> {
    this.detachMic(false);
    this.mic = track;
    track.on(TrackEvent.Restarted, this.onMicChanged);
    track.on(TrackEvent.TrackProcessorUpdate, this.onMicChanged);
    await this.applyMicVolume();
    void this.refreshDevices();
    void this.syncMeter();
  }

  detachMic(sync = true) {
    const track = this.mic;
    if (track) { track.off(TrackEvent.Restarted, this.onMicChanged); track.off(TrackEvent.TrackProcessorUpdate, this.onMicChanged); }
    this.mic = null;
    this.processor = null;
    if (this.tap?.owner === 'published') this.closeTap();
    if (sync) void this.syncMeter();
  }

  private onMicChanged = () => { void this.syncMeter(); void this.refreshDevices(); };

  private async applyMicVolume(): Promise<void> {
    const track = this.mic;
    if (!track) return;
    const volume = this.prefs.micVolume;
    if (this.processor && track.getProcessor() === this.processor) { this.processor.setVolume(volume); return; }
    // At 100 % the capture goes out untouched: no processor, nothing between the microphone and the sender.
    if (volume === 100) return;
    const context = await this.runningContext();
    if (!context) { this.note('The microphone volume could not be applied here, so your microphone is sent as it is.'); return; }
    const processor = new GainProcessor(volume);
    try {
      await track.setAudioContext(context);
      await track.setProcessor(processor);
      this.processor = processor;
    } catch { this.note('The microphone volume could not be applied here, so your microphone is sent as it is.'); }
  }

  async setMicDevice(id: string): Promise<void> {
    const wanted = id === 'default' ? null : id;
    this.setPrefs({ ...this.prefs, micId: wanted, micLabel: wanted ? this.knownInputs.find((device) => device.id === wanted)?.label || null : null });
    if (this.mic) await this.restartMic(); else this.restartPreview();
  }

  async setMicVolume(percent: number): Promise<void> {
    this.setPrefs({ ...this.prefs, micVolume: clampVolume(percent, MAX_VOLUME) });
    await this.applyMicVolume();
  }

  /** The browser's noise suppression, echo cancellation or automatic gain: a running capture restarts with it. */
  async setSwitch(key: 'noiseSuppression' | 'echoCancellation' | 'autoGain', on: boolean): Promise<void> {
    this.setPrefs({ ...this.prefs, [key]: on });
    if (this.mic) await this.restartMic(); else this.restartPreview();
  }

  private async restartMic() {
    const track = this.mic;
    if (!track) return;
    try { await track.restartTrack(this.captureOptions(true)); return; } catch { /* the default device is tried next */ }
    this.forgetMic('That microphone could not start. Flux uses the default microphone.');
    try { await track.restartTrack(this.captureOptions(true)); } catch { /* the track's own ending tells the person */ }
  }

  // ---- Speakers or headphones and the volumes ----

  async setSpeaker(id: string): Promise<void> {
    const wanted = id === 'default' ? null : id;
    this.setPrefs({ ...this.prefs, speakerId: wanted, speakerLabel: wanted ? this.knownOutputs.find((device) => device.id === wanted)?.label || null : null });
    await this.applySink(wanted);
  }

  /** Firefox: the browser's own list asks for permission and names the device. */
  async chooseOutputWithBrowser(): Promise<void> {
    const devices = navigator.mediaDevices as MediaDevices & { selectAudioOutput?(options?: { deviceId?: string }): Promise<MediaDeviceInfo> };
    try {
      const device = await devices.selectAudioOutput?.();
      if (!device) return;
      await this.refreshDevices();
      this.setPrefs({ ...this.prefs, speakerId: device.deviceId, speakerLabel: device.label || null });
      await this.applySink(device.deviceId);
    } catch { /* cancelled or refused: the speakers stay as they were */ }
  }

  setMaster(percent: number) {
    this.setPrefs({ ...this.prefs, masterVolume: clampVolume(percent, MAX_MASTER) });
    this.playback.refresh();
  }

  setPerson(userId: string, patch: Partial<PersonSound>) {
    this.setPrefs(withPerson(this.prefs, userId, patch));
    this.playback.refresh();
  }

  /** Quiet and Return change every voice. */
  setHearing() { this.playback.refresh(); }

  private async applySink(id: string | null): Promise<void> {
    if (!this.support.chooseOutput) return;
    const target = id ?? 'default';
    try { await this.room.switchActiveDevice('audiooutput', target); }
    catch { this.note('The speakers could not be changed here. Sound plays through the default output.'); }
    // A boosted voice plays from the context's own output.
    await this.context?.setSinkId?.(target === 'default' ? '' : target).catch(() => undefined);
    this.playback.refresh();
    this.emit();
  }

  /** One short, soft tone through the chosen speakers at the chosen volume. */
  async testSound(): Promise<void> {
    if (this.testing) return;
    const context = await this.runningContext();
    if (!context) { this.note('A test sound could not be played in this browser.'); return; }
    this.testing = true;
    this.emit();
    const destination = context.createMediaStreamDestination();
    const element = new Audio();
    element.srcObject = destination.stream;
    if (this.support.outputVolume) element.volume = this.prefs.masterVolume / 100;
    const nodes: AudioNode[] = [destination];
    try {
      if (this.support.chooseOutput && this.prefs.speakerId) await (element as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(this.prefs.speakerId).catch(() => undefined);
      const start = context.currentTime + 0.02;
      [[523.25, 0], [783.99, 0.22]].forEach(([frequency, offset]) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.value = frequency!;
        gain.gain.setValueAtTime(0.0001, start + offset!);
        gain.gain.exponentialRampToValueAtTime(0.3, start + offset! + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + offset! + 0.4);
        oscillator.connect(gain).connect(destination);
        oscillator.start(start + offset!);
        oscillator.stop(start + offset! + 0.45);
        nodes.push(oscillator, gain);
      });
      await element.play();
    } catch { /* the tone could not play: the button simply comes back */ }
    setTimeout(() => {
      element.pause();
      element.srcObject = null;
      nodes.forEach((node) => node.disconnect());
      this.testing = false;
      this.emit();
    }, 950);
  }

  // ---- The level meter ----

  /** The settings are open: the meter reads the published microphone, or listens locally when the browser already allows it. */
  async startMeter(): Promise<void> {
    this.meterWanted = true;
    void this.refreshDevices();
    await this.syncMeter();
  }

  /** The settings closed (or the call ended): nothing keeps listening. */
  stopMeter() {
    this.meterWanted = false;
    this.meterRun++;
    this.closePreview();
    if (this.tap) this.closeTap();
    this.notice = null;
    this.meter = 'idle';
    this.emit();
  }

  /** A click on "Test microphone": this one may ask the browser for permission. */
  async testMicrophone(): Promise<void> {
    this.meterWanted = true;
    await this.openPreview(++this.meterRun);
  }

  private async syncMeter(): Promise<void> {
    if (!this.meterWanted) return;
    const run = ++this.meterRun;
    const track = this.mic?.mediaStreamTrack;
    if (track && track.readyState === 'live') {
      this.closePreview();
      await this.bindTap(track, 'published', () => 1, run);
      return;
    }
    if (this.tap?.owner === 'preview') return;
    const permission = await micPermission();
    if (run !== this.meterRun || !this.meterWanted) return;
    if (permission === 'granted') await this.openPreview(run);
    else this.setMeter(permission === 'denied' ? 'blocked' : 'ask');
  }

  private restartPreview() {
    if (!this.meterWanted || this.mic) return;
    this.closePreview();
    void this.syncMeter();
  }

  private async openPreview(run: number): Promise<void> {
    this.closePreview();
    this.setMeter('starting');
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: this.captureOptions() }); }
    catch (error) {
      if (run !== this.meterRun) return;
      this.setMeter(['NotFoundError', 'OverconstrainedError'].includes(errorName(error)) ? 'none' : 'blocked');
      return;
    }
    // Closed meanwhile, or the published microphone took over: this capture is not needed.
    if (run !== this.meterRun || !this.meterWanted || this.mic) { stream.getTracks().forEach((track) => track.stop()); return; }
    const track = stream.getAudioTracks()[0];
    if (!track) { stream.getTracks().forEach((item) => item.stop()); this.setMeter('none'); return; }
    this.preview = stream;
    track.addEventListener('ended', () => { if (this.preview === stream) { this.closePreview(); this.setMeter('none'); } }, { once: true });
    await this.bindTap(track, 'preview', () => this.prefs.micVolume / 100, run);
    void this.refreshDevices();
  }

  private async bindTap(track: MediaStreamTrack, owner: 'published' | 'preview', factor: () => number, run: number): Promise<void> {
    if (this.tap?.tap.track === track) { this.tap.factor = factor; this.setMeter('live'); return; }
    this.closeTap();
    const context = await this.runningContext();
    if (run !== this.meterRun || !this.meterWanted) return;
    if (!context) { this.setMeter('unavailable'); return; }
    this.tap = { tap: new LevelTap(context, track), owner, factor };
    this.setMeter('live');
  }

  private closeTap() {
    this.tap?.tap.close();
    this.tap = null;
  }

  private closePreview() {
    const stream = this.preview;
    this.preview = null;
    if (!stream) return;
    if (this.tap?.owner === 'preview') this.closeTap();
    stream.getTracks().forEach((track) => track.stop());
  }

  // ---- The end of a call ----

  /** The call ended: voices go, the meter stops, the context is let go. Preferences stay for the next call. */
  reset() {
    this.stopMeter();
    this.playback.clear();
    this.mic = null;
    this.processor = null;
  }

  dispose() {
    this.reset();
    void this.context?.close().catch(() => undefined);
    this.context = null;
  }

  // ---- State ----

  private canBoost(): boolean {
    return this.support.gain && (this.prefs.speakerId === null || typeof (globalThis.AudioContext?.prototype as SinkContext | undefined)?.setSinkId === 'function');
  }

  private getContext(): SinkContext | null {
    if (typeof AudioContext === 'undefined') return null;
    if (!this.context || this.context.state === 'closed') {
      try {
        this.context = new AudioContext({ latencyHint: 'interactive' });
        if (this.prefs.speakerId) void this.context.setSinkId?.(this.prefs.speakerId).catch(() => undefined);
      } catch { return null; }
    }
    return this.context;
  }

  /** A context that is running, started from the click that needs it; `null` where the browser keeps it suspended. */
  private async runningContext(): Promise<SinkContext | null> {
    const context = this.getContext();
    if (!context) return null;
    if (context.state !== 'running') await Promise.race([context.resume().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 400))]);
    return context.state === 'running' ? context : null;
  }

  /** For a boosted voice, which must not play from a suspended context: it asks the browser to resume and tries again. */
  private runningNow(): AudioContext | null {
    const context = this.getContext();
    if (!context) return null;
    if (context.state === 'running') return context;
    void context.resume().then(() => { if (context.state === 'running') this.playback.refresh(); }).catch(() => undefined);
    return null;
  }

  private save() { writePrefs(storage(), this.prefs); }

  private setPrefs(next: AudioPrefs) {
    this.prefs = next;
    this.save();
    this.emit();
  }

  private setMeter(state: MeterState) {
    if (this.meter === state) return;
    this.meter = state;
    this.emit();
  }

  /** A calm sentence, shown while the settings are open and once as a toast. */
  private say(message: string) {
    this.notice = message;
    this.alert = { id: (this.alert?.id ?? 0) + 1, message };
    this.emit();
  }

  private note(message: string) {
    this.notice = message;
    this.emit();
  }

  private build(): AudioSnapshot {
    const { prefs } = this;
    let inputs = listed(this.knownInputs, 'Microphone');
    let outputs = listed(this.knownOutputs, 'Speakers');
    // Before the browser names its devices, a remembered one still shows as chosen.
    if (prefs.micId && this.knownInputs.length === 0) inputs = [...inputs, { id: prefs.micId, label: prefs.micLabel ?? 'Chosen microphone' }];
    if (prefs.speakerId && this.knownOutputs.length === 0) outputs = [...outputs, { id: prefs.speakerId, label: prefs.speakerLabel ?? 'Chosen speakers' }];
    return {
      prefs, inputs, outputs,
      inputId: prefs.micId ?? 'default', outputId: prefs.speakerId ?? 'default',
      support: this.support,
      askOutput: this.support.chooseOutput && this.support.selectOutput && this.knownOutputs.length === 0,
      boost: this.canBoost(),
      notice: this.notice, alert: this.alert,
      meter: this.meter, testing: this.testing,
    };
  }

  private emit() {
    this.snapshot = this.build();
    for (const listener of this.listeners) listener();
  }
}
