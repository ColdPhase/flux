"""Records the README demo GIF and the README stills from the running application (v0.2).

Not a test: scripts/record_demo.sh seeds the `./flux demo` data (scripts/flux-demo.mjs), then runs this file in the pinned
Playwright container, against the TEST-ONLY provider mock (nothing here calls a model). It first makes the scene the media show
(media_scene.py: the company, Ada's agents, a day of conversation, tasks, decisions, the Map and the Wiki), then Ada Kowalska walks the
v0.2 journey in one real browser: what waits for her on Home, the question that opens the space's conversation, `/ai` asked there and the
answer shared with Show everyone ("via Assistant"), a task made from that message, the Tasks board, the Map and the Wiki. Every frame is a
Playwright screenshot of the real app; only a pointer is drawn on top so the viewer can follow the clicks. The frames become one looping GIF
with Pillow.

After the journey it also takes the two stills at the top of the README, each in the light and the dark theme, as lossless WebP
(conversation-desktop.webp, conversation-desktop-dark.webp, conversation-phone.webp and conversation-phone-dark.webp): the space's conversation with
Ada's private Assistant answer and the accepted decision open beside it on a computer, and the same conversation on a phone.

Input (environment): FLUX_UI_ORIGIN, FLUX_UI_UPSTREAM, FLUX_DEMO_OWNER_PASSWORD, FLUX_DEMO_PARTNER_PASSWORD, FLUX_FIXTURE_TOKEN,
FLUX_ANTHROPIC_MOCK_URL and FLUX_UI_SCREENSHOTS (the output directory, mounted from the host).
"""

from __future__ import annotations

import io
import re
import sys
import uuid
from pathlib import Path

from PIL import Image, ImageChops
from playwright.sync_api import APIRequestContext, Browser, Locator, Page, expect, sync_playwright

import media_scene
from media_common import EMAIL, PARTNER, PASSWORD, SHOTS, call, mock, project_id, sign_in, start_recording_forwarder
from test_app_shell import ORIGIN

VIEWPORT = {"width": 1280, "height": 800}
OUT = SHOTS / "flux-demo.gif"
NEWS = "Ada, the school can lend us two ESP32 kits. Shall I pick them up on Thursday?"
CREATE_TASK = re.compile("^Create task$")
ASK = "What did we settle on for the first sensors, and why?"
# The mock fills {first} and {message} with the labels of the sources it was sent, which the card shows as numbered citations.
ANSWER = ("We settled on soil moisture first {first}. Jonas pointed out that the volunteers keep overwatering the raised beds, and that frost is only "
          "a spring problem {message}. Two more sensors may be borrowed from the school; the far beds still need a LoRa range test.")
TASK_TITLE = "Test LoRa range at the far beds"
# The still's second question stays unshared: the card shows what only Ada sees, with its sources and Show everyone.
ASK_AGAIN = "What is still open for the far beds?"
ANSWER_AGAIN = ("Three things are open for the far beds {first}. The second antenna is not tried yet, the school has not confirmed the two ESP32 kits "
                "{message}, and the far east bed still drops to one bar when the hedge is wet.")

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
        steps = 4
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




def jonas_replies(request: APIRequestContext) -> None:
    """Jonas asks in the space's conversation while Ada is away, through the public API."""
    conversation = call(request, "GET", f"/api/v1/projects/{project_id(request)}/conversations")["items"][0]
    call(request, "POST", f"/api/v1/conversations/{conversation['id']}/messages", {"body": NEWS, "clientMessageId": str(uuid.uuid4())})


