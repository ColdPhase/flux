"""Friendly Flux, slice 1 (#272, docs/design/friendly-flux.md FF-2 to FF-6).

Home is the place to get back to work, My sketchbook is a private place of notes and sketches,
Settings is a page reached from the person at the foot of the sidebar, the desktop sidebar can be
hidden, and a project's header says what the project is for. Real sign-up through the UI, data
through the API, Chromium through Playwright. Screenshots (272-*.png) go to FLUX_UI_SCREENSHOTS.
"""
from __future__ import annotations

import json
import re
import unittest
import uuid

from playwright.sync_api import expect, sync_playwright

from test_app_shell import BACK, ORIGIN, UPSTREAM, shot, start_forwarder

DESKTOP = {"width": 1440, "height": 900}
PHONE = {"width": 390, "height": 844}
PASSWORD = "friendly places for work"
PROJECT = "Community garden sensors"
MOVING = "Calibrate the soil moisture probes"
WAITING = "Write the volunteer guide"


class FriendlyHomeJourney(unittest.TestCase):
    """Ada owns one project with a task in progress; tests share her account and run in name order."""

    @classmethod
    def setUpClass(cls):
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        expect.set_options(timeout=8000)
        context = cls.browser.new_context(base_url=ORIGIN, viewport=DESKTOP)
        page = context.new_page()
        page.goto("/sign-up")
        page.get_by_label("Name").fill("Ada Lovegrove")
        page.get_by_label("Email").fill(f"ada.friendly+{uuid.uuid4()}@example.test")
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        cls.state = context.storage_state()
        cls.me = cls.call(page, "GET", "/api/v1/me")["user"]
        cls.workspace = cls.call(page, "POST", "/api/v1/workspaces", {"name": "Riverside Makers"}, 201)
        cls.project = cls.call(page, "POST", f"/api/v1/workspaces/{cls.workspace['id']}/projects",
                               {"name": PROJECT, "visibility": "restricted"}, 201)
        mine = {"kind": "human", "id": cls.me["id"]}
        base = f"/api/v1/projects/{cls.project['id']}/work"
        cls.moving = cls.call(page, "POST", base, {"title": MOVING, "status": "in_progress", "owner": mine, "clientCommandId": str(uuid.uuid4())}, 201)
        cls.waiting = cls.call(page, "POST", base, {"title": WAITING, "status": "open", "owner": mine, "clientCommandId": str(uuid.uuid4())}, 201)
        context.close()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    @staticmethod
    def call(page, method, path, body=None, status=200):
        response = page.request.fetch(ORIGIN + path, method=method,
            headers={"origin": ORIGIN, "content-type": "application/json"},
            data=json.dumps(body) if body is not None else None)
        if response.status != status:
            raise AssertionError(f"{method} {path}: {response.status}, expected {status}: {response.text()}")
        return response.json() if response.text() else None

    def page(self, viewport=DESKTOP, *, touch=False, reduced=False, dark=False, state=None):
        phone = viewport["width"] <= 640
        context = self.browser.new_context(base_url=ORIGIN, viewport=viewport, storage_state=state or self.state,
            color_scheme="dark" if dark else "light", is_mobile=phone and touch, has_touch=touch,
            reduced_motion="reduce" if reduced else "no-preference", locale="en-GB", timezone_id="Europe/Warsaw")
        self.addCleanup(context.close)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught browser errors"))
        return page

    def box(self, locator):
        value = locator.bounding_box()
        self.assertIsNotNone(value, f"{locator} has a box")
        return value

    def settle(self, page):
        page.evaluate("() => Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => null)))")

    def within_first_screen(self, page, locator, height, what):
        item = self.box(locator)
        self.assertGreaterEqual(item["y"], 0, f"{what} is below the top")
        self.assertLessEqual(item["y"] + item["height"], height, f"{what} is visible without scrolling")

    # ------------------------------------------------------------------ FF-2 Home

    def test_01_home_at_1440_gets_you_back_to_work(self):
        page = self.page()
        page.goto("/")
        expect(page.locator("header.top").get_by_role("heading", level=1, name="Home")).to_be_visible()
        expect(page.get_by_role("heading", level=2, name="Hi, Ada.")).to_be_visible()
        # Home has no views and no Details of its own: it says what to do next.
        expect(page.get_by_role("navigation", name="Views")).to_have_count(0)
        expect(page.get_by_role("button", name="Details", exact=True)).to_have_count(0)

        # The return card: the task Ada was moving, why it is here, and where it is.
        card = page.locator(".home-return")
        expect(card).to_contain_text("Pick up where you left off")
        expect(card.get_by_role("heading", level=3, name=MOVING)).to_be_visible()
        expect(card).to_contain_text("You own this task and it is in progress.")
        expect(card).to_contain_text(PROJECT)
        back = card.get_by_role("link", name=re.compile("^Back to work"))
        expect(back).to_have_attribute("href", f"/projects/{self.project['id']}/tasks?open=work:{self.moving['id']}")
        # FF-2 acceptance: the return card, My work and For you are visible without scrolling.
        self.assertEqual(page.evaluate("document.querySelector('.home').closest('.pane-scroll').scrollTop"), 0)
        work = page.get_by_role("region", name="My work", exact=True)
        for_you = page.get_by_role("region", name="For you", exact=True)
        self.within_first_screen(page, back, DESKTOP["height"], "Back to work")
        self.within_first_screen(page, work.get_by_role("heading", name="My work"), DESKTOP["height"], "My work")
        self.within_first_screen(page, for_you.get_by_role("heading", name="For you", exact=True), DESKTOP["height"], "For you")

        # My work: Active shows the task in progress with its project and status; All shows every open task.
        moving = work.get_by_role("button", name=re.compile("^Active"))
        expect(moving).to_have_attribute("aria-pressed", "true")
        expect(moving).to_have_text("Active · 1")
        row = work.get_by_role("link", name=re.compile(MOVING))
        expect(row).to_contain_text(f"{PROJECT} · In progress")
        expect(row).to_have_attribute("href", f"/projects/{self.project['id']}/tasks?open=work:{self.moving['id']}")
        expect(work.get_by_role("link", name=re.compile(WAITING))).to_have_count(0)
        work.get_by_role("button", name=re.compile("^All")).click()
        expect(work.get_by_role("button", name=re.compile("^All"))).to_have_attribute("aria-pressed", "true")
        expect(work.get_by_role("link", name=re.compile(WAITING))).to_contain_text(f"{PROJECT} · Open")
        work.get_by_role("button", name=re.compile("^Active")).click()

        # For you: nothing waits for Ada yet, and the empty state says what will show here.
        expect(for_you).to_contain_text("Nothing needs you right now. When someone replies to you, mentions you or asks for your decision, it shows here and in your Inbox.")
        expect(for_you.get_by_role("link", name=re.compile("^Open Inbox"))).to_have_attribute("href", "/inbox")

        # Nothing waits for a decision, so For you lists none.
        expect(for_you.get_by_role("list", name="Decisions waiting for you")).to_have_count(0)

        # Your projects: each card opens its project and says what is happening there in the project's own words.
        projects = page.get_by_role("region", name="Your projects", exact=True)
        card_link = projects.get_by_role("link", name=re.compile(f"^{PROJECT}"))
        expect(card_link).to_have_attribute("href", f"/projects/{self.project['id']}")
        expect(card_link).to_contain_text("1 in progress")
        expect(projects.get_by_role("link", name="New project")).to_have_attribute("href", "/projects/new")
        shot(page, "272-home-desktop-1440")

        # Each row opens its source: the return card opens the task in its project.
        back.click()
        expect(page).to_have_url(re.compile(rf"/projects/{self.project['id']}/tasks"))
        expect(page.locator("#details").get_by_role("heading", name=MOVING)).to_be_visible()

        # All my tasks opens the full list, which spans every project and has no views.
        page.goto("/")
        work.get_by_role("link", name=re.compile("^All my tasks")).click()
        expect(page).to_have_url(f"{ORIGIN}/tasks")
        expect(page.locator("header.top").get_by_role("heading", level=1, name="My work")).to_be_visible()
        expect(page.get_by_role("region", name="Your tasks")).to_contain_text(MOVING)

        # What matters on a project card opens the project's private recap.
        page.goto("/")
        projects.get_by_role("link", name="What matters").click()
        expect(page).to_have_url(re.compile(rf"/projects/{self.project['id']}$"))
        expect(page.locator("#details").get_by_role("heading", name="What matters")).to_be_visible()

    def test_02_home_on_a_phone_puts_back_to_work_in_the_first_screen(self):
        page = self.page(PHONE, touch=True)
        page.goto("/")
        expect(page.get_by_role("heading", level=2, name="Hi, Ada.")).to_be_visible()
        back = page.locator(".home-return").get_by_role("link", name=re.compile("^Back to work"))
        expect(back).to_be_visible()
        self.within_first_screen(page, back, PHONE["height"], "Back to work")
        self.assertGreaterEqual(min(self.box(back)["width"], self.box(back)["height"]), 44, "a 44px target")
        self.assertEqual(page.evaluate("document.documentElement.scrollWidth"), PHONE["width"], "no sideways scroll")
        bar = page.get_by_role("navigation", name="Main places")
        current = bar.locator('[aria-current="page"]')
        expect(current).to_have_count(1)
        expect(current).to_contain_text("Home")
        expect(page).to_have_title("Home · Flux")
        # The same order stacks in one column: the return card, My work, For you, Your projects.
        tops = [self.box(page.get_by_role("region", name=name, exact=True))["y"] for name in ("My work", "For you", "Your projects")]
        self.assertLess(self.box(page.locator(".home-return"))["y"], tops[0])
        self.assertEqual(tops, sorted(tops), "My work, For you and Your projects stack in that order")
        shot(page, "272-home-phone-390")
        back.tap()
        expect(page).to_have_url(re.compile(rf"/projects/{self.project['id']}/tasks"))
        # The task opens in its Details sheet.
        sheet = page.get_by_role("dialog", name="Details")
        expect(sheet.get_by_role("heading", name=MOVING)).to_be_visible()
        page.keyboard.press("Escape")
        expect(sheet).to_have_count(0)
        # Inside the project the places bar stays with Projects current (Apple HIG tab bars), and the
        # top-left control is a real Back (HIG-26): it returns Home, where she came from, without a new entry.
        expect(bar.get_by_role("link", name=re.compile("^Projects"))).to_have_attribute("aria-current", "page")
        entries = page.evaluate("history.length")
        # Its name and tooltip say where it goes.
        page.locator("header.top").get_by_role("button", name="Back to Home", exact=True).tap()
        expect(page).to_have_url(f"{ORIGIN}/")
        self.assertEqual(page.evaluate("history.length"), entries, "Back does not add a history entry")

    # ------------------------------------------------------------------ FF-3 My sketchbook

    def test_03_my_sketchbook_is_a_private_place_of_notes_and_sketches(self):
        page = self.page()
        page.goto("/")
        places = page.get_by_role("navigation", name="Places")
        expect(places.get_by_role("link")).to_have_count(4)
        self.assertEqual(places.get_by_role("link").all_inner_texts(), ["Home", "Inbox", "My sketchbook", "Wiki pages"])
        places.get_by_role("link", name="My sketchbook").click()
        expect(page).to_have_url(f"{ORIGIN}/notes")
        header = page.locator("header.top")
        expect(header.get_by_role("heading", level=1, name="My sketchbook")).to_be_visible()
        expect(header.locator(".top__topic")).to_have_text("Only you")
        expect(places.get_by_role("link", name="My sketchbook")).to_have_attribute("aria-current", "page")
        views = page.get_by_role("navigation", name="Views")
        expect(views.get_by_role("link", name="Notes")).to_have_attribute("aria-current", "page")
        expect(page.get_by_role("heading", name="Your notes, Ada")).to_be_visible()
        # Its Details say who can see it: only you (FF-3, a private place).
        page.get_by_role("button", name="Details", exact=True).click()
        audience = page.locator("#details").get_by_role("region", name="Who can see My sketchbook")
        expect(audience).to_contain_text("Only you")
        expect(audience).not_to_contain_text("each conversation")
        page.get_by_role("button", name="Close details").click()

        # Saving a note works, and it is a private draft that a search opens in the notes.
        note = f"Ask the school about two spare ESP32 kits {uuid.uuid4().hex[:6]}"
        composer = page.get_by_label("Private note", exact=True)
        composer.fill(note)
        composer.press("Enter")
        drafts = page.get_by_role("region", name="Private drafts")
        expect(drafts.get_by_text(note)).to_be_visible()
        expect(composer).to_have_value("")
        shot(page, "272-notes-desktop-1440")
        page.reload()
        expect(page.get_by_role("region", name="Private drafts").get_by_text(note)).to_be_visible()

        page.get_by_role("button", name=re.compile("Jump to")).click()
        dialog = page.get_by_role("dialog", name="Jump to")
        field = dialog.get_by_role("combobox", name="Jump to")
        field.fill(note.rsplit(" ", 1)[-1])
        expect(dialog.get_by_role("option").first).to_contain_text("Ask the school about two spare ESP32 kits")
        field.press("Enter")
        expect(page).to_have_url(re.compile(r"/notes#draft-[0-9a-f-]{36}$"))
        draft_id = page.url.rsplit("#draft-", 1)[-1]
        arrived = page.locator(f"#draft-{draft_id}")
        expect(arrived).to_have_class(re.compile("is-arrived"))
        expect(arrived).to_be_in_viewport()

        # Map is the sketchbook's other view: private sketches.
        views.get_by_role("link", name="Map").click()
        expect(page).to_have_url(f"{ORIGIN}/map")
        expect(views.get_by_role("link", name="Map")).to_have_attribute("aria-current", "page")
        expect(header.get_by_role("heading", level=1, name="My sketchbook")).to_be_visible()
        expect(page.get_by_role("button", name="New sketch")).to_be_visible()
        expect(places.get_by_role("link", name="My sketchbook")).to_have_attribute("aria-current", "page")

        # No place is titled Home except Home.
        for path, title in (("/notes", "My sketchbook"), ("/map", "My sketchbook"), ("/tasks", "My work"), ("/docs", "Wiki pages")):
            page.goto(path)
            expect(header.get_by_role("heading", level=1)).to_have_text(title)
            expect(places.get_by_role("link", name="Home")).not_to_have_attribute("aria-current", "page")

    def test_04_the_sketchbook_is_a_phone_place(self):
        page = self.page(PHONE, touch=True)
        page.goto("/")
        bar = page.get_by_role("navigation", name="Main places")
        bar.get_by_role("link", name=re.compile("^Sketchbook")).tap()
        expect(page).to_have_url(f"{ORIGIN}/notes")
        expect(bar.get_by_role("link", name=re.compile("^Sketchbook"))).to_have_attribute("aria-current", "page")
        expect(page.get_by_label("Private note", exact=True)).to_be_visible()
        self.assertEqual(page.evaluate("document.documentElement.scrollWidth"), PHONE["width"], "no sideways scroll")
        # A private sketch opens full width; its top-left control leads back to My sketchbook's Map, and
        # the places bar stays with Sketchbook current.
        page.goto("/map")
        page.get_by_role("button", name="New sketch").tap()
        expect(page).to_have_url(re.compile(r"/map/[0-9a-f-]{36}$"))
        expect(bar.get_by_role("link", name=re.compile("^Sketchbook"))).to_have_attribute("aria-current", "page")
        expect(page.get_by_role("button", name="Open navigation")).to_have_count(0)
        back = page.locator("header.top").get_by_role("button", name="Back to My sketchbook", exact=True)
        self.assertGreaterEqual(min(self.box(back)["width"], self.box(back)["height"]), 44, "a 44px way back")
        back.tap()
        expect(page).to_have_url(f"{ORIGIN}/map")
        expect(page.get_by_role("button", name="Open navigation")).to_be_visible()

    def test_04b_the_places_bar_stays_on_every_phone_page(self):
        # Apple HIG tab bars, as the founder directed on #266: the bar stays on every phone page with its
        # section current, and steps aside only while a text field has focus.
        page = self.page(PHONE, touch=True)
        bar = page.get_by_role("navigation", name="Main places")
        project = self.project["id"]
        for path, current in (("/", "Home"), ("/tasks", "Home"), ("/docs", "Home"), ("/projects", "Projects"),
                              (f"/projects/{project}", "Projects"), (f"/projects/{project}/tasks", "Projects"),
                              ("/dm", "Messages"), ("/dm/new", "Messages"), ("/inbox", "Inbox"),
                              ("/notes", "Sketchbook"), ("/map", "Sketchbook"), ("/settings", None)):
            with self.subTest(path=path):
                page.goto(path)
                expect(bar).to_be_visible()
                bar_box = self.box(bar)
                self.assertAlmostEqual(bar_box["y"] + bar_box["height"], PHONE["height"], delta=1, msg="the bar sits at the bottom")
                marked = bar.locator('[aria-current="page"]')
                if current:
                    expect(marked).to_have_count(1)
                    expect(marked).to_contain_text(current)
                else:
                    expect(marked).to_have_count(0)
                self.assertEqual(page.evaluate("document.documentElement.scrollWidth"), PHONE["width"], "no sideways scroll")
        # Inside a project the message box sits right above the bar; the bar steps aside while typing.
        page.goto(f"/projects/{project}")
        field = page.get_by_label("Write a message", exact=True)
        composer = self.box(page.locator(".project-convo__composer").first)
        self.assertLessEqual(composer["y"] + composer["height"], self.box(bar)["y"] + 1, "the message box sits above the bar")
        field.tap()
        expect(bar).to_be_hidden()
        page.locator("header.top h1").tap()
        expect(bar).to_be_visible()
        shot(page, "272-places-bar-in-project-phone-390")

    # ------------------------------------------------------------------ FF-4 Settings is a page

    def test_05_the_person_row_opens_settings_and_the_switch_changes_the_theme(self):
        page = self.page()
        page.goto(f"/projects/{self.project['id']}")
        sidebar = page.get_by_role("complementary", name="Sidebar")
        person = sidebar.get_by_role("link", name=re.compile(r"^Ada Lovegrove.*Settings and sign out"))
        expect(person).to_contain_text("Settings and sign out")
        # From any page Settings is one click on a desktop.
        person.click()
        expect(page).to_have_url(f"{ORIGIN}/settings")
        expect(page.get_by_role("heading", level=1, name="Settings")).to_be_visible()
        expect(person).to_have_attribute("aria-current", "page")
        expect(page.get_by_role("dialog", name="Account")).to_have_count(0)
        for section in ("This device", "Notifications", "AI", "Account"):
            expect(page.get_by_role("heading", name=section, exact=True)).to_be_visible()
        expect(page.get_by_role("radiogroup", name="Appearance")).to_be_visible()
        expect(page.get_by_role("button", name=re.compile("^Sign out"))).to_be_visible()
        shot(page, "272-settings-desktop-1440")

        # The light/dark switch beside the person row: one click, no popover.
        to_dark = sidebar.get_by_role("button", name="Switch to dark")
        to_dark.click()
        self.assertEqual(page.evaluate("document.documentElement.dataset.theme"), "dark")
        expect(page.get_by_role("radiogroup", name="Appearance").get_by_role("radio", name="Dark")).to_have_attribute("aria-checked", "true")
        to_light = sidebar.get_by_role("button", name="Switch to light")
        expect(to_light).to_be_visible()
        page.reload()
        self.assertEqual(page.evaluate("document.documentElement.dataset.theme"), "dark", "the choice is kept on this device")
        sidebar.get_by_role("button", name="Switch to light").click()
        self.assertEqual(page.evaluate("document.documentElement.dataset.theme"), "light")
        expect(sidebar.get_by_role("button", name="Switch to dark")).to_be_visible()
        expect(page.get_by_role("dialog")).to_have_count(0)
        page.get_by_role("radiogroup", name="Appearance").get_by_role("radio", name="System").click()

    # ------------------------------------------------------------------ FF-5 a hideable sidebar

    def test_06_the_sidebar_hides_and_comes_back_from_the_keyboard(self):
        page = self.page()
        page.goto("/")
        app = page.locator(".app")
        aside = page.locator("aside.app__side")
        hide = page.get_by_role("complementary", name="Sidebar").get_by_role("button", name="Hide sidebar")
        expect(hide).to_have_attribute("aria-keyshortcuts", "[")
        before = self.box(page.locator(".app__main"))
        hide.click()
        expect(app).to_have_attribute("data-side", "hidden")
        expect(aside).to_have_attribute("inert", re.compile(".*"))
        show = page.locator("header.top").get_by_role("button", name="Show sidebar")
        expect(show).to_be_focused()
        self.settle(page)
        after = self.box(page.locator(".app__main"))
        self.assertGreater(after["width"], before["width"] + 150, "the sheet takes the width")
        shot(page, "272-sidebar-hidden-desktop-1440")
        # The sidebar is inert: keyboard focus never lands in it.
        for _ in range(12):
            page.keyboard.press("Tab")
            self.assertFalse(page.evaluate("!!document.activeElement?.closest('.app__side')"), "focus stays out of the hidden sidebar")
        # The choice is remembered on this device.
        page.reload()
        expect(app).to_have_attribute("data-side", "hidden")
        expect(page.locator("header.top").get_by_role("button", name="Show sidebar")).to_be_visible()
        # "[" brings it back, and focus moves to the control that undoes it.
        page.locator("header.top").get_by_role("button", name="Show sidebar").focus()
        page.keyboard.press("[")
        expect(app).not_to_have_attribute("data-side", "hidden")
        expect(aside).not_to_have_attribute("inert", re.compile(".*"))
        expect(page.get_by_role("complementary", name="Sidebar").get_by_role("button", name="Hide sidebar")).to_be_focused()
        page.keyboard.press("[")
        expect(app).to_have_attribute("data-side", "hidden")
        expect(page.locator("header.top").get_by_role("button", name="Show sidebar")).to_be_focused()
        page.locator("header.top").get_by_role("button", name="Show sidebar").click()
        expect(app).not_to_have_attribute("data-side", "hidden")
        page.reload()
        expect(app).not_to_have_attribute("data-side", "hidden")
        # Typing "[" in a field writes it, and leaves the sidebar alone.
        page.goto("/notes")
        composer = page.get_by_label("Private note", exact=True)
        composer.fill("")
        composer.press("[")
        expect(composer).to_have_value("[")
        expect(app).not_to_have_attribute("data-side", "hidden")
        composer.fill("")

    def test_07_reduced_motion_hides_the_sidebar_at_once(self):
        page = self.page(reduced=True)
        page.goto("/")
        page.get_by_role("complementary", name="Sidebar").get_by_role("button", name="Hide sidebar").click()
        expect(page.locator(".app")).to_have_attribute("data-side", "hidden")
        self.assertEqual(page.evaluate("document.getAnimations().filter((a) => a.playState === 'running').length"), 0,
                         "no running animation under reduced motion")
        page.locator("header.top").get_by_role("button", name="Show sidebar").click()
        expect(page.locator(".app")).not_to_have_attribute("data-side", "hidden")
        self.assertEqual(page.evaluate("document.getAnimations().filter((a) => a.playState === 'running').length"), 0)

    # ------------------------------------------------------------------ FF-6 a project's goal

    def test_08_an_editor_sets_the_goal_and_a_viewer_reads_it(self):
        page = self.page()
        page.goto(f"/projects/{self.project['id']}")
        header = page.locator("header.top")
        add = header.get_by_role("button", name="Add a goal")
        expect(add).to_be_visible()
        add.click()
        field = header.get_by_label("Project goal")
        expect(field).to_be_focused()
        field.fill("Know when each garden bed needs water")
        # Escape cancels without saving.
        field.press("Escape")
        expect(header.get_by_label("Project goal")).to_have_count(0)
        expect(header.get_by_role("button", name="Add a goal")).to_be_visible()
        header.get_by_role("button", name="Add a goal").click()
        field = header.get_by_label("Project goal")
        field.fill("Know when each garden bed needs water")
        field.press("Enter")
        goal = header.locator(".top__goal")
        expect(goal).to_have_text(re.compile(r"Goal:\s*Know when each garden bed needs water"))
        expect(header.get_by_role("button", name=re.compile("change the goal"))).to_be_visible()
        page.reload()
        expect(header.locator(".top__goal")).to_contain_text("Goal:")
        expect(header.locator(".top__goal")).to_contain_text("Know when each garden bed needs water")
        # The state line no longer repeats a decision; the goal says what the project is for.
        expect(header.get_by_label("Current state")).not_to_contain_text("Current rule")
        shot(page, "272-project-goal-desktop-1440")
        # Details carries the goal in full, for a phone header that shortens it.
        header.get_by_role("button", name="Details", exact=True).click()
        expect(page.locator("#details .ov-goal")).to_contain_text("Know when each garden bed needs water")
        page.keyboard.press("Escape")
        # Home's project card shows the goal too.
        page.goto("/")
        expect(page.get_by_role("region", name="Your projects", exact=True).get_by_role("link", name=re.compile(f"^{PROJECT}"))).to_contain_text(
            "Know when each garden bed needs water")

        # A viewer reads the goal and cannot change it.
        viewer_context = self.browser.new_context(base_url=ORIGIN, viewport=DESKTOP)
        self.addCleanup(viewer_context.close)
        viewer = viewer_context.new_page()
        email = f"vera.viewer+{uuid.uuid4()}@example.test"
        viewer.goto("/sign-up")
        viewer.get_by_label("Name").fill("Vera Viewer")
        viewer.get_by_label("Email").fill(email)
        viewer.get_by_label("Password").fill(PASSWORD)
        viewer.get_by_role("button", name="Create account").click()
        expect(viewer.get_by_role("heading", level=1, name="Home")).to_be_visible()
        vera = self.call(viewer, "GET", "/api/v1/me")["user"]
        self.call(page, "POST", f"/api/v1/workspaces/{self.workspace['id']}/members", {"email": email, "role": "member"}, 201)
        self.call(page, "POST", f"/api/v1/projects/{self.project['id']}/grants", {"principal": {"kind": "human", "id": vera["id"]}, "role": "viewer"}, 201)
        viewer.goto(f"/projects/{self.project['id']}")
        vheader = viewer.locator("header.top")
        expect(vheader.locator(".top__goal")).to_contain_text("Know when each garden bed needs water")
        expect(vheader.get_by_role("button", name=re.compile("change the goal"))).to_have_count(0)
        expect(vheader.get_by_role("button", name="Add a goal")).to_have_count(0)

    # ------------------------------------------------------------------ FF-3 a note becomes a message

    def test_09_a_note_is_sent_to_a_project_and_waits_in_its_message_box(self):
        page = self.page()
        project = self.project["id"]
        # An unsent message is already waiting in the project's box; the note joins it below.
        page.goto(f"/projects/{project}")
        box = page.get_by_label("Write a message", exact=True)
        box.fill("Before the note")
        page.goto("/notes")
        note = f"Ask Lena for the spare hose clamps {uuid.uuid4().hex[:6]}"
        composer = page.get_by_label("Private note", exact=True)
        composer.fill(note)
        composer.press("Enter")
        item = page.get_by_role("region", name="Private drafts").get_by_role("listitem").filter(has_text=note)
        expect(item).to_be_visible()
        expect(item.get_by_role("button", name="Copy")).to_be_visible()
        send = item.get_by_role("button", name="Send to a project")
        expect(send).to_have_attribute("aria-expanded", "false")
        send.click()
        expect(send).to_have_attribute("aria-expanded", "true")
        choices = item.get_by_role("group", name="Send this note to a project")
        expect(choices).to_contain_text("Nothing is shared until you send it.")
        before = self.call(page, "GET", f"/api/v1/projects/{project}/conversations")["items"]
        choices.get_by_role("button", name=re.compile(f"^{PROJECT}")).click()
        expect(page).to_have_url(re.compile(rf"/projects/{project}$"))
        box = page.get_by_label("Write a message", exact=True)
        expect(box).to_have_value(f"Before the note\n\n{note}")
        expect(box).to_be_focused()
        # Nothing is posted until Send.
        page.wait_for_timeout(500)
        self.assertEqual(len(self.call(page, "GET", f"/api/v1/projects/{project}/conversations")["items"]), len(before), "nothing was posted")
        expect(page.locator(".project-convo__message", has_text=note)).to_have_count(0)
        # A reload does not add the note a second time.
        page.reload()
        expect(page.get_by_label("Write a message", exact=True)).to_have_value(f"Before the note\n\n{note}")
        # The note stays in My sketchbook.
        page.goto("/notes")
        expect(page.get_by_role("region", name="Private drafts").get_by_text(note)).to_be_visible()
        # Leave the project's box empty for the other tests.
        page.goto(f"/projects/{project}")
        page.get_by_label("Write a message", exact=True).fill("")

    # ------------------------------------------------------------------ FF-2 decisions waiting on Home

    def test_10_a_decision_waiting_for_you_shows_on_home(self):
        page = self.page()
        title = "Water the raised beds from the rain barrel first"
        proposal = self.call(page, "POST", f"/api/v1/projects/{self.project['id']}/decisions", {"title": title, "rationale": "It saves tap water"}, 201)
        page.goto("/")
        for_you = page.get_by_role("region", name="For you", exact=True)
        decisions = for_you.get_by_role("list", name="Decisions waiting for you")
        row = decisions.get_by_role("link", name=re.compile(f"^Decide: {title}"))
        expect(row).to_contain_text(f"{PROJECT} · proposed, waiting for your decision")
        expect(row).to_have_attribute("href", f"/projects/{self.project['id']}?open=decision:{proposal['id']}")
        expect(for_you.locator(".home-sec__count")).to_have_attribute("aria-label", re.compile(r"^\d+ needs? you$"))
        expect(page.get_by_role("region", name="Your projects", exact=True).get_by_role("link", name=re.compile(f"^{PROJECT}"))).to_contain_text("A decision needs you")
        shot(page, "272-home-decision-desktop-1440")
        # On a phone For you is below the first screen, so the greeting says what waits and goes there
        # (visual review of #275).
        phone = self.page(PHONE, touch=True)
        phone.goto("/")
        waiting = phone.locator(".home__hello").get_by_role("button", name=re.compile(r"^\d+ (decision|thing)s? needs? you$"))
        expect(waiting).to_be_visible()
        self.within_first_screen(phone, waiting, PHONE["height"], "what waits for you")
        self.assertGreaterEqual(self.box(waiting)["height"], 44, "a 44px target")
        waiting.tap()
        heading = phone.get_by_role("heading", name="For you", exact=True)
        expect(heading).to_be_focused()
        phone.wait_for_function("() => { const h = document.getElementById('home-for-you'); const r = h.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }")
        row.click()
        expect(page.locator("#details").get_by_role("heading", name=title)).to_be_visible()
        expect(page.locator("#details .wd-eyebrow")).to_contain_text("Proposed decision")

    # ------------------------------------------------------------------ FF-2 at most eight project cards

    def test_11_home_shows_eight_project_cards_and_links_to_all(self):
        # Last in the journey: it adds projects the other tests do not expect.
        page = self.page()
        for index in range(8):
            self.call(page, "POST", f"/api/v1/workspaces/{self.workspace['id']}/projects",
                      {"name": f"Garden bed {index + 1:02d}", "visibility": "restricted"}, 201)
        total = len(self.call(page, "GET", f"/api/v1/workspaces/{self.workspace['id']}/projects?limit=100")["items"])
        self.assertEqual(total, 9)
        page.goto("/")
        projects = page.get_by_role("region", name="Your projects", exact=True)
        expect(projects.locator(".home-project")).to_have_count(8)
        everything = projects.get_by_role("link", name=re.compile(rf"^All {total} projects"))
        expect(everything).to_have_attribute("href", "/projects")
        expect(projects.get_by_role("link", name="New project")).to_be_visible()
        everything.click()
        expect(page).to_have_url(f"{ORIGIN}/projects")
        expect(page.get_by_role("heading", level=1, name="Projects")).to_be_visible()


    # ------------------------------------------------------------------ FF-10 a conversation opens on what was said last

    def test_12_a_phone_conversation_opens_next_to_the_message_box(self):
        page = self.page()
        project = self.call(page, "POST", f"/api/v1/workspaces/{self.workspace['id']}/projects", {"name": "Rain barrel monitor", "visibility": "restricted"}, 201)
        # A long goal, so the header's second line has to shorten something.
        response = page.request.fetch(f"{ORIGIN}/api/v1/projects/{project['id']}", method="PATCH",
            headers={"origin": ORIGIN, "content-type": "application/json", "if-match": f"\"{project['version']}\""},
            data=json.dumps({"goal": "Know when each raised bed needs water before the seedlings wilt in a dry week"}))
        self.assertEqual(response.status, 200, response.text())
        say = lambda body: self.call(page, "POST", f"/api/v1/projects/{project['id']}/conversations", {"body": body, "clientMessageId": str(uuid.uuid4())}, 201)  # noqa: E731
        say("Where should the overflow sensor go?")
        say("The barrel by the shed fills first, so I would start there.")
        # A tall message before the newest entries: opening on it whole would leave most of the phone's stream empty.
        say(" ".join(["The float switch reads full at 180 litres, but the lid leaks when it rains hard, so the reading jumps."] * 7))
        mine = {"kind": "human", "id": self.me["id"]}
        titles = ["Seal the barrel lid", "Mount the float switch", "Log levels every hour"]
        for index, title in enumerate(titles):
            body = {"title": title, "clientCommandId": str(uuid.uuid4())}
            if index == 0: body.update(status="in_progress", owner=mine)
            self.call(page, "POST", f"/api/v1/projects/{project['id']}/work", body, 201)
        for viewport in ({"width": 375, "height": 667}, PHONE):
            with self.subTest(viewport=viewport["width"]):
                phone = self.page(viewport, touch=True)
                phone.goto(f"/projects/{project['id']}")
                notices = phone.locator(".convo-notice")
                expect(notices).to_have_count(len(titles))
                # Each announced task says where it stands now.
                expect(notices.first).to_contain_text("In progress · you")
                expect(notices.first.get_by_role("button", name=re.compile(f"^Open task: {titles[0]} · In progress · you$"))).to_be_visible()
                phone.wait_for_timeout(600)
                feed = self.box(phone.locator(".project-convo__feed.is-stream"))
                last = self.box(notices.last)
                self.assertGreaterEqual(feed["y"] + feed["height"] + 1, last["y"] + last["height"], "the newest entry is fully visible")
                self.assertLessEqual(feed["y"] + feed["height"] - (last["y"] + last["height"]), feed["height"] / 4 + 1, "the newest entry sits next to the message box")
                # The header is one block: back, the title with one line under it, and Details.
                header = self.box(phone.locator("header.top"))
                self.assertLessEqual(header["height"], 64, "the header does not wrap")
                # The short audience stays whole; a long goal shortens first.
                audience = phone.locator("header.top .top__audience > span:not(.ui-vh)")
                self.assertFalse(audience.evaluate("el => el.scrollWidth > el.clientWidth"), "the audience is not cut")
                state = phone.locator(".state-row .ws-state-row")
                expect(state).to_contain_text("Work in progress")
                self.assertLessEqual(self.box(state)["height"], 45, "one state line")
                chips = phone.get_by_role("navigation", name="Project views")
                top = self.box(chips)["y"]
                self.assertLess(top, self.box(state)["y"], "the chips come before the state line")
                chips.get_by_role("link", name=re.compile("^Tasks")).tap()
                expect(phone).to_have_url(re.compile("/tasks"))
                expect(phone.locator(".state-row")).to_have_count(0)
                self.settle(phone)
                self.assertAlmostEqual(self.box(chips)["y"], top, delta=1, msg="the chips keep their place between views")
                if viewport["width"] == 375: shot(phone, "272-conversation-phone-375")


    # How tall a control's hit area is at its middle, by hit-testing (HIG-14): what a tap there reaches.
    HIT_HEIGHT = """(el) => {
      const box = el.getBoundingClientRect();
      const x = box.left + Math.min(box.width / 2, 12);
      let top = box.top + box.height / 2, bottom = top;
      while (top > 0 && el.contains(document.elementFromPoint(x, top - 1))) top -= 1;
      while (bottom < innerHeight - 1 && el.contains(document.elementFromPoint(x, bottom + 1))) bottom += 1;
      return bottom - top + 1;
    }"""

    def test_13_on_a_tablet_the_project_header_stays_one_line(self):
        # The header's second line (audience, goal, state) stays one line at tablet widths (#136: at most 90 px);
        # a narrow state line once broke after every letter and grew the header a screen tall. On touch the
        # larger type applies too, and the audience and goal take a 44 px tap.
        for viewport in ({"width": 768, "height": 1024}, {"width": 1024, "height": 768}):
            for touch in (False, True):
                with self.subTest(width=viewport["width"], touch=touch):
                    page = self.page(viewport, touch=touch)
                    page.goto(f"/projects/{self.project['id']}")
                    header = page.locator("header.top")
                    expect(header.get_by_role("heading", level=1)).to_be_visible()
                    expect(header.get_by_label("Current state")).to_be_visible()
                    self.assertLessEqual(self.box(header)["height"], 90, "the header stays compact")
                    tallest = page.evaluate("() => Math.max(...[...document.querySelectorAll('header.top .ws-seg span')].map((el) => el.getBoundingClientRect().height))")
                    self.assertLessEqual(tallest, 26 if touch else 24, "each part of the state line is one line")
                    self.assertGreaterEqual(self.box(header.get_by_label("Current state"))["width"], 120, "the state keeps room before the goal does")
                    if touch:
                        for what in (".top__audience", "button.top__goal"):
                            self.assertGreaterEqual(header.locator(what).evaluate(self.HIT_HEIGHT), 43, f"{what} takes a 44 px tap")

    def test_13b_on_a_phone_the_audience_and_goal_take_a_44_px_tap(self):
        # The line under the title clips what overflows it; the hit areas that reach past it must not be cut.
        for viewport in ({"width": 375, "height": 667}, PHONE):
            with self.subTest(width=viewport["width"]):
                page = self.page(viewport, touch=True)
                page.goto(f"/projects/{self.project['id']}")
                header = page.locator("header.top")
                expect(header.locator(".top__audience")).to_be_visible()
                for what in (".top__audience", "button.top__goal"):
                    self.assertGreaterEqual(header.locator(what).evaluate(self.HIT_HEIGHT), 43, f"{what} takes a 44 px tap")


    # ------------------------------------------------------------------ HIG-08/09/11 type, HIG-16 press states

    SMALLEST_TEXT = """() => {
      let min = Infinity, where = '';
      for (const el of document.querySelectorAll('body *')) {
        if (![...el.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim())) continue;
        // Visible text counts whether or not assistive technology reads it (HIG-08 is about what people see).
        if (el.closest('.ui-vh, [hidden]')) continue;
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
        const box = el.getBoundingClientRect();
        if (box.width < 2 || box.height < 2 || box.bottom < 0 || box.top > innerHeight || box.right < 0 || box.left > innerWidth) continue;
        const size = parseFloat(style.fontSize);
        if (size < min) { min = size; where = `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} "${el.textContent.trim().slice(0, 30)}"`; }
      }
      return { min, where };
    }"""

    # Every visible text's size before and after doubling the default text size: what does not follow it (HIG-11).
    FIXED_TEXT = """() => {
      const texts = [...document.querySelectorAll('body *')].filter((el) => {
        if (![...el.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim())) return false;
        if (el.closest('.ui-vh, [hidden], .sk-canvas, .map-canvas')) return false;
        const box = el.getBoundingClientRect();
        return box.width >= 2 && box.height >= 2 && getComputedStyle(el).visibility !== 'hidden';
      });
      const before = texts.map((el) => parseFloat(getComputedStyle(el).fontSize));
      document.documentElement.style.fontSize = '200%';
      const fixed = texts.map((el, index) => ({ el, before: before[index], after: parseFloat(getComputedStyle(el).fontSize) }))
        .filter(({ before, after }) => after < before * 1.8)
        .map(({ el, before, after }) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 30)} "${el.textContent.trim().slice(0, 20)}" ${before}→${after}`);
      document.documentElement.style.fontSize = '';
      return fixed;
    }"""

    def test_14_touch_screens_read_at_11_pt_or_more_and_text_follows_the_default_size(self):
        paths = ("/", "/inbox", "/settings", "/notes", f"/projects/{self.project['id']}", f"/projects/{self.project['id']}/tasks")
        for viewport in (PHONE, {"width": 820, "height": 1180}):
            for path in paths:
                with self.subTest(width=viewport["width"], path=path):
                    page = self.page(viewport, touch=True)
                    page.goto(path)
                    expect(page.locator("header.top h1")).to_be_visible()
                    page.wait_for_timeout(400)
                    smallest = page.evaluate(self.SMALLEST_TEXT)
                    self.assertGreaterEqual(smallest["min"], 11, f"no visible text under 11 px (HIG-08): {smallest['where']}")
        # Doubling the default text size doubles every text on these pages (HIG-11: sizes in rem, not px).
        for path in paths:
            with self.subTest(path=path, check="follows the default size"):
                page = self.page(PHONE, touch=True)
                page.goto(path)
                expect(page.locator("header.top h1")).to_be_visible()
                page.wait_for_timeout(400)
                self.assertEqual(page.evaluate(self.FIXED_TEXT), [], "text that keeps its size when the default size doubles")
        # Reading text is 16 px on touch (HIG-09), and doubling the default text size doubles it (HIG-11, rem).
        page = self.page(PHONE, touch=True)
        page.goto("/notes")
        lead = page.get_by_label("Private note", exact=True)
        expect(lead).to_be_visible()
        base = page.evaluate("parseFloat(getComputedStyle(document.querySelector('header.top h1')).fontSize)")
        page.evaluate("document.documentElement.style.fontSize = '200%'")
        doubled = page.evaluate("parseFloat(getComputedStyle(document.querySelector('header.top h1')).fontSize)")
        self.assertAlmostEqual(doubled, base * 2, delta=1, msg="text follows the default size")
        self.assertGreaterEqual(page.evaluate("parseFloat(getComputedStyle(document.getElementById('composer')).fontSize)"), 16)

    def test_15_every_control_answers_a_press(self):
        page = self.page(PHONE, touch=True)

        def held(locator):
            """The control's fill under the pointer, then while pressed: a press shows past the hover."""
            locator.scroll_into_view_if_needed()
            box = self.box(locator)
            page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
            # Read once the control's own transition has had time to show it, as a person would see it.
            page.wait_for_timeout(300)
            rest = locator.evaluate("(el) => getComputedStyle(el).backgroundColor")
            page.mouse.down()
            page.wait_for_timeout(300)
            during = locator.evaluate("(el) => getComputedStyle(el).backgroundColor")
            # Released away from the control, so the press does not become a tap that navigates.
            page.mouse.move(1, 1)
            page.mouse.up()
            return rest, during

        def pressed(locator, what):
            rest, during = held(locator)
            self.assertNotEqual(during, rest, f"{what} changes when pressed, beyond its hover (HIG-16)")

        page.goto("/")
        bar = page.get_by_role("navigation", name="Main places")
        pressed(bar.get_by_role("link", name=re.compile("^Inbox")), "a place in the bottom bar")
        pressed(page.get_by_role("link", name=re.compile("^All my tasks")), "All my tasks")
        page.goto("/settings")
        pressed(page.get_by_role("link", name=re.compile("^What reaches you")), "a Settings row")
        page.goto(f"/projects/{self.project['id']}")
        audience = page.locator("header.top .top__audience")
        pressed(audience, "the audience in the header")
        pressed(page.get_by_role("button", name=re.compile("^Cite something saved")), "Cite in the message box")
        # Negative control: with a press that looks like the hover, the same check sees no change.
        page.add_style_tag(content=":root, :root[data-theme] { --bg-press: var(--bg-hover) !important; }")
        rest, during = held(audience)
        self.assertEqual(during, rest, "the check tells a press from a hover")
        # The current place keeps its accent while pressed and dims instead of turning grey.
        current = bar.locator('[aria-current="page"]')
        before = current.evaluate("(el) => getComputedStyle(el).backgroundColor")
        box = self.box(current)
        page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        page.mouse.down()
        page.wait_for_timeout(300)
        self.assertEqual(current.evaluate("(el) => getComputedStyle(el).backgroundColor"), before, "the current place keeps its fill")
        self.assertLess(float(current.evaluate("(el) => getComputedStyle(el).opacity")), 1, "and dims while pressed")
        page.mouse.move(1, 1)
        page.mouse.up()


if __name__ == "__main__":
    unittest.main()
