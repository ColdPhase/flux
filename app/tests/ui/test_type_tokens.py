"""Type, shape and touch targets measured in the running app (UI audit P3 batches #1373 and #1380).

Ada and Kai share a space. Kai mentions Ada and reads Ada's message, so the conversation shows a mention chip and a face under the message.
The checks use the audit's own in-page measurement (`visual_consistency_audit.MEASURE_JS`), so what the audit flags is what fails here:

- the conversation has no type flag (every size a --fs token, weights 400/500/600, Geist), times are Geist and the initials of the 16 px faces
  and of the mention chip stay inside their circle;
- the offline page is Geist, a 20 px title at 600 and a button with radius 10 at 32 px (44 on touch);
- Search's field and its Close share one height on a tablet, Close is a 44 px target, and the field shows the focus ring of README §2;
- Mine on the Tasks board is a system button (radius 10, 44 px on touch), not a circle or a pill;
- a material opened directly has a token-sized title (it drew the browser's 1.5em h2, 21 px), and the notification address tick is a 44 px
  target on touch. (The Inbox's filter counts of #1380 went with the filters, #1367.)
"""

from __future__ import annotations

import json
import re
import time
import unittest
import uuid

from playwright.sync_api import Browser, Page, expect, sync_playwright

import visual_consistency_audit as vca
from test_app_shell import ORIGIN, UI_BROWSER, UPSTREAM, start_forwarder

PASSWORD = "a long passphrase for the type checks"
STAMP = int(time.time() * 1000)
PEOPLE = {"ada": ("Ada Kowalska", f"ada.t+{STAMP}@example.test"), "kai": ("Kai Tanaka", f"kai.t+{STAMP}@example.test")}
TABLET = {"width": 820, "height": 1180}


