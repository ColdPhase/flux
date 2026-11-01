"""Build the README promo animation: docs/assets/promo/flux-promo-{light,dark}.svg (#780).

A 12 s seamless loop in the final design Prostota (docs/design/final/README.md): Kreska draws itself, the
"flux" wordmark, Jonas's message, the task made from it, a decision accepted, Kreska picking up the task,
a positive result and the end line. Pure SVG + CSS keyframes: no script, no external font (Geist glyphs are
converted to paths here, shaped by HarfBuzz), so GitHub renders it animated inside <img>. With reduced
motion the CSS stops and the static styles show the end frame.

Run it in Docker through scripts/make_promo.sh; it needs fontTools, uharfbuzz and brotli.
"""
from __future__ import annotations

import io
import sys
from pathlib import Path

import uharfbuzz as hb
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[2]
FONTS = ROOT / "app/apps/web/src/ui/fonts"
OUT = ROOT / "docs/assets/promo"
W, H = 800, 450
T = 12.0  # loop length in seconds

THEMES = {
    "light": dict(bg="#F4F4F5", el="#FFFFFF", sub="#EBEBEC", t1="#18181B", t2="#4A4A4A", t3="#636363",
                  inv="#18181B", oninv="#FFFFFF", line="rgba(0,0,0,.07)", line2="rgba(0,0,0,.14)",
                  sh1=".05", sh2=".12", outline="none"),
    "dark": dict(bg="#111111", el="#1C1C1C", sub="#242424", t1="#F0F0F0", t2="#BDBDBD", t3="#A1A1A1",
                 inv="#F0F0F0", oninv="#111111", line="rgba(255,255,255,.08)", line2="rgba(255,255,255,.16)",
                 sh1=".35", sh2=".55", outline="rgba(255,255,255,.08)"),
}

# Kreska's own paths (app/apps/web/src/ui/Kreska.tsx, guide §3), on a 24-unit grid.
SQUIRCLE = "M8.6 2.6H15.4C19 2.6 21.4 5 21.4 8.6V15.4C21.4 19 19 21.4 15.4 21.4H8.6C5 21.4 2.6 19 2.6 15.4V8.6C2.6 5 5 2.6 8.6 2.6Z"
TILE = "M7 0H17C21.2 0 24 2.8 24 7V17C24 21.2 21.2 24 17 24H7C2.8 24 0 21.2 0 17V7C0 2.8 2.8 0 7 0Z"
FACES = {
    "idle": ("M9.3 11.2V13.8M14.7 11.2V13.8", "M7.3 8.1 10.5 7.2", ""),
    "hello": ("M9.3 11.2V13.8M13.4 12.6H16", "M7.3 7 10.5 5.9",
              "M21.6 4.6C22.6 5.6 23.1 6.8 23.2 8.2M20.4 6C21 6.6 21.3 7.3 21.4 8.1"),
    "working": ("M9.3 12V13.4M14.7 12V13.4", "M7.3 8.7 10.7 8.5", ""),
    "done": ("M7.9 13.3 9.3 11.7 10.7 13.3M13.3 13.3 14.7 11.7 16.1 13.3", "M7.3 8 10.5 7.4", ""),
}


