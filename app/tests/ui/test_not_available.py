"""The "not available" pages are one pattern (#1371): an icon, one plain sentence and one way back, inside the shell, under a header that
names the place or nothing, with no raw status code. The seven places that are gone (an agent, a direct message, an Inbox item, a space, a
Wiki page, a call, an address) and the agent sign-in page opened with no request behind it. A Wiki page that exists is in the app's type scale.
Runs through scripts/check_ui.sh against the running app, on the engine named by FLUX_UI_BROWSER (chromium or webkit).
"""

from __future__ import annotations

import json
import os
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, start_forwarder

PASSWORD = "nothing is lost when a place is gone"
STAMP = int(time.time() * 1000)
EMAIL = f"ada.gone+{STAMP}@example.test"
ZERO = "00000000-0000-4000-8000-000000000000"

UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
if UI_BROWSER not in ("chromium", "webkit"):
    raise ValueError(f"FLUX_UI_BROWSER must be chromium or webkit, got {UI_BROWSER!r}")


class NotAvailable(unittest.TestCase):
    browser: Browser
    state: dict = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        assert cls.browser.browser_type.name == UI_BROWSER
        print(f"ACTUAL_UI_ENGINE={cls.browser.browser_type.name}")
        expect.set_options(timeout=10000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, phone: bool = False) -> Page:
        options = dict(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True) if phone else dict(viewport=DESKTOP)
        context = self.browser.new_context(base_url=ORIGIN, locale="en-GB", service_workers="block", storage_state=self.state["storage"], **options)
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
        space = self.api(page, "POST", f"/api/v1/workspaces/{workspace}/projects", {"name": "Orchard plans", "visibility": "restricted"}, status=201)["id"]
        material = self.api(page, "POST", f"/api/v1/projects/{space}/docs", {
            "title": "Probe datasheet notes", "body": "Dry 3.1 V, wet 1.4 V. Capacitive probes only."}, status=201)
        type(self).state.update(space=space, material=material.get("id") or material.get("materialId") or (material.get("material") or {}).get("id") or "")

    def gone_pages(self) -> list[tuple[str, str, str]]:
        """(name, address, the way back)."""
        space = self.state["space"]
        return [
            ("agent", f"/agents/{ZERO}", "Back to Messages"),
            ("direct message", f"/dm/{ZERO}", "Back to Messages"),
            ("inbox item", f"/inbox/{ZERO}", "Back to the Inbox"),
            ("space", f"/projects/{ZERO}", "Go to Home"),
            ("wiki page", f"/materials/{ZERO}", "Go to Home"),
            ("call", f"/projects/{space}/live/{ZERO}", "Back to the space"),
            ("address", "/not-a-real-place", "Go to Home"),
        ]

    def test_01_every_kind_of_place_that_is_gone_uses_one_pattern_inside_the_shell(self) -> None:
        self.world()
        for phone in (False, True):
            page = self.page(phone)
            for name, path, back in self.gone_pages():
                with self.subTest(place=name, phone=phone):
                    page.goto(path)
                    gone = page.locator("[data-not-available]")
                    expect(gone).to_have_count(1)
                    # An icon, one plain sentence (the heading) and one way back; nothing else, and nothing raw.
                    expect(gone.locator(".ui-empty__icon")).to_have_count(1)
                    expect(gone.get_by_role("heading", level=2)).to_have_count(1)
                    expect(gone.get_by_role("heading", level=2)).to_contain_text(re.compile(r"isn’t (available|here)|doesn’t exist|no longer open"))
                    expect(gone.get_by_role("link")).to_have_count(1)
                    expect(gone.get_by_role("link", name=back)).to_be_visible()
                    expect(gone.get_by_role("button")).to_have_count(0)
                    self.assertLessEqual(len((gone.inner_text() or "").split("\n")), 3, "an icon, a sentence and a link, no paragraph")
                    for raw in ("400", "404", "Service Unavailable", "Something went wrong", "Try again"):
                        expect(page.get_by_text(raw, exact=False)).to_have_count(0)
                    # The shell stays, and its header names the place or nothing: never "Home" with the company before it.
                    expect(page.get_by_role("heading", level=1)).to_have_count(1)
                    expect(page.locator(".top__crumb, .top__slash")).to_have_count(0)
                    if not phone:
                        expect(page.locator(".app__side")).to_be_visible()
                        title = page.locator("header.top h1").inner_text().strip()
                        self.assertNotEqual(title, "Home", f"the header of {name} names the place, not Home")
                        expect(page.locator(".app__side").get_by_role("link", name="Home", exact=True)).not_to_have_attribute("aria-current", "page")
                    # All of them sit in the same place under their header, whatever kind of place is gone.
                    box = gone.locator(".ui-empty").bounding_box()
                    content = page.locator("#content").bounding_box()
                    self.assertIsNotNone(box)
                    self.state.setdefault("boxes", {}).setdefault(phone, []).append((round(box["x"] - content["x"]), round(box["y"] - content["y"])))
            self.assertEqual(len(set(self.state["boxes"][phone])), 1, f"one layout for every kind of place: {self.state['boxes'][phone]}")

    def test_02_the_agent_sign_in_page_with_no_request_is_a_sign_in_page_not_an_error(self) -> None:
        self.world()
        page = self.page()
        page.goto("/consent")
        expect(page.get_by_role("heading", level=1, name="This sign-in link isn’t complete")).to_be_visible()
        for raw in ("400", "Something went wrong", "Try again"):
            expect(page.get_by_text(raw, exact=False)).to_have_count(0)
        expect(page.get_by_role("link", name="Go to Home")).to_be_visible()
        # It sits where the other sign-in pages put their body: at the column's own left edge, not indented (the error page was about 60 px in).
        column = page.locator(".auth__col").bounding_box()
        head = page.locator(".auth__head").bounding_box()
        self.assertIsNotNone(column)
        self.assertIsNotNone(head)
        self.assertLessEqual(abs(head["x"] - column["x"]), 2, "the body starts at the column's left edge")

    def test_03_a_page_by_its_id_opens_in_its_spaces_wiki(self) -> None:
        """#1508: every saved source is a Wiki page; its address by id alone (what a citation carries) opens the page in its space's Wiki."""
        self.world()
        page = self.page()
        page.goto(f"/materials/{self.state['material']}")
        expect(page).to_have_url(re.compile(rf"/projects/{self.state['space']}/docs/{self.state['material']}$"))
        expect(page.locator("article.wiki-page")).to_be_visible()
        expect(page.locator(".wiki-title")).to_contain_text("Probe datasheet notes")
        expect(page.locator(".wiki-body")).to_contain_text("Dry 3.1 V, wet 1.4 V.")
        expect(page.locator("article.material-view")).to_have_count(0)

    def test_04_an_inbox_item_whose_read_fails_for_now_is_not_called_gone(self) -> None:
        """A 503 on an Inbox item's read says "This couldn't be loaded" with Try again, never the not-available page (#1369, #1371)."""
        self.world()
        page = self.page()
        failing = {"on": True}
        page.route(re.compile(rf".*/api/v1/inbox/{ZERO}$"), lambda route: route.fulfill(status=503, json={"code": "TEST_UNAVAILABLE"}) if failing["on"] else route.continue_())
        page.goto(f"/inbox/{ZERO}")
        expect(page.get_by_role("heading", name="This couldn’t be loaded")).to_be_visible()
        expect(page.locator("[data-not-available]")).to_have_count(0)
        failing["on"] = False
        page.get_by_role("button", name="Try again").click()
        # The item really is gone: now, and only now, it is the not-available page.
        expect(page.locator("[data-not-available]")).to_be_visible()
        expect(page.get_by_role("link", name="Back to the Inbox")).to_be_visible()


if __name__ == "__main__":
    unittest.main()
