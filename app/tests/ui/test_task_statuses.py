"""A task has four states and a done task has a line (#868): "Not pursued" is Done with a "dropped" note, and "What came
of it" is the one optional line at Done, also written once in the task's discussion. The panel's row, the Dropped check,
Undo, the Board card, the List row and the discussion. Computer and phone. Screenshots (task-statuses-*.png) go to
FLUX_UI_SCREENSHOTS."""
from __future__ import annotations

import re
import unittest
import uuid

from playwright.sync_api import expect, sync_playwright

from test_app_shell import ORIGIN, UPSTREAM, shot, start_forwarder
from test_work_pagination import api

PASSWORD = "Four states, one line, calmly"


class TaskStatuses(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if UPSTREAM: start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start(); cls.browser = cls.pw.chromium.launch(); expect.set_options(timeout=10000)
        cls.ada_ctx = cls.browser.new_context(service_workers="block", base_url=ORIGIN)
        stamp = uuid.uuid4().hex[:8]
        api(cls.ada_ctx, "POST", "/api/auth/sign-up/email", {"name": "Ada Kowalska", "email": f"ts-ada-{stamp}@example.test", "password": PASSWORD})
        cls.ada = api(cls.ada_ctx, "GET", "/api/v1/me")["user"]["id"]
        cls.workspace = api(cls.ada_ctx, "POST", "/api/v1/workspaces", {"name": "Garden sensors"}, 201)["id"]
        cls.project = api(cls.ada_ctx, "POST", f"/api/v1/workspaces/{cls.workspace}/projects", {"name": "Rain barrel monitor", "visibility": "restricted"}, 201)["id"]
        cls.root = f"/api/v1/projects/{cls.project}"

    @classmethod
    def tearDownClass(cls): cls.browser.close(); cls.pw.stop()

    def page(self, phone: bool = False):
        ctx = self.browser.new_context(service_workers="block", base_url=ORIGIN, storage_state=self.ada_ctx.storage_state(),
            viewport={"width": 390 if phone else 1440, "height": 844 if phone else 900}, device_scale_factor=2 if phone else 1, is_mobile=phone, has_touch=phone, locale="en-GB")
        self.addCleanup(ctx.close); page = ctx.new_page(); errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught browser errors")); return page

    def task(self, title: str, status: str = "in_progress"):
        made = api(self.ada_ctx, "POST", self.root + "/work", {"title": title, "owner": {"kind": "human", "id": self.ada}}, 201)
        if status == "open": return made
        return api(self.ada_ctx, "PATCH", f"/api/v1/work/{made['id']}", {"status": status, "expectedVersion": made["version"]})

    def get(self, task):
        return api(self.ada_ctx, "GET", f"/api/v1/work/{task['id']}")

    def panel(self, page, task):
        page.goto(f"/projects/{self.project}/tasks?open=work:{task['id']}")
        panel = page.locator(f".wd[data-detail-kind='work'][data-detail-id='{task['id']}']"); expect(panel).to_be_visible()
        expect(panel.locator("[data-detail-relations-phase]")).to_have_attribute("data-detail-relations-phase", "ready"); return panel

    def choose_state(self, page, panel, word: str):
        panel.get_by_role("button", name="Status", exact=True).click()
        page.get_by_role("menuitemradio", name=re.compile(rf"^{word}")).click()

    def test_01_done_has_one_optional_line_that_is_also_written_in_the_discussion(self):
        for phone in (False, True):
            with self.subTest(phone=phone):
                tag = "phone" if phone else "computer"; line = f"Replaced the float switch, readings steady {tag}"
                task = self.task(f"Calibrate the overflow sensor {tag}")
                page = self.page(phone); panel = self.panel(page, task)
                expect(panel.get_by_text("What came of it", exact=True)).to_have_count(0)
                self.choose_state(page, panel, "Done")
                row = panel.locator(".wd-row").filter(has_text="What came of it")
                expect(row).to_be_visible()
                self.assertEqual(self.get(task)["status"], "done")
                row.get_by_role("button", name="What came of it, add a line").click()
                field = row.get_by_label("What came of it", exact=True)
                field.fill(line)
                with page.expect_response(lambda r: r.request.method == "PATCH" and r.url.endswith(f"/api/v1/work/{task['id']}")) as saved:
                    field.press("Enter")
                self.assertEqual(saved.value.status, 200)
                stored = self.get(task)
                self.assertEqual((stored["status"], stored["cameOfIt"], stored["dropped"]), ("done", line, False))
                expect(row).to_contain_text(line)
                # The line is also written once in the task's discussion, marked as what came of it.
                messages = api(self.ada_ctx, "GET", f"/api/v1/work/{task['id']}/discussion")["messages"]
                written = [m for m in messages if m.get("contribution", {}).get("kind") == "came_of_it"]
                self.assertEqual([m["body"] for m in written], [line])
                expect(panel.get_by_text("What came of it", exact=True)).to_have_count(2)
                shot(page, f"task-statuses-line-{tag}")

    def test_02_dropped_is_done_with_a_note_on_the_panel_the_board_and_the_list(self):
        for phone in (False, True):
            with self.subTest(phone=phone):
                tag = "phone" if phone else "computer"; title = f"Fit a second rain gauge {tag}"
                task = self.task(title, "open")
                page = self.page(phone); panel = self.panel(page, task)
                self.choose_state(page, panel, "Done")
                panel.get_by_role("checkbox", name="Dropped, not finished").click()
                expect(panel.get_by_role("checkbox", name="Dropped, not finished")).to_be_checked()
                expect(panel.get_by_role("button", name="Status", exact=True)).to_contain_text("Done · dropped")
                stored = self.get(task)
                self.assertEqual((stored["status"], stored["dropped"], stored["cameOfIt"]), ("done", True, None))
                page.goto(f"/projects/{self.project}/tasks")
                if not phone: page.get_by_role("radio", name="Board", exact=True).click()
                expect(page.locator(f".tb-card[data-card-id='{task['id']}'] .tb-card__state")).to_have_text("dropped")
                shot(page, f"task-statuses-board-{tag}")
                page.get_by_role("radio", name="List", exact=True).click()
                expect(page.locator(".ws-task").filter(has_text=title).first).to_contain_text("Done · dropped")
                shot(page, f"task-statuses-list-{tag}")

    def test_03_leaving_done_clears_the_note_and_undo_puts_it_back(self):
        task = self.task("Seal the junction box")
        api(self.ada_ctx, "PATCH", f"/api/v1/work/{task['id']}", {"status": "done", "dropped": True, "cameOfIt": "Not needed, the box was replaced", "expectedVersion": task["version"]})
        page = self.page(); panel = self.panel(page, task)
        expect(panel.get_by_role("checkbox", name="Dropped, not finished")).to_be_checked()
        self.choose_state(page, panel, "Doing")
        expect(panel.locator(".wd-row").filter(has_text="What came of it")).to_have_count(0)
        left = self.get(task)
        self.assertEqual((left["status"], left["dropped"], left["cameOfIt"]), ("in_progress", False, None))
        page.get_by_role("button", name="Undo").click()
        expect(panel.get_by_role("checkbox", name="Dropped, not finished")).to_be_checked()
        back = self.get(task)
        self.assertEqual((back["status"], back["dropped"], back["cameOfIt"]), ("done", True, "Not needed, the box was replaced"))
        # Putting the line back does not write it in the discussion again.
        messages = api(self.ada_ctx, "GET", f"/api/v1/work/{task['id']}/discussion")["messages"]
        self.assertEqual(len([m for m in messages if m.get("contribution", {}).get("kind") == "came_of_it"]), 1)

    def test_04_the_task_panel_has_no_result_button_and_a_board_has_four_columns(self):
        task = self.task("Check the barrel lid")
        page = self.page(); panel = self.panel(page, task)
        expect(panel.get_by_role("button", name="Attach a result")).to_have_count(0)
        expect(panel.get_by_role("button", name="Status", exact=True)).to_be_visible()
        page.goto(f"/projects/{self.project}/tasks")
        page.get_by_role("radio", name="Board", exact=True).click()
        for word in ("To do", "Doing", "Blocked", "Done"):
            expect(page.get_by_role("heading", name=re.compile(rf"^{word}\b")).first).to_be_visible()
        expect(page.get_by_text("Not pursued")).to_have_count(0)


if __name__ == "__main__":
    unittest.main()
