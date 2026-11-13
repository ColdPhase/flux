import {
  ConnectionQuality, DisconnectReason, LocalAudioTrack, createLocalScreenTracks, createLocalVideoTrack, type LocalTrack, LocalVideoTrack, RemoteAudioTrack, RemoteVideoTrack, Room, RoomEvent, Track, TrackEvent,
  type LocalTrackPublication, type Participant, type RemoteParticipant, type TrackPublishOptions, type VideoResolution, type RemoteTrack, type RemoteTrackPublication, type TrackPublication,
} from 'livekit-client';
import { canPublishScreen } from './capture.js';
import { installIceServerNormalizer } from './ice-servers.js';
import { CallAudio } from './call-audio.js';
import { measurement as fmt, receiverReport, TrackDiagnostics } from './diagnostics.js';

/**
 * The browser side of the self-hosted media connection (#59 §6). This is the only module
 * that touches the LiveKit SDK: views read a plain snapshot and call a few verbs, so no SDK
 * object leaks into React state. A connection starts with every device off and never turns
 * one on by itself; each device changes only through `setDevice` from a person's own action.
 */

export type DeviceKind = 'mic' | 'camera' | 'screen';
/**
 * How a screen is sent (#63). `text` keeps every pixel of code and documents sharp at up to
 * 2560×1440 and 15 fps. `motion` is for a moving demo or video: up to 1920×1080 at 60 fps, and
 * under a weak uplink the encoder lowers the resolution before the frame rate. Both are one layer.
 */
export type ScreenMode = 'text' | 'motion';

/** Capture and publication of each screen mode. */
const SCREEN_MODES: Record<ScreenMode, { resolution: VideoResolution; contentHint: 'detail' | 'motion'; publish: TrackPublishOptions }> = {
  text: {
    resolution: { width: 2560, height: 1440, frameRate: 15 },
    contentHint: 'detail',
    publish: { degradationPreference: 'maintain-resolution', simulcast: false, screenShareEncoding: { maxBitrate: 3_500_000, maxFramerate: 15 } },
  },
  motion: {
    resolution: { width: 1920, height: 1080, frameRate: 60 },
    contentHint: 'motion',
    // One layer, frame rate kept over resolution. With simulcast (one or two smaller layers) the 1080p layer fell
    // from 60 to about 12 fps in the simulation, where one layer kept 59 fps; at 6 Mbit/s a whole moving 1080p frame
    // fell back to 720p, so the cap is 10 Mbit/s (#63, 2026-10-31).
    publish: { degradationPreference: 'maintain-framerate', simulcast: false, screenShareEncoding: { maxBitrate: 10_000_000, maxFramerate: 60 } },
  },
};

const SCREEN_MODE_KEY = 'flux.live.screenMode';
function storedScreenMode(): ScreenMode {
  try { return localStorage.getItem(SCREEN_MODE_KEY) === 'motion' ? 'motion' : 'text'; } catch { return 'text'; }
}
/** What a device is really doing. Only `on` means it is captured and published. */
export type DeviceState = 'off' | 'starting' | 'on' | 'denied' | 'missing' | 'busy' | 'failed' | 'unsupported';

export interface DeviceStatus {
  state: DeviceState;
  /** One calm sentence about the last change, e.g. why it stopped. */
  note: string | null;
}

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
export type EndReason = 'left' | 'removed' | 'room-ended' | 'elsewhere' | 'lost';
export type Quality = 'excellent' | 'good' | 'poor' | 'lost' | 'unknown';

export interface VideoRef {
  /** Stable for one person's camera or screen, also when its track is published again. */
  key: string;
  /** The published track; a new one replaces the video in the same place. */
  trackSid: string;
  userId: string;
  source: 'camera' | 'screen';
  local: boolean;
  /** Attaches the video to an element; returns the detach function. */
  attach(element: HTMLVideoElement): () => void;
  width: number | null;
  height: number | null;
}

export interface MediaPerson {
  userId: string;
  local: boolean;
  speaking: boolean;
  quality: Quality;
  /** Publishing an unmuted microphone right now. */
  mic: boolean;
  camera: VideoRef | null;
  screen: VideoRef | null;
  joinedAt: number;
}

