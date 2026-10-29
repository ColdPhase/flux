"""A switch of project view never flashes (#719; final design guide §2; Spokój rule 7).

Every ordered pair of Conversation, Map, Tasks and Wiki is switched, light and dark, on a computer and on a phone, and a recorder
that runs on every animation frame (in the page itself, so it is the same in Chromium and WebKit) writes down what the content
area is made of on each one: whether a picture of the old view is over it, how opaque that picture is and what it stands on, and
whether the new view has painted. From those frames:

* the picture of the old view stands on the ground the view stood on, in the theme that is on (no ink over ink, no wrong theme);
* it starts to fade only once the new view has painted and is no longer waiting on its first reads, and its opacity only falls;
* no frame is blank: either the picture is over the content area or the new view is in it, painted;
* the content area changes from the old view to the new once (no flip back and forth, no second paint);
* nothing is left behind when it ends, and with reduced motion the switch is one frame with no picture at all.

A per-frame record can be wrong about pixels, so `FLUX_UI_SCREENSHOT_DIR` also gets a contact sheet of the frames of one switch
(`view-switch-*.png`, Chromium's screencast) for a look.
"""
from __future__ import annotations

import re
import unittest

from playwright.sync_api import Page, expect, sync_playwright

from light_motion_fixture import LightMotion, clear, ready, recorded
from project_views import project_view
from test_app_shell import ORIGIN, UI_BROWSER, UPSTREAM, start_forwarder

VIEWS = ["Conversation", "Map", "Tasks", "Wiki"]
PATH = {"Conversation": r"/projects/[^/]+/?$", "Map": r"/map$", "Tasks": r"/tasks$", "Wiki": r"/docs$"}
# How long the old view may be held for the new one to settle (ui/Dissolve.tsx HOLD_MS), and what a frame is allowed after that.
HOLD_MS = 500
# The root of the view in the content area.
ROOT = "() => { const first = document.querySelector('#content').firstElementChild; return first ? String(first.className).split(' ')[0] : ''; }"

