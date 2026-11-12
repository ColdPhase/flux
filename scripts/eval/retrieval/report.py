#!/usr/bin/env python3
"""Markdown tables from the retrieval bench's results (#1242): recall@10 per option and query form, by category, latency, sizes,
write cost, memory, and the access and deletion checks.

  python3 report.py out/results-intfloat_multilingual-e5-small.json [out/results-BAAI_bge-m3.json ...]
"""
import json
import sys
from pathlib import Path

CATS = ["exact", "inflect", "nodiacritics", "typo", "paraphrase", "crosslang", "temporal", "recent"]


def mib(n):
    return f"{n / 1048576:.1f} MiB"


def peak_memory(stats_path):
    peaks = {}
    if not stats_path.exists():
        return peaks
    for line in stats_path.read_text().splitlines():
        parts = line.split("\t")
        if len(parts) < 4:
            continue
        used = parts[3].split(" / ")[0]
        value = float(used[:-3]) * {"KiB": 1 / 1024, "MiB": 1, "GiB": 1024}.get(used[-3:], 1)
        name = parts[1].rsplit("-", 2)[-2] if "-" in parts[1] else parts[1]
        peaks[name] = max(peaks.get(name, 0), value)
    return peaks


def main():
    for path in map(Path, sys.argv[1:]):
        r = json.loads(path.read_text())
        print(f"\n### {r['model']}\n")
        print("| Option | Question r@10 | Keywords r@10 | Bilingual r@10 | MRR (question) | p50 / p95 ms (question) |")
        print("|---|---|---|---|---|---|")
        for variant, modes in r["recall"].items():
            q = modes["question"]
            lat = f"{q['p50_ms']} / {q['p95_ms']}" if "p95_ms" in q else "—"
            print(f"| {variant} | {q['recall']:.2f} | {modes['keywords']['recall']:.2f} | {modes.get('bilingual', {}).get('recall', float('nan')):.2f} | {q['mrr']:.2f} | {lat} |")
        print("\nRecall@10 by category (question form / bilingual form):\n")
        print("| Option | " + " | ".join(CATS) + " |")
        print("|---|" + "---|" * len(CATS))
        for variant, modes in r["recall"].items():
            cells = [f"{modes['question']['by_category'].get(c, 0):.2f} / {modes.get('bilingual', modes['question'])['by_category'].get(c, 0):.2f}" for c in CATS]
            print(f"| {variant} | " + " | ".join(cells) + " |")
        if "index" in r:
            print("\n| Structure | Size (10k messages) | Build |")
            print("|---|---|---|")
            for name, v in r["index"].items():
                if "bytes" in v:
                    print(f"| {name} | {mib(v['bytes'])} | {v.get('build_s', v.get('embed_all_s'))} s |")
            vec = r["index"].get("vec", {})
            if vec:
                print(f"\nEmbeddings: {vec['model']}, {vec['dim']} dimensions, {vec['embed_per_s']} messages/s in batches, one message "
                      f"{vec['embed_one_ms_p50']} ms p50 / {vec['embed_one_ms_p95']} ms p95, HNSW {mib(vec['hnsw_bytes'])} built in {vec['hnsw_build_s']} s; "
                      f"query embedding {r.get('query_embed_ms')} ms.")
        if "write" in r:
            print("\n| Write path | Statements mean / p95 ms | With commit mean / p95 ms |")
            print("|---|---|---|")
            for name, v in r["write"].items():
                print(f"| {name} | {v.get('statement_mean_ms', '—')} / {v.get('statement_p95_ms', '—')} | {v['mean_ms']} / {v['p95_ms']} |")
        if "tokens" in r:
            print("\nTokens:", json.dumps(r["tokens"]))
        tag = path.stem.replace("results-", "")
        peaks = peak_memory(path.parent / f"stats-{tag}.tsv")
        if peaks:
            print("\nPeak memory:", ", ".join(f"{k} {v:.0f} MiB" for k, v in sorted(peaks.items())))
        for section in ("access", "deletion"):
            if section in r:
                print(f"\n{section}:")
                for check, v in r[section].items():
                    print(f"- {check}: {v['what']} → " + json.dumps({k: x for k, x in v["results"].items()}, ensure_ascii=False))


if __name__ == "__main__":
    main()
