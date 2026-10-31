"""Browser tests for the interface of encrypted workspaces (F-030, issue #655, slice S3, AC-11).

Runs with the other tests/ui modules through scripts/check_ui.sh; FLUX_UI_BROWSER picks chromium (default) or webkit.

`EncryptedWorkspaces` runs against the real S1 server (the keyring is on: check_ui.sh sets FLUX_KEYRING_TOKEN, and FLUX_FIXTURE_TOKEN
opens the creation route): real Argon2id unlocks, real wrong-password and rate-limit answers, real `423 WORKSPACE_LOCKED` from the lock
gate on a locked workspace's projects, and the real `workspace.locked.v1` / `workspace.unlocked.v1` stream events. Every test makes its
own three accounts (Ada, Ben, Cy), their encrypted workspace "Garden club" (A) and a plain one, "Harbour Studio" (B, the control), so
none depends on another. Ada owns A with an unlock password, Ben is its admin without one, Cy is a member. In a computer window
(1440 × 900) and a 390 × 844 touch phone:

* New space: the encryption box, its copy, six generated words, the own-password path with its rule and repeat check (and the
  server's own refusal in place), the recovery code step (no Copy, Done only after the box, nothing in the browser's storage, a page of
  its own to print), the lost-answer retry (the real server creates the space; its answer is dropped);
* a locked space: its row in the sidebar, Home and Projects, the locked panel for a member and for an owner or admin, the same panel
  at a deep link with the address kept, a wrong password and the rate limit said in place, the recovery code swapped in place, and the
  open tabs of other people following Lock and Unlock from the stream with no reload;
* People: the Encryption section before the AI row, in the same place in every state, for an owner, an admin without a password and
  a member; Lock now with its inline confirm and its focus; a first password allowed by a holder; a new recovery code; the AI row
  fixed with no switch; what removing or demoting an owner or admin says; and zero AI surfaces in A while B keeps its own;
* a control never moves: bounding boxes of the controls named above before and after each state change.

`KeyRotation` draws the rotation states (running at a percent, paused, starting, stalled, finished) by overlaying `rotation`,
`recoveryCode: false` and `keyChangedAt` on the real server's workspace answers, because a real rotation of a small space is over before
a percent can be seen; test_44 then follows a real S2c rotation, started by removing an admin, to its end.

Screenshots (encrypted-*-<browser>.png) go to FLUX_UI_SCREENSHOTS when set.
"""

from __future__ import annotations

import json
import os
import re
import time
import unittest
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from urllib.parse import urlparse

from playwright.sync_api import Browser, BrowserContext, Page, Route, expect, sync_playwright

from app_select import choose
from light_motion_fixture import settled
from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, open_details, shot as save_shot, start_forwarder

UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
if UI_BROWSER not in ("chromium", "webkit"):
    raise ValueError(f"FLUX_UI_BROWSER must be chromium or webkit, got {UI_BROWSER!r}")

FIXTURE_TOKEN = os.environ.get("FLUX_FIXTURE_TOKEN", "")  # S1 (until S3 makes it the production route) opens creation only to a request that carries it
PASSWORD = "the lock keeps the humans calm"
NAMES = {"ada": "Ada Kowalska", "ben": "Ben Okafor", "cy": "Cy Moreno"}
A_NAME, B_NAME = "Garden club", "Harbour Studio"
A_PROJECT, B_PROJECT = "Seed tray", "Dock lights"
A_ROOT, B_ROOT = "Order the spring seeds", "Replace the dock lights"
UNLOCK_PASSWORD = "seven loud geese in a hat"       # Ada's unlock password in A (25 characters)
NEW_PASSWORD = "twelve quiet lamps by the sea"       # a valid new password (29 characters)
LOCKED_LINE = "Waiting to be unlocked"
CODE = re.compile(r"^[A-Z0-9]{4}(-[A-Z0-9]{4}){7}$")
# On screen the code is two lines of four groups in reading order (UI audit RC-3).
CODE_LINE = re.compile(r"^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$")
CODE_SHOWN = re.compile(r"^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$")
AT = r"(at \d\d:\d\d|on \d{1,2} \w{3} at \d\d:\d\d)"
LINE = re.compile(r"^Encrypted · only people, no AI\. Unlocked by Ada Kowalska (at \d\d:\d\d|on \d{1,2} \w{3} at \d\d:\d\d)\.$")
ROTATION = ("Garden club gets a new key, and everything in it is encrypted again in the background. When that finishes, Ben’s unlock password opens nothing "
            "made from then on. The recovery code stops working, and an owner makes a new one. A copy Ben may already have, such as an old backup, still opens "
            "with their old password.")


def shot(page: Page, name: str) -> None:
    save_shot(page, f"encrypted-{name}-{UI_BROWSER}")


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


class Base(unittest.TestCase):
    """Accounts, a real encrypted workspace per test, browser windows and the helpers the tests share."""

    pw = None
    browser: Browser

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=10000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    # ---------------------------------------------------------------- the world of one test

    def sign_up(self, key: str, tag: str, name: str | None = None) -> tuple[str, str, dict]:
        email = f"{key}.enc+{tag}@example.test"
        context = self.browser.new_context(base_url=ORIGIN, service_workers="block")
        try:
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name or NAMES[key]}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            return email, context.request.get("/api/v1/me").json()["user"]["id"], context.storage_state()
        finally:
            context.close()

    def call(self, world: SimpleNamespace, who: str, method: str, path: str, body: dict | None = None, status: int | None = 200) -> dict:
        """A real API call as one of the world's people (creation carries the fixture token, as S1 asks until S3)."""
        if who not in world.apis:
            context = self.browser.new_context(base_url=ORIGIN, storage_state=world.states[who], service_workers="block")
            self.addCleanup(context.close)
            world.apis[who] = context
        headers = {"origin": ORIGIN, **({"content-type": "application/json"} if body is not None else {}),
                   **({"authorization": f"Bearer {FIXTURE_TOKEN}"} if path == "/api/v1/encrypted-workspaces" else {})}
        response = world.apis[who].request.fetch(path, method=method, data=json.dumps(body) if body is not None else None, headers=headers)
        if status is not None:
            self.assertEqual(response.status, status, f"{method} {path}: {response.text()}")
        return response.json() if response.text() else {}

    def make_world(self) -> SimpleNamespace:
        """Three new accounts, A (encrypted, unlocked by Ada) with Ben as admin and Cy as member, and B (plain, Ada's)."""
        tag = uuid.uuid4().hex[:10]
        world = SimpleNamespace(ids={}, emails={}, states={}, apis={})
        for key in NAMES:
            world.emails[key], world.ids[key], world.states[key] = self.sign_up(key, tag)
        created = self.call(world, "ada", "POST", "/api/v1/encrypted-workspaces", {"name": A_NAME, "creationId": str(uuid.uuid4()), "password": UNLOCK_PASSWORD}, 201)
        world.a, world.code = created["workspace"]["id"], created["recoveryCode"]
        self.assertRegex(world.code, r"^[A-Z0-9]{4}(-[A-Z0-9]{4}){7}$")
        self.call(world, "ada", "POST", f"/api/v1/workspaces/{world.a}/members", {"email": world.emails["ben"], "role": "admin"}, 201)
        self.call(world, "ada", "POST", f"/api/v1/workspaces/{world.a}/members", {"email": world.emails["cy"], "role": "member"}, 201)
        world.b = self.call(world, "ada", "POST", "/api/v1/workspaces", {"name": B_NAME}, 201)["id"]
        for key, space, project, root in (("a", world.a, A_PROJECT, A_ROOT), ("b", world.b, B_PROJECT, B_ROOT)):
            made = self.call(world, "ada", "POST", f"/api/v1/workspaces/{space}/projects", {"name": project, "visibility": "workspace"}, 201)
            conversation = self.call(world, "ada", "POST", f"/api/v1/projects/{made['id']}/conversations", {"body": root, "clientMessageId": str(uuid.uuid4())}, 201)
            setattr(world, f"{key}_project", made["id"])
            setattr(world, f"{key}_conversation", conversation["id"])
        return world

    def encryption(self, world: SimpleNamespace, who: str = "ada") -> dict:
        return self.call(world, who, "GET", f"/api/v1/workspaces/{world.a}")["encryption"]

    def lock(self, world: SimpleNamespace) -> None:
        self.call(world, "ada", "POST", f"/api/v1/workspaces/{world.a}/lock")

    def unlock(self, world: SimpleNamespace, who: str = "ada", secret: dict | None = None) -> None:
        self.call(world, who, "POST", f"/api/v1/workspaces/{world.a}/unlock", secret or {"password": UNLOCK_PASSWORD})

    def holders(self, world: SimpleNamespace, who: str) -> bool:
        """Whether a person has an unlock password: S1 tells only the person themselves."""
        return self.encryption(world, who)["myPassword"]

    # ---------------------------------------------------------------- browser windows

    def context(self, world: SimpleNamespace, who: str, *, phone: bool = False, stream: bool = True) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "color_scheme": "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw", "storage_state": world.states[who],
                         # The tests that overlay answers must see every request, which a service worker's own requests would escape.
                         "service_workers": "block"}
        options.update(viewport=PHONE, device_scale_factor=2, is_mobile=True, has_touch=True) if phone else options.update(viewport=DESKTOP, device_scale_factor=1)
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        # The page's own creation request carries the fixture token until S3 makes creation the production route.
        context.route(re.compile(r".*/api/v1/encrypted-workspaces$"), lambda route: route.continue_(headers={**route.request.headers, "authorization": f"Bearer {FIXTURE_TOKEN}"}))
        if not stream:
            # No event stream in this window: the page's socket is answered here and never connected to the server, so it learns of a lock
            # only from a refusal.
            context.route_web_socket(re.compile(r".*/api/v1/stream.*"), lambda socket: None)
        return context

    def page(self, world: SimpleNamespace, who: str, *, phone: bool = False, stream: bool = True) -> Page:
        return self.watched(self.context(world, who, phone=phone, stream=stream).new_page())

    def watched(self, page: Page) -> Page:
        """Every uncaught page error fails the test, except WebKit's report of a fetch that the test's own `goto` or `reload` cancelled
        ("... due to access control checks", #471; the app handles it), and only while that navigation runs (as test_phone_final)."""
        errors: list[str] = []
        leaving = {"now": False}

        def on_error(error) -> None:
            if UI_BROWSER == "webkit" and leaving["now"] and str(error).endswith("due to access control checks."):
                return
            errors.append(str(error))

        page.on("pageerror", on_error)

        def leaving_while(navigate):
            def wrapped(*args, **kwargs):
                leaving["now"] = True
                try:
                    return navigate(*args, **kwargs)
                finally:
                    leaving["now"] = False
            return wrapped

        page.goto = leaving_while(page.goto)  # type: ignore[method-assign]
        page.reload = leaving_while(page.reload)  # type: ignore[method-assign]
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def home(self, page: Page) -> None:
        page.goto("/")
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()

    def open_people(self, page: Page, space: str = A_NAME) -> None:
        """Home → Details → People → the space, as a person finds it."""
        self.home(page)
        open_details(page)
        page.get_by_role("region", name="People").get_by_role("button", name=re.compile(f"^{space}")).click()
        expect(page.get_by_role("heading", name="People", exact=True)).to_be_visible()
        expect(page.locator(".details__eyebrow", has_text=space)).to_be_visible()
        # The panel slides in (#593): positions are measured only once it has stopped.
        settled(page)

    def section(self, page: Page):
        return page.get_by_role("region", name="Encryption")

    def ai_row(self, page: Page):
        return page.get_by_role("region", name=f"AI in {A_NAME}")

    @staticmethod
    def place(locator) -> dict:
        """Where an element is in its panel's own coordinates, so a scrolled panel does not count as a control moving."""
        return locator.evaluate("""el => {
          const body = el.closest('.ui-panel__body') || document.documentElement;
          const r = el.getBoundingClientRect(), b = body.getBoundingClientRect();
          return {x: r.left - b.left, y: r.top - b.top + body.scrollTop, width: r.width, height: r.height};
        }""")

    def same_place(self, before: dict, after: dict, what: str) -> None:
        for edge in ("x", "y", "width", "height"):
            self.assertAlmostEqual(before[edge], after[edge], delta=0.6, msg=f"{what}.{edge} stays: {before} → {after}")

    def same_corner(self, before: dict, after: dict, what: str) -> None:
        """The place stays (a label may change its width)."""
        for edge in ("x", "y"):
            self.assertAlmostEqual(before[edge], after[edge], delta=0.6, msg=f"{what}.{edge} stays: {before} → {after}")

    @staticmethod
    def on_page(locator) -> dict:
        box = locator.bounding_box()
        assert box, "the element is rendered"
        return box

    def open_new_space(self, page: Page) -> None:
        self.home(page)
        open_details(page)
        rows = page.get_by_role("region", name="People").get_by_role("button")
        expect(rows.last).to_have_text(re.compile(r"^New space"))
        rows.last.click()
        expect(page.get_by_role("heading", name="New space")).to_be_visible()
        settled(page)

    def fill_new_space(self, page: Page, name: str, *, encrypt: bool = True) -> None:
        page.get_by_role("textbox", name="Name", exact=True).fill(name)
        if encrypt:
            page.get_by_role("checkbox", name="Encrypt this space").check()
            expect(page.get_by_role("textbox", name="Unlock password")).to_have_value(re.compile(r"\S"))