RECORD = r"""
() => {
  if (window.__frameRecorder) return;
  window.__frameRecorder = true;
  const BUSY = '[aria-busy="true"]:not(button, a, [role="button"], [role="menuitem"]), .is-opening';
  const ground = (el) => { for (; el; el = el.parentElement) { const c = getComputedStyle(el).backgroundColor; if (c && c !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(c)) return c; } return 'transparent'; };
  window.__frames = null;
  const step = () => {
    if (window.__frames) {
      const pane = document.querySelector('#content');
      const pictures = [...document.body.children].filter((el) => el.hasAttribute('data-dissolve'));
      const top = pictures[pictures.length - 1] || null;
      const style = top ? getComputedStyle(top) : null;
      window.__frames.push({
        t: performance.now(), pictures: pictures.length, phase: top ? top.dataset.phase : null, opacity: style ? Number(style.opacity) : 0,
        pictureGround: style ? style.backgroundColor : null, ground: ground(pane), busy: !!pane.querySelector(BUSY),
        ink: (pane.innerText || '').trim().length > 0 || !!pane.querySelector('canvas, svg'),
        view: pane.firstElementChild ? String(pane.firstElementChild.className).split(' ')[0] : '', path: location.pathname,
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


def lightness(color: str) -> float:
    red, green, blue = [float(n) for n in re.findall(r"[\d.]+", color)[:3]]
    return (red + green + blue) / 3 / 255


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
        # Over when the picture is gone, the view is in and nothing waits on its reads; the recorder has seen a few frames of that.
        page.wait_for_function("() => !document.querySelector('body > [data-dissolve]') && !document.querySelector('#content [aria-busy=\"true\"]:not(button, a), #content .is-opening')", timeout=8000)
        page.wait_for_timeout(250)
        return page.evaluate("() => { const frames = window.__frames; window.__frames = null; return frames; }")

    def judge(self, page: Page, frames: list[dict], label: str, dark: bool) -> None:
        self.assertGreater(len(frames), 3, f"{label}: the recorder saw the switch")
        flat = [{k: (round(v) if k == "t" else v) for k, v in frame.items() if k in ("t", "pictures", "phase", "opacity", "view", "busy", "ink")} for frame in frames]
        started = next((frame["t"] for frame in frames if frame["pictures"]), None)
        self.assertIsNotNone(started, f"{label}: the old view is kept as a picture while the new one comes in: {flat}")
        for frame in frames:
            where = f"{label} at {frame['t'] - frames[0]['t']:.0f} ms: {frame}"
            self.assertLessEqual(frame["pictures"], 1, f"one picture at a time: {where}")
            self.assertTrue(frame["pictures"] or frame["ink"], f"no blank frame: {where}")
            if frame["pictures"]:
                self.assertEqual(frame["pictureGround"], frame["ground"], f"the picture stands on the ground of the page, in the theme that is on, so it is a whole picture and not ink over ink: {where}")
                self.assertEqual(lightness(frame["pictureGround"]) < 0.5, dark, f"no flash of the other theme: {where}")
                if frame["phase"] == "held":
                    self.assertEqual(frame["opacity"], 1, f"the old view stays at full strength until the new has painted: {where}")
                else:
                    self.assertTrue(frame["ink"] and not frame["busy"], f"it fades only once the new view has painted: {where}")
            elif frame["t"] > started:
                # Nothing is over the new view now: it has painted, unless the bound on the wait was reached on a slow page.
                self.assertTrue(frame["ink"] and (not frame["busy"] or frame["t"] - started >= HOLD_MS), f"the view is on when the picture is gone: {where}")
        fading = [frame["opacity"] for frame in frames if frame["pictures"] and frame["phase"] == "fading"]
        self.assertTrue(all(later <= earlier + 1e-6 for earlier, later in zip(fading, fading[1:])), f"{label}: the opacity only falls: {fading}")
        # What the page asked the browser to run: the old view fades out over --dur-view (a slow frame rate may not sample it).
        fades = [entry for entry in recorded(page) if entry["kind"] == "script" and entry["target"] == "div" and (entry["from"] or {}).get("opacity") == 1 and (entry["to"] or {}).get("opacity") == 0]
        self.assertEqual(len(fades), 1, f"{label}: the old view fades out once: {fades}")
        self.assertLessEqual(fades[0]["duration"], 160)
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
    def test_05_reduced_motion_switches_in_one_frame_with_no_picture_and_no_animation(self):
        page = self.page(reduced=True)
        clear(page)
        for name in ("Tasks", "Map", "Wiki", "Conversation"):
            frames = self.go(page, name, False)
            self.assertTrue(all(frame["pictures"] == 0 for frame in frames), f"{name}: no picture at any frame")
            self.assertTrue(all(frame["ink"] for frame in frames), f"{name}: no blank frame")
            views = [frame["view"] for i, frame in enumerate(frames) if i == 0 or frames[i - 1]["view"] != frame["view"]]
            self.assertEqual(len(views), 2, f"{name}: the view changes once: {views}")
        self.assertEqual([entry for entry in recorded(page) if re.search(r"app__pane|^div$", entry["target"])], [], "nothing animates the content area")

    # ------------------------------------------------------------------ the picture is only a picture, and the settle is bounded
    def test_06_the_old_view_is_held_at_full_strength_while_the_new_one_waits_on_its_reads_and_goes_after_the_bound(self):
        """A view that is held back (here: for good) does not hold the old one for ever: it goes after HOLD_MS, the new view live beneath it."""
        page = self.page()
        clear(page)
        page.evaluate("() => { window.__frames = []; }")
        # The Tasks view asked to stay unsettled: a marker on its root that nothing removes. And when the picture was put up.
        page.evaluate("""() => {
          new MutationObserver((records, watch) => {
            const root = document.querySelector('#content > .tb-root'); if (!root) return; root.setAttribute('aria-busy', 'true'); watch.disconnect(); }).observe(document.querySelector('#content'), { childList: true });
          new MutationObserver((records, watch) => { if (document.querySelector('body > [data-dissolve]')) { window.__pictureAt = performance.now(); watch.disconnect(); } }).observe(document.body, { childList: true }); }""")
        project_view(page, "Tasks")
        page.wait_for_function("() => document.querySelector('body > [data-dissolve]')", timeout=8000)
        page.wait_for_function("() => !document.querySelector('body > [data-dissolve]')", timeout=8000)
        frames = page.evaluate("() => { const frames = window.__frames; window.__frames = null; return frames; }")
        held = [frame for frame in frames if frame["pictures"] and frame["phase"] == "held"]
        self.assertTrue(held and all(frame["opacity"] == 1 for frame in held), "held at full strength")
        fades = [entry for entry in recorded(page) if entry["kind"] == "script" and entry["target"] == "div" and (entry["to"] or {}).get("opacity") == 0]
        self.assertEqual(len(fades), 1, fades)
        waited = fades[0]["at"] - page.evaluate("window.__pictureAt")
        self.assertGreaterEqual(waited, HOLD_MS - 50, "held for the length of the bound")
        self.assertLess(waited, HOLD_MS + 700, "and then it goes")


if __name__ == "__main__":
    unittest.main()
