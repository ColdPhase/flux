"""Browser tests for the final Tasks design (issue #346, F-026 S-D-Tasks, S-P-Tasks, S9).

Runs with the other tests/ui journeys through scripts/check_ui.sh against the running Compose
application. One project with open, in-progress, blocked and done tasks owned by two people and an
agent. The tests cover what the renders show at 1440x900 and 390x844 in light and dark (state as
glyph plus word, #number, title, owner as a 20 px avatar or Kreska, inverted Blocked pill, a phone
list with no toolbar), one tap on the glyph and the keys 1 to 5 changing the state, swipe left then
Done on the phone, a toast with Undo (button and key Z) that restores the previous state through the
API, and the board's drag and drop keyboard alternative with its announcement. Every change is
checked against the API.
"""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Locator, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder
from contrast import MEASURE

PASSWORD = "tasks stay easy to scan"
STAMP = int(time.time() * 1000)
ADA = {"name": "Ada Kowalska", "email": f"ada.final+{STAMP}@example.test"}
JONAS = {"name": "Jonas Berg", "email": f"jonas.final+{STAMP}@example.test"}

SUPPLIER = "Ask the supplier for the probe drawing"
SCHOOL = "Ask the school for two ESP32 kits"
LABELS = "Print a label for each of the six beds"
ENCLOSURE = "Design a weatherproof enclosure that volunteers can open without tools"
BLOCKER = "the probe dimensions from the supplier"
CALIBRATE = "Calibrate the probes at two soil depths"
LORA = "Measure LoRa range from the far east beds"
WORD = {"open": "Open", "in_progress": "In progress", "blocked": "Blocked", "done": "Done", "not_pursued": "Not pursued"}


