"""Browser tests for the run's message, Undo and the queue line (F-027 A4, #404; AST-6.1, AST-6.2, AST-6.4, AST-6.8, AST-10.13).

The check_ui.sh stack runs no assistant, so the owner's change log and runs are stubbed with the exact API shapes;
tests/app/assistant-changes.test.ts proves the same Undo end to end through /mcp with a fake engine. This proves the
one message per run (header with Undo, three rows and "+N more", before and after, per-item Undo, "Changed since"),
the partial-Undo sentence, "Stopped after N changes" and "Next: …" with Cancel, at computer and phone width.
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
ADA = {"name": "Ada Brandt", "email": f"ada.undo+{STAMP}@example.test"}
NOW = "2026-10-17T09:00:00.000Z"
WEEK = "2026-10-24T09:00:00.000Z"


class AssistantUndo(unittest.TestCase):
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
                  "decidedBy": None, "runState": "done", "before": None, "after": None, "undoable": False, "version": 1, "createdAt": NOW, "expiresAt": WEEK}
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

    def applied(self, **values) -> dict:
        values.setdefault("state", "applied")
        values.setdefault("waitReason", None)
        values.setdefault("line", None)
        values.setdefault("undoable", True)
        return self.change(**values)

    def message_set(self, run_state: str = "done") -> list[dict]:
        return [
            self.applied(objectId=str(uuid.uuid4()), objectTitle="Calibrate the probes", after="Calibrate the probes", runState=run_state),
            self.applied(objectId=str(uuid.uuid4()), objectTitle="Order spare probes", after="Order spare probes", runState=run_state),
            self.applied(operation="doc.update", objectType="doc", objectId=str(uuid.uuid4()), objectTitle="Probes", phrase="edit page", verb="Edit",
                         after="1 paragraph changed", runState=run_state),
            self.applied(operation="work.update", objectType="work", objectId=str(uuid.uuid4()), objectTitle="#4 Probes", phrase="rename task", verb="Rename",
                         before="Probes", after="Calibrate the probes at two depths", runState=run_state),
            self.change(state="refused", waitReason=None, operation="work.update", objectType="work", objectTitle="#7 Lamp driver", phrase="change task",
                        line="Skipped #7: Jonas changed it while I worked", runState=run_state),
        ]

    def stub_undo(self, page: Page, changes: list[dict], calls: list[tuple[str, str]], *, changed_since: str | None = None) -> None:
        page.route(re.compile(r".*/api/v1/conversations/[0-9a-f-]{36}/assistant-changes$"), lambda route: route.fulfill(
            status=200, content_type="application/json", body=json.dumps({"items": changes})))

        def undo_run(route: Route) -> None:
            calls.append(("run", "undo"))
            results, since, undone = [], [], 0
            for item in changes:
                if item["state"] != "applied":
                    continue
                if changed_since and item["objectTitle"] == changed_since:
                    since.append("#4")
                    results.append({"change": item, "message": "Changed since. Open it"})
                    continue
                item.update(state="undone", undoable=False, line="Undone by Ada Brandt", decidedBy={"id": "ada", "name": "Ada Brandt"})
                undone += 1
                results.append({"change": item, "message": None})
            sentence = f"Undid {undone} change{'s' if undone != 1 else ''}" + (f". {len(since)} changed since: {', '.join(since)}" if since else "")
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"changes": results, "undone": undone, "changedSince": since, "message": sentence}))

        def undo_one(route: Route) -> None:
            change_id = route.request.url.rsplit("/", 2)[1]
            calls.append((change_id, "undo"))
            item = next(entry for entry in changes if entry["id"] == change_id)
            if changed_since and item["objectTitle"] == changed_since:
                route.fulfill(status=200, content_type="application/json", body=json.dumps({"change": item, "message": "Changed since. Open it"}))
                return
            item.update(state="undone", undoable=False, line="Undone by Ada Brandt", decidedBy={"id": "ada", "name": "Ada Brandt"})
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"change": item, "message": None}))
        page.route(re.compile(r".*/api/v1/assistant-runs/[0-9a-f-]{36}/changes/undo$"), undo_run)
        page.route(re.compile(r".*/api/v1/assistant-changes/[0-9a-f-]{36}/undo$"), undo_one)

    def open_conversation(self, page: Page) -> None:
        page.goto(f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}")

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
        self.open_conversation(page)
        expect(page.locator(".assistant-message")).to_have_count(0)

    def _message_journey(self, *, phone: bool, dark: bool) -> None:
        page = self.page(phone=phone, dark=dark)
        calls: list[tuple[str, str]] = []
        changes = self.message_set()
        self.stub_undo(page, changes, calls)
        self.open_conversation(page)
        message = page.locator(".assistant-message")
        # One message: header naming what changed with Undo, at most three rows and "+N more", no separate result line.
        expect(message.locator(".assistant-message__head")).to_contain_text("Done: added 2 tasks, edited 1 page, renamed 1 task")
        expect(message.get_by_role("button", name="Undo")).to_have_count(1)
        expect(message.locator(".assistant-message__rows li")).to_have_count(3)
        expect(message.get_by_role("button", name="+1 more")).to_be_visible()
        expect(message).to_contain_text("Skipped #7: Jonas changed it while I worked")
        self.no_horizontal_scroll(page)
        suffix = f"{'390' if phone else '1440'}-{'dark' if dark else 'light'}"
        shot(page, f"assistant-undo-{suffix}-message")
        # Expanded: every row with its before and after, and its own Undo.
        message.get_by_role("button", name="+1 more").click()
        expect(message.locator(".assistant-message__rows li")).to_have_count(4)
        expect(message.locator("s")).to_have_text("Probes")
        expect(message).to_contain_text("Calibrate the probes at two depths")
        expect(message).to_contain_text("1 paragraph changed")
        self.no_horizontal_scroll(page)
        shot(page, f"assistant-undo-{suffix}-expanded")
        # One item's Undo leaves the others; the header follows.
        row = message.locator(".assistant-message__rows li", has_text="Order spare probes")
        row.get_by_role("button", name="Undo").click()
        expect(message.locator(".assistant-message__head")).not_to_contain_text("added 2 tasks")
        self.assertEqual(calls[-1][1], "undo")

    def test_02_the_message_computer_light(self) -> None:
        self._message_journey(phone=False, dark=False)

    def test_03_the_message_phone_dark(self) -> None:
        self._message_journey(phone=True, dark=True)

    def test_04_undo_all_and_the_partial_sentence(self) -> None:
        page = self.page()
        calls: list[tuple[str, str]] = []
        changes = self.message_set()
        self.stub_undo(page, changes, calls, changed_since="#4 Probes")
        self.open_conversation(page)
        message = page.locator(".assistant-message")
        message.locator(".assistant-message__head").get_by_role("button", name="Undo").click()
        expect(message.locator(".assistant-message__note")).to_have_text("Undid 3 changes. 1 changed since: #4")
        self.assertIn(("run", "undo"), calls)
        # The refused one stays undoable and says why when tried alone.
        message.get_by_role("button", name="+1 more").click()
        row = message.locator(".assistant-message__rows li", has_text="#4 Probes")
        row.get_by_role("button", name="Undo").click()
        expect(row).to_contain_text("Changed since. Open it")
        shot(page, "assistant-undo-1440-light-partial")

    def test_05_everything_undone_reads_undone_by(self) -> None:
        page = self.page()
        changes = self.message_set()[:2]
        self.stub_undo(page, changes, [])
        self.open_conversation(page)
        message = page.locator(".assistant-message")
        message.locator(".assistant-message__head").get_by_role("button", name="Undo").click()
        expect(message.locator(".assistant-message__head")).to_contain_text("Undone by Ada Brandt")
        expect(message.get_by_role("button", name="Undo")).to_have_count(0)

    def test_06_a_stopped_run_says_stopped_after_n_changes(self) -> None:
        page = self.page(phone=True)
        changes = self.message_set("stopped")[:2]
        self.stub_undo(page, changes, [])
        self.open_conversation(page)
        message = page.locator(".assistant-message")
        expect(message.locator(".assistant-message__head")).to_contain_text("Stopped after 2 changes")
        expect(message.get_by_role("button", name="Undo")).to_have_count(1)
        self.no_horizontal_scroll(page)
        shot(page, "assistant-undo-390-light-stopped")

    def test_07_a_working_run_shows_no_message_yet(self) -> None:
        page = self.page()
        self.stub_undo(page, self.message_set("working"), [])
        self.open_conversation(page)
        expect(page.locator(".assistant-message")).to_have_count(0)

    def _run(self, run_id: str, status: str, prompt: str) -> dict:
        return {"id": run_id, "clientRunId": str(uuid.uuid4()), "workspaceId": self.ids["workspace"], "projectId": self.ids["project"],
                "conversationId": self.ids["conversation"], "kind": "ask", "prompt": prompt, "target": None, "continuesRunId": None, "retryOfRunId": None,
                "status": status, "stoppedAtStage": None, "stopRequested": False, "stopAcknowledged": False, "engine": "runtime", "runtimeClient": "claude_code",
                "endReason": None, "planLimitResetsAt": None,
                "cost": {"state": "reserved", "reservedMicros": 0, "chargedMicros": 0, "inputTokens": None, "outputTokens": None},
                "answer": None, "createdAt": NOW, "dispatchedAt": None, "completedAt": None}

    def test_08_a_request_behind_the_working_one_shows_next_with_cancel(self) -> None:
        page = self.page()
        working = self._run(str(uuid.uuid4()), "reading", "Tidy the project")
        behind = self._run(str(uuid.uuid4()), "queued", "turn this into tasks")
        runs = {working["id"]: working, behind["id"]: behind}
        cancelled: list[str] = []
        page.route(re.compile(r".*/api/v1/assistant-runs\?limit=10$"), lambda route: route.fulfill(
            status=200, content_type="application/json", body=json.dumps({"items": [behind, working], "total": 2, "limit": 10, "offset": 0})))
        page.route(re.compile(r".*/api/v1/assistant-runs/[0-9a-f-]{36}$"), lambda route: route.fulfill(
            status=200, content_type="application/json", body=json.dumps(runs[route.request.url.rsplit("/", 1)[1]])))

        def stop(route: Route) -> None:
            run_id = route.request.url.rsplit("/", 2)[1]
            cancelled.append(run_id)
            runs[run_id].update(status="stopped", stopRequested=True)
            route.fulfill(status=200, content_type="application/json", body=json.dumps(runs[run_id]))
        page.route(re.compile(r".*/api/v1/assistant-runs/[0-9a-f-]{36}/stop$"), stop)
        self.open_conversation(page)
        expect(page.locator(".assistant-working")).to_have_count(1)
        queued = page.locator(".assistant-queued")
        expect(queued).to_contain_text("Next: “turn this into tasks”. It starts when this one ends")
        self.no_horizontal_scroll(page)
        shot(page, "assistant-undo-1440-light-queue")
        queued.get_by_role("button", name="Cancel").click()
        expect(queued).to_have_count(0)
        self.assertEqual(cancelled, [behind["id"]])
        expect(page.locator(".assistant-working")).to_have_count(1)


if __name__ == "__main__":
    unittest.main()
