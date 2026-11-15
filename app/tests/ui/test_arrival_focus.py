"""Browser tests for where focus goes on a computer (v0.2.1 release gate, persona round 26: P2 #2, #5, #6 and the focus P3s).

P2 #2: after New message › "Message Piotr" focus was on the page body, so Kasia's "can I swap my Friday shift…" fired C (Create) and Enter
made task #1 in a shared space: the private words leaked. The same after a person's name in a message, the sidebar's space or direct
message. One rule: arriving in a conversation on a computer puts the cursor in its composer, and what is typed on the way is kept for it.

P2 #5: a conversation opened at a message link, read on with Tab, a task card's panel, a Status change and Esc put the stream back at the
linked message (scrollTop 828 → 0) and focus on the body. The link's place applies once, on arrival.

P2 #6: the task panel's Status (and Owner) picked from the keyboard dropped focus to the body while the change saved, and Esc then left the
panel open. Focus stays on the value, and Esc closes the panel.

P3: Create space lands in the new space's composer; Copy link gives focus back to ⋯; Esc from a new task's panel
goes to its card; A on the Inbox's last decision leaves focus on the empty Inbox's heading; Esc from a thread marks its message plainly.

The engine is FLUX_UI_BROWSER (chromium or webkit). Screenshots (arrival-focus-*.png) go to FLUX_UI_SCREENSHOTS when set.
"""

from __future__ import annotations

import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, UPSTREAM, press_shortcut, start_forwarder
from test_settings import UI_BROWSER, shot

PASSWORD = "the cursor goes where you write"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "piotr": ("Piotr Nowak", f"piotr.af+{STAMP}@example.test"),
    "kasia": ("Kasia Wrona", f"kasia.af+{STAMP}@example.test"),
    "ola": ("Ola Nowicka", f"ola.af+{STAMP}@example.test"),
}
SHARED = "Morning shift"
LONG = "Sensor readings"
# Its letters are the app's single keys (C, A, S, E, T, R): typed as shortcuts it opens Create and makes a task.
SENTENCE = "can I swap my Friday shift with Marta? Thanks, see you at the stall."
FEED = ".project-convo__feed.is-stream"
WHERE = """() => { const a = document.activeElement; if (!a || a === document.body) return null; const r = a.getBoundingClientRect();
  return { tag: a.tagName, name: (a.getAttribute('aria-label') || a.textContent || '').trim().slice(0, 80), top: r.top, bottom: r.bottom,
           cls: a.className && a.className.baseVal === undefined ? a.className : '' }; }"""


