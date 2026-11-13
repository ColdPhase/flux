"""Browser tests for `/ai` in every conversation, answered privately (#842, F-036 AG-4, mockups AiPrivate and AiAgents).

Runs with the other tests/ui journeys through scripts/check_ui.sh, on the TEST-ONLY mock provider (`FLUX_TEST_PERSONAL_RUNS=anthropic-mock`): the
real worker sends runs through the real Anthropic adapter to `tests/ui/anthropic_mock.py`. Nothing here calls a model; no test is a provider,
billing or compatibility pass.

Three people share a space: Jo (owns the assistant), Kai (contributor) and Lee (a guest of the company). Jo asks in the space's main conversation, in a
thread, in a direct message with Kai and in the task's thread; the answer is Jo's alone until Show everyone posts it as "Jo's Assistant" (#1232).
Jo's agent also has a private chat with a box to write in. Each case is checked on what the others do not see.
"""

from __future__ import annotations

import json
import os
import re
import time
import unittest
import urllib.request
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder
from test_assistant_screen import menu_clipped_by, suggestions_reachable

MOCK = os.environ.get("FLUX_ANTHROPIC_MOCK_URL", "http://127.0.0.1:8090")
UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
PASSWORD = "an answer that stays mine"
STAMP = int(time.time() * 1000)
JO = {"name": "Jo Weber", "email": f"jo.weber.pai+{STAMP}@example.test"}
KAI = {"name": "Kai Lund", "email": f"kai.lund.pai+{STAMP}@example.test"}
LEE = {"name": "Lee Park", "email": f"lee.park.pai+{STAMP}@example.test"}
MIA = {"name": "Mia Roth", "email": f"mia.roth.pai+{STAMP}@example.test"}
OPENING = "Which network for the far beds: LoRa or Wi-Fi?"
KAI_REPLY = "LoRa for the far beds, because Wi-Fi drops when the hedge is wet."
DM_TOKEN = f"BETWEEN-US-{uuid.uuid4()}"
ANSWER = "Fact: the far beds will use LoRa because Wi-Fi drops when the hedge is wet [S1]."


