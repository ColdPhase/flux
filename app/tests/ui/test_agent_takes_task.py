"""Browser journey: a person's agent takes a task assigned to its owner (#856, F-036 AG-5; #904).

Runs with the other tests/ui journeys through scripts/check_ui.sh, whose stack is composed with the TEST-ONLY switch
`FLUX_TEST_PERSONAL_RUNS=anthropic-mock`: every person has a fixture key connection and the real worker sends runs through the
real `@flux/agent-runtime` Anthropic adapter to `tests/ui/anthropic_mock.py`. Nothing here calls a model; no test is a provider,
billing or compatibility pass.

The journey: Ada assigns Kai a task. Kai chose "Give it to <his agent>" in Settings > AI, so his agent takes it, says it is on it,
works, writes its report in the task and, with "Do it and tell me", marks it Done. With "Ask me first" it hands the task back to
Kai instead. The Owner field offers a person's own agents and nobody else's.
"""

from __future__ import annotations

import json
import os
import re
import time
import unittest
import urllib.request
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, UPSTREAM, start_forwarder

MOCK = os.environ.get("FLUX_ANTHROPIC_MOCK_URL", "http://127.0.0.1:8090")
UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
PASSWORD = "an agent that takes my tasks"
STAMP = int(time.time() * 1000)
ADA = {"name": "Ada Kowalska", "email": f"ada.takes+{STAMP}@example.test"}
KAI = {"name": "Kai Lund", "email": f"kai.takes+{STAMP}@example.test"}
REPORT = "I compared the last 40 readings with the sensor log. The wiring is the problem, not the level."


