"""Browser tests for Claude Code in Flux: Settings → Agents and AI → Sign in to Claude Code (F-022 T4, #279).

Two stacks run this module:

- scripts/check_ui.sh, where the operator switch FLUX_AGENT_RUNTIME is empty (the default): the
  settings page says plainly that the server does not offer it, at phone width;
- scripts/check_agent_runtime.sh, with FLUX_UI_RUNTIME=on, against the runtime profile with the
  TEST ONLY fake `claude` (its `auth login` prints the URL and prompt as the pinned Claude Code
  2.1.285 does). There the whole sign-in runs at phone width (390×844, touch) and at 1440×900:
  the notices before sign-in, the method choice, the terminal with the CLI's URL, the pasted code,
  the signed-in facts, sign-out and removal of the shared runtime space. The account-change and failed-logout notices
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
UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
if UI_BROWSER not in ("chromium", "webkit"):
    raise ValueError(f"FLUX_UI_BROWSER must be chromium or webkit, got {UI_BROWSER!r}")

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
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=15000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def context(self, *, phone: bool) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "color_scheme": "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw", "service_workers": "block"}
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
        # A JSON content type with an empty body is refused by the server, so only a body sends one.
        headers = {"origin": ORIGIN, **({"content-type": "application/json"} if body is not None else {})}
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers=headers,
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
          // HIG-41's 16px text-entry rule also covers hidden-until-opened fields, not native toggles.
          const fields = [...document.querySelectorAll('input:not([type=radio]):not([type=checkbox]):not([type=hidden]), textarea, select')]
            .map((el) => parseFloat(getComputedStyle(el).fontSize)).filter((size) => size < 16);
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
        page.goto("/settings/agents")
        section = page.locator("section.rt")
        expect(section.get_by_role("heading", name="Claude Code in Flux")).to_be_visible()
        expect(section).to_contain_text("Signing in with your Claude or ChatGPT subscription isn’t turned on for this Flux server.")
        expect(section.get_by_role("link", name=re.compile("^Use an API key"))).to_be_visible()
        expect(section.get_by_role("link", name="Sign in with Claude")).to_have_count(0)
        self.phone_layout(page, "section.rt")
        self.no_credential_fields(page)
        shot(page, "runtime-off-phone-390")
        page.goto("/settings/agents/claude-code")
        expect(page.get_by_role("note")).to_contain_text("Claude Code in Flux isn’t offered on this Flux server.")
        page.goto("/settings/assistant/claude-code")  # the earlier address still opens the console
        expect(page).to_have_url(re.compile(r"/settings/agents/claude-code$"))

    @unittest.skipUnless(RUNTIME, "needs the runtime profile (scripts/check_agent_runtime.sh)")
    def test_03_before_sign_in_the_notices_are_plain(self) -> None:
        page = self.page()
        page.goto("/settings/agents")
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
        page.goto("/settings/agents")
        page.get_by_role("link", name="Sign in with Claude").tap()
        expect(page).to_have_url(re.compile(r"/settings/agents/claude-code$"))
        expect(page.get_by_role("button", name="Sign in with Claude")).to_be_visible()
        expect(page.get_by_role("radio")).to_have_count(0)
        page.locator("details.rt-more summary").filter(has_text="Other ways to sign in").tap()
        for title in ("Anthropic Console", "Single sign-on (SSO)"):
            expect(page.get_by_role("button", name=re.compile(re.escape(title)))).to_be_visible()
        expect(page.get_by_role("button", name=re.compile("Anthropic Console"))).to_contain_text("Who pays: Your Anthropic Console organization (API billing, cost not reported to Flux).")
        self.phone_layout(page, ".rt-page")
        self.no_credential_fields(page)
        shot(page, "runtime-methods-phone-390")
        page.get_by_role("button", name=re.compile("Anthropic Console")).tap()
        expect(page.get_by_text("Sign in to Claude:")).to_be_visible()
        opener = page.get_by_role("link", name="Open the Anthropic Console")
        expect(opener).to_be_visible()
        self.assertTrue(opener.get_attribute("href").startswith("https://platform.claude.com/oauth/authorize?"))
        self.assertEqual(opener.get_attribute("rel"), "noopener noreferrer")
        page.get_by_text("Show details").tap()
        expect(page.locator(".xterm-rows")).to_contain_text("Paste code here if prompted", use_inner_text=True)
        self.phone_layout(page, ".rt-page")
        shot(page, "runtime-console-phone-390")
        code = page.get_by_label("Paste the code from the sign-in page")
        code.tap()
        # Claude Code accepts only `code#state`, with the state of the URL it printed.
        state = re.search(r"[?&]state=([\w-]+)", opener.get_attribute("href")).group(1)
        code.fill(f"fake-code-from-the-phone#{state}")
        page.get_by_role("button", name="Send").tap()
        outcome = page.locator(".rt-outcome")
        expect(outcome.get_by_role("heading", name="Signed in")).to_be_visible()
        expect(outcome.get_by_role("heading", name="Signed in · o***@example.org")).to_be_visible()
        expect(outcome).to_contain_text("Claude Code reports a login as o***@example.org")
        expect(outcome).to_contain_text("Who pays: Your Anthropic Console organization (API billing, cost not reported to Flux).")
        self.phone_layout(page, ".rt-page")
        shot(page, "runtime-signed-in-phone-390")
        page.get_by_role("link", name="Back to Agents and AI").tap()
        section = page.locator("section.rt")
        expect(section.get_by_role("heading", name=re.compile("Claude Code in Flux · signed in"))).to_be_visible()
        expect(section.get_by_role("list", name="Your sign-in")).to_contain_text("Anthropic Console · API billing")
        expect(section.get_by_role("list", name="Your sign-in")).to_contain_text("o***@example.org")
        for name in ("Check sign-in", "Sign out", "Remove shared runtime space from Flux…"):
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
        page.goto("/settings/agents")
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
            "Flux deleted the login files from your shared runtime space anyway. To be sure the session can’t be used, end it in your Claude account or Anthropic Console settings.")
        self.phone_layout(page, "section.rt")
        shot(page, "runtime-signout-failed-phone-390")

    @unittest.skipUnless(RUNTIME, "needs the runtime profile (scripts/check_agent_runtime.sh)")
    def test_06_sign_out_at_phone_width(self) -> None:
        page = self.page()
        page.goto("/settings/agents")
        section = page.locator("section.rt")
        section.get_by_role("button", name="Sign out").tap()
        expect(section.get_by_role("heading", name=re.compile("Claude Code in Flux · not signed in"))).to_be_visible()
        expect(section.get_by_role("link", name="Sign in with Claude")).to_be_visible()
        self.assertEqual(self.api(page, "GET", "/api/v1/agent-runtime")["connections"]["claude_code"]["state"], "signed_out")

    @unittest.skipUnless(RUNTIME, "needs the runtime profile (scripts/check_agent_runtime.sh)")
    def test_07_desktop_console_a_wrong_code_and_cancel(self) -> None:
        page = self.page(phone=False)
        page.goto("/settings/agents/claude-code")
        page.get_by_role("button", name="Sign in with Claude").click()
        expect(page.get_by_role("link", name="Open claude.ai")).to_have_attribute("href", re.compile(r"^https://claude\.com/cai/oauth/authorize\?"))
        shot(page, "runtime-card-desktop-1440")
        page.get_by_text("Show details").click()
        expect(page.locator(".xterm-rows")).to_contain_text("Paste code here if prompted", use_inner_text=True)
        shot(page, "runtime-console-desktop-1440")
        # The terminal takes typing directly too: a wrong code is refused by the CLI's own prompt, which
        # keeps waiting for the right one (Claude Code 2.1.285 does not exit on it), so Flux reports nothing yet.
        page.locator(".rt-term").click()
        page.keyboard.type("not-a-code")
        page.keyboard.press("Enter")
        expect(page.locator(".xterm-rows")).to_contain_text("Invalid code. Please make sure the full code was copied.", use_inner_text=True)
        expect(page.get_by_role("link", name="Open claude.ai")).to_be_visible()
        expect(page.locator(".rt-outcome")).to_have_count(0)
        shot(page, "runtime-wrong-code-desktop-1440")
        page.get_by_role("button", name="Cancel sign-in").click()
        outcome = page.locator(".rt-outcome")
        expect(outcome.get_by_role("heading", name="Not signed in")).to_be_visible()
        expect(outcome).to_contain_text("You cancelled the sign-in. Runtime access stays disabled until cleanup is confirmed")
        shot(page, "runtime-not-signed-in-desktop-1440")
        current = self.api(page, "GET", "/api/v1/agent-runtime")
        self.assertIsNone(current["connections"]["claude_code"])
        if current["binding"] is not None:
            self.assertEqual(current["binding"]["state"], "releasing")
            self.assertTrue(current["binding"]["recovery"])
        else:
            self.assertEqual(current["lastRelease"]["reason"], "auth_recovery")

    @unittest.skipUnless(RUNTIME, "needs the runtime profile (scripts/check_agent_runtime.sh)")
    def test_07b_a_failed_sign_in_says_so_and_offers_start_again(self) -> None:
        # The TEST ONLY fake CLI fails the exchange for a code starting `fake-reject-` (the scenario file
        # cannot be seeded before the browser starts the sign-in).
        page = self.page(phone=False)
        # The cancelled console before this one requires full recovery; sign in only once a slot is ready.
        deadline = time.time() + 60
        while time.time() < deadline:
            current = self.api(page, "GET", "/api/v1/agent-runtime")
            if current["binding"] is None and current["pool"] == "available":
                break
            time.sleep(0.2)
        page.goto("/settings/agents/claude-code")
        page.get_by_role("button", name="Sign in with Claude").click()
        opener = page.get_by_role("link", name="Open claude.ai")
        expect(opener).to_be_visible()
        page.get_by_text("Show details").click()
        state = re.search(r"[?&]state=([\w-]+)", opener.get_attribute("href")).group(1)
        page.get_by_label("Paste the code from the sign-in page").fill(f"fake-reject-code#{state}")
        page.get_by_role("button", name="Send").click()
        outcome = page.locator(".rt-outcome")
        expect(outcome.get_by_role("heading", name="Not signed in")).to_be_visible()
        expect(outcome.get_by_role("alert")).to_contain_text("Claude Code ended without reporting a login, so you are not signed in.")
        expect(outcome.get_by_role("button", name="Start again")).to_be_visible()
        expect(page.get_by_role("heading", name="Signed in", exact=True)).to_have_count(0)
        shot(page, "runtime-failed-sign-in-desktop-1440")
        current = self.api(page, "GET", "/api/v1/agent-runtime")
        self.assertEqual(current["connections"]["claude_code"]["state"], "signed_out")
        self.assertIsNone(current["connections"]["claude_code"]["signedInAt"])
        outcome.get_by_role("button", name="Start again").click()
        expect(page.get_by_role("button", name="Sign in with Claude")).to_be_visible()

    @unittest.skipUnless(RUNTIME, "needs the runtime profile (scripts/check_agent_runtime.sh)")
    def test_07c_paste_and_a_reload_keep_the_same_sign_in_and_other_sessions_see_nothing(self) -> None:
        """AST-1.5: [ Paste ] reads the clipboard; a reload re-attaches the SAME CLI process (same URL state); another session sees nothing."""
        page = self.page(phone=False)
        deadline = time.time() + 60
        while time.time() < deadline:
            current = self.api(page, "GET", "/api/v1/agent-runtime")
            if current["binding"] is None and current["pool"] == "available":
                break
            time.sleep(0.2)
        clip = {"value": ""}
        page.expose_function("fluxClipboard", lambda: clip["value"])
        page.add_init_script("Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => undefined, readText: () => window.fluxClipboard() } });")
        page.goto("/settings/agents/claude-code")
        page.get_by_role("button", name="Sign in with Claude").click()
        opener = page.get_by_role("link", name="Open claude.ai")
        expect(opener).to_be_visible()
        url = opener.get_attribute("href")
        state = re.search(r"[?&]state=([\w-]+)", url).group(1)
        # Reload while the code is valid: the same session takes the same sign-in back, with the same URL.
        page.reload()
        expect(page.get_by_role("link", name="Open claude.ai")).to_have_attribute("href", url)
        page.get_by_text("Show details").click()
        expect(page.locator(".xterm-rows")).to_contain_text("Paste code here if prompted", use_inner_text=True)
        # A new session of the same owner sees no URL, cannot resume, and cannot attach with the old session's ticket.
        other = self.browser.new_context(base_url=ORIGIN, viewport=DESKTOP, service_workers="block")
        self.addCleanup(other.close)
        second = other.new_page()
        second.goto("/sign-in")
        second.get_by_label("Email").fill(RAE["email"])
        second.get_by_label("Password").fill(PASSWORD)
        second.get_by_role("button", name="Sign in").click()
        expect(second).not_to_have_url(re.compile(r"/sign-in"))
        resumed = second.request.fetch(f"{ORIGIN}/api/v1/agent-runtime/console/resume", method="POST", headers={"origin": ORIGIN, "content-type": "application/json"}, data=json.dumps({"client": "claude_code"}))
        self.assertEqual(resumed.status, 404)
        second.goto("/settings/agents/claude-code")
        expect(second.get_by_text("Another sign-in, check or sign-out is still in progress.")).to_be_visible()
        expect(second.get_by_role("link", name="Open claude.ai")).to_have_count(0)
        # The paste: the clipboard text goes to the original CLI's prompt, which completes the sign-in.
        clip["value"] = f"fake-code-from-the-clipboard#{state}"
        page.get_by_role("button", name="Paste", exact=True).click()
        outcome = page.locator(".rt-outcome")
        expect(outcome.get_by_role("heading", name=re.compile("^Signed in"))).to_be_visible()
        expect(outcome).to_contain_text("o***@example.org")
        shot(page, "runtime-signed-in-desktop-1440")
        self.assertEqual(self.api(page, "GET", "/api/v1/agent-runtime")["connections"]["claude_code"]["state"], "signed_in")

    @unittest.skipUnless(RUNTIME, "needs the runtime profile (scripts/check_agent_runtime.sh)")
    def test_08_remove_runtime_at_phone_width(self) -> None:
        page = self.page()
        # The preceding cancelled console requires full recovery. Bind only after it is gone and a slot is
        # ready again: until the recovered slot's supervisor restarts, bind answers 503 "starting; try again
        # shortly" (the status reports pool "starting"), as the API contract says.
        deadline = time.time() + 60
        while time.time() < deadline:
            current = self.api(page, "GET", "/api/v1/agent-runtime")
            if current["binding"] is None and current["pool"] == "available":
                break
            if current["binding"] is not None and current["binding"]["state"] == "active":
                break  # a failed sign-in (test_07b) keeps its binding: the owner stays bound and signed out
            time.sleep(0.2)
        current = self.api(page, "GET", "/api/v1/agent-runtime")
        if current["binding"] is None:
            self.assertEqual(current["pool"], "available")
            self.api(page, "POST", "/api/v1/agent-runtime/binding")
        page.goto("/settings/agents")
        section = page.locator("section.rt")
        section.get_by_role("button", name="Remove shared runtime space from Flux…").tap()
        confirm = page.get_by_role("group", name="Remove shared runtime space from Flux")
        expect(confirm).to_contain_text("Flux tries to sign out of Claude Code and Codex, then deletes both clients’ files from your shared runtime space on this server and frees the space for someone else.")
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

    def test_15_codex_only_and_mixed_client_copy_matrix(self) -> None:
        """The active CLI owns its sign-in facts; releasing the slot is described as shared."""
        signed_at = "2026-10-07T10:00:00.000Z"
        signed_out_at = "2026-10-07T10:01:00.000Z"

        def codex_connection(state: str, *, sign_out: dict | None = None) -> dict:
            signed_in = state == "signed_in"
            return {
                "state": state, "signInMethod": "device_code", "authMethod": "chatgpt.com" if signed_in else None,
                "plan": "Plus" if signed_in else None, "accountLabel": "c***@example.org" if signed_in else None,
                "signedInAt": signed_at if signed_in else None, "payer": "chatgpt_plan" if signed_in else None,
                "accountChange": None, "signOut": sign_out,
            }

        def codex_only(state: str, *, sign_out: dict | None = None) -> dict:
            current = self.runtime_snapshot()
            current.update(clients={"claude_code": "off", "codex": "available"}, commercialTerms=None,
                           connections={"claude_code": None, "codex": codex_connection(state, sign_out=sign_out)})
            return current

        # Codex-only, signed out: use OpenAI facts and disclosure, never Anthropic's.
        page = self.page()
        signed_out = codex_only("signed_out")
        page.route("**/api/v1/agent-runtime", lambda route: route.fulfill(
            status=200, headers={"cache-control": "no-store"}, content_type="application/json", body=json.dumps(signed_out)))
        page.goto("/settings/agents")
        section = page.locator("section.rt")
        expect(section.get_by_role("heading", name="Codex in Flux · not signed in")).to_be_visible()
        expect(section).to_contain_text("OpenAI’s rules")
        expect(section).to_contain_text("your ChatGPT plan")
        expect(section).not_to_contain_text("Anthropic")
        expect(section).not_to_contain_text("your Claude plan")
        section.locator("details.rt-more summary").filter(has_text="Which account should I use?").click()
        expect(section.locator("details.rt-more")).to_contain_text("A ChatGPT sign-in uses the account or organization you choose in Codex.")
        page.close()

        # Codex-only, signed in: the action names Codex and confirms the saved sign-out for Codex.
        page = self.page()
        signed_in = codex_only("signed_in")
        confirmed = codex_only("signed_out", sign_out={"at": signed_out_at, "failed": False})
        page.route("**/api/v1/agent-runtime", lambda route: route.fulfill(
            status=200, headers={"cache-control": "no-store"}, content_type="application/json", body=json.dumps(signed_in)))
        posted: list[dict] = []

        def sign_out(route: Route) -> None:
            posted.append(route.request.post_data_json)
            route.fulfill(status=200, headers={"cache-control": "no-store"}, content_type="application/json", body=json.dumps(confirmed))

        page.route("**/api/v1/agent-runtime/sign-out", sign_out)
        page.goto("/settings/agents")
        section = page.locator("section.rt")
        expect(section.get_by_role("heading", name="Codex in Flux · signed in")).to_be_visible()
        expect(section.get_by_role("list", name="Your Codex sign-in")).to_contain_text("c***@example.org")
        expect(section.get_by_role("button", name="Check Codex sign-in")).to_be_visible()
        section.get_by_role("button", name="Sign out of Codex").click()
        expect(section.get_by_role("status").filter(has_text="Signed out of Codex in Flux.")).to_be_visible()
        self.assertEqual(posted, [{"client": "codex"}], "the button signs out the currently selected client")
        expect(section.get_by_role("button", name="Remove shared runtime space from Flux…")).to_be_visible()
        section.get_by_role("button", name="Remove shared runtime space from Flux…").click()
        removal = page.get_by_role("group", name="Remove shared runtime space from Flux")
        expect(removal).to_contain_text("Flux tries to sign out of Claude Code and Codex")
        expect(removal).to_contain_text("deletes both clients’ files from your shared runtime space")
        expect(removal).not_to_contain_text("Claude Code signs out first")
        page.close()

        # Both clients offered: the mixed state is reported individually, while removal stays shared.
        page = self.page()
        mixed = self.runtime_snapshot()
        mixed.update(clients={"claude_code": "available", "codex": "available"}, commercialTerms=None)
        mixed["connections"]["codex"] = codex_connection("signed_out")
        page.route("**/api/v1/agent-runtime", lambda route: route.fulfill(
            status=200, headers={"cache-control": "no-store"}, content_type="application/json", body=json.dumps(mixed)))
        page.goto("/settings/agents")
        section = page.locator("section.rt")
        expect(section.get_by_role("heading", name="Claude Code and Codex in Flux · Claude Code signed in · Codex not signed in")).to_be_visible()
        expect(section.get_by_role("link", name="Sign in with ChatGPT")).to_be_visible()
        expect(section.get_by_role("button", name="Sign out of ChatGPT", exact=True)).to_have_count(0)
        mixed["connections"]["codex"] = codex_connection("signed_in")
        page.reload()
        expect(section.get_by_role("heading", name="Claude Code and Codex in Flux · Claude Code signed in · Codex signed in")).to_be_visible()
        expect(section.locator(".rt-codex")).to_contain_text("ChatGPT plan")
        expect(section.get_by_role("button", name="Sign out", exact=True)).to_be_visible()
        expect(section.get_by_role("button", name="Sign out of ChatGPT", exact=True)).to_be_visible()
        section.get_by_role("button", name="Remove shared runtime space from Flux…").click()
        removal = page.get_by_role("group", name="Remove shared runtime space from Flux")
        expect(removal).to_contain_text("Claude Code and Codex")
        page.close()

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
        page.goto("/settings/agents")
        section = page.locator("section.rt")
        expect(section.get_by_role("heading", name="Claude Code in Flux · signed in")).to_be_visible()
        deadline = time.time() + 10
        while not held and time.time() < deadline:
            page.wait_for_timeout(20)
        self.assertEqual(len(held), 1, "actual background GET reached the delivery barrier")
        if remove:
            section.get_by_role("button", name="Remove shared runtime space from Flux…").tap()
            page.get_by_role("group", name="Remove shared runtime space from Flux").get_by_role("button", name="Sign out and remove").tap()
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
        if not remove:
            expect(section.get_by_role("status").filter(has_text="Signed out of Claude Code in Flux.")).to_be_visible()
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
        page.goto("/settings/agents")
        section = page.locator("section.rt")
        expect(section).to_contain_text("Sign-out was not confirmed for at least one client")
        expect(section).not_to_contain_text("It signed out first")
        page.unroute("**/api/v1/agent-runtime")
        current = self.runtime_snapshot()
        page.route("**/api/v1/agent-runtime", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(current)))
        page.reload()
        page.route("**/api/v1/agent-runtime/binding", lambda route: route.fulfill(status=503, content_type="application/json", body='{"error":"unavailable"}'))
        section.get_by_role("button", name="Remove shared runtime space from Flux…").tap()
        page.get_by_role("group", name="Remove shared runtime space from Flux").get_by_role("button", name="Sign out and remove").tap()
        expect(section.get_by_role("alert")).to_contain_text("Removal could not be confirmed")
        expect(section).not_to_contain_text("Nothing changed")
        self.phone_layout(page, "section.rt")

    @unittest.skipIf(RUNTIME, "the operator switch is off only in the check_ui stack")
    def test_12_legacy_sign_in_route_is_lazy_and_off_server_refuses_the_start(self) -> None:
        """Real lazy assets/redirect and refusal; offered status is a fixture, never a native login."""
        for phone in (False, True):
            for theme in ("light", "dark"):
                with self.subTest(phone=phone, theme=theme):
                    page = self.page(phone=phone)
                    page.emulate_media(color_scheme=theme)
                    offered = self.runtime_snapshot()
                    offered["binding"] = None
                    offered["connections"]["claude_code"] = None
                    page.route("**/api/v1/agent-runtime", lambda route: route.fulfill(
                        status=200, content_type="application/json", body=json.dumps(offered)))
                    assets: list[str] = []
                    page.on("request", lambda request: assets.append(request.url) if "/assets/" in request.url else None)
                    page.goto("/settings/agents")
                    expect(page.get_by_role("heading", name="Agents and AI", exact=True)).to_be_visible()
                    self.assertFalse(any("ClaudeCodeSignIn-" in url or "SignInConsole-" in url for url in assets),
                                     "opening Settings does not import either sign-in route or terminal")
                    page.goto("/settings/assistant/claude-code")
                    expect(page).to_have_url(re.compile(r"/settings/agents/claude-code$"))
                    expect(page.get_by_role("button", name="Sign in with Claude", exact=True)).to_be_visible()
                    if not phone:
                        expect(page.get_by_role("heading", name="Sign in to Claude Code", exact=True)).to_be_visible()
                    self.assertTrue(any("ClaudeCodeSignIn-" in url for url in assets), "the destination imports its actual route")
                    self.assertFalse(any("SignInConsole-" in url for url in assets), "choosing a method does not import the terminal")
                    page.locator("details.rt-more summary").filter(has_text="Other ways to sign in").click()
                    for other in ("Anthropic Console", "Single sign-on"):
                        expect(page.get_by_role("button", name=re.compile(f"^{other}"))).to_be_visible()  # every supported method remains
                    if phone:
                        self.phone_layout(page, ".rt-page")
                    shot(page, f"runtime-composed-methods-{'phone-390' if phone else 'desktop-1440'}-{theme}-{UI_BROWSER}")
                    # Only the status read is substituted. The actual off server owns this attempted command.
                    with page.expect_response(lambda response: response.url.endswith("/api/v1/agent-runtime/console")) as reply:
                        page.get_by_role("button", name="Sign in with Claude", exact=True).click()
                    self.assertEqual(reply.value.status, 409, "the actual off server refuses admission")
                    self.assertEqual(reply.value.json()["code"], "AGENT_RUNTIME_OFF")
                    expect(page.get_by_role("alert")).to_have_text("The agent runtime is off on this instance")
                    self.assertEqual(page.locator(".rt-console").count(), 0, "a refused start cannot mount the terminal")
                    self.assertFalse(any("SignInConsole-" in url for url in assets), "a refused start cannot download the terminal")
                    page.close()


    def test_13_sign_out_receipts_are_visible_and_never_inferred_from_an_ack(self) -> None:
        """Actual mounted rendering of current saved facts; no native profile or vendor acceptance."""
        receipt = {"at": "2026-10-07T10:01:00.000Z", "failed": False}
        confirmed = self.runtime_snapshot()
        confirmed["connections"]["claude_code"].update(state="signed_out", signedInAt=None, signOut=receipt)
        cases = [("confirmed", confirmed, "Signed out of Claude Code in Flux.")]
        failed = copy.deepcopy(confirmed)
        failed["connections"]["claude_code"]["signOut"]["failed"] = True
        cases.append(("unconfirmed", failed, "Anthropic didn’t confirm the sign-out."))
        for name, completion in (("no-receipt", None), ("ack-only", {"kind": "logout", "disposition": "accepted"})):
            status = copy.deepcopy(confirmed)
            status["connections"]["claude_code"]["signOut"] = None
            if completion:
                status["authCompletion"] = completion
            cases.append((name, status, None))
        for name, change in (("missing-timestamp", {"at": None}), ("unknown-failed", {"failed": None})):
            status = copy.deepcopy(confirmed)
            status["connections"]["claude_code"]["signOut"].update(change)
            cases.append((name, status, None))
        pending = copy.deepcopy(confirmed)
        pending["auth"] = {"claude_code": "signing_out"}
        cases.append(("pending", pending, "Sign-out requested."))
        superseded = copy.deepcopy(confirmed)
        superseded["authCompletion"] = {"kind": "logout", "disposition": "superseded"}
        cases.append(("superseded", superseded, "This operation’s result was no longer current and was not accepted."))
        recovery = copy.deepcopy(confirmed)
        recovery["binding"].update(state="releasing", recovery=True)
        recovery["connections"]["claude_code"] = None
        cases.append(("recovery", recovery, "Recovering your shared runtime space after an unconfirmed operation."))
        for name, state in (("new-sign-in", "signed_in"), ("sign-in-again", "sign_in_again")):
            status = copy.deepcopy(confirmed)
            status["connections"]["claude_code"]["state"] = state
            cases.append((name, status, None))
        unbound = copy.deepcopy(confirmed)
        unbound["binding"] = None
        cases.append(("unbound-old-receipt", unbound, None))

        for phone in (False, True):
            for theme in ("light", "dark"):
                for name, current, text in cases:
                    with self.subTest(phone=phone, theme=theme, state=name):
                        page = self.page(phone=phone)
                        page.emulate_media(color_scheme=theme)
                        page.route("**/api/v1/agent-runtime", lambda route: route.fulfill(
                            status=200, content_type="application/json", body=json.dumps(current)))
                        page.goto("/settings/agents")
                        section = page.locator("section.rt")
                        heading = section.locator("h3#rt-h")
                        expect(heading).to_contain_text("Claude Code in Flux ·")
                        if name in ("confirmed", "unconfirmed", "pending", "superseded", "recovery"):
                            shot(page, f"runtime-outcome-{name}-{'phone-390' if phone else 'desktop-1440'}-{theme}-{UI_BROWSER}")
                        if name == "confirmed":
                            self.assertEqual(section.get_by_text("Signed out of Claude Code in Flux.", exact=True).count(), 1,
                                             "a saved current sign-out receipt gets visible confirmation")
                            outcome = section.get_by_role("status").filter(has_text=text)
                            expect(outcome.locator("time")).to_have_attribute("datetime", receipt["at"])
                        else:
                            self.assertEqual(section.get_by_text("Signed out of Claude Code in Flux.", exact=True).count(), 0,
                                             "missing, older, pending, superseded or recovery facts confer no success")
                            outcome = section.locator("p").filter(has_text=text) if text else None
                        if outcome:
                            expect(outcome).to_be_visible()
                            geometry = outcome.evaluate("""node => {
                              const heading = node.closest('section.rt').querySelector('#rt-h').getBoundingClientRect();
                              const result = node.getBoundingClientRect();
                              const following = node.closest('section.rt').querySelector('.rt-choices, .rt-sub');
                              return {heading:heading.bottom, top:result.top, bottom:result.bottom,
                                following:following?.getBoundingClientRect().top ?? innerHeight, height:innerHeight};
                            }""")
                            self.assertGreaterEqual(geometry["top"], geometry["heading"] - 1)
                            self.assertLessEqual(geometry["top"] - geometry["heading"], 24, "outcome sits with the state")
                            self.assertLessEqual(geometry["bottom"], geometry["following"] + 1, "outcome precedes generic choices/disclosure")
                            self.assertLessEqual(geometry["bottom"], geometry["height"], "outcome is readable in the captured viewport")
                        if name == "confirmed":
                            # A new action owns the view even while the old saved receipt remains in GET.
                            held_action: list[Route] = []
                            page.route("**/api/v1/agent-runtime/binding", lambda route: held_action.append(route)
                                       if route.request.method == "DELETE" else route.continue_())
                            section.get_by_role("button", name="Remove shared runtime space from Flux…").click()
                            page.get_by_role("group", name="Remove shared runtime space from Flux").get_by_role("button", name="Sign out and remove").click()
                            deadline = time.time() + 5
                            while not held_action and time.time() < deadline:
                                page.wait_for_timeout(20)
                            self.assertEqual(len(held_action), 1, "the actual next DELETE is held before its answer")
                            expect(section.get_by_text("Signed out of Claude Code in Flux.", exact=True)).to_have_count(0)
                            held_action[0].fulfill(status=503, content_type="application/json", body='{"error":"unavailable"}')
                            uncertain = section.get_by_role("alert")
                            expect(uncertain).to_contain_text("Removal could not be confirmed")
                            expect(section.get_by_text("Signed out of Claude Code in Flux.", exact=True)).to_have_count(0)
                            order = uncertain.evaluate("""node => ({top:node.getBoundingClientRect().top,
                              heading:node.closest('section.rt').querySelector('#rt-h').getBoundingClientRect().bottom,
                              choices:node.closest('section.rt').querySelector('.rt-choices').getBoundingClientRect().top})""")
                            self.assertLessEqual(order["top"] - order["heading"], 24)
                            self.assertLess(order["top"], order["choices"], "unconfirmed action stays beside its current state")
                            shot(page, f"runtime-outcome-uncertain-action-{'phone-390' if phone else 'desktop-1440'}-{theme}-{UI_BROWSER}")
                        page.close()


    @unittest.skipIf(RUNTIME, "the operator switch is off only in the check_ui stack")
    def test_14_uncertain_removal_is_clear_at_the_actual_action_position(self) -> None:
        """No post-result scrolling: current action feedback and saved-value qualifier remain truthful."""
        for phone in (False, True):
            for theme in ("light", "dark"):
                for response_kind, response_status, response_body, message in (
                    ("unknown", 503, {"error": "unavailable"}, "Removal could not be confirmed. Check the current state before trying again."),
                    ("off", 409, None, "The shared runtime space was not removed. Sign-in is turned off on this server. Ask the person who runs this server to turn it on, then try again."),
                    # The current DELETE route never emits AUTH_BUSY. An unsupported response cannot
                    # prove refusal/no deletion; keep this explicit synthetic compatibility control.
                    ("synthetic-busy", 409, {"error": "Another auth operation is still using your runtime", "code": "AGENT_RUNTIME_AUTH_BUSY"},
                     "Removal could not be confirmed. Check the current state before trying again."),
                ):
                    with self.subTest(phone=phone, theme=theme, response=response_kind):
                        page = self.page(phone=phone)
                        page.emulate_media(color_scheme=theme)
                        actual_status = page.request.get(f"{ORIGIN}/api/v1/agent-runtime")
                        self.assertEqual(actual_status.status, 200)
                        self.assertFalse(actual_status.json()["enabled"], "this real server's operator switch is off")
                        current = self.runtime_snapshot()
                        current["connections"]["claude_code"].update(state="signed_out", signedInAt=None,
                            signOut={"at": "2026-10-07T10:01:00.000Z", "failed": False})
                        page.route("**/api/v1/agent-runtime", lambda route: route.fulfill(
                            status=200, content_type="application/json", body=json.dumps(current)))
                        held: list[Route] = []
                        if response_kind != "off":
                            page.route("**/api/v1/agent-runtime/binding", lambda route: held.append(route)
                                       if route.request.method == "DELETE" else route.continue_())
                        page.goto("/settings/agents")
                        section = page.locator("section.rt")
                        expect(section.get_by_role("heading", name="Claude Code in Flux · not signed in")).to_be_visible()
                        section.get_by_role("button", name="Remove shared runtime space from Flux…").click()
                        group = page.get_by_role("group", name="Remove shared runtime space from Flux")
                        submit = group.get_by_role("button", name="Sign out and remove")
                        if response_kind == "off":
                            with page.expect_response(lambda response: response.request.method == "DELETE"
                                                      and response.url.endswith("/api/v1/agent-runtime/binding")) as removal:
                                submit.click()
                            self.assertEqual(removal.value.status, response_status)
                            self.assertEqual(removal.value.json()["code"], "AGENT_RUNTIME_OFF",
                                             "the actual DELETE transport reached the pre-release server guard")
                        else:
                            submit.click()
                            deadline = time.time() + 5
                            while not held and time.time() < deadline:
                                page.wait_for_timeout(20)
                            self.assertEqual(len(held), 1, "the synthetic removal response reached its barrier")
                            held[0].fulfill(status=response_status, content_type="application/json", body=json.dumps(response_body))
                        expect(section.get_by_role("alert")).to_be_visible()
                        expect(submit).to_be_enabled()
                        expect(section.get_by_text("Signed out of Claude Code in Flux.", exact=True)).to_have_count(0)
                        # Preserve the natural post-click viewport: do not scroll to the header or alter focus.
                        shot(page, f"runtime-removal-working-{response_kind}-{'phone-390' if phone else 'desktop-1440'}-{theme}-{UI_BROWSER}")
                        with self.subTest(check="plain-current-result"):
                            self.assertEqual(section.get_by_role("alert").inner_text(), message)
                        with self.subTest(check="last-reported-value"):
                            if response_kind != "off":
                                self.assertIn("last reported:", section.locator("#rt-h").inner_text(),
                                              "the strongest label qualifies the value carried through an unknown action")
                            else:
                                self.assertNotIn("last reported:", section.locator("#rt-h").inner_text(),
                                                 "a settled typed refusal does not invent uncertainty")
                        with self.subTest(check="result-at-controls"):
                            nearby = group.locator("p").filter(has_text=message)
                            self.assertEqual(nearby.count(), 1, "the actual working position contains the current uncertain result")
                            expect(nearby).to_be_visible()
                            expect(nearby).to_have_attribute("aria-hidden", "true")
                            expect(submit).to_have_attribute("aria-describedby", "rt-error")
                            expect(group.get_by_role("button", name="Cancel")).to_have_attribute("aria-describedby", "rt-error")
                            self.assertEqual(section.get_by_role("alert").count(), 1, "one automatic result announcement")
                            geometry = nearby.evaluate("""node => {
                              const group=node.closest('.details__confirm'), result=node.getBoundingClientRect();
                              const buttons=[...group.querySelectorAll('button')].map(el=>el.getBoundingClientRect());
                              const nav=document.querySelector('nav[aria-label="Main places"]')?.getBoundingClientRect();
                              const header=document.querySelector('.top')?.getBoundingClientRect();
                              return {top:result.top,bottom:result.bottom,buttons:buttons.map(r=>({top:r.top,bottom:r.bottom})),
                                safeTop:header?.height ? header.bottom : 0,safeBottom:nav?.height ? nav.top : innerHeight};
                            }""")
                            self.assertGreaterEqual(geometry["top"], geometry["safeTop"] - 1)
                            self.assertLessEqual(geometry["bottom"], min(b["top"] for b in geometry["buttons"]) + 1,
                                                 "full uncertainty text sits next to the removal controls")
                            self.assertLessEqual(max(b["bottom"] for b in geometry["buttons"]), geometry["safeBottom"] + 1,
                                                 "both retry and cancel remain visible above the actual footer")
                        page.close()


if __name__ == "__main__":
    unittest.main()
