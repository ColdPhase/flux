"""A new space in one step (F-037, #874; final design F-026 S20).

A name makes a space; people come next. Every space starts the same way, with Conversation, Tasks, Map and Wiki:
there are no templates and no goal. Its creator is its first admin, and nobody else but the company's owners and
admins can open it until people are added. Runs through scripts/check_ui.sh against the running app.
"""

from __future__ import annotations

import os

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, Page, expect, sync_playwright

from create_window import create_other, new_space_window, open_create
from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder
from themed_shots import shot_both

PASSWORD = "one step to a project"
EMAIL = f"ada.newproject+{int(time.time() * 1000)}@example.test"
HERB = "Balcony herb garden"


UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
if UI_BROWSER not in ("chromium", "webkit"):
    raise ValueError(f"FLUX_UI_BROWSER must be chromium or webkit, got {UI_BROWSER!r}")


class NewProject(unittest.TestCase):
    browser: Browser
    state: dict = {}
    ids: dict = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        assert cls.browser.browser_type.name == UI_BROWSER
        print(f"ACTUAL_UI_ENGINE={cls.browser.browser_type.name}")
        expect.set_options(timeout=8000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, scheme: str = "light", viewport: dict | None = None) -> Page:
        phone = viewport == PHONE
        options: dict = {"base_url": ORIGIN, "color_scheme": scheme, "locale": "en-GB", "service_workers": "block",
                         "viewport": viewport or DESKTOP, "device_scale_factor": 1, "has_touch": phone, "is_mobile": phone}
        if self.state:
            options["storage_state"] = self.state
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        return context.new_page()

    def api(self, page: Page, method: str, path: str, body: dict | None = None, status: int = 201) -> dict:
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers={"origin": ORIGIN, "content-type": "application/json", "idempotency-key": str(uuid.uuid4())},
                                      data=json.dumps(body) if body is not None else None)
        self.assertEqual(response.status, status, response.text())
        return json.loads(response.text()) if response.text() else {}

    def ensure_account(self) -> None:
        if self.state:
            return
        page = self.page()
        page.goto("/sign-up")
        page.get_by_label("Name").fill("Ada Kowalska")
        page.get_by_label("Email").fill(EMAIL)
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        type(self).ids["workspace"] = self.api(page, "POST", "/api/v1/workspaces", {"name": "Riverside Makers"})["id"]
        type(self).state = page.context.storage_state()

    def signed_up(self, name: str, email: str) -> dict:
        """A new account in its own context; returns its storage state."""
        context = self.browser.new_context(base_url=ORIGIN, locale="en-GB", service_workers="block", viewport=DESKTOP)
        self.addCleanup(context.close)
        page = context.new_page()
        page.goto("/sign-up")
        page.get_by_label("Name").fill(name)
        page.get_by_label("Email").fill(email)
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        return context.storage_state()

    def as_account(self, state: dict) -> Page:
        context = self.browser.new_context(base_url=ORIGIN, locale="en-GB", service_workers="block", viewport=DESKTOP, storage_state=state)
        self.addCleanup(context.close)
        return context.new_page()

    def view_names(self, page: Page) -> list[str]:
        views = page.locator("header.top").get_by_role("navigation", name="Space views")
        expect(views.get_by_role("tab").first).to_be_visible()
        return [text.strip() for text in views.get_by_role("tab").all_inner_texts()]

    def open_window(self, page: Page, phone: bool = False):
        """New › Space: the one New space window, from New (C) on the computer and from the Spaces list on the phone."""
        if phone:
            page.goto("/projects")
            page.get_by_role("button", name=re.compile("^(New space|Create a space)$")).tap()
        else:
            page.goto("/")
            expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
            open_create(page)
            create_other(page, "Space")
        expect(new_space_window(page).get_by_role("heading", name="New space")).to_be_visible()
        return new_space_window(page)

    def create(self, page: Page, name: str) -> str:
        self.open_window(page)
        page.get_by_label("Space name").fill(name)
        page.get_by_role("button", name="Create space").click()
        expect(page).to_have_url(re.compile(r"/projects/[0-9a-f-]{36}$"))
        return re.search(r"/projects/([0-9a-f-]{36})", page.url).group(1)

    def test_01_one_window_a_name_the_people_and_the_ai_switch(self) -> None:
        self.ensure_account()
        for scheme in ("light", "dark"):
            page = self.page(scheme)
            window = self.open_window(page)
            card = window.get_by_role("form", name="New space")
            expect(card.get_by_label("Space name")).to_be_focused()
            # The drawn window: a title, a labelled Name, Cancel, no tabs of the Create window.
            expect(card.get_by_role("heading", name="New space")).to_be_visible()
            expect(card.get_by_text("Name", exact=True)).to_be_visible()
            expect(window.get_by_role("tablist")).to_have_count(0)
            expect(card).to_contain_text("You’re the admin of this space")
            expect(card.get_by_role("button", name="Add people")).to_be_visible()
            # AI starts on; one dark button, Create space, beside Cancel of the same height.
            expect(card.get_by_role("switch", name="AI")).to_have_attribute("aria-checked", "true")
            create, cancel = card.get_by_role("button", name="Create space"), card.get_by_role("button", name="Cancel")
            self.assertEqual(create.bounding_box()["height"], cancel.bounding_box()["height"])
            # No template, no goal, no "Who can see this" step; the Encrypted switch is there and starts off (C-24).
            expect(card.get_by_role("textbox")).to_have_count(1)
            expect(card.get_by_role("radio")).to_have_count(0)
            expect(card).not_to_contain_text("goal")
            expect(card.get_by_role("switch")).to_have_count(2)
            expect(card.get_by_role("switch", name=re.compile("^Encrypted"))).to_have_attribute("aria-checked", "false")
            shot(page, f"874-newspace-1440-{scheme}")

    def test_02_a_new_space_has_its_four_views_and_its_creator_is_its_admin(self) -> None:
        self.ensure_account()
        page = self.page()
        pid = self.create(page, HERB)
        type(self).ids["space"] = pid
        project = self.api(page, "GET", f"/api/v1/projects/{pid}", status=200)
        self.assertEqual(project["visibility"], "restricted")
        self.assertEqual(project["access"], "manager")
        self.assertNotIn("goal", project)
        expect(page.locator("header.top").get_by_role("heading", level=1, name=HERB)).to_be_visible()
        self.assertEqual(self.view_names(page)[:4], ["Conversation", "Tasks", "Map", "Wiki"])
        # A space made through the API starts the same way.
        other = self.api(page, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/projects", {"name": "Cargo bike co-op"})
        self.assertNotIn("views", other)

    def test_05_phone_form_and_the_views_of_a_new_space(self) -> None:
        self.ensure_account()
        for scheme in ("light", "dark"):
            page = self.page(scheme, PHONE)
            self.open_window(page, phone=True)
            expect(page.get_by_label("Space name")).to_be_visible()
            create = page.get_by_role("button", name="Create space")
            self.assertGreaterEqual(create.bounding_box()["height"], 44)
            shot(page, f"874-newspace-390-{scheme}")
        page = self.page("light", PHONE)
        self.open_window(page, phone=True)
        page.get_by_label("Space name").fill("Phone space")
        page.get_by_role("button", name="Create space").tap()
        expect(page).to_have_url(re.compile(r"/projects/[0-9a-f-]{36}$"))
        pid = re.search(r"/projects/([0-9a-f-]{36})", page.url).group(1)
        page.goto(f"/projects/{pid}")
        # On the phone the four views are the underline tabs under the title (#873, #1239).
        views = page.get_by_role("navigation", name="Space views")
        for name in ("Conversation", "Tasks", "Map", "Wiki"):
            expect(views.get_by_role("tab", name=re.compile(f"^{name}"))).to_be_visible()
        shot(page, "874-phone-views-390")

    def test_05b_the_phones_create_sheet_offers_space_and_opens_the_new_space_window(self) -> None:
        """S3: "+" opens Create everywhere with Space among its tiles. The phone's Create window has no New space button, so the
        tile is the way to it from here (the Spaces list is the other)."""
        self.ensure_account()
        page = self.page("light", PHONE)
        page.goto("/")
        page.get_by_role("button", name="Create", exact=True).tap()
        sheet = page.get_by_role("dialog", name="Create")
        expect(sheet).to_be_visible()
        tile = sheet.get_by_role("button", name="Space", exact=True)
        expect(tile).to_be_visible()
        self.assertGreaterEqual(tile.bounding_box()["height"], 44)
        tile.tap()
        window = new_space_window(page)
        expect(window.get_by_role("heading", name="New space")).to_be_visible()
        expect(window.get_by_text("Name", exact=True)).to_be_visible()
        expect(window.get_by_role("button", name="Cancel")).to_be_visible()
        # The phone's plus reaches the same window, Encrypted included (#848 AC-2).
        expect(window.get_by_role("switch", name=re.compile("^Encrypted"))).to_have_attribute("aria-checked", "false")
        expect(sheet).to_have_count(0)
        window.get_by_label("Space name").fill("Made from the plus")
        window.get_by_role("button", name="Create space").tap()
        expect(page).to_have_url(re.compile(r"/projects/[0-9a-f-]{36}$"))

    def test_06_the_footer_names_who_can_open_a_new_space(self) -> None:
        """The caption is true: the creator and the company's owners and admins open it at once; a member does not."""
        self.ensure_account()
        stamp = int(time.time() * 1000)
        admin_email, member_email = f"admin.np+{stamp}@example.test", f"member.np+{stamp}@example.test"
        admin_state = self.signed_up("Nia Admin", admin_email)
        member_state = self.signed_up("Kai Member", member_email)
        owner = self.page()
        self.api(owner, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/members", {"email": admin_email, "role": "admin"})
        self.api(owner, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/members", {"email": member_email, "role": "member"})
        pid = self.create(owner, "Visible to admins")
        admin = self.as_account(admin_state)
        self.assertEqual(self.api(admin, "GET", f"/api/v1/projects/{pid}", status=200)["access"], "manager")
        member = self.as_account(member_state)
        self.api(member, "GET", f"/api/v1/projects/{pid}", status=404)
        # A member starts a space of their own too, and is its admin.
        mine = self.create(member, "Kai’s space")
        self.assertEqual(self.api(member, "GET", f"/api/v1/projects/{mine}", status=200)["access"], "manager")

    UNLOCK = "seven loud geese in a hat"

    def assert_download_block_is_spaced(self, card, label: str) -> None:
        """#1216: the Download recovery code button, its line of words and (when shown) its refusal are one column with a clear gap between them."""
        gaps = card.locator("[data-recovery-download]").evaluate("""(block) => {
          const rows = [block.querySelector('button'), block.querySelector('.newspace__hint'), block.querySelector('.newspace__error')].filter(Boolean).map((el) => el.getBoundingClientRect());
          return rows.slice(1).map((box, at) => box.top - rows[at].bottom);
        }""")
        self.assertGreaterEqual(len(gaps), 1, label)
        for gap in gaps:
            self.assertGreaterEqual(gap, 6, f"{label}: the button, its line and its refusal are at least 6 px apart: {gaps}")

    def encrypted_card(self, page: Page, phone: bool = False):
        card = self.open_window(page, phone=phone).get_by_role("form", name="New space")
        encrypted = card.get_by_role("switch", name=re.compile("^Encrypted"))
        expect(encrypted).to_have_attribute("aria-checked", "false")
        return card, encrypted

    def test_08_encrypted_starts_off_and_turned_on_drops_ai_and_asks_for_a_password_and_the_recovery_code(self) -> None:
        self.ensure_account()
        page = self.page()
        card, encrypted = self.encrypted_card(page)
        expect(card.get_by_label("Your unlock password", exact=True)).to_have_count(0)
        expect(card.get_by_role("switch", name="AI")).to_have_attribute("aria-checked", "true")
        encrypted.click()
        expect(encrypted).to_have_attribute("aria-checked", "true")
        # The AI row stays, dimmed and off, and says why (F-026 §7 Spaces).
        expect(card.get_by_role("switch", name="AI")).to_be_disabled()
        expect(card.get_by_role("switch", name="AI")).to_have_attribute("aria-checked", "false")
        expect(card).to_contain_text("No AI in encrypted spaces")
        expect(card.get_by_label("Your unlock password", exact=True)).to_be_visible()
        expect(card.get_by_label("Repeat", exact=True)).to_be_visible()
        expect(card.get_by_role("button", name="Download recovery code")).to_be_visible()
        expect(card).to_contain_text("After each server restart, an admin of this space unlocks it")
        # Hubert's answer on C-24 (2026-11-08, #980): company admins see the name, never the contents, and the creator is told so here, in one line.
        admins = card.locator("[data-admins-see-name]")
        expect(admins).to_have_text("Company admins will see this space’s name, never what’s in it.")
        shot(page, f"874-newspace-encrypted-1440-{UI_BROWSER}")
        self.assert_download_block_is_spaced(card, "1440")
        card.locator("[data-recovery-download]").scroll_into_view_if_needed()
        shot_both(page, f"1216-newspace-encrypted-1440-{UI_BROWSER}")
        # Off again before Create: the AI switch is back, and nothing is asked.
        encrypted.click()
        expect(card.get_by_role("switch", name="AI")).to_be_enabled()
        expect(card.get_by_role("switch", name="AI")).to_have_attribute("aria-checked", "true")
        expect(card.get_by_label("Your unlock password", exact=True)).to_have_count(0)
        expect(card.locator("[data-admins-see-name]")).to_have_count(0)
        # The phone says the same, inside the width of the card and the screen.
        phone = self.page("light", PHONE)
        phone_card, phone_encrypted = self.encrypted_card(phone, phone=True)
        phone_encrypted.tap()
        line = phone_card.locator("[data-admins-see-name]")
        expect(line).to_have_text("Company admins will see this space’s name, never what’s in it.")
        box, frame = line.bounding_box(), phone_card.bounding_box()
        self.assertGreaterEqual(box["x"], frame["x"])
        self.assertLessEqual(box["x"] + box["width"], frame["x"] + frame["width"] + 1)
        self.assertLessEqual(phone.evaluate("document.documentElement.scrollWidth"), phone.evaluate("window.innerWidth"))
        shot(phone, f"980-newspace-encrypted-390-{UI_BROWSER}")
        self.assert_download_block_is_spaced(phone_card, "390")
        phone_card.locator("[data-recovery-download]").scroll_into_view_if_needed()
        shot_both(phone, f"1216-newspace-encrypted-390-{UI_BROWSER}")

    def test_09_creating_an_encrypted_space_asks_the_download_first_and_leaves_no_plain_space_behind(self) -> None:
        self.ensure_account()
        page = self.page()
        company = self.ids["workspace"]
        before = self.api(page, "GET", f"/api/v1/workspaces/{company}/projects?limit=100", status=200)["total"]
        card, encrypted = self.encrypted_card(page)
        card.get_by_label("Space name").fill("Payroll")
        encrypted.click()
        card.get_by_label("Your unlock password", exact=True).fill(self.UNLOCK)
        card.get_by_label("Repeat", exact=True).fill("something else entirely different")
        # #1361: Create space is off, and says why, until the recovery code is downloaded: neither a click nor Enter in a field makes the space.
        create = card.get_by_role("button", name="Create space")
        expect(create).to_be_disabled()
        expect(card.locator("[data-create-needs-code]")).to_have_text("Download the recovery code first.")
        expect(create).to_have_accessible_description("Download the recovery code first.")
        card.get_by_label("Repeat", exact=True).press("Enter")
        page.wait_for_timeout(400)
        self.assertEqual(self.api(page, "GET", f"/api/v1/workspaces/{company}/projects?limit=100", status=200)["total"], before, "nothing is made without the code")
        self.assert_download_block_is_spaced(card, "before the download")
        with page.expect_download() as download:
            card.get_by_role("button", name="Download recovery code").click()
        text = open(download.value.path(), encoding="utf-8").read()
        found = re.search(r"([A-Z0-9]{4}(?:-[A-Z0-9]{4}){3})\n([A-Z0-9]{4}(?:-[A-Z0-9]{4}){3})", text)
        self.assertIsNotNone(found, text)
        code = f"{found.group(1)}-{found.group(2)}"
        expect(card.get_by_role("button", name="Recovery code downloaded")).to_be_visible()
        expect(card.locator("[data-create-needs-code]")).to_have_count(0)
        expect(create).to_be_enabled()
        # A mismatching repeat is still said in the field, now that Create is on.
        card.get_by_label("Repeat", exact=True).fill("something else entirely different")
        create.click()
        expect(card).to_contain_text("The two passwords don’t match.")
        card.get_by_label("Repeat", exact=True).fill(self.UNLOCK)
        create.click()
        expect(page).to_have_url(re.compile(r"/projects/[0-9a-f-]{36}$"))
        pid = re.search(r"/projects/([0-9a-f-]{36})", page.url).group(1)
        project = self.api(page, "GET", f"/api/v1/projects/{pid}", status=200)
        self.assertEqual((project["name"], project["ai"], project["access"]), ("Payroll", "blocked", "manager"))
        workspace = self.api(page, "GET", f"/api/v1/workspaces/{project['workspaceId']}", status=200)
        self.assertEqual((workspace["spaceOf"], workspace["encryption"]["state"], workspace["name"]), (company, "unlocked", "Payroll"))
        # Nothing plain was made beside it, and the code in the file is the real one.
        self.assertEqual(self.api(page, "GET", f"/api/v1/workspaces/{company}/projects?limit=100", status=200)["total"], before)
        self.api(page, "POST", f"/api/v1/workspaces/{workspace['id']}/lock", {}, status=200)
        self.api(page, "POST", f"/api/v1/workspaces/{workspace['id']}/unlock", {"recoveryCode": code}, status=200)
        # Its settings: a lock where the AI switch would be, and its people and keys one click away.
        page.goto(f"/projects/{pid}/settings")
        expect(page.get_by_text("No AI in encrypted spaces")).to_be_visible()
        expect(page.get_by_role("switch", name="AI")).to_have_count(0)
        expect(page.locator("[data-encrypted-keys]")).to_be_visible()
        shot(page, f"874-encrypted-settings-1440-{UI_BROWSER}")

    def test_09b_the_encrypted_window_keeps_its_footer_in_view_and_puts_the_password_beside_its_repeat(self) -> None:
        """#1361 (F-026 §7 Spaces): at 1280 × 800 and 1180 × 820 Cancel and Create space stay visible with the form scrolled to its top and to its end,
        Create says why it is off, and the unlock password and Repeat sit side by side."""
        self.ensure_account()
        for size in ({"width": 1280, "height": 800}, {"width": 1180, "height": 820}):
            with self.subTest(window=f"{size['width']}x{size['height']}"):
                page = self.page("light", size)
                card, encrypted = self.encrypted_card(page)
                encrypted.click()
                create, cancel = card.get_by_role("button", name="Create space"), card.get_by_role("button", name="Cancel")
                for where in ("top", "end"):
                    card.locator(".newspace__body").evaluate("(el, where) => { el.scrollTop = where === 'top' ? 0 : el.scrollHeight; }", where)
                    for button in (create, cancel):
                        box = button.bounding_box()
                        self.assertIsNotNone(box)
                        self.assertGreaterEqual(box["y"], 0, f"{where}: inside the window")
                        self.assertLessEqual(box["y"] + box["height"], size["height"], f"{where}: the footer is in the viewport")
                self.assertAlmostEqual(create.bounding_box()["height"], cancel.bounding_box()["height"], delta=0.6, msg="Cancel and Create have the same height")
                expect(create).to_be_disabled()
                expect(card.locator("[data-create-needs-code]")).to_be_visible()
                password, repeat = card.get_by_label("Your unlock password", exact=True).bounding_box(), card.get_by_label("Repeat", exact=True).bounding_box()
                self.assertAlmostEqual(password["y"], repeat["y"], delta=1, msg="the password and Repeat are side by side")
                self.assertLess(password["x"] + password["width"], repeat["x"] + 1)
                # The footer stays put while the middle scrolls, and the scrim covers the sidebar too.
                self.assertTrue(card.locator(".newspace__foot").evaluate("el => el.getBoundingClientRect().bottom <= innerHeight"))
                self.assertEqual(page.evaluate("() => document.elementFromPoint(20, 300).closest('.ui-overlay') !== null"), True, "the scrim is over the sidebar")
                shot(page, f"1361-newspace-encrypted-{size['width']}x{size['height']}-{UI_BROWSER}")

    def test_09c_no_way_around_the_download_and_one_space_on_a_slow_double_click(self) -> None:
        """#1361 (review): keyboard only, Enter in every field, a forced submit, a double-click on a slow network. Nothing is made before the
        recovery code is downloaded, exactly one space is made after it, and the downloaded code is the one that unlocks it."""
        self.ensure_account()
        page = self.page()
        company = self.ids["workspace"]
        name = f"Ledger {int(time.time() * 1000)}"
        made = lambda: [space for space in self.api(page, "GET", f"/api/v1/workspaces/{company}/encrypted-spaces", status=200) if space["name"] == name]
        card, encrypted = self.encrypted_card(page)
        card.get_by_label("Space name").fill(name)
        encrypted.focus()
        page.keyboard.press("Space")
        expect(encrypted).to_have_attribute("aria-checked", "true")
        card.get_by_label("Your unlock password", exact=True).fill(self.UNLOCK)
        card.get_by_label("Repeat", exact=True).fill(self.UNLOCK)
        create = card.get_by_role("button", name="Create space")
        expect(create).to_be_disabled()
        for field in ("Space name", "Your unlock password", "Repeat"):
            (card.get_by_label(field) if field == "Space name" else card.get_by_label(field, exact=True)).press("Enter")
        # Even a submit that bypasses the disabled button is refused in words, and nothing reaches the server.
        card.evaluate("(form) => form.requestSubmit()")
        expect(card).to_contain_text("Download the recovery code first: it is the only way back in")
        page.wait_for_timeout(400)
        self.assertEqual(made(), [], "nothing is made before the code is downloaded")
        # The download by keyboard, then a double-click while the server answers slowly.
        def slow(route) -> None:
            time.sleep(1.5)
            route.continue_()
        page.route("**/api/v1/encrypted-workspaces", slow)
        download_button = card.get_by_role("button", name="Download recovery code")
        download_button.focus()
        with page.expect_download() as download:
            page.keyboard.press("Enter")
        found = re.search(r"([A-Z0-9]{4}(?:-[A-Z0-9]{4}){3})\n([A-Z0-9]{4}(?:-[A-Z0-9]{4}){3})", open(download.value.path(), encoding="utf-8").read())
        self.assertIsNotNone(found)
        code = f"{found.group(1)}-{found.group(2)}"
        expect(create).to_be_enabled()
        create.dblclick()
        expect(page).to_have_url(re.compile(r"/projects/[0-9a-f-]{36}$"), timeout=15000)
        page.wait_for_timeout(1500)
        spaces = made()
        self.assertEqual(len(spaces), 1, f"one double-click on a slow network makes one space: {spaces}")
        workspace_id = spaces[0]["id"]
        # The downloaded code is the real one: a wrong code is refused, the file's code unlocks it.
        self.api(page, "POST", f"/api/v1/workspaces/{workspace_id}/lock", {}, status=200)
        wrong = page.request.fetch(f"{ORIGIN}/api/v1/workspaces/{workspace_id}/unlock", method="POST", data=json.dumps({"recoveryCode": "AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA"}),
                                   headers={"origin": ORIGIN, "content-type": "application/json", "idempotency-key": str(uuid.uuid4())})
        self.assertGreaterEqual(wrong.status, 400, wrong.text())
        self.assertLess(wrong.status, 500, wrong.text())
        self.api(page, "POST", f"/api/v1/workspaces/{workspace_id}/unlock", {"recoveryCode": code}, status=200)

    def test_10_a_first_time_owner_reaches_encrypted_from_home_before_making_anything(self) -> None:
        """#848 AC-1 and AC-4: a new account with no space and no note opens the New space window from Home's first-run card and finds
        Encrypted there; creating leaves no plain space behind."""
        self.ensure_account()
        stamp = int(time.time() * 1000)
        state = self.signed_up("Zoe First", f"zoe.np+{stamp}@example.test")
        page = self.as_account(state)
        company = self.api(page, "POST", "/api/v1/workspaces", {"name": "Zoe’s co-op"})["id"]
        page.goto("/")
        first = page.locator(".home__first")
        expect(first).to_be_visible()
        first.get_by_role("button", name="Start a space").click()
        card = new_space_window(page).get_by_role("form", name="New space")
        encrypted = card.get_by_role("switch", name=re.compile("^Encrypted"))
        expect(encrypted).to_have_attribute("aria-checked", "false")
        self.assertEqual(self.api(page, "GET", f"/api/v1/workspaces/{company}/projects", status=200)["total"], 0, "nothing was made on the way")
        card.get_by_label("Space name").fill("Zoe’s private")
        encrypted.click()
        card.get_by_label("Your unlock password", exact=True).fill(self.UNLOCK)
        card.get_by_label("Repeat", exact=True).fill(self.UNLOCK)
        with page.expect_download():
            card.get_by_role("button", name="Download recovery code").click()
        card.get_by_role("button", name="Create space").click()
        expect(page).to_have_url(re.compile(r"/projects/[0-9a-f-]{36}$"))
        self.assertEqual(self.api(page, "GET", f"/api/v1/workspaces/{company}/projects", status=200)["total"], 0, "no plain space behind it")
        sealed = [item for item in self.api(page, "GET", "/api/v1/workspaces", status=200) if item.get("spaceOf") == company]
        self.assertEqual([item["name"] for item in sealed], ["Zoe’s private"])


if __name__ == "__main__":
    unittest.main()
