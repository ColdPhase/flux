"""v0.2.1 final personas round (P2 #7, #8, #10 and their P3s): menus fit at 200 % text, a decision is a decision in Search, one word for
an empty owner, one name for My tasks, a task's card keeps its title, and no made-up values (a date placeholder, a decision's "Version 2")."""
from __future__ import annotations

import re
import unittest
import uuid

from playwright.sync_api import Page, expect, sync_playwright
from create_window import dialog as create_dialog, open_from_tasks
from test_app_shell import ORIGIN, UI_BROWSER, UPSTREAM, shot, start_forwarder
from test_work_pagination import api

# Every finite animation (a menu arriving) has finished; endless indicators are ignored.
SETTLED = "() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().endTime === Infinity)"
LONG = "Be at the back door at 7:30 on Tuesday for the flour delivery"
DECISION = "Shop opens at 6:30 from December"

# Whether the element at the centre of `el` is `el` or inside it: a row cut by the panel, or under its composer, is not.
ON_TOP = """el => { const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const hit = document.elementFromPoint(x, y); return { top: r.top, bottom: r.bottom, inside: y >= 0 && y <= innerHeight && x >= 0 && x <= innerWidth,
  onTop: !!hit && (hit === el || el.contains(hit)) }; }"""


class PersonasTasksSearch(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        assert cls.browser.browser_type.name == UI_BROWSER
        print(f"ACTUAL_UI_ENGINE={cls.browser.browser_type.name}", flush=True)
        expect.set_options(timeout=10000)
        cls.ctx = cls.browser.new_context(base_url=ORIGIN, service_workers="block")
        api(cls.ctx, "POST", "/api/auth/sign-up/email", {"name": "Marta Wiśniewska", "email": f"stefan-{uuid.uuid4()}@example.test", "password": "Bake the rye loaves first"})
        cls.user = api(cls.ctx, "GET", "/api/v1/me")["user"]["id"]
        workspace = api(cls.ctx, "POST", "/api/v1/workspaces", {"name": "Nowak Bakery"}, 201)["id"]
        cls.project = api(cls.ctx, "POST", f"/api/v1/workspaces/{workspace}/projects", {"name": "Bakery", "visibility": "restricted"}, 201)["id"]
        cls.root = f"/api/v1/projects/{cls.project}"
        cls.unowned = api(cls.ctx, "POST", cls.root + "/work", {"title": "Order Christmas boxes"}, 201)
        cls.long = api(cls.ctx, "POST", cls.root + "/work", {"title": LONG, "owner": {"kind": "human", "id": cls.user}}, 201)
        cls.decision = api(cls.ctx, "POST", cls.root + "/decisions", {"title": DECISION, "rationale": "The early shift asked for it"}, 201)
        cls.state = cls.ctx.storage_state()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def page(self, phone: bool = False, height: int = 900, zoom: bool = False) -> Page:
        # `zoom`: the persona's 200 % (Stefan): the browser zoomed to 200 % on a 1440 × 900 screen is a 720 × 450 window at twice the pixels.
        size = {"width": 390, "height": 844} if phone else {"width": 720, "height": 450} if zoom else {"width": 1440, "height": height}
        ctx = self.browser.new_context(base_url=ORIGIN, storage_state=self.state, viewport=size,
            device_scale_factor=2 if phone or zoom else 1, is_mobile=phone, has_touch=phone, locale="en-US", service_workers="block")
        self.addCleanup(ctx.close)
        page = ctx.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught browser errors"))
        return page

    @staticmethod
    def text_200(page: Page) -> None:
        page.evaluate("document.documentElement.style.fontSize = '200%'")
        page.evaluate("() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))")

    def open_task(self, page: Page, task: dict):
        page.goto(f"/projects/{self.project}/tasks?open=work:{task['id']}")
        panel = page.locator("#details")
        expect(panel.locator(".wd")).to_be_visible()
        expect(panel.locator("[data-detail-relations-phase]")).to_have_attribute("data-detail-relations-phase", "ready")
        return panel

    def assert_reachable(self, items, label: str, scroll: bool = True) -> None:
        # `scroll`: the menu may scroll itself to a row; without it, every row must be on screen as the menu opens (a script can scroll the
        # panel under a menu that a person cannot).
        for index in range(items.count()):
            item = items.nth(index)
            if scroll:
                item.scroll_into_view_if_needed()
            where = item.evaluate(ON_TOP)
            self.assertTrue(where["inside"] and where["onTop"], f"{label}: {item.inner_text()!r} can be seen and clicked: {where}")

    # ------------------------------------------------------------------ P2 #7: the Status menu at 200 % text

    def test_01_the_status_menu_fits_at_200_percent_zoom_and_done_can_be_chosen(self) -> None:
        task = api(self.ctx, "POST", self.root + "/work", {"title": "Bake the rye for Saturday"}, 201)
        page = self.page(zoom=True)
        panel = self.open_task(page, task)
        panel.get_by_role("button", name="Status", exact=True).click()
        menu = page.get_by_role("menu", name="Status")
        expect(menu).to_be_visible()
        items = menu.get_by_role("menuitemradio")
        expect(items).to_have_count(4)
        page.wait_for_function(SETTLED)
        box = menu.bounding_box()
        self.assertLessEqual(box["y"] + box["height"], 450 + 0.5, f"the menu stays inside the window: {box}")
        self.assert_reachable(items, "Status at 200 % zoom", scroll=False)
        shot(page, f"personas-status-menu-200-{UI_BROWSER}")
        items.filter(has_text="Done").click()
        expect(menu).to_have_count(0)
        expect(panel.get_by_role("button", name="Status", exact=True)).to_contain_text("Done")
        self.assertEqual(api(self.ctx, "GET", f"/api/v1/work/{task['id']}")["status"], "done")

    def test_02_menus_fit_a_short_window_at_200_percent_text(self) -> None:
        # The Owner menu in the panel and the space's ⋯ at 200 % zoom with the text at 200 % too: under the control, over it, or scrolling,
        # never past the window's edge.
        page = self.page(zoom=True)
        panel = self.open_task(page, self.unowned)
        self.text_200(page)
        panel.get_by_role("button", name="Owner", exact=True).click()
        menu = page.get_by_role("menu", name="Owner")
        expect(menu).to_be_visible()
        page.wait_for_function(SETTLED)
        box = menu.bounding_box()
        self.assertGreaterEqual(box["y"], -0.5, box)
        self.assertLessEqual(box["y"] + box["height"], 450 + 0.5, f"the Owner menu stays inside the window: {box}")
        self.assert_reachable(menu.get_by_role("menuitemradio"), "Owner at 200 % zoom and text")
        page.keyboard.press("Escape")
        expect(menu).to_have_count(0)
        page.locator("header.top").get_by_role("button", name=re.compile("^More")).first.click()
        more = page.get_by_role("menu", name=re.compile("^More"))
        expect(more).to_be_visible()
        page.wait_for_function(SETTLED)
        box = more.bounding_box()
        self.assertLessEqual(box["y"] + box["height"], 450 + 0.5, f"the space's More stays inside the window: {box}")
        self.assert_reachable(more.locator("[role^=menuitem]:visible"), "More at 200 % zoom and text")

    def test_03_the_phone_status_sheet_reaches_every_state_at_200_percent_text(self) -> None:
        page = self.page(phone=True)
        panel = self.open_task(page, self.unowned)
        self.text_200(page)
        panel.get_by_role("button", name="Status", exact=True).tap()
        menu = page.get_by_role("menu", name="Status")
        expect(menu.get_by_role("menuitemradio")).to_have_count(4)
        page.wait_for_function(SETTLED)
        self.assert_reachable(menu.get_by_role("menuitemradio"), "phone Status at 200 %")
        page.keyboard.press("Escape")

    # ------------------------------------------------------------------ P2 #10: one word for an empty owner

    def test_04_an_empty_owner_is_no_owner_in_the_panel_its_menu_the_card_and_create(self) -> None:
        page = self.page()
        panel = self.open_task(page, self.unowned)
        owner = panel.get_by_role("button", name="Owner", exact=True)
        expect(owner).to_have_text("No owner")
        expect(panel).not_to_contain_text("Assign")
        expect(panel).not_to_contain_text("Nobody yet")
        owner.click()
        menu = page.get_by_role("menu", name="Owner")
        expect(menu.get_by_role("menuitemradio").first).to_have_text("No owner")
        page.keyboard.press("Escape")
        # The conversation's card says it too, where it says an owner's name.
        page.goto(f"/projects/{self.project}")
        card = page.locator(f'.convo-notice[data-work-id="{self.unowned["id"]}"] .convo-notice__task')
        expect(card.locator(".convo-notice__owner")).to_contain_text("No owner")
        # The board says it as before; Create's Owner says it, and its note says what happens.
        page.goto(f"/projects/{self.project}/tasks?view=board")
        expect(page.locator(f'.tb-card[data-card-id="{self.unowned["id"]}"]')).to_contain_text("No owner")
        open_from_tasks(page)
        window = create_dialog(page)
        expect(window).to_contain_text("No owner")
        expect(window).to_contain_text("It goes to Tasks and the conversation")
        expect(window).not_to_contain_text("one-line note")
        page.keyboard.press("Escape")

    def test_05_the_owner_face_keeps_its_initials_on_one_line(self) -> None:
        for text_200, zoom in ((False, False), (True, False), (False, True)):
            with self.subTest(text_200=text_200, zoom=zoom):
                page = self.page(zoom=zoom)
                panel = self.open_task(page, self.long)
                if text_200:
                    self.text_200(page)
                face = panel.get_by_role("button", name="Owner", exact=True).locator(".ui-avatar")
                expect(face).to_have_text("MW")
                lines = face.evaluate("el => { const range = document.createRange(); range.selectNodeContents(el.firstChild); return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size; }")
                self.assertEqual(lines, 1, "the initials are one line, never M / W")

    # ------------------------------------------------------------------ the task card at 200 % text

    def test_06_a_long_task_title_is_whole_on_its_card_at_200_percent_zoom(self) -> None:
        page = self.page(zoom=True)
        page.goto(f"/projects/{self.project}")
        card = page.locator(f'.convo-notice[data-work-id="{self.long["id"]}"] .convo-notice__task')
        expect(card).to_be_visible()
        card.scroll_into_view_if_needed()
        title = card.locator(".convo-notice__title")
        expect(title).to_have_text(LONG)
        geometry = title.evaluate("""el => ({ cut: el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1,
          clamp: getComputedStyle(el).webkitLineClamp, wrap: getComputedStyle(el).whiteSpace })""")
        self.assertFalse(geometry["cut"], f"the title is whole, wrapped on a computer: {geometry}")
        state = card.locator(".convo-notice__state")
        self.assertLessEqual(state.evaluate("el => el.scrollWidth - el.clientWidth"), 1, "the state word stays whole")
        shot(page, f"personas-task-card-200-{UI_BROWSER}")

    # ------------------------------------------------------------------ P2 #8: a decision in Search

    def test_07_search_lists_a_decision_as_a_decision_and_opens_it_as_one(self) -> None:
        page = self.page()
        page.goto(f"/projects/{self.project}/tasks")
        expect(page.get_by_role("button", name="Search", exact=True)).to_be_visible()
        page.keyboard.press("Control+k")
        dialog = page.get_by_role("dialog", name="Search", exact=True)
        expect(dialog).to_contain_text("Finds spaces, people, messages, tasks, decisions, Wiki pages, files and thoughts you can see.")
        dialog.get_by_role("combobox", name="Search", exact=True).fill("December")
        option = dialog.locator("[role=option].sr", has_text=DECISION)
        expect(option).to_be_visible()
        self.assertEqual(dialog.locator(".jump__sh").all_inner_texts(), ["Decisions"])
        option.click()
        expect(page).to_have_url(re.compile(rf"/projects/{self.project}(\?open=decision:{self.decision['id']})?$"))
        expect(page.get_by_role("navigation", name="Space views").get_by_role("tab", name="Conversation")).to_have_attribute("aria-current", "page")
        details = page.locator("#details")
        expect(details.get_by_role("heading", name=DECISION)).to_be_visible()
        # A decision nobody edited shows no row version ("Version 2" said nothing).
        expect(details).not_to_contain_text(re.compile(r"Version \d"))

    # ------------------------------------------------------------------ one name for My tasks

    def test_08_my_tasks_has_one_name_and_the_way_back_says_it(self) -> None:
        page = self.page()
        page.goto("/tasks")
        expect(page.locator("header.top")).to_contain_text("My tasks")
        expect(page.get_by_text("Your tasks")).to_have_count(0)
        expect(page.get_by_role("region", name="My tasks")).to_be_visible()
        page.get_by_role("link", name=re.compile(re.escape(LONG))).click()
        expect(page.locator("#details").get_by_role("heading", name=LONG)).to_be_visible()
        expect(page.get_by_role("button", name="Back to My tasks")).to_be_visible()
        expect(page.get_by_role("button", name="Back to Tasks")).to_have_count(0)


if __name__ == "__main__":
    unittest.main()
