"""Browser tests for search (issue #114, AC-4 and AC-6; one search, #870; the dialog does not move, #898).

Runs with the other tests/ui journeys through scripts/check_ui.sh against the running Compose
application. Ari owns a studio with a restricted project that Nia works in; Olek is a member who
is not in that project. Nia searches with the one Search tool (Ctrl+K, the sidebar and the phone's
Search), sees the results in groups by kind with no filters, opens a message, an old material
version and a rule, moves with the keys, and searches on the phone. Olek never sees the restricted
project, and recent places go away on sign-out. There is no Search page.
"""

from __future__ import annotations

import json
import math
import os
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder
from touch_targets import has_minimum_touch_size

UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
if UI_BROWSER not in ("chromium", "webkit"):
    raise ValueError(f"FLUX_UI_BROWSER must be chromium or webkit, got {UI_BROWSER!r}")
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
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=8000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def context(self, who: str | None, *, phone: bool = False, dark: bool = False) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "color_scheme": "dark" if dark else "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw", "service_workers": "block"}
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
        dialog = page.get_by_role("dialog", name="Search", exact=True)
        expect(dialog).to_be_visible()
        field = dialog.get_by_role("combobox", name="Search", exact=True)
        expect(field).to_be_focused()
        field.fill(query)
        return dialog, field

    def groups(self, dialog) -> list[str]:
        return dialog.locator(".jump__sh").all_inner_texts()

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
                     "Nia, can you check the sensor angle before Friday?",
                     "Kalibracja czujników jest zaplanowana na piątek."]:
            self.api(ari, "POST", f"/api/v1/conversations/{thread['id']}/messages", {"body": body, "clientMessageId": str(uuid.uuid4())}, status=201)
        material = self.api(ari, "POST", f"/api/v1/projects/{p}/materials", {"clientMutationId": str(uuid.uuid4()), "title": "Sensor comparison",
                                                                           "body": "The capacitive option drifts with humidity in the bedroom."}, status=201)
        self.api(ari, "PATCH", f"/api/v1/materials/{material['materialId']}", {"clientMutationId": str(uuid.uuid4()), "expectedVersion": 1,
                                                                              "body": "The infrared option wins on battery life and needs no calibration."}, status=200)
        self.api(nia, "POST", f"/api/v1/projects/{p}/work", {"title": "Mount the infrared sensor in the lamp base", "outcome": "A base that hides the sensor"}, status=201)
        rule = self.api(ari, "POST", f"/api/v1/projects/{p}/decisions", {"title": "Use the infrared sensor at night", "rationale": "It passed the hallway test at 5 lux."}, status=201)
        self.api(ari, "POST", f"/api/v1/decisions/{rule['id']}/accept", {}, status=200, headers={"if-match": '"1"'})
        sketch = self.api(nia, "POST", f"/api/v1/workspaces/{ws['id']}/sketches", {"title": "Sensing options", "scope": "project", "projectId": p}, status=201)
        thought = self.api(nia, "POST", f"/api/v1/sketches/{sketch['id']}/thoughts", {"text": "Sensor hidden behind the walnut veneer", "x": 0, "y": 0}, status=201)
        doc = self.api(ari, "POST", f"/api/v1/projects/{p}/docs", {"title": "Lamp wiring guide", "body": "Fit the brass collar before the sensor board."}, status=201)
        dm = self.api(ari, "POST", f"/api/v1/workspaces/{ws['id']}/dms", {"participantIds": [PEOPLE["nia"]["id"]]}, status=201)
        self.api(ari, "POST", f"/api/v1/dms/{dm['id']}/messages", {"body": "Did the spare sensor arrive at your place?", "clientMessageId": str(uuid.uuid4())}, status=201)
        olek = self.page("olek")
        open_thread = self.api(olek, "POST", f"/api/v1/projects/{notes['id']}/conversations", {"body": "The workshop is on Thursday, bring a sensor kit.", "clientMessageId": str(uuid.uuid4())}, status=201)
        type(self).ids = {"workspace": ws["id"], "lamp": p, "thread": thread["id"], "material": material["materialId"], "rule": rule["id"],
                          "sketch": sketch["id"], "thought": thought["thought"]["id"], "dm": dm["id"], "open_thread": open_thread["id"], "doc": doc["id"]}

    # ---------------------------------------------------------------- Search

    def test_02_ctrl_k_searches_as_you_type_and_opens_the_exact_message(self) -> None:
        page = self.page("nia")
        page.goto("/")
        expect(page.get_by_role("button", name="Search", exact=True)).to_be_visible()
        dialog, field = self.jump(page, "sensor")
        options = dialog.get_by_role("option")
        expect(options.first).to_be_visible()
        expect(dialog.get_by_role("listbox", name="Results")).to_contain_text("Sensor comparison")
        expect(dialog).to_contain_text("Material · version 2, current")
        expect(dialog).to_contain_text("Gesture lamp")
        expect(dialog.locator(".sr__hit").first).to_be_visible()
        self.assertEqual(options.first.get_attribute("aria-selected"), "true")
        # The results are in groups by kind, in one order, and there is nothing to filter with (#870).
        order = ["Tasks", "Messages", "Wiki", "Files", "Thoughts", "Spaces", "People"]
        shown = self.groups(dialog)
        for name in ("Tasks", "Messages", "Wiki", "Files", "Thoughts"):
            self.assertIn(name, shown)
        self.assertEqual(shown, [name for name in order if name in shown], "groups keep the drawn order")
        self.assertEqual(dialog.get_by_role("group").count(), 0, "no filter chips")
        expect(dialog.get_by_text("All places")).to_have_count(0)
        expect(dialog.get_by_role("option", name=re.compile("See all results"))).to_have_count(0)
        shot(page, "search-jump-desktop-1440")
        # Any of the words matches (BM25, F-042) and the groups keep their order: the message with both words leads the Messages group.
        field.fill("sensor reacts")
        reacts = dialog.locator("[role=option].sr").filter(has_text="The infrared sensor reacts at 5 lux in the hallway test.")
        expect(reacts).to_have_count(1)
        first_message = dialog.locator(".jump__sh", has_text="Messages").locator("xpath=following-sibling::*[@role='option'][1]")
        expect(first_message).to_contain_text("The infrared sensor reacts at 5 lux in the hallway test.")
        reacts.first.click()
        expect(dialog).to_be_hidden()
        expect(page).to_have_url(re.compile(rf"/projects/{self.ids['lamp']}/conversations/{self.ids['thread']}#message-"))
        expect(page.locator(".project-convo__message.is-arrived")).to_contain_text("hallway test")
        expect(page.locator(".project-convo__message.is-arrived")).to_be_focused()

    def test_03_arrow_keys_choose_and_old_versions_open_at_their_version(self) -> None:
        page = self.page("nia")
        page.goto("/")
        page.get_by_role("button", name="Search", exact=True).click()
        dialog = page.get_by_role("dialog", name="Search", exact=True)
        field = dialog.get_by_role("combobox", name="Search", exact=True)
        expect(field).to_be_focused()
        field.fill("humidity")
        option = dialog.locator("[role=option].sr").first
        expect(option).to_contain_text("Material · version 1 of 2")
        dialog.locator("[role=option].sr").first.click()
        expect(page).to_have_url(re.compile(rf"/materials/{self.ids['material']}/versions/1$"))
        # A rule opens in Details on its project.
        dialog, field = self.jump(page, "use the infrared")
        expect(dialog.locator("[role=option].sr").first).to_contain_text("Decision · accepted")
        field.press("ArrowDown")
        field.press("ArrowUp")
        self.assertEqual(dialog.get_by_role("option").first.get_attribute("aria-selected"), "true")
        dialog.locator("[role=option].sr").first.click()
        expect(page).to_have_url(re.compile(rf"/projects/{self.ids['lamp']}/tasks$"))
        expect(page.get_by_role("complementary", name="Details").or_(page.get_by_role("dialog", name="Details"))).to_contain_text("Use the infrared sensor at night")
        # A thought opens its sketch with the thought selected; Esc closes Search without moving.
        dialog, field = self.jump(page, "walnut")
        expect(dialog.locator("[role=option].sr").first).to_contain_text("Thought on the map “Sensing options”")
        dialog.locator("[role=option].sr").first.click()
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
        first = dialog.locator("[role=option].sr").filter(has_text="Did the spare sensor arrive at your place?").first
        expect(first).to_contain_text("With Ari Nowak")
        self.assertIn("Messages", self.groups(dialog))
        first.click()
        expect(page).to_have_url(re.compile(rf"/dm/{self.ids['dm']}#message-"))
        expect(page.locator(".dm-msg.is-arrived")).to_contain_text("spare sensor")
        dialog, field = self.jump(page, "brass collar")
        first = dialog.locator("[role=option].sr").first
        expect(first).to_contain_text("brass collar")
        self.assertIn("Wiki", self.groups(dialog))
        dialog.locator("[role=option].sr").first.click()
        expect(page).to_have_url(re.compile(rf"/projects/{self.ids['lamp']}/docs/{self.ids['doc']}(/versions/1)?$"))
        expect(page.get_by_role("heading", name="Lamp wiring guide").first).to_be_visible()
        dialog, field = self.jump(page, "zeppelin")
        expect(dialog.locator(".jump__none")).to_contain_text("Nothing matches “zeppelin”")
        expect(dialog.locator(".jump__none .kreska")).to_have_attribute("data-expression", "looking")
        shot(page, "search-jump-desktop-1440-empty")

    def test_05_the_keys_move_and_open_and_the_hint_is_one_plain_sentence(self) -> None:
        page = self.page("nia")
        page.goto("/")
        dialog, field = self.jump(page, "sensor")
        options = dialog.get_by_role("option")
        expect(options.first).to_be_visible()
        # ↓ moves the selection down the rows, ↑ back, and ↑ from the first wraps to the last.
        self.assertEqual(field.get_attribute("aria-activedescendant"), options.nth(0).get_attribute("id"))
        field.press("ArrowDown")
        field.press("ArrowDown")
        self.assertEqual(options.nth(2).get_attribute("aria-selected"), "true")
        self.assertEqual(field.get_attribute("aria-activedescendant"), options.nth(2).get_attribute("id"))
        field.press("ArrowUp")
        field.press("ArrowUp")
        field.press("ArrowUp")
        self.assertEqual(options.nth(options.count() - 1).get_attribute("aria-selected"), "true")
        # The footer says what the tool finds in one sentence, with none of the old words, and names the keys.
        foot = dialog.locator(".jump__foot")
        expect(foot).to_contain_text("Finds spaces, people, messages, tasks, Wiki pages, files and thoughts you can see.")
        hint = foot.locator(".jump__hint-line").inner_text().lower()
        for word in ("material", "version", "rule"):
            self.assertNotIn(word, hint)
        expect(foot).to_contain_text("move")
        expect(foot).to_contain_text("open")
        # Enter opens the first result of a narrower search.
        field.fill("walnut veneer")
        expect(options).to_have_count(1)
        expect(options.first).to_have_attribute("aria-selected", "true")
        field.press("Enter")
        expect(dialog).to_be_hidden()
        expect(page).to_have_url(re.compile(rf"/map/{self.ids['sketch']}#thought-"))

    def test_06_a_member_outside_the_project_never_sees_it(self) -> None:
        page = self.page("olek")
        page.goto("/")
        dialog, field = self.jump(page, "sensor")
        options = dialog.locator("[role=option].sr")
        expect(options).to_have_count(1)
        expect(options.first).to_contain_text("The workshop is on Thursday, bring a sensor kit.")
        self.assertEqual(self.groups(dialog), ["Messages"])
        content = page.content()
        for hidden in ["Gesture lamp", "infrared", "Sensor comparison", "spare sensor", "Sensor questions", self.ids["lamp"]]:
            self.assertNotIn(hidden, content)

    def test_07_recent_places_are_per_account_and_cleared_on_sign_out(self) -> None:
        page = self.page("nia")
        page.goto("/")
        dialog, field = self.jump(page, "hallway")
        expect(dialog.locator("[role=option].sr").first).to_be_visible()
        dialog.locator("[role=option].sr").first.click()
        # Search does not remember what was typed; its empty state lists the places opened (F-026 E02).
        dialog, field = self.jump(page, "")
        expect(dialog.get_by_role("listbox", name="Recent places and actions")).to_contain_text("Home")
        page.keyboard.press("Escape")
        self.assertEqual(page.evaluate("Object.keys(localStorage).filter((k) => k.startsWith('flux.search.recent.'))"), [])
        stored = page.evaluate("Object.keys(localStorage).filter((k) => k.startsWith('flux.places.recent.'))")
        self.assertEqual(stored, [f"flux.places.recent.{PEOPLE['nia']['id']}"])
        page.get_by_role("button", name=re.compile("Nia Berg")).click()
        page.get_by_role("dialog", name="Account").get_by_role("button", name="Sign out").click()
        expect(page).to_have_url(f"{ORIGIN}/sign-in")
        self.assertEqual(page.evaluate("Object.keys(localStorage).filter((k) => k.startsWith('flux.places.recent.'))"), [])
        # Signing in again (the stored session ended) starts with no recent places.
        page.get_by_label("Email").fill(PEOPLE["nia"]["email"])
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Sign in").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        type(self).states["nia"] = page.context.storage_state()
        dialog, field = self.jump(page, "")
        expect(dialog).not_to_contain_text("hallway")
        expect(dialog.locator(".jump__foot")).to_contain_text("Finds spaces, people, messages, tasks, Wiki pages, files and thoughts you can see.")

    def test_07a_there_is_no_search_page(self) -> None:
        page = self.page("nia")
        page.goto("/search?q=sensor")
        expect(page.get_by_text("This page doesn’t exist")).to_be_visible()
        expect(page.get_by_role("dialog", name="Search", exact=True)).to_have_count(0)

    # ---------------------------------------------------------------- phone

    def test_07b_target_measurement_preserves_the_44px_boundary(self) -> None:
        for size in (44, 48, 43.99997):
            self.assertTrue(has_minimum_touch_size(size), str(size))
        for size in (43.5, 43.75, 43.99, 43.9989, 0, -1, float("nan"), float("inf")):
            self.assertFalse(has_minimum_touch_size(size), str(size))

    def test_08_phone_search_from_the_tab_bar_and_the_page(self) -> None:
        page = self.page("nia", phone=True)
        page.goto("/")
        page.get_by_role("button", name="Search", exact=True).click()
        dialog = page.get_by_role("dialog", name="Search", exact=True)
        # The sheet first opens around a loading line; the real one replaces it when the search code arrives.
        field = dialog.get_by_role("combobox", name="Search", exact=True)
        expect(field).to_be_visible()
        box = dialog.bounding_box()
        assert box is not None
        self.assertEqual(round(box["width"]), PHONE["width"], "a full-screen sheet on the phone")
        field.fill("sensor")
        options = dialog.get_by_role("option")
        expect(options.first).to_be_visible()
        # One tool: the same grouped results as the computer's, and no chips to choose a kind with (#870).
        self.assertIn("Messages", self.groups(dialog))
        self.assertEqual(dialog.get_by_role("group").count(), 0, "no filter chips on the phone")
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
        # With no recent places yet, the sentence that says what it finds is above the list, with none of the old words.
        fresh = self.page("olek", phone=True)
        fresh.goto("/")
        fresh.get_by_role("button", name="Search", exact=True).click()
        sheet = fresh.get_by_role("dialog", name="Search", exact=True)
        hint = sheet.locator(".jump__hint")
        expect(hint).to_have_text("Finds spaces, people, messages, tasks, Wiki pages, files and thoughts you can see.")
        self.no_horizontal_scroll(fresh)
        shot(fresh, "search-jump-phone-390-empty")

    def test_09_dark_desktop_dialog(self) -> None:
        page = self.page("nia", dark=True)
        page.goto("/")
        dialog, field = self.jump(page, "infrared")
        expect(dialog.locator("[role=option].sr").first).to_be_visible()
        shot(page, "search-jump-desktop-1440-dark")

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
            expect(dialog.locator("[role=option].sr").first).to_contain_text(query.split()[0])
            dialog.locator("[role=option].sr").first.click()
            expect(page).to_have_url(re.compile(url))
            target = page.locator(selector)
            expect(target).to_contain_text("480 euros" if "oak" in query else "42 grams")
            expect(target).to_be_focused()
            expect(target).to_be_in_viewport()
            if "oak" in query:
                shot(page, "search-open-old-dm-message-desktop-1440")

    def test_11_task_number_leads_search_even_on_a_busy_project(self) -> None:
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
                expect(page.locator(".tb-card, .ws-task").first).to_be_visible()  # the phone lists rows, the computer shows the board
                page.keyboard.press("Control+k")
                dialog = page.get_by_role("dialog", name="Search", exact=True)
                field = dialog.get_by_role("combobox", name="Search", exact=True)
                for query in ("#2", "2", " #2 "):
                    field.fill(query)
                    expect(dialog.locator("[role=option].sr").first).to_contain_text(target["title"])
                dialog.locator("[role=option].sr").first.click()
                details = page.locator("#details")
                expect(details.get_by_role("heading", name=target["title"], exact=True)).to_be_visible()
                expect(details.locator(".ui-panel__meta")).to_have_text("#2")
                expect(details.locator(".wd__foot")).to_be_visible()
                self.no_horizontal_scroll(page)
                shot(page, f"task-number-jump-{'phone-390' if phone else 'desktop-1440'}")

                details.get_by_role("button", name="Close details").click()
                page.keyboard.press("Control+k")
                dialog = page.get_by_role("dialog", name="Search", exact=True)
                field = dialog.get_by_role("combobox", name="Search", exact=True)
                field.fill("#12")
                expect(dialog.locator("[role=option].sr").first).to_contain_text(tasks[11]["title"])
                shot(page, f"task-number-12-palette-{'phone-390' if phone else 'desktop-1440'}")
                page.keyboard.press("Escape")

                for number in (12, 26):
                    page.goto(f"/projects/{place['id']}/tasks")
                    expect(page.locator(".tb-card, .ws-task").first).to_be_visible()
                    page.keyboard.press("Control+k")
                    dialog = page.get_by_role("dialog", name="Search", exact=True)
                    dialog.get_by_role("combobox", name="Search", exact=True).fill(f"#{number}")
                    result = dialog.locator("[role=option].sr").first
                    expect(result).to_contain_text(tasks[number - 1]["title"])
                    expect(result).to_contain_text(f"#{number}")
                    shot(page, f"task-number-{number}-search-{'phone-390' if phone else 'desktop-1440'}")
                    result.click()
                    details = page.locator("#details")
                    expect(details.get_by_role("heading", name=tasks[number - 1]["title"], exact=True)).to_be_visible()
                    expect(details.locator(".ui-panel__meta")).to_have_text(f"#{number}")
                    expect(details.locator(".wd__foot")).to_be_visible()
                    expect(details.locator("[data-detail-relations-phase]")).to_have_attribute("data-detail-relations-phase", "ready")
                    expect(details.get_by_role("navigation", name="Object relationship pages")).to_have_count(0)
                    status = details.get_by_role("button", name="Status", exact=True)
                    expect(status).to_contain_text("To do")
                    expect(details.get_by_role("button", name="Owner", exact=True)).to_contain_text("Assign")
                    for name in ("Status", "Owner"):
                        field_box = details.get_by_role("button", name=name, exact=True).bounding_box()
                        label_box = details.locator(".wd-row dt", has_text=name).evaluate(
                            "node => { const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect().toJSON(); }")
                        self.assertGreaterEqual(field_box["x"] - label_box["x"] - label_box["width"], 11,
                                                f"{name} keeps a readable label/value gap at default text size")
                    self.no_horizontal_scroll(page)
                    shot(page, f"task-number-{number}-global-details-{'phone-390' if phone else 'desktop-1440'}")
                # The shared type tokens use rem. Enlarge actual text through the root size;
                # parseFloat(.75rem) followed by px would shrink it to 1.5px instead of 24px.
                page.evaluate("document.documentElement.style.fontSize = '200%'")
                number_label = details.locator(".ui-panel__meta")
                expect(number_label).to_be_visible()
                expect(details.locator(".wd__foot")).to_be_visible()
                self.assertGreaterEqual(number_label.evaluate("node => parseFloat(getComputedStyle(node).fontSize)"), 20)
                for name in ("Status", "Owner"):
                    field_box = details.get_by_role("button", name=name, exact=True).bounding_box()
                    label_box = details.locator(".wd-row dt", has_text=name).evaluate(
                        "node => { const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect().toJSON(); }")
                    self.assertGreaterEqual(field_box["x"] - label_box["x"] - label_box["width"], 11,
                                            f"{name} keeps a readable label/value gap with 200% text")
                expect(details.get_by_role("navigation", name="Object relationship pages")).to_have_count(0)
                self.no_horizontal_scroll(page)
                shot(page, f"task-number-26-text-200-{'phone-390' if phone else 'desktop-1440'}")


    # ---------------------------------------------------------------- projects by name (#465)

    def test_12_a_project_is_found_by_its_name_and_opens_its_home(self) -> None:
        page = self.page("nia")
        page.goto("/")
        expect(page.get_by_role("button", name="Search", exact=True)).to_be_visible()
        dialog, field = self.jump(page, "gesture lamp")
        project = dialog.locator("[role=option].sr").filter(has_text="Gesture lamp").first
        expect(project).to_be_visible()
        self.assertIn("Spaces", self.groups(dialog))
        expect(dialog.get_by_role("option", name=re.compile("New task"))).to_have_count(0)  # no Create group
        shot(page, "search-project-jump-desktop-1440")
        project.click()
        expect(dialog).to_be_hidden()
        expect(page).to_have_url(re.compile(rf"/projects/{self.ids['lamp']}"))
        expect(page.get_by_role("heading", level=1, name="Gesture lamp")).to_be_visible()

        # Olek is not in the restricted project: the name finds nothing.
        olek = self.page("olek")
        olek.goto("/")
        expect(olek.get_by_role("button", name="Search", exact=True)).to_be_visible()
        dialog, _ = self.jump(olek, "gesture lamp")
        expect(dialog.locator(".jump__none")).to_contain_text("Nothing matches")
        expect(dialog.locator("[role=option].sr").filter(has_text="Gesture lamp")).to_have_count(0)
        self.assertNotIn("Gesture lamp", olek.content())


    # ---------------------------------------------------------------- the dialog does not move (#898)

    SAMPLE = """() => {
        window.__dialog = []; const start = performance.now();
        const tick = () => {
            const dialog = document.querySelector('[role="dialog"][aria-label="Search"]');
            if (dialog) {
                const box = dialog.getBoundingClientRect();
                window.__dialog.push({ at: Math.round(performance.now() - start), height: Math.round(box.height * 100) / 100, offset: dialog.offsetTop,
                                       options: dialog.querySelectorAll('[role=option]').length, skeleton: !!dialog.querySelector('.jump-skeleton') });
            }
            if (performance.now() - start < 2200) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }"""

    def assistant_page(self, delay_ms: int) -> Page:
        """Nia with an assistant that is ready, whose status the page gets `delay_ms` after the server answers (the one read ⌘K used to make once it was open)."""
        context = self.browser.new_context(base_url=ORIGIN, viewport=DESKTOP, storage_state=self.states["nia"], locale="en-GB", service_workers="block")
        self.addCleanup(context.close)
        context.add_init_script(f"""
            const real = window.fetch.bind(window);
            window.fetch = (input, init) => {{
                const url = typeof input === 'string' ? input : input.url;
                if (new URL(url, location.href).pathname !== '/api/v1/personal-assistant' || (init && init.method && init.method !== 'GET')) return real(input, init);
                return real(input, init).then(async (response) => {{
                    const body = await response.json();
                    await new Promise((resolve) => setTimeout(resolve, {delay_ms}));
                    return new Response(JSON.stringify({{ ...body, state: 'ready' }}), {{ status: 200, headers: {{ 'content-type': 'application/json' }} }});
                }});
            }};""")
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def measure_open(self, page: Page) -> list[dict]:
        """Opens Search and reads the dialog's box on every frame for two seconds, from the frame it appears in."""
        page.evaluate(self.SAMPLE)
        page.keyboard.press("Control+k")
        dialog = page.get_by_role("dialog", name="Search", exact=True)
        expect(dialog.get_by_role("combobox", name="Search", exact=True)).to_be_visible()
        page.wait_for_timeout(2300)
        return page.evaluate("window.__dialog")

    def test_13_the_dialog_is_its_final_size_when_it_opens_and_does_not_move(self) -> None:
        for delay in (0, 1800):
            with self.subTest(status_arrives_after_ms=delay):
                page = self.assistant_page(delay)
                page.goto("/")
                expect(page.get_by_role("button", name="Search", exact=True)).to_be_visible()
                page.wait_for_timeout(500 if delay else 1200)  # a status that is ready, or one that is still on its way
                samples = self.measure_open(page)
                self.assertGreater(len(samples), 20, "the dialog was sampled on its frames")
                self.assertEqual({sample["height"] for sample in samples}, {samples[0]["height"]}, f"the dialog never changes height: {samples[:3]} … {samples[-3:]}")
                self.assertEqual({sample["offset"] for sample in samples}, {samples[0]["offset"]}, "and its place in the layout never changes (its 8 px entry travel is a transform)")
                dialog = page.get_by_role("dialog", name="Search", exact=True)
                # No assistant row at any time (README S5: its suggestions are in the `/` menu, #1376): nothing is added to the dialog.
                expect(dialog.get_by_role("option", name=re.compile("Ask my assistant"))).to_have_count(0)
                shot(page, f"search-open-stable-desktop-1440-{delay}")

    # ---------------------------------------------------------------- Polish words and accents (BM25, #1293)

    def test_13a_another_form_of_a_word_and_a_word_without_its_accents_find_the_text_and_mark_it(self) -> None:
        page = self.page("nia")
        page.goto("/")
        expect(page.get_by_role("button", name="Search", exact=True)).to_be_visible()
        kalibracja = "Kalibracja czujników jest zaplanowana na piątek."
        # "czujnik" is the base form of "czujników", and "kalibr" is the word as far as it is typed.
        for query, marked in (("czujnik", ["czujników"]), ("czujnikow piatek", ["czujników", "piątek"]), ("kalibr", ["Kalibracja"])):
            with self.subTest(query=query):
                dialog, field = self.jump(page, query)
                row = dialog.locator("[role=option].sr").filter(has_text=kalibracja)
                expect(row).to_have_count(1)
                expect(row.first.locator(".sr__hit")).to_have_text(marked)
                page.keyboard.press("Escape")
                expect(dialog).to_be_hidden()
        # Any of the words matches, so one that is nowhere does not hide the others.
        dialog, field = self.jump(page, "czujnik zeppelin")
        expect(dialog.locator("[role=option].sr").filter(has_text=kalibracja)).to_have_count(1)
        shot(page, "search-polish-form-desktop-1440")
        # The key opens the message, as for any other result.
        dialog.locator("[role=option].sr").filter(has_text=kalibracja).first.click()
        expect(page).to_have_url(re.compile(rf"/projects/{self.ids['lamp']}/conversations/{self.ids['thread']}#message-"))
        expect(page.locator(".project-convo__message.is-arrived")).to_contain_text("zaplanowana na piątek")

    # ---------------------------------------------------------------- more than the dialog lists

    def test_14_more_than_twenty_results_end_with_one_quiet_line(self) -> None:
        ari = self.page("ari")
        place = self.api(ari, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/projects", {"name": "Lantern shelf", "visibility": "restricted"}, status=201)
        thread = self.api(ari, "POST", f"/api/v1/projects/{place['id']}/conversations", {"body": "Lantern 1 for the shelf", "clientMessageId": str(uuid.uuid4())}, status=201)
        for index in range(2, 26):
            self.api(ari, "POST", f"/api/v1/conversations/{thread['id']}/messages", {"body": f"Lantern {index} for the shelf", "clientMessageId": str(uuid.uuid4())}, status=201)
        self.api(ari, "POST", f"/api/v1/conversations/{thread['id']}/messages", {"body": "A quincunx of lanterns", "clientMessageId": str(uuid.uuid4())}, status=201)
        for index in range(1, 21):
            self.api(ari, "POST", f"/api/v1/conversations/{thread['id']}/messages", {"body": f"Pennant {index} for the mast", "clientMessageId": str(uuid.uuid4())}, status=201)
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page("ari", phone=phone)
                page.goto("/")
                if phone:
                    page.get_by_role("button", name="Search", exact=True).click()
                    dialog = page.get_by_role("dialog", name="Search", exact=True)
                    field = dialog.get_by_role("combobox", name="Search", exact=True)
                    field.fill("lantern")
                else:
                    dialog, field = self.jump(page, "lantern")
                expect(dialog.get_by_role("option")).to_have_count(20)
                line = dialog.locator(".jump__more")
                expect(line).to_have_text("Showing 20 \u00b7 type more words to narrow")
                expect(dialog.get_by_role("listbox").locator(".jump__more")).to_have_count(0)  # a line under the list, never a row to choose
                expect(dialog.locator("p.ui-vh[role=status]")).to_have_text("20+ results")
                if not phone:
                    shot(page, "search-more-than-twenty-desktop-1440")
                # The line stays while the next answer loads, so the dialog's bottom edge does not move on a keystroke (#1003).
                settled_box = dialog.bounding_box()
                held: list = []
                page.route("**/api/v1/search?*", lambda route: held.append(route))
                field.fill("lantern shelf")
                expect(dialog.locator("p.ui-vh[role=status]")).to_have_text("Searching…")
                expect(line).to_have_text("Showing 20 \u00b7 type more words to narrow")
                self.assertEqual(dialog.bounding_box(), settled_box, "the dialog did not change size while it searched")
                page.unroute("**/api/v1/search?*")
                for route in held:
                    route.continue_()
                expect(dialog.locator("p.ui-vh[role=status]")).not_to_have_text("Searching…")
                expect(dialog.get_by_role("option")).to_have_count(20)
                expect(line).to_have_text("Showing 20 \u00b7 type more words to narrow")
                self.assertEqual(dialog.bounding_box(), settled_box, "nor when it was answered")
                # Text that matches nothing has no such line.
                field.fill("qzxvw")
                expect(dialog.locator(".jump__none")).to_be_visible()
                expect(line).to_have_count(0)
                # A search with a few results has none either.
                field.fill("quincunx")
                expect(dialog.get_by_role("option")).to_have_count(1)
                expect(line).to_have_count(0)
                # Exactly twenty is all of them: twenty rows, "20 results", and no line about more (#1003).
                field.fill("pennant")
                expect(dialog.get_by_role("option")).to_have_count(20)
                expect(dialog.locator("p.ui-vh[role=status]")).to_have_text("20 results")
                expect(line).to_have_count(0)


if __name__ == "__main__":
    unittest.main()
