import { personSound, voiceLevel, type AudioPrefs } from './audio-prefs';

/** What the browser can do on the speaker side; the interface draws only what works (docs/product/live-collaboration.md). */
export interface PlaybackSupport {
  /** The media volume can be set (not on iOS, where the hardware buttons own it). */
  volume: boolean;
}

interface Voice { userId: string; route: { source: MediaStreamAudioSourceNode; gain: GainNode } | null }

/**
 * How each remote voice plays on this device only (#1244): the master volume times the person's volume, and Mute for me. Up to 100 %
 * it is the voice's own `<audio>` volume. Above 100 % the stream goes through a Web Audio gain (LiveKit's own way of boosting a
 * voice) and the element is muted, so a boosted voice is never heard twice. Nothing here reaches anyone else.
 */
export class Playback {
  private readonly voices = new Map<HTMLMediaElement, Voice>();

  constructor(private readonly deps: {
    prefs(): AudioPrefs;
    hearing(): boolean;
    support(): PlaybackSupport;
    /** The highest level a voice can reach: 2 where a gain stage can play on the chosen output, else 1. */
    limit(): number;
    /** A running context for a boosted voice, or `null`. */
    context(): AudioContext | null;
  }) {}

  attach(element: HTMLMediaElement, userId: string) {
    this.voices.set(element, { userId, route: null });
    this.apply(element);
  }

  detach(element: HTMLMediaElement) {
    const voice = this.voices.get(element);
    if (voice) this.unroute(voice);
    this.voices.delete(element);
  }

  clear() {
    for (const element of [...this.voices.keys()]) this.detach(element);
  }

  /** Every voice again, after the master volume, a person, the output or Quiet changed. */
  refresh() {
    for (const element of this.voices.keys()) this.apply(element);
  }

  /** The route's gain nodes use the context's output, which a chosen speaker has to be set on too. */
  hasRoutes(): boolean {
    return [...this.voices.values()].some((voice) => voice.route);
  }

  private apply(element: HTMLMediaElement) {
    const voice = this.voices.get(element);
    if (!voice) return;
    const prefs = this.deps.prefs();
    const silent = !this.deps.hearing() || personSound(prefs, voice.userId).muted;
    const level = voiceLevel(prefs, voice.userId, this.deps.limit());
    if (!silent && level > 1 && this.route(voice, element, level)) { element.dataset.liveGain = String(level); return; }
    this.unroute(voice);
    delete element.dataset.liveGain;
    element.muted = silent;
    if (this.deps.support().volume) element.volume = Math.min(1, level);
  }

  private route(voice: Voice, element: HTMLMediaElement, level: number): boolean {
    const stream = element.srcObject;
    const context = this.deps.context();
    if (!context || !(stream instanceof MediaStream)) return false;
    try {
      if (!voice.route) {
        const source = context.createMediaStreamSource(stream);
        const gain = context.createGain();
        source.connect(gain);
        gain.connect(context.destination);
        voice.route = { source, gain };
      }
      voice.route.gain.gain.value = level;
      // The element keeps playing (a stream flows only while something plays it) but silently: the graph is the voice.
      element.muted = true;
      return true;
    } catch { return false; }
  }

  private unroute(voice: Voice) {
    if (!voice.route) return;
    voice.route.source.disconnect();
    voice.route.gain.disconnect();
    voice.route = null;
  }
}
