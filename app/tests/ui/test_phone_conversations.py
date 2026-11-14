"""Phone conversations, measured (v0.2.1 UI audit: #1356, #1357, #1359), at 390, 375 and 320 px, in the engine FLUX_UI_BROWSER names.

- #1356: an agent's chat is a normal conversation on the phone (README §4 Phone, §7 Agents and AI): Back, its face, its name and the one line
  under it in the title row, the schedule row, no second name row and no tab bar; Back returns to where the person came from.
- #1357: a message's ⋯ is a 44 px target on a touch screen, in the lane beside its bubble, so it never covers a word (a space, a thread, a
  direct message, own and other people's messages, in groups and alone) and a page never scrolls sideways.
- #1359: a task's Status opens as a bottom sheet on a small phone, so every state can be chosen with the menu inside the window.

Touch emulation is the platform's own (Pixel 7 in Chromium, iPhone 15 in WebKit) at the audit's window sizes.
"""
from __future__ import annotations

import json
import os
import re
import unittest
import uuid

from playwright.sync_api import expect, sync_playwright

from phone_audit import call, window
from test_phone_text_fit import FITS_JS
from test_app_shell import ORIGIN, UPSTREAM, start_forwarder

PASSWORD = "phones deserve room to work"
STAMP = uuid.uuid4().hex[:8]
UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
if UI_BROWSER not in ("chromium", "webkit"):
    raise ValueError(f"FLUX_UI_BROWSER must be chromium or webkit, got {UI_BROWSER!r}")
KEY = f"sk-ant-api03-{'phone-g1-key-' * 3}G101"
LADDER = "Are you at the garden this afternoon? I have the ladder."
LONG = ("I read the gateway log for the last seven days: the far east bed fell below -110 dBm twice, both times after rain, "
        "and the shed bed never dropped at all.")

# Where the ⋯ of every message on the page is, and which words of its message its 44 px box covers (none, by design).
DOTS_JS = """(scope) => {
  const out = [];
  for (const dots of (document.querySelector(scope) ?? document).querySelectorAll('.msg-touch__sr')) {
    const box = dots.getBoundingClientRect();
    const row = dots.closest('.msg-touch');
    const words = [];
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent.trim() || dots.contains(node) || node.parentElement.closest('.msg-touch__label, .ui-vh')) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      for (const q of range.getClientRects()) {
        if (q.width > 0 && q.height > 0 && q.left < box.right && q.right > box.left && q.top < box.bottom && q.bottom > box.top) words.push(node.textContent.trim().slice(0, 24));
      }
    }
    const x = box.left + box.width / 2, y = box.top + box.height / 2;
    const at = document.elementFromPoint(x, y);
    // Only a target wholly inside the feed that scrolls it can be asked what is at its middle: the header and the composer cover the rest.
    let feed = row.parentElement;
    while (feed && !/(auto|scroll)/.test(getComputedStyle(feed).overflowY)) feed = feed.parentElement;
    const area = feed ? feed.getBoundingClientRect() : { top: 0, bottom: innerHeight };
    out.push({ w: Math.round(box.width * 10) / 10, h: Math.round(box.height * 10) / 10, left: box.left, right: box.right, top: box.top, bottom: box.bottom,
      mine: row.classList.contains('is-mine'), covers: words, reachable: !!at && (at === dots || dots.contains(at)),
      blocker: at && at !== dots && !dots.contains(at) ? `${at.tagName}.${String(at.className).slice(0, 60)}` : null,
      beside: (() => { const bubble = row.querySelector('.message-bubble, .dm-msg__body'); if (!bubble) return null; const b = bubble.getBoundingClientRect();
        return row.classList.contains('is-mine') ? box.right <= b.left + 1 : box.left >= b.right - 1; })(),
      shown: box.top >= area.top && box.bottom <= area.bottom });
  }
  return out;
}"""


