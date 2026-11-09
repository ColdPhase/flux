"""Browser tests for `/ai` in every conversation, answered privately (#842, F-036 AG-4, mockups AiPrivate and AiAgents).

Runs with the other tests/ui journeys through scripts/check_ui.sh, on the TEST-ONLY mock provider (`FLUX_TEST_PERSONAL_RUNS=anthropic-mock`): the
real worker sends runs through the real Anthropic adapter to `tests/ui/anthropic_mock.py`. Nothing here calls a model; no test is a provider,
billing or compatibility pass.

Three people share a space: Jo (owns the assistant), Kai (contributor) and Lee (a guest of the company). Jo asks in the space's main conversation, in a
thread, in a direct message with Kai and in the task's thread; the answer is Jo's alone until Show everyone posts it as "Jo Weber · via Assistant".
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

    def context(self, who: str | None, *, phone: bool = False) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "color_scheme": "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw"}
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
        expect(card).to_contain_text("Kai and Lee don’t see this. Show everyone posts it as “Jo · via Assistant”.")
        shot(jo, "private-ai-1440-main-conversation")
        expect(self.private_card(kai)).to_have_count(0)
        self.assertNotIn("far beds will use LoRa because Wi-Fi drops when the hedge is wet [", kai.locator("body").inner_text(), "the others do not see the answer")
        # The cited source is one message of this space; nothing of the DM was sent.
        sent = [item for item in mock("/__requests")["requests"] if item["path"] == "/v1/messages"]
        self.assertEqual(len(sent), 1)
        self.assertIn(OPENING, json.dumps(sent[0]["body"]))
        self.assertNotIn(DM_TOKEN, json.dumps(sent[0]["body"]))
        # Show everyone: the card goes, the answer is Jo's own message for the others, naming the agent.
        card.get_by_role("button", name="Show everyone").click()
        expect(card).to_have_count(0)
        posted = kai.locator(".project-convo__message").filter(has_text="far beds will use LoRa")
        expect(posted).to_be_visible(timeout=15000)
        expect(posted).to_contain_text("Jo Weber")
        expect(posted).to_contain_text("via Assistant")
        expect(posted).not_to_contain_text("Source")
        # It stays gone after a reload: it was posted, not kept.
        jo.reload()
        expect(jo.locator(".project-convo__message").filter(has_text="far beds will use LoRa")).to_be_visible()
        expect(self.private_card(jo)).to_have_count(0)

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
        expect(posted).to_be_visible(timeout=15000)
        expect(posted).to_contain_text("via Assistant")

    # ---------------------------------------------------------------- a direct message

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
        # The only tools a DM run has read the web: a public page (#918) and, on by default, the provider's own search (#954).
        self.assertTrue({tool["name"] for tool in sent[-1]["body"].get("tools", [])} <= {"flux_read_web", "web_search"})
        shot(jo, "private-ai-1440-direct-message")
        card.get_by_role("button", name="Show everyone").click()
        expect(card).to_have_count(0)
        posted = kai.locator(".dm-msg").filter(has_text="you two agreed to meet on Thursday")
        expect(posted).to_be_visible(timeout=15000)
        expect(posted).to_contain_text("via Assistant")
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
        expect(card).to_contain_text("Kai doesn’t see this. Show everyone posts it as “Jo · via Assistant”.")
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
        # Show everyone: Jo's reply in the thread, "via Assistant", not a message of the conversation.
        jo.locator(".dm-thread .assistant-private").get_by_role("button", name="Show everyone").click()
        expect(jo.locator(".dm-thread .assistant-private")).to_have_count(0)
        posted = kai.locator(".dm-thread .dm-msg").filter(has_text="settled on Thursday for the planting")
        expect(posted).to_be_visible(timeout=15000)
        expect(posted).to_contain_text("via Assistant")
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
                expect(posted.locator(".dm-msg__meta")).to_contain_text("Jo Weber")
                expect(posted.locator(".dm-msg__via")).to_have_text("via Assistant")
                shot(kai, f"private-ai-{size}-dm-answer-after-own-message")
                mine = jo.locator(".dm-msg.is-mine").filter(has_text=words)
                expect(mine.locator(".dm-msg__via")).to_have_text("via Assistant")
                if phone:
                    self.assertFalse(self.overlap(mine.locator(".dm-msg__via").bounding_box(), mine.locator(".msg-touch__sr").bounding_box()), "Jo's ⋯ is not over her label")
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
                expect(posted.locator(".dm-msg__meta")).to_contain_text("Jo Weber")
                expect(posted.locator(".dm-msg__via")).to_have_text("via Assistant")
                shot(kai, f"private-ai-{size}-dm-thread-answer-after-own-reply")
                mine = jo.locator(".dm-thread .dm-msg.is-mine").filter(has_text=words)
                expect(mine.locator(".dm-msg__via")).to_have_text("via Assistant")
                if phone:
                    self.assertFalse(self.overlap(mine.locator(".dm-msg__via").bounding_box(), mine.locator(".msg-touch__sr").bounding_box()), "Jo's ⋯ is not over her label")
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
        expect(jo.locator("#details .wd-act__item").filter(has_text="six probes are ordered")).to_contain_text("via Assistant")

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
        expect(kai.get_by_text("This agent isn’t here.")).to_be_visible()
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


if __name__ == "__main__":
    unittest.main()
