"""The left sidebar folds and unfolds with a short, calm size change (#720; #593 tokens; Spokój rule 7).

The computer's sidebar goes between its full width and the 64 px rail: the aside's width takes `--dur-in` on `--ease-out`, the old
rendering stays a moment as an inert picture and fades over `--dur-out`, and the new one is live and in place from the first frame at
the width of its own. Frame by frame: the toggle keeps its size and its row and does not move once it has swapped, nothing in the work
area moves but its left edge (its top, height and far edge stay), and the picture is never found by a query of the page. Reduced
motion changes the width at once with no animation, and focus goes with the control the person used. The tablet's and the narrow
window's drawer enter and leave on the same tokens; a phone has no sidebar (its places are in the dock).
"""
from __future__ import annotations

import re
import unittest

from playwright.sync_api import Page, expect, sync_playwright

from light_motion_fixture import LightMotion, clear, numbers, ready, recorded
from test_app_shell import ORIGIN, UI_BROWSER, UPSTREAM, start_forwarder

EASE_OUT = [0.22, 1, 0.36, 1]
EASE_IN = [0.4, 0, 1, 1]

SAMPLE = r"""
async ({ click, ms }) => {
  const frames = [];
  const box = (selector) => { const el = document.querySelector(selector); if (!el) return null; const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; };
  const read = (t) => {
    const picture = document.querySelector('.app__side > [data-size-picture]');
    const style = picture ? getComputedStyle(picture) : null;
    return { t, sides: document.querySelectorAll('.side').length, pictures: document.querySelectorAll('.app__side > [data-size-picture]').length,
      picture: picture ? { opacity: Number(style.opacity), ground: style.backgroundColor, inert: picture.inert, hidden: picture.getAttribute('aria-hidden'), events: style.pointerEvents } : null,
      appGround: getComputedStyle(document.querySelector('.app')).backgroundColor, overflow: document.querySelector('.app__side').style.overflow,
      aside: box('.app__side'), main: box('.app__main'), toggle: box('.side__toggle'), header: box('header.top'), focus: document.activeElement ? document.activeElement.getAttribute('aria-label') : null };
  };
  const start = performance.now();
  frames.push(read(0));
  document.querySelector(click).click();
  await new Promise((resolve) => { const step = () => { const t = performance.now() - start; frames.push(read(t)); t < ms ? requestAnimationFrame(step) : resolve(); }; requestAnimationFrame(step); });
  return frames;
}
"""


