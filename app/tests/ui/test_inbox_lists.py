"""Browser tests for a task given to you in the Inbox and the lists behind "for later" and "done today" (#1424 C and E).

Founder decisions (Hubert, 2026-11-15, #1424): a task someone else gives you reaches your Inbox as "Task · who · space" with Open,
Not now and Done, and leaves it when you open it; "N for later" and "N done today" under the Inbox open their lists, with when each
item comes back and Bring back now, and when it was done and Put back. The keyboard follows README §4: the window opens on its
first row's button, the arrow keys move between rows, Esc gives focus back to the line, a row that leaves passes focus on, and the
Inbox's own keys do nothing while the window is open. Ada is checked at 1440x900 and on a 390x844 touch phone, against the API.
Screenshots (inbox-lists-*.png) go to FLUX_UI_SCREENSHOTS when set.
"""

from __future__ import annotations

import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, shot, start_forwarder

PASSWORD = "a task given and lists that open"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ada": ("Ada Kowalska", f"ada.l+{STAMP}@example.test"),
    "jonas": ("Jonas Berg", f"jonas.l+{STAMP}@example.test"),
}
SPACE = "Rain barrel monitor"
GIVEN = "Seal the lids"
SECOND = "Order the float valves"
ASKED = "can you check the overflow pipe?"


