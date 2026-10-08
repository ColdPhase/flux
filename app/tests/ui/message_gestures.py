"""Touch gestures on a message (F-026 S6): a long press and a swipe, as the touch pointer sends them.

Playwright has no long press or swipe, so these dispatch the same pointer events a touch screen would
(pointerType "touch"); a mouse never triggers them.
"""

from playwright.sync_api import Locator


def touch(target: Locator, kind: str, x: float, y: float) -> None:
    target.dispatch_event(kind, {"pointerType": "touch", "pointerId": 41, "isPrimary": True, "button": 0, "buttons": 0 if kind == "pointerup" else 1,
                                 "clientX": x, "clientY": y})


def centre(target: Locator) -> tuple[float, float]:
    box = target.bounding_box()
    assert box, "the target has a box"
    return box["x"] + box["width"] / 2, box["y"] + box["height"] / 2


def long_press(target: Locator, hold_ms: int = 700) -> None:
    x, y = centre(target)
    touch(target, "pointerdown", x, y)
    target.page.wait_for_timeout(hold_ms)
    touch(target, "pointerup", x, y)


def swipe(target: Locator, dx: float, steps: int = 6) -> None:
    """Drag by `dx` px horizontally (negative is left) from the target's centre."""
    x, y = centre(target)
    touch(target, "pointerdown", x, y)
    for step in range(1, steps + 1):
        touch(target, "pointermove", x + dx * step / steps, y)
    touch(target, "pointerup", x + dx, y)


def open_message_menu(message: Locator, *, phone: bool) -> Locator:
    """Opens a message's actions menu: More actions on a computer, a long press on a phone (F-026 S6)."""
    page = message.page
    if phone:
        bubble = message.locator(":scope > p")
        long_press(bubble if bubble.count() else message)
    else:
        message.hover()
        message.get_by_role("button", name="More actions").click()
    menu = page.get_by_role("menu", name="Message actions")
    menu.wait_for()
    return menu


def tap(target: Locator, hold_ms: int = 40) -> None:
    """A quick touch: down, a short wait, up."""
    x, y = centre(target)
    touch(target, "pointerdown", x, y)
    target.page.wait_for_timeout(hold_ms)
    touch(target, "pointerup", x, y)
