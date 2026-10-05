"""Native message source pages; parent/assistant full-graph migration remains open."""
from __future__ import annotations

import json
import re
import unittest
import uuid
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import expect, sync_playwright
from test_app_shell import ORIGIN, UPSTREAM, shot, start_forwarder
from test_work_pagination import api


class MessageWorkJourney(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if UPSTREAM: start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start(); cls.browser = cls.pw.chromium.launch()
        expect.set_options(timeout=10000)
        cls.contexts, cls.users, emails = [], [], []
        for name in ("Ada Kowalska", "Ada Nowak"):
            context = cls.browser.new_context(base_url=ORIGIN)
            email = f"source-pages-{uuid.uuid4()}@example.test"
            api(context, "POST", "/api/auth/sign-up/email", {"name": name, "email": email, "password": "compare sensor measurements before ordering"})
            cls.contexts.append(context); emails.append(email)
            cls.users.append(api(context, "GET", "/api/v1/me")["user"]["id"])
        owner = cls.contexts[0]
        workspace = api(owner, "POST", "/api/v1/workspaces", {"name": "Riverside lighting"}, 201)["id"]
        api(owner, "POST", f"/api/v1/workspaces/{workspace}/members", {"email": emails[1], "role": "member"}, 201)
        cls.project = api(owner, "POST", f"/api/v1/workspaces/{workspace}/projects", {"name": "Lamp measurements", "visibility": "restricted"}, 201)["id"]
        cls.root = f"/api/v1/projects/{cls.project}"
        api(owner, "POST", cls.root + "/grants", {"principal": {"kind": "human", "id": cls.users[1]}, "role": "contributor"}, 201)
        notes = "\n".join(f"Run {index + 1}: compare the shield, cable and standby current before ordering another sensor." for index in range(28))
        thread = api(owner, "POST", cls.root + "/conversations", {"body": "Compare the sensor measurements before ordering another board.\n" + notes, "clientMessageId": str(uuid.uuid4())}, 201)
        cls.conversation = thread["id"]
        cls.m0 = thread["messages"][0]["id"]
        cls.m1 = api(owner, "POST", f"/api/v1/conversations/{cls.conversation}/messages", {"body": "Keep both measured runs linked so we can revisit the noise.\n" + notes, "clientMessageId": str(uuid.uuid4())}, 201)["id"]
        sources = [{"type": "message", "id": message} for message in (cls.m0, cls.m1)]
        cls.work = [api(owner, "POST", cls.root + "/work", {"title": f"Compare standby sensor measurements · {index + 1:03d}", "owner": {"kind": "human", "id": cls.users[index % 2]}, "sources": sources}, 201) for index in range(64)]
        old = api(owner, "POST", cls.root + "/decisions", {"title": "Try the camera", "sources": [sources[0]]}, 201)
        api(owner, "POST", f"/api/v1/decisions/{old['id']}/accept", {"expectedVersion": 1})
        current = api(owner, "POST", cls.root + "/decisions", {"title": "Use the distance sensor", "supersedes": old["id"], "sources": [sources[0]]}, 201)
        api(owner, "POST", f"/api/v1/decisions/{current['id']}/accept", {"expectedVersion": 1, "stillApplies": [], "park": []})
        proposal = api(owner, "POST", cls.root + "/decisions", {"title": "Keep the manual off switch", "sources": [sources[0]]}, 201)
        result = api(owner, "POST", cls.root + "/results", {"title": "The shield reduced noise", "finding": "positive", "sources": [sources[0]]}, 201)
        cls.expected = {("work", work["id"]) for work in cls.work} | {("decision", item["id"]) for item in (old, current, proposal)} | {("result", result["id"])}
        api(owner, "POST", cls.root + "/work", {"title": "Related only; not made from either message", "related": [sources[0]]}, 201)
        long = api(owner, "POST", cls.root + "/conversations", {"body": "Library installation notes from the first measurement", "clientMessageId": str(uuid.uuid4())}, 201)
        cls.long_conversation = long["id"]; cls.long_messages = [long["messages"][0]["id"]]
        cls.material = api(owner,"POST",cls.root+"/materials",{"title":"Shield measurements","body":"Compare the same cable and shield across both runs.","clientMutationId":str(uuid.uuid4())},201)
        for index in range(140):
            command={"body": f"Measurement note {index + 2}: compare the shield, cable and standby current before ordering.", "clientMessageId": str(uuid.uuid4())}
            if index==139:command["source"]={"materialId":cls.material["materialId"],"version":cls.material["version"]}
            cls.long_messages.append(api(owner, "POST", f"/api/v1/conversations/{long['id']}/messages", command, 201)["id"])
        cls.first_work = api(owner, "POST", cls.root + "/work", {"title": "Revisit the first measurement", "sources": [{"type": "message", "id": cls.long_messages[0]}]}, 201)
        cls.last_work = api(owner, "POST", cls.root + "/work", {"title": "Revisit the latest measurement", "sources": [{"type": "message", "id": cls.long_messages[-1]}]}, 201)
        cls.states = [context.storage_state() for context in cls.contexts]
        cls.before = cls.digest()

    @classmethod
    def digest(cls):
        return json.dumps([api(cls.contexts[0], "GET", cls.root + f"/{kind}?limit=100") for kind in ("work", "decisions", "results")], sort_keys=True)

    @classmethod
    def tearDownClass(cls):
        try:
            if cls.digest() != cls.before: raise AssertionError("source read/navigation changed native object fields/links/counts")
        finally: cls.browser.close(); cls.pw.stop()

    def page(self, phone=False):
        context = self.browser.new_context(base_url=ORIGIN, storage_state=self.states[0], viewport={"width": 412 if phone else 1500, "height": 915 if phone else 900}, device_scale_factor=3 if phone else 1, is_mobile=phone, has_touch=phone, locale="en-GB")
        self.addCleanup(context.close)
        page = context.new_page(); errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught browser errors"))
        # Late response handlers may be canceled at teardown after all assertions;
        # browser page errors remain asserted before closing the actual context.
        self.addCleanup(lambda: page.unroute_all(behavior="ignoreErrors"))
        return page

    def thread_read(self, url):
        """The open thread's association reads. Since #195 the project's stream reads its own roots
        (this project's two conversation roots) separately; that read is not the thread's batch."""
        return "/work-associations?" in url and set(parse_qs(urlsplit(url).query)["messageIds"][0].split(",")) != {self.m0, self.long_messages[0]}

    def ready(self, page):
        expect(page.locator(".thread__pane")).to_have_attribute("data-associations-phase", "ready")
        expect(page.locator(".thread__pane")).to_have_attribute("data-associations-observed-at", re.compile(r"^\d{4}-\d{2}-\d{2}T"))

    def chips(self, page):
        return page.locator(".thread__feed .ws-chip").evaluate_all("els=>els.map(el=>({kind:el.dataset.workKind,id:el.dataset.workId,message:el.closest('[data-message-id]').dataset.messageId}))")

    def anchor(self, page):
        return page.locator(".thread__feed").evaluate("el=>{const top=el.getBoundingClientRect().top;const row=[...el.querySelectorAll('[data-message-id]')].find(row=>row.getBoundingClientRect().bottom>top);return {id:row.dataset.messageId,offset:row.getBoundingClientRect().top-top};}")

    def assert_anchor(self, page, anchor):
        offset = page.locator(f"#thread [data-message-id='{anchor['id']}']").evaluate("el=>el.getBoundingClientRect().top-el.closest('.thread__feed').getBoundingClientRect().top")
        self.assertLess(abs(offset - anchor["offset"]), 3)

    def test_01_global_object_and_edge_pages_keep_native_ids_counts_and_reply(self):
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page(phone)
                reads = []
                page.on("request", lambda request: reads.append(request.url) if self.thread_read(request.url) else None)
                page.goto(f"/projects/{self.project}/conversations/{self.conversation}"); self.ready(page)
                self.assertEqual(len(reads), 1)
                self.assertEqual(set(parse_qs(urlsplit(reads[0]).query)["messageIds"][0].split(',')), {self.m0, self.m1})
                objects = page.locator("#thread").get_by_role("navigation", name="Linked object pages")
                edges = page.locator("#thread").get_by_role("navigation", name="Message link pages")
                expect(objects).to_contain_text("1–50 of 68 objects")
                expect(edges).to_contain_text("1–50 of 100 links")
                expect(page.locator(f"#thread [data-message-id='{self.m0}'] .ws-attach__more")).to_contain_text("64 work · 3 decisions · 1 result")
                expect(page.get_by_role("button", name="Work: Related only; not made from either message", exact=True)).to_have_count(0)
                field = page.get_by_label("Reply", exact=True); field.fill("Keep this reply while checking the older measurement links")
                first = self.chips(page); self.assertEqual(len(first), 50)
                anchor = self.anchor(page)
                edges.get_by_role("button", name="Next", exact=True).click(); self.ready(page)
                expect(edges).to_contain_text("51–100 of 100 links")
                self.assert_anchor(page, anchor)
                second_edges = self.chips(page); self.assertEqual(len(second_edges), 50)
                edges.get_by_role("button", name="Previous", exact=True).click(); self.ready(page)
                self.assertEqual(self.chips(page), first)
                objects.get_by_role("button", name="Next", exact=True).click(); self.ready(page)
                expect(objects).to_contain_text("51–68 of 68 objects")
                expect(edges).to_contain_text("1–32 of 32 links")
                last = self.chips(page); self.assertEqual(len(last), 32)
                self.assertEqual({(chip["kind"], chip["id"]) for chip in first + second_edges + last}, self.expected)
                self.assertLessEqual(len(self.chips(page)), 50)
                expect(field).to_have_value("Keep this reply while checking the older measurement links")
                page.locator(".thread__feed").get_by_role("button",name="Result: The shield reduced noise",exact=True).scroll_into_view_if_needed()
                shot(page, f"bounded-message-objects-mixed-{'phone' if phone else 'desktop'}")
                if phone:
                    self.assertTrue(page.locator(".thread__feed .ws-chip__t").evaluate_all("els=>els.every(el=>el.scrollWidth<=el.clientWidth+1 && el.scrollHeight<=el.clientHeight+1 && getComputedStyle(el).whiteSpace==='normal')"),"every distinguishing native title is fully visible on the phone")
                expect(edges.get_by_role("button")).to_have_count(0)
                pane=page.locator(".thread__feed");pane.hover();page.mouse.wheel(0,100000)
                page.wait_for_function("()=>new Promise(resolve=>{let last=-1,stable=0;const check=()=>{const p=document.querySelector('.thread__feed');stable=p.scrollTop===last?stable+1:0;last=p.scrollTop;if(stable>8)resolve(true);else requestAnimationFrame(check);};requestAnimationFrame(check);})")
                shot(page, f"bounded-message-objects-{'phone' if phone else 'desktop'}")
                page.reload(); self.ready(page)
                expect(objects).to_contain_text("51–68 of 68 objects")
                self.assertEqual(self.chips(page), last)
                expect(field).to_have_value("Keep this reply while checking the older measurement links")
                objects.get_by_role("button", name="Previous", exact=True).click(); self.ready(page)
                expect(edges).to_contain_text("1–50 of 100 links")

    def test_02_held_next_page_respects_new_wheel_reading_position_and_private_selection(self):
        page = self.page(); page.goto(f"/projects/{self.project}/conversations/{self.conversation}"); self.ready(page)
        held = []
        def hold(route):
            if parse_qs(urlsplit(route.request.url).query).get("cursor"):
                response = route.fetch(); self.assertEqual(response.status, 200); held.append((route,response)); page.evaluate("window.__associationHeld = true")
            else: route.continue_()
        page.route("**/work-associations?**", hold)
        page.locator("#thread").get_by_role("navigation", name="Linked object pages").get_by_role("button", name="Next", exact=True).click()
        page.wait_for_function("window.__associationHeld === true")
        pane = page.locator(".thread__feed")
        self.assertGreater(pane.evaluate("el=>el.scrollTop"),0,"loading still has scrollable native message text")
        pane.hover(); page.mouse.wheel(0, -100000)
        page.wait_for_function("document.querySelector('.thread__feed').scrollTop === 0")
        current = self.anchor(page)
        field = page.get_by_label("Reply", exact=True); field.fill("Keep the reader's newer position and this reply")
        field.evaluate("el=>{el.focus();el.setSelectionRange(5,17);}")
        route,response = held.pop(); route.fulfill(response=response); self.ready(page)
        self.assert_anchor(page,current)
        self.assertEqual(field.evaluate("el=>[document.activeElement===el,el.selectionStart,el.selectionEnd]"),[True,5,17])
        page.unroute("**/work-associations?**",hold)

    def test_03_old_page_and_required_failure_do_not_revive_chips_or_clear_reply(self):
        page = self.page(); page.goto(f"/projects/{self.project}/conversations/{self.conversation}"); self.ready(page)
        first = self.chips(page); held = []
        def hold(route):
            if parse_qs(urlsplit(route.request.url).query).get("cursor"):
                response=route.fetch();self.assertEqual(response.status,200);held.append((route,response));page.evaluate("window.__associationHeld=true")
            else: route.continue_()
        page.route("**/work-associations?**",hold)
        pages=page.locator("#thread").get_by_role("navigation",name="Linked object pages")
        pages.get_by_role("button",name="Next",exact=True).click();page.wait_for_function("window.__associationHeld===true")
        pages.get_by_role("button",name="Refresh",exact=True).click();self.ready(page)
        route,response=held.pop();route.fulfill(response=response)
        self.assertEqual(self.chips(page),first);page.unroute("**/work-associations?**",hold)
        field=page.get_by_label("Reply",exact=True);field.fill("Reply stays private during an unavailable association read")
        page.route("**/work-associations?**",lambda route:route.fulfill(status=503,json={"code":"WORK_READ_UNAVAILABLE","error":"Fixture unavailable read"}))
        pages.get_by_role("button",name="Refresh",exact=True).click()
        expect(page.locator("#thread").get_by_role("alert").filter(has_text="Linked work could not be loaded")).to_be_visible()
        self.assertEqual(self.chips(page),[]);expect(field).to_have_value("Reply stays private during an unavailable association read")
        page.unroute("**/work-associations?**")
        page.locator("#thread").get_by_role("button",name="Refresh linked work",exact=True).click();self.ready(page);self.assertEqual(self.chips(page),first)

    def test_04_cookie_account_change_retires_held_old_page_and_isolates_reply(self):
        page=self.page();page.goto(f"/projects/{self.project}/conversations/{self.conversation}");self.ready(page)
        first=self.chips(page);field=page.get_by_label("Reply",exact=True);field.fill("Ada Kowalska's private reply")
        held=[]
        def hold(route):
            if parse_qs(urlsplit(route.request.url).query).get("cursor"):
                response=route.fetch();self.assertEqual(response.status,200);held.append((route,response));page.evaluate("window.__associationHeld=true")
            else:route.continue_()
        page.route("**/work-associations?**",hold)
        page.locator("#thread").get_by_role("navigation",name="Linked object pages").get_by_role("button",name="Next",exact=True).click();page.wait_for_function("window.__associationHeld===true")
        page.context.clear_cookies();page.context.add_cookies(self.states[1]["cookies"]);page.evaluate("window.dispatchEvent(new Event('focus'))")
        expect(field).to_have_value("");self.ready(page)
        field.fill("Ada Nowak's separate private reply")
        route,response=held.pop();route.fulfill(response=response);self.ready(page)
        self.assertEqual(self.chips(page),first);expect(field).to_have_value("Ada Nowak's separate private reply")
        expect(page.locator("#thread").get_by_role("navigation",name="Linked object pages")).to_contain_text("1–50 of 68 objects")
        page.unroute("**/work-associations?**",hold)

    def test_05_older_visible_messages_use_one_bounded_batch_and_native_source(self):
        page=self.page();reads=[]
        page.on("request",lambda request:reads.append(parse_qs(urlsplit(request.url).query)) if self.thread_read(request.url) else None)
        page.goto(f"/projects/{self.project}/conversations/{self.long_conversation}#message-{self.long_messages[1]}")
        expect(page.locator(f"#thread [data-message-id='{self.long_messages[0]}']")).to_be_visible();self.ready(page)
        expect(page.locator("#thread").get_by_role("button",name="Work: Revisit the first measurement",exact=True)).to_be_visible()
        self.assertGreater(page.locator("#thread [data-message-id]").count(),100)
        pane=page.locator(".thread__feed");pane.hover();page.mouse.wheel(0,100000)
        expect(page.locator(f"#thread [data-message-id='{self.long_messages[-1]}']")).to_be_visible();self.ready(page)
        expect(page.locator("#thread").get_by_role("button",name="Work: Revisit the latest measurement",exact=True)).to_be_visible()
        for query in reads:
            self.assertEqual(query["relation"],["source"])
            self.assertLessEqual(len(query["messageIds"][0].split(',')),100)
        self.assertLess(len(reads),10,"a bounded window read, never one HTTP read per message")

    def test_06_paused_router_revalidation_retires_viewport_selector_aba(self):
        page=self.page();reads=[]
        page.on("request",lambda request:reads.append(parse_qs(urlsplit(request.url).query)["messageIds"][0]) if self.thread_read(request.url) else None)
        page.goto(f"/projects/{self.project}/conversations/{self.long_conversation}#message-{self.long_messages[1]}")
        expect(page.locator("#thread").get_by_role("button",name="Work: Revisit the first measurement",exact=True)).to_be_visible();self.ready(page)
        original_selector=reads[-1];held=[];paused=[]
        def hold_scope(route):
            if parse_qs(urlsplit(route.request.url).query)["messageIds"][0]==original_selector and not held:
                response=route.fetch();self.assertEqual(response.status,200);held.append((route,response));page.evaluate("window.__associationHeld=true")
            else:route.continue_()
        page.route("**/work-associations?**",hold_scope)
        page.evaluate("window.dispatchEvent(new Event('focus'))");page.wait_for_function("window.__associationHeld===true")
        def pause_auth(route):
            response=route.fetch();self.assertEqual(response.status,200);paused.append((route,response));page.evaluate("window.__authHeld=true")
        page.route("**/api/v1/me",pause_auth)
        page.evaluate("window.dispatchEvent(new Event('focus'))");page.wait_for_function("window.__authHeld===true")
        pane=page.locator(".thread__feed");pane.hover();page.mouse.wheel(0,100000)
        page.wait_for_function("el=>{const row=document.querySelector('[data-message-id=\"'+el+'\"]');const pane=row.closest('.thread__feed');return row.getBoundingClientRect().top<pane.getBoundingClientRect().bottom;}",arg=self.long_messages[-1])
        expect(page.locator(".thread__pane")).to_have_attribute("data-associations-phase","loading")
        page.mouse.wheel(0,-100000);page.wait_for_function("document.querySelector('.thread__feed').scrollTop===0")
        expect(page.locator(".thread__pane")).to_have_attribute("data-associations-phase","loading")
        route,response=held.pop();route.fulfill(response=response)
        expect(page.locator(".thread__pane")).to_have_attribute("data-associations-phase","loading")
        page.unroute("**/work-associations?**",hold_scope)
        self.assertEqual(len(paused),1)
        route,response=paused.pop();route.fulfill(response=response);page.unroute("**/api/v1/me",pause_auth)
        self.ready(page);expect(page.locator("#thread").get_by_role("button",name="Work: Revisit the first measurement",exact=True)).to_be_visible()

    def test_07_restored_feed_observes_older_and_newer_native_batches(self):
        page=self.page();material_reads=[];native_recoveries=[];holding=[True]
        material_path=f"**/api/v1/materials/{self.material['materialId']}/versions/{self.material['version']}"
        def hold_material(route):
            if not holding[0]:route.continue_();return
            response=route.fetch();self.assertEqual(response.status,200)
            if holding[0]:material_reads.append(route);page.evaluate("window.__materialReadHeld=true")
            else:route.fulfill(response=response)
        page.route(material_path,hold_material)
        page.on("response",lambda response:native_recoveries.append(response.status) if urlsplit(response.url).path==self.root else None)
        page.goto(f"/projects/{self.project}/conversations/{self.long_conversation}#message-{self.long_messages[1]}")
        self.ready(page);expect(page.locator("#thread").get_by_role("button",name="Work: Revisit the first measurement",exact=True)).to_be_visible()
        page.wait_for_function("window.__materialReadHeld===true")
        before=len(native_recoveries)
        page.evaluate("()=>{window.__originalFeedColumn=document.querySelector('.thread__feed').firstElementChild;window.__feedRemovalObserver=new MutationObserver(()=>{if(!window.__originalFeedColumn.isConnected)window.__feedWasRemoved=true;});window.__feedRemovalObserver.observe(document.body,{childList:true,subtree:true});}")
        # Only the citation failure is injected; recovery uses all real native responses.
        holding[0]=False
        material_reads.pop().fulfill(status=404,json={"code":"NOT_FOUND","error":"Fixture transient unavailable citation"})
        page.wait_for_function("window.__feedWasRemoved===true")
        self.ready(page)
        self.assertTrue(page.locator(".thread__feed").evaluate("el=>el.firstElementChild!==window.__originalFeedColumn"),"the observed message subtree was actually replaced")
        self.assertGreater(len(native_recoveries),before)
        self.assertTrue(all(status==200 for status in native_recoveries[before:]),"native project checks restore the mounted reader")
        expect(page.locator("#thread").get_by_role("button",name="Work: Revisit the first measurement",exact=True)).to_be_visible()
        pane=page.locator(".thread__feed");pane.hover();page.mouse.wheel(0,100000)
        expect(page.locator("#thread").get_by_role("button",name="Work: Revisit the latest measurement",exact=True)).to_be_visible();self.ready(page)
        page.mouse.wheel(0,-100000)
        expect(page.locator("#thread").get_by_role("button",name="Work: Revisit the first measurement",exact=True)).to_be_visible();self.ready(page)
        page.evaluate("window.__feedRemovalObserver.disconnect()")
        page.unroute_all(behavior="ignoreErrors")

    def test_08_one_pagedown_gesture_keeps_scrolling_across_a_held_batch(self):
        page=self.page();reads=[]
        page.on("request",lambda request:reads.append(parse_qs(urlsplit(request.url).query)["messageIds"][0]) if self.thread_read(request.url) else None)
        page.goto(f"/projects/{self.project}/conversations/{self.long_conversation}#message-{self.long_messages[1]}")
        expect(page.locator("#thread").get_by_role("button",name="Work: Revisit the first measurement",exact=True)).to_be_visible();self.ready(page)
        original=reads[-1];pane=page.locator(".thread__feed")
        page.locator(f"#thread [data-message-id='{self.long_messages[100]}']").evaluate("row=>{const p=row.closest('.thread__feed');p.scrollTop+=row.getBoundingClientRect().top-p.getBoundingClientRect().bottom-20;}")
        page.wait_for_function("()=>new Promise(resolve=>{let last=-1,stable=0;const check=()=>{const p=document.querySelector('.thread__feed');stable=p.scrollTop===last?stable+1:0;last=p.scrollTop;if(stable>8)resolve(true);else requestAnimationFrame(check);};requestAnimationFrame(check);})")
        self.ready(page);self.assertEqual(reads[-1],original)
        held=[];holding=[True]
        def hold(route):
            if holding[0] and self.thread_read(route.request.url) and parse_qs(urlsplit(route.request.url).query)["messageIds"][0]!=original:
                top=pane.evaluate("el=>el.scrollTop")
                response=route.fetch();self.assertEqual(response.status,200)
                if holding[0]:held.append((route,response,top));page.evaluate("window.__gestureBatchHeld=true")
                else:route.fulfill(response=response)
            else:route.continue_()
        page.route("**/work-associations?**",hold)
        page.locator(f"#thread [data-message-id='{self.long_messages[98]}']").evaluate("el=>el.focus({preventScroll:true})")
        page.keyboard.press("PageDown")
        page.wait_for_function("window.__gestureBatchHeld===true")
        expect(page.locator(".thread__pane")).to_have_attribute("data-associations-phase","loading")
        page.wait_for_function("()=>new Promise(resolve=>{let last=-1,stable=0;const check=()=>{const p=document.querySelector('.thread__feed');stable=p.scrollTop===last?stable+1:0;last=p.scrollTop;if(stable>8)resolve(true);else requestAnimationFrame(check);};requestAnimationFrame(check);})")
        self.assertEqual(len(held),1)
        route,response,when_held=held.pop()
        self.assertGreater(pane.evaluate("el=>el.scrollTop"),when_held+3,"one native smooth PageDown continues after the batch response is held")
        newest=self.anchor(page);holding[0]=False;route.fulfill(response=response);self.ready(page)
        self.assert_anchor(page,newest)
        page.unroute_all(behavior="ignoreErrors")
