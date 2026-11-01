"""Captures the product screens the documentation and the README highlights show (#780).

Not a test: scripts/record_demo.sh runs this after record_demo.py, in the same Compose stack, so Ada's workspace
already has the task and the decision of the demo journey. It signs in as Ada Kowalska (the `./flux demo` owner) and
takes real screenshots of the running application with Playwright, in the Prostota look the app ships:

* the first sign-up page, the first project and the join page (docs/operations/install.md, administration.md),
* Settings > People on a 1440 px computer and a 390 px phone, light and dark, and creating an invite link
  (docs/operations/administration.md),
* one small image per README highlight (docs/assets/readme/highlight-*.webp).

Every image is written as a WebP into $FLUX_UI_SCREENSHOTS/docs, cropped to the part the text is about so it stays
readable when a page shows it at half size. Pillow does the cropping and the encoding (it is installed by hash for
the recording run, as for record_demo.py).

Input (environment): FLUX_UI_ORIGIN, FLUX_UI_UPSTREAM, FLUX_DEMO_OWNER_PASSWORD, FLUX_UI_SCREENSHOTS.
"""

from __future__ import annotations

import io
import re
import sys
import uuid

from PIL import Image
from playwright.sync_api import APIRequestContext, Browser, BrowserContext, Page, expect, sync_playwright

from record_demo import EMAIL, PASSWORD, PARTNER, SHOTS, WORKSPACE, api, project_id, sign_in
from test_app_shell import ORIGIN, UPSTREAM, start_forwarder

OUT = SHOTS / "docs"
DESKTOP = {"width": 1440, "height": 900}
PHONE = {"width": 390, "height": 844}
# Two more people so the People list shows the four roles, and an encrypted space for its highlight.
EXTRA = (("Basia Wrona", "basia@demo.flux.test", "admin"), ("Tomasz Lis", "tomasz@demo.flux.test", "guest"))
EXTRA_PASSWORD = f"{PASSWORD}-colleague"
ENCRYPTED = {"name": "Garden club", "password": "seven loud geese in a hat"}
ASK = "Ada, can you check the gateway range at the far beds before Thursday?"


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
    options: dict = {"base_url": ORIGIN, "color_scheme": scheme, "locale": "en-GB", "timezone_id": "Europe/Warsaw", "service_workers": "block"}
    if phone:
        options.update(viewport=PHONE, device_scale_factor=2, is_mobile=True, has_touch=True)
    else:
        options.update(viewport=size or DESKTOP, device_scale_factor=1)
    if signed:
        options["storage_state"] = SIGNED_IN["ada"]
    return browser.new_context(**options)


def settle(page: Page, ms: int = 900) -> None:
    """Lets fonts and the view's motion finish before the picture is taken."""
    page.evaluate("document.fonts.ready.then(() => true)")
    page.wait_for_timeout(ms)


def shoot(page: Page, name: str, clip: dict | None = None, *, width: int | None = None) -> None:
    """Takes the page (or `clip`, in CSS px) and saves it, scaled to `width` px when one is given."""
    settle(page)
    image = Image.open(io.BytesIO(page.screenshot(type="png", clip=clip))).convert("RGB")
    if width and width != image.width:
        image = image.resize((width, round(image.height * width / image.width)), Image.Resampling.LANCZOS)
    save(image, name)


def box(locator, *, pad: int = 0) -> dict:
    """The element's rectangle in CSS px, grown by `pad` on every side."""
    found = locator.bounding_box()
    assert found, "the element is on screen"
    x0, y0 = found["x"] - pad, found["y"] - pad
    x1, y1 = found["x"] + found["width"] + pad, found["y"] + found["height"] + pad
    return {"x": max(0, x0), "y": max(0, y0), "width": x1 - max(0, x0), "height": y1 - max(0, y0)}


def setup(browser: Browser, request: APIRequestContext) -> dict:
    """Adds the two more people the People list shows, through the public API; returns the ids."""
    ws = next(item for item in api(request, "GET", "/api/v1/workspaces") if item["name"] == WORKSPACE)
    for name, email, role in EXTRA:
        stranger = browser.new_context(base_url=ORIGIN)
        stranger.request.post(f"{ORIGIN}/api/auth/sign-up/email", data={"name": name, "email": email, "password": EXTRA_PASSWORD}, headers={"origin": ORIGIN})
        stranger.close()
        added = request.fetch(f"{ORIGIN}/api/v1/workspaces/{ws['id']}/members", method="POST", data={"email": email, "role": role}, headers={"origin": ORIGIN})
        if added.status not in (201, 409):
            sys.exit(f"record_docs_media: adding {email} answered {added.status}: {added.text()}")
    return {"workspace": ws["id"], "project": project_id(request)}


