"""Browser tests for the run's message, Undo and the queue line (F-027 A4, #404; AST-6.1, AST-6.2, AST-6.4, AST-6.8, AST-10.13).

The check_ui.sh stack runs no assistant, so the owner's change log and runs are stubbed with the exact API shapes;
tests/app/assistant-changes.test.ts proves the same Undo end to end through /mcp with a fake engine. This proves the
one message per run (header with Undo, three rows and "+N more", before and after, per-item Undo, "Changed since"),
the partial-Undo sentence, "Stopped after N changes" and "Next: …" with Cancel, at computer and phone width.
"""

from __future__ import annotations

import json
import os
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Error as PlaywrightError, Page, Route, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")  # chromium (default) or webkit, as in the other journeys (#68 AC-8)
PASSWORD = "waiting for my ok"
STAMP = int(time.time() * 1000)
ADA = {"name": "Ada Brandt", "email": f"ada.undo+{STAMP}@example.test"}
JONAS = {"name": "Jonas Weber", "email": f"jonas.undo+{STAMP}@example.test"}
LEE = {"name": "Lee Marsh", "email": f"lee.undo+{STAMP}@example.test"}
NOW = "2026-10-17T09:00:00.000Z"
WEEK = "2026-10-24T09:00:00.000Z"


class AssistantUndo(unittest.TestCase):
    """Tests run in name order and share one account."""

    pw = None
    browser: Browser
    state: dict | None = None
    states: dict[str, dict] = {}
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

    def context(self, *, phone: bool = False, dark: bool = False, who: str | None = None) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "color_scheme": "dark" if dark else "light", "locale": "en-GB", "timezone_id": "UTC"}
        options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True) if phone else options.update(viewport=DESKTOP, device_scale_factor=1)
        state = self.states[who] if who else self.state
        if state:
            options["storage_state"] = state
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
        # The item that could not be taken back says why in its own row, opened for the person, from the header's Undo too.
        row = message.locator(".assistant-message__rows li", has_text="#4 Probes")
        expect(row).to_contain_text("Changed since. Open it")
        # It stays undoable and says the same when tried alone.
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

    def test_05b_undo_by_keyboard_keeps_focus_in_the_message_once_the_button_is_gone(self) -> None:
        page = self.page()
        changes = self.message_set()[:2]
        self.stub_undo(page, changes, [])
        self.open_conversation(page)
        message = page.locator(".assistant-message")
        undo = message.locator(".assistant-message__head").get_by_role("button", name="Undo")
        undo.focus()
        expect(undo).to_be_focused()
        page.keyboard.press("Enter")
        expect(message.locator(".assistant-message__head")).to_contain_text("Undone by Ada Brandt")
        expect(message.get_by_role("button", name="Undo")).to_have_count(0)
        # The button that was pressed is gone; focus is on the message, not on the page (AC-8, keyboard).
        expect(message).to_be_focused()

    def test_05c_a_map_a_result_a_decision_and_a_message_have_their_own_undo_and_say_why_when_used(self) -> None:
        # #68 closeout: what no person can remove, the assistant's own Undo takes back while nobody used it (tests/app/assistant-changes.test.ts).
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page(phone=phone)
                calls: list[tuple[str, str]] = []
                changes = [
                    self.applied(operation="map.create", objectType="map", objectId=str(uuid.uuid4()), objectTitle="Probe layout", phrase="add map", verb="Add", after="Probe layout"),
                    self.applied(operation="result.record", objectType="result", objectTitle="Camera fails below 5 lux", phrase="record result", verb="Record", after="Camera fails below 5 lux"),
                    self.applied(operation="decision.propose", objectType="decision", objectTitle="Use the ToF sensor", phrase="propose decision", verb="Propose", after="Use the ToF sensor"),
                    self.applied(operation="conversation.reply", objectType="message", objectId=str(uuid.uuid4()), objectTitle="Here is the summary", phrase="post message", verb="Post", after="Here is the summary"),
                ]
                self.stub_undo(page, changes, calls)
                message_id = changes[3]["id"]

                def answered_since(route: Route) -> None:
                    if route.request.url.rsplit("/", 2)[1] == message_id:
                        route.fulfill(status=200, content_type="application/json", body=json.dumps({"change": changes[3], "message": "Replies since. Open it"}))
                    else:
                        route.fallback()
                page.route(re.compile(r".*/api/v1/assistant-changes/[0-9a-f-]{36}/undo$"), answered_since)
                self.open_conversation(page)
                message = page.locator(".assistant-message")
                head = message.locator(".assistant-message__head")
                for word in ("map", "result", "decision", "message"):
                    expect(head).to_contain_text(word)
                expect(head.get_by_role("button", name="Undo")).to_have_count(1)
                message.get_by_role("button", name=re.compile(r"\+1 more|Show details")).click()
                rows = message.locator(".assistant-message__rows li")
                expect(rows).to_have_count(4)
                for index in range(4):
                    expect(rows.nth(index).get_by_role("button", name="Undo")).to_be_visible()
                # The message was answered since: its Undo says so, in its own row, and stays.
                rows.nth(3).get_by_role("button", name="Undo").click()
                expect(rows.nth(3)).to_contain_text("Replies since. Open it")
                expect(rows.nth(3).get_by_role("button", name="Undo")).to_be_visible()
                # An untouched map goes at once.
                rows.nth(0).get_by_role("button", name="Undo").click()
                expect(head).not_to_contain_text("map")
                self.no_horizontal_scroll(page)
                shot(page, f"assistant-undo-{'390' if phone else '1440'}-light-removals")

    def test_05d_a_message_the_assistant_took_back_keeps_its_place_and_reads_as_removed(self) -> None:
        page = self.page()

        conversation_id = self.ids["conversation"]

        def mark(node) -> None:
            """Every copy of the conversation's first message in a response reads as taken back, wherever the response nests it."""
            if isinstance(node, dict):
                if node.get("conversationId") == conversation_id and node.get("sequence") == 1 and "body" in node:
                    node.update(body="[Removed with Undo]", removedAt=NOW)
                for child in node.values():
                    mark(child)
            elif isinstance(node, list):
                for child in node:
                    mark(child)

        def tombstone(route: Route) -> None:
            if route.request.method != "GET":
                route.fallback()
                return
            try:
                response = route.fetch()
                try:
                    payload = response.json()
                except Exception:
                    route.fulfill(response=response)
                    return
                mark(payload)
                route.fulfill(response=response, json=payload)
            except PlaywrightError:
                pass  # the page or the context closed while a read was in flight: nothing is left to answer
        page.route(re.compile(r".*/api/v1/(conversations|projects)/.*"), tombstone)
        self.open_conversation(page)
        removed = page.locator(".message-body--removed").first
        expect(removed).to_have_text("[Removed with Undo]")
        self.assertEqual(removed.evaluate("(node) => getComputedStyle(node).fontStyle"), "italic")
        self.no_horizontal_scroll(page)
        # No handler may still be reading when the context closes: that would fail the next test's page, not this one.
        page.unroute_all(behavior="ignoreErrors")

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

    # ------------------------------------------------- everyone reads it, editors undo it (AST-6 "Visible to everyone")

    def test_09_two_more_people_join_the_project(self) -> None:
        ada = self.page()
        for key, person in (("jonas", JONAS), ("lee", LEE)):
            fresh = self.browser.new_context(base_url=ORIGIN, service_workers="block", viewport=DESKTOP)
            self.addCleanup(fresh.close)
            page = fresh.new_page()
            page.goto("/sign-up")
            page.get_by_label("Name").fill(person["name"])
            page.get_by_label("Email").fill(person["email"])
            page.get_by_label("Password").fill(PASSWORD)
            page.get_by_role("button", name="Create account").click()
            expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
            type(self).states[key] = fresh.storage_state()
            person["id"] = self.api(page, "GET", "/api/v1/me", status=200)["user"]["id"]
            self.api(ada, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/members", {"email": person["email"], "role": "member"}, status=201)
        self.api(ada, "POST", f"/api/v1/projects/{self.ids['project']}/grants", {"principal": {"kind": "human", "id": JONAS["id"]}, "role": "contributor"}, status=201)
        self.api(ada, "POST", f"/api/v1/projects/{self.ids['project']}/grants", {"principal": {"kind": "human", "id": LEE["id"]}, "role": "viewer"}, status=201)

    def seen_by(self, who: str, *, undoable: bool, owner_id: str = "ada", phone: bool = False) -> tuple[Page, list[dict], list[tuple[str, str]]]:
        """Another person's page: the same changes, as the server lists them for a reader (Undo only for someone who may edit)."""
        page = self.page(phone=phone, who=who)
        calls: list[tuple[str, str]] = []
        changes = [{**item, "undoable": undoable, "owner": {"id": owner_id, "name": ADA["name"]}} for item in self.message_set()[:3]]
        self.stub_undo(page, changes, calls)
        return page, changes, calls

    def test_10_jonas_sees_what_ada_s_assistant_did_and_may_undo_it(self) -> None:
        page, changes, calls = self.seen_by("jonas", undoable=True)
        self.open_conversation(page)
        message = page.get_by_role("region", name="What Ada’s assistant changed")
        expect(message.locator(".assistant-message__who")).to_have_text("Ada’s assistant")
        expect(message.locator(".assistant-message__head")).to_contain_text("Done: added 2 tasks, edited 1 page")
        expect(message.get_by_role("button", name="Undo")).to_have_count(1)
        # Nothing of what waits for Ada is Jonas's to see: no card, no Apply.
        expect(page.locator(".assistant-waiting")).to_have_count(0)
        shot(page, "assistant-undo-1440-light-jonas")
        message.locator(".assistant-message__head").get_by_role("button", name="Undo").click()
        expect(message.locator(".assistant-message__head")).to_contain_text("Undone by")
        self.assertIn(("run", "undo"), calls)

    def test_11_a_viewer_sees_the_message_without_undo(self) -> None:
        page, _, calls = self.seen_by("lee", undoable=False, phone=True)
        self.open_conversation(page)
        message = page.get_by_role("region", name="What Ada’s assistant changed")
        expect(message.locator(".assistant-message__who")).to_have_text("Ada’s assistant")
        expect(message.locator(".assistant-message__head")).to_contain_text("Done: added 2 tasks, edited 1 page")
        expect(message.get_by_role("button", name="Undo")).to_have_count(0)
        message.get_by_role("button", name="Show details").click()
        expect(message.get_by_role("button", name="Undo")).to_have_count(0)
        self.no_horizontal_scroll(page)
        shot(page, "assistant-undo-390-light-viewer")
        self.assertEqual(calls, [])

    def test_12_everyone_sees_that_ada_s_assistant_is_working_and_nothing_more(self) -> None:
        ada_id = self.api(self.page(), "GET", "/api/v1/me", status=200)["user"]["id"]
        for who, expected in (("jonas", True), ("lee", True), (None, False)):
            page = self.page(who=who)
            page.route(re.compile(r".*/api/v1/conversations/[0-9a-f-]{36}/assistant-changes$"), lambda route: route.fulfill(
                status=200, content_type="application/json", body=json.dumps({"items": []})))
            page.route(re.compile(r".*/api/v1/conversations/[0-9a-f-]{36}/assistant-activity$"), lambda route: route.fulfill(
                status=200, content_type="application/json", body=json.dumps({"working": [{"ownerId": ada_id, "ownerName": ADA["name"]}]})))
            self.open_conversation(page)
            line = page.locator(".assistant-working--others")
            if expected:
                expect(line).to_have_text("Ada’s assistant is working…")
                # No detail and no Stop for anyone else (AST-10.6).
                expect(page.get_by_role("button", name="Stop")).to_have_count(0)
                expect(page.locator(".assistant-working__who")).to_have_count(0)
                expect(line.locator(".kreska")).to_have_count(1)
                if who == "jonas":
                    shot(page, "assistant-undo-1440-light-others-working")
                    # With Settings → Appearance off, the face is gone and the words stay, like the owner's own working line.
                    settings = page.context.new_page()
                    settings.goto("/settings")
                    settings.get_by_role("switch", name="Kreska in loading and empty screens").click()
                    expect(settings.get_by_role("switch", name="Kreska in loading and empty screens")).to_have_attribute("aria-checked", "false")
                    try:
                        page.reload()
                        expect(line).to_have_text("Ada’s assistant is working…")
                        expect(line.locator(".kreska")).to_have_count(0)
                    finally:
                        settings.get_by_role("switch", name="Kreska in loading and empty screens").click()
                        settings.close()
            else:
                # Ada's own page never shows the line about herself: her working line is the owner's, with Stop.
                expect(page.locator(".project-convo__message").first).to_be_visible()
                expect(line).to_have_count(0)

    def test_13_the_closing_words_open_the_thing_that_changed(self) -> None:
        page = self.page()
        work = self.api(page, "POST", f"/api/v1/projects/{self.ids['project']}/work", {"title": "Calibrate the probes"}, status=201)
        calls: list[tuple[str, str]] = []
        changes = [self.applied(operation="work.update", objectType="work", objectId=work["id"], objectTitle=f"#{work['number']} Calibrate the probes",
                                phrase="rename task", verb="Rename", before="Probes", after="Calibrate the probes at two depths", runState="done")]
        self.stub_undo(page, changes, calls, changed_since=f"#{work['number']} Calibrate the probes")
        self.open_conversation(page)
        message = page.locator(".assistant-message")
        message.get_by_role("button", name="Show details").click()
        row = message.locator(".assistant-message__rows li")
        row.get_by_role("button", name="Undo").click()
        expect(row).to_contain_text("Changed since.")
        row.get_by_role("button", name="Open it").click()
        expect(page.get_by_role("complementary", name="Details")).to_contain_text("Calibrate the probes")

    def test_14_a_hand_off_says_where_it_stands_and_why_undo_refuses_after_the_start(self) -> None:
        page = self.page()
        work = self.api(page, "POST", f"/api/v1/projects/{self.ids['project']}/work", {"title": "Review the lamp plan"}, status=201)
        calls: list[tuple[str, str]] = []
        item = self.applied(operation="cowork.unit.create", objectType="work", objectId=work["id"], objectTitle=f"#{work['number']} Review the lamp plan",
                            phrase="hand off task", verb="Hand off", after="Handed to Codex", line="Codex started", runState="done")
        self.stub_undo(page, [item], calls)
        # The server refuses once the recipient started; the item keeps its Undo and says so in words.
        page.route(re.compile(r".*/api/v1/assistant-changes/[0-9a-f-]{36}/undo$"), lambda route: route.fulfill(
            status=200, content_type="application/json", body=json.dumps({"change": item, "message": "Your Codex already started. Open the task"})))
        self.open_conversation(page)
        message = page.locator(".assistant-message")
        expect(message.locator(".assistant-message__head")).to_contain_text("Done: handed off 1 task")
        message.get_by_role("button", name="Show details").click()
        row = message.locator(".assistant-message__rows li")
        expect(row).to_contain_text("Handed to Codex")
        expect(row).to_contain_text("Codex started")
        row.get_by_role("button", name="Undo").click()
        expect(row).to_contain_text("Your Codex already started.")
        row.get_by_role("button", name="Open the task").click()
        expect(page.get_by_role("complementary", name="Details")).to_contain_text("Review the lamp plan")
        shot(page, "assistant-undo-1440-light-handoff")

    def test_14b_the_header_undo_reports_a_started_hand_off_in_its_row(self) -> None:
        page = self.page()
        work = self.api(page, "POST", f"/api/v1/projects/{self.ids['project']}/work", {"title": "Review the sensor plan"}, status=201)
        started = self.applied(operation="cowork.unit.create", objectType="work", objectId=work["id"], objectTitle=f"#{work['number']} Review the sensor plan",
                               phrase="hand off task", verb="Hand off", after="Handed to Codex", line="Codex started", runState="done")
        calls: list[tuple[str, str]] = []
        self.stub_undo(page, [started], calls)
        page.route(re.compile(r".*/api/v1/assistant-runs/[0-9a-f-]{36}/changes/undo$"), lambda route: route.fulfill(
            status=200, content_type="application/json", body=json.dumps({
                "changes": [{"change": started, "message": "Your Codex already started. Open the task"}], "undone": 0, "changedSince": [f"#{work['number']}"],
                "message": f"Undid 0 changes. 1 changed since: #{work['number']}"})))
        self.open_conversation(page)
        message = page.locator(".assistant-message")
        message.locator(".assistant-message__head").get_by_role("button", name="Undo").click()
        row = message.locator(".assistant-message__rows li")
        expect(row).to_contain_text("Your Codex already started.")
        row.get_by_role("button", name="Open the task").click()
        expect(page.get_by_role("complementary", name="Details")).to_contain_text("Review the sensor plan")

    def test_15_a_request_behind_a_background_run_says_what_it_waits_for_and_can_stop_it(self) -> None:
        page = self.page()
        summary_id = str(uuid.uuid4())
        behind = {"runId": summary_id, "authority": "owner_schedule", "label": "Morning summary"}
        waiting = {**self._run(str(uuid.uuid4()), "queued", "turn this into tasks"), "behind": behind}
        state = {"run": waiting, "stopped": []}
        page.route(re.compile(r".*/api/v1/assistant-runs\?limit=10$"), lambda route: route.fulfill(
            status=200, content_type="application/json", body=json.dumps({"items": [state["run"]], "total": 1, "limit": 10, "offset": 0})))
        page.route(re.compile(r".*/api/v1/assistant-runs/[0-9a-f-]{36}$"), lambda route: route.fulfill(
            status=200, content_type="application/json", body=json.dumps(state["run"])))

        def stop(route: Route) -> None:
            state["stopped"].append(route.request.url.rsplit("/", 2)[1])
            state["run"] = {**state["run"], "status": "reading", "behind": None}
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"id": summary_id}))
        page.route(re.compile(r".*/api/v1/assistant-runs/[0-9a-f-]{36}/stop$"), stop)
        self.open_conversation(page)
        line = page.locator(".assistant-queued")
        expect(line).to_contain_text("Finishing your Morning summary first. Yours starts next.")
        expect(line.get_by_role("button", name="Stop the morning summary")).to_be_visible()
        self.no_horizontal_scroll(page)
        shot(page, "assistant-undo-1440-light-background")
        line.get_by_role("button", name="Stop the morning summary").click()
        expect(line).to_have_count(0)
        self.assertEqual(state["stopped"], [summary_id], "it stopped the background run, not the request")
        expect(page.locator(".assistant-working")).to_have_count(1)

    def test_15b_stopping_the_background_run_fails_in_words(self) -> None:
        page = self.page()
        behind = {"runId": str(uuid.uuid4()), "authority": "owner_reaction", "label": "Blocked-task watch"}
        waiting = {**self._run(str(uuid.uuid4()), "queued", "turn this into tasks"), "behind": behind}
        page.route(re.compile(r".*/api/v1/assistant-runs\?limit=10$"), lambda route: route.fulfill(
            status=200, content_type="application/json", body=json.dumps({"items": [waiting], "total": 1, "limit": 10, "offset": 0})))
        page.route(re.compile(r".*/api/v1/assistant-runs/[0-9a-f-]{36}$"), lambda route: route.fulfill(
            status=200, content_type="application/json", body=json.dumps(waiting)))

        def refuse(route: Route) -> None:
            if page.evaluate("!navigator.onLine"):  # routed requests bypass the emulated network, so offline is aborted here
                route.abort("internetdisconnected")
            else:
                route.fulfill(status=500, content_type="application/json", body=json.dumps({"error": "Stop did not go through", "code": "SERVER_ERROR"}))
        page.route(re.compile(r".*/api/v1/assistant-runs/[0-9a-f-]{36}/stop$"), refuse)
        self.open_conversation(page)
        line = page.locator(".assistant-queued")
        expect(line).to_contain_text("Finishing your Blocked-task watch first. Yours starts next.")
        stop = line.get_by_role("button", name="Stop the blocked-task watch")
        stop.click()
        expect(line.get_by_role("alert")).to_be_visible()
        expect(line).to_contain_text("Finishing your Blocked-task watch first.")
        # Offline it says so instead of failing silently.
        page.context.set_offline(True)
        stop.click()
        expect(line.get_by_role("alert")).to_have_text("Offline")
        page.context.set_offline(False)

    def test_16_a_run_that_died_after_two_changes_says_so_and_lists_them_with_undo(self) -> None:
        page = self.page()
        run_id = self.ids["run"]
        working = self._run(run_id, "reading", "Tidy the project")
        calls = {"n": 0}
        page.route(re.compile(r".*/api/v1/assistant-runs\?limit=10$"), lambda route: route.fulfill(
            status=200, content_type="application/json", body=json.dumps({"items": [working], "total": 1, "limit": 10, "offset": 0})))

        def read(route: Route) -> None:
            calls["n"] += 1
            body = working if calls["n"] < 2 else {**working, "status": "provider_failed", "endReason": "crashed", "completedAt": NOW}
            route.fulfill(status=200, content_type="application/json", body=json.dumps(body))
        page.route(re.compile(r".*/api/v1/assistant-runs/[0-9a-f-]{36}$"), read)
        changes = [self.applied(objectId=str(uuid.uuid4()), objectTitle="Committed one", after="Committed one", runState="failed"),
                   self.applied(objectId=str(uuid.uuid4()), objectTitle="Committed two", after="Committed two", runState="failed")]
        self.stub_undo(page, changes, [])
        self.open_conversation(page)
        message = page.locator(".assistant-message")
        expect(message.locator(".assistant-message__head")).to_contain_text("Done: added 2 tasks")
        expect(message.get_by_role("button", name="Undo")).to_have_count(1)
        ended = page.locator(".assistant-working")
        expect(ended).to_contain_text("2 changes were made before it ended.", timeout=20000)
        expect(ended).not_to_contain_text("Nothing was posted")
        shot(page, "assistant-undo-1440-light-dead-run")


if __name__ == "__main__":
    unittest.main()
