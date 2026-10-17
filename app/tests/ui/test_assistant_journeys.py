"""Browser tests for the assistant journeys (F-027 A7, #407; AST-10.1, 10.6, 10.7, 10.9, 10.15).

Same stubbed-engine approach as test_assistant_screen: this proves the words, the order and the flow at both widths;
tests/app/assistant-changes.test.ts proves the Recent endpoint and Undo against the real store.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
import re
import unittest
import uuid

from playwright.sync_api import Route, expect

import test_assistant_screen as base
from test_app_shell import shot

FORBIDDEN = base.FORBIDDEN
NOW = base.NOW


class AssistantJourneys(unittest.TestCase):
    """Tests run in name order and share one account (the harness is test_assistant_screen's)."""

    state: dict | None = None
    ids: dict[str, str] = {}
    setUpClass = classmethod(base.AssistantScreen.setUpClass.__func__)
    tearDownClass = classmethod(base.AssistantScreen.tearDownClass.__func__)
    pw = None
    for _name in ("context", "page", "api", "json", "status", "stub_assistant", "answer", "stub_thread", "thread_url", "no_horizontal_scroll", "tag"):
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
               "verb": "Apply", "line": None, "suggestTo": None, "sent": False, "decidedBy": None, "runState": "done", "before": "Probes", "after": "Calibrate the probes",
               "undoable": True, "version": 1, "createdAt": datetime.now(timezone.utc).isoformat()}
        row.update(changes)
        return row

    def stub_runs(self, page, on_ask) -> list[dict]:
        """Own runs, one run and the ask endpoint; `on_ask(body)` returns (status, run)."""
        asked: list[dict] = []
        page.route(re.compile(r".*/api/v1/assistant-runs\?limit=\d+$"), lambda route: self.json(route, {"items": [], "total": 0, "limit": 10, "offset": 0}))

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

    def test_02_ready_card_has_the_exact_copy_and_turn_on_is_the_consent(self) -> None:
        for phone, dark in ((False, False), (True, False), (False, True)):
            with self.subTest(phone=phone, dark=dark):
                page = self.page(phone=phone, dark=dark)
                world = self.stub_assistant(page, enabled=False)
                enabled = self.status(page, enabled=True)
                posted: list[dict] = []

                def enable(route: Route) -> None:
                    if route.request.method == "POST":
                        posted.append(json.loads(route.request.post_data or "{}"))
                        world["status"] = enabled
                        self.json(route, enabled)
                    else:
                        self.json(route, world["status"])
                page.route("**/api/v1/personal-assistant", enable)
                page.goto("/settings/assistant")
                card = page.get_by_role("region", name="Your assistant is ready")
                expect(card).to_be_visible()
                expect(card).to_contain_text("It can read and edit tasks, the Wiki and maps, reply in conversations and suggest decisions.")
                expect(card).to_contain_text("It does things and tells you what it did, with Undo. It asks before removing anything or changing things other people made or are responsible for.")
                expect(card).to_contain_text("It joins the projects you manage. In others, a manager adds it.")
                expect(card).to_contain_text("Others in the conversation see what you ask it and what it does.")
                expect(card).to_contain_text("Uses your Claude plan. Flux can't see its limits. What it reads goes to Anthropic under your account's settings.")
                expect(card.get_by_role("button", name="Turn on", exact=True)).to_be_visible()
                expect(card.get_by_role("button", name="Change what it can do")).to_be_visible()
                expect(card.get_by_role("checkbox")).to_have_count(0)
                self.no_horizontal_scroll(page)
                text = card.inner_text()
                self.assertIsNone(FORBIDDEN.search(text), FORBIDDEN.search(text))
                shot(page, f"ready-{self.tag(phone, dark)}")
                card.get_by_role("button", name="Turn on", exact=True).click()
                expect(page.get_by_role("switch", name="Your assistant is on")).to_be_visible()
                self.assertEqual((posted[0]["engine"], posted[0]["consentVersion"]), ("runtime", "f-022-runtime-2026-10-16"))

    def test_03_from_set_up_to_the_runs_message_in_at_most_six_taps(self) -> None:
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page(phone=phone)
                world = self.stub_assistant(page, enabled=False)
                enabled = self.status(page, enabled=True)

                def status(route: Route) -> None:
                    if route.request.method == "POST":
                        world["status"] = enabled
                    self.json(route, world["status"])
                page.route("**/api/v1/personal-assistant", status)
                asked = self.stub_runs(page, lambda body: (202, self.run_json(clientRunId=body["clientRunId"], prompt=body["prompt"])))
                run = self.run_json()
                page.route(re.compile(r".*/api/v1/assistant-runs/[0-9a-f-]{36}$"), lambda route: self.json(route, run))
                self.stub_thread_answers = self.stub_thread(page, [])
                page.route(re.compile(r".*/api/v1/assistant-runs\?limit=\d+$"), lambda route: self.json(route, {"items": [run], "total": 1, "limit": 10, "offset": 0}))
                taps = 0
                page.goto("/")
                page.get_by_role("link", name="Set up").click(); taps += 1                                   # 1
                page.get_by_role("button", name="Turn on", exact=True).click(); taps += 1                    # 2
                expect(page.get_by_role("switch", name="Your assistant is on")).to_be_visible()
                if phone:
                    page.get_by_role("link", name="Projects").click(); taps += 1                             # 3 (tab bar)
                    page.get_by_role("link", name="Gesture lamp").first.click(); taps += 1                   # 4
                else:
                    page.get_by_role("link", name="Gesture lamp").first.click(); taps += 1                   # 3
                page.goto(self.thread_url())  # the thread the person came from; reaching it is not a counted tap of this flow
                chips = page.get_by_role("group", name="Suggestions for your assistant")
                for text in ("Catch me up", "Turn this thread into tasks", "Tidy this project's tasks"):
                    expect(chips.get_by_role("button", name=text)).to_be_visible()
                shot(page, f"suggestions-{self.tag(phone)}")
                chips.get_by_role("button", name="Tidy this project's tasks").click(); taps += 1
                expect(page.locator(".assistant-working")).to_contain_text("Working…")
                expect(page.locator(".assistant-working").get_by_role("button", name="Stop")).to_be_visible()
                self.assertEqual(asked[0]["prompt"], "Tidy this project's tasks")
                self.assertLessEqual(taps, 6, taps)
                shot(page, f"working-{self.tag(phone)}")

    # ---------------------------------------------------------------- AST-10.7: Recent with Undo

    def test_04_recent_lists_changes_with_undo_and_offline_says_offline(self) -> None:
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page(phone=phone)
                self.stub_assistant(page)
                first, second = self.change(), self.change(objectTitle="#9", phrase="added done-when to", before=None, after="drawing received", id=str(uuid.uuid4()))
                listing = {"items": [first, second]}
                undone: list[str] = []

                def recent(route: Route) -> None:
                    self.json(route, listing)

                def undo(route: Route) -> None:
                    if page.evaluate("!navigator.onLine"):
                        route.abort("internetdisconnected")
                        return
                    undone.append(route.request.url)
                    row = dict(first, state="undone")
                    listing["items"] = [row, second]
                    self.json(route, {"change": row, "message": None})
                page.route(re.compile(r".*/api/v1/assistant-changes\?limit=\d+$"), recent)
                page.route(re.compile(r".*/api/v1/assistant-changes/[0-9a-f-]{36}/undo$"), undo)
                page.goto("/settings/assistant")
                summary = page.get_by_text("Recent · today: 2 changes")
                expect(summary).to_be_visible()
                self.assertIn("›", page.evaluate("getComputedStyle(document.querySelector('.aset-recent > summary'), '::after').content"), "the closed row ends in the drawn ›")
                summary.click()
                row = page.locator(".aset-recent__list li").first
                expect(row).to_contain_text("Done: renamed task #3 Calibrate the probes")
                shot(page, f"recent-{self.tag(phone)}")
                page.context.set_offline(True)
                row.get_by_role("button", name="Undo").click()
                expect(row.get_by_role("status")).to_have_text("Offline")
                self.assertEqual(undone, [])
                page.context.set_offline(False)
                row.get_by_role("button", name="Undo").click()
                expect(page.locator(".aset-recent__list li").first).to_contain_text("Undone: renamed task")
                self.assertEqual(len(undone), 1)

    # ---------------------------------------------------------------- AST-10.6 / 10.15

    def test_05_stop_is_a_44px_keyboard_reachable_button_and_says_offline(self) -> None:
        page = self.page()
        self.stub_assistant(page)
        run = self.run_json()
        self.stub_thread(page, [])
        page.route(re.compile(r".*/api/v1/assistant-runs\?limit=\d+$"), lambda route: self.json(route, {"items": [run], "total": 1, "limit": 10, "offset": 0}))
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

    def test_06_a_request_sent_offline_waits_and_goes_out_once_when_back(self) -> None:
        page = self.page(phone=True)
        self.stub_assistant(page)
        self.stub_thread(page, [])
        asked = self.stub_runs(page, lambda body: (202, self.run_json(clientRunId=body["clientRunId"], prompt=body["prompt"])))
        page.goto(self.thread_url())
        chips = page.get_by_role("group", name="Suggestions for your assistant")
        expect(chips).to_be_visible()
        page.context.set_offline(True)
        chips.get_by_role("button", name="Catch me up").click()
        expect(page.get_by_text("Sends when you're back")).to_be_visible()
        shot(page, "offline-390-light")
        self.assertEqual(asked, [])
        page.context.set_offline(False)
        expect(page.get_by_text("Sends when you're back")).to_have_count(0)
        self.assertEqual([body["prompt"] for body in asked], ["Catch me up"], "sent once")

    def test_06b_a_held_request_the_server_refuses_comes_back_with_the_reason(self) -> None:
        page = self.page()
        self.stub_assistant(page)
        self.stub_thread(page, [])
        asked = self.stub_runs(page, lambda body: (409, {"code": "PERSONAL_RUN_PAUSED", "message": "Your assistant is paused"}))
        page.goto(self.thread_url())
        chips = page.get_by_role("group", name="Suggestions for your assistant")
        expect(chips).to_be_visible()
        page.context.set_offline(True)
        chips.get_by_role("button", name="Catch me up").click()
        expect(page.get_by_text("Sends when you're back")).to_be_visible()
        page.context.set_offline(False)
        # Refused on reconnect: not lost. The words are back in the ask field and the reason shows, as for a refused ask.
        expect(page.get_by_text("Sends when you're back")).to_have_count(0)
        expect(page.locator("#project-ask")).to_contain_text("Your assistant is paused.")
        expect(page.get_by_role("textbox", name="Ask your assistant")).to_have_value("Catch me up")
        self.assertEqual([body["prompt"] for body in asked], ["Catch me up"], "refused once, not retried")

    def test_06c_requests_held_offline_keep_their_order_and_each_goes_out_once(self) -> None:
        page = self.page()
        self.stub_assistant(page)
        self.stub_thread(page, [])
        asked = self.stub_runs(page, lambda body: (202, self.run_json(clientRunId=body["clientRunId"], prompt=body["prompt"])))
        page.goto(self.thread_url())
        chips = page.get_by_role("group", name="Suggestions for your assistant")
        expect(chips).to_be_visible()
        page.context.set_offline(True)
        chips.get_by_role("button", name="Catch me up").click()
        chips.get_by_role("button", name="Turn this thread into tasks").click()
        expect(page.get_by_text("Sends when you're back")).to_have_count(2)
        self.assertEqual(asked, [])
        page.context.set_offline(False)
        expect(page.get_by_text("Sends when you're back")).to_have_count(0)
        self.assertEqual([body["prompt"] for body in asked], ["Catch me up", "Turn this thread into tasks"], "in order, once each")
        self.assertEqual(len({body["clientRunId"] for body in asked}), 2, "each under its own id")

    # ---------------------------------------------------------------- AST-10.9: Journey 6 states

    def failed_ask(self, page, run: dict, *, status: int = 202, error: dict | None = None):
        self.stub_assistant(page)
        self.stub_thread(page, [])
        self.stub_runs(page, lambda body: (status, error if error else dict(run, clientRunId=body["clientRunId"], prompt=body["prompt"])))
        page.goto(self.thread_url())
        page.get_by_role("group", name="Suggestions for your assistant").get_by_role("button", name="Catch me up").click()

    def test_07_plan_limit_with_and_without_a_reset_time(self) -> None:
        page = self.page()
        self.failed_ask(page, self.run_json(status="unavailable", endReason="plan_limit", planLimitResetsAt="2026-10-16T14:00:00.000Z", completedAt=NOW))
        line = page.locator(".assistant-working")
        expect(line).to_contain_text("Paused: your Claude plan’s limit is reached until 14:00.")
        shot(page, "j6-plan-limit-1440-light")
        page = self.page(phone=True)
        self.failed_ask(page, self.run_json(status="unavailable", endReason="plan_limit", planLimitResetsAt=None, completedAt=NOW))
        line = page.locator(".assistant-working")
        expect(line).to_contain_text("Paused: your Claude plan’s limit is reached. Claude didn’t say until when.")
        expect(line.get_by_role("button", name="Try again later")).to_be_visible()
        shot(page, "j6-plan-limit-390-light")
        line.get_by_role("button", name="Try again later").click()
        expect(page.locator(".assistant-working")).to_have_count(0)

    def test_08_signed_out_leads_to_sign_in(self) -> None:
        page = self.page()
        self.failed_ask(page, self.run_json(status="unavailable", endReason="sign_in_again", completedAt=NOW))
        line = page.locator(".assistant-working")
        expect(line).to_contain_text("Sign in to Claude again to keep using your assistant.")
        shot(page, "j6-signed-out-1440-light")
        line.get_by_role("link", name="Sign in").click()
        expect(page).to_have_url(re.compile(r"/settings/agents$"))

    def test_09_not_in_the_project_offers_to_add_my_assistant(self) -> None:
        page = self.page()
        self.failed_ask(page, {}, status=409, error={"code": "PERSONAL_RUN_NO_PROJECT_ACCESS", "message": "Your assistant has no access to this project"})
        bar = page.locator("#project-ask")
        expect(bar).to_contain_text("I'm not in this project yet.")
        expect(bar.get_by_role("button", name="Add my assistant here")).to_be_visible()
        shot(page, "j6-not-in-project-1440-light")


if __name__ == "__main__":
    unittest.main()
