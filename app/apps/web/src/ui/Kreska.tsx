import type { CSSProperties, ReactNode } from 'react';

/**
 * Kreska: Flux's logo, every agent's icon and the mascot (final design F-026, guide §3). A monoline
 * face in a squircle: one raised brow, two eyes, no mouth. The paths are the design's own (24×24).
 *
 * The expression replaces status dots and follows real state only. Every expression is a complete
 * static frame; the motion in ui.css runs only when reduced motion is off.
 */
export type KreskaExpression =
  | 'idle' | 'working' | 'thinking' | 'writing' | 'reading' | 'waiting' | 'asking' | 'looking'
  | 'loading' | 'surprised' | 'done' | 'wink' | 'celebrate' | 'hello' | 'asleep' | 'worried';

const SQUIRCLE = 'M8.6 2.6H15.4C19 2.6 21.4 5 21.4 8.6V15.4C21.4 19 19 21.4 15.4 21.4H8.6C5 21.4 2.6 19 2.6 15.4V8.6C2.6 5 5 2.6 8.6 2.6Z';
const TILE = 'M7 0H17C21.2 0 24 2.8 24 7V17C24 21.2 21.2 24 17 24H7C2.8 24 0 21.2 0 17V7C0 2.8 2.8 0 7 0Z';

type Extra = 'circles' | 'sparkle' | 'wave' | 'z' | 'dots' | 'pen';
const FACES: Record<KreskaExpression, { eyes: string; brow: string; extra?: Extra }> = {
  idle: { eyes: 'M9.3 11.2V13.8M14.7 11.2V13.8', brow: 'M7.3 8.1 10.5 7.2' },
  working: { eyes: 'M9.3 12V13.4M14.7 12V13.4', brow: 'M7.3 8.7 10.7 8.5' },
  thinking: { eyes: 'M10 10.5V13.1M15.4 10.5V13.1', brow: 'M7.4 7.1 10.6 5.9' },
  waiting: { eyes: 'M8.8 12.2V14.8M14.2 12.2V14.8', brow: 'M7.3 8.4 10.5 7.8' },
  asking: { eyes: 'M9.3 10.7V13.3M14.7 11.9V13.7', brow: 'M7.2 7.2 10.4 5.7' },
  reading: { eyes: 'M8.3 12.8V14.4M13.7 12.8V14.4', brow: 'M7.3 9 10.5 8.6' },
  looking: { eyes: 'M7.9 11.6V14.2M13.3 11.6V14.2', brow: 'M6.6 8.2 9.8 7.5' },
  surprised: { eyes: '', brow: 'M7.3 6.9 10.5 6.1', extra: 'circles' },
  done: { eyes: 'M7.9 13.3 9.3 11.7 10.7 13.3M13.3 13.3 14.7 11.7 16.1 13.3', brow: 'M7.3 8 10.5 7.4' },
  celebrate: { eyes: 'M7.9 13.3 9.3 11.7 10.7 13.3M13.3 13.3 14.7 11.7 16.1 13.3', brow: 'M7.3 7.4 10.5 6.6', extra: 'sparkle' },
  wink: { eyes: 'M9.3 11.2V13.8M13.4 12.6H16', brow: 'M7.3 7.8 10.5 6.8' },
  hello: { eyes: 'M9.3 11.2V13.8M13.4 12.6H16', brow: 'M7.3 7 10.5 5.9', extra: 'wave' },
  asleep: { eyes: 'M8 12.8Q9.3 13.8 10.6 12.8M13.4 12.8Q14.7 13.8 16 12.8', brow: 'M7.3 9 10.5 8.8', extra: 'z' },
  worried: { eyes: 'M9.3 11.8V13.6M14.7 11.8V13.6', brow: 'M7.4 7.3 10.6 8.4' },
  loading: { eyes: '', brow: 'M7.3 8.1 10.5 7.2', extra: 'dots' },
  writing: { eyes: 'M10.1 12.4V14.2M15.5 12.4V14.2', brow: 'M7.6 8.6 10.8 8.1', extra: 'pen' },
};

