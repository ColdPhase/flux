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
- **A scratch per run** (#1437, RT-5): `/scratch/<run id>` on a memory file system of its own (`/scratch`, 1 GiB for all
  runs together), created empty for each run, owned by the person and deleted after it; the runtime's only place a run's
  tools can write.

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
    does not change either ([RT-5](#rt-5--tools)).
- The egress's request parser is size-bounded, minimal and fuzz-tested.

## RT-5 — Tools

**Founder decision (Hubert, 2026-11-13, [#1437](https://github.com/ColdPhase/flux/issues/1437)), amending this section and
F-022's carried-over safety list:** "Why do we limit Claude Code and Codex so much when they already support these things? An
agent can turn HTML into a PDF itself — give it access to tools." A server agent on Claude Code or Codex keeps its CLI's own
shell and file tools, inside a sandbox that exists for one run; every engine can attach a file to its answer with
`flux_attach_file`. **The boundary is the container, its egress and the per-run sandbox, not the tool list.**

- **What a run has.** The run's exact Flux MCP tools (including `flux_read_web`, the Flux server's read-only page reading
  (RT-4), which opens any public address but one that carries private Flux text the run read (C-30)); the CLI's own web
  search, which runs at its vendor; and, on Claude Code and Codex, the CLI's own shell and file tools: Claude Code's `Bash`,
  `Read`, `Write`, `Edit`, `Glob` and `Grep`, Codex's `exec_command` (with `write_stdin`) and `apply_patch`. No apps, no
  sub-agents, no other MCP server, and no CLI tool that opens a page from the runtime (`WebFetch` stays off; web reads stay
  `flux_read_web`). An API-key run (the worker's tool loop) has no shell: it attaches a file by passing its content.
- **The run's scratch** is the only place a run's tools can write: `/scratch/<run id>` on the runtime's own memory file
  system, created empty for the run (mode `0700`, owned by the person's user id), the CLI's working directory and `TMPDIR`,
  and deleted with everything in it when the run ends, however it ends. At most 256 MiB each. Concurrent runs are different
  people's (one lane per person, RT-3), so their scratches belong to different user ids, and `/scratch` itself cannot be
  listed: no run sees another's.
- **The sandbox** (Linux Landlock, a kernel feature any process may apply to itself; no capability, no Docker API). Every
  command a CLI's tool runs starts in Flux's sandbox shell: Claude Code takes it as its shell (`CLAUDE_CODE_SHELL`), Codex
  finds it first as `bash` on its `PATH`. The shell, and everything it starts, can read and write only the run's scratch, read
  and run the system's programs and libraries (`/bin`, `/usr`, `/lib`, `/etc`) and read `/proc`; it cannot read the person's
  CLI homes (their vendor login), `/data`, `/tmp`, the tools volume or another run's scratch, cannot read another process's
  environment or memory (Landlock scopes ptrace to the sandbox, so the CLI's own environment with its run token is out of reach
  too), cannot make links or devices, and starts with a clean environment (no run token, vendor setting or proxy). It has
  **no TCP at all** (Landlock ABI 4, Linux 6.7, which the tools require: coordinator decision on #1437) and **no socket of any
  kind** (a seccomp filter: Landlock does not cover UDP, so no DNS or datagram leaves, nor a connection to a Unix socket by its
  path, such as Claude Code's own messaging socket in its `TMPDIR`; no io_uring), and (ABI 6, Linux 6.12) cannot signal or reach
  an abstract socket outside the sandbox. The CLI itself runs under an outer domain: it writes only its own home and the run's
  scratch and reads only those, the system and the run's settings, never the other CLI's home. Claude Code's own file tools
  are confined to its working directory by `--restricted` as well.
- **A fixed toolbox, nothing installed** (founder decision 2026-11-13, #1437). Agents never install tools from the internet (no
  PyPI, npm or apk through the egress; the sandbox has no network). The runtime image ships a pinned toolbox for every harness:
  Python 3 with pandas, openpyxl, python-docx and matplotlib, Node, pandoc with typst for PDF (no browser), jq, ripgrep and libvips's
  `vips` for pictures. Operators who need more build their own image on top of Flux's (operator guide, "The toolbox").
- **Limits per run** (docs/operations/agent-runtime.md "What each agent needs"): the tools' memory (every process of the
  run but the CLI itself) 512 MiB and the scratch 256 MiB, at most 256 processes and threads of the person, 10 minutes of CPU
  for one tool process, a lower priority (`nice` 10) than any CLI, and the run's processes go first when memory runs out. The
  supervisor measures the run every second; past a limit it kills the tools (the CLI and its run go on, and the tool call
  fails). The run's own wall clock (RT-3, one hour) bounds everything; at its end the supervisor ends every process of the
  person and deletes the scratch.
- **The network is unchanged** (RT-4): the runtime reaches only its egress, and the egress only the vendors' hosts and Flux's
  `/mcp`; no Flux database, Redis, Docker API, metadata address or LAN. A shell has no network at all.
- **No new credential is readable.** The run token stays in the CLI's own environment and the vendor login in the CLI's home;
  neither reaches the tools. The supervisor's secret is in a non-dumpable root process.
- **The CLI's own login never leaves through Flux** (coordinator decision on #1437). Codex applies an `apply_patch` itself, outside
  the shell sandbox, and its `exec_command` starts the shell the model names, so a steered Codex can reach its own home. So the
  supervisor reads the run's login file as the person when the run starts and keeps its values (every run of 20 or more token
  characters, and each long piece of a dotted one) in memory while the run lasts; every Flux tool call of the run (`flux_attach_file`,
  every change, and every read, such as an address `flux_read_web` would fetch) is refused when what it would send holds one (the server asks the run's supervisor through runtime-manager, and only "found"
  or "not found" comes back; a file is looked through as it is read). A change of files outside the scratch, or a command outside
  the sandbox shell, kills every process of the person at once, with no grace (RT-7 still holds: nothing of the login is persisted,
  logged or sent). What this cannot catch: a value the model rewrites (encoded, split) before sending it; accepted risk 10. What Codex reads from
  its home at start (instructions, settings, skills, hooks, its `.env`) is removed before and after every run with its own tools, and a login the run wrote over its own (an attacker's account, which would
  carry the person's next runs there) is replaced by the one the run started with.
- **Without Landlock's network rules** (a kernel before 6.7, ABI 4, or one where Landlock is not enabled), the runtime keeps its
  CLIs as before: Flux's tools and the CLI's own web search only, and `flux_attach_file` has nothing to attach. The supervisor logs
  `tools_off` once at start.
- **Prompt injection** ([accepted risk 10](#accepted-risks)): a run that reads hostile content can now run commands, in its
  own sandbox. What that reaches is what the sandbox and the egress allow, nothing more.
- **Pictures go only through two Flux tools** ([#1217](https://github.com/ColdPhase/flux/issues/1217), founder
  decision 2026-11-12; [AG-8](assistant.md#ag-8--what-server-agents-may-do), [C-59](decisions.md#coordinator-defaults-and-inferences-not-founder-decisions-hubert-can-override)).
  `flux_attach_image` has the Flux server, never the runtime, download a public picture under the
  rules of `flux_read_web` and attach it to the run's answer. `flux_view_image` gives the model a
  picture attached to a message the run may read, as image input: an MCP image result, which
  Claude Code and Codex hand to their model, and an image block in the request of the owner's API
  key. A CLI's own image tools stay off (Codex's `view_image` and `image_generation`), the egress does
  not change, and no agent generates pictures.
- **Finding older messages** (F-042, [AG-12](assistant.md#ag-12--finding-older-messages-f-042)): a CLI run gets the
  same `flux_search` and `flux_read_around` tools and the same brief text as an API-key run, so both engines see the same
  results. They search Flux's own database (BM25); no model or embedding call is made to search. `flux_summarize` is the same
  for both: it returns the messages of a range as a digest and the run's own model writes the summary, so the owner pays as for
  any run and nothing is stored.
- **Claude Code** runs with its own tools `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep` and, while the web is on, `WebSearch`
  (`--tools Bash,Read,Write,Edit,Glob,Grep,WebSearch`; without `WebSearch` with `FLUX_WEB_READS=off`, C-29; never `WebFetch`,
  `Task` or any other), `--restricted` (its file tools only in the working directory, the run's scratch), Flux as the only MCP
  server (`--strict-mcp-config`, `ENABLE_CLAUDEAI_MCP_SERVERS=false`), the exact Flux tools, `Bash`, `Read(./**)` and
  `Edit(./**)` (and `WebSearch`) in `--allowedTools`, `dontAsk` with no permission prompts, no session persistence, Flux's
  sandbox shell as its shell and the run's scratch as its working directory and `TMPDIR`. The first `system/init` event is read
  back; any other tool or MCP server stops the run with nothing committed. Observed with the pinned 2.1.285 against a local
  mock model (2026-11-13): `Read`, `Write`, `Edit`, `Glob` and `Grep` outside the scratch answer "outside … `--restricted`
  confines the file tools to the working directory"; `Bash` runs in the sandbox shell, where the CLI's home, `/data` and the
  CLI's `/proc/<pid>/environ` are refused.
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
  `-c` (apps, hooks, goals, plugins, memories and the rest of the reviewed list; its shell stays on, #1437), Flux as
  the only, required MCP server with exactly the run's tools, and no persistence. **Its shell and file tools** (#1437) are
  `exec_command` and `apply_patch`; the run's scratch is its working directory. Codex's own sandbox needs bubblewrap, which a
  container without user namespaces cannot run (observed with the pinned 0.160.1, 2026-11-13: `workspace-write` failed every
  command and patch, and its legacy Landlock mode is deprecated and reports an `error` item), so it runs with
  `--sandbox danger-full-access` inside Flux's sandbox: its commands start in Flux's sandbox shell (found as `bash` first on its
  `PATH`), and Codex itself writes only its home and the scratch and reads neither Claude Code's home nor `/data`. Codex applies
  an `apply_patch` it finds inside a shell command itself, before any command runs; Flux's outer domain bounds what that can
  touch, the run stops at a `file_change` with any path outside the scratch, and the instructions and settings the pinned Codex reads from its home
  (`AGENTS.md`, rules, skills, prompts, hooks and the rest) are removed before and after each run, so nothing it wrote there reaches the next one. **Its model
  catalog is Flux's copy of the pinned one** ([#1127](https://github.com/ColdPhase/flux/issues/1127)):
  the pinned catalog makes every model Flux offers `code_mode_only`, which hides MCP tools inside
  code mode's JavaScript `exec` tool, so Flux's copy gives them plain tools (`tool_mode: direct`)
  and no sub-agents, tool search or experimental tools (its shell and `apply_patch` stay the vendor's, #1437); everything else stays
  the vendor's. **The copy is cut down for each run** ([#1332](https://github.com/ColdPhase/flux/issues/1332)) to the
  models the account's own `model/list` returns, read just before the run in a separate app-server
  session that carries no catalog (a configured catalog is authoritative, so it would only echo
  Flux's own), so a run can never be offered a model the account lacks; a run on a model outside the
  cut ends as "the plan didn't accept it" before the CLI starts. Flux's tools need no approval in Codex (Flux decides what waits for the owner,
  AG-3, as with Claude Code's `dontAsk`), and Codex's `request_user_input` is off. A preflight reads
  the effective configuration, and the run's own JSONL is the authoritative check: any item other
  than a message, reasoning, an allowed Flux tool call, a call of Codex's own MCP resource readers
  on Flux (next point), a command run in Flux's sandbox shell, a file change inside the run's scratch or, with the web on, a
  `web_search` item stops the CLI with nothing committed. **With the web on, Codex searches** (#1065, founder 2026-11-09):
  `-c web_search="cached"`, OpenAI's cached index; with `FLUX_WEB_READS=off` it is `web_search="disabled"`,
  and the preflight requires the one or the other (the real pinned binary's `config/read` reflects it:
  `contract/check-codex.ts`, 2026-11-09). How the pinned Codex searches depends on the model (codex-rs at
  rust-v0.160.1, read 2026-11-09): a Responses Lite model, as the default `gpt-6.1-sol` and most of the
  catalog are, gets the standalone `web.run` tool (`ext/web-search`, offered for the OpenAI provider),
  which the CLI runs by posting to `alpha/search` on the host it already uses, with
  `external_web_access: false`; another model, such as `gpt-5.5`, gets the hosted `web_search` tool with
  `external_web_access: false` (`core/src/tools/hosted_spec.rs`). Either way no live request reaches a
  site from the runtime, the egress does not change, and a page the model asks to open is read from
  OpenAI's index (OpenAI's description of `external_web_access`, a vendor claim). **Observed with the
  real pinned binary** (offline, a local mock as the model and the search endpoint, 2026-11-09; and
  through Flux's whole path, with Flux's model catalog of #1127, in `scripts/check_cli_runtime.sh`
  step 12): with Flux's web-on overrides the default model was offered `web.run`; its call reached `alpha/search` with
  `external_web_access: false`; and `codex exec --json` printed the `web_search` item started with no
  query and completed with its query, action and `results` (`text_result` entries, `ref_id`
  `turn0search0` for a search result and the address itself for a page it opened). With the web off,
  neither tool was offered. Flux records the queries and the search result entries (never an opened
  page), and the run's answer names its sources; it opens any page it found with `flux_read_web` like
  any other address.
- **The plan's models are read from the CLI** (#1332, founder direction 2026-11-12; F-022 amended;
  [CA-2](model-providers.md#ca-2--models)). The supervisor has one more request in its closed set,
  `models` (the person's binding, the CLI and the supervisor's boot id), and answers with the
  models the signed-in CLI itself offers: for Claude Code, the `models` of its headless
  initialization answer (`claude -p --input-format stream-json --output-format stream-json
  --restricted --tools "" --strict-mcp-config`, one `initialize` control request, no user message,
  so no model call; the process ends once it answers); for Codex, `model/list` of the same
  allowlisted app-server client, which may now send `initialize`, `config/read`,
  `account/rateLimits/read` and `model/list` and nothing else (`command/exec` and every other
  method are still refused before anything is written). Each answer is reduced in the slot to at
  most 64 entries of an id the protocol accepts, a display name and a short note; hidden models
  (Codex) and **Fable** (it can bill usage credits that Flux cannot see) are dropped there.
  Nothing the CLI prints is logged. It is read when the person signs in and about every six hours
  by the worker's reconciliation tick, one plan per tick, and it never waits behind a run nor holds
  one up: the request takes the person's lane only when it is free and answers `busy` otherwise, a
  run that finds only that read in the lane ends it (the read answers `busy`) and goes next, and the
  worker keeps the last list. For Codex, only the models Flux's reviewed copy of the pinned catalog
  holds are passed on (no run could use another).
- **Codex's own MCP resource readers go through to Flux** (#1165, decided 2026-11-10). The pinned
  Codex offers the model `list_mcp_resources`, `list_mcp_resource_templates` and `read_mcp_resource`
  whenever an MCP server is configured, and no setting removes them (codex-rs at rust-v0.160.1, read
  2026-11-10: `add_mcp_resource_tools` in `core/src/tools/spec_plan.rs` checks only that a server
  exists; neither `[tools]` nor an MCP server's settings has a switch for them). They read only MCP
  servers Codex has configured. A call names one server, or a list names none and asks every server
  (its item then names the server `codex`). An unknown name fails inside Codex before anything is
  sent (`McpConnectionSet::client_by_name`). A resource address goes to that server as data and is
  never opened by Codex. With Flux the only configured server and apps and plugins off (no
  `codex_apps` or plugin server: `ext/mcp`), all of which the preflight checks, the readers reach
  only Flux's MCP route, under that run's token. A run's server has no resources and does not
  declare any, so Claude Code offers no resource tool. When Codex asks anyway, Flux answers a list
  with none and a read with "Resource not found" (-32002), without looking at the address
  (2025-06-18, the version the pinned Codex speaks; a 2026-07-28 request gets the SDK's own "Method
  not found"). So a reader's item on the server `flux` or `codex` is let through. It counts as one
  of the run's turns toward the cap, and the run goes on. A real-model acceptance run had ended
  `local_tool` on a list the model made instead of `flux_list_contexts`. A reader that names any
  other server, and any other tool of the `codex` server, still stops the CLI.
- The pinned versions have a flag contract test. A new default-on feature or a changed event
  format keeps runs off until the review list and checks are updated.
- Transcripts are not kept. An agent's memory is only what its owner told it (AG-1). The one copy of
  what a run read is the private Flux text the address check of `flux_read_web` needs (C-30): what people,
  the company and its tools wrote in its brief and each Flux tool result, compared-ready, in
  `personal_run_private_texts`. It is kept only while the run is in flight and deleted in the same
  transaction as any end of the run (an answer, Stop, a limit, a failure, the sweep of a lost run); a result
  that comes back after the end keeps nothing (#1136). Content deleted during a run stays in it until the run
  ends.
- **Codex's `web.run` can `open` an address the model chose** (#1136). The CLI posts it to OpenAI's search
  with `external_web_access: false`, so by OpenAI's description the page comes from the cached index and the
  address never reaches the site (a vendor claim, not checked by Flux); Flux sees the item only afterwards
  and does not run the private-text check on it. Such a page is not a source Flux lists.

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
  still reports a login. Signing in again sets it back. A status check does too whenever the CLI's own
  status reports a login, but that is only the CLI's word: a revoked key still passes it, so the next
  run marks the sign-in again. Only a text that means a real revocation counts (Codex's "Please log out
  and sign in again", an invalid key or token), never a temporary refresh failure or a refusal from
  Flux's own `/mcp`.
- **Before every plan sign-in** Flux says: the server's operator can technically read the runtime's
  storage, so sign in only where you trust the operator; and the vendors recommend API keys for
  products and automation and may restrict this use without notice.

## RT-7 — Secrets, sign-out and backups

- Flux never persists, logs or sends a vendor credential. (The supervisor reads a run's login file in memory, as the person, only
  to refuse a Flux change or attachment that holds one of its values: RT-5, #1437.) The login exists only in the person's
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
   carries what the agent knows to a site. Any address opens (founder direction 2026-11-09, C-30); the defence is AG-2, AG-3 and AG-8,
   the brief's rule never to put anything from Flux into an address, the server's refusal of an address that carries private Flux text
   the run read (as written, encoded, or new on a redirect hop), and the tests in #856, #953, #954, #1065 and #1136. What the agent rewrote
   can still leave: accepted by the founder. Two channels are outside that check: Codex's `web.run` `open` (RT-5, read from OpenAI's cached
   index by its description) and a link card, which with `FLUX_LINK_PREVIEWS=on` is fetched for a person's message but never for a line an
   agent that runs on the server wrote (C-30).
10. **A run can run commands** (#1437, founder decision 2026-11-13). A run that reads hostile content (a message, a page, a
   file) can be steered to run commands in its own sandbox and to attach what it made. The boundary is the container, the
   egress and the per-run sandbox (RT-5), not the tool list: no command reaches the vendor login, the run token, another
   person, another run, `/data`, the database or the LAN, and nothing it writes outside the scratch outlives the run. What a
   shell can still do: use the run's CPU, memory and scratch up to the run's limits; read the system's own files and other
   people's command lines (RT-3). It has no network (the tools are off on a kernel without Landlock's network rules). Codex is
   the weaker side: it applies an `apply_patch` itself, outside the shell sandbox, and its `exec_command` (0.160.1) starts the
   shell the model names, which then runs under Codex's outer domain only (its own home, its login included, the scratch and
   the egress). Flux kills every process of the person the moment Codex reports such a change or command, refuses a Flux change
   or attachment that holds a value of the login, and removes what Codex wrote into its home; a command that does its harm in
   the milliseconds before that kill, or a value the model rewrites before sending, is not caught (#1437 review). What the run attaches is
   checked as a person's upload is, and only its asker sees it until they show it to everyone.
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
