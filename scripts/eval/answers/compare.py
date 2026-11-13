#!/usr/bin/env python3
"""Compares runs of the answer-accuracy evaluation (#1295): accuracy per category for each results file, the spread between runs of the
same model (the run-to-run noise a change must beat), per run (and engine variant, FLUX_EVAL_VARIANT) correctness, citations, tokens, cost
and tool calls, and the questions whose verdict changed. Standard library only.

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
    print("| Run | Variant | Model | Questions | Accuracy | No answer (run failed) | Keys | Gold found | Answer in tool results | Cited (named) gold "
          "| Date filter (relative) | In tok/q | Out tok/q | Tool calls/q | $ agent | $ judge | p50 s |")
    print("| --- |" + " --- |" * 16)
    for label, run in runs:
        o, m = run["overall"], run["meta"]
        rel = run["byCategory"].get("relative_date", {}).get("usedDateFilter")
        calls = sum(o.get("tools", {}).values()) / max(1, o["questions"])
        print(f"| {label} | {m.get('variant', 'main')} | {m['model']} | {o['questions']} | {o['accuracy']} | {o.get('failedRuns', '-')} | {o['keysMatched']} | "
              f"{o['retrievedGold']} | {o.get('answerInResults')} | {o.get('citedGold')} ({o.get('citedOrNamedGold')}) | {rel} | {o['inputTokensPerQuestion']} | "
              f"{o['outputTokensPerQuestion']} | {calls:.1f} | {m['spend']['agentUsd']} | {m['spend']['judgeUsd']} | {o['secondsP50']} |")
    tools = sorted({name for _, run in runs for name in run["overall"].get("tools", {})})
    if tools:
        print()
        print("| Tool calls per question | " + " | ".join(label for label, _ in runs) + " |")
        print("| --- |" + " --- |" * len(runs))
        for name in tools:
            print(f"| {name} | " + " | ".join(f"{run['overall'].get('tools', {}).get(name, 0) / max(1, run['overall']['questions']):.2f}" for _, run in runs) + " |")
    # A question whose wording or reference changed between runs is not the same measurement: name it, so its verdicts are not compared.
    texts = {}
    for label, run in runs:
        for q in run["questions"]:
            texts.setdefault(q["id"], set()).add((q.get("question"), q.get("reference")))
    reworded = sorted(qid for qid, seen in texts.items() if len(seen) > 1)
    if reworded:
        print()
        print(f"Not comparable across these runs (the question or its reference changed): {' '.join(reworded)}")
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
