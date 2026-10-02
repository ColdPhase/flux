"""Browser tests for the project surface (issue #117, direction C).

Runs with the other tests/ui journeys through scripts/check_ui.sh against the running Compose
application. Three people share a restricted project with a realistic conversation, a cited
source, work, a current rule, a negative result, a proposed decision, a project sketch and a doc.
The tests cover the header (title, truthful audience, Conversation · Tasks · Map · Docs), the
one-line current state, the Details overview of linked context, creating a project sketch from
the Map tab, and the phone. Every change is checked against the API.
"""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

PASSWORD = "a lamp that reads the room"
STAMP = int(time.time() * 1000)
ADA = {"name": "Ada Kowalska", "email": f"ada.k+{STAMP}@example.test"}
JONAS = {"name": "Jonas Berg", "email": f"jonas.b+{STAMP}@example.test"}
NIA = {"name": "Nia Okafor", "email": f"nia.o+{STAMP}@example.test"}
OUTSIDER = {"name": "Lee Park", "email": f"lee.p+{STAMP}@example.test"}
LONG_NAME = "Gesture lamp for the reading corner at the Riverside children's library"

OPENING = "Should the lamp react to gestures in the dark, or only when someone is close?"
THREAD = [
    ("jonas", "I ran the camera prototype last night. Above 50 lux it catches almost every wave; below that it gets unreliable fast."),
    ("nia", "That matches what I saw in the bedroom test. At 5 lux it caught 38% of gestures, so a camera fails exactly when people want a night light."),
    ("ada", "Then the camera can't be the only sensor. What about a ToF distance sensor? It works in the dark and stores no images."),
    ("jonas", "ToF would also answer the privacy question from the library. I can order two VL53L5CX boards today."),
    ("nia", "Let's keep a manual switch as well. Kids will want to turn it off without waving at it."),
    ("ada", "Agreed. I'll write down the low-light numbers so we don't repeat the test."),
]


