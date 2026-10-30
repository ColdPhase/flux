"""A page being left starts no request, and real failures stay visible (#471).

In WebKit a fetch that starts after the browser has begun a navigation (from `beforeunload` on) is
logged as "Fetch API cannot load ... due to access control checks", and Playwright raises that as an
uncaught page error even though the app handles the rejection. A request that was already running is
only cancelled and reports nothing. The web API client therefore holds back every request that is not
`keepalive` while the page is being left (api/pageLeaving.ts) and starts it when the page is live again.

Runs in the engine FLUX_UI_BROWSER names (chromium by default, webkit for the lane that matters).
1. While the page is left, window events that make the app read again (focus, online) start no request,
   and the old page reports no page error.
2. Negative control: a request started by the page's own code in the same window is reported by WebKit
   as a page error, so the guard that fails the journeys still sees this class of error.
3. A real failure of a read is not swallowed: the person is told and can try again.
4. A read asked for just before the navigation begins is held too (#758, #759): a read starts in a task of its own, and the
   navigation can begin in the task between; it starts when the page is live again, and is not dropped.
"""

from __future__ import annotations

import json
import os
import re
import time
import unittest

from playwright.sync_api import Browser, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, UPSTREAM, open_details, start_forwarder

UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
if UI_BROWSER not in ("chromium", "webkit"):
    raise ValueError(f"FLUX_UI_BROWSER must be chromium or webkit, got {UI_BROWSER!r}")

PASSWORD = "leave a page quietly"

# Installed in the page that will be left. From `beforeunload` it makes the app read again by the events
# that make it read (`focus`, `online`), every millisecond for a while, as a window that stays open until the
# new document replaces it. `through_app` False starts one request from the page's own code instead.
LEAVE_HOOK = """({ throughApp }) => {
  let leftAt = 0;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    // Only inside the page's own grace (1 s) after the leave began: later, a live page may read again.
    if (leftAt && Date.now() - leftAt < 700 && url.includes('/api/')) {
      const seen = JSON.parse(sessionStorage.getItem('fetched-while-left') || '[]');
      seen.push(url);
      sessionStorage.setItem('fetched-while-left', JSON.stringify(seen));
    }
    return nativeFetch(input, init);
  };
  addEventListener('beforeunload', () => {
    leftAt = Date.now();
    let rounds = 0;
    const pump = () => {
      if (throughApp) { dispatchEvent(new Event('focus')); dispatchEvent(new Event('online')); } else fetch('/api/v1/me', { cache: 'no-store' }).catch(() => undefined);
      if (++rounds < 30) setTimeout(pump, 1);
    };
    pump();
  });
}"""


# Installed in a page that stays: the app asks for its reads (`focus`, `online`), then the navigation begins (`beforeunload`) before
# the task each read starts in has run. A request that starts after that is the race of #758 and #759, which WebKit reports as a
# page error when the page is really left. Resolves with what started while the page was left, and what started altogether.
ASKED_BEFORE_LEAVING = """() => {
  const nativeFetch = window.fetch.bind(window);
  const started = [];
  let left = false;
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/')) started.push({ url, left });
    return nativeFetch(input, init);
  };
  dispatchEvent(new Event('focus'));
  dispatchEvent(new Event('online'));
  left = true;
  dispatchEvent(new Event('beforeunload'));
  window.__started = started;
  return new Promise((resolve) => setTimeout(() => resolve(started.map((entry) => ({ ...entry }))), 300));
}"""


