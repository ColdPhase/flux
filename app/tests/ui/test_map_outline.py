"""#510 (Spokój board A04) over #134: the List is the map's tree against the running authorized graph.

Connections record which thought they were drawn from; a thought sits under the oldest thought with a
connection drawn to it and names its other parents ("also under …"). Tab / Shift+Tab move a thought's
connection on the map, ⌥↑/⌥↓ change only this person's reading order, and folding is personal too.
"""
from __future__ import annotations

import json
import re
import time
import unittest

from playwright.sync_api import expect, sync_playwright

from test_app_shell import show_map_as, DESKTOP, ORIGIN, PHONE, SHOTS, UPSTREAM, shot, start_forwarder
from contrast import MEASURE

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
# Created as children of the thought before them (1–4, 6), then connected 5→3, 4→5, 6→3, 4→6, 0→4.
CREATED = (0, 1, 2, 3, 4, 0, 1, 0)
TREE = (0, 1, 2, 3, 1, 2, 2, 0)


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
        show_map_as(page, "List")
        expect(page.locator(".sk-head")).to_contain_text("Bedside interaction directions")
        if self.stored(page)["thoughts"]:
            expect(self.tree(page)).to_be_visible()

    def tree(self, page):
        return page.get_by_role("tree", name="Thoughts in Bedside interaction directions")

    def api(self, page, method, path, body=None, status=200, headers=None):
        response = page.request.fetch(path, method=method, data=body, headers={"origin": ORIGIN, **(headers or {})})
        self.assertEqual(response.status, status, response.text())
        return response.json() if response.text() else None

    def stored(self, page):
        return self.api(page, "GET", f"/api/v1/sketches/{self.sketch_id}")

    def pairs(self, page):
        return sorted((link["fromId"], link["toId"], link["label"]) for link in self.stored(page)["links"])

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
        """The tree item: the focusable row of one thought."""
        return page.locator(f'.sk-li-t[data-id="{self.thoughts[index]}"]')

    def pick(self, page, index):
        self.row(page, index).locator(".sk-outline-title").click()
        expect(self.row(page, index)).to_have_attribute("aria-selected", "true")

    def levels(self, page):
        return page.locator(".sk-li-t").evaluate_all("rows => Object.fromEntries(rows.map(row => [row.dataset.id, Number(row.getAttribute('aria-level')) - 1]))")

    def expected(self, levels):
        return {self.thoughts[index]: level for index, level in enumerate(levels)}

    def more(self, page, index):
        self.row(page, index).get_by_role("button", name="More actions", exact=True).click()
        return page.locator(f'li[data-id="{self.thoughts[index]}"] > .sk-outline-menu')

    def saved(self, page):
        expect(page.locator(".sk-status")).to_contain_text("Saved")

    def save(self, page):
        type(self).states["owner"] = page.context.storage_state()

    def add(self, page, text, parent_index=None):
        if parent_index is None:
            selected = page.locator('.sk-li-t[aria-selected="true"]')
            if selected.count():
                selected.first.focus()
                page.keyboard.press("Escape")
            page.get_by_role("toolbar", name="Sketch tools").get_by_role("button", name="Thought", exact=True).click()
        else:
            self.pick(page, parent_index)
            self.row(page, parent_index).get_by_role("button", name="Add a child thought", exact=True).click()
        editor = page.get_by_label("Thought text")
        editor.fill(text)
        editor.press("Enter")
        self.saved(page)
        return next(thought["id"] for thought in self.stored(page)["thoughts"] if thought["text"] == text)

    def connect(self, page, source_index, target_index):
        self.pick(page, source_index)
        self.more(page, source_index).get_by_role("button", name="Connect…", exact=True).click()
        self.row(page, target_index).locator(".sk-outline-title").click()
        expect(page.locator(".sk-status")).to_contain_text("Linked")
        self.saved(page)

    def test_01_the_list_is_the_maps_tree_with_also_under_and_reloads_the_same(self):
        page = self.page()
        self.open(page)
        for index, text in enumerate(LABELS):
            parent = index - 1 if index in (1, 2, 3, 4, 6) else None
            self.thoughts[index] = self.add(page, text, parent)
        self.assertEqual(self.levels(page), self.expected(CREATED), "a thought added under another is its child")
        for source, target in ((5, 3), (4, 5), (6, 3), (4, 6), (0, 4)):
            self.connect(page, source, target)
        expect(self.row(page, 4)).to_have_attribute("aria-level", "2")
        self.assertEqual(self.levels(page), self.expected(TREE), "each thought sits under its oldest parent on the map")
        # Every thought occurs once; its other parents are named, so no connection is lost from view.
        expect(page.locator(".sk-li-t")).to_have_count(8)
        expect(self.row(page, 3).locator(".sk-outline-also")).to_have_text(f"also under {LABELS[5]}, {LABELS[6]}")
        expect(self.row(page, 4).locator(".sk-outline-also")).to_have_text(f"also under {LABELS[3]}")
        expect(self.row(page, 6).locator(".sk-outline-also")).to_have_text(f"also under {LABELS[5]}")
        expect(self.row(page, 0).locator(".sk-outline-also")).to_have_count(0)
        # Screen readers get a tree with levels and folding.
        expect(self.row(page, 0)).to_have_attribute("aria-expanded", "true")
        expect(self.row(page, 7)).not_to_have_attribute("aria-expanded", re.compile("."))
        expect(self.tree(page).get_by_role("group").first).to_be_visible()
        type(self).baseline = self.stored(page)
        self.assertEqual(len(self.baseline["thoughts"]), 8)
        self.assertEqual(len(self.baseline["links"]), 10)
        for title, indices in (("Compare sensor trace and receiver code", (2, 4)), ("Test quiet hold without recording people", (4, 6))):
            self.api(page, "POST", f"/api/v1/projects/{self.project_id}/work", {"title": title, "sources": [{"type": "thought", "id": self.thoughts[index]} for index in indices]}, status=201)
        type(self).work_baseline = self.work(page)
        self.assertEqual(len(self.work_baseline["items"]), 2)
        page.reload()
        expect(self.row(page, 4)).to_be_visible()
        self.assertEqual(self.levels(page), self.expected(TREE))
        self.assertEqual(self.stored(page), self.baseline)
        self.save(page)
        # The tree comes from the map, not from this browser: a fresh browser shows the same structure.
        fresh = self.page(fresh=True)
        self.open(fresh)
        self.assertEqual(self.levels(fresh), self.expected(TREE))
        self.assertEqual(self.stored(fresh), self.baseline)

    def test_02_labels_tags_task_chips_dates_on_hover_and_actions_only_on_the_selected_row(self):
        page = self.page()
        self.open(page)
        link = next(item for item in self.baseline["links"] if item["fromId"] == self.thoughts[0] and item["toId"] == self.thoughts[1])
        self.api(page, "PATCH", f"/api/v1/sketches/{self.sketch_id}/links/{link['id']}", {"label": "problem", "expectedLabel": None}, headers={"idempotency-key": f"label-{STAMP}"})
        page.reload()
        show_map_as(page, "List")
        # AC-2: the connection's label is a small tag before the child's title, and part of its name.
        tag = self.row(page, 1).locator(".sk-outline-tag")
        expect(tag).to_have_text("problem")
        self.assertLess(tag.bounding_box()["x"], self.row(page, 1).locator(".sk-outline-title").bounding_box()["x"])
        expect(self.row(page, 1)).to_have_accessible_name(f"problem {LABELS[1]}")
        # AC-3: linked tasks are a chip at the row's end with a state glyph and number; it opens every task.
        chip = self.row(page, 4).locator(".sk-work")
        expect(chip).to_have_text(re.compile(r"^#\d+ Open \+1$"))
        expect(chip).to_have_accessible_name(f"2 tasks linked to “{LABELS[4][:47]}…”")
        self.assertGreater(chip.bounding_box()["x"], self.row(page, 4).locator(".sk-outline-title").bounding_box()["x"])
        chip.click()
        expect(page.get_by_role("dialog", name=LABELS[4], exact=True).get_by_role("link")).to_have_count(2)
        page.keyboard.press("Escape")
        # Dates show on hover or focus only, and keep their room so nothing moves when they appear.
        date = self.row(page, 7).locator(".sk-li-s")
        expect(date).to_have_css("opacity", "0")
        before = chip.bounding_box()
        self.row(page, 7).hover()
        expect(date).to_have_css("opacity", "1")
        self.row(page, 4).hover()
        self.assertEqual(chip.bounding_box(), before)
        page.mouse.move(5, 5)
        self.row(page, 7).focus()
        expect(date).to_have_css("opacity", "1")
        # AC-4: actions appear only on the selected row: Edit · + Child · Create task · ⋯.
        expect(page.locator(".sk-outline-actions")).to_have_count(0)
        tops = lambda: page.locator(".sk-li-t").evaluate_all("rows => rows.map(row => Math.round(row.getBoundingClientRect().top))")
        before_tops = tops()
        self.pick(page, 2)
        expect(page.locator(".sk-outline-actions")).to_have_count(1)
        # The selected row shows its actions where the date was (board A04), and no row below it moves.
        expect(self.row(page, 2).locator(".sk-li-s")).to_be_hidden()
        self.assertEqual(tops(), before_tops, "selecting a row moves nothing")
        names = self.row(page, 2).locator(".sk-outline-actions button").evaluate_all("buttons => buttons.map(b => b.getAttribute('aria-label') || b.textContent.trim())")
        self.assertEqual(names, ["Edit", "Add a child thought", "Create task from selected thoughts", "More actions"])
        menu = self.more(page, 2)
        expect(menu.get_by_role("button")).to_have_text(["IndentTab", "Outdent⇧Tab", "Move up⌥↑", "Move down⌥↓", "Connect…", "Connections", "Remove"])
        page.keyboard.press("Escape")
        shot(page, "map-outline-tree-1440-light")
        self.api(page, "PATCH", f"/api/v1/sketches/{self.sketch_id}/links/{link['id']}", {"label": None, "expectedLabel": "problem"}, headers={"idempotency-key": f"unlabel-{STAMP}"})
        self.wait_graph(page, lambda data: all(item["label"] is None for item in data["links"]))

    def test_03_folding_following_also_under_and_back_restore_the_place(self):
        page = self.page()
        self.open(page)
        before = self.stored(page)
        self.row(page, 1).get_by_role("button", name=re.compile("^Collapse ")).click()
        expect(self.row(page, 3)).to_have_count(0)
        self.pick(page, 4)
        self.row(page, 4).get_by_role("button", name=f"Also under {LABELS[3]}", exact=True).click()
        expect(self.row(page, 3)).to_be_focused()
        expect(self.row(page, 3)).to_have_attribute("aria-selected", "true")
        page.get_by_role("button", name=f"Back to “{LABELS[4][:47]}…”", exact=True).click()
        expect(self.row(page, 4)).to_be_focused()
        expect(self.row(page, 3)).to_have_count(0)
        self.assertEqual(self.stored(page), before)
        self.assertEqual(self.work(page), self.work_baseline, "many-to-many work links keep the exact thought IDs")
        # Keyboard: arrows move and select, Left folds or goes to the parent, Right unfolds or enters.
        self.row(page, 1).get_by_role("button", name=re.compile("^Expand ")).click()
        self.row(page, 0).focus()
        page.keyboard.press("ArrowDown")
        expect(self.row(page, 1)).to_be_focused()
        expect(self.row(page, 1)).to_have_attribute("aria-selected", "true")
        page.keyboard.press("ArrowRight")
        expect(self.row(page, 2)).to_be_focused()
        page.keyboard.press("ArrowLeft")
        expect(self.row(page, 2)).to_have_attribute("aria-expanded", "false")
        expect(self.row(page, 3)).to_have_count(0)
        page.keyboard.press("ArrowRight")
        expect(self.row(page, 3)).to_be_visible()
        page.keyboard.press("ArrowLeft")
        page.keyboard.press("ArrowLeft")
        expect(self.row(page, 1)).to_be_focused()
        page.keyboard.press("ArrowLeft")
        expect(self.row(page, 2)).to_have_count(0)
        expect(self.row(page, 1)).to_have_attribute("aria-expanded", "false")
        page.keyboard.press("ArrowRight")
        expect(self.row(page, 2)).to_be_visible()
        page.keyboard.press("End")
        expect(self.row(page, 7)).to_be_focused()
        page.keyboard.press("Home")
        expect(self.row(page, 0)).to_be_focused()
        self.row(page, 2).get_by_role("button", name=re.compile("^Expand ")).click()
        expect(self.row(page, 3)).to_be_visible()
        self.assertEqual(self.stored(page), before, "reading never writes the graph")
        self.save(page)

    def test_04_tab_and_shift_tab_move_the_connection_alt_arrows_reorder_and_undo_restores(self):
        page = self.page()
        self.open(page)
        baseline = self.pairs(page)
        tools = page.get_by_role("toolbar", name="Sketch tools")
        # Tab puts the selected thought under the one above it: on the map it is connected from there.
        self.pick(page, 7)
        self.row(page, 7).press("Tab")
        expect(self.row(page, 7)).to_have_attribute("aria-level", "2")
        expect(self.row(page, 7)).to_be_focused()
        self.saved(page)
        self.wait_graph(page, lambda data: any(l["fromId"] == self.thoughts[0] and l["toId"] == self.thoughts[7] for l in data["links"]))
        # Shift+Tab from the top branch takes it back out; its connection goes with it.
        self.row(page, 7).press("Shift+Tab")
        expect(self.row(page, 7)).to_have_attribute("aria-level", "1")
        self.wait_graph(page, lambda data: sorted((l["fromId"], l["toId"], l["label"]) for l in data["links"]) == baseline)
        # The first child has nothing above it to go under.
        self.pick(page, 2)
        self.row(page, 2).press("Tab")
        expect(page.locator(".sk-status")).to_contain_text("Nothing above")
        expect(self.row(page, 2)).to_have_attribute("aria-level", "3")
        # A thought with two parents goes under the one above it; the connection there is reused.
        self.pick(page, 6)
        self.row(page, 6).press("Tab")
        expect(self.row(page, 6)).to_have_attribute("aria-level", "4")
        expect(self.row(page, 6).locator(".sk-outline-also")).to_have_count(0)
        self.saved(page)
        moved = self.wait_graph(page, lambda data: not any(l["fromId"] == self.thoughts[4] and l["toId"] == self.thoughts[6] for l in data["links"]))
        self.assertTrue(any(l["fromId"] == self.thoughts[5] and l["toId"] == self.thoughts[6] for l in moved["links"]))
        self.assertEqual(len(moved["thoughts"]), 8, "indenting changes connections only")
        tools.get_by_role("button", name="Undo", exact=True).click()
        expect(self.row(page, 6)).to_have_attribute("aria-level", "3")
        expect(self.row(page, 6).locator(".sk-outline-also")).to_have_text(f"also under {LABELS[5]}")
        self.wait_graph(page, lambda data: sorted((l["fromId"], l["toId"], l["label"]) for l in data["links"]) == baseline)
        # Shift+Tab one level out: under the grandparent, after its parent.
        self.pick(page, 5)
        self.row(page, 5).press("Shift+Tab")
        expect(self.row(page, 5)).to_have_attribute("aria-level", "2")
        self.saved(page)
        tools.get_by_role("button", name="Undo", exact=True).click()
        expect(self.row(page, 5)).to_have_attribute("aria-level", "3")
        self.wait_graph(page, lambda data: sorted((l["fromId"], l["toId"], l["label"]) for l in data["links"]) == baseline)
        # A thought with another parent that would keep it under that parent is not moved at all: the status line says so (#554 review).
        self.pick(page, 4)
        self.row(page, 4).press("Shift+Tab")
        expect(page.locator(".sk-status")).to_contain_text("is also under")
        expect(page.locator(".sk-status")).to_contain_text("Use Connections")
        expect(self.row(page, 4)).to_have_attribute("aria-level", "2")
        self.assertEqual(self.pairs(page), baseline, "nothing was sent")
        # ⌥↑/⌥↓ change only this person's reading order among siblings; the map is unchanged.
        before = self.stored(page)
        order = lambda: page.locator(f'li[data-id="{self.thoughts[0]}"] > ul > li').evaluate_all("items => items.map(item => item.dataset.id)")
        self.assertEqual(order(), [self.thoughts[1], self.thoughts[4]])
        self.pick(page, 4)
        self.row(page, 4).press("Alt+ArrowUp")
        expect(self.row(page, 4)).to_be_focused()
        self.assertEqual(order(), [self.thoughts[4], self.thoughts[1]])
        self.row(page, 4).press("Alt+ArrowUp")
        expect(page.locator(".sk-status")).to_contain_text("already first")
        page.reload()
        show_map_as(page, "List")
        self.assertEqual(order(), [self.thoughts[4], self.thoughts[1]], "the reading order is remembered")
        self.pick(page, 4)
        self.row(page, 4).press("Alt+ArrowDown")
        self.assertEqual(order(), [self.thoughts[1], self.thoughts[4]])
        self.assertEqual(self.stored(page), before)
        # Escape clears the selection; Tab then leaves the row instead of indenting it.
        self.row(page, 4).press("Escape")
        expect(self.row(page, 4)).to_have_attribute("aria-selected", "false")
        self.row(page, 4).press("Tab")
        expect(self.row(page, 4)).not_to_be_focused()
        self.assertEqual(self.pairs(page), baseline)
        self.save(page)

    def test_05_enter_space_rename_delete_graph_undo_and_search_reveal_preserve_exact_ids(self):
        page = self.page()
        self.open(page)
        original = self.stored(page)
        # Space opens a thought; a renamed parent updates every "also under" that names it.
        self.row(page, 5).focus()
        page.keyboard.press("Space")
        renamed = LABELS[5] + " · after nine"
        page.get_by_label("Thought text").fill(renamed)
        page.get_by_label("Thought text").press("Enter")
        self.saved(page)
        expect(self.row(page, 3).locator(".sk-outline-also")).to_contain_text(renamed)
        expect(self.row(page, 6).locator(".sk-outline-also")).to_contain_text(renamed)
        # Enter adds a new thought beside the focused one (here at the top level); Undo removes it.
        self.row(page, 7).focus()
        page.keyboard.press("Enter")
        editor = page.get_by_role("form", name="New thought draft").get_by_label("Thought text")
        editor.fill("A new top-level direction")
        editor.press("Enter")
        self.saved(page)
        added = page.locator(".sk-li-t", has_text="A new top-level direction")
        expect(added).to_have_attribute("aria-level", "1")
        page.get_by_role("toolbar", name="Sketch tools").get_by_role("button", name="Undo", exact=True).click()
        expect(added).to_have_count(0)
        self.wait_graph(page, lambda data: len(data["thoughts"]) == 8)
        # Delete and graph Undo restore the exact thought and connection IDs, and so the same tree.
        self.row(page, 2).focus()
        page.keyboard.press("Delete")
        self.saved(page)
        expect(self.row(page, 2)).to_have_count(0)
        self.assertEqual(self.row(page, 3).get_attribute("aria-level"), "4", "its child now sits under its oldest other parent")
        self.wait_graph(page, lambda data: all(thought["id"] != self.thoughts[2] for thought in data["thoughts"]))
        page.get_by_role("toolbar", name="Sketch tools").get_by_role("button", name="Undo", exact=True).click()
        expect(page.locator(".sk-status")).to_contain_text("Undid: removed a thought")
        expected_links = {link["id"] for link in original["links"]}
        restored = self.wait_graph(page, lambda data: any(thought["id"] == self.thoughts[2] for thought in data["thoughts"]) and {link["id"] for link in data["links"]} == expected_links)
        expect(self.row(page, 2)).to_be_visible()
        self.assertEqual(self.levels(page), self.expected(TREE))
        self.assertEqual({item["id"] for item in restored["thoughts"]}, {item["id"] for item in original["thoughts"]})
        self.row(page, 5).focus()
        page.keyboard.press("F2")
        page.get_by_label("Thought text").fill(LABELS[5])
        page.get_by_label("Thought text").press("Enter")
        self.saved(page)
        self.wait_graph(page, lambda data: next(thought["text"] for thought in data["thoughts"] if thought["id"] == self.thoughts[5]) == LABELS[5])
        # Search reveals a folded destination; the selection is shared with the Map.
        self.row(page, 1).get_by_role("button", name=re.compile("^Collapse ")).click()
        page.goto(f"/projects/{self.project_id}/map/{self.sketch_id}#thought-{self.thoughts[3]}")
        expect(self.row(page, 3)).to_be_focused()
        expect(self.row(page, 3)).to_have_attribute("aria-selected", "true")
        before = self.stored(page)
        show_map_as(page, "Map")
        expect(page.locator(f'.sk-node[data-id="{self.thoughts[3]}"]')).to_have_attribute("aria-pressed", "true")
        show_map_as(page, "List")
        self.assertEqual(self.row(page, 3).get_attribute("aria-level"), "4")
        # Exercise the real router arrival contract used by LiveProvider without a fake SFU.
        self.row(page, 0).get_by_role("button", name=re.compile("^Collapse ")).click()
        page.evaluate("""ids => {
            history.pushState({usr: {liveSelect: ids, liveFollow: true}, key: 'outline-live-arrival', idx: (history.state?.idx ?? 0) + 1}, '', location.pathname);
            dispatchEvent(new PopStateEvent('popstate'));
        }""", [self.thoughts[3], self.thoughts[6], "00000000-0000-4000-8000-000000000000"])
        expect(self.row(page, 3)).to_be_focused()
        expect(self.row(page, 3)).to_have_attribute("aria-selected", "true")
        expect(self.row(page, 6)).to_have_attribute("aria-selected", "true")
        expect(page.locator('.sk-li-t[aria-selected="true"]')).to_have_count(2)
        self.assertEqual(self.stored(page), before)
        self.save(page)

    def test_06_viewer_reads_the_same_tree_without_graph_actions_and_private_placement_stays_restricted(self):
        owner = self.page()
        data = self.api(owner, "POST", f"/api/v1/sketches/{self.sketch_id}/thoughts", {"text": "Compare calibration notes without sharing the private source", "x": 0, "y": 300, "placement": {"type": "draft", "id": self.private_draft}, "linkFrom": {"thoughtId": self.thoughts[0]}}, status=201)
        placed_id = data["thought"]["id"]
        viewer = self.page("viewer")
        self.open(viewer)
        expect(viewer.get_by_role("toolbar", name="Sketch tools")).to_have_count(0)
        expect(self.tree(viewer)).not_to_contain_text("PRIVATE CALIBRATION NOTES")
        placed = viewer.locator(f'.sk-li-t[data-id="{placed_id}"]')
        expect(placed).to_contain_text("Draft you can’t open")
        expect(placed).to_have_attribute("aria-level", "2")
        levels = self.levels(viewer)
        self.assertEqual({key: value for key, value in levels.items() if key != placed_id}, self.expected(TREE), "the viewer sees the same tree")
        before = self.stored(viewer)
        self.pick(viewer, 1)
        expect(self.row(viewer, 1).get_by_role("button", name="Edit", exact=True)).to_have_count(0)
        expect(self.row(viewer, 1).get_by_role("button", name="Add a child thought", exact=True)).to_have_count(0)
        expect(self.more(viewer, 1).get_by_role("button")).to_have_text(["Move up⌥↑", "Move down⌥↓", "Connections"])
        self.row(viewer, 1).focus()
        for key in ("Enter", "Space", "+", "Delete", "Tab"):
            self.row(viewer, 1).press(key)
            self.row(viewer, 1).focus()
        expect(viewer.get_by_label("Thought text")).to_have_count(0)
        self.assertEqual(self.stored(viewer), before)
        raw = viewer.evaluate("localStorage.getItem('flux.sketch.outlines.v1')")
        self.assertNotIn("PRIVATE", raw)
        self.assertNotIn(LABELS[0], raw)
        self.api(owner, "POST", f"/api/v1/projects/{self.project_id}/grants", {"principal": {"kind": "human", "id": self.ids["viewer"]}, "role": "denied"}, status=201)
        self.api(viewer, "GET", f"/api/v1/sketches/{self.sketch_id}", status=404)
        viewer.goto(f"/map/{self.sketch_id}")
        expect(viewer.get_by_role("heading", name="This sketch isn’t available")).to_be_visible()
        expect(viewer.locator("body")).not_to_contain_text(LABELS[4])

    def test_07_render_matched_light_dark_phone_tablet_and_enlarged_text(self):
        measurements = []
        for scheme in ("Light", "Dark"):
            page = self.page()
            self.open(page)
            page.locator(".me__btn").click()
            pop = page.get_by_role("dialog", name="Account", exact=True)
            pop.get_by_role("radio", name=scheme, exact=True).click()
            page.keyboard.press("Escape")
            self.pick(page, 3)
            for selector in ('.sk-outline-title', '.sk-outline-also button', '.sk-outline-actions button', '.sk-outline-keys'):
                page.wait_for_function("selector => { const node = document.querySelector(selector); if (!node) return false; for (let el = node; el; el = el.parentElement) if (Number(getComputedStyle(el).opacity) !== 1) return false; return true; }", arg=selector)
                measured = page.evaluate(MEASURE, {"selector": selector})
                measurements.append({"theme": scheme, **measured})
                self.assertGreaterEqual(measured["ratio"], 4.5, f"{scheme} {selector} actual composite contrast")
            shot(page, f"map-outline-{scheme.lower()}-desktop-1440")
        if SHOTS:
            (SHOTS / "map-outline-contrast.json").write_text(json.dumps(measurements, indent=2) + "\n")
        for scheme in ("light", "dark"):
            page = self.page()
            page.emulate_media(color_scheme=scheme)
            self.open(page)
            self.pick(page, 3)
            for name, viewport in (("desktop-1440", DESKTOP), ("desktop-2560", {"width": 2560, "height": 1440}), ("tablet-820", {"width": 820, "height": 1180}), ("phone-390", PHONE)):
                page.set_viewport_size(viewport)
                # The phone has its own List page: wait for the layout of this width before measuring.
                page.wait_for_function("() => (innerWidth <= 640) === !document.querySelector('.sk-page--list')")
                expect(self.row(page, 3)).to_be_visible()
                self.row(page, 3).scroll_into_view_if_needed()
                shot(page, f"map-outline-{scheme}-{name}")
                self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), viewport["width"], "no horizontal document overflow")
                title = self.row(page, 3).locator(".sk-outline-title").bounding_box()
                self.assertGreater(title["width"], 190 if viewport["width"] == 390 else 300, "deep indentation leaves readable content")
            page.set_viewport_size(PHONE)
            page.add_style_tag(content=":root { --fs-xs: 24px !important; --fs-sm: 26px !important; --fs-md: 28px !important; --fs-base: 30px !important; --fs-lg: 34px !important; --fs-xl: 40px !important; --fs-2xl: 48px !important; }")
            self.assertEqual(self.row(page, 3).locator(".sk-outline-title").evaluate("node => getComputedStyle(node).fontSize"), "28px", "actual row text is enlarged")
            self.row(page, 3).scroll_into_view_if_needed()
            shot(page, f"map-outline-{scheme}-phone-enlarged")
            self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), PHONE["width"])
        touch = self.page(viewport=PHONE, is_mobile=True, has_touch=True)
        self.open(touch)
        self.row(touch, 1).get_by_role("button", name=re.compile("^Collapse ")).tap()
        self.row(touch, 4).locator(".sk-outline-title").tap()
        self.row(touch, 4).get_by_role("button", name=f"Also under {LABELS[3]}", exact=True).tap()
        expect(self.row(touch, 3)).to_have_attribute("aria-selected", "true")
        expect(self.row(touch, 3)).to_be_focused()
        expect(self.row(touch, 3)).to_be_in_viewport(ratio=1)
        back = touch.get_by_role("button", name=f"Back to “{LABELS[4][:47]}…”", exact=True)
        self.assertGreaterEqual(back.bounding_box()["y"], 0)
        self.assertLess(back.bounding_box()["y"], PHONE["height"], "the return action stays in the phone viewport")
        self.assertGreaterEqual(back.bounding_box()["height"], 44)
        shot(touch, "map-outline-phone-also-under-back")
        back.tap()
        expect(self.row(touch, 3)).to_have_count(0)

    def test_08_unavailable_and_corrupt_storage_keep_the_tree_and_this_visit_useful(self):
        blocked = self.page(fresh=True)
        blocked.add_init_script("Storage.prototype.getItem = () => { throw new DOMException('Blocked', 'SecurityError'); }; Storage.prototype.setItem = () => { throw new DOMException('Blocked', 'SecurityError'); };")
        self.open(blocked)
        before = self.stored(blocked)
        current = self.levels(blocked)
        self.assertEqual(current[self.thoughts[3]], 3, "the tree comes from the map even without storage")
        order = lambda page: page.locator(f'li[data-id="{self.thoughts[0]}"] > ul > li').evaluate_all("items => items.map(item => item.dataset.id)")
        first = order(blocked)
        self.pick(blocked, 4)
        self.row(blocked, 4).press("Alt+ArrowUp")
        self.assertNotEqual(order(blocked), first, "reordering works for this visit")
        blocked.reload()
        show_map_as(blocked, "List")
        self.assertEqual(order(blocked), first, "without storage the order is not kept after a reload")
        self.assertEqual(self.levels(blocked), current)
        self.assertEqual(self.stored(blocked), before)
        corrupt = self.page()
        corrupt.add_init_script("localStorage.setItem('flux.sketch.outlines.v1', '{bad cached title');")
        self.open(corrupt)
        self.assertEqual(self.levels(corrupt), current)
        self.assertEqual(self.stored(corrupt), before)


if __name__ == "__main__":
    unittest.main()
