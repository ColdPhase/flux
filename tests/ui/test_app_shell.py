"""Browser tests for the app shell and sign-in journeys (issue #40).

Runs against the running Compose application through scripts/check_ui.sh. The browser opens
FLUX_UI_ORIGIN (a loopback origin equal to FLUX_PUBLIC_ORIGIN); when FLUX_UI_UPSTREAM is set,
a small TCP forwarder inside this container carries that loopback port to the API service.
Screenshots are written to FLUX_UI_SCREENSHOTS when it is set.
"""

from __future__ import annotations

import json
import os
import re
import socket
import threading
import time
import unittest
import urllib.parse
import urllib.request
from pathlib import Path

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

ORIGIN = os.environ.get("FLUX_UI_ORIGIN", "http://127.0.0.1:18591").rstrip("/")
UPSTREAM = os.environ.get("FLUX_UI_UPSTREAM")
MAILPIT = os.environ.get("FLUX_MAILPIT_URL")
SHOTS = Path(os.environ["FLUX_UI_SCREENSHOTS"]) if os.environ.get("FLUX_UI_SCREENSHOTS") else None

DESKTOP = {"width": 1440, "height": 900}
PHONE = {"width": 390, "height": 844}
PASSWORD = "a calm long passphrase"
NEW_PASSWORD = "another calm passphrase"
EMAIL = f"jo.marsh+{int(time.time() * 1000)}@example.test"
NAME = "Jo Marsh"


def _pipe(src: socket.socket, dst: socket.socket) -> None:
    try:
        while data := src.recv(65536):
            dst.sendall(data)
    except OSError:
        pass
    finally:
        try:
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def start_forwarder(origin: str, upstream: str) -> None:
    """Listen on the origin's loopback port and forward every connection to the API service."""
    port = urllib.parse.urlsplit(origin).port or 80
    host, _, up_port = upstream.partition(":")
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", port))
    server.listen(128)

    def handle(client: socket.socket) -> None:
        try:
            remote = socket.create_connection((host, int(up_port or 80)), timeout=10)
        except OSError:
            client.close()
            return
        remote.settimeout(None)
        a = threading.Thread(target=_pipe, args=(client, remote), daemon=True)
        b = threading.Thread(target=_pipe, args=(remote, client), daemon=True)
        a.start(); b.start(); a.join(); b.join()
        client.close(); remote.close()

    def accept() -> None:
        while True:
            client, _ = server.accept()
            threading.Thread(target=handle, args=(client,), daemon=True).start()

    threading.Thread(target=accept, daemon=True).start()


def shot(page: Page, name: str) -> None:
    if not SHOTS:
        return
    SHOTS.mkdir(parents=True, exist_ok=True)
    page.evaluate("document.fonts.ready.then(() => true)")
    page.wait_for_timeout(450)  # let panel and view motion settle
    page.screenshot(path=str(SHOTS / f"{name}.png"))


def mailpit_reset_link(email: str) -> str:
    assert MAILPIT, "FLUX_MAILPIT_URL is required for the password reset journey"
    query = urllib.parse.quote(f'to:"{email}"')
    for _ in range(40):
        with urllib.request.urlopen(f"{MAILPIT}/api/v1/search?query={query}") as response:
            found = json.load(response)
        if found.get("messages"):
            message_id = found["messages"][0]["ID"]
            with urllib.request.urlopen(f"{MAILPIT}/api/v1/message/{message_id}") as response:
                text = json.load(response)["Text"]
            match = re.search(r"https?://\S+/api/auth/reset-password/\S+", text)
            assert match, f"reset mail contains a link: {text!r}"
            return match.group(0)
        time.sleep(0.25)
    raise AssertionError(f"no reset mail arrived for {email}")


def box(page: Page, locator) -> dict:
    result = locator.bounding_box()
    assert result, "element is rendered"
    return result


