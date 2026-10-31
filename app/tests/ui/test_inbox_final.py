"""Browser tests for the final Inbox (#342, F-026 S1, S9, S11, P4).

"Needs you" is the one queue: a decision the person can accept, a question to them, their blocked task
and a mention, across projects, with the filters All, Decisions, Questions, Blocked and Mentions. Done
(E), Not now (S, then 1, 2 or 3) and Accept (A) apply at once and offer Undo (Z); a decision cannot be
un-accepted, so Undo of Accept is a delayed command. The old Decisions view's links lead here. Ada's
view is checked at 1440x900 and 390x844 (touch), light and dark, against the API. Screenshots
(inbox-final-*.png) go to FLUX_UI_SCREENSHOTS when set.
"""

from __future__ import annotations

import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, box, shot, start_forwarder

PASSWORD = "a calm inbox for the garden"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ada": ("Ada Kowalska", f"ada.i+{STAMP}@example.test"),
    "jonas": ("Jonas Berg", f"jonas.i+{STAMP}@example.test"),
}
DECISION = "Measure soil moisture first; frost warnings later"
REASON = "Overwatering is the problem now; frost only matters in spring."


def mark(page: Page, name: str) -> None:
    """Records an event on the page, so a test waits for it with `seen` rather than a fixed sleep."""
    page.evaluate("(name) => { window.__marks[name] = (window.__marks[name] || 0) + 1; }", name)


def seen(page: Page, name: str, count: int = 1) -> None:
    """Waits until the page has recorded `name` at least `count` times. Routes keep being answered meanwhile."""
    page.wait_for_function("([name, count]) => (window.__marks[name] || 0) >= count", arg=[name, count])


def settled(page: Page) -> None:
    """Waits until no queue read is waiting for its answer, then until the page has painted what it changed."""
    page.wait_for_function("() => window.__needsYouPending === 0")
    page.evaluate("() => new Promise((done) => requestAnimationFrame(() => setTimeout(done, 0)))")


def open_card(card) -> None:
    """Opens a compact Inbox card (#763 LD-1): a click on its free space, beside the face."""
    if "nyc--compact" not in (card.get_attribute("class") or ""):
        return
    box = card.locator(".nyc__card").bounding_box()
    card.page.mouse.click(box["x"] + 10, box["y"] + box["height"] / 2)
    expect(card).to_have_class(re.compile(r"\bis-selected\b"))