export interface MediaSnapshot {
  connection: ConnectionState;
  endReason: EndReason | null;
  /** One entry per person, however many sessions (tabs, devices) they have in the room. */
  people: MediaPerson[];
  /**
   * Every published screen and camera, one per track: two devices of one person sharing
   * two screens are two choices. Remote screens only; cameras include your own.
   */
  screens: VideoRef[];
  cameras: VideoRef[];
  devices: Record<DeviceKind, DeviceStatus>;
  /** The browser allows audio to play; false until a gesture unlocks it. */
  canPlayAudio: boolean;
  /** Incoming audio is on (quiet turns it off). */
  hearing: boolean;
  /** How your screen is (or will next be) sent. */
  screenMode: ScreenMode;
}

export interface DiagnosticRow {
  who: string;
  what: string;
  values: string[];
  warning: string | null;
}

const IDLE_DEVICES: Record<DeviceKind, DeviceStatus> = {
  mic: { state: 'off', note: null },
  camera: { state: 'off', note: null },
  screen: { state: 'off', note: null },
};

/**
 * Flux signs one identity per media admission, `u_<base64url(userId)>.<admissionId>` (#128);
 * any other identity is not a Flux person. One person may be several participants.
 */
export function userIdOf(identity: string): string | null {
  const match = /^u_([A-Za-z0-9_-]{1,126})\.[A-Za-z0-9_-]{22}$/.exec(identity);
  if (!match) return null;
  try {
    const base64 = match[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4)), (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { return null; }
}


function quality(value: ConnectionQuality): Quality {
  switch (value) {
    case ConnectionQuality.Excellent: return 'excellent';
    case ConnectionQuality.Good: return 'good';
    case ConnectionQuality.Poor: return 'poor';
    case ConnectionQuality.Lost: return 'lost';
    default: return 'unknown';
  }
}

function failure(kind: DeviceKind, error: unknown): DeviceStatus {
  const name = error instanceof DOMException || error instanceof Error ? error.name : '';
  const device = kind === 'mic' ? 'microphone' : kind === 'camera' ? 'camera' : 'screen';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return kind === 'screen'
      ? { state: 'off', note: 'Screen sharing was cancelled or blocked by the browser. Nothing is shared.' }
      : { state: 'denied', note: `The browser blocked the ${device}. Allow it in the site settings, then try again.` };
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError')
    return { state: 'missing', note: `No ${device} was found on this device.` };
  if (name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError')
    return { state: 'busy', note: `The ${device} is in use by another app or could not start.` };
  if (name === 'TypeError' || name === 'NotSupportedError')
    return { state: 'unsupported', note: `This browser cannot share a ${device} here.` };
  return { state: 'failed', note: `The ${device} could not start. Nothing is being sent.` };
}

async function hasInput(kind: 'audioinput' | 'videoinput'): Promise<boolean | null> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.some((device) => device.kind === kind);
  } catch { return null; }
}

export class LiveMediaConnection {
  private readonly room: Room;
  private snapshot: MediaSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly audioHost: HTMLElement;
  private hearing = true;
  private devices: Record<DeviceKind, DeviceStatus> = { ...IDLE_DEVICES };
  /**
   * Each on/off request of a device takes the next number. Capture can take seconds (a permission
   * prompt, a screen picker); a request that is no longer the latest when capture or publication
   * finishes stops its tracks instead of sending them. Quiet, off and leave all take a number.
   */
  private generation: Record<DeviceKind, number> = { mic: 0, camera: 0, screen: 0 };
  /** Tracks captured but not yet confirmed as published: Quiet, off and leave stop them at once. */
  private pending: Record<DeviceKind, Set<LocalTrack>> = { mic: new Set(), camera: new Set(), screen: new Set() };
  private connection: ConnectionState = 'idle';
  private endReason: EndReason | null = null;
  private leaving = false;
  private trackDiagnostics = new TrackDiagnostics();
  private screenMode: ScreenMode = storedScreenMode();
  /** Screens being published again in another mode (how many are waiting or running): their unpublication is not a stop. */
  private republishing = 0;
  /** The mode the shared screen is being sent in now. */
  private screenSent: ScreenMode | null = null;
  /**
   * What this connection publishes changes one step at a time. Each publication and each unpublication is negotiated with the media
   * server, and three of them overlapping (a screen published again in another mode, Stop sharing, the camera turned on) left the
   * server with a screen nobody sent and without the camera (#1339): the others kept seeing a screen that had stopped. A step waits
   * for the one before it; capture is not part of it, since a permission prompt can take as long as a person likes.
   */
  private publications: Promise<unknown> = Promise.resolve();
  private readonly stopDeviceWatch: () => void;
  /** Sound settings of the call: devices, volumes, the meter (#1244). The interface reads it through its own snapshot. */
  readonly audio: CallAudio;

