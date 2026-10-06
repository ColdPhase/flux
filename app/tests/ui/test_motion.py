"""Subtle navigation feedback and arrival motion (#155 AC-1, AC-4, AC-5; Studio 11.6 UI116-5).

Real accounts, projects and messages through the public API; Chromium with and without reduced
motion. Navigation is held at the actual network boundary to observe an interrupted choice; nothing
is fabricated in the page. Video of the interruption journeys goes to FLUX_UI_SCREENSHOTS when set.
Screenshots and video are evidence of placement only; timings are measured by motion_performance.py.
"""
from __future__ import annotations

import json
import os
import re
import unittest
import uuid

from playwright.sync_api import Page, expect, sync_playwright
from test_app_shell import ORIGIN, UPSTREAM, shot, start_forwarder

PASSWORD = "calm motion for a shared lamp"
STAMP = uuid.uuid4().hex[:12]
PEOPLE = {"ada": "Ada Kowalska", "bob": "Bob Nowak"}
PROJECTS = ("Reading lamp", "Garden sensor", "Library shelf")
ROOTS = 101  # more than one window of the stream (100), so earlier roots page in above the reader

GLIDE_AT = """(id) => {
  const g = document.querySelector('.side__glide'), r = document.querySelector(`.side__project[data-glide-id="${id}"]`);
  if (!g || !r) return null;
  const a = g.getBoundingClientRect(), b = r.getBoundingClientRect();
  return { top: a.top - b.top, height: a.height - b.height, left: a.left - b.left, width: a.width - b.width, running: g.getAnimations().length };
}"""
SETTLED = """() => { const glide = document.querySelector('.side__glide'), mark = document.querySelector('.views .ui-tabs__indicator');
  return !!glide && !!glide.dataset.target && !glide.getAnimations().length && !(mark && mark.getAnimations().length); }"""
FIRST_IN_VIEW = """() => { const feed = document.querySelector('.project-convo__feed.is-stream'); const top = feed.getBoundingClientRect().top;
  for (const item of feed.querySelectorAll('.project-convo__message, .convo-notice')) { const box = item.getBoundingClientRect();
    if (box.bottom > top + 1) return { id: item.id, top: box.top - top }; } return null; }"""


