"""Browser tests for the assistant's waiting changes (F-027 A3, #403; AST-5.3, AST-5.6, AST-5.8).

The check_ui.sh stack runs no assistant, so the owner's change log is stubbed with the exact API shapes;
tests/app/assistant-changes.test.ts proves the same states end to end through /mcp with a fake engine.
This proves the conversation card ("Waiting for you: …" with the object's own verb, Review and Not now,
the deferred and suggested lines), the move to Inbox when the owner leaves, and the Inbox question with
its verb, at computer and phone width.
"""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, Route, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

PASSWORD = "waiting for my ok"
STAMP = int(time.time() * 1000)
ADA = {"name": "Ada Brandt", "email": f"ada.changes+{STAMP}@example.test"}
NOW = "2026-10-17T09:00:00.000Z"
WEEK = "2026-10-24T09:00:00.000Z"


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
        cls.browser = cls.pw.chromium.launch()
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
                  "operation": "work.create", "objectType": "work", "objectId": None, "objectTitle": "Label the sensor cables", "state": "waiting",
                  "waitReason": "ask", "phrase": "add task", "verb": "Add", "line": "You asked me to check with you first", "suggestTo": None, "sent": False,
                  "decidedBy": None, "version": 1, "createdAt": NOW, "expiresAt": WEEK}
        change.update(values)
        return change

    def waiting_set(self) -> list[dict]:
        return [
            self.change(),
            self.change(operation="map.thought.delete", objectType="thought", objectId=str(uuid.uuid4()), objectTitle="Old lux idea", waitReason="removal",
                        phrase="remove thought", verb="Remove", line="Removing a thought always waits for you"),
            self.change(operation="doc.update", objectType="doc", objectId=str(uuid.uuid4()), objectTitle="Suppliers", waitReason="live_wiki", phrase="edit page",
                        verb="Edit", line="I’ll edit Suppliers when Jonas finishes typing."),
            self.change(operation="work.update", objectType="work", objectId=str(uuid.uuid4()), objectTitle="#8 Calibrate the probes", waitReason="outside_rights",
                        phrase="close task", verb="Close", line="Jonas owns #8 Calibrate the probes. Suggest this change to them? · Send to Jonas",
                        suggestTo={"id": "jonas", "name": "Jonas"}),
        ]

    def stub_changes(self, page: Page, changes: list[dict], calls: list[tuple[str, str]]) -> dict:
        current = {"items": changes}
        page.route(re.compile(r".*/api/v1/conversations/[0-9a-f-]{36}/assistant-changes$"), lambda route: route.fulfill(
            status=200, content_type="application/json", body=json.dumps(current)))

        def run_action(route: Route) -> None:
            action = route.request.url.rsplit("/", 1)[1]
            calls.append(("run", action))
            if action == "inbox":
                route.fulfill(status=200, content_type="application/json", body=json.dumps({"moved": 2}))
                return
            decided = []
            for item in current["items"]:
                if item["state"] == "waiting" and item["waitReason"] not in ("live_wiki", "outside_rights"):
                    if action == "apply":
                        item.update(state="applied_after_wait", waitReason=None, line="Approved by Ada Brandt", version=item["version"] + 1)
                    else:
                        item.update(state="not_now", waitReason=None, line="Not now", version=item["version"] + 1)
                    decided.append({"change": item, "message": None})
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"changes": decided}))

        def one_action(route: Route) -> None:
            change_id, action = route.request.url.rsplit("/", 2)[1:]
            calls.append((change_id, action))
            item = next(entry for entry in current["items"] if entry["id"] == change_id)
            if action == "send":
                item.update(sent=True, line="Sent to Jonas", version=item["version"] + 1)
            elif action == "apply":
                item.update(state="applied_after_wait", waitReason=None, line="Approved by Ada Brandt", version=item["version"] + 1)
            else:
                item.update(state="not_now", waitReason=None, line="Not now", version=item["version"] + 1)
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"change": item, "message": None}))
        page.route(re.compile(r".*/api/v1/assistant-runs/[0-9a-f-]{36}/changes/(apply|not-now|inbox)$"), run_action)
        page.route(re.compile(r".*/api/v1/assistant-changes/[0-9a-f-]{36}/(apply|not-now|send)$"), one_action)
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
        expect(page.get_by_text("Can you tidy the sensor tasks")).to_be_visible()
        expect(page.locator(".assistant-waiting")).to_have_count(0)

    def test_02_the_card_says_what_waits_with_the_verb_review_and_not_now(self) -> None:
        page = self.page()
        calls: list[tuple[str, str]] = []
        self.stub_changes(page, self.waiting_set(), calls)
        page.goto(f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}")
        card = page.locator(".assistant-waiting")
        expect(card).to_contain_text("Waiting for you: add 1 task, remove 1 thought")
        # A mix uses Apply; the reasons are in plain words; the deferral and the suggestion have their own lines.
        expect(card.get_by_role("button", name="Apply", exact=True)).to_be_visible()
        expect(card).to_contain_text("You asked me to check with you first · Removing a thought always waits for you")
        expect(card).to_contain_text("I’ll edit Suppliers when Jonas finishes typing.")
        expect(card).to_contain_text("Jonas owns #8 Calibrate the probes. Suggest this change to them?")
        expect(card.get_by_role("button", name="Send to Jonas")).to_be_visible()
        shot(page, "assistant-changes-1440-light-waiting")
        # Review: each change with a check box; unticking the removal leaves the object's own verb.
        card.get_by_role("button", name="Review").click()
        boxes = card.get_by_role("checkbox")
        expect(boxes).to_have_count(2)
        card.get_by_role("checkbox", name=re.compile("remove thought")).uncheck()
        expect(card.get_by_role("button", name="Add", exact=True)).to_be_visible()
        card.get_by_role("button", name="Add", exact=True).click()
        expect(card).to_contain_text("Done: add task Label the sensor cables · Approved by Ada Brandt")
        expect(card).to_contain_text("Waiting for you: remove 1 thought")
        self.assertEqual([call[1] for call in calls], ["apply"])
        # Send to Jonas: only now does the suggestion reach him.
        card.get_by_role("button", name="Send to Jonas").click()
        expect(card).to_contain_text("Sent to Jonas")
        expect(card.get_by_role("button", name="Send to Jonas")).to_have_count(0)
        self.assertEqual(calls[-1][1], "send")
        # Not now closes what is left.
        card.get_by_role("button", name="Not now").click()
        expect(card).not_to_contain_text("Waiting for you")
        self.no_horizontal_scroll(page)

    def test_03_leaving_the_conversation_moves_undecided_changes_to_inbox(self) -> None:
        page = self.page()
        calls: list[tuple[str, str]] = []
        self.stub_changes(page, self.waiting_set()[:2], calls)
        page.goto(f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}")
        expect(page.locator(".assistant-waiting")).to_contain_text("Waiting for you")
        with page.expect_request(lambda request: request.method == "POST" and request.url.endswith(f"/assistant-runs/{self.ids['run']}/changes/inbox")):
            page.goto("/inbox")
        self.assertIn(("run", "inbox"), calls)

    def test_04_inbox_shows_one_question_with_the_objects_verb(self) -> None:
        page = self.page()
        item = {"key": f"assistant:{self.ids['run']}", "kind": "question", "title": "Your assistant wants to remove 2 thoughts",
                "detail": "Removing a thought always waits for you", "project": {"id": self.ids["project"], "name": "Gesture lamp"}, "from": None, "at": NOW,
                "url": f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}", "decision": None, "blocked": None, "reason": "question",
                "snoozeTask": None, "assistantChanges": {"runId": self.ids["run"], "verb": "Remove", "summary": "remove 2 thoughts", "changes": []}}
        queue = {"items": [item], "count": 1, "later": 0, "doneToday": 0}
        applied: list[str] = []
        page.route(re.compile(r".*/api/v1/needs-you(\?.*)?$"), lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(queue)))

        def apply(route: Route) -> None:
            applied.append(route.request.url)
            queue["items"] = []
            queue["count"] = 0
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"changes": [{"change": {}, "message": None}, {"change": {}, "message": None}]}))
        page.route(re.compile(r".*/api/v1/assistant-runs/[0-9a-f-]{36}/changes/apply$"), apply)
        page.goto("/inbox")
        card = page.locator(f'[data-key="assistant:{self.ids["run"]}"]')
        expect(card).to_contain_text("Your assistant wants to remove 2 thoughts")
        expect(card.get_by_role("button", name="Remove", exact=True)).to_be_visible()
        expect(card.get_by_role("button", name="Review")).to_be_visible()
        shot(page, "assistant-changes-1440-light-inbox")
        card.get_by_role("button", name="Remove", exact=True).click()
        expect(page.get_by_text("Done: remove 2 thoughts")).to_be_visible()
        self.assertEqual(len(applied), 1)

    def test_05_phone_reads_the_card_without_overflow(self) -> None:
        for dark in (False, True):
            page = self.page(phone=True, dark=dark)
            self.stub_changes(page, self.waiting_set(), [])
            page.goto(f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}")
            card = page.locator(".assistant-waiting")
            expect(card).to_contain_text("Waiting for you: add 1 task, remove 1 thought")
            card.scroll_into_view_if_needed()
            for name in ("Apply", "Review", "Not now"):
                box = card.get_by_role("button", name=name, exact=True).bounding_box()
                self.assertIsNotNone(box)
                self.assertGreaterEqual(box["height"], 24, f"{name} is a comfortable target")
            self.no_horizontal_scroll(page)
            shot(page, f"assistant-changes-390-{'dark' if dark else 'light'}-waiting")


if __name__ == "__main__":
    unittest.main()
