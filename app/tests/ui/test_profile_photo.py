"""Browser tests for profile photos (F-039, #1226): a person chooses a picture in Settings › Account, sees it as the circles
people will see, saves it, and everyone who can see them gets the photo in place of their initials: in a message, the people
list and the mention list, on the computer (1440 × 900) and the phone (390 × 844), light and dark. Remove goes back to the
initials. An agent is never drawn with a photo.

Runs through scripts/check_ui.sh against the running Compose application; FLUX_UI_BROWSER selects chromium (default) or webkit.
Screenshots (profile-photo-*-<browser>.png) go to FLUX_UI_SCREENSHOTS when set.
"""

from __future__ import annotations

import os
import struct
import time
import unittest
import uuid
import zlib

from playwright.sync_api import Browser, BrowserContext, Locator, Page, expect, sync_playwright

from test_app_shell import DESKTOP, ORIGIN, PHONE, UPSTREAM, shot as save_shot, start_forwarder

UI_BROWSER = os.environ.get("FLUX_UI_BROWSER", "chromium")
if UI_BROWSER not in ("chromium", "webkit"):
    raise ValueError(f"FLUX_UI_BROWSER must be chromium or webkit, got {UI_BROWSER!r}")

PASSWORD = "faces are user content"
STAMP = int(time.time() * 1000)
PEOPLE = {"ada": ("Ada Kowalska", f"ada.photo+{STAMP}@example.test"), "ben": ("Ben Okafor", f"ben.photo+{STAMP}@example.test")}
MESSAGE = "The seedlings are in the north bed; the labels follow tomorrow."


