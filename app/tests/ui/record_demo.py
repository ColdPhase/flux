"""Records the README demo GIF from the running application (#121, AC-5).

Not a test: scripts/record_demo.sh seeds the `./flux demo` data (scripts/flux-demo.mjs), then
runs this file in the pinned Playwright container. Ada Kowalska walks the core journey in one
real browser: the return view with Jonas's new reply, the project conversation, the sketch, a task and
a decision made from messages. Every frame is a Playwright screenshot of the real app; only a pointer is drawn
on top so the viewer can follow the clicks. The frames become one looping GIF with Pillow.

Input (environment): FLUX_UI_ORIGIN, FLUX_UI_UPSTREAM, FLUX_DEMO_OWNER_PASSWORD,
FLUX_DEMO_PARTNER_PASSWORD and FLUX_UI_SCREENSHOTS (the output directory, mounted from the host).
"""

from __future__ import annotations

import io
import os
import re
import sys
import uuid
from pathlib import Path

from PIL import Image
from playwright.sync_api import APIRequestContext, Locator, Page, expect, sync_playwright

from test_app_shell import ORIGIN, UPSTREAM, start_forwarder

VIEWPORT = {"width": 1280, "height": 800}
OUT = Path(os.environ.get("FLUX_UI_SCREENSHOTS", "/screenshots")) / "flux-demo.gif"
EMAIL = "ada@demo.flux.test"
PASSWORD = os.environ.get("FLUX_DEMO_OWNER_PASSWORD", "")
PARTNER = ("jonas@demo.flux.test", os.environ.get("FLUX_DEMO_PARTNER_PASSWORD", ""))
WORKSPACE = "Riverside Makers (demo)"
PROJECT = "Community garden sensors"
NEWS = "Ada, the school can lend us two ESP32 kits. Shall I pick them up on Thursday?"
# Message actions were renamed in the Studio 11.6 flow work (#189); either name works.
CREATE_TASK = re.compile("^(Create work|Task)$")
PROPOSE_DECISION = re.compile("^(Propose decision|Decision)$")

# A classic arrow, drawn above the page and ignored by hit testing and assistive technology.
POINTER = """
(() => {
  if (document.getElementById('demo-pointer')) return;
  const el = document.createElement('div');
  el.id = 'demo-pointer';
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText = 'position:fixed;left:640px;top:400px;width:22px;height:22px;z-index:2147483647;pointer-events:none;';
  el.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2 L3 18 L7.5 13.8 L10.6 20.5 L13.4 19.2 L10.4 12.6 L16.5 12.6 Z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  document.body.appendChild(el);
})()
"""


class Recorder:
    """Collects (PNG, milliseconds) frames from one page and moves the drawn pointer."""

    def __init__(self, page: Page) -> None:
        self.page = page
        self.frames: list[tuple[bytes, int]] = []
        self.x, self.y = 640.0, 400.0

    def snap(self, ms: int) -> None:
        self.page.evaluate(POINTER)
        self.page.evaluate("([x, y]) => { const p = document.getElementById('demo-pointer'); p.style.left = x + 'px'; p.style.top = y + 'px'; }", [self.x, self.y])
        self.frames.append((self.page.screenshot(type="png"), ms))

    def hold(self, ms: int) -> None:
        """Lets fonts and view motion settle, then shows the screen for `ms`."""
        self.page.evaluate("document.fonts.ready.then(() => true)")
        self.page.wait_for_timeout(500)
        self.snap(ms)

    def point(self, target: Locator) -> None:
        target.scroll_into_view_if_needed()
        box = target.bounding_box()
        assert box, "the target is on screen"
        tx, ty = box["x"] + min(box["width"] / 2, 60), box["y"] + box["height"] / 2
        steps = 5
        for step in range(1, steps + 1):
            t = step / steps
            ease = t * t * (3 - 2 * t)
            self.x, self.y = self.x + (tx - self.x) * ease, self.y + (ty - self.y) * ease
            self.snap(60)
        self.x, self.y = tx, ty

    def click(self, target: Locator) -> None:
        self.point(target)
        target.hover()
        self.snap(260)
        target.click()

    def type(self, field: Locator, text: str) -> None:
        self.click(field)
        field.fill("")
        for start in range(0, len(text), 5):
            field.press_sequentially(text[start:start + 5])
            self.snap(70)


def sign_in(request: APIRequestContext, email: str, password: str) -> None:
    response = request.post(f"{ORIGIN}/api/auth/sign-in/email", data={"email": email, "password": password}, headers={"origin": ORIGIN})
    if response.status != 200:
        sys.exit(f"record_demo: sign-in as {email} answered {response.status}; seed the demo first")


def api(request: APIRequestContext, method: str, path: str, body: dict | None = None):
    response = request.fetch(f"{ORIGIN}{path}", method=method, data=body, headers={"origin": ORIGIN})
    if response.status not in (200, 201):
        sys.exit(f"record_demo: {method} {path} answered {response.status}: {response.text()}")
    return response.json()


