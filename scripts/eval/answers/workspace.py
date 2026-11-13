#!/usr/bin/env python3
"""The answer-accuracy evaluation's workspace (#1295): the retrieval bench's 10,000 messages (scripts/eval/retrieval/seed.py) plus
workspace.json (Wiki pages, tasks with discussions, decisions, maps, files and messages at ages relative to the run) and the questions
of questions.json, written as one JSON file that app/tests/app/ai-eval.check.ts loads into a real Flux.

Dates: the bench's messages keep their dates moved forward by whole weeks since 2026-11-13 (the day the evaluation was written), so a
weekday stays a weekday and the newest bench message stays a few days old; the relative-date facts are placed from the run's own day.

  python3 workspace.py --out out/eval-seed.json [--today 2026-11-13]

Standard library only. Deterministic for a given --today.
"""
import argparse
import base64
import datetime as dt
import io
import json
import random
import re
import sys
import unicodedata
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "retrieval"))
import seed  # noqa: E402  the bench's generator

ANCHOR = dt.date(2026, 11, 13)
WINDOW = 20  # MESSAGE_WINDOW of packages/core/src/personal-runs/brief-facts.ts
MONTH_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
MONTH_PL_GEN = ["stycznia", "lutego", "marca", "kwietnia", "maja", "czerwca", "lipca", "sierpnia", "września", "października", "listopada", "grudnia"]


def fold(text):
    text = text.replace("ł", "l").replace("Ł", "L")
    return "".join(c for c in unicodedata.normalize("NFD", text) if unicodedata.category(c) != "Mn").lower()


def month_back(today, offset):
    index = today.year * 12 + today.month - 1 + offset
    return index // 12, index % 12 + 1


def when(spec, now, today):
    hour, minute = (int(part) for part in spec.get("time", "12:00").split(":"))
    if "days_ago" in spec:
        day = today - dt.timedelta(days=spec["days_ago"])
    elif "month_offset" in spec:
        year, month = month_back(today, spec["month_offset"])
        day = dt.date(year, month, spec["day"])
    elif "last_week_day" in spec:
        day = today - dt.timedelta(days=today.weekday() + 7 - spec["last_week_day"])
    else:
        raise SystemExit(f"no time in {spec}")
    moment = dt.datetime(day.year, day.month, day.day, hour, minute)
    if moment >= now:
        raise SystemExit(f"{spec} is not in the past")
    return moment


def iso(moment):
    return moment.replace(microsecond=0).isoformat() + "Z"


# --- Files: real bytes of each format, with the facts only inside.

