"""#134: personal outline against the running authorized graph, not a mock tree."""
from __future__ import annotations

import json
import re
import time
import unittest

from playwright.sync_api import expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, SHOTS, UPSTREAM, shot, start_forwarder
from test_theme_accents import FAMILIES, MEASURE

STAMP = int(time.time() * 1000)
PASSWORD = "keep the graph connected"
LABELS = [
    "Gesture lamp · explore an unobtrusive bedside interaction",
    "Capture the gesture without recording a camera image",
    "Compare ToF sensors with the radar prototype",
    "Test a slow swipe across the full bedside working area",
    "Check the long-distance receiver trace and preserve readable code during a screen-sharing review",
    "Quiet hours · a separate direction",
    "Try a deliberate hold before switching the lamp off",
    "Disconnected idea · mechanical brightness control",
]


class MapOutlineJourney(unittest.TestCase):
    states = {}
    ids = {}
    thoughts = {}
    workspace_id = ""
    project_id = ""
    sketch_id = ""
    baseline = {}
    work_baseline = {}

    @classmethod
    def setUpClass(cls):
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        expect.set_options(timeout=10000)
        contexts = {}
        for key, name in (("owner", "Ada Outline"), ("viewer", "Kai Reader")):
            context = cls.browser.new_context(base_url=ORIGIN)
            email = f"outline-{key}+{STAMP}@example.test"
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.states[key] = context.storage_state()
            contexts[key] = context
        owner = contexts["owner"]

        def post(path, body):
            response = owner.request.post(path, data=body, headers={"origin": ORIGIN})
            assert response.status == 201, response.text()
            return response.json()

        cls.workspace_id = post("/api/v1/workspaces", {"name": "Gesture studies"})["id"]
        post(f"/api/v1/workspaces/{cls.workspace_id}/members", {"email": f"outline-viewer+{STAMP}@example.test", "role": "member"})
        cls.project_id = post(f"/api/v1/workspaces/{cls.workspace_id}/projects", {"name": "Quiet gesture lamp", "visibility": "restricted"})["id"]
        post(f"/api/v1/projects/{cls.project_id}/grants", {"principal": {"kind": "human", "id": cls.ids["viewer"]}, "role": "viewer"})
        cls.sketch_id = post(f"/api/v1/workspaces/{cls.workspace_id}/sketches", {"title": "Bedside interaction directions", "scope": "project", "projectId": cls.project_id})["id"]
        cls.private_draft = post(f"/api/v1/workspaces/{cls.workspace_id}/drafts", {"title": "PRIVATE CALIBRATION NOTES", "body": "Never disclose this draft to the project viewer"})["id"]
        for context in contexts.values():
            context.close()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def page(self, who="owner", *, fresh=False, **options):
        state = self.states[who]
        if fresh:
            state = {"cookies": state["cookies"], "origins": []}
        context = self.browser.new_context(**{"base_url": ORIGIN, "storage_state": state, "viewport": DESKTOP, "color_scheme": "light", **options})
        self.addCleanup(context.close)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def open(self, page, fragment=""):
        page.goto(f"/projects/{self.project_id}/map/{self.sketch_id}{fragment}")
        page.get_by_role("radio", name="List", exact=True).click()
        expect(page.locator(".sk-head")).to_contain_text("Bedside interaction directions")
        if self.stored(page)["thoughts"]:
            expect(page.get_by_role("list", name="Thoughts in Bedside interaction directions")).to_be_visible()

    def api(self, page, method, path, body=None, status=200, headers=None):
        response = page.request.fetch(path, method=method, data=body, headers={"origin": ORIGIN, **(headers or {})})
        self.assertEqual(response.status, status, response.text())
        return response.json() if response.text() else None

    def stored(self, page):
        return self.api(page, "GET", f"/api/v1/sketches/{self.sketch_id}")

    def work(self, page):
        return self.api(page, "GET", f"/api/v1/projects/{self.project_id}/work?limit=100")

    def wait_graph(self, page, predicate):
        """Observe committed API state explicitly, rather than optimistic UI or a Promise handle."""
        for _ in range(60):
            data = self.stored(page)
            if predicate(data):
                return data
            time.sleep(0.25)
        self.fail("the expected committed graph state did not arrive")

    def row(self, page, index):
        return page.locator(f'.sk-outline-list > li[data-id="{self.thoughts[index]}"]')

    def title(self, page, index):
        return self.row(page, index).locator(".sk-li-t")

    def levels(self, page):
        return page.locator(".sk-outline-list > li").evaluate_all("rows => Object.fromEntries(rows.map(row => [row.dataset.id, Number(row.dataset.depth)]))")

    def save(self, page):
        type(self).states["owner"] = page.context.storage_state()

    def add(self, page, text, parent_index=None):
        if parent_index is None:
            selected = page.locator('.sk-li-t[aria-pressed="true"]')
            if selected.count():
                selected.first.focus()
                page.keyboard.press("Escape")
            page.get_by_role("toolbar", name="Sketch tools").get_by_role("button", name="Thought", exact=True).click()
        else:
            self.title(page, parent_index).click()
            self.row(page, parent_index).get_by_role("button", name="Add thought", exact=True).click()
        editor = page.get_by_label("Thought text")
        editor.fill(text)
        editor.press("Enter")
        expect(page.locator(".sk-status")).to_contain_text("Saved")
        return next(thought["id"] for thought in self.stored(page)["thoughts"] if thought["text"] == text)

    def connect(self, page, source_index, target_index):
        self.title(page, source_index).click()
        page.get_by_role("toolbar", name="Sketch tools").get_by_role("button", name="Connect", exact=True).click()
        self.title(page, target_index).click()
        expect(page.locator(".sk-status")).to_contain_text("Saved")

    def group(self, page, source_index, parent_index=None):
        self.title(page, source_index).click()
        self.row(page, source_index).get_by_role("button", name="Group in list…", exact=True).click()
        select = self.row(page, source_index).get_by_role("combobox")
        select.select_option(self.thoughts[parent_index] if parent_index is not None else "")
        self.row(page, source_index).get_by_role("button", name="Apply grouping", exact=True).click()

    def test_01_deep_branches_and_ordinary_cross_links_remain_stable_after_reload(self):
        page = self.page()
        self.open(page)
        for index, text in enumerate(LABELS):
            parent = index - 1 if index in (1, 2, 3, 4, 6) else None
            self.thoughts[index] = self.add(page, text, parent)
        expected = {self.thoughts[index]: level for index, level in enumerate((0, 1, 2, 3, 4, 0, 1, 0))}
        self.assertEqual(self.levels(page), expected)
        for source, target in ((5, 3), (4, 5), (6, 3), (4, 6), (0, 4)):
            self.connect(page, source, target)
            self.assertEqual(self.levels(page), expected, "ordinary relations never change a parent or root")
        type(self).baseline = self.stored(page)
        self.assertEqual(len(self.baseline["thoughts"]), 8)
        self.assertEqual(len(self.baseline["links"]), 10)
        for title, indices in (("Compare sensor trace and receiver code", (2, 4)), ("Test quiet hold without recording people", (4, 6))):
            self.api(page, "POST", f"/api/v1/projects/{self.project_id}/work", {"title": title, "sources": [{"type": "thought", "id": self.thoughts[index]} for index in indices]}, status=201)
        type(self).work_baseline = self.work(page)
        self.assertEqual(len(self.work_baseline["items"]), 2)
        page.reload()
        expect(self.title(page, 4)).to_be_visible()
        self.assertEqual(self.levels(page), expected)
        self.assertEqual(self.stored(page), self.baseline)
        self.save(page)
        fresh = self.page(fresh=True)
        self.open(fresh)
        self.assertTrue(all(level == 0 for level in self.levels(fresh).values()), "fresh browser never guesses a historical parent from relations")
        self.assertEqual(self.stored(fresh), self.baseline)

    def test_02_collapsed_cross_link_reveals_exact_destination_and_back_restores_place(self):
        page = self.page()
        self.open(page)
        self.row(page, 0).get_by_role("button", name=re.compile("^Collapse ")).click()
        expect(self.title(page, 4)).to_have_count(0)
        self.title(page, 5).click()
        before = self.stored(page)
        self.row(page, 5).locator(".sk-outline-related").get_by_role("button", name=f"Related to {LABELS[4]}", exact=True).click()
        expect(self.title(page, 4)).to_be_focused()
        expect(self.title(page, 4)).to_have_attribute("aria-pressed", "true")
        page.get_by_role("button", name=f"Back to “{LABELS[5]}”", exact=True).click()
        expect(self.title(page, 5)).to_be_focused()
        expect(self.title(page, 4)).to_have_count(0)
        self.assertEqual(self.stored(page), before)
        self.assertEqual(self.work(page), self.work_baseline, "many-to-many work links keep the exact thought IDs")
        self.row(page, 0).get_by_role("button", name=re.compile("^Expand ")).click()
        self.title(page, 0).focus()
        page.keyboard.press("ArrowDown")
        expect(self.title(page, 1)).to_be_focused()
        self.title(page, 7).click()
        expect(self.title(page, 7)).to_be_focused()
        self.title(page, 1).focus()
        page.keyboard.press("ArrowRight")
        expect(self.title(page, 2)).to_be_focused()
        page.keyboard.press("ArrowLeft")
        expect(self.title(page, 3)).to_have_count(0)
        page.keyboard.press("ArrowLeft")
        expect(self.title(page, 1)).to_be_focused()
        self.title(page, 1).press("ArrowRight")
        self.title(page, 2).press("ArrowRight")
        expect(page.locator(".sk-outline-path ol")).to_have_count(0)
        self.row(page, 4).locator(".sk-outline-path summary").click()
        path = self.row(page, 4).locator(".sk-outline-path ol")
        expect(path).to_be_visible()
        expect(path.get_by_role("button")).to_have_count(4)
        expect(page.locator(".sk-outline-path ol")).to_have_count(1)
        path.get_by_role("button", name=f"Go to ancestor {LABELS[1]}", exact=True).click()
        expect(self.title(page, 1)).to_be_focused()
        page.locator(".sk-outline-back").click()
        expect(self.title(page, 4)).to_be_focused()
        self.assertEqual(self.stored(page), before)
        self.save(page)

    def test_03_explicit_linked_only_grouping_and_local_undo_include_collapsed_target(self):
        page = self.page()
        self.open(page)
        before = self.stored(page)
        self.row(page, 0).get_by_role("button", name=re.compile("^Collapse ")).click()
        self.group(page, 5, 3)
        expect(self.title(page, 5)).to_be_focused()
        self.assertEqual(self.row(page, 5).get_attribute("data-depth"), "4")
        self.assertEqual(self.row(page, 6).get_attribute("data-depth"), "5")
        page.get_by_role("button", name="Undo list grouping", exact=True).click()
        self.assertEqual(self.row(page, 5).get_attribute("data-depth"), "0")
        self.assertEqual(self.row(page, 6).get_attribute("data-depth"), "1")
        self.title(page, 0).click()
        self.row(page, 0).get_by_role("button", name="Group in list…", exact=True).click()
        options = self.row(page, 0).get_by_role("combobox").locator("option").evaluate_all("options => options.map(option => option.value)")
        self.assertEqual(options, [""], "descendants and unlinked thoughts cannot become parents")
        self.row(page, 0).get_by_role("button", name="Cancel", exact=True).click()
        self.assertEqual(self.stored(page), before, "grouping and its undo never write the graph")
        self.assertEqual(self.work(page), self.work_baseline)
        self.save(page)

    def test_03b_grouping_undo_preserves_later_child_intent_and_exact_override_history(self):
        page = self.page()
        self.open(page)
        self.group(page, 5, 3)
        added = self.add(page, "Independent child placed after grouping", 4)
        added_row = page.locator(f'.sk-outline-list > li[data-id="{added}"]')
        expect(added_row).to_have_attribute("data-depth", "5")
        persisted = self.stored(page)
        self.group(page, 6, 4)
        undo = page.get_by_role("button", name="Undo list grouping", exact=True)
        undo.click()
        expect(self.row(page, 6)).to_have_attribute("data-depth", "5")
        expect(added_row).to_have_attribute("data-depth", "5")
        undo.click()
        expect(self.row(page, 5)).to_have_attribute("data-depth", "0")
        expect(self.row(page, 6)).to_have_attribute("data-depth", "1")
        expect(added_row).to_have_attribute("data-depth", "5")
        self.assertEqual(self.stored(page), persisted, "list undos preserve the exact committed graph")
        key = f"{self.ids['owner']}:{self.workspace_id}:{self.sketch_id}"
        parents = page.evaluate("key => JSON.parse(localStorage.getItem('flux.sketch.outlines.v1')).find(entry => entry.key === key).state.parents", key)
        self.assertIn(self.thoughts[5], parents)
        self.assertIsNone(parents[self.thoughts[5]], "an explicit root override stays explicit after undo")
        self.assertEqual(parents[added], self.thoughts[4])

        fresh = self.page(fresh=True)
        self.open(fresh)
        self.group(fresh, 1, 0)
        self.group(fresh, 1)
        fresh_undo = fresh.get_by_role("button", name="Undo list grouping", exact=True)
        fresh_undo.click()
        expect(self.row(fresh, 1)).to_have_attribute("data-depth", "1")
        fresh_undo.click()
        expect(self.row(fresh, 1)).to_have_attribute("data-depth", "0")
        fresh.wait_for_function("arg => !Object.hasOwn(JSON.parse(localStorage.getItem('flux.sketch.outlines.v1')).find(entry => entry.key === arg.key).state.parents, arg.id)", arg={"key": key, "id": self.thoughts[1]})
        self.assertEqual(self.stored(fresh), persisted, "consecutive same-thought undos also leave the graph unchanged")
        shot(page, "map-outline-independent-child-after-grouping-undo")
        # The graph Undo is separate from local grouping Undo and removes this test's new child.
        page.get_by_role("toolbar", name="Sketch tools").get_by_role("button", name="Undo", exact=True).click()
        self.wait_graph(page, lambda data: all(thought["id"] != added for thought in data["thoughts"]))

    def test_04_rename_delete_graph_undo_and_search_reveal_preserve_exact_ids(self):
        page = self.page()
        self.open(page)
        original = self.stored(page)
        self.title(page, 4).focus()
        page.keyboard.press("Enter")
        renamed = LABELS[4] + " · receiver code review"
        page.get_by_label("Thought text").fill(renamed)
        page.get_by_label("Thought text").press("Enter")
        expect(page.locator(".sk-status")).to_contain_text("Saved")
        expect(self.row(page, 5).locator(".sk-outline-related")).to_contain_text(renamed)
        self.assertEqual(self.stored(page)["thoughts"][-1]["id"] in self.thoughts.values(), True)
        self.title(page, 3).focus()
        page.keyboard.press("Delete")
        expect(page.locator(".sk-status")).to_contain_text("Saved")
        expect(self.title(page, 3)).to_have_count(0)
        self.assertEqual(self.row(page, 4).get_attribute("data-depth"), "0")
        self.wait_graph(page, lambda data: all(thought["id"] != self.thoughts[3] for thought in data["thoughts"]))
        page.get_by_role("toolbar", name="Sketch tools").get_by_role("button", name="Undo", exact=True).click()
        expect(page.locator(".sk-status")).to_contain_text("Undid: removed a thought")
        expected_links = {link["id"] for link in original["links"]}
        restored = self.wait_graph(page, lambda data: any(thought["id"] == self.thoughts[3] for thought in data["thoughts"]) and {link["id"] for link in data["links"]} == expected_links)
        expect(self.title(page, 3)).to_be_visible()
        self.assertEqual(self.row(page, 4).get_attribute("data-depth"), "4")
        self.assertEqual({item["id"] for item in restored["thoughts"]}, {item["id"] for item in original["thoughts"]})
        self.assertEqual({item["id"] for item in restored["links"]}, {item["id"] for item in original["links"]})
        self.title(page, 4).focus()
        page.keyboard.press("Enter")
        page.get_by_label("Thought text").fill(LABELS[4])
        page.get_by_label("Thought text").press("Enter")
        expect(page.locator(".sk-status")).to_contain_text("Saved")
        self.wait_graph(page, lambda data: next(thought["text"] for thought in data["thoughts"] if thought["id"] == self.thoughts[4]) == LABELS[4])
        self.row(page, 0).get_by_role("button", name=re.compile("^Collapse ")).click()
        page.goto(f"/projects/{self.project_id}/map/{self.sketch_id}#thought-{self.thoughts[4]}")
        expect(self.title(page, 4)).to_be_focused()
        expect(self.title(page, 4)).to_have_attribute("aria-pressed", "true")
        before = self.stored(page)
        page.get_by_role("radio", name="Map", exact=True).click()
        expect(page.locator(f'.sk-node[data-id="{self.thoughts[4]}"]')).to_have_attribute("aria-pressed", "true")
        page.get_by_role("radio", name="List", exact=True).click()
        self.assertEqual(self.row(page, 4).get_attribute("data-depth"), "4")
        # Exercise the real router arrival contract used by LiveProvider without a fake SFU.
        # Media/session transport remains the separate opt-in live profile's responsibility.
        self.row(page, 0).get_by_role("button", name=re.compile("^Collapse ")).click()
        self.row(page, 5).get_by_role("button", name=re.compile("^Collapse ")).click()
        page.evaluate("""ids => {
            history.pushState({usr: {liveSelect: ids, liveFollow: true}, key: 'outline-live-arrival', idx: (history.state?.idx ?? 0) + 1}, '', location.pathname);
            dispatchEvent(new PopStateEvent('popstate'));
        }""", [self.thoughts[4], self.thoughts[6], "00000000-0000-4000-8000-000000000000"])
        expect(self.title(page, 4)).to_be_focused()
        expect(self.title(page, 4)).to_have_attribute("aria-pressed", "true")
        expect(self.title(page, 6)).to_have_attribute("aria-pressed", "true")
        expect(page.locator('.sk-li-t[aria-pressed="true"]')).to_have_count(2)
        self.row(page, 0).get_by_role("button", name=re.compile("^Collapse ")).click()
        expect(self.title(page, 4)).to_have_count(0)
        self.row(page, 0).get_by_role("button", name=re.compile("^Expand ")).click()
        self.assertEqual(self.stored(page), before)
        self.save(page)

    def test_05_viewer_local_grouping_is_readonly_and_private_placement_stays_restricted(self):
        owner = self.page()
        data = self.api(owner, "POST", f"/api/v1/sketches/{self.sketch_id}/thoughts", {"text": "Compare calibration notes without sharing the private source", "x": 0, "y": 300, "placement": {"type": "draft", "id": self.private_draft}, "linkFrom": {"thoughtId": self.thoughts[0]}}, status=201)
        placed_id = data["thought"]["id"]
        viewer = self.page("viewer")
        self.open(viewer)
        expect(viewer.get_by_role("toolbar", name="Sketch tools")).to_have_count(0)
        expect(viewer.locator(".sk-outline-list")).not_to_contain_text("PRIVATE CALIBRATION NOTES")
        expect(viewer.locator(f'.sk-outline-list > li[data-id="{placed_id}"]')).to_contain_text("Draft you can’t open")
        before = self.stored(viewer)
        self.group(viewer, 1, 0)
        self.assertEqual(self.row(viewer, 1).get_attribute("data-depth"), "1")
        expect(self.row(viewer, 1).get_by_role("button", name="Edit", exact=True)).to_have_count(0)
        expect(self.row(viewer, 1).get_by_role("button", name="Add thought", exact=True)).to_have_count(0)
        self.title(viewer, 1).focus()
        for key in ("Enter", "+", "Delete"):
            viewer.keyboard.press(key)
        expect(viewer.get_by_label("Thought text")).to_have_count(0)
        self.assertEqual(self.stored(viewer), before)
        raw = viewer.evaluate("localStorage.getItem('flux.sketch.outlines.v1')")
        self.assertNotIn("PRIVATE", raw)
        self.assertNotIn(LABELS[0], raw)
        self.assertTrue(all(level == 0 for level in self.levels(self._fresh_owner()).values()), "viewer grouping never changes the owner's fresh view")
        self.api(owner, "POST", f"/api/v1/projects/{self.project_id}/grants", {"principal": {"kind": "human", "id": self.ids["viewer"]}, "role": "denied"}, status=201)
        self.api(viewer, "GET", f"/api/v1/sketches/{self.sketch_id}", status=404)
        viewer.goto(f"/map/{self.sketch_id}")
        expect(viewer.get_by_role("heading", name="This sketch isn’t available")).to_be_visible()
        expect(viewer.locator("body")).not_to_contain_text(LABELS[4])

    def _fresh_owner(self):
        page = self.page(fresh=True)
        self.open(page)
        return page

    def test_06_render_matched_light_dark_phone_tablet_and_enlarged_text(self):
        measurements = []
        for scheme in ("Light", "Dark"):
            for family in FAMILIES:
                page = self.page()
                self.open(page)
                # Appearance lives on the Settings page (#272 FF-4); back to the sketch within this visit.
                page.locator(".me__btn").click()
                pop = page.locator(".set")
                pop.get_by_role("radio", name=scheme, exact=True).click()
                pop.get_by_role("radio", name=family, exact=True).click()
                expect(pop.get_by_role("radio", name=family, exact=True)).to_have_attribute("aria-checked", "true")
                page.go_back()
                expect(page).not_to_have_url(re.compile(r"/settings$"))
                self.title(page, 4).click()
                for selector in ('.sk-li-t', '.sk-li-s', '.sk-outline-related button', '.sk-outline-selected', '.sk-outline-path summary'):
                    page.wait_for_function("selector => { const node = document.querySelector(selector); if (!node) return false; for (let el = node; el; el = el.parentElement) if (Number(getComputedStyle(el).opacity) !== 1) return false; return true; }", arg=selector)
                    measured = page.evaluate(MEASURE, {"selector": selector})
                    measurements.append({"theme": scheme, "family": family, **measured})
                    self.assertGreaterEqual(measured["ratio"], 4.5, f"{scheme}/{family} {selector} actual composite contrast")
                shot(page, f"map-outline-{scheme.lower()}-{family.lower()}-desktop-1440")
        if SHOTS:
            (SHOTS / "map-outline-contrast.json").write_text(json.dumps(measurements, indent=2) + "\n")
        for scheme in ("light", "dark"):
            page = self.page()
            page.emulate_media(color_scheme=scheme)
            self.open(page)
            self.title(page, 4).click()
            for name, viewport in (("desktop-1440", DESKTOP), ("desktop-1280", {"width": 1280, "height": 800}), ("phone-390", PHONE), ("tablet-820", {"width": 820, "height": 1180})):
                page.set_viewport_size(viewport)
                self.title(page, 4).scroll_into_view_if_needed()
                shot(page, f"map-outline-{scheme}-{name}")
                self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), viewport["width"], "no horizontal document overflow")
                title = self.title(page, 4).bounding_box()
                self.assertGreater(title["width"], 190 if viewport["width"] == 390 else 300, "deep indentation leaves readable content")
            page.set_viewport_size(PHONE)
            page.add_style_tag(content=":root { --fs-xs: 24px !important; --fs-sm: 26px !important; --fs-md: 28px !important; --fs-base: 30px !important; --fs-lg: 34px !important; --fs-xl: 40px !important; --fs-2xl: 48px !important; }")
            self.assertEqual(self.title(page, 4).evaluate("node => getComputedStyle(node).fontSize"), "28px", "actual row text is enlarged")
            self.title(page, 4).scroll_into_view_if_needed()
            shot(page, f"map-outline-{scheme}-phone-enlarged")
            self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), PHONE["width"])
        touch = self.page(viewport=PHONE, is_mobile=True, has_touch=True)
        self.open(touch)
        self.row(touch, 0).get_by_role("button", name=re.compile("^Collapse ")).tap()
        self.title(touch, 5).tap()
        self.row(touch, 5).locator(".sk-outline-related").get_by_role("button", name=f"Related to {LABELS[4]}", exact=True).tap()
        expect(self.title(touch, 4)).to_have_attribute("aria-pressed", "true")
        expect(self.title(touch, 4)).to_be_focused()
        expect(self.title(touch, 4)).to_be_in_viewport(ratio=1)
        expect(self.row(touch, 4).locator('.sk-li-s').first).to_be_in_viewport(ratio=1)
        expect(self.row(touch, 4).locator('.sk-outline-path summary')).to_be_in_viewport(ratio=1)
        back = touch.get_by_role("button", name=f"Back to “{LABELS[5]}”", exact=True)
        self.assertGreaterEqual(back.bounding_box()["y"], 0)
        self.assertLess(back.bounding_box()["y"], PHONE["height"], "the return action stays in the phone viewport")
        shot(touch, "map-outline-phone-related-follow-back")
        back.tap()
        expect(self.title(touch, 4)).to_have_count(0)

    def test_07_unavailable_and_corrupt_storage_keep_this_visit_useful_without_claiming_reload_persistence(self):
        blocked = self.page(fresh=True)
        blocked.add_init_script("Storage.prototype.getItem = () => { throw new DOMException('Blocked', 'SecurityError'); }; Storage.prototype.setItem = () => { throw new DOMException('Blocked', 'SecurityError'); };")
        self.open(blocked)
        before = self.stored(blocked)
        self.assertTrue(all(level == 0 for level in self.levels(blocked).values()))
        self.group(blocked, 1, 0)
        self.assertEqual(self.row(blocked, 1).get_attribute("data-depth"), "1")
        blocked.reload()
        blocked.get_by_role("radio", name="List", exact=True).click()
        self.assertTrue(all(level == 0 for level in self.levels(blocked).values()))
        self.assertEqual(self.stored(blocked), before)
        corrupt = self.page()
        corrupt.add_init_script("localStorage.setItem('flux.sketch.outlines.v1', '{bad cached title');")
        self.open(corrupt)
        self.assertTrue(all(level == 0 for level in self.levels(corrupt).values()))
        self.assertEqual(self.stored(corrupt), before)
