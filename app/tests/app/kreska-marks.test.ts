import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MARKS, SQUIRCLE, weights } from '../../apps/web/src/ui/kreska-geometry.js';

/** Points along an absolute SVG path made of M, L, H, V, C, Q and Z: enough for Kreska's own paths. */
function sample(d: string, steps = 24): [number, number][] {
  const tokens = d.match(/[MLHVCQZ]|-?\d*\.?\d+/g) ?? [];
  const out: [number, number][] = [];
  let at: [number, number] = [0, 0];
  let start: [number, number] = [0, 0];
  let command = '';
  let i = 0;
  const next = () => Number(tokens[i++]);
  const line = (to: [number, number]) => { for (let t = 1; t <= steps; t += 1) out.push([at[0] + (to[0] - at[0]) * t / steps, at[1] + (to[1] - at[1]) * t / steps]); at = to; };
  while (i < tokens.length) {
    if (/[MLHVCQZ]/.test(tokens[i]!)) command = tokens[i++]!;
    if (command === 'M') { at = [next(), next()]; start = at; out.push(at); command = 'L'; }
    else if (command === 'L') line([next(), next()]);
    else if (command === 'H') line([next(), at[1]]);
    else if (command === 'V') line([at[0], next()]);
    else if (command === 'Z') line(start);
    else if (command === 'C') {
      const a: [number, number] = [next(), next()]; const b: [number, number] = [next(), next()]; const to: [number, number] = [next(), next()];
      for (let t = 1; t <= steps; t += 1) {
        const u = t / steps; const k = [(1 - u) ** 3, 3 * (1 - u) ** 2 * u, 3 * (1 - u) * u * u, u ** 3];
        out.push([k[0]! * at[0] + k[1]! * a[0] + k[2]! * b[0] + k[3]! * to[0], k[0]! * at[1] + k[1]! * a[1] + k[2]! * b[1] + k[3]! * to[1]]);
      }
      at = to;
    } else if (command === 'Q') {
      const a: [number, number] = [next(), next()]; const to: [number, number] = [next(), next()];
      for (let t = 1; t <= steps; t += 1) {
        const u = t / steps;
        out.push([(1 - u) ** 2 * at[0] + 2 * (1 - u) * u * a[0] + u * u * to[0], (1 - u) ** 2 * at[1] + 2 * (1 - u) * u * a[1] + u * u * to[1]]);
      }
      at = to;
    } else throw new Error(`unsupported path command ${command}`);
  }
  return out;
}

const frame = sample(SQUIRCLE);
/** The gap between the frame's edge and a mark's edge, in pixels at this size: centre lines apart, less half of both strokes. */
function gap(mark: { d: string; width: number }, size: number): number {
  const points = sample(mark.d);
  let near = Infinity;
  for (const [x, y] of frame) for (const [px, py] of points) near = Math.min(near, Math.hypot(x - px, y - py));
  return (near - (weights(size)[0] + mark.width) / 2) * size / 24;
}

const SIZES = [24, 32, 40, 48, 56, 64, 80, 88, 112];

test('the hello wave, the asleep z and the celebrate sparkle lie outside the frame with a gap at every size (#849)', () => {
  for (const [name, mark] of [['hello wave', MARKS.wave], ['asleep z', MARKS.z], ['celebrate sparkle', MARKS.sparkle]] as const) {
    for (const size of SIZES) assert.ok(gap(mark, size) >= 0.5, `${name} at ${size}px: gap ${gap(mark, size).toFixed(2)}px`);
  }
});

test('the marks stay inside the 24 box', () => {
  for (const [name, mark] of [['hello wave', MARKS.wave], ['asleep z', MARKS.z], ['celebrate sparkle', MARKS.sparkle]] as const) {
    const points = sample(mark.d);
    for (const [x, y] of points) assert.ok(x - mark.width / 2 >= 0 && x + mark.width / 2 <= 24 && y - mark.width / 2 >= 0 && y + mark.width / 2 <= 24, `${name} point ${x},${y}`);
  }
});

test('the check fails for the marks as they were drawn before the fix', () => {
  const old = { d: 'M21.6 4.6C22.6 5.6 23.1 6.8 23.2 8.2M20.4 6C21 6.6 21.3 7.3 21.4 8.1', width: 1 };
  assert.ok(gap(old, 80) < 0, 'the old wave started on the frame line');
});
