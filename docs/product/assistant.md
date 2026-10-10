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
>
> **Later the same day**, after an independent UX review of this text
> ([review](../agents/evidence/f027-assistant/ux-review-2026-10-09.md), findings P1-1 to P3), Hubert answered the
> points that change decisions:
>
> | # | Question | Answer |
> | --- | --- | --- |
> | A | Make sign-in guided cards instead of a terminal? | Yes. Claude: "Open claude.ai and approve, then paste the code" with a one-tap [Paste]. ChatGPT: the code shown large with [Copy and open ChatGPT]. The terminal stays under "Show details". Add failure rows for "turn on device code sign-in in ChatGPT settings" and "code expired". A dated revision of AIM-3's console presentation; the mechanism is unchanged |
> | B | A private "You and your assistant" chat? | No. The assistant is used only in projects; O-008's rule stays. The agent page's "Message" and ⌘K from Home open the project conversation the person picks, or the last one used, with the assistant mentioned. They never lead nowhere |
> | C | One morning summary, written by the assistant? | Yes. It uses the Notifications time setting (#350, PR #370). It is a line under the Home greeting, never an Inbox item, and there is no second push |
> | D | A project-level manager choice over assistants' edits? | No. Only the assistant's owner decides. The truthful parts stay: the Agents tab's policy text describes the real rule, and message headers read "for Ada · Claude" so colleagues see which AI company receives their messages (O-008 §6) |
>
> He also directed: adopt the review's auto-join (P1-2: *Turn on* joins the projects
> you manage; elsewhere [Ask Jonas to add me]), its P2 and P3 fixes and its delight
> ideas that need no decision change.

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
| The sign-in console is a terminal (AIM-3) | Guided cards for Claude and ChatGPT; the terminal under *Show details*; the supervisor recognises only the sign-in URL and device code, in memory (AST-1) | A |
| Settings → Notifications' morning summary is plain text (#350) | The assistant may write it: one line under the Home greeting, the same one push, never an Inbox item (AST-7) | C |
| An agent works in a project once a manager adds it | *Turn on* adds the assistant to the projects its owner manages; elsewhere [ Ask Jonas to add me ] (AST-3) | Review P1-2, adopted |
| O-008 data boundary: "A run never reads … other projects" | The morning summary reads the owner's Inbox items and selected projects, reports only to the owner on Home and changes nothing; every other run is tied to one project (AST-7) | B, C |

