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

from playwright.sync_api import Page, Route, expect, sync_playwright

from light_motion_fixture import LightMotion, clear, ready, recorded
from project_views import project_view
from test_app_shell import ORIGIN, UI_BROWSER, UPSTREAM, start_forwarder

VIEWS = ["Conversation", "Map", "Tasks", "Wiki"]
PATH = {"Conversation": r"/projects/[^/]+/?$", "Map": r"/map$", "Tasks": r"/tasks$", "Wiki": r"/docs$"}
# How long the old view may be held for the new one to settle (ui/Dissolve.tsx HOLD_MS), and what a frame is allowed after that.
HOLD_MS = 500
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
  const ground = (el) => { for (; el; el = el.parentElement) { const c = getComputedStyle(el).backgroundColor; if (c && c !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(c)) return c; } return 'transparent'; };
  window.__frames = null;
  document.addEventListener('click', () => { window.__lastClick = performance.now(); }, true);
  const step = () => {
    if (window.__frames) {
      const pane = document.querySelector('#content');
      const pictures = [...document.body.children].filter((el) => el.hasAttribute('data-dissolve'));
      const top = pictures[pictures.length - 1] || null;
      const style = top ? getComputedStyle(top) : null;
      window.__frames.push({
        t: performance.now(), pictures: pictures.length, phase: top ? top.dataset.phase : null, of: top ? top.getAttribute('data-dissolve') : null, opacity: style ? Number(style.opacity) : 0,
        pictureGround: style ? style.backgroundColor : null, ground: ground(pane), busy: !!pane.querySelector(BUSY),
        ink: (pane.innerText || '').trim().length > 0 || !!pane.querySelector('canvas, svg'),
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
            # The "Opening …" row is for a wait that lasts: a switch that is over within a few frames never shows it (it would flash over the view).
            self.assertFalse(frame["progress"] and frame["t"] - frame["click"] < ROUTE_PROGRESS_AFTER_MS - 10, f"no route progress row on a quick switch: {where}")
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
        expect(page.locator("nav[aria-label='Project views'] a[href*='/tasks']")).to_have_attribute("aria-current", "page")
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
        expect(page.locator("nav[aria-label='Project views'] a[href*='/map']")).to_have_attribute("aria-current", "page")
        page.wait_for_function("() => window.__rows[window.__rows.length - 1][0] >= 1350")
        rows = page.evaluate("window.__rows")
        shown = [t for t, on in rows if on]
        self.assertTrue(shown, f"a wait of 260 ms shows the row: {rows}")
        self.assertGreaterEqual(shown[0], ROUTE_PROGRESS_AFTER_MS - 20, f"not before the delay: {rows}")
        self.assertGreaterEqual(shown[-1] - shown[0], ROUTE_PROGRESS_AT_LEAST_MS - 60, f"and once shown it stays its minimum although the code has arrived: {rows}")
        self.assertFalse(rows[-1][1], "and then it goes")


    def test_09_a_second_switch_while_the_picture_is_up_keeps_that_picture_and_waits_for_the_newest_view(self):
        """Tasks is switched to and, as its picture of the Conversation goes up, the Map is chosen: the picture of the Conversation stays
        (no picture of the view in between, which has not settled), holds for the Map and dissolves into it, with no blank frame."""
        page = self.page()
        project_view(page, "Map")  # warm: the Map's code is here, so it switches at once
        page.wait_for_function("() => !document.querySelector('body > [data-dissolve]')")
        project_view(page, "Conversation")
        page.wait_for_function("() => !document.querySelector('body > [data-dissolve]') && document.querySelector('#content .project-convo, #content .project-page')")
        page.wait_for_timeout(300)
        page.evaluate("() => { window.__frames = []; }")
        project_view(page, "Tasks")
        page.wait_for_function("() => document.querySelector('body > [data-dissolve]')", timeout=8000)
        project_view(page, "Map")
        page.wait_for_url(re.compile(PATH["Map"]))
        page.wait_for_function("() => !document.querySelector('body > [data-dissolve]')", timeout=8000)
        page.wait_for_timeout(250)
        frames = page.evaluate("() => { const frames = window.__frames; window.__frames = null; return frames; }")
        seen = {frame["of"] for frame in frames if frame["pictures"]}
        self.assertEqual(len(seen), 1, f"one picture, of the Conversation, for the whole of it: {seen}")
        self.assertTrue(next(iter(seen)).endswith("/conversation"), seen)
        for frame in frames:
            self.assertLessEqual(frame["pictures"], 1)
            self.assertTrue(frame["pictures"] or frame["ink"], f"no blank frame: {frame}")
        # A picture that was fading when the Map was chosen is brought back from where it was: held, its opacity only rises, to full strength.
        held = [frame["opacity"] for frame in frames if frame["pictures"] and frame["phase"] == "held"]
        self.assertTrue(held and held[-1] == 1 and all(later >= earlier - 1e-6 for earlier, later in zip(held, held[1:])), f"held: {held}")
        self.assertFalse(any(frame["pictures"] for frame in frames[-3:]), "and it is gone at the end")
        self.assertEqual(page.evaluate(ROOT), "sk-page")
        expect(page.locator("nav[aria-label='Project views'] a[href*='/map']")).to_have_attribute("aria-current", "page")


    def test_10_a_picture_that_is_fading_goes_back_to_full_strength_when_the_view_it_fades_into_has_not_settled(self):
        """The Wiki is chosen (its picture of the Conversation starts to fade, here stopped part of the way) and then the Conversation again,
        whose feed is held back until its reads have settled: the picture is back at full strength at once (no ramp that would show the
        feed unsettled), holds, and dissolves into it."""
        page = self.page()
        project_view(page, "Wiki")  # warm
        page.wait_for_function("() => !document.querySelector('body > [data-dissolve]')")
        project_view(page, "Conversation")
        page.wait_for_function("() => !document.querySelector('body > [data-dissolve]') && document.querySelector('#content .project-page')")
        page.wait_for_timeout(300)
        page.evaluate("() => { window.__frames = []; }")
        project_view(page, "Wiki")
        page.wait_for_function("() => document.querySelector('body > [data-dissolve][data-phase=fading]')", timeout=8000)
        page.evaluate("() => { const fade = (window.__animations || []).filter((a) => a.id === 'flux-motion' && a.playState === 'running' && a.effect?.target?.hasAttribute?.('data-dissolve')).pop(); fade.pause(); fade.currentTime = 60; }")
        project_view(page, "Conversation")
        page.wait_for_url(re.compile(PATH["Conversation"]))
        page.wait_for_function("() => !document.querySelector('body > [data-dissolve]')", timeout=8000)
        page.wait_for_timeout(250)
        frames = page.evaluate("() => { const frames = window.__frames; window.__frames = null; return frames; }")
        self.assertEqual(len({frame["of"] for frame in frames if frame["pictures"]}), 1, "one picture for the whole of it")
        pictures = [frame for frame in frames if frame["pictures"]]
        phases = [frame["phase"] for i, frame in enumerate(pictures) if i == 0 or pictures[i - 1]["phase"] != frame["phase"]]
        self.assertIn("fading", phases, phases)
        self.assertIn("held", phases[phases.index("fading") + 1:], f"it was fading and went back to holding: {phases}")
        for frame in frames:
            self.assertTrue(frame["pictures"] or frame["ink"], f"no blank frame: {frame}")
        # Where it went back: to full strength, never lower than where it was.
        back = [frame["opacity"] for frame in pictures[pictures.index(next(f for f in pictures if f["phase"] == "fading")):] if frame["phase"] == "held"]
        self.assertTrue(back and all(later >= earlier - 1e-6 for earlier, later in zip(back, back[1:])), f"back: {back}")
        # (A slow frame rate may sample it only once it is back at full strength: what is held is that it never dips below where it was.)
        fading = [frame["opacity"] for frame in pictures if frame["phase"] == "fading"]
        self.assertGreaterEqual(min(back), min(fading) - 1e-6, f"it comes back from where it was, never from lower: {fading} then {back}")
        self.assertEqual(back[-1], 1, "to full strength")
        self.assertEqual(page.evaluate(ROOT), "project-page")

    @staticmethod
    def weights(frame: dict) -> dict:
        """What the content area shows on a frame, as shares of its sources: the picture's view by what is left of it, the live view (by the
        root that is in the page, not by the address, which changes a moment before) by the rest, or a blank while it is unsettled."""
        names = {"project-page": "conversation", "wiki-frame": "docs", "tb-root": "tasks", "sk-page": "map"}
        shares: dict[str, float] = {}
        left = frame["opacity"] if frame["pictures"] else 0
        if frame["pictures"]:
            shares[frame["of"].rsplit("/", 1)[-1]] = left
        live = "blank" if frame["busy"] else names.get(frame["view"], frame["view"])
        shares[live] = shares.get(live, 0) + 1 - left
        return shares

    def test_11_a_return_in_the_last_part_of_the_fade_never_shows_the_view_unsettled_and_the_screen_never_jumps(self):
        """The Conversation, the Wiki, and the Conversation again with the second choice 130 to 145 ms into the 150 ms fade (the fade is stopped
        there, so the window is the same in every engine): the Conversation's feed is held back for its reads, and the nearly gone picture
        must not leave it showing for a frame or two, nor may the screen jump when the picture is replaced."""
        page = self.page()
        project_view(page, "Wiki")  # warm
        page.wait_for_function("() => !document.querySelector('body > [data-dissolve]')")
        project_view(page, "Conversation")
        page.wait_for_function("() => !document.querySelector('body > [data-dissolve]') && document.querySelector('#content .project-page')")
        for stop in (130, 140, 145):
            with self.subTest(stopped_at=stop):
                page.wait_for_timeout(300)
                page.evaluate("() => { window.__frames = []; }")
                project_view(page, "Wiki")
                page.wait_for_function("() => document.querySelector('body > [data-dissolve][data-phase=fading]')", timeout=8000)
                page.evaluate("(at) => { const fade = (window.__animations || []).filter((a) => a.id === 'flux-motion' && a.playState === 'running' && a.effect?.target?.hasAttribute?.('data-dissolve')).pop(); fade.pause(); fade.currentTime = at; window.__stoppedAt = performance.now(); }", stop)
                project_view(page, "Conversation")
                page.wait_for_url(re.compile(PATH["Conversation"]))
                page.wait_for_function("() => !document.querySelector('body > [data-dissolve]')", timeout=8000)
                page.wait_for_timeout(250)
                frames = page.evaluate("() => { const frames = window.__frames; window.__frames = null; return frames; }")
                stopped = page.evaluate("window.__stoppedAt")
                for frame in frames:
                    where = f"stopped at {stop} ms: {frame}"
                    self.assertTrue(frame["pictures"] or frame["ink"], f"no blank frame: {where}")
                    if frame["busy"] and frame["t"] - frame["click"] < HOLD_MS:
                        self.assertTrue(frame["pictures"] and frame["opacity"] == 1, f"the view that is held back is never seen through a picture that is going: {where}")
                for earlier, later in zip(frames, frames[1:]):
                    if later["t"] - earlier["t"] > 40 or earlier["t"] <= stopped:
                        continue  # a slow frame rate samples a normal fade coarsely; and the test's own stop of the fade is not the page's
                    a, b = self.weights(earlier), self.weights(later)
                    jump = sum(abs(a.get(key, 0) - b.get(key, 0)) for key in set(a) | set(b)) / 2
                    self.assertLessEqual(jump, 0.25, f"the screen does not jump (stopped at {stop} ms): {a} then {b}")
                self.assertEqual(page.evaluate(ROOT), "project-page")


if __name__ == "__main__":
    unittest.main()