class MotionJourney(unittest.TestCase):
    states: dict = {}
    ids: dict = {}

    @classmethod
    def setUpClass(cls):
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        expect.set_options(timeout=10000)
        for key, name in PEOPLE.items():
            context = cls.browser.new_context(base_url=ORIGIN)
            response = context.request.post("/api/auth/sign-up/email", data={"email": f"motion-{key}-{STAMP}@example.test", "name": name, "password": PASSWORD}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.states[key] = context.storage_state()
            context.close()
        owner = cls.browser.new_context(base_url=ORIGIN, storage_state=cls.states["ada"])
        post = lambda path, body: cls.post(owner, path, body)
        workspace = post("/api/v1/workspaces", {"name": "Riverside studio"})["id"]
        post(f"/api/v1/workspaces/{workspace}/members", {"email": f"motion-bob-{STAMP}@example.test", "role": "member"})
        cls.projects = []
        for name in PROJECTS:
            project = post(f"/api/v1/workspaces/{workspace}/projects", {"name": name, "visibility": "restricted"})["id"]
            post(f"/api/v1/projects/{project}/grants", {"principal": {"kind": "human", "id": cls.ids["bob"]}, "role": "contributor"})
            cls.projects.append(project)
        cls.roots = []
        for index in range(ROOTS):
            conversation = post(f"/api/v1/projects/{cls.projects[0]}/conversations", {"body": f"Lamp note {index + 1}: compare the reading corner at dusk before choosing a sensor threshold.", "clientMessageId": str(uuid.uuid4())})
            cls.roots.append(conversation)
        cls.thread = cls.roots[-2]
        for index in range(12):
            post(f"/api/v1/conversations/{cls.thread['id']}/messages", {"body": f"Reply {index + 1}: the distance sensor kept a steady reading at this light level.", "clientMessageId": str(uuid.uuid4())})
        post(f"/api/v1/projects/{cls.projects[1]}/conversations", {"body": "Where should the soil sensor go?", "clientMessageId": str(uuid.uuid4())})
        owner.close()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    @staticmethod
    def post(context, path, body, status=201):
        response = context.request.post(path, data=body, headers={"origin": ORIGIN})
        assert response.status == status, response.text()
        return response.json()

    def page(self, who="ada", *, reduced=False, viewport=None, scale=1, video=False) -> Page:
        options = {"base_url": ORIGIN, "storage_state": self.states[who], "viewport": viewport or {"width": 1440, "height": 900},
                   "device_scale_factor": scale, "locale": "en-GB", "timezone_id": "Europe/Warsaw", "reduced_motion": "reduce" if reduced else "no-preference"}
        if video and os.environ.get("FLUX_UI_SCREENSHOTS"):
            options["record_video_dir"] = os.environ["FLUX_UI_SCREENSHOTS"]
            options["record_video_size"] = options["viewport"]
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught browser errors"))
        return page

    def bob_posts_root(self, body):
        context = self.browser.new_context(base_url=ORIGIN, storage_state=self.states["bob"])
        try:
            return self.post(context, f"/api/v1/projects/{self.projects[0]}/conversations", {"body": body, "clientMessageId": str(uuid.uuid4())})
        finally:
            context.close()

    def bob_replies(self, body):
        context = self.browser.new_context(base_url=ORIGIN, storage_state=self.states["bob"])
        try:
            return self.post(context, f"/api/v1/conversations/{self.thread['id']}/messages", {"body": body, "clientMessageId": str(uuid.uuid4())})
        finally:
            context.close()

    def link(self, page, index):
        return page.locator(f'.side__project[data-glide-id="{self.projects[index]}"]')

    def assert_glide_on(self, page, index):
        expect(page.locator(".side__glide")).to_have_attribute("data-target", self.projects[index])
        page.wait_for_function(SETTLED)
        geo = page.evaluate(GLIDE_AT, self.projects[index])
        self.assertIsNotNone(geo)
        for key in ("top", "height", "left", "width"):
            self.assertLess(abs(geo[key]), 1.01, f"the highlight sits exactly on the row: {geo}")

    def hold(self, page, pattern):
        """Holds GET requests matching `pattern` at the network boundary until released (no fabricated responses)."""
        held = []

        def handler(route):
            if route.request.method != "GET":
                return route.continue_()
            held.append(route)

        page.route(pattern, handler)

        def release():
            page.unroute(pattern, handler)
            for route in held:
                try:
                    route.continue_()
                except Exception:  # an aborted navigation's request may already be gone
                    pass
        return held, release

    def wait_held(self, page, held):
        for _ in range(100):
            if held:
                return
            page.wait_for_timeout(20)
        self.fail("the chosen project's read was actually held at the network boundary")

    def stream_ready(self, page):
        feed = page.locator(".project-convo__feed.is-stream")
        expect(feed).not_to_have_attribute("aria-busy", "true")
        return feed

    # ------------------------------------------------------------------ projects: one traveling highlight

    def test_01_project_choice_moves_at_once_and_an_interruption_settles_on_the_latest(self):
        page = self.page(video=True)
        page.goto(f"/projects/{self.projects[0]}")
        self.stream_ready(page)
        glide = page.locator(".side__glide")
        expect(glide).to_have_attribute("data-target", self.projects[0])
        # --dur-2, 180 ms since the #266 PF-4 motion tokens.
        self.assertEqual(glide.evaluate("el => getComputedStyle(el).transitionDuration.split(',').map(s => s.trim())[0]"), "0.18s")
        composer = page.locator("#project-composer")
        composer.fill("PRIVATE draft kept while choosing projects")
        scroll = page.locator(".side__scroll").evaluate("el => el.scrollTop")
        # B is chosen and its project is still loading: the highlight is already on B, the page still A.
        held, release = self.hold(page, f"**/api/v1/projects/{self.projects[1]}**")
        self.link(page, 1).click()
        expect(glide).to_have_attribute("data-target", self.projects[1])
        expect(self.link(page, 1)).to_have_attribute("data-pending", "")
        expect(page.locator(".side__project.is-open")).to_have_attribute("data-glide-id", self.projects[0])
        expect(page).to_have_url(re.compile(f"/projects/{self.projects[0]}$"))
        self.wait_held(page, held)
        # C before B arrives: the highlight retargets from where it is and settles on C.
        self.link(page, 2).click()
        release()
        expect(page).to_have_url(re.compile(f"/projects/{self.projects[2]}$"))
        expect(page.locator(".side__project.is-open")).to_have_attribute("data-glide-id", self.projects[2])
        expect(glide).to_have_attribute("data-target", self.projects[2])
        self.assert_glide_on(page, 2)
        expect(self.link(page, 2)).to_be_focused()
        self.assertEqual(page.locator(".side__scroll").evaluate("el => el.scrollTop"), scroll, "choosing never scrolls the list")
        shot(page, "motion-project-settled-on-latest")
        # Back to A: the draft is where it was left.
        self.link(page, 0).click()
        expect(page).to_have_url(re.compile(f"/projects/{self.projects[0]}$"))
        expect(page.locator("#project-composer")).to_have_value("PRIVATE draft kept while choosing projects")
        self.assert_glide_on(page, 0)

    def test_02_a_choice_that_does_not_happen_returns_the_highlight(self):
        page = self.page()
        page.goto(f"/projects/{self.projects[0]}")
        self.stream_ready(page)
        held, release = self.hold(page, f"**/api/v1/projects/{self.projects[1]}**")
        self.link(page, 1).click()
        expect(page.locator(".side__glide")).to_have_attribute("data-target", self.projects[1])
        self.wait_held(page, held)
        # Choosing the open project again replaces the pending choice: nothing changes and the
        # highlight goes back to the open project instead of staying on a guess.
        self.link(page, 0).click()
        expect(page.locator(".side__project[data-pending]")).to_have_count(0)
        release()
        expect(page.locator(".side__glide")).to_have_attribute("data-target", self.projects[0])
        expect(page).to_have_url(re.compile(f"/projects/{self.projects[0]}$"))
        self.assert_glide_on(page, 0)

    # ------------------------------------------------------------------ work tabs: one sliding mark

    def test_03_work_tab_mark_moves_at_once_content_follows_and_state_is_kept(self):
        page = self.page(video=True)
        page.goto(f"/projects/{self.projects[0]}")
        self.stream_ready(page)
        page.locator("#project-composer").fill("PRIVATE draft kept across views")
        indicator = page.locator(".views .ui-tabs__indicator")
        expect(indicator).to_have_attribute("data-target", "conversation")
        tabs = page.get_by_role("navigation", name="Project views")
        held, release = self.hold(page, f"**/api/v1/projects/{self.projects[0]}**")
        tabs.get_by_role("link", name=re.compile("^Tasks")).click()
        expect(indicator).to_have_attribute("data-target", "tasks")
        expect(tabs.get_by_role("link", name="Conversation")).to_have_attribute("aria-current", "page")
        tabs.get_by_role("link", name="Map").click()
        release()
        expect(page).to_have_url(re.compile(f"/projects/{self.projects[0]}/map"))
        expect(tabs.get_by_role("link", name="Map")).to_have_attribute("aria-current", "page")
        expect(indicator).to_have_attribute("data-target", "map")
        page.wait_for_function(SETTLED)
        expect(tabs.get_by_role("link", name="Map")).to_be_focused()
        box = tabs.get_by_role("link", name="Map").bounding_box(); mark = indicator.bounding_box()
        self.assertTrue(box and mark and box["x"] <= mark["x"] <= box["x"] + box["width"], f"the mark is under Map: {mark} in {box}")
        shot(page, "motion-tabs-settled-on-latest")
        tabs.get_by_role("link", name="Conversation").click()
        expect(page.locator("#project-composer")).to_have_value("PRIVATE draft kept across views")

    def test_04_keyboard_choice_has_the_same_feedback_and_keeps_focus(self):
        page = self.page()
        page.goto(f"/projects/{self.projects[0]}")
        self.stream_ready(page)
        self.link(page, 1).focus()
        page.keyboard.press("Enter")
        expect(page).to_have_url(re.compile(f"/projects/{self.projects[1]}$"))
        self.assert_glide_on(page, 1)
        expect(self.link(page, 1)).to_be_focused()
        tasks = page.get_by_role("navigation", name="Project views").get_by_role("link", name=re.compile("^Tasks"))
        tasks.focus()
        page.keyboard.press("Enter")
        expect(page.locator(".views .ui-tabs__indicator")).to_have_attribute("data-target", "tasks")
        expect(tasks).to_be_focused()

    def test_05_reduced_motion_places_at_once_without_any_animation(self):
        page = self.page(reduced=True)
        page.goto(f"/projects/{self.projects[0]}")
        self.stream_ready(page)
        durations = page.evaluate("""() => [document.querySelector('.side__glide'), document.querySelector('.views .ui-tabs__indicator')]
          .map(el => getComputedStyle(el).transitionDuration.split(',').every(value => parseFloat(value) === 0))""")
        self.assertEqual(durations, [True, True])
        self.link(page, 1).click()
        expect(page).to_have_url(re.compile(f"/projects/{self.projects[1]}$"))
        self.assertEqual(page.evaluate("() => document.getAnimations().filter(a => a.playState === 'running').length"), 0)
        self.assert_glide_on(page, 1)
        self.link(page, 0).click()
        feed = self.stream_ready(page)
        page.evaluate("() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")
        feed.evaluate("el => { el.scrollTop = el.scrollHeight; }")
        created = self.bob_posts_root("Reduced motion: the new note is simply there.")
        page.evaluate("() => window.dispatchEvent(new Event('focus'))")
        arrived = page.locator(f"#message-{created['messages'][0]['id']}")
        expect(arrived).to_be_visible()
        expect(arrived).to_have_attribute("data-arrival", "static")
        self.assertEqual(arrived.evaluate("el => el.getAnimations().length"), 0)

    def test_06_zoom_200_and_drawer_keep_the_highlight_on_its_row(self):
        # 200% zoom of a 1440×900 window is a 720×450 CSS viewport at twice the pixel density.
        page = self.page(viewport={"width": 720, "height": 450}, scale=2)
        page.goto(f"/projects/{self.projects[1]}")
        self.assert_glide_on(page, 1)
        self.assertLessEqual(page.evaluate("() => document.documentElement.scrollWidth"), 720)
        mark = page.locator(".views .ui-tabs__indicator").bounding_box()
        tab = page.get_by_role("navigation", name="Project views").get_by_role("link", name="Conversation").bounding_box()
        self.assertTrue(mark and tab and tab["x"] <= mark["x"] <= tab["x"] + tab["width"])
        shot(page, "motion-zoom-200")
        # The drawer inside a project: a narrow window keeps it (680 px and below). On a phone (640 px and
        # below) the top-left control inside a project leads back to all projects instead (#272).
        phone = self.page(viewport={"width": 660, "height": 900}, scale=2)
        phone.goto(f"/projects/{self.projects[2]}")
        phone.get_by_role("button", name="Open navigation").click()
        drawer = phone.locator("#nav-drawer")
        expect(drawer.locator(".side__glide")).to_have_attribute("data-target", self.projects[2])
        phone.wait_for_function("() => !document.querySelector('#nav-drawer .side__glide').getAnimations().length")
        geo = phone.evaluate("""(id) => { const g = document.querySelector('#nav-drawer .side__glide').getBoundingClientRect();
          const r = document.querySelector(`#nav-drawer .side__project[data-glide-id="${id}"]`).getBoundingClientRect(); return [g.top - r.top, g.height - r.height]; }""", self.projects[2])
        self.assertTrue(all(abs(value) <= 1.01 for value in geo), geo)
        shot(phone, "motion-phone-drawer")

    def test_06b_script_driven_motion_lasts_its_token_in_the_production_build(self):
        # #264: the minifier turns `--dur-3: 200ms` into `.2s`; read as a bare number that made the drawer's
        # slide 0.2 ms long, a jump in one frame. Slowed tenfold so the running animation can be read.
        phone = self.page(viewport={"width": 390, "height": 844}, scale=3)
        phone.goto(f"/projects/{self.projects[2]}")
        cdp = phone.context.new_cdp_session(phone)
        cdp.send("Animation.enable")
        cdp.send("Animation.setPlaybackRate", {"playbackRate": 0.1})
        token = phone.evaluate("() => getComputedStyle(document.documentElement).getPropertyValue('--dur-3').trim()")
        phone.get_by_role("button", name="Open navigation").click()
        phone.wait_for_function("() => document.querySelector('#nav-drawer')?.getAnimations().length > 0", timeout=5000)
        durations = phone.evaluate("() => document.querySelector('#nav-drawer').getAnimations().map((a) => a.effect.getTiming().duration)")
        self.assertTrue(durations and min(durations) >= 100, f"drawer slide lasts {durations} ms for --dur-3 = {token!r}")

    # ------------------------------------------------------------------ arrivals: gentle, only what is new and seen

    def test_07_only_genuinely_new_visible_entries_arrive_and_a_reader_is_never_moved(self):
        page = self.page(video=True)
        page.goto(f"/projects/{self.projects[0]}")
        feed = self.stream_ready(page)
        page.wait_for_timeout(600)
        # Restored history never animates.
        self.assertEqual(page.locator(".project-convo__feed.is-stream [data-arrival]").count(), 0)
        first = self.bob_posts_root("A new note from Bob: the sensor board arrived.")
        page.evaluate("() => window.dispatchEvent(new Event('focus'))")
        arrived = page.locator(f"#message-{first['messages'][0]['id']}")
        expect(arrived).to_be_in_viewport()
        expect(arrived).to_have_attribute("data-arrival", "animated")
        self.assertEqual(page.locator(".project-convo__feed.is-stream [data-arrival]").count(), 1)
        # A reader with earlier content is not moved; a quiet line says what is new below.
        feed.hover()
        page.mouse.wheel(0, -2400)
        page.wait_for_timeout(400)
        before = page.evaluate(FIRST_IN_VIEW)
        second = self.bob_posts_root("Another note from Bob while Ada reads earlier notes.")
        page.evaluate("() => window.dispatchEvent(new Event('focus'))")
        line = page.locator(".convo-newbelow")
        expect(line.get_by_role("button")).to_have_text("1 new message")
        late = page.locator(f"#message-{second['messages'][0]['id']}")
        expect(late).to_have_attribute("data-arrival", "static")
        page.wait_for_timeout(300)
        after = page.evaluate(FIRST_IN_VIEW)
        self.assertEqual(after["id"], before["id"])
        self.assertLess(abs(after["top"] - before["top"]), 2.01, f"the reader stays put: {before} -> {after}")
        shot(page, "motion-new-below")
        line.get_by_role("button").click()
        expect(late).to_be_in_viewport()
        expect(line.get_by_role("button")).to_have_count(0)
        # Earlier history loaded above never animates either: no entry of the stream is animated.
        page.evaluate("""() => { window.__entryAnimations = 0; const animate = Element.prototype.animate;
          Element.prototype.animate = function (...args) { if (this.matches?.('.project-convo__message, .convo-notice')) window.__entryAnimations++; return animate.apply(this, args); }; }""")
        loaded = page.locator(".project-convo__feed.is-stream li.project-convo__message").count()
        page.get_by_role("button", name="Load earlier messages").click()
        expect(page.locator(".project-convo__feed.is-stream li.project-convo__message")).not_to_have_count(loaded)
        self.assertGreater(page.locator(".project-convo__feed.is-stream li.project-convo__message").count(), loaded)
        page.wait_for_timeout(300)
        self.assertEqual(page.evaluate("() => window.__entryAnimations"), 0, "earlier roots joined without motion")

    def test_08_an_entry_arriving_under_a_modal_does_not_animate(self):
        page = self.page()
        page.goto(f"/projects/{self.projects[0]}")
        self.stream_ready(page)
        page.keyboard.press("Control+k")
        expect(page.locator('[aria-modal="true"]')).to_be_visible()
        created = self.bob_posts_root("A note that arrives while Jump to is open.")
        page.evaluate("() => window.dispatchEvent(new Event('focus'))")
        arrived = page.locator(f"#message-{created['messages'][0]['id']}")
        expect(arrived).to_have_attribute("data-arrival", "static")
        page.keyboard.press("Escape")

    def test_09_a_reply_arriving_in_an_open_thread_rises_gently_and_history_does_not(self):
        page = self.page()
        page.goto(f"/projects/{self.projects[0]}/conversations/{self.thread['id']}")
        thread = page.locator("#thread")
        expect(page.locator(".thread__feed")).not_to_have_attribute("aria-busy", "true")
        expect(thread.locator(".project-convo__message")).to_have_count(12)
        page.wait_for_timeout(600)
        self.assertEqual(thread.locator("[data-arrival]").count(), 0)
        reply = self.bob_replies("A new reply from Bob in the open thread.")
        page.evaluate("() => window.dispatchEvent(new Event('focus'))")
        arrived = page.locator(f"#message-{reply['id']}")
        expect(arrived).to_be_in_viewport()
        expect(arrived).to_have_attribute("data-arrival", "animated")
        self.assertEqual(thread.locator("[data-arrival]").count(), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
