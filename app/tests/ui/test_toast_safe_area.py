"""The phone's feedback toast clears the real footer, with and without a bottom safe area (#639, part of #20 MOB-2).

A home-indicator iPhone in standalone mode has a bottom safe area of about 34 px. The Create control on a project's
views hangs above the dock, which sits above that inset, so the toast must take its offset from where the control
really is, not from a constant. Each journey raises a real toast (a task's state change on the Tasks view, which has
the Create control alone; "Accept" on Home, which has the Create control above the capsule of places) and measures
the toast against the footer's rendered edge: at least 8 px clear, no overlap, every control hit-tested and
inside the window, light and dark.

The inset is simulated with Chromium's `Emulation.setSafeAreaInsetsOverride`, and every journey first proves the
page really sees it (`env(safe-area-inset-bottom)` resolves to the simulated value), so the check cannot pass
vacuously. Playwright's WebKit offers no equivalent for `env()`: there only the zero-inset geometry is measured, and
the changing-inset journey is reported as skipped with that reason. The unverified part stays unverified there.

Runs with the other tests/ui journeys through scripts/check_ui.sh; FLUX_UI_BROWSER selects chromium (default) or webkit.
"""

from __future__ import annotations

import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import ORIGIN, PHONE, UI_BROWSER, UPSTREAM, start_forwarder

PASSWORD = "feedback clears the footer"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "ada": ("Ada Kowalska", f"ada.safe+{STAMP}@example.test"),
    "jonas": ("Jonas Berg", f"jonas.safe+{STAMP}@example.test"),
}
DECISION = "Water the beds at dawn; frost covers later"
# A home-indicator iPhone in standalone mode; the gap the design keeps above the footer.
INSET = 34
GAP = 8
# Chromium can simulate the inset; WebKit cannot, so it only measures the zero-inset geometry.
INSETS = (0, INSET) if UI_BROWSER == "chromium" else (0,)

# The toast against every footer element the route draws. Measured in the window, not assumed.
GEOMETRY = """() => {
  const toast = document.querySelector('.ui-toast');
  const t = toast.getBoundingClientRect();
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;visibility:hidden;padding-bottom:env(safe-area-inset-bottom)';
  document.body.append(probe);
  const inset = parseFloat(getComputedStyle(probe).paddingBottom);
  probe.remove();
  const intersects = (a, b) => Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top);
  const rect = (el) => { const r = el.getBoundingClientRect(); return {left: r.left, right: r.right, top: r.top, bottom: r.bottom}; };
  const footers = {};
  for (const [name, selector] of [['create', '.phone-fab'], ['places', '.ui-bottomnav'], ['search', '.phone-dock__search']]) {
    const el = document.querySelector(selector);
    if (el) footers[name] = {...rect(el), overlaps: intersects(t, el.getBoundingClientRect())};
  }
  const reachable = [...toast.querySelectorAll('button'), ...document.querySelectorAll('.phone-fab, .ui-bottomnav a, .phone-dock__search')].map((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return {name: el.getAttribute('aria-label') || el.textContent, width: r.width, height: r.height,
      hit: hit === el || el.contains(hit), within: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight};
  });
  return {inset, innerWidth, innerHeight, toast: rect(toast), footers, reachable};
}"""
SETTLED = """() => {
  const toast = document.querySelector('.ui-toast');
  return toast && getComputedStyle(toast).transform === 'none' && toast.getAnimations().every(a => a.playState !== 'running');
}"""


