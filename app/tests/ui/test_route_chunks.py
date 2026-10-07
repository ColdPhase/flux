"""Real browser download boundaries for #326; service-worker installation is tested separately.

Cold contexts block service workers here so their intentional precache downloads cannot be mistaken
for document imports. Inputs/navigation are trusted; held/failed actual compiled asset requests
exercise the production router and modal owners, without substituting route components or loaders.
"""
from __future__ import annotations

import json
import re
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, Route, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder


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
        page.on("pageerror", lambda error: errors.append(str(error)))
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

    def hold(self, page: Page, module: str):
        held: list[Route] = []
        page.route(re.compile(rf"/assets/{module}-[^/]+\.js(?:\?.*)?$"), lambda route: held.append(route))
        # A retained Route is released by the test, so the browser remains responsive to other input.
        return held

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
                self.assertEqual(len(held), 1, "The actual destination code download is held")
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
                page.get_by_role("link", name="Go to Home", exact=True).click()
                expect(page.get_by_placeholder("Write a note…")).to_have_value(f"Private recovery after code failure {engine}")

    def test_04_cold_deep_link_announces_destination_without_a_fabricated_shell(self):
        for engine in self.browsers:
            with self.subTest(engine=engine):
                page = self.page(engine)
                held = self.hold(page, "SettingsHome")
                page.goto("/settings", wait_until="commit")
                expect(page.locator(".booting")).to_contain_text("Opening settings…")
                self.assertEqual(len(held), 1)
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
                self.assertEqual(len(held), 1)
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
                opener = page.get_by_role("button", name="Details", exact=True)
                opener.click()
                expect(page.locator("#details")).to_contain_text("Opening details…")
                self.assertEqual(len(held), 1)
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
                opener.click()
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
                def refuse(route):
                    refused.append(route.request.url)
                    route.abort("failed")
                page.route(pattern, refuse)
                self.settings(page)
                expect(page.locator(".ui-error")).to_be_visible()
                self.assertEqual(len(refused), 1)
                page.unroute(pattern, refuse)
                expect(page.get_by_role("button", name="Try again", exact=True)).to_have_count(0)
                page.get_by_role("button", name="Reload Flux", exact=True).click()
                expect(page.get_by_role("heading", name="Settings", exact=True)).to_be_visible()
                expect(page.locator(".ui-error")).to_have_count(0)


if __name__ == "__main__":
    unittest.main()
