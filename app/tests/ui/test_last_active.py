"""When a person was last active (#1225, C-58; final design, Last active; #1236 for the header's faces).

Space settings › People and Settings › Company › People say when each person was last active in one quiet line: "Active now" with a small
mark for someone with Flux open, "Active 2 h ago" for a seeded time, a date from a day on. Settings › Account holds the switch "Show when I
was last active": off, the line is gone for everyone. The header's faces put the people active now first. Runs through scripts/check_ui.sh.
"""

from __future__ import annotations

import json
import os
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

PASSWORD = "last active in a space"
STAMP = int(time.time() * 1000)
EMAILS = {who: f"{who}.lastactive+{STAMP}@example.test" for who in ("ada", "kai", "lee")}
NAMES = {"ada": "Ada Kowalska", "kai": "Kai Tanaka", "lee": "Lee Moreno"}
SPACE = "Kiln controller"

UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
if UI_BROWSER not in ("chromium", "webkit"):
    raise ValueError(f"FLUX_UI_BROWSER must be chromium or webkit, got {UI_BROWSER!r}")


class LastActive(unittest.TestCase):
    browser: Browser
    states: dict = {}
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

    def page(self, who: str = "ada", viewport: dict | None = None, scheme: str = "light") -> Page:
        phone = viewport == PHONE
        context = self.browser.new_context(base_url=ORIGIN, locale="en-GB", service_workers="block", viewport=viewport or DESKTOP, device_scale_factor=1,
                                           has_touch=phone, is_mobile=phone, color_scheme=scheme, storage_state=self.states[who])
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def api(self, page: Page, method: str, path: str, body: dict | None = None, status: int = 200) -> dict | list:
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers={"origin": ORIGIN, "content-type": "application/json", "idempotency-key": str(uuid.uuid4())},
                                      data=json.dumps(body) if body is not None else None)
        self.assertEqual(response.status, status, response.text())
        return json.loads(response.text()) if response.text() else {}

    def seed(self, who: str, minutes_ago: float | None) -> None:
        """A time written from outside the person's session (the test-only fixture route), so nothing the person does touches it."""
        context = self.browser.new_context(base_url=ORIGIN)
        self.addCleanup(context.close)
        response = context.request.put("/api/v1/integration/last-active", headers={"authorization": f"Bearer {os.environ['FLUX_FIXTURE_TOKEN']}", "content-type": "application/json"},
                                       data=json.dumps({"userId": self.ids[who], "minutesAgo": minutes_ago}))
        self.assertEqual(response.status, 204, response.text())

    def sign_up(self, who: str) -> None:
        context = self.browser.new_context(base_url=ORIGIN, locale="en-GB")
        self.addCleanup(context.close)
        response = context.request.post("/api/auth/sign-up/email", data={"email": EMAILS[who], "password": PASSWORD, "name": NAMES[who]}, headers={"origin": ORIGIN})
        self.assertEqual(response.status, 200, response.text())
        type(self).states[who] = context.storage_state()

    def ensure_world(self) -> None:
        if self.states:
            return
        for who in ("ada", "kai", "lee"):
            self.sign_up(who)
        ada = self.page("ada")
        workspace = self.api(ada, "POST", "/api/v1/workspaces", {"name": "Riverside Makers"}, status=201)["id"]
        for who in ("kai", "lee"):
            self.api(ada, "POST", f"/api/v1/workspaces/{workspace}/members", {"email": EMAILS[who], "role": "member"}, status=201)
        for who in ("ada", "kai", "lee"):
            type(self).ids[who] = self.api(self.page(who), "GET", "/api/v1/me")["user"]["id"]
        space = self.api(ada, "POST", f"/api/v1/workspaces/{workspace}/projects", {"name": SPACE, "visibility": "restricted"}, status=201)["id"]
        for who in ("kai", "lee"):
            self.api(ada, "POST", f"/api/v1/projects/{space}/grants", {"principal": {"kind": "human", "id": self.ids[who]}, "role": "contributor"}, status=201)
        type(self).ids["workspace"] = workspace
        type(self).ids["space"] = space

    def row(self, page: Page, who: str):
        return page.locator(f'[data-person="{self.ids[who]}"], .people__item:has(b:text-is("{NAMES[who]}")), .people__item:has(b:text-is("{NAMES[who]} (you)"))').first

    def test_01_space_settings_says_who_is_active_now_and_when_the_others_were(self) -> None:
        self.ensure_world()
        kai = self.page("kai")
        kai.goto("/")
        expect(kai.get_by_role("heading", level=1, name="Home")).to_be_visible()  # Kai has Flux open
        self.seed("lee", 140)  # 2 h 20 min ago
        page = self.page("ada")
        page.goto(f"/projects/{self.ids['space']}/settings")
        expect(page.get_by_role("heading", name="Space settings")).to_be_visible()
        card = page.get_by_role("list", name=f"People in {SPACE}")
        # Kai is active now: the small mark and the words, after the address, as one quiet line.
        kai_row = self.row(card, "kai")
        expect(kai_row.locator('[data-last-active="now"]')).to_have_text("Active now")
        expect(kai_row.locator(".lastactive__now")).to_have_count(1)
        expect(kai_row).to_contain_text(EMAILS["kai"])
        # Lee was last active 2 h ago (the server rounds it to the hour): words alone, no mark.
        lee_row = self.row(card, "lee")
        expect(lee_row.locator('[data-last-active="earlier"]')).to_have_text(re.compile(r"^Active [23] h ago$"))
        expect(lee_row.locator(".lastactive__now")).to_have_count(0)
        # The reader's own row has none, and the line takes the quiet colour and the meta size.
        expect(self.row(card, "ada").locator(".lastactive")).to_have_count(0)
        style = kai_row.locator(".lastactive").evaluate("el => { const s = getComputedStyle(el); return [s.fontSize, s.color]; }")
        who_style = kai_row.locator(".spset__who > b").evaluate("el => getComputedStyle(el).color")
        self.assertEqual(style[0], "12px")
        self.assertNotEqual(style[1], who_style, "quieter than the name")
        shot(page, "1225-space-settings-light")

    def test_02_a_member_reads_the_same_line_from_the_space_people(self) -> None:
        self.ensure_world()
        self.seed("lee", 140)
        page = self.page("kai")
        page.goto(f"/projects/{self.ids['space']}/settings")
        card = page.get_by_role("list", name=f"People in {SPACE}")
        expect(self.row(card, "lee").locator('[data-last-active="earlier"]')).to_have_text(re.compile(r"^Active [23] h ago$"))
        expect(self.row(card, "ada").locator(".lastactive")).to_have_count(1)
        # No address for a member: the line stands alone.
        expect(self.row(card, "lee")).not_to_contain_text(EMAILS["lee"])

    def test_03_older_than_a_day_it_is_the_day(self) -> None:
        self.ensure_world()
        self.seed("lee", 3 * 24 * 60)
        page = self.page("ada")
        page.goto(f"/projects/{self.ids['space']}/settings")
        words = self.row(page.get_by_role("list", name=f"People in {SPACE}"), "lee").locator('[data-last-active="earlier"]')
        expect(words).to_have_text(re.compile(r"^(Last active )?\d{1,2} [A-Z][a-z]{2}( \d{4})?$"))
        self.seed("lee", 30 * 60)  # 30 hours ago: yesterday, or the date when the day changed in between
        page.reload()
        expect(self.row(page.get_by_role("list", name=f"People in {SPACE}"), "lee").locator('[data-last-active="earlier"]')).to_have_text(
            re.compile(r"^(Last active )?(Yesterday|\d{1,2} [A-Z][a-z]{2})$"))

    def test_04_the_company_page_has_the_same_line(self) -> None:
        self.ensure_world()
        self.seed("lee", 25)
        page = self.page("ada")
        page.goto("/settings/company")
        card = page.get_by_role("list", name="People in Riverside Makers")
        expect(self.row(card, "lee").locator('[data-last-active="earlier"]')).to_have_text("Active 25 min ago")
        expect(self.row(card, "kai").locator(".lastactive")).to_have_count(1)
        expect(self.row(card, "ada").locator(".lastactive")).to_have_count(0)
        shot(page, "1225-company-people-light")

    def test_05_the_header_puts_the_people_active_now_first(self) -> None:
        self.ensure_world()
        self.seed("kai", 140)
        self.seed("lee", 0)
        lee = self.page("lee")
        lee.goto("/")
        expect(lee.get_by_role("heading", level=1, name="Home")).to_be_visible()  # Lee has Flux open
        page = self.page("ada")
        page.goto(f"/projects/{self.ids['space']}")
        faces = page.locator("header.top .top__faces .top__face")
        expect(faces).to_have_count(3)
        # Ada (the reader), then Lee (active now), then Kai (2 h ago), though the list is by name: Kai before Lee.
        self.assertEqual([text.strip() for text in faces.all_inner_texts()], ["AK", "LM", "KT"])

    def test_06_the_switch_in_account_takes_the_line_away_for_everyone(self) -> None:
        self.ensure_world()
        self.seed("lee", 25)
        lee = self.page("lee")
        lee.goto("/settings/account")
        switch = lee.get_by_role("switch", name="Show when I was last active")
        expect(switch).to_have_attribute("aria-checked", "true")
        expect(lee.get_by_text("People who can see you in Flux see when you were last active, never where.")).to_be_visible()
        shot(lee, "1225-account-switch-on-light")
        ada = self.page("ada")
        ada.goto(f"/projects/{self.ids['space']}/settings")
        expect(self.row(ada.get_by_role("list", name=f"People in {SPACE}"), "lee").locator(".lastactive")).to_have_count(1)
        switch.click()
        expect(switch).to_have_attribute("aria-checked", "false")
        shot(lee, "1225-account-switch-off-light")
        lee.reload()
        expect(lee.get_by_role("switch", name="Show when I was last active")).to_have_attribute("aria-checked", "false")
        ada.reload()
        expect(ada.get_by_role("list", name=f"People in {SPACE}")).to_contain_text("Lee Moreno")
        expect(self.row(ada.get_by_role("list", name=f"People in {SPACE}"), "lee").locator(".lastactive")).to_have_count(0)
        ada.goto("/settings/company")
        expect(self.row(ada.get_by_role("list", name="People in Riverside Makers"), "lee").locator(".lastactive")).to_have_count(0)
        # Back on: the line is there again, from now.
        lee.get_by_role("switch", name="Show when I was last active").click()
        expect(lee.get_by_role("switch", name="Show when I was last active")).to_have_attribute("aria-checked", "true")
        ada.goto("/settings/company")
        expect(self.row(ada.get_by_role("list", name="People in Riverside Makers"), "lee").locator('[data-last-active="now"]')).to_have_text("Active now")

    def test_07_phone_and_dark(self) -> None:
        self.ensure_world()
        self.seed("lee", 140)
        for scheme in ("light", "dark"):
            page = self.page("ada", PHONE, scheme)
            page.goto(f"/projects/{self.ids['space']}/settings")
            card = page.get_by_role("list", name=f"People in {SPACE}")
            expect(self.row(card, "lee").locator('[data-last-active="earlier"]')).to_have_text(re.compile(r"^Active [23] h ago$"))
            self.assertEqual(page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), True, "no sideways scroll on the phone")
            shot(page, f"1225-space-settings-phone-{scheme}")
            page.goto("/settings/account")
            expect(page.get_by_role("switch", name="Show when I was last active")).to_be_visible()
            shot(page, f"1225-account-phone-{scheme}")
        dark = self.page("ada", DESKTOP, "dark")
        dark.goto(f"/projects/{self.ids['space']}/settings")
        expect(dark.get_by_role("list", name=f"People in {SPACE}")).to_contain_text("Lee Moreno")
        shot(dark, "1225-space-settings-dark")


if __name__ == "__main__":
    unittest.main()
