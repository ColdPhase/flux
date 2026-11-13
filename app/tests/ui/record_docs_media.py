"""Captures the product screens the documentation and the README highlights show (v0.2).

Not a test: scripts/record_demo.sh runs this after record_demo.py, in the same Compose stack, so Ada's company already has the scene of
media_scene.py and the journey's task and shared answer. The script has then switched the API and worker to the real connection path (no
provider mock), so Settings names the connection of Ada's key and not the test one. It signs in as Ada Kowalska (the `./flux demo` owner)
and takes real screenshots of the running application with Playwright, in the Prostota look the app ships:

* the sign-up page and the New space window (docs/operations/install.md),
* Settings › Company on a 1440 px computer and a 390 px phone, light and dark, creating an invite link, and the page the link opens
  (docs/operations/administration.md),
* Settings › AI, the Connect your MCP client page (administration.md),
* one image per README highlight (docs/assets/screens/highlight-*.webp).

Every image is written as a WebP into $FLUX_UI_SCREENSHOTS/docs, cropped to the part the text is about so it stays readable when a page shows
it at half size. Pillow does the cropping and the encoding (it is installed by hash for the recording run, as for record_demo.py).

Input (environment): FLUX_UI_ORIGIN, FLUX_UI_UPSTREAM, FLUX_DEMO_OWNER_PASSWORD and FLUX_UI_SCREENSHOTS.
"""

from __future__ import annotations

import io
import re
import sys

from PIL import Image
from playwright.sync_api import Browser, BrowserContext, Locator, Page, expect, sync_playwright

from media_common import EMAIL, PASSWORD, PROJECT, SHOTS, call, company_id, project_id, sign_in, start_recording_forwarder
from test_app_shell import ORIGIN

OUT = SHOTS / "docs"
DESKTOP = {"width": 1440, "height": 900}
PHONE = {"width": 390, "height": 844}


def save(image: Image.Image, name: str) -> None:
    """Writes the image as a WebP: lossless, which keeps the interface's text crisp and is small for flat greys."""
    OUT.mkdir(parents=True, exist_ok=True)
    # The directory is mounted from the host and this runs as root: let the host's script remove it again.
    OUT.chmod(0o777)
    path = OUT / f"{name}.webp"
    image.save(path, "WEBP", lossless=True, quality=100, method=6)
    print(f"record_docs_media: {path.name} {image.width}x{image.height} {path.stat().st_size / 1024:.0f} KiB")


# Ada's signed-in state, taken once in main(): every window below starts from it instead of signing in again.
SIGNED_IN: dict = {}


def context(browser: Browser, scheme: str = "light", *, phone: bool = False, signed: bool = True, size: dict | None = None) -> BrowserContext:
    options: dict = {"base_url": ORIGIN, "ignore_https_errors": True, "color_scheme": scheme, "locale": "en-GB", "timezone_id": "Europe/Warsaw", "service_workers": "block"}
    if phone:
        options.update(viewport=PHONE, device_scale_factor=2, is_mobile=True, has_touch=True)
    else:
        options.update(viewport=size or DESKTOP, device_scale_factor=1)
    if signed:
        options["storage_state"] = SIGNED_IN["ada"]
    return browser.new_context(**options)


def settle(page: Page, ms: int = 1200) -> None:
    """Lets fonts and the view's motion finish before the picture is taken."""
    page.evaluate("document.fonts.ready.then(() => true)")
    page.wait_for_timeout(ms)


def grab(page: Page, clip: dict | None = None) -> Image.Image:
    settle(page)
    return Image.open(io.BytesIO(page.screenshot(type="png", clip=clip))).convert("RGB")


def shoot(page: Page, name: str, clip: dict | None = None) -> None:
    """Takes the page (or `clip`, in CSS px) and saves it."""
    save(grab(page, clip), name)


def box(locator: Locator, *, pad: int = 0) -> dict:
    """The element's rectangle in CSS px, grown by `pad` on every side."""
    found = locator.bounding_box()
    assert found, "the element is on screen"
    x0, y0 = found["x"] - pad, found["y"] - pad
    x1, y1 = found["x"] + found["width"] + pad, found["y"] + found["height"] + pad
    return {"x": max(0, x0), "y": max(0, y0), "width": x1 - max(0, x0), "height": y1 - max(0, y0)}


