"""Actual native bounded Tasks windows; legacy parent/detail fetch migration remains open."""
from __future__ import annotations

import json
import re
import unittest
import uuid
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import expect, sync_playwright
from test_app_shell import ORIGIN, UPSTREAM, open_details, shot, start_forwarder


def api(context, method, path, body=None, status=200):
    response = context.request.fetch(ORIGIN + path, method=method,
        headers={"origin": ORIGIN, "content-type": "application/json"},
        data=json.dumps(body) if body is not None else None)
    if response.status != status:
        raise AssertionError(f"native {method} {path} returned {response.status}: {response.text()}")
    return response.json() if response.text() else None


class WorkPaginationJourney(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        expect.set_options(timeout=10000)
        cls.contexts, cls.users, emails = [], [], []
        for name in ("Ada Kowalska", "Ada Nowak"):
            context = cls.browser.new_context(base_url=ORIGIN)
            email = f"work-pages-{uuid.uuid4()}@example.test"
            api(context, "POST", "/api/auth/sign-up/email", {"name": name, "email": email, "password": "a careful reading corner lamp"})
            cls.contexts.append(context); emails.append(email)
            cls.users.append(api(context, "GET", "/api/v1/me")["user"]["id"])
        owner = cls.contexts[0]
        workspace = api(owner, "POST", "/api/v1/workspaces", {"name": "Riverside lighting"}, 201)["id"]
        api(owner, "POST", f"/api/v1/workspaces/{workspace}/members", {"email": emails[1], "role": "member"}, 201)
        cls.project = api(owner, "POST", f"/api/v1/workspaces/{workspace}/projects", {"name": "Reading corner lamp", "visibility": "restricted"}, 201)["id"]
        cls.root = f"/api/v1/projects/{cls.project}"
        api(owner, "POST", cls.root + "/grants", {"principal": {"kind": "human", "id": cls.users[1]}, "role": "contributor"}, 201)
        conversation = api(owner, "POST", cls.root + "/conversations", {"body": "Compare the lamp measurements before ordering another sensor.", "clientMessageId": str(uuid.uuid4())}, 201)
        cls.conversation = conversation["id"]
        cls.work = []
        titles = ["Check distance sensor noise", "Compare low-light measurements", "Order replacement boards", "Measure standby current", "Write library installation notes", "Try the manual switch with gloves"]
        for index in range(123):
            status = "open" if index < 105 else "in_progress" if index < 117 else "blocked"
            command = {"title": f"{titles[index % len(titles)]} · {index + 1:03d}", "status": status,
                       "owner": {"kind": "human", "id": cls.users[index % 2]}}
            if status == "blocked": command["blocker"] = "the next library measurement"
            cls.work.append(api(owner, "POST", cls.root + "/work", command, 201))
        previous = api(owner, "POST", cls.root + "/decisions", {"title": "Use the camera prototype"}, 201)
        api(owner, "POST", f"/api/v1/decisions/{previous['id']}/accept", {"expectedVersion": 1})
        current = api(owner, "POST", cls.root + "/decisions", {"title": "Use the distance sensor", "supersedes": previous["id"]}, 201)
        api(owner, "POST", f"/api/v1/decisions/{current['id']}/accept", {"expectedVersion": 1, "stillApplies": [], "park": []})
        proposal = api(owner, "POST", cls.root + "/decisions", {"title": "Keep a manual off switch"}, 201)
        result = api(owner, "POST", cls.root + "/results", {"title": "Noise is lower after the shield", "finding": "positive", "evidence": "Twenty real fixture measurements"}, 201)
        cls.objects = {("work", item["id"]) for item in cls.work} | {("decision", item["id"]) for item in (previous, current, proposal)} | {("result", result["id"])}
        cls.states = [context.storage_state() for context in cls.contexts]
        cls.before = cls.native_digest()

    @classmethod
    def tearDownClass(cls):
        try:
            if cls.native_digest() != cls.before:
                raise AssertionError("read/navigation journeys changed native work fields or counts")
        finally:
            cls.browser.close(); cls.pw.stop()

    @classmethod
    def native_digest(cls):
        rows = []
        for offset in (0, 100):
            rows.extend(api(cls.contexts[0], "GET", cls.root + f"/work?limit=100&offset={offset}")["items"])
        return json.dumps(rows, sort_keys=True)

    def page(self, account=0, phone=False):
        context = self.browser.new_context(base_url=ORIGIN, storage_state=self.states[account],
            viewport={"width": 412 if phone else 1500, "height": 915 if phone else 900},
            device_scale_factor=3 if phone else 1, is_mobile=phone, has_touch=phone, locale="en-GB")
        self.addCleanup(context.close)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught browser error"))
        return page

    def ready(self, page):
        expect(page.get_by_role("navigation", name="Work pages")).to_have_attribute("aria-busy", "false")
        expect(page.locator(".ws-tasks")).to_have_attribute("data-work-observed-at", re.compile(r"^\d{4}-\d{2}-\d{2}T"))

    def rows(self, page):
        return page.locator("[data-work-kind][data-work-id]").evaluate_all("els => els.map(el => ({kind: el.dataset.workKind, id: el.dataset.workId}))")

    def test_01_global_bounded_pages_previous_direct_reload_and_per_view_cursor(self):
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page(phone=phone)
                native_reads = []
                page.on("request", lambda request: native_reads.append(urlsplit(request.url).path) if request.method == "GET" and "/work-" in request.url else None)
                page.goto(f"/projects/{self.project}/tasks?view=list")
                self.ready(page)
                self.assertEqual(native_reads.count(self.root + "/work-view"), 1)
                self.assertEqual(native_reads.count(self.root + "/work-summary"), 0)
                expect(page.get_by_role("navigation", name="Work pages")).to_contain_text("1–50 of 127")
                self.assertEqual(len(self.rows(page)), 50)
                first = self.rows(page)
                page.get_by_role("navigation", name="Work pages").get_by_role("button", name="Next", exact=True).click()
                self.ready(page)
                expect(page.get_by_role("navigation", name="Work pages")).to_contain_text("51–100 of 127")
                second = self.rows(page)
                self.assertEqual(len(second), 50)
                self.assertFalse({row["id"] for row in first} & {row["id"] for row in second})
                url = page.url
                cursor = parse_qs(urlsplit(url).query)["cursor"][0]
                self.assertTrue(cursor)
                pane = page.locator(".pane-scroll").filter(has=page.locator(".ws-tasks"))
                pane.evaluate("el => { el.scrollTop = 460; el.dispatchEvent(new Event('scroll')); }")
                anchor = pane.locator("[data-work-id]").evaluate_all("els => { const pane=els[0].closest('.pane-scroll');const top=pane.getBoundingClientRect().top;const visibleTop=Math.max(top,pane.querySelector('.ws-task-controls').getBoundingClientRect().bottom);const row=els.find(el=>el.getBoundingClientRect().bottom>visibleTop);return [row.dataset.workId,row.getBoundingClientRect().top-top]; }")
                views = page.get_by_role("navigation", name="Task views")
                views.get_by_role("button", name=re.compile("^Blocked")).click()
                self.ready(page)
                self.assertEqual(len(self.rows(page)), 6)
                views.get_by_role("button", name="All", exact=True).click()
                self.ready(page)
                self.assertEqual(parse_qs(urlsplit(page.url).query)["cursor"][0], cursor)
                self.assertEqual(self.rows(page), second)
                restored = pane.locator(f"[data-work-id='{anchor[0]}']").evaluate("el=>el.getBoundingClientRect().top-el.closest('.pane-scroll').getBoundingClientRect().top")
                self.assertLess(abs(restored - anchor[1]), 3)
                page.reload(); self.ready(page)
                self.assertEqual(self.rows(page), second)
                expect(page.get_by_role("navigation", name="Work pages")).to_contain_text("51–100 of 127")
                shot(page, f"bounded-work-page-{'phone' if phone else 'desktop'}")
                pages = page.get_by_role("navigation", name="Work pages")
                pages.get_by_role("button", name="Next", exact=True).click()
                self.ready(page)
                expect(pages).to_contain_text("101–127 of 127")
                third = self.rows(page)
                self.assertEqual(len(third), 27)
                self.assertEqual({(row["kind"], row["id"]) for row in first + second + third}, self.objects)
                self.assertEqual(len({row["id"] for row in first + second + third}), 127)
                expect(pages.get_by_role("button", name="Next", exact=True)).to_be_disabled()
                pages.get_by_role("button", name="Previous", exact=True).click()
                self.ready(page); self.assertEqual(self.rows(page), second)
                page.get_by_role("navigation", name="Work pages").get_by_role("button", name="Previous", exact=True).click()
                self.ready(page); self.assertEqual(self.rows(page), first)
                page.goto(url); self.ready(page); self.assertEqual(self.rows(page), second)

    def test_02_passive_refresh_keeps_keyboard_row_focus_and_private_selection(self):
        page = self.page()
        page.goto(f"/projects/{self.project}/tasks?view=list"); self.ready(page)
        held = []
        def hold(route):
            response = route.fetch()
            self.assertEqual(response.status, 200)
            held.append((route, response))
            page.evaluate("window.__workReadHeld = (window.__workReadHeld || 0) + 1")
        page.route("**/work-view**", hold)
        row = page.locator("[data-work-id]").first.get_by_role("button")
        row.focus()
        original = self.rows(page)
        page.evaluate("window.dispatchEvent(new Event('focus'))")
        expect(page.get_by_role("navigation", name="Work pages")).to_have_attribute("aria-busy", "true")
        page.wait_for_function("window.__workReadHeld === 1")
        self.assertEqual(len(held), 1)
        expect(row).to_be_focused()
        self.assertEqual(self.rows(page), original)
        route, response = held.pop(); route.fulfill(response=response)
        self.ready(page); expect(row).to_be_focused()
        field = page.get_by_label("New task", exact=True)
        field.fill("Check the spare boards before ordering")
        field.evaluate("el => { el.focus(); el.setSelectionRange(6, 18); }")
        page.evaluate("window.dispatchEvent(new Event('focus'))")
        expect(page.get_by_role("navigation", name="Work pages")).to_have_attribute("aria-busy", "true")
        page.wait_for_function("window.__workReadHeld === 2")
        self.assertEqual(field.evaluate("el => [document.activeElement === el, el.selectionStart, el.selectionEnd]"), [True, 6, 18])
        route, response = held.pop(); route.fulfill(response=response)
        self.ready(page)
        self.assertEqual(field.evaluate("el => [document.activeElement === el, el.selectionStart, el.selectionEnd]"), [True, 6, 18])
        expect(field).to_have_value("Check the spare boards before ordering")
        page.unroute("**/work-view**", hold)

    def test_03_late_read_and_required_failure_never_become_empty_work(self):
        page = self.page()
        page.goto(f"/projects/{self.project}/tasks?view=list"); self.ready(page)
        held = []
        def hold_all(route):
            if parse_qs(urlsplit(route.request.url).query).get("group") == ["all"]:
                response = route.fetch(); self.assertEqual(response.status, 200); held.append((route, response))
                page.evaluate("window.__workReadHeld = true")
            else: route.continue_()
        page.route("**/work-view**", hold_all)
        page.get_by_role("navigation", name="Work pages").get_by_role("button", name="Refresh", exact=True).click()
        expect(page.get_by_role("navigation", name="Work pages")).to_have_attribute("aria-busy", "true")
        page.wait_for_function("window.__workReadHeld === true")
        page.get_by_role("navigation", name="Task views").get_by_role("button", name=re.compile("^Blocked")).click()
        self.ready(page); self.assertEqual(len(self.rows(page)), 6)
        route, response = held.pop(); route.fulfill(response=response)
        expect(page.get_by_role("navigation", name="Work pages")).to_contain_text("1–6 of 6")
        self.assertEqual(len(self.rows(page)), 6)
        page.unroute("**/work-view**", hold_all)
        field = page.get_by_label("New task", exact=True); field.fill("Private text survives a failed read")
        page.route("**/work-view**", lambda route: route.fulfill(status=503, json={"code": "WORK_READ_UNAVAILABLE", "error": "Fixture required read unavailable"}))
        page.get_by_role("navigation", name="Work pages").get_by_role("button", name="Refresh", exact=True).click()
        expect(page.get_by_role("heading", name="Work could not be loaded")).to_be_visible()
        expect(page.get_by_role("heading", name="No tasks yet")).to_have_count(0)
        expect(field).to_have_value("Private text survives a failed read")
        self.assertEqual(self.rows(page), [])
        page.unroute("**/work-view**")
        page.get_by_role("button", name="Refresh work", exact=True).click()
        self.ready(page); self.assertEqual(len(self.rows(page)), 6)

    def test_04_cookie_account_change_fences_held_page_and_private_draft(self):
        page = self.page()
        page.goto(f"/projects/{self.project}/tasks?view=list&show=mine"); self.ready(page)
        expect(page.get_by_role("navigation", name="Work pages")).to_contain_text("1–50 of 64")
        field = page.get_by_label("New task", exact=True); field.fill("Ada Kowalska's private draft")
        held = []
        def hold_once(route):
            if not held:
                response = route.fetch(); self.assertEqual(response.status, 200); held.append((route, response))
                page.evaluate("window.__workReadHeld = true")
            else: route.continue_()
        page.route("**/work-view**", hold_once)
        page.get_by_role("navigation", name="Work pages").get_by_role("button", name="Refresh", exact=True).click()
        expect(page.get_by_role("navigation", name="Work pages")).to_have_attribute("aria-busy", "true")
        page.wait_for_function("window.__workReadHeld === true")
        page.context.clear_cookies(); page.context.add_cookies(self.states[1]["cookies"])
        page.evaluate("window.dispatchEvent(new Event('focus'))")
        self.ready(page)
        expect(page.get_by_role("navigation", name="Work pages")).to_contain_text("1–50 of 62")
        expect(field).to_have_value("")
        field.fill("Ada Nowak's separate private draft")
        route, response = held.pop(); route.fulfill(response=response)
        self.ready(page)
        expect(page.get_by_role("navigation", name="Work pages")).to_contain_text("1–50 of 62")
        expect(field).to_have_value("Ada Nowak's separate private draft")
        expected = api(self.contexts[1], "GET", self.root + "/work-view?purpose=tasks&group=all&mine=true&limit=50")
        self.assertEqual(self.rows(page), [{"kind": row["kind"], "id": row["id"]} for row in expected["items"]])
        page.unroute("**/work-view**", hold_once)

    def test_05_open_only_project_state_uses_truthful_totals_on_desktop_and_phone(self):
        owner = self.contexts[0]
        workspace = api(owner, "GET", "/api/v1/workspaces")[0]["id"]
        project = api(owner, "POST", f"/api/v1/workspaces/{workspace}/projects", {"name": "Shelf lamp checklist", "visibility": "restricted"}, 201)["id"]
        task = api(owner, "POST", f"/api/v1/projects/{project}/work", {"title": "Check the wall socket before installation"}, 201)
        for phone in (False, True):
            page = self.page(phone=phone)
            # On the phone the state line belongs to the project's Conversation (#266 PF-2).
            if phone: page.goto(f"/projects/{project}")
            else: page.goto(f"/projects/{project}/tasks?view=list"); self.ready(page)
            if phone:
                state = page.locator(".ws-state-row")
                expect(state).to_contain_text("1 open task")
                expect(state).not_to_contain_text("No decisions or work yet")
                state.tap()
            else:
                # The computer's project state is in Details (#340).
                open_details(page)
            page.locator("#details").get_by_role("button", name=re.compile(r"Open.*Check the wall socket before installation")).click()
            expect(page.locator("#details").get_by_role("heading", name=task["title"], exact=True)).to_be_visible()

    def test_06_keyboard_rows_remain_exposed_below_the_scrolled_controls(self):
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page(phone=phone)
                page.goto(f"/projects/{self.project}/tasks?view=list"); self.ready(page)
                page.locator("[data-work-id]").nth(25).get_by_role("button").focus()
                for _ in range(20):
                    page.keyboard.press("Shift+Tab")
                    exposed = page.evaluate("""() => {
                        const row = document.activeElement;
                        const pane = row.closest('.pane-scroll');
                        const controls = pane?.querySelector('.ws-task-controls');
                        if (!row.closest('[data-work-id]') || !controls) return false;
                        const rect = row.getBoundingClientRect();
                        return rect.top >= controls.getBoundingClientRect().bottom - 1 && rect.bottom <= pane.getBoundingClientRect().bottom + 1;
                    }""")
                    self.assertTrue(exposed, "keyboard-focused native row is exposed below the sticky controls")
