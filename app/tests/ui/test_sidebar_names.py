"""Sidebar project rows (Studio 11.6, #136): two projects with one name show their workspace on a
compact second line, so the name stays readable and even identical long names stay distinguishable
(independent delta reviews of #184, B3 and B2).

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
  const l = label.getBoundingClientRect(), w = sub.getBoundingClientRect(), r = row.getBoundingClientRect();
  return { truncated: label.scrollWidth > label.clientWidth + 0.5, workspace: sub.textContent, workspaceCut: sub.scrollWidth > sub.clientWidth + 0.5,
    belowName: w.top >= l.bottom - 1, height: r.height, fontSize: parseFloat(getComputedStyle(sub).fontSize), title: row.title };
})"""
WORKSPACES = ("Northern design cooperative", "Lamp studio", "Lamp studio Berlin")


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

    def test_01_the_name_stays_whole_and_the_workspace_line_tells_identical_names_apart(self) -> None:
        page = self.page()
        page.goto("/sign-up")
        page.get_by_label("Name").fill("Ada Names")
        page.get_by_label("Email").fill(EMAIL)
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        type(self).state = page.context.storage_state()
        for workspace in WORKSPACES:
            ws = self.api(page, "POST", "/api/v1/workspaces", {"name": workspace})
            for name in (SHORT, LONG):
                self.api(page, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": name, "visibility": "restricted"})
        for phone, dark in ((False, False), (True, False), (False, True), (True, True)):
            view = self.page(phone=phone, dark=dark)
            view.goto("/")
            if phone:
                view.get_by_role("button", name="Open navigation").tap()
            expect(view.locator(".side__project .side__sub").first).to_be_visible()
            short, long = view.evaluate(ROWS, SHORT), view.evaluate(ROWS, LONG)
            self.assertEqual([len(short), len(long)], [3, 3], "every project is listed")
            for row in short + long:
                self.assertTrue(row["belowName"], f"the workspace is its own line under the name: {row}")
                self.assertFalse(row["workspaceCut"], f"the whole workspace name is visible: {row}")
                self.assertGreaterEqual(row["fontSize"], 10, "the workspace line keeps the metadata text size (--fs-xs)")
                self.assertGreaterEqual(row["height"], 44 if phone else 40, f"one comfortable row: {row}")
                self.assertIn(row["workspace"], row["title"], "the full name and workspace are the row's title")
            for row in short:
                self.assertFalse(row["truncated"], f"a short name is never cut: {row}")
            # Identical long names differ by what is visible, not only by a hover title.
            self.assertEqual(sorted(row["workspace"] for row in long), sorted(WORKSPACES))
            shot(view, f"sidebar-same-names-{'phone' if phone else 'desktop'}{'-dark' if dark else ''}")
            if phone and not dark:
                # The longer list still scrolls inside the drawer: Messages below it stays reachable.
                drawer = view.get_by_role("dialog")
                messages = drawer.get_by_text("Messages", exact=True)
                messages.scroll_into_view_if_needed()
                expect(messages).to_be_in_viewport()
        # A two-line row as the current project keeps its marker and its workspace line.
        current = self.page()
        current.goto("/")
        current.locator('.side__project[title="Gesture lamp · Lamp studio Berlin"]').click()
        row = current.locator(".side__project.is-open")
        expect(row).to_contain_text("Lamp studio Berlin")
        marker = row.evaluate("el => { const r = el.getBoundingClientRect(), b = getComputedStyle(el, '::before'); return { top: parseFloat(b.top), height: parseFloat(b.height), row: r.height }; }")
        self.assertLessEqual(marker["top"] + marker["height"], marker["row"], f"the marker sits within the row: {marker}")
        shot(current, "sidebar-same-names-current-desktop")


if __name__ == "__main__":
    unittest.main()
