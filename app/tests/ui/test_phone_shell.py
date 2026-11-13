"""Phone-first shell, current place and motion (#266, docs/design/phone-first.md PF-1 to PF-7), as the final
phone shell draws it (#341: the capsule, the views as underline tabs under the title, no chips; test_phone_final covers its criteria).

Actual authenticated browser and API data in Chromium or WebKit (FLUX_UI_BROWSER, default chromium;
#20 MOB-7 needs both engines). Viewports and touch are emulated, which #266 item 10 accepts as phone
evidence. Drag gestures use CDP touch events, which only Chromium exposes, so test_06 is skipped on
WebKit and reported as unverified there rather than passed.
"""
from __future__ import annotations

import json
import re
import unittest
import uuid

from playwright.sync_api import expect, sync_playwright

from test_app_shell import ORIGIN, UPSTREAM, shot as save_shot, start_forwarder
from test_settings import UI_BROWSER

VIEWS = ("Conversation", "Tasks", "Map", "Wiki")
PLACES = ("Home", "Spaces", "Inbox")
SE = {"width": 375, "height": 667}
CDP_ONLY = "CDP touch gestures exist only in Chromium; the WebKit drawer/sheet drag is unverified"


def shot(page, name):
    # Screenshots from the other engine get their own name, so neither run overwrites the other.
    save_shot(page, name if UI_BROWSER == "chromium" else f"{name}-{UI_BROWSER}")


