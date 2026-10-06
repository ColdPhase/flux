"""UI116-4 (#136): map thoughts show a task count, and the count opens every linked task.

Runs with the other tests/ui journeys through scripts/check_ui.sh against the running Compose
application. Three people share a restricted project whose sketch has thoughts linked to tasks
many-to-many: one thought leads to three tasks, one task comes from two thoughts, one thought has
none and one sits on a private draft. The tests check the counts against the API on the canvas and
in the List, the chooser's exact IDs, status and people, opening a task, Escape and Close returning
to the same camera and selection, a reader without changes, the phone sheet, live counts and
contrast in Light and Dark with every accent. No interaction changes the stored sketch or work.
"""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, Locator, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, SHOTS, UPSTREAM, shot, start_forwarder
from test_theme_accents import FAMILIES, MEASURE

STAMP = int(time.time() * 1000)
PASSWORD = "count the work, not the words"
PEOPLE = {"ada": "Ada Lind", "kai": "Kai Berg", "nia": "Nia Okafor"}

DARK_ROOM = "Distance sensing that works in a dark bedroom"
CAMERA = "Camera-only gesture recognition"
QUIET = "What should happen when nobody is in the room?"
DRAFTED = "Compare calibration notes without sharing the private source"
LATER = "Later: a mechanical brightness dial"
PRIVATE = "PRIVATE CALIBRATION NOTES"

ORDER = "Order two VL53L5CX ToF sensor boards"
CALIBRATE = "Calibrate the ToF sensor against the camera at 5 lux"
PROTOCOL = "Write the low-light test protocol"
DIFFUSER = "Print a diffuser sample in white PETG"
OCCUPANCY = "Decide what the lamp does in an empty room"


def quote(text: str) -> str:
    """The app's quote() for accessible names: curly quotes, long text shortened to 48 characters."""
    return f"“{text[:47] + '…' if len(text) > 48 else text}”"


def task_number(item: dict) -> str:
    """The name a task goes by on every surface (#276): its number in its project."""
    return f"#{item['number']}"


def tasks_label(count: int, text: str) -> str:
    return f"{count} {'task' if count == 1 else 'tasks'} linked to {quote(text)}"


