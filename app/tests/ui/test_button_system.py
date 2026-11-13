"""One button system everywhere (#1233, v0.2.1): the same shape, weight and height of every button on the screens people see.

Runs with the other tests/ui journeys through scripts/check_ui.sh against the running Compose app; FLUX_UI_BROWSER picks the engine
(chromium by default, webkit too). On sign in, sign up and password reset, Home, the empty Wiki, Tasks and Map, a conversation with its
composer, Settings (Account, Notifications, AI, Company), the direct messages, and the Create window, light and dark, at 1440 and 390 px,
every visible `ui-btn` is measured in the running app:
- radius 10, weight 500, no shadow, and a height of the system: 32, 36 or 44 px on the computer, 44 px on a touch screen;
- at most one primary (dark) button in the page of a screen, and in a window;
- a quiet button in a row (a settings or member row: Change, Edit, Remove, Sign out, Copy, Revoke) is the small size of the system (`sm`,
  the 12 px label), including the rows that exist only with data: a second signed-in device on Account and a pending invitation on Company;
- the empty Wiki's two buttons are one primary and one outline of one height; sign in's primary is as wide as its form;
- on Account a long address wraps inside its row: the text never runs under the row's Change button, at 1440 and 390 px.
"""

from __future__ import annotations

import json
import os
import time
import unittest
import uuid

from playwright.sync_api import Browser, Page, expect, sync_playwright

from create_window import open_create
from layers import settle
from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
PASSWORD = "one button system"
# Long enough to run under a row's button on a phone when it does not wrap (it has no spaces to break at).
EMAIL = f"nia.buttons.with.a.long.address+{int(time.time() * 1000)}@example.test"
HEADERS = {"origin": ORIGIN, "content-type": "application/json"}
HEIGHTS = {"computer": (32, 36, 44), "phone": (44,)}

# Every visible button of the system in the page (`scope` limits it to a window): its kind, size and what a person sees of it.
BUTTONS = r"""(scope) => {
  const root = scope ? document.querySelector(scope) : document;
  const seen = (el) => { const box = el.getBoundingClientRect(), style = getComputedStyle(el);
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !el.closest('[inert], [aria-hidden="true"]'); };
  const probe = document.createElement('span'); probe.style.fontSize = 'var(--fs-sm)'; document.body.appendChild(probe);
  const small = getComputedStyle(probe).fontSize; probe.remove();
  return [...root.querySelectorAll('.ui-btn')].filter(seen).map((el) => { const box = el.getBoundingClientRect(), style = getComputedStyle(el);
    const kind = [...el.classList].filter((name) => /^ui-btn--/.test(name) && !/--(lg|sm|block)$/.test(name)).map((name) => name.slice(8)).join(' ') || 'secondary';
    return { text: (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 40), kind, height: Math.round(box.height * 100) / 100,
      iconOnly: box.width <= box.height + 1, radius: style.borderTopLeftRadius, weight: style.fontWeight, shadow: style.boxShadow,
      inWindow: !!el.closest('[role="dialog"], [role="alertdialog"]'), inRow: !!el.closest('.sset-row, .people__row'), small: style.fontSize === small }; });
}"""

# Account's rows: each row's text (the value under its title) stays inside its own box and ends before the row's button, so a long
# address wraps instead of running under Change.
ACCOUNT_ROWS = r"""() => [...document.querySelectorAll('.sset-acct > .sset-row')].map((row) => {
  const text = row.querySelector('.sset-row__b'), value = row.querySelector('.sset-row__s'), button = row.querySelector('.ui-btn');
  const box = text.getBoundingClientRect(), other = button.getBoundingClientRect();
  return { title: row.querySelector('.sset-row__t').textContent, overflow: value.scrollWidth - value.clientWidth, textRight: box.right, buttonLeft: other.left,
    buttonRight: other.right, rowRight: row.getBoundingClientRect().right, page: document.documentElement.scrollWidth - document.documentElement.clientWidth };
})"""


