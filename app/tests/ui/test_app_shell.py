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

from playwright.sync_api import Browser, BrowserContext, Page, TimeoutError as PlaywrightTimeoutError, expect, sync_playwright

from app_select import choose, expect_value

from create_window import create_other

ORIGIN = os.environ.get("FLUX_UI_ORIGIN", "http://127.0.0.1:18591").rstrip("/")
UPSTREAM = os.environ.get("FLUX_UI_UPSTREAM")
MAILPIT = os.environ.get("FLUX_MAILPIT_URL")
SHOTS = Path(os.environ["FLUX_UI_SCREENSHOTS"]) if os.environ.get("FLUX_UI_SCREENSHOTS") else None
# FLUX_UI_BROWSER selects the engine for these journeys: chromium (default) or webkit (#461).
UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
if UI_BROWSER not in ("chromium", "webkit"):
    raise ValueError(f"FLUX_UI_BROWSER must be chromium or webkit, got {UI_BROWSER!r}")

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
        # Browsers, Node and real proxies disable Nagle's algorithm. With it on here, a small frame
        # written while the previous one awaited its TCP acknowledgement waited for the receiver's
        # delayed ACK (up to 40 ms on Linux): about 40-60 ms on every live round trip that no
        # deployment has, which the #228 Gate 4 latency driver measured through this hop.
        for end in (client, remote):
            end.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        a = threading.Thread(target=_pipe, args=(client, remote), daemon=True)
        b = threading.Thread(target=_pipe, args=(remote, client), daemon=True)
        a.start(); b.start(); a.join(); b.join()
        client.close(); remote.close()

    def accept() -> None:
        while True:
            client, _ = server.accept()
            threading.Thread(target=handle, args=(client,), daemon=True).start()

    threading.Thread(target=accept, daemon=True).start()


def open_sources(page: Page, scope=None) -> None:
    """Opens the project's sources above a composer (#117), where materials are saved and cited.

    A writer types "/source" in the composer (F-026 S5: no Sources button); a reader has no composer, so
    its Sources button stays. With a thread open (UI116-1) pass the thread as `scope` to use its composer."""
    within = scope or page
    region = within.get_by_role("region", name="Space materials")
    if not region.is_visible():
        button = within.get_by_role("button", name=re.compile("^Sources"))
        if button.count():
            if button.get_attribute("aria-expanded") != "true":
                button.click()
        else:
            field = scope.get_by_role("textbox") if scope else page.locator("#project-composer")
            field.fill("/source")
            field.press("Enter")
    expect(region).to_be_visible()


def thread_of(page: Page):
    """The open root's thread in the one panel: beside the stream on a computer, a sheet or overlay on a phone or tablet (UI116-1, #488)."""
    return page.get_by_role("complementary", name="Replies").or_(page.get_by_role("dialog", name="Replies"))


def own_company(page: Page, name: str = "Own company") -> None:
    """F-037: a server has one company, set up by its first account (check_ui.sh makes that one), so someone who signs up
    later is in none. The test deployment's fixture route gives this person a company of their own to start spaces in."""
    expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
    made = page.request.post(f"{ORIGIN}/api/v1/workspaces", headers={"origin": ORIGIN}, data={"name": name})
    assert made.status == 201, made.text()
    page.reload()
    expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()


def new_from_sidebar(page: Page, item: str) -> None:
    """New (C) in the computer sidebar, then one of its items (F-026 §4)."""
    page.get_by_role("complementary", name="Sidebar").get_by_role("button", name="New", exact=True).click()
    create_other(page, item)


def close_modal_thread(page: Page, tap: bool = False) -> None:
    """Below 1000 px an open thread is the one panel as a modal sheet or overlay and covers the header (#488):
    a person closes it before using the header. Docked beside the stream (above 1000 px) it covers nothing."""
    thread = page.get_by_role("dialog", name="Replies")
    close = thread.get_by_role("button", name="Close replies")
    if close.count():
        try:
            close.tap(timeout=3000) if tap else close.click(timeout=3000)
        except PlaywrightTimeoutError:
            pass  # it closed by itself while the click waited
    expect(thread).to_have_count(0)


def view_tab(page: Page, name: str, tap: bool = False) -> None:
    """A project view by its name: the underline tabs, the same at every width (#873, #1239); on a phone it is the row under the title."""
    close_modal_thread(page, tap)
    link = page.get_by_role("navigation", name="Space views").get_by_role("tab", name=re.compile(f"^{name}"))
    link.tap() if tap else link.click()


_PANEL_TASKS: dict[str, str] = {}


def panel_task(page: Page, project_id: str) -> str:
    """The task whose panel a test opens, a space having none of its own (#1419): its first task, or one made for the purpose, once, so that the
    counts of later tests hold."""
    if project_id not in _PANEL_TASKS:
        items = page.request.get(f"{ORIGIN}/api/v1/projects/{project_id}/work?limit=1").json()["items"]
        if not items:
            made = page.request.post(f"{ORIGIN}/api/v1/projects/{project_id}/work", data={"title": "Check the panel"}, headers={"origin": ORIGIN})
            assert made.status == 201, made.text()
            items = [made.json()]
        _PANEL_TASKS[project_id] = items[0]["id"]
    return _PANEL_TASKS[project_id]


def open_details(page: Page, tap: bool = False) -> None:
    """The one detail panel (a sheet on the phone). A direct message has its own, "Message info", in More; a space has none (#1419), so
    there the panel is a task's, opened from the task's address on a task made for the purpose."""
    if re.search(r"/dm/[0-9a-f-]{36}", page.url):
        if page.viewport_size["width"] <= 640:
            page.locator("header.phead button[aria-label='More']").first.wait_for()
            more = page.locator("header.phead").get_by_role("button", name="More", exact=True)
            close_modal_thread(page, tap)
            more.tap() if tap else more.click()
            item = page.get_by_role("menu", name="More").get_by_role("menuitem", name="Message info")
            item.tap() if tap else item.click()
            return
        close_modal_thread(page, tap)
        header = page.locator("header.top")
        page.locator("header.top:not(.top--bare) button[aria-label='More']").first.wait_for()
        header.get_by_role("button", name="More", exact=True).click()
        page.get_by_role("menu", name="More").get_by_role("menuitem", name="Message info").click()
        return
    project = re.search(r"/projects/([0-9a-f-]{36})", page.url)
    assert project, page.url
    # The panel opens over the place the test is at (a map, a board, a thread), so the address keeps its path.
    page.goto(f"{urllib.parse.urlsplit(page.url).path}?open=work:{panel_task(page, project.group(1))}")


def shot(page: Page, name: str) -> None:
    if not SHOTS:
        return
    SHOTS.mkdir(parents=True, exist_ok=True)
    page.evaluate("document.fonts.ready.then(() => true)")
    page.wait_for_timeout(450)  # let panel and view motion settle
    page.screenshot(path=str(SHOTS / f"{name}.png"))


def open_map_options(page: Page, *, touch: bool = False):
    """The phone's named sheet retains Map/List and Fit/zoom without stacked map controls."""
    trigger = page.get_by_role("button", name="Map options", exact=True)
    expect(trigger).to_be_visible()
    trigger.tap() if touch else trigger.click()
    sheet = page.get_by_role("dialog", name="Map options", exact=True)
    expect(sheet).to_be_visible()
    return sheet


def show_map_as(page: Page, mode: str, *, touch: bool = False) -> None:
    """Choose the same Map/List control through its visible desktop or phone entry point."""
    expect(page.locator('.ui-overlay[data-state="closing"]')).to_have_count(0)
    switch = page.get_by_role("radio", name=mode, exact=True)
    trigger = page.get_by_role("button", name="Map options", exact=True)
    expect(trigger.or_(switch)).to_be_visible()
    if trigger.is_visible():
        switch = open_map_options(page, touch=touch).get_by_role("radio", name=mode, exact=True)
    switch.tap() if touch else switch.click()
    expect(page.get_by_role("dialog", name="Map options", exact=True)).to_have_count(0)


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


# TEST ONLY: a slow network in one tab, so that signing out happens while the tab still waits.
# GET answers from /api/v1 are held back at two gates and arrive when the test releases them:
#  A: everything the tab asks for once an address with `?open=` has been written (a search result
#     or link that opens an object in Details) or `arm()` was called, until sign-out starts;
#  B: the sign-in page's own session check (`/api/v1/me`), made while its one-time notice is in
#     the address.
# Each request is really sent at once, with whatever session the tab had; only its answer waits.
SLOW_ANSWERS = """
(() => {
  const realFetch = window.fetch.bind(window);
  const gates = {};
  for (const name of ['A', 'B']) {
    let open;
    gates[name] = { opened: new Promise((resolve) => { open = resolve; }), open, held: 0, waiting: 0 };
  }
  const slow = window.__slow = {
    armed: false, signingOut: false, inflight: 0,
    arm() { slow.armed = true; },
    release(name) { gates[name].open(); },
    held(name) { return gates[name].held; },
    // Resolves once nothing but gate B's held answers has been in flight for `ms` milliseconds.
    quiet(ms) {
      return new Promise((resolve) => {
        let since = null;
        const tick = () => {
          const now = performance.now();
          if (slow.inflight === gates.B.waiting) { since ??= now; if (now - since >= ms) { resolve(true); return; } } else since = null;
          setTimeout(tick, 20);
        };
        tick();
      });
    },
  };
  for (const method of ['pushState', 'replaceState']) {
    const write = history[method].bind(history);
    history[method] = (state, unused, url) => {
      if (url != null && new URL(String(url), location.href).searchParams.has('open')) slow.armed = true;
      return write(state, unused, url);
    };
  }
  window.fetch = (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    const method = String(init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method === 'POST' && url.pathname === '/api/auth/sign-out') slow.signingOut = true;
    const api = method === 'GET' && url.pathname.startsWith('/api/v1/');
    const gate = !api ? null
      : slow.armed && !slow.signingOut ? gates.A
      : url.pathname === '/api/v1/me' && new URLSearchParams(location.search).get('notice') === 'signed-out' ? gates.B : null;
    slow.inflight += 1;
    let answer = realFetch(input, init);
    if (gate) {
      gate.held += 1;
      const signal = init.signal ?? (input instanceof Request ? input.signal : null);
      answer = answer.then((response) => new Promise((resolve, reject) => {
        let settled = false;
        gate.waiting += 1;
        const settle = (finish) => { if (settled) return; settled = true; gate.waiting -= 1; finish(); };
        const abort = () => settle(() => reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')));
        if (signal?.aborted) { abort(); return; }
        signal?.addEventListener('abort', abort, { once: true });
        gate.opened.then(() => settle(() => resolve(response)));
      }));
    }
    return answer.finally(() => { slow.inflight -= 1; });
  };
})();
"""


