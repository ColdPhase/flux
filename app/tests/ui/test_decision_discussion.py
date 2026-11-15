"""Browser tests for a decision's one discussion (founder decision, Hubert, 2026-11-15, recorded on #1424).

Runs through scripts/check_ui.sh against the running Compose application, on the engine named by FLUX_UI_BROWSER (run it with
chromium and with webkit). Discuss (and R in the Inbox) opens the decision's panel with the cursor in "Write about this decision…";
what is typed there is the decision's discussion, never the space's own composer's draft. The first message starts the thread on the
decision's card, whose "N replies" opens the same thread; a reply written there, or by anyone anywhere, shows in the panel at once. On a
phone the panel is the sheet, with the same field at its foot.
"""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, start_forwarder

PASSWORD = "one discussion in both places"
STAMP = int(time.time() * 1000)
ADA = {"name": "Ada Lind", "email": f"ada.discuss+{STAMP}@example.test"}
MESSAGE = "Should the probes in bed 5 be replaced before the frost?"
PROPOSAL = "Replace the bed 5 probes with capacitive ones"
DRAFT = "An unrelated note for the space"
FIRST = "Do capacitive probes need a heater in winter?"
IN_THREAD = "Only below minus ten, the datasheet says."
LIVE = "I ordered two to try in bed 5."
ON_PHONE = "Then we replace them on Saturday."


