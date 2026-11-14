# Answer accuracy of Flux AI on a real API key (#1295)

**Status:** measured 2026-11-13 and 2026-11-14 in 15 recorded runs, from the baseline at main `64e4ff4ce` to the v0.2.1 release gate at
main `95a6a6d1c`: **0.76 at the baseline, 0.944 at the gate** on 62 questions with Claude Haiku 5.5, at $0.0041 and $0.0029 a question
([progression](#progression)). Spend of all runs of this issue $5.77 of $8 (the ledger below). Founder decision on #1295, 2026-11-13: every AI
change of v0.2.1 must raise this score or it is dropped. Measured on this host in Docker with the founder's Anthropic key; every figure below
is an observation of these runs unless it says otherwise.

## The command

```sh
scripts/check_ai_real_model.sh --eval        # the same as scripts/check_ai_eval.sh
FLUX_EVAL_LABEL=haiku-5-5-baseline-1 FLUX_EVAL_RECORD=docs/product/research/evidence/1295 scripts/check_ai_eval.sh
FLUX_EVAL_MODEL=claude-sonnet-5-5 FLUX_EVAL_MAX_USD=4 scripts/check_ai_eval.sh
FLUX_EVAL_VARIANT=wiki-index FLUX_EVAL_LABEL=... scripts/check_ai_eval.sh      # a change under evaluation (#1381, #1382)
FLUX_EVAL_QUESTIONS=relative_date,wiki scripts/check_ai_eval.sh               # some categories or question ids only
python3 scripts/eval/answers/compare.py docs/product/research/evidence/1295/results-*.json
```

One run takes about 20 minutes (images, 10,000 messages loaded through the API, 62 questions, the judge) and costs about $0.25 on Claude
Haiku 5.5. Run it under the shared Docker slot limiter. The key is read from `~/.config/flux-eval/anthropic.key` (mode 600) into the
environment of the two runner commands that need it, saved through Connect AI like any key (Flux seals it), and never printed or written.
Every run's spend, from the provider's own usage, is appended to a ledger (`.worktrees/ai-eval-evidence/spend.tsv`); a run stops at its cap
(`FLUX_EVAL_MAX_USD`, default $2) and at what is left of the issue's $8 (`FLUX_EVAL_BUDGET_USD`).

## What it does

1. **The workspace** (`scripts/eval/answers/workspace.py`, `workspace.json`): the retrieval bench's 10,000 Polish and English messages of
   #1242 (one company, 7 spaces, 7 conversations, one with 5,000 messages, dated March to November), plus 8 Wiki pages, 3 tasks with
   discussions, 2 accepted decisions, 2 maps, 6 files (2 PDF, Markdown, 2 CSV, DOCX) whose facts are only inside the file, a ninth person
   (Maurycy) and 24 messages placed at ages relative to the day of the run, with near-duplicates on the same topic at other dates. The
   bench's dates move forward by whole weeks after 2026-11-13, so a rerun next month keeps "last week" and "about two months ago" true.
2. **Loaded into a real Flux** through its API as its people write it (sign-up, company, spaces, grants, conversations, files, Wiki,
   tasks, decisions, maps), then each message moved to its date in the database (the search index takes the new date in the same trigger;
   the run checks that all 10,093 indexed message dates match).
3. **The engine**: the production personal-runs composition (`FLUX_PERSONAL_RUNS=on`), the owner's key saved through Connect AI, her
   agent on the evaluated model, its real brief and tools. Web search is off (`FLUX_WEB_READS=off`): the questions are about the
   workspace, and the cost stays bounded. The worker's Anthropic requests go through a recording proxy (`app/tests/app/support/eval-proxy.ts`,
   test only, `FLUX_TEST_ANTHROPIC_PROXY_URL`) that passes them on unchanged, records each request and its usage, and refuses requests
   past the cap. Until #1426 Flux sent no `cache_control`, so nothing was cached (the baseline); from #1426 on an Anthropic run caches its
   prompt. Since #1441 (the runs from `pi-1441-1`) the agent is pi in the agent runtime, as in production: its requests go through the worker's
   model gateway, whose Anthropic upstream is the proxy, so the cap and the ledger see every request.
4. **The questions** (`questions.json`, 62): each asked once, a fresh agent per question in the owner's private chat (its last six
   exchanges would otherwise carry earlier answers), or `/ai` in a conversation where the question is about "this space".
