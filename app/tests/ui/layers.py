"""A window is above the page behind it (#1234): nothing of that page is painted over it.

The page behind a modal window is inert, not hidden, so a layer of the page with a menu-level z-index could still paint above
the window's scrim, and an inert layer is not hit by a pointer: `elementFromPoint` alone cannot see it. Two checks, then:
- what a person would hit: for every point of the window's own box, `elementFromPoint` is one of the window's own elements;
- what a person would see: no element outside the window's overlay has a z-index at or above the overlay's (and one that applies:
  positioned, or a flex or grid item) over the window's box. This is what the empty Wiki's "New page" was: a flex item at the menu's z-index.
"""

from __future__ import annotations

from playwright.sync_api import Locator, Page

SETTLED = "() => Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => null)))"

# Points of a grid inside the box (14 px in from its edges and rounded corners), and what is on top at each.
FOREIGN_POINTS = r"""(root) => {
  const box = root.getBoundingClientRect(), found = [], steps = 8;
  for (let i = 0; i <= steps; i++) for (let j = 0; j <= steps; j++) {
    const x = box.left + 14 + (box.width - 28) * i / steps, y = box.top + 14 + (box.height - 28) * j / steps;
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
    const hit = document.elementFromPoint(x, y);
    if (!hit || !root.contains(hit)) found.push(`${Math.round(x)},${Math.round(y)} ${hit ? hit.tagName.toLowerCase() + '.' + String(hit.className).trim().replace(/\s+/g, '.') : 'nothing'}`);
  }
  return found;
}"""

# Elements of the page, outside the window's overlay, that stack at the overlay's level or above and cover part of the window's box.
LAYERS_ABOVE = r"""(root) => {
  const overlay = root.closest('.ui-overlay') || root, level = Number(getComputedStyle(overlay).zIndex) || 0;
  const box = root.getBoundingClientRect(), found = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (overlay.contains(el) || el.closest('.ui-toast')) continue;
    const style = getComputedStyle(el);
    if (style.zIndex === 'auto' || Number(style.zIndex) < level) continue;
    const parent = el.parentElement ? getComputedStyle(el.parentElement).display : '';
    if (style.position === 'static' && !/flex|grid/.test(parent)) continue;
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || r.right <= box.left || r.left >= box.right || r.bottom <= box.top || r.top >= box.bottom) continue;
    found.push(`${el.tagName.toLowerCase()}.${String(el.className).trim().replace(/\s+/g, '.')} z-index ${style.zIndex} (the overlay's is ${level})`);
  }
  return found;
}"""

# The centre of a control: the control itself (or something in it) is what a pointer reaches.
OWN_CENTRE = r"""(el) => {
  const box = el.getBoundingClientRect();
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  return hit && el.contains(hit) ? '' : (hit ? hit.tagName.toLowerCase() + '.' + String(hit.className).trim().replace(/\s+/g, '.') : 'nothing');
}"""


def settle(page: Page) -> None:
    """Waits until nothing finite is animating: a window mid-enter is still travelling, and the points would be read on its way."""
    page.evaluate(SETTLED)


def foreign_points(page: Page, window: Locator) -> list[str]:
    """The points of the window's box where something that is not the window is on top. Empty when the window is whole."""
    settle(page)
    return window.evaluate(FOREIGN_POINTS)


def layers_above(page: Page, window: Locator) -> list[str]:
    """The layers of the page that stack at or above the window's overlay over its box, whether or not a pointer would hit them."""
    settle(page)
    return window.evaluate(LAYERS_ABOVE)


def foreign_at_centre(page: Page, control: Locator) -> str:
    """What is on top at the centre of a control inside a window, when that is not the control; empty when it is the control."""
    settle(page)
    return control.evaluate(OWN_CENTRE)
