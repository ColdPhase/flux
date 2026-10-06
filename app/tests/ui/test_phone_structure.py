"""Browser tests for the phone project structure (issue #318, F-025 PA-9 to PA-11).

Runs with the other tests/ui journeys through scripts/check_ui.sh against the running Compose
application. On a phone a project's views open from its title, so no row of chips stacks under the
header, and Tasks has one row (the status) with search and "+" in the header. Nothing is removed:
every function of the old toolbar and chips is within two taps, and tablet and desktop keep their
tabs and toolbar.
"""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

PASSWORD = "one row is enough on a phone"
STAMP = int(time.time() * 1000)
ADA = {"name": "Ada Lind", "email": f"ada.structure+{STAMP}@example.test"}
SMALL = {"width": 375, "height": 667}
TABLET = {"width": 820, "height": 1180}
PROJECT = "Gesture lamp"

ORDER = "Order two VL53L5CX ToF sensor boards"
CALIBRATE = "Calibrate the ToF sensor against the camera at 5 lux"
PROTOCOL = "Write the low-light test protocol"
PROPOSAL = "Prefer the ToF sensor for the next prototype"
NEW = "Buy a 5 lux test lamp"
VIEWS = ("Conversation", "Map", "Tasks", "Wiki", "Agents")


class PhoneStructureJourney(unittest.TestCase):
    """Tests run in name order and share one account and project."""

    pw = None
    browser: Browser
    state: dict = {}
    ids: dict[str, str] = {}

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

    def context(self, viewport: dict | None = PHONE, *, signed_in: bool = True) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "color_scheme": "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw"}
        if viewport and viewport["width"] <= 640:
            options.update(viewport=viewport, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=viewport or DESKTOP, device_scale_factor=1)
        if signed_in:
            options["storage_state"] = self.state
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        return context

    def page(self, viewport: dict | None = PHONE, **kwargs) -> Page:
        page = self.context(viewport, **kwargs).new_page()
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

    def box(self, locator) -> dict:
        box = locator.bounding_box()
        assert box is not None
        return box

    def views_sheet(self, page: Page):
        page.locator("header.top").get_by_role("button", name=re.compile(f"^{PROJECT}.*views")).click()
        sheet = page.get_by_role("dialog", name="Views")
        expect(sheet).to_be_visible()
        return sheet

    # ---------------------------------------------------------------- a project with work and a proposal

    def test_01_a_project_with_tasks_and_a_proposed_decision(self) -> None:
        page = self.page(DESKTOP, signed_in=False)
        page.goto("/sign-up")
        page.get_by_label("Name").fill(ADA["name"])
        page.get_by_label("Email").fill(ADA["email"])
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        type(self).state = page.context.storage_state()
        me = self.api(page, "GET", "/api/v1/me", status=200)["user"]["id"]
        ws = self.api(page, "POST", "/api/v1/workspaces", {"name": "Riverside Makers"}, status=201)
        project = self.api(page, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": PROJECT, "visibility": "restricted"}, status=201)
        pid = self.ids["project"] = project["id"]
        owner = {"kind": "human", "id": me}
        base = f"/api/v1/projects/{pid}/work"
        self.api(page, "POST", base, {"title": ORDER, "owner": owner}, status=201)
        self.api(page, "POST", base, {"title": CALIBRATE, "status": "in_progress", "owner": owner}, status=201)
        self.api(page, "POST", base, {"title": PROTOCOL, "status": "done"}, status=201)
        self.api(page, "POST", f"/api/v1/projects/{pid}/decisions", {"title": PROPOSAL, "rationale": "It works in the dark and stores no images."}, status=201)
        self.api(page, "POST", f"/api/v1/projects/{pid}/conversations", {"body": "Should the lamp use a ToF sensor instead of the camera?", "clientMessageId": str(uuid.uuid4())}, status=201)

    # ---------------------------------------------------------------- PA-9: the views live in the title

    def test_02_the_views_open_from_the_title_and_no_chips_stack_under_the_header(self) -> None:
        pid = self.ids["project"]
        for viewport in (PHONE, SMALL):
            with self.subTest(width=viewport["width"]):
                page = self.page(viewport)
                page.goto(f"/projects/{pid}")
                header = page.locator("header.top")
                expect(header.get_by_role("heading", level=1)).to_contain_text(PROJECT)
                expect(page.get_by_role("navigation", name="Project views")).to_have_count(0)
                expect(page.locator(".views--project")).to_have_count(0)
                expect(header.locator(".top__view")).to_have_text("Conversation")
                switch = header.get_by_role("button", name=re.compile(f"^{PROJECT}.*views"))
                # The title and the line under it are one tap of at least 44 px (HIG-14, F-025 PA-5).
                reach = switch.evaluate("""(el) => {
                  const box = el.getBoundingClientRect(), x = box.left + 12;
                  let top = box.top + box.height / 2, bottom = top;
                  while (top > 0 && el.contains(document.elementFromPoint(x, top - 1))) top -= 1;
                  while (bottom < innerHeight - 1 && el.contains(document.elementFromPoint(x, bottom + 1))) bottom += 1;
                  return bottom - top + 1;
                }""")
                self.assertGreaterEqual(reach, 44, "the title is a 44 px tap")
                sheet = self.views_sheet(page)
                expect(switch).to_have_attribute("aria-expanded", "true")
                views = sheet.get_by_role("navigation", name="Project views")
                for name in VIEWS:
                    link = views.get_by_role("link", name=re.compile(f"^{name}"))
                    expect(link).to_be_visible()
                    self.assertGreaterEqual(self.box(link)["height"], 44, f"{name} is a 44 px target")
                expect(views.locator('[aria-current="page"]')).to_have_count(1)
                expect(views.get_by_role("link", name=re.compile("^Conversation"))).to_have_attribute("aria-current", "page")
                expect(views.get_by_role("link", name=re.compile("^Tasks"))).to_contain_text("2 open")
                expect(views.get_by_role("link", name=re.compile("^Decisions"))).to_contain_text("1 needs you")
                if viewport is PHONE:
                    shot(page, "318-views-sheet-390")
                # Escape closes it and gives focus back to the title.
                page.keyboard.press("Escape")
                expect(sheet).to_have_count(0)
                expect(switch).to_be_focused()
                # Every view is one choice away; the line under the title names the current one.
                for name, path in (("Map", "/map"), ("Wiki", "/docs"), ("Agents", "/agents"), ("Tasks", "/tasks"), ("Conversation", "")):
                    self.views_sheet(page).get_by_role("link", name=re.compile(f"^{name}")).click()
                    expect(page).to_have_url(re.compile(f"/projects/{pid}{path}(\\?.*)?$"))
                    expect(page.get_by_role("dialog", name="Views")).to_have_count(0)
                    expect(header.locator(".top__view")).to_have_text(name)
                    expect(page.get_by_role("navigation", name="Project views")).to_have_count(0)
                    expect(page.locator(".tb-bar")).to_have_count(0)
                # The places bar stays.
                expect(page.get_by_role("navigation", name="Main places")).to_be_visible()

    # ---------------------------------------------------------------- PA-10: Tasks in one row

    def test_03_tasks_have_one_row_and_plus_adds_a_task_in_place(self) -> None:
        pid = self.ids["project"]
        for viewport in (PHONE, SMALL):
            with self.subTest(width=viewport["width"]):
                page = self.page(viewport)
                page.goto(f"/projects/{pid}/tasks")
                expect(page.locator(".tb-board")).to_be_visible()
                header = page.locator("header.top")
                expect(page.locator(".tb-bar")).to_have_count(0)
                expect(page.get_by_role("radiogroup", name="Show tasks as")).to_have_count(0)
                status = page.get_by_role("navigation", name="Task status")
                expect(status).to_be_visible()
                for name in ("Search tasks", "Add a task"):
                    button = header.get_by_role("button", name=name, exact=True)
                    size = self.box(button)
                    self.assertGreaterEqual(min(size["width"], size["height"]), 44, f"{name} is a 44 px target")
                # One row between the header and the first task: the status.
                card = page.locator(".tb-card").filter(has_text=CALIBRATE)
                expect(card).to_be_visible()
                header_box = self.box(header)
                self.assertLessEqual(self.box(status)["y"] - (header_box["y"] + header_box["height"]), 24, "the status row follows the header")
                # Under it, the tasks; a decision that waits is one quiet row at their top (F-025 PA-10).
                also = page.get_by_role("navigation", name="Also in the List")
                expect(also).to_be_visible()
                self.assertGreater(self.box(also)["y"], self.box(status)["y"], "the quiet row sits under the status, not above it")
                start = self.box(also)["y"] + self.box(also)["height"]
                self.assertLessEqual(self.box(card)["y"] - start, 40, "the tasks follow")
                if viewport is PHONE:
                    shot(page, "318-tasks-390")
                # The status segments filter, one column at a time.
                status.get_by_role("button", name=re.compile("^Done")).click()
                expect(page.locator(".tb-card").filter(has_text=PROTOCOL)).to_be_visible()
                expect(card).to_be_hidden()
                if viewport is not PHONE:
                    continue
                # "+" opens the new-task field in place, in Open, and the task is added without leaving Tasks.
                header.get_by_role("button", name="Add a task", exact=True).click()
                field = page.get_by_label("New task in Open")
                expect(field).to_be_focused()
                expect(status.get_by_role("button", name=re.compile("^Open"))).to_have_attribute("aria-pressed", "true")
                field.fill(NEW)
                field.press("Enter")
                expect(page).to_have_url(re.compile(f"/projects/{pid}/tasks"))
                expect(page.get_by_role("dialog", name="Details")).to_contain_text(NEW)
                page.keyboard.press("Escape")
                expect(page.locator(".tb-card").filter(has_text=NEW)).to_be_visible()
                titles = [item["title"] for item in self.api(page, "GET", f"/api/v1/projects/{pid}/work?limit=50", status=200)["items"]]
                self.assertIn(NEW, titles)

    def test_04_search_and_mine_sit_behind_one_symbol_and_an_active_filter_stays_shown(self) -> None:
        pid = self.ids["project"]
        page = self.page(PHONE)
        page.goto(f"/projects/{pid}/tasks")
        expect(page.locator(".tb-board")).to_be_visible()
        header = page.locator("header.top")
        search = header.get_by_role("button", name="Search tasks", exact=True)
        expect(search).to_have_attribute("aria-expanded", "false")
        search.click()
        find = page.get_by_role("search")
        field = find.get_by_label("Search tasks")
        expect(field).to_be_focused()
        self.assertGreaterEqual(float(field.evaluate("(el) => parseFloat(getComputedStyle(el).fontSize)")), 16, "iOS does not zoom into the field")
        field.fill("calibrate")
        expect(page.locator(".tb-card").filter(has_text=CALIBRATE)).to_be_visible()
        page.get_by_role("navigation", name="Task status").get_by_role("button", name=re.compile("^Open")).click()
        expect(page.locator(".tb-card").filter(has_text=ORDER)).to_be_hidden()
        # Mine filters too; the filter in use keeps its row after the field loses focus.
        mine = find.get_by_role("button", name="Mine")
        mine.click()
        expect(mine).to_have_attribute("aria-pressed", "true")
        page.locator(".tb-board").click(position={"x": 4, "y": 4})
        expect(find).to_be_visible()
        expect(field).to_have_value("calibrate")
        shot(page, "318-tasks-search-390")
        # Cancel clears both and the row goes.
        find.get_by_role("button", name="Cancel").click()
        expect(page.get_by_role("search")).to_have_count(0)
        expect(page.locator(".tb-card").filter(has_text=ORDER)).to_be_visible()
        expect(page).not_to_have_url(re.compile("show=mine"))

    def test_05_a_decision_that_needs_you_is_one_tap_from_the_board(self) -> None:
        pid = self.ids["project"]
        page = self.page(PHONE)
        page.goto(f"/projects/{pid}/tasks")
        also = page.get_by_role("navigation", name="Also in the List")
        also.get_by_role("button", name="1 decision needs you").click()
        expect(page).to_have_url(re.compile("status=needs"))
        row = page.locator(".ws-item").filter(has_text=PROPOSAL)
        expect(row).to_be_visible()
        # The List has one row (its views); "+" opens its new-task field, and the header leads back to the board.
        expect(page.get_by_role("navigation", name="Task views")).to_be_visible()
        expect(page.locator("#ws-add")).to_have_count(0)
        page.locator("header.top").get_by_role("button", name="Add a task", exact=True).click()
        expect(page.locator("#ws-add")).to_be_focused()
        page.locator("header.top").get_by_role("button", name="Show the board").click()
        expect(page.locator(".tb-board")).to_be_visible()
        # The same decisions are in the views sheet.
        self.views_sheet(page).get_by_role("link", name=re.compile("^Decisions")).click()
        expect(page).to_have_url(re.compile("status=needs"))
        expect(row).to_be_visible()

    # ---------------------------------------------------------------- tablet and desktop are unchanged

    def test_06_tablet_and_desktop_keep_their_tabs_and_toolbar(self) -> None:
        pid = self.ids["project"]
        for viewport in (TABLET, DESKTOP):
            with self.subTest(width=viewport["width"]):
                page = self.page(viewport)
                page.goto(f"/projects/{pid}/tasks")
                expect(page.get_by_role("navigation", name="Project views")).to_be_visible()
                expect(page.locator(".tb-bar")).to_be_visible()
                expect(page.get_by_role("radiogroup", name="Show tasks as")).to_be_visible()
                expect(page.locator("header.top .top__switch")).to_have_count(0)
                expect(page.locator("header.top").get_by_role("button", name="Search tasks")).to_have_count(0)


if __name__ == "__main__":
    unittest.main()
