"""Round 15 of the v0.2.1 release gate, the work screens (the task and decision panels, the Board, the map, the Wiki, saved sources).

Runs with the other tests/ui journeys through scripts/check_ui.sh against the running Compose application, in the engine
FLUX_UI_BROWSER names. Two people, one space with tasks (one blocked on Ada with a long reason, one of Ada's own with a due day), a proposed
decision with a discussion longer than the panel, a saved source and Wiki pages. Each test is one P2 of round 15 (REPORT.md, sections new,
look-1 and look-3) and fails on the commit before its fix:

- look-1 P2-1, look-3 F2: the phone's sheet of a blocked task scrolled to show the "Waiting for" card and put the title under its header.
- look-1 P2-2, look-3 F3: at 200 % a decision's panel opened at the end of its discussion, its title 341 px above the view.
- look-3 F1: beside the open panel, an own card with a due day read "#11 Due 25 Nov AK (you)" and "(you)" ran past the card.
- look-3 F4: at 200 % the selected thought's actions lay under the map's header, Edit and Connect hidden.
- look-3 F5: a saved source (a Wiki page by its own address) was not in the space's Wiki page switcher, and its page named no space.
- new P2-4: the Wiki's current version by its address read "You are reading a saved version" instead of opening the page.
"""

from __future__ import annotations

import json
import os
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

ENGINE = os.environ.get("FLUX_UI_BROWSER", "chromium")
PASSWORD = "round fifteen work screens"
STAMP = int(time.time() * 1000)
ADA = {"name": "Ada Kowalska", "email": f"ada.r15+{STAMP}@example.test"}
JONAS = {"name": "Jonas Berg", "email": f"jonas.r15+{STAMP}@example.test"}
DECISION = "Borrow two sensors from the school instead of buying more"
WHY = "It saves 36 EUR, and the school has spare ESP32 kits."
BLOCKED = "Waterproof the gateway box"
REASON = "Ada to choose the seals: rubber or silicone, both fit the box, and the rubber ones are cheaper but crack in frost"
DUE_TASK = "Write down how to replace a probe so any volunteer can do it without asking Jonas or Ada first"
SOURCE = "Supplier price list, winter 2026"
NOTES = [
    "I put the first probe in bed 2, it reads 41 %, which matches the hand meter within two points.",
    "Bed 3 reads 38 %, close enough. The cable is a bit short, so I zip-tied it to the frame for now.",
    "Bed 4 reads 12 %, something is off there: either the probe is half out of the soil or the soil is really that dry.",
    "The soil in bed 4 is dry on top but wet 10 cm down, so the probe is too shallow. I will push it in further.",
    "Pushed it in, now 33 %. Still lower than the others, but the bed gets the afternoon sun.",
    "Let us leave bed 4 as it is and compare again after the weekend rain.",
]

# Where an element stands in the panel's scroller (negative top: above the view).
PLACE = """([scrollSel, sel]) => {
  const scroller = document.querySelector(scrollSel); const el = scroller.querySelector(sel);
  const room = scroller.getBoundingClientRect(); const box = el.getBoundingClientRect();
  return { top: Math.round(box.top - room.top), bottom: Math.round(room.bottom - box.bottom), scrollTop: scroller.scrollTop };
}"""

# The owner of a card: the name's visible width, and how far "(you)" and the face reach past the card's inner edge.
CARD_OWNER = """(card) => {
  const inner = card.getBoundingClientRect(); const pad = parseFloat(getComputedStyle(card).paddingRight) || 0;
  const name = card.querySelector('.tb-card__name .ui-name__n'); const mark = card.querySelector('.tb-card__name .ui-name__m');
  return { name: Math.round(name.getBoundingClientRect().width), past: Math.round(mark.getBoundingClientRect().right - (inner.right - pad)) };
}"""

# The element under the middle of `sel` is that element (or inside it): nothing floats over it.
ON_TOP = """(sel) => { const el = document.querySelector(sel); if (!el) return 'missing';
  const box = el.getBoundingClientRect(); const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  return hit && (el === hit || el.contains(hit)) ? 'on top' : `covered by ${hit ? hit.className || hit.tagName : 'nothing'}`; }"""


