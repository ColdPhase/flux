import { useLayoutEffect, useRef, useState } from 'react';
import { useResolvedTheme } from '../app/theme';

export const MINIMAP = { w: 172, h: 112 };
export type MinimapFrame = { x0: number; y0: number; k: number; dx: number; dy: number };
export type MinimapBox = { x: number; y: number; w: number; h: number };

/** The decorative thought marks, with the same per-mark alpha and geometry as the SVG drawing.
 * One canvas avoids reconciling every tiny SVG host element when the fitted frame changes. */
export function MinimapDrawing({ boxes, frame }: { boxes: MinimapBox[]; frame: MinimapFrame }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const color = useRef('');
  const theme = useResolvedTheme();
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  useLayoutEffect(() => {
    // Moving a window between displays can change its backing resolution without a theme change.
    let query: MediaQueryList;
    const read = () => {
      query?.removeEventListener('change', read);
      setDpr(window.devicePixelRatio || 1);
      query = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      query.addEventListener('change', read);
    };
    read();
    return () => query.removeEventListener('change', read);
  }, []);
  useLayoutEffect(() => {
    // Resolve the token only on an actual palette change, never on a movement preview.
    if (canvas.current) color.current = getComputedStyle(canvas.current).color;
  }, [theme]);
  useLayoutEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx) return;
    const width = Math.round(MINIMAP.w * dpr), height = Math.round(MINIMAP.h * dpr);
    if (el.width !== width) el.width = width;
    if (el.height !== height) el.height = height;
    ctx.setTransform(width / MINIMAP.w, 0, 0, height / MINIMAP.h, 0, 0);
    ctx.clearRect(0, 0, MINIMAP.w, MINIMAP.h);
    ctx.fillStyle = color.current;
    ctx.globalAlpha = .6;
    for (const b of boxes) {
      const x = frame.dx + (b.x - frame.x0) * frame.k;
      const y = frame.dy + (b.y - frame.y0) * frame.k;
      const w = Math.max(3, b.w * frame.k), h = Math.max(2, b.h * frame.k);
      ctx.beginPath();
      // SVG rx=1.5 (with omitted ry) clamps each radius to half its corresponding side.
      ctx.roundRect(x, y, w, h, [{ x: Math.min(1.5, w / 2), y: Math.min(1.5, h / 2) }]);
      ctx.fill();
    }
  }, [boxes, frame, dpr, theme]);
  return <canvas ref={canvas} className="sk-minimap__drawing" width={MINIMAP.w} height={MINIMAP.h} aria-hidden="true" />;
}
