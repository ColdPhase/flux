"""Browser tests for the v0.2.1 persona round 26 (train/v021-26): guests, first run, the composer's traps and one word per thing.

Runs with the other tests/ui modules through scripts/check_ui.sh against the running Compose application. FLUX_UI_BROWSER selects chromium
(default) or webkit. Ola owns Nowak Bakery; Mia is a member; Gia is a guest in Morning shift; Gus is a guest in no space. Covered:

- P2 #3: a guest is offered no New message (the sidebar's "+", the Messages page, the phone's Spaces), a person's name over a message is not a
  link to a conversation she cannot start, and /dm/new by address says the rule in one line (no form, no broken "Only you and").
- P2 #7: the first run's "Company name" opens with "Company" selected, so typing replaces it.
- P3 composer: × on "Your assistant" keeps the words; Send without AI opens Connect AI; a damaged picture says it can't be read and offers no
  Retry, and the rest goes once it is removed; a picture shows one size, the stored one.
- P3 words: a guest with no space has only Thought in New; the owner picker and the @ list say Guest; the company's owner is Owner in Space
  settings; "(you)" marks you; the AI switch reads the same in New space and Space settings; the company's role control is a menu that
  changes the role; a phone shows no "Escape cancels".
Desktop 1440 and phone 390; screenshots (persona26-*-<browser>.png) go to FLUX_UI_SCREENSHOTS when set.
"""

from __future__ import annotations

import json
import re
import struct
import time
import unittest
import uuid
import zlib

from playwright.sync_api import Browser, Page, expect, sync_playwright

from app_select import choose, open_select
from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, show_map_as, start_forwarder
from test_settings import UI_BROWSER, shot

PASSWORD = "persona round twenty six words"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ola": ("Ola Nowak", f"ola.p26c+{STAMP}@example.test"),
    "mia": ("Mia Kran", f"mia.p26c+{STAMP}@example.test"),
    "gia": ("Gia Mlyn", f"gia.p26c+{STAMP}@example.test"),
    "gus": ("Gus Lis", f"gus.p26c+{STAMP}@example.test"),
}
OPENING = "Welcome to the morning shift. Rota and questions go here."


def png(width: int, height: int, note: bytes = b"") -> bytes:
    """A real picture; a text chunk (which the server drops when it cleans the picture) makes the file the browser picks larger than the stored one."""
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    rows = b"".join(b"\0" + bytes((200, 160, 90)) * width for _ in range(height))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + (chunk(b"tEXt", b"Comment\0" + note) if note else b"") + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


def file_size(size: int) -> str:
    """The app's own size words (composer/fileKind.ts)."""
    return f"{size} B" if size < 1024 else f"{size / 1024:.1f} KB" if size < 1024 * 1024 else f"{size / (1024 * 1024):.1f} MB"


