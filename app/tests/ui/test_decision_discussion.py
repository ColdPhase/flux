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

from create_window import window
from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, start_forwarder

PASSWORD = "one discussion in both places"
STAMP = int(time.time() * 1000)
ADA = {"name": "Ada Lind", "email": f"ada.discuss+{STAMP}@example.test"}
# Your own proposal never waits in your Inbox (#763 FT-8): Cy proposes, so it waits in Ada's.
CY = {"name": "Cy Moreau", "email": f"cy.discuss+{STAMP}@example.test"}
MESSAGE = "Should the probes in bed 5 be replaced before the frost?"
PROPOSAL = "Replace the bed 5 probes with capacitive ones"
DRAFT = "An unrelated note for the space"
FIRST = "Do capacitive probes need a heater in winter?"
IN_THREAD = "Only below minus ten, the datasheet says."
LIVE = "I ordered two to try in bed 5."
ON_PHONE = "Then we replace them on Saturday."
EDITED = "I ordered three to try in bed 5."
BEN = {"name": "Ben Ortiz", "email": f"ben.discuss+{STAMP}@example.test"}
SECOND = "Move the lamp sensor to the north wall"
TO_BEN = "Ben, the north wall gets less sun. Does that work for you?"
THIRD = "Paint the lamp base green"
ASKED = "Who buys the paint?"
FROM_BEN = "The north wall is fine by me."


