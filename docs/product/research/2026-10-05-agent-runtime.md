# Agent runtime: mode (a) on the user's own subscription (research, 2026-10-05)

**Issues:** [#245](https://github.com/ColdPhase/flux/issues/245); founder direction
[#266](https://github.com/ColdPhase/flux/issues/266) items 11 and 13.
**Author:** @PelikanFix16 (`claude-hubert`). **Independent evaluator:** @Zamojski5.
**Status:** research input to the revised, proposed [F-022](../ai-modes.md). It
replaces the companion design and the vendor-inquiry gate of the
[2026-10-04 research](2026-10-04-two-ai-modes.md); that document's audit (§1) and
its MCP and OpenRouter evidence still apply.
**Retrieved:** 2026-10-05 for every source below, unless a row says otherwise. No real Claude or ChatGPT account was used, so every behaviour with a real subscription is **unverified**.

**Mode letters.** This document uses the founder's letters: (a) the agent in Flux,
(b) your agent app over MCP. The 2026-10-04 documents number them the other way
round (mode 1 = MCP, mode 2 = agent in Flux).

**Labels**
- **[V]** Vendor documentation, quoted. This covers Anthropic and OpenAI docs, and the Hermes and OpenClaw projects' own docs about themselves.
- **[S]** Observed in source code, at a named commit.
- **[P]** Press.
- **[I]** Inference by this author.

**Founder direction (#266).** Flux has exactly two AI modes:
- **(a) The agent in Flux.** Each user connects their own Claude or Codex/ChatGPT subscription "as in a terminal, but inside Flux", per Flux instance, the way Hermes Agent and OpenClaw do.
- **(b) MCP.** The user's local terminal agent connects to Flux. This mode is unchanged.

Do not send vendor inquiries, and do not gate the feature on vendor answers. PR #247 excluded Claude plans from mode (a) and kept the ChatGPT companion off until OpenAI answers. Both positions conflict with this direction and are revised below.

## 0. Bottom line

1. **Two different mechanisms sit under "do it like Hermes and OpenClaw".**
   - **The official binary as a back end.** OpenClaw runs `claude -p` and the Codex app-server. Hermes delegates to `claude -p` and `codex exec`.
   - **Token reuse.** Some paths reuse the vendors' own OAuth client IDs and call the model APIs directly. Hermes does this for Claude, and both projects do it for Codex sign-in.

   Only the first matches the vendors' current text (§3).
2. **Recommendation: each user gets an isolated *agent runtime* (a container) that runs the unmodified official CLI.** This means `claude` and `codex`.
   - The user signs in through the CLI's own login flow. Flux relays that flow into its UI.
   - Credentials live only in that user's runtime volume.
   - Runs start only when the owner asks.
   - The CLI calls back into Flux through the existing MCP endpoint with a per-run, owner-bound token. Its permissions are therefore those of mode (b).
3. **Rejected:** token reuse and spoofing, and pasting a `setup-token` or `auth.json` into Flux (§5).
4. **Remaining risk.** It is real and named in §3.4. The founder accepted it; it is not hidden. The feature ships behind an operator switch, so each instance decides for itself.

## 1. How Hermes Agent and OpenClaw use subscriptions

Sources: Hermes `NousResearch/hermes-agent` at HEAD `6590f13a`; OpenClaw `openclaw/openclaw` at HEAD `38d12532`.

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

## 2. The official, unmodified-CLI path

### 2.1 Claude Code

Page lastmod dates come from the sitemap: authentication 2026-10-01, headless 2026-10-04, cli-reference 2026-10-03, devcontainer 2026-09-15, mcp 2026-10-05.

**Login on a headless or container host [V]**
- The user runs `claude` or `claude auth login`.
- "If your browser shows a login code instead of redirecting back … paste it into the terminal at the `Paste code here if prompted` prompt. This happens when the browser can't reach Claude Code's local callback server, which is common in WSL2, SSH sessions, and containers."
- The devcontainer guide: "Open a terminal in the rebuilt container and run `claude`". It names GitHub Codespaces as a supported host.
- `claude auth status` returns JSON with `authMethod` (`claude.ai`, `oauth_token`, …). `claude auth logout` signs out.

**Token storage [V]**
- On Linux, `~/.claude/.credentials.json`, mode `0600`, or the same file under `CLAUDE_CONFIG_DIR`.
- To persist in a container, "Mount a named volume at `~/.claude` and set `CLAUDE_CONFIG_DIR` to the same path".
- The CLI refreshes the login itself.
- When refresh fails, requests fail with "Login expired · Please run /login".

**`claude setup-token` / `CLAUDE_CODE_OAUTH_TOKEN` [V]**
- It generates "a one-year OAuth token … for CI pipelines and scripts".
- "It does not save the token anywhere; copy it".
- "It can only make model requests". Locally configured MCP servers still work.

**Headless runs [V]**
- Command shape: `claude -p --output-format stream-json --verbose --include-partial-messages`.
- Tool and MCP control: `--mcp-config` with `--strict-mcp-config`, `--allowedTools "mcp__flux__*"`, `--tools ""` (disables built-ins), `--restricted` ("when an evaluation harness drives `claude` on a shared machine"), `--permission-mode dontAsk`.
- Limits and sessions: `--max-turns`, `--max-budget-usd`, `--session-id` / `--resume`, `--no-session-persistence`.
- Stopping: SIGINT ends the turn cleanly. SIGTERM exits 143 and records no result.
- Useful environment variables: `ENABLE_CLAUDEAI_MCP_SERVERS=false` keeps the user's claude.ai connectors out. `DISABLE_AUTOUPDATER=1` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` are also available.
- Credential variables placed in remote MCP `headers` "read as empty". A Flux token must use its own variable name or a `headersHelper`.

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

**Login [V]**
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

**Headless runs [V]**
- `codex exec --json` streams JSONL events: `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.*` and `error`.
- Other flags: `--sandbox read-only` (the default) or `workspace-write`, `--ephemeral`, `--ignore-user-config`, `codex exec resume <id>`, and `--skip-git-repo-check`.

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

## 3. Vendor terms, quoted

### 3.1 Anthropic

**Claude Code legal and compliance** (lastmod 2026-08-21) [V]:
- "Unless we've mutually agreed otherwise, preinstalling or running Claude Code in your products or services (e.g. in hosted sandboxes or other agent infrastructure) requires agreeing to our Commercial Terms of Service".
- "The Claude Code binary must not be modified … customers may not remove, disable, or restrict any authentication method built into it".
- "Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf. Each end user must authenticate with their own … Claude subscription plan credentials".
- "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow."
- **The carve-out:** "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code as described under *Can customers offer Claude Code in their products?*"
- "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK."
- "Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice."

**Agent SDK overview** (lastmod 2026-09-21) [V]: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK."

**Support 13189465** (updated 2026-05-19) [V]:
- "Use of third-party tools that misrepresent their identity to Anthropic's servers, attempt to route third-party traffic against subscription limits, or otherwise violate applicable terms or policies is prohibited".
- Anthropic "reserves the right to draw use of such third-party tools from usage credits rather than subscription limits."

**Support 15036540** (update of 2026-06-15) [V]: "Claude Agent SDK, `claude -p`, and third-party app usage still draw from your subscription's usage limits."

**Consumer Terms** (effective 2025-10-08) [V]:
- "You may not share your Account login information … or make your Account available to anyone else."
- Prohibited, "Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, to access the Services through automated or non-human means, whether through a bot, script, or otherwise."

**Licence [S]:** Claude Code's `LICENSE.md` reads "© Anthropic PBC. All rights reserved. Use is subject to Anthropic's Commercial Terms of Service."

**Press [P]:** TechCrunch (2026-04-04) reported subscribers would "no longer be able to use your Claude subscription limits for third-party harnesses including OpenClaw". Zed (2026-05-14, updated 2026-06-16): "ACP usage, `claude -p`, the Claude Agent SDK, and third-party apps built on the Agent SDK continue to work with Claude subscriptions exactly as they did before."

### 3.2 OpenAI

**Terms of Use** (effective 2026-01-01, Wayback capture 2026-10-03; openai.com returned 403) [V]:
- "You may not share your account credentials or make your account available to anyone else".
- Prohibited: "Automatically or programmatically extract data or Output".

**Codex app-server docs** [V]: "If you've built a local or open-source application using Codex app-server authentication, you can continue using it … App-server authentication has never been permitted for commercial or hosted services."

**SIWC** [V]:
- "These docs explain ChatGPT plan usage for open-source and locally hosted apps. If you're interested in offering it in a paid or remotely hosted app, complete the interest form."
- "ChatGPT plan usage is available to all open-source partners and selected private clients".
- "Eligible ChatGPT Plus and Pro users can use their ChatGPT plan".
- A *Self-hosted VMs* guide exists for an "open-source app on a remote virtual machine".

**Codex CI auth** [V]: ChatGPT-managed `auth.json` is for "trusted private" runners. "Do not use this workflow for public or open-source repositories." This is about secret exposure in public CI, and "only one machine … will use a given auth.json copy".

### 3.3 What this means for a self-hosted, open-source Flux [I]

**Claude: the carve-out fits the recommended design closely.** The conditions it relies on:
- The binary is unmodified.
- Every authentication method stays available.
- Each end user signs in with their own plan through Anthropic's flow, which runs in the CLI.
- Flux does not pay for, resell or pool usage.

This differs from Hermes' native path, which "misrepresent[s] identity" by sending Claude Code headers from another client, and from OpenClaw's setup-token Messages API path. The official binary does not misrepresent anything.

**OpenAI: device-code login inside a server container is documented.** Codex documents `codex login --device-auth` for remote and container hosts. Running the unmodified Codex CLI under the user's own login on their team's server is the documented headless use. SIWC plus the official app-server is OpenAI's documented app route, scoped to open-source and local or self-hosted use.

### 3.4 Risks, stated without deciding them

The founder has accepted these. They are recorded so operators can decide.

1. **"Preinstalling or running Claude Code in your products or services … requires agreeing to our Commercial Terms".**
   - In a self-hosted Flux, whoever runs the instance is plausibly that "customer".
   - Flux should not ship Claude Code inside its image; OpenClaw does the same. Instead, the operator enables a switch whose text names this condition. The runtime then installs the official binary with Anthropic's installer.
2. **"Route third-party traffic against subscription limits".**
   - F-019 keeps invocation owner-only, but an answer posted into a project is read by other members.
   - Treat that like a person sharing Claude's output, not like serving them. Never let a member's action or a mention trigger another person's runtime.
3. **"Automated or non-human means".**
   - `claude -p` is a mode Anthropic documents, but unattended background rules would stretch "ordinary, individual usage".
   - Mode (a) runs on a subscription should be owner-triggered only. Background rules keep API-key connections, per O-007.
4. **OpenAI's "never been permitted for commercial or hosted services" (app-server auth) and "remotely hosted → interest form" (SIWC).**
   - A team-hosted Flux is open source and non-commercial, but it is remotely hosted from the user's point of view.
   - Running the plain `codex` CLI with its own device-code login is the least-ambiguous OpenAI path. SIWC remains an optional second sign-in.
5. **Operator access.** A host root can read the runtime volumes, as OpenClaw's trust-domain note says.
   - This is not "sharing credentials", but users must trust their instance operator.
   - The UI and docs must say so.
6. **Change risk.**
   - Enforcement "without prior notice".
   - `--bare` becoming the `-p` default.
   - Plan eligibility: Hermes reports Claude Pro failing on its spoofed path. The official binary is not affected by that report.
   - Pin CLI versions, and show "Sign in again / provider refused" states honestly.

## 4. Recommended design for mode (a)

### 4.1 Shape

```text
browser ──HTTPS──> api (Fastify) ──queue──> worker (personal-run dispatch, existing)
                      ▲  MCP /mcp (existing OAuth/JWT verifier)        │ internal RPC + service secret
                      │                                                ▼
                      │                                  runtime-manager (new, internal only)
                      │                                    │ docker-socket-proxy (containers/volumes, label-filtered)
                      │                                    ▼
                      └──── per-run token ───────  runtime container flux-rt-<opaque owner id>
                                                   volume flux-rt-<id> : /home/agent (.claude, .codex)
                                                   official `claude` / `codex`, non-root, egress-allowlisted
```

**Connection kind.** An owner's AI connection gets a transport, `runtime`, with client `claude_code` or `codex`. It sits beside F-020's `server` API-key transport inside mode (a). It is not a third mode.

**Ownership (F-019).**
- Exactly one runtime exists per owner.
- The manager resolves `owner → runtime` only from the worker's run record, never from browser input.
- A workspace role gives no access to it.

**Sign-in ("as in a terminal").**
1. Settings → *Agent in Flux* → *Sign in with Claude Code* or *Sign in with Codex* opens a sign-in console for the owner only.
2. The console is xterm.js over a session-bound WebSocket. It is attached to a PTY that runs exactly one command, either `claude auth login` or `codex login --device-auth`. It is not a shell.
3. Flux shows the CLI's own URL and code.
   - For Claude, the user pastes Anthropic's code back into the CLI prompt. The PKCE verifier never leaves the CLI, so the relayed code is useless to anyone else [I].
   - Codex needs nothing pasted.
4. Completion is detected only by running `auth status` / `login status`. Flux stores display facts: method, plan if reported, a masked account label and the time.
5. A setup-token, `auth.json` or claude.ai session is never accepted in any Flux field.

**Run.**
1. *Ask my assistant* or `/ai` creates the existing O-008 personal run, with consent and owner rechecks.
2. The worker mints a short-lived JWT for MCP.
   - It is signed by the same authorization server.
   - Claims: `sub` = owner, `flux_connection_id` = the owner's runtime connection, plus `flux_run_id` and `flux_place`.
   - Audience: the Flux MCP resource. Lifetime: no longer than the run timeout.
   - The MCP route already rechecks the live connection on every request (`agent-connection/mcp-route.ts`). It additionally restricts reads and writes to the run's place.
3. The manager starts the CLI in the owner's container. Claude:
   ```text
   claude -p --output-format stream-json --verbose --include-partial-messages
     --strict-mcp-config --mcp-config <tmpfs json: flux http + Authorization from FLUX_RUN_TOKEN>
     --tools "" --allowedTools "mcp__flux__*" --permission-mode dontAsk
     --max-turns N --session-id <uuid>
   ```
   with `ENABLE_CLAUDEAI_MCP_SERVERS=false` and `DISABLE_UPDATES=1` (the spot-check in §2.1 shows `DISABLE_AUTOUPDATER` alone still allows `claude update`).

   Codex:
   ```text
   codex exec --json --ephemeral --sandbox read-only --skip-git-repo-check
     -c mcp_servers.flux.url=… -c mcp_servers.flux.bearer_token_env_var=FLUX_RUN_TOKEN
     -c mcp_servers.flux.required=true
   ```
4. JSONL is parsed by one adapter per CLI into the existing owner-only progress events (`assistant_run.changed.v1`).
5. The final text commits through the existing personal-run path, shown as "Jo's assistant · asked by Jo".
6. Domain writes happen only through Flux MCP tools under the grant. Consequential changes become proposals, exactly as in mode (b).

**Caps.**
- Plans have no token price. PROV-3's money reservation is replaced, for `runtime` connections, by:
  - runs per day
  - one concurrent run per runtime (this also avoids refresh races)
  - wall-clock timeout (default 5 minutes)
  - `--max-turns`
  - a cap on output bytes
- Usage is shown as "your plan (cost not reported)", never as zero.
- Plan-limit errors fail closed, with no fallback to an API key.

**Stop.** Send SIGINT, then SIGTERM after a grace period, then kill the container process. Requested and acknowledged are separate states. A broken stream ends the run as `unknown`, with no automatic rerun.

**Revoke and sign out.**
- *Sign out* runs `claude auth logout` / `codex logout`, then wipes the credential files.
- *Remove runtime* deletes the container and its volume.
- Revoking the connection, or deleting the owner, does three things: it kills in-flight runs, the next MCP call returns 403, and the volume is deleted.
- If the vendor revokes the login, the next run shows *Sign in again*.

### 4.2 Security boundaries

**Isolation**
- One container and one volume per owner.
- The container runs as non-root with a read-only root filesystem.
- `cap_drop: ALL` and `no-new-privileges`.
- Limits on pids, memory and CPU.
- `/tmp` is tmpfs.
- No Docker socket and no host mounts.
- Optional gVisor (`runtime: runsc`).

**Network**
- Runtimes sit on their own network.
- They can reach only the Flux API's MCP route and an egress proxy.
- The proxy allowlists only the Anthropic and OpenAI hosts in §2.
- No database, Redis, worker, metadata IP or LAN access.

**Secrets**
- Tokens exist only in the runtime volume.
- They never appear in the database, queue payloads, API responses, logs, exports or admin UI.
- The manager never logs PTY or CLI stdout. It redacts `sk-ant-`, `eyJ…` and `refresh_token` patterns from errors.
- A seeded-secret absence test covers the database, logs and stream frames (the PROV-4 pattern).

**Grants**
- The CLI sees only `mcp__flux__*`. With built-ins off, it has no shell, files or web.
- Exfiltration is therefore limited to what the owner's grant already allows.

**Honesty**
- Settings states that the instance operator can technically access runtime storage.

### 4.3 Minimum viable slice (first PR)

1. **Operator switch.** `FLUX_AGENT_RUNTIME` is empty by default. When off, the UI explains that the feature is disabled.
2. **Services.** Add `runtime-manager` and a socket proxy under a Compose profile, plus the `ghcr.io/coldphase/flux-agent-runtime` image. The image includes the pinned official Codex release, which is Apache-2.0; Claude Code is installed by the official installer at enable time.
3. **Claude Code only.** Sign-in console, auth status, sign out and remove.
4. **One owner-invoked run.** Uses read-only Flux MCP tools for the requested place, with a streamed answer, stop, timeout and caps.
5. **Agents view.** Lists "Agent in Flux · Claude Code (your plan)".

**Next slices**
- Codex device-auth and the `codex exec` adapter.
- Write tools and proposals.
- `--resume` continuations.
- A per-run repository workspace with shell tools in the sandbox.
- An optional SIWC plus app-server sign-in.

### 4.4 Testing in Docker without subscriptions

**Fake CLIs.** Build `test/fake-claude` and `test/fake-codex` as Node binaries with the same argv and JSONL shapes. Scenarios are selected by `FAKE_SCENARIO`:
- **Login:** prints a URL and waits for a pasted code, or prints a device URL and code and then polls. It writes `.credentials.json` / `auth.json` into the volume, and `auth status` reports `claude.ai` / `chatgpt`.
- **Run:** emits `system/init` with `mcp_servers` status. It makes **real** MCP calls to Flux with the injected token, then emits deltas and a `result` or `turn.completed`.
- **Failures:** expired login, plan limit, hang (to test timeout), crash, SIGINT acknowledgement, oversized output, and a token-shaped string in output (to test redaction).
- **Escape attempts:** reading another runtime's path, and reaching the database or metadata IP. Both must fail.

**Integration tests** run with two owners:
- A cannot sign in to, run on or see B's runtime.
- A revoked connection gets 403 mid-run.
- The secret-absence scan passes.
- There is no fallback to API keys.

**Flag contract test.** Run the pinned real `claude --help` and `codex exec --help` in Docker, which needs no account, and assert that every flag Flux uses exists.

**Real-account smoke.** A dated, manual check, otherwise reported **unverified**.

### 4.5 Records to change before implementing

- **F-022 (PR #247).** Replace "Claude plan: not offered" and the gated ChatGPT companion with the `runtime` transport above. Keep mode (b) as it is.
- **F-020 PROV-4.** Replace "no consumer subscription sign-in … through their own external client over MCP" with: "only through the unmodified official CLI in the owner's runtime; Flux never holds the vendor token".
- **PROV-3.** Add the run, time and turn caps for `runtime` connections.
- **mcp-cowork.md.** Add a sentence: mode (a) runtimes are the instance's sandboxed containers, not the Flux server process.

## 5. Options compared

| Option | How | Pros | Cons | Terms risk |
| --- | --- | --- | --- | --- |
| **A. Official CLI runtime (recommended)** | Per-user container. Unmodified `claude` / `codex`. The user signs in with the CLI's own flow. Flux MCP comes back in with a per-run token | Matches Anthropic's carve-out and Codex's documented headless login. Flux never sees vendor tokens. Same grants as mode (b). Like OpenClaw's Claude back end | Container orchestration. The CLI's output format can change. One run at a time per user. The operator can technically reach the volumes | **Low–medium.** Commercial Terms for whoever "runs Claude Code" in a hosted service; "ordinary, individual usage"; OpenAI's "hosted" wording |
| **A′. SIWC plus official Codex app-server** | OpenAI open-source OAuth (`dynamic_agent_client`, loopback); `ACCESS_TOKEN` passed to the app-server | Route OpenAI documents for open-source apps; per-app usage controls | Loopback-only callback, so a remote Flux needs local sign-in and a credential transfer (or an undocumented redirect-URL paste). Plus/Pro only. Preview limits | **Low** for local or self-hosted VMs. "Remotely hosted" points to the interest form |
| **B. OAuth token reuse or spoofing** | Vendor client IDs (`9d1c250a…`, `app_EMoam…`) with direct Messages API or `chatgpt.com/backend-api` calls; pasted `setup-token` / `auth.json` | No CLI process; simplest to stream | Impersonates another application. Flux stores vendor tokens. Rotating-token races. Already broken by enforcement for others ([P] Jan–Apr 2026) | **High.** "misrepresent their identity", "may not collect, store, or intermediate", OpenAI's "never been permitted … hosted" |
| **C. API key only (F-020 today)** | Owner's key, encrypted on the server | Already implemented; clear pricing and caps; unattended use is allowed | Not what the founder asked for; pay-per-token instead of the plan | **Low.** Standard API terms |

## Sources (retrieved 2026-10-05)

**Anthropic**
- Claude Code: [legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance), [authentication](https://code.claude.com/docs/en/authentication), [headless](https://code.claude.com/docs/en/headless), [cli-reference](https://code.claude.com/docs/en/cli-reference), [devcontainer](https://code.claude.com/docs/en/devcontainer), [mcp](https://code.claude.com/docs/en/mcp), [network-config](https://code.claude.com/docs/en/network-config), [env-vars](https://code.claude.com/docs/en/env-vars), [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview). Fetched as `.md`; lastmod values from `code.claude.com/sitemap.xml`.
- Support: [13189465](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account), [15036540](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).
- Terms and licence: [Consumer Terms](https://www.anthropic.com/legal/consumer-terms); [claude-code LICENSE.md](https://github.com/anthropics/claude-code/blob/main/LICENSE.md).

**OpenAI**
- Codex: [auth](https://learn.chatgpt.com/docs/auth), [CI/CD auth](https://learn.chatgpt.com/docs/auth/ci-cd-auth), [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), [MCP](https://learn.chatgpt.com/docs/extend/mcp), [app-server](https://learn.chatgpt.com/docs/app-server).
- SIWC: [overview](https://developers.openai.com/siwc/token-sharing-open-source), [quickstart](https://developers.openai.com/siwc/quickstart), [sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions), [Codex app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server), [self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms), [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations), [partners](https://learn.chatgpt.com/docs/sign-in-with-chatgpt).
- Terms: [Terms of Use, Wayback 2026-10-03](http://web.archive.org/web/20261003093956/https://openai.com/policies/terms-of-use/).
- Source: [codex `device_code_auth.rs`](https://github.com/openai/codex/blob/main/codex-rs/login/src/device_code_auth.rs) and [LICENSE](https://github.com/openai/codex/blob/main/LICENSE) (Apache-2.0), at HEAD `823ea830`.

**Hermes Agent** (HEAD `6590f13a`)
- Docs: [providers](https://hermes-agent.nousresearch.com/docs/integrations/providers), [OAuth over SSH](https://hermes-agent.nousresearch.com/docs/guides/oauth-over-ssh), `website/docs/user-guide/security.md`.
- Source: `agent/anthropic_credentials.py`, `hermes_cli/auth_constants.py`, `skills/autonomous-ai-agents/claude-code/SKILL.md`.

**OpenClaw** (HEAD `38d12532`)
- Docs: [concepts/oauth](https://docs.openclaw.ai/concepts/oauth), [providers/anthropic](https://docs.openclaw.ai/providers/anthropic), [gateway/cli-backends](https://docs.openclaw.ai/gateway/cli-backends), [concepts/multi-user](https://docs.openclaw.ai/concepts/multi-user), plus `docs/providers/openai/{authentication,runtimes}.md` and `docs/install/docker/*.md`.
- Source: `extensions/openai/openai-chatgpt-device-code.ts`, `src/llm/utils/oauth/anthropic.ts`.

**Press**
- [TechCrunch, 2026-04-04](https://techcrunch.com/2026/04/04/anthropic-says-claude-code-subscribers-will-need-to-pay-extra-for-openclaw-support/).
- [Zed blog, 2026-05-14, updated 2026-06-16](https://zed.dev/blog/anthropic-subscription-changes).

**Flux, read only**
- PR #247 at `b9ca6acb`: [F-022 proposal](../ai-modes.md), [2026-10-04 research](2026-10-04-two-ai-modes.md) and [plan](2026-10-04-two-ai-modes-plan.md).
- `main` on 2026-10-05: [model providers](../model-providers.md), [decisions](../decisions.md) (F-019, F-020), [MCP co-work](../mcp-cowork.md), [personal runs](../../development/personal-runs.md), `app/apps/server/src/agent-connection/mcp-route.ts`, `docker/compose.yaml`.

**Not retrieved:** openai.com directly (HTTP 403; Wayback used); Hermes `dynamic_agent_client` usage (GitHub API rate limit).
