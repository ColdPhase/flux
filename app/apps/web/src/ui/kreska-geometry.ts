/**
 * Kreska's drawing on the 24 grid, free of React so a unit test can measure it (#849). The frame is a squircle; the marks that
 * sit beside it (the hello wave, the asleep "z", the celebrate sparkle) are drawn in the free corner above and right of it, outside
 * the frame with a gap at every size from 24 to 112 px: the frame's stroke is thicker on small faces, and the gap is measured in
 * pixels from edge to edge. They stay inside the 24 box.
 */
export const SQUIRCLE = 'M8.6 2.6H15.4C19 2.6 21.4 5 21.4 8.6V15.4C21.4 19 19 21.4 15.4 21.4H8.6C5 21.4 2.6 19 2.6 15.4V8.6C2.6 5 5 2.6 8.6 2.6Z';
export const TILE = 'M7 0H17C21.2 0 24 2.8 24 7V17C24 21.2 21.2 24 17 24H7C2.8 24 0 21.2 0 17V7C0 2.8 2.8 0 7 0Z';

/** Frame, eyes and brow line weights for the drawn size (guide §3). */
export function weights(size: number): [number, number, number] {
  if (size >= 64) return [1.15, 1.7, 1.3];
  if (size >= 40) return [1.5, 2.0, 1.55];
  return [1.8, 2.2, 1.7];
}

/** The marks beside the frame: path data and stroke width on the 24 grid. */
export const MARKS = {
  /** `hello`: two arcs that spread from the top-right corner. */
  wave: { d: 'M22.6 4.8Q21.5 2.5 19.2 1.4M23.3 2.8Q22.3 1.4 20.9 0.5', width: 1 },
  /** `asleep`: one "z". */
  z: { d: 'M21.3 0.9H23.1L21.3 2.7H23.1', width: 1 },
  /** `celebrate`: a sparkle. */
  sparkle: { d: 'M22.1 0.8V3M21 1.9H23.2', width: 1.1 },
  /** `writing`: the pen, in the face's lower right, inside the frame. */
  pen: { d: 'M17.4 18.2 19.8 15.8M15.6 18.6H17', width: 1.2 },
} as const;
