"""A switch of project view shows the new screen at once (#863, docs/design/motion.md rule 2; supersedes #719's held picture).

Every ordered pair of Conversation, Map, Tasks and Wiki is switched, light and dark, on a computer and on a phone, and a recorder
that runs on every animation frame (in the page itself, so it is the same in Chromium and WebKit) writes down what the content
area is made of on each one. From those frames:

* the old view is never held as a picture and never crossfades with the new one: no frame has a picture of the old view;
* no frame is blank: the content area always holds a view with something painted in it, and a view whose stream is still hidden for its
  first reads always has its loading rows up (never an empty feed);
* a screen that is still loading shows its own loading state from the frame the switch is made on, and the old view is not shown meanwhile;
* the content area changes from the old view to the new once (no flip back and forth, no second paint);
* the new view may fade in over at most --dur-1 (120 ms) on --ease-out, opacity only, with no travel;
* with reduced motion the switch is one frame with no animation at all.

A per-frame record can be wrong about pixels, so `FLUX_UI_SCREENSHOT_DIR` also gets a contact sheet of the frames of one switch
(`view-switch-*.png`, Chromium's screencast) for a look.
"""
from __future__ import annotations

import re
import unittest

from playwright.sync_api import Page, Route, expect, sync_playwright

from light_motion_fixture import LightMotion, clear, numbers, ready, recorded
from project_views import project_view
from test_app_shell import ORIGIN, UI_BROWSER, UPSTREAM, start_forwarder

VIEWS = ["Conversation", "Map", "Tasks", "Wiki"]
PATH = {"Conversation": r"/projects/[^/]+/?$", "Map": r"/map$", "Tasks": r"/tasks$", "Wiki": r"/docs$"}
EASE_OUT = [0.22, 1, 0.36, 1]
# The wait after which a navigation shows its "Opening …" row, and how long the row stays once shown (app/RouteProgress.tsx).
ROUTE_PROGRESS_AFTER_MS = 200
ROUTE_PROGRESS_AT_LEAST_MS = 300
# The root of the view in the content area.
ROOT = "() => { const first = document.querySelector('#content').firstElementChild; return first ? String(first.className).split(' ')[0] : ''; }"

RECORD = r"""
() => {
  if (window.__frameRecorder) return;
  window.__frameRecorder = true;
  const BUSY = '[aria-busy="true"]:not(button, a, [role="button"], [role="menuitem"]), .is-opening';
  window.__frames = null;
  document.addEventListener('click', () => { window.__lastClick = performance.now(); }, true);
  const step = () => {
    if (window.__frames) {
      const pane = document.querySelector('#content');
      const pictures = [...document.body.children].filter((el) => el.hasAttribute('data-dissolve'));
      window.__frames.push({
        t: performance.now(), pictures: pictures.length, busy: !!pane.querySelector(BUSY),
        ink: (pane.innerText || '').trim().length > 0 || !!pane.querySelector('canvas, svg, [data-pending-view]'),
        pending: !!pane.querySelector('[data-pending-view]'),
        empty: !!pane.querySelector('.is-opening') && !(pane.querySelector('.opening') && getComputedStyle(pane.querySelector('.opening')).opacity > 0.9),
        view: pane.firstElementChild ? String(pane.firstElementChild.className).split(' ')[0] : '', path: location.pathname,
        progress: !!document.querySelector('.route-progress'), click: window.__lastClick || 0,
      });
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
"""


def circuit(nodes: list[str]) -> list[str]:
    """A walk that goes along every ordered pair of nodes exactly once (an Eulerian circuit of the complete directed graph)."""
    edges = {a: [b for b in nodes if b != a] for a in nodes}
    stack, walk = [nodes[0]], []
    while stack:
        if edges[stack[-1]]:
            stack.append(edges[stack[-1]].pop())
        else:
            walk.append(stack.pop())
    return walk[::-1]


