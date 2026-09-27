import type { Thought } from '@flux/contracts';

// Plane geometry for the map: where links attach, how they curve and where a new thought fits.

export interface Rect { x: number; y: number; w: number; h: number }

/** Space kept around the content so the canvas never ends at a thought's edge. */
export const PAD = 24;

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

/** A soft cubic curve between two boxes and the point where its label sits. */
export function linkPath(a: Rect, b: Rect) {
  const A = anchor(a, b);
  const B = anchor(b, a);
  const k = Math.max(20, Math.hypot(B.x - A.x, B.y - A.y) * 0.35);
  const c1 = A.horizontal ? [A.x + A.sign * k, A.y] : [A.x, A.y + A.sign * k];
  const c2 = B.horizontal ? [B.x + B.sign * k, B.y] : [B.x, B.y + B.sign * k];
  const mid = {
    x: 0.125 * A.x + 0.375 * c1[0]! + 0.375 * c2[0]! + 0.125 * B.x,
    y: 0.125 * A.y + 0.375 * c1[1]! + 0.375 * c2[1]! + 0.125 * B.y,
  };
  return { d: `M${A.x},${A.y} C${c1.join(',')} ${c2.join(',')} ${B.x},${B.y}`, mid };
}

export function rectOf(thought: Thought, heights: Map<string, number>): Rect {
  const h = thought.shape === 'circle' ? thought.width : Math.max(thought.height, heights.get(thought.id) ?? thought.height);
  return { x: thought.x, y: thought.y, w: thought.width, h };
}

/** A free spot for a new thought: beside `from` when given, else the first free place at the top left. */
export function freeSpot(rects: Rect[], from: Rect | null, size: { w: number; h: number }, columnsOnly = false): { x: number; y: number } {
  const hits = (x: number, y: number) => rects.some((r) => x < r.x + r.w + 16 && x + size.w + 16 > r.x && y < r.y + r.h + 16 && y + size.h + 16 > r.y);
  if (!from) {
    for (let y = PAD; y < PAD + 4000; y += 40) for (let x = PAD; x < PAD + (columnsOnly ? 1 : 1200); x += 40) if (!hits(x, y)) return { x, y };
    return { x: PAD, y: PAD };
  }
  const tries = columnsOnly
    ? [[0, from.h + 32], [0, from.h + 140], [0, from.h + 250]]
    : [[from.w + 56, 0], [from.w + 56, 110], [from.w + 56, -110], [from.w + 56, 220], [0, from.h + 40], [2 * (from.w + 56), 0]];
  for (const [dx, dy] of tries) {
    const x = Math.max(PAD, from.x + dx!);
    const y = Math.max(PAD, from.y + dy!);
    if (!hits(x, y)) return { x, y };
  }
  let y = from.y + from.h + 40;
  while (hits(from.x, y)) y += 40;
  return { x: from.x, y };
}

/** Reading order for the list view: top to bottom, then left to right, in bands. */
export function readingOrder(thoughts: Thought[]): Thought[] {
  return [...thoughts].sort((a, b) => (Math.round(a.y / 80) - Math.round(b.y / 80)) || (a.x - b.x) || (a.y - b.y));
}
