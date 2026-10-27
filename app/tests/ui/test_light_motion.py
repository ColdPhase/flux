"""Light motion across the interface (#593; final design guide §2; Spokój rule 7).

Dialogs and their scrim, the detail panel and what it shows, project views and places, menus, toasts, state changes, rows
that come and go, and the press of every pressable control: what they animate, for how long and how, that nothing but
opacity and transform moves (a row's height only grows or collapses it), that reduced motion gives the static end state,
that exit motion never delays focus and that closing while opening settles on the latest state.

A recorder (light_motion_fixture.RECORDER) logs every animation the page starts, so durations and easing are read from what the
application asked the browser to run rather than guessed from frames. Boxes are sampled frame by frame while an action
runs, for the rule that a control never changes place. Chromium by default; FLUX_UI_BROWSER=webkit runs the same journeys
in WebKit. (`test_motion.py` is #155's module: the traveling highlight, arrivals and typing presence.)
"""
from __future__ import annotations

import re
import unittest

from playwright.sync_api import Page, expect, sync_playwright

from create_window import add_task
from light_motion_fixture import RECORDER, ROW_BOX, TRANSFORM_ONLY, LightMotion, clear, moved, numbers, ready, recorded, sample_while, settled
from test_app_shell import ORIGIN, UI_BROWSER, UPSTREAM, start_forwarder
from test_work_pagination import api

