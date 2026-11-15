"""Browser tests for the one focus model on a computer (F-026 §4 "Where focus goes", persona round 27: P2 1, 2, 3, 6, 7 and the focus P3s).

Each test is one rule of the model, on the engine named by FLUX_UI_BROWSER (run it with chromium and with webkit):

1. Arriving in a conversation by any means (a click, Enter on a sidebar or direct-message row) puts the cursor in its composer, at the end of
   a kept draft. A sentence typed at once is the message: no Create, no task.
2. Arriving to open one thing (`?open=decision:…`, `?open=work:…` in the conversation and in Tasks, a message link) focuses that thing; a
   link to a message with no replies marks it and opens no thread panel. Esc closes what was opened.
3. A picker opens on its first field: New message's Find people.
4. Esc in a composer leaves it for the newest message with the draft kept; then C opens Create. New shows its C only while C works.
5. With a panel open, Esc closes it wherever focus is, the composer included, and keeps the composer's words.
6. After an action removes what had focus (Undo in a toast, Add people, Esc from a board card opened with the mouse) focus goes to the
   obvious next place, never the page body.
"""

from __future__ import annotations

import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, UPSTREAM, press_shortcut, start_forwarder
from test_settings import UI_BROWSER, shot

PASSWORD = "focus goes where you would look"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "piotr": ("Piotr Nowak", f"piotr.fm+{STAMP}@example.test"),
    "kasia": ("Kasia Wrona", f"kasia.fm+{STAMP}@example.test"),
    "lee": ("Lee Moreno", f"lee.fm+{STAMP}@example.test"),
    "ola": ("Ola Nowicka", f"ola.fm+{STAMP}@example.test"),
    # Not in the bakery: nothing waits in her Inbox.
    "nia": ("Nia Okafor", f"nia.fm+{STAMP}@example.test"),
}
SHARED = "Bakery floor"
CLOSED = "Oven repairs"
SENTENCE = "can I swap my Friday shift with Marta? Thanks, see you at the stall."
FEED = ".project-convo__feed.is-stream"
BODY = "() => !document.activeElement || document.activeElement === document.body"