class AppShellJourney(unittest.TestCase):
    """One person's journey; tests run in name order and share the signed-in state."""

    pw = None
    browser: Browser
    state: dict | None = None

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        expect.set_options(timeout=8000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def context(self, *, phone: bool = False, dark: bool = False, signed_in: bool = True, **extra) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "color_scheme": "dark" if dark else "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw"}
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=DESKTOP, device_scale_factor=1)
        if signed_in and self.state:
            options["storage_state"] = self.state
        options.update(extra)
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        return context

    def page(self, **kwargs) -> Page:
        page = self.context(**kwargs).new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def save_state(self, page: Page) -> None:
        type(self).state = page.context.storage_state()

    # ---------------------------------------------------------------- sign-up and session

    def test_01_protected_route_redirects_to_sign_in(self) -> None:
        page = self.page(signed_in=False)
        page.goto("/tasks")
        expect(page).to_have_url(re.compile(r"/sign-in\?next=%2Ftasks$"))
        expect(page.get_by_role("heading", name="Sign in to Flux")).to_be_visible()
        shot(page, "sign-in-desktop-light")

    def test_02_register(self) -> None:
        page = self.page(signed_in=False)
        page.goto("/sign-up")
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_text("Enter the name people will see.")).to_be_visible()
        expect(page.get_by_label("Name")).to_be_focused()
        page.get_by_label("Name").fill(NAME)
        page.get_by_label("Email").fill(EMAIL)
        page.get_by_label("Password").fill("short")
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_text("Use at least 8 characters.")).to_be_visible()
        page.get_by_label("Password").fill(PASSWORD)
        shot(page, "sign-up-desktop-light")
        page.get_by_role("button", name="Create account").click()
        expect(page).to_have_url(f"{ORIGIN}/")
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        expect(page.get_by_role("button", name=re.compile(NAME))).to_be_visible()
        self.save_state(page)

        # The same email cannot register twice; the message offers a way forward.
        again = self.page(signed_in=False)
        again.goto("/sign-up")
        again.get_by_label("Name").fill(NAME)
        again.get_by_label("Email").fill(EMAIL)
        again.get_by_label("Password").fill(PASSWORD)
        again.get_by_role("button", name="Create account").click()
        expect(again.get_by_role("alert")).to_contain_text("already exists")

    def test_03_sign_in_and_reload_keep_the_session(self) -> None:
        page = self.page(signed_in=False)
        page.goto("/sign-in?next=%2Fdocs")
        page.get_by_label("Email").fill(EMAIL)
        page.get_by_label("Password").fill("not the password")
        page.get_by_role("button", name="Sign in").click()
        expect(page.get_by_role("alert")).to_contain_text("don’t match")
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Sign in").click()
        expect(page).to_have_url(f"{ORIGIN}/docs")
        expect(page.get_by_role("heading", name="No docs yet")).to_be_visible()
        page.reload()
        expect(page).to_have_url(f"{ORIGIN}/docs")
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        # A signed-in person who opens sign-in is taken to their work.
        page.goto("/sign-in")
        expect(page).to_have_url(f"{ORIGIN}/")
        self.save_state(page)

    # ---------------------------------------------------------------- desktop layout

    def test_04_desktop_layout_views_and_details(self) -> None:
        page = self.page()
        page.goto("/")
        sidebar = page.get_by_role("complementary", name="Sidebar")
        expect(sidebar).to_be_visible()
        expect(sidebar.get_by_role("link", name="Home")).to_have_attribute("aria-current", "page")
        expect(sidebar.get_by_text("No projects yet")).to_be_visible()
        expect(sidebar.get_by_text("No messages yet")).to_be_visible()
        expect(sidebar.get_by_role("heading", name="Direct messages")).to_be_visible()
        views = page.get_by_role("navigation", name="Views")
        for label in ("Conversation", "Tasks", "Map", "Docs"):
            expect(views.get_by_role("link", name=label, exact=True)).to_be_visible()
        expect(views.get_by_role("link", name="Conversation")).to_have_attribute("aria-current", "page")
        expect(page.get_by_role("heading", name="Nothing here yet")).to_be_visible()
        composer = page.get_by_label("Private note", exact=True)
        # The composer sits at the bottom of the work area and always shows its audience.
        self.assertGreater(box(page, composer)["y"], DESKTOP["height"] - 130)
        expect(page.locator(".composer__audience")).to_contain_text("Only you")
        shot(page, "desktop-1440-empty-light")

        # Quick capture: Enter saves a private note, which survives a reload.
        save = page.get_by_role("button", name="Save note")
        expect(save).to_have_attribute("aria-disabled", "true")
        composer.fill("Lamp idea: wave to dim, but keep the camera off by default")
        expect(save).to_have_attribute("aria-disabled", "false")
        composer.press("Enter")
        notes = page.get_by_role("region", name="Your private notes")
        expect(notes.get_by_text("Lamp idea: wave to dim")).to_be_visible()
        expect(composer).to_have_value("")
        composer.fill("Try a PIR sensor first; compare with the camera in low light")
        save.click()
        page.reload()
        expect(page.get_by_role("region", name="Your private notes").get_by_role("listitem")).to_have_count(2)
        expect(page.get_by_text("Only you can see these")).to_be_visible()
        shot(page, "desktop-1440-light")

        indicator = page.locator(".views .ui-tabs__indicator")
        before = indicator.evaluate("el => el.style.transform")
        views.get_by_role("link", name="Tasks").click()
        expect(page).to_have_url(f"{ORIGIN}/tasks")
        expect(views.get_by_role("link", name="Tasks")).to_have_attribute("aria-current", "page")
        expect(page.get_by_role("heading", name="No tasks yet")).to_be_visible()
        self.assertNotEqual(before, indicator.evaluate("el => el.style.transform"), "the underline moves to the chosen view")
        views.get_by_role("link", name="Map").click()
        expect(page.get_by_role("heading", name="Start a sketch")).to_be_visible()
        shot(page, "desktop-1440-map-light")

        details_button = page.get_by_role("button", name="Details", exact=True)
        expect(details_button).to_have_attribute("aria-expanded", "false")
        details_button.click()
        panel = page.get_by_role("complementary", name="Details")
        expect(panel).to_be_visible()
        expect(details_button).to_have_attribute("aria-expanded", "true")
        expect(panel.get_by_text(EMAIL)).to_be_visible()
        # Docked: the work area stays usable beside the panel.
        self.assertGreater(box(page, panel)["x"], 1000)
        expect(page.get_by_role("heading", name="Start a sketch")).to_be_visible()
        self.assertTrue(panel.evaluate("el => el.contains(document.activeElement)"), "focus moves into the panel")
        shot(page, "desktop-1440-details-light")
        page.keyboard.press("Escape")
        expect(panel).to_have_count(0)
        expect(details_button).to_be_focused()
        page.keyboard.press("]")
        expect(page.get_by_role("complementary", name="Details")).to_be_visible()
        page.get_by_role("button", name="Close details").click()
        expect(page.get_by_role("complementary", name="Details")).to_have_count(0)

        page.goto("/nowhere")
        expect(page.get_by_role("heading", name="This page doesn’t exist")).to_be_visible()

    def test_05_desktop_dark_and_tablet(self) -> None:
        page = self.page(dark=True)
        page.goto("/")
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        self.assertEqual(page.evaluate("getComputedStyle(document.body).backgroundColor"), "rgb(20, 21, 23)")
        shot(page, "desktop-1440-dark")
        page.get_by_role("button", name="Details", exact=True).click()
        expect(page.get_by_role("complementary", name="Details")).to_be_visible()
        shot(page, "desktop-1440-details-dark")

        tablet = self.page(viewport={"width": 1024, "height": 768})
        tablet.goto("/")
        # At 1024px the sidebar is a drawer and Details docks.
        expect(tablet.get_by_role("complementary", name="Sidebar")).to_have_count(0)
        expect(tablet.get_by_role("button", name="Open navigation")).to_be_visible()
        shot(tablet, "tablet-1024-light")

    # ---------------------------------------------------------------- phone layout

    def test_06_phone_drawer_sheet_and_targets(self) -> None:
        page = self.page(phone=True)
        page.goto("/")
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        expect(page.get_by_role("complementary", name="Sidebar")).to_have_count(0)
        composer = page.get_by_label("Private note", exact=True)
        composer_box = box(page, page.locator(".composer"))
        self.assertAlmostEqual(composer_box["y"] + composer_box["height"], PHONE["height"], delta=2, msg="composer is pinned to the bottom")
        shot(page, "phone-390-light")

        # Coarse pointer: primary targets are at least 44px.
        menu = page.get_by_role("button", name="Open navigation")
        details_button = page.get_by_role("button", name="Details", exact=True)
        targets = [menu, details_button, *[page.get_by_role("navigation", name="Views").get_by_role("link", name=n, exact=True) for n in ("Conversation", "Tasks", "Map", "Docs")]]
        for target in targets:
            size = box(page, target)
            self.assertGreaterEqual(min(size["width"], size["height"]), 44, f"44px target: {target}")
        self.assertGreaterEqual(box(page, page.get_by_role("button", name="Save note"))["height"], 44)
        expect(composer).to_be_editable()

        menu.click()
        drawer = page.get_by_role("dialog", name="Flux")
        expect(drawer).to_be_visible()
        expect(menu).to_have_attribute("aria-expanded", "true")
        self.assertTrue(drawer.evaluate("el => el.contains(document.activeElement)"), "focus moves into the drawer")
        self.assertTrue(page.evaluate("document.getElementById('root').inert"), "the page behind the drawer is inert")
        # Tab stays inside the drawer.
        for _ in range(8):
            page.keyboard.press("Tab")
            self.assertTrue(drawer.evaluate("el => el.contains(document.activeElement)"), "focus stays in the drawer")
        shot(page, "phone-390-drawer-light")
        page.keyboard.press("Escape")
        expect(page.get_by_role("dialog")).to_have_count(0)
        expect(menu).to_be_focused()
        menu.click()
        page.get_by_role("dialog", name="Flux").get_by_role("button", name="Close navigation").click()
        expect(page.get_by_role("dialog")).to_have_count(0)

        details_button.click()
        sheet = page.get_by_role("dialog", name="Details")
        expect(sheet).to_be_visible()
        page.wait_for_timeout(400)
        sheet_box = box(page, sheet)
        self.assertEqual((round(sheet_box["x"]), round(sheet_box["y"]), round(sheet_box["width"]), round(sheet_box["height"])), (0, 0, PHONE["width"], PHONE["height"]), "Details is a full-screen sheet")
        shot(page, "phone-390-details-light")
        page.keyboard.press("Escape")
        expect(page.get_by_role("dialog")).to_have_count(0)
        expect(details_button).to_be_focused()
        details_button.click()
        page.get_by_role("dialog", name="Details").get_by_role("button", name="Close details").click()
        expect(page.get_by_role("dialog")).to_have_count(0)

    def test_07_phone_dark_and_narrow(self) -> None:
        page = self.page(phone=True, dark=True)
        page.goto("/")
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        shot(page, "phone-390-dark")
        page.get_by_role("button", name="Open navigation").click()
        expect(page.get_by_role("dialog", name="Flux")).to_be_visible()
        shot(page, "phone-390-drawer-dark")

        page.keyboard.press("Escape")
        page.goto("/map")
        page.get_by_role("button", name="New thought").click()
        expect(page).to_have_url(f"{ORIGIN}/")
        expect(page.get_by_label("Private note", exact=True)).to_be_focused()

        narrow = self.page(phone=True, viewport={"width": 360, "height": 780})
        narrow.goto("/tasks")
        expect(narrow.get_by_role("heading", name="No tasks yet")).to_be_visible()
        self.assertLessEqual(narrow.evaluate("document.documentElement.scrollWidth"), 360, "no horizontal scroll at 360px")
        shot(narrow, "phone-360-tasks-light")

        signin = self.page(phone=True, dark=True, signed_in=False)
        signin.goto("/sign-in")
        expect(signin.get_by_role("heading", name="Sign in to Flux")).to_be_visible()
        shot(signin, "sign-in-phone-dark")

    # ---------------------------------------------------------------- theme and motion

    def test_08_theme_choice_persists_and_reduced_motion(self) -> None:
        page = self.page()
        page.goto("/")
        account = page.get_by_role("button", name=re.compile(NAME))
        account.click()
        menu = page.get_by_role("dialog", name="Account")
        expect(menu).to_be_visible()
        menu.get_by_role("radio", name="Dark").click()
        self.assertEqual(page.evaluate("document.documentElement.dataset.theme"), "dark")
        page.keyboard.press("Escape")
        expect(menu).to_have_count(0)
        expect(account).to_be_focused()
        page.reload()
        self.assertEqual(page.evaluate("document.documentElement.dataset.theme"), "dark")
        account.click()
        page.get_by_role("dialog", name="Account").get_by_role("radio", name="System").click()
        self.assertIsNone(page.evaluate("document.documentElement.dataset.theme ?? null"))

        calm = self.page(reduced_motion="reduce")
        calm.goto("/")
        self.assertEqual(calm.evaluate("parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dur-3'))"), 0)
        calm.get_by_role("button", name="Details", exact=True).click()
        panel = calm.get_by_role("complementary", name="Details")
        expect(panel).to_be_visible()
        self.assertEqual(panel.evaluate("el => el.getAnimations().length"), 0, "no panel animation under reduced motion")

    # ---------------------------------------------------------------- password reset

    def test_09_password_reset_through_mail(self) -> None:
        page = self.page(signed_in=False)
        page.goto("/sign-in")
        page.get_by_role("link", name="Forgot password?").click()
        expect(page.get_by_role("heading", name="Reset your password")).to_be_visible()
        page.get_by_label("Email").fill(EMAIL)
        page.get_by_role("button", name="Send reset link").click()
        expect(page.get_by_role("heading", name="Check your email")).to_be_visible()

        link = mailpit_reset_link(EMAIL)
        self.assertTrue(link.startswith(f"{ORIGIN}/api/auth/reset-password/"), link)
        page.goto(link)
        expect(page).to_have_url(re.compile(r"/reset-password\?token="))
        expect(page.get_by_role("heading", name="Choose a new password")).to_be_visible()
        page.get_by_label("New password", exact=True).fill(NEW_PASSWORD)
        page.get_by_label("Repeat new password").fill("something else")
        page.get_by_role("button", name="Save new password").click()
        expect(page.get_by_text("The two passwords don’t match.")).to_be_visible()
        page.get_by_label("Repeat new password").fill(NEW_PASSWORD)
        page.get_by_role("button", name="Save new password").click()
        expect(page).to_have_url(f"{ORIGIN}/sign-in")
        expect(page.get_by_role("status").filter(has_text="Your password was changed")).to_be_visible()

        # Resetting signs out every session, including the saved one.
        old = self.page()
        old.goto("/")
        expect(old).to_have_url(f"{ORIGIN}/sign-in")

        page.get_by_label("Email").fill(EMAIL)
        page.get_by_label("Password").fill(NEW_PASSWORD)
        page.get_by_role("button", name="Sign in").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        self.save_state(page)

        # A used or expired link explains itself and offers a new one.
        page.goto("/reset-password?error=INVALID_TOKEN")
        expect(page.get_by_role("heading", name="This reset link no longer works")).to_be_visible()
        expect(page.get_by_role("link", name="Request a new link")).to_be_visible()

    def test_10_password_reset_unavailable(self) -> None:
        page = self.page(signed_in=False)
        # Simulate a server without SMTP: capabilities say so and the request answers 503.
        page.route("**/api/v1/auth/capabilities", lambda route: route.fulfill(json={"passwordReset": "unavailable"}))
        page.goto("/forgot-password")
        expect(page.get_by_text("Password reset by email isn’t set up on this Flux server.")).to_be_visible()
        expect(page.get_by_role("button", name="Send reset link")).to_be_disabled()
        shot(page, "reset-unavailable-desktop-light")

        late = self.page(signed_in=False)
        late.route("**/api/auth/request-password-reset", lambda route: route.fulfill(status=503, json={"error": "Password reset is unavailable", "code": "PASSWORD_RESET_UNAVAILABLE"}))
        late.goto("/forgot-password")
        late.get_by_label("Email").fill(EMAIL)
        late.get_by_role("button", name="Send reset link").click()
        expect(late.get_by_text("Password reset by email isn’t set up on this Flux server.")).to_be_visible()

    # ---------------------------------------------------------------- sign out

    def test_11_sign_out_then_protected_routes_redirect(self) -> None:
        page = self.page(phone=True)
        page.goto("/map")
        page.get_by_role("button", name="Open navigation").click()
        drawer = page.get_by_role("dialog", name="Flux")
        drawer.get_by_role("button", name=re.compile(NAME)).click()
        drawer.get_by_role("dialog", name="Account").get_by_role("button", name="Sign out").click()
        expect(page).to_have_url(f"{ORIGIN}/sign-in")
        expect(page.get_by_role("status").filter(has_text="You’re signed out.")).to_be_visible()
        page.goto("/map")
        expect(page).to_have_url(re.compile(r"/sign-in\?next=%2Fmap$"))
        page.reload()
        expect(page.get_by_role("heading", name="Sign in to Flux")).to_be_visible()


if __name__ == "__main__":
    unittest.main(verbosity=2)
