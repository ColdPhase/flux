import {
  ConnectionQuality, DisconnectReason, LocalAudioTrack, LocalVideoTrack, RemoteAudioTrack, RemoteVideoTrack, Room, RoomEvent, Track,
  type LocalTrackPublication, type Participant, type RemoteTrack, type RemoteTrackPublication, type TrackPublication,
} from 'livekit-client';

/**
 * The browser side of the self-hosted media connection (#59 §6). This is the only module
 * that touches the LiveKit SDK: views read a plain snapshot and call a few verbs, so no SDK
 * object leaks into React state. A connection starts with every device off and never turns
 * one on by itself; each device changes only through `setDevice` from a person's own action.
 */

export type DeviceKind = 'mic' | 'camera' | 'screen';
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
  key: string;
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
  people: MediaPerson[];
  devices: Record<DeviceKind, DeviceStatus>;
  /** The browser allows audio to play; false until a gesture unlocks it. */
  canPlayAudio: boolean;
  /** Incoming audio is on (quiet turns it off). */
  hearing: boolean;
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

/** Flux signs `u_<base64url(userId)>`; any other identity is not a Flux person. */
export function userIdOf(identity: string): string | null {
  if (!/^u_[A-Za-z0-9_-]{1,126}$/.test(identity)) return null;
  try {
    const base64 = identity.slice(2).replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4)), (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { return null; }
}

