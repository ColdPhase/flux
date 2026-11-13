import { useEffect, useState, type RefObject } from 'react';

let canvas: HTMLCanvasElement | null = null;

/** The width of `text` in the font of `style`. */
function widthIn(text: string, style: CSSStyleDeclaration): number {
  canvas ??= document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return 0;
  context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  return context.measureText(text).width;
}

/**
 * The longest of `hints` (longest first) that fits the field on one line, so a hint never wraps and makes the composer grow
 * on a narrow phone or with large text (#1374, #1370); the last one is the fallback. Measured again when the field's width changes.
 */
export function useFittingHint(fieldRef: RefObject<HTMLTextAreaElement | null>, hints: readonly string[]): string {
  const [hint, setHint] = useState(hints[0] ?? '');
  const key = hints.join('\n');
  useEffect(() => {
    const options = key.split('\n');
    const field = fieldRef.current;
    if (!field || options.length < 2) return undefined;
    const measure = () => {
      const style = getComputedStyle(field);
      const room = field.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      setHint(options.find((option) => widthIn(option, style) <= room) ?? options[options.length - 1]!);
    };
    const watch = new ResizeObserver(measure);
    watch.observe(field);
    // The interface font may arrive after the first measure (WebKit can settle `fonts.ready` before Geist has started loading).
    let alive = true;
    void document.fonts?.ready.then(() => { if (alive) measure(); });
    document.fonts?.addEventListener?.('loadingdone', measure);
    return () => { alive = false; watch.disconnect(); document.fonts?.removeEventListener?.('loadingdone', measure); };
  }, [fieldRef, key]);
  return hints.includes(hint) ? hint : hints[0] ?? '';
}
