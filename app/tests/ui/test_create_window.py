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

from create_window import dialog, open_from_tasks, submit_button, title_field
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

    def page(self, scheme: str = "light", phone: bool = False) -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": scheme, "locale": "en-GB", "timezone_id": "Europe/Warsaw",
                         "service_workers": "block", "viewport": PHONE if phone else DESKTOP, "device_scale_factor": 1}
        if phone:
            options.update(is_mobile=True, has_touch=True)
        if self.state:
            options["storage_state"] = self.state
        context = self.browser.new_context(**options)
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
        message.get_by_role("button", name="Task", exact=True).click()
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
        expect(page.locator(f'.convo-notice[data-work-id="{made[0]["id"]}"] .convo-notice__kind')).to_have_text("New task · ")

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
        palette, field = self.jump(page, "")
        expect(palette.get_by_role("option", name="New thought on the Map")).to_be_visible()
        palette.get_by_role("option", name="New thought on the Map").click()
        expect(page).to_have_url(re.compile(rf"/projects/{self.ids['project']}/map$"))

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
            page.get_by_role("button", name="Open navigation").click()
            page.get_by_role("dialog", name="Flux").get_by_role("button", name=re.compile("^New")).tap()
            sheet = dialog(page)
            expect(sheet).to_be_visible()
            tiles = sheet.get_by_role("group", name="What to create")
            self.assertEqual([item.strip() for item in tiles.get_by_role("button").all_inner_texts()], ["Task", "Thought", "Message", "Decision", "Project", "Private note"])
            for tile in tiles.get_by_role("button").all():
                self.assertGreaterEqual(tile.bounding_box()["height"], 44)
            shot(page, f"345-create-sheet-390-{scheme}")
            sheet.get_by_label("Or just type").fill("Print labels for the beds")
            sheet.get_by_label("Or just type").press("Enter")
            expect(title_field(page)).to_have_value("Print labels for the beds")
            for control in (sheet.get_by_label("Details"), sheet.get_by_role("combobox", name="Status"), sheet.get_by_role("combobox", name="Owner"),
                            sheet.get_by_role("button", name="+ Link a message or thought"), sheet.get_by_role("switch"), submit_button(page)):
                expect(control).to_be_visible()
            box = submit_button(page).bounding_box()
            self.assertGreaterEqual(box["height"], 44)
            self.assertLessEqual(box["x"] + box["width"], PHONE["width"])
            shot(page, f"345-create-task-sheet-390-{scheme}")
            sheet.get_by_role("combobox", name="Project").select_option(self.ids["other"])
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
            page.goto(f"/projects/{self.ids['project']}")
            page.get_by_role("button", name="Open navigation").click()
            page.get_by_role("dialog", name="Flux").get_by_role("button", name="Search", exact=True).tap()
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


if __name__ == "__main__":
    unittest.main()
