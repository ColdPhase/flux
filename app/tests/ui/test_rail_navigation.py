"""#340/#357: the folded rail preserves real places, conversations and current account.

Actual authenticated routes/data and the existing sign-out form, Chromium/WebKit. No
fabricated navigation records or identity responses. Also checks enough real projects/DMs
to keep the working Stop and account reachable rather than certifying an empty rail.
"""
from __future__ import annotations

import re
import unittest
import uuid

from playwright.sync_api import Page, expect, sync_playwright
from account import sign_out_button

from test_app_shell import ORIGIN, UPSTREAM, shot, start_forwarder
from test_personal_assistant import mock
from touch_targets import has_minimum_touch_size

PASSWORD = "a complete calm rail"


class RailNavigation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browsers = {name: getattr(cls.pw, name).launch() for name in ("chromium", "webkit")}
        expect.set_options(timeout=10000)

    @classmethod
    def tearDownClass(cls):
        for browser in cls.browsers.values():
            browser.close()
        cls.pw.stop()

    def api(self, page: Page, method: str, path: str, body=None, status=200):
        response = page.request.fetch(path, method=method, headers={"origin": ORIGIN}, data=body)
        self.assertEqual(response.status, status, f"{path}: {response.status} {response.text()}")
        return response.json() if response.text() else None

    def setup_owner(self, engine, *, coarse=False, many=False, zoom=1):
        # `zoom` emulates browser zoom as the browser reports it (test_adaptive_matrix AdaptiveReflow): the window divided by it, with the
        # device pixel ratio multiplied by it. 1440×900 at 200 % is the 720×450 CSS viewport the persona rounds used.
        width, height = (1280, 800) if coarse else (1440, 900)
        context = self.browsers[engine].new_context(base_url=ORIGIN, viewport={"width": width // zoom, "height": height // zoom}, device_scale_factor=zoom,
            color_scheme="dark" if coarse else "light", has_touch=coarse, service_workers="block")
        self.addCleanup(context.close)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, []))
        email = f"ada.rail+{uuid.uuid4().hex}@example.test"
        self.api(page, "POST", "/api/auth/sign-up/email", {"name": "Ada Kowalska", "email": email, "password": PASSWORD})
        identity = self.api(page, "GET", "/api/v1/me")
        space = self.api(page, "POST", "/api/v1/workspaces", {"name": "Riverside makers"}, 201)
        projects = []
        for index in range(18 if many else 2):
            projects.append(self.api(page, "POST", f"/api/v1/workspaces/{space['id']}/projects", {
                "name": f"Garden sensor trial {index + 1}", "visibility": "restricted"}, 201))
        peer_context = self.browsers[engine].new_context(base_url=ORIGIN)
        self.addCleanup(peer_context.close)
        peer = peer_context.new_page()
        peer_email = f"jonas.rail+{uuid.uuid4().hex}@example.test"
        self.api(peer, "POST", "/api/auth/sign-up/email", {"name": "Jonas Berg", "email": peer_email, "password": PASSWORD})
        peer_id = self.api(peer, "GET", "/api/v1/me")["user"]["id"]
        self.api(page, "POST", f"/api/v1/workspaces/{space['id']}/members", {"email": peer_email, "role": "member"}, 201)
        dm = self.api(page, "POST", f"/api/v1/workspaces/{space['id']}/dms", {"participantIds": [peer_id]}, 201)
        self.api(peer, "POST", f"/api/v1/dms/{dm['id']}/messages", {"body": "Bring the ToF boards for Friday’s dark-room test.", "clientMessageId": str(uuid.uuid4())}, 201)
        page.goto("/")
        expect(page.get_by_role("heading", name="Home", exact=True)).to_be_visible()
        # A window under 900 px has the rail already.
        if zoom == 1:
            page.get_by_role("button", name="Collapse sidebar").click()
        expect(page.locator(".side--rail")).to_be_visible()
        return page, {"email": email, "user": identity["user"]["id"], "workspace": space["id"], "dm": dm["id"], "projects": projects, "peer": peer, "peer_id": peer_id}

    def assert_native_target(self, page, locator, coarse):
        self.assertEqual(locator.evaluate("el => ['A','BUTTON'].includes(el.tagName)"), True)
        locator.focus()
        expect(locator).to_be_focused()
        page.keyboard.press("Tab")
        page.keyboard.press("Shift+Tab")
        expect(locator).to_be_focused()
        self.assertTrue(locator.evaluate("el => el.matches(':focus-visible') && parseFloat(getComputedStyle(el).outlineWidth)>=2"))
        if coarse:
            rect = locator.bounding_box()
            self.assertTrue(has_minimum_touch_size(rect["width"]) and has_minimum_touch_size(rect["height"]), str(rect))

    def test_01_my_map_and_settings_keep_native_routes_in_the_rail(self):
        for engine in self.browsers:
            for coarse in (False, True):
                with self.subTest(engine=engine, coarse=coarse):
                    page, ids = self.setup_owner(engine, coarse=coarse)
                    rail = page.locator(".side--rail")
                    my_map = rail.get_by_role("link", name="My map", exact=True)
                    self.assertEqual(my_map.count(), 1, "the rail must preserve My map")
                    self.assert_native_target(page, my_map, coarse)
                    my_map.press("Enter")
                    expect(page).to_have_url(re.compile(r"/map/[0-9a-f-]{36}$"))  # My map opens at its own address (#866)
                    expect(my_map).to_have_attribute("aria-current", "page")
                    # The map has drawn its page: while it still loads (`.sk-page--center`) nothing after the rail can take focus, so a Tab
                    # from the face leaves the document and Shift+Tab comes back to the page's last control, not to the face.
                    expect(page.locator(".sk-page--map")).to_be_visible()
                    # The face is the one way to Settings, on the rail as in the sidebar (#1419): there is no gear beside it.
                    settings = rail.get_by_role("link", name=re.compile(r"^Ada Kowalska, Settings$"))
                    self.assertEqual(settings.count(), 1, "the rail must preserve Settings")
                    self.assertEqual(rail.get_by_role("link", name="Settings", exact=True).count(), 0, "no second way to Settings")
                    self.assert_native_target(page, settings, coarse)
                    settings.press("Enter")
                    expect(page).to_have_url(re.compile(r"/settings$"))
                    expect(page.get_by_role("heading", name="Settings", exact=True)).to_be_visible()
                    side = page.get_by_role("complementary", name="Sidebar")
                    # SizeSwap animates the aside's width (#720/#722); read it once that has finished (#730).
                    side.evaluate("el => Promise.all(el.getAnimations().map((animation) => animation.finished.catch(() => null)))")
                    self.assertAlmostEqual(side.bounding_box()["width"], 64, delta=.001)
                    shot(page, f"340-rail-navigation-{engine}-{'dark-coarse' if coarse else 'light'}")

    def test_02_current_account_opens_settings_and_signs_out_there(self):
        for engine in self.browsers:
            with self.subTest(engine=engine):
                page, ids = self.setup_owner(engine, coarse=True)
                rail = page.locator(".side--rail")
                account = rail.get_by_role("link", name=re.compile("Ada Kowalska, Settings"))
                self.assertEqual(account.count(), 1, "the rail must identify the current account")
                expect(account.locator(".ui-avatar")).to_have_text("AK")
                self.assert_native_target(page, account, True)
                # The face opens Settings (#1419): no menu opens, and Sign out is a row of Settings › Account.
                account.press("Enter")
                expect(page.get_by_role("dialog", name="Account", exact=True)).to_have_count(0)
                expect(page).to_have_url(re.compile(r"/settings$"))
                page.get_by_role("link", name=re.compile(r"^Account")).first.click()
                expect(page.get_by_role("region", name="Signed in as").get_by_text(ids["email"])).to_be_visible()
                for text200 in (False, True):
                    page.evaluate("large => document.documentElement.style.fontSize = large ? '200%' : ''", text200)
                    expect(account).to_be_visible()
                    shot(page, f"340-rail-account-{engine}-{'text200' if text200 else 'default'}")
                page.evaluate("document.documentElement.style.fontSize = ''")
                sign_out_button(page).click()
                expect(page.get_by_role("heading", name="Sign in", exact=True)).to_be_visible()
                self.api(page, "GET", "/api/v1/me", status=401)
                page.get_by_label("Email").fill(ids["email"])
                page.get_by_label("Password", exact=True).fill(PASSWORD)
                page.get_by_role("button", name="Sign in", exact=True).click()
                expect(page.get_by_role("heading", name="Home", exact=True)).to_be_visible()
                self.assertEqual(self.api(page, "GET", "/api/v1/me")["user"]["id"], ids["user"])
                expect(page.locator(".side--rail").get_by_role("link", name=re.compile("Ada Kowalska, Settings"))).to_be_visible()

    def test_03_real_messages_and_many_projects_do_not_remove_account_access(self):
        for engine in self.browsers:
            with self.subTest(engine=engine):
                page, ids = self.setup_owner(engine, coarse=True, many=True)
                rail = page.locator(".side--rail")
                messages = rail.get_by_role("link", name="Messages", exact=True)
                self.assertEqual(messages.count(), 1, "the rail must preserve its real Messages place")
                self.assert_native_target(page, messages, True)
                messages.press("Enter")
                expect(page).to_have_url(re.compile(r"/dm$"))
                dm = rail.get_by_role("link", name=re.compile(r"^Jonas Berg(?:, new messages)?$"))
                self.assertEqual(dm.count(), 1, "a real authorized private conversation keeps an avatar link")
                self.assert_native_target(page, dm, True)
                dm.press("Enter")
                expect(page).to_have_url(re.compile(rf"/dm/{ids['dm']}$"))
                expect(page.get_by_text("Bring the ToF boards for Friday’s dark-room test.", exact=True)).to_be_visible()
                account = rail.get_by_role("link", name=re.compile("Ada Kowalska, Settings"))
                expect(account).to_be_in_viewport()
                expect(rail.get_by_role("button", name="Expand sidebar")).to_be_in_viewport()
                self.assertEqual(page.evaluate("document.documentElement.scrollWidth - innerWidth"), 0)
                shot(page, f"340-rail-populated-messages-{engine}")

    def test_04_many_projects_preserve_real_working_stop_and_account(self):
        for engine in self.browsers:
            with self.subTest(engine=engine):
                page, ids = self.setup_owner(engine, coarse=True, many=True)
                project = ids["projects"][0]["id"]
                agent = self.api(page, "POST", f"/api/v1/workspaces/{ids['workspace']}/agents", {"name": "Garden analyst", "owner": "self"}, 201)
                # #854: the model of a connection (Connect AI's default: the TEST-ONLY fixture key); nothing else to agree to.
                default = self.api(page, "GET", "/api/v1/personal-assistant/model", None, 200)["default"]
                self.api(page, "POST", "/api/v1/my-agents", {"agentId": agent["id"], **default}, 201)
                conversation = self.api(page, "POST", f"/api/v1/projects/{project}/conversations", {
                    "body": "Compare the sensors for the east garden bed.", "clientMessageId": str(uuid.uuid4())}, 201)
                mock("/__script", {"reset": True, "delay": 30})
                run = self.api(page, "POST", f"/api/v1/conversations/{conversation['id']}/assistant-runs", {
                    "clientRunId": str(uuid.uuid4()), "kind": "ask", "prompt": "Which sensor should we test tomorrow?"}, 202)
                self.addCleanup(lambda page=page, run=run: self.api(page, "POST", f"/api/v1/assistant-runs/{run['id']}/stop"))
                page.evaluate("window.dispatchEvent(new Event('focus'))")
                rail = page.locator(".side--rail")
                stop = rail.get_by_role("button", name="Stop your assistant", exact=True)
                expect(stop).to_be_visible()
                shot(page, f"340-rail-populated-before-controls-{engine}")
                expect(stop).to_be_in_viewport()
                expect(rail.get_by_role("link", name=re.compile("Ada Kowalska, Settings"))).to_be_in_viewport()
                self.assert_native_target(page, stop, True)
                shot(page, f"340-rail-populated-working-{engine}")
                with page.expect_response(lambda response: response.request.method == "POST" and
                        response.url.endswith(f"/api/v1/assistant-runs/{run['id']}/stop")) as stopped:
                    stop.press("Space")
                self.assertEqual(stopped.value.status, 200)
                self.assertEqual(stopped.value.json()["id"], run["id"])
                current = self.api(page, "GET", f"/api/v1/assistant-runs/{run['id']}")
                self.assertTrue(current["stopRequested"] or current["status"] == "stopped", str(current["status"]))
                expect(rail.locator(".agentlive")).to_have_count(0, timeout=25000)
                expect(rail.get_by_role("link", name=re.compile("Ada Kowalska, Settings"))).to_be_in_viewport()

    # ---------------------------------------------------------------- 200 % (personas-33/34/35 P3s)

    def test_05_at_200_percent_the_rail_count_and_search_are_clear(self):
        """The Inbox count sat on its icon, and Search was half under New once the rail's band scrolled to the open space."""
        for engine in self.browsers:
            with self.subTest(engine=engine):
                page, ids = self.setup_owner(engine, many=True, zoom=2)
                self.api(ids["peer"], "POST", f"/api/v1/dms/{ids['dm']}/messages", {"body": "Can you bring the boards on Friday?", "clientMessageId": str(uuid.uuid4())}, 201)
                page.goto(f"/projects/{ids['projects'][-1]['id']}")
                rail = page.locator(".side--rail")
                inbox = rail.get_by_role("link", name=re.compile(r"^Inbox, \d+ new$"))
                expect(inbox).to_be_visible()
                page.wait_for_timeout(400)
                count = page.evaluate("""() => { const link = document.querySelector('.side--rail a[href="/inbox"]'); const c = link.querySelector('.side__count--rail').getBoundingClientRect();
                  const i = link.querySelector('svg').getBoundingClientRect();
                  return { overlap: Math.min(c.right, i.right) - Math.max(c.left, i.left) > 0.5 && Math.min(c.bottom, i.bottom) - Math.max(c.top, i.top) > 0.5,
                    count: [c.left, c.top, c.right, c.bottom], icon: [i.left, i.top, i.right, i.bottom] }; }""")
                self.assertFalse(count["overlap"], f"the Inbox count stands beside its icon, not on it: {count}")
                problems = page.evaluate("""() => { const search = document.querySelector('.side--rail button[aria-label="Search"]'); const r = search.getBoundingClientRect(); const found = [];
                  for (let up = search.parentElement; up && up !== document.body; up = up.parentElement) {
                    const style = getComputedStyle(up); if (style.overflowY === 'visible' && style.overflowX === 'visible') continue;
                    const b = up.getBoundingClientRect(); const top = up.hasAttribute('data-scroll-up') ? 24 : 0; const bottom = up.hasAttribute('data-scroll-down') ? 28 : 0;
                    if (r.top < b.top + top - 0.5 || r.bottom > b.bottom - bottom + 0.5) found.push(`cut or faded by ${up.className}`); }
                  const add = document.querySelector('.side--rail .side__new'); if (add) { const k = add.getBoundingClientRect(); if (Math.min(k.bottom, r.bottom) - Math.max(k.top, r.top) > 0.5) found.push('under New'); }
                  if (!search.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))) found.push('its middle is covered');
                  return found; }""")
                self.assertEqual(problems, [], "Search is whole and clear of New")
                shot(page, f"p3b-rail-200-{engine}")

    def test_06_at_200_percent_a_toast_does_not_cover_the_new_task_s_panel(self):
        """The toast "Task #12 created · Undo · Another task" stood on the new task's Due row."""
        for engine in self.browsers:
            with self.subTest(engine=engine):
                page, ids = self.setup_owner(engine, zoom=2)
                page.goto(f"/projects/{ids['projects'][0]['id']}")
                expect(page.locator(".project-convo")).to_be_visible()
                page.evaluate("() => document.activeElement instanceof HTMLElement && document.activeElement.blur()")
                page.keyboard.press("c")
                dialog = page.get_by_role("dialog", name="New task")
                expect(dialog).to_be_visible()
                dialog.get_by_label("Title", exact=True).fill("Wipe the big letters board")
                dialog.get_by_role("button", name=re.compile("^Create task")).click()
                toast = page.locator(".ui-toast").filter(has_text=re.compile(r"Task #\d+ created"))
                expect(toast).to_be_visible()
                panel = page.locator("#details")
                expect(panel).to_contain_text("Wipe the big letters board")
                page.wait_for_timeout(800)
                apart = page.evaluate("""() => { const t = document.querySelector('.ui-toast:not([data-leaving])').getBoundingClientRect(); const p = document.getElementById('details').getBoundingClientRect();
                  return { apart: t.right <= p.left + 0.5 || t.left >= p.right - 0.5 || t.bottom <= p.top + 0.5 || t.top >= p.bottom - 0.5, toast: [t.left, t.top, t.right, t.bottom], panel: [p.left, p.top, p.right, p.bottom],
                    inWindow: t.left >= 0 && t.right <= innerWidth }; }""")
                self.assertTrue(apart["apart"], f"the toast stands beside the panel, not on it: {apart}")
                self.assertTrue(apart["inWindow"], f"the toast stays in the window: {apart}")
                expect(toast.get_by_role("button", name="Undo")).to_be_visible()
                shot(page, f"p3b-toast-beside-panel-200-{engine}")

    def test_07_at_200_percent_r_on_a_decision_keeps_accept_in_view(self):
        """R on a decision in the Inbox opened its panel scrolled to the discussion, with Accept, Not now and Discuss out of view above it."""
        for engine in self.browsers:
            with self.subTest(engine=engine):
                page, ids = self.setup_owner(engine, zoom=2)
                pid = ids["projects"][0]["id"]
                self.api(page, "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": ids["peer_id"]}, "role": "contributor"}, 201)
                decision = self.api(ids["peer"], "POST", f"/api/v1/projects/{pid}/decisions", {"title": "Bread prices go up by 10 % from December",
                    "rationale": "Flour costs more since October.\n\nThe ovens use more power in winter, and the rolls stay as they are."}, 201)
                for line in ("The supplier wrote on Monday.", "Rye flour is up the most.", "We could keep the small loaf as it is.", "Let us decide this week."):
                    said = ids["peer"].request.post(f"/api/v1/decisions/{decision['id']}/discussion", data={"body": line, "clientMessageId": str(uuid.uuid4())}, headers={"origin": ORIGIN})
                    self.assertIn(said.status, (200, 201), said.text())
                page.goto("/inbox")
                item = page.locator(".nyq__list .nyc", has_text="Bread prices go up")
                expect(item).to_be_visible()
                expect(item.locator(".nyc__open")).to_be_focused()
                page.keyboard.press("r")
                field = page.locator("#decision-composer")
                expect(field).to_be_focused()
                page.keyboard.type("Do the rolls go up too?")
                page.keyboard.press("Enter")
                panel = page.locator("#details")
                expect(panel.get_by_text("Do the rolls go up too?")).to_be_visible()
                page.wait_for_timeout(600)
                for name in ("Accept", "Discuss"):
                    button = panel.get_by_role("button", name=name, exact=True)
                    shown = button.evaluate("el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); }")
                    self.assertTrue(shown, f"{name} is in view with the discussion")
                self.assertTrue(panel.get_by_text("Do the rolls go up too?").evaluate(
                    "el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.left + 4, r.top + r.height / 2)); }"), "and so is the message just sent")
                shot(page, f"p3b-decision-r-200-{engine}")

    # ---------------------------------------------------------------- personas-36 (200 %)

    ROOM = """(root) => {
      const scroller = root.querySelector('.wd__scroll'); const box = scroller.getBoundingClientRect();
      const clear = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const x = r.left + Math.min(r.width / 2, 24), y = r.top + r.height / 2;
        return y > box.top && y < box.bottom && el.contains(document.elementFromPoint(x, y)); };
      const named = (name) => [...root.querySelectorAll('.wd-decide button')].find((b) => b.textContent.trim() === name);
      const buttons = Object.fromEntries(['Accept', 'Not now', 'Discuss'].filter(named).map((name) => [name, clear(named(name))]));
      const lines = [...root.querySelectorAll('.wd-discussion__list .wd-act__item')].filter((li) => clear(li.querySelector('.message-bubble') ?? li)).length;
      // What stays pinned at the top of the scrolling area: the title and the answer, where they stick.
      let pinned = box.top;
      for (const el of root.querySelectorAll('.wd-decision-identity, .wd-decide')) {
        const r = el.getBoundingClientRect(); if (r.bottom > box.top + 1 && r.top < box.top + 2) pinned = Math.max(pinned, r.bottom); }
      // The field is under the scrolling area, at the panel's foot: in the window and not covered.
      const field = root.querySelector('#decision-composer'); const f = field?.getBoundingClientRect();
      const shown = !!f && f.height > 0 && f.bottom <= innerHeight + 0.5 && field.contains(document.elementFromPoint(f.left + Math.min(f.width / 2, 40), f.top + f.height / 2));
      return { buttons, lines, room: Math.round(box.bottom - pinned), height: Math.round(box.height), field: shown };
    }"""

    def assert_discussion_room(self, page, label, *, long, lines=2):
        panel = page.locator("#details")
        expect(panel.locator(".wd-discussion__list .wd-act__item").last).to_be_visible()
        page.wait_for_timeout(600)
        seen = panel.evaluate(self.ROOM)
        self.assertTrue(seen["buttons"] and all(seen["buttons"].values()), f"{label}: Accept, Not now and Discuss are in view: {seen}")
        self.assertTrue(seen["field"], f"{label}: “Write about this decision…” is in view: {seen}")
        self.assertGreaterEqual(seen["lines"], lines if long else 1, f"{label}: the discussion shows its lines: {seen}")
        if long:
            self.assertGreaterEqual(seen["room"], seen["height"] * 0.5, f"{label}: the discussion keeps at least half of the scrolling room: {seen}")
        return seen

    def test_08_at_200_percent_a_decision_s_answer_leaves_its_discussion_room(self):
        """personas-36 P2: at 200 % a decision with 14 messages, opened by R or directly, showed Accept, Not now and Discuss and not one line of
        its discussion: the pinned title and answer filled the panel's 209 px. They stick only while they leave the discussion its room; then
        the answer is a bar of its buttons. At 100 % and 200 %, short and long, on the computer and on a phone with large text."""
        for engine in self.browsers:
            with self.subTest(engine=engine):
                page, ids = self.setup_owner(engine, zoom=2)
                pid = ids["projects"][0]["id"]
                self.api(page, "POST", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": ids["peer_id"]}, "role": "contributor"}, 201)

                def propose(title, lines):
                    decision = self.api(ids["peer"], "POST", f"/api/v1/projects/{pid}/decisions", {"title": title,
                        "rationale": "Flour costs more since October.\n\nThe ovens use more power in winter, and the rolls stay as they are."}, 201)
                    for line in lines:
                        said = ids["peer"].request.post(f"/api/v1/decisions/{decision['id']}/discussion", data={"body": line, "clientMessageId": str(uuid.uuid4())}, headers={"origin": ORIGIN})
                        self.assertIn(said.status, (200, 201), said.text())
                    return decision

                short = propose("The shop opens at 7 on Saturdays", ["Fine by me."])
                long = propose("Bread prices go up by 10 % from December", [f"Line {n + 1}: the supplier wrote again about the rye." for n in range(14)])
                # By R from the Inbox, at 200 %.
                page.goto("/inbox")
                item = page.locator(".nyq__list .nyc", has_text="Bread prices go up")
                expect(item).to_be_visible()
                for _ in range(4):
                    if item.get_attribute("aria-current") == "true":
                        break
                    page.keyboard.press("j")
                expect(item).to_have_attribute("aria-current", "true")
                page.keyboard.press("r")
                expect(page.locator("#decision-composer")).to_be_focused()
                self.assert_discussion_room(page, "200 %, R", long=True)
                shot(page, f"p3b-decision-room-r-200-{engine}")
                # Directly by its address, at 200 % and at 100 %, the long one scrolled to its newest line and the short one as it opens.
                state = page.context.storage_state()
                for zoom in (2, 1):
                    context = self.browsers[engine].new_context(base_url=ORIGIN, viewport={"width": 1440 // zoom, "height": 900 // zoom}, device_scale_factor=zoom,
                        storage_state=state, service_workers="block")
                    self.addCleanup(context.close)
                    other = context.new_page()
                    for decision, is_long in ((long, True), (short, False)):
                        other.goto(f"/projects/{pid}?open=decision:{decision['id']}")
                        expect(other.locator("#details .wd-decide")).to_be_visible()
                        other.locator("#details .wd__scroll").evaluate("el => { el.scrollTop = el.scrollHeight; }")
                        self.assert_discussion_room(other, f"{zoom * 100} %, direct, {'long' if is_long else 'short'}", long=is_long)
                    shot(other, f"p3b-decision-room-direct-{zoom * 100}-{engine}")
                # A phone with large text (the root at 200 % from the first frame), its sheet opened directly and read to the end.
                phone = self.browsers[engine].new_context(base_url=ORIGIN, viewport={"width": 390, "height": 844}, device_scale_factor=3, is_mobile=engine == "chromium",
                    has_touch=True, storage_state=state, service_workers="block")
                self.addCleanup(phone.close)
                phone.add_init_script("document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.fontSize = '200%'; })")
                sheet = phone.new_page()
                sheet.goto(f"/projects/{pid}?open=decision:{long['id']}")
                expect(sheet.locator("#details .wd-decide")).to_be_visible()
                sheet.locator("#details .wd__scroll").evaluate("el => { el.scrollTop = el.scrollHeight; }")
                # A message at twice the size is about as tall as the room for two: one whole line at least, in half the room or more.
                self.assert_discussion_room(sheet, "phone, large text", long=True, lines=1)
                shot(sheet, f"p3b-decision-room-phone-large-{engine}")

    def test_09_at_200_percent_the_places_stay_pinned_and_the_open_space_is_in_view(self):
        """Round 14 P2 (look-a A11, round-37 admin V6): at 200 % (1440×900 is 720×450) the rail scrolled as one band, so on a space page Home was
        above the window and Search's neighbour was cut. Home, Inbox, My tasks and My map stay pinned under Search, whole and in the window; only
        the spaces and messages scroll, and they bring the open space into view (personas-36: nothing half under Search)."""
        for engine in self.browsers:
            with self.subTest(engine=engine):
                page, ids = self.setup_owner(engine, many=True, zoom=2)
                check = """() => { const rail = document.querySelector('.side--rail'); const search = rail.querySelector('button[aria-label="Search"]').getBoundingClientRect();
                  const found = []; const places = rail.querySelector('nav[aria-label="Places"]');
                  for (const el of places.querySelectorAll('a[href]')) { const r = el.getBoundingClientRect();
                    if (r.top < search.bottom - 0.5 || r.bottom > innerHeight + 0.5 || r.top < 0) found.push(`${el.getAttribute('aria-label')} is not whole under Search (${Math.round(r.top)}..${Math.round(r.bottom)})`);
                    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); if (!el.contains(hit)) found.push(`${el.getAttribute('aria-label')} is covered`); }
                  const band = rail.querySelector('.side__rail-middle');
                  return { found, band: band.scrollTop, list: rail.querySelector('.side__rail-scroll').scrollTop }; }"""
                for index in (len(ids["projects"]) - 1, len(ids["projects"]) // 2):
                    page.goto(f"/projects/{ids['projects'][index]['id']}")
                    expect(page.locator(".side--rail .side__rail-project.is-open")).to_be_visible()
                    page.wait_for_timeout(700)
                    seen = page.evaluate(check)
                    self.assertEqual(seen["found"], [], f"Home, Inbox, My tasks and My map are whole under Search on the space page: {seen}")
                    self.assertEqual(seen["band"], 0, f"the places do not scroll away: {seen}")
                    self.assertGreater(seen["list"], 0, f"the spaces' list brought the open space into view: {seen}")
                    shown = page.locator(".side--rail .side__rail-project.is-open").evaluate(
                        "el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); }")
                    self.assertTrue(shown, "the open space is in view")
                # Space settings, the page the round saw Home gone on, and the person's own scroll of the spaces leave the places where they are.
                page.goto(f"/projects/{ids['projects'][-1]['id']}/settings")
                expect(page.get_by_role("heading", name="Space settings")).to_be_visible()
                page.wait_for_timeout(700)
                self.assertEqual(page.evaluate(check)["found"], [], "the places are whole on Space settings")
                box = page.locator(".side--rail .side__rail-scroll").bounding_box()
                for delta in (-23, 37, -61):
                    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
                    page.mouse.wheel(0, delta)
                    page.wait_for_timeout(500)
                    seen = page.evaluate(check)
                    self.assertEqual(seen["found"], [], f"the places stay whole after a scroll of {delta}: {seen}")
                shot(page, f"round14-rail-200-pinned-{engine}")


if __name__ == "__main__":
    unittest.main()
