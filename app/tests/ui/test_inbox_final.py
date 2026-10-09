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

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, box, shot, start_forwarder

PASSWORD = "a calm inbox for the garden"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ada": ("Ada Kowalska", f"ada.i+{STAMP}@example.test"),
    "jonas": ("Jonas Berg", f"jonas.i+{STAMP}@example.test"),
}
DECISION = "Measure soil moisture first; frost warnings later"
REASON = "Overwatering is the problem now; frost only matters in spring."


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
        cls.browser = cls.pw.chromium.launch()
        expect.set_options(timeout=15000)
        for key, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(base_url=ORIGIN)
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
        context = self.browser.new_context(**options)
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
        # Three: when the task it affects is done.
        page.keyboard.press("3")
        expect(page.get_by_role("status").filter(has_text="Back when #1 is done")).to_be_visible()
        expect(decision).to_have_count(0)
        self.wait_for(lambda: (self.queue(None)["count"], self.queue(None)["later"]) == (3, 1), "the snooze to be stored")
        page.keyboard.press("z")
        expect(decision).to_have_count(1)
        self.wait_for(lambda: self.queue(None)["later"] == 0, "the snooze to be undone")

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

    # ---------------------------------------------------------------- blocked tasks and mentions

    def test_08_unblock_with_undo(self) -> None:
        page = self.page()
        page.goto("/inbox")
        card = self.card(page, "is blocked")
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
        expect(page.get_by_text("all clear · all projects")).to_be_visible()
        expect(page.get_by_role("link", name="Notification settings").last).to_be_visible()
        expect(page.get_by_role("navigation", name="Places").get_by_role("link", name="Inbox", exact=True).locator(".side__count")).to_have_count(0)
        page.get_by_role("tab", name=re.compile("^Questions")).click()
        expect(page.get_by_role("heading", name="No questions wait for you")).to_be_visible()
        shot(page, "inbox-final-desktop-1440-clear")
        self.assertEqual(self.queue(None)["count"], 0)

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


def requests_quote(key: str) -> str:
    import urllib.parse
    return urllib.parse.quote(key, safe="")


if __name__ == "__main__":
    unittest.main()
