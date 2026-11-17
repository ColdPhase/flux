"""Round 14 of the v0.2.1 release gate, area "core" (Inbox, Home, auth, focus, offline): one regression per P2.

Run once with FLUX_UI_BROWSER=chromium and once with webkit. Each test measures the running application:
- an Inbox row's title wraps to two lines and is cut with "…" on the phone and in the list, never cut mid-letter on one line (new P2-2,
  daily P2-1, look-a A2: `white-space: nowrap` under a `-webkit-box` clamp);
- the keyboard ring of an Inbox card at 200 % is one ring, the card's, never a second one round the title's words (look-a A10);
- a decision with a discussion, opened from the phone's Inbox, opens with its title in view, not scrolled to the discussion's end with only
  Accept showing (new P2-3);
- a task that waits for the reader, opened from the phone's Inbox, opens with what it waits for in view above the field, and names the reader
  "Ada Kowalska (you)" (look-a A3, A4);
- a panel's lower fade lies on the panel's own padding at the end and under the pinned answer, never over the newest message or Accept
  (look-a A5, look-b B1);
- after a submit by click, the first wrong field keeps its strong edge while no ring is drawn (look-a A1);
- Home says when what waits for you could not be read, with Try again, instead of "Looking…" for ever (look-a A6);
- offline, a page without a composer says so, and the line leaves when the connection is back (look-a A7).
"""

from __future__ import annotations

import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, shot, start_forwarder

PASSWORD = "a calm round for the garden"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ada": ("Ada Kowalska", f"ada.r14+{STAMP}@example.test"),
    "jonas": ("Jonas Berg", f"jonas.r14+{STAMP}@example.test"),
}
LONG = "can you check whether the overflow pipe behind the shed still drains after the storm on Sunday night?"
DECISION = "Borrow two sensors from the school instead of buying more"
BLOCKED = "Book the hall power for the demo table"


