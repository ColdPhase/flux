"""Spokój layout and controls (#505, #506, #507; docs/design/spokoj "Layout per screen" and rule 7).

Computer: one header row above the conversation and the one panel; the panel is 420 px at 1440 and 480 px
from 1920; the conversation is at most 760 px; when the views leave too little room the people and Together move
into More. A tablet folds the sidebar to its rail, makes the project title the view menu and overlays the panel.
Controls keep their place: the rail order, the header's right-hand set in every project view, the Tasks toolbar in
both views. Phone: Back · title (the view menu) · Together · Search in every project view and a direct message,
56 px tall, with the same title width.

Runs with the other tests/ui journeys through scripts/check_ui.sh against the running Compose app.
"""

from __future__ import annotations

import json
import os
import re
import unittest
import uuid

from playwright.sync_api import Page, expect, sync_playwright

from test_app_shell import ORIGIN, UPSTREAM, shot, start_forwarder

PASSWORD = "a calm one row header"
UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
if UI_BROWSER not in ("chromium", "webkit"):
    raise ValueError(f"FLUX_UI_BROWSER must be chromium or webkit, got {UI_BROWSER!r}")

COMPUTER = {"width": 1440, "height": 900}
LAPTOP = {"width": 1280, "height": 800}
NARROW = {"width": 1000, "height": 800}
LARGE = {"width": 1920, "height": 1080}
WIDE = {"width": 2560, "height": 1440}
TABLET = {"width": 820, "height": 1180}
PHONES = ({"width": 390, "height": 844}, {"width": 375, "height": 667})
VIEWS = ("", "/map", "/tasks", "/docs", "/agents")
VIEW_NAMES = ("Conversation", "Map", "Tasks", "Wiki", "Agents")
PEOPLE = re.compile("who can see this project$")
SETTLED = "() => document.getAnimations().every((a) => a.playState !== 'running')"


