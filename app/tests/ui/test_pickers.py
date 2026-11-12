"""Browser tests for the date and time pickers (issue #1251, apps/web/src/ui/DateField.tsx and TimeField.tsx).

Runs with the other tests/ui modules through scripts/check_ui.sh against the running Compose application.
The browser's own <input type="date"> and <input type="time"> draw their popup outside the app, so it ignores the Prostota tokens, the
dark theme and the phone sheet. The app's pickers are a text field you can type in plus a month (date) or a list of 30-minute steps
(time): a popover on a computer, the select's bottom sheet on a phone. The tests check what a person and a screen reader meet: that no
native date or time control or datalist is on the pages that had them, typed entry ("14 Nov", "9 pm"), every key, the mouse and
the touch paths, the semantics, the tokens in both themes and axe. Quiet hours (Settings, Notifications) and a task's Due (the task
panel) are the two places they appear on a plain account; a schedule's time is covered with the schedule in test_agent_schedules.
FLUX_UI_BROWSER selects chromium (default) or webkit.
"""

from __future__ import annotations

import hashlib
import os
import re
import time
import unittest
import uuid
from pathlib import Path

from playwright.sync_api import BrowserContext, Locator, Page, expect, sync_playwright

from app_select import listbox_of
from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, shot, start_forwarder
from test_work_pagination import api

AXE = Path(__file__).parent / "vendor" / "axe-core-4.13.0.min.js"
AXE_SHA256 = "c24f097bd2f451d4f933e8bc7d8d539f8672a2ebcb5cc9f9f3eec8ca9470a0c1"
PASSWORD = "a calm way to pick a day"
SETTLED = "() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().endTime === Infinity)"
NATIVE = "input[type=date], input[type=time], input[type=datetime-local], input[type=month], input[type=week], datalist"