def mock(path: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(f"{MOCK}{path}", data=data, method="POST" if body is not None else "GET", headers={"content-type": "application/json"})
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.loads(response.read())


class AgentTakesTask(unittest.TestCase):
    """Tests run in name order and share two accounts and one space."""

    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=15000)
        mock("/__script", {"reset": True})

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def context(self, who: str | None) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "color_scheme": "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw", "viewport": DESKTOP, "device_scale_factor": 1}
        if who and who in self.states:
            options["storage_state"] = self.states[who]
        context = self.browser.new_context(service_workers="block", **options)
        self.addCleanup(context.close)
        return context

    def page(self, who: str | None) -> Page:
        page = self.context(who).new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def api(self, page: Page, method: str, path: str, body: dict | None = None, status: int | None = None, headers: dict | None = None) -> dict:
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers={"origin": ORIGIN, "content-type": "application/json", **(headers or {})},
                                      data=json.dumps(body) if body is not None else None)
        if status is not None:
            self.assertEqual(response.status, status, response.text())
        return json.loads(response.text()) if response.text() else {}

    def task(self, page: Page, title: str, owner_id: str | None) -> dict:
        body: dict = {"title": title}
        if owner_id:
            body["owner"] = {"kind": "human", "id": owner_id}
        return self.api(page, "POST", f"/api/v1/projects/{self.ids['project']}/work", body, status=201)

    def agent_line(self, page: Page, work: str, wanted: str, timeout: float = 60) -> dict:
        """The agent's state on a task, read until it is the wanted line (the worker is real, so it takes a moment)."""
        deadline = time.time() + timeout
        state: dict = {}
        while time.time() < deadline:
            state = self.api(page, "GET", f"/api/v1/work/{work}/agent", status=200)
            if state.get("line") == wanted:
                return state
            page.wait_for_timeout(500)
        self.fail(f"the agent never reached {wanted!r} on the task; last state {state}")

    def open_task(self, who: str, work: str) -> Page:
        page = self.page(who)
        page.goto(f"/projects/{self.ids['project']}/tasks?open=work:{work}")
        expect(page.get_by_role("complementary", name="Details")).to_be_visible()
        return page

    # ---------------------------------------------------------------- setup

    def test_01_two_people_share_a_space_and_kai_has_an_agent(self) -> None:
        for key, person in (("ada", ADA), ("kai", KAI)):
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
        ws = self.api(ada, "POST", "/api/v1/workspaces", {"name": "Garden sensors"}, status=201)
        self.api(ada, "POST", f"/api/v1/workspaces/{ws['id']}/members", {"email": KAI["email"], "role": "member"}, status=201)
        project = self.api(ada, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Rain barrel monitor", "visibility": "workspace"}, status=201)
        kai = self.page("kai")
        agent = self.api(kai, "POST", f"/api/v1/workspaces/{ws['id']}/agents", {"name": "Planner", "owner": "self"}, status=201)
        pick = self.api(kai, "GET", "/api/v1/personal-assistant/model", status=200)["default"]
        self.api(kai, "POST", "/api/v1/personal-assistant", {"agentId": agent["id"], "connection": pick["connection"], "model": pick["model"]}, status=201)
        type(self).ids = {"workspace": ws["id"], "project": project["id"], "agent": agent["id"]}

    # ---------------------------------------------------------------- #904: the Owner field offers your own agents only

    def test_02_the_owner_field_offers_only_your_own_agents(self) -> None:
        task = self.task(self.page("ada"), "Which sensor reads full?", None)
        type(self).ids["first"] = task["id"]
        for who, expected in (("ada", 0), ("kai", 1)):
            page = self.open_task(who, task["id"])
            page.get_by_role("button", name="Owner").click()
            menu = page.get_by_role("listbox")
            expect(menu).to_contain_text("People")
            self.assertEqual(menu.get_by_role("option", name=re.compile(r"Planner")).count(), expected, f"{who}'s Owner choices")
        # Ada cannot give it to Kai's agent by the API either: she reaches it through Kai.
        refused = self.api(self.page("ada"), "PATCH", f"/api/v1/work/{task['id']}", {"owner": {"kind": "agent", "id": self.ids["agent"]}},
                           status=422, headers={"if-match": f"\"{task['version']}\""})
        self.assertEqual(refused["code"], "OWNER_NOT_YOUR_AGENT")

    # ---------------------------------------------------------------- the setting

    def test_03_kai_chooses_to_give_assigned_tasks_to_his_agent(self) -> None:
        page = self.page("kai")
        page.goto("/settings/agents")
        row = page.locator("[data-task-taking]")
        expect(row).to_contain_text("When someone assigns a task to me")
        expect(row.get_by_role("combobox")).to_contain_text("Do nothing")
        row.get_by_role("combobox").click()
        page.get_by_role("option", name="Give it to Planner").click()
        expect(row.get_by_role("status")).to_contain_text("Saved")
        self.assertEqual(self.api(page, "GET", "/api/v1/me/task-taking", status=200)["takes"], self.ids["agent"])

    # ---------------------------------------------------------------- the journey: assigned, taken, worked, reported, Done

    def test_04_ada_assigns_kai_a_task_and_his_agent_does_it(self) -> None:
        mock("/__script", {"reset": True, "text": REPORT})
        ada = self.page("ada")
        task = self.task(ada, "Calibrate the overflow sensor", KAI["id"])
        type(self).ids["task"] = task["id"]
        state = self.agent_line(self.page("kai"), task["id"], "done")
        self.assertEqual(state["agent"]["name"], "Planner")
        # The task is the agent's, Doing became Done, and Kai is told in the task: the agent's words and one plain line.
        page = self.open_task("kai", task["id"])
        panel = page.get_by_role("complementary", name="Details")
        expect(panel.locator("[data-agent-line='done']")).to_contain_text("Marked done · you were told")
        expect(panel.locator(".wd-act__item--message").filter(has_text="Got it, I'm on it.")).to_be_visible()
        expect(panel.locator(".wd-act__item--message").filter(has_text="the wiring is the problem")).to_be_visible()
        expect(panel.get_by_text("Planner").first).to_be_visible()
        # What Ada sees is the same line: it is the task's, not Kai's private view.
        ada_view = self.open_task("ada", task["id"])
        expect(ada_view.get_by_role("complementary", name="Details").locator("[data-agent-line='done']")).to_contain_text("Marked done")
        self.assertEqual(self.api(ada, "GET", f"/api/v1/work/{task['id']}", status=200)["status"], "done")

    def test_05_undo_takes_it_back_to_kai_and_reopens_it(self) -> None:
        page = self.open_task("kai", self.ids["task"])
        panel = page.get_by_role("complementary", name="Details")
        panel.locator("[data-agent-line='done']").get_by_role("button", name="Undo").click()
        expect(panel.locator("[data-agent-line='done']")).to_have_count(0)
        task = self.api(page, "GET", f"/api/v1/work/{self.ids['task']}", status=200)
        self.assertEqual((task["status"], task["owner"]["id"]), ("in_progress", KAI["id"]), "reopened and back with Kai, and not taken again by his own setting")
        page.wait_for_timeout(1500)
        self.assertEqual(self.api(page, "GET", f"/api/v1/work/{self.ids['task']}", status=200)["owner"]["kind"], "human")

    # ---------------------------------------------------------------- Ask me first: handed back to check

    def test_06_with_ask_me_first_the_task_comes_back_to_check(self) -> None:
        kai = self.page("kai")
        settings = self.api(kai, "GET", f"/api/v1/workspaces/{self.ids['workspace']}/assistants/{KAI['id']}/settings", status=200)
        self.api(kai, "PATCH", f"/api/v1/agent-connections/{settings['connectionId']}", {"mayDo": "ask"}, status=200)
        mock("/__script", {"reset": True, "text": REPORT})
        task = self.task(self.page("ada"), "Re-check the south barrel wiring", KAI["id"])
        state = self.agent_line(kai, task["id"], "handed_back")
        self.assertEqual(state["text"], "Back with you to check")
        current = self.api(kai, "GET", f"/api/v1/work/{task['id']}", status=200)
        self.assertEqual((current["status"], current["owner"]["kind"], current["owner"]["id"]), ("in_progress", "human", KAI["id"]))
        page = self.open_task("kai", task["id"])
        expect(page.get_by_role("complementary", name="Details").locator(".wd-act__item--message").filter(has_text="the wiring is the problem")).to_be_visible()

    # ---------------------------------------------------------------- Do nothing: the default

    def test_07_without_the_setting_nothing_starts(self) -> None:
        kai = self.page("kai")
        self.api(kai, "PUT", "/api/v1/me/task-taking", {"agentId": None}, status=200)
        runs_before = len(self.api(kai, "GET", "/api/v1/assistant-runs?limit=50", status=200)["items"])
        task = self.task(self.page("ada"), "Order six capacitive probes", KAI["id"])
        self.page("kai").wait_for_timeout(2500)
        self.assertEqual(self.api(kai, "GET", f"/api/v1/work/{task['id']}", status=200)["owner"]["kind"], "human")
        self.assertEqual(len(self.api(kai, "GET", "/api/v1/assistant-runs?limit=50", status=200)["items"]), runs_before, "no run was made")
        self.assertEqual(self.api(kai, "GET", f"/api/v1/work/{task['id']}/agent", status=200)["line"], None)


if __name__ == "__main__":
    unittest.main()
