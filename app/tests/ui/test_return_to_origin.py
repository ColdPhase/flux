"""#592: a visible way back from any opened reference, with the same panel, thread and reading position.

Actual authenticated routes and data, Chromium and WebKit, on the computer (1440 x 900), a tablet (820 x 1180) and a
phone (390 x 844) that reports the installed display mode. Following a reference (a wiki card, a task chip, a linked
decision, a search result, an Inbox item) pushes one history entry that carries its origin; the destination shows one
"‹ <origin>" control; going back (the control, browser Back) restores the origin as it was left: route and filters,
open thread or panel, the message in view at the same offset (also when messages arrived meanwhile), the unsent draft.
The origin is only in the browser's history entry, never on the server, so there is no API path to check.
"""
from __future__ import annotations

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Page, expect, sync_playwright

from test_app_shell import ORIGIN, UPSTREAM, shot, start_forwarder
from test_work_pagination import api

PASSWORD = "return to where the sensor list was"
STAMP = int(time.time() * 1000)
FILLERS = 40
WIKI_AT = 22
REPLIES = 30
CHIP_AT = 12
CITE_AT = 22
TASKS = 40
DECIDED = 30
DESKTOP = {"width": 1440, "height": 900}
TABLET = {"width": 820, "height": 1180}
PHONE = {"width": 390, "height": 844}
SIZES = {"desktop": DESKTOP, "tablet": TABLET, "phone": PHONE}

# The browser reports the installed display mode: a PWA has no browser Back button, so only Flux's own control leads back.
STANDALONE = """(() => {
  const real = window.matchMedia.bind(window);
  window.matchMedia = (query) => {
    const list = real(/display-mode:\\s*standalone/.test(query) ? '(min-width: 0px)' : query);
    if (!/display-mode:\\s*standalone/.test(query)) return list;
    return new Proxy(list, { get: (target, key) => key === 'matches' ? true : key === 'media' ? query : (typeof target[key] === 'function' ? target[key].bind(target) : target[key]) });
  };
})();"""

# How far below a container's top an element is.
OFFSET = """([feed, target]) => document.querySelector(target).getBoundingClientRect().top - document.querySelector(feed).getBoundingClientRect().top"""
# Brings an element to `at` px below a container's top.
PLACE = """([feed, target, at]) => {
  const pane = document.querySelector(feed);
  pane.scrollTop += document.querySelector(target).getBoundingClientRect().top - pane.getBoundingClientRect().top - at;
}"""
AWAY = """(feed) => { const el = document.querySelector(feed); return el.scrollHeight - el.clientHeight - el.scrollTop; }"""


def lines(count: int, topic: str) -> str:
    return "\n".join(f"{topic} {index + 1}: the shade, the base and the sensor must still read the dark room." for index in range(count))


