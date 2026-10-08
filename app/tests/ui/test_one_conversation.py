"""Browser tests for one project conversation (UI116-1 clarification, 2026-10-02).

A project has one chronological stream of roots, with replies beside each root in a one-level thread.
Runs with the other tests/ui modules through scripts/check_ui.sh against the running Compose
application. Three people share a project: Ada manages it, Jonas writes and Lee only reads. The
stream holds more roots than one window, so links to old conversations read back to them. Every
change is checked against the API. Screenshots (one-conversation-*.png) go to FLUX_UI_SCREENSHOTS.
"""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder
from contrast import MEASURE

PASSWORD = "one calm conversation for the lamp"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ada": ("Ada Kowalska", f"ada.one+{STAMP}@example.test"),
    "jonas": ("Jonas Berg", f"jonas.one+{STAMP}@example.test"),
    "lee": ("Lee Park", f"lee.one+{STAMP}@example.test"),
}
FILLERS = 55
OPENING = "Should the lamp react to gestures in the dark, or only when someone is close?"
FIRST_REPLY = "Above 50 lux the camera catches almost every wave; below that it gets unreliable fast."
SECOND_REPLY = "Then the camera cannot be the only sensor. A ToF board works in the dark."
NUMBERS = "Camera numbers are in: 38% of gestures at 5 lux."
NUMBERS_REPLY = "Thanks. Let's keep the negative result next to the ToF test."
ORDER = "Order two ToF boards today?"


def contrast(a: list[float], b: list[float]) -> float:
    """WCAG contrast of two opaque sRGB colours (0–255 channels)."""
    def luminance(rgb: list[float]) -> float:
        linear = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in (v / 255 for v in rgb)]
        return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
    high, low = sorted((luminance(a), luminance(b)), reverse=True)
    return (high + 0.05) / (low + 0.05)


