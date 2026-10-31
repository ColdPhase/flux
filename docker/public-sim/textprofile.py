"""The 1440p code/text profile of the simulated public host (#63 AC-2, first target). Imported by driver.py.

Ada's computer (behind the restrictive router, TURN/TLS) shows a terminal over its whole 2560x1440 X display:
the known code text of textcorpus.py in Liberation Mono at 14 px (10.5 pt, 96 dpi). She shares it through the app's
button in Sharp text (the default mode). Each receiver opens her screen at 1:1. Then:

  static  the terminal holds one screen of text. At each receiver the decoded frame (the <video> drawn to a canvas at
          its natural size) is compared with a grab of Ada's display at the same time: SSIM over the text area, and
          OCR (tesseract) of both, scored line by line against the known text;
  scroll  the terminal prints 20 lines a second (a fast `tail -f` or build log). getStats gives the received frame
          rate, size and freezes over 15 s; five decoded frames per receiver are OCR-scored against the known text,
          with five source grabs as the reference.

With four people Mia shares a second (1920x1080, moving) screen at the same time and Tom watches Ada's text too.
Thresholds (THRESHOLDS) and their rationale are in docs/development/live-media.md, "1440p code/text profile".
"""
from __future__ import annotations

import base64
import difflib
import io
import re
import subprocess
import time

import numpy as np
from PIL import Image, ImageOps
from playwright.sync_api import Page, expect

import profiles
import textcorpus

# Set on 2026-10-31 from the calibration runs txt3 and txt4 (eight receiver measurements, two and four people), before
# the enforced run; the rationale for each value is in docs/development/live-media.md, "1440p code/text profile".
THRESHOLDS = {
    # Static text at 1:1, the decoded frame 20 s after the share started, against the source pixels.
    "static": {"minWidth": 2560, "minSsim": 0.95, "maxOcrDrop": 0.02, "minLineShare": 0.95},
    # Scrolling text at 20 lines a second: frame rate, size, freezes and loss over 15 s at each receiver, and OCR of five
    # decoded frames (the median against the sources' worst, and a floor for the worst single frame).
    "scroll": {"minWidth": 2560, "minFps": 13.5, "maxFreezeS": 2.0, "maxLossPct": 1.0, "maxMedianOcrDrop": 0.07,
               "minWorstOcr": 0.70, "minMedianLineShare": 0.80},
}

FRAME = """
() => {
  const v = document.querySelector('.lv-stage__video');
  if (!v || !v.videoWidth) return null;
  const c = document.createElement('canvas');
  c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext('2d').drawImage(v, 0, 0);
  return c.toDataURL('image/png');
}
"""
STATIC_SAMPLES = (5, 10, 20)
LINE = re.compile(r"(\d{5})\s+(.*)")
# OCR reads a crop of the terminal: 40 lines, full text width (up to about 200 characters, 1700 px).
CROP = (0, 0, 1760, 700)


def gray(image: Image.Image) -> np.ndarray:
    return np.asarray(image.convert("L"), dtype=np.float64)


