"""Browser tests for the rest of the assistant screen and journeys (F-027 A7, #407; AST-10.1, 10.5, 10.9 to 10.11).

Same stubbed-engine approach as test_assistant_screen. This module covers: the request appearing in the stream as sent
(Journey 1 step 6), Close on the waiting row (steps 8 and 9), "Ask my assistant…" outside a conversation (AST-10.10),
suggestions only where the assistant is a member, the non-manager row that names the manager, turn-on that reuses what an
earlier try made, the subscription-off row and axe on the assistant screens (AST-10.11). The Agents tab's policy row (AST-3.6) is test_agents_handoff's.
"""

from __future__ import annotations

import hashlib
import json
import re
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

    def test_01_an_owner_with_a_project_and_a_colleague_who_manages_another(self) -> None:
        original = base.ADA["email"]
        base.ADA["email"] = original.replace("ada.screen", "ada.finish")
        try:
            base.AssistantScreen.test_01_an_owner_with_a_project(self)
        finally:
            base.ADA["email"] = original
        # Jonas manages a project of his own workspace and adds Ada as a member there: Ada is not a manager of it.
        jonas = self.browser.new_context(service_workers="block", base_url=ORIGIN, viewport={"width": 1440, "height": 900})
        self.addCleanup(jonas.close)
        page = jonas.new_page()
        page.goto("/sign-up")
        page.get_by_label("Name").fill(JONAS["name"])
        page.get_by_label("Email").fill(JONAS["email"])
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        ws = self.api(page, "POST", "/api/v1/workspaces", {"name": "Garden sensors"}, status=201)
        self.api(page, "POST", f"/api/v1/workspaces/{ws['id']}/members", {"email": base.ADA["email"], "role": "member"}, status=201)
        project = self.api(page, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Soil probes", "visibility": "workspace"}, status=201)
        thread = self.api(page, "POST", f"/api/v1/projects/{project['id']}/conversations", {"body": "The probes arrive Thursday", "clientMessageId": str(uuid.uuid4())}, status=201)
        type(self).ids = {**self.ids, "jonas_project": project["id"], "jonas_conversation": thread["id"]}

    # ---------------------------------------------------------------- suggestions and the non-manager row (AST-10, Journey 6)

    def test_02_suggestions_show_only_where_the_assistant_is_a_member(self) -> None:
        for member, shown in ((True, True), (False, False), (None, False)):
            with self.subTest(member=member):
                page = self.page()
                self.stub_assistant(page, member=member)
                self.stub_thread(page, [])
                page.goto(self.thread_url())
                expect(page.get_by_placeholder(re.compile("Reply in thread"))).to_be_visible()
                expect(page.get_by_role("group", name="Suggestions for your assistant")).to_have_count(1 if shown else 0)

    def test_03_a_manager_whose_assistant_is_not_in_the_project_is_told_before_asking_and_adds_it_in_one_tap(self) -> None:
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page(phone=phone)
                world = self.stub_assistant(page, member=False)
                self.stub_thread(page, [])
                page.goto(f"{self.thread_url()}?ask=1")
                bar = page.locator("#project-ask")
                expect(bar).to_contain_text("I'm not in this project yet.")
                expect(bar).not_to_contain_text("A manager can add me")
                add = bar.get_by_role("button", name="Add my assistant here")
                self.assertGreaterEqual(add.bounding_box()["height"], 24)
                shot(page, f"j6-not-in-project-proactive-{self.tag(phone)}")
                granted: list[str] = []

                def grant(route: Route) -> None:
                    granted.append(route.request.url)
                    world["agents"]["assistantJoin"]["canRequest"] = False
                    self.json(route, {"id": str(uuid.uuid4())}, 201)
                page.route(re.compile(r".*/api/v1/projects/[0-9a-f-]{36}/grants$"), grant)
                add.click()
                expect(bar).not_to_contain_text("I'm not in this project yet.")
                self.assertEqual(len(granted), 1)

    def test_04_a_member_who_does_not_manage_asks_the_manager_by_name(self) -> None:
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page(phone=phone)
                world = self.stub_assistant(page, member=False)
                posted: list[str] = []

                def join(route: Route) -> None:
                    posted.append(route.request.url)
                    world["agents"]["joinRequests"] = [{"id": str(uuid.uuid4()), "ownerUserId": base.ADA["id"], "state": "pending", "projectId": self.ids["jonas_project"]}]
                    world["agents"]["assistantJoin"]["canRequest"] = False
                    self.json(route, {"id": str(uuid.uuid4()), "state": "pending"}, 201)
                page.route(re.compile(r".*/api/v1/projects/[0-9a-f-]{36}/assistant-join-requests$"), join)
                page.route(re.compile(r".*/api/v1/conversations/[0-9a-f-]{36}/assistant-answers\?.*"), lambda route: self.json(route, {"items": [], "total": 0, "limit": 100, "offset": 0}))
                page.route(re.compile(r".*/api/v1/assistant-runs\?limit=\d+$"), lambda route: self.json(route, {"items": [], "total": 0, "limit": 10, "offset": 0}))
                page.goto(f"/projects/{self.ids['jonas_project']}/conversations/{self.ids['jonas_conversation']}?ask=1")
                bar = page.locator("#project-ask")
                expect(bar).to_contain_text("I'm not in this project yet. A manager can add me.")
                expect(page.get_by_role("group", name="Suggestions for your assistant")).to_have_count(0)
                ask = bar.get_by_role("button", name="Ask Jonas to add me")
                expect(ask).to_be_visible()
                shot(page, f"j6-not-in-project-member-{self.tag(phone)}")
                ask.click()
                expect(bar).to_contain_text("Asked Jonas to add me. I'll do this when they do.")
                expect(bar.get_by_role("button", name=re.compile("to add me"))).to_have_count(0)
                self.assertEqual(len(posted), 1)

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

    def test_05_a_request_appears_in_the_stream_as_sent_with_the_assistant_as_one_chip(self) -> None:
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page(phone=phone)
                self.stub_assistant(page)
                self.stub_thread(page, [])
                asked = self.stub_ask(page)
                page.goto(self.thread_url())
                posted = "@Ada's assistant Tidy this project's tasks"
                before = sum(body == posted for body in self.messages(page, self.ids["conversation"]))
                page.get_by_role("group", name="Suggestions for your assistant").get_by_role("button", name="Tidy this project's tasks").click()
                self.assertEqual(len(asked), 1)
                expect(page.get_by_label("Message from you").get_by_text("Tidy this project's tasks").last).to_be_visible()
                self.assertEqual(sum(body == posted for body in self.messages(page, self.ids["conversation"])), before + 1, "one message per request, in the real conversation")
                chip = page.locator(".ref-chip--agent", has_text="Ada's assistant").first
                expect(chip).to_be_visible()
                self.assertIsNone(FORBIDDEN.search(chip.inner_text()))
                shot(page, f"j1-stream-message-{self.tag(phone)}")

    def test_06_a_refused_request_leaves_no_message_behind(self) -> None:
        page = self.page()
        self.stub_assistant(page)
        self.stub_thread(page, [])
        before = len(self.messages(page, self.ids["conversation"]))
        self.stub_ask(page, error={"code": "PERSONAL_RUN_NO_PROJECT_ACCESS", "message": "Your assistant has no access to this project"})
        page.goto(self.thread_url())
        page.get_by_role("group", name="Suggestions for your assistant").get_by_role("button", name="Catch me up").click()
        expect(page.locator("#project-ask")).to_contain_text("I'm not in this project yet.")
        self.assertEqual(len(self.messages(page, self.ids["conversation"])), before)

    # ---------------------------------------------------------------- Journey 1 steps 8 and 9: Close

    def change(self, **values) -> dict:
        change = {"id": str(uuid.uuid4()), "runId": self.ids["run"], "projectId": self.ids["project"], "conversationId": self.ids["conversation"],
                  "operation": "work.update", "objectType": "work", "objectId": str(uuid.uuid4()), "objectTitle": "#3 Calibrate the probes", "state": "applied",
                  "waitReason": None, "phrase": "rename task", "verb": "Rename", "line": None, "suggestTo": None, "sent": False, "decidedBy": None, "runState": "done",
                  "before": "Probes", "after": "Calibrate the probes", "undoable": True, "version": 1, "createdAt": NOW, "expiresAt": "2026-10-24T09:00:00.000Z"}
        change.update(values)
        return change

    def test_07_waiting_to_close_two_tasks_is_one_tap_on_the_objects_own_verb(self) -> None:
        for phone in (False, True):
            with self.subTest(phone=phone):
                type(self).ids = {**self.ids, "run": str(uuid.uuid4())}
                page = self.page(phone=phone)
                self.stub_assistant(page)
                self.stub_thread(page, [])
                items = [self.change(objectTitle=f"#{number} Task {number}", phrase="rename task") for number in (3, 5, 9)]
                items += [self.change(state="waiting", waitReason="others", phrase="close task", verb="Close", objectTitle=f"#{number} Duplicate {number}", before=None, after=None,
                                      undoable=False, line="Jonas made it, so I'm asking first") for number in (4, 11)]
                current = {"items": items}
                applied: list[str] = []
                page.route(re.compile(r".*/api/v1/conversations/[0-9a-f-]{36}/assistant-changes$"), lambda route: self.json(route, current))

                def apply(route: Route) -> None:
                    applied.append(route.request.url.rsplit("/", 1)[1])
                    decided = []
                    for item in current["items"]:
                        if item["state"] == "waiting":
                            item.update(state="applied_after_wait", waitReason=None, line="Approved by Ada Brandt", version=2, undoable=True)
                            decided.append({"change": item, "message": None})
                    self.json(route, {"changes": decided})
                page.route(re.compile(r".*/api/v1/assistant-runs/[0-9a-f-]{36}/changes/apply$"), apply)
                page.goto(self.thread_url())
                card = page.get_by_label("Your assistant's changes")
                expect(card).to_contain_text("Waiting for you: close 2 tasks")
                expect(card.get_by_role("button", name="Close", exact=True)).to_be_visible()
                expect(card.get_by_role("button", name="Review")).to_be_visible()
                shot(page, f"j1-waiting-close-{self.tag(phone)}")
                card.get_by_role("button", name="Close", exact=True).click()
                self.assertEqual(applied, ["apply"])
                message = page.get_by_label("What your assistant changed")
                expect(message.get_by_role("status").first).to_contain_text("closed 2 tasks")
                expect(message.get_by_role("button", name="Undo").first).to_be_visible()
                expect(page.get_by_label("Your assistant's changes").get_by_text("Waiting for you")).to_have_count(0)
                shot(page, f"j1-closed-{self.tag(phone)}")

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
        page.goto(f"/projects/{self.ids['project']}/tasks")
        page.keyboard.press("Control+k")
        page.get_by_role("option", name=re.compile("Ask my assistant…")).click()
        where = page.get_by_role("group", name="In which conversation?")
        expect(where.get_by_role("button").first).to_contain_text("Camera or ToF sensor")
        where.get_by_role("button", name="Back").click()
        expect(page.get_by_role("combobox", name="Jump to")).to_be_visible()

    # ---------------------------------------------------------------- turn-on must not make a second assistant on a retry

    def test_10_turn_on_reuses_the_assistant_an_earlier_try_made(self) -> None:
        # Bea has one workspace and no assistant yet: Turn on makes one there, and a failed try must not make another.
        context = self.browser.new_context(service_workers="block", base_url=ORIGIN, viewport={"width": 1440, "height": 900}, locale="en-GB", timezone_id="UTC")
        self.addCleanup(context.close)
        page = context.new_page()
        page.goto("/sign-up")
        page.get_by_label("Name").fill("Bea Ortiz")
        page.get_by_label("Email").fill(f"bea.finish+{base.STAMP}@example.test")
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        fresh = self.api(page, "POST", "/api/v1/workspaces", {"name": "Second workshop"}, status=201)
        world = self.stub_assistant(page, enabled=False)
        failures = {"left": 1}
        posted: list[dict] = []

        def enable(route: Route) -> None:
            if route.request.method != "POST":
                self.json(route, world["status"])
                return
            posted.append(json.loads(route.request.post_data or "{}"))
            if failures["left"]:
                failures["left"] -= 1
                self.json(route, {"code": "INTERNAL", "message": "Couldn't turn it on."}, 500)
            else:
                world["status"] = self.status(page, enabled=True)
                self.json(route, world["status"], 201)
        page.route("**/api/v1/personal-assistant", enable)
        page.route(re.compile(r".*/api/v1/personal-assistant/agents$"), lambda route: self.json(route, world["status"]))
        page.goto("/settings/assistant")
        card = page.get_by_role("region", name="Your assistant is ready")
        card.get_by_role("button", name="Turn on", exact=True).click()
        expect(card.get_by_role("alert")).to_be_visible()
        card.get_by_role("button", name="Turn on", exact=True).click()
        expect(page.get_by_role("switch", name="Your assistant is on")).to_be_visible()
        made = [agent for agent in self.api(page, "GET", f"/api/v1/workspaces/{fresh['id']}/agents", status=200) if agent["owner"]["kind"] == "human"]
        self.assertEqual(len(made), 1, "one assistant in the new workspace after a failed try and its retry")
        self.assertEqual(len(posted), 2)

    # ---------------------------------------------------------------- Journey 6: subscription sign-in off

    def test_11_when_the_operator_turns_subscriptions_off_the_row_offers_to_tell_them_or_use_a_key(self) -> None:
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page(phone=phone)
                world = self.stub_assistant(page, member=True)
                world["status"].update(state="unavailable", unavailableReason="runtime_off")
                self.stub_thread(page, [])
                told: list[str] = []

                def tell(route: Route) -> None:
                    told.append(route.request.url)
                    self.json(route, {"sent": 1}, 201)
                page.route(re.compile(r".*/api/v1/workspaces/[0-9a-f-]{36}/assistant-operator-requests$"), tell)
                page.goto(f"{self.thread_url()}?ask=1")
                bar = page.locator("#project-ask")
                expect(bar).to_contain_text("This Flux doesn't allow signing in with a subscription yet.")
                expect(bar.get_by_role("button", name="Tell whoever runs Flux")).to_be_visible()
                expect(bar.get_by_role("button", name="Use an API key instead")).to_be_visible()
                shot(page, f"j6-subscription-off-{self.tag(phone)}")
                bar.get_by_role("button", name="Tell whoever runs Flux").click()
                expect(bar).to_contain_text("Told whoever runs Flux.")
                self.assertEqual(len(told), 1)
                bar.get_by_role("button", name="Use an API key instead").click()
                expect(page).to_have_url(re.compile(r"/settings/ai-connections$"))

    # ---------------------------------------------------------------- AST-10.11: axe on the assistant screens

    def axe(self, page: Page, where: str) -> None:
        source = AXE.read_bytes()
        self.assertEqual(hashlib.sha256(source).hexdigest(), AXE_SHA256, "the vendored axe is the one that was verified")
        page.add_script_tag(content=source.decode())
        result = page.evaluate("""async () => (await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }))
            .violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ') + ' :: ' + n.failureSummary.split('\\n').slice(1, 3).join(' ')) }))""")
        self.assertEqual(result, [], f"axe violations on {where}")

    def test_13_the_assistant_screens_have_no_axe_violations_at_both_widths_in_both_themes(self) -> None:
        for phone, dark in ((False, False), (True, False), (False, True), (True, True)):
            with self.subTest(phone=phone, dark=dark):
                tag = self.tag(phone, dark)
                page = self.page(phone=phone, dark=dark)
                self.stub_assistant(page)
                self.stub_model(page)
                page.goto("/settings/assistant")
                expect(page.get_by_role("switch", name="Your assistant is on")).to_be_visible()
                self.axe(page, f"the assistant screen ({tag})")
                page.get_by_role("button", name="Model: Sonnet. Change").click()
                expect(page.get_by_role("menu", name="Model")).to_be_visible()
                self.axe(page, f"the assistant screen with the model list open ({tag})")

    def stub_model(self, page: Page) -> None:
        options = [{"id": "sonnet", "name": "Sonnet", "note": "Everyday work", "callsTools": True}, {"id": "opus", "name": "Opus", "note": "Harder requests", "callsTools": True}]
        choice = {"engine": "runtime", "account": "claude_plan", "company": "Claude", "current": "sonnet", "default": "sonnet", "options": options, "saved": True}
        page.route(re.compile(r".*/api/v1/personal-assistant/model(\?.*)?$"), lambda route: self.json(route, choice))

    def test_14_the_ready_card_the_panel_and_the_conversation_have_no_axe_violations(self) -> None:
        for phone, dark in ((False, False), (True, True)):
            with self.subTest(phone=phone, dark=dark):
                tag = self.tag(phone, dark)
                page = self.page(phone=phone, dark=dark)
                self.stub_assistant(page, enabled=False)
                self.stub_model(page)
                page.goto("/settings/assistant")
                expect(page.get_by_role("region", name="Your assistant is ready")).to_be_visible()
                self.axe(page, f"the ready card ({tag})")
                page2 = self.page(phone=phone, dark=dark)
                self.stub_assistant(page2)
                self.stub_model(page2)
                self.stub_thread(page2, [self.answer(base.ADA["id"], "Ada Brandt", "Ada's assistant")])
                page2.goto(f"{self.thread_url()}?ask=1")
                expect(page2.locator("#project-ask")).to_be_visible()
                self.axe(page2, f"the ask bar ({tag})")
                page2.locator("#project-ask").get_by_role("button", name="Stop asking your assistant").click()
                page2.get_by_role("button", name="Ada's assistant", exact=True).click()
                expect(page2.get_by_role("group", name="Ada's assistant, details")).to_be_visible()
                self.axe(page2, f"the assistant's panel ({tag})")


if __name__ == "__main__":
    unittest.main()