class FocusModel(unittest.TestCase):
    """Tests run in name order and share the accounts and the places."""

    pw = None
    browser: Browser
    contexts: dict[str, BrowserContext] = {}
    states: dict[str, dict] = {}
    ids: dict = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        assert cls.browser.browser_type.name == UI_BROWSER
        expect.set_options(timeout=15000)
        for key, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(base_url=ORIGIN, service_workers="block")
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.contexts[key] = context
            cls.states[key] = context.storage_state()
        workspace = cls.post("piotr", "/api/v1/workspaces", {"name": "Riverside Bakery"})["id"]
        for who in ("kasia", "lee", "ola"):
            cls.post("piotr", f"/api/v1/workspaces/{workspace}/members", {"email": PEOPLE[who][1], "role": "member"})
        shared = cls.post("piotr", f"/api/v1/workspaces/{workspace}/projects", {"name": SHARED, "visibility": "workspace"})["id"]
        cls.ids["shared"] = shared
        cls.ids["closed"] = cls.post("piotr", f"/api/v1/workspaces/{workspace}/projects", {"name": CLOSED, "visibility": "restricted", "people": [cls.ids["kasia"]]})["id"]
        # Everyone of the company is in it: its Add people has only "Someone new?".
        cls.ids["full"] = cls.post("piotr", f"/api/v1/workspaces/{workspace}/projects", {"name": "Night shift", "visibility": "restricted",
                                                                                      "people": [cls.ids["kasia"], cls.ids["lee"], cls.ids["ola"]]})["id"]
        # A task given to Kasia: "Task · Piotr Nowak" in her Inbox.
        cls.ids["given"] = cls.post("piotr", f"/api/v1/projects/{shared}/work", {"title": "Count the screws", "owner": {"kind": "human", "id": cls.ids["kasia"]}})["id"]
        start = lambda who, body: cls.post(who, f"/api/v1/projects/{shared}/conversations", {"body": body, "clientMessageId": str(uuid.uuid4())})  # noqa: E731
        start("piotr", "Saturday's rota is on the Wiki. Tell me if a shift does not work.")
        cls.ids["lone"] = start("piotr", "The flour delivery moved to Thursday.")["messages"][0]["id"]
        cls.ids["task"] = cls.post("piotr", f"/api/v1/projects/{shared}/work", {"title": "Clean the proofing cabinet"})["id"]
        cls.ids["task2"] = cls.post("piotr", f"/api/v1/projects/{shared}/work", {"title": "Order a second mixer bowl"})["id"]
        cls.ids["decision"] = cls.post("piotr", f"/api/v1/projects/{shared}/decisions", {"title": "Open at seven on Saturdays", "rationale": "The market starts at eight."})["id"]
        # A direct message between Kasia and Piotr, so it is a row in Kasia's sidebar.
        dm = cls.contexts["kasia"].request.post(f"/api/v1/workspaces/{workspace}/dms", data={"participantIds": [cls.ids["piotr"]]},
                                                headers={"origin": ORIGIN, "idempotency-key": str(uuid.uuid4())})
        assert dm.status in (200, 201), dm.text()
        cls.ids["dm"] = dm.json()["id"]

    @classmethod
    def tearDownClass(cls) -> None:
        for context in cls.contexts.values():
            context.close()
        cls.browser.close()
        cls.pw.stop()

    @classmethod
    def post(cls, who: str, path: str, body: dict) -> dict:
        response = cls.contexts[who].request.post(path, data=body, headers={"origin": ORIGIN})
        assert response.status in (200, 201), f"{path}: {response.status} {response.text()}"
        return response.json()

    def page(self, who: str = "kasia") -> Page:
        context = self.browser.new_context(base_url=ORIGIN, locale="en-GB", timezone_id="Europe/Warsaw", storage_state=self.states[who],
                                           service_workers="block", viewport=DESKTOP, device_scale_factor=1)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def tasks_in(self, project: str) -> int:
        return self.contexts["piotr"].request.get(f"/api/v1/projects/{project}/work").json()["total"]

    def assert_not_body(self, page: Page, label: str) -> None:
        page.wait_for_timeout(500)
        self.assertFalse(page.evaluate(BODY), f"{label}: focus is not on the page body")

    # ---------------------------------------------------------------- 1. arriving in a conversation

    def test_01_enter_on_a_sidebar_row_arrives_in_the_composer_at_the_end_of_the_draft(self) -> None:
        page = self.page()
        page.goto("/")
        spaces = page.get_by_role("navigation", name="Spaces")
        row = spaces.get_by_role("link", name=re.compile(SHARED))
        expect(row).to_be_visible()
        before = self.tasks_in(self.ids["shared"])
        row.focus()
        page.keyboard.press("Enter")
        page.keyboard.type(SENTENCE)
        composer = page.locator("#project-composer")
        expect(composer).to_be_focused()
        expect(composer).to_have_value(SENTENCE)
        expect(page.get_by_role("dialog")).to_have_count(0)
        # A kept draft: leave the space, come back with Enter, type on; the words go after the draft.
        composer.fill("Draft: bring")
        page.get_by_role("navigation", name="Places").get_by_role("link", name="Home").click()
        expect(page).to_have_url(re.compile(r"/$"))
        row.focus()
        page.keyboard.press("Enter")
        page.keyboard.type(" the trays")
        expect(composer).to_have_value("Draft: bring the trays")
        composer.fill("")
        # The direct message's row, from the keyboard.
        dm = page.get_by_role("navigation", name="Messages").get_by_role("link", name=re.compile("Piotr Nowak"))
        dm.focus()
        page.keyboard.press("Enter")
        page.keyboard.type(SENTENCE)
        expect(page.locator("#dm-composer")).to_be_focused()
        expect(page.locator("#dm-composer")).to_have_value(SENTENCE)
        expect(page.get_by_role("dialog")).to_have_count(0)
        page.locator("#dm-composer").fill("")
        self.assertEqual(self.tasks_in(self.ids["shared"]), before, "nothing typed became a task")

    # ---------------------------------------------------------------- 2. arriving to open one thing

    def test_02_arriving_to_open_one_thing_focuses_it_and_esc_closes_it(self) -> None:
        cases = (("a decision", f"/projects/{self.ids['shared']}?open=decision:{self.ids['decision']}", "Open at seven"),
                 ("a task in the conversation", f"/projects/{self.ids['shared']}?open=work:{self.ids['task']}", "Clean the proofing cabinet"),
                 ("a task in Tasks", f"/projects/{self.ids['shared']}/tasks?open=work:{self.ids['task2']}", "Order a second mixer bowl"))
        for label, path, words in cases:
            with self.subTest(arrival=label):
                page = self.page()
                page.goto(path)
                panel = page.locator("#details")
                expect(panel).to_contain_text(words)
                page.wait_for_timeout(800)
                self.assertTrue(page.evaluate("() => !!document.activeElement.closest('#details')"), f"{label}: the panel has the focus")
                page.keyboard.press("Escape")
                expect(panel).to_be_hidden()
                self.assert_not_body(page, label)

    def test_03_a_message_link_marks_the_message_and_opens_no_empty_thread(self) -> None:
        page = self.page()
        page.goto(f"/projects/{self.ids['shared']}/messages/{self.ids['lone']}")
        message = page.locator(f"#message-{self.ids['lone']}")
        expect(message).to_be_focused()
        expect(message).to_be_in_viewport()
        page.wait_for_timeout(800)
        expect(page.locator("#details")).to_have_count(0)
        expect(page.get_by_text("0 replies")).to_have_count(0)
        expect(page.locator("#project-composer")).not_to_be_focused()

    # ---------------------------------------------------------------- 3. a picker opens on its first field

    def test_04_new_message_opens_on_find_people(self) -> None:
        page = self.page()
        page.goto("/dm/new")
        search = page.get_by_role("searchbox", name="Find people")
        expect(search).to_be_focused()
        page.keyboard.type("Lee")
        expect(search).to_have_value("Lee")
        expect(page.get_by_role("dialog")).to_have_count(0)

    # ---------------------------------------------------------------- 4. Esc leaves a composer; the C hint is true

    def test_05_esc_leaves_the_composer_for_the_newest_message_and_c_works_from_there(self) -> None:
        page = self.page()
        page.goto(f"/projects/{self.ids['shared']}")
        composer = page.locator("#project-composer")
        expect(composer).to_be_focused()
        expect(page.locator(FEED)).not_to_have_class(re.compile("is-opening"))
        hint = page.locator(".side__new kbd")
        expect(hint).to_be_hidden()
        composer.fill("Half a thought")
        page.keyboard.press("Escape")
        expect(composer).not_to_be_focused()
        expect(page.locator(f"{FEED} .project-convo__message").last).to_be_focused()
        expect(composer).to_have_value("Half a thought")
        expect(hint).to_be_visible()
        page.keyboard.press("c")
        expect(page.get_by_role("dialog", name="New task")).to_be_visible()
        page.keyboard.press("Escape")
        expect(page.get_by_role("dialog")).to_have_count(0)
        composer.fill("")

    # ---------------------------------------------------------------- 5. Esc closes a panel wherever focus is

    def test_06_with_a_panel_open_esc_in_the_composer_closes_it_and_keeps_the_words(self) -> None:
        page = self.page()
        page.goto(f"/projects/{self.ids['shared']}?open=work:{self.ids['task']}")
        panel = page.locator("#details")
        expect(panel).to_contain_text("Clean the proofing cabinet")
        composer = page.locator("#project-composer")
        composer.click()
        composer.fill("Before I forget")
        page.keyboard.press("Escape")
        expect(panel).to_be_hidden()
        expect(composer).to_be_focused()
        expect(composer).to_have_value("Before I forget")
        composer.fill("")

    # ---------------------------------------------------------------- 6. never the body after what had focus went away

    def test_07_undo_in_a_toast_gives_focus_back_to_the_control_that_made_the_change(self) -> None:
        page = self.page()
        page.goto(f"/projects/{self.ids['shared']}/tasks?open=work:{self.ids['task2']}")
        status = page.locator("#details").get_by_role("button", name=re.compile("^Status"))
        status.focus()
        page.keyboard.press("Enter")
        page.keyboard.press("ArrowDown")
        page.keyboard.press("Enter")
        undo = page.locator(".ui-toast").get_by_role("button", name=re.compile("^Undo"))
        expect(undo.first).to_be_visible()
        undo.first.focus()
        page.keyboard.press("Enter")
        expect(status).to_be_focused(timeout=5000)

    def test_08_add_people_gives_focus_back_to_add_people(self) -> None:
        page = self.page("piotr")
        page.goto(f"/projects/{self.ids['closed']}/settings")
        add = page.get_by_role("button", name="Add people", exact=True)
        add.click()
        group = page.get_by_role("group", name="Add people")
        group.get_by_role("checkbox", name=re.compile("Lee Moreno")).check()
        group.get_by_role("button", name="Add 1 person").click()
        expect(page.locator(".spset__status")).to_contain_text("Lee is now in")
        expect(add).to_be_focused()

    def test_09_esc_from_a_board_card_opened_with_the_mouse_goes_back_to_the_card(self) -> None:
        page = self.page()
        page.goto(f"/projects/{self.ids['shared']}/tasks")
        board = page.get_by_role("radio", name="Board", exact=True)
        if board.count():
            board.click()
        card = page.locator(f'[data-card-id="{self.ids["task"]}"] .tb-card__open')
        card.click()
        expect(page.locator("#details")).to_contain_text("Clean the proofing cabinet")
        page.keyboard.press("Escape")
        expect(page.locator("#details")).to_be_hidden()
        expect(card).to_be_focused()
        shot(page, "focus-model-board-esc")


    # ---------------------------------------------------------------- persona round 28: the model's holes

    def test_10_invite_opens_on_its_email_field_and_esc_closes_it(self) -> None:
        page = self.page("piotr")
        page.goto("/settings/company")
        invite = page.get_by_role("button", name="Invite", exact=True)
        invite.click()
        page.keyboard.type("gosia@school.test")
        email = page.locator("#people-invite-email")
        expect(email).to_be_focused()
        expect(email).to_have_value("gosia@school.test")
        expect(page.get_by_role("dialog")).to_have_count(0)
        page.keyboard.press("Escape")
        expect(page.get_by_role("region", name="Invite people")).to_have_count(0)
        expect(invite).to_be_focused()
        page.goto("/settings/company?invite=1")
        expect(page.locator("#people-invite-email")).to_be_focused()
        # Closed, the form leaves the address too (persona round 29).
        page.keyboard.press("Escape")
        expect(invite).to_be_focused()
        expect(page).not_to_have_url(re.compile(r"invite="))

    def test_11_with_a_thread_open_esc_in_the_composer_or_the_space_s_own_row_keeps_the_cursor_there(self) -> None:
        thread = self.post("piotr", f"/api/v1/projects/{self.ids['shared']}/conversations", {"body": "Who has the key to the store room?", "clientMessageId": str(uuid.uuid4())})
        self.post("kasia", f"/api/v1/conversations/{thread['id']}/messages", {"body": "Marta had it last.", "clientMessageId": str(uuid.uuid4())})
        page = self.page()
        page.goto(f"/projects/{self.ids['shared']}")
        composer = page.locator("#project-composer")
        expect(composer).to_be_focused()
        replies = page.locator(f"#message-{thread['messages'][0]['id']}").get_by_role("button", name=re.compile("1 reply"))
        for how in ("Esc in the composer", "the space's own row"):
            with self.subTest(how=how):
                replies.click()
                expect(page.locator("#thread-composer")).to_be_focused()
                if how == "Esc in the composer":
                    composer.click()
                    composer.fill("Keys are in the drawer")
                    page.keyboard.press("Escape")
                else:
                    page.get_by_role("navigation", name="Spaces").get_by_role("link", name=re.compile(SHARED)).click()
                expect(page.locator("#details")).to_have_count(0)
                page.keyboard.type(" I swap")
                expect(composer).to_be_focused()
                expect(composer).to_have_value(re.compile(r" I swap$"))
                composer.fill("")

    def test_12_r_on_an_inbox_decision_discusses_it_and_never_runs_the_letters(self) -> None:
        decision = self.post("piotr", f"/api/v1/projects/{self.ids['shared']}/decisions", {"title": "Water the starter at seven", "rationale": "Before the first bake."})
        for _ in range(80):
            if any(item["key"] == f"decision:{decision['id']}" for item in self.contexts["kasia"].request.get("/api/v1/needs-you").json()["items"]):
                break
            time.sleep(0.25)
        page = self.page()
        page.goto("/inbox")
        row = page.locator(f'.nyq__list .nyc[data-key="decision:{decision["id"]}"] .nyc__open')
        row.focus()
        page.keyboard.press("r")
        page.keyboard.type("maybe eight is better")
        # The decision's own field in its panel (its one discussion, founder decision, Hubert, 2026-11-15, #1424), never the space's composer.
        composer = page.locator("#decision-composer")
        expect(composer).to_be_focused()
        expect(composer).to_have_value("maybe eight is better")
        page.wait_for_timeout(500)
        self.assertEqual(self.contexts["piotr"].request.get(f"/api/v1/decisions/{decision['id']}").json()["status"], "proposed", "A did not accept it")
        composer.fill("")

    def test_13_an_open_link_keeps_its_address_a_reload_keeps_it_and_closing_takes_it_off(self) -> None:
        page = self.page()
        page.goto(f"/projects/{self.ids['shared']}/tasks?open=work:{self.ids['task2']}")
        panel = page.locator("#details")
        expect(panel).to_contain_text("Order a second mixer bowl")
        expect(page).to_have_url(re.compile(r"open=work"))
        page.reload()
        expect(panel).to_contain_text("Order a second mixer bowl")
        page.wait_for_timeout(800)
        page.keyboard.press("Escape")
        expect(panel).to_be_hidden()
        expect(page).not_to_have_url(re.compile(r"open="))

    def test_14_new_message_picks_one_match_with_enter_and_a_sentence_and_enter_sends(self) -> None:
        page = self.page()
        page.goto("/dm/new")
        expect(page.locator("#dm-people-search")).to_be_focused()
        page.keyboard.type("Lee")
        expect(page.locator(".dm-new__people li")).to_have_count(1)
        page.keyboard.press("Enter")
        message = page.get_by_role("button", name="Message Lee")
        expect(message).to_be_visible()
        message.click()
        page.keyboard.type("are you in on Friday?")
        page.keyboard.press("Enter")
        expect(page).to_have_url(re.compile(r"/dm/[0-9a-f-]{36}$"))
        expect(page.locator(".dm-msg").filter(has_text="are you in on Friday?")).to_have_count(1)
        expect(page.locator("#dm-composer")).to_have_value("")

    def test_15_the_arrow_keys_move_between_the_sidebar_s_rows_and_g_i_to_an_empty_inbox_focuses_its_heading(self) -> None:
        page = self.page("nia")
        page.goto("/")
        home = page.get_by_role("navigation", name="Places").get_by_role("link", name="Home")
        home.focus()
        page.keyboard.press("ArrowDown")
        expect(page.get_by_role("navigation", name="Places").get_by_role("link", name=re.compile("^Inbox"))).to_be_focused()
        page.keyboard.press("ArrowUp")
        expect(home).to_be_focused()
        page.locator("#content").focus()
        page.keyboard.press("g")
        page.keyboard.press("i")
        expect(page).to_have_url(re.compile(r"/inbox$"))
        expect(page.get_by_role("heading", name="Nothing needs you right now")).to_be_focused()


    # ---------------------------------------------------------------- the UI audit of train 28 (3274a05)

    def test_16_esc_from_an_empty_search_field_closes_the_panel_and_one_with_words_keeps_them(self) -> None:
        page = self.page()
        page.goto(f"/projects/{self.ids['shared']}/tasks?open=work:{self.ids['task2']}")
        panel = page.locator("#details")
        expect(panel).to_contain_text("Order a second mixer bowl")
        search = page.get_by_role("searchbox", name="Search tasks")
        search.fill("mixer")
        search.focus()
        page.keyboard.press("Escape")
        page.wait_for_timeout(400)
        expect(panel).to_be_visible()
        search.fill("")
        search.focus()
        page.keyboard.press("Escape")
        expect(panel).to_be_hidden()

    def test_17_undo_pressed_with_the_mouse_gives_focus_back_to_the_control_that_made_the_change(self) -> None:
        page = self.page()
        page.goto(f"/projects/{self.ids['shared']}/tasks?open=work:{self.ids['task2']}")
        status = page.locator("#details").get_by_role("button", name=re.compile("^Status"))
        status.focus()
        page.keyboard.press("Enter")
        page.keyboard.press("ArrowDown")
        page.keyboard.press("Enter")
        undo = page.locator(".ui-toast").get_by_role("button", name=re.compile("^Undo")).first
        expect(undo).to_be_visible()
        page.wait_for_timeout(400)
        undo.click()
        expect(status).to_be_focused(timeout=5000)

    def test_18_undo_of_a_new_task_closes_its_panel(self) -> None:
        page = self.page()
        page.goto(f"/projects/{self.ids['shared']}")
        expect(page.locator("#project-composer")).to_be_focused()
        press_shortcut(page, "c")
        title = f"Sweep the flour store {uuid.uuid4().hex[:4]}"
        page.get_by_role("dialog", name="New task").get_by_role("textbox", name="Title").fill(title)
        page.keyboard.press("Enter")
        panel = page.locator("#details")
        expect(panel).to_contain_text(title)
        undo = page.locator(".ui-toast").filter(has_text="created").get_by_role("button", name=re.compile("^Undo"))
        page.wait_for_timeout(400)
        undo.click()
        expect(panel).to_be_hidden()
        self.assert_not_body(page, "undone task")


    # ---------------------------------------------------------------- persona round 29

    def test_19_enter_enter_and_a_sentence_typed_at_once_in_new_message_sends_it_whole(self) -> None:
        page = self.page()
        page.goto("/dm/new")
        expect(page.locator("#dm-people-search")).to_be_focused()
        page.keyboard.type("Ola")
        expect(page.locator(".dm-new__people li")).to_have_count(1)
        page.keyboard.press("Enter")
        expect(page.get_by_role("button", name="Message Ola")).to_be_visible()
        sentence = "Ola, the oven timer is broken again."
        page.keyboard.press("Enter")
        page.keyboard.type(sentence)
        page.keyboard.press("Enter")
        expect(page).to_have_url(re.compile(r"/dm/[0-9a-f-]{36}$"))
        expect(page.locator(".dm-msg").filter(has_text=sentence)).to_have_count(1)
        expect(page.locator("#dm-composer")).to_have_value("")

    def test_20_g_i_after_a_sidebar_click_focuses_the_inbox_s_open_item(self) -> None:
        page = self.page()
        page.goto("/")
        page.get_by_role("navigation", name="Places").get_by_role("link", name="My tasks").click()
        expect(page).to_have_url(re.compile(r"/tasks$"))
        page.wait_for_timeout(500)
        page.keyboard.press("g")
        page.keyboard.press("i")
        expect(page).to_have_url(re.compile(r"/inbox$"))
        expect(page.locator(".nyq__list .nyc--open .nyc__open, .nyq__list .nyc .nyc__open").first).to_be_visible()
        page.wait_for_timeout(600)
        self.assertTrue(page.evaluate("() => !!document.activeElement.closest('.nyq')"), "the Inbox's open item has the focus, not the sidebar link")

    def test_21_z_after_s_gives_focus_to_the_item_that_came_back(self) -> None:
        page = self.page()
        page.goto("/inbox")
        rows = page.locator(".nyq__list .nyc__open")
        expect(rows.first).to_be_visible()
        page.wait_for_timeout(600)
        first = page.evaluate("() => document.activeElement.textContent")
        page.keyboard.press("s")
        expect(page.get_by_role("status").filter(has_text="Back tomorrow morning")).to_be_visible()
        page.keyboard.press("z")
        page.wait_for_timeout(800)
        self.assertEqual(page.evaluate("() => document.activeElement.textContent"), first, "the item that came back has the focus")
        self.assertTrue(page.evaluate("() => !!document.activeElement.closest('.nyc--open, .nyc')"))

    def test_22_a_search_result_opened_from_inside_a_space_takes_the_focus(self) -> None:
        body = f"Three sacks of rye on Monday {uuid.uuid4().hex[:4]}"
        root = self.post("piotr", f"/api/v1/projects/{self.ids['shared']}/conversations", {"body": body, "clientMessageId": str(uuid.uuid4())})
        page = self.page()
        page.goto(f"/projects/{self.ids['shared']}")
        expect(page.locator("#project-composer")).to_be_focused()
        page.keyboard.press("Control+k")
        search = page.get_by_role("dialog", name="Search", exact=True)
        search.get_by_role("combobox", name="Search", exact=True).fill(body)
        expect(search.get_by_role("option", name=re.compile("Three sacks of rye"))).to_be_visible(timeout=20000)
        page.keyboard.press("Enter")
        message = page.locator(f"#message-{root['messages'][0]['id']}")
        expect(message).to_be_focused()
        expect(page.locator("#project-composer")).not_to_be_focused()

    def test_23_a_card_opened_on_the_board_gets_its_address_and_back_closes_it(self) -> None:
        page = self.page()
        page.goto(f"/projects/{self.ids['shared']}/tasks")
        board = page.get_by_role("radio", name="Board", exact=True)
        if board.count():
            board.click()
        card = page.locator(f'[data-card-id="{self.ids["task"]}"] .tb-card__open')
        card.click()
        panel = page.locator("#details")
        expect(panel).to_contain_text("Clean the proofing cabinet")
        expect(page).to_have_url(re.compile(r"open=work"))
        page.reload()
        expect(panel).to_contain_text("Clean the proofing cabinet")
        page.go_back()
        expect(page).not_to_have_url(re.compile(r"open="))
        expect(panel).to_be_hidden()


    # ---------------------------------------------------------------- persona round 30

    def test_24_a_task_opened_from_the_inbox_has_its_address_and_esc_returns_to_its_open_item(self) -> None:
        for _ in range(80):
            if any(item.get("task") and item["task"].get("workId") == self.ids["given"] for item in self.contexts["kasia"].request.get("/api/v1/needs-you").json()["items"]):
                break
            time.sleep(0.25)
        page = self.page()
        page.goto("/inbox")
        row = page.locator(".nyq__list .nyc").filter(has_text="Count the screws").locator(".nyc__open")
        expect(row).to_be_visible()
        row.focus()
        page.keyboard.press("Enter")
        page.keyboard.press("Enter")
        panel = page.locator("#details")
        expect(panel).to_contain_text("Count the screws")
        expect(page).to_have_url(re.compile(r"/projects/[0-9a-f-]{36}/tasks\?open=work(:|%3A)"))
        page.reload()
        expect(panel).to_contain_text("Count the screws")
        page.wait_for_timeout(800)
        page.keyboard.press("Escape")
        expect(page).to_have_url(re.compile(r"/inbox$"))
        page.wait_for_timeout(800)
        # Whatever is open now has the ring, so E acts on what is seen.
        self.assertTrue(page.evaluate("() => { const a = document.activeElement; const open = document.querySelector('.nyq__list .nyc[aria-current=\"true\"]'); return !!open && open.contains(a); }"),
                        "focus is on the Inbox's open item")

    def test_25_someone_new_keeps_an_address_typed_at_once(self) -> None:
        page = self.page("piotr")
        page.goto(f"/projects/{self.ids['full']}/settings")
        add = page.get_by_role("button", name="Add people", exact=True)
        add.click()
        page.keyboard.type("marek@bakery.test")
        field = page.get_by_role("group", name="Add people").get_by_label("Someone new?")
        expect(field).to_be_focused()
        expect(field).to_have_value("marek@bakery.test")

    def test_26_after_decide_the_cursor_stays_in_the_composer(self) -> None:
        page = self.page()
        page.goto(f"/projects/{self.ids['shared']}")
        composer = page.locator("#project-composer")
        expect(composer).to_be_focused()
        page.keyboard.type("/decide")
        page.keyboard.press("Enter")
        page.keyboard.type("Paper cups only")
        page.keyboard.press("Enter")
        decision = page.get_by_role("dialog", name="New decision").get_by_role("textbox", name="Decision", exact=True)
        expect(decision).to_be_focused()
        expect(decision).to_have_value("Paper cups only")
        page.keyboard.press("Control+Enter")
        expect(page.get_by_role("dialog")).to_have_count(0)
        page.keyboard.type("ok then")
        expect(composer).to_be_focused()
        expect(composer).to_have_value("ok then")
        composer.fill("")

    def test_27_g_i_in_the_inbox_menus_that_lead_away_and_the_toast_s_key(self) -> None:
        page = self.page()
        page.goto("/inbox")
        expect(page.locator(".nyq__list .nyc__open").first).to_be_visible()
        page.locator("#content").focus()
        page.keyboard.press("g")
        page.keyboard.press("i")
        page.wait_for_timeout(600)
        self.assertTrue(page.evaluate("() => { const open = document.querySelector('.nyq__list .nyc[aria-current=\"true\"]'); return !!open && open.contains(document.activeElement); }"),
                        "G I in the Inbox focuses its open item")
        # Space ⋯ › Settings with the mouse: focus is not left on ⋯.
        page.goto(f"/projects/{self.ids['closed']}")
        more = page.locator("header.top").get_by_role("button", name="More", exact=True)
        more.click()
        page.get_by_role("menu", name="More").get_by_role("menuitem", name="Settings", exact=True).click()
        expect(page.get_by_role("heading", name="Space settings")).to_be_visible()
        page.wait_for_timeout(600)
        expect(more).not_to_be_focused()
        # A toast's Z shows only while Z works: not while the composer has the cursor.
        page.goto(f"/projects/{self.ids['shared']}/tasks?open=work:{self.ids['task2']}")
        status = page.locator("#details").get_by_role("button", name=re.compile("^Status"))
        status.focus()
        page.keyboard.press("Enter")
        page.keyboard.press("ArrowDown")
        page.keyboard.press("Enter")
        key = page.locator(".ui-toast .ui-toast__action kbd").first
        expect(key).to_be_visible()
        page.locator("#details .composer__box textarea").first.focus()
        expect(key).to_be_hidden()

    # ---------------------------------------------------------------- persona round 31

    def wait_for_item(self, who: str, match) -> None:
        for _ in range(80):
            if any(match(item) for item in self.contexts[who].request.get("/api/v1/needs-you").json()["items"]):
                return
            time.sleep(0.25)
        self.fail("the item reached the Inbox")

    def test_28_an_item_arriving_live_never_takes_the_open_item_and_e_acts_on_what_has_the_ring(self) -> None:
        give = lambda title: self.post("piotr", f"/api/v1/projects/{self.ids['shared']}/work", {"title": title, "owner": {"kind": "human", "id": self.ids["lee"]}})["id"]  # noqa: E731
        give("Sweep the shop floor")
        cups = give("Buy paper cups")
        self.wait_for_item("lee", lambda item: item.get("task") and item["task"].get("workId") == cups)
        page = self.page("lee")
        page.goto("/inbox")
        rows = page.locator(".nyq__list .nyc")
        # The newest is at the top: with nothing chosen yet, it is the open item.
        expect(rows.first).to_contain_text("Buy paper cups")
        before = rows.count()
        is_open = page.locator('.nyq__list .nyc[aria-current="true"]')
        expect(is_open).to_contain_text("Buy paper cups")
        page.wait_for_timeout(600)
        antenna = give("Clean the gateway antenna")
        expect(rows).to_have_count(before + 1)
        expect(rows.first).to_contain_text("Clean the gateway antenna")
        page.wait_for_timeout(600)
        # Nothing was chosen with J, K or a click: the open item is still the one with the ring, not the arrival at the top.
        expect(is_open).to_contain_text("Buy paper cups")
        self.assertTrue(page.evaluate("() => { const open = document.querySelector('.nyq__list .nyc[aria-current=\"true\"]'); return !!open && open.contains(document.activeElement); }"),
                        "the ring and the open item stay together")
        page.keyboard.press("e")
        expect(page.locator(".ui-toast")).to_contain_text("moved to Done")
        # The change is held while Undo is offered: the list says which item E acted on.
        expect(rows.filter(has_text="Buy paper cups")).to_have_count(0)
        expect(rows.filter(has_text="Clean the gateway antenna")).to_have_count(1)
        self.assertEqual(self.contexts["piotr"].request.get(f"/api/v1/work/{antenna}").json()["status"], "open", "the arrival nobody looked at is untouched")
        self.assertTrue(cups)

    def test_29_discuss_or_r_from_the_inbox_then_esc_returns_to_the_inbox_and_its_open_item(self) -> None:
        decision = self.post("piotr", f"/api/v1/projects/{self.ids['shared']}/decisions", {"title": "Bake rye on Tuesdays", "rationale": "The rye sells out on Wednesdays."})["id"]
        self.wait_for_item("kasia", lambda item: item["key"] == f"decision:{decision}")
        page = self.page()
        page.goto("/inbox")
        row = page.locator(f'.nyq__list .nyc[data-key="decision:{decision}"]')
        for how in ("Discuss", "R"):
            with self.subTest(how=how):
                row.locator(".nyc__open").focus()
                expect(row).to_have_attribute("aria-current", "true")
                if how == "R":
                    page.keyboard.press("r")
                else:
                    page.locator("#content").get_by_role("button", name="Discuss", exact=True).first.click()
                expect(page.locator("#decision-composer")).to_be_focused()
                page.keyboard.press("Escape")
                expect(page).to_have_url(re.compile(r"/inbox$"))
                page.wait_for_timeout(600)
                self.assertTrue(page.evaluate("(key) => document.querySelector(`.nyq__list .nyc[data-key=\"${key}\"]`)?.contains(document.activeElement)", f"decision:{decision}"),
                                "focus is back on the decision in the Inbox")

    def test_30_discuss_on_a_decision_opened_inside_a_thread_puts_the_cursor_in_its_field(self) -> None:
        thread = self.post("piotr", f"/api/v1/projects/{self.ids['shared']}/conversations", {"body": "Where should the second oven go?", "clientMessageId": str(uuid.uuid4())})
        self.post("kasia", f"/api/v1/conversations/{thread['id']}/messages", {"body": "By the back door, it has power.", "clientMessageId": str(uuid.uuid4())})
        page = self.page()
        page.goto(f"/projects/{self.ids['shared']}/conversations/{thread['id']}")
        reply = page.locator("#thread-composer")
        expect(reply).to_be_focused()
        page.keyboard.type("/decide Move the oven to the back door")
        page.keyboard.press("Enter")
        title = page.get_by_role("dialog", name="New decision").get_by_role("textbox", name="Decision", exact=True)
        expect(title).to_be_focused()
        expect(title).to_have_value("Move the oven to the back door")
        page.keyboard.press("Control+Enter")
        expect(page.get_by_role("dialog")).to_have_count(0)
        card = page.locator("#details [data-decision-card]").filter(has_text="Move the oven to the back door")
        card.click()
        expect(page).to_have_url(re.compile(r"open=decision"))
        page.locator("#details").get_by_role("button", name="Discuss", exact=True).click()
        page.keyboard.type("The wall needs a socket.")
        field = page.locator("#decision-composer")
        expect(field).to_be_focused()
        expect(field).to_have_value("The wall needs a socket.")
        page.wait_for_timeout(500)
        expect(page.get_by_role("dialog")).to_have_count(0)
        field.fill("")

    def test_31_enter_in_add_people_s_filter_picks_the_one_person_found(self) -> None:
        page = self.page("piotr")
        page.goto(f"/projects/{self.ids['closed']}/settings")
        page.get_by_role("button", name="Add people", exact=True).click()
        page.keyboard.type("Ola")
        group = page.get_by_role("group", name="Add people")
        expect(group.get_by_role("searchbox", name="Search people")).to_be_focused()
        page.keyboard.press("Enter")
        expect(group.locator("input[type=checkbox]:checked")).to_have_count(1)
        expect(group.get_by_role("checkbox", name=re.compile("Ola Nowicka"))).to_be_checked()
        expect(page.locator(".spset__status")).not_to_contain_text("is now in")

    def test_32_a_reload_then_back_from_a_task_opened_in_a_thread_shows_the_thread(self) -> None:
        thread = self.post("piotr", f"/api/v1/projects/{self.ids['shared']}/conversations", {"body": "The ladder is in the yard again.", "clientMessageId": str(uuid.uuid4())})
        self.post("kasia", f"/api/v1/conversations/{thread['id']}/messages", {"body": "I will bring it in.", "clientMessageId": str(uuid.uuid4())})
        page = self.page()
        page.goto(f"/projects/{self.ids['shared']}/conversations/{thread['id']}")
        expect(page.locator("#thread-composer")).to_be_focused()
        page.keyboard.type("/task Hang the ladder in the shed")
        page.keyboard.press("Enter")
        title = page.get_by_role("dialog", name="New task").get_by_role("textbox", name="Title", exact=True)
        expect(title).to_be_focused()
        expect(title).to_have_value("Hang the ladder in the shed")
        page.keyboard.press("Control+Enter")
        expect(page.get_by_role("dialog")).to_have_count(0)
        panel = page.locator("#details")
        expect(panel.locator('[data-detail-kind="work"]')).to_contain_text("Hang the ladder in the shed")
        expect(page).to_have_url(re.compile(r"/conversations/[0-9a-f-]{36}\?open=work"))
        page.reload()
        expect(panel.locator('[data-detail-kind="work"]')).to_contain_text("Hang the ladder in the shed")
        page.wait_for_timeout(800)
        page.go_back()
        expect(page).to_have_url(re.compile(r"/conversations/[0-9a-f-]{36}$"))
        expect(page.locator("#thread-composer")).to_be_visible()

    def test_33_r_with_nothing_to_write_holds_the_keys_only_for_a_moment(self) -> None:
        work = self.post("piotr", f"/api/v1/projects/{self.ids['shared']}/work", {"title": "Wipe the counters", "owner": {"kind": "human", "id": self.ids["kasia"]}})["id"]
        self.wait_for_item("kasia", lambda item: item.get("task") and item["task"].get("workId") == work)
        page = self.page()
        page.goto("/inbox")
        task = page.locator(".nyq__list .nyc").filter(has_text="Wipe the counters")
        task.locator(".nyc__open").focus()
        expect(task).to_have_attribute("aria-current", "true")
        last = page.evaluate("() => { const rows = [...document.querySelectorAll('.nyq__list .nyc')]; return rows.at(-1)?.getAttribute('aria-current') === 'true'; }")
        page.keyboard.press("r")
        page.wait_for_timeout(900)
        page.keyboard.press("k" if last else "j")
        expect(task).not_to_have_attribute("aria-current", "true")

    def test_34_accept_with_the_mouse_gives_focus_to_the_next_control_in_every_engine(self) -> None:
        decision = self.post("piotr", f"/api/v1/projects/{self.ids['shared']}/decisions", {"title": "Sell day-old bread at half price", "rationale": "Less goes to waste."})["id"]
        page = self.page("lee")
        page.goto(f"/projects/{self.ids['shared']}")
        page.locator(f'[data-decision-card="{decision}"]').click()
        panel = page.locator("#details")
        accept = panel.get_by_role("button", name="Accept", exact=True)
        expect(accept).to_be_visible()
        accept.click()
        expect(accept).to_have_count(0)
        expect(panel.get_by_role("button", name=re.compile("Add to a Wiki page"))).to_be_focused()

    def test_35_enter_enter_and_a_sentence_typed_while_new_message_still_loads_its_people_sends_it_whole(self) -> None:
        page = self.page()
        held: list = []
        holding = [True]
        page.route(re.compile(r"/api/v1/workspaces/[0-9a-f-]{36}/members(\?|$)"), lambda route: held.append(route) if holding[0] else route.continue_())
        page.goto("/dm/new")
        expect(page.locator("#dm-people-search")).to_be_focused()
        expect(page.get_by_text("Loading people…")).to_be_visible()
        sentence = "Ola, the flour came early."
        page.keyboard.type("Ola")
        page.keyboard.press("Enter")
        page.keyboard.press("Enter")
        page.keyboard.type(sentence)
        holding[0] = False
        for route in held:
            route.continue_()
        composer = page.locator("#dm-composer")
        expect(composer).to_be_focused()
        expect(composer).to_have_value(sentence)
        expect(page.locator("#dm-people-search")).to_have_count(0)
        composer.fill("")


if __name__ == "__main__":
    unittest.main()
