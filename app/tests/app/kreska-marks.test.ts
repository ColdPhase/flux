import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { EYE_CIRCLES, FACES, MARKS, SQUIRCLE, weights, type KreskaExpression } from '../../apps/web/src/ui/kreska-geometry.js';

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

// ---- Through the motion (#1342): every moving part keeps the gap at every frame of its animation. ----

type Point = [number, number];
type Part = { points: Point[]; width: number; centre?: Point };
/** One transform function as ui.css writes it: translate(x, y), rotate(a), scale(s) or scale(x, y), on the 24 grid. */
type Fn = { name: 'translate' | 'rotate' | 'scale'; values: number[] };

const css = readFileSync(new URL('../../apps/web/src/ui/ui.css', import.meta.url), 'utf8');

function parseTransform(text: string | undefined): Fn[] {
  if (!text || text.trim() === 'none') return [];
  return [...text.matchAll(/(\w+)\(([^)]*)\)/g)].map(([, name, args]) => {
    const values = args!.split(',').map((value) => parseFloat(value));
    if (name === 'translate') return { name, values: [values[0]!, values[1] ?? 0] };
    if (name === 'rotate') return { name, values: [values[0]!] };
    if (name === 'scale') return { name, values: [values[0]!, values[1] ?? values[0]!] };
    throw new Error(`write Kreska transforms as translate, rotate or scale, not ${name}`);
  });
}

const IDENTITY: Record<Fn['name'], number[]> = { translate: [0, 0], rotate: [0], scale: [1, 1] };

/** The functions between two keyframes, as CSS interpolates them: `none` takes the other side's functions at identity. */
function between(a: Fn[], b: Fn[], t: number): Fn[] {
  const from = a.length ? a : b.map(({ name }) => ({ name, values: IDENTITY[name] }));
  const to = b.length ? b : a.map(({ name }) => ({ name, values: IDENTITY[name] }));
  assert.deepEqual(from.map(({ name }) => name), to.map(({ name }) => name), 'neighbouring keyframes use the same transform functions');
  return from.map(({ name, values }, i) => ({ name, values: values.map((value, j) => value + (to[i]!.values[j]! - value) * t) }));
}

/** Applies the functions to a point around the origin, right to left as CSS does. Also returns how much they scale a stroke. */
function apply(fns: Fn[], origin: Point, [x, y]: Point): Point {
  let px = x - origin[0]; let py = y - origin[1];
  for (const { name, values } of [...fns].reverse()) {
    if (name === 'scale') { px *= values[0]!; py *= values[1]!; }
    else if (name === 'rotate') { const a = values[0]! * Math.PI / 180; [px, py] = [px * Math.cos(a) - py * Math.sin(a), px * Math.sin(a) + py * Math.cos(a)]; }
    else { px += values[0]!; py += values[1]!; }
  }
  return [px + origin[0], py + origin[1]];
}
const strokeScale = (fns: Fn[]) => fns.filter(({ name }) => name === 'scale').reduce((k, { values }) => k * Math.max(values[0]!, values[1]!), 1);

/** Every @keyframes kreska-* as [offset, transform functions] at each stop, with the static frame where 0% or 100% is left out. */
function keyframes(): Map<string, [number, Fn[]][]> {
  const out = new Map<string, [number, Fn[]][]>();
  for (const [, name, body] of css.matchAll(/@keyframes (kreska-[\w-]+) \{(.*)\}\s*$/gm)) {
    const stops: [number, Fn[]][] = [];
    for (const [, offsets, declarations] of body!.matchAll(/([\d%,\s]+|from|to)\{([^}]*)\}/g)) {
      for (const property of declarations!.matchAll(/([\w-]+):/g)) assert.ok(['transform', 'opacity'].includes(property[1]!), `${name} animates only transform and opacity, not ${property[1]}`);
      const transform = /transform:\s*([^;]+);/.exec(declarations!)?.[1];
      for (const offset of offsets!.split(',')) stops.push([offset.trim() === 'from' ? 0 : offset.trim() === 'to' ? 100 : parseFloat(offset), parseTransform(transform)]);
    }
    stops.sort((a, b) => a[0] - b[0]);
    if (stops[0]![0] !== 0) stops.unshift([0, []]);
    if (stops.at(-1)![0] !== 100) stops.push([100, []]);
    out.set(name!, stops);
  }
  return out;
}