class InboxFinal(unittest.TestCase):
    """Tests run in name order; each one leaves the queue as the next expects it."""

    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}
    workspace_id = ""
    project_id = ""
    task: dict = {}
    blocked: dict = {}
    decision: dict = {}
    contexts: dict[str, BrowserContext] = {}

    @classmethod
    def post(cls, who: str, path: str, body: dict | None = None) -> dict:
        response = cls.contexts[who].request.post(path, data=body or {}, headers={"origin": ORIGIN})
        assert response.status in (200, 201), f"{path}: {response.status} {response.text()}"
        return response.json()

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        assert cls.browser.browser_type.name == UI_BROWSER
        expect.set_options(timeout=15000)
        for key, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(base_url=ORIGIN, service_workers="block")
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.contexts[key] = context
        cls.workspace_id = cls.post("ada", "/api/v1/workspaces", {"name": "Riverside Makers"})["id"]
        cls.post("ada", f"/api/v1/workspaces/{cls.workspace_id}/members", {"email": PEOPLE["jonas"][1], "role": "member"})
        cls.project_id = cls.post("ada", f"/api/v1/workspaces/{cls.workspace_id}/projects", {"name": "Community garden sensors", "visibility": "workspace"})["id"]
        cls.task = cls.post("ada", f"/api/v1/projects/{cls.project_id}/work", {"title": "Calibrate the probes", "owner": {"kind": "human", "id": cls.ids["ada"]}})
        cls.blocked = cls.post("ada", f"/api/v1/projects/{cls.project_id}/work", {
            "title": "Design a weatherproof enclosure", "owner": {"kind": "human", "id": cls.ids["ada"]}, "status": "blocked", "blocker": "waiting for the probe dimensions"})
        cls.decision = cls.post("jonas", f"/api/v1/projects/{cls.project_id}/decisions", {"title": DECISION, "rationale": REASON, "affects": [cls.task["id"]]})
        for body in ("@Ada Kowalska can you check the shed roof?", "@Ada Kowalska thanks, the dashboard is live now."):
            cls.post("jonas", f"/api/v1/projects/{cls.project_id}/conversations", {"body": body, "clientMessageId": str(uuid.uuid4())})
        for key, context in cls.contexts.items():
            cls.states[key] = context.storage_state()
        # The worker writes the two notifications shortly after the events.
        for _ in range(80):
            if len(cls.queue(None)["items"]) >= 4:
                break
            time.sleep(0.25)

    @classmethod
    def tearDownClass(cls) -> None:
        for context in cls.contexts.values():
            context.close()
        cls.browser.close()
        cls.pw.stop()

    @classmethod
    def queue(cls, _page: Page | None) -> dict:
        response = cls.contexts["ada"].request.get("/api/v1/needs-you")
        assert response.status == 200, response.text()
        return response.json()

    def page(self, *, phone: bool = False, dark: bool = False) -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": "dark" if dark else "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw", "storage_state": self.states["ada"]}
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

    def kinds(self) -> list[str]:
        return [item["kind"] for item in self.queue(None)["items"]]

    def wait_for(self, check, what: str, seconds: float = 20):
        end = time.time() + seconds
        while time.time() < end:
            value = check()
            if value:
                return value
            time.sleep(0.25)
        raise AssertionError(f"timed out waiting for {what}")

    def decision_status(self) -> str:
        return self.contexts["ada"].request.get(f"/api/v1/decisions/{self.decision['id']}").json()["status"]

    def card(self, page: Page, title: str):
        return page.locator(".nyc", has_text=title)

    def watch_queue_reads(self, page: Page) -> None:
        """Counts the queue reads still waiting for an answer, and starts the page's event marks (see `mark`)."""
        page.evaluate(r"""() => {
          window.__marks = {};
          window.__needsYouPending = 0;
          const native = window.fetch;
          window.fetch = (input, init) => {
            const url = typeof input === 'string' ? input : input.url;
            if (!/\/api\/v1\/needs-you(\?|$)/.test(url)) return native(input, init);
            window.__needsYouPending += 1;
            const done = () => { window.__needsYouPending -= 1; };
            return native(input, init).then((response) => { response.clone().text().finally(done); return response; }, (error) => { done(); throw error; });
          };
        }""")

    def hold_reads_after_snooze(self, page: Page) -> dict:
        """Holds the queue reads that follow a snooze, and the Undo that follows (#519).

        The reads are requested after the server stores the snooze, and the page then Undoes it. Their
        answers are the queue from before Undo, so they arrive late, while the Undo is still on its way:
        `release()` delivers them then. Returns {"read": [(route, answer)], "undo": [route], "release": fn}.
        """
        self.watch_queue_reads(page)
        state = {"armed": False, "hold": False}
        held: dict = {"read": [], "undo": []}

        def on_item(route) -> None:
            if route.request.method == "DELETE" and state["hold"] and not held["undo"]:
                held["undo"].append(route)
                mark(page, "undo")
                return
            if route.request.method != "POST":
                route.continue_()
                return
            # The snooze is stored before the page hears of it; reads from now on are the late ones.
            response = route.fetch()
            if not state["armed"]:
                state["armed"] = state["hold"] = True
            route.fulfill(response=response)

        def on_queue(route) -> None:
            if state["hold"]:
                held["read"].append((route, route.fetch()))
                mark(page, "heldRead")
            else:
                route.continue_()

        def release() -> None:
            state["hold"] = False
            for route, answer in held["read"]:
                route.fulfill(response=answer)

        def let_undo_through() -> None:
            # A check that failed first must not leave the Undo held for the tests after it.
            while held["undo"]:
                held["undo"].pop().continue_()

        self.addCleanup(let_undo_through)
        page.route(re.compile(r"/api/v1/needs-you/[^?]+$"), on_item)
        page.route(re.compile(r"/api/v1/needs-you(\?.*)?$"), on_queue)
        return {**held, "release": release}

    def hold_snooze_in_flight(self, page: Page) -> dict:
        """Holds a snooze's answer and Undo's DELETE, and lets the queue reads be answered by the server (#519).

        The server stores the snooze before its answer is released, so the page hears of the snooze only at
        `release_answer()`, when Undo is already in flight. The DELETE waits until `release_delete()`. Every queue
        read is answered by the server as it is (still snoozed, while the DELETE waits); each answer is appended
        to `served`, and the read is marked on the page once the page has it.
        """
        self.watch_queue_reads(page)
        held: dict = {"answer": None, "delete": None, "served": []}

        def on_item(route) -> None:
            if route.request.method == "POST":
                held["answer"] = (route, route.fetch())
                mark(page, "snooze")
            elif route.request.method == "DELETE":
                held["delete"] = route
                mark(page, "undo")
            else:
                route.continue_()

        def on_queue(route) -> None:
            response = route.fetch()
            held["served"].append(response.json())
            route.fulfill(response=response)
            mark(page, "reads")

        def release_answer() -> None:
            if held["answer"] is not None:
                route, answer = held["answer"]
                held["answer"] = None
                route.fulfill(response=answer)

        def release_delete() -> None:
            if held["delete"] is not None:
                route, held["delete"] = held["delete"], None
                route.continue_()

        # A check that fails first must not leave the snooze or the Undo held for the tests after it.
        self.addCleanup(release_answer)
        self.addCleanup(release_delete)
        page.route(re.compile(r"/api/v1/needs-you/[^?]+$"), on_item)
        page.route(re.compile(r"/api/v1/needs-you(\?.*)?$"), on_queue)
        return {"served": held["served"], "release_answer": release_answer, "release_delete": release_delete}

    def watch_card(self, page: Page, title: str):
        """Watches a card from now on: it may come and go, but once it has appeared it must never leave (#519).

        Returns a reader of the watch, {"appeared": bool, "vanished": bool}.
        """
        page.evaluate("""(title) => {
          const shown = () => [...document.querySelectorAll('.nyc')].some((card) => card.textContent.includes(title));
          const watch = { appeared: shown(), vanished: false };
          new MutationObserver(() => {
            if (shown()) watch.appeared = true;
            else if (watch.appeared) watch.vanished = true;
          }).observe(document.body, { childList: true, subtree: true, characterData: true });
          window.__cardWatch = watch;
        }""", title)
        return lambda: page.evaluate("() => window.__cardWatch")

    # ---------------------------------------------------------------- the queue (AC-1, AC-3)

    def test_01_one_queue_with_filters_and_the_decision_card(self) -> None:
        self.assertEqual(self.kinds(), ["decision", "question", "blocked", "mention"])
        page = self.page()
        page.goto("/inbox")
        expect(page.get_by_role("heading", level=1, name="Inbox")).to_be_visible()
        tabs = page.get_by_role("tablist", name="Show")
        for name in (r"^All\W+4$", r"^Decisions\W+1$", r"^Questions\W+1$", r"^Blocked\W+1$", r"^Mentions\W+1$"):
            expect(tabs.get_by_role("tab", name=re.compile(name))).to_be_visible()
        expect(page.get_by_text("4 need you · all projects")).to_be_visible()
        cards = page.locator(".nyc")
        expect(cards).to_have_count(4)
        expect(cards.nth(0)).to_have_attribute("aria-current", "true")

        # P4: one card for a decision. Its kind, why it needs you, the reason, what it rests on, then the actions.
        decision = self.card(page, DECISION)
        expect(decision).to_contain_text("Jonas Berg")
        expect(decision).to_contain_text("Proposed decision")
        expect(decision).to_contain_text("Community garden sensors")
        expect(decision.locator(".nyc__chip")).to_have_text("Needs you")
        expect(decision.get_by_text(REASON)).to_be_visible()
        expect(decision.get_by_role("button", name=re.compile("^Accept"))).to_be_visible()
        expect(decision.get_by_role("button", name="Not now")).to_be_visible()
        expect(decision.get_by_role("button", name="Discuss")).to_be_visible()
        # One person accepts (O-009): the card says who still can, not who "already accepted".
        expect(decision.locator(".nyc__waiting")).to_contain_text("waiting for you")
        expect(decision.locator(".nyc__waiting")).to_contain_text("Jonas Berg can accept too")
        expect(self.card(page, "asked you")).to_contain_text("Question")
        expect(self.card(page, "is blocked")).to_contain_text("waiting for the probe dimensions")
        expect(self.card(page, "mentioned you")).to_be_visible()
        # The count in the sidebar is the number of things that need you.
        expect(page.get_by_role("navigation", name="Places").get_by_role("link", name="Inbox, 4 new").locator(".side__count")).to_have_text("4")
        page.mouse.move(1000, 880)
        shot(page, "inbox-final-desktop-1440")

        # Each filter shows its kind; none of it is hidden by the others.
        tabs.get_by_role("tab", name=re.compile(r"^Decisions\W+1$")).click()
        expect(cards).to_have_count(1)
        expect(cards.first).to_contain_text(DECISION)
        tabs.get_by_role("tab", name=re.compile(r"^Blocked\W+1$")).click()
        expect(cards).to_have_count(1)
        expect(cards.first).to_contain_text("is blocked")
        tabs.get_by_role("tab", name=re.compile(r"^All\W+4$")).click()
        expect(cards).to_have_count(4)

    def test_02_an_item_opens_in_the_detail_panel(self) -> None:
        page = self.page()
        page.goto("/inbox")
        self.card(page, DECISION).get_by_role("button", name=DECISION).click()
        details = page.locator("#details")
        expect(details).to_contain_text(DECISION)
        page.keyboard.press("Escape")
        # A blocked task opens as the task; a question opens its message.
        self.card(page, "is blocked").get_by_role("button", name="Open task").click()
        expect(page.locator("#details")).to_contain_text("Design a weatherproof enclosure")
        page.keyboard.press("Escape")
        self.card(page, "asked you").get_by_role("button", name="Reply").click()
        expect(page).to_have_url(re.compile(rf"/projects/{self.project_id}/conversations/"))

    # ---------------------------------------------------------------- Done, Not now and Undo (AC-2)

    def test_03_done_with_undo_by_keyboard(self) -> None:
        page = self.page()
        page.goto("/inbox")
        cards = page.locator(".nyc")
        expect(cards).to_have_count(4)
        page.keyboard.press("j")
        expect(cards.nth(1)).to_have_attribute("aria-current", "true")
        page.keyboard.press("k")
        expect(cards.nth(0)).to_have_attribute("aria-current", "true")
        for _ in range(3):
            page.keyboard.press("j")
        mention = self.card(page, "mentioned you")
        expect(mention).to_have_attribute("aria-current", "true")
        page.keyboard.press("e")
        toast = page.get_by_role("status").filter(has_text="Marked done")
        expect(toast).to_be_visible()
        expect(cards).to_have_count(3)
        self.wait_for(lambda: self.kinds() == ["decision", "question", "blocked"], "Done to be stored")
        page.keyboard.press("z")
        expect(cards).to_have_count(4)
        # An answered toast offers no Undo while it leaves, so the next toast's Undo is the only one (#393 review).
        expect(page.get_by_role("button", name="Undo")).to_have_count(0)
        self.wait_for(lambda: self.kinds() == ["decision", "question", "blocked", "mention"], "Undo to restore it for good")
        # The Undo button does the same as Z.
        page.keyboard.press("e")
        page.get_by_role("button", name="Undo").click()
        expect(cards).to_have_count(4)
        self.wait_for(lambda: self.kinds() == ["decision", "question", "blocked", "mention"], "the restored queue")

    def test_04_not_now_asks_when_it_returns(self) -> None:
        page = self.page()
        page.goto("/inbox")
        decision = self.card(page, DECISION)
        decision.get_by_role("button", name="Not now").click()
        menu = page.get_by_role("menu", name="Ask me again")
        expect(menu.get_by_role("menuitem")).to_have_text([re.compile("^Tomorrow morning"), re.compile("^Next week"), re.compile("^When #1 is done"), re.compile("^Decline for good")])
        # Three: when the task it affects is done. The reads that follow the snooze are answered only after Undo.
        held = self.hold_reads_after_snooze(page)
        page.keyboard.press("3")
        expect(page.get_by_role("status").filter(has_text="Back when #1 is done")).to_be_visible()
        expect(decision).to_have_count(0)
        seen(page, "heldRead")
        self.wait_for(lambda: (self.queue(None)["count"], self.queue(None)["later"]) == (3, 1), "the snooze to be stored")
        # Watches the decision card from now on: it may appear, but once it is back it must never leave.
        watch = self.watch_card(page, DECISION)
        page.keyboard.press("z")
        expect(decision).to_have_count(1)
        seen(page, "undo")
        # The late answers land while the Undo is still on its way, then the Undo is let through.
        held["release"]()
        settled(page)
        self.assertEqual(watch(), {"appeared": True, "vanished": False}, "the restored decision never left the Inbox")
        held["undo"].pop().continue_()
        self.wait_for(lambda: self.queue(None)["later"] == 0, "the snooze to be undone")
        expect(decision).to_have_count(1)

        # The restored first card is current again. Move to its neighbour and back before using S;
        # this proves the keyboard handler sees the restored queue, not its previous item list.
        expect(decision).to_have_attribute("aria-current", "true")
        question = self.card(page, "asked you")
        page.keyboard.press("j")
        expect(question).to_have_attribute("aria-current", "true")
        page.keyboard.press("k")
        expect(decision).to_have_attribute("aria-current", "true")
        # S opens the menu for the selected card; one is tomorrow morning, and Undo returns it.
        page.keyboard.press("s")
        expect(page.get_by_role("menu", name="Ask me again")).to_be_visible()
        page.keyboard.press("1")
        expect(page.get_by_role("status").filter(has_text="Back tomorrow morning")).to_be_visible()
        expect(decision).to_have_count(0)
        self.wait_for(lambda: self.queue(None)["later"] == 1, "the second snooze to be stored")
        # It stays out of the queue after a reload, until the time comes.
        page.reload()
        expect(page.locator(".nyc")).to_have_count(3)
        expect(page.get_by_text("3 need you · all projects · 1 for later")).to_be_visible()
        self.contexts["ada"].request.delete(f"/api/v1/needs-you/{requests_quote('decision:' + self.decision['id'])}", headers={"origin": ORIGIN})
        self.wait_for(lambda: self.queue(None)["later"] == 0, "the snooze to be undone")
        page.reload()
        expect(page.locator(".nyc")).to_have_count(4)

        # Escape closes the menu without choosing.
        decision = self.card(page, DECISION)
        decision.get_by_role("button", name="Not now").click()
        expect(page.get_by_role("menu", name="Ask me again")).to_be_visible()
        page.keyboard.press("Escape")
        expect(page.get_by_role("menu", name="Ask me again")).to_have_count(0)
        expect(decision).to_have_count(1)

    def test_04b_undo_before_the_snooze_is_answered_keeps_the_card(self) -> None:
        """Undo while the snooze's answer is still on its way (#519, the window after Undo).

        The page hears of the snooze only after Undo has restored the card. The read that starts then is answered
        by a server that still holds the snooze, because Undo's DELETE waits. The card, and the keyboard selection
        on it, must stay as they are until Undo has reached the server.
        """
        page = self.page()
        page.goto("/inbox")
        decision = self.card(page, DECISION)
        expect(decision).to_have_count(1)
        gate = self.hold_snooze_in_flight(page)
        decision.get_by_role("button", name="Not now").click()
        page.get_by_role("menuitem", name=re.compile("^Tomorrow morning")).click()
        expect(decision).to_have_count(0)
        seen(page, "snooze")
        page.keyboard.press("z")
        expect(decision).to_have_attribute("aria-current", "true")
        watch = self.watch_card(page, DECISION)
        reads = len(gate["served"])
        gate["release_answer"]()
        seen(page, "reads", reads + 1)
        settled(page)
        self.assertNotIn(f"decision:{self.decision['id']}", [item["key"] for item in gate["served"][-1]["items"]], "the server still holds the snooze while Undo waits")
        self.assertEqual(watch(), {"appeared": True, "vanished": False}, "the restored decision never left the Inbox after the read that started after Undo")
        expect(decision).to_have_attribute("aria-current", "true")
        # Selection while Undo waits: down to the neighbour and back lands on the restored decision.
        page.keyboard.press("j")
        expect(self.card(page, "asked you")).to_have_attribute("aria-current", "true")
        page.keyboard.press("k")
        expect(decision).to_have_attribute("aria-current", "true")
        expect(page.locator('.nyc[aria-current="true"]')).to_have_count(1)
        # Undo reaches the server; the read after it finds the decision back, and it stays current.
        reads = len(gate["served"])
        with page.expect_response(lambda response: response.request.method == "DELETE" and "/api/v1/needs-you/" in response.url) as undone:
            gate["release_delete"]()
        self.assertTrue(undone.value.ok, "the server must acknowledge Undo")
        seen(page, "reads", reads + 1)
        settled(page)
        self.assertEqual(watch(), {"appeared": True, "vanished": False}, "the restored decision never left the Inbox after Undo")
        expect(decision).to_have_count(1)
        expect(decision).to_have_attribute("aria-current", "true")
        self.assertEqual(self.queue(None)["later"], 0, "the snooze is undone on the server")

    def test_04c_unrelated_updates_arrive_while_a_write_is_unanswered(self) -> None:
        """A pending Not now protects only its item, even when the write eventually fails (#541)."""
        page = self.page()
        page.goto("/inbox")
        original = self.card(page, DECISION)
        expect(original).to_have_count(1)
        self.watch_queue_reads(page)
        held = {"write": None, "new": None}

        def on_item(route):
            if route.request.method == "POST":
                held["write"] = route
                mark(page, "writeHeld")
            else:
                route.continue_()

        def on_queue(route):
            answer = route.fetch()
            payload = answer.json()
            route.fulfill(response=answer)
            if held["new"] and any(item["key"] == f"decision:{held['new']['id']}" for item in payload["items"]):
                self.assertTrue(answer.ok)
                mark(page, "newRead")

        def release():
            if held["write"]:
                route, held["write"] = held["write"], None
                route.fulfill(status=503, json={"message": "Controlled unavailable write"})

        self.addCleanup(release)
        page.route(re.compile(r"/api/v1/needs-you/[^?]+$"), on_item)
        page.route(re.compile(r"/api/v1/needs-you(\?.*)?$"), on_queue)
        original.get_by_role("button", name="Not now").click()
        page.get_by_role("menuitem", name=re.compile("^Tomorrow morning")).click()
        seen(page, "writeHeld")
        expect(original).to_have_count(0)
        held["new"] = self.post("jonas", f"/api/v1/projects/{self.project_id}/decisions", {"title": "Protect the greenhouse controller", "rationale": "Keep it dry."})
        key = requests_quote(f"decision:{held['new']['id']}")
        self.addCleanup(lambda: self.post("ada", f"/api/v1/needs-you/{key}", {"action": "done"}))
        page.evaluate("() => window.dispatchEvent(new Event('focus'))")
        seen(page, "newRead")
        settled(page)
        self.assertIsNotNone(held["write"], "the write remains unanswered during the successful read")
        expect(original).to_have_count(0)
        expect(self.card(page, "Protect the greenhouse controller")).to_have_count(1)
        release()
        expect(original).to_have_count(1)
        expect(self.card(page, "Protect the greenhouse controller")).to_have_count(1)
        expect(page.get_by_role("status").filter(has_text="Controlled unavailable write")).to_be_visible()

    def test_04d_an_older_failure_cannot_reverse_a_newer_choice(self) -> None:
        page = self.page()
        page.goto("/inbox")
        original = self.card(page, DECISION)
        expect(original).to_have_count(1)
        self.watch_queue_reads(page)
        held = []

        def on_item(route):
            if route.request.method == "POST":
                held.append(route)
                mark(page, "writeHeld")
            else:
                route.continue_()

        def release():
            while held:
                held.pop().abort()

        self.addCleanup(release)
        page.route(re.compile(r"/api/v1/needs-you/[^?]+$"), on_item)
        original.get_by_role("button", name="Not now").click()
        page.get_by_role("menuitem", name=re.compile("^Tomorrow morning")).click()
        seen(page, "writeHeld")
        page.keyboard.press("z")
        expect(original).to_have_attribute("aria-current", "true")
        page.keyboard.press("e")
        seen(page, "writeHeld", 2)
        expect(original).to_have_count(0)
        older = held.pop(0)
        with page.expect_response(lambda response: response.status == 503 and response.request.method == "POST"):
            older.fulfill(status=503, json={"message": "Earlier snooze failed"})
        page.evaluate("() => window.dispatchEvent(new Event('focus'))")
        settled(page)
        expect(original).to_have_count(0)
        expect(page.get_by_role("status").filter(has_text="Marked done")).to_be_visible()
        with page.expect_response(lambda response: response.ok and response.request.method == "POST" and "/api/v1/needs-you/" in response.url):
            held.pop().continue_()
        self.assertNotIn(f"decision:{self.decision['id']}", [item["key"] for item in self.queue(None)["items"]])
        page.keyboard.press("z")
        expect(original).to_have_count(1)
        self.wait_for(lambda: any(item["key"] == f"decision:{self.decision['id']}" for item in self.queue(None)["items"]), "the latest Done to be undone")

    def test_05_the_task_snooze_ends_when_the_task_is_done(self) -> None:
        page = self.page()
        page.goto("/inbox")
        decision = self.card(page, DECISION)
        decision.get_by_role("button", name="Not now").click()
        page.get_by_role("menuitem", name=re.compile("^When #1 is done")).click()
        expect(decision).to_have_count(0)
        task = self.contexts["ada"].request.get(f"/api/v1/work/{self.task['id']}").json()
        self.contexts["ada"].request.patch(f"/api/v1/work/{self.task['id']}", data={"status": "done", "expectedVersion": task["version"]}, headers={"origin": ORIGIN})
        self.wait_for(lambda: "decision" in self.kinds(), "the decision to return when its task is done")
        page.reload()
        expect(self.card(page, DECISION)).to_have_count(1)

    # ---------------------------------------------------------------- Accept with Undo (AC-2, DA-3)

    def test_06_accept_is_delayed_so_undo_is_real(self) -> None:
        page = self.page()
        page.goto("/inbox")
        decision = self.card(page, DECISION)
        decision.get_by_role("button", name=re.compile("^Accept")).click()
        toast = page.get_by_role("status").filter(has_text="Accepted")
        expect(toast).to_be_visible()
        expect(decision).to_have_count(0)
        self.assertEqual(self.decision_status(), "proposed", "nothing was sent while Undo is offered")
        page.keyboard.press("z")
        expect(decision).to_have_count(1)
        time.sleep(7)
        self.assertEqual(self.decision_status(), "proposed", "an undone accept is never sent")

        # A: accepted at once on the screen, and sent when the window ends.
        page.keyboard.press("a")
        expect(decision).to_have_count(0)
        self.wait_for(lambda: self.decision_status() == "accepted", "the accept to be sent")
        expect(page.get_by_role("status").filter(has_text="Accepted")).to_have_count(0)
        accepted = self.contexts["ada"].request.get(f"/api/v1/decisions/{self.decision['id']}").json()
        self.assertEqual(accepted["decidedBy"]["id"], self.ids["ada"])
        self.assertNotIn("decision", self.kinds())

    def test_07_leaving_sends_the_accept(self) -> None:
        proposed = self.post("jonas", f"/api/v1/projects/{self.project_id}/decisions", {"title": "Label every bed with a QR code", "rationale": "Volunteers scan, not guess."})
        self.wait_for(lambda: "decision" in self.kinds(), "the new decision")
        page = self.page()
        page.goto("/inbox")
        page.locator(".nyc", has_text="Label every bed").get_by_role("button", name=re.compile("^Accept")).click()
        # Going to Home inside the app sends it at once, with Undo still on screen.
        page.get_by_role("navigation", name="Places").get_by_role("link", name="Home").click()
        self.wait_for(lambda: self.contexts["ada"].request.get(f"/api/v1/decisions/{proposed['id']}").json()["status"] == "accepted", "the accept sent on leaving")
        page.get_by_role("button", name="Undo").click()
        expect(page.get_by_role("status").filter(has_text="already accepted")).to_be_visible()

    def test_07a_another_persons_item_shows_during_an_accept_window(self) -> None:
        """An accept is not pending: while its Undo window is open, a new item from someone else shows at once (#519).

        The page starts the read itself (focus), so the item must appear while the "Accepted" toast is still up.
        It does not wait for the window to end, which a pending accept would make it do.
        """
        proposed = self.post("jonas", f"/api/v1/projects/{self.project_id}/decisions", {"title": "Sow the clover by the gate", "rationale": "It fixes nitrogen."})
        page = self.page()
        page.goto("/inbox")
        card = self.card(page, "Sow the clover")
        expect(card).to_have_count(1)
        # Control the product's real Undo clock, independently of machine speed or toast hover.
        page.clock.install(time=time.time())
        page.clock.pause_at(time.time() + 1)
        card.get_by_role("button", name=re.compile("^Accept")).click()
        toast = page.get_by_role("status").filter(has_text="Accepted")
        expect(toast).to_be_visible()
        self.post("jonas", f"/api/v1/projects/{self.project_id}/decisions", {"title": "Mulch the paths before the frost", "rationale": "Less mud in March."})
        page.evaluate("() => window.dispatchEvent(new Event('focus'))")
        expect(self.card(page, "Mulch the paths")).to_have_count(1)
        expect(card).to_have_count(0)
        self.assertEqual(self.contexts["ada"].request.get(f"/api/v1/decisions/{proposed['id']}").json()["status"], "proposed", "the incoming item appears before Accept is sent")
        page.mouse.move(0, 0)
        page.clock.run_for(6001)
        self.wait_for(lambda: self.contexts["ada"].request.get(f"/api/v1/decisions/{proposed['id']}").json()["status"] == "accepted", "the accept to be sent")
        expect(toast).to_have_count(0)

    def test_07b_accept_success_never_reveals_the_cached_proposal(self) -> None:
        self.accept_success_preserves_hidden_proposal(home=False)

    def test_07c_accept_success_never_reveals_the_home_cached_proposal(self) -> None:
        self.accept_success_preserves_hidden_proposal(home=True)

    def accept_success_preserves_hidden_proposal(self, *, home: bool) -> None:
        """A read during Accept caches the proposal; success must hide it before a fresh read (#541)."""
        proposed = self.post("jonas", f"/api/v1/projects/{self.project_id}/decisions", {"title": "Cover the rain gauge", "rationale": "Keep leaves out."})
        page = self.page()
        page.goto("/inbox")
        card = self.card(page, "Cover the rain gauge")
        expect(card).to_have_count(1)
        self.watch_queue_reads(page)
        page.clock.install(time=time.time())
        page.clock.pause_at(time.time() + 1)
        card.get_by_role("button", name=re.compile("^Accept")).click()
        held = []
        state = {"hold": False}
        accepted = []
        if home:
            def on_accept(route):
                accepted.append(route)
                mark(page, "acceptHeld")
            page.route(re.compile(r"/api/v1/decisions/[^/]+/accept$"), on_accept)
            page.get_by_role("navigation", name="Places").get_by_role("link", name="Home").click()
            seen(page, "acceptHeld")
            self.addCleanup(lambda: [route.abort() for route in accepted])

        def on_queue(route):
            answer = route.fetch()
            if state["hold"]:
                held.append((route, answer))
                mark(page, "heldRead")
            else:
                self.assertIn(f"decision:{proposed['id']}", [item["key"] for item in answer.json()["items"]])
                route.fulfill(response=answer)
                mark(page, "cachedRead")

        def release():
            state["hold"] = False
            while held:
                route, answer = held.pop()
                route.fulfill(response=answer)

        self.addCleanup(release)
        page.route(re.compile(r"/api/v1/needs-you(\?.*)?$"), on_queue)
        page.evaluate("() => window.dispatchEvent(new Event('focus'))")
        seen(page, "cachedRead")
        page.wait_for_function("() => window.__needsYouPending === 0")
        page.clock.run_for(1)
        expect(card).to_have_count(0)
        page.evaluate("""() => {
          window.__reappeared = false;
          new MutationObserver(() => {
            if ([...document.querySelectorAll('.nyc')].some(card => card.textContent.includes('Cover the rain gauge'))) window.__reappeared = true;
          }).observe(document.body, { childList: true, subtree: true, characterData: true });
        }""")
        state["hold"] = True
        # Home navigation sends Accept; otherwise a real page-leave event sends it without advancing Undo.
        if home:
            accepted.pop().continue_()
        else:
            # The page is shown again at once (a restore from the back-forward cache): while it is left the web client
            # starts no request (api/pageLeaving, #471), so the fresh queue read that follows Accept waits for this.
            page.evaluate("() => { window.dispatchEvent(new Event('pagehide')); window.dispatchEvent(new Event('pageshow')); }")
        seen(page, "heldRead")
        page.clock.run_for(1)
        self.assertEqual(self.contexts["ada"].request.get(f"/api/v1/decisions/{proposed['id']}").json()["status"], "accepted")
        expect(card).to_have_count(0)
        self.assertFalse(page.evaluate("() => window.__reappeared"), "the cached proposal never reappears after success")
        release()
        page.clock.run_for(1)
        expect(card).to_have_count(0)

    # ---------------------------------------------------------------- blocked tasks and mentions

    def test_08_unblock_with_undo(self) -> None:
        page = self.page()
        page.goto("/inbox")
        card = self.card(page, "is blocked")
        open_card(card)  # #763 LD-1: only the selected item shows all its actions
        card.get_by_role("button", name="Unblock").click()
        expect(page.get_by_role("status").filter(has_text="Blocker cleared")).to_be_visible()
        expect(card).to_have_count(0)
        work = lambda: self.contexts["ada"].request.get(f"/api/v1/work/{self.blocked['id']}").json()  # noqa: E731
        self.wait_for(lambda: work()["status"] == "in_progress", "the task to be unblocked")
        page.keyboard.press("z")
        expect(self.card(page, "is blocked")).to_have_count(1)
        self.wait_for(lambda: work()["status"] == "blocked", "Undo to block it again")
        self.assertEqual(work()["blocker"], "waiting for the probe dimensions")

    def test_09_done_on_a_question_reads_it_and_nothing_is_lost(self) -> None:
        page = self.page()
        page.goto("/inbox")
        question = self.card(page, "asked you")
        open_card(question)  # #763 LD-1
        question.get_by_role("button", name="Done").click()
        expect(question).to_have_count(0)
        def asked():
            inbox = self.contexts["ada"].request.get("/api/v1/inbox?limit=100").json()["items"]
            return [item for item in inbox if "asked you" in item["title"]]
        self.assertEqual(len(asked()), 1, "the notification is still there")
        self.wait_for(lambda: asked()[0]["readAt"], "Done to read the notification")
        page.keyboard.press("z")
        expect(self.card(page, "asked you")).to_have_count(1)

    def test_10_old_decision_links_lead_here(self) -> None:
        proposed = self.post("jonas", f"/api/v1/projects/{self.project_id}/decisions", {"title": "Keep the old rule for the shed", "rationale": "It works."})
        self.wait_for(lambda: "decision" in self.kinds(), "a decision to wait")
        page = self.page()
        for query in ("status=needs", "status=rules"):
            page.goto(f"/projects/{self.project_id}/tasks?{query}")
            expect(page).to_have_url(re.compile(r"/inbox\?show=decisions$"))
            expect(page.get_by_role("tab", name=re.compile("^Decisions"))).to_have_attribute("aria-selected", "true")
            expect(page.locator(".nyc", has_text="Keep the old rule")).to_be_visible()
        # A decision's own link still opens the decision, with its history in its details.
        page.goto(f"/projects/{self.project_id}/tasks?open=decision:{proposed['id']}")
        expect(page.locator("#details")).to_contain_text("Keep the old rule for the shed")
        # The Tasks tab no longer has a Decisions view or archive; it points here instead.
        page.goto(f"/projects/{self.project_id}/tasks")
        expect(page.get_by_role("button", name="Decisions & results")).to_have_count(0)
        expect(page.get_by_role("link", name=re.compile("decisions? needs? you in the Inbox"))).to_be_visible()
        page.get_by_role("link", name=re.compile("decisions? needs? you in the Inbox")).click()
        expect(page).to_have_url(re.compile(r"/inbox\?show=decisions$"))

    def test_11_all_clear_and_an_empty_filter(self) -> None:
        for item in self.queue(None)["items"]:
            response = self.contexts["ada"].request.post(f"/api/v1/needs-you/{requests_quote(item['key'])}", data={"action": "done"}, headers={"origin": ORIGIN})
            self.assertEqual(response.status, 200, response.text())
        page = self.page()
        page.goto("/inbox")
        expect(page.get_by_role("heading", name="Nothing needs you right now")).to_be_visible()
        expect(page.get_by_text("Enjoy the quiet.")).to_be_visible()
        expect(page.get_by_text(re.compile(r"^\d+ done today$"))).to_be_visible()
        # #437 / E06: an empty Inbox is Kreska, one sentence and the settings link; the filters wait for something to filter.
        expect(page.get_by_role("tab")).to_have_count(0)
        expect(page.get_by_text("all clear · all projects")).to_have_count(0)
        expect(page.get_by_role("link", name="Notification settings").last).to_be_visible()
        expect(page.get_by_role("navigation", name="Places").get_by_role("link", name="Inbox", exact=True).locator(".side__count")).to_have_count(0)
        page.goto("/inbox?show=questions")
        expect(page.get_by_role("heading", name="No questions wait for you")).to_be_visible()
        shot(page, "inbox-final-desktop-1440-clear")
        self.assertEqual(self.queue(None)["count"], 0)

    def test_11b_empty_inbox_with_a_snoozed_item_keeps_the_later_count(self) -> None:
        """#437: hiding the empty Inbox's summary must not hide "N for later", the way back to snoozed items."""
        snoozed = self.post("jonas", f"/api/v1/projects/{self.project_id}/decisions", {"title": "Paint the shed green", "rationale": "It hides in the garden."})
        self.wait_for(lambda: self.queue(None)["count"] == 1, "the new decision")
        page = self.page()
        page.goto("/inbox")
        self.card(page, "Paint the shed green").get_by_role("button", name="Not now").click()
        page.keyboard.press("1")
        expect(page.get_by_role("status").filter(has_text="Back tomorrow morning")).to_be_visible()
        self.wait_for(lambda: self.queue(None)["later"] == 1, "the snooze to be stored")
        page.reload()
        expect(page.get_by_role("heading", name="Nothing needs you right now")).to_be_visible()
        expect(page.get_by_text("all clear · all projects · 1 for later")).to_be_visible()
        self.contexts["ada"].request.delete(f"/api/v1/needs-you/{requests_quote('decision:' + snoozed['id'])}", headers={"origin": ORIGIN})
        self.wait_for(lambda: self.queue(None)["later"] == 0, "the snooze to be undone")
        page.reload()
        expect(self.card(page, "Paint the shed green")).to_have_count(1)
        self.contexts["ada"].request.post(f"/api/v1/needs-you/{requests_quote('decision:' + snoozed['id'])}", data={"action": "done"}, headers={"origin": ORIGIN})

    # ---------------------------------------------------------------- phone and dark

    def test_12_phone_inbox_cards_and_swipe_tray(self) -> None:
        proposed = self.post("jonas", f"/api/v1/projects/{self.project_id}/decisions", {"title": "Mulch the north beds", "rationale": "Keeps the soil damp."})
        self.post("jonas", f"/api/v1/projects/{self.project_id}/conversations", {"body": "@Ada Kowalska is the gate code still 1234?", "clientMessageId": str(uuid.uuid4())})
        self.wait_for(lambda: {"decision", "question"} <= set(self.kinds()), "new things that need her")
        page = self.page(phone=True)
        page.goto("/inbox")
        cards = page.locator(".nyc")
        expect(cards).to_have_count(2)
        self.assertLessEqual(page.evaluate("document.scrollingElement.scrollWidth"), PHONE["width"], "no sideways scroll")
        decision = self.card(page, "Mulch the north beds")
        for name in (re.compile("^Accept"), "Not now"):
            self.assertGreaterEqual(box(page, decision.get_by_role("button", name=name))["height"], 44)
        expect(decision.get_by_role("button", name="Discuss")).to_be_visible()
        # The title opens the item in the detail sheet, so it is a touch target too.
        self.assertGreaterEqual(box(page, decision.locator(".nyc__open"))["height"], 44)
        # #437: the tab labels meet the 12.5px phone meta minimum and the unread dot clears the Inbox icon.
        self.assertGreaterEqual(page.evaluate("Math.min(...[...document.querySelectorAll('.ui-bottomnav__label')].map((e) => parseFloat(getComputedStyle(e).fontSize)))"), 12.5)
        clear = page.evaluate("""() => { const dot = document.querySelector('.ui-bottomnav__dot'); const icon = dot.parentElement.querySelector('svg');
          const d = dot.getBoundingClientRect(), i = icon.getBoundingClientRect(); return d.left >= i.right - 1 || d.bottom <= i.top + 1; }""")
        self.assertTrue(clear, "the unread dot does not cover the icon")
        shot(page, "inbox-final-phone-390")
        # A swipe left reveals Not now and Done; Done applies at once and offers Undo.
        question = self.card(page, "asked you")
        question.locator(".nyc__scroll").evaluate("element => element.scrollTo({ left: element.scrollWidth, behavior: 'instant' })")
        tray = question.locator(".nyc__tray")
        self.assertGreaterEqual(box(page, tray.get_by_role("button", name="Done"))["height"], 44)
        shot(page, "inbox-final-phone-390-swipe")
        tray.get_by_role("button", name="Done").tap()
        expect(page.get_by_role("status").filter(has_text="Marked done")).to_be_visible()
        expect(question).to_have_count(0)
        page.get_by_role("button", name="Undo").tap()
        expect(self.card(page, "asked you")).to_have_count(1)
        # Not now in the tray asks when, in a menu that fits the screen.
        question = self.card(page, "asked you")
        question.locator(".nyc__scroll").evaluate("element => element.scrollTo({ left: element.scrollWidth, behavior: 'instant' })")
        question.locator(".nyc__tray").get_by_role("button", name="Not now").tap()
        menu = page.get_by_role("menu", name="Ask me again")
        expect(menu).to_be_visible()
        self.assertLessEqual(box(page, menu)["x"] + box(page, menu)["width"], PHONE["width"])
        for item in menu.get_by_role("menuitem").all():
            self.assertGreaterEqual(box(page, item)["height"], 44)
        page.keyboard.press("Escape")
        # Filters scroll sideways; tabs are touch sized.
        for tab in page.get_by_role("tablist", name="Show").get_by_role("tab").all():
            self.assertGreaterEqual(box(page, tab)["height"], 44)
        self.assertEqual(proposed["status"], "proposed")

    def test_13_dark_inbox(self) -> None:
        page = self.page(dark=True)
        page.goto("/inbox")
        expect(page.locator(".nyc").first).to_be_visible()
        page.mouse.move(1000, 880)
        shot(page, "inbox-final-desktop-1440-dark")
        phone = self.page(phone=True, dark=True)
        phone.goto("/inbox")
        expect(phone.locator(".nyc").first).to_be_visible()
        shot(phone, "inbox-final-phone-390-dark")

    def test_14_undo_toast_cannot_cross_accounts(self) -> None:
        """A's live Undo must not run under B's cookie after a same-tab sign-out/sign-in."""
        title = f"Session-bound rule {uuid.uuid4().hex[:8]}"
        decision = self.post("jonas", f"/api/v1/projects/{self.project_id}/decisions", {
            "title": title, "rationale": "Keep each account's queue choice private.", "affects": [self.task["id"]],
        })

        def has_decision(who: str) -> bool:
            response = self.contexts[who].request.get("/api/v1/needs-you")
            assert response.status == 200, response.text()
            return any(item.get("decision") and item["decision"].get("id") == decision["id"] for item in response.json()["items"])

        self.wait_for(lambda: has_decision("ada") and has_decision("jonas"), "the shared decision in both accounts")
        page = self.page()
        page.goto("/inbox?show=decisions")
        card = self.card(page, title)
        expect(card).to_have_attribute("aria-current", "true")
        page.keyboard.press("e")
        expect(page.get_by_role("status").filter(has_text="Marked done")).to_be_visible()
        self.wait_for(lambda: not has_decision("ada"), "Ada's decision choice to be stored")
        self.assertTrue(has_decision("jonas"), "Ada’s decision must remain in Jonas’s queue")

        # Use the same tab and browser context: the toast provider stays mounted across these routes.
        page.goto("/sign-out")
        page.get_by_role("button", name="Sign out", exact=True).click()
        expect(page.get_by_role("heading", name="Sign in")).to_be_visible()
        page.get_by_label("Email").fill(PEOPLE["jonas"][1])
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Sign in", exact=True).click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        self.assertEqual(page.request.get("/api/v1/me").json()["user"]["id"], self.ids["jonas"], "the same tab now carries Jonas's session")
        page.get_by_role("link", name=re.compile("^Open Inbox")).click()
        card = self.card(page, title)
        expect(card).to_have_attribute("aria-current", "true")

        def current_tab_has_decision() -> bool:
            response = page.request.get("/api/v1/needs-you")
            assert response.status == 200, response.text()
            return any(item.get("decision") and item["decision"].get("id") == decision["id"] for item in response.json()["items"])

        # B makes and dismisses their own Done toast. If A's callback survived, Z now picks it
        # and sends its DELETE with B's cookie, incorrectly putting B's decision back in the queue.
        page.keyboard.press("e")
        expect(page.get_by_role("status").filter(has_text="Marked done")).to_be_visible()
        self.wait_for(lambda: not current_tab_has_decision(), "Jonas's decision choice to be stored")
        own_toast = page.locator(".ui-toast").filter(has_text="Marked done").last
        own_toast.get_by_role("button", name="Dismiss notification").click()
        expect(page.locator(".ui-toast")).to_have_count(0)
        page.keyboard.press("z")
        # Allow a wrongly retained callback enough time to make its request, then verify the same
        # signed-in tab still sees the decision resolved for B.
        for _ in range(6):
            time.sleep(0.25)
            self.assertFalse(current_tab_has_decision(), "A stale Undo callback must not restore the decision for Jonas")


def requests_quote(key: str) -> str:
    import urllib.parse
    return urllib.parse.quote(key, safe="")


if __name__ == "__main__":
    unittest.main()