class EncryptedWorkspaces(Base):
    """Against the real S1 server."""

    # ---------------------------------------------------------------- New space

    def test_01_a_plain_space_needs_only_a_name_and_the_row_is_last(self) -> None:
        for phone in (False, True):
            with self.subTest(window="phone" if phone else "computer"):
                world = self.make_world()
                page = self.page(world, "ada", phone=phone)
                self.open_new_space(page)
                expect(page.get_by_role("checkbox", name="Encrypt this space")).not_to_be_checked()
                expect(page.get_by_role("textbox", name="Unlock password")).to_have_count(0)
                expect(page.get_by_role("button", name="Create space", exact=True)).to_be_visible()
                page.get_by_role("textbox", name="Name", exact=True).fill("Book club")
                page.get_by_role("button", name="Create space", exact=True).click()
                # A plain space is made through the ordinary route and opens its People, with no Encryption section.
                expect(page.get_by_role("heading", name="People", exact=True)).to_be_visible()
                expect(page.locator(".details__eyebrow", has_text="Book club")).to_be_visible()
                expect(self.section(page)).to_have_count(0)
                made = [space for space in self.call(world, "ada", "GET", "/api/v1/workspaces") if space["name"] == "Book club"]
                self.assertEqual(len(made), 1)
                self.assertIsNone(made[0]["encryption"])
                self.assertIsNone(made[0]["ai"]["fixed"])

    def test_02_the_encryption_box_explains_and_changes_the_button(self) -> None:
        world = self.make_world()
        for phone in (False, True):
            with self.subTest(window="phone" if phone else "computer"):
                page = self.page(world, "ada", phone=phone)
                self.open_new_space(page)
                name = page.get_by_role("textbox", name="Name", exact=True)
                box = page.get_by_role("checkbox", name="Encrypt this space")
                expect(page.get_by_text("Everything inside is encrypted on the server. Only people work here: no agents, no assistant, no AI. This can’t be changed later.")).to_be_visible()
                before = (self.on_page(name), self.on_page(box))
                box.check()
                expect(page.get_by_role("button", name="Create encrypted space", exact=True)).to_be_visible()
                expect(page.get_by_role("button", name="Create space", exact=True)).to_have_count(0)
                # The name and the box do not move when the password appears below them.
                for old, new in zip(before, (self.on_page(name), self.on_page(box))):
                    for edge in ("x", "y", "width", "height"):
                        self.assertAlmostEqual(old[edge], new[edge], delta=0.6)
                phrase = page.get_by_role("textbox", name="Unlock password")
                expect(phrase).to_have_value(re.compile(r"^([a-z]+(-[a-z]+)? ){5}[a-z]+(-[a-z]+)?$"))
                first = phrase.input_value()
                expect(phrase).to_have_attribute("readonly", "")
                page.get_by_role("button", name="Other words").click()
                self.assertNotEqual(phrase.input_value(), first, "other words are drawn")
                expect(page.get_by_text("Each owner and admin has their own. It’s needed after every server restart. Every owner’s and admin’s password protects the whole space, and the weakest one counts. Your own needs at least 20 characters.")).to_be_visible()
                expect(page.get_by_text("If every unlock password and the recovery code are lost, everything in this space is gone for good. Nobody can recover it, not even whoever runs this server.")).to_be_visible()
                # Six words are all on show: nothing is cut off.
                self.assertLessEqual(phrase.evaluate("el => el.scrollHeight - el.clientHeight"), 1)
                # "What encryption protects" opens below the buttons, so none of them moves.
                create = page.get_by_role("button", name="Create encrypted space", exact=True)
                at = self.place(create)
                page.get_by_text("What encryption protects", exact=True).click()
                expect(page.get_by_text("It doesn’t protect against someone who controls the server while this space is unlocked")).to_be_visible()
                for edge, value in self.place(create).items():
                    self.assertAlmostEqual(at[edge], value, delta=0.6)
                shot(page, f"new-space-{'phone' if phone else 'computer'}")
                box.uncheck()
                expect(page.get_by_role("textbox", name="Unlock password")).to_have_count(0)
                expect(page.get_by_role("button", name="Create space", exact=True)).to_be_visible()

    def test_03_an_own_password_has_a_rule_a_length_a_repeat_and_the_servers_refusal(self) -> None:
        world = self.make_world()
        for phone in (False, True):
            with self.subTest(window="phone" if phone else "computer"):
                page = self.page(world, "ada", phone=phone)
                self.open_new_space(page)
                page.get_by_role("textbox", name="Name", exact=True).fill("Choir")
                page.get_by_role("checkbox", name="Encrypt this space").check()
                page.get_by_role("button", name="Use my own").click()
                own, repeat = page.get_by_label("Unlock password", exact=True), page.get_by_label("Repeat password", exact=True)
                create = page.get_by_role("button", name="Create encrypted space")
                expect(own).to_have_attribute("type", "password")
                expect(own).to_be_focused()
                expect(page.get_by_text("At least 20 characters. A few unrelated words work well.")).to_be_visible()
                own.fill("too short")
                expect(page.get_by_text("9 of 20 characters.")).to_be_visible()
                create.click()
                expect(page.get_by_text("Use at least 20 characters. Yours has 9.", exact=True)).to_be_visible()
                expect(own).to_be_focused()
                own.fill("a" * 24)
                expect(page.get_by_text("Use at least 8 different characters.")).to_be_visible()
                # Twenty characters that follow a pattern are explained before anything is sent, as the server's estimate refuses them.
                own.fill("abcdefghabcdefghabcd")
                expect(page.get_by_text("20 characters, but they follow a pattern that is easy to guess. Mix it up, or use six random words.")).to_be_visible()
                create.click()
                expect(page.get_by_text("That follows a pattern that is easy to guess. Mix it up, or use six random words.", exact=True)).to_be_visible()
                own.fill(NEW_PASSWORD)
                expect(page.get_by_text(re.compile(r"^29 characters\. Long\.$"))).to_be_visible()
                repeat.fill(NEW_PASSWORD + "x")
                create.click()
                expect(page.get_by_text("The two passwords don’t match.")).to_be_visible()
                expect(repeat).to_be_focused()
                self.assertEqual([space["name"] for space in self.call(world, "ada", "GET", "/api/v1/workspaces")].count("Choir"), 0, "nothing was sent while the form was wrong")
                # Words the browser's quick check lets through but the server's estimate refuses are said in place, and nothing is made.
                own.fill("correcthorsebatterystaple")
                repeat.fill("correcthorsebatterystaple")
                create.click()
                expect(page.get_by_text("Use at least 20 characters that are hard to guess, for example the six words suggested.", exact=True)).to_be_visible()
                expect(own).to_be_focused()
                self.assertEqual([space["name"] for space in self.call(world, "ada", "GET", "/api/v1/workspaces")].count("Choir"), 0)
                page.get_by_role("button", name="Use six random words").click()
                expect(page.get_by_role("textbox", name="Unlock password")).to_have_value(re.compile(r"^\S+( \S+){5}$"))

    def test_04_the_recovery_code_is_shown_once_with_no_copy_and_nothing_stored(self) -> None:
        for phone in (False, True):
            with self.subTest(window="phone" if phone else "computer"):
                world = self.make_world()
                page = self.page(world, "ada", phone=phone)
                self.open_new_space(page)
                self.fill_new_space(page, "Riverside")
                words = page.get_by_role("textbox", name="Unlock password").input_value()
                page.get_by_role("button", name="Create encrypted space").click()
                expect(page.get_by_role("heading", name="Your recovery code")).to_be_focused()
                code = page.locator("[data-recovery-code]")
                expect(code).to_have_text(CODE_SHOWN)
                expect(page.get_by_text("This code unlocks Riverside if every password is lost. It’s shown only now. Print it or write it down and keep it somewhere safe.")).to_be_visible()
                expect(page.get_by_text("Keep this code apart from your unlock password.")).to_be_visible()
                # RC-3: two lines of four groups, the second below the first and starting where it starts, so it reads one way only.
                lines = code.locator("span")
                expect(lines).to_have_count(2)
                for index in range(2):
                    expect(lines.nth(index)).to_have_text(CODE_LINE)
                first_line, second_line = self.on_page(lines.nth(0)), self.on_page(lines.nth(1))
                self.assertAlmostEqual(first_line["x"], second_line["x"], delta=0.6)
                self.assertGreater(second_line["y"], first_line["y"] + first_line["height"] - 1)
                self.assertLessEqual(first_line["x"] + first_line["width"], self.on_page(code)["x"] + self.on_page(code)["width"] + 0.6, "a line fits its box")
                # No Copy button anywhere on the step; a Print button above the box; Done waits for the box.
                expect(page.get_by_role("button", name=re.compile("copy", re.I))).to_have_count(0)
                print_button = page.get_by_role("button", name="Print", exact=True)
                kept, done = page.get_by_role("checkbox", name=re.compile(r"I.ve kept the recovery code")), page.get_by_role("button", name="Done", exact=True)
                self.assertLess(self.on_page(print_button)["y"], self.on_page(kept)["y"])
                expect(done).to_be_disabled()
                shot(page, f"recovery-code-{'phone' if phone else 'computer'}")
                # The page that Print makes: the code and what it is for, and nothing else.
                page.emulate_media(media="print")
                expect(page.locator(".recovery-sheet")).to_be_visible()
                expect(page.locator(".recovery-sheet")).to_contain_text("Recovery code for Riverside")
                expect(page.locator(".recovery-sheet__meta")).to_contain_text(re.compile(r"^Made \d{1,2} \w{3} \d{4} · http"))
                expect(page.locator("#details")).to_be_hidden()
                page.emulate_media(media="screen")
                expect(page.locator(".recovery-sheet")).to_be_hidden()
                kept.check()
                expect(done).to_be_enabled()
                # Nothing about the password or the code is in the browser's storage.
                shown = "".join(code.inner_text().split())
                stored = page.evaluate("() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)])")
                self.assertNotIn(shown.replace("-", ""), stored)
                self.assertNotIn(shown, stored)
                self.assertNotIn(words, stored)
                done.click()
                # NS-1: the next step's primary action starts the space's first project; People is beside it.
                expect(page.get_by_role("button", name="Start the first project in Riverside")).to_be_visible()
                page.get_by_role("button", name="People", exact=True).click()
                expect(page.get_by_role("heading", name="People", exact=True)).to_be_visible()
                expect(page.locator(".details__eyebrow", has_text="Riverside")).to_be_visible()
                expect(self.section(page).locator(".people__enc-line")).to_have_text(LINE)
                expect(page.locator("[data-recovery-code]")).to_have_count(0)
                # The real server made it: encrypted, unlocked by Ada, AI fixed off, and the shown code unlocks it after a lock.
                made = next(space for space in self.call(world, "ada", "GET", "/api/v1/workspaces") if space["name"] == "Riverside")
                self.assertEqual((made["encryption"]["state"], made["encryption"]["recoveryCode"], made["ai"]["state"], made["ai"]["fixed"]), ("unlocked", True, "blocked", "encrypted"))
                self.call(world, "ada", "POST", f"/api/v1/workspaces/{made['id']}/lock")
                self.call(world, "ada", "POST", f"/api/v1/workspaces/{made['id']}/unlock", {"recoveryCode": shown})

    def test_05_a_lost_answer_is_retried_without_a_second_space_or_a_code(self) -> None:
        for phone in (False, True):
            with self.subTest(window="phone" if phone else "computer"):
                world = self.make_world()
                context = self.context(world, "ada", phone=phone)
                page = context.new_page()
                lose = {"next": True}

                def create(route: Route) -> None:
                    if route.request.method == "POST" and lose["next"]:
                        # The real server makes the space and answers; the answer never reaches the page.
                        lose["next"] = False
                        route.fetch(headers={**route.request.headers, "authorization": f"Bearer {FIXTURE_TOKEN}"})
                        route.abort()
                    else:
                        route.fallback()
                context.route(re.compile(r".*/api/v1/encrypted-workspaces$"), create)
                self.open_new_space(page)
                self.fill_new_space(page, "Lantern")
                page.get_by_role("button", name="Create encrypted space").click()
                # RC-4: the space may have been made, so nothing says "Nothing changed".
                expect(page.get_by_role("alert").filter(has_text="Flux couldn’t be reached to finish making Lantern. Try again: if it was made, you’ll go on to its recovery code.")).to_be_visible()
                expect(page.get_by_text("Nothing changed")).to_have_count(0)
                page.get_by_role("button", name="Create encrypted space").click()
                expect(page.get_by_role("heading", name="Your recovery code")).to_be_visible()
                expect(page.get_by_text("Lantern was made, but its recovery code didn’t reach this browser. Make a new one now.")).to_be_visible()
                self.assertEqual([space["name"] for space in self.call(world, "ada", "GET", "/api/v1/workspaces")].count("Lantern"), 1, "one space, made once")
                page.get_by_role("button", name="New recovery code").click()
                expect(page.locator("[data-recovery-code]")).to_have_text(CODE_SHOWN)
                page.get_by_role("checkbox", name=re.compile(r"I.ve kept")).check()
                page.get_by_role("button", name="Done", exact=True).click()
                page.get_by_role("button", name="People", exact=True).click()
                expect(page.get_by_role("heading", name="People", exact=True)).to_be_visible()

    def test_06_a_server_without_its_key_service_says_so_in_place(self) -> None:
        world = self.make_world()
        page = self.page(world, "ada")
        # The creation route answers what S1 answers when the keyring or the swap check fails.
        page.route(re.compile(r".*/api/v1/encrypted-workspaces$"), lambda route: route.fulfill(
            status=503, content_type="application/json", body=json.dumps({"error": "stub", "code": "KEYRING_UNAVAILABLE"})))
        self.open_new_space(page)
        self.fill_new_space(page, "Nowhere")
        page.get_by_role("button", name="Create encrypted space").click()
        expect(page.get_by_role("alert").filter(has_text="Encrypted spaces aren’t available on this server right now")).to_be_visible()
        expect(page.get_by_role("button", name="Create encrypted space")).to_be_enabled()

    def create_in_ui(self, page: Page, name: str) -> str:
        """Makes an encrypted space with the generated words in the UI; returns the words (its owner's unlock password)."""
        self.open_new_space(page)
        self.fill_new_space(page, name)
        words = page.get_by_role("textbox", name="Unlock password").input_value()
        page.get_by_role("button", name="Create encrypted space").click()
        expect(page.get_by_role("heading", name="Your recovery code")).to_be_focused()
        return words

    def test_07_closing_the_code_step_asks_first_and_people_says_the_code_was_not_kept(self) -> None:
        """UI audit RC-1: Esc, × and leaving the page no longer skip "I've kept the recovery code"."""
        for phone in (False, True):
            with self.subTest(window="phone" if phone else "computer"):
                world = self.make_world()
                page = self.page(world, "ada", phone=phone)
                words = self.create_in_ui(page, "Orchard")
                ask = page.get_by_role("group", name="Close without keeping the recovery code")
                # Esc asks in place; "Keep it open" keeps the code on show.
                page.keyboard.press("Escape")
                expect(ask).to_contain_text("Close without keeping the recovery code? You can make a new one in People.")
                expect(ask.get_by_role("button", name="Keep it open")).to_be_focused()
                ask.get_by_role("button", name="Keep it open").click()
                expect(ask).to_have_count(0)
                expect(page.locator("[data-recovery-code]")).to_have_text(CODE_SHOWN)
                # The panel's × asks too.
                page.locator("#details .ui-panel__close").click()
                expect(ask).to_be_visible()
                ask.get_by_role("button", name="Keep it open").click()
                if not phone:
                    # Leaving the page inside the app asks, and staying keeps the page.
                    page.get_by_role("navigation", name="Places").get_by_role("link", name=re.compile(r"^Inbox")).click()
                    expect(ask).to_be_visible()
                    ask.get_by_role("button", name="Keep it open").click()
                    expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
                    expect(page.locator("[data-recovery-code]")).to_have_text(CODE_SHOWN)
                # Close anyway: the code is gone, and People tells the owner nobody confirmed keeping it.
                expect(page.get_by_role("checkbox", name=re.compile(r"I.ve kept"))).to_be_focused()
                page.keyboard.press("Escape")
                ask.get_by_role("button", name="Close anyway").click()
                expect(page.locator("[data-recovery-code]")).to_have_count(0)
                made = next(space for space in self.call(world, "ada", "GET", "/api/v1/workspaces") if space["name"] == "Orchard")
                self.assertTrue(made["encryption"]["recoveryCode"])
                self.open_people(page, "Orchard")
                section = self.section(page)
                expect(section.locator("[data-unkept-recovery-code]")).to_have_text("Nobody confirmed keeping Orchard’s recovery code. Make a new one.")
                stored = page.evaluate("() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)])")
                self.assertIn(made["id"], stored, "only the space's id is kept")
                self.assertIsNone(re.search(r"[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}", stored), "no code in storage")
                # A new code that is kept clears the line.
                section.get_by_role("button", name="New recovery code", exact=True).click()
                group = section.get_by_role("group", name="New recovery code")
                group.get_by_role("textbox", name="Your unlock password").fill(words)
                group.get_by_role("button", name="Make a new recovery code").click()
                shown = section.get_by_role("group", name="Your new recovery code")
                expect(shown.locator("[data-recovery-code]")).to_have_text(CODE_SHOWN)
                shown.get_by_role("checkbox", name=re.compile(r"I.ve kept")).check()
                shown.get_by_role("button", name="Done", exact=True).click()
                expect(section.locator("[data-unkept-recovery-code]")).to_have_count(0)

    def test_08_the_six_words_are_offered_to_a_password_manager_and_said_to_be_kept(self) -> None:
        """UI audit RC-2: a password field with autocomplete=new-password and the account as its username, and a line to keep the words."""
        for phone in (False, True):
            with self.subTest(window="phone" if phone else "computer"):
                world = self.make_world()
                page = self.page(world, "ada", phone=phone)
                self.open_new_space(page)
                self.fill_new_space(page, "Meadow")
                words = page.get_by_role("textbox", name="Unlock password").input_value()
                saved = page.locator("input[type=password][autocomplete=new-password][data-new-password]")
                expect(saved).to_have_value(words)
                expect(page.locator("input[autocomplete=username]")).to_have_value(world.emails["ada"])
                expect(page.locator("[data-keep-words]")).to_have_text("Write these six words down or save them in your password manager. You type them after every server restart.")
                # Neither helper field is in the tab order or read out.
                for field in (saved, page.locator("input[autocomplete=username]")):
                    expect(field).to_have_attribute("tabindex", "-1")
                    expect(field).to_have_attribute("aria-hidden", "true")
                page.get_by_role("button", name="Other words").click()
                expect(saved).to_have_value(page.get_by_role("textbox", name="Unlock password").input_value())
                self.assertNotEqual(saved.input_value(), words)

    def test_09_after_done_the_first_project_starts_in_the_new_space(self) -> None:
        """UI audit NS-1: a new space can get a project: Done leads to New project in that space, and the project is made there."""
        for phone in (False, True):
            with self.subTest(window="phone" if phone else "computer"):
                world = self.make_world()
                page = self.page(world, "ada", phone=phone)
                name = f"Allotment {'phone' if phone else 'computer'}"
                self.create_in_ui(page, name)
                page.get_by_role("checkbox", name=re.compile(r"I.ve kept")).check()
                page.get_by_role("button", name="Done", exact=True).click()
                start = page.get_by_role("button", name=f"Start the first project in {name}")
                expect(start).to_be_visible()
                start.click()
                expect(page).to_have_url(re.compile(r"/projects/new\?in="))
                # #770's picker opens with the new space chosen (Ada has two spaces here, plus Garden club).
                expect(page.locator(".project-new__space > span").first).to_have_text(f"In {name}")
                page.get_by_role("textbox", name="Project name").fill("Seed swap")
                page.get_by_role("button", name="Create project").click()
                expect(page).to_have_url(re.compile(r"/projects/[0-9a-f-]{36}"))
                space = next(item for item in self.call(world, "ada", "GET", "/api/v1/workspaces") if item["name"] == name)
                projects = self.call(world, "ada", "GET", f"/api/v1/workspaces/{space['id']}/projects")
                self.assertEqual([project["name"] for project in (projects["items"] if isinstance(projects, dict) else projects)], ["Seed swap"])

    # ---------------------------------------------------------------- a locked space

    def test_10_a_member_sees_the_space_wait_in_the_sidebar_home_and_projects(self) -> None:
        world = self.make_world()
        self.lock(world)
        for phone in (False, True):
            with self.subTest(window="phone" if phone else "computer"):
                page = self.page(world, "cy", phone=phone)
                self.home(page)
                home = page.locator("#content .home")
                row = home.locator(".home__projects").get_by_role("link", name=re.compile(rf"^{A_NAME}\s+{LOCKED_LINE}$"))
                expect(row).to_be_visible()
                self.assertEqual(home.get_by_text(A_PROJECT).count(), 0, "no project of the locked space is listed")
                expect(home.get_by_role("link", name=re.compile(f"^{B_NAME}"))).to_have_count(0)
                if phone:
                    page.goto("/projects")
                    row = page.get_by_role("list", name="Projects").get_by_role("link", name=re.compile(rf"^{A_NAME}\s+{LOCKED_LINE}$"))
                else:
                    row = page.get_by_role("navigation", name="Projects").get_by_role("link", name=re.compile(rf"^{A_NAME}\s+{LOCKED_LINE}$"))
                    expect(row.locator(".side__sub")).to_have_text(LOCKED_LINE)
                expect(row).to_be_visible()
                shot(page, f"locked-row-{'phone' if phone else 'computer'}")
                row.click()
                expect(page).to_have_url(re.compile(rf"/spaces/{world.a}$"))
                expect(page.get_by_role("heading", name=f"{A_NAME} is waiting to be unlocked")).to_be_visible()
                # LK-1: the known reason, and who can unlock it (Ada is the only one with an unlock password).
                expect(page.locator("[data-locked-reason]")).to_have_text(re.compile(rf"^Ada locked {A_NAME} {AT}\. Ada can unlock it\. You can come back then\.$"))
                expect(page.get_by_role("textbox")).to_have_count(0)
                expect(page.get_by_role("button", name="Unlock")).to_have_count(0)
                self.assertEqual(page.locator("[data-ai-surface]").count(), 0)
                shot(page, f"locked-member-{'phone' if phone else 'computer'}")

    def test_11_a_deep_link_into_a_locked_space_keeps_its_address_and_back_works(self) -> None:
        world = self.make_world()
        self.lock(world)
        for phone in (False, True):
            with self.subTest(window="phone" if phone else "computer"):
                page = self.page(world, "cy", phone=phone)
                self.home(page)
                page.goto(f"/projects/{world.a_project}")
                expect(page.get_by_role("heading", name=f"{A_NAME} is waiting to be unlocked")).to_be_visible()
                expect(page).to_have_url(re.compile(rf"/projects/{world.a_project}$"))
                self.assertEqual(page.get_by_text(A_ROOT).count(), 0, "no content, no partial body")
                if not phone:
                    expect(page.locator("header.top")).to_contain_text(A_NAME)
                    expect(page.locator("header.top")).to_contain_text(LOCKED_LINE)
                else:
                    # LK-2: an installed app has no browser Back, so the locked panel keeps the header's Back and the tab bar.
                    expect(page.locator("header.phead").get_by_role("button", name=re.compile("^Back"))).to_be_visible()
                    expect(page.get_by_role("navigation", name="Main places")).to_be_visible()
                    expect(page.get_by_role("button", name="Create")).to_have_count(0)
                page.goto(f"/projects/{world.a_project}/tasks")
                expect(page.get_by_role("heading", name=f"{A_NAME} is waiting to be unlocked")).to_be_visible()
                page.go_back()
                expect(page).to_have_url(re.compile(rf"/projects/{world.a_project}$"))
                expect(page.get_by_role("heading", name=f"{A_NAME} is waiting to be unlocked")).to_be_visible()
                page.go_back()
                expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
                if phone:
                    # A conversation's deep link too keeps the tab bar, and its Back leads Home (no history inside the app).
                    page.goto(f"/projects/{world.a_project}/conversations/{world.a_conversation}")
                    expect(page.get_by_role("heading", name=f"{A_NAME} is waiting to be unlocked")).to_be_visible()
                    expect(page.get_by_role("navigation", name="Main places")).to_be_visible()
                    page.locator("header.phead").get_by_role("button", name=re.compile("^Back")).click()
                    expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()

    def test_12_an_owner_unlocks_with_her_password_and_errors_stay_in_place(self) -> None:
        for phone in (False, True):
            with self.subTest(window="phone" if phone else "computer"):
                world = self.make_world()
                self.lock(world)
                page = self.page(world, "ada", phone=phone)
                page.goto(f"/projects/{world.a_project}")
                expect(page.get_by_role("heading", name=f"Unlock {A_NAME}")).to_be_visible()
                # LK-1: the holder reads why, and that she is the one to unlock it.
                expect(page.locator("[data-locked-reason]")).to_have_text(re.compile(rf"^You locked {A_NAME} {AT}\. Type your unlock password to open it for everyone\.$"))
                field = page.get_by_role("textbox", name="Your unlock password")
                button = page.get_by_role("button", name="Unlock", exact=True)
                expect(field).to_have_attribute("type", "password")
                expect(field).to_be_focused()
                at = (self.on_page(field), self.on_page(button))
                shot(page, f"locked-owner-{'phone' if phone else 'computer'}")
                # Keyboard only: type, Enter. A wrong password says so in place, empties the field and keeps focus there.
                page.keyboard.type("not the password at all")
                page.keyboard.press("Enter")
                expect(page.get_by_role("alert").filter(has_text=f"That password doesn’t unlock {A_NAME}.")).to_be_visible()
                expect(field).to_have_value("")
                expect(field).to_be_focused()
                for old, new in zip(at, (self.on_page(field), self.on_page(button))):
                    for edge, value in old.items():
                        self.assertAlmostEqual(value, new[edge], delta=0.6, msg="the field and the button stay where they were")
                # The recovery code swaps the field in place.
                page.get_by_role("button", name="Use the recovery code").click()
                code_field = page.get_by_role("textbox", name="Recovery code")
                expect(code_field).to_be_visible()
                expect(code_field).to_be_focused()
                for old, new in zip(at, (self.on_page(code_field), self.on_page(button))):
                    for edge, value in old.items():
                        self.assertAlmostEqual(value, new[edge], delta=0.6, msg="swapping the field moves nothing")
                page.get_by_role("button", name="Use my unlock password").click()
                # The real limiter: five wrong secrets in all, the sixth is refused with the time to wait, whoever tries.
                for _ in range(4):
                    field.fill("wrong again and again")
                    button.click()
                    expect(page.get_by_role("alert").filter(has_text="doesn’t unlock")).to_be_visible()
                field.fill("and once more")
                button.click()
                expect(page.get_by_role("alert").filter(has_text=re.compile(r"Too many tries\. Try again at \d\d:\d\d\."))).to_be_visible()
                self.assertEqual(self.encryption(world)["state"], "locked")

    def test_13_the_recovery_code_unlocks_and_an_admin_without_a_password_is_told(self) -> None:
        for phone in (False, True):
            with self.subTest(window="phone" if phone else "computer"):
                world = self.make_world()
                self.lock(world)
                page = self.page(world, "ben", phone=phone)
                page.goto(f"/spaces/{world.a}")
                expect(page.get_by_role("heading", name=f"Unlock {A_NAME}")).to_be_visible()
                expect(page.locator("[data-locked-reason]")).to_have_text(re.compile(rf"^Ada locked {A_NAME} {AT}\. You don’t have an unlock password for {A_NAME} yet\. Ada can unlock it\. Or use the recovery code\.$"))
                expect(page.get_by_role("textbox", name="Recovery code")).to_be_visible()
                expect(page.get_by_role("textbox", name="Your unlock password")).to_have_count(0)
                expect(page.get_by_role("button", name="Use the recovery code")).to_have_count(0)
                page.get_by_role("textbox", name="Recovery code").fill("WRONG-CODE")
                page.get_by_role("button", name="Unlock", exact=True).click()
                expect(page.get_by_role("alert").filter(has_text=f"That recovery code doesn’t unlock {A_NAME}.")).to_be_visible()
                typed = world.code.lower().replace("-", " ")
                page.get_by_role("textbox", name="Recovery code").fill(typed)
                page.get_by_role("button", name="Unlock", exact=True).click()
                # The space is open: its row leads into its first project.
                expect(page).to_have_url(re.compile(rf"/projects/{world.a_project}$"))
                expect(page.get_by_text(A_ROOT).first).to_be_visible()
                self.assertEqual(self.encryption(world)["unlockedBy"]["name"], "Ben Okafor")

    def test_14_open_tabs_follow_lock_and_unlock_from_the_stream_without_a_reload(self) -> None:
        for phone in (False, True):
            with self.subTest(window="phone" if phone else "computer"):
                world = self.make_world()
                cy = self.page(world, "cy", phone=phone)
                cy.goto(f"/projects/{world.a_project}")
                expect(cy.get_by_text(A_ROOT).first).to_be_visible()
                cy.evaluate("window.__sameTab = 'yes'")
                ada = self.page(world, "ada", phone=phone)
                self.open_people(ada)
                expect(self.section(ada).locator(".people__enc-line")).to_have_text(LINE)
                # Lock now turns Cy's open conversation into the locked panel.
                ada.get_by_role("button", name="Lock now").click()
                ada.get_by_role("button", name=f"Lock {A_NAME}", exact=True).click()
                expect(cy.get_by_role("heading", name=f"{A_NAME} is waiting to be unlocked")).to_be_visible()
                self.assertEqual(cy.get_by_text(A_ROOT).count(), 0)
                expect(cy).to_have_url(re.compile(rf"/projects/{world.a_project}$"))
                # Ada's own tab is on Home: the space's projects give way to its one row.
                home = ada.locator("#content .home__projects")
                expect(home.get_by_role("link", name=re.compile(rf"^{A_NAME}\s+{LOCKED_LINE}$"))).to_be_visible()
                expect(home.get_by_role("link", name=re.compile(f"^{A_PROJECT}"))).to_have_count(0)
                # Unlocking from another window brings Cy's tab back.
                other = self.page(world, "ada", phone=phone)
                other.goto(f"/spaces/{world.a}")
                other.get_by_role("textbox", name="Your unlock password").fill(UNLOCK_PASSWORD)
                other.get_by_role("button", name="Unlock", exact=True).click()
                expect(cy.get_by_text(A_ROOT).first).to_be_visible()
                self.assertEqual(cy.evaluate("window.__sameTab"), "yes", "the tab was not reloaded")
                expect(home.get_by_role("link", name=re.compile(f"^{A_PROJECT}"))).to_be_visible()
                expect(home.get_by_role("link", name=re.compile(LOCKED_LINE))).to_have_count(0)

    def test_15_a_refusal_alone_turns_a_page_into_the_locked_panel(self) -> None:
        for phone in (False, True):
            with self.subTest(window="phone" if phone else "computer"):
                world = self.make_world()
                # No event stream in this window: it learns of the lock only from the server's refusal.
                cy = self.page(world, "cy", phone=phone, stream=False)
                cy.goto(f"/projects/{world.a_project}")
                expect(cy.get_by_text(A_ROOT).first).to_be_visible()
                self.lock(world)
                if phone:
                    cy.goto(f"/projects/{world.a_project}/tasks")
                else:
                    cy.get_by_role("link", name="Tasks").first.click()
                expect(cy.get_by_role("heading", name=f"{A_NAME} is waiting to be unlocked")).to_be_visible()
                self.unlock(world)
                cy.goto(f"/projects/{world.a_project}")
                expect(cy.get_by_text(A_ROOT).first).to_be_visible()

    def test_16_while_a_space_waits_the_cross_space_places_list_the_others_and_say_so(self) -> None:
        """S2a-2c answers `/needs-you`, `/inbox`, `/search` and `/return` with `lockedWorkspaces` instead of 423; nothing shows a load error."""
        world = self.make_world()
        self.lock(world)
        for phone in (False, True):
            with self.subTest(window="phone" if phone else "computer"):
                page = self.page(world, "ada", phone=phone)
                self.home(page)
                need = page.locator("#content .home__need")
                waiting = need.get_by_role("list", name=LOCKED_LINE)
                expect(waiting.get_by_role("link", name=re.compile(rf"^{A_NAME}\s+{LOCKED_LINE}$"))).to_be_visible()
                expect(need.get_by_text("Nothing needs you right now. Enjoy the quiet.")).to_have_count(0)
                shot(page, f"needs-you-waiting-{'phone' if phone else 'computer'}")
                page.goto("/inbox")
                expect(page.locator("[data-locked-note]")).to_contain_text(LOCKED_LINE)
                expect(page.get_by_text("The Inbox could not load")).to_have_count(0)
                page.goto("/search?q=dock")
                unsearched = page.locator("[data-unsearched]")
                expect(unsearched).to_have_text(f"{A_NAME} isn’t searched while it waits to be unlocked.")
                # The computer's Search page has a Results region; the phone's search is Jump to's Results list (#770).
                results = page.get_by_role("listbox", name="Results") if phone else page.get_by_role("region", name="Results")
                expect(results.get_by_text(B_PROJECT).first).to_be_visible()
                expect(page.locator(".search__problem")).to_have_count(0)
                shot(page, f"search-waiting-{'phone' if phone else 'computer'}")
                for place in ("/docs", "/map", "/tasks"):
                    page.goto(place)
                    expect(page.locator("#content")).to_be_visible()
                    expect(page.get_by_role("alert")).to_have_count(0)
                    expect(page.get_by_role("heading", name=f"Unlock {A_NAME}")).to_have_count(0)

    def test_17_an_answer_that_names_a_locked_space_turns_its_rows_to_waiting_without_a_reload(self) -> None:
        """No stream: the first word of the lock is the Inbox's own answer (`lockedWorkspaces`)."""
        world = self.make_world()
        page = self.page(world, "cy", stream=False)
        page.goto("/inbox")
        side = page.get_by_role("navigation", name="Projects")
        expect(side.get_by_role("link", name=re.compile(f"^{A_PROJECT}"))).to_be_visible()
        self.lock(world)
        page.evaluate("window.dispatchEvent(new Event('flux:inbox-changed'))")
        expect(side.get_by_role("link", name=re.compile(rf"^{A_NAME}\s+{LOCKED_LINE}$"))).to_be_visible()
        expect(side.get_by_role("link", name=re.compile(f"^{A_PROJECT}"))).to_have_count(0)
        expect(page.locator("[data-locked-note]")).to_contain_text(A_NAME)

    def test_18_a_security_notice_is_read_in_the_inbox_and_got_it_marks_it_read(self) -> None:
        world = self.make_world()
        self.call(world, "ada", "POST", f"/api/v1/workspaces/{world.a}/unlock-password-grants", {"userId": world.ids["ben"], "password": UNLOCK_PASSWORD}, 201)
        self.call(world, "ben", "PUT", f"/api/v1/workspaces/{world.a}/unlock-password", {"newPassword": NEW_PASSWORD}, None)
        self.assertTrue(self.holders(world, "ben"))
        # The phone first: the computer's Got it marks the notice read.
        for phone in (True, False):
            with self.subTest(window="phone" if phone else "computer"):
                page = self.page(world, "ada", phone=phone)
                page.goto("/inbox")
                notices = page.get_by_role("region", name="About your encrypted spaces")
                if phone:
                    expect(notices).to_be_visible()
                    notices.scroll_into_view_if_needed()
                    shot(page, "security-notice-phone")
                    continue
                notice = notices.get_by_role("listitem").filter(has_text=f"now has an unlock password for {A_NAME}")
                expect(notice).to_have_count(1)
                self.assertNotIn(UNLOCK_PASSWORD, notices.inner_text())
                notice.scroll_into_view_if_needed()
                shot(page, "security-notice-computer")
                notice.get_by_role("button", name=re.compile("^Got it")).click()
                expect(notices).to_have_count(0)
                deadline = time.time() + 5
                while time.time() < deadline:
                    items = self.call(world, "ada", "GET", "/api/v1/inbox?limit=100")["items"]
                    if all(item["readAt"] for item in items if item["reason"] == "security"):
                        break
                    time.sleep(0.2)
                self.assertTrue(all(item["readAt"] for item in items if item["reason"] == "security"), "Got it marks the notice read")

    # ---------------------------------------------------------------- People

    def test_19_printing_another_page_after_home_prints_that_page(self) -> None:
        """UI audit XC-1: the recovery sheet's print rule applies only while a code is on show, not to every page once Home loaded it."""
        world = self.make_world()
        page = self.page(world, "ada")
        self.home(page)
        page.goto(f"/projects/{world.b_project}")
        expect(page.get_by_text(B_ROOT).first).to_be_visible()
        page.emulate_media(media="print")
        expect(page.locator("#content")).to_be_visible()
        expect(page.get_by_text(B_ROOT).first).to_be_visible()
        page.emulate_media(media="screen")

    def test_32_a_former_members_messages_say_former_member(self) -> None:
        """UI audit XC-2: a removed person's messages are named "Former member", the same in the conversation and its notices."""
        world = self.make_world()
        self.call(world, "ada", "POST", f"/api/v1/workspaces/{world.b}/members", {"email": world.emails["ben"], "role": "member"}, 201)
        reply = "The new dock lights are in the shed"
        self.call(world, "ben", "POST", f"/api/v1/conversations/{world.b_conversation}/messages", {"body": reply, "clientMessageId": str(uuid.uuid4())}, 201)
        self.call(world, "ada", "DELETE", f"/api/v1/workspaces/{world.b}/members/{world.ids['ben']}", None, None)
        page = self.page(world, "ada")
        page.goto(f"/projects/{world.b_project}/conversations/{world.b_conversation}")
        message = page.locator("[data-message-id]").filter(has_text=reply).last
        expect(message).to_be_visible()
        expect(message).to_contain_text("Former member")
        expect(message).to_have_attribute("aria-label", "Former member’s message")

    def test_20_the_encryption_section_and_the_ai_row_sit_before_leave_in_every_state(self) -> None:
        for phone in (False, True):
            with self.subTest(window="phone" if phone else "computer"):
                world = self.make_world()
                page = self.page(world, "ada", phone=phone)
                self.open_people(page)
                section, ai = self.section(page), self.ai_row(page)
                expect(section.get_by_role("heading", name="Encryption")).to_be_visible()
                expect(section.locator(".people__enc-line")).to_have_text(LINE)
                # Encryption, then AI, then Leave.
                leave = page.get_by_role("region", name=f"Leave {A_NAME}")
                self.assertLess(self.place(section)["y"], self.place(ai)["y"])
                self.assertLess(self.place(ai)["y"], self.place(leave)["y"])
                # The AI row: one fixed line, for everyone, no switch.
                expect(ai.locator(".people__ai-line")).to_have_text(f"Off · {A_NAME} is encrypted, so AI can never be turned on here.")
                expect(ai.get_by_role("button")).to_have_count(0)
                expect(page.get_by_role("button", name=re.compile(r"Turn o(n|ff) AI"))).to_have_count(0)
                # An owner's buttons, in one row; with another admin in the space, the one that lets them set a password.
                for name in ("Change your unlock password", "Lock now", "New recovery code", "Let Ben set an unlock password"):
                    expect(section.get_by_role("button", name=name)).to_be_visible()
                section.scroll_into_view_if_needed()
                shot(page, f"people-unlocked-{'phone' if phone else 'computer'}")

    def test_21_a_member_reads_one_line_and_an_admin_without_a_password_is_told_what_to_do(self) -> None:
        for phone in (False, True):
            with self.subTest(window="phone" if phone else "computer"):
                world = self.make_world()
                member = self.page(world, "cy", phone=phone)
                self.open_people(member)
                expect(self.section(member).locator(".people__enc-line")).to_have_text(LINE)
                expect(self.section(member).get_by_role("button")).to_have_count(0)
                expect(self.ai_row(member).locator(".people__ai-line")).to_have_text(f"Off · {A_NAME} is encrypted, so AI can never be turned on here.")
                self.assertEqual(member.get_by_role("button", name=re.compile(r"Turn o(n|ff) AI")).count(), 0)
                admin = self.page(world, "ben", phone=phone)
                self.open_people(admin)
                section = self.section(admin)
                expect(section.get_by_text("You don’t have an unlock password yet. Another owner or admin can let you set one. If you have the recovery code, you can use it instead.")).to_be_visible()
                # No holder has allowed it yet, so the way open to him is the recovery code (the contract's wording).
                expect(section.get_by_role("button", name="Use the recovery code")).to_be_visible()
                expect(section.get_by_role("button", name="Set your unlock password")).to_have_count(0)
                expect(section.get_by_role("button", name="Lock now")).to_be_visible()
                expect(section.get_by_role("button", name="New recovery code")).to_have_count(0)
                expect(section.get_by_role("button", name=re.compile("^Let .* set"))).to_have_count(0)

    def test_22_lock_now_asks_inline_and_nothing_moves_and_focus_returns(self) -> None:
        for phone in (False, True):
            with self.subTest(window="phone" if phone else "computer"):
                world = self.make_world()
                page = self.page(world, "ada", phone=phone)
                self.open_people(page)
                section = self.section(page)
                lock = section.get_by_role("button", name="Lock now")
                names = ("Change your unlock password", "Lock now", "New recovery code", "Let Ben set an unlock password")
                before = {name: self.place(section.get_by_role("button", name=name)) for name in names}
                before["heading"] = self.place(section.get_by_role("heading", name="Encryption"))
                before["ai"] = self.place(self.ai_row(page))
                lock.focus()
                page.keyboard.press("Enter")
                confirm = section.get_by_role("group", name=f"Lock {A_NAME}")
                expect(confirm).to_contain_text(f"Everyone in {A_NAME} loses access until an owner or admin unlocks it again.")
                expect(confirm.get_by_role("button", name=f"Lock {A_NAME}")).to_be_focused()
                expect(confirm.get_by_role("button", name="Keep it unlocked")).to_be_visible()
                for name in names:
                    self.same_place(before[name], self.place(section.get_by_role("button", name=name)), name)
                self.same_place(before["heading"], self.place(section.get_by_role("heading", name="Encryption")), "heading")
                shot(page, f"lock-confirm-{'phone' if phone else 'computer'}")
                # Esc closes it and returns to the button; so does "Keep it unlocked". Nothing was locked.
                page.keyboard.press("Escape")
                expect(confirm).to_have_count(0)
                expect(lock).to_be_focused()
                page.keyboard.press("Enter")
                page.keyboard.press("Tab")
                expect(confirm.get_by_role("button", name="Keep it unlocked")).to_be_focused()
                page.keyboard.press("Enter")
                expect(confirm).to_have_count(0)
                expect(lock).to_be_focused()
                self.assertEqual(self.encryption(world)["state"], "unlocked")
                # Lock it, for real.
                page.keyboard.press("Enter")
                confirm.get_by_role("button", name=f"Lock {A_NAME}").click()
                expect(section.locator(".people__enc-line")).to_have_text("Encrypted · only people, no AI. Waiting to be unlocked.")
                expect(section.get_by_role("status")).to_have_text(f"{A_NAME} is locked.")
                # EN-1: Lock now's slot now reads "Unlock…", and focus is on it.
                unlock = section.get_by_role("button", name="Unlock…")
                expect(unlock).to_be_focused()
                expect(unlock).not_to_have_attribute("aria-disabled", "true")
                self.same_corner(before["Lock now"], self.place(unlock), "Unlock… in Lock now's place")
                self.assertEqual(self.encryption(world)["state"], "locked")
                # Locked: the buttons that need it open are dimmed, still there and still where they were.
                expect(section.get_by_role("button", name="New recovery code")).to_have_attribute("aria-disabled", "true")
                expect(section.get_by_text(f"Unlock {A_NAME} to change these.")).to_be_visible()
                for name in names:
                    if name != "Lock now":
                        self.same_place(before[name], self.place(section.get_by_role("button", name=name)), f"{name} (locked)")
                self.same_place(before["heading"], self.place(section.get_by_role("heading", name="Encryption")), "heading (locked)")
                section.get_by_role("button", name="New recovery code").click(force=True)  # dimmed (aria-disabled), not disabled: a click does nothing
                expect(section.get_by_role("group", name="New recovery code")).to_have_count(0)
                shot(page, f"people-locked-{'phone' if phone else 'computer'}")
                # Unlock in place: the field opens below the row; Esc closes it and returns to the button; the password unlocks.
                unlock.focus()
                page.keyboard.press("Enter")
                field = section.get_by_role("textbox", name="Your unlock password")
                expect(field).to_be_focused()
                page.keyboard.press("Escape")
                expect(field).to_have_count(0)
                expect(unlock).to_be_focused()
                page.keyboard.press("Enter")
                field.fill("not the password at all")
                page.keyboard.press("Enter")
                expect(section.get_by_role("alert").filter(has_text=f"That password doesn’t unlock {A_NAME}.")).to_be_visible()
                field.fill(UNLOCK_PASSWORD)
                page.keyboard.press("Enter")
                expect(section.get_by_role("status")).to_have_text(f"{A_NAME} is unlocked.")
                expect(section.locator(".people__enc-line")).to_have_text(LINE)
                expect(lock).to_be_focused()
                self.same_place(before["Lock now"], self.place(lock), "Lock now (unlocked again)")
                self.assertEqual(self.encryption(world)["state"], "unlocked")

    def test_23_a_holder_lets_an_admin_set_a_first_password_and_the_admin_sets_it(self) -> None:
        for phone in (False, True):
            with self.subTest(window="phone" if phone else "computer"):
                world = self.make_world()
                ben = self.page(world, "ben", phone=phone)
                self.open_people(ben)
                ben_section = self.section(ben)
                # Before anyone has allowed it, the way open to him is the recovery code, and the editor says nothing about a holder.
                first = ben_section.get_by_role("button", name="Use the recovery code")
                at = self.place(first)
                first.click()
                recovery = ben_section.get_by_role("group", name="Set your unlock password")
                expect(recovery.get_by_label("Recovery code")).to_be_focused()
                expect(recovery.get_by_role("button", name=re.compile("instead"))).to_have_count(0)
                self.same_corner(at, self.place(first), "the button that opened the editor")
                recovery.get_by_role("button", name="Cancel").click()
                expect(recovery).to_have_count(0)
                expect(first).to_be_focused()
                self.assertFalse(self.holders(world, "ben"))
                # Ada's window has no stream, so it is stale later on. A wrong password of her own is refused, hers allows it.
                ada = self.page(world, "ada", phone=phone, stream=False)
                self.open_people(ada)
                section = self.section(ada)
                allow = section.get_by_role("button", name="Let Ben set an unlock password")
                allow.click()
                group = section.get_by_role("group", name="Let Ben set an unlock password")
                expect(group).to_contain_text("Enter your own unlock password to let Ben set theirs. It’s allowed for a short time, and it gives Ben no key.")
                expect(group.get_by_role("textbox", name="Your unlock password")).to_be_focused()
                group.get_by_role("textbox", name="Your unlock password").fill("not my password at all")
                group.get_by_role("button", name="Let Ben set one").click()
                expect(group.get_by_role("alert")).to_have_text(f"That password doesn’t unlock {A_NAME}.")
                group.get_by_role("textbox", name="Your unlock password").fill(UNLOCK_PASSWORD)
                group.get_by_role("button", name="Let Ben set one").click()
                expect(section.get_by_role("status")).to_have_text(re.compile(r"^Ben can set an unlock password until \d\d:\d\d\.$"))
                expect(allow).to_be_focused()
                # Ben's open window follows the grant from the stream: the same place now sets the password, and a line says until when.
                set_first = ben_section.get_by_role("button", name="Set your unlock password")
                expect(set_first).to_be_visible()
                expect(ben_section.locator("[data-password-grant]")).to_have_text(re.compile(r"^You can set an unlock password until \d\d:\d\d\.$"))
                self.same_corner(at, self.place(set_first), "the first password button")
                set_first.click()
                editor = ben_section.get_by_role("group", name="Set your unlock password")
                expect(editor.get_by_label("New unlock password")).to_be_focused()
                expect(editor.get_by_label("Recovery code")).to_have_count(0)
                # A permission that ran out while the editor was open is answered in place (the server's 403, once).
                lapsed: list[str] = []

                def lapse(route: Route) -> None:
                    lapsed.append(route.request.method)
                    route.fulfill(status=403, content_type="application/json", body=json.dumps({"code": "UNLOCK_PASSWORD_GRANT_REQUIRED", "error": "Forbidden", "message": "A holder has to allow it"}))
                ben.route(re.compile(r".*/unlock-password$"), lapse)
                editor.get_by_label("New unlock password").fill(NEW_PASSWORD)
                editor.get_by_label("Repeat new password").fill(NEW_PASSWORD)
                editor.get_by_role("button", name="Set password").click()
                expect(editor.get_by_role("alert")).to_have_text("Another owner or admin has to let you set your first unlock password, or you can use the recovery code.")
                self.assertEqual(lapsed, ["PUT"])
                ben.unroute(re.compile(r".*/unlock-password$"), lapse)
                # His weak choices are refused, then a good one is set; the grant is used up.
                editor.get_by_label("New unlock password").fill("short one")
                editor.get_by_label("Repeat new password").fill("short one")
                editor.get_by_role("button", name="Set password").click()
                expect(editor).to_contain_text("Use at least 20 characters. Yours has 9.")
                editor.get_by_role("button", name="Suggest six random words").click()
                expect(editor.get_by_label("New unlock password")).to_have_attribute("type", "text")
                editor.get_by_label("New unlock password").fill("correcthorsebatterystaple")
                editor.get_by_label("Repeat new password").fill("correcthorsebatterystaple")
                editor.get_by_role("button", name="Set password").click()
                expect(editor).to_contain_text("Use at least 20 characters that are hard to guess, for example the six words suggested.")
                editor.get_by_label("New unlock password").fill(NEW_PASSWORD)
                editor.get_by_label("Repeat new password").fill(NEW_PASSWORD)
                editor.get_by_role("button", name="Set password").click()
                expect(ben_section.get_by_role("status")).to_have_text("Your unlock password is set.")
                expect(ben_section.get_by_role("button", name="Change your unlock password")).to_be_visible()
                self.assertTrue(self.holders(world, "ben"))
                # Ada's window is stale (no stream), so it still offers him; the server's answer says he has one.
                allow.click()
                group.get_by_role("textbox", name="Your unlock password").fill(UNLOCK_PASSWORD)
                group.get_by_role("button", name="Let Ben set one").click()
                expect(group.get_by_role("alert")).to_have_text("Ben already has an unlock password.")
                # He changes it with the current one, and unlocks with the new one after a lock.
                ben_section.get_by_role("button", name="Change your unlock password").click()
                change = ben_section.get_by_role("group", name="Change your unlock password")
                change.get_by_label("Your current unlock password").fill("not my password at all")
                change.get_by_label("New unlock password").fill("another quiet lamp by the sea")
                change.get_by_label("Repeat new password").fill("another quiet lamp by the sea")
                change.get_by_role("button", name="Save password").click()
                expect(change.get_by_role("alert")).to_have_text(f"That password doesn’t unlock {A_NAME}.")
                change.get_by_label("Your current unlock password").fill(NEW_PASSWORD)
                change.get_by_role("button", name="Save password").click()
                expect(ben_section.get_by_role("status")).to_have_text("Your unlock password was changed.")
                self.lock(world)
                self.unlock(world, "ben", {"password": "another quiet lamp by the sea"})

    def test_24_a_new_recovery_code_needs_the_owners_password_and_is_shown_once(self) -> None:
        for phone in (False, True):
            with self.subTest(window="phone" if phone else "computer"):
                world = self.make_world()
                page = self.page(world, "ada", phone=phone)
                self.open_people(page)
                section = self.section(page)
                section.get_by_role("button", name="New recovery code").click()
                group = section.get_by_role("group", name="New recovery code")
                expect(group).to_contain_text("The old code stops working.")
                group.get_by_role("textbox", name="Your unlock password").fill("not my password at all")
                group.get_by_role("button", name="Make a new recovery code").click()
                expect(group.get_by_role("alert")).to_have_text(f"That password doesn’t unlock {A_NAME}.")
                group.get_by_role("textbox", name="Your unlock password").fill(UNLOCK_PASSWORD)
                group.get_by_role("button", name="Make a new recovery code").click()
                shown = section.get_by_role("group", name="Your new recovery code")
                expect(shown.locator("[data-recovery-code]")).to_have_text(CODE_SHOWN)
                new = shown.locator("[data-recovery-code]").inner_text()
                expect(shown.get_by_role("button", name=re.compile("copy", re.I))).to_have_count(0)
                expect(shown.get_by_role("button", name="Done", exact=True)).to_be_disabled()
                shown.get_by_role("checkbox", name=re.compile(r"I.ve kept")).check()
                shown.get_by_role("button", name="Done", exact=True).click()
                expect(shown).to_have_count(0)
                expect(section.get_by_role("button", name="New recovery code")).to_be_focused()
                # The old code stops working; the new one unlocks.
                self.lock(world)
                self.call(world, "ben", "POST", f"/api/v1/workspaces/{world.a}/unlock", {"recoveryCode": world.code}, 400)
                self.unlock(world, "ben", {"recoveryCode": new})

    def test_25_removing_or_demoting_an_owner_or_admin_says_a_new_key_is_made_and_what_a_copy_still_opens(self) -> None:
        for phone in (False, True):
            with self.subTest(window="phone" if phone else "computer"):
                world = self.make_world()
                page = self.page(world, "ada", phone=phone)
                self.open_people(page)
                row = page.get_by_role("list", name=f"People in {A_NAME}").get_by_role("listitem").filter(has_text="Ben Okafor")
                row.get_by_role("button", name=re.compile("^Change")).click()
                editor = row.get_by_role("group", name="Change Ben Okafor")
                # Demotion asks first, with the same text.
                choose(editor.get_by_label("Role"), value="member")
                editor.get_by_role("button", name="Save role").click()
                demote = editor.get_by_role("group", name="Make Ben a member")
                expect(demote.get_by_text("Make Ben a member?", exact=True)).to_be_visible()
                expect(demote.get_by_text(ROTATION, exact=True)).to_be_visible()
                expect(demote.get_by_role("button", name="Make Ben a member")).to_be_visible()
                demote.get_by_role("button", name="Keep Ben an admin").click()
                expect(demote).to_have_count(0)
                choose(editor.get_by_label("Role"), value="admin")
                editor.get_by_role("button", name=re.compile("^Remove from")).click()
                confirm = editor.get_by_role("group", name="Remove Ben Okafor")
                expect(confirm.get_by_text("Remove Ben from Garden club?", exact=True)).to_be_visible()
                expect(confirm.get_by_text(ROTATION, exact=True)).to_be_visible()
                expect(confirm.get_by_role("button", name="Remove Ben")).to_be_visible()
                shot(page, f"remove-holder-{'phone' if phone else 'computer'}")
                confirm.get_by_role("button", name="Keep Ben").click()
                expect(confirm).to_have_count(0)
                members = {member["userId"]: member["role"] for member in self.call(world, "ada", "GET", f"/api/v1/workspaces/{world.a}/members")}
                self.assertEqual(members[world.ids["ben"]], "admin", "nothing changed")
                # A member's removal changes no key: the usual short text.
                member_row = page.get_by_role("list", name=f"People in {A_NAME}").get_by_role("listitem").filter(has_text="Cy Moreno")
                member_row.get_by_role("button", name=re.compile("^Change")).click()
                member_row.get_by_role("button", name=re.compile("^Remove from")).click()
                expect(member_row.get_by_role("group", name="Remove Cy Moreno")).to_contain_text("Cy loses access to Garden club at once")
                expect(member_row.get_by_role("group", name="Remove Cy Moreno")).not_to_contain_text("new key")

    def test_26_demoting_an_admin_really_ends_their_unlock_password_and_leaving_says_the_key_changes(self) -> None:
        for phone in (False, True):
            with self.subTest(window="phone" if phone else "computer"):
                world = self.make_world()
                # Ben gets a password (through the API), then Ada demotes him in People: the real server ends his password.
                self.call(world, "ada", "POST", f"/api/v1/workspaces/{world.a}/unlock-password-grants", {"userId": world.ids["ben"], "password": UNLOCK_PASSWORD}, 201)
                self.call(world, "ben", "PUT", f"/api/v1/workspaces/{world.a}/unlock-password", {"newPassword": NEW_PASSWORD}, 200)
                self.assertTrue(self.holders(world, "ben"))
                page = self.page(world, "ada", phone=phone)
                self.open_people(page)
                row = page.get_by_role("list", name=f"People in {A_NAME}").get_by_role("listitem").filter(has_text="Ben Okafor")
                row.get_by_role("button", name=re.compile("^Change")).click()
                editor = row.get_by_role("group", name="Change Ben Okafor")
                choose(editor.get_by_label("Role"), value="member")
                editor.get_by_role("button", name="Save role").click()
                editor.get_by_role("button", name="Make Ben a member").click()
                expect(page.get_by_text("Ben Okafor is now a member.")).to_be_visible()
                self.assertFalse(self.holders(world, "ben"), "the unlock password went with the role")
                # An admin who leaves is told the key changes (Cy, made an admin here); a member who leaves is not (Ben, a member now).
                self.call(world, "ada", "PATCH", f"/api/v1/workspaces/{world.a}/members/{world.ids['cy']}", {"role": "admin"})
                cy = self.page(world, "cy", phone=phone)
                self.open_people(cy)
                leave = cy.get_by_role("region", name=f"Leave {A_NAME}")
                leave.get_by_role("button", name=f"Leave {A_NAME}").click()
                expect(leave.get_by_role("group", name=f"Leave {A_NAME}")).to_contain_text("Garden club gets a new key when you leave. Your unlock password stops opening anything made after that.")
                leave.get_by_role("button", name="Cancel").click()
                ben = self.page(world, "ben", phone=phone)
                self.open_people(ben)
                member_leave = ben.get_by_role("region", name=f"Leave {A_NAME}")
                member_leave.get_by_role("button", name=f"Leave {A_NAME}").click()
                expect(member_leave.get_by_role("group", name=f"Leave {A_NAME}")).not_to_contain_text("new key")

    # ---------------------------------------------------------------- the rest of the interface

    def composer_markers(self, page: Page) -> int:
        """The AI surfaces on show while the composer's "/" menu is open."""
        field = page.locator("#project-composer")
        field.click()
        field.fill("/")
        expect(page.get_by_role("listbox", name="Actions")).to_be_visible()
        count = page.locator("[data-ai-surface]").count()
        field.fill("")
        return count

    def test_30_the_project_says_it_is_encrypted_and_has_no_ai_surface_while_the_control_has(self) -> None:
        world = self.make_world()
        for phone in (False, True):
            with self.subTest(window="phone" if phone else "computer"):
                page = self.page(world, "ada", phone=phone)
                page.goto(f"/projects/{world.a_project}")
                expect(page.get_by_text(A_ROOT).first).to_be_visible()
                self.assertEqual(self.composer_markers(page), 0, "no AI surface in the encrypted space")
                open_details(page)
                expect(page.locator("[data-encrypted-line]")).to_have_text("Encrypted space · only people work here, no AI.")
                self.assertEqual(page.locator("[data-ai-surface]").count(), 0)
                # The control: the plain space beside it keeps its own AI surfaces and shows no such line.
                plain = self.page(world, "ada", phone=phone)
                plain.goto(f"/projects/{world.b_project}")
                expect(plain.get_by_text(B_ROOT).first).to_be_visible()
                self.assertGreater(self.composer_markers(plain), 0, "the plain space keeps AI")
                open_details(plain)
                expect(plain.get_by_text("Everyone in", exact=False).first).to_be_visible()
                expect(plain.locator("[data-encrypted-line]")).to_have_count(0)

    def test_31_settings_says_ai_is_off_there_for_good_and_jump_to_lists_the_waiting_space(self) -> None:
        world = self.make_world()
        self.lock(world)
        for phone in (False, True):
            with self.subTest(window="phone" if phone else "computer"):
                page = self.page(world, "ada", phone=phone)
                page.goto("/settings/agents")
                expect(page.get_by_text(f"Not in {A_NAME}: it is encrypted, so AI is off there for good.").first).to_be_visible()
                page.goto("/")
                expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
                if phone:
                    page.get_by_role("button", name="Search").first.click()
                else:
                    page.keyboard.press("Control+k")
                jump = page.get_by_role("combobox", name="Jump to")
                expect(jump).to_be_visible()
                option = page.get_by_role("option", name=re.compile(f"{A_NAME}.*{LOCKED_LINE}"))
                expect(option).to_be_visible()
                jump.fill("garden")
                expect(option).to_be_visible()
                option.click()
                expect(page).to_have_url(re.compile(rf"/spaces/{world.a}$"))
                expect(page.get_by_role("heading", name=f"Unlock {A_NAME}")).to_be_visible()
                page.goto("/inbox")
                note = page.locator("[data-locked-note]")
                expect(note).to_contain_text(LOCKED_LINE)
                expect(note.get_by_role("link", name=A_NAME)).to_be_visible()


