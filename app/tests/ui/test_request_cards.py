"""Browser tests for the request cards in a task's agents' thread (#400 AC-4, #153 AC-2/AC-4).

Hubert manages a project with Marek (a contributor) and Vera (a viewer). The cards are read from the task's coordination
record, shown in plain words above the thread's messages: kind, sender -> recipient, the target, the state, a review's
verdict with whether it still applies, "Open original message", "Download packet" and, for a person who may, "Cancel request".
The server's records and its authorization (who may cancel, what a packet holds) are proved by the API suite against real
requests; here the coordination read, the packet and the cancel are served by a stub shaped like those answers, so this
checks what a person sees and can do, at 1440x900 and 390x844, light and dark, with negative controls.
"""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, shot as save_shot, start_forwarder

PASSWORD = "the agents keep one thread"
STAMP = int(time.time() * 1000)
HUBERT = {"name": "Hubert Nowak", "email": f"hubert.cards+{STAMP}@example.test"}
MAREK = {"name": "Marek Lis", "email": f"marek.cards+{STAMP}@example.test"}
VERA = {"name": "Vera Cole", "email": f"vera.cards+{STAMP}@example.test"}
TASK = "Compare the lamp measurements"
THREAD = f"Agents’ thread of {TASK}"
REGION = "Requests between agents"


def shot(page: Page, name: str) -> None:
    save_shot(page, name if UI_BROWSER == "chromium" else f"{name}-{UI_BROWSER}")


def iso(minutes_ago: int) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(time.time() - minutes_ago * 60))


class Coordination:
    """The task's coordination record as the server answers it, with the state a cancel changes."""

    def __init__(self, task_id: str, conversation_id: str, first_message: str, *, can_cancel: bool) -> None:
        self.task_id = task_id
        self.cancels: list[dict] = []
        self.packets: list[str] = []
        self.refuse_cancel: tuple[int, str] | None = None
        self.can_cancel = can_cancel
        message = {"messageId": first_message, "conversationId": conversation_id, "space": "agents", "taskId": task_id}

        def card(number: int, kind: str, state: str, status: str, **extra) -> dict:
            base = {
                "id": f"00000000-0000-4000-8000-{number:012d}", "kind": kind, "state": state, "version": 1, "status": status, "reason": None,
                "nextBoundary": None, "target": {"type": "work", "id": task_id, "version": 3}, "targetTitle": f"#12 {TASK}", "targetAvailable": True,
                "responseRef": None, "originalMessage": None,
                "sender": {"connectionId": "c1", "name": "Codex", "ownerName": "Hubert Nowak"},
                "recipient": {"connectionId": "c2", "name": "Marek Claude", "ownerName": "Marek Lis"},
                "cancelledBy": None, "canCancel": False, "createdAt": iso(10 + number), "updatedAt": iso(5), "expiresAt": iso(-1000),
            }
            base.update(extra)
            return base

        self.requests = [
            card(1, "review", "queued", "queued", originalMessage=message, canCancel=True),
            card(2, "handoff", "deferred", "deferred", reason="busy", nextBoundary="after_tests", canCancel=True),
            card(3, "help", "claimed", "working", canCancel=True, recipient={"connectionId": "c3", "name": "Hubert Claude", "ownerName": "Hubert Nowak"}),
            card(4, "fix", "queued", "offline", canCancel=True),
            card(5, "review", "resolved", "resolved"),
            card(6, "review", "resolved", "resolved", target={"type": "work", "id": task_id, "version": 2}, targetTitle=None, targetAvailable=False),
            card(7, "help", "declined", "declined", reason="scope"),
            card(8, "fix", "superseded", "superseded", reason="newer_request"),
            card(9, "help", "expired", "expired"),
            card(10, "review", "cancelled", "cancelled", reason="cancelled_by_person", cancelledBy={"name": "Marek Lis"}),
        ]
        verdict = lambda number, outcome, current: {  # noqa: E731
            "requestId": f"00000000-0000-4000-8000-{number:012d}", "verdict": outcome, "target": {"type": "work", "id": task_id, "version": 3},
            "criteriaRefs": [], "evidenceRef": {"type": "result", "id": str(uuid.uuid4())}, "reviewer": {"connectionId": "c2", "name": "Marek Claude"},
            "author": {"connectionId": "c1", "name": "Codex"}, "current": current, "createdAt": iso(30)}
        self.verdicts = [verdict(5, "passed", True), verdict(6, "changes_requested", False)]

    def body(self) -> dict:
        requests = [{**r, "canCancel": r["canCancel"] and self.can_cancel} for r in self.requests]
        return {"taskId": self.task_id, "requests": requests, "verdicts": self.verdicts}

    def handler(self, route) -> None:
        request = route.request
        url = request.url
        if request.method == "GET" and url.endswith("/coordination"):
            route.fulfill(json=self.body())
        elif request.method == "GET" and url.endswith("/packet"):
            self.packets.append(url)
            route.fulfill(body=json.dumps({"schema": "flux.cowork.packet/1"}), content_type="application/json",
                          headers={"content-disposition": 'attachment; filename="flux-handoff-12-00000001.json"'})
        elif request.method == "POST" and url.endswith("/cancel"):
            body = json.loads(request.post_data or "{}")
            self.cancels.append(body)
            if self.refuse_cancel:
                status, code = self.refuse_cancel
                route.fulfill(status=status, json={"error": "refused", "code": code})
                return
            request_id = url.split("/requests/")[1].split("/")[0]
            card = next(r for r in self.requests if r["id"] == request_id)
            card.update(state="cancelled", status="cancelled", version=card["version"] + 1, reason="cancelled_by_person",
                        cancelledBy={"name": "Hubert Nowak"}, canCancel=False)
            route.fulfill(json=card)
        else:
            route.continue_()