class DecisionDiscussion(unittest.TestCase):
    """Tests run in name order and share one account, one space and one proposal."""

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

    def panel(self, page: Page):
        return page.get_by_role("complementary", name="Details").or_(page.get_by_role("dialog", name="Details")).locator(
            f".wd[data-detail-kind='decision'][data-detail-id='{self.ids['proposal']}']")

    def replies(self, page: Page):
        return page.locator(f'.convo-object[data-object-id="{self.ids["proposal"]}"] [data-decision-replies="{self.ids["proposal"]}"]').first

    # ---------------------------------------------------------------- fixture

    def test_00_a_space_with_a_message_and_a_proposal(self) -> None:
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
        self.api(page, "POST", f"/api/v1/projects/{pid}/conversations", {"body": MESSAGE, "clientMessageId": str(uuid.uuid4())}, status=201)
        # Nobody else here can accept it, so it waits in Ada's own Inbox.
        proposal = self.api(page, "POST", f"/api/v1/projects/{pid}/decisions", {"title": PROPOSAL, "rationale": "Capacitive probes do not corrode"}, status=201)
        type(self).ids = {"project": pid, "proposal": proposal["id"]}

    # ---------------------------------------------------------------- R in the Inbox, on a computer

    def test_01_r_in_the_inbox_writes_in_the_decisions_panel_and_starts_the_thread_on_its_card(self) -> None:
        page = self.page()
        # A draft in the space's own composer, which Discuss must never write into.
        page.goto(f"/projects/{self.ids['project']}")
        expect(page.locator("#project-composer")).to_be_visible()
        page.locator("#project-composer").fill(DRAFT)
        page.goto("/inbox")
        row = page.locator(".nyc", has_text=PROPOSAL)
        expect(row).to_be_visible()
        row.locator(".nyc__open").focus()
        # R, then the words at once: they are kept for the field that R asked for, never Inbox keys.
        page.keyboard.press("r")
        page.keyboard.type(FIRST)
        expect(page).to_have_url(re.compile(rf"/projects/{self.ids['project']}\?open=decision:{self.ids['proposal']}$"))
        field = page.locator("#decision-composer")
        expect(field, "the cursor is in the decision's field").to_be_focused()
        expect(field).to_have_attribute("placeholder", re.compile("Write"))
        expect(field).to_have_value(FIRST)
        page.keyboard.press("Enter")
        panel = self.panel(page)
        messages = panel.locator(".wd-discussion__list")
        expect(messages.locator("[data-message-id]")).to_have_count(1)
        expect(messages).to_contain_text(FIRST)
        expect(field).to_have_value("")
        # The space's own composer kept its draft and sent nothing; the stream has no new root with the words.
        expect(page.locator("#project-composer")).to_have_value(DRAFT)
        expect(page.locator(".project-convo__feed").get_by_text(FIRST)).to_have_count(0)
        # The decision's card in the conversation carries the thread.
        expect(self.replies(page)).to_contain_text("1 reply")

    def test_02_the_cards_replies_open_the_same_thread_and_a_reply_there_shows_in_the_panel(self) -> None:
        page = self.page()
        page.goto(f"/projects/{self.ids['project']}")
        replies = self.replies(page)
        expect(replies).to_contain_text("1 reply")
        replies.click()
        thread = page.locator("#thread")
        expect(thread.locator(f'[data-discussed-decision="{self.ids["proposal"]}"]'), "the thread's head is the decision").to_contain_text(PROPOSAL)
        expect(thread).to_contain_text(FIRST)
        composer = page.locator("#thread-composer")
        expect(composer).to_be_focused()
        composer.fill(IN_THREAD)
        page.keyboard.press("Enter")
        expect(thread.locator(".thread__list")).to_contain_text(IN_THREAD)
        expect(self.replies(page)).to_contain_text("2 replies")
        # The same messages in the decision's panel, the newest at the bottom.
        thread.locator(f'[data-discussed-decision="{self.ids["proposal"]}"] button').click()
        items = self.panel(page).locator(".wd-discussion__list [data-message-id]")
        expect(items).to_have_count(2)
        expect(items.nth(0)).to_contain_text(FIRST)
        expect(items.nth(1)).to_contain_text(IN_THREAD)

    def test_03_a_message_written_elsewhere_arrives_in_the_open_panel_and_on_the_card(self) -> None:
        page = self.page()
        page.goto(f"/projects/{self.ids['project']}?open=decision:{self.ids['proposal']}")
        items = self.panel(page).locator(".wd-discussion__list [data-message-id]")
        expect(items).to_have_count(2)
        talk = self.api(page, "GET", f"/api/v1/decisions/{self.ids['proposal']}/discussion", status=200)
        # Another tab (the same account's session, through the API) replies in the thread: the open panel shows it without a reload.
        self.api(page, "POST", f"/api/v1/conversations/{talk['conversationId']}/messages", {"body": LIVE, "clientMessageId": str(uuid.uuid4())}, status=201)
        expect(items).to_have_count(3, timeout=15000)
        expect(items.nth(2)).to_contain_text(LIVE)
        expect(self.replies(page)).to_contain_text("3 replies", timeout=15000)
        # Discuss on the decision already open puts the cursor in its field and adds no entry.
        length = page.evaluate("history.length")
        self.panel(page).get_by_role("button", name="Discuss").click()
        expect(page.locator("#decision-composer")).to_be_focused()
        self.assertEqual(page.evaluate("history.length"), length)

    # ---------------------------------------------------------------- the phone

    def test_04_on_a_phone_discuss_opens_the_sheet_with_the_field_and_the_thread(self) -> None:
        page = self.page(phone=True)
        page.goto(f"/projects/{self.ids['project']}?open=decision:{self.ids['proposal']}")
        panel = self.panel(page)
        expect(panel).to_contain_text(PROPOSAL)
        panel.get_by_role("button", name="Discuss").tap()
        field = page.locator("#decision-composer")
        expect(field).to_be_focused()
        expect(field).to_be_in_viewport()
        field.fill(ON_PHONE)
        panel.get_by_role("button", name="Send", exact=True).tap()
        items = panel.locator(".wd-discussion__list [data-message-id]")
        expect(items).to_have_count(4)
        expect(items.nth(3)).to_contain_text(ON_PHONE)
        # The thread on the card has it too.
        conversation = self.api(page, "GET", f"/api/v1/decisions/{self.ids['proposal']}/discussion", status=200)["conversationId"]
        talk = self.api(page, "GET", f"/api/v1/conversations/{conversation}", status=200)
        self.assertIn(ON_PHONE, [message["body"] for message in talk["messages"]])
        self.assertEqual(talk["decision"]["decisionId"], self.ids["proposal"])


if __name__ == "__main__":
    unittest.main()
