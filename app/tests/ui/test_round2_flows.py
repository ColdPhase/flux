"""Browser tests for the #763 round-2 workflow and first-use fixes.

Runs through scripts/check_ui.sh against the running Compose application, on the engine named by FLUX_UI_BROWSER (run it
with chromium and with webkit), on a computer (1440 x 900) and a phone (390 x 844, touch):

* FT-1 / FR-4 (F-037): a person in no company sees one calm first step on Home (how to join) and no empty
  "Waiting for you", "Enjoy the quiet" or empty sidebar Projects section; the step opens New project.
* LD-1 / LD-5 / IN-3: the Inbox expands only the selected item; the others are one line with one quiet action; there is
  one inverted primary; a filter with nothing in it is not offered; the selection is not a ring; a click on a compact
  card opens it.
* WF-3 / SP-5: a message's Propose a decision opens the Create window on Decision with the message's first clause,
  selected, and the message quoted; proposing shows "Decision proposed" with Undo, and Undo means it never reaches
  anyone; without Undo it is proposed with the message as its source.
* WF-2: a task made from your own message says "from your message".
"""

from __future__ import annotations

import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, shot, start_forwarder

PASSWORD = "round two keeps the first minutes calm"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ada": ("Ada Kowalska", f"ada.r2+{STAMP}@example.test"),
    "jonas": ("Jonas Berg", f"jonas.r2+{STAMP}@example.test"),
    "new": ("Ola Wiśniewska", f"ola.r2+{STAMP}@example.test"),
}
QUESTION = "Could someone check bed 3 tomorrow morning? It reads 18 %, the lowest of all beds."
CLAUSE = "Could someone check bed 3 tomorrow morning"
DECISIONS = ("Measure soil moisture first; frost warnings later", "Log every 15 minutes", "Label every bed with a QR code")


