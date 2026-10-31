"""Browser tests for the guided sign-in cards: ChatGPT (F-022 T6 #281; F-027 AST-1.6, AST-1.8) and Claude (AST-1.5), slice A12.

scripts/check_ui.sh runs with the agent runtime off, so the runtime status, the console ticket and the
console WebSocket are stubbed here: the stubbed socket sends exactly the closed messages the API relays
from the slot (`device`, `problem`, `done`). This proves the card's words, layout and buttons at
390×844 and 1440×900; the slot's recognition of the code and the two failures, the ticket and the
relay are proven against the fake `codex` in tests/app/agent-runtime-console-core.test.ts.
"""

from __future__ import annotations

import copy
import json
import os
import re
import time
import unittest

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
PASSWORD = "a chatgpt sign in of mine"
STAMP = int(time.time() * 1000)
ADA = {"name": "Ada Codex", "email": f"ada.codex+{STAMP}@example.test"}
CODE = "K7Q2-9XFRT"

CLAUDE_URL = "https://claude.com/cai/oauth/authorize?code=true&client_id=fake&state=st4te_-x"
SIGNED_OUT = {
    "enabled": True, "clients": {"claude_code": "available", "codex": "available"}, "commercialTerms": None,
    "idleReleaseDays": None, "pool": "available", "lastRelease": None,
    "binding": {"state": "active", "boundAt": "2026-10-16T10:00:00.000Z", "lastUsedAt": None, "idleReleaseAt": None},
    "connections": {"claude_code": None, "codex": None}, "auth": {},
}
SIGNED_IN = copy.deepcopy(SIGNED_OUT)
SIGNED_IN["connections"]["codex"] = {
    "state": "signed_in", "signInMethod": "device_code", "authMethod": "chatgpt", "plan": None, "accountLabel": None,
    "signedInAt": "2026-10-16T10:05:00.000Z", "payer": "chatgpt_plan", "accountChange": None, "signOut": None,
}


