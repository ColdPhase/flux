# Agent runtime: mode (a) on the user's own subscription (research, 2026-10-05)

**Issues:** [#245](https://github.com/ColdPhase/flux/issues/245); founder direction
[#266](https://github.com/ColdPhase/flux/issues/266) items 11 and 13.
**Author:** @PelikanFix16 (`claude-hubert`). **Independent evaluator:** @Zamojski5.
**Status:** research input to [F-022](../ai-modes.md), accepted 2026-10-05. It
replaces the companion design and the vendor-inquiry gate of the
[2026-10-04 research](2026-10-04-two-ai-modes.md); that document's audit (§1) and
its MCP and OpenRouter evidence still apply.
**Revised** on 2026-10-05 for the
[review of `7a6987e7`](https://github.com/ColdPhase/flux/pull/247#issuecomment-6000291729)
and its [wenext note](https://github.com/ColdPhase/flux/pull/247#issuecomment-6000561858):
adverse vendor text (§3), a corrected analysis (§3.3–3.4), hardened commands and a
socket-free runtime (§4), and lower fit ratings (§5). Revised again for the [re-review of `ccdb32e2`](https://github.com/ColdPhase/flux/pull/247#issuecomment-6003428258) (N1–N10): Codex's JSONL check and extra overrides, credential wording, reconciliation, slot reuse, networks and secrets.
**Retrieved:** 2026-10-05 for every source below, unless a row says otherwise. No real Claude or ChatGPT account was used, so every behaviour with a real subscription is **unverified**.

**Mode letters.** This document uses the founder's letters: (a) the agent in Flux,
(b) your agent app over MCP. The 2026-10-04 documents number them the other way
round (mode 1 = MCP, mode 2 = agent in Flux).

**Labels**
- **[V]** Vendor documentation, quoted. This covers Anthropic and OpenAI docs, and the Hermes and OpenClaw projects' own docs about themselves.
- **[S]** Observed in source code, at a named commit.
- **[P]** Press.
- **[I]** Inference by this author.
- **[R]** Reported by the independent reviewer (@Zamojski5) in the PR #247 review, 2026-10-05, and not re-read by this author.

**Dates.** Foundation practice treats H2 2026 sources as current. Terms and support
pages dated earlier are labelled **current in-force version** when the page itself
was retrieved on 2026-10-05 and showed no newer version. Press from H1 2026 is
historical context, never evidence for a current claim.

**Founder direction (#266).** Flux has exactly two AI modes:
- **(a) The agent in Flux.** Each user connects their own Claude or Codex/ChatGPT subscription "as in a terminal, but inside Flux", per Flux instance, the way Hermes Agent and OpenClaw do.
- **(b) MCP.** The user's local terminal agent connects to Flux. This mode is unchanged.

Do not send vendor inquiries, and do not gate the feature on vendor answers. PR #247 excluded Claude plans from mode (a) and kept the ChatGPT companion off until OpenAI answers. Both positions conflict with this direction and are revised below.

## 0. Bottom line

1. **Two different mechanisms sit under "do it like Hermes and OpenClaw".**
   - **The official binary as a back end.** OpenClaw runs `claude -p` and the Codex app-server. Hermes delegates to `claude -p` and `codex exec`.
   - **Token reuse.** Some paths reuse the vendors' own OAuth client IDs and call the model APIs directly. Hermes does this for Claude, and both projects do it for Codex sign-in.

   Only the first fits the vendors' current text, and only partly (§3.3).
2. **Recommendation: each user gets an isolated *runtime slot* that runs the unmodified official CLI.** This means `claude` and `codex`.
   - The user signs in through the CLI's own login command, with every method it offers. Flux relays that flow into its UI.
   - Credentials live only in that user's directory in the slot's volume.
   - Runs start only when the owner asks. The CLI has no local tool, only the exact Flux MCP tools.
   - The CLI calls back into Flux through the existing MCP endpoint, with a per-run token bound to an owner-consented agent connection. Its permissions are therefore those of mode (b).
   - The slots are a fixed pool declared in Compose. No Flux service has Docker API access.
3. **Rejected:** token reuse and spoofing, and pasting a `setup-token` or `auth.json` into Flux (§5).
4. **Remaining risk.** It is real, named in §3.4, and rated medium–high for Claude Code and medium for Codex (§5). The agents record it under founder direction #266; the founder did not review this list. The feature ships behind an operator switch, so each instance decides for itself.

## 1. How Hermes Agent and OpenClaw use subscriptions

Sources: Hermes `NousResearch/hermes-agent` at HEAD `6590f13a`; OpenClaw `openclaw/openclaw` at HEAD `38d12532`. The reviewer re-checked the quotes at both projects' live HEADs on 2026-10-05 and found them unchanged [R]. This author did not re-read them at a newer commit.

### 1.1 Mechanisms

| | Claude Pro/Max | ChatGPT / Codex |
| --- | --- | --- |
| **Hermes: native path** | **Token reuse.** OAuth with Claude Code's client ID, `_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"` in `agent/anthropic_credentials.py` [S]. Messages API calls carry "Claude Code headers and tool-name transforms" [S]. The docs say it "routes as Claude Code against your Anthropic account. **It only works if you're on a Claude Max plan and have purchased extra usage credits**", and "Claude Pro subscribers cannot use this path" [V]. It also reads and refreshes `~/.claude/.credentials.json` and the macOS Keychain entry `Claude Code-credentials` [S]. Remote sign-in uses a "Paste-the-code flow" [V] | **Codex public client.** `CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"` [S]. Hermes "authenticates via device code by default (open a URL, enter a code)". The opt-in browser PKCE flow uses `http://localhost:1455/auth/callback`, "the redirect URI registered for the Codex client". Hermes "stores the resulting credentials in its own auth store under `~/.hermes/auth.json` and can import existing Codex CLI credentials from `~/.codex/auth.json`. No Codex CLI installation is required" [V] |
| **Hermes: delegation** | Skill `claude-code`: "Delegate coding tasks to Claude Code … via the Hermes terminal". Print mode (`claude -p … --allowedTools … --max-turns`) is "PREFERRED". The CLI keeps its own login [V] | Skill `codex`: `codex exec '…'` through the terminal tool [V] |
| **OpenClaw** | **Official binary.** "Claude CLI - reuse an existing Claude Code login through the installed executable on the same host". OpenClaw "never reads, persists, refreshes, selects, or forwards the native login tokens. Claude owns the login and token refresh lifecycle" [V]. Back-end args: `-p --output-format stream-json --include-partial-messages --verbose --setting-sources user --allowedTools mcp__openclaw__* --disallowedTools …` [V]. **Also a setup-token path:** "Direct Messages API requests using a setup token advertise a maintained Claude Code client version" [V], which is token reuse | **Official app-server and Codex public client.** "OpenAI Codex agent runs use the Codex app-server harness … There is no bundled `codex-cli` backend" [V]. Sign-in is PKCE to `auth.openai.com` with callback `localhost:1455`. Remote sign-in: "paste the redirect URL/code instead"; in Docker, "copy the full redirect URL you land on and paste it back" [V]. A device-code method also exists. Source has `OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"` [S]. SIWC is offered as a third method [V] |

### 1.2 Where credentials live and how a server runs it

**Hermes**
- Credentials go to `~/.hermes/auth.json` under the Linux user that ran `hermes auth add` [V].

**OpenClaw**
- OpenClaw's own credentials go to `~/.openclaw/state/openclaw.sqlite` and per-agent SQLite files [V].
- The Claude login stays in Claude Code's own store [V].
- In Docker: "The official image does not pre-install Claude Code. Install and log in inside the container's `node` user, then persist that container home". The user then runs `claude auth login` inside the container [V].

**Tool bridge (OpenClaw)**
- OpenClaw "spawns a loopback HTTP MCP server that exposes Gateway tools to the CLI process, authenticated with a per-run context grant (`OPENCLAW_MCP_TOKEN`) active only for the current execution attempt".
- It "binds tool access to the Gateway-selected session … instead of trusting child-process headers" [V].
- This is the pattern Flux should copy.

**Users and trust**
- OpenClaw multi-user mode is one trust domain: "Everyone who can operate an agent can make it do anything that agent can do".
- For per-person accounts, "Anthropic accepts an API key for personal setup, not a Claude subscription token" [V].
- So OpenClaw's subscription route is effectively one person per host.
- Flux's per-user runtime extends that model. It does not copy it [I].

**Status claims**
- OpenClaw: "Anthropic staff told us this usage is allowed again, so OpenClaw treats Claude CLI reuse and `claude -p` usage as sanctioned … unless Anthropic publishes a new policy. For Anthropic in production, API key auth is still the safer recommended path" [V]. The underlying claim is unsourced.
- OpenAI's partner list shows Hermes Agent under "Apps with ChatGPT plan usage" and OpenClaw under "Open-source integrations" [V].

**A hazard both document.** Hermes: refresh tokens are "single-use, rotating … once two programs hold one token family, whichever refreshes first invalidates the other's copy" [V]. Flux must therefore never copy a CLI login between runtimes, and must serialize runs per runtime [I].

### 1.3 wenext, the founder's other project [R]

The founder pointed to wenext as the reference. The reviewer read its repository for the review; no code was run, and wenext's own notes say no real Codex turn ran in its runtime tests. It connects ChatGPT subscription accounts and runs Codex 0.147.0 per workspace.

- **Sign-in.** `codex app-server` `account/login/start {type: chatgptDeviceCode}`. One job holds the process for up to 900 s, polls `account/read`, and publishes only the URL and user code.
- **Custody.** A schema test fails if a token column appears. Each connection has its own home: a UUID-only directory name (database CHECK and code), symlink escapes rejected, directories `0700`, `auth.json` `0600`, `cli_auth_credentials_store="file"`, with `auto` refused because it could fall back to a keyring.
- **Hardening.** Per-turn overrides: `features.shell_tool=false`, `features.unified_exec=false`, `features.apps=false`, `features.multi_agent=false`, `features.skill_mcp_dependency_install=false`, web search disabled, and the Flux-like MCP server `required=true` with an exact, non-empty `enabled_tools`. It misses `tools.view_image=false`.
- **Read-back.** `config/read` before a turn; wenext only logs a mismatch.
- **Measured caveat.** App-server's `command/exec` JSON-RPC still runs with the shell flags off. The flags control the model's tools, not the host API. wenext keeps a client-side method allowlist.
- **Limits and lanes.** A plan limit is detected by a text marker, then confirmed by `account/rateLimits/read`; an unreadable limit shows "unknown", never zero. One serial lane per account. A turn is killed after a fixed time with no events. The runtime home volume is excluded from backups, and the backup script says why.
- **What it gets wrong for Flux.** Codex runs inside the main API container with `DATABASE_URL`, both networks and every connection's home, and its MCP capability file carries the database connection string. A connection with `workspace_id NULL` serves every member. The device code is stored in the database and shown to every operator. Disconnect skips `logout`. Observe/judge turns override only `mcp_servers={}`, so the shell stays on. `forced_login_method="chatgpt"` restricts sign-in. The committed answer is not redacted, and threads persist.

## 2. The official, unmodified-CLI path

### 2.1 Claude Code

Page lastmod dates come from the sitemap: authentication 2026-10-01, headless 2026-10-04, cli-reference 2026-10-03, devcontainer 2026-09-15, mcp 2026-10-05.

**Login on a headless or container host [V]**
- The user runs `claude` or `claude auth login`.
- `claude auth login` "Sign in to your Anthropic account. Use `--email` to pre-fill your email address, `--sso` to force SSO authentication, and `--console` to sign in with Anthropic Console for API usage billing instead of a Claude subscription" (CLI reference).
- "If your browser shows a login code instead of redirecting back … paste it into the terminal at the `Paste code here if prompted` prompt. This happens when the browser can't reach Claude Code's local callback server, which is common in WSL2, SSH sessions, and containers."
- The devcontainer guide: "Open a terminal in the rebuilt container and run `claude`". It names GitHub Codespaces as a supported host.
- `claude auth status` shows the status as JSON and exits 0 when logged in. Its `authMethod` is one of `none`, `claude.ai`, `oauth_token`, `api_key`, `api_key_helper` or `third_party` (CLI reference). `claude auth logout` signs out.

**Token storage [V]**
- On Linux, `~/.claude/.credentials.json`, mode `0600`, or the same file under `CLAUDE_CONFIG_DIR`.
- To persist in a container, "Mount a named volume at `~/.claude` and set `CLAUDE_CONFIG_DIR` to the same path".
- The CLI refreshes the login itself.
- When refresh fails, requests fail with "Login expired · Please run /login".

**`claude setup-token` / `CLAUDE_CODE_OAUTH_TOKEN` [V]**
- It generates "a one-year OAuth token … for CI pipelines and scripts".
- "It does not save the token anywhere; copy it".
- "It can only make model requests". Locally configured MCP servers still work.

**Headless runs [V]** (CLI reference unless noted)
- Command shape: `claude -p --output-format stream-json --verbose --include-partial-messages`.
- `--tools ""` disables every built-in tool. The flag does not affect MCP tools; `--disallowedTools "mcp__*"` would remove those too.
- `--restricted` is for "when an evaluation harness drives `claude` on a shared machine and Claude Code must not run commands or read that machine's user and project settings". It removes the built-in tools that run commands or code, and WebFetch, and loads only managed settings and `--settings`. It needs v2.1.248 or later.
- `--allowedTools` lists tools that run without prompting; `--tools` restricts which tools exist. `--disallowedTools` with a bare tool name removes that tool from Claude's context.
- `--permission-mode dontAsk`. `--permission-prompts none` denies prompts that nobody can answer (v2.1.259 or later).
- `--mcp-config` with `--strict-mcp-config` uses only the given MCP servers. With `-p`, the CLI waits up to `MCP_TIMEOUT` (30 s by default) for them to connect.
- `--disable-slash-commands` disables all skills and commands for the session.
- Limits and sessions: `--max-turns`, `--max-budget-usd`, `--session-id` / `--resume`. `--no-session-persistence` means sessions "are not saved to disk and cannot be resumed" (print mode only).
- `--append-system-prompt` appends to the default system prompt; `--system-prompt` replaces it.
- With MCP tools present, `--tools ""` keeps the `EndConversation` tool.
- Stopping: SIGINT ends the turn cleanly. SIGTERM exits 143 and records no result (headless guide).
- Useful environment variables: `ENABLE_CLAUDEAI_MCP_SERVERS=false` keeps the user's claude.ai connectors out. `DISABLE_AUTOUPDATER=1` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` are also available.
- Credential variables placed in remote MCP `headers` "read as empty" (MCP guide). A Flux token must use its own variable name or a `headersHelper`. Whether a variable named `FLUX_RUN_TOKEN` is exempt is **unverified**.

**Risk to track [V]**
- `--bare` "will become the default for `-p` in a future release".
- "In bare mode, Claude Code never reads OAuth credentials".
- Pin the CLI version and detect the change with a contract test.

**Install, version and plans (spot-check, [setup](https://code.claude.com/docs/en/setup), 2026-10-05) [V]**
- Linux install: `curl -fsSL https://claude.ai/install.sh | bash`.
- "The native installer accepts either a specific version number or a release channel", e.g. `bash -s 2.1.89`.
- Each release has a GPG-signed `manifest.json` with SHA256 checksums. "Linux: binaries are not individually code-signed", so verify against the manifest.
- `DISABLE_AUTOUPDATER` "only stops the background check". `DISABLE_UPDATES` blocks all update paths: "Use this when you distribute Claude Code through your own channels and need users to stay on the version you provide."
- "Claude Code requires a Pro, Max, Team, Enterprise, or Console account. The free claude.ai plan does not include Claude Code access."

**Egress [V]:** `api.anthropic.com`, `claude.ai`, `claude.com`, `platform.claude.com` (token exchange, refresh and revocation), and `downloads.claude.ai` (installer).

### 2.2 Codex CLI

Sources: OpenAI docs at learn.chatgpt.com, and `openai/codex` at HEAD `823ea830`.

**Login [V]** (auth page)
- Three methods: ChatGPT sign-in with `codex login`; an API key piped to `codex login --with-api-key`; and, for ChatGPT Enterprise workspaces, an access token with `codex login --with-access-token`. The API key is billed at API rates, not to the ChatGPT plan. (The page was read through a summarising fetch; the commands are reliable, the wording is not quoted.)
- On a remote or headless host, "prefer device code authentication (beta) … run `codex login --device-auth`".
- Device-code login must first be enabled in ChatGPT security settings or by the workspace admin.
- The source prints a `…/codex/device` URL and a one-time code "(expires in 15 minutes)", then polls [S].
- Fallbacks: copy `~/.codex/auth.json`, including `docker cp … MY_CONTAINER`, or SSH-forward `localhost:1455`.
- Status and sign-out: `codex login status` and `codex logout`.

**Token storage [V]**
- "Codex caches login details locally in a plaintext file at `~/.codex/auth.json` or in your OS-specific credential store".
- Set `cli_auth_credentials_store = "file"` to keep it in `auth.json` under `CODEX_HOME`. Other values are `keyring`, `auto` and `ephemeral`.
- "For sign in with ChatGPT sessions, Codex refreshes tokens automatically during use".
- "treat `~/.codex/auth.json` like a password".

**Headless runs [V]** (non-interactive page)
- `codex exec --json` streams JSONL events: `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.*` and `error`.
- Other flags: `--sandbox read-only` (the default) or `workspace-write`, `--ephemeral` (no session files on disk), `--ignore-user-config` (skips `$CODEX_HOME/config.toml`), `codex exec resume <id>`, and `--skip-git-repo-check`.

**Local tools and config keys [V]** ([config reference](https://learn.chatgpt.com/docs/config-file/config-reference), read through a summarising fetch)
- `features.shell_tool` is "stable; on by default". `features.unified_exec` (PTY-backed exec), `features.apps` (app and connector integrations), `features.multi_agent` (sub-agent tools) and `features.skill_mcp_dependency_install` are also on by default.
- App and connector traffic is not controlled by the sandboxed-command network proxy.
- `web_search` is a mode: `disabled`, `cached` (the default), `indexed` or `live`. `tools.web_search` configures the web search tool. `tools.view_image` enables the local-image tool.
- `mcp_servers.<id>.enabled_tools` is an allowlist of the server's tools. `required = true` fails start-up if the server cannot initialize. `bearer_token_env_var` names the variable that holds its bearer token.
- `forced_login_method` (`chatgpt` or `api`) restricts Codex to one sign-in method.
- Further default-on features found by the reviewer [R]: `features.hooks` (hook files, which `--ignore-user-config` does not skip), `features.goals` ("automatic continuation… on by default"), `features.remote_plugin` and `features.memories`.
- `config/read` returns "the effective configuration on disk after resolving configuration layering" [R]. It may therefore not reflect `-c` overrides.

**MCP [V]**
- Configure Flux as `[mcp_servers.flux] url = …`, with `bearer_token_env_var`, `required = true` and `enabled_tools`.

**`codex app-server` [V]**
- Uses JSON-RPC over stdio.
- `account/login/start` takes `chatgpt` or `chatgptDeviceCode`; "Codex owns the ChatGPT OAuth flow, persists tokens, and refreshes them".
- "The app-server command and WebSocket transport are experimental and aren't supported for production workloads."

**SIWC route for open-source apps [V]**
- Start `codex app-server` with `model_providers.openai_chatgpt_plan.env_key="ACCESS_TOKEN"`, so the user's SIWC token is sent to `/v1/responses`. "No separate Codex sign-in is required".
- SIWC redirects only to a `127.0.0.1` loopback address.
- For a remote VM the guidance is: "Complete OAuth locally … Transfer the protected credentials … over a secure channel". "Host-specific usage attribution and revocation … for transferred sessions are not yet available".
- Tokens belong "in protected local or self-hosted runtime storage".

**Egress.** No retrieved page lists the OpenAI hosts Codex needs. They must come from the pinned Codex source (T6) before the egress proxy can allow Codex.

## 3. Vendor terms, quoted

### 3.1 Anthropic

**Claude Code legal and compliance** (lastmod 2026-08-21 at first retrieval). At the review's check, lastmod was 2026-10-05. A diff against the Wayback capture of 2026-10-04 changes only the BAA/HIPAA paragraph [R]. [V]:
- "Unless we've mutually agreed otherwise, preinstalling or running Claude Code in your products or services (e.g. in hosted sandboxes or other agent infrastructure) requires agreeing to our Commercial Terms of Service".
- "The Claude Code binary must not be modified … customers may not remove, disable, or restrict any authentication method built into it". In full, as given by the review: "customers may not remove, disable, or restrict any authentication method built into it (including methods that permit signing in with a Claude account or the user's own API key)".
- "Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf. Each end user must authenticate with their own … Claude subscription plan credentials".
- "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow."
- "Developers building products or services that interact with Claude's capabilities… should use API key authentication" (as checked by the review).
- **The carve-out:** "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code as described under *Can customers offer Claude Code in their products?*"
- "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK."
- "Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice."
- The page has a trademark paragraph; Flux names the products in plain text and uses no logos [R].

**Agent SDK overview** (lastmod 2026-09-21) [V]: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK."

**Support 13189465** (updated 2026-05-19; current in-force version) [V]:
- "If you're building a product, application, or tool for others, use API key authentication through Claude Console or a supported cloud provider." (as checked by the review)
- "Use of third-party tools that misrepresent their identity to Anthropic's servers, attempt to route third-party traffic against subscription limits, or otherwise violate applicable terms or policies is prohibited".
- Anthropic "reserves the right to draw use of such third-party tools from usage credits rather than subscription limits."

**Support 15036540** (update of 2026-06-15; current in-force version) [V]: "Claude Agent SDK, `claude -p`, and third-party app usage still draw from your subscription's usage limits."

**Consumer Terms** (effective 2025-10-08; current in-force version) [V]:
- "You may not share your Account login information … or make your Account available to anyone else."
- Prohibited, "Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, to access the Services through automated or non-human means, whether through a bot, script, or otherwise."
- Consumer plans may train on materials unless the user opts out, while the Commercial Terms "may not train" [R].

**Licence [S]:** Claude Code's `LICENSE.md` reads "© Anthropic PBC. All rights reserved. Use is subject to Anthropic's Commercial Terms of Service."

**Press [P], historical context only** (H1 2026; not evidence for a current claim): TechCrunch (2026-04-04) reported subscribers would "no longer be able to use your Claude subscription limits for third-party harnesses including OpenClaw". Zed (2026-05-14, updated 2026-06-16): "ACP usage, `claude -p`, the Claude Agent SDK, and third-party apps built on the Agent SDK continue to work with Claude subscriptions exactly as they did before."

### 3.2 OpenAI

**Terms of Use** (effective 2026-01-01; current in-force version; Wayback capture 2026-10-03, because openai.com returned 403) [V]:
- "You may not share your account credentials or make your account available to anyone else".
- Prohibited: "Automatically or programmatically extract data or Output".
- Training: "If you do not want us to use your Content to train our models, you can opt out…" (as checked by the reviewer [R]).

**Codex auth page** [V]: "Use API key authentication for programmatic Codex CLI workflows… Don't expose Codex execution in untrusted or public environments" (as checked by the review, and seen again on 2026-10-05 by this author).

**Codex non-interactive page** [V]: "API keys are the right default for automation… Use this path only if you specifically need to run as your Codex account" (as checked by the review).

**Codex app-server docs** [V]: "If you've built a local or open-source application using Codex app-server authentication, you can continue using it … App-server authentication has never been permitted for commercial or hosted services."

**SIWC** [V]:
- "These docs explain ChatGPT plan usage for open-source and locally hosted apps. If you're interested in offering it in a paid or remotely hosted app, complete the interest form."
- "ChatGPT plan usage is available to all open-source partners and selected private clients".
- "Eligible ChatGPT Plus and Pro users can use their ChatGPT plan".
- A *Self-hosted VMs* guide exists for an "open-source app on a remote virtual machine".

**Codex CI auth** [V]: ChatGPT-managed `auth.json` is for "trusted private" runners. "Do not use this workflow for public or open-source repositories." This is about secret exposure in public CI, and "only one machine … will use a given auth.json copy".

### 3.3 What this means for a self-hosted, open-source Flux [I]

**Claude: the carve-out fits hosting a sign-in. It is a stretch for an engine.**

What the design meets:
- The binary is unmodified.
- Every method of `claude auth login` is offered: Claude account, Console API billing and SSO (§4.1).
- Each end user signs in with their own account through Anthropic's flow, which runs in the CLI.
- Flux does not pay for, resell or pool usage.

What the design does not clearly meet:
- Anthropic tells developers in three places to use API keys for products: "If you're building a product, application, or tool for others, use API key authentication"; "Developers building products or services that interact with Claude's capabilities… should use API key authentication"; and "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products".
- The carve-out says these rules do not prevent "an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code". It is written about hosting Claude Code for the user.
- Flux does more than host it. Flux builds the brief, starts the run, and posts the answer as its assistant feature. That is close to a product that interacts with Claude's capabilities and offers the plan's rate limits for its own feature. The carve-out does not clearly reach that.
- The feasibility study reconciled the two texts as "a narrow exception: only the unmodified binary, only through Anthropic's own sign-in flow, with no paying for or intermediating usage", and said "A Flux-built agent loop … must use API keys" ([own-AI feasibility §4](../own-ai-feasibility.md#differing-provider-statements-and-how-they-reconcile)). The runtime uses Claude Code's own loop, not a Flux-built one, but Flux still drives it.

What narrows the gap: every run is triggered by the owner; the run is the owner's own Claude Code session acting through MCP, as the owner could do from a terminal in mode (b); Flux appends to the system prompt and never replaces it; and Console API billing is offered in the same console. None of this removes the gap.

The sign-in clause cuts both ways. "Customers may not remove, disable, or restrict any authentication method built into it". The console offers every `claude auth login` method. It does not accept a pasted `setup-token`, which is a Claude account credential that Flux may not "collect, store, or intermediate". It does not pass an API key, `apiKeyHelper` or cloud-provider credentials into the runtime. Whether Anthropic reads that as a restriction is unknown.

This differs from Hermes' native path, which "misrepresent[s] identity" by sending Claude Code headers from another client, and from OpenClaw's setup-token Messages API path. The official binary does not misrepresent anything.

**OpenAI: the plain CLI under the user's login is documented, but not as the default for automation.**
- Codex documents `codex login --device-auth` for a "remote or headless" host. It does not mention containers specifically.
- OpenAI says to use API keys "for programmatic Codex CLI workflows", calls them "the right default for automation", and allows the ChatGPT login for automation "only if you specifically need to run as your Codex account". Running the CLI under the user's ChatGPT login on a team's server is therefore a documented but non-default path. It is not "the documented headless use", as the first version of this document said.
- "Don't expose Codex execution in untrusted or public environments." A team-hosted Flux is not public. But a run reads other members' content, which is untrusted input. Hence no local tools and one isolated slot per owner (§4.2).
- The Terms of Use prohibit "Automatically or programmatically extract data or Output". `codex exec --json` is OpenAI's own programmatic interface, and the non-interactive page describes automation under a Codex account. OpenAI does not say how these pages relate to the general clause. The same question applies to Anthropic's "automated or non-human means".
- SIWC plus the official app-server is OpenAI's documented app route, scoped to open-source and local or self-hosted use. App-server authentication "has never been permitted for commercial or hosted services". Flux uses neither for sign-in.

### 3.4 Risks, stated without deciding them

The agents record these under founder direction #266. The founder directed the approach and ruled out a vendor inquiry; the founder did not review this list. They are recorded so operators can decide.

1. **"Preinstalling or running Claude Code in your products or services … requires agreeing to our Commercial Terms".**
   - In a self-hosted Flux, whoever runs the instance is plausibly that "customer".
   - A Flux setting is not an agreement with Anthropic, and the Commercial Terms are not for consumer use [R]. The operator must agree with Anthropic directly, for example through a Console organization. Flux records only the operator's statement.
   - Flux should not ship Claude Code inside its image; OpenClaw does the same. The operator enables a switch, and a one-shot service installs the official binary with Anthropic's installer.
   - A paid hosting service by the Flux project ([licensing](../licensing.md)) keeps the runtime off. OpenAI's "paid or remotely hosted app" condition also applies there.
2. **"Use API key authentication" for products, and no "claude.ai login or rate limits for their products".** See §3.3. This is the main risk for Claude Code. Anthropic may act "without prior notice", possibly against the owner's account. Settings tells the owner so.
3. **"Route third-party traffic against subscription limits".**
   - F-019 keeps invocation owner-only, but an answer posted into a project is read by other members.
   - Treat that like a person sharing Claude's output, not like serving them. Never let a member's action or a mention trigger another person's runtime.
4. **"Automated or non-human means" and "Automatically or programmatically extract data or Output".**
   - `claude -p` and `codex exec` are documented modes, but unattended background rules would stretch "ordinary, individual usage".
   - Mode (a) runs on a subscription should be owner-triggered only. Background rules keep API-key connections, per O-007.
5. **OpenAI's automation guidance, "never been permitted for commercial or hosted services" (app-server auth) and "remotely hosted → interest form" (SIWC).**
   - A team-hosted Flux is open source and non-commercial, but it is remotely hosted from the user's point of view.
   - Running the plain `codex` CLI with its own login is the least ambiguous OpenAI path, and it is still a non-default choice for automation. The console also offers an OpenAI API key, which is OpenAI's recommended default. SIWC remains an optional later sign-in (T8).
6. **Operator access.** A host root can read the runtime volumes, as OpenClaw's trust-domain note says.
   - This is not "sharing credentials", but users must trust their instance operator.
   - The UI and docs must say so.
7. **Payer visibility.** Anthropic may draw third-party tool use "from usage credits rather than subscription limits", and Flux cannot see which. Foundation §9.4's first pillar (the user sees plan limits versus paid extra usage) cannot be met for `runtime`.
8. **Data.** Other members' content goes to the vendor under the owner's account settings, which on consumer plans may allow training [R]. Mode (b) has the same property.
9. **Change risk.**
   - Enforcement "without prior notice".
   - `--bare` becoming the `-p` default.
   - Plan eligibility: Hermes reports Claude Pro failing on its spoofed path. The official binary is not affected by that report.
   - Codex app-server, used only for the read-back, is experimental.
   - Pin CLI versions, and show "Sign in again / provider refused" states honestly.

## 4. Recommended design for mode (a)

[F-022 AIM-3](../ai-modes.md#aim-3--the-runtime-transport) is the contract. This section explains it.

### 4.1 Shape

```text
browser ──HTTPS──> api (Fastify) ──queue──> worker (personal-run dispatch, existing)
                    │                          │
      console relay │                          │ start / stop run (internal network, service secret)
                    ▼                          │
                 runtime-manager <─────────────┘   (no database, no Docker API)
                    │ connects out only, per-slot secret
                    ▼
   slot network of runtime-<n> (internal: true, one per slot)
     ├─ runtime-<n>: supervisor (closed request set) + official claude / codex, non-root
     │               volume /data/<binding uuid>; tools volume read-only
     └─ runtime-egress: /mcp reverse proxy ──> api; HTTPS proxy ──> documented vendor hosts only
```

**Connection kind.** An owner's AI connection gets a transport, `runtime`, with client `claude_code` or `codex`. It sits beside F-020's `server` API-key transport inside mode (a). It is not a third mode.

**Slots, not on-demand containers.** The release Compose file declares a fixed pool (four by default). Each slot has its own volume and its own `internal` network. Nothing in Flux talks to a Docker or Podman API. §5.2 records why.

**Ownership (F-019).**
- A slot is bound to one owner at a time, in the database. One slot holds both CLIs' logins.
- The manager resolves `owner → slot` only from the worker's run record or the owner's own session, never from browser input.
- A workspace role gives no access to a slot.

**Sign-in ("as in a terminal").**
1. Settings → *Agent in Flux* → *Sign in to Claude Code* or *Sign in to Codex* opens a sign-in console for the owner only.
2. The owner picks a method. Claude Code: `claude auth login`, `claude auth login --console` or `claude auth login --sso`. Codex: `codex login --device-auth`, `codex login --with-api-key`, or `codex login --with-access-token` if the pinned version has it.
3. The console is xterm.js over a session-bound WebSocket to the supervisor's PTY, which runs exactly that command. It is not a shell. The PTY dies on exit, on disconnect, or after 15 minutes.
4. Flux shows the CLI's own URL and code.
   - For Claude, the user pastes Anthropic's code back at the CLI prompt. The code passes through Flux's WebSocket and PTY. It is single-use and cannot be exchanged without the PKCE verifier, which stays in the CLI.
   - For Codex, a device code needs nothing pasted. An API key or access token typed at the CLI's prompt passes through the same relay.
   - Flux never stores, logs or parses console frames.
5. Completion is detected only by `claude auth status` / `codex login status`. Flux stores display facts: method, plan if reported, a masked account label and the time. An account change shows a notice.
6. A setup-token, `auth.json` or claude.ai session is never accepted in any Flux field.

**Agent connection.** Enabling runs on a `runtime` connection creates an owner-consented agent connection (`compute_source = 'owner_runtime'`), with scopes and projects chosen on the mode (b) consent screen. The MCP route resolves `flux_connection_id` in that store (`agent-connection/mcp-route.ts`), so its scopes, selected projects and grants apply unchanged. Without this, a run token would get 403, because the route finds no connection.

**Run.**
1. *Ask my assistant* or `/ai` creates the existing O-008 personal run, with consent and owner rechecks.
2. The worker mints a short-lived JWT for MCP.
   - It is signed by the same authorization server.
   - Claims: `sub` and `flux_owner_user_id` = the owner, `flux_connection_id` = the agent connection, `scope`, `flux_run_id` and `flux_place`.
   - Audience: the Flux MCP resource. Lifetime: no longer than the run timeout.
   - The MCP route already rechecks the live connection on every request. For a run token it also checks that the run is still running and restricts every tool to the run's place.
3. The supervisor starts the CLI with a clean environment and the token in `FLUX_RUN_TOKEN`. Claude:
   ```text
   claude -p --output-format stream-json --verbose --include-partial-messages
     --restricted --tools "" --disable-slash-commands
     --strict-mcp-config --mcp-config <tmpfs json: flux url + Authorization from FLUX_RUN_TOKEN>
     --allowedTools mcp__flux__<tool> … --permission-mode dontAsk --permission-prompts none
     --no-session-persistence --max-turns N --append-system-prompt <brief>
   ```
   with `ENABLE_CLAUDEAI_MCP_SERVERS=false`, `DISABLE_UPDATES=1` (the spot-check in §2.1 shows `DISABLE_AUTOUPDATER` alone still allows `claude update`) and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.

   Codex:
   ```text
   codex exec --json --ephemeral --ignore-user-config --sandbox read-only --skip-git-repo-check
     -c cli_auth_credentials_store=file
     -c features.shell_tool=false -c features.unified_exec=false -c features.apps=false
     -c features.multi_agent=false -c features.skill_mcp_dependency_install=false
     -c features.hooks=false -c features.goals=false -c features.remote_plugin=false -c features.memories=false
     -c web_search=disabled -c tools.web_search=false -c tools.view_image=false
     -c mcp_servers.flux.url=… -c mcp_servers.flux.bearer_token_env_var=FLUX_RUN_TOKEN
     -c mcp_servers.flux.required=true -c 'mcp_servers.flux.enabled_tools=[…]'
   ```
4. **Start-up and run checks.** Claude: the first `system/init` event must list only the exact Flux tools (plus `EndConversation`) and only a connected Flux MCP server, or the run stops with no answer. The MCP route lists exactly the run's tools to a run token, so the two lists match. Codex: the `-c` list is a denylist of today's features, so the authoritative check is the run's own JSONL. Any `item.*` other than an agent message, reasoning, or an `mcp_tool_call` to `flux` with a listed tool stops the CLI, and nothing is committed. A `config/read` preflight stays only if T6 shows it reflects `-c`. The app-server client may send only `initialize`, `config/read` and `account/rateLimits/read`.
5. JSONL is parsed by one adapter per CLI into the existing owner-only progress events (`assistant_run.changed.v1`).
6. The final text is redacted for token patterns and the exact run token, then commits through the existing personal-run path, shown as "Jo's assistant · asked by Jo".
7. Domain writes happen only through Flux MCP tools under the grant. Consequential changes become proposals, exactly as in mode (b).

**Caps.**
- Plans have no token price. PROV-3's money reservation and O-008's single bounded request are replaced, for `runtime` connections, by:
  - runs per day (default 20);
  - one serial lane per slot for sign-in, status, run and sign-out (this also avoids refresh races);
  - a wall-clock timeout (default 5 minutes) and a no-event timeout (default 60 seconds);
  - maximum turns (default 10);
  - MCP results of at most 16 KiB per call and 64 KiB per run, which replace PROV-3's input bound;
  - an answer of at most 16 KiB.
- Usage is shown with a payer label from the sign-in method, never as zero: "your Claude plan (plan limits or paid extra usage, not visible to Flux)", or the matching ChatGPT, Console or API label.
- When the CLI reports a plan limit, the run fails closed, with no fallback to an API key. Codex confirms the limit with `account/rateLimits/read`; Claude has only its error result. An unreadable limit is "unknown".

**Stop.** Send SIGINT, then SIGTERM after a grace period, then kill the process. Requested and acknowledged are separate states. A broken stream ends the run as `unknown`, with no automatic rerun.

**Revoke and sign out.**
- *Sign out* runs `claude auth logout` / `codex logout`, then deletes that CLI's files.
- *Remove runtime*, revoking the connection, and deleting the owner each sign out every CLI, kill in-flight runs (the next MCP call returns 403) and delete the binding directory. The supervisor confirms `/data` is empty and exits; the restart policy starts a fresh supervisor with an empty `/tmp`. The slot is bound again only after that restart.
- The operator can release a binding from the admin view (sign-out first), and an optional idle policy releases unused bindings, so a pool does not fill for good.
- A failed logout still deletes the files; the owner is told to end the session in their vendor account. Whether logout revokes the refresh token at the vendor is **unverified**.
- If the vendor revokes the login, the next run shows *Sign in again*.

**Backup and cleanup.** `./flux backup` excludes slot volumes; host snapshots include them. After a restore, the worker reads the bindings from the database and reconciles them with each slot's directory through the manager, which has no database access. `./flux reset` and `./flux clean` sign out first, then remove slot volumes. Switching off keeps the volumes; a purge step removes them.

### 4.2 Security boundaries

**Isolation**
- One slot per owner: its own container, volume and network.
- The container runs as non-root with a read-only root filesystem.
- `cap_drop: ALL` and `no-new-privileges`.
- 2 GiB memory, one CPU, 256 pids and a 128 MiB tmpfs `/tmp` (starting values). The supervisor refuses a run while the binding directory exceeds 256 MiB, because local volumes have no quota.
- No Docker socket and no host mounts, anywhere in Flux.
- Optional gVisor (`runtime: runsc`).

**Control**
- The supervisor accepts only bind, login, status, run, stop, logout and release, with a client and method from fixed lists. It never takes a command line, flag, path or environment variable from the manager.
- The manager has no database and no Docker access, and listens on no slot network. The API and worker reach it on a `runtime-control` network that holds no database or Redis.
- The launcher generates one secret per slot in `docker/.env`. Each slot receives only its own; the manager receives all.
- The manager's reader of supervisor streams and `runtime-egress` are the parsers a compromised slot would attack. Both are size-bounded, minimal and fuzz-tested.

**Network**
- Each slot's network is `internal: true` and shared only with the manager and `runtime-egress`. Slots cannot reach each other. A slot added by override must attach both services to its new network.
- `runtime-egress` reaches the API on a `runtime-api` network that holds only those two services.
- `runtime-egress` allows HTTPS only to the vendor hosts in §2, and forwards only the Flux `/mcp` route to the API.
- No database, Redis, worker, other API path, metadata IP or LAN access.
- `downloads.claude.ai` only for the one-shot installer.

**Secrets**
- Tokens exist only in the binding directory, stored by the CLI's own flow. Flux never persists, logs or parses them. The sign-in console relays what the owner types at the CLI's own prompt, in memory only.
- They never appear in the database, queue payloads, API responses, logs, exports or admin UI. A schema test fails if a runtime table gains a column that could hold one.
- The supervisor could read them, and never opens them. The host root can read them.
- The manager and supervisor never log PTY or CLI stdout. They redact `sk-ant-`, `eyJ…` and `refresh_token` patterns from errors, and token patterns from the committed answer.
- A seeded-secret absence test covers the database, logs and stream frames (the PROV-4 pattern).

**Grants**
- The CLI sees only the exact Flux MCP tools. Built-in and local tools are off and read back before use, so it has no shell, files, web, images, apps or sub-agents.
- Exfiltration is therefore limited to what the owner's grant already allows, and to the answer, which is redacted.

**Honesty**
- Settings states that the instance operator can technically access runtime storage, that the vendors recommend API keys for products and automation, and that §9.4's payer split is not visible.

### 4.3 Minimum viable slice (first PR)

1. **Operator switch.** `FLUX_AGENT_RUNTIME` is empty by default. When off, the UI explains that the feature is disabled.
2. **Services.** Under the `runtime` profile: `runtime-manager`, `runtime-egress`, `runtime-install` and four slots running the `ghcr.io/coldphase/flux-agent-runtime` image. The image includes the supervisor and the pinned official Codex release, which is Apache-2.0. Claude Code is installed by the official installer when the operator enables it.
3. **Claude Code only.** Sign-in console with its three methods, auth status, sign out and remove.
4. **One owner-invoked run.** Uses read-only Flux MCP tools for the requested place, with the read-back, a streamed answer, stop, timeouts and caps.
5. **Agents view.** Lists "Agent in Flux · Claude Code · your Claude plan", with the payer label from the sign-in method.

**Next slices**
- Codex sign-in, the `codex exec` adapter and its JSONL check.
- Write tools and proposals.
- `--resume` continuations, with a decision on where transcripts may live.
- A per-run repository workspace with shell tools in the sandbox.
- An optional SIWC plus app-server sign-in.

### 4.4 Testing in Docker without subscriptions

**Fake CLIs.** Build `test/fake-claude` and `test/fake-codex` as Node binaries with the same argv and JSONL shapes. Scenarios are selected by `FAKE_SCENARIO`:
- **Login:** prints a URL and waits for a pasted code, or prints a device URL and code and then polls, for each method. It writes `.credentials.json` / `auth.json` into the binding directory, and `auth status` reports the method.
- **Run:** emits `system/init` with tools and `mcp_servers` status. It makes **real** MCP calls to Flux with the injected token, then emits deltas and a `result` or `turn.completed`.
- **Failures:** expired login, plan limit, hang (to test both timeouts), crash, SIGINT acknowledgement, oversized output, an extra tool in `system/init`, a Codex `command_execution` or other non-Flux item, and a token-shaped string in the answer (to test redaction).
- **Escape attempts:** reading another slot's path, and reaching the database, the API outside `/mcp`, another slot or the metadata IP. All must fail.

**Integration tests** run with two owners:
- A cannot sign in to, run on or see B's slot.
- A run token reads only its place, and fails after the run ends.
- A revoked connection gets 403 mid-run.
- The secret-absence scan and the no-token-column schema test pass.
- No Compose file mounts a Docker or Podman socket.
- There is no fallback to API keys.

**Flag contract test.** Run the pinned real `claude --help` and `codex exec --help` in Docker, which needs no account, and assert that every flag Flux uses exists.

**Read-back tests.** Run the pinned real `codex app-server` `config/read` with Flux's overrides (no account needed) and record whether it reflects them; the preflight is kept only if it does. Check whether the pinned real `claude` emits `system/init` before a login; if not, the Claude read-back is first verified in T10.

**Real-account smoke.** A dated, manual check, otherwise reported **unverified**. It includes an adversarial run that asks the CLI to print its credential file or environment, or to run a command.

### 4.5 Records to change before implementing

- **F-022 (PR #247).** Replace "Claude plan: not offered" and the gated ChatGPT companion with the `runtime` transport above. Keep mode (b) as it is.
- **F-020 PROV-4.** Replace "no consumer subscription sign-in … through their own external client over MCP" with: "only through the unmodified official CLI in the owner's runtime; Flux never persists, logs or parses the vendor credential".
- **PROV-3 and O-008.** Add the run, time, turn and MCP result caps for `runtime` connections, replacing the money reservation, the single bounded request and the input bound.
- **mcp-cowork.md.** Add a sentence: mode (a) runtimes are the instance's sandboxed slots, not the Flux server process.

## 5. Options compared

### 5.1 Subscription paths

| Option | How | Pros | Cons | Terms risk |
| --- | --- | --- | --- | --- |
| **A. Official CLI runtime (recommended)** | Per-user runtime slot. Unmodified `claude` / `codex`. The user signs in with the CLI's own login command. Flux MCP comes back in with a per-run token | Hosts the user's own sign-in as Anthropic's carve-out describes. Uses Codex's documented remote login. Flux never persists, logs or parses vendor credentials. Same grants as mode (b). Like OpenClaw's Claude back end | A fixed slot pool. The CLI's output format can change. One run at a time per user. The operator can technically reach the volumes. §9.4's payer split is not visible | **Medium–high for Claude Code:** three Anthropic texts send products for others to API keys, and the carve-out does not clearly cover a product driving the CLI (§3.3); plus the Commercial Terms for whoever runs it and "ordinary, individual usage". **Medium for Codex:** ChatGPT login for automation is documented but not the default, and a team-hosted instance is "remotely hosted" |
| **A′. SIWC plus official Codex app-server** | OpenAI open-source OAuth (`dynamic_agent_client`, loopback); `ACCESS_TOKEN` passed to the app-server | Route OpenAI documents for open-source apps; per-app usage controls | Loopback-only callback, so a remote Flux needs local sign-in and a credential transfer (or an undocumented redirect-URL paste). Plus/Pro only. Preview limits | **Low** for local or self-hosted VMs. "Remotely hosted" points to the interest form |
| **B. OAuth token reuse or spoofing** | Vendor client IDs (`9d1c250a…`, `app_EMoam…`) with direct Messages API or `chatgpt.com/backend-api` calls; pasted `setup-token` / `auth.json` | No CLI process; simplest to stream | Impersonates another application. Flux stores vendor tokens. Rotating-token races. Reported broken by enforcement for others ([P] Jan–Apr 2026, historical) | **High.** "misrepresent their identity", "may not collect, store, or intermediate", OpenAI's "never been permitted … hosted" |
| **C. API key only (F-020 today)** | Owner's key, encrypted on the server | Already implemented; clear pricing and caps; unattended use is allowed | Not what the founder asked for; pay-per-token instead of the plan | **Low.** Standard API terms, and both vendors' recommended path |

### 5.2 Runtime orchestration

| Option | Root-on-host exposure | Decision |
| --- | --- | --- |
| Label-filtering Docker socket proxy (first version of this document) | Off-the-shelf proxies filter by endpoint, not body or label: bind mounts of `/`, `Privileged`, `CapAdd`, host network or PID mode, devices, volume driver options, `exec`, and archive reads of every owner's credentials all pass [R] | Rejected |
| Custom validating Docker API proxy for on-demand per-owner containers | Safe only with an exact endpoint allowlist and body validation; one gap is root on the host. The required list is kept in [F-022](../ai-modes.md#runtime-orchestration) | Rejected |
| Supervisor per runtime with a lifecycle-only manager | No `exec` or archive, but on-demand `containers/create` still carries a body that can mount `/` | Rejected |
| **Fixed pool of Compose-declared slots with a supervisor** | None from Flux: no service has Docker API access | **Chosen.** Costs: fixed capacity, an idle supervisor per slot, and verified wipes when a slot changes owner |

## Sources (retrieved 2026-10-05)

**Anthropic**
- Claude Code: [legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance), [authentication](https://code.claude.com/docs/en/authentication), [headless](https://code.claude.com/docs/en/headless), [cli-reference](https://code.claude.com/docs/en/cli-reference) (re-read 2026-10-05 for the `auth login` methods, `authMethod` values, `--restricted`, `--tools`, `--disallowedTools`, `--permission-prompts` and `--no-session-persistence`), [devcontainer](https://code.claude.com/docs/en/devcontainer), [mcp](https://code.claude.com/docs/en/mcp), [network-config](https://code.claude.com/docs/en/network-config), [env-vars](https://code.claude.com/docs/en/env-vars), [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview). Fetched as `.md`; lastmod values from `code.claude.com/sitemap.xml`.
- Support: [13189465](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account), [15036540](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).
- Terms and licence: [Consumer Terms](https://www.anthropic.com/legal/consumer-terms); [claude-code LICENSE.md](https://github.com/anthropics/claude-code/blob/main/LICENSE.md).

**OpenAI**
- Codex: [auth](https://learn.chatgpt.com/docs/auth) (re-read 2026-10-05 for the sign-in methods), [CI/CD auth](https://learn.chatgpt.com/docs/auth/ci-cd-auth), [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode) (re-read 2026-10-05), [config reference](https://learn.chatgpt.com/docs/config-file/config-reference) (read 2026-10-05), [MCP](https://learn.chatgpt.com/docs/extend/mcp), [app-server](https://learn.chatgpt.com/docs/app-server).
- SIWC: [overview](https://developers.openai.com/siwc/token-sharing-open-source), [quickstart](https://developers.openai.com/siwc/quickstart), [sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions), [Codex app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server), [self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms), [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations), [partners](https://learn.chatgpt.com/docs/sign-in-with-chatgpt).
- Terms: [Terms of Use, Wayback 2026-10-03](http://web.archive.org/web/20261003093956/https://openai.com/policies/terms-of-use/).
- Source: [codex `device_code_auth.rs`](https://github.com/openai/codex/blob/main/codex-rs/login/src/device_code_auth.rs) and [LICENSE](https://github.com/openai/codex/blob/main/LICENSE) (Apache-2.0), at HEAD `823ea830`.

**Hermes Agent** (HEAD `6590f13a`; re-checked at live HEAD by the reviewer [R])
- Docs: [providers](https://hermes-agent.nousresearch.com/docs/integrations/providers), [OAuth over SSH](https://hermes-agent.nousresearch.com/docs/guides/oauth-over-ssh), `website/docs/user-guide/security.md`.
- Source: `agent/anthropic_credentials.py`, `hermes_cli/auth_constants.py`, `skills/autonomous-ai-agents/claude-code/SKILL.md`.

**OpenClaw** (HEAD `38d12532`; re-checked at live HEAD by the reviewer [R])
- Docs: [concepts/oauth](https://docs.openclaw.ai/concepts/oauth), [providers/anthropic](https://docs.openclaw.ai/providers/anthropic), [gateway/cli-backends](https://docs.openclaw.ai/gateway/cli-backends), [concepts/multi-user](https://docs.openclaw.ai/concepts/multi-user), plus `docs/providers/openai/{authentication,runtimes}.md` and `docs/install/docker/*.md`.
- Source: `extensions/openai/openai-chatgpt-device-code.ts`, `src/llm/utils/oauth/anthropic.ts`.

**wenext** [R]
- Read by @Zamojski5 for the [wenext note](https://github.com/ColdPhase/flux/pull/247#issuecomment-6000561858) on PR #247; not re-read by this author.

**Press** (historical context only)
- [TechCrunch, 2026-04-04](https://techcrunch.com/2026/04/04/anthropic-says-claude-code-subscribers-will-need-to-pay-extra-for-openclaw-support/).
- [Zed blog, 2026-05-14, updated 2026-06-16](https://zed.dev/blog/anthropic-subscription-changes).

**Flux, read only**
- PR #247 at `b9ca6acb`: [F-022 proposal](../ai-modes.md), [2026-10-04 research](2026-10-04-two-ai-modes.md) and [plan](2026-10-04-two-ai-modes-plan.md).
- `main` on 2026-10-05: [model providers](../model-providers.md), [decisions](../decisions.md) (F-019, F-020), [MCP co-work](../mcp-cowork.md), [personal runs](../../development/personal-runs.md), `app/apps/server/src/agent-connection/mcp-route.ts`, `app/packages/db/migrations/0011_agent_connection.sql` and `0034_multiple_agent_connections.sql`, `docker/compose.yaml`, the `./flux` launcher (`backup`, `reset`, `clean`).

**Not retrieved:** openai.com directly (HTTP 403; Wayback used); Hermes `dynamic_agent_client` usage (GitHub API rate limit); the OpenAI hosts Codex needs.
