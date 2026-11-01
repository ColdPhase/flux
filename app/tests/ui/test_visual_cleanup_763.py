"""Regressions for the last UI cleanup of the visual consistency sweep (#763, comment 6556237285).

Run once with FLUX_UI_BROWSER=chromium and once with webkit. Each test measures the running application:
- the task row's state glyph is not clipped by its row on a computer (1440);
- the Tasks board's "Move to…" stays inside its card on a tablet (820, touch);
- the project views stay inside the header at 1024 px;
- the header's Together, with nothing open to work on together, explains why on a click instead of looking disabled;
- icon buttons in the sidebar and the composer take the 32 px control token, with one icon size in the composer;
- a field without the shared input style (the new-message people search) has the --t3 placeholder, not the engine grey.
"""

from __future__ import annotations

import json
import time
import unittest

from playwright.sync_api import Browser, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, UI_BROWSER, UPSTREAM, shot, start_forwarder

STAMP = int(time.time() * 1000)
PASSWORD = "a tidy release for the garden"
PEOPLE = {
    "ada": ("Ada Kowalska", f"ada.vc+{STAMP}@example.test"),
    "jonas": ("Jonas Berg", f"jonas.vc+{STAMP}@example.test"),
}
TABLET = {"width": 820, "height": 1180}
LAPTOP = {"width": 1024, "height": 768}