def jonas_replies(request: APIRequestContext) -> None:
    """Jonas answers in the project conversation while Ada is away, through the public API."""
    workspace = next(ws for ws in api(request, "GET", "/api/v1/workspaces") if ws["name"] == WORKSPACE)
    project = next(item for item in api(request, "GET", f"/api/v1/workspaces/{workspace['id']}/projects")["items"] if item["name"] == PROJECT)
    conversation = api(request, "GET", f"/api/v1/projects/{project['id']}/conversations")["items"][0]
    api(request, "POST", f"/api/v1/conversations/{conversation['id']}/messages", {"body": NEWS, "clientMessageId": str(uuid.uuid4())})


def journey(page: Page, rec: Recorder) -> None:
    # 1. The return view: what changed since Ada left, and one next step.
    page.goto("/")
    since = page.get_by_role("region", name=re.compile("^Since you left"))
    expect(since).to_contain_text("school can lend")
    rec.hold(3000)

    # 2. The project conversation, opened from that change, where Jonas and Ada chose what to measure.
    messages = page.locator(".project-convo__message")
    # Jonas asked Ada something, so it is her next step ("Answer Jonas's question") or an item in the list.
    rec.click(since.get_by_role("link", name=re.compile("Answer Jonas|school can lend")).first)
    expect(messages.filter(has_text="Moisture first")).to_be_visible()
    rec.hold(2600)

    # 3. The shared sketch of where the sensors go.
    tabs = page.get_by_role("navigation", name="Project views")
    rec.click(tabs.get_by_role("link", name=re.compile("^Map")))
    rec.hold(900)
    rec.click(page.get_by_role("link", name=re.compile("^Where the sensors go")).first)
    expect(page.get_by_text("Six sensors for twelve beds").first).to_be_visible()
    rec.hold(2600)

    # 4. A task, made from Jonas's message in one action.
    rec.click(tabs.get_by_role("link", name=re.compile("^Conversation")))
    order = messages.filter(has_text="Then let us order six")
    expect(order).to_be_visible()
    order.hover()
    rec.click(order.get_by_role("button", name=CREATE_TASK))
    panel = page.locator("#details")
    expect(panel.get_by_role("button", name="Status", exact=True)).to_contain_text("Open")
    rec.hold(2400)
    page.keyboard.press("Escape")

    # 5. A decision with its reason, proposed from a message and accepted.
    moisture = messages.filter(has_text="Moisture first")
    moisture.hover()
    rec.click(moisture.get_by_role("button", name=PROPOSE_DECISION))
    expect(panel.get_by_role("heading", name="Propose a decision")).to_be_visible()
    rec.type(panel.get_by_label("Decision"), "Measure soil moisture first; frost warnings later")
    rec.type(panel.get_by_label("Why"), "Volunteers overwater the raised beds; frost is a spring problem")
    rec.click(panel.get_by_role("button", name="Propose decision"))
    expect(panel.get_by_role("button", name="Accept decision")).to_be_visible()
    rec.hold(900)
    rec.click(panel.get_by_role("button", name="Accept decision"))
    expect(page.get_by_label("Current state").first).to_contain_text("Current rule")
    # End on the rule where it was decided: under Jonas's message, linked to it.
    rec.point(moisture.get_by_role("button", name=re.compile("^Decision: Measure soil moisture first")))
    rec.hold(3400)


def write_gif(frames: list[tuple[bytes, int]], path: Path) -> None:
    images = [Image.open(io.BytesIO(png)).convert("RGB") for png, _ in frames]
    # One palette for every frame, so colours do not flicker and unchanged areas stay identical.
    sample = images[:: max(1, len(images) // 8)]
    width, height = images[0].size
    sheet = Image.new("RGB", (width, height * len(sample)))
    for index, image in enumerate(sample):
        sheet.paste(image, (0, height * index))
    palette = sheet.quantize(colors=128, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    indexed = [image.quantize(palette=palette, dither=Image.Dither.NONE) for image in images]
    path.parent.mkdir(parents=True, exist_ok=True)
    indexed[0].save(path, save_all=True, append_images=indexed[1:], duration=[ms for _, ms in frames], loop=0, optimize=True, disposal=1)


def main() -> None:
    if not PASSWORD or not PARTNER[1]:
        sys.exit("record_demo: FLUX_DEMO_OWNER_PASSWORD and FLUX_DEMO_PARTNER_PASSWORD are required")
    if UPSTREAM:
        start_forwarder(ORIGIN, UPSTREAM)
    expect.set_options(timeout=8000)
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        context = browser.new_context(base_url=ORIGIN, viewport=VIEWPORT, device_scale_factor=1, color_scheme="light", locale="en-GB", timezone_id="Europe/Warsaw")
        page = context.new_page()
        sign_in(page.request, EMAIL, PASSWORD)
        # Ada's first visit sets where she left off; Jonas replies after it, so Home has news for her.
        page.goto("/")
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(1500)
        partner = browser.new_context(base_url=ORIGIN)
        sign_in(partner.request, *PARTNER)
        jonas_replies(partner.request)
        partner.close()
        rec = Recorder(page)
        journey(page, rec)
        browser.close()
    write_gif(rec.frames, OUT)
    seconds = sum(ms for _, ms in rec.frames) / 1000
    print(f"record_demo: {len(rec.frames)} frames, {seconds:.1f} s, {OUT.stat().st_size / 1024:.0f} KiB -> {OUT.name}")


if __name__ == "__main__":
    main()
