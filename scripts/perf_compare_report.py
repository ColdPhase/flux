#!/usr/bin/env python3
"""The comparison table of a scripts/perf_compare.sh run.

Usage: perf_compare_report.py OUT_DIR

Reads OUT_DIR/meta.json and, for the base (a) and the head (b), every round's measure.jsonl and extra.jsonl (paired with the API's
log by request id, as scripts/perf_report.py pairs them), idle.json, the memory samples, browser.json, and bundle.txt. Each metric is
computed per round; the table gives the median over the rounds with the lowest and highest round in brackets, the change from base
to head, the budget (docs/development/performance-2026-11.md, #862) and a verdict:

- BREACH: the head is over its budget (`also at base` when the base was too);
- regression: the head is more than 10 % worse and the rounds' ranges do not overlap; `regression?` when they overlap (noise is
  possible); changes smaller than the metric's floor (2 ms, 1 statement or request, 2 KB, 10 MiB) are never called a change;
- better / same.

Writes OUT_DIR/compare.json beside the Markdown on stdout.
"""

from __future__ import annotations

import gzip
import json
import math
import re
import statistics
import sys
from pathlib import Path

SHELL = {"me", "workspaces", "projects", "dms", "inbox dot", "live capabilities"}
SPACE_SHELL = {"project", "project people", "project sketches", "project docs", "work summary", "needs you"}
CONVERSATION = {"conversation roots", "task notices", "materials", "members", "assistant runs", "root work associations", "notice reference rows"}
HOME = {"since you left", "assistant"}
GROUP_ORDER = ["Shell", "Space shell", "Home", "Conversation", "Thread", "Tasks", "Map", "Wiki", "Inbox", "Search box", "Link picker"]
PHASES = ["warm @2 vcpu", "concurrent @2 vcpu", "warm @1.0 cpu", "warm (member) @1.0 cpu", "concurrent @1.0 cpu"]
TARGET_P95 = 50


def group_of(label: str) -> str:
    if label in SHELL:
        return "Shell"
    if label in SPACE_SHELL:
        return "Space shell"
    if label in HOME:
        return "Home"
    if label in CONVERSATION:
        return "Conversation"
    if label == "thread":
        return "Thread"
    if label.startswith(("work view", "work relations")):
        return "Tasks"
    if label in ("sketch list", "sketch") or label.startswith("thought tasks"):
        return "Map"
    if label == "doc":
        return "Wiki"
    if label == "inbox":
        return "Inbox"
    if label in ("search", "jump to"):
        return "Search box"
    if label == "conversation list":
        return "Link picker"
    return "Other"


def percentile(values, p):
    ordered = sorted(values)
    if not ordered:
        return None
    return ordered[max(1, math.ceil(p / 100 * len(ordered))) - 1]


