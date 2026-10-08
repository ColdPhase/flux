"""The computer's one-row project header and focus mode (#340, final design F-026 §4).

One row holds the project name, the five views as a segmented control, "N needs you", the people
and agents, and More. Focus (F) keeps the name, the view and the way out, folds the sidebar to its
rail, and pauses push and email on the server until its time; F again resumes.

Runs with the other tests/ui journeys through scripts/check_ui.sh against the running Compose app.
"""

from __future__ import annotations

import json
import re
import time
import unittest
from datetime import datetime

from playwright.sync_api import Browser, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, UPSTREAM, shot, start_forwarder

PASSWORD = "one calm header"
EMAIL = f"ada.header+{int(time.time() * 1000)}@example.test"
PROJECT = "Community garden sensors"


class ProjectHeader(unittest.TestCase):
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

    def tearDown(self) -> None:
        # Never leave a pause behind for the next test.
        if self.state:
            page = self.page()
            self.api(page, "PATCH", "/api/v1/notification-preferences", {"pause": {"until": None}}, status=200)

    def test_01_one_row_name_views_people_and_more(self) -> None:
        self.ensure_project()
        for scheme in ("light", "dark"):
            page = self.page(scheme)
            page.goto(f"/projects/{self.ids['project']}")
            header = self.header(page)
            expect(header.get_by_role("heading", level=1, name=PROJECT)).to_be_visible()
            views = header.get_by_role("navigation", name="Project views")
            self.assertEqual([text.strip() for text in views.get_by_role("link").all_inner_texts()], ["Conversation", "Map", "Tasks", "Wiki", "Agents"])
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
            # People and agents as faces, which open "Who can see this".
            faces = header.get_by_role("button", name=re.compile("who can see this project$"))
            expect(faces.locator(".ui-avatar")).to_have_count(1)
            # Nothing needs Ada in a new project, so no chip claims it.
            expect(header.get_by_role("button", name=re.compile("needs you$"))).to_have_count(0)
            shot(page, f"340-header-1440-{scheme}")
        page.get_by_role("link", name="Tasks").click()
        expect(views.get_by_role("link", name="Tasks")).to_have_attribute("aria-current", "page")
        faces.click()
        expect(page.get_by_role("complementary", name="Details").get_by_role("region", name="Who can see this")).to_be_visible()

    def test_02_more_lists_details_focus_and_the_sidebar_with_keys(self) -> None:
        self.ensure_project()
        page = self.page()
        page.goto(f"/projects/{self.ids['project']}")
        more = self.header(page).get_by_role("button", name="More", exact=True)
        more.click()
        menu = page.get_by_role("menu", name="More")
        items = menu.locator("[role^=menuitem]")
        self.assertEqual([text.strip() for text in items.locator("span").all_inner_texts()], ["Details", "What matters", "Focus", "Hide the sidebar"])
        # Each key shows next to its action (S18) and is announced as its shortcut.
        self.assertEqual([items.nth(index).get_attribute("aria-keyshortcuts") for index in range(items.count())], [None, None, "F", "["])
        self.assertEqual(items.locator("kbd").all_inner_texts(), ["F", "["])
        expect(menu.get_by_role("menuitemcheckbox", name="Focus")).to_have_attribute("aria-checked", "false")
        expect(menu.get_by_role("menuitem", name="Details")).to_be_focused()
        page.keyboard.press("Escape")
        expect(menu).to_have_count(0)
        expect(more).to_be_focused()
        more.click()
        page.get_by_role("menu", name="More").get_by_role("menuitem", name="Details").click()
        expect(page.get_by_role("complementary", name="Details")).to_be_visible()

    def test_03_f_turns_focus_on_and_off_and_the_server_holds_notifications(self) -> None:
        self.ensure_project()
        page = self.page()
        page.goto(f"/projects/{self.ids['project']}")
        header = self.header(page)
        expect(header.get_by_role("navigation", name="Project views")).to_be_visible()
        page.locator("body").press("f")
        pill = header.get_by_role("button", name=re.compile(r"^Focus · notifications paused until \d\d:\d\d"))
        expect(pill).to_be_visible()
        expect(pill).to_have_attribute("aria-keyshortcuts", "F")
        # The header keeps the name and the view; the sidebar folds to its rail.
        expect(header.get_by_role("navigation", name="Project views")).to_have_count(0)
        expect(header.get_by_text("Conversation", exact=True)).to_be_visible()
        expect(header.get_by_role("button", name="More", exact=True)).to_have_count(0)
        side = page.get_by_role("complementary", name="Sidebar")
        expect(side.locator(".side--rail")).to_have_count(1)
        # The words are true: the server holds push and email until the shown time.
        prefs = self.api(page, "GET", "/api/v1/notification-preferences", status=200)
        until = datetime.fromisoformat(prefs["pause"]["until"].replace("Z", "+00:00"))
        shown = re.search(r"\d\d:\d\d", pill.inner_text()).group()
        local = page.evaluate("iso => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })", prefs["pause"]["until"])
        self.assertEqual(shown, local)
        self.assertEqual((until.minute, until.second), (0, 0), "a focus ends on a full hour")
        minutes = (until.timestamp() - time.time()) / 60
        self.assertTrue(30 <= minutes <= 91, minutes)
        shot(page, "340-focus-1440-light")
        # Typing "f" in the composer never toggles focus.
        composer = page.locator("#project-composer")
        composer.focus()
        page.keyboard.type("f")
        expect(composer).to_have_value("f")
        expect(pill).to_be_visible()
        composer.fill("")
        composer.blur()
        page.keyboard.press("f")
        expect(pill).to_have_count(0)
        expect(header.get_by_role("navigation", name="Project views")).to_be_visible()
        expect(side.locator(".side--rail")).to_have_count(0)
        self.assertIsNone(self.api(page, "GET", "/api/v1/notification-preferences", status=200)["pause"]["until"])

    def test_04_a_pause_shows_in_notification_settings_and_resumes_there(self) -> None:
        self.ensure_project()
        page = self.page()
        page.goto(f"/projects/{self.ids['project']}")
        expect(self.header(page).get_by_role("navigation", name="Project views")).to_be_visible()
        page.locator("body").press("f")
        expect(self.header(page).get_by_role("button", name=re.compile("^Focus"))).to_be_visible()
        # A phone reads the same pause (its own header has no F key).
        phone = self.page(viewport={"width": 390, "height": 844})
        phone.goto("/settings/notifications")
        note = phone.get_by_role("status").filter(has_text="Focus: push and email are paused until")
        expect(note).to_be_visible()
        note.get_by_role("button", name="Resume now").click()
        expect(note).to_have_count(0)
        # The settings page saves in the background; the server answers with the pause gone.
        for _ in range(40):
            if self.api(phone, "GET", "/api/v1/notification-preferences", status=200)["pause"]["until"] is None:
                break
            phone.wait_for_timeout(100)
        self.assertIsNone(self.api(phone, "GET", "/api/v1/notification-preferences", status=200)["pause"]["until"])
        # The computer learns it when it is used again.
        page.evaluate("window.dispatchEvent(new Event('focus'))")
        expect(self.header(page).get_by_role("button", name=re.compile("^Focus"))).to_have_count(0)


if __name__ == "__main__":
    unittest.main()
