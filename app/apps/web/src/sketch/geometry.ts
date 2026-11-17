import type { Thought } from '@flux/contracts';

// Plane geometry for the map: where links attach, how they curve and where a new thought fits.

export interface Rect { x: number; y: number; w: number; h: number }

/** Space kept around the content so the canvas never ends at a thought's edge. */
export const PAD = 24;

/** Empty plane beyond the thoughts on every side, so the map has no edge (#509). */
export const PLANE_MARGIN = 1200;

/** Room kept under a placed thought for the line a task adds to its card ("#5 To do"), so a thought placed below it is not overlapped later. */
export const TASK_LINE_ROOM = 36;

interface Anchor { x: number; y: number; horizontal: boolean; sign: number }

/** Side anchors when two boxes sit side by side; top/bottom only when they overlap horizontally. */
function anchor(r: Rect, o: Rect): Anchor {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const dx = o.x + o.w / 2 - cx;
  const dy = o.y + o.h / 2 - cy;
  if (Math.abs(dx) > (r.w + o.w) / 2 + 8) return { x: dx > 0 ? r.x + r.w : r.x, y: cy, horizontal: true, sign: Math.sign(dx) || 1 };
  return { x: cx, y: dy > 0 ? r.y + r.h : r.y, horizontal: false, sign: Math.sign(dy) || 1 };
}

