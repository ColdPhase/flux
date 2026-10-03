"""Browser tests for the return view (issue #106, AC-6) and the private recap "What matters" (#133).

Runs with the other tests/ui journeys through scripts/check_ui.sh against the running Compose
application. Two people share one project. Nia looks at Home and the project, Ari changes things
while she is away, and Nia comes back: Home shows the personal return view with one next step;
in the project, "What matters" opens a private panel with the scope, the period, the next step
and the changes, "Summarize" quotes whole messages, sources open and return to the same snapshot,
and only "I have the context" moves the project's return point. Phone, failure, empty and race
cases are covered. Return points and summaries are read back from the API.
"""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, SHOTS, UPSTREAM, shot, start_forwarder

PASSWORD = "coming back is calm"
STAMP = int(time.time() * 1000)
ARI = {"name": "Ari Nowak", "email": f"ari.nowak+{STAMP}@example.test"}
NIA = {"name": "Nia Berg", "email": f"nia.berg+{STAMP}@example.test"}
OPENING = "Camera or sensor for the bedside lamp?"
QUESTION = "Nia, can you check the camera at 5 lux before Friday?"


def element_shot(name: str) -> dict:
    """Arguments for an element screenshot into the evidence folder, when one is configured."""
    return {"path": str(SHOTS / f"{name}.png")} if SHOTS else {}