5. **Scoring**: an LLM judge (Claude Haiku 5.5, effort low, a fixed rubric in `ai-eval.check.ts`; API version 2026-10-21 refuses a
   temperature, so it cannot be set to 0) grades correct (1) / partial (0.5) / wrong / don't know (0) against a reference answer; exact
   keys (regular expressions on the answer, Polish letters folded) beside it; whether the gold source and the answer's own values reached
   the model through a tool; citations; for the relative-date questions whether the agent filtered by date (`flux_search` after/before or
   `flux_summarize`); tokens, cost and latency per question from the provider's usage.

| Category | n | What it measures |
| --- | --- | --- |
| old_messages | 15 | facts only in old messages (the bench's exact, inflection, typo, no-diacritics, paraphrase and cross-language questions) |
| recent | 2 | facts from the last days (one still in the brief's 20-message window) |
| wiki | 8 | facts only on a Wiki page |
| file | 6 | facts only inside an attached file (PDF, Markdown, CSV, DOCX): file contents are not searchable yet, so this measures the gap #1382 closes |
| task_decision_map | 7 | facts only in a task's discussion, a decision or a map thought |
| two_source | 7 | an answer that needs two sources (message + Wiki, decision + Wiki, message + task, file + message) |
| relative_date | 10 | old messages asked about with relative dates in both languages ("jakieś półtora miesiąca temu", "in early October", "last week" in this space), with near-duplicates at other dates (founder request 2026-11-13) |
| no_answer | 7 | nothing in the workspace answers it; the agent must say it does not know |

## Results

### Progression

Claude Haiku 5.5 on every row, 62 questions, web search off, the same judge. One row is one step of the product; the labels of its runs are in
the second column. Raw results of every run are in this folder: `results-<label>.json`, its table `results-<label>.md` and the harness's
result line `summary-<label>.txt`.

| Step | Runs (labels) | Flux | Engine | Accuracy | $ per question |
| --- | --- | --- | --- | --- | --- |
| Baseline | `haiku-5-5-baseline-1`, `-2` | `64e4ff4ce` | the worker's own loop, no prompt cache | 0.782, 0.734 (mean **0.76**) | 0.0041 |
| Main, after the questions were made well-defined in review | `1381-main-1`, `1410-main-1` | `58c10e9e4`, `a0237fbab` | the worker's loop, no cache | 0.823, 0.823 (**0.82**) | 0.0041, 0.0039 |
| Name search, task discussions, an answer at the size limit and the prompt cache (#1410) | `1410-mine-1`, `1410-mine-2` | `58c10e9e4` + #1410 | the worker's loop, Anthropic prompt cache | 0.847, 0.847 (**0.85**) | 0.0021, 0.0020 |
| Files searchable (#1382), Wiki and citations (#1381), the cache (#1410), all merged | `main-1441-1` | `925b5f69e` | the worker's loop, prompt cache | 0.935 (one run with no answer: a provider failure) | 0.0020 |
| pi in the agent runtime (#1441), the same questions | `pi-1441-1`, `pi-1441-2` | `b9e9cf168` + pi, `925b5f69e` + pi | pi, through the model gateway | **0.935, 0.984** | 0.0030, 0.0029 |
| **The v0.2.1 release gate** | `v021-gate-95a6a6d1c` | `95a6a6d1c` | pi in the runtime, the worker's loop removed | **0.944** (57 correct, 3 partial, 1 wrong, 1 don't know) | 0.0029 |

How to read it:

- **The first row is not strictly comparable with the rest.** Review of #1409 rewrote eight questions after the baseline ([below](#questions-changed-in-review-after-the-baseline-2026-11-13)):
  `1381-main-1` and `1410-main-1` are the baseline of the reviewed text, so 0.76 to 0.82 mixes the new question text with whatever main
  changed meanwhile: it is not a measured gain of Flux. From there every step is on the same questions.
- **#1410 (0.82 to 0.85)** raised the two-source questions (mean 0.64 and 0.57 in the main runs, 0.79 in both branch runs) and halved the cost
  (the prompt cache read 70% of the prompt); relative-date questions did not move (0.90 in all four runs).
- **#1382 (files)** took the `file` category from 0.00 to 1.00 in every run since: the answer is inside a PDF, Markdown, CSV or DOCX, and search now finds it.
- **pi (#1441)** costs about 1.5 times the worker's loop per question (0.0029 to 0.0030 against 0.0020 on the same head) for 0.935 and 0.984
  against 0.935, and the founder accepted that on #1441 (2026-11-13). Its two runs differ by 0.05, the least a change must beat. The gate
  run is inside that spread.
- **The gate** has no `file`, `wiki`, `task_decision_map` or `no_answer` miss. Its five answers that are not correct: `old09` (partial: the
  right penalty, and a second one presented as valid beside it), `old13` (wrong: who is on call in the August closure; the agent names Piotr
  but leads with "not found"), `two03` and `two04` (partial: one of the two asked facts each) and `rel02` (don't know: what Maurycy
  wrote about the supplier in early October).

| Category | n | Baseline mean | `1410-main-1` | #1410 mean | `main-1441-1` | `pi-1441-1` | `pi-1441-2` | Gate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| old_messages | 15 | 0.82 | 0.90 | 0.93 | 0.87 | 0.93 | 0.93 | 0.90 |
| recent | 2 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| wiki | 8 | 1.00 | 1.00 | 1.00 | 1.00 | 0.88 | 1.00 | 1.00 |
| file | 6 | 0.00 | 0.00 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| task_decision_map | 7 | 0.86 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| two_source | 7 | 0.64 | 0.64 | 0.79 | 0.71 | 0.93 | 1.00 | 0.86 |
| relative_date | 10 | 0.73 | 0.90 | 0.90 | 1.00 | 0.85 | 1.00 | 0.90 |
| no_answer | 7 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| **all** | 62 | **0.758** | **0.823** | **0.847** | **0.935** | **0.935** | **0.984** | **0.944** |

| | Baseline mean | `1410-main-1` | #1410 mean | `main-1441-1` | `pi-1441-1` | `pi-1441-2` | Gate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Correct / partial / wrong / don't know (62) | 45.5 / 3 / 7 / 6.5 | 48 / 6 / 0 / 8 | 50.5 / 4 / 0.5 / 7 | 56 / 4 / 2 / 0 | 56 / 4 / 0 / 2 | 61 / 0 / 1 / 0 | 57 / 3 / 1 / 1 |
| Runs that ended without an answer | 2.5 | 0 | 0 | 1 | 0 | 0 | 0 |
| Gold source linked in the answer | 0.06 | 0.04 | 0.06 | 0.78 | 0.04 | 0.80 | 0.80 |
| Model requests per question | 3.0 | 3.0 | 3.1 | 2.8 | 3.4 | 3.2 | 3.3 |
| Cost per question (agent) | $0.0041 | $0.0039 | $0.0020 | $0.0020 | $0.0030 | $0.0029 | $0.0029 |
| Seconds per question p50 / p95 | 7.1 / 10.7 | 6.1 / 11.1 | 6.7 / 10.1 | 6.1 / 11.2 | 7.1 / 11.1 | 7.1 / 10.2 | 7.1 / 11.1 |

The "gold source linked" row is the citations of #1381 (the answer links the source that holds the fact): `pi-1441-1` ran on a main from before #1431, which brought them, so it still shows the old 0.04.
Input tokens are not compared above: from #1410 on the prompt is cached, and the input tokens in each run's table are only the uncached part.

#### Where the later runs came from

- **#1381 (Wiki as the space's knowledge base), A/B, two runs each, `58c10e9e4` + the branch** ([A-1](results-1381-A-1.md), [A-2](results-1381-A-2.md),
  [B-1](results-1381-B-1.md), [B-2](results-1381-B-2.md), against [main](results-1381-main-1.md)). A is tools only (better tool descriptions, nothing about the
  Wiki in the brief), B adds a short Wiki index to the brief (`wiki-index`).

  | | main | A (tools only) | B (index in the brief) |
  | --- | --- | --- | --- |
  | Accuracy | 0.823 | 0.790, 0.847 | 0.831, 0.806 |
  | Gold source linked | 0.06 | 0.75, 0.78 | 0.75, 0.76 |
  | Runs without an answer | 1 | 0, 0 | 2, 1 |
  | Cost per question | $0.0041 | $0.0041, $0.0041 | $0.0038, $0.0038 |

  Correctness and citations tie within the spread (main's own two baseline runs were 0.734 and 0.782); B is 8% cheaper but three of its 124
  runs hit the input bound. The founder's rule is that a tie goes to A, so B was removed (#1431). Citations went from 0.06 to about 0.75
  of answers that link their gold source.
- **#1410, two runs** ([`1410-mine-1`](results-1410-mine-1.md), [`1410-mine-2`](results-1410-mine-2.md), against [`1410-main-1`](results-1410-main-1.md)): see the row above.
- **pi (#1441)**: [`pi-1441-1`](results-pi-1441-1.md) and [`pi-1441-2`](results-pi-1441-2.md), with [`main-1441-1`](results-main-1441-1.md), the worker's loop on the same head as
  the second pi run, as the control.
- **The gate**: [`v021-gate-95a6a6d1c`](results-v021-gate-95a6a6d1c.md), run on the release candidate's main `95a6a6d1c` on 2026-11-14 after pi replaced the worker's loop.
  One run, so its 0.944 is read against the pi spread of 0.935 to 0.984, not against a single earlier figure.

### Baseline: Claude Haiku 5.5, two runs at main `64e4ff4ce` (2026-11-13)

Claude Haiku 5.5 is the cheapest model an Anthropic key offers in Connect AI (Flux has no default model: the owner picks one from the key's
own list, newest family first; the run's `connect` step records the pick). Raw results: [run 1](results-haiku-5-5-baseline-1.json)
([table](results-haiku-5-5-baseline-1.md)), [run 2](results-haiku-5-5-baseline-2.json) ([table](results-haiku-5-5-baseline-2.md)).

| Category | n | Run 1 | Run 2 | Mean | Spread |
| --- | --- | --- | --- | --- | --- |
| old_messages | 15 | 0.800 | 0.833 | 0.82 | 0.03 |
| recent | 2 | 1.000 | 1.000 | 1.00 | 0 |
| wiki | 8 | 1.000 | 1.000 | 1.00 | 0 |
| **file** | 6 | **0.000** | **0.000** | **0.00** | 0 |
| task_decision_map | 7 | 0.857 | 0.857 | 0.86 | 0 |
| **two_source** | 7 | 0.786 | 0.500 | **0.64** | 0.29 |
| **relative_date** | 10 | 0.800 | 0.650 | **0.73** | 0.15 |
| no_answer | 7 | 1.000 | 1.000 | 1.00 | 0 |
| **all** | 62 | **0.782** | **0.734** | **0.758** | 0.05 |

| | Run 1 | Run 2 |
| --- | --- | --- |
| Correct / partial / wrong / don't know | 48 / 1 / 7 / 6 | 43 / 5 / 7 / 7 |
| Runs that ended without an answer (`input_too_large`) | 2 | 3 |
| Exact keys matched | 0.77 | 0.74 |
| Gold source found by a tool (answerable questions) | 0.91 | 0.86 |
| Reference values in what the tools returned | 0.76 | 0.79 |
| Gold source linked in the answer (named by its title) | 0.06 (0.46) | 0.06 (0.46) |
| Relative-date questions where the agent filtered by date | 0.80 | 0.80 |
| Input / output tokens per question | 37,408 / 799 | 37,452 / 748 |
| Model requests per question | 3.1 | 3.0 |
| Tool calls per question (flux_search) | 4.2 (3.5) | 4.1 (3.5) |
| Cost per question; whole run (agent + judge) | $0.0041; $0.257 + $0.008 | $0.0041; $0.255 + $0.008 |
| Seconds per question p50 / p95 | 7.1 / 11.1 | 7.1 / 10.2 |

### Cross-check: Claude Sonnet 5.5 on the 39 questions where Haiku missed (2026-11-13)

The four categories with misses or a control (old_messages, two_source, relative_date, no_answer), one run, the same stack and judge.
Raw results: [json](results-sonnet-5-5-crosscheck.json), [table](results-sonnet-5-5-crosscheck.md).

| Same 39 questions | Haiku 5.5 run 1 | Haiku 5.5 run 2 | Sonnet 5.5 |
| --- | --- | --- | --- |
| Accuracy | 0.833 | 0.756 | 0.782 |
| old_messages / two_source / relative_date / no_answer | 0.80 / 0.79 / 0.80 / 1.00 | 0.83 / 0.50 / 0.65 / 1.00 | 0.90 / 0.71 / 0.50 / 1.00 |
| Runs without an answer | 2 | 3 | 0 |
| Input tokens per question | ~38k | ~38k | 26.7k |
| Cost of the 39 questions | $0.16 | $0.17 | $2.25 |

A model 20 times the price is not better here: it uses fewer tokens and never hits the input bound, but it misses the same questions
(Maurycy's supplier, "last week" read as the last seven days, the invoice "about two months ago" among many invoices, Sarah's English
message found with a Polish query). **The weak categories come from what the tools and the brief give the model, not from the model**, which
is what #1381 and #1382 change. Haiku 5.5 stays the baseline model: it is what an owner who picks the cheapest model runs, and it is
cheap enough to run every variant twice.

### What the misses are (read from the answers and the recorded tool calls)

- **File contents (0 of 6 in both runs).** The agent finds the message that carries the file (the gold file is "found" in 5–6 of 6) and
  says, correctly, that it cannot read what is inside; it never invents a value. This is the gap #1382 closes; it also costs the most
  tokens per question (47–53k), because the agent keeps searching for a value that is only in the file.
- **Runs that end with no answer (2–3 of 62, 3–5%).** `old12`, `two06`, `two07`: after 3–5 requests the next request would pass the
  64,000-token input bound (`input_too_large`), and the person gets nothing, not even what was found so far. Each followed a
  `flux_get_conversation` of a long conversation or a run of eight or more searches. The tool loop has no way to drop old tool results.
- **Two sources (mean 0.64, the noisiest category).** The agent usually finds one source and stops: it reads the Wiki page and says the
  other half is not in Flux (`two02`, `two03`, `two04`), or it never opens a task's discussion (`flux_get_work` shows the task without its
  discussion, and `flux_get_task_discussion` was called in 1 of 124 runs).
- **Relative dates (mean 0.73).** The agent turns relative dates into `after`/`before` well (8 of 10 questions in both runs), but:
  - a person's name is not searchable: "What did Maurycy say about the supplier in early October?" fails in both runs ("Searches for
    'Maurycy' return no matches"), because `flux_search` matches message text only and `from` needs an author id the agent cannot get
    from a name;
  - "What happened in this space last week?" in English (`rel08`) was read in both runs as the last seven days (`flux_summarize` from
    Friday 6 November), not the calendar week before (2–8 November) where the three planted events are; the Polish "w zeszłym tygodniu"
    (`rel03`) was read from Monday 2 November and is right in both runs. The English question is ambiguous, and its reference takes
    the calendar week: read `rel08` as one point of doubt, not a clear miss;
  - a question in one language about a message in the other with a date filter (`rel09`: Polish question, Sarah's English message)
    fails when the agent searches in one language only.
- **Old messages (0.82).** The misses are a paraphrase the search does not reach (`old02`, "how long on batteries" against "Test baterii
  zakończony … 14 miesięcy"), a found message the model did not use (`old13`), and one `input_too_large`.
- **Wiki (1.00), tasks, decisions and maps (0.86), no-answer (1.00).** `flux_search` already finds Wiki pages, decisions and map thoughts
  by their words, and the agent says it does not know when nothing answers (7 of 7 in both runs, no invented values).
- **Citations.** The answer almost never links a source: an API-key run can only link the brief's own numbered messages (`[S1]`), and a
  hit found by `flux_search` comes back without a mark the answer could use, so the agent names a Wiki page in bold or quotes the
  message's author and date instead (named: 0.46).

### What this meant for #1381 and #1382

Written after the baseline. What happened is in [Progression](#progression): #1382 took the file questions from 0 to 6 of 6, #1381's A/B
tied and went to A, and the missing links to a search hit are now in the answer (gold source linked 0.06 to 0.8).

- **#1382 (file contents)** has the most room: 6 of 62 questions (one tenth of the score) are 0 today, plus one two-source question.
- **#1381 (Wiki as knowledge base)** cannot raise the Wiki-only score (already 1.00 in both runs). Its A/B (founder decision on #1381) should
  be read on the two-source questions that need a Wiki page with another source (`two01`–`two05`), on citations of Wiki pages, and on
  tokens per question; it must not lower `wiki`, `no_answer` or `all` beyond the spread above. Run each variant twice:
  `FLUX_EVAL_VARIANT=<name> FLUX_EVAL_LABEL=<name>-<n> FLUX_EVAL_RECORD=docs/product/research/evidence/1295 scripts/check_ai_eval.sh`, then
  `compare.py` (correctness, citations, tokens, cost and tool calls per variant). The variant name reaches the API and the worker as
  `FLUX_TEST_AI_VARIANT`; reading it is the implementer's.
- **Not in either issue, found here:** runs that end with no answer at the input bound, author names that cannot be searched, and the
  missing link to a search hit in the answer.

### Questions changed in review, after the baseline (2026-11-13)

The independent review of PR #1409 made five relative-date questions well-defined and three references checkable. The baseline above
was measured on the earlier text, so these ids are **not comparable with it**. `compare.py` names any such id. The next run of main, for
example the `main` arm of #1381's A/B, is the baseline for them.

- `rel03`, `rel08`: "last week" now says "Monday to Sunday". Read as the last seven days, it held none of the planted events on a
  Friday run, and both baseline runs read `rel08` that way.
- `rel04`: "the invoice" is now "an invoice's number and amount". The bench has dozens of "Invoice from X is booked" messages around
  then, and Sonnet rightly asked which one was meant.
- `rel06`: now "which firmware version passed testing". Piotr writes many firmware messages in early October, and the old reference
  wanted only one of them.
- `rel09`: now asks for the accessibility audit result. Sarah writes many messages about the site in that week.
- `old03`, `old06`, `old08`: the references now give the firmware version and the reasons the questions ask for. Before, they gave
  "as in the message", which the judge cannot check. Baseline run 2 graded a right `old06` answer as partial.

The harness changed in the same review. A no-answer question the judge grades "don't know" now scores as correct. A run in which
some questions were not asked (`INCOMPLETE`), or which ended at Flux's own cap, is never recorded. The key scan now covers every
evidence file, not only the stack log.

## Spend

From the provider's usage of every request, at Anthropic's published prices (Haiku 5.5 $0.10 / $0.50 per million input / output tokens
up to 100k-token prompts, Sonnet 5.5 $2 / $10; from #1426 a prompt-cache write is charged at 1.25 times and a read at 0.1 times the input
price); the ledger is [spend.tsv](spend.tsv) (start, dollars, model, harness commit, label). A run's dollars are the agent and the judge.

| Run | $ | Kept? |
| --- | --- | --- |
| smoke (3 questions) | 0.013 | no: a check of the harness |
| first Haiku run | 0.268 | no: its judge read a reference's context in parentheses as required; the rubric now says it is not |
| second Haiku run | 0.206 | no: 16 of 62 runs failed at the provider ("credential validation failed", 503) |
| Haiku run 2, first try | 0.000 | no: every request failed at the provider; the harness refuses to record such a run |
| Haiku baseline 1 | 0.265 | yes |
| Haiku baseline 2 | 0.264 | yes |
| Sonnet 5.5 cross-check (39 questions) | 2.254 | yes |
| `1381-main-1`, `1381-A-1`, `1381-A-2`, `1381-B-1`, `1381-B-2` (the #1381 A/B) | 0.261, 0.262, 0.263, 0.242, 0.241 | yes |
| `1410-main-1`, `1410-mine-1`, `1410-mine-2` (#1410) | 0.253, 0.141, 0.130 | yes |
| `pi-1441-1`, `pi-1441-2`, `main-1441-1` (#1441) | 0.197, 0.188, 0.130 | yes |
| `v021-gate-95a6a6d1c` (the release gate, one run) | 0.189 | yes |
| **all** | **5.767** | of the issue's $8 (2.496 of it since the baseline's $3.271) |

## Limits

- One author wrote the questions and references; the judge is a small model. Where the keys and the judge disagree, the per-question
  table in each `results-*.md` shows both, and the answers are in `results-*.json`.
- "Answer in tool results" matches the reference's keys in everything the tools returned; a short key can match by chance (`file06`'s
  "Grunwaldzk" matched a chat message about another station, so the file row shows 0.17 where no file was read).
- Two runs are few: the spread between them (0.05 overall, 0.29 on two sources) is the least a change must beat. The pi runs spread by the same
  0.05 (0.935 and 0.984), and the gate is one run.
- One model and one provider: every run is Claude Haiku 5.5 on an Anthropic key (the Sonnet 5.5 cross-check aside). No OpenAI, Gemini,
  OpenRouter or self-hosted key, and no Claude or ChatGPT plan, was measured; web search was off, so the agent's web search is not measured here.
- Citations: "Cited" counts the answer's links to a source (a message, a Wiki page, a task, a decision); "named" also counts a source named
  by its title. At the baseline only the brief's own numbered sources (`[S1]`) became links and a hit found with `flux_search` could only be named;
  from #1431 on, the answer links what it found.
- Run-to-run noise: the two baseline runs differ by the spread shown; a change must beat it to count.
