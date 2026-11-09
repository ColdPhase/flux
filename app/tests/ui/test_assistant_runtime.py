"""Browser tests for the assistant on the owner's own Claude Code (F-022 T5, #280; F-027 AST-1, AST-10; #854 Connect AI).

The check_ui.sh stack has no agent runtime (FLUX_AGENT_RUNTIME is empty), so the owner's Claude Code
sign-in, the model choice, the enablement answer and the runs are stubbed responses. This proves the words, the order and
the layout at both widths, not behaviour: tests/app/agent-runtime-runs.test.ts runs the same runs end to
end with the real worker, runtime-manager, supervisor and the TEST ONLY fake `claude` making real MCP calls.
"""

from __future__ import annotations

import copy
import json
import re
import time
import unittest
import uuid
from datetime import datetime, timedelta, timezone

from playwright.sync_api import Browser, BrowserContext, Page, Route, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

PASSWORD = "my own claude plan"
STAMP = int(time.time() * 1000)
ADA = {"name": "Ada Brandt", "email": f"ada.brandt+{STAMP}@example.test"}
# The plan-limit reset the stubbed runs report: an hour from now, in the context's UTC clock.
RESET = (datetime.now(timezone.utc) + timedelta(hours=1)).replace(second=0, microsecond=0)
RESET_ISO = RESET.isoformat().replace("+00:00", ".000Z")
RESUMES = f"at {RESET:%H:%M}" if RESET.date() == datetime.now(timezone.utc).date() else f"tomorrow at {RESET:%H:%M}"
CLAUDE_GROUP = {"connection": "claude_plan", "account": "claude_plan", "label": "Claude plan", "company": "Claude", "options": [
    {"id": "sonnet", "name": "Sonnet", "note": "Everyday work", "callsTools": True},
    {"id": "opus", "name": "Opus", "note": "Harder requests", "callsTools": True},
    {"id": "haiku", "name": "Haiku", "note": "Quick, simple requests", "callsTools": True}]}
KEY_GROUP = {"connection": "6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b", "account": "api_key", "label": "Ada OpenAI key", "company": "OpenAI", "options": [
    {"id": "gpt-6.1-sol", "name": "GPT-6.1 Sol", "note": "$1.25 in · $10 out per 1M tokens", "callsTools": True}]}


