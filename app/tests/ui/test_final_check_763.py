"""Regressions for the five P2 findings of the final UI check (#763, comment 6555764985).

Each test reproduces one finding at the device viewports of that check, on the engine FLUX_UI_BROWSER names
(run the module once with chromium and once with webkit):
- P2-1: a live strip that arrives while a task's Details sheet or overlay is open (a session started from
  Details) stays above the panel's scrim and usable; phone 390x844 and tablet 820x1180.
- P2-2: the phone header's Back after opening a `?open=` link as the tab's first page stays in Flux.
- P2-3: Home's "Open navigation" at 641-680 px (Galaxy Z Fold 5 unfolded, 673x841) is on screen and opens the
  drawer, which leads to Settings.
- P2-4: an open Inbox decision card keeps Accept, Not now and Discuss inside the card under 375 px (Fold cover
  344x882, Z Flip 360x764).
- P2-5: on the phone a Wiki decision card opens the decision in place, over the page, not over Tasks.
"""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UI_BROWSER, UPSTREAM, shot, start_forwarder

STAMP = int(time.time() * 1000)
PASSWORD = "the final check of the release"
PEOPLE = {
    "ada": ("Ada Kowalska", f"ada.fc+{STAMP}@example.test"),
    "jonas": ("Jonas Berg", f"jonas.fc+{STAMP}@example.test"),
    # Two different people with one name, as an invite tried in two browsers left them (#763 founder screenshot).
    "basia": ("Basia Wrona", f"basia.fc+{STAMP}@example.test"),
    "basia2": ("Basia Wrona", f"basia.fc2+{STAMP}@example.test"),
}
NARROW = [{"width": width, "height": 800} for width in (360, 390, 430)]
TABLET = {"width": 820, "height": 1180}
FOLD_UNFOLDED = {"width": 673, "height": 841}
FOLD_COVER = {"width": 344, "height": 882}
FLIP = {"width": 360, "height": 764}
TASK = "Calibrate the soil probes"
PROPOSED = "Add frost warnings in October"
ACCEPTED = "Measure soil moisture first"
SECOND = "Water bed 3 at 6 am, not in the evening"
BLOCKED = "Waiting for the shed key from the allotment office"

# A joined session's strip, as LiveBar renders it (`section.lv-bar` with its device buttons), put where LiveBar
# mounts it: under the header, above the work. The media path itself is covered by test_live_sessions.
ADD_STRIP = """() => {
  window.__stripTaps = 0;
  const main = document.querySelector('.app__main');
  const bar = document.createElement('section');
  bar.className = 'lv-bar';
  bar.setAttribute('aria-label', 'Live session');
  bar.innerHTML = '<div class="lv-row"><span class="lv-status">Live</span><div class="lv-row__acts">'
    + '<button type="button" class="lv-dev" aria-label="Turn microphone on">m</button>'
    + '<button type="button" class="ui-btn" aria-label="Leave">Leave</button></div></div>';
  bar.querySelectorAll('button').forEach((button) => button.addEventListener('click', () => { window.__stripTaps += 1; }));
  main.insertBefore(bar, main.querySelector('.app__body'));
}"""


