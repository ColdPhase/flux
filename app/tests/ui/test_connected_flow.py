"""Browser tests for the connected work flow study's findings fixed before the v0.1 release (#763 CW-1..CW-16).

Runs through scripts/check_ui.sh against the running Compose application, on the engine named by
FLUX_UI_BROWSER (run it with chromium and with webkit). Ola owns "Meal box pickup": a brainstorm message
about a 4-digit SMS code, a map "Pickup ideas" whose thought came from that message, two accepted
decisions, task #1 with three done-when criteria and a positive result, and the Wiki page "How pickup
works". Lena joins afterwards as a contributor. On a computer (1440 x 900) and a phone (390 x 844, touch):

* CW-1: the phone's long press puts a message on the map under "More…", source kept; `/map` does it from the composer.
* CW-2: the thought's "Open message" opens the message in its thread; the message shows an "On the map" chip.
* CW-3: a newcomer's "What matters" shows the week before she joined, under "Before you joined".
* CW-4: the Wiki editor shows a reference's kind, never `flux:decision/<id>`.
* CW-5: a toast never lies over a sheet's buttons on the phone.
* CW-6: a result lists its task's done-when criteria, each unchecked.
* CW-7 / CW-15: one word per object; Project details lists every current decision.
* CW-9: "Add to a Wiki page" puts a card under the heading the person picks.
* CW-14 / CW-16: a Wiki thought link selects the thought; a decision card names the message it came from.
"""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, Page, expect, sync_playwright

from app_select import choose
from message_gestures import long_press
from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, open_details, shot, start_forwarder

PASSWORD = "connected work flow study"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ola": ("Ola Wójcik", f"ola.cw+{STAMP}@example.test"),
    "lena": ("Lena Fischer", f"lena.cw+{STAMP}@example.test"),
}
SMS = "A 4-digit SMS code the evening before"
LOCKERS = "Lockers in the hallway"
D_SMS = "Pickup with a 4-digit SMS code"
D_SAT = "Pickup window: Saturday 10:00–13:00"
TASK = "Send the pickup codes"
CRITERIA = ["Every household gets its code", "Codes are logged with the box number", "Warns the coordinator when the gateway is down"]
RESULT = "Gateway sends pickup codes"
PAGE = "How pickup works"


