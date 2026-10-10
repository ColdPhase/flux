"""Browser tests for sketches bound to a direct message (issue #96).

Runs with the other tests/ui modules through scripts/check_ui.sh against the running Compose
application. Ada owns the workspace, Jo is an admin, Kai and Mo are members. Jo and Kai talk in a
1:1 DM. Jo selects two of its messages and starts a sketch from them; Kai opens it from the DM's
Sketches tab; Mo (outside the DM) cannot; the phone layout keeps the selection bar usable; Jo
makes a project from the sketch after an exact audience preview, and later DM messages do not
reach the copy; when Kai leaves, Kai loses the sketch at once and Jo's becomes read-only. Every
step is checked against the API. Screenshots (dm-sketch-*.png) go to FLUX_UI_SCREENSHOTS when set.
"""

from __future__ import annotations

import json
import os
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, box, shot, start_forwarder

PASSWORD = "sketching in private"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ada": ("Ada Nowak", f"ada.n+{STAMP}@example.test", None),
    "jo": ("Jo Lindqvist", f"jo.l+{STAMP}@example.test", "admin"),
    "kai": ("Kai Lind", f"kai.l+{STAMP}@example.test", "member"),
    "mo": ("Mo Haddad", f"mo.h+{STAMP}@example.test", "member"),
}
MESSAGES = [
    ("kai", "Weekend idea: a desk lamp you control with gestures. Swipe to dim, hold your palm over it to switch it off."),
    ("jo", "Love it. Camera and hand tracking? A tiny OpenMV board could run that."),
    ("kai", "A camera worries me for a bedside lamp. Maybe a ToF distance sensor?"),
    ("jo", "Unrelated: are you coming to Mira's on Saturday?"),
]


