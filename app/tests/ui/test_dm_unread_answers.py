"""Two founder decisions of 2026-11-14 on #1424, in the running application (Chromium and WebKit):

1. An answer to your question reaches you. Piotr asks Marta something in a space; her answer in the thread lands in Piotr's Inbox as
   "Reply · Marta · Corner shop", titled by what she wrote, with Reply and Done.
2. Direct messages have an unread state. A conversation with a message Marta has not read has its name in bold in the sidebar's Messages and
   on the phone's Spaces tab, as an unread space; it is read once she has seen it, on her other device too, a new message makes it bold again
   live, and Mark all as read clears it with Undo.

The people are real accounts of the stack's one company (check_ui.sh sets it up, company_setup.py). Run once per engine:
`FLUX_UI_BROWSER=chromium|webkit ./scripts/check_ui.sh test_dm_unread_answers`.
"""
from __future__ import annotations

import re
import time
import unittest
import uuid

from playwright.sync_api import BrowserContext, Page, expect, sync_playwright

from test_app_shell import ORIGIN, UI_BROWSER, UPSTREAM, shot, start_forwarder
from test_work_pagination import api

PASSWORD = "an answer reaches the one who asked"
SPACE = "Corner shop"
BOLD = re.compile(r"\bis-unread\b")
# The page's sockets, so a test can drop them. While `__refuse` is set a new one asks for an address the server does not serve and never opens;
# while `__drop` is set the page is never told of a sent message (a connection that missed it, as one whose cursor was refused does). `__frames`
# is what the sockets were sent.
SOCKETS = """(() => {
  const Native = window.WebSocket;
  window.__sockets = [];
  window.__frames = [];
  window.__refuse = false;
  window.__drop = false;
  window.WebSocket = class extends Native {
    constructor(url, protocols) {
      const address = new URL(url);
      if (window.__refuse) address.pathname = '/api/v1/__refused__';
      super(address, protocols);
      window.__sockets.push(this);
    }
    set onmessage(handler) {
      super.onmessage = handler && ((event) => {
        const text = String(event.data);
        window.__frames.push(text);
        if (window.__drop && text.includes('dm.message_sent.v1')) return;
        handler.call(this, event);
      });
    }
    get onmessage() { return super.onmessage; }
  };
})();"""


