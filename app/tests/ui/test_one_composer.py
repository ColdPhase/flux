"""One composer in the conversation, a thread, a direct message, the task panel and the Sketchbook (#504).

Writing looks and works the same everywhere: "+", the field and the inverted round send button, in the same
places; only the placeholder says where the text goes; the audience line sits under the box in one form.
Screenshots (one-composer-<place>-<device>.png) go to FLUX_UI_SCREENSHOTS when set.
"""
from __future__ import annotations

import time
import unittest
import uuid

from playwright.sync_api import Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

PASSWORD = "one composer everywhere"
STAMP = int(time.time() * 1000)
PEOPLE = {"ada": ("Ada Kowalska", f"ada.oc+{STAMP}@example.test"), "jonas": ("Jonas Berg", f"jonas.oc+{STAMP}@example.test")}
PLACEHOLDERS = {
    "conversation": "Message · @ mention · / actions", "thread": "Reply in thread…", "dm": "Message Jonas…",
    "task": "Write about #1…", "dm-thread": "Reply in thread…", "notes": "Write a note…",
}


class OneComposer(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        expect.set_options(timeout=10000)
        cls.states, cls.ids = {}, {}
        for key, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(service_workers="block", base_url=ORIGIN)
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.states[key] = context.storage_state()
            context.close()
        context = cls.browser.new_context(service_workers="block", base_url=ORIGIN, storage_state=cls.states["ada"])
        try:
            def post(path: str, body: dict) -> dict:
                response = context.request.post(path, data=body, headers={"origin": ORIGIN})
                assert response.status in (200, 201), f"{path}: {response.status} {response.text()}"
                return response.json()
            workspace = post("/api/v1/workspaces", {"name": "Lamp workshop"})["id"]
            post(f"/api/v1/workspaces/{workspace}/members", {"email": PEOPLE["jonas"][1], "role": "member"})
            cls.project = post(f"/api/v1/workspaces/{workspace}/projects", {"name": "Night lamp", "visibility": "workspace"})["id"]
            task = post(f"/api/v1/projects/{cls.project}/work", {"title": "Measure the lamp after dark"})["id"]
            cls.task = task
            cls.conversation = post(f"/api/v1/work/{task}/discussion", {"body": "Start with actual measurements", "clientMessageId": str(uuid.uuid4()), "kind": "text"})["conversationId"]
            cls.dm = post(f"/api/v1/workspaces/{workspace}/dms", {"participantIds": [cls.ids["jonas"]]})["id"]
            root = post(f"/api/v1/dms/{cls.dm}/messages", {"body": "Should the lamp dim with a wave?", "clientMessageId": str(uuid.uuid4())})["id"]
            cls.dm_root = root
        finally:
            context.close()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, *, phone: bool = False, dark: bool = False) -> Page:
        options = {"base_url": ORIGIN, "storage_state": self.states["ada"], "locale": "en-GB", "color_scheme": "dark" if dark else "light"}
        options.update(viewport=PHONE, device_scale_factor=2, is_mobile=True, has_touch=True) if phone else options.update(viewport=DESKTOP)
        context = self.browser.new_context(service_workers="block", **options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def places(self, page: Page):
        """Each place: its url, the box's field, and the root that holds the audience line."""
        yield "conversation", f"/projects/{self.project}", "#project-composer"
        yield "thread", f"/projects/{self.project}/conversations/{self.conversation}", "#thread-composer"
        yield "dm", f"/dm/{self.dm}", "#dm-composer"
        yield "dm-thread", f"/dm/{self.dm}?thread={self.dm_root}", "#dm-thread-composer"
        yield "task", f"/projects/{self.project}/tasks?open=work:{self.task}", f"#details .wd-discussion-form textarea"
        yield "notes", "/map", "#composer"

    def measure(self, field):
        return field.evaluate("""el => {
          const box = el.closest('.composer__box'); const b = box.getBoundingClientRect();
          const kids = [...box.children].filter((c) => c.matches('button, textarea'));
          const plus = kids[0].getBoundingClientRect(), send = kids[kids.length - 1].getBoundingClientRect();
          const rest = box.parentElement.querySelectorAll('.composer__audience');
          return { kinds: kids.map((c) => c.tagName + (c.classList.contains('composer__attach') ? '.attach' : c.classList.contains('composer__send') ? '.send' : '')),
            height: Math.round(b.height), plusLeft: Math.round(plus.left - b.left), sendRight: Math.round(b.right - send.right), sendSize: Math.round(send.width),
            plusSize: Math.round(plus.width), radius: getComputedStyle(box).borderRadius,
            audience: [...rest].map((a) => ({ below: a.getBoundingClientRect().top >= b.bottom - 1, icon: !!a.querySelector(':scope > svg'), size: getComputedStyle(a).fontSize })) };
        }""")

    def test_01_every_place_has_the_same_plus_field_and_round_send(self) -> None:
        for phone in (False, True):
            page = self.page(phone=phone)
            seen = {}
            for name, url, selector in self.places(page):
                with self.subTest(place=name, phone=phone):
                    page.goto(url)
                    field = page.locator(selector)
                    expect(field).to_be_visible()
                    expect(field).to_have_attribute("placeholder", PLACEHOLDERS[name])
                    box = field.locator("xpath=ancestor::div[contains(@class,'composer__box')]")
                    expect(box.get_by_role("button", name="Attach files", exact=True)).to_be_visible()
                    field.scroll_into_view_if_needed()
                    seen[name] = self.measure(field)
                    self.assertEqual(seen[name]["kinds"], ["BUTTON.attach", "TEXTAREA", "BUTTON.send"], name)
                    shot(page, f"one-composer-{name}-{'phone' if phone else 'computer'}")
            for key in ("height", "plusLeft", "sendRight", "sendSize", "plusSize", "radius"):
                values = {name: item[key] for name, item in seen.items()}
                spread = set(values.values())
                self.assertEqual(len(spread), 1, f"{key} differs between places on {'phone' if phone else 'computer'}: {values}")

    def test_02_the_audience_line_is_under_the_box_in_one_form(self) -> None:
        page = self.page()
        for name, url, selector in self.places(page):
            with self.subTest(place=name):
                page.goto(url)
                expect(page.locator(selector)).to_be_visible()
                measured = self.measure(page.locator(selector))
                self.assertTrue(measured["audience"], f"{name} shows its audience")
                for line in measured["audience"]:
                    self.assertTrue(line["below"] and line["icon"], f"{name}: under the box, lock first")
                    self.assertEqual(line["size"], measured["audience"][0]["size"])

    def test_03_the_plus_takes_files_where_they_are_kept_and_is_greyed_where_not(self) -> None:
        page = self.page()
        page.goto(f"/dm/{self.dm}")
        plus = page.locator("#dm-composer").locator("xpath=ancestor::div[contains(@class,'composer__box')]").get_by_role("button", name="Attach files", exact=True)
        expect(plus).to_have_attribute("aria-disabled", "true")
        page.goto(f"/projects/{self.project}")
        with page.expect_file_chooser() as chooser:
            page.locator("#project-composer").locator("xpath=ancestor::div[contains(@class,'composer__box')]").get_by_role("button", name="Attach files", exact=True).click()
        chooser.value.set_files({"name": "measurements.bin", "mimeType": "application/octet-stream", "buffer": b"\x00\x01"})
        expect(page.get_by_role("list", name="Files in your draft")).to_be_visible()

    def test_04_typing_enables_the_send_button_in_every_place(self) -> None:
        page = self.page()
        for name, url, selector in self.places(page):
            if name == "notes":
                continue
            with self.subTest(place=name):
                page.goto(url)
                field = page.locator(selector)
                send = field.locator("xpath=following-sibling::button[contains(@class,'composer__send')]")
                expect(send).to_have_attribute("aria-disabled", "true")
                field.fill("Wave to dim")
                expect(send).to_have_attribute("aria-disabled", "false")
                field.fill("")


if __name__ == "__main__":
    unittest.main()