class Round14Core(unittest.TestCase):
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}
    contexts: dict[str, BrowserContext] = {}

    @classmethod
    def post(cls, who: str, path: str, body: dict) -> dict:
        response = cls.contexts[who].request.post(path, data=body, headers={"origin": ORIGIN})
        assert response.status in (200, 201), f"{path}: {response.status} {response.text()}"
        return response.json()

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
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
        decision = cls.post("jonas", f"/api/v1/projects/{project}/decisions", {"title": DECISION, "rationale": "It saves 36 EUR, and the school has spare ESP32 kits."})
        for body in ("The school says the kits are free until March.", "I can pick them up on Thursday with the van.",
                     "Do they come with the probes or only the boards?", "Boards and probes, but no cases. We have spare cases in the workshop.",
                     "Good, the last class ends at 15:00, so come after that.", "Then Thursday after three it is. I will bring the crates."):
            cls.post("jonas", f"/api/v1/decisions/{decision['id']}/discussion", {"body": body, "clientMessageId": str(uuid.uuid4())})
        cls.post("jonas", f"/api/v1/projects/{project}/work", {
            "title": BLOCKED, "owner": {"kind": "human", "id": cls.ids["jonas"]}, "status": "blocked",
            "blocker": "the hall's key is with the caretaker until Thursday morning", "waitingFor": {"kind": "human", "id": cls.ids["ada"]}})
        cls.post("jonas", f"/api/v1/projects/{project}/conversations", {"body": f"@Ada Kowalska {LONG}", "clientMessageId": str(uuid.uuid4())})
        for key, context in cls.contexts.items():
            cls.states[key] = context.storage_state()
        for _ in range(80):
            items = cls.contexts["ada"].request.get("/api/v1/needs-you").json()["items"]
            if len(items) >= 3:
                break
            time.sleep(0.25)

    @classmethod
    def tearDownClass(cls) -> None:
        for context in cls.contexts.values():
            context.close()
        cls.browser.close()
        cls.pw.stop()

    def page(self, viewport: dict, touch: bool = False, signed_in: bool = True, zoom: float | None = None) -> Page:
        options: dict = {"base_url": ORIGIN, "viewport": viewport, "locale": "en-GB", "service_workers": "block"}
        if signed_in:
            options["storage_state"] = self.states["ada"]
        if touch:
            options.update(is_mobile=UI_BROWSER == "chromium", has_touch=True)
        if zoom:
            options.update(viewport={"width": int(viewport["width"] / zoom), "height": int(viewport["height"] / zoom)}, device_scale_factor=zoom)
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def long_row_lines(self, page: Page) -> tuple[float, str]:
        title = page.locator(".nyq__list .nyc__open-t").filter(has_text="overflow pipe behind the shed")
        expect(title).to_be_visible()
        return title.evaluate("""(el) => { const cs = getComputedStyle(el); const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.35;
          return [el.getBoundingClientRect().height / line, cs.whiteSpace]; }""")

    def test_01_inbox_row_titles_wrap_to_two_lines_and_end_in_an_ellipsis(self) -> None:
        for label, viewport, touch in (("phone", PHONE, True), ("list", DESKTOP, False)):
            with self.subTest(view=label):
                page = self.page(viewport, touch=touch)
                page.goto("/inbox")
                lines, white_space = self.long_row_lines(page)
                self.assertNotEqual(white_space, "nowrap", "a clamped title wraps; nowrap under the clamp cut it mid-letter in WebKit")
                self.assertGreater(lines, 1.6, "the long title takes its two lines")
                self.assertLess(lines, 2.4, "and no more than two")
                shot(page, f"round14-inbox-titles-{label}-{UI_BROWSER}")

    def test_02_an_inbox_card_at_200_percent_has_one_ring(self) -> None:
        page = self.page(DESKTOP, zoom=2)
        page.goto("/inbox")
        title = page.locator(".nyq__list .nyc__open").first
        expect(title).to_be_visible()
        page.keyboard.press("Escape")
        title.focus()
        expect(title).to_be_focused()
        rings = title.evaluate("(el) => [getComputedStyle(el.closest('.nyc').querySelector('.nyc__card')).outlineStyle, getComputedStyle(el).outlineStyle]")
        self.assertEqual(rings, ["solid", "none"], "the card carries the one ring, the title's words none")
        shot(page, f"round14-inbox-ring-200-{UI_BROWSER}")

    def open_from_phone_inbox(self, text: str) -> Page:
        page = self.page(PHONE, touch=True)
        page.goto("/inbox")
        title = page.locator(".nyq__list .nyc__open").filter(has_text=text)
        expect(title).to_be_visible()
        title.tap()
        expect(page.locator(".ui-detent-sheet .wd__scroll")).to_be_visible()
        return page

    def in_view(self, page: Page, selector: str) -> list[float]:
        """How far the element's top lies above, and its bottom below, the visible part of the sheet's scrolling area (0 when in view)."""
        return page.evaluate("""(selector) => { const el = document.querySelector(selector); const box = el.closest('.wd__scroll').getBoundingClientRect();
          const r = el.getBoundingClientRect(); return [Math.max(0, box.top - r.top), Math.max(0, r.bottom - box.bottom)]; }""", selector)

    def test_03_a_discussed_decision_opens_on_its_title_on_the_phone(self) -> None:
        page = self.open_from_phone_inbox(DECISION)
        expect(page.locator(".wd-discussion__list > li")).to_have_count(6)
        page.wait_for_timeout(400)
        above, below = self.in_view(page, ".ui-detent-sheet .wd-decision-identity .details__title")
        self.assertLess(above, 1, "the decision's title is in view, not scrolled away above the discussion")
        self.assertLess(below, 1)
        expect(page.locator(".ui-detent-sheet").get_by_role("button", name="Accept")).to_be_in_viewport()
        shot(page, f"round14-decision-sheet-{UI_BROWSER}")

    def test_04_a_task_waiting_for_you_opens_on_what_it_waits_for(self) -> None:
        page = self.open_from_phone_inbox(BLOCKED)
        blocker = page.locator(".ui-detent-sheet .wd-blocker")
        expect(blocker).to_contain_text("Waiting for Ada Kowalska (you)")
        page.wait_for_timeout(600)
        above, below = self.in_view(page, ".ui-detent-sheet .wd-blocker")
        self.assertLess(below, 1, "what the task waits for, with Done, is whole above the field")
        self.assertLess(above, 1)
        shot(page, f"round14-blocked-sheet-{UI_BROWSER}")

    def test_05_the_panel_fade_rests_on_its_padding_and_under_the_answer(self) -> None:
        page = self.open_from_phone_inbox(DECISION)
        scroller = page.locator(".ui-detent-sheet .wd__scroll")
        fade = scroller.evaluate("(el) => { const cs = getComputedStyle(el, '::after'); return [cs.position, cs.bottom, cs.zIndex, getComputedStyle(el).paddingBottom]; }")
        self.assertEqual(fade[0], "sticky")
        # Stuck at the scrolling area's edge in the middle, it lies on the 20 px bottom padding at the end, never on the newest message.
        self.assertEqual(fade[1], f"-{fade[3]}", "the fade sticks a padding below the content's edge")
        self.assertEqual(fade[2], "0", "under the pinned answer (z-index 1), so it never washes over Accept")

    def test_06_after_a_click_the_first_wrong_field_keeps_its_edge(self) -> None:
        page = self.page(DESKTOP, signed_in=False)
        page.goto("/sign-in")
        page.get_by_role("button", name="Sign in", exact=True).click()
        field = page.locator(".ui-field--invalid .ui-input").first
        expect(field).to_be_focused()
        self.assertEqual(page.evaluate("document.documentElement.dataset.input"), "pointer")
        edge = field.evaluate("(el) => getComputedStyle(el).boxShadow")
        self.assertIn("1.5px", edge, "the focused wrong field has the strong edge every wrong field has while no ring is drawn")
        shot(page, f"round14-sign-in-invalid-{UI_BROWSER}")

    def test_07_home_says_when_what_waits_could_not_be_read(self) -> None:
        page = self.page(DESKTOP)
        failing = {"on": True}
        page.route("**/api/v1/needs-you", lambda route: route.fulfill(status=500, content_type="application/json", body='{"error":"down"}') if failing["on"] else route.continue_())
        page.goto("/")
        section = page.locator("section.home__need")
        expect(section.get_by_role("alert")).to_contain_text("This couldn’t be loaded.")
        expect(section.get_by_text("Looking at what waits for you…")).to_have_count(0)
        failing["on"] = False
        section.get_by_role("button", name="Try again").click()
        expect(section.locator(".home__rows")).to_be_visible()
        shot(page, f"round14-home-needs-you-failed-{UI_BROWSER}")

    def test_08_offline_a_page_without_a_composer_says_so(self) -> None:
        page = self.page(DESKTOP)
        page.goto("/inbox")
        expect(page.locator(".nyq__list .nyc").first).to_be_visible()
        page.context.set_offline(True)
        notice = page.locator("[data-offline-notice]")
        expect(notice).to_contain_text("You’re offline.")
        shot(page, f"round14-offline-inbox-{UI_BROWSER}")
        page.context.set_offline(False)
        expect(notice).to_have_count(0)


if __name__ == "__main__":
    unittest.main()
