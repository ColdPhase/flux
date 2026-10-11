"""#340 / #357: real own-assistant runs, ordered sidebar truth and rail Stop.

The Compose worker uses the existing TEST ONLY Anthropic adapter fixture. No provider,
billing or external-agent acceptance is claimed. The public fetch probe only delays actual
HTTP responses (including genuine pre-Stop snapshots); it preserves AbortSignal semantics,
never fabricates successful data, and records superseded delivery separately from success.
"""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, Page, Route, expect, sync_playwright

from test_app_shell import ORIGIN, UPSTREAM, shot, start_forwarder
from test_personal_assistant import mock
from touch_targets import has_minimum_touch_size

PASSWORD = "one real assistant in the sidebar"
WORKING = {"queued", "reading", "dispatching"}

# Public network instrumentation, following the shell's real-answer sign-out fixture.
# No React internals, private browser APIs, fake response bodies or ignored handler errors.
WIRE = r"""(() => {
  const fetch = window.fetch.bind(window), armed = [], gates = {}, history = [];
  let watching = false;
  const probe = window.__workingWire = {
    history, gates, breaches: [],
    arm(name, kind = 'list') { armed.push({name, kind}); gates[name] = {held: false, settled: false}; },
    release(name, reject = false) { const gate = gates[name]; gate.reject = reject; gate.open?.(); },
    watchIdle() { watching = true; probe.breaches = []; },
  };
  new MutationObserver(() => {
    if (watching && document.querySelector('.agentlive')) probe.breaches.push('working card returned');
  }).observe(document, {childList: true, subtree: true, attributes: true});
  window.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    const method = String(init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const kind = method === 'GET' && url.pathname === '/api/v1/assistant-runs' ? 'list'
      : method === 'POST' && /^\/api\/v1\/assistant-runs\/[^/]+\/stop$/.test(url.pathname) ? 'stop' : null;
    if (!kind) return fetch(input, init);
    let gate = null;
    const record = {kind, status: null, items: [], settled: false, delivery: null};
    history.push(record);
    try {
      const response = await fetch(input, init);
      const body = await response.clone().json();
      record.status = response.status;
      record.items = (kind === 'list' ? body.items ?? [] : [body]).map(item =>
        ({id: item.id, status: item.status, stopRequested: item.stopRequested}));
      // An aborted request has no answer to hold. Claim only an actual completed response,
      // so stream/focus supersession cannot consume the next genuine-answer barrier.
      const signal = init.signal ?? (input instanceof Request ? input.signal : null);
      const index = signal?.aborted ? -1 : armed.findIndex(item => item.kind === kind);
      gate = index < 0 ? null : gates[armed.splice(index, 1)[0].name];
      if (gate) {
        gate.held = true; gate.record = record;
        await new Promise((resolve, reject) => {
          let settled = false;
          const finish = (callback) => {
            if (settled) return; settled = true;
            signal?.removeEventListener('abort', abort); callback();
          };
          const abort = () => finish(() => reject(signal.reason ?? new DOMException('Aborted', 'AbortError')));
          gate.open = () => finish(() => gate.reject ? reject(new TypeError('TEST ONLY response delivery failed')) : resolve());
          if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, {once: true});
        });
      }
      record.delivery = 'delivered';
      return response;
    } catch (cause) {
      record.delivery = cause instanceof DOMException && cause.name === 'AbortError' ? 'aborted' : 'failed';
      throw cause;
    } finally {
      record.settled = true;
      if (gate) gate.settled = true;
    }
  };
})();"""


