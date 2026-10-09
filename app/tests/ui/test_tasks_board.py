"""Browser tests for the Tasks board (issue #136, Studio 11.6 UI116-4).

Runs with the other tests/ui journeys through scripts/check_ui.sh against the running Compose
application. Three people and one agent share a project with open, in-progress, blocked, done and
not-pursued tasks that come from a message and a map thought. The tests cover the columns and
cards, dragging with drop feedback on the card list only, keyboard and menu moves, a refused
move that restores the stored state, the List, phone and tablet layouts, a reader without
changes, and contrast in Light and Dark. Every move is checked against the API.
"""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import Browser, BrowserContext, Locator, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder
from contrast import MEASURE

PASSWORD = "boards keep the work moving"
STAMP = int(time.time() * 1000)
ADA = {"name": "Ada Lind", "email": f"ada.board+{STAMP}@example.test"}
KAI = {"name": "Kai Berg", "email": f"kai.board+{STAMP}@example.test"}
NIA = {"name": "Nia Okafor", "email": f"nia.board+{STAMP}@example.test"}
TABLET = {"width": 820, "height": 1180}
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

MESSAGE = "If we agree on the ToF route, I can place the order with Mouser this afternoon."
THOUGHT = "Distance sensing that works in a dark bedroom"
ORDER = "Order two VL53L5CX ToF sensor boards"
CALIBRATE = "Calibrate the ToF sensor against the camera at 5 lux"
SOLDER = "Solder the sensor board into the second enclosure"
BLOCKER = "the sensor delivery from Mouser"
DIFFUSER = "Sketch a diffuser that keeps the electronics reachable"
MOUNT = "Mount a manual off switch in the lamp base"
FIRMWARE = "Flash the firmware with the long-range sensor mode"
PROTOCOL = "Write the low-light test protocol"
CAMERA = "Camera-only gesture control"
PETG = "Print a diffuser sample in white PETG"
SAMPLE = "Print three diffuser samples for the reading corner"
PROPOSAL = "Prefer the ToF sensor for the next prototype"
RULE = "Keep every sensor reading on the lamp itself"
RESULT = "The camera caught 38% of gestures at 5 lux"


