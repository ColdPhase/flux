"""Geometry probes for the message toolbar (#591) and selection mode (#594).

They read what the browser laid out (rectangles, computed opacity), not class names, so a layout that only hides
its overflow or only fades a second toolbar cannot pass. Rectangles are in viewport pixels.
"""

from __future__ import annotations

import unittest

from playwright.sync_api import Locator, Page

# A toolbar counts as showing from the first frame it has any opacity: a half-faded one is still on screen.
SHOWING = 0.001

MESSAGE = "[data-message-id], .project-convo__message[id^='message-']"


def overflow(page: Page, selector: str) -> dict:
    """scrollWidth and clientWidth of a scrolling pane: equal when nothing is laid out beyond its edge."""
    return page.locator(selector).first.evaluate("el => ({scroll: el.scrollWidth, client: el.clientWidth})")


def assert_no_sideways_scroll(case: unittest.TestCase, page: Page, selector: str, label: str) -> None:
    measured = overflow(page, selector)
    case.assertLessEqual(measured["scroll"], measured["client"], f"{label}: {selector} scrolls sideways ({measured})")
    case.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), page.viewport_size["width"], f"{label}: the page scrolls sideways")


def toolbars(page: Page, scope: str = "body") -> list[dict]:
    """Every message toolbar in scope, whether or not it is showing, with the id of the message it belongs to."""
    return page.evaluate("""([scope, message]) => [...document.querySelector(scope).querySelectorAll('.msg-acts')].map((el) => {
      const style = getComputedStyle(el), box = el.getBoundingClientRect(), host = el.closest(message);
      return {id: host ? (host.dataset.messageId || host.id) : null, opacity: parseFloat(style.opacity),
        left: box.left, right: box.right, top: box.top, bottom: box.bottom};
    })""", [scope, MESSAGE])


def showing(page: Page, scope: str = "body") -> list[dict]:
    return [bar for bar in toolbars(page, scope) if bar["opacity"] > SHOWING]


def start_counting(page: Page) -> None:
    """Counts, on every frame from now on, how many toolbars are showing at once, to catch a hand-over that overlaps."""
    page.evaluate("""() => {
      const state = window.__toolbarCount = {max: 0, frames: 0, stop: false};
      const tick = () => {
        const n = [...document.querySelectorAll('.msg-acts')].filter((el) => parseFloat(getComputedStyle(el).opacity) > %s).length;
        state.max = Math.max(state.max, n); state.frames++;
        if (!state.stop) requestAnimationFrame(tick);
      };
      tick();
    }""" % SHOWING)


def stop_counting(page: Page) -> dict:
    return page.evaluate("() => { const state = window.__toolbarCount; state.stop = true; return {max: state.max, frames: state.frames}; }")


def rect(locator: Locator) -> dict:
    box = locator.first.evaluate("el => { const r = el.getBoundingClientRect(); return {left: r.left, right: r.right, top: r.top, bottom: r.bottom}; }")
    return box


def intersects(a: dict, b: dict, slack: float = 0.5) -> bool:
    """True when two rectangles share area (touching edges and sub-pixel rounding do not count)."""
    return a["left"] < b["right"] - slack and b["left"] < a["right"] - slack and a["top"] < b["bottom"] - slack and b["top"] < a["bottom"] - slack


def covered_parts(page: Page, scope: str, bar: dict) -> list[str]:
    """What else in the pane the toolbar overlaps: any bubble, author row, time or other toolbar, even its own bubble."""
    parts = page.evaluate("""([scope, bar]) => {
      const hit = (r) => r.left < bar.right - .5 && bar.left < r.right - .5 && r.top < bar.bottom - .5 && bar.top < r.bottom - .5;
      const found = [];
      for (const el of document.querySelector(scope).querySelectorAll('.message-bubble, .dm-msg__body, .dm-msg__meta, .project-convo__message-meta, .message-time, .dm-replies, .convo-replies')) {
        const r = el.getBoundingClientRect();
        if (r.width && r.height && hit(r)) found.push((el.closest('[data-message-id]') || el).id + ' ' + el.className);
      }
      return found;
    }""", [scope, bar])
    return parts