class KeyRotation(Base):
    """The rotation states. The real server answers; `Overlay` sets `rotation`, `recoveryCode: false` and `keyChangedAt` in its answers."""

    class Overlay:
        def __init__(self, space: str) -> None:
            self.space = space
            self.fields: dict = {}

        def fix(self, workspace: dict) -> dict:
            if workspace.get("id") != self.space or not workspace.get("encryption"):
                return workspace
            encryption = {**workspace["encryption"], **self.fields}
            if self.fields.get("recoveryCode") is False:
                # S1: unlocking by the recovery code is the way for an admin without a password.
                encryption["canUnlock"] = encryption["myPassword"]
            if encryption.get("rotation") and encryption["state"] == "locked":
                encryption["rotation"] = {**encryption["rotation"], "paused": True}
            return {**workspace, "encryption": encryption}

    def overlaid(self, world: SimpleNamespace, who: str, phone: bool, overlay: "KeyRotation.Overlay") -> Page:
        context = self.context(world, who, phone=phone)

        def handle(route: Route) -> None:
            request = route.request
            path = urlparse(request.url).path
            listing = path == "/api/v1/workspaces"
            if request.method == "GET" and (listing or re.fullmatch(r"/api/v1/workspaces/[0-9a-f-]{36}", path)):
                response = route.fetch()
                data = response.json()
                route.fulfill(response=response, body=json.dumps([overlay.fix(item) for item in data] if listing else overlay.fix(data)))
            elif request.method in ("DELETE", "PATCH") and "/members/" in path:
                response = route.fetch()
                route.fulfill(response=response)
                if response.status < 300 and (request.method == "DELETE" or json.loads(request.post_data or "{}").get("role") in ("member", "guest")):
                    # As S2c will: the person's leaving starts a rotation and the recovery code stops working.
                    overlay.fields.update({"recoveryCode": False, "rotation": {"percent": 40, "paused": False, "startedAt": now_iso()}})
            elif request.method == "POST" and path.endswith("/recovery-code"):
                response = route.fetch()
                route.fulfill(response=response)
                if response.status < 300:
                    overlay.fields.pop("recoveryCode", None)
            else:
                route.continue_()
        context.route(re.compile(r".*/api/v1/workspaces(/.*)?$"), handle)
        return self.watched(context.new_page())

    def test_40_a_rotation_shows_its_progress_pauses_while_locked_and_ends_with_a_quiet_line(self) -> None:
        for phone in (False, True):
            with self.subTest(window="phone" if phone else "computer"):
                world = self.make_world()
                overlay = self.Overlay(world.a)
                overlay.fields = {"rotation": {"percent": 40, "paused": False, "startedAt": now_iso()}}
                page = self.overlaid(world, "ada", phone, overlay)
                self.open_people(page)
                section = self.section(page)
                expect(section.locator("[data-key-rotation]")).to_have_text(f"Changing the key · 40%. It continues while {A_NAME} is unlocked.")
                # S2c names why and who the new key opens for: the reason in the progress line, the holders on the line below.
                overlay.fields = {"rotation": {"percent": 55, "paused": False, "startedAt": now_iso(), "stalled": False,
                                               "reason": {"kind": "removed", "userId": world.ids["ben"], "name": NAMES["ben"]},
                                               "openFor": [{"userId": world.ids["ada"], "name": NAMES["ada"], "kind": "password"},
                                                           {"userId": world.ids["cy"], "name": NAMES["cy"], "kind": "password"},
                                                           {"userId": None, "name": "Recovery code", "kind": "recovery"}]}}
                expect(section.locator("[data-key-rotation]")).to_have_text(f"Changing the key after Ben left · 55%. It continues while {A_NAME} is unlocked.", timeout=15000)
                expect(section.locator("[data-key-open-for]")).to_have_text("The new key opens for Ada, Cy and the recovery code.")
                section.scroll_into_view_if_needed()
                shot(page, f"rotation-running-{'phone' if phone else 'computer'}")
                overlay.fields = {"rotation": {"percent": 40, "paused": False, "startedAt": now_iso()}}
                self.lock(world)
                page.reload()
                self.open_people(page)
                expect(self.section(page).locator("[data-key-rotation]")).to_have_text(f"Changing the key · paused until {A_NAME} is unlocked.")
                self.unlock(world)
                overlay.fields = {"rotation": None, "keyChangedAt": now_iso()}
                page.reload()
                self.open_people(page)
                section = self.section(page)
                expect(section.locator("[data-key-rotation]")).to_have_count(0)
                expect(section.locator("[data-key-changed]")).to_have_text(re.compile(r"^New key since \d{1,2} \w{3}\.$"))
                section.scroll_into_view_if_needed()
                shot(page, f"after-rotation-{'phone' if phone else 'computer'}")

    def test_41_a_space_without_a_recovery_code_says_so_and_offers_only_what_works(self) -> None:
        for phone in (False, True):
            with self.subTest(window="phone" if phone else "computer"):
                world = self.make_world()
                overlay = self.Overlay(world.a)
                overlay.fields = {"recoveryCode": False}
                ada = self.overlaid(world, "ada", phone, overlay)
                self.open_people(ada)
                section = self.section(ada)
                expect(section.locator("[data-no-recovery-code]")).to_have_text(f"{A_NAME} has no recovery code. Make a new one and keep it safe.")
                expect(section.get_by_role("button", name="New recovery code", exact=True)).to_be_visible()
                section.scroll_into_view_if_needed()
                shot(ada, f"no-recovery-code-{'phone' if phone else 'computer'}")
                ben = self.overlaid(world, "ben", phone, overlay)
                self.open_people(ben)
                ben_section = self.section(ben)
                expect(ben_section.locator("[data-no-recovery-code]")).to_have_text(f"{A_NAME} has no recovery code. An owner can make a new one.")
                expect(ben_section.get_by_role("button", name=re.compile("recovery code", re.I))).to_have_count(0)
                expect(ben_section.get_by_text("You don’t have an unlock password yet. Another owner or admin can let you set one.", exact=True)).to_be_visible()
                # With no code and no permission the button stays in its place, dimmed.
                expect(ben_section.get_by_role("button", name="Set your unlock password")).to_have_attribute("aria-disabled", "true")
                # Locked, the owner can only use her password; the admin has nothing to type.
                self.lock(world)
                ada2 = self.overlaid(world, "ada", phone, overlay)
                ada2.goto(f"/spaces/{world.a}")
                expect(ada2.get_by_role("textbox", name="Your unlock password")).to_be_visible()
                expect(ada2.get_by_role("button", name="Use the recovery code")).to_have_count(0)
                ben2 = self.overlaid(world, "ben", phone, overlay)
                ben2.goto(f"/spaces/{world.a}")
                expect(ben2.locator("[data-locked-reason]")).to_have_text(re.compile(rf"^Ada locked {A_NAME} {AT}\. You don’t have an unlock password for {A_NAME} yet\. Ada can unlock it\.$"))
                expect(ben2.get_by_role("textbox")).to_have_count(0)
                expect(ben2.get_by_role("button", name="Unlock")).to_have_count(0)
                self.unlock(world)
                # Making one clears the line.
                ada3 = self.overlaid(world, "ada", phone, overlay)
                self.open_people(ada3)
                s3 = self.section(ada3)
                s3.get_by_role("button", name="New recovery code", exact=True).click()
                group = s3.get_by_role("group", name="New recovery code")
                expect(group).to_contain_text(f"{A_NAME} has no recovery code now. Enter your own unlock password to make one.")
                group.get_by_role("textbox", name="Your unlock password").fill(UNLOCK_PASSWORD)
                group.get_by_role("button", name="Make a new recovery code").click()
                shown = s3.get_by_role("group", name="Your new recovery code")
                expect(shown.locator("[data-recovery-code]")).to_have_text(CODE_SHOWN)
                shown.get_by_role("checkbox", name=re.compile(r"I.ve kept")).check()
                shown.get_by_role("button", name="Done", exact=True).click()
                expect(s3.locator("[data-no-recovery-code]")).to_have_count(0)
                expect(s3.get_by_role("button", name="New recovery code")).to_be_visible()

    def test_42_removing_an_admin_opens_the_new_recovery_code_in_place(self) -> None:
        for phone in (False, True):
            with self.subTest(window="phone" if phone else "computer"):
                world = self.make_world()
                eli = self.sign_up_eli(world)
                overlay = self.Overlay(world.a)
                ada = self.overlaid(world, "ada", phone, overlay)
                self.open_people(ada)
                section = self.section(ada)
                expect(section.locator("[data-no-recovery-code]")).to_have_count(0)
                row = ada.get_by_role("list", name=f"People in {A_NAME}").get_by_role("listitem").filter(has_text="Eli Dahl")
                row.get_by_role("button", name=re.compile("^Change")).click()
                row.get_by_role("button", name=re.compile("^Remove from")).click()
                row.get_by_role("button", name="Remove Eli").click()
                expect(ada.get_by_text(f"Eli Dahl is no longer in {A_NAME}.")).to_be_visible()
                # The group that makes a new recovery code opens in place, and focus is in it.
                group = section.get_by_role("group", name="New recovery code")
                expect(group).to_contain_text(f"{A_NAME} has no recovery code now. Enter your own unlock password to make one.")
                expect(group.get_by_role("textbox", name="Your unlock password")).to_be_focused()
                expect(section.locator("[data-no-recovery-code]")).to_have_text(f"{A_NAME} has no recovery code. Make a new one and keep it safe.")
                expect(section.locator("[data-key-rotation]")).to_have_text(f"Changing the key · 40%. It continues while {A_NAME} is unlocked.")
                group.get_by_role("textbox", name="Your unlock password").fill(UNLOCK_PASSWORD)
                group.get_by_role("button", name="Make a new recovery code").click()
                shown = section.get_by_role("group", name="Your new recovery code")
                expect(shown.locator("[data-recovery-code]")).to_be_visible()
                shown.get_by_role("checkbox", name=re.compile(r"I.ve kept")).check()
                shown.get_by_role("button", name="Done", exact=True).click()
                expect(section.locator("[data-no-recovery-code]")).to_have_count(0)

    def test_43_a_rotation_that_waits_to_start_or_cannot_finish_says_so(self) -> None:
        for phone in (False, True):
            with self.subTest(window="phone" if phone else "computer"):
                world = self.make_world()
                overlay = self.Overlay(world.a)
                overlay.fields = {"rotation": {"percent": 0, "paused": True, "startedAt": None, "stalled": False}}
                page = self.overlaid(world, "ada", phone, overlay)
                self.open_people(page)
                line = self.section(page).locator("[data-key-rotation]")
                expect(line).to_have_text(f"Changing the key · starting. It continues while {A_NAME} is unlocked.")
                expect(line).to_have_attribute("data-key-rotation", "starting")
                # It cannot finish: the words of the security notice, nothing about the content.
                overlay.fields = {"rotation": {"percent": 99, "paused": False, "startedAt": now_iso(), "stalled": True}}
                expect(line).to_have_text("The key change can’t finish: some stored data doesn’t open. Ask your server’s operator.", timeout=15000)
                self.section(page).scroll_into_view_if_needed()
                shot(page, f"rotation-stalled-{'phone' if phone else 'computer'}")
                # A member reads only the first line.
                cy = self.overlaid(world, "cy", phone, overlay)
                self.open_people(cy)
                expect(self.section(cy).locator("[data-key-rotation]")).to_have_count(0)

    def test_44_a_real_rotation_after_an_admin_is_removed_ends_with_the_new_key_line(self) -> None:
        """S2c's worker rotates for real; the open panel follows it to its end by reading the state again while it runs."""
        world = self.make_world()
        eli = self.sign_up_eli(world)
        page = self.page(world, "ada")
        self.open_people(page)
        section = self.section(page)
        expect(section.locator("[data-key-changed]")).to_have_count(0)
        self.call(world, "ada", "DELETE", f"/api/v1/workspaces/{world.a}/members/{eli['id']}", None, None)
        # Why the key changed outlives the rotation (S3, `keyChangeReason`).
        expect(section.locator("[data-key-changed]")).to_have_text(re.compile(r"^New key since \d{1,2} \w{3}, after Eli left\.$"), timeout=60000)
        expect(section.locator("[data-key-rotation]")).to_have_count(0)
        expect(section.locator("[data-no-recovery-code]")).to_have_text(f"{A_NAME} has no recovery code. Make a new one and keep it safe.")
        final = self.encryption(world)
        self.assertIsNone(final["rotation"])
        self.assertFalse(final["recoveryCode"])
        self.assertIsNotNone(final["keyChangedAt"])
        self.assertEqual(final["keyChangeReason"], {"kind": "removed", "userId": eli["id"], "name": "Eli Dahl"})
        section.scroll_into_view_if_needed()
        shot(page, "after-real-rotation-computer")

    def sign_up_eli(self, world: SimpleNamespace) -> dict:
        """A new admin who really is added, so that a test can really remove them."""
        email, user_id, _ = self.sign_up("eli", uuid.uuid4().hex[:10], "Eli Dahl")
        self.call(world, "ada", "POST", f"/api/v1/workspaces/{world.a}/members", {"email": email, "role": "admin"}, 201)
        return {"id": user_id, "email": email}


if __name__ == "__main__":
    unittest.main()