class Round15Work(unittest.TestCase):
    """Tests run in name order and share two accounts and one space."""

    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, ENGINE).launch()
        print("\nActual round-15 work engine: " + cls.browser.browser_type.name)
        expect.set_options(timeout=8000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def context(self, who: str | None, *, phone: bool = False, zoom: int = 1) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "locale": "en-GB", "timezone_id": "Europe/Warsaw", "service_workers": "block"}
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=ENGINE == "chromium", has_touch=True)
        else:
            # 200 % text on a 1440 × 900 window: the page lays out at half the width and height, each CSS pixel two device pixels.
            options.update(viewport={"width": DESKTOP["width"] // zoom, "height": DESKTOP["height"] // zoom}, device_scale_factor=zoom)
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
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers={"origin": ORIGIN, "content-type": "application/json", **(headers or {})},
                                      data=json.dumps(body) if body is not None else None)
        if status is not None:
            self.assertEqual(response.status, status, response.text())
        return json.loads(response.text()) if response.text() else {}

    # ---------------------------------------------------------------- the data

    def test_01_a_space_with_a_blocked_task_a_due_day_a_discussed_decision_and_a_saved_source(self) -> None:
        for key, person in (("ada", ADA), ("jonas", JONAS)):
            page = self.page(None)
            page.goto("/sign-up")
            page.get_by_label("Name").fill(person["name"])
            page.get_by_label("Email").fill(person["email"])
            page.get_by_label("Password").fill(PASSWORD)
            page.get_by_role("button", name="Create account").click()
            expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
            type(self).states[key] = page.context.storage_state()
            person["id"] = self.api(page, "GET", "/api/v1/me", status=200)["user"]["id"]
        ada = self.page("ada")
        jonas = self.page("jonas")
        ws = self.api(ada, "POST", "/api/v1/workspaces", {"name": "Garden makers"}, status=201)
        self.api(ada, "POST", f"/api/v1/workspaces/{ws['id']}/members", {"email": JONAS["email"], "role": "member"}, status=201)
        pid = self.api(ada, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Community garden sensors", "visibility": "restricted"}, status=201)["id"]
        self.api(ada, "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": JONAS["id"]}, "role": "contributor"}, status=201)
        human = lambda person: {"kind": "human", "id": person["id"]}  # noqa: E731
        base = f"/api/v1/projects/{pid}/work"
        for title in ("Order six capacitive moisture probes", "Check the battery levels on all six sensors"):
            self.api(ada, "POST", base, {"title": title, "owner": human(ADA)}, status=201)
        self.api(ada, "POST", base, {"title": DUE_TASK, "owner": human(ADA), "dueOn": "2026-11-25"}, status=201)
        blocked = self.api(jonas, "POST", base, {"title": BLOCKED, "status": "blocked", "blocker": REASON, "waitingFor": human(ADA), "owner": human(JONAS)}, status=201)
        decision = self.api(jonas, "POST", f"/api/v1/projects/{pid}/decisions", {"title": DECISION, "rationale": WHY}, status=201)
        for index, note in enumerate(NOTES):
            self.api(ada if index % 2 else jonas, "POST", f"/api/v1/decisions/{decision['id']}/discussion", {"body": note, "clientMessageId": str(uuid.uuid4())}, status=201)
        doc = self.api(ada, "POST", f"/api/v1/projects/{pid}/docs", {"title": "Sensor placement", "body": "One probe per raised bed.\nEach probe 10 cm deep.\n"}, status=201)
        source = self.api(ada, "POST", f"/api/v1/projects/{pid}/materials", {"clientMutationId": str(uuid.uuid4()), "title": SOURCE,
                                                                            "body": "Capacitive probe: 2.90 EUR\nDS18B20: 1.90 EUR\n"}, status=201)
        type(self).ids = {"project": pid, "blocked": blocked["id"], "decision": decision["id"], "doc": doc["id"], "source": source["materialId"]}

    # ---------------------------------------------------------------- look-1 P2-1, look-3 F2

    def test_02_the_phone_sheet_of_a_blocked_task_keeps_its_title_and_shows_what_it_waits_for(self) -> None:
        page = self.page("ada", phone=True)
        page.goto(f"/projects/{self.ids['project']}/tasks?open=work:{self.ids['blocked']}")
        sheet = page.locator("#details")
        expect(sheet.locator(".wd-blocker")).to_be_visible()
        page.wait_for_timeout(800)
        title = page.evaluate(PLACE, ["#details .wd__scroll", ".details__title"])
        self.assertGreaterEqual(title["top"], 0, f"the task's title is in view, not under the sheet's header: {title}")
        blocker = page.evaluate(PLACE, ["#details .wd__scroll", ".wd-blocker"])
        self.assertGreaterEqual(blocker["bottom"], 0, f"the Waiting for card is whole in the half sheet: {blocker}")
        expect(sheet.locator(".wd-blocker").get_by_role("button", name="Done", exact=True)).to_be_in_viewport()
        shot(page, f"r15-phone-blocked-open-{ENGINE}")

    # ---------------------------------------------------------------- look-1 P2-2, look-3 F3

    def test_03_at_200_percent_a_decision_opens_on_its_title_and_answer(self) -> None:
        page = self.page("ada", zoom=2)
        page.goto(f"/projects/{self.ids['project']}?open=decision:{self.ids['decision']}")
        panel = page.locator("#details")
        expect(panel.locator(".wd-discussion__list > li")).to_have_count(len(NOTES))
        page.wait_for_timeout(800)
        title = page.evaluate(PLACE, ["#details .wd__scroll", ".wd-decision-identity .details__title"])
        self.assertGreaterEqual(title["top"], 0, f"the decision's title is in view: {title}")
        expect(panel.get_by_text(WHY)).to_be_in_viewport()
        expect(panel.get_by_role("button", name="Accept", exact=True)).to_be_in_viewport()
        shot(page, f"r15-z200-decision-open-{ENGINE}")
        # The cursor in the field brings the newest message into view.
        panel.get_by_placeholder("Write about this decision…").click()
        page.wait_for_timeout(300)
        newest = page.evaluate(PLACE, ["#details .wd__scroll", ".wd-discussion__list > li:last-child"])
        self.assertGreaterEqual(newest["bottom"], -1, f"the newest message is in view once the cursor is in the field: {newest}")

    # ---------------------------------------------------------------- look-3 F1

    def test_04_beside_the_open_panel_a_card_with_a_due_day_keeps_its_owner_inside(self) -> None:
        page = self.page("ada")
        page.goto(f"/projects/{self.ids['project']}/tasks")
        expect(page.locator(".tb-board")).to_be_visible()
        page.locator(".tb-card").filter(has_text="Check the battery levels").locator(".tb-card__open").click()
        expect(page.locator("#details .wd--task")).to_be_visible()
        page.wait_for_timeout(500)
        card = page.locator(".tb-card").filter(has_text=DUE_TASK)
        expect(card.locator(".tb-card__due")).to_have_text("Due 25 Nov")
        expect(card.locator(".tb-card__name")).to_have_text(f"{ADA['name']} (you)")
        owner = card.evaluate(CARD_OWNER)
        self.assertLessEqual(owner["past"], 0, f"(you) stays inside the card: {owner}")
        self.assertGreaterEqual(owner["name"], 20, f"some of the name shows, never only the face and (you): {owner}")
        shot(page, f"r15-board-due-you-{ENGINE}")

    # ---------------------------------------------------------------- look-3 F4

    def test_05_at_200_percent_a_new_thoughts_actions_are_not_under_the_map_header(self) -> None:
        page = self.page("ada", zoom=2)
        page.goto(f"/projects/{self.ids['project']}/map")
        page.get_by_role("toolbar", name="Map tools").get_by_role("button", name="Thought", exact=True).click()
        draft = page.get_by_role("form", name="New thought draft").get_by_label("Thought text")
        draft.fill("Overflow pipe needs a mesh")
        draft.press("Enter")
        node = page.locator(".sk-node").filter(has_text="Overflow pipe needs a mesh")
        expect(node).to_have_count(1)
        if node.get_attribute("aria-pressed") != "true":
            node.click()
        expect(node).to_have_attribute("aria-pressed", "true")
        bar = page.get_by_role("toolbar", name="Selection actions")
        expect(bar).to_be_visible()
        page.wait_for_timeout(500)
        edit = bar.get_by_role("button", name=re.compile("^Edit "))
        edit.evaluate("el => el.setAttribute('data-r15-edit', '')")
        self.assertEqual(page.evaluate(ON_TOP, "[data-r15-edit]"), "on top", "Edit is not under the map's header")
        shot(page, f"r15-z200-map-selected-{ENGINE}")

    # ---------------------------------------------------------------- look-3 F5

    def test_06_a_saved_source_is_a_page_of_its_spaces_wiki(self) -> None:
        page = self.page("ada")
        page.goto(f"/projects/{self.ids['project']}/docs/{self.ids['doc']}")
        page.locator(".wiki-switch").click()
        pages = page.get_by_role("dialog", name=re.compile("^Pages in ")).get_by_role("list", name="Pages")
        row = pages.get_by_role("link", name=SOURCE)
        expect(row).to_have_attribute("href", f"/materials/{self.ids['source']}")
        row.click()
        expect(page.get_by_role("heading", name=SOURCE)).to_be_visible()
        expect(page.get_by_role("link", name="Community garden sensors · Wiki")).to_have_attribute("href", f"/projects/{self.ids['project']}/docs")
        shot(page, f"r15-source-page-{ENGINE}")

    # ---------------------------------------------------------------- new P2-4

    def test_07_the_current_version_by_its_address_opens_the_page(self) -> None:
        page = self.page("ada")
        page.goto(f"/projects/{self.ids['project']}/docs/{self.ids['doc']}/versions/1")
        expect(page).to_have_url(re.compile(rf"/projects/{self.ids['project']}/docs/{self.ids['doc']}$"))
        expect(page.get_by_text("You are reading a saved version")).to_have_count(0)
        expect(page.locator(".doc-notice--version")).to_have_count(0)


if __name__ == "__main__":
    unittest.main()
