"""Browser tests for the return view, "Since you left" (issue #106, AC-6).

Runs with the other tests/ui journeys through scripts/check_ui.sh against the running Compose
application. Two people share one project. Nia looks at Home and the project, Ari changes things
while she is away, and Nia comes back: Home shows the personal return view with one next step,
the project shows the slim line that expands into a short list, a source opens on the whole
message, "Keep these for next time" moves the saved point back, and the phone layout is checked.
Return points and summaries are read back from the API, so the test proves persisted behaviour.
"""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

PASSWORD = "coming back is calm"
STAMP = int(time.time() * 1000)
ARI = {"name": "Ari Nowak", "email": f"ari.nowak+{STAMP}@example.test"}
NIA = {"name": "Nia Berg", "email": f"nia.berg+{STAMP}@example.test"}
OPENING = "Camera or sensor for the bedside lamp?"
QUESTION = "Nia, can you check the camera at 5 lux before Friday?"


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
        expect(page.get_by_role("region", name="Since you left")).to_have_count(0)
        self.wait_saved(page, "project")

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
        expect(region).to_contain_text("8 updates since today")
        expect(region).to_contain_text("3 need you")
        expect(region.get_by_role("heading", level=4, name="Gesture lamp")).to_be_visible()
        expect(region.locator(".since__next")).to_contain_text("Answer Ari's question")
        expect(region.locator(".since__next")).to_contain_text(f"Ari asked you in “Camera or sensor for the bedside lamp?”: “{QUESTION}”")
        # The next step is not repeated in the list below it.
        expect(region.locator(".since__item", has_text="Ari asked you")).to_have_count(0)
        expect(region.get_by_role("link", name=re.compile("Current rule changed: Exclude gestures in the dark"))).to_contain_text("Previously: Use the camera for gestures · No reason was recorded.")
        expect(region.get_by_role("link", name=re.compile("^Blocked: Order the wide-angle lens"))).to_contain_text("No reason was recorded.")
        # Home does not also claim that nothing is here.
        expect(page.get_by_text("Nothing here yet")).to_have_count(0)
        # No guilt: nothing to clear and no badges in the rail.
        expect(page.get_by_role("button", name=re.compile("Mark all", re.I))).to_have_count(0)
        shot(page, "return-home-desktop-1440")
        self.wait_saved(page, "home")

    def test_05_project_line_expands_into_a_short_list(self) -> None:
        page = self.page("nia")
        page.goto(f"/projects/{self.project_id}/conversations/{self.conversation_id}")
        line = page.get_by_role("region", name="Since you left")
        toggle = line.get_by_role("button", name=re.compile("8 updates since today"))
        expect(toggle).to_be_visible()
        expect(toggle).to_contain_text("3 need you")
        expect(toggle).to_have_attribute("aria-expanded", "false")
        expect(line.get_by_role("link", name="Answer Ari's question")).to_be_hidden()
        shot(page, "return-project-desktop-1440-collapsed")
        toggle.focus()
        page.keyboard.press("Enter")
        expect(toggle).to_have_attribute("aria-expanded", "true")
        items = line.locator(".since__item")
        # The next step is the question; the list shows the rest, whole rows only, six at first.
        expect(items).to_have_count(6)
        line.get_by_role("button", name="Show 1 more").click()
        expect(items).to_have_count(7)
        # What needs Nia comes first, in human language.
        expect(items.nth(0)).to_contain_text("needs you")
        expect(line.locator(".since__next")).to_contain_text("Answer Ari's question")
        expect(line.get_by_role("link", name=re.compile("Ari recorded a result: Camera misses 62% of gestures"))).to_contain_text("It did not work out, about “Mount the PIR sensor in the lamp base”")
        expect(line.get_by_role("link", name=re.compile("Ari replied in “Camera or sensor"))).to_contain_text("I ordered a PIR sensor too")
        expect(line.get_by_role("link", name=re.compile("New material: Low-light test plan"))).to_have_attribute("href", re.compile(r"^/materials/.+/versions/1$"))
        expect(line.get_by_role("link", name=re.compile("Ari started a sketch: Sensing options"))).to_have_attribute("href", re.compile(r"^/map/"))
        shot(page, "return-project-desktop-1440-expanded")

        # A decision opens in Details on its project.
        line.get_by_role("link", name=re.compile("Current rule changed")).click()
        expect(page.locator("#details").get_by_role("heading", name="Exclude gestures in the dark; use the PIR sensor at night")).to_be_visible()
        shot(page, "return-project-desktop-1440-source-decision")
        page.keyboard.press("Escape")

        # The question opens on the whole message it came from.
        line.get_by_role("link", name="Answer Ari's question").click()
        expect(page).to_have_url(re.compile(f"#message-{self.ids['question']}$"))
        message = page.locator(f"#message-{self.ids['question']}")
        expect(message).to_have_class(re.compile("is-arrived"))
        expect(message).to_be_in_viewport()
        expect(message).to_contain_text(QUESTION)

        # The point was saved when Nia viewed the project.
        self.wait_saved(page, "project")

    def test_06_keep_for_later_moves_the_point_back(self) -> None:
        page = self.page("nia")
        ari = self.page("ari")
        self.say(ari, "Nia, which PIR model did you pick?")
        page.goto(f"/projects/{self.project_id}")
        line = page.get_by_role("region", name="Since you left")
        toggle = line.get_by_role("button", name=re.compile(r"1 update since today, \d\d:\d\d · 1 needs you"))
        expect(toggle).to_be_visible()
        toggle.click()
        line.get_by_role("button", name="Keep these for next time").click()
        expect(line.get_by_role("status")).to_have_text("These will show again next time.")
        page.reload()
        expect(page.get_by_role("region", name="Since you left").get_by_role("button", name=re.compile("1 update since today"))).to_be_visible()
        self.wait_saved(page, "project")
        page.reload()
        expect(page.get_by_role("heading", level=2, name=OPENING)).to_be_visible()
        expect(page.get_by_role("region", name="Since you left")).to_have_count(0)

    def context_at(self, who: str, viewport: dict, phone: bool) -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw",
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
                                       ("phone-390", {"width": 390, "height": 844}, True)):
            page = self.context_at("nia", viewport, phone)
            page.goto("/")
            region = page.get_by_role("region", name=re.compile("^Since you left"))
            expect(region.locator(".since__next")).to_contain_text("Answer Ari's question")
            self.no_horizontal_scroll(page)
            shot(page, f"matched-home-{label}")
            self.wait_saved(page, "home")
            self.restore(page, {"type": "home"})
            page.goto(f"/projects/{self.project_id}/conversations/{self.conversation_id}")
            line = page.get_by_role("region", name="Since you left")
            toggle = line.get_by_role("button", name=re.compile("updates since"))
            expect(toggle).to_be_visible()
            # The line sits above a real feed: the thread stays readable below it.
            expect(page.locator(".project-convo__message", has_text="The PIR mount fits, but the cable needs 2 cm more slack.")).to_be_visible()
            self.no_horizontal_scroll(page)
            shot(page, f"matched-project-{label}-collapsed")
            toggle.click()
            expect(line.locator(".since__next")).to_be_visible()
            self.no_horizontal_scroll(page)
            shot(page, f"matched-project-{label}-expanded")
            self.wait_saved(page, "project")
            self.restore(page, project, conversation)

        # Navigation from Home: the next step opens the project on the whole message it names.
        page = self.page("nia")
        page.goto("/")
        page.get_by_role("region", name=re.compile("^Since you left")).get_by_role("link", name="Answer Ari's question").click()
        expect(page).to_have_url(re.compile(f"/projects/{self.project_id}/conversations/{self.conversation_id}#message-"))
        expect(page.locator(".is-arrived")).to_be_in_viewport()
        # The project line shows the same changes (the project point is older than Home's view).
        expect(page.get_by_role("region", name="Since you left").get_by_role("button", name=re.compile("updates since"))).to_be_visible()
        # Audience preview before writing: the composer names who will read the reply.
        expect(page.locator(".composer__audience")).to_have_text(re.compile("Gesture lamp · People with project access · Saved to project"))
        # Back on Home, its point is saved and only the server's fresh answer is shown: nothing repeats.
        self.wait_saved(page, "project")
        page.get_by_role("link", name="Home").first.click()
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
        self.wait_saved(page, "home")
        # Nia loses access; her Home point is also moved back, so only authorization can hide the item.
        self.api(ari, "POST", f"/api/v1/projects/{self.project_id}/grants", {"principal": {"kind": "human", "id": NIA["id"]}, "role": "denied"}, status=201)
        self.api(page, "POST", "/api/v1/return-points/restore", {"place": {"type": "home"}}, status=200)
        fresh = self.summary(page, "home")
        self.assertEqual(fresh["items"], [], "the server's fresh answer is empty")
        # Navigating within the app, then reloading: the item is gone both times.
        views = page.get_by_role("navigation", name="Views")
        views.get_by_role("link", name="Docs").click()
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
        page.goto(f"/projects/{self.project_id}/conversations/{self.conversation_id}")
        line = page.get_by_role("region", name="Since you left")
        toggle = line.get_by_role("button", name=re.compile("2 updates since"))
        expect(toggle).to_be_visible()
        box = toggle.bounding_box()
        assert box is not None
        self.assertGreaterEqual(box["height"], 44)
        self.no_horizontal_scroll(page)
        shot(page, "return-project-phone-390-collapsed")
        toggle.tap()
        items = line.locator(".since__item")
        expect(items).to_have_count(1)
        for index in range(1):
            item_box = items.nth(index).bounding_box()
            assert item_box is not None
            self.assertGreaterEqual(item_box["height"], 44)
        self.no_horizontal_scroll(page)
        shot(page, "return-project-phone-390-expanded")
        line.get_by_role("link", name="Answer Ari's question").tap()
        expect(page.locator(".is-arrived")).to_contain_text("photo of the PIR mount")


if __name__ == "__main__":
    unittest.main()
