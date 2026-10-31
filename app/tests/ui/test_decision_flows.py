"""Browser tests for the decision, Wiki and message-menu flows the #763 audit (Part A) found unfinished.

Runs through scripts/check_ui.sh against the running Compose application, on the engine named by
FLUX_UI_BROWSER (run it with chromium and with webkit). One person owns a project with a message, a
decision proposed from that message, a decision with no source, an accepted rule and a result. It checks
what a person sees and can do, on a computer (1440 x 900) and a phone (390 x 844, touch):

* D1: a proposed decision's panel is its Inbox card first: "Needs you", Accept / Not now / Discuss and
  who is still waiting; on a phone the answer is inside the half sheet; Not now asks when to return.
* D2: no empty "Based on", "Evidence", "Reports on" or "At this pivot" sections.
* D3: Discuss opens the decision's thread with its reply field focused, or the conversation with the
  composer focused and the decision beside it, from the panel and from the Inbox.
* D4/D6: "Add to a Wiki page" closes the form back to the decision, lists the page under "In the Wiki"
  and says where it went with one toast and Open.
* B2: "Hand off to an agent" with no agent explains that and offers "Connect your own agent", and makes
  no task.
* B3: a phone's long press lifts the message above the blur and shows the five drawn items under it.
* B4: a computer's More actions lists only what the toolbar lacks, and says "Record a result".
* B5: a task made from a message is titled with its first clause, selected.
* B6: "Propose a decision" has one title and no pager for one page of rules.
"""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from app_select import choose
from message_gestures import long_press
from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, shot, start_forwarder

PASSWORD = "decisions are answered where they are asked"
STAMP = int(time.time() * 1000)
ADA = {"name": "Ada Lind", "email": f"ada.flows+{STAMP}@example.test"}
MESSAGE = "The resistive probes in bed 5 read 92 % today, which cannot be right: the soil is dry on top. I think they are corroding"
CLAUSE = "The resistive probes in bed 5 read 92 % today"
FROM_MESSAGE = "Replace the resistive probes with capacitive ones"
NO_SOURCE = "Water the beds before eight in the morning"
RULE = "Log moisture every ten minutes"
RESULT = "Capacitive probes hold steady for three weeks"
PAGE = "Decisions and why"
DRAWN = ["Reply in thread", "Create task", "Hand off to an agent", "Cite", "Copy text"]


