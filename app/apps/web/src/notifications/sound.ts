import type { NotificationSound } from '@flux/contracts';
import { getPreferences } from './api';

/**
 * The sounds of an open tab, behind one "Sounds" switch (founder decision, Hubert, 2026-11-13, #1419 item 18, which merges #1243's two):
 * a short tone for direct messages, mentions and questions, and one soft chime for a direct call invitation, on by default. They play
 * only with a notice, which the server sends only when the level lets it through and it is not quiet hours, so both follow those too.
 * Never a loop. The sounds are synthesised (no file): a short soft tone that fades, two notes for a call.
 */
/** The "Sounds" switch: the switch writes both fields of the stored pair together, and `calls` is the one that is read. */
export const soundsOn = (sound: NotificationSound) => sound.calls;
/** What the switch stores: both fields move together. */
export const soundsChange = (on: boolean): NotificationSound => ({ messages: on, calls: on });

let known: { identity: string; sound: NotificationSound } | null = null;
let reading: { identity: string; promise: Promise<NotificationSound | null> } | null = null;

/** Settings has the person's current switches: the next notice uses them without reading them again. */
export function noteSoundPreferences(identity: string, sound: NotificationSound) {
  known = { identity, sound };
  reading = null;
}

/** The switches, read once per signed-in person the first time a notice arrives (an idle tab reads nothing). */
export async function soundPreferences(identity: string): Promise<NotificationSound | null> {
  if (known?.identity === identity) return known.sound;
  if (reading?.identity !== identity) {
    const promise = getPreferences().then((prefs) => { noteSoundPreferences(identity, prefs.sound); return prefs.sound; }, () => null);
    reading = { identity, promise };
  }
  return reading.promise;
}

let context: AudioContext | null = null;
function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context) return null;
  context ??= new Context();
  return context;
}

// A browser lets a page make sound only after the person has interacted with it: the first press or key wakes the audio once.
if (typeof window !== 'undefined') {
  const wake = () => { try { void audio()?.resume(); } catch { /* no audio */ } };
  window.addEventListener('pointerdown', wake, { once: true, capture: true });
  window.addEventListener('keydown', wake, { once: true, capture: true });
}

function tone(ctx: AudioContext, frequency: number, at: number, length: number, peak: number) {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(peak, at + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
  oscillator.connect(gain).connect(ctx.destination);
  oscillator.start(at);
  oscillator.stop(at + length + 0.02);
}

/** One soft sound: `message` is a single short tone, `call` two notes. Silent when the browser does not allow sound yet. */
export function playSound(kind: 'message' | 'call') {
  try {
    const ctx = audio();
    if (!ctx || ctx.state === 'closed') return;
    const at = ctx.currentTime + 0.01;
    if (kind === 'message') tone(ctx, 880, at, 0.35, 0.06);
    else { tone(ctx, 659.25, at, 0.5, 0.07); tone(ctx, 987.77, at + 0.16, 0.7, 0.06); }
  } catch { /* no sound is better than a broken page */ }
}
