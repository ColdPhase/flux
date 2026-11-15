"""Undo toasts that expire and stay where they were made, and one card per task or decision in a conversation.

Founder decisions 3 and 4 on #1424 (Hubert, 2026-11-14), from the persona walkthroughs of e8ead9f5e (D-3, C-11, B-8, D-2, C-4),
and the UI audit's P2-4 and P3 17. Runs through scripts/check_ui.sh against the running Compose application, on the engine named
by FLUX_UI_BROWSER (run it with chromium and with webkit), on a computer (1440 x 900, and 1024 x 768 beside a docked panel) and a
phone (390 x 844, touch):

* An Undo toast leaves on its own after 10 s, and not while the pointer is over it or focus is in it.
* Going to another place ends it at once: `Z` there undoes nothing, and an Accept held for Undo is sent then, not 10 s later.
* While a toast shows, the conversation keeps its end clear of it: the new task's card and an inline Delete / Keep row in a direct
  message are above the toast, never under it.
* A task and a decision made from a message show once in the space's conversation: one card with who made it, from which message
  (a link to it) and when inside it; no chip in the message and no separate event line. Accepting a decision changes its card in
  place, with who accepted it and when on the card, and adds no line (founder decision D, #1424, 2026-11-15).
* A proposed decision reaches everyone at once, and its Undo withdraws it for everyone (founder decision L, #1424, 2026-11-15).
  One state has one word ("Proposed", never "Proposed decision"), and the decision panel says "Decision" once.
* Beside a docked panel at 1024 px a task card keeps its title readable and its state word inside the card.
"""

from __future__ import annotations

import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from create_window import dialog, submit_button, title_field, window
from inbox_items import open_item
from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, press_shortcut, shot, start_forwarder

PASSWORD = "one card and a calm undo"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ada": ("Ada Kowalska", f"ada.onecard+{STAMP}@example.test"),
    "jonas": ("Jonas Berg", f"jonas.onecard+{STAMP}@example.test"),
    "maja": ("Maja Wiśniewska-Lindqvist", f"maja.onecard+{STAMP}@example.test"),
}
READER = "Can we get a card reader for the market? Cash only lost us sales last time."
BUNS = "Should we double the cinnamon buns? They sold out by ten."
TASK = "Get a card reader for the market"
DECIDED = "Double the cinnamon buns for the market"
OPEN_RULE = "Print a price board for the stall"
LONG_TASK = "Calibrate the soil moisture probes in the far east bed"
TOAST_MS = 10_000
GAZEBO = "Bring a second gazebo in case of rain"


def box(page: Page, selector_or_locator) -> dict:
    locator = page.locator(selector_or_locator) if isinstance(selector_or_locator, str) else selector_or_locator
    return locator.evaluate("el => { const r = el.getBoundingClientRect(); return {left: r.left, right: r.right, top: r.top, bottom: r.bottom}; }")


