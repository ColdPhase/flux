"""Browser tests for the rest of the assistant screen and journeys (F-027 A7, #407; AST-10.1, 10.5, 10.9 to 10.11).

Same stubbed-engine approach as test_assistant_screen. This module covers: the request appearing in the stream as sent
(Journey 1 step 6), the waiting card with its Approve (steps 8 and 9), "Ask my assistant…" outside a conversation (AST-10.10),
turn-on that reuses what an earlier try made, the subscription-off row and axe on the assistant screens (AST-10.11).
"""

from __future__ import annotations

import hashlib
import json
import re
import time
import unittest
import uuid
from pathlib import Path

from playwright.sync_api import Page, Route, expect

import test_assistant_screen as base
from test_app_shell import ORIGIN, shot

FORBIDDEN = base.FORBIDDEN
NOW = base.NOW
PASSWORD = base.PASSWORD
AXE = Path(__file__).parent / "vendor" / "axe-core-4.13.0.min.js"
AXE_SHA256 = "c24f097bd2f451d4f933e8bc7d8d539f8672a2ebcb5cc9f9f3eec8ca9470a0c1"
JONAS = {"name": "Jonas Weiss", "email": f"jonas.finish+{base.STAMP}@example.test"}


class AssistantFinish(unittest.TestCase):
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
        original = base.ADA["email"]
        base.ADA["email"] = original.replace("ada.screen", "ada.finish")
        try:
            base.AssistantScreen.test_01_an_owner_with_a_project(self)
        finally:
            base.ADA["email"] = original

    # ---------------------------------------------------------------- Journey 1 step 6: the request appears in the stream as sent

    def stub_ask(self, page: Page, error: dict | None = None) -> list[dict]:
        asked: list[dict] = []
        run = {"id": str(uuid.uuid4()), "clientRunId": "", "workspaceId": self.ids["workspace"], "projectId": self.ids["project"], "conversationId": self.ids["conversation"],
               "kind": "ask", "prompt": "", "target": None, "continuesRunId": None, "retryOfRunId": None, "status": "dispatching", "stoppedAtStage": None,
               "stopRequested": False, "stopAcknowledged": False, "engine": "runtime", "model": "sonnet", "runtimeClient": "claude_code", "endReason": None, "planLimitResetsAt": None,
               "cost": {"state": "reserved", "reservedMicros": 0, "chargedMicros": 0, "inputTokens": None, "outputTokens": None},
               "answer": None, "createdAt": NOW, "dispatchedAt": NOW, "completedAt": None}

        def ask(route: Route) -> None:
            body = json.loads(route.request.post_data or "{}")
            asked.append(body)
            if error:
                self.json(route, error, 409)
            else:
                self.json(route, dict(run, clientRunId=body["clientRunId"], prompt=body["prompt"]), 202)
        page.route(re.compile(r".*/api/v1/conversations/[0-9a-f-]{36}/assistant-runs$"), ask)
        return asked

    def messages(self, page: Page, conversation: str) -> list[str]:
        return [message["body"] for message in self.api(page, "GET", f"/api/v1/conversations/{conversation}", status=200)["messages"]]

    def test_05_a_request_is_private_and_leaves_no_message_in_the_conversation(self) -> None:
        # #842: what a person asks their agent is not a message of the conversation (it used to post "@Ada's assistant …" for everyone).
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page(phone=phone)
                self.stub_assistant(page)
                self.stub_thread(page, [])
                asked = self.stub_ask(page)
                sends: list[tuple[str, int]] = []
                page.on("response", lambda response: sends.append((response.request.post_data or "", response.status)) if response.request.method == "POST" and response.url.endswith("/messages") else None)
                page.goto(self.thread_url())
                before = len(self.messages(page, self.ids["conversation"]))
                page.get_by_role("group", name="Suggestions for your assistant").get_by_role("button", name="Tidy this project's tasks").click()
                deadline = time.time() + 15
                while len(asked) < 1 and time.time() < deadline:
                    page.wait_for_timeout(100)
                self.assertEqual(len(asked), 1)
                page.wait_for_timeout(500)
                self.assertEqual(sends, [], "nothing was posted to the conversation")
                self.assertEqual(len(self.messages(page, self.ids["conversation"])), before)
                expect(page.locator(".ref-chip--agent")).to_have_count(0)
                shot(page, f"j1-private-request-{self.tag(phone)}")

    def test_06_a_refused_request_leaves_no_message_behind(self) -> None:
        page = self.page()
        self.stub_assistant(page)
        self.stub_thread(page, [])
        before = len(self.messages(page, self.ids["conversation"]))
        self.stub_ask(page, error={"code": "PERSONAL_RUN_NO_PROJECT_ACCESS", "message": "Your assistant has no access to this project"})
        page.goto(self.thread_url())
        page.get_by_role("group", name="Suggestions for your assistant").get_by_role("button", name="Catch me up").click()
        expect(page.locator("#project-ask")).to_contain_text("You can't open this space any more, so neither can your assistant.")
        self.assertEqual(len(self.messages(page, self.ids["conversation"])), before)

    # ---------------------------------------------------------------- Journey 1 steps 8 and 9: Approve

    def change(self, **values) -> dict:
        change = {"id": str(uuid.uuid4()), "runId": self.ids["run"], "projectId": self.ids["project"], "conversationId": self.ids["conversation"],
                  "operation": "work.update", "objectType": "work", "objectId": str(uuid.uuid4()), "objectTitle": "#3 Calibrate the probes", "state": "applied",
                  "waitReason": None, "phrase": "rename task", "verb": "Rename", "line": None, "forPerson": None, "done": "renamed task #3 Calibrate the probes", "decidedBy": None,
                  "owner": {"id": base.ADA["id"], "name": base.ADA["name"]}, "runState": "done", "before": "Probes", "after": "Calibrate the probes", "undoable": True, "version": 1, "createdAt": NOW}
        change.update(values)
        return change

    def test_07_changing_what_jonas_made_waits_on_a_card_and_approve_adds_it_to_the_line(self) -> None:
        for phone in (False, True):
            with self.subTest(phone=phone):
                type(self).ids = {**self.ids, "run": str(uuid.uuid4())}
                page = self.page(phone=phone)
                self.stub_assistant(page)
                self.stub_thread(page, [])
                items = [self.change(objectTitle=f"#{number} Task {number}", done=f"renamed task #{number} Task {number}") for number in (3, 5)]
                items.append(self.change(state="waiting", waitReason="others", phrase="close task", verb="Close", objectTitle="#4 Duplicate", before=None, after=None,
                                         undoable=False, line="Jonas's task: other people's things wait for your OK.", done="closed task #4 Duplicate"))
                current = {"items": items}
                applied: list[str] = []
                page.route(re.compile(r".*/api/v1/conversations/[0-9a-f-]{36}/assistant-changes$"), lambda route: self.json(route, current))

                def apply(route: Route) -> None:
                    applied.append(route.request.url.rsplit("/", 1)[1])
                    item = items[-1]
                    item.update(state="applied_after_wait", waitReason=None, line="Approved by Ada Brandt", version=2, undoable=True)
                    self.json(route, {"change": item, "message": None})
                page.route(re.compile(r".*/api/v1/assistant-changes/[0-9a-f-]{36}/apply$"), apply)
                page.goto(self.thread_url())
                card = page.locator(".assistant-waiting__card")
                expect(card).to_contain_text("Assistant wants to close task #4 Duplicate")
                expect(card).to_contain_text("Jonas's task: other people's things wait for your OK.")
                expect(card.get_by_role("button", name="Skip", exact=True)).to_be_visible()
                shot(page, f"j1-waiting-{self.tag(phone)}")
                card.get_by_role("button", name="Approve", exact=True).click()
                self.assertEqual(applied, ["apply"])
                line = page.get_by_label("What your assistant changed").locator(".assistant-message__line")
                expect(line).to_contain_text("closed task #4 Duplicate")
                expect(line.get_by_role("button", name="Undo", exact=True)).to_be_visible()
                expect(page.locator(".assistant-waiting__card")).to_have_count(0)
                shot(page, f"j1-approved-{self.tag(phone)}")

    # ---------------------------------------------------------------- AST-10.10: Ask my assistant… outside a conversation

    def test_08_command_k_outside_a_conversation_asks_in_which_conversation_and_never_leads_nowhere(self) -> None:
        for phone, remembered in ((False, False), (False, True), (True, True)):
            with self.subTest(phone=phone, remembered=remembered):
                page = self.page(phone=phone)
                self.stub_assistant(page)
                self.stub_thread(page, [])
                if remembered:
                    page.add_init_script(f"localStorage.setItem('flux.assistant-last-asked.{base.ADA['id']}', JSON.stringify({{projectId: '{self.ids['project']}', conversationId: '{self.ids['conversation']}'}}))")
                page.goto("/")
                expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
                base.assistant_known(page)
                page.keyboard.press("Control+k")
                option = page.get_by_role("option", name=re.compile("Ask my assistant…"))
                expect(option).to_be_visible()
                option.click()
                where = page.get_by_role("group", name="In which conversation?")
                expect(where).to_be_visible()
                first = where.get_by_role("button").first
                if remembered:
                    expect(first).to_contain_text("Camera or ToF sensor")
                    expect(first).to_contain_text("Last used")
                self.assertGreaterEqual(first.bounding_box()["height"], 44)
                self.assertIsNone(FORBIDDEN.search(where.inner_text()))
                shot(page, f"ask-where-{self.tag(phone)}-{'last' if remembered else 'recent'}")
                first.click()
                expect(page).to_have_url(re.compile(r"/projects/[0-9a-f-]{36}/conversations/[0-9a-f-]{36}$"))
                expect(page.get_by_placeholder("Ask your assistant…")).to_be_visible()

    def test_09_command_k_in_a_project_lists_that_projects_conversations(self) -> None:
        page = self.page()
        self.stub_assistant(page)
        page.goto(f"/projects/{self.ids['project']}")
        expect(page.get_by_role("heading", level=1, name="Gesture lamp")).to_be_visible()
        base.assistant_known(page)
        page.keyboard.press("Control+k")
        page.get_by_role("option", name=re.compile("Ask my assistant…")).click()
        where = page.get_by_role("group", name="In which conversation?")
        expect(where.get_by_role("button").first).to_contain_text("Camera or ToF sensor")
        where.get_by_role("button", name="Back").click()
        expect(page.get_by_role("combobox", name="Search", exact=True)).to_be_visible()

    # ---------------------------------------------------------------- Journey 6: subscription sign-in off

    def test_11_when_the_operator_turns_subscriptions_off_the_row_offers_to_tell_them_or_connect_a_key(self) -> None:
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page(phone=phone)
                world = self.stub_assistant(page)
                world["status"].update(state="unavailable", unavailableReason="runtime_off")
                self.stub_thread(page, [])
                told: list[str] = []

                def tell(route: Route) -> None:
                    told.append(route.request.url)
                    self.json(route, {"sent": 1}, 201)
                page.route(re.compile(r".*/api/v1/workspaces/[0-9a-f-]{36}/assistant-operator-requests$"), tell)
                page.goto(f"{self.thread_url()}?ask=1")
                bar = page.locator("#project-ask")
                expect(bar).to_contain_text(re.compile(r"This Flux doesn.t allow signing in with a subscription yet\."))
                expect(bar.get_by_role("button", name="Tell whoever runs Flux")).to_be_visible()
                expect(bar.get_by_role("button", name="Connect an API key")).to_be_visible()
                shot(page, f"j6-subscription-off-{self.tag(phone)}")
                bar.get_by_role("button", name="Tell whoever runs Flux").click()
                expect(bar).to_contain_text("Told whoever runs Flux.")
                self.assertEqual(len(told), 1)
                bar.get_by_role("button", name="Connect an API key").click()
                expect(page).to_have_url(re.compile(r"/settings/ai-connections\?new=1$"))

    # ---------------------------------------------------------------- AST-10.11: axe on the assistant screens

    def axe(self, page: Page, where: str, scope: str | None = None) -> None:
        """Checks the assistant's own surface: the whole page for a screen, `scope` for a part of the conversation (the rest of that page is not this slice's)."""
        source = AXE.read_bytes()
        self.assertEqual(hashlib.sha256(source).hexdigest(), AXE_SHA256, "the vendored axe is the one that was verified")
        page.wait_for_function("() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().endTime === Infinity)")
        # The test driver runs axe in the page; a script element of its own would be an inline script, which the page's policy refuses (#979).
        page.evaluate(source.decode())
        result = page.evaluate("""async (scope) => (await axe.run(scope ? document.querySelector(scope) : document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }))
            .violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ') + ' :: ' + n.failureSummary.split('\\n').slice(1, 3).join(' ')) }))""", scope)
        self.assertEqual(result, [], f"axe violations on {where}")

    def test_13_the_agent_screens_have_no_axe_violations_at_both_widths_in_both_themes(self) -> None:
        # Opening Settings does not make an agent (it is made when the person connects AI, #857): this person has Assistant first.
        first = self.page()
        if not self.api(first, "GET", "/api/v1/my-agents", status=200).get("items"):
            self.api(first, "POST", "/api/v1/my-agents", {"workspaceId": self.ids["workspace"]}, status=201)
        for phone, dark in ((False, False), (True, False), (False, True), (True, True)):
            with self.subTest(phone=phone, dark=dark):
                tag = self.tag(phone, dark)
                page = self.page(phone=phone, dark=dark)
                page.goto("/settings/agents")
                row = page.get_by_role("list", name="Your agents").get_by_role("listitem").first
                expect(row).to_be_visible()
                self.axe(page, f"your agents ({tag})")
                row.get_by_role("link").click()
                expect(page.get_by_label("Instructions")).to_be_visible()
                self.axe(page, f"an agent's page ({tag})")
                page.goto("/settings/assistant")
                expect(page.get_by_role("heading", name=re.compile("schedules", re.I)).first).to_be_visible()
                self.axe(page, f"the schedules page ({tag})")

    def stub_model(self, page: Page) -> None:
        options = [{"id": "sonnet", "name": "Sonnet", "note": "Everyday work", "callsTools": True}, {"id": "opus", "name": "Opus", "note": "Harder requests", "callsTools": True}]
        pick = {"connection": "claude_plan", "model": "sonnet"}
        groups = [{"connection": "claude_plan", "account": "claude_plan", "label": "Claude plan", "company": "Claude", "options": options}]
        choice = {"current": pick, "default": pick, "groups": groups, "saved": True}
        page.route(re.compile(r".*/api/v1/personal-assistant/model(\?.*)?$"), lambda route: self.json(route, choice))

    def test_14_the_panel_and_the_conversation_have_no_axe_violations(self) -> None:
        for phone, dark in ((False, False), (True, True)):
            with self.subTest(phone=phone, dark=dark):
                tag = self.tag(phone, dark)
                page2 = self.page(phone=phone, dark=dark)
                self.stub_assistant(page2)
                self.stub_model(page2)
                self.stub_thread(page2, [self.answer(base.ADA["id"], "Ada Brandt", "Ada's assistant")])
                page2.goto(f"{self.thread_url()}?ask=1")
                expect(page2.locator("#project-ask")).to_be_visible()
                self.axe(page2, f"the ask bar ({tag})", "#project-ask")
                page2.locator("#project-ask").get_by_role("button", name="Stop asking your assistant").click()
                page2.get_by_role("button", name="Ada's assistant", exact=True).click()
                expect(page2.get_by_role("group", name="Ada's assistant, details")).to_be_visible()
                self.axe(page2, f"the assistant's panel ({tag})", ".aset-panel")


if __name__ == "__main__":
    unittest.main()
