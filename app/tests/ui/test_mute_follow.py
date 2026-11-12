"""Browser tests for muting a place and following a thread from where they are (#1249).

Runs with the other tests/ui modules through scripts/check_ui.sh (FLUX_UI_BROWSER selects chromium, the default, or webkit). Kai creates
real activity for Ada through the public API: a space with a thread she started and one she did not, a second space, and a direct
message. Ada mutes and unmutes a space from its ⋯ menu and a conversation from its header menu, sees the small muted mark and the quiet
count in the sidebar, follows and unfollows a thread from its header, and sees each change in her other open tab without a reload. Every
step is checked against the API, on a computer and on a phone, in light and dark. Screenshots (mute-follow-*) go to FLUX_UI_SCREENSHOTS.
"""

from __future__ import annotations

import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, start_forwarder
from test_settings import UI_BROWSER, assert_touch_target, shot

PASSWORD = "a calm place to mute"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ada": ("Ada Kowalska", f"ada.m+{STAMP}@example.test"),
    "kai": ("Kai Tanaka", f"kai.m+{STAMP}@example.test"),
}
STILL_ARRIVES = "Mentions and questions to you still arrive."


class MuteAndFollowJourney(unittest.TestCase):
    """Tests share the accounts, the workspace and the activity; each leaves nothing muted and every thread as it found it."""

    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}
    workspace_id = ""
    project_id = ""
    other_project_id = ""
    dm_id = ""
    own_thread = ""
    kai_thread = ""

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=15000)
        contexts: dict[str, BrowserContext] = {}
        for key, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(base_url=ORIGIN, service_workers="block")
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.states[key] = context.storage_state()
            contexts[key] = context

        def post(who: str, path: str, body: dict) -> dict:
            response = contexts[who].request.post(path, data=body, headers={"origin": ORIGIN})
            assert response.status in (200, 201), f"{path}: {response.status} {response.text()}"
            return response.json()

        cls.workspace_id = post("ada", "/api/v1/workspaces", {"name": "Riverside Makers"})["id"]
        post("ada", f"/api/v1/workspaces/{cls.workspace_id}/members", {"email": PEOPLE["kai"][1], "role": "member"})
        cls.project_id = post("ada", f"/api/v1/workspaces/{cls.workspace_id}/projects", {"name": "Garden sensors", "visibility": "workspace"})["id"]
        cls.other_project_id = post("ada", f"/api/v1/workspaces/{cls.workspace_id}/projects", {"name": "Tool library", "visibility": "workspace"})["id"]
        opened = lambda who, project, body: post(who, f"/api/v1/projects/{project}/conversations", {"body": body, "clientMessageId": str(uuid.uuid4())})  # noqa: E731
        message = lambda who, conversation, body: post(who, f"/api/v1/conversations/{conversation}/messages", {"body": body, "clientMessageId": str(uuid.uuid4())})  # noqa: E731
        own = opened("ada", cls.project_id, "Wiring plan for the east beds")
        cls.own_thread = own["id"]
        message("kai", cls.own_thread, "I pulled the 3 m cable, but the connectors don't fit the new probes.")
        # A thread Ada did not start, write in or get mentioned in: she does not follow it until she chooses to.
        cls.kai_thread = opened("kai", cls.project_id, "Cable lengths for the second bed are in the shed")["id"]
        message("kai", cls.kai_thread, "The long reels are on the left shelf.")
        opened("kai", cls.other_project_id, "The tool library opens at nine on Saturday")
        cls.dm_id = post("kai", f"/api/v1/workspaces/{cls.workspace_id}/dms", {"participantIds": [cls.ids["ada"]]})["id"]
        post("kai", f"/api/v1/dms/{cls.dm_id}/messages", {"body": "Can you bring the soldering iron tomorrow?", "clientMessageId": str(uuid.uuid4())})
        for context in contexts.values():
            context.close()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    # ------------------------------------------------------------------ helpers

    def context(self, who: str, *, phone: bool = False, dark: bool = False) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "color_scheme": "dark" if dark else "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw", "storage_state": self.states[who], "service_workers": "block"}
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=DESKTOP, device_scale_factor=1)
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        return context

    def page(self, who: str = "ada", **kwargs) -> Page:
        page = self.context(who, **kwargs).new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def api(self, page: Page, method: str, path: str, body: dict | None = None) -> dict:
        response = page.request.fetch(path, method=method, data=body, headers={"origin": ORIGIN})
        self.assertLess(response.status, 300, response.text())
        return response.json() if response.text() else {}

    def muted(self, page: Page) -> list[dict]:
        return self.api(page, "GET", "/api/v1/notification-preferences/mutes")["muted"]

    def settled(self, read, expected, what: str):
        """The screen answers at once and the save follows it: waits until the stored state is what the person chose."""
        found = read()
        for _ in range(60):
            if found == expected:
                return
            time.sleep(0.25)
            found = read()
        self.assertEqual(found, expected, what)

    def muted_ids(self, page: Page) -> list[tuple[str, str]]:
        return [(place["type"], place["id"]) for place in self.muted(page)]

    def following(self, page: Page, thread: str) -> bool:
        return self.api(page, "GET", f"/api/v1/notification-preferences/follows/{thread}")["following"]

    def set_mute(self, page: Page, kind: str, place: str, on: bool) -> None:
        self.api(page, "PUT", "/api/v1/notification-preferences/mutes", {"type": kind, "id": place, "muted": on})

    def set_follow(self, page: Page, thread: str, on: bool) -> None:
        self.api(page, "PUT", "/api/v1/notification-preferences/follows", {"conversationId": thread, "following": on})

    def clean_after(self, page: Page) -> None:
        """Leaves nothing muted and both threads as Ada first found them, whatever the test did."""
        def restore() -> None:
            for kind, place in (("project", self.project_id), ("project", self.other_project_id), ("dm", self.dm_id)):
                self.set_mute(page, kind, place, False)
            self.set_follow(page, self.own_thread, True)
            self.set_follow(page, self.kai_thread, False)
        self.addCleanup(restore)

    def kai_posts(self, *projects: str) -> None:
        """Something new in each space since Ada last left it: her return point moves when she leaves a space she opened."""
        context = self.context("kai")
        for project in projects:
            response = context.request.post(f"/api/v1/projects/{project}/conversations", headers={"origin": ORIGIN},
                                            data={"body": f"Update {uuid.uuid4().hex[:6]}: the soil probes are calibrated", "clientMessageId": str(uuid.uuid4())})
            self.assertEqual(response.status, 201, response.text())

    def more(self, page: Page) -> "tuple[object, object]":
        button = page.locator("header").get_by_role("button", name="More", exact=True)
        menu = page.get_by_role("menu", name="More")
        return button, menu

    def sidebar_space(self, page: Page, name: str):
        return page.locator(".side__project", has_text=name)

    # ------------------------------------------------------------------ a space's ⋯ menu, on a computer

    def test_01_mute_and_unmute_a_space_from_its_menu(self) -> None:
        page = self.page()
        self.clean_after(page)
        page.goto(f"/projects/{self.project_id}")
        button, menu = self.more(page)
        row = self.sidebar_space(page, "Garden sensors")
        expect(row.locator("[data-muted-mark]")).to_have_count(0)
        button.click()
        mute = menu.get_by_role("menuitem", name=re.compile(r"^Mute space"))
        expect(mute).to_be_visible()
        expect(mute).to_contain_text(STILL_ARRIVES)
        self.assertEqual(mute.get_attribute("aria-keyshortcuts"), None, "a row with no key")
        mute.click()
        expect(menu).to_have_count(0)
        # The preference is the one Settings lists, and the sidebar's mark reads it.
        self.settled(lambda: self.muted_ids(page), [("project", self.project_id)], "the mute is stored")
        prefs = self.api(page, "GET", "/api/v1/notification-preferences")
        self.assertEqual([place["name"] for place in prefs["muted"]], ["Garden sensors"], "the Settings list is the same state")
        expect(row.locator("[data-muted-mark]")).to_be_visible()
        expect(row).to_have_attribute("aria-label", re.compile(r"Garden sensors, muted"))
        expect(self.sidebar_space(page, "Tool library").locator("[data-muted-mark]")).to_have_count(0)
        button.click()
        unmute = menu.get_by_role("menuitem", name=re.compile(r"^Unmute space"))
        expect(unmute).to_be_visible()
        expect(unmute).to_contain_text(STILL_ARRIVES)
        unmute.click()
        expect(menu).to_have_count(0)
        self.settled(lambda: self.muted(page), [], "the unmute is stored")
        expect(row.locator("[data-muted-mark]")).to_have_count(0)

    def test_02_what_is_new_in_a_muted_space_is_a_quiet_count_not_the_dot(self) -> None:
        page = self.page()
        self.clean_after(page)
        self.kai_posts(self.project_id, self.other_project_id)
        page.goto("/")
        garden, tools = self.sidebar_space(page, "Garden sensors"), self.sidebar_space(page, "Tool library")
        # Both have something new for Ada, and show the dot.
        expect(garden.locator(".side__dot")).to_be_visible()
        expect(tools.locator(".side__dot")).to_be_visible()
        # The stream carries the change to this open page: the dot of a muted space turns into its quiet count, with no reload (a reload
        # would also move Home's return point, which is where a space with none of its own starts "since you left").
        self.set_mute(page, "project", self.project_id, True)
        quiet = garden.locator(".side__quiet")
        expect(quiet).to_be_visible()
        expect(quiet).to_have_text(re.compile(r"^[1-9]\d*$"))
        expect(garden.locator(".side__dot")).to_have_count(0)
        expect(garden.locator("[data-muted-mark]")).to_be_visible()
        expect(garden).to_have_attribute("aria-label", re.compile(r"Garden sensors, muted, \d+ new"))
        # Quiet: regular weight, in the muted text colour; the name never turns bold.
        self.assertLessEqual(int(quiet.evaluate("el => getComputedStyle(el).fontWeight")), 400)
        self.assertEqual(int(garden.locator(".side__label").evaluate("el => getComputedStyle(el).fontWeight")), int(tools.locator(".side__label").evaluate("el => getComputedStyle(el).fontWeight")))
        expect(tools.locator(".side__dot")).to_be_visible()
        expect(tools.locator(".side__quiet")).to_have_count(0)
        # The mark does not push the name out of its row.
        box = garden.bounding_box()
        for part in (garden.locator("[data-muted-mark]"), quiet):
            inner = part.bounding_box()
            self.assertGreaterEqual(inner["x"] + inner["width"], 0)
            self.assertLessEqual(inner["x"] + inner["width"], box["x"] + box["width"] + 0.5, "inside the row")

    # ------------------------------------------------------------------ a direct message's header menu

    def test_03_mute_and_unmute_a_conversation_from_its_header_menu(self) -> None:
        page = self.page()
        self.clean_after(page)
        page.goto(f"/dm/{self.dm_id}")
        button, menu = self.more(page)
        row = page.locator(".side__dm", has_text="Kai Tanaka")
        button.click()
        mute = menu.get_by_role("menuitem", name=re.compile(r"^Mute conversation"))
        expect(mute).to_contain_text(STILL_ARRIVES)
        mute.click()
        expect(menu).to_have_count(0)
        self.settled(lambda: self.muted_ids(page), [("dm", self.dm_id)], "the mute is stored")
        expect(row.locator("[data-muted-mark]")).to_be_visible()
        expect(row).to_have_attribute("aria-label", "Kai Tanaka, muted")
        button.click()
        menu.get_by_role("menuitem", name=re.compile(r"^Unmute conversation")).click()
        self.settled(lambda: self.muted(page), [], "the unmute is stored")
        expect(row.locator("[data-muted-mark]")).to_have_count(0)

    # ------------------------------------------------------------------ the same state in every tab, live

    def test_04_a_mute_made_in_one_tab_shows_in_the_other_without_a_reload(self) -> None:
        context = self.context("ada")
        first, second = context.new_page(), context.new_page()
        for page in (first, second):
            errors: list[str] = []
            page.on("pageerror", lambda error, errors=errors: errors.append(str(error)))
            self.addCleanup(lambda errors=errors: self.assertEqual(errors, [], "no uncaught page errors"))
        self.clean_after(first)
        first.goto("/settings/notifications")
        second.goto(f"/projects/{self.project_id}")
        row = self.sidebar_space(first, "Garden sensors")
        expect(first.locator(".sset-row").filter(has=first.get_by_text("Muted places", exact=True))).to_contain_text("None")
        # The stream is what carries it: nothing here reloads the first tab or polls.
        navigations: list[str] = []
        first.on("framenavigated", lambda frame: navigations.append(frame.url))
        button, menu = self.more(second)
        button.click()
        menu.get_by_role("menuitem", name=re.compile(r"^Mute space")).click()
        expect(row.locator("[data-muted-mark]")).to_be_visible()
        expect(first.locator(".sset-row").filter(has=first.get_by_text("Muted places", exact=True))).to_contain_text("Garden sensors")
        button.click()
        menu.get_by_role("menuitem", name=re.compile(r"^Unmute space")).click()
        expect(row.locator("[data-muted-mark]")).to_have_count(0)
        expect(first.locator(".sset-row").filter(has=first.get_by_text("Muted places", exact=True))).to_contain_text("None")
        self.assertEqual(navigations, [], "the first tab was never reloaded")

    # ------------------------------------------------------------------ Follow and Following in a thread's header

    def test_05_follow_and_unfollow_a_thread_from_its_header(self) -> None:
        page = self.page()
        self.clean_after(page)
        page.goto(f"/projects/{self.project_id}/conversations/{self.own_thread}")
        # She started this thread, so she follows it without choosing.
        following = page.get_by_role("button", name="Following", exact=True)
        expect(following).to_be_visible()
        self.assertTrue(self.following(page, self.own_thread))
        following.click()
        follow = page.get_by_role("button", name="Follow", exact=True)
        expect(follow).to_be_visible()
        self.settled(lambda: self.following(page, self.own_thread), False, "the choice is stored")
        page.reload()
        expect(page.get_by_role("button", name="Follow", exact=True)).to_be_visible()
        page.get_by_role("button", name="Follow", exact=True).click()
        expect(page.get_by_role("button", name="Following", exact=True)).to_be_visible()
        self.settled(lambda: self.following(page, self.own_thread), True, "the choice is stored")

        # A thread she did not start, write in or get mentioned in: Follow, then Following.
        page.goto(f"/projects/{self.project_id}/conversations/{self.kai_thread}")
        expect(page.get_by_role("button", name="Follow", exact=True)).to_be_visible()
        self.assertFalse(self.following(page, self.kai_thread))
        page.get_by_role("button", name="Follow", exact=True).click()
        expect(page.get_by_role("button", name="Following", exact=True)).to_be_visible()
        self.settled(lambda: self.following(page, self.kai_thread), True, "the choice is stored")

    def test_06_a_follow_made_in_one_tab_shows_in_the_other_without_a_reload(self) -> None:
        context = self.context("ada")
        first, second = context.new_page(), context.new_page()
        self.clean_after(first)
        for page in (first, second):
            page.goto(f"/projects/{self.project_id}/conversations/{self.kai_thread}")
            expect(page.get_by_role("button", name="Follow", exact=True)).to_be_visible()
        first.get_by_role("button", name="Follow", exact=True).click()
        expect(second.get_by_role("button", name="Following", exact=True)).to_be_visible()
        second.get_by_role("button", name="Following", exact=True).click()
        expect(first.get_by_role("button", name="Follow", exact=True)).to_be_visible()

    def test_07_a_failed_follow_is_put_back_and_says_so(self) -> None:
        page = self.page()
        self.clean_after(page)
        page.goto(f"/projects/{self.project_id}/conversations/{self.kai_thread}")
        expect(page.get_by_role("button", name="Follow", exact=True)).to_be_visible()

        def handler(route) -> None:
            if route.request.method == "PUT":
                route.fulfill(status=500, content_type="application/json", body="{}")
            else:
                route.continue_()

        page.route("**/api/v1/notification-preferences/follows", handler)
        self.addCleanup(lambda: page.unroute_all(behavior="ignoreErrors"))
        page.get_by_role("button", name="Follow", exact=True).click()
        expect(page.get_by_text("Could not follow. Try again.")).to_be_visible()
        expect(page.get_by_role("button", name="Follow", exact=True)).to_be_visible()
        self.assertFalse(self.following(page, self.kai_thread))

    # ------------------------------------------------------------------ a phone

    def test_08_on_a_phone_mute_from_the_space_menu_and_a_conversation_menu_and_follow_in_the_sheet(self) -> None:
        page = self.page(phone=True)
        self.clean_after(page)
        page.goto(f"/projects/{self.project_id}")
        button, menu = self.more(page)
        assert_touch_target(self, page, button.first)
        button.click()
        mute = menu.get_by_role("menuitem", name=re.compile(r"^Mute space"))
        expect(mute).to_contain_text(STILL_ARRIVES)
        assert_touch_target(self, page, mute)
        mute.click()
        expect(menu).to_have_count(0)
        self.settled(lambda: self.muted_ids(page), [("project", self.project_id)], "the mute is stored")
        # The phone has no sidebar: the Spaces list carries the mark.
        self.kai_posts(self.project_id, self.other_project_id)
        page.goto("/projects")
        spaces = page.get_by_role("list", name="Spaces")
        expect(spaces.get_by_role("link", name=re.compile(r"^Garden sensors, muted"))).to_be_visible()
        expect(spaces.locator("[data-muted-mark]")).to_have_count(1)
        quiet = spaces.locator(".proj-index__quiet")
        expect(quiet).to_have_count(1)
        expect(quiet).to_have_text(re.compile(r"^[1-9]\d*$"))
        expect(spaces.locator(".proj-index__dot")).to_have_count(1)
        page.goto(f"/projects/{self.project_id}")
        button.click()
        menu.get_by_role("menuitem", name=re.compile(r"^Unmute space")).click()
        self.settled(lambda: self.muted(page), [], "the unmute is stored")

        # A conversation: its title menu holds the row, above "Message info".
        page.goto(f"/dm/{self.dm_id}")
        page.get_by_role("button", name=re.compile(r"Kai Tanaka")).first.click()
        dialog = page.get_by_role("dialog", name=re.compile(r"Kai Tanaka"))
        row = dialog.get_by_role("button", name=re.compile(r"^Mute conversation"))
        expect(row).to_contain_text(STILL_ARRIVES)
        assert_touch_target(self, page, row)
        row.click()
        expect(dialog).to_have_count(0)
        self.settled(lambda: self.muted_ids(page), [("dm", self.dm_id)], "the mute is stored")
        page.goto("/projects")
        expect(page.get_by_role("link", name=re.compile(r"^Kai Tanaka, muted"))).to_be_visible()
        page.goto(f"/dm/{self.dm_id}")
        page.get_by_role("button", name=re.compile(r"Kai Tanaka")).first.click()
        page.get_by_role("dialog", name=re.compile(r"Kai Tanaka")).get_by_role("button", name=re.compile(r"^Unmute conversation")).click()
        self.settled(lambda: self.muted(page), [], "the unmute is stored")

        # A thread opens as a sheet; its header carries Follow.
        page.goto(f"/projects/{self.project_id}/conversations/{self.kai_thread}")
        follow = page.get_by_role("button", name="Follow", exact=True)
        expect(follow).to_be_visible()
        assert_touch_target(self, page, follow)
        follow.click()
        expect(page.get_by_role("button", name="Following", exact=True)).to_be_visible()
        self.settled(lambda: self.following(page, self.kai_thread), True, "the choice is stored")

    # ------------------------------------------------------------------ the screenshots: 1440 and 390, light and dark

    def test_09_screenshots_in_light_and_dark(self) -> None:
        for dark in (False, True):
            tone = "dark" if dark else "light"
            page = self.page(dark=dark)
            self.clean_after(page)
            self.set_mute(page, "project", self.other_project_id, True)
            self.kai_posts(self.other_project_id)
            page.goto(f"/projects/{self.project_id}")
            button, menu = self.more(page)
            expect(self.sidebar_space(page, "Tool library").locator(".side__quiet")).to_be_visible()
            button.click()
            expect(menu.get_by_role("menuitem", name=re.compile(r"^Mute space"))).to_be_visible()
            shot(page, f"mute-follow-1440-space-menu-{tone}")
            page.keyboard.press("Escape")
            page.goto(f"/dm/{self.dm_id}")
            self.more(page)[0].click()
            expect(page.get_by_role("menu", name="More").get_by_role("menuitem", name=re.compile(r"^Mute conversation"))).to_be_visible()
            shot(page, f"mute-follow-1440-dm-menu-{tone}")
            page.keyboard.press("Escape")
            page.goto(f"/projects/{self.project_id}/conversations/{self.kai_thread}")
            expect(page.get_by_role("button", name="Follow", exact=True)).to_be_visible()
            shot(page, f"mute-follow-1440-thread-follow-{tone}")
            page.get_by_role("button", name="Follow", exact=True).click()
            expect(page.get_by_role("button", name="Following", exact=True)).to_be_visible()
            shot(page, f"mute-follow-1440-thread-following-{tone}")
            self.set_follow(page, self.kai_thread, False)

            phone = self.page(phone=True, dark=dark)
            phone.goto(f"/projects/{self.project_id}")
            self.more(phone)[0].click()
            expect(phone.get_by_role("menu", name="More").get_by_role("menuitem", name=re.compile(r"^Mute space"))).to_be_visible()
            shot(phone, f"mute-follow-390-space-menu-{tone}")
            phone.keyboard.press("Escape")
            self.kai_posts(self.other_project_id)
            phone.goto("/projects")
            expect(phone.locator(".proj-index__quiet")).to_be_visible()
            shot(phone, f"mute-follow-390-spaces-muted-{tone}")
            phone.goto(f"/dm/{self.dm_id}")
            phone.get_by_role("button", name=re.compile(r"Kai Tanaka")).first.click()
            expect(phone.get_by_role("dialog", name=re.compile(r"Kai Tanaka")).get_by_role("button", name=re.compile(r"^Mute conversation"))).to_be_visible()
            shot(phone, f"mute-follow-390-dm-menu-{tone}")
            phone.keyboard.press("Escape")
            phone.goto(f"/projects/{self.project_id}/conversations/{self.kai_thread}")
            expect(phone.get_by_role("button", name="Follow", exact=True)).to_be_visible()
            shot(phone, f"mute-follow-390-thread-follow-{tone}")
            self.set_mute(page, "project", self.other_project_id, False)


if __name__ == "__main__":
    unittest.main()
