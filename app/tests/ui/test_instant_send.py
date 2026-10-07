"""Instant sending and the offline queue (#264, Apple HIG evaluation findings 4 and 13).

Runs with the other tests/ui modules through scripts/check_ui.sh against the running Compose
application. Ada and Jonas share a project (a root with a reply, and a task) and a direct message.
Each send is held, refused, lost or made offline at the network layer; assertions compare what the
person sees with the stored API state and the commands the browser sent. HIG-59/66/67/69/71 in
docs/design/apple-hig-mobile.md. Screenshots (instant-send-*.png) go to FLUX_UI_SCREENSHOTS.
"""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, Page, Route, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

PASSWORD = "messages that feel instant on a phone"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ada": ("Ada Kowalska", f"ada.instant+{STAMP}@example.test"),
    "jonas": ("Jonas Berg", f"jonas.instant+{STAMP}@example.test"),
}
OPENING = "Shall we test the lamp in the dark tonight?"
TASK = "Measure the lamp after dark"
WIDTHS = (1440, 390)

# Times the person's tap and the first queued message in the page itself (HIG-59: within 100 ms).
PROBE = """() => {
  window.__send = { clicked: null, shown: null };
  window.__scrolls = [];
  document.addEventListener('scroll', (event) => { const el = event.target === document ? document.scrollingElement : event.target;
    window.__scrolls.push([Math.round(performance.now()), String(el.className || el.tagName).slice(0, 30), Math.round(el.scrollTop)]); }, true);
  document.addEventListener('click', () => { if (window.__send.clicked === null) window.__send.clicked = performance.now(); }, true);
  new MutationObserver(() => {
    if (window.__send.shown === null && document.querySelector('[data-client-message-id]')) window.__send.shown = performance.now();
  }).observe(document.body, { subtree: true, childList: true, attributes: true });
}"""


# Every scrolled box on the page and the kept message's height, to tell layout from scrolling.
SCROLLERS = """() => ({ kept: document.querySelector('[data-probe=kept]')?.getBoundingClientRect().height,
  scrolled: [document.scrollingElement, ...document.querySelectorAll('*')].filter((el) => el && el.scrollHeight > el.clientHeight + 1 && getComputedStyle(el).overflowY !== 'visible' || el === document.scrollingElement)
    .map((el) => `${el.className || el.tagName}:${Math.round(el.scrollTop)}/${el.scrollHeight - el.clientHeight}`) })"""
# Where a message sits in its conversation: its top within the scrolled content of the box that scrolls it,
# so the pane following its end (or the shell's chrome changing the pane's height) does not count as a move.
PLACE = """el => {
  let box = el.parentElement;
  while (box && !['auto', 'scroll'].includes(getComputedStyle(box).overflowY)) box = box.parentElement;
  box = box || document.scrollingElement;
  return { place: el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop, top: el.getBoundingClientRect().top };
}"""