def png(width: int, height: int, bands: list[tuple[int, int, int]]) -> bytes:
    """A small RGB PNG of vertical bands, written by hand so the test needs no image library."""
    row_of = lambda: b"\x00" + b"".join(bytes(bands[min(len(bands) - 1, x * len(bands) // width)]) for x in range(width))  # noqa: E731
    raw = b"".join(row_of() for _ in range(height))
    chunk = lambda kind, data: struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)  # noqa: E731
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


# A wide picture: orange, teal, orange. Flux keeps the middle square, so the photo is teal.
PHOTO = png(300, 100, [(240, 140, 40), (20, 150, 140), (240, 140, 40)])
SVG = b'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'


def shot(page: Page, name: str) -> None:
    save_shot(page, f"profile-photo-{name}-{UI_BROWSER}")


def photo_in(scope: Locator) -> Locator:
    return scope.locator("img.ui-avatar__photo")


def assert_loaded_photo(case: unittest.TestCase, image: Locator, *, source: str = "/api/v1/pictures/") -> None:
    """The avatar shows a decoded photo from Flux itself, in the avatar's own circle."""
    expect(image).to_be_visible()
    image.evaluate("el => el.decode ? el.decode().catch(() => undefined) : undefined")
    facts = image.evaluate("""el => ({ src: el.currentSrc, natural: el.naturalWidth, width: el.getBoundingClientRect().width,
      avatar: el.parentElement.getBoundingClientRect().width, radius: getComputedStyle(el).borderRadius, fit: getComputedStyle(el).objectFit })""")
    case.assertIn(source, facts["src"], facts)
    case.assertTrue(facts["src"].startswith(ORIGIN) or facts["src"].startswith("blob:"), f"served by Flux only: {facts}")
    case.assertGreater(facts["natural"], 0, f"the photo decoded: {facts}")
    case.assertAlmostEqual(facts["width"], facts["avatar"], delta=0.5, msg=f"same circle size: {facts}")
    case.assertEqual(facts["fit"], "cover")
    case.assertTrue(facts["radius"] == "50%" or facts["radius"].endswith("px"), facts)


class ProfilePhoto(unittest.TestCase):
    """Tests run in name order and share two accounts, one company and one space."""

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

        def call(who: str, path: str, body: dict | None = None) -> dict:
            response = contexts[who].request.post(path, data=body, headers={"origin": ORIGIN})
            assert response.status in (200, 201), f"{path}: {response.status} {response.text()}"
            return response.json()

        ws = call("ada", "/api/v1/workspaces", {"name": "Riverside Makers"})
        call("ada", f"/api/v1/workspaces/{ws['id']}/members", {"email": PEOPLE["ben"][1], "role": "member"})
        pid = call("ada", f"/api/v1/workspaces/{ws['id']}/projects", {"name": "Community garden", "visibility": "restricted"})["id"]
        call("ada", f"/api/v1/projects/{pid}/grants", {"principal": {"kind": "human", "id": cls.ids["ben"]}, "role": "contributor"})
        call("ada", f"/api/v1/projects/{pid}/conversations", {"body": MESSAGE, "clientMessageId": str(uuid.uuid4())})
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

    def photo_row(self, page: Page) -> Locator:
        return page.locator("li.sset-acct").filter(has=page.get_by_text("Photo", exact=True))

    # ---------------------------------------------------------------- choosing and saving

    def test_01_choose_preview_and_save_on_the_computer(self) -> None:
        page = self.page("ada")
        page.goto("/settings/account")
        row = self.photo_row(page)
        expect(row).to_contain_text("Your initials")
        expect(photo_in(page.locator(".side, .me"))).to_have_count(0)
        row.get_by_role("button", name="Change photo").click()
        # Something that is not a PNG, JPEG or WebP is refused by its bytes, whatever its name says, and offers no Save.
        page.locator("input[type=file]").set_input_files({"name": "face.png", "mimeType": "image/png", "buffer": SVG})
        expect(row.get_by_role("alert")).to_have_text("Choose a PNG, JPEG or WebP picture.")
        expect(row.get_by_role("button", name="Save photo")).to_have_count(0)
        # A real picture: the preview is the 32 and 20 px circles people will see, then one line.
        page.locator("input[type=file]").set_input_files({"name": "garden.png", "mimeType": "image/png", "buffer": PHOTO})
        preview = row.locator("[data-photo-preview]")
        expect(preview.locator("img")).to_have_count(2)
        expect(preview).to_contain_text("Flux keeps the middle square.")
        self.assertEqual([round(box["width"]) for box in preview.locator(".ui-avatar").evaluate_all("els => els.map((el) => el.getBoundingClientRect())")], [32, 20])
        for image in preview.locator("img").all():
            assert_loaded_photo(self, image, source="blob:")
        expect(row.get_by_role("alert")).to_have_count(0)
        self.settle(page)
        shot(page, "desktop-1440-preview-light")
        with page.expect_response(lambda response: response.url.endswith("/api/v1/me/photo") and response.request.method == "PUT") as saved:
            row.get_by_role("button", name="Save photo").click()
        self.assertEqual(saved.value.status, 200)
        expect(row.get_by_role("status")).to_contain_text("Photo saved.")
        expect(row).to_contain_text("Your photo")
        # The account row at the bottom of the sidebar and the Account card now show the photo; it is the middle (teal) square.
        side = page.locator(".me__btn").first
        assert_loaded_photo(self, photo_in(side))
        assert_loaded_photo(self, photo_in(page.locator(".sset-me")))
        colour = photo_in(page.locator(".sset-me")).evaluate("""el => { const c = document.createElement('canvas'); c.width = c.height = 8;
          const g = c.getContext('2d'); g.drawImage(el, 0, 0, 8, 8); return [...g.getImageData(1, 1, 1, 1).data].slice(0, 3); }""")
        self.assertTrue(abs(colour[0] - 20) < 40 and abs(colour[1] - 150) < 40 and abs(colour[2] - 140) < 40, f"the middle square is kept: {colour}")
        self.settle(page)
        shot(page, "desktop-1440-account-light")

    # ---------------------------------------------------------------- what others see

    def test_02_others_see_it_in_a_message_the_people_list_and_mentions(self) -> None:
        for dark in (False, True):
            page = self.page("ben", dark=dark)
            page.goto(f"/projects/{self.ids['project']}")
            message = page.locator("li").filter(has_text=MESSAGE).last
            expect(message).to_be_visible()
            assert_loaded_photo(self, photo_in(message))
            # One request per rendition, then the browser keeps it: the address never changes for this photo.
            response = page.request.get(photo_in(message).evaluate("el => el.currentSrc"))
            self.assertEqual(response.headers["cache-control"], "private, max-age=31536000, immutable")
            self.assertEqual(response.headers["content-type"], "image/webp")
            self.settle(page)
            shot(page, f"desktop-1440-message-{'dark' if dark else 'light'}")
            composer = page.locator("#project-composer")
            composer.fill("@Ad")
            mentions = page.get_by_role("listbox", name="Mention")
            option = mentions.get_by_role("option").filter(has_text=PEOPLE["ada"][0])
            assert_loaded_photo(self, photo_in(option))
            shot(page, f"desktop-1440-mention-{'dark' if dark else 'light'}")
            composer.fill("")
            page.goto("/settings/company")
            person = page.locator(".people__item").filter(has_text=PEOPLE["ada"][0])
            assert_loaded_photo(self, photo_in(person))
            # Ben has no photo: his own row keeps his initials, with no image at all.
            expect(photo_in(page.locator(".people__item").filter(has_text=PEOPLE["ben"][0]))).to_have_count(0)
            self.settle(page)
            shot(page, f"desktop-1440-people-{'dark' if dark else 'light'}")

    def test_03_the_phone_shows_it_too(self) -> None:
        for dark in (False, True):
            page = self.page("ben", phone=True, dark=dark)
            page.goto(f"/projects/{self.ids['project']}")
            message = page.locator("li").filter(has_text=MESSAGE).last
            expect(message).to_be_visible()
            assert_loaded_photo(self, photo_in(message))
            # The phone asks for the rendition sharp at three pixels per point, not the largest one.
            self.assertIn(photo_in(message).evaluate("el => el.currentSrc").rsplit("/", 1)[1], ("128", "256"))
            page.locator("#project-composer").fill("@Ad")
            option = page.get_by_role("listbox", name="Mention").get_by_role("option").filter(has_text=PEOPLE["ada"][0])
            assert_loaded_photo(self, photo_in(option))
            self.settle(page)
            shot(page, f"phone-390-mention-{'dark' if dark else 'light'}")
            page.locator("#project-composer").fill("")
            page.goto("/settings/company")
            assert_loaded_photo(self, photo_in(page.locator(".people__item").filter(has_text=PEOPLE["ada"][0])))
            self.settle(page)
            shot(page, f"phone-390-people-{'dark' if dark else 'light'}")
        # Ada's own phone: the Settings card and its Account page draw her photo, light and dark.
        for dark in (False, True):
            page = self.page("ada", phone=True, dark=dark)
            page.goto("/settings/account")
            assert_loaded_photo(self, photo_in(page.locator(".sset-me")))
            self.photo_row(page).get_by_role("button", name="Change photo").tap()
            page.locator("input[type=file]").set_input_files({"name": "garden.png", "mimeType": "image/png", "buffer": PHOTO})
            expect(self.photo_row(page).locator("[data-photo-preview] img")).to_have_count(2)
            self.settle(page)
            shot(page, f"phone-390-account-{'dark' if dark else 'light'}")

    # ---------------------------------------------------------------- removing

    def test_04_remove_goes_back_to_the_initials(self) -> None:
        page = self.page("ada")
        page.goto("/settings/account")
        row = self.photo_row(page)
        old = photo_in(page.locator(".sset-me")).evaluate("el => el.currentSrc")
        row.get_by_role("button", name="Change photo").click()
        row.get_by_role("button", name="Remove photo").click()
        expect(row.get_by_role("status")).to_contain_text("Photo removed.")
        expect(row).to_contain_text("Your initials")
        expect(photo_in(page.locator(".sset-me"))).to_have_count(0)
        expect(page.locator(".sset-me .ui-avatar")).to_have_text("AK")
        self.assertEqual(page.request.get(old).status, 404, "a removed photo is not served any more")
        other = self.page("ben")
        other.goto(f"/projects/{self.ids['project']}")
        message = other.locator("li").filter(has_text=MESSAGE).last
        expect(message).to_be_visible()
        expect(photo_in(message)).to_have_count(0)
        expect(message.locator(".ui-avatar").first).to_have_text("AK")
        self.settle(page)
        shot(page, "desktop-1440-removed-light")


if __name__ == "__main__":
    unittest.main()
