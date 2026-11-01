"""Browser tests for the app's own select (issue #695, apps/web/src/ui/Select.tsx).

Runs with the other tests/ui modules through scripts/check_ui.sh against the running Compose application.
A native <select> opens the system's list, which ignores the Prostota tokens, the dark theme and the phone sheet.
Nia has two projects; the search page's Place filter, Settings' Place to mute and the Create window's Project field
are places that use the shared select (the phone's /search is its one search sheet, without a Place select, #763 SE-2). The tests check what a person and a screen reader meet: the combobox and listbox
semantics, every key of the select-only combobox pattern, that opening never moves a control, that it works inside
a dialog (Esc closes the list, not the dialog), that it is the same bottom sheet as the other menus on a phone, the
tokens in both themes, and axe. FLUX_UI_BROWSER selects chromium (default) or webkit.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
import unittest
from pathlib import Path

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from app_select import choose, expect_value, listbox_of
from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
if UI_BROWSER not in ("chromium", "webkit"):
    raise ValueError(f"FLUX_UI_BROWSER must be chromium or webkit, got {UI_BROWSER!r}")

AXE = Path(__file__).parent / "vendor" / "axe-core-4.13.0.min.js"
AXE_SHA256 = "c24f097bd2f451d4f933e8bc7d8d539f8672a2ebcb5cc9f9f3eec8ca9470a0c1"
PASSWORD = "one calm way to choose"
STAMP = int(time.time() * 1000)
NIA = {"name": "Nia Berg", "email": f"nia.select+{STAMP}@example.test"}


class AppSelect(unittest.TestCase):
    """Tests run in name order and share one account with two projects."""

    pw = None
    browser: Browser
    state: dict = {}
    ids: dict[str, str] = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=8000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def context(self, *, phone: bool = False, dark: bool = False, signed_in: bool = True) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "color_scheme": "dark" if dark else "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw"}
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=DESKTOP, device_scale_factor=1)
        if signed_in and self.state:
            options["storage_state"] = self.state
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        return context

    def page(self, **kwargs) -> Page:
        page = self.context(**kwargs).new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def api(self, page: Page, method: str, path: str, body: dict | None = None, status: int | None = None) -> dict:
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers={"origin": ORIGIN, "content-type": "application/json"},
                                      data=json.dumps(body) if body is not None else None)
        if status is not None:
            self.assertEqual(response.status, status, response.text())
        return json.loads(response.text()) if response.text() else {}

    def search(self, **kwargs):
        page = self.page(**kwargs)
        page.goto("/search?q=lamp")
        place = page.get_by_role("combobox", name="Place")
        expect(place).to_be_visible()
        return page, place

    def mute(self, **kwargs):
        """Settings' "Place to mute": the same select at every width (the search page's Place filter is the computer's only)."""
        page = self.page(**kwargs)
        page.goto("/settings/notifications")
        place = page.get_by_role("combobox", name="Place to mute", exact=True)
        expect(place).to_be_visible()
        return page, place

    # ---------------------------------------------------------------- an account with two projects

    def test_01_an_account_with_two_projects(self) -> None:
        page = self.page(signed_in=False)
        page.goto("/sign-up")
        page.get_by_label("Name").fill(NIA["name"])
        page.get_by_label("Email").fill(NIA["email"])
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        type(self).state = page.context.storage_state()
        ws = self.api(page, "POST", "/api/v1/workspaces", {"name": "Lamp studio"}, status=201)
        for key, name in (("lamp", "Gesture lamp"), ("notes", "Studio notes")):
            project = self.api(page, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": name, "visibility": "workspace"}, status=201)
            self.ids[key] = project["id"]
        self.ids["workspace"] = ws["id"]

    # ---------------------------------------------------------------- semantics a screen reader meets

    def test_02_it_is_a_combobox_with_a_listbox_and_no_native_select_remains(self) -> None:
        page, place = self.search()
        expect(page.locator("select")).to_have_count(0)
        expect(place).to_have_attribute("aria-haspopup", "listbox")
        expect(place).to_have_attribute("aria-expanded", "false")
        expect(place).to_have_text("All places")
        place.click()
        box = listbox_of(place)
        expect(box).to_be_visible()
        self.assertEqual(box.get_attribute("role"), "listbox")
        self.assertEqual(box.get_attribute("aria-label"), "Place", "the list is named like the control")
        names = [o.strip() for o in box.get_by_role("option").all_inner_texts()]
        self.assertEqual(names, ["All places", "# Gesture lamp", "# Studio notes", "Only you"])
        expect(box.get_by_role("option", name="All places", exact=True)).to_have_attribute("aria-selected", "true")
        expect(box.get_by_role("option", name="Only you", exact=True)).to_have_attribute("aria-selected", "false")
        active = place.get_attribute("aria-activedescendant")
        self.assertTrue(active, "the arrow keys' option is named by aria-activedescendant")
        self.assertEqual(page.locator(f'[id="{active}"]').inner_text().strip(), "All places")
        self.assertEqual(place.get_attribute("aria-controls"), box.get_attribute("id"))
        # The accessibility tree sees a combobox whose list is a listbox of options, one of them selected.
        expect(box).to_match_aria_snapshot("""
            - listbox "Place":
              - option "All places" [selected]
              - option "# Gesture lamp"
              - option "# Studio notes"
              - option "Only you"
        """)
        box.get_by_role("option", name="Only you", exact=True).click()
        expect(place).to_have_attribute("aria-expanded", "false")
        expect(place).to_have_text("Only you")
        expect(page).to_have_url(re.compile(r"place=private"))
        expect(place).to_be_focused()

    def test_03_a_label_names_it_and_groups_are_announced(self) -> None:
        page = self.page()
        page.goto("/settings/notifications")
        # "Place to mute" is a visually hidden <label for> the control: the label still names it, and so names its list.
        expect(page.get_by_label("Place to mute", exact=True)).to_have_attribute("role", "combobox")  # one element: the list is not there until it opens
        mute = page.get_by_role("combobox", name="Place to mute", exact=True)
        expect(mute).to_have_text("Choose a project or conversation…")
        mute.click()
        box = listbox_of(mute)
        self.assertEqual(box.get_attribute("aria-label"), "Place to mute")
        projects = box.get_by_role("group", name="Projects")
        expect(projects.get_by_role("option")).to_have_count(2)
        shot(page, f"app-select-settings-{UI_BROWSER}")
        expect(projects.get_by_role("option", name="# Gesture lamp", exact=True)).to_be_visible()
        projects.get_by_role("option", name="# Studio notes", exact=True).click()
        expect(mute).to_have_text("# Studio notes")
        expect_value(mute, f"project:{self.ids['notes']}")
        expect(mute).to_be_focused()

    # ---------------------------------------------------------------- the select-only combobox keys

    def test_04_keys_open_move_choose_and_close(self) -> None:
        page, place = self.search()
        active = lambda: page.locator('[role="listbox"] [data-active]')  # noqa: E731
        place.focus()
        # Closed: ArrowDown opens on the chosen option; Escape closes without choosing and returns focus.
        page.keyboard.press("ArrowDown")
        expect(place).to_have_attribute("aria-expanded", "true")
        expect(active()).to_have_text("All places")
        page.keyboard.press("ArrowDown")
        expect(active()).to_have_text("# Gesture lamp")
        page.keyboard.press("End")
        expect(active()).to_have_text("Only you")
        page.keyboard.press("ArrowDown")
        expect(active()).to_have_text("Only you")  # the list ends; it does not wrap
        page.keyboard.press("Home")
        expect(active()).to_have_text("All places")
        page.keyboard.press("Escape")
        expect(place).to_have_attribute("aria-expanded", "false")
        expect(place).to_be_focused()
        expect(place).to_have_text("All places")
        expect_value(place, "")
        # Enter chooses what the arrows are on; focus stays on the control.
        page.keyboard.press("ArrowDown")
        page.keyboard.press("ArrowDown")
        page.keyboard.press("ArrowDown")
        expect(active()).to_have_text("# Studio notes")
        page.keyboard.press("Enter")
        expect(place).to_have_attribute("aria-expanded", "false")
        expect(place).to_have_text("# Studio notes")
        expect_value(place, f"project:{self.ids['notes']}")
        expect(place).to_be_focused()
        # Space chooses too, and the click a browser adds on key up does not open the list again.
        page.keyboard.press("ArrowUp")  # closed: opens on the chosen option
        expect(active()).to_have_text("# Studio notes")
        page.keyboard.press("ArrowUp")
        expect(active()).to_have_text("# Gesture lamp")
        page.keyboard.press("Space")
        expect(place).to_have_text("# Gesture lamp")
        page.wait_for_timeout(150)
        expect(place).to_have_attribute("aria-expanded", "false")
        # Enter and Space open it from the closed control as a button does.
        page.keyboard.press("Enter")
        expect(place).to_have_attribute("aria-expanded", "true")
        page.keyboard.press("Escape")
        page.keyboard.press("Space")
        expect(place).to_have_attribute("aria-expanded", "true")
        page.keyboard.press("Escape")
        # Alt+Up chooses and closes, Alt+Down closes.
        page.keyboard.press("ArrowDown")
        page.keyboard.press("ArrowDown")
        page.keyboard.press("Alt+ArrowUp")
        expect(place).to_have_text("# Studio notes")
        expect(place).to_have_attribute("aria-expanded", "false")
        expect(page).to_have_url(re.compile(rf"place=project(%3A|:){self.ids['notes']}"))  # the page has taken the choice
        page.keyboard.press("ArrowDown")
        expect(place).to_have_attribute("aria-expanded", "true")
        page.keyboard.press("Alt+ArrowDown")
        expect(place).to_have_attribute("aria-expanded", "false")
        expect(place).to_have_text("# Studio notes")

    def test_05_typing_jumps_to_an_option_and_a_letter_opens_the_closed_list(self) -> None:
        page, place = self.search()
        active = lambda: page.locator('[role="listbox"] [data-active]')  # noqa: E731
        place.focus()
        page.keyboard.type("o")  # closed: a letter opens the list on the option it begins
        expect(place).to_have_attribute("aria-expanded", "true")
        expect(active()).to_have_text("Only you")
        page.wait_for_timeout(750)  # the typed letters are forgotten after a moment
        page.keyboard.type("all")  # several letters narrow down
        expect(active()).to_have_text("All places")
        page.wait_for_timeout(750)
        page.keyboard.type("#")
        expect(active()).to_have_text("# Gesture lamp")
        page.wait_for_timeout(750)
        page.keyboard.type("#")  # the same key again goes on to the next that begins with it
        expect(active()).to_have_text("# Studio notes")
        page.keyboard.press("Enter")
        expect(place).to_have_text("# Studio notes")
        # The global single-key shortcuts leave a focused select alone: "c" must not open Create.
        page.keyboard.press("Escape")
        place.focus()
        page.keyboard.press("c")
        expect(page.get_by_role("dialog", name="Create")).to_have_count(0)
        page.keyboard.press("Escape")

    def test_06_tab_chooses_what_the_arrows_are_on_and_moves_on(self) -> None:
        page, place = self.search()
        place.focus()
        page.keyboard.press("ArrowDown")
        page.keyboard.press("End")
        page.keyboard.press("Tab")
        expect(place).to_have_text("Only you")
        expect(place).to_have_attribute("aria-expanded", "false")
        expect(place).not_to_be_focused()

    def test_07_a_click_outside_closes_it_and_a_second_click_on_it_closes_it(self) -> None:
        page, place = self.search()
        place.click()
        expect(place).to_have_attribute("aria-expanded", "true")
        page.get_by_role("heading", level=1).first.click()
        expect(place).to_have_attribute("aria-expanded", "false")
        expect(place).to_have_text("All places")
        place.click()
        expect(place).to_have_attribute("aria-expanded", "true")
        place.click()
        expect(place).to_have_attribute("aria-expanded", "false")

    # ---------------------------------------------------------------- nothing moves

    def test_08_opening_and_choosing_never_move_a_control(self) -> None:
        page, place = self.search()
        before = {name: page.locator(selector).first.bounding_box() for name, selector in
                  (("place", ".search__place .ui-select"), ("chips", ".search__filters"), ("page", "h1"))}
        scroll = page.evaluate("[document.documentElement.scrollWidth, document.documentElement.scrollHeight]")
        place.click()
        box = listbox_of(place)
        expect(box).to_be_visible()
        pop = page.locator(".ui-select__pop")
        opened = {name: page.locator(selector).first.bounding_box() for name, selector in
                  (("place", ".search__place .ui-select"), ("chips", ".search__filters"), ("page", "h1"))}
        self.assertEqual(before, opened, "opening the list moved nothing")
        self.assertEqual(scroll, page.evaluate("[document.documentElement.scrollWidth, document.documentElement.scrollHeight]"))
        trigger, layer = place.bounding_box(), pop.bounding_box()
        self.assertGreaterEqual(layer["y"], trigger["y"] + trigger["height"] - 1, "the list is under its control")
        self.assertGreaterEqual(layer["x"], 0)
        self.assertLessEqual(layer["x"] + layer["width"], DESKTOP["width"])
        self.assertGreaterEqual(layer["width"], trigger["width"] - 1, "the list is at least as wide as its control")
        page.keyboard.press("End")
        page.keyboard.press("Enter")
        expect(place).to_have_text("Only you")
        after = place.bounding_box()
        self.assertEqual(before["place"], after, "the control is as wide as its widest option: choosing another never moves or resizes it")
        shot(page, f"app-select-closed-{UI_BROWSER}")

    def test_15_a_long_list_scrolls_inside_the_viewport_and_keeps_the_active_option_visible(self) -> None:
        page = self.page()
        for n in range(14):
            self.api(page, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/projects", {"name": f"Bench {n:02d} sensor", "visibility": "workspace"}, status=201)
        page.goto("/search?q=lamp")
        place = page.get_by_role("combobox", name="Place")
        expect(place).to_be_visible()
        place.focus()
        page.keyboard.press("End")
        page.keyboard.press("ArrowDown")
        page.keyboard.press("End")
        pop = page.locator(".ui-select__pop")
        layer = pop.bounding_box()
        self.assertLessEqual(layer["y"] + layer["height"], DESKTOP["height"], "the list stays inside the window")
        last = page.locator('[role="listbox"] [data-active]')
        expect(last).to_have_text("Only you")
        expect(last).to_be_in_viewport()
        shot(page, f"app-select-long-{UI_BROWSER}")
        page.keyboard.press("Escape")

    def test_09_typing_treats_a_space_and_an_underscore_alike(self) -> None:
        page = self.page()
        page.goto("/settings/notifications")
        quiet = page.get_by_role("switch", name="Quiet hours")
        expect(quiet).to_be_visible()
        if quiet.get_attribute("aria-checked") != "true":
            quiet.click()
        zone = page.get_by_role("combobox", name="Time zone", exact=True)
        expect(zone).to_be_visible()
        # The list shows "America/New York"; the value (and what a person may type) is "America/New_York".
        for typed in ("america/new_york", "america/new york", "America/New York"):
            with self.subTest(typed=typed):
                zone.focus()
                page.keyboard.press("Home")
                page.keyboard.type(typed)
                expect(page.locator('[role="listbox"] [data-active]')).to_have_text("America/New York")
                page.keyboard.press("Escape")
                expect(zone).to_have_attribute("aria-expanded", "false")
                page.wait_for_timeout(700)  # the typed letters are forgotten after a moment
        zone.focus()
        page.keyboard.press("Home")
        page.keyboard.type("america/new_york")
        page.keyboard.press("Enter")
        expect_value(zone, "America/New_York")

    # ---------------------------------------------------------------- tokens, light and dark

    def test_10_the_list_wears_the_tokens_in_both_themes(self) -> None:
        for dark in (False, True):
            with self.subTest(dark=dark):
                page, place = self.search(dark=dark)
                place.click()
                expect(page.locator(".ui-select__pop")).to_be_visible()
                page.keyboard.press("ArrowDown")
                page.wait_for_function("() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().endTime === Infinity)")
                read = page.evaluate("""() => {
                    const probe = (prop, token) => { const el = document.createElement('i'); el.style[prop] = `var(${token})`; document.body.append(el); const v = getComputedStyle(el)[prop]; el.remove(); return v; };
                    const pop = document.querySelector('.ui-select__pop');
                    const option = pop.querySelector('[role="option"]:not([data-active])');
                    const active = pop.querySelector('[data-active]');
                    return {
                      popBg: getComputedStyle(pop).backgroundColor, el: probe('backgroundColor', '--el'),
                      optColor: getComputedStyle(option).color, t1: probe('color', '--t1'),
                      activeBg: getComputedStyle(active).backgroundColor, sub: probe('backgroundColor', '--sub'),
                      shadow: getComputedStyle(pop).boxShadow, radius: getComputedStyle(pop).borderTopLeftRadius,
                      triggerBg: getComputedStyle(document.querySelector('.search__place .ui-select')).backgroundColor,
                    };
                }""")
                self.assertEqual(read["popBg"], read["el"], "the list is the --el surface")
                self.assertEqual(read["optColor"], read["t1"], "options read in --t1")
                self.assertEqual(read["activeBg"], read["sub"], "the option under the arrows is the --sub fill")
                self.assertNotEqual(read["shadow"], "none", "the list lifts with the pop-over shadow")
                self.assertEqual(read["radius"], "14px")
                self.assertEqual(read["triggerBg"], read["el"])
                shot(page, f"app-select-open-{'dark' if dark else 'light'}-{UI_BROWSER}")

    # ---------------------------------------------------------------- inside a dialog

    def test_11_inside_a_dialog_escape_closes_the_list_first_and_the_choice_stays_in_the_dialog(self) -> None:
        page = self.page()
        page.goto(f"/projects/{self.ids['lamp']}")
        expect(page.get_by_role("heading", level=1, name="Gesture lamp")).to_be_visible()
        page.get_by_role("complementary", name="Sidebar").get_by_role("button", name=re.compile("^New")).click()
        window = page.get_by_role("dialog").filter(has=page.get_by_role("combobox", name="Project"))
        expect(window).to_be_visible()
        project = window.get_by_role("combobox", name="Project")
        expect(project).to_have_attribute("aria-expanded", "false")
        project.click()
        box = listbox_of(project)
        expect(box.get_by_role("option")).to_have_count(2)
        shot(page, f"app-select-create-{UI_BROWSER}")
        page.keyboard.press("Escape")
        expect(project).to_have_attribute("aria-expanded", "false")
        expect(window).to_be_visible()  # Esc closed the list, not the dialog
        expect(project).to_be_focused()
        project.click()
        listbox_of(project).get_by_role("option", name=re.compile("Studio notes")).click()
        expect(window).to_be_visible()
        expect_value(project, self.ids["notes"])
        expect(window.locator(".create__place-name")).to_contain_text("Studio notes")
        expect(project).to_be_focused()
        page.keyboard.press("Escape")  # the list is closed now, so this one is the dialog's
        expect(window).to_have_count(0)

    # ---------------------------------------------------------------- the phone

    def test_12_on_a_phone_it_is_the_same_bottom_sheet_as_the_other_menus(self) -> None:
        page, place = self.mute(phone=True)
        place.tap()
        sheet = page.get_by_role("dialog", name="Place to mute")
        expect(sheet).to_be_visible()
        box = listbox_of(place)
        expect(box).to_be_focused()
        page.wait_for_function("() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().endTime === Infinity)")
        frame = sheet.bounding_box()
        self.assertEqual(round(frame["x"]), 0)
        self.assertEqual(round(frame["width"]), PHONE["width"])
        self.assertEqual(round(frame["y"] + frame["height"]), PHONE["height"], "the sheet sits at the bottom edge")
        self.assertGreater(frame["y"], PHONE["height"] * 0.2, "the page stays in view above the sheet")
        radius = sheet.evaluate("el => getComputedStyle(el).borderTopLeftRadius")
        self.assertEqual(radius, "26px", "the phone sheet's top corners")
        for option in box.get_by_role("option").all():
            self.assertGreaterEqual(option.bounding_box()["height"], 44 - 0.5, "options are touch targets")
        shot(page, f"app-select-sheet-{UI_BROWSER}")
        page.keyboard.press("ArrowDown")
        page.keyboard.press("ArrowDown")
        page.keyboard.press("Enter")
        expect(sheet).to_have_count(0)
        expect(place).to_have_text("# Studio notes")
        expect(place).to_be_focused()
        # A tap on an option chooses it; the scrim and Esc close without choosing.
        place.tap()
        listbox_of(place).get_by_role("option", name="# Gesture lamp", exact=True).tap()
        expect(place).to_have_text("# Gesture lamp")
        place.tap()
        expect(sheet).to_be_visible()
        page.mouse.click(PHONE["width"] // 2, 40)
        expect(sheet).to_have_count(0)
        expect(place).to_have_text("# Gesture lamp")
        expect(place).to_be_focused()
        place.tap()
        expect(sheet).to_be_visible()
        page.keyboard.press("Escape")
        expect(sheet).to_have_count(0)
        expect(place).to_be_focused()

    def test_13_a_select_inside_the_phone_create_sheet_opens_its_own_sheet(self) -> None:
        page = self.page(phone=True)
        page.goto("/")
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        page.get_by_role("button", name=re.compile(r"^(Create|New)")).first.tap()
        create = page.get_by_role("dialog", name="Create")
        expect(create).to_be_visible()
        project = create.get_by_role("combobox", name="Project")
        project.tap()
        chooser = page.get_by_role("dialog", name="Project")
        expect(chooser).to_be_visible()
        shot(page, f"app-select-create-sheet-{UI_BROWSER}")
        listbox_of(project).get_by_role("option", name="Studio notes", exact=True).tap()
        expect(chooser).to_have_count(0)
        expect(create).to_be_visible()
        expect(project).to_contain_text("Studio notes")

    def test_13b_an_open_list_follows_the_window_between_popover_and_sheet(self) -> None:
        page, place = self.mute()
        place.click()
        expect(page.locator(".ui-select__pop")).to_be_visible()
        page.keyboard.press("ArrowDown")
        page.keyboard.press("ArrowDown")
        # Narrowing to phone width turns the open popover into the phone's sheet, with the same option under the arrows.
        page.set_viewport_size(PHONE)
        sheet = page.get_by_role("dialog", name="Place to mute")
        expect(sheet).to_be_visible()
        expect(page.locator(".ui-select__pop")).to_have_count(0)
        expect(place).to_have_attribute("aria-expanded", "true")
        expect(sheet.locator("[data-active]")).to_have_text("# Studio notes")
        # Widening brings the popover back, still open, and the keys keep working.
        page.set_viewport_size(DESKTOP)
        expect(sheet).to_have_count(0)
        expect(page.locator(".ui-select__pop")).to_be_visible()
        expect(place).to_have_attribute("aria-expanded", "true")
        expect(place).to_be_focused()
        page.keyboard.press("Enter")
        expect(place).to_have_text("# Studio notes")
        # A closed select that meets a narrow window opens as the sheet.
        page.set_viewport_size(PHONE)
        place.click()
        expect(page.get_by_role("dialog", name="Place to mute")).to_be_visible()
        page.keyboard.press("Escape")
        expect(place).to_have_attribute("aria-expanded", "false")

    def test_13c_the_focus_ring_is_the_soft_field_ring(self) -> None:
        page, place = self.search()
        place.focus()
        page.keyboard.press("Tab")
        page.keyboard.press("Shift+Tab")
        expect(place).to_be_focused()
        look = place.evaluate("el => { const s = getComputedStyle(el); return { outline: s.outlineStyle, shadow: s.boxShadow }; }")
        self.assertEqual(look["outline"], "none", "no heavy outline")
        self.assertIn("inset", look["shadow"], "a hairline inside and a soft halo outside, like the other fields")

    # ---------------------------------------------------------------- axe

    def axe(self, page: Page, where: str, *scopes: str) -> None:
        source = AXE.read_bytes()
        self.assertEqual(hashlib.sha256(source).hexdigest(), AXE_SHA256, "the vendored axe is the one that was verified")
        page.wait_for_function("() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().endTime === Infinity)")
        page.add_script_tag(content=source.decode())
        for scope in scopes:
            result = page.evaluate("""async (scope) => (await axe.run(document.querySelector(scope), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }))
                .violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ') + ' :: ' + n.failureSummary.split('\\n').slice(1, 3).join(' ')) }))""", scope)
            self.assertEqual(result, [], f"axe violations on {where} ({scope})")

    def test_14_axe_finds_nothing_on_the_control_or_its_list_at_both_widths_in_both_themes(self) -> None:
        for phone, dark in ((False, False), (False, True), (True, False), (True, True)):
            with self.subTest(phone=phone, dark=dark):
                page, place = self.mute(phone=True, dark=dark) if phone else self.search(dark=dark)
                scope = ".nset__mute" if phone else ".search__place"
                self.axe(page, "the closed select", scope)
                place.click()
                expect(place).to_have_attribute("aria-expanded", "true")
                self.axe(page, "the open select", scope, ".ui-select__pop" if not phone else ".ui-select-sheet")


if __name__ == "__main__":
    unittest.main()
