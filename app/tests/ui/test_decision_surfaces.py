"""Browser tests for the decision form's spacing and the proposed decision's surfaces (issues #692, #693).

Runs through scripts/check_ui.sh against the running Compose application, on the engine named by
FLUX_UI_BROWSER. One person owns a project with a current rule, a plain proposal and a proposal that
replaces the rule (a pivot over three tasks). For 390 x 844 and 1440 x 900, in light and dark, it
measures what a person sees:

* #692: in "Propose a decision" the pagination row, the "Propose decision" button and its help text
  keep the panel's rhythm: 28 px between sections (`.details__sec`), 8 px inside one (the heading's
  gap), and the help text never touches the button.
* #693: the proposal's title block and its "Accept" block paint no background of their own (the panel
  surface is the only one), and the title, the "Proposed" row, every section heading, the accept text
  and the button start on one left edge.
"""

from __future__ import annotations

import json
import time
import unittest

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, shot, start_forwarder

PASSWORD = "spacing is the first thing read"
STAMP = int(time.time() * 1000)
ADA = {"name": "Ada Lind", "email": f"ada.surfaces+{STAMP}@example.test"}
RULE = "Use a camera for gesture control"
PLAIN = "Keep a manual off switch on the lamp"
PIVOT = "Switch to a ToF distance sensor"
WHY = "The camera failed below 10 lux; a ToF sensor works in the dark and stores no images"
TASKS = ("Calibrate the sensor board", "Order the cable harness", "Write the safety note")
VIEWS = (("desktop", DESKTOP, False), ("phone", PHONE, True))
SCHEMES = ("light", "dark")

# Everything the page measures, in CSS pixels. `surface` is the nearest solid background behind the
# panel's content; `paints` lists every structural element that draws another background over it.
MEASURE = """(root) => {
  const rgba = (css) => { const m = css.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(parseFloat); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1, css }; };
  const solid = (node) => { for (let n = node; n; n = n.parentElement) { const c = rgba(getComputedStyle(n).backgroundColor); if (c && c.a > 0) return c; } return null; };
  const surface = solid(root.parentElement);
  const structural = new Set(['DIV', 'SECTION', 'FORM', 'P', 'H3', 'H4', 'DL', 'DT', 'DD', 'FIELDSET', 'NAV', 'UL', 'LI', 'HEADER', 'ARTICLE']);
  const paints = [];
  for (const el of [root, ...root.querySelectorAll('*')]) {
    if (!structural.has(el.tagName)) continue;
    const c = rgba(getComputedStyle(el).backgroundColor);
    if (!c || c.a === 0) continue;
    if (surface && c.css === surface.css) continue;
    const box = el.getBoundingClientRect();
    paints.push({ tag: el.tagName.toLowerCase(), cls: el.className, bg: c.css, w: Math.round(box.width), h: Math.round(box.height) });
  }
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
  const q = (sel) => root.querySelector(sel);
  const edge = root.getBoundingClientRect().left, end = root.getBoundingClientRect().right;
  // The left edge of every kind of content the panel shows: eyebrow, title, rows, headings, text, buttons.
  const lefts = [];
  const note = (name, el) => { if (el) lefts.push({ name, left: el.getBoundingClientRect().left - edge, right: end - el.getBoundingClientRect().right, submit: !!el.closest('.wd-submit') }); };
  note('eyebrow', q('.details__eyebrow')); note('title', q('.details__title')); note('lead', q('.details__lead'));
  root.querySelectorAll('.wd-rows dt').forEach((el) => note('row ' + el.textContent.trim(), el));
  root.querySelectorAll('.details__sec > h4').forEach((el) => note('heading ' + el.textContent.trim(), el));
  root.querySelectorAll('.details__sec > p, .wd-accept-finish > p').forEach((el) => note('text ' + el.textContent.trim().slice(0, 24), el));
  root.querySelectorAll('.wd-actions button, .wd-decide__foot .nyc__actions > button:first-child').forEach((el) => note('button ' + el.textContent.trim(), el));
  root.querySelectorAll('.wd-link > span:first-child').forEach((el) => note('link ' + el.textContent.trim().slice(0, 24), el));
  const sections = [...root.children].filter((el) => el.matches('.details__sec'));
  return {
    surface: surface && surface.css, paints, lefts,
    identity: box(q('.wd-decision-identity')), accept: box(q('.wd-accept')), finish: box(q('.wd-accept-finish')),
    pages: box(q('.ws-pages')), form: box(q('fieldset.wd-form')), actions: box(q('.wd-actions')), help: box(q('.wd-actions + p, .wd-submit > p')),
    audience: box(root.querySelector('section[aria-labelledby="wd-audience"]')),
    lead: box(q('.details__lead')), rows: box(q('.wd-rows')), decide: box(q('.wd-decide')),
    sectionGaps: sections.slice(1).map((el, i) => Math.round((el.getBoundingClientRect().top - sections[i].getBoundingClientRect().bottom) * 10) / 10),
    headingGap: (() => { const h = q('.details__sec > h4'); const n = h && h.nextElementSibling; return h && n ? Math.round((n.getBoundingClientRect().top - h.getBoundingClientRect().bottom) * 10) / 10 : null; })(),
  };
}"""


