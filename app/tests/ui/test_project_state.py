"""Persisted native state agrees across the project header, phone overview and Tasks (#136).

Actual authenticated browser/API data; viewport captures are emulation, not device acceptance.
"""
from __future__ import annotations

import json
import re
import unittest
import uuid

from playwright.sync_api import expect, sync_playwright

from test_app_shell import ORIGIN, UPSTREAM, shot, start_forwarder


class ProjectStateJourney(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        expect.set_options(timeout=8000)
        cls.accounts = {}
        for name in ("Ada State", "Jonas Reader"):
            context = cls.browser.new_context(base_url=ORIGIN)
            page = context.new_page()
            page.goto("/sign-up")
            page.get_by_label("Name").fill(name)
            email = f"state-{uuid.uuid4()}@example.test"
            page.get_by_label("Email").fill(email)
            page.get_by_label("Password").fill("native state stays truthful")
            page.get_by_role("button", name="Create account").click()
            expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
            me = cls.call(page, "GET", "/api/v1/me")["user"]
            cls.accounts[name] = {"id": me["id"], "email": email, "state": context.storage_state()}
            context.close()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    @staticmethod
    def call(page, method, path, body=None, status=200, headers=None):
        response = page.request.fetch(ORIGIN + path, method=method,
            headers={"origin": ORIGIN, "content-type": "application/json", **(headers or {})},
            data=json.dumps(body) if body is not None else None)
        if response.status != status:
            raise AssertionError(f"{method} {path}: {response.status}, expected {status}: {response.text()}")
        return response.json() if response.text() else None

    def page(self, who="Ada State", width=1280, height=800, dark=False):
        context = self.browser.new_context(base_url=ORIGIN, viewport={"width": width, "height": height},
            storage_state=self.accounts[who]["state"], color_scheme="dark" if dark else "light",
            is_mobile=width <= 640, has_touch=width <= 640)
        self.addCleanup(context.close)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught browser errors"))
        return page

    def assert_text_is_unclipped(self, locator):
        self.assertTrue(locator.evaluate("el => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1"), "the visible label is not clipped")

    def scene(self):
        owner = self.page()
        ws = self.call(owner, "POST", "/api/v1/workspaces", {"name": "Riverside Makers"}, 201)
        self.call(owner, "POST", f"/api/v1/workspaces/{ws['id']}/members",
            {"email": self.accounts["Jonas Reader"]["email"], "role": "member"}, 201)
        project = self.call(owner, "POST", f"/api/v1/workspaces/{ws['id']}/projects",
            {"name": "Gesture lamp", "visibility": "restricted"}, 201)
        self.call(owner, "POST", f"/api/v1/projects/{project['id']}/grants",
            {"principal": {"kind": "human", "id": self.accounts["Jonas Reader"]["id"]}, "role": "viewer"}, 201)
        return owner, project

    def work(self, page, project, title, status="open"):
        return self.call(page, "POST", f"/api/v1/projects/{project['id']}/work", {"title": title, "status": status}, 201)

    def test_01_open_task_is_visible_in_header_and_tasks_and_opens_the_actual_object(self):
        page, project = self.scene()
        page.goto(f"/projects/{project['id']}")
        state = page.locator("header.top").get_by_label("Current state")
        expect(state).to_contain_text("No decisions or work yet")
        task = self.work(page, project, "Prepare the ToF sensor experiment for the library")
        page.reload()
        shot(page, "136-state-single-open-desktop")
        expect(state).to_contain_text("1 open task")
        self.assert_text_is_unclipped(state.locator('[data-seg="open"] > span'))
        expect(state).not_to_contain_text("No decisions or work yet")
        state.locator('[data-seg="open"]').click()
        expect(page.locator("#details").get_by_role("heading", name=task["title"], exact=True)).to_be_visible()
        page.get_by_role("button", name="Close details", exact=True).click()
        page.locator('[data-tab="tasks"]').click()
        expect(page.locator(".ws-item").filter(has_text=task["title"])).to_be_visible()
        self.assertEqual(self.call(page, "GET", f"/api/v1/projects/{project['id']}/work")["total"], 1)

    def test_02_closed_native_work_is_history_and_a_persisted_status_update_replaces_the_open_summary(self):
        page, project = self.scene()
        task = self.work(page, project, "Measure low-light gesture reliability")
        page.goto(f"/projects/{project['id']}")
        state = page.locator("header.top").get_by_label("Current state")
        expect(state).to_contain_text("1 open task")
        task = self.call(page, "PATCH", f"/api/v1/work/{task['id']}", {"status": "blocked", "blocker": "Waiting for the sensor delivery"},
            headers={"if-match": f'"{task["version"]}"'})
        page.reload()
        expect(state).to_contain_text("1 blocked")
        expect(state.locator('[data-seg="open"]')).to_have_count(0)
        self.call(page, "PATCH", f"/api/v1/work/{task['id']}", {"status": "done", "blocker": None},
            headers={"if-match": f'"{task["version"]}"'})
        page.reload()
        expect(state).to_contain_text("1 completed task")
        expect(state).not_to_contain_text("No decisions or work yet")
        state.locator('[data-seg="history"]').click()
        expect(page.locator("#details").get_by_role("heading", name=task["title"], exact=True)).to_be_visible()
        self.work(page, project, "Camera-only direction was not pursued", "not_pursued")
        page.get_by_role("button", name="Close details", exact=True).click()
        page.reload()
        expect(state).to_contain_text("1 completed task · 1 not pursued")
        self.assert_text_is_unclipped(state.locator('[data-seg="history"] > span'))
        shot(page, "136-state-retained-history-desktop")

    def test_03_phone_and_tablet_readers_share_current_counts_and_reachable_details_without_write_access(self):
        owner, project = self.scene()
        task = self.work(owner, project, "Prepare the ToF sensor experiment for the library")
        self.work(owner, project, "Keep a manual switch available")
        for width, height, dark in ((320, 740, False), (390, 844, True), (820, 1180, False), (1280, 800, False)):
            with self.subTest(width=width, dark=dark):
                page = self.page("Jonas Reader", width, height, dark)
                page.goto(f"/projects/{project['id']}")
                expect(page.get_by_role("heading", name="No conversations yet", exact=True)).to_be_visible()
                expect(page.locator(".project-convo__read-only")).to_be_visible()
                expect(page.locator("#project-composer")).to_have_count(0)
                expect(page.get_by_role("button", name="Start conversation", exact=True)).to_have_count(0)
                self.assert_text_is_unclipped(page.locator("header.top .top__audience > span").first)
                self.assert_text_is_unclipped(page.locator(".composer__audience > span").first)
                if width <= 640:
                    row = page.get_by_role("button", name=re.compile("open project details"))
                    expect(row).to_contain_text("2 open tasks")
                    self.assertGreaterEqual(row.bounding_box()["height"], 44)
                    row.tap()
                    panel = page.get_by_role("dialog", name="Details")
                    expect(panel.get_by_role("region", name="Now in this project")).to_contain_text("Open")
                    shot(page, f"136-state-overview-{width}")
                    panel.get_by_role("button", name=re.compile("Open.*Keep a manual switch available")).click()
                    expect(panel.get_by_role("heading", name="Keep a manual switch available", exact=True)).to_be_visible()
                    panel.get_by_role("button", name="Close details", exact=True).click()
                else:
                    expect(page.locator("header.top").get_by_label("Current state")).to_contain_text("2 open tasks")
                    self.assert_text_is_unclipped(page.locator('header.top [data-seg="open"] > span'))
                self.assertLessEqual(page.locator("body").evaluate("el => el.scrollWidth"), width)
                shot(page, f"136-state-reader-{width}-{'dark' if dark else 'light'}")
                page.locator('[data-tab="tasks"]').click()
                expect(page.locator(".ws-item").filter(has_text=task["title"])).to_be_visible()
                expect(page.get_by_role("button", name="Add work", exact=True)).to_have_count(0)
        self.call(owner, "POST", f"/api/v1/projects/{project['id']}/grants",
            {"principal": {"kind": "human", "id": self.accounts["Jonas Reader"]["id"]}, "role": "denied"}, 201)
        denied = self.page("Jonas Reader")
        self.call(denied, "GET", f"/api/v1/projects/{project['id']}/work", status=404)
        denied.goto(f"/projects/{project['id']}")
        expect(denied.locator('[data-seg="open"]')).to_have_count(0)
        expect(denied.get_by_text(task["title"], exact=True)).to_have_count(0)