class TasksFinalJourney(unittest.TestCase):
    """Tests run in name order and share two accounts, an agent and one project."""

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

    def context(self, who: str | None, *, phone: bool = False, dark: bool = False, reduced: bool = False) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "color_scheme": "dark" if dark else "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw",
                         "reduced_motion": "reduce" if reduced else "no-preference"}
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=DESKTOP, device_scale_factor=1)
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

    def tasks(self, who: str = "ada", *, phone: bool = False, dark: bool = False, reduced: bool = False) -> Page:
        page = self.page(who, phone=phone, dark=dark, reduced=reduced)
        page.goto(f"/projects/{self.ids['project']}/tasks")
        expect(page.locator(".tb-board, .ws-task").first).to_be_visible()
        return page

    def card(self, page: Page, title: str) -> Locator:
        return page.locator(".tb-card").filter(has_text=title)

    def row(self, page: Page, title: str) -> Locator:
        return page.locator(".ws-task").filter(has_text=title)

    def swipe_left(self, page: Page, target: Locator, distance: int = 150) -> None:
        """A real touch drag through the browser's input pipeline (Chromium)."""
        box = target.bounding_box()
        assert box
        x, y = box["x"] + box["width"] - 90, box["y"] + box["height"] / 2
        cdp = page.context.new_cdp_session(page)
        cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y}]})
        for step in range(1, 9):
            cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x - distance * step / 8, "y": y}]})
        cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})

    def wait_status(self, page: Page, key: str, status: str) -> None:
        deadline = time.time() + 8
        while time.time() < deadline and self.task(page, key)["status"] != status:
            page.wait_for_timeout(100)
        self.assertEqual(self.task(page, key)["status"], status)

    def set_status(self, page: Page, key: str, status: str) -> None:
        current = self.task(page, key)
        if current["status"] != status:
            self.api(page, "PATCH", f"/api/v1/work/{self.ids[key]}", {"status": status, "clientCommandId": str(uuid.uuid4())}, status=200,
                     headers={"if-match": f'"{current["version"]}"'})

    # ---------------------------------------------------------------- the data

    def test_01_a_project_with_every_kind_of_owner_and_state(self) -> None:
        for key, person in (("ada", ADA), ("jonas", JONAS)):
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
        ws = self.api(ada, "POST", "/api/v1/workspaces", {"name": "Garden makers"}, status=201)
        self.api(ada, "POST", f"/api/v1/workspaces/{ws['id']}/members", {"email": JONAS["email"], "role": "member"}, status=201)
        project = self.api(ada, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Community garden sensors", "visibility": "restricted"}, status=201)
        pid = project["id"]
        self.api(ada, "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": JONAS["id"]}, "role": "contributor"}, status=201)
        agent = self.api(ada, "POST", f"/api/v1/workspaces/{ws['id']}/agents", {"name": "Claude Code", "owner": "self"}, status=201)
        self.api(ada, "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "agent", "id": agent["id"]}, "role": "contributor"}, status=201)
        base = f"/api/v1/projects/{pid}/work"
        human = lambda person: {"kind": "human", "id": person["id"]}  # noqa: E731
        made = {
            "school": self.api(ada, "POST", base, {"title": SCHOOL, "owner": human(JONAS)}, status=201),
            "enclosure": self.api(ada, "POST", base, {"title": ENCLOSURE, "status": "blocked", "blocker": BLOCKER, "owner": human(ADA)}, status=201),
            "supplier": self.api(ada, "POST", base, {"title": SUPPLIER, "owner": human(ADA)}, status=201),
            "labels": self.api(ada, "POST", base, {"title": LABELS}, status=201),
            "calibrate": self.api(ada, "POST", base, {"title": CALIBRATE, "status": "in_progress", "owner": {"kind": "agent", "id": agent["id"]}}, status=201),
            "lora": self.api(ada, "POST", base, {"title": LORA, "status": "done", "owner": human(ADA)}, status=201),
        }
        type(self).ids = {"workspace": ws["id"], "project": pid, **{key: item["id"] for key, item in made.items()}}
        type(self).numbers = {key: item["number"] for key, item in made.items()}

    # ---------------------------------------------------------------- AC-1: as drawn

    def test_02_the_computer_board_is_drawn_in_light_and_dark(self) -> None:
        for dark in (False, True):
            with self.subTest(dark=dark):
                page = self.tasks(dark=dark)
                for name, status in (("Open", "open"), ("In progress", "in_progress"), ("Done", "done")):
                    column = page.get_by_role("region", name=name, exact=True)
                    expect(column.locator(".tb-col__head .ui-glyph--" + status)).to_have_count(1)
                    expect(column.locator(".tb-col__h")).to_have_text(name)
                # Number, title, owner; "Blocked" is an inverted pill; the owner is a 20 px avatar or Kreska.
                supplier = self.card(page, SUPPLIER)
                expect(supplier.locator(".ui-task-number")).to_have_text(f"#{self.numbers['supplier']}")
                expect(supplier.get_by_role("button", name=SUPPLIER, exact=True)).to_be_visible()
                expect(supplier.locator(".tb-card__name")).to_have_text("You")
                self.assertEqual(supplier.locator(".tb-av").evaluate("el => [el.offsetWidth, el.offsetHeight]"), [20, 20])
                expect(self.card(page, LABELS).locator(".tb-card__owner")).to_have_text("No owner")
                enclosure = self.card(page, ENCLOSURE)
                pill = enclosure.locator(".ui-pill--inv")
                expect(pill).to_have_text("Blocked")
                self.assertGreaterEqual(page.evaluate(MEASURE, {"selector": ".tb-card .ui-pill--inv"})["ratio"], 4.5)
                expect(self.card(page, SUPPLIER).locator(".ui-pill--inv")).to_have_count(0)
                agent = self.card(page, CALIBRATE).locator(".tb-card__owner")
                self.assertEqual(agent.locator(".kreska").first.evaluate("el => el.getBoundingClientRect().width"), 20)
                expect(self.card(page, SCHOOL).locator(".tb-av")).to_have_text("JB")
                for selector in (".tb-col__h", ".tb-card__name", ".ui-task-number", ".tb-card__title"):
                    self.assertGreaterEqual(page.evaluate(MEASURE, {"selector": selector})["ratio"], 4.5, selector)
                self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), DESKTOP["width"])
                shot(page, f"346-tasks-board-1440-{'dark' if dark else 'light'}")

    def test_03_the_computer_list_shows_glyph_word_number_and_owner(self) -> None:
        page = self.tasks()
        page.get_by_role("radio", name="List", exact=True).click()
        for key, title, status in (("enclosure", ENCLOSURE, "blocked"), ("supplier", SUPPLIER, "open"), ("calibrate", CALIBRATE, "in_progress"), ("lora", LORA, "done")):
            row = self.row(page, title)
            expect(row.locator(".ws-task__glyph .ui-glyph--" + status)).to_have_count(1)
            expect(row.locator(".ws-item__s")).to_contain_text(f"#{self.numbers[key]}")
            expect(row.locator(".ws-item__s")).to_contain_text(WORD[status])  # the word accompanies the glyph
        expect(self.row(page, ENCLOSURE).locator(".ui-pill--inv")).to_have_text("Blocked")
        expect(self.row(page, ENCLOSURE).locator(".ws-item__s")).to_contain_text(f"waiting for {BLOCKER}")
        expect(self.row(page, SUPPLIER).locator(".ws-av")).to_have_text("AK")
        expect(self.row(page, CALIBRATE).locator(".ws-item__r .kreska")).to_have_count(1)
        expect(self.row(page, SUPPLIER).locator(".ws-item__s")).to_contain_text("you")
        shot(page, "346-tasks-list-1440-light")

    # ---------------------------------------------------------------- AC-2: one tap, keys 1-5, Undo

    def test_04_one_tap_on_the_glyph_changes_the_state_and_undo_restores_it(self) -> None:
        for dark in (False, True):
            with self.subTest(dark=dark):
                page = self.tasks(dark=dark)
                page.get_by_role("radio", name="List", exact=True).click()
                self.set_status(page, "supplier", "open")
                row = self.row(page, SUPPLIER)
                before = self.task(page, "supplier")
                row.get_by_role("button", name="Open. Set to In progress").click()
                toast = page.locator(".ui-toast")
                expect(toast).to_contain_text(f"#{self.numbers['supplier']} in progress")
                self.assertEqual(self.task(page, "supplier")["status"], "in_progress")
                expect(self.row(page, SUPPLIER).locator(".ws-task__glyph .ui-glyph--in_progress")).to_have_count(1)
                # Undo is a click on the toast button, through the same versioned command.
                toast.get_by_role("button", name="Undo").click()
                expect(page.locator(".ui-toast").filter(has_text="back to open")).to_be_visible()
                after = self.task(page, "supplier")
                self.assertEqual(after["status"], "open")
                self.assertEqual(after["version"], before["version"] + 2, "change and undo are two stored versions")
                expect(self.row(page, SUPPLIER).locator(".ws-task__glyph .ui-glyph--open")).to_have_count(1)
                shot(page, f"346-tasks-undo-1440-{'dark' if dark else 'light'}")

    def test_05_keys_1_to_5_set_the_state_and_z_undoes_on_the_board_and_the_list(self) -> None:
        page = self.tasks()
        self.set_status(page, "supplier", "open")
        page.reload()
        # Board: the key works on the focused card; the card follows to its column and keeps focus.
        card = self.card(page, SUPPLIER)
        card.get_by_role("button", name=SUPPLIER, exact=True).focus()
        page.keyboard.press("4")
        expect(page.locator(".ui-toast")).to_contain_text(f"#{self.numbers['supplier']} done")
        self.assertEqual(self.task(page, "supplier")["status"], "done")
        expect(self.card(page.get_by_role("region", name="Done", exact=True), SUPPLIER).get_by_role("button", name=SUPPLIER, exact=True)).to_be_focused()
        page.keyboard.press("z")
        expect(page.locator(".ui-toast").filter(has_text="back to open")).to_be_visible()
        self.assertEqual(self.task(page, "supplier")["status"], "open")
        expect(self.card(page.get_by_role("region", name="Open", exact=True), SUPPLIER)).to_be_visible()
        # Every key: 1 Open, 2 In progress, 3 Blocked, 4 Done, 5 Not pursued.
        for key, status in (("2", "in_progress"), ("3", "blocked"), ("5", "not_pursued"), ("1", "open")):
            self.card(page, SUPPLIER).get_by_role("button", name=SUPPLIER, exact=True).focus()
            page.keyboard.press(key)
            self.wait_status(page, "supplier", status)
        # List: the same keys on the focused row; Z in a text field does not undo.
        page.get_by_role("radio", name="List", exact=True).click()
        row = self.row(page, SUPPLIER)
        row.locator(".ws-item").focus()
        page.keyboard.press("2")
        expect(page.locator(".ui-toast").filter(has_text="in progress").last).to_be_visible()
        self.assertEqual(self.task(page, "supplier")["status"], "in_progress")
        expect(self.row(page, SUPPLIER).locator(".ws-item")).to_be_focused()
        field = page.get_by_label("New task", exact=True)
        field.focus()
        page.keyboard.type("z")
        expect(field).to_have_value("z")
        self.assertEqual(self.task(page, "supplier")["status"], "in_progress", "Z typed in a field is text")
        field.fill("")
        self.row(page, SUPPLIER).locator(".ws-item").focus()
        page.keyboard.press("z")
        self.wait_status(page, "supplier", "open")

    def test_05b_undo_of_a_blocked_task_restores_status_blocker_and_two_versions(self) -> None:
        page = self.tasks()
        page.get_by_role("radio", name="List", exact=True).click()
        self.set_status(page, "enclosure", "blocked")
        before = self.task(page, "enclosure")
        self.assertEqual(before["blocker"], BLOCKER)
        page.reload()
        self.row(page, ENCLOSURE).locator(".ws-item").focus()
        page.keyboard.press("4")
        expect(page.locator(".ui-toast")).to_contain_text(f"#{self.numbers['enclosure']} done")
        done = self.task(page, "enclosure")
        self.assertEqual((done["status"], done["blocker"]), ("done", None), "leaving Blocked clears the blocker on the server")
        page.locator(".ui-toast").get_by_role("button", name="Undo").click()
        expect(page.locator(".ui-toast").filter(has_text="back to blocked")).to_be_visible()
        after = self.task(page, "enclosure")
        self.assertEqual((after["status"], after["blocker"]), ("blocked", BLOCKER))
        self.assertEqual(after["version"], before["version"] + 2, "the change and its undo are two stored versions")
        # Open -> Blocked by key 3 invents no blocker: the server does not require one, and the row says so.
        self.set_status(page, "labels", "open")
        page.reload()
        self.row(page, LABELS).locator(".ws-item").focus()
        page.keyboard.press("3")
        expect(page.locator(".ui-toast")).to_contain_text(f"#{self.numbers['labels']} blocked")
        blocked = self.task(page, "labels")
        self.assertEqual((blocked["status"], blocked["blocker"]), ("blocked", None))
        page.keyboard.press("z")
        self.wait_status(page, "labels", "open")

    def test_06_a_refused_change_says_why_and_shows_the_stored_state(self) -> None:
        page = self.tasks()
        self.set_status(page, "school", "open")
        page.reload()
        page.get_by_role("radio", name="List", exact=True).click()
        expect(self.row(page, SCHOOL)).to_be_visible()
        jonas = self.page("jonas")
        self.set_status(jonas, "school", "in_progress")
        row = self.row(page, SCHOOL)
        row.locator(".ws-item").focus()
        page.keyboard.press("4")
        toast = page.locator(".ui-toast").filter(has_text="changed by someone else")
        expect(toast).to_be_visible()
        self.assertEqual(self.task(page, "school")["status"], "in_progress", "the stored state wins")
        self.set_status(page, "school", "open")

    # ---------------------------------------------------------------- AC-1, AC-2, AC-4: the phone

    def test_07_the_phone_list_is_drawn_with_no_toolbar(self) -> None:
        for dark in (False, True):
            with self.subTest(dark=dark):
                page = self.tasks(phone=True, dark=dark)
                expect(page.locator(".tb-bar")).to_be_hidden()  # no search, board switch, Decisions or New Task tools
                expect(page.get_by_role("radiogroup", name="Show tasks as")).to_be_hidden()
                expect(page.get_by_label("Search tasks")).to_be_hidden()
                mine = page.get_by_role("group", name="Whose tasks")
                expect(mine.get_by_role("button")).to_have_count(2)
                expect(mine.get_by_role("button", name="All", exact=True)).to_have_attribute("aria-pressed", "true")
                enclosure = self.row(page, ENCLOSURE)
                expect(enclosure.locator(".ui-pill--inv")).to_have_text("Blocked")
                expect(enclosure.locator(".ws-item__s")).to_have_text(f"#{self.numbers['enclosure']} · waiting for {BLOCKER}", use_inner_text=True)  # the word "Blocked" is the pill
                expect(enclosure.locator(".ws-task__glyph .ui-glyph--blocked")).to_have_count(1)
                expect(self.row(page, CALIBRATE).locator(".ws-item__s")).to_contain_text("Claude Code is working")
                expect(self.row(page, CALIBRATE).locator(".ws-item__r .kreska")).to_have_count(1)
                expect(self.row(page, SCHOOL).locator(".ws-av")).to_have_text("JB")
                self.assertEqual(self.row(page, SCHOOL).locator(".ws-av").evaluate("el => el.offsetWidth"), 24)
                for control in (*mine.get_by_role("button").all(), self.row(page, SCHOOL).locator(".ws-task__glyph"), self.row(page, SCHOOL).locator(".ws-item")):
                    box = control.bounding_box()
                    assert box
                    self.assertGreaterEqual(box["height"], 44, "touch target")
                self.assertGreaterEqual(page.evaluate(MEASURE, {"selector": ".ws-item__s"})["ratio"], 4.5)
                self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), PHONE["width"])
                shot(page, f"346-tasks-phone-390-{'dark' if dark else 'light'}")

    def test_08_swipe_left_reveals_done_and_undo_restores_the_state(self) -> None:
        for reduced in (False, True):
            with self.subTest(reduced_motion=reduced):
                page = self.tasks(phone=True, dark=reduced, reduced=reduced)
                self.set_status(page, "labels", "open")
                page.reload()
                row = self.row(page, LABELS)
                expect(row).to_be_visible()
                done = row.get_by_role("button", name=re.compile("^Done"))
                expect(done).to_be_hidden()  # nothing is revealed until the swipe
                before = self.task(page, "labels")
                self.swipe_left(page, row.locator(".ws-task__fg"))
                expect(done).to_be_visible()
                box = done.bounding_box()
                assert box
                self.assertGreaterEqual(box["width"], 44)
                shot(page, f"346-tasks-swipe-390-{'dark' if reduced else 'light'}")
                self.assertEqual(self.task(page, "labels")["status"], "open", "a swipe alone changes nothing")
                done.tap()
                toast = page.locator(".ui-toast")
                expect(toast).to_contain_text(f"#{self.numbers['labels']} done")
                self.assertEqual(self.task(page, "labels")["status"], "done")
                toast.get_by_role("button", name="Undo").tap()
                expect(page.locator(".ui-toast").filter(has_text="back to open")).to_be_visible()
                after = self.task(page, "labels")
                self.assertEqual(after["status"], "open")
                self.assertEqual(after["version"], before["version"] + 2)
                expect(self.row(page, LABELS).locator(".ws-task__glyph .ui-glyph--open")).to_have_count(1)
                page.wait_for_timeout(500)
                # A vertical scroll is not a swipe, and a tap on a revealed row closes it instead of opening Details.
                self.swipe_left(page, self.row(page, LABELS).locator(".ws-task__fg"))
                expect(self.row(page, LABELS).get_by_role("button", name=re.compile("^Done"))).to_be_visible()
                self.row(page, LABELS).locator(".ws-item").tap()
                expect(self.row(page, LABELS).get_by_role("button", name=re.compile("^Done"))).to_be_hidden()
                expect(page.locator("#details").get_by_role("heading", name=LABELS)).to_have_count(0)

    def test_09_one_tap_on_a_phone_glyph_moves_the_task_forward(self) -> None:
        page = self.tasks(phone=True)
        self.set_status(page, "school", "open")
        page.reload()
        row = self.row(page, SCHOOL)
        row.locator(".ws-task__glyph").tap()
        expect(page.locator(".ui-toast")).to_contain_text(f"#{self.numbers['school']} in progress")
        self.assertEqual(self.task(page, "school")["status"], "in_progress")
        page.locator(".ui-toast").get_by_role("button", name="Undo").tap()
        expect(page.locator(".ui-toast").filter(has_text="back to open")).to_be_visible()
        self.assertEqual(self.task(page, "school")["status"], "open")

    # ---------------------------------------------------------------- AC-3: drag and drop keeps its keyboard way

    def test_10_moving_between_columns_keeps_its_keyboard_way_and_its_announcement(self) -> None:
        page = self.tasks()
        self.set_status(page, "labels", "open")
        page.reload()
        spoken = page.locator(".tb-wrap > p[aria-live]")
        open_, doing = page.get_by_role("region", name="Open", exact=True), page.get_by_role("region", name="In progress", exact=True)
        button = self.card(open_, LABELS).get_by_role("button", name=LABELS, exact=True)
        button.focus()
        page.keyboard.press("Space")
        expect(spoken).to_contain_text(f"Picked up “{LABELS}” in Open.")
        page.keyboard.press("ArrowRight")
        expect(spoken).to_contain_text("In progress.")
        page.keyboard.press("Space")
        expect(self.card(doing, LABELS)).to_be_visible()
        expect(page.locator(".tb-note--ok")).to_contain_text(f"Moved “{LABELS}” to In progress.")
        self.assertEqual(self.task(page, "labels")["status"], "in_progress")
        # The mouse still drags a card into another column.
        expect(page.locator(".tb-note--ok")).to_have_count(0, timeout=10000)  # its removal would shift the board mid-drag
        box = self.card(doing, LABELS).bounding_box()
        target = page.get_by_role("region", name="Done", exact=True).locator(".tb-col__cards").bounding_box()
        assert box and target
        page.mouse.move(box["x"] + 24, box["y"] + 14)
        page.mouse.down()
        page.mouse.move(box["x"] + 40, box["y"] + 26, steps=4)
        page.mouse.move(target["x"] + target["width"] / 2, target["y"] + 60, steps=10)
        page.mouse.up()
        page.wait_for_timeout(500)
        expect(self.card(page.get_by_role("region", name="Done", exact=True), LABELS)).to_be_visible()
        self.wait_status(page, "labels", "done")
        self.set_status(page, "labels", "open")


if __name__ == "__main__":
    unittest.main()
