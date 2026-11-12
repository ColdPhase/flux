# How agents read long conversations: retrieval, search engine, summaries and context

**Status:** research for [#1242](https://github.com/ColdPhase/flux/issues/1242) (milestone v0.2.1), 2026-11-12. This note
proposes; it does not decide. `decisions.md`, `assistant.md`, `ai-modes.md` and the threat model are unchanged until Hubert
answers [the questions at the end](#questions-for-hubert) and the decision is recorded and peer-reviewed (#1242's order:
research, then decision, then implementation issues). Every figure below was measured on this host in Docker unless it is
labelled a **vendor claim**, a **published result** or an **inference**.

## In short

- **Today an agent misses almost everything older than its window.** On a seeded space of 10,000 Polish and English
  messages with 60 known-answer questions, the API brief's last 40 messages hold the answer for 8% of the questions (only
  the recent ones). Today's search (`flux_search_project`: `simple` full text, every word required, one space) finds
  nothing for any question asked in plain words, and 8% when an agent types keywords: 55 of 60 keyword searches come back
  empty, because every word must appear in the message.
- **PostgreSQL is enough; no separate engine is needed.** The best option measured is BM25 ranking inside PostgreSQL
  (ParadeDB's `pg_search` extension, Polish stemmer, accents folded), with "any word may match" queries: recall@10 0.60 for
  the question as asked, **0.78 when the agent searches in both languages**, p95 under 3 ms, 3.8 MiB of index per 10k
  messages, a quarter of a millisecond per write, and access loss and deletion take effect in the same transaction.
  Plain PostgreSQL without an extension (any word, accents folded) reaches 0.40 (question) / 0.67 (bilingual).
- **Embeddings are not worth their cost here yet.** A small local multilingual model (multilingual-e5-small, MIT) scored
  below keyword search (0.40) and pushed hybrid search below BM25 alone, while its server takes about 920 MiB of RAM, which
  the 4 GB target (#862) does not have. A large one (bge-m3, 568M parameters) does lift recall (vector alone 0.63, hybrid with BM25 0.75 for the question as asked), but its server could not start in 4 GiB, idles at 3.2 GiB and embeds 10 messages a second on 2 CPUs; and with the agent searching in both languages BM25 alone (0.78) is within one question of that hybrid (0.80). The person's own connection cannot be the embedder: Claude plans,
  ChatGPT plans and Anthropic keys have no embeddings API, and embedding a whole space would send all of it to one person's
  provider.
- **The agent's queries matter more than the engine.** The largest single gain is the agent searching in both of the
  space's languages (BM25 0.60 → 0.78; questions across languages 0.12 → 0.69). That is a tool description and a brief
  line, not infrastructure.
- **A separate engine (Meilisearch) measured worse and costs more**: recall 0.42 / 0.62 (question / keywords), p95 ≈ 12 ms,
  one more container and volume to back up, and a removed message stayed findable for 140–175 ms after the commit unless
  every hit is rechecked in PostgreSQL.
- **Summaries** can be kept correct cheaply (a trigger marks a summary stale in the writer's transaction; verified), but
  their answer quality needs a model run that was not made here: strata is off (it uses about 50 GB of RAM) and no API key
  is configured. The scenario is ready for the coordinator ([Evaluation still to run](#evaluation-still-to-run)).
- **Recommendation:** one `flux_search` tool on BM25 in Flux's PostgreSQL, filtered by what the caller can read now in the
  same statement; `flux_read_around` for the messages around a hit; a smaller window in the API brief with a line that
  older messages are found with search; no embeddings and no separate engine in v0.2.1; summaries only as an on-demand
  tool first. The decisions this needs are listed for Hubert at the end.

## Contents

1. [How it works today](#how-it-works-today-v020)
2. [The bench: seed, test set and harness](#the-bench-seed-test-set-and-harness)
3. [Results](#results)
4. [Options compared](#options-compared)
5. [Embeddings: who computes them](#embeddings-who-computes-them)
6. [Context building: what others do and what the papers say](#context-building-what-others-do-and-what-the-papers-say)
7. [Tools](#tools)
8. [Freshness, deletion, access and storage](#freshness-deletion-access-and-storage)
9. [Recommendation and what changes for an operator](#recommendation-and-what-changes-for-an-operator)
10. [Implementation plan](#implementation-plan)
11. [Evaluation still to run](#evaluation-still-to-run)
12. [Limits of this research](#limits-of-this-research)
13. [Sources](#sources)
14. [Questions for Hubert](#questions-for-hubert)

## How it works today (v0.2.0)

Read from `main` at `8cef27ca1`:

- **API-key runs.** The brief carries the place's last 40 messages (`MESSAGE_WINDOW = 40`,
  `packages/core/src/personal-runs/brief-facts.ts`) and says when older ones exist (`leftOut`). Nothing older reaches the
  model unless it calls a tool.
- **CLI runs (Claude Code, Codex)** read with the Flux MCP tools: `flux_get_conversation` (up to 50 messages a page,
  `nextBeforeSequence` for older ones), `flux_search_project` (one space per call), `flux_get_task_discussion` and others.
  Reading a 5,000-message conversation page by page is 100 calls.
- **Search** is `search_documents` (migration 0001, kept by triggers in the writer's transaction): a `simple` tsvector (no
  stemming, no accent folding) and an audience-keyed GIN index over three-letter prefixes. The query is
  `websearch_to_tsquery('simple', q)` (every word required) or-ed with a prefix query of the same words, ranked by
  `ts_rank` (`packages/db/src/repositories/search.ts`). Access is decided at query time from the audiences the caller can
  read now (`visibleFilter` / `memberFilter`), in the same statement. Encrypted spaces use sealed search and never reach AI.
- **Each run starts from nothing** apart from the agent's own memory.

## The bench: seed, test set and harness

Everything is in `scripts/eval/retrieval/` and runs in Docker (`run.sh`); it is meant to become the evaluation harness of
the implementation ([plan, part 4](#implementation-plan)).

- **Seed** (`seed.py`, deterministic, seed 1242): one company ("Zielony Dach", a maker of roof weather stations), 8 people
  (one company guest), one agent, 6 spaces (two restricted, one with a guest), 7 conversations and **10,000 messages, 71%
  Polish and 29% English**, from March to November 2026. One conversation holds 5,000 messages. Ordinary chatter comes from
  templates with inflected Polish forms, openers and closers (8,613 distinct texts; short replies such as "ok" repeat); 55 planted messages (known answers, one superseded decision, one message to delete and one to edit) and 4 near-miss
  distractors are placed among them (`facts.json`).
- **Test set** (`facts.json`): 60 questions, each with its gold message(s), an `answer_check` pattern for answer accuracy,
  the conversation it is asked in, and three query forms: the **question** as a person asks it; **keywords** an agent would
  type, taken from the question's own words only; and **bilingual**: those keywords plus their literal translation into
  the other language, as an agent told "search in both languages" would send. Categories: exact (8), Polish inflection
  differs (8), no diacritics (4), typo (3), paraphrase (12), across languages (16), temporal (5: a date filter or the latest
  of several), recent (4: inside today's window).
- **Harness** (`harness.py`): a bench schema with Flux's access rules (`schema.sql`: people and company role, spaces and
  visibility, grants, the space's AI switch, agents and owners; `readable_spaces` follows `memberFilter`), today's
  `search_documents` index and query reproduced from migration 0001 and `search.ts`, and one structure per option. It
  measures recall@10 and MRR for each query form, query latency (3 repeats of every query, warm), index size and build
  time, the cost of a write (400 single-row inserts, one transaction each, per option), memory (`docker stats` every 2 s),
  and runs the access-loss and deletion checks against every option.
- **Limits enforced.** PostgreSQL, the embedding server and Meilisearch share one 2-CPU cpuset (`BENCH_CPUS=20,21`, as a
  2 vCPU host); PostgreSQL has Flux's own memory limit (768 MiB), the others 1–2 GiB. The harness is the client and runs
  outside the cpuset. Other agents' suites ran on the host at the same time, so absolute latencies are pessimistic.
- **Answer accuracy** (`answer.py`): each question answered by a model from one context strategy (today's window; search
  page plus read-around; stored summaries plus window; window plus search), scored by `answer_check`, with input tokens
  counted. Checked here only with a stand-in model (`--mock`), which proves the plumbing, not accuracy.

Command lines: `scripts/eval/retrieval/run.sh` (everything, multilingual-e5-small);
`BENCH_EMBED_MODEL=BAAI/bge-m3 BENCH_EMBED_MEMORY=4g scripts/eval/retrieval/run.sh load index recall tokens`;
`python3 scripts/eval/retrieval/report.py scripts/eval/retrieval/out/results-*.json` prints the tables below. Raw results:
[e5-small run](evidence/1242/results-intfloat_multilingual-e5-small.json), [bge-m3 run](evidence/1242/results-BAAI_bge-m3.json)
and [peak memory and CPU per service](evidence/1242/peaks.json).

## Results

Measured 2026-11-12 on this host (24-thread x86-64, Fedora 42, Docker), all engines on the same two CPUs. The asker is an
agent (Fieldbot, Ada's) that may read all six spaces. "today" searches only the space the question is asked in, as
`flux_search_project` does, and ignores dates (it has no filter); every other option searches every space the asker can
read and applies the question's date range when it has one.

### Recall@10 and latency (multilingual-e5-small for the vector options)

| Option | Question | Keywords | Bilingual | MRR (question) | Query p50 / p95 ms |
|---|---|---|---|---|---|
| window40 (today's API brief) | 0.08 | 0.08 | 0.08 | 0.01 | — |
| today (`flux_search_project`) | 0.00 | 0.08 | 0.00 | 0.00 | 2.0 / 3.3 |
| fts_or (simple + unaccent, any word, `ts_rank`) | 0.40 | 0.53 | 0.67 | 0.39 | 2.5 / 5.2 |
| fts_lang (Polish Hunspell + English stems + unaccent) | 0.55 | 0.50 | 0.68 | 0.48 | 3.4 / 7.0 |
| trgm (pg_trgm word similarity) | 0.55 | 0.57 | 0.73 | 0.53 | 8.4 / 37.5 |
| **bm25** (pg_search, Polish stemmer, ASCII folding) | **0.60** | **0.58** | **0.78** | **0.57** | **1.7 / 2.9** |
| vec (pgvector HNSW, e5-small) | 0.40 | 0.28 | 0.32 | 0.38 | 0.8 / 1.6 + 10 / 17 to embed the query |
| hybrid_lang (RRF of fts_lang and vec) | 0.53 | 0.48 | 0.65 | 0.42 | 5.1 / 9.4 + embedding |
| hybrid_bm25 (RRF of bm25 and vec) | 0.57 | 0.55 | 0.70 | 0.49 | 3.3 / 6.5 + embedding |
| meili (Meilisearch keyword, `frequency` matching) | 0.42 | 0.62 | 0.65 | 0.41 | 5.2 / 11.8 |
| meili_hybrid (semantic ratio 0.5, same vectors) | 0.33 | 0.30 | 0.25 | 0.31 | 7.3 / 15.0 |

"Bilingual" is a simulated agent: the query words were translated by hand (see [Limits](#limits-of-this-research)).

### Recall@10 by kind of question (question form / bilingual form)

| Option | exact | inflect | no diacritics | typo | paraphrase | across languages | temporal | recent |
|---|---|---|---|---|---|---|---|---|
| window40 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0.06 / 0.06 | 0 / 0 | 1.00 / 1.00 |
| fts_or | 0.62 / 1.00 | 0.75 / 0.75 | 0.75 / 1.00 | 0.33 / 0.33 | 0.17 / 0.42 | 0.06 / 0.62 | 0.40 / 0.40 | 1.00 / 1.00 |
| fts_lang | 0.88 / 1.00 | 1.00 / 0.75 | 1.00 / 1.00 | 1.00 / 0.33 | 0.33 / 0.42 | 0.06 / 0.69 | 0.40 / 0.60 | 1.00 / 0.75 |
| trgm | 1.00 / 1.00 | 0.88 / 0.88 | 1.00 / 1.00 | 0.67 / 0.67 | 0.33 / 0.50 | 0.19 / 0.69 | 0.40 / 0.60 | 0.75 / 0.75 |
| bm25 | 1.00 / 1.00 | 1.00 / 1.00 | 1.00 / 1.00 | 1.00 / 0.67 | 0.42 / 0.58 | 0.12 / 0.69 | 0.40 / 0.60 | 1.00 / 1.00 |
| vec | 0.62 / 0.50 | 0.88 / 0.50 | 0.50 / 0.50 | 0.33 / 0 | 0.17 / 0 | 0.12 / 0.38 | 0.60 / 0.40 | 0.50 / 0.25 |
| hybrid_bm25 | 1.00 / 1.00 | 1.00 / 0.88 | 0.50 / 0.50 | 1.00 / 0.67 | 0.42 / 0.58 | 0.12 / 0.62 | 0.40 / 0.60 | 1.00 / 0.75 |
| meili | 0.88 / 0.88 | 0.62 / 0.88 | 1.00 / 1.00 | 0.67 / 1.00 | 0.08 / 0.25 | 0.19 / 0.56 | 0.20 / 0.40 | 0.50 / 1.00 |

What the misses are (read from the per-question results):

- **Across languages** is the main gap of every keyword option and is closed mostly by the agent's own translation.
- **Paraphrase** stays the weakest category everywhere (0.58 at best): "Who is on call during the summer break?" against
  "Firma zamknięta 10–21 sierpnia, dyżur techniczny ma Piotr" shares no word. These are the questions where a model that
  reads around, reformulates or reads summaries has to help.
- **The small embedding model loses to its own language.** With e5-small, an English question about a Polish message
  ranks English chatter on the same topic higher (for "How long does a station last on batteries…", the gold message
  ranked 145th; "Should the next station version keep the battery?" came first). Its weakness is not a filtering bug: an
  exact brute-force ranking gave the same order.
- **Temporal** questions need the date filter and "the latest of several": the filter helps (vec 0.60 had the right month's
  message), and choosing the newest is the reader's job.

### With a large embedding model (bge-m3)

The same bench with BAAI/bge-m3 (MIT, 568M parameters, 1,024 dimensions; keyword rows unchanged):

| Option | Question | Keywords | Bilingual | MRR (question) | Query p50 / p95 ms |
|---|---|---|---|---|---|
| bm25 (for comparison) | 0.60 | 0.58 | 0.78 | 0.57 | 1.8 / 2.7 |
| vec (bge-m3) | 0.63 | 0.53 | 0.57 | 0.62 | 1.5 / 2.8 + 76 / 101 to embed the query |
| hybrid_lang | 0.72 | 0.60 | 0.73 | 0.61 | 51 / 72 + embedding |
| **hybrid_bm25** | **0.75** | **0.63** | **0.80** | **0.65** | 46 / 58 + embedding |
| meili_hybrid | 0.50 | 0.45 | 0.50 | 0.49 | 10 / 21 + embedding |

By kind of question (question form): hybrid_bm25 reaches 0.50 across languages and 0.58 on paraphrase, against BM25's
0.12 and 0.42. In the bilingual form the difference shrinks to 0.75 / 0.67 against 0.69 / 0.58.

- **Cost:** text-embeddings-inference with bge-m3 was killed for memory at a 4 GiB limit while warming up (with the default
  8,192 batch tokens); with 2,048 batch tokens and 6 GiB it started and idled at 3.15 GiB, about 2 GiB while embedding.
  It embedded **9.9 messages a second** (10,000 in 17 minutes), 101 ms p50 / 180 ms p95 for one message and 76 / 101 ms
  for a query, on the two CPUs. Vectors and HNSW: 121.9 MiB per 10k messages (≈ 1.2 GiB per 100k, inferred).
- The fused statement as written scanned the vectors exactly instead of through HNSW (vector search alone: 2.8 ms p95), so
  its 58 ms is an upper bound; a production hybrid would run the two index scans separately.
- **Reading:** a strong multilingual model closes most of the gap on questions asked in plain words across languages, but
  it needs about a whole 4 GB server by itself; an agent that searches in both languages gets nearly the same recall from
  BM25 alone.

### Cost of each option

| | today | fts_or | fts_lang | trgm | bm25 | vec (e5-small) | Meilisearch |
|---|---|---|---|---|---|---|---|
| Index size, 10k messages | 8.1 MiB | 1.9 MiB | 3.1 MiB | 1.8 MiB | 3.8 MiB | 37.0 MiB (HNSW 16.9) | 50.8 MiB on disk |
| Inferred per 100k messages | ≈ 81 MiB | ≈ 19 MiB | ≈ 31 MiB | ≈ 18 MiB | ≈ 38 MiB | ≈ 370 MiB | ≈ 510 MiB |
| Build from scratch | 1.2 s | 0.1 s | 1.1 s | 0.15 s | 0.08 s | 70 s to embed + 1 s HNSW | 9.4 s |
| Write: statements, mean / p95 ms (none: 0.27 / 0.47) | 0.52 / 0.80 | — | 0.38 / 0.62 | 0.26 / 0.43 | 0.24 / 0.42 | 0.82 / 1.21 for the vector row | searchable 235 / 456 ms after the request |
| Added memory | — | — | 28.7 MB per connection that uses the dictionary; 188 ms first use | — | — | text-embeddings-inference ≈ 920 MiB | ≈ 130 MiB |
| Containers | — | — | — (needs dictionary files in the image) | — | — (needs the extension in the image) | +1 | +1 |

The messages table itself is 3.4 MiB for 10k messages (55 characters on average; the seed is short chat). A write with its
commit took 12–20 ms in every variant (all of them together: 17 ms); the commit's WAL flush dominates and the index's own
work is a fraction of a millisecond. The 100k figures are linear inferences, not measurements.

The embedding server with multilingual-e5-small embedded 144 messages a second in batches of 32 on the two CPUs, 14.5 ms
p50 / 24 ms p95 for one message, and 10 / 17 ms for a query. It was killed for running out of memory at a 1 GiB limit
while loading the model and settled at about 920 MiB.

### Access loss and deletion, verified per option

Each check changes PostgreSQL, then searches again at once in the same harness (results in `evidence/1242/`):

| Check | fts / trgm / bm25 / vec / hybrids | Meilisearch |
|---|---|---|
| a1: a person loses a restricted space's grant | not found at once | not found at once (readable spaces passed from PostgreSQL with each query) |
| a2: a space's AI is turned off, an agent searches | not found at once | not found at once (same) |
| a3: a guest searches a workspace-wide space they were not added to | never found | never found |
| a4: a person leaves the company | nothing found at once | nothing found at once |
| d1: the author removes a message (`removed_at`) | not found at once | **still found 174 ms** after the commit, until the delete job ran; not found with a PostgreSQL recheck of each hit |
| d2: a message is deleted outright | not found at once (vec: the vector row goes with the message, `ON DELETE CASCADE`; e5 did not find this message even before) | **still found 142 ms**; not found with the recheck |
| d3: a message is edited | not found by the removed words at once; the vector is dropped in the writer's transaction and the new one comes with the job | **found by the removed words 170 ms**, also with the recheck (the hit exists and is readable; only its words are stale) |
| Summaries (option D) | a summary covering the message is marked stale in the writer's transaction for d1, d2 and d3 | — |

Today's index removes a message's row in the same transaction too; the bench reproduces its trigger.

## Options compared

For a self-hosted **2 vCPU / 4 GB** server (#862), whose base stack's memory limits already add up to 2,944 MiB
(`docker/compose.yaml`: db 768, api 1,536, worker 512, keyring 128).

### (a) PostgreSQL full text done better

- **What changes from today:** match any of the words instead of all of them; fold accents; rank so that rare words count
  more than common ones; search every space the caller can read, with filters.
- **Variants measured.** `fts_or`: core PostgreSQL only (`unaccent` is in the official image's contrib), no image change;
  0.40 / 0.53 / 0.67. `fts_lang`: adds a Polish Hunspell dictionary (sjp.pl via Debian's `hunspell-pl`) chained with
  English stems; 0.55 / 0.50 / 0.68, but PostgreSQL loads an ispell dictionary into **each connection** that uses it:
  28.7 MB and 188 ms on first use per connection, measured. With a pool of 10 connections that is about 290 MB inside a
  768 MiB database container. `bm25`: ParadeDB's `pg_search` (Tantivy inside PostgreSQL), whose tokenizer has a Polish
  stemmer (algorithmic, no dictionary in memory) and ASCII folding; the best option measured. `trgm`: typo tolerance by
  trigram similarity per word; good recall but 30–50 ms p95, so it is a fallback for a query that found nothing, not the
  main path.
- **Why BM25 wins here** (inference from the results): `ts_rank` has no inverse document frequency, so in an "any word"
  query a common word ("stacja", "station") weighs as much as a rare one ("SHT45"); BM25 weighs words by rarity, which is
  what an "any word" query needs.
- **Operations.** `pg_search` ships as a PostgreSQL extension: Debian/Ubuntu `.deb`, RHEL `.rpm` and macOS packages for
  PostgreSQL 15–18 (release v0.26.6, 2026-11-08), **no Alpine/musl build**. Flux's database is `postgres:18.6-alpine`, so
  BM25 means a Debian-based database image built by Flux (official `postgres:18` plus the `.deb`, as the bench did from the
  ParadeDB image) and `shared_preload_libraries=pg_search`. Moving the data directory from musl to glibc changes the
  collation library, so the upgrade must rebuild text indexes (inference from PostgreSQL's collation rules; to be proved by
  #1241's upgrade matrix). It installs `vector` (pgvector) as a dependency. **Licence:** AGPL-3.0 (Community edition), the
  same as Flux. **Backups:** `pg_dump` / `pg_restore` (what `./flux backup` uses) restore the index definition and rebuild
  it. **Vendor claims** (ParadeDB docs, read 2026-11-12): MVCC-correct and transactional, crash recovery and point-in-time
  recovery in Community; physical replication of the index only in Enterprise (Flux is single-node, so this does not bite
  today). **Upgrades:** a new binary plus `ALTER EXTENSION pg_search UPDATE`, tied to Flux's release.

### (b) pgvector in the same database: hybrid search with reciprocal rank fusion

- Embeddings per message (messages are short; a chunk per message), an HNSW index, filters in the same statement with
  pgvector 0.8's iterative scans so a filtered query still returns k rows. Fusion by reciprocal rank (k = 60, the constant
  of Cormack et al. 2009) of the top 50 of each list.
- **Measured:** with multilingual-e5-small the vector list was weaker than keywords and dragged the fusion below BM25 alone.
  With bge-m3 the fusion was the best option measured for questions asked as-is (0.75 against BM25's 0.60), and level with BM25 for bilingual queries (0.80 against 0.78); see the bge-m3 table.
- **Operations.** `pgvector` has no Alpine package either but builds from source in an Alpine image (C, PostgreSQL
  licence). The vectors take about 10 times the space of the keyword index. The real cost is the model (next section).

### (c) A separate engine: Meilisearch

- Chosen as the separate engine to measure because it does keyword search with typo tolerance and filtering, and hybrid
  search with vectors the application provides, in one binary. **Licence:** the core is MIT; parts are the Enterprise
  Edition under BUSL-1.1 (`SPDX-License-Identifier: MIT AND BUSL-1.1`), so Flux would have to ship the Community build.
- **Measured:** keywords 0.62 (best of all for an agent's keywords, by typo tolerance and prefix matching), questions 0.42,
  hybrid worse; p95 ≈ 12 ms; about 130 MiB of RAM and 50.8 MiB of disk for 10k messages; a document becomes searchable
  ≈ 235 ms after it is sent.
- **Access** works only because the readable spaces are computed in PostgreSQL and passed as a filter with every query;
  storing permissions in the engine would make access loss wait for a re-index. **Deletion** leaves a window (above) unless
  every hit is rechecked in PostgreSQL, which closes deletion and access but not edits.
- **Operations:** one more container and volume, a second thing to back up and restore consistently with the database
  (a restore can bring back an index newer or older than the database), its own upgrades ("Database upgrades are not
  atomic", Meilisearch's update guide; dumpless upgrade since v1.12 databases), and an outbox job per write. For a
  4 GB server this is cost without a recall gain.
- **Others, by documentation only (not measured):** Qdrant (Apache-2.0) and LanceDB (Apache-2.0) are vector-first;
  Typesense is GPL-3.0; OpenSearch (Apache-2.0) is a JVM service far over the memory budget. Each would bring the same
  synchronisation, deletion-window and backup questions as Meilisearch.

### (d) Summaries without embeddings

- Per-conversation (and per-thread) summaries, each covering a run of messages and listing them, written by a model and
  stored as Flux records in the space, so only its readers see them; a "since <date>" summary read on demand; the window
  plus the summaries in the brief.
- **Measured here:** correctness only. A trigger marks every summary that covers an edited, removed or deleted message as
  stale in the writer's transaction (d1–d3 above), and readers never get a stale summary. One summary per 100 messages is
  100 rows for the 10k space.
- **Not measured: quality.** Whether summaries answer the questions needs the model run (strata and an API engine); the
  scenario builds one summary per 100 messages with the model and then answers from summaries plus the window.
- **Cost (inference):** summarising the 5,000-message conversation once is 50 calls of about 4,000 input tokens (≈ 200k
  tokens); keeping it current is one call per 100 new messages. Who pays is a product question (the owner whose agent needs
  it, by AG-11's payer rule), and a summary written by one person's agent becomes text every reader of the space sees.
- **Published results** point the same way as the measurements: summaries lose details that retrieval keeps (RAPTOR uses
  both levels; LongMemEval recommends decomposing sessions into facts as keys, not summaries alone), and long raw context
  degrades with distractors (Chroma 2025, "Lost in the Middle" 2023). Summaries help "what happened since …" questions;
  they do not replace search for "what was the order number".

## Embeddings: who computes them

| Who | Cost | Allowed? | Quality here |
|---|---|---|---|
| **The person's own connection** | OpenAI `text-embedding-3-small` $0.02 per 1M tokens (OpenAI pricing page, read 2026-11-12): 10k messages ≈ 0.25M tokens ≈ $0.005. Trivial money. | **Mostly impossible and against AG-11.** Anthropic offers no embedding model ("Anthropic does not offer its own embedding model", Claude docs, read 2026-11-12; it points to Voyage AI). Claude plans and ChatGPT plans run through the CLIs and expose no embeddings API to Flux. Only OpenAI, Gemini, OpenRouter and OpenAI-compatible keys could. And an index is shared: embedding a space sends every message in it to one person's provider, not only what that person's agent read, which is more than AG-11's "What leaves Flux". Vectors from different people's providers cannot be mixed in one index. | not measured |
| **A small local model in a container** | multilingual-e5-small (MIT, 118M parameters, 384 dimensions, Polish in its languages): 144 messages/s batched on 2 CPUs, a query in 10–17 ms, **about 920 MiB of RAM** for the server (text-embeddings-inference 1.9.4, Apache-2.0), killed at a 1 GiB limit while loading. bge-m3 (MIT, 568M, 1,024 dimensions): 9.9 messages/s, a query in 76–101 ms, **3.15 GiB idle**, killed at 4 GiB while warming up. | Yes: nothing leaves the server. Encrypted spaces and spaces with AI off are never embedded. | e5-small 0.40 (question), below every keyword option but `fts_or`. bge-m3 0.63 alone and 0.75 in a hybrid with BM25 (question form); 0.80 bilingual against BM25's 0.78. |
| **None** (keywords, the agent's own query rewriting and reading around) | Nothing to run. | Yes. | bm25 0.60, 0.78 bilingual. |

- **Polish quality** is the constraint. PIRB (Dadas et al., 2024) is the Polish retrieval benchmark to choose a model by;
  it found language-specific and hybrid (sparse + dense) retrievers best, which matches the measurement that keyword BM25
  with a Polish stemmer is strong.
- **Other licences checked:** bge-m3 MIT (568M parameters); EmbeddingGemma-300m under the Gemma terms, not an open-source
  licence, so not for Flux's image; Voyage's open-weight `voyage-4-nano` is Apache-2.0 (vendor claim, Claude docs), not
  measured.
- **Inference:** on a 4 GB server the base stack leaves about 1 GB for the system and page cache; a ~1 GB model server
  does not fit beside it without lowering other limits. An optional embedding container for larger servers is possible
  later, behind the same `flux_search`, if the measured gain justifies it.

## Context building: what others do and what the papers say

### Products (vendor claims, read 2026-11-12)

| Product | Long conversations | Retrieval and access | Stored? |
|---|---|---|---|
| **Slack AI** | Summaries of a channel, DM or thread for unread, 7 days or a custom range; daily recaps; "search answers" with citations (Slack help, "Guide to AI features") | Stateless RAG: each request carries its context; "Slack AI only operates on the data that the user can already see", using the requester's access lists (Slack engineering, 2024-04-18, updated 2025-07-17) | Summaries and answers are ephemeral where possible; derived content is tied to its source messages and invalidated when a message is removed |
| **Microsoft 365 Copilot** | Grounds on Graph content and a "Semantic Index" | "Semantic Index honors the user identity-based access boundary so that the grounding process only accesses content that the current user is authorized to access" (Microsoft Learn, ms.date 2026-07-09) | Prompts and answers kept as activity history |
| **Notion AI** | Pages split into spans, each embedded; an offline batch path and an online path from Kafka with sub-minute freshness; moved to turbopuffer (Notion blog, 2026-02-19) | Permissions stored as metadata on every span; a permission change updates metadata without re-embedding | Vectors in a separate store |
| **Linear** | Similar issues by embeddings; started on pgvector in Cloud SQL (Linear blog, 2023); later replaced Elasticsearch and pgvector with turbopuffer (turbopuffer customer page, vendor marketing) | — | Separate store |
| **Zulip** (open source, self-hosted) | Topic summaries (beta since Server 10.x): the server fetches recent messages of the topic the user can access and sends them to a model configured through LiteLLM; midsize models (~70B) summarised better than ~8B ones; over 90% of tokens are input (Zulip docs 12.1) | Full-text search on PostgreSQL's built-in FTS (English stemming only), updated asynchronously after delivery; PGroonga as the multilingual option (Zulip docs) | Summaries on request |

Common pattern: **retrieval at request time, filtered by the requester's permissions at query time; summaries computed on
request for a range, and invalidated with their sources when kept.** None of the self-hosted products (Zulip) uses
embeddings; the cloud products that do run them on separate infrastructure.

### Anthropic and OpenAI guidance (read 2026-11-12)

- **Anthropic, "Effective context engineering for AI agents" (2025-09-29):** context is "a finite resource with diminishing
  marginal returns" ("context rot"); prefer "just in time" retrieval where the agent keeps lightweight identifiers and
  loads data with tools, as Claude Code does with grep and head instead of a vector index; compaction (summarise near the
  limit, clear old tool results); structured notes outside the window; sub-agents that return 1–2k-token summaries.
- **Anthropic, "Contextual Retrieval" (2024-09-19, vendor result):** embeddings plus BM25 cut top-20 retrieval failures by
  49%, plus reranking by 67%; under ~200k tokens, put the whole knowledge base in the prompt with caching.
- **Prompt caching.** Anthropic: cache writes 1.25× (5 minutes) or 2× (1 hour), reads 0.1× of the input price (0.05× on Opus
  5.5 and Sonnet 5.5); the prefix order is tools → system → messages, and a change invalidates its level and everything
  after. OpenAI: automatic for prefixes of at least 1,024 tokens, reads 0.1× on GPT-5.6 and later, 30-minute default
  lifetime; "place stable … content at the start". **Consequence for Flux (inference):** a brief whose stable part (the
  agent's instructions, tools, the space) comes first and whose message window comes last caches well across a tool loop;
  each search result appended later is new input once and cached thereafter. A sliding window of the latest messages
  changes with every new message, so it is never cached across runs, which is one more reason to keep it short.
- **OpenAI file search (vector stores):** semantic search, with hybrid keyword + vector fusion by reciprocal rank as an
  option, 800-token chunks with 400 overlap by default, attribute filters, $0.10/GB/day storage.

### Papers and benchmarks (published results)

- **Lost in the Middle** (Liu et al., arXiv 2023-07-06; TACL 2024): models use information at the start and end of a long
  context better than in the middle.
- **Retrieval meets Long Context LLMs** (Xu et al., NVIDIA, arXiv 2023-10-04; ICLR 2024): a 4k-context model with retrieval
  matched a 16k long-context model, and retrieval helped at every context length.
- **Long-Context LLMs Meet RAG** (Jin et al., arXiv 2024-10-08): answer quality first rises then falls as more passages are
  added; "hard negatives" (relevant-looking passages) are the cause. Fewer, better passages beat more.
- **Context Rot** (Chroma technical report, 2025-07-14, vendor research): 18 models degrade with input length; one
  distractor already hurts; on LongMemEval, focused prompts (~300 tokens) beat full prompts (~113k tokens) for every model.
- **LongMemEval** (Wu et al., arXiv 2024-10-14; ICLR 2025): commercial assistants and long-context models drop about 30% on
  memory across sustained chats; indexing → retrieval → reading, with sessions decomposed into facts, keys expanded with
  facts and time-aware query expansion.
- **LoCoMo** (Maharana et al., arXiv 2024-02-27): very long conversations (300 turns, up to 35 sessions); models struggle
  with long-range temporal and causal questions.
- **RAPTOR** (Sarthi et al., arXiv 2024-01-31; ICLR 2024): a tree of recursive summaries retrieved together with the raw
  chunks beats either alone.
- **Recursively Summarizing Enables Long-Term Dialogue Memory** (Wang et al., arXiv 2023-08-29) and **MemGPT** (Packer et
  al., arXiv 2023-10-12): rolling summaries and paged memory as the way past a fixed window.
- **Reciprocal Rank Fusion** (Cormack, Clarke and Büttcher, SIGIR 2009): the fusion used for the hybrids, k = 60.
- **Multilingual E5** (Wang et al., arXiv 2024-02-08), **M3-Embedding / bge-m3** (Chen et al., arXiv 2024-02-05) and
  **PIRB** (Dadas et al., arXiv 2024-02-20): the models and the Polish benchmark.

**What follows for Flux (inference):** keep the start of the context small and stable, retrieve a few precise passages with
their neighbours rather than a long window, let the agent search again with other words or the other language, and use
summaries for "what happened" questions over a range, not as the only memory.

## Tools

Proposed shapes (names and fields to be settled in the contract; both engines get the same tools, so a CLI run through MCP
and an API-key run through function calls see the same results):

- **`flux_search`** replaces `flux_search_project` for agents.
  - `q` (any words; ranked by BM25; quotes for a phrase), `in` (one space, one conversation or a task's discussion; default:
    every space the agent may read now), `from` (a person or agent), `after` / `before` (dates), `kind` (message, doc, task,
    decision, map), `limit` (default 10).
  - Each hit: the message's id and link, place and conversation, author as people see them (#1160), time, a snippet with the
    matches marked, and `sequence` so the agent can read around it.
  - Description tells the agent to search in each language the space uses and to try other words when a search finds
    little (the bilingual result above); the brief names the space's languages.
  - Filtering by what the caller can read now and by the space's AI switch happens in the same statement, as today
    (`memberFilter`, AG-10), so a run never sees a hit it could not open.
- **`flux_read_around`**: `messageId`, `before` and `after` (default 5, at most 25 each): the hit with its neighbours in
  its conversation, the same author labels and the same access check. A hit plus 3 neighbours each side for the top 3 hits
  is about 1,100 tokens in the bench, against 1,600 for today's 40-message window.
- **`flux_summarize` / "since <date>"** (optional, see the questions): a summary of one conversation or thread for a range,
  computed on request from the messages the caller can read, by the calling agent's own model in its own run (so its owner
  pays, AG-11), cached only if Hubert chooses stored summaries.
- **The brief (API-key runs):** a smaller window (for example the latest 20 messages instead of 40), a line saying how many
  older messages exist and that `flux_search` and `flux_read_around` find them, and the space's languages. The window size
  is set by the answer-accuracy evaluation, not guessed. CLI runs get the same brief text.
- `flux_get_conversation` stays for paging; its page size is unchanged.

## Freshness, deletion, access and storage

- **Indexing on write.** A keyword index inside PostgreSQL (generated tsvector or `pg_search`) is maintained by the
  writer's own statement: no job, no lag, a quarter of a millisecond of statement time per message in the bench. This is
  how today's index works and it should stay so.
- **No new polling.** The idle target is at most 100 statements a minute and v0.2 measured 95–97
  (`docs/development/performance-2026-11.md`); a new pg-boss queue adds its own checks and a daily sweep. An in-transaction
  index adds nothing at idle. If embeddings ever come, their job must reuse an existing queue or wake on NOTIFY only.
- **Edits and deletes.** In PostgreSQL the index follows the row in the same transaction (verified d1–d3). A vector is
  dropped by a trigger in the writer's transaction and re-embedded later, so between the two the message is found by
  keywords only, never by its old meaning. An external engine needs an outbox job per write and leaves a window (verified:
  140–175 ms here, longer under load or while the engine is down); rechecking each hit in PostgreSQL closes it for
  deletion and access, not for edits.
- **Summaries.** Stored summaries list the messages they cover; a trigger marks them stale when any of those is edited,
  removed or deleted, in the same transaction (verified). A stale summary is not shown and is rewritten on next use.
- **Access.** Every option was filtered at query time by what the caller can read now (grants, company role, the space's AI
  switch, membership), in the same statement for PostgreSQL and computed per query for Meilisearch. All four access checks
  passed for every option. The design rule: never store permissions in the index; store the space, and resolve readable
  spaces at query time (Slack, Copilot and Notion state the same principle).
- **Encrypted spaces** stay out: their messages are sealed in the database and have their own sealed search; no keyword or
  vector index over their text and no summaries (AG-10, "No AI in encrypted spaces").
- **Storage per 100k messages (inference from the 10k measurement, chat of ~55 characters):** messages ≈ 35 MiB; today's
  index ≈ 81 MiB; a BM25 index ≈ 38 MiB; vectors with HNSW (384 dimensions) ≈ 370 MiB; Meilisearch ≈ 510 MiB. Longer
  messages grow the keyword indexes roughly with the text and the vectors not at all (one per message).
- **Today's index stays** for the people's search (titles, prefixes as you type, task numbers), unless the implementation
  shows the BM25 index can serve both; that is an engineering choice inside part 1 of the plan.

## Recommendation and what changes for an operator

**Recommended (for the recorded decision, subject to the questions below):**

1. **Retrieval:** BM25 in Flux's own PostgreSQL with `pg_search` (Polish stemmer, ASCII folding), "any word" queries,
   filtered by what the caller can read now in the same statement. **Fallback if Hubert does not want the extension or
   the image change:** core PostgreSQL with `unaccent` and "any word" queries (`fts_or`: 0.40 / 0.53 / 0.67), which needs
   no new image and still beats today by far; the Polish Hunspell dictionary is not recommended because of its memory per
   connection.
2. **No embeddings and no separate engine in v0.2.1.** A model good enough to help (bge-m3) needs about a whole 4 GB server;
   e5-small fits better but hurts. Revisit when a model that fits the target beats BM25 on this bench, or as an optional
   container for larger servers (question 2).
3. **Tools:** `flux_search` (all readable spaces, filters, snippets with links) and `flux_read_around`, the same for the
   server engine and the CLIs; tool descriptions and the brief tell the agent to search in the space's languages.
4. **Brief:** a smaller window (size chosen by the evaluation) plus a line on how to find older messages.
5. **Summaries:** an on-demand "summarise this conversation since <date>" tool first; stored, invalidated summaries only if
   the evaluation shows they answer better per token (Hubert's choice, below).

**What changes for a self-hosting operator** (with option 1 as recommended):

| | Today | After |
|---|---|---|
| Containers | db, migrate, api, worker, keyring | the same; no new service |
| Database image | `postgres:18.6-alpine` (official, by digest) | a Flux-built Debian `postgres:18` image with `pg_search` (and `pgvector` as its dependency), by digest in the release |
| PostgreSQL settings | defaults | `shared_preload_libraries=pg_search` |
| RAM | base limits 2,944 MiB | unchanged limits; peak database use in the bench 279 MiB of its 768 |
| Disk | — | about 4 MiB of index per 10k short messages (≈ 38 MiB per 100k) |
| Backups and restore | `./flux backup` / `restore` (`pg_dump`) | unchanged; the index is rebuilt on restore (seconds for 10k messages) |
| Upgrade | migrations | the first upgrade switches the database image (musl → glibc): its migration path, including rebuilding text indexes, goes through #1241's upgrade matrix |
| Licences | — | `pg_search` AGPL-3.0 (same as Flux), `pgvector` PostgreSQL licence |

With the fallback (core PostgreSQL), nothing changes for the operator except a migration and a few MiB of disk.

## Implementation plan

Issue-sized parts for v0.2.1, in order, after the decision is recorded (#1242 step 2). Each is one PR of at most about 50
files. Migrations follow #1241: forward-only, never editing a released file, working on data left by v0.2.0, and covered by
`check_upgrade_matrix.sh`.

1. **Database image and migration (index).**
   - With `pg_search`: a Flux-built database image (Debian `postgres:18` + the pinned `pg_search` `.deb`, by digest),
     `shared_preload_libraries`, the release and `./flux upgrade` switching an existing v0.2.0 database from the Alpine image
     with its text indexes rebuilt; a migration `CREATE EXTENSION pg_search` and the BM25 index over messages (project and
     DM messages, docs and tasks as decided), with the space, conversation, author and time as filter fields.
   - Without it (fallback): a migration adding the `simple_unaccent` configuration and an "any word" tsvector with its GIN
     index.
   - Acceptance: the upgrade matrix passes from v0.2.0; index size and write cost on the seeded space within this note's
     figures; `check_performance.sh` idle and first-screen targets still met.
2. **`flux_search` and `flux_read_around` (tools).** Contracts (`agent-tools.ts`, MCP and function-calling schemas), core use
   cases over the existing access policy (`memberFilter`, AG-10's switch), repository statements, MCP registration for the
   CLIs and the server engine; `flux_search_project` kept for people or retired by the decision. Acceptance: recall@10 on
   the bench at least the recorded option's figure; every access and deletion check of this note as an API test.
3. **The brief.** A smaller window, the "older messages" line and the space's languages, the same for both engines.
   Acceptance: fewer input tokens per run than today on the bench; answer accuracy not lower than today's on any category
   (part 5).
4. **Summaries.** As decided: an on-demand summary tool; or stored summaries with the invalidation trigger, a records table
   (migration), who pays, and how they show to people. Acceptance: a removed or edited message invalidates its summaries in
   the same transaction (test); answer accuracy per token on the bench.
5. **Evaluation harness in `check_ai_real_model.sh`.** Move this bench's seed and test set into an app fixture that loads the
   10k-message space into a real Flux through its API or SQL, and add a scenario that asks each question through the real
   brief and tools (both CLIs and the API engine, on strata or the provider mock), scoring `answer_check` and counting
   input tokens; keep `scripts/eval/retrieval` for index comparisons. Acceptance: one command reports recall@10, answer
   accuracy, tokens and latency for today's window and the new design.

Dependencies: 1 → 2 → 3; 5 can start at once (it measures today first); 4 after the decision on summaries.

## Evaluation still to run

#1242's acceptance asks for answer accuracy on strata and an API engine. Neither was run here:

- **strata** (the local Qwen model, llama.cpp) is stopped because it uses about 50 GB of RAM; the coordinator schedules it on
  a quiet host. **The scenario is ready:**

  ```sh
  cd scripts/eval/retrieval
  ./run.sh load index                       # the bench, as measured here
  # with strata already started by the coordinator:
  BENCH_LLM_CONTAINER=strata BENCH_LLM_MODEL=<strata's model name> ./run.sh answer --build-summaries
  ```

  It attaches strata to the bench network under the host name flux-model, reads its key from `/data/state/api-key`, writes one summary per
  100 messages of each asked-in conversation with the model, then answers all 60 questions four ways (`window40`,
  `search_around`, `summaries`, `window_search`) and writes accuracy per category, input tokens and seconds to
  `out/answers.json`. `BENCH_ANSWER_SEARCH` picks the search option (default `hybrid_bm25`; `bm25` for the recommended
  design without embeddings). Expect several hours: about 100 summary calls of ~4k tokens and 240 answers.
- **An API engine:** only with a real key, which this host has none of; `BENCH_LLM_URL`, `BENCH_LLM_KEY` and
  `BENCH_LLM_MODEL` take any OpenAI-compatible endpoint. With the stand-in (`./run.sh answer --mock`) the plumbing and token
  counts are checked (result pending in this draft; it will be filled before review).
- These runs are static (the context is built before the model sees it). The agentic run with the real tools is part 5 of
  the plan.

## Limits of this research

- **The corpus is synthetic.** Templates give a topical, repetitive chatter; real chat is more varied and longer. The gold
  messages are more distinctive than real ones. Absolute recall will differ on real data; the ranking of the options is
  the useful result, and the bench is built to be rerun on a real export later.
- **One author wrote the facts, the questions and the translations.** The `keywords` were taken from each question's own
  words, and `keywords_other` are literal translations of those keywords, but the same person knew the gold messages. The
  bilingual figures simulate a capable agent; the agentic run (part 5) measures the real one.
- **60 questions** give coarse figures: one question is 0.017 of recall overall and up to 0.33 in a small category.
  Differences under about 0.05 overall are noise.
- **Latency** was measured while other agents' Docker suites ran on the host; the order between options held across three
  runs, the absolute values did not exactly.
- **Embedding models:** two were measured (e5-small and bge-m3); others (multilingual-e5-base, Polish-specific models from
  PIRB, voyage-4-nano) were not.
- **Not measured:** answer accuracy (above), the agentic tool loop, docs and tasks in the index (only messages), DMs
  (the same audience rule applies), 100k messages (inferred linearly).

## Sources

Read on 2026-11-12 unless noted. Vendor pages are claims of their vendors.

**Vendors and products**

- Anthropic, "Effective context engineering for AI agents", 2025-09-29: <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>
- Anthropic, "Introducing Contextual Retrieval", 2024-09-19: <https://www.anthropic.com/news/contextual-retrieval>
- Claude docs, Prompt caching (no date on the page): <https://platform.claude.com/docs/en/build-with-claude/prompt-caching>
- Claude docs, Embeddings ("Anthropic does not offer its own embedding model"): <https://platform.claude.com/docs/en/build-with-claude/embeddings>
- OpenAI docs, Retrieval (vector stores, hybrid ranking): <https://developers.openai.com/api/docs/guides/retrieval>
- OpenAI docs, Prompt caching: <https://developers.openai.com/api/docs/guides/prompt-caching>
- OpenAI pricing (embeddings, file search): <https://developers.openai.com/api/docs/pricing>
- Slack Engineering, "How we built Slack AI to be secure and private", 2024-04-18, updated 2025-07-17: <https://slack.engineering/how-we-built-slack-ai-to-be-secure-and-private/>
- Slack help, "Guide to AI features in Slack": <https://slack.com/help/articles/25076892548883-Guide-to-AI-features-in-Slack>
- Microsoft Learn, "Data, Privacy, and Security for Microsoft Copilot", ms.date 2026-07-09: <https://learn.microsoft.com/en-us/copilot/microsoft-365/microsoft-365-copilot-privacy>
- Notion, "Two years of vector search at Notion", 2026-02-19: <https://www.notion.com/blog/two-years-of-vector-search-at-notion>
- Linear, "Using AI to detect similar issues" (2023): <https://linear.app/blog/using-ai-to-detect-similar-issues>; turbopuffer customer page (marketing): <https://turbopuffer.com/customers/linear>
- Zulip docs, AI integrations (12.1): <https://zulip.readthedocs.io/en/12.1/production/ai-integrations.html>; full-text search: <https://zulip.readthedocs.io/en/latest/subsystems/full-text-search.html>
- ParadeDB docs: upgrading <https://www.paradedb.com/docs/operate/deploy/upgrading.md>, guarantees <https://www.paradedb.com/docs/concepts/guarantees.md>, Community vs Enterprise <https://www.paradedb.com/docs/operate/deploy/enterprise.md>; release v0.26.6 (2026-11-08) assets: <https://github.com/paradedb/paradedb/releases/tag/v0.26.6>
- pgvector README (iterative index scans since 0.8.0): <https://github.com/pgvector/pgvector>
- Meilisearch, updating (dumpless upgrade, "Database upgrades are not atomic"): <https://www.meilisearch.com/docs/learn/update_and_migration/updating>; licence `MIT AND BUSL-1.1`: <https://github.com/meilisearch/meilisearch/blob/main/LICENSE>
- Licences from GitHub (2026-11-12): ParadeDB AGPL-3.0, pgvector PostgreSQL licence, Qdrant Apache-2.0, Typesense GPL-3.0, OpenSearch Apache-2.0, LanceDB Apache-2.0, text-embeddings-inference Apache-2.0, pg-boss MIT.
- Models (Hugging Face API, 2026-11-12): intfloat/multilingual-e5-small (MIT, 117.7M parameters, Polish listed); BAAI/bge-m3 (MIT); google/embeddinggemma-300m (Gemma terms).

**Papers** (arXiv submission dates from the arXiv API)

- Liu et al., "Lost in the Middle: How Language Models Use Long Contexts", arXiv:2307.03172, 2023-07-06.
- Xu et al., "Retrieval meets Long Context Large Language Models", arXiv:2310.03025, 2023-10-04.
- Jin et al., "Long-Context LLMs Meet RAG: Overcoming Challenges for Long Inputs in RAG", arXiv:2410.05983, 2024-10-08.
- Wu et al., "LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory", arXiv:2410.10813, 2024-10-14.
- Maharana et al., "Evaluating Very Long-Term Conversational Memory of LLM Agents" (LoCoMo), arXiv:2402.17753, 2024-02-27.
- Sarthi et al., "RAPTOR: Recursive Abstractive Processing for Tree-Organized Retrieval", arXiv:2401.18059, 2024-01-31.
- Wang et al., "Recursively Summarizing Enables Long-Term Dialogue Memory in Large Language Models", arXiv:2308.15022, 2023-08-29.
- Packer et al., "MemGPT: Towards LLMs as Operating Systems", arXiv:2310.08560, 2023-10-12.
- Hong, Troynikov and Huber, "Context Rot", Chroma technical report, 2025-07-14: <https://www.trychroma.com/research/context-rot>
- Cormack, Clarke and Büttcher, "Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods", SIGIR 2009.
- Wang et al., "Multilingual E5 Text Embeddings: A Technical Report", arXiv:2402.05672, 2024-02-08.
- Chen et al., "M3-Embedding" (bge-m3), arXiv:2402.03216, 2024-02-05.
- Dadas et al., "PIRB: A Comprehensive Benchmark of Polish Dense and Hybrid Text Retrieval Methods", arXiv:2402.13350, 2024-02-20.

## Questions for Hubert

Each needs an answer before the decision is recorded; the recommended answer is first.

1. **Search engine.** BM25 with the `pg_search` extension in Flux's PostgreSQL (best measured; needs a Flux-built Debian
   database image and a one-time image switch on upgrade), or core PostgreSQL only ("any word" + accents folded; weaker on
   Polish inflection and ranking, no image change)? A separate engine (Meilisearch or similar) is not recommended.
2. **Embeddings.** None in v0.2.1 (recommended), or an optional local embedding container (bge-m3 class: +0.15 recall@10
   on questions asked as-is, about 3–4 GiB of RAM, 10 messages a second to index) for servers well above the 4 GB target?
   Using a person's own connection to embed a space is not recommended (most connections cannot, and it sends the whole
   space to one person's provider).
3. **Summaries.** On-demand only (a tool that summarises a conversation or thread since a date, paid by the asking agent's
   owner, nothing stored; recommended first), or stored summaries that every reader of the space can see, kept current and
   invalidated on edits and deletes? If stored: whose connection writes them, and are they shown to people or only to
   agents?
4. **The window in the API brief.** Shrink it (for example to 20) and rely on search, with the final size set by the answer
   accuracy evaluation (recommended), or keep 40 and add search on top (more tokens per run)?
5. **Scope of the new search.** Every space the agent may read now (recommended; a run already may read them), or only the
   run's own space as today, with other spaces on request?
6. **What is indexed for agents.** Messages of spaces and of DMs where AI is used, docs and tasks (recommended: everything
   `flux_search_project` covers today, plus DM messages only within a DM run), or messages only?
7. **People's search.** Does the people's search box move to the same BM25 ranking ("any word", ranked) or keep today's
   "every word" behaviour for people and use the new search for agents only?
8. **Answer-accuracy run.** May the coordinator schedule strata for the prepared scenario (several hours, ~50 GB RAM), and is
   there an API engine key to run the same scenario once, or does the provider mock stand in for the API engine?