class ReturnToOrigin(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browsers = {name: getattr(cls.pw, name).launch() for name in ("chromium", "webkit")}
        expect.set_options(timeout=10000)
        cls.setup_content()

    @classmethod
    def tearDownClass(cls):
        for context in cls.contexts.values():
            context.close()
        for browser in cls.browsers.values():
            browser.close()
        cls.pw.stop()

    @classmethod
    def setup_content(cls):
        browser = cls.browsers["chromium"]
        cls.contexts, cls.users, cls.states = {}, {}, {}
        for key, name in (("ada", "Ada Kowalska"), ("jonas", "Jonas Berg")):
            context = browser.new_context(service_workers="block", base_url=ORIGIN)
            email = f"{key}.origin+{STAMP}@example.test"
            api(context, "POST", "/api/auth/sign-up/email", {"name": name, "email": email, "password": PASSWORD})
            cls.users[key] = {"id": api(context, "GET", "/api/v1/me")["user"]["id"], "email": email, "name": name}
            cls.contexts[key] = context
        ada, jonas = cls.contexts["ada"], cls.contexts["jonas"]
        space = api(ada, "POST", "/api/v1/workspaces", {"name": "Riverside makers"}, 201)
        cls.workspace = space["id"]
        api(ada, "POST", f"/api/v1/workspaces/{space['id']}/members", {"email": cls.users["jonas"]["email"], "role": "member"}, 201)
        cls.project = api(ada, "POST", f"/api/v1/workspaces/{space['id']}/projects", {"name": "Night lamp", "visibility": "restricted"}, 201)["id"]
        root = f"/api/v1/projects/{cls.project}"
        api(ada, "POST", root + "/grants", {"principal": {"kind": "human", "id": cls.users["jonas"]["id"]}, "role": "contributor"}, 201)

        def start(who, body, project=None, **extra):
            return api(cls.contexts[who], "POST", f"/api/v1/projects/{project or cls.project}/conversations", {"body": body, "clientMessageId": str(uuid.uuid4()), **extra}, 201)

        def reply(who, conversation, body, **extra):
            return api(cls.contexts[who], "POST", f"/api/v1/conversations/{conversation}/messages", {"body": body, "clientMessageId": str(uuid.uuid4()), **extra}, 201)

        cls.start, cls.reply = staticmethod(start), staticmethod(reply)
        cls.material = api(ada, "POST", root + "/materials", {"title": "Sensor shortlist", "body": "Three ToF boards and one camera, ranked by how they read in the dark.", "clientMutationId": str(uuid.uuid4())}, 201)
        cite = {"materialId": cls.material["materialId"], "version": cls.material["version"]}
        cls.wiki_message = None
        for index in range(1, FILLERS + 1):
            who = "ada" if index % 2 else "jonas"
            if index == WIKI_AT:
                started = start(who, "Sensor shortlist for the lamp, ranked.\n" + lines(2, "Ranking"), source=cite)
                cls.wiki_message = started["messages"][0]["id"]
            else:
                start(who, f"Earlier note {index:02}: a short idea about the lamp shade, the base or the sensor.\n" + lines(3, "Detail"))
        # A root with replies: one has a task made from it, another cites the shortlist.
        thread = start("ada", "Which sensor do we order first for the lamp?\n" + lines(2, "Question"))
        cls.thread, cls.thread_root = thread["id"], thread["messages"][0]["id"]
        cls.replies = [reply("jonas" if index % 2 else "ada", thread["id"], f"Reply {index + 1}: {lines(2, 'Thought')}", **({"source": cite} if index + 1 == CITE_AT else {}))["id"] for index in range(REPLIES)]
        cls.chip_reply, cls.cite_reply = cls.replies[CHIP_AT - 1], cls.replies[CITE_AT - 1]
        api(ada, "POST", root + "/work", {"title": "Order the ToF boards", "owner": {"kind": "human", "id": cls.users["ada"]["id"]}, "sources": [{"type": "message", "id": cls.chip_reply}]}, 201)
        # Tasks Ada owns; one has a decision about it and the message it came from.
        cls.tasks = [api(ada, "POST", root + "/work", {"title": f"Check the lamp sensor {index:02}", "owner": {"kind": "human", "id": cls.users["ada"]["id"]},
                                                       "sources": [{"type": "message", "id": cls.wiki_message}] if index == DECIDED else []}, 201) for index in range(1, TASKS + 1)]
        decision = api(ada, "POST", root + "/decisions", {"title": "Use the distance sensor", "affects": [cls.tasks[DECIDED - 1]["id"]]}, 201)
        api(ada, "POST", f"/api/v1/decisions/{decision['id']}/accept", {"expectedVersion": 1})
        # What needs Ada: decisions Jonas proposes.
        for index in range(1, 11):
            api(jonas, "POST", root + "/decisions", {"title": f"Proposal {index:02}: prefer the ToF board for case {index}", "rationale": lines(3, "Reason")}, 201)
        # A second project, which Ada opens from the sidebar.
        cls.garden = cls.make_project("Garden sensors")["id"]
        for key, context in cls.contexts.items():
            cls.states[key] = context.storage_state()

    @classmethod
    def make_project(cls, name):
        """A project Ada owns where Jonas is a contributor, with a few roots by Ada; returns its id and Jonas's grant."""
        ada = cls.contexts["ada"]
        project = api(ada, "POST", f"/api/v1/workspaces/{cls.workspace}/projects", {"name": name, "visibility": "restricted"}, 201)["id"]
        grant = api(ada, "POST", f"/api/v1/projects/{project}/grants", {"principal": {"kind": "human", "id": cls.users["jonas"]["id"]}, "role": "contributor"}, 201)["id"]
        for index in range(1, 8):
            cls.start("ada", f"{name} note {index:02}: probes, wires and rain.\n" + lines(3, "Detail"), project=project)
        return {"id": project, "grant": grant}

    @classmethod
    def make_dm(cls, tag, count, replies=0):
        """A direct message between Ada and a new colleague (`tag`) with `count` roots and `replies` replies under the first; returns its id and the ids."""
        ada = cls.contexts["ada"]
        context = cls.browsers["chromium"].new_context(service_workers="block", base_url=ORIGIN)
        email = f"{tag}.origin+{STAMP}@example.test"
        api(context, "POST", "/api/auth/sign-up/email", {"name": f"Kai {tag}", "email": email, "password": PASSWORD})
        cls.users[tag] = {"id": api(context, "GET", "/api/v1/me")["user"]["id"], "email": email, "name": f"Kai {tag}"}
        cls.contexts[tag], cls.states[tag] = context, context.storage_state()
        api(ada, "POST", f"/api/v1/workspaces/{cls.workspace}/members", {"email": email, "role": "member"}, 201)
        response = ada.request.fetch(f"{ORIGIN}/api/v1/workspaces/{cls.workspace}/dms", method="POST", headers={"origin": ORIGIN, "content-type": "application/json"},
                                     data=json.dumps({"participantIds": [cls.users[tag]["id"]]}))
        assert response.status in (200, 201), response.text()
        dm = response.json()["id"]
        ids = []
        for index in range(1, count + 1):
            who = ada if index % 2 else context
            ids.append(api(who, "POST", f"/api/v1/dms/{dm}/messages", {"body": f"Note {index:02}: the shade, the base and the sensor.\n" + lines(2, "Detail"), "clientMessageId": str(uuid.uuid4())}, 201)["id"])
        answers = [api(ada if index % 2 else context, "POST", f"/api/v1/dms/{dm}/threads/{ids[0]}/replies",
                       {"body": f"Reply {index:02}: the range, the angle and the dark.\n" + lines(2, "Thought"), "clientMessageId": str(uuid.uuid4())}, 201)["id"] for index in range(1, replies + 1)]
        return {"id": dm, "roots": ids, "replies": answers, "partner": tag}

    def jump_to_search(self, page, query="shade"):
        """⌘K, a query, "See all results": the Search page, opened as a reference from wherever the person was reading."""
        page.evaluate("() => document.activeElement && document.activeElement.blur()")
        page.keyboard.press("Control+k")
        palette = page.get_by_role("dialog", name="Jump to")
        palette.locator("input").fill(query)
        palette.locator(".jump__all").click()
        expect(page).to_have_url(f"{ORIGIN}/search?q={query}")

    # ---- harness ----

    def page(self, engine="chromium", size="desktop", who="ada") -> Page:
        touch = size != "desktop"
        context = self.browsers[engine].new_context(service_workers="block", base_url=ORIGIN, storage_state=self.states[who], viewport=SIZES[size],
                                                    has_touch=touch, is_mobile=size == "phone", device_scale_factor=2 if touch else 1)
        self.addCleanup(context.close)
        if touch:
            context.add_init_script(STANDALONE)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught browser errors"))
        return page

    def activate(self, locator, tap):
        locator.tap() if tap else locator.click()

    def press_in_place(self, page, locator, tap):
        """A real click or tap at the middle of what is already in view: the browser's own scrolling before an automated click would move the place being measured."""
        box = locator.bounding_box()
        x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
        page.touchscreen.tap(x, y) if tap else page.mouse.click(x, y)

    def wait_stream(self, page):
        page.locator(".project-convo__feed.is-stream:not(.is-opening)").wait_for()
        # The stream opens on its latest and settles for a moment before it belongs to the reader.
        page.wait_for_timeout(2300)

    def wait_thread(self, page):
        page.locator(".thread__feed:not(.is-opening)").wait_for()
        page.wait_for_timeout(1500)

    def stream_ready(self, page):
        page.locator(".project-convo__feed.is-stream:not(.is-opening)").wait_for()
        page.wait_for_timeout(1200)

    def read_at(self, page, feed, target, at, touch=False):
        """Puts a message `at` px below the container's top the way a reader does: some input of their own first."""
        if touch:
            # Mobile WebKit exposes no wheel; a touch gesture on the container is the reader's own input there.
            page.evaluate("""(feed) => { const el = document.querySelector(feed); el.dispatchEvent(new Event('touchstart', { bubbles: true })); el.dispatchEvent(new Event('touchmove', { bubbles: true })); }""", feed)
        else:
            box = page.locator(feed).bounding_box()
            page.mouse.move(box["x"] + box["width"] / 2, box["y"] + min(box["height"] / 2, 300))
            page.mouse.wheel(0, -400)
            page.wait_for_timeout(500)
        page.evaluate(PLACE, [feed, target, at])
        page.wait_for_timeout(600)

    def offset(self, page, feed, target):
        return page.evaluate(OFFSET, [feed, target])

    def origin_back(self, page, label=None):
        return page.get_by_role("button", name=f"Back to {label}" if label else re.compile(r"^Back to "))

    def assert_same(self, before, after, what, tolerance=1.5):
        self.assertLessEqual(abs(before - after), tolerance, f"{what}: {before:.1f} before, {after:.1f} after")

    def box(self, locator):
        box = locator.bounding_box()
        return round(box["x"], 1), round(box["y"], 1)

    def row_offset(self, row):
        """How far below the page's list top a row is."""
        return row.evaluate("(el) => el.getBoundingClientRect().top - document.querySelector('#content .pane-scroll').getBoundingClientRect().top")

    # ---- a conversation scrolled up, a wiki card, and back ----

    def wiki_journey(self, engine, size, via, reload=False):
        page = self.page(engine, size)
        tap = size != "desktop"
        page.goto(f"/projects/{self.project}")
        self.wait_stream(page)
        feed, target = ".project-convo__feed.is-stream", f"#message-{self.wiki_message}"
        self.read_at(page, feed, target, 140, touch=tap and engine == "webkit")
        page.locator("#project-composer").fill("Draft: ask Jonas about the ToF range")
        # What is followed is in full view first, so that following it moves nothing; the place is measured as it is then.
        page.locator(f"{target} .wiki-card").scroll_into_view_if_needed()
        page.wait_for_timeout(600)
        before = self.offset(page, feed, target)
        self.assertGreater(page.evaluate("(feed) => document.querySelector(feed).scrollTop", feed), 0)
        self.assertEqual(self.origin_back(page).count(), 0, "a conversation opened by its address has no way back")
        # Something arrives while the person is away: the place they return to must not jump.
        self.start("jonas", f"While you were reading the shortlist ({engine}, {size}): the ToF board arrived.")
        history = page.evaluate("history.length")
        self.press_in_place(page, page.locator(f"{target} .wiki-card"), tap)
        expect(page).to_have_url(re.compile(r"/materials/[0-9a-f-]{36}/versions/1$"))
        expect(page.get_by_role("heading", name="Sensor shortlist")).to_be_visible()
        self.assertEqual(page.evaluate("history.length"), history + 1, "following a reference adds one history entry")
        back = self.origin_back(page, "Conversation")
        expect(back).to_have_count(1)
        expect(back).to_be_visible()
        shot(page, f"592-wiki-card-destination-{engine}-{size}")
        if reload:
            page.reload()
            back = self.origin_back(page, "Conversation")
            expect(back).to_have_count(1)
        # Every frame from here on in which the stream is visible must show the message where it was: no flash of another place.
        page.evaluate("""([target]) => {
          window.__frames = [];
          const sample = () => {
            const feed = document.querySelector('.project-convo__feed.is-stream');
            const el = document.querySelector(target);
            if (feed && el && !feed.classList.contains('is-opening') && feed.getClientRects().length) window.__frames.push(Math.round(el.getBoundingClientRect().top - feed.getBoundingClientRect().top));
            requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        }""", [target])
        if via == "control":
            self.activate(back, tap)
        else:
            page.go_back()
        expect(page).to_have_url(f"{ORIGIN}/projects/{self.project}")
        self.stream_ready(page)
        frames = page.evaluate("window.__frames")
        self.assertTrue(frames, "the stream was seen")
        self.assertTrue(all(abs(frame - before) <= 2 for frame in frames), f"the stream never showed another place while returning: {sorted(set(frames))} against {before:.1f}")
        expect(page.locator("#project-composer")).to_have_value("Draft: ask Jonas about the ToF range")
        self.assert_same(before, self.offset(page, feed, target), "the wiki message stays where it was, with new messages below")
        self.assertGreater(page.evaluate(AWAY, feed), 150, "no jump to the bottom")
        self.assertEqual(page.evaluate("history.length"), history + 1, "Back returns one step; Forward is still there")
        shot(page, f"592-wiki-card-returned-{engine}-{size}")
        # Forward leads to the object again, with its way back.
        page.go_forward()
        expect(page).to_have_url(re.compile(r"/materials/"))
        expect(self.origin_back(page, "Conversation")).to_have_count(1)

    def test_01_wiki_card_back_by_the_control(self):
        for engine in self.browsers:
            with self.subTest(engine=engine):
                self.wiki_journey(engine, "desktop", "control")

    def test_02_wiki_card_back_by_the_browser(self):
        for engine in self.browsers:
            with self.subTest(engine=engine):
                self.wiki_journey(engine, "desktop", "browser")

    def test_03_reload_on_the_destination_keeps_the_way_back(self):
        for engine in self.browsers:
            with self.subTest(engine=engine):
                self.wiki_journey(engine, "desktop", "control", reload=True)

    # ---- an open thread, a task chip, and back ----

    def thread_journey(self, engine, size):
        page = self.page(engine, size)
        tap = size != "desktop"
        page.goto(f"/projects/{self.project}/conversations/{self.thread}")
        self.wait_thread(page)
        feed, target = ".thread__feed", f"#message-{self.chip_reply}"
        # The thread is the one panel: a sheet on the phone (the person may have lowered it to half height), an overlay on a tablet.
        sheet = page.locator("#details[data-detent-sheet]")
        if size == "phone":
            expect(sheet).to_have_count(1)
            self.activate(sheet.locator(".ui-grabber"), tap)
            expect(sheet).to_have_attribute("data-height", "half")
        self.read_at(page, feed, target, 20 if size == "phone" else 120, touch=tap and engine == "webkit")
        page.locator("#thread-composer").fill("Draft reply: the ToF board first")
        page.locator(f"{target} button.ws-chip").scroll_into_view_if_needed()
        page.wait_for_timeout(600)
        before = self.offset(page, feed, target)
        height = page.locator("#details").bounding_box()["height"]
        url, history = page.url, page.evaluate("history.length")
        chip = page.locator(f"{target} button.ws-chip")
        expect(chip).to_have_count(1)
        self.press_in_place(page, chip, tap)
        # The task takes the panel's place and leaves the panel's own way back to the thread (one back pattern, not a second control).
        panel = page.locator("#details")
        expect(panel.get_by_role("heading", name="Order the ToF boards")).to_be_visible()
        back = panel.locator(".ui-panel__back")
        expect(back).to_have_text("Thread")
        expect(self.origin_back(page)).to_have_count(0)
        shot(page, f"592-task-chip-{engine}-{size}")
        self.activate(back, tap)
        expect(page.locator("#thread")).to_be_visible()
        expect(panel.locator(".ui-panel__back")).to_have_count(0)
        self.assertEqual(page.url, url, "opening and closing a panel keeps the route")
        self.assertEqual(page.evaluate("history.length"), history, "a panel is not a history entry")
        expect(page.locator("#thread")).to_be_visible()
        page.wait_for_timeout(1000)
        expect(page.locator("#thread-composer")).to_have_value("Draft reply: the ToF board first")
        self.assert_same(before, self.offset(page, feed, target), "the reply with the chip stays where it was")
        self.assertLess(abs(page.locator("#details").bounding_box()["height"] - height), 2, "the thread keeps its height")
        if size == "phone":
            expect(sheet).to_have_attribute("data-height", "half")

    def test_04_thread_task_chip_back(self):
        for engine in self.browsers:
            with self.subTest(engine=engine):
                self.thread_journey(engine, "desktop")

    # ---- an open thread, a cited wiki page in it, and back ----

    def thread_wiki_journey(self, engine, size):
        page = self.page(engine, size)
        tap = size != "desktop"
        page.goto(f"/projects/{self.project}/conversations/{self.thread}")
        self.wait_thread(page)
        feed, target = ".thread__feed", f"#message-{self.cite_reply}"
        sheet = page.locator("#details[data-detent-sheet]")
        if size == "phone":
            expect(sheet).to_have_count(1)
            self.activate(sheet.locator(".ui-grabber"), tap)
            expect(sheet).to_have_attribute("data-height", "half")
        self.read_at(page, feed, target, 20 if size == "phone" else 110, touch=tap and engine == "webkit")
        page.locator("#thread-composer").fill("Draft reply: shortlist first")
        page.locator(f"{target} .wiki-card").scroll_into_view_if_needed()
        page.wait_for_timeout(600)
        before = self.offset(page, feed, target)
        height = page.locator("#details").bounding_box()["height"]
        url, history = page.url, page.evaluate("history.length")
        self.reply("jonas", self.thread, f"A late reply while you read the shortlist ({engine}, {size}).")
        self.press_in_place(page, page.locator(f"{target} .wiki-card"), tap)
        expect(page).to_have_url(re.compile(r"/materials/[0-9a-f-]{36}/versions/1$"))
        back = self.origin_back(page, "Thread")
        expect(back).to_have_count(1)
        shot(page, f"592-thread-wiki-destination-{engine}-{size}")
        self.activate(back, tap)
        expect(page).to_have_url(url)
        self.assertEqual(page.evaluate("history.length"), history + 1)
        self.wait_thread(page)
        expect(page.locator("#thread-composer")).to_have_value("Draft reply: shortlist first")
        self.assert_same(before, self.offset(page, feed, target), "the cited reply stays where it was in the thread")
        self.assertGreater(page.evaluate(AWAY, feed), 100, "the thread did not jump to its end")
        self.assertLess(abs(page.locator("#details").bounding_box()["height"] - height), 2, "the thread keeps its height")
        if size == "phone":
            expect(sheet).to_have_attribute("data-height", "half")
        shot(page, f"592-thread-wiki-returned-{engine}-{size}")

    def test_05_thread_wiki_back(self):
        for engine in self.browsers:
            with self.subTest(engine=engine):
                self.thread_wiki_journey(engine, "desktop")

    # ---- Tasks with a filter and an open panel, a linked decision and a source, and back ----

    def tasks_journey(self, engine, size):
        page = self.page(engine, size)
        tap = size != "desktop"
        address = f"/projects/{self.project}/tasks?show=mine&view=list"
        page.goto(address)
        expect(page.locator(".ws-task").first).to_be_visible()
        row = page.locator(".ws-task").filter(has_text=f"Check the lamp sensor {DECIDED:02}")
        row.scroll_into_view_if_needed()
        page.locator("#content .pane-scroll").evaluate("(el, row) => { el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - 140; }", row.element_handle())
        page.wait_for_timeout(600)
        self.assertGreater(page.locator("#content .pane-scroll").evaluate("el => el.scrollTop"), 100)
        self.activate(row.locator(".ws-item"), tap)
        panel = page.locator("#details")
        expect(panel).to_be_visible()
        expect(panel.get_by_role("heading", name=f"Check the lamp sensor {DECIDED:02}")).to_be_visible()
        # A decision about the task, one step away in the panel: it replaces the panel's content and leads back to the task.
        link = panel.locator("button.wd-link", has_text="Use the distance sensor")
        link.scroll_into_view_if_needed()
        self.activate(link, tap)
        expect(panel.get_by_role("heading", name="Use the distance sensor")).to_be_visible()
        back = panel.locator(".ui-panel__back")
        expect(back).to_have_text(re.compile(r"^Task #\d+$"))
        shot(page, f"592-linked-decision-{engine}-{size}")
        url, history = page.url, page.evaluate("history.length")
        self.activate(back, tap)
        expect(panel.get_by_role("heading", name=f"Check the lamp sensor {DECIDED:02}")).to_be_visible()
        page.wait_for_timeout(900)
        listing = page.url
        self.assertEqual(page.url, url)
        self.assertEqual(page.evaluate("history.length"), history, "an object replacing an object in the panel is not a history entry")
        # The message the task came from is another page: one history entry, and back restores the list, the filter and the panel.
        source = panel.locator("a.wd-link").first
        source.scroll_into_view_if_needed()
        row = page.locator(".ws-task").filter(has_text=f"Check the lamp sensor {DECIDED:02}")
        before = self.row_offset(row)
        panel_before = panel.locator(".ui-panel__body").evaluate("el => el.scrollTop") if panel.locator(".ui-panel__body").count() else 0
        self.activate(source, tap)
        expect(page).to_have_url(re.compile(r"/projects/[0-9a-f-]{36}/conversations/[0-9a-f-]{36}#message-"))
        self.assertEqual(page.evaluate("history.length"), history + 1)
        if size == "desktop":
            back = self.origin_back(page, "Tasks")
            expect(back).to_have_count(1)
            self.activate(back, tap)
        else:
            # The panel stays over the page as a modal overlay or sheet and covers its header: its visible back leads to the task it
            # came from, on the task list it was opened on (not to the conversation the source message belongs to).
            back = panel.locator(".ui-panel__back")
            expect(back).to_have_text(re.compile(r"^Task #\d+$"))
            box = back.bounding_box()
            self.assertTrue(page.evaluate("([x, y]) => !!document.elementFromPoint(x, y)?.closest('.ui-panel__back')", [box["x"] + box["width"] / 2, box["y"] + box["height"] / 2]), "the back is not covered by anything")
            self.activate(back, tap)
        expect(page).to_have_url(listing)
        self.assertIn("show=mine", listing)
        expect(page.locator("#details").get_by_role("heading", name=f"Check the lamp sensor {DECIDED:02}")).to_be_visible()
        row = page.locator(".ws-task").filter(has_text=f"Check the lamp sensor {DECIDED:02}")
        expect(row).to_be_visible()
        page.wait_for_timeout(800)
        self.assert_same(before, self.row_offset(row), "the task row stays where it was in the list")
        self.assertGreater(page.locator("#content .pane-scroll").evaluate("el => el.scrollTop"), 100)
        self.assertLessEqual(abs(page.locator("#details .ui-panel__body").evaluate("el => el.scrollTop") - panel_before), 2, "the panel keeps its reading position")

    def test_06_tasks_linked_decision_and_source_back(self):
        for engine in self.browsers:
            with self.subTest(engine=engine):
                self.tasks_journey(engine, "desktop")

    # ---- search, a result, and back ----

    def search_journey(self, engine, size):
        page = self.page(engine, size)
        tap = size != "desktop"
        page.goto("/search?q=shade")
        group = page.get_by_role("region", name="Results").locator("section[aria-label='Messages']")
        expect(group.locator("a.sr").first).to_be_visible()
        self.activate(group.get_by_role("button", name=re.compile(r"^Show \d+ more")), tap)
        expect(group.locator("a.sr")).to_have_count(20)
        pick = group.locator("a.sr").nth(15)
        pick.scroll_into_view_if_needed()
        page.locator("#content .pane-scroll").evaluate("el => { el.scrollTop += 30; }")
        page.wait_for_timeout(600)
        label = pick.inner_text()
        before = self.row_offset(pick)
        self.assertGreater(page.locator("#content .pane-scroll").evaluate("el => el.scrollTop"), 100)
        self.assertEqual(self.origin_back(page).count(), 0)
        history = page.evaluate("history.length")
        self.activate(pick, tap)
        expect(page).to_have_url(re.compile(r"/projects/[0-9a-f-]{36}/conversations/[0-9a-f-]{36}#message-"))
        self.assertEqual(page.evaluate("history.length"), history + 1)
        if size == "desktop":
            back = self.origin_back(page, "Search")
        else:
            # The thread a result leads to is the one panel, a modal sheet or overlay here that covers the header: the panel's own
            # back carries the way to the search.
            back = page.locator("#details .ui-panel__back")
            expect(back).to_have_text("Search")
        expect(back).to_have_count(1)
        shot(page, f"592-search-result-{engine}-{size}")
        self.activate(back, tap)
        expect(page).to_have_url(f"{ORIGIN}/search?q=shade")
        group = page.get_by_role("region", name="Results").locator("section[aria-label='Messages']")
        expect(group.locator("a.sr")).to_have_count(20)
        expect(page.get_by_role("searchbox")).to_have_value("shade")
        row = group.locator("a.sr").nth(15)
        self.assertEqual(row.inner_text(), label)
        page.wait_for_timeout(900)
        self.assert_same(before, self.row_offset(row), "the result stays where it was in the list")

    def test_07_search_result_back(self):
        for engine in self.browsers:
            with self.subTest(engine=engine):
                self.search_journey(engine, "desktop")

    # ---- the Inbox, an item, and back ----

    def inbox_journey(self, engine, size):
        page = self.page(engine, size)
        tap = size != "desktop"
        page.goto("/inbox")
        self.activate(page.get_by_role("tab", name=re.compile(r"^Decisions")), tap)
        cards = page.locator(".nyc")
        expect(cards).to_have_count(10)
        card = cards.filter(has_text="Proposal 04")
        # J selects the next item: the selected item is part of the place.
        for _ in range(12):
            if card.get_attribute("aria-current") == "true":
                break
            page.keyboard.press("j")
            page.wait_for_timeout(120)
        expect(card).to_have_attribute("aria-current", "true")
        page.locator("#content .pane-scroll").evaluate("(el, card) => { el.scrollTop += card.getBoundingClientRect().top - el.getBoundingClientRect().top - 140; }", card.element_handle())
        page.wait_for_timeout(600)
        before = self.row_offset(card)
        self.assertGreater(page.locator("#content .pane-scroll").evaluate("el => el.scrollTop"), 100)
        history = page.evaluate("history.length")
        self.activate(card.get_by_role("button", name="Discuss"), tap)
        expect(page).to_have_url(f"{ORIGIN}/projects/{self.project}")
        self.assertEqual(page.evaluate("history.length"), history + 1)
        back = self.origin_back(page, "Inbox")
        expect(back).to_have_count(1)
        shot(page, f"592-inbox-item-{engine}-{size}")
        self.activate(back, tap)
        expect(page).to_have_url(f"{ORIGIN}/inbox")
        expect(page.get_by_role("tab", name=re.compile(r"^Decisions"))).to_have_attribute("aria-selected", "true")
        card = page.locator(".nyc").filter(has_text="Proposal 04")
        expect(card).to_be_visible()
        expect(card).to_have_attribute("aria-current", "true")
        page.wait_for_timeout(900)
        self.assert_same(before, self.row_offset(card), "the item stays where it was in the list")

    def test_08_inbox_item_back(self):
        for engine in self.browsers:
            with self.subTest(engine=engine):
                self.inbox_journey(engine, "desktop")

    # ---- the control sits in one place and only where there is an origin ----

    def test_09_one_place_on_every_destination_and_none_from_the_sidebar(self):
        for engine in self.browsers:
            with self.subTest(engine=engine):
                page = self.page(engine)
                places = {}
                # A wiki card, a search result and an Inbox item: three kinds of destination, one control.
                page.goto(f"/projects/{self.project}")
                self.wait_stream(page)
                card = page.locator(f"#message-{self.wiki_message} .wiki-card")
                card.scroll_into_view_if_needed()
                card.click()
                places["wiki card"] = self.box(self.origin_back(page, "Conversation"))
                page.go_back()
                page.goto("/search?q=shade")
                page.get_by_role("region", name="Results").locator("a.sr").first.click()
                expect(page).to_have_url(re.compile(r"/conversations/"))
                places["search result"] = self.box(self.origin_back(page, "Search"))
                page.goto("/inbox")
                page.get_by_role("tab", name=re.compile(r"^Decisions")).click()
                page.locator(".nyc").first.get_by_role("button", name="Discuss").click()
                expect(page).to_have_url(f"{ORIGIN}/projects/{self.project}")
                places["inbox item"] = self.box(self.origin_back(page, "Inbox"))
                self.assertEqual(len(set(places.values())), 1, f"the control never changes place: {places}")
                # The sidebar is not a reference: no control, and no origin in the history entry.
                page.get_by_role("complementary", name="Sidebar").get_by_role("link", name=re.compile("Garden sensors")).click()
                expect(page).to_have_url(f"{ORIGIN}/projects/{self.garden}")
                expect(page.get_by_role("heading", name="Garden sensors", level=1)).to_be_visible()
                expect(self.origin_back(page)).to_have_count(0)
                self.assertIsNone(page.evaluate("(history.state && history.state.usr && history.state.usr.origin) || null"))

    # ---- the origin is gone ----

    def test_10_a_lost_origin_has_no_control_and_back_lands_on_a_parent_with_a_note(self):
        for engine in self.browsers:
            with self.subTest(engine=engine):
                lost = self.make_project(f"Greenhouse {engine}")
                page = self.page(engine, who="jonas")
                page.goto(f"/projects/{lost['id']}")
                self.wait_stream(page)
                # Ada's name in the conversation opens her conversation with him: a reference to a person.
                page.locator("a.project-convo__person").first.click()
                expect(page).to_have_url(re.compile(r"/dm/[0-9a-f-]{36}$"))
                expect(self.origin_back(page, "Conversation")).to_have_count(1)
                page.go_back()
                expect(page).to_have_url(f"{ORIGIN}/projects/{lost['id']}")
                self.stream_ready(page)
                # Ada takes Jonas's access away while the conversation is open on his screen.
                response = self.contexts["ada"].request.delete(f"{ORIGIN}/api/v1/projects/{lost['id']}/grants/{lost['grant']}", headers={"origin": ORIGIN})
                self.assertIn(response.status, (200, 204), response.text())
                page.locator("a.project-convo__person").first.click()
                expect(page).to_have_url(re.compile(r"/dm/[0-9a-f-]{36}$"))
                expect(page.get_by_role("heading", name=re.compile("Ada Kowalska")).first).to_be_visible()
                expect(self.origin_back(page)).to_have_count(0)
                # Back lands on the nearest place that still opens, with one line, never an error page.
                page.go_back()
                expect(page).to_have_url(f"{ORIGIN}/projects")
                expect(page.get_by_text("That project is no longer available to you.")).to_be_visible()
                expect(page.get_by_role("heading", name="This place isn’t available")).to_have_count(0)
                expect(page.get_by_role("heading", name="Something went wrong")).to_have_count(0)

    # ---- a replace on the destination keeps the way back ----

    def test_14_a_replace_on_the_destination_keeps_the_way_back(self):
        for engine in self.browsers:
            with self.subTest(engine=engine):
                page = self.page(engine)
                page.goto(f"/projects/{self.project}")
                self.wait_stream(page)
                # ⌘K → "See all results" opens the Search page as a reference; typing and filtering there replace its entry.
                page.keyboard.press("Control+k")
                palette = page.get_by_role("dialog", name="Jump to")
                palette.locator("input").fill("shade")
                palette.locator(".jump__all").click()
                expect(page).to_have_url(f"{ORIGIN}/search?q=shade")
                back = self.origin_back(page, "Conversation")
                expect(back).to_have_count(1)
                before = self.box(back)
                page.get_by_role("searchbox").fill("shade lamp")
                page.wait_for_function("() => new URLSearchParams(location.search).get('q') === 'shade lamp'")
                page.get_by_role("group", name="Kind of result").get_by_role("button", name=re.compile(r"^Messages")).click()
                page.wait_for_function("() => new URLSearchParams(location.search).get('type') === 'message'")
                page.wait_for_timeout(500)
                expect(self.origin_back(page, "Conversation")).to_have_count(1)
                self.assertEqual(self.box(self.origin_back(page, "Conversation")), before, "the control stays in its place")
                self.assertIsNotNone(page.evaluate("(history.state && history.state.usr && history.state.usr.origin) || null"), "the entry still names where it was followed from")
                # A reload keeps it, and it leads back to the conversation.
                page.reload()
                back = self.origin_back(page, "Conversation")
                expect(back).to_have_count(1)
                back.click()
                expect(page).to_have_url(f"{ORIGIN}/projects/{self.project}")

    def test_15_closing_an_agents_thread_keeps_the_way_back_to_tasks(self):
        for engine in self.browsers:
            with self.subTest(engine=engine):
                page = self.page(engine)
                page.goto(f"/projects/{self.project}/tasks?show=mine&view=list")
                row = page.locator(".ws-task").filter(has_text="Check the lamp sensor 05")
                row.locator(".ws-item").click()
                panel = page.locator("#details")
                expect(panel.get_by_role("heading", name="Check the lamp sensor 05")).to_be_visible()
                panel.locator("a[data-agent-thread-link]").click()
                expect(page).to_have_url(re.compile(r"/projects/[0-9a-f-]{36}/agents\?thread="))
                expect(self.origin_back(page, "Tasks")).to_have_count(1)
                # Close the thread once it is the panel's content: a click during the hand-over closes the task's panel
                # before the thread's owner is registered, so the address keeps the thread param (#709).
                expect(panel.locator("section.agents-thread")).to_be_visible()
                # The thread leaves its panel and its address is replaced: the page is still the one the task led to.
                panel.get_by_role("button", name=re.compile(r"^Close")).click()
                # Read the live location: Playwright's page.url can lag a same-document replace on Chromium (#709).
                page.wait_for_function(r"() => /\/projects\/[0-9a-f-]{36}\/agents$/.test(location.pathname) && !location.search.includes('thread=')")
                expect(self.origin_back(page, "Tasks")).to_have_count(1)
                self.assertIsNotNone(page.evaluate("(history.state && history.state.usr && history.state.usr.origin) || null"))
                self.origin_back(page, "Tasks").click()
                expect(page).to_have_url(re.compile(r"/projects/[0-9a-f-]{36}/tasks"))

    # ---- nothing private is kept, and sign-out forgets the places ----

    def test_16_no_message_text_is_kept_and_sign_out_forgets_the_places(self):
        secret = f"SECRET-{uuid.uuid4().hex[:10]}"
        for engine in self.browsers:
            with self.subTest(engine=engine):
                context = self.browsers[engine].new_context(service_workers="block", base_url=ORIGIN, viewport=DESKTOP)
                self.addCleanup(context.close)
                email = f"sol.{engine}.{STAMP}@example.test"
                api(context, "POST", "/api/auth/sign-up/email", {"name": "Sol Nowak", "email": email, "password": PASSWORD})
                workspace = api(context, "POST", "/api/v1/workspaces", {"name": "Private makers"}, 201)["id"]
                project = api(context, "POST", f"/api/v1/workspaces/{workspace}/projects", {"name": "Quiet plans", "visibility": "restricted"}, 201)["id"]
                api(context, "POST", f"/api/v1/projects/{project}/conversations", {"body": f"{secret} the budget is not for the team yet.", "clientMessageId": str(uuid.uuid4())}, 201)
                page = context.new_page()
                errors: list[str] = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.goto(f"/projects/{project}")
                self.wait_stream(page)
                message = page.locator("li.project-convo__message", has_text=secret)
                message.hover()
                message.get_by_role("button", name="More actions").click()
                page.get_by_role("menuitem", name="Propose a decision").click()
                expect(page.get_by_role("heading", name="Propose a decision")).to_be_visible()
                page.wait_for_timeout(800)
                kept = page.evaluate("() => Object.keys(sessionStorage).filter((key) => key.startsWith('flux:place:') && key !== 'flux:place:index')")
                self.assertTrue(kept, "the places are kept while someone reads")
                self.assertNotIn(secret, page.evaluate("() => JSON.stringify({ ...sessionStorage, ...localStorage })"), "no message text is written to storage")
                # A confirmed sign-out forgets the places with the drafts.
                page.get_by_role("button", name=re.compile("Sol Nowak")).click()
                with page.expect_request(lambda request: request.method == "POST" and request.url.endswith("/api/auth/sign-out")):
                    page.get_by_role("dialog", name="Account").get_by_role("button", name="Sign out").click(no_wait_after=True)
                expect(page).to_have_url(re.compile(r"/sign-in"))
                self.assertEqual(page.evaluate("() => Object.keys(sessionStorage).filter((key) => key.startsWith('flux:place:'))"), [], "no place outlives the sign-out")
                self.assertNotIn(secret, page.evaluate("() => JSON.stringify({ ...sessionStorage, ...localStorage })"))
                self.assertEqual(errors, [])

    # ---- the origin is a material or a direct message that closed meanwhile ----

    def test_17_a_material_that_closed_has_no_control_and_back_lands_on_a_parent_with_a_note(self):
        for engine in self.browsers:
            with self.subTest(engine=engine):
                room = self.make_project(f"Material room {engine}")
                material = api(self.contexts["ada"], "POST", f"/api/v1/projects/{room['id']}/materials",
                               {"title": f"Wiring notes {engine}", "body": "Which wire goes to which pin.", "clientMutationId": str(uuid.uuid4())}, 201)["materialId"]
                page = self.page(engine, who="jonas")
                page.goto(f"/materials/{material}")
                expect(page.get_by_role("heading", name=f"Wiring notes {engine}")).to_be_visible()
                self.jump_to_search(page)
                expect(self.origin_back(page, "Wiki")).to_have_count(1)
                # Ada takes Jonas's access away; he reloads the search and goes back.
                response = self.contexts["ada"].request.delete(f"{ORIGIN}/api/v1/projects/{room['id']}/grants/{room['grant']}", headers={"origin": ORIGIN})
                self.assertIn(response.status, (200, 204), response.text())
                page.reload()
                expect(page.get_by_role("searchbox")).to_be_visible()
                expect(self.origin_back(page)).to_have_count(0)
                page.go_back()
                expect(page).to_have_url(f"{ORIGIN}/projects")
                expect(page.get_by_text("That page is no longer available to you.")).to_be_visible()
                expect(page.get_by_role("heading", name="This place isn’t available")).to_have_count(0)
                expect(page.get_by_role("heading", name="Something went wrong")).to_have_count(0)

    def test_18_a_direct_message_that_was_left_has_no_control_and_back_lands_on_the_list_with_a_note(self):
        for engine in self.browsers:
            with self.subTest(engine=engine):
                dm = self.make_dm(f"leaver{engine}", 3)
                page = self.page(engine, who=dm["partner"])
                page.goto(f"/dm/{dm['id']}")
                expect(page.locator(".dm__feed")).to_be_visible()
                self.jump_to_search(page)
                expect(self.origin_back(page, "Messages")).to_have_count(1)
                # Jonas leaves the conversation (from another window); the search is reloaded, then Back.
                left = self.contexts[dm["partner"]].request.post(f"{ORIGIN}/api/v1/dms/{dm['id']}/leave", headers={"origin": ORIGIN, "content-type": "application/json"}, data="{}")
                self.assertEqual(left.status, 204, left.text())
                page.reload()
                expect(page.get_by_role("searchbox")).to_be_visible()
                expect(self.origin_back(page)).to_have_count(0)
                page.go_back()
                expect(page).to_have_url(f"{ORIGIN}/dm")
                expect(page.get_by_text("That conversation is no longer available to you.")).to_be_visible()
                expect(page.get_by_role("heading", name="This conversation isn’t available")).to_have_count(0)

    # ---- a direct message's feed and its thread keep the reader's place ----

    def test_19_a_direct_message_comes_back_to_the_message_that_was_in_view(self):
        for engine in self.browsers:
            with self.subTest(engine=engine):
                dm = self.make_dm(f"roots{engine}", 60)
                page = self.page(engine)
                page.goto(f"/dm/{dm['id']}")
                feed, target = ".dm__feed", f"#message-{dm['roots'][7]}"
                expect(page.locator(feed)).to_be_visible()
                page.wait_for_timeout(1500)
                # Message 8 is older than the newest 50: the reader reads back to it, and puts it 48 px below the top.
                page.get_by_role("button", name="Show earlier messages").click()
                expect(page.locator(target)).to_have_count(1)
                self.read_at(page, feed, target, 48)
                page.locator("#dm-composer").fill("Draft: ask Jonas about the shade")
                before = self.offset(page, feed, target)
                self.assertGreater(page.evaluate(AWAY, feed), 1000, "the reader is far from the end")
                # Something arrives while the person is away.
                api(self.contexts[dm["partner"]], "POST", f"/api/v1/dms/{dm['id']}/messages", {"body": f"While you were away ({engine}).", "clientMessageId": str(uuid.uuid4())}, 201)
                self.jump_to_search(page)
                self.origin_back(page, "Messages").click()
                expect(page).to_have_url(f"{ORIGIN}/dm/{dm['id']}")
                expect(page.locator(target)).to_have_count(1)
                page.wait_for_timeout(1500)
                expect(page.locator("#dm-composer")).to_have_value("Draft: ask Jonas about the shade")
                self.assert_same(before, self.offset(page, feed, target), "the message stays where it was, with the newer ones below", tolerance=2)
                self.assertGreater(page.evaluate(AWAY, feed), 1000, "no jump to the bottom")
                # The browser's Back finds the same place.
                page.go_forward()
                expect(page).to_have_url(re.compile(r"/search"))
                page.go_back()
                expect(page).to_have_url(f"{ORIGIN}/dm/{dm['id']}")
                expect(page.locator(target)).to_have_count(1)
                page.wait_for_timeout(1500)
                self.assert_same(before, self.offset(page, feed, target), "and by the browser's Back", tolerance=2)

    def test_20_a_direct_message_thread_comes_back_to_the_reply_that_was_in_view(self):
        for engine in self.browsers:
            with self.subTest(engine=engine):
                dm = self.make_dm(f"thread{engine}", 3, replies=60)
                page = self.page(engine)
                page.goto(f"/dm/{dm['id']}?thread={dm['roots'][0]}")
                feed, target = ".thread__feed", f"#thread-message-{dm['replies'][7]}"
                expect(page.locator("[data-dm-thread]")).to_be_visible()
                expect(page.locator(feed)).to_be_visible()
                page.wait_for_timeout(1500)
                page.get_by_role("button", name="Show earlier replies").click()
                expect(page.locator(target)).to_have_count(1)
                self.read_at(page, feed, target, 48)
                page.locator("#dm-thread-composer").fill("Draft reply: the range first")
                before = self.offset(page, feed, target)
                self.assertGreater(page.evaluate(AWAY, feed), 1000, "the reader is far from the end")
                api(self.contexts[dm["partner"]], "POST", f"/api/v1/dms/{dm['id']}/threads/{dm['roots'][0]}/replies", {"body": f"While you were away ({engine}).", "clientMessageId": str(uuid.uuid4())}, 201)
                self.jump_to_search(page)
                self.origin_back(page, "Messages").click()
                expect(page).to_have_url(f"{ORIGIN}/dm/{dm['id']}?thread={dm['roots'][0]}")
                expect(page.locator("[data-dm-thread]")).to_be_visible()
                expect(page.locator(target)).to_have_count(1)
                page.wait_for_timeout(1500)
                expect(page.locator("#dm-thread-composer")).to_have_value("Draft reply: the range first")
                self.assert_same(before, self.offset(page, feed, target), "the reply stays where it was, with the newer ones below", tolerance=2)
                self.assertGreater(page.evaluate(AWAY, feed), 1000, "no jump to the bottom")

    # ---- the tablet and the phone, in the installed display mode ----

    def test_11_tablet_wiki_card_and_thread(self):
        for engine in self.browsers:
            with self.subTest(engine=engine, size="tablet"):
                self.wiki_journey(engine, "tablet", "control")
                self.thread_journey(engine, "tablet")
                self.thread_wiki_journey(engine, "tablet")

    def test_12_phone_wiki_card_and_thread(self):
        for engine in self.browsers:
            with self.subTest(engine=engine, size="phone"):
                self.wiki_journey(engine, "phone", "control")
                self.thread_journey(engine, "phone")
                self.thread_wiki_journey(engine, "phone")

    def test_13_tablet_and_phone_tasks_search_and_inbox(self):
        for engine in self.browsers:
            for size in ("tablet", "phone"):
                with self.subTest(engine=engine, size=size):
                    self.tasks_journey(engine, size)
                    self.search_journey(engine, size)
                    self.inbox_journey(engine, size)


if __name__ == "__main__":
    unittest.main()
