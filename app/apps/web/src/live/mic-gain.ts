import type { AudioProcessorOptions, Track, TrackProcessor } from 'livekit-client';

/**
 * The microphone volume (#1244): a Web Audio `GainNode` between the capture and the sender, set as the audio track's
 * processor so LiveKit keeps the device, mute and restart handling. At 100 % no processor is installed at all.
 */
export class GainProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  readonly name = 'flux-microphone-volume';
  processedTrack?: MediaStreamTrack;
  private context?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private gain?: GainNode;
  private destination?: MediaStreamAudioDestinationNode;

  constructor(private percent: number) {}

  async init(options: AudioProcessorOptions): Promise<void> {
    this.teardown();
    const context = options.audioContext;
    this.context = context;
    this.gain = context.createGain();
    this.gain.gain.value = this.percent / 100;
    this.destination = context.createMediaStreamDestination();
    this.gain.connect(this.destination);
    this.processedTrack = this.destination.stream.getAudioTracks()[0];
    this.connect(options.track);
  }

  /** A restarted capture (another device, a changed switch) feeds the same graph; a new context needs a new one. */
  async restart(options: AudioProcessorOptions): Promise<void> {
    if (options.audioContext !== this.context || !this.gain || !this.destination) return this.init(options);
    this.source?.disconnect();
    this.connect(options.track);
  }

  async destroy(): Promise<void> { this.teardown(); }

  /** Takes effect within a few milliseconds, with no click. */
  setVolume(percent: number) {
    this.percent = percent;
    if (this.gain && this.context) this.gain.gain.setTargetAtTime(percent / 100, this.context.currentTime, 0.015);
  }

  private connect(track: MediaStreamTrack) {
    if (!this.context || !this.gain) return;
    this.source = this.context.createMediaStreamSource(new MediaStream([track]));
    this.source.connect(this.gain);
  }

  private teardown() {
    this.source?.disconnect();
    this.gain?.disconnect();
    this.processedTrack?.stop();
    this.source = this.gain = this.destination = this.processedTrack = undefined;
  }
}

/** Reads how loud a track is right now, for the meter. It listens only; the track is not changed or sent anywhere. */
export class LevelTap {
  private readonly source: MediaStreamAudioSourceNode;
  private readonly analyser: AnalyserNode;
  private readonly samples: Float32Array<ArrayBuffer>;
  readonly track: MediaStreamTrack;

  constructor(context: AudioContext, track: MediaStreamTrack) {
    this.track = track;
    this.source = context.createMediaStreamSource(new MediaStream([track]));
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0;
    this.samples = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));
    this.source.connect(this.analyser);
  }

  /** Root mean square of the latest samples, 0 to 1. */
  rms(): number {
    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (const sample of this.samples) sum += sample * sample;
    return Math.sqrt(sum / this.samples.length);
  }

  close() {
    this.source.disconnect();
    this.analyser.disconnect();
  }
}
