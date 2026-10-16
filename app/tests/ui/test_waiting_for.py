"""Blocked tasks wait for a person (#550): the Details picker, the Create window, the Inbox item of the person
waited on, and the one short line in the project conversation. Computer and phone. Ada owns the task and Kai is the
person she waits for. Screenshots (waiting-for-*.png) go to FLUX_UI_SCREENSHOTS."""
from __future__ import annotations

import re
import unittest
import uuid

from playwright.sync_api import expect, sync_playwright

from create_window import dialog, open_from_tasks, submit_button
from test_app_shell import ORIGIN, UPSTREAM, shot, start_forwarder
from test_work_pagination import api

PASSWORD = "Waiting for a person, calmly"


class WaitingFor(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if UPSTREAM: start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start(); cls.browser = cls.pw.chromium.launch(); expect.set_options(timeout=10000)
        cls.ada_ctx = cls.browser.new_context(service_workers="block", base_url=ORIGIN)
        cls.kai_ctx = cls.browser.new_context(service_workers="block", base_url=ORIGIN)
        stamp = uuid.uuid4().hex[:8]
        api(cls.ada_ctx, "POST", "/api/auth/sign-up/email", {"name": "Ada Kowalska", "email": f"wf-ada-{stamp}@example.test", "password": PASSWORD})
        cls.ada = api(cls.ada_ctx, "GET", "/api/v1/me")["user"]["id"]
        kai_email = f"wf-kai-{stamp}@example.test"
        api(cls.kai_ctx, "POST", "/api/auth/sign-up/email", {"name": "Kai Nowak", "email": kai_email, "password": PASSWORD})
        cls.kai = api(cls.kai_ctx, "GET", "/api/v1/me")["user"]["id"]
        cls.workspace = api(cls.ada_ctx, "POST", "/api/v1/workspaces", {"name": "Riverside makers"}, 201)["id"]
        api(cls.ada_ctx, "POST", f"/api/v1/workspaces/{cls.workspace}/members", {"email": kai_email, "role": "member"}, 201)
        cls.project = api(cls.ada_ctx, "POST", f"/api/v1/workspaces/{cls.workspace}/projects", {"name": "Library lighting", "visibility": "restricted"}, 201)["id"]
        api(cls.ada_ctx, "POST", f"/api/v1/projects/{cls.project}/grants", {"principal": {"kind": "human", "id": cls.kai}, "role": "contributor"}, 201)
        cls.root = f"/api/v1/projects/{cls.project}"

    @classmethod
    def tearDownClass(cls): cls.browser.close(); cls.pw.stop()

    def page(self, who: str, phone: bool = False):
        ctx = self.browser.new_context(service_workers="block", base_url=ORIGIN, storage_state=(self.ada_ctx if who == "ada" else self.kai_ctx).storage_state(),
            viewport={"width": 390 if phone else 1440, "height": 844 if phone else 900}, device_scale_factor=2 if phone else 1, is_mobile=phone, has_touch=phone, locale="en-GB")
        self.addCleanup(ctx.close); page = ctx.new_page(); errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught browser errors")); return page

    def task(self, title: str, **fields):
        return api(self.ada_ctx, "POST", self.root + "/work", {"title": title, "owner": {"kind": "human", "id": self.ada}, **fields}, 201)

    def block(self, task, **fields):
        return api(self.ada_ctx, "PATCH", f"/api/v1/work/{task['id']}", {"status": "blocked", "expectedVersion": task["version"], **fields})

    def panel(self, page, task):
        page.goto(f"/projects/{self.project}/tasks?open=work:{task['id']}")
        panel = page.locator(f".wd[data-detail-kind='work'][data-detail-id='{task['id']}']"); expect(panel).to_be_visible()
        expect(panel.locator("[data-detail-relations-phase]")).to_have_attribute("data-detail-relations-phase", "ready"); return panel

    def test_01_the_details_panel_names_who_it_waits_for_and_undo_puts_it_back(self):
        for phone in (False, True):
            with self.subTest(phone=phone):
                task = self.block(self.task(f"Order the light sensors {'phone' if phone else 'computer'}"), blocker="Waiting for the price list")
                page = self.page("ada", phone); panel = self.panel(page, task)
                picker = panel.get_by_role("combobox", name="Waiting for")
                expect(picker).to_have_value("")
                with page.expect_response(lambda r: r.request.method == "PATCH" and r.url.endswith(f"/api/v1/work/{task['id']}")) as saved:
                    picker.select_option(label="Kai Nowak")
                self.assertEqual(saved.value.status, 200)
                stored = api(self.ada_ctx, "GET", f"/api/v1/work/{task['id']}")
                self.assertEqual(stored["waitingFor"]["id"], self.kai)
                self.assertEqual(stored["blocker"], "Waiting for the price list")
                expect(picker).to_have_value(self.kai)
                shot(page, f"waiting-for-details-{'phone' if phone else 'computer'}")
                # Resolving ends the wait; the toast's Undo puts the reason and the person back without a second blocker message.
                panel.get_by_role("button", name="Resolve").click()
                expect(panel.get_by_role("combobox", name="Waiting for")).to_have_count(0)
                self.assertIsNone(api(self.ada_ctx, "GET", f"/api/v1/work/{task['id']}")["waitingFor"])
                page.get_by_role("button", name="Undo").click()
                expect(panel.get_by_role("combobox", name="Waiting for")).to_have_value(self.kai)
                back = api(self.ada_ctx, "GET", f"/api/v1/work/{task['id']}")
                self.assertEqual((back["status"], back["blocker"], back["waitingFor"]["id"]), ("blocked", "Waiting for the price list", self.kai))

    def test_02_the_create_window_offers_waiting_for_only_while_blocked(self):
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page("ada", phone); page.goto(f"/projects/{self.project}/tasks")
                title = f"Book the lift {'phone' if phone else 'computer'}"
                open_from_tasks(page).fill(title)
                expect(dialog(page).get_by_role("combobox", name="Waiting for")).to_have_count(0)
                dialog(page).get_by_role("combobox", name="Status").select_option("blocked")
                dialog(page).get_by_label("What is it waiting for?").fill("Venue confirmation")
                dialog(page).get_by_role("combobox", name="Waiting for").select_option(label="Kai Nowak")
                shot(page, f"waiting-for-create-{'phone' if phone else 'computer'}")
                submit_button(page).click(); expect(dialog(page)).to_have_count(0)
                stored = next(item for item in api(self.ada_ctx, "GET", self.root + "/work?limit=100")["items"] if item["title"] == title)
                self.assertEqual((stored["status"], stored["waitingFor"]["id"]), ("blocked", self.kai))

    def test_03_the_person_waited_on_has_an_inbox_item_with_open_task(self):
        for phone in (False, True):
            with self.subTest(phone=phone):
                title = f"Choose the diffuser {'phone' if phone else 'computer'}"
                task = self.block(self.task(title), blocker="Which finish?", waitingFor={"kind": "human", "id": self.kai})
                page = self.page("kai", phone); page.goto("/inbox")
                heading = f"Ada Kowalska is waiting for you: #{task['number']} {title} · Which finish?"
                item = page.get_by_role("listitem").filter(has=page.get_by_role("button", name=heading))
                expect(item.first).to_be_visible()
                expect(item.first.get_by_role("button", name="Unblock")).to_have_count(0)
                shot(page, f"waiting-for-inbox-{'phone' if phone else 'computer'}")
                item.first.get_by_role("button", name="Open task").click()
                expect(page.locator(f".wd[data-detail-id='{task['id']}']")).to_be_visible()
                expect(page.get_by_role("combobox", name="Waiting for")).to_have_value(self.kai)

    def test_04_the_conversation_shows_one_line_for_blocked_and_one_for_unblocked(self):
        for phone in (False, True):
            with self.subTest(phone=phone):
                task = self.task(f"Hang the shelf lamp {'phone' if phone else 'computer'}")
                blocked = self.block(task, blocker="Missing bracket", waitingFor={"kind": "human", "id": self.kai})
                edited = api(self.ada_ctx, "PATCH", f"/api/v1/work/{task['id']}", {"blocker": "Missing bracket, ordered", "expectedVersion": blocked["version"]})
                api(self.ada_ctx, "PATCH", f"/api/v1/work/{task['id']}", {"status": "in_progress", "expectedVersion": edited["version"]})
                page = self.page("ada", phone); page.goto(f"/projects/{self.project}")
                number = task["number"]
                # Three updates in a row fold into one line (S8); open every fold so each line can be read.
                expect(page.locator(".convo-notice, .convo-fold").first).to_be_visible()
                closed = page.locator(".convo-fold__b[aria-expanded='false']")
                while closed.count(): closed.first.click()
                line_blocked = page.get_by_role("button", name=re.compile(rf"^Open task #{number} ")).filter(has_text=f"#{number} blocked · waiting for Kai Nowak")
                expect(line_blocked).to_have_count(1)
                expect(page.get_by_text(f"#{number} unblocked", exact=True)).to_have_count(1)
                expect(page.get_by_text(re.compile(rf"#{number} blocked"))).to_have_count(1, timeout=2000)
                shot(page, f"waiting-for-conversation-{'phone' if phone else 'computer'}")
                line_blocked.click()
                expect(page.locator(f".wd[data-detail-id='{task['id']}']")).to_be_visible()


if __name__ == "__main__":
    unittest.main()