  constructor() {
    installIceServerNormalizer();
    this.room = new Room({
      // Automatic quality: receivers request the size they show; hidden video is paused.
      adaptiveStream: true,
      dynacast: true,
      stopLocalTrackOnUnpublish: true,
      disconnectOnPageLeave: true,
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      publishDefaults: { dtx: true, red: true, screenShareEncoding: SCREEN_MODES.text.publish.screenShareEncoding },
    });
    this.audioHost = document.createElement('div');
    this.audioHost.hidden = true;
    this.audioHost.dataset.liveAudio = '';
    document.body.append(this.audioHost);
    this.audio = new CallAudio(this.room, () => this.hearing);
    this.snapshot = this.build();

    const update = () => this.emit();
    const room = this.room;
    room
      .on(RoomEvent.Connected, () => { this.connection = 'connected'; update(); })
      // A capture still waiting to publish is stopped when the connection drops; its request then
      // reports that nothing was sent (see `setDevice`).
      .on(RoomEvent.Reconnecting, () => { this.connection = 'reconnecting'; this.interruptRequests(); update(); })
      .on(RoomEvent.SignalReconnecting, () => { this.connection = 'reconnecting'; this.interruptRequests(); update(); })
      .on(RoomEvent.Reconnected, () => { this.connection = 'connected'; update(); })
      .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => this.onDisconnected(reason))
      .on(RoomEvent.ParticipantConnected, update)
      .on(RoomEvent.ParticipantDisconnected, update)
      .on(RoomEvent.TrackPublished, update)
      .on(RoomEvent.TrackUnpublished, update)
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => this.onSubscribed(track, publication, participant))
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, publication: RemoteTrackPublication) => {
        this.trackDiagnostics.forget(publication.trackSid);
        track.detach().forEach((element) => { this.audio.playback.detach(element); element.remove(); });
        // LiveKit detaches a track's elements itself when it unpublishes it: what it leaves behind has no stream and no voice.
        for (const element of this.audioHost.querySelectorAll('audio')) {
          if (!element.srcObject) { this.audio.playback.detach(element); element.remove(); }
        }
        update();
      })
      .on(RoomEvent.TrackMuted, update)
      .on(RoomEvent.TrackUnmuted, update)
      .on(RoomEvent.ActiveSpeakersChanged, update)
      .on(RoomEvent.ConnectionQualityChanged, update)
      .on(RoomEvent.AudioPlaybackStatusChanged, update)
      .on(RoomEvent.LocalTrackPublished, update)
      .on(RoomEvent.LocalTrackUnpublished, (publication: LocalTrackPublication) => this.onLocalUnpublished(publication))
      .on(RoomEvent.MediaDevicesChanged, () => { void this.checkDevicesStillThere(); void this.audio.refreshDevices(); });

    // A device permission revoked in site settings stops capture; say so instead of pretending.
    const watchers: (() => void)[] = [];
    for (const [name, kind] of [['microphone', 'mic'], ['camera', 'camera']] as const) {
      void navigator.permissions?.query({ name: name as PermissionName }).then((status) => {
        const onChange = () => {
          if (status.state === 'denied' && this.devices[kind].state === 'on') void this.stopDevice(kind, { state: 'denied', note: `Permission for the ${name} was withdrawn. It is off.` });
        };
        status.addEventListener('change', onChange);
        watchers.push(() => status.removeEventListener('change', onChange));
      }).catch(() => undefined);
    }
    this.stopDeviceWatch = () => watchers.forEach((stop) => stop());
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = () => this.snapshot;

  async connect(url: string, token: string): Promise<void> {
    this.connection = 'connecting';
    this.endReason = null;
    this.leaving = false;
    this.emit();
    try {
      await this.room.connect(url, token, { autoSubscribe: true, maxRetries: 1 });
      this.connection = 'connected';
      void this.audio.joined();
    } catch (error) {
      this.connection = 'disconnected';
      this.endReason = 'lost';
      this.emit();
      throw error;
    }
    this.emit();
  }

  /** Turns one device on or off. Only a person's direct action calls this. */
  async setDevice(kind: DeviceKind, on: boolean): Promise<DeviceStatus> {
    if (!on) return this.stopDevice(kind, { state: 'off', note: null });
    const request = ++this.generation[kind];
    const device = kind === 'mic' ? 'microphone' : kind === 'camera' ? 'camera' : 'screen';
    /** Why this request may no longer send: a newer request (Quiet, off, leave) or a lost connection. */
    const stale = () => request !== this.generation[kind] ? 'superseded' : this.leaving || this.connection !== 'connected' ? 'offline' : null;
    const drop = (reason: 'superseded' | 'offline') => reason === 'superseded' || this.leaving ? this.devices[kind]
      : this.set(kind, { state: 'off', note: `The connection dropped before the ${device} started, so nothing was sent. It is off.` });
    if (this.connection !== 'connected') return this.devices[kind];
    if (kind === 'screen' && !canPublishScreen()) return this.set(kind, { state: 'unsupported', note: 'This browser cannot share a screen. You can still see screens others share.' });
    if (kind !== 'screen' && (await hasInput(kind === 'mic' ? 'audioinput' : 'videoinput')) === false)
      return stale() ? drop(stale()!) : this.set(kind, { state: 'missing', note: `No ${device} was found on this device.` });
    if (stale()) return drop(stale()!);
    this.set(kind, { state: 'starting', note: null });
    let captured: LocalTrack[] = [];
    try {
      const local = this.room.localParticipant;
      // Capture first, publish only if this request is still the latest: a late permission
      // answer after Quiet, off or leave must never reach anyone.
      // The device and the three browser switches are the person's (Audio settings, #1244); on by default.
      if (kind === 'mic') captured = [await this.audio.captureMic()];
      // Up to 1080p30; simulcast sends smaller layers too, and only the layers someone shows (#59 §7).
      else if (kind === 'camera') captured = [await createLocalVideoTrack({ resolution: { width: 1920, height: 1080, frameRate: 30 } })];
      else {
        const mode = SCREEN_MODES[this.screenMode];
        captured = (await createLocalScreenTracks({
          audio: false,
          contentHint: mode.contentHint,
          resolution: mode.resolution,
          selfBrowserSurface: 'exclude',
          surfaceSwitching: 'include',
        })).filter((track) => track.kind === Track.Kind.Video);
      }
      captured.forEach((track) => this.pending[kind].add(track));
      if (stale()) { captured.forEach((track) => track.stop()); return drop(stale()!); }
      const track = captured[0];
      if (!track) return this.set(kind, { state: 'off', note: kind === 'screen' ? 'Nothing was chosen, so nothing is shared.' : null });
      const sentAs = this.screenMode;
      const result = await this.inOrder(async () => {
        // Asked to stop (or the connection dropped) while this waited its turn: nothing is sent, and the capture stops (a lost
        // connection does not stop captures on its own).
        if (stale()) { track.stop(); this.pending[kind].delete(track); return drop(stale()!); }
        // A camera keeps moving when the encoder is short of CPU or bandwidth (LiveKit would keep a 1080p camera's resolution).
        await local.publishTrack(track, kind === 'screen' ? { ...SCREEN_MODES[sentAs].publish } : kind === 'camera' ? { degradationPreference: 'balanced' } : {});
        // Superseded while publishing: the track was already stopped; take the publication back too.
        if (stale()) { await this.unpublishNow(track); return drop(stale()!); }
        this.pending[kind].clear();
        const publication = local.getTrackPublication(kind === 'mic' ? Track.Source.Microphone : kind === 'camera' ? Track.Source.Camera : Track.Source.ScreenShare);
        if (!publication?.track) return this.set(kind, { state: 'off', note: kind === 'screen' ? 'Nothing was chosen, so nothing is shared.' : null });
        const onEnded = () => {
          const note = kind === 'screen' ? 'Screen sharing stopped from the browser.' : `The ${kind === 'mic' ? 'microphone' : 'camera'} stopped (unplugged or taken by another app).`;
          void this.stopDevice(kind, { state: 'off', note });
        };
        if (kind === 'mic') {
          // The microphone's capture is replaced when another device or switch is chosen; the track's own event follows each one.
          publication.track.on(TrackEvent.Ended, onEnded);
          if (publication.track instanceof LocalAudioTrack) await this.audio.attachMic(publication.track);
        } else publication.track.mediaStreamTrack.addEventListener('ended', onEnded, { once: true });
        if (kind === 'screen') this.screenSent = sentAs;
        return this.set(kind, { state: 'on', note: null });
      });
      // The mode was chosen again while the screen was being captured or published: it is sent in the one chosen last.
      if (kind === 'screen' && result.state === 'on' && this.screenSent !== this.screenMode) void this.applyScreenMode();
      return result;
    } catch (error) {
      captured.forEach((track) => this.pending[kind].delete(track));
      await Promise.all(captured.map((track) => this.unpublish(track)));
      if (stale()) return drop(stale()!);
      await this.release(kind);
      return this.set(kind, failure(kind, error));
    }
  }

  /**
   * Chooses how your screen is sent; remembered for your next share on this browser. A screen
   * being shared changes at once: the same capture is published again in the new mode, so
   * nothing new is captured and nobody is asked to pick a screen again.
   */
  async setScreenMode(mode: ScreenMode): Promise<void> {
    if (mode === this.screenMode) return;
    this.screenMode = mode;
    try { localStorage.setItem(SCREEN_MODE_KEY, mode); } catch { /* remembered for this session only */ }
    this.emit();
    if (this.devices.screen.state === 'on') await this.applyScreenMode();
  }

  private async applyScreenMode() {
    const request = this.generation.screen;
    this.republishing += 1;
    try { await this.inOrder(() => this.republishScreen(request)); } finally { this.republishing -= 1; this.emit(); }
  }

  /** Sends the shared screen in the mode chosen now (the latest choice, whatever was asked when this was queued). `request` is the share it was asked for. */
  private async republishScreen(request: number) {
    const local = this.room.localParticipant;
    const track = local.getTrackPublication(Track.Source.ScreenShare)?.track;
    const mode = this.screenMode;
    // Stopped (or shared anew) while this waited its turn: nothing is published again.
    if (request !== this.generation.screen || !(track instanceof LocalVideoTrack) || this.devices.screen.state !== 'on' || this.screenSent === mode) return;
    const settings = SCREEN_MODES[mode];
    try {
      track.mediaStreamTrack.contentHint = settings.contentHint;
      const { width, height, frameRate } = settings.resolution;
      await track.mediaStreamTrack.applyConstraints({ width: { max: width }, height: { max: height }, frameRate: { max: frameRate } }).catch(() => undefined);
      await local.unpublishTrack(track, false);
      // Stopped (Stop sharing, Quiet, leave) while switching: nothing is published again.
      if (request !== this.generation.screen || this.connection !== 'connected') {
        track.stop();
        // The connection dropped mid-switch (not a stop): the screen no longer goes out, and the button says so.
        if (request === this.generation.screen) this.set('screen', { state: 'off', note: 'The screen could not switch and stopped. Nothing is shared.' });
        return;
      }
      await local.publishTrack(track, { ...settings.publish });
      this.screenSent = mode;
      if (request !== this.generation.screen) await this.unpublishNow(track);
    } catch {
      track.stop();
      await this.unpublishNow(track).catch(() => undefined);
      // Stopped meanwhile (Stop sharing, Quiet, leave): that stop already says what happened.
      if (request === this.generation.screen) this.set('screen', { state: 'off', note: 'The screen could not switch and stopped. Nothing is shared.' });
    }
  }

  /** Quiet stops incoming audio; returning resumes listening only. Devices stay as they are. */
  setHearing(on: boolean) {
    this.hearing = on;
    for (const participant of this.room.remoteParticipants.values()) {
      for (const publication of participant.audioTrackPublications.values()) publication.setEnabled(on);
    }
    this.audio.setHearing();
    this.emit();
  }

  /** Needs a click or tap: browsers block sound until then. */
  async startAudio() {
    try { await this.room.startAudio(); } catch { /* still blocked: the button stays */ }
    this.emit();
  }

  async disconnect(): Promise<void> {
    this.leaving = true;
    this.trackDiagnostics.clear();
    for (const kind of ['mic', 'camera', 'screen'] as const) { this.generation[kind]++; this.stopPending(kind); }
    // Leaving does not wait behind a publication in progress: every capture stops now and the room's disconnect takes the publications with it.
    this.audio.detachMic();
    for (const publication of this.room.localParticipant.trackPublications.values()) publication.track?.stop();
    this.devices = { ...IDLE_DEVICES };
    await this.room.disconnect(true);
    this.connection = 'disconnected';
    this.endReason = 'left';
    this.emit();
  }

  dispose() {
    this.stopDeviceWatch();
    this.audio.dispose();
    void this.disconnect().finally(() => this.audioHost.remove());
  }

  /** Measured values from the WebRTC statistics of each track, on request. */
  async diagnostics(names: (userId: string) => string): Promise<DiagnosticRow[]> {
    const rows: DiagnosticRow[] = [];
    const now = performance.now();
    const version = this.trackDiagnostics.version;
    const keys = new Set<string>();
    rows.push({ who: 'Connection', what: this.connection === 'connected' ? 'Connected' : this.connection, values: [`${this.snapshot.people.length || 1} ${this.snapshot.people.length === 1 ? 'person' : 'people'} in the room`], warning: this.connection === 'reconnecting' ? 'Reconnecting to the media server' : null });
    const local = this.room.localParticipant;
    for (const publication of local.trackPublications.values()) {
      keys.add(`out:${publication.trackSid}`);
      const track = publication.track;
      if (track instanceof LocalVideoTrack) {
        const [stats] = await track.getSenderStats().catch(() => []);
        if (version !== this.trackDiagnostics.version) return [];
        const key = `out:${publication.trackSid}`;
        const kbps = this.trackDiagnostics.sender(key, stats?.bytesSent, now);
        rows.push({
          who: 'You', what: publication.source === Track.Source.ScreenShare ? 'Sending screen' : 'Sending camera',
          values: [stats ? `${stats.frameWidth}×${stats.frameHeight}` : '– ×–', fmt(stats?.framesPerSecond, 'fps'), fmt(kbps, 'kbit/s'), fmt(stats?.roundTripTime !== undefined ? stats.roundTripTime * 1000 : null, 'ms RTT')],
          warning: stats?.qualityLimitationReason && stats.qualityLimitationReason !== 'none' ? `Limited by ${stats.qualityLimitationReason}` : null,
        });
      } else if (track instanceof LocalAudioTrack) {
        const stats = await track.getSenderStats().catch(() => undefined);
        if (version !== this.trackDiagnostics.version) return [];
        const kbps = this.trackDiagnostics.sender(`out:${publication.trackSid}`, stats?.bytesSent, now);
        rows.push({ who: 'You', what: publication.isMuted ? 'Microphone muted' : 'Sending voice', values: [fmt(kbps, 'kbit/s'), fmt(stats?.roundTripTime !== undefined ? stats.roundTripTime * 1000 : null, 'ms RTT'), fmt(stats?.packetsLost, 'lost total')], warning: null });
      }
    }
    for (const participant of this.room.remoteParticipants.values()) {
      const userId = userIdOf(participant.identity);
      // Your own other tab or device is you, not an unknown participant.
      const who = !userId ? 'Unknown participant' : userId === userIdOf(local.identity) ? 'You (another device)' : names(userId);
      for (const publication of participant.trackPublications.values()) {
        keys.add(`in:${publication.trackSid}`);
        const track = publication.track;
        if (track instanceof RemoteVideoTrack) {
          const raw = await track.getRTCStatsReport().catch(() => undefined);
          if (version !== this.trackDiagnostics.version) return [];
          const stats = receiverReport(raw, 'video', track.mediaStreamTrack.id);
          const measured = this.trackDiagnostics.receiver(`in:${publication.trackSid}`, 'video', stats?.record, now,
            !publication.isMuted && track.streamState !== 'paused', stats?.codec);
          rows.push({ who, what: publication.source === Track.Source.ScreenShare ? 'Screen' : 'Camera',
            values: measured.values, warning: measured.warning });
        } else if (track instanceof RemoteAudioTrack) {
          const raw = await track.getRTCStatsReport().catch(() => undefined);
          if (version !== this.trackDiagnostics.version) return [];
          const stats = receiverReport(raw, 'audio', track.mediaStreamTrack.id);
          const measured = this.trackDiagnostics.receiver(`in:${publication.trackSid}`, 'audio', stats?.record, now,
            this.hearing && !publication.isMuted, undefined, stats?.concealmentEvents);
          rows.push({ who, what: this.hearing ? 'Voice' : 'Voice (paused while quiet)',
            values: measured.values, warning: measured.warning });
        }
      }
      rows.push({ who, what: 'Link quality', values: [quality(participant.connectionQuality)], warning: participant.connectionQuality === ConnectionQuality.Poor ? 'Weak connection' : null });
    }
    this.trackDiagnostics.retain(keys);
    return rows;
  }

  private set(kind: DeviceKind, status: DeviceStatus): DeviceStatus {
    this.devices = { ...this.devices, [kind]: status };
    this.emit();
    return status;
  }

  /** Takes a device's publication back, after the steps already waiting. */
  private release(kind: DeviceKind): Promise<void> {
    return this.inOrder(() => this.releaseNow(kind));
  }

  /** Runs one publication step once the earlier ones are over; a step that fails does not stop the ones after it. */
  private inOrder<T>(step: () => Promise<T>): Promise<T> {
    const run = this.publications.then(step, step);
    this.publications = run.catch(() => undefined);
    return run;
  }

  private async releaseNow(kind: DeviceKind) {
    const source = kind === 'mic' ? Track.Source.Microphone : kind === 'camera' ? Track.Source.Camera : Track.Source.ScreenShare;
    const publication = this.room.localParticipant.getTrackPublication(source);
    const track = publication?.track;
    if (kind === 'mic') this.audio.detachMic();
    if (!track) return;
    // Unpublish and stop: a muted-but-captured device would keep the browser's recording light on.
    try { await this.room.localParticipant.unpublishTrack(track, true); } catch { track.stop(); }
  }

  /** Stops a captured track and takes back its publication, if it has one: after the steps already waiting. */
  private unpublish(track: LocalTrack): Promise<void> {
    return this.inOrder(() => this.unpublishNow(track));
  }

  private async unpublishNow(track: LocalTrack) {
    const published = [...this.room.localParticipant.trackPublications.values()].some((publication) => publication.track === track);
    if (published) { try { await this.room.localParticipant.unpublishTrack(track, true); } catch { /* stopped below */ } }
    track.stop();
  }

  /** Stops every capture of a device that has not finished publishing; its request is already superseded. */
  private stopPending(kind: DeviceKind) {
    for (const track of this.pending[kind]) track.stop();
    this.pending[kind].clear();
  }

  /**
   * A dropped connection supersedes every device request still in progress, including a capture
   * that has not returned yet (a permission prompt): its late track is stopped instead of
   * published after the reconnect, and turning the device on again needs a new action.
   */
  private interruptRequests() {
    for (const kind of ['mic', 'camera', 'screen'] as const) {
      this.stopPending(kind);
      if (this.devices[kind].state !== 'starting') continue;
      this.generation[kind]++;
      const device = kind === 'mic' ? 'microphone' : kind === 'camera' ? 'camera' : 'screen';
      this.devices = { ...this.devices, [kind]: { state: 'off', note: `The connection dropped before the ${device} started, so nothing was sent. It is off.` } };
    }
  }

  private async stopDevice(kind: DeviceKind, status: DeviceStatus): Promise<DeviceStatus> {
    this.generation[kind]++;
    this.stopPending(kind);
    // Its capture stops at once, so nothing more is sent even while a step ahead of it is still with the media server, and the device
    // shows as off; its publication is taken back when the steps ahead of it are over.
    this.room.localParticipant.getTrackPublication(kind === 'mic' ? Track.Source.Microphone : kind === 'camera' ? Track.Source.Camera : Track.Source.ScreenShare)?.track?.stop();
    const stopped = this.set(kind, status);
    await this.release(kind);
    return stopped;
  }

  private async checkDevicesStillThere() {
    for (const [kind, input] of [['mic', 'audioinput'], ['camera', 'videoinput']] as const) {
      if (this.devices[kind].state === 'on' && (await hasInput(input)) === false)
        await this.stopDevice(kind, { state: 'missing', note: `The ${kind === 'mic' ? 'microphone' : 'camera'} was disconnected. It is off.` });
    }
    this.emit();
  }

  private onLocalUnpublished(publication: LocalTrackPublication) {
    this.trackDiagnostics.forget(publication.trackSid);
    const kind: DeviceKind | null = publication.source === Track.Source.Microphone ? 'mic'
      : publication.source === Track.Source.Camera ? 'camera' : publication.source === Track.Source.ScreenShare ? 'screen' : null;
    if (kind === 'mic') this.audio.detachMic();
    if (kind && this.devices[kind].state === 'on' && !(kind === 'screen' && this.republishing > 0))
      this.devices = { ...this.devices, [kind]: { state: 'off', note: kind === 'screen' ? 'Screen sharing stopped.' : null } };
    this.emit();
  }

  private onSubscribed(track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) {
    if (track.kind === Track.Kind.Audio) {
      const element = track.attach() as HTMLAudioElement;
      // This voice's volume and Mute for me, and Quiet (#1244): how it plays is this person's own setting.
      this.audio.playback.attach(element, userIdOf(participant.identity) ?? '');
      this.audioHost.append(element);
      if (!this.hearing) publication.setEnabled(false);
    }
    this.emit();
  }

  private onDisconnected(reason?: DisconnectReason) {
    this.trackDiagnostics.clear();
    this.connection = 'disconnected';
    if (this.leaving) this.endReason = 'left';
    else if (reason === DisconnectReason.ROOM_DELETED || reason === DisconnectReason.ROOM_CLOSED) this.endReason = 'room-ended';
    else if (reason === DisconnectReason.PARTICIPANT_REMOVED) this.endReason = 'removed';
    else if (reason === DisconnectReason.DUPLICATE_IDENTITY) this.endReason = 'elsewhere';
    else if (reason === DisconnectReason.CLIENT_INITIATED) this.endReason = 'left';
    else this.endReason = 'lost';
    this.devices = { mic: { state: 'off', note: null }, camera: { state: 'off', note: null }, screen: { state: 'off', note: null } };
    this.audio.reset();
    for (const element of this.audioHost.querySelectorAll('audio')) element.remove();
    this.emit();
  }

  private video(participant: Participant, publication: TrackPublication | undefined, source: 'camera' | 'screen', local: boolean): VideoRef | null {
    const track = publication?.track;
    if (!publication || !track || publication.isMuted) return null;
    const userId = userIdOf(participant.identity) ?? participant.identity;
    const dims = publication.dimensions;
    return {
      key: `${participant.identity}:${source}`,
      trackSid: publication.trackSid,
      userId, source, local,
      width: dims?.width ?? null,
      height: dims?.height ?? null,
      attach: (element) => { track.attach(element); return () => { track.detach(element); }; },
    };
  }

  private person(participant: Participant, local: boolean): MediaPerson | null {
    const userId = userIdOf(participant.identity);
    if (!userId) return null;
    const mic = participant.getTrackPublication(Track.Source.Microphone);
    return {
      userId, local,
      speaking: participant.isSpeaking,
      quality: quality(participant.connectionQuality),
      mic: !!mic?.track && !mic.isMuted,
      camera: this.video(participant, participant.getTrackPublication(Track.Source.Camera), 'camera', local),
      screen: this.video(participant, participant.getTrackPublication(Track.Source.ScreenShare), 'screen', local),
      joinedAt: participant.joinedAt?.getTime() ?? 0,
    };
  }

  private build(): MediaSnapshot {
    const people: MediaPerson[] = [];
    const screens: VideoRef[] = [];
    const cameras: VideoRef[] = [];
    if (this.connection === 'connected' || this.connection === 'reconnecting') {
      const local = this.room.localParticipant;
      for (const participant of [local, ...this.room.remoteParticipants.values()]) {
        if (!userIdOf(participant.identity)) continue;
        const mine = participant === local;
        const camera = this.video(participant, participant.getTrackPublication(Track.Source.Camera), 'camera', mine);
        if (camera) cameras.push(camera);
        const screen = mine ? null : this.video(participant, participant.getTrackPublication(Track.Source.ScreenShare), 'screen', false);
        if (screen) screens.push(screen);
      }
      const me = this.person(this.room.localParticipant, true);
      if (me) people.push(me);
      // Stable order: by join time, so tiles and faces never reshuffle while someone speaks.
      const remote = [...this.room.remoteParticipants.values()].map((participant) => this.person(participant, false))
        .filter((person): person is MediaPerson => !!person).sort((a, b) => a.joinedAt - b.joinedAt || a.userId.localeCompare(b.userId));
      // One person with two tabs or devices is several participants but one face (#128).
      for (const person of remote) {
        // Your own other device is still you: your entry shows only this device's state.
        const same = people.find((known) => known.userId === person.userId);
        if (!same) { people.push(person); continue; }
        if (same.local) continue;
        same.speaking ||= person.speaking;
        same.mic ||= person.mic;
        same.camera ??= person.camera;
        same.screen ??= person.screen;
      }
    }
    return {
      connection: this.connection,
      endReason: this.endReason,
      people,
      screens,
      cameras,
      devices: this.devices,
      canPlayAudio: this.room.canPlaybackAudio,
      hearing: this.hearing,
      screenMode: this.screenMode,
    };
  }

  private emit() {
    this.snapshot = this.build();
    for (const listener of this.listeners) listener();
  }
}
