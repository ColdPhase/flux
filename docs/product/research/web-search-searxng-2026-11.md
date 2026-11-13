# Agents' web search through a self-hosted SearXNG instead of the provider's search

**Status:** research only, 2026-11-13, for the founder's question whether an agent's web search can run through a
SearXNG container that Flux ships, as the one path for everyone, instead of the model provider's hosted search (today:
[C-29](../decisions.md), [RT-4/RT-5](../ai-modes.md#rt-4--network), and `flux_web_search` for API-key agents in pi,
[PR #1453](https://github.com/ColdPhase/flux/pull/1453)). No product code and no decision change here.

Every figure was measured on this host on 2026-11-13 (19:12–20:19 UTC) unless it is labelled:
**observed** (measured here), **vendor claim**, **published report** (a dated third-party or upstream statement) or
**inference** (my reading). The relevance grades are my own judgement under the rubric below, not blind: I knew which
system each list came from.

## In short

- **Verdict: much worse than the provider's search as the one path for everyone, although the results themselves are as
  good when it works.** At low volume, with a chosen engine set, SearXNG's top-5 was as relevant as Anthropic's hosted
  search on 25 realistic agent queries (8.8 vs 8.6 out of 10). The problem is that it does not stay working: it is a
  scraper of other companies' search pages, and those companies block it.
- **Blocking, observed from a home connection on the first query:** Google (HTTP 403), DuckDuckGo (CAPTCHA), Qwant and
  Mojeek (403). Brave answered 429 after 8 queries at about one query per 5 s. In a burst of 100 queries in 3 minutes,
  Google CSE (the source of most good results) was cut off with 429 after ~48 queries. In the next 30 minutes at a calm
  one query per 30 s it never came back, Startpage switched to CAPTCHAs, and a freshly started container (no SearXNG
  suspension left) was still refused by Google CSE, Brave, Startpage, Qwant and DuckDuckGo: the blocks are on the
  engines' side, against this IP.
- **What survives is Bing, Yahoo (Bing's index) and Mwmbl (a small community index), and that set is much
  worse:** the same 25 queries rerun in that state scored **3.8 / 10** (from 8.8), only 7 of 25 first results were
  useful, 69 of 125 results were junk (a Fortnite wiki for "coworking Poznań cennik", Nexus Mods for a React error,
  LinkedIn profiles for Bulgakov), and the median search took 3.0 s because blocked engines ran into the timeout.
- **A datacenter IP is expected to be worse, not better** (published reports, below); this host is a residential
  connection, so the blocking above is a lower bound for a 2 vCPU VPS. Upstream's own tracker has open, current issues
  for Google 403 (#6835, 2026-10-11, also on home connections), DuckDuckGo CAPTCHA (#6779), and a Qwant block that
  returns **made-up results** instead of an error (#6358).
- **It is cheap to run:** a 266 MB image (≈92 MB compressed), ready in 3.3–7.4 s, 116–172 MiB RAM idle and at most
  194 MiB (cgroup peak) under load, about 0.07 CPU-seconds per search (4% of one core at one search every 2 s). Licence
  is no obstacle (AGPL-3.0, like Flux). The project is very active (220 commits by 29 authors in the last 90 days, a new
  image almost every day), which is also a sign of how often engines break.
- **It gives the agent less than the provider does:** a title and a one-to-two-sentence snippet per result, with a date
  on 27 of 125 top-5 results, versus Anthropic's results that carry page content into the model (≈14.5k input tokens per
  search) and a page age on 96 of 125. With SearXNG the agent must open pages with `flux_read_web` to answer from them:
  more calls, more tokens, more time. SearXNG itself is fast (median 1.0 s vs 7.1 s for one Anthropic search call).
- **Money:** SearXNG costs nothing per search. Anthropic's search cost $0.0121 per query on Haiku 5.5 here ($0.01 search
  fee + tokens); this research spent **$0.3035** of the $0.80 budget.
- **If Flux wants one path anyway** (inference, not a recommendation to change C-29): a keyed search API on the owner's
  or the operator's own account is the stable form of "one path"; a bundled keyless SearXNG is a fallback that will need
  engine maintenance by every operator. See [What one path would mean](#what-one-path-would-mean).

## What Flux does today (context)

- C-29: an agent searches with its provider's own hosted search on the owner's own connection: Anthropic's `web_search`
  server tool, OpenAI Responses' `web_search`, Claude Code's `WebSearch` (runs at Anthropic), Codex's search on OpenAI's
  cached index. **A provider without one (OpenRouter, Gemini's compatible endpoint, an OpenAI-compatible server) has no
  search.** That gap is what a single SearXNG path would close.
- `flux_web_search` (PR #1453, `app/packages/core/src/personal-runs/key-search.ts`): for an API-key agent in pi, the
  Flux server runs one request with the run's key and model and the provider's hosted search, with Flux's own
  instruction (`KEY_SEARCH_SYSTEM`), reserved against the key's daily budget, and records queries and result addresses.
  The provider comparison below uses exactly that instruction.
- Pages are read with `flux_read_web` on the Flux server, not through the runtime egress (RT-4): GET only, public
  addresses only, the guard of link cards and API base URLs, 3 s connect / 8 s total, 512 KiB, 3 redirects
  (`app/apps/server/src/web-reads/reader.ts`), HTML reduced to text (`readable.ts`), and the private-text address check
  of C-30.

## Setup (observed)

- Image `searxng/searxng:2026.11.12-de722ab1b` (published 2026-11-12 08:24 UTC; upstream ships a rolling image several
  times a day and no semantic versions). Void Linux base, Python 3.14.8, granian server with one worker, outgoing
  requests through `curl_cffi` browser impersonation.
- Own Compose project `searxng-research`, `127.0.0.1:28880`, `cpus: 2`, `mem_limit: 1g`, read-only config:

  ```yaml
  use_default_settings: true
  general: { contact_url: "<project URL>" }   # Wikipedia, Wikidata and OSM refuse to start without it
  server: { secret_key: "<random>", limiter: false, public_instance: false, image_proxy: false }
  search: { formats: [html, json], autocomplete: "" }
  engines:   # defaults plus the engines a "sensible" set would want
    - { name: google, disabled: false }
    - { name: bing, disabled: false }
    - { name: qwant, disabled: false }
    - { name: yahoo, disabled: false }
    - { name: mojeek, inactive: false, disabled: false }
    - { name: startpage, inactive: false, disabled: false }
    - { name: mwmbl, disabled: false }
  ```

- **Upstream defaults already tell the story (observed in the image's `settings.yml`):** the general web engines on by
  default are only DuckDuckGo, Google CSE, Brave, Wikipedia and Wikidata. `google` and `bing` ship disabled; `startpage`
  and `mojeek` ship *inactive* with the comments "uses a Proof Of Work captcha" and "uses a Proof of Work CAPTCHA that
  requires much computer power to solve". The Google engine's docstring says it requests an old Nokia XML layout
  because "the normal web version requires executing JavaScript". JSON output is off by default and must be enabled.
- All engines used are keyless. No proxy, no Tor.

## Quality: 25 agent queries, top 5 each

**Queries** (`data/queries.json` in the evidence folder): 5 current events of the last weeks (US midterms, COP31,
Opus 5.5 pricing, Bitcoin price, Poland's 2027 minimum wage), 6 product docs/version questions (Playwright 1.65,
ESLint 10, PostgreSQL 19, Compose `start_interval`, SearXNG JSON, Node.js 26 LTS), 3 local businesses in Poland,
4 error messages, 3 Polish questions, 4 factual lookups. Each was sent as written to SearXNG (`/search?format=json`,
no language set) and, as "Search the web for: …", to Claude Haiku 5.5 with `web_search_20250305`, `max_uses: 1`,
`effort: low`, `max_tokens: 1500` and Flux's `KEY_SEARCH_SYSTEM` (the Haiku 5.5 model is not on the list for the
`_20260209` dynamic-filtering variant). The model rewrote 3 of 25 queries slightly (dropped "Polska", "ile wynosi", the
`psql:` prefix).

**Rubric.** Each top-5 result: **2** answers the query or is the authoritative/primary source; **1** on topic but
partial, secondary, a duplicate or stale (e.g. a 2022 contribution rate); **0** off topic or junk; an empty slot is 0.
A query scores 0–10. "Hit@5" = at least one 2 in the top 5. Freshness was judged on the time-sensitive queries by
whether the top 5 reflected the current state.

| | SearXNG, all working engines | SearXNG without Bing/Mwmbl (re-ranked from the same run) | Anthropic hosted search |
|---|---|---|---|
| Mean score (0–10) | 7.76 | **8.76** | **8.56** |
| Hit@5 | 25/25 | 25/25 | 25/25 |
| First result a 2 | 23/25 | 23/25 | 20/25 |
| Junk (0) results in 125 | 16 | 3 | 3 |
| By kind: current / docs / local / error / Polish / fact | 8.4 / 7.7 / 6.7 / 9.0 / 8.0 / 6.5 | 8.8 / 8.2 / 10 / 9.5 / 9.7 / 7.2 | 9.0 / 7.7 / 9.0 / 9.0 / 10 / 7.5 |
| Result with a date | 27/125 | — | 96/125 (`page_age`) |
| Median time per search | 0.99 s | — | 7.05 s (search + model) |

Per query, SearXNG without Bing/Mwmbl vs Anthropic: 8 better, 9 equal, 8 worse. Overlap is low: on average 1.4 of the
top-5 addresses are the same in both lists, 2.8 of Anthropic's ~9–10 results appear in SearXNG's top 10, so the two find
different but comparably useful pages.

| # | Kind | Query | SearXNG, all engines | SearXNG, no Bing/Mwmbl | SearXNG, degraded | Anthropic | Same URL in both top-5 | Anthropic rewrote query |
|---|---|---|---|---|---|---|---|---|
| 01 | current | US midterm elections 2026 results House control | 10 | 10 | 5 | 8 | 1 |  |
| 02 | current | COP31 Antalya climate summit outcome | 6 | 6 | 4 | 7 | 2 |  |
| 03 | current | Claude Opus 5.5 release pricing | 6 | 8 | 0 | 10 | 3 |  |
| 04 | current | Bitcoin price today | 10 | 10 | 8 | 10 | 2 |  |
| 05 | current | Polska płaca minimalna 2027 kwota | 10 | 10 | 3 | 10 | 2 | yes |
| 06 | docs | Playwright 1.65 release notes | 7 | 7 | 4 | 7 | 3 |  |
| 07 | docs | ESLint 10 migration guide breaking changes | 9 | 9 | 4 | 8 | 2 |  |
| 08 | docs | PostgreSQL 19 release date new features | 9 | 9 | 6 | 8 | 3 |  |
| 09 | docs | docker compose healthcheck start_interval | 6 | 7 | 3 | 5 | 1 |  |
| 10 | docs | SearXNG settings.yml enable json format | 7 | 7 | 4 | 8 | 1 |  |
| 11 | docs | Node.js 26 LTS release schedule | 8 | 10 | 2 | 10 | 1 |  |
| 12 | local | dentysta Wrocław Krzyki | 4 | 10 | 2 | 8 | 0 |  |
| 13 | local | best ramen restaurant Kraków | 6 | 10 | 2 | 9 | 1 |  |
| 14 | local | coworking Poznań cennik | 10 | 10 | 3 | 10 | 0 |  |
| 15 | error | ERR_PNPM_OUTDATED_LOCKFILE Cannot install with frozen-lockfile | 8 | 10 | 4 | 10 | 2 |  |
| 16 | error | psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: No such file or directory | 10 | 10 | 3 | 6 | 1 | yes |
| 17 | error | rust error[E0502]: cannot borrow as mutable because it is also borrowed as immutable | 9 | 9 | 6 | 10 | 1 |  |
| 18 | error | TypeError: Cannot read properties of undefined (reading 'map') React | 9 | 9 | 2 | 10 | 2 |  |
| 19 | polish | KSeF obowiązkowy od kiedy dla małych firm | 9 | 10 | 3 | 10 | 1 |  |
| 20 | polish | jak założyć jednoosobową działalność gospodarczą krok po kroku | 7 | 9 | 4 | 10 | 0 |  |
| 21 | polish | ile wynosi składka zdrowotna ryczałt 2026 | 8 | 10 | 4 | 10 | 1 | yes |
| 22 | fact | height of Mount Elbrus | 8 | 7 | 5 | 7 | 1 |  |
| 23 | fact | who wrote The Master and Margarita | 5 | 9 | 5 | 10 | 0 |  |
| 24 | fact | GDPR article 17 right to erasure text | 7 | 7 | 8 | 8 | 1 |  |
| 25 | fact | boiling point of ethanol at sea level | 6 | 6 | 2 | 5 | 2 |  |

**What the grades mean (observed + inference):**

- **Freshness was fine on both** while Google CSE was answering: midterm results (Democrats won the House) from BBC, NBC,
  Guardian, CBS; the PostgreSQL 19 release notes page; Node.js 26 LTS on 28 October; the 2027 minimum wage (4,950 zł)
  from Onet and Business Insider. Anthropic had fresher dated items on the ongoing COP31 (0–2 days old).
- **15 of SearXNG's 16 junk results came from Bing (8) and Mwmbl (7)**: a Lidl store finder for "height of Mount
  Elbrus", Google Translate twice for "who wrote The Master and Margarita", a debt collector for "best ramen Kraków",
  a dentist in Kłodzko for Wrocław-Krzyki. Upstream users report the same of Bing ("Bing which I've found to be garbage",
  #6866, 2026-10-19). Dropping both moved SearXNG from below to level with the provider. This re-ranking was simulated on
  the saved run (results whose only engines were Bing/Mwmbl removed); it was not a separate live run.
- **The good results came from Google**: Google CSE was in 99 and Startpage (which serves Google's results) in 88 of the
  125 top-5 slots; Yahoo (Bing's index) in 54. So "SearXNG quality" here is Google's quality, through a scraper.
- **The provider's results are better material for an agent:** each Anthropic result carries page content into the
  model's context (that is the ≈14.5k input tokens), so the agent can answer from the search alone; SearXNG returns a
  snippet, so a good answer needs one or more `flux_read_web` calls after it.

## Reliability: blocks, bursts and recovery

### First contact (observed)

The first 25 queries, about one every 5 s, were the first searches this SearXNG ever sent:

| Engine | What happened | How SearXNG reported it |
|---|---|---|
| Google | HTTP 403 on query 1, every query after | `unresponsive_engines: [google, "access denied"]`, then "Suspended: access denied" (180 s) |
| DuckDuckGo | CAPTCHA on query 1, every query | "CAPTCHA" (the engine raises it with `suspended_time=0`, so it is retried and fails each time) |
| Qwant, Mojeek | HTTP 403 on query 1 / query 3 | "access denied", suspended 180 s, repeated |
| Brave | answered 8 queries, then 429 | "too many requests", suspended 180 s, repeated |
| Wikidata | timeouts (3 s) | "timeout" |
| Google CSE, Startpage, Yahoo, Bing, Mwmbl | answered | — |

SearXNG never failed the request: it returned HTTP 200 with whatever engines answered and listed the others in
`unresponsive_engines`; `/stats/errors` gives per-engine exception counts. A Flux tool would have to read that list to
know it got half a search. Default `suspended_times`: access denied 180 s, CAPTCHA 3,600 s, too many requests 180 s,
Cloudflare CAPTCHA 15 days, reCAPTCHA 7 days; suspensions live in the process, so a restart clears them (and the engine
is blocked again on its next request if the block is upstream).

### Burst: 100 distinct queries in 178 s, 4 in parallel (observed)

- 100/100 requests answered, 0 empty, latency p50 0.80 s / p90 1.51 s / max 3.0 s.
- Google CSE answered the first ~48 queries and then got **429 for the rest of the burst** (52 of 100 queries). Google,
  Brave, Qwant and DuckDuckGo (CAPTCHA, then "access denied") stayed out for all 100; Mojeek answered 7 and was blocked.
  Startpage had 11 parsing errors, Yahoo 3 (inference: a block or challenge page the parser does not recognise).
- Engines that returned results, per 20-query slice: queries 0–19 Bing, Google CSE, Startpage, Yahoo (+ Mojeek, Mwmbl);
  60–99 only Bing, Yahoo, Startpage, Mwmbl. Mean results per query fell from 55 to 42.

### Sustained: 1 query every 30 s for 30 minutes, right after the burst (observed)

- 60/60 answered, 0 empty; latency p50 1.14 s, p90 3.0 s (the 3 s engine timeout of blocked engines).
- **Nothing recovered.** Google CSE got 429 on every retry for the whole 30 minutes (each retry after its 180 s
  suspension was refused again), as did Brave; Google, Qwant and Mojeek stayed "access denied"; DuckDuckGo moved between
  CAPTCHA, access denied and timeouts. Startpage answered until about query 33 and then returned a CAPTCHA on every
  query to the end.
- Engines with results per 10-query slice: first 10 Bing, Yahoo, Startpage, Mwmbl; last 20 only Bing, Yahoo and Mwmbl.
  Mean results per query 34–45.
- **A restart does not help:** at 19:58 UTC the container was recreated (all SearXNG suspensions gone) and three new
  queries went to Google, Google CSE, Startpage, Brave, DuckDuckGo, Qwant, Bing and Yahoo. Google CSE and Brave answered
  429, Google and Qwant 403, Startpage failed ("unexpected crash" of its parser; it had answered CAPTCHA before the recreate), DuckDuckGo timed out; only Bing and
  Yahoo returned results.
- **Partial recovery after rest:** after 17 idle minutes (20:15 and 20:18 UTC, the second after the 180 s suspension),
  Brave and Startpage answered again, but Google CSE was still 429 about 55 minutes after it was first cut off, Google
  and Qwant still 403 and DuckDuckGo timed out. Inference: an instance that agents use steadily keeps itself on the
  engines' block lists; an idle one slowly gets some of them back.

### Quality in the degraded state (observed)

The 25 quality queries were sent again at 19:54 UTC, after the burst and the sustained run (only Bing, Yahoo and Mwmbl
were answering), and graded with the same rubric:

| | Fresh (all engines) | Fresh without Bing/Mwmbl | **Degraded** | Anthropic |
|---|---|---|---|---|
| Mean score (0–10) | 7.76 | 8.76 | **3.84** | 8.56 |
| Hit@5 | 25/25 | 25/25 | 23/25 | 25/25 |
| First result a 2 | 23/25 | 23/25 | **7/25** | 20/25 |
| Junk (0) in 125 | 16 | 3 | **69** | 3 |
| Median time | 0.99 s | — | 3.01 s | 7.05 s |

Examples: "Claude Opus 5.5 release pricing" returned nothing relevant (an Opus 4.7 changelog, claude.com, Hacker News);
"Polska płaca minimalna 2027" put a 2024 article and the Wikipedia page on Poland first; "boiling point of ethanol" led
with Wordwall quizzes and a BBC article on UK protests; Bing answered "coworking Poznań cennik" with Fortnite wikis. In
this state Yahoo's few results were usually the only useful ones; dropping Bing and Mwmbl would leave one engine.

### Datacenter IPs (published reports; not testable here)

This host is a home connection, which engines treat more kindly than a VPS; a 2 vCPU server at a hosting company is
the case Flux targets, so the blocking above is a **lower bound**.

- SSD Nodes (a VPS host), "Fix SearXNG engine CAPTCHA errors", dated 2026-10-17: "SearXNG engines answer a VPS with
  CAPTCHA pages more often than a home connection"; the set of engines that challenge datacenter addresses "changes from
  month to month"; an instance "driven by automated agents meets challenges sooner"; the durable fix is to drop engines,
  or use proxies or keyed APIs. (Vendor-authored guidance, not a measurement.)
- hbubli.cc, 2025-10-11 (operator of public SearXNG and 4get instances): Google's engine blocked; "Google has made it
  impossible to scrape web results without a JavaScript runtime"; its datacenter proxies are "often slow or still
  blocked".
- Upstream issues, all on `github.com/searxng/searxng`: #6835 Google 403 (opened 2026-10-11, open; comments 2026-10-16,
  -10-25, -11-09 on 2026.11.9, "First search always fails", on Docker, Termux, home Wi-Fi); #6570 (2026-08-23) Google
  blocked the Nokia user agent the engine had switched to, maintainer: "Google are doing TLS inspection now"; #6359
  (2026-07-03) the previous user agent stopped working; #6779 DuckDuckGo CAPTCHA on every request with language "all"
  (open since 2026-09-24; "Still the case" 2026-11-07); #6931 (2026-11-11) DuckDuckGo blocks from inconsistent
  impersonation; #6819 / #6402 Brave 429 (fixed by PR #6836, merged 2026-10-19, still 429 here after 8 queries); #6520
  Startpage constant CAPTCHA (2026-08-13); #6518 Google CSE failing (2026-08-13); #6358 Qwant **returns fabricated or
  nonsense results with HTTP 200 when it blocks the IP** (open since 2026-07-03), which would reach an agent as data.
  A search of the tracker for issues opened 2026-07-01 to 2026-11-13 mentioning CAPTCHA, access denied, too many
  requests or blocked matched 21, of which 18 are engines blocked or rate-limited (the other three are unrelated).

**Inference:** the engines that carry the quality (Google CSE, Startpage) are the ones under the most active blocking,
and fixes are a race that upstream ships every few weeks. A Flux operator would see search silently degrade between
image updates, and Flux could not promise any engine works from a given server.

## Cost on the server (observed)

| | |
|---|---|
| Image | 266 MB uncompressed; Docker Hub `full_size` ≈ 92.7 MB (compressed) |
| Start to `/healthz` OK | 3.3 s from `compose up` to `/healthz` OK on the first start, 7.4 s on a later recreate (image present; the
entrypoint updates CA certificates first) |
| RAM idle | 172 MiB after start |
| RAM under load | 189–200 MiB in `docker stats` during the burst; cgroup `memory.peak` 194 MiB after 245 queries; 116 MiB idle on a
fresh start |
| CPU | start plus 3 queries 1.8 CPU-s; ≈0.07 CPU-s per search (first container: 9.9 CPU-s for start, 25 + 100 queries;
then 7.8 CPU-s for 60 queries over 29 minutes, of which ~3.5 s is idle); the burst (0.56 searches/s) used ~4% of one
core. On 2 vCPU this is negligible |
| Network | each search fans out to every enabled engine (here 11), so one agent query is ~11 outbound requests |

The host was running other Docker test suites at the same time, so latency (not CPU, which is the container's own cgroup
counter) may be slightly pessimistic.

## Money per search

- **Anthropic hosted search (observed):** 25 searches on Haiku 5.5: 25 search requests ($0.25 at $10 per 1,000,
  vendor price) + mean 14,556 input and 1,366 output tokens ($0.10 / $0.50 per MTok) = **$0.3035**, $0.0121 per search.
  On a larger model the tokens dominate: the same ≈14.5k input tokens are about $0.058 on Opus 5.5 ($4/MTok), so about
  $0.07 per search (inference from list prices).
- **SearXNG:** no fee; the operator's CPU and bandwidth. The agent then needs `flux_read_web` to read pages, whose text
  goes into the model's input, so the token cost moves rather than vanishes (inference).
- Claude Code (`WebSearch`) and Codex searches are included in the owner's subscription today (C-29).

## Page reading

Flux already has the page tool a SearXNG path needs: `flux_read_web` (server-side GET, public addresses only, 512 KiB,
8 s, 3 redirects, HTML to text, private-text address check of C-30). With SearXNG it would carry most of the answer,
because SearXNG's snippets are short. Nothing new is needed for safety, but the published CVEs around SearXNG are a
warning about exactly this tool: they are SSRF flaws in the **page fetchers of integrations**, not in SearXNG
(`mcp-searxng`'s `web_url_read`: CVE-2026-54688, -54689, DNS rebinding CVE-2026-58485, resource exhaustion
CVE-2026-58483; SillyTavern's SearXNG proxy CVE-2026-46372; praisonaiagents CVE-2026-57143, "reachable through prompt
injection in any content an agent ingests"). Flux's guard (public addresses, each redirect hop checked, size and time
limits) is the right shape; a SearXNG path should reuse it and add nothing that fetches.

The SearXNG container itself would need: no published port (Flux's server only), its own network with internet egress,
`limiter: false`, JSON format on, `image_proxy` off, and the result addresses treated as untrusted data like any page.

## Licence, maintenance and security

- **Licence (observed):** AGPL-3.0-or-later (repository licence and file headers). Flux is AGPL-3.0 too (`LICENSE`,
  O-006), so shipping it unmodified as a separate container is unproblematic: source is upstream's, and an operator who
  modifies it must offer their modified source to its network users (AGPL §13). Config files are not a modification of
  the program (inference).
- **Maintenance (observed 2026-11-13 via the GitHub API):** 39.5k stars; 220 commits by 29 authors since 2026-08-15;
  a new image on Docker Hub almost daily (four on 2026-11-13 alone); 214 open issues and pull requests. A large share of
  recent work is engine repair (above). No releases or version numbers: pinning means pinning a dated tag, and staying
  working means updating often.
- **Security posture (observed):** `SECURITY.md` with a contact address; **no** GitHub security advisories published;
  no CVE in SearXNG itself found in a search on 2026-11-13 (the CVEs are in integrations, above). The image runs its
  entrypoint as root and drops to a `searxng` user for the server; it impersonates browsers' TLS (`curl_cffi`) and
  user agents by design. A private instance for Flux would not be exposed to the internet, which removes its bot
  limiter and public-instance concerns.

## What one path would mean

Inference, for the founder's decision:

1. **"One path, everyone through SearXNG"** replaces the provider's hosted search for API keys, Claude Code and Codex
   (their own search off), and gives OpenRouter, Gemini-compatible and OpenAI-compatible keys a search they lack today.
   Gains: one behaviour, no search fee, the search query never goes to the model provider. Costs: quality depends on
   which engines a given server can still reach that week; from a VPS some or all good engines will be blocked; Flux
   must ship and keep updating an engine list; an agent needs extra page reads per answer; and the query goes from the
   operator's server IP to Google/Bing/Startpage instead of to the provider's search partner (a privacy trade, not a
   gain, for most operators).
2. **"One path, a keyed search API"** (the operator or owner brings a search key, as they bring a model key) would be
   reliable and still one path, but it is a new account and bill; it was out of scope here and not measured.
3. **Keep C-29** (each provider's own search) and accept that some providers have none.

The founder's rule "use existing maintained tools" is met by SearXNG; the rule "one path for everyone, no exceptions" is
where it fails in practice, because the path's quality would differ per server and per week.

## Not verified

- Behaviour from a datacenter/VPS IP (only published reports above). Behaviour over days (the sustained run was 30
  minutes). IPv6 vs IPv4 per engine.
- OpenAI's hosted search (no OpenAI key in this research) and Anthropic's `web_search_20260209` on a larger model.
- Answer quality end to end (an agent answering with SearXNG + `flux_read_web` vs with hosted search); only the result
  lists were compared.
- Grades are one unblinded judge; the "without Bing/Mwmbl" column is a re-ranking of the saved run, not a live run.

## Reproduction

Evidence (not committed): `~/flux-evidence/v021/searxng-research/` on the research host: `data/queries.json`,
`data/sx_full.json` (SearXNG results), `data/anthropic.json` (Anthropic results, usage and cost), `data/grades.json`,
`data/burst.json`, `data/sustained.json`, `data/stats_burst.txt`, and the scripts `scripts/sx_quality.py`,
`scripts/sx_load.py`, `scripts/anthropic_search.py`, `scripts/compose.yaml` and `scripts/settings.yml` (secret redacted) (Anthropic Python SDK 2.8.0 in `python:3.12-slim`, key mounted
read-only from a file, never printed). The SearXNG containers were removed after the run.