def mock(path: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(f"{MOCK}{path}", data=data, method="POST" if body is not None else "GET", headers={"content-type": "application/json"})
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.loads(response.read())


class PrivateAiJourney(unittest.TestCase):
    """Tests run in name order and share three accounts, one space, one direct message and one task."""

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
        expect.set_options(timeout=10000)
        mock("/__script", {"reset": True})

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def context(self, who: str | None, *, phone: bool = False, dark: bool = False) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "color_scheme": "dark" if dark else "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw"}
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=DESKTOP, device_scale_factor=1)
        if who and who in self.states:
            options["storage_state"] = self.states[who]
        context = self.browser.new_context(service_workers="block", **options)
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

    def space(self, who: str, **kwargs) -> Page:
        page = self.page(who, **kwargs)
        page.goto(f"/projects/{self.ids['project']}")
        expect(page.locator("#project-composer")).to_be_visible()
        return page

    def thread(self, who: str, **kwargs) -> Page:
        page = self.page(who, **kwargs)
        page.goto(f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}")
        expect(page.locator("#thread-composer")).to_be_visible()
        return page

    def dm(self, who: str, **kwargs) -> Page:
        page = self.page(who, **kwargs)
        page.goto(f"/dm/{self.ids['dm']}")
        expect(page.locator("#dm-composer")).to_be_visible()
        return page

    def ask_in(self, page: Page, composer: str, prompt: str, send: str = "Send to your assistant") -> None:
        box = page.locator(composer)
        box.fill(f"/ai {prompt}")
        page.get_by_role("button", name=send).click()

    def private_card(self, page: Page):
        return page.locator(".assistant-private")

    def agent_answer(self, posted, label: str = "Jo's Assistant", spoken: str = "Jo's Assistant, shown by Jo") -> None:
        """An answer shown to everyone is the agent's message for every reader, the asker included (#1232): its label, its Kreska in the agent's
        colour, the "Agent" tag, and never the asker's own right-hand bubble; a screen reader hears whose it is and who showed it."""
        expect(posted).to_be_visible(timeout=15000)
        expect(posted).to_have_attribute("data-shown-answer", "")
        expect(posted).to_have_attribute("aria-label", spoken)
        expect(posted).not_to_have_class(re.compile(r"\bis-mine\b"))
        who = posted.locator(".project-convo__message-meta, .dm-msg__meta, .wd-act__who, .thread__root-meta").first
        expect(who).to_contain_text(label)
        expect(who.locator(".agent-tag")).to_have_text("Agent")
        expect(who).not_to_contain_text("via")
        expect(posted.locator(".kreska--ink").first).to_be_visible()
        expect(posted).not_to_contain_text("via Assistant")

    def no_horizontal_scroll(self, page: Page) -> None:
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), page.evaluate("window.innerWidth"))

    # ---------------------------------------------------------------- setup

    def test_01_three_people_share_a_space_and_a_direct_message(self) -> None:
        for key, person in (("jo", JO), ("kai", KAI), ("lee", LEE), ("mia", MIA)):
            page = self.page(None)
            page.goto("/sign-up")
            page.get_by_label("Name").fill(person["name"])
            page.get_by_label("Email").fill(person["email"])
            page.get_by_label("Password").fill(PASSWORD)
            page.get_by_role("button", name="Create account").click()
            expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
            type(self).states[key] = page.context.storage_state()
            person["id"] = self.api(page, "GET", "/api/v1/me", status=200)["user"]["id"]
        jo = self.page("jo")
        ws = self.api(jo, "POST", "/api/v1/workspaces", {"name": "Community garden"}, status=201)
        self.api(jo, "POST", f"/api/v1/workspaces/{ws['id']}/members", {"email": KAI["email"], "role": "member"}, status=201)
        self.api(jo, "POST", f"/api/v1/workspaces/{ws['id']}/members", {"email": LEE["email"], "role": "guest"}, status=201)
        self.api(jo, "POST", f"/api/v1/workspaces/{ws['id']}/members", {"email": MIA["email"], "role": "member"}, status=201)
        project = self.api(jo, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Garden sensors", "visibility": "restricted"}, status=201)
        for person, role in ((KAI, "contributor"), (LEE, "contributor")):
            self.api(jo, "POST", f"/api/v1/projects/{project['id']}/grants", {"principal": {"kind": "human", "id": person["id"]}, "role": role}, status=201)
        thread = self.api(jo, "POST", f"/api/v1/projects/{project['id']}/conversations", {"body": OPENING, "clientMessageId": str(uuid.uuid4())}, status=201)
        kai = self.page("kai")
        self.api(kai, "POST", f"/api/v1/conversations/{thread['id']}/messages", {"body": KAI_REPLY, "clientMessageId": str(uuid.uuid4())}, status=201)
        work = self.api(kai, "POST", f"/api/v1/projects/{project['id']}/work", {"title": "Order the probes", "owner": {"kind": "human", "id": KAI["id"]}}, status=201)
        self.api(kai, "POST", f"/api/v1/work/{work['id']}/discussion", {"body": "Six probes now, two more after the school replies.", "clientMessageId": str(uuid.uuid4()), "kind": "text"}, status=201)
        dm = self.api(jo, "POST", f"/api/v1/workspaces/{ws['id']}/dms", {"participantIds": [KAI["id"]]}, status=201)
        self.api(jo, "POST", f"/api/v1/dms/{dm['id']}/messages", {"body": f"Between us: {DM_TOKEN}", "clientMessageId": str(uuid.uuid4())}, status=201)
        type(self).ids = {"workspace": ws["id"], "project": project["id"], "conversation": thread["id"], "work": work["id"], "dm": dm["id"]}
        # Jo's first agent, Assistant, answers /ai: the fixture key here is Connect AI's default (the server makes it at a person's own first connection, #945).
        settings = self.page("jo")
        type(self).ids["agent"] = self.api(settings, "POST", "/api/v1/my-agents", {"workspaceId": ws["id"]}, status=201)["id"]
        settings.goto("/settings/agents")
        expect(settings.get_by_role("list", name="Your agents").get_by_role("listitem").first).to_contain_text("Answers /ai")

    # ---------------------------------------------------------------- the space's main conversation

    def test_02_in_the_main_conversation_the_answer_is_the_askers_until_show_everyone(self) -> None:
        mock("/__script", {"reset": True, "delay": 2, "text": ANSWER})
        jo = self.space("jo")
        kai = self.space("kai")
        self.ask_in(jo, "#project-composer", "summarise what we decided about the network")
        expect(jo.locator("#project-ask")).to_have_count(0)
        working = jo.locator(".assistant-working")
        expect(working).to_contain_text("Only you see this")
        # Nobody else learns that a run exists while it works, nor that it ended.
        expect(kai.locator(".assistant-working")).to_have_count(0)
        card = self.private_card(jo)
        expect(card).to_be_visible(timeout=20000)
        expect(working).to_have_count(0)
        expect(card).to_contain_text("Assistant")
        expect(card).to_contain_text("Only you can see this")
        expect(card).to_contain_text("You asked: /ai summarise what we decided about the network")
        expect(card).to_contain_text("far beds will use LoRa")
        expect(card).to_contain_text("Kai and Lee don’t see this. Show everyone posts it as “Jo's Assistant”.")
        shot(jo, "private-ai-1440-main-conversation")
        expect(self.private_card(kai)).to_have_count(0)
        self.assertNotIn("far beds will use LoRa because Wi-Fi drops when the hedge is wet [", kai.locator("body").inner_text(), "the others do not see the answer")
        # The cited source is one message of this space; nothing of the DM was sent.
        sent = [item for item in mock("/__requests")["requests"] if item["path"] == "/v1/messages"]
        self.assertEqual(len(sent), 1)
        self.assertIn(OPENING, json.dumps(sent[0]["body"]))
        self.assertNotIn(DM_TOKEN, json.dumps(sent[0]["body"]))
        # Show everyone: the card goes, the answer is Jo's message for the others, "Jo's Assistant", an agent's message (#1232).
        card.get_by_role("button", name="Show everyone").click()
        expect(card).to_have_count(0)
        posted = kai.locator(".project-convo__message").filter(has_text="far beds will use LoRa")
        self.agent_answer(posted)
        expect(posted).not_to_contain_text("Source")
        # It stays gone after a reload: it was posted, not kept. Jo reads the same agent's message, not her own bubble on the right.
        jo.reload()
        self.agent_answer(jo.locator(".project-convo__message").filter(has_text="far beds will use LoRa"))
        expect(self.private_card(jo)).to_have_count(0)
        # A guest of the company reads it the same way.
        lee = self.space("lee")
        self.agent_answer(lee.locator(".project-convo__message").filter(has_text="far beds will use LoRa"))

    def test_02b_an_answer_that_searched_the_web_lists_what_it_searched_and_the_page_it_cites(self) -> None:
        """#954: the provider's own web search is on by default; Flux lists the search and the cited address under the answer, in its own words."""
        cited = "https://lora-alliance.example/coverage/far-beds"
        mock("/__script", {"reset": True, "text": "LoRa reaches about two kilometres through a wet hedge.",
                           "search": {"query": "LoRa range through wet hedge", "results": [cited, "https://wifi.example/range"], "cite": cited}})
        jo = self.space("jo")
        self.ask_in(jo, "#project-composer", "how far does LoRa reach through a wet hedge?")
        card = self.private_card(jo)
        expect(card).to_be_visible(timeout=20000)
        expect(card).to_contain_text("Based on the search, LoRa reaches about two kilometres through a wet hedge.")
        expect(card).to_contain_text("Searched the web for:")
        expect(card).to_contain_text("LoRa range through wet hedge")
        expect(card).to_contain_text("Found on the web:")
        expect(card).to_contain_text(cited)
        self.assertNotIn("wifi.example", card.inner_text(), "a result the answer does not cite is not listed as its source")
        shot(jo, "private-ai-1440-web-search-sources")
        sent = [item for item in mock("/__requests")["requests"] if item["path"] == "/v1/messages"]
        self.assertIn({"type": "web_search_20250305", "name": "web_search"}, sent[-1]["body"]["tools"], "Anthropic's own search was offered, with no limit on its searches")
        card.get_by_role("button", name="Dismiss").click()
        expect(card).to_have_count(0)

    # ---------------------------------------------------------------- a thread

    def test_03_in_a_thread_dismiss_puts_it_away_and_a_reload_does_not_bring_it_back(self) -> None:
        mock("/__script", {"reset": True, "text": "Interpretation: the hedge is the reason [S1]."})
        jo = self.thread("jo")
        kai = self.thread("kai")
        self.ask_in(jo, "#thread-composer", "why LoRa?")
        card = self.private_card(jo)
        expect(card).to_be_visible(timeout=20000)
        expect(card).to_contain_text("hedge is the reason")
        expect(self.private_card(kai)).to_have_count(0)
        expect(kai.locator(".assistant-working")).to_have_count(0)
        # A reload keeps the card until it is dealt with: it is the asker's own, kept for them.
        jo.reload()
        expect(self.private_card(jo)).to_be_visible()
        # Dismiss by keyboard: focus goes back to the box.
        box = jo.locator("#thread-composer")
        jo.get_by_role("button", name="Dismiss").focus()
        jo.keyboard.press("Enter")
        expect(self.private_card(jo)).to_have_count(0)
        expect(box).to_be_focused()
        jo.reload()
        expect(jo.locator("#thread-composer")).to_be_visible()
        expect(self.private_card(jo)).to_have_count(0)
        # And one shown in the thread is a reply of Jo's.
        self.ask_in(jo, "#thread-composer", "once more")
        expect(self.private_card(jo)).to_be_visible(timeout=20000)
        self.private_card(jo).get_by_role("button", name="Show everyone").click()
        posted = kai.locator(".project-convo__message").filter(has_text="hedge is the reason").last
        self.agent_answer(posted)
        self.agent_answer(jo.locator(".project-convo__message").filter(has_text="hedge is the reason").last)

    # ---------------------------------------------------------------- a direct message

    # ---------------------------------------------------------------- the `/` menu's suggestions (#1224)

    def test_03b_the_slash_menu_lists_each_places_own_suggestions_under_ai_and_choosing_one_asks(self) -> None:
        """#1224: no chips above or below a composer. `/` lists the actions, and the `/ai` row is followed by the suggestions of this place only,
        understand first and then act: a space's conversation, a thread and a task each have two, a direct message none. The rows are compact
        (at most 30 px with a mouse, at least 44 px on touch) and choosing one asks the assistant at once."""
        mock("/__script", {"reset": True, "text": ANSWER})
        project, work, dm = self.ids["project"], self.ids["work"], self.ids["dm"]
        places = [
            ("space", f"/projects/{project}", "#project-composer", ["Catch me up", "Tidy this space's tasks"]),
            ("thread", f"/projects/{project}/conversations/{self.ids['conversation']}", "#thread-composer", ["Catch me up on this thread", "Turn this thread into tasks"]),
            ("task", f"/projects/{project}/tasks?open=work:{work}", "#details .wd-composer textarea", ["Summarise this task", "What's left?"]),
            ("dm", f"/dm/{dm}", "#dm-composer", []),
        ]
        for dark in (False, True):
            for phone in (False, True):
                for name, url, composer, expected in places:
                    with self.subTest(place=name, phone=phone, dark=dark):
                        page = self.page("jo", phone=phone, dark=dark)
                        page.goto(url)
                        box = page.locator(composer)
                        expect(box).to_be_visible()
                        expect(page.locator(".assistant-suggestions")).to_have_count(0)
                        box.fill("/")
                        menu = page.get_by_role("listbox", name="Actions")
                        if not expected:
                            expect(menu).to_have_count(0)
                            continue
                        rows = menu.locator(".cmenu__o--ask")
                        expect(rows).to_have_count(len(expected))
                        expect(rows).to_contain_text(expected)
                        order = menu.locator(".cmenu__o").evaluate_all("(rows) => rows.map((row) => row.querySelector('code, .cmenu__name').textContent)")
                        self.assertEqual(order[-(len(expected) + 1):], ["/ai", *expected], "under /ai, understand first and then act")
                        if name == "task":
                            self.assertEqual(order, ["/ai", *expected], "a task's box has no other slash command")
                        for row in rows.all():
                            height = row.bounding_box()["height"]
                            self.assertTrue(height >= 44 if phone else height <= 30, f"{name}: row is {height} px")
                        suggestions_reachable(self, menu, rows)
                        self.assertIsNone(menu_clipped_by(page, menu), f"{name}: the menu sits inside the pane or sheet")
                        self.no_horizontal_scroll(page)
                        shot(page, f"suggestions-{name}-{'390' if phone else '1440'}-{'dark' if dark else 'light'}")

    def test_03c_choosing_a_suggestion_asks_at_once_and_the_answer_is_private_in_a_thread_and_a_task(self) -> None:
        mock("/__script", {"reset": True, "text": ANSWER})
        # Each card is found by what it says it was asked, so cards that other tests left in these places are not mistaken for it.
        jo = self.thread("jo")
        jo.locator("#thread-composer").fill("/")
        jo.get_by_role("listbox", name="Actions").get_by_role("option", name="Ask your assistant: Catch me up on this thread", exact=True).click()
        expect(jo.locator("#thread-composer")).to_have_value("")
        card = self.private_card(jo).filter(has_text="You asked: /ai Catch me up on this thread")
        expect(card).to_be_visible(timeout=20000)
        expect(card).to_contain_text("Only you can see this")
        expect(card).to_contain_text("far beds will use LoRa")
        task = self.page("jo")
        task.goto(f"/projects/{self.ids['project']}/tasks?open=work:{self.ids['work']}")
        box = task.locator("#details .wd-composer textarea")
        box.fill("/")
        # The keyboard works in the menu as in the others: the arrows move over `/ai` and its suggestions, one key at a time, and Enter chooses.
        menu = task.get_by_role("listbox", name="Actions")
        # The suggestions join `/ai` once the assistant's status has been read: the keys are pressed on the whole list, as a person sees it.
        expect(menu.locator(".cmenu__o--ask")).to_have_count(2)
        expect(menu.get_by_role("option", selected=True)).to_contain_text("/ai")
        box.press("ArrowDown")
        expect(menu.get_by_role("option", selected=True)).to_have_attribute("aria-label", "Ask your assistant: Summarise this task")
        box.press("ArrowDown")
        expect(menu.get_by_role("option", selected=True)).to_have_attribute("aria-label", "Ask your assistant: What's left?")
        box.press("ArrowDown")
        expect(menu.get_by_role("option", selected=True)).to_contain_text("/ai")
        box.press("ArrowUp")
        expect(menu.get_by_role("option", selected=True)).to_have_attribute("aria-label", "Ask your assistant: What's left?")
        box.press("Enter")
        expect(box).to_have_value("")
        asked = task.locator("#details .assistant-private").filter(has_text="You asked: /ai What's left?")
        expect(asked).to_be_visible(timeout=20000)
        # `/ai` itself fills the box with the command, as typing it would, and the words around the "/" stay.
        box.fill("check the probes")
        box.press("Home")
        box.press("/")
        expect(menu.locator(".cmenu__o--ask")).to_have_count(2)
        expect(menu.get_by_role("option", selected=True)).to_contain_text("/ai")
        box.press("Enter")
        expect(box).to_have_value("/ai check the probes")
        expect(task.locator("#details .wd-foot__line")).to_contain_text("Only you see the answer")
        box.fill("")
        # What was asked here is Jo's alone and stays until it is put away: leave the task and the thread as they were.
        for page, answer in ((task, asked), (jo, card)):
            answer.get_by_role("button", name="Dismiss").click()
            expect(answer).to_have_count(0)

    def test_04_in_a_direct_message_both_people_see_one_line_and_only_jo_the_answer(self) -> None:
        mock("/__script", {"reset": True, "text": "Fact: you two agreed to meet on Thursday [S1]."})
        jo = self.dm("jo")
        kai = self.dm("kai")
        jo.locator("#dm-composer").fill("/ai what did we agree?")
        expect(jo.locator(".composer__audience[data-asking]")).to_contain_text("Only you see the answer")
        expect(jo.locator(".composer__audience[data-asking]")).to_contain_text("Kai sees only a line that AI was used here")
        jo.get_by_role("button", name="Ask your agent").click()
        expect(jo.locator(".dm-notice__line")).to_have_text("You used AI here (Claude)", timeout=15000)
        expect(kai.locator(".dm-notice__line")).to_have_text("Jo Weber used AI here (Claude)", timeout=15000)
        card = self.private_card(jo)
        expect(card).to_be_visible(timeout=20000)
        expect(card).to_contain_text("Thursday")
        expect(self.private_card(kai)).to_have_count(0)
        expect(kai.locator(".assistant-working")).to_have_count(0)
        sent = [item for item in mock("/__requests")["requests"] if item["path"] == "/v1/messages"]
        self.assertIn(DM_TOKEN, json.dumps(sent[-1]["body"]))
        self.assertNotIn(OPENING, json.dumps(sent[-1]["body"]), "the DM is all the model was given")
        # A DM run's tools reach only this direct message (finding, reading around and summarising its messages, F-042 #1290-#1292) and read the
        # web: a public page (#918) and, on by default, the provider's own search (#954). Nothing that writes or reaches a space.
        self.assertTrue({tool["name"] for tool in sent[-1]["body"].get("tools", [])}
                        <= {"flux_read_around", "flux_read_web", "flux_search", "flux_summarize", "web_search"}, sent[-1]["body"].get("tools"))
        shot(jo, "private-ai-1440-direct-message")
        card.get_by_role("button", name="Show everyone").click()
        expect(card).to_have_count(0)
        posted = kai.locator(".dm-msg").filter(has_text="you two agreed to meet on Thursday")
        self.agent_answer(posted)
        self.agent_answer(jo.locator(".dm-msg").filter(has_text="you two agreed to meet on Thursday"))
        # The line is no message: the list shows the last words, not "Claude".
        kai.goto("/dm")
        expect(kai.get_by_text("you two agreed to meet on Thursday").first).to_be_visible()
        expect(kai.get_by_text("used AI here")).to_have_count(0)

    # ---------------------------------------------------------------- a thread of a direct message

    def test_04b_in_a_direct_messages_thread_the_card_is_in_the_thread_and_show_everyone_replies_there(self) -> None:
        mock("/__script", {"reset": True, "text": "Fact: the thread settled on Thursday for the planting [S1]."})
        root_words, reply_words = "Planting day: Thursday or Friday?", "Thursday, the soil is ready."
        kai_api = self.page("kai")
        root = self.api(kai_api, "POST", f"/api/v1/dms/{self.ids['dm']}/messages", {"body": root_words, "clientMessageId": str(uuid.uuid4())}, status=201)
        self.api(kai_api, "POST", f"/api/v1/dms/{self.ids['dm']}/threads/{root['id']}/replies", {"body": reply_words, "clientMessageId": str(uuid.uuid4())}, status=201)

        def open_thread(who: str) -> Page:
            page = self.page(who)
            page.goto(f"/dm/{self.ids['dm']}?thread={root['id']}")
            expect(page.locator("#dm-thread-composer")).to_be_visible()
            return page

        jo, kai = open_thread("jo"), open_thread("kai")
        lines_before = kai.locator(".dm-notice__line").count()
        jo.locator("#dm-thread-composer").fill("/ai what did we settle?")
        audience = jo.locator(".dm-thread__composer .composer__audience[data-asking]")
        expect(audience).to_contain_text("Only you see the answer")
        expect(audience).to_contain_text("Kai sees only a line that AI was used here")
        jo.locator(".dm-thread__composer").get_by_role("button", name="Ask your agent").click()
        # The card is in the thread's panel and nowhere else; the others see only the line, in the conversation.
        card = jo.locator(".dm-thread .assistant-private")
        expect(card).to_be_visible(timeout=20000)
        expect(card).to_contain_text("Only you can see this")
        expect(card).to_contain_text("settled on Thursday")
        expect(card).to_contain_text("Kai doesn’t see this. Show everyone posts it as “Jo's Assistant”.")
        expect(jo.locator("#dm-thread-composer")).to_have_value("")
        expect(jo.locator(".dm__feed .assistant-private")).to_have_count(0)
        expect(kai.locator(".assistant-private")).to_have_count(0)
        expect(kai.locator(".assistant-working")).to_have_count(0)
        expect(kai.locator(".dm-notice__line")).to_have_count(lines_before + 1, timeout=15000)
        expect(kai.locator(".dm-notice__line").last).to_have_text("Jo Weber used AI here (Claude)")
        expect(jo.locator(".dm-thread .dm-notice__line")).to_have_count(0)
        # The model was given this thread, not the conversation's other messages and not the space.
        given = json.dumps([item for item in mock("/__requests")["requests"] if item["path"] == "/v1/messages"][-1]["body"])
        self.assertIn(root_words, given)
        self.assertIn(reply_words, given)
        self.assertNotIn(DM_TOKEN, given, "the thread is all the model was given")
        self.assertNotIn(OPENING, given)
        shot(jo, "private-ai-1440-dm-thread")
        # A reload keeps the card for its asker.
        jo.reload()
        expect(jo.locator(".dm-thread .assistant-private")).to_be_visible(timeout=15000)
        # Show everyone: Jo's reply in the thread, "Jo's Assistant", not a message of the conversation.
        jo.locator(".dm-thread .assistant-private").get_by_role("button", name="Show everyone").click()
        expect(jo.locator(".dm-thread .assistant-private")).to_have_count(0)
        posted = kai.locator(".dm-thread .dm-msg").filter(has_text="settled on Thursday for the planting")
        self.agent_answer(posted)
        self.agent_answer(jo.locator(".dm-thread .dm-msg").filter(has_text="settled on Thursday for the planting"))
        expect(kai.locator(".dm__feed").get_by_text("settled on Thursday for the planting")).to_have_count(0)
        thread = self.api(kai, "GET", f"/api/v1/dms/{self.ids['dm']}/threads/{root['id']}", status=200)
        self.assertEqual([(message["authorId"], message.get("via")) for message in thread["replies"] if message.get("via")], [(JO["id"], "Assistant")])

    # ---------------------------------------------------------------- Show everyone right after the asker's own message (review of #1105)

    def overlap(self, a: dict, b: dict) -> bool:
        return not (a["x"] + a["width"] <= b["x"] or b["x"] + b["width"] <= a["x"] or a["y"] + a["height"] <= b["y"] or b["y"] + b["height"] <= a["y"])

    def test_04c_in_a_direct_message_an_answer_after_the_askers_own_message_keeps_its_mark_on_both_devices(self) -> None:
        for phone, size in ((False, "1440"), (True, "390")):
            with self.subTest(size=size):
                words = f"the soil probes need calibrating on Monday ({size})"
                mock("/__script", {"reset": True, "text": f"Fact: {words} [S1]"})
                jo, kai = self.dm("jo", phone=phone), self.dm("kai", phone=phone)
                jo.locator("#dm-composer").fill("/ai when do we calibrate?")
                jo.get_by_role("button", name="Ask your agent").click()
                card = self.private_card(jo)
                expect(card).to_be_visible(timeout=20000)
                # Jo's own message comes after the "used AI here" line and before the answer is shown: the answer would follow it as one run.
                self.api(jo, "POST", f"/api/v1/dms/{self.ids['dm']}/messages", {"body": f"One moment, asking my assistant ({size})", "clientMessageId": str(uuid.uuid4())}, status=201)
                expect(kai.locator(".dm-msg").filter(has_text=f"asking my assistant ({size})")).to_be_visible(timeout=15000)
                card.get_by_role("button", name="Show everyone").click()
                expect(card).to_have_count(0)
                posted = kai.locator(".dm-msg").filter(has_text=words)
                expect(posted).to_be_visible(timeout=15000)
                expect(posted).not_to_have_class(re.compile(r"dm-msg--cont"))
                self.agent_answer(posted)
                shot(kai, f"private-ai-{size}-dm-answer-after-own-message")
                # Jo reads it as her agent's message, on the left under its label, not as one more bubble of her own (#1232).
                mine = jo.locator(".dm-msg").filter(has_text=words)
                self.agent_answer(mine)
                if phone:
                    self.assertFalse(self.overlap(mine.locator(".dm-msg__meta").bounding_box(), mine.locator(".msg-touch__sr").bounding_box()), "Jo's ⋯ is not over her label")
                    shot(jo, f"private-ai-{size}-dm-answer-after-own-message-jo")
                # The list names the mark before the words: it is an answer, not something Jo typed.
                kai.goto("/dm")
                expect(kai.locator(".dm-index__text").first).to_contain_text(f"via Assistant: Fact: {words}")

    def test_04d_in_a_direct_messages_thread_an_answer_after_the_askers_own_reply_keeps_its_mark_on_both_devices(self) -> None:
        for phone, size in ((False, "1440"), (True, "390")):
            with self.subTest(size=size):
                words = f"the thread agreed on a Monday run ({size})"
                mock("/__script", {"reset": True, "text": f"Fact: {words} [S1]"})
                kai_api = self.page("kai")
                root = self.api(kai_api, "POST", f"/api/v1/dms/{self.ids['dm']}/messages", {"body": f"Calibration day ({size}): Monday?", "clientMessageId": str(uuid.uuid4())}, status=201)
                jo, kai = self.page("jo", phone=phone), self.page("kai", phone=phone)
                for page in (jo, kai):
                    page.goto(f"/dm/{self.ids['dm']}?thread={root['id']}")
                    expect(page.locator("#dm-thread-composer")).to_be_visible()
                jo.locator("#dm-thread-composer").fill("/ai what did we settle?")
                jo.locator(".dm-thread__composer").get_by_role("button", name="Ask your agent").click()
                card = jo.locator(".dm-thread .assistant-private")
                expect(card).to_be_visible(timeout=20000)
                # Jo's own reply, then the answer shown: no "used AI here" line stands between them in a thread.
                self.api(jo, "POST", f"/api/v1/dms/{self.ids['dm']}/threads/{root['id']}/replies", {"body": f"Let me check ({size})", "clientMessageId": str(uuid.uuid4())}, status=201)
                expect(kai.locator(".dm-thread .dm-msg").filter(has_text=f"Let me check ({size})")).to_be_visible(timeout=15000)
                card.get_by_role("button", name="Show everyone").click()
                expect(card).to_have_count(0)
                posted = kai.locator(".dm-thread .dm-msg").filter(has_text=words)
                expect(posted).to_be_visible(timeout=15000)
                expect(posted).not_to_have_class(re.compile(r"dm-msg--cont"))
                self.agent_answer(posted)
                shot(kai, f"private-ai-{size}-dm-thread-answer-after-own-reply")
                mine = jo.locator(".dm-thread .dm-msg").filter(has_text=words)
                self.agent_answer(mine)
                if phone:
                    self.assertFalse(self.overlap(mine.locator(".dm-msg__meta").bounding_box(), mine.locator(".msg-touch__sr").bounding_box()), "Jo's ⋯ is not over her label")
                    shot(jo, f"private-ai-{size}-dm-thread-answer-after-own-reply-jo")

    # ---------------------------------------------------------------- the task's thread

    def test_05_in_a_tasks_thread_the_answer_shows_in_the_task_and_posts_into_its_discussion(self) -> None:
        mock("/__script", {"reset": True, "text": "Fact: six probes are ordered, two more wait for the school [S1]."})
        jo = self.page("jo")
        jo.goto(f"/projects/{self.ids['project']}/tasks?open=work:{self.ids['work']}")
        box = jo.locator("#details .wd-composer textarea")
        expect(box).to_be_visible()
        box.fill("/ai where is this task?")
        expect(jo.locator("#details .wd-foot__line")).to_contain_text("Only you see the answer")
        jo.get_by_role("button", name="Send to task").click()
        card = jo.locator("#details .assistant-private")
        expect(card).to_be_visible(timeout=20000)
        expect(card).to_contain_text("six probes are ordered")
        card.get_by_role("button", name="Show everyone").click()
        expect(card).to_have_count(0)
        talk = self.api(jo, "GET", f"/api/v1/work/{self.ids['work']}/discussion", status=200)
        posted = [message for message in [talk["root"], *talk["messages"]] if message and message.get("via")]
        self.assertEqual([(message["authorId"], message["via"]) for message in posted], [(JO["id"], "Assistant")])
        self.agent_answer(jo.locator("#details .wd-act__item").filter(has_text="six probes are ordered"))

    def test_05b_a_shown_answer_is_the_agents_message_for_the_asker_a_member_and_a_guest_on_both_devices_in_light_and_dark(self) -> None:
        # #1232: "Jo's Assistant", its Kreska in the agent's colour and the Agent tag, the agent's bubble on the left: for the asker too, for another
        # member, for a guest of the company, in the stream, as a thread's opening message and as a reply in a thread.
        words = "far beds will use LoRa"
        roots = self.api(self.page("jo"), "GET", f"/api/v1/projects/{self.ids['project']}/conversation-roots", status=200)["roots"]
        shown_root = next(root for root in roots if root["message"].get("via") and words in root["message"]["body"])
        self.assertEqual([shown_root["message"]["authorId"], shown_root["message"]["via"], shown_root["message"]["viaColour"]], [JO["id"], "Assistant", "ink"])
        for dark in (False, True):
            for phone, size in ((False, "1440"), (True, "390")):
                with self.subTest(dark=dark, size=size):
                    theme = "dark" if dark else "light"
                    for who, role in (("jo", "asker"), ("kai", "member"), ("lee", "guest")):
                        page = self.space(who, phone=phone, dark=dark)
                        posted = page.locator(".project-convo__message").filter(has_text=words)
                        self.agent_answer(posted)
                        self.no_horizontal_scroll(page)
                        shot(page, f"shown-answer-{size}-{theme}-{role}-stream")
                        page.goto(f"/projects/{self.ids['project']}/conversations/{shown_root['conversationId']}")
                        self.agent_answer(page.locator(".thread__root").filter(has_text=words))
                        self.no_horizontal_scroll(page)
                        shot(page, f"shown-answer-{size}-{theme}-{role}-thread-root")
                    page = self.thread("jo", phone=phone, dark=dark)
                    reply = page.locator(".project-convo__message").filter(has_text="hedge is the reason").last
                    self.agent_answer(reply)
                    shot(page, f"shown-answer-{size}-{theme}-asker-thread-reply")

    # ---------------------------------------------------------------- a guest

    def test_06_a_guest_has_no_ai_and_the_words_are_not_sent_as_a_question(self) -> None:
        lee = self.thread("lee")
        lee.locator("#thread-composer").fill("/ai summarise")
        expect(lee.locator("#project-ask")).to_have_count(0)
        lee.get_by_role("button", name="Send reply").click()
        expect(lee.locator(".project-convo__hint")).to_contain_text("Guests don’t have AI.")
        expect(lee.locator("#thread-composer")).to_have_value("/ai summarise")
        talk = self.api(lee, "GET", f"/api/v1/conversations/{self.ids['conversation']}", status=200)
        self.assertFalse([message for message in talk["messages"] if message["body"].startswith("/ai")], "nothing was posted")
        # The slash menu does not offer it either.
        lee.locator("#thread-composer").fill("/")
        expect(lee.locator('[role="option"]').filter(has_text="/task")).to_have_count(1)
        expect(lee.locator('[role="option"]').filter(has_text="/ai")).to_have_count(0)
        # The server agrees: a guest has no agent to ask.
        self.assertEqual(lee.request.fetch(f"{ORIGIN}/api/v1/conversations/{self.ids['conversation']}/assistant-runs", method="POST",
                                           headers={"origin": ORIGIN, "content-type": "application/json"},
                                           data=json.dumps({"clientRunId": str(uuid.uuid4()), "kind": "ask", "prompt": "x"})).status, 409)

    def test_06c_a_guest_sees_no_ask_bar_or_ai_hint_in_a_conversation_a_task_or_a_direct_message_on_either_device(self) -> None:
        # #1034: nothing of `/ai` for a guest, anywhere they talk: the space's conversation, a thread, a task's thread and a direct message.
        dm = self.api(self.page("jo"), "POST", f"/api/v1/workspaces/{self.ids['workspace']}/dms", {"participantIds": [LEE["id"]]}, status=201)
        ai_words = re.compile("Connect your AI|Ask your assistant|Ask your agent|Only you see the answer|Send to your assistant|My assistant|Meet your assistant")
        for phone in (False, True):
            with self.subTest(phone=phone):
                lee = self.page("lee", phone=phone)
                for address, field in ((f"/projects/{self.ids['project']}", "#project-composer"),
                                       (f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}", "#thread-composer"), (f"/dm/{dm['id']}", "#dm-composer")):
                    lee.goto(address)
                    box = lee.locator(field)
                    expect(box).to_be_visible()
                    box.fill("/ai summarise this")
                    expect(lee.locator("#project-ask, [data-asking]")).to_have_count(0)
                    expect(lee.get_by_text(ai_words)).to_have_count(0)
                    expect(lee.get_by_role("button", name=re.compile("Ask your|Send to your assistant"))).to_have_count(0)
                    expect(lee.locator("[data-ai-surface], .assistant-private, .assistant-working")).to_have_count(0)
                    if field != "#dm-composer":
                        # Neither menu offers AI: not `/ai` or `/handoff`, not "My assistant", no agent of anyone's.
                        box.fill("/")
                        expect(lee.locator('[role="option"]').filter(has_text="/task")).to_have_count(1)
                        expect(lee.locator('[role="option"]').filter(has_text=re.compile("/ai|/handoff"))).to_have_count(0)
                        box.fill("@")
                        expect(lee.locator('[role="option"]').filter(has_text=re.compile("My assistant|Agent"))).to_have_count(0)
                self.no_horizontal_scroll(lee)
                # The task's thread: the same words are only words, and the line under the box does not promise a private answer.
                lee.goto(f"/projects/{self.ids['project']}/tasks?open=work:{self.ids['work']}")
                task_box = lee.get_by_label(re.compile("Write to this task|First message about this task"))
                expect(task_box).to_be_visible()
                task_box.fill("/ai where is this task?")
                expect(lee.get_by_text(ai_words)).to_have_count(0)
                expect(lee.locator(".assistant-private, .assistant-working")).to_have_count(0)
                expect(lee.get_by_role("button", name=re.compile("Send to task|Start the discussion"))).to_be_visible()
        # Messages lists no agent of hers.
        desktop = self.page("lee")
        desktop.goto("/")
        expect(desktop.get_by_role("heading", level=1, name="Home")).to_be_visible()
        expect(desktop.locator("[data-agent]")).to_have_count(0)

    def test_06d_a_member_made_a_guest_loses_the_ask_bar_without_a_reload(self) -> None:
        # #1034: the shell reads the role again when it changes, so the bar of someone made a guest goes at once instead of staying until a reload.
        kai = self.thread("kai")
        kai.locator("#thread-composer").fill("/ai what did we decide?")
        expect(kai.locator("#project-ask")).to_be_visible()
        jo = self.page("jo")
        members = f"/api/v1/workspaces/{self.ids['workspace']}/members/{KAI['id']}"
        self.api(jo, "PATCH", members, {"role": "guest"}, status=200)
        try:
            expect(kai.locator("#project-ask")).to_have_count(0, timeout=15000)
            expect(kai.get_by_text(re.compile("Connect your AI|Ask your assistant"))).to_have_count(0)
        finally:
            self.api(jo, "PATCH", members, {"role": "member"}, status=200)

    def test_06b_someone_outside_the_audience_cannot_ask_in_a_place_they_cannot_read(self) -> None:
        # Mia is in the company but in neither the space nor the direct message: no door of `/ai` opens for her, whatever agent she has.
        mia = self.page("mia")
        body = {"clientRunId": str(uuid.uuid4()), "kind": "ask", "prompt": "What did they decide?"}
        for path in (f"/api/v1/conversations/{self.ids['conversation']}/assistant-runs", f"/api/v1/projects/{self.ids['project']}/assistant-runs",
                     f"/api/v1/dms/{self.ids['dm']}/assistant-runs"):
            response = mia.request.fetch(f"{ORIGIN}{path}", method="POST", headers={"origin": ORIGIN, "content-type": "application/json"}, data=json.dumps(body))
            self.assertEqual(response.status, 404, path)
        # Nor does she reach Jo's agent chat, or Jo's runs, or Show everyone for them.
        self.assertEqual(mia.request.fetch(f"{ORIGIN}/api/v1/my-agents/{self.ids['agent']}/assistant-runs", method="POST",
                                           headers={"origin": ORIGIN, "content-type": "application/json"}, data=json.dumps(body)).status, 404)
        jo = self.page("jo")
        runs = self.api(jo, "GET", "/api/v1/assistant-runs?limit=5", status=200)["items"]
        self.assertTrue(runs)
        for path in (f"/api/v1/assistant-runs/{runs[0]['id']}", f"/api/v1/assistant-runs/{runs[0]['id']}/show", f"/api/v1/assistant-runs/{runs[0]['id']}/dismiss"):
            response = mia.request.fetch(f"{ORIGIN}{path}", method="POST" if path.endswith(("show", "dismiss")) else "GET", headers={"origin": ORIGIN})
            self.assertEqual(response.status, 404, path)
        page = self.page("mia")
        page.goto(f"/projects/{self.ids['project']}")
        expect(page.locator("#project-composer")).to_have_count(0)

    # ---------------------------------------------------------------- the agent's private chat

    def test_07_an_agent_has_a_private_chat_with_a_box_to_write_in(self) -> None:
        mock("/__script", {"reset": True, "delay": 1.5, "text": "Hello Jo. Nothing waits for you today."})
        jo = self.page("jo")
        jo.goto(f"/settings/agents/{self.ids['agent']}")
        jo.get_by_role("link", name="Message Assistant").click()
        expect(jo).to_have_url(re.compile(rf"/agents/{self.ids['agent']}$"))
        expect(jo.get_by_text("Only you talk to Assistant")).to_be_visible()
        box = jo.locator("#agent-composer")
        expect(box).to_be_focused()
        box.fill("Say hello")
        jo.get_by_role("button", name="Send to Assistant").click()
        expect(box).to_have_value("")
        turn = jo.locator("[data-chat-me]").filter(has_text="Say hello")
        expect(turn).to_be_visible()
        answer = jo.locator("[data-chat-agent]").filter(has_text="Nothing waits for you today")
        expect(answer).to_be_visible(timeout=20000)
        shot(jo, "private-ai-1440-agent-chat")
        # It is still there after a reload, in order; the chat has no Show everyone.
        jo.reload()
        expect(jo.locator("[data-chat-me]").filter(has_text="Say hello")).to_be_visible()
        expect(jo.locator("[data-chat-agent]").filter(has_text="Nothing waits for you today")).to_be_visible()
        expect(jo.get_by_role("button", name="Show everyone")).to_have_count(0)
        # Nobody else reads it, or reaches the agent.
        kai = self.page("kai")
        kai.goto(f"/agents/{self.ids['agent']}")
        expect(kai.get_by_text("This agent isn’t here")).to_be_visible()
        self.assertEqual(self.api(kai, "GET", f"/api/v1/assistant-runs?chatAgentId={self.ids['agent']}", status=200)["items"], [])
        # Words typed in it are never "/ai": a chat is the agent's own conversation.
        runs = self.api(jo, "GET", f"/api/v1/assistant-runs?chatAgentId={self.ids['agent']}", status=200)["items"]
        self.assertEqual([(run["projectId"], run["conversationId"], run["dmId"]) for run in runs], [(None, None, None)])

    # ---------------------------------------------------------------- the phone

    def test_08_on_the_phone_the_card_fits_and_its_buttons_are_big_enough(self) -> None:
        mock("/__script", {"reset": True, "text": "Fact: " + "the far beds will use LoRa because the hedge is wet. " * 6 + "[S1]"})
        jo = self.thread("jo", phone=True)
        self.ask_in(jo, "#thread-composer", "summarise it")
        card = self.private_card(jo).last
        expect(card).to_be_visible(timeout=20000)
        card.scroll_into_view_if_needed()
        self.no_horizontal_scroll(jo)
        for name in ("Dismiss", "Show everyone"):
            box = card.get_by_role("button", name=name).bounding_box()
            self.assertIsNotNone(box)
            self.assertGreaterEqual(box["height"], 43, f"{name} is a touch target")
        shot(jo, "private-ai-390-card")
        chat = self.page("jo", phone=True)
        chat.goto(f"/agents/{self.ids['agent']}")
        expect(chat.locator("#agent-composer")).to_be_visible()
        self.no_horizontal_scroll(chat)
        shot(chat, "private-ai-390-agent-chat")

    def test_09_the_suggestions_are_not_offered_while_the_assistant_is_not_ready_after_three_uses_or_with_ai_off(self) -> None:
        """#1224: the rows follow `/ai`, and `/ai` itself goes with AI. Kai has no assistant yet; Jo has used hers three times on this device;
        and in a space whose AI is off there is no `/ai` at all."""
        def rows(page, composer):
            page.locator(composer).fill("/")
            menu = page.get_by_role("listbox", name="Actions")
            expect(menu.get_by_role("option").first).to_be_visible()
            return menu
        # Not ready: the command is listed (it leads to the set-up), its suggestions are not.
        for place, composer in (("thread", "#thread-composer"), ("space", "#project-composer")):
            kai = self.thread("kai") if place == "thread" else self.space("kai")
            menu = rows(kai, composer)
            expect(menu.locator(".cmenu__cmd", has_text="/ai")).to_have_count(1)
            expect(menu.locator(".cmenu__o--ask")).to_have_count(0)
        # After three uses on this device (what the assistant remembers by itself): the same.
        for url, composer in ((f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}", "#thread-composer"),
                              (f"/projects/{self.ids['project']}", "#project-composer"),
                              (f"/projects/{self.ids['project']}/tasks?open=work:{self.ids['work']}", "#details .wd-composer textarea")):
            jo = self.page("jo")
            jo.add_init_script(f"localStorage.setItem('flux.assistant-uses.{JO['id']}', '3')")
            jo.goto(url)
            expect(jo.locator(composer)).to_be_visible()
            menu = rows(jo, composer)
            expect(menu.locator(".cmenu__cmd", has_text="/ai")).to_have_count(1)
            expect(menu.locator(".cmenu__o--ask")).to_have_count(0)
        # AI off in the space: no `/ai`, so nothing under it either.
        jo = self.page("jo")
        quiet = self.api(jo, "POST", f"/api/v1/workspaces/{self.ids['workspace']}/projects", {"name": "No AI here", "visibility": "restricted"}, status=201)
        self.api(jo, "PUT", f"/api/v1/projects/{quiet['id']}/ai-policy", {"state": "blocked"})
        jo.goto(f"/projects/{quiet['id']}")
        expect(jo.locator("#project-composer")).to_be_visible()
        menu = rows(jo, "#project-composer")
        expect(menu.locator(".cmenu__cmd", has_text="/task")).to_have_count(1)
        expect(menu.locator(".cmenu__cmd", has_text="/ai")).to_have_count(0)
        expect(menu.locator(".cmenu__o--ask")).to_have_count(0)

    # ---------------------------------------------------------------- the answer as it is written (#1248)

    def test_12_an_answer_appears_as_it_is_written_then_copy_and_try_again_and_stop_keeps_the_words(self) -> None:
        streamed = ("Fact: the far beds will use LoRa because Wi-Fi drops when the hedge is wet {first}. "
                    + "The gateway stays near the shed, where the power is. " * 4).strip()
        mock("/__script", {"reset": True, "text": streamed, "stream_gap": 0.12})
        jo = self.thread("jo")
        if UI_BROWSER == "chromium":
            jo.context.grant_permissions(["clipboard-read", "clipboard-write"], origin=ORIGIN)
        kai = self.thread("kai")
        self.ask_in(jo, "#thread-composer", "how do the far beds connect")
        writing = jo.locator(".assistant-writing")
        expect(writing).to_be_visible(timeout=20000)
        expect(writing).to_contain_text("writing…")
        expect(writing).to_contain_text("Only you can see this")
        expect(writing.get_by_role("button", name="Stop")).to_be_visible()
        words = writing.locator("[data-writing-words]")
        first = words.inner_text().strip()
        self.assertTrue(first, "the first words show while it works")
        self.assertNotIn("[S", first, "source marks are not shown while it writes")
        # The text grows: later it is longer and begins with what was shown first.
        jo.wait_for_function("([el, n]) => el.innerText.trim().length > n + 20", arg=[words.element_handle(), len(first)], timeout=10000)
        self.assertTrue(words.inner_text().strip().startswith(first[:20]))
        expect(writing.locator(".assistant-writing__caret")).to_have_count(1)
        # The thread panel follows the growing words while Jo is at its end: the newest words and Stop stay in view, unscrolled.
        jo.wait_for_function("([el, n]) => el.innerText.trim().length > n + 60", arg=[words.element_handle(), len(first)], timeout=10000)
        expect(writing.get_by_role("button", name="Stop")).to_be_in_viewport()
        expect(writing.locator(".assistant-writing__caret")).to_be_in_viewport()
        shot(jo, "streaming-1440-writing-light")
        jo.emulate_media(color_scheme="dark")
        shot(jo, "streaming-1440-writing-dark")
        jo.emulate_media(color_scheme="light")
        # Nobody else sees the words.
        expect(kai.locator(".assistant-writing")).to_have_count(0)
        self.assertNotIn("The gateway stays near the shed", kai.locator("body").inner_text())

        # Done: the answer card, with Copy and Try again in its own quiet line.
        card = jo.locator(".assistant-private").filter(has_text="The gateway stays near the shed").last
        expect(card).to_contain_text("Show everyone posts it", timeout=20000)
        expect(writing).to_have_count(0)
        final = ("Fact: the far beds will use LoRa because Wi-Fi drops when the hedge is wet. "
                 + "The gateway stays near the shed, where the power is. " * 4).strip()
        card.get_by_role("button", name="Copy").click()
        expect(card.get_by_role("button", name="Copied")).to_be_visible()
        if UI_BROWSER == "chromium":
            self.assertEqual(jo.evaluate("navigator.clipboard.readText()"), final, "Copy copies the final answer's words")
        shot(jo, "streaming-1440-done-light")
        jo.emulate_media(color_scheme="dark")
        shot(jo, "streaming-1440-done-dark")
        jo.emulate_media(color_scheme="light")

        # Try again: a new run of the same request, slower this time; Stop while it writes keeps the words so far, marked stopped.
        mock("/__script", {"text": "Second try: the far beds use LoRa. " * 12, "stream_gap": 0.3})
        before = len([item for item in mock("/__requests")["requests"] if item["path"] == "/v1/messages"])
        card.get_by_role("button", name="Try again").click()
        again = jo.locator(".assistant-writing")
        expect(again).to_contain_text("Second try", timeout=20000)
        self.assertEqual(len([item for item in mock("/__requests")["requests"] if item["path"] == "/v1/messages"]), before + 1, "Try again starts one new run")
        again.get_by_role("button", name="Stop").click()
        stopped = jo.locator(".assistant-private").filter(has_text="Second try").last
        expect(stopped).to_contain_text("Stopped by you, so this answer is incomplete.", timeout=20000)
        expect(stopped.get_by_role("button", name="Copy")).to_be_visible()
        expect(stopped.get_by_role("button", name="Show everyone")).to_be_visible()
        self.assertLess(stopped.locator(".assistant-answer__body").inner_text().count("Second try"), 12, "only what was written before Stop")

    def test_13_on_the_phone_the_growing_answer_fits_and_reduced_motion_types_nothing(self) -> None:
        mock("/__script", {"reset": True, "text": "First paragraph about the far beds and LoRa.\n\n" + "The gateway stays near the shed. " * 30, "stream_gap": 0.1})
        jo = self.thread("jo", phone=True)
        self.ask_in(jo, "#thread-composer", "explain the network")
        writing = jo.locator(".assistant-writing")
        expect(writing).to_be_visible(timeout=20000)
        # Nothing is scrolled by hand: the thread follows the words, and Stop stays clear of the suggestions under the feed.
        jo.wait_for_timeout(1500)
        stop = writing.get_by_role("button", name="Stop")
        expect(stop).to_be_in_viewport()
        chips = jo.locator(".assistant-suggestions").first
        if chips.count() and chips.is_visible():
            self.assertLessEqual(stop.bounding_box()["y"] + stop.bounding_box()["height"], chips.bounding_box()["y"] + 1, "Stop is above the suggestions row")
        self.no_horizontal_scroll(jo)
        box = stop.bounding_box()
        self.assertIsNotNone(box)
        self.assertGreaterEqual(box["height"], 43, "Stop is a touch target")
        shot(jo, "streaming-390-writing-light")
        jo.emulate_media(color_scheme="dark")
        shot(jo, "streaming-390-writing-dark")
        # Reduced motion: no caret, and only a finished paragraph shows.
        jo.emulate_media(color_scheme="light", reduced_motion="reduce")
        expect(writing.locator(".assistant-writing__caret")).to_have_count(0)
        expect(writing.locator("[data-writing-words]")).to_have_text("First paragraph about the far beds and LoRa.")
        card = jo.locator(".assistant-private").filter(has_text="The gateway stays near the shed").last
        expect(card).to_be_visible(timeout=30000)
        for name in ("Copy", "Try again"):
            tool = card.get_by_role("button", name=name).bounding_box()
            self.assertIsNotNone(tool)
            self.assertGreaterEqual(tool["height"], 43, f"{name} is a touch target")
        self.no_horizontal_scroll(jo)
        shot(jo, "streaming-390-done-light")

    def test_14_the_agents_chat_follows_its_growing_answer_and_keeps_stop_in_view(self) -> None:
        mock("/__script", {"reset": True, "text": "Here is the plan for the far beds. " * 40, "stream_gap": 0.05})
        jo = self.page("jo")
        jo.goto(f"/agents/{self.ids['agent']}")
        box = jo.locator("#agent-composer")
        box.fill("Plan the far beds")
        jo.get_by_role("button", name="Send to Assistant").click()
        bubble = jo.locator("[data-writing-run]")
        expect(bubble).to_be_visible(timeout=20000)
        jo.wait_for_function("(el) => el.innerText.length > 600", arg=bubble.element_handle(), timeout=15000)
        stop = jo.locator("[data-chat-agent]").last.get_by_role("button", name="Stop")
        expect(stop).to_be_in_viewport()
        expect(bubble.locator(".assistant-writing__caret")).to_be_in_viewport()
        shot(jo, "streaming-1440-chat-writing-light")
        answer = jo.locator("[data-chat-agent]").last
        expect(answer.get_by_role("button", name="Copy")).to_be_visible(timeout=30000)
        expect(answer.get_by_role("button", name="Try again")).to_be_in_viewport()


if __name__ == "__main__":
    unittest.main()