class InstantSendJourney(unittest.TestCase):
    """Each test opens fresh pages; the project, task and DM are shared."""

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
        contexts = {}
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
        post("ada", f"/api/v1/workspaces/{ws['id']}/members", {"email": PEOPLE["jonas"][1], "role": "member"})
        project = post("ada", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Night lamp", "visibility": "restricted"})
        pid = project["id"]
        post("ada", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": cls.ids["jonas"]}, "role": "contributor"})
        root = post("ada", f"/api/v1/projects/{pid}/conversations", {"body": OPENING, "clientMessageId": str(uuid.uuid4())})
        post("jonas", f"/api/v1/conversations/{root['id']}/messages", {"body": "Yes, after nine.", "clientMessageId": str(uuid.uuid4())})
        task = post("ada", f"/api/v1/projects/{pid}/work", {"title": TASK})
        post("ada", f"/api/v1/work/{task['id']}/discussion", {"body": "Starting the night measurements.", "clientMessageId": str(uuid.uuid4()), "kind": "text"})
        dm = post("ada", f"/api/v1/workspaces/{ws['id']}/dms", {"participantIds": [cls.ids["jonas"]]})
        post("jonas", f"/api/v1/dms/{dm['id']}/messages", {"body": "Can you bring the light meter?", "clientMessageId": str(uuid.uuid4())})
        for context in contexts.values():
            context.close()
        cls.ids.update(workspace=ws["id"], project=pid, conversation=root["id"], task=task["id"], dm=dm["id"])

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    # ---------------------------------------------------------------- helpers

    def page(self, who: str = "ada", width: int = 1440) -> Page:
        options: dict = {"base_url": ORIGIN, "locale": "en-GB", "timezone_id": "Europe/Warsaw", "storage_state": self.states[who]}
        if width < 681:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=DESKTOP, device_scale_factor=1)
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def api(self, page: Page, method: str, path: str, body: dict | None = None, status: int | None = 200) -> dict:
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers={"origin": ORIGIN, "content-type": "application/json"},
                                      data=json.dumps(body) if body is not None else None)
        if status is not None:
            self.assertEqual(response.status, status, response.text())
        return json.loads(response.text()) if response.text() else {}

    def roots(self, page: Page) -> list[dict]:
        return self.api(page, "GET", f"/api/v1/projects/{self.ids['project']}/conversation-roots?limit=100")["roots"]

    def replies(self, page: Page) -> list[dict]:
        return self.api(page, "GET", f"/api/v1/conversations/{self.ids['conversation']}?limit=100")["messages"]

    def posts(self, page: Page, path: str) -> list[dict]:
        """Every send command the page makes to `path` (a URL suffix), in order."""
        sent: list[dict] = []
        page.on("request", lambda request: sent.append(request.post_data_json) if request.method == "POST" and request.url.endswith(path) else None)
        return sent

    def hold(self, page: Page, pattern: str) -> list[Route]:
        """Holds each POST before it reaches the server, until the test lets it through."""
        held: list[Route] = []
        def handler(route: Route) -> None:
            if route.request.method == "POST":
                held.append(route)
            else:
                route.continue_()
        page.route(pattern, handler)
        self.unroute_later(page)
        return held

    def unroute_later(self, page: Page) -> None:
        def unroute() -> None:
            try:
                page.unroute_all(behavior="ignoreErrors")
            except Exception:  # noqa: BLE001 - the page may already be closed with its context
                pass
        self.addCleanup(unroute)

    def double_tap(self, page: Page, button, width: int) -> None:
        """A real double tap (or double click) on Send, without waiting for the button to stay enabled."""
        page.evaluate(PROBE)
        button.scroll_into_view_if_needed()
        box = button.bounding_box()
        assert box
        x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
        if width < 681:
            page.touchscreen.tap(x, y)
            page.touchscreen.tap(x, y)
        else:
            page.mouse.dblclick(x, y)

    def shown_within(self, page: Page) -> float:
        timing = page.evaluate("() => window.__send")
        self.assertIsNotNone(timing["clicked"])
        self.assertIsNotNone(timing["shown"])
        return timing["shown"] - timing["clicked"]

    def pending(self, scope, body: str):
        return scope.locator("[data-client-message-id]").filter(has_text=body)

    def assert_held_send_is_instant(self, page: Page, scope, field, button, body: str, held: list[Route], width: int, stored_selector: str, announcer: bool = True) -> None:
        """Send while the request is held, then release it: one queued message, then one stored one, in the same item."""
        field.fill(body)
        self.double_tap(page, button, width)
        bubble = self.pending(scope, body)
        expect(bubble).to_be_visible(timeout=1000)
        expect(bubble).to_contain_text("Sending…")
        expect(field).to_have_value("")
        delay = self.shown_within(page)
        at_once = page.evaluate(SCROLLERS)
        self.assertLess(delay, 100, "the message shows within 100 ms of the tap (HIG-59)")
        if announcer:
            # Announced once, politely (HIG-71); Agents' thread list is itself the live region.
            expect(page.locator("[data-send-announcer]").filter(has_text="Sending…")).to_have_count(1)
        else:
            expect(scope.locator("ol[aria-live='polite']")).to_have_count(1)
        expect(bubble).to_be_in_viewport()
        page.wait_for_timeout(400)
        self.assertEqual(len(held), 1, "a double tap sends one request")
        bubble.evaluate("el => { el.dataset.probe = 'kept'; }")
        start = bubble.evaluate(PLACE)
        before = page.evaluate(SCROLLERS)
        shot(page, f"instant-send-sending-{width}")
        held[0].continue_()
        stored = scope.locator(stored_selector).filter(has_text=body)
        expect(stored).to_have_count(1)
        expect(self.pending(scope, body)).to_have_count(0)
        # The stored message is the queued one's list item: not removed and added again, and not moved.
        expect(scope.locator("[data-probe='kept']")).to_have_count(1)
        expect(scope.locator("[data-probe='kept']")).to_contain_text(body)
        expect(scope.locator("[data-probe='kept']")).not_to_have_attribute("data-client-message-id", re.compile("."))
        end = scope.locator("[data-probe='kept']").evaluate(PLACE)
        moved = abs(end["place"] - start["place"])
        scrolled = end["top"] - start["top"]
        self.assertLessEqual(moved, 2, f"the message keeps its place when it is stored ({moved:.1f} px); scrollers {at_once} -> {before} -> {page.evaluate(SCROLLERS)}; "
                             f"send {page.evaluate('() => window.__send')}; scrolls {page.evaluate('() => window.__scrolls')}")
        print(f"\n{body!r}: queued message shown {delay:.1f} ms after the tap; moved {moved:.1f} px in its conversation when stored (viewport {scrolled:+.1f} px)")

    # ---------------------------------------------------------------- held sends

    def test_01_a_root_shows_at_once_and_becomes_the_stored_root(self) -> None:
        for width in WIDTHS:
            with self.subTest(width=width):
                page = self.page("ada", width)
                page.goto(f"/projects/{self.ids['project']}")
                stream = page.get_by_role("region", name="Messages")
                expect(stream.get_by_text(OPENING)).to_be_visible()
                held = self.hold(page, "**/api/v1/projects/*/conversations")
                body = f"Root sent at {width}: the dark test starts at nine."
                self.assert_held_send_is_instant(page, stream, page.get_by_label("Write a message", exact=True), page.get_by_role("button", name="Send message"),
                                                 body, held, width, ".project-convo__message:not(.is-pending)")
                self.assertEqual(sum(root["message"]["body"] == body for root in self.roots(page)), 1, "one stored root")

    def test_02_a_reply_shows_at_once_in_its_thread(self) -> None:
        for width in WIDTHS:
            with self.subTest(width=width):
                page = self.page("jonas", width)
                page.goto(f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}")
                thread = page.get_by_role("complementary", name="Replies")
                expect(thread.get_by_text("Yes, after nine.")).to_be_visible()
                held = self.hold(page, "**/api/v1/conversations/*/messages")
                body = f"Reply sent at {width}: I will bring the light meter."
                self.assert_held_send_is_instant(page, thread, thread.get_by_label("Reply", exact=True), thread.get_by_role("button", name="Send reply"),
                                                 body, held, width, ".project-convo__message:not(.is-pending)")
                self.assertEqual(sum(message["body"] == body for message in self.replies(page)), 1, "one stored reply")

    def test_03_a_direct_message_shows_at_once(self) -> None:
        for width in WIDTHS:
            with self.subTest(width=width):
                page = self.page("jonas", width)
                page.goto(f"/dm/{self.ids['dm']}")
                expect(page.locator(".dm-msg__body", has_text="Can you bring the light meter?")).to_be_visible()
                held = self.hold(page, "**/api/v1/dms/*/messages")
                body = f"DM sent at {width}: yes, and spare batteries."
                list_ = page.get_by_role("list", name="Messages")
                self.assert_held_send_is_instant(page, list_, page.get_by_label(re.compile(r"^Message ")), page.get_by_role("button", name="Send message"),
                                                 body, held, width, ".dm-msg:not(.is-pending)")
                dm = self.api(page, "GET", f"/api/v1/dms/{self.ids['dm']}")
                self.assertEqual(sum(message["body"] == body for message in dm["messages"]), 1, "one stored direct message")

    def test_04_the_task_thread_in_agents_shows_at_once(self) -> None:
        for width in WIDTHS:
            with self.subTest(width=width):
                page = self.page("ada", width)
                page.goto(f"/projects/{self.ids['project']}/agents?task={self.ids['task']}")
                thread = page.get_by_role("region", name=f"Thread of {TASK}")
                expect(thread.get_by_text("Starting the night measurements.")).to_be_visible()
                held = self.hold(page, "**/api/v1/work/*/discussion")
                body = f"Agents note at {width}: the sensor reads 4 lux at nine."
                self.assert_held_send_is_instant(page, thread, page.get_by_label("Write to this task"), page.get_by_role("button", name="Send to task"),
                                                 body, held, width, ".agents-msg:not(.is-pending)", announcer=False)
                discussion = self.api(page, "GET", f"/api/v1/work/{self.ids['task']}/discussion")
                self.assertEqual(sum(message["body"] == body for message in discussion["messages"]), 1, "one stored task message")

    # ---------------------------------------------------------------- failures

    def test_05_not_sent_offers_retry_with_the_same_command_and_stores_one_message(self) -> None:
        for width in WIDTHS:
            with self.subTest(width=width):
                page = self.page("jonas", width)
                page.goto(f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}")
                thread = page.get_by_role("complementary", name="Replies")
                expect(thread.get_by_text("Yes, after nine.")).to_be_visible()
                sent = self.posts(page, f"/conversations/{self.ids['conversation']}/messages")
                lost: list[dict] = []
                def lose(route: Route) -> None:
                    # The server stores the reply, then the answer is replaced by an error.
                    if route.request.method == "POST" and not lost:
                        response = route.fetch()
                        self.assertEqual(response.status, 201)
                        lost.append(route.request.post_data_json)
                        route.fulfill(status=503, content_type="application/json", body="{}")
                    else:
                        route.continue_()
                page.route("**/api/v1/conversations/*/messages", lose)
                self.unroute_later(page)
                body = f"Not sent at {width}, then retried once."
                field = thread.get_by_label("Reply", exact=True)
                field.fill(body)
                thread.get_by_role("button", name="Send reply").click()
                bubble = self.pending(thread, body)
                failed = bubble.get_by_role("alert")
                expect(failed).to_contain_text("Not sent")
                expect(failed.get_by_role("button", name="Retry")).to_be_visible()
                expect(failed.get_by_role("button", name="Remove")).to_be_visible()
                expect(field).to_have_value("")
                if width < 681:
                    retry = failed.get_by_role("button", name="Retry").bounding_box()
                    assert retry
                    self.assertGreaterEqual(min(retry["width"], retry["height"]), 44, "Retry is a 44 px target on touch (HIG-14)")
                shot(page, f"instant-send-not-sent-{width}")
                self.assertEqual(sum(message["body"] == body for message in self.replies(page)), 1, "the server already holds it")
                if width < 681:
                    failed.get_by_role("button", name="Retry").tap()
                else:
                    failed.get_by_role("button", name="Retry").click()
                expect(thread.locator(".project-convo__message:not(.is-pending)").filter(has_text=body)).to_have_count(1)
                expect(self.pending(thread, body)).to_have_count(0)
                self.assertEqual(len(sent), 2)
                self.assertEqual(sent[1], sent[0], "Retry repeats the same command and clientMessageId")
                self.assertEqual(sent[0]["clientMessageId"], lost[0]["clientMessageId"])
                self.assertEqual(sum(message["body"] == body for message in self.replies(page)), 1, "exactly one stored reply")

    def test_06_a_lost_connection_shows_the_line_and_retry_now_sends_once(self) -> None:
        page = self.page("ada", 390)
        page.goto(f"/projects/{self.ids['project']}")
        stream = page.get_by_role("region", name="Messages")
        expect(stream.get_by_text(OPENING)).to_be_visible()
        sent = self.posts(page, f"/projects/{self.ids['project']}/conversations")
        lost: list[str] = []
        down = {"flux": True}
        def lose(route: Route) -> None:
            # The first is stored, but the browser never hears back; while Flux is down nothing answers.
            if route.request.method == "POST" and down["flux"]:
                if not lost:
                    response = route.fetch()
                    self.assertEqual(response.status, 201)
                    lost.append(route.request.post_data_json["clientMessageId"])
                route.abort("failed")
            else:
                route.continue_()
        page.route("**/api/v1/projects/*/conversations", lose)
        # Flux's light reachability check (and any reload of the page's data) gets no answer either.
        page.route("**/api/v1/me", lambda route: route.abort("failed") if down["flux"] else route.continue_())
        self.unroute_later(page)
        body = "Lost answer: the root waits and is sent again once."
        page.get_by_label("Write a message", exact=True).fill(body)
        page.get_by_role("button", name="Send message").tap()
        bubble = self.pending(stream, body)
        line = page.get_by_text("Flux isn’t responding. Messages wait here and send when it’s back.")
        expect(bubble).to_contain_text("Waiting to send")
        # F-026: the waiting state is a clock and words, not a dot.
        expect(bubble.locator(".outbox-status.is-waiting svg")).to_have_count(1)
        expect(bubble.locator(".outbox-status.is-waiting .outbox-status__dot")).to_have_count(0)
        expect(line).to_be_visible()
        shot(page, "instant-send-unreachable-390")
        page.wait_for_timeout(500)
        self.assertEqual(len(sent), 1, "nothing is resent while Flux does not answer")
        # Retry while Flux still does not answer: the conversation, the line and the message stay.
        bubble.get_by_role("button", name="Retry").tap()
        for wait in (300, 1200):
            page.wait_for_timeout(wait)
            expect(page.get_by_text("Flux can’t be reached", exact=False)).to_have_count(0)
            expect(stream.get_by_text(OPENING)).to_be_visible()
            expect(bubble).to_contain_text("Waiting to send")
            expect(line).to_be_visible()
        self.assertEqual(len(sent), 2, "the Retry was one attempt")
        # Flux answers again: Retry now stores it once, with the same command.
        down["flux"] = False
        bubble.get_by_role("button", name="Retry").tap()
        expect(stream.locator(".project-convo__message:not(.is-pending)").filter(has_text=body)).to_have_count(1)
        expect(page.get_by_text("Flux isn’t responding", exact=False)).to_have_count(0)
        self.assertEqual([command["clientMessageId"] for command in sent], [lost[0]] * 3, "the same command each time")
        self.assertEqual(sum(root["message"]["body"] == body for root in self.roots(page)), 1, "exactly one stored root")

    def test_10_back_online_while_flux_is_down_keeps_the_conversation(self) -> None:
        page = self.page("ada", 1440)
        page.goto(f"/projects/{self.ids['project']}")
        stream = page.get_by_role("region", name="Messages")
        expect(stream.get_by_text(OPENING)).to_be_visible()
        sent = self.posts(page, f"/projects/{self.ids['project']}/conversations")
        down = {"flux": True}
        page.route("**/api/v1/projects/*/conversations", lambda route: route.abort("failed") if route.request.method == "POST" and down["flux"] else route.continue_())
        page.route("**/api/v1/me", lambda route: route.abort("failed") if down["flux"] else route.continue_())
        self.unroute_later(page)
        page.context.set_offline(True)
        expect(page.get_by_text("You’re offline", exact=False)).to_be_visible(timeout=2000)
        body = "Back online, but Flux is not: the stream stays."
        page.get_by_label("Write a message", exact=True).fill(body)
        page.get_by_role("button", name="Send message").click()
        bubble = self.pending(stream, body)
        expect(bubble).to_contain_text("Waiting to send")
        # The browser is online again; Flux still does not answer. Nothing reloads into an error page.
        page.context.set_offline(False)
        page.wait_for_timeout(1500)
        expect(page.get_by_text("Flux can’t be reached", exact=False)).to_have_count(0)
        expect(stream.get_by_text(OPENING)).to_be_visible()
        expect(bubble).to_contain_text("Waiting to send")
        expect(page.get_by_text("Flux isn’t responding", exact=False)).to_be_visible()
        # Flux answers its next check: the message goes once, by itself.
        down["flux"] = False
        expect(stream.locator(".project-convo__message:not(.is-pending)").filter(has_text=body)).to_have_count(1, timeout=10000)
        self.assertEqual(len({command["clientMessageId"] for command in sent}), 1)
        self.assertEqual(sum(root["message"]["body"] == body for root in self.roots(page)), 1, "exactly one stored root")

    def test_07_a_refused_send_returns_to_the_field_and_remove_returns_an_unsent_one(self) -> None:
        page = self.page("ada", 1440)
        page.goto(f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}")
        thread = page.get_by_role("complementary", name="Replies")
        expect(thread.get_by_text("Yes, after nine.")).to_be_visible()
        refuse = {"status": 404}
        def answer(route: Route) -> None:
            if route.request.method == "POST":
                route.fulfill(status=refuse["status"], content_type="application/json", body=json.dumps({"code": "NOT_FOUND", "message": "Unavailable"}))
            else:
                route.continue_()
        page.route("**/api/v1/conversations/*/messages", answer)
        self.unroute_later(page)
        field = thread.get_by_label("Reply", exact=True)
        # A refusal a retry cannot fix: the draft comes back to the empty field with the reason.
        field.fill("Refused once: back in the field.")
        thread.get_by_role("button", name="Send reply").click()
        expect(field).to_have_value("Refused once: back in the field.")
        expect(thread.get_by_role("alert")).to_contain_text("Your draft, files and sources are kept.")
        expect(self.pending(thread, "Refused once")).to_have_count(0)
        # A server failure stays on the message; Remove brings it back to the (empty) field to edit.
        field.fill("")
        refuse["status"] = 503
        field.fill("Server failure: remove to edit.")
        thread.get_by_role("button", name="Send reply").click()
        expect(self.pending(thread, "Server failure").get_by_role("alert")).to_contain_text("Not sent")
        expect(field).to_have_value("")
        self.pending(thread, "Server failure").get_by_role("button", name="Remove").click()
        expect(self.pending(thread, "Server failure")).to_have_count(0)
        expect(field).to_have_value("Server failure: remove to edit.")
        self.assertEqual([m for m in self.replies(page) if m["body"].startswith(("Refused once", "Server failure"))], [], "nothing was stored")
        field.fill("")

    # ---------------------------------------------------------------- offline

    def test_08_offline_messages_wait_and_send_in_order_once_when_back(self) -> None:
        for width in WIDTHS:
            with self.subTest(width=width):
                page = self.page("ada", width)
                page.goto(f"/projects/{self.ids['project']}")
                stream = page.get_by_role("region", name="Messages")
                expect(stream.get_by_text(OPENING)).to_be_visible()
                sent = self.posts(page, f"/projects/{self.ids['project']}/conversations")
                field = page.get_by_label("Write a message", exact=True)
                button = page.get_by_role("button", name="Send message")
                page.context.set_offline(True)
                line = page.get_by_text("You’re offline. Messages send when you’re back.")
                expect(line).to_be_visible(timeout=2000)
                bodies = [f"Offline at {width}, first.", f"Offline at {width}, second."]
                for body in bodies:
                    field.fill(body)
                    if width < 681:
                        button.tap()
                    else:
                        button.click()
                    expect(self.pending(stream, body)).to_contain_text("Waiting to send")
                    expect(field).to_have_value("")
                ids = [self.pending(stream, body).get_attribute("data-client-message-id") for body in bodies]
                page.wait_for_timeout(500)
                self.assertEqual(sent, [], "nothing is sent while offline")
                shot(page, f"instant-send-offline-{width}")
                page.context.set_offline(False)
                for body in bodies:
                    expect(stream.locator(".project-convo__message:not(.is-pending)").filter(has_text=body)).to_have_count(1)
                expect(line).to_have_count(0)
                self.assertEqual([command["clientMessageId"] for command in sent], ids, "sent once each, in order, with the queued ids")
                stored = [root["message"]["body"] for root in self.roots(page) if root["message"]["body"] in bodies]
                self.assertEqual(stored, bodies, "stored once each, in the order they were sent")

    def test_09_an_offline_direct_message_waits_and_sends_once(self) -> None:
        page = self.page("jonas", 390)
        page.goto(f"/dm/{self.ids['dm']}")
        expect(page.locator(".dm-msg__body", has_text="Can you bring the light meter?")).to_be_visible()
        sent = self.posts(page, f"/dms/{self.ids['dm']}/messages")
        page.context.set_offline(True)
        expect(page.get_by_text("You’re offline", exact=False)).to_be_visible(timeout=2000)
        body = "Written in the tunnel: see you at nine."
        page.get_by_label(re.compile(r"^Message ")).fill(body)
        page.get_by_role("button", name="Send message").tap()
        list_ = page.get_by_role("list", name="Messages")
        expect(self.pending(list_, body)).to_contain_text("Waiting to send")
        page.wait_for_timeout(300)
        self.assertEqual(sent, [])
        page.context.set_offline(False)
        expect(list_.locator(".dm-msg:not(.is-pending)").filter(has_text=body)).to_have_count(1)
        self.assertEqual(len(sent), 1)
        dm = self.api(page, "GET", f"/api/v1/dms/{self.ids['dm']}")
        self.assertEqual(sum(message["body"] == body for message in dm["messages"]), 1)

    def test_11_a_message_sent_while_its_file_uploads_shows_uploading_then_the_stored_file(self) -> None:
        for width in WIDTHS:
            with self.subTest(width=width):
                page = self.page("jonas", width)
                page.goto(f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}")
                thread = page.get_by_role("complementary", name="Replies")
                expect(thread.get_by_text("Yes, after nine.")).to_be_visible()
                uploads = self.hold(page, "**/api/v1/projects/*/files?*")
                name = f"night-readings-{width}.bin"
                with page.expect_file_chooser() as chooser:
                    thread.get_by_role("button", name="Attach files", exact=True).click()
                chooser.value.set_files({"name": name, "mimeType": "application/octet-stream", "buffer": b"\x00\x04 lux at nine"})
                expect(thread.get_by_role("list", name="Files in your draft")).to_contain_text("Uploading…")
                field = thread.get_by_label("Reply", exact=True)
                body = f"Readings at {width} attached."
                field.fill(body)
                # Sent before its file is staged: the message shows at once with the file, marked "Uploading…".
                thread.get_by_role("button", name="Send reply").click()
                bubble = self.pending(thread, body)
                expect(bubble).to_contain_text("Uploading…")
                expect(bubble).to_contain_text(name)
                expect(field).to_have_value("")
                expect(thread.get_by_role("list", name="Files in your draft")).to_have_count(0)
                shot(page, f"instant-send-uploading-{width}")
                self.assertEqual(len(uploads), 1)
                uploads[0].continue_()
                stored = thread.locator(".project-convo__message:not(.is-pending)").filter(has_text=body)
                expect(stored).to_have_count(1)
                expect(stored.get_by_role("link", name=re.compile(re.escape(name)))).to_have_count(1)
                expect(self.pending(thread, body)).to_have_count(0)
                reply = next(message for message in self.replies(page) if message["body"] == body)
                self.assertEqual([file["name"] for file in reply["files"]], [name], "stored once, with its file")

    def test_13_remove_with_text_in_the_field_keeps_the_message(self) -> None:
        page = self.page("ada", 1440)
        page.goto(f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}")
        thread = page.get_by_role("complementary", name="Replies")
        expect(thread.get_by_text("Yes, after nine.")).to_be_visible()
        held = self.hold(page, "**/api/v1/conversations/*/messages")
        field = thread.get_by_label("Reply", exact=True)
        first, second = "Kept A: not sent, never lost.", "Kept B: typed meanwhile."
        field.fill(first)
        thread.get_by_role("button", name="Send reply").click()
        expect(self.pending(thread, first)).to_contain_text("Sending…")
        field.fill(second)
        page.wait_for_timeout(200)
        self.assertEqual(len(held), 1)
        held[0].fulfill(status=404, content_type="application/json", body=json.dumps({"code": "NOT_FOUND", "message": "Unavailable"}))
        failed = self.pending(thread, first).get_by_role("alert")
        expect(failed).to_contain_text("Not sent")
        failed.get_by_role("button", name="Remove").click()
        # The field holds B: A stays, says what to do first, and is still kept by the browser.
        expect(self.pending(thread, first)).to_have_count(1)
        expect(failed).to_contain_text("Send or clear your text first, then remove it to edit it.")
        expect(failed).to_contain_text("Your access, a file or a source may be unavailable.")
        expect(field).to_have_value(second)
        self.assertIn(first, page.evaluate("() => JSON.stringify(Object.values(localStorage))"))
        # With the field cleared, Remove returns A to it.
        field.fill("")
        failed.get_by_role("button", name="Remove").click()
        expect(self.pending(thread, first)).to_have_count(0)
        expect(field).to_have_value(first)
        field.fill("")

    def test_14_an_upload_cut_by_going_offline_waits_and_one_line_shows(self) -> None:
        for width in WIDTHS:
            with self.subTest(width=width):
                page = self.page("jonas", width)
                page.goto(f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}")
                thread = page.get_by_role("complementary", name="Replies")
                expect(thread.get_by_text("Yes, after nine.")).to_be_visible()
                uploads = self.hold(page, "**/api/v1/projects/*/files?*")
                name = f"offline-readings-{width}.bin"
                with page.expect_file_chooser() as chooser:
                    thread.get_by_role("button", name="Attach files", exact=True).click()
                chooser.value.set_files({"name": name, "mimeType": "application/octet-stream", "buffer": b"\x00\x05 lux offline"})
                body = f"Readings at {width} sent as the connection dropped."
                thread.get_by_label("Reply", exact=True).fill(body)
                button = thread.get_by_role("button", name="Send reply")
                button.tap() if width < 681 else button.click()
                bubble = self.pending(thread, body)
                expect(bubble).to_contain_text("Uploading…")
                page.context.set_offline(True)
                uploads[0].abort("internetdisconnected")
                # The upload was cut: the message says why (HIG-67), not "Uploading…".
                expect(bubble).to_have_attribute("data-send-state", "waiting")
                expect(bubble).to_contain_text("Waiting to send")
                expect(bubble).not_to_contain_text("Uploading…")
                # The stream and the thread both have a composer: one line on the screen.
                expect(page.locator(".connection-line")).to_have_count(1)
                expect(page.locator(".connection-line")).to_be_visible()
                page.unroute_all(behavior="ignoreErrors")
                page.context.set_offline(False)
                stored = thread.locator(".project-convo__message:not(.is-pending)").filter(has_text=body)
                expect(stored).to_have_count(1, timeout=10000)
                expect(page.locator(".connection-line")).to_have_count(0)
                reply = [message for message in self.replies(page) if message["body"] == body]
                self.assertEqual([[file["name"] for file in message["files"]] for message in reply], [[name]], "stored once, with its file")

    # ---------------------------------------------------------------- server idempotency

    def test_12_the_same_client_message_id_posted_twice_stores_one_message(self) -> None:
        page = self.page("ada", 1440)
        pid, cid, wid, dmid = self.ids["project"], self.ids["conversation"], self.ids["task"], self.ids["dm"]
        cases = [
            (f"/api/v1/projects/{pid}/conversations", {}, lambda: [r["message"]["body"] for r in self.roots(page)]),
            (f"/api/v1/conversations/{cid}/messages", {}, lambda: [m["body"] for m in self.replies(page)]),
            (f"/api/v1/work/{wid}/discussion", {"kind": "text"}, lambda: [m["body"] for m in self.api(page, "GET", f"/api/v1/work/{wid}/discussion?limit=100")["messages"]]),
            (f"/api/v1/dms/{dmid}/messages", {}, lambda: [m["body"] for m in self.api(page, "GET", f"/api/v1/dms/{dmid}")["messages"]]),
        ]
        for path, extra, bodies in cases:
            with self.subTest(path=path):
                body = f"Idempotent {uuid.uuid4().hex[:8]}"
                command = {"body": body, "clientMessageId": str(uuid.uuid4()), **extra}
                first = self.api(page, "POST", path, command, status=None)
                second = self.api(page, "POST", path, command, status=None)
                self.assertEqual(first["id"], second["id"], "the retry returns the original")
                self.assertEqual(bodies().count(body), 1, "one stored message")


if __name__ == "__main__":
    unittest.main()
