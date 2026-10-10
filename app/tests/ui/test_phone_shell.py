"""Phone-first shell, current place and motion (#266, docs/design/phone-first.md PF-1 to PF-7), as the final
phone shell draws it (#341: the capsule, the view menu in the title, no chips; test_phone_final covers its criteria).

Actual authenticated browser and API data in Chromium. Viewports and touch are emulated, which
#266 item 10 accepts as phone evidence. Gestures use CDP touch events, so the browser produces
real touch pointer events.
"""
from __future__ import annotations

import json
import re
import unittest
import uuid

from playwright.sync_api import expect, sync_playwright

from test_app_shell import ORIGIN, UPSTREAM, shot, start_forwarder

VIEWS = ("Conversation", "Tasks", "Map", "Wiki", "Agents")
PLACES = ("Home", "Projects", "Inbox")
SE = {"width": 375, "height": 667}


class PhoneShellJourney(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        expect.set_options(timeout=8000)
        context = cls.browser.new_context(base_url=ORIGIN)
        page = context.new_page()
        page.goto("/sign-up")
        page.get_by_label("Name").fill("Ada Phone")
        page.get_by_label("Email").fill(f"phone-{uuid.uuid4()}@example.test")
        page.get_by_label("Password").fill("phones deserve room to work")
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        cls.state = context.storage_state()
        ws = cls.call(page, "POST", "/api/v1/workspaces", {"name": "Riverside Makers"}, 201)
        cls.project = cls.call(page, "POST", f"/api/v1/workspaces/{ws['id']}/projects",
            {"name": "Community garden sensors", "visibility": "restricted"}, 201)
        for title, status in (("Order six capacitive probes", "in_progress"), ("Ask the school for two ESP32 kits", "open"),
                              ("Measure LoRa range through the hedge", "done"), ("Write the volunteer guide", "open")):
            cls.call(page, "POST", f"/api/v1/projects/{cls.project['id']}/work", {"title": title, "status": status}, 201)
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

    def page(self, viewport=SE, dark=False, touch=True, reduced=False):
        phone = viewport["width"] <= 640
        context = self.browser.new_context(base_url=ORIGIN, viewport=viewport, storage_state=self.state,
            color_scheme="dark" if dark else "light", is_mobile=phone and touch, has_touch=phone and touch,
            reduced_motion="reduce" if reduced else "no-preference")
        self.addCleanup(context.close)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught browser errors"))
        return page

    def box(self, locator):
        # A list that re-renders between the visibility check and the measurement (a fresh read arriving)
        # briefly detaches the element; measure the settled element instead of failing on that moment.
        value = None
        for _ in range(10):
            value = locator.bounding_box()
            if value is not None:
                break
            locator.page.wait_for_timeout(100)
        self.assertIsNotNone(value, f"{locator} has a box")
        return value

    def settle(self, page):
        page.evaluate("() => Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => null)))")

    # ------------------------------------------------------------------ PF-1 and PF-2

    def open_views(self, page):
        page.get_by_role("heading", level=1).get_by_role("button").click()
        menu = page.get_by_role("dialog", name=re.compile("Community garden sensors"))
        expect(menu).to_be_visible()
        return menu

    def test_01_main_places_sit_in_a_floating_capsule_and_views_are_in_the_title(self):
        for width, height in ((320, 568), (375, 667), (390, 844)):
            with self.subTest(width=width):
                page = self.page({"width": width, "height": height})
                page.goto("/")
                bar = page.get_by_role("navigation", name="Main places")
                expect(bar).to_be_visible()
                bar_box = self.box(bar)
                self.assertLess(bar_box["y"] + bar_box["height"], height - 6, "the capsule floats above the bottom edge")
                self.assertGreater(bar_box["y"] + bar_box["height"], height - 40)
                for name in PLACES:
                    link = bar.get_by_role("link", name=re.compile(f"^{name}"))
                    expect(link).to_be_visible()
                    item = self.box(link)
                    self.assertGreaterEqual(min(item["width"], item["height"]), 44, f"44px target: {name}")
                    label = link.locator(".ui-bottomnav__label")
                    self.assertTrue(label.evaluate("el => el.scrollWidth <= el.clientWidth + 1"), f"{name} is not clipped at {width}px")
                current = bar.locator('[aria-current="page"]')
                expect(current).to_have_count(1)
                expect(current).to_contain_text("Home")
                self.settle(page)
                self.assertNotIn(current.evaluate("el => getComputedStyle(el).backgroundColor"), ("rgba(0, 0, 0, 0)", "transparent"),
                    "the current place is filled")
                self.assertEqual(page.evaluate("document.documentElement.scrollWidth"), width, "no sideways scroll")
                shot(page, f"266-home-phone-{width}")

                # Inside a project the capsule stays with Projects current; the views are in the title.
                page.goto(f"/projects/{self.project['id']}/tasks")
                expect(page.get_by_role("navigation", name="Project views")).to_have_count(0)
                expect(page.get_by_role("navigation", name="Main places").get_by_role("link", name="Projects")).to_have_attribute("aria-current", "page")
                header = self.box(page.locator("header"))
                self.assertLessEqual(header["y"] + header["height"], 80, "a single compact header")
                menu = self.open_views(page)
                current = menu.locator('[aria-current="page"]')
                expect(current).to_have_count(1)
                expect(current).to_contain_text("Tasks")
                for name in VIEWS:
                    row = menu.get_by_role("link", name=re.compile(f"^{name}"))
                    self.assertGreaterEqual(self.box(row)["height"], 44, f"44px row: {name}")
                expect(page.locator(".state-row")).to_have_count(0)
                self.assertEqual(page.evaluate("document.documentElement.scrollWidth"), width, "no sideways scroll")
                shot(page, f"266-tasks-phone-{width}")

    def test_02_places_and_views_move_the_current_mark(self):
        page = self.page()
        page.goto("/")
        bar = page.get_by_role("navigation", name="Main places")
        for name, path in (("Inbox", "/inbox"), ("Projects", "/projects"), ("Home", "/")):
            bar.get_by_role("link", name=re.compile(f"^{name}")).click()
            expect(page).to_have_url(f"{ORIGIN}{path}")
            expect(bar.get_by_role("link", name=re.compile(f"^{name}"))).to_have_attribute("aria-current", "page")
            expect(bar.locator('[aria-current="page"]')).to_have_count(1)
        # Projects lists every project; one tap opens its conversation, which has the whole screen.
        bar.get_by_role("link", name="Projects").click()
        expect(page.get_by_role("heading", level=1, name="Projects")).to_be_visible()
        page.get_by_role("link", name=re.compile("^Community garden sensors")).click()
        expect(page).to_have_url(re.compile(f"/projects/{self.project['id']}$"))
        expect(bar).to_have_count(0)
        menu = self.open_views(page)
        expect(menu.get_by_role("link", name="Conversation")).to_have_attribute("aria-current", "page")
        for name, path in (("Map", "/map"), ("Wiki", "/docs"), ("Agents", "/agents"), ("Tasks", "/tasks")):
            menu.get_by_role("link", name=re.compile(f"^{name}")).click()
            expect(page).to_have_url(re.compile(f"/projects/{self.project['id']}{path}"))
            expect(bar.get_by_role("link", name="Projects")).to_have_attribute("aria-current", "page")
            menu = self.open_views(page)
            expect(menu.get_by_role("link", name=re.compile(f"^{name}"))).to_have_attribute("aria-current", "page")
            expect(menu.locator('[aria-current="page"]')).to_have_count(1)
        shot(page, "266-menu-after-switching")

    def test_03_details_open_from_the_view_menu_and_nothing_stacks_under_the_header(self):
        page = self.page()
        page.goto(f"/projects/{self.project['id']}")
        header = page.locator("header")
        for name in ("Back", "Search"):
            button = header.get_by_role("button", name=name, exact=True)
            expect(button).to_be_visible()
            size = self.box(button)
            self.assertGreaterEqual(min(size["width"], size["height"]), 44, name)
        expect(page.locator(".state-row, .views")).to_have_count(0)
        self.open_views(page).get_by_role("button", name="Details, goal and people").click()
        sheet = page.get_by_role("dialog", name="Details")
        expect(sheet.get_by_text("Now in this project")).to_be_visible()
        expect(sheet.get_by_text("Order six capacitive probes")).to_be_visible()
        page.keyboard.press("Escape")
        # The other views start right under the header.
        self.open_views(page).get_by_role("link", name="Map").click()
        expect(page).to_have_url(re.compile("/map$"))
        expect(page.locator(".state-row")).to_have_count(0)

    def test_04_desktop_view_pill_covers_the_whole_tab_and_slides(self):
        page = self.page({"width": 1440, "height": 900}, touch=False)
        page.goto(f"/projects/{self.project['id']}/tasks")
        tabs = page.get_by_role("navigation", name="Project views")
        current = tabs.get_by_role("link", name=re.compile("^Tasks"))
        expect(current).to_have_attribute("aria-current", "page")
        # The views are a segmented control in the header's one row (F-026 §4, #340).
        expect(page.locator("header.top").get_by_role("navigation", name="Project views")).to_be_visible()
        indicator = page.locator(".top__views .ui-tabs__indicator")
        self.settle(page)
        width = current.evaluate("el => el.getBoundingClientRect().width")
        mark = indicator.evaluate("el => el.getBoundingClientRect().width")
        self.assertAlmostEqual(mark, width, delta=1.5, msg="the raised pill is as wide as the current tab")
        before = indicator.evaluate("el => el.getBoundingClientRect().left")
        tabs.get_by_role("link", name="Wiki").click()
        expect(tabs.get_by_role("link", name="Wiki")).to_have_attribute("aria-current", "page")
        self.settle(page)
        self.assertNotAlmostEqual(indicator.evaluate("el => el.getBoundingClientRect().left"), before, delta=2)
        # The sidebar's current project is a raised white pill (F-026 §4).
        row = page.locator(".side__project.is-open")
        # The accent tint is the row's own background, or the travelling highlight behind it (#155).
        tint = row.evaluate("""el => { const glide = el.closest('.side__list')?.querySelector('.side__glide');
          const own = getComputedStyle(el).backgroundColor;
          return own !== 'rgba(0, 0, 0, 0)' ? own : glide && getComputedStyle(glide).opacity === '1' ? getComputedStyle(glide).backgroundColor : own; }""")
        self.assertNotIn(tint, ("rgba(0, 0, 0, 0)", "transparent"), "the current project is tinted")
        lift = row.evaluate("""el => { const glide = el.closest('.side__list')?.querySelector('.side__glide');
          const own = getComputedStyle(el).boxShadow;
          return own !== 'none' ? own : glide && getComputedStyle(glide).opacity === '1' ? getComputedStyle(glide).boxShadow : own; }""")
        self.assertNotEqual(lift, "none", "the current project is raised")
        expect(page.get_by_role("navigation", name="Main places")).to_have_count(0)
        shot(page, "266-desktop-tabs")

    # ------------------------------------------------------------------ PF-3

    def test_05_messenger_composer_grows_and_the_bar_steps_aside_while_typing(self):
        page = self.page()
        page.goto(f"/projects/{self.project['id']}")
        box = page.locator(".project-convo__composer .composer__box")
        expect(box).to_be_visible()
        self.assertLessEqual(self.box(box)["height"], 100, "a compact composer card")
        attach = box.get_by_role("button", name="Attach files", exact=True)
        expect(attach).to_be_visible()
        self.assertGreaterEqual(self.box(attach)["width"], 44)
        field = page.get_by_label("Write a message", exact=True)
        self.assertEqual(field.evaluate("el => getComputedStyle(el).fontSize"), "16px", "no iOS zoom on focus")
        self.assertGreaterEqual(self.box(field)["height"], 44, "a 44px field")
        # A tap on the card's empty space focuses the field.
        page.locator(".phead__sub").click()
        card = self.box(box)
        page.mouse.click(card["x"] + card["width"] - 6, card["y"] + 4)
        expect(field).to_be_focused()
        # The field grows with the text: a three-line draft shows all three lines.
        field.fill("Moisture first\nFrost warnings in spring\nThen the volunteer guide")
        self.assertTrue(field.evaluate("el => el.scrollHeight <= el.clientHeight + 1"), "all three lines show")
        shot(page, "266-composer-phone")

        # The places bar steps aside while a text field has focus, and comes back after.
        page.goto("/map")  # the Sketchbook holds the private note (#342)
        bar = page.get_by_role("navigation", name="Main places")
        note = page.get_by_label("Private note", exact=True)
        expect(bar).to_be_visible()
        note.focus()
        expect(bar).to_be_hidden()
        note.fill("Ask about the hedge")
        page.locator("header h1").click()
        expect(bar).to_be_visible()
        expect(note).to_have_value("Ask about the hedge")

    # ------------------------------------------------------------------ PF-4

    def swipe(self, page, start, end, steps=8, pause=16):
        cdp = page.context.new_cdp_session(page)
        cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": start[0], "y": start[1]}]})
        for step in range(1, steps + 1):
            x = start[0] + (end[0] - start[0]) * step / steps
            y = start[1] + (end[1] - start[1]) * step / steps
            cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x, "y": y}]})
            page.wait_for_timeout(pause)
        cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})

    def test_06_the_menu_and_the_sheet_follow_a_finger(self):
        page = self.page()
        page.goto(f"/projects/{self.project['id']}")
        # The phone has no navigation drawer any more: places are the capsule and the title.
        expect(page.get_by_role("button", name="Open navigation")).to_have_count(0)
        self.open_views(page).get_by_role("button", name="Details, goal and people").click()
        sheet = page.get_by_role("dialog", name="Details")
        expect(sheet).to_be_visible()
        self.settle(page)
        self.swipe(page, (187, 28), (187, 420))
        expect(page.get_by_role("dialog", name="Details")).to_have_count(0)

    def test_07_reduced_motion_changes_state_without_animating(self):
        page = self.page(reduced=True)
        page.goto(f"/projects/{self.project['id']}")
        self.assertIn(page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--dur-4').trim()"), ("0ms", "0s"))
        self.open_views(page).get_by_role("link", name="Map").click()
        expect(page).to_have_url(re.compile("/map$"))
        page.get_by_role("button", name="Create", exact=True).click()
        expect(page.get_by_role("dialog", name="Create")).to_be_visible()
        self.assertEqual(page.evaluate("document.getAnimations().filter((a) => a.playState === 'running').length"), 0)

    # ------------------------------------------------------------------ PF-5

    def test_08_settings_is_one_place_reached_in_two_taps_on_a_phone(self):
        page = self.page()
        page.goto("/")
        page.get_by_role("link", name="Settings and account").click()
        expect(page).to_have_url(f"{ORIGIN}/settings")
        expect(page.get_by_role("heading", level=1, name="Settings")).to_be_visible()
        # Settings (#350): Appearance, This phone, Agents and AI, then the other sections as rows.
        self.assertEqual(page.locator(".sset-in > h2.sset-sec").all_inner_texts(), ["Appearance", "This phone", "Agents and AI", "More"])
        expect(page.get_by_role("radiogroup", name="Theme")).to_be_visible()
        page.get_by_role("radio", name="Dark").click()
        self.assertEqual(page.evaluate("document.documentElement.dataset.theme"), "dark")
        page.get_by_role("radio", name="System").click()
        for title, url, heading in (("Notifications", "/settings/notifications", "Settings"),
                                    ("Your assistant", "/settings/assistant", "Your assistant"),
                                    ("Background suggestions", "/settings/background-compute", "Background suggestions"),
                                    ("Account", "/settings/account", "Settings")):
            page.get_by_role("link", name=re.compile(f"^{title}")).click()
            expect(page).to_have_url(f"{ORIGIN}{url}")
            expect(page.get_by_role("heading", level=1, name=heading)).to_be_visible()
            back = page.locator("header").get_by_role("button", name="Back", exact=True)
            self.assertGreaterEqual(min(self.box(back)["width"], self.box(back)["height"]), 44)
            back.click()
            expect(page).to_have_url(f"{ORIGIN}/settings")
        page.get_by_role("link", name=re.compile("^Local co-work on this computer")).click()
        expect(page).to_have_url(f"{ORIGIN}/connect-agent")
        page.get_by_role("link", name="Settings").click()
        expect(page).to_have_url(f"{ORIGIN}/settings")
        self.assertEqual(page.evaluate("document.documentElement.scrollWidth"), SE["width"])
        shot(page, "266-settings-phone")

    def test_09_desktop_account_menu_leads_to_all_settings(self):
        page = self.page({"width": 1440, "height": 900}, touch=False)
        page.goto("/")
        page.get_by_role("button", name=re.compile("account and sign out")).click()
        menu = page.get_by_role("dialog", name="Account")
        expect(menu.get_by_role("radiogroup", name="Appearance")).to_be_visible()
        menu.get_by_role("link", name="All settings").click()
        expect(page).to_have_url(f"{ORIGIN}/settings")
        expect(page.get_by_role("heading", level=1, name="Settings")).to_be_visible()
        shot(page, "266-settings-desktop")

    # ------------------------------------------------------------------ PF-6

    def test_10_phone_tasks_toolbar_is_one_row_and_search_opens_to_the_full_row(self):
        page = self.page()
        page.goto(f"/projects/{self.project['id']}/tasks")
        toolbar = page.locator(".tb-bar")
        expect(toolbar).to_be_visible()
        self.assertLessEqual(self.box(toolbar)["height"], 60, "one row of tools")
        first = page.locator(".tb-card:visible").first
        expect(first).to_be_visible()
        self.assertLessEqual(self.box(first)["y"], 320, "the first card starts within 320px")
        page.locator(".tb-ov", has_text="In progress").click()
        search = page.get_by_label("Search tasks")
        # Every tool names itself; Search is a target as wide as its tile.
        for tool in ("Search",):
            expect(toolbar.get_by_text(tool, exact=True)).to_be_visible()
        tile = self.box(page.locator(".tb-search"))
        self.assertGreaterEqual(min(tile["width"], tile["height"]), 44)
        page.mouse.click(tile["x"] + tile["width"] - 4, tile["y"] + tile["height"] - 4)
        expect(search).to_be_focused()
        self.settle(page)
        self.assertGreater(self.box(page.locator(".tb-search"))["width"], 250, "search takes the row while in use")
        search.fill("probes")
        expect(page.locator(".tb-card:visible")).to_have_count(1)
        page.locator(".phead__sub").click()
        expect(search).to_have_value("probes")
        # A filter in use keeps the field open and marked beside the tools, which come back.
        self.assertGreater(self.box(page.locator(".tb-search"))["width"], 80, "a filter in use stays visible")
        expect(page.locator(".tb-search.has-query")).to_have_count(1)
        expect(page.locator(".tb-add:visible")).to_have_count(0)
        shot(page, "266-tasks-search-phone")

    # ------------------------------------------------------------------ PF-3 and PF-7: keyboard and type size

    def test_11_a_simulated_keyboard_keeps_the_field_and_send_in_view(self):
        page = self.page()
        page.goto(f"/projects/{self.project['id']}")
        field = page.get_by_label("Write a message", exact=True)
        field.click()
        field.fill("Can someone check the hedge reading tonight?")
        # The on-screen keyboard takes about 45% of the height (#268): the viewport shrinks while focused.
        page.set_viewport_size({"width": SE["width"], "height": 367})
        page.wait_for_timeout(250)
        send = page.locator(".project-convo__composer").get_by_role("button", name=re.compile("^Send"))
        for name, locator in (("field", field), ("Send", send)):
            expect(locator).to_be_visible()
            item = self.box(locator)
            self.assertGreaterEqual(item["y"], 0, f"{name} is below the top")
            self.assertLessEqual(item["y"] + item["height"], 367 + 1, f"{name} stays above the keyboard")
        expect(field).to_be_focused()
        expect(field).to_have_value("Can someone check the hedge reading tonight?")
        self.assertEqual(page.evaluate("document.documentElement.scrollWidth"), SE["width"])
        shot(page, "266-keyboard-phone")
        page.set_viewport_size(SE)
        expect(field).to_have_value("Can someone check the hedge reading tonight?")

    def test_12_every_editable_control_is_16px_on_a_touch_screen(self):
        # Text entry only: iOS zooms on focusing a text field below 16px, not on a checkbox or file picker.
        page = self.page()
        check = """() => [...document.querySelectorAll('input:not([type=checkbox], [type=radio], [type=range], [type=color], [type=file], [type=hidden], [type=button], [type=submit]), textarea, select, [contenteditable="true"]')]
          .filter((el) => el.getClientRects().length)
          .map((el) => [el.getAttribute('aria-label') || el.name || el.tagName, parseFloat(getComputedStyle(el).fontSize)])
          .filter(([, size]) => size < 16)"""
        for path in ("/", f"/projects/{self.project['id']}", f"/projects/{self.project['id']}/tasks",
                     f"/projects/{self.project['id']}/agents", "/settings/notifications", "/dm/new"):
            with self.subTest(path=path):
                page.goto(path)
                page.wait_for_load_state("networkidle")
                self.assertEqual(page.evaluate(check), [], "fields below 16px make iOS zoom on focus")


if __name__ == "__main__":
    unittest.main()
