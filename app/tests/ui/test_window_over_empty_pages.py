"""A window is above an empty page behind it (#1234, v0.2.0): the empty Wiki's "New page" was a menu row (z-index 50) and was
painted over the Create window's space picker and title.

Runs with the other tests/ui journeys through scripts/check_ui.sh against the running Compose app; FLUX_UI_BROWSER picks the engine
(chromium by default, webkit too). The empty Wiki's New page is an ordinary primary Button with no menu class and no z-index. With the
empty Wiki, Tasks and Map behind them, the Create window (each tab and New space) and the Search window have nothing of the page
painted over them: `elementFromPoint` over the window's box, its space picker and its title returns the
window's own elements. Computer and phone widths, light and dark.
"""

from __future__ import annotations

import json
import os
import re
import time
import unittest

from playwright.sync_api import Browser, Page, expect, sync_playwright

from layers import foreign_at_centre, foreign_points, layers_above, settle
from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
PASSWORD = "an empty page stays behind"
EMAIL = f"ola.layers+{int(time.time() * 1000)}@example.test"
HEADERS = {"origin": ORIGIN, "content-type": "application/json"}
PAGES = {"Wiki": "docs", "Tasks": "tasks", "Map": "map"}


class WindowOverEmptyPages(unittest.TestCase):
    browser: Browser
    state: dict
    ids: dict[str, str] = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=10000)
        context = cls.browser.new_context(service_workers="block", base_url=ORIGIN)
        response = context.request.post("/api/auth/sign-up/email", data={"name": "Ola Layers", "email": EMAIL, "password": PASSWORD}, headers={"origin": ORIGIN})
        assert response.status == 200, response.text()
        workspace = context.request.post("/api/v1/workspaces", data=json.dumps({"name": "Quiet company"}), headers=HEADERS)
        assert workspace.status == 201, workspace.text()
        # A space with no page, no task and no map: the three empty states are the pages behind the windows.
        project = context.request.post(f"/api/v1/workspaces/{workspace.json()['id']}/projects", data=json.dumps({"name": "Quiet shelf", "visibility": "restricted"}), headers=HEADERS)
        assert project.status == 201, project.text()
        cls.ids = {"workspace": workspace.json()["id"], "project": project.json()["id"]}
        cls.state = context.storage_state()
        context.close()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, scheme: str, phone: bool) -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": scheme, "locale": "en-GB", "timezone_id": "Europe/Warsaw", "service_workers": "block",
                         "storage_state": self.state, "viewport": PHONE if phone else DESKTOP, "device_scale_factor": 1, "reduced_motion": "reduce"}
        if phone:
            options.update(is_mobile=True, has_touch=True)
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def open_page(self, page: Page, name: str) -> None:
        page.goto(f"/projects/{self.ids['project']}/{PAGES[name]}")
        expect(page.get_by_role("heading", level=1, name="Quiet shelf")).to_be_visible()
        if name == "Wiki":
            expect(page.get_by_role("heading", name="No pages yet")).to_be_visible()
        # Nothing finite is moving before a window opens over the page.
        settle(page)

    def whole(self, page: Page, window, what: str) -> None:
        expect(window).to_be_visible()
        self.assertEqual(foreign_points(page, window), [], f"{what}: something of the page is hit over it")
        self.assertEqual(layers_above(page, window), [], f"{what}: a layer of the page stacks over it")

    # ---------------------------------------------------------------- the empty Wiki's New page is an ordinary Button

    def test_01_the_empty_wikis_new_page_is_an_ordinary_button_with_no_layer_of_its_own(self) -> None:
        for scheme, phone in (("dark", False), ("light", True)):
            with self.subTest(scheme=scheme, phone=phone):
                page = self.page(scheme, phone)
                self.open_page(page, "Wiki")
                acts = page.locator(".wiki-empty__acts")
                new_page = acts.get_by_role("button", name="New page", exact=True)
                expect(new_page).to_have_class(re.compile(r"\bui-btn\b.*\bui-btn--primary\b"))
                self.assertEqual(new_page.evaluate("el => el.closest('.wiki-menu') === null"), True, "no menu around it")
                expect(new_page).not_to_have_class(re.compile("wiki-menu"))
                expect(new_page).to_have_css("z-index", "auto")
                expect(new_page).to_have_css("position", "static")
                # One primary and an outline beside it, of the same height and weight: no card next to a link.
                importing = acts.get_by_role("button", name="Import a Markdown file", exact=True)
                expect(importing).to_have_class(re.compile(r"\bui-btn--outline\b"))
                first, second = new_page.bounding_box(), importing.bounding_box()
                self.assertEqual(round(first["height"]), round(second["height"]), "the two buttons are one height")
                self.assertLessEqual(first["height"], 44)
                self.assertEqual(new_page.evaluate("el => getComputedStyle(el).fontWeight"), importing.evaluate("el => getComputedStyle(el).fontWeight"))
                shot(page, f"1234-empty-wiki-{'390' if phone else '1440'}-{scheme}")
                # Naming the page keeps the row: the field and its Create (the primary) in place of New page.
                new_page.click()
                field = page.get_by_role("textbox", name="Name of the new page")
                expect(field).to_be_focused()
                create = acts.get_by_role("button", name="Create", exact=True)
                expect(create).to_have_class(re.compile(r"\bui-btn--primary\b"))
                self.assertEqual(round(field.bounding_box()["height"]), round(create.bounding_box()["height"]), "the field and Create are one height")
                shot(page, f"1234-empty-wiki-naming-{'390' if phone else '1440'}-{scheme}")

    # ---------------------------------------------------------------- the windows over the empty pages

    def the_check_sees_a_layer_over_the_window(self, page: Page, window) -> None:
        """The check itself: a menu-level layer of the page (what the empty Wiki's "New page" was) painted over the window is found."""
        page.evaluate("""() => { const layer = document.createElement('div'); layer.id = 'probe-layer';
            layer.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:var(--z-menu);background:transparent';
            document.querySelector('.app__main, main, #root').append(layer); }""")
        try:
            self.assertNotEqual(layers_above(page, window), [], "a layer at the menu's z-index over the window is seen by the check")
        finally:
            page.evaluate("() => document.getElementById('probe-layer')?.remove()")
        self.assertEqual(layers_above(page, window), [], "and the window is whole again without it")

    def test_02_the_create_window_is_whole_over_the_empty_wiki_tasks_and_map_on_the_computer(self) -> None:
        page = self.page("dark", False)
        for behind in PAGES:
            with self.subTest(behind=behind):
                self.open_page(page, behind)
                page.locator("body").press("c")
                window = page.get_by_role("dialog", name=re.compile(r"^New (task|thought|decision|page|space)$"))
                expect(window).to_be_visible()
                tabs = window.get_by_role("tablist", name="Create")
                for kind in ("Task", "Thought", "Decision", "Page"):
                    tabs.get_by_role("tab", name=kind, exact=True).click()
                    expect(tabs.get_by_role("tab", name=kind, exact=True)).to_have_attribute("aria-selected", "true")
                    window = page.get_by_role("dialog", name=f"New {kind.lower()}")
                    self.whole(page, window, f"Create ({kind}) over the empty {behind}")
                    title = window.get_by_role("textbox").first
                    self.assertEqual(foreign_at_centre(page, title), "", f"the {kind} title is reached through the empty {behind}")
                    picker = window.get_by_role("combobox", name="Space")
                    if picker.count():
                        self.assertEqual(foreign_at_centre(page, picker), "", f"the space picker of {kind} is reached through the empty {behind}")
                        expect(picker).to_be_visible()
                    if behind == "Wiki" and kind == "Task":
                        shot(page, "1234-create-over-empty-wiki-1440-dark")
                        self.the_check_sees_a_layer_over_the_window(page, window)
                tabs.get_by_role("tab", name="Space", exact=True).click()
                space = page.get_by_role("dialog", name="New space")
                self.whole(page, space, f"New space over the empty {behind}")
                page.keyboard.press("Escape")
                expect(page.get_by_role("dialog")).to_have_count(0)

    def test_03_the_create_window_is_whole_over_the_empty_wiki_tasks_and_map_on_the_phone(self) -> None:
        page = self.page("light", True)
        for behind in PAGES:
            with self.subTest(behind=behind):
                self.open_page(page, behind)
                for kind in ("Task", "Thought", "Decision", "Page", "Space"):
                    page.get_by_role("button", name="Create", exact=True).tap()
                    sheet = page.get_by_role("dialog", name="Create")
                    expect(sheet).to_be_visible()
                    self.whole(page, sheet, f"the Create sheet over the empty {behind}")
                    sheet.get_by_role("button", name=kind, exact=True).tap()
                    window = page.get_by_role("dialog", name=f"New {kind.lower()}")
                    self.whole(page, window, f"Create ({kind}) over the empty {behind}")
                    picker = window.get_by_role("combobox", name="Space")
                    if picker.count():
                        self.assertEqual(foreign_at_centre(page, picker), "", f"the space picker of {kind} is reached through the empty {behind}")
                    if behind == "Wiki" and kind == "Task":
                        shot(page, "1234-create-over-empty-wiki-390-light")
                    page.keyboard.press("Escape")
                    expect(page.get_by_role("dialog")).to_have_count(0)

    def test_04_the_search_window_is_whole_over_the_empty_pages(self) -> None:
        for scheme, phone in (("dark", False), ("light", True)):
            page = self.page(scheme, phone)
            for behind in PAGES:
                with self.subTest(scheme=scheme, phone=phone, behind=behind):
                    self.open_page(page, behind)
                    page.get_by_role("button", name="Search", exact=True).first.click()
                    search = page.get_by_role("dialog", name="Search", exact=True)
                    self.whole(page, search, f"Search over the empty {behind}")
                    self.assertEqual(foreign_at_centre(page, search.get_by_role("combobox", name="Search", exact=True)), "", "the search field is reached")
                    if behind == "Wiki":
                        shot(page, f"1234-search-over-empty-wiki-{'390' if phone else '1440'}-{scheme}")
                    page.keyboard.press("Escape")
                    expect(page.get_by_role("dialog")).to_have_count(0)


if __name__ == "__main__":
    unittest.main()
