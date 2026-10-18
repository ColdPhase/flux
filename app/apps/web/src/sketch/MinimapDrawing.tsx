import { memo, type CSSProperties } from 'react';

export const MINIMAP = { w: 172, h: 112 };
export type MinimapFrame = { x0: number; y0: number; k: number; dx: number; dy: number };
export type MinimapBox = { id: string; x: number; y: number; w: number; h: number };

/** Native geometry stays stable for untouched thoughts even when the fitted frame changes.
 * CSS keeps the original displayed minimum sizes and radius without changing every leaf's props. */
const Mark = memo(function Mark({ x, y, w, h }: Omit<MinimapBox, 'id'>) {
  return <rect x={x} y={y} style={{ width: `max(${w}px, var(--sk-minimap-min-w))`, height: `max(${h}px, var(--sk-minimap-min-h))`, rx: 'var(--sk-minimap-rx)' }} />;
});

/** The same native SVG marks and per-mark opacity, fitted with one shared affine transform. */
export function MinimapDrawing({ boxes, frame: f }: { boxes: MinimapBox[]; frame: MinimapFrame }) {
  const minimums = { '--sk-minimap-min-w': `${3 / f.k}px`, '--sk-minimap-min-h': `${2 / f.k}px`, '--sk-minimap-rx': `${1.5 / f.k}px` } as CSSProperties;
  return (
    <svg className="sk-minimap__drawing" width={MINIMAP.w} height={MINIMAP.h}>
      <g transform={`translate(${f.dx}, ${f.dy}) scale(${f.k}) translate(${-f.x0}, ${-f.y0})`} style={minimums}>
        {boxes.map((b) => <Mark key={b.id} x={b.x} y={b.y} w={b.w} h={b.h} />)}
      </g>
    </svg>
  );
}
