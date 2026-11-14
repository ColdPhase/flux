"""44 CSS px target criterion; tolerate only documented floating-point layout noise.

Matches tests/app/support/touch-target.ts. Rounding must not accept 43.5 or 43.75 px.
"""

import math

TOUCH_TARGET_EPSILON = 0.001


def has_minimum_touch_size(size: float) -> bool:
    return math.isfinite(size) and size >= 44 - TOUCH_TARGET_EPSILON


# The hit area a finger finds, measured in the page: from the element's centre outwards in half-pixel steps along both axes until another
# element is hit, so a pseudo-element that stretches a small control (a quiet link, a 16 px row of faces) counts and a neighbour ends it.
HIT_AREA_JS = r"""el => {
  el.scrollIntoView({block: 'center', inline: 'nearest'});
  const b = el.getBoundingClientRect();
  const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
  const mine = (x, y) => { const hit = document.elementFromPoint(x, y); return !!hit && (hit === el || el.contains(hit)); };
  const reach = (dx, dy) => { let d = 0; while (d < 60 && mine(cx + dx * (d + 0.5), cy + dy * (d + 0.5))) d += 0.5; return d; };
  return {across: reach(-1, 0) + reach(1, 0) + 0.5, down: reach(0, -1) + reach(0, 1) + 0.5, box: [b.width, b.height]};
}"""
SAMPLING_STEP = 0.5


def hit_area(locator) -> dict:
    """The element's hit area as `across` and `down` in CSS px (a 44 px area measures 43.5 or more), and its own `box`."""
    return locator.evaluate(HIT_AREA_JS)


def has_minimum_hit_area(area: dict) -> bool:
    return min(area["across"], area["down"]) >= 44 - SAMPLING_STEP
