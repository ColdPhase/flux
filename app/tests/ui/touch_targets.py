"""44 CSS px target criterion; tolerate only documented floating-point layout noise.

Matches tests/app/support/touch-target.ts. Rounding must not accept 43.5 or 43.75 px.
"""

import math

TOUCH_TARGET_EPSILON = 0.001


def has_minimum_touch_size(size: float) -> bool:
    return math.isfinite(size) and size >= 44 - TOUCH_TARGET_EPSILON
