"""Browser tests for the personal assistant in a project conversation (#68 AC-8, O-008, #57 design).

Runs with the other tests/ui journeys through scripts/check_ui.sh. That stack is composed with the
TEST-ONLY switch `FLUX_TEST_PERSONAL_RUNS=anthropic-mock`: every person has a fixture key
connection and the real worker sends runs through the real `@flux/agent-runtime` Anthropic
adapter to `tests/ui/anthropic_mock.py`. Nothing here calls a model; no test is a provider,
billing or compatibility pass. The production fail-closed states (provider off, no key) are
exercised against the production composition in tests/app/personal-runs.test.ts; here they are
only rendered from a stubbed status response, which proves wording, not behaviour.

Three people share one project: Jo (manager, owns the assistant), Kai (contributor, owns the
work) and Lee (viewer).
"""

from __future__ import annotations

import json
import os
import re
import time
import unittest
import urllib.request
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, Route, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

MOCK = os.environ.get("FLUX_ANTHROPIC_MOCK_URL", "http://127.0.0.1:8090")
PASSWORD = "an assistant that stays mine"
STAMP = int(time.time() * 1000)
JO = {"name": "Jo Weber", "email": f"jo.weber+{STAMP}@example.test"}
KAI = {"name": "Kai Lund", "email": f"kai.lund+{STAMP}@example.test"}
LEE = {"name": "Lee Park", "email": f"lee.park+{STAMP}@example.test"}
DM_TOKEN = f"DM-ONLY-{uuid.uuid4()}"
OPENING = "Camera or ToF sensor for the bedside lamp?"
KAI_REPLY = "The camera fails below 5 lux in the low-light test; the ToF sensor kept working with swipe + hold."
PROPOSAL_TEXT = ("Fact: the camera failed below 5 lux {first}.\n<proposal>"
                 '{{"fact": "The camera fails below 5 lux", "interpretation": "Exposure is too short for gestures in the dark", '
                 '"title": "Camera fails in low light", "finding": "negative", "evidence": "Low-light test, 20 gestures", "finishes": "{work}"}}'
                 "</proposal>")