def server_times(side_dir: Path) -> dict[str, float]:
    path = side_dir / "api.log"
    opener = open
    if not path.exists() and (side_dir / "api.log.gz").exists():
        path, opener = side_dir / "api.log.gz", gzip.open
    times = {}
    if not path.exists():
        return times
    with opener(path, "rt", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            start = line.find("{")
            if start < 0 or "request completed" not in line:
                continue
            try:
                row = json.loads(line[start:])
            except json.JSONDecodeError:
                continue
            if row.get("msg") == "request completed" and row.get("reqId"):
                times[row["reqId"]] = float(row.get("responseTime", 0))
    return times


def read_lines(path: Path):
    if not path.exists():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if line.startswith("{"):
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return rows


def phased(rows, times):
    """{phase: [(label, server ms or client ms, status)]}; the client rows before a window line belong to it."""
    out, pending = {}, []
    for row in rows:
        if row.get("type") == "client":
            pending.append(row)
        elif row.get("type") == "window":
            out.setdefault(row["phase"], []).extend(
                (r["label"], times.get(r.get("reqId"), r["ms"]), r["status"], r.get("reqId") in times) for r in pending)
            pending = []
    return out


def memory(path: Path):
    peak = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            parts = line.split("\t")
            if len(parts) == 4:
                peak[parts[2]] = max(peak.get(parts[2], 0.0), float(parts[3]))
    return peak


def bundle(path: Path):
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    match = re.search(r"First screen: (\d+) files .*?, (\d+) KB raw, (\d+) KB brotli", text)
    return {"files": int(match.group(1)), "raw": int(match.group(2)), "brotli": int(match.group(3))} if match else {}


def side_metrics(side_dir: Path, rounds: int):
    """{metric key: [value per round]} for one ref, plus details."""
    times = server_times(side_dir)
    metrics: dict[str, list] = {}
    details = {"notes": [], "statements": {}, "unpaired": 0}

    def put(key, value):
        if value is not None:
            metrics.setdefault(key, []).append(value)

    for number in range(1, rounds + 1):
        rdir = side_dir / f"round-{number}"
        if not rdir.exists():
            continue
        rows = read_lines(rdir / "measure.jsonl")
        extra = read_lines(rdir / "extra.jsonl")
        for phase, samples in {**phased(rows, times), **phased(extra, times)}.items():
            details["unpaired"] += sum(1 for *_, paired in samples if not paired)
            values = [ms for _, ms, _, _ in samples]
            put(f"p95 all|{phase}", percentile(values, 95))
            put(f"p50 all|{phase}", percentile(values, 50))
            put(f"errors|{phase}", sum(1 for _, _, status, _ in samples if status >= 400))
            by_label = {}
            for label, ms, _, _ in samples:
                by_label.setdefault(label, []).append(ms)
            if phase in PHASES:
                put(f"over 50|{phase}", sum(1 for v in by_label.values() if percentile(v, 95) > TARGET_P95))
                by_group = {}
                for label, ms, _, _ in samples:
                    by_group.setdefault(group_of(label), []).append(ms)
                for group, values in by_group.items():
                    put(f"p50|{phase}|{group}", percentile(values, 50))
                    put(f"p95|{phase}|{group}", percentile(values, 95))
            for label, values in by_label.items():
                put(f"label p95|{phase}|{label}", percentile(values, 95))
        counts = [row for row in rows if row.get("type") == "count"]
        if counts:
            per_label = {row["label"]: row["statements"] for row in counts}
            details["statements"].setdefault(number, per_label)
            put("statements|all distinct requests", sum(per_label.values()))
            by_group = {}
            for label, n in per_label.items():
                by_group[group_of(label)] = by_group.get(group_of(label), 0) + n
            for group, n in by_group.items():
                put(f"statements|{group}", n)
            plan = next((row for row in rows if row.get("type") == "plan"), None)
            if plan:
                for view in plan["views"]:
                    put(f"statements view|{view['view']}", sum(per_label.get(r["label"], 0) for r in view["requests"]))
        for row in extra:
            if row.get("type") == "note":
                details["notes"].append(f"round {number}: {row['note']}")
        idle = json.loads((rdir / "idle.json").read_text()) if (rdir / "idle.json").exists() else {}
        put("idle statements", idle.get("statements"))
        if idle:
            put("idle cpu", round(idle["apiCpu"] + idle["workerCpu"] + idle["dbCpu"], 3))
        for service, mib in memory(rdir / "idle-memory.tsv").items():
            put(f"memory idle|{service}", mib)
        for service, mib in memory(rdir / "load-memory.tsv").items():
            put(f"memory load|{service}", mib)
        browser = json.loads((rdir / "browser.json").read_text()) if (rdir / "browser.json").exists() else {}
        loads = browser.get("loads", [])
        for error in browser.get("errors", []):
            details["notes"].append(f"round {number} browser: {error}")
        for key in ("usableMs", "codeBytesBeforeUsable", "codeBytesUntilQuiet", "openMs", "openRequests", "openStatements"):
            values = [load[key] for load in loads if key in load]
            if values:
                put(f"browser|{key}", statistics.median(values))
        if loads:
            details.setdefault("openAddresses", loads[-1].get("openAddresses"))
    seed = memory(side_dir / "seed-memory.tsv")
    for service in ("api", "worker", "db"):
        if service in seed:
            metrics[f"memory seed|{service}"] = [seed[service]]
    first = bundle(side_dir / "bundle.txt")
    if first:
        metrics["bundle brotli"] = [first["brotli"]]
        metrics["bundle files"] = [first["files"]]
    return metrics, details


def summary(values):
    if not values:
        return None
    return {"median": statistics.median(values), "min": min(values), "max": max(values), "n": len(values)}


def fmt(value, unit):
    if value is None:
        return "–"
    if unit == "KB":
        return f"{value / 1024:.0f}" if value >= 10240 else f"{value / 1024:.1f}"
    if unit in ("ms", "MiB", "%"):
        return f"{value:.0f}" if value >= 10 else f"{value:.1f}" if value >= 1 else f"{value:.2f}"
    return f"{value:.0f}" if float(value).is_integer() else f"{value:.1f}"


def cell(s, unit):
    if not s:
        return "–"
    if s["n"] == 1 or s["min"] == s["max"]:
        return fmt(s["median"], unit)
    return f"{fmt(s['median'], unit)} [{fmt(s['min'], unit)}–{fmt(s['max'], unit)}]"


FLOORS = {"ms": 2, "count": 1, "KB": 2048, "MiB": 10, "%": 0.2}


def verdict(base, head, unit, budget):
    if not head:
        return "–", None
    delta = None
    if base and base["median"]:
        delta = (head["median"] - base["median"]) / base["median"] * 100
    words = []
    if budget is not None and head["median"] > budget:
        words.append("BREACH" + (" (also at base)" if base and base["median"] > budget else ""))
    if delta is not None and abs(head["median"] - base["median"]) >= FLOORS.get(unit, 0):
        if delta > 10:
            words.append("regression" if head["min"] > base["max"] else "regression? (ranges overlap)")
        elif delta < -10:
            words.append("better")
    return (", ".join(words) or "same"), delta


def main(argv):
    out = Path(argv[1])
    meta = json.loads((out / "meta.json").read_text())
    rounds = meta["rounds"]
    a, a_details = side_metrics(out / "a", rounds)
    b, b_details = side_metrics(out / "b", rounds)
    rows = []

    def row(name, key, unit, budget=None, budget_text=None):
        base, head = summary(a.get(key, [])), summary(b.get(key, []))
        if not base and not head:
            return
        word, delta = verdict(base, head, unit, budget)
        rows.append({"metric": name, "key": key, "unit": unit, "base": base, "head": head, "deltaPct": delta,
                     "budget": budget_text or (f"≤ {fmt(budget, unit)}" if budget is not None else ""), "verdict": word})

    for phase in PHASES:
        row(f"API p95, all requests, {phase} (ms)", f"p95 all|{phase}", "ms", TARGET_P95)
        row(f"API p50, all requests, {phase} (ms)", f"p50 all|{phase}", "ms")
        row(f"Requests with p95 over 50 ms, {phase} (of 38)", f"over 50|{phase}", "count", 0)
    for phase in ("warm @2 vcpu", "warm @1.0 cpu"):
        for group in GROUP_ORDER:
            row(f"  {group}: p50 / {phase} (ms)", f"p50|{phase}|{group}", "ms")
            row(f"  {group}: p95 / {phase} (ms)", f"p95|{phase}|{group}", "ms", TARGET_P95)
    row("Statements, one of each distinct request (owner)", "statements|all distinct requests", "count")
    for group in GROUP_ORDER:
        row(f"  Statements: {group}", f"statements|{group}", "count")
    for key in sorted({k for k in list(a) + list(b) if k.startswith("statements view|")}):
        row(f"  Statements to open {key.split('|')[1]} (perf-measure's plan of v0.2's reads)", key, "count")
    row("Space + Conversation open: API requests (browser)", "browser|openRequests", "count", 8)
    row("Space + Conversation open: statements (browser)", "browser|openStatements", "count")
    row("Space + Conversation open: click to threads shown (ms)", "browser|openMs", "ms")
    row("Cold load: time to usable Home, Chromium at 2 vCPU (ms)", "browser|usableMs", "ms")
    row("Cold load: JS+CSS on the wire before usable (KB)", "browser|codeBytesBeforeUsable", "KB", 250 * 1024, "≤ 250 (brotli)")
    row("Cold load: JS+CSS on the wire until quiet, precache incl. (KB)", "browser|codeBytesUntilQuiet", "KB")
    row("First screen from the build, brotli (KB, perf-bundle.mjs)", "bundle brotli", "count", 250)
    row("Idle: statements a minute (worker running, embeddings off)", "idle statements", "count", 100)
    row("Idle: CPU of api+worker+db (% of one core)", "idle cpu", "%", 2)
    for phase in ("search @2 vcpu", "search @1.0 cpu", "agent search @2 vcpu", "agent search @1.0 cpu"):
        row(f"{'flux_search' if phase.startswith('agent') else 'People search'} p95, {phase.split(' @')[1]} (ms)", f"p95 all|{phase}", "ms", TARGET_P95)
        row(f"{'flux_search' if phase.startswith('agent') else 'People search'} p50, {phase.split(' @')[1]} (ms)", f"p50 all|{phase}", "ms")
    for service, limit in (("api", 1536), ("worker", 512), ("db", 768)):
        row(f"Memory {service}, idle (MiB)", f"memory idle|{service}", "MiB", limit, f"≤ {limit} (mem_limit)")
        row(f"Memory {service}, peak under the perf load (MiB)", f"memory load|{service}", "MiB", limit, f"≤ {limit} (mem_limit)")
        row(f"Memory {service}, peak while seeding (MiB)", f"memory seed|{service}", "MiB", limit, f"≤ {limit} (mem_limit)")

    print(f"# Flux performance: {meta['base']['ref']} against {meta['head']['ref']}\n")
    print(f"- base `{meta['base']['ref']}` = `{meta['base']['sha']}`; head `{meta['head']['ref']}` = `{meta['head']['sha']}`; scripts `{meta['scripts']}`")
    print(f"- {rounds} rounds, base and head alternating; {meta['runs']} passes per warm/concurrent phase; {meta['browserLoads']} browser loads per round")
    print(f"- host CPUs {meta['hostCpus']}: server (db, api, worker) on CPUs {meta['serverCpus']}, clients and browser on {meta['clientCpus']}; "
          "`@1.0 cpu` also holds the API and the database to 1.0 CPU each")
    print("- cells: median over the rounds [lowest–highest round]; API times are the server's own (Fastify responseTime)\n")
    print("| Metric | base | head | Δ | budget | verdict |")
    print("| --- | ---: | ---: | ---: | --- | --- |")
    for r in rows:
        delta = "–" if r["deltaPct"] is None else f"{r['deltaPct']:+.0f} %"
        print(f"| {r['metric']} | {cell(r['base'], r['unit'])} | {cell(r['head'], r['unit'])} | {delta} | {r['budget']} | {r['verdict']} |")

    # Requests whose p95 moved by more than 10 % and 2 ms in a 1.0 CPU phase, and statement counts that changed.
    print("\n## Requests that changed (p95, median over rounds, ms)\n")
    print("| Phase | Request | base | head | Δ |")
    print("| --- | --- | ---: | ---: | ---: |")
    for key in sorted({k for k in list(a) + list(b) if k.startswith("label p95|")}):
        base, head = summary(a.get(key, [])), summary(b.get(key, []))
        if base and head and abs(head["median"] - base["median"]) >= 2 and abs(head["median"] - base["median"]) / base["median"] > 0.10:
            _, phase, label = key.split("|", 2)
            print(f"| {phase} | {label} | {cell(base, 'ms')} | {cell(head, 'ms')} | {(head['median'] - base['median']) / base['median'] * 100:+.0f} % |")
    sa, sb = a_details["statements"].get(1, {}), b_details["statements"].get(1, {})
    changed = [(label, sa.get(label), sb.get(label)) for label in sorted(set(sa) | set(sb)) if sa.get(label) != sb.get(label)]
    if changed:
        print("\n## Statements per request that changed (round 1)\n")
        print("| Request | base | head |")
        print("| --- | ---: | ---: |")
        for label, x, y in changed:
            print(f"| {label} | {x if x is not None else '–'} | {y if y is not None else '–'} |")
    for name, side in (("base", "a"), ("head", "b")):
        bundle_text = (out / side / "bundle.txt").read_text(encoding="utf-8") if (out / side / "bundle.txt").exists() else ""
        for line in bundle_text.splitlines():
            if line.startswith(("First-screen files", "Largest chunks")):
                print(f"\n{name}: {line}")
    for name, details in (("base", a_details), ("head", b_details)):
        if details.get("openAddresses"):
            print(f"\nSpace + Conversation open, {name}: {'; '.join(details['openAddresses'])}")
        for note in details["notes"]:
            print(f"- {name}: {note}")
        if details["unpaired"]:
            print(f"- {name}: {details['unpaired']} requests had no server time in the API log (their client time was used)")
    with open(out / "compare.json", "w", encoding="utf-8") as handle:
        json.dump({"meta": meta, "rows": rows, "base": a, "head": b}, handle, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
