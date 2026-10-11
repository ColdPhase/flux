"""Actual bounded native document reference choices; emulated viewports are not device acceptance."""
import json
import re
import unittest
import uuid
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import expect, sync_playwright
from test_app_shell import ORIGIN, UPSTREAM, shot, start_forwarder
from test_work_pagination import api


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
        cls.other = cls.browser.new_context(service_workers="block", base_url=ORIGIN)
        email = f"reference-peer-{uuid.uuid4()}@example.test"
        api(cls.other, "POST", "/api/auth/sign-up/email", {"name": "Jonas Reference", "email": email, "password": "Private reference drafts belong to one person"})
        cls.other_user = api(cls.other, "GET", "/api/v1/me")["user"]["id"]
        api(cls.ctx, "POST", f"/api/v1/workspaces/{cls.workspace}/members", {"email": email, "role": "member"}, 201)
        api(cls.ctx, "POST", f"/api/v1/projects/{cls.project}/grants", {"principal": {"kind": "human", "id": cls.other_user}, "role": "contributor"}, 201)
        cls.other_state = cls.other.storage_state()

    @classmethod
    def create_doc(cls, title):
        response = cls.ctx.request.post(ORIGIN + f"/api/v1/projects/{cls.project}/docs", headers={"origin": ORIGIN, "idempotency-key": str(uuid.uuid4())}, data={"title": title, "body": "A native document", "state": "draft"})
        if response.status != 201:
            raise AssertionError(response.text())
        return response.json()

    @classmethod
    def tearDownClass(cls):
        cls.other.close()
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
        path = f"{self.self_doc['id']}/edit" if self_doc else "new"
        page.goto(f"/projects/{self.project}/docs/{path}")
        text = page.get_by_label("Text (Markdown)")
        text.fill("PRIVATE-DRAFT of native reference notes\n")
        return page, text

    def picker(self, page, text):
        text.focus()
        text.press("Control+End")
        text.press("Control+k")
        picker = page.get_by_role("dialog", name="Link to something in this project")
        expect(picker.get_by_role("combobox", name="Find a doc, decision, result, work, sketch or message", exact=True)).to_be_visible()
        return picker

    def test_01_all_native_pages_remain_reachable_and_search_finds_off_page_identity(self):
        for phone in (False, True):
            with self.subTest(phone=phone):
                page, text = self.scene(phone)
                picker = self.picker(page, text)
                query = picker.get_by_role("combobox", name="Find a doc, decision, result, work, sketch or message", exact=True)
                for kind in ("work", "decision", "result"):
                    picker.get_by_label("Reference type").select_option(kind)
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
                picker.get_by_label("Reference type").select_option("work")
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
                expect(text).to_have_value(re.compile("PRIVATE-DRAFT"))
                expect(text).to_have_value(re.compile(r"flux:work/[0-9a-f-]{36}"))

    def test_02_six_reference_kinds_insert_exact_ids_and_persist_native_mentions(self):
        for phone in (False, True):
            page, text = self.scene(phone)
            expected = [("doc", self.doc), ("decision", self.native["decision"][0]), ("result", self.native["result"][0]), ("work", self.native["work"][0]), ("sketch", self.sketch), ("message", {"id": self.message["id"], "title": self.message["body"]})]
            for kind, item in expected:
                picker = self.picker(page, text)
                picker.get_by_label("Reference type").select_option(kind)
                query = picker.get_by_role("combobox", name="Find a doc, decision, result, work, sketch or message", exact=True)
                query.fill(item["title"])
                expect(picker.get_by_role("listbox", name="Matches").get_by_role("option")).to_have_count(1)
                if phone: picker.get_by_role("listbox", name="Matches").get_by_role("option").tap()
                else: query.press("Enter")
                expect(text).to_have_value(re.compile(re.escape(f"flux:{kind}/{item['id']}")))
            page.get_by_label("Title", exact=True).fill(f"Native references saved {'phone' if phone else 'desktop'}")
            text.press("Control+s")
            expect(page.get_by_role("heading", level=2, name=re.compile("Native references saved"))).to_be_visible()
            saved_id = urlsplit(page.url).path.split('/')[-1]
            stored = api(page.context, "GET", f"/api/v1/docs/{saved_id}")
            self.assertIn("PRIVATE-DRAFT", stored["body"])
            mentions = {(link["to"]["type"], link["to"]["id"]) for link in stored["links"] if link["from"]["id"] == saved_id and link["role"] == "mentions"}
            self.assertTrue({(kind, item["id"]) for kind, item in expected}.issubset(mentions))
        page, text = self.scene(self_doc=True)
        picker = self.picker(page, text)
        picker.get_by_label("Reference type").select_option("doc")
        picker.get_by_role("combobox", name="Find a doc, decision, result, work, sketch or message", exact=True).fill(self.self_doc["title"])
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
                query = picker.get_by_role("combobox", name="Find a doc, decision, result, work, sketch or message", exact=True)
                query.fill("Native work reference 000")
                expect(picker.get_by_role("alert")).to_be_visible()
                fault["on"] = False
                picker.get_by_role("button", name="Retry objects").click()
                expect(picker.get_by_role("listbox", name="Matches").get_by_role("option")).to_have_count(1)
                expect(query).to_have_value("Native work reference 000")
                expect(text).to_have_value("PRIVATE-DRAFT of native reference notes\n")

    def assert_account(self, page, name, phone):
        if phone: page.get_by_role("button", name="Open navigation", exact=True).click()
        # In the phone drawer the account row leads to Settings (#266 PF-5).
        role, suffix = ("link", "settings and sign out") if phone else ("button", "account and sign out")
        expect(page.get_by_role(role, name=re.compile(f"^{name} .*{suffix}"))).to_be_visible()
        if phone: page.get_by_role("button", name="Close navigation", exact=True).click()

    def expect_new_editor(self, page, project_name):
        # Main's #197 wiki pane splits the old "New doc · everyone in <project> can read it" line:
        # the bar says it is a new page and the crumb names the project's audience.
        expect(page.locator(".wiki-bar__meta").get_by_text("New page", exact=True)).to_be_visible()
        expect(page.locator(".wiki-doc__crumb")).to_have_text(f"Everyone in {project_name} can read it")

    def navigate_editor(self, page, project, suffix="new"):
        # Actual browser history navigation observed by React Router, preserving the
        # document and component position rather than reloading away the regression.
        page.evaluate("path => { history.pushState({...history.state, key: crypto.randomUUID(), idx: (history.state?.idx ?? 0)+1}, '', path); dispatchEvent(new PopStateEvent('popstate')); }", f"/projects/{project}/docs/{suffix}")
        expect(page.get_by_label("Text (Markdown)")).to_be_visible()

    def test_04_private_draft_follows_project_and_document_scope_without_document_reload(self):
        for phone in (False, True):
            with self.subTest(phone=phone):
                page, text = self.scene(phone)
                page.evaluate("window.privateDraftDocument = crypto.randomUUID()")
                marker = page.evaluate("window.privateDraftDocument")
                self.navigate_editor(page, self.foreign)
                self.expect_new_editor(page, "Other library")
                expect(text).to_have_value("")
                text.fill("PRIVATE-DRAFT in another project")
                self.navigate_editor(page, self.project)
                self.expect_new_editor(page, "Library lighting")
                expect(text).to_have_value("PRIVATE-DRAFT of native reference notes\n")
                self.navigate_editor(page, self.project, f"{self.self_doc['id']}/edit")
                expect(page.get_by_label("Title", exact=True)).to_have_value(self.self_doc["title"])
                expect(text).to_have_value("A native document")
                text.fill("PRIVATE-DRAFT of an existing document")
                self.navigate_editor(page, self.project)
                self.expect_new_editor(page, "Library lighting")
                expect(text).to_have_value("PRIVATE-DRAFT of native reference notes\n")
                self.assertEqual(page.evaluate("window.privateDraftDocument"), marker)

    def test_05_account_revalidation_does_not_copy_or_insert_into_another_private_draft(self):
        for phone in (False, True):
            with self.subTest(phone=phone):
                page, text = self.scene(phone)
                picker = self.picker(page, text)
                picker.get_by_label("Reference type").select_option("work")
                expect(picker.get_by_role("listbox", name="Matches").get_by_role("option")).to_have_count(50)
                held = []
                def hold_old_account(route):
                    q = parse_qs(urlsplit(route.request.url).query)
                    if not held and q.get("kind") == ["work"] and q.get("q") == [self.native["work"][1]["title"]]:
                        response = route.fetch(); self.assertEqual(response.status, 200)
                        held.append((route, response)); page.evaluate("window.oldReferenceHeld = true")
                    else: route.continue_()
                page.route("**/work-view?**", hold_old_account)
                self.addCleanup(lambda page=page: page.unroute_all(behavior="ignoreErrors"))
                picker.get_by_role("combobox", name="Find a doc, decision, result, work, sketch or message", exact=True).fill(self.native["work"][1]["title"])
                page.wait_for_function("window.oldReferenceHeld === true")
                page.context.clear_cookies(); page.context.add_cookies(self.other_state["cookies"])
                self.navigate_editor(page, self.project)
                self.assert_account(page, "Jonas Reference", phone)
                expect(text).to_have_value("")
                expect(picker).to_have_count(0)
                other_key = f"flux:doc-edit:{self.other_user}:new:{self.project}"
                self.assertIsNone(page.evaluate("key => sessionStorage.getItem(key)", other_key))
                text.fill("PRIVATE-DRAFT belonging only to Jonas")
                picker = self.picker(page, text)
                picker.get_by_label("Reference type").select_option("work")
                query = picker.get_by_role("combobox", name="Find a doc, decision, result, work, sketch or message", exact=True)
                query.fill(self.native["work"][0]["title"])
                expect(picker.get_by_role("listbox", name="Matches").get_by_role("option")).to_have_count(1)
                route, response = held.pop(); route.fulfill(response=response)
                page.wait_for_function("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))")
                expect(picker.get_by_role("listbox", name="Matches")).to_contain_text(self.native["work"][0]["title"])
                expect(picker.get_by_role("listbox", name="Matches")).not_to_contain_text(self.native["work"][1]["title"])
                query.press("Enter")
                expect(text).to_have_value(re.compile("PRIVATE-DRAFT belonging only to Jonas"))
                expect(text).not_to_have_value(re.compile("PRIVATE-DRAFT of native reference notes"))
                page.context.clear_cookies(); page.context.add_cookies(self.state["cookies"])
                self.navigate_editor(page, self.project)
                self.assert_account(page, "Ada Reference", phone)
                expect(text).to_have_value("PRIVATE-DRAFT of native reference notes\n")

    def test_06_delayed_query_does_not_revive_stale_native_results_after_aba(self):
        for phone in (False, True):
            with self.subTest(phone=phone):
                item = api(self.ctx, "POST", f"/api/v1/projects/{self.project}/work", {"title": "Only the original shield measurement"}, 201)
                page, text = self.scene(phone)
                picker = self.picker(page, text)
                picker.get_by_label("Reference type").select_option("work")
                query = picker.get_by_role("combobox", name="Find a doc, decision, result, work, sketch or message", exact=True)
                held = []
                def hold(route):
                    q = parse_qs(urlsplit(route.request.url).query)
                    if not held and q.get("q") == [item["title"]]:
                        response = route.fetch(); self.assertEqual(response.status, 200)
                        held.append((route, response)); page.evaluate("window.oldQueryHeld = true")
                    else: route.continue_()
                page.route("**/work-view?**", hold)
                self.addCleanup(lambda page=page: page.unroute_all(behavior="ignoreErrors"))
                query.fill(item["title"]); page.wait_for_function("window.oldQueryHeld === true")
                api(self.ctx, "PATCH", f"/api/v1/work/{item['id']}", {"title": "Current shield measurement", "expectedVersion": item["version"]})
                query.fill(self.native["work"][1]["title"])
                expect(picker.get_by_role("listbox", name="Matches").get_by_role("option")).to_have_count(1)
                query.fill(item["title"])
                expect(picker).to_contain_text("Nothing matches")
                route, response = held.pop(); route.fulfill(response=response)
                page.wait_for_function("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))")
                expect(picker.get_by_role("listbox", name="Matches").get_by_role("option")).to_have_count(0)
                expect(text).to_have_value("PRIVATE-DRAFT of native reference notes\n")
                self.assertEqual(api(self.ctx, "GET", f"/api/v1/work/{item['id']}")["title"], "Current shield measurement")

    def test_07_retired_save_keeps_its_retry_key_and_cannot_navigate_the_new_scope(self):
        for phone in (False, True):
            with self.subTest(phone=phone):
                page, text = self.scene(phone)
                title = f"A document saved once across an editor scope change {phone}"
                page.get_by_label("Title", exact=True).fill(title)
                held = []
                def hold(route):
                    if route.request.method == "POST" and not held:
                        response = route.fetch(); self.assertEqual(response.status, 201)
                        held.append((route, response)); page.evaluate("window.oldSaveHeld = true")
                    else: route.continue_()
                page.route(f"**/api/v1/projects/{self.project}/docs", hold)
                text.press("Control+s"); page.wait_for_function("window.oldSaveHeld === true")
                key = f"flux:doc-edit:{self.user}:new:{self.project}"
                attempt = page.evaluate("key => JSON.parse(sessionStorage.getItem(key)).attempt", key)
                self.navigate_editor(page, self.foreign)
                self.expect_new_editor(page, "Other library")
                expect(text).to_have_value("")
                text.fill("PRIVATE-DRAFT of a new project while an old save completes")
                route, response = held.pop()
                with page.expect_request_finished(lambda request: request.method == "POST" and request.url.endswith(f"/{self.project}/docs")):
                    route.fulfill(response=response)
                self.assertEqual(urlsplit(page.url).path, f"/projects/{self.foreign}/docs/new")
                expect(text).to_have_value("PRIVATE-DRAFT of a new project while an old save completes")
                self.assertEqual(page.evaluate("key => JSON.parse(sessionStorage.getItem(key)).attempt", key), attempt)
                self.navigate_editor(page, self.project)
                expect(page.get_by_label("Title", exact=True)).to_have_value(title)
                expect(text).to_have_value("PRIVATE-DRAFT of native reference notes\n")
                self.assertEqual(page.evaluate("key => JSON.parse(sessionStorage.getItem(key)).attempt", key), attempt)
                page.unroute(f"**/api/v1/projects/{self.project}/docs", hold)
                submitted = []
                page.on("request", lambda request: submitted.append(request.headers.get("idempotency-key")) if request.method == "POST" and request.url.endswith(f"/{self.project}/docs") else None)
                text.press("Control+s")
                expect(page.get_by_role("heading", level=2, name=title)).to_be_visible()
                self.assertEqual(submitted, [attempt])
                docs = api(self.ctx, "GET", f"/api/v1/projects/{self.project}/docs?limit=100")["items"]
                self.assertEqual(sum(doc["title"] == title for doc in docs), 1)

    def test_08_old_save_cannot_redirect_during_the_destination_loader(self):
        for phone in (False, True):
            with self.subTest(phone=phone):
                page, text = self.scene(phone)
                page.get_by_label("Title", exact=True).fill(f"Saved before destination loaders finish {phone}")
                saves, projects = [], []
                def hold_save(route):
                    if route.request.method == "POST":
                        response = route.fetch(); self.assertEqual(response.status, 201)
                        saves.append((route, response)); page.evaluate("window.saveBeforeNavigationHeld = true")
                    else: route.continue_()
                def hold_project(route):
                    response = route.fetch(); self.assertEqual(response.status, 200)
                    projects.append((route, response)); page.evaluate("count => window.destinationLoadersHeld = count", len(projects))
                page.route(f"**/api/v1/projects/{self.project}/docs", hold_save)
                page.route(f"**/api/v1/projects/{self.foreign}", hold_project)
                self.addCleanup(lambda page=page: page.unroute_all(behavior="ignoreErrors"))
                text.press("Control+s"); page.wait_for_function("window.saveBeforeNavigationHeld === true")
                key = f"flux:doc-edit:{self.user}:new:{self.project}"
                attempt = page.evaluate("key => JSON.parse(sessionStorage.getItem(key)).attempt", key)
                self.navigate_editor(page, self.foreign)
                page.wait_for_function("window.destinationLoadersHeld === 2")
                route, response = saves.pop()
                with page.expect_request_finished(lambda request: request.method == "POST" and request.url.endswith(f"/{self.project}/docs")):
                    route.fulfill(response=response)
                page.wait_for_function("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))")
                self.assertEqual(urlsplit(page.url).path, f"/projects/{self.foreign}/docs/new")
                self.assertEqual(page.evaluate("key => JSON.parse(sessionStorage.getItem(key)).attempt", key), attempt)
                for route, response in projects: route.fulfill(response=response)
                self.expect_new_editor(page, "Other library")
                expect(text).to_have_value("")
                self.assertEqual(urlsplit(page.url).path, f"/projects/{self.foreign}/docs/new")
                self.assertEqual(page.evaluate("key => JSON.parse(sessionStorage.getItem(key)).attempt", key), attempt)

    def test_09_same_editor_revalidation_finishes_the_queued_save_once(self):
        for phone in (False, True):
            with self.subTest(phone=phone):
                page, text = self.scene(phone)
                title = f"Same editor settles and saves once {phone}"
                page.get_by_label("Title", exact=True).fill(title)
                saves, loaders = [], []
                def hold_save(route):
                    if route.request.method == "POST":
                        response = route.fetch(); self.assertEqual(response.status, 201)
                        saves.append((route, response)); page.evaluate("window.sameEditorSaveHeld = true")
                    else: route.continue_()
                def hold_loader(route):
                    response = route.fetch(); self.assertEqual(response.status, 200)
                    loaders.append((route, response)); page.evaluate("count => window.sameEditorLoadersHeld = count", len(loaders))
                page.route(f"**/api/v1/projects/{self.project}/docs", hold_save)
                self.addCleanup(lambda page=page: page.unroute_all(behavior="ignoreErrors"))
                text.press("Control+s"); page.wait_for_function("window.sameEditorSaveHeld === true")
                key = f"flux:doc-edit:{self.user}:new:{self.project}"
                attempt = page.evaluate("key => JSON.parse(sessionStorage.getItem(key)).attempt", key)
                page.route(f"**/api/v1/projects/{self.project}", hold_loader)
                self.navigate_editor(page, self.project)
                page.wait_for_function("window.sameEditorLoadersHeld === 2")
                route, response = saves.pop()
                with page.expect_request_finished(lambda request: request.method == "POST" and request.url.endswith(f"/{self.project}/docs")):
                    route.fulfill(response=response)
                page.wait_for_function("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))")
                self.assertEqual(page.evaluate("key => JSON.parse(sessionStorage.getItem(key)).attempt", key), attempt)
                expect(text).to_have_value("PRIVATE-DRAFT of native reference notes\n")
                # Subsequent reader navigation uses the real loader normally.
                page.unroute(f"**/api/v1/projects/{self.project}", hold_loader)
                for route, response in loaders: route.fulfill(response=response)
                expect(page.get_by_role("heading", level=2, name=title)).to_be_visible()
                self.assertIsNone(page.evaluate("key => sessionStorage.getItem(key)", key))
                docs = api(self.ctx, "GET", f"/api/v1/projects/{self.project}/docs?limit=100")["items"]
                self.assertEqual(sum(doc["title"] == title for doc in docs), 1)


    def test_10_delayed_reference_search_describes_its_wait_and_keeps_the_draft(self):
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
                query = picker.get_by_role("combobox", name="Find a doc, decision, result, work, sketch or message", exact=True)
                query.fill(target["title"])
                waiting = picker.locator("p.doc-muted.doc-picker__empty[aria-busy='true']")
                expect(waiting).to_have_text("Finding project objects…")
                expect(waiting).to_be_visible()
                expect(waiting).to_have_attribute("class", "doc-muted doc-picker__empty")
                expect(waiting).to_have_attribute("aria-busy", "true")
                expect(picker.get_by_role("listbox", name="Matches").get_by_role("option")).to_have_count(0)
                expect(text).to_have_value("PRIVATE-DRAFT of native reference notes\n")
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
                expect(text).to_have_value("PRIVATE-DRAFT of native reference notes\n")
