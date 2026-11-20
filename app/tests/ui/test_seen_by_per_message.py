"""Browser tests for "Seen by" per message (#1551, founder report, Hubert, 2026-11-19).

A reader's face stands under the newest message of the author's that they have read, in the middle of a group too, and moves down as they read on.
Sending another message never takes a receipt back: under "the newest group fully read" a message added to the group hid the face until the
reader read that one too. Checked in a space and in a direct message, at 1440x900 and 390x844 (touch), light and dark.
Screenshots (seen-by-message-*.png) go to FLUX_UI_SCREENSHOTS when set.
"""

from __future__ import annotations

import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, shot, start_forwarder

PASSWORD = "a calm long passphrase for reading"
STAMP = int(time.time() * 1000)
PEOPLE = {"ada": ("Ada Kowalska", f"ada.sb+{STAMP}@example.test"), "kai": ("Kai Tanaka", f"kai.sb+{STAMP}@example.test")}


class SeenByPerMessage(unittest.TestCase):
    """Tests run in name order and share the people, the space, the direct message and the messages."""

    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}
    workspace_id = ""
    project_id = ""
    dm_id = ""
    space_messages: list[str] = []
    dm_messages: list[str] = []

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=15000)
        for key, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(service_workers="block", base_url=ORIGIN)
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.states[key] = context.storage_state()
            context.close()
        cls.workspace_id = cls.post("ada", "/api/v1/workspaces", {"name": "Reading room"}, 201)["id"]
        cls.post("ada", f"/api/v1/workspaces/{cls.workspace_id}/members", {"email": PEOPLE["kai"][1], "role": "member"}, 201)
        cls.project_id = cls.post("ada", f"/api/v1/workspaces/{cls.workspace_id}/projects", {"name": "Lamp prototype", "visibility": "workspace"}, 201)["id"]
        cls.dm_id = cls.post("ada", f"/api/v1/workspaces/{cls.workspace_id}/dms", {"participantIds": [cls.ids["kai"]]}, 201)["id"]
        # A group of two of Ada's own messages, in a space and in a direct message.
        cls.space_messages = [cls.say_space("Wave to dim, hold to switch it off."), cls.say_space("I will sketch it tonight.")]
        cls.dm_messages = [cls.say_dm("czytam stary"), cls.say_dm("A picture of the new lamp, to follow")]

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    @classmethod
    def post(cls, who: str, path: str, body: dict, expected: int) -> dict:
        context = cls.browser.new_context(service_workers="block", base_url=ORIGIN, storage_state=cls.states[who])
        try:
            response = context.request.post(path, data=body, headers={"origin": ORIGIN})
            assert response.status == expected, f"{path}: {response.status} {response.text()}"
            return response.json() if response.text() else {}
        finally:
            context.close()

    @classmethod
    def say_space(cls, body: str, who: str = "ada") -> str:
        return cls.post(who, f"/api/v1/projects/{cls.project_id}/conversations", {"body": body, "clientMessageId": str(uuid.uuid4())}, 201)["messages"][0]["id"]

    @classmethod
    def say_dm(cls, body: str, who: str = "ada") -> str:
        return cls.post(who, f"/api/v1/dms/{cls.dm_id}/messages", {"body": body, "clientMessageId": str(uuid.uuid4())}, 201)["id"]

    @classmethod
    def read_space(cls, message_id: str) -> None:
        cls.post("kai", f"/api/v1/projects/{cls.project_id}/observations", {"messageIds": [message_id]}, 200)

    @classmethod
    def read_dm(cls, message_id: str) -> None:
        cls.post("kai", f"/api/v1/dms/{cls.dm_id}/observations", {"messageIds": [message_id]}, 200)

    def page(self, who: str = "ada", *, phone: bool = False, dark: bool = False) -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": "dark" if dark else "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw", "storage_state": self.states[who]}
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

    @staticmethod
    def faces(page: Page, message_id: str):
        return page.locator(f"#message-{message_id} .seen")

    def check_moves_down(self, page: Page, messages: list[str], read, say) -> None:
        """The reader has seen only the first of a group of two: the face is under the first; reading on moves it to the second; a third message never takes it back."""
        first, second = messages
        read(first)
        expect(self.faces(page, first)).to_have_attribute("aria-label", "Seen by Kai", timeout=20000)
        expect(self.faces(page, second)).to_have_count(0)
        # The face under a message inside the group stands alone, with no time, and the group is still one group.
        expect(page.locator(f"#message-{first} .message-time--seen")).to_have_count(1)
        expect(page.locator(f"#message-{first} .message-time--seen time")).to_have_count(0)
        expect(page.locator(f"#message-{second} .message-time:not(.message-time--seen) time")).to_have_count(1)
        read(second)
        expect(self.faces(page, second)).to_have_attribute("aria-label", "Seen by Kai", timeout=20000)
        expect(self.faces(page, first)).to_have_count(0)
        expect(page.locator(f"#message-{first} .message-time--seen")).to_have_count(0)
        # Another message joins the group: Kai has not read it, and the receipt of the one he read stays where it was.
        third = say("A picture of the finished lamp")
        expect(page.locator(f"#message-{third}")).to_be_visible(timeout=20000)
        page.wait_for_timeout(1500)
        expect(self.faces(page, second)).to_have_attribute("aria-label", "Seen by Kai")
        expect(self.faces(page, third)).to_have_count(0)
        messages.append(third)

    # ---------------------------------------------------------------- the space

    def test_01_a_space_the_face_stands_under_the_newest_message_read_and_never_goes(self) -> None:
        page = self.page()
        page.goto(f"/projects/{self.project_id}")
        expect(page.locator(f"#message-{self.space_messages[1]}")).to_be_visible()
        self.check_moves_down(page, self.space_messages, self.read_space, self.say_space)
        # One group still: the later messages are continued (no new author line) and the gap holds the face row without breaking the group.
        for message_id in self.space_messages[1:]:
            expect(page.locator(f"#message-{message_id}")).to_have_class(re.compile(r"\bis-continued\b"))
        shot(page, "seen-by-message-space-computer-light")

    # ---------------------------------------------------------------- the direct message

    def test_02_a_direct_message_the_same_and_the_founders_case(self) -> None:
        page = self.page()
        page.goto(f"/dm/{self.dm_id}")
        expect(page.locator(f"#message-{self.dm_messages[1]}")).to_be_visible()
        # "czytam stary" is read by Kai, then another message (a picture with a caption) joins the group: the face stays under what he read.
        self.check_moves_down(page, self.dm_messages, self.read_dm, self.say_dm)
        for message_id in self.dm_messages[1:]:
            expect(page.locator(f"#message-{message_id}")).to_have_class(re.compile(r"\bdm-msg--cont\b"))
        # A direct message with one person shows their single face, never "+N".
        expect(self.faces(page, self.dm_messages[1]).locator(".seen__more")).to_have_count(0)

    def test_03_the_group_keeps_its_spacing_with_a_face_row_inside_it(self) -> None:
        page = self.page()
        page.goto(f"/dm/{self.dm_id}")
        first, second, third = self.dm_messages[:3]
        expect(page.locator(f"#message-{third}")).to_be_visible()
        # Kai's face stands under the second message, so a face row is between the second and third bubbles of one group, and none between the first and second.
        expect(self.faces(page, second)).to_have_count(1)
        body = lambda message_id: page.locator(f"#message-{message_id} .dm-msg__body")
        boxes = [body(message_id).bounding_box() for message_id in (first, second, third)]
        assert all(boxes)
        plain = boxes[1]["y"] - (boxes[0]["y"] + boxes[0]["height"])
        with_faces = boxes[2]["y"] - (boxes[1]["y"] + boxes[1]["height"])
        # The face row is a line of its own, as high as the time line (--fs-xs x 1.5) plus its 5 px; the next bubble keeps its own 4 px: a group's gap, not two groups'.
        self.assertGreater(with_faces, plain, "the face row takes room inside the group")
        self.assertLess(with_faces - plain, 32, "and no more than a line of it")
        expect(page.locator(f"#message-{third}")).to_have_class(re.compile(r"\bdm-msg--cont\b"))
        expect(page.locator(f"#message-{third} .dm-msg__meta")).to_have_count(0)

    # ---------------------------------------------------------------- the phone and dark

    def test_04_the_phone_and_the_dark_theme(self) -> None:
        for phone, dark in ((True, False), (True, True), (False, True)):
            page = self.page(phone=phone, dark=dark)
            page.goto(f"/projects/{self.project_id}")
            expect(page.locator(f"#message-{self.space_messages[-1]}")).to_be_visible()
            expect(self.faces(page, self.space_messages[1])).to_have_attribute("aria-label", "Seen by Kai", timeout=20000)
            overflow = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
            self.assertLessEqual(overflow, 0, "no sideways scroll")
            if phone:
                # A finger needs more than the 16 px face: the target grows to 44 px each way (receipt-faces.css), the row does not.
                box = self.faces(page, self.space_messages[1]).bounding_box()
                assert box and box["height"] <= 18, "the face row stays 16 px high"
            shot(page, f"seen-by-message-{'phone' if phone else 'computer'}-{'dark' if dark else 'light'}")


if __name__ == "__main__":
    unittest.main()
