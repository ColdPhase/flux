"""Browser tests for the v0.2.1 final UI audit of the conversation (train ffcb07c1b): keyboard focus in view, the task card in a thread,
and the task card's smaller rules (docs/design/final/README.md L1055-1066, L2263; WCAG 2.2 2.4.11 Focus Not Obscured).

Runs through scripts/check_ui.sh against the running Compose application, on the engine named by FLUX_UI_BROWSER (run it with chromium
and with webkit). Ada and Maja share a space with a long conversation whose task cards stand between its messages (some with an owner,
some without), a thread with a task made from a reply, and a second space with a task card and no message.

- Opened at a message (a Search result or a message link), Tab moves through the stream and every focused control is in view, at
  1440 x 900 and on an 820 x 1180 tablet: the reader's own move wins over the place the stream keeps (task cards growing as their rows
  arrive put the old place back over the focused control, 8 of 30 stops off screen in the audit).
- In a thread, a task made from a reply is the conversation's task card under that reply (state glyph, number, whole title, owner, state
  word), never a chip in the bubble with its title cut.
- With no panel at 1440 a long title keeps its room: the owner's name gives way before the title wraps.
- The card's link to its message is a 44 px touch target; a space with a task card and no message does not ask where to start; the task
  panel says its number and space without a stray comma.
"""

from __future__ import annotations

import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, start_forwarder
from test_settings import UI_BROWSER, shot

PASSWORD = "focus stays where the reader is"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ada": ("Ada Kowalska", f"ada.focus+{STAMP}@example.test"),
    "maja": ("Maja Wiśniewska-Lindqvist", f"maja.focus+{STAMP}@example.test"),
}
SPACE = "Community garden sensors"
EMPTY_SPACE = "Seed swap shelf"
LONG_TASK = "Order six capacitive moisture probes for the raised beds and test two of them on the far beds before the frost"
REPLY_TASK = "Put two probes on the far beds to test the LoRa range through the hedge"
TABLET = {"width": 820, "height": 1180}

# Where the focused element is: its box, the box of the scroller it lives in, and the window.
FOCUSED = """() => {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  let scroller = el.parentElement;
  while (scroller && scroller !== document.body) {
    const style = getComputedStyle(scroller);
    if (/(auto|scroll)/.test(style.overflowY) && scroller.scrollHeight > scroller.clientHeight) break;
    scroller = scroller.parentElement;
  }
  const box = el.getBoundingClientRect();
  const view = scroller && scroller !== document.body ? scroller.getBoundingClientRect() : { top: 0, bottom: innerHeight };
  return { name: (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 60), top: box.top, bottom: box.bottom,
           viewTop: Math.max(0, view.top), viewBottom: Math.min(innerHeight, view.bottom), height: innerHeight, scrollTop: scroller ? scroller.scrollTop : 0 };
}"""


