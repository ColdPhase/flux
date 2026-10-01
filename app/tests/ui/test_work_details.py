"""Own native work details, complete relation/choice pages and private command continuity."""
from __future__ import annotations
import json
import re
import unittest
import uuid
from urllib.parse import parse_qs, urlsplit
from playwright.sync_api import expect, sync_playwright
from test_app_shell import ORIGIN, UPSTREAM, shot, start_forwarder
from test_work_pagination import api


class NativeDetailsJourney(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if UPSTREAM: start_forwarder(ORIGIN, UPSTREAM)
        cls.pw=sync_playwright().start();cls.browser=cls.pw.chromium.launch();expect.set_options(timeout=10000)
        cls.ctx=cls.browser.new_context(base_url=ORIGIN)
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
        cls.result=api(cls.ctx,"POST",cls.root+"/results",{"title":"The shield reduced noise in both runs","finding":"positive","evidence":"Native full evidence: 18 dB lower noise on both runs.","work":[cls.target["id"]],"sources":[sources[0],sources[3]]},201)
        cls.docs=[]
        for i in range(54):cls.docs.append(api(cls.ctx,"POST",cls.root+"/docs",{"title":f"Shielding field notes · {i+1:03d}","from":{"type":"result","id":cls.result["id"]}},201))
        cls.state=cls.ctx.storage_state()

    @classmethod
    def tearDownClass(cls):cls.browser.close();cls.pw.stop()

    def page(self,phone=False):
        ctx=self.browser.new_context(base_url=ORIGIN,storage_state=self.state,viewport={"width":412 if phone else 1500,"height":915 if phone else 900},device_scale_factor=3 if phone else 1,is_mobile=phone,has_touch=phone,locale="en-GB")
        self.addCleanup(ctx.close);page=ctx.new_page();errors=[];page.on("pageerror",lambda error:errors.append(str(error)))
        self.addCleanup(lambda:self.assertEqual(errors,[],"no uncaught browser errors"));self.addCleanup(lambda:page.unroute_all(behavior="ignoreErrors"));return page

    def native(self,kind,id):return api(self.ctx,"GET",f"/api/v1/{'work' if kind=='work' else 'decisions' if kind=='decision' else 'results'}/{id}")
    def records(self):return {kind:api(self.ctx,"GET",self.root+f"/{plural}?limit=100") for kind,plural in (("work","work"),("decision","decisions"),("result","results"))}

    def open(self,page,kind,id):
        page.goto(f"/projects/{self.project}/tasks?open={kind}:{id}")
        panel=page.locator(f".wd[data-detail-kind='{kind}'][data-detail-id='{id}']");expect(panel).to_be_visible()
        self.ready(panel);return panel

    def ready(self,panel):expect(panel.locator("[data-detail-relations-phase]")).to_have_attribute("data-detail-relations-phase","ready")
    def choices_ready(self,panel,name):expect(panel.get_by_role("navigation",name=name)).to_have_attribute("aria-busy","false")

    def test_01_complete_native_relations_own_fields_and_other_destinations_on_desktop_and_phone(self):
        before=self.records();expected={link["id"] for link in self.native("work",self.target["id"])["links"]}
        for phone in (False,True):
            with self.subTest(phone=phone):
                page=self.page(phone);observed=[];legacy=[]
                def collect(response):
                    if "/work-relations?" in response.url and response.status==200:observed.append(response.json())
                    if re.search(r"/api/v1/(work|decisions|results)/[0-9a-f-]+$",response.url):legacy.append(response.url)
                page.on("response",collect);panel=self.open(page,"work",self.target["id"])
                expect(panel).to_contain_text(self.target["outcome"]);expect(panel.get_by_label("Owner",exact=True)).to_have_value(f"human:{self.user}")
                expect(panel.get_by_role("region",name="Other relationships").get_by_role("link")).to_have_attribute("href",f"/projects/{self.project}/conversations/{self.conversation}#message-{self.message}")
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
        page=self.page();panel=self.open(page,"work",self.target["id"]);field=panel.get_by_label("What is it waiting for?",exact=True)
        field.fill("My unfinished blocker explanation is private until saved")
        page.route("**/work-relations?**",lambda route:route.fulfill(status=503,json={"code":"WORK_READ_UNAVAILABLE","error":"Fixture unavailable"}))
        panel.get_by_role("navigation",name="Object relationship pages").get_by_role("button",name="Refresh",exact=True).click()
        expect(panel.locator("[data-detail-relations-phase]")).to_have_attribute("data-detail-relations-phase","unavailable")
        expect(panel.get_by_role("alert")).to_contain_text("Relationships could not be loaded")
        expect(panel).not_to_contain_text("No decision refers to this work yet")
        expect(field).to_have_value("My unfinished blocker explanation is private until saved")
        page.unroute("**/work-relations?**");panel.get_by_role("button",name="Refresh relationships",exact=True).click();self.ready(panel)
        expect(field).to_have_value("My unfinished blocker explanation is private until saved")

    def test_03_finished_deep_selection_survives_all_result_choice_pages_and_failure(self):
        for phone in (False,True):
            with self.subTest(phone=phone):
                page=self.page(phone);panel=self.open(page,"work",self.done["id"]);panel.get_by_role("button",name="Attach a result",exact=True).click()
                panel=page.locator("#details .wd");self.choices_ready(panel,"Result work choices")
                title=panel.get_by_label("Finding",exact=True);title.fill("A measured result for the earlier completed calibration")
                field=panel.get_by_label("Evidence",exact=True);field.fill("Keep the exact measurements and this unfinished explanation")
                select=panel.get_by_label("For work",exact=True);expect(select).to_have_value(self.done["id"])
                nav=panel.get_by_role("navigation",name="Result work choices");seen=set()
                while True:
                    self.choices_ready(panel,"Result work choices")
                    seen.update(select.locator("option").evaluate_all("els=>els.map(el=>el.value).filter(Boolean)"))
                    self.assertLessEqual(select.locator("option").count(),52)
                    if nav.get_by_role("button",name="Next",exact=True).is_disabled():break
                    nav.get_by_role("button",name="Next",exact=True).click()
                self.assertEqual(seen,{item["id"] for item in self.works}|{self.done["id"]})
                expect(select).to_have_value(self.done["id"]);expect(field).to_have_value("Keep the exact measurements and this unfinished explanation")
                shot(page,f"bounded-details-result-{'phone' if phone else 'desktop'}")
                page.route("**/work-view?**choice=result_work**",lambda route:route.fulfill(status=503,json={"code":"WORK_READ_UNAVAILABLE","error":"Fixture unavailable"}))
                nav.get_by_role("button",name="Refresh",exact=True).click();expect(panel.get_by_role("alert")).to_contain_text("Choices could not be loaded")
                expect(select).to_have_value(self.done["id"]);expect(title).to_have_value("A measured result for the earlier completed calibration")
                expect(field).to_have_value("Keep the exact measurements and this unfinished explanation")
                expect(panel.get_by_role("button",name="Attach result",exact=True)).to_be_disabled()
                page.unroute("**/work-view?**choice=result_work**");panel.get_by_role("button",name="Refresh choices",exact=True).click();self.choices_ready(panel,"Result work choices")
                expect(select).to_have_value(self.done["id"])

    def test_04_all_current_rules_reachable_and_selected_rule_persists_on_another_page(self):
        page=self.page();page.goto(f"/projects/{self.project}/conversations/{self.conversation}")
        message=page.locator(f"#message-{self.message}");message.hover();message.get_by_role("button",name="Propose decision",exact=True).click()
        panel=page.locator("#details .wd");self.choices_ready(panel,"Current rule choices")
        panel.get_by_label("Decision",exact=True).fill("Keep a manual off switch after measuring both shields")
        why=panel.get_by_label("Why",exact=True);why.fill("Retain the complete earlier measurements before changing the cable")
        nav=panel.get_by_role("navigation",name="Current rule choices");select=panel.get_by_label("Replaces",exact=True);seen=set(select.locator("option").evaluate_all("els=>els.map(el=>el.value).filter(Boolean)"))
        nav.get_by_role("button",name="Next",exact=True).click();self.choices_ready(panel,"Current rule choices")
        seen.update(select.locator("option").evaluate_all("els=>els.map(el=>el.value).filter(Boolean)"));self.assertEqual(seen,{item["id"] for item in self.rules})
        chosen=self.rules[0];select.select_option(chosen["id"]);expect(panel.get_by_role("button",name="Propose decision",exact=True)).to_be_enabled()
        nav.get_by_role("button",name="Previous",exact=True).click();self.choices_ready(panel,"Current rule choices")
        expect(select).to_have_value(chosen["id"]);expect(why).to_have_value("Retain the complete earlier measurements before changing the cable")
        panel.get_by_role("button",name="Propose decision",exact=True).click()
        expect(page.locator('.wd[data-detail-kind="decision"]')).to_contain_text("Keep a manual off switch")
        saved=api(self.ctx,"GET",self.root+"/decisions?limit=100")["items"]
        proposal=next(item for item in saved if item["title"]=="Keep a manual off switch after measuring both shields")
        self.assertEqual(proposal["supersedes"],chosen["id"]);self.assertEqual(proposal["rationale"],"Retain the complete earlier measurements before changing the cable")
        self.__class__.pivot=proposal

    def test_05_native_pivot_keeps_off_page_choices_and_earlier_full_reason(self):
        page=self.page();panel=self.open(page,"decision",self.pivot["id"])
        expect(panel).to_contain_text(self.rules[0]["rationale"]);self.choices_ready(panel,"Pivot work pages")
        groups=panel.get_by_role("radiogroup");first=groups.first;keep_name=first.get_attribute("aria-label");first.get_by_role("radio",name="Still applies",exact=True).check()
        nav=panel.get_by_role("navigation",name="Pivot work pages");nav.get_by_role("button",name="Next",exact=True).click();self.choices_ready(panel,"Pivot work pages")
        park_group=panel.get_by_role("radiogroup").last;park_name=park_group.get_attribute("aria-label");park_group.get_by_role("radio",name="Park",exact=True).check()
        nav.get_by_role("button",name="Previous",exact=True).click();self.choices_ready(panel,"Pivot work pages")
        expect(panel.get_by_role("radiogroup",name=keep_name,exact=True).get_by_role("radio",name="Still applies",exact=True)).to_be_checked()
        expect(panel).to_contain_text("1 still apply · 1 parked")
        shot(page,"bounded-details-pivot-desktop")
        phone=self.page(True);mobile=self.open(phone,"decision",self.pivot["id"]);self.choices_ready(mobile,"Pivot work pages")
        shot(phone,"bounded-details-pivot-phone")
        panel.get_by_role("button",name="Accept and pivot",exact=True).click()
        expect(panel).to_contain_text("Current rule")
        work=api(self.ctx,"GET",self.root+"/work?limit=100")["items"];kept=next(item for item in work if item["title"]==keep_name);parked=next(item for item in work if item["title"]==park_name)
        self.assertEqual(parked["parked"]["decisionId"],self.pivot["id"]);self.assertTrue(any(link["role"]=="still_applies" and link["to"]["id"]==kept["id"] for link in self.native("decision",self.pivot["id"])["links"]))
        expect(panel.get_by_role("region",name="At this pivot")).to_contain_text(park_name)

    def test_06_native_version_conflict_retains_result_text_and_requires_explicit_finish_change(self):
        work=self.works[-2];page=self.page();panel=self.open(page,"work",work["id"]);panel.get_by_role("button",name="Attach a result",exact=True).click()
        panel=page.locator("#details .wd");self.choices_ready(panel,"Result work choices")
        title=panel.get_by_label("Finding",exact=True);title.fill("The earlier version changed while writing this result")
        field=panel.get_by_label("Evidence",exact=True);field.fill("The measured numbers and unfinished conclusion must survive the conflict")
        panel.get_by_role("radio",name="Negative",exact=True).check();finish=panel.get_by_role("checkbox",name=re.compile("This finishes"));expect(finish).to_be_visible();finish.check()
        current=self.native("work",work["id"]);api(self.ctx,"PATCH",f"/api/v1/work/{work['id']}",{"status":"not_pursued","expectedVersion":current["version"]})
        panel.get_by_role("button",name="Attach result",exact=True).click();expect(panel.get_by_role("alert")).to_contain_text("Someone changed this")
        expect(panel).to_contain_text("cannot be finished by this result")
        expect(title).to_have_value("The earlier version changed while writing this result");expect(field).to_have_value("The measured numbers and unfinished conclusion must survive the conflict")
        expect(panel.get_by_label("For work",exact=True)).to_have_value(work["id"]);expect(panel.get_by_role("button",name="Attach result",exact=True)).to_be_disabled()
        panel.get_by_role("button",name="Attach without finishing",exact=True).click();expect(panel.get_by_role("button",name="Attach result",exact=True)).to_be_enabled()
        panel.get_by_role("button",name="Attach result",exact=True).click();expect(page.locator('.wd[data-detail-kind="result"]')).to_contain_text("earlier version changed")
        self.assertEqual(self.native("work",work["id"])["status"],"not_pursued")

    def test_07_held_native_result_cannot_replace_fresh_draft_after_a_b_a(self):
        thread=api(self.ctx,"POST",self.root+"/conversations",{"body":"Compare these two independently owned command lifetimes.","clientMessageId":str(uuid.uuid4())},201)
        work=[]
        for title in ("Check the earlier command lifetime", "Check the intervening command lifetime"):
            work.append(api(self.ctx,"POST",self.root+"/work",{"title":title,"sources":[{"type":"message","id":thread["messages"][0]["id"]}]},201))
        page=self.page();page.goto(f"/projects/{self.project}/conversations/{thread['id']}")
        chip=lambda item:page.locator(f"#message-{thread['messages'][0]['id']}").get_by_role("button",name=f"Work: {item['title']}",exact=True)
        chip(work[0]).click();panel=page.locator("#details .wd");self.ready(panel)
        panel.get_by_role("button",name="Attach a result",exact=True).click();self.choices_ready(panel,"Result work choices")
        panel.get_by_label("Finding",exact=True).fill("The old result really committed while its response waited")
        panel.get_by_label("Evidence",exact=True).fill("Old measured evidence belongs to the old command lifetime")
        panel.get_by_role("radio",name="Positive",exact=True).check();held=[]
        def hold(route):
            response=route.fetch();self.assertEqual(response.status,201);held.append((route,response));page.evaluate("window.__oldDetailCommandHeld=true")
        page.route("**/api/v1/projects/*/results",hold)
        panel.get_by_role("button",name="Attach result",exact=True).click();page.wait_for_function("window.__oldDetailCommandHeld===true")
        chip(work[1]).click();expect(panel).to_have_attribute("data-detail-id",work[1]["id"]);self.ready(panel)
        chip(work[0]).click();self.ready(panel);panel.get_by_role("button",name="Attach a result",exact=True).click();self.choices_ready(panel,"Result work choices")
        finding=panel.get_by_label("Finding",exact=True);finding.fill("My fresh draft after reopening the same work")
        evidence=panel.get_by_label("Evidence",exact=True);evidence.fill("Fresh unsaved measurements stay owned by the new form")
        evidence.evaluate("el=>{el.focus();el.setSelectionRange(6,13)}")
        route,response=held.pop();saved=response.json();route.fulfill(response=response)
        page.wait_for_function("performance.getEntriesByType('resource').some(e=>e.name.endsWith('/results'))")
        expect(finding).to_have_value("My fresh draft after reopening the same work")
        expect(evidence).to_have_value("Fresh unsaved measurements stay owned by the new form")
        self.assertEqual(evidence.evaluate("el=>[document.activeElement===el,el.selectionStart,el.selectionEnd]"),[True,6,13])
        self.assertEqual(self.native("result",saved["id"])["title"],"The old result really committed while its response waited")
        expect(panel.get_by_role("alert")).to_have_count(0)
        page.unroute("**/api/v1/projects/*/results",hold)

    def test_08_docked_object_links_keep_their_own_project_after_route_navigation(self):
        second=api(self.ctx,"POST",f"/api/v1/workspaces/{self.workspace}/projects",{"name":"Neighbouring workshop","visibility":"restricted"},201)["id"]
        page=self.page();panel=self.open(page,"result",self.result["id"])
        page.get_by_role("navigation",name="Places").get_by_role("link",name="Neighbouring workshop",exact=True).click()
        expect(page).to_have_url(re.compile(f"/projects/{second}$"));expect(panel).to_have_attribute("data-detail-id",self.result["id"])
        panel.get_by_role("region",name="Reports on").get_by_role("button",name=re.compile("Compare both shielded")).click()
        expect(panel).to_have_attribute("data-detail-id",self.target["id"]);self.ready(panel)
        expect(panel).to_contain_text("Everyone with access to Library lighting measurements")
        expect(panel.get_by_role("heading",name="Not available",exact=True)).to_have_count(0)

    def test_09_doc_source_link_does_not_promise_a_missing_section_or_new_version(self):
        result=api(self.ctx,"POST",self.root+"/results",{"title":"Independent doc source with measured evidence","finding":"positive","evidence":"Twenty measured runs"},201)
        doc=api(self.ctx,"POST",self.root+"/docs",{"title":"Source section can be removed without losing its link","from":{"type":"result","id":result["id"]}},201)
        doc=api(self.ctx,"PATCH",f"/api/v1/docs/{doc['id']}",{"body":"Unrelated notes remain here","expectedVersion":doc["version"]})
        self.assertTrue(any(link["role"]=="source" and link["to"]["id"]==result["id"] for link in doc["links"]))
        for unchanged in (False,True):
            page=self.page();panel=self.open(page,"result",result["id"]);panel.get_by_role("button",name="Add to docs",exact=True).click()
            panel.get_by_label("Doc",exact=True).select_option(doc["id"])
            expect(panel).to_contain_text("unchanged content keeps its current version")
            expect(panel).not_to_contain_text("rewritten as version")
            panel.get_by_role("button",name="Add or update section",exact=True).click()
            expect(page.locator(".doc-prose").get_by_role("heading",name=f"Result: {result['title']}",exact=True)).to_be_visible()
            saved=api(self.ctx,"GET",f"/api/v1/docs/{doc['id']}")
            self.assertEqual(saved["version"],doc["version"]+(0 if unchanged else 1));doc=saved
