"""#488 (F-026 S4, S9, S10, P10; Spokój rules 2, 5, 7): a task, a decision, an agent's work and a thread open in the one
panel (one sheet on the phone), the thread replaces a task's content with "back", the task panel is calm, its properties
are edited in place, its Activity has real authors and times, and nothing moves between views. Real native records and the
API's own read-back; Chromium and WebKit (FLUX_UI_BROWSER)."""
from __future__ import annotations

import datetime
import re
import unittest
import uuid

from playwright.sync_api import expect, sync_playwright
from test_app_shell import ORIGIN, UI_BROWSER, UPSTREAM, shot, show_map_as, start_forwarder
from test_work_pagination import api
from native_touch import drag_touch, native_touch_driver

PASSWORD = "One panel for every object"
# Every finite animation (a sheet arriving) has finished; endless indicators are ignored.
SETTLED = "() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().endTime === Infinity)"


class UnifiedPanel(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        with native_touch_driver(UI_BROWSER):
            cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        print(f"ACTUAL_UI_ENGINE={cls.browser.browser_type.name}", flush=True)
        expect.set_options(timeout=10000)
        stamp = uuid.uuid4().hex[:8]
        cls.ada_ctx = cls.browser.new_context(base_url=ORIGIN, service_workers="block")
        cls.jonas_ctx = cls.browser.new_context(base_url=ORIGIN, service_workers="block")
        api(cls.ada_ctx, "POST", "/api/auth/sign-up/email", {"name": "Ada Kowalska", "email": f"panel-ada-{stamp}@example.test", "password": PASSWORD})
        cls.ada = api(cls.ada_ctx, "GET", "/api/v1/me")["user"]["id"]
        jonas_email = f"panel-jonas-{stamp}@example.test"
        api(cls.jonas_ctx, "POST", "/api/auth/sign-up/email", {"name": "Jonas Berg", "email": jonas_email, "password": PASSWORD})
        cls.jonas = api(cls.jonas_ctx, "GET", "/api/v1/me")["user"]["id"]
        cls.workspace = api(cls.ada_ctx, "POST", "/api/v1/workspaces", {"name": "Garden co-op"}, 201)["id"]
        api(cls.ada_ctx, "POST", f"/api/v1/workspaces/{cls.workspace}/members", {"email": jonas_email, "role": "member"}, 201)
        cls.project = api(cls.ada_ctx, "POST", f"/api/v1/workspaces/{cls.workspace}/projects", {"name": "Community garden sensors", "visibility": "restricted"}, 201)["id"]
        cls.root = f"/api/v1/projects/{cls.project}"
        api(cls.ada_ctx, "POST", cls.root + "/grants", {"principal": {"kind": "human", "id": cls.jonas}, "role": "contributor"}, 201)
        cls.thread = api(cls.ada_ctx, "POST", cls.root + "/conversations", {"body": "Should the first sensors measure soil moisture, or only temperature for the frost warnings?", "clientMessageId": str(uuid.uuid4())}, 201)
        for who, text in ((cls.jonas_ctx, "Moisture first. The volunteers keep overwatering the raised beds."), (cls.ada_ctx, "Agreed. I compared probes in the shortlist."), (cls.jonas_ctx, "Then let us order six and put two on the far beds.")):
            api(who, "POST", f"/api/v1/conversations/{cls.thread['id']}/messages", {"body": text, "clientMessageId": str(uuid.uuid4())}, 201)
        cls.source = {"type": "message", "id": cls.thread["messages"][0]["id"]}
        cls.task = cls.new_task("Raised beds by the fence: overwatered", blocker="Waiting for the probe dimensions")
        cls.decision = api(cls.ada_ctx, "POST", cls.root + "/decisions", {"title": "Measure soil moisture first", "rationale": "Overwatering is the real problem."}, 201)
        cls.stamp = stamp

    @classmethod
    def new_task(cls, title, owner=True, blocker=None, **fields):
        body = {"title": title, "sources": [cls.source], **fields}
        if owner:
            body["owner"] = {"kind": "human", "id": cls.ada}
        task = api(cls.ada_ctx, "POST", cls.root + "/work", body, 201)
        if blocker:
            task = api(cls.ada_ctx, "PATCH", f"/api/v1/work/{task['id']}", {"status": "blocked", "blocker": blocker, "waitingFor": {"kind": "human", "id": cls.jonas}, "expectedVersion": task["version"]})
        return task

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def page(self, phone=False, scheme="light"):
        ctx = self.browser.new_context(base_url=ORIGIN, storage_state=self.ada_ctx.storage_state(), color_scheme=scheme,
            viewport={"width": 390 if phone else 1440, "height": 844 if phone else 900},
            device_scale_factor=2 if phone else 1, is_mobile=phone, has_touch=phone, locale="en-GB", service_workers="block")
        self.addCleanup(ctx.close)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught browser errors"))
        return page

    def stored(self, task):
        return api(self.ada_ctx, "GET", f"/api/v1/work/{task['id']}")

    def open_task(self, page, task):
        page.goto(f"/projects/{self.project}/tasks?open=work:{task['id']}")
        panel = page.locator("#details")
        expect(panel.locator(f".wd[data-detail-id='{task['id']}']")).to_be_visible()
        expect(panel.locator("[data-detail-relations-phase]")).to_have_attribute("data-detail-relations-phase", "ready")
        expect(panel.get_by_role("list", name="Task activity")).to_be_visible()
        return panel

    def positions(self, page, names):
        """The box of each named control, for the rule that a control never changes place (Spokój rule 7)."""
        found = {}
        for name in names:
            box = page.locator("#details").get_by_role("button", name=name, exact=True).first.bounding_box()
            found[name] = None if box is None else (round(box["x"]), round(box["y"]))
        return found

    # --------------------------------------------------------------- one panel for every object (AC-1, AC-5)

    def test_01_a_task_a_decision_and_a_thread_are_one_panel_beside_the_conversation(self):
        page = self.page()
        for label, url, ready in (
            ("task", f"/projects/{self.project}/tasks?open=work:{self.task['id']}", ".wd[data-detail-kind='work']"),
            ("decision", f"/projects/{self.project}/tasks?open=decision:{self.decision['id']}", ".wd[data-detail-kind='decision']"),
            ("thread", f"/projects/{self.project}/conversations/{self.thread['id']}", ".thread"),
        ):
            with self.subTest(object=label):
                page.goto(url)
                panel = page.locator("#details")
                expect(panel.locator(ready)).to_be_visible()
                # One panel component: a single complementary landmark, the conversation or work beside it, never a third column.
                expect(page.locator("aside.ui-panel")).to_have_count(1)
                expect(page.locator("#content")).to_be_visible()
                content, side = page.locator("#content").bounding_box(), panel.bounding_box()
                self.assertGreater(side["x"], content["x"] + 300, "the panel sits to the right of the work")
                self.assertLessEqual(side["width"], 460)
                self.assertEqual(page.evaluate("document.querySelectorAll('.thread--docked, .thread--sheet, .agents-thread-pane, .agents-thread-sheet, .sk-tasks-sheet').length"), 0, "no other drawer or sheet for these objects")
                panel.locator(".ui-panel__body").focus()
                page.keyboard.press("Escape")
                expect(page.locator("aside.ui-panel")).to_have_count(0)

    def test_02_the_thread_replaces_the_task_with_back_and_marks_its_source(self):
        task = self.new_task("Order six moisture probes", blocker="Waiting for the supplier")
        page = self.page()
        panel = self.open_task(page, task)
        close_before = self.positions(page, ["Close details"])
        panel.get_by_role("link", name=re.compile("Message: Should the first sensors")).click()
        # The panel's content is the thread now, with the way back to the task; still one panel and two columns.
        expect(panel.locator(".thread")).to_be_visible()
        expect(panel.locator(".wd")).to_have_count(0)
        expect(page.locator("aside.ui-panel")).to_have_count(1)
        back = panel.get_by_role("button", name=re.compile(r"^Task #\d+$"))
        expect(back).to_be_visible()
        expect(panel.locator(".ui-panel__kind")).to_have_text("Thread")
        expect(panel.locator(".ui-panel__meta")).to_have_text("3 replies")
        expect(panel.locator(".thread__root")).to_contain_text("Should the first sensors measure soil moisture")
        # The conversation shows the source with a soft fill and its tag, which goes after two seconds; no ring or bar.
        source = page.locator(f"#message-{self.thread['messages'][0]['id']}")
        expect(source).to_be_visible()
        tag = source.locator("[data-source-tag]")
        expect(tag).to_have_text(f"Source of #{task['number']}")
        self.assertEqual(source.evaluate("el => getComputedStyle(el).boxShadow"), "none", "no ring or bar on the source")
        shot(page, "unified-panel-thread-from-task-desktop")
        expect(tag).to_have_count(0)
        # A control keeps its place: Close sits where it did on the task.
        self.assertEqual(self.positions(page, ["Close replies"])["Close replies"], close_before["Close details"])
        back.click()
        expect(panel.locator(".wd[data-detail-kind='work']")).to_be_visible()
        expect(panel.locator(".thread")).to_have_count(0)
        expect(page.locator("aside.ui-panel")).to_have_count(1)
        expect(page).not_to_have_url(re.compile("/conversations/"))
        panel.locator(".ui-panel__body").focus()
        page.keyboard.press("Escape")
        expect(page.locator("aside.ui-panel")).to_have_count(0)

    def test_03_on_the_phone_one_sheet_changes_its_content_and_keeps_its_height(self):
        task = self.new_task("Mount the rain gauge")
        page = self.page(phone=True)
        page.goto(f"/projects/{self.project}/tasks?open=work:{task['id']}")
        sheet = page.get_by_role("dialog", name="Details")
        expect(sheet.locator(".wd")).to_be_visible()
        expect(page.locator("[data-detent-sheet]")).to_have_count(1)
        expect(sheet).to_have_attribute("data-height", "half")
        sheet.get_by_role("link", name=re.compile("Message: Should the first sensors")).tap()
        thread = page.get_by_role("dialog", name="Replies")
        expect(thread.locator(".thread")).to_be_visible()
        # The same single sheet, at the height it had; the conversation is not a second layer.
        expect(page.locator("[data-detent-sheet]")).to_have_count(1)
        expect(thread).to_have_attribute("data-height", "half")
        shot(page, "unified-panel-thread-from-task-phone")
        thread.get_by_role("button", name=re.compile(r"^Task #\d+$")).tap()
        expect(page.get_by_role("dialog", name="Details").locator(".wd")).to_be_visible()
        page.wait_for_function(SETTLED)  # the sheet has finished settling before the next touch
        sheet = page.get_by_role("dialog", name="Details")
        top = sheet.bounding_box()["y"]
        drag_touch(page, top + 14, 830)
        expect(sheet).to_have_count(0)

    def test_04_a_thread_opened_from_the_conversation_is_the_same_sheet_on_the_phone(self):
        page = self.page(phone=True)
        page.goto(f"/projects/{self.project}/conversations/{self.thread['id']}")
        thread = page.get_by_role("dialog", name="Replies")
        expect(thread.locator(".thread")).to_be_visible()
        expect(page.locator("[data-detent-sheet]")).to_have_count(1)
        expect(thread).to_have_attribute("data-height", "full")
        expect(thread.locator(".ui-panel__kind")).to_have_text("Thread")
        expect(thread.locator(".thread__root")).to_contain_text("Should the first sensors measure soil moisture")
        thread.locator(".ui-panel__body").focus()
        page.keyboard.press("Escape")
        expect(thread).to_have_count(0)

    # ------------------------------------------------------------------- the task panel is calm (AC-3)

    def test_05_the_task_panel_is_rows_a_blocker_card_small_actions_activity_and_a_composer(self):
        task = self.new_task("Design a weatherproof enclosure", blocker="Waiting for the probe dimensions")
        for scheme in ("light", "dark"):
            with self.subTest(scheme=scheme):
                page = self.page(scheme=scheme)
                panel = self.open_task(page, task)
                for label in ("Status", "Owner", "Came from", "Due"):
                    expect(panel.locator(".wd-row dt", has_text=label)).to_be_visible()
                expect(panel.locator(".wd-row")).to_have_count(4)
                card = panel.get_by_role("region", name="Blocker")
                expect(card).to_contain_text("Waiting for Jonas Berg")
                expect(card).to_contain_text("Waiting for the probe dimensions")
                expect(card.get_by_label("What is it waiting for?")).to_have_count(0)  # the field shows only while editing
                actions = panel.get_by_role("group", name="Task actions")
                for name in ("Hand off to an agent", "Attach a result", "Link thought"):
                    box = actions.get_by_role("button", name=name).bounding_box()
                    self.assertAlmostEqual(box["height"], 32, delta=1, msg=f"{name} is a small action at the 32 px control height (#789)")
                # Empty sections are not shown, a single page has no pagination, and nothing is a select.
                for gone in ("Results", "Decisions", "In docs", "Linked thoughts"):
                    expect(panel.get_by_role("heading", name=gone)).to_have_count(0)
                expect(panel.locator(".ws-pages")).to_have_count(0)
                expect(panel.locator("select, .ui-select")).to_have_count(0)
                self.assertEqual(page.evaluate("[...document.querySelectorAll('#details select, #details .ui-select')].length"), 0)
                # Activity above the composer, which sits at the bottom of the panel with its audience line.
                composer = panel.get_by_placeholder(f"Write about #{task['number']} · @ · /")
                expect(composer).to_be_visible()
                bounds, composer_box, activity = panel.bounding_box(), composer.bounding_box(), panel.get_by_role("heading", name="Activity").bounding_box()
                self.assertGreater(composer_box["y"], activity["y"], "the composer is below Activity")
                self.assertLess(bounds["y"] + bounds["height"] - (composer_box["y"] + composer_box["height"]), 80, "the composer is at the bottom")
                audience = panel.locator(".wd__foot .composer__audience")
                expect(audience).to_contain_text("Everyone in Community garden sensors")
                expect(audience).not_to_contain_text("added by")  # who added it is in the activity; the line is not cut (#763 C8)
                shot(page, f"unified-panel-task-desktop-{scheme}")

    def test_06_status_owner_and_due_are_edited_in_place_and_the_activity_names_who_and_when(self):
        task = self.new_task("Calibrate the probes at two soil depths")
        page = self.page()
        panel = self.open_task(page, task)
        names = ["Status", "Owner", "Hand off to an agent", "Attach a result", "Link thought", "Close details"]
        before = self.positions(page, names)
        # Owner: a menu of people and agents, no select; the choice is stored.
        owner = panel.get_by_role("button", name="Owner", exact=True)
        owner.click()
        menu = page.get_by_role("menu", name="Owner")
        expect(menu.get_by_role("menuitemradio")).to_have_count(3)  # Nobody yet, Ada, Jonas
        menu.get_by_role("menuitemradio", name="Jonas Berg").click()
        expect(owner).to_contain_text("Jonas Berg")
        expect(panel.get_by_role("list", name="Task activity")).to_contain_text("reassigned it to Jonas Berg")
        self.assertEqual(self.stored(task)["owner"]["id"], self.jonas)
        # Due: a date saved at once, cleared at once.
        panel.get_by_role("button", name="Due, add a date").click()
        day = (datetime.date.today() + datetime.timedelta(days=9)).isoformat()
        panel.get_by_label("Due date").fill(day)
        expect(panel.get_by_role("button", name=re.compile(r"^Due "))).to_be_visible()
        self.assertEqual(self.stored(task)["dueOn"], day)
        # Status changes with a key; the controls did not move.
        panel.locator(".ui-panel__body").focus()
        page.keyboard.press("4")
        expect(panel.get_by_role("button", name="Status", exact=True)).to_contain_text("Done")
        self.assertEqual(self.stored(task)["status"], "done")
        # Activity: every change with its real author and time, newest first.
        activity = panel.get_by_role("list", name="Task activity")
        expect(activity.locator("li")).to_have_count(4)
        lines = activity.locator("li").all_inner_texts()
        self.assertIn("Ada marked it done", lines[0])
        self.assertIn("set it due", lines[1])
        self.assertIn("reassigned it to Jonas Berg", lines[2])
        self.assertIn("Ada made it from a message", lines[3])
        for line in activity.locator("time").all():
            expect(line).to_have_attribute("datetime", re.compile(r"^\d{4}-\d\d-\d\dT"))
        stored = api(self.ada_ctx, "GET", f"/api/v1/work/{task['id']}/activity")
        self.assertEqual([item["kind"] for item in stored["items"]], ["status", "due", "owner"])
        self.assertTrue(all(item["actor"]["id"] == self.ada and item["at"] for item in stored["items"]))
        # Spokój rule 7: no control changed place.
        self.assertEqual(self.positions(page, names), before)
        panel.get_by_role("button", name=re.compile(r"^Due ")).click()
        panel.get_by_role("button", name="Clear").click()
        expect(panel.get_by_role("button", name="Due, add a date")).to_be_visible()
        self.assertIsNone(self.stored(task)["dueOn"])

    def test_07_the_blocker_is_a_card_edited_in_place_and_resolve_undoes(self):
        task = self.new_task("Label the cables", blocker="Waiting for the printer")
        page = self.page()
        panel = self.open_task(page, task)
        card = panel.get_by_role("region", name="Blocker")
        card.get_by_role("button", name="Edit").click()
        field = card.get_by_label("What is it waiting for?")
        expect(field).to_have_value("Waiting for the printer")
        field.fill("Waiting for the label printer to arrive")
        card.get_by_role("button", name="Save").click()
        expect(card.get_by_label("What is it waiting for?")).to_have_count(0)
        expect(card).to_contain_text("Waiting for the label printer to arrive")
        self.assertEqual(self.stored(task)["blocker"], "Waiting for the label printer to arrive")
        card.get_by_role("button", name="Resolve").click()
        expect(panel.get_by_role("button", name="Status", exact=True)).to_contain_text("In progress")
        page.get_by_role("status").get_by_role("button", name="Undo").click()
        expect(panel.get_by_role("button", name="Status", exact=True)).to_contain_text("Blocked")
        stored = self.stored(task)
        self.assertEqual((stored["status"], stored["blocker"]), ("blocked", "Waiting for the label printer to arrive"))

    def test_08_the_composer_writes_to_the_activity_with_its_author_and_time(self):
        task = self.new_task("Choose the mast height")
        page = self.page()
        panel = self.open_task(page, task)
        composer = panel.get_by_placeholder(f"Write about #{task['number']} · @ · /")
        composer.fill("Did the supplier send the sizes?")
        panel.get_by_role("button", name=re.compile("^(Send to task|Start the discussion)$")).click()
        item = panel.get_by_role("list", name="Task activity").locator("li[data-message-id]")
        expect(item).to_have_count(1)
        expect(item.locator(".wd-act__who b")).to_have_text("Ada")
        expect(item).to_contain_text("Did the supplier send the sizes?")
        expect(item.locator("time")).to_have_attribute("datetime", re.compile(r"^\d{4}-"))
        stored = api(self.ada_ctx, "GET", f"/api/v1/work/{task['id']}/discussion")
        self.assertEqual(stored["root"]["body"], "Did the supplier send the sizes?")
        self.assertEqual(stored["root"]["authorId"], self.ada)
        # The composer stayed in its place and is empty again; the panel did not navigate.
        expect(composer).to_have_value("")
        expect(page).to_have_url(re.compile(r"/tasks"))
        expect(panel.get_by_role("link", name="Open in Conversation")).to_be_visible()

    def test_09_hand_off_result_and_link_thought_are_real_actions_with_back(self):
        task = self.new_task("Write the wiring notes")
        page = self.page()
        panel = self.open_task(page, task)
        panel.get_by_role("button", name="Hand off to an agent").click()
        expect(page.get_by_role("dialog", name="Hand off a task")).to_be_visible()
        page.keyboard.press("Escape")
        expect(page.get_by_role("dialog", name="Hand off a task")).to_have_count(0)
        panel.get_by_role("button", name="Link thought").click()
        expect(panel.get_by_role("group", name=re.compile("^Thoughts to link to"))).to_be_visible()
        page.keyboard.press("Escape")
        panel.get_by_role("button", name="Attach a result").click()
        expect(panel.get_by_role("heading", name="Record a result")).to_be_visible()
        back = panel.get_by_role("button", name=re.compile(r"^Task #\d+$"))
        back.click()
        expect(panel.locator(".wd[data-detail-kind='work']")).to_be_visible()

    # ------------------------------------------------------------------------ phone (AC-2, S10)

    def test_10_on_the_phone_status_is_one_row_that_opens_a_menu_of_five_states(self):
        task = self.new_task("Pick a gateway spot")
        page = self.page(phone=True)
        page.goto(f"/projects/{self.project}/tasks?open=work:{task['id']}")
        sheet = page.get_by_role("dialog", name="Details")
        expect(sheet.locator(".wd")).to_be_visible()
        expect(sheet.get_by_role("radiogroup", name="Status")).to_have_count(0)
        expect(sheet.get_by_text("Drag up for more")).to_have_count(0)
        status = sheet.get_by_role("button", name="Status", exact=True)
        status.tap()
        menu = page.get_by_role("menu", name="Status")
        items = menu.get_by_role("menuitemradio")
        expect(items).to_have_count(5)
        for index in range(5):
            self.assertGreaterEqual(items.nth(index).bounding_box()["height"], 44, "a real 44px target")
        shot(page, "unified-panel-status-menu-phone")
        items.nth(1).tap()
        expect(status).to_contain_text("In progress")
        self.assertEqual(self.stored(task)["status"], "in_progress")
        page.get_by_role("status").get_by_role("button", name="Undo").tap()
        expect(status).to_contain_text("Open")
        self.assertEqual(self.stored(task)["status"], "open")
        shot(page, "unified-panel-task-phone")

    # --------------------------------------------------- AC-4: the glyph, 1 to 5 and Undo on stored state

    def test_11_the_glyph_and_the_keys_change_the_stored_state_and_undo_restores_it(self):
        task = self.new_task("Order the second supplier's probes")
        page = self.page()
        page.goto(f"/projects/{self.project}/tasks?view=list")
        row = page.locator(f"li[data-work-id='{task['id']}']")
        expect(row).to_be_visible()
        # One tap on the state glyph moves it on at once, with Undo.
        row.locator(".ws-task__glyph").click()
        expect(row).to_have_attribute("data-status", "in_progress")
        self.assertEqual(self.stored(task)["status"], "in_progress")
        page.get_by_role("status").get_by_role("button", name="Undo").click()
        expect(row).to_have_attribute("data-status", "open")
        self.assertEqual(self.stored(task)["status"], "open")
        # The keys 1 to 5 on the focused row.
        for key, status in (("3", "blocked"), ("4", "done"), ("5", "not_pursued"), ("1", "open"), ("2", "in_progress")):
            row.locator(".ws-item").focus()
            page.keyboard.press(key)
            expect(row).to_have_attribute("data-status", status)
            self.assertEqual(self.stored(task)["status"], status)
        # The same keys in the open panel, and the status menu, both with Undo.
        panel = self.open_task(page, task)
        panel.locator(".ui-panel__body").focus()
        page.keyboard.press("4")
        expect(panel.get_by_role("button", name="Status", exact=True)).to_contain_text("Done")
        self.assertEqual(self.stored(task)["status"], "done")
        page.get_by_role("status").get_by_role("button", name="Undo").click()
        expect(panel.get_by_role("button", name="Status", exact=True)).to_contain_text("In progress")
        self.assertEqual(self.stored(task)["status"], "in_progress")
        panel.get_by_role("button", name="Status", exact=True).click()
        page.get_by_role("menu", name="Status").get_by_role("menuitemradio", name="Open").click()
        expect(panel.get_by_role("button", name="Status", exact=True)).to_contain_text("Open")
        self.assertEqual(self.stored(task)["status"], "open")
        page.get_by_role("status").get_by_role("button", name="Undo").click()
        expect(panel.get_by_role("button", name="Status", exact=True)).to_contain_text("In progress")
        self.assertEqual(self.stored(task)["status"], "in_progress")

    def test_12_a_thoughts_linked_tasks_open_in_the_one_sheet_and_a_task_opens_over_them_with_back(self):
        """The phone's linked-tasks sheet is the one sheet (#488 AC-1/2): a task opened from it replaces its content, with back."""
        sketch = api(self.ada_ctx, "POST", f"/api/v1/workspaces/{self.workspace}/sketches", {"title": "Mast options", "scope": "project", "projectId": self.project}, 201)
        thought = api(self.ada_ctx, "POST", f"/api/v1/sketches/{sketch['id']}/thoughts", {"text": "A taller mast clears the hedge", "x": 0, "y": 0}, 201)["thought"]
        task = self.new_task("Choose the mast height")
        api(self.ada_ctx, "POST", self.root + "/links", {"from": {"type": "work", "id": task["id"]}, "to": {"type": "thought", "id": thought["id"]}}, 201)
        page = self.page(phone=True)
        page.goto(f"/projects/{self.project}/map/{sketch['id']}")
        show_map_as(page, "List", touch=True)
        badge = page.locator(f'.sk-outline-list li[data-id="{thought["id"]}"] > .sk-outline-row .sk-work')
        expect(badge).to_be_visible()
        badge.tap()
        sheet = page.get_by_role("dialog", name=re.compile("^Details"))
        tasks = sheet.get_by_role("list", name=re.compile("^Tasks linked to"))
        expect(tasks).to_be_visible()
        expect(page.locator("[data-detent-sheet]")).to_have_count(1)
        expect(page.locator(".sk-tasks-sheet")).to_have_count(0)
        page.wait_for_function(SETTLED)
        shot(page, "unified-panel-thought-tasks-phone")
        sheet.get_by_role("link", name=re.compile("Choose the mast height")).tap()
        expect(sheet.locator(".wd[data-detail-kind='work']")).to_be_visible()
        expect(page.locator("[data-detent-sheet]")).to_have_count(1)
        sheet.get_by_role("button", name="Tasks", exact=True).tap()
        expect(tasks).to_be_visible()
        sheet.get_by_role("button", name="Close details").tap()
        expect(sheet).to_have_count(0)
        expect(badge).to_be_focused()

    def test_13_renders_for_the_visual_review_in_both_schemes_on_both_devices(self):
        """Screenshots of the one panel for a separate, neutral visual review (the interaction is proved above)."""
        task = self.new_task("Order six moisture probes for the far beds", blocker="Waiting for the supplier")
        api(self.ada_ctx, "PATCH", f"/api/v1/work/{task['id']}", {"dueOn": (datetime.date.today() + datetime.timedelta(days=6)).isoformat(), "expectedVersion": api(self.ada_ctx, "GET", f"/api/v1/work/{task['id']}")["version"]})
        for scheme in ("light", "dark"):
            for phone in (False, True):
                with self.subTest(scheme=scheme, phone=phone):
                    page = self.page(phone=phone, scheme=scheme)
                    device = "phone" if phone else "desktop"
                    panel = self.open_task(page, task) if not phone else None
                    if phone:
                        page.goto(f"/projects/{self.project}/tasks?open=work:{task['id']}")
                        sheet = page.get_by_role("dialog", name="Details")
                        expect(sheet.locator(".wd")).to_be_visible()
                        page.wait_for_function(SETTLED)
                        shot(page, f"unified-panel-task-{device}-{scheme}")
                        sheet.get_by_role("link", name=re.compile("Message: Should the first sensors")).tap()
                        expect(page.get_by_role("dialog", name="Replies").locator(".thread")).to_be_visible()
                        page.wait_for_function(SETTLED)
                        shot(page, f"unified-panel-thread-{device}-{scheme}")
                    else:
                        shot(page, f"unified-panel-task-{device}-{scheme}")
                        panel.get_by_role("link", name=re.compile("Message: Should the first sensors")).click()
                        expect(panel.locator(".thread")).to_be_visible()
                        shot(page, f"unified-panel-thread-{device}-{scheme}")
                    page.goto(f"/projects/{self.project}/tasks?open=decision:{self.decision['id']}")
                    expect(page.locator("#details .wd[data-detail-kind='decision']")).to_be_visible()
                    page.wait_for_function(SETTLED)
                    shot(page, f"unified-panel-decision-{device}-{scheme}")


if __name__ == "__main__":
    unittest.main()
