"""Browser journey: agents work together in a task's thread (#841, F-036 TA-2, TA-3) and a task keeps its message (#844).

Runs with the other tests/ui journeys through scripts/check_ui.sh, whose stack is composed with the TEST-ONLY switch
`FLUX_TEST_PERSONAL_RUNS=anthropic-mock`: every person has a fixture key connection and the real worker sends runs through the real
`@flux/agent-runtime` adapter to `tests/ui/anthropic_mock.py`, which here answers each run by what it was asked (its `rules`). Nothing
here calls a model; no test is a provider, billing or compatibility pass.

Ada's agent Planner takes a task Jonas made. It asks Jonas's agent Fieldbot a question in the thread, Fieldbot answers on Jonas's account
(reading only), Planner goes on with the answer and the task is done. A question to an agent that is not in the task goes back to the people.
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
PASSWORD = "agents that ask each other"
STAMP = int(time.time() * 1000)
ADA = {"name": "Ada Kowalska", "email": f"ada.asks+{STAMP}@example.test"}
JONAS = {"name": "Jonas Berg", "email": f"jonas.asks+{STAMP}@example.test"}
QUESTION = "Which reading means full on the north barrel?"
ASK = '<ask>{{"agent": "Fieldbot", "owner": "Jonas", "question": "' + QUESTION + '"}}</ask>'
FIRST = "I compared the last 40 readings with the sensor log."
ANSWER = "0.82 V means full."
LAST = "Thanks. The south barrel reads 0.64 V when full, so it is the wiring, not the level."


def mock(path: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(f"{MOCK}{path}", data=data, method="POST" if body is not None else "GET", headers={"content-type": "application/json"})
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.loads(response.read())


class AgentTaskQuestions(unittest.TestCase):
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

    def wait_for(self, what: str, probe, timeout: float = 90):
        deadline = time.time() + timeout
        last = None
        while time.time() < deadline:
            last = probe()
            if last:
                return last
            time.sleep(0.5)
        self.fail(f"timed out waiting for {what}; last {last!r}")

    def given_to_planner(self, title: str) -> dict:
        """Jonas makes a task; Ada gives it to her own agent, which takes it."""
        jonas, ada = self.page("jonas"), self.page("ada")
        task = self.api(jonas, "POST", f"/api/v1/projects/{self.ids['project']}/work", {"title": title}, status=201)
        self.api(ada, "PATCH", f"/api/v1/work/{task['id']}", {"owner": {"kind": "agent", "id": self.ids["planner"]}},
                 status=200, headers={"if-match": f"\"{task['version']}\""})
        return task

    def thread(self, page: Page, work: str) -> list[tuple[str, str]]:
        talk = self.api(page, "GET", f"/api/v1/work/{work}/discussion?limit=50", status=200)
        messages = {m["id"]: m for m in [talk.get("root"), *talk.get("messages", [])] if m}
        return [("agent" if m.get("authorId") is None else "person", m["body"]) for m in sorted(messages.values(), key=lambda m: m["sequence"])]

    # ---------------------------------------------------------------- setup

    def test_01_two_people_each_with_an_agent_share_a_space(self) -> None:
        for key, person in (("ada", ADA), ("jonas", JONAS)):
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
        self.api(ada, "POST", f"/api/v1/workspaces/{ws['id']}/members", {"email": JONAS["email"], "role": "member"}, status=201)
        project = self.api(ada, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Rain barrel monitor", "visibility": "workspace"}, status=201)
        ids = {"workspace": ws["id"], "project": project["id"]}
        for key, name in (("ada", "Planner"), ("jonas", "Fieldbot")):
            page = self.page(key)
            agent = self.api(page, "POST", f"/api/v1/workspaces/{ws['id']}/agents", {"name": name, "owner": "self"}, status=201)
            pick = self.api(page, "GET", "/api/v1/personal-assistant/model", status=200)["default"]
            self.api(page, "POST", "/api/v1/my-agents", {"agentId": agent["id"], "connection": pick["connection"], "model": pick["model"]}, status=201)
            ids["planner" if key == "ada" else "fieldbot"] = agent["id"]
        type(self).ids = ids

    # ---------------------------------------------------------------- TA-3: a question between agents of two owners

    def test_02_an_agent_asks_another_and_goes_on_with_its_answer(self) -> None:
        mock("/__script", {"reset": True, "text": FIRST + "\n" + ASK, "rules": [
            {"match": "Continue the task with this answer", "text": LAST},
            {"match": "Answer the question in the request", "text": ANSWER}]})
        task = self.given_to_planner("Calibrate the overflow sensor")
        type(self).ids["exchange"] = task["id"]
        ada = self.page("ada")
        self.wait_for("the task to be done", lambda: self.api(ada, "GET", f"/api/v1/work/{task['id']}", status=200)["status"] == "done")
        said = self.thread(ada, task["id"])
        self.assertEqual(said, [("agent", "Got it, I'm on it."), ("agent", FIRST), ("agent", f"@Fieldbot (Jonas's agent), {QUESTION}"), ("agent", ANSWER), ("agent", LAST)],
                         "the exchange is in the thread, in order, for everyone")
        # Jonas pays for his agent's answer and sees it as his own run.
        jonas = self.page("jonas")
        kinds = [run["kind"] for run in self.api(jonas, "GET", "/api/v1/assistant-runs?limit=20", status=200)["items"]]
        self.assertEqual(kinds, ["task_answer"])
        # The answer only reads: none of the change tools was offered to it, whatever Fieldbot may do.
        asked = [r for r in mock("/__requests")["requests"] if "Answer the question in the request" in json.dumps(r["body"])]
        self.assertTrue(asked, "the mock saw the answering run")
        tools = {tool["name"] for tool in asked[0]["body"].get("tools", [])}
        self.assertFalse({"flux_create_task", "flux_update_task", "flux_create_doc", "flux_update_doc"} & tools, f"an answer reads only: {sorted(tools)}")
        # The thread shows the exchange in the task panel as the agents' own messages.
        page = self.page("jonas")
        page.goto(f"/projects/{self.ids['project']}/tasks?open=work:{task['id']}")
        panel = page.get_by_role("complementary", name="Details")
        expect(panel.locator(".wd-act__item--message").filter(has_text=ANSWER)).to_be_visible()
        expect(panel.locator("[data-task-people]")).to_contain_text("their agents")

    def test_02b_the_owner_of_an_agent_takes_back_what_it_said_in_the_thread(self) -> None:
        """#923: each owner has Undo under their own agent's lines only; Jonas takes back the answer and everyone reads who did."""
        task = self.ids["exchange"]
        url = f"/projects/{self.ids['project']}/tasks?open=work:{task}"
        jonas_page, ada_page = self.page("jonas"), self.page("ada")
        jonas_page.goto(url)
        ada_page.goto(url)
        lines = lambda page, text: page.get_by_role("complementary", name="Details").locator(".wd-act__item--message").filter(has_text=text)
        expect(lines(jonas_page, ANSWER).get_by_role("button", name="Undo")).to_have_count(1)
        expect(lines(jonas_page, FIRST).get_by_role("button", name="Undo")).to_have_count(0)
        expect(lines(ada_page, FIRST).get_by_role("button", name="Undo")).to_have_count(1)
        expect(lines(ada_page, ANSWER)).to_be_visible()
        expect(lines(ada_page, ANSWER).get_by_role("button", name="Undo")).to_have_count(0)
        # The state line above (whose own "Undo" reopens the task) no longer lists the lines: they are taken back where they stand.
        expect(ada_page.get_by_role("complementary", name="Details").locator(".wd-agent .assistant-message")).to_have_count(0)
        message = lines(jonas_page, ANSWER).get_attribute("data-message-id")
        lines(jonas_page, ANSWER).get_by_role("button", name="Undo").click()
        taken = jonas_page.get_by_role("complementary", name="Details").locator(f"[data-message-id='{message}']")
        expect(taken).to_contain_text("Removed with Undo")
        expect(taken).to_contain_text(f"Undone by {JONAS['name']}")
        ada_page.goto(url)
        again = ada_page.get_by_role("complementary", name="Details").locator(f"[data-message-id='{message}']")
        expect(again).to_contain_text(f"Undone by {JONAS['name']}")
        expect(again.get_by_role("button", name="Undo")).to_have_count(0)
        self.assertNotIn(ANSWER, [body for _, body in self.thread(ada_page, task)])

    def test_03_a_question_to_an_agent_that_is_not_in_the_task_goes_back_to_the_people(self) -> None:
        mock("/__script", {"reset": True, "text": FIRST + "\n" + ASK.replace("Fieldbot", "Ghost")})
        task = self.given_to_planner("Weigh the full barrel")
        ada = self.page("ada")
        current = self.wait_for("the task to come back to Ada", lambda: (lambda item: item if item["owner"]["kind"] == "human" else None)(self.api(ada, "GET", f"/api/v1/work/{task['id']}", status=200)))
        self.assertEqual(current["owner"]["id"], ADA["id"])
        self.assertNotEqual(current["status"], "done")
        said = [body for _, body in self.thread(ada, task["id"])]
        self.assertIn("I can't ask Ghost (Jonas's agent): they are not in this task. This needs a person.", said)

    # ---------------------------------------------------------------- TA-2: subtasks, and #844: the message a task came from

    def test_04_subtasks_are_part_of_their_parent(self) -> None:
        ada = self.page("ada")
        parent = self.api(ada, "POST", f"/api/v1/projects/{self.ids['project']}/work", {"title": "Re-check both barrels"}, status=201)
        for title in ("Compare the last 40 readings", "Check the float on the south barrel"):
            self.api(ada, "POST", f"/api/v1/projects/{self.ids['project']}/work", {"title": title, "parentId": parent["id"]}, status=201)
        page = self.page("ada")
        page.goto(f"/projects/{self.ids['project']}/tasks?open=work:{parent['id']}")
        section = page.get_by_role("complementary", name="Details").locator("[data-subtasks]")
        expect(section).to_contain_text("Subtasks · 0 of 2 done")
        expect(section.get_by_role("button", name=re.compile("Compare the last 40 readings"))).to_be_visible()
        self.assertEqual(self.api(ada, "GET", f"/api/v1/work/{parent['id']}", status=200)["status"], "open", "the parent does not wait for its subtasks")

    def test_05_a_task_made_from_a_message_opens_it_in_context(self) -> None:
        ada = self.page("ada")
        talk = self.api(ada, "POST", f"/api/v1/projects/{self.ids['project']}/conversations", {"body": "The overflow sensor says full when the barrel is half empty.", "clientMessageId": str(uuid.uuid4())}, status=201)
        message = talk["messages"][0]
        task = self.api(ada, "POST", f"/api/v1/projects/{self.ids['project']}/work", {"title": "Calibrate the overflow sensor", "sources": [{"type": "message", "id": message["id"]}]}, status=201)
        page = self.page("jonas")
        page.goto(f"/projects/{self.ids['project']}/tasks?open=work:{task['id']}")
        link = page.get_by_role("complementary", name="Details").get_by_role("link", name=re.compile("Message:"))
        expect(link).to_contain_text("The overflow sensor says full")
        link.click()
        expect(page).to_have_url(re.compile(rf"/conversations/{talk['id']}#message-{message['id']}"))
        expect(page.locator(f"[data-message-id='{message['id']}']").first).to_be_visible()


if __name__ == "__main__":
    unittest.main()
