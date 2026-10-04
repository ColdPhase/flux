# Build log

Flux is built in public by two founders and two coding agents, one agent working for
each founder. Each agent implements, and the other evaluates independently. This log
is the short, dated story of how that has gone: decisions, incidents and what we
learned. Each entry links the pull requests or issues that hold the evidence. New
entries go at the end; earlier entries are not rewritten.

## 2026-09-26 — an empty repository

The repository starts with a license, code owners and the historical v8 HTML
prototype ([#1](https://github.com/ColdPhase/flux/pull/1), [#2](https://github.com/ColdPhase/flux/pull/2)).

## 2026-09-27 — the founders hand delivery to the agents

- **Delegation.** After writing the product
  [foundation](product/FLUX-FOUNDATION.md), the founders
  [delegated delivery](product/autonomy.md) to the agents. The agents decide, the
  peer agent reviews, and there is no founder approval queue. What stays fixed is
  protected `main`, independent review and real tests.
- **A custom runner, then no runner.** The first setup was a custom "paired runner"
  that drove both agents ([#7](https://github.com/ColdPhase/flux/pull/7)). Within a
  day it needed four fixes:
  - multiple result events ([#17](https://github.com/ColdPhase/flux/pull/17));
  - suspension on peer loss ([#21](https://github.com/ColdPhase/flux/pull/21));
  - unbounded prompts ([#23](https://github.com/ColdPhase/flux/pull/23));
  - transient GitHub failures ([#31](https://github.com/ColdPhase/flux/pull/31)).

  We removed it and moved to one `/goal` session per founder, coordinating through
  issues and pull requests ([#32](https://github.com/ColdPhase/flux/pull/32)).
  **Lesson:** process tooling is not product progress
  ([playbook §21](product/playbook-the-5.md#focus-and-simplicity)). Keep the
  coordination layer as thin as GitHub already allows.
- **Architecture.** Decision O-002 chose a TypeScript monorepo with PostgreSQL, run
  only through Docker Compose ([#25](https://github.com/ColdPhase/flux/pull/25)).
  The application foundation, identity, access policy, the event stream and the PWA
  landed the same day ([#34](https://github.com/ColdPhase/flux/pull/34),
  [#39](https://github.com/ColdPhase/flux/pull/39), [#42](https://github.com/ColdPhase/flux/pull/42),
  [#47](https://github.com/ColdPhase/flux/pull/47), [#49](https://github.com/ColdPhase/flux/pull/49)).
- **Incident: the disk filled up.** Every Docker check built 0.6–4 GB of images and
  left them behind. About 60 leftover images and 62 GB of build cache filled a
  developer disk ([#71](https://github.com/ColdPhase/flux/issues/71)). Each check
  now removes exactly the images it built and never touches shared caches or other
  projects ([#73](https://github.com/ColdPhase/flux/pull/73)).
  **Lesson:** a check that leaves state behind breaks the next one.

## 2026-09-28 — the first journey runs

- **Features.** One day brought sketches, `./flux up/demo/dev`, linked work and
  decisions, the return view, direct messages, the wiki, notifications,
  self-hosted live sessions, search and the first MCP/OAuth agent connection
  ([#100](https://github.com/ColdPhase/flux/pull/100) to
  [#122](https://github.com/ColdPhase/flux/pull/122)). Each landed through its own
  reviewed PR with Docker evidence.
- **Decisions on owner-paid AI.** O-007 decided owner-authorized background compute
  ([#108](https://github.com/ColdPhase/flux/pull/108)). O-008 decided owner-invoked
  personal runs ([#125](https://github.com/ColdPhase/flux/pull/125),
  [#126](https://github.com/ColdPhase/flux/pull/126)). Both follow one rule: the
  owner pays, the owner asks, and nobody else can spend it.

## 2026-09-29 — migrations that lie

Branches merged in a different order from their migration numbers, and one branch
renumbered its files. A database could then claim a version it never applied. The
migrator and the API now require the exact ledger the image expects
([#130](https://github.com/ColdPhase/flux/pull/130),
[#118](https://github.com/ColdPhase/flux/issues/118)). Same-volume upgrade
rehearsals keep existing data across each newly landed migration gap.
**Lesson:** `max(version)` is not a schema check.

## 2026-09-30 — a new direction from the founders

The founders supplied Studio 11.6, a redesign with Agents as a view of existing
work, local MCP co-work and adaptive layouts. It was recorded as F-015 to F-017
([#150](https://github.com/ColdPhase/flux/pull/150)), and the built-in co-work
instructions as F-018 ([#163](https://github.com/ColdPhase/flux/pull/163)).

In CI, the pull-request workflow had grown to the full 10m38s suite. Fast checks
were restored to CI, and the full suite stayed a local Docker requirement
([#143](https://github.com/ColdPhase/flux/issues/143)).

## 2026-10-01 — one layout, one owner per branch

- **Layout.** The application moved under `app/` and Docker inputs under `docker/`
  ([#165](https://github.com/ColdPhase/flux/pull/165)).
- **Ownership.** One agent stopped at its weekly usage threshold. The other kept
  going on independent ready work, and paused branches stayed untouched.
  **Lesson:** keep one owner per branch, and write handoffs that survive a stopped
  session.

## 2026-10-02 — provider-neutral AI

- **AI ownership.** The founders confirmed that AI in Flux is personal: one owner,
  one connection, no shared spending
  ([#177](https://github.com/ColdPhase/flux/pull/177)).
- **Any provider.** They also required that the Flux agent work with any provider
  and model on equal terms (F-020, [#179](https://github.com/ColdPhase/flux/issues/179)).
- **Co-work over MCP.** Standing-grant MCP actions for tasks, results, decisions
  and the shared map landed, together with a versioned co-work playbook
  ([#174](https://github.com/ColdPhase/flux/pull/174) to
  [#176](https://github.com/ColdPhase/flux/pull/176)).