class PageLeaving(unittest.TestCase):
    pw = None
    browser: Browser
    state: dict = {}
    workspace = ""
    email = ""

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=10000)
        cls.email = f"ola.leaving+{int(time.time() * 1000)}@example.test"
        context = cls.browser.new_context(base_url=ORIGIN, service_workers="block")
        response = context.request.post("/api/auth/sign-up/email", data={"email": cls.email, "password": PASSWORD, "name": "Ola Wren"}, headers={"origin": ORIGIN})
        assert response.status == 200, response.text()
        cls.state = context.storage_state()
        created = context.request.post("/api/v1/workspaces", data={"name": "Quiet Harbour"}, headers={"origin": ORIGIN})
        assert created.status == 201, created.text()
        cls.workspace = created.json()["id"]
        context.close()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, *, guard: bool = True) -> tuple[Page, list[str]]:
        context = self.browser.new_context(base_url=ORIGIN, viewport=DESKTOP, color_scheme="light", locale="en-GB", storage_state=self.state, service_workers="block")
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        if guard:
            self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page, errors

    def home(self) -> tuple[Page, list[str]]:
        page, errors = self.page(guard=False)
        page.goto("/")
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        return page, errors

    def test_1_no_request_starts_while_the_page_is_left(self) -> None:
        page, errors = self.home()
        page.evaluate(LEAVE_HOOK, {"throughApp": True})
        page.goto("/inbox")
        expect(page.get_by_role("heading", level=1, name="Inbox")).to_be_visible()
        fetched = json.loads(page.evaluate("sessionStorage.getItem('fetched-while-left') || '[]'"))
        self.assertEqual(fetched, [], "the app started no request after the browser began leaving the page")
        self.assertEqual(errors, [], "no uncaught page errors")

    def test_2_negative_control_a_request_started_by_the_page_itself_is_still_a_page_error_in_webkit(self) -> None:
        page, errors = self.home()
        page.evaluate(LEAVE_HOOK, {"throughApp": False})
        if UI_BROWSER == "webkit":
            with page.expect_event("pageerror", timeout=10000):
                page.goto("/inbox")
            expect(page.get_by_role("heading", level=1, name="Inbox")).to_be_visible()
            self.assertTrue(any(re.search(r"/api/v1/me.* due to access control checks\.$", message) for message in errors), errors)
        else:
            page.goto("/inbox")
            expect(page.get_by_role("heading", level=1, name="Inbox")).to_be_visible()
            self.assertEqual(errors, [], "Chromium reports a request started while leaving nowhere")
        fetched = json.loads(page.evaluate("sessionStorage.getItem('fetched-while-left') || '[]'"))
        self.assertTrue(fetched, "the page's own code did start requests, so the control is live")

    def test_3_a_real_failure_of_a_read_is_shown_and_can_be_tried_again(self) -> None:
        page, errors = self.page()
        failures = {"left": 1}

        def members(route) -> None:
            if failures["left"]:
                failures["left"] -= 1
                route.abort("failed")
            else:
                route.continue_()

        page.route(re.compile(rf"/api/v1/workspaces/{self.workspace}/members$"), members)
        page.goto("/")
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        open_details(page)
        page.get_by_role("region", name="People").get_by_role("button", name=re.compile("^Quiet Harbour")).click()
        alert = page.get_by_role("alert").filter(has_text="The people here couldn’t be loaded. Try again.")
        expect(alert).to_be_visible()
        self.assertEqual(failures["left"], 0, "the read really failed")
        alert.get_by_role("button", name="Try again").click()
        expect(page.get_by_role("list", name="People in Quiet Harbour").get_by_role("listitem")).to_have_count(1)
        expect(alert).to_have_count(0)
        self.assertEqual(errors, [], "no uncaught page errors")

    def test_4_a_read_asked_for_just_before_the_page_is_left_waits_too(self) -> None:
        page, errors = self.home()
        page.wait_for_load_state("networkidle")
        during = page.evaluate(ASKED_BEFORE_LEAVING)
        self.assertEqual([entry for entry in during if entry["left"]], [], f"a read asked for before the navigation began did not start after it: {during}")
        # Held back, not dropped: the person is still here (a click), so the reads start.
        page.mouse.click(5, 5)
        page.wait_for_function("() => window.__started.some((entry) => entry.left)")
        self.assertEqual(errors, [], "no uncaught page errors")


if __name__ == "__main__":
    unittest.main()