class DecisionSurfaces(unittest.TestCase):
    """Tests run in name order and share one account, one project and three decisions."""

    pw = None
    browser: Browser
    state: dict = {}
    project_id = ""
    plain_id = ""
    pivot_id = ""

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        assert cls.browser.browser_type.name == UI_BROWSER
        print(f"ACTUAL_UI_ENGINE={cls.browser.browser_type.name}", flush=True)
        expect.set_options(timeout=8000)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def context(self, *, view: dict, phone: bool, scheme: str, signed_in: bool = True) -> BrowserContext:
        options: dict = {"base_url": ORIGIN, "color_scheme": scheme, "locale": "en-GB", "timezone_id": "Europe/Warsaw", "viewport": view}
        if phone:
            options.update(device_scale_factor=3, is_mobile=True, has_touch=True)
        if signed_in and self.state:
            options["storage_state"] = self.state
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        return context

    def api(self, page: Page, method: str, path: str, body: dict | None = None, status: int | None = None) -> dict:
        response = page.request.fetch(f"{ORIGIN}{path}", method=method, headers={"origin": ORIGIN, "content-type": "application/json"},
                                      data=json.dumps(body) if body is not None else None)
        if status is not None:
            self.assertEqual(response.status, status, response.text())
        return json.loads(response.text()) if response.text() else {}

    def test_01_a_project_with_a_rule_a_proposal_and_a_pivot(self) -> None:
        page = self.context(view=DESKTOP, phone=False, scheme="light", signed_in=False).new_page()
        page.goto("/sign-up")
        page.get_by_label("Name").fill(ADA["name"])
        page.get_by_label("Email").fill(ADA["email"])
        page.get_by_label("Password").fill(PASSWORD)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        type(self).state = page.context.storage_state()
        ws = self.api(page, "POST", "/api/v1/workspaces", {"name": "Lamp studio"}, status=201)
        project = self.api(page, "POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Gesture lamp", "visibility": "restricted"}, status=201)
        type(self).project_id = project["id"]
        rule = self.api(page, "POST", f"/api/v1/projects/{project['id']}/decisions", {"title": RULE, "rationale": "It needs no extra hardware"}, status=201)
        self.api(page, "POST", f"/api/v1/decisions/{rule['id']}/accept", {"expectedVersion": 1}, status=200)
        type(self).plain_id = self.api(page, "POST", f"/api/v1/projects/{project['id']}/decisions", {"title": PLAIN, "rationale": WHY}, status=201)["id"]
        for title in TASKS:
            self.api(page, "POST", f"/api/v1/projects/{project['id']}/work", {"title": title}, status=201)
        type(self).pivot_id = self.api(page, "POST", f"/api/v1/projects/{project['id']}/decisions", {"title": PIVOT, "rationale": WHY, "supersedes": rule["id"]}, status=201)["id"]

    def opened(self, address: str, *, phone: bool, scheme: str, view: dict):
        """Opens `address` in Details and returns (page, the .wd panel content), the phone's sheet at full height."""
        page = self.context(view=view, phone=phone, scheme=scheme).new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        page.goto(address)
        host = page.get_by_role("dialog", name="Details") if phone else page.locator("#details")
        panel = host.locator(".wd").first
        expect(panel).to_be_visible()
        if phone:
            toggle = page.get_by_role("button", name="Show full height")
            if toggle.count():
                toggle.evaluate("el => el.click()")
                expect(page.locator(".ui-detent-sheet")).to_have_attribute("data-height", "full")
        return page, panel

    def measure(self, panel) -> dict:
        panel.page.wait_for_timeout(450)  # the panel's entrance has settled
        return panel.evaluate(MEASURE)

    def shots(self, page: Page, panel, name: str) -> None:
        scroller = panel.evaluate_handle("el => el.closest('.ui-panel__body') || el.parentElement")
        scroller.evaluate("el => { el.scrollTop = 0; }")
        shot(page, f"{name}-top")
        scroller.evaluate("el => { el.scrollTop = el.scrollHeight; }")
        shot(page, f"{name}-end")

    # ---------------------------------------------------------------- #692: the form's rhythm

    def test_02_the_form_keeps_the_panels_rhythm_around_its_button(self) -> None:
        for label, view, phone in VIEWS:
            for scheme in SCHEMES:
                with self.subTest(view=label, scheme=scheme):
                    page, panel = self.opened(f"/projects/{self.project_id}/tasks?open=propose-decision", phone=phone, scheme=scheme, view=view)
                    # One page of rules shows no pager (Spokój rule 4, #763 B6).
                    expect(panel.get_by_label("Replaces", exact=True)).to_be_enabled()
                    expect(panel.get_by_role("navigation", name="Current rule choices")).to_have_count(0)
                    panel.get_by_label("Decision", exact=True).fill("Keep a manual off switch")
                    expect(panel.get_by_role("button", name="Propose decision", exact=True)).to_be_enabled()
                    m = self.measure(panel)
                    self.shots(page, panel, f"form-{label}-{scheme}")
                    print(f"FORM {label} {scheme}: form->actions {m['actions']['top'] - m['form']['bottom']:.1f}, "
                          f"actions->help {m['help']['top'] - m['actions']['bottom']:.1f}, help->audience {m['audience']['top'] - m['help']['bottom']:.1f}, "
                          f"heading gap {m['headingGap']}", flush=True)
                    above = m["actions"]["top"] - m["form"]["bottom"]
                    between = m["help"]["top"] - m["actions"]["bottom"]
                    below = m["audience"]["top"] - m["help"]["bottom"]
                    self.assertAlmostEqual(above, 28, delta=1, msg="the button starts a section: the panel's 28 px below the fields")
                    self.assertAlmostEqual(between, m["headingGap"], delta=1, msg="the help text sits the heading's 8 px under the button")
                    self.assertGreaterEqual(between, 8, "the help text never touches the button")
                    self.assertAlmostEqual(below, 28, delta=1, msg="the next section starts 28 px below the help text")
                    self.assertAlmostEqual(above, below, delta=1, msg="sections are as far apart above the button as below its help")
                    self.assertEqual(m["paints"], [], "no element paints a background other than the panel's surface")
                    for part in m["lefts"]:
                        if part["submit"]:
                            # A panel form's primary sits at the right, under the fields it sends (#789 SP-5).
                            self.assertAlmostEqual(part["right"], 0, delta=1, msg=f"{part['name']} ends on the panel's right edge")
                        else:
                            self.assertAlmostEqual(part["left"], 0, delta=1, msg=f"{part['name']} starts on the panel's left edge")

    # ---------------------------------------------------------------- #693: surfaces and one left edge

    def check_proposal(self, kind: str, decision_id: str) -> None:
        for label, view, phone in VIEWS:
            for scheme in SCHEMES:
                with self.subTest(proposal=kind, view=label, scheme=scheme):
                    page, panel = self.opened(f"/projects/{self.project_id}/tasks?open=decision:{decision_id}", phone=phone, scheme=scheme, view=view)
                    expect(panel.get_by_role("heading", level=3)).to_be_visible()
                    expect(panel.get_by_role("button", name="Accept and pivot" if kind == "pivot" else "Accept", exact=True)).to_be_visible()
                    m = self.measure(panel)
                    self.shots(page, panel, f"{kind}-{label}-{scheme}")
                    print(f"PANEL {kind} {label} {scheme}: surface {m['surface']}, paints {m['paints']}, section gaps {m['sectionGaps']}, "
                          f"lefts {[(p['name'], round(p['left'], 1)) for p in m['lefts'] if abs(p['left']) > 1]}", flush=True)
                    self.assertEqual(m["paints"], [], "no element behind the title or the Accept block paints its own background")
                    for part in m["lefts"]:
                        self.assertAlmostEqual(part["left"], 0, delta=1, msg=f"{part['name']} starts on the panel's left edge")
                    # The answer is the Inbox card's (#763 D1): right under the reason, before the record rows.
                    self.assertGreaterEqual(m["decide"]["top"], m["lead"]["bottom"], "the answer follows the reason")
                    self.assertLessEqual(m["decide"]["bottom"], m["rows"]["top"], "the answer comes before the Proposed row")
                    self.assertTrue(m["sectionGaps"], "the panel has sections")
                    for gap in m["sectionGaps"]:
                        self.assertAlmostEqual(gap, 28, delta=1, msg=f"every section starts 28 px below the one before: {m['sectionGaps']}")

    def test_03_a_plain_proposal_has_one_surface_and_one_left_edge(self) -> None:
        self.check_proposal("plain", self.plain_id)

    def test_04_a_pivot_proposal_has_one_surface_and_one_left_edge(self) -> None:
        self.check_proposal("pivot", self.pivot_id)


if __name__ == "__main__":
    unittest.main()