/** Screen publishing needs the browser's picker; Android and iOS browsers do not have it. */
export function canPublishScreen(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';
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

function fmt(value: number | undefined | null, unit: string, digits = 0) {
  return value === undefined || value === null || Number.isNaN(value) ? `– ${unit}` : `${value.toFixed(digits)} ${unit}`;
}

export class LiveMediaConnection {
  private readonly room: Room;
  private snapshot: MediaSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly audioHost: HTMLElement;
  private hearing = true;
  private devices: Record<DeviceKind, DeviceStatus> = { ...IDLE_DEVICES };
  private connection: ConnectionState = 'idle';
  private endReason: EndReason | null = null;
  private leaving = false;
  private previous = new Map<string, { bytes: number; frames: number; at: number }>();
  private readonly stopDeviceWatch: () => void;

  constructor() {
    this.room = new Room({
      // Automatic quality: receivers request the size they show; hidden video is paused.
      adaptiveStream: true,
      dynacast: true,
      stopLocalTrackOnUnpublish: true,
      disconnectOnPageLeave: true,
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      publishDefaults: { dtx: true, red: true, screenShareEncoding: { maxBitrate: 3_500_000, maxFramerate: 15 } },
    });
    this.audioHost = document.createElement('div');
    this.audioHost.hidden = true;
    this.audioHost.dataset.liveAudio = '';
    document.body.append(this.audioHost);
    this.snapshot = this.build();

    const update = () => this.emit();
    const room = this.room;
    room
      .on(RoomEvent.Connected, () => { this.connection = 'connected'; update(); })
      .on(RoomEvent.Reconnecting, () => { this.connection = 'reconnecting'; update(); })
      .on(RoomEvent.SignalReconnecting, () => { this.connection = 'reconnecting'; update(); })
      .on(RoomEvent.Reconnected, () => { this.connection = 'connected'; update(); })
      .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => this.onDisconnected(reason))
      .on(RoomEvent.ParticipantConnected, update)
      .on(RoomEvent.ParticipantDisconnected, update)
      .on(RoomEvent.TrackPublished, update)
      .on(RoomEvent.TrackUnpublished, update)
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, publication: RemoteTrackPublication) => this.onSubscribed(track, publication))
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => { track.detach().forEach((element) => element.remove()); update(); })
      .on(RoomEvent.TrackMuted, update)
      .on(RoomEvent.TrackUnmuted, update)
      .on(RoomEvent.ActiveSpeakersChanged, update)
      .on(RoomEvent.ConnectionQualityChanged, update)
      .on(RoomEvent.AudioPlaybackStatusChanged, update)
      .on(RoomEvent.LocalTrackPublished, update)
      .on(RoomEvent.LocalTrackUnpublished, (publication: LocalTrackPublication) => this.onLocalUnpublished(publication))
      .on(RoomEvent.MediaDevicesChanged, () => { void this.checkDevicesStillThere(); });

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
    if (this.connection !== 'connected') return this.devices[kind];
    if (kind === 'screen' && !canPublishScreen()) return this.set(kind, { state: 'unsupported', note: 'This browser cannot share a screen. You can still see screens others share.' });
    if (kind !== 'screen' && (await hasInput(kind === 'mic' ? 'audioinput' : 'videoinput')) === false)
      return this.set(kind, { state: 'missing', note: `No ${kind === 'mic' ? 'microphone' : 'camera'} was found on this device.` });
    this.set(kind, { state: 'starting', note: null });
    try {
      const local = this.room.localParticipant;
      if (kind === 'mic') await local.setMicrophoneEnabled(true);
      else if (kind === 'camera') await local.setCameraEnabled(true, { resolution: { width: 1280, height: 720, frameRate: 30 } });
      else {
        await local.setScreenShareEnabled(true, {
          audio: false,
          contentHint: 'detail',
          resolution: { width: 2560, height: 1440, frameRate: 15 },
          selfBrowserSurface: 'exclude',
          surfaceSwitching: 'include',
        }, { degradationPreference: 'maintain-resolution', simulcast: false });
      }
      const publication = local.getTrackPublication(kind === 'mic' ? Track.Source.Microphone : kind === 'camera' ? Track.Source.Camera : Track.Source.ScreenShare);
      if (!publication?.track) return this.set(kind, { state: 'off', note: kind === 'screen' ? 'Nothing was chosen, so nothing is shared.' : null });
      publication.track.mediaStreamTrack.addEventListener('ended', () => {
        const note = kind === 'screen' ? 'Screen sharing stopped from the browser.' : `The ${kind === 'mic' ? 'microphone' : 'camera'} stopped (unplugged or taken by another app).`;
        void this.stopDevice(kind, { state: 'off', note });
      }, { once: true });
      return this.set(kind, { state: 'on', note: null });
    } catch (error) {
      await this.release(kind);
      return this.set(kind, failure(kind, error));
    }
  }

  /** Quiet stops incoming audio; returning resumes listening only. Devices stay as they are. */
  setHearing(on: boolean) {
    this.hearing = on;
    for (const participant of this.room.remoteParticipants.values()) {
      for (const publication of participant.audioTrackPublications.values()) publication.setEnabled(on);
    }
    for (const element of this.audioHost.querySelectorAll('audio')) element.muted = !on;
    this.emit();
  }

  /** Needs a click or tap: browsers block sound until then. */
  async startAudio() {
    try { await this.room.startAudio(); } catch { /* still blocked: the button stays */ }
    this.emit();
  }

  async disconnect(): Promise<void> {
    this.leaving = true;
    await Promise.all((['mic', 'camera', 'screen'] as const).map((kind) => this.release(kind)));
    this.devices = { ...IDLE_DEVICES };
    await this.room.disconnect(true);
    this.connection = 'disconnected';
    this.endReason = 'left';
    this.emit();
  }

  dispose() {
    this.stopDeviceWatch();
    void this.disconnect().finally(() => this.audioHost.remove());
  }

  /** Measured values from the WebRTC statistics of each track, on request. */
  async diagnostics(names: (userId: string) => string): Promise<DiagnosticRow[]> {
    const rows: DiagnosticRow[] = [];
    const now = performance.now();
    const rate = (key: string, bytes: number, frames: number) => {
      const before = this.previous.get(key);
      this.previous.set(key, { bytes, frames, at: now });
      if (!before || now <= before.at) return { kbps: null, fps: null };
      const seconds = (now - before.at) / 1000;
      return { kbps: ((bytes - before.bytes) * 8) / 1000 / seconds, fps: (frames - before.frames) / seconds };
    };
    rows.push({ who: 'Connection', what: this.connection === 'connected' ? 'Connected' : this.connection, values: [`${this.room.remoteParticipants.size + 1} in the room`], warning: this.connection === 'reconnecting' ? 'Reconnecting to the media server' : null });
    const local = this.room.localParticipant;
    for (const publication of local.trackPublications.values()) {
      const track = publication.track;
      if (track instanceof LocalVideoTrack) {
        const [stats] = await track.getSenderStats().catch(() => []);
        const key = `out:${publication.trackSid}`;
        const { kbps } = rate(key, stats?.bytesSent ?? 0, stats?.framesSent ?? 0);
        rows.push({
          who: 'You', what: publication.source === Track.Source.ScreenShare ? 'Sending screen' : 'Sending camera',
          values: [stats ? `${stats.frameWidth}×${stats.frameHeight}` : '– ×–', fmt(stats?.framesPerSecond, 'fps'), fmt(kbps, 'kbit/s'), fmt(stats?.roundTripTime !== undefined ? stats.roundTripTime * 1000 : null, 'ms RTT')],
          warning: stats?.qualityLimitationReason && stats.qualityLimitationReason !== 'none' ? `Limited by ${stats.qualityLimitationReason}` : null,
        });
      } else if (track instanceof LocalAudioTrack) {
        const stats = await track.getSenderStats().catch(() => undefined);
        const { kbps } = rate(`out:${publication.trackSid}`, stats?.bytesSent ?? 0, 0);
        rows.push({ who: 'You', what: publication.isMuted ? 'Microphone muted' : 'Sending voice', values: [fmt(kbps, 'kbit/s'), fmt(stats?.roundTripTime !== undefined ? stats.roundTripTime * 1000 : null, 'ms RTT'), `${stats?.packetsLost ?? 0} lost`], warning: null });
      }
    }
    for (const participant of this.room.remoteParticipants.values()) {
      const userId = userIdOf(participant.identity);
      const who = userId ? names(userId) : 'Unknown participant';
      for (const publication of participant.trackPublications.values()) {
        const track = publication.track;
        if (track instanceof RemoteVideoTrack) {
          const stats = await track.getReceiverStats().catch(() => undefined);
          const { kbps, fps } = rate(`in:${publication.trackSid}`, stats?.bytesReceived ?? 0, stats?.framesDecoded ?? 0);
          const lost = stats?.packetsLost ?? 0;
          const received = stats?.packetsReceived ?? 0;
          rows.push({
            who, what: publication.source === Track.Source.ScreenShare ? 'Screen' : 'Camera',
            values: [stats?.frameWidth ? `${stats.frameWidth}×${stats.frameHeight}` : 'paused', fmt(fps, 'fps'), fmt(kbps, 'kbit/s'), received ? `${((lost / (lost + received)) * 100).toFixed(1)}% lost` : '0% lost', stats?.mimeType?.replace('video/', '') ?? ''].filter(Boolean),
            warning: received && lost / (lost + received) > 0.05 ? 'Packet loss is high; the picture may blur' : fps !== null && fps < 5 && !!stats?.frameWidth ? 'Few frames arrive; the network may be slow' : null,
          });
        } else if (track instanceof RemoteAudioTrack) {
          const stats = await track.getReceiverStats().catch(() => undefined);
          const { kbps } = rate(`in:${publication.trackSid}`, stats?.bytesReceived ?? 0, 0);
          rows.push({ who, what: this.hearing ? 'Voice' : 'Voice (paused while quiet)', values: [fmt(kbps, 'kbit/s'), fmt(stats?.jitter !== undefined ? stats.jitter * 1000 : null, 'ms jitter'), `${stats?.concealmentEvents ?? 0} gaps`], warning: null });
        }
      }
      rows.push({ who, what: 'Link quality', values: [quality(participant.connectionQuality)], warning: participant.connectionQuality === ConnectionQuality.Poor ? 'Weak connection' : null });
    }
    return rows;
  }

  private set(kind: DeviceKind, status: DeviceStatus): DeviceStatus {
    this.devices = { ...this.devices, [kind]: status };
    this.emit();
    return status;
  }

  private async release(kind: DeviceKind) {
    const source = kind === 'mic' ? Track.Source.Microphone : kind === 'camera' ? Track.Source.Camera : Track.Source.ScreenShare;
    const publication = this.room.localParticipant.getTrackPublication(source);
    const track = publication?.track;
    if (!track) return;
    // Unpublish and stop: a muted-but-captured device would keep the browser's recording light on.
    try { await this.room.localParticipant.unpublishTrack(track, true); } catch { track.stop(); }
  }

  private async stopDevice(kind: DeviceKind, status: DeviceStatus): Promise<DeviceStatus> {
    await this.release(kind);
    return this.set(kind, status);
  }

  private async checkDevicesStillThere() {
    for (const [kind, input] of [['mic', 'audioinput'], ['camera', 'videoinput']] as const) {
      if (this.devices[kind].state === 'on' && (await hasInput(input)) === false)
        await this.stopDevice(kind, { state: 'missing', note: `The ${kind === 'mic' ? 'microphone' : 'camera'} was disconnected. It is off.` });
    }
    this.emit();
  }

  private onLocalUnpublished(publication: LocalTrackPublication) {
    const kind: DeviceKind | null = publication.source === Track.Source.Microphone ? 'mic'
      : publication.source === Track.Source.Camera ? 'camera' : publication.source === Track.Source.ScreenShare ? 'screen' : null;
    if (kind && this.devices[kind].state === 'on')
      this.devices = { ...this.devices, [kind]: { state: 'off', note: kind === 'screen' ? 'Screen sharing stopped.' : null } };
    this.emit();
  }

  private onSubscribed(track: RemoteTrack, publication: RemoteTrackPublication) {
    if (track.kind === Track.Kind.Audio) {
      const element = track.attach() as HTMLAudioElement;
      element.muted = !this.hearing;
      this.audioHost.append(element);
      if (!this.hearing) publication.setEnabled(false);
    }
    this.emit();
  }

  private onDisconnected(reason?: DisconnectReason) {
    this.connection = 'disconnected';
    if (this.leaving) this.endReason = 'left';
    else if (reason === DisconnectReason.ROOM_DELETED || reason === DisconnectReason.ROOM_CLOSED) this.endReason = 'room-ended';
    else if (reason === DisconnectReason.PARTICIPANT_REMOVED) this.endReason = 'removed';
    else if (reason === DisconnectReason.DUPLICATE_IDENTITY) this.endReason = 'elsewhere';
    else if (reason === DisconnectReason.CLIENT_INITIATED) this.endReason = 'left';
    else this.endReason = 'lost';
    this.devices = { mic: { state: 'off', note: null }, camera: { state: 'off', note: null }, screen: { state: 'off', note: null } };
    for (const element of this.audioHost.querySelectorAll('audio')) element.remove();
    this.emit();
  }

  private video(participant: Participant, publication: TrackPublication | undefined, source: 'camera' | 'screen', local: boolean): VideoRef | null {
    const track = publication?.track;
    if (!publication || !track || publication.isMuted) return null;
    const userId = userIdOf(participant.identity) ?? participant.identity;
    const dims = publication.dimensions;
    return {
      key: `${participant.identity}:${publication.trackSid}`,
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
    if (this.connection === 'connected' || this.connection === 'reconnecting') {
      const me = this.person(this.room.localParticipant, true);
      if (me) people.push(me);
      // Stable order: by join time, so tiles and faces never reshuffle while someone speaks.
      const remote = [...this.room.remoteParticipants.values()].map((participant) => this.person(participant, false))
        .filter((person): person is MediaPerson => !!person).sort((a, b) => a.joinedAt - b.joinedAt || a.userId.localeCompare(b.userId));
      people.push(...remote);
    }
    return {
      connection: this.connection,
      endReason: this.endReason,
      people,
      devices: this.devices,
      canPlayAudio: this.room.canPlaybackAudio,
      hearing: this.hearing,
    };
  }

  private emit() {
    this.snapshot = this.build();
    for (const listener of this.listeners) listener();
  }
}
