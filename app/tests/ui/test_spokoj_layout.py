"""Spokój layout and controls (#505, #506, #507; docs/design/spokoj "Layout per screen" and rule 7).

Computer: one header row above the conversation and the one panel; the panel is 420 px at 1440 and 480 px
from 1920; the conversation is at most 760 px; a tablet folds the sidebar to its rail and overlays the panel.
Controls keep their place: the rail order, the Tasks toolbar in both views and the header's views and More
do not move when the panel opens, closes or the view changes. Phone: the same header row in every project view
and a direct message, 56 px tall, with Back · title · Together · Search.

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
LARGE = {"width": 1920, "height": 1080}
TABLET = {"width": 820, "height": 1180}
PHONES = ({"width": 390, "height": 844}, {"width": 375, "height": 667})
VIEWS = ("", "/map", "/tasks", "/docs", "/agents")
VIEW_NAMES = ("Conversation", "Map", "Tasks", "Wiki", "Agents")


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
        page.goto(f"/dm/new?workspace={workspace['id']}&with={cls.kai_id}")
        expect(page).to_have_url(re.compile(r"/dm/[0-9a-f-]{36}$"))
        cls.dm_path = page.url.removeprefix(ORIGIN)
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

    def page(self, size: dict, dark: bool = False) -> Page:
        context = self.browser.new_context(base_url=ORIGIN, viewport=size, storage_state=self.state,
                                           color_scheme="dark" if dark else "light", service_workers="block")
        self.addCleanup(context.close)
        return context.new_page()

    def box(self, locator) -> dict:
        value = None
        for _ in range(10):
            value = locator.bounding_box()
            if value is not None:
                break
            locator.page.wait_for_timeout(100)
        self.assertIsNotNone(value, f"{locator} has a box")
        return value

    def assert_same_place(self, before: dict, after: dict, label: str) -> None:
        for name, box in before.items():
            self.assertIn(name, after, label)
            for key in ("x", "y"):
                self.assertAlmostEqual(box[key], after[name][key], delta=1, msg=f"{label}: {name} moved on {key}")

    def header_boxes(self, page: Page) -> dict:
        header = page.locator("header.top")
        boxes = {"More": self.box(header.get_by_role("button", name="More", exact=True))}
        for name in VIEW_NAMES:
            # A view with a count has it in its name ("Tasks, 3 open").
            boxes[name] = self.box(header.get_by_role("navigation", name="Project views").get_by_role("link", name=re.compile(f"^{name}")))
        return boxes

    def open_panel(self, page: Page) -> None:
        page.locator("header.top").get_by_role("button", name=re.compile("who can see this project$")).click()
        expect(page.locator(".ui-panel--docked")).to_be_visible()
        # The panel slides in from 24 px to the right; measure it once the animation has landed.
        page.wait_for_function("() => document.getAnimations().every((a) => a.playState !== 'running')")

    def close_panel(self, page: Page) -> None:
        page.locator(".ui-panel--docked").get_by_role("button", name=re.compile("^Close")).click()
        expect(page.locator(".ui-panel--docked")).to_have_count(0)

    # ------------------------------------------------------------------ 505 AC-1, AC-3, AC-6

    def test_01_one_header_row_and_the_views_stay_with_the_panel_open_or_closed(self) -> None:
        for size in (COMPUTER, LAPTOP):
            with self.subTest(width=size["width"]):
                page = self.page(size)
                page.goto(f"/projects/{self.project_id}")
                header = page.locator("header.top")
                expect(header.get_by_role("navigation", name="Project views")).to_be_visible()
                closed = self.header_boxes(page)
                self.assertLessEqual(self.box(header)["height"], 72, "one row, not two")
                title = self.box(header.get_by_role("heading", level=1))
                views = self.box(header.get_by_role("navigation", name="Project views"))
                self.assertLess(abs((title["y"] + title["height"] / 2) - (views["y"] + views["height"] / 2)), 4, "the name and the views share the row")
                self.open_panel(page)
                opened = self.header_boxes(page)
                self.assert_same_place(closed, opened, f"{size['width']} panel opened")
                # The header spans the conversation and the panel: one row above both (layout per screen).
                head = self.box(header)
                panel = self.box(page.locator(".ui-panel--docked"))
                self.assertLessEqual(head["x"], panel["x"] + 1)
                self.assertGreaterEqual(head["x"] + head["width"], panel["x"] + panel["width"] - 1)
                self.assertLessEqual(self.box(header)["height"], 72)
                # The views are the same in every project view, and More never leaves the header.
                for path in VIEWS[1:]:
                    page.get_by_role("navigation", name="Project views").get_by_role("link", name=re.compile(f"^{VIEW_NAMES[VIEWS.index(path)]}")).click()
                    expect(page).to_have_url(re.compile(re.escape(f"/projects/{self.project_id}{path}") + r"(\?|$|/)"))
                    self.assert_same_place(opened, self.header_boxes(page), f"{size['width']} view {path}")
                self.close_panel(page)
                self.assert_same_place(closed, self.header_boxes(page), f"{size['width']} panel closed again")
                if size is COMPUTER:
                    shot(page, "505-header-1440-panel-closed")

    def test_02_the_panel_is_420_at_1440_and_480_from_1920_and_the_conversation_is_at_most_760(self) -> None:
        page = self.page(COMPUTER)
        page.goto(f"/projects/{self.project_id}")
        self.open_panel(page)
        self.assertAlmostEqual(self.box(page.locator(".ui-panel--docked"))["width"], 420, delta=1)
        page = self.page(LARGE)
        page.goto(f"/projects/{self.project_id}")
        self.open_panel(page)
        self.assertAlmostEqual(self.box(page.locator(".ui-panel--docked"))["width"], 480, delta=1)
        column = self.box(page.locator(".project-convo__in"))
        self.assertLessEqual(column["width"], 760.5, "the conversation is at most 760 px")
        # Exactly two content columns: the conversation pane and the panel.
        self.assertEqual(page.locator(".app__body > *").count(), 2)
        shot(page, "505-layout-1920-panel-open")

    # ------------------------------------------------------------------ 505 AC-2, AC-5

    def test_03_tablet_folds_the_sidebar_to_the_rail_and_the_panel_overlays_the_conversation(self) -> None:
        page = self.page(TABLET)
        page.goto(f"/projects/{self.project_id}")
        expect(page.locator(".app__side--rail")).to_have_count(1)
        self.assertAlmostEqual(self.box(page.locator(".app__side"))["width"], 64, delta=1)
        header = page.locator("header.top")
        self.assertLessEqual(self.box(header)["height"], 72)
        # The people move into More while the title and the views stay in the row.
        expect(header.get_by_role("button", name=re.compile("who can see this project$"))).to_be_hidden()
        page.locator("header.top").get_by_role("button", name="More", exact=True).click()
        page.get_by_role("menu", name="More").get_by_role("menuitem", name="Who can see this").click()
        expect(page.locator(".ui-panel")).to_be_visible()
        panel = self.box(page.locator(".ui-panel"))
        self.assertLessEqual(panel["width"], 381)
        pane = self.box(page.locator(".app__pane"))
        self.assertGreater(pane["width"], 300, "the conversation stays visible beside the overlaid panel")
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), TABLET["width"], "no sideways page scroll")
        # The rail's expand control opens the sidebar as a drawer.
        page.keyboard.press("Escape")
        page.locator(".app__side--rail").get_by_role("button", name="Expand sidebar").click()
        expect(page.locator("#nav-drawer")).to_be_visible()
        shot(page, "505-tablet-820")

    def test_04_inbox_has_no_control_outside_the_viewport_at_820(self) -> None:
        page = self.page(TABLET)
        page.goto("/inbox")
        expect(page.locator("header.top h1")).to_be_visible()
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), TABLET["width"])
        for button in page.locator("header.top button:visible").all():
            box = self.box(button)
            self.assertLessEqual(box["x"] + box["width"], TABLET["width"] + 0.5, "every header control is inside the viewport")

    # ------------------------------------------------------------------ 506 AC-1, AC-2, AC-3

    def test_05_the_rail_lists_the_sidebar_order_and_its_toggle_leads(self) -> None:
        page = self.page(COMPUTER)
        page.goto(f"/projects/{self.project_id}")
        expect(page.locator("header.top h1")).to_be_visible()
        page.locator("body").press("[")
        rail = page.locator(".side--rail")
        expect(rail).to_be_visible()
        names = rail.locator("a[aria-label], button[aria-label]").evaluate_all("els => els.map(el => el.getAttribute('aria-label'))")
        order = ["Search", "Home", "Inbox", "Sketchbook", "Community garden sensors", "Messages"]
        positions = [next((index for index, name in enumerate(names) if name and name.startswith(item)), -1) for item in order]
        self.assertTrue(all(position >= 0 for position in positions), names)
        self.assertEqual(positions, sorted(positions), "Search, Home, Inbox, Sketchbook, projects, then messages")
        toggle = self.box(rail.get_by_role("button", name="Expand sidebar"))
        self.assertLess(toggle["y"], self.box(rail.get_by_role("link", name="Home"))["y"], "the toggle is in the top row")
        page.locator("body").press("[")
        expect(page.locator(".side--rail")).to_have_count(0)
        self.assertAlmostEqual(self.box(page.get_by_role("button", name="Collapse sidebar"))["y"], toggle["y"], delta=4, msg="the expanded toggle stays in the top row")

    def test_06_the_tasks_toolbar_keeps_its_controls_when_the_view_changes(self) -> None:
        page = self.page(COMPUTER)
        page.goto(f"/projects/{self.project_id}/tasks")
        toolbar = page.locator(".tb-bar")
        expect(toolbar.get_by_role("radio", name="Board")).to_be_visible()

        def controls() -> dict:
            return {
                "Board": self.box(toolbar.get_by_role("radio", name="Board")),
                "List": self.box(toolbar.get_by_role("radio", name="List")),
                "Mine": self.box(toolbar.get_by_role("button", name="Mine", exact=True)),
                "Search": self.box(toolbar.get_by_label("Search tasks")),
                "New": self.box(toolbar.get_by_role("button", name="New Task", exact=True)),
            }

        board = controls()
        toolbar.get_by_role("radio", name="List").click()
        expect(toolbar.get_by_role("radio", name="List")).to_have_attribute("aria-checked", "true")
        self.assert_same_place(board, controls(), "board to list")
        # Mine works from the same place in the list, and the list has no second checkbox row.
        toolbar.get_by_role("button", name="Mine", exact=True).click()
        expect(toolbar.get_by_role("button", name="Mine", exact=True)).to_have_attribute("aria-pressed", "true")
        expect(page.get_by_label("Only mine")).to_have_count(0)
        expect(page.get_by_role("textbox", name=re.compile("Add a task", re.I))).to_have_count(0)
        self.assert_same_place(board, controls(), "list with Mine")
        toolbar.get_by_role("radio", name="Board").click()
        self.assert_same_place(board, controls(), "back to the board")
        shot(page, "506-tasks-toolbar-1440")

    def test_07_header_controls_do_not_move_between_project_views(self) -> None:
        page = self.page(COMPUTER)
        page.goto(f"/projects/{self.project_id}")
        header = page.locator("header.top")

        def controls() -> dict:
            return {
                "Who can see this": self.box(header.get_by_role("button", name=re.compile("who can see this project$"))),
                "More": self.box(header.get_by_role("button", name="More", exact=True)),
            }

        first = controls()
        for path in VIEWS[1:]:
            page.goto(f"/projects/{self.project_id}{path}")
            expect(header.get_by_role("navigation", name="Project views")).to_be_visible()
            self.assert_same_place(first, controls(), f"view {path or 'conversation'}")

    # ------------------------------------------------------------------ 507 AC-1, AC-2, AC-3, AC-5

    def test_08_the_phone_header_is_one_56px_row_with_the_same_controls_in_every_view(self) -> None:
        for size in PHONES:
            with self.subTest(width=size["width"]):
                page = self.page(size)
                reference = None
                for path in (*(f"/projects/{self.project_id}{view}" for view in VIEWS), self.dm_path):
                    page.goto(path)
                    header = page.locator("header.phead")
                    expect(header.get_by_role("button", name="Search", exact=True)).to_be_visible()
                    self.assertAlmostEqual(self.box(header)["height"], 56, delta=1, msg=path)
                    controls = {
                        "Back": self.box(header.get_by_role("button", name="Back", exact=True)),
                        "Search": self.box(header.get_by_role("button", name="Search", exact=True)),
                    }
                    for name, box in controls.items():
                        self.assertGreaterEqual(min(box["width"], box["height"]), 44, f"{name} at {path}")
                    # The capsule and its round Search stay on Home, Projects and Inbox only.
                    expect(page.locator(".phone-dock__bar, .phone-dock__search")).to_have_count(0)
                    self.assertEqual(page.evaluate("document.documentElement.scrollWidth"), size["width"], path)
                    if reference is None:
                        reference = controls
                        shot(page, f"507-phone-{size['width']}-header")
                    else:
                        self.assert_same_place(reference, controls, f"{size['width']} {path}")
                # The top-level places are 56 px too (Home, Projects, Inbox).
                for path in ("/", "/projects", "/inbox"):
                    page.goto(path)
                    self.assertAlmostEqual(self.box(page.locator("header.phead"))["height"], 56, delta=1, msg=path)


if __name__ == "__main__":
    unittest.main()