class ReturnViewJourney(unittest.TestCase):
    """Tests run in name order and share two accounts and one project."""

    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    workspace_id: str = ""
    project_id: str = ""
    conversation_id: str = ""
    ids: dict[str, str] = {}

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

    def context(self, who: str | None, *, phone: bool = False) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "color_scheme": "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw"}
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=DESKTOP, device_scale_factor=1)
        if who and who in self.states:
            options["storage_state"] = self.states[who]
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        return context

    def page(self, who: str | None, **kwargs) -> Page:
        page = self.context(who, **kwargs).new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def api(self, page: Page, method: str, path: str, body: dict | None = None, status: int | None = None, headers: dict | None = None) -> dict:
        response = page.request.fetch(f"{ORIGIN}{path}", method=method,
                                      headers={"origin": ORIGIN, "content-type": "application/json", **(headers or {})},
                                      data=json.dumps(body) if body is not None else None)
        if status is not None:
            self.assertEqual(response.status, status, response.text())
        return json.loads(response.text()) if response.text() else {}

    def summary(self, page: Page, place: str) -> dict:
        query = "place=home" if place == "home" else f"place=project&id={self.project_id}"
        return self.api(page, "GET", f"/api/v1/return?{query}", status=200)

    def wait_saved(self, page: Page, place: str) -> None:
        """The view saves its point right after showing the summary; wait until the server has it."""
        for _ in range(40):
            if self.summary(page, place)["point"]["savedAt"] and not self.summary(page, place)["items"]:
                return
            page.wait_for_timeout(150)
        self.fail(f"return point for {place} was not saved")

    def point(self, page: Page) -> str | None:
        return self.summary(page, "project")["point"]["savedAt"]

    def open_recap(self, page: Page, *, tap: bool = False):
        button = page.get_by_role("button", name=re.compile("^What matters"))
        button.tap() if tap else button.click()
        panel = page.locator("#details")
        expect(panel.get_by_role("heading", name="What matters")).to_be_visible()
        expect(panel.get_by_role("radiogroup", name="Whose changes")).to_be_visible()
        return panel

    def have_context(self, page: Page, panel) -> None:
        panel.get_by_role("button", name="I have the context").click()
        expect(panel.get_by_role("heading", name="What matters")).to_have_count(0)

    def say(self, page: Page, body: str) -> str:
        return self.api(page, "POST", f"/api/v1/conversations/{self.conversation_id}/messages", {"body": body, "clientMessageId": str(uuid.uuid4())}, status=201)["id"]

    def no_horizontal_scroll(self, page: Page) -> None:
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), page.evaluate("window.innerWidth"))

    # ---------------------------------------------------------------- two people, one project

    def test_01_two_people_share_a_project(self) -> None:
        for key, person in (("ari", ARI), ("nia", NIA)):
            page = self.page(None)
            page.goto("/sign-up")
            page.get_by_label("Name").fill(person["name"])
            page.get_by_label("Email").fill(person["email"])
            page.get_by_label("Password").fill(PASSWORD)
            page.get_by_role("button", name="Create account").click()
            expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
            type(self).states[key] = page.context.storage_state()
            person["id"] = self.api(page, "GET", "/api/v1/me", status=200)["user"]["id"]
        ari = self.page("ari")
        ws = self.api(ari, "POST", "/api/v1/workspaces", {"name": "Lamp studio"}, status=201)
        self.api(ari, "POST", f"/api/v1/workspaces/{ws['id']}/members", {"email": NIA["email"], "role": "member"}, status=201)
        project = self.api(ari, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Gesture lamp", "visibility": "restricted"}, status=201)
        self.api(ari, "POST", f"/api/v1/projects/{project['id']}/grants", {"principal": {"kind": "human", "id": NIA["id"]}, "role": "contributor"}, status=201)
        type(self).workspace_id = ws["id"]
        type(self).project_id = project["id"]
        nia = self.page("nia")
        thread = self.api(nia, "POST", f"/api/v1/projects/{project['id']}/conversations", {"body": OPENING, "clientMessageId": str(uuid.uuid4())}, status=201)
        type(self).conversation_id = thread["id"]

    def test_02_viewing_saves_a_return_point_and_first_visits_are_quiet(self) -> None:
        page = self.page("nia")
        page.goto("/")
        expect(page.get_by_role("heading", name="Welcome, Nia")).to_be_visible()
        self.wait_saved(page, "home")
        page.goto(f"/projects/{self.project_id}/conversations/{self.conversation_id}")
        expect(page.get_by_role("heading", level=2, name=OPENING)).to_be_visible()
        # Opening a project no longer moves its point (#133); nothing competes with the conversation.
        expect(page.get_by_role("region", name="Since you left")).to_have_count(0)
        page.wait_for_timeout(500)
        self.assertIsNone(self.point(page), "viewing alone saves nothing")
        panel = self.open_recap(page)
        # Never viewed: the project starts from Home's point, which Nia just saw.
        expect(panel).to_contain_text(re.compile(r"Since \d+ \w+, \d\d:\d\d"))
        expect(panel).to_contain_text("Nothing new since your last visit.")
        self.have_context(page, panel)
        self.assertIsNotNone(self.point(page), "I have the context saves the point")

    # ---------------------------------------------------------------- Ari works while Nia is away

    def test_03_changes_happen_while_nia_is_away(self) -> None:
        ari = self.page("ari")
        p = self.project_id
        question = self.say(ari, QUESTION)
        self.say(ari, "I ordered a PIR sensor too, it should arrive on Wednesday.")
        rule = self.api(ari, "POST", f"/api/v1/projects/{p}/decisions", {"title": "Use the camera for gestures", "rationale": "It sees hand shapes"}, status=201)
        self.api(ari, "POST", f"/api/v1/decisions/{rule['id']}/accept", {}, status=200, headers={"if-match": '"1"'})
        pivot = self.api(ari, "POST", f"/api/v1/projects/{p}/decisions", {"title": "Exclude gestures in the dark; use the PIR sensor at night", "supersedes": rule["id"]}, status=201)
        self.api(ari, "POST", f"/api/v1/decisions/{pivot['id']}/accept", {}, status=200, headers={"if-match": '"1"'})
        task = self.api(ari, "POST", f"/api/v1/projects/{p}/work", {"title": "Mount the PIR sensor in the lamp base", "owner": {"kind": "human", "id": NIA["id"]}}, status=201)
        lens = self.api(ari, "POST", f"/api/v1/projects/{p}/work", {"title": "Order the wide-angle lens"}, status=201)
        self.api(ari, "PATCH", f"/api/v1/work/{lens['id']}", {"status": "blocked"}, status=200, headers={"if-match": '"1"'})
        result = self.api(ari, "POST", f"/api/v1/projects/{p}/results", {"title": "Camera misses 62% of gestures at 5 lux", "finding": "negative",
                                                                          "evidence": "20 gestures, bedside lamp at 5 lux", "work": [task["id"]]}, status=201)
        self.api(ari, "POST", f"/api/v1/projects/{p}/materials", {"clientMutationId": str(uuid.uuid4()), "title": "Low-light test plan", "body": "5 lux, 20 gestures, two people"}, status=201)
        self.api(ari, "POST", f"/api/v1/workspaces/{self.workspace_id}/sketches", {"title": "Sensing options", "scope": "project", "projectId": p}, status=201)
        type(self).ids = {"question": question, "pivot": pivot["id"], "result": result["id"]}

    # ---------------------------------------------------------------- Nia returns

    def test_04_home_shows_the_personal_return_view_with_one_next_step(self) -> None:
        page = self.page("nia")
        page.goto("/")
        region = page.get_by_role("region", name=re.compile("^Since you left"))
        expect(region).to_be_visible()
        # Eight updates plus the task thread that the result opened (#154): "Ari started “Camera misses 62% of gestures at 5 lux”".
        expect(region).to_contain_text("9 updates since today")
        expect(region).to_contain_text("3 need you")
        expect(region.get_by_role("heading", level=4, name="Gesture lamp")).to_be_visible()
        expect(region.locator(".since__next")).to_contain_text("Answer Ari's question")
        expect(region.locator(".since__next")).to_contain_text(f"“{QUESTION}” Ari asked you in “Camera or sensor for the bedside lamp?”.")
        # The next step is not repeated in the list below it.
        expect(region.locator(".since__item", has_text="Ari asked you")).to_have_count(0)
        expect(region.get_by_role("link", name=re.compile("Current rule changed: Exclude gestures in the dark"))).to_contain_text("Previously: Use the camera for gestures · No reason was recorded.")
        expect(region.get_by_role("link", name=re.compile("^Blocked: Order the wide-angle lens"))).to_contain_text("No reason was recorded.")
        # Home does not also claim that nothing is here.
        expect(page.get_by_text("Nothing here yet")).to_have_count(0)
        # No guilt: nothing to clear and no badges in the rail.
        expect(page.get_by_role("button", name=re.compile("Mark all", re.I))).to_have_count(0)
        shot(page, "return-home-desktop-1440")
        # Visiting acknowledges nothing (HOME-1, #190): a reload shows the same list, and only
        # "I have the context" moves Home's point.
        page.reload()
        expect(region).to_contain_text("9 updates since today")
        self.assertTrue(self.summary(page, "home")["items"], "the visit saved nothing")
        expect(region).to_contain_text("Last caught up")
        region.get_by_role("button", name="I have the context").click()
        done = page.get_by_role("status").filter(has_text="You’re caught up. New changes will show here.")
        expect(done).to_be_visible()
        # Focus moves to the Home heading (#190 A1.3); the status line says what happened.
        expect(page.locator("header.top").get_by_role("heading", level=1, name="Home")).to_be_focused()
        expect(page.get_by_role("region", name=re.compile("^Since you left"))).to_have_count(0)
        self.wait_saved(page, "home")

    def test_05_what_matters_shows_the_next_step_changes_and_a_digest(self) -> None:
        page = self.page("nia")
        page.goto(f"/projects/{self.project_id}/conversations/{self.conversation_id}")
        entry = page.get_by_role("button", name=re.compile("^What matters"))
        expect(entry).to_contain_text("3")
        # A compact entry, not a block competing with the conversation (#133 AC-1).
        box = entry.bounding_box()
        assert box
        self.assertLessEqual(box["height"], 40)
        self.assertLessEqual(box["width"], 200)
        shot(page, "recap-project-desktop-1440-closed")
        entry.focus()
        page.keyboard.press("Enter")
        panel = page.locator("#details")
        expect(panel.get_by_role("heading", name="What matters")).to_be_visible()
        expect(panel.get_by_role("radio", name="Whole project")).to_have_attribute("aria-checked", "true")
        expect(panel).to_contain_text(re.compile(r"Since \w+ \d+, \d\d:\d\d|Since \d+ \w+, \d\d:\d\d"))
        expect(panel.locator(".since__next")).to_contain_text("Answer Ari's question")
        needs = panel.locator("section[aria-labelledby=wm-needs] .since__item")
        expect(needs).to_have_count(2)
        changes = panel.locator("section[aria-labelledby=wm-changes] .since__item")
        expect(changes).to_have_count(6)
        expect(changes.filter(has_text="Ari started “Camera misses 62% of gestures at 5 lux”")).to_have_count(1)
        expect(panel.get_by_role("link", name=re.compile("Ari recorded a result: Camera misses 62% of gestures"))).to_contain_text("It did not work out, about “Mount the PIR sensor in the lamp base”")
        expect(panel.get_by_role("link", name=re.compile("New material: Low-light test plan"))).to_have_attribute("href", re.compile(r"^/materials/.+/versions/1$"))
        # The conversation stays readable beside the panel.
        expect(page.locator(f"#message-{self.ids['question']}")).to_be_visible()
        # Summarize is sized to its label; the completion action keeps its full width.
        summarize = panel.get_by_role("button", name="Summarize")
        s_box = summarize.bounding_box()
        done_box = panel.get_by_role("button", name="I have the context").bounding_box()
        assert s_box and done_box
        self.assertLessEqual(s_box["height"], 36)
        self.assertGreaterEqual(s_box["height"], 32)
        self.assertLess(s_box["width"], done_box["width"] / 2)
        self.assertGreaterEqual(done_box["height"], 36)
        shot(page, "recap-project-desktop-1440-open")
        # AC-1: two local treatments of Summarize in the same panel. The soft one (shipped) and a
        # compact accent button, rendered side by side as evidence; the class change is test-only.
        panel.locator("section[aria-labelledby=wm-changes] .wm-sec__head").screenshot(**element_shot("recap-summarize-soft-1440"))
        summarize.evaluate("(button) => button.classList.replace('ui-btn--secondary', 'ui-btn--primary')")
        panel.locator("section[aria-labelledby=wm-changes] .wm-sec__head").screenshot(**element_shot("recap-summarize-accent-1440"))
        shot(page, "recap-project-desktop-1440-summarize-accent")
        summarize.evaluate("(button) => button.classList.replace('ui-btn--primary', 'ui-btn--secondary')")
        summarize.click()
        digest = panel.locator("section[aria-labelledby=wm-digest]")
        expect(digest).to_contain_text("No AI")
        quote = digest.get_by_role("link", name=re.compile(re.escape(QUESTION)))
        expect(quote).to_have_attribute("href", re.compile(f"#message-{self.ids['question']}$"))
        expect(digest).to_contain_text("I ordered a PIR sensor too")
        # The result, and the opening of the task thread it created (#154), both quote the finding.
        expect(digest.get_by_role("link", name=re.compile("Camera misses 62% of gestures")).first).to_be_visible()
        # The quotes themselves, scrolled into view and clear of the footer.
        quote.scroll_into_view_if_needed()
        q_box, f_box = quote.bounding_box(), panel.get_by_role("button", name="I have the context").bounding_box()
        assert q_box and f_box
        self.assertLessEqual(q_box["y"] + q_box["height"], f_box["y"], "a quote scrolls clear of the footer")
        shot(page, "recap-project-desktop-1440-digest")

        # Relevant to me: the material and the sketch are not Nia's, the question and her task are.
        panel.get_by_role("radio", name="Relevant to me").click()
        expect(panel.get_by_role("link", name=re.compile("New material: Low-light test plan"))).to_have_count(0)
        expect(panel.locator(".since__next")).to_contain_text("Answer Ari's question")
        expect(panel.get_by_role("link", name=re.compile("added a task for you: Mount the PIR sensor"))).to_be_visible()
        panel.locator(".wm__scroll").evaluate("(el) => { el.scrollTop = 0; }")
        shot(page, "recap-project-desktop-1440-relevant-to-me")
        panel.get_by_role("radio", name="Whole project").click()
        expect(panel.get_by_role("link", name=re.compile("New material: Low-light test plan"))).to_be_visible()

        # A decision opens in Details; "What matters" comes back with the same snapshot and digest.
        panel.get_by_role("link", name=re.compile("Current rule changed")).click()
        expect(panel.get_by_role("heading", name="Exclude gestures in the dark; use the PIR sensor at night")).to_be_visible()
        self.open_recap(page)
        expect(panel.locator("section[aria-labelledby=wm-digest]")).to_contain_text("I ordered a PIR sensor too")

        # The question opens on the whole message; the docked panel stays.
        panel.locator(".since__next").get_by_role("link", name="Answer Ari's question").click()
        expect(page).to_have_url(re.compile(f"#message-{self.ids['question']}$"))
        message = page.locator(f"#message-{self.ids['question']}")
        expect(message).to_have_class(re.compile("is-arrived"))
        expect(message).to_be_in_viewport()
        # Reading, choosing a scope and opening sources never moved the point.
        before = self.summary(page, "project")
        self.assertEqual(len([item for item in before["items"] if item["needsYou"]]), 3)
        self.have_context(page, panel)
        self.assertEqual(self.summary(page, "project")["items"], [], "the point moved to what was shown")
        expect(entry).not_to_contain_text("3")

    def test_06_closing_without_context_keeps_the_point_and_newer_changes_wait(self) -> None:
        page = self.page("nia")
        ari = self.page("ari")
        self.say(ari, "Nia, which PIR model did you pick?")
        page.goto(f"/projects/{self.project_id}")
        panel = self.open_recap(page)
        expect(panel.locator(".since__next")).to_contain_text("Answer Ari's question")
        page.keyboard.press("Escape")
        expect(panel.get_by_role("heading", name="What matters")).to_have_count(0)
        page.reload()
        panel = self.open_recap(page)
        expect(panel.locator(".since__next")).to_contain_text("which PIR model did you pick")
        # A change while reading is announced and does not reshuffle the list.
        self.say(ari, "Also: the lens arrived.")
        expect(panel.get_by_role("status").filter(has_text="Newer changes arrived")).to_be_visible(timeout=40000)
        expect(panel).not_to_contain_text("the lens arrived")
        panel.get_by_role("button", name="Show them").click()
        expect(panel).to_contain_text("the lens arrived")
        self.have_context(page, panel)
        page.reload()
        panel = self.open_recap(page)
        expect(panel).to_contain_text("Nothing new since your last visit.")
        shot(page, "recap-project-desktop-1440-empty")
        panel.get_by_role("button", name="Look at the last 7 days").click()
        expect(panel).to_contain_text("Last 7 days")
        expect(panel.locator(".since__item").first).to_be_visible()
        # Looking back never moves the point.
        page.keyboard.press("Escape")
        self.assertEqual(self.summary(page, "project")["items"], [])

    def test_06b_a_late_answer_for_the_old_scope_is_dropped_and_failures_are_honest(self) -> None:
        ari = self.page("ari")
        self.say(ari, "Nia, is the clip printed?")
        # A conversation Nia is not part of: in the whole project, not in "relevant to me".
        self.api(ari, "POST", f"/api/v1/projects/{self.project_id}/conversations", {"body": "Which shade of grey for the base?", "clientMessageId": str(uuid.uuid4())}, status=201)
        page = self.page("nia")
        # Load the project first (its header count asks the same whole-project question).
        with page.expect_response(re.compile(r"/api/v1/return\?.*scope=all")):
            page.goto(f"/projects/{self.project_id}")
        held: list = []
        pattern = re.compile(r"/api/v1/return\?.*scope=all.*from=last-visit")
        page.route(pattern, lambda route: held.append(route) if not held else route.continue_())
        page.get_by_role("button", name=re.compile("^What matters")).click()
        panel = page.locator("#details")
        for _ in range(40):
            if held:
                break
            page.wait_for_timeout(50)
        self.assertTrue(held, "the whole-project request is in flight")
        expect(panel.get_by_role("status").filter(has_text="Loading")).to_be_visible()
        shot(page, "recap-project-desktop-1440-loading")
        panel.get_by_role("radio", name="Relevant to me").click()
        expect(panel.locator(".since__next")).to_contain_text("is the clip printed")
        held[0].continue_()
        page.wait_for_timeout(800)
        # The whole-project answer arrived last and was dropped: the list is still "relevant to me".
        expect(panel.get_by_role("radio", name="Relevant to me")).to_have_attribute("aria-checked", "true")
        expect(panel.get_by_role("link", name=re.compile("Which shade of grey"))).to_have_count(0)
        expect(panel.locator(".wm__body.is-loading")).to_have_count(0)
        panel.get_by_role("radio", name="Whole project").click()
        expect(panel.get_by_role("link", name=re.compile("Which shade of grey"))).to_be_visible()
        page.keyboard.press("Escape")

        # A failed load says so and retries.
        broken = self.page("nia")
        broken.goto(f"/projects/{self.project_id}")
        failing = re.compile(r"/api/v1/return\?.*scope=")
        broken.route(failing, lambda route: route.fulfill(status=503, body="{}", content_type="application/json"))
        broken.get_by_role("button", name=re.compile("^What matters")).click()
        bpanel = broken.locator("#details")
        expect(bpanel.get_by_role("alert")).to_contain_text("Could not load what matters.")
        shot(broken, "recap-project-desktop-1440-failure")
        broken.unroute(failing)
        bpanel.get_by_role("button", name="Try again").click()
        expect(bpanel.locator(".since__next")).to_contain_text("is the clip printed")

        # A project with no messages: a truthful empty state; a result without messages still shows.
        quiet = self.api(ari, "POST", f"/api/v1/workspaces/{self.workspace_id}/projects", {"name": "Quiet shelf", "visibility": "restricted"}, status=201)
        self.api(ari, "POST", f"/api/v1/projects/{quiet['id']}/grants", {"principal": {"kind": "human", "id": NIA["id"]}, "role": "contributor"}, status=201)
        broken.goto(f"/projects/{quiet['id']}")
        qpanel = self.open_recap(broken)
        # A new project starts from Nia's Home point; nothing happened in it since.
        expect(qpanel).to_contain_text("Nothing new since your last visit.")
        broken.keyboard.press("Escape")
        self.api(ari, "POST", f"/api/v1/projects/{quiet['id']}/results", {"title": "Shelf holds 4 kg", "finding": "positive", "evidence": "sandbags"}, status=201)
        broken.reload()
        qpanel = self.open_recap(broken)
        expect(qpanel.get_by_role("link", name=re.compile("Ari recorded a result: Shelf holds 4 kg"))).to_be_visible()
        qpanel.get_by_role("button", name="Summarize").click()
        expect(qpanel.locator("section[aria-labelledby=wm-digest]")).to_contain_text("Shelf holds 4 kg")

    def test_06c_a_late_newer_check_for_the_old_scope_announces_nothing(self) -> None:
        """The background check for newer changes belongs to its scope: a late answer after a switch is dropped."""
        ari = self.page("ari")
        page = self.page("nia")
        page.goto(f"/projects/{self.project_id}")
        panel = self.open_recap(page)
        expect(panel.get_by_role("radio", name="Whole project")).to_have_attribute("aria-checked", "true")
        # A whole-project change Nia is not part of, then hold the next background check (no `until`).
        other = self.api(ari, "POST", f"/api/v1/projects/{self.project_id}/conversations", {"body": "Which screws for the base plate?", "clientMessageId": str(uuid.uuid4())}, status=201)
        self.api(ari, "POST", f"/api/v1/conversations/{other['id']}/messages", {"body": "M3, 8 mm.", "clientMessageId": str(uuid.uuid4())}, status=201)
        held: list = []
        poll = re.compile(r"/api/v1/return\?(?!.*until=).*scope=all")
        page.route(poll, lambda route: held.append(route) if not held else route.continue_())
        for _ in range(90):
            if held:
                break
            page.wait_for_timeout(500)
        self.assertTrue(held, "the background check ran and is held")
        panel.get_by_role("radio", name="Relevant to me").click()
        expect(panel.get_by_role("radio", name="Relevant to me")).to_have_attribute("aria-checked", "true")
        expect(panel.locator(".wm__body.is-loading")).to_have_count(0)
        held[0].continue_()
        page.wait_for_timeout(1500)
        expect(panel.get_by_role("status").filter(has_text="Newer changes arrived")).to_have_count(0)
        page.unroute(poll)

    def context_at(self, who: str, viewport: dict, phone: bool, scheme: str = "light") -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": scheme, "locale": "en-GB", "timezone_id": "Europe/Warsaw",
                         "viewport": viewport, "device_scale_factor": 3 if phone else 1, "storage_state": self.states[who]}
        if phone:
            options.update(is_mobile=True, has_touch=True)
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def restore(self, page: Page, *places: dict) -> None:
        for place in places:
            self.api(page, "POST", "/api/v1/return-points/restore", {"place": place}, status=200)

    def test_07b_context_taken_in_a_project_is_not_asked_again_on_home(self) -> None:
        """HOME-1 (#190): Home uses the latest point below it, so the project's acknowledgement clears its items there."""
        ari = self.page("ari")
        line = f"Late note {STAMP}: the clip printed fine."
        self.say(ari, line)
        page = self.page("nia")
        page.goto("/")
        expect(page.get_by_role("region", name=re.compile("^Since you left"))).to_contain_text("the clip printed fine")
        page.goto(f"/projects/{self.project_id}/conversations/{self.conversation_id}")
        self.have_context(page, self.open_recap(page))
        page.goto("/")
        expect(page.get_by_role("heading", name="Welcome, Nia")).to_be_visible()
        page.wait_for_timeout(500)
        expect(page.get_by_text("the clip printed fine")).to_have_count(0)
        self.assertFalse(any("the clip printed fine" in item["text"] + (item.get("detail") or "") for item in self.summary(page, "home")["items"]))

    def test_08_matched_viewports_navigation_audience_and_composer(self) -> None:
        """Same state at 1440x900, 1280x800 and 390x844 (100% zoom): Home, the project line above a real feed, then live navigation."""
        ari = self.page("ari")
        self.say(ari, "The PIR mount fits, but the cable needs 2 cm more slack. Nia, can you print the clip with the longer channel?")
        self.api(ari, "POST", f"/api/v1/projects/{self.project_id}/decisions", {"title": "Route the cable through the lamp stem", "rationale": "Keeps the base flat"}, status=201)
        self.api(ari, "POST", f"/api/v1/projects/{self.project_id}/work", {"title": "Print a new cable clip", "owner": {"kind": "human", "id": NIA["id"]}}, status=201)
        project = {"type": "project", "id": self.project_id}
        conversation = {"type": "conversation", "id": self.conversation_id}
        for label, viewport, phone in (("desktop-1440", {"width": 1440, "height": 900}, False),
                                       ("desktop-1280", {"width": 1280, "height": 800}, False),
                                       ("tablet-768", {"width": 768, "height": 1024}, True),
                                       ("phone-390", {"width": 390, "height": 844}, True)):
            page = self.context_at("nia", viewport, phone)
            page.goto("/")
            region = page.get_by_role("region", name=re.compile("^Since you left"))
            expect(region.locator(".since__next")).to_contain_text("Answer Ari's question")
            self.no_horizontal_scroll(page)
            shot(page, f"matched-home-{label}")
            # Visiting saved nothing (HOME-1), so the next viewport shows the same state.
            self.assertTrue(self.summary(page, "home")["items"], "visiting Home saved nothing")
            page.goto(f"/projects/{self.project_id}/conversations/{self.conversation_id}")
            # The conversation comes first; "What matters" is one compact entry in the header.
            expect(page.locator(".project-convo__message", has_text="The PIR mount fits, but the cable needs 2 cm more slack.")).to_be_visible()
            self.no_horizontal_scroll(page)
            shot(page, f"matched-project-{label}-closed")
            panel = self.open_recap(page, tap=phone)
            # Useful content is in the first screen of the panel and the footer action is reachable.
            next_step = panel.locator(".since__next")
            expect(next_step).to_be_in_viewport()
            done = panel.get_by_role("button", name="I have the context")
            expect(done).to_be_in_viewport()
            step_box, done_box = next_step.bounding_box(), done.bounding_box()
            assert step_box and done_box
            self.assertLess(step_box["y"] + step_box["height"], done_box["y"], "the next step is above the footer")
            last = panel.locator(".since__item").last
            last.scroll_into_view_if_needed()
            last_box = last.bounding_box()
            assert last_box
            self.assertLessEqual(last_box["y"] + last_box["height"], done_box["y"] + 1, "every item can scroll clear of the footer")
            self.no_horizontal_scroll(page)
            shot(page, f"matched-project-{label}-panel")
            if phone:
                panel.get_by_role("button", name="Close what matters").tap()
            else:
                page.keyboard.press("Escape")
            self.assertEqual(len(self.summary(page, "project")["items"]) > 0, True, "closing kept the point")

        # Navigation from Home: the next step opens the project on the whole message it names.
        page = self.page("nia")
        page.goto("/")
        page.get_by_role("region", name=re.compile("^Since you left")).get_by_role("link", name="Answer Ari's question").click()
        expect(page).to_have_url(re.compile(f"/projects/{self.project_id}/conversations/{self.conversation_id}#message-"))
        expect(page.locator(".is-arrived")).to_be_in_viewport()
        # "What matters" counts the same changes (the project point is older than Home's view).
        expect(page.get_by_role("button", name=re.compile("^What matters"))).to_contain_text(re.compile(r"\d"))
        # Audience preview before writing: the composer names who will read the reply.
        expect(page.locator(".composer__audience")).to_have_text(re.compile("Ari and you · only you two · saved to Gesture lamp"))
        # Back on Home the list is still there: following a link acknowledges nothing (HOME-1). After
        # "I have the context" only the server's fresh answer is shown: nothing repeats.
        page.get_by_role("link", name="Home").first.click()
        expect(page.get_by_role("heading", name="Welcome, Nia")).to_be_visible()
        home = page.get_by_role("region", name=re.compile("^Since you left"))
        expect(home).to_be_visible()
        home.get_by_role("button", name="I have the context").click()
        expect(page.get_by_role("region", name=re.compile("^Since you left"))).to_have_count(0)
        page.reload()
        expect(page.get_by_role("heading", name="Welcome, Nia")).to_be_visible()
        expect(page.get_by_role("region", name=re.compile("^Since you left"))).to_have_count(0)

        # Phone composer: after reading the line, the reply box is reachable, keeps its audience and sends.
        phone = self.page("nia", phone=True)
        phone.goto(f"/projects/{self.project_id}/conversations/{self.conversation_id}")
        composer = phone.locator("#project-composer")
        composer.tap()
        composer.fill("Thanks, I will print the clip tonight.")
        expect(composer).to_be_in_viewport()
        expect(phone.locator(".composer__audience")).to_be_in_viewport()
        self.no_horizontal_scroll(phone)
        shot(phone, "matched-project-phone-390-composer")
        phone.get_by_role("button", name="Send reply").tap()
        expect(phone.locator(".project-convo__message", has_text="Thanks, I will print the clip tonight.")).to_be_visible()

    def sign_in(self, page: Page, person: dict) -> None:
        page.goto("/sign-in")
        page.get_by_label("Email").fill(person["email"])
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Sign in").click()

    def test_09_same_tab_account_switch_never_shows_the_previous_persons_items(self) -> None:
        """AC-5 in the client: nothing from one account's return view survives into the next, even before the API answers."""
        secret = f"Restricted launch note {STAMP}: Nia, can you keep the 14 Nov date quiet?"
        olek = {"name": "Olek Wiatr", "email": f"olek.wiatr+{STAMP}@example.test"}
        signup = self.page(None)
        signup.goto("/sign-up")
        signup.get_by_label("Name").fill(olek["name"])
        signup.get_by_label("Email").fill(olek["email"])
        signup.get_by_label("Password").fill(PASSWORD)
        signup.get_by_role("button", name="Create account").click()
        expect(signup.get_by_role("heading", level=1, name="Home")).to_be_visible()
        ari = self.page("ari")
        self.api(ari, "POST", f"/api/v1/workspaces/{self.workspace_id}/members", {"email": olek["email"], "role": "member"}, status=201)
        # Olek has a Home point (so he would see anything visible to him), then Ari writes in the restricted project.
        self.api(signup, "PUT", "/api/v1/return-points", {"place": {"type": "home"}, "mark": self.summary(signup, "home")["mark"]}, status=200)
        self.say(ari, secret)

        # One tab: Nia signs in fresh and sees the restricted item on Home.
        page = self.page(None)
        self.sign_in(page, NIA)
        region = page.get_by_role("region", name=re.compile("^Since you left"))
        expect(region).to_contain_text("keep the 14 Nov date quiet")
        # Sign out in the same tab and sign in as Olek, with the return API held back.
        page.get_by_role("button", name=re.compile("Nia Berg")).click()
        page.get_by_role("dialog", name="Account").get_by_role("button", name="Sign out").click()
        expect(page).to_have_url(re.compile("/sign-in"))
        held: list = []
        summary_url = re.compile(r"/api/v1/return\?")
        page.route(summary_url, lambda route: held.append(route))
        self.sign_in(page, olek)
        expect(page.get_by_role("heading", name="Welcome, Olek")).to_be_visible()
        for _ in range(40):
            if held:
                break
            page.wait_for_timeout(50)
        self.assertTrue(held, "the Home summary request was made")
        # Before the answer: nothing of Nia's return view is on the page.
        self.assertNotIn("14 Nov", page.content())
        expect(page.get_by_role("region", name=re.compile("^Since you left"))).to_have_count(0)
        for route in held:
            route.continue_()
        page.unroute(summary_url)
        page.wait_for_timeout(600)
        # After Olek's authorized answer: still nothing of it, and no hint of the restricted project.
        self.assertNotIn("14 Nov", page.content())
        self.assertNotIn("Gesture lamp", page.locator("#content").inner_text())

    def test_10_revoked_items_disappear_even_when_the_fresh_answer_is_empty(self) -> None:
        ari = self.page("ari")
        page = self.page("nia")
        line = f"Before the change {STAMP}: Nia, can you confirm the lens order?"
        self.say(ari, line)
        page.goto("/")
        region = page.get_by_role("region", name=re.compile("^Since you left"))
        expect(region).to_contain_text("confirm the lens order")
        region.get_by_role("button", name="I have the context").click()
        self.wait_saved(page, "home")
        # Nia loses access; her Home point is also moved back, so only authorization can hide the item.
        self.api(ari, "POST", f"/api/v1/projects/{self.project_id}/grants", {"principal": {"kind": "human", "id": NIA["id"]}, "role": "denied"}, status=201)
        self.api(page, "POST", "/api/v1/return-points/restore", {"place": {"type": "home"}}, status=200)
        fresh = self.summary(page, "home")
        self.assertEqual(fresh["items"], [], "the server's fresh answer is empty")
        # Navigating within the app, then reloading: the item is gone both times.
        views = page.get_by_role("navigation", name="Views")
        views.get_by_role("link", name="Wiki").click()
        expect(page.get_by_role("heading", name="No docs yet")).to_be_visible()
        views.get_by_role("link", name="Conversation").click()
        expect(page.get_by_role("heading", name="Welcome, Nia")).to_be_visible()
        page.wait_for_timeout(600)
        self.assertNotIn("confirm the lens order", page.content())
        expect(page.get_by_role("region", name=re.compile("^Since you left"))).to_have_count(0)
        page.reload()
        expect(page.get_by_role("heading", name="Welcome, Nia")).to_be_visible()
        page.wait_for_timeout(600)
        self.assertNotIn("confirm the lens order", page.content())

    def test_07_phone_layout(self) -> None:
        ari = self.page("ari")
        self.say(ari, "Nia, can you send me a photo of the PIR mount when it is in?")
        self.api(ari, "POST", f"/api/v1/projects/{self.project_id}/results", {"title": "PIR sees a hand at 1.2 m in the dark", "finding": "positive", "evidence": "10 of 10 in a dark room"}, status=201)
        page = self.page("nia", phone=True)
        page.goto("/")
        region = page.get_by_role("region", name=re.compile("^Since you left"))
        expect(region.locator(".since__next")).to_contain_text("Answer Ari's question")
        self.no_horizontal_scroll(page)
        shot(page, "return-home-phone-390")
        acknowledge = region.get_by_role("button", name="I have the context").bounding_box()
        assert acknowledge
        self.assertGreaterEqual(acknowledge["height"], 43.5, "touch target")
        page.goto(f"/projects/{self.project_id}/conversations/{self.conversation_id}")
        entry = page.get_by_role("button", name=re.compile("^What matters"))
        box = entry.bounding_box()
        assert box is not None
        self.assertGreaterEqual(min(box["width"], box["height"]), 43.5, "touch target")
        self.no_horizontal_scroll(page)
        shot(page, "recap-project-phone-390-closed")
        panel = self.open_recap(page, tap=True)
        sheet = page.get_by_role("dialog", name="What matters")
        expect(sheet).to_be_visible()
        # The first screen has the scope, the period and the next step; no repeated setup copy.
        expect(panel.locator(".since__next")).to_be_in_viewport()
        expect(panel.get_by_role("button", name="I have the context")).to_be_in_viewport()
        for control in (panel.get_by_role("radio", name="Whole project"), panel.get_by_role("radio", name="Relevant to me"),
                        panel.get_by_role("button", name="Summarize"), panel.get_by_role("button", name="I have the context")):
            control_box = control.bounding_box()
            assert control_box is not None
            self.assertGreaterEqual(control_box["height"], 43.5)
        self.no_horizontal_scroll(page)
        shot(page, "recap-project-phone-390-open")
        panel.get_by_role("button", name="Summarize").tap()
        digest = panel.locator("section[aria-labelledby=wm-digest]")
        expect(digest).to_contain_text("photo of the PIR mount")
        # The quotes themselves, scrolled into view, with their opening cue and clear of the footer.
        quote = digest.locator(".wm-quote").first
        quote.scroll_into_view_if_needed()
        expect(quote.locator(".wm-quote__go")).to_be_visible()
        q_box, f_box = quote.bounding_box(), panel.get_by_role("button", name="I have the context").bounding_box()
        assert q_box and f_box
        self.assertLessEqual(q_box["y"] + q_box["height"], f_box["y"], "a quote scrolls clear of the footer on a phone")
        shot(page, "recap-project-phone-390-digest")
        # A source closes the sheet on the phone and opens the whole message; reopening returns to
        # the same snapshot with the digest still open.
        panel.locator(".since__next").get_by_role("link", name="Answer Ari's question").tap()
        expect(page.locator(".is-arrived")).to_contain_text("photo of the PIR mount")
        panel = self.open_recap(page, tap=True)
        expect(panel.locator("section[aria-labelledby=wm-digest]")).to_contain_text("photo of the PIR mount")
        expect(panel.get_by_role("link", name=re.compile("Ari recorded a result: PIR sees a hand"))).to_be_visible()
        # Enlarged text keeps the footer reachable and the page without sideways scroll.
        page.evaluate("document.documentElement.style.fontSize = '125%'")
        expect(panel.get_by_role("button", name="I have the context")).to_be_in_viewport()
        self.no_horizontal_scroll(page)
        big_quote = panel.locator("section[aria-labelledby=wm-digest] .wm-quote").first
        big_quote.scroll_into_view_if_needed()
        q_box, f_box = big_quote.bounding_box(), panel.get_by_role("button", name="I have the context").bounding_box()
        assert q_box and f_box
        self.assertLessEqual(q_box["y"] + q_box["height"], f_box["y"], "a quote scrolls clear of the footer with enlarged text")
        shot(page, "recap-project-phone-390-text-125")
        page.evaluate("document.documentElement.style.fontSize = ''")
        panel.get_by_role("button", name="I have the context").tap()
        expect(sheet).to_have_count(0)
        expect(entry).to_be_focused()

    def test_09b_dark_renders_of_the_panel(self) -> None:
        """What matters in the dark theme at 1440x900 and 390x844, with the digest open."""
        ari = self.page("ari")
        self.say(ari, "Nia, can you share the dark-room numbers before Friday?")
        for label, viewport, phone in (("desktop-1440", {"width": 1440, "height": 900}, False),
                                       ("phone-390", {"width": 390, "height": 844}, True)):
            page = self.context_at("nia", viewport, phone, scheme="dark")
            page.goto(f"/projects/{self.project_id}/conversations/{self.conversation_id}")
            panel = self.open_recap(page, tap=phone)
            expect(panel.locator(".since__next")).to_contain_text("Answer Ari's question")
            summarize = panel.get_by_role("button", name="Summarize")
            if phone:
                summarize.tap()
            else:
                summarize.click()
            expect(panel.locator("section[aria-labelledby=wm-digest]")).to_contain_text("dark-room numbers")
            self.no_horizontal_scroll(page)
            shot(page, f"recap-project-{label}-dark")


if __name__ == "__main__":
    unittest.main()