class ArrivalFocus(unittest.TestCase):
    """Tests run in name order and share the accounts and the places."""

    pw = None
    browser: Browser
    contexts: dict[str, BrowserContext] = {}
    states: dict[str, dict] = {}
    ids: dict = {}

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
            cls.states[key] = context.storage_state()
        workspace = cls.post("piotr", "/api/v1/workspaces", {"name": "Riverside Bakery"})["id"]
        for who in ("kasia", "ola"):
            cls.post("piotr", f"/api/v1/workspaces/{workspace}/members", {"email": PEOPLE[who][1], "role": "member"})
        shared = cls.post("piotr", f"/api/v1/workspaces/{workspace}/projects", {"name": SHARED, "visibility": "workspace"})["id"]
        cls.ids["shared"] = shared
        cls.post("piotr", f"/api/v1/projects/{shared}/conversations", {"body": "Saturday's rota is on the Wiki. Tell me if a shift does not work.", "clientMessageId": str(uuid.uuid4())})
        # A long conversation whose task cards stand between its messages, for a link to one of its first messages.
        long = cls.post("piotr", f"/api/v1/workspaces/{workspace}/projects", {"name": LONG, "visibility": "workspace"})["id"]
        cls.ids["long"] = long
        messages = []
        for index in range(32):
            body = (f"Bed {index % 8 + 1}, reading {index + 1}: the soil probe there says {20 + index}% this morning and the gateway relayed "
                    "every reading without a gap, so the overnight frost did not reach the roots.")
            root = cls.post("kasia", f"/api/v1/projects/{long}/conversations", {"body": body, "clientMessageId": str(uuid.uuid4())})
            messages.append(root["messages"][0]["id"])
            if index % 6 == 5:
                cls.post("kasia", f"/api/v1/projects/{long}/work", {"title": f"Check the probe in bed {index % 8 + 1} after the next frost",
                                                                   "sources": [{"type": "message", "id": root["messages"][0]["id"]}]})
        cls.ids["messages"] = messages

    @classmethod
    def tearDownClass(cls) -> None:
        for context in cls.contexts.values():
            context.close()
        cls.browser.close()
        cls.pw.stop()

    @classmethod
    def post(cls, who: str, path: str, body: dict) -> dict:
        response = cls.contexts[who].request.post(path, data=body, headers={"origin": ORIGIN})
        assert response.status in (200, 201), f"{path}: {response.status} {response.text()}"
        return response.json()

    @classmethod
    def get(cls, who: str, path: str) -> dict:
        response = cls.contexts[who].request.get(path)
        assert response.status == 200, f"{path}: {response.status} {response.text()}"
        return response.json()

    def page(self, who: str = "kasia") -> Page:
        context = self.browser.new_context(base_url=ORIGIN, locale="en-GB", timezone_id="Europe/Warsaw", storage_state=self.states[who],
                                           service_workers="block", viewport=DESKTOP, device_scale_factor=1)
        if UI_BROWSER == "chromium":
            context.grant_permissions(["clipboard-read", "clipboard-write"], origin=ORIGIN)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def tasks_in(self, project: str) -> int:
        body = self.get("piotr", f"/api/v1/projects/{project}/work")
        items = body["items"] if isinstance(body, dict) else body
        return len(items)

    def where(self, page: Page) -> dict | None:
        return page.evaluate(WHERE)

    def assert_typed_into(self, page: Page, composer: str, label: str) -> None:
        field = page.locator(f"#{composer}")
        expect(field).to_be_focused()
        expect(field).to_have_value(SENTENCE)
        expect(page.get_by_role("dialog")).to_have_count(0)
        self.assertEqual(self.tasks_in(self.ids["shared"]), 0, f"{label}: nothing typed became a task")
        field.fill("")

    # ---------------------------------------------------------------- P2 #2: arriving in a conversation

    def test_01_a_sentence_typed_at_once_after_each_arrival_lands_in_the_composer(self) -> None:
        page = self.page()
        page.goto("/")
        spaces = page.get_by_role("navigation", name="Spaces")
        messages = page.get_by_role("navigation", name="Messages")
        expect(spaces.get_by_role("link", name=re.compile(SHARED))).to_be_visible()

        # The sidebar's space.
        spaces.get_by_role("link", name=re.compile(SHARED)).click()
        page.keyboard.type(SENTENCE)
        self.assert_typed_into(page, "project-composer", "the sidebar's space")

        # New message › a person › "Message Piotr".
        page.goto("/dm/new")
        page.get_by_text("Piotr Nowak", exact=True).click()
        page.get_by_role("button", name="Message Piotr").click()
        page.keyboard.type(SENTENCE)
        expect(page).to_have_url(re.compile(r"/dm/[0-9a-f-]{36}$"))
        self.assert_typed_into(page, "dm-composer", "New message")
        shot(page, "arrival-focus-new-message")

        # The sidebar's direct message, from another place.
        spaces.get_by_role("link", name=re.compile(SHARED)).click()
        expect(page.locator("#project-composer")).to_be_focused()
        messages.get_by_role("link", name=re.compile("Piotr Nowak")).click()
        page.keyboard.type(SENTENCE)
        self.assert_typed_into(page, "dm-composer", "the sidebar's direct message")

        # A person's name in a message of the space.
        spaces.get_by_role("link", name=re.compile(SHARED)).click()
        name = page.locator(FEED).get_by_role("link", name="Piotr Nowak").first
        expect(name).to_be_visible()
        name.click()
        page.keyboard.type(SENTENCE)
        expect(page).to_have_url(re.compile(r"/dm/[0-9a-f-]{36}$"))
        self.assert_typed_into(page, "dm-composer", "a person's name")

        # Enter sends it to Piotr alone: no task anywhere, and the words are in the direct message.
        page.keyboard.type(SENTENCE)
        page.keyboard.press("Enter")
        dm = re.search(r"/dm/([0-9a-f-]{36})$", page.url).group(1)
        for _ in range(40):
            if any(message["body"] == SENTENCE for message in self.get("piotr", f"/api/v1/dms/{dm}")["messages"]):
                break
            time.sleep(0.25)
        else:
            self.fail("the message reached the direct message")
        self.assertEqual(self.tasks_in(self.ids["shared"]), 0)

    # ---------------------------------------------------------------- P2 #5: the link's place applies once

    def open_task_panel_from_a_card_in_view(self, page: Page) -> None:
        cards = page.locator(f'{FEED} .convo-notice [data-native-ref^="work:"]')
        for index in range(cards.count()):
            box = cards.nth(index).bounding_box()
            if box and 100 < box["y"] < 760:
                cards.nth(index).focus()
                page.keyboard.press("Enter")
                break
        else:
            self.fail("a task card is in view")
        expect(page.locator("#details").get_by_role("button", name=re.compile("^Status"))).to_be_visible()

    def test_02_a_link_s_place_is_not_restored_after_the_reader_moved_on(self) -> None:
        page = self.page()
        page.goto(f"/projects/{self.ids['long']}/messages/{self.ids['messages'][2]}")
        expect(page.locator(f"#message-{self.ids['messages'][2]}")).to_be_in_viewport()
        page.wait_for_timeout(1500)
        for _ in range(25):
            page.keyboard.press("Tab")
            page.wait_for_timeout(60)
        page.wait_for_timeout(600)
        read = page.evaluate(f"() => document.querySelector('{FEED}').scrollTop")
        self.assertGreater(read, 150, "Tab moved the stream on from the linked message")
        self.open_task_panel_from_a_card_in_view(page)
        opener = self.where(page)
        status = page.locator("#details").get_by_role("button", name=re.compile("^Status"))
        status.focus()
        page.keyboard.press("Enter")
        page.keyboard.press("ArrowDown")
        page.keyboard.press("Enter")
        expect(status).to_contain_text("Doing")
        page.wait_for_timeout(800)
        self.assertLess(abs(page.evaluate(f"() => document.querySelector('{FEED}').scrollTop") - read), 4, "a Status change keeps the stream")
        page.keyboard.press("Escape")
        expect(page.locator("#details")).to_be_hidden()
        page.wait_for_timeout(800)
        self.assertLess(abs(page.evaluate(f"() => document.querySelector('{FEED}').scrollTop") - read), 4, "Esc keeps the stream where the reader was")
        back = self.where(page)
        self.assertIsNotNone(back, "focus is not on the page body")
        self.assertEqual(back["name"], opener["name"], "focus is back on the card that opened the panel")
        self.assertTrue(back["top"] >= 72 and back["bottom"] <= 900, f"the card is in view: {back}")
        shot(page, "arrival-focus-link-place-kept")

    # ---------------------------------------------------------------- P2 #6: Status and Owner from the keyboard

    def test_03_a_property_picked_from_the_keyboard_keeps_focus_and_esc_closes_the_panel(self) -> None:
        page = self.page()
        page.goto(f"/projects/{self.ids['long']}")
        expect(page.locator("#project-composer")).to_be_focused()
        self.open_task_panel_from_a_card_in_view(page)
        panel = page.locator("#details")
        for label, pattern in (("Status", re.compile("^Status")), ("Owner", re.compile("^Owner"))):
            with self.subTest(property=label):
                value = panel.get_by_role("button", name=pattern)
                before = value.inner_text()
                value.focus()
                page.keyboard.press("Enter")
                expect(page.get_by_role("menu", name=label)).to_be_visible()
                page.keyboard.press("ArrowDown")
                page.keyboard.press("Enter")
                expect(page.get_by_role("menu", name=label)).to_have_count(0)
                expect(value).not_to_have_text(before)
                # While it saves, and after: focus is on the value, never the page body.
                for _ in range(6):
                    expect(value).to_be_focused()
                    page.wait_for_timeout(200)
        page.keyboard.press("Escape")
        expect(panel).to_be_hidden()
        self.assertIsNotNone(self.where(page), "closing gives focus back to the card")

    # ---------------------------------------------------------------- P3: focus after Create space, Copy link, a new task, A, a thread

    def test_04_create_space_lands_in_the_new_space_s_composer(self) -> None:
        page = self.page()
        page.goto(f"/projects/{self.ids['shared']}")
        expect(page.locator("#project-composer")).to_be_focused()
        press_shortcut(page, "c")
        dialog = page.get_by_role("dialog", name="New task")
        expect(dialog).to_be_visible()
        dialog.get_by_role("tab", name="Space").click()
        space = page.get_by_role("dialog", name="New space")
        expect(space.get_by_role("textbox", name="Space name")).to_be_focused()
        name = f"Bread rota {uuid.uuid4().hex[:4]}"
        space.get_by_role("textbox", name="Space name").fill(name)
        space.get_by_role("button", name="Create space").click()
        expect(page).to_have_url(re.compile(r"/projects/[0-9a-f-]{36}$"))
        expect(page.get_by_role("navigation", name="Spaces").get_by_role("link", name=re.compile(name))).to_be_visible()
        page.keyboard.type(SENTENCE)
        expect(page.locator("#project-composer")).to_be_focused()
        expect(page.locator("#project-composer")).to_have_value(SENTENCE)
        expect(page.get_by_role("dialog")).to_have_count(0)
        shot(page, "arrival-focus-new-space")

    def test_05_copy_link_gives_focus_back_to_more_actions(self) -> None:
        page = self.page()
        page.goto(f"/projects/{self.ids['shared']}")
        message = page.locator(f"{FEED} .project-convo__message").first
        message.hover()
        more = message.get_by_role("button", name="More actions")
        more.click()
        page.get_by_role("menuitem", name="Copy link").click()
        expect(page.get_by_role("menu")).to_have_count(0)
        expect(more).to_be_focused()

    def test_06_esc_from_a_new_task_s_panel_goes_to_its_card(self) -> None:
        page = self.page()
        page.goto(f"/projects/{self.ids['long']}")
        expect(page.locator("#project-composer")).to_be_focused()
        press_shortcut(page, "c")
        title = f"Order a spare gateway {uuid.uuid4().hex[:4]}"
        page.get_by_role("dialog", name="New task").get_by_role("textbox", name="Title").fill(title)
        page.keyboard.press("Enter")
        expect(page.locator("#details")).to_contain_text(title)
        page.keyboard.press("Escape")
        expect(page.locator("#details")).to_be_hidden()
        page.wait_for_timeout(500)
        where = self.where(page)
        self.assertIsNotNone(where, "focus is not on the page body")
        # The new task's card, or the fold of task updates it stands in.
        self.assertTrue(page.evaluate(f"() => !!document.activeElement.closest('{FEED} .convo-notice, {FEED} .convo-fold')"), f"focus is on the card: {where}")
        self.assertTrue(where["top"] >= 72 and where["bottom"] <= 900, f"the card is in view: {where}")

    def test_07_a_on_the_last_decision_leaves_focus_on_the_empty_inbox(self) -> None:
        decision = self.post("kasia", f"/api/v1/projects/{self.ids['shared']}/decisions", {"title": "Open at seven on Saturdays", "rationale": "The market starts at eight."})
        for _ in range(80):
            keys = [item["key"] for item in self.get("ola", "/api/v1/needs-you")["items"]]
            if f"decision:{decision['id']}" in keys:
                break
            time.sleep(0.25)
        else:
            self.fail("the decision reached Ola's Inbox")
        self.assertEqual(len(keys), 1, f"Ola has only the decision: {keys}")
        page = self.page("ola")
        page.goto("/inbox")
        row = page.locator(f'.nyq__list .nyc[data-key="decision:{decision["id"]}"] .nyc__open')
        expect(row).to_be_focused()
        page.keyboard.press("a")
        heading = page.get_by_role("heading", name="Nothing needs you right now")
        expect(heading).to_be_focused()

    def test_08_esc_from_a_thread_marks_its_message_plainly(self) -> None:
        page = self.page()
        page.goto(f"/projects/{self.ids['long']}")
        message = page.locator(f"#message-{self.ids['messages'][-1]}")
        expect(message).to_be_visible()
        message.focus()
        page.keyboard.press("r")
        expect(page.locator("#thread-composer")).to_be_focused()
        page.keyboard.press("Escape")
        expect(message).to_be_focused()
        outline = message.evaluate("(el) => { const b = el.querySelector(':scope > .message-bubble') || el; const s = getComputedStyle(b); return [s.outlineStyle, parseFloat(s.outlineWidth)]; }")
        self.assertEqual(outline[0], "solid", "the focused message has a ring")
        self.assertGreaterEqual(outline[1], 2)
        shot(page, "arrival-focus-thread-closed")


if __name__ == "__main__":
    unittest.main()
