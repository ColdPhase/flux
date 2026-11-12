/**
 * What a person chose for sound in a call (#1244), kept on this device only. Pure: no browser objects, so the rules are
 * tested without a browser. Nothing here is sent to anyone.
 */

export const AUDIO_KEY = 'flux.live.audio';
/** Microphone and a person's volume go to 200 %; everything you hear only lowers (0 to 100 %). */
export const MAX_VOLUME = 200;
export const MAX_MASTER = 100;
/** Remembered per-person settings: the newest are kept. */
const MAX_PEOPLE = 200;

export interface PersonSound { volume: number; muted: boolean }

export interface AudioPrefs {
  /** The microphone chosen, `null` for the browser's default. The label is kept to say what went missing. */
  micId: string | null;
  micLabel: string | null;
  /** Percent, 0 to 200. */
  micVolume: number;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGain: boolean;
  speakerId: string | null;
  speakerLabel: string | null;
  /** Percent, 0 to 100: what you hear overall. */
  masterVolume: number;
  /** By person id; a person at 100 % who is not muted has no entry. */
  people: Record<string, PersonSound>;
}

export const DEFAULT_PREFS: AudioPrefs = {
  micId: null, micLabel: null, micVolume: 100,
  noiseSuppression: true, echoCancellation: true, autoGain: true,
  speakerId: null, speakerLabel: null, masterVolume: 100,
  people: {},
};

export type PrefsStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function clampVolume(value: unknown, max = MAX_VOLUME, fallback = 100): number {
  const number = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(0, Math.round(number)));
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 && value.length <= 300 ? value : null);
const flag = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);

/** A stored value of any shape becomes valid preferences; whatever is wrong falls back to its default. */
export function normalizePrefs(raw: unknown): AudioPrefs {
  const data = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const people: Record<string, PersonSound> = {};
  const stored = data.people && typeof data.people === 'object' ? Object.entries(data.people as Record<string, unknown>) : [];
  for (const [id, value] of stored.slice(-MAX_PEOPLE)) {
    if (!id || id.length > 128 || !value || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    const sound = { volume: clampVolume(entry.volume), muted: entry.muted === true };
    if (sound.volume !== 100 || sound.muted) people[id] = sound;
  }
  return {
    micId: text(data.micId), micLabel: text(data.micLabel),
    micVolume: clampVolume(data.micVolume, MAX_VOLUME, DEFAULT_PREFS.micVolume),
    noiseSuppression: flag(data.noiseSuppression, true),
    echoCancellation: flag(data.echoCancellation, true),
    autoGain: flag(data.autoGain, true),
    speakerId: text(data.speakerId), speakerLabel: text(data.speakerLabel),
    masterVolume: clampVolume(data.masterVolume, MAX_MASTER, DEFAULT_PREFS.masterVolume),
    people,
  };
}

/** Reads the stored preferences. A blocked, empty or damaged store gives the defaults; it never throws. */
export function readPrefs(storage: PrefsStorage | null | undefined): AudioPrefs {
  try {
    const stored = storage?.getItem(AUDIO_KEY);
    return normalizePrefs(stored ? JSON.parse(stored) : null);
  } catch { return normalizePrefs(null); }
}

/** Keeps the preferences on this device. A blocked or full store means they last only for this call. */
export function writePrefs(storage: PrefsStorage | null | undefined, prefs: AudioPrefs): boolean {
  try { storage?.setItem(AUDIO_KEY, JSON.stringify(prefs)); return !!storage; } catch { return false; }
}

export function personSound(prefs: AudioPrefs, userId: string): PersonSound {
  return prefs.people[userId] ?? { volume: 100, muted: false };
}

/** One person's volume or mute changes; the newest change is the last entry, and a default person has no entry. */
export function withPerson(prefs: AudioPrefs, userId: string, patch: Partial<PersonSound>): AudioPrefs {
  const next = { ...personSound(prefs, userId), ...patch };
  next.volume = clampVolume(next.volume);
  const { [userId]: _dropped, ...others } = prefs.people;
  void _dropped;
  const people = next.volume === 100 && !next.muted ? others : { ...others, [userId]: next };
  const entries = Object.entries(people);
  return { ...prefs, people: entries.length > MAX_PEOPLE ? Object.fromEntries(entries.slice(-MAX_PEOPLE)) : people };
}

/**
 * How loud one person's voice plays: the master volume times theirs, from 0 to 2 (above 1 needs a gain stage).
 * `limit` is the highest the browser can reach on the chosen output (1 where it cannot boost).
 */
export function voiceLevel(prefs: AudioPrefs, userId: string, limit = 2): number {
  const person = personSound(prefs, userId);
  if (person.muted) return 0;
  return Math.min(limit, (prefs.masterVolume / 100) * (person.volume / 100));
}

export interface DeviceChoice { id: string; label: string }

/**
 * The device a remembered choice stands for in the current list. `null` asks for the browser's default; a remembered device that
 * is no longer listed also falls back to the default and says so. Before the browser shows the list (no permission yet, ids empty)
 * nothing is known, so the choice is kept.
 */
export function resolveDevice(list: readonly DeviceChoice[], wanted: string | null): { id: string | null; missing: boolean } {
  if (wanted === null || wanted === 'default') return { id: null, missing: false };
  const known = list.filter((device) => device.id !== '');
  if (known.length === 0) return { id: wanted, missing: false };
  return known.some((device) => device.id === wanted) ? { id: wanted, missing: false } : { id: null, missing: true };
}

/** One calm sentence when a remembered device is gone, with the device's own name when it is known. */
export function missingDeviceNote(kind: 'microphone' | 'speakers', label: string | null): string {
  if (kind === 'microphone') return `${label ? `“${label}”` : 'The microphone'} was disconnected. Flux uses the default microphone.`;
  return `${label ? `“${label}”` : 'The speakers or headphones'} ${label ? 'was' : 'were'} disconnected. Sound plays through the default output.`;
}

/** What a level reading shows: the capture's RMS (0 to 1) times the chosen volume, on a scale of -60 to -6 dB. */
export function meterLevel(rms: number, volumePercent: number): number {
  const amplitude = rms * (volumePercent / 100);
  if (!(amplitude > 0)) return 0;
  const decibels = 20 * Math.log10(amplitude);
  return Math.min(1, Math.max(0, (decibels + 60) / 54));
}

/** The meter's text alternative; it changes only when the word does. */
export function meterWord(level: number): 'Speaking' | 'Quiet' {
  return level >= 0.18 ? 'Speaking' : 'Quiet';
}
