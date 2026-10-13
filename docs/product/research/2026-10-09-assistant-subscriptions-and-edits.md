# The assistant on a subscription: use, switches, edits and background work (research, 2026-10-09)

**Question.** Can Flux's assistant run on the owner's own Claude or ChatGPT
subscription for (1) runs the owner starts, (2) edits the owner asks for and (3)
scheduled jobs and event reactions; and how should switches, direct edits and
background work be designed so that it is simple and safe?

**Persona and situation.** Ada self-hosts Flux for a side project and later for a
small team. She pays for Claude Max (or ChatGPT Pro) and does not want an API key.
She wants to say "tidy this project's tasks" and have it done, decide what the
assistant may touch, and get a summary every morning.

**Author:** @PelikanFix16 (`claude-hubert`), 2026-10-09, as evidence for the
[assistant proposal](2026-10-09-assistant-proposal.md), which asks Hubert to decide
the suggested changes. This file changes no decision.

**Labels.**
- **[V]** vendor or project documentation, quoted verbatim;
- **[S]** observed in Flux source at `origin/main` `05f89591` or a named PR head;
- **[P]** press, context only;
- **[I]** inference by this author.

**Retrieval.** Every web source below was retrieved on **2026-10-09**. Two research
agents fetched the pages (WebFetch, curl, Wayback for 403s); this author re-fetched
the decisive ones the same day and confirmed the quotes marked ✔. No real Claude or
ChatGPT account was used, so every behaviour on a real subscription is
**unverified**.

## 0. Bottom line

1. **Nothing found forbids** the owner's own scheduled use of their own plan through
   the official CLI. Anthropic itself documents scheduled Claude Code on Pro and Max
   (GitHub Action on cron with a subscription token, Routines), and OpenAI documents
   `codex exec` for "scheduled jobs" with a ChatGPT login as a non-default path. Both
   recommend API keys for automation. Background use on a subscription is therefore
   an **owner opt-in with an honest note**, not a ban (proposal C1).
2. **The real risk is still the hosted engine** (F-022 accepted risk 2), now with a
   new item: Anthropic's Usage Policy **effective 2026-11-12** forbids services that
   "route requests through consumer subscriptions" through "unauthorized means" ✔.
   The legal page's carve-out for "a platform hosts Claude Code" is the authorization
   Flux relies on. Re-read both on 2026-11-12.
3. **A better Claude path exists for automation since 2026-10-07:** Max and Team plans
   include monthly Claude Platform credits usable "with an API key from your linked
   Claude Console organization", covering `claude -p` and the Agent SDK ✔. That is
   the vendor-recommended way to automate and is still paid by the owner's plan.
4. **Precedent.** Only "run the unmodified official CLI or SDK under the user's own
   login" survived 2026 without enforcement (Zed, Conductor, Cline, Happy, Omnara,
   OpenClaw's CLI back end). Token reuse did not (opencode removed its Claude plugin
   after legal requests; Hermes' Claude path bills as extra usage). OpenClaw and
   Hermes both ship cron and both put a permission layer in front of it.
