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
from light_motion_fixture import RECORDER, ROW_BOX, TRANSFORM_ONLY, LightMotion, clear, moved, numbers, ready, recorded, relative, sample_while, settled
from test_app_shell import ORIGIN, UI_BROWSER, UPSTREAM, start_forwarder

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

    def open_jump(self, page: Page):
        page.keyboard.press("Control+k")
        dialog = page.get_by_role("dialog", name="Jump to")
        expect(dialog).to_be_visible()
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
        verdict = page.evaluate("""async () => {
          const opener = document.querySelector('.side__search');
          const dialog = document.querySelector('[role="dialog"][aria-label="Jump to"]');
          const inside = dialog.contains(document.activeElement);
          dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          // The update React made for the key is committed in the microtask after it: before any timer or frame, never after the exit.
          await Promise.resolve(); await Promise.resolve();
          const surface = document.querySelector('.ui-overlay__surface');
          return { inside, returned: document.activeElement === opener, there: !!surface, inert: surface ? surface.inert : null,
            running: surface ? surface.getAnimations().length : 0, appInert: document.getElementById('root').inert };
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
        # The panel as a whole may be pushed by the route-progress line while the other view loads; its head and controls never move within it.
        for key in ("head", "close"):
            self.assertEqual(moved(relative(forward, key, "panel"), key), [], f"the panel's {key} never moves while its content is replaced (Spokój rule 7)")
        self.assertEqual([box for _, box in moved(forward, "panel") if abs(box[0] - forward[0]["boxes"]["panel"][0]) > 0.5 or abs(box[2] - forward[0]["boxes"]["panel"][2]) > 0.5], [], "the panel shell does not slide or resize")
        # "‹ back" returns to the task from the other side.
        settled(page)
        clear(page)
        back = sample_while(page, "() => { document.querySelector('#details .ui-panel__back')?.click(); }", boxes, 600)
        expect(panel.locator(".wd")).to_be_visible()
        again = [entry for entry in recorded(page) if entry["duration"] == 180 and "translateX" in str((entry["from"] or {}).get("transform", ""))]
        self.assertTrue(again, "the task slides back in")
        self.assertLess(numbers(again[0]["from"]["transform"])[0], 0, "back: it comes from the left")
        for key in ("head", "close"):
            self.assertEqual(moved(relative(back, key, "panel"), key), [], f"the panel's {key} never moves on Back")
        self.assertEqual([box for _, box in moved(back, "panel") if abs(box[0] - back[0]["boxes"]["panel"][0]) > 0.5 or abs(box[2] - back[0]["boxes"]["panel"][2]) > 0.5], [], "the panel shell does not slide or resize on Back")

    # ------------------------------------------------------------------ AC-3: views and routes
    def test_11_a_view_switch_crossfades_the_content_and_nothing_else_moves(self):
        page = self.page()
        self.open(page, self.fx.project_url())
        settled(page)
        clear(page)
        boxes = {**CHROME, "composer": ".composer__box"}
        frames = sample_while(page, f"() => {{ document.querySelector(\"{self.tab('tasks')}\").click(); }}", boxes, 900)
        expect(page.locator(self.tab("tasks"))).to_have_attribute("aria-current", "page")
        fades = self.by(page, r"app__pane", "script")
        self.assertTrue(fades, "the content area fades")
        self.assertLessEqual(fades[0]["duration"], 160)
        self.assertEqual(fades[0]["props"], ["opacity"], "opacity alone: nothing in the new content travels")
        self.assert_ease(fades[0], EASE_OUT, "view")
        for key in (*CHROME, "composer"):
            self.assertEqual(moved(frames, key), [], f"the {key} stays still during the switch")
        # Back to the conversation: its composer comes back in its own place and never travels while it does.
        settled(page)
        clear(page)
        back = sample_while(page, f"() => {{ document.querySelector(\"{PROJECT_TABS} a:first-of-type\").click(); }}", boxes, 900)
        expect(page.locator(".composer__box").first).to_be_visible()
        seen = [frame["boxes"]["composer"] for frame in back if frame["boxes"]["composer"]]
        self.assertTrue(seen)
        self.assertTrue(all(close(box, seen[-1], 0.5) for box in seen), f"the composer never moves: {seen[:3]}")
        for key in CHROME:
            self.assertEqual(moved(back, key), [], f"the {key} stays still on the way back")
        # A thread opening beside the conversation is not a view switch, and a first load animates nothing.
        page.goto(self.fx.thread_url())
        ready(page)
        self.assertEqual(self.by(page, r"app__pane"), [], "first load animates nothing")

    def test_12_a_place_switch_crossfades_too_and_the_reading_position_is_not_animated(self):
        page = self.page()
        self.open(page, self.fx.project_url())
        settled(page)
        clear(page)
        page.get_by_role("navigation", name="Places").get_by_role("link", name="Inbox").click()
        expect(page.get_by_role("heading", level=1, name="Inbox")).to_be_visible()
        fades = self.by(page, r"app__pane", "script")
        self.assertTrue(fades and fades[0]["props"] == ["opacity"] and fades[0]["duration"] <= 160, fades)
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
        first = [entry for entry in recorded(page) if entry["at"] < 400 and not KRESKA.search(entry["target"] + entry.get("name", ""))]
        self.assertEqual([(entry["target"], entry["props"]) for entry in first], [], "no motion at first paint")
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
        other = self.page()
        self.open(other, self.fx.project_url())
        clear(other)
        other.evaluate("Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })")
        other.keyboard.press("Control+k")
        expect(other.get_by_role("dialog", name="Jump to")).to_be_visible()
        self.assertEqual([entry for entry in recorded(other) if entry["kind"] == "script"], [], "a hidden page starts no motion")

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
        calm = self.page(phone=True, reduced=True)
        self.open(calm, self.fx.tasks_url())
        calm.locator(".ws-task .ws-item").first.tap()
        expect(calm.get_by_role("dialog", name="Details")).to_be_visible()
        self.assertEqual([entry for entry in recorded(calm) if entry["kind"] == "script"], [])


if __name__ == "__main__":
    unittest.main()