# Records the API requests this document starts: when each began, and whether `beforeunload` had
# already fired (#471). A document that is being left starts none; WebKit reports every one of them
# as an uncaught page error even though the app handles the rejection.
FETCH_RECORDER = """
(() => {
  let leaving = false;
  window.__fetches = [];
  window.addEventListener('beforeunload', () => { leaving = true; });
  window.addEventListener('pageshow', () => { leaving = false; });
  const original = window.fetch;
  window.fetch = function (...args) {
    const url = String((args[0] && args[0].url) || args[0]);
    window.__fetches.push([performance.now(), url]);
    if (leaving) { try { console.log('started-while-leaving ' + url); } catch (e) { /* the page is going away */ } }
    return original.apply(this, args);
  };
})();
"""


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
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
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
        context = self.browser.new_context(**options)  # sw-allowed: as on main; routing tests pass service_workers="block" (#271)
        self.addCleanup(context.close)
        return context

    def page(self, **kwargs) -> Page:
        page = self.context(**kwargs).new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        # How often each page reads the person (#1126): a page that loops on it is a failure whatever else it shows.
        reads = {"me": 0}
        page.on("request", lambda request: reads.__setitem__("me", reads["me"] + 1) if request.url.split("?")[0].endswith("/api/v1/me") else None)
        if not hasattr(self, "me_reads"):
            self.me_reads = []
        self.me_reads.append((page, reads))
        return page

    def assert_few_me_reads(self, at_most: int = 40) -> None:
        """No page of this test read the person more than a handful of times (#1126: a revoked page read it 52,800 times)."""
        for page, reads in getattr(self, "me_reads", []):
            self.assertLessEqual(reads["me"], at_most, f"{page.url}: {reads['me']} reads of /api/v1/me")

    def save_state(self, page: Page) -> None:
        type(self).state = page.context.storage_state()

    # ---------------------------------------------------------------- sign-up and session

    def test_01_protected_route_redirects_to_sign_in(self) -> None:
        page = self.page(signed_in=False)
        page.goto("/tasks")
        expect(page).to_have_url(re.compile(r"/sign-in\?next=%2Ftasks$"))
        expect(page.get_by_role("heading", name="Sign in")).to_be_visible()
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
        expect(page.get_by_text("Use at least 12 characters.")).to_be_visible()
        page.get_by_label("Password").fill(PASSWORD)
        # A long enough password clears the last attempt's error and the length hint (#189).
        expect(page.get_by_text("Use at least 12 characters.")).to_have_count(0)
        expect(page.get_by_text("At least 12 characters. A short sentence works well.")).to_have_count(0)
        expect(page.get_by_label("Password")).not_to_have_attribute("aria-invalid", "true")
        shot(page, "sign-up-desktop-light")
        page.get_by_role("button", name="Create account").click()
        expect(page).to_have_url(f"{ORIGIN}/")
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        expect(page.get_by_role("button", name=re.compile(NAME))).to_be_visible()
        # F-037: a server's company was set up by its first account (check_ui.sh makes that one); a person who signs up
        # later is in no company until invited. The test deployment's fixture route gives this person their own.
        made = page.request.post(f"{ORIGIN}/api/v1/workspaces", headers={"origin": ORIGIN}, data={"name": "Personal"})
        self.assertEqual(made.status, 201, made.text())
        page.reload()
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
        page.goto("/sign-in?next=%2Ftasks")
        page.get_by_label("Email").fill(EMAIL)
        page.get_by_label("Password").fill("not the password")
        page.get_by_role("button", name="Sign in").click()
        expect(page.get_by_role("alert")).to_contain_text("don’t match")
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Sign in").click()
        expect(page).to_have_url(f"{ORIGIN}/tasks")
        expect(page.get_by_role("heading", name="Nothing is waiting for you")).to_be_visible()
        page.reload()
        expect(page).to_have_url(f"{ORIGIN}/tasks")
        # My tasks, reached from Home, names itself (#763 NV-1).
        expect(page.get_by_role("heading", level=1, name="My tasks")).to_be_visible()
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
        self.assertEqual(places.get_by_role("link").all_inner_texts(), ["Home", "Inbox", "My tasks", "My map"])
        # Personal settings have their own header; Home is not current there (#184 delta review S1).
        for path, title in (("/settings/agents", "Settings"),):
            page.goto(path)
            expect(page.locator("header.top").get_by_role("heading", level=1, name=title)).to_be_visible()
            expect(places.get_by_role("link", name="Home")).not_to_have_attribute("aria-current", "page")
        page.goto("/")
        expect(places.get_by_role("link", name="Home")).to_have_attribute("aria-current", "page")
        side_box = box(page, sidebar)
        self.assertEqual((round(side_box["x"]), round(side_box["width"])), (0, 248), "a 248px sidebar at the far left")
        self.assertEqual(page.evaluate("getComputedStyle(document.querySelector('.app')).backgroundColor"), "rgb(235, 235, 237)", "the outer background (--side)")
        sheet = page.locator(".app__main")
        self.assertEqual(sheet.evaluate("el => [getComputedStyle(el).borderTopLeftRadius, getComputedStyle(el).backgroundColor]"), ["20px", "rgb(244, 244, 245)"], "a rounded panel on --bg")
        self.assertEqual(round(box(page, sheet)["x"]), 248, "the panel meets the sidebar")
        rail = places
        marker = places.get_by_role("link", name="Home").evaluate("el => [getComputedStyle(el).backgroundColor, getComputedStyle(el).boxShadow !== 'none']")
        self.assertEqual(marker, ["rgb(255, 255, 255)", True], "the current place is a raised white pill (F-026 §4)")
        # #763 FR-4: an empty section is not shown; Home carries the one first step instead.
        expect(sidebar.get_by_text("No spaces yet")).to_have_count(0)
        expect(page.get_by_role("button", name="Start a space")).to_be_visible()
        expect(sidebar.get_by_role("button", name=re.compile("^New"))).to_have_attribute("aria-keyshortcuts", "C")
        # Home has no views bar (#508); its quiet links lead to the personal pages. Project-header views are covered by
        # test_project_header.py and are Conversation · Tasks · Map · Wiki in every space (#873).
        views = page.get_by_role("navigation", name="Views")
        expect(views).to_have_count(0)
        # #763 FT-1: with no project yet Home is one first step; the waiting rows and the rows to empty pages wait.
        expect(page.locator(".home__rows")).to_have_count(0)
        expect(page.get_by_role("heading", level=2, name=re.compile("^Good "))).to_be_visible()
        expect(page.get_by_role("region", name="Waiting for you")).to_have_count(0)
        expect(page.get_by_role("region", name="You’re in Personal")).to_be_visible()
        shot(page, "desktop-1440-home-light")

        # My map (#866): the sidebar opens the person's one private map, made the first time; Your notes became thoughts on it.
        places.get_by_role("link", name="My map", exact=True).click()
        expect(page).to_have_url(re.compile(rf"^{ORIGIN}/map/[0-9a-f-]{{36}}$"))
        expect(page.get_by_role("navigation", name="Views")).to_have_count(0)
        expect(page.get_by_role("heading", level=1, name="My map", exact=True)).to_be_visible()
        expect(page.locator(".sk-aud")).to_have_text("Only you")
        expect(page.get_by_text("An empty map.")).to_be_visible()
        shot(page, "desktop-1440-my-map-empty-light")
        my_map = page.url.rsplit("/", 1)[1]
        added = page.request.post(f"{ORIGIN}/api/v1/sketches/{my_map}/thoughts", data={"text": "Lamp idea: wave to dim, but keep the camera off by default", "x": 40, "y": 40},
                                  headers={"origin": ORIGIN})
        self.assertEqual(added.status, 201, added.text())
        page.reload()
        expect(page.get_by_text("Lamp idea: wave to dim")).to_be_visible()
        spaces = page.evaluate("fetch('/api/v1/workspaces').then(r => r.json())")
        self.assertEqual([space["name"] for space in spaces], ["Personal"], "My map made no space of its own")
        self.assertEqual(len(page.request.get(f"{ORIGIN}/api/v1/workspaces/{spaces[0]['id']}/sketches?scope=private&limit=100").json()["items"]), 1, "one private map")
        shot(page, "desktop-1440-light")

        # The personal pages stay reachable and keep Back: Home's quiet links, then the browser's Back (#508 AC-5).
        places.get_by_role("link", name="Home").click()
        expect(page.get_by_role("heading", level=2, name=re.compile("^Good "))).to_be_visible()
        # #763 FT-1: with no project Home does not list the personal pages; they stay reachable by address and Back.
        page.goto("/tasks")
        expect(page).to_have_url(f"{ORIGIN}/tasks")
        expect(page.get_by_role("heading", name="Nothing is waiting for you")).to_be_visible()
        expect(page.get_by_role("navigation", name="Views")).to_have_count(0)
        page.go_back()
        expect(page).to_have_url(f"{ORIGIN}/")
        places.get_by_role("link", name="My map", exact=True).click()
        expect(page.get_by_role("heading", level=1, name="My map", exact=True)).to_be_visible()
        shot(page, "desktop-1440-map-light")

        # Only a space and a direct message have Details (#871): My map has none, and the header has no Details button.
        more = page.locator("header.top").get_by_role("button", name="More", exact=True)
        expect(page.locator("header.top").get_by_role("button", name="Details", exact=True)).to_have_count(0)
        more.click()
        menu = page.get_by_role("menu", name="More")
        expect(menu.get_by_role("menuitem", name=re.compile("details|info", re.I))).to_have_count(0)
        page.keyboard.press("Escape")
        expect(menu).to_have_count(0)
        expect(more).to_be_focused()
        # "]" is not a key of the final design (§4 keyboard); it opens nothing.
        page.keyboard.press("]")
        expect(page.get_by_role("complementary", name=re.compile("details|info", re.I))).to_have_count(0)

        # Direct messages is its own place: the sidebar lists conversations, there are no views.
        sidebar.locator("#side-dms").get_by_role("link", name="Messages", exact=True).click()
        expect(page).to_have_url(f"{ORIGIN}/dm")
        expect(page.get_by_role("heading", level=1, name="Messages")).to_be_visible()
        expect(page.get_by_role("heading", name="No messages yet")).to_be_visible()
        expect(sidebar.locator("#side-dms").get_by_role("link", name="Messages", exact=True)).to_have_attribute("aria-current", "page")
        expect(sidebar.get_by_text("No conversations yet", exact=False)).to_have_count(0)  # #763 FR-4
        # On the computer New (C) starts a message; the sidebar has no second "+".
        expect(sidebar.get_by_role("link", name="New message")).to_have_count(0)
        expect(page.get_by_role("navigation", name="Views")).to_have_count(0)
        shot(page, "desktop-1440-dm-light")
        rail.get_by_role("link", name="Home").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()

    def test_04aa_header_more_is_a_floating_bounded_menu(self) -> None:
        if not self.state:
            page = self.page(signed_in=False)
            page.goto("/sign-up")
            page.get_by_label("Name").fill(NAME)
            page.get_by_label("Email").fill(EMAIL)
            page.get_by_label("Password").fill(PASSWORD)
            page.get_by_role("button", name="Create account").click()
            expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
            self.save_state(page)
        cases = (
            ("desktop", {"phone": False}, False),
            ("tablet", {"phone": False, "viewport": {"width": 820, "height": 900}, "has_touch": True}, False),
            ("phone", {"phone": True}, False),
            ("desktop", {"phone": False}, True),
            ("phone", {"phone": True}, True),
        )
        for device, context_options, dark in cases:
            with self.subTest(device=device, dark=dark):
                page = self.page(**context_options, dark=dark)
                workspaces = page.request.post(f"{ORIGIN}/api/v1/workspaces", data={"name": "Header menu studio"}, headers={"origin": ORIGIN})
                self.assertEqual(workspaces.status, 201, workspaces.text())
                workspace_id = workspaces.json()["id"]
                project = page.request.post(f"{ORIGIN}/api/v1/workspaces/{workspace_id}/projects", data={
                    "name": "Project header actions", "visibility": "workspace",
                }, headers={"origin": ORIGIN})
                self.assertEqual(project.status, 201, project.text())
                page.goto(f"/projects/{project.json()['id']}")
                expect(page.locator(".project-convo")).to_be_visible()
                header = page.locator("header.phead" if device == "phone" else "header.top")
                before = header.bounding_box()
                if device == "phone":
                    expect(header.get_by_role("button", name="Back", exact=True)).to_be_visible()
                    # The title row is Back, the name and More; Search and Call are rows of More (#1239).
                    expect(header.get_by_role("button", name="More", exact=True)).to_be_visible()
                    expect(header.get_by_role("button", name="Call", exact=True)).to_have_count(0)
                    expect(header.get_by_role("button", name="Search", exact=True)).to_have_count(0)
                    expect(header.get_by_role("heading", level=1, name="Project header actions")).to_be_visible()
                    # The phone's More holds Search, Call, Settings and Mute: a space has no panel of its own (#873, #1419).
                    expect(header.get_by_role("button", name="More", exact=True)).to_have_count(1)
                    geometry = page.evaluate("""() => ({header: document.querySelector('header.phead').getBoundingClientRect().height,
                      width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth})""")
                    self.assertAlmostEqual(geometry["header"], 108, delta=2, msg=f"phone keeps its compact header, 8 px, a 44 px title row, 12 px and the views' 44 px row: {geometry}")
                    self.assertEqual(geometry["scrollWidth"], geometry["width"], f"phone header has no horizontal overflow: {geometry}")
                    mode = "phone-390x844-dpr3"
                    scheme = "dark" if dark else "light"
                    shot(page, f"app-shell-project-header-{mode}-{scheme}-z100-chromium")
                    continue

                more = header.get_by_role("button", name="More", exact=True)
                expect(more).to_be_visible()
                anchor = more.bounding_box()
                more.click()
                menu = page.get_by_role("menu", name="More")
                expect(menu).to_be_visible()
                page.evaluate("document.fonts.ready.then(() => true)")
                geometry = page.evaluate("""() => {
                  const header = document.querySelector('header.top').getBoundingClientRect();
                  const button = document.querySelector('header.top [aria-label="More"]').getBoundingClientRect();
                  const menu = document.querySelector('.top__more-menu').getBoundingClientRect();
                  // Rows a wide or tablet header keeps in its own row are in the menu but hidden (Spokój rule 3): measure the shown ones.
                  const rows = [...document.querySelectorAll('.top__more-menu [role^=menuitem]')].filter(el => el.getClientRects().length > 0);
                  // Mute space (#1249) carries its hint under the label, so its row is taller than the single-line rows.
                  const hinted = rows.filter(el => el.querySelector('small')).map(el => el.getBoundingClientRect().height);
                  return {header: {top: header.top, bottom: header.bottom, height: header.height},
                    button: {left: button.left, right: button.right, top: button.top, bottom: button.bottom},
                    menu: {left: menu.left, right: menu.right, top: menu.top, bottom: menu.bottom},
                    rowHeights: rows.filter(el => !el.querySelector('small')).map(el => el.getBoundingClientRect().height), hintedHeights: hinted,
                    viewport: document.documentElement.clientWidth};
                }""")
                after = header.bounding_box()
                self.assertAlmostEqual(before["height"], after["height"], delta=1, msg=f"header does not grow when More opens: {geometry}")
                self.assertGreaterEqual(geometry["menu"]["left"], 0, geometry)
                self.assertLessEqual(geometry["menu"]["right"], geometry["viewport"], geometry)
                self.assertAlmostEqual(geometry["menu"]["right"], anchor["x"] + anchor["width"], delta=1, msg=f"menu is right aligned to More: {geometry}")
                self.assertGreaterEqual(geometry["menu"]["top"], geometry["button"]["bottom"] - 1, geometry)
                self.assertGreaterEqual(len(geometry["rowHeights"]), 1, f"Settings is shown: {geometry}")
                self.assertEqual(len(geometry["hintedHeights"]), 1, f"Mute space is the one row with a hint line: {geometry}")
                if device == "tablet":
                    # 44 px touch rows; WebKit lays a menu that starts on a fractional pixel out to 43.99998… while it settles (#1375 adds the People row at 820):
                    # a rounding tolerance, not a smaller target.
                    self.assertTrue(all(height >= 43.95 for height in geometry["rowHeights"] + geometry["hintedHeights"]), geometry)
                if device == "desktop":
                    self.assertTrue(all(abs(height - 32) <= 1 for height in geometry["rowHeights"]), f"desktop rows are 32px: {geometry}")
                    self.assertTrue(all(height > 32 for height in geometry["hintedHeights"]), f"the hint line makes its row taller: {geometry}")
                mode = "tablet-820x900-dpr1" if device == "tablet" else "desktop-1440x900-dpr1"
                scheme = "dark" if dark else "light"
                shot(page, f"app-shell-project-header-more-{mode}-{scheme}-z100-chromium")
                if device == "desktop":
                    items = menu.locator("[role^=menuitem]:visible")
                    items.nth(1).hover()
                    expect(items.nth(0)).to_have_css("background-color", "rgba(0, 0, 0, 0)")
                    expect(items.nth(1)).not_to_have_css("background-color", "rgba(0, 0, 0, 0)")
                page.keyboard.press("Escape")
                expect(menu).to_have_count(0)
                expect(more).to_be_focused()

    def test_04b_unknown_route_page(self) -> None:
        """A fresh signed-in document renders the unknown-route state without coupling it to prior reads."""
        page = self.page()
        page.goto("/nowhere")
        expect(page.get_by_role("heading", name="This page doesn’t exist")).to_be_visible()

    def first_space(self, page: Page) -> str:
        """The id of the first space of the account (test_04aa made one)."""
        spaces = [item for workspace in page.request.get(f"{ORIGIN}/api/v1/workspaces").json()
                  for item in page.request.get(f"{ORIGIN}/api/v1/workspaces/{workspace['id']}/projects?limit=100").json()["items"]]
        self.assertTrue(spaces, "test_04aa made a space")
        return spaces[0]["id"]

    def test_05_desktop_dark_and_tablet(self) -> None:
        page = self.page(dark=True)
        page.goto("/")
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        self.assertEqual(page.evaluate("getComputedStyle(document.body).backgroundColor"), "rgb(11, 11, 11)", "the dark outer background")
        self.assertEqual(page.locator(".app__main").evaluate("el => getComputedStyle(el).backgroundColor"), "rgb(17, 17, 17)", "the dark panel")
        shot(page, "desktop-1440-dark")
        # Home and My map have no Details (#871); a task has the panel.
        page.goto(f"/projects/{self.first_space(page)}")
        expect(page.locator(".project-convo")).to_be_visible()
        open_details(page)
        expect(page.get_by_role("complementary", name="Details")).to_be_visible()
        shot(page, "desktop-1440-details-dark")

        tablet = self.page(viewport={"width": 1024, "height": 768})
        tablet.goto("/")
        # At 1024px the sidebar stays beside the panel (down to 681px).
        expect(tablet.get_by_role("complementary", name="Sidebar")).to_be_visible()
        expect(tablet.get_by_role("button", name="Open navigation")).to_have_count(0)
        shot(tablet, "tablet-1024-light")

    # ---------------------------------------------------------------- phone layout

    def test_06_phone_capsule_sheet_and_targets(self) -> None:
        page = self.page(phone=True)
        page.goto("/")
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        expect(page.get_by_role("complementary", name="Sidebar")).to_have_count(0)
        # #341: the capsule floats at the bottom with the round Search and the one "+"; Home has no view chips (#342).
        bar_box = box(page, page.get_by_role("navigation", name="Main places"))
        self.assertLess(bar_box["y"] + bar_box["height"], PHONE["height"] - 6, "the places capsule floats above the bottom edge")
        greeting = page.get_by_role("heading", level=2, name=re.compile(r"^Good (morning|afternoon|evening), Jo$"))
        expect(greeting).to_be_visible()
        expect(page.get_by_role("navigation", name="Views")).to_have_count(0)
        shot(page, "phone-390-light")

        # Coarse pointer: primary targets are at least 44px.
        targets = [page.get_by_role("link", name="Settings and account"), page.get_by_role("button", name="Search", exact=True),
                   page.get_by_role("button", name="Create", exact=True), page.get_by_role("link", name=re.compile(r"^My tasks"))]
        for target in targets:
            size = box(page, target)
            self.assertGreaterEqual(round(min(size["width"], size["height"]), 2), 44, f"44px target: {target}")
        # #437: the places bar labels are at least the phone meta size (12.5px, final design §2).
        # Home has no composer since #342 (notes moved to the Sketchbook), so its audience line is not measured here.
        for size in page.locator(".ui-bottomnav__label").evaluate_all("els => els.map(e => parseFloat(getComputedStyle(e).fontSize))"):
            self.assertGreaterEqual(size, 12.5, "places bar label at least 12.5px")

        # Details opens a full-screen sheet (a task's, in Jo's space: the one test_04aa made; a space has no panel of its own, #1419); the views
        # row of projects is in test_phone_final.
        spaces = [item for workspace in page.request.get(f"{ORIGIN}/api/v1/workspaces").json()
                  for item in page.request.get(f"{ORIGIN}/api/v1/workspaces/{workspace['id']}/projects?limit=100").json()["items"]]
        self.assertTrue(spaces, "test_04aa made a space")
        page.goto(f"/projects/{spaces[0]['id']}")
        expect(page.locator(".project-convo")).to_be_visible()
        open_details(page)
        sheet = page.get_by_role("dialog", name="Details")
        expect(sheet).to_be_visible()
        page.wait_for_timeout(400)
        sheet_box = box(page, sheet)
        self.assertEqual((round(sheet_box["x"]), round(sheet_box["y"]), round(sheet_box["width"]), round(sheet_box["height"])), (0, 0, PHONE["width"], PHONE["height"]), "Details is a full-screen sheet")
        shot(page, "phone-390-details-light")
        # #433: when a dialog surface itself holds keyboard focus, it shows a visible inset ring.
        # Tab establishes keyboard modality in every engine: the focus ring is for keyboard focus only (final design focus
        # rule), and a lone Shift does that only in Chromium (WebKit ignores modifier keys, #630), so the script's focus()
        # after a mouse click would not show it there. The assertion itself is the same in both engines.
        page.keyboard.press("Tab")
        ring = page.evaluate("""() => { const s = document.querySelector('.ui-overlay__surface'); s.setAttribute('tabindex', '-1'); s.focus();
          const cs = getComputedStyle(s); return {visible: s.matches(':focus-visible'), style: cs.outlineStyle, width: parseFloat(cs.outlineWidth), offset: parseFloat(cs.outlineOffset)}; }""")
        self.assertTrue(ring["visible"] and ring["style"] == "solid" and ring["width"] >= 2 and ring["offset"] < 0, ring)
        page.keyboard.press("Escape")
        expect(page.get_by_role("dialog")).to_have_count(0)
        open_details(page)
        page.get_by_role("dialog", name="Details").get_by_role("button", name="Close details").click()
        expect(page.get_by_role("dialog")).to_have_count(0)

    def test_07_phone_dark_and_narrow(self) -> None:
        page = self.page(phone=True, dark=True)
        page.goto("/")
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        shot(page, "phone-390-dark")
        page.goto("/map")
        # Mapping itself is covered by tests/ui/test_sketches.py (#69): My map opens at its own address.
        expect(page).to_have_url(re.compile(rf"^{ORIGIN}/map/[0-9a-f-]{{36}}$"))
        expect(page.get_by_role("heading", level=1, name="My map", exact=True)).to_be_visible()

        narrow = self.page(phone=True, viewport={"width": 360, "height": 780})
        narrow.goto("/tasks")
        expect(narrow.get_by_role("heading", name="Nothing is waiting for you")).to_be_visible()
        self.assertLessEqual(narrow.evaluate("document.documentElement.scrollWidth"), 360, "no horizontal scroll at 360px")
        shot(narrow, "phone-360-tasks-light")

        signin = self.page(phone=True, dark=True, signed_in=False)
        signin.goto("/sign-in")
        expect(signin.get_by_role("heading", name="Sign in")).to_be_visible()
        shot(signin, "sign-in-phone-dark")

    def test_07a_phone_enlarged_text_keeps_every_place_in_view(self) -> None:
        # #437 (HIG-11, HIG-19): with the text size doubled (html 16 -> 32 px, as the SoftVolume checks do), all three
        # places stay on the screen, each label whole and apart from its neighbours. The page's scrollWidth can stay
        # at the viewport width while the bar clips its last label, so each label's own bounds are measured.
        measure = """els => els.map((item) => {
          const label = item.querySelector('.ui-bottomnav__label');
          const r = label.getBoundingClientRect();
          return { name: label.textContent, left: r.left, right: r.right, size: parseFloat(getComputedStyle(label).fontSize),
                   overflow: label.scrollWidth - label.clientWidth };
        })"""
        for width, dark in ((320, False), (320, True), (390, False), (390, True)):
            with self.subTest(width=width, dark=dark):
                page = self.page(phone=True, dark=dark, viewport={"width": width, "height": 844})
                page.goto("/")
                expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
                items = page.get_by_role("navigation", name="Main places").locator(".ui-bottomnav__item")
                self.assertEqual(items.count(), 3, "the capsule holds Home, Projects and Inbox (#341)")
                normal = min(place["size"] for place in items.evaluate_all(measure))
                page.add_style_tag(content="html { font-size: 32px !important; }")
                places = sorted(items.evaluate_all(measure), key=lambda place: place["left"])
                listing = json.dumps(places)
                for place in places:
                    name = place["name"]
                    self.assertGreaterEqual(place["left"], 0, f"{name} starts on screen at {width}px: {listing}")
                    self.assertLessEqual(place["right"], width, f"{name} ends on screen at {width}px: {listing}")
                    self.assertLessEqual(place["overflow"], 1, f"{name} is not clipped: {listing}")
                    self.assertGreaterEqual(place["size"], 12.5, f"{name} keeps the phone meta size: {listing}")
                    self.assertGreater(place["size"], normal, f"{name} still grows with the text size: {listing}")
                for before, after in zip(places, places[1:]):
                    self.assertGreaterEqual(after["left"] - before["right"], 4, f"{before['name']} and {after['name']} do not touch: {listing}")

    # ---------------------------------------------------------------- theme and motion

    def test_08_theme_choice_persists_and_reduced_motion(self) -> None:
        page = self.page()
        page.goto("/")
        account = page.get_by_role("button", name=re.compile(NAME))
        account.click()
        menu = page.get_by_role("dialog", name="Account")
        expect(menu).to_be_visible()
        # The account menu is short (C-34): the name with the email, Settings and Sign out. The session line, this device's
        # notifications and the theme are in Settings.
        expect(menu.get_by_text(EMAIL)).to_be_visible()
        expect(menu.get_by_role("link", name="Settings", exact=True)).to_be_visible()
        expect(menu.get_by_role("button", name="Sign out")).to_be_visible()
        expect(menu.get_by_text("Signed in on this device until")).to_have_count(0)
        expect(menu.get_by_text("Notifications on this device")).to_have_count(0)
        expect(menu.get_by_role("radio")).to_have_count(0)
        shot(page, "desktop-1440-account-light")
        page.keyboard.press("Escape")
        expect(menu).to_have_count(0)
        expect(account).to_be_focused()
        # The theme is Settings > Appearance, and it persists across a reload.
        page.goto("/settings/appearance")
        themes = page.get_by_role("radiogroup", name="Theme")
        themes.get_by_role("radio", name="Dark").click()
        self.assertEqual(page.evaluate("document.documentElement.dataset.theme"), "dark")
        shot(page, "desktop-1440-appearance-dark")
        page.reload()
        self.assertEqual(page.evaluate("document.documentElement.dataset.theme"), "dark")
        themes.get_by_role("radio", name="Match system").click()
        self.assertIsNone(page.evaluate("document.documentElement.dataset.theme ?? null"))

        calm = self.page(reduced_motion="reduce")
        calm.goto(f"/projects/{self.first_space(calm)}")
        expect(calm.locator(".project-convo")).to_be_visible()
        self.assertEqual(calm.evaluate("parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dur-in'))"), 0)
        open_details(calm)
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
        # A password the server refuses as too easy to guess is not an expired link: the form stays and offers no new link (#990).
        page.get_by_label("New password", exact=True).fill("password1234")
        page.get_by_label("Repeat new password").fill("password1234")
        page.get_by_role("button", name="Save new password").click()
        expect(page.get_by_text("That password is too easy to guess.")).to_be_visible()
        expect(page.get_by_role("link", name="Request a new link")).to_have_count(0)
        page.get_by_label("New password", exact=True).fill(NEW_PASSWORD)
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
        page = self.page(signed_in=False, service_workers="block")
        # Simulate a server without SMTP: capabilities say so and the request answers 503.
        page.route("**/api/v1/auth/capabilities", lambda route: route.fulfill(json={"passwordReset": "unavailable"}))
        page.goto("/forgot-password")
        expect(page.get_by_text("Password reset by email isn’t set up on this Flux server.")).to_be_visible()
        # #763 FR-6: only the message and the way back; no form that cannot be used, no operator variables.
        expect(page.get_by_role("button", name="Send reset link")).to_have_count(0)
        expect(page.get_by_label("Email")).to_have_count(0)
        expect(page.get_by_text("FLUX_SMTP_URL")).to_have_count(0)
        expect(page.get_by_role("link", name="Back to sign in")).to_be_visible()
        shot(page, "reset-unavailable-desktop-light")

        late = self.page(signed_in=False, service_workers="block")
        late.route("**/api/auth/request-password-reset", lambda route: route.fulfill(status=503, json={"error": "Password reset is unavailable", "code": "PASSWORD_RESET_UNAVAILABLE"}))
        late.goto("/forgot-password")
        late.get_by_label("Email").fill(EMAIL)
        late.get_by_role("button", name="Send reset link").click()
        expect(late.get_by_text("Password reset by email isn’t set up on this Flux server.")).to_be_visible()

    # ---------------------------------------------------------------- sign out

    def test_11_sign_out_then_protected_routes_redirect(self) -> None:
        page = self.page(phone=True)
        page.goto("/")
        # On the phone the avatar opens Settings, which signs out (#266 PF-5, #341).
        page.get_by_role("link", name="Settings and account").click()
        expect(page).to_have_url(f"{ORIGIN}/settings")
        # Settings → Account holds Sign out (#350).
        page.locator('a[href="/settings/account"]').click()
        expect(page).to_have_url(f"{ORIGIN}/settings/account")
        page.get_by_role("button", name=re.compile("^Sign out")).click()
        expect(page).to_have_url(f"{ORIGIN}/sign-in")
        expect(page.get_by_role("status").filter(has_text="You’re signed out.")).to_be_visible()
        page.goto("/map")
        expect(page).to_have_url(re.compile(r"/sign-in\?next=%2Fmap$"))
        page.reload()
        expect(page.get_by_role("heading", name="Sign in")).to_be_visible()

    def person_with_a_task(self, name: str, *, slow: bool = True, service_workers: str = "allow") -> tuple[Page, str, str]:
        """A new account in its own tab with one restricted project and one task in it."""
        page = self.page(signed_in=False, service_workers=service_workers)
        if slow:
            page.add_init_script(SLOW_ANSWERS)
        page.goto("/sign-up")
        page.get_by_label("Name").fill(name)
        page.get_by_label("Email").fill(f"{name.split()[0].lower()}.sign-out+{time.time_ns()}@example.test")
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        request, headers = page.context.request, {"Origin": ORIGIN}
        space = request.post(f"{ORIGIN}/api/v1/workspaces", data={"name": "Dimmer bench"}, headers=headers)
        self.assertEqual(space.status, 201, space.text())
        project = request.post(f"{ORIGIN}/api/v1/workspaces/{space.json()['id']}/projects", data={"name": "Night light", "visibility": "restricted"}, headers=headers)
        self.assertEqual(project.status, 201, project.text())
        work = request.post(f"{ORIGIN}/api/v1/projects/{project.json()['id']}/work", data={"title": "Calibrate the dimmer curve", "outcome": "A fade that never flickers"}, headers=headers)
        self.assertEqual(work.status, 201, work.text())
        page.goto("/")
        expect(page.get_by_role("navigation", name="Spaces").get_by_role("link", name="Night light")).to_be_visible()
        return page, project.json()["id"], work.json()["id"]

    def sign_out_while_loading(self, page: Page, name: str) -> None:
        """Signs out while the tab still waits for answers, then lets every answer arrive."""
        page.get_by_role("button", name=re.compile(rf"{name}.*account and sign out")).click()
        page.get_by_role("dialog", name="Account").get_by_role("button", name="Sign out").click()
        expect(page.get_by_role("heading", name="Sign in")).to_be_visible()
        expect(page.get_by_role("status").filter(has_text="You’re signed out.")).to_be_visible()
        # What the tab was loading before sign-out answers now, while the sign-in page's own check
        # of the session is still out; then that check answers too. (That check is the sign-in
        # loader, run again when the page drops `?notice=` from its address; gate B waits for it.)
        page.wait_for_function("window.__slow.held('B') > 0")
        page.evaluate("window.__slow.release('A')")
        page.evaluate("window.__slow.quiet(500)")
        page.evaluate("window.__slow.release('B')")
        page.evaluate("window.__slow.quiet(500)")
        # Sign-out ends on the sign-in page and stays there: nothing loaded for the previous account
        # takes the tab back, neither its address nor its page.
        expect(page).to_have_url(f"{ORIGIN}/sign-in")
        expect(page.get_by_role("heading", name="Sign in")).to_be_visible()
        expect(page.get_by_text("Something went wrong")).to_have_count(0)
        self.assertEqual(page.evaluate("location.pathname + location.search"), "/sign-in")

    def test_11a_sign_out_while_an_opened_task_is_still_loading(self) -> None:
        """A search result opens a task in Details (`?open=work:<id>`); signing out right away wins."""
        page, project_id, _ = self.person_with_a_task("Rae Lund")
        page.get_by_role("button", name="Search", exact=True).click()
        dialog = page.get_by_role("dialog", name="Search", exact=True)
        field = dialog.get_by_role("combobox", name="Search", exact=True)
        field.fill("dimmer curve")
        expect(dialog.locator("[role=option].sr").first).to_contain_text("Calibrate the dimmer curve")
        dialog.locator("[role=option].sr").first.click()
        expect(page).to_have_url(re.compile(rf"/projects/{project_id}/tasks"))
        expect(page.get_by_role("complementary", name="Details")).to_be_visible()
        self.sign_out_while_loading(page, "Rae Lund")

    def test_11b_sign_out_while_a_project_is_still_opening(self) -> None:
        """A project link was followed and its page is still loading; signing out wins over it."""
        page, _, _ = self.person_with_a_task("Tove Berg")
        page.evaluate("window.__slow.arm()")
        page.get_by_role("navigation", name="Spaces").get_by_role("link", name="Night light").click()
        page.wait_for_function("window.__slow.held('A') > 0")
        expect(page).to_have_url(f"{ORIGIN}/")
        self.sign_out_while_loading(page, "Tove Berg")

    def test_11c_a_failed_sign_out_says_so_and_can_be_retried(self) -> None:
        page, _, _ = self.person_with_a_task("Ida Holm", slow=False, service_workers="block")
        page.route("**/api/auth/sign-out", lambda route: route.fulfill(status=503, json={"code": "TEST_UNAVAILABLE", "message": "test: sign-out unavailable"}))
        page.get_by_role("button", name=re.compile("Ida Holm.*account and sign out")).click()
        page.get_by_role("dialog", name="Account").get_by_role("button", name="Sign out").click()
        # The sign-out page says what happened and offers to try again; the session is still live.
        expect(page).to_have_url(f"{ORIGIN}/sign-out")
        expect(page.get_by_role("heading", name="Sign out of Flux?")).to_be_visible()
        expect(page.get_by_role("alert")).to_contain_text("Try again in a moment.")
        self.assertEqual(page.context.request.get(f"{ORIGIN}/api/v1/me").status, 200)
        page.unroute("**/api/auth/sign-out")
        page.get_by_role("button", name="Sign out").click()
        expect(page).to_have_url(f"{ORIGIN}/sign-in")
        expect(page.get_by_role("status").filter(has_text="You’re signed out.")).to_be_visible()
        self.assertEqual(page.context.request.get(f"{ORIGIN}/api/v1/me").status, 401)


    def test_12_real_project_capture_phone_and_revocation(self) -> None:
        """Real UI: create project, send, cite a saved version, reply, revisit on phone, revoke."""
        # A fresh account in a company of its own (the test deployment's fixture route; F-037: one company per Flux,
        # nobody names or picks it when starting a space).
        owner = self.page(signed_in=False, service_workers="block")
        owner.goto("/sign-up")
        owner.get_by_label("Name").fill("Mira Lamp")
        owner.get_by_label("Email").fill(f"mira.lamp+{int(time.time() * 1000)}@example.test")
        owner.get_by_label("Password").fill(PASSWORD)
        owner.get_by_role("button", name="Create account").click()
        expect(owner.get_by_role("heading", level=1, name="Home")).to_be_visible()
        own_company(owner, "Mira’s company")
        new_from_sidebar(owner, "Space")
        expect(owner.get_by_role("dialog", name="New space").get_by_text("Mira’s company")).to_have_count(0)
        owner.get_by_label("Space name").fill("Gesture lamp")

        def lose_first_committed(path: str):
            # The server commits the first POST but its 201 never arrives (#29 AC-4): Retry must not duplicate it.
            state = {"count": 0}
            def handler(route) -> None:
                if route.request.method != "POST":
                    route.continue_()
                    return
                state["count"] += 1
                if state["count"] == 1:
                    actual = route.fetch()
                    self.assertEqual(actual.status, 201, actual.text())
                    route.fulfill(status=503, json={"error": "test: committed response lost", "code": "TEST_LOST"})
                else:
                    route.continue_()
            owner.route(path, handler)
            return handler

        lost_project = lose_first_committed("**/api/v1/workspaces/*/projects")
        owner.get_by_role("button", name="Create space").click()
        expect(owner.get_by_role("alert")).to_be_visible()
        owner.get_by_role("button", name="Create space").click()
        expect(owner.get_by_role("heading", level=1, name="Gesture lamp")).to_be_visible()
        owner.unroute("**/api/v1/workspaces/*/projects", lost_project)
        project_id = owner.locator(".project-convo").get_attribute("data-project-id")
        self.assertTrue(project_id)
        spaces = owner.context.request.get(f"{ORIGIN}/api/v1/workspaces").json()
        self.assertEqual(len(spaces), 1, "starting a space makes no workspace")
        ws = spaces[0]
        projects = owner.context.request.get(f"{ORIGIN}/api/v1/workspaces/{ws['id']}/projects?limit=100").json()
        self.assertEqual([p["id"] for p in projects["items"]], [project_id], "a retried project whose first response was lost is not created twice")
        owner.get_by_role("navigation", name="Spaces").get_by_role("link", name="Gesture lamp").click()
        owner.get_by_role("navigation", name="Spaces").get_by_role("link", name="Gesture lamp").click()
        owner.get_by_label("Write a message").fill("Try a PIR sensor before considering a camera")
        owner.get_by_role("button", name="Send message").click()
        expect(owner.locator(".project-convo__message > .message-bubble > .message-body").filter(has_text="Try a PIR sensor before considering a camera")).to_be_visible()
        # Sending is instant (#264): the root shows at once and gets its conversation when it is stored.
        expect(owner.locator("[data-client-message-id]")).to_have_count(0)
        # One project conversation (UI116-1): the root joins the stream; its replies open beside it.
        expect(owner).to_have_url(f"{ORIGIN}/projects/{project_id}")
        opening = owner.locator(".project-convo__message").filter(has_text="Try a PIR sensor before considering a camera")
        conversation_id = opening.get_attribute("data-conversation-id")
        opening.hover()
        opening.get_by_role("button", name="Reply in thread", exact=True).click()
        expect(owner).to_have_url(re.compile(rf"/conversations/{conversation_id}$"))
        open_sources(owner, thread_of(owner))
        owner.get_by_role("button", name="Add material").click()
        owner.get_by_label("Title").fill("Privacy options")
        owner.get_by_label("Text").fill("PIR avoids storing images")
        owner.get_by_role("navigation", name="Places").get_by_role("link", name="Home").click()
        owner.go_back()
        expect(owner.get_by_label("Title")).to_have_value("Privacy options")
        expect(owner.get_by_label("Text")).to_have_value("PIR avoids storing images")
        owner.get_by_role("button", name="Save for this space").press("Enter")
        expect(owner.get_by_text("Privacy options")).to_be_visible()
        owner.get_by_role("button", name="Discuss this version").click()
        expect(thread_of(owner).locator(".composer-files__ref")).to_contain_text("Source: Privacy options · v1")
        owner.get_by_label("Reply", exact=True).fill("This is the version we should prototype")
        owner.get_by_role("button", name="Send reply").click()
        expect(owner.get_by_text("This is the version we should prototype", exact=True)).to_be_visible()
        source = owner.get_by_role("link", name=re.compile("Privacy options.*Wiki page · v1"))
        expect(source).to_be_visible()
        expect(source.locator(".wiki-card__glyph svg")).to_have_count(1)
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
        # Flux does not answer until the person acts: the thread's read of its stored messages and the app's own check (GET /api/v1/me,
        # three seconds after an answer was lost) wait too. Otherwise the refresh the lost answer starts brings the committed copy within a
        # tenth of a second and replaces the waiting reply before Retry can be pressed, or the check sends it by itself.
        held_reads: list = []
        def flux_does_not_answer_reads(route) -> None:
            if route.request.method == "GET":
                held_reads.append(route)
            else:
                route.continue_()
        unanswered = re.compile(rf"/api/v1/(me|conversations/{conversation_id})(\?.*)?$")
        owner.route(unanswered, flux_does_not_answer_reads)
        owner.get_by_label("Reply", exact=True).fill("Retry this one reply")
        owner.get_by_role("button", name="Send reply").click()
        # Sending is instant (#264): the reply waits with its command and is sent again when Flux answers.
        queued = thread_of(owner).locator("[data-client-message-id]").filter(has_text="Retry this one reply")
        expect(queued).to_contain_text("Waiting to send")
        queued.get_by_role("button", name="Retry").click()
        expect(queued).to_have_count(0)
        owner.unroute(unanswered, flux_does_not_answer_reads)
        for route in held_reads:
            route.continue_()
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
        queued = thread_of(owner).locator("[data-client-message-id]").filter(has_text="Reload after lost reply")
        expect(queued).to_contain_text("Waiting to send")
        expect(owner.get_by_label("Reply", exact=True)).to_have_value("")
        owner.unroute("**/api/v1/conversations/*/messages", lose_committed_reply)
        # The waiting reply and its id survive the reload, and it is sent again as the thread opens.
        owner.reload()
        expect(queued).to_have_count(0)
        expect(owner.get_by_text("Reload after lost reply", exact=True)).to_have_count(1)
        expect(owner.get_by_label("Reply", exact=True)).to_have_value("")
        saved = owner.context.request.get(f"{ORIGIN}/api/v1/conversations/{conversation_id}").json()
        self.assertEqual(sum(message["body"] == "Reload after lost reply" for message in saved["messages"]), 1)

        thread_of(owner).get_by_role("button", name="Close replies").click()
        expect(thread_of(owner)).to_have_count(0)
        def lose_committed_opening(route) -> None:
            response = route.fetch()
            self.assertEqual(response.status, 201)
            route.abort("failed")
        owner.route("**/api/v1/projects/*/conversations", lose_committed_opening)
        owner.get_by_label("Write a message").fill("Revisit after lost opening")
        owner.get_by_role("button", name="Send message").click()
        expect(owner.get_by_role("region", name="Messages").locator("[data-client-message-id]").filter(has_text="Revisit after lost opening")).to_contain_text("Waiting to send")
        owner.unroute("**/api/v1/projects/*/conversations", lose_committed_opening)
        owner.get_by_role("link", name="Home").click()
        owner.goto(f"/projects/{project_id}")
        expect(owner.get_by_label("Write a message")).to_have_value("")
        # The waiting root is sent again with its key when the stream opens, and joins the one stream once.
        expect(owner.get_by_role("region", name="Messages").locator("[data-client-message-id]")).to_have_count(0)
        expect(owner.get_by_role("region", name="Messages").get_by_text("Revisit after lost opening", exact=True)).to_be_visible()
        threads = owner.context.request.get(f"{ORIGIN}/api/v1/projects/{project_id}/conversations").json()["items"]
        self.assertEqual(sum(thread["firstMessageBody"] == "Revisit after lost opening" for thread in threads), 1)
        owner.goto(f"/projects/{project_id}/conversations/{conversation_id}")
        expect(owner.get_by_role("link", name=re.compile("Privacy options.*Wiki page · v1"))).to_be_visible()

        read_failures = {"count": 0}
        def fail_first_citation(route) -> None:
            read_failures["count"] += 1
            if read_failures["count"] == 1:
                route.abort("failed")
            else:
                route.continue_()
        owner.route("**/api/v1/materials/*/versions/1", fail_first_citation)
        owner.get_by_label("Reply", exact=True).fill("Do not send this draft on read retry")
        open_sources(owner, thread_of(owner))
        owner.get_by_role("button", name="Discuss this version").click()
        expect(owner.get_by_role("button", name="Retry read")).to_be_visible()
        owner.get_by_role("button", name="Retry read").click()
        expect(thread_of(owner).locator(".composer-files__ref")).to_contain_text("Source: Privacy options · v1")
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
        invite = owner.context.request.post(f"{ORIGIN}/api/v1/workspaces/{ws['id']}/members", data={"email": partner_email, "role": "member"}, headers={"Origin": ORIGIN})
        self.assertEqual(invite.status, 201, invite.text())
        partner_grant = owner.context.request.post(f"{ORIGIN}/api/v1/projects/{project_id}/grants", data={"principal": {"kind": "human", "id": partner_id}, "role": "contributor"}, headers={"Origin": ORIGIN})
        self.assertEqual(partner_grant.status, 201, partner_grant.text())
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
        # A project has its own context; leave to Home and return without losing text.
        phone.goto("/")
        phone.go_back()
        expect(phone.get_by_label("Reply", exact=True)).to_have_value("Phone draft survives a view switch")
        expect(phone.locator(".project-convo__current-thread")).to_contain_text("Try a PIR sensor before considering a camera")
        phone.set_viewport_size({"width": 390, "height": 500})
        phone.get_by_label("Reply", exact=True).focus()
        phone.wait_for_function(
            "() => { const el = document.querySelector('[role=\"dialog\"] .project-convo__composer, .thread .project-convo__composer'); if (!el) return false; const r = el.getBoundingClientRect(); return r.height > 0 && r.bottom <= 500; }"
        )
        composer = thread_of(phone).locator(".project-convo__composer").bounding_box()
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

        denial = owner.context.request.delete(f"{ORIGIN}/api/v1/projects/{project_id}/grants/{partner_grant.json()['id']}", headers={"Origin": ORIGIN})
        self.assertEqual(denial.status, 204, denial.text())
        # The open thread hears of the denial from the live stream (#733): without any action, the next read is refused and
        # the person lands on the nearest place they can open with one line saying why (#592). Before the live refresh this
        # waited for a read the person started ("Discuss this version"); now nothing of the project stays on screen meanwhile.
        expect(phone.get_by_text("That space is no longer available to you.", exact=True)).to_be_visible(timeout=10000)
        expect(phone).to_have_url(re.compile(r"/projects$"))
        expect(phone.get_by_text("Agreed. Test low light too.", exact=True)).to_have_count(0)
        expect(phone.get_by_label("Reply", exact=True)).to_have_count(0)
        phone.reload()
        expect(phone.get_by_text("Agreed. Test low light too.", exact=True)).to_have_count(0)
        self.assertEqual(phone.context.request.get(f"{ORIGIN}/api/v1/conversations/{conversation_id}").status, 404)
        # Every page of this test settles, the revoked ones included: none reads the person in a loop (#1126).
        for page, _reads in self.me_reads:
            if not page.is_closed():
                page.wait_for_timeout(1500)
                break
        self.assert_few_me_reads()

    def test_13_project_pagination_and_live_history(self) -> None:
        """The 101st item is reachable, and a fresh reply cannot punch a hole in loaded history."""
        owner = self.page(signed_in=False)
        email = f"pagination+{int(time.time() * 1000)}@example.test"
        owner.goto("/sign-up")
        owner.get_by_label("Name").fill("Pagination Owner")
        owner.get_by_label("Email").fill(email)
        owner.get_by_label("Password").fill(PASSWORD)
        owner.get_by_role("button", name="Create account").click()
        own_company(owner)
        new_from_sidebar(owner, "Space")
        owner.get_by_label("Space name").fill("Busy project")
        owner.get_by_role("button", name="Create space").click()
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
        # One stream (UI116-1): the newest 50 roots, then earlier windows on request.
        stream = owner.get_by_role("region", name="Messages")
        roots = stream.locator(".project-convo__message")
        expect(roots).to_have_count(50)
        expect(owner.get_by_role("button", name="Load more materials")).to_be_visible()
        for loaded_count in (100, 101):
            stream.get_by_role("button", name="Load earlier messages").click()
            expect(roots).to_have_count(loaded_count)
        expect(stream.get_by_role("button", name="Load earlier messages")).to_have_count(0)
        owner.get_by_role("button", name="Load more materials").click()
        expect(roots.first).to_contain_text("Thread 000")
        expect(owner.get_by_role("article").filter(has_text="Material 000")).to_be_visible()
        self.assertEqual(roots.count(), 101)
        self.assertEqual(owner.locator(".project-convo__material").count(), 101)

        for index in range(1, 121):
            result = request.post(f"{ORIGIN}/api/v1/conversations/{first_id}/messages", data={"body": f"Reply {index:03}", "clientMessageId": str(uuid.uuid4())}, headers=headers)
            self.assertEqual(result.status, 201, result.text())
        owner.goto(f"/projects/{project_id}/conversations/{first_id}")
        expect(owner.get_by_label("Reply", exact=True)).to_be_visible()
        # The thread beside the stream holds the replies; its root (sequence 1) sits at its top (UI116-1).
        replies = thread_of(owner).locator(".project-convo__message")
        expect(replies).to_have_count(50)
        for loaded_count in (100, 120):
            owner.get_by_role("button", name="Load earlier replies").click()
            expect(replies).to_have_count(loaded_count)
        expect(owner.get_by_role("button", name="Load earlier replies")).to_have_count(0)
        expect(thread_of(owner).locator(".thread__root")).to_contain_text("Thread 000")
        self.assertEqual(replies.count(), 120)
        result = request.post(f"{ORIGIN}/api/v1/conversations/{first_id}/messages", data={"body": "Reply 121", "clientMessageId": str(uuid.uuid4())}, headers=headers)
        self.assertEqual(result.status, 201, result.text())
        owner.evaluate("window.dispatchEvent(new Event('focus'))")
        expect(owner.get_by_text("Reply 121", exact=True)).to_be_visible()
        self.assertEqual(replies.count(), 121, "revalidation retains every loaded sequence")
        self.assertEqual([re.search(r'(?:Missed reply|Reply) \d+', text).group(0) for text in replies.all_inner_texts()], [f"Reply {index:03}" for index in range(1, 121)] + ["Reply 121"])

        # More than one server window arrives while this page is idle. Refresh must fill
        # the middle before presenting the new tail beside already loaded history.
        for index in range(60):
            result = request.post(f"{ORIGIN}/api/v1/conversations/{first_id}/messages", data={"body": f"Missed reply {index}", "clientMessageId": str(uuid.uuid4())}, headers=headers)
            self.assertEqual(result.status, 201, result.text())
        owner.evaluate("window.dispatchEvent(new Event('focus'))")
        expect(owner.get_by_text("Missed reply 59", exact=True)).to_be_visible()
        expect(replies).to_have_count(181)
        self.assertEqual([re.search(r'(?:Missed reply|Reply) \d+', text).group(0) for text in replies.all_inner_texts()], [f"Reply {index:03}" for index in range(1, 121)] + ["Reply 121"] + [f"Missed reply {index}" for index in range(60)])

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
        # Sending is instant (#264): the held reply shows at once, the field empties and stays usable.
        held = thread_of(owner).locator("[data-client-message-id]").filter(has_text="Held reply")
        expect(held).to_contain_text("Sending…")
        expect(reply_box).to_have_value("")
        expect(reply_box).to_be_enabled()
        owner.evaluate("() => { window.releaseReply(); }")
        expect(held).to_have_count(0)
        expect(owner.get_by_text("Held reply", exact=True)).to_have_count(1)
        expect(reply_box).to_have_value("")

        open_sources(owner, thread_of(owner))
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
        owner.get_by_role("button", name="Save for this space").click()
        expect(owner.get_by_label("Title")).to_be_disabled()
        expect(owner.get_by_label("Text")).to_be_disabled()
        owner.evaluate("() => { window.releaseMaterial(); }")
        expect(owner.get_by_role("article").filter(has_text="Held material")).to_be_visible()

    def test_14_your_agent_app_shows_how_to_connect_what_it_may_do_and_disconnects(self) -> None:
        """A first-time owner sees how a client signs in (one click, no form), sets what a connected client may do, and disconnects it (#859)."""
        page = self.page(signed_in=False)
        email = f"agent-setup+{int(time.time() * 1000)}@example.test"
        page.goto("/sign-up")
        page.get_by_label("Name").fill("Agent Setup Owner")
        page.get_by_label("Email").fill(email)
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        own_company(page)
        new_from_sidebar(page, "Space")
        page.get_by_label("Space name").fill("Sensor study")
        page.get_by_role("button", name="Create space").click()
        expect(page.get_by_role("heading", level=1, name="Sensor study")).to_be_visible()
        project_id = re.search(r"/projects/([0-9a-f-]{36})", page.url).group(1)

        page.goto("/connect-agent")
        expect(page).to_have_url(re.compile(r"/settings/agents/connect$"))
        expect(page.get_by_role("heading", level=1, name="Claude Code, Codex or another app on your computer")).to_be_visible()
        page.get_by_text("Show the command", exact=True).first.click()
        expect(page.get_by_text("claude mcp add --transport http flux", exact=False)).to_be_visible()
        # Nothing to fill in: no space to choose, no name to give, no capability to switch on.
        connection_page = page.get_by_role("region", name="Claude Code, Codex or another app")
        for control in ("checkbox", "textbox", "combobox", "radio"):
            expect(connection_page.get_by_role(control)).to_have_count(0)
        expect(page.get_by_text("Nothing is connected yet")).to_be_visible()
        shot(page, "agent-first-desktop")
        page.set_viewport_size(PHONE)
        shot(page, "agent-first-phone")
        page.set_viewport_size(DESKTOP)

        # A client signs in on its consent page (tests/ui/test_oauth_consent.py); here its connection is made as that sign-in makes it.
        workspace = page.context.request.get(f"{ORIGIN}/api/v1/workspaces").json()[0]["id"]
        headers = {"origin": ORIGIN, "content-type": "application/json"}
        agent = page.context.request.post(f"{ORIGIN}/api/v1/workspaces/{workspace}/agents", headers=headers, data=json.dumps({"name": "My research agent", "owner": "self"}))
        self.assertEqual(agent.status, 201, agent.text())
        made = page.context.request.post(f"{ORIGIN}/api/v1/integration/agent-connections", headers=headers,
                                         data=json.dumps({"agentId": agent.json()["id"], "name": "Research laptop", "clientDesignation": "codex"}))
        self.assertEqual(made.status, 201, made.text())
        page.reload()
        saved = page.get_by_role("list", name="Connected clients").get_by_role("listitem")
        expect(saved).to_have_count(1)
        expect(saved.get_by_text("Research laptop", exact=True)).to_be_visible()
        # Ask me first (#1419) starts off ("Do it and tell me"); the owner turns it on here, and it is kept.
        ask = saved.get_by_role("switch", name="Ask me first")
        expect(ask).to_have_attribute("aria-checked", "false")
        ask.click()
        expect(ask).to_have_attribute("aria-checked", "true")
        page.reload()
        expect(page.get_by_role("list", name="Connected clients").get_by_role("switch", name="Ask me first")).to_have_attribute("aria-checked", "true")
        # The connection gave the agent no grant of its own: its access is its owner's.
        grants = page.context.request.get(f"{ORIGIN}/api/v1/projects/{project_id}/grants")
        self.assertEqual(grants.status, 200, grants.text())
        self.assertFalse(any(grant["principal"]["kind"] == "agent" for grant in grants.json()), grants.text())
        shot(page, "agent-saved-desktop")
        page.set_viewport_size(PHONE)
        shot(page, "agent-saved-phone")
        page.set_viewport_size(DESKTOP)
        saved = page.get_by_role("list", name="Connected clients").get_by_role("listitem")
        saved.get_by_role("button", name="Disconnect").click()
        saved.get_by_role("button", name="Disconnect", exact=True).click()
        expect(page.get_by_role("list", name="Connected clients")).to_have_count(0)
        expect(page.get_by_text("Disconnected (1)")).to_be_visible()
        connections = page.context.request.get(f"{ORIGIN}/api/v1/agent-connections")
        self.assertEqual(connections.status, 200, connections.text())
        self.assertEqual(len(connections.json()), 1)
        self.assertIsNotNone(connections.json()[0]["revokedAt"])

    def sign_up_and_create_project(self, page: Page, name: str) -> None:
        page.goto("/sign-up")
        page.get_by_label("Name").fill("Leaving Owner")
        page.get_by_label("Email").fill(f"leaving+{int(time.time() * 1000)}@example.test")
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        own_company(page)
        new_from_sidebar(page, "Space")
        page.get_by_label("Space name").fill(name)
        page.get_by_role("button", name="Create space").click()
        expect(page.get_by_role("heading", level=1, name=name)).to_be_visible()

    def hold_settings_code(self, page: Page) -> list:
        """Holds the Space settings page's code download (the page that reads a space's people)."""
        held: list = []
        pattern = re.compile(r"/assets/SpaceSettings-[^/]+\.js(?:\?.*)?$")
        page.route(pattern, lambda route: held.append(route))

        def release() -> None:
            page.unroute(pattern)
            for route in held:
                try:
                    route.abort("aborted")
                except Exception:  # noqa: BLE001 - the page is already closed
                    pass

        self.addCleanup(release)
        return held

    def open_settings(self, page: Page) -> None:
        """⋯ › Settings of the open space (the page's code is what is held)."""
        page.locator("header.top").get_by_role("button", name="More", exact=True).click()
        page.get_by_role("menu", name="More").get_by_role("menuitem", name="Settings", exact=True).click()

    def wait_until_held(self, page: Page, held: list) -> None:
        deadline = time.monotonic() + 5
        while not held:
            self.assertLess(time.monotonic(), deadline, "the Space settings code request never arrived")
            page.wait_for_timeout(10)

    def test_14a_leaving_while_the_settings_page_is_still_loading_starts_no_request(self) -> None:
        """A page that is being left starts no request, however the app reacts to the leave (#471)."""
        # A space's settings page is opened; its code is still downloading when the person
        # follows a link out. The failed download and the address change that comes with the same
        # commit used to start /me and the space's people after beforeunload.
        page = self.page(signed_in=False, service_workers="block")
        page.add_init_script(FETCH_RECORDER)
        started: list[str] = []
        page.on("console", lambda message: started.append(message.text) if message.text.startswith("started-while-leaving ") else None)
        held = self.hold_settings_code(page)
        self.sign_up_and_create_project(page, "Sensor study")
        self.open_settings(page)
        self.wait_until_held(page, held)
        page.goto("/connect-agent")
        expect(page.get_by_role("heading", level=1, name="Claude Code, Codex or another app on your computer")).to_be_visible()
        page.evaluate("1")  # events of the document that was left have all arrived
        self.assertEqual(started, [], "no request started after beforeunload")

    def test_14b_a_page_that_mounts_while_the_page_is_left_reads_once_the_page_is_live(self) -> None:
        """Its mount-time reads wait for the grace of a cancelled navigation, and then run (#471)."""
        page = self.page(signed_in=False, service_workers="block")
        page.add_init_script(FETCH_RECORDER)
        held = self.hold_settings_code(page)
        self.sign_up_and_create_project(page, "Sensor study")
        self.open_settings(page)
        self.wait_until_held(page, held)
        # A leave that is cancelled never reaches pagehide. The page's code arrives in that moment.
        start = page.evaluate("() => { window.dispatchEvent(new Event('beforeunload')); return performance.now(); }")
        held[0].continue_()
        page.wait_for_function("(start) => window.__fetches.some(([at, url]) => at >= start && /\\/grants$/.test(url))", arg=start, timeout=6000)
        reads = page.evaluate(
            "(start) => window.__fetches.filter(([at, url]) => at >= start && /\\/(members|grants)$/.test(url)).map(([at]) => at - start)",
            start,
        )
        self.assertTrue(reads, "the page read the space's people after all")
        self.assertGreaterEqual(min(reads), 990, f"no read started while the leave could still happen: {reads}")

    def test_14c_a_read_wanted_while_leaving_runs_when_the_leave_is_cancelled(self) -> None:
        """A read a page wants while it is being left waits, and then runs: nothing stays stale (#471)."""
        page = self.page(signed_in=False)
        page.add_init_script(FETCH_RECORDER)
        self.sign_up_and_create_project(page, "Sensor study")
        # A leave that is cancelled never reaches pagehide. The browser coming back online is when
        # the project's agent owners are read again. Start once the page has been quiet for a moment,
        # so only what the leave itself holds back is measured.
        result = page.evaluate(
            """async () => {
                let seen = -1;
                for (let round = 0; round < 10 && seen !== window.__fetches.length; round += 1) {
                    seen = window.__fetches.length;
                    await new Promise((resolve) => setTimeout(resolve, 600));
                }
                const start = performance.now();
                window.dispatchEvent(new Event('beforeunload'));
                window.dispatchEvent(new Event('online'));
                await new Promise((resolve) => setTimeout(resolve, 2500));
                const people = window.__fetches.filter(([at, url]) => at >= start && /\\/people$/.test(url)).map(([at]) => at - start);
                return { people };
            }"""
        )
        self.assertTrue(result["people"], "the read that waited ran once the page was live again")
        self.assertGreaterEqual(min(result["people"]), 990, f"no read started while the leave could still happen: {result['people']}")

    def open_while_leaving(self, page: Page, path: str) -> float:
        """beforeunload, then the router opens `path` with no click or key press (either would prove the page stays)."""
        return page.evaluate(
            """(path) => {
                const start = performance.now();
                window.dispatchEvent(new Event('beforeunload'));
                const idx = ((history.state && history.state.idx) || 0) + 1;
                history.pushState({ usr: null, key: `leave-${idx}`, idx }, '', path);
                window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
                return start;
            }""",
            path,
        )

    def assert_read_waits_for_the_grace(self, page: Page, start: float, url: str) -> None:
        page.wait_for_function("([start, url]) => window.__fetches.some(([at, u]) => at >= start && u.includes(url))", arg=[start, url], timeout=8000)
        reads = page.evaluate("([start, url]) => window.__fetches.filter(([at, u]) => at >= start && u.includes(url)).map(([at]) => at - start)", [start, url])
        self.assertGreaterEqual(min(reads), 990, f"{url} was not read while the leave could still happen: {reads}")

    def test_14d_the_sign_in_page_asks_for_single_sign_on_only_once_the_page_is_live(self) -> None:
        """A sign-in page that opens while the page is being left reads its capabilities after the grace (#471)."""
        page = self.page(signed_in=False)
        page.add_init_script(FETCH_RECORDER)
        page.goto("/sign-up")
        expect(page.get_by_role("button", name="Create account")).to_be_visible()
        start = self.open_while_leaving(page, "/sign-in")
        expect(page.get_by_role("heading", name="Sign in")).to_be_visible()
        self.assert_read_waits_for_the_grace(page, start, "/api/v1/auth/capabilities")


if __name__ == "__main__":
    unittest.main(verbosity=2)