class DecisionDiscussion(unittest.TestCase):
    """Tests run in name order and share one account, one space and one proposal."""

    pw = None
    browser: Browser
    state: dict = {}
    ids: dict = {}
    ben: dict = {}

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
        cy = self.browser.new_context(base_url=ORIGIN, service_workers="block")
        self.addCleanup(cy.close)
        signed = cy.request.post("/api/auth/sign-up/email", data={"email": CY["email"], "password": PASSWORD, "name": CY["name"]}, headers={"origin": ORIGIN})
        self.assertEqual(signed.status, 200, signed.text())
        cy_id = cy.request.get("/api/v1/me").json()["user"]["id"]
        self.api(page, "POST", f"/api/v1/workspaces/{ws['id']}/members", {"email": CY["email"], "role": "member"})
        project = self.api(page, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Garden sensors", "visibility": "restricted", "people": [cy_id]}, status=201)
        pid = project["id"]
        self.api(page, "POST", f"/api/v1/projects/{pid}/conversations", {"body": MESSAGE, "clientMessageId": str(uuid.uuid4())}, status=201)
        response = cy.request.post(f"/api/v1/projects/{pid}/decisions", data={"title": PROPOSAL, "rationale": "Capacitive probes do not corrode"}, headers={"origin": ORIGIN})
        self.assertEqual(response.status, 201, response.text())
        proposal = response.json()
        type(self).ids = {"project": pid, "proposal": proposal["id"], "workspace": ws["id"]}

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


    # ---------------------------------------------------------------- an edit or a delete elsewhere

    def test_05_an_edit_and_a_delete_elsewhere_show_in_the_open_panel(self) -> None:
        page = self.page()
        page.goto(f"/projects/{self.ids['project']}?open=decision:{self.ids['proposal']}")
        talk = self.api(page, "GET", f"/api/v1/decisions/{self.ids['proposal']}/discussion", status=200)
        live = next(message for message in talk["messages"] if message["body"] == LIVE)
        item = self.panel(page).locator(f'.wd-discussion__list [data-message-id="{live["id"]}"]')
        expect(item).to_contain_text(LIVE)
        # Another tab of the same person edits it, then deletes it: the open panel follows without a reload, as the thread does.
        self.api(page, "PATCH", f"/api/v1/conversations/{talk['conversationId']}/messages/{live['id']}", {"body": EDITED}, status=200)
        expect(item).to_contain_text(EDITED, timeout=15000)
        expect(item).to_contain_text("edited")
        removed = page.request.delete(f"{ORIGIN}/api/v1/conversations/{talk['conversationId']}/messages/{live['id']}", headers={"origin": ORIGIN})
        self.assertEqual(removed.status, 200, removed.text())
        expect(item.locator(".message-body--removed")).to_be_visible(timeout=15000)
        expect(item).not_to_contain_text(EDITED)

    # ---------------------------------------------------------------- where you left off

    def test_06_the_new_divider_stands_above_a_first_message_someone_else_wrote(self) -> None:
        owner = self.page()
        owner.goto("/")
        ben_context = self.browser.new_context(base_url=ORIGIN, locale="en-GB", timezone_id="Europe/Warsaw", viewport=DESKTOP, service_workers="block")
        self.addCleanup(ben_context.close)
        signed = ben_context.request.post("/api/auth/sign-up/email", data={"email": BEN["email"], "password": PASSWORD, "name": BEN["name"]}, headers={"origin": ORIGIN})
        self.assertEqual(signed.status, 200, signed.text())
        ben_id = ben_context.request.get("/api/v1/me").json()["user"]["id"]
        self.api(owner, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/members", {"email": BEN["email"], "role": "member"})
        place = self.api(owner, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/projects", {"name": "Lamp", "visibility": "restricted", "people": [ben_id]}, status=201)
        decision = self.api(owner, "POST", f"/api/v1/projects/{place['id']}/decisions", {"title": SECOND, "rationale": "Less sun on the sensor"}, status=201)
        first = self.api(owner, "POST", f"/api/v1/decisions/{decision['id']}/discussion", {"body": TO_BEN, "clientMessageId": str(uuid.uuid4())}, status=201)
        type(self).ids.update(lamp=place["id"], second=decision["id"], second_talk=first["conversationId"])
        type(self).ben = ben_context.storage_state()
        page = ben_context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        page.goto(f"/projects/{place['id']}")
        replies = page.locator(f'[data-decision-replies="{decision["id"]}"]').first
        expect(replies).to_contain_text("1 reply")
        replies.click()
        thread = page.locator("#thread")
        expect(thread.locator(f'[data-discussed-decision="{decision["id"]}"]')).to_contain_text(SECOND)
        # Never opened: everything in it is new, so the divider stands above its first message, which is a reply to the decision.
        divider = thread.locator("[data-unread-start]")
        expect(divider).to_have_count(1)
        expect(thread.locator("[data-unread-start] + li")).to_contain_text(TO_BEN)
        expect(thread.locator("[data-unread-start] + li"), "the divider stands right above that first message").to_have_attribute("data-message-id", first["id"])


    # ---------------------------------------------------------------- round 8: who a question asks, one form in both places

    def ben_page(self, *, phone: bool = False) -> Page:
        options: dict = {"base_url": ORIGIN, "locale": "en-GB", "timezone_id": "Europe/Warsaw", "viewport": PHONE if phone else DESKTOP, "service_workers": "block",
                         "storage_state": self.ben}
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        return context.new_page()

    def test_07_a_question_that_names_nobody_asks_the_proposer_about_the_decision(self) -> None:
        ben = self.ben_page()
        ben.goto("/")
        third = self.api(ben, "POST", f"/api/v1/projects/{self.ids['lamp']}/decisions", {"title": THIRD}, status=201)
        owner = self.page()
        owner.goto("/")
        # Ada writes first, then asks a question that names nobody: it asks Ben, who proposed the decision, never Ada, who wrote first.
        self.api(owner, "POST", f"/api/v1/decisions/{third['id']}/discussion", {"body": "I like the idea.", "clientMessageId": str(uuid.uuid4())}, status=201)
        self.api(owner, "POST", f"/api/v1/decisions/{third['id']}/discussion", {"body": ASKED, "clientMessageId": str(uuid.uuid4())}, status=201)
        ben.goto("/inbox")
        row = ben.locator(".nyc", has_text=ASKED)
        expect(row).to_be_visible(timeout=15000)
        expect(row).to_contain_text("Question")
        expect(row).to_contain_text(ADA["name"])
        expect(row, "the line says which decision it is about").to_contain_text(f"about “{THIRD}”")

    def test_08_the_panel_names_people_as_the_thread_does_and_what_it_shows_is_read_there(self) -> None:
        ben = self.ben_page()
        ben.goto("/")
        said = self.api(ben, "POST", f"/api/v1/decisions/{self.ids['second']}/discussion", {"body": FROM_BEN, "clientMessageId": str(uuid.uuid4())}, status=201)
        page = self.page()
        page.goto(f"/projects/{self.ids['lamp']}?open=decision:{self.ids['second']}")
        panel = page.get_by_role("complementary", name="Details").locator(f".wd[data-detail-id='{self.ids['second']}']")
        theirs = panel.locator(f'[data-message-id="{said["id"]}"]')
        expect(theirs).to_contain_text(FROM_BEN)
        expect(theirs.locator(".wd-act__who b"), "a full name, as the thread names him").to_have_text(BEN["name"])
        expect(panel.locator(".wd-act__who b", has_text="(you)").first).to_have_text(f"{ADA['name']} (you)")
        # Read in the panel: the thread does not call it new.
        for _ in range(60):
            if self.api(page, "GET", f"/api/v1/conversations/{self.ids['second_talk']}", status=200).get("unreadFrom") is None:
                break
            page.wait_for_timeout(250)
        self.assertIsNone(self.api(page, "GET", f"/api/v1/conversations/{self.ids['second_talk']}", status=200).get("unreadFrom"), "the panel recorded it as read")
        page.goto(f"/projects/{self.ids['lamp']}")
        page.locator(f'[data-decision-replies="{self.ids["second"]}"]').first.click()
        thread = page.locator("#thread")
        expect(thread.locator(f'[data-message-id="{said["id"]}"]')).to_contain_text(FROM_BEN)
        expect(thread.locator("[data-unread-start]"), "no New divider above what was read in the panel").to_have_count(0)
        expect(thread.locator(f'[data-message-id="{said["id"]}"] .project-convo__message-meta')).to_contain_text(BEN["name"])

    def test_09_on_a_phone_the_threads_composer_says_what_it_is_about(self) -> None:
        page = self.page(phone=True)
        page.goto(f"/projects/{self.ids['lamp']}/conversations/{self.ids['second_talk']}")
        line = page.locator(".project-convo__current-thread")
        expect(line).to_have_text(f"About “{SECOND}”")

    def test_10_the_decision_window_says_the_true_thing_to_a_spaces_only_member(self) -> None:
        owner = self.page()
        owner.goto("/")
        solo = self.api(owner, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/projects", {"name": "Solo bench", "visibility": "restricted"}, status=201)
        for project, words in ((solo["id"], "Only you are in this space: it stays on its card until you accept it"), (self.ids["lamp"], "Everyone else in the space sees it in their Inbox")):
            with self.subTest(project=project):
                page = self.page()
                page.goto(f"/projects/{project}")
                composer = page.locator("#project-composer")
                expect(composer).to_be_visible()
                composer.fill("/decide Try a new probe")
                composer.press("Enter")
                expect(window(page)).to_be_visible()
                expect(window(page).get_by_text(words, exact=True)).to_be_visible()
                page.keyboard.press("Escape")

    # ---------------------------------------------------------------- personas-33 P2 3: every message reachable, oldest first

    def test_11_a_long_discussion_shows_every_message_oldest_first_with_show_earlier_in_both_panels(self) -> None:
        page = self.page()
        page.goto("/")
        pid = self.ids["project"]
        task = self.api(page, "POST", f"/api/v1/projects/{pid}/work", {"title": "Label every probe"}, status=201)
        decision = self.api(page, "POST", f"/api/v1/projects/{pid}/decisions", {"title": "Label probes with their bed", "rationale": "Easier to find"}, status=201)
        task_words = [f"Probe label {n:02d}" for n in range(1, 26)]
        decision_words = [f"Bed note {n:02d}" for n in range(1, 56)]
        for words in task_words:
            self.api(page, "POST", f"/api/v1/work/{task['id']}/discussion", {"body": words, "clientMessageId": str(uuid.uuid4())}, status=201)
        for words in decision_words:
            self.api(page, "POST", f"/api/v1/decisions/{decision['id']}/discussion", {"body": words, "clientMessageId": str(uuid.uuid4())}, status=201)
        cases = ((f"/projects/{pid}/tasks?open=work:{task['id']}", ".wd-act .wd-act__item--message .message-body", task_words),
                 (f"/projects/{pid}?open=decision:{decision['id']}", ".wd-discussion__list .wd-act__item--message .message-body", decision_words))
        for path, selector, words in cases:
            with self.subTest(path=path):
                page.goto(path)
                bodies = page.locator("#details").locator(selector)
                expect(bodies.last).to_have_text(words[-1])
                earlier = page.locator("#details").get_by_role("button", name="Show earlier", exact=True)
                # Something is missing between the first message and the newest page: "Show earlier" is at the top of the discussion.
                expect(earlier).to_be_visible()
                while earlier.count():
                    earlier.click()
                    page.wait_for_timeout(300)
                expect(bodies).to_have_count(len(words))
                self.assertEqual([text.strip() for text in bodies.all_inner_texts()], words, "every message, once, oldest first")

    # ---------------------------------------------------------------- personas-33/34 P3: one name, one way to open, the decision named

    def test_12_the_task_panel_names_people_as_the_decision_panel_does(self) -> None:
        """personas-33: the task panel said "Ada", "Jonas" where the decision panel and the thread said "Jonas Berg (you)", "Tomek Wiśniewski"."""
        owner = self.page()
        owner.goto("/")
        task = self.api(owner, "POST", f"/api/v1/projects/{self.ids['lamp']}/work", {"title": "Mount the lamp sensor on the north wall"}, status=201)
        ben = self.ben_page()
        ben.goto("/")
        said = self.api(ben, "POST", f"/api/v1/work/{task['id']}/discussion", {"body": "I can bring the ladder on Friday.", "clientMessageId": str(uuid.uuid4())}, status=201)
        mine = self.api(owner, "POST", f"/api/v1/work/{task['id']}/discussion", {"body": "Thank you, Friday works.", "clientMessageId": str(uuid.uuid4())}, status=201)
        owner.goto(f"/projects/{self.ids['lamp']}/tasks?open=work:{task['id']}")
        panel = owner.locator("#details")
        expect(panel.locator(f'[data-message-id="{said["id"]}"] .wd-act__who b'), "a full name, as the decision panel and the thread name him").to_have_text(BEN["name"])
        expect(panel.locator(f'[data-message-id="{mine["id"]}"] .wd-act__who b'), "the reader as every view names her").to_have_text(f"{ADA['name']} (you)")

    def test_13_a_reply_in_a_decisions_discussion_is_named_by_the_decision_on_home(self) -> None:
        """personas-34: for someone who was not asked, Home said "Ben replied in “<its first message>”"; it is about the decision."""
        owner = self.page()
        owner.goto("/")
        decision = self.api(owner, "POST", f"/api/v1/projects/{self.ids['lamp']}/decisions", {"title": "Put the tool library stand by the gate", "rationale": "Closer to the street"}, status=201)
        mark = self.api(owner, "GET", "/api/v1/return?place=home", status=200)["mark"]
        self.api(owner, "PUT", "/api/v1/return-points", {"place": {"type": "home"}, "mark": mark}, status=200)
        ben = self.ben_page()
        ben.goto("/")
        self.api(ben, "POST", f"/api/v1/decisions/{decision['id']}/discussion", {"body": "First thought: the gate gets the morning sun.", "clientMessageId": str(uuid.uuid4())}, status=201)
        texts: list[str] = []
        for _ in range(40):
            texts = [item["text"] for item in self.api(owner, "GET", "/api/v1/return?place=home", status=200)["items"] if item["kind"] == "message"]
            if texts:
                break
            owner.wait_for_timeout(250)
        self.assertIn(f"{BEN['name']} replied about “Put the tool library stand by the gate”", texts)
        self.assertFalse([text for text in texts if "First thought" in text], "never named by its first message")

    def test_14_the_task_panel_and_the_decision_panel_open_the_same_way_at_the_newest(self) -> None:
        """personas-34: the task panel opened at its top and the decision panel at its newest message; both open at the newest."""
        page = self.page()
        page.goto("/")
        pid = self.ids["lamp"]
        task = self.api(page, "POST", f"/api/v1/projects/{pid}/work", {"title": "Seal the lamp housing"}, status=201)
        decision = self.api(page, "POST", f"/api/v1/projects/{pid}/decisions", {"title": "Seal the housing with silicone", "rationale": "It keeps the rain out"}, status=201)
        for n in range(1, 19):
            self.api(page, "POST", f"/api/v1/work/{task['id']}/discussion", {"body": f"Housing note {n:02d}: the seam on the left side needs another pass.", "clientMessageId": str(uuid.uuid4())}, status=201)
            self.api(page, "POST", f"/api/v1/decisions/{decision['id']}/discussion", {"body": f"Seal note {n:02d}: the seam on the left side needs another pass.", "clientMessageId": str(uuid.uuid4())}, status=201)
        cases = ((f"/projects/{pid}/tasks?open=work:{task['id']}", ".wd-act .wd-act__item--message .message-body", "Housing note 18"),
                 (f"/projects/{pid}?open=decision:{decision['id']}", ".wd-discussion__list .wd-act__item--message .message-body", "Seal note 18"))
        for path, selector, newest in cases:
            with self.subTest(path=path):
                page.goto(path)
                bodies = page.locator("#details").locator(selector)
                expect(bodies.last).to_contain_text(newest)
                page.wait_for_timeout(500)
                expect(bodies.last, "the panel opens with its newest message in view").to_be_in_viewport()


if __name__ == "__main__":
    unittest.main()