# ---------------------------------------------------------------------------------------------- text
class Face:
    """One Geist instance: HarfBuzz shapes, fontTools draws; each glyph is stored once in <defs>."""

    def __init__(self, file: str, weight: int, key: str):
        self.tt = TTFont(FONTS / file)
        sfnt = io.BytesIO()  # HarfBuzz reads TrueType, not WOFF2
        self.tt.flavor = None
        self.tt.save(sfnt)
        data = sfnt.getvalue()
        self.tt = TTFont(io.BytesIO(data))
        self.glyphs = self.tt.getGlyphSet(location={"wght": weight})
        self.order = self.tt.getGlyphOrder()
        self.upem = self.tt["head"].unitsPerEm
        self.hb = hb.Font(hb.Face(data))
        self.hb.set_variations({"wght": weight})
        self.key = key
        self.used: dict[str, str] = {}

    def shape(self, text: str) -> list[tuple[str, int]]:
        buf = hb.Buffer()
        buf.add_str(text)
        buf.guess_segment_properties()
        hb.shape(self.hb, buf, {"kern": True, "liga": True})
        x, out = 0, []
        for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
            name = self.order[info.codepoint]
            out.append((name, x + pos.x_offset))
            x += pos.x_advance
        out.append(("", x))
        return out

    def ref(self, name: str) -> str:
        if name not in self.used:
            pen = SVGPathPen(self.glyphs, ntos=lambda v: f"{round(v)}")
            self.glyphs[name].draw(pen)
            self.used[name] = pen.getCommands()
        return f"{self.key}{self.order.index(name):x}"

    def defs(self) -> str:
        return "".join(f'<path id="{self.key}{self.order.index(n):x}" d="{d}"/>' for n, d in self.used.items() if d)


FONTS_USED: dict[str, Face] = {}


def face(weight: int, mono: bool = False) -> Face:
    key = f"{'m' if mono else 'g'}{weight // 100}"
    if key not in FONTS_USED:
        FONTS_USED[key] = Face("GeistMono-Variable.woff2" if mono else "Geist-Variable.woff2", weight, key)
    return FONTS_USED[key]


def width(text: str, size: float, weight: int = 400, mono: bool = False) -> float:
    f = face(weight, mono)
    return f.shape(text)[-1][1] * size / f.upem


def text(s: str, x: float, y: float, size: float, fill: str, weight: int = 400, mono: bool = False,
         anchor: str = "start") -> str:
    """A run of text as <use> glyphs; (x, y) is the baseline start (or centre/end by anchor)."""
    f = face(weight, mono)
    run = f.shape(s)
    k = size / f.upem
    if anchor == "middle":
        x -= run[-1][1] * k / 2
    elif anchor == "end":
        x -= run[-1][1] * k
    uses = "".join(f'<use href="#{f.ref(n)}" x="{gx}"/>' for n, gx in run[:-1] if f.ref(n) and f.used[n])
    return f'<g fill="var(--{fill})" transform="translate({x:.1f} {y:.1f}) scale({k:.5f} {-k:.5f})">{uses}</g>'


# ------------------------------------------------------------------------------------------ motion
EASE = "cubic-bezier(.45,0,.2,1)"       # calm in-out for moves
OUT_EASE = "cubic-bezier(.2,.75,.25,1)"  # arrivals
CSS: list[str] = []


def anim(name: str, frames: list[tuple[float, dict]], ease: str = EASE) -> str:
    """Keyframes for one element. Props: o (opacity), x/y (px), s (scale), sy (scaleY), d (dashoffset).

    Every keyframe carries the full state (missing values repeat the previous one); the first and last
    states extend to 0 % and 100 % so the loop is seamless.
    """
    keys = sorted({k for _, p in frames for k in p if k != "ease"})
    defaults = {"o": 1, "x": 0, "y": 0, "s": 1, "sy": 1, "d": 0}
    state = {k: frames[0][1].get(k, defaults[k]) for k in keys}
    rows: list[tuple[float, dict, str | None]] = []
    for t, props in frames:
        props = dict(props)
        ez = props.pop("ease", None)
        state = {**state, **props}
        rows.append((t, dict(state), ez))
    if rows[0][0] > 0:
        rows.insert(0, (0.0, rows[0][1], None))
    if rows[-1][0] < T:
        rows.append((T, rows[-1][1], None))

    def decl(st: dict) -> str:
        out = []
        if "o" in st:
            out.append(f"opacity:{st['o']:g}")
        if any(k in st for k in ("x", "y", "s", "sy")):
            tf = []
            if st.get("x", 0) or st.get("y", 0) or True:
                tf.append(f"translate({st.get('x', 0):g}px,{st.get('y', 0):g}px)")
            sx = st.get("s", 1)
            sy = st.get("sy", 1) * sx
            tf.append(f"scale({sx:g},{sy:g})")
            out.append("transform:" + " ".join(tf))
        if "d" in st:
            out.append(f"stroke-dashoffset:{st['d']:g}")
        return ";".join(out)

    body = []
    for t, st, ez in rows:
        body.append(f"{t / T * 100:.2f}%{{{decl(st)};animation-timing-function:{ez or ease}}}")
    CSS.append(f"@keyframes {name}{{{''.join(body)}}}#{name}{{animation-name:{name}}}")
    return name


