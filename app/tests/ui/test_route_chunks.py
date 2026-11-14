"""Real browser download boundaries for #326; service-worker installation is tested separately.

Cold contexts block service workers here so their intentional precache downloads cannot be mistaken
for document imports. Inputs/navigation are trusted; held/failed actual compiled asset requests
exercise the production router and modal owners, without substituting route components or loaders.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, Route, expect, sync_playwright
from account import sign_out

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder, view_tab

# Live editing is the wiki editor whenever it is configured (check_ui.sh sets FLUX_LIVE_EDITING=on by default).
LIVE = os.environ.get('FLUX_LIVE_EDITING', 'on') != 'off'

# Exhaust real browser storage; a subsequent larger write must be refused by its own quota.
# No storage API, React state or success response is replaced.
EXHAUST_STORAGE = """kind => {
  const storage = kind === 'local' ? localStorage : sessionStorage;
  const fits = size => { try { storage.setItem('quota-route-recovery', 'x'.repeat(size)); return true; }
    catch (error) { if (error.name !== 'QuotaExceededError') throw error; return false; } };
  let low = 0, high = 1 << 25;
  while (low < high) { const middle = Math.ceil((low + high) / 2); if (fits(middle)) low = middle; else high = middle - 1; }
  try { storage.setItem('quota-route-probe', 'x'); } catch (error) { return error.name; }
  storage.removeItem('quota-route-probe'); return 'accepted';
}"""

class RouteChunksJourney(unittest.TestCase):
    pw = None
    browsers: dict[str, Browser] = {}
    state: dict = {}
    name = "Ari Route Chunks"
    project_id = ""
    conversation_id = ""
    dm_id = ""
    email = ""

    @classmethod
    def setUpClass(cls):
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browsers = {"chromium": cls.pw.chromium.launch(), "webkit": cls.pw.webkit.launch()}
        expect.set_options(timeout=10000)
        context = cls.browsers["chromium"].new_context(base_url=ORIGIN, service_workers="block")
        try:
            page = context.new_page()
            page.goto("/sign-up")
            page.get_by_label("Name").fill(cls.name)
            cls.email = f"route.chunks+{uuid.uuid4()}@example.test"
            page.get_by_label("Email").fill(cls.email)
            page.get_by_label("Password").fill("a quiet route loading passphrase")
            page.get_by_role("button", name="Create account").click()
            expect(page.get_by_role("heading", name="Home", exact=True)).to_be_visible()
            def create(path, body):
                response = page.request.post(f"{ORIGIN}{path}", headers={"origin": ORIGIN, "content-type": "application/json"}, data=json.dumps(body))
                if response.status != 201:
                    raise AssertionError(f"Fixture setup {path}: {response.status} {response.text()}")
                return response.json()
            space = create("/api/v1/workspaces", {"name": "Route boundaries"})
            project = create(f"/api/v1/workspaces/{space['id']}/projects", {"name": "Chunk boundaries", "visibility": "restricted"})
            cls.project_id = project["id"]
            conversation = create(f"/api/v1/projects/{project['id']}/conversations", {"body": "An eager conversation stays available before secondary routes", "clientMessageId": str(uuid.uuid4())})
            cls.conversation_id = conversation["id"]
            # A direct message is the place with a panel of its own, "People and privacy" (a space has none, #1419).
            peer_context = cls.browsers["chromium"].new_context(base_url=ORIGIN, service_workers="block")
            try:
                peer = peer_context.new_page()
                peer.goto("/sign-up")
                peer.get_by_label("Name").fill("Jonas Route")
                peer_email = f"route.chunks.peer+{uuid.uuid4()}@example.test"
                peer.get_by_label("Email").fill(peer_email)
                peer.get_by_label("Password").fill("a quiet route loading passphrase")
                peer.get_by_role("button", name="Create account").click()
                expect(peer.get_by_role("heading", name="Home", exact=True)).to_be_visible()
                peer_id = peer.request.get(f"{ORIGIN}/api/v1/me").json()["user"]["id"]
            finally:
                peer_context.close()
            create(f"/api/v1/workspaces/{space['id']}/members", {"email": peer_email, "role": "member"})
            cls.dm_id = create(f"/api/v1/workspaces/{space['id']}/dms", {"participantIds": [peer_id]})["id"]
            cls.state = context.storage_state()
        finally:
            context.close()

    @classmethod
    def tearDownClass(cls):
        for browser in cls.browsers.values():
            browser.close()
        cls.pw.stop()

    def page(self, engine: str, *, phone=False, tablet=False) -> Page:
        context: BrowserContext = self.browsers[engine].new_context(
            base_url=ORIGIN, storage_state=self.state, service_workers="block", reduced_motion="reduce",
            viewport=PHONE if phone else {"width": 820, "height": 1180} if tablet else DESKTOP, is_mobile=phone or tablet, has_touch=phone or tablet,
        )
        self.addCleanup(context.close)
        page = context.new_page()
        errors = []
        # WebKit reports a background read that the page abandons during a reload as an access-control
        # failure; the application already catches it (WorkingAgent), so only that exact case is ignored.
        page.on("pageerror", lambda error: None if re.search(r"/api/v1/assistant-runs\?limit=10 due to access control checks", str(error)) else errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "No uncaught application errors"))
        return page

    def layout(self, page: Page) -> dict:
        """The boxes a pending navigation must not move: the header, the live strip when there is one, and the work."""
        return page.evaluate("""() => Object.fromEntries(['header', '.lv-bar', '.app__body', '#content'].map((selector) => {
          const el = document.querySelector(selector);
          const b = el?.getBoundingClientRect();
          return [selector, b ? [b.x, b.y, b.width, b.height].map(Math.round) : null];
        }))""")

    def assert_pending_is_still(self, page: Page, before: dict, pending) -> None:
        """While a navigation waits, the row floats over the work: nothing else changes place, and Cancel is a 44 px target."""
        expect(pending).to_be_visible()
        self.assertEqual(self.layout(page), before, "a pending navigation moves neither the header, the strip nor the work")
        cancel = pending.get_by_role("button", name="Cancel", exact=True).bounding_box()
        assert cancel
        self.assertGreaterEqual(cancel["height"], 43.5, "Cancel is a 44 px target")
        row = pending.bounding_box()
        assert row and row["y"] >= before["header"][1] + before["header"][3] - 1, "the row is below the header"

    def home(self, page: Page):
        page.goto("/")
        expect(page.get_by_role("heading", name="Home", exact=True)).to_be_visible()
        expect(page.get_by_role("region", name="Waiting for you")).to_be_visible()

    def notes(self, page: Page):
        """An editable field with work in it: the message box of the project's conversation (the Sketchbook's note composer is gone, #866)."""
        page.goto(f"/projects/{self.project_id}")
        expect(page.get_by_label("Write a message", exact=True)).to_be_visible()

    def back_to_notes(self, page: Page, *, phone=False):
        """Returns to the conversation through the router, in the same document (no reload)."""
        page.get_by_role("navigation", name="Spaces").get_by_role("link", name="Chunk boundaries").click()
        expect(page.get_by_label("Write a message", exact=True)).to_be_visible()

    def settings(self, page: Page, *, phone=False):
        if phone:
            # The phone reaches Settings through the account avatar in the header (#341).
            page.get_by_role("link", name="Settings and account", exact=True).click()
        else:
            page.get_by_role("link", name=re.compile(rf"{self.name}, Settings$")).click()

    def direct_message(self, page: Page):
        """A place whose header has a panel of its own in its More menu: a direct message, as People and privacy (#871: Home and My map have none, and a space has none, #1419)."""
        page.goto(f"/dm/{self.dm_id}")
        expect(page.get_by_role("heading", level=1, name="Jonas Route", exact=True)).to_be_visible()

    def open_details_by_keyboard(self, page: Page):
        """Tab to the header's More, open its menu and choose People and privacy with the keyboard; More is the opener focus comes back to."""
        opener = page.get_by_role("button", name="More", exact=True)
        for _ in range(50):
            if opener.evaluate("element => element === document.activeElement"):
                break
            page.keyboard.press("Tab")
        expect(opener).to_be_focused()
        page.keyboard.press("Enter")
        item = page.get_by_role("menu", name="More").get_by_role("menuitem", name="People and privacy", exact=True)
        expect(item).to_be_visible()
        item.focus()
        page.keyboard.press("Enter")
        return opener

    def hold(self, page: Page, module: str):
        held: list[Route] = []
        pattern = re.compile(rf"/assets/{module}-[^/]+\.js(?:\?.*)?$")
        def pause(route):
            held.append(route)
        page.route(pattern, pause)
        def cleanup():
            page.unroute(pattern, pause)
            for route in held:
                try:
                    route.abort("aborted")
                except Exception:  # the page already gave the request up (a navigation, a close)
                    pass
            held.clear()
        self.addCleanup(cleanup)
        # A retained Route is released by the test, so the browser remains responsive to other input.
        return held

    def request_is_held(self, page: Page, held):
        # Native dynamic import starts after the stylesheet is ready. Observe its actual paused
        # request instead of assuming a loading placeholder means the request has already arrived.
        deadline = time.monotonic() + 3
        while not held:
            self.assertLess(time.monotonic(), deadline, "The actual route code request did not arrive")
            page.wait_for_timeout(5)
        self.assertEqual(len(held), 1, "Exactly one actual code download is held")

    def test_12_wiki_text_and_its_save_survive_a_refused_route_and_a_full_storage(self):
        # The page is written where it is read and saves by itself (#869). With the save refused and this tab's storage full,
        # a refused code route and the way back through the router keep the text and the exact save identity: when the
        # server answers again, the text is saved once, as the next version. Live editing (#228) keeps its recovery copy in
        # this visit; the ordinary editor keeps its own.
        for engine in self.browsers:
            with self.subTest(engine=engine):
                page = self.page(engine)
                self.home(page)
                created = page.request.post(f"{ORIGIN}/api/v1/projects/{self.project_id}/docs",
                    headers={"origin": ORIGIN, "idempotency-key": str(uuid.uuid4())},
                    data={"title": f"Owned Wiki recovery {engine}", "body": "Server baseline"})
                self.assertEqual(created.status, 201, created.text())
                doc = created.json()
                page.goto(f"/projects/{self.project_id}/docs/{doc['id']}")
                text = page.locator('.cm-content[aria-label="Page text"]')
                expect(text).to_have_attribute("contenteditable", "true")
                method = "POST" if LIVE else "PATCH"
                api_path = f"/api/v1/docs/{doc['id']}/live/save" if LIVE else f"/api/v1/docs/{doc['id']}"
                api_pattern = re.compile(re.escape(api_path) + "$")
                attempted = []
                def failed_save(route):
                    if route.request.method != method:
                        route.continue_(); return
                    attempted.append({"body": route.request.post_data_json, "key": route.request.headers.get("idempotency-key"),
                        "base": route.request.headers.get("if-match")})
                    route.fulfill(status=503, content_type="application/json", body='{"message":"Save temporarily unavailable"}')
                page.route(api_pattern, failed_save)
                self.assertEqual(page.evaluate(EXHAUST_STORAGE, 'session'), 'QuotaExceededError')
                latest = f"Latest Wiki B {engine}: " + "Retain the complete private edit and its save identity. " * 35
                text.click(); page.keyboard.press("Control+a"); page.keyboard.insert_text(latest)
                page.wait_for_function("() => true")
                deadline = time.monotonic() + 20
                while not attempted and time.monotonic() < deadline:
                    page.wait_for_timeout(200)
                self.assertTrue(attempted, "the save was tried by itself")
                self.assertEqual(attempted[0]["base"], f'"{doc["version"]}"')
                if LIVE:
                    self.assertEqual(attempted[0]["body"]["expectedVersion"], doc["version"])
                    self.assertEqual(attempted[0]["key"], attempted[0]["body"]["clientCommandId"])
                else:
                    self.assertEqual(attempted[0]["body"]["body"], latest)
                pattern = re.compile(r"/assets/SettingsHome-[^/]+\.js(?:\?.*)?$")
                def refused(route):
                    route.fulfill(status=503, headers={"cache-control": "no-store"}, content_type="text/plain", body="Real refused Wiki recovery delivery")
                page.route(pattern, refused)
                self.settings(page)
                expect(page.get_by_role("heading", name="This page couldn’t be loaded", exact=True)).to_be_visible()
                page.unroute(pattern, refused)
                expect(page.get_by_role("button", name="Reload Flux", exact=True)).to_be_disabled()
                page.get_by_role("link", name="Go to Home", exact=True).click()
                # Navigate through the public router, preserving the same document and visit copy.
                page.locator(".app__side").get_by_role("link", name=re.compile("^Chunk boundaries(?:, new activity)?$")).click()
                page.get_by_role("navigation", name="Space views").get_by_role("tab", name="Wiki", exact=True).click()
                page.locator(".wiki-page").get_by_role("heading", level=2).get_by_role("button").click()
                page.get_by_role("dialog", name=re.compile("^Pages in")).get_by_role("link", name=doc["title"], exact=True).click()
                expect(text).to_contain_text(latest[:60])
                page.evaluate("sessionStorage.removeItem('quota-route-recovery')")
                page.unroute(api_pattern, failed_save)
                deadline = time.monotonic() + 30
                while True:
                    current = page.request.get(f"{ORIGIN}/api/v1/docs/{doc['id']}").json()
                    if current["body"] == latest or time.monotonic() > deadline:
                        break
                    page.wait_for_timeout(250)
                self.assertEqual(current["body"], latest)
                self.assertEqual(current["version"], doc["version"] + 1, "saved once")
                self.assertTrue(all(attempt == attempted[0] for attempt in attempted), "every try is the same save")

    def test_13_failed_fresh_session_check_never_performs_document_reload(self):
        for engine in self.browsers:
            with self.subTest(engine=engine):
                page = self.page(engine)
                self.home(page)
                pattern = re.compile(r"/assets/SettingsHome-[^/]+\.js(?:\?.*)?$")
                def refused(route):
                    route.fulfill(status=503, headers={"cache-control": "no-store"}, body="Real refused code")
                page.route(pattern, refused)
                self.settings(page)
                expect(page.get_by_role("button", name="Reload Flux", exact=True)).to_be_enabled()

                page.unroute(pattern, refused)
                me_pattern = re.compile(r"/api/v1/me$")
                def unavailable(route):
                    route.fulfill(status=503, content_type="application/json", body='{"message":"Session check temporarily unavailable"}')
                page.route(me_pattern, unavailable)
                origin = page.evaluate("performance.timeOrigin")
                page.get_by_role("button", name="Reload Flux", exact=True).click()
                expect(page.get_by_role("button", name="Check again", exact=True)).to_be_visible()
                expect(page.get_by_role("button", name="Reload Flux", exact=True)).to_be_disabled()
                self.assertEqual(page.evaluate("performance.timeOrigin"), origin)
                page.unroute(me_pattern, unavailable)
                page.get_by_role("button", name="Check again", exact=True).click()
                expect(page.get_by_role("button", name="Reload Flux", exact=True)).to_be_enabled()

    def test_15_sign_out_retires_the_live_visit_copy_for_the_next_account_in_this_tab(self):
        # A refused live save keeps Ari's visit copy only in this tab's memory (#326). Sign-out retires it
        # like the classic drafts, so Ben signing in next reaches none of it, and Ari signing in again
        # resumes no private copy: the page's next save is a fresh command, not the refused one.
        if not LIVE:
            self.skipTest("The shared working copy is the Wiki editor only when live editing is on")
        for engine in self.browsers:
            with self.subTest(engine=engine):
                page = self.page(engine)
                self.home(page)
                created = page.request.post(f"{ORIGIN}/api/v1/projects/{self.project_id}/docs",
                    headers={"origin": ORIGIN, "idempotency-key": str(uuid.uuid4())},
                    data={"title": f"Owned Wiki sign-out {engine}", "body": "Server baseline"})
                self.assertEqual(created.status, 201, created.text())
                doc = created.json()
                refused = []
                def refuse_save(route):
                    if route.request.method != "POST":
                        route.continue_(); return
                    refused.append(route.request.post_data_json)
                    route.fulfill(status=503, content_type="application/json", body='{"message":"Save temporarily unavailable"}')
                save_pattern = re.compile(rf"/api/v1/docs/{doc['id']}/live/save$")
                page.route(save_pattern, refuse_save)
                page.goto(f"/projects/{self.project_id}/docs/{doc['id']}")
                expect(page.locator('[data-live-status="live"]')).to_be_visible()
                private = f"Ari's refused private text {engine}"
                shared = page.locator('.cm-content[aria-label="Page text"]')
                self.assertEqual(page.evaluate(EXHAUST_STORAGE, 'session'), 'QuotaExceededError')
                shared.click(); page.keyboard.press("Control+a"); page.keyboard.insert_text(private)
                deadline = time.monotonic() + 20
                while not refused and time.monotonic() < deadline:
                    page.wait_for_timeout(200)
                self.assertTrue(refused, "the save was tried by itself and refused")
                refused_id = refused[0]["clientCommandId"]
                # Sign out from this tab without a document reload: the visit copy is retired. Signing out is a trip through Settings (#1419),
                # so the page is left first; saves stay refused until the sign-out is done, or leaving the page would store the text.
                sign_out(page)
                expect(page).to_have_url(re.compile("/sign-in"))
                page.unroute(save_pattern, refuse_save)
                self.assertEqual(page.evaluate("() => Object.keys(sessionStorage).filter((key) => key.startsWith('flux:wiki-live:')).length"), 0)
                # Ben signs in next in this tab: Ari's text is not on his screen and his session has no copy of it.
                ben = self.other_account(engine)
                page.get_by_label("Email").fill(ben)
                page.get_by_label("Password", exact=True).fill("a quiet route loading passphrase")
                page.get_by_role("button", name="Sign in", exact=True).click()
                expect(page.get_by_role("heading", name="Home", exact=True)).to_be_visible()
                self.assertNotIn(private, page.content())
                sign_out(page)
                expect(page).to_have_url(re.compile("/sign-in"))
                # Ari signs in again in the same tab: no private copy from the earlier session, and the next save is a fresh command.
                page.get_by_label("Email").fill(self.email)
                page.get_by_label("Password", exact=True).fill("a quiet route loading passphrase")
                page.get_by_role("button", name="Sign in", exact=True).click()
                expect(page.get_by_role("heading", name="Home", exact=True)).to_be_visible()
                # Through the router, not a document load: a load would clear this tab's visit copies anyway.
                page.locator(".app__side").get_by_role("link", name=re.compile("^Chunk boundaries(?:, new activity)?$")).click()
                page.get_by_role("navigation", name="Space views").get_by_role("tab", name="Wiki", exact=True).click()
                page.locator(".wiki-page").get_by_role("heading", level=2).get_by_role("button").click()
                page.get_by_role("dialog", name=re.compile("^Pages in")).get_by_role("link", name=doc["title"], exact=True).click()
                expect(page.locator('[data-live-status="live"]')).to_be_visible()
                expect(page.get_by_text("A private copy from an earlier session is available.", exact=True)).to_have_count(0)
                # The page's next save is a fresh command of this session, not the refused one resumed (the check the menu's sign-out had).
                with page.expect_response(lambda response: response.request.method == "POST" and response.url.endswith(f"/api/v1/docs/{doc['id']}/live/save"), timeout=30000) as saved:
                    shared.click(); page.keyboard.press("End"); page.keyboard.insert_text(f" · Ari again {engine}")
                self.assertEqual(saved.value.status, 200)
                self.assertNotEqual(saved.value.request.post_data_json["clientCommandId"], refused_id,
                    "a visit copy retired by sign-out must not resume the refused Save")
                # Sign-out revoked the shared session; the next engine starts from this fresh one (as test_14 does).
                type(self).state = page.context.storage_state()

    def other_account(self, engine: str) -> str:
        """A second account made in a throwaway context, for the next person in the same tab."""
        email = f"route.chunks.ben+{uuid.uuid4()}@example.test"
        context = self.browsers[engine].new_context(base_url=ORIGIN, service_workers="block")
        self.addCleanup(context.close)
        page = context.new_page()
        page.goto("/sign-up")
        page.get_by_label("Name").fill("Ben Route Chunks")
        page.get_by_label("Email").fill(email)
        page.get_by_label("Password").fill("a quiet route loading passphrase")
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", name="Home", exact=True)).to_be_visible()
        return email

    def test_01_cold_home_omits_secondary_and_closed_surface_imports(self):
        for engine in self.browsers:
            with self.subTest(engine=engine):
                page = self.page(engine)
                requested = []
                page.on("request", lambda request: requested.append(request.url))
                self.home(page)
                worker = page.request.get(f"{ORIGIN}/sw.js").text()
                for module in ("SettingsHome", "SketchView", "WikiEditor", "ProjectTasks", "Details", "JumpTo", "LiveStage"):
                    self.assertRegex(worker, rf"/assets/{module}-[^/\"]+\.js", f"{module} has an actual emitted lazy chunk")
                    self.assertFalse(any(re.search(rf"/assets/{module}-[^/]+\.js", url) for url in requested), f"Cold Home never imports {module}")

    def test_02_held_route_keeps_shell_editable_draft_and_cancellation(self):
        # The phone's conversation has no route to Settings (its account avatar is on Home, #341), so this journey starts
        # from the desktop conversation on both engines.
        for engine, phone in (("chromium", False), ("webkit", False)):
            with self.subTest(engine=engine, phone=phone):
                page = self.page(engine, phone=phone)
                held = self.hold(page, "SettingsHome")
                self.notes(page)
                field = page.get_by_label("Write a message", exact=True)
                field.fill("Private work while the destination downloads")
                page.evaluate("window.__routeDraftElement = document.querySelector('#project-composer')")
                before = self.layout(page)
                self.settings(page, phone=phone)
                self.assert_pending_is_still(page, before, page.locator('[data-route-pending="/settings"]'))
                expect(page.locator('[data-route-pending="/settings"] [role="status"]')).to_have_text("Opening settings…")
                self.request_is_held(page, held)
                # The destination's own loading state stands in the content area from the first frame (#863 rule 2); the old view is not shown, but it
                # is still mounted: the same element holds the draft, so a cancelled switch finds it as it was.
                expect(page.locator("#content [data-pending-view]")).to_be_visible()
                expect(page.get_by_label("Write a message", exact=True)).to_be_hidden()
                self.assertTrue(page.evaluate("window.__routeDraftElement === document.querySelector('#project-composer')"))
                expect(field).to_have_value("Private work while the destination downloads")
                shot(page, f"route-chunks-pending-{engine}-{'phone' if phone else 'desktop'}")
                page.get_by_role("button", name="Cancel", exact=True).click()
                expect(page.locator("[data-route-pending]")).to_have_count(0)
                expect(page.locator("#content [data-pending-view]")).to_have_count(0)
                expect(page).to_have_url(f"{ORIGIN}/projects/{self.project_id}")
                expect(page.get_by_label("Write a message", exact=True)).to_be_visible()
                expect(field).to_have_value("Private work while the destination downloads")
                field.fill("Private work remains editable")
                self.assertTrue(page.evaluate("window.__routeDraftElement === document.querySelector('#project-composer')"))
                held.pop().continue_()
                expect(field).to_have_value("Private work remains editable")
                # A newer completed navigation stays current even after the canceled code arrives.
                page.get_by_role("navigation", name="Main places" if phone else "Places").get_by_role("link", name=re.compile("^Inbox")).click()
                expect(page).to_have_url(f"{ORIGIN}/inbox")
                expect(page.get_by_role("heading", name="Settings", exact=True)).to_have_count(0)
                self.back_to_notes(page, phone=phone)
                expect(page.get_by_label("Write a message", exact=True)).to_have_value("Private work remains editable")

    def test_02b_phone_held_route_keeps_the_conversation_draft_and_cancellation(self):
        """The phone's own path to a lazy route (#341): a project conversation's views row opens Tasks while its code is
        held. The phone shell stays, the message draft stays the same editable element, and Cancel stays where it was."""
        page = self.page("webkit", phone=True)
        held = self.hold(page, "ProjectTasks")
        page.goto(f"/projects/{self.project_id}")
        field = page.get_by_label("Write a message", exact=True)
        expect(field).to_be_visible()
        start = page.url
        field.fill("Private work while the destination downloads")
        field.evaluate("el => { window.__routeDraftElement = el; }")
        before = self.layout(page)
        view_tab(page, "Tasks")
        pending = page.locator(f'[data-route-pending="/projects/{self.project_id}/tasks"]')
        self.assert_pending_is_still(page, before, pending)
        expect(pending.get_by_role("status")).to_have_text("Opening tasks…")
        self.request_is_held(page, held)
        # Tasks' own loading state stands in the content area; the conversation is not shown but is still mounted (#863 rule 2).
        expect(page.locator("#content [data-pending-view]")).to_be_visible()
        self.assertTrue(field.evaluate("el => window.__routeDraftElement === el"))
        expect(field).to_have_value("Private work while the destination downloads")
        shot(page, "route-chunks-pending-webkit-phone")
        pending.get_by_role("button", name="Cancel", exact=True).click()
        expect(page.locator("[data-route-pending]")).to_have_count(0)
        expect(page).to_have_url(start)
        expect(field).to_be_visible()
        field.fill("Private work remains editable")
        route = held.pop()
        with page.expect_response(lambda response: response.url == route.request.url) as late:
            route.continue_()
        late.value.finished()
        expect(page).to_have_url(start)
        expect(page.locator(".ws-task")).to_have_count(0)
        expect(field).to_have_value("Private work remains editable")
        self.assertTrue(field.evaluate("el => window.__routeDraftElement === el"))

    def test_02c_tablet_held_route_moves_nothing(self):
        """The same on a tablet, where the sidebar is a rail."""
        page = self.page("webkit", tablet=True)
        held = self.hold(page, "ProjectTasks")
        page.goto(f"/projects/{self.project_id}")
        expect(page.get_by_label("Write a message", exact=True)).to_be_visible()
        before = self.layout(page)
        view_tab(page, "Tasks")
        pending = page.locator(f'[data-route-pending="/projects/{self.project_id}/tasks"]')
        self.assert_pending_is_still(page, before, pending)
        shot(page, "route-chunks-pending-webkit-tablet")
        pending.get_by_role("button", name="Cancel", exact=True).click()
        expect(page.locator("[data-route-pending]")).to_have_count(0)
        self.assertEqual(self.layout(page), before)
        route = held.pop()
        with page.expect_response(lambda response: response.url == route.request.url) as late:
            route.continue_()
        late.value.finished()

    def test_03_failed_route_download_keeps_authenticated_shell_and_private_recovery(self):
        for engine in self.browsers:
            with self.subTest(engine=engine):
                page = self.page(engine)
                self.notes(page)
                page.get_by_label("Write a message", exact=True).fill(f"Private recovery after code failure {engine}")
                page.route(re.compile(r"/assets/SettingsHome-[^/]+\.js(?:\?.*)?$"), lambda route: route.abort("failed"))
                self.settings(page)
                expect(page.locator(".ui-error")).to_be_visible()
                expect(page.locator(".app__side")).to_be_visible()
                expect(page.get_by_role("link", name=re.compile(rf"{self.name}, Settings$"))).to_be_visible()
                expect(page.get_by_role("heading", name="Sign in")).to_have_count(0)
                shot(page, f"route-chunks-code-error-{engine}-desktop")
                page.get_by_role("link", name="Go to Home", exact=True).click()
                self.back_to_notes(page)
                expect(page.get_by_label("Write a message", exact=True)).to_have_value(f"Private recovery after code failure {engine}")

    def test_04_cold_deep_link_announces_destination_without_a_fabricated_shell(self):
        for engine in self.browsers:
            with self.subTest(engine=engine):
                page = self.page(engine)
                held = self.hold(page, "SettingsHome")
                page.goto("/settings", wait_until="commit")
                expect(page.locator(".booting")).to_contain_text("Opening settings…")
                self.request_is_held(page, held)
                expect(page.locator(".app")).to_have_count(0)
                held.pop().continue_()
                expect(page.get_by_role("heading", name="Settings", exact=True)).to_be_visible()
                expect(page.locator(".booting")).to_have_count(0)

    def test_05_held_search_close_never_reopens_or_steals_focus_after_resolution(self):
        for engine in self.browsers:
            with self.subTest(engine=engine):
                page = self.page(engine)
                held = self.hold(page, "JumpTo")
                self.notes(page)
                field = page.get_by_label("Write a message", exact=True)
                field.fill(f"Search download preserves focus {engine}")
                page.keyboard.press("Control+k")
                dialog = page.get_by_role("dialog", name="Search", exact=True)
                expect(dialog).to_contain_text("Opening search…")
                self.request_is_held(page, held)
                # The dialog is already its final size, not a spinner's 84 px: judged against the real dialog below (and in test_light_motion 04c).
                pending_height = dialog.bounding_box()["height"]
                shot(page, f"route-chunks-search-pending-{engine}-desktop")
                page.keyboard.press("Escape")
                expect(dialog).to_have_count(0)
                field.focus()
                with page.expect_response(re.compile(r"/assets/JumpTo-[^/]+\.js")):
                    held.pop().continue_()
                page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
                page.keyboard.press("End")
                expect(field).to_be_focused()
                expect(dialog).to_have_count(0)
                expect(field).to_have_value(f"Search download preserves focus {engine}")
                page.keyboard.press("Control+k")
                expect(dialog.get_by_role("combobox", name="Search", exact=True)).to_be_focused()
                self.assertAlmostEqual(dialog.bounding_box()["height"], pending_height, delta=2, msg="the held dialog was the size of the real one")
                page.keyboard.press("Escape")
                expect(field).to_be_focused()


    def test_06_cold_project_conversation_stays_eager(self):
        for engine in self.browsers:
            with self.subTest(engine=engine):
                page = self.page(engine)
                requested = []
                page.on("request", lambda request: requested.append(request.url))
                # This is what the conversation itself imports. The browser's idle fetch of the other views (rule 6, test_11) is a separate
                # behaviour that starts a second after the shell is up (at once in WebKit, which has no requestIdleCallback), and a slow
                # runner shows the first message after that: with the idle time never coming, the request list is the conversation's own.
                page.add_init_script("window.requestIdleCallback = () => 0;")
                page.goto(f"/projects/{self.project_id}/conversations/{self.conversation_id}")
                expect(page.get_by_role("heading", name="Chunk boundaries", exact=True)).to_be_visible()
                expect(page.get_by_label("Message from you", exact=True).get_by_text("An eager conversation stays available before secondary routes", exact=True)).to_be_visible()
                for module in ("ProjectTasks", "WikiEditor", "SketchView", "Details", "JumpTo", "LiveStage"):
                    self.assertFalse(any(re.search(rf"/assets/{module}-[^/]+\.js", url) for url in requested), f"The eager conversation does not import {module}")

    def test_07_held_details_close_returns_focus_and_resolution_never_reopens(self):
        for engine in self.browsers:
            with self.subTest(engine=engine):
                page = self.page(engine)
                held = self.hold(page, "Details")
                self.direct_message(page)
                opener = self.open_details_by_keyboard(page)
                # The panel's own layout in quiet bars, at its final heights, not a spinner (#863 rule 6).
                expect(page.locator("#details .wd-skeleton")).to_be_visible()
                expect(page.locator("#details .ui-spin")).to_have_count(0)
                self.request_is_held(page, held)
                shot(page, f"route-chunks-details-pending-{engine}-desktop")
                page.keyboard.press("Escape")
                expect(page.locator("#details")).to_have_count(0)
                expect(opener).to_be_focused()
                # Focus returned to the opener when the held panel closed; the code arriving later does not take it away.
                with page.expect_response(re.compile(r"/assets/Details-[^/]+\.js")):
                    held.pop().continue_()
                page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
                expect(opener).to_be_focused()
                expect(page.locator("#details")).to_have_count(0)
                self.open_details_by_keyboard(page)
                expect(page.locator("#details .details")).to_be_visible()
                page.keyboard.press("Escape")
                expect(opener).to_be_focused()


    def test_08_restored_network_really_recovers_the_failed_route(self):
        for engine in self.browsers:
            with self.subTest(engine=engine):
                page = self.page(engine)
                self.home(page)
                pattern = re.compile(r"/assets/SettingsHome-[^/]+\.js(?:\?.*)?$")
                refused = []
                assets = []
                page.on("requestfailed", lambda request: assets.append({"event": "failed", "url": request.url, "reason": request.failure}) if "/assets/" in request.url else None)
                page.on("response", lambda response: assets.append({"event": "response", "url": response.url, "status": response.status}) if "/assets/" in response.url else None)
                def refuse(route):
                    refused.append(route.request.url)
                    route.fulfill(status=503, content_type="application/javascript", headers={"cache-control": "no-store"}, body="// The code server is temporarily unavailable")
                page.route(pattern, refuse)
                self.settings(page)
                expect(page.locator(".ui-error")).to_be_visible()
                self.assertEqual(len(refused), 1)
                page.unroute(pattern, refuse)
                expect(page.get_by_role("button", name="Try again", exact=True)).to_have_count(0)
                before = page.evaluate("performance.timeOrigin")
                before_reload_assets = len(assets)
                try:
                    with page.expect_navigation(wait_until="domcontentloaded"):
                        page.get_by_role("button", name="Reload Flux", exact=True).click()
                    after = page.evaluate("performance.timeOrigin")
                    self.assertGreater(after, before, "A real new document must reset the failed module graph")
                    expect(page.get_by_role("heading", name="Appearance", exact=True)).to_be_visible()
                    expect(page.locator(".ui-error")).to_have_count(0)
                    self.assertTrue(any(item["event"] == "response" and item["url"] == refused[0] and item["status"] == 200 for item in assets[before_reload_assets:]), "The recovered document must fetch the actual formerly unavailable route chunk successfully")
                finally:
                    evidence = os.environ.get("FLUX_UI_SCREENSHOTS")
                    if evidence:
                        diagnostic = {"engine": engine, "beforeReloadAssetIndex": before_reload_assets, "beforeTimeOrigin": before, "afterTimeOrigin": page.evaluate("performance.timeOrigin"), "assets": assets,
                                      "errorText": page.locator(".ui-error").all_text_contents(), "settingsContent": page.get_by_role("heading", name="Appearance", exact=True).count()}
                        Path(evidence).mkdir(parents=True, exist_ok=True)
                        (Path(evidence) / f"route-code-reload-{engine}.json").write_text(json.dumps(diagnostic, indent=2))

    def test_09_first_message_info_keeps_readable_rows_before_any_map_download(self):
        for engine in self.browsers:
            with self.subTest(engine=engine):
                page = self.page(engine, phone=True)
                # The Map's code may be fetched in the background (a press brings the project's other views, #863), so it is held here:
                # the first Details render must not depend on it, and it has to stand with the Map's code still on the way.
                self.hold(page, "ProjectViews")
                self.hold(page, "SketchView")
                page.goto(f"/dm/{self.dm_id}")
                expect(page.get_by_role("heading", level=1, name="Jonas Route", exact=True)).to_be_visible()
                page.get_by_role("button", name="More", exact=True).click()
                page.get_by_role("menu", name="More").get_by_role("menuitem", name="People and privacy", exact=True).click()
                # The first People and privacy lists its people (a space has no panel of its own, #1419): a face and a name in separate columns inside the
                # phone panel. Missing lazy surface CSS must not collapse them.
                row = page.locator("#details .details__person", has_text="Jonas Route")
                expect(row).to_be_visible()
                geometry = row.evaluate("""el => {
                    const box = el.getBoundingClientRect();
                    const face = el.querySelector('.ui-avatar').getBoundingClientRect();
                    const name = el.querySelector('b').getBoundingClientRect();
                    return { left: box.left, right: box.right, faceRight: face.right, nameLeft: name.left, nameRight: name.right };
                }""")
                self.assertGreater(geometry["nameLeft"], geometry["faceRight"] - 0.001)
                self.assertLessEqual(geometry["nameRight"], geometry["right"] + 0.001)
                self.assertGreaterEqual(geometry["left"], 0)
                self.assertLessEqual(geometry["right"], page.viewport_size["width"])
                shot(page, f"route-chunks-first-message-info-{engine}-phone")

    CODE = {"Details": "Details", "JumpTo": "JumpTo", "ProjectTasks": "ProjectTasks", "ProjectViews": "ProjectViews", "Wiki": "Wiki"}

    def wait_for_chunks(self, page: Page, requested: list, seconds: float) -> list[str]:
        """The deferred code that has been asked for, waiting up to `seconds` for all of it."""
        deadline = time.monotonic() + seconds
        while True:
            got = [name for name in self.CODE if any(re.search(rf"/assets/{name}-[^/]+\.js", url) for url in requested)]
            if len(got) == len(self.CODE) or time.monotonic() > deadline:
                return got
            page.wait_for_timeout(50)

    def test_10_a_press_fetches_the_deferred_code_before_it_is_asked_for(self):
        """Rule 6: preload on pointer down. A press anywhere in a project brings the code of Details, Jump to… and the other views (#863)."""
        for engine in self.browsers:
            with self.subTest(engine=engine):
                page = self.page(engine)
                requested: list[str] = []
                page.on("request", lambda request: requested.append(request.url))
                page.goto(f"/projects/{self.project_id}")
                expect(page.get_by_role("heading", name="Chunk boundaries", exact=True)).to_be_visible()
                page.mouse.move(300, 400)
                page.mouse.down()
                page.mouse.up()
                got = self.wait_for_chunks(page, requested, 6)
                self.assertEqual(sorted(got), sorted(self.CODE), "a press brought all of it")

    def test_11_an_idle_page_fetches_the_deferred_code_without_any_input(self):
        """Rule 6: preload when idle. A person who only reads still finds the code here when a surface or a view is opened (#863)."""
        for engine in self.browsers:
            with self.subTest(engine=engine):
                page = self.page(engine)
                requested: list[str] = []
                page.on("request", lambda request: requested.append(request.url))
                page.goto(f"/projects/{self.project_id}")
                expect(page.get_by_role("heading", name="Chunk boundaries", exact=True)).to_be_visible()
                got = self.wait_for_chunks(page, requested, 8)
                self.assertEqual(sorted(got), sorted(self.CODE), "the browser's idle time brought all of it")
                # With the code here, the first ⌘K is one dialog with its content: no spinner, no placeholder that is replaced.
                page.keyboard.press("Control+k")
                dialog = page.get_by_role("dialog", name="Search", exact=True)
                expect(dialog.get_by_role("combobox", name="Search", exact=True)).to_be_visible()
                self.assertEqual(dialog.locator(".ui-spin, .jump-skeleton").count(), 0)


if __name__ == "__main__":
    unittest.main()