class AnswersAndUnreadMessages(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        print(f"ACTUAL_UI_ENGINE={cls.browser.browser_type.name}", flush=True)
        expect.set_options(timeout=12000)
        stamp = uuid.uuid4().hex[:8]
        owner = cls.browser.new_context(base_url=ORIGIN, service_workers="block")
        api(owner, "POST", "/api/auth/sign-in/email", {"email": "company-setup@example.test", "password": "company setup for the checks"})
        cls.company = next(item["id"] for item in api(owner, "GET", "/api/v1/workspaces") if item.get("company"))
        cls.people: dict[str, BrowserContext] = {}
        cls.ids: dict[str, str] = {}
        cls.states: dict[str, dict] = {}
        for key, name in (("marta", "Marta Lis"), ("piotr", "Piotr Nowak")):
            context = cls.browser.new_context(base_url=ORIGIN, service_workers="block")
            email = f"answers-{key}-{stamp}@example.test"
            api(context, "POST", "/api/auth/sign-up/email", {"name": name, "email": email, "password": PASSWORD})
            api(owner, "POST", f"/api/v1/workspaces/{cls.company}/members", {"email": email, "role": "member"}, 201)
            cls.ids[key] = api(context, "GET", "/api/v1/me")["user"]["id"]
            cls.people[key] = context
            cls.states[key] = context.storage_state()
        cls.space = api(owner, "POST", f"/api/v1/workspaces/{cls.company}/projects", {"name": SPACE, "visibility": "restricted"}, 201)["id"]
        for key in ("marta", "piotr"):
            api(owner, "POST", f"/api/v1/projects/{cls.space}/grants", {"principal": {"kind": "human", "id": cls.ids[key]}, "role": "contributor"}, 201)
        owner.close()
        cls.dm = api(cls.people["piotr"], "POST", f"/api/v1/workspaces/{cls.company}/dms", {"participantIds": [cls.ids["marta"]]}, 201)["id"]

    @classmethod
    def tearDownClass(cls):
        for context in cls.people.values():
            context.close()
        cls.browser.close()
        cls.pw.stop()

    # ------------------------------------------------------------------ helpers
    def open(self, who: str, url: str = "/", *, phone: bool = False, script: str | None = None) -> Page:
        options: dict = {"base_url": ORIGIN, "storage_state": self.states[who], "locale": "en-GB", "service_workers": "block",
                         "viewport": {"width": 390, "height": 844} if phone else {"width": 1440, "height": 900}}
        if phone:
            options.update(is_mobile=True, has_touch=True)
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        if script:
            context.add_init_script(script)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught browser errors"))
        page.goto(url)
        expect(page.locator("#content")).to_be_visible()
        return page

    def say(self, text: str) -> dict:
        return api(self.people["piotr"], "POST", f"/api/v1/dms/{self.dm}/messages", {"body": text, "clientMessageId": str(uuid.uuid4())}, 201)

    def unread(self) -> int:
        """What the server says of the conversation for Marta."""
        page = api(self.people["marta"], "GET", f"/api/v1/workspaces/{self.company}/dms?limit=100")
        return next(item for item in page["items"] if item["id"] == self.dm)["unread"]

    def until(self, read, expected, timeout: float = 12.0) -> None:
        end = time.time() + timeout
        while (value := read()) != expected and time.time() < end:
            time.sleep(0.2)
        self.assertEqual(value, expected)

    def sidebar_dm(self, page: Page):
        return page.locator("nav[aria-labelledby='side-dms'] a.side__dm").filter(has_text="Piotr Nowak")

    def phone_dm(self, page: Page):
        return page.locator("ul[aria-label='Conversations'] a").filter(has_text="Piotr Nowak")

    # ------------------------------------------------------------------ decision 10
    def test_1_a_direct_message_is_bold_until_read_on_every_device_and_mark_all_as_read_clears_it(self):
        first = self.say("The new shelf came today")
        computer = self.open("marta")
        row = self.sidebar_dm(computer)
        expect(row).to_have_class(BOLD)
        expect(row).to_have_attribute("aria-label", "Piotr Nowak, new messages")
        self.assertEqual(row.evaluate("(a) => getComputedStyle(a).fontWeight"), "600", "unread is semibold, as a space")
        phone = self.open("marta", "/projects", phone=True)
        expect(self.phone_dm(phone)).to_have_class(BOLD)
        self.assertEqual(self.phone_dm(phone).locator(".set-row__t").evaluate("(el) => getComputedStyle(el).fontWeight"), "600")
        shot(phone, "1424-dm-unread-phone-spaces-390")
        shot(computer, "1424-dm-unread-sidebar-1440")

        # Marta reads it on the computer: it is read there at once, on the server once she has seen it, and on the phone after a reload.
        row.click()
        expect(computer).to_have_url(re.compile(f"/dm/{self.dm}"))
        expect(computer.locator(f"[data-message-id='{first['id']}']")).to_be_visible()
        expect(row).not_to_have_class(BOLD)
        self.until(self.unread, 0)
        computer.get_by_role("navigation", name="Places").get_by_role("link", name="Home").click()
        expect(computer).to_have_url(re.compile(r"/$"))
        expect(self.sidebar_dm(computer)).not_to_have_class(BOLD)
        self.assertEqual(self.sidebar_dm(computer).evaluate("(a) => getComputedStyle(a).fontWeight"), "500", "read keeps the quiet weight")
        phone.reload()
        expect(self.phone_dm(phone)).not_to_have_class(BOLD)

        # A new message makes it bold again in the open tab, without a reload.
        self.say("Can you put the prices on it?")
        expect(self.sidebar_dm(computer)).to_have_class(BOLD)

        # Mark all as read clears it on both devices; Undo brings it back.
        computer.get_by_role("button", name="More for Spaces", exact=True).click()
        computer.get_by_role("menuitem", name="Mark all as read", exact=True).click()
        toast = computer.locator(".ui-toast").filter(has_text="Marked all as read")
        expect(toast).to_be_visible()
        expect(self.sidebar_dm(computer)).not_to_have_class(BOLD)
        self.until(self.unread, 0)
        phone.reload()
        expect(self.phone_dm(phone)).not_to_have_class(BOLD)
        toast.get_by_role("button", name="Undo").click()
        expect(self.sidebar_dm(computer)).to_have_class(BOLD)
        self.until(self.unread, 1)

    def test_1b_a_reconnect_that_replays_nothing_shows_what_came_in_the_conversation_just_left(self):
        # Pre-review P3: the conversation just left stays read until a message arrives in it, and a reconnect that cannot replay (its cursor is
        # refused) brings no message event, so it stayed read although one had come: the list read after the reconnect is the person's now.
        self.say("Is the new shelf level?")
        marta = self.open("marta", script=SOCKETS)
        row = self.sidebar_dm(marta)
        self.say("It is on the wall now.")
        expect(row).to_have_class(BOLD)
        row.click()
        expect(marta).to_have_url(re.compile(f"/dm/{self.dm}"))
        expect(marta.locator(".dm-msg__body", has_text="It is on the wall now.")).to_be_visible()
        self.until(self.unread, 0)
        marta.get_by_role("navigation", name="Places").get_by_role("link", name="Home").click()
        expect(marta).to_have_url(re.compile(r"/$"))
        expect(row).not_to_have_class(BOLD)
        marta.wait_for_timeout(1500)
        # Her connection drops and the server refuses to resume it; a message comes in while it is down, and nothing replays it.
        marta.evaluate("() => { window.__refuse = true; window.__drop = true; window.__sockets.forEach((socket) => socket.close()); }")
        self.say("Can you put the prices on it?")
        marta.wait_for_timeout(2000)
        expect(row).not_to_have_class(BOLD)
        marta.evaluate("() => { window.__refuse = false; window.dispatchEvent(new Event('online')); }")
        try:
            expect(row).to_have_class(BOLD)
        except AssertionError:
            self.fail(f"still read after the reconnect; frames: {marta.evaluate('() => window.__frames.slice(-6)')}")

    # ------------------------------------------------------------------ decision 1
    def test_2_an_answer_to_your_question_lands_in_the_askers_inbox(self):
        piotr, marta = self.people["piotr"], self.people["marta"]
        asked = api(piotr, "POST", f"/api/v1/projects/{self.space}/conversations", {"body": "@Marta Lis can you send a photo of the shelf?", "clientMessageId": str(uuid.uuid4())}, 201)
        # Marta's Reply from her Inbox is a reply in the question's thread.
        self.until(lambda: any(asked["id"] in item["url"] for item in api(marta, "GET", "/api/v1/needs-you")["items"]), True)
        answer = api(marta, "POST", f"/api/v1/conversations/{asked['id']}/messages", {"body": "Here it is, the left side is done.", "clientMessageId": str(uuid.uuid4())}, 201)
        self.until(lambda: any(item["url"].endswith(f"#message-{answer['id']}") for item in api(piotr, "GET", "/api/v1/needs-you")["items"]), True)

        page = self.open("piotr", "/inbox")
        reply = page.get_by_label(re.compile(r"^Reply from Marta Lis in Corner shop: Here it is, the left side is done\.")).first
        expect(reply).to_be_visible()
        expect(page.get_by_text("Here it is, the left side is done.").first).to_be_visible()
        shot(page, "1424-answer-in-askers-inbox-1440")
        # Home's Waiting for you names it the same way.
        home = self.open("piotr", "/")
        expect(home.get_by_text(re.compile(r"Reply · Marta Lis · Corner shop")).first).to_be_visible()

    def test_3_an_answer_reaches_whoever_asked_even_when_the_question_names_nobody(self):
        # personas-26 P2 #1: Piotr asks Marta by name; her answer asks back without a name ("Do I need a key?") and reached Piotr's Inbox as
        # a question. His answer, from the Inbox with R, reached her only as a plain reply, which the Inbox does not show.
        piotr, marta = self.people["piotr"], self.people["marta"]
        asked = api(piotr, "POST", f"/api/v1/projects/{self.space}/conversations", {"body": "Marta, can you start at 6:00 on Monday?", "clientMessageId": str(uuid.uuid4())}, 201)
        self.until(lambda: any(asked["id"] in item["url"] for item in api(marta, "GET", "/api/v1/needs-you")["items"]), True)
        back = api(marta, "POST", f"/api/v1/conversations/{asked['id']}/messages", {"body": "Yes, I can be there at 6. Do I need a key?", "clientMessageId": str(uuid.uuid4())}, 201)
        self.until(lambda: any(item["url"].endswith(f"#message-{back['id']}") for item in api(piotr, "GET", "/api/v1/needs-you")["items"]), True)

        page = self.open("piotr", "/inbox")
        row = page.locator(".nyc", has_text="Do I need a key?")
        expect(row).to_have_count(1)
        row.locator(".nyc__open").click()
        expect(row).to_have_attribute("aria-current", "true")
        page.keyboard.press("r")
        answer = "No, the back door code is 4512."
        page.keyboard.type(answer, delay=20)
        page.keyboard.press("Enter")
        self.until(lambda: any(item["title"] == answer for item in api(marta, "GET", "/api/v1/needs-you")["items"]), True)

        phone = self.open("marta", "/inbox", phone=True)
        expect(phone.get_by_label(re.compile(rf"^Reply from Piotr Nowak in Corner shop: {re.escape(answer)}")).first).to_be_visible()
        shot(phone, f"1424-answer-without-name-phone-{UI_BROWSER}")

    # ------------------------------------------------------------------ decision A (2026-11-15)
    def test_4_a_question_between_two_people_reaches_the_other_without_a_name(self):
        # personas-30 P2 1: "When do I get my apron?" in Piotr's DM to Marta never reached her Inbox; only a question opening with her name did.
        piotr, marta = self.people["piotr"], self.people["marta"]
        question = "When do I get my apron?"
        asked = self.say(question)
        self.until(lambda: any(item["url"].endswith(f"#message-{asked['id']}") for item in api(marta, "GET", "/api/v1/needs-you")["items"]), True)

        page = self.open("marta", "/inbox")
        row = page.locator(".nyc", has_text=question)
        expect(row).to_have_count(1)
        expect(row.locator(".nyc__eyebrow--row")).to_have_text("Question · Piotr Nowak")
        shot(page, f"1424-a-pair-dm-question-inbox-{UI_BROWSER}")
        # Her answer in the conversation takes it out of her Inbox, and it reaches Piotr as a Reply (decision 1).
        answer = "On Friday, at the hall."
        sent = api(marta, "POST", f"/api/v1/dms/{self.dm}/messages", {"body": answer, "clientMessageId": str(uuid.uuid4())}, 201)
        self.until(lambda: any(item["url"].endswith(f"#message-{asked['id']}") for item in api(marta, "GET", "/api/v1/needs-you")["items"]), False)
        page.reload()
        expect(page.locator(".nyc", has_text=question)).to_have_count(0)
        self.until(lambda: any(item["url"].endswith(f"#message-{sent['id']}") for item in api(piotr, "GET", "/api/v1/needs-you")["items"]), True)
        inbox = self.open("piotr", "/inbox")
        expect(inbox.get_by_label(re.compile(rf"^Reply from Marta Lis: {re.escape(answer)}")).first).to_be_visible()


if __name__ == "__main__":
    unittest.main()
