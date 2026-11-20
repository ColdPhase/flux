"""Round 15 of the v0.2.1 release gate, the work screens (the task and decision panels, the Board, the map, the Wiki, saved sources).

Runs with the other tests/ui journeys through scripts/check_ui.sh against the running Compose application, in the engine
FLUX_UI_BROWSER names. Two people, one space with tasks (one blocked on Ada with a long reason, one of Ada's own with a due day), a proposed
decision with a discussion longer than the panel, a saved source and Wiki pages. Each test is one P2 of round 15 (REPORT.md, sections new,
look-1 and look-3) and fails on the commit before its fix:

- look-1 P2-1, look-3 F2: the phone's sheet of a blocked task scrolled to show the "Waiting for" card and put the title under its header.
- look-1 P2-2, look-3 F3: at 200 % a decision's panel opened at the end of its discussion, its title 341 px above the view.
- look-3 F1: beside the open panel, an own card with a due day read "#11 Due 25 Nov AK (you)" and "(you)" ran past the card.
- look-3 F4: at 200 % the selected thought's actions lay under the map's header, Edit and Connect hidden.
- look-3 F5: a saved source was not in the space's Wiki page switcher, and its page named no space (since #1508 it is an ordinary page).
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
REASON = "Ada to choose the seals: rubber or silicone, both fit the box"
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

    def context(self, who: str | None, *, phone: bool = False, zoom: int = 1, scheme: str = "light") -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "locale": "en-GB", "timezone_id": "Europe/Warsaw", "service_workers": "block", "color_scheme": scheme}
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
        long_task = self.api(ada, "POST", base, {"title": "Calibrate the probes in the raised beds", "status": "in_progress", "owner": human(ADA)}, status=201)
        for index, note in enumerate(NOTES):
            self.api(ada if index % 2 else jonas, "POST", f"/api/v1/decisions/{decision['id']}/discussion", {"body": note, "clientMessageId": str(uuid.uuid4())}, status=201)
            self.api(ada if index % 2 else jonas, "POST", f"/api/v1/work/{long_task['id']}/discussion", {"body": note, "clientMessageId": str(uuid.uuid4())}, status=201)
        doc = self.api(ada, "POST", f"/api/v1/projects/{pid}/docs", {"title": "Sensor placement", "body": "One probe per raised bed.\nEach probe 10 cm deep.\n"}, status=201)
        source = self.api(ada, "POST", f"/api/v1/projects/{pid}/docs", {"title": SOURCE,
                                                                            "body": "Capacitive probe: 2.90 EUR\nDS18B20: 1.90 EUR\n"}, status=201)
        type(self).ids = {"project": pid, "long": long_task["id"], "blocked": blocked["id"], "decision": decision["id"], "doc": doc["id"], "source": source["id"]}

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
        # A task's panel opens the same way.
        page.goto(f"/projects/{self.ids['project']}/tasks?open=work:{self.ids['long']}")
        expect(panel.locator(".wd-act .wd-act__item--message")).to_have_count(len(NOTES))
        page.wait_for_timeout(800)
        title = page.evaluate(PLACE, ["#details .wd__scroll", ".details__title"])
        self.assertGreaterEqual(title["top"], 0, f"the task's title is in view: {title}")

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
        """#1508: a saved source is an ordinary page of its space's Wiki: in the page switcher with the others, opened as a page."""
        page = self.page("ada")
        page.goto(f"/projects/{self.ids['project']}/docs/{self.ids['doc']}")
        page.locator(".wiki-switch").click()
        pages = page.get_by_role("dialog", name=re.compile("^Pages in ")).get_by_role("list", name="Pages")
        row = pages.get_by_role("link", name=SOURCE)
        expect(row).to_have_attribute("href", f"/projects/{self.ids['project']}/docs/{self.ids['source']}")
        row.click()
        expect(page).to_have_url(re.compile(rf"/projects/{self.ids['project']}/docs/{self.ids['source']}$"))
        expect(page.locator(".wiki-title")).to_contain_text(SOURCE)
        expect(page.get_by_role("heading", level=1)).to_have_text("Community garden sensors")
        views = page.locator("nav[aria-label='Space views']")
        expect(views.get_by_role("tab")).to_have_text(["Conversation", "Tasks", "Map", "Wiki"])
        expect(views.get_by_role("tab", name="Wiki")).to_have_attribute("aria-current", "page")
        expect(page.locator(".wiki-source")).to_have_count(0)
        shot(page, f"r15-source-page-{ENGINE}")

    # ---------------------------------------------------------------- new P2-4

    def test_07_the_current_version_by_its_address_opens_the_page(self) -> None:
        page = self.page("ada")
        page.goto(f"/projects/{self.ids['project']}/docs/{self.ids['doc']}/versions/1")
        expect(page).to_have_url(re.compile(rf"/projects/{self.ids['project']}/docs/{self.ids['doc']}$"))
        expect(page.get_by_text("You are reading a saved version")).to_have_count(0)
        expect(page.locator(".doc-notice--version")).to_have_count(0)

    # ---------------------------------------------------------------- v0.2.2 (#1563)

    def test_08_a_saved_source_by_its_id_alone_goes_to_its_page_and_shows_its_link(self) -> None:
        """A citation carries a page by its id alone (`/materials/:id`): it opens the page in its space's Wiki, the current version as the page
        itself. A page that was a saved source of v0.2.1 keeps the link it was saved with under its text (#1508); no API writes one, so the
        page's read is given one here."""
        page = self.page("ada")
        page.goto(f"/materials/{self.ids['source']}")
        expect(page).to_have_url(re.compile(rf"/projects/{self.ids['project']}/docs/{self.ids['source']}$"))
        expect(page.get_by_role("heading", level=1)).to_have_text("Community garden sensors")
        expect(page.locator("nav[aria-label='Space views']").get_by_role("tab", name="Wiki")).to_have_attribute("aria-current", "page")
        phone = self.page("ada", phone=True)
        phone.goto(f"/materials/{self.ids['source']}/versions/1")
        expect(phone).to_have_url(re.compile(rf"/projects/{self.ids['project']}/docs/{self.ids['source']}$"))
        expect(phone.locator("nav[aria-label='Space views']").get_by_role("tab", name="Wiki")).to_have_attribute("aria-current", "page")
        shot(phone, f"r15-source-page-phone-{ENGINE}")
        link = "https://example.com/supplier-price-list-winter-2026"

        def with_link(route) -> None:
            response = route.fetch()
            body = response.json()
            body["url"] = link
            route.fulfill(response=response, json=body)

        for is_phone, scheme in ((False, "light"), (False, "dark"), (True, "light"), (True, "dark")):
            linked = self.page("ada", phone=is_phone, scheme=scheme)
            linked.route(f"**/api/v1/docs/{self.ids['source']}", with_link)
            linked.goto(f"/materials/{self.ids['source']}")
            expect(linked.locator(".wiki-title")).to_contain_text(SOURCE)
            source_link = linked.get_by_role("link", name="Open source link")
            expect(source_link).to_have_attribute("href", link)
            expect(source_link).to_have_attribute("target", "_blank")
            shot(linked, f"v022-source-page-{'phone' if is_phone else 'computer'}-{scheme}-{ENGINE}")

    def test_09_a_space_row_says_what_was_said_last_and_when_as_a_conversation_row_does(self) -> None:
        jonas = self.page("jonas")
        self.api(jonas, "POST", f"/api/v1/projects/{self.ids['project']}/conversations",
                 {"body": "The supplier lowered the **probe price**, see the new list.", "clientMessageId": str(uuid.uuid4())}, status=201)
        setup = self.page("ada")
        workspace_id = self.api(setup, "GET", f"/api/v1/projects/{self.ids['project']}", status=200)["workspaceId"]
        quiet = self.api(setup, "POST", f"/api/v1/workspaces/{workspace_id}/projects", {"name": "Quiet bench", "visibility": "workspace"}, status=201)
        for phone, scheme in ((False, "light"), (True, "light"), (False, "dark"), (True, "dark")):
            with self.subTest(phone=phone, scheme=scheme):
                page = self.page("ada", phone=phone, scheme=scheme)
                page.goto("/projects")
                row = page.locator(f"li.proj-index__row[data-space-id='{self.ids['project']}']")
                expect(row.locator(".set-row__s")).to_have_text("Jonas: The supplier lowered the probe price, see the new list.")
                expect(row.locator("time.proj-index__time")).to_have_count(1)
                # The row's name for a screen reader is the space, its states, then what was said (never "undefined. …").
                expect(row.locator("a.set-row")).to_have_attribute("aria-label", re.compile(r"^Community garden sensors[^.]*\. Jonas: The supplier lowered"))
                box = row.locator(".set-row__s").bounding_box()
                time = row.locator("time.proj-index__time").bounding_box()
                self.assertIsNotNone(box)
                self.assertIsNotNone(time)
                self.assertLessEqual(box["x"] + box["width"], time["x"] + 1, "the words end before the time's column")
                # A space nobody has written in has neither line nor time.
                empty = page.locator(f"li.proj-index__row[data-space-id='{quiet['id']}']")
                expect(empty).to_be_visible()
                expect(empty.locator(".set-row__s")).to_have_count(0)
                expect(empty.locator("time")).to_have_count(0)
                shot(page, f"v022-spaces-previews-{'phone' if phone else 'computer'}-{scheme}-{ENGINE}")

    def test_10_an_inbox_reply_says_what_you_asked_and_a_discussed_decision_how_many_replies_it_has(self) -> None:
        ada = self.page("ada")
        jonas = self.page("jonas")
        asked = self.api(ada, "POST", f"/api/v1/projects/{self.ids['project']}/conversations",
                         {"body": "@Jonas which hedge row is the overflow sensor on?", "clientMessageId": str(uuid.uuid4())}, status=201)
        self.api(jonas, "POST", f"/api/v1/conversations/{asked['id']}/messages", {"body": "The hedge, I think. It drops to one bar only when it is wet.", "clientMessageId": str(uuid.uuid4())}, status=201)
        item = None
        for _ in range(40):
            queue = self.api(ada, "GET", "/api/v1/needs-you")
            item = next((entry for entry in queue["items"] if entry.get("answer") and entry["title"].startswith("The hedge")), None)
            if item:
                break
            ada.wait_for_timeout(250)
        self.assertIsNotNone(item, "the answer reaches Ada's Inbox")
        self.assertIn("which hedge row is the overflow sensor on?", item["asked"])
        for scheme in ("light", "dark"):
            ada = self.page("ada", scheme=scheme)
            ada.goto("/inbox")
            ada.locator(f"li.nyc[data-key='{item['key']}']").click()
            open_item = ada.locator("article.nyc--open")
            expect(open_item.locator(".nyc__asked")).to_contain_text("You asked")
            expect(open_item.locator(".nyc__asked")).to_contain_text("which hedge row is the overflow sensor on?")
            asked_box = open_item.locator(".nyc__asked").bounding_box()
            title_box = open_item.locator(".nyc__title").bounding_box()
            self.assertLess(asked_box["y"], title_box["y"], "what was asked stands above its answer")
            shot(ada, f"v022-inbox-reply-asked-{scheme}-{ENGINE}")
            # The decision Jonas proposed, six messages deep: its open item says so.
            ada.locator(f"li.nyc[data-key='decision:{self.ids['decision']}']").click()
            expect(ada.locator("article.nyc--open .nyc__based").filter(has_text="Discussion")).to_have_text(re.compile(rf"Discussion\s+{len(NOTES)} replies"))
            shot(ada, f"v022-inbox-decision-replies-{scheme}-{ENGINE}")


if __name__ == "__main__":
    unittest.main()
