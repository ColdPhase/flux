"""Browser tests for replying from the Inbox and for leaving a closed thread (v0.2.1 release gate, C-1/E-2 and A-1).

C-1/E-2 (computer): Inbox › Reply opened the space with its thread, but focus stayed on the message the link named, so what the person
typed next went to single-key shortcuts: "Sure, I can do it by Friday." became "e, I can do it by Friday." (R replied), and "can you…"
opened Create (C) and the rest became a task. The same happened when a thread was opened from its "1 reply". Reply, and opening a thread
on a computer, put focus in the reply field and keep it there; no single key is a shortcut while focus is in, or on its way to, a field.

A-1 (phone): Inbox › Reply › × › the header's "‹" opened the thread again, without end. Closing a thread the Inbox opened goes back to the
Inbox (personas-33 P2 1); one opened from the stream is one step back, and Back then leaves the conversation as the header promises. Neither
reopens what was just closed.

The engine is FLUX_UI_BROWSER (chromium or webkit). Screenshots (reply-focus-*.png) go to FLUX_UI_SCREENSHOTS when set.
"""

from __future__ import annotations

import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, shot, start_forwarder

PASSWORD = "a reply goes where it is typed"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ada": ("Ada Kowalska", f"ada.rf+{STAMP}@example.test"),
    "jonas": ("Jonas Berg", f"jonas.rf+{STAMP}@example.test"),
}
# What Jonas asks Ada: in a root of the stream, in a reply of a thread, and three more roots for the phone (each Reply answers its own).
IN_ROOT = "can you take the stall on Saturday morning?"
IN_THREAD = "could you bring the folding table too?"
PHONE_ASKS = ["is the gazebo still at your brother's?", "do we have enough price tags?", "who keeps the cash box?"]
# Two more for R in the Inbox (#1424 persona round, P2 #4): R replies to the open one, and the other stays untouched.
R_ASKS = ["can you lock the shed after the market?", "could you print the price list?"]
# Questions nobody has answered yet, opened from the Inbox (personas-34 P2 1): one in the space (R_ASKS[1]) and one in a direct message.
DM_ASK = "Do you still have the key to the cash box?"
THREAD_ROOT = "The stall needs a table, a gazebo and a price board."
STREAM_ROOT = "Electricity at the stall: the town decides on Monday."
STREAM_REPLY = "I asked them on Friday, no answer yet."
# What the person types at once after Reply: the letters of the sentences are the app's single keys (S, R, E, C, T, A, Z, G, I).
SENTENCES = {
    "root": "Sure, I can do it by Friday.",
    "thread": "can you check it fits in the car? Then yes.",
    "replies": "can you also ask the town about a socket? Thanks.",
}


