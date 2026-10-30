"""The "A new version of Flux is available" prompt never covers a control a person needs (#20, MOB-5, #271).

In WebKit, test_settings test_07 (Back on a phone) once failed because `div.pwa-update` sat over the header and
intercepted every tap on Back for 30 s. The prompt was a layer pinned to the top of the window, so on a phone it
covered whatever the header held. It is now a row of the page above the shell: it takes its own height, and the
shell shrinks by that much, so nothing is under it.

These tests run with service workers active, the way a person uses Flux. A changed deployment is simulated the way
a browser sees one: the page's registration is given another script URL, so a second worker installs and waits
behind the one that controls the page; the app's own registration code announces it and renders the real prompt.
Nothing here dismisses the prompt to make a check pass: every reach check runs while it is on screen.

Runs against the running Compose application through scripts/check_ui.sh; FLUX_UI_BROWSER selects chromium
(default) or webkit. Phone and tablet viewports and touch are emulated (founder direction #266 item 10), which
cannot apply safe-area insets: the notch padding stays unverified here.
"""

from __future__ import annotations

import json
import re
import time
import unittest

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot as save_shot, start_forwarder
from test_settings import UI_BROWSER

PASSWORD = "an update waits for the person"
STAMP = int(time.time() * 1000)
NAME, EMAIL = "Ola Zielinska", f"ola.update+{STAMP}@example.test"
SE = {"width": 320, "height": 568}
PROMPT = "flux-update-prompt"

# The topmost element at a few points of each visible control: its centre and the middle of each side of its
# 44 px core, the points a finger lands on. A control is covered when any of them belongs to the prompt.
COVERED_CONTROLS = """() => {
  const prompt = document.querySelector('[data-testid="flux-update-prompt"]');
  const inside = (el) => el !== null && prompt.contains(el);
  const selector = 'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], '
    + '[role="switch"], [role="radio"], [role="checkbox"], [role="menuitem"], [tabindex]:not([tabindex="-1"])';
  const visible = (el) => {
    const box = el.getBoundingClientRect();
    if (box.width === 0 || box.height === 0 || el.closest('[inert]')) return false;
    for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
    }
    return true;
  };
  const covered = [];
  for (const el of document.querySelectorAll(selector)) {
    if (prompt.contains(el) || !visible(el)) continue;
    const box = el.getBoundingClientRect();
    const w = Math.min(box.width, 44), h = Math.min(box.height, 44);
    const x = box.left + (box.width - w) / 2, y = box.top + (box.height - h) / 2;
    const points = [[x + .5, y + h / 2], [x + w - .5, y + h / 2], [x + w / 2, y + .5], [x + w / 2, y + h - .5], [x + w / 2, y + h / 2]];
    const hit = points.some(([px, py]) => px >= 0 && py >= 0 && px < innerWidth && py < innerHeight && inside(document.elementFromPoint(px, py)));
    if (hit) covered.push(el.getAttribute('aria-label') || el.textContent.trim().slice(0, 40) || el.tagName.toLowerCase());
  }
  const box = prompt.getBoundingClientRect();
  return {
    covered,
    prompt: {left: box.left, top: box.top, right: box.right, bottom: box.bottom, height: box.height},
    viewport: {width: innerWidth, height: innerHeight},
    // The page itself must not scroll or overflow because of the prompt: the shell gave up the room.
    scroll: {x: document.documentElement.scrollWidth - innerWidth, y: document.documentElement.scrollHeight - innerHeight},
    shell: (() => { const app = document.querySelector('.app'); if (!app) return null; const r = app.getBoundingClientRect(); return {top: r.top, bottom: r.bottom}; })(),
  };
}"""


def shot(page: Page, name: str) -> None:
    save_shot(page, f"{name}-{UI_BROWSER}")


