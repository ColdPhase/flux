"""Browser tests for task announcements in the project conversation (UI116-3, #154).

Creating a task shows one compact "New task" line in the project's stream; the task's first genuine
contribution is a root of the stream that names its task, and replies grow under it. Runs with the
other tests/ui modules through scripts/check_ui.sh against the running Compose application. Ada
manages the project, Jonas writes and Lee only reads. Every count is checked against the API, so
opening, rendering and reloading are shown to create nothing. Screenshots (task-announcements-*.png)
go to FLUX_UI_SCREENSHOTS.
"""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

PASSWORD = "one announcement then the discussion"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ada": ("Ada Kowalska", f"ada.notice+{STAMP}@example.test"),
    "jonas": ("Jonas Berg", f"jonas.notice+{STAMP}@example.test"),
    "lee": ("Lee Park", f"lee.notice+{STAMP}@example.test"),
}
EARLY_TASK = "Sketch the lamp base in cardboard first"
FILLERS = 52
QUESTION = "Should the lamp react to gestures in the dark, or only when someone is close?"
FROM_MESSAGE = "Order two ToF boards for the dark-room test"
MEASURE = "Measure the ToF board at 5 lux"
FIRST_WORD = "I will measure it tonight in the dark room and post the numbers here."
FIRST_REPLY = "Use the black cloth so the shelf does not reflect."
LATER = "Which shop has the boards in stock this week?"
LIVE_TASK = "Write the shop a question about delivery"
LINKED = "Starting on the first chore: does the base need a heavier foot?"
EARLY_CHORES = 10
CHORES = 100
LATER_NOTES = 52
SHORT_NOTES = 20