/** The Kreska rules in ui.css that animate a part of one expression's face. */
function rules(): { expression: KreskaExpression; part: string; name: string; origin: string; box: string; declarations: string; moves: boolean }[] {
  return [...css.matchAll(/\.kreska((?:\[[^\]]+\])+) ([^{]+?) \{([^}]*)\}/g)].flatMap(([, attributes, part, declarations]) => {
    const name = /animation:\s*(kreska-[\w-]+)/.exec(declarations!)?.[1];
    const expression = /data-expression="(\w+)"/.exec(attributes!)?.[1] as KreskaExpression | undefined;
    if (!name || !expression) return [];
    return [{ expression, part: part!.trim(), name, origin: /transform-origin:\s*([^;]+);/.exec(declarations!)?.[1] ?? '0px 0px',
      box: /transform-box:\s*([^;]+);/.exec(declarations!)?.[1] ?? 'view-box', declarations: declarations!, moves: attributes!.includes('[data-moves]') }];
  });
}

/** The drawn parts a rule's selector moves, at a size (the eyes, brow and marks take the size's line weights). */
function parts(expression: KreskaExpression, part: string, size: number): Part[] {
  const face = FACES[expression];
  const [, eyes, brow] = weights(size);
  const path = (d: string | undefined, width: number): Part[] => (d ? [{ points: sample(d), width }] : []);
  const circles = (): Part[] => EYE_CIRCLES.map(({ cx, cy, r, width }) => ({ width, centre: [cx, cy] as Point,
    points: Array.from({ length: 48 }, (_, i) => [cx + r * Math.cos(i * Math.PI / 24), cy + r * Math.sin(i * Math.PI / 24)] as Point) }));
  const mark = face.extra && face.extra in MARKS ? MARKS[face.extra as keyof typeof MARKS] : undefined;
  switch (part) {
    case '.kreska__brow': return path(face.brow, brow);
    case '.kreska__eyes': return expression === 'surprised' ? circles() : [...path(face.eyes, eyes), ...path(face.shut, eyes), ...path(face.open, eyes)];
    case '.kreska__eyes circle': return circles();
    case '.kreska__shut': return path(face.shut, eyes);
    case '.kreska__open': return path(face.open, eyes);
    case '.kreska__face': return [...path(face.eyes, eyes), ...path(face.shut, eyes), ...path(face.brow, brow)];
    case '.kreska__extra': assert.ok(mark, `${expression} has a mark`); return [{ points: sample(mark.d), width: mark.width }];
    default: throw new Error(`the marks test does not know the part ${part}`);
  }
}

/** The smallest gap from the frame to the moved part over the whole animation, in pixels at this size, and its extent on the grid. */
function motionGap(rule: ReturnType<typeof rules>[number], stops: [number, Fn[]][], size: number): { gap: number; min: Point; max: Point } {
  let gapPx = Infinity; const min: Point = [Infinity, Infinity]; const max: Point = [-Infinity, -Infinity];
  for (const part of parts(rule.expression, rule.part, size)) {
    const origin: Point = rule.box === 'fill-box' && rule.origin === 'center' ? part.centre! : rule.origin.split(/\s+/).map(parseFloat) as Point;
    for (let k = 0; k + 1 < stops.length; k += 1) {
      for (let step = 0; step <= 8; step += 1) {
        const fns = between(stops[k]![1], stops[k + 1]![1], step / 8);
        const width = part.width * strokeScale(fns);
        let near = Infinity;
        for (const point of part.points) {
          const [x, y] = apply(fns, origin, point);
          for (const [fx, fy] of frame) near = Math.min(near, Math.hypot(fx - x, fy - y));
          min[0] = Math.min(min[0], x - width / 2); min[1] = Math.min(min[1], y - width / 2);
          max[0] = Math.max(max[0], x + width / 2); max[1] = Math.max(max[1], y + width / 2);
        }
        gapPx = Math.min(gapPx, (near - (weights(size)[0] + width) / 2) * size / 24);
      }
    }
  }
  return { gap: gapPx, min, max };
}