class CodexSignIn(unittest.TestCase):
    pw = None
    browser: Browser
    state: dict | None = None

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=15000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def context(self, *, phone: bool, dark: bool = False) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "color_scheme": "dark" if dark else "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw", "service_workers": "block"}
        options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True) if phone else options.update(viewport=DESKTOP, device_scale_factor=1)
        if self.state:
            options["storage_state"] = self.state
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        return context

    def stubbed(self, *, phone: bool, script: list[dict], status: dict | None = None, dark: bool = False, resume: dict | None = None,
                clipboard: str | bool | None = False) -> tuple[Page, list[dict]]:
        """A page whose runtime status, ticket and console socket are stubbed; the socket answers `attach` with `script`."""
        context = self.context(phone=phone, dark=dark)
        received: list[dict] = []
        context.route(re.compile(r".*/api/v1/agent-runtime$"), lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(status or SIGNED_OUT)))

        def ticket(route) -> None:
            received.append({"ticket": json.loads(route.request.post_data or "{}")})
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"ticket": "stub-ticket", "expiresAt": "2026-10-16T10:01:00.000Z"}))

        context.route(re.compile(r".*/api/v1/agent-runtime/console$"), ticket)

        def resume_route(route) -> None:
            received.append({"resume": json.loads(route.request.post_data or "{}")})
            if resume is None:
                route.fulfill(status=404, content_type="application/json", body=json.dumps({"error": "No sign-in is waiting in this session", "code": "AGENT_RUNTIME_NO_PENDING_SIGN_IN"}))
            else:
                route.fulfill(status=200, content_type="application/json", body=json.dumps({"ticket": "stub-resume", "expiresAt": "2026-10-16T10:01:00.000Z", **resume}))

        context.route(re.compile(r".*/api/v1/agent-runtime/console/resume$"), resume_route)
        # The clipboard is stubbed in both engines: Chromium grants it, WebKit has no permission to grant.
        if clipboard is not False:
          context.add_init_script("Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => undefined, readText: "
                                  + ("async () => { throw new DOMException('denied', 'NotAllowedError'); }" if clipboard is None else f"async () => {json.dumps(clipboard)}") + " } });")

        def console(ws) -> None:
            def on_message(message) -> None:
                data = json.loads(message)
                received.append(data)
                if data.get("t") == "attach":
                    for frame in script:
                        ws.send(json.dumps(frame))
            ws.on_message(on_message)

        context.route_web_socket(re.compile(r".*/api/v1/agent-runtime/console$"), console)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page, received

    def no_sideways_scroll(self, page: Page) -> None:
        self.assertLessEqual(page.evaluate("document.scrollingElement.scrollWidth"), page.evaluate("document.scrollingElement.clientWidth"))

    def test_01_sign_up(self) -> None:
        page = self.context(phone=False).new_page()
        page.goto("/sign-up")
        page.get_by_label("Name").fill(ADA["name"])
        page.get_by_label("Email").fill(ADA["email"])
        page.get_by_label("Password").fill(PASSWORD)
        with page.expect_response(lambda response: response.url.endswith("/api/auth/sign-up/email") and response.request.method == "POST") as registered:
            page.get_by_role("button", name="Create account").click()
        self.assertEqual(registered.value.status, 200)
        expect(page).not_to_have_url(re.compile(r"/sign-up(?:\?|$)"))
        type(self).state = page.context.storage_state()

    def test_02_settings_offers_sign_in_with_chatgpt_as_a_link(self) -> None:
        for phone in (True, False):
            page, _ = self.stubbed(phone=phone, script=[])
            page.goto("/settings/agents")
            link = page.get_by_role("link", name=re.compile("^Sign in with ChatGPT"))
            expect(link).to_have_attribute("href", "/settings/agents/codex")
            expect(page.get_by_role("link", name=re.compile("^Sign in with Claude"))).to_be_visible()
            self.no_sideways_scroll(page)

    def test_03_the_card_shows_the_code_large_with_copy_and_open_and_no_paste(self) -> None:
        """AST-1.6: the code at large size with "Copy and open ChatGPT"; nothing to paste back; the terminal under Show details."""
        for phone in (True, False):
            page, received = self.stubbed(phone=phone, script=[
                {"t": "state", "state": "running"},
                {"t": "device", "url": "https://auth.openai.com/codex/device", "code": CODE},
            ])
            page.goto("/settings/agents/codex")
            if not phone:  # on a phone the pane's own header names the page
                expect(page.get_by_role("heading", level=2, name="Sign in to ChatGPT")).to_be_visible()
            page.get_by_role("button", name="Get a code").click()
            expect(page.get_by_role("heading", level=3, name="Sign in to ChatGPT")).to_be_visible()
            code = page.locator(".rt-device__code")
            expect(code).to_have_text(CODE)
            self.assertGreaterEqual(float(code.evaluate("el => parseFloat(getComputedStyle(el).fontSize)")), 24, "the code is large")
            expect(page.get_by_text("Enter this code on auth.openai.com:")).to_be_visible()
            button = page.get_by_role("button", name="Copy and open ChatGPT")
            expect(button).to_be_visible()
            expect(page.get_by_text(re.compile("Flux notices when you’re done"))).to_be_visible()
            expect(page.locator("#rt-code")).to_have_count(0)
            details = page.locator(".rt-device details.rt-more")
            self.assertFalse(details.evaluate("d => d.open"), "the terminal starts folded under Show details")
            expect(details.locator("summary")).to_have_text("Show details")
            self.assertIn({"ticket": {"client": "codex", "method": "device_code"}}, received)
            if phone:
                self.assertGreaterEqual(button.bounding_box()["height"], 44)
            self.no_sideways_scroll(page)
            shot(page, f"codex-device-card-{'phone-390' if phone else 'desktop-1440'}")

    def test_04_copy_and_open_opens_chatgpt_and_copies_the_code(self) -> None:
        page, _ = self.stubbed(phone=False, script=[{"t": "state", "state": "running"}, {"t": "device", "url": "https://auth.openai.com/codex/device", "code": CODE}])
        page.context.grant_permissions(["clipboard-read", "clipboard-write"], origin=ORIGIN)
        # The vendor's page is stubbed: no request leaves the test.
        page.context.route("https://auth.openai.com/**", lambda route: route.fulfill(status=200, content_type="text/html", body="<title>stub</title>"))
        page.goto("/settings/agents/codex")
        page.get_by_role("button", name="Get a code").click()
        with page.context.expect_page() as opened:
            page.get_by_role("button", name="Copy and open ChatGPT").click()
        self.assertEqual(opened.value.url.split("?")[0], "https://auth.openai.com/codex/device")
        opened.value.close()
        expect(page.get_by_text(re.compile("Code copied"))).to_be_visible()
        self.assertEqual(page.evaluate("navigator.clipboard.readText()"), CODE)

    def test_05_journey_6_rows_device_code_off_and_code_expired(self) -> None:
        """AST-1.8: the two ChatGPT sign-in rows, exact copy and their next step."""
        done = {"t": "done", "ended": "exited", "disposition": "accepted", "signedIn": False, "status": SIGNED_OUT}
        for phone in (True, False):
            page, _ = self.stubbed(phone=phone, script=[{"t": "state", "state": "running"}, {"t": "problem", "problem": "device_auth_disabled"}, done])
            page.goto("/settings/agents/codex")
            page.get_by_role("button", name="Get a code").click()
            expect(page.get_by_role("alert")).to_have_text("ChatGPT needs one setting first: turn on device code sign-in in ChatGPT → Settings → Security.")
            expect(page.get_by_role("link", name="Open ChatGPT settings")).to_have_attribute("href", "https://chatgpt.com/#settings/Security")
            self.no_sideways_scroll(page)
            shot(page, f"codex-device-off-{'phone-390' if phone else 'desktop-1440'}")
            page.context.close()

            page, received = self.stubbed(phone=phone, script=[{"t": "state", "state": "running"},
                {"t": "device", "url": "https://auth.openai.com/codex/device", "code": CODE}, {"t": "problem", "problem": "code_expired"}, done])
            page.goto("/settings/agents/codex")
            page.get_by_role("button", name="Get a code").click()
            expect(page.get_by_role("alert")).to_have_text("That code has expired. Codes work once, for a few minutes.")
            again = page.get_by_role("button", name="Get a new code")
            expect(again).to_be_visible()
            again.click()
            self.until(page, lambda: sum(1 for item in received if isinstance(item.get("ticket"), dict)) == 2, f"Get a new code to start a new sign-in ({received})")
            page.context.close()

    def test_06_signed_in_says_who_pays_and_settings_shows_codex(self) -> None:
        done = {"t": "done", "ended": "exited", "disposition": "accepted", "signedIn": True, "status": SIGNED_IN}
        page, _ = self.stubbed(phone=True, script=[{"t": "state", "state": "running"}, {"t": "device", "url": "https://auth.openai.com/codex/device", "code": CODE}, done])
        page.goto("/settings/agents/codex")
        page.get_by_role("button", name="Get a code").click()
        expect(page.get_by_role("heading", name="Signed in")).to_be_visible()
        expect(page.get_by_text("Who pays: Your ChatGPT plan (plan limits or credits, not visible to Flux).")).to_be_visible()
        page.context.close()
        for dark in (False, True):
            page, _ = self.stubbed(phone=True, script=[], status=SIGNED_IN, dark=dark)
            page.goto("/settings/agents")
            block = page.get_by_label("Codex in Flux", exact=True)
            expect(block).to_contain_text("Codex in Flux · signed in")
            expect(block).to_contain_text("ChatGPT · your subscription")
            expect(block.get_by_role("button", name="Sign out of ChatGPT")).to_be_visible()
            expect(page.get_by_role("link", name=re.compile("^Sign in with ChatGPT"))).to_have_count(0)
            self.no_sideways_scroll(page)
            shot(page, f"codex-signed-in-settings-phone-390-{'dark' if dark else 'light'}")
            page.context.close()

    def test_07_other_ways_run_the_terminal_with_no_key_field(self) -> None:
        page, received = self.stubbed(phone=False, script=[{"t": "state", "state": "running"}])
        page.goto("/settings/agents/codex")
        page.locator("details.rt-more summary").filter(has_text="Other ways to sign in").click()
        page.get_by_role("button", name=re.compile("^OpenAI API key")).click()
        expect(page.get_by_label("Codex sign-in terminal")).to_be_visible()
        expect(page.locator("input")).to_have_count(0)  # the key goes to the CLI's own input, never a Flux field
        page.get_by_role("button", name="Done, finish sign-in").click()
        self.assertIn({"ticket": {"client": "codex", "method": "api_key"}}, received)
        self.until(page, lambda: {"t": "in", "d": "\u0004\u0004"} in received, "the end-of-input reached the console")

    def claude_card(self, *, phone: bool, dark: bool = False, clipboard: str | None = None, **options):
        page, received = self.stubbed(phone=phone, dark=dark, script=[{"t": "state", "state": "running"}, {"t": "link", "url": CLAUDE_URL}], clipboard=clipboard, **options)
        page.goto("/settings/agents/claude-code")
        page.get_by_role("button", name="Sign in with Claude").click()
        return page, received

    def test_08_claude_card_open_claude_and_paste_from_the_clipboard(self) -> None:
        """AST-1.5: "Open claude.ai" with the URL the CLI printed, "Paste" sends the clipboard to the CLI's prompt; the terminal is under Show details."""
        for phone in (True, False):
            page, received = self.claude_card(phone=phone, clipboard="the-code#st4te_-x")
            expect(page.get_by_text("Sign in to Claude:")).to_be_visible()
            expect(page.get_by_text("Open claude.ai and approve.")).to_be_visible()
            expect(page.get_by_text("Paste the code here.")).to_be_visible()
            opener = page.get_by_role("link", name="Open claude.ai")
            expect(opener).to_have_attribute("href", CLAUDE_URL)
            expect(opener).to_have_attribute("rel", "noopener noreferrer")
            details = page.locator(".rt-device details.rt-more")
            self.assertFalse(details.evaluate("d => d.open"), "the terminal starts folded under Show details")
            expect(details.locator("summary")).to_have_text("Show details")
            if phone:
                self.assertGreaterEqual(opener.bounding_box()["height"], 44)
                self.assertGreaterEqual(page.get_by_role("button", name="Paste", exact=True).bounding_box()["height"], 44)
            self.no_sideways_scroll(page)
            shot(page, f"claude-card-{'phone-390' if phone else 'desktop-1440'}-light")
            page.get_by_role("button", name="Paste", exact=True).click()
            self.until(page, lambda: {"t": "in", "d": "the-code#st4te_-x\r"} in received, f"the clipboard text to reach the CLI's prompt ({received})")
            expect(page.get_by_text(re.compile("Code sent"))).to_be_visible()
            page.context.close()

    def test_08b_claude_card_dark_and_other_ways(self) -> None:
        for phone in (True, False):
            page, received = self.claude_card(phone=phone, dark=True)
            expect(page.get_by_role("link", name="Open claude.ai")).to_be_visible()
            self.no_sideways_scroll(page)
            shot(page, f"claude-card-{'phone-390' if phone else 'desktop-1440'}-dark")
            page.context.close()
        page, received = self.stubbed(phone=False, script=[{"t": "state", "state": "running"}, {"t": "link", "url": CLAUDE_URL}])
        page.goto("/settings/agents/claude-code")
        expect(page.get_by_role("radio")).to_have_count(0)
        page.locator("details.rt-more summary").filter(has_text="Other ways to sign in").click()
        expect(page.get_by_role("button", name=re.compile("^Single sign-on"))).to_be_visible()
        page.get_by_role("button", name=re.compile("^Anthropic Console")).click()
        self.assertIn({"ticket": {"client": "claude_code", "method": "console"}}, received)
        expect(page.get_by_role("link", name="Open the Anthropic Console")).to_have_attribute("href", CLAUDE_URL)

    def test_08c_an_unreadable_clipboard_opens_the_box_under_show_details(self) -> None:
        page, received = self.claude_card(phone=True)  # reading the clipboard is denied
        page.get_by_role("button", name="Paste", exact=True).click()
        expect(page.get_by_text(re.compile("can’t read your clipboard"))).to_be_visible()
        box = page.get_by_label("Paste the code from the sign-in page")
        expect(box).to_be_visible()
        self.assertGreaterEqual(float(box.evaluate("el => parseFloat(getComputedStyle(el).fontSize)")), 16)
        box.fill("typed-code#st4te_-x")
        page.get_by_role("button", name="Send").click()
        self.until(page, lambda: {"t": "in", "d": "typed-code#st4te_-x\r"} in received, "the typed code to reach the prompt")
        self.no_sideways_scroll(page)

    def test_09_a_reload_while_signing_in_takes_the_same_sign_in_back(self) -> None:
        """AST-1.5 / AST-1.6: with a sign-in pending in this session, the page asks to resume it and attaches with that ticket; no new sign-in starts."""
        pending = copy.deepcopy(SIGNED_OUT)
        pending["auth"] = {"claude_code": "signing_in"}
        page, received = self.stubbed(phone=True, status=pending, resume={"client": "claude_code", "method": "claude_account"},
                                      script=[{"t": "state", "state": "running"}, {"t": "link", "url": CLAUDE_URL}])
        page.goto("/settings/agents/claude-code")
        expect(page.get_by_role("link", name="Open claude.ai")).to_have_attribute("href", CLAUDE_URL)
        self.assertIn({"resume": {"client": "claude_code"}}, received)
        self.assertTrue(any(item.get("t") == "attach" and item.get("ticket") == "stub-resume" for item in received))
        self.assertFalse(any("ticket" in item and isinstance(item["ticket"], dict) for item in received), "no new sign-in was started")
        page.context.close()

        pending["auth"] = {"codex": "signing_in"}
        page, received = self.stubbed(phone=True, status=pending, resume={"client": "codex", "method": "device_code"},
                                      script=[{"t": "state", "state": "running"}, {"t": "device", "url": "https://auth.openai.com/codex/device", "code": CODE}])
        page.goto("/settings/agents/codex")
        expect(page.locator(".rt-device__code")).to_have_text(CODE)
        self.assertTrue(any(item.get("t") == "attach" and item.get("ticket") == "stub-resume" for item in received))

    def test_09b_another_session_is_refused_and_sees_nothing(self) -> None:
        pending = copy.deepcopy(SIGNED_OUT)
        pending["auth"] = {"claude_code": "signing_in"}
        page, received = self.stubbed(phone=False, status=pending, script=[])  # the resume answer is 404: not this session's sign-in
        page.goto("/settings/agents/claude-code")
        expect(page.get_by_text("Another sign-in, check or sign-out is still in progress.")).to_be_visible()
        expect(page.get_by_role("button", name="Sign in with Claude")).to_be_disabled()
        expect(page.get_by_role("link", name="Open claude.ai")).to_have_count(0)
        self.assertFalse(any(item.get("t") == "attach" for item in received))

    def until(self, page: Page, check, what: str, timeout_ms: int = 10000) -> None:
        """Waits on state: each evaluate lets Playwright deliver pending socket events; no fixed sleep."""
        deadline = time.monotonic() + timeout_ms / 1000
        while not check():
            if time.monotonic() > deadline:
                self.fail(f"timed out waiting for {what}")
            page.evaluate("() => new Promise((resolve) => requestAnimationFrame(() => resolve(true)))")


if __name__ == "__main__":
    unittest.main()
