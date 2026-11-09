"""My map: a selected thought offers "Move to a space map" and "Copy link" (#948, guide "My map").

Ada has My map with a few thoughts and two spaces: Community garden sensors, whose map Jonas has open, and Rain barrel monitor, which has no map yet.
From a thought's actions she chooses a space and its map, and the thought goes there with Undo; a space with no map gets one made as the thought
arrives; Jonas sees it arrive on the map he has open; the thought's link opens My map with it selected. The server side (permissions, versions,
connections, placement) is `tests/app/sketch-move-to-map.test.ts`; this module is what a person sees and does, on a computer and on a phone.
Screenshots go to FLUX_UI_SCREENSHOT_DIR when it is set.
"""
from __future__ import annotations

import json
import re
import unittest
import uuid

from playwright.sync_api import Page, expect, sync_playwright

from light_motion_fixture import ready, settled
from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, shot, start_forwarder
from test_work_pagination import api

PASSWORD = "moving a thought to the garden"
TEXTS = {"a": "Rain sensor on the shed roof?", "b": "Solar panel for the probe gateway?", "c": "Bulb planting day with the school"}


class MyMapMove(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=10000)
        cls.stamp = uuid.uuid4().hex[:8]
        cls.contexts = {}
        cls.ids = {}
        for key, name in (("ada", "Ada Kowalska"), ("jonas", "Jonas Berg")):
            context = cls.browser.new_context(base_url=ORIGIN, service_workers="block")
            api(context, "POST", "/api/auth/sign-up/email", {"name": name, "email": f"move-{key}-{cls.stamp}@example.test", "password": PASSWORD})
            cls.ids[key] = api(context, "GET", "/api/v1/me")["user"]["id"]
            cls.contexts[key] = context
        ada, jonas = cls.contexts["ada"], cls.contexts["jonas"]
        cls.workspace = api(ada, "POST", "/api/v1/workspaces", {"name": "Garden co-op"}, 201)["id"]
        api(ada, "POST", f"/api/v1/workspaces/{cls.workspace}/members", {"email": f"move-jonas-{cls.stamp}@example.test", "role": "member"}, 201)
        cls.garden = api(ada, "POST", f"/api/v1/workspaces/{cls.workspace}/projects", {"name": "Community garden sensors", "visibility": "restricted"}, 201)["id"]
        cls.barrel = api(ada, "POST", f"/api/v1/workspaces/{cls.workspace}/projects", {"name": "Rain barrel monitor", "visibility": "restricted"}, 201)["id"]
        api(ada, "POST", f"/api/v1/projects/{cls.garden}/grants", {"principal": {"kind": "human", "id": cls.ids["jonas"]}, "role": "contributor"}, 201)
        cls.garden_map = api(ada, "POST", f"/api/v1/workspaces/{cls.workspace}/sketches", {"title": "Garden ideas", "scope": "project", "projectId": cls.garden}, 201)["id"]
        api(ada, "POST", f"/api/v1/sketches/{cls.garden_map}/thoughts", {"text": "Probes at two depths", "x": 40, "y": 40}, 201)
        cls.states = {key: context.storage_state() for key, context in cls.contexts.items()}

    @classmethod
    def tearDownClass(cls):
        for context in cls.contexts.values():
            context.close()
        cls.browser.close()
        cls.pw.stop()

    # ------------------------------------------------------------------ helpers
    def mine(self) -> dict:
        """My map made fresh for one test, with three thoughts and two connections: a to b, and b to c."""
        ada = self.contexts["ada"]
        # One private map for each person: earlier tests' thoughts are removed, so every test starts from the same three.
        listed = api(ada, "GET", f"/api/v1/workspaces/{self.workspace}/sketches?scope=private&limit=100")["items"]
        sketch = listed[0] if listed else api(ada, "POST", f"/api/v1/workspaces/{self.workspace}/sketches", {"title": "My map", "scope": "private"}, 201)
        detail = api(ada, "GET", f"/api/v1/sketches/{sketch['id']}")
        for thought in detail["thoughts"]:
            removed = ada.request.fetch(f"{ORIGIN}/api/v1/sketches/{sketch['id']}/thoughts/{thought['id']}", method="DELETE",
                                        headers={"origin": ORIGIN, "if-match": f'"{thought["version"]}"'})
            assert removed.status == 204, removed.text()
        made = {key: api(ada, "POST", f"/api/v1/sketches/{sketch['id']}/thoughts", {"text": text, "x": 120 + 300 * index, "y": 80 + 140 * (index % 2)}, 201)["thought"]
                for index, (key, text) in enumerate(TEXTS.items())}
        api(ada, "POST", f"/api/v1/sketches/{sketch['id']}/links", {"fromId": made["a"]["id"], "toId": made["b"]["id"], "label": "powers"}, 201)
        api(ada, "POST", f"/api/v1/sketches/{sketch['id']}/links", {"fromId": made["b"]["id"], "toId": made["c"]["id"]}, 201)
        return {"id": sketch["id"], "thoughts": made}

    def page(self, who: str = "ada", *, phone: bool = False, permissions: bool = False) -> Page:
        options = {"base_url": ORIGIN, "storage_state": self.states[who], "locale": "en-GB", "timezone_id": "Europe/Warsaw", "service_workers": "block",
                   "viewport": PHONE if phone else DESKTOP}
        if phone:
            options.update(is_mobile=True, has_touch=True, device_scale_factor=2)
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        if permissions:
            context.grant_permissions(["clipboard-read", "clipboard-write"], origin=ORIGIN)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught browser errors"))
        return page

    def sketch(self, sketch_id: str) -> dict:
        return api(self.contexts["ada"], "GET", f"/api/v1/sketches/{sketch_id}")

    def texts(self, sketch_id: str) -> list[str]:
        return sorted(thought["text"] for thought in self.sketch(sketch_id)["thoughts"])

    def open_mine(self, page: Page, mine: dict) -> None:
        page.goto(f"/map/{mine['id']}")
        ready(page)
        expect(page.locator(".sk-node", has_text=TEXTS["a"])).to_be_visible()
        settled(page)

    def select(self, page: Page, key: str, *, touch: bool = False) -> None:
        node = page.locator(".sk-node", has_text=TEXTS[key])
        node.tap() if touch else node.click()
        expect(node).to_have_attribute("aria-pressed", "true")

    def choose(self, page: Page, label: str, option: str) -> None:
        dialog = page.get_by_role("dialog", name="Move to a space map")
        dialog.get_by_role("combobox", name=label, exact=True).click()
        page.get_by_role("option", name=option, exact=True).click()

    # ------------------------------------------------------------------ the computer
    def test_01_a_selected_thought_offers_move_and_copy_link_and_goes_to_a_space_map_with_undo(self):
        mine = self.mine()
        page = self.page()
        self.open_mine(page, mine)
        self.select(page, "a")
        bar = page.get_by_role("toolbar", name="Selection actions")
        expect(bar.get_by_role("button", name="Move to a space map")).to_be_visible()
        expect(bar.get_by_role("button", name="Copy link")).to_be_visible()
        shot(page, "my-map-move-selected")
        bar.get_by_role("button", name="Move to a space map").click()
        dialog = page.get_by_role("dialog", name="Move to a space map")
        expect(dialog).to_be_visible()
        expect(dialog).to_contain_text(TEXTS["a"])
        expect(dialog).to_contain_text("Its connection to a thought that stays on My map is left behind.")
        move = dialog.get_by_role("button", name="Move", exact=True)
        expect(move).to_be_disabled()
        self.choose(page, "Space", "Community garden sensors")
        expect(dialog.get_by_role("combobox", name="Map", exact=True)).to_contain_text("Garden ideas")
        expect(move).to_be_enabled()
        shot(page, "my-map-move-window")
        move.click()
        expect(dialog).to_have_count(0)
        toast = page.locator(".ui-toast")
        expect(toast).to_contain_text("Moved to Community garden sensors")
        # It left My map (and its connection to b stayed behind), and it is on the space's map.
        expect(page.locator(".sk-node", has_text=TEXTS["a"])).to_have_count(0)
        self.assertEqual(self.texts(mine["id"]), sorted([TEXTS["b"], TEXTS["c"]]))
        self.assertEqual(len(self.sketch(mine["id"])["links"]), 1, "the connection to the thought that moved went with the original")
        self.assertEqual(self.texts(self.garden_map), sorted(["Probes at two depths", TEXTS["a"]]))
        moved = next(thought for thought in self.sketch(self.garden_map)["thoughts"] if thought["text"] == TEXTS["a"])
        self.assertEqual((moved["shape"], moved["width"], moved["height"]), (mine["thoughts"]["a"]["shape"], mine["thoughts"]["a"]["width"], mine["thoughts"]["a"]["height"]))
        shot(page, "my-map-move-done")
        # Undo brings it back to where it was, with its connection to b.
        toast.get_by_role("button", name="Undo").click()
        expect(page.locator(".sk-node", has_text=TEXTS["a"])).to_be_visible()
        self.assertEqual(self.texts(self.garden_map), ["Probes at two depths"])
        back = self.sketch(mine["id"])
        again = next(thought for thought in back["thoughts"] if thought["text"] == TEXTS["a"])
        self.assertEqual((again["x"], again["y"]), (mine["thoughts"]["a"]["x"], mine["thoughts"]["a"]["y"]), "back where it was")
        self.assertEqual(len(back["links"]), 2, "and connected to b again")
        self.assertTrue(any({link["fromId"], link["toId"]} == {again["id"], mine["thoughts"]["b"]["id"]} and link["label"] == "powers" for link in back["links"]))

    def test_02_a_space_with_no_map_gets_one_as_the_thought_arrives_and_a_group_keeps_its_connection(self):
        mine = self.mine()
        page = self.page()
        self.open_mine(page, mine)
        self.select(page, "a")
        page.locator(".sk-node", has_text=TEXTS["b"]).click(modifiers=["Shift"])
        page.get_by_role("toolbar", name="Selection actions").get_by_role("button", name="Move to a space map").click()
        dialog = page.get_by_role("dialog", name="Move to a space map")
        expect(dialog).to_contain_text("2 thoughts")
        expect(dialog).to_contain_text("Its connection to a thought that stays on My map is left behind.")
        self.choose(page, "Space", "Rain barrel monitor")
        expect(dialog).to_contain_text("Rain barrel monitor has no map yet. One is made for this thought.")
        dialog.get_by_role("button", name="Move", exact=True).click()
        expect(page.locator(".ui-toast")).to_contain_text("Moved to Rain barrel monitor")
        made = api(self.contexts["ada"], "GET", f"/api/v1/workspaces/{self.workspace}/sketches?projectId={self.barrel}")["items"]
        self.assertEqual(len(made), 1, "the space's first map")
        arrived = self.sketch(made[0]["id"])
        self.assertEqual(sorted(thought["text"] for thought in arrived["thoughts"]), sorted([TEXTS["a"], TEXTS["b"]]))
        self.assertEqual(len(arrived["links"]), 1, "the connection between the two went along")
        self.assertEqual(self.texts(mine["id"]), [TEXTS["c"]])

    def test_03_the_other_person_sees_the_thought_arrive_on_the_map_they_have_open(self):
        mine = self.mine()
        jonas = self.page("jonas")
        jonas.goto(f"/projects/{self.garden}/map/{self.garden_map}")
        ready(jonas)
        expect(jonas.locator(".sk-node", has_text="Probes at two depths")).to_be_visible()
        page = self.page()
        self.open_mine(page, mine)
        self.select(page, "c")
        page.get_by_role("toolbar", name="Selection actions").get_by_role("button", name="Move to a space map").click()
        self.choose(page, "Space", "Community garden sensors")
        page.get_by_role("dialog", name="Move to a space map").get_by_role("button", name="Move", exact=True).click()
        expect(page.locator(".ui-toast")).to_contain_text("Moved to Community garden sensors")
        expect(jonas.locator(".sk-node", has_text=TEXTS["c"])).to_be_visible()
        shot(jonas, "my-map-move-arrived")
        # And away again: Undo makes it vanish from the map Jonas has open.
        page.locator(".ui-toast").get_by_role("button", name="Undo").click()
        expect(jonas.locator(".sk-node", has_text=TEXTS["c"])).to_have_count(0)
        expect(page.locator(".sk-node", has_text=TEXTS["c"])).to_be_visible()

    def test_04_copy_link_copies_the_address_that_opens_my_map_with_the_thought_selected(self):
        mine = self.mine()
        page = self.page(permissions=True)
        self.open_mine(page, mine)
        self.select(page, "b")
        page.get_by_role("toolbar", name="Selection actions").get_by_role("button", name="Copy link").click()
        expect(page.locator(".ui-toast")).to_contain_text("Link copied")
        link = page.evaluate("navigator.clipboard.readText()")
        self.assertEqual(link, f"{ORIGIN}/map/{mine['id']}#thought-{mine['thoughts']['b']['id']}")
        opened = self.page()
        opened.goto(link)
        ready(opened)
        expect(opened.locator(".sk-node", has_text=TEXTS["b"])).to_have_attribute("aria-pressed", "true")
        # Only the owner can open it: someone else gets no map.
        other = self.page("jonas")
        other.goto(link)
        ready(other)
        expect(other.get_by_text("This map isn’t available")).to_be_visible()

    def test_05_the_list_offers_both_from_a_rows_more_actions_and_the_window_says_what_went_wrong(self):
        mine = self.mine()
        page = self.page()
        self.open_mine(page, mine)
        page.get_by_role("radio", name="List", exact=True).click()
        row = page.locator(".sk-li-t", has_text=TEXTS["c"])
        row.click()
        row.get_by_role("button", name="More actions").click()
        menu = page.get_by_role("group", name=re.compile("^More actions for"))
        expect(menu.get_by_role("button", name="Copy link")).to_be_visible()
        menu.get_by_role("button", name="Move to a space map").click()
        dialog = page.get_by_role("dialog", name="Move to a space map")
        self.choose(page, "Space", "Community garden sensors")
        # The thought changes on another screen before the move: nothing moves and the window says so.
        ada = self.contexts["ada"]
        current = self.sketch(mine["id"])["thoughts"]
        stale = next(thought for thought in current if thought["text"] == TEXTS["c"])
        ada.request.fetch(f"{ORIGIN}/api/v1/sketches/{mine['id']}/thoughts/{stale['id']}", method="PATCH",
                          headers={"origin": ORIGIN, "content-type": "application/json", "if-match": f'"{stale["version"]}"'}, data=json.dumps({"text": TEXTS["c"] + " (edited)"}))
        dialog.get_by_role("button", name="Move", exact=True).click()
        expect(dialog.get_by_role("alert")).to_contain_text("changed meanwhile")
        self.assertIn(TEXTS["c"] + " (edited)", self.texts(mine["id"]))
        dialog.get_by_role("button", name="Cancel").click()
        expect(dialog).to_have_count(0)

    # ------------------------------------------------------------------ the phone
    def test_06_on_a_phone_the_thought_actions_sheet_offers_both_and_the_window_is_a_sheet(self):
        mine = self.mine()
        page = self.page(phone=True, permissions=True)
        self.open_mine(page, mine)
        self.select(page, "a", touch=True)
        page.get_by_role("button", name="Thought actions").tap()
        sheet = page.get_by_role("dialog", name="Thought actions")
        expect(sheet.get_by_role("button", name="Copy link")).to_be_visible()
        shot(page, "my-map-move-phone-actions")
        sheet.get_by_role("button", name="Move to a space map").tap()
        dialog = page.get_by_role("dialog", name="Move to a space map")
        expect(dialog).to_be_visible()
        box = dialog.bounding_box()
        self.assertGreaterEqual(box["y"] + box["height"], PHONE["height"] - 2, "a sheet from the bottom edge")
        self.assertLessEqual(box["width"], PHONE["width"], "it fits the phone")
        dialog.get_by_role("combobox", name="Space", exact=True).tap()
        page.get_by_role("option", name="Community garden sensors", exact=True).tap()
        shot(page, "my-map-move-phone-window")
        dialog.get_by_role("button", name="Move", exact=True).tap()
        expect(page.locator(".ui-toast")).to_contain_text("Moved to Community garden sensors")
        expect(page.locator(".sk-node", has_text=TEXTS["a"])).to_have_count(0)
        self.assertIn(TEXTS["a"], self.texts(self.garden_map))
        self.assertEqual(page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), True, "no sideways scroll")


if __name__ == "__main__":
    unittest.main()
