"""#135: real local preferences, composited palette states and persisted working surfaces.

All appearance changes use the running application's account controls. API setup creates
identical project/conversation/work/map content; it does not mock browser UI responses.
"""
from __future__ import annotations

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import expect, sync_playwright
from test_app_shell import DESKTOP, ORIGIN, PHONE, SHOTS, UPSTREAM, shot, start_forwarder

FAMILIES = ("Mint", "Iris", "Sky")
MEASURE = r"""(spec) => {
  const el = document.querySelector(spec.selector);
  if (!el) throw new Error('Missing contrast target: ' + spec.selector);
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', {willReadFrequently: true});
  function rgba(value) {
    ctx.clearRect(0,0,1,1); ctx.fillStyle=value; ctx.fillRect(0,0,1,1);
    const p=ctx.getImageData(0,0,1,1).data; return [p[0],p[1],p[2],p[3]/255];
  }
  function over(a,b) { return [0,1,2].map(i=>a[i]*a[3]+b[i]*(1-a[3])).concat(1); }
  function background(node) {
    const chain=[]; for(let n=node;n;n=n.parentElement) chain.unshift(n);
    return chain.reduce((bg,n)=>over(rgba(getComputedStyle(n).backgroundColor),bg), [255,255,255,1]);
  }
  const style=getComputedStyle(el,spec.pseudo||null);
  for(let n=el;n;n=n.parentElement) {
    if(Number(getComputedStyle(n).opacity)!==1) throw new Error('Contrast scope requires opaque target/ancestors: ' + spec.selector);
  }
  if(Number(style.opacity)!==1 || (spec.property==='stroke' && Number(style.strokeOpacity)!==1)) throw new Error('Contrast scope requires opaque pseudo/stroke: ' + spec.selector);
  let bg=background(spec.backgroundSelector ? document.querySelector(spec.backgroundSelector) : el);
  if(spec.pseudo) bg=over(rgba(style.backgroundColor),bg);
  const fg=over(rgba(style[spec.property||'color']),bg);
  function lum(p) { const c=p.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}); return c[0]*.2126+c[1]*.7152+c[2]*.0722; }
  const l=[lum(fg),lum(bg)].sort((a,b)=>b-a);
  return {selector:spec.selector,property:spec.property||'color',foreground:fg.slice(0,3),background:bg.slice(0,3),ratio:(l[0]+.05)/(l[1]+.05)};
}"""


