"""#149: confirmed captures and recoverable edits against the Docker UI and real API."""
from __future__ import annotations

import re
import json
import time
import unittest
import uuid

from playwright.sync_api import expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, SHOTS, UPSTREAM, shot, start_forwarder
from test_theme_accents import MEASURE

STAMP = int(time.time() * 1000)
PASSWORD = "keep private captures recoverable"
# Fill this tab's real sessionStorage until the browser itself refuses another write. One filler
# entry grows to the largest size the quota accepts; nothing is stubbed or simulated.
EXHAUST_SESSION_STORAGE = """() => {
  const fits = (size) => {
    try { sessionStorage.setItem('quota-filler', 'x'.repeat(size)); return true; }
    catch (error) { if (error.name !== 'QuotaExceededError') throw error; return false; }
  };
  let low = 0, high = 1 << 25;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle; else high = middle - 1;
  }
  try { sessionStorage.setItem('quota-probe', 'x'); } catch (error) { return error.name; }
  sessionStorage.removeItem('quota-probe');
  return 'accepted';
}"""
# Safari (macOS, iPhone/iPad) and macOS Firefox never focus a pressed <button>: the default action
# of an unprevented mousedown clears focus instead, so the editor blurs with no related target.
# Chromium focuses the button; this models those browsers' default action in the real page.
BUTTONS_TAKE_NO_FOCUS = """document.addEventListener('mousedown', (event) => {
  const button = event.target instanceof Element ? event.target.closest('button') : null;
  if (!button || event.defaultPrevented) return;
  event.preventDefault();
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
});"""
STORED_DRAFT_TEXTS = "Object.keys(sessionStorage).filter(k => k.startsWith('flux:thought-draft:')).map(k => JSON.parse(sessionStorage.getItem(k)).text)"
EARLIER = "Earlier persisted draft"
LATEST = "Latest recoverable draft after quota exhaustion"