class VisualCleanup763(unittest.TestCase):
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
        contexts = {}
        for key, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(base_url=ORIGIN, service_workers="block")
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            contexts[key] = context

        def api(who: str, path: str, body: dict) -> dict:
            response = contexts[who].request.post(path, data=json.dumps(body), headers={"origin": ORIGIN, "content-type": "application/json"})
            assert response.status < 300, f"{path}: {response.status} {response.text()}"
            return response.json()

        workspace = api("ada", "/api/v1/workspaces", {"name": "Riverside Makers"})["id"]
        api("ada", f"/api/v1/workspaces/{workspace}/members", {"email": PEOPLE["jonas"][1], "role": "member"})
        cls.workspace = workspace
        cls.project = api("ada", f"/api/v1/workspaces/{workspace}/projects", {"name": "Community garden sensors", "visibility": "workspace"})["id"]
        me = {"kind": "human", "id": cls.ids["ada"]}
        api("ada", f"/api/v1/projects/{cls.project}/work", {"title": "Calibrate the soil moisture probes", "owner": me, "status": "in_progress"})
        api("ada", f"/api/v1/projects/{cls.project}/work", {"title": "Design a weatherproof enclosure", "owner": me, "status": "blocked", "blocker": "waiting for the probe size"})
        api("ada", f"/api/v1/projects/{cls.project}/work", {"title": "Order two spare gateways", "owner": me})
        for key, context in contexts.items():
            cls.states[key] = context.storage_state()
            context.close()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, viewport: dict, touch: bool = False) -> Page:
        options = dict(base_url=ORIGIN, viewport=viewport, storage_state=self.states["ada"], locale="en-GB", service_workers="block")
        if touch:
            options.update(is_mobile=UI_BROWSER == "chromium", has_touch=True)
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def test_01_task_glyph_is_whole_in_its_row(self) -> None:
        page = self.page(DESKTOP)
        page.goto(f"/projects/{self.project}/tasks?view=list")
        glyph = page.locator("li.ws-task button.ws-task__glyph").first
        expect(glyph).to_be_visible()
        glyph.hover()
        # Every corner of the 30 px hover circle's box is painted by the glyph itself: nothing clips it.
        whole = glyph.evaluate("""(el) => {
          const r = el.getBoundingClientRect();
          return [[r.left + 1, r.top + r.height / 2], [r.left + r.width / 2, r.top + 1], [r.right - 1, r.top + r.height / 2]]
            .every(([x, y]) => { const hit = document.elementFromPoint(x, y); return !!hit && (hit === el || el.contains(hit)); });
        }""")
        self.assertTrue(whole, "the glyph's hover circle is not cut by its row")
        self.assertEqual(glyph.evaluate("(el) => getComputedStyle(el.closest('li.ws-task')).overflow"), "visible")
        shot(page, "763-cleanup-task-glyph")

    def test_02_board_menu_stays_in_its_card_on_a_tablet(self) -> None:
        page = self.page(TABLET, touch=True)
        page.goto(f"/projects/{self.project}/tasks?view=board")
        cards = page.locator("li.tb-card")
        expect(cards.first).to_be_visible()
        for index in range(cards.count()):
            card = cards.nth(index)
            menu = card.get_by_role("button", name="Move to…")
            box, outer = menu.bounding_box(), card.bounding_box()
            self.assertGreaterEqual(box["height"], 44, "a 44 px touch target")
            self.assertLessEqual(box["x"] + box["width"], outer["x"] + outer["width"] + 0.5, "Move to… ends inside its card")
        shot(page, "763-cleanup-board-820")

    def test_03_views_fit_the_header_at_1024(self) -> None:
        page = self.page(LAPTOP)
        for view in ("", "/tasks", "/map", "/wiki", "/agents"):
            with self.subTest(view=view or "conversation"):
                page.goto(f"/projects/{self.project}{view}")
                header = page.locator("header.top")
                expect(header).to_be_visible()
                page.wait_for_timeout(300)
                over = header.evaluate("""(head) => {
                  const box = head.getBoundingClientRect();
                  const out = [];
                  for (const el of head.querySelectorAll('button, a[href], [role="tab"]')) {
                    const r = el.getBoundingClientRect();
                    if (!r.width || !el.checkVisibility()) continue;
                    let p = el.parentElement, cut = false;
                    while (p && p !== head.parentElement) {
                      const s = getComputedStyle(p), pr = p.getBoundingClientRect();
                      if (s.overflowX !== 'visible' && (r.right > pr.right + 0.5 || r.left < pr.left - 0.5)) cut = true;
                      p = p.parentElement;
                    }
                    if (cut || r.right > box.right + 0.5) out.push((el.getAttribute('aria-label') || el.textContent || '').trim());
                  }
                  return out;
                }""")
                self.assertEqual(over, [], "every header control is whole inside the header")
        shot(page, "763-cleanup-header-1024")

    def test_04_together_says_why_instead_of_looking_disabled(self) -> None:
        page = self.page(DESKTOP)
        page.goto(f"/projects/{self.project}/tasks")
        together = page.locator("header.top").get_by_role("button", name="Together", exact=True)
        expect(together).to_be_visible()
        expect(together).not_to_have_attribute("aria-disabled", "true")
        self.assertEqual(together.evaluate("(el) => getComputedStyle(el).opacity"), "1", "not greyed out")
        together.click()
        dialog = page.get_by_role("dialog", name="Together")
        expect(dialog).to_contain_text("Open a conversation, task, sketch or page to work on it together.")
        page.keyboard.press("Escape")
        expect(dialog).to_have_count(0)
        expect(together).to_be_focused()

    def test_05_icon_buttons_take_the_control_token(self) -> None:
        page = self.page(DESKTOP)
        page.goto(f"/projects/{self.project}")
        composer = page.locator(".composer__box").first
        expect(composer).to_be_visible()
        send = composer.locator(".composer__send").bounding_box()
        attach = composer.locator(".composer__attach").first.bounding_box()
        self.assertEqual((round(send["width"]), round(send["height"])), (32, 32))
        self.assertEqual(round(attach["height"]), 32)
        sizes = composer.evaluate("(box) => [...box.querySelectorAll('.composer__send svg, .composer__attach svg')].map((svg) => Math.round(svg.getBoundingClientRect().width))")
        self.assertEqual(set(sizes), {16}, "one icon size among the composer's tools")
        gear = page.get_by_role("link", name="Settings").first.bounding_box()
        self.assertEqual((round(gear["width"]), round(gear["height"])), (32, 32))

    def test_06_placeholder_without_the_shared_input_style(self) -> None:
        page = self.page(DESKTOP)
        page.goto("/dm/new")
        search = page.locator("input.dm-new__search")
        expect(search).to_be_visible()
        colours = search.evaluate("""(el) => {
          const probe = document.createElement('span');
          probe.style.color = 'var(--t3)';
          document.body.appendChild(probe);
          const t3 = getComputedStyle(probe).color;
          probe.remove();
          return [getComputedStyle(el, '::placeholder').color, t3];
        }""")
        self.assertEqual(colours[0], colours[1], "the placeholder takes --t3")


if __name__ == "__main__":
    unittest.main()
