# #1387 tuning bench

The offline model of the ranked statement used to tune #1387 on the research bench (seed 1242, `scripts/eval/retrieval/seed.py`), and its outputs.

1. A tuning database: `docker/compose.source.yaml`'s `db` and `migrate` under the compose project flux-1387-tune.
2. `load.py <seed.json>` writes the 10,000 messages into `search_documents` in seed order; `collect.py <seed.json> cache.json` asks the
   BM25 index which documents hold each query word and reads every document's tsvector.
3. `tune.py` ranks offline (df, N and avgdl over the visible hits; tf and length from the tsvector); the vector lists come from the #1341
   review's live run (`RECALL_LISTS` lines), which do not depend on the BM25 order. Tuning half: odd question numbers; held out: even.
   `grid*.py` / `grid*.out` are the sweeps (`tune / held out / all`), `final.out` the chosen setting.
4. `runner.mjs` (via `run-ranked.sh <image tag> <out.jsonl>`) runs the repository's own `searchRows(db).ranked` on that database; `cmp.py`
   scores it. The model and the statement agreed exactly before (0.467) and after (0.617) the change, and the live run
   (`../results-flux-hybrid-bge-m3.json`) agrees with both.
