"""Kreska's small moments (#352, final design F-026 §3): the splash, project loading, the empty Inbox,
the offline line, no results, pull to refresh, goal reached and the wink in the toast.

Real accounts and projects through the public API against the running Compose app. Each moment has its
words; Settings → Appearance turns the face off and the words stay; reduced motion animates nothing.
"""

from __future__ import annotations

import json
import re
import time
import unittest

from playwright.sync_api import Browser, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

PASSWORD = "a quiet small moment"
SWITCH = "Kreska in loading and empty screens"
EMAIL = f"ada.moments+{int(time.time() * 1000)}@example.test"
KRESKA_ANIMATIONS = "document.getAnimations().filter(a => a.effect?.target?.closest?.('.kreska, .opening, .boot, .pull, .goal')).length"


class SmallMomentsJourney(unittest.TestCase):
    browser: Browser
    state: dict = {}
    ids: dict = {}

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

    def page(self, *, phone: bool = False, scheme: str = "light", reduced: bool = False, signed_in: bool = True) -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": scheme, "locale": "en-GB", "timezone_id": "Europe/Warsaw",
                         "service_workers": "block", "reduced_motion": "reduce" if reduced else "no-preference"}
        options.update(viewport=PHONE, device_scale_factor=2, is_mobile=True, has_touch=True) if phone else options.update(viewport=DESKTOP, device_scale_factor=1)
        if signed_in and self.state:
            options["storage_state"] = self.state
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        return context.new_page()

    def api(self, page: Page, method: str, path: str, body: dict) -> dict:
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers={"origin": ORIGIN, "content-type": "application/json"}, data=json.dumps(body))
        self.assertEqual(response.status, 201, response.text())
        return json.loads(response.text())

    def ensure_account(self) -> None:
        if self.state:
            return
        page = self.page(signed_in=False)
        page.goto("/sign-up")
        page.get_by_label("Name").fill("Ada Moments")
        page.get_by_label("Email").fill(EMAIL)
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        workspace = self.api(page, "POST", "/api/v1/workspaces", {"name": "Garden sensors"})
        project = self.api(page, "POST", f"/api/v1/workspaces/{workspace['id']}/projects", {"name": "Soil probes", "visibility": "restricted"})
        task = self.api(page, "POST", f"/api/v1/projects/{project['id']}/work", {"title": "Order the enclosures", "owner": {"kind": "human", "id": self.me(page)}})
        type(self).ids = {"workspace": workspace["id"], "project": project["id"], "task": task["id"]}
        type(self).state = page.context.storage_state()

    def me(self, page: Page) -> str:
        return json.loads(page.request.get(f"{ORIGIN}/api/v1/me").text())["user"]["id"]

    def test_01_empty_inbox_is_done_with_its_words_in_both_themes_and_sizes(self) -> None:
        self.ensure_account()
        for phone in (True, False):
            for scheme in ("light", "dark"):
                with self.subTest(phone=phone, scheme=scheme):
                    page = self.page(phone=phone, scheme=scheme)
                    page.goto("/inbox")
                    expect(page.get_by_role("heading", name="Nothing needs you right now")).to_be_visible()
                    expect(page.get_by_text("Enjoy the quiet.")).to_be_visible()
                    face = page.locator(".ui-empty--mascot .kreska")
                    expect(face).to_have_attribute("data-expression", "done")
                    box = face.bounding_box()
                    self.assertEqual((round(box["width"]), round(box["height"])), (80, 80))
                    # It never covers the words and sits above them.
                    title = page.get_by_role("heading", name="Nothing needs you right now").bounding_box()
                    self.assertLess(box["y"] + box["height"], title["y"])
                    shot(page, f"352-inbox-empty-{'phone' if phone else 'desktop'}-{scheme}")

    def test_02_no_results_looks_aside_and_still_says_so(self) -> None:
        self.ensure_account()
        for phone in (True, False):
            with self.subTest(phone=phone):
                page = self.page(phone=phone, scheme="dark")
                page.goto("/search?q=zzqxv")
                expect(page.get_by_role("heading", name="Nothing matches “zzqxv”")).to_be_visible()
                expect(page.locator(".ui-empty--mascot .kreska")).to_have_attribute("data-expression", "looking")
                shot(page, f"352-no-results-{'phone' if phone else 'desktop'}")

    def test_03_offline_line_has_the_sleeping_face_and_unreachable_does_not(self) -> None:
        self.ensure_account()
        page = self.page(phone=True)
        page.goto(f"/projects/{self.ids['project']}")
        expect(page.get_by_role("textbox").first).to_be_visible()
        page.context.set_offline(True)
        line = page.locator(".connection-line")
        expect(line).to_have_text("You’re offline. Messages send when you’re back.")
        expect(line.locator(".kreska")).to_have_attribute("data-expression", "asleep")
        shot(page, "352-offline-phone")
        page.context.set_offline(False)
        expect(line).to_have_count(0)

    def test_04_switch_in_settings_turns_every_face_off_and_keeps_the_words(self) -> None:
        self.ensure_account()
        page = self.page()
        page.goto("/settings")
        switch = page.get_by_role("switch", name=SWITCH)
        expect(switch).to_have_attribute("aria-checked", "true")
        switch.focus()
        page.keyboard.press("Space")
        expect(switch).to_have_attribute("aria-checked", "false")
        page.goto("/inbox")
        expect(page.get_by_role("heading", name="Nothing needs you right now")).to_be_visible()
        expect(page.locator(".kreska")).to_have_count(0)
        expect(page.locator(".ui-empty__icon")).to_have_count(1)
        page.goto("/search?q=zzqxv")
        expect(page.get_by_role("heading", name="Nothing matches “zzqxv”")).to_be_visible()
        expect(page.locator(".ui-empty--mascot")).to_have_count(0)
        # The splash is gone too, and the choice is the page's before React starts.
        self.assertEqual(page.evaluate("document.documentElement.dataset.kreska"), "off")
        page.goto(f"/projects/{self.ids['project']}")
        expect(page.get_by_role("textbox").first).to_be_visible()
        page.context.set_offline(True)
        expect(page.locator(".connection-line")).to_have_text("You’re offline. Messages send when you’re back.")
        expect(page.locator(".connection-line .kreska")).to_have_count(0)
        page.context.set_offline(False)
        page.goto("/settings")
        page.get_by_role("switch", name=SWITCH).click()
        expect(page.get_by_role("switch", name=SWITCH)).to_have_attribute("aria-checked", "true")

    def test_05_the_splash_is_the_logo_and_a_line_and_moves_only_when_motion_is_allowed(self) -> None:
        self.ensure_account()
        html = self.page().request.get(f"{ORIGIN}/").text()
        self.assertIn("boot--moment", html)
        for reduced in (False, True):
            with self.subTest(reduced=reduced):
                page = self.page(phone=True, reduced=reduced, signed_in=False)
                # The app never starts, so the splash from index.html stays on screen.
                page.route(re.compile(r"\.js(\?.*)?$"), lambda route: route.abort())
                page.goto("/", wait_until="commit")
                splash = page.locator(".boot--moment")
                expect(splash).to_be_visible()
                expect(splash.locator(".boot__tile")).to_have_count(1)
                expect(splash).to_have_attribute("aria-label", "Opening Flux")
                running = page.evaluate("document.getAnimations().length")
                self.assertEqual(running == 0, reduced, running)
                if not reduced:
                    shot(page, "352-splash-phone")

    def test_06_closing_a_task_winks_in_the_toast_once_and_says_it_in_words(self) -> None:
        self.ensure_account()
        page = self.page()
        page.goto(f"/projects/{self.ids['project']}/tasks?open=work:{self.ids['task']}")
        page.get_by_role("combobox", name="Status").select_option(label="Done")
        toast = page.locator(".ui-toast")
        expect(toast).to_contain_text(re.compile(r"#\d+ done"))
        expect(toast.locator(".kreska")).to_have_attribute("data-expression", "wink")
        shot(page, "352-toast-wink")

    def test_07_pull_to_refresh_peeks_over_the_edge_and_releases_to_read_again(self) -> None:
        self.ensure_account()
        page = self.page(phone=True)
        page.goto("/")
        page.get_by_role("navigation", name="Views").get_by_role("link", name="Tasks").click()
        expect(page.get_by_role("heading", name=re.compile("Your tasks|Nothing is waiting for you"))).to_be_visible()
        reads = []
        page.on("request", lambda request: reads.append(request.url) if "/work" in request.url else None)
        cdp = page.context.new_cdp_session(page)
        point = lambda y: [{"x": 195, "y": y}]  # noqa: E731
        cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": point(200)})
        for y in range(210, 420, 20):
            cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": point(y)})
        expect(page.locator(".pull")).to_have_attribute("data-ready", "true")
        expect(page.locator(".pull .kreska")).to_have_attribute("data-expression", "surprised")
        expect(page.get_by_text("Release to refresh")).to_be_visible()
        shot(page, "352-pull-refresh-phone")
        cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        expect(page.get_by_text("Refreshing…")).to_be_visible()
        expect.set_options(timeout=8000)
        page.wait_for_timeout(1500)
        self.assertTrue(reads)
        expect(page.locator(".pull .kreska")).to_have_count(0)

    def test_08_reduced_motion_leaves_every_moment_a_static_frame(self) -> None:
        self.ensure_account()
        page = self.page(phone=True, reduced=True)
        for path in ("/inbox", "/search?q=zzqxv"):
            page.goto(path)
            expect(page.locator(".ui-empty--mascot .kreska")).to_be_visible()
            self.assertEqual(page.evaluate(KRESKA_ANIMATIONS), 0, path)
        page.goto(f"/projects/{self.ids['project']}")
        expect(page.get_by_role("textbox").first).to_be_visible()
        page.context.set_offline(True)
        expect(page.locator(".connection-line .kreska")).to_be_visible()
        self.assertEqual(page.evaluate(KRESKA_ANIMATIONS), 0)
        page.context.set_offline(False)

    def test_09_the_mascot_stays_out_of_errors_and_deletion(self) -> None:
        self.ensure_account()
        page = self.page()
        page.goto("/projects/00000000-0000-4000-8000-000000000000")
        expect(page.locator(".ui-error").first).to_be_visible()
        expect(page.locator(".ui-error .kreska, .ui-error--mascot")).to_have_count(0)
        expect(page.locator("[role=alert] .kreska")).to_have_count(0)


    def test_10_with_moments_off_the_startup_line_is_plain_before_the_app_loads(self) -> None:
        """Off is decided before the first paint, so the plain line is there while the bundle still downloads."""
        self.ensure_account()
        page = self.page(phone=True, signed_in=True)
        page.add_init_script("try { localStorage.setItem('flux.kreska', 'off'); } catch (e) {}")
        gate = {"open": False}
        held: list = []

        def hold(route) -> None:
            if gate["open"]:
                route.continue_()
            else:
                held.append(route)

        page.route(re.compile(r"\.js(\?.*)?$"), hold)
        page.goto("/", wait_until="commit")
        # The only status on screen is the plain line; the splash logo is hidden.
        expect(page.get_by_role("status")).to_have_text("Opening Flux…")
        expect(page.locator(".boot--moment")).to_be_hidden()
        self.assertEqual(page.evaluate("document.getAnimations().length"), 0)
        shot(page, "352-startup-off-phone")
        gate["open"] = True
        for route in held:
            route.continue_()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()

    def test_11_a_cancelled_pull_resets_without_refreshing(self) -> None:
        """The browser cancelling a touch is not a release: only touchend refreshes."""
        self.ensure_account()
        page = self.page(phone=True)
        page.goto("/")
        page.get_by_role("navigation", name="Views").get_by_role("link", name="Tasks").click()
        expect(page.get_by_role("heading", name=re.compile("Your tasks|Nothing is waiting for you"))).to_be_visible()
        page.wait_for_load_state("networkidle")
        reads: list[str] = []
        page.on("request", lambda request: reads.append(request.url) if "/work" in request.url else None)
        cdp = page.context.new_cdp_session(page)

        def touch(kind: str, y: int | None = None) -> None:
            points = [] if y is None else [{"x": 195, "y": y}]
            cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": points})

        # Cancelled after crossing the threshold: the pull resets, nothing is announced, nothing is read.
        touch("touchStart", 200)
        for y in range(210, 420, 20):
            touch("touchMove", y)
        expect(page.locator(".pull")).to_have_attribute("data-ready", "true")
        touch("touchCancel")
        expect(page.locator(".pull")).not_to_have_attribute("data-ready", "true")
        expect(page.get_by_text("Refreshing…")).to_have_count(0)
        expect(page.locator(".pull .kreska")).to_have_count(0)
        page.wait_for_timeout(1200)
        self.assertEqual(reads, [], "a cancelled pull reads nothing")
        # Control: released below the threshold does not refresh either.
        touch("touchStart", 200)
        touch("touchMove", 240)
        touch("touchEnd")
        page.wait_for_timeout(1200)
        self.assertEqual(reads, [], "a short pull reads nothing")
        # Control: released past the threshold refreshes exactly once.
        touch("touchStart", 200)
        for y in range(210, 420, 20):
            touch("touchMove", y)
        touch("touchEnd")
        expect(page.get_by_text("Refreshing…")).to_be_visible()
        page.wait_for_timeout(1500)
        self.assertEqual(len(reads), 1, reads)


if __name__ == "__main__":
    unittest.main()
