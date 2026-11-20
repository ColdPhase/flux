"""Pinned messages (C-74, #1615): Pin / Unpin in the message's ⋯ menu after Copy text (key P), the quiet "Pinned by" line above the bubble,
the header's pin button with its count, "Pinned · N" in the one panel, a click that brings the message into view (in its thread for a reply),
Unpin in the panel, the phone's long-press sheet, its ⋯ row "Pinned N" after Search and its sheet, and ⌘K's "Pinned" mark first in Messages.
Runs with the other tests/ui modules through scripts/check_ui.sh. Ada and Jonas share a space."""

from __future__ import annotations

import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from message_gestures import long_press
from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, shot, start_forwarder

PASSWORD = "pin the gateway login"
STAMP = int(time.time() * 1000)
WORD = f"gateway{STAMP % 100000}"
PEOPLE = {
    "ada": ("Ada Kowalska", f"ada.pins+{STAMP}@example.test"),
    "jonas": ("Jonas Berg", f"jonas.pins+{STAMP}@example.test"),
}
LOGIN = f"{WORD} login: admin panel at 10.0.4.2, the shed key is in the blue box under the bench."
ROTA = "Watering rota: Mon/Thu Maja, Tue/Fri Jonas, weekends whoever is closest."
OTHER = f"The second {WORD} works from the shed roof."