def ssim(a: np.ndarray, b: np.ndarray, window: int = 8) -> float:
    """Mean SSIM over non-overlapping window x window blocks (luma, 8-bit range)."""
    h, w = (min(a.shape[0], b.shape[0]) // window) * window, (min(a.shape[1], b.shape[1]) // window) * window
    a, b = a[:h, :w], b[:h, :w]
    shape = (h // window, window, w // window, window)
    ab, bb = a.reshape(shape), b.reshape(shape)
    ma, mb = ab.mean(axis=(1, 3)), bb.mean(axis=(1, 3))
    va, vb = ab.var(axis=(1, 3)), bb.var(axis=(1, 3))
    cov = ((ab - ma[:, None, :, None]) * (bb - mb[:, None, :, None])).mean(axis=(1, 3))
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    return float((((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma ** 2 + mb ** 2 + c1) * (va + vb + c2))).mean())


def text_box(source: np.ndarray) -> tuple[int, int, int, int]:
    """The area of the source that holds text (pixels clearly brighter than the dark background), with a margin."""
    rows, cols = np.where(source > 90)
    if not len(rows):
        return 0, 0, int(source.shape[1]), int(source.shape[0])
    return (int(max(0, cols.min() - 8)), int(max(0, rows.min() - 8)), int(min(source.shape[1], cols.max() + 8)),
            int(min(source.shape[0], rows.max() + 8)))


def ocr(image: Image.Image) -> dict:
    """Tesseract on the crop (inverted to dark text on light, doubled), scored line by line against the corpus."""
    crop = ImageOps.invert(image.crop(CROP).convert("L"))
    crop = crop.resize((crop.width * 2, crop.height * 2), Image.LANCZOS)
    buffer = io.BytesIO()
    crop.save(buffer, format="PNG")
    text = subprocess.run(["tesseract", "stdin", "stdout", "--psm", "6"], input=buffer.getvalue(),
                          capture_output=True, timeout=120).stdout.decode(errors="replace")
    scores = []
    for raw in text.splitlines():
        match = LINE.search(raw.strip())
        if not match or len(raw.strip()) < 20:
            continue
        number = int(match.group(1))
        truth = textcorpus.line(number)
        scores.append(difflib.SequenceMatcher(None, raw.strip()[match.start():], truth).ratio())
    good = [s for s in scores if s >= 0.95]
    return {"lines": len(scores), "meanRatio": round(sum(scores) / len(scores), 4) if scores else 0.0,
            "goodLines": len(good)}


def decoded(page: Page, path: str) -> Image.Image | None:
    data = page.evaluate(FRAME)
    if not data:
        return None
    image = Image.open(io.BytesIO(base64.b64decode(data.split(",", 1)[1]))).convert("RGB")
    image.save(path)
    return image


def run(phases: set, pages: dict[str, Page], result: dict, ctl, log, run_name: str, calibrate: bool) -> None:
    four = "four" in phases
    ada, jonas = pages["ada"], pages["jonas"]
    gate = profiles.Gate(calibrate)
    out: dict = {"people": 4 if four else 2, "thresholds": THRESHOLDS, "font": "Liberation Mono 10.5 pt at 96 dpi (14 px)",
                 "display": "2560x1440", "steps": {}}
    result["phases"]["text"] = out

    def step(name: str, who: dict[str, Page], seconds: float = 15) -> dict:
        ctl(f"mark {run_name} text-{name} begin")
        report = profiles.measure(who, seconds)
        ctl(f"mark {run_name} text-{name} end")
        out["steps"][name] = report
        log("text-profile", step=name, report=report)
        return report

    ctl("screen a text static")
    out["shareButton"] = profiles.share_screen(ada)
    shared_at = time.time()
    mode = profiles.bar(ada).get_by_role("radiogroup", name="How your screen is sent").get_by_role("radio", name="Sharp text")
    expect(mode).to_have_attribute("aria-checked", "true")
    viewers = {"jonas": jonas}
    if four:
        ctl("screen c on testsrc=size=1920x1080:rate=30")
        out["miaShare"] = profiles.share_screen(pages["mia"])
        viewers["tom"] = pages["tom"]
    for who, page in viewers.items():
        profiles.open_stage(page, re.compile("(’s screen|screens)$"), "Ada’s screen" if four else None)
        page.wait_for_function("(() => { const v = document.querySelector('.lv-stage__video'); return v && v.videoWidth > 0; })()",
                               timeout=30_000)
        profiles.stage(page).get_by_role("button", name="1:1").click()

    # Static text: decoded frames against the source grab at every receiver, 5, 10 and 20 s after Ada started sharing
    # (the encoder starts low and sharpens a still picture over time: "time to a clear frame", #59 §7). The gate is on
    # the 20 s frame; the earlier ones are recorded.
    t = THRESHOLDS["static"]
    ctl(f"screen a grab {run_name}-text-static-source")
    source = Image.open(f"/ctl/{run_name}-text-static-source.png").convert("RGB")
    reference = ocr(source)
    out["staticSourceOcr"] = reference
    box = text_box(gray(source))
    out["textBox"] = box
    out["static"] = {who: {} for who in viewers}
    for after in STATIC_SAMPLES:
        time.sleep(max(0.0, shared_at + after - time.time()))
        for who, page in viewers.items():
            image = decoded(page, f"/ctl/{run_name}-text-static-{who}-{after}s.png")
            if image is None:
                out["static"][who][f"{after}s"] = None
                continue
            a, b = gray(source), gray(image)
            x0, y0, x1, y1 = box
            out["static"][who][f"{after}s"] = {
                "size": f"{image.width}x{image.height}",
                "ssimText": round(ssim(a[y0:y1, x0:x1], b[y0:y1, x0:x1]), 4) if image.size == source.size else None,
                "ocr": ocr(image)}
    for who in viewers:
        row = out["static"][who].get(f"{STATIC_SAMPLES[-1]}s")
        if row is None:
            gate.check(f"static: {who} decodes Ada's text", None, "a frame", False)
            continue
        gate.at_least(f"static: {who} decoded width", int(row["size"].split("x")[0]), t["minWidth"])
        gate.at_least(f"static: {who} SSIM over the text at {STATIC_SAMPLES[-1]} s", row["ssimText"], t["minSsim"])
        gate.at_least(f"static: {who} OCR mean line ratio at {STATIC_SAMPLES[-1]} s vs source - {t['maxOcrDrop']}",
                      row["ocr"]["meanRatio"], round(reference["meanRatio"] - t["maxOcrDrop"], 4))
        gate.at_least(f"static: {who} OCR good lines at {STATIC_SAMPLES[-1]} s vs source x {t['minLineShare']}",
                      row["ocr"]["goodLines"], int(reference["goodLines"] * t["minLineShare"]))
    step("static", {**viewers, "ada": ada}, 8)

    # Scrolling text: 20 lines a second.
    t = THRESHOLDS["scroll"]
    ctl("screen a text scroll 20")
    time.sleep(5)
    report = step("scroll", {**viewers, "ada": ada}, 15)
    out["scrollSent"] = profiles.sent_video(report, "ada")
    out["scrollCaptured"] = report["ada"]["captured"]
    for who in viewers:
        row = profiles.first(profiles.tracks(report, who, "video", "Ada"))
        out.setdefault("scroll", {})[who] = {"received": row}
        if row is None:
            gate.check(f"scroll: {who} receives Ada's text", None, "a decoded track", False)
            continue
        gate.at_least(f"scroll: {who} received width", int(row["size"].split("x")[0]), t["minWidth"])
        gate.at_least(f"scroll: {who} fps", row["fps"], t["minFps"])
        gate.at_most(f"scroll: {who} freeze s", row["freezeS"], t["maxFreezeS"])
        gate.at_most(f"scroll: {who} loss %", row["lossPct"], t["maxLossPct"])
    references, samples = [], {who: [] for who in viewers}
    for i in range(5):
        ctl(f"screen a grab {run_name}-text-scroll-source-{i}")
        references.append(ocr(Image.open(f"/ctl/{run_name}-text-scroll-source-{i}.png").convert("RGB")))
        for who, page in viewers.items():
            image = decoded(page, f"/ctl/{run_name}-text-scroll-{who}-{i}.png")
            samples[who].append(ocr(image) if image else {"lines": 0, "meanRatio": 0.0, "goodLines": 0})
        time.sleep(1)
    out["scrollSourceOcr"] = references
    ref_ratio = min(r["meanRatio"] for r in references)
    ref_good = min(r["goodLines"] for r in references)
    for who in viewers:
        out["scroll"][who]["ocr"] = samples[who]
        ratios = sorted(r["meanRatio"] for r in samples[who])
        good = sorted(r["goodLines"] for r in samples[who])
        gate.at_least(f"scroll: {who} median sampled OCR mean line ratio vs source - {t['maxMedianOcrDrop']}",
                      ratios[len(ratios) // 2], round(ref_ratio - t["maxMedianOcrDrop"], 4))
        gate.at_least(f"scroll: {who} worst sampled OCR mean line ratio", ratios[0], t["minWorstOcr"])
        gate.at_least(f"scroll: {who} median good lines vs source x {t['minMedianLineShare']}", good[len(good) // 2],
                      int(ref_good * t["minMedianLineShare"]))
    for who, page in viewers.items():
        page.screenshot(path=f"/ctl/{run_name}-text-{who}-stage.png")
        profiles.stage(page).get_by_role("button", name="Fit").click()
    ctl("screen a off")
    if four:
        ctl("screen c off")
    out["checks"] = gate.checks
    out["failures"] = gate.failures()
    log("text-results", static=out["static"], staticSourceOcr=out["staticSourceOcr"], scroll=out.get("scroll"),
        scrollSourceOcr=out["scrollSourceOcr"], checks=gate.checks)
    log("text-thresholds", calibrate=calibrate, failures=out["failures"], checked=len(gate.checks))
    if not calibrate:
        assert not out["failures"], out["failures"]