class DecisionFlows(unittest.TestCase):
    """Tests run in name order and share one account and one project."""

    pw = None
    browser: Browser
    state: dict = {}
    ids: dict = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        assert cls.browser.browser_type.name == UI_BROWSER
        print(f"ACTUAL_UI_ENGINE={cls.browser.browser_type.name}", flush=True)
        expect.set_options(timeout=8000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def context(self, *, phone: bool = False, signed_in: bool = True) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "locale": "en-GB", "timezone_id": "Europe/Warsaw", "viewport": PHONE if phone else DESKTOP}
        if phone:
            options.update(device_scale_factor=3, is_mobile=True, has_touch=True)
        if signed_in and self.state:
            options["storage_state"] = self.state
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        return context

    def page(self, *, phone: bool = False) -> Page:
        page = self.context(phone=phone).new_page()
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

    def panel(self, page: Page, *, phone: bool = False):
        host = page.get_by_role("dialog", name="Details") if phone else page.locator("#details")
        panel = host.locator(".wd").first
        expect(panel).to_be_visible()
        return panel

    def message(self, page: Page):
        return page.locator(f"#message-{self.ids['message']}")

    # ---------------------------------------------------------------- fixture

    def test_00_a_project_with_a_message_two_proposals_a_rule_and_a_result(self) -> None:
        page = self.context(signed_in=False).new_page()
        page.goto("/sign-up")
        page.get_by_label("Name").fill(ADA["name"])
        page.get_by_label("Email").fill(ADA["email"])
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        type(self).state = page.context.storage_state()
        ws = self.api(page, "POST", "/api/v1/workspaces", {"name": "Riverside garden"}, status=201)
        project = self.api(page, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Garden sensors", "visibility": "restricted"}, status=201)
        pid = project["id"]
        root = self.api(page, "POST", f"/api/v1/projects/{pid}/conversations", {"body": MESSAGE, "clientMessageId": str(uuid.uuid4())})
        message = root["messages"][0]["id"]
        rule = self.api(page, "POST", f"/api/v1/projects/{pid}/decisions", {"title": RULE, "rationale": "Ten minutes shows a watering"}, status=201)
        self.api(page, "POST", f"/api/v1/decisions/{rule['id']}/accept", {"expectedVersion": 1}, status=200)
        sourced = self.api(page, "POST", f"/api/v1/projects/{pid}/decisions", {"title": FROM_MESSAGE, "rationale": "Capacitive probes do not corrode",
                                                                                 "sources": [{"type": "message", "id": message}]}, status=201)
        bare = self.api(page, "POST", f"/api/v1/projects/{pid}/decisions", {"title": NO_SOURCE, "rationale": "Less evaporation"}, status=201)
        result = self.api(page, "POST", f"/api/v1/projects/{pid}/results", {"title": RESULT, "finding": "positive", "evidence": "Readings within 2 % for 21 days"}, status=201)
        # The proposal without a source is also in a Wiki page: that link to it is not what it is based on (D2). A page mentions
        # it in a sentence; "Add to a Wiki page" itself refuses a proposal (F-034).
        self.api(page, "POST", f"/api/v1/projects/{pid}/docs", {"title": "Watering", "body": f"We may water at dawn: [{NO_SOURCE}](flux:decision/{bare['id']})."}, status=201)
        wiki = self.api(page, "POST", f"/api/v1/projects/{pid}/docs", {"title": PAGE, "body": "Why the garden runs as it does."}, status=201)
        type(self).ids = {"page": wiki["id"], "project": pid, "conversation": root["id"], "message": message, "rule": rule["id"], "sourced": sourced["id"], "bare": bare["id"], "result": result["id"]}

    # ---------------------------------------------------------------- D1, D2

    def test_01_a_proposed_decision_is_its_inbox_card_first(self) -> None:
        page = self.page()
        page.goto(f"/projects/{self.ids['project']}/tasks?open=decision:{self.ids['sourced']}")
        panel = self.panel(page)
        expect(panel.locator(".wd-decision-identity")).to_contain_text("Needs you")
        answer = panel.get_by_role("region", name="Your answer")
        expect(answer.get_by_role("button", name="Accept", exact=True)).to_be_visible()
        expect(answer.get_by_role("button", name="Not now")).to_be_visible()
        expect(answer.get_by_role("button", name="Discuss", exact=True)).to_be_visible()
        expect(answer).to_contain_text("waiting for you")
        # The answer comes right after the reason and what it rests on, before the record rows.
        order = panel.evaluate("""(root) => [...root.children].map((el) => el.matches('.wd-decide') ? 'answer' : el.matches('.wd-rows') ? 'rows'
          : el.matches('.details__lead') ? 'lead' : el.querySelector('#wd-based') ? 'based' : null).filter(Boolean)""")
        self.assertEqual(order, ["lead", "based", "answer", "rows"])
        expect(panel.get_by_role("heading", name="Based on")).to_be_visible()
        expect(panel.get_by_text("Agents can propose decisions; only people accept them.")).to_have_count(0)
        shot(page, "decision-flows-d1-desktop")
        # Not now asks when it should return, and takes it out of the Inbox only.
        answer.get_by_role("button", name="Not now").click()
        menu = page.get_by_role("menu", name="Ask me again")
        expect(menu.get_by_role("menuitem", name=re.compile("^Tomorrow morning"))).to_be_visible()
        menu.get_by_role("menuitem", name=re.compile("^Tomorrow morning")).click()
        expect(page.get_by_text("Not now. Back tomorrow morning")).to_be_visible()
        expect(answer.get_by_role("button", name="Not now")).to_have_count(0)
        expect(answer.get_by_role("button", name="Accept", exact=True)).to_be_visible()
        page.get_by_role("button", name="Undo").click()
        expect(answer.get_by_role("button", name="Not now")).to_be_visible()

    def test_02_on_a_phone_the_answer_is_inside_the_half_sheet(self) -> None:
        page = self.page(phone=True)
        page.goto(f"/projects/{self.ids['project']}?open=decision:{self.ids['sourced']}")
        panel = self.panel(page, phone=True)
        accept = panel.get_by_role("region", name="Your answer").get_by_role("button", name="Accept", exact=True)
        expect(accept).to_be_visible()
        page.wait_for_timeout(500)  # the sheet has settled at its first height
        box = accept.bounding_box()
        self.assertIsNotNone(box)
        self.assertLessEqual(box["y"] + box["height"], PHONE["height"], "Accept is on screen without scrolling the sheet")
        self.assertGreaterEqual(box["height"], 44, "a touch target")
        shot(page, "decision-flows-d1-phone")

    def test_03_no_empty_sections(self) -> None:
        page = self.page()
        pid = self.ids["project"]
        page.goto(f"/projects/{pid}/tasks?open=decision:{self.ids['bare']}")
        panel = self.panel(page)
        expect(panel.get_by_role("heading", name="In the Wiki")).to_be_visible()
        expect(panel.get_by_role("link", name=re.compile("Watering"))).to_be_visible()
        expect(panel.get_by_role("heading", name="Based on")).to_have_count(0)
        expect(panel).not_to_contain_text("No source linked")
        page.goto(f"/projects/{pid}/tasks?open=decision:{self.ids['rule']}")
        panel = self.panel(page)
        expect(panel.locator(".details__eyebrow")).to_contain_text("accepted")
        expect(panel.get_by_role("heading", name="In the Wiki")).to_be_visible()
        expect(panel.get_by_role("heading", name="At this pivot")).to_have_count(0)
        expect(panel).not_to_contain_text("No rows on this page")
        page.goto(f"/projects/{pid}/tasks?open=result:{self.ids['result']}")
        panel = self.panel(page)
        expect(panel.locator(".details__lead")).to_contain_text("Readings within 2 %")
        expect(panel.get_by_role("heading", name="In the Wiki")).to_be_visible()
        expect(panel.get_by_role("heading", name="Evidence")).to_have_count(0)
        expect(panel.get_by_role("heading", name="Reports on")).to_have_count(0)
        expect(panel).not_to_contain_text("No evidence linked")

    # ---------------------------------------------------------------- D3

    def test_04_discuss_opens_the_decisions_thread_ready_to_write(self) -> None:
        page = self.page()
        pid = self.ids["project"]
        page.goto(f"/projects/{pid}/tasks?open=decision:{self.ids['sourced']}")
        self.panel(page).get_by_role("button", name="Discuss", exact=True).click()
        expect(page).to_have_url(re.compile(f"/projects/{pid}/conversations/{self.ids['conversation']}"))
        expect(page.locator("#thread-composer")).to_be_focused()
        # The thread shows the decision that came of its message.
        expect(page.locator("#thread")).to_contain_text(FROM_MESSAGE)
        shot(page, "decision-flows-d3-thread")

    def test_05_discuss_without_a_source_opens_the_conversation_with_the_decision_beside_it(self) -> None:
        page = self.page()
        pid = self.ids["project"]
        page.goto(f"/projects/{pid}/tasks?open=decision:{self.ids['bare']}")
        self.panel(page).get_by_role("button", name="Discuss", exact=True).click()
        expect(page).to_have_url(re.compile(f"/projects/{pid}/?$"))
        expect(page.locator("#project-composer")).to_be_focused()
        expect(page.locator("#details").get_by_role("heading", level=3, name=NO_SOURCE)).to_be_visible()

    def test_06_discuss_from_the_inbox_opens_the_same_thread(self) -> None:
        page = self.page()
        page.goto("/inbox")
        card = page.locator(".nyc", has_text=FROM_MESSAGE)
        expect(card).to_be_visible()
        if "nyc--compact" in (card.get_attribute("class") or ""):  # #763 LD-1: only the selected item shows Discuss
            frame = card.locator(".nyc__card").bounding_box()
            page.mouse.click(frame["x"] + 10, frame["y"] + frame["height"] / 2)
        card.get_by_role("button", name="Discuss", exact=True).click()
        expect(page).to_have_url(re.compile(f"/conversations/{self.ids['conversation']}"))
        expect(page.locator("#thread-composer")).to_be_focused()

    # ---------------------------------------------------------------- D4, D6

    def test_07_add_to_a_wiki_page_closes_back_with_one_calm_confirmation(self) -> None:
        page = self.page()
        pid = self.ids["project"]
        page.goto(f"/projects/{pid}?open=result:{self.ids['result']}")
        panel = self.panel(page)
        expect(panel).to_contain_text("Not in the Wiki yet.")
        panel.get_by_role("button", name="Add to a Wiki page", exact=True).click()
        form = page.locator("#details form.wd")
        page_select = form.get_by_label("Wiki page", exact=True)
        expect(page_select).to_be_visible()
        choose(page_select, value=self.ids["page"])
        form.get_by_role("button", name="Add or update section", exact=True).click()
        # The form closes back to the result, which now lists the page; the conversation stays where it was.
        expect(form).to_have_count(0)
        panel = self.panel(page)
        expect(panel.get_by_role("heading", level=3, name=RESULT)).to_be_visible()
        expect(panel.get_by_role("link", name=re.compile(PAGE))).to_be_visible()
        expect(page).to_have_url(re.compile(f"/projects/{pid}/?(\\?.*)?$"))
        toast = page.get_by_text(f"Added to “{PAGE}”")
        expect(toast).to_be_visible()
        shot(page, "decision-flows-d4-added")
        page.get_by_role("button", name="Open", exact=True).click()
        expect(page).to_have_url(re.compile(f"/projects/{pid}/docs/"))
        expect(page.get_by_role("heading", level=2, name=PAGE)).to_be_visible()

    # ---------------------------------------------------------------- B2, B4, B5 (computer)

    def test_08_the_computer_menu_lists_what_the_toolbar_lacks(self) -> None:
        page = self.page()
        page.goto(f"/projects/{self.ids['project']}")
        message = self.message(page)
        message.hover()
        message.get_by_role("button", name="More actions").click()
        menu = page.get_by_role("menu", name="Message actions")
        expect(menu.get_by_role("menuitem", name="Reply in thread")).to_have_count(0)
        expect(menu.get_by_role("menuitem", name="Record a result", exact=True)).to_be_visible()
        expect(menu.get_by_role("menuitem", name="Attach a result")).to_have_count(0)
        page.keyboard.press("Escape")

    def test_09_hand_off_with_no_agent_explains_and_offers_connect(self) -> None:
        page = self.page()
        pid = self.ids["project"]
        tasks_before = len(self.api(page, "GET", f"/api/v1/projects/{pid}/work?limit=100").get("items", []))
        page.goto(f"/projects/{pid}")
        message = self.message(page)
        message.hover()
        message.get_by_role("button", name="More actions").click()
        page.get_by_role("menu", name="Message actions").get_by_role("menuitem", name="Hand off to an agent").click()
        dialog = page.get_by_role("dialog", name="Hand off a task")
        expect(dialog.get_by_role("heading", name="No agents in this project yet")).to_be_visible()
        expect(dialog.get_by_role("link", name="Connect your own agent")).to_have_attribute("href", "/connect-agent")
        expect(page.get_by_role("dialog", name=re.compile("Create"))).to_have_count(0)
        shot(page, "decision-flows-b2-no-agent")
        dialog.get_by_role("button", name="Cancel").click()
        expect(dialog).to_have_count(0)
        self.assertEqual(len(self.api(page, "GET", f"/api/v1/projects/{pid}/work?limit=100").get("items", [])), tasks_before, "no task was made")

    def test_10_a_task_from_a_message_is_titled_with_its_first_clause_selected(self) -> None:
        page = self.page()
        page.goto(f"/projects/{self.ids['project']}")
        message = self.message(page)
        message.hover()
        message.get_by_role("button", name="Create task").click()
        title = page.get_by_placeholder("What needs doing?")
        expect(title).to_have_value(CLAUSE)
        expect(title).to_be_focused()
        selected = title.evaluate("(el) => [el.selectionStart, el.selectionEnd]")
        self.assertEqual(selected, [0, len(CLAUSE)], "the title is selected, so typing replaces it")
        page.keyboard.press("Escape")

    def test_11_propose_a_decision_has_one_title_and_no_single_page_pager(self) -> None:
        page = self.page()
        page.goto(f"/projects/{self.ids['project']}/tasks?open=propose-decision")
        panel = self.panel(page)
        expect(panel.get_by_role("heading", level=3, name="Propose a decision")).to_be_visible()
        expect(panel).not_to_contain_text("New proposal")
        select = panel.get_by_label("Replaces", exact=True)
        expect(select).to_be_enabled()
        expect(panel.get_by_role("navigation", name="Current rule choices")).to_have_count(0)

    # ---------------------------------------------------------------- B3 (phone)

    def test_12_a_phone_long_press_lifts_the_message_over_five_items(self) -> None:
        page = self.page(phone=True)
        page.goto(f"/projects/{self.ids['project']}")
        message = self.message(page)
        expect(message).to_be_visible()
        bubble = message.locator(".message-bubble > .message-body")
        bubble.scroll_into_view_if_needed()
        long_press(bubble)
        menu = page.get_by_role("menu", name="Message actions")
        expect(menu).to_be_visible()
        items = [text.strip() for text in menu.get_by_role("menuitem").all_inner_texts()]
        self.assertEqual(items, DRAWN, "the five drawn items, in order")
        lifted = page.locator(".msg-menu__lift")
        expect(lifted).to_be_visible()
        expect(lifted).to_contain_text("The resistive probes in bed 5")
        page.wait_for_timeout(400)  # the menu has come in
        lift_box, menu_box = lifted.bounding_box(), menu.bounding_box()
        self.assertIsNotNone(lift_box)
        self.assertIsNotNone(menu_box)
        self.assertGreaterEqual(menu_box["y"], lift_box["y"] + lift_box["height"] - 1, "the menu sits under the lifted message, not over it")
        self.assertLessEqual(menu_box["y"] - (lift_box["y"] + lift_box["height"]), 16, "directly under it")
        self.assertLessEqual(menu_box["y"] + menu_box["height"], PHONE["height"], "the whole menu is on screen")
        self.assertGreaterEqual(lift_box["y"], 0, "the lifted message is on screen")
        # The lifted copy is above the blur: it is what a touch at its centre hits.
        hit = page.evaluate("([x, y]) => document.elementFromPoint(x, y)?.closest('.msg-menu__lift, .msg-menu__scrim')?.className ?? ''",
                            [lift_box["x"] + lift_box["width"] / 2, lift_box["y"] + lift_box["height"] / 2])
        self.assertIn("msg-menu__lift", hit)
        shot(page, "decision-flows-b3-longpress")
        menu.get_by_role("menuitem", name="Copy text").focus()
        page.keyboard.press("Escape")
        expect(menu).to_have_count(0)
        expect(lifted).to_have_count(0)


if __name__ == "__main__":
    unittest.main()
