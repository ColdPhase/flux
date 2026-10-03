import { useEffect, useState } from 'react';

/**
 * Motion helpers. Durations and easings come from the CSS tokens, which are 0ms under
 * prefers-reduced-motion, so script-driven motion switches off together with CSS motion.
 */
const reduceQuery = typeof window === 'undefined' ? null : window.matchMedia('(prefers-reduced-motion: reduce)');

export function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function duration(name: '--dur-1' | '--dur-2' | '--dur-3'): number {
  if (reduceQuery?.matches) return 0;
  return parseFloat(token(name)) || 0;
}

export type Easing = '--ease-out' | '--ease-in' | '--ease-sheet';

/** Runs a Web Animation and resolves when it ends (or at once when motion is off). */
export function play(el: Element | null, frames: Keyframe[], ms: number, easing: Easing, options: KeyframeAnimationOptions = {}): Promise<Animation | null> {
  if (!el || !ms || typeof el.animate !== 'function') return Promise.resolve(null);
  const animation = el.animate(frames, { duration: ms, easing: token(easing) || 'ease-out', ...options });
  return animation.finished.then(() => animation, () => null);
}

/** Remembers element positions, lets layout change, then animates them from where they were (FLIP). */
export function flip(elements: (Element | null)[], ms = duration('--dur-3')) {
  const items = elements.filter((el): el is Element => !!el).map((el) => ({ el, rect: el.getBoundingClientRect() }));
  return () => {
    if (!ms) return;
    for (const { el, rect } of items) {
      const now = el.getBoundingClientRect();
      const dx = rect.left - now.left;
      const dy = rect.top - now.top;
      if (Math.abs(dx) + Math.abs(dy) >= 1) void play(el, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], ms, '--ease-sheet');
    }
  };
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);
  return matches;
}

/** Layout breakpoints from direction C. */
export const MEDIA = {
  navDrawer: '(max-width: 680px)',
  panelOverlay: '(max-width: 1000px)',
  phone: '(max-width: 640px)',
} as const;
