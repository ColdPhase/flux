"""Browser tests for Sign in with ChatGPT (F-022 T6 #281; F-027 AST-1.6 and AST-1.8, card A12).

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

    def stubbed(self, *, phone: bool, script: list[dict], status: dict | None = None, dark: bool = False) -> tuple[Page, list[dict]]:
        """A page whose runtime status, ticket and console socket are stubbed; the socket answers `attach` with `script`."""
        context = self.context(phone=phone, dark=dark)
        received: list[dict] = []
        context.route(re.compile(r".*/api/v1/agent-runtime$"), lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(status or SIGNED_OUT)))

        def ticket(route) -> None:
            received.append({"ticket": json.loads(route.request.post_data or "{}")})
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"ticket": "stub-ticket", "expiresAt": "2026-10-16T10:01:00.000Z"}))

        context.route(re.compile(r".*/api/v1/agent-runtime/console$"), ticket)

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
            expect(page.get_by_role("heading", level=2, name="Sign in to ChatGPT")).to_be_visible()
            page.get_by_role("button", name="Get a code").click()
            code = page.locator(".rt-device__code")
            expect(code).to_have_text(CODE)
            self.assertGreaterEqual(float(code.evaluate("el => parseFloat(getComputedStyle(el).fontSize)")), 24, "the code is large")
            expect(page.get_by_text("Enter this code on chatgpt.com:")).to_be_visible()
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
            self.until(page, lambda: sum(1 for item in received if "ticket" in item) == 2, "Get a new code to start a new sign-in")
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
            block = page.get_by_label("Codex in Flux")
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

    def until(self, page: Page, check, what: str, timeout_ms: int = 10000) -> None:
        """Waits on state: each evaluate lets Playwright deliver pending socket events; no fixed sleep."""
        deadline = time.monotonic() + timeout_ms / 1000
        while not check():
            if time.monotonic() > deadline:
                self.fail(f"timed out waiting for {what}")
            page.evaluate("() => new Promise((resolve) => requestAnimationFrame(() => resolve(true)))")


if __name__ == "__main__":
    unittest.main()
