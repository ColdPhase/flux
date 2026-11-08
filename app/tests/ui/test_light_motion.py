"""Light motion across the interface (#593; #863, docs/design/motion.md).

Dialogs and their scrim, the detail panel and what it shows, project views and places, menus, toasts, state changes, rows
that come and go, and the press of every pressable control: what they animate, for how long and how, that nothing but
opacity and transform moves (a row never animates its height), that a view switch shows the new screen at once
with no held picture, that a press is colour (only a small button scales, to .98, with no spring), that reduced motion gives the
static end state, that exit motion never delays focus and that closing while opening settles on the latest state.

A recorder (light_motion_fixture.RECORDER) logs every animation the page starts, so durations and easing are read from what the
application asked the browser to run rather than guessed from frames. Boxes are sampled frame by frame while an action
runs, for the rule that a control never changes place. Chromium by default; FLUX_UI_BROWSER=webkit runs the same journeys
in WebKit. (`test_motion.py` is #155's module: the traveling highlight, arrivals and typing presence.)
"""
from __future__ import annotations

import re
import time
import unittest
import uuid

from playwright.sync_api import Page, expect, sync_playwright

from create_window import add_task
from light_motion_fixture import RECORDER, TRANSFORM_ONLY, LightMotion, clear, moved, numbers, ready, recorded, sample_while, settled
from test_app_shell import ORIGIN, UI_BROWSER, UPSTREAM, start_forwarder
from test_work_pagination import api

EASE_OUT = [0.22, 1, 0.36, 1]
EASE_IN = [0.4, 0, 1, 1]
# What must not move while the content area or the panel's content changes (Spokój rule 7).
CHROME = {"header": "header.top", "sidebar": ".app__side", "views": "nav[aria-label='Space views']"}
PROJECT_TABS = "nav[aria-label='Space views']"
# Kreska's moments, loading spinners, and the boot bar of index.html (a loading indicator that the first paint of the shell replaces).
KRESKA = re.compile(r"kreska|opening|ui-spin|boot-run|boot__")


def close(a: list[float], b: list[float], tolerance: float = 0.02) -> bool:
    return len(a) == len(b) and all(abs(x - y) <= tolerance for x, y in zip(a, b))


