"""Sidebar space rows (Studio 11.6, #136; F-037): one flat list of spaces, one line each, with no workspace or group line
(one Flux is one company). A short name stays whole; a long one is cut with its full name as the row's title.

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
  const label = row.querySelector('.side__label'), r = row.getBoundingClientRect();
  return { truncated: label.scrollWidth > label.clientWidth + 0.5, sub: !!row.querySelector('.side__sub'), height: r.height, title: row.title };
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

    def page(self, *, phone: bool = False, dark: bool = False) -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": "dark" if dark else "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw"}
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

    def test_01_one_line_per_space_with_no_workspace_line(self) -> None:
        page = self.page()
        page.goto("/sign-up")
        page.get_by_label("Name").fill("Ada Names")
        page.get_by_label("Email").fill(EMAIL)
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        type(self).state = page.context.storage_state()
        ws = self.api(page, "POST", "/api/v1/workspaces", {"name": "Northern design cooperative"})
        for name in (SHORT, LONG):
            self.api(page, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": name, "visibility": "restricted"})
        for dark in (False, True):
            view = self.page(dark=dark)
            view.goto("/")
            side = view.get_by_role("navigation", name="Spaces")
            expect(side.get_by_role("link", name=SHORT, exact=True)).to_be_visible()
            short, long = view.evaluate(ROWS, SHORT), view.evaluate(ROWS, LONG)
            self.assertEqual([len(short), len(long)], [1, 1], "every space is listed once")
            for row in short + long:
                self.assertFalse(row["sub"], f"no workspace line under the name: {row}")
                self.assertGreaterEqual(row["height"], 32, f"one comfortable row: {row}")
            self.assertFalse(short[0]["truncated"], "a short name is never cut")
            self.assertEqual(long[0]["title"], LONG, "the full name is the row's title")
            expect(view.locator(".side__sub")).to_have_count(0)
            shot(view, f"sidebar-spaces-desktop{'-dark' if dark else ''}")

if __name__ == "__main__":
    unittest.main()
