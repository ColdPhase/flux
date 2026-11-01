"""Records the screen shots of the launch video from the running application (#307, L-3).

Not a test: scripts/record_video.sh seeds the `./flux demo` data (scripts/flux-demo.mjs), then runs this
file in the pinned Playwright container. It records the shots of docs/product/launch-video.md that need no
person at a keyboard, in real time, with Playwright's own video recorder:

- shot 1, the opening card (Kreska and one line);
- shots 2 to 4, one take: Ada comes back after a break, a message becomes a task, a decision is proposed
  with its reason and accepted. The caption changes at each shot, so the take also works muted;
- shot 8, the closing card with the three commands and the version.

Shots 5 to 7 (Claude Code, the consent screen and the hand-off) need a person's own model account and
terminal. They stay with the person who records; the launch-video document says how.

Every frame is the real application on the fictional demo data. The only additions are a drawn pointer and
a caption bar, both in the page, so the recording needs no editing to be readable. Captions come in English
and Polish (FLUX_VIDEO_LANG=en|pl). FLUX_VIDEO_VERSION names the release on the closing card; the
recording of a release is made from the release (see the document).

Input (environment): FLUX_UI_ORIGIN, FLUX_UI_UPSTREAM, FLUX_DEMO_OWNER_PASSWORD,
FLUX_DEMO_PARTNER_PASSWORD, FLUX_UI_SCREENSHOTS (the output directory, mounted from the host), FLUX_VIDEO_LANG,
FLUX_VIDEO_VERSION and FLUX_VIDEO_CAPTIONS (on, the default, or off). Output: shot-1-open.webm, shots-2-4-journey.webm, shot-8-close.webm and
timings.json in <FLUX_UI_SCREENSHOTS>/video-<lang>/.
"""

from __future__ import annotations

import html
import json
import os
import re
import sys
import time
from pathlib import Path

from playwright.sync_api import BrowserContext, Locator, Page, TimeoutError as PlaywrightTimeoutError, expect, sync_playwright

from record_demo import CREATE_TASK, EMAIL, PARTNER, PASSWORD, VIEWPORT, jonas_replies, sign_in
from test_app_shell import ORIGIN, UPSTREAM, start_forwarder

LANG = os.environ.get("FLUX_VIDEO_LANG", "en")
VERSION = os.environ.get("FLUX_VIDEO_VERSION", "pre-release")
# FLUX_VIDEO_CAPTIONS=off leaves the caption bar out of the take (the cards keep their text), for a cut that
# carries the captions as a subtitle track (docs/assets/video/captions.<lang>.srt).
CAPTIONS_ON = os.environ.get("FLUX_VIDEO_CAPTIONS", "on") != "off"
OUT = Path(os.environ.get("FLUX_UI_SCREENSHOTS", "/screenshots")) / f"video-{LANG}"
BRAND = Path(os.environ.get("FLUX_BRAND_DIR", "/brand"))
REPO = "https://github.com/ColdPhase/flux.git"

# The captions of docs/product/launch-video.md, in the order of its shot list.
CAPTIONS = {
    "en": {
        1: "Flux: people and AI agents, one project.",
        2: "You come back after a break. Flux shows what changed.",
        3: "A message becomes a task, in one action.",
        4: "Decisions keep their reason, and a person accepts them.",
        8: "Open source, AGPL-3.0. Version {version}",
    },
    "pl": {
        1: "Flux: ludzie i agenci AI w jednym projekcie.",
        2: "Wracasz po przerwie. Flux pokazuje, co się zmieniło.",
        3: "Z wiadomości powstaje zadanie, jednym ruchem.",
        4: "Decyzja zachowuje swój powód, a przyjmuje ją człowiek.",
        8: "Otwarty kod, AGPL-3.0. Wersja {version}",
    },
}

