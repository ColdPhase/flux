"""F-026 S4, S9, S10, P10 (#344): one detail panel on the computer and one sheet on the phone."""
from __future__ import annotations

import re
import unittest
import uuid

from playwright.sync_api import expect, sync_playwright
from test_app_shell import ORIGIN, UPSTREAM, shot, start_forwarder
from test_work_pagination import api


class DetailPanelFinal(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        expect.set_options(timeout=10000)
        cls.ctx = cls.browser.new_context(base_url=ORIGIN)
        api(cls.ctx, "POST", "/api/auth/sign-up/email", {"name": "Ada Kowalska", "email": f"panel-{uuid.uuid4()}@example.test", "password": "Calibrate both probes together"})
        cls.user = api(cls.ctx, "GET", "/api/v1/me")["user"]["id"]
        workspace = api(cls.ctx, "POST", "/api/v1/workspaces", {"name": "Garden co-op"}, 201)["id"]
        cls.project = api(cls.ctx, "POST", f"/api/v1/workspaces/{workspace}/projects", {"name": "Community garden sensors", "visibility": "restricted"}, 201)["id"]
        cls.root = f"/api/v1/projects/{cls.project}"
        cls.thread = api(cls.ctx, "POST", cls.root + "/conversations", {"body": "The probes arrive Thursday. Someone should calibrate them at two depths.", "clientMessageId": str(uuid.uuid4())}, 201)
        api(cls.ctx, "POST", f"/api/v1/conversations/{cls.thread['id']}/messages", {"body": "I can do it on Saturday.", "clientMessageId": str(uuid.uuid4())}, 201)
        cls.source = {"type": "message", "id": cls.thread["messages"][0]["id"]}
        cls.task = cls.new_task("Calibrate the probes at two soil depths", owner=True)
        cls.state = cls.ctx.storage_state()

    @classmethod
    def new_task(cls, title, owner=False, blocker=None):
        body = {"title": title, "sources": [cls.source]}
        if owner:
            body["owner"] = {"kind": "human", "id": cls.user}
        task = api(cls.ctx, "POST", cls.root + "/work", body, 201)
        if blocker:
            task = api(cls.ctx, "PATCH", f"/api/v1/work/{task['id']}", {"status": "blocked", "blocker": blocker, "expectedVersion": task["version"]})
        return task

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def page(self, phone=False, scheme="light"):
        ctx = self.browser.new_context(base_url=ORIGIN, storage_state=self.state, color_scheme=scheme,
            viewport={"width": 390 if phone else 1440, "height": 844 if phone else 900},
            device_scale_factor=2 if phone else 1, is_mobile=phone, has_touch=phone, locale="en-GB")
        self.addCleanup(ctx.close)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught browser errors"))
        return page

    def stored(self, task):
        return api(self.ctx, "GET", f"/api/v1/work/{task['id']}")

    def open_task(self, page, task):
        page.goto(f"/projects/{self.project}/tasks?open=work:{task['id']}")
        panel = page.locator("#details")
        expect(panel.locator(".wd")).to_be_visible()
        expect(panel.locator("[data-detail-relations-phase]")).to_have_attribute("data-detail-relations-phase", "ready")
        return panel

    # ------------------------------------------------------------------ computer

    def test_01_computer_panel_is_calm_in_light_and_dark(self):
        blocked = self.new_task("Design a weatherproof enclosure", owner=True, blocker="Waiting for the probe dimensions")
        for scheme in ("light", "dark"):
            with self.subTest(scheme=scheme):
                page = self.page(scheme=scheme)
                panel = self.open_task(page, blocked)
                # One panel: the kind is a chip, the number sits beside it, Esc closes it.
                expect(page.get_by_role("complementary", name="Details")).to_be_visible()
                expect(panel.locator(".ui-panel__kind")).to_have_text("Task")
                expect(panel.locator(".ui-panel__meta")).to_have_text("#2")
                # Rows of label and value; the blocker is a card; Results, Activity and a composer follow.
                rows = panel.locator(".wd-rows .wd-row")
                expect(rows).to_have_count(3)
                for label in ("Status", "Owner", "Came from"):
                    expect(panel.locator(".wd-row dt", has_text=label)).to_be_visible()
                card = panel.get_by_role("region", name="Blocker")
                expect(card).to_be_visible()
                expect(card.get_by_label("What is it waiting for?")).to_have_value("Waiting for the probe dimensions")
                expect(panel.get_by_role("heading", name="Results")).to_be_visible()
                expect(panel.get_by_role("heading", name="Activity")).to_be_visible()
                expect(panel.get_by_placeholder("Write about #2…")).to_be_visible()
                # The conversation stays visible beside it.
                expect(page.locator("#content")).to_be_visible()
                box = panel.bounding_box()
                self.assertGreater(box["x"], 900, "the panel sits at the right edge")
                self.assertLess(box["width"], 460)
                shot(page, f"detail-panel-final-desktop-{scheme}")
                page.keyboard.press("Escape")
                expect(panel).to_have_count(0)

    def test_02_state_changes_at_once_with_keys_and_undo(self):
        task = self.new_task("Order the second supplier's probes", owner=True)
        page = self.page()
        panel = self.open_task(page, task)
        status = panel.get_by_role("button", name="Status", exact=True)
        expect(status).to_contain_text("Open")
        # The menu lists the five states with their keys.
        status.click()
        menu = page.get_by_role("menu", name="Status")
        expect(menu.get_by_role("menuitemradio")).to_have_count(5)
        expect(menu.get_by_role("menuitemradio", name="Blocked")).to_contain_text("3")
        page.keyboard.press("Escape")
        expect(menu).to_have_count(0)
        expect(panel).to_be_visible()  # Esc closed the menu first, not the panel
        # A digit key changes the state at once, and Undo takes it back.
        panel.locator(".ui-panel__body").focus()
        page.keyboard.press("2")
        expect(status).to_contain_text("In progress")
        self.assertEqual(self.stored(task)["status"], "in_progress")
        undo = page.get_by_role("status").get_by_role("button", name="Undo")
        expect(undo).to_be_visible()
        undo.click()
        expect(status).to_contain_text("Open")
        self.assertEqual(self.stored(task)["status"], "open")
        # From the keyboard alone: open the menu with the arrow, choose with a digit.
        status.focus()
        page.keyboard.press("ArrowDown")
        page.keyboard.press("4")
        expect(status).to_contain_text("Done")
        self.assertEqual(self.stored(task)["status"], "done")
        # Typing a digit in a field never changes the state.
        panel.locator(".wd-activity textarea").fill("5")
        self.assertEqual(self.stored(task)["status"], "done")

    def test_03_title_is_edited_in_place(self):
        task = self.new_task("Draft the wiring plan")
        page = self.page()
        panel = self.open_task(page, task)
        panel.locator(".wd-title__text").click()
        field = panel.get_by_role("textbox", name="Task title")
        expect(field).to_be_focused()
        field.fill("Draft the wiring plan for six beds")
        page.keyboard.press("Enter")
        expect(panel.locator(".details__title")).to_have_text("Draft the wiring plan for six beds")
        self.assertEqual(self.stored(task)["title"], "Draft the wiring plan for six beds")
        # Esc puts the old title back and does not close the panel.
        panel.locator(".wd-title__text").click()
        panel.get_by_role("textbox", name="Task title").fill("Something else")
        page.keyboard.press("Escape")
        expect(panel.locator(".details__title")).to_have_text("Draft the wiring plan for six beds")
        expect(panel).to_be_visible()
        self.assertEqual(self.stored(task)["title"], "Draft the wiring plan for six beds")

    def test_04_thread_opens_in_the_same_panel_look(self):
        page = self.page()
        page.goto(f"/projects/{self.project}/conversations/{self.thread['id']}")
        thread = page.get_by_role("complementary", name="Replies")
        expect(thread).to_be_visible()
        expect(thread.locator(".ui-panel__kind")).to_have_text("Thread")
        expect(thread.locator(".thread__n")).to_have_text("1 reply")
        expect(thread.locator(".thread__root")).to_contain_text("The probes arrive Thursday")
        expect(page.locator(".convo-split__stream")).to_be_visible()
        shot(page, "detail-panel-final-thread-desktop")
        thread.focus()
        page.keyboard.press("Escape")
        expect(thread).to_have_count(0)

    def test_03b_undo_restores_the_blocker_reason(self):
        task = self.new_task("Mount the rain gauge", owner=True, blocker="Waiting for the bracket from the supplier")
        page = self.page()
        panel = self.open_task(page, task)
        panel.get_by_role("button", name="Resolve").click()
        expect(panel.get_by_role("button", name="Status", exact=True)).to_contain_text("In progress")
        stored = self.stored(task)
        self.assertEqual((stored["status"], stored["blocker"]), ("in_progress", None))
        page.get_by_role("status").get_by_role("button", name="Undo").click()
        expect(panel.get_by_role("button", name="Status", exact=True)).to_contain_text("Blocked")
        expect(panel.get_by_label("What is it waiting for?")).to_have_value("Waiting for the bracket from the supplier")
        stored = self.stored(task)
        self.assertEqual((stored["status"], stored["blocker"]), ("blocked", "Waiting for the bracket from the supplier"))

    def test_03e_finishing_parked_work_offers_no_undo_it_cannot_keep(self):
        """Negative control: Undo would restore the status but not 'parked' (the PATCH contract only unparks), so no Undo is offered."""
        task = self.new_task("Compare the replacement enclosure", owner=True)
        previous = api(self.ctx, "POST", self.root + "/decisions", {"title": "Use the original enclosure"}, 201)
        api(self.ctx, "POST", f"/api/v1/decisions/{previous['id']}/accept", {"expectedVersion": 1}, 200)
        pivot = api(self.ctx, "POST", self.root + "/decisions", {"title": "Keep the measured enclosure", "supersedes": previous["id"], "affects": [task["id"]]}, 201)
        api(self.ctx, "POST", f"/api/v1/decisions/{pivot['id']}/accept", {"expectedVersion": 1, "park": [task["id"]]}, 200)
        self.assertIsNotNone(self.stored(task)["parked"])
        page = self.page()
        panel = self.open_task(page, task)
        expect(panel.locator(".wd-where")).to_contain_text("parked, not done")
        panel.locator(".ui-panel__body").focus()
        page.keyboard.press("4")
        toasts = page.locator(".ui-toasts")
        expect(toasts).to_contain_text("no longer parked")
        expect(panel.get_by_role("button", name="Status", exact=True)).to_contain_text("Done")
        self.assertEqual(self.stored(task)["status"], "done")
        self.assertIsNone(self.stored(task)["parked"])
        expect(toasts.get_by_role("button", name="Undo")).to_have_count(0)

    def test_03c_a_failed_title_save_keeps_the_draft_until_it_is_saved(self):
        task = self.new_task("Name the gateway")
        page = self.page()
        panel = self.open_task(page, task)
        title = panel.locator(".wd-title__text")
        # Escape leaves the stored title alone.
        title.click()
        panel.get_by_role("textbox", name="Task title").fill("Never saved")
        page.keyboard.press("Escape")
        expect(panel.locator(".details__title")).to_have_text("Name the gateway")
        self.assertEqual(self.stored(task)["title"], "Name the gateway")
        # One failed PATCH: the server is unchanged, the whole draft stays, and a retry saves it.
        failures = []
        def fail_once(route):
            if route.request.method == "PATCH" and not failures:
                failures.append(1)
                route.fulfill(status=503, json={"code": "UNAVAILABLE", "error": "Fixture unavailable"})
            else:
                route.continue_()
        page.route(re.compile(r"/api/v1/work/"), fail_once)
        title.click()
        field = panel.get_by_role("textbox", name="Task title")
        field.fill("Name the gateway and the antenna")
        page.keyboard.press("Enter")
        expect(panel.get_by_role("alert")).to_be_visible()
        expect(field).to_have_value("Name the gateway and the antenna")
        self.assertEqual(self.stored(task)["title"], "Name the gateway")
        page.keyboard.press("Enter")
        expect(panel.locator(".details__title")).to_have_text("Name the gateway and the antenna")
        self.assertEqual(self.stored(task)["title"], "Name the gateway and the antenna")
        page.unroute(re.compile(r"/api/v1/work/"))

    def test_03d_a_title_save_that_conflicts_keeps_the_draft(self):
        task = self.new_task("Choose the mast")
        page = self.page()
        panel = self.open_task(page, task)
        # Someone else changes the task after the panel loaded.
        api(self.ctx, "PATCH", f"/api/v1/work/{task['id']}", {"outcome": "Changed elsewhere", "expectedVersion": task["version"]})
        panel.locator(".wd-title__text").click()
        field = panel.get_by_role("textbox", name="Task title")
        field.fill("Choose the mast and the mount")
        page.keyboard.press("Enter")
        expect(panel.get_by_role("alert")).to_contain_text("Someone changed this")
        expect(field).to_have_value("Choose the mast and the mount")
        self.assertEqual(self.stored(task)["title"], "Choose the mast")
        page.wait_for_timeout(1500)  # the latest version has loaded
        page.keyboard.press("Enter")
        expect(panel.locator(".details__title")).to_have_text("Choose the mast and the mount")
        self.assertEqual(self.stored(task)["title"], "Choose the mast and the mount")

    # --------------------------------------------------------------------- phone

    def drag(self, page, from_y, to_y, x=195):
        cdp = page.context.new_cdp_session(page)
        steps = 8
        cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": from_y}]})
        for index in range(1, steps + 1):
            cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x, "y": from_y + (to_y - from_y) * index / steps}]})
            page.wait_for_timeout(16)
        cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        page.wait_for_timeout(500)

    def test_05_phone_sheet_has_a_grabber_and_two_heights(self):
        task = self.new_task("Label every probe cable", owner=True, blocker="Waiting for the label printer")
        for scheme in ("light", "dark"):
            with self.subTest(scheme=scheme):
                page = self.page(phone=True, scheme=scheme)
                page.goto(f"/projects/{self.project}/tasks?open=work:{task['id']}")
                sheet = page.get_by_role("dialog", name="Details")
                expect(sheet.locator(".wd")).to_be_visible()
                expect(sheet).to_have_attribute("data-height", "half")
                page.wait_for_timeout(900)  # the sheet has finished sliding in
                grabber = sheet.locator(".ui-grabber")
                expect(grabber).to_be_visible()
                half = sheet.bounding_box()
                self.assertGreater(half["y"], 844 * 0.3, "half height leaves the conversation in view")
                # Five state pills, one checked; touch targets are at least 44px.
                pills = sheet.get_by_role("radiogroup", name="Status").get_by_role("radio")
                expect(pills).to_have_count(5)
                for index in range(5):
                    box = pills.nth(index).bounding_box()
                    self.assertGreaterEqual(box["height"], 44, "a real 44px target, no rounding allowance")
                    self.assertGreaterEqual(box["width"], 44)
                box = grabber.bounding_box()
                self.assertGreaterEqual(box["height"], 44, "the grabber is a real 44px target")
                self.assertGreaterEqual(box["width"], 44)
                # The visible bar stays small, and the close button is not covered by the hit area.
                self.assertLess(grabber.locator("span").bounding_box()["height"], 8)
                close = sheet.get_by_role("button", name="Close details").bounding_box()
                self.assertTrue(close["x"] >= box["x"] + box["width"] or close["y"] >= box["y"] + box["height"], "the grabber does not overlap Close")
                shot(page, f"detail-panel-final-phone-half-{scheme}")
                # Drag up for full; the hint goes away.
                self.drag(page, half["y"] + 14, 120)
                expect(sheet).to_have_attribute("data-height", "full")
                self.assertLess(sheet.bounding_box()["y"], 40)
                shot(page, f"detail-panel-final-phone-full-{scheme}")
                # Drag down: back to half, then closed.
                self.drag(page, 30, 640)  # from the grabber itself
                expect(sheet).to_have_attribute("data-height", "half")
                page.wait_for_timeout(700)  # the height settles before the next touch
                start_y = sheet.bounding_box()["y"] + 14
                self.drag(page, start_y, 800)
                expect(sheet).to_have_count(0)

    def test_06_phone_grabber_button_and_state_pill(self):
        task = self.new_task("Pick a gateway spot", owner=True)
        page = self.page(phone=True)
        page.goto(f"/projects/{self.project}/tasks?open=work:{task['id']}")
        sheet = page.get_by_role("dialog", name="Details")
        expect(sheet.locator(".wd")).to_be_visible()
        sheet.locator(".ui-grabber").tap()
        expect(sheet).to_have_attribute("data-height", "full")
        sheet.locator(".ui-grabber").tap()
        expect(sheet).to_have_attribute("data-height", "half")
        # Keyboard and screen readers get a real button for the same two heights.
        sheet.get_by_role("button", name="Show full height").focus()
        page.keyboard.press("Enter")
        expect(sheet).to_have_attribute("data-height", "full")
        expect(sheet.get_by_role("button", name="Show half height")).to_have_attribute("aria-expanded", "true")
        page.keyboard.press("Space")
        expect(sheet).to_have_attribute("data-height", "half")
        sheet.get_by_role("radio", name="In progress").tap()
        expect(sheet.get_by_role("radio", name="In progress")).to_have_attribute("aria-checked", "true")
        self.assertEqual(self.stored(task)["status"], "in_progress")
        page.get_by_role("status").get_by_role("button", name="Undo").tap()
        expect(sheet.get_by_role("radio", name="Open")).to_have_attribute("aria-checked", "true")
        self.assertEqual(self.stored(task)["status"], "open")
        sheet.get_by_role("button", name="Close details").tap()
        expect(sheet).to_have_count(0)

    def test_08_details_and_thread_are_one_sheet_component_with_identical_behaviour(self):
        """AC-2: the phone Details sheet and the Thread sheet are the same component: same root marker, grabber, heights, drag and Esc."""
        task = self.new_task("Share one sheet", owner=True)
        cases = {
            "details": (f"/projects/{self.project}/tasks?open=work:{task['id']}", "#details", "half"),
            "thread": (f"/projects/{self.project}/conversations/{self.thread['id']}", "#thread", "full"),
        }
        for name, (url, selector, opens) in cases.items():
            with self.subTest(sheet=name):
                page = self.page(phone=True)
                page.goto(url)
                sheet = page.locator(selector)
                expect(sheet).to_be_visible()
                page.wait_for_timeout(1000)
                # The same component renders both: one marked root, a grabber and a keyboard button as its first children.
                expect(page.locator("[data-detent-sheet]")).to_have_count(1)
                expect(sheet).to_have_attribute("data-detent-sheet", "")
                self.assertIn("ui-detent-sheet", sheet.get_attribute("class"))
                self.assertEqual(sheet.evaluate("el => [...el.children].slice(0, 2).map(c => c.className.split(' ')[0] + ':' + c.tagName)"), ["ui-grabber:DIV", "ui-vh:BUTTON"])
                expect(sheet).to_have_attribute("data-height", opens)
                # The same heights: the keyboard button toggles half and full.
                other = "half" if opens == "full" else "full"
                sheet.locator(":scope > button.ui-vh").focus()
                page.keyboard.press("Enter")
                expect(sheet).to_have_attribute("data-height", other)
                page.keyboard.press("Enter")
                expect(sheet).to_have_attribute("data-height", opens)
                # The same drag: up opens full, down steps to half, down again closes.
                page.wait_for_timeout(700)
                top = sheet.bounding_box()["y"]
                self.drag(page, top + 14, 120)
                expect(sheet).to_have_attribute("data-height", "full")
                page.wait_for_timeout(700)
                self.drag(page, sheet.bounding_box()["y"] + 14, 640)
                expect(sheet).to_have_attribute("data-height", "half")
                page.wait_for_timeout(700)
                self.drag(page, sheet.bounding_box()["y"] + 14, 820)
                expect(sheet).to_have_count(0)
                # Esc closes both the same way.
                page.goto(url)
                expect(sheet).to_be_visible()
                sheet.focus()
                page.keyboard.press("Escape")
                expect(sheet).to_have_count(0)

    def test_08b_a_sheet_that_is_not_this_component_is_not_marked(self):
        """Negative control for test_08: the full-screen Details sheet (place details, no object) is not a two-height sheet."""
        page = self.page(phone=True)
        page.goto(f"/projects/{self.project}/tasks")
        page.get_by_role("button", name="Details", exact=True).first.click()
        sheet = page.get_by_role("dialog", name="Details")
        expect(sheet).to_be_visible()
        expect(page.locator("[data-detent-sheet]")).to_have_count(0)
        expect(sheet.locator(".ui-grabber")).to_have_count(0)

    def test_07_phone_thread_is_a_sheet_with_a_grabber(self):
        page = self.page(phone=True)
        page.goto(f"/projects/{self.project}/conversations/{self.thread['id']}")
        thread = page.get_by_role("complementary", name="Replies")
        expect(thread).to_be_visible()
        expect(thread).to_have_attribute("data-height", "full")
        handle = thread.locator(".ui-grabber").bounding_box()
        self.assertGreaterEqual(handle["height"], 44, "the thread grabber is a real 44px target")
        self.assertGreaterEqual(handle["width"], 44)
        thread.locator(".ui-grabber").tap()
        expect(thread).to_have_attribute("data-height", "half")
        shot(page, "detail-panel-final-thread-phone-half")
        thread.locator(".ui-grabber").tap()
        expect(thread).to_have_attribute("data-height", "full")
        shot(page, "detail-panel-final-thread-phone")

    def test_09_keyboard_focus_on_the_sheet_handle_is_visible_in_both_sheets(self):
        """N1 (WCAG 2.4.7): the keyboard button is visually hidden, so its focus ring must show on the visible handle. Negative control: removing the :has() rule in ui.css fails."""
        task = self.new_task("Show the handle focus", owner=True)
        cases = {
            "details": f"/projects/{self.project}/tasks?open=work:{task['id']}",
            "thread": f"/projects/{self.project}/conversations/{self.thread['id']}",
        }
        for name, url in cases.items():
            with self.subTest(sheet=name):
                page = self.page(phone=True)
                page.goto(url)
                sheet = page.locator("#" + name)
                expect(sheet).to_be_visible()
                page.wait_for_timeout(1000)
                sheet.focus()
                page.keyboard.press("Tab")
                self.assertTrue(sheet.evaluate("el => el.querySelector(':scope > button.ui-vh') === document.activeElement && el.querySelector('.ui-vh').matches(':focus-visible')"), "Tab reaches the keyboard handle button")
                ring = sheet.locator(".ui-grabber").evaluate("el => { const s = getComputedStyle(el); return { style: s.outlineStyle, width: parseFloat(s.outlineWidth), color: s.outlineColor }; }")
                self.assertEqual(ring["style"], "solid", "the visible handle shows a focus ring")
                self.assertGreaterEqual(ring["width"], 2)
                self.assertNotIn(ring["color"], ("rgba(0, 0, 0, 0)", "transparent"))

    def test_10_thread_sheet_keeps_its_enter_motion_unless_reduced(self):
        """N2: the Thread sheet slides in as before. Negative control: removing the .ui-detent-sheet.thread animation rule fails the first assertion."""
        page = self.page(phone=True)
        page.goto(f"/projects/{self.project}/conversations/{self.thread['id']}")
        expect(page.locator("#thread")).to_be_visible()
        self.assertIn("thread-in", page.locator("#thread").evaluate("el => getComputedStyle(el).animationName"))
        ctx = self.browser.new_context(base_url=ORIGIN, storage_state=self.state, viewport={"width": 390, "height": 844},
            is_mobile=True, has_touch=True, locale="en-GB", reduced_motion="reduce")
        self.addCleanup(ctx.close)
        still = ctx.new_page()
        still.goto(f"/projects/{self.project}/conversations/{self.thread['id']}")
        expect(still.locator("#thread")).to_be_visible()
        self.assertEqual(still.locator("#thread").evaluate("el => getComputedStyle(el).animationName"), "none")


if __name__ == "__main__":
    unittest.main()
