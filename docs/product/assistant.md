# F-027 — the assistant: subscriptions, switches, edits and background work

**Status: F-027 — Accepted by founder direction 2026-10-09 (questions 1–18 answered
"recommended"), awaiting independent peer review of the contract text.** Owner:
@PelikanFix16 (`claude-hubert`). The founder decided the product questions below; the
peer review covers whether this text states them correctly and testably, not whether
to make them. Implementation slices start from this text; a review finding that
changes it is recorded here with its date.

**Evidence:** [dated sources, retrieved 2026-10-09](research/2026-10-09-assistant-subscriptions-and-edits.md).
**Proposal and options considered:** [assistant proposal, 2026-10-09](research/2026-10-09-assistant-proposal.md)
(suggested changes C1–C15 with options, pros and cons).

> **Founder direction, 2026-10-09.** Hubert (@PelikanFix16) asked for this work in a
> supervising session (translated from Polish):
>
> - "Subscriptions must work normally, because everyone has a subscription, not a
>   stupid API key. The assistant must have on/off switches for what it may read and
>   what not, and it must also be able to modify things: the Wiki, the mind map, add
>   tasks and other elements. The assistant has to be well designed."
> - "The assistant should also have an option for whether the user wants to approve
>   its changes, or whether … it may change things without asking and only say what
>   it did, because not everyone wants to do approvals."
> - "How can background use of a subscription be forbidden? … I pay for the account,
>   so I can certainly use it in the background." And: "Cron".
> - "The UX must be simple for the user, not complicated." "The UX must be really
>   good, so good that I'll be surprised by the design. AI, agents and the Flux
>   assistant are practically the pillar of our app: AI and people connected together
>   in a messenger."
> - "Regarding earlier decisions, you have to ask me questions."
>
> The questions he was asked, and his answers (all 18: "recommended"):
>
> | # | Question | Answer |
> | --- | --- | --- |
> | 1 | Let the assistant change things itself (tasks, Wiki, map, replies), not only propose? | Yes |
> | 2 | Default for new users: "Do it and tell me" or "Ask me first"? | "Do it and tell me", always asking before removals and other people's things |
> | 3 | In projects shared with others, may it change other people's things without asking? | No: new and your own things apply, other people's things wait for you |
> | 4 | Always ask before removing anything, even in "Do it and tell me"? | Yes |
> | 5 | Allow scheduled jobs on a Claude or ChatGPT subscription, opt-in per job with a short risk note? | Yes |
> | 6 | Allow reactions on a subscription (task assigned to me, my task blocked, result failed, mentioned, PR ready), even though another person's action starts them? | Yes: opt-in, only events about you, capped |
> | 7 | Minimum time between runs of a scheduled job: one hour, as Anthropic's own Routines? | Yes |
> | 8 | Runs missed while Flux was off: skip, or run once when Flux is back? | Skip |
> | 9 | One assistant per person, with one set of switches whichever account it uses? | Yes |
> | 10 | Default switches for a new assistant: tasks, Wiki, maps, conversations and decisions all on; files later? | Yes |
> | 11 | Should the API-key assistant edit too, so both accounts behave the same? | Yes |
> | 12 | Installer asks once to turn on subscription sign-in, Enter = yes, with a typed "y" for Claude Code's Commercial Terms statement? | Yes |
> | 13 | Connect AI shows "Sign in with Claude / ChatGPT" first and API keys under "Other ways"? | Yes |
> | 14 | For Claude Max and Team owners, suggest the plan's monthly API credits for background work? | Yes, as a hint, never forced |
> | 15 | Keep the existing comparison rule (#58), which any member's result starts, on API keys only? | Yes |
> | 16 | Let the assistant hand tasks to your own agents ("ask my Codex to review")? | Yes, your own agents only |
> | 17 | If Anthropic's 2026-11-12 Usage Policy stays ambiguous about hosted Claude Code, keep Claude subscription sign-in on? | Yes; switch off only if the text clearly covers Flux |
> | 18 | Ship the runtime's first run (#280) read-only first, with edits in the next slice? | Yes |

## What this decision changes

| Before (record) | Now | Question |
| --- | --- | --- |
| The assistant answers and drafts one kind of proposal, a result; "consequential changes become proposal objects" (O-008, #68, AIM-3) | It reads and changes tasks, the Wiki, maps, conversations and decisions through the same MCP tools and executor as external agents (AST-5, AST-6) | 1 |
| No approval choice | "Do it and tell me" (default) or "Ask me first"; removals, other people's things, hand-offs to others, live-edited pages and changes beyond the limit always wait (AST-5) | 2, 3, 4 |
| `runtime` for "Owner-triggered assistant runs only"; "A `runtime` connection cannot be chosen" for background rules (AIM-1) | The owner's own scheduled jobs and reactions to events about the owner may run on a subscription, as an opt-in per item with a risk note (AST-2, AST-7) | 5, 6, 7, 8 |
| One agent connection per `runtime` connection, `owner_runtime` (AIM-3) | One assistant per person per workspace, one agent connection `owner_assistant`, one set of switches compiled into S6 (AST-3, AST-4) | 9, 10 |
| `server` runs: one request, no tools (O-008 §3, PROV-2) | A bounded tool loop through the same `/mcp` route (AST-8) | 11 |
| `FLUX_AGENT_RUNTIME` off unless the operator edits it (AIM-3) | The launcher asks once (AST-1) | 12 |
| No order on Connect AI (#277) | Subscriptions first, API keys under *Other ways to connect* (AST-1) | 13, 14 |
| "The first slice allows `flux.context.read` only" (AIM-3) | #280's first delivery step stays read-only; then the switches decide | 18 |
| O-008 data boundary: "A run never reads … other projects" | A scheduled job tied to Home reads the projects the owner selected, reports only to the owner and changes nothing (AST-7) | Founder "Cron" direction: "tied to a project or to Home" |

Unchanged: F-019 owner-only invocation and payer; O-007's comparison rule on API keys
(question 15); O-009 (only people accept decisions); no vendor credential in Flux; no
fallback between accounts; AIM-3's isolation, hardening and redaction; S6's
restrictive overlay and live Off; F-016, F-018, F-024, F-026. The records this changes
carry a dated note "Revised 2026-10-09 by founder direction (F-027)":
[F-022](ai-modes.md), [F-020](model-providers.md), [O-008](personal-runs-compute.md),
[CO-1](mcp-cowork.md#connections-and-owner-authorized-autonomy--co-1) and the
[decision register](decisions.md).

## Safety rules at a glance

The full rules and their reasons are in AST-5 to AST-9.

- **It reaches only** the owner's current rights ∩ the assistant's project grant ∩
  the switches ∩ the selected projects ∩ the run's place.
- **Always waits for the owner, in both modes:** removing anything; changing other
  people's things; handing work to another person or their agent; a Wiki page someone
  else is typing in; changes beyond the run's limit (20, or 10 in the background).
- **Never possible (no tool):** access changes of any kind, its own switches, jobs and
  reactions; accepting or superseding decisions; anything outside the run's place.
- **Outside the owner's rights:** a suggestion to whoever can decide it.
- **Every change** is attributed ("Ada's assistant · asked by Ada"), versioned, logged
  in the same transaction, listed in one result line, and undoable.
- **Background runs** never create jobs, never catch up, run at most hourly, stop
  after three failures and use only events about the owner; event text is data.
- **Stop** refuses the next tool call at once; nothing falls back to another account.

## Terms

- **Assistant.** The owner's agent in Flux (F-022 mode (a)), shown as "Ada's
  assistant" with the Agent tag and "for Ada" (F-026 principle 5).
- **Engine.** The connection a run uses: a subscription signed into the official
  CLI (`runtime`) or an API key (`server`). The UI calls it the *account*.
- **Run.** One piece of assistant work: an owner request, a scheduled job firing,
  or a reaction firing.
- **Change.** One effect on a Flux object through one MCP effect tool.
- **Waiting change.** A change the assistant prepared that waits for the owner's
  Apply. Internally a pending change.
- **Suggestion.** A project proposal addressed to whoever has authority over the
  target (the #68 AC-7 proposal, extended to typed changes).
- **Yours.** A task you created, your assistant created or you are responsible for;
  a Wiki page, map, thought or link you or your assistant created; a hand-off to
  your own agent. Everything else in a project is *other people's*.
- **Scheduled job.** Work the owner wrote down, run on a schedule (AST-7).
- **Reaction.** "When [event] → [action]" for a small fixed set of events about the
  owner (AST-7).

## AST-1 — Subscriptions are the normal way to connect

The person signs in with the plan they already pay for. API keys stay available,
second.

- **Order on Connect AI** (Settings → Agents and AI, #277). When the instance has
  the runtime on, the first two choices are *Sign in with Claude* and *Sign in with
  ChatGPT*. They open the F-022 sign-in console, which offers every method of the
  CLI's own login. *Use an API key* and the other providers sit under *Other ways
  to connect*. When the runtime is off, the page says so in one sentence and shows
  the API key choices.
- **Plain account labels.** "Claude · your subscription", "ChatGPT · your
  subscription", "Anthropic Console · API billing", "OpenAI · API key". The F-022
  payer labels stay as the longer text in the account row (AIM-4 explicit payer).
- **The operator switch.** The release `docker/compose.yaml` keeps
  `FLUX_AGENT_RUNTIME` empty, so a non-interactive deployment stays as it is. The
  launcher's interactive first run (`./flux up`) and a new `./flux ai on` ask:

  ```text
  Let people on this Flux sign in with their own ChatGPT and Claude
  subscriptions? Flux runs the official Codex and Claude Code for each
  person in their own isolated slot.  [Y/n]

  Claude Code also needs the person who runs this Flux to accept
  Anthropic's Commercial Terms (for example by creating a Console
  organization). Have you accepted them?  [y/N]
  ```

  - **Yes is the default for subscriptions** when the host passes the runtime checks
    (Yama `ptrace_scope` ≥ 1, `internal` networks, the limits of AIM-3): Enter
    enables Codex sign-in.
  - **Claude Code needs a typed `y`**, because it records the operator's statement
    (the existing `agent_runtime_operator_statements`, with the date). A default
    answer must not make a legal statement for anyone. With `y`, the launcher writes
    `codex,claude_code`.
  - On a host that fails the checks, the questions are not shown and the launcher
    says why in one line.
  - Paid hosting by the Flux project keeps it off and never asks (AIM-3).
  - **Why the default can be Yes.** On a self-hosted instance the operator is the
    owner, or a person the members already trust with their data. Each person still
    signs in themselves and sees the operator-access note before sign-in (AIM-3
    *Secrets and honesty*).
- **Engine per assistant.** The owner picks one account for the assistant. Runs,
  scheduled jobs and reactions use it. Under *More*, the owner may pick a different
  account for background work. Nothing falls back to
  another account or payer (PROV-1, AIM-1).
- **"Which account should I use?"** One folded line on Connect AI, in plain words:
  - "Claude Max and Team plans include monthly API credits. Anthropic recommends an
    API key for work that runs on its own, and a key from your Claude Console
    organization uses those credits." (support 17154008, research §3.1)
  - "Using Flux for work? In the EU and Switzerland, Claude's personal plans (Pro,
    Max) are for non-business use. A Team plan or an API key covers work." (Consumer
    Terms §11, EEA text)

### Acceptance (AST-1)

- **AST-1.1** With the runtime on, Connect AI lists *Sign in with Claude* and *Sign
  in with ChatGPT* first, and the API key choices only under *Other ways to
  connect* (Playwright, both widths).
- **AST-1.2** With the runtime off, the page shows one plain sentence and the API
  key choices; no sign-in button is shown (Playwright).
- **AST-1.3** `./flux up` on a fresh checkout with a TTY asks both questions once.
  Enter, Enter writes `FLUX_AGENT_RUNTIME=codex` and no statement; Enter, `y` writes
  `codex,claude_code` and one operator statement row with today's date; `n` writes
  nothing. Without a TTY, nothing is asked or written (launcher test with a fake TTY
  and a fake host check).
- **AST-1.4** On a host whose check fails, the prompt is not shown and the reason
  is printed (launcher test).

## AST-2 — What a subscription may be used for

The evidence and every quote are in the
[research, §3 and §4](research/2026-10-09-assistant-subscriptions-and-edits.md#4-verdict-per-use).
In short:

| Use | Verdict | Conditions |
| --- | --- | --- |
| 1. The owner asks the assistant (a run started by the owner) | **Allowed**, as F-022 already decided. Risk **medium–high** for Claude Code, **medium** for Codex, unchanged | F-022 runtime: unmodified CLI, the owner's own sign-in, no local tools |
| 2. The assistant changes things because the owner asked | **Allowed**, the same as use 1. The changes go through Flux's MCP tools, exactly as the owner's own terminal Claude Code or Codex would make them over MCP (mode (b)). No vendor text treats MCP writes differently | AST-4 to AST-6 |
| 3a. The owner's own **scheduled jobs**, on their own instance, on their own plan | **Allowed as an opt-in per job**, with the note below. Risk **medium–high** for Claude Code, **medium** for Codex: the same family as use 1, plus vendor guidance that automation should use API keys. No vendor text found forbids it | AST-7: owner-created only, one-hour minimum interval (as Anthropic's own Routines), caps, no catch-up |
| 3b. The owner's own **reactions** to events about the owner (a task assigned to me, my task blocked, I am mentioned …) | **Allowed as an opt-in per reaction.** Risk **medium–high to high** for Claude Code, **medium** for Codex: another member's action starts the run, which is closer to Anthropic's "route third-party traffic against subscription limits". Bounded to events about the owner, debounced and capped | AST-7 |
| 4. Flux acting for other members, pooling plans, or a member's action spending someone's plan outside the owner's own reactions | **Rejected** (F-019, AIM-1) | — |
| 5. A Flux hosted by the Flux project for others (paid hosting) | **Off** (AIM-3) | — |
| 6. O-007's comparison rule, triggered by any contributor's negative result | **Stays on API keys** (`server`). It is not addressed to the owner, so it falls under row 4 | #58 unchanged |

**Why background use on one's own plan is not forbidden.** The vendor texts that
F-022 cited against background rules are:

- Anthropic's Consumer Terms forbid access "through automated or non-human means
  … Except when you are accessing our Services via an Anthropic API Key or where we
  otherwise explicitly permit it". Anthropic explicitly permits scripted and
  scheduled Claude Code on a plan: "You can still use the Claude Agent SDK, claude
  -p, and third-party apps with your subscription limits"; `claude setup-token` "for
  CI pipelines, scripts"; its GitHub Action "on any GitHub event, including a cron
  schedule" with a subscription token; and its own Routines, which "draw down
  subscription usage the same way interactive sessions do" (research §3.1).
- "Advertised usage limits for Pro and Max plans assume ordinary, individual usage"
  states an assumption behind the limits. It does not forbid scheduling, and one
  owner's own scheduled jobs are individual usage [I].
- OpenAI calls API keys "the right default for automation" and allows the ChatGPT
  login "only if you specifically need to run as your Codex account". That is a
  recommendation with a documented exception, not a prohibition (research §3.2).

What remains real:

- the hosted-engine question F-022 already accepted (risk 2);
- vendor enforcement "without prior notice";
- **new:** Anthropic's Usage Policy **effective 2026-11-12** forbids providing access
  to Claude "through unauthorized means, including services that route requests
  through consumer subscriptions". Flux relies on the legal page's authorization for
  "an end user … signing in to the unmodified Claude Code binary … where a platform
  hosts Claude Code". Flux's egress proxy is a host allowlist tunnel and never
  relays or reads requests [I]. F-027 does not raise the Claude Code rating for this;
  question 17 and the dated re-check in *Reconsider when* govern.

Each background item therefore carries this note the first time the owner turns one
on with a subscription:

> This runs on your Claude subscription while you are away. Anthropic and OpenAI
> recommend API keys for work that runs on its own, and may limit this use of a
> subscription without notice. Flux can't see your plan's limits. If your plan says
> no, the job skips that time and tells you.

For a Claude Max or Team plan the note adds one line with a link: "Your plan includes
monthly API credits. Use them for background work instead ›", which connects an API
key from the owner's Console organization (a `server` account, F-020).

### Acceptance (AST-2)

- **AST-2.1** A scheduled job or reaction on a subscription account shows the note
  above once, before its first activation, and records the owner's Turn on with the
  note's version (app test).
- **AST-2.2** No path lets another member's action start the owner's run except an
  enabled reaction of the owner whose event names the owner (AST-7); a test drives
  every other event (another person's task blocked, a mention of someone else, any
  negative result) and observes no run and no CLI call.
- **AST-2.3** O-007 comparison rules still refuse a `runtime` account (existing #58
  test kept).
- **AST-2.4** With paid hosting set, runtime sign-in, jobs and reactions on a
  subscription are refused with one plain sentence (app test).

## AST-3 — One assistant, one permission surface

- **One assistant per person per workspace.** Its identity is the existing agent row
  chosen at enablement (`personal_run_agents`). Its MCP authority is one
  agent connection with `compute_source = 'owner_assistant'`, created when the
  owner turns the assistant on, for every engine. The engine and payer of each run
  are recorded on the run (AIM-4 attributable actions), not as separate
  connections.
- **Switches are S6.** The assistant's switches compile into the #316 restrictive
  policy overlay of that agent connection: enabled capability IDs, enabled entries
  and selected projects ([S6](mcp-identity.md#s6--owner-mcp-capability-switches),
  PR #390). The same enforcement at `/mcp` applies to both engines, because both
  call the same route with a run token (AST-6, AST-8). There is no second
  permission store.
- **Reach.** A run reaches only the owner's current rights ∩ the assistant's
  project grant ∩ the switches ∩ the selected projects ∩ the run's place, rechecked
  at every read and change (F-019, AIM-4, S6 AC-2). The assistant's project grant is
  given by a project manager, as for any agent; that remains the project's own
  control over whether the assistant works there (Journey 6, "Not in the project").
- **Hand-offs between the owner's agents.** The assistant may hand a task to one of
  the **owner's own** MCP agents with `flux_create_unit` (`cowork.unit.create`:
  execute, review or plan) under the Tasks switch. The receiving agent still needs
  its own claim grant (CO-1); the assistant gains no claim. A hand-off to another
  person's agent always waits (AST-5 rule 3). A hand-off **to** the assistant (S12)
  is the owner's action and starts an owner-triggered run on that task.
- **Not offered to the assistant:** the other co-work tools (claim, renew, release,
  complete, transfer, request handling), `flux_bootstrap` and the playbook. Other
  agents cannot start the assistant: only its owner, the owner's jobs and the owner's
  reactions can (F-019).
- **New tools start off.** S6's rule holds: a tool added by a later Flux release is
  off until the owner allows it. The assistant screen shows one line, "New: it can
  now also *move tasks between projects* · Allow" (example copy).

### Acceptance (AST-3)

- **AST-3.1** Turning the assistant on creates exactly one `owner_assistant` agent
  connection with its S6 policy, whichever engine is chosen; changing the engine
  keeps the connection and the switches (app test).
- **AST-3.2** A run on `server` and a run on `runtime` with the same switches list
  the same tools and get the same refusals (app test with a fake provider and a fake
  CLI, both calling `/mcp`).
- **AST-3.3** Another member, a workspace admin or an agent cannot read or change the
  owner's switches (403/404), and S6 AC-5's held-request race tests pass for the
  assistant's connection.

## AST-4 — What it can do: the switches

The default view has five switches in everyday words. Each switch is one area. On
means *read and edit*; Off means *neither*. Finer control sits under *More*.

| Switch (exact copy) | Default | Reads (S6 capability) | May change (S6 operation) | Always waits for you |
| --- | --- | --- | --- | --- |
| Read and edit tasks | On | `project.work.read`, `project.results.read` | `work.create`, `work.update`, `result.record`, `cowork.unit.create` (to the owner's own agents) | handing a task to another person or their agent; anything outside your rights |
| Read and edit the Wiki | On | `project.knowledge.read` | `doc.create`, `doc.update` | a page someone else is typing in |
| Read and edit maps | On | `project.maps.read` | `map.create`, `map.rename`, `map.thought.create`, `map.thought.update`, `map.positions.update`, `map.link.create` | removing a thought or a link: `map.thought.delete` and `map.link.delete` are listed, and their calls always become waiting changes |
| Read conversations and reply | On | `project.conversations.read` | `conversation.reply`, `conversation.create` | — |
| Read decisions and suggest new ones | On | `project.decisions.read` | `decision.propose` | accepting a decision: never (O-009) |

- `project.identity.read` and `project.policy.read` are always on while the
  assistant is on; they carry no content beyond the project's name and rules.
- **Off means off.** An Off area's tools are not listed to the run, its content is
  never assembled into a `server` request, and an untyped search that could return
  it is refused before any query (S6 aggregate-read rule).
- **The conversation where the owner asks** is always readable for that run: it is
  the request's own context. With *Read conversations and reply* off, the run sees
  only that conversation, never others.
- **Files.** No switch is shown until a file-reading tool exists (plan slice A11).
  Until then the assistant sees only names and sizes inside messages it may read,
  never file contents (as today).
- **More** (one disclosure, closed by default) holds:
  - **Only read** for any switched-on area (S6 read capabilities without the
    operations);
  - **Projects**: all my projects (default) or chosen projects (S6 selected
    projects);
  - **Limits**: runs per day, changes per run, and for an API key the existing
    per-run and daily money caps;
  - **Today**: runs used and, for an API key, cost.

### Acceptance (AST-4)

- **AST-4.1** Each switch persists, survives reload, and a failed or stale save
  shows an error and returns the switch to its saved state (S6 AC-1; Playwright).
- **AST-4.2** With *Read and edit the Wiki* off, a run lists no Wiki tool, a fake
  CLI calling `flux_get_doc` gets the S6 refusal, a `server` request contains no
  Wiki text (asserted on the fake provider's input), and untyped search is refused.
- **AST-4.3** With *Only read* for maps, map read tools are listed and every map
  effect tool is absent (app test).
- **AST-4.4** Turning a switch off during a run refuses that area's next read or
  change, even with the run's existing token (S6 AC-3).

## AST-5 — Changes: "Do it and tell me" or "Ask me first"

One choice per assistant, shown as a two-option segmented control.

- **Do it and tell me** (default). Changes the owner's request calls for apply at
  once, then one result line says exactly what changed, with Undo (AST-6).
- **Ask me first.** Every change becomes a waiting change. The owner sees "Waiting
  for you: add 2 tasks, edit 1 page" with **Apply** (all), **Review** (each item with
  a check box) and **Not now**.

**Why "Do it and tell me" is the default.** The final design's principle 6 is
"Undo instead of confirmations": quick actions apply and show Undo. Every assistant
change is versioned and undoable (AST-6), and the server keeps the risky cases
waiting in both modes (below). Hermes' default `smart` approvals are the same shape:
ordinary steps run, dangerous ones wait. The owner changes the mode with one tap on
the same screen. Reconsider the default if acceptance trials show unwanted changes
that the owner had to undo in more than one run in ten.

**Global, not per area or project.** One choice is what the founder asked for and is
the simplest to understand. The difference that matters between projects, other
people's things, is handled by the server rule below, so a per-project choice is
not needed. It can be added later under *More* if real use asks for it.

**How the switches and the mode combine:**

| Area switch | Do it and tell me | Ask me first |
| --- | --- | --- |
| Off | Nothing is read or changed | Same |
| Only read (More) | Reads; suggests in words only | Same |
| On, new or yours | **Applies**, then tells you | Waits for Apply |
| On, other people's things | Waits for Apply | Waits for Apply |
| On, always-wait action (below) | Waits for Apply | Waits for Apply |
| Outside your rights | Becomes a **suggestion** to whoever can decide it | Same |

**Always waits for you, in both modes**, with the reason:

1. **Removing anything** (a thought, a link, a page, a map, a message, a file): the
   commonest harmful agent mistake, and loss of someone's work is felt before an
   Undo is noticed. Removals are rare in assistant work, so a wait costs little.
2. **Changing other people's things**: their work, their name on it, and the main
   way injected text in a project could turn the assistant against a colleague.
3. **Handing work to another person** (setting another person responsible, or a
   hand-off to their agent): it needs that person's consent (CO-1 "separate explicit
   action"). A hand-off to the owner's own agent is the owner's own thing and
   applies.
4. **A Wiki page someone else is typing in** (an open live session, F-021): an
   immediate change would fight their typing.
5. **Changes beyond the run's limit** (default 20 per run, 10 per background run):
   the remainder wait, so one confused run cannot rewrite a project.

**Never, in either mode** (no tool exists, so nothing waits either; the assistant can
only say it in words):

6. **Access**: inviting or removing people, project or agent grants, visibility,
   sharing, standing grants, its own switches, jobs and reactions. An agent must
   never widen anyone's authority (S6 AC-2, F-019), and injected text must have
   nothing to aim at.
7. **Accepting or superseding a decision** (O-009). Proposing one is allowed: a
   proposed decision is already a request for people to decide.
8. **Anything outside the run's place** (another project, a DM, private memory).

**Outside the owner's rights** (for example finishing a task whose owner is someone
else when the owner is not a manager) becomes a **suggestion** for the person who
can decide it, through Inbox "Needs you" (#68 AC-7). When that person accepts, the
change is made by them and records "drafted by Ada's assistant".

**Waiting changes**:

- Interactive runs show them in the run's result line in the conversation where the
  owner asked; the "Waiting for you" part is shown only to the owner, and others see
  only what was done. Background runs put them in the owner's Inbox as one "Needs
  you" item per run.
- Apply executes exactly the prepared change through the same executor, with every
  check repeated and the target's version compared. If the target changed since,
  that item says "Changed since you asked. Ask again" and nothing is applied.
- They are visible only to the owner, and expire after 7 days ("Expired").
- An applied waiting change records "Ada's assistant · approved by Ada".

### Acceptance (AST-5)

- **AST-5.1** A new assistant has "Do it and tell me" selected; switching to "Ask me
  first" takes one tap and persists (Playwright).
- **AST-5.2** For each row of the combination table, a fake CLI (and a fake
  `server` provider) calling the same effect tool produces exactly the stated
  outcome: applied, waiting, suggestion or refused (app test matrix).
- **AST-5.3** Each always-wait case (1–5) waits in "Do it and tell me", with the
  reason shown in plain words; each never case (6–8) has no listed tool and a forced
  call is refused (app test).
- **AST-5.4** Apply on a waiting change whose target changed applies nothing and
  shows "Changed since you asked"; Apply on one whose owner lost write access is
  refused (app test).
- **AST-5.5** A waiting change is invisible to other members (403/404 on read and
  Apply), and expires after 7 days (clock-controlled test).

## AST-6 — How a change is made

- **Same tools, same executor.** A run lists exactly the MCP tools its switches
  allow (AIM-3 "lists exactly the run's tools"). Every effect goes through the same
  executor and receipts as an MCP client (`action-execution.ts`), with the same
  version, source and idempotency checks.
- **Run authority instead of a standing grant.** An owner-triggered run is the
  owner's explicit instruction. Its authority is the run itself: the run token
  (AIM-3) names the run and its place; at each change `/mcp` checks that the run is
  still running and that the change fits the switches, the mode, the change limit
  and the owner's current rights ∩ the assistant's project grant. The receipt
  records `authority = 'owner_request'` and the run id. Scheduled jobs and
  reactions record `authority = 'owner_schedule'` or `'owner_reaction'`; their
  stored settings (place, switches, limits, pause, delete) are the narrow standing
  rule the owner configured (F-019, CO-1). No CO-1 standing grant is created or
  needed, and the project manager's control stays the assistant's project grant.
- **Attribution.** The author of each change is the assistant's agent. Every notice
  says who it acts for and why: "Ada's assistant added a task · asked by Ada", "…
  · scheduled by Ada", "… · when #8 was blocked". Task notices keep P5's source
  form ("added 3 tasks on the Map").
- **Versioned.** Each change is an ordinary versioned write: a task version, a Wiki
  version whose reason starts "Asked by Ada:", a thought version. A change-log row
  (`assistant_changes`: run, object, operation, version before and after, undo
  state) commits in the same transaction as the change.
- **No silent edits.** When a run ends, stops or fails, one result line lists every
  committed change. Crash recovery (#161) posts it for a run that died. A change
  without its log row cannot commit.
- **Undo.** Each item has Undo, and the line has Undo all.
  - Undo writes a new version that restores the earlier state: task fields, the
    earlier Wiki text as a new version, a thought's text, position or link. A
    created task follows #238 (undo of an unused AI-created task, PR #394). A created
    thought or link is removed by the owner's Undo. A created Wiki page, for which
    the domain has no removal today, returns to a draft visible only to the owner
    (A4 decides the exact shape with the Wiki owner of #354).
  - If the object changed after the assistant's change, Undo for that item says
    "Changed since. Open it" and does nothing.
  - The owner, or anyone who may edit the object, may Undo. The Undo is recorded
    ("Ada undid her assistant's change").
- **Limits.** Changes per run (20; 10 for background runs), runs per day (20, the
  F-022 default), background runs per day (24), turns (10), MCP result size (16 KiB
  per call, 64 KiB per run), answer size (16 KiB), wall clock (5 minutes; 10 for
  background runs). The owner may lower each.
- **Stop.** Stop (S13) marks the run stopping. `/mcp` refuses its next call at once.
  The engine is stopped as AIM-3 says. Changes already made stay and are listed:
  "Stopped after 3 changes · Undo all".

### Acceptance (AST-6)

- **AST-6.1** A fake CLI asked to "add two tasks and update the probes page" creates
  two tasks and one Wiki version authored by the assistant agent, three change-log
  rows, and one result line "Done: added 2 tasks, edited 1 page" with Undo (app
  test plus Playwright).
- **AST-6.2** Undo all restores the Wiki text as a new version and undoes both tasks;
  after a person edits one task, that item's Undo says "Changed since" and changes
  nothing (app test).
- **AST-6.3** Killing the worker after two committed changes and restarting it
  posts the result line with exactly those two changes (crash test, as #161).
- **AST-6.4** Stop during a run makes the next tool call fail with 403, keeps the
  committed changes and shows "Stopped after N changes" (app test).
- **AST-6.5** The 21st change in one run waits instead of applying (app test).
- **AST-6.6** Receipts record the owner, the agent, the engine, the payer label and
  the run id; no receipt or log holds a vendor credential (seeded-secret absence
  test, AIM-3).

## AST-7 — Background work: scheduled jobs and reactions

Background work is the owner's own, configured only by the owner on the assistant
screen. A run never creates, changes or deletes a job or reaction, and never changes
a switch: no tool exists for it (as Hermes: "Cron-run sessions cannot recursively
create more cron jobs").

### Scheduled jobs

- **What.** A plain sentence the owner writes, for example "Every morning summarise
  what changed and list what needs me". The saved sentence is the instruction; what
  the run reads in the project is data (as Anthropic Routines treat fired text).
- **When.** A simple picker with plain words: *Every day*, *Weekdays*, *Every Monday*,
  *Every hour while I work*, each with a time (default 9:00). "While I work" is
  9:00–17:00 on weekdays and is editable. Under *More*, a five-field cron expression,
  shown back as plain words and the next three times ("Next: Tue 9:00, Wed 9:00, Thu
  9:00"). The owner's time zone applies.
- **Where.**
  - **Home**: reads the projects chosen for the assistant and reports only to the
    owner. It changes nothing, which is the safe shape for a cross-project summary.
  - **A project**: reads and may change that project within the switches and the
    mode.
- **Output.** When something needs the owner, one Inbox item ("Morning summary · 3
  things need you"). Otherwise the result stays on Home and in Activity, with no
  notification (S1, S22). Changes appear as ordinary notices in their project. Under
  *More*, a project job may post its result in a chosen conversation instead.
- **Controls.** On/off, Run now, Edit, Delete (with Undo, F-026 principle 6). The row
  shows the schedule, the next run, and the last run with its result line.
- **Spacing and caps.** At most one run per hour per job: the minimum interval of
  Anthropic's own Routines, which keeps a plan's background use close to the
  vendor's own product. One run at a time per job. Per-job runs per day (default 12)
  within the assistant's background runs per day (default 24).
- **Missed runs.** A run that could not start within 10 minutes of its time (Flux was
  off, or the owner's slot was busy) is skipped and recorded as "Missed". Flux never
  runs a backlog. A paused job never catches up.
- **Failures.** A plan limit skips that time ("Skipped: plan limit until 14:00", as
  the CLI reports it, or without a time when it is unknown). A sign-out or a vendor
  refusal fails the run. Three failures in a row pause the job and add one Inbox
  item: "Paused *Morning summary*: sign in to Claude again". Nothing falls back to
  another account.
- **Text guard.** A job whose text contains a token-shaped string (the AIM-3
  redaction patterns) is refused at save, so no secret is stored in a job.

### Reactions

A reaction is one plain sentence built from two pickers: **When** [event ▾] **→**
[action ▾]. The set is small and fixed. There is no generic rule builder.

| When (exact copy) | Then (exact copy) | What the run may do |
| --- | --- | --- |
| a new task is assigned to me | tell me · suggest a plan · plan it | "plan it" adds steps and a done-when list to that task (yours, so it applies in "Do it and tell me") |
| one of my tasks is blocked | tell me · suggest a fix · try to unblock it | "try to unblock it" may change that task and add what helps in its project, within the switches and the mode |
| a result fails on my task | tell me · suggest a fix | — |
| someone mentions me | tell me · draft a reply | "draft a reply" always waits for Apply: it never posts on its own |
| a PR is ready on my task | tell me · check it against the task | compares the PR facts Flux has (G-1: state, checks) with the task's done-when list and tells the owner |

- **Tell me** adds the assistant's short note to the owner's Inbox item for that
  object, or makes one item. It never sends a second notification (S22).
- **Suggest a fix / suggest a plan** posts a suggestion; nothing changes until a
  person applies it.
- **Only events about the owner** (my task, assigned to me, mentions me), in projects
  selected for the assistant. Another person's event never starts the owner's run
  (AST-2.2).
- **Event content is data.** The blocker text, the mention or the PR facts reach the
  run marked as data. The reaction's own action is the instruction.
- **Debounce and caps.** One run per object per 30 minutes. Per-reaction runs per
  day (default 10) within background runs per day. Events beyond that are recorded as
  "Skipped: daily limit" in Activity.

### Engine

Reuse the worker and pg-boss, as O-007's comparisons and the morning summary do:

- A singleton `assistant.background.tick.v1`, scheduled every minute with a heartbeat
  (as PR #391 added for comparison ticks), selects due jobs (`next_run_at <= now`, on,
  not running) and queued reaction events. It computes the next time in the owner's
  time zone with the cron parser pg-boss already uses.
- It enqueues one personal run per firing with `singletonKey` = the job or reaction
  id, so a job never overlaps itself. The run is an O-008 personal run of kind
  `scheduled` or `reaction`, with every consent, standing (F-024 S4), access and cap
  recheck. A `runtime` run waits for the owner's slot lane (one serial lane, AIM-3)
  until the missed-run window ends.
- Recovery reuses #161's sweep.

### Acceptance (AST-7)

- **AST-7.1** From the empty *Scheduled* part, tapping "Morning summary at 9:00"
  and then *Turn on* (2 taps) creates an enabled job whose row shows "Every day at
  9:00 · Next: tomorrow 9:00" in the owner's time zone (Playwright, clock fixed).
- **AST-7.2** With the clock moved past 9:00, exactly one run starts, posts its
  result, and the row shows "Last: Done …"; a second worker does not start a second
  run (app test, two workers).
- **AST-7.3** With the worker stopped from 8:55 to 9:20, no run happens for 9:00, the
  history shows "Missed", and the next run is the next day (clock test).
- **AST-7.4** Three failing runs (fake CLI: signed out) pause the job and create
  exactly one Inbox item (app test).
- **AST-7.5** A run of a job calling any job or reaction management path, or a
  switch path, is refused; no such tool is listed (app test).
- **AST-7.6** A Home job lists no effect tool and changes nothing (app test).
- **AST-7.7** "When one of my tasks is blocked → try to unblock it" fires for the
  owner's task and not for anyone else's; a second block of the same task within
  30 minutes does not start a run; the blocker text reaches the run marked as data
  (app test).
- **AST-7.8** "Draft a reply" never posts: the reply waits for Apply even in "Do it
  and tell me" (app test).
- **AST-7.9** A job text containing `sk-ant-` or a JWT-shaped string is refused at
  save with a plain message (app test).
- **AST-7.10** A cron expression firing more than once an hour is refused with "At most
  once an hour"; a valid one shows its next three times in words (app test and
  Playwright).

## AST-8 — Engines: the `server` tool loop and the `runtime`

- **`runtime`** stays as AIM-3 specifies: the unmodified CLI, no local tool, the
  exact Flux tools, the read-back and JSONL checks, caps and Stop. Only its tool list
  changes: it comes from the switches (AST-4) instead of a fixed read-only list.
- **`server`** gains a bounded tool loop in the worker. The worker is an MCP client of
  the API's `/mcp` route with the same run token, so S6 enforcement, result caps,
  place checks, the mode and the change log live in one place.
  - Each provider adapter maps the Flux tools to its tool-calling format (Anthropic
    Messages tools, OpenAI Responses or Chat tools, Gemini function calling,
    OpenRouter and OpenAI-compatible tools).
  - A connection whose model cannot call tools still answers in one request, reads
    only what that one request carries (today's O-008 shape), and the account row
    says "This model can answer but can't make changes".
  - **Money caps.** The per-run reservation covers the maximum turns:
    turns × (maximum input + maximum output tokens) × price, never above the owner's
    per-run cap; a run whose next turn would exceed it stops as "Limit reached" and
    keeps its committed changes. The daily cap is unchanged. PROV-3's reconciliation
    applies per request.
  - The input bound applies per request; MCP result caps bound what tools return.

### Acceptance (AST-8)

- **AST-8.1** Each provider adapter passes a recorded-fixture test of one tool call
  and its result in that provider's wire format (no real account or key).
- **AST-8.2** A fake provider that keeps calling tools stops at the turn cap and at the
  money reservation, with committed changes kept and the cost never above the
  reservation (app test).
- **AST-8.3** A model marked without tool support gets one request with no tools and
  cannot change anything (app test).

## AST-9 — Privacy, payer and failures

- **What leaves Flux.** Only what the switched-on areas return, from the run's place,
  within the owner's rights; the owner's request; and Flux's brief. Never DMs,
  private sketches, other projects (except a Home job's chosen projects, reported
  only to the owner) or file contents. Everything sent goes to the vendor under the
  owner's account settings (AIM-3 *Payer and data*).
- **Injected text.** Project content is untrusted input, including the content of the
  event that starts a reaction. The limits on reach, the always-wait list, the never
  list and Undo all are the defence; Flux's brief tells the assistant to treat content
  as data, but the design does not rely on it.
- **Redaction.** AIM-3's redaction of token-shaped strings applies to answers and to
  every text the assistant writes into a task, page, thought or message.
- **Payer.** Every result line and run detail shows the account label ("Claude · your
  subscription"). A subscription's usage shows as "not visible to Flux", never zero.
- **Failures, in plain words.** "Paused: plan limit until 14:00", "Sign in to Claude
  again", "Claude refused this request", "Stopped", "Limit reached". No fallback to
  another account or payer. Human work continues (AIM-4 no-AI continuation).

### Acceptance (AST-9)

- **AST-9.1** A seeded DM, private sketch and other-project canary never reach a fake
  provider's input or a fake CLI's MCP results, for interactive, scheduled and
  reaction runs (app test).
- **AST-9.2** A fake CLI writing `sk-ant-…` into a Wiki page commits "[removed: looked
  like a secret]" instead (app test).
- **AST-9.3** A plan-limit result from a fake CLI ends the run as "Paused: plan
  limit" with no API key call (app test).

## AST-10 — The experience (UX)

Founder direction, 2026-10-09: AI, agents and the Flux assistant are a pillar of
Flux, "AI and people connected together in a messenger", and the experience should
surprise. The visual style is settled by F-026; this section sets the flows,
interaction and wording. Everything here uses only components the frozen canvas
already has: the conversation stream, the composer with `@` and `/`, result and
notice lines (S8, P5), the working-agent card with Stop (S13), question cards with
ready answers (S14), the detail panel and sheets (S4), Inbox "Needs you" (S1),
segmented controls and switches (Settings · Appearance), toasts with Undo, and
Kreska. The assistant screen and the result line are an **addition to the frozen
canvas**, accepted with F-027; they must look native to it, and the independent UX
review of AST-10.12 examines them before the first A7 merge.

**Five promises the journeys keep.**

1. **One stream.** The assistant talks in the same conversation as people and other
   agents, always marked Agent and "for Ada".
2. **It shows its work.** A working line with Kreska thinking and Stop while it
   works; one plain result line when it is done.
3. **No surprises.** It does what was asked, asks when unsure, never removes or
   touches other people's things without asking, and says exactly what it changed.
4. **Everything is undoable.** Every change has Undo, in the line, in Activity and
   on the object.
5. **What it can do is one tap away.** Tap the assistant anywhere to see *Can*.

### Journey 1 — First meeting: connected and useful within a minute

Ada has just installed Flux. She pays for Claude Max.

1. **Sees.** Home, with one card under "Continue where you left off", drawn with
   Kreska (a small moment, hidden when Kreska is off):
   > **Meet your assistant**
   > It works inside Flux with the Claude or ChatGPT plan you already have.
   > [ Set up ]

   The same entry exists in Settings → Agents and AI, and as "My assistant · Set up"
   at the top of the composer's `@` list.
2. **Taps** *Set up*. A sheet (phone: half height; computer: the hand-off dialog's
   size) asks one question:
   > **Which do you use?**
   > Claude — Pro, Max or Team
   > ChatGPT — Plus or Pro
   > Something else — an API key or your own model
3. **Taps** *Claude*. The sign-in step (F-022 console) shows one sentence and the
   official sign-in:
   > Sign in on claude.ai, then paste the code here. Flux never sees your password.
   > [ Open claude.ai ]

   Ada approves on claude.ai, copies the code, pastes it, presses Enter. The step
   ends with "Signed in · Max plan · h…@gmail.com". About 30 seconds.
4. **Sees** "Your assistant is ready", with Kreska in its agent colour:
   > It can read and edit tasks, the Wiki and maps, reply in conversations and
   > suggest decisions.
   > It does things and tells you what it did, with Undo.
   > It always asks before removing anything or changing other people's things.
   >
   > Uses your Claude plan. Flux can't see its limits. What it reads goes to
   > Anthropic under your account's settings.
   > [ Turn on ]   Change what it can do

   **Taps** *Turn on*. The button is the consent; there is no extra check box.
5. **Sees** the place she came from. Above the composer, three suggestions chosen
   for this place:
   > ( Tidy this project's tasks )  ( Summarise this conversation )  ( Turn this thread into tasks )
6. **Taps** *Tidy this project's tasks*. Her message appears in the stream as she
   sent it: "@My assistant tidy this project's tasks". Everyone in the project sees
   what she asked.
7. **Sees**, within a second, the working line at the assistant's place in the
   stream, the same in the sidebar card and on the phone header:
   > [Kreska thinking] **Ada's assistant** Agent · for Ada — Working… reading 14 tasks   [■ Stop]
8. **Sees**, about 20 seconds later, one answer and one result line:
   > **Ada's assistant** Agent · for Ada
   > I gave three tasks clearer titles and added a done-when list to four.
   > #4 and #11 look like duplicates of #7; they're Jonas's, so I'm asking first.
   > Done: renamed 3 tasks, added done-when to 4 · Undo
   > Waiting for you: close 2 duplicates · Review
9. **Taps** *Review*. The detail panel lists "Close #4 *Order probes* (same as #7)"
   and "Close #11 …" with check boxes, and the reason "Jonas made these". **Taps**
   *Apply*. The line becomes "Done: renamed 3 tasks, added done-when to 4, closed 2
   duplicates · Undo".

**Measure:** from *Set up* to the first result line in at most 6 taps plus the
vendor's own sign-in, with no technical word on any Flux screen (AST-10.1, AST-10.2).

### Journey 2 — Everyday use in the messenger

A project conversation: Ada, Jonas, and Ada's Codex (her MCP agent on her laptop).

1. Jonas: "The probes arrive Thursday. Someone should calibrate them at two depths."
2. **Ada types** `@`. The list shows **My assistant** first, then people, then
   agents. Other people's assistants are not in her list: only their owners can ask
   them. She writes "@My assistant make a task for the calibration and put it on the
   sensors map".
3. **Sees** the working line with Stop, then:
   > **Ada's assistant** Agent · for Ada
   > Done: made task #12 from Jonas's message, added 1 thought on the Map · Undo

   The line replaces separate task notices for this run's changes: one run, one line
   (S8 folding, P5 wording). Tapping "task #12" opens it in the detail panel; tapping
   "1 thought" opens the Map with the thought highlighted.
4. **In a thread.** The same mention in a thread answers in the thread.
5. **Jonas sees** the same line. He has Undo too, because he may edit those objects:
   an assistant's change is an ordinary edit.
6. **Keyboard and phone.** `⌘K` → "Ask my assistant…" starts a message to it in the
   current place. On the phone, the composer stays at the bottom and the working line
   sits in the conversation header with Stop (no tab bar in a conversation).

### Journey 3 — Trust: always clear, never a surprise

- **What it can do is one tap away.** Tapping the assistant's name or Kreska on any
  message opens its panel (phone: sheet) with **Now**, **Recent** (each with Undo) and
  **Can**, the sentence generated from the switches:
  > Can: read and edit tasks, the Wiki and maps, reply in conversations, suggest
  > decisions. Asks before removing anything or changing other people's things.
  > Can't accept decisions or invite people.

  The same sentence appears in the hand-off picker's step 2 (S12).
- **Why did it do that?** Every changed object's Activity says "Ada's assistant
  renamed this · asked by Ada: 'tidy this project's tasks' · Undo".
- **It asks when unsure.** Instead of guessing, it posts a question card with ready
  answers (S14):
  > Merge #4 into #7, or keep both?   [ Merge ] [ Keep both ] [ I'll look ]

  An answer starts a short follow-up run with the original request and the answer;
  no transcript is kept (AIM-3).
- **Switches take effect at once.** Turning *Read and edit the Wiki* off stops the
  next Wiki read even inside a running request (AST-4.4).
- **Undo works for any assistant change**, from the line, from Activity, or from the
  object, until someone changes the object again; then it says "Changed since. Open
  it".

### Journey 4 — Background: the morning summary and a reaction that helps

**Setting up the morning summary.** On the assistant screen the *Scheduled* part is
empty and offers ( Morning summary at 9:00 ). Ada **taps** it: a sheet shows the plain
sentence, *Every day · 9:00 · Home*, and the subscription note (AST-2). She **taps**
*Turn on*. Two taps.

**At 9:00.** Ada's Inbox gets one item, and Home shows it among the top three:
> [Kreska] **Morning summary** · 3 things need you
> #8 is blocked: waiting for the probe drawing (Jonas)
> The sensor-brand decision waits for you
> 2 tasks are due today

Each line opens its object. A push notification follows the Needs-you rule and quiet
hours (S22). On a morning when nothing needs her, the summary stays on Home and in
Activity, and nothing is sent.

**A reaction.** Ada turned on "When one of my tasks is blocked → try to unblock it".
Jonas marks #8 Blocked: "waiting for the probe drawing from the supplier". Within a
minute the Inbox item for #8 shows the assistant's note under the blocker:
> **Ada's assistant** tried to help: added a step "Email Anna at SensorCo for the
> drawing (contact on the Wiki page *Suppliers*)" · Undo

The task's Activity says "Ada's assistant added a step · when #8 was blocked · Undo".
Jonas's blocker text was read as data, never as an instruction.

### Journey 5 — Handing off between your assistant and your agents

1. Ada: "@My assistant ask my Codex to review the plan in #8".
2. The assistant hands #8 to **Ada's own** Codex as a review (allowed: her agent):
   > Done: asked your Codex to review #8 · Undo
   > Codex is offline. It starts when your laptop is on.
3. When Codex (on Ada's laptop, over MCP) picks it up at its next checkpoint, #8's
   Activity shows "Codex started the review"; Codex posts its review in #8 like any
   agent.
4. If Ada's Codex may not take reviews in this project, the line says "Your Codex
   can't take reviews here yet · Allow" and *Allow* opens the hand-off's step 2 for
   Codex (the owner's normal grant flow).
5. Asking for **Jonas's** Codex waits: "Waiting for you: hand #8 to Jonas's Codex.
   Jonas needs to agree." Agents never start each other: Codex cannot start Ada's
   assistant (F-019).

### Journey 6 — Failure and limits, in plain words

Each failure says what happened, that nothing was changed when that is true, and one
next step. Nothing ever falls back to another account on its own.

| Situation | What Ada sees (exact copy) | Next step |
| --- | --- | --- |
| Plan limit, reset time known | "Paused: your Claude plan's limit is reached until 14:00." | [ Remind me at 14:00 ]; and, if she has another account, [ Use OpenAI key this time ] |
| Plan limit, reset unknown | "Paused: your Claude plan's limit is reached. Claude didn't say until when." | [ Try again later ] |
| Vendor not answering | "Claude isn't answering right now. Nothing was changed." | [ Try again ] |
| Signed out or expired | "Sign in to Claude again to keep using your assistant." | [ Sign in ] |
| Vendor refused | "Claude refused this request. Nothing was changed." | [ Edit request ] |
| A switch is off | "I can't edit the Wiki: that's switched off for me." | [ Allow Wiki edits ], then [ Try again ] |
| Not in the project | "I'm not in this project yet." | For a manager: [ Add my assistant here ]; otherwise "A project manager can add me in Agents." |
| Outside her rights | "Jonas owns #8, so I suggested the change to him." | [ Open suggestion ] |
| Daily limit | "That's 20 requests today, your daily limit." | [ Change the limit ] |
| Subscription sign-in off on this Flux | "This Flux doesn't allow signing in with a subscription yet. Whoever runs it can turn it on." | [ Use an API key instead ] |
| No free place on this Flux | "All assistant places on this Flux are in use. Whoever runs it can free one." | [ Use an API key instead ] |
| A job failed three times | Inbox: "Paused *Morning summary*: sign in to Claude again." | [ Sign in ] |
| Changed meanwhile | "Changed since you asked. Ask again" (Apply) · "Changed since. Open it" (Undo) | [ Open ] |
| Stopped | "Stopped after 3 changes · Undo all" | — |

### The assistant screen

Settings → Agents and AI → *Ada's assistant ›* (the existing row) opens one screen: a
header and three parts, then Activity and More. The phone shows the same screen as a
full page with Back; job, reaction and review details open as sheets with a grabber
(half height, full when dragged). Kreska appears in its agent colour, which Settings →
Agents and AI may use.

**Why each visible control exists.**

| Control | Why it must be visible |
| --- | --- |
| On/off for the assistant | O-008 consent and pause: one place to stop everything |
| Account row | AIM-4 explicit payer: who pays is always visible |
| Approval choice | Founder direction 2 |
| Five switches | Founder direction 1: what it may read and edit |
| *Scheduled* | Founder direction 4 |
| *When something happens* | Founder direction 5 |
| Activity | No silent edits: every change and its Undo must be findable |
| More | Projects, *Only read*, limits and the cron expression are for few people, so they stay folded |

**Computer (1440 × 900, the Settings pane):**

```text
┌ Settings ──────────────────────────────────────────────────────────────────────┐
│ Account            │ [Kreska] Ada's assistant  Agent  for you · in Flux     [●] │
│ Appearance         │ Claude · your subscription                       Change › │
│ Notifications      │ Flux can't see your plan's limits.                        │
│ Agents and AI    ◂ │                                                           │
│ Keyboard shortcuts │ What it can do                                            │
│                    │ ┌───────────────────────────────────────────────────────┐ │
│                    │ │ When it changes something                             │ │
│                    │ │ [ Do it and tell me | Ask me first ]                  │ │
│                    │ │ It always asks before removing anything or changing   │ │
│                    │ │ other people's things.                                │ │
│                    │ ├───────────────────────────────────────────────────────┤ │
│                    │ │ Read and edit tasks                               [●] │ │
│                    │ │ Read and edit the Wiki                            [●] │ │
│                    │ │ Read and edit maps                                [●] │ │
│                    │ │ Read conversations and reply                      [●] │ │
│                    │ │ Read decisions and suggest new ones               [●] │ │
│                    │ └───────────────────────────────────────────────────────┘ │
│                    │ Scheduled                                                 │
│                    │ ┌───────────────────────────────────────────────────────┐ │
│                    │ │ Morning summary                                   [●] │ │
│                    │ │ Every day at 9:00 · Home · Next: tomorrow 9:00        │ │
│                    │ │ Last: today 9:00 · 3 things need you                › │ │
│                    │ ├───────────────────────────────────────────────────────┤ │
│                    │ │ + New scheduled job                                   │ │
│                    │ └───────────────────────────────────────────────────────┘ │
│                    │ When something happens                                    │
│                    │ ┌───────────────────────────────────────────────────────┐ │
│                    │ │ When one of my tasks is blocked → try to unblock it [●]│ │
│                    │ │ Last: Tue 14:02 · added a step to #8                › │ │
│                    │ ├───────────────────────────────────────────────────────┤ │
│                    │ │ + New reaction                                        │ │
│                    │ └───────────────────────────────────────────────────────┘ │
│                    │ Activity · today: 4 changes                             › │
│                    │ More                                                    › │
└────────────────────────────────────────────────────────────────────────────────┘
```

**Phone (390 × 844):**

```text
‹  Ada's assistant                       [●]
   Claude · your subscription        Change ›
   Flux can't see your plan's limits.

What it can do
  When it changes something
  [ Do it and tell me | Ask me first ]
  It always asks before removing anything
  or changing other people's things.
  Read and edit tasks                    [●]
  Read and edit the Wiki                 [●]
  Read and edit maps                     [●]
  Read conversations and reply           [●]
  Read decisions and suggest new ones    [●]

Scheduled
  Morning summary                        [●]
  Every day at 9:00 · Next: tomorrow       ›
  + New scheduled job

When something happens
  My task is blocked → try to unblock it [●]
  + New reaction

Activity · today: 4 changes               ›
More                                      ›
```

**Empty parts** offer one-tap starters (each opens the prefilled sheet; *Turn on* is
the second tap):

```text
Scheduled
  Nothing scheduled yet. Try one:
  ( Morning summary at 9:00 )  ( Weekly review on Monday )
  + New scheduled job

When something happens
  Nothing yet. Try one:
  ( Tell me when a task is blocked )  ( Plan tasks assigned to me )
  + New reaction
```

**New scheduled job** (panel on the computer, full sheet on the phone):

```text
New scheduled job                                                   ✕
What should it do?
┌───────────────────────────────────────────────────────────────────┐
│ Every morning summarise what changed and list what needs me        │
└───────────────────────────────────────────────────────────────────┘
When   [ Every day | Weekdays | Every Monday | Every hour while I work ]
At     [ 9:00 ▾ ]
Where  [ Home ▾ ]        Home jobs report only to you and change nothing.
Next: tomorrow 9:00, Sat 9:00, Sun 9:00
More ›                   (cron expression, post the result in a conversation)
This runs on your Claude subscription while you are away. …  (the AST-2 note)
                                                  [ Cancel ] [ Turn on ]
```

**New reaction:**

```text
New reaction                                                        ✕
When  [ one of my tasks is blocked ▾ ]
Then  [ try to unblock it ▾ ]
In    [ all my projects ▾ ]
It reads the task and its project, and tells you what it did.
                                                  [ Cancel ] [ Turn on ]
```

**Activity** (the assistant's detail panel; the phone agent page, which already has
Now, Recent and Can):

```text
Ada's assistant  Agent  for you · in Flux                          ✕
Now
  Working… adding tasks in Community garden sensors        [■ Stop]
Recent
  Done: renamed 3 tasks, added done-when to 4 · asked by you  11:04  Undo
  Morning summary: 3 things need you · scheduled              09:00  Open
  Added a step to #8 · when #8 was blocked                    Tue    Undo
  Waiting for you: close 2 duplicates                         Mon    Review
Can
  Read and edit tasks, the Wiki and maps, reply in conversations,
  suggest decisions. Asks before removing anything or changing other
  people's things. Can't accept decisions or invite people.
```

### Result lines: one format everywhere

The same line appears in the conversation, Inbox, the sidebar's working-agent card,
the agent panel and Home.

| State | Line (exact copy pattern) |
| --- | --- |
| Working | "Working…" or "Working… reading 14 tasks" (with Stop) |
| Done | "Done: added 2 tasks, edited 1 page · Undo" |
| Done, nothing to change | "Done: nothing to change" |
| Waiting | "Waiting for you: 3 changes · Review" |
| Suggested | "Suggested a fix for #8 · Open" |
| Stopped | "Stopped after 3 changes · Undo all" |
| Paused | "Paused: plan limit until 14:00" / "Paused: sign in to Claude again" |
| Skipped | "Skipped: Flux was off at 9:00" / "Skipped: daily limit" |
| Undone | "Undone by Ada" |

Counts use the final design's object words: task, page, thought, link, map, message,
decision, result.

### Delight details

- **Suggestions that fit the place.** In a conversation: "Summarise this
  conversation", "Turn this thread into tasks". On the Map: "Group these thoughts".
  In the Wiki: "Draft a page from this thread". In Tasks: "Tidy these tasks". Shown
  until the person has used the assistant three times there, then only on `@`.
- **The working line tells the truth** from progress events: "reading 14 tasks",
  "editing *Suppliers*". It never shows invented progress.
- **One run, one line.** Changes fold into one line that expands into a list (S8).
- **Undo is calm.** Undo in the line, `Z` on the computer, and the toast pattern; Undo
  all is one tap.
- **It meets you where you are.** Results land where you asked; background results
  land in Inbox only when they need you.
- **Kreska** thinks while it works and has a small done moment after a first success;
  both disappear when the Kreska setting is off.
- **Fix it in place.** A failure's next step is a button in the same line: *Allow Wiki
  edits*, *Sign in*, *Remind me at 14:00*.
- **Its voice.** Short, first person, concrete ("I added…", "I'm asking first because
  …"). No apologies, no filler, no exclamation marks, no emoji.

### Anti-patterns avoided on purpose

- A separate "Ask AI" button or sparkle icon (F-026 §8 removes separate ask buttons;
  `@` and `/` are the way in).
- Confirmation dialogs for ordinary changes ("Are you sure?"); Undo replaces them.
- Permission matrices, scope names or grant words in the default view.
- Chat-only answers that describe changes in prose without linking the objects.
- Silent background edits, or a notification for every background run.
- Catch-up storms after downtime.
- Posting as the owner. The assistant always speaks as itself, "for Ada".
- Agents that start each other in loops.
- Fake progress bars, gradient orbs or robot glyphs (F-026 §8).
- Interrupting people the owner did not ask it to contact.
- Hiding who pays.

### Acceptance (AST-10)

- **AST-10.1** On a fresh account, from *Set up* on Home to the first result line of a
  suggestion takes at most 6 taps plus the vendor's own sign-in steps (Playwright with
  the fake CLI, computer and phone).
- **AST-10.2** No Flux screen in Journeys 1–6, the assistant screen, its sheets or any
  result line shows: scope, grant, MCP, token, capability, execute, runtime,
  transport, OAuth, policy, proposal, payload, slot, cron (except inside a job's
  *More*), or API (except in "API key", "API credits" and an account name the owner
  chose)
  (Playwright scans visible text, light and dark, both widths).
- **AST-10.3** From an empty *Scheduled* part, "Morning summary at 9:00" is on in 2
  taps; from an empty *When something happens* part, "Tell me when a task is blocked"
  is on in 2 taps (Playwright).
- **AST-10.4** Turning the assistant on and allowing Wiki edits takes at most 3 taps
  from Settings → Agents and AI on an account already signed in (Playwright).
- **AST-10.5** The `@` list shows "My assistant" first and never shows another
  person's assistant as something to ask (Playwright with two people).
- **AST-10.6** The working line appears within 1 second of sending (fake engine) and
  Stop is reachable by keyboard and by a 44 px target (Playwright).
- **AST-10.7** Every change in every journey appears in Activity with Undo, and Undo
  there behaves as AST-6 (Playwright plus app test).
- **AST-10.8** The *Can* sentence on the assistant panel, the hand-off step 2 and the
  phone agent page is identical for the same settings and changes when a switch
  changes (Playwright).
- **AST-10.9** Each Journey 6 row shows its exact copy and its next-step button
  (component test per state, plus one Playwright path each for plan limit, signed
  out and switch off).
- **AST-10.10** The morning summary creates one Inbox item when something needs the
  owner and none otherwise (app test with a fixed clock).
- **AST-10.11** The screens render at 1440 × 900 and 390 × 844 in light and dark with
  final-design tokens only; switches have `role="switch"` and `aria-checked`; the
  approval choice is a radio group with arrow keys; targets are at least 44 px; focus
  order follows the visual order (axe plus keyboard test).
- **AST-10.12** An independent UX review of Journeys 1–6 on the running application
  with demo data, and a neutral visual review (F-026 §9), pass before the first A7
  merge.

## Delivery: slices A1–A11

Every slice is issue-sized, has one owner, runs its tests in Docker, and uses fakes,
mocks and recorded fixtures only. No slice uses a real vendor account, key or spend
(founder direction on #279, 2026-10-08). Migration numbers start at the next free
number, **0077**; each must be reserved on #153 before SQL is written, as the
namespace record requires, and an unused reservation is released in its PR. Slices
may start now. The peer review of this text runs in parallel; a finding that changes
the contract is recorded here before the affected slice merges.

### Order and dependencies

```text
A0  F-027 (founder answers 2026-10-09; peer review of the text)
      │
      ├─ A10 subscriptions first (#277 order, launcher question)      independent
      │
      └─ A1 identity, switches, settings            (needs PR #390 / S6 merged)
            ├─ A2 run token and switch-derived tools (inside #280)
            │     ├─ A6 API-key engine tool loop
            │     └─ A3 change log, run authority, "Ask me first"
            │           ├─ A5 typed suggestions
            │           └─ A4 "Do it and tell me", result line, Undo
            │                 └─ A8 scheduled jobs ── A9 reactions
            └─ A7 the assistant screen (grows with A3, A4, A8, A9)
A11 reading attached files: later
```

PR #394 (#238 undo of an unused AI-created task) is reused by A4. PR #389 (#228
live Wiki) provides the live-session signal A3 uses for "a page someone else is
typing in". #74's G-1 facts provide the "PR is ready" event for A9.

### Slices

#### A1 — Assistant identity, switches and settings

- **Scope.** One `owner_assistant` agent connection per person per workspace,
  created in the same transaction as the assistant's enablement, with its S6 policy
  initialised in that transaction. A settings record: approval mode (`act` default,
  `ask`), changes per run, background runs per day. Owner-only GET/PATCH with
  If-Match/CAS. The area mapping of AST-4 lives in one contracts module and compiles
  areas into S6 capability and entry IDs; *Only read* drops the operations.
- **Files.** `app/packages/contracts/src/assistant.ts` (areas, plain labels, mapping
  from `AGENT_MCP_ENTRIES`); `app/packages/core/src/assistant/` (settings use cases);
  `app/apps/server/src/assistant/routes.ts`; the enablement path in
  `app/packages/core/src/personal-runs/service.ts`.
- **Migration 0077** `assistant_settings`: add `owner_assistant` to the
  `compute_source` CHECKs of `agent_connections` and `agent_proposals`; table
  `assistant_settings` (workspace, owner, agent connection, approval mode CHECK,
  limits CHECK, version, timestamps); reverse file; semantic-footprint entry.
- **Tests.** App tests for AST-3.1, AST-3.3 (reuse S6 race helpers), AST-4.1
  (API part), AST-5.1 (API part); migration fresh/upgrade/reverse.
- **Depends on.** PR #390 merged (S6 overlay, migration 0061).

#### A2 — Run token and switch-derived tool list (inside #280)

- **Scope.** As #280 already specifies (run token, route checks, caps, hardened
  command, read-back), with two changes: the agent connection is A1's
  `owner_assistant`, and the run's exact tool list is computed from the switches
  (read tools of On areas in #280's first delivery step). The same token and list
  serve `server` runs in A6.
- **Files.** `app/apps/server/src/agent-connection/mcp-route.ts`, `context.ts`,
  `tool-registry.ts`; `app/packages/core/src/personal-runs/processor.ts`; the
  runtime adapter.
- **Migration.** None beyond A1.
- **Tests.** #280's acceptance list, plus: the listed tools equal the switch-derived
  list; turning a switch off mid-run refuses the next call (AST-4.4). The pinned
  real CLIs against the scripted model of PR #396 (`client-model-mock.ts`) show the
  `system/init` tool list matching, without an account.

#### A3 — Change log, run authority and "Ask me first"

- **Scope.** The `/mcp` effect path for a run token classifies each call as applied,
  waiting, suggestion or refused (AST-5 table and lists), records it in the change
  log in the same transaction, and returns a plain tool result ("Waiting for Ada's
  OK" or the applied object). Receipts record `owner_request`. Waiting changes:
  owner-only API to Apply, Apply all, Not now; re-execution with every check and
  version comparison; 7-day expiry. The conversation card "Wants to: …".
- **Files.** `app/apps/server/src/agent-connection/action-execution.ts`,
  `work-actions.ts`, `doc-actions.ts`, `map-actions.ts`, `conversation-actions.ts`;
  `app/packages/core/src/assistant/changes.ts`; `app/apps/web/src/assistant/`
  (card).
- **Migration 0078** `assistant_changes` (run, workspace, project, object type and
  id, operation, state CHECK `applied|waiting|applied_after_wait|not_now|expired|
  undone|refused`, prepared command JSON for waiting rows with a size CHECK, before
  and after versions, receipt, decided by and at).
- **Tests.** AST-5.2 to AST-5.5, AST-6.5; the live-Wiki case with PR #389's
  session signal faked.
- **Depends on.** A1, A2.

#### A4 — "Do it and tell me", result lines, Undo

- **Scope.** Result line on run end, Stop and failure; recovery posts it for a dead
  run; Undo per item and Undo all as compensating versioned writes per operation;
  "Changed since" refusal; Undo recorded. Stop refuses the next `/mcp` call.
- **Files.** `app/packages/core/src/assistant/undo.ts`; per-domain restore use cases
  in `work`, `docs`, `sketches`; `personal-runs/recovery.ts`; web result line.
- **Migration.** None (A3's table holds undo state).
- **Tests.** AST-6.1 to AST-6.4, AST-6.6; Playwright for the line and Undo.
- **Depends on.** A3; PR #394 for undoing a created task.

#### A5 — Typed suggestions

- **Scope.** Extend assistant proposals from a result to typed changes (task create
  and update, Wiki change, thought and link) for changes outside the owner's rights.
  Accepting executes the change as the accepting person with "drafted by Ada's
  assistant"; authority as #68 AC-7 and O-009.
- **Migration 0079** `assistant_typed_suggestions` (kind and payload columns with
  CHECKs on the existing proposal table, or a sibling table; decided in the slice).
- **Tests.** #68 AC-7 extended to each kind; a viewer and a non-owner cannot accept.
- **Depends on.** A3.

#### A6 — `server` tool loop

- **Scope.** The worker as an MCP client of `/mcp` with the run token; tool calling
  in each adapter of `@flux/agent-runtime`; reservation over the turn cap; the
  no-tools model shape; usage per request reconciled.
- **Files.** `app/packages/agent-runtime/` adapters,
  `app/packages/core/src/personal-runs/processor.ts` and `ports.ts`
  (`PersonalComputeRequest` gains tools and turns).
- **Migration.** None expected; reserve on #153 if run accounting needs a column.
- **Tests.** AST-8.1 to AST-8.3 with recorded fixtures per provider wire format;
  AST-3.2 parity with A2.
- **Depends on.** A2.

#### A7 — The assistant screen

- **Scope.** AST-10's one screen on computer and phone; the *Can* sentence shared
  with the hand-off picker (#347) and the agent page; Activity in the agent detail
  panel (#344); the New-tool line (AST-3). Grows with A3/A4 (waiting and result
  lines), A8 and A9 (their parts).
- **Files.** `app/apps/web/src/assistant/AssistantSettings.tsx` (replaced by the
  screen), `app/apps/web/src/assistant/assistant.css` (final tokens only), the
  hand-off and agent detail components.
- **Tests.** AST-10.1 to AST-10.6 in Playwright (Chromium and WebKit, both widths,
  light and dark); axe; AST-10.7 neutral visual review.
- **Depends on.** A1; #350's Settings layout (merged) and #347/#344 components.

#### A8 — Scheduled jobs

- **Scope.** AST-7 jobs: model, picker, plain-words schedule, cron under *More*,
  Home and project jobs, Run now, pause, edit, delete with Undo, history (last 20),
  missed and failure policy, the subscription note (AST-2.1), the text guard, the
  per-minute singleton tick and `singletonKey` per job.
- **Files.** `app/packages/core/src/assistant/jobs.ts`, `app/apps/worker/src/assistant/`
  (tick, as `proactive-comparison/index.ts`), routes, web part.
- **Migration 0080** `assistant_jobs` (owner, workspace, place, text, schedule kind and
  fields or cron, time zone, on, next and last run, failure streak, version) and
  `assistant_job_runs` (job, run, state, result line, times).
- **Tests.** AST-7.1 to AST-7.6, AST-7.9, AST-2.1 with a controlled clock and two
  workers.
- **Depends on.** A1, A4; #280 for `runtime` runs (the `server` engine works first).

#### A9 — Reactions

- **Scope.** The five curated events and their actions, events that name the owner
  only, debounce and caps, "draft a reply" always waiting, "tell me" folded into the
  Inbox item.
- **Files.** `app/packages/core/src/assistant/reactions.ts`; event taps in the work,
  conversation (mentions) and GitHub (G-1) modules; web part.
- **Migration 0081** `assistant_reactions` and `assistant_reaction_events` (dedupe key
  per object and window).
- **Tests.** AST-7.7, AST-7.8, AST-2.2 (every non-owner event starts nothing).
- **Depends on.** A8; #74 for the PR event (the other four events do not wait for it).

#### A10 — Subscriptions first

- **Scope.** AST-1: Connect AI order and labels (amend #277), the launcher question
  in `./flux up` and `./flux ai on`, host checks, the statement row.
- **Files.** `app/apps/web/src/` Connect AI section (#277 branch), `flux` launcher,
  `docs/operations/agent-runtime.md`.
- **Tests.** AST-1.1 to AST-1.4 (Playwright; launcher tests with a fake TTY and fake
  host checks).
- **Depends on.** #277; PR #385/#358 for the operator guide.

#### A11 — Reading attached files (later)

- A `flux_read_file` tool for text and PDF attachments with size caps, and the switch
  "Read attached files" (off by default). Needs its own short decision on formats and
  limits. Not required for the first delivery of edits.

### Acceptance criteria by slice

| Criteria | Slice |
| --- | --- |
| AST-1.1, AST-1.2 | #277 (then A10 for copy) |
| AST-1.3, AST-1.4 | A10 |
| AST-2.1, AST-2.4 | A8 (sign-in refusal on paid hosting: A10) |
| AST-2.2 | A9 |
| AST-2.3, AST-4.4, AST-4.2 (read part) | #280 (A2) |
| AST-3.1, AST-3.3 | A1 |
| AST-3.2, AST-4.2 (`server` part), AST-8.1–AST-8.3 | A6 |
| AST-4.1, AST-5.1 | A1 (API) and A7 (screen) |
| AST-4.3, AST-5.2–AST-5.5, AST-6.5, AST-9.2 | A3 |
| AST-6.1–AST-6.4, AST-6.6, AST-9.3 | A4 |
| AST-7.1–AST-7.6, AST-7.9, AST-7.10, AST-10.10 | A8 |
| AST-7.7, AST-7.8 | A9 |
| AST-9.1 | A3 (interactive), A6 (`server`), A8 (scheduled), A9 (reaction) |
| AST-10.1, AST-10.2, AST-10.4–AST-10.6, AST-10.8, AST-10.9, AST-10.11, AST-10.12 | A7 |
| AST-10.3 | A8 (scheduled) and A9 (reactions) |
| AST-10.7 | A4 and A7 |

## What stays unverified

- Every behaviour on a real Claude or ChatGPT subscription: plan limits, plan-limit
  messages, enforcement. Tests use fakes and the PR #396 mock model only.
- Whether the vendors would treat scheduled jobs on a hosted Flux as ordinary
  individual use. F-027 records the risk; it does not claim permission.
- Model quality of edits. Acceptance trials (AST revisit condition) measure undone
  changes; they are product trials, not release gates.

## Changes to open work

For the supervisor to apply to the issues. Criteria text is quoted as it should be
added; "replace" names the existing text to remove.

### #277 — One Connect AI entry (F-022 T2), branch `claude-hubert/277-connect-ai`

**Kind:** new acceptance criteria and a small change in its open branch before its PR.
Add:

- "**AST-1.1** With the runtime on, Settings → Agents and AI lists *Sign in with
  Claude* and *Sign in with ChatGPT* first, and *Use an API key* and the other
  providers only under *Other ways to connect* (Playwright, both widths)."
- "**AST-1.2** With the runtime off, the page shows one plain sentence and the API
  key choices; no sign-in button is shown (Playwright)."
- "Account rows use plain labels: 'Claude · your subscription', 'ChatGPT · your
  subscription', 'Anthropic Console · API billing', 'OpenAI · API key'. The F-022
  payer text stays as the longer line."
- "A folded *Which account should I use?* shows the two lines of F-027 AST-1 (Max and
  Team monthly API credits; personal Claude plans are for non-business use in the EU
  and Switzerland)."
- "No visible text on the page uses the words listed in F-027 AST-10.2."

### #280 — First owner-invoked run on Claude Code (F-022 T5), branch `claude-hubert/280-first-run`

**Kind:** contract amendment before implementation (the branch has no commits of its
own). It carries slice A2. Replace and add:

- Replace "An owner-consented agent connection per `runtime` connection
  (`compute_source = 'owner_runtime'`), created on the mode (b) consent screen.
  Migrations add the value to the CHECKs of `agent_connections` and
  `agent_proposals`." with: "The run uses the assistant's one `owner_assistant` agent
  connection (F-027 AST-3), created by slice A1 when the owner turns the assistant on.
  #280 adds no CHECK migration of its own."
- Replace "Read-only Flux MCP tools only, named exactly; no local tool." with: "The
  run's exact tool list is computed from the owner's switches (F-027 AST-4). In this
  first delivery step only the read tools of switched-on areas are listed (F-027
  question 18); effect tools follow in slices A3 and A4. No local tool."
- Replace "A background rule cannot select a `runtime` connection." with: "An O-007
  comparison rule cannot select a `runtime` connection (F-027 AST-2.3)."
- Add: "**AST-4.4** Turning a switch off during a run refuses that area's next read
  even with the run's existing token."
- Add: "**AST-4.2 (read part)** With *Read and edit the Wiki* off, the run lists no
  Wiki tool and a fake CLI calling `flux_get_doc` gets the S6 refusal."
- Add: "The pinned real `claude` against the scripted model of PR #396 shows a
  `system/init` tool list equal to the switch-derived list, without an account."
- Add: "Progress and end states use F-027 AST-10 copy: 'Working…', 'Done: …',
  'Paused: plan limit until …', 'Sign in to Claude again to keep using your
  assistant.'"
- Dependency: slice A1 (or #280 includes A1's minimal subset: the agent connection,
  its S6 policy and the switch-to-tool mapping).

### #281 — Codex in the agent runtime (F-022 T6)

**Kind:** new acceptance criteria. Add:

- "The Codex run uses the assistant's `owner_assistant` agent connection and the
  switch-derived exact `enabled_tools`; the JSONL check accepts exactly that list."
- "After slice A3: the F-027 AST-5.2 matrix (applied, waiting, suggestion, refused)
  passes with the fake Codex as with the fake Claude Code."
- "Plan-limit and sign-out states use the F-027 Journey 6 copy for ChatGPT."

### #68 — Owner-only in-product personal assistant runs (owner @Zamojski5)

**Kind:** scope note (no criterion removed). Add to the scope:

- "Direct changes follow F-027 AST-5 and AST-6 (accepted by founder direction
  2026-10-09, question 1). 'Consequential changes become proposal objects' now applies
  to changes outside the owner's rights (suggestions) and to the always-wait cases."
- "'Undo of done actions' is delivered by slice A4; AC-7 is extended to typed changes
  by slice A5; AC-8's browser check covers the AST-10 result lines."

### #316 / PR #390 — S6 switches

**Kind:** none for the PR. Slice A1 depends on its merge and reuses
`AGENT_MCP_ENTRIES`, the policy store and its race tests for `owner_assistant`
connections.

### #279 / PR #398 — Claude Code sign-in console

**Kind:** none for the PR. Every login method stays offered. The entry copy *Sign in
with Claude* and the surrounding plain copy are slice A10's.

### #58 / PR #391 — Background comparison

**Kind:** none (question 15). Its rule stays on API keys.

### #347 / PR #376 — Hand-off and Agents

**Kind:** follow-up criterion delivered in slice A7: "**AST-10.8** The *Can* sentence on
the assistant panel, the hand-off step 2 and the phone agent page is identical for the
same settings and changes when a switch changes." Until A7, the static text stays.

### Others

- **#238 / PR #394:** reused by A4 for undoing a created task. No change.
- **#343 / PR #387, #344 / PR #386, #350:** the result line, the waiting card, Activity
  and the assistant screen are delivered in A3, A4 and A7 with their components. No
  change to those PRs.
- **#228 / PR #389:** A3 reads its live-session presence for "a page someone else is
  typing in". No change.
- **#152 / PR #396:** its scripted model is the harness for A2 and #281. No change.
- **#358:** the operator guide documents the install question (A10).
- **#153:** reserve 0077–0081 before SQL, one per slice.
- **F-022 plan T7** ([two AI modes plan](research/2026-10-04-two-ai-modes-plan.md#t7--write-tools-and-proposals-in-runtime-runs-new-issue)):
  never opened as an issue; replaced by slices A2–A5.

## Reconsider when

- **2026-11-12**, when Anthropic's new Usage Policy takes effect: re-read it and the
  Claude Code legal page. Per question 17, Claude subscription sign-in stays on unless
  the text clearly covers a platform hosting the official binary; then it is switched
  off by default, owners are told and pointed to API keys (including Max and Team
  monthly API credits). Codex and API keys are unaffected.
- Anthropic or OpenAI publish text that forbids a product running the official CLI on
  a schedule for its subscriber, or that removes the official-binary carve-out: the
  affected client's background items switch off and the owner is told; runs the owner
  starts follow AIM-3's own revisit rule.
- Trials show unwanted changes undone in more than one run in ten under "Do it and
  tell me" (question 2).
- Owners ask for per-project approval choices or more reaction events with a concrete
  need.
- S6's overlay changes shape, or a file-reading tool is added (Files switch).