test('every moving part of every expression keeps its gap from the frame through the whole motion, at every size (#1342)', () => {
  const frames = keyframes();
  const moving = rules();
  assert.ok(moving.length >= 20, `found ${moving.length} Kreska motion rules`);
  for (const rule of moving) {
    const stops = frames.get(rule.name);
    assert.ok(stops, `@keyframes ${rule.name} is in ui.css`);
    if (stops.every(([, fns]) => !fns.length)) continue; // opacity only
    for (const size of SIZES) {
      const { gap: measured, min, max } = motionGap(rule, stops, size);
      // The writing pen is drawn inside the frame closer than 0.5px on small faces; its strokes never bring it any closer.
      const still = motionGap(rule, [[0, []], [100, []]], size).gap;
      assert.ok(measured >= Math.min(0.5, still) - 1e-9, `${rule.expression} ${rule.part} (${rule.name}) at ${size}px: gap ${measured.toFixed(2)}px`);
      if (rule.part === '.kreska__extra') assert.ok(min[0] >= 0 && min[1] >= 0 && max[0] <= 24 && max[1] <= 24, `${rule.expression} mark stays in the 24 box while it moves: ${min} ${max}`);
    }
  }
});

test('each expression has its motion: a one-shot plays once, only the ongoing states loop, all on the motion tokens (#1342)', () => {
  const moving = rules();
  const loops = new Set(moving.filter(({ declarations }) => /\binfinite\b/.test(declarations)).map(({ expression }) => expression));
  assert.deepEqual([...loops].sort(), ['asleep', 'idle', 'loading', 'thinking', 'working']);
  const expressions = new Set(moving.map(({ expression }) => expression));
  for (const expression of Object.keys(FACES)) assert.ok(expressions.has(expression as KreskaExpression), `${expression} moves`);
  for (const { expression, name, declarations, moves } of moving) {
    const animation = /animation:\s*([^;]+);/.exec(declarations)![1]!;
    assert.match(animation, /^kreska-[\w-]+ (var\(--dur-[\w-]+\)|calc\(var\(--dur-[\w-]+\) [*/] [\d.]+\)) var\(--ease-(out|loop)\)( infinite)?$/, `${expression} ${name} takes its duration and easing from the tokens`);
    // Only the three loops that moved before #1342 run at 20px or less; every other motion needs a face with a state above 20px.
    if (!['thinking', 'loading', 'working'].includes(expression)) assert.ok(moves, `${expression} ${name} moves only with data-moves`);
  }
  // Every Kreska motion is off under reduced motion and with Kreska's small moments off.
  const media = css.slice(css.indexOf('@media (prefers-reduced-motion: no-preference) {', css.indexOf('Kreska moves only where it says something true')));
  const block = media.slice(0, media.indexOf('\n}\n'));
  for (const line of block.split('\n').filter((text) => text.includes('.kreska['))) assert.ok(line.trimStart().startsWith(':root:not([data-motion="reduce"]):not([data-kreska="off"]) .kreska'), line);
  assert.equal(moving.length, block.split('\n').filter((text) => /animation:\s*kreska-/.test(text)).length, 'every Kreska motion rule sits behind the reduced-motion and small-moments gate');
});

test('the check finds a mark that would touch the frame while it moves', () => {
  const rule = { expression: 'hello' as const, part: '.kreska__extra', name: 'test', origin: '24px 0px', box: 'view-box', declarations: '', moves: true };
  assert.ok(motionGap(rule, [[0, []], [100, [{ name: 'translate', values: [-1.5, 1.5] }]]], 80).gap < 0.5, 'a wave pushed 1.5 toward the face would touch it');
});
