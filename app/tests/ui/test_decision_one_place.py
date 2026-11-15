"""Browser tests for one place for a decision (v0.2.1, the founder's bar: the same object opens in the same place from everywhere).

Runs through scripts/check_ui.sh against the running Compose application, on the engine named by FLUX_UI_BROWSER (run it with
chromium and with webkit). One person owns a space with a message, an accepted rule and a proposal that waits for her. The
proposal opens from the Inbox, from Search and from an old `/tasks?open=decision:` link (a bookmark), on a computer (1440 x 900)
and on a phone (390 x 844, touch), and each time it is the same place: the space's Conversation with the decision in the one
panel (a sheet on the phone), its card in the conversation marked as the open one and in view, and no other card marked.
"""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, start_forwarder

PASSWORD = "one decision opens in one place"
STAMP = int(time.time() * 1000)
ADA = {"name": "Ada Lind", "email": f"ada.oneplace+{STAMP}@example.test"}
MESSAGE = "Should the probes in bed 5 be replaced before the frost?"
PROPOSAL = "Replace the bed 5 probes with capacitive ones"
RULE = "Log moisture every ten minutes"


class DecisionOnePlace(unittest.TestCase):
    """Tests run in name order and share one account and one space."""

    pw = None
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
        print(f"ACTUAL_UI_ENGINE={cls.browser.browser_type.name}", flush=True)
        expect.set_options(timeout=8000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def context(self, *, phone: bool = False, signed_in: bool = True) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "locale": "en-GB", "timezone_id": "Europe/Warsaw", "viewport": PHONE if phone else DESKTOP,
                         "service_workers": "block"}
        if phone:
            options.update(device_scale_factor=3, is_mobile=True, has_touch=True)
        if signed_in and self.state:
            options["storage_state"] = self.state
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        return context

    def page(self, *, phone: bool = False) -> Page:
        page = self.context(phone=phone).new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def api(self, page: Page, method: str, path: str, body: dict | None = None, status: int | None = None) -> dict:
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers={"origin": ORIGIN, "content-type": "application/json"},
                                      data=json.dumps(body) if body is not None else None)
        if status is not None:
            self.assertEqual(response.status, status, response.text())
        return json.loads(response.text()) if response.text() else {}

    def card(self, page: Page, decision: str):
        return page.locator(f'.convo-object[data-object-kind="decision.proposed"][data-object-id="{decision}"] .convo-object__card')

    def assert_the_one_place(self, page: Page, *, phone: bool, how: str) -> None:
        """The space's Conversation, the proposal in the one panel, its card marked as the open one and in view, and no other card."""
        pid, proposal = self.ids["project"], self.ids["proposal"]
        expect(page, f"{how}: the space's conversation").to_have_url(re.compile(rf"/projects/{pid}(\?open=decision:{proposal})?$"))
        if not phone:
            expect(page.get_by_role("navigation", name="Space views").get_by_role("tab", name="Conversation")).to_have_attribute("aria-current", "page")
        panel = page.get_by_role("complementary", name="Details").or_(page.get_by_role("dialog", name="Details"))
        expect(panel.locator(".wd[data-detail-kind='decision']"), f"{how}: the decision in the one panel").to_contain_text(PROPOSAL)
        card = self.card(page, proposal)
        expect(card, f"{how}: its card is the open one").to_have_attribute("aria-current", "true")
        expect(self.card(page, self.ids["rule"]), f"{how}: no other card is marked").not_to_have_attribute("aria-current", "true")
        # The fill comes in with the card's colour transition (--tr), so it is read once the transition has run.
        page.wait_for_function("""([open, other]) => {
            const fill = (id) => getComputedStyle(document.querySelector(`.convo-object[data-object-kind="decision.proposed"][data-object-id="${id}"] .convo-notice__card`)).backgroundColor;
            return fill(open) !== fill(other);
        }""", arg=[proposal, self.ids["rule"]], timeout=3000)
        if not phone:
            # On the computer the panel stands beside the conversation, so the open card is on screen beside it.
            expect(card).to_be_in_viewport()

    # ---------------------------------------------------------------- fixture

    def test_00_a_space_with_a_message_a_rule_and_a_proposal(self) -> None:
        page = self.context(signed_in=False).new_page()
        page.goto("/sign-up")
        page.get_by_label("Name").fill(ADA["name"])
        page.get_by_label("Email").fill(ADA["email"])
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        type(self).state = page.context.storage_state()
        ws = self.api(page, "POST", "/api/v1/workspaces", {"name": "Riverside garden"}, status=201)
        project = self.api(page, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Garden sensors", "visibility": "restricted"}, status=201)
        pid = project["id"]
        self.api(page, "POST", f"/api/v1/projects/{pid}/conversations", {"body": MESSAGE, "clientMessageId": str(uuid.uuid4())})
        rule = self.api(page, "POST", f"/api/v1/projects/{pid}/decisions", {"title": RULE, "rationale": "Ten minutes shows a watering"}, status=201)
        self.api(page, "POST", f"/api/v1/decisions/{rule['id']}/accept", {"expectedVersion": 1}, status=200)
        # Nobody else here can accept it, so it waits in Ada's own Inbox (#763 FT-8).
        proposal = self.api(page, "POST", f"/api/v1/projects/{pid}/decisions", {"title": PROPOSAL, "rationale": "Capacitive probes do not corrode"}, status=201)
        type(self).ids = {"project": pid, "rule": rule["id"], "proposal": proposal["id"]}
        queue = self.api(page, "GET", "/api/v1/needs-you", status=200)
        item = next(entry for entry in queue["items"] if entry["key"] == f"decision:{proposal['id']}")
        self.assertEqual(item["url"], f"/projects/{pid}?open=decision:{proposal['id']}", "the Inbox item's link is the one place")

    # ---------------------------------------------------------------- the Inbox

    def test_01_from_the_inbox_on_a_computer(self) -> None:
        page = self.page()
        page.goto("/inbox")
        row = page.locator(".nyc", has_text=PROPOSAL)
        expect(row).to_be_visible()
        # Enter on the item's row opens it (#1424), as Enter on the page does.
        row.locator(".nyc__open").focus()
        page.keyboard.press("Enter")
        self.assert_the_one_place(page, phone=False, how="Inbox")

    def test_02_from_the_inbox_on_a_phone(self) -> None:
        page = self.page(phone=True)
        page.goto("/inbox")
        title = page.locator(".nyc", has_text=PROPOSAL).locator(".nyc__open")
        expect(title).to_be_visible()
        title.tap()
        self.assert_the_one_place(page, phone=True, how="Inbox on a phone")

    # ---------------------------------------------------------------- Search

    def search(self, page: Page) -> None:
        expect(page.get_by_role("button", name="Search", exact=True).first).to_be_visible()
        page.keyboard.press("Control+k")
        dialog = page.get_by_role("dialog", name="Search", exact=True)
        expect(dialog).to_be_visible()
        dialog.get_by_role("combobox", name="Search", exact=True).fill("capacitive")
        option = dialog.locator("[role=option].sr", has_text=PROPOSAL).first
        expect(option).to_be_visible()
        option.click()

    def test_03_from_search_on_a_computer(self) -> None:
        page = self.page()
        page.goto("/inbox")
        self.search(page)
        self.assert_the_one_place(page, phone=False, how="Search")

    def test_04_from_search_inside_the_space_on_its_tasks(self) -> None:
        # From the space's own Tasks the decision does not open over Tasks: Search brings it to the conversation.
        page = self.page()
        page.goto(f"/projects/{self.ids['project']}/tasks")
        expect(page.get_by_role("navigation", name="Space views").get_by_role("tab", name="Tasks")).to_have_attribute("aria-current", "page")
        self.search(page)
        self.assert_the_one_place(page, phone=False, how="Search from Tasks")

    # ---------------------------------------------------------------- an old link

    def test_05_an_old_tasks_link_opens_the_same_place(self) -> None:
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page(phone=phone)
                page.goto(f"/projects/{self.ids['project']}/tasks?open=decision:{self.ids['proposal']}")
                self.assert_the_one_place(page, phone=phone, how="old link")
                self.assertNotIn("/tasks", page.url, "an old link is never left over Tasks")

    def test_06_a_notification_link_opens_the_same_place(self) -> None:
        # The link a notification, its push and its email open is the Inbox item's own: the same address as above.
        page = self.page()
        page.goto(f"/projects/{self.ids['project']}?open=decision:{self.ids['proposal']}")
        self.assert_the_one_place(page, phone=False, how="notification link")


if __name__ == "__main__":
    unittest.main()
