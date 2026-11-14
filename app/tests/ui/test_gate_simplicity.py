"""Release-gate simplicity fixes (#1424): the Map tab of a space with no map opens the empty canvas and makes the map on the first thought,
the phone map frames its thoughts below its header and says "Connect and arrange on a computer" once, and the Tasks List's search filters.
(Home's single appearance is in test_home_final, the Company list's missing Delete in test_space_settings, Create's missing Status in
test_create_window.) Computer and phone, against the API. Screenshots (gate-*.png) go to FLUX_UI_SCREENSHOTS when set."""
from __future__ import annotations

import os
import re
import unittest
import uuid

from playwright.sync_api import expect, sync_playwright

from test_app_shell import ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

DESKTOP = {"width": 1440, "height": 900}
THOUGHTS = ("Six sensors for twelve beds", "Far beds: test LoRa range first", "Borrow two sensors from the school?")
TASKS = ("Buy two level sensors", "Mesh in front of the diverter", "Paint the rain barrel")


class GateSimplicity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, os.environ.get("FLUX_UI_BROWSER", "chromium")).launch()
        expect.set_options(timeout=10000)
        context = cls.browser.new_context(service_workers="block", base_url=ORIGIN)
        response = context.request.post("/api/auth/sign-up/email", data={
            "name": "Ada Kowalska", "email": f"gate-{uuid.uuid4()}@example.test", "password": "one calm gate, fewer things"}, headers={"origin": ORIGIN})
        assert response.status == 200, response.text()
        cls.state = context.storage_state()
        cls.workspace = cls.api(context, "POST", "/api/v1/workspaces", {"name": "Riverside Makers"}, 201)["id"]
        cls.mapped = cls.api(context, "POST", f"/api/v1/workspaces/{cls.workspace}/projects", {"name": "Community garden sensors", "visibility": "restricted"}, 201)["id"]
        cls.sketch = cls.api(context, "POST", f"/api/v1/workspaces/{cls.workspace}/sketches", {"title": "Where the sensors go", "scope": "project", "projectId": cls.mapped}, 201)["id"]
        for index, text in enumerate(THOUGHTS):
            cls.api(context, "POST", f"/api/v1/sketches/{cls.sketch}/thoughts", {"text": text, "x": 40 + (index % 2) * 380, "y": 40 + (index // 2) * 200}, 201)
        for title in TASKS:
            cls.api(context, "POST", f"/api/v1/projects/{cls.mapped}/work", {"title": title}, 201)
        context.close()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    @staticmethod
    def api(context, method, path, body=None, status=200):
        response = context.request.fetch(path, method=method, data=body, headers={"origin": ORIGIN, "idempotency-key": str(uuid.uuid4())})
        assert response.status == status, f"{path}: {response.status} {response.text()}"
        return response.json() if response.text() else None

    def page(self, phone: bool = False):
        options = dict(viewport=PHONE, device_scale_factor=3, has_touch=True, is_mobile=True) if phone else dict(viewport=DESKTOP)
        context = self.browser.new_context(service_workers="block", base_url=ORIGIN, storage_state=self.state, locale="en-GB", **options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught browser errors"))
        page.api = lambda method, path, body=None, status=200: self.api(context, method, path, body, status)  # type: ignore[attr-defined]
        return page

    def empty_space(self, page, name: str) -> str:
        return page.api("POST", f"/api/v1/workspaces/{self.workspace}/projects", {"name": name, "visibility": "restricted"}, 201)["id"]  # type: ignore[attr-defined]

    def maps_of(self, page, project: str) -> int:
        """Every map the space holds, empty ones too."""
        return page.api("GET", f"/api/v1/workspaces/{self.workspace}/sketches?projectId={project}&limit=10")["total"]  # type: ignore[attr-defined]

    # ---------------------------------------------------------------- the Map tab of a space with no map

    def test_01_a_space_with_no_map_opens_the_canvas_and_the_first_thought_makes_the_map(self):
        page = self.page()
        project = self.empty_space(page, f"Rain barrel monitor {uuid.uuid4().hex[:4]}")
        page.goto("/")
        expect(page.get_by_role("heading", level=2, name=re.compile("^Good (morning|afternoon|evening), Ada$"))).to_be_visible()
        page.goto(f"/projects/{project}/map")
        # The map's own empty canvas: no page about maps, no New map, no name to type, one hint.
        first = page.locator(".sk-first")
        expect(first).to_have_text("An empty map. Add the first thought with Thought, then keep adding with the + beside it.")
        expect(page.get_by_text("Map ideas for")).to_have_count(0)
        expect(page.get_by_role("button", name="New map")).to_have_count(0)
        expect(page.get_by_role("textbox", name="Map name")).to_have_count(0)
        expect(page.locator(".sk-hint")).to_have_count(0)
        tools = page.get_by_role("toolbar", name="Map tools")
        expect(tools.get_by_role("button")).to_have_count(1)
        shot(page, "gate-empty-map-desktop")
        # Visiting made nothing; the first thought makes the map and opens a draft ready to type.
        self.assertEqual(self.maps_of(page, project), 0)
        tools.get_by_role("button", name="Thought", exact=True).click()
        expect(page).to_have_url(re.compile(rf"/projects/{project}/map/[0-9a-f-]{{36}}$"))
        draft = page.get_by_role("textbox", name="Thought text")
        expect(draft).to_be_focused()
        expect(page.get_by_role("textbox", name="Map name")).to_have_count(0)
        self.assertEqual(self.maps_of(page, project), 1)
        stored = page.api("GET", f"/api/v1/sketches/{page.url.rsplit('/', 1)[-1]}")  # type: ignore[attr-defined]
        self.assertEqual((stored["scope"], stored["projectId"], stored["title"]), ("project", project, "Untitled map"))
        # Still one hint while the map is empty; the drag hint comes with the first thought.
        expect(page.locator(".sk-hint")).to_have_count(0)
        draft.fill("Probe spacing along the fence")
        page.get_by_role("button", name="Save thought").click()
        expect(page.locator(".sk-node")).to_have_count(1)
        expect(page.locator(".sk-first")).to_have_count(0)
        expect(page.locator(".sk-hint")).to_contain_text("Drag empty space to move around")
        # Back leaves the tab instead of returning to the empty canvas.
        page.go_back()
        expect(page).to_have_url(f"{ORIGIN}/")

    def test_02_a_double_click_on_the_empty_canvas_starts_the_map_too(self):
        page = self.page()
        project = self.empty_space(page, f"Cargo bike co-op {uuid.uuid4().hex[:4]}")
        page.goto(f"/projects/{project}/map")
        expect(page.locator(".sk-first")).to_be_visible()
        page.locator(".sk-canvas").dblclick(position={"x": 400, "y": 300})
        expect(page).to_have_url(re.compile(rf"/projects/{project}/map/[0-9a-f-]{{36}}$"))
        expect(page.get_by_role("textbox", name="Thought text")).to_be_focused()

    def test_03_the_phone_has_one_add_a_thought_on_an_empty_map(self):
        page = self.page(phone=True)
        project = self.empty_space(page, f"Phone ideas {uuid.uuid4().hex[:4]}")
        page.goto(f"/projects/{project}/map")
        expect(page.locator(".sk-first")).to_have_text("An empty map. Start with Add a thought.")
        expect(page.get_by_text("Map ideas for")).to_have_count(0)
        expect(page.get_by_text("Connect and arrange on a computer")).to_have_count(0)
        shot(page, "gate-empty-map-phone")
        page.get_by_role("button", name="Add a thought", exact=True).tap()
        expect(page).to_have_url(re.compile(rf"/projects/{project}/map/[0-9a-f-]{{36}}$"))
        expect(page.get_by_role("textbox", name="Thought text")).to_be_visible()

    # ---------------------------------------------------------------- the phone map

    def test_04_the_phone_map_is_framed_below_its_header_and_says_the_computer_line_once(self):
        page = self.page(phone=True)
        page.goto(f"/projects/{self.mapped}/map")
        expect(page).to_have_url(re.compile(rf"/projects/{self.mapped}/map/{self.sketch}$"))
        expect(page.locator(".sk-node")).to_have_count(len(THOUGHTS))
        head = page.locator(".sk-head")
        options = page.get_by_role("button", name="Map options", exact=True)
        expect(head).to_be_visible()
        expect(options).to_be_visible()
        title, opts, canvas = head.bounding_box(), options.bounding_box(), page.locator(".sk-canvas").bounding_box()
        # The title and Map options share one row, side by side; nothing lies over the thoughts.
        self.assertLess(abs((title["y"] + title["height"] / 2) - (opts["y"] + opts["height"] / 2)), 8, f"one row: {title} {opts}")
        self.assertLessEqual(title["x"] + title["width"], opts["x"] + 1, "the title pill stops before Map options")
        self.assertLessEqual(max(title["y"] + title["height"], opts["y"] + opts["height"]), canvas["y"] + canvas["height"] * 0.2, "the first row is the top of the screen")
        for node in page.locator(".sk-node").all():
            box = node.bounding_box()
            for name, other in (("the title pill", title), ("Map options", opts)):
                apart = box["y"] >= other["y"] + other["height"] - 0.5 or box["x"] >= other["x"] + other["width"] - 0.5 \
                    or box["x"] + box["width"] <= other["x"] + 0.5 or box["y"] + box["height"] <= other["y"] + 0.5
                self.assertTrue(apart, f"a thought lies under {name}: {box} / {other}")
        # The line about arranging on a computer is said once, with its own close.
        note = page.get_by_text("Connect and arrange on a computer")
        expect(note).to_be_visible()
        shot(page, "gate-map-phone")
        page.get_by_role("button", name="Dismiss", exact=True).tap()
        expect(note).to_have_count(0)
        page.reload()
        expect(page.locator(".sk-node")).to_have_count(len(THOUGHTS))
        expect(page.get_by_text("Connect and arrange on a computer")).to_have_count(0)
        other = page.api("POST", f"/api/v1/workspaces/{self.workspace}/sketches", {"title": "Second map", "scope": "project", "projectId": self.mapped}, 201)["id"]  # type: ignore[attr-defined]
        page.api("POST", f"/api/v1/sketches/{other}/thoughts", {"text": "A thought on another map", "x": 40, "y": 40}, 201)  # type: ignore[attr-defined]
        page.goto(f"/projects/{self.mapped}/map/{other}")
        expect(page.locator(".sk-node")).to_have_count(1)
        expect(page.get_by_text("Connect and arrange on a computer")).to_have_count(0)
        expect(page.get_by_role("button", name="Add a thought", exact=True)).to_be_visible()

    def test_05_the_fit_button_is_named_for_the_map(self):
        page = self.page()
        page.goto(f"/projects/{self.mapped}/map/{self.sketch}")
        fit = page.get_by_role("button", name="Fit the map to the view", exact=True)
        expect(fit).to_have_text("Fit")
        expect(page.get_by_role("button", name=re.compile("sketch", re.I))).to_have_count(0)

    # ---------------------------------------------------------------- the Tasks List's search

    def test_06_search_tasks_filters_the_list_and_is_never_greyed(self):
        page = self.page()
        page.goto(f"/projects/{self.mapped}/tasks")
        page.get_by_role("radio", name="List", exact=True).click()
        search = page.get_by_role("searchbox", name="Search tasks")
        expect(page.locator(".ws-task")).to_have_count(len(TASKS))
        expect(search).to_be_enabled()
        expect(page.locator(".tb-search.is-dimmed")).to_have_count(0)
        expect(page.get_by_text("Search works on the board")).to_have_count(0)
        search.fill("mesh")
        expect(page.locator(".ws-task")).to_have_count(1)
        expect(page.locator(".ws-task")).to_contain_text("Mesh in front of the diverter")
        expect(page.get_by_role("status").filter(has_text="1 match")).to_contain_text("1 match · 3 tasks")
        shot(page, "gate-tasks-list-search")
        search.fill("#2")
        expect(page.locator(".ws-task")).to_have_count(1)
        search.fill("no such task")
        expect(page.locator(".ws-task")).to_have_count(0)
        expect(page.get_by_text("No task matches “no such task”.")).to_be_visible()
        page.get_by_role("button", name="Clear the search").click()
        expect(search).to_have_value("")
        expect(page.locator(".ws-task")).to_have_count(len(TASKS))
        # The same search follows the person to the Board and filters its cards.
        search.fill("paint")
        page.get_by_role("radio", name="Board", exact=True).click()
        expect(search).to_have_value("paint")
        expect(page.locator(".tb-card")).to_have_count(1)
        expect(page.locator(".tb-card")).to_contain_text("Paint the rain barrel")

    def test_07_the_phone_list_search_filters_too(self):
        page = self.page(phone=True)
        page.goto(f"/projects/{self.mapped}/tasks")
        page.get_by_role("radio", name="List", exact=True).tap()
        expect(page.locator(".ws-task")).to_have_count(len(TASKS))
        search = page.get_by_role("searchbox", name="Search tasks")
        expect(search).to_be_enabled()
        search.fill("barrel")
        expect(page.locator(".ws-task")).to_have_count(1)
        shot(page, "gate-tasks-list-search-phone")


if __name__ == "__main__":
    unittest.main()