def journey(page: Page, rec: Recorder) -> None:
    messages = page.locator(".project-convo__message")
    # 1. Home: what waits for Ada.
    page.goto("/")
    question = page.get_by_text("Basia Wrona asked you in Rain barrel monitor")
    expect(question).to_be_visible()
    rec.hold(3000)

    # 2. The space's conversation, where Basia and Jonas asked.
    rec.click(page.get_by_role("link", name=re.compile("^Community garden sensors")).first)
    expect(messages.filter(has_text="volunteer rota").first).to_be_visible()
    rec.hold(2200)

    # 3. `/ai` asks Ada's Assistant, which answers only to her; Show everyone posts the answer as hers, "via Assistant".
    mock("/__script", {"reset": True, "text": ANSWER, "output_tokens": 180})
    composer = page.locator("#project-composer")
    rec.type(composer, f"/ai {ASK}")
    rec.click(page.get_by_role("button", name="Send to your assistant"))
    expect(page.locator(".assistant-working")).to_be_visible()
    rec.hold(1400)
    card = page.locator(".assistant-private").last
    expect(card).to_be_visible(timeout=60000)
    rec.hold(3600)
    rec.click(card.get_by_role("button", name="Show everyone"))
    shared = messages.filter(has_text="We settled on soil moisture first").last
    expect(shared).to_be_visible()
    rec.hold(2000)

    # 4. A task from that message, in one action. The Create window is not drawn in the GIF: a dimmed screen costs as many bytes as a whole
    # new view, and the GIF has to stay within its allowlisted size.
    shared.hover()
    rec.click(shared.get_by_role("button", name=CREATE_TASK))
    window = page.get_by_role("dialog", name="New task")
    expect(window).to_be_visible()
    window.get_by_placeholder(re.compile("^What needs doing")).fill(TASK_TITLE)
    window.get_by_role("button", name=re.compile("^Create task")).click()
    expect(window).to_have_count(0)
    expect(shared.get_by_text(TASK_TITLE)).to_be_visible()
    rec.hold(2400)
    # The new task opened in the panel beside the conversation: Esc closes it, and the toast leaves before the next view is drawn.
    page.keyboard.press("Escape")
    expect(page.locator(".ui-toast")).to_have_count(0, timeout=20000)

    # 5. The Tasks board has it, with the others.
    tabs = page.get_by_role("navigation", name="Space views")
    rec.click(tabs.get_by_role("tab", name=re.compile("^Tasks")))
    expect(page.get_by_role("button", name=TASK_TITLE, exact=True).first).to_be_visible()
    rec.hold(2800)

    # 6. The Map: the thoughts the conversation led to.
    rec.click(tabs.get_by_role("tab", name=re.compile("^Map")))
    listed = page.get_by_role("link", name=re.compile("^Where the sensors go"))
    rec.hold(700)
    if listed.count():
        rec.click(listed.first)
    expect(page.get_by_text("Gateway on the shed roof").first).to_be_visible()
    # The last thought made is selected; a click on the empty canvas puts the selection away before the picture is held.
    page.mouse.click(700, 640)
    rec.hold(3000)

    # 7. The Wiki, where the space writes down what it knows.
    rec.click(tabs.get_by_role("tab", name=re.compile("^Wiki")))
    expect(page.get_by_role("heading", level=1).first).to_be_visible()
    rec.hold(2400)


def ask_again(browser: Browser, project: str) -> None:
    """Ada asks the Assistant once more in the space and leaves the answer where only she sees it: its card, with Show everyone, is part of the
    desktop still."""
    mock("/__script", {"reset": True, "text": ANSWER_AGAIN, "output_tokens": 160})
    context = browser.new_context(base_url=ORIGIN, ignore_https_errors=True, viewport={"width": 1440, "height": 900}, locale="en-GB", timezone_id="Europe/Warsaw", service_workers="block")
    sign_in(context.request, EMAIL, PASSWORD)
    page = context.new_page()
    page.goto(f"/projects/{project}")
    composer = page.locator("#project-composer")
    composer.click()
    composer.fill(f"/ai {ASK_AGAIN}")
    page.get_by_role("button", name="Send to your assistant").click()
    expect(page.locator(".assistant-private").last).to_contain_text("Three things are open", timeout=60000)
    context.close()


def readme_stills(browser: Browser, ids: dict) -> None:
    """The stills at the top of the README, after the journey, in the light and the dark theme: the space's conversation with Ada's private
    answer from her Assistant, on a 1440 px computer with the accepted decision beside it, and on a 390 px phone."""
    ask_again(browser, ids["project"])
    for name, options in (
        ("conversation-desktop", {"viewport": {"width": 1440, "height": 900}, "device_scale_factor": 1}),
        ("conversation-phone", {"viewport": {"width": 390, "height": 844}, "device_scale_factor": 3, "is_mobile": True, "has_touch": True}),
    ):
        for scheme in ("light", "dark"):
            context = browser.new_context(base_url=ORIGIN, ignore_https_errors=True, color_scheme=scheme, locale="en-GB", timezone_id="Europe/Warsaw", service_workers="block", **options)
            sign_in(context.request, EMAIL, PASSWORD)
            page = context.new_page()
            page.goto(f"/projects/{ids['project']}")
            expect(page.locator(".assistant-private").last).to_contain_text("Three things are open")
            if name == "conversation-desktop":
                page.get_by_role("button", name=re.compile("^Open decision Measure soil moisture first")).first.click()
                expect(page.locator("#details")).to_contain_text("Measure soil moisture first")
                # The pointer rests in the panel's empty part, so no message shows its hover actions.
                page.mouse.move(1210, 780)
            page.evaluate("document.fonts.ready.then(() => true)")
            page.wait_for_timeout(1000)
            image = Image.open(io.BytesIO(page.screenshot(type="png"))).convert("RGB")
            # Lossless WebP is less than half the size of the PNG for these flat greys, and keeps the text crisp.
            image.save(SHOTS / f"{name}{'-dark' if scheme == 'dark' else ''}.webp", "WEBP", lossless=True, quality=100, method=6)
            context.close()