class ConnectedFlow(unittest.TestCase):
    """Tests run in name order and share two accounts and one project."""

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
        assert cls.browser.browser_type.name == UI_BROWSER
        print(f"ACTUAL_UI_ENGINE={cls.browser.browser_type.name}", flush=True)
        expect.set_options(timeout=10000)
        contexts = {}
        for key, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(service_workers="block", base_url=ORIGIN)
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.states[key] = context.storage_state()
            contexts[key] = context

        def call(who: str, method: str, path: str, body: dict | None = None, headers: dict | None = None) -> dict:
            response = contexts[who].request.fetch(path, method=method, data=json.dumps(body) if body is not None else None,
                                                   headers={"origin": ORIGIN, "content-type": "application/json", **(headers or {})})
            assert response.status in (200, 201), f"{path}: {response.status} {response.text()}"
            return response.json() if response.text() else {}

        cls.call = staticmethod(call)
        ws = call("ola", "POST", "/api/v1/workspaces", {"name": "Lindenhof Community Kitchen"})
        call("ola", "POST", f"/api/v1/workspaces/{ws['id']}/members", {"email": PEOPLE["lena"][1], "role": "member"})
        pid = call("ola", "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Meal box pickup", "visibility": "restricted"})["id"]
        talk = call("ola", "POST", f"/api/v1/projects/{pid}/conversations", {"body": SMS, "clientMessageId": str(uuid.uuid4())})
        lockers = call("ola", "POST", f"/api/v1/projects/{pid}/conversations", {"body": LOCKERS, "clientMessageId": str(uuid.uuid4())})
        message = talk["messages"][0]["id"]
        sketch = call("ola", "POST", f"/api/v1/workspaces/{ws['id']}/sketches", {"title": "Pickup ideas", "scope": "project", "projectId": pid})
        thought = call("ola", "POST", f"/api/v1/sketches/{sketch['id']}/thoughts",
                       {"id": str(uuid.uuid4()), "text": "SMS code", "x": 200, "y": 160, "sourceProjectMessageId": message})["thought"]
        decisions = []
        for title in (D_SMS, D_SAT):
            decision = call("ola", "POST", f"/api/v1/projects/{pid}/decisions",
                            {"title": title, "rationale": "5 of 8 regulars had no email on their phone", "sources": [{"type": "message", "id": message}]})
            call("ola", "POST", f"/api/v1/decisions/{decision['id']}/accept", {}, {"if-match": "\"1\""})
            decisions.append(decision["id"])
        task = call("ola", "POST", f"/api/v1/projects/{pid}/work", {"title": TASK, "criteria": CRITERIA})
        result = call("ola", "POST", f"/api/v1/projects/{pid}/results", {"title": RESULT, "finding": "positive",
                      "evidence": "Codes arrive within a minute. Not tested: what happens when the gateway is down.", "work": [task["id"]]})
        body = "\n".join([f"From the [Pickup ideas](flux:sketch/{sketch['id']}) map and its [SMS thought](flux:thought/{thought['id']}).", "",
                          "## Pickup", "", f"[{D_SMS}](flux:decision/{decisions[0]})", "", "Codes go out the evening before.", "",
                          "## Still open", "", "Lockers?", ""])
        doc = call("ola", "POST", f"/api/v1/projects/{pid}/docs", {"title": PAGE, "body": body, "state": "published"}, {"idempotency-key": str(uuid.uuid4())})
        # Lena joins after all of that.
        call("ola", "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": cls.ids["lena"]}, "role": "contributor"})
        for context in contexts.values():
            context.close()
        cls.ids.update(project=pid, workspace=ws["id"], conversation=talk["id"], message=message, lockers=lockers["messages"][0]["id"],
                       sketch=sketch["id"], thought=thought["id"], d_sms=decisions[0], d_sat=decisions[1], task=task["id"], result=result["id"], doc=doc["id"])

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, who: str = "lena", *, phone: bool = False) -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw", "storage_state": self.states[who]}
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=DESKTOP, device_scale_factor=1)
        context = self.browser.new_context(service_workers="block", **options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def thoughts(self, page: Page) -> list[dict]:
        return page.request.get(f"/api/v1/sketches/{self.ids['sketch']}").json()["thoughts"]

    def save_draft(self, page: Page, text: str) -> None:
        draft = page.get_by_role("form", name="New thought draft")
        expect(draft.get_by_role("textbox", name="Thought text")).to_have_value(text)
        before = len(self.thoughts(page))
        draft.get_by_role("button", name="Save thought", exact=True).click()
        deadline = time.time() + 10
        while len(self.thoughts(page)) == before and time.time() < deadline:
            time.sleep(0.2)

    # ---------------------------------------------------------------- CW-3: What matters for a newcomer

    def test_01_a_newcomer_sees_what_happened_before_she_joined(self) -> None:
        page = self.page()
        page.goto(f"/projects/{self.ids['project']}")
        page.locator("header.top").get_by_role("button", name="More", exact=True).click()
        page.get_by_role("menu", name="More").get_by_role("menuitem", name="What matters").click()
        panel = page.locator("#details")
        expect(panel.get_by_role("heading", name="What matters")).to_be_visible()
        before = panel.get_by_role("region", name="Before you joined")
        expect(before).to_be_visible()
        expect(before).to_contain_text(TASK)
        expect(panel).not_to_contain_text("Nothing new")
        shot(page, "cw3-what-matters-newcomer")
        panel.get_by_role("button", name="Change").click()
        panel.get_by_role("radio", name="Last 7 days").click()
        expect(panel.get_by_role("region", name="Before you joined")).to_contain_text(TASK)
        expect(panel).not_to_contain_text("Nothing new in this period")

    # ---------------------------------------------------------------- CW-2: the thought and its message

    def test_02_a_thought_opens_its_message_and_the_message_names_its_thought(self) -> None:
        page = self.page()
        page.goto(f"/projects/{self.ids['project']}")
        chip = page.locator(f"#message-{self.ids['message']} .ws-chip[data-work-kind='thought']")
        expect(chip).to_contain_text("SMS code")
        expect(chip).to_contain_text("On the map · Pickup ideas")
        chip.click()
        expect(page).to_have_url(re.compile(f"/projects/{self.ids['project']}/map/{self.ids['sketch']}"))
        node = page.locator(f".sk-node[data-id='{self.ids['thought']}']")
        expect(node).to_have_attribute("aria-pressed", "true")
        toolbar = page.get_by_role("toolbar", name="Selection actions")
        toolbar.get_by_role("link", name=re.compile("^Open the message")).click()
        expect(page).to_have_url(re.compile(f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}#message-{self.ids['message']}$"))
        expect(page.locator(f"#thread #message-{self.ids['message']}, #message-{self.ids['message']}").first).to_be_visible()

    def test_03_phone_thought_actions_open_the_message(self) -> None:
        page = self.page(phone=True)
        page.goto(f"/projects/{self.ids['project']}/map/{self.ids['sketch']}#thought-{self.ids['thought']}")
        node = page.locator(f".sk-node[data-id='{self.ids['thought']}']")
        expect(node).to_be_visible()
        node.tap()
        options = page.get_by_role("button", name=re.compile("^(More actions|Thought actions)"))
        if options.count():
            options.first.tap()
        sheet = page.get_by_role("dialog", name="Thought actions")
        expect(sheet).to_be_visible()
        sheet.get_by_role("link", name="Open message").tap()
        expect(page).to_have_url(re.compile(f"/conversations/{self.ids['conversation']}#message-{self.ids['message']}$"))

    # ---------------------------------------------------------------- CW-1: a message onto the map

    def test_04_phone_more_add_to_map_keeps_the_source(self) -> None:
        page = self.page(phone=True)
        page.goto(f"/projects/{self.ids['project']}")
        bubble = page.locator(f"#message-{self.ids['lockers']} .message-bubble > .message-body")
        expect(bubble).to_be_visible()
        bubble.scroll_into_view_if_needed()
        long_press(bubble)
        menu = page.get_by_role("menu", name="Message actions")
        menu.get_by_role("menuitem", name="More…").click()
        menu.get_by_role("menuitem", name="Add to map").click()
        expect(page).to_have_url(re.compile(f"/projects/{self.ids['project']}/map/{self.ids['sketch']}"))
        self.save_draft(page, LOCKERS)
        made = [thought for thought in self.thoughts(page) if thought["text"] == LOCKERS]
        self.assertEqual(len(made), 1)
        self.assertEqual((made[0]["source"] or {}).get("projectMessageId"), self.ids["lockers"], "the phone keeps the source")
        shot(page, "cw1-phone-add-to-map")

    def test_05_slash_map_in_a_thread_puts_its_opening_message_on_the_map(self) -> None:
        page = self.page()
        page.goto(f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}")
        composer = page.locator("#thread-composer")
        expect(composer).to_be_visible()
        composer.click()
        composer.press_sequentially("/ma")
        menu = page.get_by_role("listbox", name="Actions")
        expect(menu.locator(".cmenu__cmd", has_text="/map")).to_be_visible()
        # Enter first picks "/map" from the menu, then sends it.
        composer.fill("/map")
        composer.press("Enter")
        expect(composer).to_have_value("/map ")
        composer.press("Enter")
        expect(page).to_have_url(re.compile(f"/projects/{self.ids['project']}/map/{self.ids['sketch']}"))
        draft = page.get_by_role("form", name="New thought draft")
        expect(draft.get_by_role("textbox", name="Thought text")).to_have_value(SMS)
        # The draft lands in free space in view, not over a thought or under the breadcrumb (CW-12).
        page.wait_for_timeout(300)
        shot(page, "cw12-arrival-desktop")
        ghost = page.locator(".sk-ghost--draft").bounding_box()
        canvas = page.locator(".sk-canvas").bounding_box()
        if ghost and canvas:
            self.assertGreaterEqual(ghost["y"], canvas["y"] + 60)
            for box in page.locator(".sk-node").evaluate_all("els => els.map(el => el.getBoundingClientRect().toJSON())"):
                overlap = not (ghost["x"] + ghost["width"] <= box["left"] or box["right"] <= ghost["x"] or ghost["y"] + ghost["height"] <= box["top"] or box["bottom"] <= ghost["y"])
                self.assertFalse(overlap, f"the new thought overlaps a thought at {box}")
        draft.get_by_role("button", name="Cancel").click()

    # ---------------------------------------------------------------- CW-6: a result and its criteria

    def test_06_a_result_lists_its_tasks_criteria_unchecked(self) -> None:
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page(phone=phone)
                page.goto(f"/projects/{self.ids['project']}/tasks?open=result:{self.ids['result']}")
                panel = page.locator("[data-detail-kind='result']")
                expect(panel).to_be_visible()
                criteria = panel.get_by_role("region", name=re.compile("^Done when"))
                expect(criteria.locator("li")).to_have_text(CRITERIA)
                expect(criteria.get_by_role("img", name="Not checked off")).to_have_count(3)
                expect(criteria).to_contain_text("Not checked off")
                shot(page, f"cw6-result-criteria-{'phone' if phone else 'desktop'}")

    # ---------------------------------------------------------------- CW-15, CW-7: Project details

    def test_07_project_details_lists_every_current_decision(self) -> None:
        page = self.page()
        page.goto(f"/projects/{self.ids['project']}/tasks?open=decision:{self.ids['d_sms']}")
        panel = page.locator("#details")
        expect(panel.locator(".wd-eyebrow")).to_contain_text("Decision · accepted")
        expect(panel).not_to_contain_text("Current rule")
        page.goto(f"/projects/{self.ids['project']}")
        open_details(page)
        now = page.locator("#details").get_by_role("region", name="Now", exact=True)
        expect(now.locator(".ov-rule")).to_have_count(2)
        expect(now).to_contain_text(D_SMS)
        expect(now).to_contain_text(D_SAT)

    # ---------------------------------------------------------------- CW-9, CW-5: a card under a heading, a toast clear of the sheet

    def test_08_add_the_card_under_a_heading_and_the_toast_stays_clear_of_the_sheet(self) -> None:
        page = self.page(phone=True)
        page.goto(f"/projects/{self.ids['project']}/tasks?open=decision:{self.ids['d_sat']}")
        sheet = page.get_by_role("dialog", name="Details")
        expect(sheet).to_be_visible()
        sheet.get_by_role("button", name="Add to a Wiki page").tap()
        choose(sheet.get_by_label("Wiki page", exact=True), label=PAGE)
        choose(sheet.get_by_label("Where", exact=True), label="Under “Pickup”")
        expect(sheet).to_contain_text("The card goes at the end of “Pickup”")
        sheet.get_by_role("button", name="Add the card").tap()
        toast = page.locator(".ui-toast", has_text=f"Added to “{PAGE}”")
        expect(toast).to_be_visible()
        page.wait_for_timeout(400)
        box = toast.bounding_box()
        assert box
        for control in page.locator("[aria-modal='true'] button:visible, [aria-modal='true'] a[href]:visible").evaluate_all("els => els.map(el => el.getBoundingClientRect().toJSON())"):
            covered = not (box["x"] + box["width"] <= control["left"] or control["right"] <= box["x"] or box["y"] + box["height"] <= control["top"] or control["bottom"] <= box["y"])
            self.assertFalse(covered, f"the toast covers a sheet control at {control}")
        shot(page, "cw5-toast-clear-of-sheet")
        doc = page.request.get(f"/api/v1/docs/{self.ids['doc']}").json()
        body = doc["body"]
        self.assertLess(body.index(f"flux:decision/{self.ids['d_sat']}"), body.index("## Still open"), "the card is under Pickup, not under Still open")
        # The action toast leaves on its own (CW-5).
        expect(toast).to_have_count(0, timeout=12000)

    # ---------------------------------------------------------------- CW-4, CW-14, CW-16: the Wiki

    def test_09_the_wiki_reads_references_as_objects(self) -> None:
        page = self.page()
        page.goto(f"/projects/{self.ids['project']}/docs/{self.ids['doc']}")
        card = page.locator("a.doc-decision", has_text=D_SMS)
        expect(card).to_be_visible()
        expect(card.locator(".doc-decision__from")).to_contain_text(SMS)
        link = page.locator(".doc-prose a", has_text="SMS thought")
        expect(link).to_have_attribute("href", f"/projects/{self.ids['project']}/map/{self.ids['sketch']}#thought-{self.ids['thought']}")
        page.goto(f"/projects/{self.ids['project']}/docs/{self.ids['doc']}/edit")
        editor = page.locator("[data-live-wiki-editor], .doc-edit__text").first
        expect(editor).to_be_visible()
        if page.locator("[data-live-wiki-editor]").count():
            expect(editor.locator(".editing-ref", has_text="Decision card").first).to_be_visible()
            self.assertNotIn("flux:decision", editor.inner_text())
            shot(page, "cw4-wiki-editor-references")

    def test_10_search_snippets_show_no_flux_links(self) -> None:
        page = self.page()
        page.goto(f"/search?q={'evening before'}")
        results = page.locator(".sr")
        expect(results.first).to_be_visible()
        for text in results.all_inner_texts():
            self.assertNotIn("flux:", text)


if __name__ == "__main__":
    unittest.main()
