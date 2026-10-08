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

## 2026-10-03 — the Studio 11.6 shell

- **New look.** The Studio 11.6 shell, tokens, header, tabs and conversation landed,
  built from a measured design system rather than eyeballed screenshots
  ([#182](https://github.com/ColdPhase/flux/pull/182),
  [#184](https://github.com/ColdPhase/flux/pull/184)).
- **AI and integrations.** The provider-neutral Flux agent became a requirement
  (F-020, [#180](https://github.com/ColdPhase/flux/pull/180)). Project conversations
  and docs joined the standing-grant MCP tools
  ([#193](https://github.com/ColdPhase/flux/pull/193)). Verified GitHub pull requests
  were connected to projects ([#168](https://github.com/ColdPhase/flux/pull/168)).

## 2026-10-04 — a day of integration

- **Views.** The 11.6 views arrived in one day:
  - a Kanban board with drag, keyboard and menu moves
    ([#194](https://github.com/ColdPhase/flux/pull/194));
  - a two-pane wiki ([#197](https://github.com/ColdPhase/flux/pull/197));
  - the project Agents view ([#183](https://github.com/ColdPhase/flux/pull/183));
  - task counts on map thoughts ([#196](https://github.com/ColdPhase/flux/pull/196));
  - Home acknowledgement and first notes ([#211](https://github.com/ColdPhase/flux/pull/211));
  - workspace People ([#198](https://github.com/ColdPhase/flux/pull/198));
  - durable file messages ([#225](https://github.com/ColdPhase/flux/pull/225)).
- **AI connections.** Owner AI connections became provider-neutral
  ([#192](https://github.com/ColdPhase/flux/pull/192)). Co-work gained fenced claims and
  an approved project policy for agents ([#166](https://github.com/ColdPhase/flux/pull/166),
  [#214](https://github.com/ColdPhase/flux/pull/214)).
- **In public.** Governance, the changelog and this build log were added
  ([#187](https://github.com/ColdPhase/flux/pull/187)). Core logic moved behind ports,
  one refactor at a time ([#206](https://github.com/ColdPhase/flux/pull/206) to
  [#209](https://github.com/ColdPhase/flux/pull/209),
  [#213](https://github.com/ColdPhase/flux/pull/213)).

## 2026-10-05 — the founders try it on their phones

- **One conversation.** A project became one conversation stream with a reply drawer
  ([#195](https://github.com/ColdPhase/flux/pull/195)).
- **The phone.** The founders opened Flux on real phones and found it overwhelming:
  unclear what to tap, nothing like a messenger
  ([#264](https://github.com/ColdPhase/flux/issues/264)). They set a phone-first
  direction ([#266](https://github.com/ColdPhase/flux/issues/266)). Web Push reached
  real iPhones and Androids through a trusted-HTTPS fixture
  ([#233](https://github.com/ColdPhase/flux/pull/233),
  [#263](https://github.com/ColdPhase/flux/pull/263)).
- **Contracts.** Two contracts were made explicit: who may accept a decision (O-009,
  [#259](https://github.com/ColdPhase/flux/pull/259)), and the versioned MCP tool and
  export formats (O-010, [#260](https://github.com/ColdPhase/flux/pull/260)). Flux
  settled on exactly two AI modes: the agent in Flux, and your own agent app over MCP
  (F-022, [#247](https://github.com/ColdPhase/flux/pull/247)).

## 2026-10-06 — phone-first, and a full disk

- **Phone and devices.** The phone-first shell landed
  ([#267](https://github.com/ColdPhase/flux/pull/267)), with an Apple HIG checklist as
  the rulebook for phones ([#285](https://github.com/ColdPhase/flux/pull/285)). The
  founders made physical devices optional for acceptance, with emulation and documented
  platform rules instead ([#268](https://github.com/ColdPhase/flux/pull/268)). They
  also took live co-editing out of v0.1.
- **Sign-in and security.** Operator single sign-on with OIDC landed
  ([#240](https://github.com/ColdPhase/flux/pull/240)), together with MCP sign-in through
  external identity providers (F-024, [#274](https://github.com/ColdPhase/flux/pull/274)).
  A review found that any signed-in session could register OAuth clients; that was fixed
  the same day ([#294](https://github.com/ColdPhase/flux/pull/294)).
- **Work flow.** Linked GitHub PRs now move the same Flux task
  ([#270](https://github.com/ColdPhase/flux/pull/270)). The founders' scenarios run end to
  end on desktop and phone ([#291](https://github.com/ColdPhase/flux/pull/291)). Co-work
  gained unit completion, transfer and MCP tools
  ([#261](https://github.com/ColdPhase/flux/pull/261)). The release acceptance matrix
  for v0.1.0-rc.1 is in place ([#248](https://github.com/ColdPhase/flux/pull/248)).
- **The disk.** Per-run test images filled the host disk twice, and every Docker check
  stopped until space was freed. **Lesson:** a shared machine needs a disk guard and
  cleanup by an allowlist, not by exclusion.
- **Choosing the phone look.** The founders compared five phone mock-ups. Copying the
  dense desktop look onto the phone was rejected as heavy. An ElevenLabs-like direction
  was chosen: calm monochrome, and a coloured "orb" for each AI agent that moves only
  while the agent really works (F-025, proposed in
  [#304](https://github.com/ColdPhase/flux/pull/304)). **Lesson:** show the founders
  rendered screens early; a description is not a design.
- **Launch plan.** A plan for the v0.1 launch was written from *The Five*
  ([launch plan](product/launch-v0.1.md)).

## 2026-10-07 — the final design

- **The founders drew it themselves.** After the phone mock-ups, Hubert designed the whole
  application on one canvas: 65 screens for the computer and the phone, in light and dark.
  "Prostota" (simplicity) is now the only UI and UX for Flux (F-026,
  [#336](https://github.com/ColdPhase/flux/issues/336); [guide and renders](design/final/README.md)).
  Every earlier appearance decision is superseded, and its documents were removed.
- **What changes.** One queue, Inbox "Needs you", replaces the Decisions view. Kreska, a
  line-drawn face, becomes the logo and every agent's icon, with expressions instead of status
  dots. There are no accent colours. The phone gets a three-tab bar with Search and one "+".
  Swipes go left only, and Undo replaces confirmations.
- **Lesson:** when a direction keeps moving, have the founders draw the screens they want and
  treat that drawing as the contract; agents implement it instead of re-deciding it.

## 2026-10-07 — restored release scope and one SSO provider

- The [founder's new direction](https://github.com/ColdPhase/flux/issues/249#issuecomment-6042227715)
  restores live map/wiki (#228/#231), safe unused AI-task Undo (#238), and
  back-channel logout (#314) to v0.1. The earlier deferral above remains a
  historical event; all technical gates and independent acceptance still apply.
- The [independently assessed amendment](https://github.com/ColdPhase/flux/issues/360#issuecomment-6042333778)
  uses one SSO provider per installation, keeps the narrowed account/deployment
  and authority-increasing confirmation safeguards in #315/#316, and cancels
  #317's extra opaque-key surface. OAuth/SSH guidance remains. This records
  scope and cancellation, not delivered functionality.
- [Prostota](https://github.com/ColdPhase/flux/issues/336) (F-026) is the final
  appearance and UX reference. The [reference import](https://github.com/ColdPhase/flux/pull/337)
  and its implementations remain independently reviewed work.

## 2026-10-07 — owner MCP switches and SSO-only ordinary login

- The [later founder amendment](https://github.com/ColdPhase/flux/issues/360#issuecomment-6043340696)
  replaces #316 recent-authentication with ordinary owner capability switches and
  selected native projects. No password replay or ten-minute/secondary SSO
  challenge; live rights/grants/OAuth ceilings and bounded runtime effects remain.
- #315 now targets password-only without active SSO or SSO-only through the sole
  IdP, with explicit account migration before cutover and audited host recovery.
  IDs/data/memberships and verification/offboarding stay protected; no email
  auto-linking, ordinary mixed login or password signup/reset alongside SSO.
- The preceding scope and necessity entries remain historical. [The current
  assessment](product/research/2026-10-07-mcp-switches-and-sso-only.md) distinguishes
  source seams from missing switches/exclusive-mode implementation and preserves
  real bootstrap prerequisites, race/transport boundaries and all release gates.