class DateAndTimePickers(unittest.TestCase):
    """Tests share one account with a project and tasks; each opens its own page."""

    pw = None
    browser = None
    ada: BrowserContext

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        print(f"ACTUAL_UI_ENGINE={cls.browser.browser_type.name}", flush=True)
        expect.set_options(timeout=10000)
        stamp = uuid.uuid4().hex[:8]
        cls.ada = cls.browser.new_context(base_url=ORIGIN, service_workers="block")
        api(cls.ada, "POST", "/api/auth/sign-up/email", {"name": "Ada Kowalska", "email": f"pickers-ada-{stamp}@example.test", "password": PASSWORD})
        workspace = api(cls.ada, "POST", "/api/v1/workspaces", {"name": "Garden co-op"}, 201)["id"]
        cls.project = api(cls.ada, "POST", f"/api/v1/workspaces/{workspace}/projects", {"name": "Community garden sensors", "visibility": "restricted"}, 201)["id"]
        cls.root = f"/api/v1/projects/{cls.project}"
        cls.tasks: dict[str, dict] = {}

    @classmethod
    def tearDownClass(cls) -> None:
        cls.ada.close()
        cls.browser.close()
        cls.pw.stop()

    # ------------------------------------------------------------------------------------------------ helpers

    def page(self, *, phone: bool = False, dark: bool = False) -> Page:
        options: dict = {"base_url": ORIGIN, "storage_state": self.ada.storage_state(), "color_scheme": "dark" if dark else "light", "locale": "en-GB",
                         "timezone_id": "Europe/Warsaw", "service_workers": "block"}
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=DESKTOP, device_scale_factor=1)
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def new_task(self, title: str) -> dict:
        task = api(self.ada, "POST", self.root + "/work", {"title": title}, 201)
        self.tasks[task["id"]] = task
        return task

    def stored(self, task: dict) -> dict:
        return api(self.ada, "GET", f"/api/v1/work/{task['id']}")

    def due(self, task: dict, expected: str | None) -> str | None:
        """A task's stored due day once it is `expected` (a change saves a moment after the click), else what it is."""
        value = None
        for _ in range(40):
            value = self.stored(task)["dueOn"]
            if value == expected:
                break
            time.sleep(0.25)
        return value

    def prefs(self, until=None) -> dict:
        """The stored notification preferences; waits until `until(prefs)` holds (settings save as you change them)."""
        prefs: dict = {}
        for _ in range(40):
            prefs = api(self.ada, "GET", "/api/v1/notification-preferences")
            if until is None or until(prefs):
                return prefs
            time.sleep(0.25)
        return prefs

    def open_task(self, page: Page, task: dict, *, phone: bool = False) -> Locator:
        """The task's panel (a side panel on a computer, the "Details" sheet on a phone)."""
        page.goto(f"/projects/{self.project}/tasks?open=work:{task['id']}")
        panel = page.get_by_role("dialog", name="Details") if phone else page.locator("#details")
        expect(panel.locator(f".wd[data-detail-id='{task['id']}']")).to_be_visible()
        expect(panel.locator("[data-detail-relations-phase]")).to_have_attribute("data-detail-relations-phase", "ready")
        return panel

    def quiet_hours(self, page: Page, *, tap: bool = False) -> tuple[Locator, Locator]:
        """Settings > Notifications with quiet hours switched on and open: the From and Until fields."""
        page.goto("/settings/notifications")
        click = (lambda locator: locator.tap()) if tap else (lambda locator: locator.click())
        click(page.get_by_role("button", name="Change quiet hours"))
        quiet = page.get_by_role("switch", name="Use quiet hours")
        expect(quiet).to_be_visible()
        if quiet.get_attribute("aria-checked") != "true":
            click(quiet)
            expect(quiet).to_have_attribute("aria-checked", "true")
        start, end = page.get_by_role("combobox", name="From", exact=True), page.get_by_role("combobox", name="Until", exact=True)
        expect(start).to_be_visible()
        return start, end

    def today(self, page: Page, days: int = 0) -> str:
        return page.evaluate("""(days) => { const d = new Date(); d.setDate(d.getDate() + days);
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }""", days)

    @staticmethod
    def day(scope: Locator, iso: str) -> Locator:
        return scope.locator(f'button[data-day="{iso}"]')

    def axe(self, page: Page, where: str, *scopes: str) -> None:
        source = AXE.read_bytes()
        self.assertEqual(hashlib.sha256(source).hexdigest(), AXE_SHA256, "the vendored axe is the one that was verified")
        page.wait_for_function(SETTLED)
        page.evaluate(source.decode())
        for scope in scopes:
            result = page.evaluate("""async (scope) => (await axe.run(document.querySelector(scope), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }))
                .violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ') + ' :: ' + n.failureSummary.split('\\n').slice(1, 3).join(' ')) }))""", scope)
            self.assertEqual(result, [], f"axe violations on {where} ({scope})")

    # ------------------------------------------------------------------------------------------------ no native control

    def test_01_no_native_date_or_time_control_and_no_datalist_is_left_on_the_pages_that_had_them(self) -> None:
        """The browser's own popups ignore the tokens, the dark theme and the phone sheet: none is left."""
        task = self.new_task("Order six moisture probes")
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page(phone=phone)
                start, _ = self.quiet_hours(page, tap=phone)
                expect(page.locator(NATIVE)).to_have_count(0)
                expect(start).to_have_attribute("role", "combobox")
                self.assertEqual(start.get_attribute("type"), "text")
                panel = self.open_task(page, task, phone=phone)
                expect(page.locator(NATIVE)).to_have_count(0)
                (panel.get_by_role("button", name="Due, add a date").tap if phone else panel.get_by_role("button", name="Due, add a date").click)()
                expect(page.get_by_role("dialog", name="Due date")).to_be_visible()
                expect(page.locator(NATIVE)).to_have_count(0)
                self.assertEqual(page.evaluate("document.querySelectorAll('input[type=date], input[type=time]').length"), 0)

    # ------------------------------------------------------------------------------------------------ time field

    def test_02_a_time_is_typed_in_the_ways_people_write_it_and_saved(self) -> None:
        page = self.page()
        start, end = self.quiet_hours(page)
        expect(start).to_have_attribute("aria-expanded", "false")
        for typed, shown, stored in (("21:30", "21:30", "21:30"), ("9 pm", "21:00", "21:00"), ("8", "8:00", "08:00"), ("0845", "8:45", "08:45"), ("noon", "12:00", "12:00")):
            with self.subTest(typed=typed):
                start.fill(typed)
                start.press("Enter")
                expect(start).to_have_value(shown)
                self.assertEqual(self.prefs(lambda prefs: prefs["quietHours"]["start"] == stored)["quietHours"]["start"], stored)
        row = page.locator(".sset-row").filter(has=page.get_by_text("Quiet hours", exact=True)).first
        expect(row).to_contain_text("12:00–")
        # Leaving the field commits too, and the text it keeps is the field's own form.
        end.fill("6:15 am")
        page.get_by_role("heading", level=2, name="Notifications").click()
        expect(end).to_have_value("6:15")
        self.assertEqual(self.prefs(lambda prefs: prefs["quietHours"]["end"] == "06:15")["quietHours"]["end"], "06:15")
        expect(row).to_contain_text("12:00–6:15")

    def test_03_text_that_is_not_a_time_is_marked_invalid_and_the_last_time_comes_back(self) -> None:
        page = self.page()
        start, _ = self.quiet_hours(page)
        start.fill("10:00")
        start.press("Enter")
        expect(start).to_have_value("10:00")
        self.prefs(lambda prefs: prefs["quietHours"]["start"] == "10:00")
        start.fill("soon")
        start.press("Enter")
        expect(start).to_have_attribute("aria-invalid", "true")
        expect(start).to_have_value("soon")
        expect(page.locator(".ui-pick[data-invalid]")).to_have_count(1)
        expect(page.get_by_role("status").filter(has_text="Not a time")).to_have_count(1)
        # The hint is what a screen reader hears after the name.
        described = start.get_attribute("aria-describedby")
        self.assertIn("Type a time", page.locator(f'[id="{described.split()[-1]}"]').inner_text())
        page.keyboard.press("Tab")
        expect(start).to_have_value("10:00")
        expect(start).not_to_have_attribute("aria-invalid", "true")
        self.assertEqual(self.prefs()["quietHours"]["start"], "10:00")
        # Esc puts the last time back too, and leaves the page's own Esc alone while there is nothing to put back.
        start.fill("11:45")
        start.press("Escape")
        expect(start).to_have_value("10:00")

    def test_04_the_time_list_opens_with_the_keys_and_moves_chooses_and_closes(self) -> None:
        page = self.page()
        start, _ = self.quiet_hours(page)
        start.fill("9:00")
        start.press("Enter")
        self.prefs(lambda prefs: prefs["quietHours"]["start"] == "09:00")
        start.focus()
        expect(start).to_be_focused()
        start.press("ArrowDown")
        box = listbox_of(start)
        expect(box).to_be_visible()
        expect(box.get_by_role("option")).to_have_count(48)
        expect(box.get_by_role("option").first).to_have_text("0:00")
        expect(box.get_by_role("option").last).to_have_text("23:30")
        expect(box.get_by_role("option", name="9:00", exact=True)).to_have_attribute("aria-selected", "true")
        expect(start).to_have_attribute("aria-activedescendant", re.compile(r".+"))
        expect(box.locator("[data-active]")).to_have_text("9:00")
        # Focus stays in the field; the arrows move through the list and the field shows the time they are on.
        for key, shown in (("ArrowDown", "9:30"), ("ArrowDown", "10:00"), ("ArrowUp", "9:30"), ("PageDown", "14:30"), ("PageUp", "9:30")):
            start.press(key)
            expect(start).to_be_focused()
            expect(box.locator("[data-active]")).to_have_text(shown)
            expect(start).to_have_value(shown)
        expect(box.locator("[data-active]")).to_be_in_viewport()
        start.press("Enter")
        expect(start).to_have_attribute("aria-expanded", "false")
        expect(start).to_have_value("9:30")
        self.assertEqual(self.prefs(lambda prefs: prefs["quietHours"]["start"] == "09:30")["quietHours"]["start"], "09:30")
        # Esc closes without choosing and puts the field back.
        start.press("ArrowDown")
        start.press("ArrowDown")
        expect(start).to_have_value("10:00")
        start.press("Escape")
        expect(start).to_have_attribute("aria-expanded", "false")
        expect(start).to_have_value("9:30")
        expect(start).to_be_focused()
        # Typing in the open list follows the typed time; a time off the half hour is added in its place.
        start.press("ArrowDown")
        start.press("Control+A")
        start.type("8:45")
        expect(start).to_have_attribute("aria-expanded", "true")
        expect(box.locator("[data-active]")).to_have_text("9:00")
        start.press("Enter")
        expect(start).to_have_value("8:45")
        self.assertEqual(self.prefs(lambda prefs: prefs["quietHours"]["start"] == "08:45")["quietHours"]["start"], "08:45")
        start.press("ArrowDown")
        expect(box.get_by_role("option")).to_have_count(49)
        expect(box.get_by_role("option", name="8:45", exact=True)).to_have_attribute("aria-selected", "true")
        # Tab keeps what is in the field and moves on.
        start.press("ArrowDown")
        expect(start).to_have_value("9:00")
        start.press("Tab")
        expect(start).to_have_attribute("aria-expanded", "false")
        expect(start).to_have_value("9:00")
        self.assertEqual(self.prefs(lambda prefs: prefs["quietHours"]["start"] == "09:00")["quietHours"]["start"], "09:00")

    def test_05_the_time_list_with_a_mouse_the_chevron_opens_it_an_option_chooses_and_a_press_outside_closes_it(self) -> None:
        page = self.page()
        start, end = self.quiet_hours(page)
        chevrons = page.get_by_role("button", name="Choose a time")
        expect(chevrons).to_have_count(2)
        before = [start.bounding_box(), end.bounding_box()]
        chevrons.first.click()
        box = listbox_of(start)
        expect(box).to_be_visible()
        expect(start).to_be_focused()
        field, layer = start.locator("xpath=ancestor::span[contains(@class,'ui-pick')]").bounding_box(), page.locator(".ui-select__pop").bounding_box()
        self.assertGreaterEqual(layer["width"], field["width"] - 1, "the list is at least as wide as its field")
        self.assertTrue(abs(layer["y"] - (field["y"] + field["height"])) < 8 or abs(layer["y"] + layer["height"] - field["y"]) < 8, "the list sits against its field")
        box.get_by_role("option", name="10:30", exact=True).click()
        expect(start).to_have_value("10:30")
        expect(start).to_have_attribute("aria-expanded", "false")
        self.assertEqual(self.prefs(lambda prefs: prefs["quietHours"]["start"] == "10:30")["quietHours"]["start"], "10:30")
        # A second click on the chevron closes it; a press outside closes it and keeps the value.
        chevrons.nth(1).click()
        listbox_of(end)
        chevrons.nth(1).click()
        expect(end).to_have_attribute("aria-expanded", "false")
        chevrons.nth(1).click()
        expect(end).to_have_attribute("aria-expanded", "true")
        page.get_by_role("heading", level=2, name="Notifications").click()
        expect(end).to_have_attribute("aria-expanded", "false")
        expect(page.locator(".ui-select__pop")).to_have_count(0)
        # Opening and choosing never moved a field.
        self.assertEqual([start.bounding_box(), end.bounding_box()], before)

    def test_06_the_time_field_is_a_labelled_combobox_a_screen_reader_can_use(self) -> None:
        page = self.page()
        start, end = self.quiet_hours(page)
        for field, name in ((start, "From"), (end, "Until")):
            expect(field).to_have_attribute("role", "combobox")
            expect(field).to_have_attribute("aria-haspopup", "listbox")
            expect(field).to_have_attribute("aria-autocomplete", "none")
            expect(field).not_to_have_attribute("aria-controls", re.compile(".+"))
            self.assertEqual(page.get_by_label(name, exact=True).count(), 1, "one control carries the name")
        start.press("ArrowDown")
        box = listbox_of(start)
        expect(box).to_have_attribute("role", "listbox")
        expect(box).to_have_attribute("aria-label", "From")
        expect(start).to_have_attribute("aria-controls", re.compile(".+"))
        self.axe(page, "the open time list", ".nset__times", ".ui-select__pop")
        page.keyboard.press("Escape")

    # ------------------------------------------------------------------------------------------------ date field

    def test_07_a_due_date_is_typed_and_saved_with_enter(self) -> None:
        task = self.new_task("Label the cables")
        page = self.page()
        panel = self.open_task(page, task)
        panel.get_by_role("button", name="Due, add a date").click()
        field = panel.get_by_label("Due date", exact=True)
        # The field takes the caret as it appears and the month is open under it, with nothing chosen yet.
        expect(field).to_be_focused()
        expect(field).to_have_value("")
        dialog = page.get_by_role("dialog", name="Due date")
        expect(dialog).to_be_visible()
        expect(self.day(dialog, self.today(page))).to_have_attribute("data-today", "")
        expect(dialog.locator("[data-selected]")).to_have_count(0)
        field.fill("14 Nov 2027")
        expect(dialog.get_by_role("heading", name="November 2027")).to_be_visible()
        field.press("Enter")
        expect(panel.get_by_role("button", name="Due 14 Nov 2027")).to_be_visible()
        self.assertEqual(self.stored(task)["dueOn"], "2027-11-14")
        expect(panel.get_by_role("button", name="Due 14 Nov 2027")).to_be_focused()
        for typed, expected in (("tomorrow", self.today(page, 1)), ("2028-03-02", "2028-03-02"), ("9 Jan 2029", "2029-01-09"), ("14.11.2027", "2027-11-14")):
            with self.subTest(typed=typed):
                panel.get_by_role("button", name=re.compile(r"^Due ")).click()
                field = panel.get_by_label("Due date", exact=True)
                field.fill(typed)
                field.press("Enter")
                expect(panel.get_by_label("Due date", exact=True)).to_have_count(0)
                self.assertEqual(self.due(task, expected), expected)
        # Text that is not a day is marked and keeps the editor open; Esc leaves with the date unchanged.
        panel.get_by_role("button", name=re.compile(r"^Due ")).click()
        field = panel.get_by_label("Due date", exact=True)
        field.fill("31 Nov")
        field.press("Enter")
        expect(field).to_have_attribute("aria-invalid", "true")
        expect(page.get_by_role("status").filter(has_text="Not a date")).to_have_count(1)
        field.press("Escape")
        expect(panel.get_by_label("Due date", exact=True)).to_have_count(0)
        expect(panel.get_by_role("button", name=re.compile(r"^Due "))).to_be_focused()
        self.assertEqual(self.stored(task)["dueOn"], "2027-11-14")

    def test_08_the_month_by_keyboard_arrows_pages_tab_and_escape(self) -> None:
        task = self.new_task("Order the wire")
        page = self.page()
        panel = self.open_task(page, task)
        panel.get_by_role("button", name="Due, add a date").click()
        field = panel.get_by_label("Due date", exact=True)
        field.fill("14 Nov 2027")
        field.press("Enter")
        expect(panel.get_by_role("button", name="Due 14 Nov 2027")).to_be_visible()
        panel.get_by_role("button", name="Due 14 Nov 2027").click()
        field = panel.get_by_label("Due date", exact=True)
        dialog = page.get_by_role("dialog", name="Due date")
        expect(field).to_have_value("14 Nov 2027")
        selected = self.day(dialog, "2027-11-14")
        expect(selected).to_have_attribute("data-selected", "")
        expect(selected.locator("xpath=..")).to_have_attribute("aria-selected", "true")
        expect(selected).to_have_attribute("aria-label", re.compile(r"^Sunday,? 14 November 2027$"))
        # Down from the field moves into the month, onto the chosen day.
        field.press("ArrowDown")
        expect(selected).to_be_focused()
        grid = dialog.get_by_role("grid")
        for key, iso in (("ArrowRight", "2027-11-15"), ("ArrowDown", "2027-11-22"), ("ArrowLeft", "2027-11-21"), ("ArrowUp", "2027-11-14"),
                         ("Home", "2027-11-08"), ("End", "2027-11-14"), ("PageDown", "2027-12-14"), ("PageUp", "2027-11-14"),
                         ("Shift+PageDown", "2028-11-14"), ("Shift+PageUp", "2027-11-14"), ("ArrowRight", "2027-11-15")):
            page.keyboard.press(key)
            expect(self.day(dialog, iso)).to_be_focused()
        expect(dialog.get_by_role("heading", name="November 2027")).to_be_visible()
        # The month shows the days of its neighbours (muted) and they can be reached by the arrows across the edge.
        for _ in range(16):
            page.keyboard.press("ArrowRight")
        expect(self.day(dialog, "2027-12-01")).to_be_focused()
        expect(dialog.get_by_role("heading", name="December 2027")).to_be_visible()
        expect(grid).to_be_visible()
        # Tab stays in the dialog: the month's days are one stop, then Today, Tomorrow, Clear, then round to the month arrows.
        page.keyboard.press("Tab")
        expect(dialog.get_by_role("button", name="Today", exact=True)).to_be_focused()
        page.keyboard.press("Tab")
        expect(dialog.get_by_role("button", name="Tomorrow", exact=True)).to_be_focused()
        page.keyboard.press("Tab")
        expect(dialog.get_by_role("button", name="Clear", exact=True)).to_be_focused()
        page.keyboard.press("Tab")
        expect(dialog.get_by_role("button", name="Previous month")).to_be_focused()
        page.keyboard.press("Shift+Tab")
        expect(dialog.get_by_role("button", name="Clear", exact=True)).to_be_focused()
        # Enter on a day chooses it and saves at once.
        page.keyboard.press("Shift+Tab")
        page.keyboard.press("Shift+Tab")
        page.keyboard.press("Shift+Tab")
        expect(self.day(dialog, "2027-12-01")).to_be_focused()
        page.keyboard.press("ArrowRight")
        page.keyboard.press("Enter")
        expect(panel.get_by_role("button", name="Due 2 Dec 2027")).to_be_visible()
        self.assertEqual(self.stored(task)["dueOn"], "2027-12-02")
        expect(page.get_by_role("dialog", name="Due date")).to_have_count(0)
        expect(panel.get_by_role("button", name="Due 2 Dec 2027")).to_be_focused()
        # Tab from the field goes into the dialog; Clear by keyboard; Esc from inside leaves unchanged.
        panel.get_by_role("button", name="Due 2 Dec 2027").click()
        field = panel.get_by_label("Due date", exact=True)
        field.press("Tab")
        expect(self.day(dialog, "2027-12-02")).to_be_focused()
        page.keyboard.press("Escape")
        expect(panel.get_by_label("Due date", exact=True)).to_have_count(0)
        expect(panel.get_by_role("button", name="Due 2 Dec 2027")).to_be_focused()
        self.assertEqual(self.stored(task)["dueOn"], "2027-12-02")
        panel.get_by_role("button", name="Due 2 Dec 2027").click()
        panel.get_by_label("Due date", exact=True).press("ArrowDown")
        for _ in range(3):
            page.keyboard.press("Tab")
        expect(dialog.get_by_role("button", name="Clear", exact=True)).to_be_focused()
        page.keyboard.press("Enter")
        expect(panel.get_by_role("button", name="Due, add a date")).to_be_visible()
        expect(panel.get_by_role("button", name="Due, add a date")).to_be_focused()
        self.assertIsNone(self.due(task, None))

    def test_09_the_month_with_a_mouse_a_day_today_tomorrow_clear_and_a_press_outside(self) -> None:
        task = self.new_task("Water the beds")
        page = self.page()
        panel = self.open_task(page, task)
        dialog = page.get_by_role("dialog", name="Due date")
        panel.get_by_role("button", name="Due, add a date").click()
        expect(dialog).to_be_visible()
        # Clear is there and off while there is no date.
        expect(dialog.get_by_role("button", name="Clear", exact=True)).to_be_disabled()
        # Today and Tomorrow save at once.
        dialog.get_by_role("button", name="Tomorrow", exact=True).click()
        expect(panel.get_by_role("button", name=re.compile(r"^Due "))).to_be_visible()
        self.assertEqual(self.due(task, self.today(page, 1)), self.today(page, 1))
        panel.get_by_role("button", name=re.compile(r"^Due ")).click()
        expect(self.day(dialog, self.today(page, 1))).to_have_attribute("data-selected", "")
        dialog.get_by_role("button", name="Today", exact=True).click()
        self.assertEqual(self.due(task, self.today(page)), self.today(page))
        # A day of the next month by the arrow and a click.
        panel.get_by_role("button", name=re.compile(r"^Due ")).click()
        dialog.get_by_role("button", name="Next month").click()
        title = dialog.get_by_role("heading").first.inner_text()
        self.assertRegex(title, r"^[A-Z][a-z]+ \d{4}$")
        expect(dialog.get_by_role("heading", name=title)).to_have_count(1)
        target = dialog.locator('button[data-day$="-15"]:not([data-outside])')
        expect(target).to_have_count(1)
        iso = target.get_attribute("data-day")
        target.click()
        self.assertEqual(self.due(task, iso), iso)
        # Clear takes it away, and a press outside leaves it as it was.
        panel.get_by_role("button", name=re.compile(r"^Due ")).click()
        expect(dialog.get_by_role("button", name="Clear", exact=True)).to_be_enabled()
        page.get_by_role("heading", level=1).first.click()
        expect(dialog).to_have_count(0)
        expect(panel.get_by_label("Due date", exact=True)).to_have_count(0)
        self.assertEqual(self.stored(task)["dueOn"], iso)
        panel.get_by_role("button", name=re.compile(r"^Due ")).click()
        dialog.get_by_role("button", name="Clear", exact=True).click()
        expect(panel.get_by_role("button", name="Due, add a date")).to_be_visible()
        self.assertIsNone(self.due(task, None))

    def test_10_the_date_dialog_is_named_its_days_are_read_in_full_and_axe_finds_nothing(self) -> None:
        task = self.new_task("Count the probes")
        for dark in (False, True):
            with self.subTest(dark=dark):
                page = self.page(dark=dark)
                panel = self.open_task(page, task)
                panel.get_by_role("button", name="Due, add a date").click()
                dialog = page.get_by_role("dialog", name="Due date")
                expect(dialog).to_be_visible()
                field = panel.get_by_label("Due date", exact=True)
                expect(field).to_have_attribute("aria-describedby", re.compile(r".+"))
                self.assertIn("Type a date", page.locator(f'[id="{field.get_attribute("aria-describedby").split()[-1]}"]').inner_text())
                chevron = panel.get_by_role("button", name="Choose a date")
                expect(chevron).to_have_attribute("aria-haspopup", "dialog")
                expect(chevron).to_have_attribute("aria-expanded", "true")
                expect(dialog.get_by_role("grid")).to_have_attribute("aria-labelledby", re.compile(r".+"))
                expect(dialog.get_by_role("columnheader")).to_have_count(7)
                expect(dialog.get_by_role("gridcell")).to_have_count(42)
                today = self.day(dialog, self.today(page))
                expect(today).to_have_attribute("aria-current", "date")
                self.assertRegex(today.get_attribute("aria-label"), r"^\w+day,? \d{1,2} \w+ \d{4}, today$")
                self.axe(page, "the open date picker", ".wd", ".ui-cal-pop")
                page.keyboard.press("Escape")

    # ------------------------------------------------------------------------------------------------ tokens

    def test_11_the_fields_and_the_month_wear_the_tokens_in_both_themes(self) -> None:
        task = self.new_task("Check the gutters")
        for dark in (False, True):
            with self.subTest(dark=dark):
                page = self.page(dark=dark)
                panel = self.open_task(page, task)
                panel.get_by_role("button", name=re.compile(r"^Due")).click()
                dialog = page.get_by_role("dialog", name="Due date")
                dialog.get_by_role("button", name="Tomorrow", exact=True).click()
                expect(panel.get_by_role("button", name=re.compile(r"^Due "))).to_be_visible()
                panel.get_by_role("button", name=re.compile(r"^Due ")).click()
                expect(dialog).to_be_visible()
                page.wait_for_function(SETTLED)
                page.mouse.move(2, 2)  # a hovered field takes the hover border
                read = page.evaluate("""(args) => {
                    const probe = (prop, token) => { const el = document.createElement('i'); el.style[prop] = `var(${token})`; document.body.append(el); const v = getComputedStyle(el)[prop]; el.remove(); return v; };
                    const pop = document.querySelector('.ui-cal-pop');
                    const selected = pop.querySelector('[data-selected]');
                    const today = pop.querySelector('[data-today]');
                    const plain = pop.querySelector('.ui-cal__day:not([data-selected], [data-today], [data-outside], :disabled)');
                    const outside = pop.querySelector('[data-outside]');
                    const field = document.querySelector('.ui-pick');
                    const cs = (el) => getComputedStyle(el);
                    return {
                      popBg: cs(pop).backgroundColor, el: probe('backgroundColor', '--el'), shadow: cs(pop).boxShadow, radius: cs(pop).borderTopLeftRadius,
                      selBg: cs(selected).backgroundColor, inv: probe('backgroundColor', '--inv'), selColor: cs(selected).color, oninv: probe('color', '--oninv'),
                      todayShadow: cs(today).boxShadow, todayBg: cs(today).backgroundColor,
                      plainColor: cs(plain).color, t1: probe('color', '--t1'), outsideColor: cs(outside).color, t3: probe('color', '--t3'),
                      fieldBg: cs(field).backgroundColor, fieldBorder: cs(field).borderTopColor, line2: probe('borderTopColor', '--line2'), fieldRadius: cs(field).borderTopLeftRadius,
                      fieldFocus: cs(field).boxShadow,
                    };
                }""", {})
                self.assertEqual(read["popBg"], read["el"], "the month is the --el surface")
                self.assertNotEqual(read["shadow"], "none", "the month lifts with the pop-over shadow")
                self.assertEqual(read["radius"], "14px")
                self.assertEqual(read["selBg"], read["inv"], "the chosen day is filled --inv")
                self.assertEqual(read["selColor"], read["oninv"], "and reads in --oninv")
                self.assertIn("inset", read["todayShadow"], "today is outlined")
                self.assertEqual(read["todayBg"], "rgba(0, 0, 0, 0)", "and not filled")
                self.assertEqual(read["plainColor"], read["t1"])
                self.assertEqual(read["outsideColor"], read["t3"], "days of the neighbouring months are muted")
                self.assertEqual(read["fieldBg"], read["el"], "the field is the select's --el box")
                self.assertEqual(read["fieldBorder"], read["line2"])
                self.assertEqual(read["fieldRadius"], "14px")
                self.assertIn("inset", read["fieldFocus"], "the field has the soft focus: a hairline inside and a halo outside")
                shot(page, f"pickers-date-1440-{'dark' if dark else 'light'}-{UI_BROWSER}")
                page.keyboard.press("Escape")

    def test_12_the_time_list_wears_the_selects_tokens_in_both_themes(self) -> None:
        for dark in (False, True):
            with self.subTest(dark=dark):
                page = self.page(dark=dark)
                start, _ = self.quiet_hours(page)
                shot(page, f"pickers-quiet-hours-1440-{'dark' if dark else 'light'}-{UI_BROWSER}")
                start.press("ArrowDown")
                start.press("ArrowDown")
                page.wait_for_function(SETTLED)
                read = page.evaluate("""() => {
                    const probe = (prop, token) => { const el = document.createElement('i'); el.style[prop] = `var(${token})`; document.body.append(el); const v = getComputedStyle(el)[prop]; el.remove(); return v; };
                    const pop = document.querySelector('.ui-select__pop');
                    const option = pop.querySelector('[role="option"]:not([data-active])');
                    const active = pop.querySelector('[data-active]');
                    return { popBg: getComputedStyle(pop).backgroundColor, el: probe('backgroundColor', '--el'), optColor: getComputedStyle(option).color, t1: probe('color', '--t1'),
                             activeBg: getComputedStyle(active).backgroundColor, sub: probe('backgroundColor', '--sub') };
                }""")
                self.assertEqual(read["popBg"], read["el"])
                self.assertEqual(read["optColor"], read["t1"])
                self.assertEqual(read["activeBg"], read["sub"], "the time under the arrows is the --sub fill")
                shot(page, f"pickers-time-1440-{'dark' if dark else 'light'}-{UI_BROWSER}")
                page.keyboard.press("Escape")

    # ------------------------------------------------------------------------------------------------ phone

    def test_13_on_a_phone_the_time_list_is_the_selects_bottom_sheet_and_a_tap_chooses(self) -> None:
        for dark in (False, True):
            with self.subTest(dark=dark):
                page = self.page(phone=True, dark=dark)
                start, end = self.quiet_hours(page, tap=True)
                self.assertLessEqual(page.evaluate("document.scrollingElement.scrollWidth"), PHONE["width"], "the fields fit the phone")
                field = start.locator("xpath=ancestor::span[contains(@class,'ui-pick')]")
                self.assertGreaterEqual(field.bounding_box()["height"], 44 - 0.5, "the field is a touch target")
                chevron = page.get_by_role("button", name="Choose a time").first
                self.assertGreaterEqual(chevron.bounding_box()["width"], 44 - 0.5, "so is its chevron")
                shot(page, f"pickers-quiet-hours-390-{'dark' if dark else 'light'}-{UI_BROWSER}")
                chevron.tap()
                sheet = page.locator(".ui-select-sheet")
                expect(sheet).to_be_visible()
                box = sheet.get_by_role("listbox")
                expect(box).to_be_focused()
                expect(sheet.locator(".ui-select-sheet__title")).to_have_text("From")
                expect(page.locator(".ui-select__pop")).to_have_count(0)
                option = box.get_by_role("option", name="10:00", exact=True)
                self.assertGreaterEqual(option.bounding_box()["height"], 44 - 0.5, "the times are touch targets")
                page.wait_for_function(SETTLED)
                shot(page, f"pickers-time-390-{'dark' if dark else 'light'}-{UI_BROWSER}")
                option.tap()
                expect(sheet).to_have_count(0)
                expect(start).to_have_value("10:00")
                self.assertEqual(self.prefs(lambda prefs: prefs["quietHours"]["start"] == "10:00")["quietHours"]["start"], "10:00")
                # The field takes typing on a phone as well; the sheet is for choosing.
                end.fill("6")
                end.press("Enter")
                expect(end).to_have_value("6:00")
                self.axe(page, "the phone's time sheet", ".nset__times")
                chevron.tap()
                self.axe(page, "the phone's time sheet", ".ui-select-sheet")
                page.keyboard.press("Escape")
                expect(sheet).to_have_count(0)

    def test_14_on_a_phone_the_month_is_a_sheet_that_opens_with_the_due_date_and_a_tap_chooses(self) -> None:
        task = self.new_task("Fix the hose")
        for dark in (False, True):
            with self.subTest(dark=dark):
                page = self.page(phone=True, dark=dark)
                panel = self.open_task(page, task, phone=True)
                panel.get_by_role("button", name=re.compile(r"^Due")).tap()
                sheet = page.locator(".ui-select-sheet")
                expect(sheet).to_be_visible()
                dialog = page.get_by_role("dialog", name="Due date")
                expect(dialog).to_be_visible()
                expect(sheet.locator(".ui-select-sheet__title")).to_have_text("Due date")
                self.assertLessEqual(page.evaluate("document.scrollingElement.scrollWidth"), PHONE["width"])
                today = self.day(sheet, self.today(page))
                expect(today).to_be_focused()
                for control in (today, sheet.get_by_role("button", name="Today", exact=True), sheet.get_by_role("button", name="Previous month"), sheet.get_by_role("button", name="Tomorrow", exact=True)):
                    box = control.bounding_box()
                    self.assertGreaterEqual(box["height"], 44 - 0.5, "targets are 44 px")
                    self.assertGreaterEqual(box["width"], 44 - 0.5)
                layer = sheet.bounding_box()
                self.assertLessEqual(layer["x"] + layer["width"], PHONE["width"] + 0.5, "the sheet fits the width")
                self.assertGreater(layer["y"], 40, "the sheet leaves the top of the screen")
                page.wait_for_function(SETTLED)
                shot(page, f"pickers-date-390-{'dark' if dark else 'light'}-{UI_BROWSER}")
                self.axe(page, "the phone's month sheet", ".ui-select-sheet")
                sheet.get_by_role("button", name="Tomorrow", exact=True).tap()
                expect(page.locator(".ui-select-sheet")).to_have_count(0)
                expect(panel.get_by_role("button", name=re.compile(r"^Due "))).to_be_visible()
                self.assertEqual(self.due(task, self.today(page, 1)), self.today(page, 1))
                # A day by touch; Clear by touch.
                panel.get_by_role("button", name=re.compile(r"^Due ")).tap()
                expect(self.day(page.locator(".ui-select-sheet"), self.today(page, 1))).to_have_attribute("data-selected", "")
                page.locator(".ui-select-sheet").get_by_role("button", name="Next month").tap()
                target = page.locator('.ui-select-sheet button[data-day$="-20"]:not([data-outside])')
                iso = target.get_attribute("data-day")
                target.tap()
                self.assertEqual(self.due(task, iso), iso)
                panel.get_by_role("button", name=re.compile(r"^Due ")).tap()
                page.locator(".ui-select-sheet").get_by_role("button", name="Clear", exact=True).tap()
                expect(panel.get_by_role("button", name="Due, add a date")).to_be_visible()
                self.assertIsNone(self.due(task, None))
                # The scrim and Esc leave it unchanged.
                panel.get_by_role("button", name="Due, add a date").tap()
                expect(page.locator(".ui-select-sheet")).to_be_visible()
                page.keyboard.press("Escape")
                expect(page.locator(".ui-select-sheet")).to_have_count(0)
                expect(panel.get_by_role("button", name="Due, add a date")).to_be_visible()


if __name__ == "__main__":
    unittest.main()
