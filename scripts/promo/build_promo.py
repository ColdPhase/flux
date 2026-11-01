"""Build the README promo animation: docs/assets/promo/flux-promo-{light,dark}.svg (#780).

A 16 s seamless loop in the final design Prostota (docs/design/final/README.md). Kreska draws itself and
becomes the logo of a Flux window ("Community garden sensors"). A camera then moves over that window:
Jonas's message becomes task #12, Ada accepts a decision, Claude Code (Kreska, as an agent) picks the task
up and streams its status, the positive result lands in the Wiki, the Map links all four, and a phone shows
the same work in the Inbox. It ends on "People and agents, one project."

Pure SVG + CSS keyframes: no script and no external font. Geist glyphs are shaped by HarfBuzz and stored once
as paths, so GitHub renders it animated inside <img>. With reduced motion the CSS stops and the static styles
show the end frame. Run it in Docker through scripts/make_promo.sh (fontTools, uharfbuzz, brotli).
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
OUT_DIR = ROOT / "docs/assets/promo"
W, H = 960, 540   # the frame
T = 16.0          # loop length in seconds

THEMES = {
    "light": dict(side="#EBEBED", bg="#F4F4F5", el="#FFFFFF", sub="#EBEBEC", hov="#E3E3E5", t1="#18181B",
                  t2="#4A4A4A", t3="#636363", inv="#18181B", oninv="#FFFFFF", own="#E7E7EA",
                  line="rgba(0,0,0,.07)", line2="rgba(0,0,0,.14)", outline="none", dot="rgba(0,0,0,.13)",
                  g1="#3B3B3F", g2="#18181B", ong="#FFFFFF", sh1=".05", sh2=".12", sh3=".22"),
    "dark": dict(side="#0B0B0B", bg="#111111", el="#1C1C1C", sub="#242424", hov="#2C2C2C", t1="#F0F0F0",
                 t2="#BDBDBD", t3="#A1A1A1", inv="#F0F0F0", oninv="#111111", own="#313134",
                 line="rgba(255,255,255,.08)", line2="rgba(255,255,255,.16)", outline="rgba(255,255,255,.08)",
                 dot="rgba(255,255,255,.12)", g1="#FFFFFF", g2="#D9D9D9", ong="#111111",
                 sh1=".35", sh2=".5", sh3=".6"),
}

# Kreska's own paths (app/apps/web/src/ui/Kreska.tsx, guide §3), on a 24-unit grid.
SQUIRCLE = "M8.6 2.6H15.4C19 2.6 21.4 5 21.4 8.6V15.4C21.4 19 19 21.4 15.4 21.4H8.6C5 21.4 2.6 19 2.6 15.4V8.6C2.6 5 5 2.6 8.6 2.6Z"
TILE = "M7 0H17C21.2 0 24 2.8 24 7V17C24 21.2 21.2 24 17 24H7C2.8 24 0 21.2 0 17V7C0 2.8 2.8 0 7 0Z"
FACES = {
    "idle": ("M9.3 11.2V13.8M14.7 11.2V13.8", "M7.3 8.1 10.5 7.2", ""),
    "hello": ("M9.3 11.2V13.8M13.4 12.6H16", "M7.3 7 10.5 5.9",
              "M21.6 4.6C22.6 5.6 23.1 6.8 23.2 8.2M20.4 6C21 6.6 21.3 7.3 21.4 8.1"),
    "working": ("M9.3 12V13.4M14.7 12V13.4", "M7.3 8.7 10.7 8.5", ""),
    "writing": ("M10.1 12.4V14.2M15.5 12.4V14.2", "M7.6 8.6 10.8 8.1", "M17.4 18.2 19.8 15.8M15.6 18.6H17"),
    "done": ("M7.9 13.3 9.3 11.7 10.7 13.3M13.3 13.3 14.7 11.7 16.1 13.3", "M7.3 8 10.5 7.4", ""),
}


# ---------------------------------------------------------------------------------------------- text
class Face:
    """One Geist instance: HarfBuzz shapes, fontTools draws; each glyph is stored once in <defs>."""

    def __init__(self, file: str, weight: int, key: str):
        tt = TTFont(FONTS / file)
        sfnt = io.BytesIO()  # HarfBuzz reads TrueType, not WOFF2
        tt.flavor = None
        tt.save(sfnt)
        data = sfnt.getvalue()
        self.tt = TTFont(io.BytesIO(data))
        self.glyphs = self.tt.getGlyphSet(location={"wght": weight})
        self.order = self.tt.getGlyphOrder()
        self.upem = self.tt["head"].unitsPerEm
        self.hb = hb.Font(hb.Face(data))
        self.hb.set_variations({"wght": weight})
        self.key = key
        self.used: dict[str, str] = {}

    def shape(self, s: str) -> list[tuple[str, int]]:
        buf = hb.Buffer()
        buf.add_str(s)
        buf.guess_segment_properties()
        hb.shape(self.hb, buf, {"kern": True, "liga": True})
        x, out = 0, []
        for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
            out.append((self.order[info.codepoint], x + pos.x_offset))
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


def width(s: str, size: float, weight: int = 400, mono: bool = False) -> float:
    f = face(weight, mono)
    return f.shape(s)[-1][1] * size / f.upem


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
EASE = "cubic-bezier(.45,0,.2,1)"          # calm in-out (camera, moves)
OUT = "cubic-bezier(.2,.8,.25,1)"          # arrivals
SPRING = "cubic-bezier(.3,1.45,.5,1)"      # a small overshoot for pops
CSS: list[str] = []


def anim(name: str, frames: list[tuple[float, dict]], ease: str = EASE) -> None:
    """Keyframes for one element. Props: o (opacity), x/y (px), s (scale), sx/sy (axis scale), d (dashoffset).

    Every keyframe carries the full state (missing values repeat the previous one). The first and last states
    extend to 0 % and 100 %, so the loop is seamless. A keyframe's "ease" shapes the segment that ends there.
    Transforms use the element's own origin (0, 0): draw a group around 0,0 inside a translated parent to
    scale it about a point.
    """
    keys = sorted({k for _, p in frames for k in p if k != "ease"})
    defaults = {"o": 1, "x": 0, "y": 0, "s": 1, "sx": 1, "sy": 1, "d": 0}
    state = {k: frames[0][1].get(k, defaults[k]) for k in keys}
    rows: list[list] = []
    for t, props in frames:
        props = dict(props)
        ez = props.pop("ease", None)
        state = {**state, **props}
        rows.append([t, dict(state), ease])
        if ez and len(rows) > 1:
            rows[-2][2] = ez  # the segment that ends here starts at the previous keyframe
    if rows[0][0] > 0:
        rows.insert(0, [0.0, rows[0][1], ease])
    if rows[-1][0] < T:
        rows.append([T, rows[-1][1], ease])

    def decl(st: dict) -> str:
        out = []
        if "o" in st:
            out.append(f"opacity:{st['o']:g}")
        if any(k in st for k in ("x", "y", "s", "sx", "sy")):
            s = st.get("s", 1)
            out.append(f"transform:translate({st.get('x', 0):g}px,{st.get('y', 0):g}px) "
                       f"scale({s * st.get('sx', 1):g},{s * st.get('sy', 1):g})")
        if "d" in st:
            out.append(f"stroke-dashoffset:{st['d']:g}")
        return ";".join(out)

    body = "".join(f"{t / T * 100:.2f}%{{{decl(st)};animation-timing-function:{ez}}}" for t, st, ez in rows)
    CSS.append(f"@keyframes {name}{{{body}}}#{name}{{animation-name:{name}}}")


def g(id_: str, content: str, frames: list[tuple[float, dict]] | None = None, ease: str = EASE,
      static: str = "opacity:0", at: tuple[float, float] | None = None,
      pivot: tuple[float, float] | None = None) -> str:
    """An animated group. `static` is its reduced-motion style; `at` wraps it in a translate (its origin);
    `pivot` does the same for content drawn in place, so it scales about that point."""
    if pivot:
        content = f'<g transform="translate({-pivot[0]:g} {-pivot[1]:g})">{content}</g>'
        at = pivot
    if frames:
        anim(id_, frames, ease)
    CSS.append(f"#{id_}{{{static}}}")
    out = f'<g id="{id_}" class="a">{content}</g>'
    return f'<g transform="translate({at[0]:g} {at[1]:g})">{out}</g>' if at else out


def show(t0: float, t1: float | None = None, dy: float = 10, dur: float = .45, out: float = .3) -> list:
    """Fade (and rise) in at t0; optionally out at t1."""
    f = [(t0, {"o": 0, "y": dy}), (t0 + dur, {"o": 1, "y": 0, "ease": OUT})]
    if t1 is not None:
        f += [(t1, {"o": 1, "y": 0}), (t1 + out, {"o": 0, "y": 0})]
    return f


def swap(t_out: float, dur: float = .25) -> list:
    """Visible until t_out, then fades out (the thing it is replaced by uses show)."""
    return [(t_out, {"o": 1}), (t_out + dur, {"o": 0})]


# ------------------------------------------------------------------------------------------ pieces
def kface(expr: str, eyes_w: float, brow_w: float, color: str = "t1") -> str:
    eyes, brow, extra = FACES[expr]
    out = (f'<path d="{eyes}" stroke-width="{eyes_w}"/><path d="{brow}" stroke-width="{brow_w}"/>'
           + (f'<path d="{extra}" stroke-width="1"/>' if extra else ""))
    return f'<g fill="none" stroke="var(--{color})" stroke-linecap="round" stroke-linejoin="round">{out}</g>'


def weights(size: float) -> tuple[float, float, float]:
    return (1.8, 2.2, 1.7) if size <= 32 else (1.5, 2.0, 1.55) if size < 64 else (1.15, 1.7, 1.3)


def kreska(x: float, y: float, size: float, expr: str = "idle") -> str:
    """Kreska as the agent icon: outline squircle on --el."""
    fw, ew, bw = weights(size)
    return (f'<g transform="translate({x:g} {y:g}) scale({size / 24:.4f})">'
            f'<path d="{SQUIRCLE}" fill="var(--el)" stroke="var(--t1)" stroke-width="{fw}"/>{kface(expr, ew, bw)}</g>')


def kreska_faces(x: float, y: float, size: float, faces: list[tuple[str, list]], name: str) -> str:
    """Kreska whose expression changes over time: one face per (expression, frames)."""
    fw, ew, bw = weights(size)
    inner = "".join(g(f"{name}{i}", kface(e, ew, bw), fr, static="opacity:0" if i < len(faces) - 1 else "opacity:1")
                    for i, (e, fr) in enumerate(faces))
    return (f'<g transform="translate({x:g} {y:g}) scale({size / 24:.4f})">'
            f'<path d="{SQUIRCLE}" fill="var(--el)" stroke="var(--t1)" stroke-width="{fw}"/>{inner}</g>')


def logo(x: float, y: float, size: float) -> str:
    """The Flux logo: a solid --inv tile with the face knocked out."""
    eyes, brow, _ = FACES["idle"]
    return (f'<g transform="translate({x:g} {y:g}) scale({size / 24:.4f})"><path d="{TILE}" fill="var(--inv)"/>'
            f'<g transform="translate(12 12) scale(1.14) translate(-12 -12.4)" fill="none" stroke="var(--oninv)"'
            f' stroke-linecap="round" stroke-linejoin="round"><path d="{eyes}" stroke-width="2.2"/>'
            f'<path d="{brow}" stroke-width="1.7"/></g></g>')


def card(x, y, w, h, r=18, fill="el", shadow="sh") -> str:
    f = f' filter="url(#{shadow})"' if shadow else ""
    return f'<rect x="{x:g}" y="{y:g}" width="{w:g}" height="{h:g}" rx="{r}" fill="var(--{fill})"{f} stroke="var(--outline)"/>'


def avatar(cx, cy, r, initials) -> str:
    return (f'<circle cx="{cx:g}" cy="{cy:g}" r="{r}" fill="var(--sub)"/>'
            + text(initials, cx, cy + r * .36, r * .78, "t2", 600, anchor="middle"))


def tile(x, y, letter, size=20) -> str:
    return (f'<rect x="{x}" y="{y}" width="{size}" height="{size}" rx="6" fill="var(--sub)"/>'
            + text(letter, x + size / 2, y + size * .7, size * .55, "t2", 600, anchor="middle"))


def glyph_open(cx, cy, r=8):
    return f'<circle cx="{cx:g}" cy="{cy:g}" r="{r - .8:g}" fill="none" stroke="var(--t2)" stroke-width="1.6"/>'


def glyph_half(cx, cy, r=8):
    return glyph_open(cx, cy, r) + f'<path d="M{cx:g} {cy - r + 3:g}A{r - 3:g} {r - 3:g} 0 0 1 {cx:g} {cy + r - 3:g}Z" fill="var(--t1)"/>'


def glyph_done(cx, cy, r=8, ink="el"):
    return (f'<circle cx="{cx:g}" cy="{cy:g}" r="{r:g}" fill="var(--t1)"/>'
            f'<path d="M{cx - r * .42:g} {cy + r * .02:g}l{r * .28:g} {r * .28:g} {r * .55:g}-{r * .58:g}" fill="none"'
            f' stroke="var(--{ink})" stroke-width="{max(1.6, r * .2):g}" stroke-linecap="round" stroke-linejoin="round"/>')


def agent_tag(x, y, size=12) -> tuple[str, float]:
    """The "Agent" tag; (x, y) is the left of its vertical centre. Returns (svg, width)."""
    tw = width("Agent", size, 500)
    h = size * 1.75
    ic = size * 1.05
    w = size * .55 + ic + size * .35 + tw + size * .7
    return (f'<rect x="{x:g}" y="{y - h / 2:g}" width="{w:.1f}" height="{h:g}" rx="{h / 2:g}" fill="none"'
            f' stroke="var(--line2)"/>' + kreska(x + size * .55, y - ic / 2, ic)
            + text("Agent", x + size * .55 + ic + size * .35, y + size * .36, size, "t2", 500)), w


ICONS = {
    "home": "M3 8.2 9 3.2l6 5V14.6a1 1 0 0 1-1 1H11V11H7v4.6H4a1 1 0 0 1-1-1Z",
    "inbox": "M2.6 9.6 4.6 3.6h8.8l2 6V14a1.6 1.6 0 0 1-1.6 1.6H4.2A1.6 1.6 0 0 1 2.6 14ZM2.6 9.6h3.8l1 1.8h3.2l1-1.8h3.8",
    "pen": "M3.2 14.8l.9-3.6 7.6-7.6a1.6 1.6 0 0 1 2.3 2.3l-7.6 7.6Z",
    "projects": "M3 3h5v5H3ZM10 3h5v5h-5ZM3 10h5v5H3ZM10 10h5v5h-5Z",
}


def icon(name, x, y, size=18, color="t2"):
    return (f'<path d="{ICONS[name]}" transform="translate({x:g} {y:g}) scale({size / 18:g})" fill="none"'
            f' stroke="var(--{color})" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>')


POINTER = ('<path d="M0 0V17.5L4.6 13.2 7.9 20 10.6 18.8 7.4 12.2H13.4Z" fill="var(--t1)" stroke="var(--el)"'
           ' stroke-width="1.3" stroke-linejoin="round"/>')


# --------------------------------------------------------------------------------------------- world
# The world is a 1200 x 720 Flux window (sidebar, project header, conversation, Wiki panel) with a phone
# to its right. The camera maps world (x, y) to frame (z*x + tx, z*y + ty).
def cam(fx: float, fy: float, z: float) -> dict:
    """A camera keyframe that centres world point (fx, fy) at zoom z."""
    return {"x": round(W / 2 - z * fx, 1), "y": round(H / 2 - z * fy, 1), "s": z}


FULL = cam(600, 362, .72)

# Timeline (seconds)
T_ARRIVE = 2.9     # Jonas's message arrives
T_TASK = 4.55      # the click that makes it a task
T_DEC = 5.95       # decision card enters
T_ACCEPT = 7.0     # the click on Accept
T_AGENT = 7.95     # Claude Code appears
T_RESULT = 10.15   # the result lands in the Wiki
T_POSITIVE = 10.75
T_MAP = 11.75      # tab switch to the Map
T_PHONE = 13.35    # the phone slides in
T_END = 14.55      # the end line


def build() -> str:
    CSS.clear()
    world: list[str] = []
    # ---- window frame and sidebar
    world.append(f'<rect width="1200" height="720" rx="26" fill="var(--side)" filter="url(#pop)" stroke="var(--outline)"/>')
    side = [g("sblogo", logo(22, 20, 28) + text("flux", 58, 42, 21, "t1", 600),
              [(2.7, {"o": 0}), (2.72, {"o": 1})], static="opacity:1")]
    for i, (ic, label) in enumerate([("home", "Home"), ("inbox", "Inbox"), ("pen", "Sketchbook")]):
        y = 96 + i * 36
        side.append(icon(ic, 24, y - 13) + text(label, 54, y + 1, 15, "t1", 500))
    side.append(f'<circle cx="212" cy="127" r="10" fill="var(--inv)"/>' + text("2", 212, 131.5, 12, "oninv", 600, anchor="middle"))
    side.append(text("Projects", 24, 214, 12.5, "t3", 500))
    side.append(card(12, 226, 214, 36, 10, shadow=None))
    for i, (letter, name) in enumerate([("C", "Community garden sensors"), ("B", "Cargo bike co-op"), ("R", "Riverside zine #4")]):
        y = 244 + i * 36
        side.append(tile(22, y - 10, letter) + text(name, 52, y + 5, 14, "t1", 500))
    side.append(text("Messages", 24, 368, 12.5, "t3", 500))
    side.append(avatar(32, 396, 10, "JB") + text("Jonas Berg", 52, 401, 14, "t1", 500))
    agent_card = (card(12, 612, 214, 52, 14)
                  + kreska_faces(24, 625, 26, [("working", [(0, {"o": 1})])], "sbk")
                  + text("Claude Code", 60, 635, 14, "t1", 600) + text("working on #12", 60, 653, 12.5, "t3"))
    side.append(g("sbagent", agent_card, show(T_AGENT + .6, T_POSITIVE + .4, dy=8) , static="opacity:0"))
    side.append(avatar(34, 692, 12, "AK") + text("Ada Kowalska", 56, 697, 14, "t1", 500))
    world.append("".join(side))

    # ---- main panel and header
    world.append('<rect x="244" y="10" width="946" height="700" rx="20" fill="var(--bg)"/>')
    world.append(text("Community garden sensors", 268, 46, 16, "t1", 600))
    tabs = ["Conversation", "Map", "Tasks", "Wiki", "Agents"]
    tx = 500
    tab_x = []
    for t in tabs:
        w = width(t, 13.5, 500) + 28
        tab_x.append((tx, w))
        tx += w
    world.append(f'<rect x="496" y="22" width="{tx - 496 + 4:.1f}" height="36" rx="18" fill="var(--sub)"/>')
    (cx0, cw0), (mx0, mw0) = tab_x[0], tab_x[1]
    world.append(g("pillc", f'<rect x="{cx0:.1f}" y="26" width="{cw0:.1f}" height="28" rx="14" fill="var(--el)"/>',
                   [(T_MAP, {"o": 1, "x": 0}), (T_MAP + .35, {"o": 0, "x": mx0 - cx0})], static="opacity:0"))
    world.append(g("pillm", f'<rect x="{mx0:.1f}" y="26" width="{mw0:.1f}" height="28" rx="14" fill="var(--el)"/>',
                   [(T_MAP, {"o": 0, "x": cx0 - mx0}), (T_MAP + .35, {"o": 1, "x": 0, "ease": OUT})], static="opacity:1"))
    for t, (x, w) in zip(tabs, tab_x):
        world.append(text(t, x + w / 2, 45, 13.5, "t1" if t in ("Conversation", "Map") else "t2", 500, anchor="middle"))
    world.append(avatar(1094, 40, 13, "AK") + avatar(1124, 40, 13, "JB") + kreska(1142, 27, 26))
    world.append('<path d="M244 70H1190" stroke="var(--line)"/>')

    # ---- the conversation (scrolls), clipped to the stream area
    conv: list[str] = []
    conv.append('<path d="M272 104H528M596 104H852" stroke="var(--line)"/>' + text("Today", 562, 108, 12.5, "t3", 500, anchor="middle"))
    # Basia
    conv.append(avatar(290, 138, 16, "BN") + text("Basia Nowak", 316, 134, 14, "t1", 600)
                + text("10:41", 316 + width("Basia Nowak", 14, 600) + 8, 134, 12, "t3", mono=True))
    b1 = "The probes arrive on Thursday."
    conv.append(card(316, 144, width(b1, 15) + 30, 42, 18) + text(b1, 331, 170, 15, "t1"))
    # Ada (own)
    a1 = "Great, I’ll label the twelve beds."
    aw = width(a1, 15) + 30
    conv.append(f'<rect x="{852 - aw:.1f}" y="202" width="{aw:.1f}" height="42" rx="18" fill="url(#own)"/>'
                + text(a1, 852 - aw + 15, 228, 15, "ong"))
    # Jonas: the new message, then its hover toolbar
    j1 = "Should we measure soil moisture first?"
    jw = width(j1, 16) + 32
    jonas = (avatar(290, 282, 16, "JB") + text("Jonas Berg", 316, 278, 14, "t1", 600)
             + text("10:58", 316 + width("Jonas Berg", 14, 600) + 8, 278, 12, "t3", mono=True)
             + card(316, 288, jw, 46, 18) + text(j1, 332, 317, 16, "t1"))
    conv.append(g("jonas", jonas, show(T_ARRIVE, dy=18, dur=.55), static="opacity:1"))
    # toolbar above the bubble's right end: reply, make task, more
    tbx, tby = 316 + jw + 10, 294
    toolbar = (card(tbx, tby, 108, 34, 12)
               + f'<path d="M{tbx + 26} {tby + 12}l-5 5 5 5M{tbx + 21} {tby + 17}h7a5 5 0 0 1 5 5" fill="none" stroke="var(--t2)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'
               + f'<circle cx="{tbx + 54}" cy="{tby + 17}" r="8" fill="none" stroke="var(--t2)" stroke-width="1.5"/>'
               + f'<path d="M{tbx + 54} {tby + 13}v8M{tbx + 50} {tby + 17}h8" stroke="var(--t2)" stroke-width="1.5" stroke-linecap="round"/>'
               + "".join(f'<circle cx="{tbx + 80 + i * 6}" cy="{tby + 17}" r="1.5" fill="var(--t2)"/>' for i in range(3)))
    conv.append(g("toolbar", toolbar, show(T_TASK - .55, T_TASK + .2, dy=4, dur=.25, out=.2)))
    # the lift: the bubble's outline travels down into the task row
    ghost = f'<rect x="316" y="288" width="{jw:.1f}" height="46" rx="18" fill="none" stroke="var(--t3)" stroke-width="1.5"/>'
    conv.append(g("ghost", ghost, [(T_TASK + .05, {"o": 0, "y": 0}), (T_TASK + .1, {"o": .9}),
                                   (T_TASK + .3, {"o": .9}), (T_TASK + .55, {"o": 0, "y": 84, "ease": EASE})]))
    # task notice + row
    ty = 372
    owner_none = g("ownnone", text("No owner", 836, ty + 29, 12.5, "t3", anchor="end"), swap(T_AGENT + .7), static="opacity:0")
    ow = 22 + 7 + width("Claude Code", 12.5, 500)
    owner_ai = g("ownai", kreska(836 - ow, ty + 12, 22, "working") + text("Claude Code", 836, ty + 28, 12.5, "t2", 500, anchor="end"),
                 show(T_AGENT + .8, dy=0, dur=.3), static="opacity:1")
    gl = (g("gopen", glyph_open(338, ty + 23), swap(T_AGENT + .75), static="opacity:0")
          + g("ghalf", glyph_half(338, ty + 23), [(T_AGENT + .75, {"o": 0}), (T_AGENT + 1.0, {"o": 1}),
                                                  (T_POSITIVE, {"o": 1}), (T_POSITIVE + .2, {"o": 0})])
          + g("gdone", glyph_done(0, 0), [(T_POSITIVE, {"o": 0, "s": .5}), (T_POSITIVE + .35, {"o": 1, "s": 1, "ease": SPRING})],
              static="opacity:1", at=(338, ty + 23)))
    task = (text("Ada", 316, ty - 8, 13.5, "t1", 600) + text("made a task from Jonas’s message", 316 + width("Ada", 13.5, 600) + 5, ty - 8, 13.5, "t2")
            + card(316, ty, 536, 46, 14) + gl + text("#12", 354, ty + 28, 13, "t3", 500, mono=True)
            + text("Measure soil moisture first", 354 + width("#12", 13, 500, mono=True) + 8, ty + 28, 15, "t1", 500)
            + owner_none + owner_ai)
    conv.append(g("task", task, show(T_TASK + .3, dy=-14, dur=.55), static="opacity:1"))
    # decision notice + card
    dy0 = 448
    btn = g("btn", f'<rect x="-46" y="-17" width="92" height="34" rx="10" fill="var(--inv)"/>'
            + text("Accept", 0, 5, 14, "oninv", 500, anchor="middle"),
            [(T_ACCEPT - .05, {"o": 1, "s": 1}), (T_ACCEPT + .05, {"s": .94}), (T_ACCEPT + .22, {"s": 1, "ease": SPRING}),
             (T_ACCEPT + .3, {"o": 1}), (T_ACCEPT + .5, {"o": 0, "s": .9})], at=(788, dy0 + 106))
    acc = g("acc", glyph_done(-34, 0, 9) + text("Accepted", -20, 5, 14, "t1", 600),
            [(T_ACCEPT + .38, {"o": 0, "s": .85}), (T_ACCEPT + .7, {"o": 1, "s": 1, "ease": SPRING})],
            static="opacity:1", at=(776, dy0 + 106))
    prop = g("prop", text("Proposed by Ada", 336, dy0 + 111, 12.5, "t3"), swap(T_ACCEPT + .35), static="opacity:0")
    acc2 = g("acc2", text("Accepted by Ada · 11:04", 336, dy0 + 111, 12.5, "t3"), show(T_ACCEPT + .45, dy=0, dur=.3), static="opacity:1")
    dec = (text("Ada", 316, dy0 - 8, 13.5, "t1", 600) + text("proposed a decision from Jonas’s message", 316 + width("Ada", 13.5, 600) + 5, dy0 - 8, 13.5, "t2")
           + card(316, dy0, 536, 132, 18)
           + text("Decision", 336, dy0 + 28, 12.5, "t3", 500)
           + text("Measure moisture before buying sensors", 336, dy0 + 54, 17, "t1", 600)
           + text("Readings show which beds need a sensor.", 336, dy0 + 78, 14, "t2")
           + prop + acc2 + btn + acc)
    conv.append(g("dec", dec, show(T_DEC, dy=16, dur=.55), static="opacity:1"))
    # Claude Code's message with a streaming status line
    ay = 604
    tag, tagw = agent_tag(316 + width("Claude Code", 14, 600) + 8, ay + 9, 11.5)
    k_faces = [("hello", [(T_AGENT + .7, {"o": 1}), (T_AGENT + .8, {"o": 0})]),
               ("working", [(T_AGENT + .7, {"o": 0}), (T_AGENT + .8, {"o": 1}), (T_POSITIVE, {"o": 1}), (T_POSITIVE + .1, {"o": 0})]),
               ("done", [(T_POSITIVE, {"o": 0}), (T_POSITIVE + .1, {"o": 1})])]
    head = (text("Claude Code", 316, ay + 14, 14, "t1", 600) + tag
            + text("for Ada", 316 + width("Claude Code", 14, 600) + 16 + tagw, ay + 14, 12.5, "t3"))
    lines = [("Reading soil data from 12 beds…", T_AGENT + .9, T_AGENT + 1.95),
             ("Writing the result in the Wiki…", T_AGENT + 2.05, T_RESULT + .5),
             ("Recorded a positive result for #12", T_POSITIVE + .05, None)]
    stream = ""
    for i, (s, t0, t1) in enumerate(lines):
        w = width(s, 14)
        n = len(s)
        body = text(s, 316, ay + 40, 14, "t2" if i < 2 else "t1", 400 if i < 2 else 500)
        # the typing: a cover the colour of the panel slides off the text in character steps
        cover = g(f"cov{i}", f'<rect x="314" y="{ay + 24}" width="{w + 16:.1f}" height="22" fill="var(--bg)"/>'
                  f'<rect x="314" y="{ay + 26}" width="2" height="18" rx="1" fill="var(--t1)"/>',
                  [(t0, {"x": 0}), (t0 + min(.9, n * .03), {"x": round(w + 4, 1), "ease": f"steps({n})"})],
                  static="opacity:0")
        fr = [(t0 - .01, {"o": 0}), (t0, {"o": 1})] + ([(t1, {"o": 1}), (t1 + .15, {"o": 0})] if t1 else [])
        stream += g(f"line{i}", body + cover, fr, static="opacity:1" if i == 2 else "opacity:0")
    agent = (g("kpop", kreska_faces(-16, -16, 32, k_faces, "kc"),
               [(T_AGENT, {"o": 0, "s": .4}), (T_AGENT + .45, {"o": 1, "s": 1, "ease": SPRING})], static="opacity:1",
               at=(290, ay + 16))
             + g("ahead", head, show(T_AGENT + .15, dy=8), static="opacity:1") + stream)
    conv.append(agent)
    scroll = [(T_AGENT - .3, {"y": 0}), (T_AGENT + .25, {"y": -64, "ease": EASE})]
    world.append('<g clip-path="url(#streamclip)">'
                 + g("stream", g("scroll", "".join(conv), scroll, static="transform:translate(0,-64px)"),
                     [(T_MAP, {"o": 1, "x": 0}), (T_MAP + .3, {"o": 0, "x": -40})], static="opacity:0")
                 + "</g>")
    # composer
    world.append(g("composer", card(272, 640, 580, 52, 16) + text("Message · @ mention · / actions", 292, 671, 14, "t3")
                   + '<circle cx="826" cy="666" r="15" fill="var(--own)"/>'
                   + '<path d="M826 673v-13M820.5 665.5 826 660l5.5 5.5" fill="none" stroke="var(--t1)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
                   [(T_MAP, {"o": 1}), (T_MAP + .4, {"o": 0})], static="opacity:0"))

    # ---- the Wiki panel
    wx, wy = 868, 86
    wiki = [card(wx, wy, 302, 608, 18),
            text("Wiki", wx + 20, wy + 30, 12.5, "t3", 500),
            text("Sensor plan", wx + 20, wy + 60, 19, "t1", 600),
            text("Edited by Ada · 10:30", wx + 20, wy + 82, 12.5, "t3"),
            text("Twelve raised beds, six sensors.", wx + 20, wy + 116, 14, "t2"),
            text("Where they go depends on how", wx + 20, wy + 138, 14, "t2"),
            text("dry each bed is.", wx + 20, wy + 160, 14, "t2"),
            text("Findings", wx + 20, wy + 198, 15, "t1", 600)]
    wiki.append(g("wkwrite", kreska(wx + 254, wy + 182, 24, "writing"),
                  [(T_AGENT + 2.05, {"o": 0, "s": .5}), (T_AGENT + 2.35, {"o": 1, "s": 1, "ease": SPRING}),
                   (T_POSITIVE + .2, {"o": 1}), (T_POSITIVE + .4, {"o": 0})], pivot=(wx + 266, wy + 194)))
    wiki.append(g("wkempty", text("No results yet.", wx + 20, wy + 224, 14, "t3"), swap(T_RESULT - .1), static="opacity:0"))
    rx_, ry_ = wx + 14, wy + 210
    res_pend = g("rpend", glyph_open(rx_ + 262 - 18 - width("Recording", 13, 500) - 12, ry_ + 22, 7)
                 + text("Recording", rx_ + 262 - 16, ry_ + 27, 13, "t3", 500, anchor="end"), swap(T_POSITIVE), static="opacity:0")
    res_pos = g("rpos", glyph_done(-width("Positive", 13.5, 600) - 14, -4, 8) + text("Positive", 0, 1, 13.5, "t1", 600, anchor="end"),
                [(T_POSITIVE, {"o": 0, "s": .7}), (T_POSITIVE + .4, {"o": 1, "s": 1, "ease": SPRING})], static="opacity:1",
                at=(rx_ + 262 - 16, ry_ + 26))
    result = (card(rx_, ry_, 274, 112, 14, fill="bg", shadow=None)
              + f'<rect x="{rx_}" y="{ry_}" width="274" height="112" rx="14" fill="none" stroke="var(--line2)"/>'
              + text("Result · #12", rx_ + 16, ry_ + 27, 12.5, "t3", 500)
              + res_pend + res_pos
              + text("Soil moisture in all 12 beds", rx_ + 16, ry_ + 56, 15, "t1", 600)
              + text("4 beds are dry; 8 are fine.", rx_ + 16, ry_ + 78, 13.5, "t2")
              + kreska(rx_ + 16, ry_ + 87, 16, "done") + text("Claude Code · for Ada", rx_ + 38, ry_ + 100, 12, "t3"))
    wiki.append(g("result", result, show(T_RESULT, dy=14, dur=.5), static="opacity:1"))
    nxt = (text("Next", wx + 20, wy + 360, 15, "t1", 600) + glyph_open(wx + 28, wy + 384, 7)
           + text("Order sensors for the 4 dry beds", wx + 42, wy + 389, 14, "t2"))
    wiki.append(g("wnext", nxt, show(T_POSITIVE + .45, dy=8), static="opacity:1"))
    world.append(g("wiki", "".join(wiki), [(T_MAP, {"o": 1, "x": 0}), (T_MAP + .3, {"o": 0, "x": 40})], static="opacity:0"))

    # ---- the Map
    mp = ['<rect x="246" y="72" width="942" height="636" fill="url(#dots)"/>']
    nodes = [  # id, x, y, w, kind line, title, glyph
        ("n1", 300, 150, 300, "Message · Jonas", "Should we measure soil moisture first?", "jb"),
        ("n2", 700, 150, 300, "#12 · Done · Claude Code", "Measure soil moisture first", "done"),
        ("n3", 300, 400, 300, "Decision · Accepted", "Measure moisture before buying sensors", "done"),
        ("n4", 700, 400, 300, "Result · positive", "Soil moisture in all 12 beds", "done"),
    ]
    links = [("l1", "M600 186C650 186 650 186 700 186"), ("l2", "M450 222C450 320 380 300 380 400"),
             ("l3", "M850 222C850 320 780 300 780 400"), ("l4", "M600 436C650 436 650 436 700 436")]
    for i, (lid, d) in enumerate(links):
        mp.append(g(lid, f'<path d="{d}" pathLength="1" stroke-dasharray="1 1" fill="none" stroke="var(--t3)" stroke-width="1.6"/>',
                    [(T_MAP + .7 + i * .15, {"o": 1, "d": 1}), (T_MAP + 1.2 + i * .15, {"d": 0, "ease": OUT})],
                    static="opacity:1;stroke-dashoffset:0"))
    for i, (nid, x, y, w, kind, title, gk) in enumerate(nodes):
        lead = avatar(x + 26, y + 46, 10, "JB") if gk == "jb" else glyph_done(x + 26, y + 46, 8)
        body = (card(x, y, w, 72, 16) + text(kind, x + 18, y + 26, 12.5, "t3", 500) + lead
                + text(title, x + 42, y + 51, 14.5 if len(title) < 34 else 13.5, "t1", 600))
        mp.append(g(nid, body, [(T_MAP + .35 + i * .12, {"o": 0, "s": .9}),
                                (T_MAP + .8 + i * .12, {"o": 1, "s": 1, "ease": SPRING})], static="opacity:1",
                    pivot=(x + w / 2, y + 36)))
    # the result node lights up: an inverted copy over it, with a soft ring
    x, y, w = 700, 400, 300
    lit = (f'<rect x="{x}" y="{y}" width="{w}" height="72" rx="16" fill="var(--inv)"/>'
           + text("Result · positive", x + 18, y + 26, 12.5, "oninv", 500) + glyph_done(x + 26, y + 46, 8, ink="inv")
           .replace('fill="var(--t1)"', 'fill="var(--oninv)"')
           + text("Soil moisture in all 12 beds", x + 42, y + 51, 14.5, "oninv", 600))
    mp.append(g("lit", lit, [(T_MAP + 1.45, {"o": 0}), (T_MAP + 1.75, {"o": 1, "ease": OUT})], static="opacity:1"))
    mp.append(g("ring", f'<rect x="-156" y="-42" width="312" height="84" rx="22" fill="none" stroke="var(--t1)" stroke-width="2"/>',
                [(T_MAP + 1.5, {"o": 0, "s": 1}), (T_MAP + 1.6, {"o": .5}), (T_MAP + 2.3, {"o": 0, "s": 1.12, "ease": OUT})],
                at=(850, 436)))
    mp.append(g("mapbadge", f'<rect x="742" y="370" width="{width("Claude Code is linking", 12, 500) + 40:.1f}" height="24" rx="12" fill="var(--inv)"/>'
                + kreska(748, 374, 16).replace('stroke="var(--t1)"', 'stroke="var(--oninv)"').replace('fill="var(--el)"', 'fill="var(--inv)"')
                + text("Claude Code is linking", 770, 386.5, 12, "oninv", 500),
                show(T_MAP + 1.1, T_MAP + 1.45, dy=6, out=.2)))
    world.append(g("map", "".join(mp), [(T_MAP + .2, {"o": 0}), (T_MAP + .5, {"o": 1})], static="opacity:1"))

    # ---- the cursor (world space) and its click ripples
    c_task = (tbx + 54, tby + 17)               # the make-task button
    c_acc = (788, dy0 + 106 - 64 + 64)          # Accept, before the scroll
    cur = g("cursor", POINTER,
            [(T_TASK - 1.1, {"o": 0, "x": c_task[0] - 120, "y": c_task[1] + 150}),
             (T_TASK - .85, {"o": 1}),
             (T_TASK - .05, {"x": c_task[0], "y": c_task[1], "s": 1, "ease": EASE}),
             (T_TASK + .05, {"s": .85}), (T_TASK + .2, {"s": 1}),
             (T_ACCEPT - .9, {"x": c_task[0], "y": c_task[1]}),
             (T_ACCEPT - .05, {"x": c_acc[0] + 4, "y": c_acc[1] + 4, "s": 1, "ease": EASE}),
             (T_ACCEPT + .05, {"s": .85}), (T_ACCEPT + .2, {"s": 1}),
             (T_ACCEPT + .45, {"o": 1, "x": c_acc[0] + 4, "y": c_acc[1] + 4}),
             (T_ACCEPT + .8, {"o": 0, "x": c_acc[0] + 60, "y": c_acc[1] + 90})], static="opacity:0")
    rip = lambda name, t, at: g(name, '<circle r="14" fill="none" stroke="var(--t1)" stroke-width="2"/>',
                                [(t, {"o": 0, "s": .3}), (t + .02, {"o": .5}), (t + .5, {"o": 0, "s": 1.6, "ease": OUT})], at=at)
    world.append(rip("rip1", T_TASK, c_task) + rip("rip2", T_ACCEPT, c_acc) + cur)

    # ---- the phone (to the right of the window)
    px, py, pw, ph = 1012, 56, 320, 640
    phone = [f'<rect x="{px}" y="{py}" width="{pw}" height="{ph}" rx="46" fill="var(--bg)" filter="url(#pop)"'
             f' stroke="var(--line2)" stroke-width="3"/>',
             text("9:41", px + 34, py + 40, 15, "t1", 600),
             text("Inbox", px + 22, py + 96, 30, "t1", 600),
             text("1 needs you", px + 30 + width("Inbox", 30, 600), py + 96, 15, "t3"),
             f'<rect x="{px + 22}" y="{py + 114}" width="{width("All · 2", 14, 500) + 28:.1f}" height="32" rx="16" fill="var(--inv)"/>',
             text("All · 2", px + 36, py + 135, 14, "oninv", 500)]
    xx = px + 22 + width("All · 2", 14, 500) + 36
    for lab in ("Decisions", "Questions"):
        ww = width(lab, 14, 500) + 28
        phone.append(f'<rect x="{xx:.1f}" y="{py + 114}" width="{ww:.1f}" height="32" rx="16" fill="var(--sub)"/>'
                     + text(lab, xx + 14, py + 135, 14, "t2", 500))
        xx += ww + 8
    cx_, cy_ = px + 16, py + 164
    ptag, ptw = agent_tag(cx_ + 62 + width("Claude Code", 15, 600) + 8, cy_ + 30, 11.5)
    item = (card(cx_, cy_, pw - 32, 214, 20) + kreska(cx_ + 18, cy_ + 16, 34, "waiting" if False else "idle")
            + text("Claude Code", cx_ + 62, cy_ + 35, 15, "t1", 600) + ptag
            + text("Result · Community garden", cx_ + 62, cy_ + 55, 12.5, "t3")
            + text("4 beds are dry. Order", cx_ + 18, cy_ + 96, 18, "t1", 600)
            + text("4 sensors for them?", cx_ + 18, cy_ + 120, 18, "t1", 600)
            + f'<rect x="{cx_ + 18}" y="{cy_ + 136}" width="{width("Needs you", 12, 600) + 22:.1f}" height="24" rx="12" fill="var(--inv)"/>'
            + text("Needs you", cx_ + 29, cy_ + 152.5, 12, "oninv", 600)
            + f'<rect x="{cx_ + 18}" y="{cy_ + 170}" width="{(pw - 32 - 46) / 2:.1f}" height="34" rx="10" fill="var(--inv)"/>'
            + text("Accept", cx_ + 18 + (pw - 32 - 46) / 4, cy_ + 192, 14, "oninv", 500, anchor="middle")
            + text("Not now", cx_ + 28 + (pw - 32 - 46) * .75, cy_ + 192, 14, "t2", 500, anchor="middle"))
    phone.append(g("pitem", item, show(T_PHONE + .45, dy=16, dur=.5), static="opacity:1"))
    item2 = (card(cx_, cy_ + 228, pw - 32, 96, 20) + avatar(cx_ + 34, cy_ + 262, 16, "JB")
             + text("Jonas mentioned you", cx_ + 62, cy_ + 266, 14.5, "t1", 600)
             + text("“Can we put one by the shed?”", cx_ + 18, cy_ + 306, 14, "t2"))
    phone.append(g("pitem2", item2, show(T_PHONE + .6, dy=16, dur=.5), static="opacity:1"))
    by_ = py + ph - 74
    phone.append(card(px + 16, by_, pw - 32, 56, 28))
    for i, (ic, lab) in enumerate([("home", "Home"), ("projects", "Projects"), ("inbox", "Inbox")]):
        bx_ = px + 16 + (pw - 32) * (i + .5) / 3
        if lab == "Inbox":
            phone.append(f'<rect x="{bx_ - 44:.1f}" y="{by_ + 5}" width="88" height="46" rx="23" fill="var(--sub)"/>')
        phone.append(icon(ic, bx_ - 9, by_ + 9, 18, "t1") + text(lab, bx_, by_ + 44, 11.5, "t1", 500, anchor="middle"))
    world.append(g("phone", "".join(phone), [(T_PHONE, {"o": 0, "x": 320}), (T_PHONE + .8, {"o": 1, "x": 0, "ease": OUT})],
                   static="opacity:1"))

    # ---- camera
    j_focus = cam(562, 318, 1.45)
    camera = [(0, FULL), (T_ARRIVE + .55, FULL),
              (T_ARRIVE + 1.4, {**j_focus, "ease": EASE}),
              (T_TASK + .55, j_focus),
              (T_DEC + .55, {**cam(584, 494, 1.62), "ease": EASE}),
              (T_ACCEPT + .55, cam(584, 494, 1.62)),
              (T_AGENT + .4, {**cam(565, 468, 1.5), "ease": EASE}),
              (T_AGENT + 1.9, cam(565, 468, 1.5)),
              (T_RESULT, {**cam(722, 410, 1.04), "ease": EASE}),
              (T_POSITIVE + .65, cam(726, 410, 1.06)),
              (T_MAP + .25, {**cam(605, 362, .78), "ease": EASE}),
              (T_PHONE - .1, cam(612, 362, .8)),
              (T_PHONE + .8, {**cam(665, 360, .69), "ease": EASE}),
              (T, cam(665, 360, .69))]
    world_g = g("cam", "".join(world), camera, static="opacity:1")

    # ---- the intro (frame space): Kreska draws itself, the wordmark, then both fly into the sidebar
    lg, wm = 92, 66
    wmw = width("flux", wm, 600)
    gap = 22
    row = lg + gap + wmw
    lx, ly = W / 2 - row / 2, H / 2 - lg / 2
    shift = (row - lg) / 2
    k = lg / 24
    eyes, brow, _ = FACES["idle"]
    draw = g("tline", f'<path d="{TILE}" pathLength="1" fill="none" stroke="var(--inv)" stroke-width="1.1" stroke-dasharray="1 1"/>',
             [(.1, {"o": 0, "d": 1}), (.15, {"o": 1}), (.95, {"d": 0, "ease": OUT}), (1.2, {"o": 1}), (1.35, {"o": 0})],
             static="opacity:0")
    fill = g("tfill", f'<path d="{TILE}" fill="var(--inv)"/>', [(.75, {"o": 0}), (1.1, {"o": 1, "ease": OUT})], static="opacity:1")
    facein = (f'<g transform="translate(12 12) scale(1.14) translate(-12 -12.4)" fill="none" stroke="var(--oninv)" stroke-linecap="round">'
              + g("ieyes", f'<path d="{eyes}" stroke-width="2.2"/>',
                  [(1.0, {"o": 0}), (1.25, {"o": 1, "ease": OUT}), (1.85, {"o": 1}), (1.9, {"o": .0}), (1.98, {"o": 1})], static="opacity:1")
              + g("ibrow", f'<path d="{brow}" pathLength="1" stroke-dasharray="1 1" stroke-width="1.7"/>',
                  [(1.1, {"o": 0, "d": 1}), (1.15, {"o": 1}), (1.45, {"d": 0, "ease": OUT})], static="opacity:1;stroke-dashoffset:0")
              + "</g>")
    ilogo = g("ilogo", f'<g transform="translate({lx:.1f} {ly:.1f}) scale({k:.4f})">{draw}{fill}{facein}</g>',
              [(0, {"x": shift}), (1.2, {"x": shift}), (1.7, {"x": 0, "ease": EASE})], static="opacity:1")
    iword = g("iword", text("flux", lx + lg + gap, H / 2 + wm * .36, wm, "t1", 600),
              [(1.4, {"o": 0, "x": 10}), (1.85, {"o": 1, "x": 0, "ease": OUT})], static="opacity:1")
    # fly: map the intro row onto the sidebar logo (world 22,20 size 28) under the FULL camera
    zf = FULL["s"]
    target_x, target_y = FULL["x"] + zf * 22, FULL["y"] + zf * 20
    sc = 28 * zf / lg
    fly = {"x": round(target_x - sc * lx, 1), "y": round(target_y - sc * ly, 1), "s": round(sc, 4)}
    intro = g("intro", ilogo + iword,
              [(0, {"o": 1, "x": 0, "y": 0, "s": 1}), (2.05, {"o": 1, "x": 0, "y": 0, "s": 1}),
               (2.75, {**fly, "o": 1, "ease": EASE}), (2.85, {"o": 0})], static="opacity:0")
    scrim = g("scrim", f'<rect width="{W}" height="{H}" fill="var(--bg)"/>',
              [(0, {"o": 1}), (2.1, {"o": 1}), (2.75, {"o": 0, "ease": EASE}),
               (T_END - .15, {"o": 0}), (T_END + .45, {"o": .94, "ease": EASE})], static="opacity:1")

    # ---- the end line (also the reduced-motion frame)
    el, ew = 48, 42
    eww = width("flux", ew, 600)
    erow = el + 14 + eww
    ex = W / 2 - erow / 2
    end = (g("e1", logo(ex, 128, el) + text("flux", ex + el + 14, 128 + el / 2 + ew * .36, ew, "t1", 600),
             show(T_END + .2, T - .45, dy=12, dur=.5, out=.35), static="opacity:1")
           + g("e2", text("People and agents, one project.", W / 2, 278, 46, "t1", 600, anchor="middle"),
               show(T_END + .35, T - .45, dy=12, dur=.55, out=.35), static="opacity:1")
           + g("e3", text("Open source · self-hosted · your own agents", W / 2, 326, 21, "t3", anchor="middle"),
               show(T_END + .5, T - .45, dy=12, dur=.55, out=.35), static="opacity:1"))
    return world_g + scrim + intro + end


def svg(theme: str) -> str:
    FONTS_USED.clear()
    body = build()
    tk = THEMES[theme]
    tokens = ";".join(f"--{k}:{v}" for k, v in tk.items() if not k.startswith("sh") and k not in ("g1", "g2"))
    defs = (f'<filter id="sh" x="-20%" y="-50%" width="140%" height="220%">'
            f'<feDropShadow dx="0" dy="1" stdDeviation="1" flood-color="#000" flood-opacity="{tk["sh1"]}"/>'
            f'<feDropShadow dx="0" dy="5" stdDeviation="6" flood-color="#000" flood-opacity="{tk["sh2"]}"/></filter>'
            f'<filter id="pop" x="-10%" y="-10%" width="120%" height="130%">'
            f'<feDropShadow dx="0" dy="1" stdDeviation="1" flood-color="#000" flood-opacity="{tk["sh1"]}"/>'
            f'<feDropShadow dx="0" dy="12" stdDeviation="15" flood-color="#000" flood-opacity="{tk["sh3"]}"/></filter>'
            f'<linearGradient id="own" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{tk["g1"]}"/>'
            f'<stop offset="1" stop-color="{tk["g2"]}"/></linearGradient>'
            '<pattern id="dots" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="11" cy="11" r="1.1" fill="var(--dot)"/></pattern>'
            '<clipPath id="streamclip"><rect x="244" y="71" width="616" height="563"/></clipPath>')
    glyphs = "".join(f.defs() for f in FONTS_USED.values())
    css = (f":root{{{tokens}}}"
           f".a{{animation-duration:{T:g}s;animation-iteration-count:infinite;animation-fill-mode:both;"
           "transform-box:view-box;transform-origin:0 0}"
           + "".join(CSS)
           + "@media (prefers-reduced-motion:reduce){.a{animation:none!important}}")
    title = "Flux: people and agents, one project"
    desc = ("A short animation of a Flux project, Community garden sensors. Jonas asks: Should we measure soil moisture "
            "first? Ada turns the message into task #12 and accepts the decision Measure moisture before buying "
            "sensors. Kreska, as the agent Claude Code, picks up the task, reads the beds and writes a positive result "
            "into the Wiki. The Map links the message, task, decision and result, and a phone shows the same work in "
            "the Inbox. It ends on: People and agents, one project. Open source, self-hosted, your own agents.")
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img"'
            f' aria-labelledby="t d"><title id="t">{title}</title><desc id="d">{desc}</desc>'
            f'<style>{css}</style><defs>{defs}{glyphs}</defs>'
            f'<clipPath id="frame"><rect width="{W}" height="{H}" rx="24"/></clipPath>'
            f'<g clip-path="url(#frame)"><rect width="{W}" height="{H}" fill="var(--bg)"/>{body}</g></svg>\n')


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for theme in THEMES:
        path = OUT_DIR / f"flux-promo-{theme}.svg"
        path.write_text(svg(theme), encoding="utf-8")
        print(f"{path.relative_to(ROOT)}: {path.stat().st_size} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