class PhoneShellJourney(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
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
        # Layout and motion checks do not use the service worker. Blocking it keeps a worker left by an
        # earlier context from showing the update prompt over the header in later ones (seen in WebKit).
        context = self.browser.new_context(base_url=ORIGIN, viewport=viewport, storage_state=self.state,
            color_scheme="dark" if dark else "light", is_mobile=phone and touch, has_touch=phone and touch,
            reduced_motion="reduce" if reduced else "no-preference", service_workers="block")
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

    def views(self, page):
        """The space's views: the underline tabs every width has (#873, #1239), in a row of their own under the title on a phone."""
        views = page.get_by_role("navigation", name="Space views")
        expect(views).to_be_visible()
        return views

    def open_details(self, page):
        """Space details open from one place: the header's More (#873)."""
        page.locator("header").get_by_role("button", name="More", exact=True).click()
        page.get_by_role("menuitem", name="Space details").click()

    def test_01_main_places_sit_in_a_floating_capsule_and_views_are_in_a_row_under_the_title(self):
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

                # Inside a space there is no capsule (#507 AC-2): Search is the first row of More (#1239), and the four views are the
                # underline tabs under the title, in the order Conversation, Tasks, Map, Wiki (#873).
                page.goto(f"/projects/{self.project['id']}/tasks")
                expect(page.get_by_role("navigation", name="Main places")).to_have_count(0)
                expect(page.locator("header").get_by_role("button", name="Search", exact=True)).to_have_count(0)
                expect(page.locator("header").get_by_role("button", name="More", exact=True)).to_have_count(1)
                views = self.views(page)
                self.assertEqual([text.strip() for text in views.get_by_role("tab").all_inner_texts()], ["Conversation", "Tasks", "Map", "Wiki"])
                current = views.locator('[aria-current="page"]')
                expect(current).to_have_count(1)
                expect(current).to_contain_text("Tasks")
                for name in VIEWS:
                    row = views.get_by_role("tab", name=re.compile(f"^{name}"))
                    self.assertGreaterEqual(self.box(row)["height"], 44, f"44px target: {name}")
                header = self.box(page.locator("header"))
                # 8 px, the title row (a name of two lines at 320 px makes it 65 px), 12 px and the views' 44 px row.
                self.assertLessEqual(header["y"] + header["height"], 133, "the title row and the views row")
                expect(page.locator(".state-row")).to_have_count(0)
                self.assertEqual(page.evaluate("document.documentElement.scrollWidth"), width, "no sideways scroll")
                shot(page, f"266-tasks-phone-{width}")

    def test_02_places_and_views_move_the_current_mark(self):
        page = self.page()
        page.goto("/")
        bar = page.get_by_role("navigation", name="Main places")
        for name, path in (("Inbox", "/inbox"), ("Spaces", "/projects"), ("Home", "/")):
            bar.get_by_role("link", name=re.compile(f"^{name}")).click()
            expect(page).to_have_url(f"{ORIGIN}{path}")
            expect(bar.get_by_role("link", name=re.compile(f"^{name}"))).to_have_attribute("aria-current", "page")
            expect(bar.locator('[aria-current="page"]')).to_have_count(1)
        # Projects lists every project; one tap opens its conversation, which has the whole screen.
        bar.get_by_role("link", name="Spaces").click()
        expect(page.get_by_role("heading", level=1, name="Spaces")).to_be_visible()
        page.get_by_role("link", name=re.compile("^Community garden sensors")).click()
        expect(page).to_have_url(re.compile(f"/projects/{self.project['id']}$"))
        expect(bar).to_have_count(0)
        # Every space has all four views from the start: walk them through the tabs.
        views = self.views(page)
        expect(views.get_by_role("tab", name="Conversation")).to_have_attribute("aria-current", "page")
        for name, path in (("Tasks", "/tasks"), ("Map", "/map"), ("Wiki", "/docs"), ("Conversation", "")):
            views.get_by_role("tab", name=re.compile(f"^{name}")).click()
            expect(page).to_have_url(re.compile(rf"/projects/{self.project['id']}{path}(\?.*)?$"))
            expect(bar).to_have_count(0)
            expect(views.get_by_role("tab", name=re.compile(f"^{name}"))).to_have_attribute("aria-current", "page")
            expect(views.locator('[aria-current="page"]')).to_have_count(1)
        shot(page, "266-views-after-switching")

    def test_03_details_open_from_more_and_nothing_stacks_under_the_header(self):
        page = self.page()
        page.goto(f"/projects/{self.project['id']}")
        header = page.locator("header")
        for name in ("Back", "More"):
            button = header.get_by_role("button", name=name, exact=True)
            expect(button).to_be_visible()
            size = self.box(button)
            self.assertGreaterEqual(min(size["width"], size["height"]), 44, name)
        expect(page.locator(".state-row, .views")).to_have_count(0)
        self.open_details(page)
        sheet = page.get_by_role("dialog", name="Details")
        expect(sheet.get_by_role("region", name="Now", exact=True)).to_have_count(0)
        expect(sheet.locator(".ov-head").get_by_role("heading", level=3)).to_be_visible()
        # The panel does not repeat the views: no Map, Wiki or Tasks rows (#873).
        expect(sheet.get_by_role("region", name="In this space")).to_have_count(0)
        page.keyboard.press("Escape")
        # The other views start right under the header.
        self.views(page).get_by_role("tab", name="Map").click()
        expect(page).to_have_url(re.compile("/map$"))
        expect(page.locator(".state-row")).to_have_count(0)

    def test_04_desktop_view_underline_is_as_wide_as_the_word_and_slides(self):
        page = self.page({"width": 1440, "height": 900}, touch=False)
        page.goto(f"/projects/{self.project['id']}/tasks")
        tabs = page.get_by_role("navigation", name="Space views")
        current = tabs.get_by_role("tab", name=re.compile("^Tasks"))
        expect(current).to_have_attribute("aria-current", "page")
        # The views are underline tabs in the header's one row (F-026 §4, #1239): as tall as the row, so the underline sits on its hairline.
        expect(page.locator("header.top").get_by_role("navigation", name="Space views")).to_be_visible()
        indicator = page.locator(".top__views .ui-tabs__indicator")
        self.settle(page)
        word = current.locator(".ui-tabs__label").evaluate("el => el.getBoundingClientRect().width")
        mark = indicator.evaluate("el => el.getBoundingClientRect().width")
        self.assertAlmostEqual(mark, word, delta=1.5, msg="the underline is as wide as the current word")
        self.assertAlmostEqual(indicator.evaluate("el => el.getBoundingClientRect().height"), 2, delta=0.1)
        self.assertAlmostEqual(indicator.evaluate("el => el.getBoundingClientRect().bottom"), page.locator("header.top").evaluate("el => el.getBoundingClientRect().bottom"), delta=1,
                               msg="the underline sits on the header's hairline")
        before = indicator.evaluate("el => el.getBoundingClientRect().left")
        tabs.get_by_role("tab", name="Wiki").click()
        expect(tabs.get_by_role("tab", name="Wiki")).to_have_attribute("aria-current", "page")
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
        card = self.box(box)
        page.mouse.click(card["x"] + card["width"] / 2, card["y"] + 2)
        expect(field).to_be_focused()
        # The field grows with the text: a three-line draft shows all three lines.
        field.fill("Moisture first\nFrost warnings in spring\nThen the volunteer guide")
        self.assertTrue(field.evaluate("el => el.scrollHeight <= el.clientHeight + 1"), "all three lines show")
        shot(page, "266-composer-phone")

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

    @unittest.skipIf(UI_BROWSER != "chromium", CDP_ONLY)
    def test_06_the_sheet_follows_a_finger(self):
        page = self.page()
        page.goto(f"/projects/{self.project['id']}")
        # The phone has no navigation drawer any more: places are the capsule and the views.
        expect(page.get_by_role("button", name="Open navigation")).to_have_count(0)
        self.open_details(page)
        sheet = page.get_by_role("dialog", name="Details")
        expect(sheet).to_be_visible()
        self.settle(page)
        self.swipe(page, (187, 28), (187, 420))
        expect(page.get_by_role("dialog", name="Details")).to_have_count(0)

    def test_07_reduced_motion_changes_state_without_animating(self):
        page = self.page(reduced=True)
        page.goto(f"/projects/{self.project['id']}")
        self.assertIn(page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--dur-in').trim()"), ("0ms", "0s"))
        self.views(page).get_by_role("tab", name="Map").click()
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
        # Spokój E04p: the account, then Appearance, Notifications and AI as rows; Keyboard shortcuts only with a keyboard.
        expect(page.locator('a[href="/settings/account"]')).to_have_count(1)
        self.assertEqual([text.split("\n")[0] for text in page.locator("ul.sset-card a.sset-row").all_inner_texts()],
                         ["Appearance", "Notifications", "AI", "Company"])
        page.get_by_role("link", name=re.compile("^Appearance")).click()
        expect(page).to_have_url(f"{ORIGIN}/settings/appearance")
        expect(page.get_by_role("radiogroup", name="Theme")).to_be_visible()
        page.get_by_role("radio", name="Dark").click()
        self.assertEqual(page.evaluate("document.documentElement.dataset.theme"), "dark")
        page.get_by_role("radio", name="System").click()
        page.locator("header").get_by_role("button", name="Back", exact=True).click()
        expect(page).to_have_url(f"{ORIGIN}/settings")
        for title, url, heading in (("Notifications", "/settings/notifications", "Settings"),
                                    ("AI", "/settings/agents", "Settings"),
                                    ("Account", "/settings/account", "Settings")):
            page.locator(f'a[href="{url}"]').click()
            expect(page).to_have_url(f"{ORIGIN}{url}")
            expect(page.get_by_role("heading", level=1, name=heading)).to_be_visible()
            back = page.locator("header").get_by_role("button", name="Back", exact=True)
            self.assertGreaterEqual(min(self.box(back)["width"], self.box(back)["height"]), 44)
            back.click()
            expect(page).to_have_url(f"{ORIGIN}/settings")
        page.get_by_role("link", name=re.compile(r"^AI\b")).click()
        # #1363: the person's own Claude Code or Codex is the Connect AI window's fourth choice; it leads to its Settings page.
        page.get_by_role("button", name=re.compile("^Connect (AI|another)$")).click()
        window = page.get_by_role("dialog", name="Connect your AI")
        window.locator("[data-choice=local_client]").click()
        window.get_by_role("button", name="Continue").click()
        # #763 AG-2: Connect your agent is a Settings page, with the way back to Settings › AI first on the left.
        expect(page).to_have_url(f"{ORIGIN}/settings/agents/connect")
        page.locator("header").get_by_role("button", name="Back", exact=True).click()
        expect(page).to_have_url(f"{ORIGIN}/settings/agents")
        self.assertEqual(page.evaluate("document.documentElement.scrollWidth"), SE["width"])
        shot(page, "266-settings-phone")

    def test_09_desktop_account_menu_leads_to_settings(self):
        page = self.page({"width": 1440, "height": 900}, touch=False)
        page.goto("/")
        page.get_by_role("button", name=re.compile("account and sign out")).click()
        menu = page.get_by_role("dialog", name="Account")
        # Short (C-34): the name, Settings and Sign out; the theme is in Settings.
        expect(menu.get_by_role("radiogroup")).to_have_count(0)
        expect(menu.get_by_role("button", name="Sign out")).to_be_visible()
        menu.get_by_role("link", name="Settings", exact=True).click()
        expect(page).to_have_url(f"{ORIGIN}/settings")
        expect(page.get_by_role("heading", level=1, name="Settings")).to_be_visible()
        shot(page, "266-settings-desktop")

    # ------------------------------------------------------------------ PF-6

    def test_10_phone_tasks_has_the_views_and_one_control_row(self):
        # F-026 S-P-Tasks (#346, #868): the views are the row under the title, then one control row (Board | List, Mine, search).
        page = self.page()
        page.goto(f"/projects/{self.project['id']}/tasks")
        expect(page.get_by_role("navigation", name="Space views")).to_be_visible()
        shape = page.get_by_role("radiogroup", name="Show tasks as")
        mine = page.get_by_role("main").get_by_role("button", name="Mine", exact=True)
        expect(shape).to_be_visible()
        expect(mine).to_be_visible()
        self.assertGreaterEqual(self.box(mine)["height"], 34)
        first = page.get_by_role("region", name="To do").get_by_role("heading", level=3).first
        expect(first).to_be_visible()
        self.assertLessEqual(self.box(first)["y"], 360, "the first task starts within 360px: the header, the views and the control row")
        self.assertLessEqual(page.locator("body").evaluate("el => el.scrollWidth"), SE["width"])
        shot(page, "346-tasks-phone")

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
                     "/settings/notifications", "/dm/new"):
            with self.subTest(path=path):
                page.goto(path)
                page.wait_for_load_state("networkidle")
                self.assertEqual(page.evaluate(check), [], "fields below 16px make iOS zoom on focus")


    def test_13_projects_list_rows_audience_and_search_are_full_touch_targets(self):
        # #438: #370 dropped the list rules the Projects list used, leaving a bulleted, underlined 19 px link.
        page = self.page({"width": 390, "height": 844})
        page.goto("/projects")
        row = page.get_by_role("list", name="Spaces").get_by_role("link", name="Community garden sensors")
        expect(row).to_be_visible()
        look = row.evaluate("""(el) => ({ height: el.getBoundingClientRect().height,
          underline: getComputedStyle(el).textDecorationLine, bullet: getComputedStyle(el.closest('ul')).listStyleType })""")
        self.assertGreaterEqual(look["height"], 44, "a project row is a full touch target")
        self.assertEqual(look["underline"], "none")
        self.assertEqual(look["bullet"], "none")
        # The search field is 44 px tall on touch (the phone's one search, #870).
        page.goto("/")
        page.get_by_role("button", name="Search", exact=True).click()
        field = page.get_by_role("combobox", name="Search", exact=True)
        expect(field).to_be_visible()
        self.assertGreaterEqual(self.box(field)["height"], 44)

    # #438 / #478 asked that the project header's small targets have whole 44 px hit squares that do not
    # reach into each other. The final phone header (#341) moved the audience line into Details; since #1239 its
    # targets are the plain Back and More (Search and Call are rows of More; Join shows only while a call is live).
    def header_targets(self, page):
        page.goto(f"/projects/{self.project['id']}")
        header = page.locator("header.phead")
        targets = {"Back": header.get_by_role("button", name="Back", exact=True),
                   "More": header.get_by_role("button", name="More", exact=True)}
        for target in targets.values():
            expect(target).to_be_visible()
        self.settle(page)
        return targets

    def test_14_the_phone_header_targets_are_44_px(self):
        for width in (320, 390, 640):
            with self.subTest(width=width):
                page = self.page({"width": width, "height": 844})
                for name, target in self.header_targets(page).items():
                    box = self.box(target)
                    self.assertGreaterEqual(round(box["height"], 2), 44, f"{name} is at least 44 px tall")
                    self.assertGreaterEqual(round(box["width"], 2), 44, f"{name} is at least 44 px wide")
                expect(page.locator("header .top__audience")).to_have_count(0)

    def test_15_every_pixel_across_a_header_target_belongs_to_it(self):
        # Whole-pixel points: Chromium rounds a half-pixel point up, onto the next pixel.
        selectors = {"Back": "button.phead__back", "More": "button[aria-label='More']"}
        for width in (320, 390, 640):
            with self.subTest(width=width):
                page = self.page({"width": width, "height": 844})
                for name, target in self.header_targets(page).items():
                    box = self.box(target)
                    elsewhere = page.evaluate("""([left, width, y, selector]) => {
                      const out = [];
                      for (let step = 1; step < width - 1; step += 1) {
                        const el = document.elementFromPoint(Math.round(left + step), Math.round(y));
                        if (!(el && el.closest(selector))) out.push([step, el ? el.tagName + '.' + el.className : null]);
                      }
                      return out;
                    }""", [box["x"], box["width"], box["y"] + box["height"] / 2, selectors[name]])
                    self.assertEqual(elsewhere, [], f"every pixel across {name}'s middle row belongs to it at {width} px")

    def test_16_the_title_is_plain_text_and_the_views_are_the_only_switch(self):
        page = self.page({"width": 390, "height": 844})
        self.header_targets(page)
        expect(page.get_by_role("heading", level=1).get_by_role("button")).to_have_count(0)
        self.assertEqual(self.views(page).get_by_role("tab").count(), 4)

if __name__ == "__main__":
    unittest.main()
