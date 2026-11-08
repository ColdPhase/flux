#!/usr/bin/env python3
"""Reads ZAP's JSON reports (#838), applies the recorded triage (zap-rules.conf) and writes summary.md.

    summarize.py --rules scripts/dast/zap-rules.conf --out DIR report.json [report.json ...]

Exit 0: nothing at Medium or higher that is not a recorded false positive. Exit 10: findings left to triage. Exit 2: a report is
missing, empty or not ZAP's (a scan that did not run is never "clean"). A rule's `IGNORE` line carries its reason in the fourth
column: "Tracked in #N: ..." for a real finding accepted until that issue lands, "Accepted risk: ..." for one kept on purpose, anything
else for a false positive. A rule's third column that starts with `~` is a regex on the alert's name, so it excuses one alert of a rule that has several.
`OUTOFSCOPE` drops one rule's alerts on the urls its regex matches (the regex in the third column, a reason in a fourth).
"""
import argparse
import json
import re
import sys

RISK = {"0": "Informational", "1": "Low", "2": "Medium", "3": "High"}


def load_rules(path):
    ignored, scoped = {}, {}
    with open(path, encoding="utf-8") as handle:
        for number, line in enumerate(handle, 1):
            if line.startswith("#") or not line.strip():
                continue
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 3:
                sys.exit(f"dast: {path}:{number}: a rule has at least three tab-separated columns")
            rule, action, third = parts[0], parts[1], parts[2]
            if action == "OUTOFSCOPE":
                scoped.setdefault(rule, []).append((re.compile(third), parts[3] if len(parts) > 3 else ""))
            elif action in ("IGNORE", "INFO", "WARN", "FAIL"):
                reason = parts[3].strip() if len(parts) > 3 else ""
                if action == "IGNORE" and not reason:
                    sys.exit(f"dast: {path}:{number}: an IGNOREd rule needs its reason in the fourth column")
                # A third column that starts with `~` is a regex on the alert's name: the rule then excuses only the alerts of that rule it matches.
                ignored.setdefault(rule, []).append((action, third, reason, re.compile(third[1:]) if third.startswith("~") else None))
            else:
                sys.exit(f"dast: {path}:{number}: unknown action {action}")
    return ignored, scoped


def alerts_of(path):
    try:
        with open(path, encoding="utf-8") as handle:
            document = json.load(handle)
    except (OSError, ValueError) as error:
        sys.exit(f"dast: {path} is not a usable ZAP report ({error})")
    sites = document.get("site") if isinstance(document, dict) else None
    if not isinstance(sites, list) or not sites:
        sys.exit(f"dast: {path} lists no scanned site: the scan did not run")
    return [alert for site in sites for alert in site.get("alerts", [])]


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--rules", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("reports", nargs="+")
    args = parser.parse_args()
    ignored, scoped = load_rules(args.rules)
    open_findings, recorded, tracked, accepted, lower = [], [], [], [], []
    total_instances = 0
    for report in args.reports:
        name = report.rsplit("/", 1)[-1].removesuffix(".json")
        for alert in alerts_of(report):
            rule, risk = alert.get("pluginid", "?"), alert.get("riskcode", "0")
            instances = [item for item in alert.get("instances", []) if not any(rx.match(item.get("uri", "")) for rx, _ in scoped.get(rule, []))]
            if not instances:
                continue
            total_instances += len(instances)
            row = {"report": name, "rule": rule, "name": alert.get("name", alert.get("alert", "?")), "risk": RISK.get(risk, risk), "level": int(risk),
                   "count": len(instances), "urls": sorted({f"{item.get('method', '')} {item.get('uri', '')}".strip() for item in instances})[:4]}
            action = next((entry for entry in ignored.get(rule, []) if entry[3] is None or entry[3].search(row["name"])), None)
            if action and action[0] == "IGNORE":
                # A reason that starts "Tracked in #N" is a real finding accepted until that issue lands, "Accepted risk" one that is understood
                # and kept on purpose; any other is a false positive.
                kind = tracked if action[2].startswith("Tracked in #") else accepted if action[2].startswith("Accepted risk") else recorded
                kind.append({**row, "reason": action[2]})
            elif row["level"] >= 2:
                open_findings.append(row)
            else:
                lower.append(row)
    lines = ["# ZAP scan summary", "", f"Reports: {', '.join(r.rsplit('/', 1)[-1] for r in args.reports)}; {total_instances} alert instances.", ""]
    table = lambda rows, extra="": [f"| {row['report']} | {row['rule']} | {row['risk']} | {row['name']} | {row['count']} | {row['urls'][0] if row['urls'] else ''}{extra and ' | ' + row[extra]} |" for row in rows]
    lines += [f"## To triage: Medium or higher, not recorded ({len(open_findings)})", ""]
    lines += (["| Report | Rule | Risk | Alert | Instances | Example |", "| --- | --- | --- | --- | --- | --- |"] + table(open_findings)) if open_findings else ["None."]
    lines += ["", f"## Real findings accepted until their issue lands ({len(tracked)})", ""]
    lines += (["| Report | Rule | Risk | Alert | Instances | Example | Reason |", "| --- | --- | --- | --- | --- | --- | --- |"] + table(tracked, "reason")) if tracked else ["None."]
    lines += ["", f"## Accepted risks, kept on purpose ({len(accepted)})", ""]
    lines += (["| Report | Rule | Risk | Alert | Instances | Example | Reason |", "| --- | --- | --- | --- | --- | --- | --- |"] + table(accepted, "reason")) if accepted else ["None."]
    lines += ["", f"## Recorded false positives ({len(recorded)})", ""]
    lines += (["| Report | Rule | Risk | Alert | Instances | Example | Reason |", "| --- | --- | --- | --- | --- | --- | --- |"] + table(recorded, "reason")) if recorded else ["None."]
    lines += ["", f"## Low and informational ({len(lower)})", ""]
    lines += (["| Report | Rule | Risk | Alert | Instances | Example |", "| --- | --- | --- | --- | --- | --- |"] + table(lower)) if lower else ["None."]
    with open(f"{args.out}/summary.md", "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")
    print("\n".join(lines[:3]))
    print(f"dast: {len(open_findings)} to triage, {len(tracked)} tracked, {len(accepted)} accepted risks, {len(recorded)} recorded false positives, {len(lower)} low or informational; see {args.out}/summary.md")
    sys.exit(10 if open_findings else 0)


if __name__ == "__main__":
    main()