/** A soft cubic curve between two boxes and the point where its label sits; `at(t)` is any point along it (0 at `a`, 1 at `b`). */
export function linkPath(a: Rect, b: Rect) {
  const A = anchor(a, b);
  const B = anchor(b, a);
  const k = Math.max(20, Math.hypot(B.x - A.x, B.y - A.y) * 0.35);
  const c1 = A.horizontal ? [A.x + A.sign * k, A.y] : [A.x, A.y + A.sign * k];
  const c2 = B.horizontal ? [B.x + B.sign * k, B.y] : [B.x, B.y + B.sign * k];
  const at = (t: number) => {
    const u = 1 - t;
    return {
      x: u * u * u * A.x + 3 * u * u * t * c1[0]! + 3 * u * t * t * c2[0]! + t * t * t * B.x,
      y: u * u * u * A.y + 3 * u * u * t * c1[1]! + 3 * u * t * t * c2[1]! + t * t * t * B.y,
    };
  };
  return { d: `M${A.x},${A.y} C${c1.join(',')} ${c2.join(',')} ${B.x},${B.y}`, mid: at(0.5), at };
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Where each connection's label sits (founder direction 2026-11-17 visual review): on a free part of its own line, never on another label
 * or under a thought. The middle of the line first, then points a little towards either end; a label that every point puts under a thought
 * gets `null`, and the map draws it at the line's middle over the thoughts' edges (never hidden). Sizes are the labels' boxes in plane units.
 */
const LABEL_POINTS = Array.from({ length: 19 }, (_, i) => (i + 1) / 20).sort((a, b) => Math.abs(a - 0.5) - Math.abs(b - 0.5) || b - a);

export function placeLabels(labels: { id: string; at(t: number): { x: number; y: number }; w: number; h: number }[], cards: Rect[]): Map<string, { x: number; y: number } | null> {
  const placed: Rect[] = [];
  const result = new Map<string, { x: number; y: number } | null>();
  for (const label of labels) {
    let chosen: { x: number; y: number } | null = null;
    // Every point along the curve, nearest the middle first, so a label a card covers at the middle finds the free part of its line
    // (round 14 look-b P11: "problem" was never drawn while seven points were tried).
    for (const t of LABEL_POINTS) {
      const point = label.at(t);
      const box = { x: point.x - label.w / 2 - 3, y: point.y - label.h / 2 - 2, w: label.w + 6, h: label.h + 4 };
      if (cards.some((card) => overlaps(box, card)) || placed.some((other) => overlaps(box, other))) continue;
      chosen = point;
      placed.push(box);
      break;
    }
    result.set(label.id, chosen);
  }
  return result;
}

export function rectOf(thought: Thought, heights: Map<string, number>): Rect {
  const h = thought.shape === 'circle' ? thought.width : Math.max(thought.height, heights.get(thought.id) ?? thought.height);
  return { x: thought.x, y: thought.y, w: thought.width, h };
}

/** A free spot for a new thought: beside `from` when given, else the first free place at the top left. */
export function freeSpot(rects: Rect[], from: Rect | null, size: { w: number; h: number }, columnsOnly = false): { x: number; y: number } {
  const hits = (x: number, y: number) => rects.some((r) => x < r.x + r.w + 16 && x + size.w + 16 > r.x && y < r.y + r.h + 16 + TASK_LINE_ROOM && y + size.h + 16 > r.y);
  if (!from) {
    // On the phone's columns the first free place is counted from the map's own top left, not the plane's: a thought made on a computer
    // may stand far from the plane's corner, and the columns keep vertical gaps, so a new one there landed a screen or more below it and
    // the view went with it (round 15 new P3-f: the existing thought went off screen after Save).
    const x0 = columnsOnly && rects.length ? Math.min(...rects.map((r) => r.x)) : PAD;
    const y0 = columnsOnly && rects.length ? Math.min(...rects.map((r) => r.y)) : PAD;
    for (let y = y0; y < y0 + 4000; y += 40) for (let x = x0; x < x0 + (columnsOnly ? 1 : 1200); x += 40) if (!hits(x, y)) return { x, y };
    return { x: x0, y: y0 };
  }
  const tries = columnsOnly
    ? [[0, from.h + 32], [0, from.h + 140], [0, from.h + 250]]
    : [[from.w + 56, 0], [from.w + 56, 110], [from.w + 56, -110], [from.w + 56, 220], [0, from.h + 40], [2 * (from.w + 56), 0]];
  for (const [dx, dy] of tries) {
    const x = from.x + dx!;
    const y = from.y + dy!;
    if (!hits(x, y)) return { x, y };
  }
  let y = from.y + from.h + 40;
  while (hits(from.x, y)) y += 40;
  return { x: from.x, y };
}

export interface Projection {
  rects: Map<string, Rect>;
  /** Card width on the narrow layout. */
  nodeWidth: number;
  /** Stored plane units per displayed pixel horizontally (to turn a drag back into a move). */
  scaleX: number;
}

/**
 * The phone layout of direction C (`#lamp-map` at 390px): thoughts keep their vertical order and
 * their relative left-to-right place, spread across two readable card columns that fit the
 * screen width. Thoughts that would touch are pushed down, and so is anything under the
 * selected thought's actions. Only the display changes; stored
 * positions stay as they are unless the person moves a thought.
 */
export function project(thoughts: Thought[], heights: Map<string, number>, canvasWidth: number, reserve: { id: string; below: number } | null = null): Projection {
  const gap = 12;
  const nodeWidth = Math.max(120, Math.floor((canvasWidth - PAD * 2 - gap) / 2));
  const span = Math.max(0, canvasWidth - PAD * 2 - nodeWidth);
  const xs = thoughts.map((t) => t.x);
  const minX = Math.min(...xs);
  const range = Math.max(...xs) - minX;
  const minY = Math.min(...thoughts.map((t) => t.y));
  const scaleX = range > 0 && span > 0 ? range / span : 1;
  const placed: Rect[] = [];
  const rects = new Map<string, Rect>();
  for (const t of [...thoughts].sort((a, b) => (a.y - b.y) || (a.x - b.x))) {
    const x = PAD + (range > 0 ? ((t.x - minX) / range) * span : 0);
    const h = t.shape === 'circle' ? nodeWidth : Math.max(t.height, heights.get(t.id) ?? t.height);
    let y = PAD + (t.y - minY);
    for (const p of placed) if (x < p.x + p.w + 8 && x + nodeWidth + 8 > p.x && y < p.y + p.h + gap && y + h + gap > p.y) y = p.y + p.h + gap;
    const rect = { x: Math.round(x), y: Math.round(y), w: nodeWidth, h };
    // Room under the selected thought for its Edit and Add actions, so they cover nothing.
    placed.push(reserve?.id === t.id ? { ...rect, h: h + reserve.below } : rect);
    rects.set(t.id, rect);
  }
  return { rects, nodeWidth, scaleX };
}

/**
 * A free spot as near `center` as possible, inside `bounds` when given (CW-12): a thought that arrives from a message lands
 * in empty space the person can see, never over another thought or under the map's breadcrumb. Rings of a 40 px grid
 * around the centre; null when nothing within reach is free.
 */
export function freeSpotNear(rects: Rect[], center: { x: number; y: number }, size: { w: number; h: number }, bounds?: Rect): { x: number; y: number } | null {
  const hits = (x: number, y: number) => rects.some((r) => x < r.x + r.w + 24 && x + size.w + 24 > r.x && y < r.y + r.h + 24 + TASK_LINE_ROOM && y + size.h + 24 > r.y);
  const inside = (x: number, y: number) => !bounds || (x >= bounds.x && y >= bounds.y && x + size.w <= bounds.x + bounds.w && y + size.h <= bounds.y + bounds.h);
  const x0 = Math.round(center.x - size.w / 2), y0 = Math.round(center.y - size.h / 2);
  for (let ring = 0; ring <= 30; ring++) {
    const step = 40, found: { x: number; y: number; d: number }[] = [];
    for (let i = -ring; i <= ring; i++) for (const [dx, dy] of [[i, -ring], [i, ring], [-ring, i], [ring, i]] as const) {
      const x = x0 + dx * step, y = y0 + dy * step;
      if (inside(x, y) && !hits(x, y)) found.push({ x, y, d: Math.hypot(dx, dy) });
    }
    if (found.length) { const best = found.sort((a, b) => a.d - b.d)[0]!; return { x: best.x, y: best.y }; }
  }
  return null;
}
