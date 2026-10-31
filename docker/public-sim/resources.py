"""Summarizes resources.jsonl of scripts/check_public_sim.sh (#63 AC-1): per measured window (the driver's
"mark RUN STEP begin|end" lines) the SFU's, API's and proxy's mean and peak CPU, peak memory, and network bytes the
container sent and received during the window. Docker reports cumulative network bytes per container; the SFU's
transmitted bytes are its egress to the people in the call (plus small signalling traffic to the API).
Usage: python3 -I resources.py resources.jsonl > resources-summary.json
"""
from __future__ import annotations

import json
import re
import sys

UNITS = {"b": 1, "kb": 1e3, "mb": 1e6, "gb": 1e9, "kib": 1024, "mib": 1024 ** 2, "gib": 1024 ** 3}


def size(text: str) -> float:
    match = re.match(r"\s*([\d.]+)\s*([a-zA-Z]+)", text)
    if not match:
        return 0.0
    return float(match.group(1)) * UNITS.get(match.group(2).lower(), 1)


def main(path: str) -> None:
    samples: list[dict] = []
    marks: list[tuple[float, str]] = []
    with open(path) as handle:
        for line in handle:
            try:
                item = json.loads(line)
            except ValueError:
                continue
            if "mark" in item:
                marks.append((float(item["t"]), item["mark"]))
                continue
            stat = item["s"]
            rx, tx = (stat.get("NetIO") or "0B / 0B").split("/")
            samples.append({"t": float(item["t"]), "name": re.sub(r"^flux-public-sim-[0-9]+-[0-9]+-", "", stat.get("Name", "")),
                            "cpu": float(stat.get("CPUPerc", "0%").rstrip("%") or 0), "mem": size(stat.get("MemUsage", "0B").split("/")[0]),
                            "rx": size(rx), "tx": size(tx)})
    windows: dict[str, dict] = {}
    for t, mark in marks:
        name, _, edge = mark.rpartition(" ")
        windows.setdefault(name, {})[edge] = t
    summary = {}
    for name, edges in windows.items():
        if "begin" not in edges or "end" not in edges:
            continue
        begin, end = edges["begin"], edges["end"]
        per: dict[str, dict] = {}
        for service in sorted({s["name"] for s in samples}):
            inside = [s for s in samples if s["name"] == service and begin <= s["t"] <= end]
            around = [s for s in samples if s["name"] == service and begin - 3 <= s["t"] <= end + 3]
            if not inside:
                continue
            span = max(0.001, around[-1]["t"] - around[0]["t"])
            per[service] = {"samples": len(inside), "cpuMeanPct": round(sum(s["cpu"] for s in inside) / len(inside), 1),
                            "cpuPeakPct": round(max(s["cpu"] for s in inside), 1), "memPeakMB": round(max(s["mem"] for s in inside) / 1e6, 1),
                            "txMbps": round(8 * (around[-1]["tx"] - around[0]["tx"]) / span / 1e6, 2),
                            "rxMbps": round(8 * (around[-1]["rx"] - around[0]["rx"]) / span / 1e6, 2)}
        summary[name] = {"seconds": round(end - begin, 1), "services": per}
    json.dump({"windows": summary, "samples": len(samples)}, sys.stdout, indent=1)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main(sys.argv[1])