class Round2Flows(unittest.TestCase):
    """Tests run in name order and share the accounts made in setUpClass."""

    pw = None
    browser: Browser
    contexts: dict[str, BrowserContext] = {}
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}

    @classmethod
    def post(cls, who: str, path: str, body: dict | None = None) -> dict:
        response = cls.contexts[who].request.post(path, data=body or {}, headers={"origin": ORIGIN})
        assert response.status in (200, 201), f"{path}: {response.status} {response.text()}"
        return response.json()

    @classmethod
    def get(cls, who: str, path: str) -> dict:
        response = cls.contexts[who].request.get(path)
        assert response.status == 200, f"{path}: {response.status} {response.text()}"
        return response.json()

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
        workspace = cls.post("ada", "/api/v1/workspaces", {"name": "Riverside Makers"})["id"]
        cls.post("ada", f"/api/v1/workspaces/{workspace}/members", {"email": PEOPLE["jonas"][1], "role": "member"})
        project = cls.post("ada", f"/api/v1/workspaces/{workspace}/projects", {"name": "Community garden sensors", "visibility": "workspace"})["id"]
        cls.ids["project"] = project
        for title in DECISIONS:
            cls.post("jonas", f"/api/v1/projects/{project}/decisions", {"title": title, "rationale": "Overwatering is the problem now; frost only matters in spring."})
        cls.post("jonas", f"/api/v1/projects/{project}/conversations", {"body": "@Ada Kowalska can you check the shed roof?", "clientMessageId": str(uuid.uuid4())})
        question = cls.post("ada", f"/api/v1/projects/{project}/conversations", {"body": QUESTION, "clientMessageId": str(uuid.uuid4())})
        cls.ids["question"] = question["messages"][0]["id"]
        own = cls.post("ada", f"/api/v1/projects/{project}/conversations", {"body": "Order six capacitive probes from the shortlist", "clientMessageId": str(uuid.uuid4())})
        cls.post("ada", f"/api/v1/projects/{project}/work", {"title": "Order six capacitive probes", "sources": [{"type": "message", "id": own["messages"][0]["id"]}],
                                                            "clientCommandId": str(uuid.uuid4())})
        for key, context in cls.contexts.items():
            cls.states[key] = context.storage_state()
        for _ in range(80):
            if len(cls.get("ada", "/api/v1/needs-you")["items"]) >= 4:
                break
            time.sleep(0.25)

    @classmethod
    def tearDownClass(cls) -> None:
        for context in cls.contexts.values():
            context.close()
        cls.browser.close()
        cls.pw.stop()

    def page(self, who: str, *, phone: bool = False, dark: bool = False) -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": "dark" if dark else "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw",
                         "storage_state": self.states[who]}
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

    def decisions(self) -> list[dict]:
        return self.get("ada", f"/api/v1/projects/{self.ids['project']}/decisions?limit=100")["items"]

    # ---------------------------------------------------------------- FT-1, FR-4

    def test_01_a_person_in_no_company_gets_one_calm_first_step(self) -> None:
        """F-037: an account nobody has invited is in no company; Home says how to join and starts nothing."""
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page("new", phone=phone)
                page.goto("/")
                first = page.get_by_role("region", name="You’re not in a company here yet")
                expect(first).to_be_visible()
                expect(first.get_by_text("Got an invite link? Open it to join your company.")).to_be_visible()
                expect(page.get_by_text("Enjoy the quiet", exact=False)).to_have_count(0)
                expect(page.get_by_role("heading", name="Waiting for you")).to_have_count(0)
                expect(page.get_by_text("with the New button", exact=False)).to_have_count(0)
                self.assertEqual(page.locator("#content .ui-btn--primary:visible").count(), 0, "nothing to start before joining")
                if not phone:
                    expect(page.get_by_role("complementary", name="Sidebar").get_by_text("No spaces yet")).to_have_count(0)
                shot(page, f"r2-first-home-{'390' if phone else '1440'}-{UI_BROWSER}")

    # ---------------------------------------------------------------- LD-1, LD-5, IN-3

    def test_02_the_inbox_opens_only_the_selected_item(self) -> None:
        for phone, dark in ((False, False), (False, True), (True, False)):
            with self.subTest(phone=phone, dark=dark):
                page = self.page("ada", phone=phone, dark=dark)
                page.goto("/inbox")
                cards = page.locator(".nyq__list > .nyc")
                expect(cards.first).to_be_visible()
                count = cards.count()
                self.assertGreaterEqual(count, 4)
                expect(page.locator(".nyq__list > .nyc.is-selected")).to_have_count(1)
                expect(page.locator(".nyq__list > .nyc--compact")).to_have_count(count - 1)
                # One inverted primary: Accept on the selected decision only.
                expect(page.locator(".nyq__list .nyc__card .ui-btn--primary:visible")).to_have_count(1)
                for index in range(1, count):
                    self.assertEqual(cards.nth(index).locator(".nyc__rowactions .ui-btn").count(), 1, "a compact card has one action")
                    expect(cards.nth(index).locator(".nyc__reason, .nyc__based, .nyc__foot")).to_have_count(0)
                # "Needs you" marks only the selected card, and only on the computer.
                expect(page.locator(".nyq__list .nyc__chip")).to_have_count(0 if phone else 1)
                # A filter with nothing in it is not offered.
                filters = page.locator(".nyq__filters")
                expect(filters.get_by_role("tab", name="Blocked", exact=False)).to_have_count(0)
                expect(filters.get_by_role("tab", name="Decisions", exact=False)).to_have_count(1)
                expect(filters.get_by_role("tab", name=re.compile(r"\b0$"))).to_have_count(0)
                # The selection is not a ring (Spokój rule 6).
                ring = page.locator(".nyc.is-selected .nyc__card").evaluate("el => getComputedStyle(el).boxShadow")
                self.assertNotIn("0px 0px 0px 2px", ring)
                shot(page, f"r2-inbox-{'390' if phone else '1440'}-{'dark' if dark else 'light'}-{UI_BROWSER}")
                if phone:
                    self.assertLess(cards.nth(1).bounding_box()["height"], 120, "a compact card is about one line on a phone")
                # A click on a compact card's free space opens it, and the one before closes.
                second = cards.nth(1)
                key = second.get_attribute("data-key")
                box = second.locator(".nyc__card").bounding_box()
                if phone:
                    page.touchscreen.tap(box["x"] + 12, box["y"] + box["height"] / 2)
                else:
                    page.mouse.click(box["x"] + 12, box["y"] + box["height"] / 2)
                expect(page.locator(f'.nyc.is-selected[data-key="{key}"]')).to_have_count(1)
                expect(page.locator(".nyq__list > .nyc--compact")).to_have_count(count - 1)

    # ---------------------------------------------------------------- WF-3, SP-5

    def test_03_a_decision_from_the_window_is_short_and_can_be_undone(self) -> None:
        page = self.page("ada")
        page.goto(f"/projects/{self.ids['project']}")
        expect(page.locator(f"#message-{self.ids['question']}")).to_be_visible()

        def propose() -> None:
            # A message has no Propose a decision (#867): the Create window's Decision tab is the short form.
            page.locator("body").press("c")
            page.get_by_role("dialog", name="New task").get_by_role("tab", name="Decision", exact=True).click()
            dialog = page.get_by_role("dialog", name="New decision")
            field = dialog.get_by_role("textbox", name="Decision", exact=True)
            field.fill(CLAUSE)
            shot(page, f"r2-propose-from-window-1440-{UI_BROWSER}")
            dialog.get_by_role("button", name="Propose decision").click()
            expect(dialog).to_have_count(0)
            expect(page.locator(".ui-toast", has_text="Decision proposed")).to_be_visible()

        propose()
        page.locator(".ui-toast", has_text="Decision proposed").get_by_role("button", name="Undo").click()
        expect(page.locator(".ui-toast", has_text="Not proposed")).to_be_visible()
        time.sleep(7)
        self.assertNotIn(CLAUSE, [item["title"] for item in self.decisions()], "an undone proposal never reached anyone")
        # Without Undo it is proposed when the window ends.
        propose()
        found = None
        for _ in range(60):
            found = next((item for item in self.decisions() if item["title"] == CLAUSE), None)
            if found:
                break
            time.sleep(0.25)
        self.assertIsNotNone(found, "the proposal was sent when the Undo window ended")
        self.assertEqual(found["status"], "proposed")
        # The full form with Replaces stays one step away.
        page.locator("body").press("c")
        page.get_by_role("dialog", name="New task").get_by_role("tab", name="Decision", exact=True).click()
        page.get_by_role("dialog", name="New decision").get_by_role("textbox", name="Decision", exact=True).fill(CLAUSE)
        page.get_by_role("dialog", name="New decision").get_by_role("button", name="Replace an accepted decision…").click()
        panel = page.locator("#details")
        expect(panel.get_by_role("heading", name="Propose a decision")).to_be_visible()
        expect(panel.get_by_label("Decision", exact=True)).to_have_value(CLAUSE)
        expect(panel.get_by_label("Does it replace an earlier one?", exact=True)).to_be_visible()

    # ---------------------------------------------------------------- WF-2

    def test_04_a_task_from_your_own_message_says_your_message(self) -> None:
        page = self.page("ada")
        page.goto(f"/projects/{self.ids['project']}")
        notice = page.locator(".convo-notice", has_text="Order six capacitive probes").first
        expect(notice.locator(".convo-notice__what")).to_have_text("made a task from your message")
        jonas = self.page("jonas")
        jonas.goto(f"/projects/{self.ids['project']}")
        notice = jonas.locator(".convo-notice", has_text="Order six capacitive probes").first
        expect(notice.locator(".convo-notice__what")).to_have_text("made a task from their own message")


    # ---------------------------------------------------------------- H11-3

    def test_05_a_returning_person_finds_the_unread_divider_above_the_decision(self) -> None:
        project = self.ids["project"]
        page = self.page("jonas")
        page.goto(f"/projects/{project}")
        expect(page.locator(".project-convo__message").first).to_be_visible()
        page.wait_for_timeout(500)
        # Leaving the conversation saves where Jonas was.
        page.get_by_role("link", name="Home").first.click()
        expect(page.get_by_role("heading", level=2, name=re.compile("^Good "))).to_be_visible()
        time.sleep(1.5)
        rule = self.post("ada", f"/api/v1/projects/{project}/decisions", {"title": "Water at dawn only", "rationale": "Less evaporation."})
        self.post("ada", f"/api/v1/decisions/{rule['id']}/accept", {"expectedVersion": rule["version"]})
        time.sleep(1.5)
        # H11-3: the New divider sits right above the decision, the first thing that changed.
        page = self.page("jonas")
        page.goto(f"/projects/{project}")
        divider = page.get_by_role("separator", name="New")
        expect(divider).to_have_count(1)
        self.assertTrue(divider.evaluate("el => !!el.nextElementSibling && el.nextElementSibling.matches('.convo-object')"), "the divider is above the decision")
        # #865: no "Since you left" line floats over the stream, on a computer or a phone.
        expect(page.get_by_role("region", name="Since you left")).to_have_count(0)
        shot(page, f"r2-unread-divider-1440-{UI_BROWSER}")
        phone = self.page("jonas", phone=True)
        phone.goto(f"/projects/{project}")
        expect(phone.get_by_role("separator", name="New")).to_have_count(1)
        expect(phone.get_by_role("region", name="Since you left")).to_have_count(0)


if __name__ == "__main__":
    unittest.main()
