"""Browser tests for opening a conversation where the person left off (#1246, final design S23).

One behaviour in five surfaces: a space's conversation, a direct message, a thread, a task's discussion and an agent's chat (and a direct message's
thread). Each opens on its first new message with a quiet "New" divider above it, or at its end when nothing is new, or at its very first message when
the person has never opened it (founder decision on #1246); while the reader is above the end, what arrives is counted in "↓ N new", which a click or
tap (and End) takes to the end; and nothing moves under the reader.

Ada reads and Bob writes. What Ada had seen is set through the API the app itself writes (a return point for the space, viewing observations for a
direct message, a thread and a discussion), then Bob writes 30 more and Ada opens the surface. The agent's chat has no way to post a line from a test, so
the lines of its 30 unread are what the browser is told the chat holds (the server's `readAt` is covered by tests/app/unread-from.test.ts); the message that
arrives is a real run of the agent. Computer (1440 px, with the keyboard) and phone (390 px, touch), in light and dark; the engine is FLUX_UI_BROWSER.
Screenshots (unread-*.png) go to FLUX_UI_SCREENSHOTS.
"""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid
from datetime import datetime, timedelta, timezone

from playwright.sync_api import Browser, BrowserContext, Locator, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, shot, start_forwarder

PASSWORD = "reading where I left off"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ada": ("Ada Kowalska", f"ada.left+{STAMP}@example.test"),
    "bob": ("Bob Okafor", f"bob.left+{STAMP}@example.test"),
    "carol": ("Carol Reyes", f"carol.left+{STAMP}@example.test"),
}
OLD = 6
NEW = 30
KEY = f"sk-ant-api03-{'unread-ui-one-' * 3}UR01"


def words(kind: str, index: int) -> str:
    return f"{kind} {index}: the gateway log shows a reboot at night, and the sensor board waits in the second drawer."


