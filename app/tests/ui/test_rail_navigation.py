"""#340/#357: the folded rail preserves real places, conversations and current account.

Actual authenticated routes/data and the existing sign-out form, Chromium/WebKit. No
fabricated navigation records or identity responses. Also checks enough real projects/DMs
to keep the working Stop and account reachable rather than certifying an empty rail.
"""
from __future__ import annotations

import re
import unittest
import uuid

from playwright.sync_api import Page, expect, sync_playwright

from test_app_shell import ORIGIN, UPSTREAM, shot, start_forwarder
from test_personal_assistant import mock
from touch_targets import has_minimum_touch_size

PASSWORD = "a complete calm rail"


class RailNavigation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browsers = {name: getattr(cls.pw, name).launch() for name in ("chromium", "webkit")}
        expect.set_options(timeout=10000)

    @classmethod
    def tearDownClass(cls):
        for browser in cls.browsers.values():
            browser.close()
        cls.pw.stop()

    def api(self, page: Page, method: str, path: str, body=None, status=200):
        response = page.request.fetch(path, method=method, headers={"origin": ORIGIN}, data=body)
        self.assertEqual(response.status, status, f"{path}: {response.status} {response.text()}")
        return response.json() if response.text() else None

    def setup_owner(self, engine, *, coarse=False, many=False):
        context = self.browsers[engine].new_context(base_url=ORIGIN, viewport={"width": 1280 if coarse else 1440, "height": 800 if coarse else 900},
            color_scheme="dark" if coarse else "light", has_touch=coarse, service_workers="block")
        self.addCleanup(context.close)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, []))
        email = f"ada.rail+{uuid.uuid4().hex}@example.test"
        self.api(page, "POST", "/api/auth/sign-up/email", {"name": "Ada Kowalska", "email": email, "password": PASSWORD})
        identity = self.api(page, "GET", "/api/v1/me")
        space = self.api(page, "POST", "/api/v1/workspaces", {"name": "Riverside makers"}, 201)
        projects = []
        for index in range(18 if many else 2):
            projects.append(self.api(page, "POST", f"/api/v1/workspaces/{space['id']}/projects", {
                "name": f"Garden sensor trial {index + 1}", "visibility": "restricted"}, 201))
        peer_context = self.browsers[engine].new_context(base_url=ORIGIN)
        self.addCleanup(peer_context.close)
        peer = peer_context.new_page()
        peer_email = f"jonas.rail+{uuid.uuid4().hex}@example.test"
        self.api(peer, "POST", "/api/auth/sign-up/email", {"name": "Jonas Berg", "email": peer_email, "password": PASSWORD})
        peer_id = self.api(peer, "GET", "/api/v1/me")["user"]["id"]
        self.api(page, "POST", f"/api/v1/workspaces/{space['id']}/members", {"email": peer_email, "role": "member"}, 201)
        dm = self.api(page, "POST", f"/api/v1/workspaces/{space['id']}/dms", {"participantIds": [peer_id]}, 201)
        self.api(peer, "POST", f"/api/v1/dms/{dm['id']}/messages", {"body": "Bring the ToF boards for Friday’s dark-room test.", "clientMessageId": str(uuid.uuid4())}, 201)
        page.goto("/")
        expect(page.get_by_role("heading", name="Home", exact=True)).to_be_visible()
        page.get_by_role("button", name="Collapse sidebar").click()
        expect(page.locator(".side--rail")).to_be_visible()
        return page, {"email": email, "user": identity["user"]["id"], "workspace": space["id"], "dm": dm["id"], "projects": projects}

    def assert_native_target(self, page, locator, coarse):
        self.assertEqual(locator.evaluate("el => ['A','BUTTON'].includes(el.tagName)"), True)
        locator.focus()
        expect(locator).to_be_focused()
        page.keyboard.press("Tab")
        page.keyboard.press("Shift+Tab")
        expect(locator).to_be_focused()
        self.assertTrue(locator.evaluate("el => el.matches(':focus-visible') && parseFloat(getComputedStyle(el).outlineWidth)>=2"))
        if coarse:
            rect = locator.bounding_box()
            self.assertTrue(has_minimum_touch_size(rect["width"]) and has_minimum_touch_size(rect["height"]), str(rect))

    def test_01_sketchbook_and_settings_keep_native_routes_in_the_rail(self):
        for engine in self.browsers:
            for coarse in (False, True):
                with self.subTest(engine=engine, coarse=coarse):
                    page, ids = self.setup_owner(engine, coarse=coarse)
                    rail = page.locator(".side--rail")
                    sketchbook = rail.get_by_role("link", name="Sketchbook", exact=True)
                    self.assertEqual(sketchbook.count(), 1, "the rail must preserve Sketchbook")
                    self.assert_native_target(page, sketchbook, coarse)
                    sketchbook.press("Enter")
                    expect(page).to_have_url(re.compile(r"/map$"))
                    expect(sketchbook).to_have_attribute("aria-current", "page")
                    settings = rail.get_by_role("link", name="Settings", exact=True)
                    self.assertEqual(settings.count(), 1, "the rail must preserve Settings")
                    self.assert_native_target(page, settings, coarse)
                    settings.press("Enter")
                    expect(page).to_have_url(re.compile(r"/settings$"))
                    expect(page.get_by_role("heading", name="Settings", exact=True)).to_be_visible()
                    self.assertAlmostEqual(page.get_by_role("complementary", name="Sidebar").bounding_box()["width"], 64, delta=.001)
                    shot(page, f"340-rail-navigation-{engine}-{'dark-coarse' if coarse else 'light'}")

    def test_02_current_account_signs_out_from_the_compact_existing_form(self):
        for engine in self.browsers:
            with self.subTest(engine=engine):
                page, ids = self.setup_owner(engine, coarse=True)
                rail = page.locator(".side--rail")
                account = rail.get_by_role("button", name=re.compile("Ada Kowalska.*account and sign out"))
                self.assertEqual(account.count(), 1, "the rail must identify the current account")
                expect(account.locator(".ui-avatar")).to_have_text("AK")
                self.assert_native_target(page, account, True)
                account.press("Enter")
                popup = page.get_by_role("dialog", name="Account", exact=True)
                expect(popup).to_be_visible()
                expect(popup).to_contain_text(ids["email"])
                rect = popup.bounding_box()
                self.assertGreaterEqual(rect["x"], 0)
                self.assertLessEqual(rect["x"] + rect["width"], page.viewport_size["width"])
                page.keyboard.press("Escape")
                expect(popup).to_have_count(0)
                expect(account).to_be_focused()
                account.press("Enter")
                popup.get_by_role("button", name="Sign out", exact=True).click()
                expect(page.get_by_role("heading", name="Sign in to Flux", exact=True)).to_be_visible()
                self.api(page, "GET", "/api/v1/me", status=401)
                page.get_by_label("Email").fill(ids["email"])
                page.get_by_label("Password", exact=True).fill(PASSWORD)
                page.get_by_role("button", name="Sign in", exact=True).click()
                expect(page.get_by_role("heading", name="Home", exact=True)).to_be_visible()
                self.assertEqual(self.api(page, "GET", "/api/v1/me")["user"]["id"], ids["user"])
                expect(page.locator(".side--rail").get_by_role("button", name=re.compile("Ada Kowalska.*account and sign out"))).to_be_visible()

    def test_03_real_messages_and_many_projects_do_not_remove_account_access(self):
        for engine in self.browsers:
            with self.subTest(engine=engine):
                page, ids = self.setup_owner(engine, coarse=True, many=True)
                rail = page.locator(".side--rail")
                messages = rail.get_by_role("link", name="Messages", exact=True)
                self.assertEqual(messages.count(), 1, "the rail must preserve its real Messages place")
                self.assert_native_target(page, messages, True)
                messages.press("Enter")
                expect(page).to_have_url(re.compile(r"/dm$"))
                dm = rail.get_by_role("link", name=re.compile(r"^Jonas Berg(?:, new messages)?$"))
                self.assertEqual(dm.count(), 1, "a real authorized private conversation keeps an avatar link")
                self.assert_native_target(page, dm, True)
                dm.press("Enter")
                expect(page).to_have_url(re.compile(rf"/dm/{ids['dm']}$"))
                expect(page.get_by_text("Bring the ToF boards for Friday’s dark-room test.", exact=True)).to_be_visible()
                account = rail.get_by_role("button", name=re.compile("Ada Kowalska.*account and sign out"))
                expect(account).to_be_in_viewport()
                expect(rail.get_by_role("link", name="Settings", exact=True)).to_be_in_viewport()
                expect(rail.get_by_role("button", name="Expand sidebar")).to_be_in_viewport()
                self.assertEqual(page.evaluate("document.documentElement.scrollWidth - innerWidth"), 0)
                shot(page, f"340-rail-populated-messages-{engine}")

    def test_04_many_projects_preserve_real_working_stop_and_account(self):
        for engine in self.browsers:
            with self.subTest(engine=engine):
                page, ids = self.setup_owner(engine, coarse=True, many=True)
                project = ids["projects"][0]["id"]
                agent = self.api(page, "POST", f"/api/v1/workspaces/{ids['workspace']}/agents", {"name": "Garden analyst", "owner": "self"}, 201)
                self.api(page, "POST", f"/api/v1/projects/{project}/grants", {"principal": {"kind": "agent", "id": agent["id"]}, "role": "viewer"}, 201)
                self.api(page, "POST", "/api/v1/personal-assistant", {"consentVersion": "o-008-2026-10-02", "agentId": agent["id"],
                    "perRunCents": 6, "dailyCapCents": 100, "timeZone": "Europe/Warsaw"}, 201)
                conversation = self.api(page, "POST", f"/api/v1/projects/{project}/conversations", {
                    "body": "Compare the sensors for the east garden bed.", "clientMessageId": str(uuid.uuid4())}, 201)
                mock("/__script", {"reset": True, "delay": 30})
                run = self.api(page, "POST", f"/api/v1/conversations/{conversation['id']}/assistant-runs", {
                    "clientRunId": str(uuid.uuid4()), "kind": "ask", "prompt": "Which sensor should we test tomorrow?"}, 202)
                self.addCleanup(lambda page=page, run=run: self.api(page, "POST", f"/api/v1/assistant-runs/{run['id']}/stop"))
                page.evaluate("window.dispatchEvent(new Event('focus'))")
                rail = page.locator(".side--rail")
                stop = rail.get_by_role("button", name="Stop your assistant", exact=True)
                expect(stop).to_be_visible()
                expect(stop).to_be_in_viewport()
                expect(rail.get_by_role("button", name=re.compile("Ada Kowalska.*account and sign out"))).to_be_in_viewport()
                expect(rail.get_by_role("link", name="Settings", exact=True)).to_be_in_viewport()
                self.assert_native_target(page, stop, True)
                shot(page, f"340-rail-populated-working-{engine}")
                stop.press("Space")
                current = self.api(page, "GET", f"/api/v1/assistant-runs/{run['id']}")
                self.assertTrue(current["stopRequested"] or current["status"] == "stopped", str(current["status"]))
                expect(rail.locator(".agentlive")).to_have_count(0, timeout=25000)
                expect(rail.get_by_role("button", name=re.compile("Ada Kowalska.*account and sign out"))).to_be_in_viewport()


if __name__ == "__main__":
    unittest.main()