class TasksBoardJourney(unittest.TestCase):
    """Tests run in name order and share three accounts, an agent and two projects."""

    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}
    numbers: dict[str, int] = {}

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

    # ---------------------------------------------------------------- helpers

    def context(self, who: str | None, *, viewport: dict | None = None, phone: bool = False, dark: bool = False, touch: bool = False, block_service_workers: bool = False) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "color_scheme": "dark" if dark else "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw",
                         "service_workers": "block" if block_service_workers else "allow"}
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=viewport or DESKTOP, device_scale_factor=1, has_touch=touch)
        if who and who in self.states:
            options["storage_state"] = self.states[who]
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        return context

    def page(self, who: str | None, **kwargs) -> Page:
        page = self.context(who, **kwargs).new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def api(self, page: Page, method: str, path: str, body: dict | None = None, status: int | None = None, headers: dict | None = None) -> dict:
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers={"origin": ORIGIN, "content-type": "application/json", **(headers or {})},
                                      data=json.dumps(body) if body is not None else None)
        if status is not None:
            self.assertEqual(response.status, status, response.text())
        return json.loads(response.text()) if response.text() else {}

    def task(self, page: Page, key: str) -> dict:
        return self.api(page, "GET", f"/api/v1/work/{self.ids[key]}", status=200)

    def board(self, who: str, project: str = "project", **kwargs) -> Page:
        page = self.page(who, **kwargs)
        page.goto(f"/projects/{self.ids[project]}/tasks")
        expect(page.locator(".tb-board")).to_be_visible()
        return page

    def column(self, page: Page, name: str) -> Locator:
        return page.get_by_role("region", name=name, exact=True)

    def card(self, scope: Page | Locator, title: str) -> Locator:
        return scope.locator(".tb-card").filter(has_text=title)

    def lift(self, page: Page, card: Locator) -> None:
        """Press on a card's quiet top line and move past the drag threshold."""
        box = card.bounding_box()
        assert box
        page.mouse.move(box["x"] + 24, box["y"] + 14)
        page.mouse.down()
        page.mouse.move(box["x"] + 40, box["y"] + 26, steps=4)

    def hover(self, page: Page, target: Locator, dy: float | None = None) -> None:
        box = target.bounding_box()
        assert box
        page.mouse.move(box["x"] + box["width"] / 2, box["y"] + (dy if dy is not None else min(box["height"] / 2, 40)), steps=8)

    def no_sideways_scroll(self, page: Page, width: int, label: str) -> None:
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), width, f"{label}: no sideways page scroll")
        self.assertTrue(page.locator(".pane-scroll").first.evaluate("(el) => el.scrollWidth <= el.clientWidth + 1"), f"{label}: nothing clipped sideways in the board")

    # ---------------------------------------------------------------- a realistic project

    def test_01_three_people_and_an_agent_share_a_project(self) -> None:
        for key, person in (("ada", ADA), ("kai", KAI), ("nia", NIA)):
            page = self.page(None)
            page.goto("/sign-up")
            page.get_by_label("Name").fill(person["name"])
            page.get_by_label("Email").fill(person["email"])
            page.get_by_label("Password").fill(PASSWORD)
            page.get_by_role("button", name="Create account").click()
            expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
            type(self).states[key] = page.context.storage_state()
            person["id"] = self.api(page, "GET", "/api/v1/me", status=200)["user"]["id"]
        ada = self.page("ada")
        kai = self.page("kai")
        ws = self.api(ada, "POST", "/api/v1/workspaces", {"name": "Riverside Makers"}, status=201)
        for person in (KAI, NIA):
            self.api(ada, "POST", f"/api/v1/workspaces/{ws['id']}/members", {"email": person["email"], "role": "member"}, status=201)
        project = self.api(ada, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Gesture lamp", "visibility": "restricted"}, status=201)
        pid = project["id"]
        self.api(ada, "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": KAI["id"]}, "role": "contributor"}, status=201)
        self.api(ada, "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": NIA["id"]}, "role": "viewer"}, status=201)
        agent = self.api(ada, "POST", f"/api/v1/workspaces/{ws['id']}/agents", {"name": "Codex", "owner": "self"}, status=201)
        self.api(ada, "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "agent", "id": agent["id"]}, "role": "contributor"}, status=201)
        thread = self.api(ada, "POST", f"/api/v1/projects/{pid}/conversations", {"body": "Should the lamp use a ToF sensor instead of the camera?", "clientMessageId": str(uuid.uuid4())}, status=201)
        message = self.api(kai, "POST", f"/api/v1/conversations/{thread['id']}/messages", {"body": MESSAGE, "clientMessageId": str(uuid.uuid4())}, status=201)
        sketch = self.api(ada, "POST", f"/api/v1/workspaces/{ws['id']}/sketches", {"title": "Sensing options", "scope": "project", "projectId": pid}, status=201, headers={"idempotency-key": str(uuid.uuid4())})
        thought = self.api(ada, "POST", f"/api/v1/sketches/{sketch['id']}/thoughts", {"text": THOUGHT, "x": 0, "y": 0}, status=201, headers={"idempotency-key": str(uuid.uuid4())})
        base = f"/api/v1/projects/{pid}/work"
        human = lambda person: {"kind": "human", "id": person["id"]}  # noqa: E731
        made = {
            "order": self.api(kai, "POST", base, {"title": ORDER, "owner": human(KAI), "sources": [{"type": "message", "id": message["id"]}]}, status=201),
            "calibrate": self.api(ada, "POST", base, {"title": CALIBRATE, "status": "in_progress", "owner": human(ADA), "sources": [{"type": "thought", "id": thought["thought"]["id"]}]}, status=201),
            "solder": self.api(ada, "POST", base, {"title": SOLDER, "status": "blocked", "blocker": BLOCKER, "owner": human(ADA)}, status=201),
            "diffuser": self.api(ada, "POST", base, {"title": DIFFUSER, "owner": {"kind": "agent", "id": agent["id"]}}, status=201),
            "mount": self.api(ada, "POST", base, {"title": MOUNT, "owner": human(ADA)}, status=201),
            "protocol": self.api(kai, "POST", base, {"title": PROTOCOL, "status": "done", "owner": human(KAI)}, status=201),
            "camera": self.api(ada, "POST", base, {"title": CAMERA, "status": "not_pursued"}, status=201),
        }
        made["firmware"] = self.api(kai, "POST", base, {"title": FIRMWARE, "owner": human(KAI), "dependencyIds": [made["order"]["id"]]}, status=201)
        self.api(kai, "POST", f"/api/v1/projects/{pid}/decisions", {"title": PROPOSAL, "rationale": "It works in the dark and stores no images."}, status=201)
        rule = self.api(ada, "POST", f"/api/v1/projects/{pid}/decisions", {"title": RULE, "rationale": "Nothing about a bedroom leaves the lamp."}, status=201)
        self.api(ada, "POST", f"/api/v1/decisions/{rule['id']}/accept", {"expectedVersion": 1}, status=200)
        self.api(kai, "POST", f"/api/v1/projects/{pid}/results", {"title": RESULT, "finding": "negative", "evidence": "20 gestures per light level"}, status=201)
        # A second project with one task and two empty columns.
        study = self.api(ada, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Diffuser study", "visibility": "restricted"}, status=201)
        made["sample"] = self.api(ada, "POST", f"/api/v1/projects/{study['id']}/work", {"title": SAMPLE, "owner": human(ADA)}, status=201)
        type(self).ids = {"workspace": ws["id"], "project": pid, "study": study["id"], "agent": agent["id"], "conversation": thread["id"],
                          "message": message["id"], "sketch": sketch["id"], "thought": thought["thought"]["id"],
                          **{key: item["id"] for key, item in made.items()}}
        type(self).numbers = {key: item["number"] for key, item in made.items()}

    # ---------------------------------------------------------------- columns and cards

    def test_02_columns_and_cards_show_the_stored_work(self) -> None:
        page = self.board("ada")
        expect(page.get_by_role("radio", name="Kanban", exact=True)).to_be_checked()
        self.assertNotIn("view=", page.url, "Kanban is the default and needs no URL parameter")
        open_, doing, done = (self.column(page, name) for name in ("Open", "In progress", "Done"))
        for column, titles in ((open_, (ORDER, DIFFUSER, MOUNT, FIRMWARE)), (doing, (SOLDER, CALIBRATE)), (done, (PROTOCOL, CAMERA))):
            expect(column.locator(".tb-card")).to_have_count(len(titles))
            for title in titles:
                expect(self.card(column, title)).to_be_visible()
        expect(open_.locator(".tb-col__n")).to_have_text(re.compile(r"^4"))
        # Done has no add button, yet its header rule and first card line up with the other columns.
        rules = [column.locator(".tb-col__head").evaluate("(el) => Math.round(el.getBoundingClientRect().bottom)") for column in (open_, doing, done)]
        self.assertEqual(len(set(rules)), 1, f"column headers end at one height: {rules}")
        # Blocked work leads its column, says so in words and names what it waits for.
        expect(doing.locator(".tb-col__head")).to_contain_text("1 blocked")
        expect(doing.locator(".tb-card").first).to_contain_text(SOLDER)
        blocked = self.card(doing, SOLDER)
        expect(blocked.locator(".tb-card__state")).to_have_text("Blocked")
        expect(blocked).to_contain_text(f"Waiting for {BLOCKER}")
        # The ID, the title, where it came from, the owner and the agent that owns a task.
        order = self.card(open_, ORDER)
        # A task is named by its number in the project, "#12" (#276); the id stays in the tooltip.
        self.assertEqual(self.numbers["order"], 1, "the project's first task is #1")
        expect(order.locator(".tb-card__id")).to_have_text("Task #1")
        number = order.locator(".ui-task-number")
        self.assertIn("monospace", number.evaluate("node => getComputedStyle(node).fontFamily"))
        self.assertGreaterEqual(number.evaluate("node => parseFloat(getComputedStyle(node).fontSize)"), 12)
        expect(order.locator(".tb-card__id")).to_have_attribute("title", f"Task #1 · {self.ids['order']}")
        expect(self.card(doing, SOLDER).locator(".tb-card__id")).to_have_text(f"Task #{self.numbers['solder']}")
        expect(order.get_by_role("button", name=ORDER, exact=True)).to_be_visible()
        source = order.get_by_role("link", name=re.compile("^From a message: If we agree on the ToF route"))
        expect(source).to_have_attribute("href", f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}#message-{self.ids['message']}")
        expect(order.locator(".tb-card__owner")).to_contain_text("Kai Berg")
        expect(self.card(doing, CALIBRATE).get_by_role("link", name=f"From a thought: {THOUGHT}")).to_have_attribute(
            "href", f"/projects/{self.ids['project']}/map/{self.ids['sketch']}#thought-{self.ids['thought']}")
        expect(self.card(doing, CALIBRATE).locator(".tb-card__owner")).to_contain_text("Ada Lind · you")
        owner = self.card(open_, DIFFUSER).locator(".tb-card__owner")
        expect(owner.locator(".tb-card__name")).to_have_text("Codex")
        expect(owner.locator(":scope > .kreska")).to_have_count(1)  # an agent is Kreska, never initials (#339)
        expect(owner.locator(".agent-tag")).to_have_text("Agent")
        expect(self.card(open_, FIRMWARE)).to_contain_text("Waits for 1")
        expect(self.card(done, CAMERA).locator(".tb-card__state")).to_have_text("Not pursued")
        # Decisions and results stay one step away, and a decision that needs you is named.
        expect(page.get_by_role("button", name="Decisions & results")).to_be_visible()
        expect(page.get_by_role("navigation", name="Also in the List")).to_contain_text("1 decision needs you")
        self.no_sideways_scroll(page, DESKTOP["width"], "desktop")
        shot(page, "tasks-board-1440-light")

        # A card opens its existing details.
        order.get_by_role("button", name=ORDER, exact=True).click()
        expect(page.locator("#details").get_by_role("heading", name=ORDER)).to_be_visible()
        expect(page.locator("#details").get_by_label("Status")).to_have_value("open")
        page.keyboard.press("Escape")

        # Mine and the search narrow the board; the URL keeps Mine.
        mine = page.get_by_role("button", name="Mine", exact=True)
        mine.click()
        expect(mine).to_have_attribute("aria-pressed", "true")
        self.assertIn("show=mine", page.url)
        expect(self.card(page, ORDER)).to_have_count(0)
        for title in (CALIBRATE, SOLDER, MOUNT):
            expect(self.card(page, title)).to_be_visible()
        mine.click()
        expect(self.card(page, ORDER)).to_be_visible()
        search = page.get_by_label("Search tasks")
        search.fill("solder")
        expect(page.locator(".tb-card")).to_have_count(1)
        expect(open_).to_contain_text("Nothing here matches.")
        # "#n" finds exactly that task; a number no task has finds none (#276).
        search.fill(f"#{self.numbers['solder']}")
        expect(page.locator(".tb-card")).to_have_count(1)
        expect(self.card(page, SOLDER)).to_be_visible()
        search.fill("#99")
        expect(page.locator(".tb-card")).to_have_count(0)
        search.press("Escape")
        expect(search).to_have_value("")
        expect(page.locator(".tb-card")).to_have_count(8)

    # ---------------------------------------------------------------- drag feedback

    def test_03_drag_feedback_lights_only_the_card_list_and_clears(self) -> None:
        page = self.board("ada")
        patches: list[str] = []
        page.on("request", lambda request: patches.append(request.url) if request.method == "PATCH" else None)
        open_, doing, done = (self.column(page, name) for name in ("Open", "In progress", "Done"))
        head = doing.locator(".tb-col__head")
        neutral = head.evaluate("(el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el.querySelector('h2')).color, getComputedStyle(el.querySelector('.tb-col__n')).color]")
        order = self.card(open_, ORDER)
        self.lift(page, order)
        expect(page.locator(".tb-ghost")).to_be_visible()
        expect(order).to_have_class(re.compile("is-dragging"))
        # Over another column's cards, only that card list lights up.
        self.hover(page, doing.locator(".tb-col__cards"))
        expect(page.locator(".is-over")).to_have_count(1)
        expect(doing.locator(".tb-col__cards")).to_have_class(re.compile("is-over"))
        self.assertEqual(head.evaluate("(el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el.querySelector('h2')).color, getComputedStyle(el.querySelector('.tb-col__n')).color]"), neutral,
                         "the header, title and count stay neutral")
        self.assertEqual(doing.evaluate("(el) => getComputedStyle(el).backgroundColor"), "rgba(0, 0, 0, 0)", "the column itself is not highlighted")
        # The card under the pointer is not lit as if it were the target: only its card list is.
        under = doing.locator(".tb-card:hover")
        if under.count():
            self.assertEqual(under.first.evaluate("(el) => getComputedStyle(el).borderColor"),
                             done.locator(".tb-card").first.evaluate("(el) => getComputedStyle(el).borderColor"), "no card hover while dragging")
        shot(page, "tasks-board-1440-drag")
        # The header is still a drop target: over it, the same card list stays lit.
        self.hover(page, head, dy=10)
        expect(doing.locator(".tb-col__cards")).to_have_class(re.compile("is-over"))
        expect(page.locator(".is-over")).to_have_count(1)
        # Leaving every column clears the feedback; its own column never lights up.
        self.hover(page, page.locator(".tb-bar"))
        expect(page.locator(".is-over")).to_have_count(0)
        self.hover(page, open_.locator(".tb-col__cards"))
        expect(page.locator(".is-over")).to_have_count(0)
        self.hover(page, done.locator(".tb-col__cards"))
        expect(done.locator(".tb-col__cards")).to_have_class(re.compile("is-over"))
        # Escape cancels: no feedback, no ghost, and releasing afterwards moves nothing.
        page.keyboard.press("Escape")
        expect(page.locator(".is-over")).to_have_count(0)
        expect(page.locator(".tb-ghost")).to_have_count(0)
        expect(order).not_to_have_class(re.compile("is-dragging"))
        page.mouse.up()
        expect(page.locator("#details").get_by_role("heading", name=ORDER)).to_have_count(0)
        # A drop outside every column does nothing either.
        self.lift(page, order)
        self.hover(page, page.locator(".tb-bar"))
        page.mouse.up()
        expect(page.locator(".tb-ghost")).to_have_count(0)
        expect(page.locator(".is-over")).to_have_count(0)
        page.wait_for_timeout(600)
        self.assertEqual(patches, [], "cancelled and outside drops send no change")
        expect(self.card(open_, ORDER)).to_be_visible()
        self.assertEqual(self.task(page, "order")["status"], "open")

    # ---------------------------------------------------------------- drag and drop persists

    def test_04_a_drop_on_the_header_or_an_empty_column_persists(self) -> None:
        page = self.board("ada")
        doing = self.column(page, "In progress")
        self.lift(page, self.card(self.column(page, "Open"), ORDER))
        self.hover(page, doing.locator(".tb-col__head"), dy=10)
        with page.expect_response(lambda response: response.request.method == "PATCH" and response.url.endswith(f"/api/v1/work/{self.ids['order']}")) as moved:
            page.mouse.up()
        response = moved.value
        self.assertEqual(response.status, 200, response.text())
        command = json.loads(response.request.post_data or "{}")
        self.assertEqual(command["status"], "in_progress")
        self.assertRegex(command["clientCommandId"], UUID, "the existing command carries a stable command id")
        self.assertEqual(response.request.all_headers().get("if-match"), '"1"', "the move names the version it saw")
        expect(self.card(doing, ORDER)).to_be_visible()
        expect(page.locator(".tb-note--ok")).to_contain_text(f"Moved “{ORDER}” to In progress.")
        self.assertEqual(self.task(page, "order")["status"], "in_progress")
        page.reload()
        expect(self.card(self.column(page, "In progress"), ORDER)).to_be_visible()
        expect(self.card(self.column(page, "Open"), ORDER)).to_have_count(0)

        # Empty columns still have a usable target.
        study = self.board("ada", "study")
        target = self.column(study, "In progress").locator(".tb-col__cards")
        expect(target).to_contain_text("Nothing here yet.")
        box = target.bounding_box()
        assert box
        self.assertGreaterEqual(box["height"], 120, "an empty column keeps a real drop area")
        self.lift(study, self.card(study, SAMPLE))
        self.hover(study, target)
        expect(target).to_have_class(re.compile("is-over"))
        study.mouse.up()
        expect(self.card(self.column(study, "In progress"), SAMPLE)).to_be_visible()
        # The card moves at once; the stored state is read once the move is confirmed.
        expect(study.locator(".tb-note--ok")).to_contain_text(f"Moved “{SAMPLE}” to In progress.")
        self.assertEqual(self.task(study, "sample")["status"], "in_progress")

    # ---------------------------------------------------------------- keyboard

    def test_05_keyboard_picks_up_chooses_and_drops(self) -> None:
        page = self.board("ada")
        open_, doing, done = (self.column(page, name) for name in ("Open", "In progress", "Done"))
        spoken = page.locator(".tb-wrap > p[aria-live]")
        mount = self.card(open_, MOUNT)
        button = mount.get_by_role("button", name=MOUNT, exact=True)
        expect(button).to_have_accessible_description(re.compile("Space picks the task up"))
        button.focus()
        page.keyboard.press("Space")
        expect(mount).to_have_class(re.compile("is-lifted"))
        expect(spoken).to_contain_text(f"Picked up “{MOUNT}” in Open.")
        page.keyboard.press("ArrowRight")
        expect(doing.locator(".tb-col__cards")).to_have_class(re.compile("is-over"))
        page.keyboard.press("ArrowRight")
        expect(done.locator(".tb-col__cards")).to_have_class(re.compile("is-over"))
        expect(page.locator(".is-over")).to_have_count(1)
        page.keyboard.press("ArrowLeft")
        expect(doing.locator(".tb-col__cards")).to_have_class(re.compile("is-over"))
        # The destination and the keys are on screen too, not only announced (visual review of #194).
        expect(page.locator(".tb-note--moving")).to_contain_text(f"Moving “{MOUNT}” to In progress")
        expect(page.locator(".tb-note--moving")).to_contain_text("Enter or Space drops it")
        shot(page, "tasks-board-1440-keyboard")
        # Escape cancels without a change.
        page.keyboard.press("Escape")
        expect(page.locator(".is-over")).to_have_count(0)
        expect(page.locator(".tb-note--moving")).to_have_count(0)
        expect(mount).not_to_have_class(re.compile("is-lifted"))
        expect(spoken).to_contain_text("Cancelled.")
        self.assertEqual(self.task(page, "mount")["status"], "open")
        # Space, Right, Space moves it; focus stays on the card and Details stays closed.
        page.keyboard.press("Space")
        page.keyboard.press("ArrowRight")
        page.keyboard.press("Space")
        moved = self.card(doing, MOUNT)
        expect(moved).to_be_visible()
        expect(moved.get_by_role("button", name=MOUNT, exact=True)).to_be_focused()
        expect(page.locator("#details").get_by_role("heading", name=MOUNT)).to_have_count(0)
        expect(page.locator(".tb-note--ok")).to_contain_text(f"Moved “{MOUNT}” to In progress.")
        self.assertEqual(self.task(page, "mount")["status"], "in_progress")
        # Enter still opens the card.
        page.keyboard.press("Enter")
        expect(page.locator("#details").get_by_role("heading", name=MOUNT)).to_be_visible()

    # ---------------------------------------------------------------- "Move to…" menu

    def test_06_move_to_menu_by_pointer_and_keyboard(self) -> None:
        page = self.board("ada")
        doing, done = self.column(page, "In progress"), self.column(page, "Done")
        # Keyboard: the menu opens on the first other column, and Escape returns to its button.
        mount = self.card(doing, MOUNT)
        trigger = mount.get_by_role("button", name="Move to…")
        trigger.focus()
        page.keyboard.press("Enter")
        menu = page.get_by_role("menu", name=f"Move “{MOUNT}”")
        expect(menu).to_be_visible()
        expect(menu.get_by_role("menuitemradio", name="In progress")).to_have_attribute("aria-checked", "true")
        expect(menu.get_by_role("menuitemradio", name="Open")).to_be_focused()
        page.keyboard.press("ArrowDown")
        expect(menu.get_by_role("menuitemradio", name="In progress")).to_be_focused()
        page.keyboard.press("Escape")
        expect(menu).to_have_count(0)
        expect(trigger).to_be_focused()
        self.assertEqual(self.task(page, "mount")["status"], "in_progress")
        # Pointer: choose Done.
        calibrate = self.card(doing, CALIBRATE)
        calibrate.get_by_role("button", name="Move to…").click()
        menu = page.get_by_role("menu", name=f"Move “{CALIBRATE}”")
        expect(menu.get_by_role("menuitem", name="Open details")).to_be_visible()
        shot(page, "tasks-board-1440-menu")
        menu.get_by_role("menuitemradio", name="Done").click()
        expect(menu).to_have_count(0)
        expect(self.card(done, CALIBRATE)).to_be_visible()
        expect(page.locator(".tb-note--ok")).to_contain_text(f"Moved “{CALIBRATE}” to Done.")
        self.assertEqual(self.task(page, "calibrate")["status"], "done")
        page.reload()
        expect(self.card(self.column(page, "Done"), CALIBRATE)).to_be_visible()

    # ---------------------------------------------------------------- refused moves

    def test_07_a_refused_move_restores_the_stored_state(self) -> None:
        page = self.board("ada")
        open_, doing = self.column(page, "Open"), self.column(page, "In progress")
        expect(self.card(open_, DIFFUSER)).to_be_visible()
        # Kai changes the task meanwhile; Ada's board still shows the earlier version.
        kai = self.page("kai")
        before = self.task(kai, "diffuser")
        self.api(kai, "PATCH", f"/api/v1/work/{self.ids['diffuser']}", {"status": "in_progress", "clientCommandId": str(uuid.uuid4())}, status=200,
                 headers={"if-match": f'"{before["version"]}"'})
        expect(self.card(open_, DIFFUSER)).to_be_visible()
        self.card(open_, DIFFUSER).get_by_role("button", name="Move to…").click()
        with page.expect_response(lambda response: response.request.method == "PATCH" and response.url.endswith(f"/api/v1/work/{self.ids['diffuser']}")) as refused:
            page.get_by_role("menu").get_by_role("menuitemradio", name="Done").click()
        self.assertEqual(refused.value.status, 409)
        alert = page.get_by_role("alert").filter(has_text=DIFFUSER)
        expect(alert).to_contain_text("was changed by someone else a moment ago, so it was not moved")
        # The true, stored state: in progress, as Kai left it, and not done.
        expect(self.card(doing, DIFFUSER)).to_be_visible()
        expect(self.card(self.column(page, "Done"), DIFFUSER)).to_have_count(0)
        self.assertEqual(self.task(page, "diffuser")["status"], "in_progress")
        shot(page, "tasks-board-1440-refused")
        alert.get_by_role("button", name="Dismiss").click()
        expect(page.get_by_role("alert").filter(has_text=DIFFUSER)).to_have_count(0)
        # A task waiting for an unfinished prerequisite cannot start; it stays where it is.
        firmware = self.card(open_, FIRMWARE)
        firmware.get_by_role("button", name=FIRMWARE, exact=True).focus()
        page.keyboard.press("Space")
        page.keyboard.press("ArrowRight")
        page.keyboard.press("Space")
        expect(page.get_by_role("alert").filter(has_text=FIRMWARE)).to_contain_text("it can start or finish only when every task it waits for is done")
        expect(self.card(open_, FIRMWARE)).to_be_visible()
        expect(self.card(open_, FIRMWARE).get_by_role("button", name=FIRMWARE, exact=True)).to_be_focused()
        self.assertEqual(self.task(page, "firmware")["status"], "open")

    # ---------------------------------------------------------------- List

    def test_08_the_list_stays_and_is_remembered_per_person(self) -> None:
        page = self.board("ada")
        page.get_by_role("radio", name="List", exact=True).click()
        views = page.get_by_role("navigation", name="Task views")
        expect(views.get_by_role("button", name="All", exact=True)).to_have_attribute("aria-pressed", "true")
        expect(page.get_by_role("region", name=re.compile("^Blocked"))).to_contain_text(SOLDER)
        expect(page.get_by_role("region", name=re.compile("^Needs you"))).to_contain_text(PROPOSAL)
        expect(page.get_by_role("region", name=re.compile("^Finished"))).to_contain_text(CALIBRATE)
        self.assertEqual(page.evaluate(f"localStorage.getItem('flux.tasks.mode.{ADA['id']}')"), "list")
        self.assertNotIn("view=", page.url)
        page.reload()
        expect(page.get_by_role("radio", name="List", exact=True)).to_be_checked()
        expect(page.get_by_role("navigation", name="Task views")).to_be_visible()
        # The List's own field still adds a task through the existing flow.
        page.get_by_label("New task", exact=True).fill(PETG)
        page.get_by_role("button", name="Add task", exact=True).click()
        expect(page.locator("#details").get_by_role("heading", name=PETG)).to_be_visible()
        page.keyboard.press("Escape")
        expect(page.get_by_role("region", name=re.compile("^Open"))).to_contain_text(PETG)
        shot(page, "tasks-board-1440-list")
        # Back to Kanban, which is remembered too.
        page.get_by_role("radio", name="Kanban", exact=True).click()
        expect(self.card(self.column(page, "Open"), PETG)).to_be_visible()
        page.reload()
        expect(page.get_by_role("radio", name="Kanban", exact=True)).to_be_checked()
        self.assertEqual(page.evaluate(f"localStorage.getItem('flux.tasks.mode.{ADA['id']}')"), "board")
        # "Decisions & results" opens the whole List at the decisions without changing the choice.
        page.get_by_role("button", name="Decisions & results").click()
        expect(page.get_by_role("radio", name="List", exact=True)).to_be_checked()
        expect(page.get_by_role("region", name=re.compile("^Needs you"))).to_contain_text(PROPOSAL)
        expect(page.get_by_role("region", name=re.compile("^Decisions"))).to_contain_text(RULE)
        expect(page.get_by_role("region", name=re.compile("^Results"))).to_contain_text(RESULT)
        self.assertIn("view=list", page.url)
        self.assertEqual(page.evaluate(f"localStorage.getItem('flux.tasks.mode.{ADA['id']}')"), "board")
        # A link to one List view opens the List.
        page.goto(f"/projects/{self.ids['project']}/tasks?status=blocked")
        expect(page.get_by_role("navigation", name="Task views").get_by_role("button", name=re.compile("^Blocked"))).to_have_attribute("aria-pressed", "true")
        expect(page.get_by_role("region", name=re.compile("^Blocked"))).to_contain_text(SOLDER)
        # Another person's choice is their own.
        kai = self.board("kai")
        expect(kai.get_by_role("radio", name="Kanban", exact=True)).to_be_checked()

    # ---------------------------------------------------------------- phone

    def test_09_phone_shows_a_status_overview_and_moves_by_menu(self) -> None:
        page = self.board("kai", phone=True, dark=True)
        overview = page.get_by_role("navigation", name="Task status")
        expect(overview).to_be_visible()
        doing = overview.get_by_role("button", name=re.compile("^In progress"))
        expect(doing).to_have_attribute("aria-pressed", "true")
        expect(doing).to_contain_text("1 blocked")
        expect(overview.get_by_role("button", name=re.compile("^Open"))).to_contain_text("2")
        expect(overview.get_by_role("button", name=re.compile("^Done"))).to_contain_text("3")
        # One readable column at a time instead of a clipped neighbour.
        expect(self.column(page, "In progress")).to_be_visible()
        expect(self.column(page, "Open")).to_have_count(0)
        expect(self.column(page, "Done")).to_have_count(0)
        expect(self.column(page, "In progress").locator(".tb-card").first).to_contain_text(SOLDER)
        number = self.card(page, SOLDER).locator(".ui-task-number")
        expect(number).to_have_text(f"#{self.numbers['solder']}")
        self.assertGreaterEqual(number.evaluate("node => parseFloat(getComputedStyle(node).fontSize)"), 12.5, "F-026 phone metadata remains readable")
        column = self.column(page, "In progress").bounding_box()
        assert column
        self.assertLessEqual(column["x"] + column["width"], PHONE["width"], "the column fits the phone")
        self.no_sideways_scroll(page, PHONE["width"], "phone")
        # #341: the phone's one "+" is the floating Create; the board has no second one.
        expect(page.get_by_role("button", name="New Task", exact=True)).to_have_count(0)
        expect(page.get_by_role("button", name="New task in In progress")).to_have_count(0)
        for control in (*overview.get_by_role("button").all(), page.get_by_role("radio", name="List", exact=True),
                        page.get_by_role("button", name="Mine", exact=True),
                        self.card(page, SOLDER).get_by_role("button", name="Move to…")):
            box = control.bounding_box()
            assert box
            self.assertGreaterEqual(box["height"], 44, "touch target")
        shot(page, "tasks-board-390-dark")
        overview.get_by_role("button", name=re.compile("^Open")).tap()
        open_ = self.column(page, "Open")
        expect(open_).to_be_visible()
        expect(self.column(page, "In progress")).to_have_count(0)
        self.card(open_, PETG).get_by_role("button", name="Move to…").tap()
        page.get_by_role("menu").get_by_role("menuitemradio", name="Done").tap()
        expect(self.card(open_, PETG)).to_have_count(0)
        # The visible column follows the card, and focus stays on it (#194 review B1).
        done = self.column(page, "Done")
        expect(done).to_be_visible()
        expect(overview.get_by_role("button", name=re.compile("^Done"))).to_have_attribute("aria-pressed", "true")
        expect(self.card(done, PETG).locator(".tb-card__open")).to_be_focused()
        expect(page.locator(".tb-note--ok")).to_contain_text(f"Moved “{PETG}” to Done.")
        expect(overview.get_by_role("button", name=re.compile("^Done"))).to_contain_text("4")
        self.assertEqual(next(item for item in self.api(page, "GET", f"/api/v1/projects/{self.ids['project']}/work?limit=100", status=200)["items"] if item["title"] == PETG)["status"], "done")
        self.no_sideways_scroll(page, PHONE["width"], "phone after a move")
        light = self.board("kai", phone=True)
        expect(light.get_by_role("navigation", name="Task status")).to_be_visible()
        shot(light, "tasks-board-390-light")

    # ---------------------------------------------------------------- tablet and laptop

    def test_10_tablet_and_laptop_use_their_width(self) -> None:
        page = self.board("ada", viewport=TABLET, touch=True)
        expect(page.get_by_role("navigation", name="Task status")).to_be_visible()
        doing = self.column(page, "In progress")
        expect(doing.locator(".tb-card")).to_have_count(4)
        first, second = doing.locator(".tb-card").nth(0).bounding_box(), doing.locator(".tb-card").nth(1).bounding_box()
        assert first and second
        self.assertLess(abs(first["y"] - second["y"]), 2, "the wider column shows two cards side by side")
        self.assertGreater(second["x"], first["x"] + first["width"] - 1)
        self.no_sideways_scroll(page, TABLET["width"], "tablet")
        shot(page, "tasks-board-820-light")
        laptop = self.board("ada", viewport={"width": 1024, "height": 768})
        expect(laptop.get_by_role("navigation", name="Task status")).to_be_hidden()
        for name in ("Open", "In progress", "Done"):
            expect(self.column(laptop, name)).to_be_visible()
        self.no_sideways_scroll(laptop, 1024, "laptop")
        shot(laptop, "tasks-board-1024-light")

    # ---------------------------------------------------------------- a reader

    def test_11_a_reader_sees_the_board_without_changing_it(self) -> None:
        page = self.board("nia")
        patches: list[str] = []
        page.on("request", lambda request: patches.append(request.url) if request.method == "PATCH" else None)
        expect(self.card(self.column(page, "In progress"), SOLDER)).to_be_visible()
        expect(page.get_by_role("button", name="New Task")).to_have_count(0)
        expect(page.get_by_role("button", name="Move to…")).to_have_count(0)
        expect(page.get_by_role("button", name=re.compile("^New task in"))).to_have_count(0)
        solder = self.card(page, SOLDER)
        solder.get_by_role("button", name=SOLDER, exact=True).focus()
        page.keyboard.press("Space")
        expect(solder).not_to_have_class(re.compile("is-lifted"))
        page.keyboard.press("Escape")
        self.lift(page, solder)
        self.hover(page, self.column(page, "Done").locator(".tb-col__cards"))
        expect(page.locator(".tb-ghost")).to_have_count(0)
        expect(page.locator(".is-over")).to_have_count(0)
        page.mouse.up()
        page.wait_for_timeout(400)
        self.assertEqual(patches, [])
        shot(page, "tasks-board-1440-reader")

    # ---------------------------------------------------------------- contrast

    def test_12_light_and_dark_keep_readable_contrast(self) -> None:
        measured: list[dict] = []
        for theme in ("Light", "Dark"):
            with self.subTest(theme=theme):
                context = self.context("ada")
                context.add_init_script(f"localStorage.setItem('flux.theme', '{theme.lower()}')")
                page = context.new_page()
                page.goto(f"/projects/{self.ids['project']}/tasks")
                expect(page.locator("html")).to_have_attribute("data-theme", theme.lower())
                expect(page.locator(".tb-card").first).to_be_visible()
                # Since #155 a card's source line comes from its own bounded read, after the cards.
                expect(page.locator(".tb-card__from").first).to_be_visible()
                page.wait_for_timeout(250)
                for selector, minimum, spec in (
                    (".tb-card__id", 4.5, {}), (".tb-card__title", 4.5, {}), (".tb-card__from", 4.5, {}), (".tb-card__kind", 4.5, {}),
                    (".tb-card__state--blocked", 4.5, {}), (".tb-card__blocker", 4.5, {}), (".tb-col__n", 4.5, {}), (".tb-col__b", 4.5, {}),
                    (".tb-col__h", 4.5, {}), ('.tb-mode__b[aria-checked="true"]', 4.5, {}), ('.tb-mode__b[aria-checked="false"]', 4.5, {}),
                    (".tb-dr", 4.5, {}), (".tb-mine", 4.5, {}), (".tb-also__b--need", 4.5, {}), (".tb-search input", 4.5, {"pseudo": "::placeholder"}),
                    (".tb-col__head .tb-ring--in_progress", 3, {"property": "borderTopColor"}), (".tb-search", 3, {"property": "color"}),
                ):
                    value = page.evaluate(MEASURE, {"selector": selector, **spec})
                    value.update(theme=theme, minimum=minimum)
                    measured.append(value)
                    self.assertGreaterEqual(value["ratio"], minimum, value)
                shot(page, f"tasks-board-1440-{theme.lower()}")
        self.assertEqual(len(measured), 2 * 17)

    def test_13_delayed_native_columns_say_which_tasks_are_loading(self) -> None:
        for phone in (False, True):
            with self.subTest(phone=phone):
                # The request hold must reach the actual API; a controlling service worker can
                # bypass page.route. PWA behavior is covered separately.
                page = self.page("ada", phone=phone, block_service_workers=True)
                held = []
                def hold(route):
                    query = parse_qs(urlsplit(route.request.url).query)
                    if query.get("purpose") == ["tasks"] and query.get("group", [""])[0] in ("open", "in_progress", "blocked", "finished"):
                        response = route.fetch()
                        self.assertEqual(response.status, 200)
                        held.append((route, response))
                        page.evaluate("count => window.loadingTaskReadsHeld = count", len(held))
                    else:
                        route.continue_()
                page.route(f"**/api/v1/projects/{self.ids['project']}/work-view?**", hold)
                self.addCleanup(lambda page=page: page.unroute_all(behavior="ignoreErrors"))
                page.goto(f"/projects/{self.ids['project']}/tasks?view=board")
                for column in ("Open", "In progress", "Done"):
                    if phone:
                        page.locator(".tb-ov").filter(has_text=column).click()
                    label = self.column(page, column).locator(".tb-col__empty")
                    expect(label).to_have_text(f"Loading {column.lower()} tasks…")
                    expect(label).to_be_visible()
                    self.assertEqual(label.evaluate("e => e.tagName"), "P")
                    expect(label).to_have_attribute("class", "tb-col__empty")
                page.wait_for_function("window.loadingTaskReadsHeld >= 4")
                self.assertGreaterEqual(len(held), 4, "each real native status read waits")
                shot(page, f"323-board-loading-{'phone' if phone else 'desktop'}")
                for route, response in held:
                    route.fulfill(response=response)
                page.unroute_all(behavior="wait")
                expect(page.locator(".tb")).to_have_attribute("data-work-observed-at", re.compile(r".+"))
                expect(page.locator(".tb-col__empty").filter(has_text=re.compile("^Loading"))).to_have_count(0)
                self.assertGreater(page.locator(".tb-card").count(), 0, "the stored task cards appear after their responses arrive")


if __name__ == "__main__":
    unittest.main()
