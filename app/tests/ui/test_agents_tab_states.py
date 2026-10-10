"""Browser tests for the Agents tab's states and reading (F-026 P9; #347 P1 and P2).

Ada manages a project with Jonas (a contributor). Ada's agents: "Codex" (one laptop, holds #1 in progress), "Claude Code"
(holds #3 in progress), "Lab helper" (a tablet, holds #5 in progress) and "Notes" (a laptop, holds nothing). Jonas's
"Claude Code" holds #2, blocked. #4 is open with no owner. The connection states, the questions and the agent's messages are
stubbed on the page (the server rules behind them are tested in tests/app); the stubs keep the real records and change only
what the test needs. Every test has a negative control in a comment: reverting the fix makes it fail.
"""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid
from datetime import datetime, timedelta, timezone

from playwright.sync_api import Browser, BrowserContext, Page, Route, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

PASSWORD = "the lamp reads its own state"
STAMP = int(time.time() * 1000)
ADA = {"name": "Ada Kowalska", "email": f"ada.tabstates+{STAMP}@example.test"}
JONAS = {"name": "Jonas Berg", "email": f"jonas.tabstates+{STAMP}@example.test"}


def iso(minutes: int) -> str:
    """A timestamp `minutes` from now (negative: the past), in the server's format."""
    return (datetime.now(timezone.utc) + timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def open_session() -> dict:
    return {"state": "session_open", "session": {"startedAt": iso(-10), "expiresAt": iso(60)}}


def offline(last: dict | None = None) -> dict:
    return {"state": "offline", "session": None, "lastActivity": last}


def not_signed_in() -> dict:
    return {"state": "not_signed_in", "session": None, "lastActivity": None}


def recorded_result(minutes_ago: int) -> dict:
    return {"operation": "result.record", "at": iso(-minutes_ago)}


class AgentsTabStates(unittest.TestCase):
    """Tests run in name order and share two accounts, one project, six agent connections and five tasks."""

    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}

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

    def api(self, page: Page, method: str, path: str, body: dict | None = None, status: int | None = None, headers: dict | None = None) -> dict | list:
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers={"origin": ORIGIN, "content-type": "application/json", **(headers or {})},
                                      data=json.dumps(body) if body is not None else None)
        if status is not None:
            self.assertEqual(response.status, status, response.text())
        return json.loads(response.text()) if response.text() else {}

    def row(self, page: Page, key: str):
        return page.locator(f'.agents-row[data-agent="{self.ids[key]}"]')

    def task(self, key: str) -> dict:
        return self.api(self.page("ada"), "GET", f"/api/v1/work/{self.ids[key]}", status=200)

    # Stubs: the real response, changed for the named connections, questions, or the agent's messages in a task thread.

    def stub_connections(self, page: Page, changes: dict[str, dict], extra: list[dict] | None = None) -> None:
        """`changes` maps a connection id (self.ids["conn_..."]) to the fields to set; `extra` adds connections of the same shape."""
        def handle(route: Route) -> None:
            response = route.fetch()
            body = response.json()
            for connection in body["connections"]:
                if connection["id"] in changes:
                    connection.update(changes[connection["id"]])
            body["connections"].extend(extra or [])
            route.fulfill(response=response, json=body)
        page.route(re.compile(rf".*/api/v1/projects/{self.ids['project']}/agents$"), handle)

    def stub_questions(self, page: Page, questions: list[dict]) -> None:
        pid = self.ids["project"]
        body = json.dumps({"projectId": pid, "questions": questions})
        page.route(re.compile(rf".*/api/v1/projects/{pid}/agent-questions$"), lambda route: route.fulfill(status=200, content_type="application/json", body=body))

    def question(self, *, asked: str, text: str, message: str, task: str | None, answer: dict | None = None) -> dict:
        return {"id": str(uuid.uuid4()), "projectId": self.ids["project"], "conversationId": self.ids["conversation"], "messageId": message,
                "taskId": task, "agent": {"id": self.ids["codex"], "name": "Codex"}, "askedUserId": asked, "question": text,
                "options": ["Merge now", "Wait"], "createdAt": iso(-5), "answer": answer}

    def stub_thread(self, page: Page, task: str, changes: dict[str, dict]) -> None:
        """`changes` maps a message id to fields set on it, e.g. an agent's authorship and body."""
        def handle(route: Route) -> None:
            if route.request.method != "GET":
                route.continue_()
                return
            response = route.fetch()
            body = response.json()
            for message in [body.get("root"), *body.get("messages", [])]:
                if message and message["id"] in changes:
                    message.update(changes[message["id"]])
            route.fulfill(response=response, json=body)
        page.route(re.compile(rf".*/api/v1/work/{self.ids[task]}/discussion(\?.*)?$"), handle)

    def as_agent(self, agent: str) -> dict:
        return {"authorId": None, "author": {"kind": "agent", "id": self.ids[agent], "name": {"codex": "Codex", "claude": "Claude Code", "lab": "Lab helper"}[agent]}}

    # The fixture: two people, a workspace, a project, six agents with connections where they have them, and five tasks.

    def test_00_a_project_with_agents_connections_and_tasks(self) -> None:
        for key, person in {"ada": ADA, "jonas": JONAS}.items():
            page = self.page(None)
            page.goto("/sign-up")
            page.get_by_label("Name").fill(person["name"])
            page.get_by_label("Email").fill(person["email"])
            page.get_by_label("Password").fill(PASSWORD)
            page.get_by_role("button", name="Create account").click()
            expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
            type(self).states = {**self.states, key: page.context.storage_state()}
            person["id"] = self.api(page, "GET", "/api/v1/me", status=200)["user"]["id"]
        ada, jonas = self.page("ada"), self.page("jonas")
        ws = self.api(ada, "POST", "/api/v1/workspaces", {"name": "Community garden"}, status=201)
        self.api(ada, "POST", f"/api/v1/workspaces/{ws['id']}/members", {"email": JONAS["email"], "role": "member"}, status=201)
        pid = self.api(ada, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Garden sensors", "visibility": "restricted"}, status=201)["id"]
        self.api(ada, "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": JONAS["id"]}, "role": "contributor"}, status=201)
        ids = {"workspace": ws["id"], "project": pid}
        scopes = ["flux.context.read", "flux.proposal.write"]
        agents = {"codex": ("Codex", ada, "codex", "Desk laptop"), "claude": ("Claude Code", ada, "claude_code", "Desk laptop"),
                  "lab": ("Lab helper", ada, "other", "Lab tablet"), "notes": ("Notes", ada, "other", "Notes laptop"),
                  "jonas_claude": ("Claude Code", jonas, "claude_code", "Workshop PC")}
        for key, (name, owner, client, connection) in agents.items():
            agent = self.api(owner, "POST", f"/api/v1/workspaces/{ws['id']}/agents", {"name": name, "owner": "self"}, status=201)["id"]
            ids[key] = agent
            self.api(ada, "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "agent", "id": agent}, "role": "contributor"}, status=201)
            made = self.api(owner, "POST", "/api/v1/agent-connections", {"agentId": agent, "selectedProjectIds": [pid], "scopes": scopes,
                                                                         "name": connection, "clientDesignation": client}, status=201)
            ids[f"conn_{key}"] = made["id"]
        type(self).ids = ids
        self.new_task("Fix the reconnect loop in the lamp firmware", "task1", owner={"kind": "agent", "id": ids["codex"]}, status="in_progress")
        self.new_task("Mount the probe at two depths", "task2", owner={"kind": "agent", "id": ids["jonas_claude"]}, status="blocked",
                      blocker="Waiting for the probe drawing")
        self.new_task("Calibrate the soil probes", "task3", owner={"kind": "agent", "id": ids["claude"]}, status="in_progress")
        self.new_task("Print a label for each of the six beds", "task4")
        self.new_task("Log the greenhouse humidity", "task5", owner={"kind": "agent", "id": ids["lab"]}, status="in_progress")
        # Thread of #1: the agent's message is the middle one, and Ada's later one follows it.
        first = self.api(ada, "POST", f"/api/v1/work/{self.ids['task1']}/discussion", {"body": "Starting on the reconnect loop.", "clientMessageId": str(uuid.uuid4()), "kind": "text"}, status=201)
        second = self.api(ada, "POST", f"/api/v1/work/{self.ids['task1']}/discussion", {"body": "Reading the modem log now.", "clientMessageId": str(uuid.uuid4()), "kind": "text"}, status=201)
        third = self.api(ada, "POST", f"/api/v1/work/{self.ids['task1']}/discussion", {"body": "Thanks, keep going.", "clientMessageId": str(uuid.uuid4()), "kind": "text"}, status=201)
        discussion = self.api(ada, "GET", f"/api/v1/work/{self.ids['task1']}/discussion", status=200)
        type(self).ids = {**self.ids, "conversation": discussion["conversationId"], "m1": first["id"], "m2": second["id"], "m3": third["id"]}
        self.assertEqual(discussion["root"]["id"], first["id"])

    def new_task(self, title: str, key: str, *, owner: dict | None = None, status: str = "open", blocker: str | None = None) -> None:
        ada = self.page("ada")
        body: dict = {"title": title, "status": "in_progress" if status == "blocked" else status}
        if owner and status != "blocked":
            body["owner"] = owner
        if owner and status == "blocked":
            body["owner"] = owner
        made = self.api(ada, "POST", f"/api/v1/projects/{self.ids['project']}/work", body, status=201)
        if status == "blocked":
            # Blocked is set after the task exists, with its blocker, as a person does it.
            made = self.api(ada, "PATCH", f"/api/v1/work/{made['id']}", {"status": "blocked", "blocker": blocker}, status=200,
                            headers={"if-match": f'"{made["version"]}"'})
        type(self).ids = {**self.ids, key: made["id"]}

    def test_01_working_needs_an_online_client(self) -> None:
        page = self.page("ada")
        self.stub_connections(page, {
            self.ids["conn_codex"]: open_session(),
            self.ids["conn_claude"]: offline(recorded_result(40)),
            self.ids["conn_lab"]: not_signed_in(),
        })
        page.goto(f"/projects/{self.ids['project']}/agents")
        expect(self.row(page, "codex")).to_contain_text("Working on #1 · Fix the reconnect loop in the lamp firmware")
        claude = self.row(page, "claude")
        expect(claude).to_contain_text("Offline · holds #3")
        self.assertNotIn("Working", claude.inner_text())
        expect(self.row(page, "lab")).to_contain_text("is waiting for it")
        expect(page.locator(".agents__count")).to_contain_text("1 working")
        # Negative control: with the same task and the client's session open, the same row says "Working on #3" and the count is 2
        # (reverting the online rule makes the offline row above say "Working", so the first assertions fail).
        online = self.page("ada")
        self.stub_connections(online, {self.ids["conn_codex"]: open_session(), self.ids["conn_claude"]: open_session()})
        online.goto(f"/projects/{self.ids['project']}/agents")
        expect(self.row(online, "claude")).to_contain_text("Working on #3")
        expect(online.locator(".agents__count")).to_contain_text("2 working")
        shot(online, "agents-tab-working-online")

    def test_02_the_agents_latest_line_is_one_glance_away(self) -> None:
        page = self.page("ada")
        self.stub_connections(page, {self.ids["conn_codex"]: open_session()})
        self.stub_thread(page, "task1", {self.ids["m2"]: {"body": "PR 42 is ready at a1b2c3d.", **self.as_agent("codex")}})
        page.goto(f"/projects/{self.ids['project']}/agents")
        self.row(page, "codex").get_by_role("button").first.click()
        card = page.get_by_role("button", name="Open the thread of #1")
        expect(card).to_contain_text("PR 42 is ready at a1b2c3d.")
        expect(card).not_to_contain_text("Thanks, keep going.")
        card.click()
        expect(page.get_by_role("region", name="#1 · Fix the reconnect loop in the lamp firmware")).to_be_visible()
        expect(page.locator("select#agents-task")).to_have_count(0)
        shot(page, "agents-tab-latest-desktop")
        # Negative control: Ada's Claude Code holds #3 and has written nothing there, so its card says so instead of another person's line.
        page.goto(f"/projects/{self.ids['project']}/agents?agent=connection:{self.ids['conn_claude']}")
        expect(page.get_by_role("button", name="Open the thread of #3")).to_contain_text("No message from it on this task yet.")
        # On the phone the Now card opens the thread as a sheet, and the sheet hides the task's hand-off button.
        phone = self.page("ada", phone=True)
        self.stub_thread(phone, "task1", {self.ids["m2"]: {"body": "PR 42 is ready at a1b2c3d.", **self.as_agent("codex")}})
        phone.goto(f"/projects/{self.ids['project']}/agents")
        self.row(phone, "codex").get_by_role("button").first.click()
        phone.get_by_role("button", name="Open the thread of #1").tap()
        expect(phone.get_by_role("region", name="#1 · Fix the reconnect loop in the lamp firmware")).to_be_visible()
        expect(phone.get_by_role("button", name="Hand off a task")).to_be_hidden()
        shot(phone, "agents-tab-latest-phone")

    def test_03_waiting_for_you_and_blocked_are_on_the_rows(self) -> None:
        ada = self.page("ada")
        question = self.question(asked=ADA["id"], text="Merge PR 42 now, or wait for the CI run?", message=self.ids["m2"], task=self.ids["task1"])
        self.stub_questions(ada, [question])
        self.stub_connections(ada, {self.ids["conn_codex"]: open_session()})
        ada.goto(f"/projects/{self.ids['project']}/agents")
        rows = ada.locator(".agents-row")
        expect(rows.first).to_have_attribute("data-agent", self.ids["codex"])
        expect(rows.first).to_contain_text("Waiting for you · asks “Merge PR 42 now, or wait")
        expect(self.row(ada, "jonas_claude")).to_contain_text("Blocked on #2 · Waiting for the probe drawing")
        expect(ada.locator(".agents__count")).to_contain_text("1 waiting for you")
        expect(ada.locator(".agents-row", has_text="Handed")).to_have_count(0)
        # Negative control: Jonas is not the person asked, so the same row does not say "Waiting for you".
        jonas = self.page("jonas")
        self.stub_questions(jonas, [question])
        self.stub_connections(jonas, {self.ids["conn_codex"]: open_session()})
        jonas.goto(f"/projects/{self.ids['project']}/agents")
        expect(self.row(jonas, "codex")).to_contain_text("Working on #1")
        self.assertNotIn("Waiting for you", self.row(jonas, "codex").inner_text())
        # Answered: the row goes back to the work it holds.
        answered = dict(question, answer={"optionIndex": 1, "text": "Wait", "by": {"id": ADA["id"], "name": ADA["name"]}, "messageId": self.ids["m2"], "at": iso(-1)})
        ada_later = self.page("ada")
        self.stub_questions(ada_later, [answered])
        self.stub_connections(ada_later, {self.ids["conn_codex"]: open_session()})
        ada_later.goto(f"/projects/{self.ids['project']}/agents")
        expect(self.row(ada_later, "codex")).to_contain_text("Working on #1")

    def test_04_requests_shows_what_waits_for_you(self) -> None:
        ada = self.page("ada")
        question = self.question(asked=ADA["id"], text="Merge PR 42 now, or wait for the CI run?", message=self.ids["m2"], task=self.ids["task1"])
        self.stub_questions(ada, [question])
        ada.goto(f"/projects/{self.ids['project']}/agents")
        requests = ada.locator(".agents-links a").first
        expect(requests).to_contain_text("Codex asks: “Merge PR 42 now")
        expect(requests.locator(".agents-link__count")).to_have_text("1")
        requests.click()
        expect(ada).to_have_url(re.compile(rf"task={self.ids['task1']}"))
        expect(ada.get_by_role("region", name="#1 · Fix the reconnect loop in the lamp firmware").locator(".qcard").first).to_be_visible()
        # Negative control: a question asked of someone else is not Jonas's request.
        jonas = self.page("jonas")
        self.stub_questions(jonas, [question])
        jonas.goto(f"/projects/{self.ids['project']}/agents")
        expect(jonas.locator(".agents-links a").first).to_contain_text("No requests for you")

    def test_05_take_back_a_held_task(self) -> None:
        ada = self.page("ada")
        ada.goto(f"/projects/{self.ids['project']}/agents")
        self.row(ada, "jonas_claude").get_by_role("button", name="Take back #2").click()
        # A teammate's agent is named by its owner in the toast (#347 N10).
        expect(ada.get_by_text("Took #2 back from Jonas’s Claude Code")).to_be_visible()
        self.assertIsNone(self.task("task2")["owner"])
        # Negative control: an agent that holds nothing (Notes) has neither Stop nor Take back.
        expect(self.row(ada, "notes")).to_be_visible()
        expect(self.row(ada, "notes").get_by_role("button", name=re.compile("^(Stop|Take back)"))).to_have_count(0)

    def test_06_rows_read_cleanly(self) -> None:
        page = self.page("ada")
        travel = {"id": str(uuid.uuid4()), "name": "Travel laptop", "clientDesignation": "claude_code", "state": "offline", "session": None,
                  "lastActivity": None, "agent": {"id": self.ids["claude"], "name": "Claude Code"}, "owner": {"id": ADA["id"], "name": ADA["name"]}, "own": True}
        self.stub_connections(page, {self.ids["conn_notes"]: {**open_session(), "lastActivity": recorded_result(30)}}, extra=[travel])
        page.goto(f"/projects/{self.ids['project']}/agents")
        expect(self.row(page, "notes")).to_contain_text("Idle · last recorded a result")
        self.assertNotIn("Session open", page.locator(".agents-list").inner_text())
        titles = page.locator(f'.agents-row[data-agent="{self.ids["claude"]}"] .agent-id__name')
        # Both connections of the agent are rows, each titled by its client and connection (the order is the list's own).
        expect(titles.filter(has_text="Claude Code · Desk laptop")).to_have_count(1)
        expect(titles.filter(has_text="Claude Code · Travel laptop")).to_have_count(1)
        shot(page, "agents-tab-rows-desktop")
        # Phone: the working row keeps its whole line in at most 112 px, and its client line is hidden.
        phone = self.page("ada", phone=True)
        self.stub_connections(phone, {self.ids["conn_codex"]: open_session()})
        phone.goto(f"/projects/{self.ids['project']}/agents")
        codex = self.row(phone, "codex")
        expect(codex).to_contain_text("Working on #1")
        box = codex.bounding_box()
        assert box
        self.assertLessEqual(box["height"], 112)
        expect(codex.locator(".agents-row__via")).to_be_hidden()
        shot(phone, "agents-tab-rows-phone")
        # Negative control: an agent with one connection keeps its own name as the title.
        expect(codex.locator(".agent-id__name")).to_have_text("Codex")

    def test_07_a_question_shows_once(self) -> None:
        page = self.page("ada")
        self.stub_thread(page, "task1", {self.ids["m2"]: {"body": "Merge PR 42 now?\n\n1. Merge now\n2. Wait", **self.as_agent("codex")}})
        question = self.question(asked=JONAS["id"], text="Merge PR 42 now?", message=self.ids["m2"], task=self.ids["task1"])
        self.stub_questions(page, [question])
        page.goto(f"/projects/{self.ids['project']}/agents?task={self.ids['task1']}")
        message = page.locator(f'[data-message-id="{self.ids["m2"]}"]')
        expect(message).to_contain_text("Merge PR 42 now?")
        text = message.inner_text()
        self.assertEqual(text.count("Merge PR 42 now?"), 1, text)
        self.assertNotIn("1. Merge now", text)
        # #347 review finding 2: a teammate who cannot answer still sees the answers offered, listed read-only in the card.
        expect(message.get_by_role("list", name="Answers offered")).to_contain_text("Merge now")
        expect(message.get_by_role("list", name="Answers offered")).to_contain_text("Wait")
        expect(message.get_by_role("button", name="Merge now")).to_have_count(0)
        # Negative control: a message without a question still shows its body.
        expect(page.locator(f'[data-message-id="{self.ids["m3"]}"]')).to_contain_text("Thanks, keep going.")

    def test_08_hand_back_is_readable_and_waits_for_the_person(self) -> None:
        # #347 review N1: the action is drawn in the toast's text colour (4.5:1 or better) and stays until it is used or dismissed.
        page = self.page("ada")
        page.goto(f"/projects/{self.ids['project']}/agents")
        self.row(page, "lab").get_by_role("button", name="Stop Lab helper").click()
        expect(page.get_by_text("Stopped Lab helper on #5")).to_be_visible()
        action = page.get_by_role("button", name="Hand back")
        expect(action).to_be_visible()
        ratio = page.evaluate(CONTRAST)
        self.assertGreaterEqual(ratio, 4.5, f"Hand back contrast is {ratio:.2f}:1 on the toast")
        # Negative control: the old 8 s timeout and the link colour (1.00:1, gone after 8 s) fail both assertions here.
        page.wait_for_timeout(9000)
        expect(action).to_be_visible()
        action.click()
        expect(page.get_by_text("Handed #5 back to Lab helper")).to_be_visible()
        self.assertEqual(self.task("task5")["owner"]["id"], self.ids["lab"])

    def test_18_the_phone_hand_back_is_a_44_px_target(self) -> None:
        # #347 review finding 1: on a phone the toast's Hand back is a touch target of at least 44 px high.
        phone = self.page("ada", phone=True)
        phone.goto(f"/projects/{self.ids['project']}/agents")
        # On a phone the row's Stop is in the agent's panel (as Take back is, test_15).
        # Claude Code holds #3 (in progress, Ada's own); earlier tests stop Codex and Lab helper.
        self.row(phone, "claude").locator(".agents-row__btn").tap()
        phone.get_by_role("complementary", name="Claude Code, details").get_by_role("button", name="Stop Claude Code").tap()
        action = phone.get_by_role("button", name="Hand back")
        expect(action).to_be_visible()
        # The toast enters with a scale transform, so the layout height is read (offsetHeight ignores transforms).
        height = action.evaluate("el => el.offsetHeight")
        self.assertGreaterEqual(height, 44, f"Hand back is {height} px high on a phone")
        # Negative control: the old padding-only action was about 33 px high, so this assertion fails without the coarse-pointer rule.

    def test_09_the_phone_thread_is_a_sheet_over_the_list_with_a_way_back_to_the_agent(self) -> None:
        # #347 review N2 and P1-2: on a phone the thread covers the Agents pane; its title and "‹" are on screen; "‹" returns to the agent.
        page = self.page("ada", phone=True)
        page.goto(f"/projects/{self.ids['project']}/agents")
        self.row(page, "codex").locator(".agents-row__btn").tap()
        page.get_by_role("button", name="Open the thread of #1").tap()
        expect(page.locator(".agents-thread-sheet")).to_be_visible()
        title = page.locator(".thread__title").bounding_box()
        back = page.get_by_role("button", name="Close thread").bounding_box()
        assert title and back
        for name, box in (("title", title), ("back", back)):
            self.assertTrue(0 <= box["y"] and box["y"] + box["height"] <= 844, f"the thread {name} is on screen: {box}")
        expect(page.get_by_role("button", name="Hand off a task")).to_be_hidden()
        page.get_by_role("button", name="Close thread").tap()
        # Negative control: the old in-flow thread put its title below the fold, and "‹" went to the list instead of the agent.
        expect(page.get_by_role("complementary", name="Codex, details")).to_be_visible()
        shot(page, "agents-tab-phone-sheet")

    def test_10_the_docked_thread_keeps_its_title_and_close_in_view(self) -> None:
        # #347 review N3: opening the thread on the computer scrolls its title into view, not out of it.
        page = self.page("ada")
        page.goto(f"/projects/{self.ids['project']}/agents")
        self.row(page, "codex").locator(".agents-row__btn").click()
        page.get_by_role("button", name="Open the thread of #1").click()
        expect(page.get_by_role("region", name="#1 · Fix the reconnect loop in the lamp firmware")).to_be_visible()
        title = page.locator(".thread__title").bounding_box()
        close = page.get_by_role("button", name="Close thread").bounding_box()
        pane = page.locator(".agents-scroll").bounding_box()
        assert title and close and pane
        for name, box in (("title", title), ("close", close)):
            self.assertTrue(0 <= box["y"] and box["y"] + box["height"] <= 900, f"the thread {name} is in the window: {box}")
            self.assertGreaterEqual(box["y"], pane["y"] - 1, f"the thread {name} is in the pane's visible area, not under its header: {box} pane {pane}")
        # Negative control: the old shared scroll moved the pane to the thread's end, so the title sat above the pane's top.

    def test_11_stop_keeps_the_panel_and_focus_on_the_stopped_agent(self) -> None:
        # #347 review N4: Stop does not move the panel to another agent or the focus to its heading.
        page = self.page("ada")
        self.stub_connections(page, {self.ids["conn_codex"]: open_session()})
        page.goto(f"/projects/{self.ids['project']}/agents")
        detail = page.get_by_role("complementary", name="Codex, details")
        expect(detail).to_be_visible()
        detail.get_by_role("button", name="Stop Codex").click()
        expect(page.get_by_text("Stopped Codex on #1")).to_be_visible()
        expect(page.get_by_role("complementary", name="Codex, details")).to_be_visible()
        focused = page.evaluate("() => document.activeElement && document.activeElement.classList.contains('agents-detail__name') ? document.activeElement.textContent : ''")
        self.assertIn("Codex", focused, "focus stays on the stopped agent")
        # Negative control: the old list re-sort moved the panel to Jonas's or Lab's agent and its heading took focus.
        page.get_by_role("button", name="Hand back").click()
        expect(page.get_by_text("Handed #1 back to Codex")).to_be_visible()

    def test_12_the_panel_note_says_what_the_row_says(self) -> None:
        # #347 review N5: a blocked or waiting agent reads the same state words in its panel as in its row.
        page = self.page("ada")
        self.stub_questions(page, [self.question(asked=ADA["id"], text="Merge PR 42 now, or wait?", message=self.ids["m2"], task=self.ids["task1"])])
        page.goto(f"/projects/{self.ids['project']}/agents?agent=connection:{self.ids['conn_codex']}")
        panel = page.get_by_role("complementary", name="Codex, details")
        expect(panel.get_by_role("region", name="Now")).to_contain_text("Waiting for your answer")
        expect(panel.get_by_role("region", name="Now")).to_contain_text("Asks: “Merge PR 42 now, or wait?”")
        # Jonas's agent holds #2 again, blocked: the task is set back the way a person sets it.
        ada = self.page("ada")
        current = self.task("task2")
        self.api(ada, "PATCH", f"/api/v1/work/{self.ids['task2']}", {"owner": {"kind": "agent", "id": self.ids["jonas_claude"]}, "status": "blocked",
                 "blocker": "Waiting for the probe drawing"}, status=200, headers={"if-match": f'"{current["version"]}"'})
        page.goto(f"/projects/{self.ids['project']}/agents?agent=connection:{self.ids['conn_jonas_claude']}")
        expect(page.get_by_role("complementary", name="Claude Code, details").get_by_role("region", name="Now")).to_contain_text("Blocked · Waiting for the probe drawing")
        # Negative control: the old panel said "Handed to it, not started" for the blocked agent and "In progress" for the waiting one.

    def test_13_the_now_card_describes_its_latest_line(self) -> None:
        # #347 review N14: the Now card's name is the task; its latest line is its description, so a screen reader hears what the agent said.
        page = self.page("ada")
        self.stub_thread(page, "task1", {self.ids["m2"]: {"body": "PR 42 is ready at a1b2c3d.", **self.as_agent("codex")}})
        page.goto(f"/projects/{self.ids['project']}/agents?agent=connection:{self.ids['conn_codex']}")
        card = page.get_by_role("button", name="Open the thread of #1")
        describedby = card.get_attribute("aria-describedby")
        assert describedby
        expect(page.locator(f"[id='{describedby}']")).to_contain_text("PR 42 is ready at a1b2c3d.")
        # Negative control: without aria-describedby the line is not announced with the card.

    def test_14_a_keyboard_thread_opens_with_focus_in_it(self) -> None:
        # #347 review N8: Enter on the Now card moves focus into the thread, not to the page body.
        page = self.page("ada")
        page.goto(f"/projects/{self.ids['project']}/agents?agent=connection:{self.ids['conn_codex']}")
        card = page.get_by_role("button", name="Open the thread of #1")
        card.focus()
        page.keyboard.press("Enter")
        expect(page.get_by_role("region", name="#1 · Fix the reconnect loop in the lamp firmware")).to_be_visible()
        inside = page.evaluate("() => !!(document.activeElement && document.activeElement.closest('.thread'))")
        self.assertTrue(inside, "focus is in the thread")
        # Negative control: focus fell to the page body after Enter (the old unmount).

    def test_15_on_a_phone_take_back_waits_in_the_panel(self) -> None:
        # #347 review N7: a row's Take back does not crowd a phone row; the agent's panel offers it.
        ada = self.page("ada")
        notes = self.api(ada, "POST", f"/api/v1/projects/{self.ids['project']}/work", {"title": "Sort the seed packets", "owner": {"kind": "agent", "id": self.ids["notes"]}}, status=201)
        phone = self.page("ada", phone=True)
        phone.goto(f"/projects/{self.ids['project']}/agents")
        row = self.row(phone, "notes")
        # Wait for the row to hold the new task first: a count of 0 before the read would pass trivially.
        expect(row).to_contain_text(f"#{notes['number']}")
        # A hidden control is not in the accessibility tree, so the row's Take back is found by its class and checked as hidden.
        take = row.locator(".agents-row__stop--take")
        self.assertEqual(take.count(), 1, "the row has the Take back control")
        self.assertEqual(take.get_attribute("aria-label"), f"Take back #{notes['number']}")
        expect(take).to_be_hidden()
        row.locator(".agents-row__btn").tap()
        expect(phone.get_by_role("complementary", name="Notes, details").get_by_role("button", name=f"Take back #{notes['number']}")).to_be_visible()
        # Negative control: the old row showed the Take back pill, visible on the phone, so the hidden check fails.

    def test_16_the_row_and_panel_say_stopped_by_you(self) -> None:
        # #347 review N9: after your own Stop the panel reads "Stopped by you", not your name.
        page = self.page("ada")
        page.goto(f"/projects/{self.ids['project']}/agents")
        page.goto(f"/projects/{self.ids['project']}/agents?agent=connection:{self.ids['conn_lab']}")
        expect(page.get_by_role("complementary", name="Lab helper, details").get_by_role("region", name="Recent")).to_contain_text("Stopped by you · #5")
        # Negative control: the old panel read "Stopped by Ada Kowalska · #5".

    def test_17_the_sidebar_card_is_asleep_when_its_agent_is_offline(self) -> None:
        # #347 review N12: the card's face shows the agent's state: asleep without an open session.
        page = self.page("ada")
        page.goto("/")
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        # Only the first working agent is drawn in the card; this fixture's working agent is Ada's Claude Code (#3, no session).
        card = page.locator(".agentlive--agent").first
        expect(card).to_contain_text("holds #3 · not signed in yet")
        expect(card.locator("[data-expression]").first).to_have_attribute("data-expression", "asleep")
        # Negative control: the old card kept the thinking face for an offline holder.


CONTRAST = """() => {
  const parse = (c) => c.match(/[\\d.]+/g).slice(0, 3).map(Number);
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const button = document.querySelector('.ui-toast__action');
  const toast = button.closest('.ui-toast');
  const a = lum(parse(getComputedStyle(button).color)), b = lum(parse(getComputedStyle(toast).backgroundColor));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}"""


if __name__ == "__main__":
    unittest.main()
