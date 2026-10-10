# Design partners for v0.1

- **Status:** draft for the founders, 2026-10-10. Part of L-4 in the
  [v0.1 launch plan](launch-v0.1.md), tracked in [#308](https://github.com/ColdPhase/flux/issues/308).
  Owner: claude-maurycy (Zamojski5). Evaluator: claude-hubert (PelikanFix16).
- **Basis:** rules 16 and 17 of the [delivery playbook](playbook-the-5.md). Good design partners
  adopt early, match the problem and commit time. Friends and family feedback misleads.
- **Who decides:** the founders choose the teams, contact them and decide every message sent to
  them. Agents never do outreach. This file describes the kind of team to look for; it names no
  real team. The founders keep the shortlist and contacts outside this repository, and a partner
  is named in public only with their consent.

## Who we look for

We look for 3–5 teams, each of which meets all four conditions:

1. **Already working with coding agents.** People on the team use Claude Code, Codex or a similar
   MCP-capable client every week on shared work, not only for experiments.
2. **Has the problem Flux solves.** Work is discussed in one place, decided in another and tracked
   in a third. Someone who returns after a break, or takes over from a person or an agent, has to
   rebuild what was decided, what is current and what is next. This is the return and handoff
   journey of the [first segment proposal](first-segment-and-usp-proposal.md) (H1 and H2).
3. **Small and able to adopt now.** 2–8 people, at least one of whom can run Docker on their own
   machine or server. They can decide to try a tool without a procurement process.
4. **Will commit time.** One real, non-sensitive project in Flux for four weeks, with a named
   person who sends feedback each week.

**Not a design partner** (rule 17): friends, family or former colleagues who would try Flux as a
favour; solo users; teams that do not use coding agents; teams that need a hosted service, an SLA
or sensitive data in Flux before v0.1.

## Four profiles

The founders pick 3–5 teams across these profiles, at most two from any one profile; not every
profile needs a team. A spread of profiles keeps one team's habits from becoming the product.

| Profile | Situation | What they test |
| --- | --- | --- |
| **A. Small product team** (3–6 people: product lead, designer, engineers) | Discuss in chat, keep briefs in a docs tool, track work in GitHub or Linear. Agents write part of the code. People come back to a project after a week on something else. | H1: after a break, can the returning person find the current decision, its reason and the next step faster than with their current tools? |
| **B. Technical founders with agents** (2–3 people) | A small product where agents do much of the implementation. Handoffs between people and agents happen every day; context lives in issue threads and handoff files. | H2: can a person or an agent pick up a partial result safely, with AI on and with AI off? Does reviewing agent suggestions cost more than it saves? |
| **C. Open source maintainers** (2–5 people) | A public project with outside contributors and agent-written PRs. Decisions are scattered across issues, chat and calls. | Self-hosting and handoff: install, backup and upgrade on their own server; whether decisions and tasks stay connected to the conversations they came from. |
| **D. A satisfied control team** (3–6 people) | Already happy with a linked chat, docs and tracker setup, or with Plane. | Whether Flux is better at all. The segment proposal asks for such a team so the test can reject H1 or H2. |

## What we ask of a partner

- Install Flux on their own machine or server with the [README quick start](../../README.md#quick-start),
  and tell us how long it took.
- Connect their own agent client and run the [first journey](partner-onboarding.md#4-the-first-journey)
  on one real project with non-sensitive data. Flux is pre-release.
- Use it for four weeks, and send feedback at least once a week through the
  [partner feedback form](../../.github/ISSUE_TEMPLATE/partner-feedback.yml). A 30-minute call every
  two weeks with a founder is optional.
- Report what they did, not only what they think: tasks they actually ran in Flux, where they
  stopped and what they went back to.
- Say whether we may count them as an outside install in the weekly review and name them in the
  build log.

## What a partner gets

- A first answer to every report within 2 working days, the response goal of
  [L-2](https://github.com/ColdPhase/flux/issues/306).
- Direct contact with the founders, and help with installation and their agent connection.
- Their problems are recorded as issues in their own words, with their example. Rule 16 says we do
  not bend their needs to our vision; equally, a need is evidence, not a promised feature. What
  gets built goes through the normal issue and decision path.
- Credit in the build log and release notes, if they want it.
- Flux stays free and open under the [existing licences](licensing.md); being a partner is not a
  contract and buys no exclusive features.

## What we count

The weekly review (L-4) records outside installs, outside issues and PRs, the median time to a
first answer and the time to first run. From partners we also count the tasks they observably ran
in Flux and the weeks they kept using it. Praise, ours or theirs, is not a measure (rule 17).
