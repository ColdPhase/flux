"""Menus, Search and My map show what README §4 and §7 draw (UI audit P3 batch #1376).

- ⌘K with an empty field lists the places last opened ("My tasks", not "Home · Tasks") and Go to Inbox; no assistant row, no sidebar toggle;
- a space's ⋯ has no row for the sidebar (and no key hint);
- My map says "Only you", visibly (beside its title once the map has one);
- the Inbox's ⋯ is there on every Inbox address, an open item or a missing one included.
"""

from __future__ import annotations

import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, Page, expect, sync_playwright

from test_app_shell import ORIGIN, UI_BROWSER, UPSTREAM, start_forwarder

PASSWORD = "a long passphrase for the menu checks"
EMAIL = f"ada.m+{int(time.time() * 1000)}@example.test"
ZERO = "00000000-0000-4000-8000-000000000000"


class MenuDepartures(unittest.TestCase):
    pw = None
    browser: Browser
    state: dict = {}
    project = ""

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=10000)
        context = cls.browser.new_context(service_workers="block", base_url=ORIGIN)
        response = context.request.post("/api/auth/sign-up/email", data={"email": EMAIL, "password": PASSWORD, "name": "Ada Kowalska"}, headers={"origin": ORIGIN})
        assert response.status == 200, response.text()
        headers = {"origin": ORIGIN, "idempotency-key": str(uuid.uuid4())}
        workspace = context.request.post("/api/v1/workspaces", data={"name": "Menus"}, headers=headers).json()["id"]
        cls.project = context.request.post(f"/api/v1/workspaces/{workspace}/projects", data={"name": "Community garden sensors", "visibility": "workspace"},
                                           headers={**headers, "idempotency-key": str(uuid.uuid4())}).json()["id"]
        cls.state = context.storage_state()
        context.close()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self) -> Page:
        context = self.browser.new_context(service_workers="block", base_url=ORIGIN, storage_state=self.state, viewport={"width": 1440, "height": 900})
        self.addCleanup(context.close)
        return context.new_page()

    def test_01_the_empty_command_k_lists_places_and_go_to_inbox_only(self) -> None:
        page = self.page()
        page.goto("/tasks")
        expect(page.get_by_role("heading", name="My tasks").first).to_be_visible()
        page.goto("/")
        expect(page.get_by_role("heading", name="Home", level=1)).to_be_visible()
        page.get_by_role("complementary", name="Sidebar").get_by_role("button", name="Search", exact=True).click()
        palette = page.get_by_role("dialog", name="Search", exact=True)
        expect(palette.get_by_role("option", name="Go to Inbox", exact=True)).to_be_visible()
        expect(palette.get_by_role("option", name="My tasks", exact=True)).to_be_visible()
        for name in (re.compile("Ask my assistant"), re.compile("the sidebar$"), re.compile("Home · Tasks")):
            expect(palette.get_by_role("option", name=name)).to_have_count(0)

    def test_02_a_spaces_more_has_no_sidebar_row(self) -> None:
        page = self.page()
        page.goto(f"/projects/{self.project}")
        page.locator("header.top").get_by_role("button", name="More", exact=True).click()
        menu = page.get_by_role("menu", name="More")
        expect(menu.get_by_role("menuitem", name="Settings")).to_be_visible()
        expect(menu.get_by_role("menuitem", name="Space details")).to_be_visible()
        expect(menu.get_by_role("menuitem", name=re.compile("the sidebar"))).to_have_count(0)
        expect(menu.locator("kbd")).to_have_count(0)

    def test_03_my_map_says_only_you_beside_its_title(self) -> None:
        page = self.page()
        page.goto("/map")
        said = page.locator(".sk-aud")
        expect(said).to_be_visible()
        expect(said).to_have_text(re.compile("Only you"))
        box = said.bounding_box()
        self.assertGreater(box["width"], 40, "the words are drawn, not hidden (they were a 1 px visually-hidden span)")
        self.assertGreater(box["height"], 10)

    def test_04_the_inbox_more_is_on_every_inbox_address(self) -> None:
        page = self.page()
        for path in ("/inbox", f"/inbox/{ZERO}"):
            page.goto(path)
            expect(page.locator("header.top").get_by_role("button", name="More", exact=True)).to_be_visible()


if __name__ == "__main__":
    unittest.main()
