"""The final phone shell (#341, F-026 §4 Phone and S2): Home · Projects · Inbox with a round Search, one
floating "+", the view menu in the title, and conversations without the tab bar.

Real authenticated browser and API data in Chromium with touch emulation, at 390 x 844 and 320 x 568,
in light and dark. Gestures are real touch taps.
"""
from __future__ import annotations

import json
import re
import unittest
import uuid

from playwright.sync_api import expect, sync_playwright

from test_app_shell import ORIGIN, UPSTREAM, shot, start_forwarder

SIZES = ({"width": 390, "height": 844}, {"width": 320, "height": 568})
PASSWORD = "phones deserve room to work"


class PhoneFinal(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
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
        page.on("pageerror", lambda error: errors.append(str(error)))
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
                self.assertEqual([text.strip() for text in links.all_inner_texts()], ["Home", "Projects", "Inbox"])
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
                for name in ("Home", "Projects", "Inbox"):
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
                for name, path in (("Inbox", "/inbox"), ("Projects", "/projects"), ("Home", "/")):
                    bar.get_by_role("link", name=re.compile(f"^{name}")).click()
                    expect(page).to_have_url(f"{ORIGIN}{path}")
                    expect(bar.get_by_role("link", name=re.compile(f"^{name}"))).to_have_attribute("aria-current", "page")
                    expect(bar.locator('[aria-current="page"]')).to_have_count(1)
                page.goto("/projects")
                expect(page.get_by_role("heading", level=1, name="Projects")).to_be_visible()
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
                bar = self.box(page.get_by_role("navigation", name="Main places"))
                self.assertLessEqual(fab["y"] + fab["height"], bar["y"], "the plus floats above the capsule")
                self.assertGreater(fab["x"], size["width"] / 2, "on the thumb side")
                header = page.locator("header")
                expect(header.get_by_role("button", name=re.compile(r"^(New|Add|Create)", re.I))).to_have_count(0)
                expect(page.get_by_role("button", name=re.compile("^New task in"))).to_have_count(0)
                expect(page.locator(".tb-add:visible")).to_have_count(0)
                plus.click()
                sheet = page.get_by_role("dialog", name="Create")
                expect(sheet).to_be_visible()
                names = [text.strip().split("\n")[0] for text in sheet.get_by_role("button").all_inner_texts() if text.strip()]
                self.assertEqual(names[:6], ["Task", "Thought", "Message", "Decision", "File or link", "Sketch"])
                for name in ("Task", "Thought", "Message", "Decision", "File or link", "Sketch"):
                    self.assertGreaterEqual(min(self.box(sheet.get_by_role("button", name=re.compile(f"^{name}")))["height"], 44), 44)
                self.assert_no_sideways_scroll(page, size["width"])
                shot(page, f"341-create-{size['width']}-{'dark' if dark else 'light'}")
                sheet.get_by_role("button", name=re.compile("^Task")).click()
                expect(page).to_have_url(re.compile(r"/tasks"))
                expect(page.get_by_role("dialog", name="Create")).to_have_count(0)

    def test_04_create_message_and_thought_use_the_places_that_make_them(self):
        page = self.page(SIZES[0])
        page.goto("/projects")
        page.get_by_role("button", name="Create", exact=True).click()
        page.get_by_role("dialog", name="Create").get_by_role("button", name=re.compile("^Message")).click()
        expect(page).to_have_url(f"{ORIGIN}/dm/new")
        expect(page.get_by_role("navigation", name="Main places")).to_have_count(0)
        page.goto("/inbox")
        page.get_by_role("button", name="Create", exact=True).click()
        page.get_by_role("dialog", name="Create").get_by_role("button", name=re.compile("^Thought")).click()
        expect(page).to_have_url(f"{ORIGIN}/map")
        expect(page.get_by_label("Private note", exact=True)).to_be_focused()

    # ------------------------------------------------------------------ AC-3

    def test_05_the_title_is_the_view_menu_with_no_chips(self):
        for size, dark in self.variants():
            with self.subTest(width=size["width"], dark=dark):
                page = self.page(size, dark)
                page.goto(f"/projects/{self.project['id']}/tasks")
                expect(page.get_by_role("navigation", name="Project views")).to_have_count(0)
                expect(page.locator(".views, .state-row")).to_have_count(0)
                heading = page.get_by_role("heading", level=1, name=re.compile("Community garden sensors"))
                expect(heading).to_be_visible()
                expect(page.locator("header .phead__sub")).to_contain_text("Tasks")
                title = heading.get_by_role("button")
                self.assertGreaterEqual(self.box(title)["height"], 28)
                title.click()
                menu = page.get_by_role("dialog", name=re.compile("Community garden sensors"))
                expect(menu).to_be_visible()
                labels = [text.strip().split("\n")[0] for text in menu.locator(".phone-menu__item").all_inner_texts()]
                # "What matters" (#133) stays reachable as a quiet last row now that the state row is gone.
                self.assertEqual(labels, ["Conversation", "Tasks", "Map", "Wiki", "Agents", "Details, goal and people", "What matters"])
                expect(menu.get_by_text("Decisions")).to_have_count(0)
                expect(menu.locator('[aria-current="page"]')).to_have_count(1)
                expect(menu.locator('[aria-current="page"]')).to_contain_text("Tasks")
                for item in menu.locator(".phone-menu__item").all():
                    self.assertGreaterEqual(self.box(item)["height"], 44)
                    self.assertGreaterEqual(float(item.evaluate("el => getComputedStyle(el).fontSize").removesuffix("px")), 15)
                self.assert_no_sideways_scroll(page, size["width"])
                shot(page, f"341-viewsmenu-{size['width']}-{'dark' if dark else 'light'}")
                menu.get_by_role("link", name=re.compile("^Map")).click()
                expect(page).to_have_url(re.compile(r"/map$"))
                page.get_by_role("heading", level=1).get_by_role("button").click()
                page.get_by_role("button", name="Details, goal and people").click()
                expect(page.get_by_role("dialog", name="Details")).to_be_visible()
                page.keyboard.press("Escape")

    def test_06_the_menu_works_from_the_keyboard(self):
        page = self.page(SIZES[0])
        page.goto(f"/projects/{self.project['id']}/docs")
        opener = page.get_by_role("heading", level=1).get_by_role("button")
        opener.focus()
        page.keyboard.press("Enter")
        menu = page.get_by_role("dialog", name=re.compile("Community garden sensors"))
        expect(menu.get_by_role("link", name=re.compile("^Conversation"))).to_be_focused()
        page.keyboard.press("Escape")
        expect(menu).to_have_count(0)
        expect(opener).to_be_focused()

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
                # Back follows the way you came: from Tasks, opened through the title, it returns to the conversation.
                page.get_by_role("link", name=re.compile("^Community garden sensors")).click()
                page.get_by_role("heading", level=1).get_by_role("button").click()
                page.get_by_role("dialog").get_by_role("link", name=re.compile("^Tasks")).click()
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
        self.assertEqual(labels[:2], ["Messages", "Sketches"])
        menu.get_by_role("link", name="Sketches").click()
        expect(page).to_have_url(re.compile(r"/sketches$"))
        expect(page.locator(".views")).to_have_count(0)

    def test_09_every_place_stays_reachable(self):
        page = self.page(SIZES[0])
        page.goto("/")
        # Settings through the avatar; Home's pages, the Sketchbook and Details from Home; Messages through Projects.
        page.get_by_role("link", name="Settings and account").click()
        expect(page).to_have_url(f"{ORIGIN}/settings")
        expect(page.get_by_role("heading", level=1, name="Settings")).to_be_visible()
        for link, path, title in (("All my tasks", "/tasks", "Your tasks"), ("Wiki", "/docs", "Wiki"), ("Sketchbook", "/map", "Sketchbook")):
            page.goto("/")
            page.locator(".home__more").get_by_role("link", name=link).click()
            expect(page).to_have_url(f"{ORIGIN}{path}")
            expect(page.get_by_role("heading", level=1, name=title)).to_be_visible()
            page.get_by_role("button", name="Back", exact=True).click()
            expect(page).to_have_url(f"{ORIGIN}/")
        page.locator(".home__more").get_by_role("button", name="Details", exact=True).click()
        expect(page.get_by_role("dialog", name="Details")).to_be_visible()
        page.keyboard.press("Escape")
        page.goto("/inbox")
        expect(page.get_by_role("link", name="Settings and account")).to_be_visible()

    # ------------------------------------------------------------------ AC-5

    def test_10_sizes_follow_the_system_text_size_and_targets_stay_44px(self):
        for size, dark in self.variants():
            with self.subTest(width=size["width"], dark=dark):
                page = self.page(size, dark)
                page.goto(f"/projects/{self.project['id']}/tasks")
                sizes = lambda selector: page.locator(selector).first.evaluate("el => parseFloat(getComputedStyle(el).fontSize)")  # noqa: E731
                self.assertGreaterEqual(sizes(".phead__sub"), 12.5, "meta text")
                self.assertGreaterEqual(sizes(".phone-dock__bar .ui-bottomnav__label"), 12.5, "tab labels")
                for selector in (".phead__round", ".phone-dock__search", ".phone-fab"):
                    item = self.box(page.locator(selector).first)
                    self.assertGreaterEqual(min(item["width"], item["height"]), 44, selector)
                labels = page.locator(".phone-dock__bar .ui-bottomnav__label")
                for index in range(labels.count()):
                    self.assertTrue(labels.nth(index).evaluate("el => el.scrollWidth <= el.clientWidth + 1"), "tab labels are not clipped")
                # rem: the page's own text size scales them.
                before = sizes(".phead__sub")
                page.evaluate("document.documentElement.style.fontSize = '20px'")
                self.assertAlmostEqual(sizes(".phead__sub"), before * 1.25, delta=0.6)
                self.assertAlmostEqual(sizes(".phone-dock__bar .ui-bottomnav__label"), before * 1.25, delta=0.6)
                page.evaluate("document.documentElement.style.fontSize = ''")
                self.assert_no_sideways_scroll(page, size["width"])


if __name__ == "__main__":
    unittest.main()