def g(id_: str, content: str, frames: list[tuple[float, dict]] | None = None, ease: str = EASE,
      static: str = "", extra: str = "") -> str:
    """An animated group. `static` is its reduced-motion style (the end frame); default hidden."""
    if frames:
        anim(id_, frames, ease)
    style = static or "opacity:0"
    CSS.append(f"#{id_}{{{style}}}")
    return f'<g id="{id_}" class="a"{extra}>{content}</g>'


def kreska_face(expr: str, eyes_w: float, brow_w: float, color: str) -> str:
    eyes, brow, extra = FACES[expr]
    out = (f'<path d="{eyes}" stroke="var(--{color})" stroke-width="{eyes_w}"/>'
           f'<path d="{brow}" stroke="var(--{color})" stroke-width="{brow_w}"/>')
    if extra:
        out += f'<path d="{extra}" stroke="var(--{color})" stroke-width="1"/>'
    return f'<g fill="none" stroke-linecap="round" stroke-linejoin="round">{out}</g>'


def agent_icon(x: float, y: float, size: float, expr: str = "idle") -> str:
    """Kreska as the agent icon: outline squircle on --el (guide §3 weights)."""
    fw, ew, bw = (1.8, 2.2, 1.7) if size <= 32 else (1.5, 2.0, 1.55) if size < 64 else (1.15, 1.7, 1.3)
    k = size / 24
    return (f'<g transform="translate({x:g} {y:g}) scale({k:.4f})">'
            f'<path d="{SQUIRCLE}" fill="var(--el)" stroke="var(--t1)" stroke-width="{fw}"/>'
            f'{kreska_face(expr, ew, bw, "t1")}</g>')


def card(x, y, w, h, r=20) -> str:
    return (f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="var(--el)" filter="url(#sh)"'
            f' stroke="var(--outline)"/>')


# ---------------------------------------------------------------------------------------- glyphs
def open_glyph(cx, cy, r=11):
    return f'<circle cx="{cx}" cy="{cy}" r="{r - 1}" fill="none" stroke="var(--t2)" stroke-width="2"/>'


def half_glyph(cx, cy, r=11):
    return f'<path d="M{cx} {cy - r + 4}A{r - 4} {r - 4} 0 0 1 {cx} {cy + r - 4}Z" fill="var(--t1)"/>'


def done_glyph(cx, cy, r=11):
    return (f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="var(--t1)"/>'
            f'<path d="M{cx - 4.6} {cy + .2}l3.1 3.1 6-6.4" fill="none" stroke="var(--el)" stroke-width="2.2"'
            f' stroke-linecap="round" stroke-linejoin="round"/>')


def agent_tag(x, y) -> tuple[str, float]:
    """The "Agent" tag: a pill with a tiny Kreska and the word. Returns (svg, width)."""
    tw = width("Agent", 16, 500)
    w = 12 + 16 + 6 + tw + 12
    return (f'<rect x="{x}" y="{y - 14}" width="{w:.1f}" height="28" rx="14" fill="var(--sub)"/>'
            + agent_icon(x + 10, y - 8, 16)
            + text("Agent", x + 32, y + 5.5, 16, "t2", 500)), w