# The pointer is drawn in the page and glides to each target before Playwright acts on it, the way record_demo.py
# draws it; the real mouse only jumps, so nothing on the way can close a menu or hide a hover action. The caption
# bar uses the surface, line, shadow and text tokens of the final design (soft volume, no accent colour).
OVERLAY = """
(() => {
  const add = () => {
    if (document.getElementById('demo-pointer')) return;
    const style = document.createElement('style');
    style.textContent = '#demo-caption{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);max-width:880px;'
      + 'padding:12px 22px;border-radius:16px;background:#fff;color:#18181b;font:500 20px/1.35 Geist,-apple-system,"Segoe UI",Roboto,sans-serif;'
      + 'box-shadow:0 1px 2px rgba(0,0,0,.06),0 12px 30px -10px rgba(0,0,0,.22),inset 0 0 0 1px rgba(0,0,0,.06);'
      + 'z-index:2147483646;pointer-events:none;text-align:center;opacity:0;transition:opacity .25s}'
      + '#demo-caption.on{opacity:1}';
    document.documentElement.appendChild(style);
    const caption = document.createElement('div');
    caption.id = 'demo-caption';
    caption.setAttribute('aria-hidden', 'true');
    document.documentElement.appendChild(caption);
    window.__fluxCaption = (text) => {
      caption.classList.remove('on');
      setTimeout(() => { caption.textContent = text; caption.classList.toggle('on', !!text); }, 260);
    };
    const el = document.createElement('div');
    el.id = 'demo-pointer';
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText = 'position:fixed;left:-60px;top:-60px;width:22px;height:22px;z-index:2147483647;pointer-events:none;'
      + 'transition:left .5s cubic-bezier(.45,0,.25,1),top .5s cubic-bezier(.45,0,.25,1);';
    el.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2 L3 18 L7.5 13.8 L10.6 20.5 L13.4 19.2 L10.4 12.6 L16.5 12.6 Z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(el);
    window.__fluxPointer = (x, y) => { el.style.left = (x - 3) + 'px'; el.style.top = (y - 2) + 'px'; };
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add); else add();
})()
"""


def kreska() -> str:
    return (BRAND / "kreska-light.svg").read_text(encoding="utf-8")


def card(body: str) -> str:
    """A plain card in the design's colours: the screen background, centred content, the app's type stack."""
    return f"""<!doctype html><html lang="{LANG}"><meta charset="utf-8"><title>Flux</title>
<style>
  html, body {{ margin: 0; height: 100%; background: #f4f4f5; color: #18181b;
    font: 400 20px/1.4 Geist, -apple-system, "Segoe UI", Roboto, sans-serif; }}
  main {{ height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 26px; text-align: center; padding: 0 48px; box-sizing: border-box; }}
  svg {{ width: 96px; height: 96px; filter: drop-shadow(0 6px 14px rgba(0,0,0,.18)); }}
  h1 {{ margin: 0; font-size: 34px; line-height: 1.25; font-weight: 600; letter-spacing: -.01em; }}
  pre {{ margin: 0; padding: 22px 30px; border-radius: 18px; background: #fff; text-align: left; font: 500 22px/1.7 "Geist Mono", ui-monospace, Menlo, Consolas, monospace;
    box-shadow: 0 1px 2px rgba(0,0,0,.05), 0 6px 16px -6px rgba(0,0,0,.12), inset 0 0 0 1px rgba(0,0,0,.05); }}
  p {{ margin: 0; font-size: 24px; color: #4a4a4a; }}
  /* Chromium sends a video frame only when something repaints, so a still card would be a one-second clip.
     Four pixels in the corner change by one level of grey twice a second: nobody sees it, the recorder keeps going. */
  body::after {{ content: ""; position: fixed; right: 0; bottom: 0; width: 2px; height: 2px; background: #f4f4f5; animation: tick 1s steps(1) infinite; }}
  @keyframes tick {{ 50% {{ background: #f3f3f4; }} }}
</style><main>{body}</main></html>"""


def opening_card() -> str:
    return card(f"{kreska()}<h1>{html.escape(CAPTIONS[LANG][1])}</h1>")


def closing_card() -> str:
    commands = f"git clone --depth 1 {REPO}\n./flux up\n./flux demo"
    return card(f"{kreska()}<pre>{html.escape(commands)}</pre><p>{html.escape(CAPTIONS[LANG][8].format(version=VERSION))}</p>")


