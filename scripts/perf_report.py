#!/usr/bin/env python3
"""Summarise a scripts/check_performance.sh run (#298).

Reads the measurement script's JSON lines and the API's own request log (Fastify/pino JSON, one
line per event) and prints, per distinct request, the server time Fastify logged in each phase
(p50/p95, nearest rank) and what pg_stat_statements recorded for one execution: statements sent
and their execution (and planning) time in PostgreSQL. A request the app sends on several views
(the shell's) is listed once, under the first view that sends it.

Usage: perf_report.py MEASURE.jsonl API.log [--json OUT.json]
"""

import json
import math
import sys

PHASES = ["isolated", "isolated (member)", "cold", "cold (member)", "warm", "warm (member)", "concurrent"]


def percentile(values, p):
    ordered = sorted(values)
    if not ordered:
        return None
    rank = max(1, math.ceil(p / 100 * len(ordered)))
    return ordered[rank - 1]


def read_measure(path):
    plan, windows, counts, clients = [], [], {}, []
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line.startswith("{"):
                continue
            row = json.loads(line)
            kind = row.get("type")
            if kind == "plan" and not plan:
                plan = row["views"]
            elif kind == "window":
                windows.append(row)
            elif kind == "count":
                counts[(row.get("phase", "isolated"), row["method"], row["path"])] = row
            elif kind == "client":
                clients.append(row)
    return plan, windows, counts, clients


def read_server_times(path):
    """(time, method, url, responseTime, status) per completed request, paired in log order."""
    pending, done = {}, []
    with open(path, encoding="utf-8", errors="replace") as handle:
        for line in handle:
            start = line.find("{")
            if start < 0:
                continue
            try:
                row = json.loads(line[start:])
            except json.JSONDecodeError:
                continue
            req_id = row.get("reqId")
            if req_id is None:
                continue
            if row.get("msg") == "incoming request" and isinstance(row.get("req"), dict):
                pending[req_id] = (row["req"].get("method"), row["req"].get("url"))
            elif row.get("msg") == "request completed" and req_id in pending:
                method, url = pending.pop(req_id)
                status = (row.get("res") or {}).get("statusCode")
                done.append((row.get("time"), method, url, float(row.get("responseTime", 0)), status))
    return done


def summarise(measure_path, log_path):
    plan, windows, counts, clients = read_measure(measure_path)
    completed = read_server_times(log_path)
    phases = {}
    for window in windows:
        times = phases.setdefault(window["phase"], {})
        for when, method, url, response_time, status in completed:
            if when is None or not window["start"] <= when <= window["end"]:
                continue
            times.setdefault((method, url), []).append((response_time, status))
    sizes = {}
    for row in clients:
        sizes.setdefault((row["method"], row["path"]), row.get("bytes"))
    rows, seen = [], set()
    for view in plan:
        for request in view["requests"]:
            key = (request["method"], request["path"])
            if key in seen:
                continue
            seen.add(key)
            owner = counts.get(("isolated",) + key, {})
            member = counts.get(("isolated (member)",) + key, {})
            entry = {"view": view["view"], "label": request["label"], "method": key[0], "path": key[1],
                     "statements": owner.get("statements"), "dbMs": owner.get("dbMs"), "planMs": owner.get("planMs"),
                     "memberDbMs": member.get("dbMs"), "walBytes": owner.get("walBytes"), "bytes": sizes.get(key), "phases": {}}
            for phase, times in phases.items():
                values = [value for value, _ in times.get(key, [])]
                bad = [status for _, status in times.get(key, []) if status is None or status >= 400]
                entry["phases"][phase] = {"n": len(values), "p50": percentile(values, 50), "p95": percentile(values, 95), "errors": len(bad)}
            rows.append(entry)
    return rows, phases, counts


def fmt(value):
    return "–" if value is None else (f"{value:.0f}" if value >= 10 else f"{value:.1f}")


def main(argv):
    if len(argv) < 3:
        print(__doc__, file=sys.stderr)
        return 2
    rows, phases, counts = summarise(argv[1], argv[2])
    order = [phase for phase in PHASES if phase in phases] + sorted(set(phases) - set(PHASES))
    print("| View | Request | SQL | DB ms (owner / member) | WAL B | Bytes | " + " | ".join(f"{phase} p50 / p95" for phase in order) + " |")
    print("|" + " --- |" * (6 + len(order)))
    for row in rows:
        cells = []
        for phase in order:
            stats = row["phases"].get(phase)
            if not stats or not stats["n"]:
                cells.append("–")
                continue
            cells.append(f"{fmt(stats['p50'])} / {fmt(stats['p95'])}" + (f" ({stats['errors']} errors)" if stats["errors"] else ""))
        db = f"{fmt(row['dbMs'])} / {fmt(row['memberDbMs'])}"
        wal = row["walBytes"] if row["walBytes"] is not None else "–"
        print(f"| {row['view']} | {row['label']} | {row['statements'] if row['statements'] is not None else '–'} | {db} | {wal} | "
              f"{row['bytes'] if row['bytes'] is not None else '–'} | " + " | ".join(cells) + " |")
    samples = {phase: sum(len(values) for values in times.values()) for phase, times in phases.items()}
    print("\nRequests per phase: " + ", ".join(f"{phase} {samples[phase]}" for phase in order))
    if "--json" in argv:
        with open(argv[argv.index("--json") + 1], "w", encoding="utf-8") as handle:
            json.dump({"rows": rows, "counts": [dict(row, key=None) for row in counts.values()]}, handle, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