class ThemeAccentsJourney(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        expect.set_options(timeout=8000)
        cls.state = None
        cls.measurements = []

    @classmethod
    def tearDownClass(cls):
        if SHOTS:
            (SHOTS / "accent-contrast.json").write_text(json.dumps(cls.measurements, indent=2) + "\n")
        cls.browser.close()
        cls.pw.stop()

    def page(self, *, signed_in=True, **options):
        context = self.browser.new_context(base_url=ORIGIN, viewport=DESKTOP, color_scheme="light", storage_state=self.state if signed_in else None, **options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def api(self, page, method, path, data=None, status=201):
        response = page.request.fetch(path, method=method, headers={"origin": ORIGIN, "content-type": "application/json", "idempotency-key": str(uuid.uuid4())}, data=json.dumps(data) if data is not None else None)
        self.assertEqual(response.status, status, response.text())
        return response.json()

    def account(self, page):
        # Wait for the authenticated shell loader; a missing desktop control is not a
        # narrow-layout signal while the route is still loading.
        page.locator(".app").wait_for(state="visible")
        # The same account control lives in the responsive sidebar drawer.
        if not page.locator(".me__btn").is_visible():
            page.get_by_role("button", name="Open navigation").click()
        page.locator(".me__btn").click()
        pop = page.get_by_role("dialog", name="Account", exact=True)
        expect(pop).to_be_visible()
        page.wait_for_function("document.querySelector('.me__pop')?.getAnimations().every(a => a.playState === 'finished' || a.playState === 'idle')")
        return pop

    def appearance(self, page, theme, family):
        pop = self.account(page)
        pop.get_by_role("radio", name=theme, exact=True).click()
        pop.get_by_role("radio", name=family, exact=True).click()
        expect(pop.get_by_role("radio", name=family, exact=True)).to_have_attribute("aria-checked", "true")
        page.keyboard.press("Escape")
        # If account was opened in the phone navigation drawer, close that separately.
        if page.get_by_role("button", name="Close navigation").is_visible():
            page.get_by_role("button", name="Close navigation").click()
        page.wait_for_timeout(200)

    def measure(self, page, theme, family, selector, minimum=4.5, **spec):
        # Measure resting production states after enter/loading motion. A persistent opacity
        # still fails this bounded wait and the independent guard in MEASURE.
        page.wait_for_function("""spec => {
          const el=document.querySelector(spec.selector); if(!el) return false;
          for(let n=el;n;n=n.parentElement) if(Number(getComputedStyle(n).opacity)!==1) return false;
          const s=getComputedStyle(el,spec.pseudo||null);
          return Number(s.opacity)===1 && (spec.property!=='stroke' || Number(s.strokeOpacity)===1);
        }""", arg={"selector": selector, **spec}, timeout=5000)
        value = page.evaluate(MEASURE, {"selector": selector, **spec})
        value.update(theme=theme, family=family, minimum=minimum)
        type(self).measurements.append(value)
        self.assertGreaterEqual(value["ratio"], minimum, value)

    def test_01_create_persisted_content(self):
        page = self.page()
        page.goto("/sign-up")
        page.get_by_label("Name").fill("Nia Berg")
        page.get_by_label("Email").fill(f"accent.nia+{time.time_ns()}@example.test")
        page.get_by_label("Password").fill("calm appearance afternoon")
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        type(self).state = page.context.storage_state()
        me = self.api(page, "GET", "/api/v1/me", status=200)["user"]["id"]
        ws = self.api(page, "POST", "/api/v1/workspaces", {"name": "Riverside Makers"})
        project = self.api(page, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Gesture lamp — bedside interaction study", "visibility": "restricted"})
        pid = project["id"]
        conversation = self.api(page, "POST", f"/api/v1/projects/{pid}/conversations", {"body": "Test the bedside lamp with a ToF sensor before committing to the enclosure. We need reliable gestures in a dark bedroom.", "clientMessageId": str(uuid.uuid4())})
        cid = conversation["id"]
        partner = self.page(signed_in=False)
        partner.goto("/sign-up")
        partner.get_by_label("Name").fill("Ari Nowak")
        partner_email = f"accent.ari+{time.time_ns()}@example.test"
        partner.get_by_label("Email").fill(partner_email)
        partner.get_by_label("Password").fill("calm appearance afternoon")
        partner.get_by_role("button", name="Create account").click()
        expect(partner.get_by_role("heading", level=1, name="Home")).to_be_visible()
        partner_id = self.api(partner, "GET", "/api/v1/me", status=200)["user"]["id"]
        self.api(page, "POST", f"/api/v1/workspaces/{ws['id']}/members", {"email": partner_email, "role": "member"})
        self.api(page, "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": partner_id}, "role": "contributor"})
        self.api(partner, "POST", f"/api/v1/conversations/{cid}/messages", {"body": "The camera detected only 38% of gestures at 5 lux. Keep the negative result and compare it with the distance sensor tomorrow.", "clientMessageId": str(uuid.uuid4())})
        self.api(page, "POST", f"/api/v1/projects/{pid}/work", {"title": "Compare gestures at 5 lux and document the failed camera experiment", "owner": {"kind": "human", "id": me}, "status": "in_progress", "sources": [{"type": "message", "id": conversation['messages'][0]['id']}]})
        self.api(page, "POST", f"/api/v1/projects/{pid}/work", {"title": "Order two VL53L5CX sensor boards", "status": "blocked"})
        self.api(page, "POST", f"/api/v1/projects/{pid}/work", {"title": "Record the measured camera limitation", "status": "done"})
        self.api(partner, "POST", f"/api/v1/projects/{pid}/decisions", {"title": "Prefer the ToF sensor for the next prototype", "rationale": "Camera performance at 5 lux does not meet the interaction requirement."})
        sketch = self.api(page, "POST", f"/api/v1/workspaces/{ws['id']}/sketches", {"title": "Sensing options and evidence", "scope": "project", "projectId": pid})
        first = self.api(page, "POST", f"/api/v1/sketches/{sketch['id']}/thoughts", {"text": "Reliable gestures in a dark bedroom", "x": 20, "y": 20})
        for i, text in enumerate(("ToF sensor: compare latency and coverage", "Camera: failed at 5 lux", "Diffuser: keep the electronics accessible")):
            self.api(page, "POST", f"/api/v1/sketches/{sketch['id']}/thoughts", {"text": text, "x": 40+i*260, "y": 180, "linkFrom": {"thoughtId": first['thought']['id']}})
        type(self).conversation_url = f"/projects/{pid}/conversations/{cid}"
        type(self).work_url = f"/projects/{pid}/tasks"
        type(self).map_url = f"/projects/{pid}/map/{sketch['id']}"

    def test_02_keyboard_persistence_system_and_fallback(self):
        page = self.page()
        page.goto(self.conversation_url)
        pop = self.account(page)
        group = pop.get_by_role("radiogroup", name="Accent", exact=True)
        self.assertEqual(group.get_by_role("radio").count(), 3)
        mint = group.get_by_role("radio", name="Mint", exact=True)
        expect(mint).to_have_attribute("aria-checked", "true")
        mint.focus()
        mint.press("ArrowRight")
        iris = group.get_by_role("radio", name="Iris", exact=True)
        expect(iris).to_be_focused()
        expect(iris).to_have_attribute("aria-checked", "true")
        iris.press("End")
        expect(group.get_by_role("radio", name="Sky", exact=True)).to_be_focused()
        group.get_by_role("radio", name="Sky", exact=True).press("Home")
        expect(mint).to_be_focused()
        mint.press("ArrowLeft")
        expect(group.get_by_role("radio", name="Sky", exact=True)).to_be_focused()
        page.wait_for_timeout(200)
        self.measure(page, "Light", "Sky", '[data-accent-option="sky"]', 3, property="outlineColor", backgroundSelector=".me__pop")
        pop.get_by_role("radio", name="Dark", exact=True).click()
        page.keyboard.press("Escape")
        expect(page.locator(".me__btn")).to_be_focused()
        page.reload()
        expect(page.locator("html")).to_have_attribute("data-accent", "sky")
        expect(page.locator("html")).to_have_attribute("data-theme", "dark")
        self.assertEqual(page.evaluate("localStorage.getItem('flux.accent')"), "sky")
        pop = self.account(page)
        pop.get_by_role("radio", name="System", exact=True).click()
        page.keyboard.press("Escape")
        page.emulate_media(color_scheme="dark")
        dark = page.locator("html").evaluate("e => getComputedStyle(e).getPropertyValue('--accent').trim()")
        page.emulate_media(color_scheme="light")
        light = page.locator("html").evaluate("e => getComputedStyle(e).getPropertyValue('--accent').trim()")
        self.assertNotEqual(light, dark)
        expect(page.locator("html")).to_have_attribute("data-accent", "sky")
        page.evaluate("localStorage.setItem('flux.accent','old-teal')")
        page.reload()
        expect(page.locator("html")).to_have_attribute("data-accent", "mint")
        pop = self.account(page)
        expect(pop.get_by_role("radio", name="Mint", exact=True)).to_have_attribute("aria-checked", "true")
        page.keyboard.press("Escape")
        # Refused browser storage still permits a visit-local preference.
        blocked = self.page()
        blocked.add_init_script("Storage.prototype.setItem = () => { throw new DOMException('Refused', 'SecurityError') }; Storage.prototype.getItem = () => { throw new DOMException('Refused', 'SecurityError') }")
        blocked.goto(self.conversation_url)
        self.appearance(blocked, "Dark", "Iris")
        expect(blocked.locator("html")).to_have_attribute("data-accent", "iris")

    def test_03_all_six_composited_surfaces(self):
        page = self.page()
        stable = {}
        for theme in ("Light", "Dark"):
            for family in FAMILIES:
                with self.subTest(theme=theme, family=family):
                    page.goto(self.conversation_url)
                    self.appearance(page, theme, family)
                    statuses = page.locator("html").evaluate("e => Object.fromEntries(['--ok','--danger','--warning','--attention','--resolution'].map(k => [k,getComputedStyle(e).getPropertyValue(k).trim()]))")
                    if theme in stable:
                        self.assertEqual(statuses, stable[theme], "semantic statuses stay fixed across families")
                    stable[theme] = statuses
                    self.measure(page, theme, family, ".project-convo__message p")
                    self.measure(page, theme, family, ".project-convo__message-meta")
                    textbox = page.locator(".composer__box textarea")
                    textbox.fill("I will compare the sensor tomorrow and attach the measured evidence.")
                    self.measure(page, theme, family, ".composer__box textarea")
                    send = page.locator(".composer__send")
                    for state in ("normal", "hover", "pressed"):
                        if state == "hover": send.hover()
                        if state == "pressed": page.mouse.down()
                        page.wait_for_timeout(250)
                        self.measure(page, theme, family, ".composer__send", 3, pseudo="::before")
                        if state == "pressed":
                            page.mouse.move(1, 1)
                            page.mouse.up()
                    shot(page, f"accent-{theme.lower()}-{family.lower()}-conversation-1440")
                    pop = self.account(page)
                    samples = page.locator(".me-accent__sample").evaluate_all("els => els.map(e => getComputedStyle(e).backgroundColor)")
                    expected = ["rgb(36, 115, 88)", "rgb(103, 66, 166)", "rgb(44, 96, 155)"] if theme == "Light" else ["rgb(142, 216, 184)", "rgb(183, 168, 239)", "rgb(148, 188, 243)"]
                    self.assertEqual(samples, expected, "each named sample keeps its own family regardless of the active choice")
                    self.measure(page, theme, family, f'[data-accent-option="{family.lower()}"]')
                    selected = pop.get_by_role("radio", name=family, exact=True)
                    selected.focus()
                    page.keyboard.press("Tab")
                    page.keyboard.press("Shift+Tab")
                    expect(selected).to_be_focused()
                    page.wait_for_timeout(200)
                    self.assertEqual(selected.evaluate("e => getComputedStyle(e).outlineWidth"), "2px")
                    self.measure(page, theme, family, f'[data-accent-option="{family.lower()}"]', 3, property="outlineColor", backgroundSelector=".me__pop")
                    shot(page, f"accent-{theme.lower()}-{family.lower()}-settings-1440")
                    page.keyboard.press("Escape")
                    page.get_by_role("button", name=re.compile("^What matters")).click()
                    expect(page.locator("#details").get_by_role("heading", name="What matters")).to_be_visible()
                    self.measure(page, theme, family, ".wm-period")
                    self.measure(page, theme, family, ".wm-link")
                    expect(page.locator(".wm__foot .ui-btn--primary")).to_be_enabled()
                    primary = page.locator(".wm__foot .ui-btn--primary")
                    for state in ("normal", "hover", "pressed"):
                        if state == "hover": primary.hover()
                        if state == "pressed": page.mouse.down()
                        page.wait_for_timeout(250)
                        self.measure(page, theme, family, ".wm__foot .ui-btn--primary")
                        if state == "pressed":
                            page.mouse.move(1, 1)
                            page.mouse.up()
                    shot(page, f"accent-{theme.lower()}-{family.lower()}-recap-1440")
                    page.goto(self.map_url)
                    page.get_by_role("radio", name="Map", exact=True).click()
                    expect(page.locator(".sk-node")).to_have_count(4)
                    self.measure(page, theme, family, ".sk-edges path", 3, property="stroke")
                    page.locator(".sk-node").first.click()
                    self.measure(page, theme, family, ".sk-el")
                    shot(page, f"accent-{theme.lower()}-{family.lower()}-map-1440")
                    page.get_by_role("radio", name="List", exact=True).click()
                    page.locator(".sk-li-t").first.click()
                    self.measure(page, theme, family, ".sk-li-t")
                    self.measure(page, theme, family, ".sk-li-s")
                    shot(page, f"accent-{theme.lower()}-{family.lower()}-map-list-1440")
                    page.goto(self.work_url)
                    expect(page.get_by_text("Order two VL53L5CX sensor boards", exact=True)).to_be_visible()
                    self.measure(page, theme, family, ".ws-item__st")
                    self.measure(page, theme, family, ".ws-need")
                    self.measure(page, theme, family, ".ws-dot--done", 3, property="backgroundColor", backgroundSelector="#ws-finished .ws-item")
                    shot(page, f"accent-{theme.lower()}-{family.lower()}-work-1440")
                    page.goto("/")
                    shot(page, f"accent-{theme.lower()}-{family.lower()}-return-1440")

    def test_04_narrow_and_enlarged_text(self):
        page = self.page(has_touch=True)
        for theme in ("Light", "Dark"):
            for family in FAMILIES:
                page.set_viewport_size(DESKTOP)
                page.goto(self.conversation_url)
                self.appearance(page, theme, family)
                for name, size in (("phone", PHONE), ("tablet", {"width": 820, "height": 1180}), ("desktop-1280", {"width": 1280, "height": 800})):
                    page.set_viewport_size(size)
                    page.goto(self.conversation_url)
                    expect(page.locator(".composer__box textarea")).to_be_visible()
                    self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), size["width"])
                    shot(page, f"accent-{theme.lower()}-{family.lower()}-{name}-conversation")
                    page.get_by_role("button", name=re.compile("^What matters")).click()
                    expect(page.locator("#details").get_by_role("heading", name="What matters")).to_be_visible()
                    shot(page, f"accent-{theme.lower()}-{family.lower()}-{name}-recap")
                    # All six families have full desktop comparisons; Mint also has matched
                    # map/work/return on the two narrow viewports for hierarchy and density.
                    if family == "Mint" and name != "desktop-1280":
                        page.goto(self.map_url)
                        page.get_by_role("radio", name="Map", exact=True).click()
                        expect(page.locator(".sk-node")).to_have_count(4)
                        page.get_by_role("radio", name="List", exact=True).click()
                        expect(page.locator(".sk-li-t")).to_have_count(4)
                        shot(page, f"accent-{theme.lower()}-{family.lower()}-{name}-map-list")
                        page.goto(self.work_url)
                        expect(page.get_by_text("Order two VL53L5CX sensor boards", exact=True)).to_be_visible()
                        shot(page, f"accent-{theme.lower()}-{family.lower()}-{name}-work")
                        page.goto("/")
                        shot(page, f"accent-{theme.lower()}-{family.lower()}-{name}-return")
                page.set_viewport_size(PHONE)
                page.goto(self.conversation_url)
                page.add_style_tag(content=":root { --fs-xs:15px; --fs-sm:16.25px; --fs-md:17.5px; --fs-base:18.75px; --fs-lg:21.25px; --fs-xl:25px; --fs-2xl:30px; }")
                expect(page.locator(".composer__box textarea")).to_be_visible()
                shot(page, f"accent-{theme.lower()}-{family.lower()}-phone-text-125-conversation")
                self.account(page)
                pop = page.get_by_role("dialog", name="Account", exact=True)
                for family_label in FAMILIES:
                    expect(pop.get_by_role("radio", name=family_label, exact=True)).to_be_visible()
                self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), PHONE["width"])
                shot(page, f"accent-{theme.lower()}-{family.lower()}-phone-text-125-settings")
                if family == "Mint":
                    page.set_viewport_size({"width": 390, "height": 500})
                    pop.get_by_role("radio", name="Sky", exact=True).scroll_into_view_if_needed()
                    expect(pop.get_by_role("radio", name="Sky", exact=True)).to_be_visible()
                    rect = pop.bounding_box()
                    self.assertGreaterEqual(rect["y"], 0, "account popover remains on the short viewport")
                    self.assertLessEqual(rect["y"] + rect["height"], 500)
                    shot(page, f"accent-{theme.lower()}-{family.lower()}-phone-short-125-settings")

    def test_05_error_text_all_six(self):
        for theme in ("Light", "Dark"):
            for family in FAMILIES:
                page = self.page(signed_in=False)
                page.add_init_script(f"localStorage.setItem('flux.theme', '{theme.lower()}'); localStorage.setItem('flux.accent', '{family.lower()}')")
                page.goto("/sign-up")
                page.get_by_role("button", name="Create account").click()
                expect(page.get_by_text("Enter the name people will see.")).to_be_visible()
                self.measure(page, theme, family, ".ui-field__error")
                self.measure(page, theme, family, ".ui-btn--primary")
                shot(page, f"accent-{theme.lower()}-{family.lower()}-form-error-1440")