class Take:
    """One recorded page: moves a visible pointer, changes the caption and notes when each shot starts."""

    def __init__(self, context: BrowserContext, name: str) -> None:
        self.name = name
        self.page: Page = context.new_page()
        self.started = time.monotonic()
        self.marks: dict[str, float] = {}
        self.x, self.y = 640.0, 740.0

    def at(self) -> float:
        return round(time.monotonic() - self.started, 1)

    def caption(self, shot: int) -> None:
        self.marks[f"shot {shot}"] = self.at()
        if not CAPTIONS_ON:
            return
        self.page.evaluate("(text) => window.__fluxCaption && window.__fluxCaption(text)", CAPTIONS[LANG][shot].format(version=VERSION))

    def wait(self, seconds: float) -> None:
        self.page.wait_for_timeout(int(seconds * 1000))

    def settle(self, seconds: float) -> None:
        self.page.evaluate("document.fonts.ready.then(() => true)")
        self.wait(seconds)

    def place(self, x: float, y: float) -> None:
        self.page.evaluate("([x, y]) => window.__fluxPointer && window.__fluxPointer(x, y)", [x, y])

    def move_to(self, target: Locator) -> None:
        """Glides the drawn pointer to the middle of the target."""
        target.scroll_into_view_if_needed()
        box = target.bounding_box()
        assert box, "the target is on screen"
        self.x, self.y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
        self.place(self.x, self.y)
        self.wait(0.55)

    def hover(self, target: Locator) -> None:
        """Glides the pointer to the target and hovers it, so what shows on hover (message actions) appears."""
        self.move_to(target)
        try:
            target.hover(timeout=8000)
        except PlaywrightTimeoutError:
            # Leave what the browser showed next to the clips: a hover that fails is almost always something on top.
            self.page.screenshot(path=str(OUT / "hover-failed.png"))
            raise
        self.wait(0.35)

    def click(self, target: Locator) -> None:
        self.hover(target)
        target.click()

    def type(self, field: Locator, text: str) -> None:
        self.click(field)
        field.fill("")
        field.press_sequentially(text, delay=24)

    def finish(self, destination: Path) -> float:
        seconds = self.at()
        video = self.page.video
        self.page.close()
        video.save_as(str(destination))
        return seconds


def journey(take: Take) -> None:
    page = take.page
    # Shot 2: the return view. Jonas wrote after Ada's last visit, so Home has news for her.
    page.goto("/")
    since = page.get_by_role("link", name=re.compile("^Continue where you left off"))
    expect(since).to_be_visible()
    take.place(take.x, take.y)
    take.caption(2)
    take.settle(3.2)
    take.click(since)
    messages = page.locator(".project-convo__message")
    expect(messages.filter(has_text="Moisture first")).to_be_visible()
    take.settle(2.4)

    # Shot 3: a task, made from Jonas's message in one action.
    take.caption(3)
    order = messages.filter(has_text="Then let us order six")
    if not order.count():
        take.click(page.get_by_role("button", name=re.compile(r"^\d+ replies")).first)
    expect(order).to_be_visible()
    take.hover(order)
    take.click(order.get_by_role("button", name=CREATE_TASK))
    window = page.get_by_role("dialog", name="New task")
    expect(window).to_be_visible()
    take.settle(1.6)
    take.click(window.get_by_role("button", name=re.compile("^Create task")))
    panel = page.locator("#details")
    expect(panel.get_by_role("button", name="Status", exact=True)).to_contain_text("Open")
    take.settle(2.6)
    take.click(panel.get_by_role("button", name="Thread"))

    # Shot 4: a decision with its reason, proposed from a message and accepted by a person.
    take.caption(4)
    moisture = messages.filter(has_text="Moisture first")
    expect(moisture).to_be_visible()
    take.hover(moisture)
    take.click(moisture.get_by_role("button", name="More actions"))
    take.click(page.get_by_role("menuitem", name="Propose a decision"))
    expect(panel.get_by_role("heading", name="Propose a decision")).to_be_visible()
    take.type(panel.get_by_label("Decision"), "Measure soil moisture first; frost warnings later")
    take.type(panel.get_by_label("Why"), "Volunteers overwater the raised beds; frost is a spring problem")
    take.click(panel.get_by_role("button", name="Propose decision"))
    expect(panel.get_by_role("button", name="Accept decision")).to_be_visible()
    take.settle(1.0)
    take.click(panel.get_by_role("button", name="Accept decision"))
    expect(panel.locator(".wd-eyebrow")).to_contain_text("Decision · accepted")
    take.settle(1.6)
    take.click(panel.get_by_role("button", name="Thread"))
    take.move_to(moisture.get_by_role("button", name=re.compile("^Decision: Measure soil moisture first")).first)
    take.settle(3.2)
    if CAPTIONS_ON:
        page.evaluate("window.__fluxCaption && window.__fluxCaption('')")
    take.settle(0.5)


