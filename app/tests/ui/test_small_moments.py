"""Kreska's small moments (#352, final design F-026 §3): the splash, project loading, the empty Inbox,
the offline line, no results, pull to refresh, goal reached (#520) and the wink in the toast.

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
SWITCH = "Kreska in loading and empty screens"
EMAIL = f"ada.moments+{int(time.time() * 1000)}@example.test"
KRESKA_ANIMATIONS = "document.getAnimations().filter(a => a.effect?.target?.closest?.('.kreska, .opening, .boot, .pull, .goal')).length"
GOAL_ANIMATIONS = "document.getAnimations().filter(a => a.effect?.target?.closest?.('.goal, .convo-goal')).length"


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

    def goal_change(self, page: Page, project_id: str, method: str, path: str, body: dict | None = None) -> dict:
        """A goal change through the API (#520) with the project version the caller just read."""
        version = json.loads(page.request.get(f"{ORIGIN}/api/v1/projects/{project_id}").text())["version"]
        headers = {"origin": ORIGIN, "if-match": f'"{version}"'}
        if body is not None:
            headers["content-type"] = "application/json"
        response = page.request.fetch(f"{ORIGIN}/api/v1/projects/{project_id}/{path}", method=method, headers=headers,
                                      data=json.dumps(body) if body is not None else None)
        self.assertEqual(response.status, 200, response.text())
        return json.loads(response.text())

    def reached_goal(self, page: Page, name: str, title: str) -> tuple[str, str]:
        """A project whose agent reported in the conversation and whose person then marked the goal reached."""
        project = self.api(page, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/projects", {"name": name, "visibility": "restricted"})
        self.api(page, "POST", f"/api/v1/projects/{project['id']}/conversations", {"body": "Sensor 6 just reported. That's all six beds.", "clientMessageId": str(uuid.uuid4())})
        self.goal_change(page, project["id"], "PUT", "goal", {"title": title})
        state = self.goal_change(page, project["id"], "POST", "goal/reached")
        return project["id"], state["goal"]["id"]

    def assert_goal_card_in_place(self, page: Page, card) -> None:
        """The card is part of the stream, above the composer, and nothing covers it."""
        expect(card).to_be_in_viewport()
        box = card.bounding_box()
        composer = page.get_by_role("textbox").first.bounding_box()
        self.assertLessEqual(box["y"] + box["height"], composer["y"] + 1, "the card never covers the composer")
        self.assertTrue(card.evaluate("node => !!node.closest('.project-convo__message-list')"), "it is a stream entry, not an overlay")
        covered = card.evaluate("node => { const r = node.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 24); return !node.contains(hit); }")
        self.assertFalse(covered, "nothing lies over the card")

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

    def test_02_no_results_looks_aside_and_still_says_so(self) -> None:
        self.ensure_account()
        for phone in (True, False):
            with self.subTest(phone=phone):
                page = self.page(phone=phone, scheme="dark")
                page.goto("/search?q=zzqxv")
                expect(page.get_by_role("heading", name="Nothing matches “zzqxv”")).to_be_visible()
                # The phone's /search is its one search (#763 SE-2), with the drawn no-results moment.
                expect(page.locator(".jump__none .kreska" if phone else ".ui-empty--mascot .kreska")).to_have_attribute("data-expression", "looking")
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
        expect(page.locator(".home__clear")).to_contain_text("Nothing needs you right now")
        expect(page.locator(".home__clear .kreska")).to_have_count(0)
        page.goto("/inbox")
        expect(page.get_by_role("heading", name="Nothing needs you right now")).to_be_visible()
        expect(page.locator(".kreska")).to_have_count(0)
        expect(page.get_by_text("Enjoy the quiet.")).to_be_visible()
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
        # The header names the page "Your tasks" (#763 NV-1) beside the list's own heading.
        expect(page.get_by_role("heading", name=re.compile("Your tasks|Nothing is waiting for you")).first).to_be_visible()
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
        for path, face in (("/inbox", ".nyq__clear .kreska"), ("/search?q=zzqxv", ".jump__none .kreska")):
            page.goto(path)
            expect(page.locator(face)).to_be_visible()
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
        # The header names the page "Your tasks" (#763 NV-1) beside the list's own heading.
        expect(page.get_by_role("heading", name=re.compile("Your tasks|Nothing is waiting for you")).first).to_be_visible()
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

    def test_12_goal_reached_celebrates_once_per_goal_and_device(self) -> None:
        """#520 AC-2/AC-5/AC-6: the card at the reached point, once per goal and device, then one quiet line."""
        self.ensure_account()
        project_id, goal_id = self.reached_goal(self.page(), "Community garden sensors", "All six beds report moisture")
        for phone, scheme in ((False, "light"), (True, "dark")):
            with self.subTest(phone=phone, scheme=scheme):
                page = self.page(phone=phone, scheme=scheme)  # a fresh device: it has not seen this goal
                page.goto(f"/projects/{project_id}")
                card = page.locator(".convo-goal--card")
                expect(card).to_be_visible()
                expect(card.locator(".kreska")).to_have_attribute("data-expression", "celebrate")
                expect(card.get_by_role("heading", name="All six beds report moisture")).to_be_visible()
                expect(card).to_contain_text("Community garden sensors · goal reached")
                expect(card.get_by_role("button", name="Write a wrap-up")).to_be_visible()
                expect(card.get_by_role("button", name="Keep going")).to_be_visible()
                # It follows the agent's report in the stream, and never covers content; no confetti, no motion.
                order = page.locator(".project-convo__message-list > li:not(.project-convo__day)").evaluate_all("items => items.map(item => item.className)")
                self.assertRegex(order[-1], "convo-goal", order)
                self.assertRegex(order[-2], "project-convo__message", order)
                self.assert_goal_card_in_place(page, card)
                self.assertEqual(page.evaluate(GOAL_ANIMATIONS), 0)
                shot(page, f"520-goal-card-{'phone' if phone else 'desktop'}-{scheme}")
                # Seen once it is on screen: it never returns for this goal on this device.
                page.wait_for_function(f"localStorage.getItem('flux.goal.{goal_id}') === '1'")
                if phone:
                    card.get_by_role("button", name="Keep going").tap()
                    expect(card).to_have_count(0)
                page.reload()
                line = page.locator(".convo-goal__line")
                expect(line).to_contain_text("Goal reached · All six beds report moisture · you")
                expect(page.locator(".convo-goal--card")).to_have_count(0)
                expect(page.locator(".convo-goal .kreska")).to_have_count(0)
                if phone:
                    shot(page, f"520-goal-line-phone-{scheme}")

    def test_13_with_moments_off_or_reduced_motion_the_goal_card_keeps_its_words(self) -> None:
        """#520 AC-3/AC-4: Small moments off shows the same words with no face; reduced motion is a static frame."""
        self.ensure_account()
        setup = self.page()
        for case in ("off", "reduced"):
            with self.subTest(case=case):
                project_id, _ = self.reached_goal(setup, f"Cargo bikes {case}", "Two shared cargo bikes by spring")
                page = self.page(phone=True, reduced=case == "reduced")
                if case == "off":
                    page.add_init_script("try { localStorage.setItem('flux.kreska', 'off'); } catch (e) {}")
                page.goto(f"/projects/{project_id}")
                card = page.locator(".convo-goal--card")
                expect(card.get_by_role("heading", name="Two shared cargo bikes by spring")).to_be_visible()
                expect(card).to_contain_text(f"Cargo bikes {case} · goal reached")
                expect(card.get_by_role("button", name="Keep going")).to_be_visible()
                if case == "off":
                    expect(card.locator(".kreska")).to_have_count(0)
                    shot(page, "520-goal-card-moments-off-phone")
                else:
                    expect(card.locator(".kreska")).to_have_attribute("data-expression", "celebrate")
                self.assert_goal_card_in_place(page, card)
                self.assertEqual(page.evaluate(GOAL_ANIMATIONS), 0)
                self.assertEqual(page.evaluate(KRESKA_ANIMATIONS), 0)

    def test_14_write_a_wrap_up_starts_a_wiki_page_draft(self) -> None:
        """#520 AC-2: Write a wrap-up opens a new Wiki page draft named after the goal; nothing is saved yet."""
        self.ensure_account()
        page = self.page()
        project_id, goal_id = self.reached_goal(page, "Soil sensors wrap-up", "Every probe survives the winter")
        page.goto(f"/projects/{project_id}")
        page.locator(".convo-goal--card").get_by_role("button", name="Write a wrap-up").click()
        expect(page).to_have_url(re.compile(rf"/projects/{project_id}/docs/new$"))
        expect(page.get_by_label("Title")).to_have_value("Wrap-up: Every probe survives the winter")
        self.assertEqual(json.loads(page.request.get(f"{ORIGIN}/api/v1/projects/{project_id}/docs").text())["total"], 0, "a draft until the person saves it")
        self.assertEqual(page.evaluate(f"localStorage.getItem('flux.goal.{goal_id}')"), "1")
        page.go_back()
        expect(page.locator(".convo-goal__line")).to_contain_text("Goal reached · Every probe survives the winter")


if __name__ == "__main__":
    unittest.main()