class AssistantRuntime(unittest.TestCase):
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

    # ---------------------------------------------------------------- stubs

    def status_stub(self, page: Page, enabled: bool) -> dict:
        real = self.api(page, "GET", "/api/v1/personal-assistant", status=200)
        stub = copy.deepcopy(real)
        stub["setup"] = {"provider": "off", "connection": "none",
                         "runtime": {"state": "signed_in", "payer": "claude_plan", "accountLabel": "a***@example.test", "client": "claude_code"}}
        if enabled:
            now = "2026-10-16T09:00:00.000Z"
            # A plan has no budget of Flux's: `today` is null (#854).
            stub.update(state="ready", unavailableReason=None, today=None, enablement={
                "ownerUserId": ADA["id"], "connection": "claude_plan", "engine": "runtime", "status": "active", "model": "sonnet",
                "agents": [{"workspaceId": self.ids["workspace"], "agentId": self.ids["agent"]}], "version": 1, "createdAt": now, "updatedAt": now})
        else:
            stub.update(state="not_enabled", unavailableReason=None, enablement=None, today=None)
        return stub

    def model_stub(self, page: Page, groups: list[dict]) -> None:
        """The model choice of a signed-in plan (and an API key), Connect AI's default first (#854)."""
        first = groups[0]
        choice = {"current": None, "default": {"connection": first["connection"], "model": first["options"][0]["id"]}, "groups": groups, "saved": False}
        page.route("**/api/v1/personal-assistant/model", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(choice))
                   if route.request.method == "GET" else route.continue_())

    def run_json(self, **changes) -> dict:
        run = {"id": self.ids.get("run", str(uuid.uuid4())), "clientRunId": str(uuid.uuid4()), "workspaceId": self.ids["workspace"], "projectId": self.ids["project"],
               "conversationId": self.ids["conversation"], "kind": "ask", "prompt": "What do the notes say about the sensor?", "target": None,
               "continuesRunId": None, "retryOfRunId": None, "status": "dispatching", "stoppedAtStage": None, "stopRequested": False, "stopAcknowledged": False,
               "engine": "runtime", "endReason": None, "planLimitResetsAt": None, "resumesAt": None,
               "cost": {"state": "reserved", "reservedMicros": 0, "chargedMicros": 0, "inputTokens": None, "outputTokens": None},
               "answer": None, "createdAt": "2026-10-16T09:00:00.000Z", "dispatchedAt": "2026-10-16T09:00:01.000Z", "completedAt": None}
        run.update(changes)
        return run

    # ---------------------------------------------------------------- tests

    def test_01_an_owner_with_a_project(self) -> None:
        page = self.page()
        page.goto("/sign-up")
        page.get_by_label("Name").fill(ADA["name"])
        page.get_by_label("Email").fill(ADA["email"])
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        type(self).state = page.context.storage_state()
        ADA["id"] = self.api(page, "GET", "/api/v1/me", status=200)["user"]["id"]
        ws = self.api(page, "POST", "/api/v1/workspaces", {"name": "Lamp studio"}, status=201)
        project = self.api(page, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Gesture lamp", "visibility": "restricted"}, status=201)
        thread = self.api(page, "POST", f"/api/v1/projects/{project['id']}/conversations", {"body": "Camera or ToF sensor for the bedside lamp?", "clientMessageId": str(uuid.uuid4())}, status=201)
        agent = self.api(page, "POST", f"/api/v1/workspaces/{ws['id']}/agents", {"name": "Ada’s assistant", "owner": "self"}, status=201)
        type(self).ids = {"workspace": ws["id"], "project": project["id"], "conversation": thread["id"], "agent": agent["id"]}

    def test_04_runs_use_plain_words_working_paused_and_sign_in_again(self) -> None:
        page = self.page()
        stub = self.status_stub(page, enabled=True)
        type(self).ids["run"] = str(uuid.uuid4())
        current = {"run": self.run_json()}
        asked: list[dict] = []
        page.route("**/api/v1/personal-assistant", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(stub))
                   if route.request.method == "GET" else route.continue_())
        page.route(re.compile(r".*/api/v1/assistant-runs\?(?:limit=\d+|conversationId=[0-9a-f-]{36}&limit=\d+&offset=\d+)$"), lambda route: route.fulfill(status=200, content_type="application/json",
                   body=json.dumps({"items": [current["run"]], "total": 1, "limit": 10, "offset": 0})))
        page.route(re.compile(r".*/api/v1/assistant-runs/[0-9a-f-]{36}$"), lambda route: route.fulfill(status=200, content_type="application/json",
                   body=json.dumps(current["run"])))

        def ask(route: Route) -> None:
            asked.append(json.loads(route.request.post_data or "{}"))
            route.fulfill(status=202, content_type="application/json", body=json.dumps(self.run_json(
                id=str(uuid.uuid4()), status="unavailable", endReason="sign_in_again", completedAt="2026-10-16T09:01:00.000Z")))
        page.route(re.compile(r".*/api/v1/conversations/[0-9a-f-]{36}/assistant-runs$"), ask)
        # An open tab reads a run again when the live stream says it changed, not on a timer (#862, #1101). The run is stubbed, so the
        # stream is answered here and never reaches the server: the test sends the event the server records when a run's status changes.
        streams: list = []
        page.route_web_socket(re.compile(r".*/api/v1/stream.*"), lambda route: streams.append(route))
        page.goto(f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}")
        working = page.locator(".assistant-working")
        expect(working).to_contain_text("Working…")
        expect(working.get_by_role("button", name="Stop")).to_be_visible()
        shot(page, "runtime-1440-light-working")
        # The CLI reported its plan limit and when it resets: the line says so in the reader's clock.
        current["run"] = self.run_json(status="unavailable", endReason="plan_limit", planLimitResetsAt=RESET_ISO, completedAt="2026-10-16T09:01:00.000Z")
        for _ in range(100):
            if streams:
                break
            page.wait_for_timeout(100)
        self.assertTrue(streams, "the page opened its live stream")
        streams[-1].send(json.dumps({"type": "event", "cursor": "c1", "id": str(uuid.uuid4()), "kind": "assistant_run.changed.v1", "workspaceId": self.ids["workspace"],
                                     "objectType": "assistant_run", "objectId": current["run"]["id"], "createdAt": "2026-10-16T09:01:00.000Z"}))
        expect(working).to_contain_text(f"Claude limit reached until {RESUMES.removeprefix('at ')}")
        expect(working.get_by_role("button", name="Stop")).to_have_count(0)
        shot(page, "runtime-1440-light-plan-limit")
        working.get_by_role("button", name="Dismiss").click()
        expect(working).to_have_count(0)
        # The ask bar names the plan, never a money cap.
        composer = page.locator("#thread-composer")
        composer.fill("/ai What changed since yesterday?")
        expect(page.locator("#project-ask")).to_contain_text("on your Claude plan")
        page.get_by_role("button", name="Send to your assistant").click()
        expect(working).to_contain_text("Sign in to Claude again to keep using your assistant.")
        self.assertEqual(asked[0]["prompt"], "What changed since yesterday?")
        self.no_horizontal_scroll(page)

    def test_04b_a_request_with_no_room_on_the_server_waits_with_one_line(self) -> None:
        """#860: the server runs as many agents as fit in its memory; the others wait in order, and the line says why."""
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page(phone=phone)
                stub = self.status_stub(page, enabled=True)
                run = self.run_json(id=str(uuid.uuid4()), status="queued", endReason="no_room", dispatchedAt=None)
                page.route("**/api/v1/personal-assistant", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(stub))
                           if route.request.method == "GET" else route.continue_())
                page.route(re.compile(r".*/api/v1/assistant-runs\?(?:limit=\d+|conversationId=[0-9a-f-]{36}&limit=\d+&offset=\d+)$"), lambda route: route.fulfill(status=200, content_type="application/json",
                           body=json.dumps({"items": [run], "total": 1, "limit": 10, "offset": 0})))
                page.route(re.compile(r".*/api/v1/assistant-runs/[0-9a-f-]{36}$"), lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(run)))
                page.goto(f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}")
                working = page.locator(".assistant-working")
                expect(working).to_contain_text("Waiting for room on the server")
                expect(working.get_by_role("button", name=re.compile("switch|another|instead", re.I))).to_have_count(0)
                self.no_horizontal_scroll(page)
                shot(page, f"runtime-{'390' if phone else '1440'}-light-no-room")

    def test_05_phone_reads_the_runtime_lines_without_overflow(self) -> None:
        page = self.page(phone=True)
        stub = self.status_stub(page, enabled=True)
        run = self.run_json(id=str(uuid.uuid4()), status="unavailable", endReason="plan_limit", planLimitResetsAt=None, completedAt="2026-10-16T09:01:00.000Z")
        page.route("**/api/v1/personal-assistant", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(stub))
                   if route.request.method == "GET" else route.continue_())
        page.route(re.compile(r".*/api/v1/conversations/[0-9a-f-]{36}/assistant-runs$"), lambda route: route.fulfill(
            status=202, content_type="application/json", body=json.dumps(run)))
        page.goto(f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}")
        composer = page.locator("#thread-composer")
        composer.fill("/ai Summarize the sensor notes")
        page.get_by_role("button", name="Send to your assistant").tap()
        expect(page.locator(".assistant-working")).to_contain_text("Claude limit reached")
        expect(page.locator(".assistant-working")).not_to_contain_text("resumes")
        self.no_horizontal_scroll(page)
        shot(page, "runtime-390-light-plan-limit")

    def test_06_codex_runs_use_the_chatgpt_words(self) -> None:
        """#281 / F-027 Journey 6: on the owner's own Codex, the plan-limit and sign-in lines name ChatGPT, the ask bar the ChatGPT plan."""
        page = self.page(phone=True)
        stub = self.status_stub(page, enabled=True)
        stub["setup"]["runtime"] = {"state": "signed_in", "payer": "chatgpt_plan", "accountLabel": None, "client": "codex"}
        stub["enablement"].update(connection="chatgpt_plan", model="gpt-6.1-sol")
        runs = [self.run_json(id=str(uuid.uuid4()), runtimeClient="codex", status="unavailable", endReason="plan_limit",
                              planLimitResetsAt=RESET_ISO, completedAt="2026-10-16T09:01:00.000Z"),
                self.run_json(id=str(uuid.uuid4()), runtimeClient="codex", status="unavailable", endReason="sign_in_again", completedAt="2026-10-16T09:02:00.000Z")]
        page.route("**/api/v1/personal-assistant", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(stub))
                   if route.request.method == "GET" else route.continue_())
        page.route(re.compile(r".*/api/v1/conversations/[0-9a-f-]{36}/assistant-runs$"), lambda route: route.fulfill(
            status=202, content_type="application/json", body=json.dumps(runs.pop(0))))
        page.goto(f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}")
        composer = page.locator("#thread-composer")
        composer.fill("/ai Summarize the sensor notes")
        expect(page.locator("#project-ask")).to_contain_text("on your ChatGPT plan")
        page.get_by_role("button", name="Send to your assistant").tap()
        working = page.locator(".assistant-working")
        expect(working).to_contain_text(f"ChatGPT limit reached until {RESUMES.removeprefix('at ')}")
        self.no_horizontal_scroll(page)
        shot(page, "runtime-390-light-codex-plan-limit")
        working.get_by_role("button", name="Dismiss").tap()
        composer.fill("/ai Summarize the sensor notes")
        page.get_by_role("button", name="Send to your assistant").tap()
        expect(working).to_contain_text("Sign in to ChatGPT again to keep using your assistant.")


if __name__ == "__main__":
    unittest.main()
