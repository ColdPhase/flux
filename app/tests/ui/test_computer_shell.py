"""The computer shell's sidebar (#340, final design F-026 §4): the drawn order, the 64px rail with "[",
New with "C", Search, "G I" to the Inbox, project tiles and the account row.

Runs with the other tests/ui journeys through scripts/check_ui.sh against the running Compose app.
"""

from __future__ import annotations

import json
import re
import time
import unittest

from playwright.sync_api import Browser, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, UPSTREAM, shot, start_forwarder

PASSWORD = "one calm sidebar"
EMAIL = f"ada.shell+{int(time.time() * 1000)}@example.test"


class ComputerShell(unittest.TestCase):
    browser: Browser
    state: dict = {}
    ids: dict = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        expect.set_options(timeout=8000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, scheme: str = "light") -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": scheme, "locale": "en-GB", "timezone_id": "Europe/Warsaw",
                         "service_workers": "block", "viewport": DESKTOP, "device_scale_factor": 1}
        if self.state:
            options["storage_state"] = self.state
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        return context.new_page()

    def api(self, page: Page, method: str, path: str, body: dict) -> dict:
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers={"origin": ORIGIN, "content-type": "application/json"}, data=json.dumps(body))
        self.assertEqual(response.status, 201, response.text())
        return json.loads(response.text())

    def ensure_account(self) -> None:
        if self.state:
            return
        page = self.page()
        page.goto("/sign-up")
        page.get_by_label("Name").fill("Ada Shell")
        page.get_by_label("Email").fill(EMAIL)
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        workspace = self.api(page, "POST", "/api/v1/workspaces", {"name": "Garden sensors"})
        for name in ("Community garden sensors", "Cargo bike co-op"):
            project = self.api(page, "POST", f"/api/v1/workspaces/{workspace['id']}/projects", {"name": name, "visibility": "restricted"})
            type(self).ids.setdefault("projects", []).append(project["id"])
        type(self).state = page.context.storage_state()

    def sidebar(self, page: Page):
        return page.get_by_role("complementary", name="Sidebar")

    def test_01_the_sidebar_follows_the_drawn_order(self) -> None:
        self.ensure_account()
        for scheme in ("light", "dark"):
            page = self.page(scheme)
            page.goto("/")
            side = self.sidebar(page)
            self.assertEqual(round(side.bounding_box()["width"]), 248)
            expect(side.get_by_role("img", name="Flux")).to_be_visible()
            expect(side.get_by_role("button", name="Collapse sidebar")).to_have_attribute("aria-keyshortcuts", "[")
            expect(side.get_by_role("button", name=re.compile("^New"))).to_have_attribute("aria-keyshortcuts", "C")
            expect(side.get_by_role("button", name="Search", exact=True)).to_be_visible()
            places = side.get_by_role("navigation", name="Places")
            self.assertEqual([text.strip() for text in places.get_by_role("link").all_inner_texts()], ["Home", "Inbox", "Sketchbook"])
            projects = side.get_by_role("navigation", name="Projects")
            # Each project is a letter tile and its name, in the order the sidebar lists them.
            labels = projects.locator(".side__label").all_inner_texts()
            self.assertEqual(projects.locator(".side__pj").all_inner_texts(), [label.strip()[0].upper() for label in labels])
            self.assertEqual(len(labels), 2)
            expect(side.locator("#side-dms").get_by_role("link", name="Messages", exact=True)).to_be_visible()
            # The account row ends with Settings.
            expect(side.locator(".me").get_by_role("link", name="Settings", exact=True)).to_have_attribute("href", "/settings")
            # Nothing works, so no working-agent card claims activity.
            expect(side.locator(".agentlive")).to_have_count(0)
            shot(page, f"340-sidebar-1440-{scheme}")

    def test_02_bracket_collapses_to_the_rail_and_it_is_remembered(self) -> None:
        self.ensure_account()
        page = self.page()
        page.goto("/")
        side = self.sidebar(page)
        expect(side.get_by_role("button", name="Collapse sidebar")).to_be_visible()
        page.keyboard.press("[")
        expect(side.locator(".side--rail")).to_have_count(1)
        self.assertEqual(round(side.bounding_box()["width"]), 64)
        rail = side.locator(".side--rail")
        expect(rail.get_by_role("link", name="Home")).to_have_attribute("aria-current", "page")
        expect(rail.get_by_role("navigation", name="Projects").get_by_role("link")).to_have_count(2)
        shot(page, "340-rail-1440")
        page.reload()
        expect(self.sidebar(page).locator(".side--rail")).to_have_count(1)
        expect(self.sidebar(page).get_by_role("button", name="Expand sidebar")).to_be_visible()
        page.keyboard.press("[")
        expect(self.sidebar(page).locator(".side--rail")).to_have_count(0)
        self.assertEqual(round(self.sidebar(page).bounding_box()["width"]), 248)
        # Typing "[" in a field never collapses the sidebar.
        page.goto(f"/projects/{self.ids['projects'][0]}")
        composer = page.locator("#project-composer")
        composer.focus()
        page.keyboard.type("[")
        expect(composer).to_have_value("[")
        expect(self.sidebar(page).locator(".side--rail")).to_have_count(0)

    def test_03_c_opens_the_create_window_and_a_task_starts_in_the_open_project(self) -> None:
        self.ensure_account()
        page = self.page()
        page.goto("/")
        expect(self.sidebar(page).get_by_role("button", name=re.compile("^New"))).to_be_visible()
        page.locator("body").press("c")
        window = page.get_by_role("dialog", name="Create")
        expect(window).to_be_visible()
        # New opens the one Create window (#345); Project, Message and Private note stay one step away.
        expect(window.get_by_label("Title", exact=True)).to_be_focused()
        other = window.get_by_role("group", name="Create something else")
        self.assertEqual([item.strip() for item in other.get_by_role("button").all_inner_texts()], ["Project", "Message", "Private note"])
        page.keyboard.press("Escape")
        expect(window).to_have_count(0)
        page.goto(f"/projects/{self.ids['projects'][0]}")
        expect(page.get_by_role("heading", level=1, name="Community garden sensors")).to_be_visible()
        page.locator("body").press("c")
        expect(window).to_be_visible()
        expect(window.get_by_role("combobox", name="Project")).to_have_value(self.ids["projects"][0])

    def test_04_g_then_i_goes_to_the_inbox(self) -> None:
        self.ensure_account()
        page = self.page()
        page.goto("/")
        expect(self.sidebar(page).get_by_role("button", name=re.compile("^New"))).to_be_visible()
        page.locator("body").press("g")
        page.locator("body").press("i")
        expect(page).to_have_url(re.compile(r"/inbox$"))
        expect(self.sidebar(page).get_by_role("navigation", name="Places").get_by_role("link", name=re.compile("^Inbox"))).to_have_attribute("aria-current", "page")


if __name__ == "__main__":
    unittest.main()