def rect(x: int, y: int, width: int, height: int) -> dict:
    return {"x": x, "y": y, "width": width, "height": height}


def sign_up_page(browser: Browser) -> None:
    """The first page of a new instance, light and dark (install.md, step 4)."""
    for scheme in ("light", "dark"):
        window = context(browser, scheme, signed=False, size={"width": 720, "height": 700})
        page = window.new_page()
        page.goto("/sign-up")
        expect(page.get_by_role("button", name="Create account")).to_be_visible()
        # The name field has the focus when the page opens; the picture shows the page at rest.
        page.locator("body").click(position={"x": 20, "y": 20})
        shoot(page, f"signup-{scheme}")
        window.close()


def first_space(browser: Browser) -> None:
    """New › Space: one name, the people and the AI switch that starts on (install.md, step 4)."""
    window = context(browser)
    page = window.new_page()
    # Over Tool library, a space nothing was said in, so the margin round the window is plain backdrop.
    page.goto("/")
    page.get_by_role("link", name=re.compile("^Tool library")).first.click()
    expect(page.get_by_role("navigation", name="Space views")).to_be_visible()
    page.get_by_role("button", name=re.compile("^New")).first.click()  # the one Create window, on its Task tab; Space is its last tab
    page.get_by_role("tab", name="Space", exact=True).click()
    dialog = page.get_by_role("dialog", name="New space")
    expect(dialog).to_be_visible()
    name = dialog.get_by_role("textbox").first
    name.fill(PROJECT)
    name.evaluate("el => el.blur()")
    shoot(page, "first-space", box(dialog))
    window.close()


def people(browser: Browser) -> None:
    """Settings › Company: the four roles and the guests line, on a computer and a phone, light and dark (administration.md)."""
    for scheme in ("light", "dark"):
        window = context(browser, scheme, size={"width": 1440, "height": 1000})
        page = window.new_page()
        page.goto("/settings/company")
        listed = page.get_by_role("heading", name=re.compile("^People"))
        expect(listed).to_be_visible()
        guests = page.get_by_text(re.compile("^Guests: ")).first
        expect(guests).to_be_visible()
        top = box(listed)["y"] - 14
        bottom = box(guests)["y"] + box(guests)["height"] + 18
        shoot(page, f"people-computer-{scheme}", rect(486, int(top), 680, int(bottom - top)))
        window.close()
        window = context(browser, scheme, phone=True)
        page = window.new_page()
        page.goto("/settings/company")
        expect(page.get_by_role("heading", name=re.compile("^People"))).to_be_visible()
        shoot(page, f"people-phone-{scheme}")
        window.close()


def invite(browser: Browser) -> None:
    """Creates an invite link in Settings › Company, saves the form with the link, then the page the link opens (administration.md)."""
    window = context(browser, size={"width": 1440, "height": 1300})
    page = window.new_page()
    page.goto("/settings/company?invite=1")
    heading = page.get_by_role("heading", name="Invite people")
    expect(heading).to_be_visible()
    page.get_by_role("button", name="Create invite link").click()
    field = page.locator("#people-invite-link")
    expect(field).to_be_visible()
    link = field.input_value()
    # The page selects the link so it can be copied once it has appeared; the picture shows the link, not a highlight.
    page.wait_for_timeout(800)
    field.evaluate("el => { el.setSelectionRange(0, 0); el.blur(); }")
    page.mouse.click(1330, 400)
    done = page.get_by_text(re.compile("^Invite link created"))
    expect(done).to_be_visible()
    top = box(heading)["y"] - 20
    shoot(page, "invite-link", rect(486, int(top), 680, int(box(done)["y"] + box(done)["height"] + 16 - top)))
    window.close()
    visitor = context(browser, signed=False, size={"width": 720, "height": 560})
    join = visitor.new_page()
    join.goto(f"/join#{link.split('#', 1)[1]}")
    expect(join.get_by_role("button", name="Create account and join")).to_be_visible()
    shoot(join, "join-page")
    visitor.close()


