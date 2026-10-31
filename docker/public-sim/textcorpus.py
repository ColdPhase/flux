"""The known code text of the 1440p text profile (#63 AC-2). Used on a simulated presenter's computer to fill a
terminal (static: the first lines; scroll: lines at a fixed rate) and by the driver as the truth for OCR scoring.

Usage on the client: python3 textcorpus.py static | python3 textcorpus.py scroll LINES_PER_SECOND
Every line starts with its five-digit number, so a recognized line is matched to its source without alignment.
"""
from __future__ import annotations

import random
import sys
import time

WORDS = ["config", "session", "media", "track", "frame", "buffer", "encoder", "receiver", "anchor", "presence",
         "layer", "packet", "window", "stage", "result", "decision", "project", "member", "grant", "token"]
TYPES = ["string", "number", "boolean", "Uint8Array", "MediaStream", "Promise<void>", "Record<string, Track>"]


def line(n: int) -> str:
    """Line n: deterministic, code-like, about 140 to 200 characters (two statements, so the text spans most of a
    2560 px wide terminal), with identifiers, numbers and punctuation."""
    r = random.Random(n)
    return f"{n:05d}  {' ' * (2 * r.randint(0, 3))}{statement(r)}  {statement(r)}"


def statement(r: random.Random) -> str:
    a, b, c = r.sample(WORDS, 3)
    kind = r.randint(0, 3)
    if kind == 0:
        body = f"const {a}_{b} = await {c}.open({{ id: '{r.randrange(16**6):06x}', limit: {r.randint(1, 4096)} }});"
    elif kind == 1:
        body = f"if ({a}.{b} >= {r.randint(2, 999)} && !{c}Ready) return {{ ok: false, code: '{b.upper()}_{r.randint(10, 99)}' }};"
    elif kind == 2:
        body = f"function {a}{b.capitalize()}({c}: {r.choice(TYPES)}, retries = {r.randint(1, 9)}): {r.choice(TYPES)} {{"
    else:
        body = f"// {a} -> {b}: keep {r.randint(10, 90)} ms between {c} updates (see #{r.randint(100, 999)})"
    return body


def main() -> None:
    mode = sys.argv[1]
    if mode == "static":
        # One screen of text; the terminal keeps it still.
        print("\n".join(line(n) for n in range(0, 80)), end="", flush=True)
        while True:
            time.sleep(3600)
    rate = float(sys.argv[2])
    n, start = 0, time.monotonic()
    while True:
        print(line(n), flush=True)
        n += 1
        delay = start + n / rate - time.monotonic()
        if delay > 0:
            time.sleep(delay)


if __name__ == "__main__":
    main()
