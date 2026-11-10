# Flux v0.2.0

Flux v0.2 is a simpler Flux with simpler AI. One Flux is now one company with a flat list of **spaces**,
everything that works for you with AI is an **agent**, and a lot that was rarely used is gone. It is
also lighter on a small server, and its security was reviewed and hardened.

Documentation: <https://coldphase.github.io/flux/>. Flux is open source under the AGPL-3.0.

## Read this first: v0.1 is not upgraded

**v0.2 starts from empty data.** v0.1.0 had no users, so v0.2 converts nothing and keeps no compatibility
with its data, its API shapes or its file formats.

- `./flux upgrade` refuses an instance that Flux v0.1 wrote, before it takes a backup or stops anything, and says so.
  The migration step that every start runs refuses it too, and so does `./flux restore` of a v0.1 backup
  (with or without `--migrate`). Your v0.1 data stays exactly as it was.
- There is nothing to import. The project export of v0.1 (`./flux export`) gives open JSON and files you can
  keep and read, but neither version has an import for it.
- To move to v0.2, install it fresh: in a new folder with its own volumes, or in the same folder after
  `./flux reset` (it deletes the instance's data after you confirm). Then create your company and
  its spaces again. The [upgrade guide](https://coldphase.github.io/flux/operate/upgrade/) has the steps.

From v0.2 on, `./flux upgrade` takes a backup and migrates forward as before.

## What is new for the people who use Flux

- **One company, many spaces.** The first account on a Flux sets up the company and owns it, with the
  default space **Everyone**, which holds the whole company. Everything else people do together happens in
  spaces (what v0.1 called projects). You see only the spaces you were added to. **New › Space** is one
  window: a name, the people, an AI switch that starts on, and an optional **Encrypted** switch. A space has
  two roles, member and admin. People join the company by a one-time invite link, or, with single sign-on,
  by signing in. **Settings › Company** holds the company's people, its spaces and the people who left, with
  Restore.
- **A calmer app.**
  - The sidebar is Home, Inbox, My tasks, My map, Spaces and Messages.
  - **Create** has the same five types on the computer and the phone: Task, Thought, Decision, Page and Space.
  - A message has Reply in thread, Create task and a ⋯ menu (Add to map, Copy link, Copy text, and Edit and
    Delete on your own messages).
  - There is one search (⌘K) and one place for what needs you, the Inbox, with its top three on Home.
  - A task is To do, Doing, Blocked or Done, and a blocked task goes back to Doing by itself when what it waited for is
    resolved.
  - The Wiki is edited where it is read, and versions save by themselves.
  - An idea is a **Thought** and a canvas is a **Map**; your private map is **My map**.
- **AI that is the same everywhere.**
  - **Connect AI once.** In Settings › AI you connect a Claude plan, a ChatGPT plan or an API key (or all of them).
    Flux sets no limits of its own: when a plan is at its limit the work waits and resumes by itself, and an API
    key has one daily budget that you set.
  - **Everything is an agent.** You get an agent called **Assistant**, and can add more (a Planner, a Reviewer),
    each with its own instructions, model and a memory of what you told it to remember. Each agent is a private
    chat in Messages.
  - **`/ai` in any conversation.** The answer is only yours, with **Dismiss** and **Show everyone**. It uses only what the
    conversation's people can already see.
  - **Agents act with your rights, no more.** Each agent has one setting, **What it may do**: Only read, Do it and tell me
    (the default) or Ask me first. Deleting something and changing other people's things always wait for your OK in
    your Inbox, and only you can give it. Every change an agent makes has an **Undo** on its message.
  - **Agents take tasks.** Give a task to one of your agents in its Owner field. It works in the task's one discussion,
    can split the task into subtasks and ask other people's agents questions, and finishes the way its setting says.
    You can Stop it.
  - **Schedules by asking.** Tell an agent "every weekday at 9, summarise what changed in Garden"; it shows what
    it prepared, you turn it on with one tap, it runs at 9:00 on your own clock (your browser's time zone), and the results arrive in its chat.
  - **The web.** Agents search the web and read public pages as much as a question needs, and list what they searched and
    opened. They are told never to put anything from Flux into an address, and Flux refuses an address that carries
    text the agent read in Flux. The operator can turn this off (`FLUX_WEB_READS=off`).
  - **AI where you want it.** Each space has its own AI switch. A guest has no AI. An encrypted space never has AI.
- **Your own Claude Code or Codex.** Add Flux to the client with the two commands on the Connect page, sign in, and
  choose **Allow**: that is the whole setup. The client then acts with your rights, in the spaces where AI is
  on, with the same **What it may do** setting, and what it writes shows as "Ada · via Claude Code". It is
  still your own computer and your own account.
- **Encrypted spaces, per space.** Any member who is not a guest can switch **Encrypted** on when making a space.
  Its content is encrypted on the server and it has no AI. Only the space's admins and a recovery code can open it;
  the company's admins can delete it but not read it. After a server restart it waits until one of its admins
  enters their unlock password, and the rest of the company works as usual.

## What is new for the operator

- **Server agents.** The operator decides how people connect AI:
  - *API keys* need `FLUX_PERSONAL_RUNS=on` and a key file (`FLUX_BACKGROUND_KEY_HOST_FILE`), as before. Off by default.
  - *Claude and ChatGPT plans* need the optional agent runtime (`FLUX_AGENT_RUNTIME`, off by default; `./flux up`
    asks once in a terminal, or `./flux ai on` later). **One runtime now serves everyone**, each person under their own
    user id. How many agents run at once follows from its memory (about 2 on a 4 GB server) and the others wait;
    `FLUX_RUNTIME_MAX_RUNS` sets the number. A host that does not meet a requirement, such as a Yama `ptrace_scope` of 0,
    stops the runtime with one message and the fix instead of restarting in a loop. See the
    [agent runtime guide](https://coldphase.github.io/flux/operate/agent-runtime/).
- **Docker Engine 25 or newer is required** (the health checks use `start_interval`). `./flux` says so before it starts,
  and `docker compose up` refuses an older engine.
- **Lighter on a modest server.** The default memory limits are `FLUX_DB_MEMORY` 768m (new), `FLUX_API_MEMORY` 1536m and
  `FLUX_WORKER_MEMORY` 512m, 2.9 GiB for the base stack on a 4 GB host; raise them if your instance needs more. An idle Flux
  used about 1% of one core when the release was measured, health checks are small programs, and job queues wake the worker instead
  of being polled. An open page no longer polls the server on a timer while its live connection is up, and the application image is about 215 MB.
- **Settings.** New: `FLUX_WEB_READS` (on), `FLUX_RUNTIME_MAX_RUNS`, `FLUX_RUNTIME_MEMORY`, `FLUX_RUNTIME_CPUS`, `FLUX_DB_MEMORY`,
  `FLUX_SESSION_IDLE` and `FLUX_SESSION_MAX_AGE`. Removed: `FLUX_BACKGROUND_COMPARISONS` and `FLUX_RUNTIME_SECRET_2` to `_4`
  (there is one runtime secret). The [configuration reference](https://coldphase.github.io/flux/operate/configuration/)
  lists every setting.
- **Local clients and MCP.** The MCP tool contract is now version 2: no scopes, no capability switches and no per-project grants;
  a client has its person's rights. Integrators read the [integration guide](https://coldphase.github.io/flux/integrate/).
- **No in-app switch for the whole company's AI.** AI is switched per space, by its admins and the company's admins.
- **Installing.** `./flux up` and `./flux demo` work as before, and `./flux demo` now speaks the app's words (a company, a space,
  a Map with Thoughts, a Wiki page).

## Security

Flux was reviewed and hardened for this release. An agent that did not write the code reviewed it, and the work is recorded in
[`docs/security/`](https://github.com/ColdPhase/flux/tree/main/docs/security). It is not a human audit, and an external
penetration test and cryptography review are still planned before Flux is offered for production use by companies.

- **Reviews and tests.** A written [threat model](https://github.com/ColdPhase/flux/blob/main/docs/security/threat-model.md) and an
  [OWASP ASVS Level 2 checklist](https://github.com/ColdPhase/flux/blob/main/docs/security/asvs-l2.md); a
  [penetration test](https://github.com/ColdPhase/flux/blob/main/docs/security/pentest-v0.2.md) of authorization and isolation between
  spaces and people, which found no break; and a dynamic scan with OWASP ZAP (`./scripts/check_dast.sh`) of the running application.
- **Fixed after the review.**
  - A password now needs 12 to 128 characters, must not be a common password, and sign-in backs off per account, not only per address.
  - A password reset, and signing out the other devices, also disconnect local AI clients.
  - Unexpected server errors no longer tell the browser their internal message.
  - Responses carry `X-Content-Type-Options`, `Referrer-Policy` and `Permissions-Policy`, API answers are not cached, and an `https`
    origin gets `Strict-Transport-Security`.
  - Pages carry a Content-Security-Policy with no inline or eval scripts.
  - A floor of rate limits sits under every route, and sessions have an absolute life (30 days by default).
  - The first account on a newly exposed server no longer silently becomes its owner: the install guide has you sign up first,
    and `./flux up` warns while nobody has.
  - Failed sign-ins, password changes, consent decisions, refused requests and space unlocks are written to a
    [security log](https://coldphase.github.io/flux/operate/monitoring/).
- **Dependencies and images.** Production dependencies with high or critical advisories were upgraded. Dependabot, a dependency audit and CodeQL
  run on the repository. The release workflow scans both images and does not publish while one has a high or critical finding with a fix (apart from reviewed exceptions), and it
  signs both image digests (cosign, Sigstore) so you can check the signature and the build provenance before you pull
  ([how](https://coldphase.github.io/flux/operate/release-guide/)).
- **Agents and the web.** What a page says is data and never an order. An agent has its owner's rights only, deleting waits for the owner, only the
  owner can approve, and nothing an agent reads can add to its memory.

## Install

You need a Linux server with Docker Engine 25 or newer and the Compose plugin, about 4 GB of memory, and a domain name for HTTPS. The full
guide is [Install from a release](https://coldphase.github.io/flux/operate/install-release/); in short:

1. Download every file of this release into an empty folder and check them with `sha256sum -c SHA256SUMS`. Optionally check the image
   signatures and provenance first (see `INSTALL.md`).
2. Run `cp env.example .env && chmod 600 .env`, then set `POSTGRES_PASSWORD`, `FLUX_AUTH_SECRET`, `FLUX_PUBLIC_ORIGIN`, `FLUX_KEYRING_TOKEN`
   and `FLUX_KEY_PIN_SECRET` (`openssl rand -hex 32` for each secret; never change the pin secret and keep it with your `.env` backups).
3. Run `docker compose --env-file .env -f compose.yaml pull`, then `docker compose --env-file .env -f compose.yaml up -d --wait`.
4. Put an HTTPS reverse proxy in front of `127.0.0.1:8081` (tested
   [Caddy, nginx and Traefik examples](https://coldphase.github.io/flux/operate/reverse-proxy/)), open your address and **create the first
   account yourself, before anyone else can reach the address**: it becomes the company's owner.
5. Optional: AI. Set `FLUX_PERSONAL_RUNS=on` and the key file for API keys, and add the agent runtime for Claude and ChatGPT plans
   (`runtime.sh`); calls and screen sharing need `compose.live.yaml`. The steps are in `INSTALL.md`.

To look around first, clone the repository and run `./flux up`, then `./flux demo` for sample data
([quick start](https://coldphase.github.io/flux/start/quick-start/)). Connect your own Claude Code or Codex with
[Connect your own agent](https://coldphase.github.io/flux/start/connect-your-agent/).

## Back up your data

Back up from the start. A backup is the database and the files volume, taken together while the API and worker are stopped, with your `.env` kept
beside it; copy it off the machine, and check it by restoring it somewhere else. The commands are in `INSTALL.md` and in
[Backup and restore](https://coldphase.github.io/flux/operate/backup-restore/).

## Platforms

- **Published images: `linux/amd64` (x86_64) only.** `linux/arm64` is planned for v0.3
  ([#833](https://github.com/ColdPhase/flux/issues/833)). A source checkout (`./flux up`) builds on arm64.
- **Browsers.** Phones and tablets are tested in Chromium and WebKit emulation in Docker, not on physical devices. Web Push on iPhone and iPad
  works only from the Home Screen app, on iOS or iPadOS 16.4 or later, and needs HTTPS and the three `FLUX_VAPID_*` settings
  ([guide](https://coldphase.github.io/flux/operate/mobile-and-push/)).
- Flux does not support Kubernetes or Helm yet. Docker Compose is the only supported install. The agent runtime needs a Linux engine with Yama
  `ptrace_scope` of 1 or higher; Docker Desktop cannot run it.

## Known limits and what comes next

- **No upgrade from v0.1** (above).
- **AI was tested with the real Claude Code and Codex programs against a local model**, and with fake CLIs and mock providers in Docker; it was not
  run on live Claude or ChatGPT plans as part of the release check. A named provider without a dated real-key test is unverified.
- **Server agents never write code or post by themselves.** Code changes come from your own Claude Code or Codex over MCP, and a server agent
  speaks to other people only when you choose Show everyone. A server agent reads the web with the operator's setting on, and a web search
  sends the agent's query to the provider's search partner.
- **Encrypted spaces protect a copy of the data or a server taken away switched off.** They do not protect against someone who controls the running,
  unlocked server, and Flux is not end-to-end encrypted. Names, structure, times, task states and owners stay visible. If every unlock password
  and the recovery code are lost, nobody can recover the space. A host with swap needs it off or encrypted. See
  [encrypted spaces](https://coldphase.github.io/flux/operate/encrypted-spaces/).
- **Calls and screen sharing** need the optional `compose.live.yaml`, public media ports and a public IPv4 address. Phone browsers cannot share
  their screen.
- **Email** works through any SMTP server you set in `FLUX_SMTP_URL`; set up SPF, DKIM and DMARC for your own domain. Flux sends no invitation
  email: an invite is a link you send yourself.
- **Re-import of a project export, Kubernetes and Helm** are later. There is no hosted service. The MCP tool contract and the project export
  format are the only public extension contracts; there is no REST API, webhook or plugin interface yet.

## Check your download

`SHA256SUMS` lists every other file of the release. `release.json` names the source commit and the exact images
(`ghcr.io/coldphase/flux@sha256:…` and `ghcr.io/coldphase/flux-agent-runtime@sha256:…`). Check the signatures with `cosign verify` and the build
provenance with `gh attestation verify`, as `INSTALL.md` shows.

## Full list of changes

The [changelog](https://github.com/ColdPhase/flux/blob/main/CHANGELOG.md) lists everything in this release.
