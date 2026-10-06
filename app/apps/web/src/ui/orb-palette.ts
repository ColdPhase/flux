/**
 * Agent orbs (F-025 PA-2, docs/design/people-and-ai.md), kept free of the DOM so views and unit tests share them.
 * An agent's face on a phone is an orb in one of eight palettes. The person's built-in assistant is always violet;
 * every other agent gets one of the remaining seven from a stable hash of its agent id, so a connected agent never
 * looks like your assistant and the same agent has the same colour in every view, on every device. The colour is
 * never the only mark: the name and an "AI" badge always go with it. People never get an orb.
 */
export const ORB_PALETTES = ['violet', 'ember', 'rose', 'gold', 'fern', 'teal', 'ocean', 'plum'] as const;
export type OrbPalette = (typeof ORB_PALETTES)[number];

/** The person's built-in assistant (the agent in Flux). */
export const ASSISTANT_PALETTE: OrbPalette = 'violet';

/** The palettes an agent connection can get: all but the assistant's. */
export const AGENT_PALETTES: readonly OrbPalette[] = ORB_PALETTES.filter((palette) => palette !== ASSISTANT_PALETTE);

/**
 * 32-bit FNV-1a over the id's UTF-16 code units, lower-cased so a UUID written either way is the same agent.
 * Pure arithmetic: no randomness, clock, locale or storage, so it is the same in every browser and session.
 */
export function orbHash(id: string): number {
  let hash = 0x811c9dc5;
  const text = id.trim().toLowerCase();
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** The palette of an agent (a connection's agent or any other non-assistant agent), from its agent id. */
export function agentPalette(agentId: string): OrbPalette {
  return AGENT_PALETTES[orbHash(agentId) % AGENT_PALETTES.length]!;
}

export type OrbSize = 'sm' | 'md' | 'lg';

/**
 * The orb's classes. `live` adds the slow turn; CSS runs it only without reduced motion, and useLoopPause pauses it
 * while the page is hidden, the orb is off screen or a modal covers it (#155).
 */
export function orbClassName(palette: OrbPalette, size: OrbSize, live: boolean): string {
  return `ui-orb ui-orb--${size} ui-orb--${palette}${live ? ' ui-orb--live' : ''}`;
}
