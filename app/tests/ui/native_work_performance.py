"""Opt-in native 1000-work baseline; never included in normal test_*.py discovery.

Run in the ui-test Compose service after building the pinned application. Public
commands create the fixture. Chromium observes real navigation/input/view/wheel
events; CDP reads actual response bodies AFTER a usable-paint timestamp. No mock
responses, SQL seed, provider dispatch, private payload or authentication logs.
An observed budget/continuity failure is evidence, not a completed task.
"""
from __future__ import annotations

import base64
from collections import Counter
import hashlib
import json
import math
import os
from pathlib import Path
import re
import time
import uuid
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

from test_app_shell import ORIGIN, UPSTREAM, start_forwarder

OUT = Path(os.environ.get("FLUX_UI_SCREENSHOTS", "/screenshots"))
COUNTS = {"Needs you": 1, "In progress": 300, "Blocked": 150, "Open": 470,
          "Parked": 30, "Finished": 50, "Decisions": 2, "Results": 10}
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
COLLECTION = re.compile(r"/api/v1/projects/[^/]+/(work|decisions|results|summary)$")
CONTINUITY = ("resizePreservesDraft", "resizePreservesFocusSelection", "onlyMinePreservesDraft",
              "onlyMineCountsVerified", "viewPreservesDraft", "detailsPreservesDraft",
              "deepNativeTitleVerified", "sourceRoundTripPreservesDraft", "sourceRoundTripNativeRouteVerified")
PROBE = r"""(() => {
  const counts = {"Needs you":1,"In progress":300,"Blocked":150,"Open":470,
    "Parked":30,"Finished":50,"Decisions":2,"Results":10};
  const probe = window.__nativeWorkProbe = {nav:null, armed:null, sample:null};
  const rows = () => document.querySelectorAll('.ws-list > li').length;
  const pane = () => document.querySelector('.ws-tasks')?.closest('.pane-scroll');
  function correctView(view, rowCount, checkAllCounts) {
    const input = document.querySelector('.create__title');
    if (!input || input.disabled || !input.closest('.ws-tasks')) return false;
    const views = document.querySelectorAll('.ws-view');
    const selected = [...views].find(b => b.getAttribute('aria-pressed') === 'true');
    if (!selected || !selected.textContent.trim().startsWith(view)) return false;
    if (rows() !== rowCount) return false;
    return !checkAllCounts || Object.entries(counts).every(([label, count]) => {
      const button = [...views].find(b => b.textContent.trim().startsWith(label));
      return button && Number(button.querySelector('.ws-view__n')?.textContent) === count;
    });
  }
  // Continuous state observation stays in this document's performance clock.
  // Two following frames are an explicit proxy, not a raster-completion claim.
  function navigation() {
    if (!correctView('All',1013,true)) return requestAnimationFrame(navigation);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!correctView('All',1013,true)) return navigation();
      const entry = performance.getEntriesByType('navigation')[0];
      probe.nav = {start:entry?.startTime ?? 0, end:performance.now(),
        duration:performance.now() - (entry?.startTime ?? 0),
        timeOrigin:performance.timeOrigin, rows:rows()};
    }));
  }
  requestAnimationFrame(navigation);
  probe.arm = (kind, expected) => {
    probe.sample = null;
    probe.armed = {kind, expected, start:null, trusted:false, beforeScroll:pane()?.scrollTop};
  };
  function ready(a) {
    if (a.kind === 'input') return document.querySelector('.create__title')?.value === a.expected.value;
    if (a.kind === 'view') return correctView(a.expected.view,a.expected.rows,true);
    return !!pane() && Math.abs(pane().scrollTop-a.beforeScroll) >= 1;
  }
  function finish(a) {
    if (probe.armed !== a) return;
    if (!ready(a)) return requestAnimationFrame(() => finish(a));
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (probe.armed !== a) return;
      if (!ready(a)) return finish(a);
      probe.sample = {kind:a.kind, duration:performance.now()-a.start,
        trusted:a.trusted, changed:true, rows:rows(),
        scrollDelta:a.kind === 'scroll' ? pane().scrollTop-a.beforeScroll : null};
      probe.armed = null;
    }));
  }
  function capture(event) {
    const a = probe.armed;
    if (!a || a.start !== null || !event.isTrusted) return;
    const el = event.target instanceof Element ? event.target : null;
    if (a.kind === 'input' && !(event.type === 'keydown' && el?.classList?.contains('create__title'))) return;
    if (a.kind === 'view' && !(event.type === 'click' && el?.closest('.ws-view'))) return;
    if (a.kind === 'scroll' && !(event.type === 'wheel' && el?.closest('.pane-scroll') === pane())) return;
    a.start = performance.now(); a.trusted = true; requestAnimationFrame(() => finish(a));
  }
  for (const event of ['keydown','click','wheel']) document.addEventListener(event,capture,true);
})();"""


