# Flux v0.1.0

This is the first release of Flux.

Flux is an open source workspace where people and AI agents work on the same projects: conversations,
and the tasks, decisions and documents that come out of them. You run it on your own server with
Docker Compose, and an agent sees only the projects and actions you give it.

Documentation: <https://coldphase.github.io/flux/>. Flux is open source under the AGPL-3.0.

## Highlights

- **Conversation that turns into work.** Make a message a task, a decision with its reason, or a result.
  Each stays linked to the message it came from. Decisions are accepted by a person who can edit the
  project, never by an agent.
- **Tasks.** Criteria, an owner, a due date and a state you change in one tap. A blocked task names the
  person it waits for, and that person gets it in their Inbox.
- **Wiki and Map.** A project Wiki with page history and Markdown import, and a Map of connected
  thoughts on an infinite canvas. Several people can edit a page or a map at the same time and see who
  is there. An operator can turn live editing off.
- **Inbox, "Needs you".** One queue for the proposed decisions you can accept, the questions asked of
  you, your blocked tasks and your mentions. Home shows what changed since you left and the next step.
- **People and agents.** Connect your own Claude Code, Codex or any MCP client to the projects you choose.
  It runs on your computer with your own model account. You grant exactly the actions it may use, and it
  is named as the author of what it does. Co-work Start and Resume prompts, hand-offs, pause and stop are
  built in. Flux was tested with the real Claude Code and Codex.
- **Phone and tablet.** The same design on a computer and a phone. Install Flux as a web app (PWA) and
  get Web Push notifications, including on iPhone and iPad. Web Push needs HTTPS and the three
  `FLUX_VAPID_*` settings ([guide](https://coldphase.github.io/flux/operate/mobile-and-push/)).
- **Calls and screen sharing.** Join a live session from a project, follow someone and share a screen.
  This is optional and not in the downloadable `compose.yaml` yet (see the limits).
- **Encrypted workspaces.** When you create a workspace (a "space" in the app) you can encrypt it. Its
  content is encrypted in the database, the files and the search index, and the key lives only in memory.
  After every restart it stays locked until an owner or admin enters their unlock password. There is a
  recovery code, shown once. An encrypted workspace never has AI.
- **Backups.** Back up and restore the database and the files together, and export a project as JSON
  plus files.
- **AI is optional.** Flux is useful with no AI at all. A workspace owner or admin can turn AI off for the
  whole workspace, and the in-app assistant and the runtime that runs Claude Code or Codex on your server
  are off until the operator switches them on.
- **For operators.** One Docker Compose stack, optional single sign-on with your OpenID Connect provider,
  one-time invite links for people without an account, and a configuration reference generated from the code.

## Install

You need a Linux server with Docker Engine and the Compose plugin, about 4 GB of memory, and a domain name
for HTTPS. The full guide is
[Install from a release](https://coldphase.github.io/flux/operate/install-release/); in short:

1. Download every file of this release into an empty folder and check them with `sha256sum -c SHA256SUMS`.
2. Run `cp env.example .env && chmod 600 .env`, then set `POSTGRES_PASSWORD`, `FLUX_AUTH_SECRET` and
   `FLUX_PUBLIC_ORIGIN`.
3. Run `docker compose --env-file .env -f compose.yaml pull`, then
   `docker compose --env-file .env -f compose.yaml up -d --wait`.
4. Put an HTTPS reverse proxy in front of `127.0.0.1:8081` (tested
   [Caddy, nginx and Traefik examples](https://coldphase.github.io/flux/operate/reverse-proxy/)), open your
   address and create the first account.

The same steps are in `INSTALL.md`, attached to this release. To look around first, clone the
repository and run `./flux up`, then `./flux demo` for sample data
([quick start](https://coldphase.github.io/flux/start/quick-start/)). Connect your own agent with
[Connect your own agent](https://coldphase.github.io/flux/start/connect-your-agent/).

## Back up your data

This is a 0.1 release, so back up from the start. A backup is the database and the files volume, taken
together while the API and worker are stopped, with your `.env` kept beside it. Copy it off the machine.
The commands are in `INSTALL.md` and in
[Backup and restore](https://coldphase.github.io/flux/operate/backup-restore/). Check a backup by restoring
it somewhere else before you rely on it.

## Platforms

- **Published image: `linux/amd64` (x86_64) only.** Run it on a Linux server with Docker Engine and Compose.
- **`linux/arm64` follows in v0.1.1**, after a test on real arm64 hardware. A source checkout (`./flux up`)
  builds on arm64 and was measured on a Mac, but Linux arm64 servers are not tested yet.
- **Browsers.** Phones and tablets are tested in Chromium and WebKit emulation in Docker, not on physical
  devices. Web Push on iPhone and iPad works only from the Home Screen app, on iOS or iPadOS 16.4 or later.
- Flux does not support Kubernetes or Helm yet. Docker Compose is the only supported install.

## Known limits and what comes next

- **No `linux/arm64` image yet.** It comes in v0.1.1.
- **Calls and screen sharing need the optional live-media overlay** from a source checkout. The release
  `compose.yaml` does not include it. Call quality was measured in a Docker simulation of a public host with
  Chromium, Firefox and WebKit, not on real networks or devices. Phone browsers cannot share their screen, and Flux says so.
  See [live media](https://github.com/ColdPhase/flux/blob/main/docs/development/live-media.md).
- **Agents do not wake up by themselves.** You start or resume work from your own Claude Code or Codex.
  Flux shows the requests that wait for an agent ([#754](https://github.com/ColdPhase/flux/issues/754)).
- **GitHub.** A project can link tasks to pull requests, tested with simulated GitHub events. Installing a
  real GitHub App and publishing reviews comes later ([#755](https://github.com/ColdPhase/flux/issues/755)).
- **Sharing a Wiki page with people outside Flux** comes later
  ([#778](https://github.com/ColdPhase/flux/issues/778)).
- **Deleting your account**, with a handover of your content, comes later
  ([#775](https://github.com/ColdPhase/flux/issues/775)).
- **Encrypted workspaces protect a copy of the data or a server taken away switched off.** They do not
  protect against someone who controls the running, unlocked server, and Flux is not end-to-end encrypted.
  Names, structure, times, task states and owners stay visible. If every unlock password and the recovery
  code are lost, nobody can recover the workspace. A host with swap needs it off or encrypted. See
  [encrypted spaces](https://coldphase.github.io/flux/operate/encrypted-spaces/).
- **Email** works through any SMTP server you set in `FLUX_SMTP_URL`. It was tested against a test mail
  server, so set up SPF, DKIM and DMARC for your own domain.
- **Kubernetes and Helm** are later.
- There is no hosted service. Only the MCP tool contract 1 and the project export format 1 are public
  extension contracts: there is no REST API, webhook or plugin interface yet.

## Check your download

`SHA256SUMS` lists every other file of the release. `release.json` names the source commit and the exact
image (`ghcr.io/coldphase/flux@sha256:…`). To check the build provenance of that image, run
`gh attestation verify oci://ghcr.io/coldphase/flux@sha256:<digest from release.json> --repo ColdPhase/flux`.

## Full list of changes

The [changelog](https://github.com/ColdPhase/flux/blob/main/CHANGELOG.md) lists everything in this release.
