"""Files, photos and videos in direct messages (#1438 point 10): the paperclip is live in a direct message and its thread, a sent file or
photo shows to both people as it does in a space, the bytes reach only the conversation's people, and the draft behaves as a space's does.
Runs with the other tests/ui modules through scripts/check_ui.sh. Ada and Kai talk; Lee, in the same company, is outside."""

from __future__ import annotations

import base64
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, shot, start_forwarder

PASSWORD = "files for friends only"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ada": ("Ada Files", f"ada.files+{STAMP}@example.test"),
    "kai": ("Kai Files", f"kai.files+{STAMP}@example.test"),
    "lee": ("Lee Files", f"lee.files+{STAMP}@example.test"),
}
NOTES = b"lux,gestures\n5,38%\n"
# A real 1x1 PNG: a photo the browser can draw.
PHOTO = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")


class DirectMessageFiles(unittest.TestCase):
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
        workspace = post("/api/v1/workspaces", {"name": "Files friends"})
        assert workspace.status == 201, workspace.text()
        for key in ("kai", "lee"):
            added = post(f"/api/v1/workspaces/{workspace.json()['id']}/members", {"email": PEOPLE[key][1], "role": "member"})
            assert added.status == 201, added.text()
        dm = post(f"/api/v1/workspaces/{workspace.json()['id']}/dms", {"participantIds": [cls.ids["kai"]]})
        assert dm.status in (200, 201), dm.text()
        cls.dm = dm.json()["id"]
        ada.close()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def context(self, who: str, *, phone: bool = False) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "color_scheme": "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw", "storage_state": self.states[who]}
        options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True) if phone else options.update(viewport=DESKTOP, device_scale_factor=1)
        context = self.browser.new_context(service_workers="block", **options)
        self.addCleanup(context.close)
        return context

    def page(self, who: str, **kwargs) -> Page:
        page = self.context(who, **kwargs).new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def attach(self, page: Page, files: list[dict], within=None) -> None:
        with page.expect_file_chooser() as chooser:
            (within or page).get_by_role("button", name="Attach files").click()
        chooser.value.set_files(files)

    def test_01_the_paperclip_sends_a_file_and_a_photo_that_both_people_read(self) -> None:
        for phone in (False, True):
            with self.subTest(phone=phone):
                ada = self.page("ada", phone=phone)
                ada.goto(f"/dm/{self.dm}")
                field = ada.get_by_label(re.compile(r"^Message "))
                expect(field).to_be_visible()
                # The paperclip is a real control here, not the greyed "(not available here)" one.
                expect(ada.get_by_role("button", name=re.compile("not available here"))).to_have_count(0)
                clip = ada.get_by_role("button", name="Attach files")
                box = clip.bounding_box()
                self.assertGreaterEqual(min(box["width"], box["height"]), 44 if phone else 24)
                name = f"notes-{'phone' if phone else 'desk'}.csv"
                self.attach(ada, [{"name": name, "mimeType": "text/csv", "buffer": NOTES}, {"name": "bed.png", "mimeType": "image/png", "buffer": PHOTO}])
                if phone:
                    sheet = ada.get_by_role("dialog", name="Choose files to send")
                    for item in (name, "bed.png"):
                        sheet.get_by_role("button", name=item).click()
                    sheet.get_by_role("button", name="Add 2").click()
                draft = ada.get_by_role("list", name="Files in your draft")
                expect(draft.get_by_role("listitem")).to_have_count(2)
                expect(draft.get_by_text("Ready, private", exact=False)).to_have_count(2)
                field.fill(f"The readings and the bed {'phone' if phone else 'desk'}")
                shot(ada, f"dm-files-draft-{'390' if phone else '1440'}")
                ada.get_by_role("button", name="Send message").click()
                expect(draft).to_have_count(0)
                message = ada.locator(".dm-msg", has_text=f"The readings and the bed {'phone' if phone else 'desk'}")
                expect(message).to_be_visible()
                expect(message.get_by_role("link", name=f"Download {name}")).to_have_attribute("href", re.compile(r"^/api/v1/files/[0-9a-f-]{36}$"))
                expect(message.locator(".photo-grid__tile[data-photo-state='ready']")).to_have_count(1)
                shot(ada, f"dm-files-sent-{'390' if phone else '1440'}")
                # Kai reads the same message with the same files, and the bytes.
                kai = self.page("kai", phone=phone)
                kai.goto(f"/dm/{self.dm}")
                there = kai.locator(".dm-msg", has_text=f"The readings and the bed {'phone' if phone else 'desk'}")
                expect(there.get_by_role("link", name=f"Download {name}")).to_be_visible()
                expect(there.locator(".photo-grid__tile[data-photo-state='ready']")).to_have_count(1)
                href = there.get_by_role("link", name=f"Download {name}").get_attribute("href")
                self.assertEqual(kai.request.get(href).body(), NOTES)

    def test_02_a_message_of_a_file_alone_and_a_reply_in_the_thread_carry_files(self) -> None:
        ada = self.page("ada")
        ada.goto(f"/dm/{self.dm}")
        self.attach(ada, [{"name": "only-the-file.txt", "mimeType": "text/plain", "buffer": b"nothing else to say"}])
        draft = ada.get_by_role("list", name="Files in your draft")
        expect(draft.get_by_role("listitem")).to_have_count(1)
        # A file alone can be sent: Send is live with no words.
        send = ada.get_by_role("button", name="Send message")
        expect(send).not_to_have_attribute("aria-disabled", "true")
        send.click()
        message = ada.locator(".dm-msg", has=ada.get_by_role("link", name="Download only-the-file.txt"))
        expect(message).to_be_visible()
        expect(message.locator(".dm-msg__body")).to_have_count(0)  # no empty bubble of words above the file
        # The conversation's list says what the last message is.
        ada.goto("/dm")
        expect(ada.get_by_role("link", name=re.compile("Sent a file")).first).to_be_visible()
        # A reply in the thread carries a file too.
        kai = self.page("kai")
        kai.goto(f"/dm/{self.dm}")
        kai.locator(".dm-msg", has=kai.get_by_role("link", name="Download only-the-file.txt")).hover()
        kai.locator(".dm-msg", has=kai.get_by_role("link", name="Download only-the-file.txt")).get_by_role("button", name=re.compile("Reply in thread")).first.click()
        thread = kai.locator("#thread")
        expect(thread).to_be_visible()
        self.attach(kai, [{"name": "answer.txt", "mimeType": "text/plain", "buffer": b"an answer"}], within=thread)
        thread.get_by_role("button", name="Send reply").click()
        expect(thread.get_by_role("link", name="Download answer.txt")).to_be_visible()

    def test_03_someone_outside_the_conversation_reaches_neither_the_conversation_nor_its_files(self) -> None:
        kai = self.page("kai")
        kai.goto(f"/dm/{self.dm}")
        href = kai.get_by_role("link", name=re.compile(r"^Download notes-desk\.csv$")).first.get_attribute("href")
        self.assertTrue(href)
        self.assertEqual(kai.request.get(href).status, 200)
        lee = self.page("lee")
        self.assertEqual(lee.request.get(href).status, 404)
        lee.goto(f"/dm/{self.dm}")
        expect(lee.get_by_text(re.compile("isn.t available", re.I)).first).to_be_visible()
        expect(lee.get_by_role("link", name=re.compile("^Download "))).to_have_count(0)

    def test_04_asking_the_agent_takes_no_file_and_the_paperclip_comes_back(self) -> None:
        ada = self.page("ada")
        ada.goto(f"/dm/{self.dm}")
        field = ada.get_by_label(re.compile(r"^Message "))
        field.fill("/ai what is in the readings?")
        # A question to the agent is text only here: its private answer is not a message of the conversation.
        expect(ada.get_by_role("button", name=re.compile("Attach files \\(not available here\\)"))).to_be_visible()
        field.fill("")
        expect(ada.get_by_role("button", name="Attach files")).to_be_visible()


if __name__ == "__main__":
    unittest.main()