# ----------------------------------------------------------------------------------------- scenes
def build() -> str:
    CSS.clear()
    parts: list[str] = []
    cx = W / 2

    # A. Kreska draws itself, then the wordmark -------------------------------------------- 0.0–2.4
    logo = 96
    wm_size = 84
    wm_w = width("flux", wm_size, 600)
    gap = 24
    total = logo + gap + wm_w
    lx = cx - total / 2          # final logo x
    ly = 225 - logo / 2
    shift = (total - logo) / 2   # logo starts centred alone
    k = logo / 24
    draw = g("tileline", f'<path d="{TILE}" pathLength="1" fill="none" stroke="var(--inv)" stroke-width="1.1"'
                         f' stroke-dasharray="1 1"/>',
             [(0.05, {"o": 0, "d": 1}), (0.1, {"o": 1}), (0.95, {"d": 0, "ease": OUT_EASE}), (1.25, {"o": 1}),
              (1.45, {"o": 0})], ease=EASE, static="opacity:0;stroke-dashoffset:0")
    fill = g("tilefill", f'<path d="{TILE}" fill="var(--inv)"/>',
             [(0.75, {"o": 0, "s": .94}), (1.15, {"o": 1, "s": 1, "ease": OUT_EASE})], ease=OUT_EASE,
             static="opacity:1")
    eyes, brow, _ = FACES["idle"]
    face_in = (f'<g transform="translate(12 12) scale(1.14) translate(-12 -12.4)" fill="none" stroke="var(--oninv)"'
               f' stroke-linecap="round" stroke-linejoin="round">'
               + g("eyes", f'<path d="{eyes}" stroke-width="2.2"/>',
                   [(1.0, {"o": 0, "sy": 0}), (1.35, {"o": 1, "sy": 1, "ease": OUT_EASE}),
                    (2.05, {"sy": 1}), (2.12, {"sy": .1}), (2.2, {"sy": 1})], ease=OUT_EASE, static="opacity:1")
               + g("brow", f'<path d="{brow}" pathLength="1" stroke-dasharray="1 1" stroke-width="1.7"/>',
                   [(1.15, {"o": 0, "d": 1, "y": 0}), (1.2, {"o": 1}), (1.5, {"d": 0, "ease": OUT_EASE}),
                    (1.95, {"y": 0}), (2.1, {"y": -.5}), (2.25, {"y": 0})], ease=OUT_EASE,
                   static="opacity:1;stroke-dashoffset:0")
               + "</g>")
    tile = f'<g transform="translate({lx:.1f} {ly:.1f}) scale({k:g})">{draw}{fill}{face_in}</g>'
    logo_g = g("logo", tile, [(0, {"x": shift}), (1.2, {"x": shift}), (1.7, {"x": 0})], static="opacity:1")
    wm = g("wordmark", text("flux", lx + logo + gap, 225 + wm_size * .36, wm_size, "t1", 600),
           [(1.5, {"o": 0, "x": 10}), (1.95, {"o": 1, "x": 0, "ease": OUT_EASE})], ease=OUT_EASE,
           static="opacity:1")
    parts.append(g("intro", logo_g + wm,
                   [(0, {"o": 1, "y": 0, "s": 1}), (2.35, {"o": 1, "y": 0, "s": 1}),
                    (2.7, {"o": 0, "y": -16, "s": .97})],
                   static="opacity:0"))

    # B. Jonas's message --------------------------------------------------------------------- 2.5–3.7
    msg = "Should we measure soil moisture first?"
    msz = 26
    bw = width(msg, msz) + 44
    av = 46
    row_w = av + 14 + bw
    mx = cx - row_w / 2
    my = 150  # name baseline
    bub_y = my + 14
    bub_h = 60
    bubble = (f'<circle cx="{mx + av / 2}" cy="{my - 2}" r="{av / 2}" fill="var(--sub)"/>'
              + text("JB", mx + av / 2, my + 4.5, 17, "t2", 600, anchor="middle")
              + text("Jonas Berg", mx + av + 14, my + 3, 19, "t1", 600)
              + text("10:58", mx + av + 14 + width("Jonas Berg", 19, 600) + 10, my + 3, 16, "t3", 400, mono=True)
              + card(mx + av + 14, bub_y, bw, bub_h, 20)
              + text(msg, mx + av + 14 + 22, bub_y + 39, msz, "t1"))
    parts.append(g("msg", bubble,
                   [(2.65, {"o": 0, "y": 18, "s": .97}), (3.1, {"o": 1, "y": 0, "s": 1, "ease": OUT_EASE}),
                    (3.7, {"o": 1, "y": 0, "s": 1}), (4.3, {"o": .45, "y": -78, "s": .86}),
                    (5.0, {"o": .45, "y": -78, "s": .86}), (5.4, {"o": 0, "y": -110, "s": .86})],
                   ease=EASE))

    # C. It lifts into task #12 ------------------------------------------------------------- 3.7–5.0
    tw, th = 620, 100
    tx, ty = cx - tw / 2, 212
    # the ghost: the bubble's outline travelling down into the card
    ghost = f'<rect x="{mx + av + 14}" y="{bub_y}" width="{bw}" height="{bub_h}" rx="20" fill="none" stroke="var(--line2)" stroke-width="2"/>'
    parts.append(g("ghost", ghost,
                   [(3.7, {"o": 0, "y": 0}), (3.8, {"o": 1}), (4.35, {"o": 0, "y": 70})], ease=EASE))
    gx, gy = tx + 34, ty + 38
    status = (g("st-open", open_glyph(gx, gy), [(7.95, {"o": 1}), (8.25, {"o": 0})], static="opacity:0")
              + g("st-prog", open_glyph(gx, gy) + half_glyph(gx, gy),
                  [(7.95, {"o": 0, "s": .6}), (8.3, {"o": 1, "s": 1, "ease": OUT_EASE}), (9.3, {"o": 1, "s": 1}),
                   (9.6, {"o": 0, "s": .6})], ease=OUT_EASE)
              + g("st-done", done_glyph(gx, gy),
                  [(9.3, {"o": 0, "s": .6}), (9.65, {"o": 1, "s": 1, "ease": OUT_EASE})], ease=OUT_EASE))
    title_x = gx + 24
    num_w = width("#12", 22, 500, mono=True)
    words = (g("w-open", text("Open · from Jonas’s message", title_x, ty + 76, 19, "t3"),
               [(7.95, {"o": 1}), (8.2, {"o": 0})], static="opacity:0")
             + g("w-prog", text("In progress · Claude Code", title_x, ty + 76, 19, "t3"),
                 [(8.15, {"o": 0, "y": 6}), (8.45, {"o": 1, "y": 0, "ease": OUT_EASE}), (9.3, {"o": 1, "y": 0}),
                  (9.5, {"o": 0})], ease=OUT_EASE)
             + g("w-done", text("Done · Claude Code", title_x, ty + 76, 19, "t3"),
                 [(9.45, {"o": 0, "y": 6}), (9.75, {"o": 1, "y": 0, "ease": OUT_EASE})], ease=OUT_EASE))
    owner_none = g("own-none", text("No owner", tx + tw - 26, ty + 45, 18, "t3", anchor="end"),
                   [(7.75, {"o": 1}), (7.95, {"o": 0})], static="opacity:0")
    owner_w = 26 + 8 + width("Claude Code", 18, 500)
    ox = tx + tw - 26 - owner_w
    owner_ai = g("own-ai", agent_icon(ox, ty + 25, 26, "working") + text("Claude Code", ox + 34, ty + 44, 18, "t2", 500),
                 [(8.1, {"o": 0}), (8.35, {"o": 1})])
    task = (card(tx, ty, tw, th, 20) + status
            + text("#12", title_x, ty + 46, 22, "t3", 500, mono=True)
            + text("Measure soil moisture first", title_x + num_w + 12, ty + 46, 25, "t1", 500)
            + words + owner_none + owner_ai)
    parts.append(g("task", task,
                   [(3.85, {"o": 0, "y": 34, "s": .96}), (4.4, {"o": 1, "y": 0, "s": 1, "ease": OUT_EASE}),
                    (4.95, {"o": 1, "y": 0, "s": 1}), (5.45, {"o": .45, "y": -150, "s": .86}),
                    (6.8, {"o": .45, "y": -150, "s": .86}), (7.3, {"o": 1, "y": -40, "s": 1}),
                    (8.75, {"o": 1, "y": -40, "s": 1}), (9.2, {"o": .5, "y": -150, "s": .86}),
                    (10.0, {"o": .5, "y": -150, "s": .86}), (10.35, {"o": 0, "y": -170, "s": .86})], ease=EASE))

    # D. A decision is accepted ----------------------------------------------------------- 5.0–6.8
    dw, dh = 620, 170
    dx, dy = cx - dw / 2, 160
    btn_w, btn_h = 116, 46
    bx, by = dx + dw - 28 - btn_w, dy + dh - 26 - btn_h
    button = g("btn", f'<rect x="{bx}" y="{by}" width="{btn_w}" height="{btn_h}" rx="10" fill="var(--inv)"/>'
               + text("Accept", bx + btn_w / 2, by + 30, 19, "oninv", 500, anchor="middle"),
               [(5.75, {"o": 1, "s": 1}), (5.85, {"s": .94}), (6.0, {"s": 1, "ease": OUT_EASE}),
                (6.05, {"o": 1, "s": 1}), (6.3, {"o": 0, "s": .9})], static="opacity:0")
    acc_w = 24 + 10 + width("Accepted", 19, 500)
    ax = bx + btn_w - acc_w
    accepted = g("acc", done_glyph(ax + 12, by + btn_h / 2, 12) + text("Accepted", ax + 34, by + 30, 19, "t1", 500),
                 [(6.1, {"o": 0, "s": .85}), (6.45, {"o": 1, "s": 1, "ease": OUT_EASE})], ease=OUT_EASE)
    dtitle = "Measure moisture before buying sensors"
    decision = (card(dx, dy, dw, dh, 20)
                + text("Decision", dx + 28, dy + 40, 17, "t3", 500)
                + text(dtitle, dx + 28, dy + 80, 25, "t1", 500)
                + text("Readings show which beds need a sensor.", dx + 28, dy + 112, 19, "t2")
                + text("From Jonas’s message", dx + 28, dy + 146, 17, "t3")
                + button + accepted)
    parts.append(g("dec", decision,
                   [(5.0, {"o": 0, "y": 30, "s": .96}), (5.5, {"o": 1, "y": 0, "s": 1, "ease": OUT_EASE}),
                    (6.75, {"o": 1, "y": 0, "s": 1}), (7.2, {"o": 0, "y": 40, "s": .96})], ease=EASE))
    pointer = ('<path d="M0 0V24L6.4 18 10.8 27.4 14.6 25.8 10.3 16.6H18.6Z" fill="var(--t1)" stroke="var(--el)"'
               ' stroke-width="1.6" stroke-linejoin="round"/>')
    px, py = bx + btn_w / 2 + 6, by + btn_h / 2 + 4
    parts.append(f'<g transform="translate({px:.1f} {py:.1f})">'
                 + g("ptr", pointer,
                     [(5.3, {"o": 0, "x": 120, "y": 90}), (5.45, {"o": 1}), (5.8, {"x": 0, "y": 0, "s": 1}),
                      (5.88, {"s": .88}), (6.0, {"s": 1}), (6.3, {"o": 1, "x": 0, "y": 0}),
                      (6.6, {"o": 0, "x": 30, "y": 40})], ease=EASE) + "</g>")

    # E. Kreska, as an agent, picks up the task ------------------------------------------ 6.8–8.6
    msz2 = 92
    kx, ky = cx + 150, 26
    hello = g("k-hello", kreska_face("hello", 1.7, 1.3, "t1"), [(7.6, {"o": 1}), (7.7, {"o": 0})],
              static="opacity:0")
    work = g("k-work", kreska_face("working", 1.7, 1.3, "t1"), [(7.6, {"o": 0}), (7.7, {"o": 1})],
             static="opacity:0")
    mascot = (f'<g transform="translate({kx} {ky}) scale({msz2 / 24:.4f})">'
              f'<path d="{SQUIRCLE}" fill="var(--el)" stroke="var(--t1)" stroke-width="1.15"/>{hello}{work}</g>')
    # target: the owner icon in the task card, after the card moved up by 40
    tgt_x, tgt_y = ox, ty + 25 - 40
    k2 = 26 / msz2
    fx = (tgt_x - 2.6 * k2 * 0) - kx
    fy = tgt_y - ky
    # scale about the mascot's own centre (fill-box), so translate compensates for the centre shift
    c0 = (kx + msz2 / 2, ky + msz2 / 2)
    c1 = (tgt_x + 13, tgt_y + 13)
    parts.append(g("mascot", mascot,
                   [(6.95, {"o": 0, "x": 0, "y": 22, "s": .7}),
                    (7.4, {"o": 1, "x": 0, "y": 0, "s": 1, "ease": "cubic-bezier(.3,1.4,.5,1)"}),
                    (7.75, {"o": 1, "x": 0, "y": 0, "s": 1}),
                    (8.25, {"o": 1, "x": round(c1[0] - c0[0], 1), "y": round(c1[1] - c0[1], 1), "s": round(k2, 3)}),
                    (8.4, {"o": 0})], ease=EASE))
    tag2, tag2_w = agent_tag(0, 0)
    name_w = width("Claude Code", 18, 500)
    lab_x = kx + msz2 / 2 - (name_w + 10 + tag2_w) / 2
    label = (text("Claude Code", lab_x, ky + msz2 + 30, 18, "t1", 500)
             + f'<g transform="translate({lab_x + name_w + 10:.1f} {ky + msz2 + 24})">{tag2}</g>')
    parts.append(g("klabel", label,
                   [(7.1, {"o": 0, "y": 6}), (7.45, {"o": 1, "y": 0, "ease": OUT_EASE}), (7.7, {"o": 1, "y": 0}),
                    (7.9, {"o": 0, "y": 0})], ease=OUT_EASE))
    parts.append(g("pickup", text("Claude Code picked up #12", cx, 352, 19, "t3", anchor="middle"),
                   [(8.2, {"o": 0, "y": 8}), (8.5, {"o": 1, "y": 0, "ease": OUT_EASE}), (8.8, {"o": 1}),
                    (9.05, {"o": 0})], ease=OUT_EASE))

    # F. The result turns Positive ------------------------------------------------------- 8.8–10.2
    rw, rh = 620, 160
    rx, ry = cx - rw / 2, 182
    tag, tag_w = agent_tag(0, 0)
    by_x = rx + 28
    by_y = ry + rh - 34
    byline = (agent_icon(by_x, by_y - 13, 26, "done")
              + text("Claude Code", by_x + 36, by_y + 6, 18, "t1", 500)
              + f'<g transform="translate({by_x + 36 + width("Claude Code", 18, 500) + 10:.1f} {by_y})">{tag}</g>'
              + text("for Ada", by_x + 36 + width("Claude Code", 18, 500) + 20 + tag_w, by_y + 6, 18, "t3"))
    sx_ = rx + rw - 28
    st_pending = g("r-pend", open_glyph(sx_ - 11 - width("Recording", 19, 500) - 10, ry + 38)
                   + text("Recording", sx_, ry + 45, 19, "t3", 500, anchor="end"),
                   [(9.55, {"o": 1}), (9.75, {"o": 0})], static="opacity:0")
    pos_w = width("Positive", 19, 600)
    st_pos = g("r-pos", done_glyph(sx_ - pos_w - 22, ry + 38) + text("Positive", sx_, ry + 45, 19, "t1", 600, anchor="end"),
               [(9.6, {"o": 0, "s": .8}), (9.95, {"o": 1, "s": 1, "ease": OUT_EASE})], ease=OUT_EASE)
    result = (card(rx, ry, rw, rh, 20)
              + text("Result · #12", rx + 28, ry + 45, 17, "t3", 500)
              + text("Soil moisture in all 12 beds", rx + 28, ry + 86, 25, "t1", 500)
              + st_pending + st_pos + byline)
    parts.append(g("res", result,
                   [(8.9, {"o": 0, "y": 30, "s": .96}), (9.4, {"o": 1, "y": 0, "s": 1, "ease": OUT_EASE}),
                    (10.1, {"o": 1, "y": 0, "s": 1}), (10.45, {"o": 0, "y": 20, "s": .97})], ease=EASE))

    # G. The end line (also the reduced-motion frame) -------------------------------------- 10.3–12
    lsz = 46
    wm2 = 40
    wm2_w = width("flux", wm2, 600)
    row = lsz + 14 + wm2_w
    ex = cx - row / 2
    end_logo = (f'<g transform="translate({ex:.1f} 126) scale({lsz / 24:g})"><path d="{TILE}" fill="var(--inv)"/>'
                f'<g transform="translate(12 12) scale(1.14) translate(-12 -12.4)" fill="none" stroke="var(--oninv)"'
                f' stroke-linecap="round" stroke-linejoin="round"><path d="{eyes}" stroke-width="2.2"/>'
                f'<path d="{brow}" stroke-width="1.7"/></g></g>'
                + text("flux", ex + lsz + 14, 126 + lsz / 2 + wm2 * .36, wm2, "t1", 600))
    line1 = text("People and agents, one project.", cx, 262, 40, "t1", 600, anchor="middle")
    line2 = text("Open source · self-hosted · your own agents", cx, 306, 20, "t3", anchor="middle")
    parts.append(g("end", end_logo + line1 + line2,
                   [(10.3, {"o": 0, "y": 14}), (10.85, {"o": 1, "y": 0, "ease": OUT_EASE}),
                    (11.45, {"o": 1, "y": 0}), (11.9, {"o": 0, "y": -10})], ease=EASE, static="opacity:1"))
    return "".join(parts)


