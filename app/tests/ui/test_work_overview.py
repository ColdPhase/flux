"""Native Overview object/relationship windows; full parent/details migration stays open."""
from __future__ import annotations

import json
import re
import unittest
import uuid
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import expect, sync_playwright
from test_app_shell import ORIGIN, UPSTREAM, shot, start_forwarder
from test_work_pagination import api


class OverviewWorkJourney(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if UPSTREAM: start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start(); cls.browser = cls.pw.chromium.launch()
        expect.set_options(timeout=10000)
        cls.context = cls.browser.new_context(base_url=ORIGIN)
        api(cls.context, "POST", "/api/auth/sign-up/email", {"name": "Ada Kowalska", "email": f"overview-{uuid.uuid4()}@example.test", "password": "compare the library measurements before ordering"})
        cls.user = api(cls.context, "GET", "/api/v1/me")["user"]["id"]
        ws = api(cls.context, "POST", "/api/v1/workspaces", {"name": "Riverside makers"}, 201)["id"]
        cls.project = api(cls.context, "POST", f"/api/v1/workspaces/{ws}/projects", {"name": "Library lighting measurements", "visibility": "restricted"}, 201)["id"]
        cls.root = f"/api/v1/projects/{cls.project}"
        cls.material = api(cls.context, "POST", cls.root + "/materials", {"title": "Shield measurement notes", "body": "First measured cable and shield", "clientMutationId": str(uuid.uuid4())}, 201)["materialId"]
        api(cls.context, "PATCH", f"/api/v1/materials/{cls.material}", {"title": "Shield measurement notes, revised", "body": "Second measured cable and shield", "expectedVersion": 1, "clientMutationId": str(uuid.uuid4())})
        thread = api(cls.context, "POST", cls.root + "/conversations", {"body": "Compare the earliest measurements before ordering another sensor.", "source": {"materialId": cls.material, "version": 1}, "clientMessageId": str(uuid.uuid4())}, 201)
        cls.conversation = thread["id"]; cls.m0 = thread["messages"][0]["id"]
        cls.m1 = api(cls.context, "POST", f"/api/v1/conversations/{cls.conversation}/messages", {"body": "Keep both low-light runs linked to their original notes.", "clientMessageId": str(uuid.uuid4())}, 201)["id"]
        for index in range(139):
            api(cls.context, "POST", f"/api/v1/conversations/{cls.conversation}/messages", {"body": f"Measurement {index + 3}: compare the shield and standby current.", "clientMessageId": str(uuid.uuid4())}, 201)
        cls.sketch = api(cls.context, "POST", f"/api/v1/workspaces/{ws}/sketches", {"title": "Sensing options", "scope": "project", "projectId": cls.project}, 201)["id"]
        cls.thought = api(cls.context, "POST", f"/api/v1/sketches/{cls.sketch}/thoughts", {"text": "Try the same shield with both low-light runs", "x": 0, "y": 0}, 201)["thought"]["id"]
        sources = [{"type": "message", "id": cls.m0}, {"type": "message", "id": cls.m1}, {"type": "material", "id": cls.material, "version": 1}, {"type": "material", "id": cls.material, "version": 2}]
        for index in range(64):
            api(cls.context, "POST", cls.root + "/work", {"title": f"Compare the library low-light shield measurements · {index + 1:03d}", "owner": {"kind": "human", "id": cls.user}, "sources": sources}, 201)
        api(cls.context, "POST", cls.root + "/work", {"title": "Related notes; no source relationship", "related": [{"type": "message", "id": cls.m0}]}, 201)
        old = api(cls.context, "POST", cls.root + "/decisions", {"title": "Try the camera", "sources": [sources[0]]}, 201)
        api(cls.context, "POST", f"/api/v1/decisions/{old['id']}/accept", {"expectedVersion": 1})
        current = api(cls.context, "POST", cls.root + "/decisions", {"title": "Use the distance sensor", "supersedes": old["id"], "sources": [sources[0]]}, 201)
        api(cls.context, "POST", f"/api/v1/decisions/{current['id']}/accept", {"expectedVersion": 1, "stillApplies": [], "park": []})
        thought = {"type": "thought", "id": cls.thought}
        api(cls.context, "POST", cls.root + "/decisions", {"title": "Keep the manual off switch", "sources": [sources[0], thought]}, 201)
        result = api(cls.context, "POST", cls.root + "/results", {"title": "The shield reduced noise in both runs", "finding": "positive", "sources": [sources[0], thought, sources[2]]}, 201)
        cls.doc = api(cls.context, "POST", cls.root + "/docs", {"title": "What we learned about shielding", "from": {"type": "result", "id": result["id"]}}, 201)["id"]
        cls.state = cls.context.storage_state()
        cls.native = cls.records()
        cls.expected = {(kind, item["id"]) for kind, items in cls.native.items() for item in items["items"]}
        cls.edges = {link["id"] for items in cls.native.values() for item in items["items"] for link in item["links"]}
        cls.before = json.dumps(cls.native, sort_keys=True)

    @classmethod
    def records(cls):
        return {kind: api(cls.context, "GET", cls.root + f"/{plural}?limit=100") for kind, plural in (("work", "work"), ("decision", "decisions"), ("result", "results"))}

    @classmethod
    def tearDownClass(cls):
        try:
            if json.dumps(cls.records(), sort_keys=True) != cls.before: raise AssertionError("Overview reads changed native work/decision/result fields or links")
        finally: cls.browser.close(); cls.pw.stop()

    def page(self, phone=False):
        context = self.browser.new_context(base_url=ORIGIN, storage_state=self.state, viewport={"width": 412 if phone else 1500, "height": 915 if phone else 900}, device_scale_factor=3 if phone else 1, is_mobile=phone, has_touch=phone, locale="en-GB")
        self.addCleanup(context.close)
        page = context.new_page(); errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught browser errors"))
        self.addCleanup(lambda: page.unroute_all(behavior="ignoreErrors"))
        return page

    def ready(self, page):
        overview = page.locator(".ov")
        expect(overview).to_have_attribute("data-overview-phase", "ready")
        expect(overview).to_have_attribute("data-overview-relations-phase", "ready")
        return overview

    def open(self, page):
        page.goto(f"/projects/{self.project}/conversations/{self.conversation}")
        expect(page.get_by_label("Reply", exact=True)).to_be_visible()
        page.locator("header.top").get_by_role("button", name="Details", exact=True).click()
        return self.ready(page)

    def identities(self, page):
        return page.locator(".ov [data-work-id]").evaluate_all("els=>els.map(el=>[el.dataset.workKind,el.dataset.workId])")

    def test_01_all_native_object_and_relation_pages_are_reachable_on_desktop_and_phone(self):
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page(phone); observed = []
                def collect(response):
                    if response.status == 200 and ("/work-relations?" in response.url or "/work-associations?" in response.url and parse_qs(urlsplit(response.url).query).get("conversationId")):
                        observed.append((response.url, response.json()))
                page.on("response", collect)
                ov = self.open(page)
                objects = ov.get_by_role("navigation", name="Overview object pages")
                links = ov.get_by_role("navigation", name="Overview relation pages")
                expect(objects).to_contain_text("1–50 of 69 objects")
                expect(ov).to_contain_text("Related notes; no source relationship")
                first = self.identities(page); self.assertEqual(len(first), 50)
                union = set(); seen = set()
                for object_page in range(2):
                    while True:
                        self.ready(page)
                        latest = [body for url, body in observed if "/work-relations?" in url][-1]
                        self.assertLessEqual(len(latest["items"]), 50)
                        union.update(link["id"] for link in latest["items"])
                        seen.update(tuple(ref) for ref in self.identities(page))
                        if not latest["nextCursor"]: break
                        links.get_by_role("button", name="Next", exact=True).click()
                    if object_page == 0:
                        objects.get_by_role("button", name="Next", exact=True).click(); self.ready(page)
                        expect(objects).to_contain_text("51–69 of 69 objects")
                        expect(links).to_contain_text("1–50 of")
                        # Both pinned native versions remain distinct destinations.
                        for version in (1, 2): expect(ov.locator(f'a[href="/materials/{self.material}/versions/{version}"]')).to_have_count(1)
                self.assertEqual(seen, self.expected); self.assertEqual(union, self.edges)
                self.assertLessEqual(len(self.identities(page)), 50)
                # Deep document/thought relations are reached on their native edge page.
                expect(ov.locator(f'a[href="/projects/{self.project}/map/{self.sketch}"]').filter(has_text="Try the same shield")).to_have_count(1)
                expect(ov.locator(f'a[href="/projects/{self.project}/docs/{self.doc}"]')).to_have_count(1)
                shot(page, f"bounded-overview-mixed-{'phone' if phone else 'desktop'}")
                links.get_by_role("button", name="Previous", exact=True).click(); self.ready(page)
                expect(links).to_contain_text("1–50 of")
                objects.get_by_role("button", name="Previous", exact=True).click(); self.ready(page)
                self.assertEqual(self.identities(page), first)
                self.assertTrue(all(len(body["items"]) <= 50 for _,body in observed))
                self.assertTrue(all(len(parse_qs(urlsplit(url).query)["objects"][0].split(',')) <= 50 for url,_ in observed if "/work-relations?" in url))
                self.assertTrue(all(body["sourceTotal"] == 141 and len(body["sources"]) == 100 for url,body in observed if "/work-associations?" in url), "native conversation selector covers messages outside the source-count and loaded-text windows")
                shot(page, f"bounded-overview-{'phone' if phone else 'desktop'}")
                self.assertLessEqual(page.locator("body").evaluate("el=>el.scrollWidth"), 412 if phone else 1500)

    def test_02_required_relation_failure_is_unavailable_then_retries_without_touching_private_reply(self):
        page = self.page(); ov = self.open(page)
        field = page.get_by_label("Reply", exact=True); field.fill("Keep this reply while checking the sources")
        links = ov.get_by_role("navigation", name="Overview relation pages")
        page.route("**/work-relations?**", lambda route: route.fulfill(status=503, json={"code": "WORK_READ_UNAVAILABLE", "error": "Fixture unavailable read"}))
        links.get_by_role("button", name="Refresh", exact=True).click()
        expect(ov.get_by_role("alert")).to_contain_text("Object links could not be loaded")
        expect(ov).not_to_contain_text("Nothing linked yet")
        expect(ov).not_to_contain_text("No docs yet")
        self.assertEqual(len(self.identities(page)), 50)
        expect(field).to_have_value("Keep this reply while checking the sources")
        page.unroute("**/work-relations?**")
        ov.get_by_role("button", name="Refresh object links", exact=True).click(); self.ready(page)
        expect(ov.get_by_role("alert")).to_have_count(0)

    def test_03_held_old_relations_cannot_replace_a_new_object_window_or_erase_selection(self):
        page = self.page(); ov = self.open(page); held = []
        def hold(route):
            if parse_qs(urlsplit(route.request.url).query).get("cursor"):
                response = route.fetch(); self.assertEqual(response.status, 200); held.append((route,response)); page.evaluate("window.__overviewHeld=true")
            else: route.continue_()
        page.route("**/work-relations?**", hold)
        ov.get_by_role("navigation", name="Overview relation pages").get_by_role("button", name="Next", exact=True).click()
        page.wait_for_function("window.__overviewHeld===true")
        ov.get_by_role("navigation", name="Overview object pages").get_by_role("button", name="Next", exact=True).click(); self.ready(page)
        field = page.get_by_label("Reply", exact=True); field.fill("Keep the newest private selection")
        field.evaluate("el=>{el.focus();el.setSelectionRange(5,17);}")
        route,response=held.pop(); route.fulfill(response=response)
        expect(ov.get_by_role("navigation", name="Overview relation pages")).to_contain_text("1–50 of")
        expect(ov.get_by_role("navigation", name="Overview object pages")).to_contain_text("51–69 of 69 objects")
        self.assertEqual(field.evaluate("el=>[document.activeElement===el,el.selectionStart,el.selectionEnd]"), [True,5,17])
        page.unroute("**/work-relations?**", hold)

    def test_04_details_of_an_older_loaded_message_keeps_exact_source_scope_and_pinned_citation(self):
        page = self.page(); page.goto(f"/projects/{self.project}/conversations/{self.conversation}")
        earlier = page.get_by_role("button", name="Load earlier messages", exact=True)
        for _ in range(2): earlier.click(); expect(earlier).to_be_enabled()
        message = page.locator(f"#message-{self.m0}"); expect(message).to_have_count(1)
        message.scroll_into_view_if_needed(); message.hover()
        message.get_by_role("button", name="Details of this message", exact=True).click()
        ov = self.ready(page)
        expect(ov.get_by_role("heading", name="Message from you", exact=True)).to_be_visible()
        expect(ov.locator(".ov-quote")).to_have_text("Compare the earliest measurements before ordering another sensor.")
        expect(ov.get_by_role("region", name="Made from this message")).to_contain_text("Related notes; no source relationship")
        expect(ov.locator(f'a[href="/materials/{self.material}/versions/1"]')).to_have_count(1)
        expect(ov.get_by_role("navigation", name="Overview object pages")).to_contain_text("1–50 of 69 objects")
        ov.get_by_role("button", name="This conversation", exact=True).click(); self.ready(page)
        expect(ov.get_by_role("region", name="Linked in this conversation")).to_be_visible()