Unchanged: F-019 owner-only invocation and payer; O-007's comparison rule on API keys
(question 15); O-009 (only people accept decisions); no vendor credential in Flux; no
fallback between accounts; AIM-3's isolation, hardening and redaction; S6's
restrictive overlay and live Off; F-016 except CO-1, F-018, F-024, F-026. The records this changes
carry a dated note "Revised 2026-10-09 by founder direction (F-027)":
[F-022](ai-modes.md), [F-020](model-providers.md), [O-008](personal-runs-compute.md),
[CO-1](mcp-cowork.md#connections-and-owner-authorized-autonomy--co-1) and the
[decision register](decisions.md).

## Safety rules at a glance

The full rules and their reasons are in AST-5 to AST-9.

- **It reaches only** the owner's current rights ∩ the assistant's project grant ∩
  the switches ∩ the selected projects ∩ the run's place.
- **Always waits for the owner, in both modes:** removing anything; changing things
  other people made or are responsible for; handing work to another person or their
  agent; changes beyond the run's limit (20, or 10 in the background). A change to a
  Wiki page someone else is typing in waits until they finish.
- **Never possible (no tool):** access changes of any kind, its own switches, jobs and
  reactions; accepting or superseding decisions; anything outside the run's place.
- **Outside the owner's rights:** a suggestion to whoever can decide it, sent only after
  the owner's tap.
- **It joins** the projects its owner manages; elsewhere a manager adds it.
- **Others always see** whose assistant it is, which AI company it uses, and that it
  is working; only the owner sees the detail and Stop.
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
- **Yours.** A task you are responsible for, or one you or your assistant created
  while nobody else is responsible for it; a Wiki page, map, thought or link you or
  your assistant created and nobody else has edited; a hand-off to your own agent.
  Everything else in a project is *other people's*. The person sees this as one
  sentence: "It asks before changing things other people made or are responsible
  for." (Revised 2026-10-09 after the UX review, P2-11.)
- **Scheduled job** (UI: *On a schedule*). Work the owner wrote down, run on a
  schedule in one project (AST-7).
- **Reaction** (UI: *When something happens*). "When [event] → [action]" for a small
  fixed set of events about the owner (AST-7). "Job" and "reaction" never appear in
  the UI.

## AST-1 — Subscriptions are the normal way to connect

The person signs in with the plan they already pay for. API keys stay available,
second.

- **Order on Connect AI** (Settings → Agents and AI, #277). When the instance has
  the runtime on, the first two choices are *Sign in with Claude* and *Sign in with
  ChatGPT*. They open the guided sign-in below. *Use an API key* and the other
  providers sit under *Other ways to connect*. When the runtime is off, the page says
  so in one sentence and shows the API key choices; nothing on Home or in the set-up
  sheet then promises "the plan you already have".
- **Guided sign-in** (founder answer A, 2026-10-09; a revision of the presentation of
  [AIM-3 *Sign-in as in a terminal*](ai-modes.md#sign-in-as-in-a-terminal), with the
  mechanism unchanged). The F-022 console still runs exactly the CLI's own login
  command in a PTY, and every login method stays available. The person sees a card;
  the terminal is folded under *Show details*.
  - **Claude** (`claude auth login`):

    ```text
    Sign in to Claude
    1. Open claude.ai and approve.        [ Open claude.ai ]
    2. Paste the code here.               [ Paste ]
    Flux never sees your password.        Show details ⌄
    ```

    *Open claude.ai* opens the sign-in URL the CLI printed. *Paste* reads the
    clipboard on tap and sends it to the CLI's own prompt, so it is one tap on a phone.
    A pending sign-in survives a PWA reload while the code is valid.
  - **ChatGPT** (`codex login --device-auth`):

    ```text
    Sign in to ChatGPT
    Enter this code on chatgpt.com:
          ABCD-1234
    [ Copy and open ChatGPT ]
    Flux notices when you're done.        Show details ⌄
    ```

    There is nothing to paste back; completion is read from `codex login status`.
  - **The one exception to "Flux never parses console frames"** (AIM-3 N2): the
    supervisor recognises only the sign-in URL and the device code in the CLI's output,
    in memory, to draw the card. Neither is persisted or logged. The authorization code
    the person pastes is relayed exactly as before.
  - Other methods (*Anthropic Console*, *SSO*, *API key*, *access token*) sit under
    *Other ways to sign in* on the same card, each as its own short card or, where no
    card fits, the terminal.
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
    organization uses those credits (about 5 minutes in the Claude Console)."
    (support 17154008, research §3.1)
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
- **AST-1.5** With the fake `claude`, the Claude card shows *Open claude.ai* with the URL
  the CLI printed and *Paste*; *Paste* sends the clipboard text to the CLI's prompt;
  the card shows "Signed in · <plan> · <masked account>" when `claude auth status`
  reports it; *Show details* shows the same terminal (Playwright, computer and phone).
- **AST-1.6** With the fake `codex`, the ChatGPT card shows the device code at large
  size with *Copy and open ChatGPT*, and completes without any paste (Playwright).
- **AST-1.7** The sign-in URL and the device code never appear in the database, logs,
  queue payloads or any stream other than the owner's card (seeded-value absence test,
  as AIM-3's).
- **AST-1.8** The fake CLIs' "device code sign-in is disabled" and "code expired"
  outputs show Journey 6's two sign-in rows with their buttons (Playwright).

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

The first time the owner turns on any background item with a subscription account,
this note shows once **per account**, not per item (UX review P2-13):

> Runs on your Claude plan while you're away. Anthropic may limit this use without
> notice. If your plan says no, it skips that time and tells you.

After that, each sheet shows one meta line, "Runs on your Claude plan". For a Claude
Max or Team plan the note adds one line with a link: "Your plan includes monthly API
credits. Use them for background work instead (about 5 minutes in the Claude Console)
›", which connects an API key from the owner's Console organization (a `server`
account, F-020).

### Acceptance (AST-2)

- **AST-2.1** The first background item on a subscription account shows the note
  above once for that account, before activation, and records the owner's Turn on with
  the note's version; later items on the same account show only the meta line (app
  test).
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
  control over whether the assistant works there.
- **Joining projects** (UX review P1-2, adopted by founder direction 2026-10-09).
  *Turn on* adds the assistant, as a contributor, to every project the owner manages,
  and to projects the owner creates later. The ready card says so ("It joins the
  projects you manage. In others, a manager adds it."), so no grant is hidden (S6). In
  a project where the owner is not a manager, the assistant offers [ Ask Jonas to add
  me ], which creates the existing Agents *Request* row ("Ada's assistant asks to
  join · Review ›") in that project's managers' Inbox. A manager's Allow is the
  ordinary project-grant route. Starter chips appear only where the assistant is a
  member.
- **Only in projects** (founder answer B). The assistant works in project
  conversations, threads, tasks, the Wiki and maps. There is no private chat with it
  and no DM runs; O-008's DM rule is unchanged. The agent page's *Message* and ⌘K
  "Ask my assistant…" outside a project open the project conversation the person
  picks, or the last one used, with "Ada's assistant" already mentioned in the
  composer. The one Home output is the morning summary line (AST-7, founder answer C).
- **Other people's view** (founder answer D; UX review P1-5). Every assistant message
  header reads "Ada's assistant · Agent · for Ada · Claude" (the account's company), so
  colleagues see where their messages go (O-008 §6). The assistant's panel, as others
  see it, says "Uses Claude through Ada's account. What it reads here goes to
  Anthropic." The project Agents tab's policy row states the real rule: "Agents read
  and propose; people accept. Assistants also edit for their owner, with Undo." Only
  the owner decides what the assistant may do; there is no project-level switch.
- **Someone else picks Ada's assistant in a hand-off** (UX review P2-10). Jonas's
  hand-off picker shows "Ada's assistant · for Ada · asks Ada first". Choosing it
  sends Ada one Needs-you item: "Jonas asks your assistant to do #10 · [ Allow ] [ Not
  now ]". Allow is Ada's own action, which starts the run (F-019). Jonas's `@` list
  never offers another person's assistant.
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
- **AST-3.4** *Turn on* creates a contributor project grant for the assistant in each
  project the owner manages and in none other; a non-manager's [ Ask Jonas to add me ]
  creates one join request for that project's managers, and a manager's Allow grants
  it (app test with two people). The manager's Inbox request names the target project
  and marks the assistant with monochrome Kreska and the Agent tag. Join questions
  use the project source and its canonical `/projects/:projectId/agents` destination;
  the marking comes from that destination and reason, never from matching display text.
- **AST-3.5** Jonas choosing "Ada's assistant" in a hand-off starts no run; it creates
  one Needs-you item for Ada, and only Ada's Allow starts the run (app test).
- **AST-3.6** Assistant messages show the account's company in their header for every
  viewer, and the Agents tab's policy row reads the sentence above (Playwright).

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
  - **Limits**: requests a day, changes per request, and for an API key the existing
    per-request and daily money caps;
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
4. **A Wiki page someone else is typing in** (an open live session, F-021): the
   change is **deferred**, not handed to the owner, because the conflict is with the
   typist, not the owner's consent (UX review P2-5). The line says "I'll edit
   *Suppliers* when Jonas finishes typing." When the session ends, the change applies
   if the page's version still matches; otherwise it becomes an ordinary waiting
   change. In "Ask me first" it waits for the owner as usual.
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
else when the owner is not a manager) becomes a **suggestion** for the person who can
decide it (#68 AC-7). It is prepared first and reaches that person only after the
owner's one tap (UX review P2-6): "Jonas owns #8. Suggest this change to him? [ Send to
Jonas ]". Then it is a Needs-you item for Jonas; when he accepts, the change is made by
him and records "drafted by Ada's assistant".

**Waiting changes**:

- Interactive runs show them in the run's message in the conversation where the owner
  asked; the "Waiting for you" part is shown only to the owner, and others see only
  what was done. Background runs put them in the owner's Inbox as one "Needs you" item
  per run.
- **Unanswered ones move to Inbox** (UX review P2-4): still undecided when the owner
  leaves that conversation, or 10 minutes after the run ends, they become one Needs-you
  item under Inbox *Questions*: "Your assistant wants to close 2 duplicates · [ Close ]
  [ Review ]".
- **The button is the object's own verb** (UX review P2-5): *Close*, *Remove*, *Send*,
  *Hand off*, *Rename*. *Apply* is used only for a mixed batch.
- Applying executes exactly the prepared change through the same executor, with every
  check repeated and the target's version compared. If the target changed since,
  that item says "Changed since you asked. Ask again" and nothing is applied.
- They are visible only to the owner, and expire after 7 days. An expired item leaves
  one line in Recent: "Expired: close 2 duplicates · Ask again".
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
  Apply), and expires after 7 days with the Recent line (clock-controlled test).
- **AST-5.6** An undecided waiting change becomes one Inbox *Questions* item when the
  owner leaves the conversation or 10 minutes after the run ends, with the object's
  verb on its button (Playwright with a fixed clock).
- **AST-5.7** A change to a page with another person's open live session is deferred
  with the "when Jonas finishes typing" line; it applies when the session ends if the
  version matches, and otherwise becomes a waiting change (app test with a faked
  session signal).
- **AST-5.8** A change outside the owner's rights reaches the other person only after
  the owner's *Send to Jonas* (app test: no Needs-you item for Jonas before the tap).

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
- **No silent edits.** When a run ends, stops or fails, one message lists every
  committed change (AST-10, *The run's message*). Crash recovery (#161) posts it for a
  run that died. A change without its log row cannot commit.
- **Conflicts while it works** (UX review P2-3). A write whose version check fails
  because a person or another agent changed the object is not retried; it becomes an
  item in the run's message: "Skipped #4: Jonas changed it while I worked · Open" (or
  "… Jonas's assistant changed it …").
- **Visible to everyone, controlled by the owner.** Everyone in the place sees "Ada's
  assistant is working…". Only the owner sees the detail ("reading 14 tasks") and Stop.
- **Queue** (one serial lane per owner). The owner's requests go before queued
  background runs. A request behind a running background run shows "Finishing your
  *Morning summary* first. Yours starts next. [ Stop the summary ]". A request behind
  another request shows "Next: 'turn this into tasks'. It starts when this one ends ·
  Cancel".
- **Undo** (field-level; UX review P2-7).
  - The message's **Undo** always means all of its changes; each item in the expanded
    list has its own Undo.
  - Undo restores only the fields the assistant changed, if those fields are untouched
    since: a rename can be undone after someone moved the task to In progress. It
    writes a new version: task fields, the earlier Wiki text as a new version, a
    thought's text, position or link. A created task follows #238 (PR #394). A created
    thought or link is removed by the owner's Undo. A created Wiki page, which the
    domain cannot remove today, moves to the owner's drafts: "Moved to your drafts".
  - If a changed field was edited again since, that item says "Changed since. Open it"
    and does nothing. A partial Undo says "Undid 5 changes. 2 changed since: #4, #7 ·
    Open".
  - The owner, or anyone who may edit the object, may Undo. The Undo is recorded
    ("Ada undid her assistant's change").
- **Limits.** Changes per request (20; 10 for background runs), requests a day (20,
  the F-022 default), background runs a day (24), turns (10), MCP result size (16 KiB
  per call, 64 KiB per run), answer size (16 KiB), wall clock (5 minutes; 10 for
  background runs). The owner may lower each. Each limit, when reached, is named in
  plain words (Journey 6).
- **Stop.** Stop (S13) marks the run stopping. `/mcp` refuses its next call at once.
  The engine is stopped as AIM-3 says. Changes already made stay and are listed:
  "Stopped after 3 changes · Undo".

### Acceptance (AST-6)

- **AST-6.1** A fake CLI asked to "add two tasks and update the probes page" creates
  two tasks and one Wiki version authored by the assistant agent, three change-log
  rows, and one result line "Done: added 2 tasks, edited 1 page" with Undo (app
  test plus Playwright).
- **AST-6.2** Undo restores the Wiki text as a new version and undoes both tasks. After
  a person changes a task's state, Undo of the assistant's rename of that task still
  works; after a person edits the same title, that item says "Changed since" and the
  message says "Undid N changes. 1 changed since: #…" (app test).
- **AST-6.3** Killing the worker after two committed changes and restarting it
  posts the result line with exactly those two changes (crash test, as #161).
- **AST-6.4** Stop during a run makes the next tool call fail with 403, keeps the
  committed changes and shows "Stopped after N changes" (app test).
- **AST-6.5** The 21st change in one run waits instead of applying (app test).
- **AST-6.7** A person's edit to #4 between the run's read and its write makes that
  write an item "Skipped #4: Jonas changed it while I worked"; nothing is retried (app
  test).
- **AST-6.8** A request made while a background run holds the lane shows the
  "Finishing your … first" line and runs before any other queued background run;
  others in the place see only "Ada's assistant is working…" (app test plus
  Playwright with two people).
- **AST-6.6** Receipts record the owner, the agent, the engine, the payer label and
  the run id; no receipt or log holds a vendor credential (seeded-secret absence
  test, AIM-3).

## AST-7 — Background work: on a schedule, and when something happens

Background work is the owner's own, configured only by the owner. The assistant
screen calls the two kinds **On a schedule** and **When something happens**; "job"
and "reaction" are internal words only (UX review P2-9). No background run creates,
changes or deletes a schedule, a reaction or a switch: no tool exists for it (as
Hermes: "Cron-run sessions cannot recursively create more cron jobs").

**Set up by asking** (delight, UX review). In an owner's own request, "@Ada's assistant
every weekday at 9 tell me what's blocked here" makes the assistant prepare a
schedule that is **off**: "Ready: *Blocked tasks*, weekdays 9:00 · [ Turn on ]". Only
the owner's tap turns it on. Background runs cannot prepare one.

### The morning summary

Founder answer C, 2026-10-09: **one** morning summary, written by the assistant.

- It is Settings → Notifications → *Morning summary* (#350, PR #370), with its time,
  quiet hours and its one push. Turning on "Let your assistant write your morning
  summary" (a starter on the assistant screen, or the same row in Notifications) makes
  the assistant write its text. Notifications then shows "Written by Ada's assistant ·
  Change ›".
- It appears as **one line under the Home greeting**, for example "Good morning, Ada.
  Jonas is waiting on you for #8, and 2 tasks are due today. ›". It is **never an
  Inbox item** and there is **no second push**.
- It reads the owner's Inbox items and the projects selected for the assistant,
  reports only to the owner, and changes nothing. It is the one assistant output on
  Home (founder answer B), and the one exception to O-008's "never reads … other
  projects" (revised O-008, 2026-10-09).
- If the run fails or the plan says no, the plain #350 summary goes out as before
  ("3 things wait in your inbox"): human work continues without AI, and nothing falls
  back to another account.
- It runs on the existing morning-summary tick (`MORNING_SUMMARY_JOB`), not on a second
  schedule.

### On a schedule

- **What.** A plain sentence the owner writes, for example "Every Friday at 16:00 list
  what we finished this week". The saved sentence is the instruction; what the run
  reads in the project is data (as Anthropic Routines treat fired text).
- **When.** A simple picker with plain words: *Every day*, *Weekdays*, *Every Monday*,
  *Every hour while I work*, each with a time (default 9:00). "While I work" is
  9:00–17:00 on weekdays and is editable. Under *More*, a five-field cron expression,
  shown back as plain words and the next three times ("Next: Tue 9:00, Wed 9:00, Thu
  9:00"). The owner's time zone applies.
- **Where.** One project (founder answer B: the assistant works only in projects). It
  reads and may change that project within the switches and the mode.
- **Output.** When something needs the owner, one Inbox item. Otherwise its result
  shows in the assistant's Recent. A project schedule may post its result in a chosen
  conversation (*More*); there, "Done: nothing to change" is never posted, and its
  messages fold into its previous one while no person has posted since (S8): "Ada's
  assistant · Hourly tidy · 6 changes today ⌄" (UX review P2-8).
- **Controls.** On/off, Run now, Edit, Delete (with Undo, F-026 principle 6). The row
  shows the schedule, the next run, and the last run with its result line.
- **Spacing and caps.** At most one run per hour per schedule: the minimum interval of
  Anthropic's own Routines (question 7). One run at a time per schedule. Runs a day per
  schedule (default 12) within the assistant's background runs a day (default 24).
- **Missed runs.** A run that could not start within 10 minutes of its time (Flux was
  off, or the owner's lane was busy) is skipped and recorded as "Skipped: Flux was off
  at 9:00" (question 8). Flux never runs a backlog. A paused schedule never catches up.
- **Failures.** A plan limit skips that time ("Skipped: plan limit until 14:00", or
  without a time when it is unknown). A sign-out or a vendor refusal fails the run.
  Three failures in a row pause the schedule and add one Inbox item: "Paused *Weekly
  review*: sign in to Claude again". Nothing falls back to another account.
- **Do it later.** When the plan limit stops an owner's request, the line offers [ Do
  it at 14:00 ] next to [ Remind me at 14:00 ]: a one-off schedule of the same request,
  made by the owner's tap.
- **Text guard.** A schedule whose text contains a token-shaped string (the AIM-3
  redaction patterns) is refused at save, so no secret is stored.

### When something happens

One plain sentence built from two pickers: **When** [event ▾] **→** [action ▾]. The
set is small and fixed. There is no generic rule builder.

| When (exact copy) | Then (exact copy) | What the run may do |
| --- | --- | --- |
| a new task is assigned to me | tell me · suggest a plan · plan it | "plan it" adds steps and a done-when list to that task (yours, so it applies in "Do it and tell me") |
| one of my tasks is blocked | tell me · suggest a fix · add next steps | "add next steps" adds steps to that task and what helps in its project, within the switches and the mode. (Not "unblock": the Inbox's *Unblock* button clears a blocker; UX review P3) |
| a result fails on my task | tell me · suggest a fix | — |
| someone mentions me | tell me · draft a reply | "draft a reply" opens the Inbox mention's existing *Reply*, prefilled and marked "Drafted by your assistant", with *Send*; it never posts on its own |
| a pull request is ready on my task | tell me · check it against the task | offered only in projects linked to GitHub; compares the PR facts Flux has (G-1: state, checks) with the task's done-when list and tells the owner |

- **Tell me** adds the assistant's short note to the owner's Inbox item for that
  object, or makes one item. It never sends a second notification (S22).
- **Suggest a fix / suggest a plan** prepares a suggestion for the owner; nothing
  changes until a person applies it.
- **Only events about the owner** (my task, assigned to me, mentions me), in projects
  selected for the assistant. Another person's event never starts the owner's run
  (AST-2.2).
- **Event content is data.** The blocker text, the mention or the PR facts reach the
  run marked as data. The owner's chosen action is the instruction.
- **Debounce and caps.** One run per object per 30 minutes. Runs a day per reaction
  (default 10) within background runs a day. Events beyond that are recorded as
  "Skipped: daily limit" in Recent.

### Engine

Reuse the worker and pg-boss, as O-007's comparisons and the morning summary do:

- A singleton `assistant.background.tick.v1`, scheduled every minute with a heartbeat
  (as PR #391 added for comparison ticks), selects due schedules (`next_run_at <=
  now`, on, not running) and queued reaction events. It computes the next time in the
  owner's time zone with the cron parser pg-boss already uses. The morning summary
  stays on #350's tick.
- It enqueues one personal run per firing with `singletonKey` = the schedule or
  reaction id, so one never overlaps itself. The run is an O-008 personal run of kind
  `scheduled`, `reaction` or `morning_summary`, with every consent, standing (F-024
  S4), access and cap recheck. A `runtime` run waits for the owner's lane (AIM-3) until
  the missed-run window ends, behind the owner's own requests (AST-6 *Queue*).
- Recovery reuses #161's sweep.

### Acceptance (AST-7)

- **AST-7.1** From the empty *On a schedule* part, tapping "Weekly review on Monday"
  and then *Turn on* (2 taps) creates an enabled schedule whose row shows "Every Monday
  at 9:00 · Next: Mon 9:00" in the owner's time zone (Playwright, clock fixed).
- **AST-7.2** With the clock moved past the time, exactly one run starts, posts its
  result, and the row shows "Last: Done …"; a second worker does not start a second
  run (app test, two workers).
- **AST-7.3** With the worker stopped from 8:55 to 9:20, no run happens for 9:00, the
  history shows "Skipped: Flux was off at 9:00", and the next run is the next one due
  (clock test).
- **AST-7.4** Three failing runs (fake CLI: signed out) pause the schedule and create
  exactly one Inbox item (app test).
- **AST-7.5** A background run calling any schedule, reaction or switch path is
  refused, and no such tool is listed; an owner's request may prepare a schedule that
  stays off until the owner taps *Turn on* (app test).
- **AST-7.6** The morning summary: with "Let your assistant write your morning
  summary" on, at the Notifications time exactly one run happens, Home shows its line
  under the greeting, no Inbox item is created, and exactly one push is sent; with the
  fake CLI failing, the plain #350 summary is sent instead (app test plus Playwright,
  fixed clock).
- **AST-7.7** "When one of my tasks is blocked → add next steps" fires for the owner's
  task and not for anyone else's; a second block of the same task within 30 minutes
  does not start a run; the blocker text reaches the run marked as data (app test).
- **AST-7.8** "Draft a reply" never posts: it opens the Inbox mention's *Reply*
  prefilled with "Drafted by your assistant", and only *Send* posts it (app test plus
  Playwright).
- **AST-7.9** A schedule text containing `sk-ant-` or a JWT-shaped string is refused at
  save with a plain message (app test).
- **AST-7.10** A cron expression firing more than once an hour is refused with "At most
  once an hour"; a valid one shows its next three times in words (app test and
  Playwright).
- **AST-7.11** A schedule posting into a conversation never posts "Done: nothing to
  change", and folds into its previous message while no person has posted since
  (Playwright).
- **AST-7.12** "a pull request is ready on my task" is offered only in projects linked
  to GitHub (Playwright).

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
  private sketches, other projects (except the morning summary, which reads the
  owner's selected projects and reports only to the owner) or file contents. Everything sent goes to the vendor under the
  owner's account settings (AIM-3 *Payer and data*).
- **Injected text.** Project content is untrusted input, including the content of the
  event that starts a reaction. The limits on reach, the always-wait list, the never
  list and Undo are the defence; Flux's brief tells the assistant to treat content
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
interaction and wording. It uses only components the frozen canvas already has: the
conversation stream, the composer with `@` and `/`, P5 notices with object rows, S8
folding, the working-agent card with Stop (S13), question cards with ready answers
(S14), the detail panel and sheets (S4), Inbox "Needs you" (S1), segmented controls
and switches (Settings · Appearance), toasts with Undo, the Home greeting, and
Kreska. The assistant screen and the run's message are an **addition to the frozen
canvas**, accepted with F-027; they must look native to it, and the independent UX
review of AST-10.12 examines them before the first A7 merge.

*Revised 2026-10-09 after the independent [UX review](../agents/evidence/f027-assistant/ux-review-2026-10-09.md)
and the founder's answers A–D: guided sign-in, joining projects, one morning summary on
Home, no private chat, truthful headers, one message per run, field-level Undo, and the
P2/P3 fixes.*

**Five promises the journeys keep.**

1. **One stream.** The assistant talks in the project's conversation with people and
   other agents, always marked Agent, "for Ada" and the AI company it uses.
2. **It shows its work.** Everyone sees that it is working; its owner sees what it is
   doing and can stop it. When it is done, one message says what changed.
3. **No surprises.** It does what was asked, asks when unsure, and never removes
   anything or changes things other people made or are responsible for without asking.
4. **Everything is undoable.** Every change has Undo, in the message, in Recent and on
   the object, and Undo touches only what the assistant changed.
5. **What it can do is one tap away.** Tap the assistant anywhere to see *Can*.

### Journey 1 — First meeting: connected and useful within a minute

Ada has just installed Flux and manages her project. She pays for Claude Max.

1. **Sees.** Home, with one card under "Continue where you left off", drawn with
   Kreska (a small moment, hidden when Kreska is off):
   > **Meet your assistant**
   > It works inside Flux with the Claude or ChatGPT plan you already have.
   > [ Set up ]   Not now

   When subscription sign-in is off on this Flux, the card says "It works inside Flux
   with your AI account" and promises no plan. The same entry exists in Settings →
   Agents and AI, and as "My assistant · Set up" in the composer's `@` list (first,
   then last once the card has been dismissed).
2. **Taps** *Set up*. A sheet (phone: half height; computer: the hand-off dialog's
   size) asks one question and lists only choices that work on this Flux:
   > **Which do you use?**
   > Claude — Pro, Max or Team
   > ChatGPT — Plus or Pro
   > Something else — an API key or your own model
3. **Taps** *Claude*. The guided card (AST-1):
   > **Sign in to Claude**
   > 1. Open claude.ai and approve.   [ Open claude.ai ]
   > 2. Paste the code here.          [ Paste ]
   > Flux never sees your password.   Show details ⌄

   On a Flux with more than one account, one line above it: "Whoever runs this Flux
   could technically reach your sign-in. Sign in only if you trust them." Ada approves
   on claude.ai, comes back, taps *Paste*. The card ends with "Signed in · Max plan ·
   h…@gmail.com". About 30 seconds.
4. **Sees** "Your assistant is ready", with Kreska in its agent colour:
   > It can read and edit tasks, the Wiki and maps, reply in conversations and
   > suggest decisions.
   > It does things and tells you what it did, with Undo. It asks before removing
   > anything or changing things other people made or are responsible for.
   > It joins the projects you manage. In others, a manager adds it.
   > Others in the conversation see what you ask it and what it does.
   >
   > Uses your Claude plan. Flux can't see its limits. What it reads goes to
   > Anthropic under your account's settings.
   > [ Turn on ]   Change what it can do

   **Taps** *Turn on*. The button is the consent; there is no extra check box. The
   assistant joins the projects Ada manages.
5. **Sees** the place she came from. Above the composer, three suggestions for this
   place, shown only where the assistant is a member:
   > ( Catch me up )  ( Turn this thread into tasks )  ( Tidy this project's tasks )
6. **Taps** *Tidy this project's tasks*. Her message appears in the stream as sent:
   "@Ada's assistant tidy this project's tasks". Everyone sees what she asked and whose
   assistant it is.
7. **Sees**, within a second, the working line at the assistant's place in the stream,
   in the sidebar card and in the phone header:
   > [Kreska thinking] **Ada's assistant** Agent · for Ada · Claude — Working… reading 14 tasks   [■ Stop]

   Jonas sees "Ada's assistant is working…", with no detail and no Stop.
8. **Sees**, about 20 seconds later, one message (not an answer plus a result line):
   > **Ada's assistant** Agent · for Ada · Claude
   > Renamed 3 tasks and added done-when to 4 · Undo
   > ◐ #3 ~~Probes~~ → Calibrate the probes at two depths
   > ○ #5 ~~Labels~~ → Print a label for each of the six beds
   > ○ #9 done-when added: "drawing received, depths agreed"
   > +4 more ⌄
   > #4 and #11 look like duplicates of #7. Jonas made them, so I'm asking first.
   > Waiting for you: close 2 duplicates · [ Close ] [ Review ]

   The prose line appears because it gives a reason. Only Ada sees the waiting row.
   Kreska shows its "waiting for you" expression on the message while it waits.
9. **Taps** *Close*. The header becomes "Renamed 3 tasks, added done-when to 4, closed
   2 duplicates · Undo".

**Measure:** from *Set up* to the run's message in at most 6 taps plus the vendor's
own sign-in, with no technical word on any Flux screen (AST-10.1, AST-10.2).

### Journey 2 — Everyday use in the messenger

A project conversation: Ada, Jonas, and Ada's Codex (her MCP agent on her laptop).

1. Jonas: "The probes arrive Thursday. Someone should calibrate them at two depths."
2. **Ada types** `@`. Her list shows **My assistant** first, then people, then agents;
   typing `@my` finds it too. Once chosen, the chip reads "Ada's assistant" for
   everyone. Other people's assistants are not in her list. She writes "@Ada's
   assistant make a task for the calibration and put it on the sensors map".
3. Everyone sees "Ada's assistant is working…"; Ada sees the detail and Stop.
4. **The message:**
   > **Ada's assistant** Agent · for Ada · Claude
   > Made a task from Jonas's message and added 1 thought on the Map · Undo
   > ○ #12 Calibrate the probes at two depths · Ada
   > ◇ Map · Calibration at two depths

   Tapping #12 opens it in the detail panel; tapping the thought opens the Map with it
   highlighted.
5. **In a thread.** Ada's reply in the thread of her assistant's message addresses it
   without `@`. A mention in any thread answers in that thread.
6. **Jonas sees** the same message, and Undo too, because he may edit those objects:
   an assistant's change is an ordinary edit.
7. **Collisions are explained.** If Jonas edits #12 while the assistant works on it,
   that item reads "Skipped #12: Jonas changed it while I worked · Open".
8. **One thing at a time.** A second request during a run shows "Next: 'turn this
   into tasks'. It starts when this one ends · Cancel".
9. **From anywhere.** ⌘K → "Ask my assistant…", and the agent page's **Message**, open
   the current project conversation with "Ada's assistant" already mentioned. Outside
   a project (Home, Inbox) they ask "In which conversation?" with the last one used
   first, then open it the same way. They never lead nowhere (founder answer B).
10. **Phone.** The composer stays at the bottom; the working line sits in the
    conversation header with Stop (no tab bar in a conversation). Sent offline, the
    message shows "Sends when you're back", as photos do.

### Journey 3 — Trust: always clear, never a surprise

- **What it can do is one tap away.** Tapping the assistant's name or Kreska on any
  message opens its panel (phone: sheet) with **Now**, **Recent** (each with Undo) and
  **Can**, generated from the switches:
  > Can: read and edit tasks, the Wiki and maps, reply in conversations, suggest
  > decisions. Asks before removing anything or changing things other people made or
  > are responsible for. Can't accept decisions or invite people.

  The same sentence appears in the hand-off picker's step 2 (S12). Others see one more
  line: "Uses Claude through Ada's account. What it reads here goes to Anthropic." The
  panel's ⋯ menu has *Pause my assistant* and *Manage ›*.
- **The project tells the truth.** The Agents tab's policy row reads "Agents read and
  propose; people accept. Assistants also edit for their owner, with Undo."
- **Why did it do that?** Every changed object's Activity says "Ada's assistant renamed
  this · asked by Ada: 'tidy this project's tasks' · Undo".
- **It asks when unsure.** Instead of guessing, it posts a question card with ready
  answers (S14):
  > Merge #4 into #7, or keep both?   [ Merge ] [ Keep both ] [ I'll look ]

  An answer starts a short follow-up run with the original request and the answer; no
  transcript is kept (AIM-3).
- **It waits for people who are typing.** "I'll edit *Suppliers* when Jonas finishes
  typing."
- **Switches take effect at once**, even inside a running request (AST-4.4).
- **Undo touches only what it changed.** Undoing a rename works after someone moved the
  task to In progress; only an edit to the same field stops it ("Changed since. Open
  it").
- **Screen readers** hear the working line and the message politely: "Ada's assistant
  finished: renamed 3 tasks".

### Journey 4 — Background: the morning summary and a helpful reaction

**The morning summary** (founder answer C). On the assistant screen, the empty *On a
schedule* part offers ( Let your assistant write your morning summary ). Ada **taps**
it: a sheet shows "Morning summary · 8:30, from Notifications · written by your
assistant", and the account note once (AST-2). She **taps** *Turn on*. Two taps.

Next morning at 8:30, Home shows one line under the greeting, and the one push of
#350 carries the same text:
> Good morning, Ada. Jonas is waiting on you for #8, and 2 tasks are due today. ›

Nothing is added to the Inbox. Each name in the line opens its object.

**When something happens.** Ada turned on "When one of my tasks is blocked → add next
steps". Jonas marks #8 Blocked: "waiting for the probe drawing from the supplier".
Within a minute the Inbox item for #8 shows the assistant's note under the blocker:
> **Ada's assistant** added a step: "Email Anna at SensorCo for the drawing (contact on
> the Wiki page *Suppliers*)" · Undo

The task's Activity says "Ada's assistant added a step · when #8 was blocked · Undo".
Jonas's blocker text was read as data, never as an instruction.

**Set up by asking.** "@Ada's assistant every Friday at 16:00 list what we finished
this week" gets "Ready: *Weekly wins*, Fridays 16:00 · [ Turn on ]". It stays off until
Ada taps.

### Journey 5 — Handing off between your assistant and your agents

1. Ada: "@Ada's assistant ask my Codex to review the plan in #8".
2. The assistant hands #8 to **Ada's own** Codex as a review (allowed: her agent):
   > Asked your Codex to review #8 · Undo
   > Codex is offline. It starts when *Desk laptop* is on.
3. When Codex (on Ada's laptop, over MCP) picks it up at its next checkpoint, #8's
   Activity shows "Codex started the review"; Codex posts its review in #8 like any
   agent.
4. If Ada's Codex may not take reviews in this project: "Your Codex can't take reviews
   here yet · [ Allow ]", and *Allow* opens the hand-off's step 2 for Codex.
5. Asking for **Jonas's** Codex: "Jonas has to agree to hand #8 to his Codex. [ Ask
   Jonas ]".
6. **Jonas picks Ada's assistant** in his own hand-off: his picker shows "Ada's
   assistant · for Ada · asks Ada first". Ada gets one Needs-you item: "Jonas asks your
   assistant to do #10 · [ Allow ] [ Not now ]". Only her Allow starts it (F-019).
   Agents never start each other.

### Journey 6 — Failure and limits, in plain words

Each failure says what happened, whether anything changed, and offers one next step
in the same line. Nothing ever falls back to another account on its own.

| Situation | What Ada sees (exact copy) | Next step |
| --- | --- | --- |
| Plan limit, reset time known | "Paused: your Claude plan's limit is reached until 14:00." | [ Do it at 14:00 ] [ Remind me at 14:00 ]; and, if she has another account, [ Use OpenAI key this time ] |
| Plan limit, reset unknown | "Paused: your Claude plan's limit is reached. Claude didn't say until when." | [ Try again later ] |
| Vendor not answering, nothing done | "Claude isn't answering right now. Nothing was changed." | [ Try again ] |
| Vendor stopped after some changes | "Claude stopped answering after 2 changes · Undo" | [ Finish it ] (continues with the list of changes already made, so nothing is redone) |
| Time limit | "I stopped after 5 minutes, the limit for one request. I made 4 changes · Undo" | [ Continue ] |
| Change limit | "I made 20 changes, the most for one request. 6 more wait for you." | [ Review ] |
| Daily limit | "That's 20 requests today, your daily limit." | [ Change the limit ] |
| Signed out or expired | "Sign in to Claude again to keep using your assistant." | [ Sign in ] |
| Vendor refused | "Claude refused this request. Nothing was changed." | [ Edit request ] |
| A switch is off | "I can't edit the Wiki: that's switched off for me." | [ Allow Wiki edits and try again ] |
| Not in the project, Ada manages it | "I'm not in this project yet." | [ Add my assistant here ] |
| Not in the project, Ada doesn't manage it | "I'm not in this project yet. A manager can add me." | [ Ask Jonas to add me ] → "Asked Jonas to add me. I'll do this when he does." |
| Outside her rights | "Jonas owns #8. Suggest this change to him?" | [ Send to Jonas ] |
| Someone changed it meanwhile | "Skipped #4: Jonas changed it while I worked." | [ Open ] |
| Subscription sign-in off on this Flux | "This Flux doesn't allow signing in with a subscription yet." | [ Tell whoever runs Flux ] [ Use an API key instead ] |
| No free place on this Flux | "All assistant places on this Flux are in use." | [ Tell whoever runs Flux ] [ Use an API key instead ] |
| ChatGPT device code is off | "ChatGPT needs one setting first: turn on *device code sign-in* in ChatGPT → Settings → Security." | [ Open ChatGPT settings ] |
| Sign-in code expired | "That code has expired. Codes work once, for a few minutes." | [ Get a new code ] |
| A schedule failed three times | Inbox: "Paused *Weekly review*: sign in to Claude again." | [ Sign in ] |
| Changed before Ada decided | "Changed since you asked. Ask again" (waiting) · "Changed since. Open it" (Undo) | [ Open ] |
| A waiting change expired | Recent: "Expired: close 2 duplicates." | [ Ask again ] |
| Stopped | "Stopped after 3 changes · Undo" | — |
| Offline | "Sends when you're back" (a request) · "Offline" (on Stop, Undo, Close) | — |

*Tell whoever runs Flux* sends one Needs-you item to the workspace's owners: "Ada would
like to use her Claude plan here. Whoever runs this Flux turns it on with `./flux ai
on`."

### The assistant screen

Settings → Agents and AI → *Ada's assistant ›* (the existing row), the panel's *Manage
›*, opens one screen: a header and three parts, then Recent and More. The phone shows
the same screen as a full page with Back; sheets open with a grabber (half height,
full when dragged). Kreska appears in its agent colour, which Settings → Agents and AI
may use.

**Why each visible control exists.**

| Control | Why it must be visible |
| --- | --- |
| On/off for the assistant | O-008 consent and pause: one place to stop everything |
| Account row | AIM-4 explicit payer: who pays is always visible |
| Approval choice | Founder question 2 |
| Five switches | Founder question 10: what it may read and edit |
| *On a schedule* | Founder questions 5, 7, 8 and answer C (the morning summary) |
| *When something happens* | Founder question 6 |
| Recent | No silent edits: every change and its Undo must be findable |
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
│                    │ │ It asks before removing anything or changing things   │ │
│                    │ │ other people made or are responsible for.             │ │
│                    │ ├───────────────────────────────────────────────────────┤ │
│                    │ │ Read and edit tasks                               [●] │ │
│                    │ │ Read and edit the Wiki                            [●] │ │
│                    │ │ Read and edit maps                                [●] │ │
│                    │ │ Read conversations and reply                      [●] │ │
│                    │ │ Read decisions and suggest new ones               [●] │ │
│                    │ └───────────────────────────────────────────────────────┘ │
│                    │ On a schedule                                             │
│                    │ ┌───────────────────────────────────────────────────────┐ │
│                    │ │ Morning summary · written by your assistant       [●] │ │
│                    │ │ Every day at 8:30 (Notifications) · Home              │ │
│                    │ ├───────────────────────────────────────────────────────┤ │
│                    │ │ Weekly review                                     [●] │ │
│                    │ │ Every Monday at 9:00 · Community garden sensors       │ │
│                    │ │ Next: Mon 9:00 · Last: Done, 2 things need you      › │ │
│                    │ ├───────────────────────────────────────────────────────┤ │
│                    │ │ + Add                                                 │ │
│                    │ └───────────────────────────────────────────────────────┘ │
│                    │ When something happens                                    │
│                    │ ┌───────────────────────────────────────────────────────┐ │
│                    │ │ When one of my tasks is blocked → add next steps  [●] │ │
│                    │ │ Last: Tue 14:02 · added a step to #8                › │ │
│                    │ ├───────────────────────────────────────────────────────┤ │
│                    │ │ + Add                                                 │ │
│                    │ └───────────────────────────────────────────────────────┘ │
│                    │ Recent · today: 4 changes                               › │
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
  It asks before removing anything or
  changing things other people made or
  are responsible for.
  Read and edit tasks                    [●]
  Read and edit the Wiki                 [●]
  Read and edit maps                     [●]
  Read conversations and reply           [●]
  Read decisions and suggest new ones    [●]

On a schedule
  Morning summary · by your assistant    [●]
  Weekly review · Mondays 9:00           [●]
  + Add

When something happens
  My task is blocked → add next steps    [●]
  + Add

Recent · today: 4 changes                 ›
More                                      ›
```

**Empty parts** offer one-tap starters (each opens the prefilled sheet; *Turn on* is
the second tap):

```text
On a schedule
  Nothing yet. Try one:
  ( Let your assistant write your morning summary )  ( Weekly review on Monday )
  + Add

When something happens
  Nothing yet. Try one:
  ( Tell me when a task is blocked )  ( Plan tasks assigned to me )
  + Add
```

**On a schedule** sheet (panel on the computer, full sheet on the phone):

```text
On a schedule                                                       ✕
What should it do?
┌───────────────────────────────────────────────────────────────────┐
│ List what we finished this week                                    │
└───────────────────────────────────────────────────────────────────┘
When   [ Every day | Weekdays | Every Monday | Every hour while I work ]
At     [ 16:00 ▾ ]   on [ Friday ▾ ]
Where  [ Community garden sensors ▾ ]
Next: Fri 16:00, next Fri 16:00, …
More ›                   (cron expression, post the result in a conversation)
Runs on your Claude plan
                                                  [ Cancel ] [ Turn on ]
```

**When something happens** sheet:

```text
When something happens                                              ✕
When  [ one of my tasks is blocked ▾ ]
Then  [ add next steps ▾ ]
In    [ all my projects ▾ ]
It reads the task and its project, and tells you what it did.
Runs on your Claude plan
                                                  [ Cancel ] [ Turn on ]
```

**The assistant's panel** (the agent page on the phone, which already has Now, Recent,
Can and *Message*):

```text
Ada's assistant  Agent  for you · in Flux · Claude                ⋯  ✕
Now
  Working… adding tasks in Community garden sensors        [■ Stop]
  (when idle: Next: morning summary tomorrow 8:30)
Recent
  Done: renamed 3 tasks, added done-when to 4 · asked by you  11:04  Undo
  Morning summary written                                     08:30  Open
  Added a step to #8 · when #8 was blocked                    Tue    Undo
  Waiting for you: close 2 duplicates                         Mon    Close
Can
  Read and edit tasks, the Wiki and maps, reply in conversations,
  suggest decisions. Asks before removing anything or changing things
  other people made or are responsible for. Can't accept decisions or
  invite people.
[ Message ]
⋯  Pause my assistant · Manage ›
```

### The run's message, and the one line everywhere else

**In the conversation, one message per run** (UX review P2-1; principle 3, "Everything
belongs to its message"):

- It opens with a P5-style header naming what changed, with **Undo** (all of it):
  "Renamed 3 tasks and added done-when to 4 · Undo".
- Up to three object rows follow (state glyph, number, title, owner; a map thought or
  Wiki page row), then "+4 more ⌄".
- Expanded rows show before and after: "~~Probes~~ → Calibrate the probes at two
  depths". A Wiki edit shows "2 paragraphs changed · See changes". *Review* shows the
  same diff.
- Prose appears only when it adds a reason or a question. There is no second result
  line repeating it.
- The waiting row is shown only to the owner.

**Elsewhere** (Inbox, the sidebar's working-agent card, the panel's Recent, the
project's Agents row, Home) the run is one line:

| State | Line (exact copy pattern) |
| --- | --- |
| Working | Owner: "Working…" or "Working… reading 14 tasks" (with Stop). Others: "Ada's assistant is working…" |
| Queued | "Next: 'turn this into tasks'. It starts when this one ends · Cancel" |
| Behind a background run | "Finishing your *Morning summary* first. Yours starts next. [ Stop the summary ]" |
| Done | "Done: added 2 tasks, edited 1 page · Undo" |
| Done, nothing to change | "Done: nothing to change" (never posted into a shared conversation) |
| Waiting | "Waiting for you: close 2 duplicates · Close" (the object's verb; *Apply* only for a mix) |
| Deferred | "I'll edit *Suppliers* when Jonas finishes typing." |
| Suggested | "Jonas owns #8. Suggest this change to him? · Send to Jonas" |
| Skipped | "Skipped #4: Jonas changed it while I worked" / "Skipped: Flux was off at 9:00" / "Skipped: daily limit" |
| Stopped | "Stopped after 3 changes · Undo" |
| Paused | "Paused: plan limit until 14:00" / "Paused: sign in to Claude again" |
| Undone | "Undone by Ada" / "Undid 5 changes. 2 changed since: #4, #7 · Open" |

Counts use the final design's object words: task, page, thought, link, map, message,
decision, result.

### Delight details

- **Suggestions that fit the place**, only where the assistant is a member. In a
  conversation: "Catch me up", "Turn this thread into tasks", "Tidy this project's
  tasks". On the Map: "Group these thoughts". In the Wiki: "Draft a page from this
  thread". Shown until the person has used the assistant three times there, then only
  on `@`.
- **The Home greeting is the assistant's** (founder answer C): the single most visible
  daily proof that it works.
- **The working line tells the truth** from progress events: "reading 14 tasks",
  "editing *Suppliers*". It never shows invented progress.
- **One run, one message**, with object rows and before/after.
- **Undo is calm.** Undo in the message, `Z` on the computer, the toast pattern, and
  field-level, so it rarely refuses.
- **Results land where you asked**; background results reach the Inbox only when they
  need you.
- **Kreska** thinks while it works, wears its "waiting for you" expression while a
  change waits, and has a small done moment after a first success; all of it
  disappears when the Kreska setting is off.
- **Fix it in place**, in one tap: *Allow Wiki edits and try again*, *Sign in*, *Do it at
  14:00*, *Ask Jonas to add me*.
- **Set up by asking**: a schedule prepared from a request, turned on by one tap.
- **"Next:"** in the panel's Now when idle: "Next: morning summary tomorrow 8:30".
- **Its voice.** Short, first person, concrete ("I added…", "I'm asking first because
  …"). No apologies, no filler, no exclamation marks, no emoji.

### Anti-patterns avoided on purpose

- A separate "Ask AI" button or sparkle icon (F-026 §8 removes separate ask buttons;
  `@` and `/` are the way in).
- Confirmation dialogs for ordinary changes ("Are you sure?"); Undo replaces them.
- Permission matrices, scope names, grant words, "job" or "reaction" in the UI.
- An answer that repeats its own result line, or describes changes in prose without
  showing the objects.
- Silent background edits; a notification for every background run; a second morning
  summary or a second push.
- Catch-up storms after downtime.
- Posting as the owner. The assistant always speaks as itself, "for Ada", naming its AI
  company.
- Buttons that lead nowhere (*Message* and ⌘K always open a conversation).
- Agents that start each other in loops.
- Fake progress bars, gradient orbs or robot glyphs (F-026 §8).
- Interrupting people the owner did not choose to contact (suggestions to others need
  the owner's tap).
- Hiding who pays, or where colleagues' messages go.

### Acceptance (AST-10)

- **AST-10.1** On a fresh account, from *Set up* on Home to the run's message for a
  suggestion takes at most 6 taps plus the vendor's own sign-in steps (Playwright with
  the fake CLI, computer and phone).
- **AST-10.2** No Flux screen in Journeys 1–6, the assistant screen, its sheets or any
  run message or line shows: scope, grant, MCP, token, capability, execute, runtime,
  transport, OAuth, policy, proposal, payload, slot, job, reaction, cron (except inside
  a schedule's *More*), or API (except in "API key", "API credits" and an account name
  the owner chose) (Playwright scans visible text, light and dark, both widths).
- **AST-10.3** From an empty *On a schedule* part, "Let your assistant write your
  morning summary" is on in 2 taps; from an empty *When something happens* part, "Tell
  me when a task is blocked" is on in 2 taps (Playwright).
- **AST-10.4** Turning the assistant on and allowing Wiki edits takes at most 3 taps
  from Settings → Agents and AI on an account already signed in (Playwright).
- **AST-10.5** The owner's `@` list shows "My assistant" first; the chosen chip reads
  "Ada's assistant" for every viewer; nobody's list offers another person's assistant
  (Playwright with two people).
- **AST-10.6** The working line appears within 1 second of sending (fake engine);
  others see only "Ada's assistant is working…"; Stop is reachable by keyboard and by
  a 44 px target (Playwright with two people).
- **AST-10.7** Every change in every journey appears in Recent with Undo, and Undo
  there behaves as AST-6 (Playwright plus app test).
- **AST-10.8** The *Can* sentence on the assistant panel, the hand-off step 2 and the
  phone agent page is identical for the same settings and changes when a switch
  changes (Playwright).
- **AST-10.9** Each Journey 6 row shows its exact copy and its next-step button
  (component test per state, plus one Playwright path each for plan limit, signed
  out, switch off and not in the project).
- **AST-10.10** *Message* on the agent page and ⌘K "Ask my assistant…" open the current
  project conversation, or, outside a project, the picked or last-used one, with "Ada's
  assistant" mentioned in the composer; neither ever opens an empty or private place
  (Playwright).
- **AST-10.11** The screens render at 1440 × 900 and 390 × 844 in light and dark with
  final-design tokens only; switches have `role="switch"` and `aria-checked`; the
  approval choice is a radio group with arrow keys; targets are at least 44 px; focus
  order follows the visual order; the working line and the run's message are announced
  through a polite live region (axe plus keyboard and screen-reader text test).
- **AST-10.12** An independent UX review of Journeys 1–6 on the running application
  with demo data, and a neutral visual review (F-026 §9), pass before the first A7
  merge.
- **AST-10.13** A run produces one message: a header with Undo, at most three object
  rows and "+N more", before and after in the expanded rows, prose only with a reason
  or a question, and no separate result line (Playwright).
- **AST-10.14** *Pause my assistant* in the panel's ⋯ menu pauses everything in 2 taps
  from any place where the assistant appears (Playwright).
- **AST-10.15** Offline, a request shows "Sends when you're back" and sends on
  reconnect once; Stop, Undo and Close show "Offline" instead of failing (Playwright
  offline emulation).

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
A12 guided sign-in cards (after PR #398; ChatGPT after #281)            independent
```

PR #394 (#238 undo of an unused AI-created task) is reused by A4. PR #389 (#228
live Wiki) provides the live-session signal A3 uses for "a page someone else is
typing in". #74's G-1 facts provide the "PR is ready" event for A9.

### Slices

#### A1 — Assistant identity, switches and settings

**Persistence seam clarification (2026-10-10, #402).** The drawn Agents Request row has no
project-join persistence backend in current main. A1 supplies its durable pending request
under migration 0077 and uses the existing project-grant use case for a manager Allow,
with one Needs-you notification for current project managers. A request creates no authority;
the caller must retain project read access, and neither projects nor managers outside those
rights are revealed. The accepted AST-3.4 behavior and owner/manage boundaries are unchanged.
An upgrade backfills already enabled owners from their existing `personal_run_agents`
with a read-only S6 snapshot and their existing explicit project grants. It adds no
project grant or effect capability. Fresh explicit Turn on retains the accepted
read-and-edit defaults; older owners allow new effects explicitly.

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
- **Joining.** *Turn on* creates contributor project grants for the assistant in the
  projects the owner manages (and later in projects the owner creates), through the
  existing project-grant route; the join request for other projects reuses the Agents
  *Request* row (AST-3.4).
- **Tests.** App tests for AST-3.1, AST-3.3 (reuse S6 race helpers), AST-3.4, AST-4.1
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
- **Tests.** AST-4.3, AST-5.2 to AST-5.8, AST-6.5, AST-6.7, AST-9.2; the live-Wiki
  deferral with PR #389's session signal faked; waiting changes moving to Inbox with a
  fixed clock.
- **Depends on.** A1, A2.

#### A4 — "Do it and tell me", the run's message, Undo, queue

- **Scope.** One message per run (header with Undo, object rows, before and after) on
  run end, Stop and failure; recovery posts it for a dead run; field-level Undo per item
  and for the whole message as compensating versioned writes per operation; "Changed
  since" and partial-Undo copy; Undo recorded; "Skipped #4: … changed it while I
  worked" items; Stop refuses the next `/mcp` call; the owner's lane queue (owner
  requests before background runs) with its lines.
- **Files.** `app/packages/core/src/assistant/undo.ts`; per-domain restore use cases
  in `work`, `docs`, `sketches`; `personal-runs/recovery.ts`; the run message
  component (with #343's P5 notice rows).
- **Migration.** None (A3's table holds undo state).
- **Tests.** AST-6.1 to AST-6.4, AST-6.6, AST-6.8, AST-9.3, AST-10.13; Playwright for
  the message and Undo.
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

#### A7 — The assistant screen and the journeys

- **Scope.** AST-10's one screen on computer and phone; the panel (Now, Recent, Can,
  *Message*, ⋯ *Pause my assistant*); the *Can* sentence shared with the hand-off
  picker (#347) and the agent page; Jonas's hand-off to Ada's assistant as a Needs-you
  item for Ada (AST-3.5); message headers with the AI company and the Agents tab policy
  row (AST-3.6); *Message* and ⌘K opening a conversation with the assistant mentioned;
  the Home set-up card and the `@` entry; suggestions only where the assistant is a
  member; offline states; the New-tool line (AST-3). Grows with A3/A4 (waiting and
  run messages), A8 and A9 (their parts).
- **Files.** `app/apps/web/src/assistant/AssistantSettings.tsx` (replaced by the
  screen), `app/apps/web/src/assistant/assistant.css` (final tokens only), the
  hand-off, agent panel, composer and Home greeting components.
- **Tests.** AST-3.5, AST-3.6, AST-4.1 and AST-5.1 (screen), AST-10.1, AST-10.2,
  AST-10.4 to AST-10.6, AST-10.8 to AST-10.11, AST-10.14, AST-10.15 in Playwright
  (Chromium and WebKit, both widths, light and dark); axe; AST-10.12 independent UX and
  neutral visual review.
- **Depends on.** A1; #350's Settings layout (merged) and #347/#344/#343 components.

#### A8 — On a schedule, and the morning summary

- **Scope.** AST-7 *On a schedule*: model, picker, plain-words schedule, cron under
  *More*, one project per schedule, Run now, pause, edit, delete with Undo, history
  (last 20), missed and failure policy, *Do it at 14:00*, schedules prepared from a
  request (off until the owner's tap), the account note once per account (AST-2.1), the
  text guard, folding in a shared conversation, the per-minute singleton tick and
  `singletonKey` per schedule. **The morning summary**: "Let your assistant write your
  morning summary" on #350's Notifications row and tick, the Home greeting line, the
  one push, the plain fallback.
- **Files.** `app/packages/core/src/assistant/jobs.ts`, `app/apps/worker/src/assistant/`
  (tick, as `proactive-comparison/index.ts`), `app/apps/worker/src/jobs/morning-summary.ts`,
  routes, Settings → Notifications row, Home greeting, web part.
- **Migration 0080** `assistant_jobs` (owner, workspace, project, text, schedule kind and
  fields or cron, time zone, on, prepared-off flag, next and last run, failure streak,
  version), `assistant_job_runs` (job, run, state, result line, times), and the
  morning summary's "written by the assistant" flag on the owner's notification
  settings.
- **Tests.** AST-2.1, AST-2.4, AST-7.1 to AST-7.6, AST-7.9 to AST-7.11, AST-10.3 (first
  half), AST-9.1 (scheduled) with a controlled clock and two workers.
- **Depends on.** A1, A4; #280 for `runtime` runs (the `server` engine works first);
  #350's morning summary (merged in PR #370).

#### A9 — When something happens

- **Scope.** The five curated events and their actions ("add next steps", not
  "unblock"), events about the owner only, debounce and caps, "draft a reply" opening
  the Inbox mention's *Reply* prefilled, "tell me" folded into the Inbox item, the PR
  event only in GitHub-linked projects.
- **Files.** `app/packages/core/src/assistant/reactions.ts`; event taps in the work,
  conversation (mentions) and GitHub (G-1) modules; the Inbox mention reply; web part.
- **Migration 0081** `assistant_reactions` and `assistant_reaction_events` (dedupe key
  per object and window).
- **Tests.** AST-2.2 (every non-owner event starts nothing), AST-7.7, AST-7.8,
  AST-7.12, AST-10.3 (second half), AST-9.1 (reaction).
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

#### A12 — Guided sign-in cards

- **Scope.** Founder answer A: the Claude card ([ Open claude.ai ], [ Paste ] reading
  the clipboard, survives a PWA reload while the code is valid) and the ChatGPT card
  (the device code large, [ Copy and open ChatGPT ], completion from `codex login
  status`); the terminal under *Show details*; other methods under *Other ways to sign
  in*; the supervisor recognising only the sign-in URL and device code, in memory; the
  two sign-in failure rows of Journey 6.
- **Files.** The sign-in console component of PR #398, the supervisor's login output
  reader (`app/apps/runtime/src/supervisor/`), the fake CLIs.
- **Migration.** None.
- **Tests.** AST-1.5 to AST-1.8 with the fake CLIs; the pinned real CLIs' login output
  shapes checked by the account-free contract table of PR #398.
- **Depends on.** PR #398 (#279) for Claude; #281 for ChatGPT.

### Acceptance criteria by slice

| Criteria | Slice |
| --- | --- |
| AST-1.1, AST-1.2 | #277 (then A10 for copy) |
| AST-1.3, AST-1.4 | A10 |
| AST-1.5–AST-1.8 | A12 |
| AST-2.1, AST-2.4 | A8 (sign-in refusal on paid hosting: A10) |
| AST-2.2 | A9 |
| AST-2.3, AST-4.4, AST-4.2 (read part) | #280 (A2) |
| AST-3.1, AST-3.3, AST-3.4 | A1 |
| AST-3.5, AST-3.6 | A7 (with #347 and #343) |
| AST-3.2, AST-4.2 (`server` part), AST-8.1–AST-8.3 | A6 |
| AST-4.1, AST-5.1 | A1 (API) and A7 (screen) |
| AST-4.3, AST-5.2–AST-5.8, AST-6.5, AST-6.7, AST-9.2 | A3 |
| AST-6.1–AST-6.4, AST-6.6, AST-6.8, AST-9.3, AST-10.13 | A4 |
| AST-7.1–AST-7.6, AST-7.9–AST-7.11 | A8 |
| AST-7.7, AST-7.8, AST-7.12 | A9 |
| AST-9.1 | A3 (interactive), A6 (`server`), A8 (scheduled), A9 (reaction) |
| AST-10.1, AST-10.2, AST-10.4–AST-10.6, AST-10.8–AST-10.12, AST-10.14, AST-10.15 | A7 |
| AST-10.3 | A8 (schedule) and A9 (when something happens) |
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
- "`codex login --device-auth`'s user code and verification URL are available to the
  sign-in card (slice A12) in memory only; 'device code sign-in is disabled' and 'code
  expired' outputs map to Journey 6's two sign-in rows."

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

**Kind:** no fix needed for PR #398 to merge; a follow-up slice, **A12**, builds the
guided cards on its console (founder answer A, 2026-10-09). Every login method stays
offered. Criteria A12 adds: AST-1.5 to AST-1.8 ("Sign in to Claude: 1. Open claude.ai
and approve. 2. Paste the code here." with [ Open claude.ai ] and [ Paste ]; the
terminal under *Show details*; the sign-in URL and device code never stored or
logged). The entry copy *Sign in with Claude* is slice A10's.

### #58 / PR #391 — Background comparison

**Kind:** none (question 15). Its rule stays on API keys.

### #347 / PR #376 — Hand-off and Agents

**Kind:** follow-up criteria delivered in slice A7; the policy-row text can be fixed in
PR #376 now, because the current text is untrue once the assistant edits (founder
answer D):

- "The project Agents tab's policy row reads: 'Agents read and propose; people accept.
  Assistants also edit for their owner, with Undo.'"
- "**AST-3.5** In a hand-off, another person's assistant shows as 'Ada's assistant ·
  for Ada · asks Ada first'; choosing it creates one Needs-you item for Ada ('Jonas asks
  your assistant to do #10 · Allow · Not now') and starts nothing until Ada allows."
- "**AST-10.8** The *Can* sentence on the assistant panel, the hand-off step 2 and the
  phone agent page is identical for the same settings and changes when a switch
  changes." Until A7, the static text stays.

### #343 / PR #387 — Conversation

**Kind:** follow-up criteria delivered in slices A4 and A7; no change needed in PR
#387:

- "**AST-3.6** An assistant's message header reads 'Ada's assistant · Agent · for Ada ·
  Claude' (the account's AI company) for every viewer."
- "**AST-10.13** A run produces one message built from P5 notice rows: a header with
  Undo, at most three object rows and '+N more', before and after when expanded."
- "**AST-10.5** The owner's `@` list shows 'My assistant' first; the chosen chip reads
  'Ada's assistant' for every viewer."

### #350 — Settings (owner @Zamojski5; PR #370 merged)

**Kind:** no change to the merged work. Slice A8 adds to Settings → Notifications →
*Morning summary* the line "Written by Ada's assistant · Change ›" when the owner lets
the assistant write it (founder answer C), and reuses its time, quiet hours, tick and
single push.

### Others

- **#238 / PR #394:** reused by A4 for undoing a created task. No change.
- **#344 / PR #386:** the assistant's panel (Now, Recent, Can) uses the one detail
  panel and sheet; delivered in A7. No change to the PR.
- **#228 / PR #389:** A3 reads its live-session presence to defer a change while
  someone else is typing in a page. No change.
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
