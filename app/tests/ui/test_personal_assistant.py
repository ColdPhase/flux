"""Browser tests for the personal assistant in a project conversation (#68 AC-8, O-008, #57 design; since #842 its answer is private, see test_private_ai).

Runs with the other tests/ui journeys through scripts/check_ui.sh. That stack is composed with the
TEST-ONLY switch `FLUX_TEST_PERSONAL_RUNS=anthropic-mock`: every person has a fixture key
connection and the real worker sends runs through the real `@flux/agent-runtime` Anthropic
adapter to `tests/ui/anthropic_mock.py`. Nothing here calls a model; no test is a provider,
billing or compatibility pass. The production fail-closed states (provider off, no key) are
exercised against the production composition in tests/app/personal-runs.test.ts; here they are
only rendered from a stubbed status response, which proves wording, not behaviour.

Three people share one project: Jo (manager, owns the assistant), Kai (contributor, owns the
work) and Lee (a member).
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
UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")  # chromium (default) or webkit, as in the other journeys (#68 AC-8)
PASSWORD = "an assistant that stays mine"
STAMP = int(time.time() * 1000)
JO = {"name": "Jo Weber", "email": f"jo.weber+{STAMP}@example.test"}
KAI = {"name": "Kai Lund", "email": f"kai.lund+{STAMP}@example.test"}
LEE = {"name": "Lee Park", "email": f"lee.park+{STAMP}@example.test"}
DM_TOKEN = f"DM-ONLY-{uuid.uuid4()}"
OPENING = "Camera or ToF sensor for the bedside lamp?"
KAI_REPLY = "The camera fails below 5 lux in the low-light test; the ToF sensor kept working with swipe + hold."


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

    def conversation(self, who: str, **kwargs) -> Page:
        """The conversation's thread, open beside the project's stream (UI116-1); the assistant is asked there."""
        page = self.page(who, **kwargs)
        page.goto(f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}")
        expect(self.opening(page)).to_contain_text(OPENING)
        # The thread is drawn hidden until its opening reads settle (#155, `.is-opening`); until then nothing in it can
        # take focus, so a test that starts at once focused nothing (#752).
        expect(self.opening(page)).to_be_visible()
        return page

    def opening(self, page: Page):
        return page.get_by_role("complementary", name="Replies").or_(page.get_by_role("dialog", name="Replies")).locator(".thread__root")

    def composer(self, page: Page):
        return page.locator("#thread-composer")

    def ask(self, page: Page, prompt: str) -> None:
        box = self.composer(page)
        box.fill(f"/ai {prompt}")
        expect(page.locator("#project-ask")).to_be_visible()
        expect(box).to_have_value(prompt)
        page.get_by_role("button", name="Send to your assistant").click()

    def status(self, page: Page) -> dict:
        return self.api(page, "GET", "/api/v1/personal-assistant", status=200)

    def own_runs(self, page: Page) -> list[dict]:
        return self.api(page, "GET", "/api/v1/assistant-runs?limit=20", status=200)["items"]

    def focus_state(self, page: Page) -> dict:
        """Where focus is now: `page` is true when it fell to the document (nothing to operate), `in` names the part of the conversation."""
        return page.evaluate("""() => {
            const el = document.activeElement;
            const page = !el || el === document.body || el === document.documentElement;
            const within = (selector) => !!el && !!el.closest(selector);
            return { page, label: page ? '' : (el.getAttribute('aria-label') || el.textContent || el.id || el.tagName).trim().slice(0, 40),
                     in: page ? 'page' : within('[role="dialog"]') ? 'dialog' : within('.assistant-working') ? 'working'
                       : within('.assistant-private') ? 'answer' : within('#thread-composer') ? 'composer' : 'other' };
        }""")

    def reach(self, page: Page, target, *, back: bool = False, presses: int = 60) -> None:
        """Move focus to `target` with Tab (Shift+Tab when `back`) alone, as a keyboard user does."""
        for _ in range(presses):
            if target.evaluate("(node) => node === document.activeElement"):
                return
            page.keyboard.press("Shift+Tab" if back else "Tab")
        self.fail(f"{target} was not reached by keyboard in {presses} presses; focus is on {self.focus_state(page)}")

    def trapped(self, page: Page, dialog) -> None:
        """Tab and Shift+Tab never leave the open dialog (it is modal: AC-8 modal focus)."""
        for key in ("Tab",) * 8 + ("Shift+Tab",) * 8:
            page.keyboard.press(key)
            self.assertTrue(dialog.evaluate("(node) => node.contains(document.activeElement)"), f"{key} left the dialog: {self.focus_state(page)}")

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
        self.api(jo, "POST", f"/api/v1/projects/{project['id']}/grants", {"principal": {"kind": "human", "id": LEE["id"]}, "role": "contributor"}, status=201)
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
        # The composer has no Ask button (F-026 S5): "/ai" in a conversation starts the private prompt.
        expect(page.get_by_role("button", name="Ask my assistant")).to_have_count(0)
        self.composer(page).fill("/ai ")
        bar = page.locator("#project-ask")
        expect(bar).to_contain_text("You haven’t set up your assistant. Nobody else’s can be used for you.")
        self.composer(page).fill("Summarize this for me")
        expect(page.get_by_role("button", name="Send to your assistant")).to_have_attribute("aria-disabled", "true")
        self.composer(page).press("Enter")
        expect(self.composer(page)).to_have_value("Summarize this for me")
        shot(page, "assistant-1440-not-set-up")
        bar.get_by_role("button", name="Connect your AI").click()
        panel = page.get_by_role("complementary", name="Connect your AI")  # headed by the button that opened it (#1058)
        expect(panel.get_by_role("link", name="Ways to connect, in Settings → AI")).to_have_attribute("href", "/settings/agents")
        # Details take the thread's one panel; "back" returns to the reply being written.
        panel.get_by_role("button", name="Thread").click()
        expect(page.get_by_role("complementary", name="Replies")).to_be_visible()
        # Esc returns to a plain reply; the person's own message is sent as usual.
        self.composer(page).fill("/ai ")
        expect(page.locator("#project-ask")).to_be_visible()
        self.composer(page).focus()
        page.keyboard.press("Escape")
        expect(page.locator("#project-ask")).to_have_count(0)
        self.composer(page).fill("Let's try the ToF sensor next.")
        page.get_by_role("button", name="Send reply").click()
        expect(page.locator(".project-convo__message").filter(has_text="Let's try the ToF sensor next.")).to_be_visible()
        self.assertEqual(self.own_runs(page), [], "nothing was run")

    def test_03_production_states_are_worded_truthfully(self) -> None:
        """Rendering only: the stub stands in for the production composition's real status."""
        page = self.page("jo")
        real = self.status(page)
        off = {"provider": "off", "connection": "none", "runtime": {"state": "off", "payer": None, "accountLabel": None, "client": None}}
        stub = {**real, "state": "not_enabled", "enablement": None, "today": None, "setup": off}

        def fulfil(route: Route) -> None:
            if route.request.method == "GET":
                route.fulfill(status=200, content_type="application/json", body=json.dumps(stub))
            else:
                route.continue_()
        page.route("**/api/v1/personal-assistant", fulfil)
        stub.update(state="unavailable", unavailableReason="provider_off", enablement={
            "ownerUserId": JO["id"], "agentId": "00000000-0000-4000-8000-000000000002", "workspaceId": "00000000-0000-4000-8000-000000000003",
            "connection": "00000000-0000-4000-8000-000000000001", "engine": "server",
            "model": "claude-sonnet-5", "version": 1, "createdAt": "2026-09-30T08:00:00.000Z", "updatedAt": "2026-09-30T08:00:00.000Z"},
            today={"chargedMicros": 0, "reservedMicros": 0, "budgetCents": 500, "resetsAt": "2026-09-30T22:00:00.000Z"})
        page.goto(f"/projects/{self.ids['project']}/conversations/{self.ids['conversation']}")
        self.composer(page).fill("/ai ")
        expect(page.locator("#project-ask")).to_contain_text("In-app AI is turned off on this Flux server, so nothing is sent.")
        expect(page.get_by_role("button", name="Send to your assistant")).to_have_attribute("aria-disabled", "true")
        stub.update(setup={**off, "provider": "on"}, unavailableReason="no_connection")
        page.reload()
        self.composer(page).fill("/ai ")
        expect(page.locator("#project-ask")).to_contain_text("Your AI key isn’t connected, so nothing is sent.")

    # ---------------------------------------------------------------- turning it on: a model, nothing else (#854)

    def test_04_owner_has_assistant_in_settings_ai(self) -> None:
        # The account menu holds Settings and People only (#763 SG-7); the agents are in Settings › AI (#857).
        page = self.page("jo")
        page.goto("/settings/agents")
        # Opening Settings makes no agent: with none yet it says so. Connecting AI gives the owner Assistant on the server; the check
        # stack's fixture key is not a connection made by the person, so the same first agent is made through the API.
        expect(page.get_by_text("You have no agents. Make one with New agent.")).to_be_visible()
        self.api(page, "POST", "/api/v1/my-agents", {"workspaceId": self.ids["workspace"]}, status=201)
        page.reload()
        # Connect AI's default model (the TEST-ONLY fixture key here), nothing to agree to and no limit of Flux's own to set.
        row = page.get_by_role("list", name="Your agents").get_by_role("listitem").first
        expect(row).to_contain_text("Assistant")
        expect(row).to_contain_text("Answers /ai")
        self.assertRegex(row.locator(".sset-row__ic > .kreska").get_attribute("class") or "", r"kreska--[a-z]+")
        expect(page.get_by_label("Up to per request")).to_have_count(0)
        expect(page.get_by_label("Daily cap")).to_have_count(0)
        expect(page.get_by_role("checkbox")).to_have_count(0)
        row.get_by_role("link").click()
        expect(page.get_by_role("heading", level=2, name="Assistant")).to_be_visible()
        expect(page.locator("[data-agent-model]")).to_contain_text("Sonnet 5")
        page.get_by_role("button", name="More settings").click()  # the Model is behind More (#1419)
        # The model is the one control of its group: a dropdown for an API key (#1282), showing the model the assistant has (not "Choose a model").
        model = page.get_by_role("group", name=re.compile("^Model")).get_by_role("combobox")
        expect(model).to_have_count(1)
        expect(model).to_contain_text("Sonnet 5")
        expect(model).not_to_contain_text("Choose a model")
        shot(page, "assistant-1440-settings-ready")
        status = self.status(page)
        self.assertEqual((status["state"], status["enablement"]["engine"], status["enablement"]["model"]), ("ready", "server", "claude-sonnet-5"))
        self.assertRegex(status["enablement"]["connection"], r"^[0-9a-f-]{36}$", "the assistant uses the fixture key, Connect AI's default")
        self.assertNotIn("consent", status["enablement"])
        self.assertEqual(status["today"]["budgetCents"], 500)
        type(self).ids["agent"] = status["enablement"]["agentId"]
        # Kai sees his own, not-set-up state: Jo's assistant is never offered to him.
        kai = self.page("kai")
        self.assertEqual(self.status(kai)["state"], "not_enabled")

    def test_05_the_assistant_has_its_owners_rights_with_no_grant_of_its_own(self) -> None:
        # F-036 AG-3: the assistant reaches what its owner reaches; nobody lets it in and no grant names it.
        setup = self.page("jo")
        grants = self.api(setup, "GET", f"/api/v1/projects/{self.ids['project']}/grants", status=200)
        self.assertEqual([g for g in grants if g["principal"]["kind"] != "human"], [], "people hold grants, agents do not")

    # ---------------------------------------------------------------- a run, its working line and the shared answer

    def test_06_owner_sees_the_working_line_and_the_private_answer_and_nobody_else_sees_either(self) -> None:
        mock("/__script", {"reset": True, "delay": 2.5, "text": "Fact: the camera fails below 5 lux {second}. Interpretation: the ToF sensor is the better next test {first}."})
        jo = self.conversation("jo")
        kai = self.conversation("kai")
        self.ask(jo, "Summarize where we are")
        working = jo.locator(".assistant-working")
        expect(working).to_contain_text("Only you see this")
        expect(working.get_by_role("button", name="Stop")).to_be_visible()
        expect(jo.locator("#project-ask")).to_have_count(0)
        expect(self.composer(jo)).to_have_value("")
        expect(working).to_contain_text(re.compile("Your assistant is (getting ready|reading this conversation|thinking)"))
        shot(jo, "assistant-1440-working")
        # Nobody else learns that a run exists while it works (#842).
        expect(kai.locator(".assistant-working")).to_have_count(0)
        card = jo.locator(".assistant-private").last
        expect(card).to_be_visible(timeout=20000)
        expect(working).to_have_count(0)
        expect(card).to_contain_text("Only you can see this")
        expect(card).to_contain_text("You asked: /ai Summarize where we are")
        expect(card).not_to_contain_text("claude-sonnet-5")
        expect(card.get_by_role("button", name="Show everyone")).to_be_visible()
        shot(jo, "assistant-1440-answer-owner")
        expect(kai.locator(".assistant-private")).to_have_count(0)
        # Citations open exactly their source: [1] is Kai's message in this conversation.
        cite = card.locator(".assistant-cite").first
        expect(cite).to_have_text("1")
        expect(cite).to_have_attribute("aria-label", re.compile(r"^Source \d+: message #\d+ by Kai Lund$"))
        # What left Flux: one count, one Messages request, the fixture key, no retries, no DM.
        sent = [item for item in mock("/__requests")["requests"] if item["path"] == "/v1/messages"]
        self.assertEqual(len(sent), 1)
        self.assertTrue(all(item["key_ok"] for item in mock("/__requests")["requests"]))
        self.assertEqual(sent[0]["retry_count"], "0")
        body = sent[0]["body"]
        self.assertEqual((body["model"], body["max_tokens"], body["output_config"]), ("claude-sonnet-5", 4000, {"effort": "low"}))
        # F-027 A6 (#484) and A3 (#403): the run offers its exact tools (reads and change tools), listed by /mcp to its
        # run token; the co-work claim, transfer and request tools, bootstrap and proposal tools are never offered to a run.
        tools = sorted(tool["name"] for tool in body.get("tools", []))
        self.assertIn("flux_get_conversation", tools)
        self.assertIn("flux_create_task", tools)
        self.assertIn("flux_create_unit", tools)  # the owner-assistant hand-off, with its own private input
        for absent in ("flux_bootstrap", "flux_claim_unit", "flux_transfer_unit", "flux_create_proposal", "flux_undo_task_creation", "flux_ask_question"):
            self.assertNotIn(absent, tools)
        self.assertIn(KAI_REPLY, json.dumps(body))
        self.assertNotIn(DM_TOKEN, json.dumps(body))
        run = self.own_runs(jo)[0]
        self.assertEqual((run["status"], run["cost"]["state"]), ("completed", "observed"))
        card.get_by_role("button", name="Dismiss").click()
        expect(card).to_have_count(0)

    def test_07_stop_posts_nothing_and_a_failed_provider_says_so(self) -> None:
        mock("/__script", {"reset": True, "delay": 8})
        jo = self.conversation("jo")
        before = jo.locator(".assistant-private").count()
        self.ask(jo, "Compare every sensor in detail")
        working = jo.locator(".assistant-working")
        expect(working).to_contain_text("Your assistant is thinking…", timeout=15000)
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
        expect(jo.locator(".assistant-private")).to_have_count(before)

    def test_07b_working_motion_follows_execution_and_pauses_unseen(self) -> None:
        """#155 AC-3/AC-4: the working mark moves only while the run actually executes, pauses under a modal
        or off screen, is static while stopping, and the line's text always says what is happening."""
        # The provider answers after 12 s, so the run is executing for the whole check; Stop ends it below
        # (the worker holds the stopped call until the provider answers, so the delay stays short).
        mock("/__script", {"reset": True, "delay": 12})
        jo = self.conversation("jo")
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
        expect(working).to_contain_text("Your assistant is thinking…", timeout=15000)
        expect(working).to_have_class(re.compile(r"\bis-working\b"))
        # The sidebar shows the working agent with Stop while the run executes (F-026 S13, #340).
        if jo.locator(".app__side").count():
            card = jo.locator(".app__side .agentlive")
            expect(card).to_be_visible()
            expect(card.get_by_role("button", name="Stop your assistant")).to_be_visible()
        # The mark is Kreska thinking: its brow waves while the run executes (#339).
        pulse = working.locator('.kreska[data-expression="thinking"] .kreska__brow')
        self.assertEqual(pulse.evaluate("el => [getComputedStyle(el).animationName, getComputedStyle(el).animationPlayState]"), ["kreska-wave", "running"])
        # The sidebar's working mark is the same run's Kreska, so it follows the same motion rule (#155 AC-4).
        sidebar = jo.locator(".app__side").count() > 0
        side_pulse = jo.locator('.app__side .agentlive .kreska[data-expression="thinking"] .kreska__brow')
        if sidebar:
            self.assertEqual(side_pulse.evaluate("el => getComputedStyle(el).animationPlayState"), "running")
        # Under a modal (Jump to…) the marks pause; they run again when the modal closes.
        jo.keyboard.press("Control+k")
        expect(jo.locator('[aria-modal="true"]')).to_be_visible()
        expect(working).to_have_attribute("data-motion-paused", "")
        self.assertEqual(pulse.evaluate("el => getComputedStyle(el).animationPlayState"), "paused")
        if sidebar:
            self.assertEqual(side_pulse.evaluate("el => getComputedStyle(el).animationPlayState"), "paused")
        jo.keyboard.press("Escape")
        expect(jo.locator('[aria-modal="true"]')).to_have_count(0)
        expect(working).not_to_have_attribute("data-motion-paused", "")
        if sidebar:
            self.assertEqual(side_pulse.evaluate("el => getComputedStyle(el).animationPlayState"), "running")
        # Off screen it pauses too: in a short window the reader scrolls (a real wheel; the thread keeps a
        # reader's own position) to the top of the thread, then back down to the line. The window is short enough that the thread is
        # taller than its visible part by more than the line itself: the assistant's suggestions no longer take room under the thread
        # (they are in the / menu, #1279), so at 640 px the line was still partly in view at the top (the thread 448 px, its visible part 393).
        jo.set_viewport_size({"width": 1440, "height": 520})
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
        expect(working.locator('.kreska[data-expression="thinking"]')).to_have_count(0)
        expect(working).to_contain_text("Stopped. Nothing was posted.", timeout=15000)

    def test_07c_small_moments_off_keeps_the_working_words_and_stop_without_the_face(self) -> None:
        """#352 AC-2: with Settings → Appearance off, the thinking face is gone and the working line keeps its words,
        Stop and the attributed answers; turning the moments back on brings the live face back."""
        mock("/__script", {"reset": True, "delay": 12})
        jo = self.conversation("jo")
        self.ask(jo, "Compare the two sensors a last time")
        working = jo.locator(".assistant-working")
        try:
            expect(working).to_contain_text("Your assistant is thinking…", timeout=15000)
            expect(working.locator('.kreska[data-expression="thinking"]')).to_have_count(1)
            settings = jo.context.new_page()  # the same storage as the conversation
            settings.goto("/settings")
            settings.get_by_role("switch", name="Show the face on loading and empty screens").click()
            expect(settings.get_by_role("switch", name="Show the face on loading and empty screens")).to_have_attribute("aria-checked", "false")
            settings.close()
            jo.reload()
            expect(working).to_contain_text("Your assistant is thinking…", timeout=15000)
            expect(working.get_by_role("button", name="Stop")).to_be_visible()
            expect(working.locator(".kreska")).to_have_count(0)
            self.assertEqual(jo.evaluate("document.documentElement.dataset.kreska"), "off")
            # The sidebar's working card follows the switch too: words and Stop stay, no face, nothing animates.
            animated = "() => [...document.querySelectorAll('.agentlive *')].filter((el) => getComputedStyle(el).animationName !== 'none').length"
            card = jo.locator(".app__side .agentlive")
            expect(card).to_contain_text("Your assistant")
            expect(card.get_by_role("button", name="Stop your assistant")).to_be_visible()
            expect(card.locator(".kreska")).to_have_count(0)
            self.assertEqual(jo.evaluate(animated), 0)
            # The folded rail keeps a visible target (the mark) with the same label and Stop, and no face.
            jo.keyboard.press("[")
            rail_card = jo.locator(".side--rail .agentlive")
            expect(rail_card.get_by_role("link")).to_be_visible()
            expect(rail_card.get_by_role("button", name="Stop your assistant")).to_be_visible()
            expect(rail_card.locator(".kreska")).to_have_count(0)
            self.assertEqual(jo.evaluate(animated), 0)
            jo.keyboard.press("[")
            expect(jo.locator(".side--rail")).to_have_count(0)
            # Turning the moments back on brings the live thinking face back, in the conversation and the sidebar.
            settings = jo.context.new_page()  # the same storage as the conversation
            settings.goto("/settings")
            settings.get_by_role("switch", name="Show the face on loading and empty screens").click()
            expect(settings.get_by_role("switch", name="Show the face on loading and empty screens")).to_have_attribute("aria-checked", "true")
            settings.close()
            jo.reload()
            expect(working.locator('.kreska[data-expression="thinking"] .kreska__brow')).to_be_visible()
            expect(jo.locator('.app__side .agentlive .kreska[data-expression="thinking"] .kreska__brow')).to_be_visible()
        finally:
            stop = working.get_by_role("button", name="Stop")
            if stop.count():
                stop.click()
                expect(working).to_contain_text("Stopped. Nothing was posted.", timeout=20000)
            dismiss = working.get_by_role("button", name="Dismiss")
            if dismiss.count():
                dismiss.click()
            expect(working).to_have_count(0)

    # ---------------------------------------------------------------- the proposal: only authority accepts

    def test_08b_ask_stop_retry_and_dismiss_work_by_keyboard_and_focus_never_falls_to_the_page(self) -> None:
        mock("/__script", {"reset": True, "delay": 10})
        jo = self.conversation("jo")
        box = self.composer(jo)
        box.focus()
        jo.keyboard.type("/ai Compare the sensors")
        # Enter sends once the bar knows the assistant is ready; while it says "Checking your assistant…" Enter is refused (#752).
        expect(jo.locator("#project-ask")).to_contain_text("Only you see the answer")
        jo.keyboard.press("Enter")
        working = jo.locator(".assistant-working")
        expect(working).to_contain_text("Only you see this")
        expect(box).to_be_focused()  # sending keeps the person in the box: they can write on
        expect(box).to_have_value("")  # typing "/ai" key by key left no "/a" behind as the reply's draft
        # Stop is reachable by Tab alone and works with Enter; the button goes away, focus does not fall to the page.
        self.reach(jo, working.get_by_role("button", name="Stop"), back=True)
        jo.keyboard.press("Enter")
        self.assertEqual(self.focus_state(jo)["page"], False, "focus after Stop")
        expect(working).to_contain_text("Stopped. Nothing was posted.", timeout=15000)
        self.assertEqual(self.focus_state(jo)["in"], "working", "focus stays where the answer will appear")
        # Retry starts a new run and its own Stop takes the place of the button that was pressed.
        self.reach(jo, working.get_by_role("button", name="Retry"))
        jo.keyboard.press("Enter")
        expect(working.get_by_role("button", name="Stop")).to_be_visible(timeout=15000)
        self.assertEqual(self.focus_state(jo)["in"], "working", "focus after Retry")
        self.reach(jo, working.get_by_role("button", name="Stop"))
        jo.keyboard.press("Enter")
        expect(working).to_contain_text("Stopped. Nothing was posted.", timeout=15000)
        # Dismiss removes the line; focus goes back to the box, where the next thing is written.
        self.reach(jo, working.get_by_role("button", name="Dismiss"))
        jo.keyboard.press("Enter")
        expect(working).to_have_count(0)
        expect(box).to_be_focused()

    def test_08c_an_answer_cites_what_it_used_from_flux_as_chips_that_open_exactly_it(self) -> None:
        # C-62 (#1381): a Wiki page and its section, a decision and an id that points at nothing; the marks the model wrote with the ids its tools gave
        # become the same numbered chips as any source, in one list, and the unknown one goes. The section opens the page at its heading.
        # Only what the run's own tools returned is cited: the agent reads the page and the decision first.
        project = self.ids["project"]
        jo = self.conversation("jo")
        page = self.api(jo, "POST", f"/api/v1/projects/{project}/docs", {"title": "Calibration", "body": "# Calibration\nHow to calibrate.\n\n## Install\nMount the probe.\n\n## Readings\nWithin 2%."}, status=201)
        decision = self.api(jo, "POST", f"/api/v1/projects/{project}/decisions", {"title": "Use the reference probe"}, status=201)
        unknown = "00000000-0000-4000-8000-000000000000"
        mock("/__script", {"reset": True, "text": f"Mount the probe first [doc:{page['id']}#2] and read it within 2% [doc:{page['id']}#3]. "
                                                  f"We decided on it [decision:{decision['id']}], not on [doc:{unknown}].",
                           "tool": [{"name": "flux_get_doc", "input": {"projectId": project, "id": page["id"]}},
                                    {"name": "flux_get_decision", "input": {"projectId": project, "id": decision["id"]}}]})
        self.ask(jo, "How do we calibrate the north barrel?")
        card = jo.locator(".assistant-private").last
        expect(card).to_be_visible(timeout=20000)
        chips = card.locator(".assistant-cite")
        expect(chips).to_have_count(3)
        expect(card).not_to_contain_text("[doc:")
        expect(card).not_to_contain_text(unknown)
        expect(chips.nth(0)).to_have_attribute("aria-label", "Source 1: Wiki page “Calibration”, section “Install”")
        expect(chips.nth(1)).to_have_attribute("aria-label", "Source 2: Wiki page “Calibration”, section “Readings”")
        expect(chips.nth(2)).to_have_attribute("aria-label", "Source 3: decision “Use the reference probe”")
        shot(jo, "assistant-1440-flux-citations")
        answer = self.own_runs(jo)[0]["answer"]
        self.assertEqual([source["type"] for source in answer["sources"]], ["doc", "doc", "decision"])
        # The section opens the version it was numbered in, at its heading.
        chips.nth(0).click()
        jo.wait_for_url(re.compile(rf"/projects/{project}/docs/{page['id']}/versions/\d+#section-2$"))
        heading = jo.locator("#section-2")
        expect(heading).to_have_text("Install")
        expect(heading).to_be_in_viewport()
        # A decision opens in Details (the thread, which is the same one panel, makes room for it); the answer is still the owner's to read.
        again = self.conversation("jo")
        card = again.locator(".assistant-private").last
        expect(card).to_be_visible(timeout=20000)
        expect(card.locator(".assistant-cite")).to_have_count(3)
        card.locator(".assistant-cite").nth(2).click()
        expect(again.get_by_text("Use the reference probe").first).to_be_visible()
        mock("/__script", {"reset": True})

    def test_09_a_used_budget_is_explicit(self) -> None:
        jo = self.conversation("jo")
        self.composer(jo).fill("/ai ")
        bar = jo.locator("#project-ask")
        expect(bar).to_contain_text("Only you see the answer")
        # #854: an API key's one daily budget. Jo's TEST-ONLY fixture key keeps the default $5, which these runs never reach,
        # so the used budget is rendered from a stubbed status (wording only; the wait itself is covered through the real
        # worker by personal-runs-providers.test.ts). No button offers another connection or a higher limit.
        real = self.status(jo)
        self.assertEqual(real["today"]["budgetCents"], 500)
        used = {**real, "state": "capped", "today": {**real["today"], "chargedMicros": 5_000_000, "reservedMicros": 0}}
        jo.route("**/api/v1/personal-assistant", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(used))
                 if route.request.method == "GET" else route.continue_())
        jo.reload()
        self.composer(jo).fill("/ai ")
        expect(bar).to_contain_text("Not enough left of your API key’s $5.00 daily budget. A request now starts", timeout=10000)
        expect(bar.get_by_role("button", name=re.compile("raise|switch|another|instead", re.I))).to_have_count(0)
        shot(jo, "assistant-1440-capped")
        # Human work is never blocked by the budget.
        kai = self.conversation("kai")
        self.composer(kai).fill("Noted, thanks.")
        kai.get_by_role("button", name="Send reply").click()
        expect(kai.locator(".project-convo__message").filter(has_text="Noted, thanks.")).to_be_visible()


if __name__ == "__main__":
    unittest.main()
