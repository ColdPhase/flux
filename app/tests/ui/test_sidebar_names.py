"""Sidebar project rows (Studio 11.6, #136): two projects with one name show their workspace, and
that label gives way before the project name does (independent delta review of #184, B3).

Runs with the other tests/ui journeys through scripts/check_ui.sh against the running Compose app.
"""

from __future__ import annotations

import json
import time
import unittest

from playwright.sync_api import Browser, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

PASSWORD = "two lamps one name"
EMAIL = f"ada.names+{int(time.time() * 1000)}@example.test"
SHORT = "Gesture lamp"
LONG = "Gesture lamp for the reading corner upstairs"
ROWS = """(name) => [...document.querySelectorAll('.side__project')].filter((row) => row.querySelector('.side__label').textContent === name).map((row) => {
  const label = row.querySelector('.side__label'), sub = row.querySelector('.side__sub');
  return { truncated: label.scrollWidth > label.clientWidth + 0.5, sub: sub ? sub.getBoundingClientRect().width : 0, title: row.title };
})"""


class SidebarNames(unittest.TestCase):
    browser: Browser
    state: dict = {}

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

    def page(self, *, phone: bool = False) -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw"}
        options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True) if phone else options.update(viewport=DESKTOP, device_scale_factor=1)
        if self.state:
            options["storage_state"] = self.state
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        return context.new_page()

    def api(self, page: Page, method: str, path: str, body: dict) -> dict:
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers={"origin": ORIGIN, "content-type": "application/json"}, data=json.dumps(body))
        self.assertEqual(response.status, 201, response.text())
        return json.loads(response.text())

    def test_01_the_project_name_stays_whole_and_the_workspace_label_gives_way(self) -> None:
        page = self.page()
        page.goto("/sign-up")
        page.get_by_label("Name").fill("Ada Names")
        page.get_by_label("Email").fill(EMAIL)
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        type(self).state = page.context.storage_state()
        for workspace in ("Northern design cooperative", "Lamp studio"):
            ws = self.api(page, "POST", "/api/v1/workspaces", {"name": workspace})
            for name in (SHORT, LONG):
                self.api(page, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": name, "visibility": "restricted"})
        for phone in (False, True):
            view = self.page(phone=phone)
            view.goto("/")
            if phone:
                view.get_by_role("button", name="Open navigation").tap()
            expect(view.locator(".side__project .side__sub").first).to_be_visible()
            short = view.evaluate(ROWS, SHORT)
            self.assertEqual(len(short), 2, "both projects are listed")
            for row in short:
                self.assertFalse(row["truncated"], f"a short name is never cut for its workspace label: {row}")
                self.assertGreaterEqual(row["sub"], 20, f"the workspace label keeps a few letters: {row}")
                self.assertIn(SHORT, row["title"], "the full name and workspace are the row's title")
            for row in view.evaluate(ROWS, LONG):
                self.assertGreaterEqual(row["sub"], 20, f"a long name leaves the workspace label a few letters: {row}")
            shot(view, f"sidebar-same-names-{'phone' if phone else 'desktop'}")


if __name__ == "__main__":
    unittest.main()
