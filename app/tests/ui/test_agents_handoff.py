"""Browser tests for handing a task to an agent in two steps and the Agents view as one list (F-026 P9, S12; #347).

Ada manages a project with Jonas. Three agents exist: "Claude Code agent" (can write here, one connection, one task in
progress), "Reader agent" (can only read here) and "Outside agent" (no access to the project). Hand-off is the task's owner
and grants nothing: an agent without write access is explained and never given access from the dialog.
"""

from __future__ import annotations

import json
import re
import time
import unittest

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

PASSWORD = "two steps then it is theirs"
STAMP = int(time.time() * 1000)
ADA = {"name": "Ada Kowalska", "email": f"ada.handoff+{STAMP}@example.test"}
JONAS = {"name": "Jonas Berg", "email": f"jonas.handoff+{STAMP}@example.test"}


class HandOffJourney(unittest.TestCase):
    """Tests run in name order and share two accounts, one project, three agents and four tasks."""

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

    def context(self, who: str | None, *, phone: bool = False, scheme: str = "light", width: int | None = None) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "color_scheme": scheme, "locale": "en-GB", "timezone_id": "Europe/Warsaw", "service_workers": "block"}
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        elif width:
            options.update(viewport={"width": width, "height": 900}, device_scale_factor=1)
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

    def open_agents(self, **kwargs) -> Page:
        page = self.page("ada", **kwargs)
        page.goto(f"/projects/{self.ids['project']}/agents")
        expect(page.get_by_role("heading", level=1, name="Agents")).to_be_visible()
        return page

    def task(self, key: str) -> dict:
        return self.api(self.page("ada"), "GET", f"/api/v1/work/{self.ids[key]}", status=200)

    def test_01_a_project_with_three_agents_and_four_tasks(self) -> None:
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
        agents = {}
        for key, name in (("claude", "Claude Code agent"), ("reader", "Reader agent"), ("outside", "Outside agent")):
            agents[key] = self.api(ada, "POST", f"/api/v1/workspaces/{ws['id']}/agents", {"name": name, "owner": "self"}, status=201)["id"]
        self.api(ada, "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "agent", "id": agents["claude"]}, "role": "contributor"}, status=201)
        self.api(ada, "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "agent", "id": agents["reader"]}, "role": "viewer"}, status=201)
        self.api(ada, "POST", "/api/v1/agent-connections", {"agentId": agents["claude"], "selectedProjectIds": [pid],
                 "scopes": ["flux.context.read", "flux.proposal.write"], "name": "Desk laptop", "clientDesignation": "claude_code"}, status=201)
        busy = self.api(ada, "POST", f"/api/v1/projects/{pid}/work", {"title": "Calibrate the probes at two soil depths", "status": "in_progress",
                        "owner": {"kind": "agent", "id": agents["claude"]}}, status=201)
        ids = {"workspace": ws["id"], "project": pid, "busy": busy["id"], **{f"agent_{k}": v for k, v in agents.items()}}
        for key, title in (("label", "Print a label for each of the six beds"), ("drag", "Ask the supplier for the probe drawing"),
                           ("details", "Photograph the north bed"), ("keys", "Order spare batteries")):
            ids[key] = self.api(ada, "POST", f"/api/v1/projects/{pid}/work", {"title": title}, status=201)["id"]
        type(self).ids = ids

    def test_02_agents_is_one_list_with_one_primary_button(self) -> None:
        for scheme in ("light", "dark"):
            page = self.open_agents(scheme=scheme)
            rows = page.get_by_role("list", name="Agents in this project").get_by_role("listitem")
            expect(rows).to_have_count(2)
            claude = rows.filter(has_text="Claude Code agent")
            expect(claude).to_contain_text("for Ada Kowalska (you)")
            expect(claude).to_contain_text("Desk laptop")
            # No client session is open here, so the held task is not "working" (#347 P1-1).
            expect(claude).to_contain_text("Not signed in yet · #1 is waiting for it")
            expect(rows.filter(has_text="Reader agent")).to_contain_text("nothing handed to it")
            expect(page.get_by_text("2 in this project")).to_be_visible()
            # Requests, Policy and "Connect your own agent": one row each, below the list.
            expect(page.get_by_role("link", name=re.compile("^Requests"))).to_have_attribute("href", "/inbox")
            expect(page.get_by_role("button", name=re.compile("^Project policy"))).to_be_visible()
            expect(page.get_by_role("link", name=re.compile("^Connect your own agent"))).to_have_attribute("href", "/connect-agent")
            expect(page.get_by_role("button", name="Hand off a task")).to_have_count(1)
            self.assertEqual(page.locator(".agents .ui-btn--primary").count(), 1, "exactly one primary button")
            # No connection dots, terminal icons or the old "Working together" heading.
            expect(page.get_by_text("Working together")).to_have_count(0)
            expect(page.locator(".agents-conn")).to_have_count(0)
            shot(page, f"handoff-agents-desktop-{scheme}")

    def test_03_policy_opens_from_its_row(self) -> None:
        page = self.open_agents()
        row = page.get_by_role("button", name=re.compile("^Project policy"))
        expect(row).to_have_attribute("aria-expanded", "false")
        row.click()
        expect(page.get_by_role("region", name="Agent policy")).to_be_visible()
        expect(row).to_have_attribute("aria-expanded", "true")
        row.click()
        expect(page.get_by_role("region", name="Agent policy")).to_have_count(0)

    def test_04_the_detail_panel_opens_on_the_working_agent(self) -> None:
        page = self.open_agents()
        detail = page.get_by_role("complementary", name="Claude Code agent, details")
        expect(detail).to_be_visible()
        claude = page.locator(f'.agents-row[data-agent="{self.ids["agent_claude"]}"] .agents-row__btn')
        expect(claude).to_have_attribute("aria-pressed", "true")
        expect(detail).to_contain_text("for Ada Kowalska (you)")
        expect(detail.get_by_role("region", name="Now")).to_contain_text("Calibrate the probes at two soil depths")
        expect(detail.get_by_role("region", name="Can")).to_contain_text("It can’t accept decisions")
        expect(detail.get_by_role("region", name="Recent")).to_be_visible()
        # Stop (S13) is on the working agent's row and in its panel, for its owner; test_agent_stop_questions exercises it.
        expect(detail.get_by_role("button", name="Stop Claude Code agent")).to_be_visible()
        expect(page.get_by_role("button", name="Stop Reader agent")).to_have_count(0)
        shot(page, "handoff-agents-detail-desktop")
        page.locator(f'.agents-row[data-agent="{self.ids["agent_reader"]}"] .agents-row__btn').click()
        expect(page.get_by_role("complementary", name="Reader agent, details")).to_be_visible()
        expect(page).to_have_url(re.compile(r"agent=connection|agent=agent"))
        page.locator(f'.agents-row[data-agent="{self.ids["agent_claude"]}"] .agents-row__btn').click()
        # The agent's task opens its thread under the list.
        page.get_by_role("complementary", name="Claude Code agent, details").get_by_role("button", name=re.compile("^Open the thread of #")).click()
        expect(page.get_by_role("region", name="Thread of Calibrate the probes at two soil depths")).to_be_visible()
        expect(page.locator("select#agents-task")).to_have_count(0)

    def test_05_two_steps_choose_the_agent_then_see_what_it_may_do(self) -> None:
        page = self.open_agents()
        page.get_by_role("button", name="Hand off a task").click()
        dialog = page.get_by_role("dialog", name="Hand off a task")
        expect(dialog.get_by_text("Step 1 of 2")).to_be_visible()
        expect(dialog.get_by_role("heading", name="Who should do it?")).to_be_visible()
        expect(dialog.get_by_role("radio")).to_have_count(3)
        # Nothing is chosen yet, so there is no way forward.
        expect(dialog.get_by_role("button", name="Next")).to_be_disabled()
        dialog.get_by_label("Task", exact=True).select_option(label="#2 · Print a label for each of the six beds")
        # Keyboard: the radio group takes arrows; Enter moves on.
        dialog.get_by_role("radio").first.focus()
        page.keyboard.press("ArrowDown")
        page.keyboard.press("ArrowUp")
        expect(dialog.get_by_role("radio", name=re.compile("Claude Code agent"))).to_be_checked()
        shot(page, "handoff-step1-desktop")
        page.keyboard.press("Enter")
        expect(dialog.get_by_text("Step 2 of 2")).to_be_visible()
        expect(dialog.get_by_role("heading", name="What Claude Code agent may do")).to_be_visible()
        expect(dialog).to_contain_text("Claude Code agent will be able to read this project and write in it")
        expect(dialog).to_contain_text("It holds #1 · not signed in yet")
        shot(page, "handoff-step2-desktop")
        dialog.get_by_role("button", name="Back").click()
        expect(dialog.get_by_text("Step 1 of 2")).to_be_visible()
        dialog.get_by_role("button", name="Next").click()
        # Nothing has changed until the second step is confirmed.
        self.assertIsNone(self.task("label")["owner"])
        dialog.get_by_role("button", name=re.compile("^Hand off")).click()
        expect(page.get_by_role("dialog")).to_have_count(0)
        expect(page.get_by_text("Handed #2 to Claude Code agent")).to_be_visible()
        owner = self.task("label")["owner"]
        self.assertEqual(owner["id"], self.ids["agent_claude"])
        row = page.get_by_role("list", name="Agents in this project").get_by_role("listitem").filter(has_text="Claude Code agent")
        expect(row).to_contain_text("Not signed in yet · #1 is waiting for it")

    def test_06_an_agent_without_write_access_is_explained_and_never_granted(self) -> None:
        page = self.open_agents()
        grants_before = self.api(page, "GET", f"/api/v1/projects/{self.ids['project']}/grants", status=200)
        page.get_by_role("button", name="Hand off a task").click()
        dialog = page.get_by_role("dialog", name="Hand off a task")
        dialog.get_by_label("Task", exact=True).select_option(label="#3 · Ask the supplier for the probe drawing")
        for name, note in (("Outside agent", "has no access to Garden sensors"), ("Reader agent", "can only read Garden sensors")):
            dialog.locator("label.handoff__agent", has_text=name).click()
            dialog.get_by_role("button", name="Next").click()
            expect(dialog).to_contain_text(note)
            expect(dialog).to_contain_text("Nothing is granted from here")
            expect(dialog.get_by_role("link", name="Connect an agent")).to_have_attribute("href", "/connect-agent")
            expect(dialog.get_by_role("button", name=re.compile("^Hand off"))).to_be_disabled()
            dialog.get_by_role("button", name="Back").click()
        self.assertIsNone(self.task("drag")["owner"])
        self.assertEqual(self.api(page, "GET", f"/api/v1/projects/{self.ids['project']}/grants", status=200), grants_before, "no access was granted")

    def test_07_a_task_dragged_onto_an_agent_opens_the_second_step(self) -> None:
        page = self.open_agents()
        row = page.locator(f'.agents-row[data-agent="{self.ids["agent_claude"]}"]')
        task = page.locator(f'.agents-drag__task[data-task-id="{self.ids["drag"]}"]')
        expect(page.get_by_text("Drag a task onto an agent to hand it off")).to_be_visible()
        task.drag_to(row)
        dialog = page.get_by_role("dialog", name="Hand off a task")
        expect(dialog.get_by_text("Step 2 of 2")).to_be_visible()
        expect(dialog).to_contain_text("Hand off #3 · Ask the supplier for the probe drawing")
        expect(dialog).to_contain_text("Claude Code agent will be able to")
        dialog.get_by_role("button", name=re.compile("^Hand off")).click()
        expect(page.get_by_role("dialog")).to_have_count(0)
        self.assertEqual(self.task("drag")["owner"]["id"], self.ids["agent_claude"])
        # Dropping on an agent that cannot take it only explains why.
        page.locator(f'.agents-drag__task[data-task-id="{self.ids["details"]}"]').drag_to(page.locator(f'.agents-row[data-agent="{self.ids["agent_reader"]}"]'))
        expect(page.get_by_role("dialog")).to_contain_text("can only read Garden sensors")
        page.keyboard.press("Escape")
        self.assertIsNone(self.task("details")["owner"])

    def test_08_the_task_details_hand_off_the_same_way(self) -> None:
        page = self.page("ada")
        page.goto(f"/projects/{self.ids['project']}/tasks?open=work:{self.ids['details']}")
        page.get_by_role("button", name="Hand off to an agent").click()
        dialog = page.get_by_role("dialog", name="Hand off a task")
        expect(dialog).to_contain_text("Hand off #4 · Photograph the north bed")
        expect(dialog.get_by_label("Task", exact=True)).to_have_count(0)
        dialog.locator("label.handoff__agent", has_text="Claude Code agent").click()
        dialog.get_by_role("button", name="Next").click()
        page.keyboard.press("Control+Enter")
        expect(page.get_by_role("dialog", name="Hand off a task")).to_have_count(0)
        self.assertEqual(self.task("details")["owner"]["id"], self.ids["agent_claude"])

    def test_09_phone_two_steps_with_touch_in_light_and_dark(self) -> None:
        for scheme in ("light", "dark"):
            page = self.open_agents(phone=True, scheme=scheme)
            overflow = page.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
            self.assertLessEqual(overflow, 0, "no horizontal page scroll at 390px")
            button = page.get_by_role("button", name="Hand off a task")
            box = button.bounding_box()
            assert box
            self.assertGreaterEqual(box["height"], 44, "a touch target of at least 44px")
            shot(page, f"handoff-agents-phone-{scheme}")
            # An agent opens as its own page and goes back to the list.
            page.get_by_role("button", name=re.compile("Reader agent")).tap()
            detail = page.get_by_role("complementary", name="Reader agent, details")
            expect(detail).to_be_visible()
            expect(page.get_by_role("list", name="Agents in this project")).to_be_hidden()
            shot(page, f"handoff-agent-phone-{scheme}")
            detail.get_by_role("button", name="Agents").tap()
            expect(page.get_by_role("list", name="Agents in this project")).to_be_visible()
            button.tap()
            dialog = page.get_by_role("dialog", name="Hand off a task")
            expect(dialog.get_by_text("Step 1 of 2")).to_be_visible()
            dialog.get_by_label("Task", exact=True).select_option(label="#5 · Order spare batteries")
            dialog.locator("label.handoff__agent", has_text="Claude Code agent").tap()
            for name in ("Next",):
                target = dialog.get_by_role("button", name=name).bounding_box()
                assert target
                self.assertGreaterEqual(target["height"], 44)
            shot(page, f"handoff-step1-phone-{scheme}")
            dialog.get_by_role("button", name="Next").tap()
            expect(dialog.get_by_text("Step 2 of 2")).to_be_visible()
            shot(page, f"handoff-step2-phone-{scheme}")
            page.keyboard.press("Escape")
            expect(page.get_by_role("dialog")).to_have_count(0)
        self.assertIsNone(self.task("keys")["owner"], "closing hands nothing off")

    def test_10_an_agents_task_opens_its_thread_from_the_panel_at_every_width(self) -> None:
        title = "Calibrate the probes at two soil depths"
        for label, kwargs in (("phone-390", {"phone": True}), ("tablet-820", {"width": 820})):
            page = self.open_agents(**kwargs)
            touch = bool(kwargs.get("phone"))
            row = page.locator(f'.agents-row[data-agent="{self.ids["agent_claude"]}"] .agents-row__btn')
            (row.tap if touch else row.click)()
            detail = page.get_by_role("complementary", name="Claude Code agent, details")
            expect(detail).to_be_visible()
            link = detail.get_by_role("region", name="Now").get_by_role("button", name=re.compile("^Open the thread of #"))
            (link.tap if touch else link.click)()
            # The panel is left: the exact thread with its composer is on screen, not hidden behind the panel.
            thread = page.get_by_role("region", name=f"Thread of {title}")
            expect(thread).to_be_visible()
            expect(page.get_by_label("Write to this task")).to_be_visible()
            expect(detail).to_have_count(0)
            expect(page).to_have_url(re.compile(f"task={self.ids['busy']}"))
            shot(page, f"handoff-thread-from-panel-{label}")
            # Back returns to the agent's panel; forward to the thread.
            page.go_back()
            expect(detail).to_be_visible()
            page.go_forward()
            expect(thread).to_be_visible()
        # Where the panel sits beside the list both stay on screen.
        wide = self.open_agents()
        wide.get_by_role("complementary", name="Claude Code agent, details").get_by_role("button", name=re.compile("^Open the thread of #")).click()
        expect(wide.get_by_role("region", name=f"Thread of {title}")).to_be_visible()
        # The thread takes the right column in place of the panel; closing it returns to the panel (#347 P1-2).
        expect(wide.get_by_role("complementary", name="Claude Code agent, details")).to_have_count(0)
        wide.get_by_role("button", name="Close thread").click()
        expect(wide.get_by_role("complementary", name="Claude Code agent, details")).to_be_visible()

    def test_11_the_agent_panel_asks_for_a_task_before_confirmation(self) -> None:
        page = self.open_agents()
        grants_before = self.api(page, "GET", f"/api/v1/projects/{self.ids['project']}/grants", status=200)
        page.get_by_role("complementary", name="Claude Code agent, details").get_by_role("button", name="Hand off to Claude Code agent").click()
        dialog = page.get_by_role("dialog", name="Hand off a task")
        # No task is known yet, so this is step 1 with the agent already chosen, never an empty confirmation.
        expect(dialog.get_by_text("Step 1 of 2")).to_be_visible()
        expect(dialog.get_by_role("radio", name=re.compile("Claude Code agent"))).to_be_checked()
        expect(dialog.get_by_role("button", name="Next")).to_be_disabled()
        dialog.get_by_label("Task", exact=True).select_option(label="#5 · Order spare batteries")
        dialog.get_by_role("button", name="Next").click()
        expect(dialog.get_by_text("Step 2 of 2")).to_be_visible()
        expect(dialog.get_by_role("button", name=re.compile("^Hand off"))).to_be_enabled()
        dialog.get_by_role("button", name=re.compile("^Hand off")).click()
        expect(page.get_by_role("dialog")).to_have_count(0)
        self.assertEqual(self.task("keys")["owner"]["id"], self.ids["agent_claude"])
        self.assertEqual(self.api(page, "GET", f"/api/v1/projects/{self.ids['project']}/grants", status=200), grants_before, "permissions are unchanged")

    def test_13_a_teammates_agent_is_asked_not_assigned(self) -> None:
        # #347 P1-3: a task is not handed to another person's agent; Flux asks its owner in the task's thread.
        # Negative control (second half): the agent Ada owns still gets the task handed to it, owner changed.
        ada, jonas = self.page("ada"), self.page("jonas")
        pid, ws = self.ids["project"], self.ids["workspace"]
        jonas_agent = self.api(jonas, "POST", f"/api/v1/workspaces/{ws}/agents", {"name": "Claude Code", "owner": "self"}, status=201)["id"]
        self.api(ada, "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "agent", "id": jonas_agent}, "role": "contributor"}, status=201)
        ask = self.api(ada, "POST", f"/api/v1/projects/{pid}/work", {"title": "Print a label for each of the six beds"}, status=201)
        page = self.open_agents()
        page.get_by_role("button", name="Hand off a task").click()
        dialog = page.get_by_role("dialog", name="Hand off a task")
        dialog.get_by_label("Task", exact=True).select_option(label=f"#{ask['number']} · Print a label for each of the six beds")
        dialog.locator("label.handoff__agent", has_text="Claude Code").filter(has_text="Jonas Berg").click()
        expect(dialog).to_contain_text("for Jonas Berg · Jonas decides")
        dialog.get_by_role("button", name="Next").click()
        expect(dialog.get_by_role("heading", name="Ask Jonas first")).to_be_visible()
        expect(dialog).to_contain_text("Only Jonas can hand work to it")
        expect(dialog.get_by_role("button", name="Ask Jonas")).to_be_visible()
        expect(dialog.get_by_role("button", name=re.compile("^Hand off"))).to_have_count(0)
        dialog.get_by_role("button", name="Ask Jonas").click()
        expect(page.get_by_text(f"Asked Jonas about #{ask['number']}")).to_be_visible()
        self.assertIsNone(self.task_by_id(ask["id"])["owner"], "the task's owner does not change")
        discussion = self.api(ada, "GET", f"/api/v1/work/{ask['id']}/discussion", status=200)
        newest = sorted([discussion["root"] or {}, *discussion["messages"]], key=lambda m: m.get("sequence", 0))[-1]
        self.assertTrue(newest["body"].startswith(f"@Jonas Berg can your Claude Code take #{ask['number']}"), newest["body"])
        # Negative control: Ada's own agent is handed the task, and the owner becomes that agent.
        fresh = self.api(ada, "POST", f"/api/v1/projects/{pid}/work", {"title": "Measure the greenhouse humidity"}, status=201)
        page = self.open_agents()
        page.get_by_role("button", name="Hand off a task").click()
        dialog = page.get_by_role("dialog", name="Hand off a task")
        dialog.get_by_label("Task", exact=True).select_option(label=f"#{fresh['number']} · Measure the greenhouse humidity")
        dialog.locator("label.handoff__agent", has_text="Claude Code agent").click()
        dialog.get_by_role("button", name="Next").click()
        expect(dialog.get_by_role("button", name=re.compile("^Hand off"))).to_be_visible()
        dialog.get_by_role("button", name=re.compile("^Hand off")).click()
        expect(page.get_by_text(f"Handed #{fresh['number']} to Claude Code agent")).to_be_visible()
        self.assertEqual(self.task_by_id(fresh["id"])["owner"]["id"], self.ids["agent_claude"])

    def task_by_id(self, task_id: str) -> dict:
        return self.api(self.page("ada"), "GET", f"/api/v1/work/{task_id}", status=200)

    def test_14_asking_a_teammate_says_how_to_say_yes_and_load_lines_name_the_sign_in(self) -> None:
        # #347 review N6 and N11: the asked message says what a yes does; a never-signed-in agent reads "not signed in yet", not "offline".
        ada, jonas = self.page("ada"), self.page("jonas")
        pid, ws = self.ids["project"], self.ids["workspace"]
        jonas_agent = self.api(jonas, "POST", f"/api/v1/workspaces/{ws}/agents", {"name": "Claude Code", "owner": "self"}, status=201)["id"]
        self.api(ada, "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "agent", "id": jonas_agent}, "role": "contributor"}, status=201)
        ask = self.api(ada, "POST", f"/api/v1/projects/{pid}/work", {"title": "Label the compost bins"}, status=201)
        page = self.open_agents()
        page.get_by_role("button", name="Hand off a task").click()
        dialog = page.get_by_role("dialog", name="Hand off a task")
        dialog.get_by_label("Task", exact=True).select_option(label=f"#{ask['number']} · Label the compost bins")
        # Ada's Claude Code holds #1 in progress and has never signed in: the load line says so (negative control: "holds #1 · offline").
        expect(dialog.locator("label.handoff__agent", has_text="Claude Code agent")).to_contain_text("holds #1 · not signed in yet")
        dialog.locator("label.handoff__agent", has_text="Claude Code").filter(has_text="Jonas Berg").first.click()
        dialog.get_by_role("button", name="Next").click()
        dialog.get_by_role("button", name="Ask Jonas").click()
        expect(page.get_by_text(f"Asked Jonas about #{ask['number']}")).to_be_visible()
        discussion = self.api(ada, "GET", f"/api/v1/work/{ask['id']}/discussion", status=200)
        newest = sorted([discussion["root"] or {}, *discussion["messages"]], key=lambda m: m.get("sequence", 0))[-1]
        # Negative control: the old message ended at the question mark, so Jonas was not told a yes hands the task over.
        self.assertTrue(newest["body"].endswith(f"? If yes, hand #{ask['number']} to it in Agents."), newest["body"])

    def seed_paged_project(self, page: Page, free_first: bool) -> tuple[str, str]:
        """A project with 55 tasks owned by an agent and one free task, created in the given order."""
        project = self.api(page, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/projects", {"name": f"Paged {int(time.time() * 1000) % 100000}", "visibility": "restricted"}, status=201)["id"]
        self.api(page, "POST", f"/api/v1/projects/{project}/grants", {"principal": {"kind": "agent", "id": self.ids["agent_claude"]}, "role": "contributor"}, status=201)
        owner = {"kind": "agent", "id": self.ids["agent_claude"]}
        free = None
        if free_first:
            free = self.api(page, "POST", f"/api/v1/projects/{project}/work", {"title": "The one free task"}, status=201)["id"]
        for number in range(55):
            self.api(page, "POST", f"/api/v1/projects/{project}/work", {"title": f"Owned task {number}", "owner": owner}, status=201)
        if free is None:
            free = self.api(page, "POST", f"/api/v1/projects/{project}/work", {"title": "The one free task"}, status=201)["id"]
        return project, free

    def test_12_a_free_task_beyond_the_first_page_is_reachable(self) -> None:
        page = self.page("ada")
        for free_first in (True, False):
            project, free = self.seed_paged_project(page, free_first)
            first = self.api(page, "GET", f"/api/v1/projects/{project}/work-view?purpose=choices&choice=pivot_work&limit=50", status=200)
            if free not in [row["id"] for row in first["items"]]:
                break
        else:
            self.fail("neither creation order put the free task beyond the first page")
        self.assertTrue(first["nextCursor"], "the choices are paged")
        view = self.page("ada")
        reads: list[str] = []
        view.on("request", lambda request: reads.append(request.url) if "/work-view" in request.url and "cursor=" in request.url else None)
        view.goto(f"/projects/{project}/agents")
        expect(view.get_by_role("heading", level=1, name="Agents")).to_be_visible()
        view.get_by_role("button", name="Hand off a task").click()
        dialog = view.get_by_role("dialog", name="Hand off a task")
        expect(dialog.get_by_text("No open task without an agent")).to_have_count(0)
        select = dialog.get_by_label("Task", exact=True)
        expect(select.locator("option", has_text="The one free task")).to_have_count(1)
        self.assertTrue(reads, "the next bounded page was read")
        select.select_option(label=next(o for o in select.locator("option").all_inner_texts() if "The one free task" in o))
        dialog.locator("label.handoff__agent", has_text="Claude Code agent").click()
        dialog.get_by_role("button", name="Next").click()
        dialog.get_by_role("button", name=re.compile("^Hand off")).click()
        expect(view.get_by_role("dialog")).to_have_count(0)
        owner = self.api(view, "GET", f"/api/v1/work/{free}", status=200)["owner"]
        self.assertEqual(owner["id"], self.ids["agent_claude"])


if __name__ == "__main__":
    unittest.main()
