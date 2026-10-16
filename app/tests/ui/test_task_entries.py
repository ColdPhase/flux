"""Every task-creation entry, by two authors, shows one root in Conversation, Tasks, Map and Agents (#154 AC-5).

Entries: a message's Create task (Conversation), "New task in Open" on the Tasks board, and "Create task
from selected thoughts" on the Map. Each author creates a task, the other author writes the task's first
message, and the four views must reach the same root: the root's message in Conversation, the Discussion
link in Details (Tasks and Map), and the "Open in Conversation" link of the Agents thread. A first attempt
that fails without saving, and a lost answer that does save, are retried from the Create window: exactly one
task results and the command id stays the same. A source the author cannot read is refused. Runs with the
other tests/ui modules through scripts/check_ui.sh against the running Compose application.
"""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from create_window import dialog, linked_labels, submit_button, title_field
from test_app_shell import DESKTOP, ORIGIN, UPSTREAM, shot, start_forwarder

PASSWORD = "two authors one root in every view"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ada": ("Ada Kowalska", f"ada.entries+{STAMP}@example.test"),
    "jonas": ("Jonas Berg", f"jonas.entries+{STAMP}@example.test"),
    "lee": ("Lee Park", f"lee.entries+{STAMP}@example.test"),
}
OTHER = {"ada": "jonas", "jonas": "ada"}


