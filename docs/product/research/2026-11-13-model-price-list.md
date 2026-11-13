# Model prices from a maintained public list (#1465)

**Date:** 2026-11-13 (all readings 18:50–19:10 UTC). **Question:** which maintained public price list Flux
refreshes its model prices from every day, now that the hand-kept `AI_PRICE_TABLE` goes (founder decision,
Hubert, 2026-11-13, [#1465](https://github.com/ColdPhase/flux/issues/1465)). Founder rule: use an existing
maintained source rather than building one. Raw copies of every page and file read are kept outside the
repository under `~/flux-evidence/v021/1465/raw/` on the machine that made the readings.

## Candidates

| | OpenRouter model list | LiteLLM price file |
| --- | --- | --- |
| Address | `GET https://openrouter.ai/api/v1/models` (no key) | `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json` |
| Size read | 849,076 bytes, 470 models | 4,072,360 bytes, 5,980 entries (24 Anthropic, 102 OpenAI and 47 Gemini chat models; 24 OpenAI `responses` models) |
| Ids | `vendor/model` with dots: `anthropic/claude-opus-5.5`, `openai/gpt-6.1-sol`, `google/gemini-3.1-pro-preview` | The provider's own API id: `claude-opus-5-5`, `gpt-6.1-sol`; Gemini as `gemini/gemini-3.1-pro-preview`; each entry names its `litellm_provider` |
| Prices | OpenRouter's own resale prices, USD per token as decimal strings; long-prompt tiers as `overrides` with `min_prompt_tokens` | USD per token as numbers; long-prompt tiers as `input_cost_per_token_above_<N>k_tokens`; batch, flex, priority and cache rates as separate fields |
| Terms | Terms of Service, "Last Updated: August 31, 2026", §7: no "scripts, robots or any other means or processes (such as crawlers, browser plugins, add-ons or any other automated technology) to scrape or copy any information on the Site or the Services" | MIT licence for everything outside `litellm/enterprise/` (the repository's `LICENSE`, read 2026-11-13); the price file is outside it |
| Upkeep | Run by OpenRouter for its own routing | Community-maintained in the LiteLLM repository; 10 commits to the file on 2026-11-13 alone, the newest at 18:34 UTC (GitHub commits API) |

## Sample: the providers' own pages against both lists

Standard (paid, non-batch) input / output price in USD per 1M tokens for the prompt tier Flux's largest
server request can reach (64,000 tokens plus 50,000 of web search results). Provider pages: Anthropic
`platform.claude.com/docs/en/about-claude/pricing.md`, OpenAI `developers.openai.com/api/docs/pricing.md`
(undated), Gemini `ai.google.dev/gemini-api/docs/pricing` (redirects to `aistudio.google.com/docs/pricing`,
undated).

| Model (provider id) | Provider page | LiteLLM | OpenRouter |
| --- | --- | --- | --- |
| `claude-opus-5-5` | $4 / $20 | $4 / $20 | $4 / $20 |
| `claude-sonnet-5` | $2 / $10 (footnote: the introductory price is now standard) | $2 / $10 | $2 / $10 |
| `claude-sonnet-5-5` | $2 / $10 | $2 / $10 | $2 / $10 |
| `claude-haiku-5-5` | $0.10 / $0.50 up to 100,000 prompt tokens; $0.50 / $2.50 over | $0.10 / $0.50, and `_above_100k_tokens` $0.50 / $2.50 | $0.10 / $0.50, override from 100,000 tokens $0.50 / $2.50 |
| `claude-fable-5-2` | $8 / $40 | $8 / $40 | $8 / $40 |
| `claude-opus-4-5` | $5 / $25 | $5 / $25 | $5 / $25 (`anthropic/claude-opus-4.5`) |
| `gpt-6-astra` | $10 / $50 (≤272k) | $10 / $50 | $10 / $50 |
| `gpt-6.1-sol` | $2 / $10 (≤272k) | $2 / $10 | $2 / $10 |
| `gpt-6-luna` | $0.10 / $0.50 | $0.10 / $0.50 | $0.10 / $0.50 |
| `gpt-5.6-terra` | $2 / $12 | $2 / $12 | $2 / $12 |
| `gpt-5.6-sol` | $4 / $20; "promotional pricing is available until November 30, 2026" | $4 / $20 | **$4.40 / $22** |
| `gemini-3.1-pro-preview` | $2 / $12 (≤200k) | $2 / $12 | $2 / $12 |
| `gemini-2.5-pro` | $1.25 / $10 (≤200k) | $1.25 / $10 | $1.25 / $10 |
| `gemini-3.5-flash-lite` | $0.30 / $2.50 | $0.30 / $2.50 | $0.30 / $2.50 |
| `gemini-3.8-flash` | $0.75 / $3.75 through 2026-12-31, $1.50 / $7.50 from 2027-01-01 | $0.75 / $3.75 | **$0.825 / $4.125** |
| `gemini-4-carbon` | $2 / $10 through 2026-11-30, $4 / $20 from 2026-12-01 | $2 / $10 | $2 / $10 |

Against the 54 rows of the removed `AI_PRICE_TABLE` (read from the same pages on 2026-11-12):

- **LiteLLM** has all 54 under the provider's own id, including the dated snapshots
  (`claude-opus-4-5-20251101`) and Claude Mythos. 53 equal the table; the 54th is Claude Haiku 5.5, where the
  table carried the over-100k tier and LiteLLM's base field the lower one, with the tier in its own field.
- **OpenRouter** has 48 (no dated snapshots, no Mythos), and only after translating `-` to `.` in the version
  (`claude-opus-4-5` → `anthropic/claude-opus-4.5`); 47 equal the table.

Cache rates: both lists carry per-model cache read and write prices that match Anthropic's page (0.05× read
on Opus 5.5 and Sonnet 5.5, 1.25× write). Flux's price model does not use per-model cache prices: it charges
Anthropic cache writes at 1.25× and reads at 0.1× of the input price (`PROMPT_CACHE_RATES`), which is never
below what Anthropic bills, and other providers' cached input at the full price. That stays unchanged.

## Observations

1. On this sample LiteLLM equals the providers' pages on every standard price; OpenRouter equals them except
   on two models, where it is 10% higher (`gpt-5.6-sol`, `gemini-3.8-flash`): OpenRouter's list is OpenRouter's
   own resale price, not the provider's.
2. Neither list carries a price change the provider has announced for a later date (Gemini 4 Carbon from
   2026-12-01, Gemini 3.8 Flash from 2027-01-01, GPT-5.6 Sol's promotion ending 2026-11-30). Both show today's
   price.
3. LiteLLM uses the provider's own model ids; OpenRouter's ids need a vendor prefix and a dot translation that
   fails for dated snapshots.
4. LiteLLM has no entries for OpenRouter's own models (`openrouter/…`: 0 entries on 2026-11-13).
5. OpenRouter's terms forbid automated technology that "scrape[s] or copy[ies] any information on the Site or
   the Services"; LiteLLM's file is MIT-licensed.
6. Both answered `200` to an anonymous `GET` with no key, cookie or header beyond `User-Agent`.

## Inferences

- Copying OpenRouter's whole list into every Flux server daily would sit uneasily with its §7; reading it as a
  person's own OpenRouter model list (what Connect AI already does for an OpenRouter key) is ordinary use.
- Because neither list knows future prices, a daily refresh lags a provider's change by up to a day plus the
  list's own upkeep delay. On 2026-11-13 LiteLLM's maintainers committed same-day provider changes; this is
  a sample of one day, not a measured lag.
- A provider that raises a price before the list follows it is under-reserved for that gap. The daily budget
  still bounds what a key spends per day; OpenRouter reports each answer's cost, which reconciles its charge.

## Decision (agents, under the founder's #1465 rule)

**LiteLLM's `model_prices_and_context_window.json`** is Flux's price list, for Anthropic, OpenAI and Gemini:
the provider's own ids, the providers' own prices on every sampled model, all 54 previous rows, the long-prompt
tiers in their own fields and an MIT licence. Flux takes, for each chat or Responses model of those three
providers, the standard input and output price, raised to any `_above_<N>k_tokens` tier whose threshold is
below Flux's largest server request (so Claude Haiku 5.5 is $0.50 / $2.50, as before), and nothing else
(no batch, flex, priority, regional or cache fields).

OpenRouter and an OpenAI-compatible endpoint have no price in the list. Their models are priced by the owner,
as today; for OpenRouter the price its list shows is filled in for the owner to confirm, and OpenRouter's
reported cost reconciles each charge.

Rejected: OpenRouter's list as Flux's price list (its own resale prices, 10% above two providers' pages in the
sample, an id translation that misses snapshots, and terms against automated copying); building and keeping a
list in Flux (the founder rule).