class InboxLists(unittest.TestCase):
    """Tests run in name order; each one leaves the queue as the next expects it."""

    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}
    contexts: dict[str, BrowserContext] = {}
    tasks: dict[str, dict] = {}
    project_id = ""

    @classmethod
    def call(cls, who: str, method: str, path: str, body: dict | None = None) -> dict:
        response = cls.contexts[who].request.fetch(path, method=method, data=body, headers={"origin": ORIGIN})
        assert response.status in (200, 201, 204), f"{method} {path}: {response.status} {response.text()}"
        return response.json() if response.status != 204 and response.text() else {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        assert cls.browser.browser_type.name == UI_BROWSER
        print(f"ACTUAL_UI_ENGINE={cls.browser.browser_type.name}", flush=True)
        expect.set_options(timeout=15000)
        for key, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(base_url=ORIGIN, service_workers="block")
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.contexts[key] = context
        workspace = cls.call("ada", "POST", "/api/v1/workspaces", {"name": "Riverside Makers"})["id"]
        cls.call("ada", "POST", f"/api/v1/workspaces/{workspace}/members", {"email": PEOPLE["jonas"][1], "role": "member"})
        cls.project_id = cls.call("ada", "POST", f"/api/v1/workspaces/{workspace}/projects", {"name": SPACE, "visibility": "workspace"})["id"]
        for key, title in (("given", GIVEN), ("second", SECOND)):
            cls.tasks[key] = cls.call("jonas", "POST", f"/api/v1/projects/{cls.project_id}/work", {"title": title, "owner": {"kind": "human", "id": cls.ids["ada"]}})
        # A task Ada gives herself is no item.
        cls.tasks["own"] = cls.call("ada", "POST", f"/api/v1/projects/{cls.project_id}/work", {"title": "Paint the barrel", "owner": {"kind": "human", "id": cls.ids["ada"]}})
        cls.call("jonas", "POST", f"/api/v1/projects/{cls.project_id}/conversations", {"body": f"@Ada Kowalska {ASKED}", "clientMessageId": str(uuid.uuid4())})
        for key, context in cls.contexts.items():
            cls.states[key] = context.storage_state()
        # The worker writes the notifications shortly after the events.
        for _ in range(80):
            if len(cls.queue()["items"]) >= 3:
                break
            time.sleep(0.25)

    @classmethod
    def tearDownClass(cls) -> None:
        for context in cls.contexts.values():
            context.close()
        cls.browser.close()
        cls.pw.stop()

    @classmethod
    def queue(cls) -> dict:
        response = cls.contexts["ada"].request.get("/api/v1/needs-you")
        assert response.status == 200, response.text()
        return response.json()

    def task_item(self, key: str) -> dict | None:
        return next((item for item in self.queue()["items"] if item["kind"] == "task" and item["task"]["workId"] == self.tasks[key]["id"]), None)

    def page(self, *, phone: bool = False) -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw", "storage_state": self.states["ada"]}
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=DESKTOP, device_scale_factor=1)
        context = self.browser.new_context(service_workers="block", **options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def focused(self, page: Page) -> str:
        """What has focus: its text, or its accessible name for a button that has one."""
        return page.evaluate("() => { const el = document.activeElement; return el ? (el.getAttribute('aria-label') || el.textContent || el.tagName).trim() : ''; }")

    # ---------------------------------------------------------------- C: a task given to you

    def test_01_a_given_task_is_an_inbox_item_and_opening_it_takes_it_out(self) -> None:
        self.assertIsNotNone(self.task_item("given"), "the task Jonas gave Ada waits for her")
        self.assertIsNone(self.task_item("own"), "a task she gave herself is no item")
        page = self.page()
        page.goto("/inbox")
        row = page.locator(".nyq__list .nyc--task", has_text=GIVEN)
        expect(row).to_be_visible()
        expect(row.locator(".nyc__meta")).to_have_text(f"Task · Jonas Berg · {SPACE}")
        expect(row.locator(".nyc__title")).to_have_text(f"#{self.tasks['given']['number']} {GIVEN}")
        expect(page.locator(".nyq__list .nyc", has_text="Paint the barrel")).to_have_count(0)
        row.locator(".nyc__open").click()
        pane = page.locator(".nyq__col--open")
        expect(pane).to_contain_text(GIVEN)
        # Open, Not now and Done, like the other items; a task has no Reply.
        for name in ("Open", "Not now", "Done"):
            expect(pane.get_by_role("button", name=re.compile(f"^{name}"))).to_be_visible()
        expect(pane.get_by_role("button", name=re.compile("^Reply"))).to_have_count(0)
        shot(page, "inbox-lists-task-item")
        pane.get_by_role("button", name="Open", exact=True).click()
        panel = page.locator("#details .wd[data-detail-kind='work']")
        expect(panel).to_contain_text(GIVEN)
        # Opened, it leaves the Inbox here and on the server.
        expect(row).to_have_count(0)
        deadline = time.time() + 10
        while self.task_item("given") and time.time() < deadline:
            time.sleep(0.25)
        self.assertIsNone(self.task_item("given"), "opening the task read the notice that gave it")
        self.assertIsNotNone(self.task_item("second"), "the other task still waits")

    # ---------------------------------------------------------------- E: the lists behind the line

    def test_02_for_later_and_done_today_open_their_lists_by_keyboard(self) -> None:
        page = self.page()
        page.goto("/inbox")
        second = page.locator(".nyq__list .nyc--task", has_text=SECOND)
        question = page.locator(".nyq__list .nyc", has_text=ASKED)
        expect(second).to_be_visible()
        expect(question).to_be_visible()
        # Not now on the task (S) and Done on the question (E). Done on a task finishes it and is in done today too (test_02b).
        second.locator(".nyc__open").click()
        page.locator(".nyq__col--open").get_by_role("button", name=re.compile("^Not now")).click()
        expect(second).to_have_count(0)
        question.locator(".nyc__open").click()
        page.locator(".nyq__col--open").get_by_role("button", name=re.compile("^Done")).click()
        expect(question).to_have_count(0)
        later = page.get_by_role("button", name="1 for later")
        done = page.get_by_role("button", name="1 done today")
        expect(later).to_be_visible()
        expect(done).to_be_visible()
        expect(page.locator(".nyq-aside__line")).to_have_text("1 for later · 1 done today")

        # For later: the window opens on its first row's button, says when the item comes back, and Esc gives focus back to the line.
        later.focus()
        page.keyboard.press("Enter")
        window = page.get_by_role("dialog", name="For later")
        expect(window).to_be_visible()
        row = window.locator(".nyq-aside__row", has_text=SECOND)
        expect(row).to_contain_text(f"Task · Jonas Berg · {SPACE}")
        expect(row).to_contain_text("Back tomorrow at 08:00")
        bring = row.get_by_role("button", name=re.compile("^Bring back now"))
        expect(bring).to_be_focused()
        # The Undo toast of Not now leaves as the window opens: the window has its own way back, and nothing floats over it (personas-30).
        expect(page.locator(".ui-toast").filter(has_text="Undo")).to_have_count(0)
        shot(page, "inbox-lists-for-later")
        # The Inbox's keys do nothing while the window is open: E is not Done on the open item.
        before = len(self.queue()["items"])
        page.keyboard.press("e")
        page.keyboard.press("j")
        expect(window).to_be_visible()
        self.assertEqual(len(self.queue()["items"]), before)
        page.keyboard.press("Escape")
        expect(window).to_have_count(0)
        expect(later).to_be_focused()

        # Done today: when it was done, and Put back. The last row leaving closes the window; the item it put back takes focus in the list.
        done.focus()
        page.keyboard.press("Enter")
        window = page.get_by_role("dialog", name="Done today")
        row = window.locator(".nyq-aside__row", has_text=ASKED)
        expect(row).to_contain_text(f"Question · Jonas Berg · {SPACE}")
        expect(row).to_contain_text(re.compile(r"Done today at \d\d:\d\d"))
        put = row.get_by_role("button", name=re.compile("^Put back"))
        expect(put).to_be_focused()
        shot(page, "inbox-lists-done-today")
        page.keyboard.press("Enter")
        expect(window).to_have_count(0)
        expect(question).to_be_visible()
        expect(question.locator(".nyc__open")).to_be_focused()
        expect(page.get_by_role("button", name=re.compile("done today"))).to_have_count(0)
        self.assertTrue(any(ASKED in item["title"] for item in self.queue()["items"]), "put back: in the Inbox again")

        # Bring back now, with the mouse.
        page.get_by_role("button", name="1 for later").click()
        window = page.get_by_role("dialog", name="For later")
        window.get_by_role("button", name=re.compile("^Bring back now")).click()
        expect(window).to_have_count(0)
        expect(second).to_be_visible()
        expect(page.locator(".nyq-aside__line")).to_have_count(0)
        self.assertEqual(self.queue()["later"], 0)
        self.assertIsNotNone(self.task_item("second"), "brought back: in the Inbox again")

    def test_02b_done_on_a_given_task_finishes_it_and_undo_puts_it_back(self) -> None:
        # Founder decision (2026-11-15, #1424): Done on a Task item finishes the task, not only the item; Undo puts it back.
        task = self.tasks["second"]
        work = lambda: self.contexts["jonas"].request.get(f"/api/v1/work/{task['id']}").json()  # noqa: E731
        done_before = self.queue()["doneToday"]
        page = self.page()
        page.goto("/inbox")
        second = page.locator(".nyq__list .nyc--task", has_text=SECOND)
        second.locator(".nyc__open").click()
        page.locator(".nyq__col--open").get_by_role("button", name=re.compile("^Done")).click()
        toast = page.get_by_role("status").filter(has_text=f"#{task['number']} moved to Done")
        expect(toast).to_be_visible()
        expect(second).to_have_count(0)
        deadline = time.time() + 10
        while work()["status"] != "done" and time.time() < deadline:
            time.sleep(0.25)
        self.assertEqual(work()["status"], "done", "Jonas, who gave it, sees it done")
        self.assertIsNone(self.task_item("second"))
        # It is in done today, so it can be put back from there too (personas-33 P2 2).
        self.assertEqual(self.queue()["doneToday"], done_before + 1, "a task Done finished from the Inbox is in done today")
        shot(page, "inbox-lists-task-done")
        # Undo (Z): the task is To do again and the item is back.
        page.keyboard.press("z")
        expect(second).to_be_visible()
        deadline = time.time() + 10
        while work()["status"] != "open" and time.time() < deadline:
            time.sleep(0.25)
        self.assertEqual(work()["status"], "open")
        self.assertIsNotNone(self.task_item("second"), "Undo brings the item back")

    def test_03_the_arrow_keys_move_between_rows_and_focus_moves_on_when_a_row_leaves(self) -> None:
        for key in ("given", "second"):
            item = self.task_item(key)
            if item is None:
                continue
            self.call("ada", "POST", f"/api/v1/needs-you/{item['key']}", {"action": "done"})
        question = next(item for item in self.queue()["items"] if ASKED in item["title"])
        self.call("ada", "POST", f"/api/v1/needs-you/{question['key']}", {"action": "done"})
        done_count = self.queue()["doneToday"]
        self.assertGreaterEqual(done_count, 2)
        page = self.page()
        page.goto("/inbox")
        page.get_by_role("button", name=f"{done_count} done today").click()
        window = page.get_by_role("dialog", name="Done today")
        buttons = window.get_by_role("button", name=re.compile("^Put back"))
        expect(buttons).to_have_count(done_count)
        expect(buttons.nth(0)).to_be_focused()
        page.keyboard.press("ArrowDown")
        expect(buttons.nth(1)).to_be_focused()
        page.keyboard.press("ArrowUp")
        expect(buttons.nth(0)).to_be_focused()
        # The first row leaves; focus goes to the next row's button, never to the page.
        page.keyboard.press("Enter")
        expect(buttons).to_have_count(done_count - 1)
        expect(buttons.nth(0)).to_be_focused()
        page.keyboard.press("Escape")
        expect(window).to_have_count(0)
        # What came back is in the list, and has focus.
        expect(page.locator(".nyq__list .nyc__open:focus")).to_have_count(1)

    def test_03b_what_comes_back_is_the_open_item_and_e_acts_on_it(self) -> None:
        # personas-34 P2 2: Put back with the window left open, then Esc: the ring went to the row that came back, but the open item stayed the
        # one before, and E finished that one. The same when the window closed by itself. What comes back has the ring and is the open item.
        again = "is the rain gauge still on the shed roof?"
        self.call("jonas", "POST", f"/api/v1/projects/{self.project_id}/conversations", {"body": f"@Ada Kowalska {again}", "clientMessageId": str(uuid.uuid4())})
        item = None
        for _ in range(80):
            item = next((entry for entry in self.queue()["items"] if again in entry["title"]), None)
            if item:
                break
            time.sleep(0.25)
        self.assertIsNotNone(item, "the question reached Ada")
        self.call("ada", "POST", f"/api/v1/needs-you/{item['key']}", {"action": "done"})
        waiting = lambda: [entry["title"] for entry in self.queue()["items"]]  # noqa: E731

        def put_back_then_e(page: Page, closes_itself: bool) -> None:
            page.goto("/inbox")
            other = page.locator(".nyq__list .nyc[aria-current='true']")
            expect(other).to_have_count(1)
            expect(other).not_to_contain_text(again)
            page.get_by_role("button", name=re.compile(r"^\d+ done today$")).click()
            window = page.get_by_role("dialog", name="Done today")
            put = window.locator(".nyq-aside__row", has_text=again).get_by_role("button", name=re.compile("^Put back"))
            expect(put).to_be_focused()
            page.keyboard.press("Enter")
            if closes_itself:
                expect(window).to_have_count(0)
            else:
                expect(window.locator(".nyq-aside__row", has_text=again)).to_have_count(0)
                expect(window).to_be_visible()
                page.keyboard.press("Escape")
                expect(window).to_have_count(0)
            back = page.locator(".nyq__list .nyc", has_text=again)
            expect(back.locator(".nyc__open")).to_be_focused()
            expect(back, "the ring and the open item stay together").to_have_attribute("aria-current", "true")
            expect(page.locator(".nyq__col--open")).to_contain_text(again)
            shot(page, f"inbox-lists-put-back-open-{'closed' if closes_itself else 'esc'}")
            page.keyboard.press("e")
            expect(page.get_by_role("status").filter(has_text="Marked done")).to_be_visible()
            expect(back).to_have_count(0)
            for _ in range(40):
                if not any(again in title for title in waiting()):
                    break
                time.sleep(0.25)
            titles = waiting()
            self.assertFalse(any(again in title for title in titles), "E finished the item that came back")
            self.assertTrue(any(ASKED in title for title in titles), "the item open before is untouched")

        # Two rows: Put back one, the window stays, Esc closes it.
        self.assertGreaterEqual(self.queue()["doneToday"], 2)
        put_back_then_e(self.page(), closes_itself=False)
        # One row: Put back closes the window by itself. The other done item goes back first, through the API.
        aside = self.contexts["ada"].request.get("/api/v1/needs-you/aside").json()
        for entry in aside["done"]:
            if again not in entry["item"]["title"]:
                self.call("ada", "DELETE", f"/api/v1/needs-you/{entry['item']['key']}")
        self.assertEqual(self.queue()["doneToday"], 1)
        put_back_then_e(self.page(), closes_itself=True)

    def test_03c_a_double_click_on_put_back_or_bring_back_now_brings_back_one_item(self) -> None:
        # Sweep 34 C4: the next row slides up under the pointer as a row leaves, so the second click of a double-click on Put back (or Bring
        # back now) brought that row back too. One press, one action (README §4), as in the Inbox itself.
        tag = uuid.uuid4().hex[:4]
        asks = {which: [f"can you check the {thing} {which} {tag}?" for thing in ("hose", "tap")] for which in ("done", "later")}
        for texts in asks.values():
            for text in texts:
                self.call("jonas", "POST", f"/api/v1/projects/{self.project_id}/conversations", {"body": f"@Ada Kowalska {text}", "clientMessageId": str(uuid.uuid4())})
        items: dict[str, dict] = {}
        for _ in range(80):
            queue = self.queue()["items"]
            items = {text: item for text in asks["done"] + asks["later"] for item in queue if text in item["title"]}
            if len(items) == 4:
                break
            time.sleep(0.25)
        self.assertEqual(len(items), 4, "the four questions reached Ada")
        for text in asks["done"]:
            self.call("ada", "POST", f"/api/v1/needs-you/{items[text]['key']}", {"action": "done"})
        until = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 86400))
        for text in asks["later"]:
            self.call("ada", "POST", f"/api/v1/needs-you/{items[text]['key']}", {"action": "snooze", "until": until})
        waiting = lambda: [item["title"] for item in self.queue()["items"]]  # noqa: E731
        page = self.page()
        for which, line, title, action in (("done", r"done today$", "Done today", "Put back"), ("later", r"for later$", "For later", "Bring back now")):
            with self.subTest(which=which):
                page.goto("/inbox")
                page.get_by_role("button", name=re.compile(rf"^\d+ {line}")).click()
                window = page.get_by_role("dialog", name=title)
                rows = window.locator(".nyq-aside__row")
                expect(rows.first).to_be_visible()
                count = rows.count()
                self.assertGreaterEqual(count, 2, "a row below slides up as the first leaves")
                window.get_by_role("button", name=re.compile(f"^{action}")).first.dblclick()
                expect(rows).to_have_count(count - 1)
                page.wait_for_timeout(1000)
                expect(rows, "the row that slid up under the pointer stays").to_have_count(count - 1)
                page.keyboard.press("Escape")
                expect(window).to_have_count(0)
                back = [text for text in asks[which] if any(text in title for title in waiting())]
                self.assertEqual(len(back), 1, f"one press, one item back: {back}")

    def test_04_phone_the_line_opens_a_sheet(self) -> None:
        page = self.page(phone=True)
        page.goto("/inbox")
        line = page.get_by_role("button", name=re.compile(r"^\d+ done today$"))
        expect(line).to_be_visible()
        self.assertGreaterEqual(line.bounding_box()["height"], 44, "a touch target")
        line.tap()
        window = page.get_by_role("dialog", name="Done today")
        expect(window).to_be_visible()
        put = window.get_by_role("button", name=re.compile("^Put back")).first
        expect(put).to_be_visible()
        self.assertGreaterEqual(put.bounding_box()["height"], 44, "a touch target")
        # A sheet: the whole width, from the bottom edge (its rounded top above the rows).
        page.wait_for_function("() => document.querySelector('.nyq-aside-win').getAnimations().length === 0")
        box = window.bounding_box()
        self.assertLessEqual(abs(box["x"]), 1)
        self.assertLessEqual(abs(box["width"] - PHONE["width"]), 1)
        self.assertGreaterEqual(box["y"] + box["height"], page.evaluate("innerHeight") - 12, "it reaches the bottom edge")
        shot(page, "inbox-lists-phone-sheet")
        window.get_by_role("button", name="Close done today").tap()
        expect(window).to_have_count(0)

    def test_05_phone_a_task_opened_from_a_compact_card_comes_back_as_its_neighbour_at_its_place(self) -> None:
        # Sweep 34 C7: a card opened from the phone's list is the open item, so closing what it opened returns with it expanded (README §4).
        # A task given to you leaves the Inbox as it opens: its neighbour at its place is the expanded card then, not the card that was
        # expanded before the task was opened.
        tag = uuid.uuid4().hex[:4]
        below, above = f"can you oil the hinges {tag}?", f"can you sweep the yard {tag}?"
        self.call("jonas", "POST", f"/api/v1/projects/{self.project_id}/conversations", {"body": f"@Ada Kowalska {below}", "clientMessageId": str(uuid.uuid4())})
        task = self.call("jonas", "POST", f"/api/v1/projects/{self.project_id}/work", {"title": f"Fit the rain cap {tag}", "owner": {"kind": "human", "id": self.ids["ada"]}})
        time.sleep(1.1)
        self.call("jonas", "POST", f"/api/v1/projects/{self.project_id}/conversations", {"body": f"@Ada Kowalska {above}", "clientMessageId": str(uuid.uuid4())})
        titles: list[str] = []
        for _ in range(80):
            titles = [item["title"] for item in self.queue()["items"]]
            at = lambda text: next((index for index, title in enumerate(titles) if text in title), -1)  # noqa: E731
            if min(at(above), at(task["title"]), at(below)) >= 0:
                break
            time.sleep(0.25)
        order = [next(index for index, title in enumerate(titles) if text in title) for text in (above, task["title"], below)]
        self.assertEqual(order, sorted(order), f"newest first: {titles}")
        self.assertEqual(order[1] + 1, order[2], "the question below is the task's neighbour")
        page = self.page(phone=True)
        page.goto("/inbox")
        card = lambda text: page.locator(".nyq__list .nyc", has_text=text)  # noqa: E731
        # The top card is expanded; the task's card is compact, with Open.
        expect(card(above)).to_have_attribute("aria-current", "true")
        expect(card(task["title"])).not_to_have_attribute("aria-current", "true")
        card(task["title"]).locator(".nyc__rowactions").get_by_role("button", name="Open").tap()
        expect(page).to_have_url(re.compile(r"/tasks\?open=work"))
        expect(page.locator("#details")).to_contain_text(task["title"])
        page.locator("#details").get_by_role("button", name="Close details").tap()
        expect(page).to_have_url(re.compile(r"/inbox$"))
        expect(card(task["title"]), "opened, the task left the Inbox").to_have_count(0)
        expect(card(below), "its neighbour at its place is the expanded card").to_have_attribute("aria-current", "true")
        expect(card(above)).not_to_have_attribute("aria-current", "true")
        # And it has the focus, as on a computer (F-026 §4; personas-33/34/35: × or Back left it on the page).
        expect(card(below).locator(".nyc__open")).to_be_focused()
        shot(page, "inbox-lists-phone-task-opened-neighbour")

    def test_06_phone_the_first_reply_puts_the_cursor_in_the_thread(self) -> None:
        # personas-33/35 P3: the first Reply on a phone, on a page just opened, left the focus on the page (the next ones had the cursor).
        tag = uuid.uuid4().hex[:4]
        asked = f"can you check the drain {tag}?"
        self.call("jonas", "POST", f"/api/v1/projects/{self.project_id}/conversations", {"body": f"@Ada Kowalska {asked}", "clientMessageId": str(uuid.uuid4())})
        for _ in range(80):
            if any(asked in item["title"] for item in self.queue()["items"]):
                break
            time.sleep(0.25)
        page = self.page(phone=True)
        page.goto("/inbox")
        card = page.locator(".nyq__list .nyc", has_text=asked)
        expect(card).to_have_attribute("aria-current", "true")
        card.get_by_role("button", name=re.compile("^Reply")).first.tap()
        field = page.locator("#thread-composer")
        expect(field).to_be_focused()
        # It keeps the cursor once the sheet has settled around it.
        page.wait_for_timeout(1500)
        expect(field).to_be_focused()

    def test_07_opening_tasks_of_yours_reads_the_set_aside_list_once_and_still_reads_a_put_off_task(self) -> None:
        # Pre-review P3: every open of a task of yours that has not started read the uncached set-aside list while anything was set aside. It is
        # kept like the queue now: one read for as many opens, and a task given to you that you put off for later is still read when opened.
        tag = uuid.uuid4().hex[:4]
        given = self.call("jonas", "POST", f"/api/v1/projects/{self.project_id}/work", {"title": f"Fit the spigot {tag}", "owner": {"kind": "human", "id": self.ids["ada"]}})
        for _ in range(80):
            item = next((entry for entry in self.queue()["items"] if entry["kind"] == "task" and entry["task"]["workId"] == given["id"]), None)
            if item:
                break
            time.sleep(0.25)
        self.assertIsNotNone(item, "the task reached Ada")
        until = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 86400))
        self.call("ada", "POST", f"/api/v1/needs-you/{item['key']}", {"action": "snooze", "until": until})
        later = lambda: [entry["item"]["key"] for entry in self.contexts["ada"].request.get("/api/v1/needs-you/aside").json()["later"]]  # noqa: E731
        self.assertIn(item["key"], later())
        page = self.page()
        asides: list[str] = []
        page.on("request", lambda request: asides.append(request.url) if request.method == "GET" and request.url.split("?")[0].endswith("/api/v1/needs-you/aside") else None)
        page.goto(f"/projects/{self.project_id}/tasks?view=list")
        panel = page.locator("#details .wd[data-detail-kind='work']")
        # Her own task (nobody gave it to her): opened twice, the lists are looked in once.
        for _ in range(2):
            page.locator(f'.ws-task[data-work-id="{self.tasks["own"]["id"]}"] .ws-item').click()
            expect(panel).to_contain_text("Paint the barrel")
            page.wait_for_timeout(1200)
            page.locator("#details").get_by_role("button", name="Close details").click()
            expect(panel).to_have_count(0)
        self.assertEqual(len(asides), 1, f"the set-aside lists were read once for two opens: {asides}")
        # The one she put off is read when she opens it, from what was kept: it leaves the list and nothing is read again.
        page.locator(f'.ws-task[data-work-id="{given["id"]}"] .ws-item').click()
        expect(panel).to_contain_text(f"Fit the spigot {tag}")
        for _ in range(80):
            if item["key"] not in later():
                break
            time.sleep(0.25)
        self.assertNotIn(item["key"], later(), "opening it read the notice that gave it, though it was put off")
        self.assertEqual(len(asides), 1, f"and no list was read again: {asides}")


if __name__ == "__main__":
    unittest.main()