class MapTaskCountJourney(unittest.TestCase):
    """Tests run in name order and share three accounts, one project and its sketch."""

    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}
    thoughts: dict[str, str] = {}
    work: dict[str, str] = {}
    numbers: dict[str, int] = {}
    sketch_baseline: dict = {}
    work_baseline: dict = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        expect.set_options(timeout=10000)
        contexts = {}
        for key, name in PEOPLE.items():
            context = cls.browser.new_context(base_url=ORIGIN)
            email = f"map-count-{key}+{STAMP}@example.test"
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.ids[f"{key}-email"] = email
            cls.states[key] = context.storage_state()
            contexts[key] = context
        ada = contexts["ada"]

        def post(path: str, body: dict) -> dict:
            response = ada.request.post(path, data=body, headers={"origin": ORIGIN, "idempotency-key": str(uuid.uuid4())})
            assert response.status == 201, response.text()
            return response.json()

        workspace = post("/api/v1/workspaces", {"name": "Lamp studio"})["id"]
        for key in ("kai", "nia"):
            post(f"/api/v1/workspaces/{workspace}/members", {"email": cls.ids[f"{key}-email"], "role": "member"})
        project = post(f"/api/v1/workspaces/{workspace}/projects", {"name": "Gesture lamp", "visibility": "restricted"})["id"]
        post(f"/api/v1/projects/{project}/grants", {"principal": {"kind": "human", "id": cls.ids["kai"]}, "role": "viewer"})
        post(f"/api/v1/projects/{project}/grants", {"principal": {"kind": "human", "id": cls.ids["nia"]}, "role": "contributor"})
        sketch = post(f"/api/v1/workspaces/{workspace}/sketches", {"title": "Sensing directions", "scope": "project", "projectId": project})["id"]
        draft = post(f"/api/v1/workspaces/{workspace}/drafts", {"title": PRIVATE, "body": "Only Ada can read this draft"})["id"]
        cls.ids.update(workspace=workspace, project=project, sketch=sketch, draft=draft)

        def thought(key: str, text: str, x: int, y: int, **extra) -> None:
            cls.thoughts[key] = post(f"/api/v1/sketches/{sketch}/thoughts", {"text": text, "x": x, "y": y, **extra})["thought"]["id"]

        thought("dark", DARK_ROOM, 420, 260)
        thought("camera", CAMERA, 60, 40, linkFrom={"thoughtId": cls.thoughts["dark"]})
        thought("quiet", QUIET, 780, 40, linkFrom={"thoughtId": cls.thoughts["dark"]})
        thought("drafted", DRAFTED, 780, 480, placement={"type": "draft", "id": draft}, linkFrom={"thoughtId": cls.thoughts["dark"]})
        thought("later", LATER, 1500, 900)

        def task(key: str, title: str, **extra) -> None:
            created = post(f"/api/v1/projects/{project}/work", {"title": title, **extra})
            cls.work[key], cls.numbers[key] = created["id"], created["number"]

        ref = lambda key: {"type": "thought", "id": cls.thoughts[key]}  # noqa: E731
        task("order", ORDER, sources=[ref("dark")], owner={"kind": "human", "id": cls.ids["nia"]}, status="in_progress")
        # Many-to-many: one task from two thoughts.
        task("calibrate", CALIBRATE, sources=[ref("dark"), ref("camera")], owner={"kind": "human", "id": cls.ids["ada"]}, status="blocked", blocker="the sensor delivery from Mouser")
        task("protocol", PROTOCOL, related=[ref("dark")])
        task("diffuser", DIFFUSER, sources=[ref("drafted")], owner={"kind": "human", "id": cls.ids["nia"]}, status="done")
        for context in contexts.values():
            context.close()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    # ---------------------------------------------------------------- helpers

    def page(self, who: str = "ada", *, phone: bool = False, dark: bool = False, **options) -> Page:
        settings: dict = {"base_url": ORIGIN, "storage_state": self.states[who], "color_scheme": "dark" if dark else "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw"}
        if phone:
            settings.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            settings.update(viewport=DESKTOP, device_scale_factor=1)
        context = self.browser.new_context(**{**settings, **options})
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def api(self, page: Page, method: str, path: str, body: dict | None = None, status: int = 200) -> dict:
        response = page.request.fetch(path, method=method, data=body, headers={"origin": ORIGIN, "idempotency-key": str(uuid.uuid4())})
        self.assertEqual(response.status, status, response.text())
        return response.json() if response.text() else {}

    def stored(self, page: Page) -> dict:
        return self.api(page, "GET", f"/api/v1/sketches/{self.ids['sketch']}")

    def project_work(self, page: Page) -> dict:
        return self.api(page, "GET", f"/api/v1/projects/{self.ids['project']}/work?limit=100")

    def unchanged(self, page: Page) -> None:
        self.assertEqual(self.stored(page), self.sketch_baseline, "the sketch is unchanged")
        self.assertEqual(self.project_work(page), self.work_baseline, "the work and its many-to-many links are unchanged")

    def open(self, page: Page, mode: str = "Map") -> None:
        page.goto(f"/projects/{self.ids['project']}/map/{self.ids['sketch']}")
        expect(page.locator(".sk-head")).to_contain_text("Sensing directions")
        page.get_by_role("radio", name=mode, exact=True).click()
        if mode == "Map":
            expect(page.locator(".sk-node")).to_have_count(5)
        else:
            expect(page.get_by_role("list", name="Thoughts in Sensing directions")).to_be_visible()

    def node(self, page: Page, key: str) -> Locator:
        return page.locator(f'.sk-node[data-id="{self.thoughts[key]}"]')

    def badge(self, page: Page, key: str) -> Locator:
        return page.locator(f'.sk-node[data-id="{self.thoughts[key]}"] + .sk-work-slot .sk-work')

    def row_badge(self, page: Page, key: str) -> Locator:
        return page.locator(f'.sk-outline-list > li[data-id="{self.thoughts[key]}"] .sk-work')

    def chooser(self, page: Page, text: str) -> Locator:
        return page.get_by_role("dialog", name=text, exact=True)

    def camera(self, page: Page) -> dict:
        return page.evaluate("""() => {
          const canvas = document.querySelector('.sk-canvas');
          const plane = document.querySelector('.sk-plane');
          return {
            left: canvas ? canvas.scrollLeft : null, top: canvas ? canvas.scrollTop : null,
            transform: plane ? plane.style.transform : null,
            zoom: document.querySelector('.sk-zoom__level')?.textContent ?? null,
            page: document.querySelector('.sk-page').scrollTop,
            selected: [...document.querySelectorAll('.sk-node[aria-pressed="true"], .sk-li-t[aria-pressed="true"]')].map((el) => el.dataset.id),
          };
        }""")

    def settle(self, page: Page, selector: str) -> None:
        """Wait until an element and its ancestors finished their enter motion."""
        page.wait_for_function("""selector => {
          const el = document.querySelector(selector); if (!el) return false;
          for (let n = el; n; n = n.parentElement) if (Number(getComputedStyle(n).opacity) !== 1) return false;
          return true;
        }""", arg=selector)

    def appearance(self, page: Page, theme: str, family: str) -> None:
        page.locator(".app").wait_for(state="visible")
        if not page.locator(".me__btn").is_visible():
            # The phone drawer's account row opens Settings, with the same choices (#266 PF-5).
            page.get_by_role("button", name="Open navigation").click()
            page.locator(".me__btn").click()
            pop = page.locator(".set")
            expect(pop.get_by_role("radiogroup", name="Appearance")).to_be_visible()
        else:
            page.locator(".me__btn").click()
            pop = page.get_by_role("dialog", name="Account", exact=True)
        pop.get_by_role("radio", name=theme, exact=True).click()
        pop.get_by_role("radio", name=family, exact=True).click()
        expect(pop.get_by_role("radio", name=family, exact=True)).to_have_attribute("aria-checked", "true")
        page.keyboard.press("Escape")
        if page.get_by_role("button", name="Close navigation").is_visible():
            page.get_by_role("button", name="Close navigation").click()
        if not page.url.endswith("/settings"):
            expect(pop).to_have_count(0)

    def expected_counts(self, page: Page) -> dict[str, int]:
        """Tasks per thought from the API's own links, many-to-many."""
        counts = {key: 0 for key in self.thoughts}
        by_id = {value: key for key, value in self.thoughts.items()}
        for item in self.project_work(page)["items"]:
            linked = {link["to"]["id"] for link in item["links"] if link["from"]["id"] == item["id"] and link["to"]["type"] == "thought"}
            for thought in linked:
                counts[by_id[thought]] += 1
        return counts

    # ---------------------------------------------------------------- journeys

    def test_01_counts_match_the_linked_tasks_on_the_canvas_and_in_the_list(self) -> None:
        page = self.page()
        type(self).sketch_baseline = self.stored(page)
        type(self).work_baseline = self.project_work(page)
        counts = self.expected_counts(page)
        self.assertEqual(counts, {"dark": 3, "camera": 1, "quiet": 0, "drafted": 1, "later": 0}, "0, 1 and several tasks; one task under two thoughts")
        texts = {"dark": DARK_ROOM, "camera": CAMERA, "quiet": QUIET, "drafted": DRAFTED, "later": LATER}
        self.open(page)
        for key, count in counts.items():
            if count:
                badge = self.badge(page, key)
                expect(badge).to_have_accessible_name(tasks_label(count, texts[key]))
                expect(badge).to_have_text(f"{count} {'task' if count == 1 else 'tasks'}")
                expect(badge).to_have_attribute("aria-expanded", "false")
                # The count sits inside its thought, below the text, not over a neighbour.
                node, at = self.node(page, key).bounding_box(), badge.bounding_box()
                text = self.node(page, key).locator(".sk-t").bounding_box()
                self.assertGreaterEqual(at["y"], text["y"] + text["height"], f"{key}: the count is under the thought's text")
                self.assertLessEqual(at["y"] + at["height"], node["y"] + node["height"], f"{key}: the count stays inside the thought")
                self.assertGreaterEqual(at["x"], node["x"])
            else:
                expect(self.badge(page, key)).to_have_count(0)
        expect(page.get_by_role("button", name=re.compile(r"linked to "))).to_have_count(3)
        # A display simplification: no task titles or results on the canvas.
        for title in (ORDER, CALIBRATE, PROTOCOL, DIFFUSER):
            expect(page.locator(".sk-canvas")).not_to_contain_text(title)
        shot(page, "map-task-count-canvas-1440-light")

        page.get_by_role("radio", name="List", exact=True).click()
        for key, count in counts.items():
            if count:
                expect(self.row_badge(page, key)).to_have_accessible_name(tasks_label(count, texts[key]))
                expect(self.row_badge(page, key)).to_have_text(f"{count} {'task' if count == 1 else 'tasks'}")
            else:
                expect(self.row_badge(page, key)).to_have_count(0)
        for title in (ORDER, CALIBRATE, PROTOCOL, DIFFUSER):
            expect(page.locator(".sk-outline-list")).not_to_contain_text(title)
        shot(page, "map-task-count-list-1440-light")
        self.unchanged(page)

    def test_01b_a_link_that_cannot_know_the_project_still_shows_the_counts(self) -> None:
        # Home's Map list, search, doc links and returns open a sketch at /map/:id; a project sketch
        # moves into its project's Map, where its thoughts show their tasks (#196 review).
        page = self.page()
        page.goto(f"/map/{self.ids['sketch']}")
        expect(page).to_have_url(re.compile(rf"/projects/{self.ids['project']}/map/{self.ids['sketch']}$"))
        expect(self.badge(page, "dark")).to_have_text("3 tasks")

    def test_02_the_chooser_lists_every_task_with_its_exact_id_status_and_people(self) -> None:
        page = self.page()
        self.open(page)
        self.badge(page, "dark").click()
        chooser = self.chooser(page, DARK_ROOM)
        expect(chooser).to_be_visible()
        expect(self.badge(page, "dark")).to_have_attribute("aria-expanded", "true")
        expect(chooser).to_contain_text("3 tasks linked to this thought")
        links = chooser.get_by_role("link")
        expect(links).to_have_count(3)
        expected = [
            ("order", ORDER, "In progress", "Owner Nia Okafor"),
            ("calibrate", CALIBRATE, "Blocked", "Owner Ada Lind"),
            ("protocol", PROTOCOL, "Open", "No owner yet"),
        ]
        for index, (key, title, status, owner) in enumerate(expected):
            link = links.nth(index)
            work_id = self.work[key]
            expect(link).to_contain_text(title)
            expect(link.locator(".sk-task__id")).to_have_text(f"#{self.numbers[key]}")
            expect(link).to_contain_text(f"#{self.numbers[key]} · {status}")
            expect(link).to_contain_text(f"{owner} · added by Ada Lind")
            expect(link).to_have_attribute("title", f"Task {work_id}")
            expect(link).to_have_attribute("data-work-id", work_id)
            expect(link).to_have_attribute("href", f"/projects/{self.ids['project']}/tasks?open=work:{work_id}")
            expect(link).to_have_accessible_name(re.compile(re.escape(title)))
        expect(chooser.get_by_role("list", name=f"Tasks linked to {quote(DARK_ROOM)}")).to_be_visible()
        shot(page, "map-task-count-chooser-1440-light")
        page.keyboard.press("Escape")
        expect(chooser).to_have_count(0)

        # The task from two thoughts is listed under the other one too.
        self.badge(page, "camera").click()
        camera = self.chooser(page, CAMERA)
        expect(camera.get_by_role("link")).to_have_count(1)
        expect(camera.get_by_role("link")).to_contain_text(CALIBRATE)
        expect(camera.get_by_role("link")).to_have_attribute("data-work-id", self.work["calibrate"])
        expect(camera).to_contain_text("1 task linked to this thought")
        page.keyboard.press("Escape")

        # The List opens the same chooser.
        page.get_by_role("radio", name="List", exact=True).click()
        self.row_badge(page, "drafted").click()
        drafted = self.chooser(page, DRAFTED)
        expect(drafted.get_by_role("link")).to_have_count(1)
        expect(drafted.get_by_role("link")).to_contain_text(f"#{self.numbers['diffuser']} · Done")
        expect(drafted.get_by_role("link")).to_contain_text("Owner Nia Okafor · added by Ada Lind")
        page.keyboard.press("Escape")
        expect(self.row_badge(page, "drafted")).to_be_focused()
        self.unchanged(page)

    def test_03_escape_and_close_return_to_the_same_camera_selection_and_count(self) -> None:
        page = self.page()
        self.open(page)
        self.node(page, "camera").click()
        expect(self.node(page, "camera")).to_have_attribute("aria-pressed", "true")
        page.get_by_role("button", name=re.compile(r"^Zoom \d+%, reset to 100%$")).click()
        page.get_by_role("button", name="Zoom in", exact=True).click()
        expect(page.locator(".sk-zoom__level")).to_have_text("110%")
        page.locator(".sk-canvas").evaluate("(el) => { el.scrollLeft = 300; el.scrollTop = 150; }")
        badge = self.badge(page, "dark")
        badge.focus()
        before = self.camera(page)
        self.assertEqual((before["left"], before["top"]), (300, 150), "a camera away from the origin")
        self.assertEqual(before["transform"], "scale(1.1)")
        self.assertEqual(before["selected"], [self.thoughts["camera"]])

        # Keyboard: Enter opens, focus moves in, Tab stays inside, Escape returns.
        page.keyboard.press("Enter")
        chooser = self.chooser(page, DARK_ROOM)
        expect(chooser).to_be_visible()
        expect(chooser).to_be_focused()
        for _ in range(6):
            page.keyboard.press("Tab")
            self.assertTrue(chooser.evaluate("(el) => el.contains(document.activeElement)"), "Tab stays in the chooser")
        page.keyboard.press("Escape")
        expect(chooser).to_have_count(0)
        expect(badge).to_be_focused()
        expect(badge).to_have_attribute("aria-expanded", "false")
        self.assertEqual(self.camera(page), before, "Escape keeps camera, zoom and selection")

        # Pointer: Close returns the same way.
        badge.click()
        expect(chooser).to_be_visible()
        self.assertEqual(self.camera(page), before, "opening moves nothing")
        chooser.get_by_role("button", name="Close", exact=True).click()
        expect(chooser).to_have_count(0)
        expect(badge).to_be_focused()
        self.assertEqual(self.camera(page), before, "Close keeps camera, zoom and selection")

        # Pressing the count again closes it; a click elsewhere closes it without stealing focus.
        badge.click()
        expect(chooser).to_be_visible()
        badge.click()
        expect(chooser).to_have_count(0)
        badge.click()
        expect(chooser).to_be_visible()
        page.get_by_role("radio", name="Map", exact=True).click()
        expect(chooser).to_have_count(0)
        self.assertEqual(self.camera(page), before)
        self.unchanged(page)

    def test_04_a_task_link_opens_that_task_in_its_project(self) -> None:
        page = self.page()
        self.open(page)
        page.locator(".sk-canvas").evaluate("(el) => { el.scrollLeft = 40; el.scrollTop = 20; }")
        self.badge(page, "dark").click()
        before = self.camera(page)
        path = page.evaluate("location.pathname")
        chooser = self.chooser(page, DARK_ROOM)
        href = chooser.get_by_role("link", name=re.compile(re.escape(ORDER))).get_attribute("href")
        chooser.get_by_role("link", name=re.compile(re.escape(CALIBRATE))).click()
        expect(chooser).to_have_count(0)
        expect(page.locator(".details__title")).to_have_text(CALIBRATE)
        self.assertEqual(page.evaluate("location.pathname"), path, "the task opens beside the map")
        self.assertEqual(self.camera(page), before, "opening a task keeps the camera and selection")
        shot(page, "map-task-count-open-task-1440-light")

        # The link itself is the task in its project: a new tab or a shared URL opens it there.
        tab = self.page()
        tab.goto(href)
        expect(tab).to_have_url(re.compile(rf"/projects/{self.ids['project']}/tasks"))
        expect(tab.locator(".details__title")).to_have_text(ORDER)
        self.unchanged(page)

    def test_05_a_reader_sees_the_counts_and_tasks_but_changes_nothing(self) -> None:
        page = self.page("kai")
        self.open(page)
        expect(page.get_by_role("toolbar", name="Sketch tools")).to_have_count(0)
        expect(page.locator(".sk-readonly")).to_be_visible()
        expect(self.badge(page, "dark")).to_have_accessible_name(tasks_label(3, DARK_ROOM))
        expect(self.badge(page, "drafted")).to_have_accessible_name(tasks_label(1, DRAFTED))
        # The private draft under a thought stays private; the count does not reveal it.
        expect(self.node(page, "drafted")).to_contain_text("Draft you can’t open")
        expect(page.locator("body")).not_to_contain_text(PRIVATE)
        self.badge(page, "drafted").click()
        chooser = self.chooser(page, DRAFTED)
        expect(chooser.get_by_role("link")).to_have_count(1)
        expect(chooser.get_by_role("link")).to_contain_text(DIFFUSER)
        expect(chooser).not_to_contain_text(PRIVATE)
        # Reading only: links to the tasks and Close, nothing that edits.
        expect(chooser.get_by_role("button")).to_have_count(1)
        expect(chooser.get_by_role("textbox")).to_have_count(0)
        page.keyboard.press("Escape")
        expect(self.badge(page, "drafted")).to_be_focused()
        # A drag or a key on the thought does not change it for a reader.
        node = self.node(page, "dark")
        box = node.bounding_box()
        page.mouse.move(box["x"] + 30, box["y"] + 20)
        page.mouse.down()
        page.mouse.move(box["x"] + 120, box["y"] + 90, steps=6)
        page.mouse.up()
        node.focus()
        for key in ("Enter", "Delete", "ArrowRight"):
            page.keyboard.press(key)
        expect(page.get_by_label("Thought text")).to_have_count(0)
        self.badge(page, "dark").click()
        self.chooser(page, DARK_ROOM).get_by_role("link", name=re.compile(re.escape(ORDER))).click()
        expect(page.locator(".details__title")).to_have_text(ORDER)
        page.get_by_role("radio", name="List", exact=True).click()
        expect(self.row_badge(page, "dark")).to_have_text("3 tasks")
        # Compared as the owner, who can also read the private placement.
        self.unchanged(self.page())

    def test_06_phone_390_sheet_without_horizontal_overflow(self) -> None:
        for scheme in ("light", "dark"):
            page = self.page(phone=True, dark=scheme == "dark")
            self.open(page)
            badge = self.badge(page, "dark")
            badge.scroll_into_view_if_needed()
            box = badge.bounding_box()
            self.assertGreaterEqual(box["height"], 24, "the count is a usable touch target")
            before = self.camera(page)
            badge.tap()
            sheet = self.chooser(page, DARK_ROOM)
            expect(sheet).to_be_visible()
            expect(sheet).to_have_attribute("aria-modal", "true")
            expect(sheet.get_by_role("link")).to_have_count(3)
            # The sheet slides up (shell overlay motion): measure where it comes to rest.
            page.evaluate("() => Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished))")
            sheet_box = sheet.bounding_box()
            self.assertGreaterEqual(sheet_box["x"], 0)
            self.assertLessEqual(sheet_box["x"] + sheet_box["width"], PHONE["width"], "the sheet fits the phone width")
            self.assertLessEqual(sheet_box["y"] + sheet_box["height"], PHONE["height"] + 1, "the sheet sits at the bottom")
            self.assertTrue(sheet.evaluate("(el) => el.scrollWidth <= el.clientWidth + 1"), "nothing in the sheet scrolls sideways")
            self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), PHONE["width"], "no horizontal page overflow")
            for link in sheet.get_by_role("link").all():
                link_box = link.bounding_box()
                self.assertLessEqual(link_box["x"] + link_box["width"], PHONE["width"], "every task fits")
                self.assertGreaterEqual(link_box["height"], 44, "each task is a 44px touch target")
            page.wait_for_timeout(400)
            shot(page, f"map-task-count-phone-390-{scheme}")
            sheet.get_by_role("button", name="Close", exact=True).tap()
            expect(sheet).to_have_count(0)
            expect(badge).to_be_focused()
            self.assertEqual(self.camera(page), before, "closing the sheet keeps the phone camera")

            page.get_by_role("radio", name="List", exact=True).tap()
            row = self.row_badge(page, "dark")
            expect(row).to_have_text("3 tasks")
            self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), PHONE["width"], "the List with counts fits too")
            row_box = row.bounding_box()
            self.assertGreaterEqual(row_box["height"], 44)
            row.tap()
            expect(self.chooser(page, DARK_ROOM)).to_be_visible()
            page.keyboard.press("Escape")
            expect(self.chooser(page, DARK_ROOM)).to_have_count(0)
            expect(row).to_be_focused()
            shot(page, f"map-task-count-phone-390-list-{scheme}")
        self.unchanged(page)

    def test_07_light_and_dark_contrast_for_every_accent(self) -> None:
        measurements = []

        def measure(page: Page, theme: str, family: str, selector: str, **spec) -> None:
            self.settle(page, selector)
            value = page.evaluate(MEASURE, {"selector": selector, **spec})
            value.update(theme=theme, family=family)
            measurements.append(value)
            self.assertGreaterEqual(value["ratio"], 4.5, value)

        for theme in ("Light", "Dark"):
            for family in FAMILIES:
                page = self.page()
                self.open(page)
                self.appearance(page, theme, family)
                # The count sits over its thought's own surface.
                node = f'.sk-node[data-id="{self.thoughts["dark"]}"]'
                measure(page, theme, family, f"{node} + .sk-work-slot .sk-work", backgroundSelector=node)
                self.badge(page, "dark").click()
                for selector in (".sk-tasks__k", ".sk-tasks__t", ".sk-task__t", ".sk-task__m", ".sk-task__id", ".sk-tasks__note"):
                    measure(page, theme, family, f".sk-tasks-pop {selector}")
                shot(page, f"map-task-count-{theme.lower()}-{family.lower()}-1440")
                page.keyboard.press("Escape")
                page.get_by_role("radio", name="List", exact=True).click()
                measure(page, theme, family, f'.sk-outline-list > li[data-id="{self.thoughts["dark"]}"] .sk-work')
        if SHOTS:
            (SHOTS / "map-task-count-contrast.json").write_text(json.dumps(measurements, indent=2) + "\n")

    def test_08_counts_follow_new_tasks_from_others_and_from_the_map(self) -> None:
        page = self.page()
        self.open(page)
        expect(self.badge(page, "quiet")).to_have_count(0)
        # Another person links a task to a thought while the map is open.
        nia = self.page("nia")
        created = self.api(nia, "POST", f"/api/v1/projects/{self.ids['project']}/work",
                           {"title": OCCUPANCY, "sources": [{"type": "thought", "id": self.thoughts["quiet"]}, {"type": "thought", "id": self.thoughts["dark"]}]}, status=201)
        expect(self.badge(page, "quiet")).to_have_accessible_name(tasks_label(1, QUIET))
        expect(self.badge(page, "dark")).to_have_accessible_name(tasks_label(4, DARK_ROOM))
        self.badge(page, "quiet").click()
        expect(self.chooser(page, QUIET).get_by_role("link")).to_contain_text(f"{task_number(created)} · Open")
        expect(self.chooser(page, QUIET).get_by_role("link")).to_contain_text("No owner yet · added by Nia Okafor")
        page.keyboard.press("Escape")
        # Create work on the map: the new task is counted at once.
        self.node(page, "later").click()
        page.get_by_role("toolbar", name="Sketch tools").get_by_role("button", name="Create work from selected thoughts").click()
        expect(page.locator(".details__title")).to_have_text(LATER)
        expect(self.badge(page, "later")).to_have_accessible_name(tasks_label(1, LATER))
        self.assertEqual(self.expected_counts(page), {"dark": 4, "camera": 1, "quiet": 1, "drafted": 1, "later": 1})
        self.assertEqual(self.stored(page)["thoughts"], self.sketch_baseline["thoughts"], "creating tasks never changes the thoughts")


if __name__ == "__main__":
    unittest.main()
