"""Browser tests for Claude Code in Flux: Settings → Agent in Flux → Sign in to Claude Code (F-022 T4, #279).

Two stacks run this module:

- scripts/check_ui.sh, where the operator switch FLUX_AGENT_RUNTIME is empty (the default): the
  settings page says plainly that the server does not offer it, at phone width;
- scripts/check_agent_runtime.sh, with FLUX_UI_RUNTIME=on, against the runtime profile with the
  TEST ONLY fake `claude` (its `auth login` prints the URL and prompt as the pinned Claude Code
  2.1.285 does). There the whole sign-in runs at phone width (390×844, touch) and at 1440×900:
  the notices before sign-in, the method choice, the terminal with the CLI's URL, the pasted code,
  the signed-in facts, sign-out and Remove runtime. The account-change and failed-logout notices
  are rendered from a stubbed status, which proves wording and layout, not behaviour (the API suite
  tests/app/agent-runtime-console.test.ts proves those).
"""

from __future__ import annotations

import copy
import json
import os
import re
import time
import unittest

from playwright.sync_api import Error as PlaywrightError, Browser, BrowserContext, Page, Route, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot, start_forwarder

RUNTIME = os.environ.get("FLUX_UI_RUNTIME") == "on"
PASSWORD = "a terminal that stays mine"
STAMP = int(time.time() * 1000)
RAE = {"name": "Rae Novak", "email": f"rae.novak+{STAMP}@example.test"}
FORBIDDEN = re.compile(r"setup.?token|auth\.json|api.?key|session.?(key|token)|oauth.?token|access.?token|refresh.?token|credential", re.I)