class ThoughtDraftJourney(unittest.TestCase):
    states = {}
    people = {}

    @classmethod
    def setUpClass(cls):
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        expect.set_options(timeout=10000)
        contexts = {}
        for who, name in (("owner", "Ada Capture"), ("writer", "Jonas Berg"), ("viewer", "Nia Reader")):
            ctx = cls.browser.new_context(base_url=ORIGIN)
            email = f"capture-{who}+{STAMP}@example.test"
            answer = ctx.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert answer.status == 200, answer.text()
            cls.people[who] = {"id": ctx.request.get("/api/v1/me").json()["user"]["id"], "email": email}
            cls.states[who] = ctx.storage_state()
            contexts[who] = ctx
        owner = contexts["owner"]
        answer = owner.request.post("/api/v1/workspaces", data={"name": "Riverside interaction studies"}, headers={"origin": ORIGIN})
        assert answer.status == 201, answer.text()
        cls.workspace = answer.json()["id"]
        for who in ("writer", "viewer"):
            answer = owner.request.post(f"/api/v1/workspaces/{cls.workspace}/members", data={"email": cls.people[who]["email"], "role": "member"}, headers={"origin": ORIGIN})
            assert answer.status == 201, answer.text()
        for ctx in contexts.values():
            ctx.close()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def page(self, who="owner", **options):
        ctx = self.browser.new_context(**{"base_url": ORIGIN, "storage_state": self.states[who], "viewport": DESKTOP, "color_scheme": "light", **options})
        self.addCleanup(ctx.close)
        if ctx.request.get('/api/v1/me').status == 401:
            response = ctx.request.post('/api/auth/sign-in/email', data={'email': self.people[who]['email'], 'password': PASSWORD}, headers={'origin': ORIGIN})
            self.assertEqual(response.status, 200, response.text())
            self.states[who] = ctx.storage_state()
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught browser errors"))
        return page

    def api(self, page, method, path, body=None, status=200, headers=None):
        response = page.request.fetch(path, method=method, data=body, headers={"origin": ORIGIN, "idempotency-key": str(uuid.uuid4()), **(headers or {})})
        self.assertEqual(response.status, status, response.text())
        return response.json() if response.text() else None

    def setUp(self):
        self.owner = self.page()
        self.project = self.api(self.owner, "POST", f"/api/v1/workspaces/{self.workspace}/projects", {"name": "Quiet gesture lamp", "visibility": "restricted"}, 201)["id"]
        for who, role in (("writer", "contributor"), ("viewer", "viewer")):
            self.grant(who, role)
        self.sketch = self.new_sketch("Bedside sensing directions")
        self.parent = self.api(self.owner, "POST", f"/api/v1/sketches/{self.sketch}/thoughts", {"text": "Capture a gesture without recording camera images", "x": 0, "y": 0}, 201)["thought"]["id"]
        self.api(self.owner, "POST", f"/api/v1/sketches/{self.sketch}/thoughts", {"text": "Compare the ToF distance sensor with the radar prototype", "x": 0, "y": 180, "linkFrom": {"thoughtId": self.parent}}, 201)
        self.before = self.stored(self.owner)

    def grant(self, who, role):
        self.api(self.owner, "POST", f"/api/v1/projects/{self.project}/grants", {"principal": {"kind": "human", "id": self.people[who]["id"]}, "role": role}, 201)

    def new_sketch(self, title):
        return self.api(self.owner, "POST", f"/api/v1/workspaces/{self.workspace}/sketches", {"title": title, "scope": "project", "projectId": self.project}, 201)["id"]

    def stored(self, page, sketch=None):
        return self.api(page, "GET", f"/api/v1/sketches/{sketch or self.sketch}")

    def wait_stored(self, page, predicate):
        for _ in range(50):
            current = self.stored(page)
            if predicate(current):
                return current
            page.wait_for_timeout(100)
        self.fail('the expected committed API state did not arrive')

    def open(self, page, sketch=None, mode="List"):
        page.goto(f"/projects/{self.project}/map/{sketch or self.sketch}")
        expect(page.locator(".sk-head")).to_be_visible()
        page.get_by_role("radio", name=mode, exact=True).click()

    def capture(self, page, *, child=False):
        if child:
            page.locator(f'.sk-li-t[data-id="{self.parent}"]').focus()
            page.keyboard.press("+")
        else:
            page.get_by_role("toolbar", name="Sketch tools").get_by_role("button", name="Thought", exact=True).click()
        field = page.get_by_role("form", name="New thought draft").get_by_label("Thought text")
        expect(field).to_be_focused()
        return field

    def exhaust_session_storage(self, page):
        self.assertEqual(page.evaluate(EXHAUST_SESSION_STORAGE), "QuotaExceededError", "the browser itself refuses a further session storage write")

    def stored_drafts(self, page):
        return page.evaluate(STORED_DRAFT_TEXTS)

    def leave_by_sketches_link_and_reopen(self, page):
        """Follow the header's Sketches link, then open the same map again without reloading the page."""
        page.locator(".sk-back").click()
        expect(page).to_have_url(re.compile(rf"/projects/{self.project}/map$"))
        page.locator(f'.sk-index a[href="/projects/{self.project}/map/{self.sketch}"]').click()
        expect(page).to_have_url(re.compile(rf"/projects/{self.project}/map/{self.sketch}$"))
        expect(page.locator(".sk-head")).to_be_visible()

    def test_01_cancel_empty_blur_and_composition_never_write(self):
        page = self.owner
        self.open(page)
        writes = []
        page.on("request", lambda request: writes.append(request.url) if request.method != "GET" and "/sketches/" in request.url else None)
        field = self.capture(page)
        field.press("Enter")
        expect(page.get_by_role("button", name="Save thought", exact=True)).to_be_disabled()
        field.fill("<b>Literal text</b> · ゆっくり動かす")
        field.evaluate("e => e.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true, isComposing:true}))")
        expect(field).to_be_visible()
        page.get_by_role("radio", name="Map", exact=True).click()
        expect(field).to_have_value("<b>Literal text</b> · ゆっくり動かす")
        self.assertEqual(self.stored(page), self.before)
        field.press("Escape")
        expect(page.get_by_role("form", name="New thought draft")).to_have_count(0)
        page.get_by_role("radio", name="List", exact=True).click()
        self.capture(page, child=True).fill("Cancel this child")
        page.get_by_role("button", name="Cancel", exact=True).click()
        self.assertEqual(self.stored(page), self.before)
        self.assertEqual(writes, [], "no write can create a placeholder, relation or event before save")

    def test_02_draft_survives_projection_map_navigation_and_reload(self):
        page = self.owner
        self.open(page)
        field = self.capture(page, child=True)
        text = "A slow swipe switches the lamp off\n<b>Keep this markup literal</b>"
        field.fill(text)
        page.get_by_role("radio", name="Map", exact=True).click()
        expect(field).to_have_value(text)
        other = self.new_sketch("Separate reading corner")
        self.open(page, other)
        expect(page.get_by_role("form", name="New thought draft")).to_have_count(0)
        self.capture(page).fill("Independent draft on another map")
        self.open(page)
        field = page.get_by_label("Thought text")
        expect(field).to_have_value(text)
        page.reload()
        expect(page.get_by_label("Thought text")).to_have_value(text)
        peer = self.page("writer")
        self.assertEqual(self.stored(peer), self.before)
        requests = []
        page.on("request", lambda r: requests.append(r) if r.method == "POST" and r.url.endswith(f"/{self.sketch}/thoughts") else None)
        page.get_by_role("button", name="Save thought", exact=True).click()
        expect(page.get_by_role("form", name="New thought draft")).to_have_count(0)
        expect(page.locator(".sk-status")).to_contain_text("Saved")
        created = self.stored(peer)
        added = next(t for t in created["thoughts"] if t["text"] == text)
        self.assertEqual(len(created["thoughts"]), 3)
        self.assertEqual(len(created["links"]), 2)
        self.assertTrue(any(l["fromId"] == self.parent and l["toId"] == added["id"] for l in created["links"]))
        self.assertEqual(len(requests), 1, "thought and relation use one atomic command")
        page.reload()
        expect(page.locator(f'.sk-li-t[data-id="{added["id"]}"]')).to_contain_text("<b>Keep this markup literal</b>")
        self.assertEqual(self.stored(page), created)
        self.assertEqual([(t["id"], t["x"], t["y"], t["source"]) for t in created["thoughts"] if t["id"] != added["id"]], [(t["id"], t["x"], t["y"], t["source"]) for t in self.before["thoughts"]])
        self.open(page, other)
        expect(page.get_by_label("Thought text")).to_have_value("Independent draft on another map")

    def test_03_uncertain_committed_response_retries_exactly_once_and_undo_removes_link(self):
        page = self.owner
        self.open(page)
        field = self.capture(page, child=True)
        field.fill("Hold deliberately before switching off")
        submitted = []
        path = f"**/api/v1/sketches/{self.sketch}/thoughts"

        def lose_response(route):
            submitted.append((route.request.post_data_json, route.request.headers["idempotency-key"]))
            actual = route.fetch()
            self.assertEqual(actual.status, 201, actual.text())
            route.fulfill(status=503, json={"message": "test: committed response lost"})

        page.route(path, lose_response)
        field.press("Enter")
        expect(page.locator(".sk-status")).to_contain_text("draft is kept")
        expect(field).to_have_value("Hold deliberately before switching off")
        self.assertNotIn("Saved", page.locator(".sk-status").inner_text())
        committed = self.stored(page)
        self.assertEqual(len(committed["thoughts"]), 3)
        page.unroute(path, lose_response)
        page.on("request", lambda r: submitted.append((r.post_data_json, r.headers["idempotency-key"])) if r.method == "POST" and r.url.endswith(f"/{self.sketch}/thoughts") else None)
        field.press("Enter")
        expect(page.get_by_role("form", name="New thought draft")).to_have_count(0)
        self.assertEqual(submitted[0], submitted[1], "retry retains the exact payload, IDs and request key")
        self.assertEqual(self.stored(page), committed)
        page.get_by_role("button", name="Undo", exact=True).click()
        restored = self.wait_stored(page, lambda current: len(current['thoughts']) == 2)
        self.assertEqual(restored["thoughts"], self.before["thoughts"])
        self.assertEqual(restored["links"], self.before["links"])

    def test_04_deleted_parent_leaves_text_and_no_partial_thought(self):
        page = self.owner
        self.open(page)
        self.capture(page, child=True).fill("Never silently turn this into a root")
        peer = self.page("writer")
        parent = next(t for t in self.before["thoughts"] if t["id"] == self.parent)
        self.api(peer, "DELETE", f"/api/v1/sketches/{self.sketch}/thoughts/{self.parent}", status=204, headers={"if-match": f'"{parent["version"]}"'})
        page.get_by_role("button", name="Save thought", exact=True).click()
        expect(page.locator(".sk-status")).to_contain_text("draft is kept")
        expect(page.get_by_label("Thought text")).to_have_value("Never silently turn this into a root")
        self.assertEqual(len(self.stored(peer)["thoughts"]), 1)
        self.assertEqual(self.stored(peer)["links"], [])

    def test_05_lost_permission_and_revocation_recover_private_text_even_after_reload(self):
        page = self.page("writer")
        self.open(page)
        self.capture(page, child=True).fill("PRIVATE unsaved calibration idea")
        # Keep an old authorized read while the real backend checks current write permission.
        get_path = f"**/api/v1/sketches/{self.sketch}"
        page.route(get_path, lambda route: route.fulfill(json=self.before))
        self.grant("writer", "viewer")
        page.get_by_role("button", name="Save thought", exact=True).click()
        expect(page.locator(".sk-status")).to_contain_text("draft is kept")
        expect(page.get_by_label("Thought text")).to_have_value("PRIVATE unsaved calibration idea")
        self.assertEqual(self.stored(self.owner), self.before)
        page.unroute(get_path)
        page.reload()
        expect(page.get_by_role("button", name="Save thought", exact=True)).to_be_disabled()
        self.grant("writer", "denied")
        page.reload()
        expect(page.get_by_label("Recoverable thought draft")).to_have_value("PRIVATE unsaved calibration idea")
        self.assertNotIn(self.before["title"], page.locator("main").inner_text())
        self.assertEqual(self.stored(self.owner), self.before)
        reader = self.page("viewer")
        self.open(reader)
        expect(reader.get_by_role("form", name="New thought draft")).to_have_count(0)
        expect(reader.get_by_role("toolbar", name="Sketch tools")).to_have_count(0)

    def test_06_f2_cancel_multiline_and_real_concurrent_edit_are_recoverable(self):
        page = self.owner
        self.open(page)
        row = page.locator(f'.sk-li-t[data-id="{self.parent}"]')
        row.focus()
        row.press("F2")
        field = page.get_by_label("Thought text")
        field.fill("Discard this existing edit")
        page.get_by_role("button", name="Cancel edit", exact=True).click()
        self.assertEqual(self.stored(page), self.before)
        row.focus()
        row.press("F2")
        field.fill("My private proposal\n<b>Literal text</b>")
        field.evaluate("e => e.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true, isComposing:true}))")
        self.assertEqual(self.stored(page), self.before)
        peer = self.page("writer")
        thought = next(t for t in self.before["thoughts"] if t["id"] == self.parent)
        with page.expect_response(lambda response: response.request.method == 'GET' and response.url.endswith(f'/api/v1/sketches/{self.sketch}')) as streamed:
            self.api(peer, "PATCH", f"/api/v1/sketches/{self.sketch}/thoughts/{self.parent}", {"text": "Jonas confirmed the newer sensor requirement"}, headers={"if-match": f'"{thought["version"]}"'})
        # The stream is allowed to refetch before Ada saves: her opened version must stay fixed.
        self.assertTrue(any(t['text'] == 'Jonas confirmed the newer sensor requirement' for t in streamed.value.json()['thoughts']))
        page.wait_for_timeout(150)
        field.press("Enter")
        expect(page.locator(".sk-status")).to_contain_text("Someone else changed")
        expect(page.get_by_label("Thought text")).to_have_value("My private proposal\n<b>Literal text</b>")
        shot(page, 'thought-edit-conflict-desktop')
        self.assertTrue(page.locator('.sk-status').evaluate('e => e.scrollWidth <= e.clientWidth + 1 && e.scrollHeight <= e.clientHeight + 1'), 'The complete conflict recovery wording must fit its rendered row, allowing one rounded CSS pixel')
        current = next(t for t in self.stored(peer)["thoughts"] if t["id"] == self.parent)
        self.assertEqual(current["text"], "Jonas confirmed the newer sensor requirement")
        page.get_by_role("button", name="Cancel edit", exact=True).click()
        expect(row).to_contain_text(current["text"])
        row.press("F2")
        field = page.get_by_label("Thought text")
        field.fill("A deliberate hold")
        field.press("End")
        field.press("Shift+Enter")
        field.type("<b>does not record images</b>")
        page.get_by_role("button", name="Save edit", exact=True).click()
        expect(page.locator(".sk-status")).to_contain_text("Saved")
        self.assertEqual(next(t for t in self.stored(peer)["thoughts"] if t["id"] == self.parent)["text"], "A deliberate hold\n<b>does not record images</b>")

    def test_07_failed_existing_edit_keeps_text_and_retries(self):
        page = self.owner
        self.open(page)
        row = page.locator(f'.sk-li-t[data-id="{self.parent}"]')
        row.click()
        row.press("F2")
        field = page.get_by_label("Thought text")
        field.fill("Keep the manual off switch")
        path = f"**/api/v1/sketches/{self.sketch}/thoughts/{self.parent}"
        page.route(path, lambda route: route.fulfill(status=503, json={"message": "temporary test failure"}))
        field.press("Enter")
        expect(page.locator(".sk-status")).to_contain_text("text is kept")
        expect(page.get_by_label("Thought text")).to_have_value("Keep the manual off switch")
        self.assertEqual(self.stored(page), self.before)
        page.get_by_role('toolbar', name='Sketch tools').get_by_role('button', name='Edit', exact=True).click()
        expect(page.get_by_label('Thought text')).to_have_value('Keep the manual off switch')
        shot(page, 'thought-edit-failure-desktop')
        self.assertTrue(page.locator('.sk-status').evaluate('e => e.scrollWidth <= e.clientWidth + 1 && e.scrollHeight <= e.clientHeight + 1'), 'The complete failed-save recovery wording must fit its rendered row, allowing one rounded CSS pixel')
        page.unroute(path)
        page.get_by_role("button", name="Save edit", exact=True).click()
        expect(page.locator(".sk-status")).to_contain_text("Saved")
        self.assertEqual(next(t for t in self.stored(page)["thoughts"] if t["id"] == self.parent)["text"], "Keep the manual off switch")

    def test_08_sign_out_discards_drafts_before_another_account_signs_in(self):
        page = self.owner
        self.open(page)
        self.capture(page).fill("PRIVATE Ada draft")
        page.locator(".me__btn").click()
        page.get_by_role("dialog", name="Account", exact=True).get_by_role("button", name="Sign out", exact=True).click()
        expect(page).to_have_url(re.compile(r"/sign-in$"))
        self.assertEqual(page.evaluate("Object.keys(sessionStorage).filter(k => k.startsWith('flux:thought-draft:'))"), [])
        page.get_by_label("Email").fill(self.people["writer"]["email"])
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Sign in", exact=True).click()
        expect(page.get_by_role("heading", name="Home", exact=True)).to_be_visible()
        self.open(page)
        expect(page.get_by_role("form", name="New thought draft")).to_have_count(0)
        self.assertEqual(self.stored(page), self.before)

    def test_09_matched_desktop_phone_tablet_and_touch_save(self):
        measurements = []
        for theme in ("light", "dark"):
            for name, viewport in (("desktop", DESKTOP), ("phone", PHONE), ("tablet", {"width": 820, "height": 1180})):
                page = self.page(viewport=viewport, has_touch=name != "desktop", is_mobile=name == "phone", color_scheme=theme)
                self.open(page)
                field = self.capture(page, child=True)
                field.fill("Test a deliberate hold in the dark\nKeep a manual switch within reach")
                expect(page.get_by_role("button", name="Save thought", exact=True)).to_be_visible()
                expect(page.get_by_role("button", name="Save thought", exact=True)).to_be_enabled()
                expect(page.get_by_role("button", name="Cancel", exact=True)).to_be_visible()
                self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), viewport["width"])
                for selector in ('.sk-draft__context', '.sk-draft textarea', '.sk-draft__actions span', '.sk-draft .ui-btn--primary', '.sk-draft .ui-btn--quiet'):
                    page.wait_for_function("selector => { const node = document.querySelector(selector); if (!node) return false; for (let el = node; el; el = el.parentElement) if (Number(getComputedStyle(el).opacity) !== 1) return false; return true; }", arg=selector)
                    page.wait_for_function("selector => document.querySelector(selector).getAnimations().every(animation => animation.playState === 'finished' || animation.playState === 'idle')", arg=selector)
                    measured = page.evaluate(MEASURE, {'selector': selector})
                    measurements.append({'theme': theme, 'viewport': name, **measured})
                    self.assertGreaterEqual(measured['ratio'], 4.5, f'{theme}/{name} {selector}: readable actual draft text {measured}')
                shot(page, f"thought-draft-{theme}-{name}-list")
                page.get_by_role("radio", name="Map", exact=True).click()
                expect(field).to_have_value("Test a deliberate hold in the dark\nKeep a manual switch within reach")
                shot(page, f"thought-draft-{theme}-{name}-map")
                if name == "phone":
                    page.get_by_role("button", name="Save thought", exact=True).tap()
                    expect(page.get_by_role("form", name="New thought draft")).to_have_count(0)
                    expect(page.locator(".sk-status")).to_contain_text("Saved")
                    page.get_by_role('button', name='Undo', exact=True).tap()
                    self.wait_stored(page, lambda current: len(current['thoughts']) == 2)
                else:
                    page.get_by_role("button", name="Cancel", exact=True).click()
                page.get_by_role('radio', name='List', exact=True).click()
                page.locator(f'.sk-li-t[data-id="{self.parent}"]').click()
                page.get_by_role('toolbar', name='Sketch tools').get_by_role('button', name='Edit', exact=True).click()
                page.get_by_label('Thought text').fill('Keep the manual off switch within reach')
                shot(page, f'thought-edit-{theme}-{name}-list')
                page.get_by_role('button', name='Cancel edit', exact=True).click()
        if SHOTS:
            (SHOTS / 'thought-draft-contrast.json').write_text(json.dumps(measurements, indent=2) + '\n')

    def test_10_latest_draft_survives_a_refused_storage_write_and_map_navigation(self):
        page = self.owner
        self.open(page)
        writes = []
        page.on("request", lambda request: writes.append(request.url) if request.method != "GET" and "/sketches/" in request.url else None)
        field = self.capture(page)
        field.fill(EARLIER)
        self.assertEqual(self.stored_drafts(page), [EARLIER])
        self.exhaust_session_storage(page)
        field.fill(LATEST)
        self.assertEqual(self.stored_drafts(page), [EARLIER], "the browser refused the later write, so only the older text is persisted")
        page.evaluate("window.sameVisit = true")
        self.leave_by_sketches_link_and_reopen(page)
        self.assertTrue(page.evaluate("window.sameVisit === true"), "the map reopened inside one page visit, not after a reload")
        expect(page.get_by_label("Thought text")).to_have_value(LATEST)
        self.assertEqual(self.stored_drafts(page), [EARLIER])
        # Session storage belongs to its tab: another tab of the same person starts without this draft,
        # and a draft saved there for the same map never reaches this tab's copy or storage.
        second = page.context.new_page()
        second.goto(f"/projects/{self.project}/map/{self.sketch}")
        expect(second.locator(".sk-head")).to_be_visible()
        expect(second.get_by_role("form", name="New thought draft")).to_have_count(0)
        self.assertEqual(self.stored_drafts(second), [])
        self.capture(second).fill("Second tab's own draft")
        self.assertEqual(self.stored_drafts(second), ["Second tab's own draft"])
        self.assertEqual(self.stored_drafts(page), [EARLIER])
        self.leave_by_sketches_link_and_reopen(page)
        expect(page.get_by_label("Thought text")).to_have_value(LATEST)
        second.close()
        # Cancel removes the visit's copy and the older persisted one; neither returns on reopening.
        page.get_by_role("button", name="Cancel", exact=True).click()
        expect(page.get_by_role("form", name="New thought draft")).to_have_count(0)
        self.assertEqual(self.stored_drafts(page), [])
        self.leave_by_sketches_link_and_reopen(page)
        expect(page.get_by_role("form", name="New thought draft")).to_have_count(0)
        self.assertEqual(self.stored(page), self.before)
        self.assertEqual(writes, [], "no shared sketch write happened")

    def test_11_storage_that_accepts_writes_again_catches_up_before_a_reload(self):
        page = self.owner
        self.open(page)
        field = self.capture(page)
        field.fill(EARLIER)
        self.exhaust_session_storage(page)
        field.fill(LATEST)
        self.assertEqual(self.stored_drafts(page), [EARLIER])
        page.evaluate("sessionStorage.removeItem('quota-filler')")
        newest = "Newest draft once storage accepts writes again"
        field.fill(newest)
        self.assertEqual(self.stored_drafts(page), [newest])
        page.reload()
        expect(page.get_by_label("Thought text")).to_have_value(newest)
        self.assertEqual(self.stored(page), self.before)

    def test_12_sign_out_clears_the_visit_copy_that_outlived_a_refused_write(self):
        page = self.owner
        self.open(page)
        field = self.capture(page)
        field.fill(EARLIER)
        self.exhaust_session_storage(page)
        field.fill(LATEST)
        page.evaluate("window.sameVisit = true")
        page.locator(".me__btn").click()
        page.get_by_role("dialog", name="Account", exact=True).get_by_role("button", name="Sign out", exact=True).click()
        expect(page).to_have_url(re.compile(r"/sign-in$"))
        self.assertEqual(self.stored_drafts(page), [])
        page.get_by_label("Email").fill(self.people["owner"]["email"])
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Sign in", exact=True).click()
        expect(page.get_by_role("heading", name="Home", exact=True)).to_be_visible()
        # The same person in the same page visit, reaching the map through the app's own links.
        page.get_by_role("navigation", name="Views").get_by_role("link", name="Map").click()
        page.locator(f'.sk-index a[href="/map/{self.sketch}"]').click()
        expect(page.locator(".sk-head")).to_be_visible()
        self.assertTrue(page.evaluate("window.sameVisit === true"), "no reload: only sign-out can have cleared the in-memory copy")
        expect(page.get_by_role("form", name="New thought draft")).to_have_count(0)
        self.assertEqual(self.stored_drafts(page), [])
        self.assertEqual(self.stored(page), self.before)

    def test_13_own_nudge_just_before_editing_is_not_a_conflict(self):
        page = self.owner
        self.open(page, mode="Map")
        node = page.locator(f'.sk-node[data-id="{self.parent}"]')
        node.focus()
        node.press("ArrowRight")
        # Edit at once: the coalesced nudge is still unsent, so the editor opens on the older version.
        node.press("F2")
        field = page.get_by_label("Thought text")
        expect(field).to_be_focused()
        field.fill("Nudged, then renamed by the same person")
        opened = next(t for t in self.before["thoughts"] if t["id"] == self.parent)
        self.wait_stored(page, lambda current: next(t for t in current["thoughts"] if t["id"] == self.parent)["version"] > opened["version"])
        field.press("Enter")
        expect(page.locator(".sk-status")).to_contain_text("Edited")
        expect(page.locator(".sk-status")).not_to_contain_text("Someone else")
        stored = next(t for t in self.stored(page)["thoughts"] if t["id"] == self.parent)
        self.assertEqual((stored["text"], stored["x"]), ("Nudged, then renamed by the same person", opened["x"] + 12))

    def test_14_edit_buttons_work_where_a_pressed_button_takes_no_focus(self):
        page = self.owner
        page.add_init_script(BUTTONS_TAKE_NO_FOCUS)
        self.open(page)
        writes = []
        page.on("request", lambda request: writes.append(request.url) if request.method != "GET" and "/sketches/" in request.url else None)
        row = page.locator(f'.sk-li-t[data-id="{self.parent}"]')
        row.focus()
        row.press("F2")
        page.get_by_label("Thought text").fill("Discard this existing edit")
        page.get_by_role("button", name="Cancel edit", exact=True).click()
        expect(page.locator(".sk-status")).to_contain_text("Edit cancelled")
        expect(row).to_contain_text("Capture a gesture without recording camera images")
        self.assertEqual(writes, [], "Cancel edit never saves the discarded text")
        self.assertEqual(self.stored(page), self.before)
        row.press("F2")
        page.get_by_label("Thought text").fill("Saved with the visible button")
        page.get_by_role("button", name="Save edit", exact=True).click()
        expect(page.locator(".sk-status")).to_contain_text("Edited")
        self.assertEqual(next(t for t in self.stored(page)["thoughts"] if t["id"] == self.parent)["text"], "Saved with the visible button")
        self.assertEqual(len(writes), 1, "one save")

    def test_15_jump_to_shortcut_still_opens_while_typing_a_draft(self):
        page = self.owner
        self.open(page)
        field = self.capture(page)
        field.fill("Ask Jonas about the radar module")
        field.press("Control+k")
        jump = page.get_by_role("dialog", name="Jump to")
        expect(jump).to_be_visible()
        page.keyboard.press("Escape")
        expect(jump).to_have_count(0)
        expect(page.get_by_role("form", name="New thought draft").get_by_label("Thought text")).to_have_value("Ask Jonas about the radar module")
        self.assertEqual(self.stored(page), self.before)

    def test_16_committed_save_with_every_response_lost_then_refined_saves_the_refined_text_once(self):
        page = self.owner
        self.open(page)
        field = self.capture(page)
        field.fill("First text")
        path = f"**/api/v1/sketches/{self.sketch}/thoughts"

        def lose_response(route):
            actual = route.fetch()
            self.assertEqual(actual.status, 201, actual.text())
            route.fulfill(status=503, json={"message": "test: committed response lost"})

        page.route(path, lose_response)
        field.press("Enter")
        expect(page.locator(".sk-status")).to_contain_text("draft is kept")
        page.unroute(path, lose_response)
        committed = self.stored(page)
        created = [t for t in committed["thoughts"] if t["text"] == "First text"]
        self.assertEqual(len(created), 1, "the first save committed although its response was lost")
        # Editing gives the draft a fresh request key; its stable thought ID already exists on the server.
        field.fill("First text, then refined")
        field.press("Enter")
        expect(page.get_by_role("form", name="New thought draft")).to_have_count(0)
        expect(page.locator(".sk-status")).to_contain_text("Saved")
        stored = self.wait_stored(page, lambda current: any(t["text"] == "First text, then refined" for t in current["thoughts"]))
        self.assertEqual([t["id"] for t in stored["thoughts"] if t["text"].startswith("First text")], [created[0]["id"]],
                         "the refined text lands on the thought that committed, never a second thought")
        self.assertEqual(len(stored["thoughts"]), len(committed["thoughts"]))