class SidebarMotion(unittest.TestCase):
    fx: LightMotion

    @classmethod
    def setUpClass(cls):
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        print(f"ACTUAL_UI_ENGINE={cls.browser.browser_type.name}", flush=True)
        expect.set_options(timeout=10000)
        cls.fx = LightMotion(cls.browser).build()

    @classmethod
    def tearDownClass(cls):
        cls.fx.close()
        cls.browser.close()
        cls.pw.stop()

    def page(self, url: str | None = None, **options) -> Page:
        context = self.fx.context(**options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught browser errors"))
        page.goto(url or self.fx.tasks_url())
        ready(page)
        return page

    def token_ms(self, page: Page, name: str) -> float:
        value = page.evaluate("(name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()", name)
        return numbers(value)[0] * (1 if value.endswith("ms") else 1000)

    def toggle(self, page: Page) -> list[dict]:
        clear(page)
        frames = page.evaluate(SAMPLE, {"click": ".side__toggle", "ms": 500})
        return frames

    @staticmethod
    def close_to(a: float, b: float, tolerance: float = 0.5) -> bool:
        return abs(a - b) <= tolerance

    # ------------------------------------------------------------------ the size change
    def assert_folds(self, page: Page, frames: list[dict], start: float, end: float, label: str) -> None:
        widths = [frame["aside"][2] for frame in frames]
        self.assertTrue(self.close_to(widths[0], start, 1) and self.close_to(widths[-1], end, 1), f"{label}: {start} to {end}: {widths}")
        between = [w for w in widths if min(start, end) + 4 < w < max(start, end) - 4]
        self.assertGreaterEqual(len(between), 1, f"{label}: the width passes through a size between (a slow frame rate may sample few): {widths}")
        ordered = widths if start > end else widths[::-1]
        self.assertTrue(all(later <= earlier + 0.5 for earlier, later in zip(ordered, ordered[1:])), f"{label}: the width only goes one way: {widths}")
        # Nothing in the work area moves but its left edge (intended); the toggle is where it will be from the first frame, and not again.
        for key, index in (("top", 1), ("height", 3)):
            values = [frame["main"][index] for frame in frames]
            self.assertTrue(all(self.close_to(v, values[0]) for v in values), f"{label}: the work area's {key} stays: {values}")
        rights = [frame["main"][0] + frame["main"][2] for frame in frames]
        self.assertTrue(all(self.close_to(v, rights[0]) for v in rights), f"{label}: the work area's far edge stays: {rights}")
        lefts = [frame["main"][0] for frame in frames]
        self.assertTrue(self.close_to(lefts[0] - lefts[-1], start - end, 1.5), f"{label}: its left edge follows the sidebar: {lefts}")
        for key in ("top", "height"):
            index = 1 if key == "top" else 3
            values = [frame["header"][index] for frame in frames]
            self.assertTrue(all(self.close_to(v, values[0]) for v in values), f"{label}: the header's {key} stays: {values}")
        toggles = [frame["toggle"] for frame in frames]
        self.assertTrue(all(t is not None for t in toggles), label)
        self.assertTrue(all(self.close_to(t[1], toggles[0][1], 1) and self.close_to(t[2], toggles[0][2]) and self.close_to(t[3], toggles[0][3]) for t in toggles),
                        f"{label}: the toggle keeps its row and its size: {toggles}")
        swapped = toggles[1:]
        self.assertTrue(all(all(self.close_to(a, b, 0.5) for a, b in zip(t, swapped[0])) for t in swapped), f"{label}: the toggle does not move while the sidebar changes: {swapped}")
        # The picture of the old rendering: only a picture.
        shown = [frame for frame in frames if frame["pictures"]]
        self.assertTrue(shown, f"{label}: the old rendering is kept as a picture")
        self.assertTrue(all(frame["sides"] == 1 and frame["pictures"] <= 1 for frame in frames), f"{label}: a query of the page finds the one live sidebar, never the picture")
        for frame in shown:
            self.assertEqual((frame["picture"]["inert"], frame["picture"]["hidden"], frame["picture"]["events"]), (True, "true", "none"), label)
            self.assertEqual(frame["picture"]["ground"], frame["appGround"], f"{label}: it stands on the sidebar's own ground, in the theme that is on")
            self.assertEqual(frame["overflow"], "hidden", f"{label}: the aside clips while it changes size")
        opacities = [frame["picture"]["opacity"] for frame in shown]
        self.assertTrue(all(later <= earlier + 1e-6 for earlier, later in zip(opacities, opacities[1:])), f"{label}: it only fades: {opacities}")
        self.assertEqual(frames[-1]["pictures"], 0, f"{label}: nothing is left behind")
        self.assertEqual(frames[-1]["overflow"], "", f"{label}: and the aside does not clip any more (its menus reach out of it)")

    def assert_asked_with_tokens(self, page: Page, label: str) -> None:
        size = [entry for entry in recorded(page) if entry["kind"] == "script" and entry["props"] == ["width"]]
        self.assertEqual(len(size), 1, f"{label}: the width is asked for once: {recorded(page)}")
        self.assertEqual(size[0]["duration"], self.token_ms(page, "--dur-in"), f"{label}: over --dur-in")
        self.assertTrue(re.search(r"aside\.app__side", size[0]["target"]), size[0]["target"])
        self.assertEqual([round(n, 2) for n in numbers(size[0]["easing"])], EASE_OUT, f"{label}: on --ease-out")
        fade = [entry for entry in recorded(page) if entry["kind"] == "script" and entry["props"] == ["opacity"] and entry["target"] == "div"]
        self.assertEqual(len(fade), 1, f"{label}: the old rendering fades once")
        self.assertEqual(fade[0]["duration"], self.token_ms(page, "--dur-out"), f"{label}: over --dur-out")
        self.assertEqual([round(n, 2) for n in numbers(fade[0]["easing"])], EASE_IN, f"{label}: on --ease-in")

    def test_01_collapse_and_expand_change_the_width_over_the_motion_tokens_and_nothing_else_moves(self):
        page = self.page()
        collapsed = self.toggle(page)
        self.assert_folds(page, collapsed, 248, 64, "collapse")
        self.assert_asked_with_tokens(page, "collapse")
        expect(page.locator(".side--rail")).to_have_count(1)
        page.wait_for_timeout(300)
        expanded = self.toggle(page)
        self.assert_folds(page, expanded, 64, 248, "expand")
        self.assert_asked_with_tokens(page, "expand")
        expect(page.locator(".side--rail")).to_have_count(0)
        # The reading position of the work area and its content are not part of it: the composer's page is as it was.
        self.assertEqual(page.evaluate("document.querySelector('.app__side').style.cssText"), "")

    def test_02_in_dark_the_picture_stands_on_the_dark_ground(self):
        page = self.page(scheme="dark")
        frames = self.toggle(page)
        self.assert_folds(page, frames, 248, 64, "dark collapse")
        red, green, blue = [float(n) for n in re.findall(r"[\d.]+", frames[1]["picture"]["ground"])[:3]]
        self.assertLess((red + green + blue) / 3, 128, "a dark ground")

    def test_03_a_key_press_on_the_page_folds_it_too_and_focus_stays_where_it_is(self):
        page = self.page()
        page.locator("nav[aria-label='Project views'] a[href*='/tasks']").focus()
        clear(page)
        page.keyboard.press("[")
        expect(page.locator(".side--rail")).to_have_count(1)
        self.assertTrue([entry for entry in recorded(page) if entry["props"] == ["width"]], "the shortcut folds it with the same motion")
        expect(page.locator("nav[aria-label='Project views'] a[href*='/tasks']")).to_be_focused()
        page.keyboard.press("[")
        expect(page.locator(".side--rail")).to_have_count(0)
        expect(page.locator("nav[aria-label='Project views'] a[href*='/tasks']")).to_be_focused()

    def test_04_focus_goes_with_the_toggle_that_was_used(self):
        for reduced in (False, True):
            with self.subTest(reduced=reduced):
                page = self.page(reduced=reduced)
                page.get_by_role("button", name="Collapse sidebar").focus()
                page.keyboard.press("Enter")
                expect(page.get_by_role("button", name="Expand sidebar")).to_be_focused()
                page.wait_for_timeout(350)
                page.keyboard.press("Enter")
                expect(page.get_by_role("button", name="Collapse sidebar")).to_be_focused()

    def test_05_reduced_motion_changes_the_width_at_once_with_no_animation(self):
        page = self.page(reduced=True)
        frames = self.toggle(page)
        self.assertTrue(self.close_to(frames[0]["aside"][2], 248, 1))
        self.assertTrue(all(self.close_to(frame["aside"][2], 64, 1) for frame in frames[1:]), [frame["aside"][2] for frame in frames])
        self.assertTrue(all(frame["pictures"] == 0 for frame in frames), "no picture")
        self.assertEqual([entry for entry in recorded(page) if entry["kind"] == "script"], [], "nothing is animated")
        self.assertEqual(page.evaluate("document.querySelector('.app__side').style.cssText"), "")
        # The work area is where it will be in the first frame, the toggle in its row.
        self.assertTrue(all(self.close_to(frame["toggle"][1], frames[0]["toggle"][1], 1) for frame in frames))

    def test_06_a_change_of_window_is_not_an_animation(self):
        """Turning to a tablet's width puts the rail there in the same layout as the resize (no frame with the wide sidebar on a narrow screen)."""
        page = self.page()
        clear(page)
        page.set_viewport_size({"width": 820, "height": 1180})
        expect(page.locator(".side--rail")).to_have_count(1)
        page.wait_for_timeout(350)
        self.assertEqual([entry for entry in recorded(page) if entry["props"] == ["width"]], [])
        self.assertTrue(self.close_to(page.evaluate("document.querySelector('.app__side').getBoundingClientRect().width"), 64, 1))
        page.set_viewport_size({"width": 1440, "height": 900})
        expect(page.locator(".side--rail")).to_have_count(0)
        self.assertEqual([entry for entry in recorded(page) if entry["props"] == ["width"]], [])

    # ------------------------------------------------------------------ the drawer of a tablet and of a narrow window
    def drawer_journey(self, name: str, width: int, height: int) -> None:
        page = self.page(viewport={"width": width, "height": height})
        opener = page.get_by_role("button", name=name)
        opener.focus()
        clear(page)
        page.keyboard.press("Enter")
        drawer = page.get_by_role("dialog").filter(has=page.get_by_role("button", name="Close navigation"))
        expect(drawer).to_be_visible()
        page.wait_for_timeout(300)
        surface = [entry for entry in recorded(page) if entry["kind"] == "script" and "ui-drawer" in entry["target"]]
        scrim = [entry for entry in recorded(page) if entry["kind"] == "script" and "ui-scrim" in entry["target"]]
        self.assertTrue(surface and scrim, f"{width}: the drawer and its scrim animate in")
        self.assertEqual(surface[0]["duration"], self.token_ms(page, "--dur-in"))
        self.assertEqual(scrim[0]["duration"], self.token_ms(page, "--dur-in"))
        self.assertEqual(set(surface[0]["props"]), {"opacity", "transform"})
        self.assertLess(numbers(surface[0]["from"]["transform"])[0], 0, f"{width}: it comes in from the left edge")
        clear(page)
        page.keyboard.press("Escape")
        # Focus is back on the control that opened it in the same task, while the drawer still leaves.
        expect(opener).to_be_focused()
        page.wait_for_timeout(300)
        left = [entry for entry in recorded(page) if entry["kind"] == "script" and re.search("ui-drawer|ui-scrim", entry["target"])]
        self.assertTrue(left and all(entry["duration"] == self.token_ms(page, "--dur-out") for entry in left), f"{width}: and leaves over --dur-out: {left}")
        expect(page.get_by_role("dialog").filter(has=page.get_by_role("button", name="Close navigation"))).to_have_count(0)

    def test_07_a_tablet_opens_the_sidebar_as_a_drawer_that_enters_and_leaves_on_the_tokens(self):
        self.drawer_journey("Expand sidebar", 820, 1180)

    def test_08_a_narrow_window_does_the_same_from_the_menu_control(self):
        self.drawer_journey("Open navigation", 660, 900)

    def test_09_the_drawer_has_no_motion_under_reduced_motion(self):
        page = self.page(viewport={"width": 820, "height": 1180}, reduced=True)
        page.get_by_role("button", name="Expand sidebar").click()
        expect(page.get_by_role("dialog").filter(has=page.get_by_role("button", name="Close navigation"))).to_be_visible()
        page.keyboard.press("Escape")
        expect(page.get_by_role("dialog").filter(has=page.get_by_role("button", name="Close navigation"))).to_have_count(0)
        self.assertEqual([entry for entry in recorded(page) if entry["kind"] == "script"], [])

    def test_10_a_phone_has_no_sidebar_to_fold_or_slide_its_places_are_in_the_dock(self):
        page = self.page(phone=True)
        self.assertEqual(page.locator(".app__side").count(), 0)
        self.assertEqual(page.locator(".nav-drawer").count(), 0)
        self.assertEqual(page.locator(".side__toggle").count(), 0)


if __name__ == "__main__":
    unittest.main()
