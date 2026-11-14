"""Spokój layout and controls (#505, #506, #507; docs/design/spokoj "Layout per screen" and rule 7).

Computer: one header row above the conversation and the one panel; the panel is 420 px at 1440 and 480 px
from 1920; the conversation is at most 760 px; when the views leave too little room the people and Call move
into More. A tablet folds the sidebar to its rail, keeps the same views in the header and overlays the panel.
Controls keep their place: the rail order, the header's right-hand set in every project view, the Tasks toolbar in
both views. Phone: Back · title · More in every project view, with the views in the row under it (Search and Call are rows of More, #1239), and
Back · title · Call · Search in a direct message, one 56 px row; the title keeps the same width in every view.

Runs with the other tests/ui journeys through scripts/check_ui.sh against the running Compose app.
"""

from __future__ import annotations

import json
import os
import re
import unittest
import uuid

from playwright.sync_api import Page, expect, sync_playwright

from urllib.parse import urlsplit

from phone_audit import TEXT_SIZE_SCRIPT
from test_app_shell import ORIGIN, UPSTREAM, panel_task, shot, start_forwarder

PASSWORD = "a calm one row header"
UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
if UI_BROWSER not in ("chromium", "webkit"):
    raise ValueError(f"FLUX_UI_BROWSER must be chromium or webkit, got {UI_BROWSER!r}")

