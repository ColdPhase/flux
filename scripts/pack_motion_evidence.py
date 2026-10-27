#!/usr/bin/env python3
"""Cuts the #593 review recordings down to small animated WebP (docs/agents/evaluation.md, "Evidence size").

    python3 scripts/pack_motion_evidence.py <recordings dir> <output dir>

`<recordings dir>` holds what `app/tests/ui/motion_evidence.py` (`test_clips_for_the_review`) wrote for each engine and
scheme: `<engine>-<scheme>-<clip>.webm` and `.marks.json` (a mark may ask for a frame rate, `fps`). The marks say when the motion starts and which part of the page
it happens in; this keeps that part, a little before and after, at a lower frame rate. It needs `ffmpeg` and `img2webp`
(libwebp) on the host and tries a ladder of frame rates and qualities until a clip is under the limit.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

LIMIT = 280 * 1024  # the docs size guard allows 300 KB per recording
LADDER = ((12, 50), (12, 40), (10, 40), (10, 30), (8, 30), (8, 20))


def crop(marks: dict) -> tuple[int, int, int, int]:
    width, height = marks["viewport"]["width"], marks["viewport"]["height"]
    x, y, w, h = marks["marks"][0]["box"]
    x0, y0 = max(0, int(x)), max(0, int(y))
    x1, y1 = min(width, int(x + w)), min(height, int(y + h))
    return x0, y0, (x1 - x0) // 2 * 2, (y1 - y0) // 2 * 2


def pack(video: Path, out: Path) -> int:
    marks = json.loads(video.with_suffix(".marks.json").read_text())
    mark = marks["marks"][0]
    x, y, w, h = crop(marks)
    start = max(0.0, mark["at"] - mark["before"])
    first = int(mark.get("fps") or 0)
    # A clip that asks for a higher frame rate (a slide that has to be seen) starts there and comes down only as far as the size limit needs.
    ladder = ((first, 45), (first, 35), (20, 40), (15, 35), *LADDER) if first > 12 else LADDER
    for fps, quality in ladder:
        with tempfile.TemporaryDirectory() as scratch:
            vf = f"crop={w}:{h}:{x}:{y},scale=trunc(iw*{mark['scale']}/2)*2:-2,fps={fps}"
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{start:.3f}", "-t", f"{mark['before'] + mark['after']:.3f}", "-i", str(video), "-vf", vf, f"{scratch}/f%03d.png"], check=True)
            frames = sorted(Path(scratch).glob("f*.png"))
            subprocess.run(["img2webp", "-lossy", "-q", str(quality), "-d", str(round(1000 / fps)), "-loop", "0", *map(str, frames), "-o", str(out)], check=True, capture_output=True)
        if out.stat().st_size <= LIMIT:
            return out.stat().st_size
    raise SystemExit(f"{out.name}: still {out.stat().st_size} bytes after the whole ladder")


def main() -> None:
    source, target = Path(sys.argv[1]), Path(sys.argv[2])
    if not shutil.which("ffmpeg") or not shutil.which("img2webp"):
        raise SystemExit("needs ffmpeg and img2webp")
    target.mkdir(parents=True, exist_ok=True)
    for video in sorted(source.glob("*.webm")):
        if video.with_suffix(".marks.json").exists():
            print(f"{video.stem}.webp  {pack(video, target / f'{video.stem}.webp') // 1024} KB")


if __name__ == "__main__":
    main()
