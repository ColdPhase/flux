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

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

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

# Hold one genuine fresh-session HTTP response, preserving its AbortSignal. Release it only after
# a public MutationObserver witnesses the requested committed Home/sign-in view. No identity is made up.
HELD_SESSION_RESPONSE = """(() => {
  const fetch = window.fetch.bind(window);
  const probe = window.__reloadSession = {armed:false, held:false, settled:false, commitSeen:false, delivery:null};
  window.fetch = async (input, init = {}) => {
    const path = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
    if (path !== '/api/v1/me' || !probe.armed) return fetch(input, init);
    probe.armed = false;
    const signal = init.signal ?? (input instanceof Request ? input.signal : null);
    try {
      const response = await fetch(input, init), actual = await response.clone().json();
      probe.status = response.status; probe.actual = {owner: actual.user?.id, session: actual.session?.id}; probe.held = true;
      await new Promise((resolve, reject) => {
        let done = false;
        const finish = action => { if (done) return; done = true; signal?.removeEventListener('abort', abort); action(); };
        const abort = () => finish(() => reject(signal.reason ?? new DOMException('Aborted','AbortError')));
        probe.release = () => finish(resolve);
        if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, {once:true});
      });
      probe.delivery = 'delivered'; return response;
    } catch (error) { probe.delivery = error.name === 'AbortError' ? 'aborted' : 'failed'; throw error; }
    finally { probe.settled = true; }
  };
  probe.afterCommit = heading => {
    const observer = new MutationObserver(() => {
      if (![...document.querySelectorAll('h1')].some(el => el.textContent.trim() === heading)) return;
      probe.commitSeen = true; observer.disconnect(); probe.release();
    });
    observer.observe(document, {childList:true,subtree:true});
  };
})();"""


