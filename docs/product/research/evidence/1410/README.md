# Agents answer better: the evaluation of #1410

**Status:** measured 2026-11-13 on this host in Docker with the founder's Anthropic key, through the #1295 harness
(`scripts/check_ai_eval.sh`, PR #1409 at `1b4f46459`), Claude Haiku 5.5 as the agent and the judge, all 62 questions. Every figure is
an observation of these runs. Spend of #1410: **$0.525** of its $1.50 (ledger `.worktrees/ai-eval-evidence/spend.tsv`).

## Runs

| Label | Product code | Evidence dir (host) | $ (agent + judge) |
| --- | --- | --- | --- |
| main-1 | `main` a0237fbab | `.worktrees/ai-eval-evidence/20261113T112229Z` | 0.253 |
| main-2-from-1381 | `main` 58c10e9e4 (the main arm #1381 ran on the same harness head; no spend of #1410) | `…/20261113T111834Z` | (0.261, #1381's) |
| 1410-1 | this branch at 2b5a38afd (without the `from` fallback of 231b795ed) | `…/20261113T114327Z` | 0.141 |
| 1410-2 | this branch at 231b795ed | `…/20261113T120334Z` | 0.130 |

The JSON of each run is under `~/flux-evidence/v021/1410/runs/` on the host; the per-question tables are the `results-*.md` here.

## Accuracy per category

| Category | n | main-1 | main-2 | 1410-1 | 1410-2 |
| --- | --- | --- | --- | --- | --- |
| old_messages | 15 | 0.900 | 0.933 | 0.933 | 0.933 |
| recent | 2 | 1.000 | 1.000 | 1.000 | 1.000 |
| wiki | 8 | 1.000 | 1.000 | 1.000 | 1.000 |
| file | 6 | 0.000 | 0.000 | 0.000 | 0.000 |
| task_decision_map | 7 | 1.000 | 1.000 | 1.000 | 1.000 |
| **two_source** | 7 | 0.643 | 0.571 | **0.786** | **0.786** |
| **relative_date** | 10 | 0.900 | 0.900 | 0.900 | 0.900 |
| no_answer | 7 | 1.000 | 1.000 | 1.000 | 1.000 |
| **all** | 62 | 0.823 | 0.823 | **0.847** | **0.847** |

## Cost, cache and runs without an answer

Prompt tokens are the whole prompt (uncached + written to the cache + read from it), from the provider's usage of each request.

| | main-1 | main-2 | 1410-1 | 1410-2 |
| --- | --- | --- | --- | --- |
| Cost per question (agent) | $0.00394 | $0.00408 | **$0.00213** | **$0.00196** |
| Prompt tokens per question | 35,915 | 37,198 | 39,272 | 36,300 |
| of which read from the cache / written / uncached | 0 / 0 / all | 0 / 0 / all | 27,639 / 11,625 / 8 | 25,598 / 10,694 / 8 |
| Cache hit rate (read ÷ prompt) | 0 | 0 | **0.704** | **0.705** |
| Requests per question | 2.98 | 3.05 | 3.15 | 2.97 |
| Runs without an answer | 0 | 1 (`two06`, `input_too_large`) | **0** | **0** |
| `flux_get_task_discussion` calls (62 questions) | 1 | 1 | 3 | 3 |
| Seconds per question p50 | 6.1 | 6.2 | 7.1 | 6.2 |

## What changed per question (read from the answers and the recorded calls)

- **Two sources** (0.64 / 0.57 → 0.79 / 0.79): `two02` (release owner + soak test) and `two03` correct in both runs of the branch; `two06`
  (the city's complaint + the antennas ordered in a task's discussion) reads the task's discussion through `flux_get_task_discussion`
  after the task hit says it has one (correct in 1410-2; on main it was half right or ended without an answer). `two04` stays half
  right in every run (the new developer's start date is not found) and `two07` needs a file's contents (#1382).
- **Relative dates** (0.90 in all four): `rel02` ("What did Maurycy say about the supplier in early October?") was 0 on main in both
  runs. In 1410-1 the agent now passes `from: "Maurycy"` (the name resolved), but none of his words match "supplier" ("Elfa raises the
  price…"), so the search found nothing; 231b795ed lists what the author wrote within the filters when none of it has the words, and
  in 1410-2 `rel02` is correct with two searches. In 1410-2 `rel06` (Piotr's firmware, early last month) was not found (the agent read
  around the wrong replies); it is correct in the other three runs, so the category stays at 0.90 with one question each way.
- **Old messages:** `old02` and `old12` correct in both branch runs (0 and 0.5 on main-1); `old13` wrong once in 1410-2.

## Limits

- Two runs a side; the judge is Claude Haiku 5.5 without a temperature setting. The spread between the two main runs is 0 overall and
  0.07 on two sources; the branch beats both main runs on two sources and overall in both of its runs.
- The relative-date category did not improve on these questions (one fixed, one missed), against the issue's acceptance that it improve:
  the `from` fix is what moved `rel02`, and the remaining misses are retrieval, not names.
- `compare.py`'s "In tok/q" counts only uncached input; with caching that is 8 a question, so the table above counts the whole prompt.