def encrypted_space(request: APIRequestContext) -> str:
    """Makes the encrypted space for its highlight, last, because from then on it is in everybody's sidebar and Home."""
    made = request.fetch(f"{ORIGIN}/api/v1/encrypted-workspaces", method="POST", headers={"origin": ORIGIN},
                         data={"name": ENCRYPTED["name"], "creationId": str(uuid.uuid4()), "password": ENCRYPTED["password"]})
    if made.status != 201:
        sys.exit(f"record_docs_media: creating the encrypted space answered {made.status}: {made.text()} (does the stack have FLUX_KEYRING_TOKEN and FLUX_KEY_PIN_SECRET?)")
    return made.json()["workspace"]["id"]


def sign_up_page(browser: Browser) -> None:
    for scheme in ("light", "dark"):
        window = context(browser, scheme, signed=False, size={"width": 720, "height": 700})
        page = window.new_page()
        page.goto("/sign-up")
        expect(page.get_by_role("button", name="Create account")).to_be_visible()
        shoot(page, f"signup-{scheme}")
        window.close()


def new_project(browser: Browser) -> None:
    window = context(browser)
    page = window.new_page()
    page.goto("/projects/new")
    name = page.get_by_label("Project name")
    expect(name).to_be_visible()
    name.fill("Seed library")
    shoot(page, "first-project", {"x": 484, "y": 96, "width": 712, "height": 470})
    window.close()


def people(browser: Browser, ids: dict) -> None:
    """Settings > People: the list with the four roles and the AI row, on a computer and a phone, light and dark."""
    for scheme in ("light", "dark"):
        window = context(browser, scheme, size={"width": 1440, "height": 1500})
        page = window.new_page()
        page.goto(f"/settings/people/{ids['workspace']}")
        listed = page.get_by_text(re.compile(r"^In Riverside Makers \(demo\) · 4"))
        expect(listed).to_be_visible()
        ai = page.get_by_role("region", name=re.compile("^AI in Riverside Makers"))
        expect(ai).to_be_visible()
        top = box(listed)["y"] - 24
        bottom = box(ai)["y"] + box(ai)["height"] + 16
        shoot(page, f"people-computer-{scheme}", {"x": 496, "y": top, "width": 680, "height": bottom - top})
        window.close()
        window = context(browser, scheme, phone=True)
        page = window.new_page()
        page.goto(f"/settings/people/{ids['workspace']}")
        listed = page.get_by_text(re.compile(r"^In Riverside Makers \(demo\) · 4"))
        listed.evaluate("el => { el.style.scrollMarginTop = '88px'; el.scrollIntoView({ block: 'start' }); }")
        shoot(page, f"people-phone-{scheme}")
        window.close()


def invite(browser: Browser, ids: dict) -> str:
    """Creates an invite link in People and returns it; saves the form with the link, then the page it opens."""
    window = context(browser, size={"width": 1440, "height": 1500})
    page = window.new_page()
    page.goto(f"/settings/people/{ids['workspace']}")
    heading = page.get_by_role("heading", name="Invite with a link")
    expect(heading).to_be_visible()
    page.get_by_role("button", name="Create invite link").click()
    field = page.locator("#people-invite-link")
    expect(field).to_be_visible()
    link = field.input_value()
    # The page selects the link so it can be copied once it has appeared; the picture shows the link, not a highlight.
    page.wait_for_timeout(800)
    page.mouse.click(1330, 400)
    field.evaluate("el => { el.setSelectionRange(0, 0); el.blur(); }")
    top = box(heading)["y"] - 24
    shoot(page, "invite-link", {"x": 496, "y": top, "width": 680, "height": box(field)["y"] + box(field)["height"] + 120 - top})
    window.close()
    visitor = context(browser, signed=False, size={"width": 720, "height": 520})
    join = visitor.new_page()
    join.goto(f"/join#{link.split('#', 1)[1]}")
    expect(join.get_by_role("button", name="Create an account")).to_be_visible()
    shoot(join, "join-page")
    visitor.close()
    return link