def api(context, method, path, body=None, status=200):
    response = context.request.fetch(path, method=method, data=body,
        headers={"origin": ORIGIN, "idempotency-key": str(uuid.uuid4())})
    if response.status != status:
        raise AssertionError(f"native {method} {UUID.sub(':id', path)} returned {response.status}, expected {status}")
    data = response.json()
    response.dispose()
    return data


def work_digest(items):
    # Digest current native state, retaining no identity/title/authentication in reports.
    state = [{"id":i["id"],"version":i["version"],"status":i["status"],
              "owner":i["owner"],"parked":i["parked"],"links":i["links"]} for i in items]
    return hashlib.sha256(json.dumps(sorted(state,key=lambda i:i["id"]),sort_keys=True).encode()).hexdigest()


def fixture(browser):
    started = time.monotonic()
    contexts, ids, emails = [], [], []
    for index, name in enumerate(("Ada Kowalska", "Jonas Berg")):
        context = browser.new_context(base_url=ORIGIN)
        email = f"native-work-{index}-{uuid.uuid4()}@example.test"
        api(context,"POST","/api/auth/sign-up/email",
            {"name":name,"email":email,"password":"a quiet reading corner lamp"})
        contexts.append(context); emails.append(email)
        ids.append(api(context,"GET","/api/v1/me")["user"]["id"])
    owner = contexts[0]
    workspace = api(owner,"POST","/api/v1/workspaces",{"name":"Riverside Makers"},201)["id"]
    api(owner,"POST",f"/api/v1/workspaces/{workspace}/members",{"email":emails[1],"role":"member"},201)
    project = api(owner,"POST",f"/api/v1/workspaces/{workspace}/projects",
        {"name":"Reading corner lamp","visibility":"restricted"},201)["id"]
    api(owner,"POST",f"/api/v1/projects/{project}/grants",
        {"principal":{"kind":"human","id":ids[1]},"role":"contributor"},201)
    root = f"/api/v1/projects/{project}"
    material = api(owner,"POST",root+"/materials",{"title":"Low-light observations",
        "body":"20 gestures at each light level. A distance sensor stores no images. Keep a manual switch.",
        "clientMutationId":str(uuid.uuid4())},201)
    assert material["version"] == 1
    conversation = api(owner,"POST",root+"/conversations",
        {"body":"How should the library lamp respond in low light?","clientMessageId":str(uuid.uuid4())},201)
    messages = [conversation["messages"][0]["id"]]
    for index in range(99):
        message = api(contexts[index%2],"POST",f"/api/v1/conversations/{conversation['id']}/messages",
            {"body":f"Trial {index+1}: compare sensor range, child reach and privacy before changing the lamp threshold.",
             "clientMessageId":str(uuid.uuid4())},201)
        messages.append(message["id"])
    assert len(set(messages)) == 100
    themes = ("Measure the distance sensor range", "Check the manual switch reach",
              "Compare low-light gesture recognition", "Verify private observations stay local",
              "Test the reading corner lamp enclosure", "Review the library mounting clearance")
    work = []
    for index in range(1000):
        status = "open" if index < 500 else "in_progress" if index < 800 else "blocked" if index < 950 else "done"
        sources = ([{"type":"message","id":messages[index//2]}] if index%2 == 0
                   else [{"type":"material","id":material["materialId"],"version":1}]) if index < 100 else []
        item = api(contexts[index%2],"POST",root+"/work",{
            "title":f"{themes[index%len(themes)]} — trial {index+1:04d}",
            "outcome":"Record measured range, lux and observations so the library can choose a usable threshold.",
            "owner":{"kind":"human","id":ids[index%2]},"status":status,
            **({"blocker":"the next low-light measurement from the library"} if status == "blocked" else {}),
            **({"sources":sources} if sources else {})},201)
        work.append(item)
        if (index+1)%100 == 0: print(f"fixture: {index+1}/1000 native work objects",flush=True)
    previous = api(owner,"POST",root+"/decisions",{"title":"Use a camera for the first prototype",
        "rationale":"Compare its measured low-light performance before choosing the production sensor."},201)
    api(owner,"POST",f"/api/v1/decisions/{previous['id']}/accept",{"expectedVersion":1})
    current = api(owner,"POST",root+"/decisions",{"title":"Use a distance sensor for the reading corner",
        "rationale":"It works in the dark without recording images.","supersedes":previous["id"],
        "affects":[item["id"] for item in work[:30]]},201)
    api(owner,"POST",f"/api/v1/decisions/{current['id']}/accept",
        {"expectedVersion":1,"park":[item["id"] for item in work[:30]]})
    api(contexts[1],"POST",root+"/decisions",{"title":"Keep a manual off switch on the base",
        "rationale":"Children should be able to turn the lamp off without a gesture."},201)
    for index in range(10):
        api(contexts[index%2],"POST",root+"/results",{
            "title":f"Range trial {index+1}: {'stable' if index%2 == 0 else 'unreliable'} at low light",
            "finding":"positive" if index%2 == 0 else "negative",
            "evidence":"20 gestures at 5 lux; compare detection with the manual switch available.",
            "work":[work[950+index]["id"]],"decisions":[current["id"]]},201)
    per_account = []
    for context in contexts:
        observed = []
        for offset in range(0,1000,100):
            page = api(context,"GET",root+f"/work?limit=100&offset={offset}")
            assert page["total"] == 1000, "native API must report all 1000 work objects"
            observed.extend(page["items"])
        assert len({item["id"] for item in observed}) == 1000
        assert Counter(item["status"] for item in observed) == {"open":500,"in_progress":300,"blocked":150,"done":50}
        assert len([item for item in observed if item["parked"]]) == 30
        assert Counter(item["owner"]["id"] for item in observed) == {ids[0]:500,ids[1]:500}
        assert Counter(item["owner"]["id"] for item in observed if item["parked"]) == {ids[0]:15,ids[1]:15}
        source_links = [link for item in observed for link in item["links"]
                        if link["from"]["id"] == item["id"] and link["role"] == "source"]
        assert Counter(link["to"]["type"] for link in source_links) == {"message":50,"material":50}
        assert all(link["to"]["version"] == 1 for link in source_links if link["to"]["type"] == "material")
        for item in (work[900],work[98]):
            actual = api(context,"GET",f"/api/v1/work/{item['id']}")
            assert actual["id"] == item["id"] and actual["title"] == item["title"]
        decisions = api(context,"GET",root+"/decisions?limit=100&offset=0")
        results = api(context,"GET",root+"/results?limit=100&offset=0")
        assert decisions["total"] == 3 and Counter(d["status"] for d in decisions["items"]) == {"accepted":1,"proposed":1,"superseded":1}
        assert results["total"] == 10 and Counter(r["finding"] for r in results["items"]) == {"positive":5,"negative":5}
        per_account.append({"uniqueWork":1000,"status":{"open":500,"in_progress":300,"blocked":150,"done":50},"parked":30,"ownedWork":500,"ownedParked":15,"decisions":3,"results":10})
        digest = work_digest(observed)
    states = [c.storage_state() for c in contexts]
    for context in contexts: context.close()
    return {"project":project,"conversation":conversation["id"],"deep":work[900],"sourced":work[98],
        "states":states,"workDigest":digest,"summary":{"actualHumans":2,"accountsVerified":per_account,
            "workSourceLinks":{"message":50,"materialVersion1":50},"messagesCreated":100,
            "fixtureSeconds":time.monotonic()-started,"writes":"public native commands; setup excluded from measurement"}}


class Traffic:
    """CDP observes real network; payloads stay in memory and only aggregates persist."""
    def __init__(self, session):
        self.session = session; self.phase = "between"; self.records = {}; self.mutations = Counter()
        self.initials = []; self.overflow = 0
        session.send("Network.enable",{"maxTotalBufferSize":20000000,"maxResourceBufferSize":2000000})
        session.on("Network.requestWillBeSent",self.request)
        session.on("Network.responseReceived",self.response)
        session.on("Network.loadingFinished",self.finished)

    def request(self,event):
        request = event["request"]; url = urlsplit(request["url"])
        if url.scheme not in ("http","https"): return
        method = request["method"]; path = UUID.sub(":id",url.path)
        if method not in ("GET","HEAD","OPTIONS"):
            same_origin = (url.scheme,url.netloc)==(urlsplit(ORIGIN).scheme,urlsplit(ORIGIN).netloc)
            self.mutations[f"{method} {path if same_origin and path.startswith('/api/') else '(other HTTP command)'}"] += 1
        if not url.path.startswith("/api/"): return
        if len(self.records) >= 256:
            self.overflow += 1; return
        self.records[event["requestId"]] = {"path":path,"collection":bool(COLLECTION.search(url.path)),
            "kind":(COLLECTION.search(url.path).group(1) if COLLECTION.search(url.path) else None),
            "method":method,"phase":self.phase,"status":None,"finished":False,"encoded":None}

    def response(self,event):
        record = self.records.get(event["requestId"])
        if record: record["status"] = event["response"]["status"]

    def finished(self,event):
        record = self.records.get(event["requestId"])
        if record: record.update(finished=True,encoded=event["encodedDataLength"])

    def begin(self,phase):
        self.phase = phase; self.records = {}; self.overflow = 0

    def collect(self,phase):
        # The browser's measured paint proxy has already finished before body reads.
        self.phase = "between"
        records = [(rid,r) for rid,r in self.records.items() if r["phase"] == phase]
        work = set(); fetched = Counter(); body_bytes = 0; unavailable = 0
        for rid,record in records:
            if not record["collection"]: continue
            if not record["finished"]:
                unavailable += 1; continue
            try:
                body = self.session.send("Network.getResponseBody",{"requestId":rid})
                raw = base64.b64decode(body["body"]) if body.get("base64Encoded") else body["body"].encode()
                body_bytes += len(raw)
                data = json.loads(raw)
                if isinstance(data.get("items"),list):
                    fetched[record["kind"]] += len(data["items"])
                    if record["kind"] == "work": work.update(item["id"] for item in data["items"])
            except Exception:
                unavailable += 1
        collections = [r for _,r in records if r["collection"]]
        return {"phase":phase,"apiRequests":len(records),"collectionCalls":len(collections),
            "uniqueWorkFetched":len(work),"recordsFetched":dict(fetched),
            "collectionDecodedBodyBytes":body_bytes,
            "collectionEncodedTransferBytes":sum(r["encoded"] or 0 for r in collections),
            "unavailableCollectionBodies":unavailable,"requestBufferOverflow":self.overflow,
            "failedCollectionResponses":sum(r["status"] != 200 for r in collections),
            "routes":dict(Counter(f"{r['method']} {r['path']}" for _,r in records))}


def snapshot(page,cdp):
    dom = page.evaluate("""() => ({elements:document.querySelectorAll('*').length,
      renderedRows:document.querySelectorAll('.ws-list > li').length,
      renderedWorkRows:document.querySelectorAll('#ws-progress .ws-list > li,#ws-blocked .ws-list > li,#ws-open .ws-list > li,#ws-parked .ws-list > li,#ws-finished .ws-list > li').length,
      viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},
      overflow:document.documentElement.scrollWidth > innerWidth})""")
    try:
        metrics = {m["name"]:m["value"] for m in cdp.send("Performance.getMetrics")["metrics"]}
        dom["targetJSHeapUsedBytes"] = metrics.get("JSHeapUsedSize")
        dom["targetDOMCountersIncludingDetached"] = cdp.send("Memory.getDOMCounters")
    except Exception:
        dom["targetJSHeapUsedBytes"] = None; dom["targetDOMCountersIncludingDetached"] = None
    return dom


def distribution(values,target,seconds):
    ordered = sorted(values)
    p95 = ordered[math.ceil(.95*len(ordered))-1] if ordered else None
    return {"samples":len(values),"warmupActions":30,"measuredSeconds":seconds,
        "p95Ms":p95,"maxMs":max(values) if values else None,"targetP95Ms":target,
        "passed":len(values)>=200 and seconds>=60 and p95 is not None and p95<=target,
        "durationsMs":values}


def verified_traffic(traffic):
    return not any(traffic[key] for key in ("unavailableCollectionBodies","requestBufferOverflow","failedCollectionResponses"))


def fetch_bound(traffic):
    return verified_traffic(traffic) and traffic["uniqueWorkFetched"]<=100 and traffic["collectionCalls"]<=4


def following_frame(page):
    page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")


def usable(page):
    page.wait_for_function("window.__nativeWorkProbe?.nav !== null && window.__nativeWorkProbe?.nav !== undefined",timeout=20000)
    return page.evaluate("window.__nativeWorkProbe.nav")


def run_profile(browser,data,label,viewport,cpu,report):
    context = browser.new_context(base_url=ORIGIN,storage_state=data["states"][0],
        viewport=viewport,device_scale_factor=1,color_scheme="light",locale="en-GB",timezone_id="Europe/Warsaw")
    context.add_init_script(PROBE)
    page = context.new_page(); page.set_default_timeout(12000)
    cdp = context.new_cdp_session(page); cdp.send("Performance.enable")
    cdp.send("Emulation.setCPUThrottlingRate",{"rate":cpu})
    traffic = Traffic(cdp)
    item = {"label":label,"viewport":viewport,"dpr":1,"cpuThrottlingRate":cpu,
        "cpuScope":"Chromium target only; API/database/worker uncapped",
        "navigationSemantics":"fresh document, same browser process/cache/session",
        "paintSemantics":"verified actual DOM and double-rAF following-frame proxy",
        "distributions":{},"memorySamples":[],"initialNavigationSamples":[],
        "mutatingRequests":{},"continuity":{}}
    report["profiles"].append(item)
    url = f"/projects/{data['project']}/tasks?view=list"
    try:
        # Probe one initial load before numeric distributions, retaining its actual bytes/counts.
        traffic.begin("initial"); page.goto(url,wait_until="domcontentloaded"); usable(page)
        item["initialTraffic"] = traffic.collect("initial")
        item["initialDOM"] = snapshot(page,cdp)
        item["initialFetchBoundPassed"] = fetch_bound(item["initialTraffic"])
        item["initialRenderBoundPassed"] = item["initialDOM"]["renderedWorkRows"]<=200
        page.screenshot(path=str(OUT/f"native-work-{label}.png"))
        targets = {"navigation":2000*cpu if cpu==1 else 4000,"input":100 if cpu==1 else 200,
                   "view":150 if cpu==1 else 300,"scroll":100 if cpu==1 else 200}
        for kind in ("navigation","input","view","scroll"):
            values = []; driver_navigation = []; started = None
            item["currentPhase"] = kind
            item["distributions"][kind] = {"samples":0,"durationsMs":values,"complete":False,"passed":False}
            if kind != "navigation":
                page.goto(url,wait_until="domcontentloaded"); usable(page)
            if kind == "scroll":
                page.evaluate("document.querySelector('.ws-tasks').closest('.pane-scroll').scrollTop=600")
                following_frame(page)
            traffic.begin(kind)
            for index in range(230):
                item["currentAction"] = index
                if index == 30: started = time.monotonic()
                if kind == "navigation":
                    traffic.begin("initial")
                    driver_started = time.monotonic(); page.goto(url,wait_until="domcontentloaded")
                    sample = usable(page)
                    driver_ms = (time.monotonic()-driver_started)*1000
                    collected = traffic.collect("initial")
                    if index >= 30:
                        item["initialNavigationSamples"].append(collected)
                        driver_navigation.append(driver_ms)
                else:
                    if kind == "input":
                        if not page.locator(".create__title").is_visible(): page.get_by_role("button",name=re.compile("^(New )?Task$")).first.click()
                        field = page.locator(".create__title"); field.focus()
                        before = field.input_value(); key = "a" if index%2 == 0 else "Backspace"
                        expected = before+"a" if key == "a" else before[:-1]
                        assert expected != before, "each native key action must change the input"
                        page.evaluate("expected => window.__nativeWorkProbe.arm('input',{value:expected})",expected)
                        page.keyboard.press(key)
                    elif kind == "view":
                        view = "Blocked" if index%2 == 0 else "All"; rows = 150 if view == "Blocked" else 1013
                        button = page.get_by_role("navigation",name="Task views").get_by_role("button",name=re.compile(f"^{view}"))
                        assert button.get_attribute("aria-pressed") == "false", "view click must change selection"
                        page.evaluate("e => window.__nativeWorkProbe.arm('view',e)",{"view":view,"rows":rows})
                        button.click()
                    else:
                        box = page.locator(".ws-tasks").locator("..").bounding_box()
                        assert box, "the native list pane must be rendered"
                        page.mouse.move(box["x"]+box["width"]*.5,box["y"]+box["height"]*.65)
                        page.evaluate("window.__nativeWorkProbe.arm('scroll',{})")
                        page.mouse.wheel(0,180 if index%2 == 0 else -180)
                    page.wait_for_function("window.__nativeWorkProbe.sample !== null",timeout=12000)
                    sample = page.evaluate("window.__nativeWorkProbe.sample")
                    assert sample["trusted"] and sample["changed"], "sample must contain a trusted actual event and changed native state"
                if index >= 30:
                    values.append(sample["duration"])
                    item["distributions"][kind]["samples"] = len(values)
                    if (index-30)%10 == 0: item["memorySamples"].append(snapshot(page,cdp))
                    page.wait_for_timeout(310)  # >=60 seconds; browser remains live between real actions.
                if index in (29,79,129,179,229):
                    write_report(report)
                    print(f"{label}: {kind} {max(0,index-29)}/200 measured",flush=True)
            item["distributions"][kind] = distribution(values,targets[kind],time.monotonic()-started)
            item["distributions"][kind]["complete"] = True
            if kind == "navigation": item["distributions"][kind]["driverNavigationMs"] = driver_navigation
            else: item["distributions"][kind]["trafficIncluding15sRevalidation"] = traffic.collect(kind)
            write_report(report)
        # Native continuity is a separate observation, not a fabricated passing sample.
        item["currentPhase"] = "continuity"
        page.goto(url,wait_until="domcontentloaded"); usable(page)
        page.get_by_role("button",name=re.compile("^(New )?Task$")).first.click()
        field = page.locator(".create__title"); draft = "Compare privacy and sensor range before the next library test"
        field.fill(draft); field.focus(); page.keyboard.press("End")
        selection_before = field.evaluate("el => ({start:el.selectionStart,end:el.selectionEnd,focused:document.activeElement===el})")
        page.set_viewport_size({"width":820,"height":1000}); following_frame(page)
        page.set_viewport_size(viewport); following_frame(page)
        item["continuity"]["resizePreservesDraft"] = field.input_value()==draft
        item["continuity"]["resizePreservesFocusSelection"] = selection_before == field.evaluate("el => ({start:el.selectionStart,end:el.selectionEnd,focused:document.activeElement===el})")
        page.get_by_label("Only mine").check()
        item["continuity"]["onlyMinePreservesDraft"] = field.input_value()==draft
        item["continuity"]["onlyMineRows"] = page.locator(".ws-list > li").count()
        mine_counts = page.evaluate("""() => Object.fromEntries([...document.querySelectorAll('.ws-view')].slice(1).map(b => [b.childNodes[0].textContent.trim(),Number(b.querySelector('.ws-view__n')?.textContent)]))""")
        item["continuity"]["onlyMineCounts"] = mine_counts
        item["continuity"]["onlyMineCountsVerified"] = item["continuity"]["onlyMineRows"]==506 and mine_counts=={
            "Needs you":1,"In progress":150,"Blocked":75,"Open":235,"Parked":15,"Finished":25,"Results":5}
        page.get_by_label("Only mine").uncheck()
        page.get_by_role("navigation",name="Task views").get_by_role("button",name=re.compile("^Blocked")).click()
        item["continuity"]["viewPreservesDraft"] = field.input_value()==draft
        deep = page.locator(".ws-item").filter(has=page.locator(".ws-item__t",has_text=data["deep"]["title"]))
        traffic.begin("deepDetails"); deep.click()
        page.locator("#details").get_by_role("heading",name=data["deep"]["title"],exact=True).wait_for()
        item["deepDetailsTraffic"] = traffic.collect("deepDetails")
        item["continuity"]["deepNativeTitleVerified"] = True
        item["continuity"]["detailsPreservesDraft"] = field.input_value()==draft
        page.locator("#details").get_by_role("button",name="Close details").click()
        page.get_by_role("navigation",name="Task views").get_by_role("button",name=re.compile("^All$")).click()
        sourced = page.locator(".ws-item").filter(has=page.locator(".ws-item__t",has_text=data["sourced"]["title"]))
        sourced.click()
        panel = page.locator("#details")
        panel.get_by_role("heading",name=data["sourced"]["title"],exact=True).wait_for()
        source = panel.get_by_role("link",name=re.compile("^Message:"))
        source.click()
        page.wait_for_url(re.compile(r"/conversations/"))
        page.locator(".project-convo__feed").wait_for()
        if panel.get_by_role("button",name="Close details").is_visible():
            panel.get_by_role("button",name="Close details").click()
        page.get_by_role("navigation",name="Project views").get_by_role("link",name=re.compile("^Tasks")).click()
        field.wait_for()
        item["continuity"]["sourceRoundTripPreservesDraft"] = field.input_value()==draft
        item["continuity"]["sourceRoundTripNativeRouteVerified"] = True
        item["continuity"]["sourceRoundTripDraftLength"] = len(field.input_value())
        item["mutatingRequests"] = dict(traffic.mutations)
        item["memorySemantics"] = "80 samples across measured distributions; target JS heap and target DOM (including detached nodes), not driver/container RSS"
        heaps = [s["targetJSHeapUsedBytes"] for s in item["memorySamples"] if s["targetJSHeapUsedBytes"] is not None]
        item["sampledTargetHeapPeakBytes"] = max(heaps) if heaps else None
        item["sampledRenderedWorkRowPeak"] = max(s["renderedWorkRows"] for s in item["memorySamples"])
        item["laterRenderBoundPassed"] = item["sampledRenderedWorkRowPeak"]<=200
        item["measuredInitialTraffic"] = {"samples":len(item["initialNavigationSamples"]),
            "verified":sum(verified_traffic(t) for t in item["initialNavigationSamples"]),
            "withinBounds":sum(fetch_bound(t) for t in item["initialNavigationSamples"])}
        item["currentPhase"] = "complete"
    finally:
        item["mutatingRequests"] = dict(traffic.mutations)
        context.close(); write_report(report)


def write_report(report):
    OUT.mkdir(parents=True,exist_ok=True)
    (OUT/"native-work-performance.json").write_text(json.dumps(report,indent=2)+"\n")


def main():
    if UPSTREAM: start_forwarder(ORIGIN,UPSTREAM)
    report = {"schema":1,"sourceCommit":os.environ.get("FLUX_PERF_SOURCE_COMMIT","unavailable"),
        "harnessSHA256":hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "startedUTC":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime()),"profiles":[],
        "complete":False,"outcome":"running","failure":None}
    write_report(report)
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            report["browser"] = browser.version
            data = fixture(browser); report["fixture"] = data["summary"]; write_report(report)
            for label,viewport,cpu in (("desktop",{"width":1280,"height":800},1),("phone-cpu4",{"width":390,"height":844},4)):
                run_profile(browser,data,label,viewport,cpu,report)
            verifier = browser.new_context(base_url=ORIGIN,storage_state=data["states"][0])
            current = []
            for offset in range(0,1000,100):
                current.extend(api(verifier,"GET",f"/api/v1/projects/{data['project']}/work?limit=100&offset={offset}")["items"])
            report["nativeWorkUnchanged"] = len(current)==1000 and work_digest(current)==data["workDigest"]
            report["nativeWorkDigestBefore"] = data["workDigest"]
            report["nativeWorkDigestAfter"] = work_digest(current)
            verifier.close()
            # Same native content at 3840px; one observation, never a latency distribution/device claim.
            context = browser.new_context(base_url=ORIGIN,storage_state=data["states"][0],viewport={"width":3840,"height":2160},device_scale_factor=1)
            context.add_init_script(PROBE); page = context.new_page()
            page.goto(f"/projects/{data['project']}/tasks?view=list",wait_until="domcontentloaded"); usable(page)
            cdp = context.new_cdp_session(page); cdp.send("Performance.enable")
            report["wideObservation"] = snapshot(page,cdp)
            page.screenshot(path=str(OUT/"native-work-wide.png")); context.close(); browser.close()
        report["complete"] = True
        failure_names = []
        if not report["nativeWorkUnchanged"]: failure_names.append("nativeWorkChanged")
        for p in report["profiles"]:
            for key in ("initialFetchBoundPassed","initialRenderBoundPassed","laterRenderBoundPassed"):
                if not p[key]: failure_names.append(f"{p['label']}:{key}")
            if p["measuredInitialTraffic"]["withinBounds"] != 200:
                failure_names.append(f"{p['label']}:measuredInitialFetchBound")
            for key in CONTINUITY:
                if not p["continuity"].get(key,False): failure_names.append(f"{p['label']}:{key}")
            for key,d in p["distributions"].items():
                if not d["passed"]: failure_names.append(f"{p['label']}:{key}:distribution")
                if "trafficIncluding15sRevalidation" in d and not verified_traffic(d["trafficIncluding15sRevalidation"]):
                    failure_names.append(f"{p['label']}:{key}:collectionTrafficUnverified")
            if not verified_traffic(p["deepDetailsTraffic"]):
                failure_names.append(f"{p['label']}:deepDetailsTrafficUnverified")
            unexpected_mutations = {route:count for route,count in p["mutatingRequests"].items()}
            # Tasks/source routes do not issue ordinary read acknowledgments in this source.
            p["unexpectedMutatingRequests"] = unexpected_mutations
            if unexpected_mutations: failure_names.append(f"{p['label']}:unexpectedMutation")
        report["observedFailures"] = failure_names
        if report["wideObservation"]["renderedWorkRows"]>200: failure_names.append("wide:renderBound")
        failures = bool(failure_names)
        report["outcome"] = "completed-baseline-with-observed-failures" if failures else "completed-measurement-within-proposed-budgets"
        write_report(report)
        print(report["outcome"],flush=True)
        return 1 if failures else 0
    except Exception as error:
        # Exceptions may contain private native URLs/payloads; retain only type + fixed phase.
        report["outcome"] = "incomplete-harness-run"; report["failure"] = type(error).__name__
        write_report(report); print(f"harness incomplete: {type(error).__name__}",flush=True)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
