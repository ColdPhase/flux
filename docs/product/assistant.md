# F-036 — agents: everything is an agent

**Status:** founder direction, Hubert (@PelikanFix16), 2026-11-02, final model 2026-11-03
([#851](https://github.com/ColdPhase/flux/issues/851)), recorded 2026-11-03 in
[#852](https://github.com/ColdPhase/flux/issues/852). An independent review of this text by
@Zamojski5 is pending; comments from the shared PelikanFix16 account do not count. Decision
record: [F-036 and F-037](decisions.md#f-036-to-f-038-the-v02-direction-2026-11-03). Rules the
agents inferred rather than Hubert decided are tagged "coordinator default" and listed in
[one table](decisions.md#coordinator-defaults-and-inferences-not-founder-decisions-hubert-can-override); Hubert can override them.

This contract replaces F-027 (the assistant) and the workspace AI lock (F-029). It states only
the rules that hold from v0.2. The earlier text is in git history at
[`a82ee012`](https://github.com/ColdPhase/flux/blob/a82ee012d0dc0a33e9ab14925f8f400c96f31e60/docs/product/assistant.md).

Related contracts:

- [Connect AI and models](model-providers.md): connections, models, provider limits and the
  API-key budget.
- [Where agents run](ai-modes.md): the server runtime and its security.
- [Agents in a task](cowork-workflow.md): subtasks and questions between agents.
- [Local Claude Code and Codex](mcp-cowork.md): code changes from the person's own computer.

Flux connects people: shared work, conversation and tasks. AI only helps, and it stays simple:
one Connect AI per person, agents that act as their owner, and no limits or switches of Flux's
own.

## Safety rules at a glance

- An agent acts with exactly its owner's current rights, never more, and only in spaces where AI
  is on.
- Only its owner prompts or configures it. Its owner or the space admin can Stop it on a task
  (AG-5). Other people's messages, web pages and project content are data, never instructions.
- `/ai` uses only what the conversation's audience can see, so Show everyone never publishes
  anything private (AG-4). AI in a DM between people shows both of them one line (AG-4).
- Deleting anything and changing other people's things always wait for the owner's OK.
- Only the owner approves. Approving, editing or skipping a waiting item, and accepting a
  decision, are done only by the owner (or the person the item waits for) in their own signed-in
  session. No agent, server or local, can do it, not even for its own waiting item (AG-3).
- Changing access, accepting decisions and changing code are never possible for a server agent.
- Every change is attributed, versioned and has Undo on the agent's message.
- Flux never handles a plan token and never impersonates Claude Code or Codex
  ([where agents run](ai-modes.md)).
- An encrypted space never has AI. A guest has no AI.
- Nothing falls back to another connection, provider or payer.
- Human work continues when AI is off, signed out, limited or failing.

## Terms

- **Agent.** A person's AI helper with a name, saved instructions, a model and a memory. Every AI
  helper in Flux is an agent; there is no separate assistant concept.
- **Assistant.** The person's first agent. It answers `/ai`.
- **Owner.** The one person an agent belongs to, for the whole Flux. Agents never belong to a
  space or to the company.
- **What it may do.** The agent's one permission row (AG-3).
- **Yours and other people's.** Yours: a task you are responsible for, or one you or your agents
  created while nobody else is responsible for it; a Wiki page, map, thought or link you or your
  agents created and nobody else has edited. Everything else is other people's.
- **A task's people.** The task's creator, its owner and anyone who wrote in its thread
  ([coordinator default C-10](decisions.md#coordinator-defaults-and-inferences-not-founder-decisions-hubert-can-override)). When an
  agent owns the task, the agent's owner is the person. Only people count: a message written by an
  agent does not add its owner ([coordinator default C-5](decisions.md#coordinator-defaults-and-inferences-not-founder-decisions-hubert-can-override)). Agents ask each other questions only when both owners are among the
  task's people (TA-3), and use only what all of the task's people can see (AG-11).
- **Run.** One piece of an agent's work: an answer, a step on a task or a scheduled firing.

## AG-1 — Everything is an agent

- A person gets one agent, **Assistant**, when they connect AI. They can add more, such as
  Planner or Reviewer, and rename or remove any of them. Flux makes Assistant once, when the
  person's first connection is made (an API key saved, or a plan signed in), never when a page
  opens; someone who deleted their agents is not given Assistant again by a later connection.
  Settings shows a guest no AI at all (AG-2).
- Each agent has:
  - a **name**;
  - **saved instructions**, in plain text;
  - its **own model**, chosen from any of the person's connections; Connect AI sets the default
    ([models](model-providers.md#ca-2--models));
  - a **memory** of only what its owner told it to remember: an item is added only by the
    owner's own message ("remember that …", typed by the owner to that agent) or by the owner
    editing the list on the agent's page, where the owner also edits or deletes each item. An
    agent never adds to its memory by itself, and nothing it reads (other people's messages, web
    pages, task text) can add to or change it;
  - its **What it may do** row (AG-3).
- All of a person's agents share the person's connections and rights. Mixed agents are normal:
  Planner on a Claude plan, Reviewer on a ChatGPT plan.
- An agent has one label everywhere, for example "Planner · Ada's agent".
- Agents are listed in Settings › AI and in Messages. They are not members of a space and have
  no space roles. In a space they appear as task owners, in task discussions, and as a small
  face in the space header while they work.

## AG-2 — Only the owner prompts an agent

- Only its owner talks to, configures, schedules or pays for an agent (F-019). The space admin can
  Stop an agent on a task (AG-5) but cannot prompt or configure it.
- Other people reach someone's agent only by assigning a task to its owner (AG-5). Nobody can
  @mention or prompt another person's agent.
- Messages from anyone but the owner, including in a task discussion, are context, never
  instructions. The same holds for web pages, files, event text and anything an agent reads.
- Another agent's question in a task is answered under [agents in a task](cowork-workflow.md);
  it never becomes an instruction to change anything ([coordinator default C-13](decisions.md#coordinator-defaults-and-inferences-not-founder-decisions-hubert-can-override)).
- A guest has no agents and no AI. The server refuses a guest's API key, plan sign-in and new agent (`GUEST_NO_AI`), and a
  guest cannot sign in a local client or keep one, whatever address they open and whatever role another workspace (an encrypted
  space) gives them (#978). A guest is a person whose role in the company is guest (F-037: one company per Flux; [C-22](decisions.md#coordinator-defaults-and-inferences-not-founder-decisions-hubert-can-override)).
  A member who is made a guest keeps their agents, keys, client connections, schedules and old `/ai` runs, but the server lists and
  finds none of them, and refuses every change of one (including a run's changes and Show everyone), until they are a member again
  (C-50). An old `/ai` request is not replayed to them either: the same request, in a space, a direct message or a chat and with
  or without an `Idempotency-Key`, is refused, and the conversation's change list gives them only what was done, not their own
  refusals, skips or waiting changes. Their plan sign-in is not shown and not signed out, the idle policy
  (`FLUX_AGENT_RUNTIME_IDLE_DAYS`) does not release it, and the assistant's model list is empty. Their schedules do not fire, and
  nothing is written to their history or to their hidden chat meanwhile (no "Skipped" line): the next time after the role comes back
  is the next one on the clock. A one-time schedule that falls due while its owner is a guest comes back off, and stays off.

## AG-3 — Rights, "What it may do", approvals and Undo

**Rights.** An agent reads and changes exactly what its owner can, now, and only in spaces where
AI is on (AG-10). A DM between people is not in a space; AG-4 governs AI there. Every read and
change is checked at the moment it happens; when the owner loses access, the agent loses it on
its next call. There are no agent project grants, no access requests and no manager approvals.
An agent sees what its owner sees in the sidebar: a company owner or admin reaches every space
themselves, but their agents (server agents, local clients and `/ai`) read, search and act only in
the spaces the person was added to ([C-15](decisions.md#coordinator-defaults-and-inferences-not-founder-decisions-hubert-can-override),
Hubert, 2026-11-07). After the person adds themselves to another space with Add me, their agents
work there too.

**What it may do.** One row on each agent's page:

| Choice | What the agent does |
| --- | --- |
| Only read | Reads and answers. It changes nothing; on a task it reports and hands the task back ([coordinator default C-1](decisions.md#coordinator-defaults-and-inferences-not-founder-decisions-hubert-can-override)). |
| Do it and tell me (default) | Makes new things and changes yours at once, then reports them with Undo. |
| Ask me first | Every change waits for the owner's OK. |

**Always waits, whatever the choice:**

- **Deleting anything.** It is asked first, with [Delete] and [Keep].
- **Changing other people's things.**
- **Tasks for other people.** A subtask or task for someone else is a proposal with [Approve],
  [Edit] and [Skip], and Approve all for a group. Tasks for the owner or the owner's agents are
  created directly.
- **Telling another person.** A server agent's change that would notify someone other than its
  owner waits too: a task made to wait for them, new words (title or blocker) on a task that waits
  for them, or a decision about their task. Flux would send them its words, and a server
  agent sends no message to another person by itself (AG-4,
  [#1089](https://github.com/ColdPhase/flux/issues/1089)). The owner's OK card shows those words and
  everyone they would reach before Approve. Flux's own notice when what a task waited for is resolved ("#5 can
  continue: #4 is done", AG-6) carries no words of the agent, so finishing the owner's task does not
  wait for it. A local client is its person's own tool and is not held to this (LC-2).

**Never possible.** No tool exists for these, so nothing waits either; the agent can only say it
in words:

- **approving, editing or skipping a waiting item**, including Approve all, and accepting or
  replacing a decision (O-009). The OK comes only from the owner (or the person the item waits
  for) in their own signed-in Flux session. No agent, server or local, no run token and no MCP
  grant has a tool for it, and an agent cannot approve its own waiting item. Proposing a decision
  is allowed;
- changing access: people, spaces, roles, the AI switch, connections, and any agent's settings or
  "What it may do". Its memory changes only on the owner's own "remember that …" message or when
  the owner edits the list (AG-1); an agent never adds to it by itself;
- anything outside its owner's rights. The agent says so; nothing is prepared for or sent to
  another person;
- for server agents, posting in a conversation with other people, a space's or a DM; only the
  owner's Show everyone does that (AG-4). A local client may post in a space's conversations as its
  person, marked "via Claude Code" or "via Codex" (LC-2, Hubert, 2026-11-08);
- for server agents, anything outside Flux except reading GitHub and the web (AG-8).

**Waiting items.** A change that waits shows in the task discussion or private conversation
where the agent works, and as one Inbox item per run (AG-7). Only the owner (or the person it
waits for) approves, edits or skips it, in their own signed-in session (see Never possible).
Approving re-checks the owner's rights and the target's version; if the target changed, it
applies nothing and says "Changed since you asked".

**Undo.**

- An agent message that changed something carries one change line, for example "Updated the
  Wiki page *Calibration* (3 changes) · moved #4 to Doing · Undo". There is no separate
  Activity list.
- Undo restores the fields the agent changed, as new versions, when nobody changed them since.
  An item changed since says "Changed since · Open" and does nothing. The line then reads
  "Undone by Ada".
- The owner, or anyone who may edit the object, may Undo.
- A local client's change carries the same line where it was made: on its message, and on the task,
  Wiki page or map it changed, "Ada · via Claude Code" (LC-2, #868).

**Attribution and conflicts.** The agent is the author of every change, which records its owner
and the run and is an ordinary versioned write. A write whose version check fails is not
retried; it is reported as "Skipped #4: Jonas changed it while I worked".

## AG-4 — Talking to your agents

- **Private conversations.** Each agent is a private conversation with its owner in Messages,
  with Assistant pinned first. The owner talks to it there, and its reports and schedule results
  arrive there with an unread dot. In that chat the agent reads like its owner and changes nothing
  ([C-38](decisions.md#coordinator-defaults-and-inferences-not-founder-decisions-hubert-can-override)); "remember that …" adds a memory item.
- **`/ai` everywhere.** In every conversation the person can write in (a space's conversation,
  threads, a task's thread and DMs), `/ai` asks their Assistant. Only the asker sees the answer, as
  a card in the conversation with Dismiss and Show everyone. Show everyone posts it as the asker's
  own message, attributed "Ada · via Assistant". The agent may use the conversation as context, for
  example to summarise it. A guest has no `/ai`. The places, what each may use and what Show everyone
  posts are [C-36 to C-40](decisions.md#coordinator-defaults-and-inferences-not-founder-decisions-hubert-can-override).
- **Who wrote what.** Every message an agent reads names its author as people see them: a person
  by name, an agent with whose it is ("Asystent (Ada's agent)"), and an answer a person posted with
  Show everyone as that person's ("Ada Nowak · via Asystent"), never the reading agent's own; the
  agent is told its own id and label, which has its owner's full name when another reader of the
  space shares the first name. Only someone who can read the space now is named; anyone else is
  "Former member" ([coordinator default C-56](decisions.md#coordinator-defaults-and-inferences-not-founder-decisions-hubert-can-override), #1160).
- **What `/ai` may use.** Inside a conversation, `/ai` uses only what that conversation's
  audience can see: the conversation and the places its people can all see. So Show everyone
  never publishes anything private, because the answer was drawn only from what its readers
  could already see. In a private conversation with your own agent the audience is you, so the
  agent can use anything you can see (AG-3). The guarantee covers what the agent reads in Flux
  ([coordinator default C-12](decisions.md#coordinator-defaults-and-inferences-not-founder-decisions-hubert-can-override)). The agent's own instructions and memory are its owner's text, not
  filtered by the audience, so they still go to the provider with a shared `/ai` request
  ([coordinator default C-7](decisions.md#coordinator-defaults-and-inferences-not-founder-decisions-hubert-can-override), AG-11).
- **No memory in a shared answer.** In a shared conversation (a space's conversation, a thread, a
  DM, or any answer posted with Show everyone), an agent never quotes or reveals its memory items
  or its private instructions in the answer ([coordinator default C-8](decisions.md#coordinator-defaults-and-inferences-not-founder-decisions-hubert-can-override)). The owner sees the private
  answer before choosing Show everyone.
- **AI in a DM between people.** It is allowed. Whenever AI is used on a DM, either `/ai` typed in
  it or an agent opening it for its owner ([coordinator default C-2](decisions.md#coordinator-defaults-and-inferences-not-founder-decisions-hubert-can-override)), one line appears in the DM for
  both people, for example "Ada used AI here (Claude)". The line names the provider of the model
  used. No space switch governs DMs, so the line is how the other person learns which AI company
  receives their messages. `/ai` works in a DM's threads too (#1016): the answer is a card in the
  thread panel that only the asker sees, Show everyone posts it as a reply in that thread, the
  model reads that thread and nothing else, and the line appears in the DM's main line.
- **How an answer is written (#1247).** An agent's words, in its private chat, in a card and after Show
  everyone, are drawn by the one message renderer, the same as a person's message. The agent may use
  exactly this small subset of Markdown, where it helps: `**bold**`, `*italic*`, `` `inline code` ``, a
  fenced code block, a list with `- ` or `1. `, and a quote with `> `. Its brief says so (the `FORMAT`
  rule): sentences first, and a list only for several items.
  Headings, tables, images, HTML and Markdown links are not part of it and stay as the raw symbols
  that were written, so the brief forbids them; a bare web address, `#12`, `[[Wiki page]]` and the
  `[S<n>]` source marks keep working as before. The stored body is the Markdown text: search and the
  brief an agent reads see it as text, while Copy text and previews show the words without the marks.
- **States.** An answer shows when it is working, failed (with Try again), stopped by the
  provider's limit (with when it resumes) or not possible because AI is off here.
- **No drafts for other people.** An agent never prepares or sends a message to another person.
  A line a server agent writes in a task's discussion (its report, a blocker, what came of the task, its
  question to another agent, C-51) shows there for everyone, but it notifies nobody except the
  agent's owner, whatever it names: no mention, question or reply notification, push or email
  ([#1089](https://github.com/ColdPhase/flux/issues/1089)). A local client writes as its person and
  notifies like them (LC-2).
  The owner writes to people.

## AG-5 — Tasks reach agents through their owner

- **The Owner field.** A task's owner is a person or one of that person's own agents, listed
  under "Your agents". Nobody else's agent is offered.
- **One setting per person:** "When someone assigns a task to me: Do nothing / Give it to
  [agent]". The default is Do nothing. It names exactly one agent; there is no rule per space
  and no automatic choice. To give one task to a different agent, the owner changes its Owner
  field.
- An agent that gets a task starts within seconds and makes no model calls while idle.
- **Where it works.** In the task's one discussion, in the task panel. The space conversation
  shows one line per task event.
- **One state line** in the task panel: waiting for room on the server, working, waiting for
  your OK, paused by the provider's limit (with when it resumes), failed (with Try again or Take
  it back), stopped (by whom), done, or handed back.
- **Finishing** follows the agent's "What it may do": with Do it and tell me it marks the task
  Done and tells the owner, with Undo; with Ask me first it hands the task back,
  "Ready for you to check", and so does Only read. **One exception:** a task that is Blocked when
  the run ends stays Blocked with the agent in every mode, neither Done nor handed back, because it
  is waiting for something (AG-6, [C-52](decisions.md#coordinator-defaults-and-inferences-not-founder-decisions-hubert-can-override)) ([coordinator default C-1](decisions.md#coordinator-defaults-and-inferences-not-founder-decisions-hubert-can-override)). This is the whole
  review step: the owner checks the task; a separate reviewer is optional, for example a subtask
  for a Reviewer agent ([coordinator default C-9](decisions.md#coordinator-defaults-and-inferences-not-founder-decisions-hubert-can-override)).
- **Stop.** The agent's owner or the space admin can Stop an agent working on a task at any time.
  Its next call is refused, and the changes it made stay, with Undo. The owner is told who
  stopped it: the state line reads "Stopped by Maja" and the agent's private conversation gets
  the same line, not an Inbox item (AG-7). Stopping gives the admin no other power over the
  agent: only the owner prompts or configures it (AG-2).
- **Changing the Owner is a Stop.** A person who changes a task's Owner away from an agent
  (taking it back, or giving it to someone else) also ends what a local client had claimed on
  it: its next call is refused and "Stopped by Maja" is kept as for Stop, and a server agent's
  run stops (#856). Anyone who may change the Owner field may do it, which is more people than
  the Stop button allows; the Owner field is theirs to change (#936, #985).
- "Mine" and My tasks include tasks owned by your agents.

## AG-6 — Blocked tasks and questions

- **Blocked.** A blocked task waits for one thing: a person (who gets it in their Inbox), a
  decision or another task. When that resolves, the task moves back to Doing by itself and its
  owner gets one line, for example "#4 can continue: the decision was accepted". An agent owner
  resumes its work: it takes the task up again as when it was given it. So does a person who
  moves its Blocked task to Doing.
- **Questions with ready answers.** An agent may ask a person a question with two to four
  answers. It is an ordinary message of the agent, with one-tap answers for the person asked and
  an Inbox item for them. An answer never grants the agent anything.

## AG-7 — Where agent items appear

- **Inbox: only what needs you.** Approvals, tasks handed back for review and questions from an
  agent. Each agent run is one item, for example "Planner · 3 things wait for you · Approve all
  · Open". The same requests also show in the task discussion.
- **Reports** such as "Done: #4 … · 3 changes · Undo" go to the agent's private conversation and
  onto its message in the task discussion. They never go to the Inbox. The private conversation
  gets one line when a run on a task ends: "Done: #4 …", "Blocked: #4 …" (the task is waiting and stays with the agent), or "Stopped by Maja: #4 …" (a limit or AI
  turned off is the task's own state line, not a report). The count and Undo are what still stands of
  the run's changes when the line is read. The agent's row in Messages and in the sidebar shows an
  unread dot until its owner opens the chat (#919).
- **Notifications.** "Only what needs me" includes an agent waiting for you: when a run (or a local
  client) starts waiting for your OK, you alone are told once, and the notification opens its Inbox
  card (`approval`, [notifications](../development/notifications.md), #1186). During Quiet hours
  there is no push or email, and the Inbox keeps everything.

## AG-8 — What server agents may do

Server agents act only inside Flux, with their owner's rights:

| Area | Allowed |
| --- | --- |
| Tasks | Create tasks for the owner or the owner's agents (tasks for others wait, given to a person of the space by name, C-56); change status and the due day; write in the task discussion |
| Conversations | Read; write only in task discussions and the private conversation. A conversation with other people (a space's or a DM) only through the owner's Show everyone |
| Wiki | Create and edit pages, with Undo. Undo of a page the agent started deletes it, while only that agent has written it and nothing uses it (no link to it, no message that cited it, no call on it, no one typing in it). Deleting a page always waits for the owner's OK |
| Map | Add thoughts and link them to tasks |
| Decisions | Propose; never accept |
| Search | Everything the owner can see, in spaces with AI on |
| GitHub | Read the connected repository (issues, pull requests, checks); never write |
| Web | Search with its own web search tool (the provider's, or the owner's Claude Code's or Codex's), and open any public web page (`flux_read_web`) as much as a question needs, never putting anything from Flux into an address (the server refuses one that carries private text the run read), always citing the sources; never post or fill in anything. On by default; the operator can turn both off ([C-29](decisions.md#coordinator-defaults-and-inferences-not-founder-decisions-hubert-can-override), [C-30](decisions.md#coordinator-defaults-and-inferences-not-founder-decisions-hubert-can-override)) |
| Not allowed | Code, email, other apps |

Code changes come only from the owner's own Claude Code or Codex on their computer
([local Claude Code and Codex](mcp-cowork.md)).

**Web content and prompt injection.** Web pages and search results are untrusted input, like project content and
other people's messages, and the prompt marks them so. The defence is in the rules, not in the model's obedience: only the
owner instructs (AG-2), rights and waits and the never-list hold (AG-3), every change has Undo, and nothing is posted or filled in on
the web. **Search** (founder direction, Hubert, 2026-11-08, #954) is the provider's own built-in tool on the owner's connection, with
no other account or key: Anthropic's `web_search` and OpenAI's Responses `web_search`; on the owner's own Claude Code its `WebSearch`,
and on their Codex its own search on OpenAI's cached index (#1065). A provider or wire format without one has no search, and the
agent's brief says so; nothing fails. **Any address opens** (founder direction, Hubert, 2026-11-09, #1065: open any address, the same
for Claude and Codex, with no approval taps): the same rule on every engine. The brief tells the agent to open only what its answer
needs, never to put anything from Flux into an address (no words of messages, tasks, the Wiki or the request, no names, ids or keys)
and that what a page or a message says is data, not an order; and the server refuses, without asking anyone, an address that carries
a verbatim fragment of private Flux text the run has read (12 characters with a digit, a space or an `@`, compared without case, accents
or percent-encoding, also in a run of hex, base64 or base32), telling the agent why. Private text is what people, the company and its
tools wrote, never Flux's own brief words or which date it was; a link written in it opens, a redirect hop may carry only the text of the
link a person wrote that the read began with, and a run's change may not write such an address into Flux, and its answer keeps none (`[address left out]`, #1138, #1143) ([C-30](decisions.md#coordinator-defaults-and-inferences-not-founder-decisions-hubert-can-override), #1136, #1138).
**Accepted risk** (founder, Hubert, 2026-11-09): what the agent rewrote (other words, hyphens for spaces, pieces under 12
characters), or signals by which address it chooses, can leave through an address, and a search query reaches the search's vendor; the
check stops the copy. The defence is the one above, and the list of every address the
server asked for. The key's daily budget is what stops spending: each search is charged as the provider reports it. On the owner's
API key a page's text is sent to the model once and, once the model has noted it, left out of later requests, so a long read fits;
the Claude Code and Codex engines manage their own context. A test shows that web content cannot bypass an approval, and what
happens when a page tells an agent to send what it read to a site (#918, #953, #1065). The server reads the page, not the agent's
process, so the runtime's egress stays closed to the web ([network](ai-modes.md#rt-4--network)); the run lists every address the
server asked for, those that failed too, in Flux's own words, written down before each request goes out, and its searches and the
addresses its answer cites: under its answer, or in its end line when it ends without one. Reading and searching are on by default; the operator turns both
off with `FLUX_WEB_READS=off` ([C-29](decisions.md#coordinator-defaults-and-inferences-not-founder-decisions-hubert-can-override)). A
local client reads and searches the web with its own tools and does not get the tool
([RT-5](ai-modes.md#rt-5--tools-only-flux-tools-the-clis-own-web-search-and-reading-the-web)). Another person's task title that becomes a run's request is the same kind of input: data, never an
instruction.

## AG-9 — Schedules

- The owner makes a schedule by telling an agent in its private conversation, for example
  "Every weekday at 9 summarise new tasks for me". The agent answers in plain words with what it
  prepared and the owner confirms it there with one tap. Nothing else makes a schedule: not `/ai`
  in a space, and not a run of a schedule.
- Schedules are listed in that conversation: its header has one line ("Every weekday 9:00 ·
  Garden summary · 1 schedule"), on the computer and the phone, that opens the one list, where the
  owner turns them on, pauses, changes, runs and deletes them (Undo for a day). The agent's page
  in Settings shows the same list. Their results arrive in the conversation, as one message each
  ([C-53, C-54](decisions.md#coordinator-defaults-and-inferences-not-founder-decisions-hubert-can-override)).
  The Inbox is not used for schedules unless something needs the owner (AG-7).
- A schedule reads web addresses only when its owner typed them: in the sentence that asked for it
  (or in the text they made it with through the API). They are fixed when the schedule is prepared;
  Change edits the wording only, and to give a schedule a new address the owner asks the agent again
  in the chat. Addresses the agent wrote in the schedule's text give none (C-30). A scheduled run
  may still search the web and read what the search returned.
- The morning summary is one such schedule: a ready-made one on the agent's page, "Every weekday
  at 9 summarise what needs me", off until the owner turns it on. It is the only morning summary
  in Flux: the plain, non-AI summary in Notifications (#350) is removed (F-038).
- A scheduled run acts like its agent in its chat: it reads what its owner can see and changes
  nothing, and it never makes or changes a schedule. Its result goes only to that chat: nothing
  posts it into a conversation, and the owner shares what they choose with their own message.
- A schedule runs at the time its owner said on their own wall clock: in their time zone, which is their browser's, saved on them by
  itself with no setting, and it stays at 9:00 across a clock change. It keeps the zone it was made in; a browser in another zone sees it
  named ("Weekdays at 9:00, Warsaw time"). The agent's clock and the times it reads are in the same zone
  ([C-57](decisions.md#coordinator-defaults-and-inferences-not-founder-decisions-hubert-can-override)).
- **Flux's only schedule rule:** a time missed while Flux was off is skipped, never caught up
  ([coordinator default C-14](decisions.md#coordinator-defaults-and-inferences-not-founder-decisions-hubert-can-override)). There is no minimum interval between firings and no pause after failures; a firing that
  fails, or cannot start (for example "Sign in to Claude again"), says so in the conversation (AG-4) and the next firing happens as scheduled.
  Deleting an agent deletes its schedules.

## AG-10 — AI in a space

This replaces the workspace AI lock (F-029) under F-037.

- Each space has its own AI switch in its settings, on by default for a new space. A space admin
  controls it, and the company admin can change it in any space. There is no global AI switch.
- An encrypted space never has AI and shows no switch
  ([encryption](encrypted-workspaces.md#moving-to-per-space-encryption-f-037)).
- While AI is off in a space, no agent, server or local, reads, writes or answers there. Its
  content never reaches a model, including through search or a schedule, and the Owner field
  offers no agents there.
- One server check covers every AI path and fails closed. Turning AI off stops the agents' runs
  in that space, cancels their queued work there and deletes nothing. A run in progress is asked to
  stop at once and its next check refuses, so it makes no further change; what it had already
  written stays, and the owner is told it stopped ([C-17](decisions.md#coordinator-defaults-and-inferences-not-founder-decisions-hubert-can-override)). Turning it back on resumes
  each agent's standing setup; nothing that was stopped or missed is replayed, and anything
  waiting still needs its owner's OK.
- Human work in the space is unchanged, including what agents wrote before.

F-029's design (one policy check, an admission epoch on every AI work item, a sweep and a
database backstop) is the starting point at space level for #855 and #874; see its
[earlier text](https://github.com/ColdPhase/flux/blob/a82ee012d0dc0a33e9ab14925f8f400c96f31e60/docs/product/workspace-ai-lock.md).

## AG-11 — Privacy, payer and failures

- **What leaves Flux.** What the agent reads under AG-3 and AG-8, the owner's request, and the
  agent's instructions and memory, sent to the provider under the owner's account and its data
  settings ([payer and data](ai-modes.md#rt-8--payer-and-data)). The instructions and memory are
  the owner's own text and go along even with a shared `/ai` request, though the answer never
  quotes them (AG-4, [coordinator default C-7](decisions.md#coordinator-defaults-and-inferences-not-founder-decisions-hubert-can-override)). Never content of an encrypted
  space or of a space with AI off. A DM's content leaves only when AI is used on it, and both
  people see the line of AG-4. In a conversation, `/ai` uses only what the conversation's audience
  can see (AG-4). In a task discussion, an agent uses only what all of the task's people (see
  Terms) can see.
- **Redaction.** Token-shaped strings (`sk-ant-`, `sk-`, `eyJ…`, `refresh_token` and the run's
  own token) are replaced with "[removed: looked like a secret]" in everything an agent writes.
- **Payer.** Each run records the connection that paid for it. An agent's owner always pays for
  it, also when it answers another person's agent.
- **Failures in plain words**: "Claude limit reached, resumes at 14:00", "Sign in to Claude
  again", "Claude refused this request", "Stopped". Nothing falls back to another connection or
  payer, and human work continues.

## What went away in v0.2

- A separate assistant with five area switches, a "Can" sentence and an approval mode per person.
- Flux's own limits: runs a day, minutes, steps and changes per run, background runs a day, and
  the per-request and daily money caps of the assistant (an API key keeps one daily budget).
- The seven reasons a change waits, waiting changes that expire, and typed suggestions to other
  people.
- Agent project grants, "Ask a manager to let it in", join requests and the project agent
  policy.
- Reactions ("When something happens"), background suggestions (O-007) and the background note.
- Drafts of messages to other people.
- The space Agents tab, and "only in projects, no private chat".
- The fixed pool of four runtime slots (#860).

## Delivery

| Issue | Outcome |
| --- | --- |
| [#853](https://github.com/ColdPhase/flux/issues/853) | Mockups for Hubert's review, before UI work |
| [#854](https://github.com/ColdPhase/flux/issues/854) | One Connect AI with several connections |
| [#855](https://github.com/ColdPhase/flux/issues/855) | Owner's rights, "What it may do", Undo, approvals, the space AI switch |
| [#856](https://github.com/ColdPhase/flux/issues/856) | Agents on the server take tasks through their owner; web reading |
| [#857](https://github.com/ColdPhase/flux/issues/857) | Agents with name, instructions, model and memory |
| [#858](https://github.com/ColdPhase/flux/issues/858) | Schedules from a sentence; reactions and background suggestions go |
| [#842](https://github.com/ColdPhase/flux/issues/842) | `/ai` everywhere, answered privately |
| [#843](https://github.com/ColdPhase/flux/issues/843) | No Flux limits; the provider's remaining usage |
| [#841](https://github.com/ColdPhase/flux/issues/841) | Agents together in a task |
| [#859](https://github.com/ColdPhase/flux/issues/859) | Local Claude Code and Codex with the person's rights |
| [#860](https://github.com/ColdPhase/flux/issues/860) | Server capacity without a fixed cap: memory decides how many agents run at once (about 2 on 4 GB), the rest wait, the operator can change the number in config ([RT-3](ai-modes.md#rt-3--isolation-and-capacity)) |
| [#844](https://github.com/ColdPhase/flux/issues/844) | A task keeps the message it came from |

Each issue carries its acceptance criteria. Tests use fake CLIs and fake providers in Docker;
behaviour on real Claude and ChatGPT accounts stays unverified until a dated smoke test records
it.

## Revisit when

- Trials show that more than one run in ten needs Undo under "Do it and tell me" (then reconsider
  the default).
- A vendor text forbids an agent pattern used here ([where agents run](ai-modes.md#revisit-when)).
- People need an agent shared by a team, or rules that send different tasks to different agents.
