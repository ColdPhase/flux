#!/usr/bin/env python3
"""Compares runs of the answer-accuracy evaluation (#1295): accuracy per category for each results file, the spread between runs of the
same model (the run-to-run noise a change must beat), and the questions whose verdict changed. Standard library only.

  python3 scripts/eval/answers/compare.py docs/product/research/evidence/1295/results-*.json
"""
import json
import sys
from pathlib import Path


def main(paths):
    runs = [(Path(p).stem.removeprefix("results-"), json.loads(Path(p).read_text())) for p in paths]
    categories = []
    for _, run in runs:
        for name in run["byCategory"]:
            if name not in categories:
                categories.append(name)
    print("| Category | " + " | ".join(label for label, _ in runs) + " | Spread |")
    print("| --- |" + " --- |" * (len(runs) + 1))
    for name in categories + ["all"]:
        values = [(run["overall"] if name == "all" else run["byCategory"].get(name, {})).get("accuracy") for _, run in runs]
        known = [v for v in values if v is not None]
        spread = f"{max(known) - min(known):.3f}" if len(known) > 1 else "-"
        print(f"| {name} | " + " | ".join("-" if v is None else f"{v:.3f}" for v in values) + f" | {spread} |")
    print()
    print("| Run | Model | Questions | Accuracy | Keys | Gold found | Answer in tool results | Date filter (relative) | In tok/q | $ agent | $ judge | p50 s |")
    print("| --- |" + " --- |" * 11)
    for label, run in runs:
        o, m = run["overall"], run["meta"]
        rel = run["byCategory"].get("relative_date", {}).get("usedDateFilter")
        print(f"| {label} | {m['model']} | {o['questions']} | {o['accuracy']} | {o['keysMatched']} | {o['retrievedGold']} | {o.get('answerInResults')} | {rel} | "
              f"{o['inputTokensPerQuestion']} | {m['spend']['agentUsd']} | {m['spend']['judgeUsd']} | {o['secondsP50']} |")
    verdicts = {}
    for label, run in runs:
        for q in run["questions"]:
            verdicts.setdefault(q["id"], {})[label] = (q.get("judge") or {}).get("verdict", "-")
    changed = {qid: v for qid, v in verdicts.items() if len(set(v.values())) > 1}
    if changed:
        print()
        print("| Question | " + " | ".join(label for label, _ in runs) + " |")
        print("| --- |" + " --- |" * len(runs))
        for qid, v in sorted(changed.items()):
            print(f"| {qid} | " + " | ".join(v.get(label, "-") for label, _ in runs) + " |")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    main(sys.argv[1:])