def svg(theme: str) -> str:
    FONTS_USED.clear()
    body = build()
    tk = THEMES[theme]
    tokens = ";".join(f"--{k}:{v}" for k, v in tk.items() if k not in ("sh1", "sh2"))
    shadow = (f'<filter id="sh" x="-10%" y="-20%" width="120%" height="160%">'
              f'<feDropShadow dx="0" dy="1" stdDeviation="1" flood-color="#000" flood-opacity="{tk["sh1"]}"/>'
              f'<feDropShadow dx="0" dy="6" stdDeviation="7" flood-color="#000" flood-opacity="{tk["sh2"]}"/></filter>')
    glyphs = "".join(f.defs() for f in FONTS_USED.values())
    css = (f":root{{{tokens}}}"
           ".a{animation-duration:12s;animation-iteration-count:infinite;animation-fill-mode:both;"
           "transform-box:fill-box;transform-origin:center}"
           + "".join(CSS)
           + "@media (prefers-reduced-motion:reduce){.a{animation:none!important}}")
    title = "Flux: people and agents, one project"
    desc = ("A short animation. The Flux logo, Kreska, draws itself next to the word flux. Jonas asks: Should we "
            "measure soil moisture first? The message becomes task #12. A decision, Measure moisture before buying "
            "sensors, is accepted. Kreska, as the agent Claude Code, picks up the task, and its result turns "
            "Positive. It ends on: People and agents, one project.")
    return (f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 {W} {H}"'
            f' width="{W}" height="{H}" role="img" aria-labelledby="t d">'
            f'<title id="t">{title}</title><desc id="d">{desc}</desc>'
            f'<style>{css}</style><defs>{shadow}{glyphs}</defs>'
            f'<rect width="{W}" height="{H}" rx="24" fill="var(--bg)"/>{body}</svg>\n')


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    for theme in THEMES:
        path = OUT / f"flux-promo-{theme}.svg"
        path.write_text(svg(theme), encoding="utf-8")
        print(f"{path.relative_to(ROOT)}: {path.stat().st_size} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