class TypeTokens(unittest.TestCase):
    pw = None
    browser: Browser
    states: dict[str, dict] = {}
    project = ""
    material = ""

    @classmethod
    def setUpClass(cls) -> None:
        if UPSTREAM:
            start_forwarder(ORIGIN, UPSTREAM)
        cls.pw = sync_playwright().start()
        cls.browser = getattr(cls.pw, UI_BROWSER).launch()
        expect.set_options(timeout=10000)
        for key, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(service_workers="block", base_url=ORIGIN)
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.states[key] = context.storage_state()
            context.close()
        workspace = cls.api("ada", "POST", "/api/v1/workspaces", {"name": "Type checks"})["id"]
        cls.api("ada", "POST", f"/api/v1/workspaces/{workspace}/members", {"email": PEOPLE["kai"][1], "role": "member"})
        cls.project = cls.api("ada", "POST", f"/api/v1/workspaces/{workspace}/projects", {"name": "Community garden sensors", "visibility": "workspace"})["id"]
        cls.api("ada", "POST", f"/api/v1/projects/{cls.project}/work", {"title": "Calibrate the probes", "owner": {"kind": "human", "id": cls.me("ada")}})
        cls.material = cls.api("ada", "POST", f"/api/v1/projects/{cls.project}/materials", {"clientMutationId": str(uuid.uuid4()), "title": "Probe datasheet notes",
                                                                                         "body": "The capacitive probe drifts with humidity."})["materialId"]
        mine = cls.api("kai", "POST", f"/api/v1/projects/{cls.project}/conversations", {"body": "@Ada Kowalska the rota is in the Wiki now.", "clientMessageId": str(uuid.uuid4())})
        theirs = cls.api("ada", "POST", f"/api/v1/projects/{cls.project}/conversations", {"body": "Thanks, I will read it.", "clientMessageId": str(uuid.uuid4())})
        # Kai reads both, so the line under Ada's message carries his face.
        cls.api("kai", "POST", f"/api/v1/projects/{cls.project}/observations", {"messageIds": [mine["messages"][0]["id"], theirs["messages"][0]["id"]]}, ok=(200,))

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    @classmethod
    def api(cls, who: str, method: str, path: str, body: dict | None = None, ok=(200, 201)) -> dict:
        context = cls.browser.new_context(service_workers="block", base_url=ORIGIN, storage_state=cls.states[who])
        response = context.request.fetch(path, method=method, data=body, headers={"origin": ORIGIN, "idempotency-key": str(uuid.uuid4())})
        text = response.text()
        context.close()
        assert response.status in ok, f"{method} {path}: {response.status} {text[:200]}"
        return json.loads(text) if text else {}

    @classmethod
    def me(cls, who: str) -> str:
        return cls.api(who, "GET", "/api/v1/me")["user"]["id"]

    def page(self, who: str = "ada", touch: bool = False, dark: bool = False) -> Page:
        options = {"service_workers": "block", "base_url": ORIGIN, "storage_state": self.states[who], "color_scheme": "dark" if dark else "light"}
        options.update({"viewport": TABLET, "has_touch": True, "is_mobile": True} if touch else {"viewport": {"width": 1440, "height": 900}})
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        return context.new_page()

    def flags(self, page: Page, *rules: str) -> list[str]:
        found = page.evaluate(vca.MEASURE_JS, {})["flags"]
        return [f"{f['rule']} {f['detail']} | {f['sig']} {f['label']}" for f in found if f["rule"] in rules]

    def test_01_the_conversation_has_no_type_flag_and_its_faces_hold_their_initials(self) -> None:
        for dark in (False, True):
            page = self.page(dark=dark)
            page.goto(f"/projects/{self.project}")
            expect(page.locator(".ref-chip--person")).to_be_visible()
            page.evaluate("document.fonts.ready")
            self.assertEqual(self.flags(page, "d"), [], "every size is a token, every weight 400/500/600, every family Geist")
            # Times are interface text with tabular figures, never a monospace.
            for time_family in page.locator("time").evaluate_all("els => els.map((e) => [getComputedStyle(e).fontFamily, getComputedStyle(document.body).fontFamily])"):
                self.assertEqual(time_family[0], time_family[1], "a time uses the interface font")
            # The 16 px faces: the initials are --fs-face scaled to the circle, so the type is a token and the letters stay inside.
            faces = page.evaluate("""() => [...document.querySelectorAll('.seen .ui-avatar__i')].map((e) => {
              const token = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fs-face'));
              const face = e.parentElement.getBoundingClientRect(), text = e.getBoundingClientRect();
              return {size: parseFloat(getComputedStyle(e).fontSize), token, inside: text.left >= face.left - 0.5 && text.right <= face.right + 0.5};
            })""")
            for face in faces:
                self.assertAlmostEqual(face["size"], face["token"], delta=0.2)
                self.assertTrue(face["inside"], face)
            chip = page.evaluate("""() => { const f = document.querySelector('.ref-chip__face'); const s = getComputedStyle(f, '::before'); return {transform: s.transform, size: parseFloat(s.fontSize), face: f.getBoundingClientRect().width}; }""")
            self.assertEqual(chip["face"], 16)
            self.assertTrue(chip["transform"].startswith("matrix(0.72"), chip)

    def test_02_the_offline_page_is_geist_with_the_system_button(self) -> None:
        page = self.page()
        page.goto("/offline.html")
        page.evaluate("document.fonts.ready")
        look = page.evaluate("""() => { const h = getComputedStyle(document.querySelector('h1')), b = getComputedStyle(document.querySelector('button')), p = getComputedStyle(document.querySelector('p'));
          return {h: [h.fontFamily, h.fontSize, h.fontWeight], b: [b.fontFamily, b.borderRadius, b.minHeight, b.fontWeight], p: p.fontFamily}; }""")
        for family in (look["h"][0], look["b"][0], look["p"]):
            self.assertTrue(family.startswith("Geist"), look)
        self.assertEqual(look["h"][1:], ["20px", "600"])
        self.assertEqual(look["b"][1:], ["10px", "32px", "500"])
        self.assertEqual(self.flags(page, "d", "e"), [])

    def test_03_search_is_one_height_a_44_px_close_and_a_visible_ring_on_a_tablet(self) -> None:
        page = self.page(touch=True)
        page.goto("/")
        page.get_by_role("button", name="Search").first.tap()
        field = page.get_by_role("combobox", name="Search")
        expect(field).to_be_visible()
        close = page.locator(".jump__close")
        heights = [round(field.bounding_box()["height"]), round(close.bounding_box()["height"])]
        self.assertEqual(heights[0], heights[1], f"the field and Close share one height: {heights}")
        box = close.bounding_box()
        self.assertGreaterEqual(min(box["width"], box["height"]), 44, box)
        ring = page.locator(".jump__field").evaluate("el => getComputedStyle(el).outlineStyle + ' ' + getComputedStyle(el).outlineWidth")
        self.assertEqual(ring, "solid 2px", "the field's row carries the ring while the field has focus")
        self.assertEqual([flag for flag in self.flags(page, "a", "b") if "jump" in flag], [])

    def test_04_mine_on_the_board_is_a_system_button(self) -> None:
        for touch in (False, True):
            page = self.page(touch=touch)
            page.goto(f"/projects/{self.project}/tasks")
            mine = page.get_by_role("button", name="Mine", exact=True)
            expect(mine).to_be_visible()
            look = mine.evaluate("el => { const s = getComputedStyle(el); return {radius: s.borderTopLeftRadius, height: el.getBoundingClientRect().height, border: s.borderTopWidth}; }")
            self.assertEqual(look["radius"], "10px", look)
            self.assertEqual(look["border"], "1px", "an outline button")
            self.assertGreaterEqual(look["height"], 44 if touch else 32, look)
            self.assertEqual([flag for flag in self.flags(page, "b", "e") if "Mine" in flag], [])

    def test_05_a_material_title_and_the_address_tick(self) -> None:
        page = self.page()
        page.goto(f"/materials/{self.material}")
        title = page.get_by_role("heading", name="Probe datasheet notes")
        expect(title).to_be_visible()
        self.assertEqual(title.evaluate("e => getComputedStyle(e).fontSize"), "20px", "the title is --fs-xl, not the browser's 1.5em h2")
        self.assertEqual([flag for flag in self.flags(page, "d") if "material-view" in flag], [])
        page = self.page(touch=True)
        page.goto("/settings/notifications")
        tick = page.get_by_role("checkbox", name=re.compile("^Notification email to")).first
        expect(tick).to_be_visible()
        box = tick.bounding_box()
        self.assertGreaterEqual(min(box["width"], box["height"]), 44, box)
        self.assertEqual([flag for flag in self.flags(page, "b") if "nset__tick" in flag], [])


if __name__ == "__main__":
    unittest.main()
