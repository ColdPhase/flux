"""Every Settings page lays out the same after a full load as after in-app navigation (v0.2.1 UI audit P2-1; final design, principle 7).

settings.css and a screen's own stylesheet are separate chunks, and a full load (a typed address, a reload, a link from outside) inserts
them in another order than moving inside the app does. Where two rules of the same weight set one property, the page then differed with
how it was reached: Settings › AI's faces were 24 px instead of 36 and its headings grew by 14 px after a reload. tests/app/
settings-style-order.test.ts finds such rule pairs in the sources; this module measures the rendered pages. For every Settings page,
with realistic content (an API key, Assistant and Planner with something remembered, a connected Claude Code, a second person), it loads
the page directly, then opens Home and moves to the page inside the app, and compares the box of every element of the page column: its
rows, faces, headings and buttons. Computer (1440 × 900) and phone (390 × 844, touch); FLUX_UI_BROWSER selects chromium or webkit.
"""

from __future__ import annotations

import os
import time
import unittest

from playwright.sync_api import Browser, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, start_forwarder

UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
if UI_BROWSER not in ("chromium", "webkit"):
    raise ValueError(f"FLUX_UI_BROWSER must be chromium or webkit, got {UI_BROWSER!r}")

PASSWORD = "settings look the same however you come"
STAMP = int(time.time() * 1000)
PEOPLE = {"ada": ("Ada Kowalska", f"ada.order+{STAMP}@example.test"), "ben": ("Ben Okafor", f"ben.order+{STAMP}@example.test")}
KEY = f"sk-ant-api03-{'load-order-key-' * 3}LO01"

# The box of every element in the page column, relative to the column's own top left, so the scroll position does not count. An SVG is
# one box (a Kreska's strokes may move while it blinks); what is hidden is left out.
MEASURE = """() => {
  const page = document.querySelector('.sset__page');
  if (!page) return null;
  const column = page.querySelector('.pane-in') ?? page;
  const origin = column.getBoundingClientRect();
  const out = [];
  const walk = (node, path) => {
    let index = 0;
    for (const child of node.children) {
      const key = `${path}/${child.tagName.toLowerCase()}${child.classList.length ? '.' + [...child.classList].join('.') : ''}[${index++}]`;
      const style = getComputedStyle(child);
      if (style.display === 'none') continue;
      const r = child.getBoundingClientRect();
      out.push({key, x: Math.round((r.left - origin.left) * 2) / 2, y: Math.round((r.top - origin.top) * 2) / 2,
        w: Math.round(r.width * 2) / 2, h: Math.round(r.height * 2) / 2,
        css: `display ${style.display}; margin ${style.margin}; padding ${style.padding}; gap ${style.gap}; font ${style.fontSize}/${style.lineHeight} ${style.fontWeight}`});
      if (child.tagName.toLowerCase() !== 'svg') walk(child, key);
    }
  };
  walk(column, '');
  return {busy: !!page.querySelector('[aria-busy="true"], .surface-skeleton, .inbox__loading'), boxes: out};
}"""


