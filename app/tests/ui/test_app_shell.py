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
import uuid
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


_FORWARDING: set[str] = set()


def start_forwarder(origin: str, upstream: str) -> None:
    """Listen on the origin's loopback port and forward every connection to the API service.

    Idempotent per origin, so several test modules in one run share the listener."""
    if origin in _FORWARDING:
        return
    _FORWARDING.add(origin)
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


def open_sources(page: Page) -> None:
    """Opens the project's sources above the composer (#117), where materials are saved and cited."""
    button = page.get_by_role("button", name=re.compile("^Sources"))
    if button.get_attribute("aria-expanded") != "true":
        button.click()
    expect(page.get_by_role("region", name="Project materials")).to_be_visible()


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
        # Studio 11.6 (#136): one sidebar on the chrome with the Flux mark and the places, then the
        # work on a rounded sheet. No identity rail.
        expect(sidebar.get_by_role("img", name="Flux")).to_be_visible()
        places = sidebar.get_by_role("navigation", name="Places")
        expect(places.get_by_role("link", name="Home")).to_have_attribute("aria-current", "page")
        expect(places.get_by_role("link", name="Direct messages")).not_to_have_attribute("aria-current", "page")
        self.assertEqual(places.get_by_role("link").all_inner_texts(), ["Home", "Inbox", "Direct messages", "My sketchbook"])
        side_box = box(page, sidebar)
        self.assertEqual((round(side_box["x"]), round(side_box["width"])), (0, 220), "a 220px sidebar at the far left")
        self.assertEqual(page.evaluate("getComputedStyle(document.querySelector('.app')).backgroundColor"), "rgb(242, 243, 245)", "the chrome")
        sheet = page.locator(".app__main")
        self.assertEqual(sheet.evaluate("el => [getComputedStyle(el).borderTopLeftRadius, getComputedStyle(el).backgroundColor]"), ["13px", "rgb(255, 255, 255)"], "a rounded white sheet")
        self.assertEqual(round(box(page, sheet)["x"]), 220, "the sheet meets the sidebar")
        rail = places
        marker = places.get_by_role("link", name="Home").evaluate("el => { const s = getComputedStyle(el, '::before'); return [s.width, s.height]; }")
        self.assertEqual(marker, ["2px", "14px"], "a short accent bar beside the current place")
        expect(sidebar.get_by_text("No projects yet")).to_be_visible()
        expect(sidebar.get_by_role("button", name=re.compile("^New note"))).to_be_visible()
        views = page.get_by_role("navigation", name="Views")
        for label in ("Conversation", "Map", "Tasks", "Wiki"):
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
        expect(page.get_by_role("heading", name="Nothing is waiting for you")).to_be_visible()
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
        expect(panel.get_by_role("heading", name="Nothing selected")).to_be_visible()
        expect(panel.get_by_text(EMAIL)).to_have_count(0)
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

        # Direct messages is its own place: the sidebar lists conversations, there are no views.
        rail.get_by_role("link", name="Direct messages").click()
        expect(page).to_have_url(f"{ORIGIN}/dm")
        expect(page.get_by_role("heading", level=1, name="Direct messages")).to_be_visible()
        expect(page.get_by_role("heading", name="No direct messages yet")).to_be_visible()
        expect(rail.get_by_role("link", name="Direct messages")).to_have_attribute("aria-current", "page")
        expect(sidebar.get_by_text("No conversations yet", exact=False)).to_be_visible()
        expect(sidebar.get_by_role("link", name="New message")).to_be_visible()
        expect(page.get_by_role("navigation", name="Views")).to_have_count(0)
        shot(page, "desktop-1440-dm-light")
        rail.get_by_role("link", name="Home").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()

        page.goto("/nowhere")
        expect(page.get_by_role("heading", name="This page doesn’t exist")).to_be_visible()

    # ---------------------------------------------------------------- unfinished work

    def test_04a_draft_survives_view_switch_and_reload(self) -> None:
        page = self.page()
        page.goto("/")
        views = page.get_by_role("navigation", name="Views")
        composer = page.get_by_label("Private note", exact=True)
        state = page.locator(".composer__state")
        expect(state).to_have_text("Notes stay in this browser until sharing arrives")
        unfinished = "Half a thought: what if the lamp dims when nobody moves for"
        composer.fill(unfinished)
        expect(state).to_have_text("Draft kept on this device")
        user_id = page.evaluate("fetch('/api/v1/me').then(r => r.json()).then(b => b.user.id)")
        self.assertEqual(page.evaluate(f"localStorage.getItem('flux:draft:{user_id}:home')"), unfinished, "stored per account and context")

        # A view switch remounts the composer; the text comes back.
        views.get_by_role("link", name="Tasks").click()
        expect(page.get_by_role("heading", name="Nothing is waiting for you")).to_be_visible()
        views.get_by_role("link", name="Conversation").click()
        expect(composer).to_have_value(unfinished)
        expect(state).to_have_text("Draft kept on this device")

        # So does a reload.
        page.reload()
        expect(page.get_by_label("Private note", exact=True)).to_have_value(unfinished)
        shot(page, "desktop-1440-draft-light")

        # Sending saves the note and clears the draft, also after a reload.
        page.get_by_label("Private note", exact=True).press("Enter")
        expect(page.get_by_role("region", name="Your private notes").get_by_text(unfinished)).to_be_visible()
        expect(page.get_by_label("Private note", exact=True)).to_have_value("")
        expect(state).to_have_text("Notes stay in this browser until sharing arrives")
        self.assertIsNone(page.evaluate(f"localStorage.getItem('flux:draft:{user_id}:home')"))
        page.reload()
        expect(page.get_by_label("Private note", exact=True)).to_have_value("")

        # Another account on the same browser does not see this draft.
        page.get_by_label("Private note", exact=True).fill("Only mine")
        self.assertEqual(page.evaluate("Object.keys(localStorage).filter(k => k.startsWith('flux:draft:'))"), [f"flux:draft:{user_id}:home"])
        page.get_by_label("Private note", exact=True).fill("")

    def test_04b_reading_position_is_kept_per_view(self) -> None:
        page = self.page()
        page.goto("/")
        user_id = page.evaluate("fetch('/api/v1/me').then(r => r.json()).then(b => b.user.id)")
        key = f"flux.captures.{user_id}"
        saved = page.evaluate(f"localStorage.getItem('{key}')")
        notes = [{"id": f"n{i}", "text": f"Reading position check, note {i + 1}: a long enough line to take real space in the column.", "createdAt": "2026-09-27T09:00:00.000Z"} for i in range(40)]
        page.evaluate(f"localStorage.setItem('{key}', JSON.stringify({json.dumps(notes)}))")
        try:
            page.reload()
            scroller = page.locator(".convo .pane-scroll")
            expect(page.get_by_text("note 40:")).to_be_attached()
            scroller.evaluate("el => { el.scrollTop = 600; el.dispatchEvent(new Event('scroll')); }")
            page.wait_for_timeout(100)
            views = page.get_by_role("navigation", name="Views")
            views.get_by_role("link", name="Wiki").click()
            expect(page.get_by_role("heading", name="No docs yet")).to_be_visible()
            views.get_by_role("link", name="Conversation").click()
            self.assertAlmostEqual(page.locator(".convo .pane-scroll").evaluate("el => el.scrollTop"), 600, delta=2, msg="position restored after a view switch")
            page.reload()
            expect(page.get_by_text("note 40:")).to_be_attached()
            self.assertAlmostEqual(page.locator(".convo .pane-scroll").evaluate("el => el.scrollTop"), 600, delta=2, msg="position restored after a reload")
        finally:
            page.evaluate(f"localStorage.setItem('{key}', {json.dumps(saved)}); localStorage.removeItem('flux:scroll:{user_id}:/')" if saved else f"localStorage.removeItem('{key}'); localStorage.removeItem('flux:scroll:{user_id}:/')")
            self.save_state(page)

    def test_04c_personal_assistant_needs_a_connection(self) -> None:
        page = self.page()
        page.goto("/")
        composer = page.get_by_label("Private note", exact=True)
        composer.fill("Which sensor works in the dark?")
        # With no assistant of their own, the spark button leads to "Connect your AI" (#189); nothing is
        # sent and the private note stays where it is.
        ask = page.locator(".composer__ask")
        expect(ask).to_have_accessible_name("Connect your AI")
        expect(ask).not_to_have_attribute("aria-pressed", re.compile(".*"))
        ask.click()
        panel = page.get_by_role("complementary", name="Details")
        expect(panel.get_by_role("heading", name="Connect your AI")).to_be_visible()
        expect(panel.get_by_role("link", name="Set up your assistant in Flux")).to_have_attribute("href", "/settings/assistant")
        expect(panel.get_by_role("link", name="Set up or revoke a Claude Code connection")).to_have_attribute("href", "/connect-agent")
        expect(panel.get_by_text("Flux works fully without AI.", exact=False)).to_be_visible()
        shot(page, "desktop-1440-ask-light")
        panel.get_by_role("button", name="Back to Details").click()
        expect(panel.get_by_role("heading", name="Nothing selected")).to_be_visible()
        page.get_by_role("button", name="Close details").click()
        expect(composer).to_have_value("Which sensor works in the dark?")
        expect(page.locator(".composer__audience")).to_contain_text("Only you")
        expect(page.get_by_role("button", name="Save note")).to_have_attribute("aria-disabled", "false")
        composer.fill("")

    def test_05_desktop_dark_and_tablet(self) -> None:
        page = self.page(dark=True)
        page.goto("/")
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        self.assertEqual(page.evaluate("getComputedStyle(document.body).backgroundColor"), "rgb(25, 28, 33)", "the dark chrome")
        self.assertEqual(page.locator(".app__main").evaluate("el => getComputedStyle(el).backgroundColor"), "rgb(33, 37, 43)", "the dark sheet")
        shot(page, "desktop-1440-dark")
        page.get_by_role("button", name="Details", exact=True).click()
        expect(page.get_by_role("complementary", name="Details")).to_be_visible()
        shot(page, "desktop-1440-details-dark")

        tablet = self.page(viewport={"width": 1024, "height": 768})
        tablet.goto("/")
        # At 1024px the 220px sidebar stays beside the sheet (Studio 11.6 keeps it down to 681px).
        expect(tablet.get_by_role("complementary", name="Sidebar")).to_be_visible()
        expect(tablet.get_by_role("button", name="Open navigation")).to_have_count(0)
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
        targets = [menu, details_button, *[page.get_by_role("navigation", name="Views").get_by_role("link", name=n, exact=True) for n in ("Conversation", "Map", "Tasks", "Wiki")]]
        for target in targets:
            size = box(page, target)
            self.assertGreaterEqual(min(size["width"], size["height"]), 44, f"44px target: {target}")
        self.assertGreaterEqual(box(page, page.get_by_role("button", name="Save note"))["height"], 44)
        expect(composer).to_be_editable()

        menu.click()
        drawer = page.get_by_role("dialog", name="Flux")
        expect(drawer).to_be_visible()
        expect(menu).to_have_attribute("aria-expanded", "true")
        # The sidebar is a 260px drawer with the places as 44px+ rows.
        drawer_places = drawer.get_by_role("navigation", name="Places")
        expect(drawer_places).to_be_visible()
        self.assertLessEqual(round(box(page, drawer)["width"]), 260)
        for name in ("Home", "Inbox", "Direct messages"):
            self.assertGreaterEqual(box(page, drawer_places.get_by_role("link", name=name))["height"], 44, f"44px place target: {name}")
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
        # Sketching itself is covered by tests/ui/test_sketches.py (#69).
        expect(page.get_by_role("button", name="New sketch")).to_be_visible()

        narrow = self.page(phone=True, viewport={"width": 360, "height": 780})
        narrow.goto("/tasks")
        expect(narrow.get_by_role("heading", name="Nothing is waiting for you")).to_be_visible()
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
        # Account and session details live here, with this device's notifications (#41).
        expect(menu.get_by_text(EMAIL)).to_be_visible()
        expect(menu.get_by_text("Signed in on this device until")).to_be_visible()
        expect(menu.get_by_text("Notifications on this device")).to_be_visible()
        # check_ui.sh runs without VAPID keys, so the server says push isn't set up.
        expect(menu.get_by_role("note")).to_contain_text("Notifications are not set up on this Flux server.")
        shot(page, "desktop-1440-account-light")
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


    def test_12_real_project_capture_phone_and_revocation(self) -> None:
        """Real UI: create project, send, cite a saved version, reply, revisit on phone, revoke."""
        owner = self.page()
        owner.goto("/sign-in")
        owner.get_by_label("Email").fill(EMAIL)
        owner.get_by_label("Password").fill(NEW_PASSWORD)
        owner.get_by_role("button", name="Sign in").click()
        expect(owner.get_by_role("heading", level=1, name="Home")).to_be_visible()
        owner.get_by_role("link", name="New project").click()
        owner.get_by_label("Your space").fill("Lamp lab")
        owner.get_by_label("Project name").fill("Gesture lamp")
        project_attempts = {"count": 0}
        def fail_first_project(route) -> None:
            if route.request.method != "POST":
                route.continue_()
                return
            project_attempts["count"] += 1
            if project_attempts["count"] == 1:
                route.abort("failed")
            else:
                route.continue_()
        owner.route("**/api/v1/workspaces/*/projects", fail_first_project)
        owner.get_by_role("button", name="Create project").click()
        expect(owner.get_by_role("alert")).to_contain_text("Could not create this project")
        expect(owner.get_by_text("In Lamp lab")).to_be_visible()
        owner.get_by_role("button", name="Create project").click()
        expect(owner.get_by_role("heading", level=1, name="Gesture lamp")).to_be_visible()
        owner.unroute("**/api/v1/workspaces/*/projects", fail_first_project)
        project_id = owner.locator(".project-convo").get_attribute("data-project-id")
        self.assertTrue(project_id)
        spaces = owner.context.request.get(f"{ORIGIN}/api/v1/workspaces").json()
        self.assertEqual(len(spaces), 1, "project retry must reuse the newly created space")
        ws = spaces[0]
        owner.get_by_role("link", name="Home").click()
        owner.get_by_label("Private note", exact=True).fill("home address 123; PIR avoids storing images")
        owner.get_by_role("button", name="Save note").click()
        expect(owner.get_by_role("region", name="Private drafts").get_by_text("home address 123; PIR avoids storing images")).to_be_visible()
        owner.reload()
        expect(owner.get_by_role("region", name="Private drafts").get_by_text("home address 123; PIR avoids storing images")).to_be_visible()
        draft_id = owner.context.request.get(f"{ORIGIN}/api/v1/workspaces/{ws['id']}/drafts").json()["items"][0]["id"]
        owner.get_by_role("navigation", name="Projects").get_by_role("link", name="Gesture lamp").click()
        owner.get_by_label("Start a conversation").fill("Try a PIR sensor before considering a camera")
        owner.get_by_role("button", name="Start conversation").click()
        expect(owner.locator(".project-convo__message > p").filter(has_text="Try a PIR sensor before considering a camera")).to_be_visible()
        expect(owner).to_have_url(re.compile(r"/conversations/[0-9a-f-]+$"))
        conversation_id = owner.url.split("/conversations/")[-1]
        open_sources(owner)
        owner.get_by_role("button", name="Add material").click()
        owner.get_by_label("Start from a private draft").select_option(draft_id)
        expect(owner.get_by_label("Text")).to_have_value("home address 123; PIR avoids storing images")
        owner.get_by_label("Title").fill("Privacy options")
        owner.get_by_label("Text").fill("PIR avoids storing images")
        owner.get_by_role("navigation", name="Places").get_by_role("link", name="Home").click()
        owner.go_back()
        expect(owner.get_by_label("Title")).to_have_value("Privacy options")
        expect(owner.get_by_label("Text")).to_have_value("PIR avoids storing images")
        expect(owner.get_by_label("Start from a private draft")).to_have_value(draft_id)
        owner.get_by_role("button", name="Save for this project").press("Enter")
        expect(owner.get_by_text("Privacy options")).to_be_visible()
        owner.get_by_role("button", name="Discuss this version").click()
        expect(owner.get_by_text("Discussing “Privacy options” v1")).to_be_visible()
        owner.get_by_label("Reply", exact=True).fill("This is the version we should prototype")
        owner.get_by_role("button", name="Send reply").click()
        expect(owner.get_by_text("This is the version we should prototype", exact=True)).to_be_visible()
        source = owner.get_by_role("link", name="Source: Privacy options · v1")
        expect(source).to_be_visible()
        source.click()
        expect(owner.get_by_text("PIR avoids storing images")).to_be_visible()
        owner.go_back()
        expect(owner.get_by_text("This is the version we should prototype", exact=True)).to_be_visible()
        owner.goto(f"/projects/{project_id}/conversations/{conversation_id}")
        expect(owner.get_by_text("This is the version we should prototype", exact=True)).to_be_visible()
        shot(owner, "conversation-desktop-1440")

        lost = {"count": 0}
        def drop_first_response(route) -> None:
            lost["count"] += 1
            if lost["count"] == 1:
                response = route.fetch()
                self.assertEqual(response.status, 201)
                route.abort("failed")
            else:
                route.continue_()
        owner.route("**/api/v1/conversations/*/messages", drop_first_response)
        owner.get_by_label("Reply", exact=True).fill("Retry this one reply")
        owner.get_by_role("button", name="Send reply").click()
        expect(owner.get_by_role("alert")).to_contain_text("Flux could not be reached")
        owner.get_by_role("button", name="Retry send").click()
        expect(owner.get_by_text("Retry this one reply", exact=True)).to_be_visible()
        owner.unroute("**/api/v1/conversations/*/messages", drop_first_response)
        saved = owner.context.request.get(f"{ORIGIN}/api/v1/conversations/{conversation_id}").json()
        self.assertEqual(sum(message["body"] == "Retry this one reply" for message in saved["messages"]), 1)

        # The server commits, the response disappears, and the browser reloads before
        # the person retries. The client id must survive the remount with the draft.
        def lose_committed_reply(route) -> None:
            response = route.fetch()
            self.assertEqual(response.status, 201)
            route.abort("failed")
        owner.route("**/api/v1/conversations/*/messages", lose_committed_reply)
        owner.get_by_label("Reply", exact=True).fill("Reload after lost reply")
        owner.get_by_role("button", name="Send reply").click()
        expect(owner.get_by_role("alert")).to_contain_text("Flux could not be reached")
        owner.unroute("**/api/v1/conversations/*/messages", lose_committed_reply)
        owner.reload()
        expect(owner.get_by_label("Reply", exact=True)).to_have_value("Reload after lost reply")
        owner.get_by_role("button", name="Send reply").click()
        expect(owner.get_by_label("Reply", exact=True)).to_have_value("")
        saved = owner.context.request.get(f"{ORIGIN}/api/v1/conversations/{conversation_id}").json()
        self.assertEqual(sum(message["body"] == "Reload after lost reply" for message in saved["messages"]), 1)

        owner.get_by_role("link", name="New conversation").click()
        def lose_committed_opening(route) -> None:
            response = route.fetch()
            self.assertEqual(response.status, 201)
            route.abort("failed")
        owner.route("**/api/v1/projects/*/conversations", lose_committed_opening)
        owner.get_by_label("Start a conversation").fill("Revisit after lost opening")
        owner.get_by_role("button", name="Start conversation").click()
        expect(owner.get_by_role("alert")).to_contain_text("Flux could not be reached")
        owner.unroute("**/api/v1/projects/*/conversations", lose_committed_opening)
        owner.get_by_role("link", name="Home").click()
        owner.goto(f"/projects/{project_id}?new=1")
        expect(owner.get_by_label("Start a conversation")).to_have_value("Revisit after lost opening")
        owner.get_by_role("button", name="Start conversation").click()
        # The sidebar lists the same thread (#117); the message itself is in the feed.
        expect(owner.get_by_role("region", name="Messages").get_by_text("Revisit after lost opening", exact=True)).to_be_visible()
        threads = owner.context.request.get(f"{ORIGIN}/api/v1/projects/{project_id}/conversations").json()["items"]
        self.assertEqual(sum(thread["firstMessageBody"] == "Revisit after lost opening" for thread in threads), 1)
        owner.goto(f"/projects/{project_id}/conversations/{conversation_id}")
        expect(owner.get_by_role("link", name="Source: Privacy options · v1")).to_be_visible()

        read_failures = {"count": 0}
        def fail_first_citation(route) -> None:
            read_failures["count"] += 1
            if read_failures["count"] == 1:
                route.abort("failed")
            else:
                route.continue_()
        owner.route("**/api/v1/materials/*/versions/1", fail_first_citation)
        owner.get_by_label("Reply", exact=True).fill("Do not send this draft on read retry")
        open_sources(owner)
        owner.get_by_role("button", name="Discuss this version").click()
        expect(owner.get_by_role("button", name="Retry read")).to_be_visible()
        owner.get_by_role("button", name="Retry read").click()
        expect(owner.get_by_text("Discussing “Privacy options” v1")).to_be_visible()
        self.assertEqual(owner.context.request.get(f"{ORIGIN}/api/v1/conversations/{conversation_id}").json()["messages"][-1]["body"], "Reload after lost reply")
        owner.get_by_label("Reply", exact=True).fill("")
        owner.get_by_role("button", name="Remove material citation").click()
        owner.unroute("**/api/v1/materials/*/versions/1", fail_first_citation)

        partner_email = f"partner+{int(time.time() * 1000)}@example.test"
        partner = self.page(signed_in=False)
        partner.goto("/sign-up")
        partner.get_by_label("Name").fill("Ari Lane")
        partner.get_by_label("Email").fill(partner_email)
        partner.get_by_label("Password").fill(PASSWORD)
        partner.get_by_role("button", name="Create account").click()
        expect(partner.get_by_role("heading", level=1, name="Home")).to_be_visible()
        partner_id = partner.context.request.get(f"{ORIGIN}/api/v1/me").json()["user"]["id"]
        self.assertEqual(partner.context.request.get(f"{ORIGIN}/api/v1/drafts/{draft_id}").status, 404)
        invite = owner.context.request.post(f"{ORIGIN}/api/v1/workspaces/{ws['id']}/members", data={"email": partner_email, "role": "member"}, headers={"Origin": ORIGIN})
        self.assertEqual(invite.status, 201, invite.text())
        grant = owner.context.request.post(f"{ORIGIN}/api/v1/projects/{project_id}/grants", data={"principal": {"kind": "human", "id": partner_id}, "role": "contributor"}, headers={"Origin": ORIGIN})
        self.assertEqual(grant.status, 201, grant.text())
        partner.goto(f"/projects/{project_id}/conversations/{conversation_id}")
        expect(partner.get_by_role("region", name="Messages").get_by_text("Try a PIR sensor before considering a camera", exact=True)).to_be_visible()
        self.assertNotIn("home address 123", partner.locator("body").inner_text())
        partner.get_by_label("Reply", exact=True).fill("Agreed. Test low light too.")
        partner.get_by_role("button", name="Send reply").click()
        expect(partner.get_by_text("Agreed. Test low light too.", exact=True)).to_be_visible()

        phone = self.page(phone=True, signed_in=False)
        phone.goto("/sign-in")
        phone.get_by_label("Email").fill(partner_email)
        phone.get_by_label("Password").fill(PASSWORD)
        phone.get_by_role("button", name="Sign in").click()
        expect(phone.get_by_role("heading", level=1, name="Home")).to_be_visible()
        phone.goto(f"/projects/{project_id}/conversations/{conversation_id}")
        expect(phone.get_by_text("Agreed. Test low light too.", exact=True)).to_be_visible()
        phone.get_by_label("Reply", exact=True).fill("Phone draft survives a view switch")
        # A project has its own context; leave through the drawer and return without losing text.
        phone.get_by_role("button", name="Open navigation").click()
        phone.get_by_role("dialog", name="Flux").get_by_role("link", name="Home").click()
        phone.go_back()
        expect(phone.get_by_label("Reply", exact=True)).to_have_value("Phone draft survives a view switch")
        expect(phone.locator(".project-convo__current-thread")).to_contain_text("Try a PIR sensor before considering a camera")
        phone.set_viewport_size({"width": 390, "height": 500})
        phone.get_by_label("Reply", exact=True).focus()
        composer = phone.locator(".project-convo__composer").bounding_box()
        self.assertIsNotNone(composer)
        self.assertLessEqual(composer["y"] + composer["height"], 500, "focused composer remains inside a reduced phone viewport")
        phone.set_viewport_size(PHONE)
        shot(phone, "conversation-phone-390")
        self.assertLessEqual(phone.locator("body").evaluate("el => el.scrollWidth"), PHONE["width"])

        guest_email = f"guest+{int(time.time() * 1000)}@example.test"
        guest = self.page(signed_in=False)
        guest.goto("/sign-up")
        guest.get_by_label("Name").fill("Kai Guest")
        guest.get_by_label("Email").fill(guest_email)
        guest.get_by_label("Password").fill(PASSWORD)
        guest.get_by_role("button", name="Create account").click()
        expect(guest.get_by_role("heading", level=1, name="Home")).to_be_visible()
        guest_id = guest.context.request.get(f"{ORIGIN}/api/v1/me").json()["user"]["id"]
        invite = owner.context.request.post(f"{ORIGIN}/api/v1/workspaces/{ws['id']}/members", data={"email": guest_email, "role": "guest"}, headers={"Origin": ORIGIN})
        self.assertEqual(invite.status, 201, invite.text())
        grant = owner.context.request.post(f"{ORIGIN}/api/v1/projects/{project_id}/grants", data={"principal": {"kind": "human", "id": guest_id}, "role": "contributor"}, headers={"Origin": ORIGIN})
        self.assertEqual(grant.status, 201, grant.text())
        self.assertEqual(guest.context.request.get(f"{ORIGIN}/api/v1/workspaces/{ws['id']}/members").status, 403)
        guest.goto(f"/projects/{project_id}/conversations/{conversation_id}")
        expect(guest.get_by_text("Agreed. Test low light too.", exact=True)).to_be_visible()
        guest.get_by_label("Reply", exact=True).fill("A guest can contribute here")
        guest.get_by_role("button", name="Send reply").click()
        expect(guest.get_by_text("A guest can contribute here", exact=True)).to_be_visible()

        denial = owner.context.request.post(f"{ORIGIN}/api/v1/projects/{project_id}/grants", data={"principal": {"kind": "human", "id": partner_id}, "role": "denied"}, headers={"Origin": ORIGIN})
        self.assertEqual(denial.status, 201, denial.text())
        open_sources(phone)
        phone.get_by_role("button", name="Discuss this version").click()
        expect(phone.get_by_text("Agreed. Test low light too.", exact=True)).to_have_count(0)
        expect(phone.get_by_label("Reply", exact=True)).to_have_count(0)
        phone.reload()
        expect(phone.get_by_text("Agreed. Test low light too.", exact=True)).to_have_count(0)
        self.assertEqual(phone.context.request.get(f"{ORIGIN}/api/v1/conversations/{conversation_id}").status, 404)

    def test_13_project_pagination_and_live_history(self) -> None:
        """The 101st item is reachable, and a fresh reply cannot punch a hole in loaded history."""
        owner = self.page(signed_in=False)
        email = f"pagination+{int(time.time() * 1000)}@example.test"
        owner.goto("/sign-up")
        owner.get_by_label("Name").fill("Pagination Owner")
        owner.get_by_label("Email").fill(email)
        owner.get_by_label("Password").fill(PASSWORD)
        owner.get_by_role("button", name="Create account").click()
        owner.get_by_role("link", name="New project").click()
        owner.get_by_label("Your space").fill("Many ideas")
        owner.get_by_label("Project name").fill("Busy project")
        owner.get_by_role("button", name="Create project").click()
        project_id = owner.locator(".project-convo").get_attribute("data-project-id")
        self.assertTrue(project_id)
        request = owner.context.request
        headers = {"Origin": ORIGIN}
        first_id = None
        for index in range(101):
            result = request.post(f"{ORIGIN}/api/v1/projects/{project_id}/conversations", data={"body": f"Thread {index:03}", "clientMessageId": str(uuid.uuid4())}, headers=headers)
            self.assertEqual(result.status, 201, result.text())
            if index == 0:
                first_id = result.json()["id"]
            material = request.post(f"{ORIGIN}/api/v1/projects/{project_id}/materials", data={"title": f"Material {index:03}", "body": "A saved project note", "clientMutationId": str(uuid.uuid4())}, headers=headers)
            self.assertEqual(material.status, 201, material.text())
        self.assertTrue(first_id)
        owner.reload()
        open_sources(owner)
        expect(owner.get_by_role("button", name="Load more conversations")).to_be_visible()
        expect(owner.get_by_role("button", name="Load more materials")).to_be_visible()
        owner.get_by_role("button", name="Load more conversations").click()
        owner.get_by_role("button", name="Load more materials").click()
        expect(owner.get_by_role("link", name=re.compile("Thread 000"))).to_be_visible()
        expect(owner.get_by_role("article").filter(has_text="Material 000")).to_be_visible()
        self.assertEqual(owner.locator(".project-convo__thread").count(), 102)  # 101 threads + New
        self.assertEqual(owner.locator(".project-convo__material").count(), 101)

        for index in range(1, 121):
            result = request.post(f"{ORIGIN}/api/v1/conversations/{first_id}/messages", data={"body": f"Reply {index:03}", "clientMessageId": str(uuid.uuid4())}, headers=headers)
            self.assertEqual(result.status, 201, result.text())
        owner.goto(f"/projects/{project_id}/conversations/{first_id}")
        expect(owner.get_by_label("Reply", exact=True)).to_be_visible()
        expect(owner.locator(".project-convo__message")).to_have_count(50)
        for loaded_count in (100, 121):
            owner.get_by_role("button", name="Load earlier replies").click()
            expect(owner.locator(".project-convo__message")).to_have_count(loaded_count)
        expect(owner.get_by_role("button", name="Load earlier replies")).to_have_count(0)
        self.assertEqual(owner.locator(".project-convo__message").count(), 121)
        result = request.post(f"{ORIGIN}/api/v1/conversations/{first_id}/messages", data={"body": "Reply 121", "clientMessageId": str(uuid.uuid4())}, headers=headers)
        self.assertEqual(result.status, 201, result.text())
        owner.evaluate("window.dispatchEvent(new Event('focus'))")
        expect(owner.get_by_text("Reply 121", exact=True)).to_be_visible()
        self.assertEqual(owner.locator(".project-convo__message").count(), 122, "revalidation retains every loaded sequence")
        self.assertEqual([int(text.lstrip('#')) for text in owner.locator(".project-convo__message-meta span").all_text_contents()], list(range(1, 123)))

        # More than one server window arrives while this page is idle. Refresh must fill
        # the middle before presenting the new tail beside already loaded history.
        for index in range(60):
            result = request.post(f"{ORIGIN}/api/v1/conversations/{first_id}/messages", data={"body": f"Missed reply {index}", "clientMessageId": str(uuid.uuid4())}, headers=headers)
            self.assertEqual(result.status, 201, result.text())
        owner.evaluate("window.dispatchEvent(new Event('focus'))")
        expect(owner.get_by_text("Missed reply 59", exact=True)).to_be_visible()
        expect(owner.locator(".project-convo__message")).to_have_count(182)
        self.assertEqual([int(text.lstrip('#')) for text in owner.locator(".project-convo__message-meta span").all_text_contents()], list(range(1, 183)))

        # Hold the browser's POST, then prove the in-flight text cannot be overwritten.
        owner.evaluate("""() => {
          const actual = window.fetch.bind(window);
          window.fetch = (input, init) => {
            const url = typeof input === 'string' ? input : input.url;
            if (url.includes('/messages') && init?.method === 'POST') {
              return new Promise((resolve) => { window.releaseReply = () => resolve(actual(input, init)); });
            }
            return actual(input, init);
          };
        }""")
        reply_box = owner.get_by_label("Reply", exact=True)
        reply_box.fill("Held reply")
        owner.get_by_role("button", name="Send reply").click()
        expect(reply_box).to_be_disabled()
        self.assertEqual(reply_box.input_value(), "Held reply")
        owner.evaluate("() => { window.releaseReply(); }")
        expect(owner.get_by_text("Held reply", exact=True)).to_be_visible()
        expect(reply_box).to_have_value("")

        open_sources(owner)
        owner.get_by_role("button", name="Add material").click()
        owner.get_by_label("Title").fill("Held material")
        owner.get_by_label("Text").fill("Do not lose this text")
        owner.evaluate("""() => {
          const actual = window.fetch.bind(window);
          window.fetch = (input, init) => {
            const url = typeof input === 'string' ? input : input.url;
            if (url.includes('/materials') && init?.method === 'POST') {
              return new Promise((resolve) => { window.releaseMaterial = () => resolve(actual(input, init)); });
            }
            return actual(input, init);
          };
        }""")
        owner.get_by_role("button", name="Save for this project").click()
        expect(owner.get_by_label("Title")).to_be_disabled()
        expect(owner.get_by_label("Text")).to_be_disabled()
        owner.evaluate("() => { window.releaseMaterial(); }")
        expect(owner.get_by_role("article").filter(has_text="Held material")).to_be_visible()

    def test_14_personal_agent_setup_grant_and_revoke(self) -> None:
        """A first-time owner can create an identity, explicitly grant a project, and revoke access."""
        page = self.page(signed_in=False)
        email = f"agent-setup+{int(time.time() * 1000)}@example.test"
        page.goto("/sign-up")
        page.get_by_label("Name").fill("Agent Setup Owner")
        page.get_by_label("Email").fill(email)
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        page.get_by_role("link", name="New project").click()
        page.get_by_label("Your space").fill("Research space")
        page.get_by_label("Project name").fill("Sensor study")
        page.get_by_role("button", name="Create project").click()
        expect(page.get_by_role("heading", level=1, name="Sensor study")).to_be_visible()

        page.goto("/connect-agent")
        expect(page.get_by_role("heading", name="Your agent connections")).to_be_visible()
        expect(page.get_by_text("claude mcp add --transport http flux", exact=False)).to_be_visible()
        expect(page.get_by_role("heading", name="New connection")).to_have_count(0)
        shot(page, "agent-first-desktop")
        page.set_viewport_size(PHONE)
        create_button = box(page, page.get_by_role("button", name="Create personal agent"))
        self.assertLessEqual(create_button["y"] + create_button["height"], PHONE["height"])
        shot(page, "agent-first-phone")
        page.set_viewport_size(DESKTOP)
        page.get_by_label("Agent name").fill("My research agent")
        page.get_by_role("button", name="Create personal agent").click()
        expect(page.get_by_label("Your agent")).to_have_value(re.compile(r".+"))
        expect(page.get_by_role("heading", name="New connection")).to_be_visible()
        project = page.locator(".connection__project").filter(has_text="Sensor study")
        expect(project.get_by_text("No agent grant yet")).to_be_visible()
        expect(project.get_by_role("checkbox")).to_be_disabled()
        project.get_by_role("button", name="Grant", exact=True).click()
        expect(project.get_by_text("Agent grant: read and propose")).to_be_visible()
        project.get_by_role("checkbox").check()
        page.get_by_label("Connection name").fill("Research laptop")
        page.get_by_label("Client label").select_option("codex")
        page.get_by_role("button", name="Save connection").click()
        saved = page.get_by_role("group", name="Saved selections")
        expect(saved.get_by_text("My research agent", exact=True)).to_be_visible()
        expect(saved.get_by_text("Sensor study", exact=True)).to_be_visible()
        expect(saved.get_by_text("Selected project", exact=True)).to_be_visible()
        shot(page, "agent-saved-desktop")
        page.set_viewport_size(PHONE)
        shot(page, "agent-saved-phone")
        page.set_viewport_size(DESKTOP)
        page.reload()
        saved = page.get_by_role("group", name="Saved selections")
        expect(saved.get_by_text("My research agent", exact=True)).to_be_visible()
        saved.get_by_role("button", name="Revoke connection").click()
        saved.get_by_role("button", name="Revoke now").click()
        expect(page.get_by_role("group", name="Saved selections")).to_have_count(0)
        connections = page.context.request.get(f"{ORIGIN}/api/v1/agent-connections")
        self.assertEqual(connections.status, 200, connections.text())
        self.assertEqual(len(connections.json()), 1)
        self.assertIsNotNone(connections.json()[0]["revokedAt"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