class OneConversationJourney(unittest.TestCase):
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

        def post(who: str, path: str, body: dict) -> dict:
            response = contexts[who].request.post(path, data=body, headers={"origin": ORIGIN})
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
        reply = lambda who, cid, body: post(who, f"/api/v1/conversations/{cid}/messages", {"body": body, "clientMessageId": str(uuid.uuid4())})  # noqa: E731
        # More roots than the newest window (50), oldest first, from two people.
        oldest = None
        for index in range(1, FILLERS + 1):
            started = start("ada" if index % 2 else "jonas", f"Earlier note {index:02}: a short idea about the lamp shade, the base or the sensor.")
            oldest = oldest or started
        r1 = start("ada", OPENING)
        first = reply("jonas", r1["id"], FIRST_REPLY)
        second = reply("ada", r1["id"], SECOND_REPLY)
        r2 = start("jonas", NUMBERS)
        reply("ada", r2["id"], NUMBERS_REPLY)
        r3 = start("ada", ORDER)
        for context in contexts.values():
            context.close()
        cls.ids.update(project=pid, workspace=ws["id"], oldest=oldest["id"], oldest_root=oldest["messages"][0]["id"],
                       c1=r1["id"], r1=r1["messages"][0]["id"], first=first["id"], second=second["id"],
                       c2=r2["id"], r2=r2["messages"][0]["id"], c3=r3["id"], r3=r3["messages"][0]["id"])

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

    def project_url(self, suffix: str = "") -> str:
        return f"/projects/{self.ids['project']}{suffix}"

    def stream(self, page: Page):
        return page.get_by_role("region", name="Messages")

    def thread(self, page: Page):
        return page.get_by_role("complementary", name="Replies")

    def root(self, page: Page, key: str):
        return page.locator(f"#message-{self.ids[key]}")

    def no_sideways_scroll(self, page: Page) -> None:
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), page.evaluate("window.innerWidth"), "no horizontal overflow")

    def all_roots(self, page: Page) -> list[dict]:
        roots: list[dict] = []
        cursor = None
        while True:
            window = self.api(page, "GET", f"/api/v1/projects/{self.ids['project']}/conversation-roots?limit=100" + (f"&before={cursor}" if cursor else ""), status=200)
            roots = window["roots"] + roots
            cursor = window["rootPage"]["nextBefore"]
            if not cursor:
                return roots

    # ---------------------------------------------------------------- the stream

    def test_01_one_stream_of_roots_from_several_people(self) -> None:
        page = self.page("ada")
        page.goto(self.project_url())
        stream = self.stream(page)
        roots = stream.locator(".project-convo__message")
        expect(roots).to_have_count(50)
        self.assertEqual([text.strip() for text in stream.locator(".project-convo__message > p").all_inner_texts()[-3:]], [OPENING, NUMBERS, ORDER], "chronological, newest last")
        expect(self.root(page, "r1")).to_have_class(re.compile("is-mine"))
        expect(self.root(page, "r2")).not_to_have_class(re.compile("is-mine"))
        expect(self.root(page, "r2")).to_contain_text("Jonas Berg")
        # Each root says how many replies it has; the reply action opens the same thread.
        expect(self.root(page, "r1").get_by_role("button", name=re.compile(r"^2 replies"))).to_be_visible()
        expect(self.root(page, "r2").get_by_role("button", name=re.compile(r"^1 reply"))).to_be_visible()
        expect(self.root(page, "r3").get_by_role("button", name="Reply", exact=True)).to_be_visible()
        expect(self.root(page, "r3").get_by_role("button", name=re.compile(r"repl(y|ies) ·"))).to_have_count(0)
        expect(stream.locator(".project-convo__day", has_text="Today")).to_have_count(1)
        # No thread is open and no topic is needed: one composer writes the next root.
        expect(self.thread(page)).to_have_count(0)
        expect(page.get_by_label("Write a message", exact=True)).to_be_visible()
        expect(page.get_by_role("link", name="New conversation")).to_have_count(0)
        sidebar = page.get_by_role("complementary", name="Sidebar")
        expect(sidebar.get_by_role("link", name="Night lamp")).to_be_visible()
        expect(sidebar.get_by_role("link", name=re.compile("Should the lamp react"))).to_have_count(0)
        # The stream opens on whole messages with the latest fully visible.
        page.wait_for_timeout(600)
        clipped = page.evaluate("""() => {
          const feed = document.querySelector('.project-convo__feed');
          const top = feed.getBoundingClientRect().top;
          return [...feed.querySelectorAll('.project-convo__message')].filter((el) => { const r = el.getBoundingClientRect(); return r.top < top - 1 && r.bottom > top + 1; }).length;
        }""")
        self.assertEqual(clipped, 0, "no root is cut off at the top of the opening screen")
        last, feed = self.root(page, "r3").bounding_box(), page.locator(".project-convo__feed").bounding_box()
        assert last and feed
        self.assertLessEqual(last["y"] + last["height"], feed["y"] + feed["height"] + 1, "the newest root is fully visible")
        self.no_sideways_scroll(page)
        shot(page, "one-conversation-desktop-1440-light")
        # Earlier roots load in place, above the reader's position.
        page.locator(".project-convo__feed").evaluate("el => { el.scrollTop = 0; }")
        page.wait_for_timeout(200)
        anchor = page.locator("#" + (roots.first.get_attribute("id") or ""))
        before = anchor.bounding_box()
        stream.get_by_role("button", name="Load earlier messages").click()
        expect(roots).to_have_count(FILLERS + 3)
        expect(stream.get_by_role("button", name="Load earlier messages")).to_have_count(0)
        after = anchor.bounding_box()
        assert before and after
        self.assertAlmostEqual(before["y"], after["y"], delta=4, msg="loading earlier roots keeps the reader's place")
        self.assertTrue(stream.locator(".project-convo__message > p").first.inner_text().startswith("Earlier note 01"))

    def test_02_a_thread_opens_beside_the_stream_and_takes_a_reply(self) -> None:
        page = self.page("ada")
        page.goto(self.project_url())
        r1 = self.root(page, "r1")
        expect(r1).to_be_visible()
        r1.evaluate("el => el.scrollIntoView({ block: 'center' })")
        page.wait_for_timeout(300)
        start = r1.bounding_box()
        assert start
        r1.get_by_role("button", name=re.compile(r"^2 replies")).click()
        expect(page).to_have_url(re.compile(rf"/projects/{self.ids['project']}/conversations/{self.ids['c1']}$"))
        thread = self.thread(page)
        expect(thread).to_be_visible()
        expect(thread).to_be_focused()
        expect(thread.locator(".thread__root")).to_contain_text(OPENING)
        expect(thread.locator(f"#message-{self.ids['first']}")).to_contain_text(FIRST_REPLY)
        expect(thread.locator(f"#message-{self.ids['second']}")).to_contain_text(SECOND_REPLY)
        expect(r1.get_by_role("button", name=re.compile(r"^2 replies"))).to_have_attribute("aria-expanded", "true")
        expect(r1).to_have_class(re.compile("is-open"))
        # Docked beside the stream on a wide screen; the root stays where the reader left it.
        stream_box, thread_box = page.locator(".project-convo__feed").bounding_box(), thread.bounding_box()
        assert stream_box and thread_box
        self.assertGreaterEqual(thread_box["x"], stream_box["x"] + stream_box["width"] - 1, "the thread docks to the right of the stream")
        self.assertGreaterEqual(stream_box["width"], 420, "the stream stays readable")
        page.wait_for_timeout(300)
        docked = r1.bounding_box()
        assert docked
        self.assertAlmostEqual(docked["y"], start["y"], delta=4, msg="opening the thread keeps the stream in place")
        # A reply's actions open from one ⋯ in its corner and never cover its author or time.
        first = thread.locator(f"#message-{self.ids['first']}")
        first.hover()
        expect(first.get_by_role("button", name="Create work")).to_have_count(0)
        more = first.get_by_role("button", name="Make from this message")
        more_box, name_box = more.bounding_box(), first.locator(".project-convo__message-meta strong").bounding_box()
        assert more_box and name_box
        self.assertTrue(more_box["x"] >= name_box["x"] + name_box["width"] or more_box["y"] >= name_box["y"] + name_box["height"], "the ⋯ is clear of the author")
        more.click()
        expect(more).to_have_attribute("aria-expanded", "true")
        first.get_by_role("button", name="Details of this message").click()
        expect(page.locator("#details").get_by_role("heading", name="Message from Jonas Berg")).to_be_visible()
        page.wait_for_timeout(300)
        expect(r1, "the opened root stays in view while Details is open").to_be_in_viewport()
        page.locator("#details").get_by_role("button", name="Close details").click()
        page.wait_for_timeout(300)
        expect(r1, "and after Details closes").to_be_in_viewport()
        composer = thread.get_by_label("Reply", exact=True)
        composer.fill("Agreed, ToF first. I will order the boards.")
        thread.get_by_role("button", name="Send reply").click()
        expect(thread.locator(".project-convo__message", has_text="Agreed, ToF first.")).to_be_visible()
        expect(composer).to_have_value("")
        expect(r1.get_by_role("button", name=re.compile(r"^3 replies"))).to_be_visible()
        expect(thread.locator(".thread__n")).to_have_text(re.compile("3"))
        page.wait_for_timeout(300)
        expect(r1, "a reply in the open thread leaves its root in view in the stream").to_be_in_viewport()
        saved = self.api(page, "GET", f"/api/v1/conversations/{self.ids['c1']}", status=200)
        self.assertEqual([m["body"] for m in saved["messages"]][-1], "Agreed, ToF first. I will order the boards.")
        self.assertEqual(len(saved["messages"]), 4, "a reply joins the same one-level thread")
        shot(page, "one-conversation-desktop-1440-thread-light")
        thread.get_by_role("button", name="Close replies").click()
        expect(self.thread(page)).to_have_count(0)
        expect(page).to_have_url(re.compile(rf"/projects/{self.ids['project']}$"))
        page.wait_for_timeout(300)
        closed = r1.bounding_box()
        assert closed
        self.assertAlmostEqual(closed["y"], start["y"], delta=4, msg="closing returns to the same place in the stream")
        expect(r1.get_by_role("button", name=re.compile(r"^3 replies"))).to_be_focused()
        # Reply on a root without replies opens its thread with the reply box ready; Esc closes it.
        self.root(page, "r3").get_by_role("button", name="Reply", exact=True).click()
        expect(page).to_have_url(re.compile(rf"/conversations/{self.ids['c3']}$"))
        expect(page.locator("#thread-composer")).to_be_focused()
        expect(self.thread(page)).to_contain_text("Reply to this message. No new topic needed.")
        page.keyboard.press("Escape")
        expect(self.thread(page)).to_have_count(0)
        expect(page).to_have_url(re.compile(rf"/projects/{self.ids['project']}$"))

    # ---------------------------------------------------------------- links keep working

    def test_03_old_conversation_urls_and_message_anchors_open_the_stream_there(self) -> None:
        page = self.page("ada")
        # The oldest conversation is outside the newest window: the stream reads back to its root.
        page.goto(self.project_url(f"/conversations/{self.ids['oldest']}"))
        oldest = self.root(page, "oldest_root")
        expect(oldest).to_be_in_viewport()
        expect(self.thread(page).locator(".thread__root")).to_contain_text("Earlier note 01")
        expect(self.thread(page)).to_contain_text("Reply to this message. No new topic needed.")
        # A reply's anchor opens its thread on that whole reply, focused; the stream shows its root.
        page.goto(self.project_url(f"/conversations/{self.ids['c1']}#message-{self.ids['first']}"))
        arrived = self.thread(page).locator(".project-convo__message.is-arrived")
        expect(arrived).to_contain_text(FIRST_REPLY)
        expect(arrived).to_be_focused()
        expect(arrived).to_be_in_viewport()
        expect(self.root(page, "r1")).to_be_in_viewport()
        expect(page.locator(".is-arrived")).to_have_count(1)
        # A root's anchor marks the root in the stream, with its thread beside it.
        page.goto(self.project_url(f"/conversations/{self.ids['c2']}#message-{self.ids['r2']}"))
        root = self.stream(page).locator(".project-convo__message.is-arrived")
        expect(root).to_have_attribute("id", f"message-{self.ids['r2']}")
        expect(root).to_be_focused()
        expect(self.thread(page)).to_contain_text(NUMBERS_REPLY)
        # The Conversation tab returns to the open thread after another view.
        tabs = page.get_by_role("navigation", name="Project views")
        tabs.get_by_role("link", name=re.compile("^Tasks")).click()
        expect(page).to_have_url(re.compile(r"/tasks$"))
        tabs.get_by_role("link", name=re.compile("^Conversation")).click()
        expect(self.thread(page)).to_contain_text(NUMBERS_REPLY)
        expect(self.root(page, "r2")).to_be_in_viewport()

    def test_04_an_inbox_notification_opens_the_thread_at_the_message(self) -> None:
        jonas = self.page("jonas")
        asked = self.api(jonas, "POST", f"/api/v1/conversations/{self.ids['c2']}/messages",
                         {"body": "@Ada Kowalska could you send the lux table before Friday?", "clientMessageId": str(uuid.uuid4())}, status=201)
        page = self.page("ada")
        url = None
        for _ in range(80):
            items = self.api(page, "GET", "/api/v1/inbox", status=200)["items"]
            url = next((item["url"] for item in items if item.get("url") and item["url"].endswith(f"#message-{asked['id']}")), None)
            if url:
                break
            time.sleep(0.25)
        self.assertEqual(url, self.project_url(f"/conversations/{self.ids['c2']}#message-{asked['id']}"), "the notification links the exact message")
        page.goto("/inbox")
        page.locator(".inbox__row", has_text="asked you in Night lamp").get_by_role("link").click()
        expect(page).to_have_url(re.compile(re.escape(url) + "$"))
        message = self.thread(page).locator(f"#message-{asked['id']}")
        expect(message).to_have_class(re.compile("is-arrived"))
        expect(message).to_be_in_viewport()
        expect(self.root(page, "r2")).to_be_in_viewport()

    # ---------------------------------------------------------------- writing a root

    def test_05_the_main_composer_starts_a_root_once_and_keeps_its_draft(self) -> None:
        page = self.page("jonas")
        page.goto(self.project_url())
        composer = page.get_by_label("Write a message", exact=True)
        body = "Shall we keep a PIR sensor as the backup for the ToF board?"
        composer.fill(body)
        expect(page.locator(".composer__audience")).to_contain_text("Ada, Lee and you")
        # The draft stays with the project across views.
        tabs = page.get_by_role("navigation", name="Project views")
        tabs.get_by_role("link", name=re.compile("^Tasks")).click()
        expect(page).to_have_url(re.compile(r"/tasks$"))
        tabs.get_by_role("link", name=re.compile("^Conversation")).click()
        expect(composer).to_have_value(body)

        # The server commits, the response is lost: the retry reuses the same key and adds one root.
        def lose_committed_start(route) -> None:
            if route.request.method != "POST":
                route.continue_()
                return
            response = route.fetch()
            self.assertEqual(response.status, 201)
            route.abort("failed")
        page.route("**/api/v1/projects/*/conversations", lose_committed_start)
        page.get_by_role("button", name="Send message").click()
        # Sending is instant (#264): the root waits at the end of the stream with its command, and the
        # quiet line says why; when Flux answers again it is sent once more, with the same key.
        queued = self.stream(page).locator("[data-client-message-id]").filter(has_text=body)
        expect(queued).to_contain_text("Waiting to send")
        expect(composer).to_have_value("")
        expect(page.get_by_text("Flux isn’t responding", exact=False)).to_be_visible()
        page.unroute("**/api/v1/projects/*/conversations", lose_committed_start)
        expect(queued).to_have_count(0, timeout=20000)
        expect(composer).to_have_value("")
        last = self.stream(page).locator(".project-convo__message").last
        expect(last).to_contain_text(body)
        expect(last).to_have_class(re.compile("is-mine"))
        expect(last).to_be_in_viewport()
        expect(page).to_have_url(re.compile(rf"/projects/{self.ids['project']}$"))
        expect(self.thread(page)).to_have_count(0)
        roots = self.all_roots(page)
        self.assertEqual(sum(root["message"]["body"] == body for root in roots), 1, "one root despite the lost response")
        self.assertEqual(roots[-1]["message"]["body"], body)
        page.reload()
        expect(page.get_by_label("Write a message", exact=True)).to_have_value("")

    def test_05b_an_assistant_prompt_in_the_stream_composer_is_never_posted(self) -> None:
        # UI116-3: a private helper prompt does not become a public root.
        page = self.page("ada")
        page.goto(self.project_url())
        before = len(self.all_roots(page))
        composer = page.get_by_label("Write a message", exact=True)
        composer.fill("/ai summarize the plan")
        hint = page.get_by_role("status").filter(has_text="Your assistant answers inside a conversation")
        expect(hint).to_be_visible()
        expect(composer).to_have_attribute("aria-describedby", re.compile("ai-hint"))
        expect(page.get_by_role("button", name="Send message")).to_have_attribute("aria-disabled", "true")
        composer.press("Enter")
        page.get_by_role("button", name="Send message").click(force=True)
        expect(composer).to_have_value("/ai summarize the plan")
        page.wait_for_timeout(500)
        self.assertEqual(len(self.all_roots(page)), before, "no root is created from an assistant prompt")
        # The text stays a private draft; another member sees no new root.
        other = self.page("jonas")
        self.assertFalse(any(root["message"]["body"].startswith("/ai") for root in self.all_roots(other)))
        composer.fill("")
        expect(hint).to_have_count(0)

    def test_05c_a_row_growing_above_the_reader_does_not_move_the_stream(self) -> None:
        # Foundation 10.5: a viewer's "1 reply" row appears on a root above the viewport (0 -> 1 replies)
        # after a focus refresh; the first root in view stays where it was.
        page = self.page("lee")
        page.goto(self.project_url())
        feed = page.locator(".project-convo__feed.is-stream")
        expect(self.root(page, "r3")).to_be_visible()
        roots = {root["message"]["id"]: root for root in self.all_roots(page)}
        loaded = page.eval_on_selector_all(".project-convo__feed.is-stream .project-convo__message", "items => items.map(item => item.id.slice(8))")
        quiet = [mid for mid in loaded if roots.get(mid, {}).get("replyCount") == 0]
        self.assertGreaterEqual(len(quiet), 12, "enough roots without replies in the loaded window")
        target, reader = quiet[2], quiet[8]
        # Mid-stream: the reader's root at the top of the feed, the target root above the viewport.
        page.evaluate("""([feedSel, id]) => { const feed = document.querySelector(feedSel); const item = document.getElementById(id);
            feed.scrollTop += item.getBoundingClientRect().top - feed.getBoundingClientRect().top - 4; }""",
                      [".project-convo__feed.is-stream", f"message-{reader}"])
        page.wait_for_timeout(300)
        first_visible = """(feedSel) => { const feed = document.querySelector(feedSel); const top = feed.getBoundingClientRect().top;
            for (const item of feed.querySelectorAll('.project-convo__message')) { const box = item.getBoundingClientRect();
              if (box.bottom > top + 1) return { id: item.id, top: box.top - top }; } return null; }"""
        before = page.evaluate(first_visible, ".project-convo__feed.is-stream")
        self.assertIn(before["id"], {f"message-{mid}" for mid in quiet[3:9]}, "mid-stream, below the target root")
        self.assertLess(page.evaluate("id => document.getElementById(id).getBoundingClientRect().bottom", f"message-{target}"),
                        feed.bounding_box()["y"], "the target root is above the viewport")
        other = self.page("jonas")
        self.api(other, "POST", f"/api/v1/conversations/{roots[target]['conversationId']}/messages",
                 {"body": "A late answer to an earlier note", "clientMessageId": str(uuid.uuid4())}, status=201)
        page.evaluate("() => window.dispatchEvent(new Event('focus'))")
        expect(page.locator(f"#message-{target} .convo-replies")).to_contain_text("1 reply")
        page.wait_for_timeout(300)
        after = page.evaluate(first_visible, ".project-convo__feed.is-stream")
        self.assertEqual(after["id"], before["id"], "the same root stays first in view")
        self.assertLessEqual(abs(after["top"] - before["top"]), 2, f"drift {after['top'] - before['top']:.1f}px")

    def test_05d_an_empty_workspace_stream_names_its_current_and_future_audience(self) -> None:
        owner = self.page("ada")
        workspace = self.api(owner, "POST", "/api/v1/workspaces", {"name": "Open conversation controls"}, status=201)
        project = self.api(owner, "POST", f"/api/v1/workspaces/{workspace['id']}/projects",
                           {"name": "Workspace conversation", "visibility": "workspace"}, status=201)
        path = f"/api/v1/projects/{project['id']}/conversation-roots"
        owner.goto(f"/projects/{project['id']}")
        stream = self.stream(owner)
        expect(stream.get_by_role("heading", name="Where do we start?")).to_be_visible()
        expect(stream).to_contain_text("Everyone in Workspace conversation sees it.")
        expect(stream).not_to_contain_text("Only you see it for now")
        self.assertEqual(self.api(owner, "GET", path, status=200)["roots"], [])
        people = self.api(owner, "GET", f"/api/v1/projects/{project['id']}/people", status=200)
        self.assertEqual([person["id"] for person in people], [self.ids["ada"]], "the initial empty workspace really has only its owner")

        # A current workspace member can read without an explicit project grant.
        member = self.page("jonas")
        self.api(member, "GET", path, status=404)
        self.api(owner, "POST", f"/api/v1/workspaces/{workspace['id']}/members",
                 {"email": PEOPLE["jonas"][1], "role": "member"}, status=201)
        self.assertEqual(self.api(member, "GET", path, status=200)["roots"], [])
        body = "This conversation is shared with the workspace."
        owner.get_by_label("Write a message", exact=True).fill(body)
        owner.get_by_role("button", name="Send message", exact=True).click()
        expect(owner.get_by_label("Write a message", exact=True)).to_have_value("")
        expect(owner.locator("[data-client-message-id]")).to_have_count(0)
        roots = self.api(owner, "GET", path, status=200)["roots"]
        self.assertEqual(len(roots), 1)
        self.assertEqual(roots[0]["message"]["body"], body)
        member.goto(f"/projects/{project['id']}")
        expect(member.locator(f"#message-{roots[0]['message']['id']}")).to_contain_text(body)

        # Joining later confers the same audience, including the already saved root.
        future = self.page("lee")
        self.api(future, "GET", path, status=404)
        self.api(owner, "POST", f"/api/v1/workspaces/{workspace['id']}/members",
                 {"email": PEOPLE["lee"][1], "role": "member"}, status=201)
        inherited = self.api(future, "GET", path, status=200)["roots"]
        self.assertEqual([(root["conversationId"], root["message"]["body"]) for root in inherited],
                         [(roots[0]["conversationId"], body)], "workspace membership inherits the saved conversation without a project grant")
        future.goto(f"/projects/{project['id']}")
        expect(future.locator(f"#message-{roots[0]['message']['id']}")).to_contain_text(body)

    def test_05e_an_empty_restricted_stream_keeps_the_only_owner_audience(self) -> None:
        owner = self.page("ada")
        workspace = self.api(owner, "POST", "/api/v1/workspaces", {"name": "Restricted conversation controls"}, status=201)
        self.api(owner, "POST", f"/api/v1/workspaces/{workspace['id']}/members",
                 {"email": PEOPLE["jonas"][1], "role": "member"}, status=201)
        project = self.api(owner, "POST", f"/api/v1/workspaces/{workspace['id']}/projects",
                           {"name": "Restricted conversation", "visibility": "restricted"}, status=201)
        path = f"/api/v1/projects/{project['id']}/conversation-roots"
        owner.goto(f"/projects/{project['id']}")
        stream = self.stream(owner)
        expect(stream.get_by_role("heading", name="Where do we start?")).to_be_visible()
        expect(stream).to_contain_text("Only you see it for now; people you add to the project will see it too.")
        self.assertEqual(self.api(owner, "GET", path, status=200)["roots"], [])
        member = self.page("jonas")
        self.api(member, "GET", path, status=404)
        body = "A restricted conversation still needs a project grant."
        owner.get_by_label("Write a message", exact=True).fill(body)
        owner.get_by_role("button", name="Send message", exact=True).click()
        expect(owner.get_by_label("Write a message", exact=True)).to_have_value("")
        expect(owner.locator("[data-client-message-id]")).to_have_count(0)
        roots = self.api(owner, "GET", path, status=200)["roots"]
        self.assertEqual(len(roots), 1)
        self.assertEqual(roots[0]["message"]["body"], body)
        self.api(member, "GET", path, status=404)

    def test_06_a_reader_reads_the_stream_and_threads_without_a_composer(self) -> None:
        page = self.page("lee")
        page.goto(self.project_url())
        stream = self.stream(page)
        expect(self.root(page, "r1")).to_be_visible()
        expect(page.locator("#project-composer")).to_have_count(0)
        expect(page.locator("#thread-composer")).to_have_count(0)
        expect(page.locator(".project-convo__read-only")).to_be_visible()
        expect(stream.get_by_role("button", name="Reply", exact=True)).to_have_count(0)
        self.root(page, "r1").get_by_role("button", name=re.compile(r"^3 replies")).click()
        thread = self.thread(page)
        expect(thread.locator(f"#message-{self.ids['first']}")).to_be_visible()
        expect(thread.get_by_role("textbox")).to_have_count(0)
        expect(thread.locator(".project-convo__read-only")).to_be_visible()
        expect(thread.get_by_role("button", name="Ask my assistant")).to_have_count(0)
        expect(thread.locator(".project-convo__current-thread")).not_to_contain_text("Replying to")
        self.api(page, "POST", f"/api/v1/conversations/{self.ids['c1']}/messages", {"body": "A reader cannot reply", "clientMessageId": str(uuid.uuid4())}, status=403)
        shot(page, "one-conversation-desktop-1440-reader")

    # ---------------------------------------------------------------- phone and tablet

    def test_07_phone_opens_the_thread_as_a_sheet(self) -> None:
        page = self.page("ada", phone=True)
        page.goto(self.project_url())
        r2 = self.root(page, "r2")
        expect(r2).to_be_visible()
        self.no_sideways_scroll(page)
        shot(page, "one-conversation-phone-390-light")
        r2.get_by_role("button", name=re.compile(r"^2 replies")).tap()
        thread = self.thread(page)
        expect(thread).to_be_visible()
        page.wait_for_timeout(400)
        sheet, header, pane = thread.bounding_box(), page.locator("header.top").bounding_box(), page.locator(".app__pane").bounding_box()
        assert sheet and header and pane
        self.assertEqual((round(sheet["x"]), round(sheet["width"])), (0, PHONE["width"]), "a full-width sheet")
        self.assertAlmostEqual(sheet["y"], pane["y"] + 12, delta=1, msg="the full sheet covers the work area, a grabber's breadth below its top")
        self.assertAlmostEqual(sheet["y"] + sheet["height"], pane["y"] + pane["height"], delta=1)
        expect(page.locator("header.top")).to_be_visible()
        close = thread.get_by_role("button", name="Close replies")
        close_box = close.bounding_box()
        assert close_box
        self.assertGreaterEqual(min(close_box["width"], close_box["height"]), 44, "a 44px way back")
        self.assertLess(close_box["x"], 60, "the way back sits first, at the left")
        composer = page.locator("#thread-composer")
        composer.tap()
        composer.fill("I will bring the lux meter tonight.")
        expect(composer).to_be_in_viewport()
        replies = thread.get_by_role("region", name="Replies to this message")
        expect(replies.locator(".project-convo__message").first).to_be_visible()
        self.no_sideways_scroll(page)
        shot(page, "one-conversation-phone-390-thread-light")
        thread.get_by_role("button", name="Send reply").tap()
        expect(thread.locator(".project-convo__message", has_text="I will bring the lux meter tonight.")).to_be_visible()
        close.tap()
        expect(self.thread(page)).to_have_count(0)
        expect(r2).to_be_in_viewport()
        expect(r2.get_by_role("button", name=re.compile(r"^3 replies"))).to_be_visible()

        dark = self.page("ada", phone=True, dark=True)
        dark.goto(self.project_url(f"/conversations/{self.ids['c1']}"))
        expect(self.thread(dark)).to_be_visible()
        self.no_sideways_scroll(dark)
        shot(dark, "one-conversation-phone-390-thread-dark")

        narrow = self.page("ada", phone=True, viewport={"width": 320, "height": 640})
        narrow.goto(self.project_url())
        expect(self.root(narrow, "r1")).to_be_visible()
        self.no_sideways_scroll(narrow)
        narrow.goto(self.project_url(f"/conversations/{self.ids['c1']}"))
        expect(self.thread(narrow).locator(f"#message-{self.ids['first']}")).to_be_visible()
        self.no_sideways_scroll(narrow)
        shot(narrow, "one-conversation-phone-320-thread-light")

    def test_08_tablet_and_desktop_renders(self) -> None:
        tablet = self.page("ada", phone=True, viewport={"width": 820, "height": 1180})
        tablet.goto(self.project_url())
        expect(self.root(tablet, "r1")).to_be_visible()
        self.no_sideways_scroll(tablet)
        shot(tablet, "one-conversation-tablet-820-light")
        self.root(tablet, "r1").get_by_role("button", name=re.compile(r"^3 replies")).tap()
        thread = self.thread(tablet)
        expect(thread).to_be_visible()
        tablet.wait_for_timeout(400)
        box, pane = thread.bounding_box(), tablet.locator(".app__pane").bounding_box()
        assert box and pane
        self.assertAlmostEqual(box["width"], pane["width"], delta=2, msg="too narrow to dock: the thread is a sheet over the stream")
        self.no_sideways_scroll(tablet)
        shot(tablet, "one-conversation-tablet-820-thread-light")

        dark = self.page("ada", dark=True)
        dark.goto(self.project_url(f"/conversations/{self.ids['c1']}"))
        expect(self.thread(dark)).to_be_visible()
        expect(self.root(dark, "r1")).to_be_in_viewport()
        shot(dark, "one-conversation-desktop-1440-thread-dark")
        dark.goto(self.project_url())
        expect(self.root(dark, "r3")).to_be_visible()
        shot(dark, "one-conversation-desktop-1440-dark")

    def test_09_light_and_dark_contrast_of_the_new_parts(self) -> None:
        for theme in ("light", "dark"):
            with self.subTest(theme=theme):
                page = self.page("ada", dark=theme == "dark")
                page.goto(self.project_url(f"/conversations/{self.ids['c1']}"))
                expect(self.thread(page).locator(f"#message-{self.ids['first']}")).to_be_visible()
                for selector in (f"#message-{self.ids['r1']} .convo-replies__open", f"#message-{self.ids['r1']} .convo-replies__when",
                                 ".thread__title", ".thread__n", ".thread__hint", ".thread__root-meta time", ".thread__root > p",
                                 f"#message-{self.ids['first']} > p", f"#message-{self.ids['r3']} .convo-replies__reply"):
                    if selector.endswith("convo-replies__reply"):
                        page.locator(selector).hover()
                    page.wait_for_function("""selector => {
                      const el = document.querySelector(selector); if (!el) return false;
                      for (let n = el; n; n = n.parentElement) if (Number(getComputedStyle(n).opacity) !== 1) return false;
                      return true;
                    }""", arg=selector, timeout=5000)
                    value = page.evaluate(MEASURE, {"selector": selector})
                    self.assertGreaterEqual(value["ratio"], 4.5, value)
                # The reply link (at rest and on hover) and the open root's ring are readable (#338, no accent colour).
                root = f"#message-{self.ids['r1']}"
                expect(page.locator(root)).to_have_class(re.compile("is-open"))
                page.mouse.move(1, 1)
                page.wait_for_timeout(250)
                rest = page.evaluate(MEASURE, {"selector": f"{root} .convo-replies__open"})
                self.assertGreaterEqual(rest["ratio"], 4.5, (theme, "reply link", rest))
                page.locator(f"{root} .convo-replies__open").hover()
                page.wait_for_timeout(250)
                hovered = page.evaluate(MEASURE, {"selector": f"{root} .convo-replies__open"})
                self.assertGreaterEqual(hovered["ratio"], 4.5, (theme, "reply link on hover", hovered))
                page.mouse.move(1, 1)
                page.wait_for_timeout(250)
                outline = page.locator(f"{root} > p").evaluate("e => { const s = getComputedStyle(e); return [s.outlineStyle, s.outlineWidth, s.outlineColor]; }")
                ink = page.evaluate("""() => { const probe = document.createElement('i'); probe.style.color = 'var(--t1)';
                  document.body.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; }""")
                self.assertEqual(outline, ["solid", "2px", ink], (theme, "the open root has a solid ring in the primary ink"))
                colour = [int(channel) for channel in re.findall(r"\d+", ink)[:3]]
                # The ring sits 2px outside the bubble, on the stream: measured against the stream.
                background = page.evaluate(MEASURE, {"selector": root})["background"]
                self.assertGreaterEqual(contrast(colour, background), 3, (theme, "open root ring", colour, background))


if __name__ == "__main__":
    unittest.main(verbosity=2)
