"""A background read that fails keeps the page that is shown (#1141).

A live event (here a space renamed) makes the app read the page's data again in the background, and that read also asks for the person
(`/api/v1/me`). One 503, or no answer, used to replace the whole page with "Something went wrong" until Try again. Now the page stays as it
was, asks again by itself after a short wait, and takes the new data when a read finishes. The error screen is for a first load that fails
and for data that is gone (404). Runs through scripts/check_ui.sh against the running app.
"""

from __future__ import annotations

import json
import os
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, UPSTREAM, start_forwarder

PASSWORD = "a page that stays up"
STAMP = int(time.time() * 1000)
EMAIL = f"ada.refresh+{STAMP}@example.test"
ERROR = "Something went wrong"
GONE = "This place isn’t available"

UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
if UI_BROWSER not in ("chromium", "webkit"):
    raise ValueError(f"FLUX_UI_BROWSER must be chromium or webkit, got {UI_BROWSER!r}")


def space_read(space: str) -> re.Pattern:
    """The reads of the space itself: its own address, and its frame (`space-shell`, #1109), which is how a space's pages read it."""
    return re.compile(rf".*/api/v1/projects/{space}(/space-shell)?$")


class BackgroundRefresh(unittest.TestCase):
    browser: Browser
    state: dict = {}
    renames = 0

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

    def page(self) -> Page:
        context = self.browser.new_context(base_url=ORIGIN, locale="en-GB", service_workers="block", viewport=DESKTOP, storage_state=self.state["storage"])
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def api(self, page: Page, method: str, path: str, body: dict | None = None, status: int = 200) -> dict:
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers={"origin": ORIGIN, "content-type": "application/json", "idempotency-key": str(uuid.uuid4())},
                                      data=json.dumps(body) if body is not None else None)
        self.assertEqual(response.status, status, response.text())
        return json.loads(response.text()) if response.text() else {}

    def world(self) -> None:
        if self.state:
            return
        context = self.browser.new_context(base_url=ORIGIN, locale="en-GB", service_workers="block")
        self.addCleanup(context.close)
        response = context.request.post("/api/auth/sign-up/email", data={"email": EMAIL, "password": PASSWORD, "name": "Ada Kowalska"}, headers={"origin": ORIGIN})
        self.assertEqual(response.status, 200, response.text())
        type(self).state["storage"] = context.storage_state()
        page = self.page()
        workspace = self.api(page, "POST", "/api/v1/workspaces", {"name": "Orchard Makers"}, status=201)["id"]
        space = self.api(page, "POST", f"/api/v1/workspaces/{workspace}/projects", {"name": "Orchard plans", "visibility": "restricted"}, status=201)
        type(self).state.update(space=space["id"], name=space["name"])

    def open(self, page: Page, path: str) -> None:
        """Opens a page and waits for its live stream, so the event that the test causes reaches it."""
        with page.expect_websocket(lambda socket: "/api/v1/stream" in socket.url, timeout=15000):
            page.goto(path)
        page.wait_for_timeout(1000)

    def rename(self, page: Page) -> str:
        """Another change of the space: its rename is an event that makes every open page read its data again."""
        type(self).renames += 1
        name = f"Orchard plans {self.renames}"
        self.api(page, "PATCH", f"/api/v1/projects/{self.state['space']}", {"name": name})
        type(self).state["name"] = name
        return name

    def failing(self, page: Page, pattern, how: str) -> dict:
        """Every read of `pattern` fails (`network`: no answer; `server`: 503; `gone`: 404) until `state["failing"]` is set to False."""
        state = {"failing": True, "reads": 0}

        def blip(route) -> None:
            if not state["failing"]:
                route.continue_()
                return
            state["reads"] += 1
            if how == "network":
                route.abort("failed")
            elif how == "gone":
                route.fulfill(status=404, json={"code": "NOT_FOUND", "message": "Not found"})
            else:
                route.fulfill(status=503, json={"code": "TEST_UNAVAILABLE"})

        page.route(pattern, blip)
        return state

    def wait_for(self, page: Page, condition, what: str, seconds: float = 20) -> None:
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if condition():
                return
            page.wait_for_timeout(100)
        self.fail(f"gave up waiting for {what}")

    def sidebar_space(self, page: Page, name: str):
        return page.locator("nav[aria-labelledby='side-projects']").get_by_role("link", name=re.compile(rf"^{re.escape(name)}(, new activity)?$"))

    def test_01_a_failed_identity_read_in_a_refresh_keeps_home_and_the_next_read_brings_the_change(self) -> None:
        self.world()
        for how in ("network", "server"):
            with self.subTest(identity_read=how):
                page = self.page()
                self.open(page, "/")
                expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
                before = self.state["name"]
                expect(self.sidebar_space(page, before)).to_be_visible()
                reads = self.failing(page, "**/api/v1/me", how)
                after = self.rename(page)
                # The refresh asks for the person and fails; the page asks again by itself, a second after, and fails again.
                self.wait_for(page, lambda: reads["reads"] >= 2, "a second read of the person, by itself")
                expect(page.get_by_text(ERROR)).to_have_count(0)
                expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
                expect(self.sidebar_space(page, before)).to_be_visible()
                self.assertEqual(self.sidebar_space(page, after).count(), 0, "what the page showed is still what it shows")
                # The server answers again: a later read of its own takes the change, with nobody pressing anything.
                reads["failing"] = False
                expect(self.sidebar_space(page, after)).to_be_visible(timeout=20000)
                expect(page.get_by_text(ERROR)).to_have_count(0)

    def test_02_a_failed_read_of_the_space_in_a_refresh_keeps_its_conversation(self) -> None:
        self.world()
        space = self.state["space"]
        for how in ("network", "server"):
            with self.subTest(space_read=how):
                page = self.page()
                self.open(page, f"/projects/{space}")
                title = page.locator("header.top .top__title h1")
                expect(title).to_have_text(self.state["name"])
                feed = page.locator(".project-convo__feed")
                expect(feed).to_be_visible()
                reads = self.failing(page, space_read(space), how)
                after = self.rename(page)
                self.wait_for(page, lambda: reads["reads"] >= 2, "a second read of the space, by itself")
                expect(page.get_by_text(ERROR)).to_have_count(0)
                expect(feed).to_be_visible()
                expect(page.get_by_role("textbox").first).to_be_visible()
                reads["failing"] = False
                expect(title).to_have_text(after, timeout=20000)
                expect(page.get_by_text(ERROR)).to_have_count(0)

    def test_03_a_first_load_that_fails_still_shows_the_error_and_try_again_recovers(self) -> None:
        self.world()
        for how, shown in (("server", ERROR), ("network", "Flux can’t be reached")):
            with self.subTest(first_load=how):
                page = self.page()
                reads = self.failing(page, "**/api/v1/me", how)
                page.goto("/")
                expect(page.get_by_role("heading", level=1, name=shown)).to_be_visible()
                self.assertGreaterEqual(reads["reads"], 1)
                reads["failing"] = False
                page.get_by_role("button", name="Try again").click()
                expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
                expect(page.get_by_text(shown)).to_have_count(0)

    def test_04_a_space_that_is_gone_in_a_refresh_still_says_so(self) -> None:
        self.world()
        space = self.state["space"]
        pattern = space_read(space)
        # A page that was opened by its address, or returned to, lands on the nearest place that opens, with one line (#592).
        page = self.page()
        self.open(page, f"/projects/{space}")
        expect(page.locator("header.top .top__title h1")).to_have_text(self.state["name"])
        reads = self.failing(page, pattern, "gone")
        self.rename(page)
        expect(page).to_have_url(f"{ORIGIN}/projects")
        expect(page.get_by_text("That space is no longer available to you.")).to_be_visible()
        self.assertGreaterEqual(reads["reads"], 1)
        expect(page.get_by_text(ERROR)).to_have_count(0)
        # A page that a click opened says that it is not available.
        page = self.page()
        self.open(page, "/")
        self.sidebar_space(page, self.state["name"]).click()
        expect(page.locator("header.top .top__title h1")).to_have_text(self.state["name"])
        reads = self.failing(page, pattern, "gone")
        self.rename(page)
        expect(page.get_by_role("heading", level=1, name=GONE)).to_be_visible()
        self.assertGreaterEqual(reads["reads"], 1)
        expect(page.get_by_text(ERROR)).to_have_count(0)

    def test_05_no_session_in_a_refresh_still_leads_to_sign_in(self) -> None:
        self.world()
        page = self.page()
        self.open(page, "/")
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        # The session ended elsewhere: the identity read answers 200 with no person (the probe answer, #546).
        page.route("**/api/v1/me", lambda route: route.fulfill(status=200, body="null", content_type="application/json"))
        self.rename(page)
        expect(page).to_have_url(re.compile(r"/sign-in"))
        expect(page.get_by_text(ERROR)).to_have_count(0)


if __name__ == "__main__":
    unittest.main()
