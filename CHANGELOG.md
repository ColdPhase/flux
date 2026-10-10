# Changelog

All notable changes to Flux are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Flux uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) for its releases.

**Keeping it current.** A pull request that changes what people or operators see adds
one line under `[Unreleased]`, in the matching section, with its PR number. This
covers features, changed behaviour, fixes, removals, security fixes and new
operator steps. Internal refactors, tests and agent-process changes need no entry.
At release time, the release candidate moves `[Unreleased]` under its version and date.

## [Unreleased]

No version has been released yet. Everything below is on `main` since the
repository was created on 2026-09-26.

### Added

#### Run and operate Flux

- Operators can offer owners their own Claude Code inside Flux (off by default, `FLUX_AGENT_RUNTIME`): a fixed pool of isolated runtime slots with no Docker socket, `./flux runtime status|release|purge`, and slot volumes kept out of backups ([#303](https://github.com/ColdPhase/flux/pull/303)).
- One Docker Compose application with the API, a separate worker, PostgreSQL and a
  durable job queue. Migrations are reviewed SQL with health checks ([#34](https://github.com/ColdPhase/flux/pull/34)).
- `./flux up`, `./flux demo` and `./flux dev` start, seed and develop Flux with only
  Docker installed ([#102](https://github.com/ColdPhase/flux/pull/102)).
- Backup, restore, project export and upgrade through `./flux backup`, `restore`,
  `export` and `upgrade` ([#127](https://github.com/ColdPhase/flux/pull/127)).
- Operator Compose files and versioned installation assets for released images
  ([#159](https://github.com/ColdPhase/flux/pull/159)), plus a gated, explicitly
  triggered OCI release workflow ([#104](https://github.com/ColdPhase/flux/pull/104)).
- An exact migration-ledger check at install and startup. A database that does not
  match the image's migrations refuses to start ([#130](https://github.com/ColdPhase/flux/pull/130)).
- Two public extension contracts with a written compatibility promise: MCP tool
  contract 1 and project export format 1. A versioned snapshot test catches a
  breaking change. The [integration guide](docs/integrations/README.md) is for
  integrators and operators ([#260](https://github.com/ColdPhase/flux/pull/260)).
- A tested HTTPS reverse-proxy guide (Caddy) that keeps one public origin for the UI, sign-in, MCP and live updates, and trusts only the measured proxy address ([#366](https://github.com/ColdPhase/flux/pull/366)).
- `FLUX_BACKGROUND_COMPARISONS`, an operator switch that registers the comparison runtime; off by default, with behaviour unchanged ([#212](https://github.com/ColdPhase/flux/pull/212)).
- Live media: a recorded encryption boundary (hop-by-hop, not end-to-end), plus k3s values with a render check ([#284](https://github.com/ColdPhase/flux/pull/284)).

#### People and access

- Email sign-up and sign-in with origin-checked sessions ([#39](https://github.com/ColdPhase/flux/pull/39)).
- Workspaces, projects, grants and private drafts behind one authorization check
  ([#42](https://github.com/ColdPhase/flux/pull/42)).
- An authorized live event stream; the worker rechecks access before it acts, and
  idempotent writes are safe to retry ([#47](https://github.com/ColdPhase/flux/pull/47)).
- Optional single sign-on through one operator-configured OpenID Connect provider, next to email and password. Accounts are keyed by the provider's subject, never by email, so an SSO identity cannot take over an existing account, and the provider's groups or roles grant nothing in Flux ([#240](https://github.com/ColdPhase/flux/pull/240)).
- Workspace People: owners and admins add an existing account by email, change roles and remove people, with project access controls and opt-in promotion grants ([#198](https://github.com/ColdPhase/flux/pull/198)). An open project's access line says accurately who can see it ([#243](https://github.com/ColdPhase/flux/pull/243)).

#### Working together

- Installable PWA shell and Web Push notifications ([#49](https://github.com/ColdPhase/flux/pull/49)).
- The calm web app shell and design system ([#55](https://github.com/ColdPhase/flux/pull/55)),
  later the project surface with view tabs and a state line ([#122](https://github.com/ColdPhase/flux/pull/122)).
- Project capture and conversations with replies and cited materials ([#60](https://github.com/ColdPhase/flux/pull/60)).
- Sketches: persistent maps of connected thoughts ([#100](https://github.com/ColdPhase/flux/pull/100)).
  - A stable personal list view ([#146](https://github.com/ColdPhase/flux/pull/146)).
  - Draft-before-save for new thoughts ([#158](https://github.com/ColdPhase/flux/pull/158)).
  - Paste lines, a link or an image onto a map as a private draft; a project map keeps
    the image as a stored file ([#257](https://github.com/ColdPhase/flux/pull/257)).
- Work items, decisions and results linked to the conversations they came from
  ([#105](https://github.com/ColdPhase/flux/pull/105)). Native tasks gained
  criteria, prerequisites and plan intent ([#171](https://github.com/ColdPhase/flux/pull/171)).
  A person who can only read a proposed decision sees who decides it: someone who can
  edit the project, never an agent or assistant ([#259](https://github.com/ColdPhase/flux/pull/259), O-009).
- Canonical task discussions:
  - A task's thread starts at its first real contribution, with genuine actors
    ([#164](https://github.com/ColdPhase/flux/pull/164)).
  - Saved blockers, results and handoffs contribute to the thread
    ([#173](https://github.com/ColdPhase/flux/pull/173)).
- A return view: what changed since you left, its sources and one next step
  ([#110](https://github.com/ColdPhase/flux/pull/110)). It also offers a private,
  sourced "What matters" recap ([#140](https://github.com/ColdPhase/flux/pull/140)).
- Direct messages that do not belong to a project ([#111](https://github.com/ColdPhase/flux/pull/111)).
  A sketch can live inside a DM and be promoted to a project with an exact audience
  ([#129](https://github.com/ColdPhase/flux/pull/129)).
- Project docs and wiki with versions and links ([#115](https://github.com/ColdPhase/flux/pull/115)).
- Notifications: an inbox, per-reason preferences and email delivery
  ([#120](https://github.com/ColdPhase/flux/pull/120)).
- Privacy-safe search across everything you can read ([#119](https://github.com/ColdPhase/flux/pull/119)).
- Self-hosted live sessions ([#109](https://github.com/ColdPhase/flux/pull/109)):
  - contextual join, follow and screen sharing ([#131](https://github.com/ColdPhase/flux/pull/131));
  - media ends at sign-out ([#139](https://github.com/ColdPhase/flux/pull/139));
  - TURN calibration and real media diagnostics ([#156](https://github.com/ColdPhase/flux/pull/156)).
- Phone task views. Your own messages sit on the right and other people's on the
  left ([#138](https://github.com/ColdPhase/flux/pull/138)).
- Mint, Sky and Copper accents, remembered separately for light and dark themes
  ([#145](https://github.com/ColdPhase/flux/pull/145), [#157](https://github.com/ColdPhase/flux/pull/157)).
- A project can connect a read-only GitHub App repository and link tasks to verified
  pull requests, from signed, deduplicated webhook deliveries ([#168](https://github.com/ColdPhase/flux/pull/168)).
- "Let linked PRs move this task": a person who can edit a task lets its required pull requests
  start, block and finish it, or mark it Ready to close. A manual status change pauses it until resumed
  ([#270](https://github.com/ColdPhase/flux/pull/270)).
- Messages send instantly: the field empties at once, the message shows "Sending…" in place, and a failed send offers Retry or Remove. Offline, a line says so and queued messages resend automatically ([#299](https://github.com/ColdPhase/flux/pull/299)).
- A phone-first shell: on phones, Home and project views sit in a bottom bar, with a clear current place, motion and Settings ([#267](https://github.com/ColdPhase/flux/pull/267)).
- One chronological project conversation with no mandatory topics; replies sit with their message in a reply drawer ([#195](https://github.com/ColdPhase/flux/pull/195)). Creating a task posts one compact announcement in the stream, and the task's discussion root shows in the stream and Details ([#224](https://github.com/ColdPhase/flux/pull/224)).
- Project conversations and task discussions take durable file attachments, including file-only messages; uploads stay private until sent, and DMs refuse attachments ([#225](https://github.com/ColdPhase/flux/pull/225)). A task's unsent draft and staged files are shared across Conversation, Details and Agents ([#229](https://github.com/ColdPhase/flux/pull/229)).
- Tasks open as a Kanban board with drag, keyboard and menu moves; the grouped List stays one switch away ([#194](https://github.com/ColdPhase/flux/pull/194)).
- A two-pane Wiki with a page index, New page and Markdown import, and a top bar to edit, see history, export and share ([#197](https://github.com/ColdPhase/flux/pull/197)).
- Each map thought shows how many tasks link to it, and the count opens a chooser of those tasks ([#196](https://github.com/ColdPhase/flux/pull/196)).
- Home lists your tasks and first notes, and visiting Home acknowledges nothing ([#211](https://github.com/ColdPhase/flux/pull/211)). Project sketches open inside their project, among other flow fixes from the Studio 11.6 audit ([#210](https://github.com/ColdPhase/flux/pull/210)).

#### AI that stays yours

- Connect your own agent to Flux through scoped MCP and OAuth ([#103](https://github.com/ColdPhase/flux/pull/103)).
  - Several named connections per person, with consent bound to each request
    ([#167](https://github.com/ColdPhase/flux/pull/167)).
  - Standing-grant actions for tasks, results and decisions ([#174](https://github.com/ColdPhase/flux/pull/174)),
    and for the shared map ([#176](https://github.com/ColdPhase/flux/pull/176)).
  - Standing-grant actions for project docs and the project conversation, with the
    agent named as the author ([#193](https://github.com/ColdPhase/flux/pull/193)).
  - A versioned co-work playbook delivered through Start/Resume prompts
    ([#175](https://github.com/ColdPhase/flux/pull/175)).
  - Co-work tools for connected agents: create a work unit, and claim or decline a request addressed to it ([#254](https://github.com/ColdPhase/flux/pull/254), [#255](https://github.com/ColdPhase/flux/pull/255), [#261](https://github.com/ColdPhase/flux/pull/261)).
  - Owners grant, narrow and revoke standing grants for each of their own connections on the Connect page ([#262](https://github.com/ColdPhase/flux/pull/262)).
- Owner-only personal assistant runs. Only the owner can ask, stop or pay
  ([#141](https://github.com/ColdPhase/flux/pull/141), [#142](https://github.com/ColdPhase/flux/pull/142)).
  Crashed runs recover without a second invocation ([#161](https://github.com/ColdPhase/flux/pull/161)).
- Owner AI connections work with any provider and model on equal terms ([#192](https://github.com/ColdPhase/flux/pull/192)).
- A project Agents view lists every connected agent, one entry per connection, with the task thread ([#183](https://github.com/ColdPhase/flux/pull/183)).
- Owner background setup with paused rules and sourced comparisons. These are
  prepared, but production activation stays off ([#124](https://github.com/ColdPhase/flux/pull/124)).
- In a project's Agents view, workspace owners and admins edit and publish the agent policy (scope, priorities, review criteria, allowed work) ([#214](https://github.com/ColdPhase/flux/pull/214)). A conflicting publish keeps your text and shows what the other manager changed; everyone else reads the policy with its managers named ([#292](https://github.com/ColdPhase/flux/pull/292)).

### Changed

- Files, references and photos sit inside their message: file rows with a type icon and Download, voice notes with Play, task and decision cards, inline `#4` and `@person` chips, link cards, a frameless photo grid with send state on the photo, composer thumbnails, drop to attach and an always-dark photo viewer ([#369](https://github.com/ColdPhase/flux/pull/369)).
- Faster reads: the Inbox count no longer compiles query code on each visit, conversation and material lists use one statement instead of one or two per row, and conversation roots and comparison outcomes are read without locks ([#300](https://github.com/ColdPhase/flux/pull/300)).
- The app's files are sent as Brotli or gzip, and large JSON answers are compressed ([#269](https://github.com/ColdPhase/flux/pull/269)).
- Settings is one calm place with Account, Appearance (Light, Dark or Match system, and a switch for Kreska's small moments), Notifications, Agents and AI and Keyboard shortcuts. Notifications now default to Only "Needs you" (replies no longer push), with Everything or Nothing, quiet hours and an optional morning summary push ([#370](https://github.com/ColdPhase/flux/pull/370)).
- One neutral look from the final design: Soft volume surfaces in light, dark or Match system, Geist type served with Flux, pill buttons, and task states shown as shapes with words. The accent colours and their picker are gone ([#353](https://github.com/ColdPhase/flux/pull/353)).
- Kreska, a face drawn in a few lines, is the Flux logo, the app icon and every agent's icon. Agents carry an "Agent" tag and, where you may know them, the person they work for; the personal assistant's face shows what its run is doing ([#356](https://github.com/ColdPhase/flux/pull/356)).
- The computer sidebar as drawn: New (C) and Search at the top, Home, Inbox with its count and Sketchbook, projects as letter tiles, Messages, a card for your working assistant with Stop, and the account with Settings. `[` folds it to a 64 px rail and `G` `I` opens the Inbox ([#357](https://github.com/ColdPhase/flux/pull/357)).
- The Studio 11.6 interface: a sidebar with workspace and project names, a calmer
  header, Conversation · Map · Tasks · Wiki tabs and a reworked conversation
  ([#184](https://github.com/ColdPhase/flux/pull/184)).
- The application lives under `app/` and the Docker inputs under `docker/`.
  `./flux` moves an old root `.env` to `docker/.env` once ([#165](https://github.com/ColdPhase/flux/pull/165)).
- The compiled, non-root runtime image no longer ships TypeScript tooling ([#43](https://github.com/ColdPhase/flux/pull/43)).

### Fixed

- Background comparisons resume within a few minutes after the worker is killed mid-run, instead of waiting an hour for the dead run to expire; the interrupted request stays counted as possible spending and is never retried ([#58](https://github.com/ColdPhase/flux/issues/58)).
- Task details hide empty relationship paging after a successful read and keep status/owner labels separated from their values with enlarged text ([#282](https://github.com/ColdPhase/flux/pull/282)).
- People and agents keep a full 32px author avatar in the same conversation column on phones and computers, including your own replies ([#356](https://github.com/ColdPhase/flux/pull/356)).
- Historical agent contributions can still name their currently visible owner after the agent loses project access, without restoring the agent or exposing hidden owner identities ([#356](https://github.com/ColdPhase/flux/pull/356)).

- Task board columns describe the tasks being loaded, and the Wiki link picker names its search while waiting for results ([#363](https://github.com/ColdPhase/flux/pull/363)).
- When someone's sign-in and extra address are one mailbox and the notification email Flux sent there fails for good, the other copy is now sent instead, once, after rechecking access and preferences ([#334](https://github.com/ColdPhase/flux/pull/334)).
- The shared files volume works on SELinux hosts ([#67](https://github.com/ColdPhase/flux/pull/67)).
- Check scripts remove the images they built, so test runs no longer fill the
  disk ([#73](https://github.com/ColdPhase/flux/pull/73)).
- Project status and conversation navigation are correct for readers
  ([#169](https://github.com/ColdPhase/flux/pull/169)).
- Blocked project work stays visible on narrow phones ([#172](https://github.com/ColdPhase/flux/pull/172)).
- On touch screens, message fields, Reply, map Fit and wiki Edit have 44 px tap areas; the map keeps its place when a phone rotates or changes layout; wiki prose keeps a readable line length; and closing a sheet on a tablet no longer leaves the page untappable ([#265](https://github.com/ColdPhase/flux/pull/265)).
- The return view tells you when a pivot parked a task, even if the task itself did not change since you left ([#293](https://github.com/ColdPhase/flux/pull/293)).
- Security: a runtime CLI can no longer read or alter the agent runtime supervisor; switching the runtime off no longer blocks vendor logout, and purge no longer reports an unconfirmed logout as successful ([#359](https://github.com/ColdPhase/flux/pull/359)).
- A task root's chip in the conversation no longer grows when its task number arrives ([#368](https://github.com/ColdPhase/flux/pull/368)).
- In the production build, drawers, sheets and popovers move for their full duration instead of jumping in one frame ([#286](https://github.com/ColdPhase/flux/pull/286)).
- Web Push reaches public push services again: a network guard had rejected ordinary public IPv4 addresses ([#233](https://github.com/ColdPhase/flux/pull/233)). Flux warns about VAPID contacts that Apple's push service refuses ([#263](https://github.com/ColdPhase/flux/pull/263)).
- An installed app's title bar follows the chosen Light or Dark theme ([#242](https://github.com/ColdPhase/flux/pull/242)).
- Search says "1 result" in the singular and adds "+" when counts are capped; GitHub settings shows a line when a chosen task has no linked pull requests ([#241](https://github.com/ColdPhase/flux/pull/241)).
- A database connection whose BEGIN or ROLLBACK failed is discarded instead of going back to the pool with an open transaction ([#235](https://github.com/ColdPhase/flux/pull/235)).
- The map keeps its complete keyboard hint when task Details is open ([#227](https://github.com/ColdPhase/flux/pull/227)), and Fit keeps thoughts clear of the zoom controls ([#226](https://github.com/ColdPhase/flux/pull/226)).
- Retrying a first space, project or private draft after a lost response no longer
  creates a second one ([#178](https://github.com/ColdPhase/flux/pull/178)).
- Security: a signed-in account can no longer register or change OAuth clients, so a
  member cannot pass off a look-alike client with their own redirect. The agent consent
  page shows where access goes and warns when that is not this computer, and no Flux
  page can be framed by another site ([#287](https://github.com/ColdPhase/flux/issues/287), [#294](https://github.com/ColdPhase/flux/pull/294)).
- The agent connection page no longer asks for an HTTPS address on the quick start's
  local `http://` address, and the README shows how to connect your own agent
  ([#328](https://github.com/ColdPhase/flux/pull/328)).
