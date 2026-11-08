"""The computer's one-row project header (#340, final design F-026 §4; Focus mode went with F-038, #872).

One row holds the project name, the views as a segmented control, the people and agents, and More. What needs the
person is only in the Inbox: the header carries no "N needs you" (#865).

Runs with the other tests/ui journeys through scripts/check_ui.sh against the running Compose app.
"""

from __future__ import annotations

import os

import json
import re
import time
import unittest
from datetime import datetime, timezone

from playwright.sync_api import Browser, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, UPSTREAM, shot, start_forwarder

PASSWORD = "one calm header"
EMAIL = f"ada.header+{int(time.time() * 1000)}@example.test"
PROJECT = "Community garden sensors"


def soon() -> str:
    """A pause end the server accepts: a few hours ahead."""
    return datetime.fromtimestamp(time.time() + 3 * 3600, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
if UI_BROWSER not in ("chromium", "webkit"):
    raise ValueError(f"FLUX_UI_BROWSER must be chromium or webkit, got {UI_BROWSER!r}")


class ProjectHeader(unittest.TestCase):
    browser: Browser
    state: dict = {}
    ids: dict = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        assert cls.browser.browser_type.name == UI_BROWSER
        print(f"ACTUAL_UI_ENGINE={cls.browser.browser_type.name}")
        expect.set_options(timeout=8000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, scheme: str = "light", viewport: dict | None = None) -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": scheme, "locale": "en-GB", "timezone_id": "Europe/Warsaw",
                         "service_workers": "block", "viewport": viewport or DESKTOP, "device_scale_factor": 1}
        if self.state:
            options["storage_state"] = self.state
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        return context.new_page()

    def api(self, page: Page, method: str, path: str, body: dict | None = None, status: int = 201) -> dict:
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers={"origin": ORIGIN, "content-type": "application/json"},
                                      data=json.dumps(body) if body is not None else None)
        self.assertEqual(response.status, status, response.text())
        return json.loads(response.text()) if response.text() else {}

    def ensure_project(self) -> None:
        if self.state:
            return
        page = self.page()
        page.goto("/sign-up")
        page.get_by_label("Name").fill("Ada Header")
        page.get_by_label("Email").fill(EMAIL)
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        workspace = self.api(page, "POST", "/api/v1/workspaces", {"name": "Garden sensors"})
        project = self.api(page, "POST", f"/api/v1/workspaces/{workspace['id']}/projects", {"name": PROJECT, "visibility": "restricted"})
        type(self).ids["project"] = project["id"]
        type(self).state = page.context.storage_state()

    def header(self, page: Page):
        return page.locator("header.top")

    def test_01_one_row_name_views_people_and_more(self) -> None:
        self.ensure_project()
        for scheme in ("light", "dark"):
            page = self.page(scheme)
            page.goto(f"/projects/{self.ids['project']}")
            header = self.header(page)
            expect(header.get_by_role("heading", level=1, name=PROJECT)).to_be_visible()
            views = header.get_by_role("navigation", name="Space views")
            self.assertEqual([text.strip() for text in views.get_by_role("link").all_inner_texts()], ["Conversation", "Map", "Tasks", "Wiki"])
            expect(views.get_by_role("link", name="Conversation")).to_have_attribute("aria-current", "page")
            # One row: the views sit beside the name, and no second toolbar row follows the header.
            name_box = header.get_by_role("heading", level=1).bounding_box()
            views_box = views.bounding_box()
            self.assertLess(abs((name_box["y"] + name_box["height"] / 2) - (views_box["y"] + views_box["height"] / 2)), 4)
            self.assertLessEqual(header.bounding_box()["height"], 72)
            expect(page.locator(".app__main > .views, .app__main > .state-row")).to_have_count(0)
            # The current view is a raised pill that covers its whole tab.
            current = views.get_by_role("link", name="Conversation").bounding_box()
            pill = views.locator(".ui-tabs__indicator").bounding_box()
            self.assertAlmostEqual(pill["width"], current["width"], delta=1.5)
            # People and agents as faces, which open the space's settings.
            faces = header.get_by_role("button", name=re.compile("who can see this space$"))
            expect(faces.locator(".ui-avatar")).to_have_count(1)
            # What needs Ada is in the Inbox alone: no chip in the header claims it (#865).
            expect(header.get_by_role("button", name=re.compile("needs you$"))).to_have_count(0)
            shot(page, f"340-header-1440-{scheme}")
        page.get_by_role("link", name="Tasks", exact=True).click()
        expect(views.get_by_role("link", name="Tasks")).to_have_attribute("aria-current", "page")
        faces.click()
        # The faces open the space's settings, where its people are (F-037).
        expect(page.get_by_role("heading", name="Space settings")).to_be_visible()

    def test_02_more_lists_details_and_the_sidebar_with_keys(self) -> None:
        self.ensure_project()
        page = self.page()
        page.goto(f"/projects/{self.ids['project']}")
        more = self.header(page).get_by_role("button", name="More", exact=True)
        more.click()
        menu = page.get_by_role("menu", name="More")
        # "Who can see this" is in More only where the header has no room for the faces (a narrow main column).
        items = menu.locator("[role^=menuitem]:visible")
        self.assertEqual([text.strip() for text in items.locator("span").all_inner_texts()], ["Settings", "Space details", "Hide the sidebar"])
        # Each key shows next to its action (S18) and is announced as its shortcut.
        self.assertEqual([items.nth(index).get_attribute("aria-keyshortcuts") for index in range(items.count())], [None, None, "["])
        self.assertEqual(items.locator("kbd").all_inner_texts(), ["["])
        expect(menu.get_by_role("menuitem", name="Settings")).to_be_focused()
        page.keyboard.press("Escape")
        expect(menu).to_have_count(0)
        expect(more).to_be_focused()
        more.click()
        page.get_by_role("menu", name="More").get_by_role("menuitem", name="Details").click()
        expect(page.get_by_role("complementary", name="Details")).to_be_visible()


if __name__ == "__main__":
    unittest.main()
