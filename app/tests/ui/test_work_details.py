"""Own native work details, complete relation/choice pages and private command continuity."""
from __future__ import annotations
import json
import time
import re
import unittest
import uuid
from urllib.parse import parse_qs, urlsplit
from playwright.sync_api import expect, sync_playwright

from app_select import choose, expect_value, values
from create_window import open_decision
from test_app_shell import ORIGIN, UPSTREAM, SHOTS, shot, start_forwarder
from test_work_pagination import api


class NativeDetailsJourney(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if UPSTREAM: start_forwarder(ORIGIN, UPSTREAM)
        cls.pw=sync_playwright().start();cls.browser=cls.pw.chromium.launch();expect.set_options(timeout=10000)
        cls.ctx=cls.browser.new_context(service_workers="block", base_url=ORIGIN)
        api(cls.ctx,"POST","/api/auth/sign-up/email",{"name":"Ada Kowalska","email":f"details-{uuid.uuid4()}@example.test","password":"Compare measured results before choosing"})
        cls.user=api(cls.ctx,"GET","/api/v1/me")["user"]["id"]
        ws=api(cls.ctx,"POST","/api/v1/workspaces",{"name":"Riverside makers"},201)["id"]
        cls.workspace=ws
        cls.project=api(cls.ctx,"POST",f"/api/v1/workspaces/{ws}/projects",{"name":"Library lighting measurements","visibility":"restricted"},201)["id"]
        cls.root=f"/api/v1/projects/{cls.project}"
        cls.material=api(cls.ctx,"POST",cls.root+"/materials",{"title":"Shield measurement notes","body":"First measured cable","clientMutationId":str(uuid.uuid4())},201)["materialId"]
        api(cls.ctx,"PATCH",f"/api/v1/materials/{cls.material}",{"title":"Shield measurement notes, revised","body":"Second cable run","expectedVersion":1,"clientMutationId":str(uuid.uuid4())})
        convo=api(cls.ctx,"POST",cls.root+"/conversations",{"body":"Compare the earliest measurements before ordering another sensor.","clientMessageId":str(uuid.uuid4())},201)
        cls.conversation=convo["id"];cls.message=convo["messages"][0]["id"]
        sketch=api(cls.ctx,"POST",f"/api/v1/workspaces/{ws}/sketches",{"title":"Sensing options","scope":"project","projectId":cls.project},201)["id"]
        cls.sketch=sketch;cls.thought=api(cls.ctx,"POST",f"/api/v1/sketches/{sketch}/thoughts",{"text":"Try the same shield with both low-light runs","x":0,"y":0},201)["thought"]["id"]
        sources=[{"type":"message","id":cls.message},{"type":"material","id":cls.material,"version":1},{"type":"material","id":cls.material,"version":2},{"type":"thought","id":cls.thought}]
        cls.target=api(cls.ctx,"POST",cls.root+"/work",{"title":"Compare both shielded sensor runs","outcome":"A measured comparison of both low-light shielded runs, with original evidence.","owner":{"kind":"human","id":cls.user},"sources":sources,"related":[sources[0]]},201)
        cls.target=api(cls.ctx,"PATCH",f"/api/v1/work/{cls.target['id']}",{"status":"blocked","blocker":"Waiting for the same camera firmware","expectedVersion":cls.target["version"]})
        cls.works=[cls.target]
        for i in range(66):cls.works.append(api(cls.ctx,"POST",cls.root+"/work",{"title":f"Compare the library shield measurements · {i+1:03d}","owner":{"kind":"human","id":cls.user},"sources":[sources[0]]},201))
        cls.done=api(cls.ctx,"POST",cls.root+"/work",{"title":"Earlier completed calibration","sources":[sources[0]]},201)
        cls.done=api(cls.ctx,"PATCH",f"/api/v1/work/{cls.done['id']}",{"status":"done","expectedVersion":1})
        cls.rules=[]
        for i in range(64):
            rule=api(cls.ctx,"POST",cls.root+"/decisions",{"title":f"Use the measured shield and cable · {i+1:03d}","rationale":f"Measured rule {i+1} retains its own full reason.","affects":[cls.target["id"]],"sources":[sources[0]]},201)
            cls.rules.append(api(cls.ctx,"POST",f"/api/v1/decisions/{rule['id']}/accept",{"expectedVersion":1}))
        cls.state=cls.ctx.storage_state()

    @classmethod
    def tearDownClass(cls):cls.browser.close();cls.pw.stop()

    def page(self,phone=False):
        ctx=self.browser.new_context(service_workers="block", base_url=ORIGIN,storage_state=self.state,viewport={"width":412 if phone else 1500,"height":915 if phone else 900},device_scale_factor=3 if phone else 1,is_mobile=phone,has_touch=phone,locale="en-GB")
        self.addCleanup(ctx.close);page=ctx.new_page();errors=[];page.on("pageerror",lambda error:errors.append(str(error)))
        self.addCleanup(lambda:self.assertEqual(errors,[],"no uncaught browser errors"));self.addCleanup(lambda:page.unroute_all(behavior="ignoreErrors"));return page

    def native(self,kind,id):return api(self.ctx,"GET",f"/api/v1/{'work' if kind=='work' else 'decisions'}/{id}")
    def records(self):return {kind:api(self.ctx,"GET",self.root+f"/{plural}?limit=100") for kind,plural in (("work","work"),("decision","decisions"))}

    def open(self,page,kind,id):
        page.goto(f"/projects/{self.project}/tasks?open={kind}:{id}")
        panel=page.locator(f".wd[data-detail-kind='{kind}'][data-detail-id='{id}']");expect(panel).to_be_visible()
        self.ready(panel);return panel

    def blocker(self,panel):
        """The blocker's field shows only while it is edited: open it from the card."""
        field=panel.get_by_role("combobox",name="Waiting for",exact=True)
        if field.count()==0:panel.get_by_role("region",name="Blocker").get_by_role("button",name="Edit",exact=True).click()
        return field
    def owner_menu(self,page,panel):
        """The owner is a menu on its row; opening it keeps the version the person saw."""
        button=panel.get_by_role("button",name="Owner",exact=True);button.click()
        return button,page.get_by_role("menu",name="Owner")

    def ready(self,panel):expect(panel.locator("[data-detail-relations-phase]")).to_have_attribute("data-detail-relations-phase","ready")
    def choices_ready(self,panel,name):
        nav=panel.get_by_role("navigation",name=name)
        expect(nav.get_by_role("status")).to_contain_text(re.compile(r"(?:\d+–\d+ of|No rows on this page)"))
        expect(nav).to_have_attribute("aria-busy","false")

    def in_panel_viewport(self,page,element):
        box=element.bounding_box();body=page.locator(".ui-panel__body").bounding_box()
        self.assertGreaterEqual(box["y"],body["y"]-1)
        self.assertLessEqual(box["y"]+box["height"],body["y"]+body["height"]+1)
        self.assertGreaterEqual(box["x"],body["x"]-1)
        self.assertLessEqual(box["x"]+box["width"],body["x"]+body["width"]+1)

    def test_01_complete_native_relations_own_fields_and_other_destinations_on_desktop_and_phone(self):
        before=self.records();expected={link["id"] for link in self.native("work",self.target["id"])["links"]}
        for phone in (False,True):
            with self.subTest(phone=phone):
                page=self.page(phone);observed=[];legacy=[]
                def collect(response):
                    if "/work-relations?" in response.url and response.status==200:observed.append(response.json())
                    if re.search(r"/api/v1/(work|decisions)/[0-9a-f-]+$",response.url):legacy.append(response.url)
                page.on("response",collect);panel=self.open(page,"work",self.target["id"])
                expect(panel).to_contain_text(self.target["outcome"]);expect(panel.get_by_role("button",name="Owner",exact=True)).to_contain_text("Ada Kowalska")
                expect(panel.get_by_role("region",name="Also linked").get_by_role("link")).to_have_attribute("href",f"/projects/{self.project}/conversations/{self.conversation}#message-{self.message}")
                for version in (1,2):expect(panel.locator(f'a[href="/materials/{self.material}/versions/{version}"]')).to_have_count(1)
                expect(panel.locator(f'a[href="/projects/{self.project}/map/{self.sketch}#thought-{self.thought}"]')).to_have_count(1)
                nav=panel.get_by_role("navigation",name="Object relationship pages");union=set()
                while True:
                    self.ready(panel);stamp=panel.locator("[data-detail-relations-observed-at]").get_attribute("data-detail-relations-observed-at")
                    current=[body for body in observed if body["observedAt"]==stamp][-1]
                    self.assertLessEqual(len(current["items"]),50);union.update(item["id"] for item in current["items"])
                    if not current["nextCursor"]:break
                    nav.get_by_role("button",name="Next",exact=True).click()
                self.assertEqual(union,expected);self.assertEqual(legacy,[])
                shot(page,f"bounded-details-work-{'phone' if phone else 'desktop'}")
                nav.get_by_role("button",name="Previous",exact=True).click();self.ready(panel);expect(nav).to_contain_text("1–50 of")
        self.assertEqual(self.records(),before,"read/navigation preserves native target fields and links")

    def test_02_required_relation_failure_retains_blocker_draft_and_has_no_false_empty(self):
        page=self.page();panel=self.open(page,"work",self.target["id"]);field=self.blocker(panel)
        field.fill("My unfinished blocker explanation is private until saved")
        page.route("**/work-relations?**",lambda route:route.fulfill(status=503,json={"code":"WORK_READ_UNAVAILABLE","error":"Fixture unavailable"}))
        panel.get_by_role("navigation",name="Object relationship pages").get_by_role("button",name="Refresh",exact=True).click()
        expect(panel.locator("[data-detail-relations-phase]")).to_have_attribute("data-detail-relations-phase","unavailable")
        expect(panel.get_by_role("alert")).to_contain_text("Relationships could not be loaded")
        expect(panel).not_to_contain_text("No decision refers to this work yet")
        expect(field).to_have_value("My unfinished blocker explanation is private until saved")
        page.unroute("**/work-relations?**");panel.get_by_role("button",name="Refresh relationships",exact=True).click();self.ready(panel)
        expect(field).to_have_value("My unfinished blocker explanation is private until saved")

    def test_04_all_current_rules_reachable_and_selected_rule_persists_on_another_page(self):
        # The one decision form is the Create window's (#1419): its "Replace an accepted decision…" choice pages through every accepted rule.
        page=self.page();page.goto(f"/projects/{self.project}/tasks")
        window=open_decision(page)
        window.get_by_role("textbox",name="Decision",exact=True).fill("Keep a manual off switch after measuring both shields")
        why=window.get_by_role("textbox",name="Why",exact=True);why.fill("Retain the complete earlier measurements before changing the cable")
        window.get_by_role("button",name="Replace an accepted decision…").click();self.choices_ready(window,"Decisions it can replace")
        nav=window.get_by_role("navigation",name="Decisions it can replace");select=window.get_by_label("Does it replace an earlier decision?",exact=True);seen={value for value in values(select) if value}
        nav.get_by_role("button",name="Next",exact=True).click();self.choices_ready(window,"Decisions it can replace")
        seen.update(value for value in values(select) if value);self.assertEqual(seen,{item["id"] for item in self.rules})
        chosen=self.rules[0];choose(select, chosen["id"]);expect(window.get_by_role("button",name=re.compile("^Propose decision"))).to_be_enabled()
        nav.get_by_role("button",name="Previous",exact=True).click();self.choices_ready(window,"Decisions it can replace")
        expect_value(select, chosen["id"]);expect(why).to_have_value("Retain the complete earlier measurements before changing the cable")
        window.get_by_role("button",name=re.compile("^Propose decision")).click()
        # The proposal is held for Undo and reaches the people who can accept it when that window ends.
        expect(page.locator(".ui-toast",has_text="Decision proposed")).to_be_visible()
        proposal=None
        for _ in range(80):
            proposal=next((item for item in api(self.ctx,"GET",self.root+"/decisions?limit=100")["items"] if item["title"]=="Keep a manual off switch after measuring both shields"),None)
            if proposal:break
            page.wait_for_timeout(250)
        self.assertIsNotNone(proposal,"the proposal was sent when the Undo window ended")
        self.assertEqual(proposal["supersedes"],chosen["id"]);self.assertEqual(proposal["rationale"],"Retain the complete earlier measurements before changing the cable")
        self.__class__.pivot=proposal

    def test_05_a_replacing_decision_names_what_it_replaces_and_moves_no_task(self):
        page=self.page();panel=self.open(page,"decision",self.pivot["id"])
        before=api(self.ctx,"GET",self.root+"/work?limit=100")["items"]
        # One plain sentence names the decision it replaces, with its full earlier reason; there is nothing to decide about tasks (#871).
        expect(panel.get_by_text(f"This replaces the decision {self.rules[0]['title']}")).to_be_visible()
        expect(panel).to_contain_text(self.rules[0]["rationale"])
        for gone in ("What happens to current work?","At this pivot"):expect(panel.get_by_role("heading",name=gone)).to_have_count(0)
        expect(panel.get_by_role("radiogroup")).to_have_count(0)
        expect(panel.get_by_role("button",name="Accept and pivot",exact=True)).to_have_count(0)
        # The answer stays at the top, as on the Inbox card (#763 D1).
        accept=panel.get_by_role("button",name="Accept",exact=True);accept.scroll_into_view_if_needed()
        self.in_panel_viewport(page,accept);self.in_panel_viewport(page,panel.locator(".wd-decision-identity"))
        shot(page,"bounded-details-replaces-desktop")
        phone=self.page(True);mobile=self.open(phone,"decision",self.pivot["id"])
        mobile.get_by_role("button",name="Accept",exact=True).scroll_into_view_if_needed()
        self.in_panel_viewport(phone,mobile.get_by_role("button",name="Accept",exact=True));self.in_panel_viewport(phone,mobile.locator(".wd-decision-identity"))
        shot(phone,"bounded-details-replaces-phone")
        accept.click()
        expect(panel).to_contain_text("Decision · accepted")
        after=api(self.ctx,"GET",self.root+"/work?limit=100")["items"]
        self.assertEqual([(item["id"],item["version"]) for item in before],[(item["id"],item["version"]) for item in after],"no task was moved")
        self.assertFalse(any(link["role"]=="still_applies" for link in self.native("decision",self.pivot["id"])["links"]))
        self.assertEqual(self.native("decision",self.rules[0]["id"])["status"],"superseded")
        expect(panel.get_by_role("button",name=self.rules[0]["title"],exact=True)).to_be_visible()

    def test_08_docked_object_links_keep_their_own_project_after_route_navigation(self):
        second=api(self.ctx,"POST",f"/api/v1/workspaces/{self.workspace}/projects",{"name":"Neighbouring workshop","visibility":"restricted"},201)["id"]
        page=self.page();panel=self.open(page,"decision",self.rules[1]["id"])
        # Main's #184 sidebar lists projects under its own "Projects" navigation ("Places" holds Home/Inbox).
        page.get_by_role("complementary",name="Sidebar").get_by_role("navigation",name="Spaces").get_by_role("link",name="Neighbouring workshop",exact=True).click()
        # #763 H11-8 (#802, docs/development/return-to-origin.md): a docked object does not follow the person to another
        # project; it closes there, and Back to the page it was opened on restores it with its own project's links.
        expect(page).to_have_url(re.compile(f"/projects/{second}$"));expect(panel).to_have_count(0)
        expect(page.locator(f"#details .wd[data-detail-id='{self.rules[1]['id']}']")).to_have_count(0)
        page.go_back();expect(page).to_have_url(re.compile(f"/projects/{self.project}/tasks"));expect(panel).to_be_visible();self.ready(panel)
        panel.get_by_role("region",name="Affects").get_by_role("button",name=re.compile("Compare both shielded")).click()
        panel=page.locator("#details .wd");expect(panel).to_have_attribute("data-detail-id",self.target["id"]);self.ready(panel)
        expect(panel).not_to_contain_text("Everyone in Library lighting measurements")
        expect(panel.get_by_role("heading",name="Not available",exact=True)).to_have_count(0)

    def test_11_empty_relations_keep_loading_failure_and_retry_visible(self):
        task = api(self.ctx, "POST", self.root + "/work", {"title": "Record the next shield reading"}, 201)
        before = self.native("work", task["id"])
        self.assertEqual(before["links"], [], "the real task starts without relationships")
        observations = []
        for phone in (False, True):
            with self.subTest(phone=phone):
                page = self.page(phone)
                held = []
                holding = [True]

                def hold(route):
                    if not holding[0] or parse_qs(urlsplit(route.request.url).query).get("objects") != [f"work:{task['id']}"]:
                        route.continue_()
                        return
                    # Register the genuine request before any upstream I/O. Loading
                    # is observable as soon as the request starts, before fetch returns.
                    held.append((route, route.request.url))

                page.route("**/work-relations?**", hold)
                page.goto(f"/projects/{self.project}/tasks?open=work:{task['id']}")
                panel = page.locator(f".wd[data-detail-id='{task['id']}']")
                # The panel waits for its relationships' first read (#899): the task's skeleton stands in, so nothing moves
                # when they arrive, and there is no false empty state meanwhile.
                deadline = time.monotonic() + 10
                while not held and time.monotonic() < deadline:
                    page.wait_for_timeout(50)
                expect(page.locator("#details [aria-busy='true']").first).to_be_visible()
                expect(panel).to_have_count(0)
                nav = panel.get_by_role("navigation", name="Object relationship pages")
                self.assertTrue(held, "the loading state comes from actual held relation reads")
                holding[0] = False
                # Only this task's selector is held. Retain every genuine observation
                # of it, without intercepting relationship reads for other objects.
                for route, url in held:
                    response = route.fetch()
                    self.assertEqual(response.status, 200)
                    payload = response.json()
                    self.assertEqual((payload["before"], payload["total"], payload["items"]), (0, 0, []))
                    observations.append({"phone": phone, "targetWorkId": task["id"], "url": url,
                                         "objects": parse_qs(urlsplit(url).query)["objects"],
                                         "before": payload["before"], "total": payload["total"], "itemCount": len(payload["items"])})
                    if SHOTS:
                        (SHOTS / "detail-relations-empty-observations.json").write_text(json.dumps(observations, indent=2) + "\n")
                    route.fulfill(response=response)
                self.ready(panel)
                expect(nav).to_have_count(0)
                expect(panel).not_to_contain_text("No rows on this page")
                # A task added on Tasks has no source: its "From" row is hidden (#868).
                expect(panel.locator(".wd-row dt", has_text="From")).to_have_count(0)
                shot(page, f"detail-relations-empty-{'phone' if phone else 'desktop'}")

                page.unroute("**/work-relations?**", hold)
                def fail_current_relations(route):
                    if parse_qs(urlsplit(route.request.url).query).get("objects") == [f"work:{task['id']}"]:
                        route.fulfill(status=503, json={"code": "WORK_READ_UNAVAILABLE", "error": "Fixture unavailable"})
                    else:
                        route.continue_()

                page.route("**/work-relations?**", fail_current_relations)
                page.goto(f"/projects/{self.project}/tasks?open=work:{task['id']}")
                expect(panel.locator("[data-detail-relations-phase]")).to_have_attribute("data-detail-relations-phase", "unavailable")
                expect(nav).to_be_visible()
                expect(panel.get_by_role("alert")).to_contain_text("Relationships could not be loaded")
                expect(panel).not_to_contain_text("Added directly on the Tasks tab.")
                shot(page, f"detail-relations-unavailable-{'phone' if phone else 'desktop'}")
                page.unroute("**/work-relations?**")
                panel.get_by_role("button", name="Refresh relationships", exact=True).click()
                self.ready(panel)
                expect(nav).to_have_count(0)
                expect(panel.locator(".wd-row dt", has_text="From")).to_have_count(0)
        self.assertEqual(self.native("work", task["id"]), before, "empty/read/retry never changes native work or links")

    def test_12_empty_later_relation_page_still_returns_to_first_page(self):
        page = self.page()
        panel = self.open(page, "work", self.target["id"])
        nav = panel.get_by_role("navigation", name="Object relationship pages")

        def empty_later_page(route):
            query = parse_qs(urlsplit(route.request.url).query)
            if query.get("objects") != [f"work:{self.target['id']}"] or not query.get("cursor"):
                route.continue_()
                return
            response = route.fetch()
            self.assertEqual(response.status, 200)
            payload = response.json()
            if payload["before"] == 0:
                route.fulfill(response=response)
                return
            self.assertGreater(payload["before"], 0)
            self.assertTrue(payload["previousCursor"])
            # A changed observation can leave the requested later page empty. Keep
            # the real cursor/before metadata so both recovery paths stay testable.
            payload.update(items=[], total=0, nextCursor=None)
            route.fulfill(response=response, json=payload)

        page.route("**/work-relations?**", empty_later_page)
        for recovery in ("Previous", "Refresh"):
            with self.subTest(recovery=recovery):
                nav.get_by_role("button", name="Next", exact=True).click()
                self.ready(panel)
                # An empty list says nothing in the bar (#1372); the panel says the page is empty.
                expect(nav.locator(".ws-pages__range")).to_have_text("")
                expect(nav.get_by_role("button", name="Previous", exact=True)).to_be_enabled()
                expect(panel).to_contain_text("No matching links on this page.")
                shot(page, f"detail-relations-empty-later-{recovery.lower()}")
                nav.get_by_role("button", name=recovery, exact=True).click()
                self.ready(panel)
                expect(nav).to_contain_text("1–50 of")
                expect(nav.get_by_role("button", name="Next", exact=True)).to_be_enabled()

    def test_13_blocker_and_title_drafts_keep_their_base_across_live_changes_and_retries(self):
        other = self.browser.new_context(service_workers="block", base_url=ORIGIN)
        self.addCleanup(other.close)
        email = f"conflict-peer-{uuid.uuid4()}@example.test"
        api(other, "POST", "/api/auth/sign-up/email", {"name": "Jonas Berg", "email": email, "password": "Read every conflicting measurement"})
        user = api(other, "GET", "/api/v1/me")["user"]["id"]
        api(self.ctx, "POST", f"/api/v1/workspaces/{self.workspace}/members", {"email": email, "role": "member"}, 201)
        api(self.ctx, "POST", self.root + "/grants", {"principal": {"kind": "human", "id": user}, "role": "contributor"}, 201)
        for field in ("blocker", "title"):
            with self.subTest(field=field):
                task = api(self.ctx, "POST", self.root + "/work", {"title": "Compare the conflicting measurement"}, 201)
                task = api(self.ctx, "PATCH", f"/api/v1/work/{task['id']}", {"status": "blocked", "blocker": "Original blocker", "expectedVersion": task["version"]})
                page = self.page(); panel = self.open(page, "work", task["id"])
                if field == "title":
                    panel.get_by_title("Edit title", exact=True).click()
                    draft = panel.get_by_role("textbox", name="Task title", exact=True)
                else:
                    draft = self.blocker(panel)
                draft.fill("My carefully preserved draft")
                url = f"/api/v1/work/{task['id']}"
                for number in (1, 2):
                    current = api(other, "GET", url)
                    api(other, "PATCH", url, {field: f"Peer measurement {number}", "expectedVersion": current["version"]})
                    # A visible live snapshot proves the concurrent version reached the
                    # panel before Save, including the second change after its first 409.
                    expect(panel).to_contain_text(f"Now: Peer measurement {number}")
                    with page.expect_response(lambda response: response.request.method == "PATCH" and response.url.endswith(url)) as refused:
                        if field == "title": draft.press("Enter")
                        else: panel.get_by_role("button", name="Save", exact=True).click()
                    self.assertEqual(refused.value.status, 409)
                    expect(panel.get_by_role("alert")).to_contain_text("Someone changed this")
                    expect(draft).to_have_value("My carefully preserved draft")
                    shot(page, f"task-conflict-{field}-{number}")
                    self.assertEqual(api(other, "GET", url)[field], f"Peer measurement {number}")
                with page.expect_response(lambda response: response.request.method == "PATCH" and response.url.endswith(url)) as saved:
                    if field == "title": draft.press("Enter")
                    else: panel.get_by_role("button", name="Save", exact=True).click()
                self.assertEqual(saved.value.status, 200)
                self.assertEqual(api(other, "GET", url)[field], "My carefully preserved draft")

    def test_14_owner_choice_conflicts_keep_the_selection_and_require_explicit_retry(self):
        task = api(self.ctx, "POST", self.root + "/work", {"title": "Review who owns the next measurement"}, 201)
        page = self.page(); panel = self.open(page, "work", task["id"])
        owner, menu = self.owner_menu(page, panel)
        url = f"/api/v1/work/{task['id']}"
        current = api(self.ctx, "PATCH", url, {"title": "The peer revised the measurement", "expectedVersion": task["version"]})
        expect(panel.get_by_title("Edit title", exact=True)).to_have_text("The peer revised the measurement")
        with page.expect_response(lambda response: response.request.method == "PATCH" and response.url.endswith(url)) as conflict:
            menu.get_by_role("menuitemradio", name=re.compile("Ada Kowalska")).click()
        self.assertEqual(conflict.value.status, 409)
        expect(owner).to_contain_text("Ada Kowalska")
        expect(panel).to_contain_text("Now: Nobody yet")
        expect(panel.get_by_role("alert")).to_contain_text("Someone changed this")
        api(self.ctx, "PATCH", url, {"title": "The peer revised it again", "expectedVersion": current["version"]})
        expect(panel.get_by_title("Edit title", exact=True)).to_have_text("The peer revised it again")
        retry = panel.get_by_role("button", name="Retry owner change", exact=True)
        with page.expect_response(lambda response: response.request.method == "PATCH" and response.url.endswith(url)) as second:
            retry.click()
        self.assertEqual(second.value.status, 409)
        expect(owner).to_contain_text("Ada Kowalska")
        with page.expect_response(lambda response: response.request.method == "PATCH" and response.url.endswith(url)) as saved:
            retry.click()
        self.assertEqual(saved.value.status, 200)
        self.assertEqual(self.native("work", task["id"])["owner"]["id"], self.user)
        expect(retry).to_have_count(0)

    def test_15_successful_blocker_save_retires_the_draft_before_a_peer_refresh(self):
        task = api(self.ctx, "POST", self.root + "/work", {"title": "Retire each stored blocker draft"}, 201)
        task = api(self.ctx, "PATCH", f"/api/v1/work/{task['id']}", {"status": "blocked", "blocker": "Original", "expectedVersion": task["version"]})
        page = self.page(); panel = self.open(page, "work", task["id"])
        card = panel.get_by_role("region", name="Blocker")
        field = self.blocker(panel)
        field.fill("My first stored blocker")
        save = panel.get_by_role("button", name="Save", exact=True)
        with page.expect_response(lambda response: response.request.method == "PATCH" and response.url.endswith(task['id'])) as stored:
            save.click()
        self.assertEqual(stored.value.status, 200)
        # Saved, the card shows it and the field is gone: nothing is left to type over.
        expect(card).to_contain_text("My first stored blocker")
        expect(field).to_have_count(0)
        current = self.native("work", task["id"])
        api(self.ctx, "PATCH", f"/api/v1/work/{task['id']}", {"blocker": "The peer's newer blocker", "expectedVersion": current["version"]})
        expect(card).to_contain_text("The peer's newer blocker")
        # The retired draft does not come back over the peer's text.
        field = self.blocker(panel)
        expect(field).to_have_value("The peer's newer blocker")
        expect(save).to_be_disabled()
        self.assertEqual(self.native("work", task["id"])["blocker"], "The peer's newer blocker")

    def test_16_clean_field_focus_ends_before_a_later_edit(self):
        task = api(self.ctx, "POST", self.root + "/work", {"title": "End clean property editing sessions"}, 201)
        url = f"/api/v1/work/{task['id']}"
        task = api(self.ctx, "PATCH", url, {"status": "blocked", "blocker": "Original blocker", "expectedVersion": task["version"]})
        page = self.page(); panel = self.open(page, "work", task["id"])
        owner, menu = self.owner_menu(page, panel)
        page.keyboard.press("Escape")
        expect(menu).to_have_count(0)
        task = api(self.ctx, "PATCH", url, {"title": "A fresh title after clean owner focus", "expectedVersion": task["version"]})
        expect(panel.get_by_title("Edit title", exact=True)).to_have_text(task["title"])
        owner, menu = self.owner_menu(page, panel)
        with page.expect_response(lambda response: response.request.method == "PATCH" and response.url.endswith(url)) as assigned:
            menu.get_by_role("menuitemradio", name=re.compile("Ada Kowalska")).click()
        self.assertEqual(assigned.value.status, 200, "a new clean owner session uses the currently visible version")
        expect(panel.get_by_role("button", name="Retry owner change", exact=True)).to_have_count(0)
        field = self.blocker(panel)
        panel.get_by_role("region", name="Blocker").get_by_role("button", name="Cancel", exact=True).click()
        expect(field).to_have_count(0)
        task = self.native("work", task["id"])
        api(self.ctx, "PATCH", url, {"blocker": "A fresh blocker after clean focus", "expectedVersion": task["version"]})
        # The live update reaches the card before a new session opens: it starts from the version the person sees.
        expect(panel.get_by_role("region", name="Blocker")).to_contain_text("A fresh blocker after clean focus")
        field = self.blocker(panel)
        expect(field).to_have_value("A fresh blocker after clean focus")
        field.fill("My new blocker session")
        with page.expect_response(lambda response: response.request.method == "PATCH" and response.url.endswith(url)) as stored:
            panel.get_by_role("button", name="Save", exact=True).click()
        self.assertEqual(stored.value.status, 200, "a new clean blocker session uses the currently visible version")
        expect(panel.get_by_role("alert")).to_have_count(0)

    def test_18_late_success_preserves_newer_title_and_blocker_drafts_with_their_own_base(self):
        for field_name in ("blocker", "title"):
            with self.subTest(field=field_name):
                task = api(self.ctx, "POST", self.root + "/work", {"title": "Keep text entered after Save"}, 201)
                url = f"/api/v1/work/{task['id']}"
                task = api(self.ctx, "PATCH", url, {"status": "blocked", "blocker": "Original blocker", "expectedVersion": task["version"]})
                page = self.page(); panel = self.open(page, "work", task["id"])
                if field_name == "title":
                    panel.get_by_title("Edit title", exact=True).click()
                    field = panel.get_by_role("textbox", name="Task title", exact=True)
                else:
                    field = self.blocker(panel)
                held = []
                def hold(route):
                    if route.request.method != "PATCH":
                        route.continue_(); return
                    response = route.fetch()
                    self.assertEqual(response.status, 200)
                    held.append((route, response))
                    page.evaluate("window.__draftSaveHeld = true")
                page.route("**" + url, hold)
                field.fill("My submitted draft A")
                if field_name == "title": field.press("Enter")
                else: panel.get_by_role("button", name="Save", exact=True).click()
                page.wait_for_function("window.__draftSaveHeld === true")
                field.fill("My newer unsaved draft B")
                stored = self.native("work", task["id"])
                self.assertEqual(stored[field_name], "My submitted draft A")
                api(self.ctx, "PATCH", url, {field_name: "Peer revision C", "expectedVersion": stored["version"]})
                expect(panel).to_contain_text("Now: Peer revision C")
                route, response = held.pop()
                with page.expect_response(lambda response: response.request.method == "PATCH" and response.url.endswith(url)) as released:
                    route.fulfill(response=response)
                released.value.finished()
                if field_name == "title": expect(field).to_have_attribute("aria-busy", "false")
                else: expect(panel.get_by_role("button", name="Save", exact=True)).to_be_enabled()
                expect(field).to_have_value("My newer unsaved draft B")
                page.unroute("**" + url, hold)
                with page.expect_response(lambda response: response.request.method == "PATCH" and response.url.endswith(url)) as conflict:
                    if field_name == "title": field.press("Enter")
                    else: panel.get_by_role("button", name="Save", exact=True).click()
                self.assertEqual(conflict.value.status, 409, "newer draft is based on our own acknowledged save, not the later peer revision")
                expect(field).to_have_value("My newer unsaved draft B")
                self.assertEqual(self.native("work", task["id"])[field_name], "Peer revision C")
                with page.expect_response(lambda response: response.request.method == "PATCH" and response.url.endswith(url)) as saved:
                    if field_name == "title": field.press("Enter")
                    else: panel.get_by_role("button", name="Save", exact=True).click()
                self.assertEqual(saved.value.status, 200)
                self.assertEqual(self.native("work", task["id"])[field_name], "My newer unsaved draft B")