class UndoAndOneCard(unittest.TestCase):
    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}

    @classmethod
    def call(cls, who: str, method: str, path: str, body: dict | None = None) -> dict:
        context = cls.browser.new_context(base_url=ORIGIN, storage_state=cls.states[who], service_workers="block")
        try:
            response = context.request.fetch(path, method=method, data=body, headers={"origin": ORIGIN})
            assert response.status in (200, 201), f"{method} {path}: {response.status} {response.text()}"
            return response.json() if response.text() else {}
        finally:
            context.close()

    @classmethod
    def root(cls, who: str, body: str) -> dict:
        return cls.call(who, "POST", f"/api/v1/projects/{cls.ids['project']}/conversations", {"body": body, "clientMessageId": str(uuid.uuid4())})

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
            cls.states[key] = context.storage_state()
            context.close()
        workspace = cls.call("ada", "POST", "/api/v1/workspaces", {"name": "Bakery"})["id"]
        for key in ("jonas", "maja"):
            cls.call("ada", "POST", f"/api/v1/workspaces/{workspace}/members", {"email": PEOPLE[key][1], "role": "member"})
        cls.ids["project"] = cls.call("ada", "POST", f"/api/v1/workspaces/{workspace}/projects", {"name": "Spring market stall", "visibility": "workspace"})["id"]
        project = cls.ids["project"]
        # Enough of a conversation that its end sits right above the composer, where a toast stands.
        for index in range(10):
            cls.root("jonas" if index % 2 else "ada", f"Stall note {index + 1}: tables, the gazebo and the float for the till are sorted.")
        reader = cls.root("jonas", READER)
        cls.ids["reader"] = reader["messages"][0]["id"]
        cls.ids["task"] = cls.call("ada", "POST", f"/api/v1/projects/{project}/work", {
            "title": TASK, "owner": {"kind": "human", "id": cls.ids["maja"]},
            "sources": [{"type": "message", "id": cls.ids["reader"]}], "clientCommandId": str(uuid.uuid4())})["id"]
        buns = cls.root("jonas", BUNS)
        cls.ids["buns"] = buns["messages"][0]["id"]
        decision = cls.call("ada", "POST", f"/api/v1/projects/{project}/decisions", {"title": DECIDED, "sources": [{"type": "message", "id": cls.ids["buns"]}]})
        cls.ids["decided"] = decision["id"]
        # Something between the proposal and its acceptance: the card still changes in place, and no line is added after it.
        cls.root("maja", "I can bring the cash box as a fallback.")
        cls.call("ada", "POST", f"/api/v1/decisions/{decision['id']}/accept", {"expectedVersion": decision["version"]})
        cls.ids["open_rule"] = cls.call("jonas", "POST", f"/api/v1/projects/{project}/decisions", {"title": OPEN_RULE})["id"]
        cls.ids["long_task"] = cls.call("ada", "POST", f"/api/v1/projects/{project}/work", {
            "title": LONG_TASK, "status": "in_progress", "owner": {"kind": "human", "id": cls.ids["maja"]}, "clientCommandId": str(uuid.uuid4())})["id"]
        cls.root("maja", "The probes are in the shed.")
        dm = cls.call("ada", "POST", f"/api/v1/workspaces/{workspace}/dms", {"participantIds": [cls.ids["jonas"]]})
        cls.ids["dm"] = dm["id"]
        for index in range(12):
            who = "ada" if index % 2 else "jonas"
            sent = cls.call(who, "POST", f"/api/v1/dms/{dm['id']}/messages", {"body": f"Market plan {index + 1}: who brings the scales and the bags.", "clientMessageId": str(uuid.uuid4())})
            if who == "ada":
                cls.ids["dm_last"] = sent["id"]

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, who: str = "ada", *, phone: bool = False, viewport: dict | None = None) -> Page:
        options: dict = {"base_url": ORIGIN, "locale": "en-GB", "timezone_id": "Europe/Warsaw", "storage_state": self.states[who]}
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=viewport or DESKTOP, device_scale_factor=1)
        context = self.browser.new_context(service_workers="block", **options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def stream(self, page: Page) -> None:
        page.goto(f"/projects/{self.ids['project']}")
        expect(page.locator(f"#message-{self.ids['reader']}")).to_be_visible()

    def create_task(self, page: Page, title: str, phone: bool) -> None:
        # `/task` in the space's composer opens the one Create window with the words, on a computer and a phone alike.
        composer = page.locator("#project-composer")
        composer.fill(f"/task {title}")
        # Enter sends on a computer; a phone's Enter is a new line, so it uses Send.
        if phone:
            page.get_by_role("button", name="Send message", exact=True).click()
        else:
            composer.press("Enter")
        expect(dialog(page)).to_be_visible()
        expect(title_field(page)).to_have_value(title)
        submit_button(page).click()
        expect(dialog(page)).to_have_count(0)

    def settled_toast(self, page: Page, text: str):
        toast = page.locator(".ui-toast").filter(has_text=text)
        expect(toast).to_be_visible()
        page.wait_for_function("() => [...document.querySelectorAll('.ui-toast')].every(el => getComputedStyle(el).transform === 'none' && getComputedStyle(el).opacity === '1')")
        return toast

    def work(self, page: Page, work_id: str) -> dict:
        return page.request.get(f"/api/v1/work/{work_id}").json()

    def at_end(self, page: Page, feed: str) -> None:
        page.evaluate("(feed) => { const el = document.querySelector(feed); el.scrollTop = el.scrollHeight; }", feed)
        page.wait_for_timeout(200)

    # ------------------------------------------------------------------ decision 4: one card

    def test_01_a_task_and_a_decision_show_once_as_one_card(self) -> None:
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page(phone=phone)
                self.stream(page)
                feed = page.locator(".project-convo__message-list")
                # The task: no chip in the message it came from, and one card that carries who, from what and when.
                reader = page.locator(f"#message-{self.ids['reader']}")
                expect(reader.locator(".ws-chip")).to_have_count(0)
                made = feed.locator(f'.convo-notice[data-work-id="{self.ids["task"]}"]')
                expect(made).to_have_count(1)
                expect(made.locator(".convo-notice__card")).to_have_count(1)
                expect(made.locator(".convo-notice__card .convo-notice__task")).to_have_count(1)
                expect(made.locator(".convo-notice__card .convo-notice__meta")).to_have_count(1)
                expect(made.locator(".convo-notice__meta")).to_have_count(1)
                expect(made.locator(".convo-notice__meta strong")).to_have_text("Ada Kowalska (you)")
                expect(made.locator(".convo-notice__what")).to_have_text("created a task from Jonas’s message")
                expect(made.locator(".convo-notice__title")).to_have_text(TASK)
                # The way from the card to the message it came from is on the card.
                made.scroll_into_view_if_needed()
                link = made.get_by_role("button", name="Jonas’s message")
                if phone:
                    link.tap()
                else:
                    link.click()
                expect(reader).to_be_focused()
                # The decision: one card in the stream, its state in one word, no chip in its message.
                expect(page.locator(f"#message-{self.ids['buns']} .ws-chip")).to_have_count(0)
                lines = feed.locator(f'.convo-object[data-object-id="{self.ids["decided"]}"]')
                expect(lines).to_have_count(1)
                expect(lines.locator(".convo-notice__card")).to_have_count(1)
                proposed = feed.locator('.convo-object[data-object-kind="decision.proposed"]', has_text=DECIDED)
                expect(proposed.locator(".convo-object__state")).to_have_text("Accepted")
                expect(proposed.locator(".convo-notice__card .convo-notice__what")).to_have_text("proposed a decision from Jonas’s message")
                # Accepted after another message: the card changed in place, with who accepted it on the card, and no line was added.
                expect(proposed.locator(".convo-object__decided")).to_have_text(re.compile(r"^Accepted by Ada Kowalska \(you\) · \S"))
                expect(feed.locator('.convo-object[data-object-kind="decision.accepted"]')).to_have_count(0)
                expect(feed).not_to_contain_text("accepted the decision")
                expect(feed).not_to_contain_text("accepted it")
                expect(feed.locator(".convo-object", has_text=OPEN_RULE).locator(".convo-object__state")).to_have_text("Proposed")
                expect(feed.locator(".convo-object", has_text=OPEN_RULE).locator(".convo-object__decided")).to_have_count(0)
                expect(feed).not_to_contain_text("Proposed decision")
                shot(page, f"one-card-stream-{'phone' if phone else 'desktop'}-{UI_BROWSER}")
                # The card opens the decision; its panel names the kind once and the state alone.
                title = proposed.get_by_role("button", name=re.compile(rf"^Open decision {re.escape(DECIDED)}"))
                title.scroll_into_view_if_needed()
                if phone:
                    title.tap()
                else:
                    title.click()
                panel = page.locator("#details")
                expect(panel.get_by_role("heading", name=DECIDED)).to_be_visible()
                eyebrow = panel.locator(".wd-eyebrow")
                expect(eyebrow).to_contain_text("Accepted")
                expect(eyebrow).not_to_contain_text("Decision")

    def test_01b_a_proposed_decision_reaches_everyone_at_once_and_undo_withdraws_it(self) -> None:
        # Founder decision L (#1424, 2026-11-15): there is no 10 s hold. The proposal is sent at once, its card shows for the proposer and
        # for anyone watching the space at once, and the toast's Undo withdraws it for everyone.
        page, watcher = self.page(), self.page("jonas")
        self.stream(page)
        self.stream(watcher)
        feed = page.locator(".project-convo__message-list")
        card = feed.locator('.convo-object[data-object-kind="decision.proposed"]', has_text=GAZEBO)
        theirs = watcher.locator(".project-convo__message-list").locator('.convo-object[data-object-kind="decision.proposed"]', has_text=GAZEBO)
        decisions = lambda: [item["title"] for item in page.request.get(f"/api/v1/projects/{self.ids['project']}/decisions?limit=100").json()["items"]]  # noqa: E731

        def propose() -> None:
            composer = page.locator("#project-composer")
            composer.fill(f"/decide {GAZEBO}")
            composer.press("Enter")
            expect(window(page)).to_be_visible()
            window(page).get_by_role("button", name=re.compile("^Propose decision")).click()
            expect(window(page)).to_have_count(0)
            expect(page.locator(".ui-toast").filter(has_text="Decision proposed")).to_be_visible()

        propose()
        expect(card, "the card is in the conversation at once").to_have_count(1, timeout=2000)
        expect(card.locator(".convo-object__state")).to_have_text("Proposed")
        expect(card.locator(".convo-notice__meta strong")).to_have_text("Ada Kowalska (you)")
        # Sent at once, with the toast still up: the server has it, and Jonas, watching the space, sees its card well inside the toast's 10 s.
        expect(page.locator(".ui-toast").filter(has_text="Decision proposed")).to_be_visible()
        self.assertIn(GAZEBO, decisions(), "sent at once, not held for Undo")
        expect(theirs, "a watcher sees it at once").to_have_count(1, timeout=5000)
        expect(theirs.locator(".convo-notice__meta strong")).to_have_text("Ada Kowalska")
        expect(page.locator(".ui-toast").filter(has_text="Decision proposed")).to_be_visible()
        shot(page, f"one-card-proposal-at-once-{UI_BROWSER}")
        # Undo withdraws it for everyone: gone from the server, from Ada's conversation and from Jonas's, without a reload.
        page.locator(".ui-toast").filter(has_text="Decision proposed").get_by_role("button", name=re.compile("^Undo")).click()
        expect(page.locator(".ui-toast").filter(has_text="Not proposed")).to_be_visible()
        expect(card, "Undo takes the card away").to_have_count(0)
        self.assertNotIn(GAZEBO, decisions())
        expect(theirs, "and from everyone who watched it arrive").to_have_count(0, timeout=10000)

        # Again, and opened from its card: it opens in the panel, and stays one card once the read has it.
        propose()
        expect(card).to_have_count(1, timeout=2000)
        card.get_by_role("button", name=re.compile(rf"^Open decision {re.escape(GAZEBO)}")).first.click()
        expect(page.locator("#details").get_by_role("heading", name=GAZEBO)).to_be_visible()
        self.assertEqual(decisions().count(GAZEBO), 1, "proposed once")
        page.wait_for_timeout(1500)
        expect(card).to_have_count(1)
        expect(card.locator(".convo-object__state")).to_have_text("Proposed")
        expect(theirs).to_have_count(1)

    def test_01c_a_task_from_your_own_message_starts_as_yours(self) -> None:
        # Founder decision M (#1424, 2026-11-15): Create task on your own message, T on it and `/task` start the window with you as
        # its Owner; on someone else's message it starts with no owner, as before. Nothing is created here: each window is closed.
        page = self.page()
        self.stream(page)
        owner = lambda: dialog(page).get_by_role("combobox", name="Owner")  # noqa: E731

        def close() -> None:
            page.keyboard.press("Escape")
            expect(dialog(page)).to_have_count(0)

        own = page.locator('[id^="message-"]', has_text="Stall note 9:").first
        own.scroll_into_view_if_needed()
        own.hover()
        own.get_by_role("button", name="Create task", exact=True).click()
        expect(dialog(page)).to_be_visible()
        expect(owner()).to_have_text("Ada Kowalska (you)")
        close()
        theirs = page.locator(f"#message-{self.ids['buns']}")
        theirs.scroll_into_view_if_needed()
        theirs.hover()
        theirs.get_by_role("button", name="Create task", exact=True).click()
        expect(dialog(page)).to_be_visible()
        expect(owner()).to_have_text("No owner")
        close()
        # T on your own message, from the keyboard.
        own.hover()
        own.focus()
        page.keyboard.press("t")
        expect(dialog(page)).to_be_visible()
        expect(owner()).to_have_text("Ada Kowalska (you)")
        close()
        # Your own `/task` words.
        composer = page.locator("#project-composer")
        composer.fill("/task Bring the spare float")
        composer.press("Enter")
        expect(dialog(page)).to_be_visible()
        expect(owner()).to_have_text("Ada Kowalska (you)")
        close()
        composer.fill("")

    def test_02_a_task_card_keeps_its_title_beside_a_docked_panel_at_1024(self) -> None:
        for touch in (False, True):
            with self.subTest(touch=touch):
                context = self.browser.new_context(base_url=ORIGIN, service_workers="block", storage_state=self.states["ada"], locale="en-GB",
                                                   viewport={"width": 1024, "height": 768}, has_touch=touch)
                self.addCleanup(context.close)
                page = context.new_page()
                page.goto(f"/projects/{self.ids['project']}?open=decision:{self.ids['decided']}")
                expect(page.locator("#details").get_by_role("heading", name=DECIDED)).to_be_visible()
                for work_id, title in ((self.ids["long_task"], LONG_TASK), (self.ids["task"], TASK)):
                    card = page.locator(f'.convo-notice[data-work-id="{work_id}"] .convo-notice__card')
                    card.scroll_into_view_if_needed()
                    expect(card.locator(".convo-notice__title")).to_have_text(title)
                    measured = card.evaluate("""card => {
                      const r = (el) => el.getBoundingClientRect();
                      const title = card.querySelector('.convo-notice__title'), state = card.querySelector('.convo-notice__state');
                      return {card: r(card).right, cardLeft: r(card).left, title: r(title).width, state: r(state).right, stateLeft: r(state).left,
                        stateFits: state.scrollWidth <= state.clientWidth + 1};
                    }""")
                    label = f"1024 px beside the panel{' (touch)' if touch else ''}, {title}: {measured}"
                    # The audit saw 0 px of title and the state 12.6 px past the card (P2-4).
                    self.assertGreaterEqual(measured["title"], 60, f"{label}: the title is readable")
                    self.assertLessEqual(measured["state"], measured["card"] + 0.5, f"{label}: the state word stays inside the card")
                    self.assertTrue(measured["stateFits"], f"{label}: the state word is whole")
                shot(page, f"one-card-1024-panel{'-touch' if touch else ''}-{UI_BROWSER}")

    # ------------------------------------------------------------------ decision 3: Undo toasts

    def test_03_an_undo_toast_leaves_after_ten_seconds_but_not_while_held(self) -> None:
        page = self.page()
        self.stream(page)
        self.create_task(page, f"Bring the scales {uuid.uuid4().hex[:4]}", phone=False)
        toast = self.settled_toast(page, "created")
        started = time.monotonic()
        page.mouse.move(5, 5)
        page.wait_for_timeout(TOAST_MS - 2000)
        expect(toast).to_be_visible()
        expect(toast).to_have_count(0, timeout=5000)
        # Timed from when it had settled on screen, a little after its 10 s began.
        self.assertGreaterEqual(time.monotonic() - started, (TOAST_MS - 1500) / 1000, "it stayed about 10 s")
        # Held by the pointer: it stays past its 10 s, and runs on when the pointer leaves.
        self.create_task(page, f"Bring the bags {uuid.uuid4().hex[:4]}", phone=False)
        toast = self.settled_toast(page, "created")
        toast.hover()
        page.wait_for_timeout(TOAST_MS + 1500)
        expect(toast).to_be_visible()
        page.mouse.move(5, 5)
        expect(toast).to_have_count(0, timeout=TOAST_MS + 3000)
        # Held by focus, so Undo is reachable with Tab or a screen reader for as long as it is needed.
        self.create_task(page, f"Bring the float {uuid.uuid4().hex[:4]}", phone=False)
        toast = self.settled_toast(page, "created")
        page.mouse.move(5, 5)
        toast.get_by_role("button", name="Undo").focus()
        page.wait_for_timeout(TOAST_MS + 1500)
        expect(toast).to_be_visible()
        toast.get_by_role("button", name="Undo").press("Enter")
        expect(page.locator(".ui-toast").filter(has_text="creation undone")).to_be_visible()

    def test_04_another_place_ends_undo_so_z_never_undoes_from_there(self) -> None:
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page(phone=phone)
                self.stream(page)
                title = f"Label the jars {uuid.uuid4().hex[:4]}"
                self.create_task(page, title, phone)
                self.settled_toast(page, "created")
                made = next(item for item in page.request.get(f"/api/v1/projects/{self.ids['project']}/work?limit=100").json()["items"] if item["title"] == title)
                # Another place: the space's Tasks view (the address changes).
                if phone:
                    close = page.locator("#details").get_by_role("button", name=re.compile("^Close"))
                    if close.count():
                        close.first.click()
                page.get_by_role("navigation", name="Space views").get_by_role("tab", name=re.compile(r"^Tasks")).click()
                expect(page).to_have_url(re.compile(r"/tasks$"))
                expect(page.locator(".ui-toast").filter(has_text="created")).to_have_count(0, timeout=3000)
                press_shortcut(page, "z")
                page.wait_for_timeout(1500)
                state = (self.work(page, made["id"]).get("lifecycle") or {}).get("state")
                self.assertNotEqual(state, "creation_reverted", "Z in another place undid nothing")

    def test_05_an_accept_held_for_undo_is_sent_when_its_toast_leaves(self) -> None:
        rule = self.call("ada", "POST", f"/api/v1/projects/{self.ids['project']}/decisions", {"title": f"Close the stall at four {uuid.uuid4().hex[:4]}"})
        page = self.page("jonas")
        for _ in range(60):
            if any((item.get("decision") or {}).get("id") == rule["id"] for item in page.request.get("/api/v1/needs-you").json()["items"]):
                break
            time.sleep(0.25)
        page.goto("/inbox")
        row = page.locator("li.nyc--decision").filter(has_text=rule["title"])
        open_item(row).get_by_role("button", name=re.compile("^Accept")).click()
        self.settled_toast(page, "Accepted")
        status = lambda: page.request.get(f"/api/v1/projects/{self.ids['project']}/decisions?limit=100").json()["items"]
        self.assertEqual(next(item for item in status() if item["id"] == rule["id"])["status"], "proposed", "held while Undo is offered")
        left = time.monotonic()
        page.get_by_role("complementary", name="Sidebar").get_by_role("link", name="Home").first.click()
        expect(page.locator(".ui-toast").filter(has_text="Accepted")).to_have_count(0, timeout=3000)
        for _ in range(40):
            if next(item for item in status() if item["id"] == rule["id"])["status"] == "accepted":
                break
            time.sleep(0.1)
        self.assertEqual(next(item for item in status() if item["id"] == rule["id"])["status"], "accepted")
        self.assertLess(time.monotonic() - left, 5, "sent when the toast left, not at the end of its 10 s")

    def test_06_a_toast_never_covers_the_new_card_or_a_delete_row(self) -> None:
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page(phone=phone)
                self.stream(page)
                title = f"Wrap the cutlery {uuid.uuid4().hex[:4]}"
                self.create_task(page, title, phone)
                toast = self.settled_toast(page, "created")
                if phone:
                    page.locator("#details").get_by_role("button", name=re.compile("^Close")).first.click()
                card = page.locator(".convo-notice").filter(has_text=title).locator(".convo-notice__card")
                expect(card).to_be_visible()
                self.at_end(page, ".project-convo__feed")
                expect(toast).to_be_visible()
                below, above = box(page, card), box(page, toast)
                self.assertLessEqual(below["bottom"], above["top"] + 0.5, f"the new task's card is above the toast: {below} {above}")
                shot(page, f"toast-clear-card-{'phone' if phone else 'desktop'}-{UI_BROWSER}")
                # When the toast goes, nothing moves under the reader: the card stays where it was (measured once the stream is still).
                page.wait_for_function("""(el) => new Promise(resolve => { let last = null, still = 0; const check = () => {
                  const top = el.getBoundingClientRect().top; still = top === last ? still + 1 : 0; last = top;
                  if (still > 10) resolve(true); else requestAnimationFrame(check); }; requestAnimationFrame(check); })""", arg=card.element_handle())
                below = box(page, card)
                scrolled = page.evaluate("() => { const el = document.querySelector('.project-convo__feed'); const t = document.querySelector('.ui-toasts').getBoundingClientRect(); return [el.scrollTop, el.scrollHeight, getComputedStyle(document.querySelector('.project-convo__in')).borderBottomWidth, Math.round(t.top), Math.round(t.height), Math.round(el.getBoundingClientRect().bottom)]; }")
                toast.locator(".ui-toast__close").evaluate("el => el.click()")
                expect(page.locator(".ui-toast")).to_have_count(0)
                page.wait_for_timeout(300)
                after = page.evaluate("() => { const el = document.querySelector('.project-convo__feed'); const t = document.querySelector('.ui-toasts').getBoundingClientRect(); return [el.scrollTop, el.scrollHeight, getComputedStyle(document.querySelector('.project-convo__in')).borderBottomWidth, Math.round(t.top), Math.round(t.height), Math.round(el.getBoundingClientRect().bottom)]; }")
                self.assertAlmostEqual(box(page, card)["top"], below["top"], delta=1, msg=f"the card stays put when the toast leaves: scroll {scrolled} -> {after}")
                # Reading up gives the room back without a jump; the end is the conversation's own again.
                page.evaluate("() => { const el = document.querySelector('.project-convo__feed'); el.scrollTop = 0; }")
                page.wait_for_timeout(300)
                self.assertEqual(page.evaluate("() => getComputedStyle(document.querySelector('.project-convo__in')).borderBottomWidth"), "0px")
        # A direct message: a toast from elsewhere in the app (Mark all as read) and an inline Delete / Keep row on the last message.
        page = self.page()
        page.goto(f"/dm/{self.ids['dm']}")
        last = page.locator(f"#message-{self.ids['dm_last']}")
        expect(last).to_be_visible()
        page.get_by_role("button", name="More for Spaces", exact=True).click()
        page.get_by_role("menuitem", name="Mark all as read", exact=True).click()
        toast = self.settled_toast(page, "Marked all as read")
        last.hover()
        last.get_by_role("button", name="More actions").click()
        page.get_by_role("menuitem", name="Delete", exact=True).click()
        ask = last.get_by_role("group", name="Delete this message")
        expect(ask).to_be_visible()
        self.at_end(page, ".dm__feed")
        expect(toast).to_be_visible()
        row, above = box(page, ask), box(page, toast)
        self.assertLessEqual(row["bottom"], above["top"] + 0.5, f"the Delete / Keep row is above the toast: {row} {above}")
        shot(page, f"toast-clear-delete-row-{UI_BROWSER}")
        page.keyboard.press("Escape")


if __name__ == "__main__":
    unittest.main()