class PersonaRound26Words(unittest.TestCase):
    """Tests run in name order and share the accounts and the company."""

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
            context = cls.browser.new_context(base_url=ORIGIN, service_workers="block")
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.states[key] = context.storage_state()
            context.close()
        context = cls.browser.new_context(base_url=ORIGIN, service_workers="block", storage_state=cls.states["ola"])
        post = lambda path, body: context.request.post(path, data=body, headers={"origin": ORIGIN, "idempotency-key": str(uuid.uuid4())})  # noqa: E731
        company = post("/api/v1/workspaces", {"name": "Nowak Bakery"})
        assert company.status == 201, company.text()
        cls.ids["company"] = company.json()["id"]
        for key, role in (("mia", "member"), ("gia", "guest"), ("gus", "guest")):
            added = post(f"/api/v1/workspaces/{cls.ids['company']}/members", {"email": PEOPLE[key][1], "role": role})
            assert added.status == 201, added.text()
        space = post(f"/api/v1/workspaces/{cls.ids['company']}/projects", {"name": "Morning shift", "visibility": "restricted"})
        assert space.status == 201, space.text()
        cls.ids["space"] = space.json()["id"]
        for key in ("mia", "gia"):
            granted = post(f"/api/v1/projects/{cls.ids['space']}/grants", {"principal": {"kind": "human", "id": cls.ids[key]}, "role": "contributor"})
            assert granted.status == 201, granted.text()
        opened = post(f"/api/v1/projects/{cls.ids['space']}/conversations", {"body": OPENING, "clientMessageId": str(uuid.uuid4())})
        assert opened.status == 201, opened.text()
        context.close()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, who: str, phone: bool = False) -> Page:
        options = {"viewport": PHONE, "is_mobile": True, "has_touch": True, "device_scale_factor": 2} if phone and UI_BROWSER != "firefox" else {"viewport": DESKTOP, "device_scale_factor": 1}
        context = self.browser.new_context(base_url=ORIGIN, locale="en-GB", timezone_id="Europe/Warsaw", service_workers="block", storage_state=self.states[who], **options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def api(self, page: Page, method: str, path: str, body: dict | None = None, status: int | None = None) -> dict | list:
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers={"origin": ORIGIN, "content-type": "application/json",
                                      "idempotency-key": str(uuid.uuid4())}, data=json.dumps(body) if body is not None else None)
        if status is not None:
            self.assertEqual(response.status, status, response.text())
        return json.loads(response.text()) if response.text() else {}

    def attach(self, page: Page, files: list[dict]) -> None:
        with page.expect_file_chooser() as chooser:
            page.get_by_role("button", name="Attach files").click()
        chooser.value.set_files(files)

    # ---------------------------------------------------------------- P2 #3: a guest is offered no New message

    def test_01_a_guest_is_offered_no_new_message_on_the_computer(self) -> None:
        page = self.page("gia")
        page.goto("/")
        sidebar = page.get_by_role("complementary", name="Sidebar")
        # With no conversation and no agent, a guest has no Messages heading over nothing (audit P3 5, personas-28).
        expect(page.get_by_role("main")).to_be_visible()
        expect(sidebar.get_by_role("link", name="Messages", exact=True)).to_have_count(0)
        expect(sidebar.get_by_role("link", name="New message")).to_have_count(0)
        page.goto("/dm")
        # One line under the title, never "No messages yet" and "No conversations yet" together.
        expect(page.get_by_role("heading", name="No messages yet")).to_be_visible()
        expect(page.get_by_text("When someone writes to you, it appears here.", exact=True)).to_be_visible()
        expect(page.get_by_text("No conversations yet")).to_have_count(0)
        expect(page.get_by_role("link", name="New message")).to_have_count(0)
        # The owner's name over her message is her name, not a way into a conversation the guest cannot start.
        page.goto(f"/projects/{self.ids['space']}")
        message = page.locator(".project-convo__message").filter(has_text=OPENING)
        expect(message.locator(".project-convo__message-meta")).to_contain_text("Ola Nowak")
        expect(message.get_by_role("link", name="Ola Nowak")).to_have_count(0)
        expect(page.locator('a[href*="/dm/new"]')).to_have_count(0)
        shot(page, "persona26-guest-name-not-a-link")
        # Reached by address, the page says the rule once, and offers the way back: no form, no "Only you and".
        page.goto(f"/dm/new?workspace={self.ids['company']}&with={self.ids['ola']}")
        expect(page.get_by_role("heading", name="Guests don’t start conversations")).to_be_visible()
        expect(page.get_by_text("You can reply in conversations you’re added to.")).to_be_visible()
        expect(page.get_by_role("link", name="Back to Messages")).to_be_visible()
        expect(page.get_by_text(re.compile(r"Only you and\s*$"))).to_have_count(0)
        expect(page.get_by_role("checkbox")).to_have_count(0)
        shot(page, "persona26-guest-dm-new")
        # A member is still offered both.
        mia = self.page("mia")
        mia.goto(f"/projects/{self.ids['space']}")
        expect(mia.locator(".project-convo__message").filter(has_text=OPENING).get_by_role("link", name="Ola Nowak")).to_be_visible()
        mia.goto("/dm")
        expect(mia.get_by_role("main").get_by_role("link", name="New message")).to_be_visible()

    def test_02_a_guest_is_offered_no_new_message_on_the_phone(self) -> None:
        page = self.page("gia", phone=True)
        page.goto("/projects")
        # With no conversation and no agent a guest's Spaces tab has no Messages heading over nothing, as the sidebar (persona round 6).
        expect(page.locator(".proj-index__row, .proj-index__empty").first).to_be_visible()
        expect(page.locator("section.proj-index__dms")).to_have_count(0)
        expect(page.get_by_role("link", name="New message")).to_have_count(0)
        shot(page, "persona26-guest-phone-spaces")
        mia = self.page("mia", phone=True)
        mia.goto("/projects")
        expect(mia.locator("section.proj-index__dms").get_by_role("link", name="New message")).to_be_visible()

    def test_03_a_guest_with_no_space_is_offered_only_a_thought(self) -> None:
        page = self.page("gus")
        page.goto("/")
        expect(page.locator(".home__first")).to_contain_text("When someone adds you to a space, it appears under Spaces at once.")
        page.get_by_role("complementary", name="Sidebar").get_by_role("button", name=re.compile("^New")).click()
        window = page.get_by_role("dialog", name="New thought")
        expect(window).to_be_visible()
        expect(window.get_by_role("tab")).to_have_count(1)
        expect(window.get_by_role("tab", name="Thought")).to_be_visible()
        for tab in ("Task", "Decision", "Page", "Space"):
            expect(window.get_by_role("tab", name=tab, exact=True)).to_have_count(0)
        shot(page, "persona26-guest-no-space-new")

    # ---------------------------------------------------------------- P2 #7: the first run's company name

    def test_04_the_first_runs_company_name_is_replaced_by_typing(self) -> None:
        page = self.page("ola")
        # A fresh install's company is called "Company" until its owner names it (Home's first step opens this).
        self.api(page, "PATCH", f"/api/v1/workspaces/{self.ids['company']}", {"name": "Company"}, status=200)
        self.addCleanup(lambda: self.api(page, "PATCH", f"/api/v1/workspaces/{self.ids['company']}", {"name": "Nowak Bakery"}))
        page.goto("/settings/company?name=1")
        field = page.get_by_label("Company name", exact=True)
        expect(field).to_be_focused()
        expect(field).to_have_value("Company")
        self.assertEqual(field.evaluate("el => [el.selectionStart, el.selectionEnd]"), [0, len("Company")], "the default is selected")
        page.keyboard.type("Nowak Bakery")
        expect(field).to_have_value("Nowak Bakery")
        page.get_by_role("button", name="Save name").click()
        expect(page.get_by_role("region", name="Name")).to_contain_text("Nowak Bakery")
        # Saved, the address no longer opens the field, and the line keeps its full stop (personas-30).
        expect(page).to_have_url(re.compile(r"/settings/company$"))
        expect(page.get_by_role("region", name="Name")).to_contain_text("Shown on the sign-in page and in emails.")
        self.assertEqual(self.api(page, "GET", f"/api/v1/workspaces/{self.ids['company']}", status=200)["name"], "Nowak Bakery")

    # ---------------------------------------------------------------- P3: the composer's traps

    def test_05_stop_asking_keeps_the_words_and_send_without_ai_opens_connect_ai(self) -> None:
        page = self.page("mia")
        page.goto(f"/projects/{self.ids['space']}")
        composer = page.locator("#project-composer")
        composer.fill("/ai ")
        bar = page.locator("#project-ask")
        expect(bar).to_contain_text("You haven’t set up your assistant.")
        composer.fill("Thank you, I can start at six")
        # Send is not silently dead: it opens the one Connect AI window, and the words wait in the box.
        send = page.get_by_role("button", name="Send to your assistant")
        expect(send).to_be_enabled()
        send.click()
        window = page.get_by_role("dialog", name="Connect your AI")
        expect(window).to_be_visible()
        page.keyboard.press("Escape")
        expect(window).to_have_count(0)
        expect(composer).to_have_value("Thank you, I can start at six")
        # × leaves ask mode with the words still there, now as the message.
        bar.get_by_role("button", name="Stop asking your assistant").click()
        expect(bar).to_have_count(0)
        expect(page.get_by_label("Write a message", exact=True)).to_have_value("Thank you, I can start at six")
        shot(page, "persona26-stop-asking-keeps-words")
        page.get_by_label("Write a message", exact=True).fill("")

    def test_06_a_damaged_picture_says_so_and_the_rest_is_sent(self) -> None:
        page = self.page("mia")
        page.goto(f"/projects/{self.ids['space']}")
        field = page.get_by_label("Write a message", exact=True)
        field.fill("This is how the bread looked this morning")
        damaged = {"name": "IMG_2041.jpg", "mimeType": "image/jpeg", "buffer": b"\xff\xd8\xff\xe0" + b"\x13" * 2048}
        self.attach(page, [damaged])
        draft = page.get_by_role("list", name="Files in your draft")
        item = draft.get_by_role("listitem").filter(has_text="IMG_2041.jpg")
        expect(item).to_contain_text("Can’t be read")
        expect(item).not_to_contain_text("Upload not confirmed")
        expect(page.get_by_role("button", name="Retry upload")).to_have_count(0)
        line = page.locator("[data-refused-file]")
        expect(line).to_have_text("This picture cannot be read: it is damaged, or its parts do not agree on one image. Remove IMG_2041.jpg to send the rest.")
        shot(page, "persona26-damaged-picture")
        page.get_by_role("button", name="Remove IMG_2041.jpg").click()
        expect(draft).to_have_count(0)
        expect(line).to_have_count(0)
        field.press("Enter")
        expect(page.locator(".project-convo__message").filter(has_text="This is how the bread looked this morning")).to_be_visible()

    def test_07_a_picture_has_one_size(self) -> None:
        page = self.page("mia")
        page.goto(f"/projects/{self.ids['space']}")
        picture = png(64, 48, b"x" * 6000)
        with page.expect_response(lambda response: "/files?" in response.url and response.request.method == "POST") as staged:
            self.attach(page, [{"name": "IMG_2042.png", "mimeType": "image/png", "buffer": picture}])
        stored = staged.value.json()["size"]
        self.assertLess(stored, len(picture), "the cleaned picture is smaller than the one picked")
        item = page.get_by_role("list", name="Files in your draft").get_by_role("listitem")
        expect(item).to_contain_text("Ready, private")
        expect(item).to_contain_text(file_size(stored))
        expect(item).not_to_contain_text(file_size(len(picture)))

    # ---------------------------------------------------------------- P3: one word per thing

    def test_08_a_guest_is_called_guest_where_she_is_chosen(self) -> None:
        page = self.page("ola")
        page.goto(f"/projects/{self.ids['space']}")
        composer = page.locator("#project-composer")
        composer.fill("@Gi")
        option = page.get_by_role("option", name=re.compile("Gia Mlyn"))
        expect(option).to_contain_text("Guest")
        expect(option).not_to_contain_text("Person")
        composer.fill("")
        page.get_by_role("complementary", name="Sidebar").get_by_role("button", name=re.compile("^New")).click()
        window = page.get_by_role("dialog", name="New task")
        # The space's people arrive after the window opens; the open list shows them as they do.
        box = open_select(window.get_by_label("Owner"))
        expect(box.get_by_role("option", name="Gia Mlyn · Guest", exact=True)).to_be_visible()
        expect(box.get_by_role("option", name="Ola Nowak (you)", exact=True)).to_be_visible()
        expect(box.get_by_role("option", name="Mia Kran", exact=True)).to_be_visible()
        page.keyboard.press("Escape")

    def test_09_one_word_for_the_owner_and_for_you(self) -> None:
        for who in ("ola", "mia"):
            page = self.page(who)
            page.goto(f"/projects/{self.ids['space']}/settings")
            people = page.get_by_role("list", name="People in Morning shift")
            row = people.locator(f"[data-person='{self.ids['ola']}']")
            expect(row).to_contain_text("Owner")
            expect(row).not_to_contain_text("Admin")
            mine = people.locator(f"[data-person='{self.ids[who]}'] .spset__who b")
            expect(mine).to_have_text(f"{PEOPLE[who][0]} (you)")
            if who == "ola":
                expect(page.locator("[data-ai-switch]")).to_contain_text("Let AI agents help in this space")

    def test_10_the_company_role_is_a_menu_that_changes_it(self) -> None:
        page = self.page("ola")
        page.goto("/settings/company")
        role = page.get_by_role("combobox", name="Role of Mia Kran")
        expect(role).to_contain_text("Member")
        expect(page.get_by_role("button", name=re.compile("^Change Mia Kran"))).to_have_count(0)
        choose(role, label="Guest")
        expect(page.locator(".people__done")).to_have_text("Mia Kran is now a guest.")
        roles = {item["userId"]: item["role"] for item in self.api(page, "GET", f"/api/v1/workspaces/{self.ids['company']}/members", status=200)}
        self.assertEqual(roles[self.ids["mia"]], "guest")
        choose(page.get_by_role("combobox", name="Role of Mia Kran"), label="Member")
        expect(page.locator(".people__done")).to_have_text("Mia Kran is now a member.")
        # Your own role is the same menu; the last owner is told what to do first.
        mine = page.get_by_role("combobox", name="Your role")
        box = open_select(mine)
        box.get_by_role("option", name="Admin", exact=True).click()
        expect(page.get_by_role("alert")).to_contain_text("needs at least one owner")
        expect(mine).to_contain_text("Owner")
        shot(page, "persona26-company-role-menu")

    def test_11_a_phone_shows_no_escape_hint(self) -> None:
        page = self.page("mia", phone=True)
        sketch = self.api(page, "POST", f"/api/v1/workspaces/{self.ids['company']}/sketches", {"title": "Shift ideas", "scope": "project", "projectId": self.ids["space"]}, 201)["id"]
        page.goto(f"/projects/{self.ids['space']}/map/{sketch}")
        expect(page.locator(".sk-page .sk")).to_be_visible()
        show_map_as(page, "List", touch=True)
        page.get_by_role("toolbar", name="Map tools").get_by_role("button", name="Thought", exact=True).tap()
        draft = page.get_by_role("form", name="New thought draft")
        expect(draft).to_be_visible()
        expect(draft).not_to_contain_text("Escape")
        expect(draft.get_by_role("button", name="Cancel")).to_be_visible()
        computer = self.page("mia")
        computer.goto(f"/projects/{self.ids['space']}/map/{sketch}")
        expect(computer.locator(".sk-page .sk")).to_be_visible()
        show_map_as(computer, "List")
        computer.get_by_role("toolbar", name="Map tools").get_by_role("button", name="Thought", exact=True).click()
        expect(computer.get_by_role("form", name="New thought draft")).to_contain_text("Escape cancels")


if __name__ == "__main__":
    unittest.main()