class RuntimeConsole(unittest.TestCase):
    """Tests run in name order and share one account."""

    pw = None
    browser: Browser
    state: dict | None = None

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        expect.set_options(timeout=15000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def context(self, *, phone: bool) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "color_scheme": "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw"}
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=DESKTOP, device_scale_factor=1)
        if self.state:
            options["storage_state"] = self.state
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        return context

    def page(self, *, phone: bool = True) -> Page:
        page = self.context(phone=phone).new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def api(self, page: Page, method: str, path: str, body: dict | None = None) -> dict:
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers={"origin": ORIGIN, "content-type": "application/json"},
                                      data=json.dumps(body) if body is not None else None)
        self.assertLess(response.status, 300, response.text())
        return json.loads(response.text()) if response.text() else {}

    # ------------------------------------------------------------------ layout checks (HIG-05/08/14/41)

    def phone_layout(self, page: Page, scope: str) -> None:
        """No sideways scroll; every control a 44 px target; fields at 16 px; no text under 11 px."""
        self.assertLessEqual(page.evaluate("document.scrollingElement.scrollWidth"), page.evaluate("document.scrollingElement.clientWidth"), "no sideways scroll")
        report = page.evaluate("""(scope) => {
          const root = document.querySelector(scope);
          const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
          const small = [...root.querySelectorAll('button, a.ui-btn, label.rt-method, .rt-code input, a.ui-link')].filter(visible)
            .filter((el) => !el.closest('.xterm'))
            .map((el) => ({ text: el.textContent.trim().slice(0, 40), h: el.getBoundingClientRect().height,
              inline: el.matches('a.ui-link, button.ui-link') && !el.parentElement.matches('.aset__actions') }))
            // HIG-14: 44 px for controls; 28 px for a link inside running text.
            .filter((t) => t.inline ? t.h < 28 : t.h < 44);
          // HIG-08's 16px font prevents text-entry focus zoom; it does not apply to native toggles.
          const fields = [...document.querySelectorAll('input:not([type=radio]):not([type=checkbox]):not([type=hidden]), textarea, select')]
            .filter(visible).map((el) => parseFloat(getComputedStyle(el).fontSize)).filter((size) => size < 16);
          const toggles = [...document.querySelectorAll('input[type=checkbox], input[type=radio]')].filter(visible)
            .map((el) => { const target = [...(el.labels || [])].find(visible) || el; return { type: el.type, h: target.getBoundingClientRect().height }; })
            .filter((target) => target.h < 44);

          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          const tiny = [];
          while (walker.nextNode()) {
            const node = walker.currentNode; const el = node.parentElement;
            if (!node.textContent.trim() || !el || !visible(el)) continue;
            const size = parseFloat(getComputedStyle(el).fontSize);
            if (size < 11) tiny.push(node.textContent.trim().slice(0, 30));
          }
          const wide = [...root.querySelectorAll('*')].filter(visible).filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1).map((el) => el.className).slice(0, 5);
          return { small, fields, toggles, tiny, wide };
        }""", scope)
        self.assertEqual(report["small"], [], "every control is a 44 px target")
        self.assertEqual(report["fields"], [], "every editable field is at least 16 px (no zoom on focus)")
        self.assertEqual(report["toggles"], [], "every native toggle has a 44 px labelled target")
        self.assertEqual(report["tiny"], [], "no text under 11 px")
        self.assertEqual(report["wide"], [], "nothing extends past the screen")

    def no_credential_fields(self, page: Page) -> None:
        fields = page.evaluate("""() => [...document.querySelectorAll('input, textarea, select')].filter((el) => !el.closest('.xterm'))
          .map((el) => [el.type, el.name, el.id, el.getAttribute('aria-label') || '', el.labels && el.labels[0] ? el.labels[0].textContent : ''].join(' '))""")
        for field in fields:
            self.assertIsNone(FORBIDDEN.search(field), f"a credential field: {field}")

    # ------------------------------------------------------------------ journey

    def test_01_sign_up(self) -> None:
        page = self.page()
        page.goto("/sign-up")
        page.get_by_label("Name").fill(RAE["name"])
        page.get_by_label("Email").fill(RAE["email"])
        page.get_by_label("Password").fill(PASSWORD)
        with page.expect_response(lambda response: response.url.endswith("/api/auth/sign-up/email") and response.request.method == "POST") as registered:
            page.get_by_role("button", name="Create account").click()
        self.assertEqual(registered.value.status, 200)
        expect(page).not_to_have_url(re.compile(r"/sign-up(?:\?|$)"))
        self.api(page, "GET", "/api/v1/me")  # prove the session before sharing its cookie state
        type(self).state = page.context.storage_state()

    @unittest.skipIf(RUNTIME, "the runtime is on in this stack")
    def test_02_off_the_server_says_so(self) -> None:
        page = self.page()
        page.goto("/settings/assistant")
        section = page.locator("section.rt")
        expect(section.get_by_role("heading", name="Claude Code in Flux")).to_be_visible()
        expect(section).to_contain_text("Not turned on for this Flux server.")
        expect(section).to_contain_text("The person who runs this server decides whether it is offered.")
        expect(section.get_by_role("link", name="agent connection (MCP)")).to_have_attribute("href", "/connect-agent")
        expect(section.get_by_role("link", name="Sign in to Claude Code")).to_have_count(0)
        self.phone_layout(page, "section.rt")
        self.no_credential_fields(page)
        shot(page, "runtime-off-phone-390")
        page.goto("/settings/assistant/claude-code")
        expect(page.get_by_role("note")).to_contain_text("Claude Code in Flux isn’t offered on this Flux server.")

    @unittest.skipUnless(RUNTIME, "needs the runtime profile (scripts/check_agent_runtime.sh)")
    def test_03_before_sign_in_the_notices_are_plain(self) -> None:
        page = self.page()
        page.goto("/settings/assistant")
        section = page.locator("section.rt")
        expect(section.get_by_role("heading", name=re.compile("Claude Code in Flux · not signed in"))).to_be_visible()
        facts = section.get_by_role("list", name="Before you sign in")
        expect(facts).to_contain_text("The person who runs this server can technically read that storage")
        expect(facts).to_contain_text("Anthropic recommends API keys for products and automation, and may restrict this kind of use without notice")
        expect(facts).to_contain_text("your Claude plan, your organization’s plan, or your Anthropic Console organization")
        expect(facts).to_contain_text("Never your password, the sign-in code or the login itself.")
        expect(facts).to_contain_text("agreed to Anthropic’s Commercial Terms on 2026-10-05")
        expect(section.locator("img, svg[data-logo]")).to_have_count(0)
        self.phone_layout(page, "section.rt")
        self.no_credential_fields(page)
        shot(page, "runtime-before-phone-390")

    @unittest.skipUnless(RUNTIME, "needs the runtime profile (scripts/check_agent_runtime.sh)")
    def test_04_sign_in_in_the_console_at_phone_width(self) -> None:
        page = self.page()
        page.goto("/settings/assistant")
        page.get_by_role("link", name="Sign in to Claude Code").tap()
        expect(page).to_have_url(re.compile(r"/settings/assistant/claude-code$"))
        expect(page.get_by_role("group", name="How do you want to sign in?")).to_be_visible()
        for title in ("Claude account", "Anthropic Console", "Single sign-on (SSO)"):
            expect(page.get_by_role("radio", name=re.compile(re.escape(title)))).to_be_visible()
        page.get_by_role("radio", name=re.compile("Anthropic Console")).tap()
        expect(page.locator(".rt-method.is-on")).to_contain_text("Who pays: Your Anthropic Console organization (API billing, cost not reported to Flux).")
        self.phone_layout(page, ".rt-page")
        self.no_credential_fields(page)
        shot(page, "runtime-methods-phone-390")
        page.get_by_role("button", name="Start sign-in").tap()
        expect(page.get_by_role("status").filter(has_text="Claude Code is waiting for you to sign in.")).to_be_visible()
        expect(page.locator(".xterm-rows")).to_contain_text("Paste code here if prompted", use_inner_text=True)
        opener = page.get_by_role("link", name=re.compile(r"Open the sign-in page \(platform\.claude\.com\)"))
        expect(opener).to_be_visible()
        self.assertTrue(opener.get_attribute("href").startswith("https://platform.claude.com/oauth/authorize?"))
        self.assertEqual(opener.get_attribute("rel"), "noopener noreferrer")
        self.phone_layout(page, ".rt-page")
        self.no_credential_fields(page)
        shot(page, "runtime-console-phone-390")
        code = page.get_by_label("Paste the code from the sign-in page")
        code.tap()
        code.fill("fake-code-from-the-phone")
        page.get_by_role("button", name="Send").tap()
        outcome = page.locator(".rt-outcome")
        expect(outcome.get_by_role("heading", name="Signed in")).to_be_visible()
        expect(outcome).to_contain_text("Claude Code reports a login as o***@example.org")
        expect(outcome).to_contain_text("Who pays: Your Anthropic Console organization (API billing, cost not reported to Flux).")
        self.phone_layout(page, ".rt-page")
        shot(page, "runtime-signed-in-phone-390")
        page.get_by_role("link", name="Back to Agent in Flux").tap()
        section = page.locator("section.rt")
        expect(section.get_by_role("heading", name=re.compile("Claude Code in Flux · signed in"))).to_be_visible()
        expect(section.get_by_role("list", name="Your sign-in")).to_contain_text("Anthropic Console · o***@example.org")
        for name in ("Check sign-in", "Sign out", "Remove runtime…"):
            expect(section.get_by_role("button", name=name)).to_be_visible()
        self.phone_layout(page, "section.rt")
        shot(page, "runtime-settings-signed-in-phone-390")

    @unittest.skipUnless(RUNTIME, "needs the runtime profile (scripts/check_agent_runtime.sh)")
    def test_05_notices_at_phone_width(self) -> None:
        page = self.page()
        real = self.api(page, "GET", "/api/v1/agent-runtime")
        stubbed = copy.deepcopy(real)
        connection = stubbed["connections"]["claude_code"]
        connection["accountChange"] = {"previousLabel": "r***@example.test", "at": "2026-10-06T09:41:00.000Z"}

        def status(route: Route) -> None:
            route.fulfill(status=200, content_type="application/json", body=json.dumps(stubbed))

        page.route("**/api/v1/agent-runtime", status)
        page.goto("/settings/assistant")
        notice = page.get_by_role("alert").filter(has_text="Signed in to a different account than before.")
        expect(notice).to_contain_text("It was r***@example.test; now it is o***@example.org.")
        expect(notice).to_contain_text("If you didn’t do this, sign out here now and change your Flux password.")
        expect(notice.get_by_role("button", name="Got it")).to_be_visible()
        self.phone_layout(page, "section.rt")
        shot(page, "runtime-account-change-phone-390")
        page.unroute("**/api/v1/agent-runtime")
        signed_out = copy.deepcopy(real)
        signed_out["connections"]["claude_code"].update(state="signed_out", payer=None, signOut={"at": "2026-10-06T09:45:00.000Z", "failed": True})
        page.route("**/api/v1/agent-runtime", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(signed_out)))
        page.reload()
        expect(page.get_by_role("note").filter(has_text="Anthropic didn’t confirm the sign-out.")).to_contain_text(
            "Flux deleted the login from your runtime anyway. To be sure it can’t be used, end the session in your Claude account or Anthropic Console settings.")
        self.phone_layout(page, "section.rt")
        shot(page, "runtime-signout-failed-phone-390")

    @unittest.skipUnless(RUNTIME, "needs the runtime profile (scripts/check_agent_runtime.sh)")
    def test_06_sign_out_at_phone_width(self) -> None:
        page = self.page()
        page.goto("/settings/assistant")
        section = page.locator("section.rt")
        section.get_by_role("button", name="Sign out").tap()
        expect(section.get_by_role("heading", name=re.compile("Claude Code in Flux · not signed in"))).to_be_visible()
        expect(section.get_by_role("link", name="Sign in to Claude Code")).to_be_visible()
        self.assertEqual(self.api(page, "GET", "/api/v1/agent-runtime")["connections"]["claude_code"]["state"], "signed_out")

    @unittest.skipUnless(RUNTIME, "needs the runtime profile (scripts/check_agent_runtime.sh)")
    def test_07_desktop_console_a_wrong_code_and_cancel(self) -> None:
        page = self.page(phone=False)
        page.goto("/settings/assistant/claude-code")
        page.get_by_role("radio", name=re.compile("Claude account")).check()
        page.get_by_role("button", name="Start sign-in").click()
        expect(page.locator(".xterm-rows")).to_contain_text("Paste code here if prompted", use_inner_text=True)
        expect(page.get_by_role("link", name=re.compile(r"Open the sign-in page \(claude\.com\)"))).to_be_visible()
        shot(page, "runtime-console-desktop-1440")
        # The terminal takes typing directly too: a wrong code is refused by the CLI's own prompt.
        page.locator(".rt-term").click()
        page.keyboard.type("not-a-code")
        page.keyboard.press("Enter")
        outcome = page.locator(".rt-outcome")
        expect(outcome.get_by_role("heading", name="Not signed in")).to_be_visible()
        expect(outcome).to_contain_text("Claude Code ended without reporting a login")
        shot(page, "runtime-not-signed-in-desktop-1440")
        page.get_by_role("button", name="Start again").click()
        page.get_by_role("button", name="Start sign-in").click()
        expect(page.locator(".xterm-rows")).to_contain_text("Paste code here if prompted", use_inner_text=True)
        page.get_by_role("button", name="Cancel sign-in").click()
        expect(page.locator(".rt-outcome")).to_contain_text("You cancelled the sign-in. Runtime access stays disabled until cleanup is confirmed")
        current = self.api(page, "GET", "/api/v1/agent-runtime")
        self.assertIsNone(current["connections"]["claude_code"])
        if current["binding"] is not None:
            self.assertEqual(current["binding"]["state"], "releasing")
            self.assertTrue(current["binding"]["recovery"])
        else:
            self.assertEqual(current["lastRelease"]["reason"], "auth_recovery")

    @unittest.skipUnless(RUNTIME, "needs the runtime profile (scripts/check_agent_runtime.sh)")
    def test_08_remove_runtime_at_phone_width(self) -> None:
        page = self.page()
        # The preceding cancelled console requires full recovery. Bind only after it is gone.
        deadline = time.time() + 60
        while self.api(page, "GET", "/api/v1/agent-runtime")["binding"] is not None and time.time() < deadline:
            time.sleep(0.2)
        self.assertIsNone(self.api(page, "GET", "/api/v1/agent-runtime")["binding"])
        self.api(page, "POST", "/api/v1/agent-runtime/binding")
        page.goto("/settings/assistant")
        section = page.locator("section.rt")
        section.get_by_role("button", name="Remove runtime…").tap()
        confirm = page.get_by_role("group", name="Remove your runtime")
        expect(confirm).to_contain_text("Flux signs Claude Code out first, then deletes your runtime’s files")
        self.phone_layout(page, "section.rt")
        shot(page, "runtime-remove-phone-390")
        confirm.get_by_role("button", name="Sign out and remove").tap()
        expect(section.get_by_role("heading", name=re.compile("Claude Code in Flux · removing"))).to_be_visible()
        expect(section.get_by_role("heading", name=re.compile("Claude Code in Flux · not signed in"))).to_be_visible(timeout=60000)
        deadline = time.time() + 30
        while self.api(page, "GET", "/api/v1/agent-runtime")["binding"] is not None and time.time() < deadline:
            time.sleep(0.5)
        self.assertIsNone(self.api(page, "GET", "/api/v1/agent-runtime")["binding"])


    def runtime_snapshot(self) -> dict:
        return {
            "enabled": True, "clients": {"claude_code": "available", "codex": "off"}, "commercialTerms": None,
            "idleReleaseDays": None, "pool": "available", "lastRelease": None,
            "binding": {"state": "active", "boundAt": "2026-10-07T10:00:00.000Z", "lastUsedAt": None, "idleReleaseAt": None},
            "connections": {"codex": None, "claude_code": {
                "state": "signed_in", "signInMethod": "sso", "authMethod": "claude.ai", "plan": "max",
                "accountLabel": "a***@example.org", "signedInAt": "2026-10-07T10:00:00.000Z", "payer": "claude_plan",
                "accountChange": None, "signOut": None,
            }}, "auth": {},
        }

    def held_poll(self, *, remove: bool) -> None:
        """Mounted component with a real fetch held before delivery, not an implementation mirror."""
        page = self.page()
        previous = self.runtime_snapshot()
        initial = copy.deepcopy(previous)
        initial["auth"] = {"claude_code": "checking"}  # causes the ordinary background poll
        restrictive = copy.deepcopy(previous)
        if remove:
            restrictive["binding"].update(state="releasing", recovery=True)
            restrictive["connections"]["claude_code"] = None
        else:
            restrictive["connections"]["claude_code"].update(state="signed_out", signedInAt=None,
                signOut={"at": "2026-10-07T10:01:00.000Z", "failed": False})
        held: list[Route] = []
        completed = []
        page.on("requestfinished", lambda request: completed.append(request))
        page.on("requestfailed", lambda request: completed.append(request))
        reads = 0
        acted = False

        def read(route: Route) -> None:
            nonlocal reads
            reads += 1
            if reads == 2:
                held.append(route)
            else:
                route.fulfill(status=200, content_type="application/json", body=json.dumps(restrictive if acted else initial))

        def action(route: Route) -> None:
            nonlocal acted
            if route.request.method == ("DELETE" if remove else "POST"):
                acted = True
                route.fulfill(status=202 if remove else 200, content_type="application/json", body=json.dumps(restrictive))
            else:
                route.continue_()

        page.route("**/api/v1/agent-runtime", read)
        page.route("**/api/v1/agent-runtime/binding" if remove else "**/api/v1/agent-runtime/sign-out", action)
        page.goto("/settings/assistant")
        section = page.locator("section.rt")
        expect(section.get_by_role("heading", name="Claude Code in Flux · signed in")).to_be_visible()
        deadline = time.time() + 10
        while not held and time.time() < deadline:
            page.wait_for_timeout(20)
        self.assertEqual(len(held), 1, "actual background GET reached the delivery barrier")
        if remove:
            section.get_by_role("button", name="Remove runtime…").tap()
            page.get_by_role("group", name="Remove your runtime").get_by_role("button", name="Sign out and remove").tap()
        else:
            section.get_by_role("button", name="Sign out", exact=True).tap()
        expected = "Claude Code in Flux · removing" if remove else "Claude Code in Flux · not signed in"
        expect(section.get_by_role("heading", name=expected)).to_be_visible()
        try:
            held[0].fulfill(status=200, content_type="application/json", body=json.dumps(previous))
        except PlaywrightError:
            self.assertIn(held[0].request, completed, "only an actually aborted fetch may refuse delivery")
        deadline = time.time() + 5
        while held[0].request not in completed and time.time() < deadline:
            page.wait_for_timeout(20)
        self.assertIn(held[0].request, completed, "held fetch has finished or been aborted")
        page.evaluate("async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); }")
        expect(section.get_by_role("heading", name=expected)).to_be_visible()
        expect(section.get_by_role("button", name="Sign out", exact=True)).to_have_count(0)
        self.phone_layout(page, "section.rt")
        shot(page, "runtime-held-poll-remove-phone-390" if remove else "runtime-held-poll-signout-phone-390")

    def test_09_held_poll_cannot_restore_signed_in_after_sign_out(self) -> None:
        self.held_poll(remove=False)

    def test_10_held_poll_cannot_restore_signed_in_after_remove(self) -> None:
        self.held_poll(remove=True)

    def test_11_unconfirmed_release_and_unknown_removal_never_claim_success(self) -> None:
        page = self.page()
        released = self.runtime_snapshot()
        released.update(binding=None, connections={"claude_code": None, "codex": None},
            lastRelease={"reason": "operator", "at": "2026-10-07T10:01:00.000Z", "signOutFailed": True})
        page.route("**/api/v1/agent-runtime", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(released)))
        page.goto("/settings/assistant")
        section = page.locator("section.rt")
        expect(section).to_contain_text("Vendor sign-out was not confirmed")
        expect(section).not_to_contain_text("It signed out first")
        page.unroute("**/api/v1/agent-runtime")
        current = self.runtime_snapshot()
        page.route("**/api/v1/agent-runtime", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(current)))
        page.reload()
        page.route("**/api/v1/agent-runtime/binding", lambda route: route.fulfill(status=503, content_type="application/json", body='{"error":"unavailable"}'))
        section.get_by_role("button", name="Remove runtime…").tap()
        page.get_by_role("group", name="Remove your runtime").get_by_role("button", name="Sign out and remove").tap()
        expect(section.get_by_role("alert")).to_contain_text("Removal could not be confirmed")
        expect(section).not_to_contain_text("Nothing changed")
        self.phone_layout(page, "section.rt")


if __name__ == "__main__":
    unittest.main()
