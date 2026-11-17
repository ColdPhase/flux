"""Each agent's colour is the same for everyone (final design §2, principle 5; #1528): a teammate sees another person's agent in the colour its
owner sees it in, in the space's conversation, in Tasks (the list, the board, the panel's Owner and the agent's messages) and in the
Inbox.

Runs through scripts/check_ui.sh against the running Compose application, on the engine FLUX_UI_BROWSER names (chromium and webkit). Its stack
runs the real worker with the TEST-ONLY `anthropic-mock` (tests/ui/anthropic_mock.py), so Ada's agent really takes a task and proposes a decision
about Ben's task with its Flux tool; nothing here calls a model.

Ada has two agents, Assistant (ink, a person's first) and Planner (teal, the next colour). Ben, a member of the same company, owns a task of his own.
"""

from __future__ import annotations

import json
import os
import re
import time
import unittest
import urllib.request
import uuid

from playwright.sync_api import Browser, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, UI_BROWSER, UPSTREAM, shot, start_forwarder

MOCK = os.environ.get("FLUX_ANTHROPIC_MOCK_URL", "http://127.0.0.1:8090")
PASSWORD = "one colour for every reader"
STAMP = int(time.time() * 1000)
PEOPLE = {"ada": ("Ada Kowalska", f"ada.colour+{STAMP}@example.test"), "ben": ("Ben Okafor", f"ben.colour+{STAMP}@example.test"),
          "gus": ("Gus Lind", f"gus.colour+{STAMP}@example.test")}
LABEL = "Ada's Planner"
READING = "The rain gauge on the shed roof reads 4 mm more than the one by the beds."
TASK = "Compare the two rain gauges"
BENS_TASK = "Move the shed gauge away from the gutter"
DECISION = "Use the bed gauge as the reference"
REPORT = "I compared a week of both gauges. The shed one catches run-off from the gutter."
TEAL = re.compile(r"(^|\s)kreska--teal(\s|$)")


