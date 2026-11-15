"""Persona round 4 (personas-27, train/v021-27): nothing shown that was undone, and one answer to "is something waiting for me?".

Runs through scripts/check_ui.sh against the running Compose application, on the engine named by FLUX_UI_BROWSER (run it with chromium
and with webkit), on a computer (1440 x 900):

* P2 4: a task whose creation was undone leaves the space's conversation for every reader: the "N task updates" fold neither lists
  it nor counts it, live in an open stream and after a reload, for its author and for another reader.
* P2 5: a question in a thread that names nobody is the starter's: it is on the starter's Home under Waiting for you and in their
  Inbox (never only as "Answer Jonas's question" under Continue), and someone else who wrote in the thread is asked nothing.
"""

from __future__ import annotations

import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, UI_BROWSER, UPSTREAM, start_forwarder

PASSWORD = "round four feed and questions"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ada": ("Ada Kowalska", f"ada.round4+{STAMP}@example.test"),
    "jonas": ("Jonas Berg", f"jonas.round4+{STAMP}@example.test"),
    "maja": ("Maja Lindqvist", f"maja.round4+{STAMP}@example.test"),
}
TASKS = ["Order flour for Saturday", "Private note do not share", "Clean the proofing baskets", "Book the van for the market"]
UNDONE = TASKS[1]
QUESTION = "Which size, small or large?"


class FeedAndQuestions(unittest.TestCase):
    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}

    @classmethod
    def call(cls, who: str, method: str, path: str, body: dict | None = None) -> dict:
        context = cls.browser.new_context(base_url=ORIGIN, storage_state=cls.states[who], service_workers="block")
        try:
            response = context.request.fetch(path, method=method, data=body, headers={"origin": ORIGIN})
            assert response.status in (200, 201), f"{method} {path}: {response.status} {response.text()}"
            return response.json() if response.text() else {}
        finally:
            context.close()

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        assert cls.browser.browser_type.name == UI_BROWSER
        print(f"ACTUAL_UI_ENGINE={cls.browser.browser_type.name}", flush=True)
        expect.set_options(timeout=15000)
        for key, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(base_url=ORIGIN, service_workers="block")
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.states[key] = context.storage_state()
            context.close()
        workspace = cls.call("ada", "POST", "/api/v1/workspaces", {"name": "Bakery"})["id"]
        for key in ("jonas", "maja"):
            cls.call("ada", "POST", f"/api/v1/workspaces/{workspace}/members", {"email": PEOPLE[key][1], "role": "member"})
        cls.ids["project"] = cls.call("ada", "POST", f"/api/v1/workspaces/{workspace}/projects", {"name": "Morning shift", "visibility": "workspace"})["id"]
        cls.ids["questions"] = cls.call("ada", "POST", f"/api/v1/workspaces/{workspace}/projects", {"name": "Trays", "visibility": "workspace"})["id"]
        project = cls.ids["project"]
        cls.call("ada", "POST", f"/api/v1/projects/{project}/conversations", {"body": "Saturday prep starts at six.", "clientMessageId": str(uuid.uuid4())})
        # Four tasks in a row, one day, no message between: one "4 task updates" fold.
        for index, title in enumerate(TASKS):
            made = cls.call("ada", "POST", f"/api/v1/projects/{project}/work", {"title": title, "clientCommandId": str(uuid.uuid4())})
            cls.ids[f"task{index}"] = made["id"]
            cls.ids[f"version{index}"] = str(made["version"])

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, who: str) -> Page:
        context = self.browser.new_context(service_workers="block", base_url=ORIGIN, locale="en-GB", timezone_id="Europe/Warsaw",
                                           storage_state=self.states[who], viewport=DESKTOP, device_scale_factor=1)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def fold(self, page: Page):
        return page.locator(".project-convo__message-list .convo-fold")

    def test_01_an_undone_task_leaves_every_readers_feed(self) -> None:
        project = self.ids["project"]
        jonas = self.page("jonas")
        jonas.goto(f"/projects/{project}")
        expect(self.fold(jonas).locator(".convo-fold__t b")).to_have_text("4 task updates")
        # Ada takes back her own new task (the toast's Undo is this command).
        self.call("ada", "POST", f"/api/v1/work/{self.ids['task1']}/creation-undo",
                  {"clientCommandId": str(uuid.uuid4()), "expectedVersion": int(self.ids["version1"])})
        undone = f'.convo-notice[data-work-id="{self.ids["task1"]}"]'
        # Live, in the open stream of another reader: neither listed nor counted, and no "Undone" card.
        expect(self.fold(jonas).locator(".convo-fold__t b")).to_have_text("3 task updates")
        expect(self.fold(jonas).locator(".convo-fold__s")).to_have_text(" · Ada Kowalska created 3 tasks")
        expect(jonas.locator(undone)).to_have_count(0)
        for who in ("jonas", "ada"):
            with self.subTest(reader=who):
                page = jonas if who == "jonas" else self.page("ada")
                page.goto(f"/projects/{project}")
                fold = self.fold(page)
                expect(fold.locator(".convo-fold__t b")).to_have_text("3 task updates")
                fold.locator(".convo-fold__b").click()
                expect(fold.locator(".convo-notice")).to_have_count(3)
                expect(page.locator(undone)).to_have_count(0)
                expect(page.locator(".project-convo__message-list").get_by_text(UNDONE)).to_have_count(0)
                expect(page.locator(".project-convo__message-list").get_by_text("Undone", exact=True)).to_have_count(0)

    def test_02_a_question_that_names_nobody_waits_for_the_threads_starter(self) -> None:
        place = self.ids["questions"]
        thread = self.call("ada", "POST", f"/api/v1/projects/{place}/conversations", {"body": "Trays for the morning shift", "clientMessageId": str(uuid.uuid4())})
        self.call("maja", "POST", f"/api/v1/conversations/{thread['id']}/messages", {"body": "I will bring them.", "clientMessageId": str(uuid.uuid4())})
        self.call("jonas", "POST", f"/api/v1/conversations/{thread['id']}/messages", {"body": QUESTION, "clientMessageId": str(uuid.uuid4())})
        ada = self.page("ada")
        ada.goto("/")
        need = ada.get_by_role("region", name=re.compile("^Waiting for you"))
        expect(need.locator(".home__row").filter(has_text=QUESTION)).to_have_count(1)
        # Home gives one answer: it is not also offered as "Answer Jonas's question" under Continue.
        expect(ada.get_by_text(re.compile(r"Answer Jonas.s question"))).to_have_count(0)
        expect(ada.get_by_text("Nothing is waiting for you.")).to_have_count(0)
        ada.goto("/inbox")
        expect(ada.locator(".nyc").filter(has_text=QUESTION)).to_have_count(1)
        # Maja wrote in the thread too, but she is not asked: nothing waits for her, on Home or in the Inbox.
        maja = self.page("maja")
        maja.goto("/")
        expect(maja.get_by_role("region", name=re.compile("^Waiting for you")).get_by_text("Nothing is waiting for you.")).to_be_visible()
        expect(maja.get_by_text(re.compile(r"Answer Jonas.s question"))).to_have_count(0)
        maja.goto("/inbox")
        expect(maja.locator(".nyc").filter(has_text=QUESTION)).to_have_count(0)


if __name__ == "__main__":
    unittest.main()