class SpokojLayout(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=8000)
        cls.kai_email = f"kai-spokoj-{uuid.uuid4()}@example.test"
        kai = cls.browser.new_context(base_url=ORIGIN)
        response = kai.request.post("/api/auth/sign-up/email", data={"email": cls.kai_email, "password": PASSWORD, "name": "Kai Spokoj"}, headers={"origin": ORIGIN})
        assert response.status == 200, response.text()
        cls.kai_id = kai.request.get("/api/v1/me").json()["user"]["id"]
        kai.close()
        context = cls.browser.new_context(base_url=ORIGIN)
        page = context.new_page()
        page.goto("/sign-up")
        page.get_by_label("Name").fill("Ada Spokoj")
        page.get_by_label("Email").fill(f"ada-spokoj-{uuid.uuid4()}@example.test")
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        cls.state = context.storage_state()
        workspace = cls.call(page, "POST", "/api/v1/workspaces", {"name": "Riverside Makers"}, 201)
        cls.call(page, "POST", f"/api/v1/workspaces/{workspace['id']}/members", {"email": cls.kai_email, "role": "member"}, 201)
        project = cls.call(page, "POST", f"/api/v1/workspaces/{workspace['id']}/projects",
                           {"name": "Community garden sensors", "visibility": "restricted"}, 201)
        cls.project_id = project["id"]
        # Wiki and Agents appear in the header once a project has them (#351): add them as More does.
        for view in ("docs", "agents"):
            response = page.request.fetch(f"{ORIGIN}/api/v1/projects/{cls.project_id}/views", method="POST",
                                          headers={"origin": ORIGIN, "content-type": "application/json", "idempotency-key": str(uuid.uuid4())},
                                          data=json.dumps({"view": view}))
            assert response.status == 200, response.text()
        for title, status in (("Order six capacitive probes", "in_progress"), ("Ask the school for two ESP32 kits", "open"), ("Calibrate the rain gauge", "blocked")):
            cls.call(page, "POST", f"/api/v1/projects/{cls.project_id}/work", {"title": title, "status": status}, 201)
        # A conversation and a Wiki page: Together has something to anchor to there and is dimmed in the other views.
        cls.call(page, "POST", f"/api/v1/projects/{cls.project_id}/conversations",
                 {"body": "Where should the first probes go: the raised beds or the greenhouse?", "clientMessageId": str(uuid.uuid4())}, 201)
        response = page.request.fetch(f"{ORIGIN}/api/v1/projects/{cls.project_id}/docs", method="POST",
                                      headers={"origin": ORIGIN, "content-type": "application/json", "idempotency-key": str(uuid.uuid4())},
                                      data=json.dumps({"title": "Hardware", "body": "Six capacitive probes and two ESP32 boards.", "state": "published"}))
        assert response.status == 201, response.text()
        cls.doc_id = response.json()["id"]
        page.goto(f"/dm/new?workspace={workspace['id']}&with={cls.kai_id}")
        expect(page).to_have_url(re.compile(r"/dm/[0-9a-f-]{36}$"))
        cls.dm_path = page.url.removeprefix(ORIGIN)
        # Messages, so the direct message offers "Choose messages".
        cls.call(page, "POST", f"/api/v1/dms/{cls.dm_path.split('/')[-1]}/messages",
                 {"body": "Can you bring the soldering iron on Saturday?", "clientMessageId": str(uuid.uuid4())}, 201)
        context.close()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    @staticmethod
    def call(page: Page, method: str, path: str, body: dict | None = None, status: int = 200):
        response = page.request.fetch(ORIGIN + path, method=method,
                                      headers={"origin": ORIGIN, "content-type": "application/json"},
                                      data=json.dumps(body) if body is not None else None)
        if response.status != status:
            raise AssertionError(f"{method} {path}: {response.status}, expected {status}: {response.text()}")
        return response.json() if response.text() else None

    def page(self, size: dict, dark: bool = False, touch: bool = False) -> Page:
        options: dict = {"base_url": ORIGIN, "viewport": size, "storage_state": self.state,
                         "color_scheme": "dark" if dark else "light", "service_workers": "block"}
        if touch:
            options.update(has_touch=True, is_mobile=UI_BROWSER == "chromium")
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        return context.new_page()

    def box(self, locator) -> dict:
        expect(locator).to_be_visible()
        value = locator.bounding_box()
        self.assertIsNotNone(value, f"{locator} has a box")
        return value

    def assert_same_place(self, before: dict, after: dict, label: str) -> None:
        for name, box in before.items():
            self.assertIn(name, after, label)
            for key in ("x", "y"):
                self.assertAlmostEqual(box[key], after[name][key], delta=1, msg=f"{label}: {name} moved on {key}")

    def goto_view(self, page: Page, path: str) -> None:
        page.goto(f"/projects/{self.project_id}{path}")
        expect(page).to_have_url(re.compile(re.escape(f"/projects/{self.project_id}{path}") + r"(\?|$|/)"))
        page.wait_for_function(SETTLED)

    def header_boxes(self, page: Page, views: bool = True) -> dict:
        """The computer header's controls by accessible name: the views, then people · Together · More."""
        header = page.locator("header.top")
        boxes = {
            "people": self.box(header.get_by_role("button", name=PEOPLE)),
            "Together": self.box(header.get_by_role("button", name="Together", exact=True)),
            "More": self.box(header.get_by_role("button", name="More", exact=True)),
        }
        if views:
            for name in VIEW_NAMES:
                # A view with a count has it in its name ("Tasks, 3 open").
                boxes[name] = self.box(header.get_by_role("navigation", name="Project views").get_by_role("link", name=re.compile(f"^{name}")))
        return boxes

    def open_panel(self, page: Page) -> None:
        page.locator("header.top").get_by_role("button", name="More", exact=True).click()
        page.get_by_role("menu", name="More").get_by_role("menuitem", name="Project details").click()
        expect(page.locator(".ui-panel--docked")).to_be_visible()
        # The panel slides in from 24 px to the right; measure it once the animation has landed.
        page.wait_for_function(SETTLED)

    def close_panel(self, page: Page) -> None:
        page.locator(".ui-panel--docked").get_by_role("button", name=re.compile("^Close")).click()
        expect(page.locator(".ui-panel--docked")).to_have_count(0)

    def assert_one_row(self, page: Page, label: str) -> None:
        header = page.locator("header.top")
        self.assertLessEqual(self.box(header)["height"], 72, f"{label}: one row, not two")
        title = self.box(header.get_by_role("heading", level=1))
        for control in [header.get_by_role("navigation", name="Project views"), header.get_by_role("button", name="More", exact=True)]:
            other = self.box(control)
            self.assertLess(abs((title["y"] + title["height"] / 2) - (other["y"] + other["height"] / 2)), 4, f"{label}: the name, the views and More share the row")
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), page.viewport_size["width"], f"{label}: no sideways scroll")

    # ------------------------------------------------------------------ 505 AC-1, AC-3, AC-6

    def test_01_one_header_row_and_its_controls_stay_with_the_panel_open_or_closed(self) -> None:
        for size in (COMPUTER, LAPTOP):
            with self.subTest(width=size["width"]):
                page = self.page(size)
                self.goto_view(page, "")
                self.assert_one_row(page, f"{size['width']} closed")
                closed = self.header_boxes(page)
                # The people, Together and More follow the views in that order (#506 AC-2).
                self.assertLess(closed["people"]["x"], closed["Together"]["x"])
                self.assertLess(closed["Together"]["x"], closed["More"]["x"])
                self.open_panel(page)
                self.assert_one_row(page, f"{size['width']} panel open")
                self.assert_same_place(closed, self.header_boxes(page), f"{size['width']} panel opened")
                # The header spans the conversation and the panel: one row above both (layout per screen).
                head = self.box(page.locator("header.top"))
                panel = self.box(page.locator(".ui-panel--docked"))
                self.assertLessEqual(head["x"], panel["x"] + 1)
                self.assertGreaterEqual(head["x"] + head["width"], panel["x"] + panel["width"] - 1)
                self.assertGreaterEqual(panel["y"], head["y"] + head["height"] - 1, "the panel opens under the header")
                # Moving between the views with the panel open moves nothing in the header.
                for path, name in zip(VIEWS[1:], VIEW_NAMES[1:]):
                    page.get_by_role("navigation", name="Project views").get_by_role("link", name=re.compile(f"^{name}")).click()
                    expect(page).to_have_url(re.compile(re.escape(f"/projects/{self.project_id}{path}") + r"(\?|$|/)"))
                    page.wait_for_function(SETTLED)
                    self.assert_same_place(closed, self.header_boxes(page), f"{size['width']} view {name}")
                self.close_panel(page)
                self.assert_same_place(closed, self.header_boxes(page), f"{size['width']} panel closed again")
                if size is COMPUTER:
                    shot(page, "505-header-1440-panel-closed")

    def test_02_a_narrow_header_moves_the_people_and_together_into_more_and_keeps_the_views(self) -> None:
        for size in (NARROW, {"width": 901, "height": 800}):
            with self.subTest(width=size["width"]):
                page = self.page(size)
                self.goto_view(page, "")
                header = page.locator("header.top")
                self.assert_one_row(page, f"{size['width']}")
                expect(header.get_by_role("button", name=PEOPLE)).to_be_hidden()
                expect(header.get_by_role("button", name="Together", exact=True)).to_be_hidden()
                views = self.header_boxes_views_only(page)
                header.get_by_role("button", name="More", exact=True).click()
                menu = page.get_by_role("menu", name="More")
                items = [text.split("\n")[0].strip() for text in menu.locator("[role^=menuitem]:visible").all_inner_texts()]
                self.assertEqual(items[:3], ["Who can see this", "Together", "Project details"], items)
                # Live sessions are off on this test server: Together is dimmed in place, not removed.
                expect(menu.get_by_role("menuitem", name="Together")).to_have_attribute("aria-disabled", "true")
                menu.get_by_role("menuitem", name="Project details").click()
                expect(page.locator("#details")).to_be_visible()
                page.wait_for_function(SETTLED)
                self.assert_one_row(page, f"{size['width']} panel open")
                self.assert_same_place(views, self.header_boxes_views_only(page), f"{size['width']} panel opened")
                if size is NARROW:
                    shot(page, "505-header-1000-panel-open")

    def header_boxes_views_only(self, page: Page) -> dict:
        header = page.locator("header.top")
        boxes = {"More": self.box(header.get_by_role("button", name="More", exact=True))}
        for name in VIEW_NAMES:
            boxes[name] = self.box(header.get_by_role("navigation", name="Project views").get_by_role("link", name=re.compile(f"^{name}")))
        return boxes

    def test_03_the_panel_is_420_at_1440_and_480_from_1920_and_the_conversation_is_at_most_760(self) -> None:
        page = self.page(COMPUTER)
        self.goto_view(page, "")
        self.open_panel(page)
        side = self.box(page.locator(".app__side"))
        panel = self.box(page.locator(".ui-panel--docked"))
        self.assertAlmostEqual(side["width"], 248, delta=1)
        self.assertAlmostEqual(panel["width"], 420, delta=1)
        self.assertGreater(self.box(page.locator(".app__pane"))["width"], 600, "the conversation fills the rest")
        for size in (LARGE, WIDE):
            with self.subTest(width=size["width"]):
                page = self.page(size, dark=size is WIDE)
                self.goto_view(page, "")
                self.open_panel(page)
                self.assertAlmostEqual(self.box(page.locator(".ui-panel--docked"))["width"], 480, delta=1)
                self.assertLessEqual(self.box(page.locator(".project-convo__in"))["width"], 760.5, "the conversation is at most 760 px")
                # Exactly two content columns: the conversation pane and the panel.
                self.assertEqual(page.locator(".app__body > *").count(), 2)
                shot(page, f"505-layout-{size['width']}-panel-open")

    def test_04_the_closing_panel_fades_out_inside_its_column(self) -> None:
        page = self.page(COMPUTER)
        self.goto_view(page, "")
        self.open_panel(page)
        head = self.box(page.locator("header.top"))
        body = self.box(page.locator(".app__body"))
        leaving = page.evaluate("""async () => {
          document.querySelector('.ui-panel--docked .ui-panel__close').click();
          await new Promise((done) => requestAnimationFrame(done));
          const panel = document.querySelector('.ui-panel--docked.is-leaving');
          if (!panel) return null;
          const box = panel.getBoundingClientRect();
          return {x: box.x, y: box.y, right: box.right, bottom: box.bottom, running: panel.getAnimations().length};
        }""")
        self.assertIsNotNone(leaving, "the panel leaves with its fade")
        self.assertGreaterEqual(leaving["y"], head["y"] + head["height"] - 1, "it stays under the header")
        self.assertAlmostEqual(leaving["right"], body["x"] + body["width"], delta=17, msg="it stays at the right of its row")
        self.assertLessEqual(leaving["bottom"], body["y"] + body["height"] + 1)
        expect(page.locator(".ui-panel--docked")).to_have_count(0)

    # ------------------------------------------------------------------ 505 AC-2, AC-5

    def test_05_tablet_has_the_rail_the_title_as_view_menu_and_the_panel_over_the_conversation(self) -> None:
        page = self.page(TABLET)
        self.goto_view(page, "")
        expect(page.locator(".side--rail")).to_have_count(1)
        self.assertAlmostEqual(self.box(page.locator(".app__side"))["width"], 64, delta=1)
        header = page.locator("header.top")
        self.assertLessEqual(self.box(header)["height"], 72)
        # The project title is the view menu (the phone's pattern); the people, Together and More keep the row.
        expect(header.get_by_role("navigation", name="Project views")).to_have_count(0)
        boxes = self.header_boxes(page, views=False)
        title = header.get_by_role("heading", level=1).get_by_role("button", name="Community garden sensors")
        boxes["title"] = self.box(title)
        title.click()
        menu = page.get_by_role("dialog").filter(has=page.locator(".phone-menu__list"))
        expect(menu.get_by_role("link", name="Conversation")).to_have_attribute("aria-current", "page")
        menu.get_by_role("link", name=re.compile("^Tasks")).click()
        expect(page).to_have_url(re.compile(r"/tasks"))
        page.wait_for_function(SETTLED)
        expect(header.locator(".phead__sub")).to_have_text("Tasks")
        self.assert_same_place(boxes, {**self.header_boxes(page, views=False), "title": self.box(title)}, "820 Conversation to Tasks")
        # The panel (380 px) slides over the conversation, which stays visible beside it.
        header.get_by_role("button", name="More", exact=True).click()
        page.get_by_role("menu", name="More").get_by_role("menuitem", name="Project details").click()
        expect(page.locator(".ui-panel--overlay")).to_be_visible()
        page.wait_for_function(SETTLED)
        panel = self.box(page.locator(".ui-panel--overlay"))
        self.assertAlmostEqual(panel["width"], 380, delta=1)
        self.assertGreater(panel["x"], 300, "the conversation stays visible to the left of the panel")
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), TABLET["width"], "no sideways page scroll")
        shot(page, "505-tablet-820-panel")
        # The rail's expand control opens the sidebar as a drawer.
        page.keyboard.press("Escape")
        page.locator(".side--rail").get_by_role("button", name="Expand sidebar").click()
        expect(page.locator("#nav-drawer")).to_be_visible()

    def test_06_no_control_outside_the_viewport_at_820(self) -> None:
        page = self.page(TABLET)
        for path in ("/inbox", f"/projects/{self.project_id}", self.dm_path):
            page.goto(path)
            expect(page.locator("header.top h1")).to_be_visible()
            self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), TABLET["width"], path)
            # One snapshot of every visible control's right edge: no per-button waits that race a closing menu.
            rights = page.locator("header.top button:visible").evaluate_all("els => els.map((el) => el.getBoundingClientRect().right)")
            self.assertTrue(rights, f"{path}: the header has controls")
            for right in rights:
                self.assertLessEqual(right, TABLET["width"] + 0.5, f"{path}: every header control is inside the viewport")

    # ------------------------------------------------------------------ 506 AC-1, AC-6

    def test_07_the_rail_lists_the_sidebar_order_and_the_toggle_stays_in_the_top_row(self) -> None:
        page = self.page(COMPUTER)
        page.goto(f"/projects/{self.project_id}")
        collapse = self.box(page.get_by_role("button", name="Collapse sidebar"))
        page.locator("body").press("[")
        rail = page.locator(".side--rail")
        expect(rail).to_be_visible()
        names = rail.locator("a, button").evaluate_all("els => els.map(el => el.getAttribute('aria-label') || el.getAttribute('title'))")
        order = ["Expand sidebar", "New", "Search", "Home", "Inbox", "Sketchbook", "Community garden sensors", "Messages", "Kai Spokoj", "Ada Spokoj", "Settings"]
        positions = [next((index for index, name in enumerate(names) if name and name.startswith(item)), -1) for item in order]
        self.assertTrue(all(position >= 0 for position in positions), names)
        self.assertEqual(positions, sorted(positions), f"the sidebar's order, the account and its settings last: {names}")
        expand = self.box(rail.get_by_role("button", name="Expand sidebar"))
        self.assertAlmostEqual(expand["y"], collapse["y"], delta=1, msg="the toggle stays in the top row")
        page.locator("body").press("[")
        expect(page.locator(".side--rail")).to_have_count(0)
        self.assert_same_place({"toggle": collapse}, {"toggle": self.box(page.get_by_role("button", name="Collapse sidebar"))}, "1440 expanded again")
        # A tablet: the rail's toggle opens the sidebar as a drawer whose close control is in the same top row.
        page = self.page(TABLET)
        page.goto(f"/projects/{self.project_id}")
        expand = self.box(page.locator(".side--rail").get_by_role("button", name="Expand sidebar"))
        page.locator(".side--rail").get_by_role("button", name="Expand sidebar").click()
        drawer = page.locator("#nav-drawer")
        expect(drawer).to_be_visible()
        page.wait_for_function(SETTLED)
        self.assertAlmostEqual(self.box(drawer.get_by_role("button", name="Close navigation"))["y"], expand["y"], delta=4, msg="820: the drawer's toggle is in the same top row")

    # ------------------------------------------------------------------ 506 AC-2, AC-6

    def test_08_the_header_controls_do_not_move_between_project_views(self) -> None:
        for size in (COMPUTER, TABLET):
            with self.subTest(width=size["width"]):
                page = self.page(size)
                first = None
                for path in VIEWS:
                    self.goto_view(page, path)
                    header = page.locator("header.top")
                    boxes = self.header_boxes(page, views=size is COMPUTER)
                    if size is TABLET:
                        boxes["title"] = self.box(header.get_by_role("heading", level=1).get_by_role("button"))
                    # Together is in every view; where nothing is open to work on together it is dimmed, not removed.
                    if path in ("/map", "/tasks", "/agents"):
                        expect(header.get_by_role("button", name="Together", exact=True)).to_have_attribute("aria-disabled", "true")
                    if first is None:
                        first = boxes
                    else:
                        self.assert_same_place(first, boxes, f"{size['width']} view {path}")
                shot(page, f"506-header-{size['width']}-agents")

    # ------------------------------------------------------------------ 506 AC-3, AC-4, AC-5, AC-6

    def test_09_the_tasks_toolbar_keeps_its_controls_when_the_view_changes(self) -> None:
        for size in (COMPUTER, TABLET):
            with self.subTest(width=size["width"]):
                page = self.page(size)
                page.goto(f"/projects/{self.project_id}/tasks?view=board")
                toolbar = page.locator(".tb-bar")
                names = {"Board": toolbar.get_by_role("radio", name="Board"), "List": toolbar.get_by_role("radio", name="List"),
                         "Mine": toolbar.get_by_role("button", name="Mine", exact=True), "Search": toolbar.get_by_label("Search tasks"),
                         # The primary action: the header row's right where a panel docks (#763 C4), the toolbar's end on a tablet.
                         "New": page.get_by_role("button", name="New Task", exact=True)}
                controls = lambda: {name: self.box(locator) for name, locator in names.items()}  # noqa: E731
                board = controls()
                # [Board | List] [Mine] [Search tasks] … [+ Task], in reading and focus order.
                self.assertLess(board["Board"]["x"], board["List"]["x"])
                self.assertLess(board["List"]["x"], board["Mine"]["x"])
                self.assertLess(board["Mine"]["x"], board["Search"]["x"])
                self.assertGreater(board["New"]["x"], board["Search"]["x"] + board["Search"]["width"] + 40, "+ Task at the far end")
                order = toolbar.locator("[role=radio][aria-checked=true], button.tb-mine, input").evaluate_all("els => els.map(el => el.textContent.trim() || el.getAttribute('placeholder'))")
                self.assertEqual(order, ["Board", "Mine", "Search tasks"])
                names["List"].click()
                expect(names["List"]).to_have_attribute("aria-checked", "true")
                self.assert_same_place(board, controls(), f"{size['width']} board to list")
                # The List's search is dimmed in place (it reads server pages), so nothing beside it moves.
                expect(names["Search"]).to_be_disabled()
                # Mine works from the same place; the list has no second checkbox row and no second way to add.
                names["Mine"].click()
                expect(names["Mine"]).to_have_attribute("aria-pressed", "true")
                expect(page.get_by_label("Only mine")).to_have_count(0)
                expect(page.get_by_role("textbox", name=re.compile("Add a task", re.I))).to_have_count(0)
                self.assert_same_place(board, controls(), f"{size['width']} list with Mine")
                # One page of tasks has no Previous and Next (Spokój rule 4); Refresh stays.
                names["Mine"].click()
                pages = page.get_by_role("navigation", name="Work pages")
                expect(pages).to_contain_text("1–3 of 3 tasks")
                expect(pages.get_by_role("button", name="Previous", exact=True)).to_have_count(0)
                expect(pages.get_by_role("button", name="Next", exact=True)).to_have_count(0)
                expect(pages.get_by_role("button", name="Refresh", exact=True)).to_be_visible()
                if size is COMPUTER:
                    shot(page, "506-tasks-list-1440")
                names["Board"].click()
                expect(names["Board"]).to_have_attribute("aria-checked", "true")
                self.assert_same_place(board, controls(), f"{size['width']} back to the board")
                if size is COMPUTER:
                    shot(page, "506-tasks-board-1440")
                    # Opening a task docks the panel and narrows the board; "+ Task" keeps its place (#763 C4, rule 7).
                    page.locator(".tb-card .tb-card__open").first.click()
                    expect(page.locator(".ui-panel--docked")).to_be_visible()
                    page.wait_for_function(SETTLED)
                    self.assert_same_place({"New": board["New"]}, {"New": self.box(names["New"])}, "+ Task with a task open")

    def test_10_labels_have_one_meaning(self) -> None:
        page = self.page(COMPUTER)
        page.goto(f"/projects/{self.project_id}")
        page.locator("header.top").get_by_role("button", name="More", exact=True).click()
        menu = page.get_by_role("menu", name="More")
        expect(menu.get_by_role("menuitem", name="Project details")).to_be_visible()
        expect(menu.get_by_role("menuitem", name="Details", exact=True)).to_have_count(0)
        page.keyboard.press("Escape")
        page.goto(self.dm_path)
        expect(page.locator("header.top").get_by_role("button", name="Choose messages", exact=True)).to_be_visible()
        expect(page.get_by_role("button", name="Select", exact=True)).to_have_count(0)
        page.locator("header.top").get_by_role("button", name="More", exact=True).click()
        expect(page.get_by_role("menu", name="More").get_by_role("menuitem", name="Message info")).to_be_visible()

    # ------------------------------------------------------------------ 507 AC-1 to AC-5

    def test_11_the_phone_header_is_one_56px_row_with_the_same_controls_in_every_view(self) -> None:
        for size in PHONES:
            with self.subTest(width=size["width"]):
                page = self.page(size, dark=size is PHONES[1], touch=True)
                reference = None
                # The Wiki's page, and its edit and history states (#507: the header is the same in all of them).
                wiki_states = (f"/projects/{self.project_id}/docs/{self.doc_id}/edit", f"/projects/{self.project_id}/docs/{self.doc_id}/history")
                for path in (*(f"/projects/{self.project_id}{view}" for view in VIEWS), *wiki_states, self.dm_path):
                    page.goto(path)
                    header = page.locator("header.phead")
                    expect(header.get_by_role("button", name="Search", exact=True)).to_be_visible()
                    page.wait_for_function(SETTLED)
                    head = self.box(header)
                    self.assertAlmostEqual(head["height"], 56, delta=1, msg=path)
                    # Back · title with the view menu · Together · Search, and nothing else.
                    controls = {
                        "Back": self.box(header.get_by_role("button", name="Back", exact=True)),
                        "title": self.box(header.get_by_role("heading", level=1).get_by_role("button")),
                        "Search": self.box(header.get_by_role("button", name="Search", exact=True)),
                    }
                    # Together keeps its place in the Wiki too (#507 gap 3 of the #500 audit): a Wiki page's own "More" is in
                    # the page's strip below the header, not in it.
                    controls["Together"] = self.box(header.get_by_role("button", name="Together", exact=True))
                    self.assertEqual(header.locator("button:visible").count(), 4, f"{path}: {header.locator('button:visible').all_inner_texts()}")
                    if path.endswith("/docs"):
                        expect(header.get_by_role("button", name="More", exact=True)).to_have_count(0)
                        menu = page.locator(".wiki-top__menu").get_by_role("button", name="More", exact=True)
                        expect(menu).to_be_visible()
                        menu_box, strip = self.box(menu), self.box(page.locator(".wiki-top"))
                        self.assertGreaterEqual(min(menu_box["width"], menu_box["height"]), 44, "the page's menu keeps a touch target")
                        self.assertGreaterEqual(menu_box["y"], head["y"] + head["height"] - 0.5, "the page's menu is below the header")
                        self.assertLessEqual(menu_box["y"] + menu_box["height"], strip["y"] + strip["height"] + 0.5, "in the row of page chips")
                        expect(page.get_by_role("navigation", name="Wiki pages").get_by_role("button", name="More", exact=True)).to_have_count(0)
                        self.assertLessEqual(menu_box["x"] + menu_box["width"], size["width"], "inside the screen")
                    for name, box in controls.items():
                        self.assertGreaterEqual(min(box["width"], box["height"]), 44, f"{name} at {path}")
                        self.assertGreaterEqual(box["y"], head["y"] - 0.5, f"{name} stays inside the header at {path}")
                        self.assertLessEqual(box["y"] + box["height"], head["y"] + head["height"] + 0.5, f"{name} stays inside the header at {path}")
                    self.assertLess(controls["Back"]["x"], controls["title"]["x"])
                    self.assertLess(controls["title"]["x"] + controls["title"]["width"], controls["Together"]["x"])
                    self.assertLess(controls["Together"]["x"], controls["Search"]["x"])
                    # The capsule and its round Search stay on Home, Projects and Inbox only.
                    expect(page.locator(".phone-dock__bar, .phone-dock__search")).to_have_count(0)
                    self.assertEqual(page.evaluate("document.documentElement.scrollWidth"), size["width"], path)
                    title = self.box(header.locator(".phead__title"))
                    if reference is None:
                        reference = {**controls, "title width": title}
                        shot(page, f"507-phone-{size['width']}-conversation")
                    else:
                        moving = {key: value for key, value in controls.items() if key != "title"}
                        self.assert_same_place({key: value for key, value in reference.items() if key in moving}, moving, f"{size['width']} {path}")
                        if path != self.dm_path:
                            # The project's title is cut at the same width in every view.
                            self.assertAlmostEqual(title["width"], reference["title width"]["width"], delta=1, msg=f"{size['width']} title width at {path}")
                            self.assertAlmostEqual(controls["title"]["x"], reference["title"]["x"], delta=4, msg=f"{size['width']} title at {path}")
                # The direct message's "Choose messages" waits by its composer.
                expect(page.get_by_role("button", name="Choose messages", exact=True)).to_be_visible()
                shot(page, f"507-phone-{size['width']}-dm")
                # Every top-level header is 56 px with its controls at the same height; the capsule is here.
                avatar = None
                for path in ("/", "/projects", "/inbox"):
                    page.goto(path)
                    header = page.locator("header.phead")
                    self.assertAlmostEqual(self.box(header)["height"], 56, delta=1, msg=path)
                    expect(page.get_by_role("navigation", name="Main places")).to_be_visible()
                    here = self.box(header.get_by_role("link", name="Settings and account"))
                    if avatar is None:
                        avatar = here
                    else:
                        self.assertAlmostEqual(here["y"], avatar["y"], delta=1, msg=path)
                    if reference:
                        self.assertAlmostEqual(here["y"], reference["Search"]["y"], delta=1, msg=f"{path}: the same height as the project header's controls")

    def test_12_the_phone_direct_message_chooses_messages_by_its_composer(self) -> None:
        page = self.page(PHONES[0], touch=True)
        page.goto(self.dm_path)
        choose = page.get_by_role("button", name="Choose messages", exact=True)
        expect(page.locator("header.phead").get_by_role("button", name="Choose messages")).to_have_count(0)
        self.assertGreaterEqual(self.box(choose)["height"], 44)
        choose.click()
        bar = page.get_by_role("region", name="Selected messages")
        expect(bar.get_by_role("status")).to_have_text("Choose the messages to sketch from")
        bar.get_by_role("button", name="Cancel").click()
        expect(bar).to_be_hidden()
        expect(choose).to_be_focused()


if __name__ == "__main__":
    unittest.main()
