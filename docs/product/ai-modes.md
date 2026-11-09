# Where agents run (F-036; supersedes F-022 "exactly two AI modes")

**Status:** founder direction, Hubert (@PelikanFix16), 2026-11-02/03
([#851](https://github.com/ColdPhase/flux/issues/851), [#856](https://github.com/ColdPhase/flux/issues/856),
[#860](https://github.com/ColdPhase/flux/issues/860)), recorded 2026-11-03 in
[#852](https://github.com/ColdPhase/flux/issues/852); independent review pending
([F-036](decisions.md#f-036--simple-ai-everything-is-an-agent)). It keeps F-022's runtime safety and
drops its two-mode framing, fixed slot pool and run caps. F-022's full text, its research and the
options it rejected are at [`a82ee012`](https://github.com/ColdPhase/flux/blob/a82ee012d0dc0a33e9ab14925f8f400c96f31e60/docs/product/ai-modes.md);
the evidence is in the [agent runtime research](research/2026-10-05-agent-runtime.md) and the
operator guide is [agent runtime operations](../operations/agent-runtime.md).

Agents run in two places, under the same rules ([agents](assistant.md)):

1. **On the Flux server.** Every agent of every person. Always ready, so it takes tasks while its
   owner's computer is off.
2. **On the person's computer.** Their own Claude Code or Codex over MCP, for code
   ([local Claude Code and Codex](mcp-cowork.md)).

Providers and sign-in methods are choices of a connection ([Connect AI](model-providers.md)), never
further kinds of agent.

## RT-1 — Engines on the server

| Connection | Who runs the agent's loop | Where the credential lives |
| --- | --- | --- |
| Claude plan, ChatGPT plan | The unmodified official CLI, `claude` or `codex`, in the person's isolated runtime | Only the person's directory in the runtime, written by the CLI's own login |
| API key | The Flux worker's tool loop | Flux, sealed ([CA-4](model-providers.md#ca-4--key-custody-and-endpoints)) |

- Both reach Flux only through its MCP route, with a short-lived run token bound to the agent, its
  owner, the run and its place. The route lists exactly the run's tools and checks the owner's
  current rights, the space's AI switch and "What it may do" on every call.
- The run token is passed in its own environment variable, never in a file or argument, and
  expires with the run.
- Flux's brief is appended to the CLI's system prompt and never replaces it, so a run stays a
  Claude Code or Codex session.
- Nothing falls back from one connection, engine or payer to another.

## RT-2 — The unmodified CLI: no plan token, no impersonation

**Refused**, with the reason:

| Request | Why |
| --- | --- |
| A pasted `claude setup-token` / `CLAUDE_CODE_OAUTH_TOKEN`, a claude.ai session or a copied `~/.codex/auth.json` | Anthropic: third parties "may not collect, store, or intermediate Claude.ai credentials or session tokens". Codex: one `auth.json` per machine |
| Reusing a vendor's OAuth client ID, or sending Claude Code's headers from another client | It impersonates another application. Anthropic prohibits "third-party tools that misrepresent their identity to Anthropic's servers" (support 13189465). Hermes Agent's core Claude route does this; Flux must not |
| Vendor tokens held by the Flux server (database, worker, queue), including hosted Codex app-server authentication | Anthropic: "may not collect, store, or intermediate". OpenAI: app-server authentication "has never been permitted for commercial or hosted services" (2026-10-04) |
| A modified or wrapped Claude Code binary, or one with an authentication method disabled | Anthropic: the binary "must not be modified", and customers "may not remove, disable, or restrict any authentication method built into it" |
| Flux, the operator or another person paying for, pooling or spending a person's plan | Anthropic: "Each end user must authenticate with their own … Claude subscription plan credentials"; F-019 |

**Installation.** Flux does not bundle Claude Code. When the operator turns on Claude Code,
`runtime-install` downloads Anthropic's official release at the version Flux's flag contract test
covers, checks it against Anthropic's signed release manifest, and installs it into a read-only
tools volume with updates disabled. Codex is pinned in the runtime image (Apache-2.0). Running
Claude Code in a product "requires agreeing to our Commercial Terms of Service", so the operator
states that they agreed with Anthropic before turning it on; Flux records the statement and does
not verify it. A paid hosting service run by the Flux project keeps plan sign-in off.

## RT-3 — Isolation and capacity

- **No Docker API.** No Flux service has access to a Docker or Podman API, and no Compose file
  mounts a socket.
- **One isolated place per person, in one runtime** (#860). People cannot reach each other's
  credentials, processes or runs. Each person has their own user id in the runtime, and their CLI
  homes live in their own directory (a UUID name, mode `0700`, owned by that id, credential files
  `0600` checked by `stat`, no symlinks), so the kernel keeps them apart. Their CLIs run under that id
  with no capabilities. The container has a read-only root filesystem, `no-new-privileges`, no host
  mounts, and memory, CPU and pid limits. Only its supervisor starts as root inside it, with the six
  capabilities that giving people their own ids takes (`CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `KILL`,
  `SETGID`, `SETUID`). Whatever lies inside a person's directory is written and deleted as that
  person, who has no rights outside their own files, so a link they planted leads nowhere. Root
  touches only the directory itself, and only once no process of theirs is left. People share
  one network namespace and `/proc`: a person's process can see another's command line (never its
  environment or memory) and reach their loopback ports. Flux passes no secret on a command line.
- **A small supervisor** accepts only a closed set of requests (bind, login, status,
  run, stop, logout, release), builds every command from a fixed template with a clean
  environment, makes itself non-dumpable, and accepts only its own secret. Linux Yama
  `ptrace_scope` must be at least 1. A host that fails a runtime requirement stops the runtime with
  one clear message and the fix, never a restart loop (#860).
- **No fixed per-person cap; memory decides how many run at once** (Hubert, 2026-11-03, #860). The
  fixed pool of four slots goes: every person with Connect AI can have their agents ready. Flux
  works out from the server's memory how many agents can run at the same time, about 2 on 4 GB.
  The rest wait, and their task shows "Waiting for room on the server". The operator can change the
  number in the config file; there is no setting in the app. An idle agent costs close to nothing:
  no CLI process and no model calls while it waits. Idle and per-run CPU and memory are measured
  against the 2 vCPU / 4 GB target (#862, [F-038](decisions.md#f-038--a-simpler-flux)), and the
  operator guide states what each active agent needs.
- **One lane per person.** A person's sign-in, status, runs and sign-out never overlap, which also
  prevents refresh-token races. One person's lane never waits for another's.

## RT-4 — Network

- A runtime's network is internal. It reaches only the runtime egress, never the database, Redis,
  the worker, the LAN or the cloud metadata address. Inside the runtime people share a network
  namespace ([RT-3](#rt-3--isolation-and-capacity)).
- The egress allows:
  - the vendor hosts each CLI documents (Claude Code: `api.anthropic.com`, `claude.ai`,
    `claude.com`, `platform.claude.com`; Codex: `auth.openai.com`, `chatgpt.com`,
    `api.openai.com`); telemetry, feedback uploads and update checks are not allowed;
  - Flux's MCP route, and no other Flux path;
  - nothing else. **Web reads are not through the egress** (#918): an agent reads a page with Flux's own tool `flux_read_web`, which the
    Flux server runs (GET only, public addresses only, the same guard as API base URLs and link cards:
    [CA-4](model-providers.md#ca-4--key-custody-and-endpoints)), so a CLI's own web tools stay off and the egress is not widened to
    every public host, which a TLS tunnel could not hold to read-only. Nothing is posted or submitted.
    **Claude Code's own web search is on with the web** (#1065, C-29): its `WebSearch` tool runs at
    Anthropic through the Messages API on `api.anthropic.com`, which the egress allows already, so the
    egress does not change. Its `WebFetch`, which would open pages from the runtime, stays off.
    **Codex's own search is on with the web too** (#1065): it runs at OpenAI on its cached index
    (`web_search="cached"`: no live page request), through the host the CLI already uses, so the egress
    does not change either ([RT-5](#rt-5--tools-only-flux-tools-the-clis-own-web-search-and-reading-the-web)).
- The egress's request parser is size-bounded, minimal and fuzz-tested.

## RT-5 — Tools: only Flux tools, the CLI's own web search and reading the web

- A server agent has no shell, files, code execution, images, apps, sub-agents or other MCP
  servers. Its tools are the run's exact Flux MCP tools, which include `flux_read_web`, the Flux
  server's read-only page reading (RT-4), which opens any public address but one that carries private
  Flux text the run read (C-30), and the CLI's own web search, which runs at its vendor. No CLI tool
  opens a page from the runtime.
- **Claude Code** runs with every built-in tool removed but `WebSearch` while the web is on
  (`--tools WebSearch`; `--tools ''` with `FLUX_WEB_READS=off`, C-29; never `WebFetch`), Flux as
  the only MCP server (`--strict-mcp-config`, `ENABLE_CLAUDEAI_MCP_SERVERS=false`), the exact Flux
  tools (and `WebSearch`) in `--allowedTools`, `dontAsk` with no permission prompts, and no session
  persistence. The first `system/init` event is read back; any other tool or MCP server stops the
  run with nothing committed.
- **A CLI's searches are recorded and listed** (#1065, C-30). The slot reports a search when the CLI
  starts it and again when its result comes back: Claude Code's `WebSearch` with its query, then the
  addresses of the result entries of the `user` event's structured `tool_use_result` (never an address
  from the result's text, which carries the CLI's own summary, and none for an error); Codex's
  `web_search` item, then its queries and, when the item carries structured `results`, the addresses
  of its search result entries (never an `open_page` or `find_in_page` address, which the model chose).
  The worker writes them in the order the CLI wrote them (`personal_run_web_searches`). The run lists
  the queries and the addresses its answer names that a search returned, as an API-key run lists its
  searches and citations. Since any address opens (founder direction 2026-11-09), nothing waits for a
  search to be recorded.
- **Codex** runs with `--ignore-user-config`, every reviewed default-on feature switched off by
  `-c` (shell, apps, hooks, goals, plugins, memories and the rest of the reviewed list), Flux as
  the only, required MCP server with exactly the run's tools, and no persistence. **Its model
  catalog is Flux's copy of the pinned one** ([#1127](https://github.com/ColdPhase/flux/issues/1127)):
  the pinned catalog makes every model Flux offers `code_mode_only`, which hides MCP tools inside
  code mode's JavaScript `exec` tool, so Flux's copy gives them plain tools (`tool_mode: direct`)
  and no sub-agents, file edits, shell, tool search or experimental tools; everything else stays
  the vendor's. Flux's tools need no approval in Codex (Flux decides what waits for the owner,
  AG-3, as with Claude Code's `dontAsk`), and Codex's `request_user_input` is off. A preflight reads
  the effective configuration, and the run's own JSONL is the authoritative check: any item other
  than a message, reasoning, an allowed Flux tool call or, with the web on, a `web_search` item stops
  the CLI with nothing committed (a call to Codex's own MCP resource readers, which stay offered, is
  such an item). **With the web on, Codex searches** (#1065, founder 2026-11-09):
  `-c web_search="cached"` (OpenAI's cached index, `external_web_access` false); with
  `FLUX_WEB_READS=off` it is `web_search="disabled"`, and the preflight requires the one or the other.
  The pinned `codex exec --json` (rust-v0.160.1) carries a `results` field on the `web_search` item
  (openai/codex #32898 of 2026-07-13 and #46319 of 2026-09-17, both in that tag; GitHub compare API,
  2026-11-09), filled only by Codex's standalone web search (`features.standalone_web_search`, still
  under development and off by default there); Flux does not turn that feature on, so a Codex run
  normally records its queries and no result addresses. Its answer names its sources itself, and it
  opens any page it found with `flux_read_web` like any other address.
- The pinned versions have a flag contract test. A new default-on feature or a changed event
  format keeps runs off until the review list and checks are updated.
- Transcripts are not kept. An agent's memory is only what its owner told it (AG-1).

## RT-6 — Sign-in

- Sign-in runs exactly the CLI's own login command, and every method it offers stays available.
  The person sees a guided card and the terminal is folded under *Show details*:
  - **Claude:** "1. Open claude.ai and approve. 2. Paste the code here", with a one-tap Paste.
  - **ChatGPT:** the device code shown large, with "Copy and open ChatGPT"; Flux notices when it
    is done.
- The supervisor recognises only the sign-in URL and the device code in the CLI's output, in
  memory, to draw the card. What the person types is relayed to the CLI's own prompt in memory
  only. Nothing of it is stored or logged.
- A pending sign-in survives a reload for the same owner and session, within a 15-minute maximum.
  Cancel, sign-out, revocation and process loss end it.
- **A sign-in that stops working** ([#1129](https://github.com/ColdPhase/flux/issues/1129)): when a
  run's CLI says its login no longer works (a revoked key or token, a refresh the vendor refuses),
  the run ends *Sign in again* and so does that sign-in in Settings, even while the CLI's own status
  still reports a login. Signing in again, or a status check that finds it working, sets it back.
- **Before every plan sign-in** Flux says: the server's operator can technically read the runtime's
  storage, so sign in only where you trust the operator; and the vendors recommend API keys for
  products and automation and may restrict this use without notice.

## RT-7 — Secrets, sign-out and backups

- Flux never persists, logs or parses a vendor credential. The login exists only in the person's
  runtime directory, written by the CLI's own flow, never in the database, queue payloads, API
  responses, stream frames, logs, exports or admin screens. A schema test refuses a runtime column
  that could hold a token, and a seeded-secret absence test covers the database, logs and frames.
- **Sign out** runs the CLI's own logout, then deletes its files. Removing the runtime, revoking
  it or deleting the person signs out every CLI, stops runs (the next MCP call fails), deletes the
  directory and confirms it is empty. If the vendor cannot be reached, the files are still deleted
  and the person is told to end the session in their account settings.
- **Backups** (`./flux backup`) exclude runtime volumes, because they hold vendor logins. After a
  restore, the worker reconciles runtimes: a missing login shows *Sign in again*, and a directory
  without an owner is signed out and deleted. `./flux reset` and `./flux clean` sign out first.
- **What a compromised part can reach.** A compromised runtime gets its own person's login and a
  short-lived, place-bound run token, and reaches only the egress. Host root can read every
  runtime volume; people are told so before signing in.

## RT-8 — Payer and data

- Each run records its payer with a label that is never shown as zero: "your Claude plan (plan
  limits or paid extra usage, not visible to Flux)", "your ChatGPT plan (…)", "your Anthropic
  Console organization (API billing)", "your OpenAI API account (API billing)", or the API key's
  provider account.
- Flux cannot see whether a plan run used plan limits or paid extra usage, so foundation §9.4's
  first pillar is not met for plans. Settings says so before sign-in.
- A run sends what the agent reads, which may include other people's messages, to the vendor
  under the person's account settings. Consumer plans may train on it unless the person opted out;
  Settings says so.

## RT-9 — The operator

- One operator step turns on agents with plans on the server (today `FLUX_AGENT_RUNTIME`, asked
  once by `./flux up`; Claude Code needs a typed `y` for the Commercial Terms statement). The
  release Compose file keeps it off, so a non-interactive deployment does not change.
- Each Flux release pins the Claude Code and Codex versions its flag contract test passed;
  `./flux upgrade` reinstalls them. Nothing updates itself.
- The operator guide states the resources each active agent needs (#860), the number of agents
  that run at once, which Flux computes from memory and the operator can change in the config file
  (RT-3), and that host root can read every person's vendor login.

## Accepted risks

Recorded by the agents under founder direction #266 (2026-10-05) and #851 (2026-11-02/03). Flux
sends no questions to Anthropic or OpenAI and waits for no vendor answer (#266 item 13). Each
operator decides for their server through the operator step (RT-9).

1. **Plan sign-in on a hosted Flux (Anthropic).** The legal page (code.claude.com/docs/en/legal-and-compliance,
   retrieved 2026-11-02) says developers building products "should use API key authentication"
   and must not route requests through plan credentials for their users, but "Nor does it prevent
   an end user from signing in to the unmodified Claude Code binary with their own Claude
   subscription, including where a platform hosts Claude Code". Flux hosts that sign-in faithfully,
   but it also drives the CLI as the engine of its agents, which the carve-out does not clearly
   reach [inference]. Mitigations: the person's own sign-in through the CLI's own flow, the
   unmodified binary, the brief appended and never replacing the system prompt, API billing
   offered beside the plan, and the risk stated before sign-in. **Rating: medium–high for Claude
   Code.** Anthropic's Usage Policy effective 2026-11-12 forbids access "through unauthorized
   means, including services that route requests through consumer subscriptions"; re-read it then.
2. **Always-on agents and other people's triggers.** Someone else assigning a task to a person can
   start that person's agent on their plan (when they chose "Give it to [agent]"), and an agent
   answers another person's agent in a task. Anthropic prohibits tools that "route third-party
   traffic against subscription limits" (support 13189465). Mitigations: only the owner's own
   standing choice starts it; the task is assigned to the owner; an answer uses only what the
   task's people can see, and its owner sees and can delete it. **Rating: medium–high to high for
   Claude Code, medium for Codex.** The monthly API credits are the clean alternative for heavy
   automated use (support 17154008, 2026-10-07).
3. **Automated and scheduled use.** Anthropic's Consumer Terms forbid access "through automated or
   non-human means" except by API key or explicit permission; Anthropic does permit `claude -p` and
   scheduled plan use in its own products (research of 2026-10-09). OpenAI calls API keys "the right
   default for automation". Schedules are the owner's own, made in plain words and confirmed by the
   owner.
4. **OpenAI and hosted teams.** Sign in with ChatGPT is documented "for open-source and locally
   hosted apps", and "a paid or remotely hosted app" needs the interest form (developers.openai.com/siwc,
   retrieved 2026-11-02). Flux uses the plain `codex` CLI with its own device sign-in, which Codex
   documents for a remote or headless host, not Sign in with ChatGPT or app-server authentication.
   A team-hosted Flux is remotely hosted from the person's point of view. **Rating: medium.**
5. **Storage on the server.** The CLI writes the login onto the operator's host; host root can read
   it. Flux relies on the carve-out in risk 1 against "may not collect, store, or intermediate".
6. **Payer visibility and training** (RT-8).
7. **Sign-in methods.** Every `claude auth login` method is offered, but a pasted setup token is
   refused because it is a Claude account credential. Whether Anthropic reads that as restricting a
   method is unknown.
8. **Web reading and search.** Egress beyond the vendors' hosts, prompt injection from any page or search result, and an address that
   carries what the agent knows to a site. The defence is AG-2, AG-3 and AG-8 (an agent reads only addresses it was given or found by its
   own search in the same run, C-30), and the tests in #856, #953 and #954.
9. **Change without notice.** Anthropic may enforce "without prior notice"; plan eligibility, the
   CLIs' flags and Codex's app-server can change. Mitigations: pinned versions, the flag contract
   test, the start-up and JSONL checks, and honest *Sign in again* and *Provider refused* states.

## Revisit when

- **2026-11-12:** re-read Anthropic's Usage Policy and legal page. Claude plan sign-in stays on
  unless the text clearly covers a platform hosting the official binary.
- Anthropic or OpenAI publish text that removes the official-binary carve-out, forbids hosted
  device-code sign-in, or clearly forbids a product driving the hosted CLI. The affected client is
  then turned off; API keys and local clients stay.
- OpenAI says a team-hosted Codex sign-in needs its interest form.
- The flag contract test fails, the pinned Codex adds a default-on feature the checks miss, or an
  isolation, escape or secret-absence test fails.
- Real-account smoke tests contradict any rule above.