class TaskEntries(unittest.TestCase):
    """Tests run in name order and share three accounts, one project and one sketch."""

    pw = None
    browser: Browser
    contexts: dict[str, BrowserContext] = {}
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        try:
            cls.browser = cls.pw.chromium.launch()
            expect.set_options(timeout=10000)
            cls.seed()
        except BaseException:
            cls.tearDownClass()
            raise

    @classmethod
    def seed(cls) -> None:
        for key, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(service_workers="block", base_url=ORIGIN)
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.states[key] = context.storage_state()
            cls.contexts[key] = context

        ada = cls.contexts["ada"]

        def post(who: str, path: str, body: dict) -> dict:
            response = cls.contexts[who].request.post(path, data=body, headers={"origin": ORIGIN})
            assert response.status in (200, 201), f"{path}: {response.status} {response.text()}"
            return response.json()

        ws = post("ada", "/api/v1/workspaces", {"name": "Riverside Makers"})["id"]
        post("ada", f"/api/v1/workspaces/{ws}/members", {"email": PEOPLE["jonas"][1], "role": "member"})
        post("ada", f"/api/v1/workspaces/{ws}/members", {"email": PEOPLE["lee"][1], "role": "admin"})
        pid = post("ada", f"/api/v1/workspaces/{ws}/projects", {"name": "Entry check", "visibility": "restricted"})["id"]
        post("ada", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": cls.ids["jonas"]}, "role": "contributor"})
        sketch = post("ada", f"/api/v1/workspaces/{ws}/sketches", {"title": "Entry sketch", "scope": "project", "projectId": pid})["id"]
        # A project only Lee can read: its message is a source neither Ada nor Jonas may use.
        vault = post("lee", f"/api/v1/workspaces/{ws}/projects", {"name": "Lee vault", "visibility": "restricted"})["id"]
        vault_message = post("lee", f"/api/v1/projects/{vault}/conversations", {"body": "Only Lee can read this source.", "clientMessageId": str(uuid.uuid4())})
        cls.ids.update(project=pid, sketch=sketch, workspace=ws, vault_message=vault_message["messages"][0]["id"])

    @classmethod
    def tearDownClass(cls) -> None:
        for context in cls.contexts.values():
            context.close()
        if getattr(cls, "browser", None) is not None:
            cls.browser.close()
        cls.pw.stop()

    def page(self, who: str) -> Page:
        context = self.browser.new_context(service_workers="block", base_url=ORIGIN, color_scheme="light", locale="en-GB",
                                           timezone_id="Europe/Warsaw", viewport=DESKTOP, device_scale_factor=1, storage_state=self.states[who])
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def raw(self, who: str, method: str, path: str, body: dict | None = None):
        return self.contexts[who].request.fetch(f"{ORIGIN}{path}", method=method, headers={"origin": ORIGIN, "content-type": "application/json"},
                                                data=json.dumps(body) if body is not None else None)

    def api(self, who: str, method: str, path: str, body: dict | None = None, status: int | None = None) -> dict:
        response = self.raw(who, method, path, body)
        if status is not None:
            self.assertEqual(response.status, status, response.text())
        return json.loads(response.text()) if response.text() else {}

    def task_total(self) -> int:
        return self.api("ada", "GET", f"/api/v1/projects/{self.ids['project']}/work?limit=100", status=200)["total"]

    def task_by_title(self, title: str) -> dict:
        items = self.api("ada", "GET", f"/api/v1/projects/{self.ids['project']}/work?limit=100", status=200)["items"]
        matches = [item for item in items if item["title"] == title]
        self.assertEqual(len(matches), 1, f"exactly one task titled {title!r}")
        return matches[0]

    def submit_with_recovery(self, page: Page, title: str) -> None:
        """First attempt fails without saving, the second is stored but its answer is lost, the third succeeds."""
        path = f"**/api/v1/projects/{self.ids['project']}/work"
        sent: list[str] = []
        statuses: list[int] = []

        def handler(route) -> None:
            if route.request.method != "POST":
                return route.continue_()
            sent.append(json.loads(route.request.post_data or "{}")["clientCommandId"])
            if len(sent) == 1:
                return route.fulfill(status=500, content_type="application/json", body=json.dumps({"error": "internal", "message": "Could not save the task."}))
            if len(sent) == 2:
                response = route.fetch()
                statuses.append(response.status)
                return route.abort("connectionreset")
            return route.continue_()

        before = self.task_total()
        page.route(path, handler)
        submit_button(page).click()
        expect(dialog(page).get_by_role("alert")).to_be_visible()
        expect(title_field(page)).to_have_value(title)
        self.assertEqual(self.task_total(), before, "a failed save stores nothing")
        submit_button(page).click()
        expect(dialog(page).get_by_role("alert")).to_be_visible()
        expect(title_field(page)).to_have_value(title)
        self.assertEqual(self.task_total(), before + 1, "the lost answer was stored once by the server")
        submit_button(page).click()
        expect(dialog(page)).to_have_count(0)
        page.unroute(path)
        self.assertEqual(len(set(sent)), 1, "every attempt reuses one command id")
        self.assertIn(statuses[0], (200, 201), "the lost answer had been saved")
        self.assertEqual(self.task_total(), before + 1, "the retry does not create a second task")

    def check_views(self, who: str, work_id: str, title: str, first_word: str, root_id: str, conversation_id: str, on_map: str | None) -> None:
        """Conversation, Tasks, Agents (and Map when the task has a thought) show the same root, author and one task each."""
        creator = PEOPLE[who][0]
        root_author = PEOPLE[OTHER[who]][0]
        pid = self.ids["project"]
        thread = f"/projects/{pid}/conversations/{conversation_id}"
        page = self.page(who)
        page.goto(f"/projects/{pid}")
        root = page.locator(f"#message-{root_id}")
        expect(root).to_be_visible()
        expect(root.get_by_role("button", name=f"Discussion of task: {title}")).to_be_visible()
        expect(root.locator(".project-convo__message-meta strong")).to_have_text(root_author)
        notices = page.locator(f".convo-notice[data-work-id='{work_id}']")
        expect(notices).to_have_count(1)
        expect(notices.locator(".convo-notice__meta strong")).to_contain_text(creator.split()[0])

        page.goto(f"/projects/{pid}/tasks?view=board")
        cards = page.locator(".tb-card").filter(has_text=title)
        expect(cards).to_have_count(1)
        cards.get_by_role("button", name=title, exact=True).click()
        details = page.locator("#details")
        expect(details.get_by_role("heading", name=title)).to_be_visible()
        link = details.get_by_role("region", name="Discussion").get_by_role("link")
        expect(link).to_contain_text(root_author)
        expect(link).to_contain_text(first_word)
        expect(link).to_have_attribute("href", thread)

        page.goto(f"/projects/{pid}/agents?task={work_id}")
        thread_region = page.get_by_role("region", name=re.compile(rf"^Thread of {re.escape(title)}"))
        expect(thread_region).to_have_count(1)
        expect(thread_region.locator(".agents-msg", has_text=first_word)).to_contain_text(root_author)
        expect(thread_region).to_contain_text(first_word)
        expect(page.get_by_role("link", name="Open in Conversation")).to_have_attribute("href", thread)

        if on_map:
            page.goto(f"/projects/{pid}/map/{self.ids['sketch']}")
            badge = page.locator(f'.sk-node[data-id="{self.ids[f"thought-{who}"]}"] + .sk-work-slot .sk-work')
            expect(badge).to_have_count(1)
            expect(badge).to_have_accessible_name(re.compile(r"^1 task linked to"))
            badge.click()
            chooser = page.get_by_role("dialog", name=self.ids[f"text-{who}"], exact=True)
            expect(chooser.get_by_role("link")).to_have_count(1)
            chooser.get_by_role("link").click()
            details = page.locator("#details")
            expect(details.get_by_role("heading", name=title)).to_be_visible()
            link = details.get_by_role("region", name="Discussion").get_by_role("link")
            expect(link).to_contain_text(root_author)
            expect(link).to_contain_text(first_word)
            expect(link).to_have_attribute("href", thread)
        shot(page, f"task-entry-{on_map or 'views'}-{who}")

    def discussion_root(self, who: str, work_id: str, body: str) -> tuple[str, str]:
        """The other author (who) writes the task's first message; returns the root message and its conversation."""
        first = self.api(who, "POST", f"/api/v1/work/{work_id}/discussion", {"body": body, "clientMessageId": str(uuid.uuid4())}, status=201)
        discussion = self.api(who, "GET", f"/api/v1/work/{work_id}/discussion", status=200)
        self.assertEqual(discussion["rootMessageId"], first["id"], "the first message is the task's root")
        self.assertEqual(discussion["root"]["authorId"], self.ids[who], "the other author wrote the root")
        return first["id"], first["conversationId"]

    def conversation_entry(self, who: str) -> None:
        other = OTHER[who]
        tag = f"conversation by {PEOPLE[who][0].split()[0]}"
        body = f"Which driver fits the lamp, {tag}? The shop lists two."
        source = self.api(other, "POST", f"/api/v1/projects/{self.ids['project']}/conversations", {"body": body, "clientMessageId": str(uuid.uuid4())}, status=201)
        message = source["messages"][0]["id"]
        page = self.page(who)
        page.goto(f"/projects/{self.ids['project']}")
        row = page.locator(f"#message-{message}")
        row.hover()
        row.get_by_role("button", name="Create task").click()
        expect(title_field(page)).to_have_value(body)
        self.submit_with_recovery(page, body)
        return body

    def tasks_entry(self, who: str) -> str:
        tag = f"column by {PEOPLE[who][0].split()[0]}"
        title = f"Check the lamp driver, {tag}"
        page = self.page(who)
        page.goto(f"/projects/{self.ids['project']}/tasks?view=board")
        page.get_by_role("button", name="New task in Open").click()
        expect(dialog(page)).to_be_visible()
        title_field(page).fill(title)
        self.submit_with_recovery(page, title)
        return title

    def map_entry(self, who: str) -> str:
        tag = f"map by {PEOPLE[who][0].split()[0]}"
        text = f"Compare the two lamp shades, {tag}"
        thought = self.api(who, "POST", f"/api/v1/sketches/{self.ids['sketch']}/thoughts", {"text": text, "x": 40 if who == "ada" else 360, "y": 40}, status=201)["thought"]["id"]
        self.ids[f"thought-{who}"] = thought
        self.ids[f"text-{who}"] = text
        page = self.page(who)
        page.goto(f"/projects/{self.ids['project']}/map/{self.ids['sketch']}")
        page.locator(f".sk-node[data-id='{thought}']").click()
        page.get_by_role("button", name="Create task from selected thoughts", exact=True).click()
        expect(title_field(page)).to_have_value(text)
        expect(linked_labels(page)).to_have_text([text])
        self.submit_with_recovery(page, text)
        return text

    def run_entry(self, entry: str, who: str) -> None:
        other = OTHER[who]
        if entry == "conversation":
            title = self.conversation_entry(who)
            on_map = None
        elif entry == "tasks":
            title = self.tasks_entry(who)
            on_map = None
        else:
            title = self.map_entry(who)
            on_map = "map"
        work = self.task_by_title(title)
        self.assertEqual(work["title"], title)
        # The creator's draft for the task is the same text in Details and in the Agents composer, before the root exists.
        page = self.page(who)
        page.goto(f"/projects/{self.ids['project']}/tasks?view=board")
        page.locator(".tb-card").filter(has_text=title).get_by_role("button", name=title, exact=True).click()
        box = page.locator("#details").get_by_label("First message about this task")
        draft = f"Shared draft for {title}"
        box.fill(draft)
        page.goto(f"/projects/{self.ids['project']}/agents?task={work['id']}")
        expect(page.get_by_label("Write to this task")).to_have_value(draft)
        page.get_by_label("Write to this task").fill("")
        first_word = f"First word from {other} about {entry}"
        root_id, conversation_id = self.discussion_root(other, work["id"], first_word)
        self.check_views(who, work["id"], title, first_word, root_id, conversation_id, on_map)
        self.ids[f"{entry}-{who}"] = work["id"]

    def test_01_conversation_message_task_by_ada(self) -> None:
        self.run_entry("conversation", "ada")

    def test_02_conversation_message_task_by_jonas(self) -> None:
        self.run_entry("conversation", "jonas")

    def test_03_tasks_column_task_by_ada(self) -> None:
        self.run_entry("tasks", "ada")

    def test_04_tasks_column_task_by_jonas(self) -> None:
        self.run_entry("tasks", "jonas")

    def test_05_map_thought_task_by_ada(self) -> None:
        self.run_entry("map", "ada")

    def test_06_map_thought_task_by_jonas(self) -> None:
        self.run_entry("map", "jonas")

    def test_07_a_source_outside_the_project_is_refused_for_both_authors(self) -> None:
        for who in ("ada", "jonas"):
            with self.subTest(who=who):
                before = self.task_total()
                response = self.raw(who, "POST", f"/api/v1/projects/{self.ids['project']}/work",
                                    {"title": f"Refused source for {who}", "sources": [{"type": "message", "id": self.ids["vault_message"]}],
                                     "clientCommandId": str(uuid.uuid4())})
                # The server refuses a source outside the project; it never stores the task.
                self.assertEqual((response.status, response.json()["code"]), (422, "LINK_TARGET_NOT_FOUND"), response.text())
                self.assertEqual(self.task_total(), before, "a refused source stores no task")


if __name__ == "__main__":
    unittest.main()
