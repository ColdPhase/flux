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
        # Done on the task (E) and Not now on the question (S).
        second.locator(".nyc__open").click()
        page.locator(".nyq__col--open").get_by_role("button", name=re.compile("^Done")).click()
        expect(second).to_have_count(0)
        question.locator(".nyc__open").click()
        page.locator(".nyq__col--open").get_by_role("button", name=re.compile("^Not now")).click()
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
        row = window.locator(".nyq-aside__row", has_text=ASKED)
        expect(row).to_contain_text(f"Question · Jonas Berg · {SPACE}")
        expect(row).to_contain_text("Back tomorrow at 08:00")
        bring = row.get_by_role("button", name=re.compile("^Bring back now"))
        expect(bring).to_be_focused()
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
        row = window.locator(".nyq-aside__row", has_text=SECOND)
        expect(row).to_contain_text(f"Task · Jonas Berg · {SPACE}")
        expect(row).to_contain_text(re.compile(r"Done today at \d\d:\d\d"))
        put = row.get_by_role("button", name=re.compile("^Put back"))
        expect(put).to_be_focused()
        shot(page, "inbox-lists-done-today")
        page.keyboard.press("Enter")
        expect(window).to_have_count(0)
        expect(second).to_be_visible()
        expect(second.locator(".nyc__open")).to_be_focused()
        expect(page.get_by_role("button", name=re.compile("done today"))).to_have_count(0)
        self.assertIsNotNone(self.task_item("second"), "put back: in the Inbox again")

        # Bring back now, with the mouse.
        page.get_by_role("button", name="1 for later").click()
        window = page.get_by_role("dialog", name="For later")
        window.get_by_role("button", name=re.compile("^Bring back now")).click()
        expect(window).to_have_count(0)
        expect(question).to_be_visible()
        expect(page.locator(".nyq-aside__line")).to_have_count(0)
        self.assertEqual(self.queue()["later"], 0)

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


if __name__ == "__main__":
    unittest.main()
