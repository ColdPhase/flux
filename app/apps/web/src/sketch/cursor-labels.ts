import type { Rect } from './geometry';

/** On-screen size of a cursor label (px): shape, name and padding; long names are cut with an ellipsis at 220 px. */
export const LABEL_HEIGHT = 20;
export const MAX_LABEL = 220;
export const labelWidth = (name: string) => Math.min(MAX_LABEL, Math.max(52, 34 + Math.ceil(name.length * 7.6)));
const ARROW = { w: 14, h: 16 };

export interface CursorLabelInput { key: string; name: string; x: number; y: number }
/**
 * `end`: the label's right edge sits at dx + w (it was flipped to the cursor's left), so a name shorter than the estimate
 * hugs the cursor. `spot` names the candidate, so the next layout can keep it (no corner hopping).
 */
export interface LabelOffset { dx: number; dy: number; w: number; end: boolean; spot: string }

const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/**
 * Names stay visible beside every cursor and never cover a thought's text. Each label tries the four corners around its
 * cursor, then the space just outside the thought the cursor is over, then a widening ring of spots, and keeps the first
 * one that touches no thought, no other label and no other cursor; otherwise the least overlapping one. A label keeps the
 * spot it had (`previous`) for as long as that spot is still clear, so it does not hop between corners as the cursor
 * crosses a thought's edge. Always clamped inside the plane, so a phone's edge keeps the whole name. Offsets are screen
 * pixels from the cursor tip.
 */
export function placeLabels(cursors: readonly CursorLabelInput[], thoughts: readonly Rect[], zoom: number, plane: Rect, previous?: ReadonlyMap<string, string>): Map<string, LabelOffset> {
  const placed = new Map<string, LabelOffset>();
  const boxes: Rect[] = [];
  const arrows = cursors.map((c): Rect => ({ x: c.x, y: c.y, w: ARROW.w / zoom, h: ARROW.h / zoom }));
  [...cursors].sort((a, b) => (a.key < b.key ? -1 : 1)).forEach((cursor) => {
    const w = labelWidth(cursor.name), h = LABEL_HEIGHT;
    const host = thoughts.find((r) => cursor.x >= r.x && cursor.x <= r.x + r.w && cursor.y >= r.y && cursor.y <= r.y + r.h);
    const candidates: [string, number, number][] = [['se', 12, 12], ['sw', -12 - w, 12], ['ne', 12, -12 - h], ['nw', -12 - w, -12 - h]];
    if (host) candidates.push(['below', 12, (host.y + host.h - cursor.y) * zoom + 4], ['above', 12, (host.y - cursor.y) * zoom - h - 4], ['below-left', -12 - w, (host.y + host.h - cursor.y) * zoom + 4]);
    boxes.forEach((box, index) => candidates.push([`stack${index}`, 12, (box.y + box.h - cursor.y) * zoom + 2]));
    // A ring of spots for crowded places (a phone's narrow plane): further out in every direction.
    for (const reach of [1, 2, 3, 4]) candidates.push([`e${reach}`, 12 + 24 * reach, 0], [`w${reach}`, -12 - w - 24 * reach, 0], [`s${reach}`, 12, 12 + 24 * reach], [`n${reach}`, 12, -12 - h - 24 * reach]);
    const score = (ox: number, oy: number) => {
      const x = Math.min(Math.max(cursor.x + ox / zoom, plane.x), plane.x + plane.w - w / zoom);
      const y = Math.min(Math.max(cursor.y + oy / zoom, plane.y), plane.y + plane.h - h / zoom);
      const box: Rect = { x, y, w: w / zoom, h: h / zoom };
      return { x, y, box, score: thoughts.reduce((sum, r) => sum + overlap(box, r), 0) + 4 * boxes.reduce((sum, b) => sum + overlap(box, b), 0) + 4 * arrows.reduce((sum, a) => sum + overlap(box, a), 0) };
    };
    let best: { dx: number; dy: number; score: number; end: boolean; spot: string } | null = null;
    const consider = (spot: string, ox: number, oy: number) => {
      const found = score(ox, oy);
      if (!best || found.score < best.score) best = { dx: (found.x - cursor.x) * zoom, dy: (found.y - cursor.y) * zoom, score: found.score, end: ox < 0, spot };
      return found.score === 0;
    };
    const kept = previous?.get(cursor.key);
    const keptSpot = kept === undefined ? undefined : candidates.find(([spot]) => spot === kept);
    if (!(keptSpot && consider(...keptSpot))) {
      best = null;
      for (const [spot, ox, oy] of candidates) if (consider(spot, ox, oy)) break;
    }
    const chosen = best!;
    placed.set(cursor.key, { dx: chosen.dx, dy: chosen.dy, w, end: chosen.end, spot: chosen.spot });
    boxes.push({ x: cursor.x + chosen.dx / zoom, y: cursor.y + chosen.dy / zoom, w: w / zoom, h: h / zoom });
  });
  return placed;
}