class TaskAnnouncements(unittest.TestCase):
    """Tests run in name order and share three accounts and one project."""

    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        expect.set_options(timeout=10000)
        contexts: dict[str, BrowserContext] = {}
        for key, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(base_url=ORIGIN)
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.states[key] = context.storage_state()
            contexts[key] = context

        def post(who: str, path: str, body: dict, method: str = "POST") -> dict:
            response = contexts[who].request.fetch(path, method=method, data=body, headers={"origin": ORIGIN})
            assert response.status in (200, 201), f"{path}: {response.status} {response.text()}"
            return response.json()

        ws = post("ada", "/api/v1/workspaces", {"name": "Riverside Makers"})
        for key in ("jonas", "lee"):
            post("ada", f"/api/v1/workspaces/{ws['id']}/members", {"email": PEOPLE[key][1], "role": "member"})
        project = post("ada", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Night lamp", "visibility": "restricted"})
        pid = project["id"]
        post("ada", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": cls.ids["jonas"]}, "role": "contributor"})
        post("ada", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": cls.ids["lee"]}, "role": "viewer"})
        start = lambda who, body: post(who, f"/api/v1/projects/{pid}/conversations", {"body": body, "clientMessageId": str(uuid.uuid4())})  # noqa: E731
        task = lambda who, body: post(who, f"/api/v1/projects/{pid}/work", {**body, "clientCommandId": str(uuid.uuid4())})  # noqa: E731
        # An early task, then more roots than the newest window (50): its announcement waits with them.
        start("ada", "Kick-off: a night lamp that wakes up when you wave at it.")
        early = task("ada", {"title": EARLY_TASK})
        for index in range(1, FILLERS + 1):
            start("ada" if index % 2 else "jonas", f"Earlier note {index:02}: a short idea about the lamp shade, the base or the sensor.")
        question = start("ada", QUESTION)
        from_message = task("jonas", {"title": FROM_MESSAGE, "sources": [{"type": "message", "id": question["messages"][0]["id"]}]})
        measure = task("ada", {"title": MEASURE})
        # The task's first genuine contribution comes from Jonas, not from Ada who created it.
        first = post("jonas", f"/api/v1/work/{measure['id']}/discussion", {"body": FIRST_WORD, "clientMessageId": str(uuid.uuid4())})
        post("ada", f"/api/v1/conversations/{first['conversationId']}/messages", {"body": FIRST_REPLY, "clientMessageId": str(uuid.uuid4())})
        later = start("ada", LATER)
        # Two boards with more announcements than one page (100). The ten oldest announcements arrive after
        # the stream is shown and sit between entries already on screen. On the busy board the roots also
        # take more than one window (50), and the oldest task's discussion opened early.
        def board(name: str, notes: int, discussed: bool) -> tuple[str, dict | None]:
            bid = post("ada", f"/api/v1/workspaces/{ws['id']}/projects", {"name": name, "visibility": "restricted"})["id"]
            start_in = lambda body: post("ada", f"/api/v1/projects/{bid}/conversations", {"body": body, "clientMessageId": str(uuid.uuid4())})  # noqa: E731
            chore = lambda title: post("ada", f"/api/v1/projects/{bid}/work", {"title": title, "clientCommandId": str(uuid.uuid4())})  # noqa: E731
            start_in(f"{name}'s first idea: a list of every small job.")
            early_chores = [chore(f"Early chore {index:02}") for index in range(EARLY_CHORES)]
            opened = post("ada", f"/api/v1/work/{early_chores[0]['id']}/discussion", {"body": LINKED, "clientMessageId": str(uuid.uuid4())}) if discussed else None
            for index in range(CHORES):
                chore(f"Chore {index:03}")
            for index in range(notes):
                start_in(f"Later note {index:02} on the board.")
            return bid, opened

        bid, linked = board("Busy board", LATER_NOTES, True)
        assert linked
        short, _ = board("Short board", SHORT_NOTES, False)
        for context in contexts.values():
            context.close()
        cls.ids.update(project=pid, early=early["id"], question=question["messages"][0]["id"], from_message=from_message["id"], from_message_number=from_message["number"],
                       measure=measure["id"], first=first["id"], thread=first["conversationId"], later=later["messages"][0]["id"],
                       busy=bid, linked=linked["conversationId"], linked_root=linked["id"], short=short)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, who: str, *, phone: bool = False, dark: bool = False, viewport: dict | None = None) -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": "dark" if dark else "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw",
                         "storage_state": self.states[who]}
        if phone:
            options.update(viewport=viewport or PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=viewport or DESKTOP, device_scale_factor=1)
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def api(self, page: Page, method: str, path: str, body: dict | None = None, status: int | None = None) -> dict:
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers={"origin": ORIGIN, "content-type": "application/json"},
                                      data=json.dumps(body) if body is not None else None)
        if status is not None:
            self.assertEqual(response.status, status, response.text())
        return json.loads(response.text()) if response.text() else {}

    def counts(self, page: Page) -> tuple[int, int, int]:
        """Announcements, tasks and roots of the project, as the API reports them."""
        pid = self.ids["project"]
        notices = self.api(page, "GET", f"/api/v1/projects/{pid}/task-notices?limit=100", status=200)
        work = self.api(page, "GET", f"/api/v1/projects/{pid}/work?limit=100", status=200)
        roots = self.api(page, "GET", f"/api/v1/projects/{pid}/conversation-roots?limit=100", status=200)
        return notices["total"], work["total"], len(roots["roots"])

    def notice(self, page: Page, work_id: str):
        return page.locator(f'.convo-notice[data-work-id="{work_id}"]')

    def stream_order(self, page: Page) -> list[str]:
        """The stream's entries from the question onwards: roots by message id, announcements by task id."""
        return page.locator(".project-convo__message-list > li:not(.project-convo__day)").evaluate_all(
            "items => items.map(item => item.dataset.workId ? `task:${item.dataset.workId}` : item.id)")

    def test_01_one_announcement_per_task_in_its_place(self) -> None:
        page = self.page("ada")
        page.goto(f"/projects/{self.ids['project']}")
        stream = page.get_by_role("region", name="Messages")
        expect(stream.locator(f"#message-{self.ids['later']}")).to_be_visible()
        order = self.stream_order(page)
        question = order.index(f"message-{self.ids['question']}")
        self.assertEqual(order[question:], [f"message-{self.ids['question']}", f"task:{self.ids['from_message']}", f"task:{self.ids['measure']}",
                                            f"message-{self.ids['first']}", f"message-{self.ids['later']}"],
                         "announcements sit in time order between the roots, and the first contribution is the task's root")
        made = self.notice(page, self.ids["from_message"])
        expect(made).to_have_count(1)
        expect(made.locator(".convo-notice__meta")).to_have_text("New task · Jonas Berg")
        expect(made.get_by_role("button", name=f"Open task: {FROM_MESSAGE}")).to_be_visible()
        # The announcement names the task by its number in the project (#276).
        expect(made.locator(".convo-notice__num")).to_have_text(f"#{self.ids['from_message_number']}")
        expect(self.notice(page, self.ids["measure"]).locator(".convo-notice__meta")).to_have_text("New task · Ada Kowalska · you")
        # An announcement is not a message: no replies, no actions, no avatar.
        for work_id in (self.ids["from_message"], self.ids["measure"]):
            item = self.notice(page, work_id)
            expect(item.get_by_role("button", name=re.compile("Reply|Create work|Details"))).to_have_count(0)
            expect(item.locator(".ui-avatar")).to_have_count(0)
        # The early task's announcement waits with the earlier roots, then appears in its place.
        expect(self.notice(page, self.ids["early"])).to_have_count(0)
        stream.get_by_role("button", name="Load earlier messages").click()
        expect(self.notice(page, self.ids["early"])).to_have_count(1)
        order = self.stream_order(page)
        self.assertLess(order.index(f"task:{self.ids['early']}"), order.index(f"message-{self.ids['question']}"))
        self.assertEqual(self.counts(page)[0], 3, "exactly one announcement per task")
        self.assertEqual(page.locator(".convo-notice").count(), 3)
        page.locator(f"#message-{self.ids['first']}").scroll_into_view_if_needed()
        shot(page, "task-announcements-desktop")

    def test_02_the_announcement_opens_that_task(self) -> None:
        page = self.page("ada")
        page.goto(f"/projects/{self.ids['project']}")
        made = self.notice(page, self.ids["from_message"])
        made.get_by_role("button", name=f"Open task: {FROM_MESSAGE}").click()
        details = page.locator("#details")
        expect(details.get_by_role("heading", name=FROM_MESSAGE)).to_be_visible()
        # The task made from the question also shows under the question itself, as before.
        question = page.locator(f"#message-{self.ids['question']}")
        expect(question.get_by_role("button", name=f"Work: {FROM_MESSAGE}")).to_be_visible()

    def test_03_the_first_contribution_is_the_tasks_root(self) -> None:
        page = self.page("ada")
        page.goto(f"/projects/{self.ids['project']}")
        root = page.locator(f"#message-{self.ids['first']}")
        expect(root.locator(".project-convo__message-meta strong")).to_have_text("Jonas Berg")
        expect(root.locator("p").first).to_have_text(FIRST_WORD)
        chip = root.get_by_role("button", name=f"Discussion of task: {MEASURE}")
        expect(chip).to_be_visible()
        expect(chip).to_contain_text("Open")
        root.get_by_role("button", name=re.compile("^1 reply")).click()
        thread = page.locator("#thread")
        expect(thread.locator(".project-convo__message", has_text=FIRST_REPLY)).to_be_visible()
        header_chip = thread.get_by_role("button", name=f"Discussion of task: {MEASURE}")
        expect(header_chip).to_be_visible()
        shot(page, "task-announcements-thread")
        # A reply here is the task's discussion: the API's task thread has it under the same root.
        composer = thread.get_by_label("Reply", exact=True)
        composer.fill("Numbers at 5 lux: 97% of waves caught.")
        thread.get_by_role("button", name="Send reply").click()
        expect(thread.locator(".project-convo__message", has_text="Numbers at 5 lux")).to_be_visible()
        discussion = self.api(page, "GET", f"/api/v1/work/{self.ids['measure']}/discussion", status=200)
        self.assertEqual(discussion["rootMessageId"], self.ids["first"])
        self.assertEqual([message["body"] for message in discussion["messages"]][-1], "Numbers at 5 lux: 97% of waves caught.")
        header_chip.click()
        expect(page.locator("#details").get_by_role("heading", name=MEASURE)).to_be_visible()

    def test_04_opening_rendering_and_reloading_create_nothing(self) -> None:
        page = self.page("jonas")
        before = self.counts(page)
        page.goto(f"/projects/{self.ids['project']}")
        expect(self.notice(page, self.ids["measure"])).to_be_visible()
        self.notice(page, self.ids["measure"]).get_by_role("button", name=f"Open task: {MEASURE}").click()
        expect(page.locator("#details").get_by_role("heading", name=MEASURE)).to_be_visible()
        for _ in range(2):
            page.reload()
            expect(self.notice(page, self.ids["measure"])).to_be_visible()
        page.goto(f"/projects/{self.ids['project']}/conversations/{self.ids['thread']}")
        expect(page.locator("#thread")).to_be_visible()
        self.assertEqual(self.counts(page), before, "no announcement, task or root comes from reading")
        expect(page.locator(".convo-notice")).to_have_count(2)

    def test_05_a_new_task_appears_at_the_end_for_someone_reading_it(self) -> None:
        page = self.page("ada")
        page.goto(f"/projects/{self.ids['project']}")
        last = page.locator(f"#message-{self.ids['later']}")
        expect(last).to_be_in_viewport()
        jonas = self.page("jonas")
        created = self.api(jonas, "POST", f"/api/v1/projects/{self.ids['project']}/work",
                           {"title": LIVE_TASK, "clientCommandId": str(uuid.uuid4())}, status=201)
        arrived = self.notice(page, created["id"])
        expect(arrived).to_have_count(1, timeout=25000)
        expect(arrived.locator(".convo-notice__meta")).to_have_text("New task · Jonas Berg")
        expect(arrived, "a reader at the end follows the new announcement").to_be_in_viewport()
        self.assertEqual(self.stream_order(page)[-1], f"task:{created['id']}")
        self.ids["live"] = created["id"]

    def test_06_create_work_from_a_message_announces_it_once(self) -> None:
        page = self.page("ada")
        page.goto(f"/projects/{self.ids['project']}")
        before = self.counts(page)
        later = page.locator(f"#message-{self.ids['later']}")
        later.hover()
        later.get_by_role("button", name="Task", exact=True).click()
        details = page.locator("#details")
        expect(details.get_by_role("heading", name=LATER)).to_be_visible()
        work = self.api(page, "GET", f"/api/v1/projects/{self.ids['project']}/work?limit=100", status=200)
        made = next(item for item in work["items"] if item["title"] == LATER)
        expect(self.notice(page, made["id"])).to_have_count(1)
        expect(self.notice(page, made["id"]).locator(".convo-notice__meta")).to_have_text("New task · Ada Kowalska · you")
        self.assertEqual(self.counts(page), (before[0] + 1, before[1] + 1, before[2]), "one task and one announcement; no root")

    def test_07_a_reader_sees_announcements_and_opens_the_task(self) -> None:
        page = self.page("lee")
        page.goto(f"/projects/{self.ids['project']}")
        made = self.notice(page, self.ids["measure"])
        expect(made.locator(".convo-notice__meta")).to_have_text("New task · Ada Kowalska")
        made.get_by_role("button", name=f"Open task: {MEASURE}").click()
        expect(page.locator("#details").get_by_role("heading", name=MEASURE)).to_be_visible()
        expect(page.get_by_role("button", name="Task", exact=True)).to_have_count(0)

    def test_08_phone_keeps_the_announcement_one_line_and_readable(self) -> None:
        for viewport, dark in (({"width": 390, "height": 844}, True), ({"width": 320, "height": 640}, False)):
            with self.subTest(width=viewport["width"]):
                page = self.page("ada", phone=True, dark=dark, viewport=viewport)
                page.goto(f"/projects/{self.ids['project']}")
                made = self.notice(page, self.ids["from_message"])
                made.scroll_into_view_if_needed()
                button = made.get_by_role("button", name=f"Open task: {FROM_MESSAGE}")
                box, row = button.bounding_box(), made.bounding_box()
                assert box and row
                self.assertGreaterEqual(box["height"], 44, "the link is a full touch target")
                self.assertLessEqual(row["x"] + row["width"], viewport["width"], "no sideways overflow")
                title = made.locator(".convo-notice__title")
                height = title.evaluate("node => node.getBoundingClientRect().height")
                line = title.evaluate("node => parseFloat(getComputedStyle(node).lineHeight) || node.getBoundingClientRect().height")
                self.assertLessEqual(height, line + 1, "a long title stays on one line")
                self.assertEqual(page.evaluate("document.documentElement.scrollWidth <= innerWidth"), True)
                shot(page, f"task-announcements-phone-{viewport['width']}{'-dark' if dark else ''}")


    def open_task_from_stream(self, page: Page, work_id: str, title: str):
        self.notice(page, work_id).get_by_role("button", name=f"Open task: {title}").click()
        details = page.locator("#details")
        expect(details.get_by_role("heading", name=title)).to_be_visible()
        return details.get_by_role("region", name="Discussion")

    def test_09_details_shows_the_tasks_root_and_opens_its_thread(self) -> None:
        page = self.page("ada")
        page.goto(f"/projects/{self.ids['project']}")
        section = self.open_task_from_stream(page, self.ids["measure"], MEASURE)
        link = section.get_by_role("link")
        expect(link).to_contain_text("Jonas Berg")
        expect(link).to_contain_text(FIRST_WORD)
        expect(link).to_contain_text("2 replies · Open in Conversation")
        shot(page, "task-announcements-details-discussion")
        link.click()
        expect(page).to_have_url(re.compile(f"/conversations/{self.ids['thread']}"))
        expect(page.locator("#thread").locator(".project-convo__message", has_text=FIRST_REPLY)).to_be_visible()

    def test_10_details_starts_the_discussion_once_even_after_a_lost_answer(self) -> None:
        page = self.page("ada")
        pid = self.ids["project"]
        page.goto(f"/projects/{pid}")
        before = self.counts(page)
        section = self.open_task_from_stream(page, self.ids["from_message"], FROM_MESSAGE)
        expect(section).to_contain_text("Nobody has written about this task yet.")
        box = section.get_by_label("First message about this task")
        text = "I can pick the boards up on Friday; the shop keeps two for us."
        box.fill(text)
        # The draft is the task's own, kept across a reload under the key every view of the task uses.
        key = f"flux:composer:{self.ids['ada']}:{pid}:task:{self.ids['from_message']}"
        record = page.evaluate("key => JSON.parse(localStorage.getItem(key))", key)
        self.assertEqual(record['version'], 1)
        self.assertEqual(record['body'], text)
        self.assertEqual(record['files'], [])
        self.assertEqual(record['references'], [])
        self.assertFalse(record['unconfirmed'])
        uuid.UUID(record['commandId'])
        page.reload()
        section = self.open_task_from_stream(page, self.ids["from_message"], FROM_MESSAGE)
        box = section.get_by_label("First message about this task")
        expect(box).to_have_value(text)
        self.assertEqual(page.evaluate("key => JSON.parse(localStorage.getItem(key))", key), record)
        # The server stores the first message but its answer is lost: the text stays and nothing claims success.
        path = f"**/api/v1/work/{self.ids['from_message']}/discussion"
        sent: list[str] = []

        def lose(route) -> None:
            sent.append(json.loads(route.request.post_data or "{}").get("clientMessageId", ""))
            response = route.fetch()
            self.assertEqual(response.status, 201, response.text())
            route.abort("connectionreset")

        page.route(path, lose)
        section.get_by_role("button", name="Start the discussion").click()
        expect(section.get_by_role("alert")).to_contain_text("Could not confirm the send")
        expect(box).to_have_value(text)
        kept = page.evaluate("key => JSON.parse(localStorage.getItem(key))", key)
        self.assertEqual(kept, {**record, 'unconfirmed': True})
        self.assertEqual(sent, [record['commandId']])
        page.unroute(path)
        retried: list[str] = []
        page.on("request", lambda request: retried.append(json.loads(request.post_data or "{}").get("clientMessageId", ""))
                if request.method == "POST" and request.url.endswith(f"/work/{self.ids['from_message']}/discussion") else None)
        section.get_by_role("button", name="Start the discussion").click()
        expect(page).to_have_url(re.compile(r"/conversations/[0-9a-f-]+#message-"))
        self.assertEqual(retried, sent, "the retry reuses the first attempt's client message id")
        discussion = self.api(page, "GET", f"/api/v1/work/{self.ids['from_message']}/discussion", status=200)
        self.assertEqual([message["body"] for message in discussion["messages"]], [text], "stored exactly once")
        self.assertEqual(discussion["root"]["authorId"], self.ids["ada"])
        root = page.locator(f"#message-{discussion['rootMessageId']}")
        expect(root.get_by_role("button", name=f"Discussion of task: {FROM_MESSAGE}")).to_be_visible()
        expect(page.locator("#thread")).to_be_visible()
        self.assertEqual(self.counts(page), (before[0], before[1], before[2] + 1), "one new root; no announcement or task")
        cleared = page.evaluate("key => JSON.parse(localStorage.getItem(key))", key)
        self.assertEqual({field: cleared[field] for field in ('version', 'body', 'files', 'references', 'unconfirmed')},
                         {'version': 1, 'body': '', 'files': [], 'references': [], 'unconfirmed': False}, "the confirmed draft is cleared")
        uuid.UUID(cleared['commandId'])
        self.assertNotEqual(cleared['commandId'], record['commandId'])

    def test_11_a_reader_sees_the_discussion_but_cannot_start_one(self) -> None:
        page = self.page("lee")
        page.goto(f"/projects/{self.ids['project']}")
        section = self.open_task_from_stream(page, self.ids["measure"], MEASURE)
        expect(section.get_by_role("link")).to_contain_text(FIRST_WORD)
        page.locator("#details").get_by_role("button", name="Close details").click()
        section = self.open_task_from_stream(page, self.ids["live"], LIVE_TASK)
        expect(section).to_contain_text("Nobody has written about this task yet.")
        expect(section.get_by_role("textbox")).to_have_count(0)
        expect(section.get_by_role("button", name="Start the discussion")).to_have_count(0)

    def hold_earlier_announcements(self, page: Page) -> list:
        """Holds the read of the second announcement page until the test lets it through."""
        held: list = []
        page.route(re.compile(r"/task-notices\?limit=100&offset=100$"), lambda route: held.append(route))
        return held

    def wait_for(self, page: Page, condition, label: str) -> None:
        for _ in range(100):
            if condition():
                return
            page.wait_for_timeout(100)
        self.fail(label)

    def held_root_stays(self, page: Page, held: list, root, expected: int) -> None:
        """Lets the held announcements through and checks the root stays where it is."""
        self.wait_for(page, lambda: bool(held), "the stream reads the earlier announcements")
        page.wait_for_timeout(1500)
        expect(page.locator(".convo-notice")).to_have_count(expected)
        before = root.bounding_box()
        assert before
        held[0].continue_()
        expect(page.locator(".convo-notice")).to_have_count(expected + EARLY_CHORES)
        page.wait_for_timeout(300)
        after = root.bounding_box()
        assert after
        self.assertAlmostEqual(after["y"], before["y"], delta=2, msg="announcements arriving above it do not move it")

    def test_12_late_announcements_keep_a_linked_old_root_in_place(self) -> None:
        # The linked root is older than the newest window: the stream reads back to it first.
        page = self.page("ada")
        held = self.hold_earlier_announcements(page)
        page.goto(f"/projects/{self.ids['busy']}/conversations/{self.ids['linked']}")
        root = page.locator(f"#message-{self.ids['linked_root']}")
        expect(root).to_be_in_viewport()
        expect(page.locator("#thread")).to_be_visible()
        self.held_root_stays(page, held, root, CHORES)
        order = self.stream_order(page)
        early = [index for index, key in enumerate(order) if key.startswith("task:")][:EARLY_CHORES]
        self.assertTrue(all(index < order.index(f"message-{self.ids['linked_root']}") for index in early), "they sit above it, in time order")

    def test_12b_a_link_followed_from_an_open_thread_keeps_the_new_root_in_place(self) -> None:
        page = self.page("ada")
        held = self.hold_earlier_announcements(page)
        page.goto(f"/projects/{self.ids['busy']}")
        newest = page.locator(".project-convo__message", has_text=f"Later note {LATER_NOTES - 1:02} on the board.")
        newest.get_by_role("button", name="Reply").click()
        expect(page.locator("#thread")).to_be_visible()
        page.wait_for_timeout(1200)
        # Search is a link inside the open stream: the thread changes, the stream stays mounted.
        page.keyboard.press("Control+k")
        dialog = page.get_by_role("dialog", name="Jump to")
        dialog.get_by_role("combobox", name="Jump to").fill("heavier foot")
        expect(dialog.get_by_role("option").first).to_contain_text("heavier foot")
        dialog.get_by_role("combobox", name="Jump to").press("Enter")
        expect(page).to_have_url(re.compile(f"/conversations/{self.ids['linked']}"))
        root = page.locator(f"#message-{self.ids['linked_root']}")
        expect(root).to_be_in_viewport()
        self.held_root_stays(page, held, root, CHORES)
        expect(root).to_be_in_viewport()

    def test_12c_load_earlier_keeps_the_reader_through_late_announcements(self) -> None:
        page = self.page("ada")
        held = self.hold_earlier_announcements(page)
        page.goto(f"/projects/{self.ids['busy']}")
        expect(page.locator(".project-convo__message").last).to_be_in_viewport()
        page.wait_for_timeout(2500)
        page.locator(".project-convo__feed").evaluate("feed => { feed.scrollTop = 0; }")
        first = page.locator(".project-convo__message", has_text="Later note 02 on the board.")
        expect(first).to_be_in_viewport()
        page.wait_for_timeout(300)
        before = first.bounding_box()
        page.get_by_role("button", name="Load earlier messages").click()
        expect(page.locator(".project-convo__message", has_text=LINKED)).to_have_count(1)
        page.wait_for_timeout(300)
        loaded = first.bounding_box()
        assert before and loaded
        self.assertAlmostEqual(loaded["y"], before["y"], delta=2, msg="earlier roots join above the reader")
        self.held_root_stays(page, held, first, CHORES)

    def test_13_late_announcements_keep_a_reader_at_the_end(self) -> None:
        page = self.page("ada")
        held = self.hold_earlier_announcements(page)
        page.goto(f"/projects/{self.ids['short']}")
        feed = page.locator(".project-convo__feed")
        at_end = "feed => feed.scrollHeight - feed.scrollTop - feed.clientHeight < 48"
        last = page.locator(".project-convo__message-list > li").last
        expect(last).to_be_in_viewport()
        self.wait_for(page, lambda: bool(held), "the stream reads the earlier announcements")
        # Past the first two seconds, when opening the stream stops holding its end by itself.
        page.wait_for_timeout(2500)
        self.assertTrue(feed.evaluate(at_end))
        held[0].continue_()
        expect(page.locator(".convo-notice")).to_have_count(CHORES + EARLY_CHORES)
        page.wait_for_timeout(300)
        self.assertTrue(feed.evaluate(at_end), "the reader stays at the end")
        expect(page.get_by_text(f"Later note {SHORT_NOTES - 1:02} on the board.")).to_be_in_viewport()

    def test_14_lost_write_access_keeps_the_text_and_stores_nothing(self) -> None:
        page = self.page("jonas")
        pid = self.ids["project"]
        page.goto(f"/projects/{pid}")
        section = self.open_task_from_stream(page, self.ids["live"], LIVE_TASK)
        box = section.get_by_label("First message about this task")
        text = "I will write to the shop tomorrow morning."
        box.fill(text)
        key = f"flux:composer:{self.ids['jonas']}:{pid}:task:{self.ids['live']}"
        original = page.evaluate("key => JSON.parse(localStorage.getItem(key))", key)
        before = self.counts(page)
        ada = self.page("ada")
        self.api(ada, "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": self.ids["jonas"]}, "role": "viewer"}, status=201)
        self.addCleanup(lambda: self.api(ada, "POST", f"/api/v1/projects/{pid}/grants",
                                         {"principal": {"kind": "human", "id": self.ids["jonas"]}, "role": "contributor"}, status=201))
        with page.expect_response(lambda response: response.request.method == 'POST'
                                  and response.url.endswith(f"/work/{self.ids['live']}/discussion")) as refused:
            section.get_by_role("button", name="Start the discussion").click()
        self.assertEqual(refused.value.status, 403)
        expect(section.get_by_role("alert")).to_contain_text("Could not send: your access, a file or a source may be unavailable.")
        expect(section.get_by_role("alert")).to_contain_text("Your draft, files and sources are kept.")
        expect(box).to_have_value(text)
        self.assertEqual(page.evaluate("key => JSON.parse(localStorage.getItem(key))", key),
                         {**original, 'unconfirmed': True})
        self.assertEqual(self.counts(page), before, "no root, announcement or task")
        discussion = self.api(page, "GET", f"/api/v1/work/{self.ids['live']}/discussion", status=200)
        self.assertIsNone(discussion["root"])


if __name__ == "__main__":
    unittest.main()
