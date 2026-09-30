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
        page.get_by_role('button', name='Edit', exact=True).click()
        expect(page.get_by_label('Thought text')).to_have_value('Keep the manual off switch')
        shot(page, 'thought-edit-failure-desktop')
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
                expect(page.get_by_role("button", name="Cancel", exact=True)).to_be_visible()
                self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), viewport["width"])
                for selector in ('.sk-draft__context', '.sk-draft textarea', '.sk-draft__actions span', '.sk-draft .ui-btn--primary', '.sk-draft .ui-btn--quiet'):
                    page.wait_for_function("selector => { const node = document.querySelector(selector); if (!node) return false; for (let el = node; el; el = el.parentElement) if (Number(getComputedStyle(el).opacity) !== 1) return false; return true; }", arg=selector)
                    measured = page.evaluate(MEASURE, {'selector': selector})
                    measurements.append({'theme': theme, 'viewport': name, **measured})
                    self.assertGreaterEqual(measured['ratio'], 4.5, f'{theme}/{name}: readable actual draft text')
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
                page.get_by_role('button', name='Edit', exact=True).click()
                page.get_by_label('Thought text').fill('Keep the manual off switch within reach')
                shot(page, f'thought-edit-{theme}-{name}-list')
                page.get_by_role('button', name='Cancel edit', exact=True).click()
        if SHOTS:
            (SHOTS / 'thought-draft-contrast.json').write_text(json.dumps(measurements, indent=2) + '\n')
