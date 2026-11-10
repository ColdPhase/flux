"""Browser tests for an agent's waiting changes (F-036 AG-3, AG-7, #855; mockups UndoApproval, AiPhone).

The check_ui.sh stack runs no assistant, so the owner's change log is stubbed with the exact API shapes;
tests/app/assistant-what-it-may-do.test.ts proves the same states end to end through /mcp with a fake engine.
This proves the conversation cards (a deletion's [Delete] [Keep], a task for another person's [Approve] [Edit]
[Skip], a group with Approve all), the change line with Undo and "Undone by", and the one Inbox item per run,
at computer and phone width.
"""

from __future__ import annotations

import json
import os
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, Route, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")  # chromium (default) or webkit, as in the other journeys (#68 AC-8)
PASSWORD = "waiting for my ok"
STAMP = int(time.time() * 1000)
ADA = {"name": "Ada Brandt", "email": f"ada.changes+{STAMP}@example.test"}
NOW = "2026-10-17T09:00:00.000Z"


class AssistantChanges(unittest.TestCase):
    """Tests run in name order and share one account."""

    pw = None
    browser: Browser
    state: dict | None = None
    ids: dict[str, str] = {}

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

    def context(self, *, phone: bool = False, dark: bool = False) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "color_scheme": "dark" if dark else "light", "locale": "en-GB", "timezone_id": "UTC"}
        options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True) if phone else options.update(viewport=DESKTOP, device_scale_factor=1)
        if self.state:
            options["storage_state"] = self.state
        context = self.browser.new_context(service_workers="block", **options)
        self.addCleanup(context.close)
        return context

    def page(self, **kwargs) -> Page:
        page = self.context(**kwargs).new_page()
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

    def no_horizontal_scroll(self, page: Page) -> None:
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), page.evaluate("window.innerWidth"))

    def change(self, **values) -> dict:
        change = {"id": str(uuid.uuid4()), "runId": self.ids["run"], "projectId": self.ids["project"], "conversationId": self.ids["conversation"],
                  "operation": "work.update", "objectType": "work", "objectId": str(uuid.uuid4()), "objectTitle": "#8 Calibrate the probes", "state": "waiting",
                  "waitReason": "ask", "phrase": "change task", "verb": "Change", "line": "Waits for your OK: you asked it to check with you first.",
                  "forPerson": None, "tells": [], "agentName": "Assistant", "via": None, "done": "changed task #8 Calibrate the probes", "decidedBy": None, "owner": {"id": "ada", "name": ADA["name"]}, "runState": "done",
                  "before": None, "after": None, "undoable": False, "version": 1, "createdAt": NOW}
        change.update(values)
        return change

    def deletion(self) -> dict:
        return self.change(operation="map.thought.delete", objectType="thought", objectTitle="Old lux idea", waitReason="removal",
                           phrase="remove thought", verb="Remove", line="Deleting always waits for your OK.", done="removed thought Old lux idea")

    def proposal(self, title: str, name: str) -> dict:
        return self.change(operation="work.create", objectId=None, objectTitle=title, waitReason="others", phrase="add task", verb="Add",
                           line="Tasks for other people wait for your OK.", forPerson={"id": name.lower(), "name": name}, done=f"added task {title}")

    def stub_changes(self, page: Page, changes: list[dict], calls: list[tuple[str, str]]) -> dict:
        current = {"items": changes}
        page.route(re.compile(r".*/api/v1/conversations/[0-9a-f-]{36}/assistant-changes$"), lambda route: route.fulfill(
            status=200, content_type="application/json", body=json.dumps(current)))

        def one_action(route: Route) -> None:
            change_id, action = route.request.url.rsplit("/", 2)[1:]
            calls.append((change_id, action))
            item = next(entry for entry in current["items"] if entry["id"] == change_id)
            if action == "apply":
                item.update(state="applied_after_wait", waitReason=None, line=f"Approved by {ADA['name']}", undoable=True, version=item["version"] + 1)
            elif action == "edit":
                item.update(objectTitle=json.loads(route.request.post_data or "{}")["title"], version=item["version"] + 1)
            else:
                item.update(state="skipped", line="Kept" if item["waitReason"] == "removal" else "Skipped", waitReason=None, version=item["version"] + 1)
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"change": item, "message": None}))

        def undo_run(route: Route) -> None:
            calls.append(("run", "undo"))
            undone = [item for item in current["items"] if item["state"] in ("applied", "applied_after_wait")]
            for item in undone:
                item.update(state="undone", undoable=False, decidedBy={"id": "ada", "name": ADA["name"]})
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"changes": [{"change": item, "message": None} for item in undone],
                          "undone": len(undone), "changedSince": [], "message": f"Undid {len(undone)} change{'' if len(undone) == 1 else 's'}"}))
        page.route(re.compile(r".*/api/v1/assistant-changes/[0-9a-f-]{36}/(apply|skip|edit)$"), one_action)
        page.route(re.compile(r".*/api/v1/assistant-runs/[0-9a-f-]{36}/changes/undo$"), undo_run)
        return current

    # ---------------------------------------------------------------- tests

    def test_01_an_owner_with_a_conversation(self) -> None:
        page = self.page()
        page.goto("/sign-up")
        page.get_by_label("Name").fill(ADA["name"])
        page.get_by_label("Email").fill(ADA["email"])
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        type(self).state = page.context.storage_state()
        ws = self.api(page, "POST", "/api/v1/workspaces", {"name": "Lamp studio"}, status=201)
        project = self.api(page, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Gesture lamp", "visibility": "restricted"}, status=201)
        thread = self.api(page, "POST", f"/api/v1/projects/{project['id']}/conversations",
                          {"body": "Can you tidy the sensor tasks and the probe notes?", "clientMessageId": str(uuid.uuid4())}, status=201)
        type(self).ids = {"workspace": ws["id"], "project": project["id"], "conversation": thread["id"], "run": str(uuid.uuid4())}
        # With nothing waiting, the conversation shows no card at all (the real, empty change log).
        page.goto(f"/projects/{project['id']}/conversations/{thread['id']}")
        expect(page.get_by_label("Message from you").get_by_text("Can you tidy the sensor tasks")).to_be_visible()
        expect(page.locator(".assistant-waiting")).to_have_count(0)

    def open_conversation(self, page: Page) -> None:
        page.goto(f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}")

    def test_02_a_deletion_asks_delete_or_keep(self) -> None:
        page = self.page()
        calls: list[tuple[str, str]] = []
        kept, deleted = self.deletion(), self.deletion()
        self.stub_changes(page, [kept, deleted], calls)
        self.open_conversation(page)
        card = page.locator(f'[data-change="{kept["id"]}"]')
        expect(card).to_contain_text("Assistant wants to delete the thought Old lux idea")
        expect(card).to_contain_text("Deleting always waits for your OK.")
        expect(card.get_by_role("button", name="Approve")).to_have_count(0)
        shot(page, "assistant-changes-1440-light-delete")
        card.get_by_role("button", name="Keep", exact=True).click()
        expect(page.locator(".assistant-waiting__done")).to_contain_text("Kept: remove thought Old lux idea")
        expect(card).to_have_count(0)
        page.locator(f'[data-change="{deleted["id"]}"]').get_by_role("button", name="Delete", exact=True).click()
        expect(page.locator(".assistant-message__line")).to_contain_text("Removed thought Old lux idea")
        self.assertEqual([call[1] for call in calls], ["skip", "apply"])
        self.no_horizontal_scroll(page)

    def test_03_a_task_for_another_person_is_approved_edited_or_skipped(self) -> None:
        page = self.page()
        calls: list[tuple[str, str]] = []
        task = self.proposal("Order 20 soil sensors", "Jonas")
        self.stub_changes(page, [task], calls)
        self.open_conversation(page)
        card = page.locator(f'[data-change="{task["id"]}"]')
        expect(card).to_contain_text("Assistant wants to create Order 20 soil sensors for Jonas")
        expect(card).to_contain_text("Tasks for other people wait for your OK.")
        shot(page, "assistant-changes-1440-light-proposal")
        card.get_by_role("button", name="Edit", exact=True).click()
        card.get_by_label("Task title").fill("Order 30 soil sensors")
        card.get_by_role("button", name="Save", exact=True).click()
        expect(card).to_contain_text("Assistant wants to create Order 30 soil sensors for Jonas")
        card.get_by_role("button", name="Approve", exact=True).click()
        expect(page.locator(".assistant-message__line")).to_contain_text("Added task Order 20 soil sensors")
        self.assertEqual([call[1] for call in calls], ["edit", "apply"])

    def test_04_several_tasks_for_others_are_one_group_with_approve_all(self) -> None:
        page = self.page()
        calls: list[tuple[str, str]] = []
        tasks = [self.proposal("Weigh the full barrel on Thursday", "Jonas"), self.proposal("Re-check the south barrel wiring", "Maja"), self.proposal("Print new labels", "Maja")]
        self.stub_changes(page, tasks, calls)
        self.open_conversation(page)
        group = page.locator(".assistant-waiting__card").filter(has_text="wants to create 3 tasks for others")
        expect(group).to_contain_text("for Jonas")
        expect(group.get_by_role("button", name="Edit", exact=True)).to_have_count(3)
        shot(page, "assistant-changes-1440-light-group")
        group.locator(f'[data-change="{tasks[2]["id"]}"]').get_by_role("button", name="Skip", exact=True).click()
        expect(page.locator(".assistant-waiting__card").filter(has_text="Re-check the south barrel wiring")).to_be_visible()
        expect(page.locator(".assistant-waiting__done")).to_contain_text("Skipped: add task Print new labels")
        # The two left stay one group with Approve all.
        expect(page.locator(".assistant-waiting__card").filter(has_text="wants to create 2 tasks for others").get_by_role("button", name="Approve all")).to_be_visible()
        page.get_by_role("button", name="Approve all").click()
        expect(page.locator(".assistant-message__line")).to_contain_text("Added task Weigh the full barrel on Thursday")
        self.assertEqual([call[1] for call in calls], ["skip", "apply", "apply"])

    def test_05_the_change_line_carries_undo_and_then_says_who_undid_it(self) -> None:
        page = self.page()
        calls: list[tuple[str, str]] = []
        done = dict(state="applied", waitReason=None, line=None, undoable=True)
        self.stub_changes(page, [
            self.change(**done, operation="doc.update", objectType="doc", objectTitle="Calibration", phrase="edit page", verb="Edit", done="updated the Wiki page Calibration"),
            self.change(**done, operation="doc.update", objectType="doc", objectTitle="Calibration", phrase="edit page", verb="Edit", done="updated the Wiki page Calibration"),
            self.change(**done, objectTitle="#4 Calibrate the overflow sensor", done="moved #4 to In progress"),
        ], calls)
        self.open_conversation(page)
        line = page.locator(".assistant-message__line")
        expect(line).to_contain_text("Updated the Wiki page Calibration (2 changes) · moved #4 to In progress")
        shot(page, "assistant-changes-1440-light-change-line")
        line.get_by_role("button", name="Undo", exact=True).click()
        expect(line).to_contain_text(f"Undone by {ADA['name'].split()[0]}")
        expect(line.get_by_role("button", name="Undo", exact=True)).to_have_count(0)
        self.assertEqual(calls, [("run", "undo")])

    def test_06_inbox_shows_one_item_per_run_with_approve_all_and_open(self) -> None:
        page = self.page()
        changes = [{"id": str(uuid.uuid4()), "version": 1, "phrase": "remove thought", "verb": "Remove", "objectTitle": "Old notes", "line": "Deleting always waits for your OK.", "waitReason": "removal", "forPerson": None},
                   {"id": str(uuid.uuid4()), "version": 1, "phrase": "add task", "verb": "Add", "objectTitle": "Order 20 soil sensors", "line": "Tasks for other people wait for your OK.", "waitReason": "others", "forPerson": {"id": "jonas", "name": "Jonas"}},
                   {"id": str(uuid.uuid4()), "version": 1, "phrase": "add task", "verb": "Add", "objectTitle": "Re-check the south barrel wiring", "line": "Tasks for other people wait for your OK.", "waitReason": "others", "forPerson": {"id": "maja", "name": "Maja"}}]
        item = {"key": f"assistant:{self.ids['run']}", "kind": "question", "title": "3 things wait for you", "detail": "remove 1 thought, add 2 tasks",
                "project": {"id": self.ids["project"], "name": "Gesture lamp"}, "from": None, "at": NOW,
                "url": f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}", "decision": None, "blocked": None, "reason": "question",
                "snoozeTask": None, "assistantChanges": {"runId": self.ids["run"], "agentName": "Assistant", "summary": "remove 1 thought, add 2 tasks", "changes": changes}}
        queue = {"items": [item], "count": 1, "later": 0, "doneToday": 0}
        applied: list[str] = []
        page.route(re.compile(r".*/api/v1/needs-you(\?.*)?$"), lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(queue)))

        def apply(route: Route) -> None:
            applied.append(route.request.url)
            queue["items"] = []
            queue["count"] = 0
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"changes": [{"change": {}, "message": None} for _ in changes]}))
        page.route(re.compile(r".*/api/v1/assistant-runs/[0-9a-f-]{36}/changes/apply$"), apply)
        page.goto("/inbox")
        card = page.locator(f'[data-key="assistant:{self.ids["run"]}"]')
        expect(card).to_contain_text("Assistant")
        expect(card).to_contain_text("3 things wait for you")
        expect(card).to_contain_text("Delete “Old notes”")
        expect(card).to_contain_text("Jonas")
        expect(card.get_by_role("button", name="Open", exact=True)).to_be_visible()
        shot(page, "assistant-changes-1440-light-inbox")
        card.get_by_role("button", name="Approve all", exact=True).click()
        expect(page.get_by_text("Approved: remove 1 thought, add 2 tasks")).to_be_visible()
        self.assertEqual(len(applied), 1)

    def test_06b_the_notification_of_an_agent_waiting_opens_its_card(self) -> None:
        """#1186: an agent waiting for your OK tells you once; its link (email and a push tap go through /inbox/<id>) opens the Inbox on
        the run's card, selected, even when another item comes first."""
        page = self.page()
        run = self.ids["run"]
        changes = [{"id": str(uuid.uuid4()), "version": 1, "phrase": "add task", "verb": "Add", "objectTitle": "Order 20 soil sensors",
                    "line": "Waits for your OK: you asked it to check with you first.", "waitReason": "ask", "forPerson": None}]
        question = {"key": f"note:{uuid.uuid4()}", "kind": "question", "title": "Jonas asked you in Gesture lamp", "detail": "Is the lux sensor in?",
                    "project": None, "from": None, "at": NOW, "url": f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}",
                    "decision": None, "blocked": None, "reason": "question", "snoozeTask": None}
        waiting = {"key": f"assistant:{run}", "kind": "question", "title": "1 thing waits for you", "detail": "add 1 task",
                   "project": {"id": self.ids["project"], "name": "Gesture lamp"}, "from": None, "at": NOW,
                   "url": f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}", "decision": None, "blocked": None, "reason": "question",
                   "snoozeTask": None, "assistantChanges": {"runId": run, "agentName": "Assistant", "summary": "add 1 task", "changes": changes}}
        page.route(re.compile(r".*/api/v1/needs-you(\?.*)?$"), lambda route: route.fulfill(status=200, content_type="application/json",
                   body=json.dumps({"items": [question, waiting], "count": 2, "later": 0, "doneToday": 0})))
        notification = str(uuid.uuid4())
        page.route(re.compile(rf".*/api/v1/inbox/{notification}$"), lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps({
            "id": notification, "source": {"workspaceId": str(uuid.uuid4()), "type": "project", "id": self.ids["project"]}, "reason": "approval",
            "title": "Assistant is waiting for your OK", "body": "Add “Order 20 soil sensors” · Gesture lamp", "url": f"/inbox?item=assistant:{run}",
            "createdAt": NOW, "readAt": None})))
        page.route(re.compile(rf".*/api/v1/inbox/{notification}/read$"), lambda route: route.fulfill(status=200, content_type="application/json",
                   body=json.dumps({"id": notification, "readAt": NOW})))
        page.goto(f"/inbox/{notification}")
        expect(page).to_have_url(re.compile(re.escape(f"/inbox?item=assistant:{run}") + "$"))
        card = page.locator(f'.nyc[data-key="assistant:{run}"]')
        expect(card).to_have_attribute("aria-current", "true")
        expect(card).to_contain_text("Order 20 soil sensors")
        expect(card.get_by_role("button", name="Approve all", exact=True)).to_be_visible()
        expect(page.locator(f'.nyc[data-key="{question["key"]}"]')).not_to_have_attribute("aria-current", "true")

    def test_07_phone_reads_the_cards_without_overflow(self) -> None:
        for dark in (False, True):
            page = self.page(phone=True, dark=dark)
            self.stub_changes(page, [self.deletion(), self.proposal("Order 20 soil sensors", "Jonas")], [])
            self.open_conversation(page)
            card = page.locator(".assistant-waiting__card").first
            expect(card).to_contain_text("Assistant wants to delete the thought")
            card.scroll_into_view_if_needed()
            for name in ("Delete", "Keep"):
                box = card.get_by_role("button", name=name, exact=True).bounding_box()
                self.assertIsNotNone(box)
                self.assertGreaterEqual(box["height"], 24, f"{name} is a comfortable target")
            self.no_horizontal_scroll(page)
            shot(page, f"assistant-changes-390-{'dark' if dark else 'light'}-waiting")

    def test_09_a_change_that_would_tell_someone_shows_the_words_and_the_person(self) -> None:
        # #1089: a run's change that would notify another person waits; the owner reads what Flux would send, and to whom, before the OK,
        # and the Inbox gives each change's own reason, not the sentence about deleting and other people's things.
        page = self.page()
        line = "It would notify Jonas Weber: what tells other people waits for your OK."
        said = "“Order the spare probes” · Needs the budget"
        tells = self.change(operation="work.create", objectId=None, objectTitle="Order the spare probes", waitReason="tells", phrase="add task", verb="Add",
                            line=line, tells=[{"id": "jonas", "name": "Jonas Weber"}], after=said, done="added task Order the spare probes")
        self.stub_changes(page, [tells], [])
        self.open_conversation(page)
        card = page.locator(f'[data-change="{tells["id"]}"]')
        expect(card).to_contain_text("Assistant wants to add task Order the spare probes")
        expect(card.locator(".assistant-waiting__said")).to_have_text(f"Jonas Weber would read: {said}")
        expect(card.locator(".assistant-waiting__why")).to_have_text(line)
        expect(card.get_by_role("button", name="Edit")).to_have_count(0)
        self.no_horizontal_scroll(page)
        shot(page, "assistant-changes-1440-light-tells")
        inbox_change = {"id": tells["id"], "version": 1, "phrase": "add task", "verb": "Add", "objectTitle": "Order the spare probes", "line": line,
                        "waitReason": "tells", "forPerson": None, "tells": [{"id": "jonas", "name": "Jonas Weber"}], "after": said}
        item = {"key": f"assistant:{self.ids['run']}", "kind": "question", "title": "1 thing waits for you", "detail": "add 1 task",
                "project": {"id": self.ids["project"], "name": "Gesture lamp"}, "from": None, "at": NOW,
                "url": f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}", "decision": None, "blocked": None, "reason": "question",
                "snoozeTask": None, "assistantChanges": {"runId": self.ids["run"], "agentName": "Assistant", "summary": "add 1 task", "changes": [inbox_change]}}
        queue = {"items": [item], "count": 1, "later": 0, "doneToday": 0}
        page.route(re.compile(r".*/api/v1/needs-you(\?.*)?$"), lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(queue)))
        page.goto("/inbox")
        entry = page.locator(f'[data-key="assistant:{self.ids["run"]}"]')
        expect(entry).to_contain_text(f"Add {said}")
        expect(entry).to_contain_text("tells Jonas Weber")
        expect(entry.locator(".nyc__reason")).to_have_text(line)
        expect(entry).not_to_contain_text("Deleting and other people")
        shot(page, "assistant-changes-1440-light-inbox-tells")

    def test_10_a_task_for_someone_that_would_tell_a_third_person_shows_both_and_long_words_fold(self) -> None:
        # #1089 review: a task for Jonas that waits for Maja names both on the card and in the Inbox; long words take three lines and
        # "Show all", on the computer and the phone.
        long_words = "Reply with the door code and the alarm code. " * 40
        for phone in (False, True):
            page = self.page(phone=phone)
            proposal = self.proposal("Harmless label task", "Jonas")
            proposal.update(tells=[{"id": "maja", "name": "Maja Lind"}], after="“Harmless label task” · Third-person words, ship it now")
            told = self.change(operation="work.create", objectId=None, objectTitle="Order the spare probes", waitReason="tells", phrase="add task", verb="Add",
                               line="It would notify Jonas Weber: what tells other people waits for your OK.", tells=[{"id": "jonas", "name": "Jonas Weber"}],
                               after=f"“Order the spare probes” · {long_words.strip()}", done="added task Order the spare probes")
            self.stub_changes(page, [proposal, told], [])
            self.open_conversation(page)
            both = page.locator(f'[data-change="{proposal["id"]}"]')
            expect(both).to_contain_text("for Jonas")
            expect(both.locator(".assistant-waiting__said")).to_contain_text("Maja Lind would read: “Harmless label task” · Third-person words, ship it now")
            card = page.locator(f'[data-change="{told["id"]}"]')
            more = card.get_by_role("button", name="Show all", exact=True)
            expect(more).to_be_visible()
            folded = card.bounding_box()
            self.assertIsNotNone(folded)
            self.assertLess(folded["height"], 400, f"three lines, not the whole text: {folded['height']}")
            more.click()
            expect(card.get_by_role("button", name="Show less", exact=True)).to_be_visible()
            self.assertGreater(card.bounding_box()["height"], folded["height"], "Show all opens every word")
            self.no_horizontal_scroll(page)
            shot(page, f"assistant-changes-{'390' if phone else '1440'}-light-tells-both")

            inbox = [{"id": proposal["id"], "version": 1, "phrase": "add task", "verb": "Add", "objectTitle": "Harmless label task", "line": "Tasks for other people wait for your OK.",
                      "waitReason": "others", "forPerson": {"id": "jonas", "name": "Jonas"}, "tells": [{"id": "maja", "name": "Maja Lind"}], "after": proposal["after"]},
                     {"id": told["id"], "version": 1, "phrase": "add task", "verb": "Add", "objectTitle": "Order the spare probes", "line": told["line"],
                      "waitReason": "tells", "forPerson": None, "tells": [{"id": "jonas", "name": "Jonas Weber"}], "after": told["after"]}]
            item = {"key": f"assistant:{self.ids['run']}", "kind": "question", "title": "2 things wait for you", "detail": "add 2 tasks",
                    "project": {"id": self.ids["project"], "name": "Gesture lamp"}, "from": None, "at": NOW,
                    "url": f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}", "decision": None, "blocked": None, "reason": "question",
                    "snoozeTask": None, "assistantChanges": {"runId": self.ids["run"], "agentName": "Assistant", "summary": "add 2 tasks", "changes": inbox}}
            queue = {"items": [item], "count": 1, "later": 0, "doneToday": 0}
            body = json.dumps(queue)
            page.route(re.compile(r".*/api/v1/needs-you(\?.*)?$"), (lambda payload: lambda route: route.fulfill(status=200, content_type="application/json", body=payload))(body))
            page.goto("/inbox")
            entry = page.locator(f'[data-key="assistant:{self.ids["run"]}"]')
            # The title is said once (#1102).
            expect(entry).to_contain_text("Add “Harmless label task” · Third-person words, ship it now")
            expect(entry).not_to_contain_text("Add Harmless label task ·")
            expect(entry).to_contain_text("tells Maja Lind")
            expect(entry).to_contain_text("tells Jonas Weber")
            expect(entry.get_by_role("button", name="Show all", exact=True).last).to_be_visible()
            box = entry.bounding_box()
            self.assertIsNotNone(box)
            self.assertLess(box["height"], 700, f"the Inbox item stays short: {box['height']}")
            self.no_horizontal_scroll(page)
            shot(page, f"assistant-changes-{'390' if phone else '1440'}-light-inbox-tells-both")

    def test_11_long_names_go_under_the_words_on_a_phone_and_everyone_told_is_named(self) -> None:
        # #1102: at 390 px a change for one person that tells others keeps its words readable: the names go to their own line instead of
        # squeezing the words to nothing, and a decision about several people's tasks names them all.
        page = self.page(phone=True)
        names = [{"id": "a", "name": "Maximiliane Gräfin von Hohenzollern-Sigmaringen"}, {"id": "b", "name": "Bartholomäus Wojciechowski-Kowalczyk"}]
        changes = [{"id": str(uuid.uuid4()), "version": 1, "phrase": "add task", "verb": "Add", "objectTitle": "Harmless label task",
                    "line": "Tasks for other people wait for your OK.", "waitReason": "others",
                    "forPerson": {"id": "c", "name": "Konstantinopoulos-Papadimitriou Alexandra"}, "tells": names[:1],
                    "after": "“Harmless label task” · Third-person words, ship it now"},
                   {"id": str(uuid.uuid4()), "version": 1, "phrase": "propose decision", "verb": "Propose", "objectTitle": "One cable colour",
                    "line": f"It would notify {names[0]['name']} and {names[1]['name']}: what tells other people waits for your OK.", "waitReason": "tells",
                    "forPerson": None, "tells": names, "after": "“One cable colour”"}]
        item = {"key": f"assistant:{self.ids['run']}", "kind": "question", "title": "2 things wait for you", "detail": "add 1 task, propose 1 decision",
                "project": {"id": self.ids["project"], "name": "Gesture lamp"}, "from": None, "at": NOW,
                "url": f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}", "decision": None, "blocked": None, "reason": "question",
                "snoozeTask": None, "assistantChanges": {"runId": self.ids["run"], "agentName": "Assistant", "summary": "add 1 task, propose 1 decision", "changes": changes}}
        body = json.dumps({"items": [item], "count": 1, "later": 0, "doneToday": 0})
        page.route(re.compile(r".*/api/v1/needs-you(\?.*)?$"), (lambda payload: lambda route: route.fulfill(status=200, content_type="application/json", body=payload))(body))
        page.goto("/inbox")
        entry = page.locator(f'[data-key="assistant:{self.ids["run"]}"]')
        expect(entry).to_contain_text("Add “Harmless label task” · Third-person words, ship it now")
        expect(entry).to_contain_text(f"tells {names[0]['name']} and {names[1]['name']}")
        card = entry.bounding_box()
        self.assertIsNotNone(card)
        for row in entry.locator(".nyc__waits li").all():
            words = row.locator(".nyc__waits-words").bounding_box()
            self.assertIsNotNone(words)
            self.assertGreater(words["width"], 120, f"the words keep their width: {words['width']}")
            for label in row.locator(".nyc__waits-for").all():
                box = label.bounding_box()
                self.assertIsNotNone(box)
                self.assertGreaterEqual(box["y"], words["y"] + words["height"] - 1, "the names are under the words")
                self.assertLessEqual(box["x"] + box["width"], card["x"] + card["width"] + 1, "and inside the card")
        self.no_horizontal_scroll(page)
        shot(page, "assistant-changes-390-light-inbox-long-names")

    def test_08_a_page_the_assistant_started_has_undo_and_a_refusal_opens_the_page(self) -> None:
        page = self.page()
        calls: list[tuple[str, str]] = []
        page_id = str(uuid.uuid4())
        current = self.stub_changes(page, [
            self.change(state="applied", waitReason=None, line=None, undoable=True, operation="doc.create", objectType="doc", objectId=page_id,
                        objectTitle="Probe notes", phrase="add page", verb="Add", done="added the Wiki page Probe notes", after="Probe notes"),
        ], calls)
        refused = {"once": True}

        def refuse_once(route: Route) -> None:
            if not refused["once"]:
                route.fallback()
                return
            refused["once"] = False
            calls.append(("run", "refused"))
            route.fulfill(status=200, content_type="application/json", body=json.dumps({
                "changes": [{"change": current["items"][0], "message": "Changed since. Open it"}], "undone": 0, "changedSince": ["Probe notes"],
                "message": "Nothing undone. 1 changed since: Probe notes"}))
        page.route(re.compile(r".*/api/v1/assistant-runs/[0-9a-f-]{36}/changes/undo$"), refuse_once)
        self.open_conversation(page)
        line = page.locator(".assistant-message__line")
        expect(line).to_contain_text("Added the Wiki page Probe notes")
        # A page someone edited since stays: the line says so and "Open it" goes to the page (#1021).
        line.get_by_role("button", name="Undo", exact=True).click()
        note = page.locator(".assistant-message__note")
        expect(note).to_contain_text("Changed since.")
        expect(note.get_by_role("link", name="Open it")).to_have_attribute("href", f"/projects/{self.ids['project']}/docs/{page_id}")
        expect(line.get_by_role("button", name="Undo", exact=True)).to_be_visible()
        # An untouched one is taken back, and the line says who did it.
        line.get_by_role("button", name="Undo", exact=True).click()
        expect(line).to_contain_text(f"Undone by {ADA['name'].split()[0]}")
        expect(line.get_by_role("button", name="Undo", exact=True)).to_have_count(0)
        self.assertEqual(calls, [("run", "refused"), ("run", "undo")])


if __name__ == "__main__":
    unittest.main()