class DmSketchJourney(unittest.TestCase):
    """Tests run in name order and share the accounts, the DM and its sketch."""

    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}
    workspace_id = ""
    dm_id = ""
    message_ids: list[str] = []
    sketch_id = ""
    copy_path = ""

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, os.environ.get("FLUX_UI_BROWSER", "chromium")).launch()
        expect.set_options(timeout=10000)
        contexts: dict[str, BrowserContext] = {}
        for key, (name, email, _) in PEOPLE.items():
            context = cls.browser.new_context(base_url=ORIGIN)
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.states[key] = context.storage_state()
            contexts[key] = context

        def post(who: str, path: str, body: dict):
            response = contexts[who].request.post(path, data=body, headers={"origin": ORIGIN})
            assert response.status in (200, 201), response.text()
            return response.json()

        cls.workspace_id = post("ada", "/api/v1/workspaces", {"name": "Lamp makers"})["id"]
        for key, (_, email, role) in PEOPLE.items():
            if role:
                post("ada", f"/api/v1/workspaces/{cls.workspace_id}/members", {"email": email, "role": role})
        cls.dm_id = post("jo", f"/api/v1/workspaces/{cls.workspace_id}/dms", {"participantIds": [cls.ids["kai"]]})["id"]
        cls.message_ids = [post(who, f"/api/v1/dms/{cls.dm_id}/messages", {"body": body, "clientMessageId": str(uuid.uuid4())})["id"] for who, body in MESSAGES]
        for context in contexts.values():
            context.close()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, who: str, *, phone: bool = False) -> Page:
        options: dict = {"base_url": ORIGIN, "locale": "en-GB", "timezone_id": "Europe/Warsaw", "storage_state": self.states[who]}
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=DESKTOP, device_scale_factor=1)
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def api(self, page: Page, path: str) -> tuple[int, dict]:
        response = page.request.get(path)
        return response.status, (json.loads(response.text()) if response.text() else {})

    def message(self, page: Page, index: int):
        return page.locator(f'.dm-msg[data-message-id="{self.message_ids[index]}"]')

    # ---------------------------------------------------------------- start from messages

    def test_01_select_messages_and_start_a_sketch(self) -> None:
        page = self.page("jo")
        page.goto(f"/dm/{self.dm_id}")
        expect(page.locator(".dm-msg__body", has_text="gestures")).to_be_visible()
        select = page.get_by_role("button", name="Select", exact=True)
        select.click()
        expect(select).to_have_attribute("aria-pressed", "true")
        bar = page.get_by_role("region", name="Selected messages")
        expect(bar.get_by_role("status")).to_have_text("Choose the messages to sketch from")
        expect(bar).to_contain_text("only you and Kai can see it. No project is created.")
        expect(page.get_by_label(re.compile(r"^Message "))).to_be_hidden()
        # Pointer: a whole row toggles. Keyboard: the check is a button, Space toggles it.
        self.message(page, 0).locator(".dm-msg__body").click()
        check = self.message(page, 2).get_by_role("button", name=re.compile(r"^Select Kai Lind’s message"))
        check.focus()
        page.keyboard.press("Space")
        expect(check).to_have_attribute("aria-pressed", "true")
        expect(bar.get_by_role("status")).to_have_text("2 messages selected")
        expect(self.message(page, 0)).to_have_class(re.compile(r"is-picked"))
        shot(page, "dm-sketch-select")
        # Esc cancels without starting anything.
        page.keyboard.press("Escape")
        expect(bar).to_be_hidden()
        expect(select).to_be_focused()
        select.click()
        self.message(page, 0).locator(".dm-msg__body").click()
        self.message(page, 2).locator(".dm-msg__body").click()
        bar.get_by_role("button", name="Start sketch from these messages").click()

        page.wait_for_url(re.compile(rf"/dm/{self.dm_id}/sketches/[0-9a-f-]{{36}}$"))
        type(self).sketch_id = page.url.rsplit("/", 1)[-1]
        expect(page.get_by_label("Sketch name")).to_be_focused()
        page.keyboard.press("Escape")  # keep the proposed name
        expect(page.get_by_label("Sketch name")).to_have_count(0)
        expect(page.locator(".sk-status")).to_contain_text("Started from 2 messages · only you and Kai can see it")
        expect(page.locator(".sk-aud")).to_contain_text("Only you and Kai, in this direct message")
        expect(page.get_by_role("navigation", name="Direct message views").get_by_role("link", name=re.compile(r"^Sketches"))).to_contain_text("1")
        nodes = page.locator(".sk-node")
        expect(nodes).to_have_count(2)
        expect(nodes.first).to_contain_text("Message from Kai")
        shot(page, "dm-sketch-map")

        status, sketch = self.api(page, f"/api/v1/sketches/{self.sketch_id}")
        self.assertEqual(status, 200)
        self.assertEqual((sketch["scope"], sketch["dmId"], sketch["projectId"]), ("dm", self.dm_id, None))
        self.assertEqual([t["source"]["dmMessageId"] for t in sketch["thoughts"]], [self.message_ids[0], self.message_ids[2]])
        self.assertEqual({t["source"]["author"]["id"] for t in sketch["thoughts"]}, {self.ids["kai"]})

    def test_02_the_other_participant_opens_it_and_outsiders_cannot(self) -> None:
        kai = self.page("kai")
        kai.goto(f"/dm/{self.dm_id}")
        kai.get_by_role("navigation", name="Direct message views").get_by_role("link", name=re.compile(r"^Sketches")).click()
        expect(kai).to_have_url(re.compile(rf"/dm/{self.dm_id}/sketches$"))
        expect(kai.get_by_text("can see these. They stay in this conversation.")).to_be_visible()
        kai.get_by_role("link", name=re.compile(r"^From 2 messages")).click()
        expect(kai.locator(".sk-node")).to_have_count(2)
        # Kai can change it: add a connected thought.
        kai.locator(".sk-node").first.click()
        kai.get_by_role("toolbar", name="Sketch tools").get_by_role("button", name="Thought", exact=True).click()
        editor = kai.get_by_label("Thought text")
        expect(editor).to_be_focused()
        editor.fill("60 GHz radar sees through the shade")
        editor.press("Enter")
        expect(kai.locator(".sk-node", has_text="60 GHz radar")).to_be_visible()
        expect(kai.locator(".sk-status")).to_contain_text("Saved")

        mo = self.page("mo")
        mo.goto(f"/dm/{self.dm_id}/sketches/{self.sketch_id}")
        expect(mo.get_by_role("heading", name="This sketch isn’t available")).to_be_visible()
        expect(mo.get_by_text("gestures")).to_have_count(0)
        status, _ = self.api(mo, f"/api/v1/sketches/{self.sketch_id}")
        self.assertEqual(status, 404)
        status, listed = self.api(mo, f"/api/v1/workspaces/{self.workspace_id}/sketches?dmId={self.dm_id}")
        self.assertEqual((status, listed["total"]), (200, 0))
        ada = self.page("ada")
        status, _ = self.api(ada, f"/api/v1/sketches/{self.sketch_id}")
        self.assertEqual(status, 404, "the workspace owner outside the DM gets 404")

    def test_03_phone_selection_bar(self) -> None:
        page = self.page("kai", phone=True)
        page.goto(f"/dm/{self.dm_id}")
        select = page.get_by_role("button", name="Select", exact=True)
        select.tap()
        self.message(page, 1).locator(".dm-msg__body").tap()
        bar = page.get_by_role("region", name="Selected messages")
        expect(bar.get_by_role("status")).to_have_text("1 message selected")
        start = bar.get_by_role("button", name="Start sketch from these messages")
        expect(start).to_be_visible()
        # Measure once the checks and the bar have finished scaling in.
        page.evaluate("Promise.all(document.getAnimations().map((a) => a.finished))")
        for target in (start, bar.get_by_role("button", name="Cancel"), self.message(page, 1).locator(".dm-msel")):
            size = box(page, target)
            self.assertGreaterEqual(min(size["width"], size["height"]), 44, "44 px touch targets")
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), PHONE["width"], "no horizontal scrolling")
        shot(page, "dm-sketch-phone-select")
        bar.get_by_role("button", name="Cancel").tap()
        expect(bar).to_be_hidden()

    # ---------------------------------------------------------------- make it a project

    def test_04_make_a_project_after_an_exact_preview(self) -> None:
        page = self.page("jo")
        page.goto(f"/dm/{self.dm_id}/sketches/{self.sketch_id}")
        page.get_by_role("button", name="Make it a project…").click()
        panel = page.locator("#details")
        expect(panel.get_by_role("heading", name="Make a project from this sketch")).to_be_visible()
        # Nobody from the conversation joins unless Jo chooses it (#188): the preview names who would.
        expect(panel.locator(".promote__aud b")).to_have_text("Ada and you — only you two")
        grant = panel.get_by_role("checkbox", name="Also give Kai access")
        expect(grant).not_to_be_checked()
        grant.check()
        expect(panel.locator(".promote__aud b")).to_have_text("You, Kai and Ada")
        expect(panel.locator(".promote__aud")).to_contain_text("Ada manages every project in this workspace")
        expect(panel).to_contain_text("3 thoughts, with their 1 link")
        expect(panel).to_contain_text("2 thoughts started from messages keep who wrote them and when")
        expect(panel).to_contain_text("The other 2 messages of the conversation, and everything written there later. Nothing is synced to the project.")
        status, preview = self.api(page, f"/api/v1/sketches/{self.sketch_id}/promotion?target=new")
        self.assertEqual({p["id"] for p in preview["audience"]}, {self.ids["jo"], self.ids["kai"], self.ids["ada"]})
        shot(page, "dm-sketch-promote")
        panel.get_by_label("Name").fill("Gesture lamp")
        panel.get_by_role("button", name="Create project").click()

        page.wait_for_url(re.compile(r"/projects/[0-9a-f-]{36}/map/[0-9a-f-]{36}$"))
        type(self).copy_path = page.url.split(ORIGIN, 1)[-1]
        project_id, copy_id = re.findall(r"[0-9a-f-]{36}", self.copy_path)
        expect(page.locator(".top__title h1")).to_have_text("Gesture lamp")
        expect(page.locator(".sk-origin")).to_contain_text("Copied from a direct message by you")
        expect(page.locator(".sk-node")).to_have_count(3)
        status, people = self.api(page, f"/api/v1/projects/{project_id}/people")
        self.assertEqual({p["id"] for p in people}, {p["id"] for p in preview["audience"]}, "the preview named exactly the readers")
        status, project = self.api(page, f"/api/v1/projects/{project_id}")
        self.assertEqual(project["visibility"], "restricted")
        mo = self.page("mo")
        self.assertEqual(self.api(mo, f"/api/v1/sketches/{copy_id}")[0], 404, "a member outside the DM cannot open the copy")
        shot(page, "dm-sketch-copied")

        # The DM sketch notes the copy; later DM messages never reach the project.
        page.goto(f"/dm/{self.dm_id}/sketches/{self.sketch_id}")
        expect(page.locator(".sk-copies")).to_contain_text("Copied to Gesture lamp")
        page.request.post(f"/api/v1/dms/{self.dm_id}/messages", data={"body": "One more lamp thought, later", "clientMessageId": str(uuid.uuid4())}, headers={"origin": ORIGIN})
        _, copy = self.api(page, f"/api/v1/sketches/{copy_id}")
        self.assertEqual(len(copy["thoughts"]), 3)
        self.assertNotIn(self.dm_id, json.dumps(copy))
        self.assertTrue(all(t["source"] is None or t["source"]["dmMessageId"] is None for t in copy["thoughts"]))

    def test_04c_phone_maps_keep_the_room_for_the_map(self) -> None:
        """The DM map and the project copy at 390x844: one compact header, one line of context, one row of tools."""
        page = self.page("jo", phone=True)
        for label, path in (("dm", f"/dm/{self.dm_id}/sketches/{self.sketch_id}"), ("copied", self.copy_path)):
            page.goto(path)
            canvas = page.locator(".sk-canvas")
            expect(canvas).to_be_visible()
            top = canvas.bounding_box()["y"]
            # Before this review the copied map started at about 508 px of 844. The sketch's own chrome
            # (header, context line, tools) is what this surface controls; the shell above it is shared.
            chrome = top - page.locator(".sk").bounding_box()["y"]
            print(f"PHONE-MAP {label}: canvas top {top:.0f}px, sketch chrome {chrome:.0f}px", flush=True)
            shot(page, f"dm-sketch-phone-{label}")
            self.assertLessEqual(top, 440, f"{label}: the map starts near the upper half of the screen (at {top:.0f}px)")
            self.assertLessEqual(chrome, 300, f"{label}: the sketch's own header, context and tools stay compact ({chrome:.0f}px)")
            # S15: no toolbar row on the phone; the map views and adds, and says where to connect.
            expect(page.get_by_role("toolbar", name="Sketch tools")).to_have_count(0)
            add = page.get_by_role("button", name="Add a thought", exact=True)
            expect(add).to_be_visible()
            self.assertGreaterEqual(add.bounding_box()["height"], 43.5, f"{label}: Add a thought is a touch target")
            expect(page.get_by_text("Connect and arrange on a computer")).to_be_visible()
            page.locator(".sk-node").first.tap()
            page.get_by_role("button", name="Thought actions", exact=True).tap()
            actions = page.get_by_role("dialog", name="Thought actions", exact=True)
            expect(actions.get_by_role("button", name="Remove from sketch", exact=True)).to_be_visible()
            for name in ("Connect", "Change shape", "Undo"):
                expect(actions.get_by_role("button", name=name, exact=True)).to_have_count(0)
            self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), PHONE["width"], f"{label}: no horizontal scrolling")
            actions.get_by_role("button", name="Close thought actions", exact=True).tap()
            shot(page, f"dm-sketch-phone-{label}")
        # The copy still says where it came from and that the conversation stays private.
        expect(page.locator(".sk-origin")).to_contain_text("Copied from a direct message by you")
        expect(page.locator(".sk-origin")).to_contain_text("the conversation stays private")

    def test_04b_search_finds_the_dm_sketch_and_opens_it_in_the_dm(self) -> None:
        page = self.page("jo")
        # "60 GHz radar sees through the shade" is Kai's thought in the DM sketch; its copy lives in Gesture lamp.
        page.goto(f"/search?q=shade&place=dm:{self.dm_id}")
        results = page.get_by_role("list", name="Results")
        expect(results.get_by_role("link")).to_have_count(1)
        expect(results).to_contain_text("60 GHz radar")
        expect(results).to_contain_text("Kai Lind")
        results.get_by_role("link").first.click()
        expect(page).to_have_url(re.compile(rf"/dm/{self.dm_id}/sketches/{self.sketch_id}#thought-[0-9a-f-]{{36}}$"))
        expect(page.locator(".sk-aud")).to_contain_text("in this direct message")
        # Across every place: the DM thought and the project copy, each opening where it lives.
        page.goto("/search?q=shade")
        expect(results.get_by_role("link")).to_have_count(2)
        hrefs = sorted(results.get_by_role("link").evaluate_all("(links) => links.map((a) => a.getAttribute('href'))"))
        self.assertTrue(any(h.startswith(f"/dm/{self.dm_id}/sketches/{self.sketch_id}#thought-") for h in hrefs), hrefs)
        self.assertTrue(any(h.startswith(f"{self.copy_path.split('/map/')[0]}/map/") or h.startswith("/map/") for h in hrefs if not h.startswith("/dm/")), hrefs)
        # Mo is outside the DM and the project: nothing, not even a count.
        mo = self.page("mo")
        mo.goto("/search?q=shade")
        expect(mo.get_by_role("heading", name="Nothing matches “shade”")).to_be_visible()
        self.assertNotIn("radar", mo.content())
        shot(page, "dm-sketch-search")

    # ---------------------------------------------------------------- leaving

    def test_05_leaving_ends_access_and_the_sketch_turns_read_only(self) -> None:
        kai = self.page("kai")
        kai.goto(f"/dm/{self.dm_id}/sketches/{self.sketch_id}")
        expect(kai.locator(".sk-node")).to_have_count(3)
        left = kai.request.post(f"/api/v1/dms/{self.dm_id}/leave", headers={"origin": ORIGIN})
        self.assertEqual(left.status, 204)
        kai.reload()
        expect(kai.get_by_role("heading", name=re.compile(r"isn’t available"))).to_be_visible()
        self.assertEqual(self.api(kai, f"/api/v1/sketches/{self.sketch_id}")[0], 404)

        jo = self.page("jo")
        jo.goto(f"/dm/{self.dm_id}/sketches/{self.sketch_id}")
        expect(jo.locator(".sk-readonly")).to_contain_text("read-only until the other person reopens it")
        expect(jo.get_by_role("button", name="Make it a project…")).to_have_count(0)
        expect(jo.get_by_role("toolbar", name="Sketch tools")).to_have_count(0)
        jo.goto(f"/dm/{self.dm_id}")
        expect(jo.locator(".dm__notice")).to_contain_text("left this conversation")
        expect(jo.get_by_role("button", name="Select", exact=True)).to_have_count(0)
        shot(jo, "dm-sketch-left")


if __name__ == "__main__":
    unittest.main()
