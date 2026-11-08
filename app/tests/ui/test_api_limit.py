"""Two people at one address use the app with the API-wide request limit ON (issue #838, review of #1008).

The limit once looked for a cookie Flux does not set, so every browser request counted as anonymous: 240 a minute per address.
Two people in one office got 429 within 30 seconds and the page turned into "Something went wrong". Here Ada and Jonas open the
app's pages in turn from the one loopback address until the two of them have made more API requests than the anonymous budget
allows, and nothing is refused or turns into an error page. The stack has the limits off in the other modules (the journeys sign in
many times from one address), so this one runs with
    FLUX_UI_RATE_LIMIT=true ./scripts/check_ui.sh test_api_limit
and is skipped otherwise.
"""

from __future__ import annotations

import os
import re
import time
import unittest

from playwright.sync_api import expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, SHOTS, UI_BROWSER, UPSTREAM, start_forwarder

PASSWORD = "two people one address"
STAMP = int(time.time() * 1000)
PAGES = ("/", "/inbox", "/tasks", "/settings", "/projects", "/settings/account")
ANONYMOUS_BUDGET = 600  # apps/server/src/http/rate-limit.ts, per address without a credential
ON = os.environ.get("FLUX_UI_RATE_LIMIT") == "true"


@unittest.skipUnless(ON, "needs the API limit on: FLUX_UI_RATE_LIMIT=true ./scripts/check_ui.sh test_api_limit")
class ApiLimit(unittest.TestCase):
    pw = None
    browser = None

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

    def person(self, label: str):
        context = self.browser.new_context(base_url=ORIGIN, viewport=DESKTOP, locale="en-GB", service_workers="block")
        self.addCleanup(context.close)
        made = context.request.fetch(f"{ORIGIN}/api/auth/sign-up/email", method="POST", headers={"origin": ORIGIN},
                                     data={"name": f"Limit {label}", "email": f"limit.{label}+{STAMP}@example.test", "password": PASSWORD})
        self.assertLess(made.status, 300, made.text())
        page = context.new_page()
        seen = {"api": 0, "refused": []}
        page.on("request", lambda r: seen.__setitem__("api", seen["api"] + 1) if re.match(rf"^{re.escape(ORIGIN)}/(api|mcp)/", r.url) else None)
        page.on("response", lambda r: seen["refused"].append(f"{r.status} {r.request.method} {r.url}") if r.status == 429 else None)
        return page, seen

    def test_01_two_people_at_one_address_are_not_one_anonymous_crowd(self) -> None:
        people = [self.person("ada"), self.person("jonas")]
        for page, _ in people:
            page.goto("/")
            expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        turns = 0
        while sum(seen["api"] for _, seen in people) < ANONYMOUS_BUDGET + 200 and turns < 200:
            for page, _ in people:
                page.goto(PAGES[turns % len(PAGES)])
                expect(page.get_by_role("heading", level=1).first).to_be_visible()
                page.wait_for_load_state("networkidle")
                page.keyboard.press("Control+k")
                page.keyboard.type("a")
                page.keyboard.press("Escape")
                self.assertEqual(page.get_by_text("Something went wrong").count(), 0, f"the error page after {turns} turns")
            turns += 1
        total = sum(seen["api"] for _, seen in people)
        self.assertGreater(total, ANONYMOUS_BUDGET, "the two of them made more requests than one anonymous address may")
        for _, seen in people:
            self.assertEqual(seen["refused"], [])
            self.assertLess(seen["api"], 1200, "each stays within a session's own budget")


class BusyNotice(unittest.TestCase):
    """The API answers one read with 429 and Retry-After: the page says Flux is busy, waits, asks again and opens the place (no limit needed)."""

    def test_01_a_read_that_gets_429_waits_with_a_calm_line_and_then_opens(self) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        with sync_playwright() as pw:
            browser = getattr(pw, UI_BROWSER).launch()
            for label, viewport in (("computer", DESKTOP), ("phone", PHONE)):
                phone = viewport == PHONE
                context = browser.new_context(base_url=ORIGIN, viewport=viewport, locale="en-GB", service_workers="block", has_touch=phone, is_mobile=phone)
                made = context.request.fetch(f"{ORIGIN}/api/auth/sign-up/email", method="POST", headers={"origin": ORIGIN},
                                             data={"name": "Busy Bea", "email": f"busy.bea.{label}+{STAMP}@example.test", "password": PASSWORD})
                self.assertLess(made.status, 300, made.text())
                page = context.new_page()
                expect.set_options(timeout=15000)
                page.goto("/")
                expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
                answered = []

                def busy_once(route) -> None:
                    if answered:
                        route.continue_()
                        return
                    answered.append(route.request.url)
                    route.fulfill(status=429, headers={"retry-after": "3", "content-type": "application/json"},
                                  body='{"error":"Too many requests. Try again shortly.","code":"RATE_LIMITED"}')

                page.route(re.compile(r"/api/v1/inbox(\?|$)"), busy_once)
                page.get_by_role("link", name=re.compile("^Inbox")).first.click()
                notice = page.locator("[data-busy-notice]")
                expect(notice).to_be_visible()
                expect(notice).to_contain_text("Flux is busy. Trying again in")
                self.assertEqual(page.get_by_text("Something went wrong").count(), 0)
                box = notice.bounding_box()
                self.assertLessEqual(box["x"] + box["width"], viewport["width"] + 1, f"{label}: the line fits the window")
                self.assertGreaterEqual(box["x"], 0)
                if SHOTS:
                    page.screenshot(path=str(SHOTS / f"busy-notice-{label}.png"))
                expect(page.get_by_role("heading", level=1, name="Inbox")).to_be_visible(timeout=20000)
                expect(notice).to_have_count(0)
                self.assertEqual(len(answered), 1, f"{label}: the read was refused once and asked again")
                context.close()
            browser.close()


if __name__ == "__main__":
    unittest.main()
