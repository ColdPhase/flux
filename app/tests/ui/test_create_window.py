"""One way to create, one search (#345, F-026 S3 and S16): the Create window on the computer and the sheet on
the phone open from the same places with the same fields; a task made from a message keeps it as its source and
puts one line in the conversation; ⌘K finds and creates, with `@` for people and agents and `#` for tasks.

Runs with the other tests/ui journeys through scripts/check_ui.sh against the running Compose app.
"""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, Page, expect, sync_playwright

from message_gestures import open_message_menu
from create_window import create_other, dialog, kind_tab, open_from_tasks, submit_button, title_field, window
from native_work_performance import TASKS_READY, close_create, draft_value, open_create
from touch_targets import has_minimum_touch_size
from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

PASSWORD = "one way to create"
EMAIL = f"ada.create+{int(time.time() * 1000)}@example.test"
SEED = "Calibrate the soil probes at two depths before the frost"


class CreateWindow(unittest.TestCase):
    browser: Browser
    state: dict = {}
    ids: dict = {}

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

    def page(self, scheme: str = "light", phone: bool = False, browser: Browser | None = None) -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": scheme, "locale": "en-GB", "timezone_id": "Europe/Warsaw",
                         "service_workers": "block", "viewport": PHONE if phone else DESKTOP, "device_scale_factor": 1}
        if phone:
            options.update(is_mobile=True, has_touch=True)
        if self.state:
            options["storage_state"] = self.state
        context = (browser or self.browser).new_context(**options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def api(self, page: Page, method: str, path: str, body: dict | None = None, status: int | None = None) -> dict:
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers={"origin": ORIGIN, "content-type": "application/json"},
                                      data=json.dumps(body) if body is not None else None)
        if status is not None:
            self.assertEqual(response.status, status, response.text())
        return json.loads(response.text()) if response.text() else {}

    def ensure_account(self) -> None:
        if self.state:
            return
        page = self.page()
        page.goto("/sign-up")
        page.get_by_label("Name").fill("Ada Create")
        page.get_by_label("Email").fill(EMAIL)
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        workspace = self.api(page, "POST", "/api/v1/workspaces", {"name": "Garden sensors"}, 201)
        project = self.api(page, "POST", f"/api/v1/workspaces/{workspace['id']}/projects", {"name": "Community garden sensors", "visibility": "restricted"}, 201)
        other = self.api(page, "POST", f"/api/v1/workspaces/{workspace['id']}/projects", {"name": "Cargo bike co-op", "visibility": "restricted"}, 201)
        self.api(page, "POST", f"/api/v1/workspaces/{workspace['id']}/agents", {"name": "Probe helper", "owner": "self"}, 201)
        thread = self.api(page, "POST", f"/api/v1/projects/{project['id']}/conversations", {"body": SEED, "clientMessageId": str(uuid.uuid4())}, 201)
        type(self).ids = {"workspace": workspace["id"], "project": project["id"], "other": other["id"], "thread": thread["id"]}
        # The thread's first message is the one a task is made from.
        roots = self.api(page, "GET", f"/api/v1/projects/{project['id']}/conversation-roots?limit=10", status=200)["roots"]
        type(self).ids["message"] = roots[0]["message"]["id"]
        type(self).state = page.context.storage_state()

    def work(self, page: Page) -> list[dict]:
        return self.api(page, "GET", f"/api/v1/projects/{self.ids['project']}/work?limit=100", status=200)["items"]

    # ---------------------------------------------------------------- AC-1: one window, the same fields

    def test_01_new_and_c_open_the_window_with_the_drawn_fields_and_make_a_task(self) -> None:
        self.ensure_account()
        for scheme in ("light", "dark"):
            page = self.page(scheme)
            page.goto(f"/projects/{self.ids['project']}")
            expect(page.get_by_role("heading", level=1, name="Community garden sensors")).to_be_visible()
            page.get_by_role("complementary", name="Sidebar").get_by_role("button", name=re.compile("^New")).click()
            window = dialog(page)
            expect(window).to_be_visible()
            expect(title_field(page)).to_be_focused()
            for control in (window.get_by_label("Details"), window.get_by_role("combobox", name="Status"), window.get_by_role("combobox", name="Owner"),
                            window.get_by_role("button", name="+ Link a message or thought"), window.get_by_role("switch"), submit_button(page)):
                expect(control).to_be_visible()
            self.assertEqual(window.evaluate("el => el.offsetWidth"), 640)
            # The place picker is a 10px frame around a 6px tile, not a pill (concentric corners).
            frame = window.locator(".create__place")
            self.assertEqual(frame.evaluate("el => getComputedStyle(el).borderRadius"), "10px")
            self.assertEqual(window.locator(".create__tile").evaluate("el => getComputedStyle(el).borderRadius"), "6px")
            self.assertEqual(frame.evaluate("el => getComputedStyle(el).paddingLeft"), "4px")
            # "Create task" waits for a title.
            expect(submit_button(page)).to_be_disabled()
            title = f"Calibrate the probes at two soil depths {scheme}"
            title_field(page).fill(title)
            shot(page, f"345-create-window-1440-{scheme}")
            title_field(page).press("Enter")
            expect(dialog(page)).to_have_count(0)
            expect(page.get_by_role("complementary", name="Details").or_(page.get_by_role("dialog", name="Details")).get_by_role("heading", name=title)).to_be_visible()
        titles = [item["title"] for item in self.work(page)]
        self.assertIn("Calibrate the probes at two soil depths light", titles)
        self.assertIn("Calibrate the probes at two soil depths dark", titles)

    def test_02_tasks_and_the_board_open_the_same_window(self) -> None:
        self.ensure_account()
        page = self.page()
        page.goto(f"/projects/{self.ids['project']}/tasks")
        field = open_from_tasks(page)
        expect(dialog(page).get_by_role("combobox", name="Project")).to_have_value(self.ids["project"])
        page.keyboard.press("Escape")
        expect(dialog(page)).to_have_count(0)
        page.get_by_role("button", name="New task in In progress").click()
        expect(dialog(page)).to_be_visible()
        expect(dialog(page).get_by_role("combobox", name="Status")).to_have_value("in_progress")
        field = title_field(page)
        field.fill("Started from a column")
        submit_button(page).click()
        expect(dialog(page)).to_have_count(0)
        stored = {item["title"]: item for item in self.work(page)}
        self.assertEqual(stored["Started from a column"]["status"], "in_progress")

    def test_03_create_another_and_command_enter(self) -> None:
        self.ensure_account()
        page = self.page()
        page.goto(f"/projects/{self.ids['project']}/tasks")
        field = open_from_tasks(page)
        dialog(page).get_by_role("switch").check()
        field.fill("First of two")
        dialog(page).get_by_label("Details").fill("Done when both are listed")
        page.keyboard.press("Control+Enter")
        expect(field).to_have_value("")
        expect(dialog(page)).to_be_visible()
        expect(field).to_be_focused()
        field.fill("Second of two")
        page.keyboard.press("Control+Enter")
        expect(field).to_have_value("")
        dialog(page).get_by_role("switch").uncheck()
        page.keyboard.press("Escape")
        stored = {item["title"]: item for item in self.work(page)}
        self.assertEqual(stored["First of two"]["outcome"], "Done when both are listed")
        self.assertIn("Second of two", stored)

    def test_04_a_blocked_task_needs_its_reason(self) -> None:
        self.ensure_account()
        page = self.page()
        page.goto(f"/projects/{self.ids['project']}/tasks")
        field = open_from_tasks(page)
        field.fill("Waiting on the supplier")
        dialog(page).get_by_role("combobox", name="Status").select_option("blocked")
        expect(submit_button(page)).to_be_disabled()
        dialog(page).get_by_label("What is it waiting for?").fill("Probe drawing v2")
        submit_button(page).click()
        expect(dialog(page)).to_have_count(0)
        stored = {item["title"]: item for item in self.work(page)}
        self.assertEqual((stored["Waiting on the supplier"]["status"], stored["Waiting on the supplier"]["blocker"]), ("blocked", "Probe drawing v2"))

    # ---------------------------------------------------------------- AC-4: a message is the task's source

    def test_05_a_task_from_a_message_keeps_it_as_source_and_posts_the_one_line_notice(self) -> None:
        self.ensure_account()
        page = self.page()
        page.goto(f"/projects/{self.ids['project']}/conversations/{self.ids['thread']}")
        message = page.locator(f"#message-{self.ids['message']}")
        expect(message).to_be_visible()
        message.hover()
        message.get_by_role("button", name="Create task", exact=True).click()
        window = dialog(page)
        expect(window).to_be_visible()
        expect(title_field(page)).to_have_value(SEED)
        expect(window.get_by_role("button", name=re.compile("^Remove link to"))).to_have_count(1)
        before = page.locator(".convo-notice").count()
        submit_button(page).click()
        expect(window).to_have_count(0)
        made = [item for item in self.work(page) if item["title"] == SEED]
        self.assertEqual(len(made), 1)
        self.assertEqual([(link["role"], link["to"]) for link in made[0]["links"]], [("source", {"type": "message", "id": self.ids["message"]})])
        expect(page.locator(".convo-notice")).to_have_count(before + 1)
        expect(page.locator(f'.convo-notice[data-work-id="{made[0]["id"]}"] .convo-notice__what')).to_contain_text("made a task from")

    # ---------------------------------------------------------------- AC-3: ⌘K finds and creates

    def jump(self, page: Page, query: str):
        page.keyboard.press("Control+k")
        palette = page.get_by_role("dialog", name="Jump to")
        expect(palette).to_be_visible()
        field = palette.get_by_role("combobox", name="Jump to")
        expect(field).to_be_focused()
        field.fill(query)
        return palette, field

    def test_06_command_k_offers_create_actions_and_opens_the_window_with_the_text(self) -> None:
        self.ensure_account()
        page = self.page()
        page.goto(f"/projects/{self.ids['project']}")
        expect(page.get_by_role("heading", level=1, name="Community garden sensors")).to_be_visible()
        palette, field = self.jump(page, "probes")
        options = palette.get_by_role("option")
        expect(options.first).to_have_text(re.compile("New task “probes”"))
        self.assertEqual(options.first.get_attribute("aria-selected"), "true")
        expect(palette.get_by_role("option", name="New thought on the Map")).to_be_visible()
        expect(palette.get_by_role("option", name="Propose a decision")).to_be_visible()
        shot(page, "345-palette-1440")
        field.press("Enter")
        expect(palette).to_have_count(0)
        expect(title_field(page)).to_have_value("probes")
        page.keyboard.press("Escape")
        # With no query: the four actions with their keys (E02); Go to Inbox runs.
        palette, field = self.jump(page, "")
        for name in ("New task", "Go to Inbox", "Focus mode", "Hide the sidebar"):
            expect(palette.get_by_role("option", name=name, exact=True)).to_be_visible()
        expect(palette.get_by_role("option", name="New thought on the Map")).to_have_count(0)
        palette.get_by_role("option", name="Go to Inbox", exact=True).click()
        expect(page).to_have_url(re.compile(r"/inbox$"))

    def test_07_at_finds_agents_and_hash_finds_tasks_by_number_with_the_keyboard_only(self) -> None:
        self.ensure_account()
        page = self.page()
        page.goto(f"/projects/{self.ids['project']}/tasks")
        add = open_from_tasks(page)
        add.fill("Numbered for the palette")
        submit_button(page).click()
        expect(dialog(page)).to_have_count(0)
        number = next(item for item in self.work(page) if item["title"] == "Numbered for the palette")["number"]
        palette, field = self.jump(page, f"#{number}")
        row = palette.locator("[role=option].sr").filter(has_text="Numbered for the palette")
        expect(row.first).to_be_visible()
        expect(palette.get_by_role("option", name=re.compile("^New task"))).to_have_count(0)
        field.press("Enter")
        expect(page).to_have_url(re.compile(r"/tasks\?open=work:|/tasks$"))
        palette, field = self.jump(page, "@probe")
        agent = palette.get_by_role("option", name=re.compile("Probe helper"))
        expect(agent).to_be_visible()
        field.press("Enter")
        expect(page).to_have_url(re.compile(rf"/projects/{self.ids['project']}/agents$"))
        # The footer names both scopes.
        palette, field = self.jump(page, "")
        expect(palette).to_contain_text("people and agents")
        expect(palette).to_contain_text("task number")

    # ---------------------------------------------------------------- the phone's sheet

    def test_08_the_phone_sheet_asks_what_to_create_then_shows_the_same_fields(self) -> None:
        self.ensure_account()
        for scheme in ("light", "dark"):
            page = self.page(scheme, phone=True)
            page.goto("/")
            page.get_by_role("button", name="Create", exact=True).tap()
            sheet = page.get_by_role("dialog", name="Create")
            expect(sheet).to_be_visible()
            tiles = sheet.locator(".phone-create__grid").get_by_role("button")
            self.assertEqual([item.strip() for item in tiles.all_inner_texts()], ["Task", "Thought", "Message", "Decision", "File or link", "Sketch"])
            for tile in tiles.all():
                self.assertGreaterEqual(tile.bounding_box()["height"], 44)
            shot(page, f"345-create-sheet-390-{scheme}")
            sheet.get_by_role("button", name="Task", exact=True).tap()
            window = dialog(page)
            expect(window).to_have_count(1)  # the sheet has left the screen
            expect(window).to_be_visible()
            # Type first, then pick another project: the typed title moves with the task (F2).
            title_field(page).fill("Print labels for the beds")
            window.get_by_role("combobox", name="Project").select_option(self.ids["other"])
            expect(title_field(page)).to_have_value("Print labels for the beds")
            for control in (window.get_by_label("Details"), window.get_by_role("combobox", name="Status"), window.get_by_role("combobox", name="Owner"),
                            window.get_by_role("button", name="+ Link a message or thought"), window.get_by_role("switch"), submit_button(page)):
                expect(control).to_be_visible()
            box = submit_button(page).bounding_box()
            self.assertGreaterEqual(box["height"], 44)
            self.assertLessEqual(box["x"] + box["width"], PHONE["width"])
            shot(page, f"345-create-task-sheet-390-{scheme}")
            submit_button(page).tap()
            expect(dialog(page)).to_have_count(0)
        stored = self.api(page, "GET", f"/api/v1/projects/{self.ids['other']}/work?limit=100", status=200)["items"]
        self.assertTrue([item for item in stored if item["title"] == "Print labels for the beds"])

    # ---------------------------------------------------------------- the phone's Search (S-P-Search, S-P-NoResults)

    def test_09_phone_search_has_scope_chips_a_create_action_and_a_calm_no_match_state(self) -> None:
        self.ensure_account()
        for scheme in ("light", "dark"):
            page = self.page(scheme, phone=True)
            self.api(page, "POST", f"/api/v1/projects/{self.ids['project']}/work", {"title": f"Order the probes {scheme}", "clientCommandId": str(uuid.uuid4())}, 201)
            page.goto(f"/projects/{self.ids['project']}/tasks")
            page.get_by_role("button", name="Search", exact=True).tap()
            sheet = page.get_by_role("dialog", name="Jump to")
            expect(sheet).to_be_visible()
            expect(sheet.get_by_role("heading", name="Search")).to_be_visible()
            chips = sheet.get_by_role("group", name="Search in")
            self.assertEqual([item.strip() for item in chips.get_by_role("button").all_inner_texts()], ["All", "Tasks", "People", "Agents", "Wiki"])
            for chip in chips.get_by_role("button").all():
                self.assertGreaterEqual(chip.bounding_box()["height"], 44)
            field = sheet.get_by_role("combobox", name="Jump to")
            field.fill("probes")
            # All: the create action first, then tasks, then everything else.
            expect(sheet.get_by_role("option", name=re.compile("^New task “probes”"))).to_be_visible()
            expect(sheet.locator("[role=option].sr").filter(has_text=f"Order the probes {scheme}")).to_be_visible()
            shot(page, f"345-phone-search-390-{scheme}")
            chips.get_by_role("button", name="Tasks").tap()
            expect(chips.get_by_role("button", name="Tasks")).to_have_attribute("aria-pressed", "true")
            expect(sheet.get_by_role("option", name=re.compile("^New task"))).to_have_count(0)
            expect(sheet.locator("[role=option].sr").filter(has_text=f"Order the probes {scheme}")).to_be_visible()
            chips.get_by_role("button", name="Agents").tap()
            field.fill("probe")
            expect(sheet.get_by_role("option", name=re.compile("Probe helper"))).to_be_visible()
            chips.get_by_role("button", name="All").tap()
            field.fill("zzqxunmatched")
            none = sheet.locator(".jump__none")
            expect(none.get_by_role("heading", name="No match in this project")).to_be_visible()
            expect(none.locator(".kreska")).to_have_count(1)
            expect(sheet.get_by_role("option", name=re.compile("^New task “zzqxunmatched”"))).to_be_visible()
            shot(page, f"345-phone-search-nomatch-390-{scheme}")
            none.get_by_role("button", name="Search all projects").tap()
            expect(sheet.get_by_role("group", name="Search where").get_by_role("button", name="All projects")).to_have_attribute("aria-pressed", "true")
            expect(none).to_have_count(0)
            # The create action opens the sheet with the text.
            sheet.get_by_role("option", name=re.compile("^New task “zzqxunmatched”")).tap()
            expect(title_field(page)).to_have_value("zzqxunmatched")

    def test_13_the_window_project_picker_moves_the_task_to_the_chosen_project(self) -> None:
        self.ensure_account()
        page = self.page()
        page.goto(f"/projects/{self.ids['project']}/tasks")
        field = open_from_tasks(page)
        title = f"Picker moves this {uuid.uuid4().hex[:6]}"
        field.fill(title)
        dialog(page).get_by_role("combobox", name="Project").select_option(self.ids["other"])
        expect(title_field(page)).to_have_value(title)
        submit_button(page).click()
        expect(dialog(page)).to_have_count(0)
        stored = self.api(page, "GET", f"/api/v1/projects/{self.ids['other']}/work?limit=100", status=200)["items"]
        self.assertTrue([item for item in stored if item["title"] == title], "the task is in the project the picker shows")

    # ---------------------------------------------------------------- review fixes (#377)

    def thread(self, page: Page, body: str) -> dict:
        thread = self.api(page, "POST", f"/api/v1/projects/{self.ids['project']}/conversations", {"body": body, "clientMessageId": str(uuid.uuid4())}, 201)
        return {"conversation": thread["id"], "message": thread["messages"][0]["id"]}

    def lose_first_response(self, page: Page, keys: list[str]) -> None:
        """The first create really commits on the server, but its response never arrives."""
        def lose(route):
            if route.request.method != "POST":
                return route.continue_()
            keys.append(route.request.headers["idempotency-key"])
            response = route.fetch()
            self.assertEqual(response.status, 201, response.text())
            if len(keys) == 1:
                route.fulfill(status=503, json={"message": "The response was lost"})
            else:
                route.fulfill(response=response)
        page.route(f"**/api/v1/projects/{self.ids['project']}/work", lose)

    def test_10_a_lost_response_is_retried_with_the_same_identity_from_every_entry_point(self) -> None:
        self.ensure_account()
        notices = lambda page: self.api(page, "GET", f"/api/v1/projects/{self.ids['project']}/task-notices?limit=100", status=200)["total"]  # noqa: E731
        # From a message: source, details and status all come back after closing and reopening.
        page = self.page()
        made = self.thread(page, "Lost response from a message: check the ESP32 kits")
        page.goto(f"/projects/{self.ids['project']}/conversations/{made['conversation']}")
        keys: list[str] = []
        self.lose_first_response(page, keys)
        before = notices(page)
        message = page.locator(f"#message-{made['message']}")
        message.hover()
        message.get_by_role("button", name="Create task", exact=True).click()
        window = dialog(page)
        window.get_by_label("Details").fill("Done when both kits are counted")
        window.get_by_role("combobox", name="Status").select_option("in_progress")
        submit_button(page).click()
        expect(window.get_by_role("alert")).to_have_text("The response was lost")
        page.keyboard.press("Escape")
        expect(window).to_have_count(0)
        message.hover()
        message.get_by_role("button", name="Create task", exact=True).click()
        expect(title_field(page)).to_have_value("Lost response from a message: check the ESP32 kits")
        expect(window.get_by_label("Details")).to_have_value("Done when both kits are counted")
        expect(window.get_by_role("combobox", name="Status")).to_have_value("in_progress")
        expect(window.get_by_role("button", name=re.compile("^Remove link to"))).to_have_count(1)
        submit_button(page).click()
        expect(window).to_have_count(0)
        self.assertEqual(len(keys), 2)
        self.assertEqual(keys[0], keys[1], "the retry carries the first attempt's identity")
        stored = [item for item in self.work(page) if item["title"].startswith("Lost response from a message")]
        self.assertEqual(len(stored), 1, "one persisted task")
        self.assertEqual((stored[0]["outcome"], stored[0]["status"]), ("Done when both kits are counted", "in_progress"))
        self.assertEqual(notices(page), before + 1, "one notice")
        # From the palette: the typed title is the command.
        page = self.page()
        page.goto(f"/projects/{self.ids['project']}")
        keys = []
        self.lose_first_response(page, keys)
        expect(page.get_by_role("button", name="Search", exact=True)).to_be_visible()
        palette, field = self.jump(page, "Lost response from the palette")
        field.press("Enter")
        title_field(page)
        submit_button(page).click()
        expect(dialog(page).get_by_role("alert")).to_have_text("The response was lost")
        page.keyboard.press("Escape")
        palette, field = self.jump(page, "Lost response from the palette")
        field.press("Enter")
        submit_button(page).click()
        expect(dialog(page)).to_have_count(0)
        self.assertEqual(keys[0], keys[1])
        self.assertEqual(len([item for item in self.work(page) if item["title"] == "Lost response from the palette"]), 1)
        # From a blank form: details, status and owner survive too (the title-only control).
        page = self.page()
        page.goto(f"/projects/{self.ids['project']}/tasks")
        keys = []
        self.lose_first_response(page, keys)
        field = open_from_tasks(page)
        field.fill("Lost response from a blank form")
        dialog(page).get_by_label("Details").fill("Blank form details")
        dialog(page).get_by_role("combobox", name="Status").select_option("in_progress")
        submit_button(page).click()
        expect(dialog(page).get_by_role("alert")).to_have_text("The response was lost")
        page.keyboard.press("Escape")
        field = open_from_tasks(page)
        expect(field).to_have_value("Lost response from a blank form")
        expect(dialog(page).get_by_label("Details")).to_have_value("Blank form details")
        expect(dialog(page).get_by_role("combobox", name="Status")).to_have_value("in_progress")
        submit_button(page).click()
        expect(dialog(page)).to_have_count(0)
        self.assertEqual(keys[0], keys[1])
        stored = [item for item in self.work(page) if item["title"] == "Lost response from a blank form"]
        self.assertEqual(len(stored), 1)
        self.assertEqual((stored[0]["outcome"], stored[0]["status"]), ("Blank form details", "in_progress"))

    def second_workspace(self, page: Page) -> dict:
        if "b_project" not in self.ids:
            workspace = self.api(page, "POST", "/api/v1/workspaces", {"name": "Bike co-op space"}, 201)
            project = self.api(page, "POST", f"/api/v1/workspaces/{workspace['id']}/projects", {"name": "Frame builds", "visibility": "restricted"}, 201)
            self.api(page, "POST", f"/api/v1/workspaces/{workspace['id']}/agents", {"name": "Gearbox helper", "owner": "self"}, 201)
            self.ids["b_project"] = project["id"]
        return self.ids

    def test_11_an_agent_opens_in_its_own_workspace_from_home_and_from_another_project(self) -> None:
        self.ensure_account()
        page = self.page()
        self.second_workspace(page)
        a_projects = rf"/projects/({self.ids['project']}|{self.ids['other']})/agents$"
        for start, query, expected in (("/", "@gearbox", rf"/projects/{self.ids['b_project']}/agents$"),
                                       (f"/projects/{self.ids['project']}", "@gearbox", rf"/projects/{self.ids['b_project']}/agents$"),
                                       (f"/projects/{self.ids['b_project']}", "@probe", a_projects),
                                       ("/", "@probe", a_projects)):
            with self.subTest(start=start, query=query):
                page = self.page()
                page.goto(start)
                expect(page.get_by_role("button", name="Search", exact=True)).to_be_visible()
                palette, field = self.jump(page, query)
                option = palette.get_by_role("option", name=re.compile("(Gearbox|Probe) helper"))
                expect(option).to_have_count(1)
                field.press("Enter")
                expect(page).to_have_url(re.compile(expected))

    def test_12_the_phone_chooser_proposes_a_decision_in_the_project_it_shows(self) -> None:
        self.ensure_account()
        page = self.page(phone=True)
        for start in (f"/projects/{self.ids['project']}/tasks", "/"):
            with self.subTest(start=start):
                title = f"Decide in the shown project from {'a project' if start != '/' else 'home'}"
                page = self.page(phone=True)
                page.goto(start)
                page.get_by_role("button", name="Create", exact=True).tap()
                sheet = page.get_by_role("dialog", name="Create")
                sheet.get_by_role("combobox", name="Project").select_option(self.ids["other"])
                tile = sheet.get_by_role("button", name="Decision", exact=True)
                expect(tile).not_to_have_attribute("aria-disabled", "true")
                tile.tap()
                panel = page.get_by_role("dialog", name="Details")
                expect(panel.get_by_role("heading", name="Propose a decision")).to_be_visible()
                panel.get_by_label("Decision").fill(title)
                panel.get_by_label("Why").fill("Because the picker said so")
                panel.get_by_role("button", name="Propose decision", exact=True).tap()
                expect(panel.locator(".wd-eyebrow")).to_contain_text("Proposed decision")
                titles = lambda project: [item["title"] for item in self.api(page, "GET", f"/api/v1/projects/{project}/decisions?limit=100", status=200)["items"]]  # noqa: E731
                self.assertIn(title, titles(self.ids["other"]))
                self.assertNotIn(title, titles(self.ids["project"]))

    def test_13_close_project_and_remove_link_are_44px_targets_on_touch_chromium_and_webkit(self) -> None:
        self.ensure_account()
        self.assertFalse(has_minimum_touch_size(43.99), "a 43.99 px target is rejected")
        self.assertTrue(has_minimum_touch_size(43.9995), "layout noise within 0.001 is not")
        page0 = self.page()
        made = self.thread(page0, "Touch targets of the Create sheet")
        webkit = self.pw.webkit.launch()
        self.addCleanup(webkit.close)
        for engine, browser in (("chromium", self.browser), ("webkit", webkit)):
            with self.subTest(engine=engine):
                page = self.page(phone=True, browser=browser)
                page.goto(f"/projects/{self.ids['project']}")
                message = page.locator(f"#message-{made['message']}")
                expect(message).to_be_visible()
                page.evaluate("() => Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => null)))")
                menu = open_message_menu(message, phone=True)
                menu.get_by_role("menuitem", name="Create task", exact=True).tap()
                sheet = dialog(page)
                expect(sheet.get_by_role("button", name=re.compile("^Remove link to"))).to_be_visible()
                page.evaluate("() => Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => null)))")
                targets = {"Close": sheet.get_by_role("button", name="Close"), "Project picker": sheet.locator(".create__place"),
                           "Project": sheet.get_by_role("tablist", name="Create").get_by_role("tab", name="Project", exact=True),
                           "Remove link": sheet.get_by_role("button", name=re.compile("^Remove link to"))}
                for name, target in targets.items():
                    box = target.bounding_box()
                    assert box
                    self.assertTrue(has_minimum_touch_size(box["width"]), f"{engine} {name} width {box['width']}")
                    self.assertTrue(has_minimum_touch_size(box["height"]), f"{engine} {name} height {box['height']}")
                    # The middle of each edge receives the touch (trial: checks the hit target, does not click); rounded
                    # controls have no corners to hit.
                    w, h = box["width"], box["height"]
                    for x, y in ((w / 2, 1), (w / 2, h - 1), (1, h / 2), (w - 1, h / 2)):
                        target.click(position={"x": x, "y": y}, trial=True)
                # Finger taps: on the label 1 px before Remove's box the link stays; a tap on Remove removes it.
                chip = sheet.locator(".create__chip--link").first
                chip_box = chip.bounding_box()
                remove_box = targets["Remove link"].bounding_box()
                assert chip_box and remove_box
                edge = remove_box["x"] - 1
                for y in (chip_box["y"] + 1, chip_box["y"] + chip_box["height"] / 2, chip_box["y"] + chip_box["height"] - 1):
                    hit = page.evaluate("([x, y]) => { const e = document.elementFromPoint(x, y); return { inChip: !!e?.closest('.create__chip--link'), inButton: !!e?.closest('button') }; }", [edge, y])
                    self.assertEqual(hit, {"inChip": True, "inButton": False}, f"{engine}: the tap point is on the label, not Remove")
                    page.touchscreen.tap(edge, y)
                    expect(sheet.locator(".create__chip--link")).to_have_count(1)
                page.touchscreen.tap(remove_box["x"] + remove_box["width"] / 2, remove_box["y"] + remove_box["height"] / 2)
                expect(sheet.locator(".create__chip--link")).to_have_count(0)

    # ---------------------------------------------------------------- keyboard-only and focus (kept from the old assertions)

    def test_14_keyboard_only_opens_a_result_and_focus_returns_to_the_opener(self) -> None:
        self.ensure_account()
        page = self.page()
        page.goto(f"/projects/{self.ids['project']}")
        new = page.get_by_role("complementary", name="Sidebar").get_by_role("button", name=re.compile("^New"))
        new.focus()
        page.keyboard.press("Enter")
        expect(title_field(page)).to_be_focused()
        page.keyboard.press("Escape")
        expect(new).to_be_focused()
        palette, field = self.jump(page, "probes")
        # Create rows first; arrows reach the results and Enter opens the highlighted one.
        selected = lambda: palette.locator("[role=option][aria-selected=true]")  # noqa: E731
        expect(palette.locator("[role=option].sr").first).to_be_visible()
        for _ in range(4):  # three create rows, then the first result
            field.press("ArrowDown")
        expect(selected()).to_have_class(re.compile(r"\bsr\b"))
        self.assertEqual(page.evaluate("document.activeElement === document.querySelector('[role=dialog][aria-label=\"Jump to\"] input')"), True, "focus stays in the field")
        field.press("Enter")
        expect(palette).to_have_count(0)

    def test_15_the_performance_harness_predicates_follow_the_portalled_window(self) -> None:
        """Bounded ordinary-fixture smoke of the migrated harness helpers; the load generator is not run."""
        self.ensure_account()
        page = self.page()
        page.goto(f"/projects/{self.ids['project']}/tasks")
        page.get_by_role("radio", name="List", exact=True).click()
        page.wait_for_function(f"({TASKS_READY})()")
        self.assertFalse(page.locator(".create__title").count(), "closed: no input, yet Tasks is ready")
        open_create(page)
        self.assertEqual(page.evaluate(f"({TASKS_READY})()"), True, "open: Tasks readiness does not depend on the dialog")
        self.assertFalse(page.evaluate("!!document.querySelector('.create__title').closest('.ws-tasks')"), "the input is outside .ws-tasks")
        page.locator(".create__title").fill("Harness draft")
        self.assertEqual(draft_value(page), "Harness draft")
        close_create(page)
        self.assertEqual(page.locator(".create__title").count(), 0)


    def test_16_an_unresolved_command_survives_another_create_in_the_same_project(self) -> None:
        """A blank-form command loses its response; a prefilled create in the same project then completes. The retry of the
        first command still carries its own identity and makes no second task."""
        self.ensure_account()
        made = self.thread(self.page(), "Cross-command message: order the seed trays")
        page = self.page()
        page.goto(f"/projects/{self.ids['project']}/tasks")
        keys: list[str] = []
        self.lose_first_response(page, keys)
        field = open_from_tasks(page)
        field.fill("Cross command first")
        dialog(page).get_by_label("Details").fill("First command details")
        submit_button(page).click()
        expect(dialog(page).get_by_role("alert")).to_have_text("The response was lost")
        page.keyboard.press("Escape")
        expect(dialog(page)).to_have_count(0)
        page.goto(f"/projects/{self.ids['project']}/conversations/{made['conversation']}")
        message = page.locator(f"#message-{made['message']}")
        message.hover()
        message.get_by_role("button", name="Create task", exact=True).click()
        submit_button(page).click()
        expect(dialog(page)).to_have_count(0)
        page.goto(f"/projects/{self.ids['project']}/tasks")
        field = open_from_tasks(page)
        expect(field).to_have_value("Cross command first")
        expect(dialog(page).get_by_label("Details")).to_have_value("First command details")
        submit_button(page).click()
        expect(dialog(page)).to_have_count(0)
        self.assertEqual(len(keys), 3)
        self.assertNotEqual(keys[1], keys[0], "the other create has its own identity")
        self.assertEqual(keys[2], keys[0], "the first command's identity survives the other create")
        stored = [item for item in self.work(page) if item["title"] == "Cross command first"]
        self.assertEqual(len(stored), 1, "one persisted task")
        self.assertEqual(stored[0]["outcome"], "First command details")

    # ---------------------------------------------------------------- #521: the kinds as tabs in the same window

    def open_window(self, page: Page, path: str | None = None) -> None:
        """C on a project's conversation (or `path`): the window opens on Task with its title focused."""
        page.goto(path or f"/projects/{self.ids['project']}")
        expect(page.get_by_role("heading", level=1, name="Community garden sensors")).to_be_visible()
        page.locator("body").press("c")
        expect(title_field(page)).to_be_focused()

    def test_17_the_kinds_are_tabs_in_one_window_and_the_title_goes_with_the_person(self) -> None:
        """F-026 S3 / E02: Task is the default; Thought, Message, Decision and Project are tabs with ←/→ in the same window,
        and the typed text is in each of them (a thought, a message, a decision, a project's name)."""
        self.ensure_account()
        page = self.page()
        self.open_window(page)
        tabs = window(page).get_by_role("tablist", name="Create")
        expect(tabs.get_by_role("tab")).to_have_text(["Task", "Thought", "Message", "Decision", "Project"])
        expect(kind_tab(page, "Task")).to_have_attribute("aria-selected", "true")
        expect(window(page).get_by_role("heading")).to_have_count(0)  # the window is named after its tab; no heading repeats it
        expect(window(page).get_by_role("tabpanel")).to_have_count(1)
        text = f"Carried across the tabs {uuid.uuid4().hex[:6]}"
        title_field(page).fill(text)
        # The keyboard: ←/→ move between the tabs and keep focus on them; the window and its text stay.
        kind_tab(page, "Task").focus()
        fields = (("Thought", "Thought", "New thought"), ("Message", "Message", "New message"), ("Decision", "Decision", "New decision"),
                  ("Project", "What is it about?", "New project"))
        for tab, label, name in fields:
            page.keyboard.press("ArrowRight")
            expect(kind_tab(page, tab)).to_be_focused()
            expect(kind_tab(page, tab)).to_have_attribute("aria-selected", "true")
            panel = page.get_by_role("dialog", name=name).get_by_role("tabpanel")
            expect(panel).to_have_count(1)
            self.assertEqual(panel.get_attribute("aria-labelledby"), kind_tab(page, tab).get_attribute("id"))
            expect(panel.get_by_role("textbox", name=label, exact=True)).to_have_value(text)
            if tab == "Decision":
                expect(panel.get_by_role("combobox", name="Project")).to_have_value(self.ids["project"])
            if tab == "Message":
                expect(panel.get_by_role("combobox", name="Project")).to_have_count(0)  # a direct message, not a project's
        page.keyboard.press("ArrowRight")
        expect(kind_tab(page, "Task")).to_be_focused()
        expect(title_field(page)).to_have_value(text)
        page.keyboard.press("ArrowLeft")
        expect(kind_tab(page, "Project")).to_have_attribute("aria-selected", "true")
        page.keyboard.press("Home")
        expect(kind_tab(page, "Task")).to_have_attribute("aria-selected", "true")
        expect(page.get_by_role("dialog")).to_have_count(1)
        # A pointer on a tab goes on to its text; a change there comes back to Task.
        kind_tab(page, "Decision").click()
        decision = page.get_by_role("dialog", name="New decision").get_by_role("textbox", name="Decision", exact=True)
        expect(decision).to_be_focused()
        page.keyboard.press("End")
        page.keyboard.type(" today")
        kind_tab(page, "Task").click()
        expect(title_field(page)).to_have_value(f"{text} today")
        expect(title_field(page)).to_be_focused()
        # A blank window keeps the text as this project's draft: closing never loses it.
        page.keyboard.press("Escape")
        expect(window(page)).to_have_count(0)
        page.locator("body").press("c")
        expect(title_field(page)).to_have_value(f"{text} today")
        expect(kind_tab(page, "Task")).to_have_attribute("aria-selected", "true")

    def test_18_thought_saves_a_private_note_from_the_window(self) -> None:
        self.ensure_account()
        page = self.page()
        self.open_window(page)
        text = f"Ask the library about a second sensor shelf {uuid.uuid4().hex[:6]}"
        title_field(page).fill(text)
        create_other(page, "Thought")
        thought = page.get_by_role("dialog", name="New thought")
        expect(thought.get_by_role("textbox", name="Thought", exact=True)).to_have_value(text)
        expect(thought.get_by_role("tabpanel").locator(".create__where")).to_contain_text("Only you")
        thought.get_by_role("button", name=re.compile("^Save thought")).click()
        expect(window(page)).to_have_count(0)
        expect(page.locator(".ui-toast").filter(has_text="Thought saved to Your notes")).to_be_visible()
        drafts = self.api(page, "GET", f"/api/v1/workspaces/{self.ids['workspace']}/drafts?limit=100", status=200)["items"]
        self.assertEqual([(item["body"], item["visibility"]) for item in drafts if item["body"] == text], [(text, "private")])
        # What it was made from is done with: the next window starts blank.
        page.locator("body").press("c")
        expect(title_field(page)).to_have_value("")
        page.keyboard.press("Escape")

    def test_19_message_is_a_private_direct_message_with_nobody_chosen_by_default(self) -> None:
        """Message means one thing everywhere (the phone's "+" Message, New message): a direct message. Nobody is chosen until
        the person picks someone, so it cannot go to a project by mistake. Sending is covered in test_direct_messages."""
        self.ensure_account()
        page = self.page()
        self.open_window(page, f"/projects/{self.ids['project']}/tasks")
        title_field(page).fill("Who has the spare probe cables?")
        create_other(page, "Message")
        message = page.get_by_role("dialog", name="New message")
        panel = message.get_by_role("tabpanel")
        expect(panel.get_by_role("textbox", name="Message", exact=True)).to_have_value("Who has the spare probe cables?")
        expect(panel.locator(".create__where")).to_have_text("Nobody else is in your spaces yet")
        expect(panel.locator(".create__foot")).to_contain_text("only the two of you can read it")
        expect(panel.get_by_role("button", name=re.compile("^Send message"))).to_be_disabled()

    def test_20_decision_proposes_in_the_project_and_opens_it_in_details(self) -> None:
        self.ensure_account()
        page = self.page()
        self.open_window(page)
        text = f"Use capacitive probes only {uuid.uuid4().hex[:6]}"
        title_field(page).fill(text)
        create_other(page, "Decision")
        decision = page.get_by_role("dialog", name="New decision")
        expect(decision.get_by_role("textbox", name="Decision", exact=True)).to_have_value(text)
        decision.get_by_label("Why", exact=True).fill("Resistive probes corrode within a season")
        decision.get_by_role("button", name=re.compile("^Propose decision")).click()
        expect(window(page)).to_have_count(0)
        details = page.get_by_role("complementary", name="Details")
        expect(details.get_by_role("heading", name=text)).to_be_visible()
        stored = [item for item in self.api(page, "GET", f"/api/v1/projects/{self.ids['project']}/decisions?limit=100", status=200)["items"] if item["title"] == text]
        self.assertEqual(len(stored), 1)
        self.assertEqual(stored[0]["status"], "proposed")

    def test_21_project_creates_one_from_the_typed_name_and_a_template(self) -> None:
        self.ensure_account()
        page = self.page()
        self.open_window(page)
        name = f"Seed library {uuid.uuid4().hex[:6]}"
        title_field(page).fill(name)
        create_other(page, "Project")
        project = page.get_by_role("dialog", name="New project")
        expect(project.get_by_role("textbox", name="What is it about?", exact=True)).to_have_value(name)
        expect(project.get_by_role("tabpanel").locator(".create__where")).to_have_text("In Garden sensors")
        project.get_by_role("combobox", name="Start from").select_option("research")
        expect(project.get_by_role("tabpanel").locator(".create__foot")).to_contain_text("Starts with Conversation + Wiki")
        project.get_by_role("button", name=re.compile("^Create project")).click()
        expect(page.get_by_role("heading", level=1, name=name)).to_be_visible()
        expect(page).to_have_url(re.compile(r"/projects/[0-9a-f-]{36}"))
        made = [item for item in self.api(page, "GET", f"/api/v1/workspaces/{self.ids['workspace']}/projects?limit=100", status=200)["items"] if item["name"] == name]
        self.assertEqual(len(made), 1)

    def test_22_a_double_submit_sends_one_command_and_sources_stay_in_their_project(self) -> None:
        self.ensure_account()
        page = self.page()
        posts: list[str] = []
        creates = re.compile(r"/api/v1/(projects/[^/?]+/(?:work|conversations|decisions))$")
        page.on("request", lambda request: posts.append(creates.search(request.url).group(1)) if request.method == "POST" and creates.search(request.url) else None)
        twice = "() => { const form = document.querySelector('.create__panel:not([hidden])'); form.requestSubmit(); form.requestSubmit(); }"
        page.goto(f"/projects/{self.ids['project']}/tasks")
        field = open_from_tasks(page)
        title = f"Only once {uuid.uuid4().hex[:6]}"
        field.fill(title)
        page.evaluate(twice)
        expect(dialog(page)).to_have_count(0)
        self.assertEqual(posts, [f"projects/{self.ids['project']}/work"])
        self.assertEqual(len([item for item in self.work(page) if item["title"] == title]), 1)
        # The same guard holds in another tab.
        posts.clear()
        page.locator("body").press("c")
        title_field(page).fill(f"Proposed once {uuid.uuid4().hex[:6]}")
        create_other(page, "Decision")
        page.evaluate(twice)
        expect(window(page)).to_have_count(0)
        self.assertEqual(posts, [f"projects/{self.ids['project']}/decisions"])
        # A message's link belongs to its project: another project starts without it, so the task is made there.
        made = self.thread(page, "Sources stay home: label the bed rows")
        page.goto(f"/projects/{self.ids['project']}/conversations/{made['conversation']}")
        message = page.locator(f"#message-{made['message']}")
        message.hover()
        message.get_by_role("button", name="Create task", exact=True).click()
        links = dialog(page).get_by_role("button", name=re.compile("^Remove link to"))
        expect(links).to_have_count(1)
        dialog(page).get_by_role("combobox", name="Project").select_option(self.ids["other"])
        expect(links).to_have_count(0)
        submit_button(page).click()
        expect(dialog(page)).to_have_count(0)
        stored = [item for item in self.api(page, "GET", f"/api/v1/projects/{self.ids['other']}/work?limit=100", status=200)["items"] if item["title"] == "Sources stay home: label the bed rows"]
        self.assertEqual(len(stored), 1)
        self.assertEqual(stored[0]["links"], [])

    # ---------------------------------------------------------------- #521: the empty ⌘K

    def visit(self, page: Page, path: str, heading: str | None = None) -> None:
        page.goto(path)
        if heading:
            expect(page.get_by_role("heading", level=1, name=heading)).to_be_visible()

    def option_names(self, listbox) -> list[str]:
        """Each option's accessible name: a recent place is "<name> · <kind>" (its row shows the kind at the end, E02)."""
        expect(listbox.get_by_role("option").first).to_be_visible()
        return listbox.evaluate("el => [...el.querySelectorAll('[role=option]')].map((o) => o.getAttribute('aria-label') ?? o.querySelector('.jump__rtext').textContent)")

    def test_23_empty_command_k_lists_recent_places_then_the_actions_with_the_keyboard(self) -> None:
        self.ensure_account()
        page = self.page()
        project, other = self.ids["project"], self.ids["other"]
        doc = self.api(page, "POST", f"/api/v1/projects/{project}/docs", {"title": "How the garden sensors work", "body": "Probes, radio, battery."}, 201)
        # No recent place yet but the one in view: only the actions, and the list says so.
        self.visit(page, "/", "Home")
        page.evaluate("Object.keys(localStorage).filter((k) => k.startsWith('flux.places.recent.')).forEach((k) => localStorage.removeItem(k))")
        self.visit(page, "/", "Home")
        palette, field = self.jump(page, "")
        expect(palette.get_by_role("listbox", name="Actions")).to_be_visible()
        expect(palette.get_by_role("option")).to_have_text([re.compile("^New task"), re.compile("^Go to Inbox"), re.compile("^Focus mode"), re.compile("^Hide the sidebar")])
        page.keyboard.press("Escape")
        expect(palette).to_have_count(0)
        # Places by identity, most recent first: a second visit moves a place up once, a doc's version is its doc (named by
        # its own title), and the place in view and pages that are not places (not found) are left out.
        self.visit(page, f"/projects/{project}", "Community garden sensors")
        self.visit(page, f"/projects/{project}/tasks", "Community garden sensors")
        self.visit(page, f"/projects/{other}", "Cargo bike co-op")
        self.visit(page, f"/projects/{project}/tasks?status=open", "Community garden sensors")
        page.goto(f"/projects/{project}/docs/{doc['id']}/versions/1")
        expect(page.get_by_role("heading", name="How the garden sensors work").first).to_be_visible()
        page.goto(f"/projects/{project}/nowhere")
        expect(page.get_by_role("heading", name="This page doesn’t exist")).to_be_visible()
        self.visit(page, f"/projects/{project}", "Community garden sensors")
        palette, field = self.jump(page, "")
        listbox = palette.get_by_role("listbox", name="Recent places and actions")
        self.assertEqual(self.option_names(listbox), ["How the garden sensors work · Wiki", "Community garden sensors · Tasks", "Cargo bike co-op · Conversation", "Home",
                                                      "New task", "Go to Inbox", "Focus mode", "Hide the sidebar"])
        options = listbox.get_by_role("option")
        expect(options.first.locator(".jump__side")).to_have_text("Wiki")
        expect(options.nth(3).locator(".jump__side")).to_have_count(0)
        expect(listbox.locator(".jump__sh")).to_have_text(["Recent", "Actions"])
        expect(options.nth(5).locator(".jump__key")).to_have_text(["G", "I"])
        expect(palette.locator(".jump__foot")).to_have_text(re.compile(r"# task number.*@ people and agents"))
        shot(page, "521-empty-palette-1440-light")
        # ↑↓ move (and wrap), Enter opens, Esc closes.
        selected = palette.locator("[role=option][aria-selected=true]")
        expect(selected).to_have_attribute("aria-label", "How the garden sensors work · Wiki")
        field.press("ArrowUp")
        expect(selected).to_have_text(re.compile("^Hide the sidebar"))
        for _ in range(3):
            field.press("ArrowDown")
        expect(selected).to_have_attribute("aria-label", "Cargo bike co-op · Conversation")
        self.assertEqual(field.get_attribute("aria-activedescendant"), selected.get_attribute("id"))
        field.press("Enter")
        expect(palette).to_have_count(0)
        expect(page).to_have_url(re.compile(rf"/projects/{other}$"))
        palette, field = self.jump(page, "")
        names = self.option_names(palette.get_by_role("listbox", name="Recent places and actions"))
        self.assertEqual(names[:2], ["Community garden sensors · Conversation", "How the garden sensors work · Wiki"])
        # The Wiki page opens at the doc itself, not the version that was open.
        palette.get_by_role("option", name="How the garden sensors work · Wiki", exact=True).click()
        expect(page).to_have_url(re.compile(rf"/projects/{project}/docs/{doc['id']}$"))
        palette, field = self.jump(page, "")
        field.press("Escape")
        expect(palette).to_have_count(0)

    def test_24_focus_mode_and_hide_the_sidebar_run_from_the_empty_command_k(self) -> None:
        self.ensure_account()
        page = self.page()
        self.visit(page, f"/projects/{self.ids['project']}", "Community garden sensors")
        side = page.get_by_role("complementary", name="Sidebar")
        expect(side.locator(".side--rail")).to_have_count(0)
        palette, field = self.jump(page, "")
        field.press("ArrowUp")  # the last action
        expect(palette.locator("[role=option][aria-selected=true]")).to_have_text(re.compile("^Hide the sidebar"))
        field.press("Enter")
        expect(side.locator(".side--rail")).to_have_count(1)
        palette, field = self.jump(page, "")
        palette.get_by_role("option", name="Show the sidebar", exact=True).click()
        expect(side.locator(".side--rail")).to_have_count(0)
        pill = page.get_by_role("button", name=re.compile(r"^Focus · notifications paused until"))
        palette, field = self.jump(page, "")
        palette.get_by_role("option", name="Focus mode", exact=True).click()
        expect(pill).to_be_visible()
        expect(side.locator(".side--rail")).to_have_count(1)
        self.assertIsNotNone(self.api(page, "GET", "/api/v1/notification-preferences", status=200)["pause"]["until"])
        # Focus folds the sidebar to its rail, so the action says what it would do now.
        palette, field = self.jump(page, "")
        expect(palette.get_by_role("option", name="Show the sidebar", exact=True)).to_be_visible()
        expect(palette.get_by_role("option", name="Hide the sidebar", exact=True)).to_have_count(0)
        palette.get_by_role("option", name="Focus mode", exact=True).click()
        expect(pill).to_have_count(0)
        expect(side.locator(".side--rail")).to_have_count(0)
        self.assertIsNone(self.api(page, "GET", "/api/v1/notification-preferences", status=200)["pause"]["until"])

    def test_25_the_phone_search_sheet_shows_the_same_empty_content_without_keys(self) -> None:
        self.ensure_account()
        page = self.page(phone=True)
        page.goto(f"/projects/{self.ids['other']}")
        expect(page.locator(".project-convo")).to_be_visible()
        page.goto(f"/projects/{self.ids['project']}/tasks")
        expect(page.get_by_role("button", name="Search", exact=True)).to_be_visible()
        page.get_by_role("button", name="Search", exact=True).tap()
        sheet = page.get_by_role("dialog", name="Jump to")
        listbox = sheet.get_by_role("listbox", name="Recent places and actions")
        # The same recent places and actions; the phone has no sidebar to hide and no focus mode, and no keys to press.
        self.assertEqual(self.option_names(listbox), ["Cargo bike co-op · Conversation", "Home", "New task", "Go to Inbox"])
        expect(listbox.locator(".jump__keys").first).to_be_hidden()
        for option in listbox.get_by_role("option").all():
            self.assertGreaterEqual(option.bounding_box()["height"], 44)
        listbox.get_by_role("option", name="Go to Inbox", exact=True).tap()
        expect(page).to_have_url(re.compile(r"/inbox$"))

    def test_26_screenshots_of_the_tabs_and_the_empty_command_k(self) -> None:
        """Evidence for the visual review (AC-3): computer 1440 and phone 390, light and dark, Chromium and WebKit."""
        self.ensure_account()
        user = self.api(self.page(), "GET", "/api/v1/me", status=200)["user"]["id"]
        places = [{"key": f"project:{self.ids['other']}:conversation", "path": f"/projects/{self.ids['other']}"}, {"key": "home", "path": "/"}]
        webkit = self.pw.webkit.launch()
        self.addCleanup(webkit.close)
        for engine, browser in (("chromium", self.browser), ("webkit", webkit)):
            for scheme in ("light", "dark"):
                for phone in (False, True):
                    size = "390" if phone else "1440"
                    page = self.page(scheme, phone=phone, browser=browser)
                    # The recent places this device already holds (test_23 builds them by visiting): one load, so no
                    # navigation interrupts a page's reads.
                    page.add_init_script(f"localStorage.setItem({json.dumps('flux.places.recent.' + user)}, {json.dumps(json.dumps(places))})")
                    page.goto(f"/projects/{self.ids['project']}/tasks")
                    if phone:
                        page.get_by_role("button", name="Create", exact=True).tap()
                        page.get_by_role("dialog", name="Create").get_by_role("button", name="Task", exact=True).tap()
                    else:
                        expect(page.get_by_role("heading", level=1, name="Community garden sensors")).to_be_visible()
                        page.locator("body").press("c")
                    expect(title_field(page)).to_be_visible()
                    title_field(page).fill("Order two spare capacitive probes")
                    shot(page, f"521-create-task-{size}-{scheme}-{engine}")
                    kind_tab(page, "Message").click()
                    expect(page.get_by_role("dialog", name="New message").get_by_role("textbox", name="Message", exact=True)).to_be_visible()
                    shot(page, f"521-create-message-{size}-{scheme}-{engine}")
                    kind_tab(page, "Project").click()
                    expect(page.get_by_role("dialog", name="New project").get_by_role("textbox", name="What is it about?", exact=True)).to_be_visible()
                    shot(page, f"521-create-project-{size}-{scheme}-{engine}")
                    page.keyboard.press("Escape")
                    expect(window(page)).to_have_count(0)
                    if phone:
                        page.get_by_role("button", name="Search", exact=True).tap()
                    else:
                        page.keyboard.press("Control+k")
                    expect(page.get_by_role("dialog", name="Jump to").get_by_role("listbox", name="Recent places and actions")).to_be_visible()
                    shot(page, f"521-empty-palette-{size}-{scheme}-{engine}")

    def test_27_the_window_and_its_controls_keep_their_place_across_the_tabs(self) -> None:
        """Spokój rule 7: the tabs, Close and the primary action stay where they are whichever tab shows (1440 and 390)."""
        self.ensure_account()
        webkit = self.pw.webkit.launch()
        self.addCleanup(webkit.close)
        settle = "() => Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => null)))"
        for engine, browser, phone in (("chromium", self.browser, False), ("chromium", self.browser, True), ("webkit", webkit, True)):
            with self.subTest(engine=engine, phone=phone):
                page = self.page(phone=phone, browser=browser)
                page.goto(f"/projects/{self.ids['project']}/tasks")
                if phone:
                    page.get_by_role("button", name="Create", exact=True).tap()
                    page.get_by_role("dialog", name="Create").get_by_role("button", name="Task", exact=True).tap()
                else:
                    expect(page.get_by_role("heading", level=1, name="Community garden sensors")).to_be_visible()
                    page.locator("body").press("c")
                expect(title_field(page)).to_be_visible()
                title_field(page).fill("Order two spare capacitive probes")
                boxes: dict[str, dict] = {}
                for tab in ("Task", "Thought", "Message", "Decision", "Project", "Task"):
                    kind_tab(page, tab).click()
                    expect(kind_tab(page, tab)).to_have_attribute("aria-selected", "true")
                    page.evaluate(settle)
                    shown = {"window": window(page), "tabs": window(page).get_by_role("tablist", name="Create"),
                             "close": window(page).get_by_role("button", name="Close"), "primary": window(page).get_by_role("tabpanel").locator(".create__go")}
                    now = {name: target.bounding_box() for name, target in shown.items()}
                    for name, box in now.items():
                        assert box, name
                        if name in boxes:
                            for edge in ("x", "y", "width", "height"):
                                if name == "primary" and edge in ("x", "width") and not phone:
                                    continue  # each kind's own label ("Create task", "Save thought") sets the button's width
                                self.assertAlmostEqual(box[edge], boxes[name][edge], delta=0.5, msg=f"{engine} {'390' if phone else '1440'} {name} {edge} on {tab}")
                        else:
                            boxes[name] = box
                    if not phone:
                        # The primary action keeps its right edge on the computer.
                        self.assertAlmostEqual(now["primary"]["x"] + now["primary"]["width"], boxes["primary"]["x"] + boxes["primary"]["width"], delta=0.5)

    def test_28_a_one_line_field_shows_carried_lines_on_one_line_and_keeps_the_text(self) -> None:
        self.ensure_account()
        page = self.page()
        self.open_window(page)
        create_other(page, "Thought")
        thought = page.get_by_role("dialog", name="New thought").get_by_role("textbox", name="Thought", exact=True)
        thought.fill("line one\nline two")
        kind_tab(page, "Task").click()
        expect(title_field(page)).to_have_value("line one line two")
        kind_tab(page, "Decision").click()
        expect(page.get_by_role("dialog", name="New decision").get_by_role("textbox", name="Decision", exact=True)).to_have_value("line one line two")
        kind_tab(page, "Project").click()
        expect(page.get_by_role("dialog", name="New project").get_by_role("textbox", name="What is it about?", exact=True)).to_have_value("line one line two")
        kind_tab(page, "Thought").click()
        expect(thought).to_have_value("line one\nline two")

    def test_29_recent_places_leave_with_the_account_on_sign_out(self) -> None:
        """Runs last: the account signs in again and the shared session follows it."""
        self.ensure_account()
        page = self.page()
        self.visit(page, f"/projects/{self.ids['other']}", "Cargo bike co-op")
        self.visit(page, "/", "Home")
        self.assertTrue(page.evaluate("Object.keys(localStorage).some((k) => k.startsWith('flux.places.recent.'))"))
        page.get_by_role("button", name=re.compile("Ada Create")).click()
        page.get_by_role("dialog", name="Account").get_by_role("button", name="Sign out").click()
        expect(page).to_have_url(re.compile(r"/sign-in"))
        self.assertEqual(page.evaluate("Object.keys(localStorage).filter((k) => k.startsWith('flux.places.recent.'))"), [])
        # Signing in again on a project page (not Home): nothing remembered from before, so ⌘K lists only the actions.
        page.goto(f"/projects/{self.ids['project']}/tasks")
        expect(page).to_have_url(re.compile(r"/sign-in"))
        page.get_by_label("Email").fill(EMAIL)
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Sign in").click()
        expect(page).to_have_url(re.compile(rf"/projects/{self.ids['project']}/tasks"))
        expect(page.get_by_role("heading", level=1, name="Community garden sensors")).to_be_visible()
        type(self).state = page.context.storage_state()
        palette, field = self.jump(page, "")
        expect(palette.get_by_role("listbox", name="Actions")).to_be_visible()
        expect(palette.get_by_role("option", name=re.compile("Cargo bike co-op|^Home"))).to_have_count(0)
        expect(palette).to_contain_text("Only what you can open is searched.")

if __name__ == "__main__":
    unittest.main()
