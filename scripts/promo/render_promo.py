"""Render the promo SVG to frames: the animated WebP fallback, a contact sheet, and an <img> check (#780).

  render_promo.py webp  <svg> <out.webp> [fps]        frame-exact capture (Web Animations currentTime) -> WebP
  render_promo.py sheet <svg> <out.png> <t1,t2,...>   frames at those seconds, side by side, for review
  render_promo.py img   <page.html> <out-dir> <browser> [width]
                                                      real-time capture of a page that shows the SVG as <img>
                                                      (the README as GitHub renders it): proves it animates there
Runs in Docker (scripts/make_promo.sh) on the Playwright image.
"""
from __future__ import annotations

import io
import sys
import time
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

LOOP = 12.0


def frames_at(svg: Path, times: list[float], scale: float = 1.0) -> list[Image.Image]:
    out = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 800, "height": 450}, device_scale_factor=scale)
        page.goto(svg.resolve().as_uri())
        page.wait_for_timeout(300)
        for t in times:
            # Seek every animation, then let two frames paint so composited layers catch up.
            page.evaluate("t => new Promise(done => { document.getAnimations().forEach(a => { a.pause();"
                          " a.currentTime = t; }); requestAnimationFrame(() => requestAnimationFrame(done)); })",
                          t * 1000)
            out.append(Image.open(io.BytesIO(page.screenshot(omit_background=False))).convert("RGB"))
        browser.close()
    return out


def webp(svg: Path, dest: Path, fps: int) -> None:
    n = int(LOOP * fps)
    shots = frames_at(svg, [i / fps for i in range(n)])
    frames: list[Image.Image] = []
    durations: list[int] = []
    for im in shots:  # a held frame is stored once, with a longer duration
        if frames and im.tobytes() == frames[-1].tobytes():
            durations[-1] += round(1000 / fps)
        else:
            frames.append(im)
            durations.append(round(1000 / fps))
    frames[0].save(dest, save_all=True, append_images=frames[1:], duration=durations, loop=0,
                   quality=int(__import__("os").environ.get("Q", "55")), method=6, minimize_size=True, allow_mixed=True)
    print(f"{dest}: {n} frames ({len(frames)} distinct) at {fps} fps, {dest.stat().st_size} bytes")


def sheet(svg: Path, dest: Path, times: list[float]) -> None:
    frames = frames_at(svg, times)
    cols = 2
    rows = (len(frames) + cols - 1) // cols
    canvas = Image.new("RGB", (800 * cols, 450 * rows), "white")
    for i, im in enumerate(frames):
        canvas.paste(im, ((i % cols) * 800, (i // cols) * 450))
    canvas.save(dest)
    print(f"{dest}: {len(frames)} frames")


def img_check(page_html: Path, out: Path, engine: str, width: int) -> None:
    out.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = getattr(p, engine).launch()
        for scheme in ("light", "dark"):
            page = browser.new_page(viewport={"width": width, "height": 900}, color_scheme=scheme)
            page.goto(page_html.resolve().as_uri())
            hero = page.locator("img[src*='flux-promo']").first
            hero.wait_for()
            src = hero.evaluate("e => e.currentSrc")
            start = time.monotonic()
            shots = []
            for i in range(6):
                target = start + i * 1.7
                time.sleep(max(0, target - time.monotonic()))
                name = out / f"{engine}-{scheme}-{width}-{i}.png"
                hero.screenshot(path=str(name))
                shots.append(name.read_bytes())
            distinct = len(set(shots))
            print(f"{engine} {scheme} {width}px: src={src.rsplit('/', 1)[-1]} distinct frames {distinct}/6")
            page.close()
        browser.close()


def main(argv: list[str]) -> int:
    mode = argv[1]
    if mode == "webp":
        webp(Path(argv[2]), Path(argv[3]), int(argv[4]) if len(argv) > 4 else 12)
    elif mode == "sheet":
        sheet(Path(argv[2]), Path(argv[3]), [float(t) for t in argv[4].split(",")])
    elif mode == "img":
        img_check(Path(argv[2]), Path(argv[3]), argv[4], int(argv[5]) if len(argv) > 5 else 1012)
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
