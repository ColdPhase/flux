# Built-in agent workflows and addressed cooperation

**F-018, 2026-09-30 — founder requirement; delivery pending.** Hubert's follow-up
requires Flux to teach connected agents how to cooperate, not merely expose MCP
tools. This extends [F-016 / CO-1–CO-5](mcp-cowork.md). The contract and
[internal instruction content](cowork-playbook.md) are product design, not an installed
skill, working scheduler or proof of client support. [#160](https://github.com/ColdPhase/flux/issues/160)
owns packaging/onboarding; #152/#153/#74 and the final design's Agents view (#347) retain their existing domains.
Owner: `codex-hubert`; independent evaluator: `claude-maurycy`.

The missing pieces in the earlier contract were instruction delivery, explicit
request lifecycle, safe-checkpoint scheduling, context-loss recovery and the
boundary between Flux conversation and formal GitHub review. This amendment
specifies them. It does not change this repository's current development
procedures in `docs/agents/` or turn supplied `AGENTS_COOP.md` into instructions.

## Connect, authorize, start — CW-1

The default journey is **connect a supported client → authorize project/role →
Start work**. Instruction delivery and workflow management are built into Flux.
Users must not have to read a playbook/README, copy or paste prompts, download
instruction files, manually install skills or author agent procedures to make
co-work function. Each of Hubert's two connections and
Marek's third gets its own role, grants and state. Existing helper remains separate.

Flux owns and ships one internal versioned instruction bundle (called a playbook
in these engineering documents) with role modules: start/resume, plan/claim,
execute/checkpoint, request help/review, review/fix, blocker/transfer and stop.
Flux's supported integration supplies/loads this through MCP or a managed client
adapter as part of the built-in connection and Start/Resume flow. A native skill
or MCP prompt/resource is an implementation detail, not homework handed to the
user. Demonstrably load the instructions into the active client; advertising a
prompt or tools is not successful setup. The default must be useful without
optional project customization. End-user UI says Connect/Start/Resume and explains
scope/activity, rather than exposing instruction files to operate the feature.

Bootstrap returns authenticated connection/owner, tenant/project, permitted role
and grant references, capability manifest, playbook version/digest, approved
project-policy revision, bounded entry context, active claim/checkpoint and inbox
continuation. It does not dump all conversations/wiki/tasks. Resolve additional
authorized sources only when needed. The client records the bundle it loaded;
this acknowledgment is compatibility evidence, not proof of model obedience or
an authorization token. Server commands independently enforce all policy.

Require exact tested client/adapter versions and a supported activation path.
If the client requires a user invocation/approval, provide an integrated action
in the supported setup/launch flow. Manual prompt copying or skill-file setup
does not satisfy this product requirement. A client lacking a tested integrated
path remains unsupported/pending; do not claim that MCP auto-installs a skill,
starts a closed application or makes notifications trigger model turns.
No silent edits to global/repository
instructions. A missing required capability is a visible setup failure with a
supported remedy, not a connection shown as working. Optional duty mode remains
separate under CO-2. Document Start/Resume/Pause/Stop and their actual client limits.

Project maintainers can publish a bounded policy revision (scope, priorities,
review criteria, allowed work), under current project rights. Only that privileged
policy-publishing operation changes approved policy. Bootstrap's authenticated,
authorized, versioned policy envelope carries the selected policy; ordinary
messages, PR text, wiki content and tool-result prose cannot promote themselves
into policy or authority. Neither envelope nor source content expands owner
grants. Project policy can narrow/select work within them. On resume, compare
revisions. Compatible content updates load at the next
safe checkpoint; an incompatible required version pauses new claims with an
upgrade reason. Revocation/security restrictions apply immediately at the server,
regardless of a client's pinned bundle. Never silently upgrade permissions.

### Understand the project before making its task plan

Hubert's additional clarification makes **Flux the project's working knowledge
and planning home**: goals/plans in its wiki, conversations, decisions, tasks and
results. GitHub holds linked code/branches/PRs/CI, not a competing project plan or
task backlog. Technical files such as repository build instructions remain useful
linked sources; the user need not copy project planning into GitHub Issues.

After Start, agents first orient themselves in the authorized project. Obtain a
versioned index of goals/current plans, wiki, relevant conversation/decisions,
existing tasks/dependencies and linked repository context. Read the current plan
and applicable decisions completely, then follow relevant sources with bounded
pagination until the selected outcome is understood. Thorough analysis means
covering the goal, constraints, prior decisions, open questions and existing work,
not silently truncating a large wiki or dumping every historical message into one
prompt. Record coverage/version references and visible gaps; distinguish accepted
decisions from proposals and superseded conversation. Private/inaccessible content
stays out, and an unavailable critical source is a blocker, not assumed knowledge.

Publish useful analysis or a proposed plan in the existing Flux conversation/wiki
through permitted domain actions, linked to sources. Under standing create/edit
and execution grants, agents can decompose the plan into bounded **native Flux
tasks**, set criteria/dependencies, claim/delegate eligible work and keep outcomes
current without asking the users to administer each step. Existing human-reserved
decision acceptance remains. Creation must check existing work and use an
idempotent correlation to plan revision/work intent; concurrent planners cannot
silently create duplicate tasks or overwrite an accepted plan. A sole plan-writer
claim or equivalent atomic conflict handling resolves competing decomposition.

Bind each resulting PR to those tasks using verified #74 links; one task may need
several PRs and one PR may contribute to several tasks. Tasks also support non-code
results. Review/fix/CI events update those same records under CO-3/CO-4 rules.
On subsequent work, restore the orientation/checkpoint and read relevant changes
since the recorded versions; reanalyze affected decisions when they change. Do
not repeatedly reread the whole project. #160 owns this orientation workflow,
#152 the scoped reads/task mutations, and #153 concurrency/events/recovery.

## A durable request, not a second conversation — CW-2

**Revised 2026-10-09 by founder direction.** Hubert (@PelikanFix16), in a supervising
session, decided that agent-to-agent conversation lives **only in the Agents tab**.
- Agents talk in their own threads there.
- People's conversations show only short outcomes, for example "Codex finished #12 ·
  review passed", with a link to the agents' thread.

This replaces the sentence below that calls Agents and the inbox "views of this work,
not … agent-only chat", and the sentence that lets a question or finding be "a normal
attributed message" in the people's thread. **Everything else in CW-2 stands:**
- the request record and its fields;
- the state table;
- addressing, claims and fencing;
- the outbox and durable inbox;
- cursors, recovery and retention;
- the access rules.

- **What moves.** Agent-authored messages about work live in the task's **agent
  thread**, one per task, opened from the project's Agents tab. That covers:
  - plans and progress;
  - help, review, fix and hand-off requests to other agents, and the replies;
  - review findings and "fixed at <SHA>".

  Requests appear there as cards read from the same durable request records. The thread
  is their visible face, never their store, so an edited or lost message cannot change or
  lose a request.
- **Nothing is hidden.**
  - Everyone who can read the task can read its agent thread.
  - A person can write in it. People keep their initials avatar, and agents keep Kreska
    and the Agent tag (F-026 principle 5).
  - Search and export include agent threads, and current access rules apply as to any
    conversation.
- **What people's views get.** Outcome notices only. Flux composes each one as one line
  from records, never as a model-written summary, and each links "See the agents' thread".
  The outcomes are:
  - a result (the existing result card);
  - a review verdict;
  - done;
  - blocked, with its reason;
  - a question to a person, which also goes to Inbox "Needs you".

  Agent-thread messages add no unread count and no notification, except a question or
  request addressed to a person.
- **Where an agent may still write in people's views.** The server enforces this list,
  not only the playbook:
  - a result;
  - a proposed decision;
  - a question to a person;
  - a reply to a person who addressed that agent in that conversation.

  All other work talk goes to the agent thread.
- **History.** Agent messages already in task threads stay where they are. Nothing is
  moved or rewritten.
- **Delivery.** The slice and its criteria are in the
  [Agents tab review](research/2026-10-09-agents-tab-ux-review.md#slice-for-agent-threads-in-agents).
  Until that slice ships, agents keep using the task thread, and the rules above are the
  target, not current behaviour.

Use the existing Flux task/thread/result as the content record. A request is a
small delivery/control record pointing to that source; Agents/inbox are views
of this work, not a parallel backlog or agent-only chat. A meaningful question
or finding may be a normal attributed message once. Receiving it is not an
instruction to accept more work than authorized.

Each request records a stable ID and idempotency key; sender and recipient
connection IDs/owners; tenant/project and task/work-unit IDs; request kind and
expected response; source message or artifact reference/version; causal parent;
current claim generation where applicable; priority, expiry and bounded retry
budget. A review includes exact SHA/result version and criteria references.
These are product requirements, not new public tool names/schema commitments.

Address a connection, or resolve a granted role to one eligible connection and
record that recipient. Do not broadcast a job to every peer. Claiming remains
atomic. If nobody is eligible, show why it waits; do not borrow another owner's
compute. Reassignment is explicit/authorized, records history, supersedes the
prior delivery and fences any old claim before a replacement can act. Several
sessions of one connection cannot claim the same request twice.

| Request state | Meaning and allowed progression |
| --- | --- |
| Queued | Persisted for a recipient; transport receipt can be recorded separately. Offline is an availability fact, not completion. |
| Deferred | Recipient has retained the request and recorded why/which checkpoint or dependency comes next; it stays pending. |
| Claimed | Recipient acquired the authorized work unit and lease. A transport ACK alone can never do this. |
| Resolved | The requested response/artifact or blocker answer is durably linked and validated. This does not mark the parent task done or approve a PR. |
| Declined / superseded / expired / cancelled | Terminal delivery outcome with reason; unresolved work stays visible on the original task for authorized rerouting or continuation. No silent drop. |

Delivery receipt, request state, execution availability, review verdict and task
status are distinct. Use existing task statuses; this table does not add board
columns. An expired claim leaves the request pending/recoverable under a new
generation, not resolved. A completed review with findings resolves that review
request; it produces one targeted correction request, not a false approval.

Commit a domain effect and its outgoing event atomically where they share the
database. Use transactional outbox/durable inbox, at-least-once transport and
idempotent domain effects. Persist outcome + response link before marking the
request resolved. Unknown local/GitHub write outcomes reconcile the referenced
object before retry. New SHAs supersede outdated queued reviews; an in-flight
review may retain historical evidence but cannot satisfy current-version gates.

Persist per-connection cursors and pending requests server-side. Delivery/ACK
cannot delete actionable work. On restart/context loss, load active claim and
last durable checkpoint, pending requests and changes since cursor; if history
was compacted, return an authorized bounded snapshot/resync marker. No global
GitHub scan to reconstruct memory. Retention cannot silently remove unresolved
requests. Enforce current ACLs on enqueue, routing, fetch, replay and execution;
redacted/unavailable outcomes must not reveal newly inaccessible sources.

## Finish a step, then handle the request — CW-3

By default one active unit per connection; higher concurrency requires its own
grant and tested client support. Ordinary incoming requests never preempt work.
The adapter may retain their receipt without opening a model turn. The playbook
checks pending work at startup/resume, after a bounded implementation/test step,
before selecting new work and after releasing/parking a claim. A checkpoint
contains observed progress, artifact/source IDs, tests and next action, not
hidden reasoning. Long external operations renew leases through non-LLM
infrastructure; on loss of lease they cannot publish authoritative Flux effects.

At each checkpoint process applicable stop/revocation/version changes first,
finish or checkpoint/park the current unit, then choose an eligible pending
request. Prefer work unblocking a peer before fresh self-selected work; use
priority then oldest-ready order, with aging so ordinary requests do not starve.
Deferral records a concrete dependency or next checkpoint, not an endless
"later" ACK. A blocked author releases its execution slot and can do other
authorized work; two agents awaiting reviews must not retain incompatible
execution/review locks. Decline or reroute unavailable work within standing
policy; only ask a human when authority or a genuinely missing decision requires it.

Work discovery is initial/explicit bounded project discovery plus subsequent
relevant task events. A ready-work subscription may make new permitted tasks
eligible without a peer manually asking each time. Direct review/help requests
are targeted; content, heartbeats and transport ACKs do not recursively create
requests. Bound delegation depth, retries, review/fix rounds and total owner
budget. Exhaustion leaves a checkpoint and visible blocker, not a loop of agents
asking each other or repeatedly calling a model to see whether anything changed.

Use negotiated notifications where supported as hints to drain the durable
inbox. A notification is not the durable event. A supported active adapter can
wait/back off or poll the **bounded addressed inbox** without LLM calls and
schedule a permitted turn at a safe checkpoint. Otherwise check at the next
active-client checkpoint/Resume and show waiting honestly. Specify and measure
adapter-specific checkpoint/wake latency; do not promise arbitrary instant
interruption. Never run a model every N minutes to list every issue/PR/comment.
Recovery polling of a specific provider object by #74 is ordinary infrastructure.

Owner stop/revocation is exceptional control, not a high-priority peer message:
block new server effects immediately and request local cancellation if supported.
Show requested versus acknowledged; Flux cannot kill unrelated local commands or
erase downloaded context. Pause prevents new work and records a safe checkpoint;
release/expiry of its claim follows CO-2. No hosted or alternate-payer fallback.

## Talk in Flux, retain real review gates — CW-4

**Revised 2026-10-09 by founder direction (see CW-2).** "Live in Flux" below now means the
task's agent thread in the Agents tab. People's views get the outcome: the review verdict
and the result. The formal GitHub review, approval, check and merge gates in this section
are unchanged.

"PR ready; review when free", "please inspect this finding" and "fixed at this
SHA" live in Flux, referencing the same task/PR and addressed request. They need
not be repeated as GitHub coordination comments. Findings may live in Flux with
precise SHA/path/line or result-message/version and reproduction/evidence.

Formal eligible GitHub reviews/approvals, required status checks, unresolved
GitHub review threads and merge rules remain real provider facts. When policy
requires a GitHub review, publish it through the authorized reviewer identity
and link its external ID to the Flux assessment. A substantive review can be
published once where external collaborators need it; this is not a second
conversation to maintain manually. Synchronize referenced resolution/state,
not an LLM rewrite of all discussion. Flux-only approval never satisfies a
required GitHub approval, including two connections sharing one GitHub account.

#74 routes relevant signed GitHub events for already linked PRs (new head,
review/requested changes, linked review-thread comments, checks/merge) into #153's
inbox under current access and explicit subscriptions/standing policy. Untrusted
comment text cannot authorize tools or create arbitrary new work. Record provider
delivery/object IDs and causal origin to suppress webhook echoes and duplicate
"ready"/"fixed" requests. A request and its later webhook update the same
correlation, not two reviews. Gaps use bounded non-LLM reconciliation of known
bindings/objects; listing the whole repository is not the agent's work loop.

## Concrete journey and delivery proof — CW-5

1. Hubert connects Codex and Claude, Marek connects Claude. Each owner authorizes
   scope and invokes the supplied Start action. Clients load the same playbook,
   analyze the existing Flux plan/wiki/conversation/decisions/tasks and, where
   needed, create bounded nonduplicate tasks within their grants. The Agents view
   shows three distinct connections and their real readiness.
2. Hubert's Codex completes task A's code at SHA H1 and requests Marek's review.
   Marek's agent is testing task B: A stays deferred, B continues uninterrupted.
   A's author sees "waiting for reviewer to finish current step", not "reviewing".
3. At B's checkpoint its agent releases/parks B as appropriate, claims A's review
   and publishes findings tied to H1. A targeted correction reaches the author.
   Review/approval records are published to GitHub only where required/useful.
4. A fix produces H2. H1 cannot approve H2; one fresh request reaches the already
   authorized reviewer. Reconnect or lost ACK does not lose or duplicate it.
   Eligible current approvals/checks and all task criteria determine completion.
5. With Marek offline, show waiting or explicitly route to Hubert's Claude only
   if its grant and the project's same-owner review policy permit it. No pretend
   wake, automatic payer substitution, author self-review or false progress.

The same flow must work for a versioned research/result message without a PR.
Humans can read context, correct assignments and continue work without any agent.
The UI shows current work, pending request/reason and source/outcome with optional
details; ACKs/heartbeats do not flood the conversation, unread count or notifications.

| Owner issue | Required slice; no duplicate ownership |
| --- | --- |
| #160 / PelikanFix16 | Canonical playbook/modules, supported-client activation/resume adapters and end-to-end onboarding evidence |
| #152 / PelikanFix16 | Authenticated bootstrap delivery, capability/version envelope and scoped domain tools; agree payload with #160 |
| #153 / Zamojski5 | Durable addressed inbox/outbox, lifecycle, fencing, checkpoint scheduling interface and recovery; #160 consumes this interface |
| #74 / PelikanFix16 | Scoped GitHub event/review bridge and deduplication, preserving formal gates |
| #347 (final design) | Calm integrated Agents controls/status and source navigation; consumes these domains without an event-console UI |

Acceptance needs Docker race/access/recovery regressions **and real pinned
supported Codex/Claude clients**, two owners/three connections, fresh setup with
no README reading, prompt copying or manual skill installation, project orientation
with source coverage, concurrent
plan decomposition into nonduplicate tasks, verified task↔PR links, a plan change
that triggers targeted reanalysis, busy reviewer, context reset, offline/resume,
duplicate/lost ACK, simultaneous sessions, stale SHA, changed policy, revocation,
blocked-peer fairness and no-AI continuation. Capture tool/network/model-call
traces showing no periodic global GitHub scans, zero idle model calls and one
domain effect per retried request. A bundle ACK alone or simulated client cannot
complete acceptance. Document unsupported activation/notification behavior.

## Evidence and alternatives

Primary specifications checked 2026-09-30:
[MCP architecture](https://modelcontextprotocol.io/specification/2025-11-25/architecture)
assigns model integration/lifecycle to the host;
[prompts](https://modelcontextprotocol.io/specification/2025-11-25/server/prompts)
provide discoverable templates intended for user invocation;
[resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources)
provide content and negotiated subscription notifications. These facts do not
establish automatic skill installation, durable business delivery or closed-client
wake. The version is a cited protocol baseline, not a protocol upgrade decision.
Current supported client behavior must be retested during implementation.

**Design choice/inference:** a canonical shipped playbook plus durable targeted
inbox addresses the user's missing-instructions and lost-handoff problems. Tools
alone leave orchestration to users; periodic global scans cost context and miss
clear ownership; automatic preemption breaks active work; copying every message
to GitHub creates a second conversation. The chosen path costs a small durable
delivery state machine and tested client adapters. Revisit adapter mechanics on
capability evidence, preserving these observable outcomes and owner authority.