class ToastSafeArea(unittest.TestCase):
    """Tests run in name order and share two accounts, one project and its needs-you decision."""

    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    contexts: dict[str, BrowserContext] = {}
    ids: dict[str, str] = {}
    project_id = ""
    decision: dict = {}

    @classmethod
    def post(cls, who: str, path: str, body: dict | None = None) -> dict:
        response = cls.contexts[who].request.post(path, data=body or {}, headers={"origin": ORIGIN})
        assert response.status in (200, 201, 202), f"{path}: {response.status} {response.text()}"
        return response.json()

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        assert cls.browser.browser_type.name == UI_BROWSER
        print("\nActual toast safe-area engine: " + cls.browser.browser_type.name)
        expect.set_options(timeout=15000)
        for key, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(base_url=ORIGIN)
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.contexts[key] = context
        workspace = cls.post("ada", "/api/v1/workspaces", {"name": "Riverside Makers"})["id"]
        cls.post("ada", f"/api/v1/workspaces/{workspace}/members", {"email": PEOPLE["jonas"][1], "role": "member"})
        cls.project_id = cls.post("ada", f"/api/v1/workspaces/{workspace}/projects", {"name": "Community garden sensors", "visibility": "workspace"})["id"]
        cls.decision = cls.post("jonas", f"/api/v1/projects/{cls.project_id}/decisions", {"title": DECISION, "rationale": "Overwatering is the problem now."})
        for key, context in cls.contexts.items():
            cls.states[key] = context.storage_state()
        for _ in range(80):
            if cls.contexts["ada"].request.get("/api/v1/needs-you").json()["items"]:
                break
            time.sleep(0.25)

    @classmethod
    def tearDownClass(cls) -> None:
        for context in cls.contexts.values():
            context.close()
        cls.browser.close()
        cls.pw.stop()

    # ---------------------------------------------------------------- helpers

    def phone(self, *, dark: bool, inset: int = 0) -> Page:
        context = self.browser.new_context(base_url=ORIGIN, color_scheme="dark" if dark else "light", locale="en-GB", timezone_id="Europe/Warsaw",
                                           service_workers="block", storage_state=self.states["ada"], viewport=PHONE, device_scale_factor=3,
                                           is_mobile=True, has_touch=True)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        if inset:
            self.set_inset(page, inset)
        return page

    def set_inset(self, page: Page, inset: int) -> None:
        """Chromium only: the page's env(safe-area-inset-bottom) becomes this many pixels."""
        self.assertEqual(UI_BROWSER, "chromium", "only Chromium can simulate a safe area")
        session = getattr(page, "_safe_area_session", None) or page.context.new_cdp_session(page)
        page._safe_area_session = session  # type: ignore[attr-defined]  # one live session keeps the override
        session.send("Emulation.setSafeAreaInsetsOverride", {"insets": {"top": 0, "left": 0, "bottom": inset, "right": 0}})

    def new_task(self, title: str) -> None:
        self.post("ada", f"/api/v1/projects/{self.project_id}/work", {"title": title, "owner": {"kind": "human", "id": self.ids["ada"]}, "clientCommandId": str(uuid.uuid4())})

    def assert_clear(self, page: Page, inset: int, footers: set[str], label: str) -> dict:
        """The toast is at least 8 px above the highest footer element, overlaps none, and every control can be pressed."""
        page.wait_for_function("() => document.getAnimations().every(a => a.playState !== 'running' || a.effect?.getComputedTiming().endTime === Infinity)")
        page.wait_for_function(SETTLED)
        # A change of the inset reaches the published edge on the next frame; the end state is what must hold.
        deadline = time.time() + 3
        while True:
            observed = page.evaluate(GEOMETRY)
            footers_top = [item["top"] for item in observed["footers"].values()]
            if (footers_top and min(footers_top) - observed["toast"]["bottom"] >= GAP and observed["inset"] == inset) or time.time() > deadline:
                break
            page.wait_for_timeout(50)
        # The override really reached the page; otherwise a pass would prove nothing about a safe area.
        self.assertEqual(observed["inset"], inset, f"{label}: the page sees a {inset}px bottom safe area")
        self.assertEqual(set(observed["footers"]), footers, f"{label}: the footer this route draws")
        top = min(item["top"] for item in observed["footers"].values())
        clearance = top - observed["toast"]["bottom"]
        self.assertGreaterEqual(clearance, GAP, f"{label}: the toast keeps {GAP}px above the footer {observed}")
        self.assertLessEqual(clearance, 2 * GAP, f"{label}: the toast follows the footer's edge instead of floating away {observed}")
        for name, item in observed["footers"].items():
            self.assertFalse(item["overlaps"], f"{label}: the toast covers {name} {observed}")
        self.assertGreaterEqual(observed["toast"]["top"], 0, label)
        self.assertGreaterEqual(observed["toast"]["left"], 0, label)
        self.assertLessEqual(observed["toast"]["right"], observed["innerWidth"], label)
        for control in observed["reachable"]:
            self.assertGreaterEqual(control["width"], 44, f"{label}: {control}")
            self.assertGreaterEqual(control["height"], 44, f"{label}: {control}")
            self.assertTrue(control["hit"] and control["within"], f"{label}: {control}")
        return observed

    # ---------------------------------------------------------------- the journeys

    def test_01_tasks_view_toast_clears_the_create_control_with_and_without_a_safe_area(self) -> None:
        for dark in (False, True):
            for inset in INSETS:
                with self.subTest(dark=dark, inset=inset):
                    title = f"Mulch the herb bed {uuid.uuid4().hex[:6]}"
                    self.new_task(title)
                    page = self.phone(dark=dark, inset=inset)
                    page.goto(f"/projects/{self.project_id}/tasks")
                    row = page.locator(".ws-task").filter(has_text=title)
                    row.get_by_role("button", name="Open. Set to In progress").tap()
                    expect(page.locator(".ui-toast")).to_contain_text("in progress")
                    self.assert_clear(page, inset, {"create"}, f"tasks dark={dark} inset={inset}")
                    page.locator(".ui-toast__close").first.tap()
                    expect(page.locator(".ui-toast")).to_have_count(0)

    def test_02_home_toast_clears_the_create_control_and_the_places(self) -> None:
        for dark in (False, True):
            for inset in INSETS:
                with self.subTest(dark=dark, inset=inset):
                    page = self.phone(dark=dark, inset=inset)
                    page.goto("/")
                    card = page.locator(".nyc").filter(has=page.get_by_role("button", name=re.compile("^Accept"))).first
                    card.get_by_role("button", name=re.compile("^Accept")).tap()
                    toast = page.locator(".ui-toast").filter(has_text="Accepted")
                    expect(toast).to_be_visible()
                    self.assert_clear(page, inset, {"create", "places", "search"}, f"home dark={dark} inset={inset}")
                    toast.get_by_role("button", name="Undo", exact=True).tap()
                    status = self.contexts["ada"].request.get(f"/api/v1/decisions/{self.decision['id']}").json()["status"]
                    self.assertEqual(status, "proposed", "Undo kept the decision proposed")

    def test_03_a_visible_toast_follows_a_changing_safe_area(self) -> None:
        if UI_BROWSER != "chromium":
            self.skipTest("Playwright WebKit cannot override env(safe-area-inset-*); a changing inset is verified in Chromium only")
        title = f"Label the seed trays {uuid.uuid4().hex[:6]}"
        self.new_task(title)
        page = self.phone(dark=False)
        page.goto(f"/projects/{self.project_id}/tasks")
        page.locator(".ws-task").filter(has_text=title).get_by_role("button", name="Open. Set to In progress").tap()
        expect(page.locator(".ui-toast")).to_contain_text("in progress")
        self.assert_clear(page, 0, {"create"}, "tasks before the inset")
        # A phone turning or a keyboard closing changes the inset together with a window resize.
        self.set_inset(page, INSET)
        page.set_viewport_size({"width": PHONE["width"], "height": PHONE["height"] - 1})
        self.assert_clear(page, INSET, {"create"}, "tasks after the inset appeared")
        self.set_inset(page, 0)
        page.set_viewport_size(PHONE)
        self.assert_clear(page, 0, {"create"}, "tasks after the inset went away")


if __name__ == "__main__":
    unittest.main()