class WorkingAgentJourney(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browsers: dict[str, Browser] = {name: getattr(cls.pw, name).launch() for name in ("chromium", "webkit")}
        expect.set_options(timeout=12000)

    @classmethod
    def tearDownClass(cls) -> None:
        for browser in cls.browsers.values():
            browser.close()
        cls.pw.stop()

    def api(self, page: Page, method: str, path: str, body: dict | None = None, status: int = 200):
        response = page.request.fetch(path, method=method, headers={"origin": ORIGIN}, data=body)
        self.assertEqual(response.status, status, f"{path}: {response.status} {response.text()}")
        return response.json() if response.text() else None

    def person(self, engine: str, *, width: int = 1440, dark: bool = False, touch: bool = False, enabled: bool = True):
        context = self.browsers[engine].new_context(base_url=ORIGIN, viewport={"width": width, "height": 900 if width == 1440 else 800},
            color_scheme="dark" if dark else "light", service_workers="block", has_touch=touch)
        self.addCleanup(context.close)
        context.add_init_script(WIRE)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught product page errors"))
        email = f"ada.shellrun+{uuid.uuid4().hex}@example.test"
        self.api(page, "POST", "/api/auth/sign-up/email", {"name": "Ada Kowalska", "email": email, "password": PASSWORD})
        me = self.api(page, "GET", "/api/v1/me")
        if not enabled:
            return page, {"email": email, "user": me["user"]["id"]}
        ws = self.api(page, "POST", "/api/v1/workspaces", {"name": "Riverside garden"}, 201)
        project = self.api(page, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Garden sensor trial", "visibility": "restricted"}, 201)
        agent = self.api(page, "POST", f"/api/v1/workspaces/{ws['id']}/agents", {"name": "Garden analyst", "owner": "self"}, 201)
        self.api(page, "POST", f"/api/v1/projects/{project['id']}/grants", {"principal": {"kind": "agent", "id": agent["id"]}, "role": "viewer"}, 201)
        self.api(page, "POST", "/api/v1/personal-assistant", {"consentVersion": "o-008-2026-10-02", "agentId": agent["id"],
            "perRunCents": 6, "dailyCapCents": 100, "timeZone": "Europe/Warsaw"}, 201)
        conversation = self.api(page, "POST", f"/api/v1/projects/{project['id']}/conversations", {
            "body": "Which soil sensor should we test in the east garden bed?", "clientMessageId": str(uuid.uuid4())}, 201)
        self.api(page, "POST", f"/api/v1/conversations/{conversation['id']}/messages", {
            "body": "The east bed dried out after two. Compare the shaded and sunny readings.", "clientMessageId": str(uuid.uuid4())}, 201)
        page.goto("/")
        expect(page.get_by_role("heading", name="Home", exact=True)).to_be_visible()
        expect(page.locator(".agentlive")).to_have_count(0)
        return page, {"email": email, "user": me["user"]["id"], "workspace": ws["id"], "project": project["id"], "conversation": conversation["id"]}

    def start(self, page: Page, ids: dict, delay: float = 15) -> dict:
        mock("/__script", {"reset": True, "delay": delay})
        run = self.api(page, "POST", f"/api/v1/conversations/{ids['conversation']}/assistant-runs", {
            "clientRunId": str(uuid.uuid4()), "kind": "ask", "prompt": "Compare the garden readings before tomorrow's sensor test."}, 202)
        def cleanup_run() -> None:
            # The live document may have signed out or switched accounts. Cleanup uses its own
            # genuine session of the original owner, never the new viewer's request context.
            request = self.pw.request.new_context(base_url=ORIGIN)
            try:
                signed = request.post("/api/auth/sign-in/email", data={"email": ids["email"], "password": PASSWORD}, headers={"origin": ORIGIN})
                self.assertEqual(signed.status, 200)
                ended = request.post(f"/api/v1/assistant-runs/{run['id']}/stop", headers={"origin": ORIGIN})
                self.assertEqual(ended.status, 200)
            finally:
                request.dispose()
        self.addCleanup(cleanup_run)
        page.evaluate("window.dispatchEvent(new Event('focus'))")
        expect(page.locator(".agentlive")).to_be_visible()
        self.wait_run(page, run["id"], lambda current: current["status"] == "dispatching")
        return run

    def wait_run(self, page: Page, run_id: str, predicate, timeout: float = 20) -> dict:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            run = self.api(page, "GET", f"/api/v1/assistant-runs/{run_id}")
            if predicate(run):
                return run
            page.wait_for_timeout(50)
        self.fail(f"run did not reach the expected actual API state: {run['status']}")

    def hold_list(self, page: Page, name: str) -> None:
        before = page.evaluate("name => { const before = window.__workingWire.history.length; window.__workingWire.arm(name); window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('focus')); return before; }", name)
        page.wait_for_function("name => window.__workingWire.gates[name]?.held", arg=name)
        self.assertTrue(page.evaluate("before => window.__workingWire.history.slice(before).some(record => record.kind === 'list' && record.delivery === 'aborted')", before),
                        "the first genuine read was superseded before the held answer")
        held = page.evaluate("name => window.__workingWire.gates[name].record", name)
        self.assertEqual(held["status"], 200)
        self.assertTrue(any(item["status"] in WORKING and not item["stopRequested"] for item in held["items"]),
                        "the held answer is the real authorized pre-Stop working snapshot")

    def release(self, page: Page, name: str, *, reject: bool = False) -> None:
        page.evaluate("({name, reject}) => window.__workingWire.release(name, reject)", {"name": name, "reject": reject})
        page.wait_for_function("name => window.__workingWire.gates[name]?.settled", arg=name)
        page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")

    def stopped(self, page: Page, run: dict) -> None:
        stored = self.wait_run(page, run["id"], lambda current: current["status"] == "stopped")
        self.assertIsNone(stored["answer"], "Stop committed no assistant answer")
        expect(page.locator(".agentlive")).to_have_count(0, timeout=20000)
        page.wait_for_function("id => window.__workingWire.history.some(r => r.kind === 'list' && r.status === 200 && r.delivery === 'delivered' && r.items.every(item => item.id !== id || !['queued','reading','dispatching'].includes(item.status)))", arg=run["id"])

    def test_01_old_real_working_answer_cannot_return_after_card_stop(self) -> None:
        for engine in self.browsers:
            with self.subTest(engine=engine):
                page, ids = self.person(engine)
                run = self.start(page, ids)
                self.hold_list(page, "old-working")
                try:
                    button = page.locator(".agentlive").get_by_role("button", name="Stop your assistant")
                    button.focus(); expect(button).to_be_focused()
                    with page.expect_response(lambda r: r.request.method == "POST" and r.url.endswith(f"/{run['id']}/stop")) as answer:
                        button.press("Enter")
                    self.assertEqual(answer.value.status, 200)
                    self.stopped(page, run)
                    page.evaluate("window.__workingWire.watchIdle()")
                finally:
                    self.release(page, "old-working")
                expect(page.locator(".agentlive")).to_have_count(0)
                self.assertEqual(page.evaluate("window.__workingWire.breaches"), [], "no even transient false working card")

    def test_02_the_rail_has_native_keyboard_stop_and_preserves_width(self) -> None:
        for engine in self.browsers:
            for width, dark, touch in ((1440, False, False), (1440, True, False), (1280, False, False), (1280, True, False), (1280, False, True)):
                with self.subTest(engine=engine, width=width, dark=dark, touch=touch):
                    page, ids = self.person(engine, width=width, dark=dark, touch=touch)
                    run = self.start(page, ids)
                    expect(page.locator(".agentlive__text")).to_contain_text("writing an answer")
                    shot(page, f"340-working-expanded-{engine}-{width}-{'dark' if dark else 'light'}{'-coarse' if touch else ''}")
                    page.keyboard.press("[")
                    rail = page.locator(".side--rail")
                    expect(rail).to_be_visible()
                    side = page.get_by_role("complementary", name="Sidebar")
                    self.assertAlmostEqual(side.bounding_box()["width"], 64, delta=.001)
                    card = rail.locator(".agentlive")
                    link = card.get_by_role("link")
                    expect(link).to_have_attribute("href", f"/projects/{ids['project']}/conversations/{ids['conversation']}")
                    stop = card.get_by_role("button", name="Stop your assistant")
                    self.assertEqual(stop.evaluate("el => el.tagName"), "BUTTON")
                    self.assertEqual(stop.evaluate("el => el.closest('a')"), None, "Stop is separate from navigation")
                    link.focus(); page.keyboard.press("Tab"); expect(stop).to_be_focused()
                    focus = stop.evaluate("el => ({visible: el.matches(':focus-visible'), width: parseFloat(getComputedStyle(el).outlineWidth), style: getComputedStyle(el).outlineStyle})")
                    self.assertTrue(focus["visible"] and focus["width"] >= 2 and focus["style"] == "solid", "the real keyboard Stop has visible focus")
                    if dark:
                        page.emulate_media(reduced_motion="reduce")
                        self.assertTrue(card.locator(".kreska__brow").evaluate("el => getComputedStyle(el).animationName === 'none'"))
                    if touch:
                        bounds = stop.bounding_box()
                        self.assertTrue(has_minimum_touch_size(bounds["width"]) and has_minimum_touch_size(bounds["height"]))
                    self.assertEqual(page.evaluate("document.documentElement.scrollWidth - innerWidth"), 0)
                    shot(page, f"340-working-rail-{engine}-{width}-{'dark' if dark else 'light'}{'-coarse' if touch else ''}")
                    stop.press("Space")
                    self.stopped(page, run)

    def test_03_failed_stop_says_so_and_retry_uses_the_real_api(self) -> None:
        for engine in self.browsers:
            for compact in (False, True):
                with self.subTest(engine=engine, compact=compact):
                    page, ids = self.person(engine, width=1280 if compact else 1440, dark=compact)
                    run = self.start(page, ids)
                    if compact:
                        page.keyboard.press("[")
                        expect(page.locator(".side--rail")).to_be_visible()
                    attempts = []
                    def refuse_once(route: Route) -> None:
                        attempts.append(route.request.url)
                        if len(attempts) == 1:
                            route.fulfill(status=503, content_type="application/json", body='{"code":"TEMPORARY_UNAVAILABLE"}')
                        else:
                            route.continue_()
                    page.route(f"**/api/v1/assistant-runs/{run['id']}/stop", refuse_once)
                    card = page.locator(".agentlive")
                    card.get_by_role("button", name="Stop your assistant").click()
                    error = page.locator(".agentlive__notice") if compact else card.get_by_role("alert")
                    expect(error).to_contain_text("Couldn’t stop your assistant. Try again.")
                    self.assertFalse(self.api(page, "GET", f"/api/v1/assistant-runs/{run['id']}")["stopRequested"],
                                     "the network refusal is not a successful Stop")
                    expect(card.get_by_role("button", name="Stop your assistant")).to_be_enabled()
                    if compact:
                        for scale in (100, 200):
                            page.evaluate("scale => document.documentElement.style.fontSize = scale + '%'", scale)
                            self.assertTrue(error.locator(".ui-toast__msg").evaluate(r"""el => {
                                const r=el.getBoundingClientRect(), node=el.firstChild;
                                const words=[...node.textContent.matchAll(/\S+/g)];
                                return r.left>=0 && r.top>=0 && r.right<=innerWidth && r.bottom<=innerHeight
                                  && el.scrollWidth<=el.clientWidth+.001 && words.length===6 && words.every(word => {
                                    const range=document.createRange();range.setStart(node,word.index);range.setEnd(node,word.index+word[0].length);
                                    return range.getClientRects().length===1;
                                  });
                            }"""), "complete error words stay visible and never fragment across lines")
                            self.assertEqual(page.evaluate("document.documentElement.scrollWidth - innerWidth"), 0)
                            self.assertEqual(card.locator(".agentlive__error").count(), 0)
                            shot(page, f"340-working-stop-failed-{engine}-rail-text{scale}")
                        error.get_by_role("button", name="Dismiss Stop error").click()
                        expect(error).to_have_count(0)
                        expect(card.get_by_role("button", name="Stop your assistant")).to_be_focused()
                        self.assertFalse(self.api(page, "GET", f"/api/v1/assistant-runs/{run['id']}")["stopRequested"],
                                         "Dismiss only clears local feedback")
                    else:
                        shot(page, f"340-working-stop-failed-{engine}")
                    card.get_by_role("button", name="Stop your assistant").click()
                    self.stopped(page, run)
                    self.assertEqual(len(attempts), 2)

    def test_04_old_read_and_stop_completion_do_not_cross_real_sign_out(self) -> None:
        for engine in self.browsers:
            with self.subTest(engine=engine):
                page, ids = self.person(engine)
                other, other_ids = self.person(engine, enabled=False)
                run = self.start(page, ids)
                self.hold_list(page, "old-identity")
                page.evaluate("window.__workingWire.arm('old-stop', 'stop')")
                page.locator(".agentlive").get_by_role("button", name="Stop your assistant").click()
                page.wait_for_function("window.__workingWire.gates['old-stop']?.held")
                expect(page.locator(".agentlive")).to_have_attribute("aria-label", "Stopping your assistant…")
                expect(page.locator(".agentlive").get_by_role("button", name="Stop your assistant")).to_be_disabled()
                stopped = self.wait_run(page, run["id"], lambda current: current["status"] == "stopped")
                self.assertIsNone(stopped["answer"])
                page.evaluate("window.__sameWorkingDocument = true")
                page.get_by_role("button", name=re.compile("Ada Kowalska.*account and sign out")).click()
                page.get_by_role("dialog", name="Account", exact=True).get_by_role("button", name="Sign out", exact=True).click()
                expect(page.get_by_role("heading", name="Sign in to Flux", exact=True)).to_be_visible()
                page.get_by_label("Email").fill(other_ids["email"])
                page.get_by_label("Password", exact=True).fill(PASSWORD)
                page.get_by_role("button", name="Sign in", exact=True).click()
                expect(page.get_by_role("heading", name="Home", exact=True)).to_be_visible()
                self.assertEqual(self.api(page, "GET", "/api/v1/me")["user"]["id"], other_ids["user"])
                self.assertEqual(self.api(page, "GET", "/api/v1/assistant-runs?limit=10")["items"], [])
                self.api(page, "GET", f"/api/v1/assistant-runs/{run['id']}", status=404)
                page.evaluate("window.__workingWire.watchIdle()")
                self.release(page, "old-identity")
                self.release(page, "old-stop")
                expect(page.locator(".agentlive__notice")).to_have_count(0)
                expect(page.locator(".agentlive")).to_have_count(0)
                self.assertEqual(page.evaluate("window.__workingWire.breaches"), [])
                self.assertTrue(page.evaluate("window.__sameWorkingDocument"))
                other.close()


    def test_05_older_delivery_failure_cannot_hide_a_newer_working_answer(self) -> None:
        for engine in self.browsers:
            with self.subTest(engine=engine):
                page, ids = self.person(engine)
                run = self.start(page, ids)
                self.hold_list(page, "older-failure")
                try:
                    before = page.evaluate("window.__workingWire.history.length")
                    page.evaluate("window.dispatchEvent(new Event('focus'))")
                    page.wait_for_function("before => window.__workingWire.history.slice(before).some(r => r.kind === 'list' && r.status === 200 && r.delivery === 'delivered')", arg=before)
                finally:
                    self.release(page, "older-failure", reject=True)
                expect(page.locator(".agentlive")).to_be_visible()
                self.assertEqual(self.api(page, "GET", f"/api/v1/assistant-runs/{run['id']}")["status"], "dispatching")
                page.locator(".agentlive").get_by_role("button", name="Stop your assistant").click()
                self.stopped(page, run)


    def test_06_compact_error_belongs_only_to_its_active_instance(self) -> None:
        for engine in self.browsers:
            for ending in ("unmount", "terminal", "late-failure-after-sign-out"):
                with self.subTest(engine=engine, ending=ending):
                    page, ids = self.person(engine)
                    run = self.start(page, ids)
                    def refuse(route: Route) -> None:
                        route.fulfill(status=503, content_type="application/json", body='{"code":"TEMPORARY_UNAVAILABLE"}')
                    page.route(f"**/api/v1/assistant-runs/{run['id']}/stop", refuse)
                    if ending == "late-failure-after-sign-out":
                        other, other_ids = self.person(engine, enabled=False)
                        page.evaluate("window.__workingWire.arm('late-failure', 'stop')")
                        page.locator(".agentlive").get_by_role("button", name="Stop your assistant").click()
                        page.wait_for_function("window.__workingWire.gates['late-failure']?.held")
                        self.assertFalse(self.api(page, "GET", f"/api/v1/assistant-runs/{run['id']}")["stopRequested"])
                        page.get_by_role("button", name=re.compile("Ada Kowalska.*account and sign out")).click()
                        page.get_by_role("dialog", name="Account", exact=True).get_by_role("button", name="Sign out", exact=True).click()
                        expect(page.get_by_role("heading", name="Sign in to Flux", exact=True)).to_be_visible()
                        page.get_by_label("Email").fill(other_ids["email"])
                        page.get_by_label("Password", exact=True).fill(PASSWORD)
                        page.get_by_role("button", name="Sign in", exact=True).click()
                        expect(page.get_by_role("heading", name="Home", exact=True)).to_be_visible()
                        self.assertEqual(self.api(page, "GET", "/api/v1/me")["user"]["id"], other_ids["user"])
                        self.release(page, "late-failure")
                        expect(page.locator(".agentlive__notice")).to_have_count(0)
                        expect(page.locator(".agentlive")).to_have_count(0)
                        other.close()
                        continue
                    page.keyboard.press("[")
                    expect(page.locator(".side--rail")).to_be_visible()
                    page.locator(".agentlive").get_by_role("button", name="Stop your assistant").click()
                    notice = page.locator(".agentlive__notice")
                    expect(notice).to_be_visible()
                    if ending == "unmount":
                        page.get_by_role("button", name="Expand sidebar").click()
                        expect(notice).to_have_count(0)
                        expect(page.locator(".agentlive")).to_be_visible()
                        self.assertFalse(self.api(page, "GET", f"/api/v1/assistant-runs/{run['id']}")["stopRequested"])
                    else:
                        # APIRequestContext bypasses the simulated page delivery refusal: a real Stop.
                        self.api(page, "POST", f"/api/v1/assistant-runs/{run['id']}/stop")
                        self.stopped(page, run)
                        expect(notice).to_have_count(0)


    def test_07_unrelated_stream_events_do_not_refetch_private_run_state(self) -> None:
        for engine in self.browsers:
            with self.subTest(engine=engine):
                page, ids = self.person(engine)
                frames: list[dict] = []
                page.on("websocket", lambda socket: socket.on("framereceived", lambda frame: frames.append(json.loads(frame))))
                page.reload()
                expect(page.get_by_role("heading", name="Home", exact=True)).to_be_visible()
                page.wait_for_function("window.__workingWire.history.some(r => r.kind === 'list' && r.delivery === 'delivered' && r.status === 200)")
                before = page.evaluate("window.__workingWire.history.length")
                sketch = self.api(page, "POST", f"/api/v1/workspaces/{ids['workspace']}/sketches", {"title": "An unrelated private sketch", "scope": "private"}, 201)
                deadline = time.monotonic() + 8
                while time.monotonic() < deadline and not any(frame.get("objectId") == sketch["id"] for frame in frames):
                    page.wait_for_timeout(50)
                self.assertTrue(any(frame.get("objectId") == sketch["id"] for frame in frames), "the genuine unrelated event reached this tab")
                page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
                self.assertEqual(page.evaluate("window.__workingWire.history.length"), before, "unrelated project activity does not read private run state")
                run = self.start(page, ids)
                expect(page.locator(".agentlive")).to_be_visible()
                page.locator(".agentlive").get_by_role("button", name="Stop your assistant").click()
                self.stopped(page, run)

    def test_08_cancelled_navigation_resumes_pending_stop_from_current_server_truth(self) -> None:
        for engine in self.browsers:
            with self.subTest(engine=engine):
                page, ids = self.person(engine)
                run = self.start(page, ids)
                self.hold_list(page, "pre-retirement")
                page.evaluate("window.__workingWire.arm('retiring-stop', 'stop')")
                page.locator(".agentlive").get_by_role("button", name="Stop your assistant").click()
                page.wait_for_function("window.__workingWire.gates['retiring-stop']?.held")
                self.wait_run(page, run["id"], lambda current: current["status"] == "stopped")
                expect(page.locator(".agentlive")).to_have_attribute("aria-label", "Stopping your assistant…")
                # Native beforeunload dialogue: the real Stop click supplies user activation.
                # Dismiss cancels document replacement; no synthetic lifecycle event resumes it.
                with page.expect_event("dialog", timeout=8000) as pending:
                    page.evaluate("""() => {
                      window.__sameCancelledWorkingDocument = true;
                      addEventListener('beforeunload', event => { event.preventDefault(); event.returnValue = 'Keep this page'; }, {once:true});
                      setTimeout(() => location.reload(), 0);
                    }""")
                dialog = pending.value
                self.assertEqual(dialog.type, "beforeunload")
                dialog.dismiss()
                self.assertTrue(page.evaluate("window.__sameCancelledWorkingDocument"))
                page.get_by_role("heading", name="Home", exact=True).click()
                self.stopped(page, run)
                page.evaluate("window.__workingWire.watchIdle()")
                self.release(page, "pre-retirement")
                self.release(page, "retiring-stop")
                expect(page.locator(".agentlive")).to_have_count(0)
                self.assertEqual(page.evaluate("window.__workingWire.breaches"), [], "retired read and Stop answers cannot revive an old run")
                self.assertEqual(page.evaluate("window.__workingWire.history.filter(r => r.kind === 'stop').length"), 1, "resuming sends no second Stop")
                # A subsequent genuine own-run event still refreshes after cancellation.
                later = self.start(page, ids)
                expect(page.locator(".agentlive")).to_be_visible()
                page.goto("about:blank")
                page.go_back()
                expect(page.locator(".agentlive")).to_be_visible()
                page.locator(".agentlive").get_by_role("button", name="Stop your assistant").click()
                self.stopped(page, later)

if __name__ == "__main__":
    unittest.main()