class RouteChunksJourney(unittest.TestCase):
    pw = None
    browsers: dict[str, Browser] = {}
    state: dict = {}
    name = "Ari Route Chunks"
    project_id = ""
    conversation_id = ""

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
            page.get_by_label("Email").fill(f"route.chunks+{uuid.uuid4()}@example.test")
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
            cls.state = context.storage_state()
        finally:
            context.close()

    @classmethod
    def tearDownClass(cls):
        for browser in cls.browsers.values():
            browser.close()
        cls.pw.stop()

    def page(self, engine: str, *, phone=False) -> Page:
        context: BrowserContext = self.browsers[engine].new_context(
            base_url=ORIGIN, storage_state=self.state, service_workers="block", reduced_motion="reduce",
            viewport=PHONE if phone else DESKTOP, is_mobile=phone, has_touch=phone,
        )
        self.addCleanup(context.close)
        page = context.new_page()
        errors = []
        # WebKit reports a background read that the page abandons during a reload as an access-control
        # failure; the application already catches it (WorkingAgent), so only that exact case is ignored.
        page.on("pageerror", lambda error: None if re.search(r"/api/v1/assistant-runs\?limit=10 due to access control checks", str(error)) else errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "No uncaught application errors"))
        return page

    def home(self, page: Page):
        page.goto("/")
        expect(page.get_by_role("heading", name="Home", exact=True)).to_be_visible()
        expect(page.get_by_placeholder("Write a note…")).to_be_visible()

    def settings(self, page: Page, *, phone=False):
        if phone:
            page.get_by_role("button", name="Open navigation").click()
            page.get_by_role("link", name=re.compile(self.name)).click()
        else:
            page.get_by_role("button", name=re.compile(self.name)).click()
            page.get_by_role("link", name="All settings", exact=True).click()

    def open_details_by_keyboard(self, page: Page):
        opener = page.get_by_role("button", name="Details", exact=True)
        for _ in range(50):
            if opener.evaluate("element => element === document.activeElement"):
                break
            page.keyboard.press("Tab")
        expect(opener).to_be_focused()
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
                route.abort("aborted")
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

    def refused_home_draft(self, page: Page, engine: str):
        self.home(page)
        response = page.request.get(f"{ORIGIN}/api/v1/me")
        self.assertEqual(response.status, 200)
        key = f"flux:draft:{response.json()['user']['id']}:home"
        earlier = f"Earlier device draft A {engine}"
        latest = f"Latest visit-only draft B {engine}: " + "Keep the newest private garden notes. " * 40
        field = page.get_by_placeholder("Write a note…")
        field.fill(earlier)
        page.wait_for_function("([key,text]) => localStorage.getItem(key) === text", arg=[key, earlier])
        self.assertEqual(page.evaluate(EXHAUST_STORAGE, 'local'), 'QuotaExceededError')
        field.fill(latest)
        expect(page.get_by_text("Draft kept until you close this tab", exact=True)).to_be_visible()
        self.assertEqual(page.evaluate("key => localStorage.getItem(key)", key), earlier)
        return key, earlier, latest

    def test_10_refused_latest_home_draft_blocks_destructive_reload_then_recovers(self):
        for engine in self.browsers:
            with self.subTest(engine=engine):
                page = self.page(engine)
                key, earlier, latest = self.refused_home_draft(page, engine)
                pattern = re.compile(r"/assets/SettingsHome-[^/]+\.js(?:\?.*)?$")
                def refused(route):
                    route.fulfill(status=503, headers={"cache-control": "no-store"}, content_type="text/plain", body="Real refused route delivery")
                page.route(pattern, refused)
                self.settings(page)
                expect(page.get_by_role("heading", name="This page couldn’t be loaded", exact=True)).to_be_visible()
                page.unroute(pattern, refused)
                reload = page.get_by_role("button", name="Reload Flux", exact=True)
                origin = page.evaluate("performance.timeOrigin")
                if reload.is_enabled():
                    # Old-source control follows the real unsafe action and observes its actual loss.
                    with page.expect_navigation(wait_until="domcontentloaded"):
                        reload.click()
                    self.home(page)
                    self.assertEqual(page.get_by_placeholder("Write a note…").input_value(), latest,
                        "unguarded document reload must not restore the older stored A over the latest visit-only B")
                    self.fail("visit-only work must make automatic code-error Reload unavailable")
                expect(reload).to_be_disabled()
                expect(page.get_by_text("Keep this tab open", exact=False)).to_be_visible()
                page.get_by_role("link", name="Go to Home", exact=True).click()
                expect(page.get_by_placeholder("Write a note…")).to_have_value(latest)
                self.assertEqual(page.evaluate("performance.timeOrigin"), origin)
                self.assertEqual(page.evaluate("key => localStorage.getItem(key)", key), earlier)
                page.evaluate("localStorage.removeItem('quota-route-recovery')")
                persisted = latest + "Storage accepts the newest copy again."
                page.get_by_placeholder("Write a note…").fill(persisted)
                page.wait_for_function("([key,text]) => localStorage.getItem(key) === text", arg=[key, persisted])
                self.settings(page)
                expect(page.get_by_role("heading", name="This page couldn’t be loaded", exact=True)).to_be_visible()
                expect(page.get_by_role("button", name="Reload Flux", exact=True)).to_be_enabled()
                with page.expect_navigation(wait_until="domcontentloaded"):
                    page.get_by_role("button", name="Reload Flux", exact=True).click()
                self.assertGreater(page.evaluate("performance.timeOrigin"), origin)
                expect(page.get_by_role("heading", name="This device", exact=True)).to_be_visible()
                self.home(page)
                expect(page.get_by_placeholder("Write a note…")).to_have_value(persisted)

    def test_11_failed_optional_surface_keeps_refused_draft_and_close_recovery(self):
        for engine in self.browsers:
            with self.subTest(engine=engine):
                page = self.page(engine)
                key, earlier, latest = self.refused_home_draft(page, engine)
                pattern = re.compile(r"/assets/JumpTo-[^/]+\.js(?:\?.*)?$")
                def refused(route):
                    route.fulfill(status=503, headers={"cache-control": "no-store"}, content_type="text/plain", body="Real refused search delivery")
                page.route(pattern, refused)
                page.keyboard.press("Control+k")
                dialog = page.get_by_role("dialog", name="Jump to", exact=True)
                expect(dialog).to_contain_text("Search couldn’t be loaded")
                page.unroute(pattern, refused)
                expect(dialog.get_by_role("button", name="Reload Flux", exact=True)).to_be_disabled()
                expect(dialog.get_by_text("Keep this tab open", exact=False)).to_be_visible()
                page.keyboard.press("Escape")
                expect(dialog).to_have_count(0)
                expect(page.get_by_placeholder("Write a note…")).to_have_value(latest)
                self.assertEqual(page.evaluate("key => localStorage.getItem(key)", key), earlier)

    def test_12_wiki_quota_copy_preserves_fields_base_and_attempt_before_reload(self):
        for engine in self.browsers:
            with self.subTest(engine=engine):
                page = self.page(engine)
                self.home(page)
                created = page.request.post(f"{ORIGIN}/api/v1/projects/{self.project_id}/docs",
                    headers={"origin": ORIGIN, "idempotency-key": str(uuid.uuid4())},
                    data={"title": f"Owned Wiki recovery {engine}", "body": "Server baseline", "state": "draft"})
                self.assertEqual(created.status, 201, created.text())
                doc = created.json()
                me = page.request.get(f"{ORIGIN}/api/v1/me").json()
                key = f"flux:doc-edit:{me['user']['id']}:{doc['id']}"
                page.goto(f"/projects/{self.project_id}/docs/{doc['id']}/edit")
                field = page.get_by_label("Text (Markdown)", exact=True)
                earlier = f"Earlier Wiki A {engine}"
                latest = f"Latest Wiki B {engine}: " + "Retain the complete private edit and its save identity. " * 35
                field.fill(earlier)
                page.wait_for_function("([key,text]) => JSON.parse(sessionStorage.getItem(key) ?? '{}').body === text", arg=[key, earlier])
                before = page.evaluate("key => JSON.parse(sessionStorage.getItem(key))", key)
                self.assertEqual(page.evaluate(EXHAUST_STORAGE, 'session'), 'QuotaExceededError')
                field.fill(latest)
                self.assertEqual(page.evaluate("key => JSON.parse(sessionStorage.getItem(key)).body", key), earlier)
                attempted = []
                api_pattern = re.compile(rf"/api/v1/docs/{doc['id']}$")
                def failed_save(route):
                    if route.request.method != 'PATCH':
                        route.continue_(); return
                    attempted.append({"body": route.request.post_data_json, "key": route.request.headers.get("idempotency-key"),
                        "base": route.request.headers.get("if-match")})
                    route.fulfill(status=503, content_type="application/json", body='{"message":"Save temporarily unavailable"}')
                page.route(api_pattern, failed_save)
                page.get_by_role("button", name="Save version", exact=True).click()
                expect(page.locator(".doc-error")).to_be_visible()
                self.assertEqual(len(attempted), 1)
                self.assertEqual(attempted[0]["body"]["body"], latest)
                self.assertNotEqual(attempted[0]["key"], before["attempt"])
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
                page.get_by_role("navigation", name="Project views").get_by_role("link", name="Wiki", exact=True).click()
                page.get_by_role("link", name=re.compile(rf"^{re.escape(doc['title'])}(?:\s*Draft)?$")).click()
                page.locator(".wiki-bar").get_by_role("link", name="Edit", exact=True).click()
                expect(page.get_by_label("Text (Markdown)", exact=True)).to_have_value(latest)
                page.evaluate("sessionStorage.removeItem('quota-route-recovery')")
                page.get_by_role("button", name="Save version", exact=True).click()
                expect(page.locator(".doc-error")).to_be_visible()
                self.assertEqual(len(attempted), 2)
                self.assertEqual(attempted[1], attempted[0], "B's exact body/base/save identity survives code recovery")
                page.unroute(api_pattern, failed_save)
                delivered = []
                page.on("request", lambda request: delivered.append({"body": request.post_data_json,
                    "key": request.headers.get("idempotency-key"), "base": request.headers.get("if-match")})
                    if request.method == 'PATCH' and request.url.endswith(f"/api/v1/docs/{doc['id']}") else None)
                with page.expect_response(lambda response: response.request.method == 'PATCH' and response.url.endswith(f"/api/v1/docs/{doc['id']}")) as saved:
                    page.get_by_role("button", name="Save version", exact=True).click()
                self.assertEqual(saved.value.status, 200)
                self.assertEqual(delivered, [attempted[0]])
                current = page.request.get(f"{ORIGIN}/api/v1/docs/{doc['id']}").json()
                self.assertEqual(current["body"], latest)
                self.assertEqual(current["version"], before["base"] + 1)

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

    def test_14_held_real_reload_check_cannot_cross_committed_home_or_device_retirement(self):
        for engine in self.browsers:
            for retiring in (False, True):
                with self.subTest(engine=engine, retiring=retiring):
                    page = self.page(engine)
                    page.add_init_script(HELD_SESSION_RESPONSE)
                    self.home(page)
                    me = page.request.get(f"{ORIGIN}/api/v1/me").json()
                    durable = f"Durable same-account work before held reload {engine}"
                    page.get_by_placeholder("Write a note…").fill(durable)
                    page.wait_for_function("([id,text]) => localStorage.getItem(`flux:draft:${id}:home`) === text", arg=[me["user"]["id"], durable])
                    pattern = re.compile(r"/assets/SettingsHome-[^/]+\.js(?:\?.*)?$")
                    def refused(route):
                        route.fulfill(status=503, headers={"cache-control":"no-store"}, body="Real refused route")
                    page.route(pattern, refused)
                    self.settings(page)
                    expect(page.get_by_role("button", name="Reload Flux", exact=True)).to_be_enabled()
                    page.unroute(pattern, refused)
                    origin = page.evaluate("performance.timeOrigin")
                    page.evaluate("window.__reloadSession.armed = true")
                    page.get_by_role("button", name="Reload Flux", exact=True).click()
                    page.wait_for_function("window.__reloadSession.held")
                    actual = page.evaluate("window.__reloadSession.actual")
                    self.assertEqual(actual, {"owner":me["user"]["id"], "session":me["session"]["id"]})
                    self.assertEqual(page.evaluate("window.__reloadSession.status"), 200)
                    if retiring:
                        page.evaluate("window.__reloadSession.afterCommit('Sign in to Flux')")
                        page.get_by_role("button", name=re.compile(self.name)).click()
                        page.get_by_role("button", name="Sign out", exact=True).click()
                        expect(page.get_by_role("heading", name="Sign in to Flux", exact=True)).to_be_visible()
                        self.assertEqual(page.request.get(f"{ORIGIN}/api/v1/me").status, 401)
                    else:
                        page.evaluate("window.__reloadSession.afterCommit('Home')")
                        page.get_by_role("link", name="Go to Home", exact=True).click()
                        expect(page.get_by_placeholder("Write a note…")).to_have_value(durable)
                    page.wait_for_function("window.__reloadSession.commitSeen && window.__reloadSession.settled")
                    page.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
                    self.assertEqual(page.evaluate("performance.timeOrigin"), origin, "old checked response cannot reload a different committed lifetime")
                    self.assertIn(page.evaluate("window.__reloadSession.delivery"), ('delivered','aborted'))
                    if retiring:
                        page.get_by_label("Email").fill(me["user"]["email"])
                        page.get_by_label("Password", exact=True).fill("a quiet route loading passphrase")
                        page.get_by_role("button", name="Sign in", exact=True).click()
                        expect(page.get_by_role("heading", name="Home", exact=True)).to_be_visible()
                        restored = page.request.get(f"{ORIGIN}/api/v1/me").json()
                        self.assertEqual(restored["user"]["id"], me["user"]["id"])
                        self.assertNotEqual(restored["session"]["id"], me["session"]["id"])
                        type(self).state = page.context.storage_state()


    def test_01_cold_home_omits_secondary_and_closed_surface_imports(self):
        for engine in self.browsers:
            with self.subTest(engine=engine):
                page = self.page(engine)
                requested = []
                page.on("request", lambda request: requested.append(request.url))
                self.home(page)
                worker = page.request.get(f"{ORIGIN}/sw.js").text()
                for module in ("SettingsHome", "SketchView", "DocEditor", "ProjectTasks", "ProjectAgents", "Details", "JumpTo", "LiveStage"):
                    self.assertRegex(worker, rf"/assets/{module}-[^/\"]+\.js", f"{module} has an actual emitted lazy chunk")
                    self.assertFalse(any(re.search(rf"/assets/{module}-[^/]+\.js", url) for url in requested), f"Cold Home never imports {module}")

    def test_02_held_route_keeps_shell_editable_draft_and_cancellation(self):
        for engine, phone in (("chromium", False), ("webkit", True)):
            with self.subTest(engine=engine, phone=phone):
                page = self.page(engine, phone=phone)
                held = self.hold(page, "SettingsHome")
                self.home(page)
                field = page.get_by_placeholder("Write a note…")
                field.fill("Private work while the destination downloads")
                page.evaluate("window.__routeDraftElement = document.querySelector('#composer')")
                self.settings(page, phone=phone)
                expect(page.locator('[data-route-pending="/settings"]')).to_be_visible()
                expect(page.locator('[data-route-pending="/settings"] [role="status"]')).to_have_text("Opening settings…")
                self.request_is_held(page, held)
                expect(page.get_by_role("heading", name="Home", exact=True)).to_be_visible()
                expect(field).to_have_value("Private work while the destination downloads")
                field.fill("Private work remains editable")
                self.assertTrue(page.evaluate("window.__routeDraftElement === document.querySelector('#composer')"))
                shot(page, f"route-chunks-pending-{engine}-{'phone' if phone else 'desktop'}")
                page.get_by_role("button", name="Cancel", exact=True).click()
                expect(page.locator("[data-route-pending]")).to_have_count(0)
                expect(page).to_have_url(f"{ORIGIN}/")
                held.pop().continue_()
                expect(field).to_have_value("Private work remains editable")
                # A newer completed navigation stays current even after the canceled code arrives.
                page.get_by_role("link", name="Map", exact=True).click()
                expect(page).to_have_url(f"{ORIGIN}/map")
                expect(page.get_by_role("heading", name="Settings", exact=True)).to_have_count(0)
                page.get_by_role("link", name="Conversation", exact=True).click()
                expect(page.get_by_placeholder("Write a note…")).to_have_value("Private work remains editable")

    def test_03_failed_route_download_keeps_authenticated_shell_and_private_recovery(self):
        for engine in self.browsers:
            with self.subTest(engine=engine):
                page = self.page(engine)
                self.home(page)
                page.get_by_placeholder("Write a note…").fill(f"Private recovery after code failure {engine}")
                page.route(re.compile(r"/assets/SettingsHome-[^/]+\.js(?:\?.*)?$"), lambda route: route.abort("failed"))
                self.settings(page)
                expect(page.locator(".ui-error")).to_be_visible()
                expect(page.locator(".app__side")).to_be_visible()
                expect(page.get_by_role("button", name=re.compile(self.name))).to_be_visible()
                expect(page.get_by_role("heading", name="Sign in to Flux")).to_have_count(0)
                shot(page, f"route-chunks-code-error-{engine}-desktop")
                page.get_by_role("link", name="Go to Home", exact=True).click()
                expect(page.get_by_placeholder("Write a note…")).to_have_value(f"Private recovery after code failure {engine}")

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
                self.home(page)
                field = page.get_by_placeholder("Write a note…")
                field.fill(f"Search download preserves focus {engine}")
                page.keyboard.press("Control+k")
                dialog = page.get_by_role("dialog", name="Jump to")
                expect(dialog).to_contain_text("Opening search…")
                self.request_is_held(page, held)
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
                expect(dialog.get_by_role("combobox", name="Jump to")).to_be_focused()
                page.keyboard.press("Escape")
                expect(field).to_be_focused()


    def test_06_cold_project_conversation_stays_eager(self):
        for engine in self.browsers:
            with self.subTest(engine=engine):
                page = self.page(engine)
                requested = []
                page.on("request", lambda request: requested.append(request.url))
                page.goto(f"/projects/{self.project_id}/conversations/{self.conversation_id}")
                expect(page.get_by_role("heading", name="Chunk boundaries", exact=True)).to_be_visible()
                expect(page.get_by_label("Message from you", exact=True).get_by_text("An eager conversation stays available before secondary routes", exact=True)).to_be_visible()
                for module in ("ProjectTasks", "ProjectAgents", "DocEditor", "SketchView", "Details", "JumpTo", "LiveStage"):
                    self.assertFalse(any(re.search(rf"/assets/{module}-[^/]+\.js", url) for url in requested), f"The eager conversation does not import {module}")

    def test_07_held_details_close_returns_focus_and_resolution_never_reopens(self):
        for engine in self.browsers:
            with self.subTest(engine=engine):
                page = self.page(engine)
                held = self.hold(page, "Details")
                self.home(page)
                opener = self.open_details_by_keyboard(page)
                expect(page.locator("#details")).to_contain_text("Opening details…")
                self.request_is_held(page, held)
                shot(page, f"route-chunks-details-pending-{engine}-desktop")
                page.keyboard.press("Escape")
                expect(page.locator("#details")).to_have_count(0)
                expect(opener).to_be_focused()
                field = page.get_by_placeholder("Write a note…")
                field.fill(f"Closed Details never steals focus {engine}")
                with page.expect_response(re.compile(r"/assets/Details-[^/]+\.js")):
                    held.pop().continue_()
                page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
                expect(field).to_be_focused()
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
                    expect(page.get_by_role("heading", name="This device", exact=True)).to_be_visible()
                    expect(page.locator(".ui-error")).to_have_count(0)
                    self.assertTrue(any(item["event"] == "response" and item["url"] == refused[0] and item["status"] == 200 for item in assets[before_reload_assets:]), "The recovered document must fetch the actual formerly unavailable route chunk successfully")
                finally:
                    evidence = os.environ.get("FLUX_UI_SCREENSHOTS")
                    if evidence:
                        diagnostic = {"engine": engine, "beforeReloadAssetIndex": before_reload_assets, "beforeTimeOrigin": before, "afterTimeOrigin": page.evaluate("performance.timeOrigin"), "assets": assets,
                                      "errorText": page.locator(".ui-error").all_text_contents(), "settingsContent": page.get_by_role("heading", name="This device", exact=True).count()}
                        Path(evidence).mkdir(parents=True, exist_ok=True)
                        (Path(evidence) / f"route-code-reload-{engine}.json").write_text(json.dumps(diagnostic, indent=2))

    def test_09_first_project_details_keep_readable_rows_before_any_map_download(self):
        for engine in self.browsers:
            with self.subTest(engine=engine):
                page = self.page(engine, phone=True)
                title = f"Check the first project overview before opening Map {engine}"
                response = page.request.post(f"{ORIGIN}/api/v1/projects/{self.project_id}/work",
                    headers={"origin": ORIGIN, "content-type": "application/json"}, data=json.dumps({"title": title}))
                self.assertEqual(response.status, 201, response.text())
                requested = []
                page.on("request", lambda request: requested.append(request.url))
                page.goto(f"/projects/{self.project_id}")
                expect(page.get_by_role("heading", name="Chunk boundaries", exact=True)).to_be_visible()
                page.get_by_role("button", name="Details", exact=True).click()
                row = page.locator("#details .ov-row", has_text=title)
                expect(row).to_be_visible()
                # A first-open native row must keep its icon, readable text and action in separate
                # columns inside the phone panel. Missing lazy surface CSS must not collapse them.
                geometry = row.evaluate("""el => {
                    const box = el.getBoundingClientRect();
                    const icon = el.querySelector('.ov-row__ic').getBoundingClientRect();
                    const body = el.querySelector('.ov-row__b').getBoundingClientRect();
                    const action = el.querySelector('.ov-row__go').getBoundingClientRect();
                    return { height: box.height, left: box.left, right: box.right,
                        iconRight: icon.right, textLeft: body.left, textRight: body.right, actionLeft: action.left };
                }""")
                self.assertGreaterEqual(geometry["height"], 44 - 0.001)
                self.assertGreater(geometry["textLeft"], geometry["iconRight"])
                self.assertLess(geometry["textRight"], geometry["actionLeft"])
                self.assertGreaterEqual(geometry["left"], 0)
                self.assertLessEqual(geometry["right"], page.viewport_size["width"])
                self.assertFalse(any(re.search(r"/assets/(?:ProjectViews|SketchView)-[^/]+\.js", url) for url in requested),
                                 "The first project/Details render never depends on Map code")
                shot(page, f"route-chunks-first-project-details-{engine}-phone")


if __name__ == "__main__":
    unittest.main()