class FinalCheck763(unittest.TestCase):
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

        def api(who: str, method: str, path: str, body: dict | None = None, headers: dict | None = None) -> dict:
            response = contexts[who].request.fetch(f"{ORIGIN}{path}", method=method, data=json.dumps(body) if body is not None else None,
                                                   headers={"origin": ORIGIN, "content-type": "application/json", **(headers or {})})
            assert response.status < 300, f"{method} {path}: {response.status} {response.text()}"
            return json.loads(response.text() or "{}")

        workspace = api("ada", "POST", "/api/v1/workspaces", {"name": "Riverside Makers"})["id"]
        for key in ("jonas", "basia", "basia2"):
            api("ada", "POST", f"/api/v1/workspaces/{workspace}/members", {"email": PEOPLE[key][1], "role": "member"})
        cls.project_id = api("ada", "POST", f"/api/v1/workspaces/{workspace}/projects", {"name": "Community garden sensors", "visibility": "workspace"})["id"]
        cls.task = api("ada", "POST", f"/api/v1/projects/{cls.project_id}/work", {"title": TASK, "owner": {"kind": "human", "id": cls.ids["ada"]}})
        api("jonas", "POST", f"/api/v1/projects/{cls.project_id}/decisions", {"title": PROPOSED, "rationale": "Frost came in mid-October last year."})
        api("jonas", "POST", f"/api/v1/projects/{cls.project_id}/decisions", {"title": SECOND, "rationale": "Less water lost in the heat."})
        api("ada", "POST", f"/api/v1/projects/{cls.project_id}/work", {"title": BLOCKED, "owner": {"kind": "human", "id": cls.ids["ada"]},
                                                                       "status": "blocked", "blocker": "the office opens on Monday"})
        accepted = api("ada", "POST", f"/api/v1/projects/{cls.project_id}/decisions", {"title": ACCEPTED, "rationale": "Seedlings die in June from dry soil."})
        api("ada", "POST", f"/api/v1/decisions/{accepted['id']}/accept", {"expectedVersion": accepted["version"]})
        body = f"The rules we keep.\n\n[{ACCEPTED}](flux:decision/{accepted['id']})\n\nThe far bed sits behind a hedge.\n"
        cls.doc_id = api("ada", "POST", f"/api/v1/projects/{cls.project_id}/docs", {"title": "Decisions and why", "body": body, "state": "published"},
                         {"idempotency-key": str(uuid.uuid4())})["id"]
        for key, context in contexts.items():
            cls.states[key] = context.storage_state()
        # The worker writes Ada's "needs you" item for Jonas's proposal shortly after.
        for _ in range(80):
            items = contexts["ada"].request.get("/api/v1/needs-you").json().get("items", [])
            if len(items) >= 3:
                break
            time.sleep(0.25)
        for context in contexts.values():
            context.close()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, viewport: dict, touch: bool = True, theme: str = "light") -> Page:
        options = dict(base_url=ORIGIN, viewport=viewport, storage_state=self.states["ada"], locale="en-GB", color_scheme=theme)
        if touch:
            options.update(is_mobile=UI_BROWSER == "chromium", has_touch=True, device_scale_factor=2)
        context = self.browser.new_context(**options, service_workers="block")
        self.addCleanup(context.close)
        context.add_init_script(f"localStorage.setItem('flux.theme', '{theme}')")
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def open_proposed(self, page: Page):
        """The Inbox opens its first item; another is opened with a tap on its free space, beside the face (#763 LD-1)."""
        page.goto("/inbox")
        card = page.locator(".nyc").filter(has_text=PROPOSED).first
        expect(card).to_be_visible()
        if "nyc--compact" in (card.get_attribute("class") or ""):
            rect = card.locator(".nyc__card").bounding_box()
            page.touchscreen.tap(rect["x"] + 10, rect["y"] + rect["height"] / 2)
        card = page.locator(".nyc").filter(has_text=PROPOSED).first
        expect(card.get_by_role("button", name="Discuss")).to_be_visible()
        return card

    def tasks_with_details(self, page: Page) -> None:
        page.goto(f"/projects/{self.project_id}/tasks?open=work:{self.task['id']}")
        expect(page.locator(".ui-overlay[data-state='open']")).to_have_count(1)
        expect(page.locator(".ui-overlay").get_by_text(TASK).first).to_be_visible()
        page.wait_for_function("() => !new URLSearchParams(location.search).has('open')")

    # ------------------------------------------------------------------ P2-1

    def test_p2_1_a_strip_that_arrives_under_open_details_stays_usable(self) -> None:
        for name, viewport in (("phone", PHONE), ("tablet", TABLET)):
            with self.subTest(name):
                page = self.page(viewport)
                self.tasks_with_details(page)
                self.assertEqual(page.evaluate("document.getElementById('root').getAttribute('data-modal')"), "", "the panel alone makes the app modal")
                page.evaluate(ADD_STRIP)
                # The decision is taken again when the strip arrives: only the strip's path stays live.
                page.wait_for_function("() => document.getElementById('root').getAttribute('data-modal') === 'strip'")
                self.assertFalse(page.evaluate("document.getElementById('root').inert"))
                # The overlay and its scrim start below the strip, so nothing paints over it.
                page.wait_for_function("""() => { const frame = document.querySelector('.ui-overlay[data-state="open"]');
                  const strip = document.querySelector('#root .lv-bar');
                  return frame && strip && parseFloat(frame.style.top || '0') >= Math.round(strip.getBoundingClientRect().bottom) - 1; }""")
                for label in ("Turn microphone on", "Leave"):
                    button = page.locator(f"#root .lv-bar button[aria-label='{label}']")
                    hit = page.evaluate("""(label) => { const button = document.querySelector(`#root .lv-bar button[aria-label="${label}"]`);
                      const r = button.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === button; }""", label)
                    self.assertTrue(hit, f"{name}: {label} is not covered by the panel or its scrim")
                    button.tap()
                self.assertEqual(page.evaluate("window.__stripTaps"), 2, f"{name}: Mute and Leave take taps with Details open")
                expect(page.locator(".ui-overlay[data-state='open']")).to_have_count(1)
                # Leave takes the strip away: the panel is modal over the whole app again.
                page.evaluate("document.querySelector('#root .lv-bar').remove()")
                page.wait_for_function("() => document.getElementById('root').getAttribute('data-modal') === '' && document.getElementById('root').inert")

    # ------------------------------------------------------------------ P2-2

    def test_p2_2_phone_back_after_an_open_link_stays_in_flux(self) -> None:
        page = self.page(PHONE)
        # The `?open=` link is the tab's first page, as when it is followed from a notification or another app.
        self.tasks_with_details(page)
        page.keyboard.press("Escape")
        expect(page.locator(".ui-overlay[data-state='open']")).to_have_count(0)
        page.locator(".phead").get_by_role("button", name="Back", exact=True).tap()
        page.wait_for_function("() => location.pathname === '/projects'")
        self.assertTrue(page.url.startswith(ORIGIN), page.url)
        expect(page.locator("#content")).to_be_visible()

    # ------------------------------------------------------------------ P2-3

    def test_p2_3_fold_unfolded_home_navigation_is_reachable(self) -> None:
        for width in (641, FOLD_UNFOLDED["width"], 680):
            with self.subTest(width=width):
                page = self.page({"width": width, "height": FOLD_UNFOLDED["height"]})
                page.goto("/")
                menu = page.get_by_role("button", name="Open navigation")
                expect(menu).to_be_visible()
                rect = menu.bounding_box()
                self.assertGreaterEqual(rect["y"], 0, "the button is fully on screen")
                self.assertGreaterEqual(min(rect["width"], rect["height"]), 44, "a 44 px touch target")
                hit = page.evaluate("""() => { const b = document.querySelector('button[aria-label="Open navigation"]'); const r = b.getBoundingClientRect();
                  return b.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); }""")
                self.assertTrue(hit, "nothing on Home takes the button's taps")
                menu.tap()
                drawer = page.locator("#nav-drawer")
                expect(drawer).to_be_visible()
                page.locator("#nav-drawer a[href='/settings']").first.tap()
                page.wait_for_function("() => location.pathname.startsWith('/settings')")

    # ------------------------------------------------------------------ P2-4

    def test_p2_4_inbox_actions_stay_inside_the_card_on_narrow_phones(self) -> None:
        for name, viewport in (("fold-cover", FOLD_COVER), ("flip", FLIP), ("phone", PHONE), ("430", NARROW[2])):
            with self.subTest(name):
                page = self.page(viewport)
                card = self.open_proposed(page)
                discuss = card.get_by_role("button", name="Discuss")
                expect(discuss).to_be_visible()
                inner = card.locator(".nyc__card").bounding_box()
                for button in (card.get_by_role("button", name=re.compile("^Accept")), card.get_by_role("button", name=re.compile("^Not now")), discuss):
                    rect = button.bounding_box()
                    self.assertGreaterEqual(rect["x"], inner["x"] + 8, f"{name}: inside the card's padding")
                    self.assertLessEqual(rect["x"] + rect["width"], inner["x"] + inner["width"] - 8, f"{name}: inside the card's padding")
                    self.assertGreaterEqual(rect["height"], 44, f"{name}: a 44 px touch target")
                    # The label is whole, not clipped by the button.
                    self.assertLessEqual(button.evaluate("el => el.scrollWidth - el.clientWidth"), 1, f"{name}: the label fits")
                self.assertLessEqual(page.evaluate("document.scrollingElement.scrollWidth"), viewport["width"], "no sideways scroll")
                # 390 keeps the three on one row (#763 IN-6); under 375 they wrap inside the card.
                tops = {round(b.bounding_box()["y"]) for b in (card.get_by_role("button", name=re.compile("^Accept")), discuss)}
                if viewport["width"] >= 375:
                    self.assertEqual(len(tops), 1, "one row at 390")

    def test_inbox_waiting_line_names_people_once_without_a_lone_separator(self) -> None:
        for viewport in NARROW:
            with self.subTest(width=viewport["width"]):
                page = self.page(viewport)
                card = self.open_proposed(page)
                line = card.locator(".nyc__waiting")
                expect(line).to_contain_text("can accept too")
                expect(line).to_contain_text("waiting for you")
                text = line.inner_text()
                self.assertEqual(text.count("Basia Wrona"), 1, text)
                self.assertEqual(line.locator(".ui-avatar:not(.ui-avatar--me)").evaluate_all("els => els.map((el) => el.textContent)").count("BW"), 1)
                # The separator ends the first part: no line of the waiting line starts with it.
                self.assertFalse(re.search(r"(^|\n)\s*·", text), text)
                self.assertEqual(line.locator(":scope > [aria-hidden='true']:not(.ui-avatar)").count(), 0)

    def test_inbox_compact_rows_keep_their_titles_on_phones(self) -> None:
        for viewport in NARROW:
            with self.subTest(width=viewport["width"]):
                page = self.page(viewport)
                page.goto("/inbox")
                row = page.locator(".nyc--compact").filter(has=page.locator(".nyc__rowactions")).first
                expect(row).to_be_visible()
                title = row.locator(".nyc__open")
                # Two lines before an ellipsis, and the project stays out of the one-line meta.
                self.assertNotEqual(title.evaluate("el => getComputedStyle(el).whiteSpace"), "nowrap")
                self.assertLessEqual(title.evaluate("el => el.scrollHeight - el.clientHeight"), 1, "the title is whole in two lines")
                self.assertNotIn("Community garden sensors", row.locator(".nyc__eyebrow").inner_text())
                action = row.locator(".nyc__rowactions").bounding_box()
                self.assertGreaterEqual(action["x"], title.bounding_box()["x"] + title.bounding_box()["width"] - 1, "the action has its own column")

    def test_home_needs_you_is_never_clipped_above_the_dock(self) -> None:
        for viewport in NARROW:
            with self.subTest(width=viewport["width"]):
                page = self.page(viewport)
                page.goto("/")
                last = page.get_by_role("button", name="Open task").first
                expect(last).to_be_attached()
                page.locator("#content .pane-scroll").first.evaluate("el => { el.scrollTop = el.scrollHeight; }")
                page.wait_for_timeout(100)
                fab = page.locator(".phone-fab").bounding_box()
                rect = last.bounding_box()
                self.assertLessEqual(rect["y"] + rect["height"], fab["y"], "the last action ends above the + once scrolled")
                hit = last.evaluate("el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); }")
                self.assertTrue(hit, "the last action is tappable")
                # The scroller runs to the dock: content passes under the + instead of stopping at a hard line above it.
                scroller = page.locator("#content .pane-scroll").first.bounding_box()
                self.assertGreater(scroller["y"] + scroller["height"], fab["y"] + fab["height"] / 2)
                # The second row's text Accept starts on the first row's dark Accept's left edge.
                rows = page.locator(".home__queue .nyc--row")
                first = rows.nth(0).get_by_role("button", name=re.compile("^Accept")).bounding_box()
                second = rows.nth(1).get_by_role("button", name=re.compile("^Accept")).bounding_box()
                self.assertLessEqual(abs(first["x"] - second["x"]), 1)
                text_left = rows.nth(1).get_by_role("button", name=re.compile("^Accept")).evaluate(
                    "el => { const range = document.createRange(); range.selectNodeContents(el); return range.getBoundingClientRect().left; }")
                self.assertLessEqual(abs(text_left - first["x"]), 2, "the text starts on the dark button's left edge")

    # ------------------------------------------------------------------ P2-5

    def test_p2_5_phone_wiki_decision_card_opens_in_place(self) -> None:
        page = self.page(PHONE)
        doc = f"/projects/{self.project_id}/docs/{self.doc_id}"
        page.goto(doc)
        card = page.locator("a.doc-decision").first
        expect(card.locator(".doc-decision__reason")).to_be_visible()
        # A tap on the card's text (a portal inside the link), where the release check tapped.
        card.locator(".doc-decision__t").tap()
        expect(page.locator(".ui-overlay[data-state='open']")).to_have_count(1)
        expect(page.locator(".ui-overlay").get_by_text(ACCEPTED).first).to_be_visible()
        self.assertEqual(page.evaluate("location.pathname"), doc, "the decision opens over the Wiki page")
        page.keyboard.press("Escape")
        expect(page.locator(".ui-overlay[data-state='open']")).to_have_count(0)
        self.assertEqual(page.evaluate("location.pathname"), doc, "closing it leaves the reader on the page")

    # ------------------------------------------------------------------ Wiki Edit (founder screenshot, iPad Wiki read view)

    def test_wiki_edit_is_a_quiet_toolbar_button(self) -> None:
        doc = f"/projects/{self.project_id}/docs/{self.doc_id}"
        for name, viewport, touch in (("tablet", TABLET, True), ("desktop", DESKTOP, False), ("phone", PHONE, True)):
            for theme in ("light", "dark"):
                with self.subTest(name, theme=theme):
                    page = self.page(viewport, touch=touch, theme=theme)
                    page.goto(doc)
                    edit = page.get_by_role("link", name="Edit", exact=True)
                    expect(edit).to_be_visible()
                    # Soft fill, never the screen's inverted primary: the read page has no dark button.
                    fill = edit.evaluate("""el => { const probe = document.createElement('i'); probe.style.background = 'var(--inv)'; document.body.append(probe);
                      const inv = getComputedStyle(probe).backgroundColor; probe.remove(); return [getComputedStyle(el).backgroundColor, inv]; }""")
                    self.assertNotEqual(fill[0], fill[1], f"{name}/{theme}: Edit is not the dark primary")
                    self.assertEqual(page.locator(".ui-btn--primary:visible").count(), 0, f"{name}/{theme}: no dark button on the read page")
                    rect = edit.bounding_box()
                    if name == "phone":
                        # The phone keeps Edit in its own space under the page, one touch control high.
                        self.assertGreaterEqual(rect["height"], 44)
                        self.assertLessEqual(rect["height"], 46)
                    else:
                        self.assertLessEqual(abs(rect["height"] - 32), 1, f"{name}/{theme}: the icon buttons' 32 px, not a block")
                        self.assertLessEqual(rect["width"], 120, f"{name}/{theme}: compact width")
                        icon = page.locator(".wiki-bar .ui-icon-btn:visible").first.bounding_box()
                        self.assertLessEqual(abs((rect["y"] + rect["height"] / 2) - (icon["y"] + icon["height"] / 2)), 1, "on the icons' centre line")
                        if touch:
                            # Its hit area reaches 44 px without growing what is drawn.
                            reach = edit.evaluate("""el => { const r = el.getBoundingClientRect(); const x = r.left + r.width / 2;
                              return [r.top - 5, r.bottom + 5].every((y) => el.contains(document.elementFromPoint(x, y))); }""")
                            self.assertTrue(reach, f"{name}: a 44 px touch target")
                    shot(page, f"final-763-wiki-edit-{name}-{theme}-{UI_BROWSER}")


if __name__ == "__main__":
    unittest.main()
