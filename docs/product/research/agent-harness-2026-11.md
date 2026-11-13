# One agent harness contract for every way of paying

**Status:** research for the founder's question of 2026-11-13 ("now everything works differently — someone has shell access, someone
doesn't, something can do X — there can't be such discrepancies; is there a better harness than pi?"), next to
[#1437](https://github.com/ColdPhase/flux/issues/1437). No decision is recorded here; the [questions](#questions-for-the-founder)
at the end need answers first. Every statement is labelled: **observed** (run or read by me on 2026-11-13, in Docker on this host
or in a primary source's code), **vendor claim** (a vendor's own documentation), **published result** (a third party's measurement)
or **inference** (my reasoning). Evidence: [`evidence/harness-2026-11/`](evidence/harness-2026-11/).

## In short

- **The discrepancy is real and has one cause:** today the payer picks the engine. A Claude or ChatGPT plan runs the vendor CLI in
  Flux's runtime; every API key runs Flux's own tool loop in the worker, which has no shell or files and never will
  ([RT-1](../ai-modes.md#rt-1--engines-on-the-server), [RT-5](../ai-modes.md#rt-5--tools)).
  #1437 gives the CLIs shell and files, which widens the gap for API keys.
- **No single harness can serve every payer.** Plans legally enter only through the vendors' own unmodified CLIs
  ([RT-2](../ai-modes.md#rt-2--the-unmodified-cli-no-plan-token-no-impersonation)), and those CLIs speak only their vendor's models:
  Claude Code doesn't support non-Claude models through a gateway (vendor claim), and Codex 0.169.0 speaks only the Responses API
  (observed: `"chat"` is rejected in `model-provider-info/src/lib.rs`). So "the same capabilities" has to be a **Flux capability
  contract** that every engine meets, not one binary.
- **Recommendation: architecture A.** The vendor harness for its own model family however it is paid (Claude Code for Claude plans
  *and* Anthropic API keys; Codex for ChatGPT plans *and* OpenAI API keys), **pi** for every other API key (OpenRouter, Gemini,
  OpenAI-compatible and self-hosted). All three run in the same per-run sandbox of #1437 with the same Flux tools, the same
  `flux_attach_file`, the same "Ask me first" (enforced by Flux's MCP route, not by the harness) and the same egress. API-key
  traffic of all three goes through **one Flux model gateway** that holds the key (it never enters the runtime), reserves the
  daily budget before each request and charges the provider's usage after it, whatever harness sent the request.
- **Is there a better harness than pi for the "everything else" slot? Not today.** pi is the smallest (5 tools, about 1.4k tokens
  of prompt and tool definitions per request against 6–28k for the others, observed), MIT, TypeScript like Flux, has JSON, RPC and
  SDK modes, native MCP with directly exposed tools, prompt caching and per-request usage. **Goose** (Apache-2.0, Rust, its repository now in
  the `aaif-goose` organization) is the closest alternative and the fallback. opencode is the most featureful but the heaviest
  (311 MiB, 2.1 s of CPU to answer one prompt, observed) and has had a remotely exploitable server. Crush is source-available
  (FSL), Qwen Code did not reach the MCP tool directly in the probe, OpenHands' CLI is unmaintained, Aider is stale and has no MCP,
  Amp and Hermes do not fit (details below).
- **What must be measured before switching:** the #1295 answer bench (baseline 0.847 at $0.002 a question on Haiku 5.5, #1410)
  run through Claude Code-on-API-key and pi. Claude Code's own prompt with the six #1437 tools is about 12.6k tokens per request
  (observed), which caching makes cheap but not free; the switch for Anthropic keys happens only if it keeps the score and stays
  within an agreed cost factor (question 3). Effort for A: about 20–30 agent-days in three phases, behind the existing engine.

## 1. What Flux runs today (observed in the repository at `c24afddc3`)

| | Plan (Claude, ChatGPT) | API key (Anthropic, OpenAI, OpenRouter, Gemini, OpenAI-compatible, self-hosted) | Own Claude Code / Codex over MCP |
| --- | --- | --- | --- |
| Loop | Unmodified `claude` / `codex` in the runtime, one Linux user id per person (RT-3) | Flux's `tool-loop.ts` in the worker, three wire adapters in `app/packages/agent-runtime` | On the person's computer |
| Shell, files | None today (RT-5); #1437 adds them in a per-run scratch | None, and the worker cannot give them safely | Their own |
| Web search | CLI's own (Claude `WebSearch`, Codex cached `web_search`) | Provider's hosted search on Anthropic Messages / OpenAI Responses; none on Chat Completions | Their own |
| Page reading, pictures | `flux_read_web`, `flux_attach_image`, `flux_view_image` (Flux server) | same | own tools |
| Money | Plan; Flux cannot see it (RT-8) | Daily budget reserved per request before sending, charged from usage (CA-3; `processor.ts`) | Their own |
| Caching | The CLI's | Anthropic `cache_control` since #1410/#1426 (cache hit 0.70, cost halved, `evidence/1410`) | Their own |
| Approvals | Flux's MCP route makes changes wait (AG-3) | same | LC rules |

The runtime is off by default (RT-9), needs Linux Docker with Yama `ptrace_scope` ≥ 1 and is not supported on Docker Desktop
(operator guide). Its egress is a CONNECT proxy to the CLIs' vendor hosts plus Flux's exact `/mcp` route
(`app/apps/runtime/src/egress/policy.ts`).

## 2. What "the same capabilities" has to mean: the Flux capability contract

Proposed as the acceptance list for any engine (inference from AG-3, AG-8, CA-3, CA-6, RT-3–RT-5 and #1437):

1. **Tools.** The run's exact Flux MCP tools (the only way to read or change Flux), `flux_read_web`, the picture tools,
   `flux_attach_file`; plus, with the runtime, shell, read, write, edit, glob and grep inside the run's scratch only. Nothing else:
   no sub-agents, schedulers, other MCP servers, app builders, image generation or the harness's own page fetcher.
2. **Web search** is the model vendor's hosted search where the wire format has one, and none otherwise, as today (CA-6).
3. **Rights, waits and Undo** are enforced by Flux's MCP route on every call (AG-3). A harness's own permission system is not part
   of the boundary; inside the sandbox nothing asks (the container is the boundary, #1437).
4. **Isolation and network** as RT-3/RT-4 and #1437: read-only root, per-run scratch with caps, the egress only.
5. **Money.** Plans: the vendor's limits (RT-8). API keys: Flux reserves before each model request and charges after it, so a key's
   daily budget holds on every engine.
6. **Events.** The run streams text, tool calls, usage and a final result that Flux turns into its own frames; a preflight reads the
   tool list the harness actually offers and stops the run on anything outside item 1 (as RT-5 does today).
7. **Same brief** appended to the harness's own system prompt, never replacing it.

## 3. Candidates (sources read 2026-11-13)

Repository facts from the GitHub API (licence, stars, last push, releases) and npm metadata, all observed 2026-11-13.

| | Claude Code | Codex CLI | pi | opencode | Goose | Crush | Qwen Code | Gemini CLI | OpenHands | Aider | Cline CLI | Amp | Hermes Agent |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Version (date) | 2.1.323 (11-12) | rust-v0.169.0 (11-13) | 1.5.2 (11-10) | 2.3.0 (11-13) | 1.59.0 (11-10) | 0.101.0 (11-12) | 0.27.3 (11-13) | 0.68.0 (11-10) | 1.40.0 (11-12) | last push 2026-05-22 | cli-v3.0.74 (10-26) | rolling | 0.23.1 (11-10) |
| Licence | Proprietary (Anthropic terms) | Apache-2.0 | MIT | MIT | Apache-2.0 | FSL-1.1-MIT (source-available) | Apache-2.0 | Apache-2.0 | MIT | Apache-2.0 | Apache-2.0 | Proprietary | MIT |
| Can Flux bundle it in the AGPL runtime image | No; downloaded by `runtime-install` (RT-2) | Yes (already) | Yes | Yes | Yes | Aggregation only, non-OSI terms | Yes | Yes | Yes | Yes | Yes | No | Yes |
| Providers | Claude only: Anthropic API, Bedrock, Google's Agent Platform, Foundry, a gateway (vendor claim) | OpenAI; any **Responses** endpoint; Ollama/LM Studio via `--oss` (vendor claim, observed source) | Anthropic, OpenAI, Google, OpenRouter, Mistral, Groq, xAI, DeepSeek, Bedrock, Vertex and about 30 more (observed docs); any OpenAI-, Anthropic- or Google-compatible base URL; llama.cpp, Ollama, vLLM | models.dev catalog, openai-compatible, Ollama, LM Studio, vLLM (vendor claim) | openai, anthropic, ollama, databricks and others (observed help) | openai-compat and others (observed) | openai, openai-responses, anthropic, gemini, vertex-ai, qwen (observed help) | Gemini only (vendor) | n/c | n/c | n/c | Amp's own billing (third party) | Nous Portal, OpenRouter, OpenAI, own endpoint (observed README) |
| Plan sign-in | Official (Claude) | Official (ChatGPT device code) | **Reuses Claude Code's OAuth client id** (observed in `packages/ai/src/auth/oauth/anthropic.ts`) and ships ChatGPT/Codex OAuth — RT-2 forbids using these | ChatGPT "Sign in with ChatGPT" (vendor claim) | Through its `claude-code` and `gemini-cli` providers (observed in help) | — | Qwen OAuth (observed in help) | Google login (n/c) | — | — | n/c | Amp account | Nous Portal (observed README) |
| Headless streaming JSON | `-p --output-format stream-json` (observed) | `exec --json` (observed) | `--mode json`, `--mode rpc`, TS SDK (observed) | `run --format json`, HTTP server + SDK (observed) | `run --output-format stream-json` (observed) | **None** (`crush run` prints text) | `-o stream-json` (observed) | n/c | `--headless --json`, but the CLI "is no longer actively maintained" (vendor claim) | n/c | "fully headless" (vendor claim) | `-x --stream-json` (third party) | n/c |
| MCP client, Flux tool reached directly | Yes (observed; MCP tools deferred behind ToolSearch unless `ENABLE_TOOL_SEARCH=false`) | Yes (observed) | Yes with `exposure: direct` (observed; default is codemode) | Yes with `codemode: false` (observed) | Yes (observed) | Yes (observed) | MCP connected but tool not offered directly (observed; deferred) | n/c | n/c | n/c | n/c | n/c | MCP supported (observed README) |
| Built-in shell / read / write / edit / glob / grep | All (observed) | `exec_command` shell; files through it and patches (observed) | read, bash, edit, write; grep, find, ls optional (observed) | All, plus webfetch, websearch, subagent, image generation (observed) | shell, write, edit, tree, analyze (observed) | All plus LSP, fetch, sourcegraph (observed) | All plus cron, worktrees, agents (observed) | n/c | n/c | n/c | n/c | n/c | "40+ tools" (observed README) |
| Own web search | Yes, Anthropic hosted (observed `WebSearch`) | Yes, OpenAI hosted (observed `web_search`) | No (observed) | Yes, `websearch` (observed) | No by default (observed) | No; fetch only (observed) | No; `web_fetch` only (observed) | n/c | n/c | n/c | n/c | n/c | Through Nous Portal (observed README) |
| Approval hooks (only for in-sandbox tools) | `--permission-mode`, hooks, `--permission-prompt-tool` (vendor claim) | `approval_policy`, sandbox modes (vendor claim) | `tool_call` extension event can block (observed in docs) | allow/ask/deny per action; `--auto` (vendor claim, observed flag) | `GOOSE_MODE` (observed config) | `-y` (observed) | `--approval-mode` (observed) | n/c | Always approves in headless (vendor claim) | n/c | n/c | n/c | n/c |
| Prompt caching | Automatic (vendor claim) | Automatic, `prompt_cache_key` (vendor claim) | Anthropic `cache_control`, OpenAI `prompt_cache_key`, compatible `cache_control` (observed in source) | n/c | n/c | n/c | n/c | n/c | n/c | n/c | n/c | n/a | n/c |
| Usage in its output | `result.usage` + `costUSD` (observed) | `turn.completed.usage` incl. cached (observed) | per message incl. cache read/write and cost (observed) | `step_finish.tokens` + cost (observed) | `complete` totals incl. cache (observed) | None (observed) | `result.usage` (observed) | n/c | n/c | n/c | n/c | token usage (third party) | n/c |
| Custom base URL + credential (for a Flux gateway) | `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`/`apiKeyHelper`; gateways documented (vendor claim) | `model_providers.<id>.base_url`, `env_key` (observed) | `baseUrl`, `apiKey` per provider (observed) | `settings.baseURL` (observed) | `OPENAI_HOST` etc. (observed) | `base_url` (observed) | `--openai-base-url` (observed) | n/c | n/c | n/c | n/c | No (Amp's service) | "your own endpoint" (observed README) |
| Runs offline with read-only root, tmpfs home, no caps (probe) | Yes | Yes | Yes | Yes (`--standalone`) | Yes | Yes | Yes | not run | not run | not run | not run | not run | not run |
| GitHub security advisories (published, high+critical / total) | 29 / 36 (latest 2026-10-26, Edit tool TOCTOU) | 1 / 1 (2025-09 sandbox bypass) | 1 / 4 (2026-06) | 3 / 3 (incl. 2026-01 unauthenticated HTTP server RCE, critical XSS→RCE) | 1 / 1 (2026-07) | 0 / 0 | 0 / 0 | 0 / 0 | 1 / 1 | — | 2 / 3 (incl. a hijacked npm publish, 2026-02) | — | 0 / 0 |
| Maturity, cadence | Several releases a week | Several a day (incl. alphas) | About weekly; repo moved to `earendil-works`; new contributors' issues and PRs "closed automatically" (observed README) | Several a week; 226k stars | Weekly; now `aaif-goose` | Weekly | Daily | Weekly | Daily | Stalled | Last CLI release 2026-10-26 | Rolling npm builds | Weekly; 263k stars |

n/c = not checked on 2026-11-13. Advisory counts show disclosure practice as much as security: Anthropic runs a HackerOne programme and publishes many.

**Excluded, with the reason.** Gemini CLI: Gemini only. Amp: proprietary and billed by Amp, not by the person's key. Aider: no agent
tool loop or MCP, last push 2026-05-22. OpenHands: its CLI is marked unmaintained (it points to "Agent Canvas"), and headless mode
always approves. Hermes Agent: a personal-assistant product with its own memory, gateways and Python stack; Flux agents remember only
what their owner says (AG-1), and Flux has recorded that Hermes' core Claude route impersonates Claude Code (RT-2). Kilo CLI: a fork
of opencode (observed README). Crush: FSL-1.1 is not an open-source licence and `crush run` has no machine-readable output.
Cline CLI and Mistral Vibe: not probed; nothing they offer beats pi or Goose for this slot.

## 4. The offline probe (observed, 2026-11-13)

Each harness ran once in the throwaway image of [`Dockerfile`](evidence/harness-2026-11/Dockerfile) with
[`probe.sh`](evidence/harness-2026-11/probe.sh): read-only root, 256 MiB tmpfs home and `/tmp`, `--cap-drop ALL`,
`no-new-privileges`, 1 CPU, 1 GiB, on an internal Docker network whose only peer is [`mock.py`](evidence/harness-2026-11/mock.py)
(a scripted model for Chat Completions, Responses and Messages, plus a streamable-HTTP MCP server with one tool, `flux_echo`,
behind a bearer token). No API key, no internet. The prompt asks for the Flux tool; the mock calls it and then answers. Raw
journals, `/usr/bin/time -v` output and the tails of each event stream are in `run-1/` (all eight harnesses; the table) and `run-2/` (an earlier run of
the last two, the same result).

| Harness, as configured | Model requests | Flux tool called | Tools offered | System prompt (chars) | Tool definitions (bytes) | ≈ tokens per request before any work | Largest process RSS | Wall / CPU to the answer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pi 1.5.2, default tools | 2 | yes | 5 | 2,251 | 3,180 | ~1.4k | 124 MiB | 0.44 s / 0.45 s |
| Goose 1.59.0, default profile | 3 (one is a title) | yes | 18 | 4,271 | 13,616 | ~4.5k | 125 MiB | 0.38 s / 0.25 s |
| opencode 2.3.0, `--standalone`, `codemode: false` | 3 (one is a title) | yes | 14 | 8,582 | 16,209 | ~6.2k | 311 MiB | 2.14 s / 2.14 s |
| Codex 0.169.0, defaults | 2 | yes | 19 | 20,155 | 20,038 | ~10k | 146 MiB | 0.31 s / 0.23 s |
| Claude Code 2.1.323, #1437 tools (`--tools Bash,Read,Write,Edit,Glob,Grep`) | 2 | yes | 7 | 27,097 | 23,264 | ~12.6k | 207 MiB | 0.52 s / 0.45 s |
| Crush 0.101.0 | 3 | yes | 29 | 22,127 | 29,537 | ~12.9k | 77 MiB | 0.43 s / 0.24 s |
| Qwen Code 0.27.3 | 2 | **no** (deferred) | 29 | 22,623 | 66,397 | ~22k | 203 MiB | 2.46 s / 2.44 s |
| Claude Code 2.1.323, all default tools | 2 | yes | 26 | 27,785 | 86,022 | ~28k | 209 MiB | 0.45 s / 0.41 s |

Tokens are characters ÷ 4 (inference). RSS is the largest single process of the run (GNU time over `timeout`). These are startup
costs with an instant model; a real run's memory grows with its context. Codex's and Claude Code's figures match Flux's own
measurements (87 MiB idle `app-server`, 195 MiB Claude Code start; operator guide, 2026-11-05).

What the probe shows beyond the table:

- **Every candidate except Qwen Code reached a Flux tool over streamable HTTP with a bearer header**, and each needed one switch to
  stop hiding MCP tools behind its own search or code mode (Claude Code `ENABLE_TOOL_SEARCH=false`, pi `exposure: direct`, opencode
  `codemode: false`). That switch belongs in each engine's flag contract test.
- **Defaults offer far more than Flux allows.** Claude Code offers schedulers, sub-agents, worktrees, `WebFetch`; Codex offers
  sub-agents, goals, `request_user_input`, `view_image`; opencode `webfetch`, `subagent`, image generation; Goose an app builder,
  `delegate` and an extension manager. Every engine therefore needs a pinned allow-list and the read-back preflight RT-5 already
  does for Claude Code and Codex.
- **All run on a read-only root with a tmpfs home and no network but the mock**, with no hang on blocked telemetry or update checks.
- **The prompt overhead differs by an order of magnitude.** On a self-hosted model with a 32k context, Claude Code's or Qwen Code's
  defaults would use most of the window before the brief (inference). pi's 1.4k is closest to Flux's own engine.

## 5. Findings that decide the architecture

1. **Plans need the vendor CLIs; nothing else is allowed** (vendor claim, code.claude.com/docs/en/legal-and-compliance, read
   2026-11-13: "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route
   requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users"; RT-2's OpenAI rules). pi's and opencode's
   plan logins are therefore unusable in Flux; the engine for a Claude plan is Claude Code and for a ChatGPT plan Codex, permanently.
2. **Claude Code with the person's own Anthropic API key is allowed in a hosted product** (vendor claim, same page): running it "in
   hosted sandboxes or other agent infrastructure requires agreeing to our Commercial Terms of Service", the binary unmodified, and
   "each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference provider
   credential … billed directly to the end user". Flux already records the operator's Commercial Terms statement before installing
   Claude Code (RT-2).
3. **A gateway can keep the key out of the runtime and meter every request** (vendor claim, code.claude.com/docs/en/llm-gateway:
   "the provider key stays server-side; developers hold gateway credentials instead"; "enforce budgets and rate limits in one place";
   Claude Code "doesn't support routing Claude Code to non-Claude models through any gateway"). Codex, pi, opencode and Goose all take
   a base URL and a credential per provider (observed). So the same mechanism serves every harness: the runtime gets a run-scoped
   gateway token, Flux's gateway swaps it for the sealed key (CA-4 stays: "an API key is never passed into the CLI runtime"),
   reserves the request's worst case against the daily budget before forwarding (CA-3 stays exact), reads the usage from the
   response and charges it. A refusal must be a non-retryable 4xx with a clear message, and the gateway also tells the worker to stop
   the run: Codex retried a broken stream five times in the probe (observed).
4. **Vendor harnesses lead published agentic benchmarks.** The Terminal-Bench leaderboard as served on 2026-11-13 (page heading
   "Terminal-Bench 4.1"; extract in [`terminal-bench-2026-11-13.tsv`](evidence/harness-2026-11/terminal-bench-2026-11-13.tsv)) lists
   only Claude Code, Codex, mini-swe-agent, Grok Build and Muse Code; the top entries are Claude Code with Opus 5.5 (65.76%) and Codex
   with GPT-6.1 Sol (60.91%) (published result). No pi, opencode or Goose entry exists there, so for those there is no comparable
   published quality figure. Flux's own tasks are workspace questions and edits, not terminal tasks; Flux's #1295 bench is the
   measure that counts (inference).
5. **"Ask me first" does not depend on the harness.** Every Flux change goes through the MCP route, which makes it wait (AG-3). A
   harness's permission hooks matter only for actions inside the sandbox, which #1437 lets run without asking (observation of the
   contracts; question 2 confirms the reading).
6. **Codex cannot be the "everything else" harness** (observed): Responses only, so not OpenRouter's or Gemini's Chat Completions
   endpoints or most self-hosted servers.

## 6. Architectures

### A — the vendor's harness for its models however paid, pi for every other key (recommended)

| Connection | Engine in the runtime | Model traffic |
| --- | --- | --- |
| Claude plan | Claude Code | CONNECT to Anthropic (unchanged) |
| Anthropic API key (incl. Max/Team monthly API credits) | Claude Code when the operator made the Commercial Terms statement; otherwise pi | Flux gateway → `api.anthropic.com` |
| ChatGPT plan | Codex | CONNECT to OpenAI (unchanged) |
| OpenAI API key | Codex | Flux gateway → `api.openai.com` (Responses) |
| OpenRouter, Gemini, OpenAI-compatible, self-hosted | pi | Flux gateway → the endpoint, under CA-4's base-URL guard |

- **For:** a Claude model behaves the same whether paid by plan or by key, and likewise for GPT, which is the discrepancy the founder
  sees most. Web search stays exactly as today (hosted search on Anthropic and OpenAI, none on Chat Completions). The vendors keep
  tuning their harness for their models. Flux keeps two engines it already parses and adds one small one.
- **Against:** three harnesses to pin, contract-test and parse. Claude Code's prompt is about 12.6k tokens a request with the #1437
  tools (observed), so an Anthropic-key run may cost more than today's engine until caching absorbs it; measured, not assumed.
  OpenRouter users running a Claude model get pi, not Claude Code (Claude Code through a non-Anthropic gateway is unsupported).

### B — one harness for every API key, the vendor CLIs only for plans

pi for all keys; Claude Code and Codex only for plans. Same gateway, same contract.

- **For:** one key engine, one parser for keys; the smallest prompt overhead for every key; no Commercial Terms statement needed for
  Anthropic keys.
- **Against:** a Claude model now runs in two different harnesses depending on payment, which is the founder's complaint in another
  form. pi has no web search, so Anthropic- and OpenAI-key agents lose the hosted search they have today unless Flux adds it to pi
  (an extension that injects the provider's search tool; not verified). Still three harnesses in total, because plans need the two
  CLIs.

### C — keep Flux's engine and give it sandboxed tools

Flux's tool loop stays for API keys and gets Flux-defined `flux_shell`, `flux_read_file`, `flux_write_file`, `flux_edit_file`,
`flux_glob`, `flux_grep` that the runtime supervisor executes in the run's scratch. The CLIs keep their own tools (#1437).

- **For:** metering, caching, the brief and the #1295 score (0.847) stay exactly as built; least new surface; works the same with
  any provider; about 8–12 agent-days.
- **Against:** Flux maintains a coding-agent tool set and loop forever (edit semantics, output truncation, context compaction) that
  the harness projects already maintain; models are tuned to their own vendor's tool shapes; the shell still needs the runtime, so
  installs without it are no better. A variant (C′) that gives the CLIs only these Flux tools too would make tools literally
  identical but contradicts #1437's founder decision to let the CLIs keep their own.

## 7. Recommendation: A, gated by measurement

**Why A.** It is the only option where the same model family has the same harness on every payment route, and where nothing a person
has today (hosted search, the vendors' caching, plan support) is lost. The capability contract (section 2) makes the three engines
equal in what they may do; the gateway makes them equal in money. pi is the right third engine: the least prompt overhead (matters
most for self-hosted models), MIT, TypeScript, JSON/RPC/SDK modes, direct MCP, caching and usage in its own events.

**Risks and mitigations.**

| Risk | Mitigation |
| --- | --- |
| Claude Code on an Anthropic key costs more or answers worse than today's engine | #1295 bench before the switch; keep today's engine for Anthropic keys (or fall back to B for them) if it misses the gate |
| pi's governance: young company repo, outside issues closed automatically, four advisories in 2026-06 | Pin by checksum, flag contract test, `--no-extensions --no-skills --no-context-files --no-approve --offline`, `PI_TELEMETRY=0`, no `auth.json`; Goose as the documented fallback (both MIT/Apache, same gateway) |
| pi ships plan OAuth that reuses Claude Code's client id | Flux never runs `/login`; the runtime holds no vendor credential for pi runs; the egress gives a pi run only the gateway route, never `claude.ai`, `platform.claude.com` or `chatgpt.com` (needs per-run egress identity: a proxy credential per run, since people share one network namespace, RT-3) |
| A harness update adds a default-on tool or changes its events | The existing pattern: pinned versions, flag contract test, read-back preflight of the offered tools, stop on anything unknown |
| Gateway refusal causes retry storms | Non-retryable 4xx plus a stop from the worker; tested per engine with the mock |
| Prompt injection now reaches a shell | #1437's threat model: the sandbox and egress are the boundary, not the tool list; the gateway token is run-scoped and useless outside Flux |

## 8. Migration path from today's engine

1. **Gateway first (no behaviour change).** Add a model route to Flux reached through the egress like `/mcp`, keyed by the run token.
   It reuses `app/packages/agent-runtime` (endpoint guard, the three wire formats, usage parsing) and the reservation and charging of
   `processor.ts`/`service.ts`. Point today's engine at it too, so one path meters everything. The #1295 recording proxy
   (`eval-proxy.ts`) is the same idea and shows the usage parsing works on real responses.
2. **API keys into the runtime, behind a per-connection switch.** OpenAI keys → Codex with a custom provider at the gateway;
   Anthropic keys → Claude Code with `ANTHROPIC_BASE_URL` + a run token as `ANTHROPIC_AUTH_TOKEN`; other keys → pi with generated
   `models.json` and `mcp.json` (`exposure: direct`). Each gets a flag contract test, a preflight and the vendor-mock scenarios of
   `scripts/check_cli_runtime.sh` (pi and Codex can run against a Chat Completions / Responses mock like `mock.py`).
3. **Measure, then switch.** Run the #1295/#1409 bench on the same key and model (Haiku 5.5, 62 questions, about $0.25 a run) for
   today's engine, Claude Code and pi; OpenAI key: today's engine against Codex; one self-hosted small model on pi. Switch each
   connection type only when it meets the gate (question 3). Caching: Claude Code and Codex cache by themselves; pi sets
   `cache_control`/`prompt_cache_key` (observed in source); the bench's cache-hit column (0.70 today) shows any regression.
4. **Retire the tool loop** (`tool-loop.ts`, the run-time parts of `processor.ts`) once every connection type has switched, keeping
   the adapters for the gateway, model lists and price checks. Docs first: RT-1, RT-5, CA-3/CA-4/CA-6, AG-8, the operator guide.

**Effort (inference):** gateway 5–8 agent-days; three engines 6–10; capability-contract conformance tests 3–4; bench runs and tuning
2–3; retirement and docs 3–4; about 20–30 agent-days, outside v0.2.1's "faster on 2 vCPU" scope. Memory: plan 1 GiB per active run as
today; pi's and Codex's start are lighter than Claude Code's (section 4).

## 9. Installs without the runtime

The runtime needs Linux Docker with Yama `ptrace_scope` ≥ 1 and an operator step (RT-9); Docker Desktop is unsupported. On such an
install no engine can have a shell, whatever the harness. To keep the founder's rule (no difference by how a person pays), the
capability becomes a property of the server, the same for everyone on it: **"Agents on this server use Flux's tools only (no files
or shell)"**, shown once in Settings › AI and in the operator guide. API keys keep working through today's engine (and later pi with
`--no-tools`, so one loop remains); plan sign-in stays unavailable as today; `flux_attach_file` takes content directly. Making the
runtime the default for agents in `./flux up` (it no longer needs a vendor statement for pi or Codex on keys) would make this the
exception rather than the rule (question 4).

## Questions for the founder

1. **A or B for Anthropic keys?** A runs Claude Code for an Anthropic key (same as the Claude plan; needs the operator's Commercial
   Terms statement, falls back to pi without it). B runs pi for every key (one key engine, but Claude behaves differently by plan or
   key and loses hosted search).
2. **Does "Ask me first" cover the shell?** My reading: no — it covers changes in Flux (AG-3), and shell and files inside the run's
   scratch run without asking (#1437). If it should, every engine needs its permission hook wired to a Flux wait.
3. **The switch gate:** keep or beat the #1295 score (0.847 on Haiku 5.5) at no more than how many times today's cost per question
   ($0.002)? Proposal: score ≥ today, cost ≤ 1.5×.
4. **Runtime by default?** Should `./flux up` turn the runtime on for API-key agents on hosts that meet its requirements, so files
   and shell are the normal case, with "Flux tools only" as the labelled exception?

## Sources (all read 2026-11-13)

- Anthropic, Claude Code legal and compliance: <https://code.claude.com/docs/en/legal-and-compliance> (vendor claim).
- Anthropic, Claude Code LLM gateways: <https://code.claude.com/docs/en/llm-gateway> (vendor claim).
- OpenAI, Codex advanced configuration (redirects to <https://learn.chatgpt.com/docs/config-file/config-advanced>) (vendor claim);
  `codex-rs/model-provider-info/src/lib.rs` at `rust-v0.169.0` (observed: `WireApi` has only `responses`).
- pi: <https://github.com/earendil-works/pi> README and `packages/coding-agent/docs/{mcp,providers,json,security,containerization,cli,models,extensions,environment-variables}.md`;
  `packages/ai/src/auth/oauth/anthropic.ts`, `packages/ai/src/api/{anthropic-messages,openai-completions}.ts` (observed).
- opencode: <https://opencode.ai/docs/providers/>, <https://opencode.ai/docs/permissions/>, <https://opencode.ai/docs/mcp-servers/>, release notes v2.3.0 (vendor claims); `opencode run --help` (observed).
- Goose `goose run --help`, Crush `crush run --help`, Qwen Code `qwen --help` in the probe image (observed).
- OpenHands headless docs: <https://docs.openhands.dev/openhands/usage/cli/headless> (vendor claim: CLI no longer maintained).
- Amp: third-party CLI references found by search (e2b.dev, developersdigest.tech); no primary pricing page confirmed.
- GitHub REST API: repository licence, stars, last push, releases, published security advisories for each repository; npm registry
  metadata (observed).
- Terminal-Bench leaderboard: <https://www.tbench.ai/leaderboard/terminal-bench/2.0> as served (published result; extract saved).
- Flux: `docs/product/ai-modes.md`, `model-providers.md`, `assistant.md`, `decisions.md` (F-020, F-022, F-036, F-042, C-12, C-37),
  `docs/operations/agent-runtime.md`, #1437, `research/evidence/1295` and `1410`, `app/apps/runtime/src/egress/policy.ts`.
