"""#1419 part A: the composer: `/` lists four commands, `@` people only, `/decide` opens the one Create window.

Runs through scripts/check_ui.sh against the running Compose application, on the engine named by FLUX_UI_BROWSER."""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, start_forwarder

PASSWORD = "one way to do each thing"
STAMP = int(time.time() * 1000)
ADA = {"name": "Ada Kowalska", "email": f"ada.ux+{STAMP}@example.test"}
JONAS = {"name": "Jonas Berg", "email": f"jonas.ux+{STAMP}@example.test"}
OPENING = "Which supplier do we order the probes from?"


class UxSimplicityPartAComposer(unittest.TestCase):
    pw = None
    browser = None
    ada_state: dict = {}
    jonas_state: dict = {}
    ids: dict = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=10000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def sign_up(self, person: dict) -> tuple[Page, dict]:
        context = self.browser.new_context(base_url=ORIGIN, locale="en-GB", service_workers="block", viewport=DESKTOP)
        self.addCleanup(context.close)
        page = context.new_page()
        page.goto("/sign-up")
        page.get_by_label("Name").fill(person["name"])
        page.get_by_label("Email").fill(person["email"])
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        return page, context.storage_state()

    def api(self, page: Page, method: str, path: str, body: dict | None = None, status: int = 201) -> dict:
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers={"origin": ORIGIN, "content-type": "application/json", "idempotency-key": str(uuid.uuid4())},
                                      data=json.dumps(body) if body is not None else None)
        self.assertEqual(response.status, status, response.text())
        return json.loads(response.text()) if response.text() else {}

    def ensure_world(self) -> None:
        if self.ids:
            return
        jonas_page, jonas_state = self.sign_up(JONAS)
        jonas_id = self.api(jonas_page, "GET", "/api/v1/me", None, 200)["user"]["id"]
        ada_page, ada_state = self.sign_up(ADA)
        workspace = self.api(ada_page, "POST", "/api/v1/workspaces", {"name": "Riverside Makers"})["id"]
        self.api(ada_page, "POST", f"/api/v1/workspaces/{workspace}/members", {"email": JONAS["email"], "role": "member"})
        project = self.api(ada_page, "POST", f"/api/v1/workspaces/{workspace}/projects", {"name": "Community garden sensors", "visibility": "restricted"})["id"]
        self.api(ada_page, "POST", f"/api/v1/projects/{project}/grants", {"principal": {"kind": "human", "id": jonas_id}, "role": "contributor"})
        conversation = self.api(ada_page, "POST", f"/api/v1/projects/{project}/conversations", {"body": OPENING, "clientMessageId": str(uuid.uuid4())})
        self.api(ada_page, "POST", f"/api/v1/workspaces/{workspace}/agents", {"name": "Planner Bot", "owner": "self"})
        dm = self.api(ada_page, "POST", f"/api/v1/workspaces/{workspace}/dms", {"participantIds": [jonas_id]})
        type(self).ada_state, type(self).jonas_state = self.ada_state or ada_state, jonas_state
        type(self).ids = {"workspace": workspace, "project": project, "conversation": conversation["id"], "message": conversation["messages"][0]["id"], "dm": dm["id"]}

    def page(self, who: str = "ada", *, phone: bool = False) -> Page:
        self.ensure_world()
        context = self.browser.new_context(base_url=ORIGIN, locale="en-GB", service_workers="block", viewport=PHONE if phone else DESKTOP,
                                           storage_state=self.ada_state if who == "ada" else self.jonas_state, has_touch=phone, is_mobile=phone)
        self.addCleanup(context.close)
        return context.new_page()

    def space(self, page: Page) -> None:
        page.goto(f"/projects/{self.ids['project']}")
        expect(page.get_by_label("Write a message", exact=True)).to_be_visible()

    def thread(self, page: Page) -> None:
        page.goto(f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}")
        expect(page.get_by_label("Reply", exact=True)).to_be_visible()

    def test_01_the_slash_menu_has_the_four_commands_of_the_design_and_no_more(self) -> None:
        page = self.page()
        for place, field in (("space", "Write a message"), ("thread", "Reply")):
            with self.subTest(place=place):
                self.space(page) if place == "space" else self.thread(page)
                box = page.get_by_label(field, exact=True)
                box.fill("/")
                menu = page.get_by_role("listbox", name="Actions")
                expect(menu).to_be_visible()
                self.assertEqual(menu.get_by_role("option").locator(".cmenu__cmd").all_inner_texts(), ["/task", "/decide", "/file", "/ai"])
                for gone in ("/map", "/handoff", "/source"):
                    box.fill(gone)
                    expect(page.get_by_role("listbox", name="Actions")).to_have_count(0)
                box.fill("")

    def test_02_at_lists_people_only_never_the_assistant_or_an_agent(self) -> None:
        page = self.page()
        self.space(page)
        box = page.get_by_label("Write a message", exact=True)
        box.fill("@")
        people = page.get_by_role("listbox", name="Mention")
        expect(people.get_by_role("option")).to_have_count(1)
        expect(people.get_by_role("option").first).to_contain_text("Jonas Berg")
        expect(people.get_by_role("option").first).to_contain_text("Person")
        expect(people).not_to_contain_text("My assistant")
        expect(people).not_to_contain_text("Agent")
        for name in ("Plan", "Assist"):
            box.fill(f"@{name}")
            expect(page.get_by_role("listbox", name="Mention")).to_have_count(0)
        # The `/` menu is its commands and nothing under them: the composer's hint already says "@ mention" (#1424).
        box.fill("/")
        menu = page.get_by_role("listbox", name="Actions")
        expect(menu).to_be_visible()
        expect(menu.locator(".cmenu__f")).to_have_count(0)
        expect(menu).not_to_contain_text("Type @")

    def test_02b_a_direct_messages_slash_menu_has_what_applies_there_in_the_spaces_words(self) -> None:
        """#1424 (#1419 item 11): `/file` and `/ai` in a direct message, with a space's hints; `/file` opens the picker; the hint says `/` is there."""
        page = self.page()
        page.goto(f"/dm/{self.ids['dm']}")
        box = page.locator("#dm-composer")
        expect(box).to_be_visible()
        expect(box).to_have_attribute("placeholder", "Message Jonas · / actions")
        box.fill("/")
        menu = page.get_by_role("listbox", name="Actions")
        expect(menu).to_be_visible()
        self.assertEqual(menu.get_by_role("option").locator(".cmenu__cmd").all_inner_texts(), ["/file", "/ai"])
        self.assertEqual(menu.get_by_role("option").locator(".cmenu__hint").all_inner_texts(), ["Attach a file or link", "Ask your assistant"])
        expect(menu.locator(".cmenu__f")).to_have_count(0)
        for gone in ("/task", "/decide"):
            box.fill(gone)
            expect(page.get_by_role("listbox", name="Actions")).to_have_count(0)
        box.fill("/fi")
        with page.expect_file_chooser(timeout=15000) as chooser:
            page.get_by_role("listbox", name="Actions").get_by_role("option", selected=True).click()
        chooser.value.set_files({"name": "probe-notes.txt", "mimeType": "text/plain", "buffer": b"probe 4 reads high\n"})
        expect(page.get_by_text("probe-notes.txt")).to_be_visible()
        expect(box).to_have_value("")

    def test_03_decide_opens_the_one_create_window_with_its_words_and_the_message_as_source(self) -> None:
        page = self.page()
        self.thread(page)
        reply = page.get_by_label("Reply", exact=True)
        reply.fill("/decide Order from the second supplier")
        reply.press("Enter")
        window = page.get_by_role("dialog", name="New decision")
        expect(window).to_be_visible()
        # The same window as New › Decision, in the same words; no second form in the side panel (#1419).
        expect(page.get_by_role("heading", name="Propose a decision")).to_have_count(0)
        expect(window.get_by_role("textbox", name="Decision", exact=True)).to_have_value("Order from the second supplier")
        expect(window.get_by_placeholder("What is being decided?")).to_be_visible()
        expect(window.get_by_placeholder("Why this is the right call (optional)")).to_be_visible()
        expect(window.locator(".create__source")).to_contain_text(OPENING)
        expect(window.get_by_role("button", name="Replace an accepted decision…")).to_be_visible()
        expect(window).not_to_contain_text("write access")
        # The words stay in the composer until the decision is proposed (closing the window loses nothing).
        window.get_by_role("button", name="Close", exact=True).click()
        expect(reply).to_have_value("/decide Order from the second supplier")
        reply.press("Enter")
        window = page.get_by_role("dialog", name="New decision")
        # Replace an accepted decision… is a choice in the same window, and the keyboard goes on to it.
        window.get_by_role("button", name="Replace an accepted decision…").click()
        expect(window.get_by_label("Does it replace an earlier decision?")).to_be_focused()
        window.get_by_role("button", name=re.compile("^Propose decision")).click()
        expect(page.locator(".ui-toast", has_text="Decision proposed")).to_be_visible()
        # #1424: the Undo toast stands above the composer, never on its hint or Send.
        page.wait_for_timeout(700)
        toast = page.locator(".ui-toast", has_text="Decision proposed").bounding_box()
        field = reply.locator("xpath=ancestor::div[contains(@class,'composer__box')]").bounding_box()
        self.assertLessEqual(toast["y"] + toast["height"], field["y"], f"the toast {toast} stands on the composer {field}")
        # Proposed: the words leave the composer at once, so they are not sent again while the proposal waits out its Undo.
        expect(reply).to_have_value("")
        found = None
        for _ in range(80):
            found = next((item for item in self.api(page, "GET", f"/api/v1/projects/{self.ids['project']}/decisions?limit=100", None, 200)["items"]
                          if item["title"] == "Order from the second supplier"), None)
            if found:
                break
            page.wait_for_timeout(250)
        self.assertIsNotNone(found, "the proposal was sent when the Undo window ended")
        self.assertEqual(found["status"], "proposed")
        expect(reply).to_have_value("")


if __name__ == "__main__":
    unittest.main()