class UpdatePromptReach(unittest.TestCase):
    pw = None
    browser: Browser
    state: dict = {}
    project: dict = {}

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=15000)
        context = cls.browser.new_context(base_url=ORIGIN)
        response = context.request.post("/api/auth/sign-up/email", data={"email": EMAIL, "password": PASSWORD, "name": NAME}, headers={"origin": ORIGIN})
        assert response.status == 200, response.text()
        workspace = cls.call(context, "POST", "/api/v1/workspaces", {"name": "Riverside Makers"}, 201)
        cls.project = cls.call(context, "POST", f"/api/v1/workspaces/{workspace['id']}/projects", {"name": "Community garden sensors", "visibility": "restricted"}, 201)
        for title, status in (("Order six capacitive probes", "in_progress"), ("Ask the school for two ESP32 kits", "open"), ("Write the volunteer guide", "open")):
            cls.call(context, "POST", f"/api/v1/projects/{cls.project['id']}/work", {"title": title, "status": status}, 201)
        cls.state = context.storage_state()
        context.close()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    @staticmethod
    def call(context: BrowserContext, method: str, path: str, body: dict, status: int) -> dict:
        response = context.request.fetch(ORIGIN + path, method=method, headers={"origin": ORIGIN, "content-type": "application/json"}, data=json.dumps(body))
        assert response.status == status, f"{method} {path}: {response.status}, expected {status}: {response.text()}"
        return response.json()

    def page(self, viewport: dict | None = None, *, dark: bool = False) -> Page:
        """A fresh browser profile with its service worker allowed: a phone by default, a computer when given DESKTOP."""
        viewport = viewport or PHONE
        phone = viewport["width"] <= 640
        options: dict = {"base_url": ORIGIN, "storage_state": self.state, "viewport": viewport, "color_scheme": "dark" if dark else "light",
                         "locale": "en-GB", "timezone_id": "Europe/Warsaw", "service_workers": "allow"}
        if phone:
            options.update(is_mobile=True, has_touch=True, device_scale_factor=3)
        else:
            options.update(device_scale_factor=1)
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    @staticmethod
    def controlled(page: Page) -> None:
        """The first worker has installed, activated and taken the page: from here a second one is an update."""
        page.wait_for_function("navigator.serviceWorker.controller !== null && navigator.serviceWorker.controller.state === 'activated'", timeout=20000)

    def offer_update(self, page: Page) -> None:
        """A changed deployment: another worker installs and waits, and the app offers it. The page keeps running."""
        self.controlled(page)
        page.evaluate("navigator.serviceWorker.register('/sw.js?deployment=next', {scope: '/', updateViaCache: 'none'}).then(() => undefined)")
        expect(page.get_by_test_id(PROMPT)).to_be_visible()
        expect(page.get_by_test_id(PROMPT)).to_have_count(1)
        # The row's entrance motion settles before anything is measured (a looping mark elsewhere does not count).
        page.wait_for_function("document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).every((a) => a.playState !== 'running')")

    def reach(self, page: Page, where: str) -> dict:
        """Nothing a person needs is under the prompt, the prompt is whole in the window, and the page does not scroll for it."""
        # The row publishes its height from a ResizeObserver, so after the window or the text size changes the shell follows on the
        # next rendering update. Wait for that (a loaded browser can be a few hundred ms late); a height that never follows still fails.
        page.wait_for_function("""() => {
          const prompt = document.querySelector('[data-testid="flux-update-prompt"]');
          const published = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--pwa-update-h'));
          return prompt !== null && Math.abs(published - prompt.getBoundingClientRect().height) < 0.5;
        }""", timeout=5000)
        measured = page.evaluate(COVERED_CONTROLS)
        self.assertEqual(measured["covered"], [], f"{where}: controls under the update prompt: {measured}")
        prompt, viewport = measured["prompt"], measured["viewport"]
        self.assertTrue(prompt["left"] >= 0 and prompt["top"] >= 0 and prompt["right"] <= viewport["width"] and prompt["bottom"] <= viewport["height"], f"{where}: the prompt is inside the window: {measured}")
        self.assertLessEqual(measured["scroll"]["x"], 0, f"{where}: no sideways scroll: {measured}")
        # The shell has a fixed height and gave up the prompt's room, so the page must not scroll for it. A sign-in page may
        # legitimately scroll when its own content is taller than the window, so only the shell is held to this.
        if measured["shell"]:
            self.assertLessEqual(measured["scroll"]["y"], 0, f"{where}: the page does not scroll because of the prompt: {measured}")
            self.assertGreaterEqual(measured["shell"]["top"], prompt["bottom"] - 0.5, f"{where}: the shell starts below the prompt: {measured}")
            self.assertLessEqual(measured["shell"]["bottom"], viewport["height"] + 0.5, f"{where}: the shell ends inside the window: {measured}")
        return measured

    def prompt_actions_are_targets(self, page: Page) -> None:
        """Reload and Later are real 44 px targets that receive the tap, with the prompt wrapped at this width."""
        for name in ("Reload", "Later"):
            button = page.get_by_test_id(PROMPT).get_by_role("button", name=name, exact=True)
            expect(button).to_be_visible()
            box = button.bounding_box()
            self.assertIsNotNone(box)
            self.assertGreaterEqual(min(box["width"], box["height"]), 44, f"{name} is a 44 px target: {box}")
            self.assertTrue(button.evaluate("""el => { const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return hit === el || el.contains(hit); }"""), f"{name} receives the tap")

    # ------------------------------------------------------------ first load, and other profiles

    def test_01_first_load_on_a_phone_offers_no_update(self) -> None:
        """A first install is not an update, however long the page runs and whenever the browser checks for one."""
        page = self.page()
        page.goto("/settings")
        expect(page.get_by_role("link", name=re.compile("^Notifications"))).to_be_visible()
        self.controlled(page)
        # A browser checks for a new worker whenever the page becomes visible again; do it while the first one settles.
        for _ in range(3):
            page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
            page.wait_for_timeout(500)
        page.wait_for_timeout(2500)
        self.assertEqual(page.get_by_test_id(PROMPT).count(), 0, "no prompt after a first install")

    def test_02_a_second_profile_opening_flux_offers_nothing_to_the_first(self) -> None:
        """Two profiles of one browser each install their own first worker: neither is an update for the other."""
        first = self.page()
        first.goto("/settings")
        self.controlled(first)
        pages = [first]
        for _ in range(2):
            later = self.page()
            later.goto("/settings")
            self.controlled(later)
            pages.append(later)
        first.wait_for_timeout(3000)
        for number, page in enumerate(pages, 1):
            self.assertEqual(page.get_by_test_id(PROMPT).count(), 0, f"no prompt in profile {number}")

    # ------------------------------------------------------------ the original failure

    def test_03_settings_back_is_tappable_while_the_prompt_is_on_screen(self) -> None:
        """test_settings test_07 with the prompt up: every tap on a section and on Back goes through (the 30 s intercept)."""
        page = self.page()
        page.goto("/settings")
        expect(page.get_by_role("link", name=re.compile("^Notifications"))).to_be_visible()
        self.offer_update(page)
        self.reach(page, "settings list")
        self.prompt_actions_are_targets(page)
        shot(page, "update-prompt-phone-390-settings")
        page.get_by_role("link", name=re.compile("^Notifications")).tap(timeout=5000)
        expect(page).to_have_url(re.compile(r"/settings/notifications$"))
        expect(page.get_by_role("heading", level=2, name="Notifications")).to_be_visible()
        expect(page.get_by_test_id(PROMPT)).to_be_visible()
        self.reach(page, "notifications page")
        page.get_by_role("button", name="Back").tap(timeout=5000)
        expect(page).to_have_url(re.compile(r"/settings$"))
        page.get_by_role("link", name=re.compile("^Agents and AI")).tap(timeout=5000)
        expect(page).to_have_url(re.compile(r"/settings/agents$"))
        expect(page.get_by_role("region", name=re.compile("^Your assistant"))).to_be_visible()
        expect(page.get_by_test_id(PROMPT)).to_be_visible()
        page.get_by_role("button", name="Back").tap(timeout=5000)
        expect(page).to_have_url(re.compile(r"/settings$"))
        page.get_by_role("link", name=re.compile(f"^{NAME}")).tap(timeout=5000)
        expect(page).to_have_url(re.compile(r"/settings/account$"))
        page.get_by_role("button", name="Back").tap(timeout=5000)
        expect(page).to_have_url(re.compile(r"/settings$"))
        expect(page.get_by_test_id(PROMPT)).to_be_visible()

    def test_04_the_main_places_stay_reachable_on_a_phone(self) -> None:
        """Home, Projects, Inbox and the project's views: header, capsule, Create and composer are all clear of the prompt."""
        page = self.page()
        page.goto("/")
        expect(page.get_by_role("navigation", name="Main places")).to_be_visible()
        self.offer_update(page)
        places = page.get_by_role("navigation", name="Main places")
        for name, path in (("Home", "/"), ("Projects", "/projects"), ("Inbox", "/inbox")):
            places.get_by_role("link", name=re.compile(f"^{name}")).tap(timeout=5000)
            expect(page).to_have_url(f"{ORIGIN}{path}")
            expect(page.get_by_test_id(PROMPT)).to_be_visible()
            self.reach(page, name)
        shot(page, "update-prompt-phone-390-inbox")
        project = self.project["id"]
        for where, path in (("conversation", f"/projects/{project}"), ("tasks", f"/projects/{project}/tasks")):
            page.goto(path)
            expect(page.get_by_test_id(PROMPT)).to_be_visible()
            expect(page.locator("header").get_by_role("button", name="Search", exact=True)).to_be_visible()
            self.reach(page, where)
        shot(page, "update-prompt-phone-390-tasks")
        page.goto(f"/projects/{project}")
        composer = page.locator("#project-composer")
        expect(composer).to_be_visible()
        self.reach(page, "conversation composer")
        composer.tap(timeout=5000)
        expect(composer).to_be_focused()

    def test_05_the_prompt_wraps_whole_on_the_narrowest_phone_and_with_larger_text(self) -> None:
        for width_name, viewport in (("320", SE), ("390", PHONE)):
            with self.subTest(width=width_name):
                page = self.page(viewport)
                page.goto("/settings")
                self.offer_update(page)
                # The system text size scales rem: a 20 px root is the largest the shell supports (#435, #437).
                page.add_style_tag(content="html { font-size: 20px; }")
                page.wait_for_timeout(300)
                self.reach(page, f"{width_name} px, large text")
                self.prompt_actions_are_targets(page)
                shot(page, f"update-prompt-phone-{width_name}-large-text")

    def test_05b_the_view_menu_opens_under_the_header_not_over_it(self) -> None:
        """The phone's view menu is a card under the header; with the prompt above, it follows the header down."""
        page = self.page()
        page.goto(f"/projects/{self.project['id']}/tasks")
        expect(page.locator("header").get_by_role("button", name="Search", exact=True)).to_be_visible()
        self.offer_update(page)
        page.get_by_role("heading", level=1).get_by_role("button").tap(timeout=5000)
        menu = page.get_by_role("dialog", name=re.compile("Community garden sensors"))
        expect(menu).to_be_visible()
        page.wait_for_function("document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).every((a) => a.playState !== 'running')")
        header, card = page.locator("header").bounding_box(), menu.bounding_box()
        self.assertIsNotNone(header)
        self.assertIsNotNone(card)
        self.assertGreaterEqual(card["y"], header["y"] + header["height"] - 2, f"the menu card starts under the header: {header} {card}")
        shot(page, "update-prompt-phone-390-view-menu")

    def test_06_the_computer_shell_is_clear_of_the_prompt(self) -> None:
        for dark in (False, True):
            with self.subTest(dark=dark):
                page = self.page(DESKTOP, dark=dark)
                page.goto("/")
                expect(page.get_by_role("complementary", name="Sidebar")).to_be_visible()
                self.offer_update(page)
                self.reach(page, "computer home")
                sidebar = page.get_by_role("complementary", name="Sidebar")
                sidebar.get_by_role("navigation", name="Places").get_by_role("link", name=re.compile("^Inbox")).click(timeout=5000)
                expect(page).to_have_url(f"{ORIGIN}/inbox")
                expect(page.get_by_test_id(PROMPT)).to_be_visible()
                self.reach(page, "computer inbox")
                shot(page, f"update-prompt-desktop-1440-{'dark' if dark else 'light'}")

    def test_07_the_sign_in_page_makes_room_for_the_prompt_too(self) -> None:
        """The prompt shows signed in or not: the sign-in card is whole and nothing on it is covered."""
        context = self.browser.new_context(base_url=ORIGIN, viewport=PHONE, is_mobile=True, has_touch=True, service_workers="allow")
        self.addCleanup(context.close)
        page = context.new_page()
        page.goto("/sign-in")
        expect(page.get_by_label("Email")).to_be_visible()
        self.offer_update(page)
        self.reach(page, "sign in")
        shot(page, "update-prompt-phone-390-sign-in")
        page.get_by_label("Email").tap(timeout=5000)
        expect(page.get_by_label("Email")).to_be_focused()

    # ------------------------------------------------------------ the person's choice

    def test_08_later_dismisses_the_prompt_and_the_shell_takes_its_room_back(self) -> None:
        page = self.page()
        page.goto("/settings")
        self.offer_update(page)
        with_prompt = page.evaluate("document.querySelector('.app').getBoundingClientRect().top")
        self.assertGreater(with_prompt, 40, "the shell sits below the prompt")
        page.get_by_test_id(PROMPT).get_by_role("button", name="Later", exact=True).tap(timeout=5000)
        expect(page.get_by_test_id(PROMPT)).to_have_count(0)
        self.assertLess(page.evaluate("document.querySelector('.app').getBoundingClientRect().top"), with_prompt, "the shell took its room back")
        self.assertLessEqual(page.evaluate("document.documentElement.scrollHeight - innerHeight"), 0)
        # Dismissing is not applying: the worker is still waiting and the page is still the old one.
        self.assertTrue(page.evaluate("navigator.serviceWorker.getRegistration('/').then((r) => r.waiting !== null)"), "the update still waits")
        page.get_by_role("link", name=re.compile("^Notifications")).tap(timeout=5000)
        expect(page).to_have_url(re.compile(r"/settings/notifications$"))
        page.wait_for_timeout(1000)
        self.assertEqual(page.get_by_test_id(PROMPT).count(), 0, "the prompt stays away while the person keeps working")
        # A new document is the person's next chance: the waiting worker is offered again.
        page.reload()
        expect(page.get_by_test_id(PROMPT)).to_be_visible()

    def test_09_a_prompt_over_the_header_is_caught_by_the_reach_check(self) -> None:
        """Negative control: the earlier placement (a layer pinned to the top) covers Back, and this suite sees it."""
        page = self.page()
        page.goto("/settings/notifications")
        expect(page.get_by_role("button", name="Back")).to_be_visible()
        self.offer_update(page)
        self.reach(page, "in the page")
        page.add_style_tag(content="""
          .pwa-update { position: fixed !important; z-index: 60; left: 50%; top: max(12px, env(safe-area-inset-top)); transform: translateX(-50%);
            width: min(460px, calc(100% - 24px)); margin: 0 !important; }""")
        page.wait_for_timeout(200)
        with self.assertRaisesRegex(AssertionError, "controls under the update prompt"):
            self.reach(page, "as a layer")
        # The same cover is what Playwright reported for 30 s: the tap never reaches Back.
        with self.assertRaises(Exception) as caught:
            page.get_by_role("button", name="Back").tap(timeout=1500)
        self.assertIn("pwa-update", str(caught.exception))

    def test_10_reload_keeps_the_unsent_draft_and_activates_the_new_version(self) -> None:
        """MOB-5: a person mid-sentence chooses Reload; the new worker takes the page and the draft is still in the composer."""
        page = self.page()
        page.goto(f"/projects/{self.project['id']}")
        composer = page.locator("#project-composer")
        expect(composer).to_be_visible()
        draft = "Probe 3 reads 41% after the rain, check the cable before Friday"
        composer.tap(timeout=5000)
        composer.fill(draft)
        # The draft is saved as it is typed; give the store its moment before the page goes away.
        page.wait_for_timeout(500)
        self.offer_update(page)
        self.assertFalse(page.evaluate("navigator.serviceWorker.controller.scriptURL.includes('deployment=next')"), "the old worker still controls the page")
        with page.expect_event("load"):
            page.get_by_test_id(PROMPT).get_by_role("button", name="Reload", exact=True).tap(timeout=5000)
        page.wait_for_function("navigator.serviceWorker.controller !== null && navigator.serviceWorker.controller.scriptURL.includes('deployment=next')", timeout=20000)
        expect(page.get_by_test_id(PROMPT)).to_have_count(0)
        expect(page.locator("#project-composer")).to_have_value(draft)
        # Negative control on the same page: a draft the store did not hold would be gone after a reload.
        page.evaluate("for (const store of [localStorage, sessionStorage]) Object.keys(store).filter((k) => (store.getItem(k) || '').includes('Probe 3 reads')).forEach((k) => store.removeItem(k))")
        page.reload()
        expect(page.locator("#project-composer")).to_have_value("")


if __name__ == "__main__":
    unittest.main()