class RequestCardsJourney(unittest.TestCase):
    """Tests run in name order and share three accounts, one project, one task and a long agents' thread."""

    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=8000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, who: str | None, *, phone: bool = False, dark: bool = False) -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": "dark" if dark else "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw",
                         "service_workers": "block", "accept_downloads": True}
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=DESKTOP, device_scale_factor=1)
        if who and who in self.states:
            options["storage_state"] = self.states[who]
        context: BrowserContext = self.browser.new_context(**options)
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

    def thread_url(self, fragment: str = "") -> str:
        return f"/projects/{self.ids['project']}/agents?thread={self.ids['task']}{fragment}"

    def cards(self, who: str, *, can_cancel: bool, phone: bool = False, dark: bool = False, open_url: str | None = None) -> tuple[Page, Coordination]:
        page = self.page(who, phone=phone, dark=dark)
        stub = Coordination(self.ids["task"], self.ids["conversation"], self.ids["first"], can_cancel=can_cancel)
        page.route(re.compile(rf".*/api/v1/work/{self.ids['task']}/coordination(/.*)?$"), stub.handler)
        page.goto(open_url or self.thread_url())
        return page, stub

    def test_01_the_fixture(self) -> None:
        for key, person in {"hubert": HUBERT, "marek": MAREK, "vera": VERA}.items():
            page = self.page(None)
            page.goto("/sign-up")
            page.get_by_label("Name").fill(person["name"])
            page.get_by_label("Email").fill(person["email"])
            page.get_by_label("Password").fill(PASSWORD)
            page.get_by_role("button", name="Create account").click()
            expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
            type(self).states[key] = page.context.storage_state()
            person["id"] = self.api(page, "GET", "/api/v1/me", status=200)["user"]["id"]
        hubert = self.page("hubert")
        ws = self.api(hubert, "POST", "/api/v1/workspaces", {"name": "Lamp workshop"}, status=201)
        for person in (MAREK, VERA):
            self.api(hubert, "POST", f"/api/v1/workspaces/{ws['id']}/members", {"email": person["email"], "role": "member"}, status=201)
        pid = self.api(hubert, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Arduino lamp", "visibility": "restricted"}, status=201)["id"]
        for person, role in ((MAREK, "contributor"), (VERA, "viewer")):
            self.api(hubert, "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": person["id"]}, "role": role}, status=201)
        task = self.api(hubert, "POST", f"/api/v1/projects/{pid}/work", {"title": TASK}, status=201)
        # A long thread: the first message is older than the first page, so "Open original message" has to page back to it.
        first = self.api(hubert, "POST", f"/api/v1/work/{task['id']}/agent-thread", {"body": "Please compare the second reading with the baseline.", "clientMessageId": str(uuid.uuid4())}, status=201)
        for index in range(55):
            self.api(hubert, "POST", f"/api/v1/work/{task['id']}/agent-thread", {"body": f"Note {index + 1}: the lamp still flickers at the lowest setting.", "clientMessageId": str(uuid.uuid4())}, status=201)
        type(self).ids = {"workspace": ws["id"], "project": pid, "task": task["id"], "conversation": first["conversationId"], "first": first["id"]}

    def test_02_a_task_without_requests_shows_no_section(self) -> None:
        # The real server, no stub: a task nobody asked anything about has no cards, and the section does not appear.
        page = self.page("hubert")
        page.goto(self.thread_url())
        expect(page.get_by_role("region", name=THREAD)).to_be_visible()
        expect(page.get_by_role("region", name=REGION)).to_have_count(0)
        self.assertEqual(self.api(page, "GET", f"/api/v1/work/{self.ids['task']}/coordination", status=200)["requests"], [])

    def test_03_each_card_says_kind_who_target_and_state_in_plain_words(self) -> None:
        page, _ = self.cards("hubert", can_cancel=True)
        region = page.get_by_role("region", name=REGION)
        expect(region).to_be_visible()
        cards = region.get_by_role("listitem")
        # Open requests first, then the three latest closed ones; the rest wait behind "Show earlier requests".
        expect(cards).to_have_count(7)
        review = region.locator("[data-request-id$='000000000001']")
        expect(review).to_contain_text("Review")
        expect(review).to_contain_text("Codex for Hubert")
        expect(review).to_contain_text("Marek Claude for Marek")
        expect(review).to_contain_text(f"#12 {TASK} · version 3")
        expect(review).to_contain_text("Waiting for its next step")
        expect(region.locator("[data-request-id$='000000000002']")).to_contain_text("Put off until after its tests (busy)")
        expect(region.locator("[data-request-id$='000000000003']")).to_contain_text("Being handled")
        expect(region.locator("[data-request-id$='000000000003']")).to_contain_text("Hubert Claude for Hubert")
        expect(region.locator("[data-request-id$='000000000004']")).to_contain_text("Waiting: Marek Claude is offline")
        expect(region.locator("[data-request-id$='000000000005']")).to_contain_text("Answered")
        expect(region.locator("[data-request-id$='000000000005']")).to_contain_text("Passed · applies to the current version")
        stale = region.locator("[data-request-id$='000000000006']")
        expect(stale).to_contain_text("Changes requested · what it reviewed has changed since, so it no longer applies")
        expect(stale).to_contain_text("Task · version 2 (changed since)")
        expect(region.locator("[data-request-id$='000000000007']")).to_contain_text("Declined: it is outside its scope")
        # The earlier ones are folded, said once.
        expect(region.locator("[data-request-id$='000000000008']")).to_have_count(0)
        region.get_by_role("button", name="Show 3 earlier requests").click()
        expect(cards).to_have_count(10)
        expect(region.locator("[data-request-id$='000000000008']")).to_contain_text("Replaced by a newer request")
        expect(region.locator("[data-request-id$='000000000009']")).to_contain_text("Expired without an answer")
        expect(region.locator("[data-request-id$='000000000010']")).to_contain_text("Cancelled by Marek Lis")
        shot(page, "request-cards-1440")

    def test_04_open_original_message_reaches_a_message_older_than_the_page(self) -> None:
        page, _ = self.cards("hubert", can_cancel=True)
        message = page.locator(f"[data-message-id='{self.ids['first']}']")
        expect(message).to_have_count(0)
        page.get_by_role("region", name=REGION).locator("[data-request-id$='000000000001']").get_by_role("button", name="Open original message").click()
        expect(message).to_be_visible()
        expect(message).to_have_attribute("data-arrived", "true")
        expect(message).to_contain_text("Please compare the second reading with the baseline.")
        # The highlight is a soft fill that fades by itself (Spokój rule 6).
        expect(message).not_to_have_attribute("data-arrived", "true", timeout=5000)
        # A link into the thread with #message-… lands on the message too.
        page2, _ = self.cards("hubert", can_cancel=True, open_url=self.thread_url(f"#message-{self.ids['first']}"))
        expect(page2.locator(f"[data-message-id='{self.ids['first']}']")).to_be_visible()

    def test_05_the_packet_downloads_for_every_reader(self) -> None:
        for who in ("hubert", "vera"):
            page, stub = self.cards(who, can_cancel=who == "hubert")
            link = page.get_by_role("region", name=REGION).locator("[data-request-id$='000000000001']").get_by_role("link", name="Download packet")
            with page.expect_download() as download:
                link.click()
            self.assertEqual(download.value.suggested_filename, "flux-handoff-12-00000001.json")
            self.assertEqual(len(stub.packets), 1)
            self.assertRegex(stub.packets[0], rf"/api/v1/work/{self.ids['task']}/coordination/requests/00000000-0000-4000-8000-000000000001/packet$")

    def test_06_cancel_asks_first_and_acts_on_the_version_that_was_seen(self) -> None:
        page, stub = self.cards("hubert", can_cancel=True)
        card = page.get_by_role("region", name=REGION).locator("[data-request-id$='000000000001']")
        download = card.get_by_role("link", name="Download packet")
        before = download.bounding_box()
        card.get_by_role("button", name="Cancel request").click()
        group = card.get_by_role("group", name="Cancel this request?")
        expect(group).to_be_visible()
        self.assertEqual(stub.cancels, [], "asking changes nothing")
        # The controls before it do not move while it asks (Spokój rule 7).
        self.assertEqual(download.bounding_box(), before)
        group.get_by_role("button", name="Keep it").click()
        expect(group).to_have_count(0)
        expect(card.get_by_role("button", name="Cancel request")).to_be_visible()
        card.get_by_role("button", name="Cancel request").click()
        group.get_by_role("button", name="Yes, cancel it").click()
        expect(card).to_contain_text("Cancelled by Hubert Nowak")
        expect(card.get_by_role("button", name="Cancel request")).to_have_count(0)
        self.assertEqual(stub.cancels, [{"expectedVersion": 1}])
        self.assertEqual(download.bounding_box(), before, "nothing before it moved when the request closed")

    def test_07_a_refused_cancel_says_why_and_shows_the_request_as_it_is(self) -> None:
        page, stub = self.cards("hubert", can_cancel=True)
        card = page.get_by_role("region", name=REGION).locator("[data-request-id$='000000000002']")
        stub.refuse_cancel = (409, "COWORK_VERSION_CONFLICT")
        card.get_by_role("button", name="Cancel request").click()
        card.get_by_role("button", name="Yes, cancel it").click()
        expect(card.get_by_role("alert")).to_contain_text("changed a moment ago")
        expect(card).to_contain_text("Put off until after its tests (busy)")
        stub.refuse_cancel = (403, "COWORK_CANCEL_NOT_ALLOWED")
        card.get_by_role("button", name="Cancel request").click()
        card.get_by_role("button", name="Yes, cancel it").click()
        expect(card.get_by_role("alert")).to_contain_text("Only a project manager or the owner of either agent can cancel a request")
        self.assertEqual(len(stub.cancels), 2)

    def test_08_a_viewer_reads_the_cards_and_has_no_cancel(self) -> None:
        page, stub = self.cards("vera", can_cancel=False)
        region = page.get_by_role("region", name=REGION)
        expect(region.get_by_role("listitem")).to_have_count(7)
        expect(region.get_by_role("button", name="Cancel request")).to_have_count(0)
        expect(region.get_by_role("link", name="Download packet")).to_have_count(7)
        self.assertEqual(stub.cancels, [])
        # The task is Vera's to read, so the thread is too; she still cannot write to it.
        expect(page.get_by_label("Write to the agents")).to_be_disabled()

    def test_09_a_stranger_gets_nothing(self) -> None:
        stranger = self.page(None)
        stranger.goto("/sign-in")
        self.api(stranger, "GET", f"/api/v1/work/{self.ids['task']}/coordination", status=401)

    def test_10_phone_and_dark(self) -> None:
        phone, _ = self.cards("hubert", can_cancel=True, phone=True)
        region = phone.get_by_role("region", name=REGION)
        expect(region).to_be_visible()
        expect(region.get_by_role("listitem")).to_have_count(7)
        self.assertLessEqual(phone.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth"), 0, "no horizontal scroll at 390px")
        # Every control is a comfortable tap target on a phone.
        for control in region.locator("[data-request-id$='000000000001']").get_by_role("link").all() + region.locator("[data-request-id$='000000000001']").get_by_role("button").all():
            self.assertGreaterEqual(control.bounding_box()["height"], 44)
        shot(phone, "request-cards-phone-390")
        dark, _ = self.cards("hubert", can_cancel=True, dark=True)
        expect(dark.get_by_role("region", name=REGION)).to_be_visible()
        shot(dark, "request-cards-dark-1440")
        dark_phone, _ = self.cards("hubert", can_cancel=True, phone=True, dark=True)
        expect(dark_phone.get_by_role("region", name=REGION)).to_be_visible()
        shot(dark_phone, "request-cards-phone-dark-390")

    def test_11_a_manager_chooses_who_may_review_and_others_only_read_it(self) -> None:
        # The real server, no stub: the rule is stored and read back, and a plain contributor or viewer cannot change it.
        path = f"/api/v1/projects/{self.ids['project']}/review-policy"
        hubert = self.page("hubert")
        hubert.goto(f"/projects/{self.ids['project']}/agents")
        hubert.get_by_role("button", name=re.compile("^Project policy")).click()
        rule = hubert.get_by_role("region", name="Who may review")
        expect(rule).to_be_visible()
        expect(rule.get_by_role("radio", name=re.compile("^Another connection"))).to_be_checked()
        rule.get_by_role("radio", name=re.compile("^Another person’s agent")).check()
        expect(rule.get_by_role("status")).to_contain_text("Saved. It applies from the next review.")
        self.assertEqual(self.api(hubert, "GET", path, status=200)["reviewSeparation"], "distinct_owner")
        shot(hubert, "review-rule-1440")
        hubert.reload()
        hubert.get_by_role("button", name=re.compile("^Project policy")).click()
        expect(hubert.get_by_role("region", name="Who may review").get_by_role("radio", name=re.compile("^Another person’s agent"))).to_be_checked()
        # A viewer reads it in a sentence, with no choice to make; the server refuses her anyway.
        vera = self.page("vera")
        vera.goto(f"/projects/{self.ids['project']}/agents")
        vera.get_by_role("button", name=re.compile("^Project policy")).click()
        read = vera.get_by_role("region", name="Who may review")
        expect(read).to_contain_text("The reviewer must belong to someone other than the author’s owner.")
        expect(read.get_by_role("radio")).to_have_count(0)
        self.api(vera, "PUT", path, {"reviewSeparation": "distinct_connection"}, status=403)
        marek = self.page("marek")
        self.api(marek, "PUT", path, {"reviewSeparation": "distinct_connection"}, status=403)
        self.assertEqual(self.api(marek, "GET", path, status=200)["reviewSeparation"], "distinct_owner")
        # Put it back, so the rule is the default again.
        self.api(hubert, "PUT", path, {"reviewSeparation": "distinct_connection"}, status=200)
        phone = self.page("hubert", phone=True)
        phone.goto(f"/projects/{self.ids['project']}/agents")
        phone.get_by_role("button", name=re.compile("^Project policy")).click()
        expect(phone.get_by_role("region", name="Who may review")).to_be_visible()
        self.assertLessEqual(phone.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth"), 0)
        shot(phone, "review-rule-phone-390")


if __name__ == "__main__":
    unittest.main()