class SettingsLoadOrder(unittest.TestCase):
    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=15000)
        for who, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(service_workers="block", base_url=ORIGIN)
            response = context.request.post("/api/auth/sign-up/email", data={"name": name, "email": email, "password": PASSWORD}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.states[who] = context.storage_state()
            context.close()
        context = cls.browser.new_context(service_workers="block", base_url=ORIGIN, storage_state=cls.states["ada"])

        def api(method: str, path: str, body: dict | None = None, status: int = 200) -> dict:
            response = context.request.fetch(path, method=method, headers={"origin": ORIGIN}, data=body)
            assert response.status == status, f"{method} {path}: {response.status} {response.text()}"
            return response.json() if response.text() else {}

        ws = api("POST", "/api/v1/workspaces", {"name": "Riverside Makers"}, 201)
        api("POST", f"/api/v1/workspaces/{ws['id']}/members", {"email": PEOPLE["ben"][1], "role": "member"}, 201)
        api("POST", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Tool library", "visibility": "workspace"}, 201)
        # An API key of her own: the server makes Assistant with it. Planner is a second agent, with something it remembers.
        api("POST", "/api/v1/background-compute-connections", {"name": "Ada's Anthropic key", "provider": "anthropic", "model": "claude-sonnet-5",
            "apiKey": KEY, "dailyBudgetCents": 500, "timeZone": "Europe/Warsaw"}, 201)
        mine = api("GET", "/api/v1/my-agents")["items"]
        assert [item["name"] for item in mine] == ["Assistant"], mine
        cls.ids["assistant"] = mine[0]["id"]
        cls.ids["planner"] = api("POST", "/api/v1/my-agents", {"workspaceId": ws["id"], "name": "Planner"}, 201)["id"]
        api("POST", f"/api/v1/my-agents/{cls.ids['planner']}/memory", {"body": "Due dates fall on Fridays."}, 201)
        # Claude Code on her laptop: a row in Settings › AI and a card on its own page.
        coding = api("POST", f"/api/v1/workspaces/{ws['id']}/agents", {"name": "Ada's coding agent", "owner": "self"}, 201)
        api("POST", "/api/v1/integration/agent-connections", {"agentId": coding["id"], "name": "Ada's laptop", "clientDesignation": "claude_code"}, 201)
        context.close()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def pages(self) -> list[str]:
        return ["/settings/account", "/settings/appearance", "/settings/notifications", "/settings/agents", "/settings/company",
                "/settings/shortcuts", f"/settings/agents/{self.ids['assistant']}", f"/settings/agents/{self.ids['planner']}",
                "/settings/ai-connections", "/settings/agents/connect", "/settings/agents/claude-code", "/settings/agents/codex"]

    def page(self, *, phone: bool) -> Page:
        options = {"service_workers": "block", "base_url": ORIGIN, "storage_state": self.states["ada"], "locale": "en-GB", "reduced_motion": "reduce"}
        if phone:
            options.update(viewport=PHONE, is_mobile=True, has_touch=True, device_scale_factor=3)
        else:
            options.update(viewport=DESKTOP)
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def settled(self, page: Page, where: str) -> list[dict]:
        """The page's boxes once its reads are in: the same three times in a row, 250 ms apart, with nothing busy."""
        expect(page.locator(".sset__page")).to_be_visible()
        page.evaluate("document.fonts.ready.then(() => true)")
        last, same = None, 0
        for _ in range(60):
            now = page.evaluate(MEASURE)
            if now and not now["busy"] and len(now["boxes"]) >= 3 and now["boxes"] == last:
                same += 1
                if same >= 2:
                    return now["boxes"]
            else:
                same = 0
            last = now["boxes"] if now else None
            page.wait_for_timeout(250)
        self.fail(f"{where}: the page did not settle: {last and len(last)} boxes")

    def compare(self, path: str, direct: list[dict], moved: list[dict]) -> None:
        self.assertEqual([box["key"] for box in direct], [box["key"] for box in moved], f"{path}: the same elements both ways")
        different = [(a, b) for a, b in zip(direct, moved) if any(abs(a[side] - b[side]) > 1 for side in ("x", "y", "w", "h"))]
        # The first elements that differ are the cause; the ones after them only moved with them.
        report = "\n".join(f"  {a['key']}\n    full load: {a['x']},{a['y']} {a['w']}×{a['h']} ({a['css']})\n    in-app:    {b['x']},{b['y']} {b['w']}×{b['h']} ({b['css']})"
                           for a, b in different[:6])
        self.assertEqual(different, [], f"{path}: {len(different)} boxes differ between a full load and in-app navigation:\n{report}")

    def check(self, *, phone: bool) -> None:
        page = self.page(phone=phone)
        paths = (["/settings"] if phone else []) + self.pages()
        for path in paths:
            with self.subTest(path=path, phone=phone):
                page.goto(path)
                direct = self.settled(page, f"{path} (full load)")
                # Home first, as after signing in, with the code it fetches while the browser is idle (DeferredSurfaces, 1.2 s after
                # the shell), then the page by in-app navigation: no document is loaded again.
                page.goto("/")
                expect(page.locator(".sset__page")).to_have_count(0)
                page.wait_for_timeout(3000)
                page.evaluate("() => { window.__sameDocument = true; }")
                page.evaluate("path => { history.pushState(null, '', path); dispatchEvent(new PopStateEvent('popstate', {state: null})); }", path)
                expect(page).to_have_url(f"{ORIGIN}{path}")
                moved = self.settled(page, f"{path} (in-app)")
                self.assertTrue(page.evaluate("() => window.__sameDocument === true"), f"{path}: reached inside the app, without a reload")
                self.compare(path, direct, moved)

    def test_01_every_settings_page_on_the_computer(self) -> None:
        self.check(phone=False)

    def test_02_every_settings_page_on_the_phone(self) -> None:
        self.check(phone=True)


if __name__ == "__main__":
    unittest.main()
