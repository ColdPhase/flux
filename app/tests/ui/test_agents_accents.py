"""#148 AC-4 on the Agents view (UI116-2, #136): measured contrast with every accent in Light and Dark.

Runs with the other tests/ui journeys through scripts/check_ui.sh against the running Compose
application. Two owners connect three agents (Hubert: Codex and Claude Code; Marek: Claude Code)
to one restricted project, and both write in one task's thread, so Hubert's view shows his own
message on the accent-tinted surface beside Marek's. For each of the six combinations (Light and
Dark × Mint, Sky and Copper), chosen through the real per-device appearance storage, the test
measures the actual composited colours with test_theme_accents.MEASURE:

- text (4.5:1): the title, the connection owner, name and state, the task picker, the links, the
  thread caption, message metadata and bodies (own and others'), the composer text and hint, the
  current project tab and the Send label at rest, on hover and pressed;
- controls (3:1): the task picker and composer boundaries, the composer's focused boundary, the
  focus rings of the task picker, a link and Send, and the current tab's accent mark.

Hover and pressed Send use `filter: brightness()`, which MEASURE does not apply; the test applies
that filter to both colours before comparing, and fails on any other filter. Text is measured at
1440, 820 and 390 px; states at 1440. Screenshots (agents-accent-*.png) and the measurements
(agents-accent-contrast.json) go to FLUX_UI_SCREENSHOTS.
"""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, SHOTS, UPSTREAM, shot, start_forwarder
from test_theme_accents import FAMILIES, MEASURE

PASSWORD = "two owners, three agents, one lamp"
STAMP = int(time.time() * 1000)
PEOPLE = {
    "hubert": ("Hubert Nowak", f"hubert.accents+{STAMP}@example.test"),
    "marek": ("Marek Lis", f"marek.accents+{STAMP}@example.test"),
}
TASK = "Restore the connection to the lamp"
OWN = "I'll take the reconnect bug with Codex; Claude Code reviews it."
OTHER = "OK. Workshop PC is offline until tonight, so review it tomorrow morning."
TABLET = {"width": 820, "height": 1180}

# Text on its actual background: at least 4.5:1 in every combination and width.
TEXT = (
    ".agents__title",
    ".agents__connect",
    ".agents-conn__who b",
    ".agents-conn__who span",
    ".agents-conn__name",
    ".agents-conn__state",
    ".agents__task-label",
    ".agents__task select",
    ".agents__open",
    ".agents-thread__top",
    ".agents-thread__top .ui-link",
    ".agents-msg__meta",
    ".agents-msg__meta b",
    ".agents-msg:not(.agents-msg--own) .agents-msg__body",
    ".agents-msg--own .agents-msg__body",
    ".agents-composer textarea",
    ".agents-composer__hint",
    '.views .ui-tabs__tab[aria-current="page"]',
)
# Boundaries of controls at rest: at least 3:1.
BOUNDARIES = (
    (".agents__task select", {"property": "borderTopColor"}),
    (".agents-composer textarea", {"property": "borderTopColor"}),
    (".views .ui-tabs__indicator", {"property": "backgroundColor", "backgroundSelector": ".views"}),
)
PHONE_TEXT = ("header.top .top__switch-t", "header.top .top__view")
SEND = ".agents-composer .ui-btn--primary"


def luminance(rgb: list[float]) -> float:
    channels = [c / 255 for c in rgb]
    linear = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in channels]
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]


def ratio(a: list[float], b: list[float]) -> float:
    high, low = sorted((luminance(a), luminance(b)), reverse=True)
    return (high + 0.05) / (low + 0.05)