def pdf(lines):
    """A one-page PDF 1.4 with a text layer (Helvetica, WinAnsi): what a text extractor reads."""
    def esc(text):
        return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    stream = "BT /F1 12 Tf 56 760 Td 16 TL " + " ".join(f"({esc(line)}) Tj T*" for line in lines) + " ET"
    objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
               "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
               "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
               f"<< /Length {len(stream.encode('latin-1'))} >>\nstream\n{stream}\nendstream"]
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(out.tell())
        out.write(f"{number} 0 obj\n{body}\nendobj\n".encode("latin-1"))
    xref = out.tell()
    out.write(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode())
    for offset in offsets:
        out.write(f"{offset:010d} 00000 n \n".encode())
    out.write(f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return out.getvalue()


def docx(paragraphs):
    """A minimal Word document: the three parts Word itself needs."""
    def esc(text):
        return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    body = "".join(f"<w:p><w:r><w:t xml:space=\"preserve\">{esc(p)}</w:t></w:r></w:p>" for p in paragraphs)
    parts = {
        "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        "_rels/.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        "word/document.xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f"<w:body>{body}</w:body></w:document>",
    }
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, text in parts.items():
            info = zipfile.ZipInfo(name, date_time=(2026, 11, 1, 12, 0, 0))
            archive.writestr(info, text)
    return out.getvalue()


STREETS = ["al. Zwycięstwa", "ul. Kartuska", "ul. Słowackiego", "ul. Chłopska", "al. Rzeczypospolitej", "ul. Obrońców Wybrzeża", "ul. Pomorska",
           "ul. Kołobrzeska", "ul. Startowa", "ul. Wita Stwosza", "ul. Jaśkowa Dolina", "ul. Hallera", "ul. Partyzantów", "ul. Kościuszki"]


def file_bytes(spec, today, rng):
    kind = spec["type"]
    if kind == "pdf":
        return pdf(spec["lines"]), "application/pdf"
    if kind == "md":
        return spec["text"].encode(), "text/markdown"
    if kind == "docx":
        return docx(spec["paragraphs"]), "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    if kind == "csv_measurements":
        rows = ["data;godzina;temp_oslony_c;wilgotnosc_pct;bateria_v"]
        start = today - dt.timedelta(days=48)
        peak_day = rng.randrange(5, 25)
        for n in range(30):
            day = start + dt.timedelta(days=n)
            temp = spec["peak"] if n == peak_day else f"{rng.uniform(6, 33):.1f}"
            volts = f"{rng.uniform(3.55, 4.1):.2f}".replace(".", ",")
            rows.append(f"{day.isoformat()};13:00;{temp.replace('.', ',')};{rng.randrange(55, 96)};{volts}")
        return ("\n".join(rows) + "\n").encode(), "text/csv"
    if kind == "csv_stations":
        rows = ["stacja,adres,przystanek,zamontowana"]
        for n in range(401, 461):
            station = f"ST-{n:04d}"
            address = spec["address"] if station == spec["station"] else f"{rng.choice(STREETS)} {rng.randrange(1, 140)}"
            stop = rng.choice(seed.SLOTS["stop_nom"])
            rows.append(f"{station},{address},{stop},{(today - dt.timedelta(days=rng.randrange(60, 200))).isoformat()}")
        return ("\n".join(rows) + "\n").encode(), "text/csv"
    raise SystemExit(f"unknown file type {kind}")


def render(text, today):
    def month(match):
        kind, offset = match.group(1), int(match.group(2))
        _, number = month_back(today, offset)
        return (MONTH_EN if kind == "month_en" else MONTH_PL_GEN)[number - 1]
    return re.sub(r"\{(month_en|month_pl_gen):(-?\d+)\}", month, text)


def build(today, now):
    spec = json.loads((HERE / "workspace.json").read_text())
    asked = json.loads((HERE / "questions.json").read_text())
    rng = random.Random(f"1295-{today.isoformat()}")
    bench = seed.build(10_000, 1242)
    shift = dt.timedelta(days=max(0, (today - ANCHOR).days) // 7 * 7)
    people = [{"key": p["key"], "name": p["name"], "role": p["role"]} for p in bench["people"]]
    people += [{"key": k, "name": n, "role": r} for k, (n, r) in spec["people"].items()]
    spaces = [{"key": s["key"], "name": s["name"], "visibility": s["visibility"], "grants": s["grants"]} for s in bench["spaces"]]
    spaces += [{"key": k, "name": n, "visibility": v, "grants": g} for k, (n, v, g) in spec["spaces"].items()]
    conversations = [{"key": c["key"], "space": c["space"]} for c in bench["conversations"]]

    messages = []
    for m in bench["messages"]:
        if m["fact"] in ("ovh_password",):
            continue  # the bench's deletion probe: a password nobody would leave in a real space
        at = dt.datetime.fromisoformat(m["at"].rstrip("Z")) + shift
        messages.append({"conv": m["conversation"], "author": m["author"], "at": at, "body": m["body"], "key": m["fact"]})
    for t in spec["timed_messages"]:
        messages.append({"conv": t["conv"], "author": t["author"], "at": when(t["when"], now, today), "body": t["text"], "key": t["key"]})
    week_start = dt.datetime.combine(today - dt.timedelta(days=today.weekday()), dt.time())
    for f in spec["fillers"]:
        frng = random.Random(f"filler-{f['seed']}")
        lo = max(week_start, now - dt.timedelta(days=4))
        hi = now - dt.timedelta(minutes=30)
        if (hi - lo).total_seconds() < 3600:
            lo = hi - dt.timedelta(hours=1)
        authors = [a for a, w in seed.CONVERSATIONS[f["conv"]][3].items() for _ in range(w)]
        for _ in range(f["count"]):
            text, _lang = seed.chatter(frng, f["space"], frng.random() < seed.CONVERSATIONS[f["conv"]][2])
            at = lo + dt.timedelta(seconds=frng.uniform(0, (hi - lo).total_seconds()))
            messages.append({"conv": f["conv"], "author": frng.choice(authors), "at": at.replace(microsecond=0), "body": text, "key": None})
    files = {}
    for f in spec["files"]:
        data, content_type = file_bytes(f, today, rng)
        files[f["key"]] = {"name": f["name"], "contentType": content_type, "base64": base64.b64encode(data).decode(), "bytes": len(data)}
        messages.append({"conv": f["conv"], "author": f["author"], "at": when(f["when"], now, today), "body": f["message"], "key": f"file:{f['key']}", "file": f["key"]})
    messages.sort(key=lambda m: (m["conv"], m["at"]))
    by_conv = {}
    for m in messages:
        by_conv.setdefault(m["conv"], []).append(m)
    for conv, rows in by_conv.items():
        for m in rows[-WINDOW:]:
            m["inWindow"] = True
    for m in messages:
        m["at"] = iso(m["at"])

    tasks = []
    for t in spec["tasks"]:
        discussion = [{"key": d["key"], "author": d["author"], "at": iso(when({"days_ago": d["days_ago"], "time": "10:00"}, now, today)), "body": d["text"]} for d in t["discussion"]]
        tasks.append({**{k: v for k, v in t.items() if k != "discussion"}, "discussion": discussion})

    # Every source a gold names must exist, and nothing in the workspace may answer a no-answer question.
    known = {f"message:{m['key']}" for m in messages if m["key"] and not m["key"].startswith("file:")}
    known |= {f"doc:{d['key']}" for d in spec["docs"]} | {f"task:{t['key']}" for t in spec["tasks"]} | {f"decision:{d['key']}" for d in spec["decisions"]}
    known |= {f"thought:{th['key']}" for m in spec["maps"] for th in m["thoughts"]} | {f"file:{k}" for k in files}
    known |= {f"message:{d['key']}" for t in tasks for d in t["discussion"]}
    texts = [m["body"] for m in messages] + [d["title"] + " " + d["body"] for d in spec["docs"]] + [t["title"] for t in tasks]
    texts += [d["body"] for t in tasks for d in t["discussion"]] + [d["title"] + " " + d["rationale"] for d in spec["decisions"]]
    texts += [th["text"] for m in spec["maps"] for th in m["thoughts"]] + [m["title"] for m in spec["maps"]]
    texts += [base64.b64decode(f["base64"]).decode("utf-8", "replace") for f in files.values() if not f["contentType"].endswith("document")]
    folded = [fold(t) for t in texts]
    in_window = {f"message:{m['key']}" for m in messages if m.get("inWindow") and m["key"]}
    questions = []
    for q in asked["questions"]:
        for source in q["gold"]:
            if source not in known:
                raise SystemExit(f"{q['id']}: unknown gold source {source}")
        if q.get("absent"):
            hits = [t for t in folded if re.search(q["absent"], t)]
            if hits:
                raise SystemExit(f"{q['id']}: the workspace answers a no-answer question: {hits[:3]}")
        questions.append({**q, "question": render(q["question"], today), "goldInWindow": [s for s in q["gold"] if s in in_window]})

    return {
        "generatedFor": "#1295 answer-accuracy evaluation", "today": today.isoformat(), "now": iso(now), "shiftDays": shift.days, "window": WINDOW,
        "workspace": {"name": bench["workspace"]["name"]}, "people": people, "spaces": spaces, "conversations": conversations,
        "messages": messages, "docs": spec["docs"], "tasks": tasks, "decisions": spec["decisions"], "maps": spec["maps"], "files": files,
        "questions": questions,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(HERE / "out" / "eval-seed.json"))
    parser.add_argument("--today", default=None, help="the run's day (UTC), YYYY-MM-DD; default today")
    args = parser.parse_args()
    now = dt.datetime.now(dt.timezone.utc).replace(tzinfo=None, microsecond=0)
    today = dt.date.fromisoformat(args.today) if args.today else now.date()
    if args.today:
        now = dt.datetime.combine(today, dt.time(18, 0))
    data = build(today, now)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(data, ensure_ascii=False))
    counts = {}
    for q in data["questions"]:
        counts[q["category"]] = counts.get(q["category"], 0) + 1
    print(f"today {data['today']} · shift {data['shiftDays']} days · messages {len(data['messages'])} · docs {len(data['docs'])} · tasks {len(data['tasks'])} · "
          f"decisions {len(data['decisions'])} · maps {len(data['maps'])} · files {len(data['files'])} · questions {len(data['questions'])} {counts} · out {args.out}")


if __name__ == "__main__":
    main()
