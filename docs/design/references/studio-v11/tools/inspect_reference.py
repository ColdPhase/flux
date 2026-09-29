"""Render the unchanged supplied HTML with disposable local fixtures in Docker.
No model, remote participants, device access, or production backend is exercised.
"""
from pathlib import Path
import hashlib, json
from datetime import datetime, timezone
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
def lum(h):
    h=h.lstrip("#"); h="".join(c*2 for c in h) if len(h)==3 else h
    c=[int(h[i:i+2],16)/255 for i in [0,2,4]]
    c=[x/12.92 if x<=.04045 else ((x+.055)/1.055)**2.4 for x in c]
    return sum(x*y for x,y in zip(c,[.2126,.7152,.0722]))
def ratio(a,b):
    low,high=sorted([lum(a),lum(b)])
    return (high+.05)/(low+.05)
OUT = ROOT / "inspection"
OUT.mkdir(exist_ok=True)
html = ROOT / "supplied/flux-studio-v11.html"
report = {"html_sha256": hashlib.sha256(html.read_bytes()).hexdigest(), "zoom": "100%", "screenshots": [], "errors": [], "limits": "Local prototype fixtures only; no production ACL/persistence, LLM, hardware, remote media or end-user study."}
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
    report["browser"] = browser.version
    page = browser.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
    page.clock.install(time=datetime(2026, 9, 29, 12, 0, tzinfo=timezone.utc))
    report["fixture_clock"]="2026-09-29T12:00:00Z"
    page.on("pageerror", lambda e: report["errors"].append(str(e)))
    page.evaluate("""() => { const d = {}; Object.defineProperty(window, 'localStorage', {configurable:true, value:{getItem:k=>d[k]??null,setItem:(k,v)=>d[k]=String(v),removeItem:k=>delete d[k]}}); }""")
    page.set_content(html.read_text())
    def act(action, **data):
        return page.evaluate("([action, data]) => Flux.action(action, {dataset:data})", [action, data])
    def reset(width=1440, height=900, theme="dark", accent="mint"):
        page.evaluate("() => { document.activeElement?.blur(); document.querySelector('#app').innerHTML=''; Flux.reset(); }")
        page.set_viewport_size({"width":width,"height":height})
        act("theme-set", value=theme)
        act("accent-set", value=accent)
    def shot(name):
        page.evaluate("() => {document.querySelector('#toasts').innerHTML='';for(const e of document.querySelectorAll('#chat-scroll, #drawer-scroll, .view-scroll'))e.scrollTop=0;}")
        page.screenshot(path=str(OUT / name))
        report["screenshots"].append({"file":name,"viewport":page.viewport_size})
    pairs = []
    for theme in ["light", "dark"]:
        for accent in ["mint", "iris", "sky"]:
            reset(theme=theme, accent=accent)
            colors=page.evaluate("""() => {const s=getComputedStyle(document.documentElement);return Object.fromEntries(['bg','surface','text','muted','accent','on-accent','own','accent-soft'].map(k=>[k,s.getPropertyValue('--'+k).trim()]));}""")
            ratios={f"{fg}/{bg}":round(ratio(colors[fg],colors[bg]),2) for fg,bg in [("text","surface"),("muted","surface"),("accent","surface"),("on-accent","accent"),("text","own"),("accent","accent-soft")]}
            pairs.append({"theme":theme,"accent":accent,"colors":colors,"contrast":ratios})
            shot(f"conversation-1440-{theme}-{accent}.png")
    report["candidate_palettes"] = pairs
    for width,height in [(1440,900),(1280,800),(390,844),(768,1024)]:
        reset(width,height)
        act("return-open")
        shot(f"private-return-{width}.png")
        if width==1440:
            report["summary_button"] = page.locator(".summary-generate").evaluate("e=>({width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height,label:e.textContent})")
    reset()
    act("view",view="map")
    act("map-view",value="list")
    page.evaluate("""() => {const s=Flux.state;const base=s.nodes.n3;for(const [id,text,parent] of [['deep3','Zasilanie przy słabym świetle','n3'],['deep4','Pomiar poboru energii przy wykryciu gestu','deep3'],['newRoot','Nowy kierunek: lokalna analiza obrazu',null]]) {s.nodes[id]={...base,id,text,root:!parent,outlineParent:parent};if(parent)s.edges['fixture-'+id]={id:'fixture-'+id,a:parent,b:id,space:base.space,map:base.map,kind:'related'};} Flux.render();}""")
    before=page.evaluate("Flux11.buildOutline(Flux.ui.map)")
    shot("map-deep-before-1440.png")
    page.evaluate("""() => {Flux.state.edges['fixture-cross']={id:'fixture-cross',a:'newRoot',b:'deep4',space:'p1',map:'map1',kind:'related'};Flux.render();}""")
    after=page.evaluate("Flux11.buildOutline(Flux.ui.map)")
    report["deep_relation_fixture"]={"before_roots":before["roots"],"before_depth":before["depth"],"after_roots":after["roots"],"after_depth":after["depth"],"new_root_parent":after["parent"].get("newRoot"),"cross_edge_ids":[e["id"] for e in after["cross"]],"note":"Fixture injection tests presentation only, not the node/link creation UI or persistence."}
    shot("map-deep-after-1440.png")
    page.set_viewport_size({"width":390,"height":844})
    shot("map-deep-after-390.png")
    browser.close()
(OUT / "report.json").write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n")
print(f"{len(report['screenshots'])} renders; {len(report['errors'])} page errors")
print(json.dumps(report["deep_relation_fixture"],ensure_ascii=False))
