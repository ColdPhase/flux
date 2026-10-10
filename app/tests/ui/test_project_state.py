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
from test_project_surface import LONG_NAME


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

    def scene(self, name="Gesture lamp"):
        owner = self.page()
        ws = self.call(owner, "POST", "/api/v1/workspaces", {"name": "Riverside Makers"}, 201)
        self.call(owner, "POST", f"/api/v1/workspaces/{ws['id']}/members",
            {"email": self.accounts["Jonas Reader"]["email"], "role": "member"}, 201)
        project = self.call(owner, "POST", f"/api/v1/workspaces/{ws['id']}/projects",
            {"name": name, "visibility": "restricted"}, 201)
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
        page.get_by_role("radio", name="List", exact=True).click()
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
                # One project conversation (UI116-1): an empty stream says so to a reader, with no composer.
                expect(page.get_by_role("heading", name="No messages yet", exact=True)).to_be_visible()
                # The two tasks are announced above it (UI116-3); announcements are not messages.
                expect(page.locator(".convo-notice")).to_have_count(2)
                expect(page.locator(".project-convo__message")).to_have_count(0)
                expect(page.locator(".project-convo__read-only")).to_be_visible()
                expect(page.locator("#project-composer")).to_have_count(0)
                expect(page.get_by_role("button", name="Send message", exact=True)).to_have_count(0)
                self.assert_text_is_unclipped(page.locator("header.top .top__audience > span").first)
                self.assert_text_is_unclipped(page.locator(".composer__audience > span").first)
                if width <= 640:
                    row = page.get_by_role("button", name=re.compile("open project details"))
                    expect(row).to_contain_text("2 open tasks")
                    self.assertGreaterEqual(row.bounding_box()["height"], 44)
                    row.tap()
                    panel = page.get_by_role("dialog", name="Details")
                    expect(panel.get_by_role("region", name="Now in this project")).to_contain_text("Open")
                    expect(panel.get_by_role("region", name="Sketches")).to_contain_text("to browse saved sketches")
                    expect(panel.get_by_role("region", name="Docs")).to_contain_text("to read saved documents")
                    shot(page, f"136-state-overview-{width}")
                    panel.get_by_role("button", name=re.compile("Open.*Keep a manual switch available")).click()
                    expect(panel.get_by_role("heading", name="Keep a manual switch available", exact=True)).to_be_visible()
                    panel.get_by_role("button", name="Close details", exact=True).click()
                else:
                    expect(page.locator("header.top").get_by_label("Current state")).to_contain_text("2 open tasks")
                    self.assert_text_is_unclipped(page.locator('header.top [data-seg="open"] > span'))
                    expect(page.get_by_role("link", name="New conversation", exact=True)).to_have_count(0)
                self.assertLessEqual(page.locator("body").evaluate("el => el.scrollWidth"), width)
                shot(page, f"136-state-reader-{width}-{'dark' if dark else 'light'}")
                page.locator('[data-tab="tasks"]').click()
                # A reader's board has no way to add or move a task (#136).
                expect(page.locator(".tb-card").filter(has_text=task["title"])).to_have_count(1)
                expect(page.get_by_role("button", name="New Task")).to_have_count(0)
                expect(page.get_by_role("button", name="Move to…")).to_have_count(0)
                page.get_by_role("radio", name="List", exact=True).click()
                expect(page.locator(".ws-item").filter(has_text=task["title"])).to_be_visible()
                expect(page.get_by_role("button", name=re.compile("^(New )?Task$"))).to_have_count(0)
        self.call(owner, "POST", f"/api/v1/projects/{project['id']}/grants",
            {"principal": {"kind": "human", "id": self.accounts["Jonas Reader"]["id"]}, "role": "denied"}, 201)
        denied = self.page("Jonas Reader")
        self.call(denied, "GET", f"/api/v1/projects/{project['id']}/work", status=404)
        denied.goto(f"/projects/{project['id']}")
        expect(denied.locator('[data-seg="open"]')).to_have_count(0)
        expect(denied.get_by_text(task["title"], exact=True)).to_have_count(0)

    def test_04_reader_opens_uncited_source_and_existing_conversation_then_writer_draft_returns(self):
        owner, project = self.scene()
        principal = {"kind": "human", "id": self.accounts["Jonas Reader"]["id"]}
        self.call(owner, "POST", f"/api/v1/projects/{project['id']}/grants", {"principal": principal, "role": "contributor"}, 201)
        reader = self.page("Jonas Reader", 390, 844)
        reader.goto(f"/projects/{project['id']}")
        reader.get_by_label("Write a message", exact=True).fill("Unsent sensor notes remain mine")
        self.call(owner, "POST", f"/api/v1/projects/{project['id']}/grants", {"principal": principal, "role": "viewer"}, 201)
        thread = self.call(owner, "POST", f"/api/v1/projects/{project['id']}/conversations",
            {"body": "Sensor calibration plan for the library", "clientMessageId": str(uuid.uuid4())}, 201)
        material = self.call(owner, "POST", f"/api/v1/projects/{project['id']}/materials",
            {"title": "Low-light sensor notes", "body": "ToF detects gestures without saving camera images.", "clientMutationId": str(uuid.uuid4())}, 201)
        reader.reload()
        # The existing root is in the one stream (UI116-1); the reader has no composer.
        expect(reader.locator(".project-convo__message > p")).to_have_text("Sensor calibration plan for the library")
        expect(reader.get_by_role("heading", name="No messages yet", exact=True)).to_have_count(0)
        expect(reader.locator("#project-composer")).to_have_count(0)
        expect(reader.get_by_text("Unsent sensor notes remain mine", exact=True)).to_have_count(0)
        reader.get_by_role("button", name=re.compile("^Sources")).click()
        tray = reader.get_by_role("region", name="Project materials")
        expect(tray.get_by_role("button", name="Discuss this version")).to_have_count(0)
        expect(tray.get_by_role("button", name="Add material")).to_have_count(0)
        source = tray.get_by_role("link", name=material["title"], exact=True)
        expect(source).to_have_attribute("href", f"/materials/{material['materialId']}/versions/{material['version']}")
        source.focus()
        reader.keyboard.press("Enter")
        expect(reader.locator(".material-view__body")).to_have_text(material["body"])
        reader.goto(f"/projects/{project['id']}")
        reader.get_by_role("button", name="Open navigation", exact=True).click()
        expect(reader.get_by_role("link", name="New conversation", exact=True)).to_have_count(0)
        # The drawer lists projects, not their conversations; the saved conversation's own URL opens its thread.
        expect(reader.get_by_role("link", name=re.compile("Sensor calibration plan for the library"))).to_have_count(0)
        reader.keyboard.press("Escape")
        reader.goto(f"/projects/{project['id']}/conversations/{thread['id']}")
        thread_view = reader.get_by_role("complementary", name="Replies")
        expect(thread_view.locator(".thread__root")).to_contain_text("Sensor calibration plan for the library")
        expect(reader.locator(".project-convo__message > p")).to_have_text("Sensor calibration plan for the library")
        expect(thread_view.locator(".project-convo__read-only")).to_be_visible()
        expect(thread_view.locator(".project-convo__current-thread")).to_contain_text("Conversation · Sensor calibration")
        expect(thread_view.locator(".project-convo__current-thread")).not_to_contain_text("Replying to")
        expect(reader.locator("#project-composer")).to_have_count(0)
        expect(reader.locator("#thread-composer")).to_have_count(0)
        shot(reader, "136-state-reader-saved-conversation-390")
        self.call(owner, "POST", f"/api/v1/projects/{project['id']}/grants", {"principal": principal, "role": "contributor"}, 201)
        reader.goto(f"/projects/{project['id']}")
        expect(reader.get_by_label("Write a message", exact=True)).to_have_value("Unsent sensor notes remain mine")

    def test_05_long_project_title_yields_to_readable_audience_and_compact_header(self):
        for name in (LONG_NAME, LONG_NAME + " — sensor calibration and accessible night lighting"):
            owner, project = self.scene(name)
            self.work(owner, project, "Check low-light reliability")
            for width in (641, 700, 744, 820, 1024, 1280, 1440):
                with self.subTest(name=name, width=width):
                    page = self.page(width=width, height=1180)
                    page.goto(f"/projects/{project['id']}")
                    header = page.locator("header.top")
                    expect(header.get_by_label("Current state")).to_contain_text("1 open task")
                    self.assertLessEqual(header.bounding_box()["height"], 90, "long title must not turn audience into a vertical column")
                    self.assert_text_is_unclipped(header.locator(".top__audience > span").first)
                    expect(header.get_by_role("heading", level=1)).to_have_attribute("title", name)
                    self.assertLessEqual(page.locator("body").evaluate("el => el.scrollWidth"), width)
                    header.locator(".top__audience").click()
                    expect(page.locator("#details").get_by_role("heading", name=name, exact=True)).to_be_visible()
                    page.get_by_role("button", name="Close details", exact=True).click()
                    if width in (744, 820, 1280):
                        shot(page, f"136-state-long-title-{len(name)}-{width}")

    def test_06_material_draft_hides_on_downgrade_and_returns_on_upgrade(self):
        owner, project = self.scene()
        principal = {"kind": "human", "id": self.accounts["Jonas Reader"]["id"]}
        self.call(owner, "POST", f"/api/v1/projects/{project['id']}/grants", {"principal": principal, "role": "contributor"}, 201)
        reader = self.page("Jonas Reader", 390, 844)
        reader.goto(f"/projects/{project['id']}")
        reader.get_by_role("button", name=re.compile("^Sources")).click()
        reader.get_by_role("button", name="Add material", exact=True).click()
        reader.get_by_label("Title", exact=True).fill("Unpublished calibration source")
        reader.get_by_label("Text", exact=True).fill("Keep this source draft until I can contribute again.")
        self.call(owner, "POST", f"/api/v1/projects/{project['id']}/grants", {"principal": principal, "role": "viewer"}, 201)
        reader.evaluate("window.dispatchEvent(new Event('focus'))")
        expect(reader.locator(".project-convo__read-only")).to_be_visible(timeout=20000)
        expect(reader.locator(".project-convo__material-form")).to_have_count(0)
        reader.reload()
        expect(reader.locator(".project-convo__read-only")).to_be_visible()
        reader.get_by_role("button", name=re.compile("^Sources")).click()
        expect(reader.locator(".project-convo__material-form")).to_have_count(0)
        expect(reader.get_by_role("button", name="Save for this project", exact=True)).to_have_count(0)
        self.assertEqual(self.call(owner, "GET", f"/api/v1/projects/{project['id']}/materials")["total"], 0)
        shot(reader, "136-state-material-reader-downgrade-390")
        self.call(owner, "POST", f"/api/v1/projects/{project['id']}/grants", {"principal": principal, "role": "contributor"}, 201)
        reader.reload()
        expect(reader.get_by_label("Title", exact=True)).to_have_value("Unpublished calibration source")
        expect(reader.get_by_label("Text", exact=True)).to_have_value("Keep this source draft until I can contribute again.")
        with reader.expect_response(lambda r: r.request.method == "POST" and r.url.endswith(f"/projects/{project['id']}/materials")) as saved:
            reader.get_by_role("button", name="Save for this project", exact=True).click()
        self.assertEqual(saved.value.status, 201)
        material = self.call(owner, "GET", f"/api/v1/projects/{project['id']}/materials")["items"][0]
        self.assertEqual(material["title"], "Unpublished calibration source")

    def test_07_phone_keeps_blocked_count_visible_beside_other_current_work(self):
        owner, project = self.scene()
        blocked = self.work(owner, project, "Wait for the calibration sensor", "blocked")
        self.work(owner, project, "Collect observations from the library team", "in_progress")
        self.call(owner, "POST", f"/api/v1/projects/{project['id']}/decisions",
            {"title": "Keep manual fallback until the experiment is accepted", "rationale": "Avoid excluding anyone while testing"}, 201)
        for who in ("Ada State", "Jonas Reader"):
            for width, scale, dark in ((320, 1, False), (390, 1.25, True), (320, 2, False)):
                with self.subTest(who=who, width=width, scale=scale):
                    page = self.page(who, width, 844, dark)
                    page.goto(f"/projects/{project['id']}")
                    if scale != 1:
                        sizes = {"xs": 12, "sm": 13, "md": 14, "base": 15, "lg": 17, "xl": 20, "2xl": 24}
                        page.add_style_tag(content=":root { " + "; ".join(f"--fs-{key}:{size * scale}px" for key, size in sizes.items()) + "; }")
                    row = page.get_by_role("button", name=re.compile("open project details"))
                    expect(row).to_contain_text("1 blocked")
                    shot(page, f"136-state-blocked-{width}-text-{int(scale * 100)}-{'writer' if who == 'Ada State' else 'reader'}")
                    # A text assertion alone passes even when the label is past an ellipsis.
                    # Measure the actual text range against every clipping ancestor and the viewport.
                    visible = row.evaluate("""(el, text) => {
                        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
                        let node;
                        while ((node = walker.nextNode())) {
                            const at = node.textContent.indexOf(text);
                            if (at < 0) continue;
                            const range = document.createRange();
                            range.setStart(node, at); range.setEnd(node, at + text.length);
                            const box = range.getBoundingClientRect();
                            if (box.width <= 0 || box.left < 0 || box.right > innerWidth + 1) continue;
                            let clipped = false;
                            for (let parent = node.parentElement; parent; parent = parent.parentElement) {
                                const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
                                if (['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowX)
                                    && (box.left < bounds.left - 1 || box.right > bounds.right + 1)) clipped = true;
                                if (parent === el) break;
                            }
                            if (!clipped && [0.1, 0.5, 0.9].every(fraction => {
                                const hit = document.elementFromPoint(box.left + box.width * fraction, box.top + box.height / 2);
                                return hit && el.contains(hit);
                            })) return true;
                        }
                        return false;
                    }""", "1 blocked")
                    self.assertTrue(visible, "the blocked count must be visibly readable before opening the overview")
                    self.assertGreaterEqual(row.bounding_box()["height"], 44)
                    self.assertLessEqual(page.locator("body").evaluate("el => el.scrollWidth"), width)
                    if who == "Ada State":
                        row.focus()
                        row.press("Enter")
                    else:
                        row.tap()
                    panel = page.get_by_role("dialog", name="Details")
                    expect(panel.get_by_role("region", name="Now in this project")).to_contain_text("Blocked")
                    panel.get_by_role("button", name=re.compile("Blocked.*Wait for the calibration sensor")).click()
                    expect(panel.get_by_role("heading", name=blocked["title"], exact=True)).to_be_visible()
                    self.assertEqual(self.call(page, "GET", f"/api/v1/work/{blocked['id']}")["status"], "blocked")