class StreamFocusAndCards(unittest.TestCase):
    """Tests run in name order and share the accounts and the places."""

    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        assert cls.browser.browser_type.name == UI_BROWSER
        print(f"ACTUAL_UI_ENGINE={cls.browser.browser_type.name}", flush=True)
        expect.set_options(timeout=10000)
        cls.api_contexts: dict[str, BrowserContext] = {}
        for key, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(base_url=ORIGIN, service_workers="block")
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.states[key] = context.storage_state()
            cls.api_contexts[key] = context
        workspace = cls.post("ada", "/api/v1/workspaces", {"name": "Riverside Makers"})["id"]
        cls.post("ada", f"/api/v1/workspaces/{workspace}/members", {"email": PEOPLE["maja"][1], "role": "member"})
        pid = cls.post("ada", f"/api/v1/workspaces/{workspace}/projects", {"name": SPACE, "visibility": "workspace"})["id"]
        cls.ids["project"] = pid
        # A long conversation whose task cards stand between its messages: every sixth message becomes a task, owned by Maja or by nobody,
        # so the cards change as their rows arrive while the reader moves through them.
        messages: list[dict] = []
        tasks: list[str] = []
        for index in range(32):
            who = "ada" if index % 3 else "maja"
            body = (f"Bed {index % 8 + 1}, reading {index + 1}: the soil probe there says {20 + index}% this morning and the gateway relayed "
                    "every reading without a gap, so the overnight frost did not reach the roots.")
            root = cls.post(who, f"/api/v1/projects/{pid}/conversations", {"body": body, "clientMessageId": str(uuid.uuid4())})
            messages.append(root["messages"][0])
            if index % 6 == 5:
                owner = {"owner": {"kind": "human", "id": cls.ids["maja"]}} if index % 12 == 5 else {}
                title = LONG_TASK if index == 11 else f"Check the probe in bed {index % 8 + 1} after the next frost and note its reading"
                tasks.append(cls.post("ada", f"/api/v1/projects/{pid}/work", {"title": title, "sources": [{"type": "message", "id": root["messages"][0]["id"]}], **owner})["id"])
        cls.ids["messages"] = [message["id"] for message in messages]
        cls.ids["long_task"] = tasks[1]
        # A thread: a root, Maja's reply, and a task made from that reply.
        thread_root = messages[20]
        reply = cls.post("maja", f"/api/v1/conversations/{thread_root['conversationId']}/messages",
                         {"body": "Then let us put two on the far beds to see how far the LoRa signal reaches through the hedge.", "clientMessageId": str(uuid.uuid4())})
        cls.ids["thread"] = thread_root["conversationId"]
        cls.ids["reply"] = reply["id"]
        cls.ids["reply_task"] = cls.post("ada", f"/api/v1/projects/{pid}/work", {"title": REPLY_TASK, "sources": [{"type": "message", "id": reply["id"]}],
                                                                              "owner": {"kind": "human", "id": cls.ids["ada"]}})["id"]
        # A space with a task and no message.
        empty = cls.post("ada", f"/api/v1/workspaces/{workspace}/projects", {"name": EMPTY_SPACE, "visibility": "workspace"})["id"]
        cls.ids["empty_project"] = empty
        cls.ids["empty_task"] = cls.post("ada", f"/api/v1/projects/{empty}/work", {"title": "Label the seed jars by year"})["id"]

    @classmethod
    def tearDownClass(cls) -> None:
        for context in cls.api_contexts.values():
            context.close()
        cls.browser.close()
        cls.pw.stop()

    @classmethod
    def post(cls, who: str, path: str, body: dict) -> dict:
        response = cls.api_contexts[who].request.post(path, data=body, headers={"origin": ORIGIN})
        assert response.status in (200, 201), f"{path}: {response.status} {response.text()}"
        return response.json()

    def page(self, who: str = "ada", *, viewport: dict | None = None, touch: bool = False, dark: bool = False) -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": "dark" if dark else "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw",
                         "storage_state": self.states[who], "service_workers": "block", "viewport": viewport or DESKTOP}
        if touch:
            options.update(device_scale_factor=3, is_mobile=UI_BROWSER == "chromium", has_touch=True)
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def notice(self, page: Page, work_id: str):
        return page.locator(f'.convo-notice[data-work-id="{work_id}"]')

    # ---------------------------------------------------------------- keyboard focus

    def test_01_tab_through_a_conversation_opened_at_a_message_keeps_every_focused_control_in_view(self) -> None:
        target = self.ids["messages"][13]
        for viewport in (DESKTOP, TABLET):
            with self.subTest(viewport=viewport):
                page = self.page(viewport=viewport)
                page.goto(f"/projects/{self.ids['project']}/messages/{target}")
                expect(page.locator(f"#message-{target}")).to_be_in_viewport()
                expect(page.locator(".project-convo__feed.is-stream")).to_have_attribute("data-references-phase", "ready")
                page.wait_for_timeout(1500)
                stops, hidden = [], []
                for _ in range(30):
                    page.keyboard.press("Tab")
                    page.wait_for_timeout(200)
                    where = page.evaluate(FOCUSED)
                    if where is None:
                        continue
                    stops.append(where)
                    # A control is in view when it is wholly inside its scroller and the window (1 px for rounding).
                    if where["top"] < where["viewTop"] - 1 or where["bottom"] > where["viewBottom"] + 1:
                        hidden.append(where)
                self.assertGreaterEqual(len(stops), 25, "Tab moved through the stream")
                self.assertEqual(hidden, [], f"{viewport['width']} x {viewport['height']}: every focused control is in view")

    # ---------------------------------------------------------------- the task card in a thread

    def test_02_in_a_thread_a_task_made_from_a_reply_is_its_card_under_that_reply(self) -> None:
        for viewport, touch in ((DESKTOP, False), (PHONE, True)):
            with self.subTest(viewport=viewport):
                page = self.page(viewport=viewport, touch=touch)
                page.goto(f"/projects/{self.ids['project']}/conversations/{self.ids['thread']}")
                reply = page.locator(f".thread__feed #message-{self.ids['reply']}")
                expect(reply).to_be_visible()
                card = reply.locator(f'.msg-tasks__card[data-work-id="{self.ids["reply_task"]}"]')
                expect(card).to_be_visible()
                # The conversation's card: the state glyph, the number, the whole title, the owner's face and the state word.
                expect(card.locator(".ui-glyph, svg").first).to_be_visible()
                expect(card.locator(".convo-notice__num")).to_have_text(re.compile(r"^#\d+$"))
                expect(card.locator(".convo-notice__title")).to_have_text(REPLY_TASK)
                expect(card.locator(".convo-notice__owner .ui-avatar")).to_be_visible()
                expect(card.locator(".convo-notice__state")).to_have_text("To do")
                # It is under the bubble, not inside it, and the bubble carries no chip of it.
                expect(reply.locator(".message-bubble .ws-chip")).to_have_count(0)
                expect(reply.locator(".message-bubble .msg-tasks__card")).to_have_count(0)
                bubble = reply.locator(".message-bubble").first.bounding_box()
                box = card.bounding_box()
                assert bubble and box
                self.assertGreaterEqual(box["y"], bubble["y"] + bubble["height"] - 1, "the card is under the reply")
                title = card.locator(".convo-notice__title")
                if not touch:
                    # Whole on a computer: nothing of it is cut.
                    self.assertTrue(title.evaluate("el => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1"), "the whole title shows")
                shot(page, f"thread-task-card-{viewport['width']}")
                # It opens the task in the one panel.
                card.locator(".convo-notice__task").click()
                details = page.locator("#details")
                expect(details).to_contain_text(REPLY_TASK)

    # ---------------------------------------------------------------- the owner's name gives way

    def test_03_with_no_panel_the_owner_name_gives_way_before_a_long_title_wraps(self) -> None:
        page = self.page()
        page.goto(f"/projects/{self.ids['project']}/messages/{self.ids['messages'][11]}")
        card = self.notice(page, self.ids["long_task"])
        expect(card.locator(".convo-notice__owner")).to_be_visible()
        card.scroll_into_view_if_needed()
        found = card.evaluate("""(card) => {
          const title = card.querySelector('.convo-notice__title');
          const owner = card.querySelector('.convo-notice__owner');
          const name = card.querySelector('.convo-notice__owner-name');
          const lines = Math.round(title.getBoundingClientRect().height / parseFloat(getComputedStyle(title).lineHeight));
          const ob = owner.getBoundingClientRect(), nb = name.getBoundingClientRect();
          const nameShown = getComputedStyle(name).display !== 'none' && nb.width > 0 && nb.top < ob.bottom - 1 && nb.bottom <= ob.bottom + 1;
          return { lines, nameShown, cut: title.scrollHeight > title.clientHeight + 1, width: card.getBoundingClientRect().width };
        }""")
        self.assertGreater(found["width"], 500, f"the card has the stream's width with no panel: {found}")
        self.assertFalse(found["cut"], f"the title is whole: {found}")
        self.assertFalse(found["lines"] > 1 and found["nameShown"], f"the owner's name gives way before the title wraps: {found}")
        shot(page, "task-card-owner-gives-way-1440")

    # ---------------------------------------------------------------- the card's link on touch

    def test_04_the_cards_link_to_its_message_is_a_44_px_touch_target(self) -> None:
        for viewport in (PHONE, TABLET):
            with self.subTest(viewport=viewport):
                page = self.page(viewport=viewport, touch=True)
                page.goto(f"/projects/{self.ids['project']}/messages/{self.ids['messages'][11]}")
                link = self.notice(page, self.ids["long_task"]).locator("button.convo-notice__src")
                expect(link).to_be_visible()
                box = link.bounding_box()
                assert box
                self.assertGreaterEqual(box["height"], 44, f"{viewport['width']}: the link is 44 px tall ({box['height']:.1f})")

    # ---------------------------------------------------------------- an empty conversation

    def test_05_a_space_with_a_task_card_and_no_message_does_not_ask_where_to_start(self) -> None:
        page = self.page()
        page.goto(f"/projects/{self.ids['empty_project']}")
        expect(self.notice(page, self.ids["empty_task"])).to_be_visible()
        expect(page.get_by_role("heading", name="Where do we start?")).to_have_count(0)

    # ---------------------------------------------------------------- the task panel's words

    def test_06_the_task_panel_says_its_number_and_space_without_a_stray_comma(self) -> None:
        page = self.page()
        page.goto(f"/projects/{self.ids['project']}/tasks?open=work:{self.ids['long_task']}")
        ref = page.locator("#details .wd__ref")
        expect(ref).to_be_visible()
        # What a screen reader reads: the text without what is hidden from it.
        spoken = ref.evaluate("""(el) => {
          const walk = (node) => node.nodeType === 3 ? node.textContent : node.nodeType === 1 && node.getAttribute('aria-hidden') !== 'true' ? [...node.childNodes].map(walk).join('') : '';
          return walk(el).replace(/\\s+/g, ' ').trim();
        }""")
        self.assertRegex(spoken, rf"^#\d+ in {SPACE}$")


if __name__ == "__main__":
    unittest.main()