def drop_transition_frames(images: list[Image.Image], durations: list[int]) -> tuple[list[Image.Image], list[int]]:
    """Merges a short pointer frame into the one before it when much of the screen changed between them.

    The interface now dissolves between views (#722), so a pointer step taken during a dissolve is a
    half-faded screen. It costs the most bytes in the GIF and shows nothing the next frame does not, so its
    time goes to the frame before it. The file stays within its allowlisted size.
    """
    kept: list[Image.Image] = []
    times: list[int] = []
    for image, ms in zip(images, durations):
        box = ImageChops.difference(image, kept[-1]).getbbox() if kept else None
        if box and ms <= 60 and (box[2] - box[0]) * (box[3] - box[1]) > 250_000:
            times[-1] += ms
            continue
        kept.append(image)
        times.append(ms)
    return kept, times


# The README's demo GIF may not exceed this (scripts/docs-size-allowlist.txt, checked by scripts/check_agent_setup.py).
GIF_LIMIT = 476206
# Prostota's text ink, card white, page grey and side grey (docs/design/final/README.md §2, light theme), and two mid greys for the Map's minimap
# and hairlines. They are kept in the palette whatever the median cut does, so the text stays black, the cards white and every grey neutral in a
# palette this small (without the mid greys the median cut turned the minimap brown).
ANCHORS = ((24, 24, 27), (255, 255, 255), (244, 244, 245), (235, 235, 237), (128, 128, 130), (190, 190, 192))


def write_gif(frames: list[tuple[bytes, int]], path: Path) -> None:
    images, durations = drop_transition_frames([Image.open(io.BytesIO(png)).convert("RGB") for png, _ in frames], [ms for _, ms in frames])
    # One palette for every frame, so colours do not flicker and unchanged areas stay identical.
    sample = images[:: max(1, len(images) // 8)]
    width, height = images[0].size
    sheet = Image.new("RGB", (width, height * len(sample)))
    for index, image in enumerate(sample):
        sheet.paste(image, (0, height * index))
    path.parent.mkdir(parents=True, exist_ok=True)
    # The interface is greys and one accent, so a small palette reads the same as a large one. Take the largest that
    # keeps the file within its allowlisted size: how many bytes the dissolves between views cost varies from run to run.
    for colors in (32, 28, 24, 20):
        rest = sheet.quantize(colors=colors - len(ANCHORS), method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
        palette = Image.new("P", (1, 1))
        palette.putpalette([channel for color in ANCHORS for channel in color] + rest.getpalette()[: 3 * (colors - len(ANCHORS))])
        indexed = [image.quantize(palette=palette, dither=Image.Dither.NONE) for image in images]
        indexed[0].save(path, save_all=True, append_images=indexed[1:], duration=durations, loop=0, optimize=True, disposal=1)
        if path.stat().st_size <= GIF_LIMIT:
            print(f"record_demo: GIF with {colors} colours, {path.stat().st_size} bytes (limit {GIF_LIMIT})")
            return
    sys.exit(f"record_demo: the GIF is {path.stat().st_size} bytes with 20 colours, above its {GIF_LIMIT}; drop a scene from the journey")


def main() -> None:
    if not PASSWORD or not PARTNER[1]:
        sys.exit("record_demo: FLUX_DEMO_OWNER_PASSWORD and FLUX_DEMO_PARTNER_PASSWORD are required")
    start_recording_forwarder()
    expect.set_options(timeout=10000)
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        context = browser.new_context(base_url=ORIGIN, ignore_https_errors=True, viewport=VIEWPORT, device_scale_factor=1, color_scheme="light", locale="en-GB", timezone_id="Europe/Warsaw", service_workers="block")
        page = context.new_page()
        sign_in(page.request, EMAIL, PASSWORD)
        ids = media_scene.build(browser, context)
        rec = Recorder(page)
        journey(page, rec)
        readme_stills(browser, ids)
        browser.close()
    write_gif(rec.frames, OUT)
    seconds = sum(ms for _, ms in rec.frames) / 1000
    print(f"record_demo: {len(rec.frames)} frames, {seconds:.1f} s, {OUT.stat().st_size / 1024:.0f} KiB -> {OUT.name}")


if __name__ == "__main__":
    main()