def highlights(browser: Browser, ids: dict, request: APIRequestContext) -> None:
    """One image per README highlight, light, cropped to what the sentence is about."""
    # 1. A task made from a message: the Create window opens with the message as its source.
    window = context(browser)
    page = window.new_page()
    page.goto(f"/projects/{ids['project']}")
    page.get_by_role("button", name=re.compile(r"^\d+ replies")).first.click()
    message = page.locator(".project-convo__message").filter(has_text="Ada, the school can lend us two ESP32 kits").first
    message.hover()
    message.get_by_role("button", name="Create task").click()
    dialog = page.get_by_role("dialog", name="New task")
    expect(dialog).to_be_visible()
    dialog.get_by_role("textbox").first.press("End")
    shoot(page, "highlight-task", box(dialog, pad=70))
    window.close()

    # 2. Come back and catch up: Ada has been away; Jonas has asked her something new since.
    window = context(browser)
    page = window.new_page()
    page.goto("/")
    expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(1500)
    # Basia, the space's admin, asks her while she is away: Home then has news and a next step for her.
    colleague = browser.new_context(base_url=ORIGIN)
    sign_in(colleague.request, EXTRA[0][1], EXTRA_PASSWORD)
    conversation = api(colleague.request, "GET", f"/api/v1/projects/{ids['project']}/conversations")["items"][0]
    api(colleague.request, "POST", f"/api/v1/conversations/{conversation['id']}/messages", {"body": ASK, "clientMessageId": str(uuid.uuid4())})
    colleague.close()
    page.goto("/")
    catch_up = page.get_by_role("link", name=re.compile("^Continue where you left off"))
    expect(catch_up).to_be_visible()
    cards = box(catch_up)
    shoot(page, "highlight-home", {"x": 400, "y": 30, "width": 880, "height": cards["y"] + cards["height"] + 20 - 30})
    window.close()

    # 3. Your own agent, with your permission: Settings > Agents and AI > connect.
    window = context(browser, size={"width": 1440, "height": 1300})
    page = window.new_page()
    page.goto("/settings/agents/connect")
    heading = page.get_by_role("heading", name="Connect your MCP client")
    expect(heading).to_be_visible()
    code = page.locator("pre, code").filter(has_text="claude mcp add").first
    expect(code).to_be_visible()
    top = box(heading)["y"] - 36
    shoot(page, "highlight-agent", {"x": 496, "y": top, "width": 672, "height": box(code)["y"] + box(code)["height"] + 8 - top})
    window.close()

    # 4. One project, three views: the map (the shared sketch) with the project's views above it.
    window = context(browser)
    page = window.new_page()
    page.goto(f"/projects/{ids['project']}")
    page.get_by_role("navigation", name="Project views").get_by_role("link", name=re.compile("^Map")).click()
    sketch = page.get_by_role("link", name=re.compile("^Where the sensors go"))
    if sketch.count():
        sketch.first.click()
    expect(page.get_by_text("Six sensors for twelve beds").first).to_be_visible()
    shoot(page, "highlight-map", {"x": 248, "y": 8, "width": 660, "height": 470})
    window.close()

    # 5. Everywhere you are: the Inbox and the notification settings (with push) on a phone, side by side.
    window = context(browser, phone=True)
    page = window.new_page()
    page.goto("/inbox")
    expect(page.get_by_text("asked you in Community garden sensors").first).to_be_visible()
    settle(page)
    inbox = Image.open(io.BytesIO(page.screenshot(type="png"))).convert("RGB")
    page.goto("/settings/notifications")
    kinds = page.get_by_text("Push and email for each kind")
    expect(kinds).to_be_visible()
    kinds.evaluate("el => { el.style.scrollMarginTop = '24px'; el.scrollIntoView({ block: 'start' }); }")
    settle(page)
    notify = Image.open(io.BytesIO(page.screenshot(type="png"))).convert("RGB")
    window.close()
    gap = 40
    sheet = Image.new("RGB", (inbox.width + gap + notify.width, inbox.height), (244, 244, 245))
    sheet.paste(inbox, (0, 0))
    sheet.paste(notify, (inbox.width + gap, 0))
    sheet = sheet.crop((0, 0, sheet.width, 1120))
    save(sheet.resize((sheet.width * 3 // 4, sheet.height * 3 // 4), Image.Resampling.LANCZOS), "highlight-phone")

    # 6. An encrypted space: the Encryption section of its People.
    window = context(browser, size={"width": 1440, "height": 1500})
    page = window.new_page()
    page.goto(f"/settings/people/{encrypted_space(request)}")
    section = page.get_by_role("region", name="Encryption")
    expect(section).to_be_visible()
    section.scroll_into_view_if_needed()
    area = box(section)
    ai = box(page.get_by_role("region", name=f"AI in {ENCRYPTED['name']}"))
    shoot(page, "highlight-encrypted", {"x": 496, "y": area["y"] - 24, "width": 680, "height": ai["y"] + ai["height"] + 16 - area["y"] + 24})
    window.close()


def main() -> None:
    if not PASSWORD or not PARTNER[1]:
        sys.exit("record_docs_media: FLUX_DEMO_OWNER_PASSWORD and FLUX_DEMO_PARTNER_PASSWORD are required")
    if UPSTREAM:
        start_forwarder(ORIGIN, UPSTREAM)
    expect.set_options(timeout=10000)
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        admin = browser.new_context(base_url=ORIGIN)
        sign_in(admin.request, EMAIL, PASSWORD)
        SIGNED_IN["ada"] = admin.storage_state()
        ids = setup(browser, admin.request)
        sign_up_page(browser)
        new_project(browser)
        people(browser, ids)
        invite(browser, ids)
        highlights(browser, ids, admin.request)
        browser.close()


if __name__ == "__main__":
    main()