class OpenWhereYouLeftOff(unittest.TestCase):
    """Tests run in name order and share three accounts, one space and Ada's first agent."""

    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}
    contexts: dict[str, BrowserContext] = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=15000)
        for key, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(service_workers="block", base_url=ORIGIN)
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.states[key] = context.storage_state()
            cls.contexts[key] = context
        ws = cls.call("ada", "/api/v1/workspaces", {"name": "Riverside Makers"})
        cls.ids["workspace"] = ws["id"]
        for key in ("bob", "carol"):
            cls.call("ada", f"/api/v1/workspaces/{ws['id']}/members", {"email": PEOPLE[key][1], "role": "member"})
        cls.ids["project"] = cls.call("ada", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Garden sensors", "visibility": "workspace"})["id"]
        # Ada's first agent: connecting a key makes Assistant (the mock provider answers its runs).
        cls.call("ada", "/api/v1/background-compute-connections", {"name": "Ada's key", "provider": "anthropic", "model": "claude-sonnet-5", "apiKey": KEY,
                 "dailyBudgetCents": 500, "timeZone": "Europe/Warsaw"})
        cls.ids["agent"] = cls.call("ada", "/api/v1/my-agents", method="GET")["items"][0]["id"]

    @classmethod
    def tearDownClass(cls) -> None:
        for context in cls.contexts.values():
            context.close()
        cls.browser.close()
        cls.pw.stop()

    # ------------------------------------------------------------------ plumbing

    @classmethod
    def call(cls, who: str, path: str, body: dict | None = None, method: str = "POST") -> dict:
        response = cls.contexts[who].request.fetch(path, method=method, data=body, headers={"origin": ORIGIN})
        assert response.status in (200, 201, 202, 204), f"{method} {path}: {response.status} {response.text()}"
        return response.json() if response.text() else {}

    def page(self, who: str = "ada", *, phone: bool = False, dark: bool = False) -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": "dark" if dark else "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw", "storage_state": self.states[who]}
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

    # ------------------------------------------------------------------ the five surfaces (and a DM's thread): what each has, set up through the API

    def space(self, tag: str) -> dict:
        project = self.call("ada", f"/api/v1/workspaces/{self.ids['workspace']}/projects", {"name": f"Garden {tag}", "visibility": "workspace"})["id"]
        say = lambda index, kind: self.call("bob", f"/api/v1/projects/{project}/conversations", {"body": words(kind, index), "clientMessageId": str(uuid.uuid4())})["messages"][0]["id"]  # noqa: E731
        for index in range(OLD):
            say(index, "Earlier")
        # Ada has read up to here: the return point the app saves when she leaves the conversation.
        seen = self.call("ada", f"/api/v1/return?place=project&id={project}", method="GET")
        self.call("ada", "/api/v1/return-points", {"place": {"type": "project", "id": project}, "mark": seen["mark"]}, method="PUT")
        time.sleep(1.1)
        new = [say(index, "New") for index in range(NEW)]
        return dict(name="space", url=f"/projects/{project}", feed=".project-convo__feed.is-stream", first=f"#message-{new[0]}", ready=f"#message-{new[-1]}",
                    more=lambda: say(NEW, "Later"), refresh=True)

    def direct(self, tag: str) -> dict:
        dm = self.call("ada", f"/api/v1/workspaces/{self.ids['workspace']}/dms", {"participantIds": [self.ids["bob"], self.ids["carol"]], "title": f"Lamp crew {tag}"})["id"]
        say = lambda index, kind: self.call("bob", f"/api/v1/dms/{dm}/messages", {"body": words(kind, index), "clientMessageId": str(uuid.uuid4())})["id"]  # noqa: E731
        old = [say(index, "Earlier") for index in range(OLD)]
        self.call("ada", f"/api/v1/dms/{dm}/observations", {"messageIds": old})
        new = [say(index, "New") for index in range(NEW)]
        return dict(name="dm", url=f"/dm/{dm}", feed=".dm__feed", first=f"#message-{new[0]}", ready=f"#message-{new[-1]}", more=lambda: say(NEW, "Later"), refresh=True)

    def dm_thread(self, tag: str) -> dict:
        dm = self.call("ada", f"/api/v1/workspaces/{self.ids['workspace']}/dms", {"participantIds": [self.ids["bob"], self.ids["carol"]], "title": f"Lamp thread {tag}"})["id"]
        root = self.call("bob", f"/api/v1/dms/{dm}/messages", {"body": "Should the lamp dim with a wave of the hand?", "clientMessageId": str(uuid.uuid4())})["id"]
        say = lambda index, kind: self.call("bob", f"/api/v1/dms/{dm}/threads/{root}/replies", {"body": words(kind, index), "clientMessageId": str(uuid.uuid4())})["id"]  # noqa: E731
        old = [say(index, "Earlier") for index in range(OLD)]
        self.call("ada", f"/api/v1/dms/{dm}/observations", {"messageIds": [root, *old]})
        new = [say(index, "New") for index in range(NEW)]
        return dict(name="dm-thread", url=f"/dm/{dm}?thread={root}", feed=".dm-thread .thread__feed", first=f"#thread-message-{new[0]}", ready=f"#thread-message-{new[-1]}",
                    more=lambda: say(NEW, "Later"), refresh=True)

    def thread(self, tag: str) -> dict:
        project = self.ids["project"]
        root = self.call("bob", f"/api/v1/projects/{project}/conversations", {"body": f"Which bed gets the new sensors first? ({tag})", "clientMessageId": str(uuid.uuid4())})
        conversation, root_message = root["id"], root["messages"][0]["id"]
        say = lambda index, kind: self.call("bob", f"/api/v1/conversations/{conversation}/messages", {"body": words(kind, index), "clientMessageId": str(uuid.uuid4())})["id"]  # noqa: E731
        old = [say(index, "Earlier") for index in range(OLD)]
        self.call("ada", f"/api/v1/projects/{project}/observations", {"messageIds": [root_message, *old]})
        new = [say(index, "New") for index in range(NEW)]
        return dict(name="thread", url=f"/projects/{project}/conversations/{conversation}", feed=".thread__feed", first=f"#message-{new[0]}", ready=f"#message-{new[-1]}",
                    more=lambda: say(NEW, "Later"), refresh=True)

    def discussion(self, tag: str) -> dict:
        project = self.ids["project"]
        task = self.call("ada", f"/api/v1/projects/{project}/work", {"title": f"Order the sensors ({tag})", "clientCommandId": str(uuid.uuid4())})
        say = lambda index, kind: self.call("bob", f"/api/v1/work/{task['id']}/discussion", {"body": words(kind, index), "clientMessageId": str(uuid.uuid4())})["id"]  # noqa: E731
        old = [say(index, "Earlier") for index in range(OLD)]
        talk = self.call("ada", f"/api/v1/work/{task['id']}/discussion", method="GET")
        self.call("ada", f"/api/v1/projects/{project}/observations", {"messageIds": [talk["rootMessageId"], *old[1:]]})
        new = [say(index, "New") for index in range(NEW)]
        return dict(name="discussion", url=f"/projects/{project}/conversations/{talk['conversationId']}", feed=".thread__feed", first=f"#message-{new[0]}", ready=f"#message-{new[-1]}",
                    more=lambda: say(NEW, "Later"), refresh=True)

    def agent(self, tag: str) -> dict:
        """The chat holds 30 lines the agent said after Ada last had it open: the browser is told so; what arrives is a real run."""
        agent = self.ids["agent"]
        start = datetime.now(timezone.utc) - timedelta(hours=2)
        lines = [{"id": str(uuid.uuid4()), "agentId": agent, "runId": None, "body": words("Result", index), "createdAt": (start + timedelta(seconds=index)).isoformat().replace("+00:00", "Z"),
                  "changes": 0, "undone": 0, "words": None, "task": None, "schedule": {"title": "Garden summary", "words": "Every weekday at 9:00", "failed": False}} for index in range(NEW)]
        read_at = (start - timedelta(hours=1)).isoformat().replace("+00:00", "Z")

        def more() -> str:
            return self.call("ada", f"/api/v1/my-agents/{agent}/assistant-runs", {"clientRunId": str(uuid.uuid4()), "kind": "ask", "prompt": f"And what about bed {tag}?"})["id"]

        def arrange(page: Page) -> None:
            page.route(re.compile(rf".*/api/v1/agent-chats/{agent}/messages$"), lambda route: route.fulfill(
                status=200, content_type="application/json", body=json.dumps({"items": lines, "readAt": read_at})) if route.request.method == "GET" else route.continue_())

        return dict(name="agent", url=f"/agents/{agent}", feed=".agc-pane .dm__feed", first=f'[data-line-id="{lines[0]["id"]}"]', ready=f'[data-line-id="{lines[-1]["id"]}"]', more=more,
                    refresh=False, arrange=arrange, starts=True, author="Assistant")

    # ------------------------------------------------------------------ the one behaviour

    def open(self, surface: dict, *, phone: bool = False, dark: bool = False) -> tuple[Page, Locator]:
        page = self.page(phone=phone, dark=dark)
        if "arrange" in surface:
            surface["arrange"](page)
        page.goto(surface["url"])
        feed = page.locator(surface["feed"])
        expect(feed).to_be_visible()
        expect(page.locator(surface["ready"])).to_be_attached()
        return page, feed

    def at_end(self, feed: Locator) -> float:
        return feed.evaluate("el => el.scrollHeight - el.scrollTop - el.clientHeight")

    def scroll_up(self, feed: Locator) -> None:
        """Back to the top, and past the frames in which the scroll is still being noticed (its event, what listens to it)."""
        feed.evaluate("el => { el.scrollTop = 0; return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))); }")

    def pill(self, feed: Locator) -> Locator:
        # The feed's frame: `.convo-stream` holds the feed and the "N new" line.
        return feed.locator("xpath=..").locator(".convo-newbelow__b")

    def arrive(self, page: Page, surface: dict) -> None:
        surface["more"]()
        if surface["refresh"]:
            page.evaluate("() => window.dispatchEvent(new Event('focus'))")

    def check(self, surface: dict, *, phone: bool) -> None:
        label = f"{surface['name']} on a {'phone' if phone else 'computer'}"
        page, feed = self.open(surface, phone=phone)
        divider = feed.get_by_role("separator", name="New")
        expect(divider).to_have_count(1)
        expect(divider).to_have_text("New")
        first = page.locator(surface["first"])
        # The first new message starts its own group: its author is named, whoever wrote the message above the divider.
        expect(first).to_contain_text(surface.get("author", "Bob"))
        # It opens on what is new: the divider is where the feed starts, with the first new message below it. Not at the end and not at the top.
        expect(first).to_be_in_viewport()
        top = divider.evaluate("(el, feed) => el.getBoundingClientRect().top - feed.getBoundingClientRect().top", feed.element_handle())
        if surface.get("starts"):
            # Nothing was read before the divider (the agent's chat holds only new lines): it opens at the very top, under the chat's own note.
            self.assertLess(feed.evaluate("el => el.scrollTop"), 2, f"{label}: it opens at the top")
        else:
            self.assertTrue(0 <= top <= 40, f"{label}: the divider opens at the top of the feed, saw {top}px below it")
            self.assertGreater(feed.evaluate("el => el.scrollTop"), 100, f"{label}: it did not open at the top")
        self.assertGreater(self.at_end(feed), 200, f"{label}: it did not open at the end, 30 messages are new")
        self.assertTrue(divider.evaluate("(el, selector) => el.nextElementSibling?.matches(selector)", surface["first"]), f"{label}: the divider is right above the first new message")
        expect(self.pill(feed)).to_have_count(0)
        # Something arrives while Ada reads above the end: it is counted, and nothing moves under her.
        before = divider.evaluate("(el, feed) => el.getBoundingClientRect().top - feed.getBoundingClientRect().top", feed.element_handle())
        self.arrive(page, surface)
        pill = self.pill(feed)
        expect(pill).to_have_text("1 new")
        expect(pill).to_be_visible()
        self.assertEqual(pill.get_attribute("aria-label"), "1 new. Go to the newest")
        page.wait_for_timeout(600)
        after = divider.evaluate("(el, feed) => el.getBoundingClientRect().top - feed.getBoundingClientRect().top", feed.element_handle())
        self.assertLess(abs(after - before), 2.01, f"{label}: the reader stays put ({before} -> {after})")
        tag = f"unread-{surface['name']}-{'390' if phone else '1440'}"
        shot(page, f"{tag}-light")
        page.emulate_media(color_scheme="dark")
        shot(page, f"{tag}-dark")
        page.emulate_media(color_scheme="light")
        # A click or a tap goes to the end, and the line goes.
        if phone:
            pill.tap()
        else:
            pill.click()
        expect(self.pill(feed)).to_have_count(0)
        page.wait_for_timeout(300)
        self.assertLess(self.at_end(feed), 48, f"{label}: the line took the reader to the end")
        self.assertEqual(divider.count(), 1, f"{label}: the divider stays where it was")
        # End does the same on a keyboard.
        if not phone:
            self.scroll_up(feed)
            self.arrive(page, surface)
            expect(self.pill(feed)).to_have_text("1 new")
            page.keyboard.press("End")
            expect(self.pill(feed)).to_have_count(0)
            page.wait_for_timeout(300)
            self.assertLess(self.at_end(feed), 48, f"{label}: End took the reader to the end")
            # Used from the keyboard, the line leaves focus on the newest message, not on the page.
            self.scroll_up(feed)
            self.arrive(page, surface)
            expect(self.pill(feed)).to_have_text("1 new")
            self.pill(feed).focus()
            page.keyboard.press("Enter")
            expect(self.pill(feed)).to_have_count(0)
            self.assertTrue(feed.evaluate("el => el.contains(document.activeElement) && document.activeElement !== el.ownerDocument.body"), f"{label}: focus stays in the feed after the line")
            # And the line says how many when there are several.
            self.scroll_up(feed)
            self.arrive(page, surface)
            self.arrive(page, surface)
            expect(self.pill(feed)).to_have_text(re.compile(r"^[23] new$"))
            self.pill(feed).click()
            expect(self.pill(feed)).to_have_count(0)

    # ------------------------------------------------------------------ the tests: the five surfaces, a computer then a phone

    def test_01_a_space_opens_on_what_is_new(self) -> None:
        for phone in (False, True):
            self.check(self.space(f"computer-{STAMP}" if not phone else f"phone-{STAMP}"), phone=phone)

    def test_02_a_direct_message_opens_on_what_is_new(self) -> None:
        for phone in (False, True):
            self.check(self.direct("computer" if not phone else "phone"), phone=phone)

    def test_03_a_thread_opens_on_what_is_new(self) -> None:
        for phone in (False, True):
            self.check(self.thread("computer" if not phone else "phone"), phone=phone)

    def test_04_a_task_discussion_opens_on_what_is_new(self) -> None:
        for phone in (False, True):
            self.check(self.discussion("computer" if not phone else "phone"), phone=phone)

    def test_05_an_agent_chat_opens_on_what_is_new(self) -> None:
        for phone in (False, True):
            self.check(self.agent("computer" if not phone else "phone"), phone=phone)

    def test_06_a_direct_message_thread_opens_on_what_is_new(self) -> None:
        for phone in (False, True):
            self.check(self.dm_thread("computer" if not phone else "phone"), phone=phone)

    # ------------------------------------------------------------------ when nothing is new

    def test_07_a_conversation_with_nothing_new_opens_at_its_end_without_a_divider(self) -> None:
        """Ada has seen all of it: no divider, and the feed opens at its end (the thread too: it has been read)."""
        dm = self.call("ada", f"/api/v1/workspaces/{self.ids['workspace']}/dms", {"participantIds": [self.ids["bob"], self.ids["carol"]], "title": "Lamp crew read"})["id"]
        sent = [self.call("bob", f"/api/v1/dms/{dm}/messages", {"body": words("Read", index), "clientMessageId": str(uuid.uuid4())})["id"] for index in range(NEW)]
        self.call("ada", f"/api/v1/dms/{dm}/observations", {"messageIds": sent})
        project = self.ids["project"]
        root = self.call("bob", f"/api/v1/projects/{project}/conversations", {"body": "Which bed is first?", "clientMessageId": str(uuid.uuid4())})
        replies = [self.call("bob", f"/api/v1/conversations/{root['id']}/messages", {"body": words("Read", index), "clientMessageId": str(uuid.uuid4())})["id"] for index in range(NEW)]
        self.call("ada", f"/api/v1/projects/{project}/observations", {"messageIds": [root["messages"][0]["id"], *replies]})
        for surface in ({"url": f"/dm/{dm}", "feed": ".dm__feed", "ready": f"#message-{sent[-1]}"},
                        {"url": f"/projects/{project}/conversations/{root['id']}", "feed": ".thread__feed", "ready": f"#message-{replies[-1]}"}):
            page, feed = self.open(surface)
            page.wait_for_timeout(600)
            expect(feed.get_by_role("separator", name="New")).to_have_count(0)
            self.assertLess(self.at_end(feed), 48, f"{surface['url']} opens at its end")
            expect(page.locator(surface["ready"])).to_be_in_viewport()
        # An agent's chat the person has open as it is told them: nothing came after `readAt`, so it opens at its end.
        agent = self.agent("quiet")
        agent["arrange"] = lambda page: page.route(re.compile(rf".*/api/v1/agent-chats/{self.ids['agent']}/messages$"), lambda route: route.fulfill(
            status=200, content_type="application/json", body=json.dumps({"items": [], "readAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")})))
        agent["ready"] = ".agc-pane"
        page, feed = self.open(agent)
        expect(feed.get_by_role("separator", name="New")).to_have_count(0)


    def test_09_a_long_direct_message_never_opened_reads_back_a_page_or_two_at_most(self) -> None:
        """#862's request budget: 330 messages never opened open with the divider above the oldest message that was read back (50 newest and two
        pages of 100), with "Show earlier messages" above it, not after reading all the way to the first message."""
        dm = self.call("ada", f"/api/v1/workspaces/{self.ids['workspace']}/dms", {"participantIds": [self.ids["bob"], self.ids["carol"]], "title": "Lamp crew long"})["id"]
        for index in range(330):
            self.call("bob", f"/api/v1/dms/{dm}/messages", {"body": words("Long", index), "clientMessageId": str(uuid.uuid4())})
        page = self.page()
        reads: list[str] = []
        page.on("request", lambda request: reads.append(request.url) if request.method == "GET" and re.search(rf"/api/v1/dms/{dm}\?beforeSequence=", request.url) else None)
        page.goto(f"/dm/{dm}")
        feed = page.locator(".dm__feed")
        expect(feed).to_be_visible()
        divider = feed.get_by_role("separator", name="New")
        expect(divider).to_have_count(1)
        expect(feed.get_by_role("button", name="Show earlier messages")).to_be_visible()
        loaded = page.locator(".dm__feed li.dm-msg").count()
        self.assertTrue(200 <= loaded <= 260, f"the newest 50 and two pages of 100 are loaded, saw {loaded}")
        self.assertLessEqual(len(reads), 2, f"at most two pages are read back, saw {reads}")
        self.assertTrue(divider.evaluate("el => el.nextElementSibling?.matches('li.dm-msg') && !el.previousElementSibling?.matches('li.dm-msg')"), "the divider is above the oldest message loaded")
        self.assertLess(feed.evaluate("el => el.scrollTop"), 2)
        expect(divider).to_be_in_viewport()

    # ------------------------------------------------------------------ never opened: the first message

    def test_08_a_conversation_never_opened_opens_at_its_first_message(self) -> None:
        """Founder decision on #1246: everything in a conversation the person has never opened is new, so it opens at its first message with
        the divider above it, from the very top (who is in it, a thread's root), and "↓ N new" leads to the end."""
        project = self.ids["project"]
        for phone in (False, True):
            # Each viewport has conversations of its own: what the first one showed is observed, so it is no longer new.
            tag = "phone" if phone else "computer"
            dm = self.call("ada", f"/api/v1/workspaces/{self.ids['workspace']}/dms", {"participantIds": [self.ids["bob"], self.ids["carol"]], "title": f"Lamp crew new {tag}"})["id"]
            sent = [self.call("bob", f"/api/v1/dms/{dm}/messages", {"body": words("Hello", index), "clientMessageId": str(uuid.uuid4())})["id"] for index in range(60)]
            root = self.call("bob", f"/api/v1/projects/{project}/conversations", {"body": f"Which bed gets the new sensors first? (never opened {tag})", "clientMessageId": str(uuid.uuid4())})
            replies = [self.call("bob", f"/api/v1/conversations/{root['id']}/messages", {"body": words("Hello", index), "clientMessageId": str(uuid.uuid4())})["id"] for index in range(20)]
            label = "a phone" if phone else "a computer"
            # A new direct message with 60 messages (more than its newest window): it is read back to the first.
            page, feed = self.open({"url": f"/dm/{dm}", "feed": ".dm__feed", "ready": f"#message-{sent[0]}"}, phone=phone)
            divider = feed.get_by_role("separator", name="New")
            expect(divider).to_have_count(1)
            self.assertTrue(divider.evaluate("(el, id) => el.nextElementSibling?.id === `message-${id}`", sent[0]), f"{label}: the divider is right above the first message")
            expect(page.locator(f"#message-{sent[0]}")).to_be_in_viewport()
            expect(feed.locator(".dm__head")).to_be_in_viewport()
            self.assertLess(feed.evaluate("el => el.scrollTop"), 2, f"{label}: a direct message never opened opens at its very top")
            name = f"unread-never-opened-dm-{'390' if phone else '1440'}"
            shot(page, f"{name}-light")
            page.emulate_media(color_scheme="dark")
            shot(page, f"{name}-dark")
            page.emulate_media(color_scheme="light")
            # A thread never opened opens at its root, whole, with the divider under it above the first reply.
            page, feed = self.open({"url": f"/projects/{project}/conversations/{root['id']}", "feed": ".thread__feed", "ready": f"#message-{replies[-1]}"}, phone=phone)
            divider = feed.get_by_role("separator", name="New")
            expect(divider).to_have_count(1)
            self.assertTrue(divider.evaluate("(el, id) => el.nextElementSibling?.id === `message-${id}`", replies[0]), f"{label}: the divider is right above the first reply")
            self.assertLess(feed.evaluate("el => el.scrollTop"), 2, f"{label}: a thread never opened opens at its root")
            expect(feed.locator(".thread__root")).to_be_in_viewport()
            expect(page.locator(f"#message-{replies[0]}")).to_be_in_viewport()
            # "↓ N new" leads to the end.
            page.evaluate("() => window.dispatchEvent(new Event('focus'))")
            self.call("bob", f"/api/v1/conversations/{root['id']}/messages", {"body": words("Later", 99), "clientMessageId": str(uuid.uuid4())})
            page.evaluate("() => window.dispatchEvent(new Event('focus'))")
            pill = self.pill(feed)
            expect(pill).to_have_text("1 new")
            pill.tap() if phone else pill.click()
            expect(self.pill(feed)).to_have_count(0)
            page.wait_for_timeout(300)
            self.assertLess(self.at_end(feed), 48, f"{label}: the line took the reader to the end")


if __name__ == "__main__":
    unittest.main()
