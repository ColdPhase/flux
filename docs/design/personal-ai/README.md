# Personal AI assistance — interaction design (#57)

**Status:** proposed for independent evaluation in [#57](https://github.com/ColdPhase/flux/issues/57), 2026-09-27, by `claude-maurycy`. Evaluator: `codex-hubert`.
**Builds on:** the C direction (`docs/design/direction.md` on PR #33, branch `claude-maurycy/task-15-ui-direction`), the #40 shell components, [access policy](../../development/access-policy.md) (agents capped by their owner) and O-005 on PR #53 (first path: user-operated Claude Code through a personal Flux MCP grant).
**Prototype:** [`prototype.html`](prototype.html) is static and self-contained. Its first `<style>` block is variant C's stylesheet copied verbatim (tokens, motion, components). The second block adds only the assistant components, and it adds no colours. The Flux identity is the founder-chosen **rail** option (a dark 60 px rail with the indigo accent), and it is the default here. `?identity=accent` shows C's earlier default.

This design covers how the product looks and behaves. It does not show that billing, permissions or persisted actions work. Those need the implementation work in [Enforcement and follow-up work](#enforcement-and-follow-up-work).

## Principles

1. **People work, the assistant helps.** Conversation, map, tasks and docs are complete without AI. An assistant never takes focus, moves or reorders map thoughts, cards or messages, or posts unless its owner asked.
2. **Every assistant belongs to one person.** It is always named after its owner ("Kai's assistant"). Only the owner can ask, retry, continue, pause or pay for it. The UI never offers another person's assistant.
3. **An answer can be shared, the assistant cannot.** An answer is visible to the audience of the place where it was asked, and to no one else. Others can read it and reply to it as an ordinary message. They can ask their *own* assistant about it.
4. **A request is done, an unrequested change is proposed.** A clearly requested, bounded, low-impact action runs without an extra approval click and can be undone. A change to shared commitments (results, decisions, owners, status, audience) is a proposal until a person with that authority accepts it.
5. **Quiet by default.** Ownership is one line of text on the message ("Kai's assistant · asked by Kai"). Grant, payer, cost and controls are in Details, not on every message.

## Surfaces

| Element | Where | Behaviour |
| --- | --- | --- |
| **Ask my assistant** | A quiet ✦ icon button inside the composer, and `/ai` or `/` in the composer. Also *Ask my assistant* on a selected map thought, in a task's actions, on selected doc text, and under someone else's answer. | It turns on *ask mode*: an accent chip "Your assistant ×" above the box, plus one line saying who will see the answer ("Answer shown to Kai and you") and the payer with the expected cost ("paid by you, about $0.01"). Esc, ×, or Backspace in an empty box return to a plain reply. One request, then the composer goes back to a plain reply. |
| **`/` commands** | Typing `/` at the start of the box. | A small list headed "Your assistant · only you can use it": *Ask my assistant* `/ai`, *Summarize this conversation* `/sum`, *Add a thought to the map* `/map`. Arrow keys move, Enter or Tab picks, Esc closes. With AI turned off, `/` opens nothing. |
| **Working line** | In the feed, where the answer will appear. | "Your assistant is reading this conversation and 2 linked sources…" with **Stop**. Stopping posts and saves nothing. |
| **Answer** | In the feed, as a message. | An agent avatar (a rounded square with ✦), "**Jo's assistant** · asked by Jo", the request in quotes, then statements labelled **Fact**, **Interpretation** and **Proposal**. A fact has an inline source link. The evidence line reads "Used 2 sources you both can open". Only the owner sees Retry. A peer sees *Ask my assistant about this*. |
| **Done action** | A quiet system line with a ✓. | "Your assistant added the thought 'ToF sensor: swipe + hold' to the Sensor options map, next to Camera · asked by you" with **View on map** and **Undo** (owner only). The thought also carries "Added by Jo's assistant · asked by Jo". |
| **Proposal** | The only framed object an assistant adds. | The label "Proposal · not saved yet" with an open ring, a title, Fact / Interpretation / Proposal, and one line on the effect ("Accept saves the result and finishes *Camera in low light*, which you own"). **Accept · Edit · Discard** appear only for a person with authority. **Others see "Jo's assistant drafted this — proposal"** and "Waiting for Jo". After Accept: "Result recorded by you · drafted by your assistant", with Undo. |
| **Proactive suggestion** | One line after the latest message, above a dashed rule. The owner sees it; nobody else does. | "🔒 Only you see this · your rule 'Point out conflicts with new results'", one sentence, then **Show suggested edit · Not now · Don't suggest again**. The edit opens as a diff in Details, with **Apply edit · Edit first · Dismiss**. A dismissal is kept until the evidence changes. |
| **Header status** | A ✦ icon button next to Details, with a small dot. | Green dot: ready. Ring: paused, or stopped at the cap. No dot and the label "Connect your AI": no connection. With AI turned off, the button is hidden. |
| **Assistant details** | Side panel on desktop; a full-screen sheet on the phone. | See below. As a sheet (≤ 980 px) and in the drawer, the rest of the page and the skip link are inert. Tab and Shift+Tab cycle inside, and a hash-opened sheet starts with focus inside it. Esc returns focus to the trigger. |
| **Someone else's assistant** | Opened from "About Kai's assistant" on the answer. | "Kai's assistant · only Kai can use it". The panel says you can read and reply, but can't retry, continue or spend Kai's budget. It shows who asked and when, what it read (only sources you both can open), and who the answer is shown to. It shows no cost, credentials, history or hidden sources. It offers *Ask my assistant about this*, or *Connect your AI*. |

### Assistant details (owner only)

- **Status and controls first:** "● Ready · only you can use it", then **Pause** (or **Resume**, or **Raise cap**) and **Disconnect**. "Pause or disconnect stops work before its next read or save. Kai and you keep working as usual."
- **Three separate questions:**
  - *Who can use it:* only you.
  - *What it can read and change here:* this project only. It adds map thoughts and edits your drafts when you ask. Results, owners, decisions and audience are proposals only.
  - *Who sees its answers:* the people in the conversation you ask in.
- **Cost and consent:**
  - Paid by: you, personal key.
  - Today: $0.08 of your $1.00 daily cap, with a meter.
  - This month: the total and the number of requests.
  - "At the cap it stops and says so. It never switches to another payer or to someone else's connection."
- **Suggestions:** each rule is a switch, with its scope, frequency and effect: "Gesture lamp only · at most 3 a day · drafts, never edits". A note says how many dismissed suggestions stay hidden.
- **Recent actions**, each with its requester and whether it can be undone.
- **Outside Flux:** "Claude Code on your laptop can reach this project through a personal Flux grant, with the same limits. It uses its own plan; Flux can't see that cost." When the payer is an external client, the cost row says exactly that. It never shows a made-up number.

### States

| State | Prototype | What changes |
| --- | --- | --- |
| Ready | default | As above. |
| **No connection** | `?ai=none` | ✦ opens "You haven't connected an assistant. Kai's can't be used for you. **Connect your AI**", and Send is disabled while ask mode is on. Kai's answers stay readable. *Connect your AI* explains that Flux works fully without AI. It lists Claude Code (personal Flux grant) and a personal API key (not available yet), plus **Don't offer AI to me**. |
| **Cap reached / out of quota** | `?ai=limit` | The header shows a ring. Ask mode says "Stopped at today's $1.00 cap. It won't use another payer. **Raise cap**". Suggestions stop. Proposals already made can still be accepted, because accepting is a human action. |
| **Paused** | Pause in Details | Nothing runs or suggests. Ask mode shows "Paused. **Resume**". |
| **Revoked, disconnected, or access lost** | Disconnect in Details | The panel switches to the no-connection state. Queued work stops before its next read or commit. Earlier answers and accepted results stay, with their provenance. An uncommitted draft is withheld. |
| **No AI** | `?ai=off` | No ✦, no `/` menu, no assistant lines. The same day reads "You added the thought…" and Kai replies. Conversation, map, tasks and docs are unchanged. |
| **Peer view** | `?as=kai` | Kai sees Jo's action line with no Undo, and Jo's proposal as "Jo's assistant drafted this — proposal · Waiting for Jo". He does not see Jo's private suggestion. His own earlier answer offers him Retry. |

Phone: a single column, as in C. The feed opens at the first line of the proposal waiting for you, never mid-card. Authorship, title, facts, effect and Accept are read together, and a **Latest** pill leads to the newer messages. Without a pending proposal it opens at the latest message. ✦ sits in the composer and in the header. Ask mode's cost text shortens to "Answer shown to Kai and you". Details and the diff open as full-screen sheets, and the proposal buttons fill the row. Touch targets are 44 px.

## Context and audience boundaries

- **A run reads only the place it was asked in.** A project run reads that project's conversation, map, tasks and docs, intersected with the owner's current rights and the agent grant. A DM run reads that DM. The owner's other projects, DMs and private captures are never included, and the evidence line says so ("From this project only…").
- **Sources in a shared answer** are limited to what everyone in that audience can open. Hidden sources are not named or counted.
- **Widening an audience** (DM → project, project → another project) is never an assistant action. It is the human publication flow, with a preview of the exact content and recipients (#44).
- **No silent changes.** Commitments, decisions, owners, status, audience and other people's content change only through Accept by an authorized person, and each change keeps "drafted by …'s assistant". A requested edit to your own draft or map thought is applied directly with Undo. Nothing changes layout or focus.

## #57 requirements → design elements

| #57 requirement | Design element |
| --- | --- |
| §1 Human work is the main flow; useful with no AI | No-AI state (`?ai=off`): the whole feed, map, tasks and docs work. AI is one ✦ button and `/`. Principle 1. |
| §1 Explicit `/ai summarize` answers directly | `/sum` → working line → attributed answer, with no approval step. |
| §1 Explicit authorized bounded action performs it | "Your assistant added the thought…" line with Undo. The map node is attributed. |
| §1 Unsolicited ideas are a limited, marked preview | The private suggestion line and the diff in Details. Nothing changes until **Apply edit**. |
| §1 Proactive help needs owner rules with scope, purpose, effects and limits | The rule switch in Details: "Gesture lamp only · at most 3 a day · drafts, never edits". The suggestion names its rule. |
| §1 Suppress dismissed suggestions; pause or disable rules; human work continues while stopped | **Don't suggest again** → "…unless the evidence changes". Pause, and the rule switch. The paused and cap states leave the human flow unchanged. |
| §1 Preserve place, drafts, layout; no taking focus | The answer appears in place of the working line. The composer draft and scroll are kept. The map is never rearranged; selecting a thought opens no panel. |
| §2 Personal connection, owner-only invocation; `/ai` resolves to the requester's own connection | The ✦ and `/` menu are always "your assistant". The list header reads "only you can use it". Retry is owner only. |
| §2 No connection → "Connect your AI"; never fall back to a peer | The `?ai=none` ask bar: "Kai's can't be used for you. Connect your AI". Send is disabled. |
| §2 Same rule for retry, continue, buttons | Peers get no Retry or Undo on another person's run. They get *Ask my assistant about this*. |
| §3 Shared answer shows "Hubert's AI / requested by Hubert" to that conversation only | "Kai's assistant · asked by Kai", and "Answer shown to Kai and you" before sending. |
| §3 Peers discuss the answer; they can't continue the owner's paid run | Kai's human reply under Jo's proposal. The panel for someone else's assistant. |
| §3 Three concepts kept separate | The three rows in Details: who can use it, what it can read and change, who sees its answers. |
| §3 No private-context injection or leaks; no credential or billing exposure | "Used 2 sources you both can open" and "From this project only". The peer panel shows no cost or history. |
| §4 Help across map, docs and tasks, not only chat | *Ask my assistant* on a map thought, in task actions and on doc text. The result proposal on an experiment. The doc edit suggestion. |
| §4 Consequential changes stay with authorized people; attribution and undo | Proposal with Accept, Edit and Discard only for the owner of the experiment. "Result recorded by you · drafted by your assistant". Undo. |
| §4 A text reply is not proof that an action was saved | The done line appears only for a saved change. A proposal says "not saved yet". |
| §5 MCP is a separate, personal entry point | "Outside Flux" in Details. *Connect your AI* lists Claude Code (personal Flux grant) separately from an in-Flux key. |
| #44 Fact / interpretation / proposal; cost caps; no loops | Claim labels on every answer and proposal. The daily cap and meter. The rule's frequency cap. Assistant output never triggers another assistant, because rules react to human events and results. |
| AC-2 owner and non-owner cases, no-agent and out-of-quota states, bounded action preview and result, quiet suggestion, human continuation | Prototype states: default, `?as=kai`, `?ai=none`, `?ai=limit`, proposal → accepted, suggestion, `?ai=off`. |

## Enforcement and follow-up work

The UI only reflects decisions the server makes. Hiding a button is not enforcement. For implementation (AC-3):

| Rule | Where it is enforced | Work |
| --- | --- | --- |
| Invocation, retry and continue resolve to the **authenticated requester's** connection. A browser-supplied owner or connection ID is ignored. | Run API, WebSocket command handler and job enqueue, through `policy.ts` (`agent.invoke` owned by the requester). | #29 policy action plus [#68](https://github.com/ColdPhase/flux/issues/68) (in-product personal runs). Tests: a peer calls the run endpoint, retries or replies, and no model call or quota use happens on the owner's connection. |
| A run reads only (owner rights ∩ agent grant ∩ requested place). The output audience is that place. | Domain read methods and worker rechecks before reads and before commit (#29 AC-3, PR #47). | #29 / #47. Tests: a DM or private capture is never present in a project run's input, and a revoke mid-run commits nothing. |
| A consequential change is a proposal object. Accept needs human authority. | Domain use cases (result, decision, task and audience). | #52 proposal tools, then map, doc and task mutation tools as their domain APIs arrive. These stay tracked and unimplemented until then. |
| Cap, pause and revocation stop work; there is no payer fallback. | The run scheduler checks the owner's standing authorization at every step. | [#68](https://github.com/ColdPhase/flux/issues/68), which depends on a compute-source decision under O-005. |
| Proactive rules: owner, scope, frequency, dedupe by rule and source revision, suppression of dismissed suggestions, no triggering from agent output. | Rule engine / worker. | The #37 proactive follow-up. |

In-Flux `/ai` needs an accepted compute contract (O-005: "embedded/API/local … requires a separately accepted compute owner…"). Until then, the MCP path uses the same labels, attributions and proposal objects, and ✦ shows *Connect your AI*.

## Required examples → enforcement (AC-3), 2026-10-02

The founder's ownership model is recorded as [F-019](../../product/decisions.md). The table
below maps every required example from #57 to the server rule that enforces it, the
regression that pins it, and where it stands on `main` at `9c96cbe2` (after #176 and
#124 merged). Every merged
behaviour runs on fake or mock compute in Docker. **No real provider call, billing or
device is claimed.** Personal runs still fail closed in production until their connection
lookup is wired to #124's key custody and a real provider pass lands; see
[personal runs](../../development/personal-runs.md). Owner background rules (#124) are merged
with production activation still disabled ([proactive comparison](../../development/proactive-comparison.md)).

| Example | Enforced by | Regression | State |
| --- | --- | --- | --- |
| Hubert invokes `/ai` in a shared conversation | `POST /api/v1/conversations/:id/assistant-runs` resolves the owner from the session; a body naming another owner, agent or connection is `403 PERSONAL_RUN_NOT_OWNER`. The committed answer is labelled as Hubert's AI and requested by Hubert. | `personal-runs.test.ts` AC-1 (the `403 PERSONAL_RUN_NOT_OWNER` refusal), AC-3 and AC-5; owner-only `agent.invoke` in `core/src/access/policy.ts`; browser `test_personal_assistant` | Merged (#141, #142, #161), fake compute |
| Maurycy has no connection; `/ai`, a mention or reply, or the run endpoint | No route reaches Hubert's assistant. Runs, stop and retry are owner-only (404 otherwise). The stream ignores every client frame, so there is no WebSocket command path. | `personal-runs.test.ts` AC-1: "another person reaches the owner's assistant by no route". The same test sends `assistant.run`/`assistant.stop` frames on the stream, and nothing happens | Merged |
| Maurycy connects his own agent | His run uses his enablement, connection and cap only; Hubert's usage is unchanged. | `personal-runs.test.ts` AC-3 | Merged, fake compute |
| A connection is unavailable, paused, capped or revoked | Explicit state (`unavailable`, `paused`, `capped`, `cap_reached`); zero cost before dispatch; no payer fallback; human work continues. | `personal-runs.test.ts` AC-2 and AC-4 | Merged |
| Hubert asks for a permitted map/wiki/task change | **Via MCP:** standing-grant native actions through the canonical commands and the #152 execution port. Tasks, results and decision proposals are merged (#174); shared-map actions are merged (#176). MCP can propose a decision, never accept it. **In product:** assistant proposals that only a person with authority accepts. | `mcp-work-actions.test.ts`, `mcp-map-actions.test.ts` (#176), `personal-runs.test.ts` AC-7 | Tasks, results, decision proposals and map actions merged, fake compute. **Wiki/doc edits and done-with-undo actions from a personal run are not implemented**; tracked in #68 and #152 |
| AI has an unsolicited idea | Only owner-enabled rules can act, and they produce a quiet, editable, dismissible proposal. Production rule activation stays unavailable until #58's runtime gates pass. | `proactive-comparison-rules`, `proactive-outcomes` (#124) | Merged (#124), fake/mock compute; production rule activation still disabled |
| A background rule is paused or revoked, or the owner loses access mid-job | Recheck before reads, dispatch and commit; revocation commits nothing. | `personal-runs.test.ts` AC-6 (both cases); `proactive-comparison-cancellation` (#124) | Merged (personal runs; #124 rules), fake/mock compute; production activation still disabled |
| An external MCP client authenticates as Maurycy | Reads and writes require the bearer's own connection, selected projects, scopes and standing grants, rechecked on execution and replay. Another owner's runtime or connection cannot be selected. | `oauth-mcp.test.ts` (three named connections, two owners; revocation); `agent-proposals.test.ts`; `mcp-work-actions.test.ts` | Merged (#103, #167, #174) |
| A shared answer is prepared | Input is only the requested place's project-audience sources. DMs, private captures and other projects never enter input or output. `GET …/assistant-answers` exposes no cost, cap, connection or hidden source. | `personal-runs.test.ts` AC-5 | Merged |

**Live sessions** (founder direction on #57). No AI run receives audio, video or screen
data, and no audio-notes feature exists. Any future one is separately scoped, outside
milestone 2, and must meet the consent and pause rules of
[live collaboration §5](../../product/live-collaboration.md#5-personal-ai-help-and-optional-audio-notes)
before it can be offered. This is a deliberately unimplemented capability, not a delivered
one, and it has no implementation issue.

**Still required, owned and tracked:**
- #68: real connection custody and provider pass, done actions with undo, the header
  status and "someone else's assistant" panel, real devices.
- #152: wiki/doc agent actions and real Codex/Claude clients.
- #58: production activation of owner rules (merged in #124, still disabled).
- #179 / F-020: the same rules for every provider and model.
- #57 AC-4: independent peer check, recorded on #57 (2026-10-02).

## Verification (2026-09-27)

Both scripts run in Docker (`mcr.microsoft.com/playwright/python:v1.62.0-noble-arm64`, with `pip install -q playwright==1.62.0`), from the repository root:

```sh
docker run --rm -v "$PWD/docs/design/personal-ai:/work" -w /work \
  mcr.microsoft.com/playwright/python:v1.62.0-noble-arm64 \
  sh -c "pip install -q playwright==1.62.0 && python3 tools/audit.py && python3 tools/interactions.py"
```

- **`tools/audit.py`** is adapted from O-003's audit. It covers 38 states from 1440×900 to 360×780, both identities included, with touch emulation at 1024 px and below. Results: 0 horizontal overflow, 0 console errors, 0 text contrast failures below WCAG AA, 0 visible text under 12 px, 0 touch targets under 44 px in either width or height. Inline references in sentences need only 24 px, under the WCAG 2.5.8 inline exception. At 200% zoom there is no overflow in the default, assistant and ask states. On the software keyboard (390×480, ask mode), the composer and ask bar stay visible. The first 40 Tab stops show a focus ring every time: 39 stops default, 38 with no AI, 39 as Kai. Under reduced motion, 0 elements animate. Raw output is in `audit.json`, and screenshots are in `screenshots/<w>x<h>-<state>.png`.
- **`tools/interactions.py`: 63/63 checks pass.**
  - Reply, the `/` menu with the keyboard, ask mode and its audience, the working line, Stop, and the attributed labelled answer.
  - Accept, Discard, Undo on the map, and dismissing a suggestion.
  - Pause blocks sending, and Esc returns focus.
  - The peer view: no Accept or Undo, no private suggestion.
  - No connection, cap reached, and no AI.
  - The phone modal sheet, and map selection without a panel.
  - At 390×844 and 360×780, authorship, title, fact, effect and Accept are all in the first view. Tab goes from the fact's source to Accept.
  - Five modals, click-opened and hash-opened (assistant and sources sheets, the drawer): focus starts inside and the skip link and page are inert. 30 Tab and 30 Shift+Tab never leave the modal, and Esc restores focus to the trigger.

**Not covered:**
- dark-theme contrast;
- screen readers;
- real devices;
- any real model call, billing, permission or persistence.

Two design iterations came from the screenshots:
1. The first desktop screen was mostly assistant output. The fix added the human flow around it, shortened the proposal and suggestion, and moved Pause next to the status.
2. Map edge labels were truncated, and the claim labels drifted off their lines.
3. Review of `87d077f` found three problems, all now fixed:
   - B1: the phone view opened with the actions visible but not the proposal they act on.
   - B2: focus could escape the modals.
   - B3: the target audit tested width against 24 px only.

## Open questions

1. **Is the proactive suggestion line (owner only, after the latest message) the right home, or should it live only in Home's return view?** The current choice keeps it next to the evidence it is about.
2. **Should the default for a *requested* edit to someone else's doc paragraph be to apply it with Undo, or to make it a proposal?** The current choice: your own content is applied; other people's is proposed.
3. **Should the daily cap be set once per person, or per project?** The prototype shows one personal daily cap.
