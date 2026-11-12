"""Browser tests for space icons (F-040, #1227): a space admin sets an emoji, then a picture, then the letter again in Space settings;
another member's open sidebar follows each change without a reload; a member has no Change; the tile keeps its size and alignment
in the sidebar at 1440 × 900 and in the phone's Spaces list at 390 × 844, light and dark.

Runs through scripts/check_ui.sh against the running Compose application; FLUX_UI_BROWSER selects chromium (default) or webkit.
Screenshots (space-icon-*-<browser>.png) go to FLUX_UI_SCREENSHOTS when set.
"""

from __future__ import annotations

import os
import struct
import time
import unittest
import zlib

from playwright.sync_api import Browser, BrowserContext, Locator, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot as save_shot, start_forwarder

UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
if UI_BROWSER not in ("chromium", "webkit"):
    raise ValueError(f"FLUX_UI_BROWSER must be chromium or webkit, got {UI_BROWSER!r}")

PASSWORD = "spaces keep their tiles"
STAMP = int(time.time() * 1000)
PEOPLE = {"ada": ("Ada Kowalska", f"ada.icon+{STAMP}@example.test"), "ben": ("Ben Okafor", f"ben.icon+{STAMP}@example.test")}
SPACE = "Community garden"


def png(width: int, height: int, bands: list[tuple[int, int, int]]) -> bytes:
    """A small RGB PNG of vertical bands, written by hand so the test needs no image library."""
    row_of = lambda: b"\x00" + b"".join(bytes(bands[min(len(bands) - 1, x * len(bands) // width)]) for x in range(width))  # noqa: E731
    raw = b"".join(row_of() for _ in range(height))
    chunk = lambda kind, data: struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)  # noqa: E731
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


PICTURE = png(120, 60, [(30, 120, 200), (240, 170, 40), (30, 120, 200)])


def shot(page: Page, name: str) -> None:
    save_shot(page, f"space-icon-{name}-{UI_BROWSER}")


class SpaceIcon(unittest.TestCase):
    """Tests run in name order and share two accounts and one space (Ada is its admin, Ben a member)."""

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
        contexts: dict[str, BrowserContext] = {}
        for key, (name, email) in PEOPLE.items():
            context = cls.browser.new_context(service_workers="block", base_url=ORIGIN)
            response = context.request.post("/api/auth/sign-up/email", data={"email": email, "password": PASSWORD, "name": name}, headers={"origin": ORIGIN})
            assert response.status == 200, response.text()
            cls.ids[key] = context.request.get("/api/v1/me").json()["user"]["id"]
            cls.states[key] = context.storage_state()
            contexts[key] = context

        def call(path: str, body: dict) -> dict:
            response = contexts["ada"].request.post(path, data=body, headers={"origin": ORIGIN})
            assert response.status in (200, 201), f"{path}: {response.status} {response.text()}"
            return response.json()

        ws = call("/api/v1/workspaces", {"name": "Riverside Makers"})
        call(f"/api/v1/workspaces/{ws['id']}/members", {"email": PEOPLE["ben"][1], "role": "member"})
        pid = call(f"/api/v1/workspaces/{ws['id']}/projects", {"name": SPACE, "visibility": "restricted"})["id"]
        call(f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": cls.ids["ben"]}, "role": "contributor"})
        cls.ids["project"] = pid
        for context in contexts.values():
            context.close()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()

    def page(self, who: str, *, phone: bool = False, dark: bool = False) -> Page:
        options: dict = {"base_url": ORIGIN, "color_scheme": "dark" if dark else "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw",
                         "storage_state": self.states[who], "service_workers": "block"}
        if phone:
            options.update(viewport=PHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        else:
            options.update(viewport=DESKTOP, device_scale_factor=1)
        context: BrowserContext = self.browser.new_context(**options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "no uncaught page errors"))
        return page

    def settle(self, page: Page) -> None:
        page.wait_for_load_state("networkidle")
        page.wait_for_function("document.getAnimations().every((a) => a.playState !== 'running')")

    def side_tile(self, page: Page) -> Locator:
        return page.locator(f'.side .side__project[data-glide-id="{self.ids["project"]}"] .side__pj').first

    def geometry(self, tile: Locator) -> dict:
        return tile.evaluate("""el => { const r = el.getBoundingClientRect(), l = el.parentElement.querySelector('.side__label, .set-row__b');
          const t = l ? l.getBoundingClientRect() : r; return { w: r.width, h: r.height, x: Math.round(r.left), mid: Math.round(r.top + r.height / 2),
          labelMid: Math.round(t.top + t.height / 2), radius: getComputedStyle(el).borderTopLeftRadius }; }""")

    def icon_row(self, page: Page) -> Locator:
        return page.locator("[data-space-icon]")

    def test_01_emoji_picture_and_letter_reach_an_open_sidebar_live(self) -> None:
        ben = self.page("ben")
        ben.goto("/")
        tile = self.side_tile(ben)
        expect(tile).to_have_text("C")
        before = self.geometry(tile)
        self.settle(ben)
        shot(ben, "desktop-1440-letter-light")

        ada = self.page("ada")
        ada.goto(f"/projects/{self.ids['project']}/settings")
        row = self.icon_row(ada)
        expect(row).to_contain_text("Letter")
        row.get_by_role("button", name=f"Change the icon of {SPACE}").click()
        emoji = row.get_by_role("group", name="Emoji").get_by_role("button")
        expect(emoji).to_have_count(32)
        # Every emoji is a 44 px target.
        for size in emoji.evaluate_all("els => els.map((el) => [el.getBoundingClientRect().width, el.getBoundingClientRect().height])"):
            self.assertGreaterEqual(min(size), 44)
        row.get_by_role("button", name="🌱").click()
        expect(row.get_by_role("button", name="🌱")).to_have_attribute("aria-pressed", "true")
        expect(row.locator(".spset__name .spset__tile")).to_have_text("🌱")
        self.settle(ada)
        shot(ada, "desktop-1440-settings-emoji-light")
        row.get_by_role("button", name="Save icon").click()
        expect(row).to_contain_text("Emoji")
        # Ben's open sidebar follows without a reload; the tile keeps its size, place, radius and centre line.
        expect(tile).to_have_text("🌱")
        after = self.geometry(tile)
        self.assertEqual({k: after[k] for k in ("w", "h", "x", "mid", "radius")}, {k: before[k] for k in ("w", "h", "x", "mid", "radius")})
        self.assertLessEqual(abs(after["mid"] - after["labelMid"]), 1, "the tile and the name stay on one line")
        self.settle(ben)
        shot(ben, "desktop-1440-emoji-light")

        # A picture: refused by its bytes when it is not one, then the real one.
        row.get_by_role("button", name=f"Change the icon of {SPACE}").click()
        files = row.locator("input[type=file]")
        files.set_input_files({"name": "garden.png", "mimeType": "image/png", "buffer": b"<svg xmlns='http://www.w3.org/2000/svg'/>"})
        expect(row.get_by_role("alert")).to_have_text("Choose a PNG, JPEG or WebP picture.")
        files.set_input_files({"name": "garden.png", "mimeType": "image/png", "buffer": PICTURE})
        expect(row.locator(".spset__name img")).to_be_visible()
        row.get_by_role("button", name="Save icon").click()
        expect(row).to_contain_text("Picture")
        picture = tile.locator("img.space-face--pic")
        expect(picture).to_be_visible()
        picture.evaluate("el => el.decode().catch(() => undefined)")
        facts = picture.evaluate("el => ({ src: el.currentSrc, natural: el.naturalWidth, w: el.getBoundingClientRect().width, tile: el.parentElement.getBoundingClientRect().width })")
        self.assertIn("/api/v1/pictures/", facts["src"])
        self.assertTrue(facts["src"].startswith(ORIGIN), facts)
        self.assertGreater(facts["natural"], 0)
        self.assertAlmostEqual(facts["w"], facts["tile"], delta=0.5)
        self.assertEqual(self.geometry(tile)["w"], before["w"])
        self.settle(ben)
        shot(ben, "desktop-1440-picture-light")

        # Back to the letter.
        row.get_by_role("button", name=f"Change the icon of {SPACE}").click()
        row.get_by_role("button", name="Use the letter").click()
        row.get_by_role("button", name="Save icon").click()
        expect(row).to_contain_text("Letter")
        expect(tile).to_have_text("C")
        expect(tile.locator("img")).to_have_count(0)

    def test_02_a_member_has_no_change_and_dark_and_phone_keep_the_tile(self) -> None:
        ada = self.page("ada")
        response = ada.request.put(f"/api/v1/projects/{self.ids['project']}/icon", data={"emoji": "🌻"}, headers={"origin": ORIGIN})
        self.assertEqual(response.status, 200, response.text())
        ben = self.page("ben", dark=True)
        ben.goto(f"/projects/{self.ids['project']}/settings")
        row = self.icon_row(ben)
        expect(row).to_contain_text("Emoji")
        expect(row.get_by_role("button", name=f"Change the icon of {SPACE}")).to_have_count(0)
        expect(self.side_tile(ben)).to_have_text("🌻")
        self.settle(ben)
        shot(ben, "desktop-1440-emoji-dark")
        for dark in (False, True):
            phone = self.page("ben", phone=True, dark=dark)
            phone.goto("/projects")
            entry = phone.locator(".proj-index__tile").first
            expect(entry).to_have_text("🌻")
            facts = entry.evaluate("el => { const r = el.getBoundingClientRect(); return [r.width, r.height, r.right <= innerWidth]; }")
            self.assertEqual(facts, [32, 32, True])
            self.settle(phone)
            shot(phone, f"phone-390-spaces-{'dark' if dark else 'light'}")
        phone = self.page("ada", phone=True)
        phone.goto(f"/projects/{self.ids['project']}/settings")
        row = self.icon_row(phone)
        row.get_by_role("button", name=f"Change the icon of {SPACE}").tap()
        grid = row.get_by_role("group", name="Emoji")
        # The picker fits its card on the phone: every emoji is inside it, in as many columns as fit (rows of 8 where there is room).
        fit = grid.evaluate("""el => { const card = el.closest('.sset-card').getBoundingClientRect();
          const boxes = [...el.querySelectorAll('button')].map((b) => b.getBoundingClientRect());
          return { inside: boxes.every((b) => b.left >= card.left && b.right <= card.right), columns: new Set(boxes.map((b) => Math.round(b.left))).size }; }""")
        self.assertTrue(fit["inside"], fit)
        self.assertLessEqual(fit["columns"], 8)
        self.settle(phone)
        shot(phone, "phone-390-settings-light")


if __name__ == "__main__":
    unittest.main()
