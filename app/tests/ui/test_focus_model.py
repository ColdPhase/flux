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
        composer = page.locator("#project-composer")
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


if __name__ == "__main__":
    unittest.main()