5. **Flux already has every write tool** an MCP client uses (45 tools), S6 switches in
   review (PR #390) and per-run tokens in the F-022 design. The in-Flux assistant uses
   none of the write tools today. The design therefore reuses them instead of adding
   an assistant-only path.

## 1. Current state in Flux

### 1.1 Decisions and contracts

| Record | What it says today | Relevance |
| --- | --- | --- |
| [F-022](../ai-modes.md) (accepted 2026-10-05) | Two modes. Mode (a) has `server` (API key) and `runtime` (official CLI in an isolated slot) transports. `runtime` is for owner-triggered runs only; "Background rules (O-007) keep `server` connections." The runtime's agent connection is `owner_runtime`; "The first slice allows `flux.context.read` only." Operator switch `FLUX_AGENT_RUNTIME`, off by default. Accepted risks rated medium–high (Claude Code) and medium (Codex) | The proposal suggests changing the background rule, the agent connection and the read-only slice (C1, C6, C7) |
| [F-020](../model-providers.md) PROV-1–6 | Provider-neutral `server` connections; `runtime` connections have no key or price; PROV-3 caps; "no tools, no hosted search, no automatic retries" per request | The proposal suggests a bounded tool loop (C9) |
| [O-008](../personal-runs-compute.md) | One capped request per run; "Each run is **one** Messages API request … no … automatic tool loop"; consequential changes become proposals | The proposal suggests direct changes and a tool loop (C3, C9) |
| [O-007](../background-compute.md) | Event-triggered comparison rule on an API key | Unchanged: its trigger is any contributor's result |
| [F-019](../decisions.md) | Owner-only invocation and payer; "Only that owner (or a narrow standing rule the owner configured) may invoke" | Scheduled jobs and reactions are such narrow rules |
| [F-024 S6](../mcp-identity.md#s6--owner-mcp-capability-switches) (#316) | Owner switches for Read / Suggest / Execute capabilities and selected projects as a restrictive versioned overlay, enforced live | The proposal's switches would compile into it (C8) |
| [CO-1](../mcp-cowork.md#connections-and-owner-authorized-autonomy--co-1) | The in-product helper does "chat, research, finding connections, map/wiki/task assistance and scoped proposals"; standing grants for autonomous external agents | The proposal suggests extending the helper to direct edits (C3) |
| O-009 | Only people accept decisions | Unchanged |
| [F-026](../../design/final/README.md) | "Undo instead of confirmations"; agents always tagged and "for <owner>"; a working agent always visible with Stop; agent questions with ready answers; Settings → Agents and AI rows "Ada's assistant · for you · in Flux · Manage ›" | The proposal's UX follows it |


### 1.2 Code on `origin/main` `05f89591` [S]

- **Personal runs** (`app/packages/core/src/personal-runs/`). `processor.ts` reads the
  conversation's last messages, open tasks and an optional map thought, sends one
  request through `PersonalCompute.dispatch` (`ports.ts`: "no tools, no hosted
  search, no automatic retries"), parses the answer, and may insert one proposal.
  `proposals.ts` supports one change type, a result (`change: { type: 'result' … }`),
  accepted by a person with authority, recorded "drafted by X's assistant". Run kinds
  are `'ask' | 'summarize' | 'map_thought'`. The assistant edits nothing.
- **MCP tools** (`app/apps/server/src/agent-connection/`). Read tools for contexts,
  materials, tasks, decisions, results, Wiki, conversations, maps and search; effect
  tools under `flux.action.execute` for `work.create/update`, `result.record`,
  `decision.propose`, `map.create/rename`, `map.thought.create/update/delete`,
  `map.positions.update`, `map.link.create/delete`, `doc.create/update`,
  `conversation.create/reply` and eight co-work operations; `flux_create_proposal`
  under `flux.proposal.write` (free-text fact, interpretation, suggested action).
  Every effect needs a live standing grant and a runtime from `flux_bootstrap`
  (`work-actions.ts`), through the shared executor (`action-execution.ts`) with
  receipts.
- **Versions and authors.** Wiki versions are immutable with an `author` that may be an
  agent (`docs/ports.ts`); tasks and thoughts carry versions; rows record `ActorRef`
  `human | agent`.
- **Runtime.** Migration `0056_agent_runtime.sql` adds slots, bindings, runtime
  connections and operator statements. The supervisor's `run` request returns
  `not_available` (`apps/runtime/src/supervisor/handlers.ts`): no run exists yet.
  No run token exists on `main`.
- **Schedulers.** pg-boss `schedule` ticks: comparisons every minute (singleton),
  morning summary every 15 minutes, idempotency cleanup hourly
  (`apps/worker/src/…`).
- **Assistant settings UI** (`app/apps/web/src/assistant/AssistantSettings.tsx`):
  consent, connection choice, per-run and daily money caps, pause. No switches.

### 1.3 Issues and open PRs (2026-10-09)

| Item | State | Relevance |
| --- | --- | --- |
| #68 assistant runs (@Zamojski5) | Open; merged slices PR #141, #142, #161, #192 | Scope already names "bounded requested actions … with actor/on-behalf-of attribution and undo"; undo of done actions still open |
| #179 provider-neutral | Open; PR #192 merged | Adapters without tool calling |
| #277 Connect AI | Open; branch `claude-hubert/277-connect-ai` `42586a7d`, no PR | Order and labels change (A10) |
| #279 Claude Code sign-in console | PR #398 open at `a8a4e4e9` | No contract change |
| #280 first run (T5) | Open; branch `claude-hubert/280-first-run` at the same `42586a7d`, no own commits | Agent connection and tool list change |
| #281 Codex in the runtime | Open | Switch-derived tool list |
| #316 S6 switches | PR #390 open at `79769420` (migration 0061, `AGENT_MCP_ENTRIES`, policy store, owner UI) | The proposal depends on it |
| #331 runtime follow-ups | PR #385 open, changes requested | No change |
| #358 runtime image and operator assets | Open | Launcher prompt touches the operator guide |
| #58 comparison | PR #391 open | No change |
| #238 undo of an AI-created task | PR #394 open | Reused for Undo |
| #152 real clients | PR #396 open: real pinned Claude Code and Codex against a scripted model, no account | Test harness for runs |
| T7 of the [F-022 plan](2026-10-04-two-ai-modes-plan.md#t7--write-tools-and-proposals-in-runtime-runs-new-issue) | Never opened as an issue | The proposal would replace it with slices A2–A5 |

### 1.4 Gaps

- **(a) Subscription as the normal path.** The runtime is off unless an operator edits
  `docker/.env`; Connect AI does not lead with sign-in; no run exists on `main` yet
  (#280); background work cannot use a subscription by decision.
- **(b) Switches.** S6 exists only for external MCP connections and only in review; the
  assistant has no agent connection on `main` and no switches.
- **(c) Direct edits.** The assistant cannot call any effect tool; its one proposal type
  is a result; there is no change log, result line or Undo for agent changes beyond
  PR #394's task case; the `server` engine has no tool loop.

## 2. Precedent: how others use a subscription and run in the background

All [V] from the projects' own docs or repositories unless marked.

### 2.1 OpenClaw and Hermes Agent (re-read 2026-10-09)

| | OpenClaw | Hermes Agent |
| --- | --- | --- |
| Claude mechanism | Official CLI: the `claude-cli` back end runs `-p --output-format stream-json --include-partial-messages --verbose --setting-sources user --allowedTools mcp__openclaw__*` and `--disallowedTools ScheduleWakeup,CronCreate,Bash(run_in_background:true),Monitor` ✔ ([cli-backends](https://docs.openclaw.ai/gateway/cli-backends)). "Claude Code owns its existing local login and subscription." "OpenClaw … never reads, persists, refreshes, or forwards native tokens" ✔ | Token reuse: Claude Code's OAuth client and credential store against the API; "It only works if you're on a Claude Max plan and have purchased extra usage credits"; "Claude Pro subscribers cannot use this path" ([providers](https://hermes-agent.nousresearch.com/docs/integrations/providers)). Issue #47260 (opened 2026-06-16) reports a $12.70 extra-usage charge |
| Tools into the app | "spawns a loopback HTTP MCP server that exposes Gateway tools to the CLI process, authenticated with a per-run context grant (`OPENCLAW_MCP_TOKEN`) active only for the current execution attempt" ✔ | MCP servers with `tools.include` / `tools.exclude` per server ([mcp](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)) |
| Policy claims | "OpenClaw supports Anthropic Claude CLI reuse and `claude -p` as a sanctioned auth path"; "Anthropic staff told us OpenClaw-style Claude CLI usage is allowed again"; "For Anthropic in production, API key auth is still the safer recommended path"; "OpenAI Codex OAuth is explicitly supported for use outside the Codex CLI" ✔ ([concepts/oauth](https://docs.openclaw.ai/concepts/oauth), no page date). Its Anthropic provider page: "For shared production automation, use an Anthropic API key instead of Claude CLI." Project claims, not vendor text | No ban warning on the providers page |
| Scheduler | "Automations are OpenClaw's built-in scheduler"; "The scheduler persists jobs, wakes the agent at the right time" ✔ ([cron-jobs](https://docs.openclaw.ai/automation/cron-jobs)); whether jobs use the CLI back end is not stated | "The gateway ticks the scheduler every 60 seconds, running any due jobs in isolated agent sessions"; "Cron-run sessions cannot recursively create more cron jobs"; "a long outage collapses into a single run rather than one run per missed slot"; "Paused jobs never catch up"; "A recurring job that keeps failing with the same error alerts you once"; prompts "scanned for prompt-injection and credential-exfiltration patterns at creation and update time" ✔ ([cron](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron)) |
| Approvals | `tools.exec.ask`: `off`, `on-miss`, `always`; host default security `full`, ask `off` ([exec-approvals](https://docs.openclaw.ai/tools/exec-approvals)) | `approvals.mode` `smart` (default) / `manual` / `off`; `cron_mode`, `single_query_mode`, `unattended_mode` default `deny`: "`deny` blocks the command (the agent must find another path)" ✔ ([security](https://hermes-agent.nousresearch.com/docs/user-guide/security)) |

**Reconciliation with F-022 §1 of the [2026-10-05 research](2026-10-05-agent-runtime.md#1-how-hermes-agent-and-openclaw-use-subscriptions).**
Nothing material changed on the Claude path since 2026-10-05: OpenClaw's
official-binary back end with a per-run MCP grant is still the pattern F-022 follows;
Hermes' Claude path is still token reuse and is still billed as extra usage. New for
this decision: both ship cron with an approval layer that is stricter for unattended
runs (Hermes) and both stop the CLI's own scheduling tools (OpenClaw disallows
`CronCreate` and `ScheduleWakeup`; Flux's `--tools ""` removes every built-in). The
"allowed again" sentence is OpenClaw's report of a conversation, not vendor text [I].

### 2.2 Other tools

| Tool | Mechanism | Scheduled on a subscription | 2026 events |
| --- | --- | --- | --- |
| Zed | Official Agent SDK through ACP; Codex CLI; ChatGPT sign-in with OpenAI | Not found | Blog 2026-05-14 / updated 2026-06-16: subscription use continues "exactly as they did before"; ChatGPT sign-in 2026-05-15 |
| opencode | Claude: bundled OAuth plugin, **removed**: "Remove anthropic references per legal requests" (PR #18186, merged 2026-03-19), docs: "Anthropic explicitly prohibits this" | Not found | Removal is the one documented enforcement against token reuse |
| Cline | Claude Code provider runs the user's `claude`; ChatGPT OAuth provider (2026-01-22) | Not found | — |
| Roo Code | Claude Code and ChatGPT providers | — | "The Roo Code Extension was shut down on May 15th" (no reason given) |
| Conductor | "can run either its bundled Claude Code binary or a system Claude Code binary"; Conductor Cloud: "Add a personal subscription token or API key" | Not found | — |
| Happy, Omnara | Official Agent SDK or CLI on the user's machine, remote UI | Not found | — |
| Multica (self-hosted, multi-user) | A daemon "drives the agent CLIs you already have installed and authenticated"; autopilots "on a cron"; "Claude Code runs with `--permission-mode bypassPermissions`" | Yes | — |
| Alloy (hosted) | "Run `claude setup-token` locally and paste the generated token into Settings" | — | Contrary to Anthropic's "collect, store, or intermediate" text [I]; no enforcement found |

**UX precedent for owner switches:** GitHub Copilot coding agent (repository access,
separate "Allow automations"), Linear agents (opt-in `app:assignable`,
`app:mentionable`; the app is a "delegate, not the assignee"), Notion (admins enable,
disable and cap agents), Anthropic's own owner toggles for Remote Control, Routines and
cloud sessions. None exposes a capability matrix to an individual user [I].

## 3. Vendor terms (retrieved 2026-10-09)

### 3.1 Anthropic

**Claude Code legal and compliance** ([page](https://code.claude.com/docs/en/legal-and-compliance); sitemap lastmod 2026-10-05; Wayback diffs of 2026-09-30, 10-06 and 10-08 change only the HIPAA/BAA text). Unchanged since F-022 [V]:
- Governing terms: "Consumer Terms of Service - for Free, Pro, and Max users"; "Commercial Terms of Service - for Team, Enterprise, and Claude API users".
- "Unless we've mutually agreed otherwise, preinstalling or running Claude Code in your products or services (e.g. in hosted sandboxes or other agent infrastructure) requires agreeing to our Commercial Terms of Service and complying with the conditions below".
- "Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf. Each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference provider credential".
- "Claude Code usage is subject to the Anthropic Usage Policy. Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK."
- "OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications."
- "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens".
- The carve-out: "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code".
- "Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice."
- The page says nothing about scheduled, automated, background, cron or unattended use (searched; not found).

**Consumer Terms** ([page](https://www.anthropic.com/legal/consumer-terms), "Effective October 8, 2025"; served as the EEA/Swiss version from a Warsaw edge) [V]:
- §3: "Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, to access the Services through automated or non-human means, whether through a bot, script, or otherwise."
- §2: "You may not share your Account login information … or make your Account available to anyone else."
- §11 (EEA text): "Non-commercial use only. You agree that you will not use our Services for any commercial or business purposes".

**Explicit permission for scripted and scheduled use on a plan** [V]:
- GitHub Actions ([page](https://code.claude.com/docs/en/github-actions), lastmod 2026-10-08) ✔: "`CLAUDE_CODE_OAUTH_TOKEN`: an OAuth token that authenticates with your Claude subscription, available on Pro, Max, Team, and Enterprise plans"; "With a `prompt` input, the Claude Code GitHub Action runs in automation mode on any GitHub event, including a cron schedule"; "If you authenticate with an OAuth token, runs use your Claude subscription instead of API billing"; "For a secret shared across repositories, authenticate with an API key … since an OAuth token is tied to the subscription of the person who ran `claude setup-token`".
- Authentication ([page](https://code.claude.com/docs/en/authentication), lastmod 2026-10-08): "For CI pipelines, scripts, or other environments where interactive browser login isn't available, generate a one-year OAuth token with `claude setup-token`"; "This token authenticates with your Claude subscription and requires a Pro, Max, Team, or Enterprise plan."
- Routines ([page](https://code.claude.com/docs/en/routines), lastmod 2026-10-07; research preview) ✔: "Routines are available on Pro, Max, Team, and Enterprise plans"; "Routines belong to your individual claude.ai account … their runs count against your account's usage and limits"; "Routines draw down subscription usage the same way interactive sessions do"; scheduled runs: "The minimum interval is one hour; expressions that run more frequently are rejected"; fired text "arrives wrapped in a `<routine-fire-payload>` block that labels it as untrusted data"; "If your GitHub connection is missing or expired when a run is due, the routine skips runs until you reconnect, for up to 72 hours".
- Agent SDK with a plan ([15036540](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), updated 2026-10-07): "Update October 7, 2026: Claude Max and Team plans now include monthly API credits, which cover the Claude Agent SDK, claude -p, the Claude API, and Claude Managed Agents. You can still use the Claude Agent SDK, claude -p, and third-party apps with your subscription limits."
- Monthly API credits ([17154008](https://support.claude.com/en/articles/17154008), "Updated yesterday" on 2026-10-09) ✔: "Max and Team plans include monthly credits for the Claude Platform"; "Free, Pro, and Enterprise plans aren't eligible"; "API credits cover `claude -p` and the Claude Agent SDK when you run them yourself … with an API key from your linked Claude Console organization"; signed in with the plan instead, they "still draw from your plan's usage limits and don't use your API credits"; not covered: "Interactive Claude Code in the terminal, IDE, desktop, or web".

**Product guidance against plan logins in products** [V] (unchanged): Agent SDK
overview: "Unless previously approved, Anthropic does not allow third party developers
to offer claude.ai login or rate limits for their products"; support 13189465
(updated 2026-05-19): "If you're building a product, application, or tool for others,
use API key authentication"; "Use of third-party tools that misrepresent their identity
to Anthropic's servers, attempt to route third-party traffic against subscription
limits, or otherwise violate applicable terms or policies is prohibited".

**New: Usage Policy effective 2026-11-12** ([aup](https://www.anthropic.com/legal/aup); Wayback shows the old "Effective September 15, 2025" through 2026-10-08 07:24 UTC and the new text by 2026-10-09 02:50 UTC) ✔ [V]:
- "Resell, proxy, or otherwise provide access to Claude through unauthorized means, including services that route requests through consumer subscriptions or misrepresent the product or client being used".
- "Agentic use cases must comply with the Usage Policy. Users are responsible for ensuring that agents they build or deploy, including actions those agents take through tools, browsers, or connected systems, comply with this Usage Policy."

**Headless** ([page](https://code.claude.com/docs/en/headless), lastmod 2026-10-09): "`--bare` is the recommended mode for scripted and SDK calls, and will become the default for `-p` in a future release"; "In bare mode, Claude Code never reads OAuth credentials or the system keychain". Not the default yet [V].

**Press [P], context only:** 2026-04-04 third-party harnesses moved to "extra usage"
(InfoWorld, TNW); 2026-05-13 an Agent SDK credit announced, paused 2026-06-15; Zed
2026-05-14/06-16.

### 3.2 OpenAI

Docs at `learn.chatgpt.com/docs/*` show no dates [V]:
- Non-interactive ([page](https://learn.chatgpt.com/docs/non-interactive-mode)): "Run as part of a pipeline (CI, pre-merge checks, scheduled jobs)"; "`codex exec` reuses saved CLI authentication by default"; "API keys are the right default for automation because they are simpler to provision and rotate. Use this path only if you specifically need to run as your Codex account."
- Auth ([page](https://learn.chatgpt.com/docs/auth)): "Use API key authentication for programmatic Codex CLI workflows, such as CI/CD jobs. Don't expose Codex execution in untrusted or public environments"; for "a remote or headless environment", "prefer device code authentication"; Enterprise "Access tokens are intended for trusted scripts, schedulers, and private CI runners."
- CI/CD auth ([page](https://learn.chatgpt.com/docs/auth/ci-cd-auth)): "The right way to authenticate automation is with an API key. Use this guide only if you specifically need to run the workflow as your Codex account"; "trusted private" runners; "only one machine or serialized job stream will use a given auth.json copy"; "Do not use this workflow for public or open-source repositories" (secret exposure in public CI).
- App-server ([page](https://learn.chatgpt.com/docs/app-server)): "App-server authentication has never been permitted for commercial or hosted services."
- Sign in with ChatGPT ([quickstart](https://developers.openai.com/siwc/quickstart)): "ChatGPT plan usage is available to all open-source partners and selected private clients"; token sharing is for "open-source and locally hosted apps. If you're interested in offering it in a paid or remotely hosted app, complete the interest form."
- Scheduled tasks on plans ([automations](https://learn.chatgpt.com/docs/automations)): "Schedule recurring tasks to run in the background."
- Terms of Use (Wayback 2026-10-08; "Effective: January 1, 2026"): "Automatically or programmatically extract data or Output"; "You may not share your account credentials or make your account available to anyone else". Nothing Codex-specific on automation.

### 3.3 Explicit prohibitions of scheduled use: searched, not found

Searched for text forbidding scheduled, cron, unattended or background use of Claude
Code or Codex on the subscriber's own plan: Anthropic legal page, Consumer Terms,
Usage Policy (both versions), support 13189465, 15036540, 17154008, 11145838,
headless, GitHub Actions, GitLab CI; OpenAI auth, non-interactive, CI/CD auth,
app-server, SIWC, Terms of Use, pricing. **Not found.** The nearest texts are the
recommendations to use API keys (both vendors), "ordinary, individual usage"
(Anthropic, about advertised limits), and the 2026-11-12 Usage Policy line about
services routing requests through consumer subscriptions by unauthorized means.

## 4. Verdict per use

[I] throughout; quotes are in §3.

| Use | Anthropic (Claude Code on Pro/Max) | OpenAI (Codex on Plus/Pro) |
| --- | --- | --- |
| 1. Runs the owner starts | **Allowed** under the carve-out ("signing in to the unmodified Claude Code binary … where a platform hosts Claude Code"). Risk **medium–high** as F-022 rated it: Flux drives the binary as its assistant's engine, which "do not allow third party developers to offer claude.ai login or rate limits for their products" may reach | **Allowed**: device-code login on a remote host is documented; plain `codex`, not app-server auth. Risk **medium** (F-022) |
| 2. Edits at the owner's request | **Same as 1.** The CLI calls Flux's MCP tools, as the owner's terminal Claude Code would over mode (b); nothing distinguishes MCP writes | **Same as 1** |
| 3a. The owner's own scheduled jobs | **Allowed as an owner opt-in.** The Consumer Terms' automation clause excepts uses "where we otherwise explicitly permit it", and Anthropic explicitly permits scripted and scheduled plan use (GitHub Action on cron with a subscription token; `setup-token` "for CI pipelines, scripts"; Routines that "draw down subscription usage the same way interactive sessions do"). "Ordinary, individual usage" is the assumption behind advertised limits; one owner's jobs are individual. Risk **medium–high**: the same hosted-engine question as use 1, plus vendor guidance that automation should use API keys. **Better path for Max and Team:** an API key from the linked Console organization uses the plan's monthly API credits, which is the vendor-recommended way to automate | **Allowed as an owner opt-in.** OpenAI documents `codex exec` for "scheduled jobs" with the saved login, as a non-default path ("Use this path only if you specifically need to run as your Codex account") on trusted private machines. A self-hosted Flux slot is one machine per login (F-022 never copies `auth.json`). Risk **medium** |
| 3b. The owner's reactions to events naming the owner | **Allowed as an opt-in, risk medium–high to high.** Another member's action starts the run, which is closer to "route third-party traffic against subscription limits"; bounded to events about the owner, debounced and capped | **Allowed as an opt-in, risk medium** |
| 4. For other members, pooled plans, any member's action spending a plan | **Forbidden**: "on behalf of their users", "make your Account available to anyone else", "pay for, resell, or intermediate" | **Forbidden**: "make your account available to anyone else" |
| 5. A Flux hosted for others for pay | **Off**: Commercial Terms and the "products or services" clause bind that operator; from 2026-11-12 the Usage Policy line on routing consumer subscriptions | **Off**: app-server auth "never been permitted for commercial or hosted services"; SIWC "paid or remotely hosted app" needs the interest form |

**The operator switch can default to Yes** in the launcher on a self-hosted instance,
under conditions (proposal C11, AST-1): an interactive question rather than a silent default;
host checks pass; Claude Code's Commercial Terms statement needs a typed `y`, because
a default answer must not make a legal statement; paid hosting never. The release Compose default stays empty so non-interactive
deployments do not change.

**Two notes for owners, not for Flux's design.** (1) In the EEA and Switzerland the
Consumer Terms say "you will not use our Services for any commercial or business
purposes": a Pro or Max plan used for work is the owner's issue with Anthropic;
Connect AI says so in one sentence and points to Team plans and API keys. (2) The
`--bare` default for `-p` would stop OAuth logins in `-p`; F-022's flag contract test
already catches it.

## 5. Design evidence for switches, approvals and background UX

- **Approval default.** F-026 principle 6 "Undo instead of confirmations" and the
  founder's "not everyone wants to do approvals" favour acting with Undo; Hermes'
  default `smart` approvals run ordinary steps and stop dangerous ones; Anthropic's
  Routines run "without stopping for approval" except for named risky actions. Claude
  Code's interactive default asks before edits, but it edits files with no per-change
  Undo. Flux's changes are versioned and individually undoable [I]. Hence "Do it and
  tell me" by default with a fixed always-wait list (proposal AST-5).
- **Unattended runs.** Hermes denies dangerous actions when nobody can answer
  (`cron_mode: deny`); scheduler-launched runs cannot manage jobs; Anthropic wraps
  fired text as untrusted data. Hence: the same always-wait list in background runs,
  no job or switch tools for any run, and event content passed as data (proposal AST-7, AST-9).
- **Missed runs.** Hermes collapses an outage into one run; Anthropic Routines skip
  while GitHub is disconnected, up to 72 hours. Flux skips and records "Missed" (simplest,
  no burst on a plan) [I].
- **Minimum interval.** Anthropic Routines: one hour. Flux uses one hour, which also
  keeps a subscription's background use close to the vendor's own product [I].
- **Simplicity.** Every precedent in §2.2 exposes on/off controls, not capability
  matrices, to individual users [I]; the founder asked for the same.

## 6. Alternatives considered

| Alternative | Why not chosen |
| --- | --- |
| Keep background work on API keys only (F-022 as accepted) | Contradicts founder direction 3; no vendor text forbids the owner's own scheduled plan use; Anthropic's own products schedule on plans |
| Accept a pasted `setup-token` for background jobs (as Alloy, Conductor Cloud) | Anthropic: "may not collect, store, or intermediate Claude.ai credentials or session tokens"; F-022 rejects it |
| Hermes' token reuse | "misrepresent their identity"; bills as extra usage; opencode's removal shows enforcement |
| An assistant-only write path | Two permission systems; S6 and the MCP executor already exist and are reviewed |
| Ask before every change | Contradicts F-026 principle 6 and the founder's request |

## 7. Uncertainty and what would change the recommendation

- **2026-11-12 Usage Policy.** If Anthropic reads "services that route requests through
  consumer subscriptions" to include a platform hosting the official binary, or narrows
  the legal-page carve-out, Claude Code subscription use in Flux is switched off by
  default and owners are pointed to API keys (including the Max/Team monthly credits).
  Codex and API keys are unaffected.
- **Vendor enforcement on background use.** If either vendor publishes text forbidding
  scheduled plan use by a self-hosted product, background items on that vendor's
  subscription are switched off and the owner is told; interactive runs stay.
- **Untested behaviour.** Plan-limit messages, refusal codes and whether a vendor treats
  a hosted slot as "ordinary" use are unverified until a real-account check (T10),
  which stays optional and never a release gate.

## Sources (all retrieved 2026-10-09)

- Anthropic: [legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), [Consumer Terms](https://www.anthropic.com/legal/consumer-terms), [Usage Policy](https://www.anthropic.com/legal/aup), [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview), [authentication](https://code.claude.com/docs/en/authentication), [headless](https://code.claude.com/docs/en/headless), [GitHub Actions](https://code.claude.com/docs/en/github-actions), [routines](https://code.claude.com/docs/en/routines), [remote control](https://code.claude.com/docs/en/remote-control), [cloud sessions](https://code.claude.com/docs/en/claude-code-on-the-web), support [13189465](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account), [15036540](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), [17154008](https://support.claude.com/en/articles/17154008), [claude-code-action setup](https://github.com/anthropics/claude-code-action/blob/main/docs/setup.md).
- OpenAI: [auth](https://learn.chatgpt.com/docs/auth), [non-interactive](https://learn.chatgpt.com/docs/non-interactive-mode), [CI/CD auth](https://learn.chatgpt.com/docs/auth/ci-cd-auth), [app-server](https://learn.chatgpt.com/docs/app-server), [automations](https://learn.chatgpt.com/docs/automations), [SIWC quickstart](https://developers.openai.com/siwc/quickstart), Terms of Use via Wayback 2026-10-08.
- OpenClaw: [concepts/oauth](https://docs.openclaw.ai/concepts/oauth), [gateway/cli-backends](https://docs.openclaw.ai/gateway/cli-backends), [automation/cron-jobs](https://docs.openclaw.ai/automation/cron-jobs), [tools/exec-approvals](https://docs.openclaw.ai/tools/exec-approvals), providers/anthropic.
- Hermes Agent: [providers](https://hermes-agent.nousresearch.com/docs/integrations/providers), [cron](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron), [security](https://hermes-agent.nousresearch.com/docs/user-guide/security), [mcp](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp).
- Others: [Zed blog](https://zed.dev/blog/anthropic-subscription-changes), [opencode providers](https://opencode.ai/docs/providers/), [Cline Claude Code provider](https://docs.cline.bot/provider-config/claude-code), [Roo Code](https://github.com/RooCodeInc/Roo-Code), [Conductor](https://www.conductor.build/docs/reference/harnesses/claude-code), [Happy](https://github.com/slopus/happy), [Multica security model](https://multica.ai/docs/security-model), [Alloy](https://alloy.app/launches/bring-your-own-subscription), [GitHub Copilot coding agent](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-organization/add-copilot-coding-agent), [Linear agents](https://linear.app/developers/agents).
- Press: [InfoWorld](https://www.infoworld.com/article/4154435/anthropic-cuts-openclaw-access-from-claude-subscriptions-offers-credits-to-ease-transition.html).
