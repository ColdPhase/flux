# Faithful mocks for Claude Code and Codex CLI sign-in: findings and recommendation

Access date for every source: 2026-10-08. Nothing was logged in, logged out or run against an account.
Only `--help` / `--version` of the local binaries were executed.

Evidence tags:
- **[D]** documented in the vendor's official docs (URL given)
- **[S]** observed in source code (Codex: `github.com/openai/codex` shallow clone at commit `2fdf047c9631c9ed01a31b62efb7891718a931a8`, 2026-10-08, workspace crate version `0.0.0`)
- **[B]** observed in the strings of the locally installed Claude Code binary `~/.local/share/claude/versions/2.1.292` (Bun-compiled JS embedded in the binary; Claude Code is closed source, so this is reading shipped code, not a published source)
- **[H]** observed in the CLI's own `--help` output (local `claude` 2.1.292, local `codex-cli` 0.160.0)
- **[I]** my inference
- **unknown** = not established

Local versions: `claude --version` -> `2.1.292 (Claude Code)`; `codex --version` -> `codex-cli 0.160.0`.
The Codex source is HEAD of main, which may be newer than 0.160.0. Pin and re-check against the tag you ship.

---

## A. Claude Code

### A1. Sign-in methods

| Method | Command / variable | Browser needed? | Evidence |
| --- | --- | --- | --- |
| Claude subscription (Pro/Max/Team/Enterprise), default | `claude auth login` or `claude auth login --claudeai` | yes, or paste-code | [H] `--claudeai  Use Claude subscription (default)` |
| Anthropic Console (API billing) | `claude auth login --console` | yes, or paste-code | [H] `--console  Use Anthropic Console (API usage billing) instead of Claude subscription` |
| SSO | `claude auth login --sso` | yes, or paste-code | [H] `--sso  Force SSO login flow` |
| Pre-fill email | `--email <email>` | n/a | [H] |
| Both flags | `--console` with `--claudeai` prints `Error: --console and --claudeai cannot be used together.` to stderr, exit 1 | n/a | [B] |
| Refresh-token login (non-interactive) | `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` + `CLAUDE_CODE_OAUTH_SCOPES` set, then `claude auth login`. Without scopes: stderr `CLAUDE_CODE_OAUTH_SCOPES is required when using CLAUDE_CODE_OAUTH_REFRESH_TOKEN.` exit 1. Success prints `Login successful.` exit 0 | no | [D] env-vars page (https://code.claude.com/docs/en/env-vars) lists both variables; behaviour [B] |
| Long-lived token | `claude setup-token` ("Generate a long-lived OAuth token for CI and scripts. Prints the token to the terminal without saving it. Requires a Claude subscription") then `export CLAUDE_CODE_OAUTH_TOKEN=...` | yes, same flow as `/login` | [D] https://code.claude.com/docs/en/cli-reference , https://code.claude.com/docs/en/authentication#generate-a-long-lived-token ; `--help` [H] "Set up a long-lived authentication token (requires Claude subscription)" |
| API key | `ANTHROPIC_API_KEY` (header `X-Api-Key`). Interactive mode asks once to approve the key; with `-p` the key is always used | no | [D] authentication page |
| Bearer token | `ANTHROPIC_AUTH_TOKEN` (header `Authorization: Bearer`), for gateways | no | [D] |
| Key script | `apiKeyHelper` setting (settings.json), TTL via `CLAUDE_CODE_API_KEY_HELPER_TTL_MS` | no | [D] |
| Console without API key ("Anthropic profile", Claude Code >= 2.1.242) | choose "Anthropic Console account" at the `/login` prompt, then "Sign in with your Console account (recommended)" vs "Create an API key (legacy)". Stores an OAuth profile, not an API key | yes | [D] authentication page, section "Sign in without an API key" |
| Cloud providers / gateway | `CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY`, or Claude apps gateway sign-in | no | [D] |

Precedence when several are present (first wins) [D]: cloud provider vars; `ANTHROPIC_AUTH_TOKEN`; `ANTHROPIC_API_KEY`; `apiKeyHelper`; `CLAUDE_CODE_OAUTH_TOKEN`; Anthropic profile/federation; subscription OAuth from `/login`.

**Which flow prints a URL and asks for a pasted code** [B, matches D]:
`claude auth login` (all three variants) writes to **stdout**, in order:

```
Opening browser to sign in…
If the browser didn't open, visit: <authorize URL>
Paste code here if prompted > 
```

(no trailing newline after the `>` prompt), then on success `Login successful.\n` and exit 0. The doc says the paste-code prompt is used "when the browser can't reach Claude Code's local callback server, which is common in WSL2, SSH sessions, and containers" [D, https://code.claude.com/docs/en/authentication]. The interactive `claude` first-run screen shows `Login successful` plus "press Enter" [D]; the `auth login` subcommand exits instead [B].

How the paste is parsed [B]: each stdin line is trimmed and split on `#` into `code` and `state`. If either part is empty it prints `Invalid code. Please make sure the full code was copied.` to stderr and keeps waiting. So the code the user copies has the shape `<authorization_code>#<state>`. A line is accepted at any moment, even before the browser callback.

Failure: stderr `Login failed: <message>` (plus an optional hint), exit 1. A managed-settings or organisation policy refusal also exits 1 [B].

URL hosts [B, hard-coded production config in the 2.1.292 binary]:

| Purpose | URL |
| --- | --- |
| claude.ai authorize | `https://claude.com/cai/oauth/authorize` (redirects to claude.ai) |
| Console authorize | `https://platform.claude.com/oauth/authorize` |
| Manual (paste) redirect | `https://platform.claude.com/oauth/code/callback` |
| Success pages | `https://platform.claude.com/oauth/code/success?app=claude-code` , `.../buy_credits?returnUrl=/oauth/code/success%3Fapp%3Dclaude-code` |
| Token exchange / refresh | `https://platform.claude.com/v1/oauth/token` |
| Console API key creation | `https://api.anthropic.com/api/oauth/claude_cli/create_api_key` |
| Roles | `https://api.anthropic.com/api/oauth/claude_cli/roles` |
| OAuth client id (public) | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` (also in the existing Flux research doc, which got it from Hermes source) |
| Local callback | a localhost HTTP server with a dynamic port: port number **unknown** (not extracted) |

Host list from the docs [D, https://code.claude.com/docs/en/network-config]: `api.anthropic.com`, `claude.ai`, `claude.com`, `platform.claude.com` (OAuth token exchange, refresh, revocation for claude.ai accounts too), `downloads.claude.ai` (installer), optional `mcp-proxy.anthropic.com`, Datadog intake hosts, `storage.googleapis.com`, `registry.npmjs.org`.

### A2. Status and sign-out

`claude auth status [--json|--text]` [H] (`--json` is the default).
- Documented: "Show authentication status as JSON. Use `--text` for human-readable output. Exits with code 0 if logged in, 1 if not. The JSON includes a `configDirectory` field (v2.1.268+). `authMethod` is one of `none`, `claude.ai`, `oauth_token`, `api_key`, `api_key_helper`, or `third_party`" [D, https://code.claude.com/docs/en/cli-reference].
- Observed JSON keys [B]: `loggedIn` (bool), `authMethod`, `apiProvider`, `analyticsDisabled`, `projectsDirectory`, `configDirectory`; optional `forcedLoginMethod`, `allowedProviders`, `apiKeySource`; when `authMethod` is `claude.ai`: `email`, `orgId`, `orgName`, `subscriptionType` (null when unknown); for a Console-managed key: `email`, `orgId`, `orgName`. Pretty-printed with 2-space indent (`JSON.stringify(o, null, 2)`). Exit code is `loggedIn ? 0 : 1`. It is computed from local state and environment; no network call is visible in that function [B], so a status call with a seeded fake credential should be offline [I - unverified, test under `--network none`].
- `--text` when not logged in: `Not logged in. Run claude auth login to authenticate.` [B].
- Mapping [B]: `third_party` when a cloud provider is selected; `claude.ai` for a stored claude.ai login; `api_key_helper`; `oauth_token` for `CLAUDE_CODE_OAUTH_TOKEN`; `api_key` for `ANTHROPIC_API_KEY` or a login-managed key; else `none`. What a keyless Console "Anthropic profile" reports is **unknown**.

`claude auth logout` [H] "Log out from your Anthropic account" [D cli-reference]. Success output: `Successfully logged out from your Anthropic account.` exit 0. Failure: stderr `Logout failed: <message>`, exit 1 [B]. Exit code for success is not stated in the docs; inferred 0 from the code path (no `exit(1)`).

In an interactive session `/logout` also "resets your first-launch setup state" [D authentication page].

### A3. Credential storage on Linux

- `~/.claude/.credentials.json`, mode `0600`; with `CLAUDE_CONFIG_DIR` set the file is `$CLAUDE_CONFIG_DIR/.credentials.json` [D, https://code.claude.com/docs/en/authentication#credential-management]. macOS uses the Keychain with the same file as fallback; Windows `%USERPROFILE%\.claude\.credentials.json` [D].
- Format is **not documented**. Observed [B]: a JSON object with top-level key `claudeAiOauth` holding `accessToken`, `refreshToken`, `expiresAt`, `refreshTokenExpiresAt`, `scopes`, `subscriptionType`, `rateLimitTier`, `clientId`. Units of `expiresAt` (ms vs s) not verified. On a permanently failed refresh (`invalid_grant`) the CLI blanks `refreshToken`, `accessToken` and sets `expiresAt` to 0 [B].
- Account display facts (email, organisation) come from the global config `~/.claude.json` (`oauthAccount`) [I; B shows `emailAddress`, `organizationUuid`, `organizationName` objects read via a config accessor]. `~/.claude.json` also carries `hasCompletedOnboarding` [B]. With `CLAUDE_CONFIG_DIR` the global config location is **unknown** (docs say the directory has "its own settings, session history, and claude.ai login or API key").
- **Important exception** [D, same page]: a keyless Console sign-in "stores that kind of sign-in **outside the configuration directory**" as an Anthropic profile, by default `~/.config/anthropic` (macOS/Linux) in the "Anthropic configuration directory", chosen by `ANTHROPIC_PROFILE` / `active_config`. `/logout` "removes and revokes" it. Also "Claude Code stores that kind of sign-in outside..." means `CLAUDE_CONFIG_DIR` isolation does not isolate it. The env var that relocates that directory is **unknown** (the platform docs call it the "configuration directory"; I did not fetch that page).
- Bare mode never reads OAuth credentials or the keychain [D https://code.claude.com/docs/en/headless].

### A4. Other endpoints

- `ANTHROPIC_BASE_URL` overrides the API endpoint [D env-vars]. Side effects [D]: disables MCP tool search by default (unless `ENABLE_TOOL_SEARCH=true`); disables Remote Control when the host is not api.anthropic.com (v2.1.196+).
- Gateway contract [D, https://code.claude.com/docs/en/llm-gateway-protocol]: Anthropic Messages format = `POST /v1/messages?beta=true` (streaming SSE; `/v1/messages/count_tokens` optional, otherwise a character estimate); forward `anthropic-version` and `anthropic-beta` verbatim; `HEAD /api/hello` connection-warm probe that may be rejected; `GET /v1/models?limit=1000` only if `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`. Response should be `content-type: text/event-stream`; a stream that ends after a content block started but before `message_delta` is treated as a dropped connection and retried.
- Subscription login + `ANTHROPIC_BASE_URL` only (no credential variable): requests still go to the gateway **with the saved claude.ai OAuth credential**, and the `anthropic-beta` header carries an OAuth capability value [D https://code.claude.com/docs/en/llm-gateway ("Subscriptions and gateways")]. So a seeded claude.ai credential plus `ANTHROPIC_BASE_URL=<mock>` runs the real CLI against a mock without any OAuth call, as long as the access token is not expired [I].
- Some calls ignore `ANTHROPIC_BASE_URL` and go to api.anthropic.com directly: fast-mode availability check, WebFetch domain safety check [D llm-gateway-protocol]. Feature-flag fetches, telemetry and profile lookups also use the Anthropic hosts [D network-config]. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` removes most of that (below).
- **OAuth / token endpoints cannot be pointed at a mock.** Documentation lists no override [D env-vars: "no custom OAuth endpoint override"]. In the binary [B]: `CLAUDE_CODE_CUSTOM_OAUTH_URL` exists but is checked against a hard-coded allow-list (`https://beacon.claude-ai.staging.ant.dev`, `https://claude.fedstart.com`, `https://claude-staging.fedstart.com`); any other value throws `CLAUDE_CODE_CUSTOM_OAUTH_URL is not an approved endpoint.` The environment selector (`prod`/`staging`/`local`) is hard-coded to `prod` in this build. `CLAUDE_CODE_OAUTH_CLIENT_ID` overrides only the client id used in the refresh-token login path. The only remaining ways to make the real binary talk to a mock for OAuth are DNS/hosts mapping of `platform.claude.com`, `claude.ai`, `claude.com`, `api.anthropic.com` to the mock plus a mock CA in `NODE_EXTRA_CA_CERTS` [D network-config] or an HTTPS proxy (`HTTPS_PROXY`, supported [D]). The request/response bodies of the token exchange, the profile fetch and the roles call are **unknown** (not documented; I did not decompile them), and I could not record them without an account.

### A5. Headless use

- `claude -p "..."`; `--output-format text|json|stream-json`; `stream-json` needs `--verbose`; `--include-partial-messages` adds `stream_event` lines with raw API deltas; `--input-format stream-json`; `--bare`; `--no-session-persistence`; `--max-turns`; `--permission-prompts none`; `--settings <file|json>` [D https://code.claude.com/docs/en/headless , cli-reference].
- Exit: 0 on success, non-zero on failure; SIGTERM -> 143. A missing-authentication failure inside the run is printed "as the result on stdout" [D headless]. Last stream-json line is a `result` message; the first is `system/init` (carries `plugins`, `mcp_servers`, `capabilities`); retries emit `system/api_retry` with `error` one of `authentication_failed`, `oauth_org_not_allowed`, `billing_error`, ... [D headless].
- Exact text of the unauthenticated `-p` failure message and the field name that carries it: **unknown**.
- Update/telemetry control [D env-vars]: `DISABLE_AUTOUPDATER=1` (background updates only), `DISABLE_UPDATES=1` (also blocks `claude update` / `install`), `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` (any non-empty value, including `0` or `false`, disables: auto-updates, telemetry, error reporting, feedback, release notes, status checks, plugin background runs, feature-flag fetching; it also turns Remote Control off), `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`, `DO_NOT_TRACK`, `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1`, `ENABLE_CLAUDEAI_MCP_SERVERS=false`, `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` (gateway compatibility), `CLAUDE_CODE_ATTRIBUTION_HEADER=0`. Gateway hint headers `x-claude-code-*` are off for a custom base URL unless `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1` [D llm-gateway-protocol].

---

## B. OpenAI Codex CLI

Sources: https://learn.chatgpt.com/docs/auth (permanent redirect target of https://developers.openai.com/codex/auth), https://learn.chatgpt.com/docs/config-file/config-advanced , https://learn.chatgpt.com/docs/non-interactive-mode , and the source tree [S]. Local `codex login --help` [H].

### B1. Login

`codex login [OPTIONS] [COMMAND]` [H]; options: `--with-api-key`, `--with-access-token`, `--device-auth`, global `-c key=value`, `--enable/--disable <FEATURE>`. Hidden options present in source [S, `codex-rs/cli/src/main.rs` ~L520-550]: `--experimental_issuer <URL>`, `--experimental_client-id <ID>`, deprecated `--api-key`.

| Method | Command | Notes |
| --- | --- | --- |
| ChatGPT, browser | `codex login` | local callback server on `localhost:1455` (`DEFAULT_PORT = 1455` [S `login/src/server.rs`]); authorize URL `https://auth.openai.com/oauth/authorize` |
| ChatGPT, device code | `codex login --device-auth` | docs: "prefer device code authentication (beta)" on remote/headless hosts [D auth page] |
| API key | `printenv OPENAI_API_KEY \| codex login --with-api-key` | key read from stdin [H, D] |
| Enterprise access token | `printenv CODEX_ACCESS_TOKEN \| codex login --with-access-token` | exists in 0.160.0 [H], documented in repo help text [S] |
| Environment only | `OPENAI_API_KEY`, `CODEX_API_KEY` (used by `codex exec`), `CODEX_ACCESS_TOKEN` | constants in `login/src/auth/manager.rs` ~L953 [S]; `CODEX_API_KEY` for exec [D non-interactive page] |

Passing both `--with-api-key` and `--with-access-token` -> stderr `Choose one login credential source: --with-api-key or --with-access-token.` exit 1 [S].

**Device-code flow, exact behaviour [S `login/src/device_code_auth.rs`]:**
1. `POST {issuer}/api/accounts/deviceauth/usercode` with JSON `{"client_id": "..."}`. Response JSON: `device_auth_id`, `user_code` (alias `usercode`), `interval` (a **string** of seconds, parsed with `parse::<u64>`; a JSON number would fail to deserialize). HTTP 404 -> error `device code login is not enabled for this Codex server. Use the browser login or verify the server URL.`; other non-2xx -> `device code request failed with status <S>`.
2. Prints to **stdout** (ANSI colours, version in the banner):
```
Welcome to Codex [v<version>]
OpenAI's command-line coding agent

Follow these steps to sign in with ChatGPT using device code authorization:

1. Open this link in your browser and sign in to your account
   <issuer>/codex/device

2. Enter this one-time code (expires in 15 minutes)
   <user_code>

Continue only if you started this login in Codex. If a website or another person gave you this code, cancel.
```
3. Polls `POST {issuer}/api/accounts/deviceauth/token` with `{"device_auth_id","user_code"}` every `interval` seconds. 200 -> JSON `{authorization_code, code_challenge, code_verifier}`; 403 or 404 means "keep polling"; anything else fails with `device auth failed with status <S>`; after 15 minutes `device auth timed out after 15 minutes`.
4. `POST {issuer}/oauth/token` (form-encoded authorization-code exchange, `redirect_uri={issuer}/deviceauth/callback`, PKCE verifier from step 3). Response JSON needs `id_token`, `access_token`, `refresh_token`. The `id_token` is a three-part JWT whose payload is decoded **without signature check** (the CLI's own tests use `alg: none` and the signature `sig`); claims read: `email`, `https://api.openai.com/profile`, `https://api.openai.com/auth` { `chatgpt_plan_type`, `chatgpt_user_id`, `chatgpt_account_id`, FedRAMP flag, ...}. Workspace restriction check (`forced_chatgpt_workspace_id`) runs here.
5. Tokens are written to the credential store (below). `Successfully logged in` is printed to **stderr**, exit 0. Errors: stderr `Error logging in with device code: <e>`, exit 1.

Browser flow success and failure also print `Successfully logged in` / `Error logging in: <e>` to stderr [S `cli/src/login.rs`]. If login methods are disabled by policy: `ChatGPT login is disabled. Use API key login instead.` / `API key login is disabled. Use ChatGPT login instead.` / `Access token login is disabled. Use API key login instead.` exit 1.

API-key login: reads stdin; if stdin is a terminal it prints guidance and exits 1; empty input exits 1; success `Successfully logged in`, exit 0 [S].

### B2. Status and logout

`codex login status` [H], source [S `cli/src/login.rs` `run_login_status`]. **All output goes to stderr** (`eprintln!`), none to stdout:
- `Logged in using ChatGPT` exit 0
- `Logged in using an API key - sk-proj-***abcde` (first 8 chars, `***`, last 5; keys of 13 chars or fewer show `***`) exit 0
- `Logged in using access token`, `Logged in using personal access token`, `Logged in using workload identity`, `Logged in using Amazon Bedrock API key`, `... AWS access keys`, exit 0
- `Not logged in` exit 1
- `Error checking login status: <e>` exit 1

`codex logout` [H]. Output to stderr: `Successfully logged out` (exit 0) when credentials existed and were removed, `Not logged in` (exit 0!) when there was nothing to remove, `Error logging out: <e>` exit 1 [S]. Logout first tries to revoke the tokens at the auth server and removes local auth even if revoking fails [S `login/src/auth/revoke.rs` header comment]. Revoke endpoint: `CODEX_REVOKE_TOKEN_URL_OVERRIDE`, else derived from `CODEX_REFRESH_TOKEN_URL_OVERRIDE` by replacing the path with `/oauth/revoke`, else the default issuer [S]. Whether the default revoke URL is `https://auth.openai.com/oauth/revoke` was not confirmed.

### B3. Credential storage

- `CODEX_HOME` (default `~/.codex`) / `auth.json`. `cli_auth_credentials_store` = `file` | `keyring` | `auto` | `ephemeral` [D auth page]; "Treat ~/.codex/auth.json like a password" [D].
- Shape [S `login/src/auth/storage.rs`, `AuthDotJson`]:
```json
{
  "auth_mode": "chatgpt",                  // optional; "apikey" etc. - exact enum strings not extracted
  "OPENAI_API_KEY": null,                  // key string for API-key logins
  "tokens": { "id_token": "<jwt>", "access_token": "<jwt>", "refresh_token": "...", "account_id": null },
  "last_refresh": "2026-10-08T12:00:00Z"   // RFC 3339; refresh is attempted when older than 8 days (TOKEN_REFRESH_INTERVAL = 8)
}
```
  plus optional `agent_identity`, `personal_access_token`, `bedrock_api_key`. `id_token` is stored as the raw JWT string and parsed on load.
- Token refresh URL: default `https://auth.openai.com/oauth/token`, overridable with `CODEX_REFRESH_TOKEN_URL_OVERRIDE` [S `login/src/auth/manager.rs` L212-216, L1728].

### B4. Custom endpoints

Documented example [D, https://learn.chatgpt.com/docs/config-file/config-advanced]:
```toml
[model_providers.proxy]
name = "OpenAI using LLM proxy"
base_url = "http://proxy.example.com"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
query_params = { api-version = "2025-04-01-preview" }
http_headers = { "X-Example-Header" = "example-value" }
```
Struct [S `codex-rs/model-provider-info/src/lib.rs`]: `name`, `base_url`, `env_key`, `env_key_instructions`, `experimental_bearer_token`, `auth` (command-backed), `gateway_oauth`, `aws`, `wire_api`, `query_params`, `http_headers`, `env_http_headers`, `request_max_retries`, `stream_max_retries`, `stream_idle_timeout_ms`, `requires_openai_auth`, `supports_websockets`, ... **`wire_api` has exactly one value, `responses`** in current source (the old `chat` value is gone). Select it with `model_provider = "proxy"` [I: standard key; not re-read this session].

Built-in shortcuts [D]: `openai_base_url = "https://.../v1"` and `chatgpt_base_url = "..."` (default ChatGPT backend `https://chatgpt.com/backend-api/` [S `core/src/config/mod.rs` L4471]; Codex-backend inference base `https://chatgpt.com/backend-api/codex` [S `CHATGPT_CODEX_BASE_URL`]). The CLI's own exec test harness uses `-c openai_base_url="<mock>/v1"` with `CODEX_HOME=<tempdir>` and `CODEX_API_KEY=dummy` [S `core/tests/common/test_codex_exec.rs`]. Project-local `.codex/config.toml` cannot set `openai_base_url` (ignored in project layer [S `config/src/loader/mod.rs` L90]); user config and `-c` can.

**Can the ChatGPT auth issuer be overridden?** Yes, but only through the hidden flag `--experimental_issuer <URL>` (plus `--experimental_client-id`) on `codex login` for the **device-auth** path (`run_login_with_device_code`: `opts.issuer = iss`) [S `cli/src/login.rs` L355-356, L407-408]. The plain browser `codex login` call does not pass it [S main.rs ~L1595: only the device branch receives `issuer_base_url`]. The Rust tests set `ServerOptions.issuer` directly against a wiremock server [S `login/tests/suite/device_code_login.rs`, `login_server_e2e.rs`]. After login, token refresh/revoke are redirected with `CODEX_REFRESH_TOKEN_URL_OVERRIDE` / `CODEX_REVOKE_TOKEN_URL_OVERRIDE`. TLS: `CODEX_CA_CERTIFICATE` and `SSL_CERT_FILE` appear as CA env vars in some crates [S, ollama/tui]; whether the auth client honours them: **unknown**.

Flux consequence: `codex login --device-auth --experimental_issuer http://mock:PORT` is **not** the command Flux's supervisor runs (`codex login --device-auth`). A test needs either that extra hidden flag in the test image only (a wrapper script) or host/CA redirection of `auth.openai.com`.

### B5. `codex exec`

`codex exec [OPTIONS] [PROMPT]` [H]; `--json` (JSON Lines), `--output-schema`, `-o/--output-last-message <file>`, `--ephemeral`, `--sandbox`, `--skip-git-repo-check`, `--ignore-user-config`, `--ignore-rules`, `-m`, `-c`, `-p <profile>` [D non-interactive page, H].
JSONL events [S `exec/src/exec_events.rs`, D]: `thread.started{thread_id}`, `turn.started`, `item.started`, `item.updated`, `item.completed`, `turn.completed{usage}`, `turn.failed{error}`, `error`. Item details include agent_message, reasoning, command_execution, file_change, mcp_tool_call, web_search, plan update. Auth for scripts: `CODEX_API_KEY=<key> codex exec --json "task"` [D]. Exit code table: **unknown** (docs only say MCP init failure -> error).

---

## C. How the vendors test, and the wire formats a mock must emit

**OpenAI Codex** [S]: Rust integration tests start `wiremock::MockServer`s and run the real code against them.
- Login: `login/tests/suite/device_code_login.rs` mocks `POST /api/accounts/deviceauth/usercode`, `POST /api/accounts/deviceauth/token` (first call 404/403, then 200 with the three fields) and the token endpoint; JWTs are hand-built with `alg: none`. `login_server_e2e.rs` drives the browser flow against a mock issuer; `logout.rs`, `auth_refresh.rs`, `login_proxy_fallback.rs` cover the rest. Hermetic guard macro `skip_if_no_network!` and `CODEX_SANDBOX_NETWORK_DISABLED` for sandboxed runs.
- Model traffic: `core/tests/common/responses.rs` builds SSE with `sse(vec![ev_response_created("resp-1"), ev_assistant_message("m1","hi"), ev_completed("resp-1")])`, mounts it with `mount_sse_once` / `mount_sse_sequence`, content type `text/event-stream`. `start_mock_server()` also mounts an empty `/models` response so tests stay hermetic. Config goes through `-c openai_base_url=` and `CODEX_HOME` tempdirs.

**Anthropic**: no documented guidance on testing the CLI without an account was found. The documented building blocks are the gateway compatibility guide (endpoints/headers above) and the SDK-level streaming reference. The shipped CLI has hard-coded production OAuth endpoints, so there is no equivalent of Codex's `issuer` option [B]. Treat the absence of vendor test guidance as a finding.

**Anthropic Messages SSE** (documented, https://platform.claude.com/docs/en/build-with-claude/streaming [D]). Framing: `event: <type>\ndata: <json>\n\n`. Order for a text reply:
```
event: message_start
data: {"type":"message_start","message":{"id":"msg_...","type":"message","role":"assistant","content":[],"model":"<model>","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":25,"output_tokens":1}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: ping
data: {"type":"ping"}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":15}}

event: message_stop
data: {"type":"message_stop"}
```
Tool use: `content_block_start` with `content_block:{"type":"tool_use","id":"toolu_...","name":"...","input":{}}`, then `input_json_delta` events with `partial_json`, `stop_reason":"tool_use"`. Thinking: `thinking_delta` then `signature_delta`. Error mid-stream: `event: error` / `data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`. A non-streaming reply is a plain Message JSON. The CLI aborts a stream with no bytes for 180 s (custom base URL: 180 s with feature flags fetched, otherwise 300 s) [D network-config]. Required request headers the mock may assert on: `anthropic-version: 2023-06-01`, `anthropic-beta`, `x-claude-code-session-id`, and `authorization: Bearer ...` (OAuth) or `x-api-key` [D].

**OpenAI Responses SSE** (`POST {base_url}/responses`, stream). Documented event list [D, https://developers.openai.com/api/docs/guides/streaming-responses.md]: `response.created`, `response.in_progress`, `response.failed`, `response.completed`, `response.output_item.added`, `response.output_item.done`, `response.content_part.added`, `response.content_part.done`, `response.output_text.delta`, `response.output_text.done`, `response.refusal.delta/done`, `response.function_call_arguments.delta/done`, tool-call progress events, and `error`. The API reference page (platform.openai.com) returned HTTP 403 to my fetch, so per-event field lists come from Codex's own fixtures [S `responses.rs`], which are the minimal shape the CLI accepts:
```
event: response.created
data: {"type":"response.created","response":{"id":"resp-1"}}

event: response.output_item.done
data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","id":"msg-1","content":[{"type":"output_text","text":"hi"}]}}

event: response.completed
data: {"type":"response.completed","response":{"id":"resp-1","usage":{"input_tokens":0,"input_tokens_details":null,"output_tokens":0,"output_tokens_details":null,"total_tokens":0}}}
```
Plus optional `response.output_text.delta` `{"type":..., "delta":"..."}` and function calls as `response.output_item.done` with `item.type:"function_call"` and `call_id`, `name`, `arguments` (helpers `ev_function_call`) [S]. Failure: `sse_failed(id, code, message)` -> `response.failed` [S]. Content type `text/event-stream`. In ChatGPT-login mode the CLI posts to the Codex backend base (`chatgpt_base_url`-derived) instead of `/v1`; exact path under it: **unknown** (inferred `/responses`).

---

## D. Statements in Flux docs that the sources contradict or complicate

Read: `docs/product/ai-modes.md`, `docs/product/research/2026-10-05-agent-runtime.md`, `gh issue view 279`, and the existing fake in `app/apps/runtime/src/fakes/fake-cli.ts`.

1. **"For Claude Code [the CLI's login file] is `CLAUDE_CONFIG_DIR`"** (ai-modes step 6; also "Credentials live only in that user's directory in the slot's volume", research §2 and N2). Not true for the Console keyless sign-in introduced in 2.1.242: "Claude Code stores that kind of sign-in outside the configuration directory" (an Anthropic profile, default `~/.config/anthropic`) [D]. `claude auth login --console` may produce it (whether the `auth login` subcommand asks keyless-vs-key, as `/login` does, is **unknown**). Consequences: (a) Sign-out's "delete the credential files" would miss it; (b) two owners sharing a slot HOME could share it. The T4 contract must either pin `HOME`/`XDG` to the per-owner directory (so `~/.config/anthropic` lands inside the binding directory), or handle the profile directory explicitly, and `claude auth logout` must be verified to remove and revoke it. **Highest-impact finding.**
2. **Fake `claude auth logout` prints `Successfully logged out`**; the real text is `Successfully logged out from your Anthropic account.` [B]. Fake version `2.1.285 (Claude Code) [fake]` vs real `2.1.292 (Claude Code)` [H]. Fake `auth status` when signed out prints `{"loggedIn":false}`; the real JSON also has `authMethod:"none"`, `apiProvider`, `configDirectory`, etc. [B]. Fake signed-in JSON lacks `email`, `orgId`, `orgName`, `subscriptionType`, `configDirectory`, `apiProvider`. Fake failing logout writes to stdout and returns 1; real writes `Logout failed: <msg>` to stderr [B].
3. **Fake `codex login status` and `codex logout` write to stdout**; the real CLI writes every line to **stderr** [S]. A supervisor that reads stdout only passes against the fake and fails on the real CLI. Real `codex logout` when nothing is stored prints `Not logged in` and exits **0**; the fake's `logout` always prints `Successfully logged out`. Fake Codex version `0.160.1 [fake]` vs local `0.160.0`.
4. **Fake does not implement login at all** ("not implemented in T3", exit 2). Acceptance of #279 ("Docker, fake `claude`") needs the three-line stdout contract and the `code#state` paste rule from A1; otherwise a test that pastes a bare code would pass on a fake and be rejected by the real prompt (`Invalid code...`).
5. **ai-modes "a pasted code reaches the CLI prompt ... connection becomes signed in only after `auth status` reports it"**: consistent with source, with one extra fact: the code the browser shows is `code#state`; and `auth login` itself exits 0 after `Login successful.`, so completion can also be detected by the PTY exit code. No contradiction, a refinement.
6. **Research §3.2 / ai-modes: "`codex login status`" as the only completion check** works, but its exit code (0/1) carries the signal; its text goes to stderr (see 3). A PTY merges both streams, so inside the console this is invisible; only the non-PTY status call by the supervisor is affected.
7. **ai-modes: "No primary source lists Codex's OpenAI hosts yet. T6 records them from the pinned Codex source."** Source-derived hosts so far [S]: `auth.openai.com` (issuer, device and browser flows, refresh, revoke), `chatgpt.com` (`/backend-api/codex` inference and `/backend-api/`), `api.openai.com` (API-key mode; default `openai_base_url` assumed, not re-verified). Not a contradiction; recording progress.
8. **ai-modes: Codex device code "must first be enabled in the owner's ChatGPT security settings or by their workspace admin"** is from the docs page the research doc read; I could not re-confirm it on the redirected auth page (the fetch summary did not include it). The source confirms the failure mode: a 404 from `usercode` yields "device code login is not enabled for this Codex server", and `codex login` (non-`--device-auth`) falls back to the browser path only in an internal function `run_login_with_device_code_fallback_to_browser` that `main.rs` does not call for `--device-auth` [S].
9. **ai-modes N2/"Flux never persists ... a vendor credential"** vs `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` + `claude auth login`: a non-interactive login route exists that the owner could use only if Flux passed that env; Flux does not, so no contradiction, but "The console offers every method of the CLIs' own login commands" should note that `auth login` has this hidden-in-docs-table environment path, and Codex has the hidden `--experimental_issuer`.
10. **Issue #279 acceptance "The pinned CLI's `auth login --help` lists no further method"**: [H] `claude auth login --help` (2.1.292) lists exactly `--claudeai`, `--console`, `--email`, `--sso`. Confirmed. The Codex side (`--with-access-token`, `--device-auth`, `--with-api-key`) matches ai-modes.
11. **Research doc: "`claude auth status` shows the status as JSON and exits 0 when logged in"**: confirmed [D, B]; its list of `authMethod` values matches the docs. Not covered: the keyless-Console profile (see 1).
12. Research doc line "OpenAI says to use API keys for programmatic workflows" etc. are policy claims; I did not re-verify them and neither confirm nor contradict them.

---

## E. Recommendation: testing sign-in, status, sign-out and a first run without real accounts

### E1. Principle
Two layers, both account-free, plus a quarantined live layer.

**Layer 1: fake binaries, for Flux's own logic (supervisor, PTY relay, console tickets, fences, UI).** Keep `/opt/flux-fakes/{claude,codex}`. Fix their fidelity from section D and add a **contract test** that proves the fakes match the real CLIs (below). Extend `fake-claude` with a real-shaped `auth login`:
- stdout: `Opening browser to sign in…\n`, `If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?...&state=<state>\n` (console variant `https://platform.claude.com/oauth/authorize?...`), then `Paste code here if prompted > ` without newline.
- read stdin lines; split on `#`; reject with `Invalid code. Please make sure the full code was copied.` on stderr; accept only `<scenario code>#<state it printed>`; then write `.credentials.json` as `{"claudeAiOauth":{...}}` with a seeded sentinel secret, print `Login successful.\n`, exit 0. Scenarios: `login_failed` (stderr `Login failed: ...`, exit 1), `login_timeout` (never answers), `org_not_allowed`.
- `auth status` JSON with the full real key set; `--text` form; exit 0/1.
- `auth logout`: real message, exit 0; scenario `logout_fails`: stderr `Logout failed: ...`, exit 1.
- For Codex `--device-auth`: print the real banner (URL `https://auth.openai.com/codex/device`, a code like `ABCD-1234`, "expires in 15 minutes"), wait a scenario-controlled delay, write `auth.json`, stderr `Successfully logged in`. `login status` / `logout` strings on **stderr**, `Not logged in` exit 0 for logout.
- Also make the fake write the credential in a profile directory outside `CLAUDE_CONFIG_DIR` in a `console_profile` scenario to test the sign-out leak from D1.

**Layer 2: real pinned CLIs against mock HTTP servers, for what the CLI does after sign-in (and Codex sign-in itself).**

*Codex (fully feasible, Apache-2.0, pin the release tag and bundle it in the test image):*
- Mock issuer (one small HTTP service, or wiremock-style Node server) serving:
  - `POST /api/accounts/deviceauth/usercode` -> `{"device_auth_id":"d1","user_code":"CODE-12345","interval":"0"}` (interval as a string)
  - `POST /api/accounts/deviceauth/token` -> 403 first, then 200 `{"authorization_code","code_challenge","code_verifier"}`
  - `POST /oauth/token` (form body; authorization_code grant, and refresh_token grant) -> `{"id_token":"<alg:none JWT with email and https://api.openai.com/auth claims>","access_token":"<jwt>","refresh_token":"r1"}`
  - `POST /oauth/revoke` (set `CODEX_REVOKE_TOKEN_URL_OVERRIDE`, and `CODEX_REFRESH_TOKEN_URL_OVERRIDE` for refresh)
  - `GET /codex/device` HTML page (only a human or Playwright would open it)
  - API-key flow needs no server: `printf %s sk-test... | codex login --with-api-key`.
- Run: `codex login --device-auth --experimental_issuer http://mock:PORT` in a throwaway image/wrapper (the hidden flag is a test seam, never offered in the product), `CODEX_HOME=<tmp>`, `-c cli_auth_credentials_store=file`.
- First run: `-c openai_base_url=http://mock/v1` (API-key mode) with `CODEX_API_KEY=dummy`, or `-c chatgpt_base_url=...` for ChatGPT mode (exact path to mock **unknown**, record with the Codex test fixtures). Mock serves `GET /v1/models` (empty list is accepted per the CLI's own harness) and `POST /v1/responses` SSE: `response.created`, `response.output_item.done` (assistant message), `response.completed`. For tools add a `function_call` item first. Assert on `codex exec --json` lines: `thread.started`, `turn.started`, `item.completed` (agent_message), `turn.completed`.

*Claude Code (login cannot be mocked; the rest can):*
- Sign-in through the real binary against a mock would need hosts/DNS mapping of four Anthropic hostnames, a mock CA via `NODE_EXTRA_CA_CERTS`, and reverse-engineered token/profile/roles payloads I could not obtain. Not recommended for required checks. Use Layer 1 for the login console.
- Status, logout and first run **are** testable with the real binary: seed `$CLAUDE_CONFIG_DIR/.credentials.json` with `{"claudeAiOauth":{"accessToken":"sk-ant-oat01-FAKE...","refreshToken":"FAKE","expiresAt":<far future; check ms vs s>,"scopes":["user:inference","user:profile"],"subscriptionType":"max"}}` (mode 0600) plus `~/.claude.json` `{"hasCompletedOnboarding":true,...}`, set `ANTHROPIC_BASE_URL=http://mock:PORT`, and run in a container with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_AUTOUPDATER=1` (or `DISABLE_UPDATES=1`), `DISABLE_TELEMETRY=1`, `ENABLE_CLAUDEAI_MCP_SERVERS=false`. Mock endpoints:
  - `POST /v1/messages` (path arrives as `/v1/messages?beta=true`): the SSE sequence in section C; honour non-streaming too; assert `anthropic-beta` carries the OAuth value and `authorization: Bearer <fake>`.
  - `POST /v1/messages/count_tokens` (optional; 404 is fine, CLI estimates).
  - `HEAD /api/hello` -> 200 (or 404).
  - `GET /v1/models` only when `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`.
  - Everything else (profile, feature flags, roles) goes to the real hosts; run the container on a network with **no route** to them (Flux's `internal: true` slot network with the egress proxy replaced by the mock) so any leak fails closed. The first spike must record which unexpected hosts the CLI tries (use `--debug-file`) before this is a required check.
- Test the `-p --output-format stream-json --verbose` consumer with this: `system/init` first, `result` last.
- `claude auth status` / `claude auth logout` on the seeded state can be golden-recorded offline under `docker run --network none` (zero chance of touching an account). Logout will try to revoke over the network; with no network it should delete locally and may print `Logout failed` or still succeed: **unknown**, which is exactly what the spike must record.
- `ANTHROPIC_API_KEY=fake` with `-p` is the simplest mock-able first-run path (always used with `-p` [D]) but it exercises `authMethod:"api_key"`, not the subscription path Flux sells. Use the seeded-OAuth variant for the subscription path.

Licensing note [from ai-modes]: Flux does not bundle Claude Code. A test image that contains the real Claude binary must download it at test time from `downloads.claude.ai` (needs egress, and "preinstalling or running Claude Code" terms apply per ai-modes). Codex (Apache-2.0) can be vendored by tag.

### E2. Contract tests that keep the fakes honest (account-free, can be required)
In a `--network none` container with the pinned real binaries:
1. `claude --version`, `claude auth login --help`, `claude auth status --help`, `claude setup-token --help`, `codex login --help`, `codex logout --help`, `codex login status --help`: diff against checked-in goldens. This catches new login methods (the #279 acceptance "lists no further method" becomes automatic) and flag drift on every version bump.
2. Run the real `claude auth status` and `codex login status` in an empty config dir; assert the JSON key set and the exit code, and run the **same** assertion against the fake. One shared test table, two subjects.
3. Same for `claude auth status` with seeded fake credentials, and `codex login status` after `--with-api-key` / mock-issuer login.
4. Assert stream selection (stdout vs stderr) in the shared table. This would have caught D3.

### E3. What only a real vendor account can prove
- That real browser OAuth completes and the printed URL is accepted by the vendor; the exact `code#state` the vendor shows; PKCE and state acceptance; SSO and org enforcement (`forceLoginOrgUUID`, workspace restriction).
- Token lifetime, rotation and revocation semantics (a refresh token reused by two programs, logout actually invalidating server-side), `last_refresh` handling after 8 days, `invalid_grant` recovery text.
- Plan detection and what `status` reports for the owner's actual subscription; Console keyless profile behaviour and where it lands (D1); whether device-auth is enabled for the account.
- Real model responses, rate-limit headers (`anthropic-ratelimit-unified-*`), `Login expired` states, vendor ToS / policy behaviour, and drift in unreferenced server-side payloads (profile/roles/token bodies) that no mock can know.
- Whether the egress allow-list of Flux is complete for a real login (hosts listed in A1/B).

### E4. Keeping the live layer out of required checks
- Separate entry point, e.g. `scripts/check_vendor_live.sh`, never called by `scripts/check_application.sh`; refuses to run unless `FLUX_LIVE_VENDOR=1` **and** an explicit account label is passed; prints which account class it will use; runs only on a maintainer machine.
- GitHub: a `workflow_dispatch`-only workflow (no `pull_request`/`push` trigger), no repository secrets (the owner signs in interactively through the same console), not in the required-checks list. Add a repo test that fails if the live script or workflow name appears in `check_application.sh` or the required-check configuration, and a grep gate that fails when any test or fixture reads a real vendor host (`api.anthropic.com`, `platform.claude.com`, `auth.openai.com`, `chatgpt.com`, `api.openai.com`) outside the allow-list files.
- Run the account-free contract tests (E2) in required checks: they need only the pinned binaries, no account, and give the same "does the real CLI still behave like the fake" signal on every version bump.
- Record the evidence of any live run (date, CLI version, which of E3 was checked) in the #279 issue as "vendor acceptance", separate from the mocked acceptance, as the issue already distinguishes ("Mocked runtime delivery ... is not vendor/runtime acceptance").

### E5. Open items for the first spike (each is a single container run, no account)
1. `docker run --network none` the pinned `claude`: record `auth status` (JSON, text, exit codes) empty and seeded; `auth logout` on seeded state; list files created outside `CLAUDE_CONFIG_DIR` (look for `~/.config/anthropic`, `~/.claude.json`).
2. Start `claude -p` with the seeded OAuth credential and `ANTHROPIC_BASE_URL` pointing at the mock; capture every request path and header; confirm no OAuth call is made and which other hosts are attempted with the non-essential-traffic switch on.
3. Run `claude auth login --console` with no network and read what it prints before failing, to see whether the keyless-vs-key choice appears on this subcommand.
4. Confirm the Codex mock-issuer flow end to end with `--experimental_issuer`, and whether `CODEX_CA_CERTIFICATE` lets the unmodified `codex login --device-auth` reach a TLS mock of `auth.openai.com` (would remove the need for the hidden flag).
