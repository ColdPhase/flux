"""Round 14 of the v0.2.1 release gate, the work screens (tasks, the task and decision panels, the Wiki's history).

Runs with the other tests/ui journeys through scripts/check_ui.sh against the running Compose application, in the engine
FLUX_UI_BROWSER names. Two people, one space with tasks, a blocked task that waits for Ada, a task and a proposed decision each with a
discussion longer than the panel, and two Wiki pages. Each test is one finding of round 14 (REPORT.md, sections daily, new, look-a,
look-b) and fails on the commit before its fix:

- daily P2-3: beside the open panel the Board's columns are 160 px and every own card read "Ada Kowalska (…": "(you)" stays whole.
- look-a A4: a blocked task said "Waiting for Ada Kowalska" to Ada herself: the card and the panel say "(you)", as every list does.
- new P2-3, look-b B3, look-a A3: the phone's sheet opened at the end of the discussion, with no title, no Why and no state, and a blocked
  task's "Waiting for" card cut by the field: the sheet opens at its top with what it asks of the reader whole.
- look-b B1, look-a A5: the panel's lower fade lay over the newest message and over Accept: it fades only while there is more below.
- new d, daily 9: a first version in the Wiki's history read "+0 −0 · The text is the same in both versions." or all underlined.
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
PASSWORD = "round fourteen work screens"
STAMP = int(time.time() * 1000)
ADA = {"name": "Ada Kowalska", "email": f"ada.r14+{STAMP}@example.test"}
JONAS = {"name": "Jonas Berg", "email": f"jonas.r14+{STAMP}@example.test"}
DECISION = "Borrow two sensors from the school instead of buying more"
WHY = "It saves 36 EUR, and the school has spare ESP32 kits."
LONG_TASK = "Calibrate the probes in the raised beds"
BLOCKED = "Waterproof the gateway box"
REASON = "the new seals"
NOTES = [
    "I put the first probe in bed 2, it reads 41 %, which matches the hand meter within two points.",
    "Bed 3 reads 38 %, close enough. The cable is a bit short, so I zip-tied it to the frame for now.",
    "Bed 4 reads 12 %, something is off there: either the probe is half out of the soil or the soil is really that dry.",
    "The soil in bed 4 is dry on top but wet 10 cm down, so the probe is too shallow. I will push it in further.",
    "Pushed it in, now 33 %. Still lower than the others, but the bed gets the afternoon sun.",
    "Let us leave bed 4 as it is and compare again after the weekend rain.",
    "Agreed. I will redo bed 4 on Monday morning and close this task after that.",
]

# Where "(you)" is drawn: whole, or cut by a box that clips it (the name's own ellipsis or the card's).
YOU_WHOLE = """(el) => {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node; while ((node = walker.nextNode()) && !node.data.includes('(you)')) {}
  if (!node) return 'no (you)';
  const range = document.createRange(); const at = node.data.indexOf('(you)'); range.setStart(node, at); range.setEnd(node, at + 5);
  const box = range.getBoundingClientRect();
  for (let box2 = node.parentElement; box2 && box2 !== el.parentElement; box2 = box2.parentElement) {
    const style = getComputedStyle(box2);
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
    const clip = box2.getBoundingClientRect();
    if (box.right > clip.right + 0.5 || box.left < clip.left - 0.5) return `cut by ${box2.className}: ${Math.round(box.right)} > ${Math.round(clip.right)}`;
  }
  return 'whole';
}"""

# The panel's scroller: where an element stands in it, and whether its lower fade is drawn now.
PLACE = """([scrollSel, sel]) => {
  const scroller = document.querySelector(scrollSel); const el = typeof sel === 'string' ? scroller.querySelector(sel) : null;
  const room = scroller.getBoundingClientRect(); const box = el ? el.getBoundingClientRect() : null;
  return { top: box && box.top - room.top, bottom: box && room.bottom - box.bottom, fade: getComputedStyle(scroller, '::after').opacity !== '0',
           scrollTop: scroller.scrollTop, end: scroller.scrollHeight - scroller.clientHeight };
}"""
FADE = 20


class Round14Work(unittest.TestCase):
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
        print("\nActual round-14 work engine: " + cls.browser.browser_type.name)
        expect.set_options(timeout=8000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def context(self, who: str | None, *, phone: bool = False, dark: bool = False) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "color_scheme": "dark" if dark else "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw", "service_workers": "block"}
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=ENGINE == "chromium", has_touch=True)
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

    def api(self, page: Page, method: str, path: str, body: dict | None = None, status: int | None = None) -> dict:
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers={"origin": ORIGIN, "content-type": "application/json"},
                                      data=json.dumps(body) if body is not None else None)
        if status is not None:
            self.assertEqual(response.status, status, response.text())
        return json.loads(response.text()) if response.text() else {}

    def settled(self, page: Page) -> None:
        """The panel has read its discussion and placed itself."""
        page.wait_for_timeout(700)

    # ---------------------------------------------------------------- the data

    def test_01_a_space_with_own_tasks_a_blocked_task_and_two_discussions(self) -> None:
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
        for title in ("Order six capacitive moisture probes", "Label the sensor enclosures", "Print the volunteer rota"):
            self.api(ada, "POST", base, {"title": title, "owner": human(ADA)}, status=201)
        long_task = self.api(ada, "POST", base, {"title": LONG_TASK, "status": "in_progress", "owner": human(ADA)}, status=201)
        blocked = self.api(jonas, "POST", base, {"title": BLOCKED, "status": "blocked", "blocker": REASON, "waitingFor": human(ADA), "owner": human(JONAS)}, status=201)
        decision = self.api(jonas, "POST", f"/api/v1/projects/{pid}/decisions", {"title": DECISION, "rationale": WHY}, status=201)
        for index, note in enumerate(NOTES):
            who = ada if index % 2 else jonas
            self.api(who, "POST", f"/api/v1/work/{long_task['id']}/discussion", {"body": note, "clientMessageId": str(uuid.uuid4())}, status=201)
            self.api(who, "POST", f"/api/v1/decisions/{decision['id']}/discussion", {"body": note, "clientMessageId": str(uuid.uuid4())}, status=201)
        first = self.api(ada, "POST", f"/api/v1/projects/{pid}/docs", {"title": "Sensor placement", "body": "## Where the sensors go\n\nOne capacitive probe per raised bed, 10 cm deep.\n"}, status=201)
        empty = self.api(ada, "POST", f"/api/v1/projects/{pid}/docs", {"title": "Open questions", "body": ""}, status=201)
        type(self).ids = {"project": pid, "long": long_task["id"], "blocked": blocked["id"], "decision": decision["id"], "doc": first["id"], "empty": empty["id"]}

    # ---------------------------------------------------------------- daily P2-3, look-a A4

    def test_02_beside_the_open_panel_an_own_card_keeps_you_whole(self) -> None:
        page = self.page("ada")
        page.goto(f"/projects/{self.ids['project']}/tasks")
        expect(page.locator(".tb-board")).to_be_visible()
        page.locator(".tb-card").filter(has_text="Print the volunteer rota").locator(".tb-card__open").click()
        expect(page.locator("#details .wd--task")).to_be_visible()
        page.wait_for_timeout(500)
        names = page.locator(".tb-card__name").filter(has_text=ADA["name"])
        expect(names.first).to_be_visible()
        self.assertEqual(names.count(), 4, "Ada owns four of the cards")
        width = page.locator(".tb-col").first.evaluate("el => el.getBoundingClientRect().width")
        self.assertLess(width, 200, f"the columns are narrow beside the panel: {width}")
        for index in range(names.count()):
            name = names.nth(index)
            expect(name).to_have_text(f"{ADA['name']} (you)")
            self.assertEqual(name.evaluate(YOU_WHOLE), "whole", f"card {index}: (you) is drawn whole")
        shot(page, f"r14-board-panel-you-{ENGINE}")

    def test_03_a_task_that_waits_for_you_says_you(self) -> None:
        page = self.page("ada")
        page.goto(f"/projects/{self.ids['project']}/tasks")
        card = page.locator(".tb-card").filter(has_text=BLOCKED)
        expect(card.locator(".tb-card__blocker")).to_have_text(f"Waiting for {ADA['name']} (you) · {REASON}")
        card.locator(".tb-card__open").click()
        blocker = page.locator("#details .wd-blocker")
        expect(blocker.locator(".wd-blocker__text")).to_have_text(f"Waiting for {ADA['name']} (you) · {REASON}")
        # Status already says Blocked: the card has no second pill, and its words are not squeezed beside its actions (look-b P8).
        expect(blocker.locator(".ui-pill")).to_have_count(0)
        words = blocker.locator(".wd-blocker__text").bounding_box()
        done = blocker.get_by_role("button", name="Done", exact=True).bounding_box()
        self.assertGreaterEqual(done["y"], words["y"] + words["height"] - 1, "Done is on the line under the words")
        # Jonas, who owns it, reads Ada's name without the mark.
        theirs = self.page("jonas")
        theirs.goto(f"/projects/{self.ids['project']}/tasks")
        expect(theirs.locator(".tb-card").filter(has_text=BLOCKED).locator(".tb-card__blocker")).to_have_text(f"Waiting for {ADA['name']} · {REASON}")

    # ---------------------------------------------------------------- new P2-3, look-b B3, look-a A3 and A5

    def test_04_the_phone_sheet_opens_at_its_top_with_what_it_asks_whole(self) -> None:
        page = self.page("ada", phone=True)
        page.goto(f"/projects/{self.ids['project']}?open=decision:{self.ids['decision']}")
        sheet = page.locator("#details")
        expect(sheet.locator(".wd-discussion__list > li")).to_have_count(len(NOTES))
        self.settled(page)
        title = page.evaluate(PLACE, ["#details .wd__scroll", ".wd-decision-identity .details__title"])
        self.assertGreaterEqual(title["top"], 0, f"the decision's title is in view: {title}")
        accept = page.evaluate(PLACE, ["#details .wd__scroll", ".wd-decide .ui-btn--primary"])
        self.assertGreaterEqual(accept["bottom"], FADE if accept["fade"] else 0, f"Accept is whole, clear of the fade: {accept}")
        expect(sheet.get_by_text(WHY)).to_be_in_viewport()
        shot(page, f"r14-phone-decision-open-{ENGINE}")
        # The cursor in the field brings the newest message into view, as a conversation's composer does.
        sheet.get_by_placeholder("Write about this decision…").click()
        page.wait_for_timeout(300)
        newest = page.evaluate(PLACE, ["#details .wd__scroll", ".wd-discussion__list > li:last-child"])
        self.assertGreaterEqual(newest["bottom"], -1, f"the newest message is in view once the cursor is in the field: {newest}")

        page.goto(f"/projects/{self.ids['project']}/tasks?open=work:{self.ids['long']}")
        expect(sheet.locator(".wd-act .wd-act__item--message")).to_have_count(len(NOTES))
        self.settled(page)
        title = page.evaluate(PLACE, ["#details .wd__scroll", ".wd-title, .details__title"])
        self.assertGreaterEqual(title["top"], 0, f"the task's title is in view: {title}")
        shot(page, f"r14-phone-task-open-{ENGINE}")

        page.goto(f"/projects/{self.ids['project']}/tasks?open=work:{self.ids['blocked']}")
        expect(sheet.locator(".wd-blocker")).to_be_visible()
        self.settled(page)
        blocker = page.evaluate(PLACE, ["#details .wd__scroll", ".wd-blocker"])
        self.assertGreaterEqual(blocker["top"], 0, f"the Waiting for card starts in view: {blocker}")
        self.assertGreaterEqual(blocker["bottom"], FADE if blocker["fade"] else 0, f"the Waiting for card is whole above the field: {blocker}")
        shot(page, f"r14-phone-blocked-open-{ENGINE}")

    # ---------------------------------------------------------------- look-b B1

    def test_05_the_computer_panel_opens_with_its_newest_message_unfaded(self) -> None:
        page = self.page("ada")
        page.goto(f"/projects/{self.ids['project']}/tasks?open=work:{self.ids['long']}")
        expect(page.locator("#details .wd-act .wd-act__item--message")).to_have_count(len(NOTES))
        self.settled(page)
        last = page.evaluate(PLACE, ["#details .wd__scroll", ".wd-act > li:last-child"])
        self.assertGreater(last["end"], 0, "the discussion is longer than the panel")
        self.assertGreaterEqual(last["bottom"], FADE if last["fade"] else 0, f"the newest message is whole and no fade lies on it: {last}")
        # Scrolled up, the lower edge fades into the field; at the end it does not.
        page.locator("#details .wd__scroll").evaluate("el => { el.scrollTop = 0; }")
        page.wait_for_timeout(200)
        self.assertTrue(page.evaluate(PLACE, ["#details .wd__scroll", None])["fade"], "the fade shows while there is more below")
        shot(page, f"r14-computer-task-open-{ENGINE}")

    # ---------------------------------------------------------------- new d, daily 9

    def test_06_a_first_version_reads_as_the_page_began(self) -> None:
        page = self.page("ada")
        page.goto(f"/projects/{self.ids['project']}/docs/{self.ids['doc']}/history")
        expect(page.get_by_role("heading", name="Version 1, the first")).to_be_visible()
        expect(page.locator(".doc-changes__stat")).to_have_count(0)
        expect(page.get_by_text("The text is the same in both versions.")).to_have_count(0)
        first = page.get_by_label("The text of the first version")
        expect(first).to_contain_text("One capacitive probe per raised bed")
        expect(first.locator("ins, .wiki-chg--added")).to_have_count(0)
        # The chosen row says what can be done with it, in words: the current version opens the page.
        expect(page.locator(".doc-versions").get_by_role("link", name="Open the page")).to_be_visible()
        shot(page, f"r14-wiki-history-first-{ENGINE}")
        page.goto(f"/projects/{self.ids['project']}/docs/{self.ids['empty']}/history")
        expect(page.get_by_role("heading", name="Version 1, the first")).to_be_visible()
        expect(page.get_by_text("The page started with no text.")).to_be_visible()
        expect(page.locator(".doc-changes__stat")).to_have_count(0)


if __name__ == "__main__":
    unittest.main()
