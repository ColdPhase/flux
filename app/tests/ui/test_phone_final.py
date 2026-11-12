"""The final phone shell (#341, F-026 §4 Phone and S2): Home · Projects · Inbox with a round Search, one
floating "+", the views as underline tabs under a plain title (Back, the name and More in the title row, #1239), and conversations without the tab bar.

Real authenticated browser and API data with touch emulation, at 390 x 844 and 320 x 568, in light and
dark. Gestures are real touch taps. FLUX_UI_BROWSER selects chromium (default) or webkit.
"""
from __future__ import annotations

import json
import os
import re
import unittest
import uuid

from playwright.sync_api import expect, sync_playwright

from app_select import choose

from test_app_shell import ORIGIN, UPSTREAM, shot, start_forwarder

SIZES = ({"width": 390, "height": 844}, {"width": 320, "height": 568})
PASSWORD = "phones deserve room to work"
UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
if UI_BROWSER not in ("chromium", "webkit"):
    raise ValueError(f"FLUX_UI_BROWSER must be chromium or webkit, got {UI_BROWSER!r}")


class PhoneFinal(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=8000)
        cls.kai_email = f"kai-{uuid.uuid4()}@example.test"
        kai = cls.browser.new_context(base_url=ORIGIN)
        response = kai.request.post("/api/auth/sign-up/email", data={"email": cls.kai_email, "password": PASSWORD, "name": "Kai Tanaka"}, headers={"origin": ORIGIN})
        assert response.status == 200, response.text()
        cls.kai_id = kai.request.get("/api/v1/me").json()["user"]["id"]
        kai.close()
        context = cls.browser.new_context(base_url=ORIGIN)
        page = context.new_page()
        page.goto("/sign-up")
        page.get_by_label("Name").fill("Ada Final")
        page.get_by_label("Email").fill(f"final-{uuid.uuid4()}@example.test")
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        cls.state = context.storage_state()
        cls.workspace = cls.call(page, "POST", "/api/v1/workspaces", {"name": "Riverside Makers"}, 201)
        cls.call(page, "POST", f"/api/v1/workspaces/{cls.workspace['id']}/members", {"email": cls.kai_email, "role": "member"}, 201)
        cls.project = cls.call(page, "POST", f"/api/v1/workspaces/{cls.workspace['id']}/projects",
            {"name": "Community garden sensors", "visibility": "restricted"}, 201)
        cls.second_project = cls.call(page, "POST", f"/api/v1/workspaces/{cls.workspace['id']}/projects",
            {"name": "Riverside seed library", "visibility": "restricted"}, 201)
        for title, status in (("Order six capacitive probes", "in_progress"), ("Ask the school for two ESP32 kits", "open")):
            cls.call(page, "POST", f"/api/v1/projects/{cls.project['id']}/work", {"title": title, "status": status}, 201)
        # A direct message with Kai: opening the person's link creates the 1:1 once.
        page.goto(f"/dm/new?workspace={cls.workspace['id']}&with={cls.kai_id}")
        expect(page).to_have_url(re.compile(r"/dm/[0-9a-f-]{36}$"))
        cls.dm_path = page.url.removeprefix(ORIGIN)
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

    def page(self, size, dark=False):
        context = self.browser.new_context(base_url=ORIGIN, viewport=size, storage_state=self.state, color_scheme="dark" if dark else "light",
            is_mobile=True, has_touch=True)
        self.addCleanup(context.close)
        page = context.new_page()
        errors = []
        # WebKit reports a fetch that a document unload cancels as an uncaught page error ("... due to access
        # control checks", #471), even when the app handles it. Only those, and only while this test itself
        # loads another document with goto, are not the app's errors; every other page error still fails.
        leaving = {"now": False}

        def on_error(error):
            if UI_BROWSER == "webkit" and leaving["now"] and str(error).endswith("due to access control checks."):
                return
            errors.append(str(error))

        page.on("pageerror", on_error)
        goto = page.goto

        def leave_and_goto(url, **options):
            leaving["now"] = True
            try:
                return goto(url, **options)
            finally:
                leaving["now"] = False

        page.goto = leave_and_goto
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught browser errors"))
        return page

    def box(self, locator):
        value = None
        for _ in range(10):
            value = locator.bounding_box()
            if value is not None:
                break
            locator.page.wait_for_timeout(100)
        self.assertIsNotNone(value, f"{locator} has a box")
        return value

    def variants(self):
        return [(size, dark) for size in SIZES for dark in (False, True)]

    def assert_no_sideways_scroll(self, page, width):
        self.assertEqual(page.evaluate("document.documentElement.scrollWidth"), width, "no sideways scroll")

    # ------------------------------------------------------------------ AC-1

    def test_01_a_floating_capsule_holds_home_projects_inbox_and_a_round_search(self):
        for size, dark in self.variants():
            with self.subTest(width=size["width"], dark=dark):
                page = self.page(size, dark)
                page.goto("/")
                bar = page.get_by_role("navigation", name="Main places")
                expect(bar).to_be_visible()
                links = bar.get_by_role("link")
                self.assertEqual([text.strip() for text in links.all_inner_texts()], ["Home", "Spaces", "Inbox"])
                expect(bar.get_by_role("link", name="Messages")).to_have_count(0)
                capsule = self.box(bar)
                self.assertGreaterEqual(capsule["height"], 56, "a capsule, not a thin bar")
                self.assertGreaterEqual(capsule["y"] + capsule["height"], size["height"] - 40)
                self.assertLessEqual(capsule["y"] + capsule["height"], size["height"] - 8, "it floats above the bottom edge")
                self.assertGreaterEqual(capsule["x"], 8, "and in from the sides")
                self.assertEqual(bar.evaluate("el => getComputedStyle(el).borderRadius"), "31px")
                search = page.get_by_role("button", name="Search", exact=True)
                round_box = self.box(search)
                self.assertAlmostEqual(round_box["width"], round_box["height"], delta=1, msg="Search is round")
                self.assertGreaterEqual(round_box["width"], 44)
                self.assertAlmostEqual(round_box["y"], capsule["y"], delta=6, msg="beside the capsule")
                self.assertGreater(round_box["x"], capsule["x"] + capsule["width"] - 2)
                for name in ("Home", "Spaces", "Inbox"):
                    item = self.box(bar.get_by_role("link", name=re.compile(f"^{name}")))
                    self.assertGreaterEqual(min(item["width"], item["height"]), 44, name)
                expect(bar.locator('[aria-current="page"]')).to_contain_text("Home")
                # No other bottom bar.
                self.assertEqual(page.locator("nav[aria-label='Main places'], .ui-bottomnav").count(), 1)
                self.assert_no_sideways_scroll(page, size["width"])
                shot(page, f"341-home-{size['width']}-{'dark' if dark else 'light'}")
                search.click()
                expect(page.get_by_role("dialog")).to_be_visible()
                page.keyboard.press("Escape")

    def test_02_direct_messages_live_in_projects_and_the_places_move_the_current_mark(self):
        for size, dark in self.variants():
            with self.subTest(width=size["width"], dark=dark):
                page = self.page(size, dark)
                page.goto("/")
                bar = page.get_by_role("navigation", name="Main places")
                for name, path in (("Inbox", "/inbox"), ("Spaces", "/projects"), ("Home", "/")):
                    bar.get_by_role("link", name=re.compile(f"^{name}")).click()
                    expect(page).to_have_url(f"{ORIGIN}{path}")
                    expect(bar.get_by_role("link", name=re.compile(f"^{name}"))).to_have_attribute("aria-current", "page")
                    expect(bar.locator('[aria-current="page"]')).to_have_count(1)
                page.goto("/projects")
                expect(page.get_by_role("heading", level=1, name="Spaces")).to_be_visible()
                expect(page.get_by_role("heading", name="Direct messages")).to_be_visible()
                row = page.get_by_role("link", name=re.compile("Kai Tanaka"))
                expect(row).to_be_visible()
                self.assertGreaterEqual(self.box(row)["height"], 44)
                row.click()
                expect(page).to_have_url(f"{ORIGIN}{self.dm_path}")
                expect(bar).to_have_count(0)
                page.go_back()
                expect(page).to_have_url(f"{ORIGIN}/projects")
                self.assert_no_sideways_scroll(page, size["width"])
                shot(page, f"341-projects-{size['width']}-{'dark' if dark else 'light'}")

    # ------------------------------------------------------------------ AC-2

    def test_03_one_floating_plus_opens_create_and_no_header_has_another(self):
        for size, dark in self.variants():
            with self.subTest(width=size["width"], dark=dark):
                page = self.page(size, dark)
                page.goto(f"/projects/{self.project['id']}/tasks")
                plus = page.get_by_role("button", name="Create", exact=True)
                expect(plus).to_have_count(1)
                fab = self.box(plus)
                self.assertGreaterEqual(min(fab["width"], fab["height"]), 44)
                # Spokój rule 7: a project's views have no capsule (Search is in the header); the plus floats alone.
                expect(page.get_by_role("navigation", name="Main places")).to_have_count(0)
                self.assertLessEqual(fab["y"] + fab["height"], size["height"] - 8, "the plus floats above the bottom edge")
                self.assertGreater(fab["x"], size["width"] / 2, "on the thumb side")
                header = page.locator("header")
                expect(header.get_by_role("button", name=re.compile(r"^(New|Add|Create)", re.I))).to_have_count(0)
                expect(page.get_by_role("button", name=re.compile("^New task in"))).to_have_count(0)
                expect(page.locator(".tb-add:visible")).to_have_count(0)
                plus.click()
                sheet = page.get_by_role("dialog", name="Create")
                expect(sheet).to_be_visible()
                names = [text.strip().split("\n")[0] for text in sheet.get_by_role("button").all_inner_texts() if text.strip()]
                self.assertEqual(names[:5], ["Task", "Thought", "Decision", "Page", "Space"])
                for name in ("Task", "Thought", "Decision", "Page", "Space"):
                    self.assertGreaterEqual(min(self.box(sheet.get_by_role("button", name=re.compile(f"^{name}")))["height"], 44), 44)
                self.assert_no_sideways_scroll(page, size["width"])
                shot(page, f"341-create-{size['width']}-{'dark' if dark else 'light'}")
                sheet.get_by_role("button", name=re.compile("^Task")).click()
                expect(page).to_have_url(re.compile(r"/tasks"))
                # The Task tile opens the one Create window in this project; the sheet itself is gone.
                expect(page.get_by_role("dialog", name="New task").get_by_label("Title", exact=True)).to_be_visible()

    def test_04_create_thought_uses_the_window_that_makes_it(self):
        page = self.page(SIZES[0])
        page.goto("/inbox")
        page.get_by_role("button", name="Create", exact=True).click()
        page.get_by_role("dialog", name="Create").get_by_role("button", name=re.compile("^Thought")).click()
        # The same Create window as the computer's, on its Thought tab; the thought goes on My map (#866).
        thought = page.get_by_role("dialog", name="New thought")
        expect(thought.get_by_role("textbox", name="Thought", exact=True)).to_be_visible()

    def test_04b_create_decision_and_page_start_those_things_in_the_chosen_project(self):
        page = self.page(SIZES[0])
        base = f"/api/v1/projects/{self.project['id']}"
        # Decision: the same Create window as the computer's, on its Decision tab, in the space chosen in the window (#1013: the sheet has no picker).
        page.goto("/inbox")
        page.get_by_role("button", name="Create", exact=True).click()
        sheet = page.get_by_role("dialog", name="Create")
        expect(sheet.get_by_role("combobox")).to_have_count(0)
        sheet.get_by_role("button", name=re.compile("^Decision")).click()
        window = page.get_by_role("dialog", name="New decision")
        choose(window.get_by_role("combobox", name="Space"), self.project["id"])
        title = f"Probes stay on the north beds {uuid.uuid4().hex[:6]}"
        window.get_by_role("textbox", name="Decision", exact=True).fill(title)
        window.get_by_role("button", name=re.compile("^Propose decision")).click()
        expect(page.locator(".ui-toast", has_text="Decision proposed")).to_be_visible()
        decisions: list = []
        for _ in range(60):
            decisions = self.call(page, "GET", f"{base}/decisions?limit=100")["items"]
            if title in [item["title"] for item in decisions]:
                break
            page.wait_for_timeout(250)
        self.assertIn(title, [item["title"] for item in decisions])
        # Page: a Wiki page in the chosen space; it opens ready to write.
        page.goto("/projects")
        page.get_by_role("button", name="Create", exact=True).click()
        sheet = page.get_by_role("dialog", name="Create")
        sheet.get_by_role("button", name=re.compile("^Page")).click()
        window = page.get_by_role("dialog", name="New page")
        choose(window.get_by_role("combobox", name="Space"), self.project["id"])
        name = f"Bed map {uuid.uuid4().hex[:6]}"
        window.get_by_role("textbox", name="Page title", exact=True).fill(name)
        window.get_by_role("button", name=re.compile("^Create page")).click()
        expect(page).to_have_url(re.compile(rf"{ORIGIN}/projects/{self.project['id']}/docs/[0-9a-f-]{{36}}$"))
        expect(page.get_by_role("heading", level=2).get_by_role("button", name=name)).to_be_visible()

    # ------------------------------------------------------------------ AC-3

    def test_05_the_views_are_underline_tabs_under_a_plain_title_with_no_chips(self):
        for size, dark in self.variants():
            with self.subTest(width=size["width"], dark=dark):
                page = self.page(size, dark)
                page.goto(f"/projects/{self.project['id']}/tasks")
                expect(page.locator(".views, .state-row")).to_have_count(0)
                heading = page.get_by_role("heading", level=1, name=re.compile("Community garden sensors"))
                expect(heading).to_be_visible()
                # The title is the title, not a menu (#873).
                expect(heading.get_by_role("button")).to_have_count(0)
                expect(page.locator("header .phead__sub")).to_contain_text(re.compile("person|people"))
                views = page.get_by_role("navigation", name="Space views")
                expect(views).to_be_visible()
                # A tab list: each view is a tab, the current one is selected (#1239).
                tablist = views.get_by_role("tablist", name="Space views")
                labels = [text.strip().split("\n")[0].split(",")[0] for text in tablist.get_by_role("tab").all_inner_texts()]
                self.assertEqual(labels, ["Conversation", "Tasks", "Map", "Wiki"])
                expect(views.locator('[aria-current="page"]')).to_have_count(1)
                expect(views.locator('[aria-current="page"]')).to_contain_text("Tasks")
                expect(tablist.get_by_role("tab", selected=True)).to_have_count(1)
                expect(tablist.get_by_role("tab", name=re.compile("^Tasks"))).to_have_attribute("aria-selected", "true")
                expect(views.get_by_text("Decisions")).to_have_count(0)
                # AC-5: every phone touch target is at least 44 px, the views included. Each tab is as wide as its word (22 px of padding around
                # it) and left-aligned: the words are not equal slots, and the first starts at the page's gutter.
                tabs = tablist.get_by_role("tab").all()
                widths = []
                for item in tabs:
                    self.assertGreaterEqual(self.box(item)["height"], 44)
                    self.assertGreaterEqual(self.box(item)["width"], 44)
                    widths.append(self.box(item)["width"])
                self.assertNotAlmostEqual(widths[0], widths[-1], delta=20, msg=f"tabs are as wide as their words: {widths}")
                first_word = page.evaluate("""() => { const label = document.querySelector('.phead__views .ui-tabs__label'); return label.getBoundingClientRect().left; }""")
                self.assertAlmostEqual(first_word, 18, delta=3, msg="the first word lines up with the page's gutter")
                gaps = [self.box(tabs[i + 1])["x"] - (self.box(tabs[i])["x"] + self.box(tabs[i])["width"]) for i in range(len(tabs) - 1)]
                self.assertTrue(all(abs(gap) <= 1 for gap in gaps), f"tabs sit side by side; the 22 px between words is their padding: {gaps}")
                look = page.evaluate("""() => {
                  const mark = document.querySelector('.phead__views .ui-tabs__indicator'), bar = document.querySelector('.phead__views .ui-tabs__bar');
                  const current = document.querySelector('.phead__views [aria-current="page"]'), other = document.querySelector('.phead__views [role="tab"]:not([aria-current])');
                  const style = (el) => getComputedStyle(el);
                  return { markHeight: mark.getBoundingClientRect().height, markColor: style(mark).backgroundColor, ink: style(current).color, ink2: style(other).color,
                    weight: style(current).fontWeight, weight2: style(other).fontWeight, track: style(bar).borderRadius, fill: style(bar).backgroundColor,
                    shadow: style(bar).boxShadow };
                }""")
                self.assertEqual(look["markHeight"], 2, "a 2 px underline")
                self.assertEqual(look["markColor"], look["ink"], "the underline is the current tab's ink")
                self.assertNotEqual(look["ink"], look["ink2"], "the others are quieter")
                self.assertEqual((look["weight"], look["weight2"]), ("500", "400"))
                self.assertEqual(look["shadow"], "none", "no raised track")
                self.assert_no_sideways_scroll(page, size["width"])
                shot(page, f"341-views-{size['width']}-{'dark' if dark else 'light'}")
                views.get_by_role("tab", name=re.compile("^Map")).click()
                expect(page).to_have_url(re.compile(r"/map$"))
                # Search, Call, Settings and the space's details are in More: the title row holds Back, the name and More only (#1239).
                page.get_by_role("button", name="More", exact=True).click()
                menu = page.get_by_role("menu", name="More")
                items = [text.split("\n")[0].strip() for text in menu.locator("[role^=menuitem]:visible").all_inner_texts()]
                self.assertEqual(items, ["Search", "Call", "Settings", "Space details"])
                menu.get_by_role("menuitem", name="Space details").click()
                expect(page.get_by_role("dialog", name="Details")).to_be_visible()
                expect(page.get_by_role("dialog", name="Details").get_by_role("button", name="What matters")).to_have_count(0)
                page.keyboard.press("Escape")

    def test_06_the_views_work_from_the_keyboard(self):
        page = self.page(SIZES[0])
        page.goto(f"/projects/{self.project['id']}/docs")
        views = page.get_by_role("navigation", name="Space views")
        conversation = views.get_by_role("tab", name=re.compile("^Conversation"))
        # One tab stop: the current view (Wiki), as a tab list has it; the others are reached with the arrows.
        self.assertEqual(views.get_by_role("tab").evaluate_all("tabs => tabs.map((tab) => tab.tabIndex)"), [-1, -1, -1, 0])
        conversation.focus()
        page.keyboard.press("Enter")
        expect(page).to_have_url(f"{ORIGIN}/projects/{self.project['id']}")
        expect(views.get_by_role("tab", name=re.compile("^Conversation"))).to_have_attribute("aria-current", "page")
        # Left and Right (wrapping), Home and End only move focus along the row; Enter or Space opens the tab in focus.
        page.keyboard.press("ArrowRight")
        expect(views.get_by_role("tab", name=re.compile("^Tasks"))).to_be_focused()
        page.keyboard.press("End")
        expect(views.get_by_role("tab", name=re.compile("^Wiki"))).to_be_focused()
        page.keyboard.press("ArrowRight")
        expect(views.get_by_role("tab", name=re.compile("^Conversation"))).to_be_focused()
        page.keyboard.press("ArrowLeft")
        expect(views.get_by_role("tab", name=re.compile("^Wiki"))).to_be_focused()
        page.keyboard.press("Home")
        page.keyboard.press("ArrowRight")
        expect(page).to_have_url(f"{ORIGIN}/projects/{self.project['id']}")
        page.keyboard.press("Space")
        expect(page).to_have_url(re.compile(r"/tasks(\?.*)?$"))
        expect(views.get_by_role("tab", name=re.compile("^Tasks"))).to_have_attribute("aria-selected", "true")
        # More is a menu from the keyboard too: Escape closes it and focus returns to it.
        more = page.get_by_role("button", name="More", exact=True)
        more.focus()
        page.keyboard.press("Enter")
        menu = page.get_by_role("menu", name="More")
        expect(menu).to_be_visible()
        page.keyboard.press("Escape")
        expect(menu).to_have_count(0)
        expect(more).to_be_focused()

    # ------------------------------------------------------------------ AC-4

    def test_07_a_conversation_has_no_tab_bar_and_back_returns_where_you_came_from(self):
        for size, dark in self.variants():
            with self.subTest(width=size["width"], dark=dark):
                page = self.page(size, dark)
                page.goto("/projects")
                page.get_by_role("link", name=re.compile("^Community garden sensors")).click()
                expect(page).to_have_url(f"{ORIGIN}/projects/{self.project['id']}")
                expect(page.get_by_role("navigation", name="Main places")).to_have_count(0)
                expect(page.get_by_role("button", name="Create", exact=True)).to_have_count(0)
                composer = page.locator(".project-convo__composer")
                expect(composer).to_be_visible()
                area = self.box(composer)
                self.assertAlmostEqual(area["y"] + area["height"], size["height"], delta=2, msg="the composer sits at the bottom")
                self.assert_no_sideways_scroll(page, size["width"])
                shot(page, f"341-conversation-{size['width']}-{'dark' if dark else 'light'}")
                back = page.get_by_role("button", name="Back", exact=True)
                self.assertGreaterEqual(min(self.box(back)["width"], self.box(back)["height"]), 44)
                back.click()
                expect(page).to_have_url(f"{ORIGIN}/projects")
                expect(page.get_by_role("navigation", name="Main places")).to_be_visible()
                # Back follows the way you came: from Tasks, opened through the views, it returns to the conversation.
                page.get_by_role("link", name=re.compile("^Community garden sensors")).click()
                page.get_by_role("navigation", name="Space views").get_by_role("tab", name=re.compile("^Tasks")).click()
                expect(page).to_have_url(re.compile(r"/tasks"))
                page.get_by_role("button", name="Back", exact=True).click()
                expect(page).to_have_url(f"{ORIGIN}/projects/{self.project['id']}")

    def test_08_a_direct_message_has_no_tab_bar_either_and_other_places_reach_it(self):
        page = self.page(SIZES[0])
        page.goto(self.dm_path)
        expect(page.get_by_role("navigation", name="Main places")).to_have_count(0)
        title = page.get_by_role("heading", level=1, name=re.compile("Kai Tanaka"))
        expect(title).to_be_visible()
        title.get_by_role("button").click()
        menu = page.get_by_role("dialog", name=re.compile("Kai Tanaka"))
        labels = [text.strip().split("\n")[0] for text in menu.locator(".phone-menu__item").all_inner_texts()]
        # A direct message has the one view, Messages; its sketches are gone (#866).
        self.assertEqual(labels[:1], ["Messages"])
        self.assertNotIn("Sketches", labels)
        expect(page.locator(".views")).to_have_count(0)

    def test_09_every_place_stays_reachable(self):
        page = self.page(SIZES[0])
        page.goto("/")
        # Settings through the avatar; Home's rows for My tasks and My map; Messages through Projects.
        page.get_by_role("link", name="Settings and account").click()
        expect(page).to_have_url(f"{ORIGIN}/settings")
        expect(page.get_by_role("heading", level=1, name="Settings")).to_be_visible()
        for link, path, shell_title, content_title in ((re.compile(r"^My tasks"), "/tasks", "My tasks", "Nothing is waiting for you"),):
            page.goto("/")
            page.get_by_role("list", name="Your places").get_by_role("link", name=link).click()
            expect(page).to_have_url(f"{ORIGIN}{path}")
            # Each names itself in the header: My tasks (#763 NV-1).
            expect(page.get_by_role("heading", level=1, name=shell_title, exact=True)).to_be_visible()
            expect(page.get_by_role("heading", level=2, name=content_title)).to_be_visible()
            page.get_by_role("button", name="Back", exact=True).click()
            expect(page).to_have_url(f"{ORIGIN}/")
        # My map opens the person's one private map at its own address; Back leads Home (#866).
        page.goto("/")
        page.get_by_role("list", name="Your places").get_by_role("link", name=re.compile(r"^My map")).click()
        expect(page).to_have_url(re.compile(rf"{ORIGIN}/map/[0-9a-f-]{{36}}$"))
        expect(page.get_by_role("heading", level=1, name="My map", exact=True)).to_be_visible()
        # Home has no Details: a company's people are in Settings › Company, an encrypted space's people and keys in its own settings (#964).
        page.goto("/")
        expect(page.get_by_role("list", name="Your places")).to_be_visible()
        expect(page.locator("#content .home").get_by_role("button", name="Details", exact=True)).to_have_count(0)
        page.goto("/inbox")
        expect(page.get_by_role("link", name="Settings and account")).to_be_visible()

    # ------------------------------------------------------------------ AC-5

    def test_10_sizes_follow_the_system_text_size_and_targets_stay_44px(self):
        for size, dark in self.variants():
            with self.subTest(width=size["width"], dark=dark):
                page = self.page(size, dark)
                page.goto(f"/projects/{self.project['id']}/tasks")
                sizes = lambda selector: page.locator(selector).first.evaluate("el => parseFloat(getComputedStyle(el).fontSize)")  # noqa: E731
                # A project view (Spokój #507): the header's round controls and the floating plus are 44 px targets.
                self.assertGreaterEqual(sizes(".phead__sub"), 12.5, "meta text")
                for selector in (".phead__round", ".phone-fab"):
                    item = self.box(page.locator(selector).first)
                    self.assertGreaterEqual(min(item["width"], item["height"]), 44, selector)
                # rem: the page's own text size scales the header's meta text.
                before = sizes(".phead__sub")
                page.evaluate("document.documentElement.style.fontSize = '20px'")
                self.assertAlmostEqual(sizes(".phead__sub"), before * 1.25, delta=0.6)
                page.evaluate("document.documentElement.style.fontSize = ''")
                self.assert_no_sideways_scroll(page, size["width"])
                # Home carries the capsule: its tab labels and round Search are targets, not clipped.
                page.goto("/")
                self.assertGreaterEqual(sizes(".phone-dock__bar .ui-bottomnav__label"), 12.5, "tab labels")
                item = self.box(page.locator(".phone-dock__search").first)
                self.assertGreaterEqual(min(item["width"], item["height"]), 44, "Search")
                labels = page.locator(".phone-dock__bar .ui-bottomnav__label")
                for index in range(labels.count()):
                    self.assertTrue(labels.nth(index).evaluate("el => el.scrollWidth <= el.clientWidth + 1"), "tab labels are not clipped")
                before = sizes(".phone-dock__bar .ui-bottomnav__label")
                page.evaluate("document.documentElement.style.fontSize = '20px'")
                self.assertAlmostEqual(sizes(".phone-dock__bar .ui-bottomnav__label"), before * 1.25, delta=0.6)
                page.evaluate("document.documentElement.style.fontSize = ''")
                self.assert_no_sideways_scroll(page, size["width"])

    def test_11_create_sheet_selection_and_text_persist_and_create_only_in_selected_project(self):
        # The "+" sheet has one way to create: its Task row opens the one Create window (#345), whose Space picker chooses the project (#1013).
        page = self.page(SIZES[0])
        page.goto("/projects")
        title = f"Print bed labels {uuid.uuid4().hex[:8]}"
        page.get_by_role("button", name="Create", exact=True).click()
        page.get_by_role("dialog", name="Create").get_by_role("button", name="Task", exact=True).click()
        choose(page.get_by_role("dialog", name="New task").get_by_role("combobox", name="Space"), self.second_project["id"])
        field = page.get_by_role("dialog", name="New task").get_by_label("Title", exact=True)
        expect(field).to_be_visible()
        field.fill(title)

        # An unfinished task stays private to this account and project across reload (the window's kept draft).
        page.reload()
        page.get_by_role("button", name="Create", exact=True).click()
        page.get_by_role("dialog", name="Create").get_by_role("button", name="Task", exact=True).click()
        project_picker = page.get_by_role("dialog", name="New task").get_by_role("combobox", name="Space")
        choose(project_picker, self.second_project["id"])
        field = page.get_by_role("dialog", name="New task").get_by_label("Title", exact=True)
        expect(field).to_have_value(title)
        page.get_by_role("dialog", name="New task").get_by_role("button", name=re.compile("^Create task")).click()
        expect(page.locator("#details")).to_contain_text(title)
        selected_work = self.call(page, "GET", f"/api/v1/projects/{self.second_project['id']}/work?limit=100")
        first_work = self.call(page, "GET", f"/api/v1/projects/{self.project['id']}/work?limit=100")
        created_selected = [item for item in selected_work["items"] if item["title"] == title]
        created_first = [item for item in first_work["items"] if item["title"] == title]
        self.assertEqual(len(created_selected), 1, "the submitted phone text becomes exactly one task in the persisted selected project")
        self.assertEqual(created_first, [], "submitting from the reloaded sheet does not create the task in the first project")

    # ------------------------------------------------------------------ #1239

    LONG_NAME = "North allotment community garden sensors and rain barrel monitoring"

    def header_geometry(self, page):
        """Boxes of the space header's parts, in CSS px, read in the page."""
        return page.evaluate("""() => {
          const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
          const header = document.querySelector('header.phead'), h1 = header.querySelector('h1'), line = parseFloat(getComputedStyle(h1).lineHeight);
          const back = header.querySelector('button.phead__back'), more = header.querySelector('button[aria-label="More"]'), bar = header.querySelector('.ui-tabs__bar');
          const style = (el) => getComputedStyle(el);
          const plain = (el) => ({ fill: style(el).backgroundColor, shadow: style(el).boxShadow, icon: el.querySelector('svg').getBoundingClientRect().width });
          return { header: box(header), h1: box(h1), lines: Math.round(h1.getBoundingClientRect().height / line), clipped: h1.scrollHeight > h1.clientHeight + 1,
            back: box(back), more: box(more), tabs: box(header.querySelector('.phead__views')), bar: box(bar), barScrolls: bar.scrollWidth > bar.clientWidth + 1,
            sub: box(header.querySelector('.phead__sub')), plainBack: plain(back), plainMore: plain(more),
            others: [...header.querySelectorAll('button')].map((el) => el.getAttribute('aria-label') || el.textContent.trim()), page: document.documentElement.scrollWidth };
        }""")

    def test_12_the_space_header_is_back_the_name_and_more_with_the_views_under_it(self):
        # #1239: 320, 360, 390 and 430 px, light and dark, with a short and a very long name. The title row has Back, the name and More only,
        # as plain icons with 44 px hit areas; the name wraps to two lines at most; nothing overlaps; the page never scrolls sideways.
        long_project = self.call(self.page(SIZES[0]), "POST", f"/api/v1/workspaces/{self.workspace['id']}/projects", {"name": self.LONG_NAME, "visibility": "restricted"}, 201)
        for width, height in ((320, 640), (360, 740), (390, 844), (430, 900)):
            for dark in (False, True):
                for project, name, long in ((self.project, "Community garden sensors", False), (long_project, self.LONG_NAME, True)):
                    with self.subTest(width=width, dark=dark, name=name):
                        page = self.page({"width": width, "height": height}, dark)
                        page.goto(f"/projects/{project['id']}")
                        heading = page.get_by_role("heading", level=1, name=name)
                        expect(heading).to_be_visible()
                        expect(heading).to_have_text(name)  # the full name is the accessible name, whatever the ellipsis shows
                        page.evaluate("document.fonts.ready.then(() => true)")
                        part = self.header_geometry(page)
                        self.assertEqual(part["others"], ["Back", "More"], "the title row holds Back, the name and More only")
                        for control in ("back", "more"):
                            self.assertGreaterEqual(part[control]["width"], 44, control)
                            self.assertGreaterEqual(part[control]["height"], 44, control)
                        for plain in ("plainBack", "plainMore"):
                            self.assertIn(part[plain]["fill"], ("rgba(0, 0, 0, 0)", "transparent"), f"{plain} has no fill")
                            self.assertEqual(part[plain]["shadow"], "none", f"{plain} has no shadow")
                            self.assertAlmostEqual(part[plain]["icon"], 24, delta=0.5, msg=f"{plain} is a 24 px icon")
                        self.assertLessEqual(part["lines"], 2, "the name wraps to two lines at most")
                        self.assertLessEqual(part["back"]["right"], part["h1"]["x"] + 0.5, "Back and the name do not overlap")
                        self.assertLessEqual(part["h1"]["right"], part["more"]["x"] + 0.5, "the name and More do not overlap")
                        if long:
                            self.assertEqual(part["lines"], 2)
                            self.assertTrue(part["clipped"], "a very long name ends in an ellipsis after two lines")
                        else:
                            self.assertFalse(part["clipped"], "a normal name is whole: no ellipsis")
                        # 8 px under the top, 12 between the title row and the views (the row is as tall as its tallest part).
                        row_bottom = max(part["back"]["bottom"], part["more"]["bottom"], part["sub"]["bottom"])
                        row_top = min(part["back"]["y"], part["more"]["y"], part["h1"]["y"] - 2)
                        self.assertAlmostEqual(row_top - part["header"]["y"], 8, delta=1, msg="8 px above the title row")
                        self.assertAlmostEqual(part["tabs"]["y"] - row_bottom, 12, delta=3, msg="12 px between the title row and the views")
                        self.assertGreaterEqual(part["header"]["y"] + part["header"]["height"], part["bar"]["y"] + part["bar"]["height"] - 1)
                        self.assertEqual(part["page"], width, "no sideways page scroll")
                        shot(page, f"1239-header-{width}-{'long' if long else 'short'}-{'dark' if dark else 'light'}")
        # Large text (200%): the views row scrolls inside itself, and nothing in the header overlaps or scrolls the page.
        page = self.page({"width": 320, "height": 640})
        page.goto(f"/projects/{self.project['id']}")
        expect(page.get_by_role("heading", level=1, name="Community garden sensors")).to_be_visible()
        page.evaluate("document.documentElement.style.fontSize = '32px'")
        page.wait_for_timeout(300)
        part = self.header_geometry(page)
        self.assertTrue(part["barScrolls"], "the views scroll sideways inside their own row")
        self.assertEqual(part["page"], 320, "no sideways page scroll with large text")
        self.assertLessEqual(part["back"]["right"], part["h1"]["x"] + 0.5)
        self.assertLessEqual(part["h1"]["right"], part["more"]["x"] + 0.5)
        shot(page, "1239-header-320-large-text")

    def test_13_search_and_call_are_in_more_and_nothing_else_is_in_the_title_row(self):
        page = self.page(SIZES[1])
        page.goto(f"/projects/{self.project['id']}")
        header = page.locator("header.phead")
        expect(header.get_by_role("button", name="Search", exact=True)).to_have_count(0)
        expect(header.get_by_role("button", name="Call", exact=True)).to_have_count(0)
        page.get_by_role("button", name="More", exact=True).click()
        page.get_by_role("menuitem", name="Search", exact=True).click()
        expect(page.get_by_role("combobox", name="Search", exact=True)).to_be_visible()
        page.keyboard.press("Escape")
        # A press shows the 44 px target, and a tap leaves nothing drawn: no lingering hover fill on Back or More.
        more = page.get_by_role("button", name="More", exact=True)
        more.tap()
        self.assertIn(more.evaluate("el => getComputedStyle(el).backgroundColor"), ("rgba(0, 0, 0, 0)", "transparent"), "an open More leaves no filled circle")
        shot(page, "1239-more-open-390")


if __name__ == "__main__":
    unittest.main()
