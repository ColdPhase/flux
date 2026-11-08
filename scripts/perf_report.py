#!/usr/bin/env python3
"""Summarise a scripts/check_performance.sh run (#298).

Reads the measurement script's JSON lines and the API's own request log (Fastify/pino JSON, one
line per event) and prints, per distinct request, the server time Fastify logged in each phase
(p50/p95, nearest rank) and what pg_stat_statements recorded for one execution: statements sent
and their execution (and planning) time in PostgreSQL. A request the app sends on several views
(the shell's) is listed once, under the first view that sends it.

The API's request log has no query string (F-030), so a server time is matched to a request by its id: the measurement sends
`X-Request-ID` and the API logs it as `reqId` (#827). A log line without a known id is matched by its path alone, and only when no
other request of the plan shares that path; otherwise the row shows "–" rather than the mixed times of several requests.

With --targets it also holds the CPU-limited phases (their names end in "@<n> cpu", #850 AC-3) to the 2 vCPU / 4 GB targets of #862:
the p95 of every request at most 50 ms, and says which requests are over.

With --fail-on-targets (and --targets) the exit status is 1 when a CPU-limited phase is over the target, so a check can stop on it (#1023).

Usage: perf_report.py MEASURE.jsonl API.log [--json OUT.json] [--targets [--fail-on-targets]]
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


def base_path(url):
    return url.split("?", 1)[0]


def read_measure(path):
    plan, windows, counts, clients, ids = [], [], {}, [], {}
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line.startswith("{"):
                continue
            row = json.loads(line)
            kind = row.get("type")
            if row.get("reqId") and row.get("method") and row.get("path"):
                ids[row["reqId"]] = (row["method"], row["path"])
            if kind == "plan" and not plan:
                plan = row["views"]
            elif kind == "window":
                windows.append(row)
            elif kind == "count":
                counts[(row.get("phase", "isolated"), row["method"], row["path"])] = row
            elif kind == "client":
                clients.append(row)
    return plan, windows, counts, clients, ids


def read_server_times(path):
    """(time, method, url, responseTime, status, reqId) per completed request, paired by reqId."""
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
                done.append((row.get("time"), method, url, float(row.get("responseTime", 0)), status, req_id))
    return done


def summarise(measure_path, log_path):
    plan, windows, counts, clients, ids = read_measure(measure_path)
    completed = read_server_times(log_path)
    # The plan's requests that share a method and a path (their queries differ, the log shows only the path).
    shared = {}
    for view in plan:
        for request in view["requests"]:
            shared.setdefault((request["method"], base_path(request["path"])), set()).add(request["path"])
    phases = {}
    for window in windows:
        times = phases.setdefault(window["phase"], {})
        for when, method, url, response_time, status, req_id in completed:
            if when is None or not window["start"] <= when <= window["end"]:
                continue
            if req_id in ids:
                times.setdefault(ids[req_id], []).append((response_time, status))
            else:
                times.setdefault((method, base_path(url)), []).append((response_time, status))
    sizes = {}
    for row in clients:
        sizes.setdefault((row["method"], row["path"]), row.get("bytes"))

    def timed(phase, key):
        """What the log holds for one request in a phase: its own ids, else its path when no other request has it."""
        times = phases.get(phase, {})
        own = times.get(key, [])
        if own:
            return own
        path = (key[0], base_path(key[1]))
        return times.get(path, []) if len(shared.get(path, ())) == 1 else []

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
            for phase in phases:
                observed = timed(phase, key)
                values = [value for value, _ in observed]
                bad = [status for _, status in observed if status is None or status >= 400]
                entry["phases"][phase] = {"n": len(values), "p50": percentile(values, 50), "p95": percentile(values, 95), "errors": len(bad)}
            rows.append(entry)
    return rows, phases, counts


# #862, "Server: p95 <= 50 ms", judged where the host is held to two vCPUs.
TARGET_P95_MS = 50


def target_lines(rows, phases):
    """One line per CPU-limited phase: every request's p95 against the target, and the ones over it."""
    lines = []
    for phase in sorted(name for name in phases if "@" in name):
        every = [value for observed in phases[phase].values() for value, _ in observed]
        overall = percentile(every, 95)
        over = sorted(((row["phases"][phase]["p95"], row) for row in rows if row["phases"].get(phase, {}).get("p95") is not None
                       and row["phases"][phase]["p95"] > TARGET_P95_MS), key=lambda item: -item[0])
        verdict = "PASS" if not over and overall is not None and overall <= TARGET_P95_MS else "FAIL"
        lines.append(f"- {phase}: {verdict}, p95 of all {len(every)} requests {fmt(overall)} ms; {len(over)} of {len(rows)} requests over {TARGET_P95_MS} ms"
                     + ("".join(f"\n  - {row['view']}: {row['label']} p95 {fmt(value)} ms, {row['statements']} statements" for value, row in over[:12])))
    return lines


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
    if "--targets" in argv:
        lines = target_lines(rows, phases)
        print(f"\nTargets for 2 vCPU / 4 GB (#862): p95 at most {TARGET_P95_MS} ms, in the CPU-limited phases")
        print("\n".join(lines) if lines else "- no CPU-limited phase ran (FLUX_PERF_PHASES without `limited`)")
        missed = any(": FAIL," in line for line in lines)
    if "--json" in argv:
        with open(argv[argv.index("--json") + 1], "w", encoding="utf-8") as handle:
            json.dump({"rows": rows, "counts": [dict(row, key=None) for row in counts.values()]}, handle, indent=1)
    return 1 if "--fail-on-targets" in argv and "--targets" in argv and missed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
