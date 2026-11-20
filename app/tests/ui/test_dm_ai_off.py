"""AI off in a direct message (C-73, #1591): anyone in it turns AI off in People and privacy, the header says who did ("AI off · turned off by
Kai"), a line records each change, `/ai` there says it is off and keeps the words, and only the person who turned it off can turn it back on.
Runs with the other tests/ui modules through scripts/check_ui.sh. Ada and Kai talk in a 1:1."""

from __future__ import annotations

import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, open_details, shot, start_forwarder

PASSWORD = "no ai in here please"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ada": ("Ada Nowak", f"ada.aioff+{STAMP}@example.test"),
    "kai": ("Kai Lis", f"kai.aioff+{STAMP}@example.test"),
}


class DirectMessageAiOff(unittest.TestCase):
    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}
    dm = ""

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
        post = lambda path, body: ada.request.post(path, data=body, headers={"origin": ORIGIN})  # noqa: E731
        workspace = post("/api/v1/workspaces", {"name": "Quiet lamp works"})
        assert workspace.status == 201, workspace.text()
        added = post(f"/api/v1/workspaces/{workspace.json()['id']}/members", {"email": PEOPLE["kai"][1], "role": "member"})
        assert added.status == 201, added.text()
        dm = post(f"/api/v1/workspaces/{workspace.json()['id']}/dms", {"participantIds": [cls.ids["kai"]]})
        assert dm.status in (200, 201), dm.text()
        cls.dm = dm.json()["id"]
        for body in ("Kai, the supplier sent the invoice for the brass lamps.", "Thanks, I will pay it on Friday."):
            sent = post(f"/api/v1/dms/{cls.dm}/messages", {"body": body, "clientMessageId": str(uuid.uuid4())})
            assert sent.status == 201, sent.text()
        ada.close()

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
        page.goto(f"/dm/{self.dm}")
        expect(page.get_by_text("Thanks, I will pay it on Friday.")).to_be_visible()
        return page

    def test_ai_off_switch_header_lines_and_ai_refusal(self) -> None:
        kai = self.page("kai")
        open_details(kai)
        details = kai.locator("#details")
        expect(details.get_by_role("heading", name="AI", exact=True)).to_be_visible()
        expect(details).to_contain_text("Anyone here can turn off AI. Then nobody’s agent can read this conversation, and /ai doesn’t work here.")
        details.get_by_role("button", name="Turn off AI in this conversation").click()
        expect(details.get_by_role("button", name="Turn AI back on")).to_be_visible()
        expect(details).to_contain_text("You turned off AI.")
        expect(kai.locator(".top__topic")).to_have_text("AI off · turned off by you")
        expect(kai.get_by_text("You turned off AI in this conversation")).to_be_visible(timeout=15000)
        shot(kai, "dm-ai-off-desktop-1440-details-light")

        # Ada sees who turned it off, the line, and cannot turn Kai's back on: her button adds her own.
        ada = self.page("ada")
        expect(ada.locator(".top__topic")).to_have_text("AI off · turned off by Kai")
        expect(ada.get_by_text("Kai turned off AI in this conversation")).to_be_visible()
        composer = ada.locator("#dm-composer")
        composer.fill("/ai what did Kai say about the invoice?")
        composer.press("Enter")
        expect(ada.get_by_role("alert")).to_contain_text("AI is off in this conversation · turned off by Kai. Remove /ai to send these words as a message.")
        expect(composer).to_have_value("/ai what did Kai say about the invoice?")
        expect(ada.locator(".composer__audience")).to_have_count(0)
        shot(ada, "dm-ai-off-desktop-1440-ai-refused-light")
        open_details(ada)
        ada_details = ada.locator("#details")
        expect(ada_details).to_contain_text("Kai turned off AI. Only they can turn it back on.")
        expect(ada_details.get_by_role("button", name="Turn AI back on")).to_have_count(0)
        expect(ada_details.get_by_role("button", name="Turn off AI in this conversation")).to_be_visible()

        dark = self.page("ada", dark=True)
        expect(dark.locator(".top__topic")).to_have_text("AI off · turned off by Kai")
        shot(dark, "dm-ai-off-desktop-1440-dark")

        phone = self.page("ada", phone=True)
        expect(phone.locator("header.phead .phead__sub")).to_have_text("AI off · turned off by Kai")
        shot(phone, "dm-ai-off-phone-390-light")
        phone_dark = self.page("ada", phone=True, dark=True)
        expect(phone_dark.locator("header.phead .phead__sub")).to_have_text("AI off · turned off by Kai")
        open_details(phone_dark)
        expect(phone_dark.get_by_text("Kai turned off AI. Only they can turn it back on.")).to_be_visible()
        shot(phone_dark, "dm-ai-off-phone-390-details-dark")

        # Kai, and only Kai, turns it back on: the header returns to the name alone and a line says so.
        details.get_by_role("button", name="Turn AI back on").click()
        expect(details.get_by_role("button", name="Turn off AI in this conversation")).to_be_visible()
        expect(kai.locator(".top__topic")).to_have_count(0)
        expect(kai.get_by_text("You turned AI back on")).to_be_visible(timeout=15000)
        expect(ada.get_by_text("Kai turned AI back on")).to_be_visible(timeout=15000)


if __name__ == "__main__":
    unittest.main()