EASE_OUT = [0.22, 1, 0.36, 1]
EASE_IN = [0.4, 0, 1, 1]
EASE_SPRING = [0.34, 1.4, 0.64, 1]
# What must not move while the content area or the panel's content changes (Spokój rule 7).
CHROME = {"header": "header.top", "sidebar": ".app__side", "views": "nav[aria-label='Project views']"}
PROJECT_TABS = "nav[aria-label='Project views']"
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
        dialog = page.get_by_role("dialog", name="Jump to")
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
        names = ("--dur-in", "--dur-out", "--dur-view", "--dur-press")
        page = self.page()
        self.open(page, self.fx.project_url())
        values = {name: self.token_ms(page, name) for name in names}
        self.assertEqual((values["--dur-in"], values["--dur-out"], values["--dur-press"]), (180, 120, 250))
        self.assertLessEqual(values["--dur-view"], 160)
        self.assertEqual(page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--press').trim()"), ".97")
        # The system setting and Settings → Appearance → Reduce motion give the same zeroes.
        calm = self.page(reduced=True)
        self.open(calm, self.fx.project_url())
        self.assertEqual({name: self.token_ms(calm, name) for name in names}, {name: 0 for name in names})
        chosen = self.page()
        self.open(chosen, "/settings/appearance")
        chosen.get_by_role("switch", name="Reduce motion").click()
        self.assertEqual(chosen.evaluate("document.documentElement.dataset.motion"), "reduce")
        self.assertEqual({name: self.token_ms(chosen, name) for name in names}, {name: 0 for name in names})

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
        clear(page)
        page.keyboard.press("Escape")
        surface = self.by(page, r"ui-overlay__surface", "script")
        scrim = self.by(page, r"ui-scrim", "script")
        self.assertLessEqual(surface[0]["duration"], 140)
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
          const dialog = document.querySelector('[role="dialog"][aria-label="Jump to"]');
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
        expect(page.get_by_role("dialog", name="Jump to")).to_have_count(0)

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
                    else document.querySelector('[role="dialog"][aria-label="Jump to"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
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
                    expect(page.get_by_role("dialog", name="Jump to")).to_have_count(0)
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
    def test_10_a_thread_replaces_a_task_in_the_direction_of_travel_and_back_reverses_it(self):
        page = self.page()
        self.open(page, self.fx.task_url(self.fx.tasks[0]))
        panel = page.locator("#details")
        expect(panel.locator(".wd")).to_be_visible()
        settled(page)
        boxes = {"panel": "aside.ui-panel", "head": ".ui-panel__head", "close": ".ui-panel__close"}
        clear(page)
        forward = sample_while(page, "() => { [...document.querySelectorAll('#details a')].find((a) => a.textContent.includes('Should the first sensors'))?.click(); }", boxes, 600)
        expect(panel.locator(".thread")).to_be_visible()
        content = [entry for entry in recorded(page) if entry["duration"] == 180 and "translateX" in str((entry["from"] or {}).get("transform", ""))]
        self.assertTrue(content, f"the content animates in: {recorded(page)}")
        self.assertEqual({tuple(sorted(entry["props"])) for entry in content}, {("opacity", "transform")})
        self.assertGreater(numbers(content[0]["from"]["transform"])[0], 0, "forward: it comes from the right")
        # The route-progress line lies over the work while the other view loads and takes no room: the whole panel, its head and its
        # controls stay exactly where they were, in x, y and size (Spokój rule 7).
        for key in boxes:
            self.assertEqual(moved(forward, key), [], f"the panel's {key} never moves while its content is replaced (Spokój rule 7)")
        # The old content dissolves over the new, towards where the person came from; the new content is never blank.
        left = [entry for entry in recorded(page) if entry["duration"] == 120 and (entry["from"] or {}).get("opacity") == 1 and (entry["to"] or {}).get("opacity") == 0]
        self.assertTrue(left, f"the old content leaves: {recorded(page)}")
        self.assertLess(numbers(left[0]["to"]["transform"])[0], 0, "forward: the old content goes left as the new comes from the right")
        # "‹ back" returns to the task from the other side.
        settled(page)
        clear(page)
        back = sample_while(page, "() => { document.querySelector('#details .ui-panel__back')?.click(); }", boxes, 600)
        expect(panel.locator(".wd")).to_be_visible()
        again = [entry for entry in recorded(page) if entry["duration"] == 180 and "translateX" in str((entry["from"] or {}).get("transform", ""))]
        self.assertTrue(again, "the task slides back in")
        self.assertLess(numbers(again[0]["from"]["transform"])[0], 0, "back: it comes from the left")
        for key in boxes:
            self.assertEqual(moved(back, key), [], f"the panel's {key} never moves on Back")
        left = [entry for entry in recorded(page) if entry["duration"] == 120 and (entry["from"] or {}).get("opacity") == 1 and (entry["to"] or {}).get("opacity") == 0]
        self.assertTrue(left)
        self.assertGreater(numbers(left[0]["to"]["transform"])[0], 0, "back: the old content goes right as the task comes from the left")

    def test_10b_the_old_content_stays_as_an_inert_picture_while_the_new_content_comes_in(self):
        """A real old-to-new crossfade (PR 608's review): the outgoing content is retained, not replaced by a fade-in from zero."""
        page = self.page()
        self.open(page, self.fx.task_url(self.fx.tasks[0]))
        panel = page.locator("#details")
        expect(panel.locator(".wd")).to_be_visible()
        settled(page)
        probe = """async (action) => {
          const body = document.querySelector('#details .ui-panel__body');
          const old = body.querySelector(':scope > *'); const oldBox = old.getBoundingClientRect();
          const point = { x: oldBox.left + oldBox.width / 2, y: oldBox.top + Math.min(60, oldBox.height / 2) };
          // The task's link leads to the conversation: the page under the panel dissolves too (its picture is named by a path).
          const layers = () => [...document.body.children].filter((el) => el.hasAttribute('data-dissolve') && !el.getAttribute('data-dissolve').startsWith('/'));
          const reach = () => {
            const hit = document.elementFromPoint(point.x, point.y);
            const back = document.querySelector('#details .ui-panel__back');
            const backBox = back ? back.getBoundingClientRect() : null;
            const backHit = backBox ? document.elementFromPoint(backBox.left + backBox.width / 2, backBox.top + backBox.height / 2) : null;
            return { hit: hit ? hit.tagName + '.' + hit.className : null, hitIsPicture: !!hit && hit.hasAttribute('data-dissolve'),
              backReachable: back ? (backHit === back || back.contains(backHit)) : null,
              scoped: document.querySelectorAll('#details .wd, #details .thread').length, everywhere: document.querySelectorAll('.wd, .thread').length,
              inside: !!body.querySelector('[data-dissolve]') };
          };
          const capture = () => {
            const copies = layers(); const layer = copies[0];
            return { copies: copies.length, fresh: [...body.children].map((child) => child.className),
              layer: layer ? { inert: layer.inert, hidden: layer.getAttribute('aria-hidden'), events: getComputedStyle(layer).pointerEvents, of: layer.getAttribute('data-dissolve'),
                position: getComputedStyle(layer).position, z: getComputedStyle(layer).zIndex } : null };
          };
          const seen = new Promise((resolve) => {
            const watch = new MutationObserver(() => {
              if (!layers().length) return;
              watch.disconnect();
              // In the task that committed the swap: the picture of the old content and the new content are in the page together.
              const committed = capture();
              requestAnimationFrame(() => requestAnimationFrame(() => resolve({ ...committed, ...reach() })));
            });
            watch.observe(document.body, { childList: true });
            setTimeout(() => { watch.disconnect(); resolve(null); }, 4000);
          });
          if (action === 'forward') [...document.querySelectorAll('#details a')].find((a) => a.textContent.includes('Should the first sensors'))?.click();
          else document.querySelector('#details .ui-panel__back')?.click();
          return seen;
        }"""
        forward = page.evaluate(probe, "forward")
        self.assertIsNotNone(forward, "the panel's content was replaced")
        self.assertEqual(forward["copies"], 1, f"the task's content is still on screen on the frame the thread's is put up: {forward}")
        self.assertTrue(forward["fresh"], f"and the thread's is in the panel: {forward}")
        layer = forward["layer"]
        self.assertIn(self.fx.tasks[0]["id"], layer["of"], f"the picture is of the task: {forward}")
        self.assertEqual((layer["inert"], layer["hidden"], layer["events"], layer["position"]), (True, "true", "none", "fixed"),
                         f"inert, hidden from assistive technology, no pointer input, a layer of its own: {forward}")
        self.assertFalse(forward["inside"], "the picture is not in the panel")
        self.assertEqual((forward["scoped"], forward["everywhere"]), (1, 1), f"a query of the page finds the one live content, never two (the picture is only a picture): {forward}")
        self.assertFalse(forward["hitIsPicture"], "the person's pointer reaches the new content, not the picture")
        self.assertTrue(forward["backReachable"], f"the panel's own controls are reachable: {forward}")
        # It starts to fade on the first frame the browser draws after the swap, and goes the way the person came from.
        wait_fade = "() => (window.__motion || []).some((entry) => entry.kind === 'script' && entry.duration === 120 && entry.from && entry.from.opacity === 1 && entry.to && entry.to.opacity === 0)"
        page.wait_for_function(wait_fade)
        left = self.leaving(page, 120)
        self.assertTrue(left, "the old content is animated out")
        self.assertLess(numbers(left[0]["to"]["transform"])[0], 0, "forward: it goes left as the new content comes from the right")
        expect(panel.locator(".thread")).to_be_visible()
        expect(page.locator(self.PICTURE)).to_have_count(0)
        settled(page)
        clear(page)
        back = page.evaluate(probe, "back")
        self.assertIsNotNone(back, "the panel's content was replaced on Back")
        self.assertEqual(back["copies"], 1, f"going back keeps the thread's content on screen as a picture too: {back}")
        self.assertNotEqual(back["layer"]["of"], layer["of"], "the picture is of the thread now")
        # The task's own content may still be on its way (it is loaded); whichever is there, the page finds it once.
        self.assertLessEqual(back["scoped"], 1, back)
        self.assertEqual(back["everywhere"], back["scoped"], f"a query of the page finds the live content only, never the picture: {back}")
        self.assertFalse(back["hitIsPicture"])
        page.wait_for_function(wait_fade)
        left = self.leaving(page, 120)
        self.assertTrue(left)
        self.assertGreater(numbers(left[0]["to"]["transform"])[0], 0, "back: it goes right as the task comes from the left")
        expect(panel.locator(".wd")).to_be_visible()
        expect(page.locator(self.PICTURE)).to_have_count(0)

    # The picture of the old content: a layer of its own at the end of `body`, the page's own queries never see inside it.
    PICTURE = "body > [data-dissolve]"
    # A probe that clicks and looks at the page in the task that commits the switch (the picture and the new content are there together),
    # and again a few frames later.
    SWITCH = """async ({ click, count, controls }) => {
      const layers = () => [...document.body.children].filter((el) => el.hasAttribute('data-dissolve'));
      const reach = (selector) => { const el = document.querySelector(selector); if (!el) return null; const at = el.getBoundingClientRect();
        const hit = document.elementFromPoint(at.left + at.width / 2, at.top + at.height / 2);
        return { ok: !!hit && (hit === el || el.contains(hit) || hit.contains(el)), hit: hit ? hit.tagName + '.' + hit.className : null }; };
      const seen = new Promise((resolve) => {
        const watch = new MutationObserver(() => {
          if (!layers().length) return;
          watch.disconnect();
          const layer = layers()[0];
          const committed = { layers: layers().length, inert: layer.inert, hidden: layer.getAttribute('aria-hidden'), events: getComputedStyle(layer).pointerEvents,
            queries: count.map((selector) => document.querySelectorAll(selector).length), of: layer.getAttribute('data-dissolve') };
          requestAnimationFrame(() => requestAnimationFrame(() => resolve({ ...committed, reach: Object.fromEntries(controls.map((selector) => [selector, reach(selector)])) })));
        });
        watch.observe(document.body, { childList: true });
        setTimeout(() => { watch.disconnect(); resolve(null); }, 4000);
      });
      document.querySelector(click).click();
      return seen;
    }"""

    def leaving(self, page: Page, duration: int = 150) -> list[dict]:
        """What the page asked the browser to run to fade the old content out: opacity from 1 to 0 with a little travel."""
        return [entry for entry in recorded(page) if entry["kind"] == "script" and entry["duration"] == duration and (entry["from"] or {}).get("opacity") == 1 and (entry["to"] or {}).get("opacity") == 0]

    def test_11_a_view_switch_dissolves_the_content_and_nothing_else_moves(self):
        page = self.page()
        self.open(page, self.fx.project_url())
        settled(page)
        clear(page)
        boxes = {**CHROME, "composer": ".composer__box"}
        frames = sample_while(page, f"() => {{ document.querySelector(\"{self.tab('tasks')}\").click(); }}", boxes, 900)
        expect(page.locator(self.tab("tasks"))).to_have_attribute("aria-current", "page")
        left = self.leaving(page)
        self.assertTrue(left, f"the old content fades out: {recorded(page)}")
        self.assertLessEqual(left[0]["duration"], 160)
        self.assertEqual(set(left[0]["props"]), {"opacity", "transform"}, "it fades and travels")
        self.assertLess(numbers(left[0]["to"]["transform"])[0], 0, "Conversation to Tasks is forward: the old content goes left")
        self.assert_ease(left[0], EASE_IN, "view")
        for key in (*CHROME, "composer"):
            self.assertEqual(moved(frames, key), [], f"the {key} stays still during the switch")
        expect(page.locator(self.PICTURE)).to_have_count(0)
        # Back to the conversation reverses the travel, and its composer arrives in its own place and never travels.
        settled(page)
        clear(page)
        back = sample_while(page, f"() => {{ document.querySelector(\"{PROJECT_TABS} a:first-of-type\").click(); }}", boxes, 900)
        expect(page.locator(".composer__box").first).to_be_visible()
        left = self.leaving(page)
        self.assertTrue(left)
        self.assertGreater(numbers(left[0]["to"]["transform"])[0], 0, "Tasks to Conversation is back: the travel is reversed")
        seen = [frame["boxes"]["composer"] for frame in back if frame["boxes"]["composer"]]
        self.assertTrue(seen)
        self.assertTrue(all(close(box, seen[-1], 0.5) for box in seen), f"the composer never moves: {seen[:3]}")
        for key in CHROME:
            self.assertEqual(moved(back, key), [], f"the {key} stays still on the way back")
        # A thread opening beside the conversation is not a view switch, and a first load animates nothing.
        page.goto(self.fx.thread_url())
        ready(page)
        self.assertEqual(self.by(page, r"app__pane"), [], "first load animates nothing")
        self.assertEqual(page.locator(self.PICTURE).count(), 0)

    def test_11b_the_old_view_is_retained_as_a_picture_and_the_page_answers_while_it_fades(self):
        """The picture is only a picture: queries of the page find the new view alone, a pointer reaches the live page, and nothing is blank."""
        page = self.page()
        self.open(page, self.fx.project_url())
        expect(page.locator(".project-convo").first).to_be_visible()
        settled(page)
        verdict = page.evaluate(self.SWITCH, {"click": f"nav[aria-label='Project views'] a[href*='/tasks']", "count": [".project-convo", ".composer"],
                                              "controls": ["nav[aria-label='Project views'] a[href*='/map']", ".app__side a, .app__side button", "header.top button, header.top a"]})
        self.assertIsNotNone(verdict, "the view was switched")
        self.assertEqual(verdict["layers"], 1, f"the old view is still on screen as a picture on the frame the new one is put up: {verdict}")
        self.assertEqual((verdict["inert"], verdict["hidden"], verdict["events"]), (True, "true", "none"), f"inert, hidden from assistive technology, no pointer input: {verdict}")
        self.assertTrue(verdict["of"], "it names the view it is a picture of")
        self.assertEqual(verdict["queries"], [0, 0], f"queries of the page find the new view alone, never a second copy of the old: {verdict}")
        for selector, seen in verdict["reach"].items():
            self.assertTrue(seen and seen["ok"], f"{selector} is reached by a pointer while the old view fades: {verdict}")
        expect(page.locator(self.PICTURE)).to_have_count(0)

    def test_11c_a_modal_panel_stays_reachable_while_the_page_beneath_dissolves(self):
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
          const during = []; let seen = false;
          // Until the page beneath has switched (a view loads) and its picture has gone.
          for (let frame = 0; frame < 300 && !(seen && !during[during.length - 1].picture); frame++) {
            await new Promise((resolve) => requestAnimationFrame(resolve));
            const close = document.querySelector('#details .ui-panel__close'); const at = close.getBoundingClientRect();
            const hit = document.elementFromPoint(at.left + at.width / 2, at.top + at.height / 2);
            const picture = [...document.body.children].some((el) => el.hasAttribute('data-dissolve') && el.getAttribute('data-dissolve').startsWith('/'));
            seen = seen || picture;
            during.push({ picture, ok: !!hit && (hit === close || close.contains(hit)), hit: describe(hit) });
          }
          return during;
        }""")
        self.assertTrue(any(entry["picture"] for entry in verdict), f"the page beneath did dissolve: {verdict}")
        self.assertTrue(all(entry["ok"] for entry in verdict), f"the panel's close control is reachable on every frame: {verdict}")

    def test_12_a_place_switch_dissolves_too_and_the_reading_position_is_not_animated(self):
        page = self.page()
        self.open(page, self.fx.project_url())
        settled(page)
        clear(page)
        page.get_by_role("navigation", name="Places").get_by_role("link", name="Inbox").click()
        expect(page.get_by_role("heading", level=1, name="Inbox")).to_be_visible()
        # The old view's fade starts on the first frame drawn after the swap.
        page.wait_for_function("() => (window.__motion || []).some((entry) => entry.kind === 'script' && entry.duration === 150 && entry.from && entry.from.opacity === 1 && entry.to && entry.to.opacity === 0)")
        left = self.leaving(page)
        self.assertTrue(left and set(left[0]["props"]) == {"opacity", "transform"} and left[0]["duration"] <= 160, recorded(page))
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
                self.assertTrue(set(entry["props"]) <= TRANSFORM_ONLY | ROW_BOX, f"{entry['target']} animates {entry['props']}")

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

    def test_14_an_added_row_grows_in(self):
        page = self.page()
        self.open(page, self.fx.tasks_url())
        settled(page)
        clear(page)
        add_task(page, "Replace the cracked sensor housing")
        grown = [entry for entry in recorded(page) if "ws-task" in entry["target"] and "height" in entry["props"]]
        self.assertTrue(grown, f"the new row grows: {recorded(page)}")
        self.assertLessEqual(grown[0]["duration"], 180)
        self.assertIn("opacity", grown[0]["props"])
        self.assertTrue(set(grown[0]["props"]) <= {"opacity"} | ROW_BOX)

    def test_15_an_accepted_decision_collapses_where_it_stood_and_the_card_below_stays_reachable(self):
        page = self.page()
        self.open(page, "/inbox")
        card = page.locator(".nyc", has_text="Measure soil moisture first")
        expect(card).to_be_visible()
        other = page.locator(".nyc", has_text="Label every bed")
        expect(other).to_be_visible()
        settled(page)
        clear(page)
        card.get_by_role("button", name=re.compile("^Accept")).click()
        expect(page.locator(".nyc", has_text="Measure soil moisture first")).to_have_count(0)
        collapsed = [entry for entry in recorded(page) if "nyc" in entry["target"] and "height" in entry["props"]]
        self.assertTrue(collapsed, f"the card collapses: {recorded(page)}")
        self.assertLessEqual(collapsed[0]["duration"], 140)
        self.assertEqual(page.locator(".nyc[data-row-ghost]").count(), 0, "the outgoing copy is gone once it has collapsed")
        expect(other.get_by_role("button", name=re.compile("^Accept"))).to_be_enabled()

    def test_15b_rows_that_leave_in_quick_succession_collapse_cleanly(self):
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
        self.assertEqual(page.locator("[data-row-ghost]").count(), 0, "every collapsing copy is gone")
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
    def test_16_every_kind_of_pressable_control_takes_the_same_press(self):
        page = self.page()
        self.open(page, self.fx.tasks_url())
        settled(page)
        targets = {
            "icon button": page.get_by_role("button", name="Collapse sidebar").first,
            "button": page.get_by_role("button", name=re.compile("^(New )?Task$")).first,
            "row that opens something": page.locator(".ws-task .ws-item").first,
            "state glyph button": page.locator("button.ws-task__glyph").first,
            "sidebar row": page.locator(".side__project").first,
        }
        for name, target in targets.items():
            with self.subTest(control=name):
                expect(target).to_be_visible()
                pressed, released = self.press_scale(page, target)
                self.assertEqual(numbers(pressed), [0.97], f"{name}: pressed scale {pressed!r}")
                self.assertIn(released, ("none", "1"), f"{name}: springs back, {released!r}")
        released = [entry for entry in recorded(page) if entry["props"] == ["scale"] and entry["duration"] == 250]
        self.assertTrue(released, "the release takes --dur-press")
        self.assert_ease(released[0], EASE_SPRING, "release")
        # A disabled send does not press; once it can send it does.
        page.goto(self.fx.project_url())
        ready(page)
        send = page.locator(".composer__send").first
        pressed, _ = self.press_scale(page, send, 120)
        self.assertEqual(pressed, "none", "a send button that cannot send does not press")
        page.locator("#project-composer").fill("Probes arrive on Thursday")
        pressed, _ = self.press_scale(page, send)
        self.assertEqual(numbers(pressed), [0.97], pressed)

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
        expect(page.get_by_role("dialog", name="Jump to")).to_have_count(0)
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
          const menu = document.querySelector('.wd-menu__list'); const item = document.querySelector('.wd-menu__item');
          // A pressed control: the pointer goes down on the item and is held.
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
        expect(other.get_by_role("dialog", name="Jump to")).to_be_visible()
        self.assertEqual([entry for entry in recorded(other) if entry["kind"] == "script"], [], "a hidden page starts no motion")

    def test_20b_a_view_dissolve_in_flight_lands_on_its_end_state_when_the_page_is_hidden(self):
        page = self.page()
        self.open(page, self.fx.project_url())
        expect(page.locator(".project-convo").first).to_be_visible()
        settled(page)
        verdict = page.evaluate("""async () => {
          const layers = () => [...document.body.children].filter((el) => el.hasAttribute('data-dissolve'));
          document.querySelector("nav[aria-label='Project views'] a[href*='/tasks']").click();
          for (let i = 0; i < 400 && !layers().length; i++) await new Promise((resolve) => setTimeout(resolve, 5));
          // The pictures are in a shadow root, which not every engine lists in document.getAnimations(): the recorder kept every animation.
          // The fade starts on the first frame drawn after the swap.
          const running = () => (window.__animations || []).filter((a) => a.id === 'flux-motion' && a.playState === 'running');
          for (let i = 0; i < 200 && !running().length; i++) await new Promise((resolve) => setTimeout(resolve, 5));
          const all = running();
          for (const animation of all) { animation.pause(); animation.currentTime = 10; }
          const held = all.map((a) => a.playState);
          Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
          document.dispatchEvent(new Event('visibilitychange'));
          const after = all.map((a) => a.playState);
          await new Promise((resolve) => setTimeout(resolve, 0));
          const left = layers().length;
          delete document.visibilityState;
          document.dispatchEvent(new Event('visibilitychange'));
          return { held, after, left };
        }""")
        self.assertTrue(verdict["held"] and all(state == "paused" for state in verdict["held"]), f"the old view's fade is in flight: {verdict}")
        self.assertTrue(all(state == "finished" for state in verdict["after"]), f"it landed on its end state: {verdict}")
        self.assertEqual(verdict["left"], 0, f"and the picture is gone: {verdict}")
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
        self.assertEqual(page.locator(self.PICTURE).count(), 0, "no picture of the old view: the view swaps at once")
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


if __name__ == "__main__":
    unittest.main()
