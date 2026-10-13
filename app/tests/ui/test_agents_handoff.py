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
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, shot as save_shot, start_forwarder

PASSWORD = "two steps then it is theirs"
STAMP = int(time.time() * 1000)
ADA = {"name": "Ada Kowalska", "email": f"ada.handoff+{STAMP}@example.test"}
JONAS = {"name": "Jonas Berg", "email": f"jonas.handoff+{STAMP}@example.test"}


def shot(page: Page, name: str) -> None:
    save_shot(page, name if UI_BROWSER == "chromium" else f"{name}-{UI_BROWSER}")


def assert_phone_sheet(dialog, page) -> None:
    metrics = dialog.evaluate("""el => { const rect = el.getBoundingClientRect(); return {top: rect.top, radius: parseFloat(getComputedStyle(el).borderTopLeftRadius)}; }""")
    if metrics["top"] <= 80 or metrics["radius"] <= 20:
        raise AssertionError(f"phone hand-off sheet should leave the project visible above rounded corners: {metrics}")
    expect(page.get_by_role("heading", level=1, name="Agents")).to_be_visible()


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
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        if cls.browser.browser_type.name != UI_BROWSER:
            raise AssertionError(f"Expected {UI_BROWSER}, launched {cls.browser.browser_type.name}")
        print(f"\n  Hand-off browser: {cls.browser.browser_type.name}")
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
            expect(claude).to_contain_text("Handed #1 · Calibrate the probes at two soil depths")
            expect(claude).to_contain_text("Not signed in from your client yet")
            expect(claude).not_to_have_attribute("data-working", "true")
            expect(rows.filter(has_text="Reader agent")).to_contain_text("nothing handed to it")
            expect(page.get_by_text("2 in this project", exact=True)).to_be_visible()
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
        expect(row).to_contain_text("Agents read and propose; people accept. Assistants also edit for their owner, with Undo.")
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
        page.get_by_role("complementary", name="Claude Code agent, details").get_by_role("button", name="Calibrate the probes at two soil depths").click()
        expect(page.get_by_role("region", name="Thread of Calibrate the probes at two soil depths")).to_be_visible()
        expect(page.get_by_label("Task", exact=True)).to_have_value(self.ids["busy"])

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
        expect(dialog).to_contain_text("has #1")
        expect(dialog.get_by_text(re.compile("queued behind|working on", re.IGNORECASE))).to_have_count(0)
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
        expect(row).to_contain_text("Handed #1")

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
            assert_phone_sheet(dialog, page)
            dialog.get_by_label("Task", exact=True).select_option(label="#5 · Order spare batteries")
            dialog.locator("label.handoff__agent", has_text="Claude Code agent").tap()
            for name in ("Next",):
                target = dialog.get_by_role("button", name=name).bounding_box()
                assert target
                self.assertGreaterEqual(target["height"], 44)
            shot(page, f"handoff-step1-phone-{scheme}")
            dialog.get_by_role("button", name="Next").tap()
            expect(dialog.get_by_text("Step 2 of 2")).to_be_visible()
            assert_phone_sheet(dialog, page)
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
            link = detail.get_by_role("region", name="Now").get_by_role("button", name=title)
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
            # Recent uses the same deliberate panel-to-thread step and returns to the same agent.
            page.go_back()
            recent_title = "Print a label for each of the six beds"
            recent = detail.get_by_role("region", name="Recent").get_by_role("button", name=re.compile(f"Also holds #2 · {recent_title}"))
            (recent.tap if touch else recent.click)()
            recent_thread = page.get_by_role("region", name=f"Thread of {recent_title}")
            expect(recent_thread).to_be_visible()
            expect(page.get_by_label("Write to this task")).to_be_visible()
            expect(page.get_by_label("Task", exact=True)).to_have_value(self.ids["label"])
            page.go_back()
            expect(detail).to_be_visible()
            page.go_forward()
            expect(recent_thread).to_be_visible()
        # Where the panel sits beside the list both stay on screen.
        wide = self.open_agents()
        wide.get_by_role("complementary", name="Claude Code agent, details").get_by_role("button", name=title).click()
        expect(wide.get_by_role("region", name=f"Thread of {title}")).to_be_visible()
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
        page.reload()
        self.assertEqual(self.task("keys")["owner"]["id"], self.ids["agent_claude"], "the native owner persists after reload")
        self.assertEqual(self.api(page, "GET", f"/api/v1/projects/{self.ids['project']}/grants", status=200), grants_before, "reload grants no permissions")

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

    def test_13_connection_work_and_requests_survive_the_one_list_composition(self) -> None:
        """The projection is a fixture; task pages, scoped native reads and threads use the actual API.

        Main's durable unit/request projection is separately checked by the application suite. Here a
        newer connection unit must override an older in-progress task-owner fallback, including its face.
        """
        ada = self.page("ada")
        project = self.api(ada, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/projects",
                           {"name": "Connection work", "visibility": "restricted"}, status=201)["id"]
        self.api(ada, "POST", f"/api/v1/projects/{project}/grants",
                 {"principal": {"kind": "agent", "id": self.ids["agent_claude"]}, "role": "contributor"}, status=201)
        connection = self.api(ada, "POST", "/api/v1/agent-connections",
                              {"agentId": self.ids["agent_claude"], "selectedProjectIds": [project],
                               "scopes": ["flux.context.read", "flux.proposal.write"], "name": "Unit laptop", "clientDesignation": "claude_code"}, status=201)
        tasks = [self.api(ada, "POST", f"/api/v1/projects/{project}/work",
                          {"title": f"Connection task {number}", "status": "in_progress",
                           "owner": {"kind": "agent", "id": self.ids["agent_claude"]}}, status=201) for number in range(51)]
        first = self.api(ada, "GET", f"/api/v1/projects/{project}/work-view?purpose=choices&choice=pivot_work&limit=50", status=200)
        page_ids = {item["id"] for item in first["items"]}
        target = next(item for item in tasks if item["id"] not in page_ids)
        self.assertTrue(first["nextCursor"])
        type(self).ids.update(projection_project=project, projection_task=target["id"])
        states = (("pending", "queued", "Not signed in from your client yet", "not_signed_in", "Assigned", "asleep"),
                  ("claimed", "claimed", "Session open since", "session_open", "Working on", "working"),
                  ("paused", "deferred", "Offline", "offline", "Paused on", "asleep"),
                  ("claimed", "claimed", "Not signed in from your client yet", "not_signed_in", "Work held on", "asleep"),
                  ("claimed", "deferred", "Offline", "offline", "Work held on", "asleep"),
                  ("claimed", "claimed", "Can’t act here now", "unavailable", "Work held on", "worried"),
                  ("claimed", "claimed", "Offline", "expired_session", "Work held on", "asleep"),
                  ("paused", "deferred", "Session open since", "session_open", "Paused on", "asleep"),
                  ("paused", "deferred", "Can’t act here now", "unavailable", "Paused on", "worried"))
        for state, request_state, availability, connection_state, text, expression in states:
            for phone, scheme in ((False, "dark"), (True, "light")):
                with self.subTest(state=state, phone=phone, engine=UI_BROWSER):
                    page = self.page("ada", phone=phone, scheme=scheme)
                    self.addCleanup(lambda page=page: None if page.is_closed() else page.unroute_all(behavior="ignoreErrors"))
                    native_reads: list[str] = []
                    page.on("request", lambda request: native_reads.append(request.url) if f"/projects/{project}/work-objects/work/{target['id']}" in request.url else None)

                    def projection(route) -> None:
                        response = route.fetch()
                        body = response.json()
                        item = next(row for row in body["connections"] if row["id"] == connection["id"])
                        item["state"] = "session_open" if connection_state == "expired_session" else connection_state
                        at = time.time()
                        item["session"] = {"startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(at - 3600)),
                                           "expiresAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(at - 60 if connection_state == "expired_session" else at + 3600))} if item["state"] == "session_open" else None
                        item["currentWork"] = {"taskId": target["id"], "taskTitle": target["title"], "role": "review", "state": state}
                        item["requests"] = [{"id": "fixture-request", "kind": "review", "state": request_state,
                                             "reason": "after the calibration result", "taskId": target["id"], "taskTitle": target["title"],
                                             "sender": {"connectionId": "fixture-sender", "name": "Review laptop", "ownerName": "Jonas Berg"}}]
                        route.fulfill(response=response, json=body)

                    page.route(f"**/api/v1/projects/{project}/agents", projection)
                    page.goto(f"/projects/{project}/agents")
                    row = page.locator(f'.agents-row[data-agent="{self.ids["agent_claude"]}"]')
                    expect(row.locator(".agents-row__now")).to_contain_text(f'{text} “{target["title"]}”')
                    expect(row).to_contain_text(availability)
                    expect(row).to_contain_text("Review request from Review laptop (Jonas Berg)")
                    expect(row).to_contain_text("after the calibration result")
                    request_text = {"queued": "waiting for its next step", "claimed": "being handled", "deferred": "deferred until its next step"}[request_state]
                    expect(row).to_contain_text(request_text)
                    expect(row.locator(".agents-row__icon")).to_have_attribute("data-expression", expression)
                    if state != "claimed" or connection_state != "session_open":
                        expect(row).not_to_contain_text("Working on")
                    if state == "claimed" and connection_state == "session_open":
                        expect(row).to_have_attribute("data-working", "true")
                        expect(page.get_by_text("1 in this project · 1 working", exact=True)).to_be_visible()
                    else:
                        expect(row).not_to_have_attribute("data-working", "true")
                        expect(page.get_by_text("1 in this project", exact=True)).to_be_visible()
                    (row.locator(".agents-row__btn").tap if phone else row.locator(".agents-row__btn").click)()
                    detail = page.get_by_role("complementary", name="Claude Code agent, details")
                    expect(detail.locator(".agents-detail__head > .kreska")).to_have_attribute("data-expression", expression)
                    now = detail.get_by_role("region", name="Now")
                    expect(now).to_contain_text(availability)
                    expect(now).to_contain_text(request_text)
                    expect(now).to_contain_text("Review laptop (Jonas Berg)")
                    expect(now).to_contain_text("Review")
                    if state == "claimed":
                        expect(now).to_contain_text("claim recorded")
                    shot(page, f"handoff-projection-{state}-{connection_state}-{'phone' if phone else 'desktop'}-{scheme}")
                    # The selected task is outside the loaded page. Its native read and actual discussion open.
                    (now.get_by_role("button", name=target["title"]).tap if phone else now.get_by_role("button", name=target["title"]).click)()
                    thread = page.get_by_role("region", name=f'Thread of {target["title"]}')
                    expect(thread).to_be_visible()
                    expect(page.get_by_label("Write to this task")).to_be_visible()
                    expect(page.get_by_label("Task", exact=True)).to_have_value(target["id"])
                    self.assertTrue(native_reads, "the current target used the actual project-scoped native read beyond page one")
                    if phone:
                        expect(detail).to_have_count(0)
                        page.go_back()
                        expect(detail).to_be_visible()
                        page.go_forward()
                        expect(thread).to_be_visible()
                    else:
                        expect(detail).to_be_visible()
                    page.unroute_all(behavior="ignoreErrors")
                    page.context.close()

    def test_14_inaccessible_and_cross_project_targets_and_viewer_writes_are_refused(self) -> None:
        project, task_id = self.ids["projection_project"], self.ids["projection_task"]
        ada = self.page("ada")
        task = self.api(ada, "GET", f"/api/v1/work/{task_id}", status=200)
        before = self.api(ada, "GET", f"/api/v1/projects/{project}/grants", status=200)
        jonas = self.page("jonas")
        self.api(jonas, "GET", f"/api/v1/work/{task_id}", status=404)
        self.api(jonas, "GET", f"/api/v1/projects/{project}/agents", status=404)
        # An explicit task URL cannot open another project's otherwise readable thread.
        for wanted in (self.ids["busy"], str(uuid.uuid4())):
            page = self.page("ada", phone=True)
            page.goto(f"/projects/{project}/agents?task={wanted}")
            expect(page.get_by_role("heading", level=1, name="Agents")).to_be_visible()
            expect(page.get_by_role("region", name="Thread of Calibrate the probes at two soil depths")).to_have_count(0)
            self.assertNotEqual(page.get_by_label("Task", exact=True).input_value(), wanted)
        # A reader can see the work but has no hand-off entry and cannot bypass it through the API.
        self.api(ada, "POST", f"/api/v1/projects/{project}/grants",
                 {"principal": {"kind": "human", "id": JONAS["id"]}, "role": "viewer"}, status=201)
        grants = self.api(ada, "GET", f"/api/v1/projects/{project}/grants", status=200)
        self.assertEqual(len(grants), len(before) + 1)
        jonas.goto(f"/projects/{project}/agents")
        expect(jonas.get_by_role("heading", level=1, name="Agents")).to_be_visible()
        expect(jonas.get_by_role("button", name="Hand off a task")).to_have_count(0)
        headers = {"origin": ORIGIN, "content-type": "application/json", "if-match": f'"{task["version"]}"'}
        response = jonas.request.patch(f"{ORIGIN}/api/v1/work/{task_id}", headers=headers,
                                      data=json.dumps({"owner": {"kind": "agent", "id": self.ids["agent_outside"]}, "clientCommandId": str(uuid.uuid4())}))
        self.assertEqual(response.status, 403, response.text())
        response = ada.request.patch(f"{ORIGIN}/api/v1/work/{task_id}", headers=headers,
                                    data=json.dumps({"owner": {"kind": "agent", "id": self.ids["agent_outside"]}, "clientCommandId": str(uuid.uuid4())}))
        self.assertEqual(response.status, 422, response.text())
        self.assertEqual(response.json()["code"], "OWNER_WITHOUT_ACCESS")
        self.assertEqual(self.api(ada, "GET", f"/api/v1/work/{task_id}", status=200)["owner"], task["owner"])
        self.assertEqual(self.api(ada, "GET", f"/api/v1/projects/{project}/grants", status=200), grants, "refusals change no grants")

    def test_16_phone_tap_confirmation_persists_owner_and_version_without_grant_changes(self) -> None:
        """Isolated projects preserve the preceding fixture; complete both touch steps in both themes."""
        for scheme in ("light", "dark"):
            with self.subTest(engine=UI_BROWSER, scheme=scheme):
                page = self.page("ada", phone=True, scheme=scheme)
                workspace = self.api(page, "POST", "/api/v1/workspaces", {"name": f"Phone hand-off {scheme}"}, status=201)["id"]
                project = self.api(page, "POST", f"/api/v1/workspaces/{workspace}/projects",
                                   {"name": "Phone field work", "visibility": "restricted"}, status=201)["id"]
                agent = self.api(page, "POST", f"/api/v1/workspaces/{workspace}/agents", {"name": "Field agent", "owner": "self"}, status=201)["id"]
                self.api(page, "POST", f"/api/v1/projects/{project}/grants",
                         {"principal": {"kind": "agent", "id": agent}, "role": "contributor"}, status=201)
                task = self.api(page, "POST", f"/api/v1/projects/{project}/work", {"title": "Check the probes after rain"}, status=201)
                grants = self.api(page, "GET", f"/api/v1/projects/{project}/grants", status=200)
                page.goto(f"/projects/{project}/agents")
                page.get_by_role("button", name="Hand off a task").tap()
                dialog = page.get_by_role("dialog", name="Hand off a task")
                expect(dialog.get_by_text("Step 1 of 2", exact=True)).to_be_visible()
                dialog.get_by_label("Task", exact=True).select_option(label="#1 · Check the probes after rain")
                dialog.locator("label.handoff__agent", has_text="Field agent").tap()
                dialog.get_by_role("button", name="Next").tap()
                expect(dialog.get_by_text("Step 2 of 2", exact=True)).to_be_visible()
                expect(dialog).to_contain_text("Field agent will be able to read this project and write in it")
                self.assertIsNone(self.api(page, "GET", f"/api/v1/work/{task['id']}", status=200)["owner"], "step2 alone changes nothing")
                confirm = dialog.get_by_role("button", name=re.compile("^Hand off"))
                target = confirm.bounding_box()
                assert target
                self.assertGreaterEqual(target["height"], 44)
                self.assertGreaterEqual(target["width"], 44)
                confirm.tap()
                expect(dialog).to_have_count(0)
                saved = self.api(page, "GET", f"/api/v1/work/{task['id']}", status=200)
                self.assertEqual({key: saved["owner"][key] for key in ("kind", "id")}, {"kind": "agent", "id": agent})
                self.assertEqual(saved["version"], task["version"] + 1, "one confirmation changes one native version")
                self.assertEqual(self.api(page, "GET", f"/api/v1/projects/{project}/grants", status=200), grants)
                page.reload()
                expect(page.locator(f'.agents-row[data-agent="{agent}"]')).to_contain_text("Handed #1")
                readback = self.api(page, "GET", f"/api/v1/work/{task['id']}", status=200)
                self.assertEqual((readback["owner"], readback["version"]), (saved["owner"], saved["version"]))
                self.assertEqual(self.api(page, "GET", f"/api/v1/projects/{project}/grants", status=200), grants, "reload grants no access")

    def test_17_phone_permission_content_stays_inside_its_inset_with_long_names_and_larger_text(self) -> None:
        api = self.page("ada")
        workspace = self.api(api, "POST", "/api/v1/workspaces", {"name": "Phone containment"}, status=201)["id"]
        project = self.api(api, "POST", f"/api/v1/workspaces/{workspace}/projects",
                           {"name": "Phone containment", "visibility": "restricted"}, status=201)["id"]
        name = "Field calibration companion " + "X" * 95
        agent = self.api(api, "POST", f"/api/v1/workspaces/{workspace}/agents", {"name": name, "owner": "self"}, status=201)["id"]
        self.api(api, "POST", f"/api/v1/projects/{project}/grants",
                 {"principal": {"kind": "agent", "id": agent}, "role": "contributor"}, status=201)
        self.api(api, "POST", f"/api/v1/projects/{project}/work", {"title": "Check the permission-step inset"}, status=201)
        problems: list[str] = []
        measurements = []
        for width in (390, 320):
            for scheme in ("light", "dark"):
                for enlarged in (False, True):
                    page = self.page("ada", phone=True, scheme=scheme)
                    page.set_viewport_size({"width": width, "height": 844})
                    page.goto(f"/projects/{project}/agents")
                    if enlarged:
                        page.evaluate("() => { document.documentElement.style.fontSize = '125%'; }")
                    page.get_by_role("button", name="Hand off a task").tap()
                    dialog = page.get_by_role("dialog", name="Hand off a task")
                    dialog.get_by_label("Task", exact=True).select_option(label="#1 · Check the permission-step inset")
                    dialog.locator("label.handoff__agent", has_text=name).tap()
                    dialog.get_by_role("button", name="Next").tap()
                    expect(dialog.get_by_text("Step 2 of 2", exact=True)).to_be_visible()
                    metric = dialog.evaluate("""el => {
                      const width = innerWidth;
                      const boxes = {};
                      for (const selector of ['.handoff__step','.handoff__title','.handoff__can','.handoff__foot']) {
                        const item = el.querySelector(selector), rect = item.getBoundingClientRect();
                        const range = document.createRange(); range.selectNodeContents(item);
                        boxes[selector] = {left:rect.left,right:rect.right,scroll:item.scrollWidth,client:item.clientWidth,
                          text:[...range.getClientRects()].map(r=>({left:r.left,right:r.right}))};
                      }
                      const body = el.querySelector('.handoff__body');
                      return {width, rootFont:getComputedStyle(document.documentElement).fontSize,boxes,
                        bodyScroll:body.scrollWidth,bodyClient:body.clientWidth};
                    }""")
                    label = f"{UI_BROWSER} {width} {scheme} {'125%' if enlarged else 'default'}"
                    measurements.append({"label": label, **metric})
                    for selector, box in metric["boxes"].items():
                        if box["left"] < 0 or box["right"] > width + 1:
                            problems.append(f"{label} {selector}: box outside viewport {box}")
                        if selector in (".handoff__step", ".handoff__title", ".handoff__can") and any(r["left"] < 0 or r["right"] > width + 1 for r in box["text"]):
                            problems.append(f"{label} {selector}: text outside viewport {box}")
                    if metric["bodyScroll"] > metric["bodyClient"] + 1:
                        problems.append(f"{label}: permission body scrolls horizontally")
                    shot(page, f"handoff-long-name-{width}-{scheme}-{'large' if enlarged else 'default'}")
                    page.context.close()
        print("\n  Phone permission containment: " + json.dumps(measurements))
        self.assertEqual(problems, [], "\n".join(problems))

    def test_18_each_connection_keeps_its_own_work_and_the_dialog_ages_the_live_claim(self) -> None:
        page = self.page("ada")
        workspace = self.api(page, "POST", "/api/v1/workspaces", {"name": "Two connection facts"}, status=201)["id"]
        project = self.api(page, "POST", f"/api/v1/workspaces/{workspace}/projects", {"name": "Two connection facts", "visibility": "restricted"}, status=201)["id"]
        agent = self.api(page, "POST", f"/api/v1/workspaces/{workspace}/agents", {"name": "Shared field agent", "owner": "self"}, status=201)["id"]
        self.api(page, "POST", f"/api/v1/projects/{project}/grants", {"principal": {"kind": "agent", "id": agent}, "role": "contributor"}, status=201)
        connections = []
        for name in ("Older unsigned laptop", "Current planning laptop"):
            connections.append(self.api(page, "POST", "/api/v1/agent-connections",
                                        {"agentId": agent, "selectedProjectIds": [project], "scopes": ["flux.context.read", "flux.proposal.write"], "name": name, "clientDesignation": "codex"}, status=201))
        held = self.api(page, "POST", f"/api/v1/projects/{project}/work",
                        {"title": "Plan the next moisture reading", "status": "in_progress", "owner": {"kind": "agent", "id": agent}}, status=201)
        self.api(page, "POST", f"/api/v1/projects/{project}/work", {"title": "The next task to hand off"}, status=201)
        reads: list[str] = []
        at = time.time()
        started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(at - 60))
        expires = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(at + 8))

        def projection(route) -> None:
            response = route.fetch()
            body = response.json()
            for item in body["connections"]:
                if item["id"] == connections[0]["id"]:
                    item.update(state="not_signed_in", session=None, currentWork=None)
                elif item["id"] == connections[1]["id"]:
                    item.update(state="session_open", session={"startedAt": started, "expiresAt": expires},
                                currentWork={"taskId": held["id"], "taskTitle": held["title"], "role": "plan", "state": "claimed"},
                                requests=[{"id": "expiry-request", "kind": "review", "state": "claimed", "reason": "after the field reading",
                                           "taskId": held["id"], "taskTitle": held["title"],
                                           "sender": {"connectionId": "expiry-sender", "name": "Field laptop", "ownerName": "Jonas Berg"}}])
            reads.append(route.request.url)
            route.fulfill(response=response, json=body)

        self.addCleanup(lambda: None if page.is_closed() else page.unroute_all(behavior="ignoreErrors"))
        page.route(f"**/api/v1/projects/{project}/agents", projection)
        opened_at = time.monotonic()
        page.goto(f"/projects/{project}/agents")
        rows = page.get_by_role("list", name="Agents in this project").get_by_role("listitem")
        expect(rows).to_have_count(2)
        unsigned = rows.filter(has_text="Older unsigned laptop")
        live = rows.filter(has_text="Current planning laptop")
        expect(unsigned).to_contain_text("Handed #1")
        expect(unsigned).not_to_have_attribute("data-working", "true")
        expect(unsigned.locator(".agents-row__icon")).to_have_attribute("data-expression", "asleep")
        expect(live).to_contain_text('Working on “Plan the next moisture reading”')
        expect(live).to_have_attribute("data-working", "true")
        expect(live.locator(".agents-row__icon")).to_have_attribute("data-expression", "working")
        expect(page.get_by_text("2 in this project · 1 working", exact=True)).to_be_visible()
        expect(page.get_by_role("complementary").get_by_role("region", name="Now")).to_contain_text("Planning")
        page.get_by_role("button", name="Hand off a task").click()
        dialog = page.get_by_role("dialog", name="Hand off a task")
        radio = dialog.locator("label.handoff__agent", has_text="Shared field agent")
        expect(radio).to_contain_text("Current planning laptop")
        expect(radio).to_contain_text('Working on “Plan the next moisture reading”')
        dialog.get_by_label("Task", exact=True).select_option(label="#2 · The next task to hand off")
        radio.click()
        dialog.get_by_role("button", name="Next").click()
        expect(dialog).to_contain_text('Working on “Plan the next moisture reading”')
        expect(dialog.locator(".handoff__chosen .kreska")).to_have_attribute("data-expression", "working")
        shot(page, "handoff-known-expiry-live-desktop-light")
        expect(dialog.get_by_text(re.compile("queued behind", re.IGNORECASE))).to_have_count(0)
        before_expiry = len(reads)
        expect(dialog).to_contain_text('Work held on “Plan the next moisture reading”', timeout=12000)
        expect(dialog.locator(".handoff__chosen .kreska")).to_have_attribute("data-expression", "asleep")
        shot(page, "handoff-known-expiry-held-desktop-light")
        self.assertEqual(len(reads), before_expiry, "aging session evidence polls no API")
        # The known eight-second expiry must also age the roster, count and selected detail before
        # their existing fifteen-second observation poll, without losing the unit/role/request facts.
        dialog.get_by_role("button", name="Close", exact=True).click()
        expect(live).to_contain_text('Work held on “Plan the next moisture reading”', timeout=1000)
        expect(live).not_to_have_attribute("data-working", "true")
        expect(live).to_contain_text("Offline")
        expect(live).to_contain_text("Review request from Field laptop (Jonas Berg)")
        expect(live).to_contain_text("after the field reading")
        expect(live.locator(".agents-row__icon")).to_have_attribute("data-expression", "asleep")
        expect(page.get_by_text("2 in this project", exact=True)).to_be_visible()
        detail = page.get_by_role("complementary").get_by_role("region", name="Now")
        expect(detail).to_contain_text("Planning · Work held · claim recorded")
        expect(detail).to_contain_text("Offline")
        expect(detail).to_contain_text("Field laptop (Jonas Berg)")
        self.assertLess(time.monotonic() - opened_at, 14, "known expiry is visible before the fifteen-second poll")
        self.assertEqual(len(reads), before_expiry, "roster, count and detail expiry use the unchanged snapshot")
        shot(page, "agents-known-expiry-held-desktop-light")

    def test_19_a_deadline_crossed_after_the_display_commit_is_not_dropped(self) -> None:
        """Controlled browser clock: retain the real DOM/effect path and move only elapsed time.

        The first clock read after the real live-claim DOM commit moves Date.now beyond its deadline,
        before expiry scheduling. No app event, API read, reload or timer advance is sent. A DOM
        observer alone is too late in this engine: its callback can run after passive effect setup.
        """
        page = self.page("ada")
        project = self.api(page, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/projects",
                           {"name": "Delayed expiry setup", "visibility": "restricted"}, status=201)["id"]
        self.api(page, "POST", f"/api/v1/projects/{project}/grants",
                 {"principal": {"kind": "agent", "id": self.ids["agent_claude"]}, "role": "contributor"}, status=201)
        connection = self.api(page, "POST", "/api/v1/agent-connections",
                              {"agentId": self.ids["agent_claude"], "selectedProjectIds": [project], "scopes": ["flux.context.read"],
                               "name": "Delayed laptop", "clientDesignation": "codex"}, status=201)
        task = self.api(page, "POST", f"/api/v1/projects/{project}/work", {"title": "Check the deadline boundary"}, status=201)
        reads: list[str] = []
        expires_at = int(time.time() * 1000) + 60_000

        def projection(route) -> None:
            response = route.fetch()
            body = response.json()
            item = next(row for row in body["connections"] if row["id"] == connection["id"])
            item.update(state="session_open", session={"startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                                                       "expiresAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(expires_at / 1000))},
                        currentWork={"taskId": task["id"], "taskTitle": task["title"], "role": "review", "state": "claimed"})
            reads.append(route.request.url)
            route.fulfill(response=response, json=body)

        self.addCleanup(lambda: None if page.is_closed() else page.unroute_all(behavior="ignoreErrors"))
        page.route(f"**/api/v1/projects/{project}/agents", projection)
        page.goto(f"/projects/{project}/agents")
        expect(page.get_by_text("1 in this project · 1 working", exact=True)).to_be_visible()
        before_dialog = len(reads)
        page.evaluate("""expiry => {
          const originalNow = Date.now.bind(Date);
          const originalTimeout = window.setTimeout.bind(window);
          const evidence = window.__expiryBoundary = { offset: 0, committed: null, timers: [], clockReads: [] };
          Date.now = () => {
            const choice = document.querySelector('.handoff__agent');
            if (!evidence.committed && choice?.textContent.includes('Working on “Check the deadline boundary”')) {
              evidence.committed = { text: choice.textContent, before: originalNow(), expiry };
              evidence.offset = expiry + 1000 - originalNow();
              evidence.committed.after = originalNow() + evidence.offset;
            }
            const at = originalNow() + evidence.offset;
            evidence.clockReads.push({ at, phase: evidence.committed ? 'after-commit' : 'before-commit' });
            return at;
          };
          window.setTimeout = (callback, delay, ...args) => {
            evidence.timers.push({ delay, at: originalNow() + evidence.offset, phase: evidence.committed ? 'after-commit' : 'before-commit' });
            return originalTimeout(callback, delay, ...args);
          };
          window.__restoreExpiryBoundary = () => {
            Date.now = originalNow; window.setTimeout = originalTimeout; evidence.offset = 0;
          };
        }""", (expires_at // 1000) * 1000)
        self.addCleanup(lambda: None if page.is_closed() else page.evaluate("window.__restoreExpiryBoundary?.()"))
        page.get_by_role("button", name="Hand off a task").click()
        dialog = page.get_by_role("dialog", name="Hand off a task")
        radio = dialog.locator("label.handoff__agent", has_text="Delayed laptop")
        try:
            expect(radio).to_contain_text('Work held on “Check the deadline boundary”', timeout=2000)
        finally:
            observed = page.evaluate("window.__expiryBoundary")
            observed.update(finalState=radio.inner_text(), clockAgeingReads=len(reads) - before_dialog - 1)
            print("\n  Delayed expiry boundary lifecycle: " + json.dumps(observed))
        evidence = page.evaluate("window.__expiryBoundary")
        self.assertIsNotNone(evidence["committed"], "the real DOM first committed a live claim")
        self.assertLess(evidence["committed"]["before"], evidence["committed"]["expiry"])
        self.assertGreater(evidence["committed"]["after"], evidence["committed"]["expiry"])
        self.assertTrue(any(timer["delay"] == 0 and timer["at"] > evidence["committed"]["expiry"] for timer in evidence["timers"]),
                        "a crossed known deadline schedules immediate ageing")
        expect(radio.locator(".kreska")).to_have_attribute("data-expression", "asleep")
        self.assertEqual(len(reads), before_dialog + 1, "only the dialog observation was read; clock ageing makes no read")
        evidence.update(finalState=radio.inner_text(), clockAgeingReads=len(reads) - before_dialog - 1)
        print("\n  Delayed expiry boundary: " + json.dumps(evidence))

    def test_15_an_exhausted_empty_task_page_is_honest(self) -> None:
        page = self.page("ada")
        project = self.api(page, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/projects",
                           {"name": "Nothing to hand off", "visibility": "restricted"}, status=201)["id"]
        page.goto(f"/projects/{project}/agents")
        page.get_by_role("button", name="Hand off a task").click()
        dialog = page.get_by_role("dialog", name="Hand off a task")
        expect(dialog.get_by_label("Task", exact=True)).to_be_disabled()
        expect(dialog.get_by_text("No open task without an agent", exact=True)).to_have_count(1)
        expect(dialog.get_by_role("button", name="More tasks")).to_have_count(0)
        expect(dialog.get_by_role("button", name="Next")).to_be_disabled()


if __name__ == "__main__":
    unittest.main()
