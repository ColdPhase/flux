"""Browser tests for Home's "New messages" (#1548, founder direction, Hubert, 2026-11-19).

Home shows the conversations that have something new: every space and every direct message the person is in with a message from someone else they
have not read, newest first, muted places left out. A row opens the conversation; reading it takes the row away. Nothing new means no part at all.
The Inbox does not change: a message that names nobody is no item of it. Checked at 1440x900 and 390x844 (touch), light and dark.
Screenshots (home-new-messages-*.png) go to FLUX_UI_SCREENSHOTS when set.
"""

from __future__ import annotations

import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, shot, start_forwarder

PASSWORD = "a calm home for the garden"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ada": ("Ada Kowalska", f"ada.nm+{STAMP}@example.test"),
    "jonas": ("Jonas Berg", f"jonas.nm+{STAMP}@example.test"),
    "maja": ("Maja Wiśniewska", f"maja.nm+{STAMP}@example.test"),
}
SPACES = ["Community garden sensors", "Tool library", "Rain barrel monitor"]


class HomeNewMessages(unittest.TestCase):
    """Tests run in name order and share the people, the spaces and what was written in them."""

    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}
    contexts: dict[str, BrowserContext] = {}
    workspace_id = ""
    spaces: dict[str, str] = {}
    dm_id = ""

    @classmethod
    def post(cls, who: str, path: str, body: dict | None = None, ok: tuple[int, ...] = (200, 201, 202)) -> dict:
        response = cls.contexts[who].request.post(path, data=body or {}, headers={"origin": ORIGIN})
        assert response.status in ok, f"{path}: {response.status} {response.text()}"
        return response.json() if response.text() else {}

    @classmethod
    def say(cls, who: str, space: str, body: str) -> str:
        made = cls.post(who, f"/api/v1/projects/{cls.spaces[space]}/conversations", {"body": body, "clientMessageId": str(uuid.uuid4())})
        return made["messages"][0]["id"]

    @classmethod
    def mute(cls, who: str, kind: str, place_id: str, muted: bool) -> None:
        response = cls.contexts[who].request.put("/api/v1/notification-preferences/mutes", data={"type": kind, "id": place_id, "muted": muted}, headers={"origin": ORIGIN})
        assert response.status == 200, response.text()

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=15000)
        for key, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(base_url=ORIGIN)
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.contexts[key] = context
        cls.workspace_id = cls.post("ada", "/api/v1/workspaces", {"name": "Riverside Makers"})["id"]
        for key in ("jonas", "maja"):
            cls.post("ada", f"/api/v1/workspaces/{cls.workspace_id}/members", {"email": PEOPLE[key][1], "role": "member"})
        for name in SPACES:
            cls.spaces[name] = cls.post("ada", f"/api/v1/workspaces/{cls.workspace_id}/projects", {"name": name, "visibility": "workspace"})["id"]
        for key, context in cls.contexts.items():
            cls.states[key] = context.storage_state()

    @classmethod
    def tearDownClass(cls) -> None:
        for context in cls.contexts.values():
            context.close()
        cls.browser.close()
        cls.pw.stop()

    def page(self, *, phone: bool = False, dark: bool = False) -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": "dark" if dark else "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw", "storage_state": self.states["ada"]}
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=DESKTOP, device_scale_factor=1)
        context = self.browser.new_context(service_workers="block", **options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    @staticmethod
    def news(page: Page):
        return page.locator("[data-new-messages]")

    def rows(self, page: Page):
        return self.news(page).locator("[data-new-message]")

    # ---------------------------------------------------------------- nothing new: Home as it was

    def test_01_nothing_new_is_no_part_at_all(self) -> None:
        page = self.page()
        page.goto("/")
        expect(page.get_by_role("region", name=re.compile("^Waiting for you"))).to_be_visible()
        page.wait_for_timeout(1500)
        expect(self.news(page)).to_have_count(0)
        expect(page.get_by_role("heading", name=re.compile("^New messages"))).to_have_count(0)

    # ---------------------------------------------------------------- the rows

    def test_02_a_space_and_a_direct_message_with_news_are_rows_newest_first(self) -> None:
        self.say("jonas", "Community garden sensors", "The soil probes arrived this morning")
        time.sleep(0.05)
        self.say("jonas", "Tool library", "Who has the planer?")
        self.__class__.dm_id = self.post("maja", f"/api/v1/workspaces/{self.workspace_id}/dms", {"participantIds": [self.ids["ada"]]})["id"]
        self.post("maja", f"/api/v1/dms/{self.dm_id}/messages", {"body": "Lunch at the harbour on Friday?", "clientMessageId": str(uuid.uuid4())})
        page = self.page()
        page.goto("/")
        news = self.news(page)
        expect(news.get_by_role("heading", name=re.compile(r"^New messages\s*3$"))).to_be_visible()
        rows = self.rows(page)
        expect(rows).to_have_count(3)
        # Newest first: the direct message, then the Tool library, then the garden.
        expect(rows.nth(0)).to_contain_text("Maja Wiśniewska")
        expect(rows.nth(0)).to_contain_text("Lunch at the harbour on Friday?")
        expect(rows.nth(1)).to_contain_text("Tool library")
        expect(rows.nth(1)).to_contain_text("Jonas: Who has the planer?")
        expect(rows.nth(2)).to_contain_text("Community garden sensors")
        expect(rows.nth(2)).to_contain_text("Jonas: The soil probes arrived this morning")
        # Each row ends in its time and the unread dot, not an arrow, and its name is read with ", new messages".
        expect(rows.nth(1).locator("time")).to_be_visible()
        expect(rows.nth(1).locator(".home__dot")).to_be_visible()
        expect(rows.nth(1).get_by_text(", new messages")).to_be_attached()
        # It stands under Waiting for you, before Continue.
        order = page.evaluate("""() => [...document.querySelectorAll('.home > section')].map((s) => s.className)""")
        self.assertLess(order.index("home__need"), order.index("home__news"), "New messages is under Waiting for you")
        shot(page, "home-new-messages-computer-light")

    def test_03_the_inbox_does_not_change(self) -> None:
        queue = self.contexts["ada"].request.get("/api/v1/needs-you").json()
        self.assertEqual(queue["count"], 0, "plain messages are nothing that needs Ada")
        page = self.page()
        page.goto("/")
        expect(page.get_by_role("heading", name=re.compile(r"^Waiting for you$"))).to_be_visible()
        expect(page.get_by_text("Nothing is waiting for you.")).to_be_visible()
        expect(self.rows(page)).to_have_count(3)

    # ---------------------------------------------------------------- muted, read, live

    def test_04_a_muted_place_is_left_out_and_comes_back_when_unmuted_live(self) -> None:
        page = self.page()
        page.goto("/")
        expect(self.rows(page)).to_have_count(3)
        self.mute("ada", "project", self.spaces["Tool library"], True)
        expect(self.rows(page)).to_have_count(2)
        expect(self.news(page)).not_to_contain_text("Tool library")
        self.mute("ada", "dm", self.dm_id, True)
        expect(self.rows(page)).to_have_count(1)
        expect(self.news(page).get_by_role("heading", name=re.compile(r"^New messages\s*1$"))).to_be_visible()
        self.mute("ada", "dm", self.dm_id, False)
        self.mute("ada", "project", self.spaces["Tool library"], False)
        expect(self.rows(page)).to_have_count(3)

    def test_05_reading_a_conversation_takes_its_row_away_and_a_new_message_brings_it_back_live(self) -> None:
        page = self.page()
        page.goto("/")
        expect(self.rows(page)).to_have_count(3)
        # A click opens the direct message; reading it removes it from Home.
        self.rows(page).filter(has_text="Maja Wiśniewska").click()
        expect(page).to_have_url(re.compile(rf"/dm/{self.dm_id}"))
        expect(page.get_by_text("Lunch at the harbour on Friday?").first).to_be_visible()
        page.wait_for_timeout(1500)
        page.get_by_role("link", name="Home").first.click()
        expect(page.get_by_role("heading", level=2, name=re.compile(r"^Good (morning|afternoon|evening), Ada$"))).to_be_visible()
        expect(self.rows(page)).to_have_count(2)
        expect(self.news(page)).not_to_contain_text("Maja Wiśniewska")
        # The space too: opened and left, it is read.
        self.rows(page).filter(has_text="Community garden sensors").click()
        expect(page).to_have_url(re.compile(rf"/projects/{self.spaces['Community garden sensors']}"))
        expect(page.get_by_text("The soil probes arrived this morning").first).to_be_visible()
        page.wait_for_timeout(1500)
        page.get_by_role("link", name="Home").first.click()
        expect(self.rows(page)).to_have_count(1)
        expect(self.news(page)).to_contain_text("Tool library")
        # Live: Home stays open while a message arrives in the space that was read, and its row returns at the top.
        self.say("jonas", "Community garden sensors", "Second delivery on Monday")
        expect(self.rows(page)).to_have_count(2, timeout=20000)
        expect(self.rows(page).nth(0)).to_contain_text("Jonas: Second delivery on Monday")
        # And a direct message that arrives while Home is open.
        self.post("maja", f"/api/v1/dms/{self.dm_id}/messages", {"body": "Never mind, Thursday works", "clientMessageId": str(uuid.uuid4())})
        expect(self.rows(page)).to_have_count(3, timeout=20000)
        expect(self.rows(page).nth(0)).to_contain_text("Never mind, Thursday works")

    # ---------------------------------------------------------------- at most five rows, the phone, dark

    def test_06_more_than_five_show_five_and_Show_all(self) -> None:
        for index in range(4):
            name = f"Extra space {index + 1}"
            self.spaces[name] = self.post("ada", f"/api/v1/workspaces/{self.workspace_id}/projects", {"name": name, "visibility": "workspace"})["id"]
            self.say("jonas", name, f"Note {index + 1} for the extra space")
        page = self.page()
        page.goto("/")
        news = self.news(page)
        expect(news.get_by_role("heading", name=re.compile(r"^New messages\s*7$"))).to_be_visible()
        expect(self.rows(page)).to_have_count(5)
        show_all = news.get_by_role("link", name="Show all")
        expect(show_all).to_be_visible()
        show_all.click()
        expect(page).to_have_url(re.compile(r"/projects$"))

    def test_07_the_phone_and_the_dark_theme(self) -> None:
        for dark in (False, True):
            page = self.page(phone=True, dark=dark)
            page.goto("/")
            expect(self.news(page)).to_be_visible()
            expect(self.rows(page)).to_have_count(5)
            # My tasks and My map keep their place under the waiting items; New messages follows them.
            order = page.evaluate("""() => [...document.querySelectorAll('.home > section, .home > ul')].map((s) => s.className.split(' ')[0])""")
            self.assertLess(order.index("home__places"), order.index("home__news"))
            overflow = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
            self.assertLessEqual(overflow, 0, "no sideways scroll")
            for row in self.rows(page).all():
                box = row.bounding_box()
                assert box and box["height"] >= 44, "a row is a 44 px touch target"
            shot(page, f"home-new-messages-phone-{'dark' if dark else 'light'}")
        page = self.page(dark=True)
        page.goto("/")
        expect(self.rows(page)).to_have_count(5)
        shot(page, "home-new-messages-computer-dark")


if __name__ == "__main__":
    unittest.main()
