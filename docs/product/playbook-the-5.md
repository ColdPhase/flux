# Delivery playbook: *The Five*

**Status:** founder direction (Maurycy, 2026-09-27). It applies to all milestone
work. Agents apply it within the [foundation](FLUX-FOUNDATION.md) and
[delegation](autonomy.md).

**Source:** Tomasz Karwatka, *The Five*. The open source chapters include work by
Piotr Karwatka. The founders hold a private copy, which is not in this
repository. Page numbers are printed pages. Principles are paraphrased, and each
"Flux:" line is our own application, not a claim from the book.

## Why this exists

By 2026-09-27 the agents had produced careful research documents and long
contract negotiations, but no application code. The book's main lesson for this
stage is to ship a thin, working slice early and learn from use. Research and
review stay, but they serve shipping and must not replace it.

## Ship first

1. **Act before you feel ready; long deliberation misses the wave** (pp. 87–94,
   292–293). Flux: give a research or decision task a time box. It ends with a
   recorded decision and at least one follow-up code issue. When options are
   close, choose a reasonable one and test it in code (p. 340).
2. **An MVP covers one painful problem, one segment and one scenario. Ship it
   before it feels comfortable** (pp. 182–183). Flux: the first slice is one
   end-to-end journey: a person and an agent in one conversation, a task created
   from it, and a recorded handoff that someone else can resume. Other areas
   follow as thin slices.
3. **Iterate in days, at most two weeks, and expect to rewrite** (pp. 185–186).
   Flux: application PRs contain running code with tests. Keep contracts short and
   revise them when code teaches us something.
4. **Observe real use; it beats asking or speculating** (p. 185). Flux: judge
   progress by what runs and how it is used, not by document completeness.
5. **Solve your own problem first** (p. 80). Flux: the two agents and founders
   are customer zero. Move project coordination into Flux once the first slice
   runs.

## Easy start and structure

6. **Include what is needed and cut setup; Vue Storefront started with two
   commands** (pp. 196–197). Flux: clone, `./flux up` (source-built `docker/compose.source.yaml`), `./flux demo`.
   The launcher creates `docker/.env` once from `docker/.env.example`; the operator
   release path uses pull-only `docker/compose.yaml` with its matching release template.
   Measure the time to the first message and the first agent reply. Seed demo data
   so the first success is designed (p. 332).
7. **Write short personas before coding** (pp. 195–196). Flux: reuse
   [O-001](first-segment-and-usp-proposal.md). Do not open another research
   round for personas.
8. **Use a monorepo of separate modules** (pp. 197–198). Flux: one pnpm
   workspace, as in the O-002 founder direction on
   [PR #25](https://github.com/ColdPhase/flux/pull/25#issuecomment-5856569524).
9. **Stay out of framework wars; keep core logic framework-independent**
   (p. 198). Flux: `contracts`, `sdk` and `core` do not depend on React or on the
   server. An agent in any language, or a different front end, can use the
   documented HTTP/JSON API (and MCP when it is added).
10. **Small spin-off libraries can extend reach later** (pp. 198–199). Flux:
    note candidates, e.g. a handoff/decision schema. Do not build them before v0.1.

## Community and releases

11. **Be fully open from day one; early hidden enterprise editions erode trust**
    (pp. 289–290). Flux: every feature is in the open repository. The application
    is AGPL-3.0. SDK, contracts and examples are Apache-2.0. Revenue comes from
    services, not closed features.
12. **Release early and on a predictable rhythm; each release is a communication
    event** (pp. 291–292). Flux: mark an internal v0.1 checkpoint as soon as the
    first journey works on a clean install from `main`, with a changelog entry and
    a short demo. Packaged artifacts and GitHub Releases still follow the accepted
    final-only boundary in [CI and releases](../agents/ci-and-releases.md). Any
    earlier public release needs a separate recorded change to that policy.
13. **Invest in the community and treat contributors as partners** (pp. 290–291).
    Flux: keep CONTRIBUTING accurate, label good first issues, answer quickly and
    keep contributor instructions short.
14. **Everyone markets in open source; show how the product is built**
    (pp. 283, 288, 293). Flux: two agents building Flux in public is a story.
    Keep a short build log with each release, and add a demo of the core journey
    to the README once it runs.
15. **Standard licenses avoid community distrust** (pp. 132–134). Flux: plain
    license texts, with no custom usage limits.

The [v0.1 launch plan](launch-v0.1.md) applies rules 6, 12, 13, 14, 16, 17 and 20 to the first release.

## Feedback

16. **Good design partners adopt early, match the problem and commit time. Do
    not bend their needs to our vision** (pp. 176–182). Flux: after v0.1,
    recruit a few small teams that already work with agents.
17. **Friends and family feedback misleads** (pp. 124, 181). Flux: count outside
    adopters and observed tasks, not our own enthusiasm.

## Focus and simplicity

18. **Win a narrow niche first** (pp. 118–119, 127, 138, 191). Flux: optimize
    the first slice for the O-001 segment only.
19. **Complexity kills scaling** (pp. 251–253). Flux: cut anything the first
    journey does not need, including extra services, layers and protocol ceremony.
20. **One wildly important goal, a few lead measures, a weekly review**
    (pp. 261–265). Flux: the goal is a runnable v0.1 checkpoint of the first journey on a
    clean Compose install. Lead measures are merged PRs with running code and the time
    to first run.
21. **Process polish and infrastructure rebuilds are not results** (pp. 295–297).
    Flux: changes to the agent tooling or protocol are not product progress. Fix
    only what blocks delivery.

## What agents change now

- A contract for a documentation or decision task is short: outcome, 3–5
  criteria, owner and evaluator. It is accepted or corrected once. Do not
  negotiate further versions unless the scope really changed.
- After O-002 is accepted, start the monorepo/Compose foundation and identity
  issues immediately. The first-journey issue follows. New research is opened only
  when it blocks a concrete code task.
- Independent review, protected `main`, real tests and the mobile/PWA acceptance
  requirements are unchanged. Speed comes from smaller slices, not weaker checks.

## Not applied now

- Enterprise sales with the MVP (p. 183), pricing and margin rules
  (pp. 200–204), full OKR/4DX, NPS and budgeting systems (pp. 259–268, 341–343).
  They are premature for an unreleased open source product.
- Paid or closed editions (pp. 125, 133, 194). They conflict with full openness.
- Validation by landing page or mock-up instead of code (pp. 82, 176, 185).
  Flux's current gap is zero code, and a developer tool is judged by running it.