def agents(browser: Browser) -> None:
    """Settings › AI: Connect AI, the agents and the agent app, and the page that connects a local client (administration.md, README)."""
    window = context(browser, size={"width": 1440, "height": 900})
    page = window.new_page()
    page.goto("/settings/agents")
    expect(page.get_by_role("heading", name="Your agents")).to_be_visible()
    expect(page.get_by_text("Sonnet 5").first).to_be_visible()
    shoot(page, "highlight-agent", rect(500, 84, 664, 772))
    window.close()


def highlights(browser: Browser, ids: dict) -> None:
    """One image per README highlight, cropped to what the sentence is about."""
    project = ids["project"]

    # 1. Tasks: the board, with every state and every kind of owner.
    window = context(browser, size={"width": 1200, "height": 560})
    page = window.new_page()
    page.goto(f"/projects/{project}/tasks")
    expect(page.get_by_role("region", name="Done", exact=True)).to_be_visible()
    expect(page.get_by_text("Draft the volunteer watering rota").first).to_be_visible()
    shoot(page, "highlight-task", rect(240, 0, 960, 560))
    window.close()

    # 2. Home: what waits for Ada, and where she left off.
    window = context(browser)
    page = window.new_page()
    page.goto("/")
    expect(page.get_by_text("Continue where you left off")).to_be_visible()
    shoot(page, "highlight-home", rect(396, 30, 888, 470))
    window.close()

    # 3. The Map: the space's thoughts, linked.
    window = context(browser)
    page = window.new_page()
    page.goto(f"/projects/{project}/map")
    page.get_by_role("link", name=re.compile("^Where the sensors go")).click()
    expect(page.get_by_text("Gateway on the shed roof").first).to_be_visible()
    page.mouse.click(700, 640)  # the last thought made is selected; the picture shows the Map at rest
    shoot(page, "highlight-map", rect(256, 8, 760, 500))
    window.close()

    # 4. The Wiki: a page of the space, edited where it is read.
    window = context(browser)
    page = window.new_page()
    page.goto(f"/projects/{project}/docs/{ids['wiki']}")
    expect(page.get_by_text("Capacitive soil moisture probe").first).to_be_visible()
    shoot(page, "highlight-wiki", rect(456, 84, 760, 560))
    window.close()

    # 5. The phone: the space's conversation with its marks, and the "+" that makes anything.
    window = context(browser, phone=True)
    page = window.new_page()
    page.goto(f"/projects/{project}")
    expect(page.locator("[data-shown-answer]", has_text="Ada's Assistant").first).to_be_visible()
    conversation = grab(page)
    page.goto("/")
    expect(page.get_by_text("Continue where you left off")).to_be_visible()
    page.get_by_role("button", name="Create", exact=True).click()
    expect(page.get_by_role("dialog", name="New task")).to_be_visible()
    sheet = grab(page)
    window.close()
    gap = 40
    both = Image.new("RGB", (conversation.width + gap + sheet.width, conversation.height), (244, 244, 245))
    both.paste(conversation, (0, 0))
    both.paste(sheet, (conversation.width + gap, 0))
    save(both.resize((both.width * 3 // 4, both.height * 3 // 4), Image.Resampling.LANCZOS), "highlight-phone")


def main() -> None:
    if not PASSWORD:
        sys.exit("record_docs_media: FLUX_DEMO_OWNER_PASSWORD is required")
    start_recording_forwarder()
    expect.set_options(timeout=15000)
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        admin = browser.new_context(base_url=ORIGIN, ignore_https_errors=True)
        sign_in(admin.request, EMAIL, PASSWORD)
        SIGNED_IN["ada"] = admin.storage_state()
        pid = project_id(admin.request)
        pages = call(admin.request, "GET", f"/api/v1/projects/{pid}/docs")["items"]
        ids = {"project": pid, "company": company_id(admin.request), "wiki": next(item for item in pages if item["title"] == "How the garden sensors work")["id"]}
        sign_up_page(browser)
        first_space(browser)
        people(browser)
        invite(browser)
        agents(browser)
        highlights(browser, ids)
        browser.close()


if __name__ == "__main__":
    main()
