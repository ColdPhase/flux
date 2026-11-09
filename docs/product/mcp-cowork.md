# Local Claude Code and Codex over MCP (F-036; amends F-016)

**Status:** founder direction, Hubert (@PelikanFix16), 2026-11-03
([#851](https://github.com/ColdPhase/flux/issues/851) point 9, [#859](https://github.com/ColdPhase/flux/issues/859)),
recorded 2026-11-03 in [#852](https://github.com/ColdPhase/flux/issues/852); independent review
pending ([F-036](decisions.md#f-036--simple-ai-everything-is-an-agent)). It replaces F-016's
standing scoped autonomy (CO-1, CO-2) and its formal review gate (CO-4, see LC-3), and keeps one
Flux task and the GitHub binding (CO-3). The earlier text is at [`a82ee012`](https://github.com/ColdPhase/flux/blob/a82ee012d0dc0a33e9ab14925f8f400c96f31e60/docs/product/mcp-cowork.md).

**Implementation.** #859 landed in two steps. Step 1 built the waiting rules and removed the standing grants. Step 2 (2026-11-07)
removed the three OAuth scopes (one remains, `offline_access`, so a client stays connected), the 38 capability switches and the
permissions page, and project selection; a client signs in with one click on the consent page. What a client reaches is read again
at every call from its owner's rights, and what it may change comes only from "What it may do"
([coordinator defaults C-19 to C-23](decisions.md#coordinator-defaults-and-inferences-not-founder-decisions-hubert-can-override)).

A person's own Claude Code, Codex or other MCP client on their computer connects to Flux for code
work. **It follows the same rules as their [agents](assistant.md).** The only difference is that
it changes code on the person's computer, outside Flux (Hubert, 2026-11-03: "it must not be
complicated or different").

## LC-1 — One sign-in

- The developer adds Flux to their client, for example
  `claude mcp add --transport http flux <origin>/mcp` or `codex mcp add flux --url <origin>/mcp`,
  and signs in once in the browser (OAuth). There are no scopes, capability switches, project
  selections, standing grants, project grants or access requests.
- The client appears as one row in Settings › AI: "Claude Code on Ada's laptop · Do it and tell me
  · Disconnect". Disconnect revokes it at once. A person may connect several clients, each with its
  own row. A password reset, a password change that signs out the other devices, and "Sign out all
  other devices" disconnect every client of the person the same way; each connects again with one
  click on the consent page ([C-42](decisions.md#coordinator-defaults-and-inferences-not-founder-decisions-hubert-can-override)).
- Flux holds only its own grant. Flux tokens are audience-bound to Flux's MCP resource, and Flux
  never accepts, stores or forwards the client's provider token (MCP 2026-07-28: the server "MUST
  NOT pass through the token it received from the MCP client"). The client's plan usage is unknown
  to Flux and never shown as zero.
- With single sign-on, the identity provider's standing check applies: when it stops confirming
  the person, their clients lose access ([F-024](mcp-identity.md)). Protocol admission follows
  [O-012](mcp-protocol-compatibility.md).

## LC-2 — Same rules as agents

- It sees exactly what the person sees, never more, and only in spaces with AI on; never in an
  encrypted space (AG-3, AG-10). A DM between people it opens shows both people the line of AG-4
  ([coordinator default C-2](decisions.md#coordinator-defaults-and-inferences-not-founder-decisions-hubert-can-override)).
- It has the same "What it may do" row: Only read, Do it and tell me or Ask me first. Deleting
  anything and other people's things wait for the person's OK, and the never-list holds (AG-3),
  except posting: a local client is its person's own tool, so it may post in a space's conversations
  as the person, marked "via Claude Code" or "via Codex" (Hubert, 2026-11-08, [#1089](https://github.com/ColdPhase/flux/issues/1089); how it is stored and shown is below).
  For the same reason a change of its that would notify another person does not wait (AG-3 "Telling
  another person" holds server agents only).
  Its changes can be taken back (Undo), and each shows its change line with Undo where it was made
  (#868): a task's change in the task's activity, a page's change on the page between its title and
  its text, a map's change (also its thoughts and links) on the map, in its dock or at the head of its
  List. The line is the assistant's own, "Ada · via Claude Code", "Moved #4 to Doing · Undo", one per
  change, newest first, three at most with the earlier ones one button away. Everyone who can read the
  object sees it, a guest of the company who can read the space too (#1116); the owner or anyone who may edit it takes it back, and a created task, map or page
  only its owner (AG-3). After someone else changed the same thing it reads "Changed since" and puts
  nothing back. Nothing shows in a space with AI off. What it posts is the person's own message with
  its own Delete (below), and its lines in a task's discussion are its owner's to delete (TA-3).
- **Only the person approves.** Approving, editing or skipping a waiting item, Approve all, and
  accepting a decision come only from the person in a signed-in Flux session. The client's grant
  has no tool for them, so a prompt-injected client cannot approve its own wait ([AG-3](assistant.md#ag-3--rights-what-it-may-do-approvals-and-undo)).
- **What waits.** A local client's changes wait exactly as an agent's do (AG-3), and what waits is one Inbox item per client:
  "Claude Code on Ada's laptop · 3 things wait for you · Approve all · Open". Its answer to the client is plain words that the
  change waits; the client does not retry it. What it made carries one change line with Undo on the task, page or map it changed (above),
  and an Undo takes back that change and never the client's earlier work
  ([coordinator default C-18](decisions.md#coordinator-defaults-and-inferences-not-founder-decisions-hubert-can-override)).
  Taking a task, claiming or releasing it, asking a question, writing in the task's discussion and linking a pull request are
  its own work on a task it holds, not changes to anyone's things, so they do not wait; Only read refuses them like any change.
  Taking back its own unused task (`flux_undo_task_creation`) is a deletion, so it waits like any deletion (AG-3). Giving a unit to
  another person's client (a new child unit or a transfer) is another person's thing: it waits like a task
  for someone else. Approve repeats the call as the client's own, which works while the claim and session it was made under are live
  (a 300 second lease). A later Approve cannot apply it, and says so in plain words: "The claim this was made under has ended, so it
  can't be made now. Ask again with a live claim" (the simpler of the two options; it records that the owner's rights today are not a
  claim the client holds).
- Only the person prompts it, from their editor. Flux never starts, wakes or prompts a local
  client, and nothing polls a model while it is idle (F-032).
- **Its posts are the person's, marked "via".** What it posts in a space's conversation, a new conversation or a reply, is stored
  as the person's own message with the client's name as its mark ("Claude Code", "Codex", or another client's name), and everyone reads
  "Ada · via Claude Code", the same mark as an answer posted with Show everyone (#1091, Hubert, 2026-11-08). The person is the author
  for everything that follows: they edit or delete it like any message of theirs (and an edit makes the words theirs, so the mark goes),
  an assistant's brief does not take it for their own words (the mark is the same). The mark goes with the message everywhere it is
  named: a person it mentions is told "Ada · via Claude Code mentioned you in …" (the Inbox item, the push and the notice are marked as
  AI-origin, so they are hidden while AI is off in the space), a search result and the "While you were away" summary (its item and
  its next step, "Answer Ada's question, posted via Claude Code") name it the same way, and the project export keeps it as the
  message's `via`. An answer posted with Show everyone is named the same way, also in a direct message and its thread, where it
  starts its own author run after the person's own message, and the direct messages list names it before the words ("via Assistant: …")
  (#1091, review of #1105). It has no change line and no Undo of its own, since the person's own Delete takes it back (the change is
  still in the log). In a task's discussion the client stays an agent: its line there is its agent's own, counted by the
  five-in-a-row limit (C-51) and its owner's to delete (TA-3), so a client cannot reset the guard by posting as the person.

## LC-3 — "Work on #4"

- The person tells their client "work on #4". The client takes the task through MCP (Flux shows
  "Ada is on it via Claude Code"), reports in the task's discussion and finishes it under "What it
  may do": Done with Undo, or handed back for review.
- **Review.** There is no separate Flux review verdict on a pull request head (F-016's and F-018's
  review gate; [coordinator default C-9](decisions.md#coordinator-defaults-and-inferences-not-founder-decisions-hubert-can-override)). Review is the "What it may do" row: under Ask
  me first, or Only read, the task is handed back to its person, "Ready for you to check". A
  separate reviewer is optional, for example a subtask for a Reviewer agent. GitHub's own reviews and
  checks stay GitHub's (LC-4).
- Flux's MCP server gives the client its instructions and tools. The person never copies prompts,
  reads a playbook or installs files (F-018, kept in that sense).
- Flux gets no new hand-off control for this, and a local client is not offered in the Owner
  field.
- How the client holds the task internally (today's co-work claim and lease) is engineering for
  #859; it is not something people see.

## LC-4 — GitHub

Kept from CO-3, [O-011](decisions.md) and [F-033](decisions.md):

- A space binds repositories through the read-only GitHub App. Flux holds the task and its
  discussion; GitHub holds repositories, branches, commits, pull requests and CI. Flux never
  creates, imports or mirrors GitHub Issues as a second backlog.
- Private repository facts need both current Flux access and verified repository access. Login
  identity, App installation and each repository binding are distinct, and callbacks bind the
  initiating person and space with verified state.
- The client links the pull request it produced to the task. Flux verifies it with the person's
  own GitHub authorization through the read-only App; the client gains no GitHub permission.
- Linked pull requests may move the same Flux task under O-011's per-task rules. Statuses are To
  do, Doing, Blocked and Done (F-038); closed-unmerged is not done, and green CI or a merge alone
  does not meet unmet criteria.
- Server agents read the connected repository (issues, pull requests, checks) and never write to
  GitHub (AG-8).
- Flux's own record, GitHub approval, checks and merge are different facts. GitHub's required
  approvals and protections stay GitHub's. The real GitHub App installation remains a later
  version (F-033).
- Webhooks are verified, persisted before processing, deduplicated and reconciled against the
  provider; a disconnect stops future privileged reads and writes.

## LC-5 — Stop and questions

- The person, or the space admin, can Stop the client's work on a task: its next Flux call is
  refused ([AG-5](assistant.md#ag-5--tasks-reach-agents-through-their-owner)). Flux cannot kill a
  local process, so it shows "Stopped by Ada" (or by the admin's name), not that the client
  stopped running, and the person is told who stopped it. Taking the task back, or giving it to someone else, by changing its Owner
  ends the client's claim the same way ([AG-5](assistant.md#ag-5--tasks-reach-agents-through-their-owner)). Only the person prompts the client. That
  the space admin's Stop also reaches a local client is a [coordinator default C-6](decisions.md#coordinator-defaults-and-inferences-not-founder-decisions-hubert-can-override).
- A local client may ask a person a question with ready answers, as an agent does (AG-6).

## What went away in v0.2

- Three OAuth scopes, 38 capability switches per connection, project selection, standing grants
  with uses and expiry, and hand-off auto-grants.
- Agent project grants, "Ask a manager to let it in" and the project agent policy.
- The space Agents tab and its agent thread ([agents in a task](cowork-workflow.md)).
- Start and Resume commands as a step the person must run, and the always-on local waiter (#754,
  closed).
- Workspace-owned agents: every agent belongs to one person.

Removing scopes and switches changes EXT-1 ([O-010](extension-contracts.md)): #859 edits the
contract's one current snapshot in place.

## Evidence

Real Claude Code and Codex sessions are recorded with their versions; mock clients support
regression tests but do not prove compatibility. Primary sources checked 2026-09-30:
[MCP architecture](https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture),
[GitHub review eligibility](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/approving-a-pull-request-with-required-reviews)
and [protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).
