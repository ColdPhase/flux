"""Phone conversation first (#296, HIG findings 2/3/7/12/14 on #264, F-023 FF-10).

On a phone the conversation gets the room: reading back through the stream, the view chips and the state line
step aside and come back toward the newest; the thread sheet has a grabber and closes on a drag down or Escape;
search is one tap away from every top-level place; and the stream never opens on a blank gap above the message
box. Real sign-up through the UI, data through the API, Chromium through Playwright with touch emulation.
"""
from __future__ import annotations

import json
import re
import unittest
import uuid

from playwright.sync_api import expect, sync_playwright

from test_app_shell import ORIGIN, UPSTREAM, shot, start_forwarder

PHONE = {"width": 390, "height": 844}
SE = {"width": 375, "height": 667}
PASSWORD = "the conversation comes first"
PROJECT = "Orchard frost watch"
QUESTION = "Which trees should get the first frost sensors?"
LONG = ("The apricots bloom first and lose the most to a late frost, so I would start with the three by the south wall. "
        "The pears can wait a week; they flower later and the wall shelters them less.")


class ConversationFirstJourney(unittest.TestCase):
    """Ada owns one project with a long conversation and one thread; tests share her account and run in name order."""

    ids: dict = {}

    @classmethod
    def setUpClass(cls):
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        expect.set_options(timeout=8000)
        context = cls.browser.new_context(base_url=ORIGIN, viewport={"width": 1280, "height": 800})
        page = context.new_page()
        page.goto("/sign-up")
        page.get_by_label("Name").fill("Ada Orchard")
        page.get_by_label("Email").fill(f"ada.orchard+{uuid.uuid4()}@example.test")
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        cls.state = context.storage_state()
        workspace = cls.call(page, "POST", "/api/v1/workspaces", {"name": "Hillside Growers"}, 201)
        project = cls.call(page, "POST", f"/api/v1/workspaces/{workspace['id']}/projects", {"name": PROJECT, "visibility": "restricted"}, 201)
        pid = project["id"]
        start = lambda body: cls.call(page, "POST", f"/api/v1/projects/{pid}/conversations", {"body": body, "clientMessageId": str(uuid.uuid4())}, 201)  # noqa: E731
        question = start(QUESTION)
        for reply in ("The apricots, they bloom first.", "And one in the low corner, where the cold air sits.", "Agreed, three apricots and the corner."):
            cls.call(page, "POST", f"/api/v1/conversations/{question['conversationId']}/messages", {"body": reply, "clientMessageId": str(uuid.uuid4())}, 201)
        for index in range(1, 19):
            start(LONG if index % 3 == 0 else f"Note {index:02}: checked row {index}, buds still closed.")
        cls.ids.update(project=pid, question=question["messages"][0]["id"] if "messages" in question else question["id"])
        context.close()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    @staticmethod
    def call(page, method, path, body=None, status=200):
        response = page.request.fetch(ORIGIN + path, method=method,
            headers={"origin": ORIGIN, "content-type": "application/json"},
            data=json.dumps(body) if body is not None else None)
        if response.status != status:
            raise AssertionError(f"{method} {path}: {response.status}, expected {status}: {response.text()}")
        return response.json() if response.text() else None

    def page(self, viewport=PHONE, *, reduced=False):
        context = self.browser.new_context(base_url=ORIGIN, viewport=viewport, storage_state=self.state, is_mobile=True, has_touch=True,
            reduced_motion="reduce" if reduced else "no-preference", locale="en-GB", timezone_id="Europe/Warsaw")
        self.addCleanup(context.close)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught browser errors"))
        return page

    def box(self, locator):
        value = locator.bounding_box()
        self.assertIsNotNone(value, f"{locator} has a box")
        return value

    def open_project(self, page):
        page.goto(f"/projects/{self.ids['project']}")
        expect(page.locator(".project-convo__feed.is-stream")).to_be_visible()
        expect(page.locator(".project-convo__feed.is-opening")).to_have_count(0)
        expect(page.get_by_role("navigation", name="Project views")).to_be_visible()

    def wheel(self, page, dy):
        feed = self.box(page.locator(".project-convo__feed.is-stream"))
        page.mouse.move(feed["x"] + feed["width"] / 2, feed["y"] + feed["height"] / 2)
        page.mouse.wheel(0, dy)
        page.wait_for_timeout(250)

    def swipe(self, page, start, end, steps=10, pause=16):
        cdp = page.context.new_cdp_session(page)
        cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": start[0], "y": start[1]}]})
        for step in range(1, steps + 1):
            x = start[0] + (end[0] - start[0]) * step / steps
            y = start[1] + (end[1] - start[1]) * step / steps
            cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x, "y": y}]})
            page.wait_for_timeout(pause)
        cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})

    # ------------------------------------------------------------------ finding 12: search one tap away

    def test_01_search_is_one_tap_from_every_top_level_place(self):
        page = self.page()
        for path in ("/", "/projects", "/dm", "/inbox", "/notes"):
            with self.subTest(path=path):
                page.goto(path)
                search = page.locator("header.top").get_by_role("button", name="Search", exact=True)
                expect(search).to_be_visible()
                self.assertGreaterEqual(self.box(search)["height"], 44, "a 44px target")
                search.tap()
                expect(page.get_by_role("dialog", name="Jump to")).to_be_visible()
                expect(page.get_by_role("combobox", name="Jump to")).to_be_focused()
                page.keyboard.press("Escape")
                expect(page.get_by_role("dialog", name="Jump to")).to_have_count(0)
        # Inside a place the top-left control leads back; the header keeps its room for the place itself.
        self.open_project(page)
        expect(page.locator("header.top").get_by_role("button", name="Search", exact=True)).to_have_count(0)

    # ------------------------------------------------------------------ finding 3: the conversation gets the room

    def test_02_reading_back_the_chips_and_state_line_step_aside(self):
        page = self.page(SE)
        self.open_project(page)
        chips = page.get_by_role("navigation", name="Project views")
        state = page.locator(".state-row")
        expect(state).to_be_visible()
        before = self.box(page.locator(".project-convo__feed.is-stream"))["height"]
        self.wheel(page, -400)
        expect(chips).to_be_hidden()
        expect(state).to_be_hidden()
        page.wait_for_timeout(300)
        self.assertGreater(self.box(page.locator(".project-convo__feed.is-stream"))["height"], before + 60, "the stream takes the room")
        shot(page, "296-reading-back-phone-375")
        # Toward the newest they come back; the bottom bar of places stays throughout.
        expect(page.get_by_role("navigation", name="Main places")).to_be_visible()
        self.wheel(page, 150)
        expect(chips).to_be_visible()
        expect(state).to_be_visible()
        # Reading back again, then reaching the newest, brings them back too.
        self.wheel(page, -400)
        expect(chips).to_be_hidden()
        page.locator(".project-convo__feed.is-stream").evaluate("(feed) => feed.scrollTo(0, feed.scrollHeight)")
        self.wheel(page, 60)
        expect(chips).to_be_visible()
        # Another view starts with its chips in view.
        self.wheel(page, -400)
        expect(chips).to_be_hidden()
        page.get_by_role("navigation", name="Main places").get_by_role("link", name=re.compile("^Home")).tap()
        page.go_back()
        expect(chips).to_be_visible()

    def test_03_under_reduced_motion_the_chips_stay(self):
        page = self.page(SE, reduced=True)
        self.open_project(page)
        self.wheel(page, -400)
        page.wait_for_timeout(200)
        expect(page.get_by_role("navigation", name="Project views")).to_be_visible()
        expect(page.locator(".state-row")).to_be_visible()

    def test_04_the_stream_writes_alone_never_hide_the_chips(self):
        # Opening, settling and new arrivals scroll the stream without the person: the chips stay.
        page = self.page(SE)
        self.open_project(page)
        page.wait_for_timeout(1200)
        expect(page.get_by_role("navigation", name="Project views")).to_be_visible()
        page.locator(".project-convo__feed.is-stream").evaluate("(feed) => { feed.scrollTop = 0; }")
        page.wait_for_timeout(300)
        expect(page.get_by_role("navigation", name="Project views")).to_be_visible()

    # ------------------------------------------------------------------ finding 14: no blank gap above the message box

    def test_05_the_stream_opens_without_a_blank_gap(self):
        page = self.page()
        page.goto(f"/projects/{self.ids['project']}")
        for at in (500, 2000):
            page.wait_for_timeout(at if at == 500 else at - 500)
            gap = page.evaluate("""() => {
              const feed = document.querySelector('.project-convo__feed.is-stream');
              if (!feed || feed.classList.contains('is-opening')) return null;
              const items = feed.querySelectorAll('.project-convo__message, .convo-notice');
              const last = items[items.length - 1];
              const box = feed.getBoundingClientRect();
              return { gap: box.bottom - last.getBoundingClientRect().bottom, height: box.height };
            }""")
            if gap is None:
                continue
            with self.subTest(at=at):
                self.assertLessEqual(gap["gap"], gap["height"] / 4 + 12 + 1, f"at {at} ms the newest entry sits next to the message box")

    # ------------------------------------------------------------------ finding 7: the thread sheet

    def test_06_the_thread_sheet_drags_down_to_close(self):
        page = self.page()
        self.open_project(page)
        root = page.locator(f"#message-{self.ids['question']}")
        root.scroll_into_view_if_needed()
        opener = root.get_by_role("button", name=re.compile(r"^3 replies"))
        opener.tap()
        thread = page.locator("#thread")
        expect(thread).to_have_class(re.compile(r"\bthread--sheet\b"))
        grabber = thread.locator(".thread__grabber")
        expect(grabber).to_be_visible()
        shot(page, "296-thread-sheet-phone-390")
        # A short drag settles back; a long one closes it.
        head = self.box(thread.locator(".thread__head"))
        x, y = head["x"] + head["width"] / 2, head["y"] + 10
        self.swipe(page, (x, y), (x, y + 60))
        page.wait_for_timeout(400)
        expect(thread).to_be_visible()
        self.assertLess(abs(self.box(thread)["y"] - head["y"] + (head["y"] - self.box(thread)["y"])), 2, "it settles back")
        self.swipe(page, (x, y), (x, y + 420))
        expect(page.locator("#thread")).to_have_count(0)
        expect(opener).to_be_focused()
        # Escape closes it from the reply box too.
        opener.tap()
        expect(page.locator("#thread")).to_be_visible()
        reply = page.locator("#thread").get_by_label("Reply", exact=True)
        reply.focus()
        page.keyboard.press("Escape")
        expect(page.locator("#thread")).to_have_count(0)


if __name__ == "__main__":
    unittest.main()
