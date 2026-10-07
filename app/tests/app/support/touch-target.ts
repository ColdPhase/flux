/** The phone/tablet target stays 44 CSS px; only floating-point layout noise is tolerated. */
export const TOUCH_TARGET_EPSILON = 0.001;

export function hasMinimumTouchSize(size: number): boolean {
  return Number.isFinite(size) && size >= 44 - TOUCH_TARGET_EPSILON;
}