def main() -> None:
    if not PASSWORD or not PARTNER[1]:
        sys.exit("record_video: FLUX_DEMO_OWNER_PASSWORD and FLUX_DEMO_PARTNER_PASSWORD are required")
    if LANG not in CAPTIONS:
        sys.exit(f"record_video: FLUX_VIDEO_LANG must be one of {', '.join(CAPTIONS)}")
    if UPSTREAM:
        start_forwarder(ORIGIN, UPSTREAM)
    expect.set_options(timeout=8000)
    OUT.mkdir(parents=True, exist_ok=True)
    try:
        record(timings_base={"lang": LANG, "version": VERSION, "viewport": VIEWPORT})
    finally:
        # The container runs as root; the host user must be able to remove what it wrote.
        for folder in (OUT / "raw", OUT):
            if folder.exists():
                folder.chmod(0o777)


def record(timings_base: dict[str, object]) -> None:
    timings: dict[str, object] = {**timings_base, "clips": {}}
    options = {"base_url": ORIGIN, "viewport": VIEWPORT, "device_scale_factor": 1, "color_scheme": "light", "locale": "en-GB", "timezone_id": "Europe/Warsaw"}
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        # Ada's first visit (not recorded) sets where she left off; Jonas replies after it, so Home has news.
        setup = browser.new_context(**options)
        sign_in(setup.request, EMAIL, PASSWORD)
        page = setup.new_page()
        page.goto("/")
        expect(page.get_by_role("heading", level=1, name="Home")).to_be_visible()
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(1500)
        partner = browser.new_context(base_url=ORIGIN)
        sign_in(partner.request, *PARTNER)
        jonas_replies(partner.request)
        partner.close()
        state = setup.storage_state()
        setup.close()

        recorded = browser.new_context(**options, storage_state=state, record_video_dir=str(OUT / "raw"), record_video_size=VIEWPORT)
        recorded.add_init_script(OVERLAY)

        opening = Take(recorded, "open")
        opening.page.set_content(opening_card())
        opening.settle(5.0)
        timings["clips"]["shot-1-open"] = opening.finish(OUT / "shot-1-open.webm")

        take = Take(recorded, "journey")
        journey(take)
        timings["clips"]["shots-2-4-journey"] = {"seconds": take.finish(OUT / "shots-2-4-journey.webm"), "starts": take.marks}

        closing = Take(recorded, "close")
        closing.page.set_content(closing_card())
        closing.settle(7.0)
        timings["clips"]["shot-8-close"] = closing.finish(OUT / "shot-8-close.webm")
        recorded.close()
        browser.close()
    for raw in (OUT / "raw").glob("*"):
        raw.unlink()
    (OUT / "raw").rmdir()
    (OUT / "timings.json").write_text(json.dumps(timings, indent=2) + "\n", encoding="utf-8")
    for clip in sorted(OUT.glob("*.webm")):
        print(f"record_video: {clip.name} {clip.stat().st_size / 1024:.0f} KiB")
    print(json.dumps(timings["clips"]))


if __name__ == "__main__":
    main()
