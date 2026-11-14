"""Kreska's small moments (#352, final design F-026 §3): the splash, project loading, the empty Inbox,
the offline line, no results, pull to refresh and the wink in the toast (F-038: no goal, so no goal reached).

Real accounts and projects through the public API against the running Compose app. Each moment has its
words; Settings → Appearance turns the face off and the words stay; reduced motion animates nothing.
"""

from __future__ import annotations

import json
import os
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

PASSWORD = "a quiet small moment"
SWITCH = "Show the face on loading and empty screens"
# Every animated part of one face: its animation's name and iteration count, sorted (#1342).
MOTION = """face => [...face.querySelectorAll('*')].map((part) => getComputedStyle(part)).filter((style) => style.animationName !== 'none')
  .map((style) => `${style.animationName} ${style.animationIterationCount}`).sort()"""
EMAIL = f"ada.moments+{int(time.time() * 1000)}@example.test"
KRESKA_ANIMATIONS = "document.getAnimations().filter(a => a.effect?.target?.closest?.('.kreska, .opening, .boot, .pull')).length"


class SmallMomentsJourney(unittest.TestCase):
    browser: Browser
    state: dict = {}
    ids: dict = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, os.environ.get("FLUX_UI_BROWSER", "chromium")).launch()
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

    def task_status(self, page: Page, task_id: str) -> str:
        return json.loads(page.request.get(f"{ORIGIN}/api/v1/work/{task_id}").text())["status"]

    def set_task_status(self, page: Page, task_id: str, status: str) -> None:
        task = json.loads(page.request.get(f"{ORIGIN}/api/v1/work/{task_id}").text())
        response = page.request.patch(f"{ORIGIN}/api/v1/work/{task_id}", data=json.dumps({"status": status, "expectedVersion": task["version"]}),
                                      headers={"origin": ORIGIN, "content-type": "application/json"})
        self.assertEqual(response.status, 200, response.text())

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
                    face = page.locator(".nyq__clear .kreska")
                    expect(face).to_have_attribute("data-expression", "done")
                    box = face.bounding_box()
                    self.assertEqual((round(box["width"]), round(box["height"])), (96, 96))
                    # It never covers the words and sits above them.
                    title = page.get_by_role("heading", name="Nothing needs you right now").bounding_box()
                    self.assertLess(box["y"] + box["height"], title["y"])
                    shot(page, f"352-inbox-empty-{'phone' if phone else 'desktop'}-{scheme}")

    def search_nothing(self, page, phone: bool):
        """Opens Search (the phone's button or Ctrl+K) and types words nothing matches."""
        page.goto("/")
        if phone:
            page.get_by_role("button", name="Search", exact=True).click()
        else:
            expect(page.get_by_role("button", name="Search", exact=True)).to_be_visible()
            page.keyboard.press("Control+k")
        dialog = page.get_by_role("dialog", name="Search", exact=True)
        dialog.get_by_role("combobox", name="Search", exact=True).fill("zzqxv")
        return dialog

    def test_02_no_results_looks_aside_and_still_says_so(self) -> None:
        self.ensure_account()
        for phone in (True, False):
            with self.subTest(phone=phone):
                page = self.page(phone=phone, scheme="dark")
                dialog = self.search_nothing(page, phone)
                expect(dialog.get_by_role("heading", name="Nothing matches “zzqxv”")).to_be_visible()
                # One search on both devices (#870), with the drawn no-results moment.
                expect(dialog.locator(".jump__none .kreska")).to_have_attribute("data-expression", "looking")
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
        page.goto("/")
        expect(page.locator(".home__clear")).to_contain_text("Nothing is waiting for you")
        expect(page.locator(".home__clear .kreska")).to_have_count(0)
        page.goto("/inbox")
        expect(page.get_by_role("heading", name="Nothing needs you right now")).to_be_visible()
        expect(page.locator(".kreska")).to_have_count(0)
        expect(page.get_by_text("Enjoy the quiet.")).to_be_visible()
        dialog = self.search_nothing(page, False)
        expect(dialog.get_by_role("heading", name="Nothing matches “zzqxv”")).to_be_visible()
        expect(dialog.locator(".kreska")).to_have_count(0)
        page.keyboard.press("Escape")
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
        page.goto("/")
        expect(page.locator(".home__clear .kreska")).to_be_visible()

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

    def test_05b_the_dark_splash_is_dark_before_any_stylesheet_arrives(self) -> None:
        """#763 FR-3: with the OS in dark (or Flux set to Dark) and no stylesheet yet, the page and the splash are dark
        and the logo tile is light on them, from the inline critical CSS alone."""
        self.ensure_account()
        for stored in (None, "dark"):
            with self.subTest(stored=stored):
                page = self.page(phone=True, scheme="dark" if stored is None else "light", signed_in=False)
                if stored:
                    page.add_init_script(f"try {{ localStorage.setItem('flux.theme', '{stored}') }} catch (e) {{}}")
                page.route(re.compile(r"\.(js|css)(\?.*)?$"), lambda route: route.abort())
                page.goto("/", wait_until="commit")
                splash = page.locator(".boot--moment")
                expect(splash).to_be_visible()
                colours = page.evaluate("""() => ({
                  page: getComputedStyle(document.documentElement).backgroundColor,
                  splash: getComputedStyle(document.querySelector('.boot--moment')).backgroundColor,
                  tile: getComputedStyle(document.querySelector('.boot__tile')).fill,
                })""")
                self.assertEqual(colours["page"], "rgb(17, 17, 17)", colours)
                self.assertEqual(colours["splash"], "rgb(17, 17, 17)", colours)
                self.assertEqual(colours["tile"], "rgb(240, 240, 240)", colours)
        # Light stays light.
        page = self.page(phone=True, scheme="light", signed_in=False)
        page.route(re.compile(r"\.(js|css)(\?.*)?$"), lambda route: route.abort())
        page.goto("/", wait_until="commit")
        self.assertEqual(page.evaluate("getComputedStyle(document.querySelector('.boot--moment')).backgroundColor"), "rgb(244, 244, 245)")

    def test_06_closing_a_task_winks_in_one_undo_toast_from_every_surface(self) -> None:
        self.ensure_account()
        project = self.ids["project"]
        owner = {"kind": "human", "id": self.me(self.page())}
        tasks = {}
        for key, title in (("list", "Close from the list"), ("key", "Close with key four")):
            tasks[key] = self.api(self.page(), "POST", f"/api/v1/projects/{project}/work", {"title": title, "owner": owner})

        def assert_one_wink(page: Page, task: dict) -> None:
            toast = page.locator(".ui-toast").filter(has_text=re.compile(r"#\d+ done"))
            expect(toast).to_have_count(1)
            expect(toast.locator(".kreska")).to_have_attribute("data-expression", "wink")
            expect(toast.get_by_role("button", name="Undo")).to_be_visible()
            self.assertEqual(self.task_status(page, task["id"]), "done")

        # 1. The detail panel's Status menu (the original task).
        page = self.page()
        page.goto(f"/projects/{project}/tasks?open=work:{self.ids['task']}")
        page.get_by_role("button", name="Status", exact=True).click()
        page.get_by_role("menu", name="Status").get_by_role("menuitemradio", name="Done").click()
        toast = page.locator(".ui-toast").filter(has_text=re.compile(r"#\d+ done"))
        expect(toast).to_have_count(1)
        expect(toast.locator(".kreska")).to_have_attribute("data-expression", "wink")
        shot(page, "352-toast-wink")

        # 2. One tap on the glyph in the list (desktop): the glyph moves the task one step, so it starts In progress.
        page = self.page()
        self.set_task_status(page, tasks["list"]["id"], "in_progress")
        page.goto(f"/projects/{project}/tasks")
        page.get_by_role("radio", name="List", exact=True).click()
        page.locator(".ws-task").filter(has_text=tasks["list"]["title"]).get_by_role("button", name=re.compile(r"Set to Done")).click()
        assert_one_wink(page, tasks["list"])

        # 3. Key 4 on the focused board card (desktop).
        page = self.page()
        page.goto(f"/projects/{project}/tasks")
        page.locator(".tb-card").filter(has_text=tasks["key"]["title"]).get_by_role("button", name=tasks["key"]["title"], exact=True).focus()
        page.keyboard.press("4")
        assert_one_wink(page, tasks["key"])

    @unittest.skipIf(os.environ.get("FLUX_UI_BROWSER", "chromium") == "webkit", "Chromium-only touch control and route holding; WebKit hangs here")
    def test_07_pull_to_refresh_peeks_over_the_edge_and_releases_to_read_again(self) -> None:
        self.ensure_account()
        page = self.page(phone=True)
        page.goto("/tasks")
        # The header names the page "Your tasks" (#763 NV-1) at once; the pull belongs to the list, so wait for the list's own
        # heading (level 2), not the header's, before the gesture.
        expect(page.get_by_role("heading", level=2, name=re.compile("Your tasks|Nothing is waiting for you")).first).to_be_visible()
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
        page.goto("/inbox")
        expect(page.locator(".nyq__clear .kreska")).to_be_visible()
        self.assertEqual(page.evaluate(KRESKA_ANIMATIONS), 0, "/inbox")
        self.search_nothing(page, True)
        expect(page.locator(".jump__none .kreska")).to_be_visible()
        self.assertEqual(page.evaluate(KRESKA_ANIMATIONS), 0, "search")
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
        # A space that is not there is "This place isn't available" (#1371), not an error box; neither carries the mascot.
        expect(page.locator("[data-not-available], .ui-error").first).to_be_visible()
        expect(page.locator("[data-not-available] .kreska, .ui-error .kreska, .ui-error--mascot")).to_have_count(0)
        expect(page.locator("[role=alert] .kreska")).to_have_count(0)


    @unittest.skipIf(os.environ.get("FLUX_UI_BROWSER", "chromium") == "webkit", "Chromium-only touch control and route holding; WebKit hangs here")
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

    @unittest.skipIf(os.environ.get("FLUX_UI_BROWSER", "chromium") == "webkit", "Chromium-only touch control and route holding; WebKit hangs here")
    def test_11_a_cancelled_pull_resets_without_refreshing(self) -> None:
        """The browser cancelling a touch is not a release: only touchend refreshes."""
        self.ensure_account()
        page = self.page(phone=True)
        page.goto("/tasks")
        # The header names the page "Your tasks" (#763 NV-1) at once; the pull belongs to the list, so wait for the list's own
        # heading (level 2), not the header's, before the gesture.
        expect(page.get_by_role("heading", level=2, name=re.compile("Your tasks|Nothing is waiting for you")).first).to_be_visible()
        page.wait_for_load_state("networkidle")
        # Only API reads of the work count: the lazily loaded `work-*.css` asset chunk is not a read.
        reads: list[str] = []
        page.on("request", lambda request: reads.append(request.url) if "/api/" in request.url and "/work" in request.url else None)
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

    def test_12_each_moment_moves_as_drawn_and_reduced_motion_or_the_switch_stops_it(self) -> None:
        """#1342: the empty Inbox's eyes settle into the smile once, the offline face's z drifts and it breathes (loops of an
        ongoing state), and Settings → Appearance (the face switch off) or the system's reduced motion leaves every face still."""
        self.ensure_account()
        page = self.page()
        page.goto("/inbox")
        face = page.locator(".nyq__clear .kreska")
        expect(face).to_be_visible()
        self.assertEqual(face.get_attribute("data-expression"), "done")
        self.assertEqual(face.evaluate(MOTION), ["kreska-settle 1"])
        page.goto(f"/projects/{self.ids['project']}")
        expect(page.get_by_role("textbox").first).to_be_visible()
        page.context.set_offline(True)
        asleep = page.locator(".connection-line .kreska")
        expect(asleep).to_have_attribute("data-expression", "asleep")
        self.assertEqual(asleep.evaluate(MOTION), ["kreska-breathe infinite", "kreska-drift infinite"])
        page.context.set_offline(False)
        # A face that stays when the moments are off (an agent's state beside its name) answers to the same switch: a copy of the
        # Settings row's face is given a state, so the switch is the real one and the rules are the built ones.
        page.goto("/settings")
        expect(page.get_by_role("switch", name=SWITCH)).to_be_visible()
        expect(page.locator(".kreska").first).to_be_attached()
        probe = """expression => { document.querySelector('[data-probe]')?.remove(); const face = document.querySelector('.kreska:not([data-probe])').cloneNode(true);
          face.dataset.probe = ''; face.dataset.expression = expression; face.setAttribute('data-moves', ''); document.body.append(face);
          return [...face.querySelectorAll('*')].map((part) => getComputedStyle(part)).filter((style) => style.animationName !== 'none')
            .map((style) => `${style.animationName} ${style.animationIterationCount}`).sort(); }"""
        self.assertEqual(page.evaluate(probe, "thinking"), ["kreska-wave infinite"])
        self.assertEqual(page.evaluate(probe, "worried"), ["kreska-drop 1"])
        switch = page.get_by_role("switch", name=SWITCH)
        before = switch.get_attribute("aria-checked")
        switch.click()
        expect(switch).not_to_have_attribute("aria-checked", before)
        self.assertEqual(page.evaluate(probe, "thinking"), [], SWITCH)
        self.assertEqual(page.evaluate(probe, "worried"), [], SWITCH)
        switch.click()
        expect(switch).to_have_attribute("aria-checked", before)
        self.assertEqual(page.evaluate(probe, "thinking"), ["kreska-wave infinite"], SWITCH)
        self.assertEqual(page.get_by_role("switch", name="Reduce motion").count(), 0, "no Reduce motion switch: the system's setting decides")
        reduced = self.page(reduced=True)
        reduced.goto("/settings")
        expect(reduced.get_by_role("switch", name=SWITCH)).to_be_visible()
        expect(reduced.locator(".kreska").first).to_be_attached()
        self.assertEqual(reduced.evaluate(probe, "thinking"), [], "the system's reduced motion")


if __name__ == "__main__":
    unittest.main()