class AgentsAccentsJourney(unittest.TestCase):
    """Tests run in name order and share two accounts, one project and its task thread."""

    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    ids: dict[str, str] = {}
    measurements: list[dict] = []

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        expect.set_options(timeout=10000)
        contexts = {}
        for key, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(base_url=ORIGIN)
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.states[key] = context.storage_state()
            contexts[key] = context
        hubert, marek = contexts["hubert"], contexts["marek"]

        def post(context, path: str, body: dict) -> dict:
            response = context.request.post(path, data=body, headers={"origin": ORIGIN, "idempotency-key": str(uuid.uuid4())})
            assert response.status == 201, response.text()
            return response.json()

        workspace = post(hubert, "/api/v1/workspaces", {"name": "Lamp workshop"})["id"]
        post(hubert, f"/api/v1/workspaces/{workspace}/members", {"email": PEOPLE["marek"][1], "role": "member"})
        project = post(hubert, f"/api/v1/workspaces/{workspace}/projects", {"name": "Arduino lamp", "visibility": "restricted"})["id"]
        post(hubert, f"/api/v1/projects/{project}/grants", {"principal": {"kind": "human", "id": cls.ids["marek"]}, "role": "contributor"})
        for owner, agent_name, connections in ((hubert, "Hubert's coding agent", (("Desk laptop", "codex"), ("Travel laptop", "claude_code"))),
                                               (marek, "Marek's coding agent", (("Workshop PC", "claude_code"),))):
            agent = post(owner, f"/api/v1/workspaces/{workspace}/agents", {"name": agent_name, "owner": "self"})
            post(hubert, f"/api/v1/projects/{project}/grants", {"principal": {"kind": "agent", "id": agent["id"]}, "role": "contributor"})
            for name, client in connections:
                post(owner, "/api/v1/agent-connections", {"agentId": agent["id"], "selectedProjectIds": [project],
                     "scopes": ["flux.context.read", "flux.proposal.write"], "name": name, "clientDesignation": client})
        task = post(hubert, f"/api/v1/projects/{project}/work", {"title": TASK, "status": "in_progress"})["id"]
        for context, body in ((hubert, OWN), (marek, OTHER)):
            post(context, f"/api/v1/work/{task}/discussion", {"body": body, "clientMessageId": str(uuid.uuid4()), "kind": "text"})
        cls.ids.update(project=project, task=task)
        for context in contexts.values():
            context.close()

    @classmethod
    def tearDownClass(cls) -> None:
        if SHOTS:
            (SHOTS / "agents-accent-contrast.json").write_text(json.dumps(cls.measurements, indent=2) + "\n")
        cls.browser.close()
        cls.pw.stop()

    # ---------------------------------------------------------------- helpers

    def page(self, theme: str, family: str) -> Page:
        """Hubert's Agents view with the appearance stored the way the account menu stores it on this device."""
        context = self.browser.new_context(base_url=ORIGIN, storage_state=self.states["hubert"], viewport=DESKTOP, device_scale_factor=1,
                                           color_scheme=theme, locale="en-GB", timezone_id="Europe/Warsaw")
        self.addCleanup(context.close)
        context.add_init_script(f"localStorage.setItem('flux.theme', '{theme}'); localStorage.setItem('flux.accent.light', '{family}'); localStorage.setItem('flux.accent.dark', '{family}')")
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        page.goto(f"/projects/{self.ids['project']}/agents")
        expect(page.get_by_role("heading", level=1, name="Working together")).to_be_visible()
        expect(page.locator("html")).to_have_attribute("data-theme", theme)
        expect(page.locator("html")).to_have_attribute("data-accent", family)
        expect(page.get_by_role("list", name="Agent connections in this project").get_by_role("listitem")).to_have_count(3)
        thread = page.get_by_role("region", name=f"Thread of {TASK}")
        expect(thread.get_by_text(OWN)).to_be_visible()
        expect(thread.get_by_text(OTHER)).to_be_visible()
        expect(page.locator(".agents-msg--own .agents-msg__body")).to_have_text(OWN)
        expect(thread.get_by_role("link", name="Open in Conversation")).to_be_visible()
        return page

    def settle(self, page: Page, selector: str, spec: dict) -> None:
        """Resting production state: the target and its ancestors are opaque and no transition is running."""
        page.wait_for_function("""spec => {
          const el = document.querySelector(spec.selector); if (!el) return false;
          for (let n = el; n; n = n.parentElement) if (Number(getComputedStyle(n).opacity) !== 1) return false;
          return el.getAnimations().every((a) => a.playState === 'finished' || a.playState === 'idle');
        }""", arg={"selector": selector, **spec}, timeout=5000)

    def measure(self, page: Page, where: dict, selector: str, minimum: float = 4.5, **spec) -> dict:
        self.settle(page, selector, spec)
        value = page.evaluate(MEASURE, {"selector": selector, **spec})
        # MEASURE composites colours but ignores CSS filters. brightness() scales everything the element
        # paints: its text and its own background, but not the surroundings named by backgroundSelector.
        css_filter = page.evaluate("s => getComputedStyle(document.querySelector(s)).filter", selector)
        if css_filter != "none":
            match = re.fullmatch(r"brightness\(([0-9.]+)\)", css_filter)
            self.assertIsNotNone(match, f"{selector}: an unmeasured filter {css_filter}")
            factor = float(match.group(1))
            value["foreground"] = [min(255.0, c * factor) for c in value["foreground"]]
            if "backgroundSelector" not in spec:
                value["background"] = [min(255.0, c * factor) for c in value["background"]]
            value["ratio"] = ratio(value["foreground"], value["background"])
            value["filter"] = css_filter
        value.update(where, minimum=minimum)
        type(self).measurements.append(value)
        self.assertGreaterEqual(value["ratio"], minimum, value)
        return value

    def keyboard_focus(self, page: Page, selector: str) -> None:
        """Focus by keyboard, so :focus-visible shows the ring a keyboard user sees."""
        target = page.locator(selector)
        target.focus()
        page.keyboard.press("Shift+Tab")
        page.keyboard.press("Tab")
        expect(target).to_be_focused()
        self.assertEqual(target.evaluate("e => e.matches(':focus-visible')"), True, f"{selector} shows its keyboard focus")

    # ---------------------------------------------------------------- journeys

    def test_01_every_combination_meets_text_and_control_contrast(self) -> None:
        for theme in ("light", "dark"):
            for family in (name.lower() for name in FAMILIES):
                with self.subTest(theme=theme, family=family):
                    page = self.page(theme, family)
                    box = page.get_by_label("Write to this task")
                    box.fill("Firmware 1.4 fixes the reconnect loop; I'll flash both lamps tonight.")
                    box.evaluate("e => e.blur()")
                    for name, size in (("1440", DESKTOP), ("820", TABLET), ("390", PHONE)):
                        page.set_viewport_size(size)
                        page.wait_for_timeout(150)
                        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), size["width"], f"{name}: no horizontal page scroll")
                        where = {"theme": theme, "family": family, "width": name}
                        # On a phone the views open from the title, so there is no tab strip; the line under the
                        # title names the current view instead (#318, F-025 PA-9).
                        phone = size["width"] <= 640
                        for selector in (*TEXT, *(PHONE_TEXT if phone else ())):
                            self.measure(page, where, selector)
                        for selector, spec in BOUNDARIES:
                            if phone and selector.startswith(".views"):
                                continue
                            self.measure(page, where, selector, 3, **spec)
                        page.locator(".agents-scroll").evaluate("el => { el.scrollTop = el.scrollHeight; }")
                        shot(page, f"agents-accent-{theme}-{family}-{name}")
                    page.set_viewport_size(DESKTOP)
                    page.wait_for_timeout(150)
                    where = {"theme": theme, "family": family, "width": "1440"}

                    # Send at rest, on hover and pressed: the label on the button, and the button on the page.
                    send = page.locator(SEND)
                    expect(send).to_be_enabled()
                    for state in ("rest", "hover", "pressed"):
                        if state == "hover":
                            send.hover()
                        if state == "pressed":
                            page.mouse.down()
                        page.wait_for_timeout(250)
                        self.measure(page, {**where, "state": state}, SEND)
                        self.measure(page, {**where, "state": state}, SEND, 3, property="backgroundColor", backgroundSelector=".agents-composer")
                        if state == "pressed":
                            page.mouse.move(1, 1)
                            page.mouse.up()
                    self.assertEqual(box.input_value(), "Firmware 1.4 fixes the reconnect loop; I'll flash both lamps tonight.", "pressing and moving away sends nothing")

                    # Keyboard focus: the task picker's ring, the composer's boundary, Send's ring and a link's ring.
                    self.keyboard_focus(page, ".agents__task select")
                    self.measure(page, {**where, "state": "focus"}, ".agents__task select", 3, property="outlineColor")
                    self.keyboard_focus(page, ".agents-composer textarea")
                    self.measure(page, {**where, "state": "focus"}, ".agents-composer textarea", 3, property="borderTopColor")
                    self.keyboard_focus(page, SEND)
                    self.measure(page, {**where, "state": "focus"}, SEND, 3, property="outlineColor", backgroundSelector=".agents-composer")
                    self.keyboard_focus(page, ".agents__connect")
                    self.measure(page, {**where, "state": "focus"}, ".agents__connect", 3, property="outlineColor")
                    self.assertIn("underline", page.locator(".agents__connect").evaluate("e => getComputedStyle(e).textDecorationLine"), "links are more than colour")
                    shot(page, f"agents-accent-{theme}-{family}-1440-focus")

    def test_02_the_own_message_tint_follows_the_family(self) -> None:
        """The own-message surface is the family's soft accent, distinct per family and theme, never a status colour."""
        tints: dict[tuple[str, str], str] = {}
        for theme in ("light", "dark"):
            for family in (name.lower() for name in FAMILIES):
                page = self.page(theme, family)
                own = page.locator(".agents-msg--own .agents-msg__body")
                tints[(theme, family)] = own.evaluate("e => getComputedStyle(e).backgroundColor")
                soft = page.locator("html").evaluate("e => getComputedStyle(e).getPropertyValue('--accent-soft').trim()")
                expected = page.evaluate("""value => { const probe = document.createElement('i'); probe.style.color = value; document.body.append(probe);
                  const color = getComputedStyle(probe).color; probe.remove(); return color; }""", soft)
                self.assertEqual(tints[(theme, family)], expected, f"{theme}/{family}: the own message uses --accent-soft")
                other = page.locator(".agents-msg:not(.agents-msg--own) .agents-msg__body").evaluate("e => getComputedStyle(e).backgroundColor")
                self.assertNotEqual(other, tints[(theme, family)], "only the own message is tinted")
        for theme in ("light", "dark"):
            self.assertEqual(len({tints[(theme, family.lower())] for family in FAMILIES}), 3, f"{theme}: each family has its own tint")


if __name__ == "__main__":
    unittest.main(verbosity=2)