class ReplyFocus(unittest.TestCase):
    pw = None
    browser: Browser
    contexts: dict[str, BrowserContext] = {}
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}
    phone: dict[str, str] = {}
    r_asks: dict[str, str] = {}

    @classmethod
    def post(cls, who: str, path: str, body: dict) -> dict:
        response = cls.contexts[who].request.post(path, data=body, headers={"origin": ORIGIN})
        assert response.status in (200, 201), f"{path}: {response.status} {response.text()}"
        return response.json()

    @classmethod
    def get(cls, path: str) -> dict:
        response = cls.contexts["ada"].request.get(path)
        assert response.status == 200, f"{path}: {response.status} {response.text()}"
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
        workspace = cls.post("ada", "/api/v1/workspaces", {"name": "Riverside Makers"})["id"]
        cls.post("ada", f"/api/v1/workspaces/{workspace}/members", {"email": PEOPLE["jonas"][1], "role": "member"})
        project = cls.post("ada", f"/api/v1/workspaces/{workspace}/projects", {"name": "Spring market stall", "visibility": "workspace"})["id"]
        start = lambda who, body: cls.post(who, f"/api/v1/projects/{project}/conversations", {"body": body, "clientMessageId": str(uuid.uuid4())})  # noqa: E731
        reply = lambda who, cid, body: cls.post(who, f"/api/v1/conversations/{cid}/messages", {"body": body, "clientMessageId": str(uuid.uuid4())})  # noqa: E731
        stream = start("ada", STREAM_ROOT)
        reply("jonas", stream["id"], STREAM_REPLY)
        thread = start("ada", THREAD_ROOT)
        reply("jonas", thread["id"], f"@Ada Kowalska {IN_THREAD}")
        root = start("jonas", f"@Ada Kowalska {IN_ROOT}")
        phone = {ask: start("jonas", f"@Ada Kowalska {ask}")["id"] for ask in PHONE_ASKS}
        cls.r_asks = {ask: start("jonas", f"@Ada Kowalska {ask}")["id"] for ask in R_ASKS}
        cls.ids["dm"] = cls.post("jonas", f"/api/v1/workspaces/{workspace}/dms", {"participantIds": [cls.ids["ada"]]})["id"]
        cls.post("jonas", f"/api/v1/dms/{cls.ids['dm']}/messages", {"body": DM_ASK, "clientMessageId": str(uuid.uuid4())})
        cls.ids.update(project=project, stream=stream["id"], stream_root=stream["messages"][0]["id"], thread=thread["id"], root=root["id"])
        cls.phone = phone
        for key, context in cls.contexts.items():
            cls.states[key] = context.storage_state()
        # The worker writes the notifications shortly after the messages.
        for _ in range(120):
            titles = " ".join(item["title"] for item in cls.get("/api/v1/needs-you")["items"])
            if all(ask in titles for ask in [IN_ROOT, IN_THREAD, *PHONE_ASKS, *R_ASKS, DM_ASK]):
                break
            time.sleep(0.25)
        else:
            raise AssertionError("the mentions reached Ada's Inbox")

    @classmethod
    def tearDownClass(cls) -> None:
        for context in cls.contexts.values():
            context.close()
        cls.browser.close()
        cls.pw.stop()

    def page(self, *, phone: bool = False) -> Page:
        options: dict = {"base_url": ORIGIN, "locale": "en-GB", "timezone_id": "Europe/Warsaw", "storage_state": self.states["ada"]}
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

    def thread(self, page: Page):
        return page.get_by_role("complementary", name="Replies").or_(page.get_by_role("dialog", name="Replies"))

    def tasks(self) -> int:
        return len(self.get(f"/api/v1/projects/{self.ids['project']}/work?limit=100")["items"])

    def bodies(self, conversation_id: str) -> list[str]:
        return [message["body"] for message in self.get(f"/api/v1/conversations/{conversation_id}")["messages"]]

    def reply_from_inbox(self, page: Page, asked: str) -> None:
        """Inbox › the item › Reply. On a computer the row opens the item in the right column; on a phone the card carries Reply."""
        page.goto("/inbox")
        row = page.locator(".nyc", has_text=asked)
        expect(row).to_have_count(1)
        if page.viewport_size["width"] > 1000:
            row.locator(".nyc__open").click()
            pane = page.locator(".nyc--open")
            expect(pane).to_contain_text(asked)
            pane.get_by_role("button", name="Reply", exact=True).click()
        else:
            row.get_by_role("button", name="Reply", exact=True).first.click()

    def type_at_once(self, page: Page, conversation_id: str, sentence: str) -> None:
        """Types the sentence as soon as the reply field shows, a key at a time, then sends it: exactly the sentence is the reply, and nothing else happened."""
        before = self.tasks()
        field = self.thread(page).get_by_label("Reply", exact=True)
        expect(field).to_be_visible()
        page.keyboard.type(sentence, delay=35)
        expect(field, "every key went into the reply field").to_have_value(sentence)
        expect(page.get_by_role("dialog", name=re.compile(r"^New "))).to_have_count(0)
        page.keyboard.press("Enter")
        expect(self.thread(page).locator(".project-convo__message", has_text=sentence)).to_be_visible()
        # The reply shows at once and is stored a moment later: its body is exactly what was typed.
        for _ in range(80):
            if sentence in self.bodies(conversation_id):
                break
            time.sleep(0.25)
        self.assertEqual(self.bodies(conversation_id)[-1], sentence, "the reply is exactly what was typed")
        self.assertEqual(self.tasks(), before, "no task was made from the typing")

    # ---------------------------------------------------------------- C-1 / E-2: the computer

    def test_01_typing_right_after_inbox_reply_is_the_reply(self) -> None:
        # The mention is a root of the stream: the link names it, and the stream marks it, but the reply field has the focus.
        page = self.page()
        self.reply_from_inbox(page, IN_ROOT)
        expect(page).to_have_url(re.compile(rf"/projects/{self.ids['project']}/conversations/{self.ids['root']}"))
        self.type_at_once(page, self.ids["root"], SENTENCES["root"])
        expect(self.thread(page).get_by_label("Reply", exact=True)).to_be_focused()
        shot(page, f"reply-focus-inbox-reply-1440-{UI_BROWSER}")

    def test_02_typing_right_after_inbox_reply_to_a_reply_is_the_reply(self) -> None:
        # The mention is a reply in a thread: the thread opens on it, and the reply field keeps the focus.
        page = self.page()
        self.reply_from_inbox(page, IN_THREAD)
        expect(page).to_have_url(re.compile(rf"/conversations/{self.ids['thread']}#message-"))
        self.type_at_once(page, self.ids["thread"], SENTENCES["thread"])

    def test_03_typing_right_after_opening_a_thread_from_its_replies_is_the_reply(self) -> None:
        page = self.page()
        page.goto(f"/projects/{self.ids['project']}")
        root = page.locator(f"#message-{self.ids['stream_root']}")
        expect(root).to_be_visible()
        root.get_by_role("button", name=re.compile(r"^1 reply")).click()
        expect(page).to_have_url(re.compile(rf"/conversations/{self.ids['stream']}$"))
        self.type_at_once(page, self.ids["stream"], SENTENCES["replies"])

    # ---------------------------------------------------------------- A-1: the phone

    def test_04_phone_back_after_closing_a_thread_leaves_the_conversation(self) -> None:
        page = self.page(phone=True)
        # Inbox › Reply › ×: back in the Inbox with its open item (F-026 §4, personas-33 P2 1), never the thread again.
        for ask in PHONE_ASKS[:2]:
            self.reply_from_inbox(page, ask)
            expect(page).to_have_url(re.compile(rf"/conversations/{self.phone[ask]}"))
            sheet = self.thread(page)
            expect(sheet).to_be_visible()
            sheet.get_by_role("button", name="Close replies").click()
            expect(sheet).to_have_count(0)
            expect(page).to_have_url(re.compile(r"/inbox$"))
            shot(page, f"reply-focus-phone-closed-390-{UI_BROWSER}")
            page.wait_for_timeout(400)
            expect(self.thread(page)).to_have_count(0)
        # A thread opened from its replies in the stream: × is one step back, and Back then leaves the space for the list of spaces.
        page.goto(f"/projects/{self.ids['project']}")
        page.locator(f"#message-{self.ids['stream_root']}").get_by_role("button", name=re.compile(r"^\d+ repl")).click()
        expect(self.thread(page)).to_be_visible()
        self.thread(page).get_by_role("button", name="Close replies").click()
        expect(self.thread(page)).to_have_count(0)
        page.locator("header.phead").get_by_role("button", name=re.compile(r"^Back")).click()
        expect(page).to_have_url(re.compile(r"/projects$"))
        expect(self.thread(page)).to_have_count(0)

    # ---------------------------------------------------------------- R in the Inbox (#1424 persona round, P2 #4)

    def test_05_r_in_the_inbox_replies_and_what_follows_is_the_reply(self) -> None:
        # Shortcuts says "R · Reply in thread". In the Inbox R did nothing, and the reply typed next ran the Inbox's keys: "Sure" put the open
        # item off (S) and marked the next one done (E), and both silently left the Inbox.
        page = self.page()
        asked, other = R_ASKS
        page.goto("/inbox")
        row = page.locator(".nyc", has_text=asked)
        expect(row).to_have_count(1)
        row.locator(".nyc__open").click()
        expect(row).to_have_attribute("aria-current", "true")
        reply = page.locator(".nyc--open").get_by_role("button", name="Reply", exact=True)
        expect(reply).to_have_attribute("aria-keyshortcuts", "R")
        expect(reply.locator("kbd")).to_have_text("R")
        shot(page, f"reply-focus-inbox-r-key-1440-{UI_BROWSER}")
        # R, then the sentence at once: the reply field opens with every key of it.
        page.keyboard.press("r")
        page.keyboard.type(SENTENCES["root"], delay=35)
        expect(page).to_have_url(re.compile(rf"/conversations/{self.r_asks[asked]}"))
        field = self.thread(page).get_by_label("Reply", exact=True)
        expect(field, "every key after R went into the reply field").to_have_value(SENTENCES["root"])
        page.keyboard.press("Enter")
        for _ in range(80):
            if SENTENCES["root"] in self.bodies(self.r_asks[asked]):
                break
            time.sleep(0.25)
        self.assertEqual(self.bodies(self.r_asks[asked])[-1], SENTENCES["root"], "the reply is exactly what was typed")
        # Nothing was put off or marked done by the typing: the other question still waits, and nothing is "for later".
        queue = self.get("/api/v1/needs-you")
        self.assertTrue(any(other in item["title"] for item in queue["items"]), "the other question is still in the Inbox")
        self.assertEqual(queue["later"], 0, "nothing was put off by the typing")

    # ---------------------------------------------------------------- personas-34 P2 1: the same item opened the same way

    def test_06_enter_r_and_reply_open_where_it_is_answered_and_esc_returns_to_the_inbox(self) -> None:
        # Enter on a question nobody had answered yet only marked the message: no thread, and Esc did nothing, while with one reply Enter opened
        # the thread and Esc came back. In a direct message Enter and R both stayed there. From the Inbox, Enter, R and Reply open a question
        # where it is answered, with the cursor there (its thread, also when empty; a direct message's own field), and Esc returns to the Inbox
        # with the item open and focused.
        page = self.page()
        places = {
            "space": (R_ASKS[1], rf"/projects/{self.ids['project']}/conversations/{self.r_asks[R_ASKS[1]]}", lambda: self.thread(page).get_by_label("Reply", exact=True)),
            "dm": (DM_ASK, rf"/dm/{self.ids['dm']}", lambda: page.locator("#dm-composer")),
        }
        for place, (asked, address, field) in places.items():
            for how in ("Enter", "r", "Reply"):
                with self.subTest(place=place, how=how):
                    page.goto("/inbox")
                    row = page.locator(".nyq__list .nyc", has_text=asked)
                    row.locator(".nyc__open").click()
                    expect(row).to_have_attribute("aria-current", "true")
                    expect(row.locator(".nyc__open")).to_be_focused()
                    if how == "Reply":
                        page.locator(".nyc--open").get_by_role("button", name="Reply", exact=True).click()
                    else:
                        page.keyboard.press(how)
                    expect(page).to_have_url(re.compile(address))
                    if place == "space":
                        expect(self.thread(page), "the thread opens, although nobody has replied yet").to_be_visible()
                    expect(field(), "the cursor is where the answer is written").to_be_focused()
                    if how == "Enter":
                        shot(page, f"reply-focus-enter-{place}-1440-{UI_BROWSER}")
                    page.keyboard.press("Escape")
                    expect(page).to_have_url(re.compile(r"/inbox$"))
                    row = page.locator(".nyq__list .nyc", has_text=asked)
                    expect(row).to_have_attribute("aria-current", "true")
                    expect(row.locator(".nyc__open")).to_be_focused()
        queue = " ".join(item["title"] for item in self.get("/api/v1/needs-you")["items"])
        self.assertIn(R_ASKS[1], queue, "nothing was written, so the question still waits")
        self.assertIn(DM_ASK, queue)

    def test_07_phone_a_question_with_no_replies_opens_its_thread_and_x_returns(self) -> None:
        page = self.page(phone=True)
        asked = PHONE_ASKS[2]
        page.goto("/inbox")
        card = page.locator(".nyq__list .nyc", has_text=asked)
        card.locator(".nyc__open").tap()
        expect(page).to_have_url(re.compile(rf"/conversations/{self.phone[asked]}"))
        sheet = self.thread(page)
        expect(sheet, "the thread opens in its sheet, although nobody has replied yet").to_be_visible()
        shot(page, f"reply-focus-phone-empty-thread-390-{UI_BROWSER}")
        sheet.get_by_role("button", name="Close replies").click()
        expect(page).to_have_url(re.compile(r"/inbox$"))
        expect(page.locator(".nyq__list .nyc", has_text=asked)).to_have_attribute("aria-current", "true")


if __name__ == "__main__":
    unittest.main()
