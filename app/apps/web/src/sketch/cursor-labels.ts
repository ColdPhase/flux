import type { Rect } from './geometry';

/** On-screen size of a cursor label (px): shape, name and padding; long names are cut with an ellipsis at 220 px. */
export const LABEL_HEIGHT = 20;
export const MAX_LABEL = 220;
export const labelWidth = (name: string) => Math.min(MAX_LABEL, Math.max(52, 34 + Math.ceil(name.length * 7.6)));
const ARROW = { w: 14, h: 16 };

export interface CursorLabelInput { key: string; name: string; x: number; y: number }
/** `end`: the label's right edge sits at dx + w (it was flipped to the cursor's left), so a name shorter than the estimate hugs the cursor. */
export interface LabelOffset { dx: number; dy: number; w: number; end: boolean }

const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/**
 * Names stay visible beside every cursor and never cover a thought's text. Each label tries the four corners around its
 * cursor, then the space just outside the thought the cursor is over, and keeps the first spot that touches no thought,
 * no other label and no other cursor; otherwise the least overlapping one. It is always clamped inside the plane so a
 * cursor at the edge (a phone's right edge) keeps its whole name. Offsets are screen pixels from the cursor tip.
 */
export function placeLabels(cursors: readonly CursorLabelInput[], rects: Iterable<Rect>, zoom: number, plane: Rect): Map<string, LabelOffset> {
  const thoughts = [...rects];
  const placed = new Map<string, LabelOffset>();
  const boxes: Rect[] = [];
  const arrows = cursors.map((c): Rect => ({ x: c.x, y: c.y, w: ARROW.w / zoom, h: ARROW.h / zoom }));
  [...cursors].sort((a, b) => (a.key < b.key ? -1 : 1)).forEach((cursor) => {
    const w = labelWidth(cursor.name), h = LABEL_HEIGHT;
    const host = thoughts.find((r) => cursor.x >= r.x && cursor.x <= r.x + r.w && cursor.y >= r.y && cursor.y <= r.y + r.h);
    const candidates: [number, number][] = [[12, 12], [-12 - w, 12], [12, -12 - h], [-12 - w, -12 - h]];
    if (host) candidates.push([12, (host.y + host.h - cursor.y) * zoom + 4], [12, (host.y - cursor.y) * zoom - h - 4], [-12 - w, (host.y + host.h - cursor.y) * zoom + 4]);
    for (const box of boxes) candidates.push([12, (box.y + box.h - cursor.y) * zoom + 2]);
    let best: { dx: number; dy: number; score: number; end: boolean } | null = null;
    for (const [ox, oy] of candidates) {
      const x = Math.min(Math.max(cursor.x + ox / zoom, plane.x), plane.x + plane.w - w / zoom);
      const y = Math.min(Math.max(cursor.y + oy / zoom, plane.y), plane.y + plane.h - h / zoom);
      const box: Rect = { x, y, w: w / zoom, h: h / zoom };
      const score = thoughts.reduce((sum, r) => sum + overlap(box, r), 0)
        + 4 * boxes.reduce((sum, b) => sum + overlap(box, b), 0)
        + 4 * arrows.reduce((sum, a) => sum + overlap(box, a), 0);
      if (!best || score < best.score) best = { dx: (x - cursor.x) * zoom, dy: (y - cursor.y) * zoom, score, end: ox < 0 };
      if (score === 0) break;
    }
    const chosen = best!;
    placed.set(cursor.key, { dx: chosen.dx, dy: chosen.dy, w, end: chosen.end });
    boxes.push({ x: cursor.x + chosen.dx / zoom, y: cursor.y + chosen.dy / zoom, w: w / zoom, h: h / zoom });
  });
  return placed;
}