COMPUTER = {"width": 1440, "height": 900}
LAPTOP = {"width": 1280, "height": 800}
NARROW = {"width": 700, "height": 900}
LARGE = {"width": 1920, "height": 1080}
WIDE = {"width": 2560, "height": 1440}
TABLET = {"width": 820, "height": 1180}
PHONES = ({"width": 390, "height": 844}, {"width": 375, "height": 667})
VIEWS = ("", "/map", "/tasks", "/docs")
VIEW_NAMES = ("Conversation", "Map", "Tasks", "Wiki")
PEOPLE = re.compile("who can see this space$")
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
        kai = cls.browser.new_context(base_url=ORIGIN, service_workers="block")
        response = kai.request.post("/api/auth/sign-up/email", data={"email": cls.kai_email, "password": PASSWORD, "name": "Kai Spokoj"}, headers={"origin": ORIGIN})
        assert response.status == 200, response.text()
        cls.kai_id = kai.request.get("/api/v1/me").json()["user"]["id"]
        kai.close()
        context = cls.browser.new_context(base_url=ORIGIN, service_workers="block")
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
        for title, status in (("Order six capacitive probes", "in_progress"), ("Ask the school for two ESP32 kits", "open"), ("Calibrate the rain gauge", "blocked")):
            cls.call(page, "POST", f"/api/v1/projects/{cls.project_id}/work", {"title": title, "status": status}, 201)
        # A conversation and a Wiki page: Call has something to anchor to there and is dimmed in the other views.
        cls.call(page, "POST", f"/api/v1/projects/{cls.project_id}/conversations",
                 {"body": "Where should the first probes go: the raised beds or the greenhouse?", "clientMessageId": str(uuid.uuid4())}, 201)
        response = page.request.fetch(f"{ORIGIN}/api/v1/projects/{cls.project_id}/docs", method="POST",
                                      headers={"origin": ORIGIN, "content-type": "application/json", "idempotency-key": str(uuid.uuid4())},
                                      data=json.dumps({"title": "Hardware", "body": "Six capacitive probes and two ESP32 boards."}))
        assert response.status == 201, response.text()
        cls.doc_id = response.json()["id"]
        page.goto(f"/dm/new?workspace={workspace['id']}&with={cls.kai_id}")
        expect(page).to_have_url(re.compile(r"/dm/[0-9a-f-]{36}$"))
        cls.dm_path = page.url.removeprefix(ORIGIN)
        # Messages, so the direct message is not empty.
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

    def header_boxes(self, page: Page, views: bool = True, narrow: bool = False, faces: bool = True) -> dict:
        """The header's controls by accessible name: the views, then the people and More. This test server has no media server, so there is no Call (#1424).
        Where the row has no room for them (under 704 px) the people are in More; where the name would be cut under its 220 px slot (under 780 px,
        `faces=False`) the people alone are (#1375)."""
        header = page.locator("header.top")
        boxes = {"More": self.box(header.get_by_role("button", name="More", exact=True))}
        if not narrow and faces:
            boxes["people"] = self.box(header.get_by_role("button", name=PEOPLE))
        if not narrow:
            expect(header.get_by_role("button", name="Call", exact=True)).to_have_count(0)
        if views:
            for name in VIEW_NAMES:
                # A view with a count has it in its name ("Tasks, 3 open").
                boxes[name] = self.box(header.get_by_role("navigation", name="Space views").get_by_role("tab", name=re.compile(f"^{name}")))
        return boxes

    def open_panel(self, page: Page, path: str | None = None) -> None:
        """The one panel, on a task of the space: a space has no panel of its own (#1419), so the panel is a task's, opened from its address,
        over the place the test is at (the Wiki's page, for one, is `/docs/:id`)."""
        here = path if path is not None else urlsplit(page.url).path
        page.goto(f"{here}?open=work:{panel_task(page, self.project_id)}")
        expect(page.locator("#details")).to_be_visible()
        # The panel slides in from 24 px to the right; measure it once the animation has landed.
        page.wait_for_function(SETTLED)

    def close_panel(self, page: Page) -> None:
        page.locator(".ui-panel--docked").get_by_role("button", name=re.compile("^Close")).click()
        expect(page.locator(".ui-panel--docked")).to_have_count(0)

    def assert_one_row(self, page: Page, label: str) -> None:
        header = page.locator("header.top")
        self.assertLessEqual(self.box(header)["height"], 72, f"{label}: one row, not two")
        title = self.box(header.get_by_role("heading", level=1))
        for control in [header.get_by_role("navigation", name="Space views"), header.get_by_role("button", name="More", exact=True)]:
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
                # The people and More follow the views in that order (#506 AC-2); Call is not shown without a media server (#1424).
                self.assertLess(closed["people"]["x"], closed["More"]["x"])
                self.open_panel(page)
                self.assert_one_row(page, f"{size['width']} panel open")
                self.assert_same_place(closed, self.header_boxes(page), f"{size['width']} panel opened")
                # The header spans the conversation and the panel: one row above both (layout per screen).
                head = self.box(page.locator("header.top"))
                panel = self.box(page.locator(".ui-panel--docked"))
                self.assertLessEqual(head["x"], panel["x"] + 1)
                self.assertGreaterEqual(head["x"] + head["width"], panel["x"] + panel["width"] - 1)
                self.assertGreaterEqual(panel["y"], head["y"] + head["height"] - 1, "the panel opens under the header")
                # Moving between the views with the panel open moves nothing in the header. The Wiki is one of them: its panel is the same
                # one beside the page (#1365).
                for path, name in zip(VIEWS[1:], VIEW_NAMES[1:]):
                    page.get_by_role("navigation", name="Space views").get_by_role("tab", name=re.compile(f"^{name}")).click()
                    expect(page).to_have_url(re.compile(re.escape(f"/projects/{self.project_id}{path}") + r"(\?|$|/)"))
                    page.wait_for_function(SETTLED)
                    self.assert_same_place(closed, self.header_boxes(page), f"{size['width']} view {name}")
                self.close_panel(page)
                self.assert_same_place(closed, self.header_boxes(page), f"{size['width']} panel closed again")
                if size is COMPUTER:
                    shot(page, "505-header-1440-panel-closed")
                page.get_by_role("navigation", name="Space views").get_by_role("tab", name=re.compile("^Wiki")).click()
                expect(page).to_have_url(re.compile(re.escape(f"/projects/{self.project_id}/docs") + r"(\?|$|/)"))
                page.wait_for_function(SETTLED)
                self.open_panel(page)
                expect(page.locator(".ui-panel--docked")).to_be_visible()
                expect(page.locator(".ui-panel--overlay")).to_have_count(0)
                self.assert_same_place(closed, self.header_boxes(page), f"{size['width']} Wiki with the panel beside the page")
                page.keyboard.press("Escape")
                expect(page.locator(".ui-panel--docked")).to_have_count(0)

    def test_02_a_narrow_header_moves_the_people_and_together_into_more_and_keeps_the_views(self) -> None:
        for size in (NARROW, {"width": 901, "height": 800}):
            # 700 px: the rail and a 636 px header; 901 px: the full sidebar and a 645 px header. Both are under the 704 px the whole row needs.
            with self.subTest(width=size["width"]):
                page = self.page(size)
                self.goto_view(page, "")
                header = page.locator("header.top")
                self.assert_one_row(page, f"{size['width']}")
                expect(header.get_by_role("button", name=PEOPLE)).to_be_hidden()
                expect(header.get_by_role("button", name="Call", exact=True)).to_have_count(0)
                views = self.header_boxes_views_only(page)
                header.get_by_role("button", name="More", exact=True).click()
                menu = page.get_by_role("menu", name="More")
                items = [text.split("\n")[0].strip() for text in menu.locator("[role^=menuitem]:visible").all_inner_texts()]
                # Mute space (#1249) follows Settings, under its own one-line hint. Live sessions are off on this test server, so there is no Call
                # row, not even a dimmed one (#1419), and a space has no details panel of its own.
                self.assertEqual(items[:3], ["People", "Settings", "Mute space"], items)
                self.assertNotIn("Call", items)
                self.assertNotIn("Space details", items)
                page.keyboard.press("Escape")
                self.open_panel(page)
                self.assert_one_row(page, f"{size['width']} panel open")
                self.assert_same_place(views, self.header_boxes_views_only(page), f"{size['width']} panel opened")
                if size is NARROW:
                    shot(page, "505-header-700-panel-open")

    def header_boxes_views_only(self, page: Page) -> dict:
        header = page.locator("header.top")
        boxes = {"More": self.box(header.get_by_role("button", name="More", exact=True))}
        for name in VIEW_NAMES:
            boxes[name] = self.box(header.get_by_role("navigation", name="Space views").get_by_role("tab", name=re.compile(f"^{name}")))
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
          const panel = document.querySelector('.ui-panel--docked');
          let seen = null;
          // The class comes with the first frame of the exit and the panel may be gone a moment later: watch for it from before the click.
          const note = () => { if (!seen && panel.classList.contains('is-leaving')) { const box = panel.getBoundingClientRect(); seen = {x: box.x, y: box.y, right: box.right, bottom: box.bottom, running: panel.getAnimations().length}; } };
          const observer = new MutationObserver(note);
          observer.observe(panel, {attributes: true, attributeFilter: ['class']});
          document.querySelector('.ui-panel--docked .ui-panel__close').click();
          for (let frame = 0; frame < 8 && !seen; frame++) await new Promise((done) => requestAnimationFrame(done));
          observer.disconnect();
          return seen;
        }""")
        self.assertIsNotNone(leaving, "the panel leaves with its fade")
        self.assertGreaterEqual(leaving["y"], head["y"] + head["height"] - 1, "it stays under the header")
        self.assertAlmostEqual(leaving["right"], body["x"] + body["width"], delta=17, msg="it stays at the right of its row")
        self.assertLessEqual(leaving["bottom"], body["y"] + body["height"] + 1)
        expect(page.locator(".ui-panel--docked")).to_have_count(0)

    # ------------------------------------------------------------------ 505 AC-2, AC-5

    def test_05_tablet_has_the_rail_the_same_views_and_the_panel_over_the_conversation(self) -> None:
        page = self.page(TABLET)
        self.goto_view(page, "")
        expect(page.locator(".side--rail")).to_have_count(1)
        self.assertAlmostEqual(self.box(page.locator(".app__side"))["width"], 64, delta=1)
        header = page.locator("header.top")
        self.assertLessEqual(self.box(header)["height"], 72)
        # The views are the same tabs as the computer's (#873). The header is 748 px wide at 820, under the 780 px where the name keeps its
        # 220 px slot with the people in the row, so the people are in More and the name has its slot (#1375). This test server has no media
        # server, so there is no Call, in the row or in More (#1424).
        views = header.get_by_role("navigation", name="Space views")
        expect(views).to_be_visible()
        expect(header.get_by_role("heading", level=1).get_by_role("button")).to_have_count(0)
        expect(header.get_by_role("button", name=PEOPLE)).to_be_hidden()
        expect(header.get_by_role("button", name="Call", exact=True)).to_have_count(0)
        boxes = self.header_boxes(page, views=True, faces=False)
        self.assertAlmostEqual(self.box(header.locator(".top__title"))["width"], 220, delta=1, msg="the name keeps its 220 px slot")
        header.get_by_role("button", name="More", exact=True).click()
        menu = page.get_by_role("menu", name="More")
        expect(menu.get_by_role("menuitem", name="People")).to_be_visible()
        expect(menu.get_by_role("menuitem", name="Call")).to_have_count(0)
        page.keyboard.press("Escape")
        expect(menu).to_have_count(0)
        views.get_by_role("tab", name=re.compile("^Tasks")).click()
        expect(page).to_have_url(re.compile(r"/tasks"))
        page.wait_for_function(SETTLED)
        self.assert_same_place(boxes, self.header_boxes(page, views=True, faces=False), "820 Conversation to Tasks")
        # The panel (380 px) is the computer's card laid over the work's right edge, under the header and with no scrim (#1365). A space has no
        # panel of its own (#1419): it is a task's.
        self.open_panel(page)
        expect(page.locator(".ui-panel--float")).to_be_visible()
        expect(page.locator(".ui-overlay[data-state='open']")).to_have_count(0)
        page.wait_for_function(SETTLED)
        panel = self.box(page.locator(".ui-panel--float"))
        self.assertAlmostEqual(panel["width"], 380, delta=1)
        self.assertGreater(panel["x"], 300, "the conversation stays visible to the left of the panel")
        bar = self.box(header)
        self.assertGreaterEqual(panel["y"], bar["y"] + bar["height"] - 1, "the panel never covers the header")
        self.assert_same_place(boxes, self.header_boxes(page, views=True, faces=False), "820 with the panel open")
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
        order = ["Expand sidebar", "New", "Search", "Home", "Inbox", "My tasks", "My map", "Community garden sensors", "Messages", "Kai Spokoj", "Ada Spokoj, Settings"]
        positions = [next((index for index, name in enumerate(names) if name and name.startswith(item)), -1) for item in order]
        self.assertTrue(all(position >= 0 for position in positions), names)
        self.assertEqual(positions, sorted(positions), f"the sidebar's order, the account (the one way to Settings, #1419) last: {names}")
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
                    boxes = self.header_boxes(page, views=True, faces=size is not TABLET)
                    # No media server here: Call is in no view, not even greyed or explained (#1424).
                    expect(header.get_by_role("button", name="Call", exact=True)).to_have_count(0)
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
                         # The primary action: the right end of this row on every device (#1366).
                         "New": toolbar.get_by_role("button", name="New Task", exact=True)}
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
                # The List's search works in place (#1424: it filters the page on screen), never greyed, so nothing beside it moves.
                expect(names["Search"]).to_be_enabled()
                # Mine works from the same place; the list has no second checkbox row and no second way to add.
                names["Mine"].click()
                expect(names["Mine"]).to_have_attribute("aria-pressed", "true")
                expect(page.get_by_label("Only mine")).to_have_count(0)
                expect(page.get_by_role("textbox", name=re.compile("Add a task", re.I))).to_have_count(0)
                self.assert_same_place(board, controls(), f"{size['width']} list with Mine")
                # One page of tasks has no Previous and Next (Spokój rule 4) and says "3 tasks"; no Refresh, the List updates live (#1419).
                names["Mine"].click()
                pages = page.get_by_role("navigation", name="Work pages")
                expect(pages).to_contain_text("3 tasks")
                expect(pages.get_by_role("button", name="Previous", exact=True)).to_have_count(0)
                expect(pages.get_by_role("button", name="Next", exact=True)).to_have_count(0)
                expect(pages.get_by_role("button", name="Refresh", exact=True)).to_have_count(0)
                if size is COMPUTER:
                    shot(page, "506-tasks-list-1440")
                names["Board"].click()
                expect(names["Board"]).to_have_attribute("aria-checked", "true")
                self.assert_same_place(board, controls(), f"{size['width']} back to the board")
                if size is COMPUTER:
                    shot(page, "506-tasks-board-1440")
                    # Opening a task docks the panel and narrows the board; "+ Task" stays the right end of the row (#1366).
                    page.locator(".tb-card .tb-card__open").first.click()
                    expect(page.locator(".ui-panel--docked")).to_be_visible()
                    page.wait_for_function(SETTLED)
                    row, new = self.box(toolbar), self.box(names["New"])
                    self.assertAlmostEqual(new["x"] + new["width"], row["x"] + row["width"] - 36, delta=40, msg="+ Task ends the row")

    def test_14_new_task_is_in_the_control_row_and_the_header_holds_only_its_slots(self) -> None:
        """#1366, rule 7: "+ Task" is the right end of the Tasks control row at every width, in both views, with a task open or not, and the
        space's header holds only the name, the views, the people, Call and More (nothing is added to it in Tasks)."""
        for width in (820, 1010, 1180, 1280, 1440):
            for folded in (False, True):
                if folded and width < 1010:
                    continue
                with self.subTest(width=width, sidebar="folded" if folded else "open"):
                    page = self.page({"width": width, "height": 820 if width != 820 else 1180}, touch=width <= 1024)
                    page.goto(f"/projects/{self.project_id}/tasks?view=board")
                    if folded:
                        page.get_by_role("button", name="Collapse sidebar").click()
                        expect(page.locator(".side--rail")).to_be_visible()
                    page.wait_for_function(SETTLED)
                    row = page.locator(".tb-bar")
                    new = row.get_by_role("button", name="New Task", exact=True)
                    expect(new).to_be_visible()
                    expect(page.locator("header.top").get_by_role("button", name="New Task", exact=True)).to_have_count(0)
                    self.assertEqual(page.locator("header.top .top__actions").evaluate("el => el.childElementCount"), 0, "nothing is put in the header's slot in Tasks")
                    places = self.header_places(page)
                    for mode in ("board", "list"):
                        row_box, new_box, search = self.box(row), self.box(new), self.box(row.get_by_label("Search tasks"))
                        self.assertGreaterEqual(new_box["x"], search["x"] + search["width"], f"{width} {mode}: + Task is after the search")
                        self.assertLessEqual(new_box["x"] + new_box["width"], row_box["x"] + row_box["width"] + 1, f"{width} {mode}: + Task is inside the row")
                        self.assertGreater(new_box["x"] + new_box["width"], row_box["x"] + row_box["width"] - 60, f"{width} {mode}: + Task is the row's right end")
                        self.assertLess(row_box["height"], 80, f"{width} {mode}: the control row is one line, with the panel open or not")
                        if mode == "board":
                            if width > 1000:  # the panel docks beside the work above 1000 px; below, it is the overlay from the right
                                page.locator(".tb-card .tb-card__open").first.click()
                                expect(page.locator(".ui-panel--docked")).to_be_visible()
                                page.wait_for_function(SETTLED)
                                self.assert_same_place(places, self.header_places(page), f"{width}: the header with a task open")
                                page.keyboard.press("Escape")
                                expect(page.locator(".ui-panel--docked")).to_have_count(0)
                            row.get_by_role("radio", name="List").click()
                            expect(row.get_by_role("radio", name="List")).to_have_attribute("aria-checked", "true")
                            page.wait_for_function(SETTLED)

    def test_15_the_list_and_its_control_row_share_a_column_on_a_wide_window(self) -> None:
        """#1366: at 3440 the List is a centred column; the row that controls it is the same column, with + Task at its right edge, and the
        Board | List switch is where it was in the board (rule 7)."""
        page = self.page({"width": 3440, "height": 1440})
        page.goto(f"/projects/{self.project_id}/tasks?view=board")
        page.wait_for_function(SETTLED)
        switch = page.locator(".tb-bar").get_by_role("radio", name="Board")
        in_board = self.box(switch)
        page.locator(".tb-bar").get_by_role("radio", name="List").click()
        expect(page.locator(".ws-tasks .ws-list").first).to_be_visible()
        page.wait_for_function(SETTLED)
        self.assert_same_place({"switch": in_board}, {"switch": self.box(switch)}, "the Board | List switch between the views at 3440")
        row, first = self.box(page.locator(".tb-bar")), self.box(page.locator(".ws-tasks .ws-list").first)
        new = self.box(page.locator(".tb-bar").get_by_role("button", name="New Task", exact=True))
        self.assertAlmostEqual(row["x"] + 24, first["x"], delta=24, msg="the row starts where the list starts")
        self.assertAlmostEqual(new["x"] + new["width"], first["x"] + first["width"], delta=30, msg="+ Task ends where the list ends")

    def test_16_the_one_panel_is_the_same_card_on_every_view_and_never_covers_the_header(self) -> None:
        """#1365, README §4: a task, a decision or a thread opens in the same right-hand panel over Conversation, Tasks and Wiki, under a header
        that stays visible and live, at 1440 and 1180x820 (beside the work). Below 1001 px it is still the overlay from the right (open question
        in #1365)."""
        for size in (COMPUTER, {"width": 1180, "height": 820}):
            with self.subTest(width=size["width"]):
                page = self.page(size)
                boxes, headers = {}, {}
                for path, name in (("", "Conversation"), ("/tasks", "Tasks"), ("/docs", "Wiki")):
                    self.goto_view(page, path)
                    self.open_panel(page)
                    head = self.box(page.locator("header.top"))
                    panel = self.box(page.locator(".ui-panel--docked"))
                    boxes[name], headers[name] = panel, head
                    self.assertGreaterEqual(panel["y"], head["y"] + head["height"] - 1, f"{name}: the panel is under the header")
                    # The header's own controls are what is at their centres: not the panel and not a scrim.
                    for control in ("More", "Call"):
                        button = page.locator("header.top").get_by_role("button", name=control, exact=True)
                        if not button.count() or not button.is_visible():
                            continue
                        at = button.evaluate("el => { const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!hit && el.contains(hit); }")
                        self.assertTrue(at, f"{name}: {control} is not covered")
                    self.assertEqual(page.locator(".ui-scrim:visible").count(), 0, f"{name}: no scrim dims the header")
                    self.close_panel(page)
                first = boxes["Conversation"]
                for name, box in boxes.items():
                    for key in ("x", "y", "width", "height"):
                        self.assertAlmostEqual(box[key], first[key], delta=1, msg=f"{size['width']} {name}: the panel's {key} is the same as in the Conversation")
                    self.assertAlmostEqual(headers[name]["height"], headers["Conversation"]["height"], delta=1)

    def test_17_the_board_stays_reachable_beside_the_panel(self) -> None:
        """#1365: at 1180x820 the board beside the panel is about 530 px wide: its four columns are reached by sideways scroll, shown by a bar."""
        page = self.page({"width": 1180, "height": 820})
        page.goto(f"/projects/{self.project_id}/tasks?view=board")
        page.locator(".tb-card .tb-card__open").first.click()
        expect(page.locator(".ui-panel--docked")).to_be_visible()
        page.wait_for_function(SETTLED)
        board = page.locator(".tb-board")
        reach = board.evaluate("el => ({ scroll: el.scrollWidth, client: el.clientWidth, bar: el.offsetHeight - el.clientHeight, thin: getComputedStyle(el).scrollbarWidth })")
        self.assertGreater(reach["scroll"], reach["client"], "the columns are wider than the board beside the panel")
        self.assertEqual(reach["thin"], "thin", "the bar that shows where it scrolls")
        board.evaluate("el => { el.scrollLeft = el.scrollWidth; }")
        done = self.box(page.locator('.tb-col[data-column="done"]'))
        pane, panel = self.box(page.locator("#content")), self.box(page.locator(".ui-panel--docked"))
        self.assertLessEqual(done["x"] + done["width"], min(pane["x"] + pane["width"], panel["x"]) + 1, "the last column ends beside the panel, not under it")
        self.assertGreaterEqual(done["x"], pane["x"], "and starts inside the board")

    def test_10_labels_have_one_meaning(self) -> None:
        page = self.page(COMPUTER)
        page.goto(f"/projects/{self.project_id}")
        page.locator("header.top").get_by_role("button", name="More", exact=True).click()
        menu = page.get_by_role("menu", name="More")
        expect(menu.get_by_role("menuitem", name="Space details")).to_have_count(0)
        expect(menu.get_by_role("menuitem", name="Details", exact=True)).to_have_count(0)
        page.keyboard.press("Escape")
        page.goto(self.dm_path)
        expect(page.get_by_role("button", name="Choose messages", exact=True)).to_have_count(0)  # sketches from messages are gone (#866)
        expect(page.get_by_role("button", name="Select", exact=True)).to_have_count(0)
        page.locator("header.top").get_by_role("button", name="More", exact=True).click()
        expect(page.get_by_role("menu", name="More").get_by_role("menuitem", name="People and privacy")).to_be_visible()

    def test_12_the_views_are_as_wide_as_their_words_and_the_name_has_its_own_slot(self) -> None:
        page = self.page(COMPUTER)
        self.goto_view(page, "")
        header = page.locator("header.top")
        links = header.get_by_role("navigation", name="Space views").get_by_role("tab")
        widths = [self.box(links.nth(index))["width"] for index in range(4)]
        # Underline tabs (#1239): left-aligned, each as wide as its word plus 22 px, side by side; "Conversation" is the widest.
        self.assertGreater(widths[0], widths[2] + 20, f"each tab is as wide as its word: {widths}")
        for index in range(4):
            self.assertGreaterEqual(widths[index], 44, f"a tab is at least 44 px wide: {widths}")
            word = links.nth(index).locator(".ui-tabs__label").evaluate("el => el.getBoundingClientRect().width")
            self.assertAlmostEqual(widths[index], word + 22, delta=1.5, msg=f"22 px between words: {widths}")
        # F-026 §4: the space's name has a 220 px slot, the same for every name.
        self.assertAlmostEqual(self.box(header.locator(".top__title"))["width"], 220, delta=2)
        # The tablet's 748 px header has the same tabs.
        tablet = self.page(TABLET)
        self.goto_view(tablet, "")
        compact = [self.box(link)["width"] for link in tablet.locator("header.top").get_by_role("navigation", name="Space views").get_by_role("tab").all()]
        self.assertEqual([round(width) for width in compact], [round(width) for width in widths], f"the tablet's tabs are the computer's: {compact}")

    def header_places(self, page: Page) -> dict:
        """Where the header's items are, by accessible name, in the state the page is in: the four views, the people and More (Call only with a media server)."""
        header = page.locator("header.top")
        places = {name: self.box(header.get_by_role("navigation", name="Space views").get_by_role("tab", name=re.compile(f"^{name}"))) for name in VIEW_NAMES}
        places["name"] = self.box(header.locator(".top__title"))
        for key, locator in (("people", header.get_by_role("button", name=PEOPLE)), ("Call", header.get_by_role("button", name="Call", exact=True)),
                             ("More", header.get_by_role("button", name="More", exact=True))):
            if locator.count():
                places[key] = self.box(locator)
        return places

    def test_13_the_views_keep_their_place_in_every_view_at_every_width(self) -> None:
        """#873, Spokój rule 7: the name's slot depends on the header's width only, so "+ Task" in Tasks (it is in the header from a 928 px
        header up) or any other item that is in one view only never moves the views, the people, Call or More. The name's slot is the same in
        every view too."""
        for width, height, text in ((820, 1180, None), (1010, 768, None), (1024, 768, None), (1100, 800, None), (1180, 820, None), (1200, 820, None), (1280, 800, None), (1440, 900, None),
                                    (1180, 820, "large"), (1440, 900, "large")):
            with self.subTest(width=width, text=text):
                page = self.page({"width": width, "height": height}, touch=width <= 1024)
                if text:
                    # The system's text size (a root font size of 113 %, set before the page's own styles run), not a setting of Flux's.
                    page.add_init_script(TEXT_SIZE_SCRIPT % 113)
                first = None
                for path in VIEWS:
                    self.goto_view(page, path)
                    places = self.header_places(page)
                    if first is None:
                        first = places
                    else:
                        self.assertEqual(sorted(places), sorted(first), f"{width} {path}: the same items are in the row")
                        self.assert_same_place(first, places, f"{width} {text or ''} view {path or '/'}")
                        for name in places:
                            self.assertAlmostEqual(places[name]["width"], first[name]["width"], delta=1, msg=f"{width} {path}: {name} keeps its width")
                self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), width, f"{width}: no sideways scroll")

    # ------------------------------------------------------------------ 507 AC-1 to AC-5

    def test_11_the_phone_header_is_back_the_name_and_more_with_the_views_under_it_in_every_view(self) -> None:
        for size in PHONES:
            with self.subTest(width=size["width"]):
                page = self.page(size, dark=size is PHONES[1], touch=True)
                reference = None
                # The Wiki's page and its history (#507: the header is the same in all of them).
                wiki_states = (f"/projects/{self.project_id}/docs/{self.doc_id}", f"/projects/{self.project_id}/docs/{self.doc_id}/history")
                for path in (*(f"/projects/{self.project_id}{view}" for view in VIEWS), *wiki_states, self.dm_path):
                    page.goto(path)
                    header = page.locator("header.phead")
                    project = path != self.dm_path
                    expect(header.get_by_role("button", name="More", exact=True)).to_be_visible()
                    page.wait_for_function(SETTLED)
                    head = self.box(header)
                    if project:
                        # A space (#1239): the title row (Back, the name, More), 8 px above and 12 under it, and the views' row of 44 px, where the
                        # hairline closes the header. A name of two lines makes the row taller.
                        self.assertGreaterEqual(head["height"], 106, path)
                        self.assertLessEqual(head["height"], 132, path)
                        controls = {
                            "Back": self.box(header.get_by_role("button", name="Back", exact=True)),
                            "title": self.box(header.get_by_role("heading", level=1)),
                            "More": self.box(header.get_by_role("button", name="More", exact=True)),
                        }
                        expect(header.get_by_role("navigation", name="Space views")).to_be_visible()
                        # Search and Call are rows of More; only Back and More are buttons in the header (Join appears while a call is live).
                        expect(header.get_by_role("button", name="Search", exact=True)).to_have_count(0)
                        expect(header.get_by_role("button", name="Call", exact=True)).to_have_count(0)
                        self.assertEqual(header.locator("button:visible").count(), 2, f"{path}: {header.locator('button:visible').all_inner_texts()}")
                    else:
                        # A direct message's title row is a space's without its views (#1374): 8 px above, the 44 px row, 6 px under it; Back · title · More,
                        # and nothing else (Search and Call are rows of More; Join appears while a call is live). The name is not a menu.
                        self.assertGreaterEqual(head["height"], 56, path)
                        self.assertLessEqual(head["height"], 70, path)
                        controls = {
                            "Back": self.box(header.get_by_role("button", name="Back", exact=True)),
                            "title": self.box(header.get_by_role("heading", level=1)),
                            "More": self.box(header.get_by_role("button", name="More", exact=True)),
                        }
                        expect(header.get_by_role("heading", level=1).get_by_role("button")).to_have_count(0)
                        expect(header.get_by_role("button", name="Search", exact=True)).to_have_count(0)
                        expect(header.get_by_role("button", name="Call", exact=True)).to_have_count(0)
                        self.assertEqual(header.locator("button:visible").count(), 2, f"{path}: {header.locator('button:visible').all_inner_texts()}")
                    if path.endswith("/docs") or path.endswith(self.doc_id):
                        expect(header.get_by_role("button", name="Page actions", exact=True)).to_have_count(0)
                        menu = page.locator(".wiki-head").get_by_role("button", name="Page actions", exact=True)
                        expect(menu).to_be_visible()
                        menu_box, row = self.box(menu), self.box(page.locator(".wiki-head"))
                        self.assertGreaterEqual(min(menu_box["width"], menu_box["height"]), 44, "the page's menu keeps a touch target")
                        self.assertGreaterEqual(menu_box["y"], head["y"] + head["height"] - 0.5, "the page's menu is below the header")
                        self.assertLessEqual(menu_box["y"] + menu_box["height"], row["y"] + row["height"] + 0.5, "in the row above the title")
                        self.assertLessEqual(menu_box["x"] + menu_box["width"], size["width"], "inside the screen")
                    for name, box in controls.items():
                        if name == "title":
                            continue
                        self.assertGreaterEqual(min(box["width"], box["height"]), 44, f"{name} at {path}")
                        self.assertGreaterEqual(box["y"], head["y"] - 0.5, f"{name} stays inside the header at {path}")
                        self.assertLessEqual(box["y"] + box["height"], head["y"] + head["height"] + 0.5, f"{name} stays inside the header at {path}")
                    self.assertLess(controls["Back"]["x"], controls["title"]["x"])
                    self.assertLessEqual(controls["title"]["x"] + controls["title"]["width"], controls["More"]["x"] + 0.5)
                    # The capsule and its round Search stay on Home, Projects and Inbox only.
                    expect(page.locator(".phone-dock__bar, .phone-dock__search")).to_have_count(0)
                    self.assertEqual(page.evaluate("document.documentElement.scrollWidth"), size["width"], path)
                    title = self.box(header.locator(".phead__title"))
                    if project and reference is None:
                        reference = {**controls, "title width": title}
                        shot(page, f"507-phone-{size['width']}-conversation")
                    elif project:
                        moving = {key: value for key, value in controls.items() if key != "title"}
                        self.assert_same_place({key: value for key, value in reference.items() if key in moving}, moving, f"{size['width']} {path}")
                        # The project's title is cut at the same width in every view.
                        self.assertAlmostEqual(title["width"], reference["title width"]["width"], delta=1, msg=f"{size['width']} title width at {path}")
                        self.assertAlmostEqual(controls["title"]["x"], reference["title"]["x"], delta=4, msg=f"{size['width']} title at {path}")
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
                        # A space's header starts its title row 8 px down, a main place's 6 px (the space header's own rhythm, #1239).
                        self.assertAlmostEqual(here["y"], reference["Back"]["y"], delta=2.5, msg=f"{path}: the controls start at the top of the header")

if __name__ == "__main__":
    unittest.main()