class LightMotionJourney(unittest.TestCase):
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

    # ------------------------------------------------------------------ helpers
    def page(self, **options) -> Page:
        context = self.fx.context(**options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught browser errors"))
        return page

    def open(self, page: Page, url: str) -> None:
        page.goto(url)
        ready(page)

    def by(self, page: Page, target: str, kind: str | None = None) -> list[dict]:
        return [entry for entry in recorded(page) if re.search(target, entry["target"]) and (kind is None or entry["kind"] == kind)]

    def assert_ease(self, entry: dict, expected: list[float], label: str) -> None:
        self.assertTrue(close(numbers(entry["easing"]), expected, 0.011), f"{label}: eased {entry['easing']!r}")

    def token_ms(self, page: Page, name: str) -> float:
        value = page.evaluate("(name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()", name)
        return numbers(value)[0] * (1 if value.endswith("ms") else 1000)

    def prime(self, page: Page) -> None:
        """A real key press just before a test closes a surface with a key the page did not get as a real one: motion that answers input is
        allowed for a second after any (the shell's own "ready" may not have come yet on a loaded machine)."""
        page.keyboard.press("Shift")

    def open_jump(self, page: Page):
        page.keyboard.press("Control+k")
        dialog = page.get_by_role("dialog", name="Search", exact=True)
        expect(dialog).to_be_visible()
        # The first time on a page the dialog is a placeholder until its search chunk arrives, and the chunk's own dialog then takes its
        # place: judge exits only once the real one is up (a WebKit run can be well into its exit when the chunk lands).
        expect(dialog.locator("input")).to_be_visible()
        return dialog

    def tab(self, name: str) -> str:
        return f"{PROJECT_TABS} a[href*='/{name}']"

    def press_scale(self, page: Page, locator, hold: int = 220) -> tuple[str, str]:
        """Holds the pointer down on a control, reads its scale, lets go elsewhere (no click) and reads it again once it settled."""
        box = locator.bounding_box()
        page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        page.mouse.down()
        page.wait_for_timeout(hold)
        pressed = locator.evaluate("el => getComputedStyle(el).scale")
        page.mouse.move(2, 2)
        page.mouse.up()
        page.wait_for_timeout(450)
        return pressed, locator.evaluate("el => getComputedStyle(el).scale")

    # ------------------------------------------------------------------ AC-1: enter and exit
    def test_01_the_tokens_carry_the_meaning_and_reduced_motion_zeroes_them(self):
        names = ("--dur-1", "--dur-in", "--dur-out", "--dur-highlight")
        page = self.page()
        self.open(page, self.fx.project_url())
        values = {name: self.token_ms(page, name) for name in names}
        self.assertEqual((values["--dur-1"], values["--dur-in"], values["--dur-out"]), (120, 180, 120))
        self.assertLessEqual(values["--dur-highlight"], 600)
        self.assertEqual(page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--press').trim()"), ".98")
        # The retired tokens are gone: no spring, no glide, no sheet curve, no separate view or press duration.
        for gone in ("--ease-spring", "--ease-glide", "--ease-sheet", "--dur-view", "--dur-press", "--shift-view"):
            self.assertEqual(page.evaluate("(name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()", gone), "", f"{gone} is retired")
        # The system setting and Settings → Appearance → Reduce motion give the same zeroes.
        calm = self.page(reduced=True)
        self.open(calm, self.fx.project_url())
        self.assertEqual({name: self.token_ms(calm, name) for name in names}, {name: 0 for name in names})
        chosen = self.page()
        self.open(chosen, "/settings/appearance")
        chosen.get_by_role("switch", name="Reduce motion").click()
        self.assertEqual(chosen.evaluate("document.documentElement.dataset.motion"), "reduce")
        self.assertEqual({name: self.token_ms(chosen, name) for name in names}, {name: 0 for name in names})
        # Both settings zero the delays too, so an end state is there at once.
        for page_ in (calm, chosen):
            delays = page_.evaluate("""() => { const el = document.createElement('div'); el.style.animation = 'ui-spin 1s linear 2s infinite'; el.style.transition = 'opacity 1s 2s'; document.body.append(el);
              const style = getComputedStyle(el); const result = [style.animationDelay, style.transitionDelay, style.animationDuration]; el.remove(); return result; }""")
            self.assertEqual([delays[0], delays[1], delays[2]], ["0s", "0s", "0s"], "durations and delays are zero under reduced motion")

    def test_02_a_dialog_and_its_scrim_fade_and_travel_within_the_budget_and_leave_faster(self):
        page = self.page()
        self.open(page, self.fx.project_url())
        clear(page)
        dialog = self.open_jump(page)
        surface = self.by(page, r"ui-overlay__surface", "script")
        scrim = self.by(page, r"ui-scrim", "script")
        self.assertTrue(surface and scrim, "the dialog and its scrim animate in")
        self.assertLessEqual(surface[0]["duration"], 180)
        self.assertLessEqual(scrim[0]["duration"], 180)
        self.assertEqual(set(surface[0]["props"]), {"opacity", "transform"}, "a short fade and transform")
        self.assertEqual(scrim[0]["props"], ["opacity"], "the scrim fades")
        self.assert_ease(surface[0], EASE_OUT, "in")
        self.assertNotIn("scale", str(surface[0]["from"]), "a dialog travels a few pixels and never scales")
        self.assertEqual(surface[0]["duration"], 180, "in: --dur-in")
        clear(page)
        page.keyboard.press("Escape")
        surface = self.by(page, r"ui-overlay__surface", "script")
        scrim = self.by(page, r"ui-scrim", "script")
        self.assertEqual(surface[0]["duration"], 120, "out: --dur-out")
        self.assertLessEqual(scrim[0]["duration"], 140)
        self.assert_ease(surface[0], EASE_IN, "out")
        self.assertTrue(set(surface[0]["props"] + scrim[0]["props"]) <= {"opacity", "transform"})
        expect(dialog).to_have_count(0)

    def test_03_the_create_window_enters_and_leaves_the_same_way(self):
        page = self.page()
        self.open(page, self.fx.tasks_url())
        clear(page)
        page.get_by_role("button", name=re.compile("^(New )?Task$")).first.click()
        expect(page.get_by_role("dialog", name="New task")).to_be_visible()
        entered = self.by(page, r"ui-overlay__surface", "script")
        self.assertTrue(entered)
        self.assertLessEqual(entered[0]["duration"], 180)
        self.assertTrue(set(entered[0]["props"]) <= {"opacity", "transform"})
        clear(page)
        page.keyboard.press("Escape")
        left = self.by(page, r"ui-overlay__surface", "script")
        self.assertLessEqual(left[0]["duration"], 140)
        expect(page.get_by_role("dialog", name="New task")).to_have_count(0)

    def test_04_exit_motion_never_delays_focus_and_the_surface_is_out_of_reach_while_it_leaves(self):
        page = self.page()
        self.open(page, self.fx.project_url())
        page.locator(".side__search").focus()
        self.open_jump(page)
        self.prime(page)
        verdict = page.evaluate("""async () => {
          const opener = document.querySelector('.side__search');
          const dialog = document.querySelector('[role="dialog"][aria-label="Search"]');
          const inside = dialog.contains(document.activeElement);
          dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          // The update React made for the key is committed in the microtask after it: before any timer or frame, never after the exit.
          await Promise.resolve(); await Promise.resolve();
          const surface = document.querySelector('.ui-overlay__surface');
          return { inside, returned: document.activeElement === opener, there: !!surface, inert: surface ? surface.inert : null,
            running: surface ? surface.getAnimations().length : 0, appInert: document.getElementById('root').inert,
            visibility: document.visibilityState, focused: document.hasFocus(), now: Math.round(performance.now()),
            durOut: getComputedStyle(document.documentElement).getPropertyValue('--dur-out'), reduce: matchMedia('(prefers-reduced-motion: reduce)').matches,
            lastAnimations: (window.__animations || []).slice(-4).map((a) => [a.id, a.playState, a.effect && a.effect.target ? (a.effect.target.className || a.effect.target.tagName) : null, a.effect ? a.effect.getComputedTiming().duration : null]),
            stored: (() => { try { return localStorage.getItem('flux.reduceMotion'); } catch (error) { return 'x'; } })(), root: document.documentElement.getAttribute('data-motion') };
        }""")
        self.assertTrue(verdict["inside"], "focus was inside the dialog")
        self.assertTrue(verdict["returned"], f"focus is back on its opener in the same task as the close: {verdict}")
        self.assertTrue(verdict["there"] and verdict["running"] >= 1, f"the surface is still animating out: {verdict}")
        self.assertTrue(verdict["inert"], "and nothing in it can be reached")
        self.assertFalse(verdict["appInert"], "the app is live again at once")
        expect(page.get_by_role("dialog", name="Search", exact=True)).to_have_count(0)

    def first_k(self, visits: tuple[str, ...], *, phone: bool = False) -> dict:
        """The first ⌘K with the code of the search held, then let go: the dialog's box and where its list starts, on its skeleton and on its content, and how many buttons name a close."""
        page = self.page(phone=phone)
        held: list = []
        page.route(re.compile(r"/assets/JumpTo-[^/]+\.js"), lambda route: held.append(route))

        def release() -> None:
            for route in held:
                try:
                    route.abort()
                except Exception:  # already continued
                    pass
        self.addCleanup(release)
        self.open(page, self.fx.project_url())
        for name in visits:
            page.locator(self.tab(name)).click()
            expect(page.locator(self.tab(name))).to_have_attribute("aria-current", "page")
        clear(page)
        page.keyboard.press("Control+k")
        dialog = page.get_by_role("dialog", name="Search", exact=True)
        expect(dialog.locator(".jump-skeleton")).to_be_visible()
        self.assertEqual(dialog.locator(".ui-spin").count(), 0, "bars at the dialog's size, not a spinner")
        self.assertEqual(page.locator(".ui-scrim").count(), 1)
        page.wait_for_timeout(300)
        shape = lambda: {"box": dialog.bounding_box(), "list": dialog.locator(".jump__list").bounding_box()["y"] - dialog.bounding_box()["y"]}
        before = shape()
        closes = page.get_by_role("button", name="Close search").count()
        while held:
            held.pop().continue_()
        expect(dialog.get_by_role("combobox", name="Search", exact=True)).to_be_visible()
        settled(page)
        after = shape()
        self.assertEqual(page.get_by_role("dialog", name="Search", exact=True).count(), 1, "still the one dialog")
        self.assertEqual(page.locator(".ui-scrim").count(), 1, "and the one scrim")
        scrim = self.by(page, r"ui-scrim", "script")
        self.assertTrue(scrim and all((entry["to"] or {}).get("opacity") == 1 for entry in scrim), f"the scrim only rises: {scrim}")
        return {"before": before, "after": after, "closes": closes}

    def test_04c_the_first_k_opens_one_dialog_at_its_final_size_and_its_content_loads_inside_it(self):
        """Used to be a blink (#863 rule 6), then a 373 px skeleton with a button of its own under the 341 px dialog that shrank to 340 when the content came,
        and on a phone a list that moved 58 px when the row of scope chips arrived. One dialog and one scrim that only rises, at the size the content has, its
        list where the real list is, with the close control where the real one is: with no recent places (a hint stands in the list), with two, and on a phone."""
        for label, visits, phone in (("no recent places", (), False), ("two recent places", ("tasks", "map"), False), ("phone", (), True)):
            with self.subTest(case=label):
                seen = self.first_k(visits, phone=phone)
                was, now = seen["before"], seen["after"]
                self.assertAlmostEqual(was["box"]["y"], now["box"]["y"], delta=1, msg="the dialog does not move")
                self.assertAlmostEqual(was["box"]["height"], now["box"]["height"], delta=2, msg=f"the skeleton is the size of the dialog it stands for: {was['box']} then {now['box']}")
                self.assertAlmostEqual(was["list"], now["list"], delta=2, msg=f"and its list starts where the real one does: {was['list']} then {now['list']}")
                self.assertEqual(seen["closes"], 0, "no button of its own under the dialog: its close is in the field row, as the real one is")

    def test_04d_the_k_dialog_leaves_at_its_own_size_while_it_fades(self):
        """On Esc the dialog used to collapse to nothing on the first frame, because its content was removed at once, and fade out as an empty box (#863 rule 3)."""
        page = self.page()
        self.open(page, self.fx.project_url())
        dialog = self.open_jump(page)
        settled(page)
        height = dialog.bounding_box()["height"]
        page.evaluate("""() => {
          const el = document.querySelector('[role="dialog"][aria-label="Search"]');
          const out = window.__exit = []; const start = performance.now();
          const step = () => { if (!el.isConnected || performance.now() - start > 1500) return;
            out.push({ t: performance.now() - start, h: el.getBoundingClientRect().height, o: Number(getComputedStyle(el.closest('.ui-overlay__surface') || el).opacity), input: !!el.querySelector('input') }); requestAnimationFrame(step); };
          requestAnimationFrame(step); }""")
        page.keyboard.press("Escape")
        expect(page.get_by_role("dialog", name="Search", exact=True)).to_have_count(0)
        frames = [frame for frame in page.evaluate("window.__exit") if frame["t"] > 0]
        self.assertGreaterEqual(len(frames), 3, f"the exit is seen: {frames}")
        for frame in frames:
            self.assertAlmostEqual(frame["h"], height, delta=1.5, msg=f"it keeps its size while it fades: {frame}")
            self.assertTrue(frame["input"], f"with its content: {frame}")
        self.assertLess(min(frame["o"] for frame in frames), 0.9, f"and it really fades: {frames}")
        expect(page.get_by_role("dialog", name="Search", exact=True)).to_have_count(0)

    def test_05_rapid_open_and_close_settles_on_the_latest_state(self):
        page = self.page()
        self.open(page, self.fx.project_url())
        for final_open in (True, False):
            with self.subTest(final_open=final_open):
                self.prime(page)
                page.evaluate("""async (finalOpen) => {
                  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
                  const toggle = (open) => {
                    if (open) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
                    else document.querySelector('[role="dialog"][aria-label="Search"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                  };
                  for (const open of [true, false, true, false, true, false, true]) { toggle(open); await wait(35); }
                  if (!finalOpen) toggle(false);
                }""", final_open)
                settled(page)
                page.wait_for_timeout(300)
                state = page.evaluate("""() => { const surface = document.querySelector('.ui-overlay__surface'); return { overlays: document.querySelectorAll('.ui-overlay').length,
                  state: document.querySelector('.ui-overlay')?.dataset.state ?? null, opacity: surface ? getComputedStyle(surface).opacity : null, surfaceInert: surface ? surface.inert : null,
                  rootInert: document.getElementById('root').inert, ours: document.getAnimations().filter((a) => a.id === 'flux-motion' && a.playState === 'running').length }; }""")
                self.assertEqual(state["ours"], 0, f"nothing is still moving: {state}")
                if final_open:
                    self.assertEqual((state["overlays"], state["state"], state["opacity"], state["surfaceInert"], state["rootInert"]), (1, "open", "1", False, True), state)
                    page.keyboard.press("Escape")
                    expect(page.get_by_role("dialog", name="Search", exact=True)).to_have_count(0)
                else:
                    self.assertEqual((state["overlays"], state["rootInert"]), (0, False), state)

    def test_06_the_detail_panel_enters_and_leaves_with_a_fade_and_a_slide(self):
        page = self.page()
        self.open(page, self.fx.tasks_url())
        clear(page)
        page.get_by_role("button", name=re.compile(re.escape(self.fx.tasks[0]["title"]))).first.click()
        panel = page.get_by_role("complementary", name="Details")
        expect(panel).to_be_visible()
        entered = self.by(page, r"ui-panel--docked", "script")
        self.assertTrue(entered, "the docked panel animates in")
        self.assertLessEqual(entered[0]["duration"], 180)
        self.assertEqual(set(entered[0]["props"]), {"opacity", "transform"})
        self.assert_ease(entered[0], EASE_OUT, "panel in")
        clear(page)
        panel.locator(".ui-panel__body").focus()
        page.keyboard.press("Escape")
        left = self.by(page, r"ui-panel--docked", "script")
        self.assertTrue(left)
        self.assertLessEqual(left[0]["duration"], 140)
        self.assert_ease(left[0], EASE_IN, "panel out")
        expect(page.locator("aside.ui-panel")).to_have_count(0)

    def test_07_a_panel_opened_and_closed_in_one_breath_settles_on_the_latest_state(self):
        page = self.page()
        self.open(page, self.fx.tasks_url())
        title = self.fx.tasks[0]["title"]
        for final_open in (True, False):
            with self.subTest(final_open=final_open):
                self.prime(page)
                page.evaluate("""async ([title, finalOpen]) => {
                  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
                  const row = [...document.querySelectorAll('.ws-item')].find((el) => el.textContent.includes(title));
                  const esc = () => document.querySelector('aside.ui-panel')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                  for (const open of [true, false, true, false, true]) { if (open) row.click(); else esc(); await wait(40); }
                  if (!finalOpen) esc();
                }""", [title, final_open])
                settled(page)
                page.wait_for_timeout(250)
                state = page.evaluate("""() => { const p = document.querySelector('aside.ui-panel'); return { n: document.querySelectorAll('aside.ui-panel').length,
                  opacity: p && getComputedStyle(p).opacity, inert: p && p.inert, transform: p && getComputedStyle(p).transform }; }""")
                if final_open:
                    self.assertEqual((state["n"], state["opacity"], state["inert"], state["transform"]), (1, "1", False, "none"), state)
                    page.locator("aside.ui-panel .ui-panel__body").focus()
                    page.keyboard.press("Escape")
                    expect(page.locator("aside.ui-panel")).to_have_count(0)
                else:
                    self.assertEqual(state["n"], 0, state)

    # ------------------------------------------------------------------ AC-1: menus, popovers and toasts
    def test_08_a_menu_fades_in_and_out_keeps_its_size_and_returns_focus_at_once(self):
        page = self.page()
        self.open(page, self.fx.task_url(self.fx.tasks[1]))
        panel = page.get_by_role("complementary", name="Details")
        status = panel.get_by_role("button", name="Status", exact=True)
        expect(status).to_be_visible()
        settled(page)
        clear(page)
        status.click()
        menu = page.get_by_role("menu", name="Status")
        expect(menu).to_be_visible()
        page.evaluate("() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))")
        css = self.by(page, r"wd-menu__list", "css")
        self.assertTrue(css and css[0]["name"], f"the menu animates in: {recorded(page)}")
        self.assertLessEqual(css[0]["duration"], 180)
        self.assertTrue(set(css[0]["props"]) <= {"opacity", "transform"}, css[0]["props"])
        self.assertEqual(menu.get_attribute("data-pop"), "open")
        self.prime(page)
        verdict = page.evaluate("""async () => {
          const menu = document.querySelector('.wd-menu__list'); const button = document.querySelector('button[aria-label="Status"]');
          menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          await Promise.resolve(); await Promise.resolve();
          const left = document.querySelector('.wd-menu__list');
          return { focused: document.activeElement === button, pop: left ? left.dataset.pop : null, inert: left ? left.inert : null,
            duration: left ? parseFloat(getComputedStyle(left).animationDuration) * 1000 : null };
        }""")
        self.assertTrue(verdict["focused"], "focus is back on its button in the same task as the close")
        self.assertEqual((verdict["pop"], verdict["inert"]), ("closing", True))
        self.assertLessEqual(verdict["duration"], 140)
        expect(page.locator(".wd-menu__list")).to_have_count(0)

    def test_09_a_toast_arrives_and_leaves_within_the_budget(self):
        task = self.fx.new_task("Order the stakes for the beds")
        page = self.page()
        self.open(page, self.fx.tasks_url())
        row = page.locator(f".ws-task[data-work-id='{task['id']}']")
        expect(row).to_be_visible()
        settled(page)
        clear(page)
        row.locator("button.ws-task__glyph").click()
        toast = page.locator(".ui-toast").first
        expect(toast).to_be_visible()
        entered = self.by(page, r"ui-toast", "script")
        self.assertTrue(entered)
        self.assertLessEqual(entered[0]["duration"], 180)
        self.assertEqual(set(entered[0]["props"]), {"opacity", "transform"})
        clear(page)
        toast.get_by_role("button", name="Dismiss notification").click()
        left = self.by(page, r"ui-toast", "script")
        self.assertTrue(left)
        self.assertLessEqual(left[0]["duration"], 140)
        expect(page.locator(".ui-toast")).to_have_count(0)

    def test_09b_every_menu_leaves_with_motion_and_focus_is_back_at_once(self):
        """The composer's menu, a message's ⋯ menu and the header's More menu stay mounted and inert through their exit.

        PR 608's review reproduced it by entering `/`, pressing Escape and inspecting the saved node on the next animation frame
        (it was gone, with no exit animation). So the node is held across the close and inspected on the very next frame.
        """
        page = self.page()
        self.open(page, self.fx.project_url())
        settled(page)
        leave = """async ({ selector, scrim, key }) => {
          const kept = document.querySelector(selector); const veil = scrim ? document.querySelector(scrim) : null;
          const label = () => document.activeElement ? (document.activeElement.getAttribute('aria-label') || document.activeElement.id || document.activeElement.tagName) : null;
          const names = (node) => node ? node.getAnimations().map((animation) => animation.animationName) : [];
          const look = () => ({ connected: kept.isConnected, inert: kept.inert, pop: kept.dataset.pop, names: names(kept), same: document.querySelector(selector) === kept, active: label(),
            veil: veil ? { connected: veil.isConnected, pop: veil.dataset.pop, inert: veil.inert, names: names(veil) } : null });
          const closed = performance.now();
          (key ? document.querySelector(key) : kept).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          // The task that closed it, once React has committed the key: the surface leaves, it is not gone, and focus is already back.
          await Promise.resolve(); await Promise.resolve();
          const now = look();
          await new Promise((frame) => requestAnimationFrame(frame));
          // The next animation frame, when it comes within the exit (a loaded machine can take longer than the 120 ms exit to draw one).
          return { now, frame: { ...look(), after: performance.now() - closed } };
        }"""

        def gone_after(verdict: dict, label: str) -> None:
            for when, seen in (("in the task that closes it", verdict["now"]), ("on the next frame", verdict["frame"] if verdict["frame"]["after"] < 100 else None)):
                if seen is None:
                    continue
                self.assertTrue(seen["connected"] and seen["same"], f"{label} is still in the page {when}: {verdict}")
                self.assertEqual((seen["pop"], seen["inert"]), ("closing", True), f"{label} is leaving and out of reach {when}: {verdict}")
                self.assertIn("ui-pop-out", seen["names"], f"{label} runs its exit animation {when}: {verdict}")

        field = page.locator("#project-composer")
        field.click()
        field.fill("/")
        expect(page.locator(".cmenu")).to_be_visible()
        self.prime(page)
        verdict = page.evaluate(leave, {"selector": ".cmenu", "key": "#project-composer"})
        gone_after(verdict, "the composer's menu")
        self.assertEqual(verdict["now"]["active"], "project-composer", "the field keeps focus through the exit")
        expect(page.locator(".cmenu")).to_have_count(0)
        message = page.locator(".project-convo__message").first
        message.hover()
        message.get_by_role("button", name="More actions").click()
        expect(page.locator(".msg-menu")).to_be_visible()
        self.prime(page)
        verdict = page.evaluate(leave, {"selector": ".msg-menu", "scrim": ".msg-menu__scrim"})
        gone_after(verdict, "the message menu")
        self.assertEqual(verdict["now"]["active"], "More actions", "focus is back on the ⋯ button in the same task as the close")
        veil = verdict["now"]["veil"]
        self.assertEqual((veil["connected"], veil["pop"], veil["inert"]), (True, "closing", True), "its scrim leaves with it")
        self.assertIn("ui-pop-fade-out", veil["names"])
        expect(page.locator(".msg-menu")).to_have_count(0)
        page.mouse.move(2, 2)
        more = page.locator("header.top").get_by_role("button", name="More", exact=True)
        more.click()
        expect(page.locator("header.top [role=menu][aria-label=More]")).to_be_visible()
        self.prime(page)
        verdict = page.evaluate(leave, {"selector": "header.top [role=menu][aria-label=More]"})
        gone_after(verdict, "the header's More menu")
        self.assertEqual(verdict["now"]["active"], "More", "focus is back on the More button in the same task as the close")
        expect(page.locator("header.top [role=menu]")).to_have_count(0)

    def test_09c_the_more_menu_over_the_header_moves_nothing_while_it_leaves(self):
        """The More menu is a popover over the header (#606): while it fades, no control beside it moves."""
        page = self.page()
        self.open(page, self.fx.project_url())
        settled(page)
        boxes = {**CHROME, "more": "header.top button[aria-label=More]", "tabs": PROJECT_TABS}
        page.locator("header.top").get_by_role("button", name="More", exact=True).click()
        expect(page.locator("header.top [role=menu][aria-label=More]")).to_be_visible()
        settled(page)
        self.prime(page)
        frames = sample_while(page, "() => { document.querySelector('header.top [role=menu][aria-label=More]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }", boxes, 300)
        expect(page.locator("header.top [role=menu]")).to_have_count(0)
        # The menu leaves the flow at once, so the controls beside the button are back where they stand without it: from the first
        # frame on they are still, however long the fade takes.
        for key in ("more", "tabs"):
            at = [frame["boxes"][key] for frame in frames[1:] if frame["boxes"][key]]
            self.assertTrue(at and all(close(box, at[0], 0.5) for box in at), f"{key} does not move while the menu leaves: {at[:3]}")

    # ------------------------------------------------------------------ AC-2: the panel's content
    def faded_in(self, page: Page, target: str) -> list[dict]:
        """What the page asked the browser to run to fade new content in: opacity from 0 to 1 over --dur-1 and nothing else."""
        return [entry for entry in recorded(page) if entry["kind"] == "script" and re.search(target, entry["target"])
                and (entry["from"] or {}).get("opacity") == 0 and (entry["to"] or {}).get("opacity") == 1 and entry["props"] == ["opacity"]]

    def test_10_a_thread_replaces_a_task_at_once_and_fades_in_and_nothing_travels_or_is_held(self):
        page = self.page()
        self.open(page, self.fx.task_url(self.fx.tasks[0]))
        panel = page.locator("#details")
        expect(panel.locator(".wd")).to_be_visible()
        settled(page)
        boxes = {"panel": "aside.ui-panel", "head": ".ui-panel__head", "close": ".ui-panel__close"}
        clear(page)
        forward = sample_while(page, "() => { [...document.querySelectorAll('#details a')].find((a) => a.textContent.includes('Should the first sensors'))?.click(); }", boxes, 600)
        expect(panel.locator(".thread")).to_be_visible()
        # The new content is in place at once and fades in over --dur-1 on --ease-out: opacity only, no travel.
        entered = self.faded_in(page, r"ui-panel__body|thread|ui-panel__slot")
        self.assertTrue(entered, f"the new content fades in: {recorded(page)}")
        self.assertEqual(entered[0]["duration"], 120)
        self.assert_ease(entered[0], EASE_OUT, "panel content in")
        self.assertEqual([entry for entry in recorded(page) if "translateX" in str((entry.get("from") or {}).get("transform", "")) and entry["duration"] == 180 and "ui-panel__body" in entry["target"]], [],
                         "the content does not travel from a side")
        # The old content is not held: no picture of it, no fade out of it, and the panel's shell, head and controls never move.
        self.assertEqual(page.locator("body > [data-dissolve]").count(), 0, "no picture of the old content")
        self.assertEqual([entry for entry in recorded(page) if entry["kind"] == "script" and entry["duration"] == 120 and (entry.get("to") or {}).get("opacity") == 0], [], "the old content does not fade out")
        for key in boxes:
            self.assertEqual(moved(forward, key), [], f"the panel's {key} never moves while its content is replaced")
        # "‹ back" returns to the task the same way.
        settled(page)
        clear(page)
        back = sample_while(page, "() => { document.querySelector('#details .ui-panel__back')?.click(); }", boxes, 600)
        expect(panel.locator(".wd")).to_be_visible()
        again = self.faded_in(page, r"ui-panel__body|wd|ui-panel__slot")
        self.assertTrue(again, "the task fades in on Back")
        self.assertEqual(again[0]["duration"], 120)
        for key in boxes:
            self.assertEqual(moved(back, key), [], f"the panel's {key} never moves on Back")
        self.assertEqual(page.locator("body > [data-dissolve]").count(), 0)

    def test_10b_the_old_content_is_gone_on_the_frame_the_new_content_is_put_up(self):
        """No held picture (#863): in the task that commits the swap the page holds the new content alone, and a pointer reaches it."""
        page = self.page()
        self.open(page, self.fx.task_url(self.fx.tasks[0]))
        panel = page.locator("#details")
        expect(panel.locator(".wd")).to_be_visible()
        settled(page)
        probe = """async (action) => {
          const body = document.querySelector('#details .ui-panel__body');
          const seen = new Promise((resolve) => {
            const watch = new MutationObserver(() => {
              if (!body.querySelector('.thread, .wd') || (action === 'forward' && body.querySelector('.wd'))) return;
              watch.disconnect();
              const copies = [...document.body.children].filter((el) => el.hasAttribute('data-dissolve')).length;
              requestAnimationFrame(() => requestAnimationFrame(() => {
                const back = document.querySelector('#details .ui-panel__back');
                const at = back ? back.getBoundingClientRect() : null;
                const hit = at ? document.elementFromPoint(at.left + at.width / 2, at.top + at.height / 2) : null;
                resolve({ copies, scoped: document.querySelectorAll('#details .wd, #details .thread').length, everywhere: document.querySelectorAll('.wd, .thread').length,
                  backReachable: back ? (hit === back || back.contains(hit)) : null });
              }));
            });
            watch.observe(body, { childList: true, subtree: true });
            setTimeout(() => { watch.disconnect(); resolve(null); }, 4000);
          });
          if (action === 'forward') [...document.querySelectorAll('#details a')].find((a) => a.textContent.includes('Should the first sensors'))?.click();
          else document.querySelector('#details .ui-panel__back')?.click();
          return seen;
        }"""
        forward = page.evaluate(probe, "forward")
        self.assertIsNotNone(forward, "the panel's content was replaced")
        self.assertEqual(forward["copies"], 0, f"no picture of the task is kept: {forward}")
        self.assertEqual((forward["scoped"], forward["everywhere"]), (1, 1), f"the page finds the one live content, never two: {forward}")
        self.assertTrue(forward["backReachable"], f"the panel's own controls are reachable: {forward}")
        expect(panel.locator(".thread")).to_be_visible()
        settled(page)
        back = page.evaluate(probe, "back")
        self.assertIsNotNone(back, "the panel's content was replaced on Back")
        self.assertEqual(back["copies"], 0, f"nor on Back: {back}")
        self.assertLessEqual(back["scoped"], 1, back)

    PANEL_FRAMES = """(ms) => {
      window.__panel = []; window.__panelDone = false;
      const top = (sel, base) => { const el = document.querySelector(sel); return el ? Math.round((el.getBoundingClientRect().top - base.getBoundingClientRect().top) * 10) / 10 : null; };
      const start = performance.now();
      const step = () => {
        const base = document.querySelector('#details .wd__scroll');
        if (base) {
          const title = document.querySelector('#details .wd-skeleton__name, #details h3.wd-title');
          window.__panel.push({ t: Math.round(performance.now() - start), skeleton: !!document.querySelector('#details .wd-skeleton'),
            title: top('#details .wd-skeleton__name, #details h3.wd-title', base), titleHeight: title ? Math.round(title.getBoundingClientRect().height * 10) / 10 : null,
            rows: top('#details .wd-skeleton__rows, #details dl.wd-rows', base), actions: top('#details .wd-skeleton__actions, #details .wd-acts', base),
            section: top('#details .wd-skeleton__sec, #details section.details__sec', base) });
        }
        if (performance.now() - start < ms) requestAnimationFrame(step); else window.__panelDone = true; };
      requestAnimationFrame(step); }"""

    def touch_page(self, width: int, height: int) -> Page:
        """A touch screen of any width: the coarse pointer's 44 px targets apply (a mouse at the same width gets the smaller ones)."""
        context = self.fx.context(phone=True, viewport={"width": width, "height": height})
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught browser errors"))
        return page

    def watch_panel(self, title: str, wait: int = 2200, touch: tuple[int, int] | None = None) -> list[dict]:
        """Opens a task from its row while its reads arrive in two steps (the task and its context, then 450 ms later its relationships) and records every frame."""
        page = self.touch_page(*touch) if touch else self.page()
        self.open(page, self.fx.tasks_url())
        settled(page)
        held: list = []
        gate = {"on": True}

        def hold(route):
            if gate["on"] and route.request.method == "GET" and "stream" not in route.request.url:
                held.append(route)
            else:
                route.fallback()
        page.route(re.compile(r"/api/v1/"), hold)
        row = page.locator(".ws-task .ws-item", has_text=title).first
        expect(row).to_be_visible()
        page.evaluate(self.PANEL_FRAMES, wait)
        row.tap() if touch else row.click()
        expect(page.locator("#details .wd-skeleton")).to_be_visible()
        self.assertEqual(page.locator("#details .ui-spin").count(), 0, "a skeleton, not a spinner")
        page.wait_for_timeout(300)
        # The task, its context and the rest come first; the relationships, last, 450 ms later.
        for route in [route for route in held if "work-relations" not in route.request.url]:
            held.remove(route)
            route.continue_()
        page.wait_for_timeout(450)
        gate["on"] = False
        while held:
            held.pop().continue_()
        page.wait_for_function("() => window.__panelDone", timeout=10000)
        return page.evaluate("window.__panel")

    def judge_panel(self, frames: list[dict], label: str) -> None:
        real = [frame for frame in frames if not frame["skeleton"] and frame["rows"] is not None]
        self.assertTrue(real and any(frame["skeleton"] for frame in frames), f"{label}: the panel went from its skeleton to its content: {frames[:3]}")
        settled_at = real[-1]
        for frame in frames:
            for part in ("title", "rows", "actions", "section"):
                if frame[part] is None:
                    continue
                self.assertLessEqual(abs(frame[part] - settled_at[part]), 2, f"{label}: the {part} is at {frame[part]} at {frame['t']} ms and ends at {settled_at[part]}: {frame}")
            if frame["titleHeight"] is not None:
                self.assertLessEqual(abs(frame["titleHeight"] - settled_at["titleHeight"]), 1.5, f"{label}: the title takes the lines it will have: {frame}")

    def test_10c_the_task_panel_has_no_jump_from_its_skeleton_to_its_content_whatever_the_title_and_the_pointer(self):
        """The task panel waits for its reads behind its own title and its fixed rows; nothing moves at any frame of the wait, including the one in between (task read,
        relationships not yet), with a title of one line and with one that wraps, with a mouse and on touch screens, where the 44 px targets of `pointer: coarse` make
        the rows 188 px and the actions 44 px high (#863 rule 6; the review found 295 px, 356 px, 295 px, a 27 px jump and, on touch, 20 px and 32 px)."""
        long = self.fx.new_task("Ask the school about two more ESP32 kits for the far beds and the gate by the shed")
        for where, touch in (("mouse", None), ("phone 390 px", (390, 844)), ("small phone 360 px", (360, 740)), ("tablet 768 px with touch", (768, 1024))):
            for task in (self.fx.tasks[0], long):
                with self.subTest(where=where, title=task["title"][:30]):
                    self.judge_panel(self.watch_panel(task["title"], touch=touch), f"{where}: {task['title'][:30]}")

    def thread_panel_at_once(self, *, phone: bool) -> None:
        page = self.page(phone=phone)
        self.open(page, self.fx.project_url())
        settled(page)
        held: list = []
        gate = {"on": True}

        def hold(route):
            if gate["on"] and route.request.method == "GET" and re.search(r"/api/v1/projects/[^/?]+(\?.*)?$", route.request.url):
                held.append(route)
            else:
                route.fallback()
        page.route(re.compile(r"/api/v1/"), hold)
        opener = page.get_by_role("button", name=re.compile(r"^\d+ repl(y|ies)")).first
        expect(opener).to_be_visible()
        page.evaluate("() => { window.__t0 = 0; document.addEventListener('click', () => { window.__t0 = performance.now(); }, true); }")
        opener.tap() if phone else opener.click()
        panel = page.locator("#details")
        expect(panel).to_be_visible()
        appeared = page.evaluate("performance.now() - window.__t0")
        self.assertLess(appeared, 300, f"the panel is up within a few frames of the press, not after the thread's reads ({appeared:.0f} ms)")
        self.assertTrue(held, "the thread's reads are being waited for")
        self.assertGreaterEqual(panel.locator(".thread__opening .opening__row").count(), 2, "with the thread's loading rows")
        self.assertEqual(panel.locator(".ui-spin").count(), 0)
        expect(panel.locator(".ui-panel__chip, .ui-panel__title")).to_contain_text("Thread")
        page.evaluate("() => { window.__panel = document.getElementById('details'); }")
        page.wait_for_timeout(700)
        self.assertTrue(panel.locator(".thread__opening").count() == 1, "and they stay while the reads are out")
        gate["on"] = False
        while held:
            held.pop().continue_()
        expect(panel.locator(".thread__feed")).to_contain_text("Moisture first")
        self.assertTrue(page.evaluate("window.__panel === document.getElementById('details')"), "the same panel takes the thread: it did not close and open again")
        self.assertEqual(panel.locator(".ui-panel__chip, .ui-panel__title").count(), 1)

    def test_10e_a_thread_opens_its_panel_on_the_frame_of_the_press_on_a_computer(self):
        """Opening a thread waits on the conversation's loader (724 ms at +200 ms reads, the same as main); its panel must not (#863 rule 2)."""
        self.thread_panel_at_once(phone=False)

    def test_10g_a_thread_opens_its_sheet_on_the_frame_of_the_press_on_a_phone(self):
        self.thread_panel_at_once(phone=True)

    def hold_projects(self, page: Page) -> tuple[list, dict]:
        """Holds the reads of the conversation's loader (the project) until the test lets them go."""
        held: list = []
        gate = {"on": True}

        def hold(route):
            if gate["on"] and route.request.method == "GET" and re.search(r"/api/v1/projects/[^/?]+(\?.*)?$", route.request.url):
                held.append(route)
            else:
                route.fallback()
        page.route(re.compile(r"/api/v1/"), hold)
        return held, gate

    def release(self, held: list, gate: dict) -> None:
        gate["on"] = False
        while held:
            held.pop().continue_()

    def test_10h_a_thread_opened_over_a_task_hides_the_task_while_the_thread_is_read(self):
        """With a task open, "Came from" opens the thread over it. The thread's rows are the panel while its reads are out: the task, which stays mounted for "‹ Task #2",
        is not on screen (it used to share the panel with the rows, two columns of 210 px with its text stacked letter by letter) (#863 rule 2)."""
        for where, phone in (("computer", False), ("phone", True)):
            with self.subTest(where=where):
                page = self.page(phone=phone)
                self.open(page, f"{self.fx.project_url()}?open=work:{self.fx.tasks[0]['id']}")
                panel = page.locator("#details")
                expect(panel.locator(".wd-from a")).to_be_visible()
                held, gate = self.hold_projects(page)
                panel.locator(".wd-from a").first.tap() if phone else panel.locator(".wd-from a").first.click()
                expect(panel.locator(".thread-opening-panel")).to_be_visible()
                page.wait_for_timeout(300)
                self.assertTrue(held, "the thread's reads are being waited for")
                shown = page.evaluate("""() => { const body = document.querySelector('#details .ui-panel__body'); const box = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; };
                  return { body: box(body), rows: box(body.querySelector('.thread-opening-panel')), others: [...body.children].filter((el) => !el.matches('.thread-opening-panel')).map((el) => [String(el.className).split(' ')[0], getComputedStyle(el).display, box(el)]),
                           chip: document.querySelector('#details .ui-panel__chip')?.textContent }; }""")
                self.assertEqual([entry[1] for entry in shown["others"]], ["none"] * len(shown["others"]), f"what the panel showed is mounted and not displayed: {shown}")
                self.assertGreaterEqual(shown["rows"][0], shown["body"][0] - 2, f"the rows have the whole panel: {shown}")
                self.assertIn("Thread", shown["chip"])
                self.release(held, gate)
                expect(panel.locator(".thread__feed")).to_contain_text("Moisture first")
                expect(panel.locator(".ui-panel__back")).to_contain_text("Task")

    def test_10i_cancelling_a_thread_that_opens_leaves_with_its_rows_not_with_the_space_overview(self):
        """With the panel closed, replies then Esc: the panel leaves over 120 ms with the thread's rows. It used to show the space's Overview, at full opacity,
        for the 175 ms the rows lingered and the exit after them, because that was mounted behind the rows on every thread open (#863 rule 3)."""
        for where, phone in (("computer", False), ("phone", True)):
            with self.subTest(where=where):
                page = self.page(phone=phone)
                self.open(page, self.fx.project_url())
                settled(page)
                held, gate = self.hold_projects(page)
                opener = page.get_by_role("button", name=re.compile(r"^\d+ repl(y|ies)")).first
                opener.tap() if phone else opener.click()
                panel = page.locator("#details")
                expect(panel.locator(".thread-opening-panel")).to_be_visible()
                page.wait_for_timeout(250)
                page.evaluate("""() => { const out = window.__cancel = []; const start = performance.now();
                  const step = () => { const body = document.querySelector('#details .ui-panel__body'); const panel = document.getElementById('details');
                    if (panel) out.push({ t: Math.round(performance.now() - start), rows: !!body?.querySelector('.thread-opening-panel'), others: body ? [...body.children].filter((el) => !el.matches('.thread-opening-panel')).map((el) => String(el.className).split(' ')[0]) : [], opacity: Number(getComputedStyle(panel.closest('.ui-overlay__surface') || panel).opacity) });
                    if (performance.now() - start < 900) requestAnimationFrame(step); };
                  requestAnimationFrame(step); }""")
                page.keyboard.press("Escape")
                expect(page.locator("#details")).to_have_count(0)
                page.wait_for_timeout(700)
                self.release(held, gate)
                frames = page.evaluate("window.__cancel")
                self.assertTrue(frames, "the panel's exit was seen")
                for frame in frames:
                    self.assertEqual(frame["others"], [], f"nothing but the thread's rows is in the panel, at any frame: {frame}")
                self.assertTrue(any(frame["opacity"] < 0.95 for frame in frames), f"and it fades: {frames}")

    def test_10j_a_thread_opening_has_no_row_across_the_panels_head_at_any_width(self):
        """When the reads take over 200 ms the "Opening the conversation…" row used to lie across the panel's head, over its chip, title and the top of its close control,
        and a press on the X landed on the row's Cancel. The panel is the loading state; the row waits for a navigation that has no panel (#863 rule 2)."""
        for where, size, phone in (("1024", (1024, 800), False), ("1440", (1440, 900), False), ("1920", (1920, 1000), False), ("phone", (390, 844), True)):
            with self.subTest(width=where):
                context = self.fx.context(phone=phone, viewport={"width": size[0], "height": size[1]})
                self.addCleanup(context.close)
                page = context.new_page()
                self.open(page, self.fx.project_url())
                settled(page)
                held, gate = self.hold_projects(page)
                opener = page.get_by_role("button", name=re.compile(r"^\d+ repl(y|ies)")).first
                opener.tap() if phone else opener.click()
                expect(page.locator("#details .thread-opening-panel")).to_be_visible()
                page.wait_for_timeout(500)
                self.assertTrue(held, "the reads are waited for, past the 200 ms after which the row comes up")
                self.assertEqual(page.locator(".route-progress").count(), 0, "no row: the panel is the loading state")
                close = page.locator("#details .ui-panel__close")
                box = close.bounding_box()
                hit = page.evaluate("([x, y]) => !!document.elementFromPoint(x, y)?.closest('.ui-panel__close')", [box["x"] + box["width"] / 2, box["y"] + box["height"] / 2])
                self.assertTrue(hit, "a press on the centre of the panel's close control lands on it")
                self.release(held, gate)
                expect(page.locator("#details .thread__feed")).to_contain_text("Moisture first")

    def test_10f_a_panel_that_cannot_know_its_layout_draws_none(self):
        """A decision's lead and the title above its rows have lengths nobody knows before the read: its skeleton is a title bar and quiet lines, with no
        rows, actions or sections at guessed places (the review found a short decision 97 px off) (#863 rule 6)."""
        page = self.page()
        held: list = []
        page.route(re.compile(r"/work-objects/"), lambda route: held.append(route))

        def release() -> None:
            for route in held:
                try:
                    route.abort()
                except Exception:
                    pass
        self.addCleanup(release)
        page.goto(f"/projects/{self.fx.project}/tasks?view=list&open=decision:{self.fx.decision['id']}")
        skeleton = page.locator("#details .wd-skeleton")
        expect(skeleton).to_be_visible()
        self.assertEqual(skeleton.locator(".wd-skeleton__rows, .wd-skeleton__row, .wd-skeleton__actions").count(), 0, "no rows or actions at guessed places")
        self.assertEqual(page.locator("#details .ui-spin").count(), 0)

    def test_10d_the_thread_panel_and_the_stream_never_open_empty_while_their_first_reads_settle(self):
        """The replies are laid out but hidden until the first reads that decorate them have settled (at most a second, #155). They used to be
        hidden with nothing in their place (the thread) or with the stream's rows still at opacity 0 behind the wait (#863 rule 6)."""
        page = self.page()
        held: list = []
        page.route(re.compile(r"/work-associations|/work-reference-rows"), lambda route: held.append(route))

        def release() -> None:
            for route in held:
                try:
                    route.abort()
                except Exception:  # the page already gave the request up
                    pass
        self.addCleanup(release)
        page.goto(self.fx.thread_url())
        stream_rows = page.locator(".convo-stream .opening .opening__row")
        thread_rows = page.locator(".thread__opening .opening__row")
        expect(thread_rows.first).to_be_visible()
        expect(stream_rows.first).to_be_visible()
        self.assertEqual(page.locator(".thread__feed.is-opening").count(), 1, "the replies are laid out but hidden")
        self.assertEqual(page.locator(".convo-stream .opening").evaluate("el => getComputedStyle(el).opacity"), "1", "and the stream's rows are not waiting behind a delay")
        self.assertGreaterEqual(thread_rows.count(), 2)
        # The panel's frame and composer are there meanwhile; once the wait is over the rows give way to the replies.
        expect(page.locator("#thread-composer")).to_be_visible()
        expect(page.locator(".thread__feed.is-opening")).to_have_count(0, timeout=5000)
        expect(page.locator(".thread__opening")).to_have_count(0)
        expect(page.locator(".thread__feed")).to_contain_text("Moisture first")

    def test_11_a_view_switch_shows_the_new_screen_at_once_with_one_short_fade_and_nothing_else_moves(self):
        page = self.page()
        self.open(page, self.fx.project_url())
        settled(page)
        clear(page)
        boxes = {**CHROME, "composer": ".composer__box"}
        frames = sample_while(page, f"() => {{ document.querySelector(\"{self.tab('tasks')}\").click(); }}", boxes, 900)
        expect(page.locator(self.tab("tasks"))).to_have_attribute("aria-current", "page")
        # The new content fades in over --dur-1 on --ease-out (at most 120 ms): opacity only, no travel, no old view fading out.
        entered = self.faded_in(page, r"app__pane|tb-root|ws-tasks|pane-in|div")
        content = [entry for entry in entered if entry["duration"] == 120]
        self.assertTrue(content, f"the new view fades in: {recorded(page)}")
        self.assertLessEqual(content[0]["duration"], 120)
        self.assert_ease(content[0], EASE_OUT, "view")
        self.assertEqual([entry for entry in recorded(page) if entry["kind"] == "script" and (entry["to"] or {}).get("opacity") == 0 and "translateX" in str((entry["to"] or {}).get("transform", ""))], [], "no old view travels away")
        self.assertEqual(page.locator("body > [data-dissolve]").count(), 0, "the old view is not held as a picture")
        for key in (*CHROME, "composer"):
            self.assertEqual(moved(frames, key), [], f"the {key} stays still during the switch")
        # Back to the conversation is the same: its composer arrives in its own place and never travels.
        settled(page)
        clear(page)
        back = sample_while(page, f"() => {{ document.querySelector(\"{PROJECT_TABS} a:first-of-type\").click(); }}", boxes, 900)
        expect(page.locator(".composer__box").first).to_be_visible()
        self.assertTrue([entry for entry in self.faded_in(page, r"app__pane|project-convo|project-page|pane-in|div") if entry["duration"] == 120])
        seen = [frame["boxes"]["composer"] for frame in back if frame["boxes"]["composer"]]
        self.assertTrue(seen)
        self.assertTrue(all(close(box, seen[-1], 0.5) for box in seen), f"the composer never moves: {seen[:3]}")
        for key in CHROME:
            self.assertEqual(moved(back, key), [], f"the {key} stays still on the way back")
        # A thread opening beside the conversation is not a view switch, and a first load animates nothing.
        page.goto(self.fx.thread_url())
        ready(page)
        self.assertEqual(self.by(page, r"app__pane"), [], "first load animates nothing")

    def test_11b_the_page_holds_the_new_view_alone_on_the_frame_it_is_put_up(self):
        """No held picture (#863): queries of the page find the new view alone, a pointer reaches the live page, and nothing is blank."""
        page = self.page()
        self.open(page, self.fx.project_url())
        expect(page.locator(".project-convo").first).to_be_visible()
        settled(page)
        verdict = page.evaluate("""async () => {
          const reach = (selector) => { const el = document.querySelector(selector); if (!el) return null; const at = el.getBoundingClientRect();
            const hit = document.elementFromPoint(at.left + at.width / 2, at.top + at.height / 2);
            return { ok: !!hit && (hit === el || el.contains(hit) || hit.contains(el)), hit: hit ? hit.tagName + '.' + hit.className : null }; };
          const seen = new Promise((resolve) => {
            const watch = new MutationObserver(() => {
              if (!document.querySelector('#content .tb-root, #content .ws-tasks')) return;
              watch.disconnect();
              const committed = { pictures: [...document.body.children].filter((el) => el.hasAttribute('data-dissolve')).length,
                queries: [document.querySelectorAll('.project-convo').length, document.querySelectorAll('.composer').length] };
              requestAnimationFrame(() => requestAnimationFrame(() => resolve({ ...committed, reach: {
                tabs: reach("nav[aria-label='Space views'] a[href*='/map']"), side: reach('.app__side a, .app__side button'), top: reach('header.top button, header.top a') } })));
            });
            watch.observe(document.querySelector('#content'), { childList: true, subtree: true });
            setTimeout(() => { watch.disconnect(); resolve(null); }, 4000);
          });
          document.querySelector("nav[aria-label='Space views'] a[href*='/tasks']").click();
          return seen;
        }""")
        self.assertIsNotNone(verdict, "the view was switched")
        self.assertEqual(verdict["pictures"], 0, f"no picture of the old view: {verdict}")
        self.assertEqual(verdict["queries"], [0, 0], f"queries of the page find the new view alone: {verdict}")
        for selector, seen in verdict["reach"].items():
            self.assertTrue(seen and seen["ok"], f"{selector} is reached by a pointer on the first frame: {verdict}")

    def test_11c_a_modal_panel_stays_reachable_while_the_page_beneath_switches(self):
        """A tablet's panel is an overlay: when the page under it switches views, its own controls work on every frame."""
        page = self.page(viewport={"width": 820, "height": 1180})
        self.open(page, self.fx.task_url(self.fx.tasks[0]))
        panel = page.locator("#details")
        expect(panel.locator(".wd")).to_be_visible()
        settled(page)
        verdict = page.evaluate("""async () => {
          const describe = (el) => el ? el.tagName.toLowerCase() + '.' + String(el.className).split(/\\s+/).join('.') : null;
          const link = [...document.querySelectorAll('#details a')].find((a) => a.textContent.includes('Should the first sensors'));
          link.click();
          const during = [];
          for (let frame = 0; frame < 60; frame++) {
            await new Promise((resolve) => requestAnimationFrame(resolve));
            const close = document.querySelector('#details .ui-panel__close'); const at = close.getBoundingClientRect();
            const hit = document.elementFromPoint(at.left + at.width / 2, at.top + at.height / 2);
            during.push({ picture: [...document.body.children].some((el) => el.hasAttribute('data-dissolve')), ok: !!hit && (hit === close || close.contains(hit)), hit: describe(hit) });
          }
          return during;
        }""")
        self.assertFalse(any(entry["picture"] for entry in verdict), f"no picture of the page beneath: {verdict}")
        self.assertTrue(all(entry["ok"] for entry in verdict), f"the panel's close control is reachable on every frame: {verdict}")

    def test_12_a_place_switch_is_the_same_and_the_reading_position_is_not_animated(self):
        page = self.page()
        self.open(page, self.fx.project_url())
        settled(page)
        clear(page)
        page.get_by_role("navigation", name="Places").get_by_role("link", name="Inbox").click()
        expect(page.get_by_role("heading", level=1, name="Inbox")).to_be_visible()
        page.wait_for_function("() => (window.__motion || []).some((entry) => entry.kind === 'script' && entry.duration === 120 && entry.from && entry.from.opacity === 0 && entry.to && entry.to.opacity === 1)")
        entered = [entry for entry in recorded(page) if entry["kind"] == "script" and entry["duration"] == 120 and (entry["from"] or {}).get("opacity") == 0]
        self.assertTrue(entered and set(entered[0]["props"]) == {"opacity"}, recorded(page))
        self.assertEqual(page.locator("body > [data-dissolve]").count(), 0)
        self.assertEqual([entry for entry in recorded(page) if any("scroll" in prop.lower() for prop in entry["props"])], [], "no animation of the scroll position")

    # ------------------------------------------------------------------ AC-4: state changes and rows
    def test_13_a_state_change_morphs_the_glyph_the_word_and_slides_the_row_to_its_group(self):
        task = self.fx.new_task("Order the ground anchors")
        page = self.page()
        self.open(page, self.fx.tasks_url())
        row = page.locator(f".ws-task[data-work-id='{task['id']}']")
        expect(row).to_be_visible()
        settled(page)
        clear(page)
        row.locator("button.ws-task__glyph").click()
        expect(page.locator(f".ws-task[data-work-id='{task['id']}']")).to_have_attribute("data-status", "in_progress")
        glyph = self.by(page, r"ui-glyph", "script")
        self.assertTrue(glyph, "the state glyph morphs")
        self.assertLessEqual(glyph[0]["duration"], 180)
        self.assertEqual(set(glyph[0]["props"]), {"opacity", "transform"})
        slides = [entry for entry in self.by(page, r"ws-task", "script") if entry["props"] == ["transform"]]
        self.assertTrue(slides, "the row, and the rows it moved past, slide in place")
        for entry in recorded(page):
            if entry["props"] != ["scale"]:
                self.assertTrue(set(entry["props"]) <= TRANSFORM_ONLY, f"{entry['target']} animates {entry['props']}")

    def test_13d_a_task_notice_does_not_morph_its_glyph_when_the_conversation_opens(self):
        """The notice's state glyph used to flip from the open outline to its state on every visit; it morphs only from a state it knew (#863 rule 5)."""
        page = self.page()
        self.open(page, self.fx.project_url())
        expect(page.locator(".convo-stream .ui-glyph").first).to_be_attached()
        page.wait_for_timeout(800)
        self.assertEqual(self.by(page, r"ui-glyph", "script"), [], f"no glyph morphs on the first view: {recorded(page)}")
        page.locator(self.tab("tasks")).click()
        expect(page.locator(self.tab("tasks"))).to_have_attribute("aria-current", "page")
        clear(page)
        page.locator(self.tab("")).first.click()
        expect(page.locator(".convo-stream")).to_be_visible()
        page.wait_for_timeout(800)
        self.assertEqual(self.by(page, r"ui-glyph", "script"), [], f"nor when the conversation is visited again: {recorded(page)}")

    def test_13b_a_row_that_moves_across_the_list_comes_in_with_a_short_slide_not_a_long_flight(self):
        """Motion is short and calm (final design §2): a row sent to another group far down the list is not carried the whole way.

        The neutral visual review of PR 608 read one row translating 320 px while three others moved 57 to 114 px in the same frame:
        the row of an in-progress task marked done, with the open ones between it and the finished group.
        """
        import uuid
        ada = self.fx.contexts["ada"]
        project = api(ada, "POST", f"/api/v1/workspaces/{self.fx.workspace}/projects", {"name": "Long list for the row cap", "visibility": "restricted"}, 201)["id"]

        def task(title: str, status: str | None = None) -> str:
            made = api(ada, "POST", f"/api/v1/projects/{project}/work", {"title": title, "clientCommandId": str(uuid.uuid4())}, 201)
            if status:
                made = api(ada, "PATCH", f"/api/v1/work/{made['id']}", {"status": status, "expectedVersion": made["version"]})
            return made["id"]

        finished = task("Cap list: already finished", "done")
        for index in range(4):
            task(f"Cap list: open {index}")
        moving = task("Cap list: in progress", "in_progress")
        page = self.page()
        self.open(page, f"/projects/{project}/tasks?view=list")
        row = page.locator(f".ws-task[data-work-id='{moving}']")
        expect(row).to_have_attribute("data-status", "in_progress")
        expect(page.locator(f".ws-task[data-work-id='{finished}']")).to_be_visible()
        settled(page)
        before = row.bounding_box()["y"]
        clear(page)
        row.locator("button.ws-task__glyph").click()
        expect(page.locator(f".ws-task[data-work-id='{moving}']")).to_have_attribute("data-status", "done")
        settled(page)
        travel = abs(page.locator(f".ws-task[data-work-id='{moving}']").bounding_box()["y"] - before)
        self.assertGreater(travel, 160, f"the row really did move across the list ({travel:.0f} px), so the cap is what is under test")
        slides = [entry for entry in self.by(page, r"ws-task", "script") if "transform" in entry["props"]]
        self.assertTrue(slides, recorded(page))
        for entry in slides:
            distance = max(abs(n) for n in numbers(entry["from"]["transform"]))
            self.assertLessEqual(distance, 160, f"no row is carried further than the cap: {entry}")
        arrivals = [entry for entry in slides if (entry["from"] or {}).get("opacity") == 0]
        self.assertTrue(arrivals, f"the row that moved far fades in at its new place instead: {slides}")
        self.assertLessEqual(max(abs(n) for n in numbers(arrivals[0]["from"]["transform"])), 12.5, "with a short slide from the side it came from")
        self.assertLessEqual(arrivals[0]["duration"], 180)
        self.assertEqual(set(arrivals[0]["props"]), {"opacity", "transform"})

    def test_13c_a_board_move_has_its_one_motion_at_the_drop_and_the_servers_answer_adds_none(self):
        """The card slides to its column when it is moved; the server's answer, 700 ms later, neither tints the card nor replays the slide (#863 rule 4, 5)."""
        task = self.fx.new_task("Seal the gateway enclosure")
        page = self.page()
        self.open(page, self.fx.tasks_url("board"))
        card = page.locator(".tb-card", has_text=task["title"])
        expect(card).to_be_visible()
        settled(page)
        held: list = []
        page.route(re.compile(rf"/api/v1/work/{task['id']}$"), lambda route: held.append(route) if route.request.method == "PATCH" else route.fallback())
        clear(page)
        card.get_by_role("button", name="Move to…").click()
        page.get_by_role("menu").get_by_role("menuitemradio", name="Done").click()
        expect(page.get_by_role("region", name="Done", exact=True).locator(".tb-card", has_text=task["title"])).to_be_visible()
        page.wait_for_timeout(500)
        settled(page)
        self.assertEqual(len(held), 1, "the answer is held")
        at_drop = len(recorded(page))
        self.assertTrue([entry for entry in recorded(page) if "tb-card" in entry["target"]], f"the card moves at the drop: {recorded(page)}")
        held.pop().continue_()
        expect(page.locator(".ui-toast").filter(has_text=re.compile(r"done"))).to_be_visible()
        page.wait_for_timeout(900)
        later = recorded(page)[at_drop:]
        self.assertEqual([entry for entry in later if "tb-" in entry["target"] or "arrive" in entry.get("name", "")], [], f"the answer adds no motion to the board: {later}")
        self.assertEqual(page.locator(".tb-card.is-arrived").count(), 0)

    def test_14_an_added_row_fades_in_where_it_stands_and_the_rows_below_slide_with_transform(self):
        page = self.page()
        self.open(page, self.fx.tasks_url())
        settled(page)
        clear(page)
        add_task(page, "Replace the cracked sensor housing")
        expect(page.locator(".ws-task", has_text="Replace the cracked sensor housing")).to_be_visible()
        entries = [entry for entry in recorded(page) if "ws-task" in entry["target"]]
        faded = [entry for entry in entries if entry["props"] == ["opacity"]]
        self.assertTrue(faded, f"the new row fades in: {recorded(page)}")
        self.assertLessEqual(faded[0]["duration"], 180)
        for entry in recorded(page):
            self.assertNotIn("height", [prop.lower() for prop in entry["props"]], f"a row never animates its height: {entry}")
            self.assertTrue(set(entry["props"]) <= TRANSFORM_ONLY, f"{entry['target']} animates {entry['props']}")

    def test_15_an_accepted_decision_goes_at_once_and_the_card_below_slides_up_and_stays_reachable(self):
        page = self.page()
        self.open(page, "/inbox")
        cards = page.locator(".nyc")
        expect(cards.nth(1)).to_be_visible()
        first, below = cards.nth(0), cards.nth(1)
        gone, stays = first.get_attribute("data-key"), below.get_attribute("data-key")
        settled(page)
        clear(page)
        count = cards.count()
        first.get_by_role("button", name=re.compile("^Accept")).click()
        expect(page.locator(f".nyc[data-key='{gone}']")).to_have_count(0)
        expect(cards).to_have_count(count - 1)
        for entry in recorded(page):
            self.assertNotIn("height", [prop.lower() for prop in entry["props"]], f"a card never animates its height: {entry}")
        slid = [entry for entry in recorded(page) if "nyc" in entry["target"] and "transform" in entry["props"]]
        self.assertTrue(slid, f"the cards below slide up into the place it left: {recorded(page)}")
        self.assertLessEqual(slid[0]["duration"], 180)
        self.assertEqual(page.locator("[data-row-ghost]").count(), 0, "no outgoing copy is kept")
        settled(page)
        box = page.locator(f".nyc[data-key='{stays}']").bounding_box()
        reachable = page.evaluate("([x, y, key]) => !!document.elementFromPoint(x, y)?.closest(`.nyc[data-key='${key}']`)", [box["x"] + box["width"] / 2, box["y"] + box["height"] / 2, stays])
        self.assertTrue(reachable, "the card below is where it looks to be, and a pointer reaches it")

    def test_15b_rows_that_leave_in_quick_succession_leave_cleanly(self):
        """Two decisions accepted within a tenth of a second and two states changed back to back: React and the collapsing copies coexist."""
        for title in ("Order spare batteries in bulk", "Keep the gateway indoors"):
            api(self.fx.contexts["jonas"], "POST", self.fx.root + "/decisions", {"title": title, "rationale": "Fewer site visits."}, 201)
        page = self.page()
        self.open(page, "/inbox")
        pair = re.compile("Order spare batteries|Keep the gateway")
        expect(page.locator(".nyc", has_text=pair)).to_have_count(2)
        page.evaluate("""async () => { for (const card of [...document.querySelectorAll('.nyc')].filter((c) => /Order spare batteries|Keep the gateway/.test(c.textContent))) {
          card.querySelector('.nyc__accept').click(); await new Promise((resolve) => setTimeout(resolve, 60)); } }""")
        expect(page.locator(".nyc", has_text=pair)).to_have_count(0)
        settled(page)
        self.assertEqual(page.locator("[data-row-ghost]").count(), 0, "no outgoing copy is kept")
        extra = [self.fx.new_task(f"Stress the list {index}") for index in range(2)]
        tasks = self.page()
        self.open(tasks, self.fx.tasks_url())
        settled(tasks)
        tasks.evaluate("""async (ids) => { for (const id of ids) { document.querySelector(`.ws-task[data-work-id="${id}"] button.ws-task__glyph`).click(); await new Promise((resolve) => setTimeout(resolve, 40)); } }""", [task["id"] for task in extra])
        for task in extra:
            expect(tasks.locator(f".ws-task[data-work-id='{task['id']}']")).to_have_attribute("data-status", "in_progress")
        settled(tasks)
        ids = tasks.evaluate("[...document.querySelectorAll('.ws-task[data-work-id]')].map((el) => el.dataset.workId)")
        self.assertEqual(len(ids), len(set(ids)), "no row is drawn twice")
        self.assertEqual(tasks.locator("[data-row-ghost]").count(), 0)

    # ------------------------------------------------------------------ AC-5: press and hover
    def test_16_a_press_is_colour_and_only_a_small_button_scales_with_no_spring(self):
        page = self.page()
        self.open(page, self.fx.tasks_url())
        settled(page)
        small = {
            "icon button": page.get_by_role("button", name="Collapse sidebar").first,
            "state glyph button": page.locator("button.ws-task__glyph").first,
        }
        for name, target in small.items():
            with self.subTest(control=name):
                expect(target).to_be_visible()
                pressed, released = self.press_scale(page, target)
                self.assertEqual(numbers(pressed), [0.98], f"{name}: pressed scale {pressed!r}")
                self.assertIn(released, ("none", "1"), f"{name}: back to full size, {released!r}")
        released = [entry for entry in recorded(page) if entry["props"] == ["scale"] and entry["from"] and numbers(entry["from"]["scale"]) and numbers(entry["from"]["scale"])[0] < 1 and entry["to"] and numbers(entry["to"]["scale"]) == [1]]
        self.assertTrue(released, "the release is animated")
        self.assertEqual(released[0]["duration"], 120, "the release takes --dur-1")
        self.assert_ease(released[0], EASE_OUT, "release (no spring)")
        # Rows, cards, list items and sidebar items never scale: a press changes their colour only. A wide button does not scale either.
        never = {
            "button": page.get_by_role("button", name=re.compile("^(New )?Task$")).first,
            "row that opens something": page.locator(".ws-task .ws-item").first,
            "sidebar row": page.locator(".side__project").first,
        }
        for name, target in never.items():
            with self.subTest(control=name):
                expect(target).to_be_visible()
                pressed, _ = self.press_scale(page, target)
                self.assertEqual(pressed, "none", f"{name} never scales: {pressed!r}")
        # A disabled send does not press; once it can send it does (it is a small button).
        page.goto(self.fx.project_url())
        ready(page)
        send = page.locator(".composer__send").first
        pressed, _ = self.press_scale(page, send, 120)
        self.assertEqual(pressed, "none", "a send button that cannot send does not press")
        page.locator("#project-composer").fill("Probes arrive on Thursday")
        pressed, _ = self.press_scale(page, send)
        self.assertEqual(numbers(pressed), [0.98], pressed)

    def fills(self, page: Page, target, hold: int = 260) -> dict[str, str]:
        """A control's fill at rest, under the pointer and with the button held down on it (the pointer is over it and pressing it at once)."""
        read = "el => getComputedStyle(el).backgroundColor"
        page.mouse.move(2, 2)
        page.wait_for_timeout(300)
        rest = target.evaluate(read)
        box = target.bounding_box()
        page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        page.wait_for_timeout(300)
        hover = target.evaluate(read)
        page.mouse.down()
        page.wait_for_timeout(hold)
        pressed = target.evaluate(read)
        page.mouse.move(2, 2)
        page.mouse.up()
        page.wait_for_timeout(300)
        return {"rest": rest, "hover": hover, "pressed": pressed}

    def test_16b_a_press_changes_the_fill_of_every_kind_of_control_and_not_only_the_hover_does(self):
        """A mouse is over the control when it presses it, so the pressed fill must be one the hover is not (#863 rules 1 and 7); a wide button does not scale, so colour is all it has."""
        page = self.page()
        self.open(page, self.fx.tasks_url())
        settled(page)
        targets = {
            "wide button": page.get_by_role("button", name=re.compile("^(New )?Task$")).first,
            "small icon button": page.get_by_role("button", name="Collapse sidebar").first,
            "row that opens something": page.locator(".ws-task .ws-item").first,
            "sidebar row": page.get_by_role("navigation", name="Places").get_by_role("link", name="Inbox"),
        }
        for name, target in targets.items():
            with self.subTest(control=name):
                expect(target).to_be_visible()
                fill = self.fills(page, target)
                self.assertNotEqual(fill["pressed"], fill["rest"], f"{name}: the press changes the fill: {fill}")
                self.assertNotEqual(fill["pressed"], fill["hover"], f"{name}: and it is not the hover's fill: {fill}")
        primary = page.locator(".ui-btn--primary:visible").first
        if primary.count():
            with self.subTest(control="primary button"):
                fill = self.fills(page, primary)
                self.assertNotEqual(fill["pressed"], fill["hover"], f"the primary button: a press apart from the hover: {fill}")
                self.assertNotEqual(fill["pressed"], fill["rest"], fill)
        self.open(page, "/")
        card = page.locator(".home__continue .home__row").first
        expect(card).to_be_visible()
        with self.subTest(control="Continue row"):
            fill = self.fills(page, card)
            self.assertNotEqual(fill["pressed"], fill["rest"], f"the Continue row: the press changes the fill: {fill}")
            self.assertNotEqual(fill["pressed"], fill["hover"], fill)

    def test_17_the_message_toolbar_has_its_shared_reveal_pose(self):
        page = self.page()
        self.open(page, self.fx.project_url())
        pose = page.evaluate("""() => { const el = document.createElement('div'); el.className = 'ui-reveal'; el.dataset.side = 'start'; document.body.append(el);
          const hidden = getComputedStyle(el); const result = { opacity: hidden.opacity, transform: hidden.transform, duration: hidden.transitionDuration };
          el.style.transition = 'none'; el.classList.add('is-shown'); const shown = getComputedStyle(el); result.shown = { opacity: shown.opacity, transform: shown.transform }; el.remove(); return result; }""")
        self.assertEqual(pose["opacity"], "0")
        self.assertLessEqual(numbers(pose["transform"])[4], -4, "from its own side: a few pixels to the left")
        self.assertEqual(pose["shown"]["opacity"], "1")
        self.assertEqual(pose["shown"]["transform"], "none")

    def test_17b_the_message_toolbar_fades_and_slides_in_from_its_side(self):
        page = self.page()
        self.open(page, self.fx.project_url())
        settled(page)
        message = page.locator(".project-convo__message.is-mine").first
        expect(message).to_be_visible()
        toolbar = message.locator("> .msg-acts")
        self.assertIn("ui-reveal", toolbar.get_attribute("class"))
        rest = toolbar.evaluate("el => { const s = getComputedStyle(el); return { opacity: s.opacity, transform: s.transform, duration: s.transitionDuration }; }")
        self.assertEqual(rest["opacity"], "0")
        self.assertEqual(numbers(rest["transform"])[4], -6, "an own message's pill comes in from the left, six pixels")
        message.hover()
        page.wait_for_timeout(400)
        shown = toolbar.evaluate("el => { const s = getComputedStyle(el); return { opacity: s.opacity, transform: s.transform }; }")
        self.assertEqual((shown["opacity"], shown["transform"]), ("1", "none"))
        page.mouse.move(2, 2)
        page.wait_for_timeout(400)
        self.assertEqual(toolbar.evaluate("el => getComputedStyle(el).opacity"), "0")

    # ------------------------------------------------------------------ AC-6: discipline
    def test_18_only_opacity_and_transform_animate_across_the_journeys(self):
        page = self.page()
        self.open(page, self.fx.project_url())
        clear(page)
        self.open_jump(page)
        page.keyboard.press("Escape")
        expect(page.get_by_role("dialog", name="Search", exact=True)).to_have_count(0)
        page.locator(self.tab("tasks")).click()
        expect(page.locator(self.tab("tasks"))).to_have_attribute("aria-current", "page")
        page.get_by_role("button", name=re.compile(re.escape(self.fx.tasks[0]["title"]))).first.click()
        expect(page.get_by_role("complementary", name="Details")).to_be_visible()
        settled(page)
        entries = recorded(page)
        self.assertTrue(entries)
        for entry in entries:
            self.assertTrue(set(entry["props"]) <= TRANSFORM_ONLY, f"{entry['target']} animates {entry['props']}")
        endless = page.evaluate("document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations === Infinity && a.id === 'flux-motion').length")
        self.assertEqual(endless, 0, "no bounce loop or attention pulse was started")

    def test_19_nothing_animates_while_the_first_screen_is_put_up(self):
        page = self.page()
        page.goto(self.fx.task_url(self.fx.tasks[0]))
        expect(page.get_by_role("complementary", name="Details").locator(".wd")).to_be_visible()
        # The deep link's panel and its content are up: nothing was animated to put them there (the mark is when they were).
        shown = page.evaluate("performance.now()")
        before = [entry for entry in recorded(page) if entry["at"] <= shown and not KRESKA.search(entry["target"] + entry.get("name", ""))]
        self.assertEqual([(entry["target"], entry["props"]) for entry in before], [], "no motion while the first screen is put up")
        # Once the first screen has settled, the same panel closes and opens with motion again.
        page.wait_for_timeout(600)
        clear(page)
        page.locator("aside.ui-panel .ui-panel__body").focus()
        page.keyboard.press("Escape")
        self.assertTrue(self.by(page, r"ui-panel--docked", "script"), "motion is on after the first screen")
        anonymous = self.browser.new_context(base_url=ORIGIN, service_workers="block")
        self.addCleanup(anonymous.close)
        anonymous.add_init_script(RECORDER)
        sign_in = anonymous.new_page()
        sign_in.goto("/sign-in")
        expect(sign_in.get_by_role("button", name="Sign in")).to_be_visible()
        sign_in.wait_for_timeout(500)
        self.assertEqual([entry["name"] for entry in recorded(sign_in) if entry["kind"] == "css" and not KRESKA.search(entry["name"])], [], "the sign-in card does not rise on first load")

    def test_20_animations_stop_while_the_page_is_hidden_and_land_on_their_end_state(self):
        page = self.page()
        self.open(page, self.fx.project_url())
        clear(page)
        self.open_jump(page)
        stopped = page.evaluate("""() => {
          const surface = document.querySelector('.ui-overlay__surface');
          Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
          document.dispatchEvent(new Event('visibilitychange'));
          const running = document.getAnimations().filter((a) => a.id === 'flux-motion' && a.playState === 'running').length;
          const opacity = getComputedStyle(surface).opacity;
          delete document.visibilityState;
          document.dispatchEvent(new Event('visibilitychange'));
          return { running, opacity };
        }""")
        self.assertEqual(stopped["running"], 0, "our transient motion ended with the page hidden")
        self.assertEqual(stopped["opacity"], "1", "on its end state")
        # A menu's CSS entry and a press in flight, held mid-way, are settled and let go too (PR 608's review: `ui-pop-in` and `flux-press`
        # stayed running, the menu at opacity .237). All in one task, so no entry has finished by the time it is pinned.
        mid = self.page()
        self.open(mid, self.fx.task_url(self.fx.tasks[1]))
        expect(mid.get_by_role("complementary", name="Details").get_by_role("button", name="Status", exact=True)).to_be_visible()
        settled(mid)
        verdict = mid.evaluate("""async () => {
          document.querySelector('#details button[aria-label="Status"]').click();
          for (let i = 0; i < 100 && !document.querySelector('.wd-menu__list .wd-menu__item'); i++) await new Promise((resolve) => setTimeout(resolve, 5));
          const menu = document.querySelector('.wd-menu__list');
          // A pressed control: the pointer goes down on a small button (a menu's own items are rows and never scale) and is held.
          const item = document.querySelector('#details .ui-panel__close');
          item.dispatchEvent(new PointerEvent('pointerdown', { isPrimary: true, button: 0, pointerType: 'mouse', bubbles: true }));
          for (const animation of [...menu.getAnimations(), ...item.getAnimations()]) { animation.pause(); animation.currentTime = 10; }
          const state = () => ({ opacity: getComputedStyle(menu).opacity, pop: menu.getAnimations().map((a) => [a.animationName, a.playState]),
            press: item.getAnimations().filter((a) => a.id === 'flux-press').map((a) => a.playState), scale: getComputedStyle(item).scale });
          const held = state();
          Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
          document.dispatchEvent(new Event('visibilitychange'));
          const after = state();
          delete document.visibilityState;
          document.dispatchEvent(new Event('visibilitychange'));
          item.dispatchEvent(new PointerEvent('pointerup', { isPrimary: true, bubbles: true }));
          return { held, after };
        }""")
        held, after = verdict["held"], verdict["after"]
        self.assertTrue(any(name == "ui-pop-in" for name, _ in held["pop"]), f"a menu entry is in flight: {held}")
        self.assertTrue(held["press"], f"and a press is held: {held}")
        self.assertLess(float(held["opacity"]), 1, f"the menu is part-way, not at its end state: {held}")
        self.assertEqual(after["opacity"], "1", f"the menu is on its end state: {after}")
        # A finished entry (no fill after its end) is no longer listed: nothing may be left running or paused.
        self.assertTrue(all(state == "finished" for _, state in after["pop"]), after)
        self.assertEqual((after["press"], after["scale"]), ([], "none"), f"the press was let go: {after}")
        other = self.page()
        self.open(other, self.fx.project_url())
        clear(other)
        other.evaluate("Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })")
        other.keyboard.press("Control+k")
        expect(other.get_by_role("dialog", name="Search", exact=True)).to_be_visible()
        self.assertEqual([entry for entry in recorded(other) if entry["kind"] == "script"], [], "a hidden page starts no motion")

    def test_20b_a_view_fade_in_flight_lands_on_its_end_state_when_the_page_is_hidden(self):
        page = self.page()
        self.open(page, self.fx.project_url())
        expect(page.locator(".project-convo").first).to_be_visible()
        settled(page)
        verdict = page.evaluate("""async () => {
          document.querySelector("nav[aria-label='Space views'] a[href*='/tasks']").click();
          // Only animations on elements still in the page: earlier tests can leave unfinished glyph morphs on detached nodes.
          const running = () => (window.__animations || []).filter((a) => a.id === 'flux-motion' && a.playState === 'running' && a.effect?.target?.isConnected);
          for (let i = 0; i < 200 && !running().length; i++) await new Promise((resolve) => setTimeout(resolve, 5));
          const all = running();
          for (const animation of all) { animation.pause(); animation.currentTime = 10; }
          const held = all.map((a) => a.playState);
          Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
          document.dispatchEvent(new Event('visibilitychange'));
          const after = all.map((a) => a.playState);
          delete document.visibilityState;
          document.dispatchEvent(new Event('visibilitychange'));
          return { held, after };
        }""")
        self.assertTrue(verdict["held"] and all(state == "paused" for state in verdict["held"]), f"the new view's fade is in flight: {verdict}")
        self.assertTrue(all(state == "finished" for state in verdict["after"]), f"it landed on its end state: {verdict}")
        expect(page.locator(self.tab("tasks"))).to_have_attribute("aria-current", "page")

    # ------------------------------------------------------------------ AC-6: reduced motion gives the static end state at once
    def test_21_reduced_motion_runs_no_animation_and_every_surface_is_in_its_end_state_at_once(self):
        page = self.page(reduced=True)
        self.open(page, self.fx.project_url())
        clear(page)
        dialog = self.open_jump(page)
        end_state = "el => [getComputedStyle(el).opacity, getComputedStyle(el).transform, el.getAnimations().length]"
        self.assertEqual(page.locator(".ui-overlay__surface").evaluate(end_state), ["1", "none", 0])
        page.keyboard.press("Escape")
        expect(dialog).to_have_count(0)
        # A view, a panel, a menu and a press.
        page.locator(self.tab("tasks")).click()
        expect(page.locator(self.tab("tasks"))).to_have_attribute("aria-current", "page")
        self.assertEqual(page.locator("body > [data-dissolve]").count(), 0, "no picture of the old view: the view swaps at once")
        page.goto(self.fx.tasks_url())
        ready(page)
        page.locator(".ws-task .ws-item").first.click()
        panel = page.get_by_role("complementary", name="Details")
        expect(panel).to_be_visible()
        self.assertEqual(panel.evaluate(end_state), ["1", "none", 0])
        panel.get_by_role("button", name="Status", exact=True).click()
        menu = page.get_by_role("menu", name="Status")
        self.assertEqual(menu.evaluate(end_state), ["1", "none", 0])
        page.keyboard.press("Escape")
        expect(page.locator(".wd-menu__list")).to_have_count(0)
        pressed, _ = self.press_scale(page, page.get_by_role("button", name="Collapse sidebar").first, 120)
        self.assertEqual(pressed, "none", "a press does not scale under reduced motion")
        # The panel's content is replaced at once: no picture of the old content is kept, nothing slides.
        page.locator("#details a", has_text="Should the first sensors").first.click()
        expect(page.locator("#details .thread")).to_be_visible()
        self.assertEqual(page.locator("body > [data-dissolve]").count(), 0, "no picture of the old content")
        self.assertEqual(page.evaluate("document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity && a.playState === 'running').length"), 0)
        self.assertEqual([entry for entry in recorded(page) if entry["kind"] == "script"], [], "no script motion")
        self.assertEqual([entry for entry in recorded(page) if entry["kind"] == "css" and entry["duration"] > 0], [], "no CSS motion")

    def test_22_the_persons_own_reduce_motion_choice_gives_the_same_static_frame(self):
        page = self.page()
        self.open(page, self.fx.project_url())
        page.evaluate("localStorage.setItem('flux.reduceMotion', 'on')")
        page.reload()
        ready(page)
        self.assertEqual(page.evaluate("document.documentElement.dataset.motion"), "reduce")
        clear(page)
        self.open_jump(page)
        self.assertEqual(page.locator(".ui-overlay__surface").evaluate("el => el.getAnimations().length"), 0)
        self.assertEqual([entry for entry in recorded(page) if entry["kind"] == "script"], [])

    # ------------------------------------------------------------------ phone
    def test_23_on_the_phone_the_sheet_follows_the_same_rules(self):
        page = self.page(phone=True)
        self.open(page, self.fx.tasks_url())
        settled(page)
        clear(page)
        page.locator(".ws-task .ws-item").first.tap()
        expect(page.get_by_role("dialog", name="Details")).to_be_visible()
        settled(page)
        entries = self.by(page, r"ui-overlay__surface|ui-scrim", "script")
        self.assertTrue(entries, "the sheet and its scrim animate")
        for entry in entries:
            self.assertTrue(set(entry["props"]) <= {"opacity", "transform"}, entry["props"])
            self.assertLessEqual(entry["duration"], 180, "the phone sheet enters within the dialog budget")
        clear(page)
        page.get_by_role("dialog", name="Details").get_by_role("button", name="Close details").tap()
        left = self.by(page, r"ui-overlay__surface|ui-scrim", "script")
        self.assertTrue(left and all(entry["duration"] <= 140 for entry in left), f"and leaves within 140 ms: {left}")
        expect(page.get_by_role("dialog", name="Details")).to_have_count(0)
        calm = self.page(phone=True, reduced=True)
        self.open(calm, self.fx.tasks_url())
        calm.locator(".ws-task .ws-item").first.tap()
        expect(calm.get_by_role("dialog", name="Details")).to_be_visible()
        self.assertEqual([entry for entry in recorded(calm) if entry["kind"] == "script"], [])

    SHEET_EDGES = """async (ms) => {
      const sheet = document.querySelector('[data-detent-sheet]');
      const frames = [];
      const start = performance.now();
      document.querySelector('.ui-grabber').click();
      await new Promise((resolve) => { const step = () => {
        const t = performance.now() - start; const box = sheet.getBoundingClientRect();
        frames.push({ t, top: box.top, bottom: box.bottom, height: sheet.dataset.height, transform: getComputedStyle(sheet).transform, screen: window.innerHeight });
        t < ms ? requestAnimationFrame(step) : resolve(); }; requestAnimationFrame(step); });
      return frames;
    }"""

    def test_23b_the_two_height_sheet_keeps_its_bottom_on_the_screen_edge_while_it_travels_in_both_directions(self):
        """Going from full to half the sheet used to take the half height at once and travel down from the old top, so for 150 ms its bottom floated
        above the screen's edge with the page showing beneath (#863 rule 8, review of #891). Both ways the bottom edge must stay at or below the edge."""
        page = self.page(phone=True)
        self.open(page, self.fx.tasks_url())
        settled(page)
        page.locator(".ws-task .ws-item").first.tap()
        sheet = page.locator("[data-detent-sheet]")
        expect(sheet).to_be_visible()
        expect(sheet).to_have_attribute("data-height", "half")
        settled(page)
        for label, expected in (("up to full", "full"), ("down to half", "half")):
            with self.subTest(travel=label):
                frames = page.evaluate(self.SHEET_EDGES, 450)
                screen = frames[0]["screen"]
                for frame in frames:
                    self.assertGreaterEqual(frame["bottom"], screen - 1, f"{label}: the sheet's bottom edge stays on the screen's edge: {frame}")
                tops = [frame["top"] for frame in frames]
                self.assertTrue(all(b - a >= -1 for a, b in zip(tops, tops[1:])) if expected == "half" else all(a - b >= -1 for a, b in zip(tops, tops[1:])), f"{label}: one steady travel of the top edge: {tops}")
                self.assertGreater(abs(tops[-1] - tops[0]), 100, f"{label}: the top edge really travelled")
                expect(sheet).to_have_attribute("data-height", expected)
                self.assertIn(frames[-1]["transform"], ("none", "matrix(1, 0, 0, 1, 0, 0)"), f"{label}: nothing is left on the sheet when it has arrived")

    def test_23c_the_drawer_and_the_phone_sheet_fade_as_well_as_travel(self):
        page = self.page(phone=True)
        self.open(page, self.fx.tasks_url())
        settled(page)
        clear(page)
        page.locator(".ws-task .ws-item").first.tap()
        expect(page.get_by_role("dialog", name="Details")).to_be_visible()
        entered = [entry for entry in self.by(page, r"ui-overlay__surface", "script") if (entry["to"] or {}).get("opacity") == 1]
        self.assertTrue(entered, f"the sheet's surface enters: {recorded(page)}")
        self.assertEqual(entered[0]["from"].get("opacity"), 0, "from transparent, with its travel from the screen's edge")
        self.assertIn("translateY", entered[0]["from"].get("transform", ""))
        self.assertEqual(set(entered[0]["props"]), {"opacity", "transform"})

    # The first section of Home, then Details (in the date line, only with an encrypted space; see test_encrypted_workspaces) when it is there.
    SHIFT = """() => {
      const top = (selector) => { const el = document.querySelector(selector); return el ? el.getBoundingClientRect().top : null; };
      const first = top('.home__need, .home__first');
      return first === null ? null : [first, top('.home__top'), top('.home__details')];
    }"""

    def home_tops(self, context, wait_for_card: bool) -> tuple[float, float, int]:
        """How far the first section of Home and its date line (Details sits there) move while the two reads that decide the Continue row
        are held and after they answer: the first section's top before, its top after and the slot kept for the card.

        The reads are held in a list and let go by the test, never delayed with a sleep: a sleep inside a sync route handler blocks Playwright's
        dispatcher, so what the test reads lands after the reads have answered (it failed 2 runs in 8 that way)."""
        page = context.new_page()
        self.addCleanup(page.close)
        held: list = []
        gate = {"held": True}

        def hold(route):
            if gate["held"]:
                held.append(route)
            else:
                route.continue_()
        page.route(re.compile(r"/api/v1/(return\?|workspaces/[^/]+/work/assigned)"), hold)
        page.goto("/")
        page.wait_for_function(f"() => ({self.SHIFT})() !== null", timeout=10000)
        # Frames with both reads outstanding: the slot is on screen from the first of them, or it is never kept.
        page.wait_for_timeout(300)
        self.assertTrue(held, "the reads that decide the card are being waited for")
        before = page.evaluate(self.SHIFT)
        slot = page.locator(".home__continue-slot").count()
        gate["held"] = False
        while held:
            held.pop().continue_()
        if wait_for_card:
            expect(page.locator(".home__continue")).to_be_visible()
        page.wait_for_timeout(1200)
        after = page.evaluate(self.SHIFT)
        # The date line (and Details in it) is above everything that arrives, so it never moves; the section's own top is returned for the caller.
        self.assertIsNotNone(before[1], "the date line is there")
        self.assertLess(abs(before[1] - after[1]), 1.5, f"the date line did not move: {before[1]} to {after[1]}")
        self.assertEqual(before[2] is None, after[2] is None, "Details neither arrives nor leaves")
        if before[2] is not None:
            self.assertLess(abs(before[2] - after[2]), 1.5, f"Details did not move: {before[2]} to {after[2]}")
        return before[0], after[0], slot

    def test_25_home_keeps_no_space_for_continue_and_nothing_above_it_moves_when_it_arrives(self):
        """Phone Home: Continue is the last section, so nothing above it jumps when it arrives and no gap is kept for it (#863 rule 6, #865)."""
        ada = self.fx.context(phone=True)
        self.addCleanup(ada.close)
        first = ada.new_page()
        first.goto("/")
        expect(first.locator(".home__continue")).to_be_visible()
        first.wait_for_timeout(400)
        first.close()
        # The next time Home opens there is a card, but no space is kept for it while it is read, and the section above does not move.
        before, after, slot = self.home_tops(ada, wait_for_card=True)
        self.assertEqual(slot, 0, "no space is kept while the card is read")
        self.assertLess(abs(before - after), 1.5, f"the section above Continue did not move: {before} to {after}")
        # Someone with nothing to continue from has nothing to close up.
        fresh = self.fx.browser.new_context(base_url=ORIGIN, service_workers="block", viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
        self.addCleanup(fresh.close)
        api(fresh, "POST", "/api/auth/sign-up/email", {"name": "Mara Nowak", "email": f"motion-mara-{self.fx.stamp}-{uuid.uuid4().hex[:8]}@example.test", "password": "light motion for a calm shared studio"})
        for visit in range(2):
            before, after, slot = self.home_tops(fresh, wait_for_card=False)
            self.assertEqual(slot, 0, f"visit {visit + 1}: no space is kept for a card that is not there")
            self.assertLess(abs(before - after), 1.5, f"visit {visit + 1}: nothing moved: {before} to {after}")


if __name__ == "__main__":
    unittest.main()
