// Motion follows the system's reduced-motion setting and nothing else: Settings has no "Reduce motion" switch (founder decision,
// 2026-11-13, #1419 item 17). The CSS answers the media query itself (tokens.css, ui.css); this is for script-driven motion.

const REDUCED = '(prefers-reduced-motion: reduce)';

/** True when script-driven motion must stop: the system's reduced-motion setting. */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.(REDUCED).matches;
}