class ProjectSurfaceJourney(unittest.TestCase):
    """Tests run in name order and share three accounts and one project."""

    pw = None
    browser: Browser
    states: dict[str, dict] = {}
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

    def context(self, who: str | None, *, phone: bool = False, viewport: dict | None = None) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "color_scheme": "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw"}
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=viewport or DESKTOP, device_scale_factor=1)
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
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers={"origin": ORIGIN, "content-type": "application/json", **(headers or {})},
                                      data=json.dumps(body) if body is not None else None)
        if status is not None:
            self.assertEqual(response.status, status, response.text())
        return json.loads(response.text()) if response.text() else {}

    def open_project(self, who: str, **kwargs) -> Page:
        page = self.page(who, **kwargs)
        page.goto(f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}")
        expect(page.locator(f"#message-{self.ids['m_camera']}")).to_be_visible()
        return page

    def details(self, page: Page):
        return page.locator("#details")

    # ---------------------------------------------------------------- realistic project

    def test_01_three_people_share_a_project(self) -> None:
        people = {"ada": ADA, "jonas": JONAS, "nia": NIA, "outsider": OUTSIDER}
        for key, person in people.items():
            page = self.page(None)
            page.goto("/sign-up")
            page.get_by_label("Name").fill(person["name"])
            page.get_by_label("Email").fill(person["email"])
            page.get_by_label("Password").fill(PASSWORD)
            page.get_by_role("button", name="Create account").click()
            expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
            type(self).states[key] = page.context.storage_state()
            person["id"] = self.api(page, "GET", "/api/v1/me", status=200)["user"]["id"]
        ada = self.page("ada")
        jonas = self.page("jonas")
        nia = self.page("nia")
        ws = self.api(ada, "POST", "/api/v1/workspaces", {"name": "Riverside Makers"}, status=201)
        for person in (JONAS, NIA, OUTSIDER):
            self.api(ada, "POST", f"/api/v1/workspaces/{ws['id']}/members", {"email": person["email"], "role": "member"}, status=201)
        project = self.api(ada, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Gesture lamp", "visibility": "restricted"}, status=201)
        pid = project["id"]
        for person in (JONAS, NIA):
            self.api(ada, "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": person["id"]}, "role": "contributor"}, status=201)
        # A second project in the rail, and one with a long name for the phone.
        bike = self.api(ada, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Bike light", "visibility": "restricted"}, status=201)
        long_project = self.api(ada, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": LONG_NAME, "visibility": "restricted"}, status=201)
        self.api(ada, "POST", f"/api/v1/projects/{long_project['id']}/grants", {"principal": {"kind": "human", "id": JONAS["id"]}, "role": "contributor"}, status=201)
        self.api(ada, "POST", f"/api/v1/projects/{long_project['id']}/conversations", {"body": "Which shelf gets the first lamp?", "clientMessageId": str(uuid.uuid4())}, status=201)

        pages = {"ada": ada, "jonas": jonas, "nia": nia}
        material = self.api(ada, "POST", f"/api/v1/projects/{pid}/materials", {"title": "Low-light test notes", "body": "Camera: 97% at 200 lux, 71% at 50 lux, 38% at 5 lux (20 gestures each).", "clientMutationId": str(uuid.uuid4())}, status=201)
        self.api(nia, "POST", f"/api/v1/projects/{pid}/materials", {"title": "VL53L5CX datasheet", "url": "https://www.st.com/en/imaging-and-photonics-solutions/vl53l5cx.html", "clientMutationId": str(uuid.uuid4())}, status=201)
        thread = self.api(ada, "POST", f"/api/v1/projects/{pid}/conversations", {"body": OPENING, "clientMessageId": str(uuid.uuid4())}, status=201)
        cid = thread["id"]
        messages = {"m_opening": thread["messages"][0]["id"]}
        for index, (who, body) in enumerate(THREAD):
            command = {"body": body, "clientMessageId": str(uuid.uuid4())}
            if index == 1:
                command["source"] = {"materialId": material["materialId"], "version": material["version"]}
            messages[f"m{index}"] = self.api(pages[who], "POST", f"/api/v1/conversations/{cid}/messages", command, status=201)["id"]
        messages["m_camera"] = messages["m0"]
        base = f"/api/v1/projects/{pid}"
        work = self.api(nia, "POST", f"{base}/work", {"title": "Test the camera in low light", "owner": {"kind": "human", "id": NIA["id"]}, "status": "in_progress", "sources": [{"type": "message", "id": messages["m0"]}]}, status=201)
        self.api(jonas, "POST", f"{base}/work", {"title": "Order two VL53L5CX boards", "owner": {"kind": "human", "id": JONAS["id"]}, "sources": [{"type": "message", "id": messages["m3"]}]}, status=201)
        result = self.api(nia, "POST", f"{base}/results", {"title": "Camera caught 38% of gestures at 5 lux", "finding": "negative", "evidence": "20 gestures per light level in a dark bedroom", "work": [work["id"]], "sources": [{"type": "message", "id": messages["m1"]}, {"type": "material", "id": material["materialId"], "version": material["version"]}]}, status=201)
        rule = self.api(ada, "POST", f"{base}/decisions", {"title": "Use a ToF sensor, not the camera, for gestures", "rationale": "It works in the dark and stores no images", "sources": [{"type": "message", "id": messages["m2"]}]}, status=201)
        self.api(ada, "POST", f"/api/v1/decisions/{rule['id']}/accept", {"expectedVersion": 1}, status=200)
        proposal = self.api(nia, "POST", f"{base}/decisions", {"title": "Keep a manual off switch on the base", "rationale": "Children should not have to wave to turn it off", "sources": [{"type": "message", "id": messages["m4"]}]}, status=201)
        sketch = self.api(jonas, "POST", f"/api/v1/workspaces/{ws['id']}/sketches", {"title": "Sensing options", "scope": "project", "projectId": pid}, status=201, headers={"idempotency-key": str(uuid.uuid4())})
        idea = self.api(jonas, "POST", f"/api/v1/sketches/{sketch['id']}/thoughts", {"text": "React to gestures in the dark", "x": 0, "y": 0}, status=201, headers={"idempotency-key": str(uuid.uuid4())})
        for index, text in enumerate(("Camera", "ToF distance sensor", "PIR presence")):
            self.api(jonas, "POST", f"/api/v1/sketches/{sketch['id']}/thoughts", {"text": text, "x": -260 + index * 260, "y": 160, "linkFrom": {"thoughtId": idea["thought"]["id"]}}, status=201, headers={"idempotency-key": str(uuid.uuid4())})
        doc = self.api(ada, "POST", f"{base}/docs", {"title": "What we learned about low light", "from": {"type": "result", "id": result["id"]}, "state": "published", "reason": "First notes"}, status=201, headers={"idempotency-key": str(uuid.uuid4())})
        type(self).ids = {"workspace": ws["id"], "project": pid, "bike": bike["id"], "conversation": cid, "long_project": long_project["id"], "work": work["id"], "result": result["id"], "rule": rule["id"],
                          "proposal": proposal["id"], "sketch": sketch["id"], "doc": doc["id"], "material": material["materialId"], **messages}

    # ---------------------------------------------------------------- header

    def test_02_header_names_the_project_and_its_exact_audience(self) -> None:
        page = self.open_project("ada")
        header = page.locator("header.top")
        expect(header.get_by_role("heading", level=1, name="Gesture lamp")).to_be_visible()
        expect(header.locator(".top__audience")).to_contain_text("Jonas, Nia and you")
        people = self.api(page, "GET", f"/api/v1/projects/{self.ids['project']}/people", status=200)
        self.assertEqual(sorted(person["id"] for person in people), sorted([ADA["id"], JONAS["id"], NIA["id"]]), "the audience is exactly the project's readers")
        self.assertNotIn(OUTSIDER["id"], [person["id"] for person in people])
        outsider = self.page("outsider")
        self.api(outsider, "GET", f"/api/v1/projects/{self.ids['project']}/people", status=404)
        tabs = page.get_by_role("navigation", name="Project views")
        # Studio 11.6 order and vocabulary (#136); quiet tabs without visible counts.
        self.assertEqual([text.split("\n")[0] for text in tabs.get_by_role("link").all_inner_texts()[:4]], ["Conversation", "Map", "Tasks", "Wiki"])
        expect(tabs.get_by_role("link", name="Tasks, 2 open")).to_be_visible()
        expect(header.get_by_role("button", name="Details")).to_be_visible()
        # The conversations sit in the sidebar; the centre uses the pane (#136) with readable bubbles.
        expect(page.get_by_role("complementary", name="Sidebar").get_by_role("link", name=re.compile("^Should the lamp react"))).to_have_attribute("aria-current", "page")
        column = page.locator(".project-convo__in").bounding_box()
        assert column
        self.assertLessEqual(column["width"], 1000, "conversation pane")
        for bubble in page.locator(".project-convo__message > p").all():
            box = bubble.bounding_box()
            assert box
            self.assertLessEqual(box["width"], 700, "readable measure per message")
        # Calm chips under a message open their object.
        chip = page.locator(f"#message-{self.ids['m0']}").get_by_role("button", name="Work: Test the camera in low light")
        expect(chip).to_contain_text("In progress")
        self.assert_whole_messages(page)
        shot(page, "project-conversation-desktop-1440")
        small = self.page("ada", viewport={"width": 1280, "height": 800})
        small.goto(f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}")
        expect(small.locator("header.top").get_by_label("Current state")).to_be_visible()
        expect(small.locator(f"#message-{self.ids['m4']}")).to_be_visible()
        self.assert_whole_messages(small)
        shot(small, "project-conversation-desktop-1280")

    def assert_whole_messages(self, page: Page) -> None:
        """The feed opens on whole messages: none starts above the top edge of the feed."""
        page.wait_for_timeout(600)
        clipped = page.evaluate("""() => {
          const feed = document.querySelector('.project-convo__feed');
          const top = feed.getBoundingClientRect().top;
          return [...feed.querySelectorAll('.project-convo__message')].filter((el) => { const r = el.getBoundingClientRect(); return r.top < top - 1 && r.bottom > top + 1; }).length;
        }""")
        self.assertEqual(clipped, 0, "no message is cut off at the top of the opening screen")
        last = page.locator(".project-convo__message").last.bounding_box()
        feed = page.locator(".project-convo__feed").bounding_box()
        assert last and feed
        self.assertLessEqual(last["y"] + last["height"], feed["y"] + feed["height"] + 1, "the latest message is fully visible")

    # ---------------------------------------------------------------- current state

    def test_03_each_state_segment_opens_its_object(self) -> None:
        page = self.open_project("ada")
        state = page.locator("header.top").get_by_label("Current state")
        expect(state).to_contain_text("Current rule: Use a ToF sensor, not the camera, for gestures")
        expect(state).to_contain_text("In progress: Test the camera in low light (Nia)")
        expect(state).to_contain_text("Negative result: Camera caught 38% of gestures at 5 lux")
        expect(state).to_contain_text("Needs you: a proposed decision")
        panel = self.details(page)
        for segment, heading in (("rule", "Use a ToF sensor, not the camera, for gestures"), ("work", "Test the camera in low light"),
                                 ("result", "Camera caught 38% of gestures at 5 lux"), ("proposal", "Keep a manual off switch on the base")):
            state.locator(f'[data-seg="{segment}"]').click()
            expect(panel.get_by_role("heading", name=heading)).to_be_visible()
        panel.get_by_role("button", name="Close details").click()
        expect(panel).to_be_hidden()

    # ---------------------------------------------------------------- tabs

    def test_04_view_tabs_switch_between_the_project_surfaces(self) -> None:
        page = self.open_project("jonas")
        tabs = page.get_by_role("navigation", name="Project views")
        conversation_url = page.url
        tabs.get_by_role("link", name=re.compile("^Tasks")).click()
        expect(page).to_have_url(re.compile(r"/tasks$"))
        expect(page.get_by_role("region", name=re.compile("^In progress"))).to_contain_text("Test the camera in low light")
        expect(tabs.get_by_role("link", name=re.compile("^Tasks"))).to_have_attribute("aria-current", "page")
        shot(page, "project-tasks-desktop-1440")
        tabs.get_by_role("link", name=re.compile("^Map")).click()
        expect(page).to_have_url(re.compile(r"/map$"))
        expect(page.get_by_role("list", name="Sketches in Gesture lamp").get_by_role("link", name=re.compile("Sensing options"))).to_be_visible()
        tabs.get_by_role("link", name=re.compile("^Wiki")).click()
        expect(page).to_have_url(re.compile(rf"/docs/{self.ids['doc']}$"))
        expect(page.get_by_role("link", name=re.compile("What we learned about low light"))).to_be_visible()
        tabs.get_by_role("link", name=re.compile("^Conversation")).click()
        expect(page, "Conversation returns to the open conversation").to_have_url(conversation_url)
        expect(page.locator(f"#message-{self.ids['m_camera']}")).to_be_visible()
        # The state line stays with the project on every tab.
        tabs.get_by_role("link", name=re.compile("^Map")).click()
        expect(page.locator("header.top").get_by_label("Current state")).to_contain_text("Current rule")
        # At 320px the tab strip scrolls sideways; the current tab is brought into view.
        page.set_viewport_size({"width": 320, "height": 640})
        tabs.get_by_role("link", name=re.compile("^Wiki")).click()
        expect(page).to_have_url(re.compile(rf"/docs/{self.ids['doc']}$"))
        current = tabs.get_by_role("link", name=re.compile("^Wiki"))
        expect(current).to_have_attribute("aria-current", "page")
        box = current.bounding_box()
        assert box
        self.assertGreaterEqual(box["x"], 0)
        self.assertLessEqual(box["x"] + box["width"], 320, "the current tab is visible in the strip")

    # ---------------------------------------------------------------- Details overview

    def test_05_details_overview_links_everything_one_step_away(self) -> None:
        page = self.open_project("ada")
        page.locator("header.top").get_by_role("button", name="Details").click()
        panel = self.details(page)
        expect(panel.get_by_role("heading", name=OPENING)).to_be_visible()
        linked = panel.get_by_role("region", name="Linked in this conversation")
        for title in ("Test the camera in low light", "Order two VL53L5CX boards", "Use a ToF sensor, not the camera, for gestures", "Keep a manual off switch on the base", "Camera caught 38% of gestures at 5 lux"):
            expect(linked.get_by_role("button", name=re.compile(re.escape(title)))).to_be_visible()
        expect(panel.get_by_role("region", name="Sources").get_by_role("link", name=re.compile("Low-light test notes"))).to_be_visible()
        expect(panel.get_by_role("region", name="Sketches").get_by_role("link", name=re.compile("Sensing options"))).to_be_visible()
        expect(panel.get_by_role("region", name="Docs").get_by_role("link", name=re.compile("What we learned about low light"))).to_be_visible()
        people = panel.get_by_role("region", name="Who can see this")
        for name in ("Ada Kowalska (you)", "Jonas Berg", "Nia Okafor"):
            expect(people).to_contain_text(name)
        expect(people).not_to_contain_text("Lee Park")
        shot(page, "project-details-desktop-1440")
        # One step to an object, and back.
        linked.get_by_role("button", name=re.compile("Order two VL53L5CX boards")).click()
        expect(panel.get_by_role("heading", name="Order two VL53L5CX boards")).to_be_visible()
        page.locator("header.top").get_by_role("button", name="Details").click()
        page.locator("header.top").get_by_role("button", name="Details").click()
        expect(panel.get_by_role("region", name="Sources")).to_be_visible()
        panel.get_by_role("region", name="Sources").get_by_role("link", name=re.compile("Low-light test notes")).click()
        expect(page).to_have_url(re.compile(rf"/materials/{self.ids['material']}/versions/1$"))
        page.go_back()
        # A message's own Details show what was made from it.
        message = page.locator(f"#message-{self.ids['m1']}")
        message.hover()
        message.get_by_role("button", name="Details of this message").click()
        expect(panel.get_by_role("heading", name="Message from Nia Okafor")).to_be_visible()
        made = panel.get_by_role("region", name="Made from this message")
        expect(made.get_by_role("button", name=re.compile("Camera caught 38% of gestures"))).to_be_visible()
        expect(made).not_to_contain_text("Order two VL53L5CX boards")
        expect(panel.get_by_role("region", name="Docs").get_by_role("link", name=re.compile("What we learned about low light"))).to_be_visible()
        panel.get_by_role("button", name="This conversation").click()
        expect(panel.get_by_role("region", name="Linked in this conversation")).to_be_visible()
        panel.get_by_role("region", name="Sketches").get_by_role("link", name=re.compile("Sensing options")).click()
        expect(page).to_have_url(re.compile(rf"/projects/{self.ids['project']}/map/{self.ids['sketch']}$"))
        expect(page.get_by_role("navigation", name="Project views").get_by_role("link", name=re.compile("^Map"))).to_have_attribute("aria-current", "page")

    # ---------------------------------------------------------------- Map tab

    def test_06_map_tab_creates_a_project_sketch(self) -> None:
        page = self.page("nia")
        page.goto(f"/projects/{self.ids['project']}/map")
        expect(page.get_by_role("list", name="Sketches in Gesture lamp")).to_be_visible()
        shot(page, "project-map-desktop-1440")
        page.get_by_role("button", name="New sketch").click()
        expect(page).to_have_url(re.compile(rf"/projects/{self.ids['project']}/map/[0-9a-f-]+$"))
        sketch_id = page.url.rsplit("/", 1)[-1]
        stored = self.api(page, "GET", f"/api/v1/sketches/{sketch_id}", status=200)
        self.assertEqual((stored["scope"], stored["projectId"]), ("project", self.ids["project"]))
        expect(page.get_by_text("Everyone in Gesture lamp")).to_be_visible()
        page.get_by_role("link", name="Sketches", exact=True).click()
        expect(page).to_have_url(re.compile(rf"/projects/{self.ids['project']}/map$"))
        expect(page.get_by_role("list", name="Sketches in Gesture lamp").get_by_role("link")).to_have_count(2)
        # Everyone in the project sees it; nobody else does.
        listed = self.api(self.page("jonas"), "GET", f"/api/v1/workspaces/{self.ids['workspace']}/sketches?projectId={self.ids['project']}&limit=50", status=200)
        self.assertIn(sketch_id, [item["id"] for item in listed["items"]])
        self.api(self.page("outsider"), "GET", f"/api/v1/sketches/{sketch_id}", status=404)

    # ---------------------------------------------------------------- phone

    def test_07_phone_collapses_the_state_line_and_keeps_the_audience(self) -> None:
        page = self.open_project("ada", phone=True)
        row = page.get_by_role("button", name=re.compile("open project details"))
        box = row.bounding_box()
        assert box
        self.assertGreaterEqual(box["height"], 44, "state row is one 44px target")
        self.assertLessEqual(box["height"], 50, "one line")
        expect(row).to_contain_text("Decision needs you")
        # One quiet overflow button per message, in its corner, still a 44 px target.
        message = page.locator(f"#message-{self.ids['m4']}")
        more = message.get_by_role("button", name="Make from this message")
        mbox, bbox = more.bounding_box(), message.bounding_box()
        assert mbox and bbox
        self.assertGreaterEqual(mbox["height"], 44)
        self.assertLess(mbox["y"] - bbox["y"], 20, "the overflow button sits beside the author, not in a row of its own")
        expect(page.locator("header.top").get_by_label("Current state")).to_have_count(0)
        self.assertLessEqual(page.locator("body").evaluate("el => el.scrollWidth"), PHONE["width"])
        shot(page, "project-conversation-phone-390")
        row.tap()
        sheet = page.get_by_role("dialog", name="Details")
        expect(sheet.get_by_role("region", name="Linked in this conversation").get_by_role("button", name=re.compile("Keep a manual off switch"))).to_be_visible()
        expect(sheet.get_by_role("region", name="Who can see this")).to_contain_text("Nia Okafor")
        shot(page, "project-details-phone-390")
        sheet.get_by_role("region", name="Linked in this conversation").get_by_role("button", name=re.compile("Use a ToF sensor")).tap()
        expect(sheet.get_by_role("heading", name="Use a ToF sensor, not the camera, for gestures")).to_be_visible()
        sheet.get_by_role("button", name="Close details").tap()
        page.get_by_role("navigation", name="Project views").get_by_role("link", name=re.compile("^Map")).tap()
        expect(page.get_by_role("list", name="Sketches in Gesture lamp")).to_be_visible()
        shot(page, "project-map-phone-390")

        # A title too long for the phone truncates; its audience stays visible and opens the people.
        page.goto(f"/projects/{self.ids['long_project']}")
        title = page.locator("header.top h1")
        expect(title).to_have_text(LONG_NAME)
        self.assertTrue(title.evaluate("el => el.scrollWidth > el.clientWidth"), "the long title truncates")
        audience = page.locator("header.top .top__audience")
        expect(audience).to_be_visible()
        expect(audience).to_contain_text("Jonas and you · only you two")
        abox = audience.bounding_box()
        assert abox
        self.assertLessEqual(abox["x"] + abox["width"], PHONE["width"])
        shot(page, "project-long-title-phone-390")
        audience.tap()
        expect(page.get_by_role("dialog", name="Details").get_by_role("region", name="Who can see this")).to_contain_text("Jonas Berg")


    # ---------------------------------------------------------------- the Map route is bound to its project

    def test_08_a_sketch_never_shows_under_another_projects_frame(self) -> None:
        page = self.page("ada")
        other = self.api(page, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/sketches", {"title": "Bike light beam angles", "scope": "project", "projectId": self.ids["bike"]}, status=201, headers={"idempotency-key": str(uuid.uuid4())})
        private = self.api(page, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/sketches", {"title": "My private lamp doodles", "scope": "private"}, status=201, headers={"idempotency-key": str(uuid.uuid4())})
        page.goto(f"/projects/{self.ids['project']}/map/{other['id']}")
        expect(page).to_have_url(f"{ORIGIN}/projects/{self.ids['bike']}/map/{other['id']}")
        expect(page.locator("header.top h1")).to_have_text("Bike light")
        expect(page.get_by_role("button", name="Rename sketch Bike light beam angles")).to_be_visible()
        page.goto(f"/projects/{self.ids['project']}/map/{private['id']}")
        expect(page).to_have_url(f"{ORIGIN}/map/{private['id']}")
        expect(page.get_by_role("button", name="Rename sketch My private lamp doodles")).to_be_visible()
        expect(page.locator(".sk-aud")).to_contain_text("Only you")
        expect(page.get_by_role("navigation", name="Project views")).to_have_count(0)
        expect(page.locator("header.top h1")).not_to_have_text("Gesture lamp")


if __name__ == "__main__":
    unittest.main(verbosity=2)