class PhoneConversations(unittest.TestCase):
    """Tests run in name order and share one account (Ada), her company, a space, a direct message with Kai and two agents."""

    pw = None
    ids: dict = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=10000)
        cls.states = {}
        for who, name in (("ada", "Ada Kowalska"), ("kai", "Kai Tanaka")):
            context = cls.browser.new_context(base_url=ORIGIN)
            email = f"{who}.phone+{STAMP}@example.test"
            response = context.request.post("/api/auth/sign-up/email", data={"name": name, "email": email, "password": PASSWORD}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[who] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.ids[who + "_email"] = email
            cls.states[who] = context.storage_state()
            context.close()
        ada = cls.api_context("ada")
        workspace = cls.call(ada, "POST", "/api/v1/workspaces", {"name": "Riverside Makers"}, 201)
        cls.call(ada, "POST", f"/api/v1/workspaces/{workspace['id']}/members", {"email": cls.ids["kai_email"], "role": "member"}, 201)
        project = cls.call(ada, "POST", f"/api/v1/workspaces/{workspace['id']}/projects", {"name": "Community garden sensors", "visibility": "restricted"}, 201)
        cls.call(ada, "POST", f"/api/v1/projects/{project['id']}/grants", {"principal": {"kind": "human", "id": cls.ids["kai"]}, "role": "contributor"}, 201)
        cls.ids.update(workspace=workspace["id"], project=project["id"])
        task = cls.call(ada, "POST", f"/api/v1/projects/{project['id']}/work", {"title": "Order the replacement probes from the blue box before the weekend"}, 201)
        cls.ids["task"] = task["id"]
        kai = cls.api_context("kai")
        # The space's conversation: Kai writes in groups and alone, Ada too; one root has a thread.
        root = cls.call(kai, "POST", f"/api/v1/projects/{project['id']}/conversations", {"body": LADDER, "clientMessageId": str(uuid.uuid4())}, 201)
        for body in (LADDER, LONG, "Short one"):
            cls.call(kai, "POST", f"/api/v1/projects/{project['id']}/conversations", {"body": body, "clientMessageId": str(uuid.uuid4())}, 201)
        for body in (LADDER, LADDER, LONG, "Yes"):
            cls.call(ada, "POST", f"/api/v1/projects/{project['id']}/conversations", {"body": body, "clientMessageId": str(uuid.uuid4())}, 201)
        for who, body in ((kai, "Yes, and the spare cable."), (kai, LONG), (ada, "Thursday works")):
            cls.call(who, "POST", f"/api/v1/conversations/{root['id']}/messages", {"body": body, "clientMessageId": str(uuid.uuid4())}, 201)
        cls.ids["conversation"] = root["id"]
        # A direct message: groups of Kai's messages, then Ada's.
        dm = cls.call(ada, "POST", f"/api/v1/workspaces/{workspace['id']}/dms", {"participantIds": [cls.ids["kai"]]}, (200, 201))
        cls.ids["dm"] = dm["id"]
        first = None
        for who, body in ((kai, LADDER), (kai, LADDER), (kai, LADDER), (kai, LONG), (kai, "Yes"), (ada, LADDER), (ada, LONG), (ada, "Ok, see you at three"), (ada, "Yes")):
            made = cls.call(who, "POST", f"/api/v1/dms/{dm['id']}/messages", {"body": body, "clientMessageId": str(uuid.uuid4())}, 201)
            first = first or made["id"]
        cls.call(kai, "POST", f"/api/v1/dms/{dm['id']}/threads/{first}/replies", {"body": "It needs the 5 V supply, I will pack that too.", "clientMessageId": str(uuid.uuid4())}, 201)
        cls.ids["dm_root"] = first
        # Ada connects AI: the server makes Assistant; Planner is a second agent. Assistant has a schedule, so its chat has the schedule row.
        cls.call(ada, "POST", "/api/v1/background-compute-connections", {"name": "Ada's key", "provider": "anthropic", "model": "claude-sonnet-5",
                 "apiKey": KEY, "dailyBudgetCents": 500, "timeZone": "Europe/Warsaw"}, 201)
        mine = cls.call(ada, "GET", "/api/v1/my-agents")["items"]
        cls.ids["assistant"] = next(item["id"] for item in mine if item["name"] == "Assistant")
        cls.call(ada, "POST", f"/api/v1/my-agents/{cls.ids['assistant']}/schedules", {"title": "Monday plan", "text": "Say what the garden space has to do this week",
                 "schedule": {"kind": "daily", "at": "08:00"}, "timeZone": "Europe/Warsaw"}, 201)
        ada.dispose()
        kai.dispose()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    @classmethod
    def api_context(cls, who: str):
        return cls.pw.request.new_context(base_url=ORIGIN, storage_state=cls.states[who], extra_http_headers={"origin": ORIGIN})

    call = staticmethod(call)

    def phone(self, width: int, height: int, who: str = "ada"):
        context = window(self.pw, self.browser, UI_BROWSER, ORIGIN, self.states[who], width, height)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught browser errors"))
        return page

    def settled(self, page) -> None:
        page.evaluate("() => Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => null)))")

    # ------------------------------------------------------------------------------------------------------------------
    # #1356
    # ------------------------------------------------------------------------------------------------------------------

    def test_01_an_agent_s_chat_is_a_normal_conversation_on_the_phone(self) -> None:
        for width, height in ((390, 844), (320, 640)):
            with self.subTest(width=width):
                page = self.phone(width, height)
                page.goto("/projects")
                page.get_by_role("link", name=re.compile(r"^Assistant")).first.click()
                expect(page).to_have_url(re.compile(r"/agents/[0-9a-f-]{36}$"))
                header = page.locator("header.phead")
                expect(header.get_by_role("heading", level=1, name="Assistant")).to_be_visible()
                expect(header).to_contain_text("Your agent · only you talk to it")
                expect(header.get_by_role("button", name="Back")).to_be_visible()
                # The agent's face is in the title row, and the one name row below it is gone: no bar, no lock line, no tag.
                self.assertGreaterEqual(header.locator("svg").count(), 3, "Back, the agent's face and ⋯ are drawn in the title row")
                expect(page.locator(".agc__bar, .agc__tag, .agc__note")).to_have_count(0)
                expect(page.locator("[data-schedules-header]")).to_be_visible()
                # A conversation has no tab bar (S2), and the composer sits at the bottom.
                expect(page.get_by_role("navigation", name="Main places")).to_have_count(0)
                box = page.get_by_role("textbox", name="Message Assistant").bounding_box()
                self.assertGreater(box["y"] + box["height"], height - 80, "the composer is at the bottom of the screen")
                # The title row's ⋯ holds the agent's Settings; Back returns to where the person came from.
                header.get_by_role("button", name="More").click()
                page.get_by_role("menuitem", name="Settings").click()
                expect(page).to_have_url(re.compile(r"/settings/agents/[0-9a-f-]{36}$"))
                page.go_back()
                expect(header.get_by_role("button", name="Back")).to_be_visible()
                header.get_by_role("button", name="Back").click()
                expect(page).to_have_url(re.compile(r"/projects$"))

    # ------------------------------------------------------------------------------------------------------------------
    # #1357
    # ------------------------------------------------------------------------------------------------------------------

    def assert_dots(self, page, where: str, width: int, scope: str = "body") -> None:
        page.wait_for_function("(scope) => document.querySelectorAll(`${scope} .msg-touch__sr`).length >= 3", arg=scope)
        self.settled(page)
        found = page.evaluate(DOTS_JS, scope)
        self.assertGreaterEqual(len(found), 3, f"{where}: several messages")
        for dots in found:
            self.assertGreaterEqual(dots["w"], 44, f"{where}: the ⋯ is 44 px wide: {dots}")
            self.assertGreaterEqual(dots["h"], 44, f"{where}: the ⋯ is 44 px high: {dots}")
            self.assertEqual(dots["covers"], [], f"{where}: the ⋯ covers no words: {dots}")
            self.assertGreaterEqual(dots["left"], -0.5, f"{where}: the ⋯ is inside the window: {dots}")
            self.assertLessEqual(dots["right"], width + 0.5, f"{where}: the ⋯ is inside the window: {dots}")
            if dots["shown"]:
                self.assertTrue(dots["reachable"], f"{where}: nothing covers the middle of the ⋯: {dots}")
        self.assertLessEqual(page.evaluate("() => document.documentElement.scrollWidth"), width, f"{where}: the page does not scroll sideways")
        # Own and other people's messages have it, each on the side of its bubble away from the author.
        for dots in found:
            self.assertIn(dots["beside"], (True, None), f"{where}: the ⋯ is beside its bubble, away from the author: {dots}")

    def test_02_the_message_menu_is_a_44_px_target_that_covers_no_words(self) -> None:
        for width, height in ((390, 844), (320, 640)):
            page = self.phone(width, height)
            page.goto(f"/dm/{self.ids['dm']}")
            expect(page.get_by_text("Ok, see you at three").first).to_be_visible()
            self.assert_dots(page, f"a direct message at {width}", width)
            page.goto(f"/projects/{self.ids['project']}")
            expect(page.get_by_text("Short one").first).to_be_visible()
            self.assert_dots(page, f"a space at {width}", width)

    def test_03_the_same_in_a_thread(self) -> None:
        page = self.phone(390, 844)
        page.goto(f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}")
        expect(page.get_by_text("Thursday works").first).to_be_visible()
        self.assert_dots(page, "a space's thread", 390, ".thread")
        page.goto(f"/dm/{self.ids['dm']}?thread={self.ids['dm_root']}")
        expect(page.get_by_text("It needs the 5 V supply").first).to_be_visible()
        page.wait_for_function("() => document.querySelectorAll('.dm-thread .msg-touch__sr').length >= 2")
        self.settled(page)
        for dots in page.evaluate(DOTS_JS, ".dm-thread"):
            self.assertEqual(dots["covers"], [], f"a direct message's thread: the ⋯ covers no words: {dots}")
            self.assertGreaterEqual((dots["w"], dots["h"]), (44, 44))
        # The reply count is said once (the head's), not again on the line between the message and its replies.
        expect(page.locator("#details").get_by_text(re.compile(r"^1 reply$"))).to_have_count(1)

    def test_04_the_message_menu_opens_from_the_target(self) -> None:
        page = self.phone(390, 844)
        page.goto(f"/dm/{self.ids['dm']}")
        expect(page.get_by_text("Ok, see you at three").first).to_be_visible()
        page.get_by_role("button", name="Message actions").last.tap()
        expect(page.get_by_role("menu", name="Message actions")).to_be_visible()
        expect(page.get_by_role("menuitem", name="Copy text")).to_be_visible()

    def test_04a_a_keyboard_shows_the_label_inside_the_window(self) -> None:
        """A keyboard focus shows the ⋯ as a pill with its label; on a short message of someone else's ("Yes") the pill stays inside the window."""
        page = self.phone(390, 844)
        page.goto(f"/dm/{self.ids['dm']}")
        expect(page.get_by_text("Ok, see you at three").first).to_be_visible()
        page.locator("header.phead").get_by_role("button", name="More").focus()
        seen = 0
        for _ in range(16):
            page.keyboard.press("Tab")
            focused = page.evaluate("""() => { const el = document.activeElement; const b = el.getBoundingClientRect();
              return { label: el.getAttribute('aria-label') || el.textContent.trim(), left: b.left, right: b.right, popup: el.getAttribute('aria-haspopup') }; }""")
            if focused["label"] != "Message actions":
                continue
            seen += 1
            self.assertEqual(focused["popup"], "menu", focused)
            self.assertGreaterEqual(focused["left"], -0.5, f"the focused ⋯ is inside the window: {focused}")
            self.assertLessEqual(focused["right"], 390.5, f"the focused ⋯ is inside the window: {focused}")
        self.assertGreaterEqual(seen, 5, "every message's ⋯ is reached by Tab")

    def test_04c_a_direct_message_s_hint_is_one_line_with_large_text(self) -> None:
        context = window(self.pw, self.browser, UI_BROWSER, ORIGIN, self.states["ada"], 320, 640, text=200)
        self.addCleanup(context.close)
        page = context.new_page()
        page.goto(f"/dm/{self.ids['dm']}")
        expect(page.get_by_text("Ok, see you at three").first).to_be_visible()
        page.evaluate("() => document.fonts.ready")
        # The hint is chosen again when the interface font arrives; give it that moment, then measure.
        try:
            page.wait_for_function(f"() => {{ const fit = ({FITS_JS})('#dm-composer'); return fit && fit.width <= fit.room; }}", timeout=5000)
        except Exception:
            pass
        fit = page.evaluate(FITS_JS, "#dm-composer")
        self.assertLessEqual(fit["width"], fit["room"], f"the hint fits its line: {fit}")
        self.assertLessEqual(fit["height"], fit["oneLine"] + 2, f"the composer is one line high: {fit}")

    def test_04b_a_direct_message_s_title_row_is_a_space_s(self) -> None:
        """#1374 (founder decision): Back, the name and ⋯, with Search and Call as the first rows of ⋯; no icons for them, and the name is no menu."""
        for width, height in ((390, 844), (320, 640)):
            with self.subTest(width=width):
                page = self.phone(width, height)
                page.goto(f"/dm/{self.ids['dm']}")
                header = page.locator("header.phead")
                title = header.get_by_role("heading", level=1, name="Kai Tanaka")
                expect(title).to_be_visible()
                expect(title.get_by_role("button")).to_have_count(0)
                self.assertEqual(header.locator("button:visible").evaluate_all("els => els.map((el) => el.getAttribute('aria-label')).filter(Boolean)"), ["Back", "More"])
                expect(page.get_by_role("navigation", name="Main places")).to_have_count(0)
                header.get_by_role("button", name="More").click()
                labels = [text.strip().split("\n")[0] for text in page.get_by_role("menu", name="More").get_by_role("menuitem").all_inner_texts()]
                self.assertEqual(labels[0], "Search")
                self.assertNotIn("Call", labels, "no media server on this test server: no Call row (#1424)")
                self.assertEqual(labels[-1], "People and privacy")
                self.assertIn("Mute conversation", labels)

    # ------------------------------------------------------------------------------------------------------------------
    # #1359
    # ------------------------------------------------------------------------------------------------------------------

    def test_05_every_state_can_be_chosen_on_a_small_phone(self) -> None:
        for width, height in ((320, 640), (375, 667)):
            with self.subTest(width=width):
                page = self.phone(width, height)
                page.goto(f"/projects/{self.ids['project']}/tasks?view=board&open=work:{self.ids['task']}")
                page.get_by_role("button", name="Status").click()
                menu = page.get_by_role("menu", name="Status")
                expect(menu).to_be_visible()
                self.settled(page)
                options = menu.get_by_role("menuitemradio")
                self.assertEqual(options.all_inner_texts(), ["To do", "Doing", "Blocked", "Done"])
                for option in options.all():
                    box = option.bounding_box()
                    self.assertTrue(box["x"] >= 0 and box["y"] >= 0 and box["x"] + box["width"] <= width and box["y"] + box["height"] <= height,
                                    f"{option.inner_text()} is inside the {width} x {height} window: {box}")
                    self.assertGreaterEqual(box["height"], 44)
                options.get_by_text("Blocked", exact=True).tap()
                expect(page.get_by_role("button", name="Status")).to_contain_text("Blocked")
                page.get_by_role("button", name="Status").click()
                page.get_by_role("menuitemradio", name="Done").tap()
                expect(page.get_by_role("button", name="Status")).to_contain_text("Done")


if __name__ == "__main__":
    unittest.main()
