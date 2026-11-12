"""Browser tests for the assistant journeys (F-027 A7, #407; AST-10.1, 10.6, 10.7, 10.9, 10.15).

Same stubbed-engine approach as test_assistant_screen: this proves the words, the order and the flow at both widths;
tests/app/assistant-what-it-may-do.test.ts proves Undo against the real store.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
import re
import unittest
import uuid

from playwright.sync_api import Route, expect

import test_assistant_screen as base
from test_assistant_screen import menu_clipped_by, pick_suggestion, suggestions_reachable
from test_app_shell import shot

FORBIDDEN = base.FORBIDDEN
NOW = base.NOW
# The Claude plan's models, Connect AI's default first (#854): the ready card preselects Sonnet of the Claude plan.
PLAN = {"connection": "claude_plan", "model": "sonnet"}
CHOICE = {"current": None, "default": PLAN, "saved": False, "groups": [{"connection": "claude_plan", "account": "claude_plan", "label": "Claude plan",
          "company": "Claude", "options": [{"id": "sonnet", "name": "Sonnet", "note": "Everyday work", "callsTools": True},
                                           {"id": "opus", "name": "Opus", "note": "Harder requests", "callsTools": True}]}]}


def stub_plan_model(page, json_reply) -> None:
    page.route(re.compile(r".*/api/v1/personal-assistant/model(\?.*)?$"), lambda route: json_reply(route, CHOICE))


class AssistantJourneys(unittest.TestCase):
    """Tests run in name order and share one account (the harness is test_assistant_screen's)."""

    state: dict | None = None
    ids: dict[str, str] = {}
    setUpClass = classmethod(base.AssistantScreen.setUpClass.__func__)
    tearDownClass = classmethod(base.AssistantScreen.tearDownClass.__func__)
    pw = None
    for _name in ("context", "page", "api", "json", "status", "stub_assistant", "stub_thread", "thread_url", "no_horizontal_scroll", "tag"):
        locals()[_name] = getattr(base.AssistantScreen, _name)
    del _name

    def test_01_an_owner_with_a_project(self) -> None:
        # Its own account, so this module and test_assistant_screen can run in one process.
        original = base.ADA["email"]
        base.ADA["email"] = original.replace("ada.screen", "ada.journeys")
        try:
            base.AssistantScreen.test_01_an_owner_with_a_project(self)
        finally:
            base.ADA["email"] = original

    def run_json(self, **changes) -> dict:
        run = {"id": str(uuid.uuid4()), "clientRunId": str(uuid.uuid4()), "workspaceId": self.ids["workspace"], "projectId": self.ids["project"],
               "conversationId": self.ids["conversation"], "kind": "ask", "prompt": "Tidy this project's tasks", "target": None,
               "continuesRunId": None, "retryOfRunId": None, "status": "dispatching", "stoppedAtStage": None, "stopRequested": False, "stopAcknowledged": False,
               "engine": "runtime", "runtimeClient": "claude_code", "endReason": None, "planLimitResetsAt": None,
               "cost": {"state": "reserved", "reservedMicros": 0, "chargedMicros": 0, "inputTokens": None, "outputTokens": None},
               "answer": None, "createdAt": NOW, "dispatchedAt": NOW, "completedAt": None}
        run.update(changes)
        return run

    def change(self, **changes) -> dict:
        row = {"id": str(uuid.uuid4()), "runId": str(uuid.uuid4()), "projectId": self.ids["project"], "conversationId": self.ids["conversation"], "operation": "work.update",
               "objectType": "work", "objectId": str(uuid.uuid4()), "objectTitle": "#3 Calibrate the probes", "state": "applied", "waitReason": None, "phrase": "renamed task",
               "verb": "Apply", "line": None, "forPerson": None, "tells": [], "agentName": "Assistant", "via": None, "done": "renamed task #3 Calibrate the probes", "decidedBy": None, "owner": {"id": "ada", "name": "Ada"}, "runState": "done", "before": "Probes", "after": "Calibrate the probes",
               "undoable": True, "version": 1, "createdAt": datetime.now(timezone.utc).isoformat()}
        row.update(changes)
        return row

    def stub_runs(self, page, on_ask) -> list[dict]:
        """Own runs, one run and the ask endpoint; `on_ask(body)` returns (status, run)."""
        asked: list[dict] = []
        page.route(re.compile(r".*/api/v1/assistant-runs\?(?:limit=\d+|conversationId=[0-9a-f-]{36}&limit=\d+&offset=\d+)$"), lambda route: self.json(route, {"items": [], "total": 0, "limit": 10, "offset": 0}))

        def ask(route: Route) -> None:
            if page.evaluate("!navigator.onLine"):  # routed requests bypass the emulated network, so offline is aborted here
                route.abort("internetdisconnected")
                return
            body = json.loads(route.request.post_data or "{}")
            asked.append(body)
            status, payload = on_ask(body)
            self.json(route, payload, status)
        page.route(re.compile(r".*/api/v1/conversations/[0-9a-f-]{36}/assistant-runs$"), ask)
        return asked

    # ---------------------------------------------------------------- Journey 1: ready, Turn on, suggestions, 6 taps

    def test_05_stop_is_a_44px_keyboard_reachable_button_and_says_offline(self) -> None:
        page = self.page()
        self.stub_assistant(page)
        run = self.run_json()
        self.stub_thread(page)
        page.route(re.compile(r".*/api/v1/assistant-runs\?(?:limit=\d+|conversationId=[0-9a-f-]{36}&limit=\d+&offset=\d+)$"), lambda route: self.json(route, {"items": [run], "total": 1, "limit": 10, "offset": 0}))
        page.route(re.compile(r".*/api/v1/assistant-runs/[0-9a-f-]{36}$"), lambda route: self.json(route, run))
        page.goto(self.thread_url())
        stop = page.locator(".assistant-working").get_by_role("button", name="Stop")
        expect(stop).to_be_visible()
        self.assertGreaterEqual(stop.bounding_box()["height"], 44)
        stop.focus()
        expect(stop).to_be_focused()
        page.context.set_offline(True)
        page.keyboard.press("Enter")
        expect(page.locator(".assistant-working__error")).to_have_text("Offline")

    def open_suggestions(self, page, phone: bool):
        """#1224: `/` lists the thread's two suggestions under `/ai`, and nothing sits above or below the composer. The rows are compact: at most
        30 px with a mouse and at least 44 px on touch; the page never scrolls sideways."""
        expect(page.locator("#thread-composer")).to_be_visible()
        expect(page.locator(".assistant-suggestions")).to_have_count(0)
        page.locator("#thread-composer").fill("/")
        menu = page.get_by_role("listbox", name="Actions")
        rows = menu.locator(".cmenu__o--ask")
        expect(rows).to_have_count(2)
        expect(rows).to_contain_text(["Catch me up on this thread", "Turn this thread into tasks"])
        order = menu.locator(".cmenu__o").evaluate_all("(rows) => rows.map((row) => row.querySelector('code, .cmenu__name').textContent)")
        self.assertEqual(order[-3:], ["/ai", "Catch me up on this thread", "Turn this thread into tasks"], "under /ai, understand first and then act")
        boxes = [row.bounding_box() for row in rows.all()]
        self.assertTrue(all(box["height"] >= 44 for box in boxes) if phone else all(box["height"] <= 30 for box in boxes), boxes)
        suggestions_reachable(self, menu, rows)
        self.assertIsNone(menu_clipped_by(page, menu), "the menu sits inside the pane or sheet")
        self.assertEqual(menu.get_by_role("option", name=re.compile("Tidy this space")).count(), 0, "a space-wide action is not offered in a thread")
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth"), 0)
        return menu

    def test_06_a_request_sent_offline_waits_and_goes_out_once_when_back(self) -> None:
        page = self.page(phone=True)
        self.stub_assistant(page)
        self.stub_thread(page)
        asked = self.stub_runs(page, lambda body: (202, self.run_json(clientRunId=body["clientRunId"], prompt=body["prompt"])))
        page.goto(self.thread_url())
        menu = self.open_suggestions(page, phone=True)
        shot(page, "suggestions-thread-390-light")
        page.context.set_offline(True)
        menu.get_by_role("option", name="Ask your assistant: Catch me up on this thread", exact=True).click()
        expect(page.get_by_text("Sends when you're back")).to_be_visible()
        shot(page, "offline-390-light")
        self.assertEqual(asked, [])
        page.context.set_offline(False)
        expect(page.get_by_text("Sends when you're back")).to_have_count(0)
        self.assertEqual([body["prompt"] for body in asked], ["Catch me up on this thread"], "sent once")

    def test_06b_a_held_request_the_server_refuses_comes_back_with_the_reason(self) -> None:
        page = self.page()
        self.stub_assistant(page)
        self.stub_thread(page)
        asked = self.stub_runs(page, lambda body: (409, {"code": "PERSONAL_RUN_UNAVAILABLE", "message": "Your assistant is unavailable"}))
        page.goto(self.thread_url())
        menu = self.open_suggestions(page, phone=False)
        page.context.set_offline(True)
        menu.get_by_role("option", name="Ask your assistant: Catch me up on this thread", exact=True).click()
        expect(page.get_by_text("Sends when you're back")).to_be_visible()
        page.context.set_offline(False)
        # Refused on reconnect: not lost. The words are back in the ask field and the reason shows, as for a refused ask.
        expect(page.get_by_text("Sends when you're back")).to_have_count(0)
        expect(page.locator("#project-ask")).to_contain_text("Your assistant is unavailable right now. Nothing was sent.")
        expect(page.get_by_role("textbox", name="Ask your assistant")).to_have_value("Catch me up on this thread")
        self.assertEqual([body["prompt"] for body in asked], ["Catch me up on this thread"], "refused once, not retried")

    def test_06c_requests_held_offline_keep_their_order_and_each_goes_out_once(self) -> None:
        page = self.page()
        self.stub_assistant(page)
        self.stub_thread(page)
        asked = self.stub_runs(page, lambda body: (202, self.run_json(clientRunId=body["clientRunId"], prompt=body["prompt"])))
        page.goto(self.thread_url())
        menu = self.open_suggestions(page, phone=False)
        shot(page, "suggestions-thread-1440-light")
        page.context.set_offline(True)
        menu.get_by_role("option", name="Ask your assistant: Catch me up on this thread", exact=True).click()
        pick_suggestion(page, "Turn this thread into tasks")
        expect(page.get_by_text("Sends when you're back")).to_have_count(2)
        self.assertEqual(asked, [])
        page.context.set_offline(False)
        expect(page.get_by_text("Sends when you're back")).to_have_count(0)
        self.assertEqual([body["prompt"] for body in asked], ["Catch me up on this thread", "Turn this thread into tasks"], "in order, once each")
        self.assertEqual(len({body["clientRunId"] for body in asked}), 2, "each under its own id")

    # ---------------------------------------------------------------- AST-10.9: Journey 6 states

    def failed_ask(self, page, run: dict, *, status: int = 202, error: dict | None = None):
        self.stub_assistant(page)
        self.stub_thread(page)
        self.stub_runs(page, lambda body: (status, error if error else dict(run, clientRunId=body["clientRunId"], prompt=body["prompt"])))
        page.goto(self.thread_url())
        pick_suggestion(page, "Catch me up on this thread")

    def test_07_plan_limit_with_and_without_a_reset_time(self) -> None:
        page = self.page()
        self.failed_ask(page, self.run_json(status="unavailable", endReason="plan_limit", planLimitResetsAt="2026-10-16T14:00:00.000Z", completedAt=NOW))
        line = page.locator(".assistant-working")
        expect(line).to_contain_text(re.compile(r"Claude limit reached until .*14:00"))
        shot(page, "j6-plan-limit-1440-light")
        page = self.page(phone=True)
        self.failed_ask(page, self.run_json(status="unavailable", endReason="plan_limit", planLimitResetsAt=None, completedAt=NOW))
        line = page.locator(".assistant-working")
        expect(line).to_contain_text("Claude limit reached")
        expect(line).not_to_contain_text("resumes")
        expect(line.get_by_role("button", name=re.compile("switch|another|use ", re.I))).to_have_count(0)
        shot(page, "j6-plan-limit-390-light")
        line.get_by_role("button", name="Dismiss").click()
        expect(page.locator(".assistant-working")).to_have_count(0)

    def test_07b_api_credits_out_is_one_line_with_no_switch(self) -> None:
        page = self.page()
        self.failed_ask(page, self.run_json(status="provider_failed", endReason="credits", completedAt=NOW))
        line = page.locator(".assistant-working")
        expect(line).to_contain_text("API credits used up. API requests stop until your next monthly credits arrive.")
        expect(line.get_by_role("button", name=re.compile("switch|another", re.I))).to_have_count(0)

    def test_08_signed_out_leads_to_sign_in(self) -> None:
        page = self.page()
        self.failed_ask(page, self.run_json(status="unavailable", endReason="sign_in_again", completedAt=NOW))
        line = page.locator(".assistant-working")
        expect(line).to_contain_text("Sign in to Claude again to keep using your assistant.")
        shot(page, "j6-signed-out-1440-light")
        line.get_by_role("link", name="Sign in").click()
        expect(page).to_have_url(re.compile(r"/settings/agents$"))

    def test_09_an_owner_who_lost_the_project_is_told_so_and_offered_no_way_round(self) -> None:
        page = self.page()
        self.failed_ask(page, {}, status=409, error={"code": "PERSONAL_RUN_NO_PROJECT_ACCESS", "message": "Your assistant has no access to this project"})
        bar = page.locator("#project-ask")
        expect(bar).to_contain_text("You can't open this space any more, so neither can your assistant.")
        expect(bar.get_by_role("button", name="Add my assistant here")).to_have_count(0)
        shot(page, "j6-owner-lost-the-project-1440-light")


if __name__ == "__main__":
    unittest.main()