class MessagePins(unittest.TestCase):
    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=10000)
        for key, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(service_workers="block", base_url=ORIGIN)
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.states[key] = context.storage_state()
            context.close()
        ada = cls.browser.new_context(service_workers="block", base_url=ORIGIN, storage_state=cls.states["ada"])
        jonas = cls.browser.new_context(service_workers="block", base_url=ORIGIN, storage_state=cls.states["jonas"])
        post = lambda context, path, body: context.request.post(path, data=body, headers={"origin": ORIGIN})  # noqa: E731
        workspace = post(ada, "/api/v1/workspaces", {"name": "Community garden"})
        assert workspace.status == 201, workspace.text()
        cls.ids["workspace"] = workspace.json()["id"]
        added = post(ada, f"/api/v1/workspaces/{cls.ids['workspace']}/members", {"email": PEOPLE["jonas"][1], "role": "member"})
        assert added.status == 201, added.text()
        space = post(ada, f"/api/v1/workspaces/{cls.ids['workspace']}/projects", {"name": "Garden sensors", "visibility": "workspace"})
        assert space.status == 201, space.text()
        cls.ids["space"] = space.json()["id"]
        rota = post(jonas, f"/api/v1/projects/{cls.ids['space']}/conversations", {"body": "Who waters this week?", "clientMessageId": str(uuid.uuid4())})
        assert rota.status == 201, rota.text()
        cls.ids["thread"] = rota.json()["id"]
        reply = post(jonas, f"/api/v1/conversations/{cls.ids['thread']}/messages", {"body": ROTA, "clientMessageId": str(uuid.uuid4())})
        assert reply.status == 201, reply.text()
        cls.ids["reply"] = reply.json()["id"]
        for body in (OTHER, LOGIN):
            sent = post(jonas, f"/api/v1/projects/{cls.ids['space']}/conversations", {"body": body, "clientMessageId": str(uuid.uuid4())})
            assert sent.status == 201, sent.text()
            cls.ids[body] = sent.json()["messages"][0]["id"]
        ada.close()
        jonas.close()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, who: str, *, phone: bool = False, dark: bool = False) -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": "dark" if dark else "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw", "storage_state": self.states[who]}
        options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True) if phone else options.update(viewport=DESKTOP, device_scale_factor=1)
        context: BrowserContext = self.browser.new_context(service_workers="block", **options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        page.goto(f"/projects/{self.ids['space']}")
        expect(page.get_by_text(LOGIN)).to_be_visible()
        return page

    def api(self, who: str, method: str, path: str) -> None:
        context = self.browser.new_context(service_workers="block", base_url=ORIGIN, storage_state=self.states[who])
        try:
            response = context.request.fetch(path, method=method, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
        finally:
            context.close()

    def message(self, page: Page, body: str):
        return page.locator(".project-convo__message", has_text=body).first

    def clear(self) -> None:
        for message in (self.ids[LOGIN], self.ids[OTHER], self.ids["reply"]):
            self.api("ada", "DELETE", f"/api/v1/projects/{self.ids['space']}/pins/{message}")

    def setUp(self) -> None:
        self.clear()

    def test_01_pin_from_the_menu_the_line_the_header_count_the_panel_jump_and_unpin(self) -> None:
        ada = self.page("ada")
        jonas = self.page("jonas")
        header = ada.locator("header.top")
        expect(header.locator(".top__pins-slot")).to_have_count(1)
        expect(header.locator(".top__pins")).to_have_count(0)  # an empty slot: nothing moves
        login = self.message(ada, LOGIN)
        login.hover()
        login.get_by_role("button", name="More actions").click()
        menu = ada.get_by_role("menu", name="Message actions")
        self.assertEqual([text.strip() for text in menu.get_by_role("menuitem").all_inner_texts()], ["Add to map", "Copy link", "Copy text", "Pin"])
        expect(menu.get_by_role("menuitem", name="Pin", exact=True).locator("kbd")).to_have_attribute("data-key", "P")
        shot(ada, "pins-desktop-1440-menu-light")
        menu.get_by_role("menuitem", name="Pin", exact=True).click()
        expect(login.locator(".pin-line")).to_have_text("Pinned by Ada Kowalska (you)")
        expect(header.get_by_role("button", name="Pinned messages, 1")).to_be_visible()
        # Everyone reading sees it at once, with no notification and no line in the conversation.
        expect(self.message(jonas, LOGIN).locator(".pin-line")).to_have_text("Pinned by Ada Kowalska", timeout=15000)
        expect(jonas.locator("header.top").get_by_role("button", name="Pinned messages, 1")).to_be_visible()

        # The reply in a thread, pinned by Jonas: the list says "in a thread", newest first.
        self.api("jonas", "PUT", f"/api/v1/projects/{self.ids['space']}/pins/{self.ids['reply']}")
        expect(header.get_by_role("button", name="Pinned messages, 2")).to_be_visible(timeout=15000)
        header.get_by_role("button", name="Pinned messages, 2").click()
        panel = ada.locator("#details")
        expect(panel.get_by_role("heading", name="Pinned · 2")).to_be_visible()
        rows = panel.locator(".pins__row")
        expect(rows).to_have_count(2)
        expect(rows.nth(0)).to_contain_text(ROTA)
        expect(rows.nth(0).locator(".pins__meta")).to_contain_text("Jonas Berg · ")
        expect(rows.nth(0).locator(".pins__meta")).to_contain_text("in a thread · pinned by Jonas Berg")
        expect(rows.nth(1).locator(".pins__meta")).to_contain_text("pinned by Ada Kowalska (you)")
        expect(panel).to_contain_text("Everyone in this space sees these. The newest pin is first.")
        rows.nth(1).hover()
        expect(rows.nth(1).get_by_role("button", name="Unpin Jonas Berg’s message")).to_be_visible()
        shot(ada, "pins-desktop-1440-panel-light")

        # A click on the reply opens its thread at the reply.
        rows.nth(0).locator(".pins__open").click()
        expect(ada).to_have_url(f"{ORIGIN}/projects/{self.ids['space']}/conversations/{self.ids['thread']}#message-{self.ids['reply']}")
        expect(ada.locator(f"#thread [data-message-id='{self.ids['reply']}'], #details [data-message-id='{self.ids['reply']}']").first).to_be_visible()

        # Unpin from the panel: the count follows, and with none the slot is empty again.
        header.get_by_role("button", name="Pinned messages, 2").click()
        panel.locator(".pins__row").nth(0).hover()
        panel.locator(".pins__row").nth(0).get_by_role("button", name="Unpin Jonas Berg’s message").click()
        expect(header.get_by_role("button", name="Pinned messages, 1")).to_be_visible()
        expect(panel.get_by_role("heading", name="Pinned · 1")).to_be_visible()
        # P on a focused message pins and unpins.
        ada.keyboard.press("Escape")
        login = self.message(ada, LOGIN)
        login.focus()
        ada.keyboard.press("p")
        expect(header.locator(".top__pins")).to_have_count(0)
        expect(login.locator(".pin-line")).to_have_count(0)
        ada.keyboard.press("p")
        expect(login.locator(".pin-line")).to_have_text("Pinned by Ada Kowalska (you)")

        dark = self.page("ada", dark=True)
        dark.locator("header.top").get_by_role("button", name="Pinned messages, 1").click()
        expect(dark.locator("#details").get_by_role("heading", name="Pinned · 1")).to_be_visible()
        shot(dark, "pins-desktop-1440-panel-dark")

    def test_02_cmd_k_puts_a_pinned_match_first_in_messages_with_its_mark(self) -> None:
        self.api("ada", "PUT", f"/api/v1/projects/{self.ids['space']}/pins/{self.ids[LOGIN]}")
        page = self.page("ada")
        expect(page.get_by_role("button", name="Search", exact=True)).to_be_visible()
        page.keyboard.press("Control+k")
        dialog = page.get_by_role("dialog", name="Search", exact=True)
        dialog.get_by_role("combobox", name="Search", exact=True).fill(WORD)
        first = dialog.get_by_role("option").filter(has_text="10.0.4.2").first
        expect(first).to_be_visible()
        options = dialog.get_by_role("option").all_inner_texts()
        messages = [text for text in options if "10.0.4.2" in text or "shed roof" in text]
        self.assertGreaterEqual(len(messages), 2, options)
        self.assertIn("10.0.4.2", messages[0], "the pinned message is first among the messages")
        expect(first.locator(".sr__pinned")).to_have_text("Pinned")
        expect(dialog.get_by_role("option").filter(has_text="shed roof").locator(".sr__pinned")).to_have_count(0)
        shot(page, "pins-desktop-1440-search-light")

    def test_03_phone_long_press_the_more_row_and_the_sheet(self) -> None:
        for dark in (False, True):
            self.clear()
            page = self.page("ada", phone=True, dark=dark)
            bubble = self.message(page, LOGIN).locator(".message-body")
            long_press(bubble)
            sheet = page.get_by_role("menu", name="Message actions")
            self.assertEqual([text.strip() for text in sheet.get_by_role("menuitem").all_inner_texts()],
                             ["Reply in thread", "Create task", "Add to map", "Copy link", "Copy text", "Pin"])
            if not dark:
                shot(page, "pins-phone-390-long-press-light")
            sheet.get_by_role("menuitem", name="Pin", exact=True).click()
            expect(self.message(page, LOGIN).locator(".pin-line")).to_have_text("Pinned by Ada Kowalska (you)")
            header = page.locator("header.phead")
            header.get_by_role("button", name="More").click()
            more = page.get_by_role("menu", name="More")
            labels = [text.strip().split("\n")[0] for text in more.get_by_role("menuitem").all_inner_texts()]
            self.assertEqual(labels[:2], ["Search", "Pinned"], labels)
            expect(more.get_by_role("menuitem", name="Pinned").locator(".top__more-count")).to_have_text("1")
            shot(page, f"pins-phone-390-more-{'dark' if dark else 'light'}")
            more.get_by_role("menuitem", name="Pinned").click()
            panel = page.locator("#details")
            expect(panel.get_by_role("heading", name="Pinned · 1")).to_be_visible()
            expect(panel.get_by_role("button", name="Unpin Jonas Berg’s message")).to_be_visible()  # always shown on a touch screen
            shot(page, f"pins-phone-390-sheet-{'dark' if dark else 'light'}")
            panel.locator(".pins__open").first.tap()
            expect(panel.get_by_role("heading", name="Pinned · 1")).to_have_count(0)
            expect(self.message(page, LOGIN)).to_be_in_viewport()


if __name__ == "__main__":
    unittest.main()