def mock(path: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(f"{MOCK}{path}", data=data, method="POST" if body is not None else "GET", headers={"content-type": "application/json"})
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.loads(response.read())


class AgentColourForEveryone(unittest.TestCase):
    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}

    @classmethod
    def call(cls, who: str, method: str, path: str, body: dict | None = None, headers: dict | None = None) -> dict:
        context = cls.browser.new_context(base_url=ORIGIN, storage_state=cls.states[who], service_workers="block")
        try:
            response = context.request.fetch(path, method=method, data=json.dumps(body) if body is not None else None,
                                             headers={"origin": ORIGIN, "content-type": "application/json", **(headers or {})})
            assert response.status in (200, 201), f"{method} {path}: {response.status} {response.text()}"
            return response.json() if response.text() else {}
        finally:
            context.close()

    @classmethod
    def setUpClass(cls) -> None:
        try:
            cls.set_up()
        except BaseException:
            if cls.pw:
                cls.pw.stop()
            raise

    @classmethod
    def set_up(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        assert cls.browser.browser_type.name == UI_BROWSER
        print(f"ACTUAL_UI_ENGINE={cls.browser.browser_type.name}", flush=True)
        expect.set_options(timeout=15000)
        for key, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(base_url=ORIGIN, service_workers="block")
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.states[key] = context.storage_state()
            context.close()
        workspace = cls.call("ada", "POST", "/api/v1/workspaces", {"name": "Allotment weather"})["id"]
        cls.call("ada", "POST", f"/api/v1/workspaces/{workspace}/members", {"email": PEOPLE["ben"][1], "role": "member"})
        cls.call("ada", "POST", f"/api/v1/workspaces/{workspace}/members", {"email": PEOPLE["gus"][1], "role": "guest"})
        project = cls.ids["project"] = cls.call("ada", "POST", f"/api/v1/workspaces/{workspace}/projects", {"name": "Rain gauges", "visibility": "workspace"})["id"]
        # Gus is a guest of the company, added to this one space.
        cls.call("ada", "POST", f"/api/v1/projects/{project}/grants", {"principal": {"kind": "human", "id": cls.ids["gus"]}, "role": "contributor"})
        # Ada's two agents: the first is ink, the second takes teal, the first colour after it (#1377).
        pick = cls.call("ada", "GET", "/api/v1/personal-assistant/model")["default"]
        for name in ("Assistant", "Planner"):
            made = cls.call("ada", "POST", f"/api/v1/workspaces/{workspace}/agents", {"name": name, "owner": "self"})
            cls.call("ada", "POST", "/api/v1/my-agents", {"agentId": made["id"], "connection": pick["connection"], "model": pick["model"]})
            cls.ids[name] = made["id"]
        mine = {item["id"]: item for item in cls.call("ada", "GET", "/api/v1/my-agents")["items"]}
        assert (mine[cls.ids["Assistant"]]["colour"], mine[cls.ids["Planner"]]["colour"]) == ("ink", "teal"), mine
        # Ask me first off: Planner proposes without waiting for Ada's OK.
        cls.call("ada", "PATCH", f"/api/v1/agent-connections/{mine[cls.ids['Planner']]['connectionId']}", {"mayDo": "act"})
        cls.ids["bens_task"] = cls.call("ben", "POST", f"/api/v1/projects/{project}/work", {"title": BENS_TASK, "owner": {"kind": "human", "id": cls.ids["ben"]}})["id"]
        reading = cls.call("ben", "POST", f"/api/v1/projects/{project}/conversations", {"body": READING, "clientMessageId": str(uuid.uuid4())})
        cls.ids["reading"] = reading["messages"][0]["id"]
        # Ada makes a task of Ben's message and gives it to Planner with its Owner field: Planner takes it, proposes a decision about Ben's task
        # with its Flux tool and reports (Ask me first is off, so it marks the task done).
        mock("/__script", {"reset": True, "text": REPORT, "tool": {"name": "flux_propose_decision", "input": {
            "projectId": project, "clientCommandId": str(uuid.uuid4()), "decision": {"title": DECISION, "affects": [cls.ids["bens_task"]]}}}})
        task = cls.call("ada", "POST", f"/api/v1/projects/{project}/work", {
            "title": TASK, "owner": {"kind": "human", "id": cls.ids["ada"]}, "sources": [{"type": "message", "id": cls.ids["reading"]}], "clientCommandId": str(uuid.uuid4())})
        cls.ids["task"] = task["id"]
        cls.call("ada", "PATCH", f"/api/v1/work/{task['id']}", {"owner": {"kind": "agent", "id": cls.ids["Planner"]}}, headers={"if-match": f"\"{task['version']}\""})
        deadline = time.time() + 90
        state: dict = {}
        approved = False
        while time.time() < deadline:
            state = cls.call("ada", "GET", f"/api/v1/work/{task['id']}/agent")
            if state.get("line") in ("done", "handed_back"):
                break
            # A proposal about someone else's task waits for its owner's OK whatever Ask me first says (#1419): Ada gives it, as Approve does.
            if state.get("line") == "waiting_for_ok" and state.get("runId") and not approved:
                cls.call("ada", "POST", f"/api/v1/assistant-runs/{state['runId']}/changes/apply", {})
                approved = True
            time.sleep(0.5)
        assert state.get("line") in ("done", "handed_back"), f"Planner never finished the task: {state}"
        # The proposal is the run's: say what its tool answered if it is not there.
        decisions = cls.call("ada", "GET", f"/api/v1/projects/{project}/decisions")
        if not any(item["title"] == DECISION for item in decisions.get("items", [])):
            sent = mock("/__requests")["requests"]
            tools = sorted({tool.get("name", "") for request in sent for tool in request["body"].get("tools", []) if "decision" in tool.get("name", "")})
            results = [block for request in sent for message in request["body"].get("messages", []) if isinstance(message.get("content"), list)
                       for block in message["content"] if isinstance(block, dict) and block.get("type") in ("tool_result", "tool_use")]
            raise AssertionError(f"Planner proposed no decision; decision tools offered {tools}; tool blocks {json.dumps(results)[:3000]}")

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, who: str) -> Page:
        context = self.browser.new_context(base_url=ORIGIN, viewport=DESKTOP, device_scale_factor=1, locale="en-GB", timezone_id="Europe/Warsaw",
                                           storage_state=self.states[who], service_workers="block")
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def test_01_the_conversation_draws_planner_in_teal_for_ben_as_for_ada(self) -> None:
        for who in ("ben", "ada"):
            page = self.page(who)
            page.goto(f"/projects/{self.ids['project']}")
            card = page.locator(f'.convo-notice[data-work-id="{self.ids["task"]}"]')
            expect(card.locator(".convo-notice__owner .kreska")).to_have_class(TEAL)
            # The card names the agent by its one label (round 15 ai P3: a removed owner's agent read only "Assistant").
            expect(card.locator(".convo-notice__owner-name")).to_have_text(LABEL)
            shot(page, f"agent-colour-conversation-{who}-{UI_BROWSER}")

    def test_02_tasks_draw_planner_in_teal_for_ben(self) -> None:
        page = self.page("ben")
        project = self.ids["project"]
        page.goto(f"/projects/{project}/tasks?view=list")
        row = page.locator(f'.ws-task[data-work-id="{self.ids["task"]}"]')
        expect(row.locator(".ws-item__r .kreska")).to_have_class(TEAL)
        # Ben's own task keeps his initials and no colour.
        expect(page.locator(f'.ws-task[data-work-id="{self.ids["bens_task"]}"] .kreska')).to_have_count(0)
        page.goto(f"/projects/{project}/tasks?view=board")
        owner = page.locator(".tb-card", has_text=TASK).locator(".tb-card__owner")
        expect(owner.locator(".agent-id > .kreska")).to_have_class(TEAL)
        # Ben reads Planner's owner as Ada does, so there is no Agent tag (only while the owner is unknown, L1414–1416; release audit ffcb07c P2-4).
        expect(owner.locator(".agent-tag")).to_have_count(0)
        page.goto(f"/projects/{project}/tasks?open=work:{self.ids['task']}")
        panel = page.get_by_role("complementary", name="Details")
        expect(panel.get_by_role("button", name="Owner").locator(".agent-id > .kreska")).to_have_class(TEAL)
        # The task is done, so no agent's line is drawn: its history line says it for every reader (personas-26, #856). The agent's own
        # messages in the task's discussion: the same face.
        expect(panel.locator("[data-agent-line]")).to_have_count(0)
        expect(panel.get_by_role("list", name="Task activity").locator("li").filter(has_text="marked it done")).to_have_count(1)
        said = panel.locator(".wd-act__item--message").filter(has_text="the gutter")
        expect(said.locator(".wd-act__face")).to_have_class(TEAL)
        # "In this task": Ada's two agents, Assistant in ink and Planner in teal, as Ada sees them.
        people = panel.locator("[data-task-people]")
        expect(people.locator(".kreska--teal")).to_have_count(1)
        expect(people.locator(".kreska--ink")).to_have_count(1)
        shot(page, f"agent-colour-task-panel-ben-{UI_BROWSER}")

    def test_03_bens_inbox_draws_planners_proposal_in_teal(self) -> None:
        page = self.page("ben")
        page.goto("/inbox")
        card = page.locator(".nyc", has_text=DECISION)
        expect(card).to_be_visible(timeout=30000)
        expect(card.locator(".nyc__face .kreska")).to_have_class(TEAL)
        shot(page, f"agent-colour-inbox-ben-{UI_BROWSER}")

    def test_05_planner_has_one_label_for_its_owner_a_member_and_a_guest(self) -> None:
        """Release audit ffcb07c P2-4: for anyone but Ada the board card, the List row, the panel's Owner and "marked it done" said "Planner [Agent]"
        while the discussion said "Planner · Ada's agent". One label for every reader, now "Ada's Planner" (round 15 ai P2-5) (final design L1414–1416, L277): the Agent tag only while the
        owner is unknown."""
        project = self.ids["project"]
        for who in ("ada", "ben", "gus"):
            with self.subTest(who=who):
                page = self.page(who)
                page.goto(f"/projects/{project}/tasks?view=list")
                row = page.locator(f'.ws-task[data-work-id="{self.ids["task"]}"]')
                expect(row.locator(".ws-item__s .agent-id")).to_have_text(LABEL)
                expect(row.locator(".agent-tag")).to_have_count(0)
                page.goto(f"/projects/{project}/tasks?view=board")
                owner = page.locator(".tb-card", has_text=TASK).locator(".tb-card__owner")
                expect(owner.locator(".agent-id__label")).to_have_text(LABEL)
                expect(owner.locator(".agent-tag")).to_have_count(0)
                page.goto(f"/projects/{project}/tasks?open=work:{self.ids['task']}")
                panel = page.get_by_role("complementary", name="Details")
                expect(panel.get_by_role("button", name="Owner").locator(".agent-id__label")).to_have_text(LABEL)
                done = panel.locator('.wd-act__item[data-activity="status"]').filter(has_text="Planner").first
                expect(done.locator(".agent-id__label")).to_have_text(LABEL)
                expect(panel.locator(".wd-act__item:not(.wd-act__item--message) .agent-tag")).to_have_count(0)
                said = panel.locator(".wd-act__item--message").filter(has_text="the gutter")
                expect(said.locator(".agent-id__label")).to_have_text(LABEL)
                # A message's name line carries the Agent tag, as an answer shown to everyone does (#1232, round 15 ai P2-5).
                expect(said.locator(".agent-tag")).to_have_count(1)
                shot(page, f"agent-label-task-panel-{who}-{UI_BROWSER}")

    def test_04_the_chat_task_chip_ends_in_an_ellipsis_and_the_agent_page_fields_are_14_px_round(self) -> None:
        """Release audit (skipped by #1524): the Planner chat's task chip was cut with no ellipsis; the agent page's fields took 12 px corners."""
        context = self.browser.new_context(base_url=ORIGIN, viewport={"width": 360, "height": 780}, device_scale_factor=2, is_mobile=True, has_touch=True,
                                           locale="en-GB", timezone_id="Europe/Warsaw", storage_state=self.states["ada"], service_workers="block")
        self.addCleanup(context.close)
        page = context.new_page()
        page.goto(f"/agents/{self.ids['Planner']}")
        chip = page.locator(".agc__chip").first
        expect(chip).to_be_visible()
        words = chip.locator(".agc__chip-t")
        cut = words.evaluate("el => ({ overflow: getComputedStyle(el).textOverflow, clipped: el.scrollWidth > el.clientWidth, chip: el.closest('.agc__chip').getBoundingClientRect().right, bubble: el.closest('.dm-msg__body').getBoundingClientRect().right })")
        self.assertEqual(cut["overflow"], "ellipsis", cut)
        self.assertLessEqual(cut["chip"], cut["bubble"] + 0.5, f"the chip stays inside its bubble: {cut}")
        shot(page, f"agent-colour-chat-chip-360-{UI_BROWSER}")
        page.goto(f"/settings/agents/{self.ids['Planner']}")
        field = page.locator("#agent-name")
        expect(field).to_be_visible()
        self.assertEqual(field.evaluate("el => getComputedStyle(el).borderTopLeftRadius"), "14px")


if __name__ == "__main__":
    unittest.main()
