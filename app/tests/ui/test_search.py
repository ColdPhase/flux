"""Browser tests for search (issue #114, AC-4 and AC-6).

Runs with the other tests/ui journeys through scripts/check_ui.sh against the running Compose
application. Ari owns a studio with a restricted project that Nia works in; Olek is a member who
is not in that project. Nia searches with Jump to… (Ctrl+K and the sidebar), opens a message, an
old material version and a rule, uses the search page with its filters and keyboard, and searches
on the phone. Olek never sees the restricted project, and recent searches go away on sign-out.
"""

from __future__ import annotations

import json
import math
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder
from touch_targets import has_minimum_touch_size

PASSWORD = "finding things calmly"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ari": {"name": "Ari Nowak", "email": f"ari.search+{STAMP}@example.test"},
    "nia": {"name": "Nia Berg", "email": f"nia.search+{STAMP}@example.test"},
    "olek": {"name": "Olek Marsh", "email": f"olek.search+{STAMP}@example.test"},
}


class SearchJourney(unittest.TestCase):
    """Tests run in name order and share three accounts and one studio."""

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

    def context(self, who: str | None, *, phone: bool = False, dark: bool = False) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "color_scheme": "dark" if dark else "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw"}
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

    def no_horizontal_scroll(self, page: Page) -> None:
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), page.evaluate("window.innerWidth"))

    def jump(self, page: Page, query: str):
        # The shortcut works once the app shell has loaded.
        expect(page.get_by_role("button", name="Search", exact=True)).to_be_visible()
        page.keyboard.press("Control+k")
        dialog = page.get_by_role("dialog", name="Jump to")
        expect(dialog).to_be_visible()
        field = dialog.get_by_role("combobox", name="Jump to")
        expect(field).to_be_focused()
        field.fill(query)
        return dialog, field

    # ---------------------------------------------------------------- a studio with things to find

    def test_01_a_studio_with_things_to_find(self) -> None:
        for key, person in PEOPLE.items():
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
        for key in ("nia", "olek"):
            self.api(ari, "POST", f"/api/v1/workspaces/{ws['id']}/members", {"email": PEOPLE[key]["email"], "role": "member"}, status=201)
        lamp = self.api(ari, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Gesture lamp", "visibility": "restricted"}, status=201)
        self.api(ari, "POST", f"/api/v1/projects/{lamp['id']}/grants", {"principal": {"kind": "human", "id": PEOPLE["nia"]["id"]}, "role": "contributor"}, status=201)
        notes = self.api(ari, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Studio notes", "visibility": "workspace"}, status=201)
        p = lamp["id"]
        nia = self.page("nia")
        thread = self.api(nia, "POST", f"/api/v1/projects/{p}/conversations", {"body": "Camera or sensor for the bedside lamp?", "clientMessageId": str(uuid.uuid4())}, status=201)
        for body in ["I ordered an infrared sensor, it should arrive on Wednesday.",
                     "The infrared sensor reacts at 5 lux in the hallway test.",
                     "Nia, can you check the sensor angle before Friday?"]:
            self.api(ari, "POST", f"/api/v1/conversations/{thread['id']}/messages", {"body": body, "clientMessageId": str(uuid.uuid4())}, status=201)
        material = self.api(ari, "POST", f"/api/v1/projects/{p}/materials", {"clientMutationId": str(uuid.uuid4()), "title": "Sensor comparison",
                                                                           "body": "The capacitive option drifts with humidity in the bedroom."}, status=201)
        self.api(ari, "PATCH", f"/api/v1/materials/{material['materialId']}", {"clientMutationId": str(uuid.uuid4()), "expectedVersion": 1,
                                                                              "body": "The infrared option wins on battery life and needs no calibration."}, status=200)
        self.api(nia, "POST", f"/api/v1/projects/{p}/work", {"title": "Mount the infrared sensor in the lamp base", "outcome": "A base that hides the sensor"}, status=201)
        rule = self.api(ari, "POST", f"/api/v1/projects/{p}/decisions", {"title": "Use the infrared sensor at night", "rationale": "It passed the hallway test at 5 lux."}, status=201)
        self.api(ari, "POST", f"/api/v1/decisions/{rule['id']}/accept", {}, status=200, headers={"if-match": '"1"'})
        self.api(nia, "POST", f"/api/v1/projects/{p}/results", {"title": "Infrared sensor passed the low-light test", "finding": "positive", "evidence": "20 gestures at 5 lux"}, status=201)
        sketch = self.api(nia, "POST", f"/api/v1/workspaces/{ws['id']}/sketches", {"title": "Sensing options", "scope": "project", "projectId": p}, status=201)
        thought = self.api(nia, "POST", f"/api/v1/sketches/{sketch['id']}/thoughts", {"text": "Sensor hidden behind the walnut veneer", "x": 0, "y": 0}, status=201)
        doc = self.api(ari, "POST", f"/api/v1/projects/{p}/docs", {"title": "Lamp wiring guide", "body": "Fit the brass collar before the sensor board.", "state": "published"}, status=201)
        self.api(nia, "POST", f"/api/v1/workspaces/{ws['id']}/drafts", {"title": "Sensor questions for Ari", "body": "Ask about the lens"}, status=201)
        dm = self.api(ari, "POST", f"/api/v1/workspaces/{ws['id']}/dms", {"participantIds": [PEOPLE["nia"]["id"]]}, status=201)
        self.api(ari, "POST", f"/api/v1/dms/{dm['id']}/messages", {"body": "Did the spare sensor arrive at your place?", "clientMessageId": str(uuid.uuid4())}, status=201)
        olek = self.page("olek")
        open_thread = self.api(olek, "POST", f"/api/v1/projects/{notes['id']}/conversations", {"body": "The workshop is on Thursday, bring a sensor kit.", "clientMessageId": str(uuid.uuid4())}, status=201)
        type(self).ids = {"workspace": ws["id"], "lamp": p, "thread": thread["id"], "material": material["materialId"], "rule": rule["id"],
                          "sketch": sketch["id"], "thought": thought["thought"]["id"], "dm": dm["id"], "open_thread": open_thread["id"], "doc": doc["id"]}

    # ---------------------------------------------------------------- Jump to…

    def test_02_ctrl_k_searches_as_you_type_and_opens_the_exact_message(self) -> None:
        page = self.page("nia")
        page.goto("/")
        expect(page.get_by_role("button", name="Search", exact=True)).to_be_visible()
        dialog, field = self.jump(page, "sensor")
        options = dialog.get_by_role("option")
        expect(options.first).to_be_visible()
        expect(dialog.get_by_role("listbox", name="Results")).to_contain_text("Sensor comparison")
        expect(dialog).to_contain_text("Material · version 2, current")
        expect(dialog).to_contain_text("# Gesture lamp")
        expect(dialog.locator(".sr__hit").first).to_be_visible()
        self.assertEqual(options.first.get_attribute("aria-selected"), "true")
        shot(page, "search-jump-desktop-1440")
        field.fill("sensor reacts")
        expect(options.first).to_contain_text("The infrared sensor reacts at 5 lux in the hallway test.")
        field.press("Enter")
        expect(dialog).to_be_hidden()
        expect(page).to_have_url(re.compile(rf"/projects/{self.ids['lamp']}/conversations/{self.ids['thread']}#message-"))
        expect(page.locator(".project-convo__message.is-arrived")).to_contain_text("hallway test")
        expect(page.locator(".project-convo__message.is-arrived")).to_be_focused()

    def test_03_arrow_keys_choose_and_old_versions_open_at_their_version(self) -> None:
        page = self.page("nia")
        page.goto("/")
        page.get_by_role("button", name="Search", exact=True).click()
        dialog = page.get_by_role("dialog", name="Jump to")
        field = dialog.get_by_role("combobox", name="Jump to")
        expect(field).to_be_focused()
        field.fill("humidity")
        option = dialog.get_by_role("option").first
        expect(option).to_contain_text("Material · version 1 of 2")
        field.press("Enter")
        expect(page).to_have_url(re.compile(rf"/materials/{self.ids['material']}/versions/1$"))
        # A rule opens in Details on its project.
        dialog, field = self.jump(page, "use the infrared")
        expect(dialog.get_by_role("option").first).to_contain_text("Decision · current rule")
        field.press("ArrowDown")
        field.press("ArrowUp")
        self.assertEqual(dialog.get_by_role("option").first.get_attribute("aria-selected"), "true")
        field.press("Enter")
        expect(page).to_have_url(re.compile(rf"/projects/{self.ids['lamp']}/tasks$"))
        expect(page.get_by_role("complementary", name="Details").or_(page.get_by_role("dialog", name="Details"))).to_contain_text("Use the infrared sensor at night")
        # A thought opens its sketch with the thought selected; Esc closes Jump to without moving.
        dialog, field = self.jump(page, "walnut")
        expect(dialog.get_by_role("option").first).to_contain_text("Thought in “Sensing options”")
        field.press("Enter")
        expect(page).to_have_url(re.compile(rf"/map/{self.ids['sketch']}#thought-{self.ids['thought']}$"))
        expect(page.locator(f'[data-id="{self.ids["thought"]}"][aria-pressed="true"]').first).to_be_visible()
        dialog, field = self.jump(page, "sensor")
        page.keyboard.press("Escape")
        expect(dialog).to_be_hidden()
        expect(page).to_have_url(re.compile(rf"/map/{self.ids['sketch']}"))

    def test_04_direct_messages_and_nothing_found(self) -> None:
        page = self.page("nia")
        page.goto("/")
        dialog, field = self.jump(page, "spare sensor")
        first = dialog.get_by_role("option").first
        expect(first).to_contain_text("Direct message")
        expect(first).to_contain_text("Ari Nowak")
        field.press("Enter")
        expect(page).to_have_url(re.compile(rf"/dm/{self.ids['dm']}#message-"))
        expect(page.locator(".dm-msg.is-arrived")).to_contain_text("spare sensor")
        dialog, field = self.jump(page, "brass collar")
        first = dialog.get_by_role("option").first
        expect(first).to_contain_text("Doc · published")
        field.press("Enter")
        expect(page).to_have_url(re.compile(rf"/projects/{self.ids['lamp']}/docs/{self.ids['doc']}(/versions/1)?$"))
        expect(page.get_by_role("heading", name="Lamp wiring guide").first).to_be_visible()
        dialog, field = self.jump(page, "zeppelin")
        expect(dialog).to_contain_text("Nothing you can open matches “zeppelin”.")
        shot(page, "search-jump-desktop-1440-empty")

    # ---------------------------------------------------------------- the search page

    def test_05_search_page_filters_counts_and_keyboard(self) -> None:
        page = self.page("nia")
        page.goto("/")
        dialog, field = self.jump(page, "sensor")
        see_all = dialog.get_by_role("option", name=re.compile("See all results"))
        expect(see_all).to_be_visible()
        see_all.click()
        expect(page).to_have_url(re.compile(r"/search\?q=sensor$"))
        expect(page.get_by_role("heading", level=1, name="Search")).to_be_visible()
        results = page.get_by_role("list", name="Results")
        expect(results.get_by_role("link").first).to_be_visible()
        chips = page.get_by_role("group", name="Kind of result")
        expect(chips.get_by_role("button", name=re.compile(r"^All"))).to_have_attribute("aria-pressed", "true")
        expect(chips.get_by_role("button", name=re.compile(r"^Messages"))).to_contain_text("6")
        expect(chips.get_by_role("button", name=re.compile(r"^Docs"))).to_contain_text("1")
        shot(page, "search-page-desktop-1440")
        tasks = chips.get_by_role("button", name=re.compile(r"^Tasks"))
        tasks.click()
        expect(tasks).to_have_attribute("aria-pressed", "true")
        expect(page).to_have_url(re.compile(r"type=work"))
        expect(results.get_by_role("link")).to_have_count(1)
        expect(results).to_contain_text("Mount the infrared sensor in the lamp base")
        tasks.click()
        expect(tasks).to_have_attribute("aria-pressed", "false")
        expect(page).not_to_have_url(re.compile(r"type=work"))
        page.get_by_role("combobox", name="Place").select_option(label="Only you")
        expect(results.get_by_role("link")).to_have_count(1)
        expect(results).to_contain_text("Sensor questions for Ari")
        expect(results).to_contain_text("Only you")
        # The announced status counts in the singular for one result (#217).
        expect(page.locator('p.ui-vh[role="status"]')).to_have_text("1 result")
        page.get_by_role("combobox", name="Place").select_option(label="All places")
        # ↓ from the field moves through the results; ↑ from the first returns to the field.
        search_box = page.get_by_role("searchbox", name="Search Flux")
        search_box.focus()
        page.keyboard.press("ArrowDown")
        expect(results.get_by_role("link").first).to_be_focused()
        page.keyboard.press("ArrowDown")
        expect(results.get_by_role("link").nth(1)).to_be_focused()
        page.keyboard.press("ArrowUp")
        page.keyboard.press("ArrowUp")
        expect(search_box).to_be_focused()
        search_box.fill("walnut veneer")
        expect(results.get_by_role("link")).to_have_count(1)
        expect(page).to_have_url(re.compile(r"q=walnut\+veneer|q=walnut%20veneer"))
        results.get_by_role("link").first.click()
        expect(page).to_have_url(re.compile(rf"/map/{self.ids['sketch']}#thought-"))

    def test_06_a_member_outside_the_project_never_sees_it(self) -> None:
        page = self.page("olek")
        page.goto("/search?q=sensor")
        results = page.get_by_role("list", name="Results")
        expect(results.get_by_role("link")).to_have_count(1)
        expect(results).to_contain_text("The workshop is on Thursday, bring a sensor kit.")
        chips = page.get_by_role("group", name="Kind of result")
        expect(chips.get_by_role("button")).to_have_count(2)  # All 1 · Messages 1
        content = page.content()
        for hidden in ["Gesture lamp", "infrared", "Sensor comparison", "spare sensor", "Sensor questions", self.ids["lamp"]]:
            self.assertNotIn(hidden, content)
        page.goto(f"/search?q=sensor&place=project:{self.ids['lamp']}")
        expect(page.get_by_role("heading", name="Nothing matches “sensor”")).to_be_visible()

    def test_07_recent_searches_are_per_account_and_cleared_on_sign_out(self) -> None:
        page = self.page("nia")
        page.goto("/")
        dialog, field = self.jump(page, "hallway")
        expect(dialog.get_by_role("option").first).to_be_visible()
        field.press("Enter")
        dialog, field = self.jump(page, "")
        recent = dialog.get_by_role("listbox", name="Recent searches")
        expect(recent).to_contain_text("hallway")
        page.keyboard.press("Escape")
        stored = page.evaluate("Object.keys(localStorage).filter((k) => k.startsWith('flux.search.recent.'))")
        self.assertEqual(stored, [f"flux.search.recent.{PEOPLE['nia']['id']}"])
        page.get_by_role("button", name=re.compile("Nia Berg")).click()
        page.get_by_role("dialog", name="Account").get_by_role("button", name="Sign out").click()
        expect(page).to_have_url(f"{ORIGIN}/sign-in")
        self.assertEqual(page.evaluate("Object.keys(localStorage).filter((k) => k.startsWith('flux.search.recent.'))"), [])
        # Signing in again (the stored session ended) starts with no recent searches.
        page.get_by_label("Email").fill(PEOPLE["nia"]["email"])
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Sign in").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        type(self).states["nia"] = page.context.storage_state()
        dialog, field = self.jump(page, "")
        expect(dialog.get_by_role("listbox", name="Recent searches")).to_have_count(0)
        expect(dialog).to_contain_text("Only what you can open is searched.")

    # ---------------------------------------------------------------- phone

    def test_07b_target_measurement_preserves_the_44px_boundary(self) -> None:
        for size in (44, 48, 43.99997):
            self.assertTrue(has_minimum_touch_size(size), str(size))
        for size in (43.5, 43.75, 43.99, 43.9989, 0, -1, float("nan"), float("inf")):
            self.assertFalse(has_minimum_touch_size(size), str(size))

    def test_08_phone_search_from_the_drawer_and_the_page(self) -> None:
        page = self.page("nia", phone=True)
        page.goto("/")
        page.get_by_role("button", name="Open navigation").click()
        page.get_by_role("dialog", name="Flux").get_by_role("button", name="Search", exact=True).click()
        dialog = page.get_by_role("dialog", name="Jump to")
        expect(dialog).to_be_visible()
        box = dialog.bounding_box()
        assert box is not None
        self.assertEqual(round(box["width"]), PHONE["width"], "a full-screen sheet on the phone")
        field = dialog.get_by_role("combobox", name="Jump to")
        field.fill("sensor")
        options = dialog.get_by_role("option")
        expect(options.first).to_be_visible()
        cancel = dialog.get_by_role("button", name="Cancel")
        # Read a settled sheet rather than accepting a genuinely undersized target by rounding.
        dialog.evaluate("el => Promise.all(el.getAnimations({subtree: true}).filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished))")
        cancel_box = cancel.bounding_box()
        assert cancel_box is not None
        minimum = cancel.evaluate("el => parseFloat(getComputedStyle(el).minHeight)")
        self.assertTrue(math.isfinite(minimum))
        self.assertGreaterEqual(minimum, 44)
        # Keep the newer main's stricter noise tolerance; never round a shorter target up.
        self.assertTrue(math.isfinite(cancel_box["height"]))
        self.assertGreaterEqual(cancel_box["height"], 44 - 0.0001)
        for index in range(min(options.count(), 5)):
            option_box = options.nth(index).bounding_box()
            assert option_box is not None
            self.assertGreaterEqual(option_box["height"], 44)
        shot(page, "search-jump-phone-390")
        options.filter(has_text="Mount the infrared sensor").first.click()
        expect(page).to_have_url(re.compile(rf"/projects/{self.ids['lamp']}/tasks$"))
        expect(page.get_by_role("dialog", name="Details")).to_contain_text("Mount the infrared sensor in the lamp base")
        page.goto("/search?q=sensor")
        results = page.get_by_role("list", name="Results")
        expect(results.get_by_role("link").first).to_be_visible()
        self.no_horizontal_scroll(page)
        for index in range(3):
            link_box = results.get_by_role("link").nth(index).bounding_box()
            assert link_box is not None
            self.assertGreaterEqual(link_box["height"], 44)
        shot(page, "search-page-phone-390")

    def test_09_dark_desktop_page(self) -> None:
        page = self.page("nia", dark=True)
        page.goto("/search?q=infrared")
        expect(page.get_by_role("list", name="Results").get_by_role("link").first).to_be_visible()
        shot(page, "search-page-desktop-1440-dark")


    def test_10_an_old_message_opens_exactly_even_outside_the_first_window(self) -> None:
        """More messages than one window (50) arrive after the target, in a DM and in a project."""
        ari = self.page("ari")
        dm, lamp = self.ids["dm"], self.ids["lamp"]
        self.api(ari, "POST", f"/api/v1/dms/{dm}/messages", {"body": "The oak veneer quote came back at 480 euros.", "clientMessageId": str(uuid.uuid4())}, status=201)
        thread = self.api(ari, "POST", f"/api/v1/projects/{lamp}/conversations", {"body": "Where should the dimmer knob go?", "clientMessageId": str(uuid.uuid4())}, status=201)
        self.api(ari, "POST", f"/api/v1/conversations/{thread['id']}/messages", {"body": "The brass knob sample weighs 42 grams.", "clientMessageId": str(uuid.uuid4())}, status=201)
        for index in range(130):
            self.api(ari, "POST", f"/api/v1/dms/{dm}/messages", {"body": f"Packing list item {index + 1}", "clientMessageId": str(uuid.uuid4())}, status=201)
            self.api(ari, "POST", f"/api/v1/conversations/{thread['id']}/messages", {"body": f"Assembly step {index + 1}", "clientMessageId": str(uuid.uuid4())}, status=201)
        page = self.page("nia")
        page.goto("/")
        for query, selector, url in (("oak veneer quote", ".dm-msg.is-arrived", rf"/dm/{dm}#message-"),
                                     ("brass knob sample", ".project-convo__message.is-arrived", rf"/projects/{lamp}/conversations/{thread['id']}#message-")):
            dialog, field = self.jump(page, query)
            expect(dialog.get_by_role("option").first).to_contain_text(query.split()[0])
            field.press("Enter")
            expect(page).to_have_url(re.compile(url))
            target = page.locator(selector)
            expect(target).to_contain_text("480 euros" if "oak" in query else "42 grams")
            expect(target).to_be_focused()
            expect(target).to_be_in_viewport()
            if "oak" in query:
                shot(page, "search-open-old-dm-message-desktop-1440")

    def test_11_task_number_leads_jump_to_even_on_a_busy_project(self) -> None:
        owner = self.page("ari")
        place = self.api(owner, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/projects",
                         {"name": "Hedge sensor calibration", "visibility": "restricted"}, status=201)
        titles = ["Phase 2 walnut probes", "Seal the barrel lid", "Order 2 spare probes"] + [
            f"Log the hedge reading {chr(97 + index)}" for index in range(23)]
        tasks = [self.api(owner, "POST", f"/api/v1/projects/{place['id']}/work",
                          {"title": title}, status=201) for title in titles]
        target = tasks[1]
        self.assertEqual(target["number"], 2)
        hidden = self.api(self.page("olek"), "GET", "/api/v1/search?q=%232", status=200)
        self.assertNotIn(f"work:{target['id']}", [item["id"] for item in hidden["items"]])

        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page("ari", phone=phone)
                page.goto(f"/projects/{place['id']}/tasks")
                expect(page.locator(".tb-card").first).to_be_visible()
                page.keyboard.press("Control+k")
                dialog = page.get_by_role("dialog", name="Jump to")
                field = dialog.get_by_role("combobox", name="Jump to")
                for query in ("#2", "2", " #2 "):
                    field.fill(query)
                    expect(dialog.get_by_role("option").first).to_contain_text(target["title"])
                field.press("Enter")
                details = page.locator("#details")
                expect(details.get_by_role("heading", name=target["title"], exact=True)).to_be_visible()
                expect(details.locator(".wd-eyebrow .ui-task-number")).to_have_text("#2")
                expect(details.locator(".wd-project-name")).to_have_text(place["name"])
                self.no_horizontal_scroll(page)
                shot(page, f"task-number-jump-{'phone-390' if phone else 'desktop-1440'}")

                details.get_by_role("button", name="Close details").click()
                page.keyboard.press("Control+k")
                dialog = page.get_by_role("dialog", name="Jump to")
                field = dialog.get_by_role("combobox", name="Jump to")
                field.fill("#12")
                expect(dialog.get_by_role("option").first).to_contain_text(tasks[11]["title"])
                shot(page, f"task-number-12-palette-{'phone-390' if phone else 'desktop-1440'}")
                page.keyboard.press("Escape")

                for number in (12, 26):
                    page.goto(f"/search?q=%23{number}&type=work&place=project:{place['id']}")
                    result = page.locator("a.sr").first
                    expect(result).to_contain_text(tasks[number - 1]["title"])
                    expect(result).to_contain_text(f"#{number}")
                    shot(page, f"task-number-{number}-search-{'phone-390' if phone else 'desktop-1440'}")
                    result.click()
                    details = page.locator("#details")
                    expect(details.get_by_role("heading", name=tasks[number - 1]["title"], exact=True)).to_be_visible()
                    expect(details.locator(".wd-eyebrow .ui-task-number")).to_have_text(f"#{number}")
                    expect(details.locator(".wd-project-name")).to_have_text(place["name"])
                    expect(details.locator("[data-detail-relations-phase]")).to_have_attribute("data-detail-relations-phase", "ready")
                    expect(details.get_by_role("navigation", name="Object relationship pages")).to_have_count(0)
                    expect(details.get_by_label("Status", exact=True)).to_have_value("open")
                    expect(details.get_by_label("Owner", exact=True)).to_have_value("")
                    for name in ("Status", "Owner"):
                        field_box = details.get_by_label(name, exact=True).bounding_box()
                        label_box = details.locator(".wd-controls > label", has_text=name).evaluate(
                            "node => { const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect().toJSON(); }")
                        self.assertGreaterEqual(field_box["x"] - label_box["x"] - label_box["width"], 11,
                                                f"{name} keeps a readable label/value gap at default text size")
                    self.no_horizontal_scroll(page)
                    shot(page, f"task-number-{number}-global-details-{'phone-390' if phone else 'desktop-1440'}")
                # The shared type tokens use rem. Enlarge actual text through the root size;
                # parseFloat(.75rem) followed by px would shrink it to 1.5px instead of 24px.
                page.evaluate("document.documentElement.style.fontSize = '200%'")
                number_label = details.locator(".wd-eyebrow .ui-task-number")
                expect(number_label).to_be_visible()
                expect(details.locator(".wd-project-name")).to_be_visible()
                self.assertGreaterEqual(number_label.evaluate("node => parseFloat(getComputedStyle(node).fontSize)"), 20)
                for name in ("Status", "Owner"):
                    field_box = details.get_by_label(name, exact=True).bounding_box()
                    label_box = details.locator(".wd-controls > label", has_text=name).evaluate(
                        "node => { const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect().toJSON(); }")
                    self.assertGreaterEqual(field_box["x"] - label_box["x"] - label_box["width"], 11,
                                            f"{name} keeps a readable label/value gap with 200% text")
                expect(details.get_by_role("navigation", name="Object relationship pages")).to_have_count(0)
                self.no_horizontal_scroll(page)
                shot(page, f"task-number-26-text-200-{'phone-390' if phone else 'desktop-1440'}")


if __name__ == "__main__":
    unittest.main()