/** Frame, eyes and brow line weights for the drawn size (guide §3). */
function weights(size: number): [number, number, number] {
  if (size >= 64) return [1.15, 1.7, 1.3];
  if (size >= 40) return [1.5, 2.0, 1.55];
  return [1.8, 2.2, 1.7];
}

const line = (d: string, width: number, className?: string) => (
  <path d={d} className={className} fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" />
);

function extra(kind: Extra | undefined, size: number): ReactNode {
  // Small icons keep only the extras that replace the eyes; the rest would be noise below 24px.
  if (!kind || (size <= 20 && kind !== 'circles' && kind !== 'dots')) return null;
  switch (kind) {
    case 'circles':
      return <g className="kreska__eyes"><circle cx="9.3" cy="12.4" r="1.25" fill="none" stroke="currentColor" strokeWidth="1.6" /><circle cx="14.7" cy="12.4" r="1.25" fill="none" stroke="currentColor" strokeWidth="1.6" /></g>;
    case 'dots':
      return <g className="kreska__dots"><circle cx="8.6" cy="12.6" r="1.1" fill="currentColor" /><circle cx="12" cy="12.6" r="1.1" fill="currentColor" opacity=".55" /><circle cx="15.4" cy="12.6" r="1.1" fill="currentColor" opacity=".25" /></g>;
    case 'sparkle':
      return <path className="kreska__extra" d="M19.4 .6V2.8M18.3 1.7H20.5M23 5.2V6.8M22.2 6H23.8" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />;
    case 'wave':
      return <path className="kreska__extra" d="M21.6 4.6C22.6 5.6 23.1 6.8 23.2 8.2M20.4 6C21 6.6 21.3 7.3 21.4 8.1" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />;
    case 'z':
      return <path className="kreska__extra" d="M17.2 4.6H19.4L17.2 6.8H19.4M20.4 1.4H22L20.4 3H22" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />;
    case 'pen':
      return <path className="kreska__extra" d="M17.4 18.2 19.8 15.8M15.6 18.6H17" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />;
  }
}

/** The seven muted agent colours (equal lightness, OKLCH), shown only in the Agents section. */
export const AGENT_HUES = ['clay', 'ochre', 'sage', 'teal', 'indigo', 'plum', 'rose'] as const;
export type AgentHue = (typeof AGENT_HUES)[number];

/** A stable colour for an agent: the same agent always gets the same one. */
export function agentHue(agentId: string): AgentHue {
  let hash = 0;
  for (const char of agentId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AGENT_HUES[hash % AGENT_HUES.length]!;
}

export interface KreskaProps {
  expression?: KreskaExpression;
  size?: number;
  /** The agent's colour; pass it only inside the Agents section. Everywhere else agents are monochrome. */
  hue?: AgentHue;
  /** An accessible name; without one the face is decorative and the text beside it names the agent. */
  label?: string;
  className?: string;
  style?: CSSProperties;
}

/** Kreska as an agent icon (outline squircle on --el) or, at 56–112px, the mascot. */
export function Kreska({ expression = 'idle', size = 24, hue, label, className, style }: KreskaProps) {
  const [frame, eyes, brow] = weights(size);
  const face = FACES[expression];
  return (
    <span className={`kreska${hue ? ` kreska--${hue}` : ''}${className ? ` ${className}` : ''}`} data-expression={expression}
      style={{ width: size, height: size, ...style }} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <svg viewBox="0 0 24 24" width={size} height={size}>
        {line(SQUIRCLE, frame, 'kreska__frame')}
        {face.eyes ? <g className="kreska__eyes">{line(face.eyes, eyes)}</g> : null}
        {line(face.brow, brow, 'kreska__brow')}
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

/** The logo with the "flux" wordmark. */
export function FluxLockup({ size = 22, label = 'Flux' }: { size?: number; label?: string }) {
  return (
    <span className="flux-lockup" role="img" aria-label={label}>
      <FluxLogo size={size} />
      <b aria-hidden="true">flux</b>
    </span>
  );
}
