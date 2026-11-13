import type { CSSProperties, ReactNode } from 'react';
import { EYE_CIRCLES, FACES, MARKS, SQUIRCLE, TILE, weights, type Extra, type KreskaExpression } from './kreska-geometry.js';
import { useLoopPause } from './motion.js';

/**
 * Kreska: Flux's logo, every agent's icon and the mascot (final design F-026, guide §3). A monoline
 * face in a squircle: one raised brow, two eyes, no mouth. The paths are the design's own (24×24).
 *
 * The expression replaces status dots and follows real state only. Every expression is a complete
 * static frame, and each has its own short motion in ui.css (#1342): a one-shot when the face appears or its expression
 * changes, a loop only for an ongoing state. Nothing moves under reduced motion or with the small moments off.
 */
export type { KreskaExpression };

const line = (d: string, width: number, className?: string) => (
  <path d={d} className={className} fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" />
);

function extra(kind: Extra | undefined, size: number): ReactNode {
  // Small icons keep only the extras that replace the eyes; the rest would be noise below 24px.
  if (!kind || (size <= 20 && kind !== 'circles' && kind !== 'dots')) return null;
  switch (kind) {
    case 'circles':
      return <g className="kreska__eyes">{EYE_CIRCLES.map(({ cx, cy, r, width }) => <circle key={cx} cx={cx} cy={cy} r={r} fill="none" stroke="currentColor" strokeWidth={width} />)}</g>;
    case 'dots':
      return <g className="kreska__dots"><circle cx="8.6" cy="12.6" r="1.1" fill="currentColor" /><circle cx="12" cy="12.6" r="1.1" fill="currentColor" opacity=".55" /><circle cx="15.4" cy="12.6" r="1.1" fill="currentColor" opacity=".25" /></g>;
    case 'sparkle':
      return <path className="kreska__extra" d={MARKS.sparkle.d} fill="none" stroke="currentColor" strokeWidth={MARKS.sparkle.width} strokeLinecap="round" />;
    case 'wave':
      return <path className="kreska__extra" d={MARKS.wave.d} fill="none" stroke="currentColor" strokeWidth={MARKS.wave.width} strokeLinecap="round" />;
    case 'z':
      return <path className="kreska__extra" d={MARKS.z.d} fill="none" stroke="currentColor" strokeWidth={MARKS.z.width} strokeLinecap="round" strokeLinejoin="round" />;
    case 'pen':
      return <path className="kreska__extra" d={MARKS.pen.d} fill="none" stroke="currentColor" strokeWidth={MARKS.pen.width} strokeLinecap="round" />;
  }
}

/** The seven muted agent colours (equal lightness, OKLCH). Each agent has its own (F-036 AG-1), and ink is a first agent's. */
export const AGENT_HUES = ['clay', 'ochre', 'sage', 'teal', 'indigo', 'plum', 'rose'] as const;
export type AgentHue = (typeof AGENT_HUES)[number] | 'ink';

/** A stable colour for an agent: the same agent always gets the same one. */
export function agentHue(agentId: string): AgentHue {
  let hash = 0;
  for (const char of agentId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AGENT_HUES[hash % AGENT_HUES.length]!;
}

export interface KreskaProps {
  expression?: KreskaExpression;
  size?: number;
  /** The agent's own colour (final design §2): it shows everywhere the agent appears. Without one the face is plain. */
  hue?: AgentHue;
  /** An accessible name; without one the face is decorative and the text beside it names the agent. */
  label?: string;
  className?: string;
  style?: CSSProperties;
}

/** The loops (ongoing states): only these run on, so only these pause off screen. The rest play once and end on the static frame. */
const LOOPS: ReadonlySet<KreskaExpression> = new Set<KreskaExpression>(['thinking', 'loading', 'working', 'idle', 'asleep']);
/** The loops that moved at every size before #1342; at 20px or less a face keeps only these (agent icons there never animate marks). */
const SMALL_LOOPS: ReadonlySet<KreskaExpression> = new Set<KreskaExpression>(['thinking', 'loading', 'working']);

/** Kreska as an agent icon (outline squircle on --el) or, at 56–112px, the mascot. */
export function Kreska({ expression, size = 24, hue, label, className, style }: KreskaProps) {
  const [frame, eyes, brow] = weights(size);
  const shown = expression ?? 'idle';
  const face = FACES[shown];
  // A face with a state above 20px moves (ui.css keys every motion but the three small loops on data-moves); a face without a
  // state (an agent's icon beside its name) stays still (#1342).
  const moves = expression !== undefined && size > 20;
  const loops = moves ? LOOPS.has(shown) : SMALL_LOOPS.has(shown);
  // A moving face pauses while hidden, off screen or under a modal, wherever it is shown (#155 AC-4).
  const loop = useLoopPause<HTMLSpanElement>();
  return (
    <span ref={loops ? loop : undefined} className={`kreska${hue ? ` kreska--${hue}` : ''}${className ? ` ${className}` : ''}`} data-expression={shown}
      data-moves={moves ? '' : undefined} style={{ width: size, height: size, ...style }} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {/* Keyed by the expression, so a change plays the new expression's motion from its start. */}
      <svg key={shown} viewBox="0 0 24 24" width={size} height={size}>
        {line(SQUIRCLE, frame, 'kreska__frame')}
        <g className="kreska__face">
          {face.eyes ? <g className="kreska__eyes">{line(face.eyes, eyes)}{face.shut ? line(face.shut, eyes, 'kreska__shut') : null}{face.open ? <path d={face.open} className="kreska__open" opacity="0" fill="none" stroke="currentColor" strokeWidth={eyes} strokeLinecap="round" /> : null}</g> : null}
          {line(face.brow, brow, 'kreska__brow')}
        </g>
        {extra(face.extra, size)}
      </svg>
    </span>
  );
}

/** The Flux logo: a solid tile in the inverted ink with the face knocked out. Nothing leaves the tile. */
export function FluxLogo({ size = 24, label }: { size?: number; label?: string }) {
  const [, eyes, brow] = weights(size);
  const face = FACES.idle;
  return (
    <svg className="flux-logo" viewBox="0 0 24 24" width={size} height={size} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <path d={TILE} className="flux-logo__tile" />
      <g className="flux-logo__face" transform="translate(12 12) scale(1.14) translate(-12 -12.4)">
        {line(face.eyes, eyes)}
        {line(face.brow, brow)}
      </g>
    </svg>
  );
}
