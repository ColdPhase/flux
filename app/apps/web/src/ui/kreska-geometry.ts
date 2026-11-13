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

export type KreskaExpression =
  | 'idle' | 'working' | 'thinking' | 'writing' | 'reading' | 'waiting' | 'asking' | 'looking'
  | 'loading' | 'surprised' | 'done' | 'wink' | 'celebrate' | 'hello' | 'asleep' | 'worried';

export type Extra = 'circles' | 'sparkle' | 'wave' | 'z' | 'dots' | 'pen';

/**
 * Each expression's eyes and brow on the 24 grid, and its extra (marks, the surprised circles or the loading dots). A winking eye
 * is its own line (`shut`), so the wink can close it; `open` is the eye it closes from, drawn only while the wink plays.
 */
export const FACES: Record<KreskaExpression, { eyes: string; brow: string; shut?: string; open?: string; extra?: Extra }> = {
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
  wink: { eyes: 'M9.3 11.2V13.8', shut: 'M13.4 12.6H16', open: 'M14.7 11.2V13.8', brow: 'M7.3 7.8 10.5 6.8' },
  hello: { eyes: 'M9.3 11.2V13.8', shut: 'M13.4 12.6H16', brow: 'M7.3 7 10.5 5.9', extra: 'wave' },
  asleep: { eyes: 'M8 12.8Q9.3 13.8 10.6 12.8M13.4 12.8Q14.7 13.8 16 12.8', brow: 'M7.3 9 10.5 8.8', extra: 'z' },
  worried: { eyes: 'M9.3 11.8V13.6M14.7 11.8V13.6', brow: 'M7.4 7.3 10.6 8.4' },
  loading: { eyes: '', brow: 'M7.3 8.1 10.5 7.2', extra: 'dots' },
  writing: { eyes: 'M10.1 12.4V14.2M15.5 12.4V14.2', brow: 'M7.6 8.6 10.8 8.1', extra: 'pen' },
};

/** The surprised eyes: two open circles. */
export const EYE_CIRCLES = [{ cx: 9.3, cy: 12.4, r: 1.25, width: 1.6 }, { cx: 14.7, cy: 12.4, r: 1.25, width: 1.6 }] as const;