def mock(path: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(f"{MOCK}{path}", data=data, method="POST" if body is not None else "GET",
                                     headers={"content-type": "application/json"})
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.loads(response.read())


class PersonalAssistantJourney(unittest.TestCase):
    """Tests run in name order and share three accounts and one project."""

    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
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

    def conversation(self, who: str, **kwargs) -> Page:
        """The conversation's thread, open beside the project's stream (UI116-1); the assistant is asked there."""
        page = self.page(who, **kwargs)
        page.goto(f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}")
        expect(self.opening(page)).to_contain_text(OPENING)
        return page

    def opening(self, page: Page):
        return page.get_by_role("complementary", name="Replies").locator(".thread__root")

    def composer(self, page: Page):
        return page.locator("#thread-composer")

    def ask(self, page: Page, prompt: str) -> None:
        box = self.composer(page)
        box.fill(f"/ai {prompt}")
        expect(page.get_by_role("button", name="Ask my assistant")).to_have_attribute("aria-pressed", "true")
        expect(box).to_have_value(prompt)
        page.get_by_role("button", name="Send to your assistant").click()

    def status(self, page: Page) -> dict:
        return self.api(page, "GET", "/api/v1/personal-assistant", status=200)

    def own_runs(self, page: Page) -> list[dict]:
        return self.api(page, "GET", "/api/v1/assistant-runs?limit=20", status=200)["items"]

    def no_horizontal_scroll(self, page: Page) -> None:
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), page.evaluate("window.innerWidth"))

    # ---------------------------------------------------------------- setup

    def test_01_three_people_share_a_project(self) -> None:
        for key, person in (("jo", JO), ("kai", KAI), ("lee", LEE)):
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
        ws = self.api(jo, "POST", "/api/v1/workspaces", {"name": "Lamp studio"}, status=201)
        for person in (KAI, LEE):
            self.api(jo, "POST", f"/api/v1/workspaces/{ws['id']}/members", {"email": person["email"], "role": "member"}, status=201)
        project = self.api(jo, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Gesture lamp", "visibility": "restricted"}, status=201)
        self.api(jo, "POST", f"/api/v1/projects/{project['id']}/grants", {"principal": {"kind": "human", "id": KAI["id"]}, "role": "contributor"}, status=201)
        self.api(jo, "POST", f"/api/v1/projects/{project['id']}/grants", {"principal": {"kind": "human", "id": LEE["id"]}, "role": "viewer"}, status=201)
        thread = self.api(jo, "POST", f"/api/v1/projects/{project['id']}/conversations", {"body": OPENING, "clientMessageId": str(uuid.uuid4())}, status=201)
        kai = self.page("kai")
        self.api(kai, "POST", f"/api/v1/conversations/{thread['id']}/messages", {"body": KAI_REPLY, "clientMessageId": str(uuid.uuid4())}, status=201)
        work = self.api(kai, "POST", f"/api/v1/projects/{project['id']}/work", {"title": "Camera in low light", "owner": {"kind": "human", "id": KAI["id"]}}, status=201)
        # A private DM the assistant must never read.
        dm = self.api(jo, "POST", f"/api/v1/workspaces/{ws['id']}/dms", {"participantIds": [KAI["id"]]}, status=201)
        self.api(jo, "POST", f"/api/v1/dms/{dm['id']}/messages", {"body": f"Between us: {DM_TOKEN}", "clientMessageId": str(uuid.uuid4())}, status=201)
        type(self).ids = {"workspace": ws["id"], "project": project["id"], "conversation": thread["id"], "work": work["id"]}

    # ---------------------------------------------------------------- not set up: explicit, human work goes on

    def test_02_not_set_up_says_so_and_human_work_continues(self) -> None:
        page = self.conversation("jo")
        ask = page.get_by_role("button", name="Ask my assistant")
        ask.click()
        expect(ask).to_have_attribute("aria-pressed", "true")
        bar = page.locator("#project-ask")
        expect(bar).to_contain_text("You haven’t set up your assistant. Nobody else’s can be used for you.")
        self.composer(page).fill("Summarize this for me")
        expect(page.get_by_role("button", name="Send to your assistant")).to_have_attribute("aria-disabled", "true")
        self.composer(page).press("Enter")
        expect(self.composer(page)).to_have_value("Summarize this for me")
        shot(page, "assistant-1440-not-set-up")
        bar.get_by_role("button", name="Connect your AI").click()
        panel = page.get_by_role("complementary", name="Details")
        expect(panel.get_by_role("link", name="Set up your assistant in Flux")).to_have_attribute("href", "/settings/assistant")
        page.get_by_role("button", name="Close details").click()
        # Esc returns to a plain reply; the person's own message is sent as usual.
        self.composer(page).focus()
        page.keyboard.press("Escape")
        expect(ask).to_have_attribute("aria-pressed", "false")
        self.composer(page).fill("Let's try the ToF sensor next.")
        page.get_by_role("button", name="Send reply").click()
        expect(page.locator(".project-convo__message").filter(has_text="Let's try the ToF sensor next.")).to_be_visible()
        self.assertEqual(self.own_runs(page), [], "nothing was run")

    def test_03_production_states_are_worded_truthfully(self) -> None:
        """Rendering only: the stub stands in for the production composition's real status."""
        page = self.page("jo")
        real = self.status(page)
        stub = {**real, "state": "not_enabled", "setup": {"provider": "off", "connection": "none"}}

        def fulfil(route: Route) -> None:
            if route.request.method == "GET":
                route.fulfill(status=200, content_type="application/json", body=json.dumps(stub))
            else:
                route.continue_()
        page.route("**/api/v1/personal-assistant", fulfil)
        page.goto("/settings/assistant")
        expect(page.get_by_role("heading", level=1, name="Your assistant")).to_be_visible()
        expect(page.get_by_text("In-app AI is turned off on this Flux server.")).to_be_visible()
        expect(page.get_by_role("button", name="Turn on my assistant")).to_be_disabled()
        shot(page, "assistant-1440-settings-provider-off")
        stub.update(state="unavailable", unavailableReason="provider_off", enablement={
            "ownerUserId": JO["id"], "connectionId": None, "perRunCents": 6, "dailyCapCents": 100, "timeZone": "Europe/Warsaw", "status": "active",
            "agents": [], "version": 1, "createdAt": "2026-09-30T08:00:00.000Z", "updatedAt": "2026-09-30T08:00:00.000Z",
            "consent": {"version": "o-008-2026-09-28", "acceptedAt": "2026-09-30T08:00:00.000Z", "provider": "anthropic", "model": "claude-sonnet-5",
                        "payer": {"organization": "Jo's org", "workspace": "Default"}}},
            today={"chargedMicros": 0, "reservedMicros": 0, "capCents": 100, "resetsAt": "2026-09-30T22:00:00.000Z"})
        page.goto(f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}")
        page.get_by_role("button", name="Ask my assistant").click()
        expect(page.locator("#project-ask")).to_contain_text("In-app AI is turned off on this Flux server, so nothing is sent.")
        expect(page.get_by_role("button", name="Send to your assistant")).to_have_attribute("aria-disabled", "true")
        stub.update(setup={"provider": "on", "connection": "none"}, unavailableReason="no_connection")
        page.reload()
        page.get_by_role("button", name="Ask my assistant").click()
        expect(page.locator("#project-ask")).to_contain_text("Your AI key isn’t connected, so nothing is sent.")

    # ---------------------------------------------------------------- consent and caps

    def test_04_owner_turns_it_on_from_the_account_menu(self) -> None:
        page = self.page("jo")
        page.goto("/")
        page.locator(".me__btn").click()
        page.get_by_role("link", name="Your assistant").click()
        expect(page).to_have_url(re.compile(r"/settings/assistant$"))
        expect(page.get_by_role("heading", name="Not set up")).to_be_visible()
        expect(page.get_by_text("Never your direct messages, private notes, private maps or other projects.")).to_be_visible()
        turn_on = page.get_by_role("button", name="Turn on my assistant")
        expect(turn_on).to_be_disabled()
        page.get_by_role("button", name="Create your assistant here").click()
        expect(page.get_by_label("In Lamp studio")).to_have_value(re.compile(r"[0-9a-f-]{36}"))
        page.get_by_label("Up to per request", exact=True).select_option(label="$0.06")
        page.get_by_label("Daily cap", exact=True).select_option(label="$1.00")
        shot(page, "assistant-1440-settings-consent")
        expect(turn_on).to_be_disabled()
        page.get_by_role("checkbox", name=re.compile("excerpts from the project conversations I ask in are sent to Anthropic")).check()
        turn_on.click()
        expect(page.get_by_role("heading", name="Ready · only you can use it")).to_be_visible()
        expect(page.get_by_text("of your $1.00 daily cap", exact=False)).to_be_visible()
        status = self.status(page)
        self.assertEqual((status["state"], status["enablement"]["perRunCents"], status["enablement"]["dailyCapCents"]), ("ready", 6, 100))
        self.assertEqual(status["enablement"]["consent"]["version"], "o-008-2026-10-02")
        self.assertEqual((status["enablement"]["consent"]["provider"], status["enablement"]["consent"]["model"]), ("anthropic", "claude-sonnet-5"))
        type(self).ids["agent"] = status["enablement"]["agents"][0]["agentId"]
        shot(page, "assistant-1440-settings-ready")
        # Kai sees his own, not-set-up state: Jo's assistant is never offered to him.
        kai = self.page("kai")
        self.assertEqual(self.status(kai)["state"], "not_enabled")

    def test_04b_home_ask_mode_never_sends_a_private_note(self) -> None:
        # Home's spark button switches ask mode for the owner's own assistant. A note on Home stays private:
        # ask mode only explains where the assistant answers, never sends, and Esc or "Stop asking" leaves it.
        page = self.page("jo")
        page.goto("/")
        composer = page.get_by_label("Private note")
        composer.fill("Which sensor works in the dark?")
        ask = page.get_by_role("button", name="Ask my assistant")
        expect(ask).to_have_attribute("aria-pressed", "false")
        ask.click()
        expect(ask).to_have_attribute("aria-pressed", "true")
        expect(page.get_by_text("Your assistant answers in project conversations. Notes here stay private and are never sent.")).to_be_visible()
        send = page.get_by_role("button", name="Send to your assistant")
        expect(send).to_have_attribute("aria-disabled", "true")
        composer.press("Enter")
        expect(composer).to_have_value("Which sensor works in the dark?")
        shot(page, "assistant-1440-home-ask")
        composer.focus()
        page.keyboard.press("Escape")
        expect(ask).to_have_attribute("aria-pressed", "false")
        expect(composer).to_have_value("Which sensor works in the dark?")
        ask.click()
        page.get_by_role("button", name="Stop asking your assistant").click()
        expect(ask).to_have_attribute("aria-pressed", "false")
        expect(composer).to_be_focused()
        # Kai has no assistant: the same button leads to "Connect your AI" and never toggles.
        kai = self.page("kai")
        kai.goto("/")
        expect(kai.locator(".composer__ask")).to_have_accessible_name("Connect your AI")
        expect(kai.locator(".composer__ask")).not_to_have_attribute("aria-pressed", re.compile(".*"))

    def test_05_a_manager_lets_their_assistant_read_the_project(self) -> None:
        page = self.conversation("jo")
        self.ask(page, "Summarize where we are")
        bar = page.locator("#project-ask")
        expect(bar).to_contain_text("Your assistant can’t read this project yet.")
        bar.get_by_role("button", name="Let your assistant read this project").click()
        expect(bar.get_by_role("alert")).to_have_count(0)
        grants = self.api(page, "GET", f"/api/v1/projects/{self.ids['project']}/grants", status=200)
        self.assertTrue(any(g["principal"] == {"kind": "agent", "id": self.ids["agent"]} and g["role"] == "viewer" for g in grants))
        self.assertEqual(self.own_runs(page), [], "the refused ask wrote no run")

    # ---------------------------------------------------------------- a run, its working line and the shared answer

    def test_06_owner_sees_the_working_line_and_everyone_reads_the_attributed_answer(self) -> None:
        mock("/__script", {"reset": True, "delay": 2.5, "text": "Fact: the camera fails below 5 lux {second}. Interpretation: the ToF sensor is the better next test {first}."})
        jo = self.conversation("jo")
        kai = self.conversation("kai")
        lee = self.conversation("lee")
        expect(lee.get_by_role("button", name="Ask my assistant")).to_have_count(0)
        self.ask(jo, "Summarize where we are")
        working = jo.locator(".assistant-working")
        expect(working).to_contain_text("Only you see this")
        expect(working.get_by_role("button", name="Stop")).to_be_visible()
        expect(jo.get_by_role("button", name="Ask my assistant")).to_have_attribute("aria-pressed", "false")
        expect(self.composer(jo)).to_have_value("")
        expect(working).to_contain_text(re.compile("Your assistant is (getting ready|reading this conversation|writing an answer)"))
        shot(jo, "assistant-1440-working")
        # Nobody else learns that a run exists while it works.
        expect(kai.locator(".assistant-working")).to_have_count(0)
        answer = jo.locator(".assistant-answer").last
        expect(answer).to_be_visible(timeout=20000)
        expect(working).to_have_count(0)
        expect(answer).to_contain_text(f"{JO['name']}'s assistant")
        expect(answer.locator(".agent-tag")).to_have_text("Agent")
        expect(answer).to_contain_text("asked by you")
        expect(answer).to_contain_text("“Summarize where we are”")
        expect(answer).to_contain_text("Anthropic · claude-sonnet-5")
        expect(answer.get_by_role("button", name="Retry")).to_be_visible()
        shot(jo, "assistant-1440-answer-owner")
        for peer in (kai, lee):
            peer_answer = peer.locator(".assistant-answer").last
            expect(peer_answer).to_contain_text(f"{JO['name']}'s assistant", timeout=15000)
            expect(peer_answer).to_contain_text(f"asked by {JO['name']}")
            expect(peer_answer.get_by_role("button", name="Retry")).to_have_count(0)
            expect(peer_answer.get_by_role("button", name="Continue")).to_have_count(0)
            text = peer_answer.inner_text()
            for hidden in ("$0.", "cap", "reserved"):
                self.assertNotIn(hidden, text, f"a peer never sees cost: {hidden}")
        expect(kai.locator(".assistant-answer").last.get_by_role("button", name="Ask my assistant about this")).to_be_visible()
        expect(lee.locator(".assistant-answer").last.get_by_role("button", name="Ask my assistant about this")).to_have_count(0)
        shot(kai, "assistant-1440-answer-peer")
        # Citations open exactly their source: [1] is Kai's message in this conversation.
        cite = kai.locator(".assistant-answer").last.locator(".assistant-cite").first
        expect(cite).to_have_text("1")
        expect(cite).to_have_attribute("aria-label", re.compile(r"^Source \d+: message #\d+ by Kai Lund$"))
        cite.click()
        expect(kai).to_have_url(re.compile(r"#message-[0-9a-f-]{36}$"))
        target = kai.url.split("#message-")[1]
        expect(kai.locator(f"#message-{target}")).to_contain_text(KAI_REPLY)
        # What left Flux: one count, one Messages request, the fixture key, no retries, no DM.
        sent = [item for item in mock("/__requests")["requests"] if item["path"] == "/v1/messages"]
        self.assertEqual(len(sent), 1)
        self.assertTrue(all(item["key_ok"] for item in mock("/__requests")["requests"]))
        self.assertEqual(sent[0]["retry_count"], "0")
        body = sent[0]["body"]
        self.assertEqual((body["model"], body["max_tokens"], body["output_config"]), ("claude-sonnet-5", 1500, {"effort": "low"}))
        self.assertNotIn("tools", body)
        self.assertIn(KAI_REPLY, json.dumps(body))
        self.assertNotIn(DM_TOKEN, json.dumps(body))
        run = self.own_runs(jo)[0]
        self.assertEqual((run["status"], run["cost"]["state"]), ("completed", "observed"))

    def test_07_stop_posts_nothing_and_a_failed_provider_says_so(self) -> None:
        mock("/__script", {"reset": True, "delay": 8})
        jo = self.conversation("jo")
        expect(jo.locator(".assistant-answer").first).to_be_visible()  # answers load after the messages
        before = jo.locator(".assistant-answer").count()
        self.ask(jo, "Compare every sensor in detail")
        working = jo.locator(".assistant-working")
        expect(working).to_contain_text("Your assistant is writing an answer…", timeout=15000)
        working.get_by_role("button", name="Stop").click()
        expect(working).to_contain_text("Stopped. Nothing was posted.", timeout=15000)
        expect(working.get_by_role("button", name="Retry")).to_be_visible()
        shot(jo, "assistant-1440-stopped")
        run = self.own_runs(jo)[0]
        self.assertEqual((run["status"], run["answer"]), ("stopped", None))
        working.get_by_role("button", name="Dismiss").click()
        expect(working).to_have_count(0)
        # The provider fails: the line says so, nothing is posted, and it is not retried by itself.
        mock("/__script", {"reset": True, "status": 500})
        self.ask(jo, "Try once more")
        expect(working).to_contain_text("The AI provider didn’t answer. Nothing was posted.", timeout=20000)
        self.assertEqual(len([item for item in mock("/__requests")["requests"] if item["path"] == "/v1/messages"]), 1)
        jo.reload()
        expect(self.opening(jo)).to_contain_text(OPENING)
        expect(jo.locator(".assistant-answer").first).to_be_visible()
        expect(jo.locator(".assistant-answer")).to_have_count(before)

    def test_07b_working_motion_follows_execution_and_pauses_unseen(self) -> None:
        """#155 AC-3/AC-4: the working mark moves only while the run actually executes, pauses under a modal
        or off screen, is static while stopping, and the line's text always says what is happening."""
        # The provider answers after 12 s, so the run is executing for the whole check; Stop ends it below
        # (the worker holds the stopped call until the provider answers, so the delay stays short).
        mock("/__script", {"reset": True, "delay": 12})
        jo = self.conversation("jo")
        expect(jo.locator(".assistant-answer").first).to_be_visible()
        self.ask(jo, "Compare the two sensors once more")
        working = jo.locator(".assistant-working")
        try:
            self.check_working_motion(jo, working)
        finally:
            # Never leave a run executing for the next journey.
            stop = working.get_by_role("button", name="Stop")
            if stop.count():
                stop.click()
                expect(working).to_contain_text("Stopped. Nothing was posted.", timeout=20000)
            dismiss = working.get_by_role("button", name="Dismiss")
            if dismiss.count():
                dismiss.click()
            expect(working).to_have_count(0)

    def check_working_motion(self, jo: Page, working) -> None:
        expect(working).to_contain_text("Your assistant is writing an answer…", timeout=15000)
        expect(working).to_have_class(re.compile(r"\bis-working\b"))
        pulse = working.locator(".assistant-working__pulse")
        self.assertEqual(pulse.evaluate("el => [getComputedStyle(el).animationName, getComputedStyle(el).animationPlayState]"), ["assistant-breathe", "running"])
        # Under a modal (Jump to…) the mark pauses; it runs again when the modal closes.
        jo.keyboard.press("Control+k")
        expect(jo.locator('[aria-modal="true"]')).to_be_visible()
        expect(working).to_have_attribute("data-motion-paused", "")
        self.assertEqual(pulse.evaluate("el => getComputedStyle(el).animationPlayState"), "paused")
        jo.keyboard.press("Escape")
        expect(jo.locator('[aria-modal="true"]')).to_have_count(0)
        expect(working).not_to_have_attribute("data-motion-paused", "")
        # Off screen it pauses too: in a short window the reader scrolls (a real wheel; the thread keeps a
        # reader's own position) to the top of the thread, then back down to the line.
        jo.set_viewport_size({"width": 1440, "height": 640})
        feed = jo.locator(".thread__feed")
        feed.hover()
        jo.mouse.wheel(0, -100000)
        jo.wait_for_function("() => document.querySelector('.thread__feed').scrollTop === 0")
        self.assertTrue(working.evaluate("el => { const f = el.closest('.thread__feed').getBoundingClientRect(), r = el.getBoundingClientRect(); return r.top >= f.bottom || r.bottom <= f.top; }"),
                        "the working line is outside the visible part of the thread")
        expect(working).to_have_attribute("data-motion-paused", "")
        jo.mouse.wheel(0, 100000)
        expect(working).to_be_in_viewport()
        expect(working).not_to_have_attribute("data-motion-paused", "")
        jo.set_viewport_size({"width": 1440, "height": 900})
        # Stopping is not execution: the mark is static and the text says so.
        working.get_by_role("button", name="Stop").click()
        expect(working).to_contain_text(re.compile("Stopping… nothing will be posted.|Stopped. Nothing was posted."), timeout=15000)
        expect(working).not_to_have_class(re.compile(r"\bis-working\b"))
        expect(working.locator(".assistant-working__pulse")).to_have_count(0)
        expect(working).to_contain_text("Stopped. Nothing was posted.", timeout=15000)

    # ---------------------------------------------------------------- the proposal: only authority accepts

    def test_08_a_proposal_waits_for_someone_with_authority(self) -> None:
        mock("/__script", {"reset": True, "text": PROPOSAL_TEXT, "output_tokens": 90})
        jo = self.conversation("jo")
        self.ask(jo, "Record the low-light result")
        card = jo.locator(".assistant-proposal").last
        expect(card).to_contain_text("Proposal · not saved yet", timeout=20000)
        expect(card).to_contain_text("Camera fails in low light")
        expect(card).to_contain_text("finishes Camera in low light")
        lee = self.conversation("lee")
        lee_card = lee.locator(".assistant-proposal").last
        expect(lee_card).to_contain_text(f"{JO['name']}'s assistant drafted this. It waits for someone who can decide it.")
        expect(lee_card.get_by_role("button", name="Accept")).to_have_count(0)
        kai = self.conversation("kai")
        kai_card = kai.locator(".assistant-proposal").last
        # The proposal itself, before anyone decides it (the shot used to be taken before it rendered).
        expect(kai_card).to_contain_text("Proposal · not saved yet")
        kai_card.scroll_into_view_if_needed()
        shot(kai, "assistant-1440-proposal")
        kai_card.get_by_role("button", name="Accept").click()
        expect(kai_card).to_contain_text(f"Recorded by you · drafted by {JO['name']}'s assistant")
        expect(card).to_contain_text("Recorded by Kai Lund · drafted by your assistant", timeout=15000)
        work = self.api(kai, "GET", f"/api/v1/work/{self.ids['work']}", status=200)
        self.assertEqual(work["status"], "done")
        kai_card.get_by_role("button", name="Open result").click()
        expect(kai.get_by_role("complementary", name="Details")).to_contain_text("Camera fails in low light")

    # ---------------------------------------------------------------- paused and capped: explicit and calm

    def test_09_paused_and_capped_are_explicit(self) -> None:
        settings = self.page("jo")
        settings.goto("/settings/assistant")
        settings.get_by_role("button", name="Pause").click()
        expect(settings.get_by_role("heading", name="Paused · nothing runs")).to_be_visible()
        jo = self.conversation("jo")
        jo.get_by_role("button", name="Ask my assistant").click()
        bar = jo.locator("#project-ask")
        expect(bar).to_contain_text("Your assistant is paused.")
        expect(jo.get_by_role("button", name="Send to your assistant")).to_have_attribute("aria-disabled", "true")
        shot(jo, "assistant-1440-paused")
        bar.get_by_role("button", name="Resume").click()
        expect(bar).to_contain_text("Answer shown to")
        # A small cap. The stopped and the failed run of test_07 may have been billed, so their
        # reservations still count (cost `unknown`): today's use leaves no room for another run.
        runs = {run["status"]: run["cost"]["state"] for run in self.own_runs(jo)}
        self.assertEqual((runs["stopped"], runs["provider_failed"]), ("unknown", "unknown"))
        settings.reload()
        settings.get_by_label("Daily cap", exact=True).select_option(label="$0.10")
        settings.get_by_role("button", name="Save limits").click()
        expect(settings.get_by_text("of your $0.10 daily cap", exact=False)).to_be_visible()
        expect(settings.get_by_role("heading", name="Stopped at today’s cap")).to_be_visible()
        self.assertEqual(self.status(settings)["state"], "capped")
        jo.reload()
        jo.get_by_role("button", name="Ask my assistant").click()
        expect(bar).to_contain_text("Stopped at today’s $0.10 cap. It won’t use another payer.", timeout=10000)
        expect(jo.get_by_role("button", name="Send to your assistant")).to_have_attribute("aria-disabled", "true")
        shot(jo, "assistant-1440-capped")
        bar.get_by_role("button", name="Raise cap").click()
        expect(jo).to_have_url(re.compile(r"/settings/assistant$"))
        expect(jo.get_by_role("heading", name="Stopped at today’s cap")).to_be_visible()
        # Human work is never blocked by the cap.
        kai = self.conversation("kai")
        self.composer(kai).fill("Noted, thanks.")
        kai.get_by_role("button", name="Send reply").click()
        expect(kai.locator(".project-convo__message").filter(has_text="Noted, thanks.")).to_be_visible()

    def test_10_phone_reads_the_answer_and_proposal_without_overflow(self) -> None:
        page = self.conversation("kai", phone=True)
        answer = page.locator(".assistant-answer").filter(has=page.locator(".assistant-proposal")).last
        answer.scroll_into_view_if_needed()
        expect(answer).to_contain_text("Recorded by you")
        self.no_horizontal_scroll(page)
        shot(page, "assistant-390-proposal-accepted")
        jo = self.conversation("jo", phone=True)
        jo.get_by_role("button", name="Ask my assistant").tap()
        expect(jo.locator("#project-ask")).to_be_visible()
        self.no_horizontal_scroll(jo)
        shot(jo, "assistant-390-ask-capped")


if __name__ == "__main__":
    unittest.main()
