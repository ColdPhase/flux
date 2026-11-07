"""Actual bounded native document reference choices in a Wiki page (Mod-K while writing, #869); emulated viewports are not device acceptance."""
import json
import re
import time
import unittest
import uuid
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import expect, sync_playwright

from app_select import choose
from test_app_shell import ORIGIN, UPSTREAM, shot, start_forwarder
from test_work_pagination import api
from wiki_text import existing_text, has_text, text_of, wait_until_shared


class DocReferenceJourney(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        expect.set_options(timeout=10000)
        cls.ctx = cls.browser.new_context(service_workers="block", base_url=ORIGIN)
        api(cls.ctx, "POST", "/api/auth/sign-up/email", {"name": "Ada Reference", "email": f"references-{uuid.uuid4()}@example.test", "password": "Native references keep their exact identity"})
        ws = api(cls.ctx, "POST", "/api/v1/workspaces", {"name": "Riverside makers"}, 201)
        cls.workspace = ws["id"]
        cls.project = api(cls.ctx, "POST", f"/api/v1/workspaces/{cls.workspace}/projects", {"name": "Library lighting", "visibility": "restricted"}, 201)["id"]
        cls.foreign = api(cls.ctx, "POST", f"/api/v1/workspaces/{cls.workspace}/projects", {"name": "Other library", "visibility": "restricted"}, 201)["id"]
        cls.native = {"work": [], "decision": [], "result": []}
        for kind, path in (("work", "work"), ("decision", "decisions"), ("result", "results")):
            for i in range(105):
                body = {"title": f"Native {kind} reference {i:03d}"}
                if kind == "result":
                    body.update(finding="positive", evidence="Saved native reference evidence")
                cls.native[kind].append(api(cls.ctx, "POST", f"/api/v1/projects/{cls.project}/{path}", body, 201))
            foreign_body = {"title": "Foreign reference must remain elsewhere"}
            if kind == "result":
                foreign_body.update(finding="positive", evidence="Other project's evidence")
            api(cls.ctx, "POST", f"/api/v1/projects/{cls.foreign}/{path}", foreign_body, 201)
        cls.doc = cls.create_doc("Sensor measurements")
        cls.self_doc = cls.create_doc("Reference draft itself")
        cls.sketch = api(cls.ctx, "POST", f"/api/v1/workspaces/{cls.workspace}/sketches", {"title": "Sensor wiring map", "scope": "project", "projectId": cls.project}, 201)
        cls.thread = api(cls.ctx, "POST", f"/api/v1/projects/{cls.project}/conversations", {"body": "Compare the distance sensor beside the window", "clientMessageId": str(uuid.uuid4())}, 201)
        cls.message = api(cls.ctx, "GET", f"/api/v1/conversations/{cls.thread['id']}")["messages"][0]
        cls.user = api(cls.ctx, "GET", "/api/v1/me")["user"]["id"]
        cls.state = cls.ctx.storage_state()

    @classmethod
    def create_doc(cls, title):
        response = cls.ctx.request.post(ORIGIN + f"/api/v1/projects/{cls.project}/docs", headers={"origin": ORIGIN, "idempotency-key": str(uuid.uuid4())}, data={"title": title, "body": "A native document"})
        if response.status != 201:
            raise AssertionError(response.text())
        return response.json()

    @classmethod
    def tearDownClass(cls):
        cls.ctx.close()
        cls.browser.close()
        cls.pw.stop()

    def scene(self, phone=False, self_doc=False):
        ctx = self.browser.new_context(base_url=ORIGIN, storage_state=self.state, viewport={"width": 390 if phone else 1440, "height": 844 if phone else 900}, is_mobile=phone, has_touch=phone, service_workers="block")
        self.addCleanup(ctx.close)
        page = ctx.new_page()
        page.choice_observations = []
        def observe_choices(response):
            q = parse_qs(urlsplit(response.url).query)
            if response.status == 200 and "/work-view?" in response.url and q.get("choice") == ["doc_refs"]:
                page.choice_observations.append({"kind": q["kind"][0], "limit": q.get("limit"), "rows": len(response.json()["items"])})
        page.on("response", observe_choices)
        self.addCleanup(lambda: self.assertTrue(all(read["limit"] == ["50"] and read["rows"] <= 50 for read in page.choice_observations), "actual native response windows stay at most50 rows"))
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught browser errors"))
        # Each scene writes in a page of its own, so the steps never read each other's text.
        doc = self.self_doc if self_doc else self.create_doc(f"Reference notes {uuid.uuid4().hex[:6]}")
        page.doc = doc
        page.goto(f"/projects/{self.project}/docs/{doc['id']}")
        text = existing_text(page)
        wait_until_shared(page)
        if not self_doc:
            text.focus()
            page.keyboard.press("Control+End")
            page.keyboard.insert_text(" WRITING native reference notes\n")
            has_text(text, "WRITING native reference notes")
        return page, text

    def picker(self, page, text):
        # Focus, not a click: a click on a reference's chip opens what it refers to.
        text.focus()
        page.keyboard.press("Control+End")
        page.keyboard.press("Control+k")
        picker = page.get_by_role("dialog", name="Link to something in this space")
        expect(picker.get_by_role("combobox", name="Find a Wiki page, decision, result, task, map or message", exact=True)).to_be_visible()
        return picker

    def test_01_all_native_pages_remain_reachable_and_search_finds_off_page_identity(self):
        for phone in (False, True):
            with self.subTest(phone=phone):
                page, text = self.scene(phone)
                picker = self.picker(page, text)
                query = picker.get_by_role("combobox", name="Find a Wiki page, decision, result, task, map or message", exact=True)
                for kind in ("work", "decision", "result"):
                    choose(picker.get_by_label("Reference type"), kind)
                    query.fill("")
                    seen = set()
                    for count in (50, 50, 5):
                        options = picker.get_by_role("listbox", name="Matches").get_by_role("option")
                        expect(options).to_have_count(count)
                        titles = options.all_text_contents()
                        actual = {re.search(r"Native .* reference \d{3}", title).group(0) for title in titles}
                        self.assertFalse(seen & actual)
                        seen.update(actual)
                        if count != 5:
                            picker.get_by_role("navigation", name="Reference pages").get_by_role("button", name="Next", exact=True).click()
                    self.assertEqual(seen, {item["title"] for item in self.native[kind]})
                    picker.get_by_role("navigation", name="Reference pages").get_by_role("button", name="Previous", exact=True).click()
                    expect(picker.get_by_role("listbox", name="Matches").get_by_role("option")).to_have_count(50)
                    query.fill(self.native[kind][0]["title"])
                    expect(picker.get_by_role("listbox", name="Matches").get_by_role("option")).to_have_count(1)
                    expect(picker.get_by_role("listbox", name="Matches").get_by_role("option")).to_contain_text(self.native[kind][0]["title"])
                    query.fill("Foreign reference")
                    expect(picker.get_by_role("listbox", name="Matches").get_by_role("option")).to_have_count(0)
                    expect(picker).to_contain_text("Nothing matches")
                query.fill("")
                choose(picker.get_by_label("Reference type"), "work")
                expect(picker.get_by_role("listbox", name="Matches").get_by_role("option")).to_have_count(50)
                query.focus()
                for _ in range(45):
                    query.press("ArrowDown")
                selected = picker.locator('[role="option"][aria-selected="true"]')
                self.assertTrue(selected.evaluate("el => { const row=el.getBoundingClientRect(), list=el.parentElement.getBoundingClientRect(); return row.top>=list.top-1 && row.bottom<=list.bottom+1; }"), "the keyboard-selected option stays exposed inside its own list")
                self.assertEqual({read["kind"] for read in page.choice_observations}, {"work", "decision", "result"})
                if phone: expect(picker.get_by_text("Tap a match to insert its link.", exact=True)).to_be_in_viewport()
                shot(page, f"155-doc-reference-work-{'phone' if phone else 'desktop'}")
                query.press("Enter")
                has_text(text, "WRITING native reference notes")
                self.assertRegex(text_of(text), r"flux:work/[0-9a-f-]{36}")

    def test_02_six_reference_kinds_insert_exact_ids_and_persist_native_mentions(self):
        for phone in (False, True):
            page, text = self.scene(phone)
            expected = [("doc", self.doc), ("decision", self.native["decision"][0]), ("result", self.native["result"][0]), ("work", self.native["work"][0]), ("sketch", self.sketch), ("message", {"id": self.message["id"], "title": self.message["body"]})]
            for kind, item in expected:
                picker = self.picker(page, text)
                choose(picker.get_by_label("Reference type"), kind)
                query = picker.get_by_role("combobox", name="Find a Wiki page, decision, result, task, map or message", exact=True)
                query.fill(item["title"])
                expect(picker.get_by_role("listbox", name="Matches").get_by_role("option")).to_have_count(1)
                if phone: picker.get_by_role("listbox", name="Matches").get_by_role("option").tap()
                else: query.press("Enter")
                has_text(text, f"flux:{kind}/{item['id']}")
            # The version saves by itself once the writing rests; its links are the page's mentions.
            saved_id = page.doc["id"]
            deadline = time.monotonic() + 30
            while True:
                stored = api(page.context, "GET", f"/api/v1/docs/{saved_id}")
                if all(f"flux:{kind}/{item['id']}" in stored["body"] for kind, item in expected) or time.monotonic() > deadline:
                    break
                time.sleep(0.25)
            self.assertIn("WRITING native reference notes", stored["body"])
            mentions = {(link["to"]["type"], link["to"]["id"]) for link in stored["links"] if link["from"]["id"] == saved_id and link["role"] == "mentions"}
            self.assertTrue({(kind, item["id"]) for kind, item in expected}.issubset(mentions))
        page, text = self.scene(self_doc=True)
        picker = self.picker(page, text)
        choose(picker.get_by_label("Reference type"), "doc")
        picker.get_by_role("combobox", name="Find a Wiki page, decision, result, task, map or message", exact=True).fill(self.self_doc["title"])
        expect(picker.get_by_role("listbox", name="Matches").get_by_role("option")).to_have_count(0)

    def test_03_required_failure_retries_without_publishing_partial_matches_or_erasing_editor(self):
        for phone in (False, True):
            with self.subTest(phone=phone):
                page, text = self.scene(phone)
                fault = {"on": True}
                def intercept(route):
                    query = parse_qs(urlsplit(route.request.url).query)
                    if fault["on"] and query.get("choice") == ["doc_refs"] and query.get("kind") == ["work"]:
                        route.fulfill(status=503, content_type="application/json", body=json.dumps({"error": {"code": "UNAVAILABLE"}}))
                    else:
                        route.continue_()
                page.route("**/work-view?**", intercept)
                picker = self.picker(page, text)
                expect(picker.get_by_role("alert")).to_contain_text("Could not load")
                expect(picker.get_by_role("listbox", name="Matches").get_by_role("option")).to_have_count(0)
                query = picker.get_by_role("combobox", name="Find a Wiki page, decision, result, task, map or message", exact=True)
                query.fill("Native work reference 000")
                expect(picker.get_by_role("alert")).to_be_visible()
                fault["on"] = False
                picker.get_by_role("button", name="Retry objects").click()
                expect(picker.get_by_role("listbox", name="Matches").get_by_role("option")).to_have_count(1)
                expect(query).to_have_value("Native work reference 000")
                has_text(text, "WRITING native reference notes")
                self.assertNotIn("flux:work/", text_of(text), "nothing was inserted")

    def test_04_delayed_reference_search_describes_its_wait_and_keeps_the_text(self):
        for phone in (False, True):
            with self.subTest(phone=phone):
                page, text = self.scene(phone)
                picker = self.picker(page, text)
                target = self.native["work"][3]
                held = []
                def hold(route):
                    query = parse_qs(urlsplit(route.request.url).query)
                    if query.get("choice") == ["doc_refs"] and query.get("kind") == ["work"] and query.get("q") == [target["title"]]:
                        response = route.fetch()
                        self.assertEqual(response.status, 200)
                        held.append((route, response))
                        page.evaluate("window.loadingProjectObjectsHeld = true")
                    else:
                        route.continue_()
                page.route(f"**/api/v1/projects/{self.project}/work-view?**", hold)
                self.addCleanup(lambda page=page: page.unroute_all(behavior="ignoreErrors"))
                query = picker.get_by_role("combobox", name="Find a Wiki page, decision, result, task, map or message", exact=True)
                query.fill(target["title"])
                waiting = picker.locator("p.doc-muted.doc-picker__empty[aria-busy='true']")
                expect(waiting).to_have_text("Finding space objects…")
                expect(waiting).to_be_visible()
                expect(waiting).to_have_attribute("class", "doc-muted doc-picker__empty")
                expect(waiting).to_have_attribute("aria-busy", "true")
                expect(picker.get_by_role("listbox", name="Matches").get_by_role("option")).to_have_count(0)
                has_text(text, "WRITING native reference notes")
                # The loading state remains until the real, matching native read completes.
                page.wait_for_function("window.loadingProjectObjectsHeld === true")
                self.assertEqual(len(held), 1)
                shot(page, f"323-link-picker-loading-{'phone' if phone else 'desktop'}")
                for route, response in held:
                    route.fulfill(response=response)
                page.unroute_all(behavior="wait")
                match = picker.get_by_role("listbox", name="Matches").get_by_role("option")
                expect(match).to_have_count(1)
                expect(match).to_contain_text(target["title"])
                expect(waiting).to_have_count(0)
                has_text(text, "WRITING native reference notes")