class ButtonSystem(unittest.TestCase):
    browser: Browser
    state: dict
    ids: dict[str, str] = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=10000)
        context = cls.browser.new_context(service_workers="block", base_url=ORIGIN)
        response = context.request.post("/api/auth/sign-up/email", data={"name": "Nia Buttons", "email": EMAIL, "password": PASSWORD}, headers={"origin": ORIGIN})
        assert response.status == 200, response.text()

        def post(path: str, body: dict, status: int = 201) -> dict:
            made = context.request.post(path, data=json.dumps(body), headers={**HEADERS, "idempotency-key": str(uuid.uuid4())})
            assert made.status == status, made.text()
            return made.json()

        workspace = post("/api/v1/workspaces", {"name": "Button company"})["id"]
        quiet = post(f"/api/v1/workspaces/{workspace}/projects", {"name": "Quiet shelf", "visibility": "restricted"})["id"]
        busy = post(f"/api/v1/workspaces/{workspace}/projects", {"name": "Busy shelf", "visibility": "restricted"})["id"]
        post(f"/api/v1/projects/{busy}/conversations", {"body": "Which probe goes in the north bed?", "clientMessageId": str(uuid.uuid4())})
        post(f"/api/v1/projects/{busy}/work", {"title": "Calibrate the soil probes"})
        # The states a row's actions show only with data: a pending invitation (Copy, Revoke on Company) and a second signed-in device
        # (Sign out on Account).
        post(f"/api/v1/workspaces/{workspace}/invites", {"role": "member", "email": "kai.invited@example.test"})
        other = cls.browser.new_context(service_workers="block", base_url=ORIGIN)
        signed = other.request.post("/api/auth/sign-in/email", data={"email": EMAIL, "password": PASSWORD}, headers={"origin": ORIGIN})
        assert signed.status == 200, signed.text()
        other.close()
        cls.ids = {"workspace": workspace, "quiet": quiet, "busy": busy}
        cls.state = context.storage_state()
        context.close()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, scheme: str, phone: bool, *, signed_in: bool = True) -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": scheme, "locale": "en-GB", "timezone_id": "Europe/Warsaw", "service_workers": "block",
                         "viewport": PHONE if phone else DESKTOP, "device_scale_factor": 1, "reduced_motion": "reduce"}
        if signed_in:
            options["storage_state"] = self.state
        if phone:
            options.update(is_mobile=True, has_touch=True)
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def check(self, page: Page, screen: str, *, scope: str | None = None, window: bool = False, needs_buttons: bool = True) -> list[dict]:
        """The buttons of the screen (or of its window) measured against the system."""
        settle(page)
        phone = (page.viewport_size or DESKTOP)["width"] <= 640
        buttons = page.evaluate(BUTTONS, scope)
        if window:
            buttons = [item for item in buttons if item["inWindow"]]
        else:
            buttons = [item for item in buttons if not item["inWindow"]]
        if needs_buttons:
            self.assertTrue(buttons, f"{screen}: the screen has buttons to measure")
        allowed = HEIGHTS["phone" if phone else "computer"]
        for item in buttons:
            where = f"{screen} ({'phone' if phone else 'computer'}): {item}"
            if item["iconOnly"]:  # an icon with no words is the icon button's round shape (the phone header's Call)
                self.assertNotEqual(item["radius"], "0px", f"a rounded icon button in {where}")
            else:
                self.assertEqual(item["radius"], "10px", f"the radius is the system's 10 in {where}")
            self.assertEqual(item["weight"], "500", f"one weight in {where}")
            self.assertEqual(item["shadow"], "none", f"no shadow in {where}")
            self.assertTrue(any(abs(item["height"] - height) <= 0.5 for height in allowed), f"a height of the system {allowed} in {where}")
            if item["kind"] == "quiet" and item["inRow"]:
                self.assertTrue(item["small"], f"a quiet button in a row is size sm, with the small label, in {where}")
        primaries = [item["text"] for item in buttons if item["kind"] == "primary"]
        self.assertLessEqual(len(primaries), 1, f"{screen}: at most one primary button, found {primaries}")
        return buttons

    def run_screens(self, screens: list[tuple[str, str, str | None]], phone: bool) -> None:
        for scheme in ("light", "dark"):
            page = self.page(scheme, phone)
            for name, path, ready in screens:
                with self.subTest(screen=name, scheme=scheme, phone=phone):
                    page.goto(path)
                    page.wait_for_load_state("networkidle")
                    if ready:
                        expect(page.get_by_text(ready, exact=False).first).to_be_visible()
                    # A conversation's header has no button of the system on the phone any more: Search and Call are rows of More (#1239). On the
                    # computer its one was Call, which a server without a media server no longer shows anywhere (#1424). This stack has no media
                    # server (Call runs only in the live suite, scripts/check_live_ui.sh), so Conversation is measured for whatever system buttons it
                    # shows, without requiring one.
                    self.check(page, name, needs_buttons=name == "Empty wiki")
                    if name == "Account":
                        self.account_rows_fit(page, phone)
                    self.row_actions_shown(page, name)
                    shot(page, f"1233-{name.lower().replace(' ', '-')}-{'390' if phone else '1440'}-{scheme}")

    def row_actions_shown(self, page: Page, screen: str) -> None:
        """The rows that exist only with data are on screen and measured: a second device's Sign out and a pending invitation's Copy and Revoke
        are row actions too (quiet and small), so `check` reaches them."""
        shown = {"Account": (".sset-row .ui-btn", "Sign out", 1), "Company": (".people__row .ui-btn", "Revoke", 1)}.get(screen)
        if shown:
            selector, text, count = shown
            if screen == "Company":  # the invitations are under the page's Invite
                invite = page.get_by_role("button", name="Invite", exact=True)
                if invite.get_attribute("aria-expanded") != "true":
                    invite.click()
            expect(page.locator(selector, has_text=text)).to_have_count(count)
            if screen == "Company":
                expect(page.locator(selector, has_text="Copy")).to_have_count(count)
            self.check(page, f"{screen} rows", needs_buttons=True)

    def account_rows_fit(self, page: Page, phone: bool) -> None:
        expect(page.locator(".sset-acct")).to_have_count(4)  # Photo, Name, Email and Password, once the sign-in capabilities have loaded
        rows = page.evaluate(ACCOUNT_ROWS)
        self.assertEqual(len(rows), 4, f"Account has its Photo, Name, Email and Password rows {rows}")
        for row in rows:
            where = f"Account's {row['title']} row ({'phone' if phone else 'computer'}): {row}"
            self.assertLessEqual(row["overflow"], 1, f"the value stays inside its box, wrapped, not running on {where}")
            self.assertLessEqual(row["textRight"], row["buttonLeft"] + 0.5, f"the text ends before the row's button {where}")
            self.assertLessEqual(row["buttonRight"], row["rowRight"] + 0.5, f"the button stays inside the row {where}")
            self.assertLessEqual(row["page"], 1, f"the page does not scroll sideways {where}")

    def screens(self) -> list[tuple[str, str, str | None]]:
        return [
            ("Home", "/", "Home"),
            ("Empty wiki", f"/projects/{self.ids['quiet']}/docs", "No pages yet"),
            ("Empty tasks", f"/projects/{self.ids['quiet']}/tasks", None),
            ("Map", f"/projects/{self.ids['quiet']}/map", None),
            ("Conversation", f"/projects/{self.ids['busy']}", "Which probe goes in the north bed?"),
            ("Account", "/settings/account", None),
            ("Notifications", "/settings/notifications", None),
            ("AI", "/settings/agents", None),
            ("Company", "/settings/company", None),
            ("Direct messages", "/dm", None),
        ]

    # ---------------------------------------------------------------- the screens

    def test_01_signed_out_pages_use_one_pair_of_buttons(self) -> None:
        for scheme, phone in (("light", False), ("dark", True)):
            page = self.page(scheme, phone, signed_in=False)
            for name, path in (("Sign in", "/sign-in"), ("Sign up", "/sign-up"), ("Reset", "/forgot-password")):
                with self.subTest(screen=name, scheme=scheme, phone=phone):
                    page.goto(path)
                    expect(page.get_by_role("heading", level=1)).to_be_visible()
                    buttons = self.check(page, name)
                    primary = page.locator(".ui-btn--primary").first
                    form = primary.locator("xpath=ancestor::form[1]").bounding_box()
                    self.assertEqual(primary.get_attribute("type"), "submit")
                    self.assertTrue(primary.evaluate("el => el.classList.contains('ui-btn--lg') && el.classList.contains('ui-btn--block')"), f"{name}: the primary is lg and as wide as its form")
                    box = primary.bounding_box()
                    self.assertGreaterEqual(box["width"], form["width"] * 0.8, f"{name}: the primary is as wide as its form {box} in {form}")
                    self.assertEqual(len(buttons), 1, f"{name}: one button, the primary")
                    shot(page, f"1233-{name.lower().replace(' ', '-')}-{'390' if phone else '1440'}-{scheme}")

    def test_02_the_computer_screens_use_the_system(self) -> None:
        self.run_screens(self.screens(), False)

    def test_03_the_phone_screens_use_the_system(self) -> None:
        self.run_screens(self.screens(), True)

    def test_04_the_empty_wiki_has_one_primary_and_an_outline_of_one_height(self) -> None:
        for scheme, phone in (("dark", False), ("light", True)):
            page = self.page(scheme, phone)
            page.goto(f"/projects/{self.ids['quiet']}/docs")
            expect(page.get_by_role("heading", name="No pages yet")).to_be_visible()
            buttons = self.check(page, "Empty wiki")
            kinds = {item["text"]: (item["kind"], item["height"]) for item in buttons if item["text"] in ("New page", "Import a Markdown file")}
            self.assertEqual(kinds["New page"][0], "primary")
            self.assertEqual(kinds["Import a Markdown file"][0], "outline")
            self.assertEqual(kinds["New page"][1], kinds["Import a Markdown file"][1], "one height")

    # ---------------------------------------------------------------- the windows

    def test_05_the_create_window_uses_the_system(self) -> None:
        for scheme, phone in (("light", False), ("dark", True)):
            page = self.page(scheme, phone)
            page.goto("/")
            expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
            if phone:
                page.get_by_role("button", name="Create", exact=True).tap()
                page.get_by_role("dialog", name="Create").get_by_role("button", name="Task", exact=True).tap()
            else:
                open_create(page)
            expect(page.get_by_role("dialog", name="New task")).to_be_visible()
            self.check(page, "Create window", window=True)
            shot(page, f"1233-create-window-{'390' if phone else '1440'}-{scheme}")


if __name__ == "__main__":
    unittest.main()
