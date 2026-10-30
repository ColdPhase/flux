# Flux v0.1.0 release notes (draft)

> **Draft, not a release.** Drafted on 2026-10-10 from `main` at `05f89591` and refreshed on 2026-10-23
> against `main` at `c7b89690` and on 2026-10-30 against `main` at `1e0dc2dd9` for L-3 of the
> [launch plan](launch-v0.1.md) ([#307](https://github.com/ColdPhase/flux/issues/307), open until the candidate is accepted and these notes are final).
> Finalise it against the accepted candidate and the
> [#249](https://github.com/ColdPhase/flux/issues/249) report: every statement below must be
> restated at the candidate; only independently recorded scope exclusions or accepted residual limitations may be listed as known limits, and an incomplete required outcome (such as #228, #231, #238, #314 or mobile acceptance) blocks candidate acceptance and publication until it is fixed and verified.
> The [acceptance matrix](../agents/release-acceptance/v0.1.0-rc.1.md) still proposes the first
> tag as `v0.1.0-rc.1`; a stable `v0.1.0` follows an rc that passed.
>
> | Field | Value |
> | --- | --- |
> | Version and tag | `<VERSION>` |
> | Candidate commit | `<CANDIDATE SHA>` |
> | Release date | `<DATE>` |
> | Acceptance | `ACCEPTED RELEASE CANDIDATE <SHA>` lines on [#249](https://github.com/ColdPhase/flux/issues/249) |

## What Flux is

Flux is an open source, self-hostable workspace where people and AI agents work on the same
projects: conversations, and the tasks, documents and decisions that come out of them. It runs
on your own server with Docker Compose, and your own AI agent joins only the projects you grant
it. It is for small software teams that already hand some work to coding agents and want to return
to a project after a break and see what changed, what was decided and what is next.

## Quick start

**Try it from the source** (Git and Docker with Compose; no host Node.js or PostgreSQL):

```sh
git clone --depth 1 https://github.com/ColdPhase/flux.git
cd flux
./flux up      # creates docker/.env with random secrets once, builds, migrates, starts, prints the URL
./flux demo    # optional: sample workspace, project, conversation and note; prints two logins
```

Open the printed URL, <http://127.0.0.1:8081/> by default. The first `./flux up` builds Flux
and takes a few minutes. Measured from `git clone` to the demo logins: 3 min 0 s with a no-cache
build and 47.8 s with a warm Docker cache on a Linux workstation (2026-10-23), 6 min 37 s and 5 min 40 s on
the same machine when it was heavily loaded by other builds (2026-10-30), and 5 min 11 s and
2 min 45 s on a Mac with the full-history clone (2026-10-11); signing in and posting the first
message then took about a second in the browser ([time to first run](../development/time-to-first-run.md); restate it for the candidate). To
connect your own MCP client, follow [Connect your own
agent](../../README.md#connect-your-own-agent).

**Run a published release** (Docker Engine with Compose; no checkout or build):

1. Download every asset of the `<VERSION>` release into an empty directory and check them with
   `sha256sum -c SHA256SUMS` (macOS: `shasum -a 256 -c SHA256SUMS`).
2. `cp env.example .env && chmod 600 .env`, then set `POSTGRES_PASSWORD`, `FLUX_AUTH_SECRET` and
   `FLUX_PUBLIC_ORIGIN`.
3. `docker compose --env-file .env -f compose.yaml pull`, then
   `docker compose --env-file .env -f compose.yaml up -d --wait`.

The release's `INSTALL.md` ([source](../operations/release-guide.md)) has the full steps, Web
Push keys and the HTTPS reverse proxy; [install from a release](../operations/install-release.md)
explains the assets.

## What works

Grouped by what a person does. Each item names the pull request that delivered it; the
[changelog](../../CHANGELOG.md) has the full list.

### Start, sign in and share a project

- Email sign-up and sign-in with origin-checked sessions ([#39](https://github.com/ColdPhase/flux/pull/39)).
- Workspaces, projects, grants and private drafts behind one authorization check
  ([#42](https://github.com/ColdPhase/flux/pull/42)); an authorized live event stream
  ([#47](https://github.com/ColdPhase/flux/pull/47)).
- Optional single sign-on with the operator's OpenID Connect provider
  ([#240](https://github.com/ColdPhase/flux/pull/240), [single sign-on](../operations/single-sign-on.md)):
  an SSO-only mode with explicit account linking and a last-identity guard ([#416](https://github.com/ColdPhase/flux/pull/416)), account safety for
  email collisions and verification ([#412](https://github.com/ColdPhase/flux/pull/412)), the provider's sign-in on the agent authorization path ([#384](https://github.com/ColdPhase/flux/pull/384)),
  a standing check of the person's provider account for agent access ([#392](https://github.com/ColdPhase/flux/pull/392)) and OIDC back-channel
  logout ([#418](https://github.com/ColdPhase/flux/pull/418)).

### Talk, and turn talk into work

- Project conversations with replies and cited materials ([#60](https://github.com/ColdPhase/flux/pull/60)),
  sent instantly, with an offline line and automatic resend ([#299](https://github.com/ColdPhase/flux/pull/299)).
- Tasks, decisions and results linked to the conversation they came from
  ([#105](https://github.com/ColdPhase/flux/pull/105)); tasks with criteria, prerequisites and
  plan intent ([#171](https://github.com/ColdPhase/flux/pull/171)) and friendly numbers per project
  ([#282](https://github.com/ColdPhase/flux/pull/282)). A task's discussion starts at its first
  real contribution, and saved blockers, results and handoffs join it
  ([#164](https://github.com/ColdPhase/flux/pull/164), [#173](https://github.com/ColdPhase/flux/pull/173)).
- Decisions are accepted by a person who can edit the project, never by an agent or assistant
  ([#259](https://github.com/ColdPhase/flux/pull/259), O-009).
- Project docs and wiki with versions and links ([#115](https://github.com/ColdPhase/flux/pull/115)),
  the Wiki as drawn with editors, outline, references and phone chips ([#374](https://github.com/ColdPhase/flux/pull/374)).
- The conversation as drawn: aligned authors, `@` and `/` in the composer, message actions and a
  "Since you left" line ([#387](https://github.com/ColdPhase/flux/pull/387)); files, references and photos inside the message ([#369](https://github.com/ColdPhase/flux/pull/369)); one composer
  everywhere, with long press and swipe-right to reply on the phone ([#578](https://github.com/ColdPhase/flux/pull/578)); private reply threads and
  "Seen by" receipts in direct messages, and an excerpt that becomes a project task ([#574](https://github.com/ColdPhase/flux/pull/574)).
- Tasks as drawn: glyph states, one-tap status, swipe to Done and Undo ([#375](https://github.com/ColdPhase/flux/pull/375)); one calm detail panel and
  a two-height sheet for tasks, decisions and threads ([#386](https://github.com/ColdPhase/flux/pull/386)); a blocked task waits for a person, with one
  conversation line and an Inbox item for them ([#570](https://github.com/ColdPhase/flux/pull/570)); an optional shared project goal that a person
  marks reached ([#556](https://github.com/ColdPhase/flux/pull/556)).
- Undo of an unused AI-created task that keeps its provenance ([#394](https://github.com/ColdPhase/flux/pull/394)).
- Decisions show in their thread and in the conversation, with their reason and the message they came from
  ([#696](https://github.com/ColdPhase/flux/pull/696)); a message can cite another message or a thought, files show their details and a pasted
  link becomes a card fetched safely on the server ([#704](https://github.com/ColdPhase/flux/pull/704), [#708](https://github.com/ColdPhase/flux/pull/708));
  another member's message reaches an open thread when it is sent ([#741](https://github.com/ColdPhase/flux/pull/741)).

### Think it through: DMs, sketches and new directions

The founder scenarios of [#44](https://github.com/ColdPhase/flux/issues/44) have end-to-end
browser tests ([#291](https://github.com/ColdPhase/flux/pull/291)): a DM becomes a sketch and then
a project; a thought becomes an experiment, a negative result and a new direction; a person
returns after a pivot with AI off. Their result at the candidate comes from the #249 report.

- Direct messages outside any project ([#111](https://github.com/ColdPhase/flux/pull/111)); a
  sketch in a DM can be promoted to a project with an exact audience
  ([#129](https://github.com/ColdPhase/flux/pull/129)).
- Sketches, persistent maps of connected thoughts ([#100](https://github.com/ColdPhase/flux/pull/100)),
  with a personal list view ([#146](https://github.com/ColdPhase/flux/pull/146)),
  draft-before-save ([#158](https://github.com/ColdPhase/flux/pull/158)) and pasted lines, links
  and images ([#257](https://github.com/ColdPhase/flux/pull/257)).
- Maps on an infinite canvas, with the list as a tree ([#554](https://github.com/ColdPhase/flux/pull/554)); new thoughts grown from thought dots
  ([#380](https://github.com/ColdPhase/flux/pull/380)); an existing task linked to a thought from its details ([#449](https://github.com/ColdPhase/flux/pull/449)); the Sketchbook ([#563](https://github.com/ColdPhase/flux/pull/563)).

### Come back after a break

- A return view: what changed since you left, its sources and one next step
  ([#110](https://github.com/ColdPhase/flux/pull/110)), naming the work a pivot parked
  ([#293](https://github.com/ColdPhase/flux/pull/293)), and a private, sourced "What matters"
  recap ([#140](https://github.com/ColdPhase/flux/pull/140)).
- An inbox, per-reason preferences and email delivery
  ([#120](https://github.com/ColdPhase/flux/pull/120)). Notifications default to Only "Needs you",
  with quiet hours and an optional morning summary ([#370](https://github.com/ColdPhase/flux/pull/370)).
- Privacy-safe search across everything you can read ([#119](https://github.com/ColdPhase/flux/pull/119)),
  finding projects by name ([#468](https://github.com/ColdPhase/flux/pull/468)).
- Inbox "Needs you" as the one queue, with the top three on Home ([#393](https://github.com/ColdPhase/flux/pull/393)); a way back to where you were
  from any opened reference ([#603](https://github.com/ColdPhase/flux/pull/603)); one Create window and a ⌘K that creates and finds ([#377](https://github.com/ColdPhase/flux/pull/377)).

### On the phone

- An installable PWA and Web Push notifications ([#49](https://github.com/ColdPhase/flux/pull/49)). Install from Settings
  (the browser's own offer, or "Share, then Add to Home Screen" on iPhone and iPad), a standalone launch with your
  session, a link that reopens its project, Web Push to a closed app and a refused permission said in Settings, tested on emulated
  Chromium and WebKit in Docker ([#756](https://github.com/ColdPhase/flux/pull/756), [mobile and push](../operations/mobile-and-push.md)).
- Phone task views ([#138](https://github.com/ColdPhase/flux/pull/138)), blocked work that stays
  visible on narrow phones ([#172](https://github.com/ColdPhase/flux/pull/172)), and 44 px touch
  targets and readable line lengths across layouts ([#265](https://github.com/ColdPhase/flux/pull/265)).
- The phone shell: Home, Projects and Inbox in one capsule, one `+`, a title menu and full-screen
  conversations ([#414](https://github.com/ColdPhase/flux/pull/414)); the update prompt is a row above the shell, never a layer over controls ([#622](https://github.com/ColdPhase/flux/pull/622)).
  Physical devices are optional (founder direction, [#266](https://github.com/ColdPhase/flux/issues/266)). The
  [#20](https://github.com/ColdPhase/flux/issues/20) emulation evidence is closed; what the report accepts at the candidate is what is stated here.
- Layouts that hold from small phones to 4K and ultrawide: short threads, safe areas, a stream band on the phone, a map that fits and a
  rail that fits a short window ([#669](https://github.com/ColdPhase/flux/pull/669), [#728](https://github.com/ColdPhase/flux/pull/728),
  [#729](https://github.com/ColdPhase/flux/pull/729), [#745](https://github.com/ColdPhase/flux/pull/745), [#750](https://github.com/ColdPhase/flux/pull/750)).
  The tracking issue ([#151](https://github.com/ColdPhase/flux/issues/151)) is open.

### Work with your AI

Flux has exactly two AI modes ([F-022](decisions.md), [AI modes](ai-modes.md)).

- **Your agent app over MCP.** Your own Claude Code, Codex or other MCP client runs on your
  computer with your own model account and connects through scoped MCP and OAuth
  ([#103](https://github.com/ColdPhase/flux/pull/103)), with several named connections and
  consent bound to each request ([#167](https://github.com/ColdPhase/flux/pull/167)). You can grant
  fewer permissions than a client asks for: it gets exactly those, and a tool outside them says
  which permission is missing ([#571](https://github.com/ColdPhase/flux/pull/571)). In-app switches for what each connection may use ([#390](https://github.com/ColdPhase/flux/pull/390)). The pinned
  Codex connects on its protocol revision ([#467](https://github.com/ColdPhase/flux/pull/467)). With a grant from you it can act on tasks, results,
  decisions, the shared map, project docs and the project conversation, named as the author
  ([#174](https://github.com/ColdPhase/flux/pull/174), [#176](https://github.com/ColdPhase/flux/pull/176),
  [#193](https://github.com/ColdPhase/flux/pull/193)).
  - **Work together.** A versioned co-work playbook ([#175](https://github.com/ColdPhase/flux/pull/175))
    reaches Claude Code as Start/Resume prompts and Codex as a resource it reads ([#589](https://github.com/ColdPhase/flux/pull/589)). Agents claim,
    hand off and review work with current-version verdicts, requests and a coordination inbox
    ([#584](https://github.com/ColdPhase/flux/pull/584), [#587](https://github.com/ColdPhase/flux/pull/587), [#600](https://github.com/ColdPhase/flux/pull/600)); each task has an agents' thread, and the Agents tab lists agents with what they
    are doing now ([#582](https://github.com/ColdPhase/flux/pull/582), [#417](https://github.com/ColdPhase/flux/pull/417), [#376](https://github.com/ColdPhase/flux/pull/376)). You can stop an agent's work and answer its questions ([#383](https://github.com/ColdPhase/flux/pull/383)). A
    project's agent policy is edited in Flux with conflict-safe publishing
    ([#292](https://github.com/ColdPhase/flux/pull/292)).
  - **Start and Resume, verified.** A real Codex (0.160.1) and a real Claude Code (2.1.285) each made one
    task with criteria and saved a checkpoint; after the owner changed the plan, Resume read only what had changed, and Codex resumed its
    exact thread. Connect and Agents offer Claude Code's `/mcp__flux__start_work` and `/mcp__flux__resume_work` and Codex's `./flux cowork`
    ([#616](https://github.com/ColdPhase/flux/pull/616), [#649](https://github.com/ColdPhase/flux/pull/649), [#751](https://github.com/ColdPhase/flux/pull/751)).
    A person who may stop an agent can pause it at its next safe point; events of a linked GitHub pull request reach the connection whose
    agent holds the task; an agent can link the pull request it produced to that task ([#760](https://github.com/ColdPhase/flux/pull/760)).
  - **What is not verified.** Codex's sign-in with a connection that grants fewer than the three actions it asks for, and the agent's
    suggestions in "Needs you", were fixed with Codex-shaped tests ([#673](https://github.com/ColdPhase/flux/pull/673)); the real Codex lane was not
    re-run for that change.
- **The agent in Flux.** Owner-only assistant runs on the owner's own AI connection: only the
  owner can ask, stop or pay ([#141](https://github.com/ColdPhase/flux/pull/141),
  [#142](https://github.com/ColdPhase/flux/pull/142)), and crashed runs recover
  ([#161](https://github.com/ColdPhase/flux/pull/161)). The assistant has its own screen, panel and
  "Ask" entry points ([#588](https://github.com/ColdPhase/flux/pull/588)), a change log with "Ask me first" and run authority ([#597](https://github.com/ColdPhase/flux/pull/597)), field-level Undo
  ([#586](https://github.com/ColdPhase/flux/pull/586)), schedules and an assistant-written morning summary ([#598](https://github.com/ColdPhase/flux/pull/598)), and a choice of model ([#599](https://github.com/ColdPhase/flux/pull/599)). Owners
  can sign in with their own Claude or ChatGPT subscription: operators offer Claude Code and Codex in
  isolated runtime slots ([#398](https://github.com/ColdPhase/flux/pull/398), [#575](https://github.com/ColdPhase/flux/pull/575)), with a guided sign-in card ([#577](https://github.com/ColdPhase/flux/pull/577)) and a one-time question in
  `./flux up` ([#494](https://github.com/ColdPhase/flux/pull/494)). Both modes are off until the operator turns them on (see [known limits](#known-limits)).
- **A workspace can turn AI off.** An admin policy with server enforcement, a turn-off cutover and
  re-enable, and an interface without any AI ([#633](https://github.com/ColdPhase/flux/pull/633), [#634](https://github.com/ColdPhase/flux/pull/634), [#643](https://github.com/ColdPhase/flux/pull/643), [#653](https://github.com/ColdPhase/flux/pull/653)); the issue ([#614](https://github.com/ColdPhase/flux/issues/614))
  is still open at 2026-10-30.
- AI is optional: the human return and handoff journey without AI is part of the release
  (O-004).

### Edit together, live

- Live co-editing of the map and the wiki with identified authors: shared mind-map movement and wiki
  text ([#389](https://github.com/ColdPhase/flux/pull/389)), named cursors and who is here on the map ([#585](https://github.com/ColdPhase/flux/pull/585)), completed with the live wiki and map
  ([#613](https://github.com/ColdPhase/flux/pull/613)), with every map cursor named and told apart by shape, not colour ([#646](https://github.com/ColdPhase/flux/pull/646), [#648](https://github.com/ColdPhase/flux/pull/648)). The tracking issues
  ([#228](https://github.com/ColdPhase/flux/issues/228), [#231](https://github.com/ColdPhase/flux/issues/231)) are closed.

### Work with GitHub

- A project can connect a read-only GitHub App repository and link tasks to verified pull
  requests ([#168](https://github.com/ColdPhase/flux/pull/168)); linked PRs can start, block and
  finish the task ([#270](https://github.com/ColdPhase/flux/pull/270)).

### Meet live

- Optional self-hosted live sessions ([#109](https://github.com/ColdPhase/flux/pull/109)) with
  contextual join, follow and screen sharing ([#131](https://github.com/ColdPhase/flux/pull/131)),
  media that ends at sign-out ([#139](https://github.com/ColdPhase/flux/pull/139)) and TURN
  diagnostics ([#156](https://github.com/ColdPhase/flux/pull/156)).

### Look and feel

- One design for the computer and the phone, ["Prostota"](../design/final/README.md) (F-026):
  Soft volume surfaces in light, dark or Match system, no accent colours
  ([#353](https://github.com/ColdPhase/flux/pull/353)); Kreska as the logo and every agent's icon
  ([#356](https://github.com/ColdPhase/flux/pull/356)); the computer sidebar and rail with a
  working assistant's Stop ([#357](https://github.com/ColdPhase/flux/pull/357)); one Settings
  place ([#370](https://github.com/ColdPhase/flux/pull/370)).
- The one-row project header and a focus mode that pauses notifications on the server ([#372](https://github.com/ColdPhase/flux/pull/372)); Kreska's
  small moments: splash, loading, empty Inbox, offline, no results, pull to refresh ([#382](https://github.com/ColdPhase/flux/pull/382)); text size and
  reduce motion in Appearance ([#452](https://github.com/ColdPhase/flux/pull/452)); light motion for dialogs, the panel, views, state changes and
  press ([#608](https://github.com/ColdPhase/flux/pull/608)), with view switches that do not flicker and an animated sidebar ([#722](https://github.com/ColdPhase/flux/pull/722));
  app-drawn selects instead of the browser's ([#699](https://github.com/ColdPhase/flux/pull/699)).

### Run and operate

- One Docker Compose application with the API, a separate worker, PostgreSQL and a durable job
  queue ([#34](https://github.com/ColdPhase/flux/pull/34)); `./flux up`, `demo` and `dev`
  ([#102](https://github.com/ColdPhase/flux/pull/102)).
- `./flux backup`, `restore`, `export` and `upgrade` ([#127](https://github.com/ColdPhase/flux/pull/127));
  an exact migration-ledger check that refuses a mismatched database
  ([#130](https://github.com/ColdPhase/flux/pull/130)).
- A pull-only operator Compose file and versioned installation assets
  ([#159](https://github.com/ColdPhase/flux/pull/159)), and a tested HTTPS reverse-proxy example
  ([#366](https://github.com/ColdPhase/flux/pull/366), [reverse proxy](../operations/reverse-proxy.md)).
- A separate `keyring` service on an internal network (for encrypted workspaces, not yet usable, see the known limits) and memory limits with
  swap limited to the same value for `api`, `worker` and `keyring` ([#668](https://github.com/ColdPhase/flux/pull/668)); `./flux upgrade` adds its
  token to `docker/.env`. `./flux clean` and `reset` work after a first `./flux up` that stopped before the migration ([#671](https://github.com/ColdPhase/flux/pull/671)).
- Documentation: a README that answers what Flux is, who it is for and how to try it, and a documentation site on GitHub Pages built from the
  repository ([#740](https://github.com/ColdPhase/flux/pull/740)).
- Two public extension contracts with a compatibility promise: MCP tool contract 1 and project
  export format 1 ([#260](https://github.com/ColdPhase/flux/pull/260),
  [integration guide](../integrations/README.md)).

## Known limits

### Out of v0.1 by recorded decision

- No hosted service; the release is GitHub Release assets and a GHCR image only. No Helm chart
  (O-004).
- No delegated decision acceptance with a scope and an expiry (O-009 DA-5).
- Extension contracts other than MCP tool contract 1 and project export format 1: no outbound
  webhooks, REST/OpenAPI API with integration tokens, public event vocabulary, supported SDK,
  plugins or UI slots, export re-import or MCP output schemas (O-010 EXT-D1–D7).
- No additional opaque MCP connection keys ([#317](https://github.com/ColdPhase/flux/issues/317),
  canceled); agents connect through OAuth.
- No enterprise certification, pricing, closed edition, unsupported provider subscriptions or
  native app-store packages (O-004).

### Off until the operator turns it on

- The agent in Flux on an owner's AI connection: `FLUX_PERSONAL_RUNS`.
- Background comparisons: `FLUX_BACKGROUND_COMPARISONS`.
- The owner's own Claude Code or Codex in a runtime slot: `FLUX_AGENT_RUNTIME`. Codex must work in
  v0.1 (founder direction 2026-10-16, [#281](https://github.com/ColdPhase/flux/issues/281)), not be
  marked "coming soon". The first interactive `./flux up` asks once whether to turn it on (Enter
  enables Codex; Claude Code needs a typed `y` for Anthropic's Commercial Terms), and a host whose
  engine cannot run the slots, for example one with `kernel.yama.ptrace_scope` 0, gets one line
  saying why instead.
- Live media is a separate overlay (`docker/compose.live.yaml`) and is not part of the release's
  operator `compose.yaml` yet.

### Accepted residual limitations at the candidate (from the #249 report)

> **Placeholder.** Fill in from the [#249](https://github.com/ColdPhase/flux/issues/249) report
> at the accepted candidate: each independently recorded scope exclusion or accepted residual limitation, its issue and what a person sees; an open required outcome is never listed here, because it blocks candidate acceptance and publication until it is fixed and verified.
>
> - `<item>` ([#N](https://github.com/ColdPhase/flux/issues/N)): `<effect>`

## Upgrade and backup

- **This is the first release.** There is no earlier version to upgrade from
  ([release pipeline](../development/release-pipeline.md)).
- **Back up before every upgrade**, as a pair: PostgreSQL and the files volume, taken while the
  API and worker are stopped. Keep `.env` with the backup; it holds the database password,
  `FLUX_AUTH_SECRET` and the VAPID keys. Treat backups as secrets and copy them off the machine.
- **Upgrade a release** by downloading the new release into a new directory, copying `.env`
  unchanged (the same `FLUX_PROJECT` keeps the same volumes), then `pull` and `up -d --wait`.
  The migration runs before the API and the worker start.
- **Going back** means restoring the backup with the previous release's files. Forward
  migrations are not reversible; never run an older image over a migrated database. If the
  PostgreSQL major version changes between releases, restore into a fresh installation instead.
- **After restoring an older backup**, access revoked since then is active again. Revoke agent
  connections and OAuth tokens before the API starts (`revoke-agent-access`).
- From a source checkout the same steps are `./flux backup`, `./flux upgrade` (which backs up
  first) and `./flux restore`.

Details: the release's `INSTALL.md` ([source](../operations/release-guide.md)),
[backup and restore](../operations/backup-restore.md) and [upgrade](../operations/upgrade.md).

## Checksums

> **Placeholder.** Fill in from the published release after the exact artifact review
> (`ACCEPTED RELEASE ARTIFACT …` on [#249](https://github.com/ColdPhase/flux/issues/249)).

| Item | Value |
| --- | --- |
| Image (`linux/amd64`, `linux/arm64`) | `ghcr.io/coldphase/flux@sha256:<DIGEST>` |
| Source commit (`release.json`) | `<CANDIDATE SHA>` |
| SHA-256 of `SHA256SUMS` | `<SHA-256>` |

`SHA256SUMS` covers `compose.yaml`, `env.example`, `INSTALL.md`, `release.json`,
`sbom.spdx.json`, `THIRD_PARTY_NOTICES.json` and `LICENSE`. Check the assets and, optionally,
the image's build provenance:

```sh
sha256sum -c SHA256SUMS      # macOS: shasum -a 256 -c SHA256SUMS
gh attestation verify oci://ghcr.io/coldphase/flux@sha256:<DIGEST> --repo ColdPhase/flux
```

## Notes for the finaliser

Remove this section before publishing.

- **Live co-editing is not a known limit.** #307 lists "no live co-editing in v0.1", but the
  [2026-10-07 scope amendment](https://github.com/ColdPhase/flux/issues/249#issuecomment-6042227715)
  (F-021) requires live map and wiki in v0.1.0. At the 2026-10-23 refresh
  [#228](https://github.com/ColdPhase/flux/issues/228), [#231](https://github.com/ColdPhase/flux/issues/231),
  [#238](https://github.com/ColdPhase/flux/issues/238) and [#314](https://github.com/ColdPhase/flux/issues/314)
  are closed and listed under "What works". Restate them from the #249 report at the candidate; an
  unresolved gate blocks the release and does not become an exclusion here.
- **Open at the 2026-10-30 refresh.** Each is either fixed before the candidate or listed above with what a
  person sees. Fixed since 2026-10-23: Codex's sign-in with a connection that grants fewer than the three actions
  it asks for ([#660](https://github.com/ColdPhase/flux/issues/660)) and an agent's suggestion having no screen
  ([#661](https://github.com/ColdPhase/flux/issues/661)) in [#673](https://github.com/ColdPhase/flux/pull/673);
  `./flux clean` refusing after a first `./flux up` that stopped before the migration
  ([#662](https://github.com/ColdPhase/flux/issues/662)) in [#671](https://github.com/ColdPhase/flux/pull/671);
  light motion ([#593](https://github.com/ColdPhase/flux/issues/593)); and installation and notifications on emulated
  phones and tablets ([#20](https://github.com/ColdPhase/flux/issues/20), closed). Still open:
  - **Encrypted workspaces ([#655](https://github.com/ColdPhase/flux/issues/655)).** Required in v0.1.0 by founder
    direction of 2026-10-23, so it blocks candidate acceptance and is not a known limit. The keyring, sealed
    content, notifications, locking, restore and rotation slices are on `main`; S3, the creation route and the
    interface, is the open [#670](https://github.com/ColdPhase/flux/pull/670). Until it merges nobody can create an
    encrypted workspace, so the "What works" list says nothing about it. Add a section from the accepted contract
    ([encrypted workspaces](encrypted-workspaces.md)) only after S3 and its acceptance.
  - The workspace AI lock ([#614](https://github.com/ColdPhase/flux/issues/614)), adaptive layouts
    ([#151](https://github.com/ColdPhase/flux/issues/151)), live-collaboration device evidence
    ([#63](https://github.com/ColdPhase/flux/issues/63)), the first agent reply through a person's own client on a
    clean clone ([#320](https://github.com/ColdPhase/flux/issues/320)), the time-to-first-run issue
    ([#305](https://github.com/ColdPhase/flux/issues/305)) and the acceptance itself
    ([#249](https://github.com/ColdPhase/flux/issues/249)).
- **The changelog.** At the 2026-10-30 refresh 134 pull requests are named here. The 12 user-visible changes that had
  no entry now have one under `changes/` (live co-editing, the workspace AI lock, MCP switches, AI-task Undo,
  partial consent, the assistant's authority and Undo, PWA install and push, co-work Start/Resume and the Codex
  fixes). 45 pull requests are still not cited by their own number; each is covered by an entry that cites its
  issue, except [#291](https://github.com/ColdPhase/flux/pull/291), which changes tests only. Run
  `python3 scripts/changelog.py check`, then `python3 scripts/changelog.py release 0.1.0 <date>` at release.
- **Quick-start times.** The numbers in "Quick start" come from the 2026-10-30, 2026-10-23 and 2026-10-11 runs
  in [time to first run](../development/time-to-first-run.md). The 2026-10-30 run was on a heavily loaded host.
  Re-measure on the candidate and replace them; the macOS figures still need a re-run, and no number covers a
  person's first reply through their own MCP client.
- **Phone and tablet.** The PWA and phone views are merged and [#20](https://github.com/ColdPhase/flux/issues/20)
  closed on 2026-10-30 with its emulation evidence; the adaptive-layout issue
  ([#151](https://github.com/ColdPhase/flux/issues/151)) is open. Keep the wording to what the report accepts.
- **The two AI modes.** The real-client (PROV-5) and real-key (PROV-6) evidence was external at
  the matrix pin; state only what the report verified.
- **Media.** Founder gate [#763](https://github.com/ColdPhase/flux/issues/763): the README and docs-site screenshots, the
  GIF and the [video](launch-video.md) are recorded from the audited build, after the audit's UI/UX fixes are merged,
  and again from the released revision. `./scripts/record_media.sh` regenerates the GIF, the stills and the scripted
  clips in one go ([how](../assets/demo/README.md)). Put the video's link here.
- **The release upgrade path.** If an rc was published first, replace "This is the first
  release" with the tested upgrade from that rc (R-13).

## Release-day steps for L-3

For whoever publishes ([CI and releases](../agents/ci-and-releases.md)); these are the two repository changes that
[#307](https://github.com/ColdPhase/flux/issues/307) asks for at release, which cannot be made before the candidate is accepted.

1. **Changelog.** `python3 scripts/changelog.py check && python3 scripts/changelog.py release 0.1.0 <YYYY-MM-DD>`,
   then read the `[0.1.0]` section once; the "No version has been released yet" sentence under `[Unreleased]` must
   not survive.
2. **Build log.** Append an entry at the end of [the build log](../build-log.md) (new entries go at the end; the log's
   last entry is 2026-10-07, so add one line pointing at the [story](launch-story.md) for the weeks in between):

   ```markdown
   ## <YYYY-MM-DD> — Flux v0.1.0

   - **Released.** `v0.1.0` from the accepted candidate `<SHA>`. Release: <RELEASE URL>. Acceptance:
     the `ACCEPTED RELEASE CANDIDATE` lines on issue #249. The assets and the image are checked against
     `SHA256SUMS` and the build provenance as the release notes describe.
   - **What it contains.** The release notes at the release URL and the `[0.1.0]` section of
     `CHANGELOG.md` (link both with Markdown links relative to `docs/`). Known limits are listed there.
   - **How we show it.** The README GIF and stills and the launch video were recorded from the tag.
     Video: <VIDEO URL>.
   ```
3. **Notes.** Fill the version, the candidate commit, the date, the accepted residual limitations and the checksums
   from the release; delete "Draft, not a release" and the "Notes for the finaliser" section.
4. **Media.** On a clone of the tag, once the [#763](https://github.com/ColdPhase/flux/issues/763) audit fixes are
   in it: `FLUX_VIDEO_VERSION=<VERSION> ./scripts/record_media.sh <dir>` (the GIF and stills land in `docs/assets/`;
   commit those two only), then the human steps in the [video script](launch-video.md#after-the-recording).
5. **Posts.** The [posts](launch-posts.md) and the [story](launch-story.md) are the founders' to publish.
