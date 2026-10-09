"""Browser tests for stopping a working agent and for an agent's question with ready-made answers (F-026 S13, S14; #347).

Ada manages a project with Jonas (a contributor). Her "Claude Code agent" works on a task. Stop is offered to who the server lets
stop it (a manager, the agent's owner, the task's creator) and ends the hold for real: the test reads the task back. The question card
is drawn under a real agent-style message; the question read and the answer are stubbed here because a question can only be asked over
an MCP bearer (the real asking, notifying and answering is covered by tests/app/agent-stop-questions.test.ts).
"""

from __future__ import annotations

import json
import re
import time
import unittest

from playwright.sync_api import Browser, BrowserContext, Page, Route, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

PASSWORD = "stop it before it goes on"
STAMP = int(time.time() * 1000)
ADA = {"name": "Ada Kowalska", "email": f"ada.stop+{STAMP}@example.test"}
JONAS = {"name": "Jonas Berg", "email": f"jonas.stop+{STAMP}@example.test"}


class StopAndQuestions(unittest.TestCase):
    """Tests run in name order and share two accounts, one project, an agent and its tasks."""

    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}
    question: dict = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        expect.set_options(timeout=8000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def context(self, who: str | None, *, phone: bool = False, scheme: str = "light") -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "color_scheme": scheme, "locale": "en-GB", "timezone_id": "Europe/Warsaw", "service_workers": "block"}
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=DESKTOP, device_scale_factor=1)
        if who and who in self.states:
            options["storage_state"] = self.states[who]
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        return context

    def page(self, who: str | None, **kwargs) -> Page:
        page = self.context(who, **kwargs).new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def api(self, page: Page, method: str, path: str, body: dict | None = None, status: int | None = None) -> dict | list:
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers={"origin": ORIGIN, "content-type": "application/json"},
                                      data=json.dumps(body) if body is not None else None)
        if status is not None:
            self.assertEqual(response.status, status, response.text())
        return json.loads(response.text()) if response.text() else {}

    def task(self, key: str) -> dict:
        return self.api(self.page("ada"), "GET", f"/api/v1/work/{self.ids[key]}", status=200)

    def new_working_task(self, title: str, key: str) -> None:
        made = self.api(self.page("ada"), "POST", f"/api/v1/projects/{self.ids['project']}/work",
                        {"title": title, "status": "in_progress", "owner": {"kind": "agent", "id": self.ids["agent"]}}, status=201)
        type(self).ids = {**self.ids, key: made["id"]}

    def test_01_a_project_with_a_working_agent(self) -> None:
        for key, person in {"ada": ADA, "jonas": JONAS}.items():
            page = self.page(None)
            page.goto("/sign-up")
            page.get_by_label("Name").fill(person["name"])
            page.get_by_label("Email").fill(person["email"])
            page.get_by_label("Password").fill(PASSWORD)
            page.get_by_role("button", name="Create account").click()
            expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
            type(self).states[key] = page.context.storage_state()
            person["id"] = self.api(page, "GET", "/api/v1/me", status=200)["user"]["id"]
        ada = self.page("ada")
        ws = self.api(ada, "POST", "/api/v1/workspaces", {"name": "Community garden"}, status=201)
        self.api(ada, "POST", f"/api/v1/workspaces/{ws['id']}/members", {"email": JONAS["email"], "role": "member"}, status=201)
        project = self.api(ada, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Garden sensors", "visibility": "restricted"}, status=201)
        pid = project["id"]
        self.api(ada, "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": JONAS["id"]}, "role": "contributor"}, status=201)
        agent = self.api(ada, "POST", f"/api/v1/workspaces/{ws['id']}/agents", {"name": "Claude Code agent", "owner": "self"}, status=201)["id"]
        self.api(ada, "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "agent", "id": agent}, "role": "contributor"}, status=201)
        self.api(ada, "POST", "/api/v1/agent-connections", {"agentId": agent, "selectedProjectIds": [pid],
                 "scopes": ["flux.context.read", "flux.proposal.write"], "name": "Desk laptop", "clientDesignation": "claude_code"}, status=201)
        type(self).ids = {"workspace": ws["id"], "project": pid, "agent": agent}
        self.new_working_task("Calibrate the probes at two soil depths", "first")

    def test_02_stop_is_on_the_working_agents_row_and_panel_only_for_who_may_stop_it(self) -> None:
        for scheme in ("light", "dark"):
            page = self.page("ada", scheme=scheme)
            page.goto(f"/projects/{self.ids['project']}/agents")
            row = page.locator(f'.agents-row[data-agent="{self.ids["agent"]}"]')
            expect(row).to_contain_text("Not signed in yet · #1 is waiting for it")
            stop = row.get_by_role("button", name="Stop Claude Code agent")
            expect(stop).to_be_visible()
            expect(page.get_by_role("complementary", name="Claude Code agent, details").get_by_role("button", name="Stop Claude Code agent")).to_be_visible()
            shot(page, f"stop-agents-desktop-{scheme}")
        # Jonas writes here but is neither a manager nor the agent's owner: no Stop to press.
        jonas = self.page("jonas")
        jonas.goto(f"/projects/{self.ids['project']}/agents")
        expect(jonas.locator(f'.agents-row[data-agent="{self.ids["agent"]}"]')).to_contain_text("Not signed in yet · #1 is waiting for it")
        expect(jonas.get_by_role("button", name=re.compile("^Stop"))).to_have_count(0)
        # The panel's Message opens the task's thread.
        page = self.page("ada")
        page.goto(f"/projects/{self.ids['project']}/agents")
        page.get_by_role("complementary", name="Claude Code agent, details").get_by_role("button", name="Message").click()
        expect(page.get_by_role("region", name="Thread of Calibrate the probes at two soil depths")).to_be_visible()

    def test_03_the_sidebar_card_shows_the_working_agent_and_stops_it(self) -> None:
        page = self.page("ada")
        page.goto("/")
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        card = page.locator(".agentlive--agent")
        expect(card).to_have_count(1)
        expect(card).to_contain_text("Claude Code agent")
        expect(card).to_contain_text("holds #1 · offline")
        shot(page, "stop-sidebar-card")
        card.get_by_role("button", name="Stop Claude Code agent").click()
        expect(page.get_by_text("Stopped Claude Code agent on #1")).to_be_visible()
        expect(card).to_have_count(0)
        task = self.task("first")
        self.assertIsNone(task["owner"])
        self.assertEqual(task["status"], "open")
        stops = self.api(page, "GET", f"/api/v1/projects/{self.ids['project']}/agent-stops", status=200)["stops"]
        self.assertEqual([(s["taskNumber"], s["stoppedBy"]["name"]) for s in stops], [(1, ADA["name"])])

    def test_04_the_agents_view_says_who_stopped_it(self) -> None:
        page = self.page("ada")
        page.goto(f"/projects/{self.ids['project']}/agents")
        row = page.locator(f'.agents-row[data-agent="{self.ids["agent"]}"]')
        expect(row).to_contain_text("Stopped by Ada Kowalska · #1")
        expect(row.get_by_role("button", name=re.compile("^Stop"))).to_have_count(0)
        row.locator(".agents-row__btn").click()
        recent = page.get_by_role("complementary", name="Claude Code agent, details").get_by_role("region", name="Recent")
        expect(recent).to_contain_text("Stopped by Ada Kowalska")
        # Everyone who reads the project sees it.
        jonas = self.page("jonas")
        jonas.goto(f"/projects/{self.ids['project']}/agents")
        expect(jonas.locator(f'.agents-row[data-agent="{self.ids["agent"]}"]')).to_contain_text("Stopped by Ada Kowalska · #1")
        shot(page, "stop-recorded-desktop")

    def test_05_stop_from_the_row_ends_the_hold_and_a_stale_second_stop_is_explained(self) -> None:
        self.new_working_task("Photograph the north bed", "second")
        page = self.page("ada")
        page.goto(f"/projects/{self.ids['project']}/agents")
        row = page.locator(f'.agents-row[data-agent="{self.ids["agent"]}"]')
        expect(row).to_contain_text("Not signed in yet · #2 is waiting for it")
        # Someone stops the agent while Ada's view is still open: her press is the stale one, so it is told and nothing is stopped twice.
        other = self.page("ada")

        def stop_first(route: Route) -> None:
            if route.request.method == "POST":
                self.api(other, "POST", f"/api/v1/projects/{self.ids['project']}/agent-stops", {"taskId": self.ids["second"], "agentId": self.ids["agent"]}, status=201)
            route.continue_()

        page.route(re.compile(r".*/api/v1/projects/[^/]+/agent-stops$"), stop_first)
        row.get_by_role("button", name="Stop Claude Code agent").click()
        expect(page.get_by_text("That agent was not working on this task any more.")).to_be_visible()
        expect(row).to_contain_text("Stopped by Ada Kowalska · #2")
        stops = self.api(page, "GET", f"/api/v1/projects/{self.ids['project']}/agent-stops", status=200)["stops"]
        self.assertEqual(len(stops), 2)

    def test_06_phone_stop_is_a_touch_target_in_the_row(self) -> None:
        self.new_working_task("Order spare batteries", "third")
        for scheme in ("light", "dark"):
            page = self.page("ada", phone=True, scheme=scheme)
            page.goto(f"/projects/{self.ids['project']}/agents")
            overflow = page.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
            self.assertLessEqual(overflow, 0, "no horizontal page scroll at 390px")
            stop = page.locator(f'.agents-row[data-agent="{self.ids["agent"]}"]').get_by_role("button", name="Stop Claude Code agent")
            expect(stop).to_be_visible()
            box = stop.bounding_box()
            assert box
            self.assertGreaterEqual(box["height"], 44)
            self.assertGreaterEqual(box["width"], 44)
            shot(page, f"stop-agents-phone-{scheme}")
        stop.tap()
        expect(page.get_by_text("Stopped Claude Code agent on #3")).to_be_visible()
        self.assertIsNone(self.task("third")["owner"])

    def route_question(self, page: Page, *, asked: str, message_id: str, conversation_id: str) -> list[dict]:
        """Stubs the question read and the answer; returns the answers the page sent."""
        sent: list[dict] = []
        pid = self.ids["project"]
        state = {"answer": None}

        def question() -> dict:
            return {"id": "00000000-0000-4000-8000-000000000347", "projectId": pid, "conversationId": conversation_id, "messageId": message_id,
                    "taskId": None, "agent": {"id": self.ids["agent"], "name": "Claude Code agent"}, "askedUserId": asked,
                    "question": "Should the offsets be per bed, or one value for all six?", "options": ["Per bed", "One value"],
                    "createdAt": "2026-10-08T10:00:00.000Z", "answer": state["answer"]}

        def read(route: Route) -> None:
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"projectId": pid, "questions": [question()]}))

        def answer(route: Route) -> None:
            body = json.loads(route.request.post_data or "{}")
            sent.append(body)
            text = body.get("text") or ["Per bed", "One value"][body["optionIndex"]]
            state["answer"] = {"optionIndex": body.get("optionIndex"), "text": text, "by": {"id": JONAS["id"], "name": JONAS["name"]},
                               "messageId": message_id, "at": "2026-10-08T10:01:00.000Z"}
            route.fulfill(status=200, content_type="application/json", body=json.dumps(question()))

        page.route(re.compile(r".*/api/v1/projects/[^/]+/agent-questions$"), read)
        page.route(re.compile(r".*/api/v1/agent-questions/[^/]+/answer$"), answer)
        return sent

    def test_07_a_question_is_a_card_with_ready_answers_for_the_person_asked(self) -> None:
        ada = self.page("ada")
        pid = self.ids["project"]
        conversation = self.api(ada, "POST", f"/api/v1/projects/{pid}/conversations",
                                {"body": "Should the offsets be per bed, or one value for all six?\n\n1. Per bed\n2. One value", "clientMessageId": "00000000-0000-4000-8000-0000000003a1"}, status=201)
        message_id, conversation_id = conversation["messages"][0]["id"], conversation["id"]
        type(self).question = {"message": message_id, "conversation": conversation_id}
        for scheme in ("light", "dark"):
            page = self.page("jonas", scheme=scheme)
            sent = self.route_question(page, asked=JONAS["id"], message_id=message_id, conversation_id=conversation_id)
            page.goto(f"/projects/{pid}/conversations/{conversation_id}")
            card = page.locator(".qcard").first
            expect(card).to_be_visible()
            expect(card).to_contain_text("Should the offsets be per bed, or one value for all six?")
            options = card.get_by_role("group", name="Ready answers")
            expect(options.get_by_role("button", name="Per bed")).to_be_visible()
            expect(options.get_by_role("button", name="One value")).to_be_visible()
            shot(page, f"question-card-desktop-{scheme}")
            if scheme == "light":
                options.get_by_role("button", name="One value").click()
                expect(card).to_have_attribute("data-state", "answered")
                expect(card).to_contain_text("One value")
                expect(card).to_contain_text("You")
                self.assertEqual(sent, [{"optionIndex": 1}])
                expect(card.get_by_role("button", name="Per bed")).to_have_count(0)
                shot(page, "question-answered-desktop")

    def test_08_everyone_else_sees_the_question_without_buttons_and_free_words_work_on_the_phone(self) -> None:
        pid = self.ids["project"]
        message_id, conversation_id = self.question["message"], self.question["conversation"]
        ada = self.page("ada")
        self.route_question(ada, asked=JONAS["id"], message_id=message_id, conversation_id=conversation_id)
        ada.goto(f"/projects/{pid}/conversations/{conversation_id}")
        card = ada.locator(".qcard").first
        expect(card).to_contain_text("Waiting for the person asked to answer.")
        expect(card.get_by_role("button")).to_have_count(0)
        phone = self.page("jonas", phone=True)
        sent = self.route_question(phone, asked=JONAS["id"], message_id=message_id, conversation_id=conversation_id)
        phone.goto(f"/projects/{pid}/conversations/{conversation_id}")
        # On a phone the thread opens as a sheet over the stream: the card to use is the sheet's.
        card = phone.locator("#thread .qcard")
        expect(card).to_be_visible()
        overflow = phone.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
        self.assertLessEqual(overflow, 0, "no horizontal page scroll at 390px")
        for name in ("Per bed", "One value", "Reply in your own words"):
            box = card.get_by_role("button", name=name).bounding_box()
            assert box
            self.assertGreaterEqual(box["height"], 44, f"{name} is a touch target")
        shot(phone, "question-card-phone")
        card.get_by_role("button", name="Reply in your own words").tap()
        card.get_by_label("Your answer").fill("Per bed, but start with the north one")
        card.get_by_role("button", name="Send").tap()
        expect(card).to_have_attribute("data-state", "answered")
        self.assertEqual(sent, [{"text": "Per bed, but start with the north one"}])


    def test_09_stop_offers_hand_back(self) -> None:
        # Hand back (#347 P2-4): after Stop the toast offers to give the task back to the agent; Jonas is offered neither.
        self.new_working_task("Water the seedlings at dawn", "fourth")
        page = self.page("ada")
        page.goto(f"/projects/{self.ids['project']}/agents")
        row = page.locator(f'.agents-row[data-agent="{self.ids["agent"]}"]')
        row.get_by_role("button", name="Stop Claude Code agent").click()
        expect(page.get_by_text("Stopped Claude Code agent on #4")).to_be_visible()
        page.get_by_role("button", name="Hand back").click()
        expect(page.get_by_text("Handed #4 back to Claude Code agent")).to_be_visible()
        self.assertEqual(self.task("fourth")["owner"]["id"], self.ids["agent"])
        # Negative control: Jonas, who neither owns the agent nor manages the project, sees neither Stop nor Hand back.
        jonas = self.page("jonas")
        jonas.goto(f"/projects/{self.ids['project']}/agents")
        expect(jonas.locator(f'.agents-row[data-agent="{self.ids["agent"]}"]')).to_be_visible()
        expect(jonas.get_by_role("button", name=re.compile("^(Stop|Hand back)"))).to_have_count(0)


if __name__ == "__main__":
    unittest.main()