class ViewSwitch(unittest.TestCase):
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

    def page(self, **options) -> Page:
        context = self.fx.context(**options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught browser errors"))
        page.goto(self.fx.project_url())
        ready(page)
        page.evaluate(RECORD)
        return page

    def go(self, page: Page, name: str, phone: bool) -> list[dict]:
        """Switches to a view and returns what every frame was made of, from before the click until the switch is over."""
        clear(page)
        before = page.evaluate(ROOT)
        page.evaluate("() => { window.__frames = []; }")
        project_view(page, name, touch=phone)
        page.wait_for_url(re.compile(PATH[name]))
        # The address changes a moment before the view does: judge from the switch itself.
        page.wait_for_function(f"() => ({ROOT})() !== {before!r}", timeout=8000)
        # Over when the view is in and nothing waits on its reads; the recorder has seen a few frames of that.
        page.wait_for_function("() => !document.querySelector('#content [aria-busy=\"true\"]:not(button, a), #content .is-opening')", timeout=8000)
        page.wait_for_timeout(250)
        return page.evaluate("() => { const frames = window.__frames; window.__frames = null; return frames; }")

    def judge(self, page: Page, frames: list[dict], label: str, dark: bool) -> None:
        self.assertGreater(len(frames), 3, f"{label}: the recorder saw the switch")
        for frame in frames:
            where = f"{label} at {frame['t'] - frames[0]['t']:.0f} ms: {frame}"
            self.assertEqual(frame["pictures"], 0, f"the old view is never held as a picture: {where}")
            # The "Opening …" row is for a wait that lasts: a switch that is over within a few frames never shows it (it would flash over the view).
            self.assertFalse(frame["progress"] and frame["t"] - frame["click"] < ROUTE_PROGRESS_AFTER_MS - 10, f"no route progress row on a quick switch: {where}")
            self.assertTrue(frame["ink"], f"no blank frame: {where}")
            self.assertFalse(frame["empty"], f"a feed hidden for its first reads always has its loading rows up: {where}")
        # What the page asked the browser to run: the new view fades in once, over at most --dur-1, opacity only, on --ease-out, no travel.
        # (The phone's title menu is a surface of its own: it enters and leaves on the surface vocabulary, not on the view's.)
        views_only = [entry for entry in recorded(page) if entry["kind"] == "script" and not re.search(r"ui-overlay|ui-scrim|ui-pop|ui-toast", entry["target"])]
        fades = [entry for entry in views_only if (entry["from"] or {}).get("opacity") == 0 and (entry["to"] or {}).get("opacity") == 1]
        self.assertTrue(fades, f"{label}: the new view fades in: {recorded(page)}")
        for fade in fades:
            self.assertLessEqual(fade["duration"], 120)
            self.assertEqual(fade["props"], ["opacity"], "no travel")
            self.assertTrue(all(abs(a - b) <= 0.011 for a, b in zip(numbers(fade["easing"]), EASE_OUT)), f"eased {fade['easing']!r}")
        self.assertEqual([entry for entry in views_only if (entry["to"] or {}).get("opacity") == 0], [], f"{label}: nothing fades out: the old view is not held")
        views = [frame["view"] for i, frame in enumerate(frames) if i == 0 or frames[i - 1]["view"] != frame["view"]]
        self.assertEqual(len(views), 2, f"{label}: the content area goes from the old view to the new once: {views}")
        self.assertNotEqual(views[0], views[1])

    def switches(self, *, dark: bool, phone: bool) -> None:
        page = self.page(scheme="dark" if dark else "light", phone=phone)
        walk = circuit(VIEWS)
        # The page is on the Conversation: start the walk there (the circuit begins with it).
        self.assertEqual(walk[0], "Conversation")
        for previous, name in zip(walk, walk[1:]):
            frames = self.go(page, name, phone)
            self.judge(page, frames, f"{'dark' if dark else 'light'} {'phone' if phone else 'computer'} {previous} to {name}", dark)

    # ------------------------------------------------------------------ every pair, both themes, both sizes
    def test_01_every_pair_of_views_on_a_computer_in_light(self):
        self.switches(dark=False, phone=False)

    def test_02_every_pair_of_views_on_a_computer_in_dark(self):
        self.switches(dark=True, phone=False)

    def test_03_every_pair_of_views_on_a_phone_in_light(self):
        self.switches(dark=False, phone=True)

    def test_04_every_pair_of_views_on_a_phone_in_dark(self):
        self.switches(dark=True, phone=True)

    # ------------------------------------------------------------------ reduced motion
    def test_05_reduced_motion_switches_in_one_frame_with_no_animation(self):
        page = self.page(reduced=True)
        clear(page)
        for name in ("Tasks", "Map", "Wiki", "Conversation"):
            frames = self.go(page, name, False)
            self.assertTrue(all(frame["pictures"] == 0 for frame in frames), f"{name}: no picture at any frame")
            self.assertTrue(all(frame["ink"] for frame in frames), f"{name}: no blank frame")
            views = [frame["view"] for i, frame in enumerate(frames) if i == 0 or frames[i - 1]["view"] != frame["view"]]
            self.assertEqual(len(views), 2, f"{name}: the view changes once: {views}")
        self.assertEqual([entry for entry in recorded(page) if re.search(r"app__pane|^div$", entry["target"])], [], "nothing animates the content area")

    # ------------------------------------------------------------------ the "Opening …" row
    def hold_chunk(self, page: Page, module: str) -> list[Route]:
        """Holds the code of a lazy view (first visit) until the test lets it go."""
        held: list[Route] = []
        pattern = re.compile(rf"/assets/{module}-[^/]+\.js(?:\?.*)?$")

        def pause(route: Route) -> None:
            held.append(route)
        page.route(pattern, pause)

        def release() -> None:
            page.unroute(pattern, pause)
            for route in held:
                try:
                    route.abort("aborted")
                except Exception:  # already continued
                    pass
            held.clear()
        self.addCleanup(release)
        return held

    ROW_FRAMES = """(ms) => { const rows = window.__rows = []; const t0 = performance.now();
      const step = () => { const t = performance.now() - t0; rows.push([Math.round(t), !!document.querySelector('.route-progress')]); if (t < ms) requestAnimationFrame(step); }; requestAnimationFrame(step); }"""

    def test_07_a_wait_shorter_than_the_delay_never_shows_the_opening_row(self):
        page = self.page()
        held = self.hold_chunk(page, "ProjectTasks")
        page.evaluate(self.ROW_FRAMES, 900)
        project_view(page, "Tasks")
        page.wait_for_timeout(100)
        self.assertEqual(len(held), 1, "the code of Tasks is held")
        held.pop().continue_()
        expect(page.locator("nav[aria-label='Space views'] a[href*='/tasks']")).to_have_attribute("aria-current", "page")
        page.wait_for_function("() => window.__rows[window.__rows.length - 1][0] >= 850")
        rows = page.evaluate("window.__rows")
        self.assertTrue(rows and not any(shown for _, shown in rows), f"a switch that is over in 100 ms never shows the row: {rows}")

    def test_08_a_longer_wait_shows_it_after_the_delay_and_it_stays_its_minimum_once_shown(self):
        page = self.page()
        held = self.hold_chunk(page, "ProjectViews")
        page.evaluate(self.ROW_FRAMES, 1400)
        project_view(page, "Map")
        page.wait_for_timeout(260)
        self.assertEqual(len(held), 1, "the code of the Map is held")
        # The pending row is the same 44 px Cancel row over the work (test_route_chunks holds that it moves nothing).
        expect(page.locator(".route-progress").get_by_role("button", name="Cancel", exact=True)).to_be_enabled()
        held.pop().continue_()
        expect(page.locator("nav[aria-label='Space views'] a[href*='/map']")).to_have_attribute("aria-current", "page")
        page.wait_for_function("() => window.__rows[window.__rows.length - 1][0] >= 1350")
        rows = page.evaluate("window.__rows")
        shown = [t for t, on in rows if on]
        self.assertTrue(shown, f"a wait of 260 ms shows the row: {rows}")
        self.assertGreaterEqual(shown[0], ROUTE_PROGRESS_AFTER_MS - 20, f"not before the delay: {rows}")
        self.assertGreaterEqual(shown[-1] - shown[0], ROUTE_PROGRESS_AT_LEAST_MS - 60, f"and once shown it stays its minimum although the code has arrived: {rows}")
        self.assertFalse(rows[-1][1], "and then it goes")


    # ------------------------------------------------------------------ a screen that is still loading
    def hold_reads(self, page: Page, pattern: str) -> list[Route]:
        """Holds every GET to the API matching `pattern` until the test lets it go."""
        held: list[Route] = []
        expression = re.compile(pattern)

        def pause(route: Route) -> None:
            if route.request.method == "GET":
                held.append(route)
            else:
                route.fallback()
        page.route(expression, pause)

        def release() -> None:
            page.unroute(expression, pause)
            for route in held:
                try:
                    route.continue_()
                except Exception:  # the page is gone
                    pass
            held.clear()
        self.addCleanup(release)
        return held

    def test_09_a_screen_that_is_still_loading_shows_its_own_state_at_once_and_the_old_view_is_not_shown(self):
        """Tasks' reads are held for a second. From the frame the switch is made on, the content area holds Tasks' own loading state (not a blank,
        not the conversation) and stays so until the reads answer; then the real view takes its place (#863 rule 2)."""
        page = self.page()
        project_view(page, "Tasks")  # warm: its code is here, so what is waited for is the reads
        page.wait_for_function("() => document.querySelector('#content .tb-root, #content .ws-tasks, #content [class*=tb-], #content [class*=ws-]')", timeout=8000)
        project_view(page, "Conversation")
        page.wait_for_function("() => document.querySelector('#content .project-convo')", timeout=8000)
        # The Tasks view's loader reads the project (and the comparison outcomes) before it commits.
        held = self.hold_reads(page, r"/api/v1/projects/[^/?]+(/comparison[^/?]*)?(\?.*)?$")
        page.evaluate("() => { window.__frames = []; }")
        project_view(page, "Tasks")
        page.wait_for_timeout(1000)
        frames = page.evaluate("() => { const frames = window.__frames; window.__frames = null; return frames; }")
        self.assertTrue(held, "Tasks' reads are being waited for")
        click = next(frame["click"] for frame in frames if frame["click"])
        first = next((frame for frame in frames if frame["pending"]), None)
        self.assertIsNotNone(first, f"the loading state was up: {frames[-1]}")
        # Within a few frames of the click (about 30 ms in Chromium, up to about 150 ms in a loaded WebKit, whose render of the shell is slower), and so far
        # before the 350 ms `--delay-wait` the stream's rows used to sit behind; the 120 ms of the pill and the press already answer the click itself.
        self.assertLess(first["t"] - click, 200, "from the frame the switch is made on, not after a delay")
        timeline = [(round(frame["t"] - click), frame["pending"]) for frame in frames[:12]]
        for frame in frames:
            if frame["t"] < first["t"]:
                continue
            self.assertTrue(frame["pending"] and frame["ink"], f"the loading state stays up, never a blank frame: {frame} in {timeline}")
        visible = page.evaluate("() => { const root = document.querySelector('#content > .project-page, #content > .project-convo'); return root ? getComputedStyle(root).visibility : 'gone'; }")
        self.assertIn(visible, ("hidden", "gone"), "the old view is not shown while the new one loads")
        # It is only hidden: the router still holds it, so a cancelled switch finds it as it was.
        while held:
            held.pop().continue_()
        page.wait_for_url(re.compile(PATH["Tasks"]))
        page.wait_for_function("() => !document.querySelector('[data-pending-view]') && document.querySelector('#content .tb-root, #content [class*=ws-], #content [class*=tb-]')", timeout=8000)


if __name__ == "__main__":
    unittest.main()
