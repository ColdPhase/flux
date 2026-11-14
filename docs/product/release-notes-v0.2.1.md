# Flux v0.2.1

Flux v0.2.1 is faster on a small server, fixes and finishes what people met in v0.2, and has AI working right after install.
Every agent now runs in Flux's agent runtime: your own Claude Code or Codex for a plan, and pi for every API key. Calls tell the
space and are easier to join, agents answer as they write and can search everything their owner may read, files and videos open
inside Flux, and search ranks by BM25 in Flux's own database image. It is the first release that installs one way: its `flux`
launcher pulls the release's images, and `./flux upgrade` moves to the next release.

Documentation: <https://coldphase.github.io/flux/>. Flux is open source under the AGPL-3.0.

## Read this first: install and upgrade

- **One install path** ([#1471](https://github.com/ColdPhase/flux/issues/1471), founder decision 5). Download `flux.tar.gz`,
  `SHA256SUMS` and its signature, check, unpack, `./flux up` ([installation](https://coldphase.github.io/flux/operate/install/)). The
  release is a folder; its launcher pulls the release's images by digest, and nothing is built. Later releases install with
  `./flux upgrade`, which always checks the download against `SHA256SUMS` and its signature first (with cosign on the host, or the pinned
  cosign image through Docker), and refuses and changes nothing when it cannot.
- **From v0.2.0: install fresh.** v0.2.0 was installed from loose Compose files, so v0.2.1 brings no way to move that installation
  into the release folder. Its data would upgrade: this release was tested to upgrade the data of **v0.2.0** (the "Upgrades from"
  line of the release page names what was tested).
- **Flux AI needs a recent Linux host.** Every agent runs in the agent runtime, which needs Linux 6.7 or later and
  `kernel.yama.ptrace_scope` of 1 or higher on the host that runs Docker. The first `./flux up` checks. Where the host cannot run it, AI
  stays off and one line says why (owners and admins read it in Settings › AI too). A kernel before 6.7 gets:

  ```text
  AI agents stay off, as the agent runtime cannot run here: Flux AI needs a newer Linux (kernel 6.7 or later, e.g. Ubuntu 24.04 or Debian 13). See docs/operations/agent-runtime.md.
  ```

  A host with `ptrace_scope` 0 gets the fix in the same line: `sudo sysctl -w kernel.yama.ptrace_scope=1`, and to keep it after a restart
  `echo 'kernel.yama.ptrace_scope = 1' | sudo tee /etc/sysctl.d/90-flux.conf`. Docker Desktop on a Mac has no Yama, so AI stays off
  there and the rest of Flux runs ([agent runtime](https://coldphase.github.io/flux/operate/agent-runtime/)).
- **HTTPS and calls come with `./flux up`.** With an `https` address in `FLUX_PUBLIC_ORIGIN` it starts its own Caddy, which gets and
  renews the certificate (open ports 80 and 443). `FLUX_CALLS=on` adds the media server, writes its keys and public address, and
  prints the ports to open. Your own reverse proxy still works: set `FLUX_TRUSTED_PROXIES` and Caddy is not started.
- **The database image changes.** From v0.2.1 the database runs Flux's own image, `ghcr.io/coldphase/flux-database`: the official
  PostgreSQL 18 on Debian with the `pg_search` extension (BM25 search) and `pgvector`. The same PostgreSQL major reads your data
  directory as it is; the release names the new image. The image is about 500 MB larger.
  Migration `0065` builds the search index and recomputes what the old image (musl) computed differently for rare characters; on
  302,000 messages it took 28 s (the whole `./flux upgrade`, with its images already built, 77 s), while Flux was stopped. A
  database that is not Flux's image (your own PostgreSQL) stops the upgrade before anything changes, with `FLUX_DATABASE_IMAGE …`
  and what to do ([upgrade notes](https://coldphase.github.io/flux/operate/upgrade/#v021-the-database-image-changes)).
- **`FLUX_SIGNUP` is removed.** Accounts now come only from a link ([below](#accounts-and-passwords)); `./flux upgrade` names the
  old line, which you can delete. New: `FLUX_SETUP_TOKEN` (the setup link's token; `./flux up` writes it, and an instance that
  already has its company never needs it), and, all optional, `FLUX_VIDEO_MAX_MIB` (200), `FLUX_EMBEDDINGS` (off) and
  `FLUX_EMBEDDINGS_MEMORY` (6g).
- **Your reverse proxy** must now accept request bodies as large as the largest video you allow (`FLUX_VIDEO_MAX_MIB`, 200 MiB by
  default; nginx: `client_max_body_size 210m`) and pass `Range` requests and `206 Partial Content` answers through, or videos fail to
  upload (413) or to seek ([reverse proxy](https://coldphase.github.io/flux/operate/reverse-proxy/)).
- **A downgrade is not supported.** The way back is the backup you took before the upgrade.

## Calls

- **Starting a call tells the space.** The people of the space get an Inbox item with **Join**, the space shows a live dot, the call
  has **Invite…**, and a call nobody joins ends by itself.
- **One call per space.** A call started from a conversation is the space's call, and while it runs every view of the space shows
  **Join** in its header. The call is one line in the conversation or task it started from: who was in it, how long, and Join while
  it runs.
- **One click on Call** shows the call strip at once, saying it is connecting; a second click starts nothing more.
- **Audio settings.** The microphone's arrow (and a row in ⋯) opens them: choose the microphone and the speakers, see a level meter
  before you unmute, set the microphone volume and what you hear, test the sound, and set each person's own volume or mute them for
  you only. They are remembered on this device.
- **Screen sharing.** When someone shares a screen, the others' stage opens on it once and says who shares and when it stops. A
  screen stopped right after its mode changed no longer stays on the others' screens.
- The first call invitation offers once to turn notifications on.

## AI, agents and search

- **Every agent runs in the agent runtime.** `./flux up` turns it on where the host can run it, so AI works right after install: add a
  key in Settings › AI. A plan runs in its vendor's own program (Claude Code, Codex); **every API key runs in pi** (Anthropic, OpenAI,
  OpenRouter, Gemini, your own endpoint), with the same Flux tools. Each run has its own shell and files in a sandbox that lasts one run.
  A key never enters the sandbox: Flux's model gateway holds it and counts every request against the key's daily budget. The worker no
  longer has an agent loop of its own.
- **Only models that call tools are agents.** When you add a key or choose a model, Flux sends one small check, a `ping` tool the model
  must call. A model that does not is refused with "This model can't use tools. Choose another." and the key stays for another model.
- **Prices update themselves.** Flux reads model prices every day (Anthropic, OpenAI and Gemini from LiteLLM's public price list,
  OpenRouter from OpenRouter), and the release carries the list of its build day for a server without internet. Connect AI asks for a
  price only when no list has one.
- **Answers appear as they are written**, only to the person who asked, with **Stop**, then **Copy** and **Try again**. Agents on an API
  key and your own Claude Code stream their words; Codex shows each message as it finishes.
- **Web search comes from the provider.** An agent on an Anthropic or OpenAI key searches the web with that provider's own search,
  inside the key's daily budget, and lists what it searched; Claude Code and Codex use their own. Gemini and OpenRouter keys have no web
  search yet (planned for v0.2.2), and an endpoint of your own has none. Every agent can still open a public web page.
  `FLUX_WEB_READS=off` turns web search and reading off.
- **Agents work with files.** In its sandbox an agent can convert, make a CSV or run a script, and attach what it made to its answer.
  Files, photos and videos can be sent in the chat with your agent: it looks at the photos and reads the files.
- **Ask me first is the one switch** of an agent: your OK for changes in Flux (deleting and other people's things always wait). "Only
  read" is gone; an agent that had it is set to Ask me first.
- **Agents find what lies outside the conversation.** `flux_search` ranks messages, Wiki pages, tasks, decisions and maps in every
  space the agent's owner may read, and `flux_read_around` reads the messages around a hit. Server agents, your own Claude Code and
  Codex get the same two tools. What may be found is checked on every call. For how, what and why, an agent looks in the Wiki first,
  and every answer links the pages, tasks, decisions and messages it used.
- **Search finds what is inside files.** The text of a PDF, a Word document (DOCX), Markdown, plain text, CSV and TSV is read once when
  the file is sent, in a sandbox with no network, and found like a message by whoever may read the space; agents find it too and read an
  excerpt. No OCR, and nothing in an encrypted space.
- **Search ranks by BM25** in Flux's database: any of your words, Polish and English forms alike, accents ignored, best match first,
  and always only among what you may read. A word that occurs more often in a message ranks it higher.
- **Optional local embeddings** for a larger server: `FLUX_EMBEDDINGS=on` (or the release's `compose.embeddings.yaml`) adds one
  container that lets search also rank by meaning, so an English question finds a Polish message. It needs about 3.2 GiB of RAM more,
  downloads a 2.3 GB model on its first start, and embeds about 10,000 messages in 17 minutes of two cores. Off by default; encrypted
  spaces and spaces with AI off are never embedded.
- **An agent can summarise** a conversation, a thread, a task's discussion, a space or a direct message since a date; nothing is stored.
- **Models come from where you sign in.** An API key's models are read from its provider with the key (a dropdown by family), and a
  Claude or ChatGPT plan's models are the ones its signed-in Claude Code or Codex lists. An agent on a model that is retired or no longer
  offered says so and pauses until you choose another.
- **Agents use your AI.** With one AI connection, agents simply use it, and replacing the key breaks nothing. A choice of connection per
  agent appears only when you have several. An agent with no usable connection says "Needs a connection".
- **Connect AI is short.** Provider and Key come first and the model is preselected; Budget and Name are under More. It shows a price
  only when none is known, in plain words, and needs no scrolling at 1440 × 900.
- **Pictures.** An agent can look at a picture someone posted when its model sees pictures, and can attach a picture from the web to
  its `/ai` answer, with Undo.
- **Cleaner answers.** A web answer lists its sources once, without invented citation marks. An answer shown to everyone reads as the
  agent's message ("Hubert's Assistant") for every reader. An agent's answer in a task's discussion is an ordinary message.
- The assistant's suggestions are in the `/` menu under `/ai`, each place showing its own.
- **Settings › AI** is one column: your own Claude Code or Codex is one row with plain steps to connect it, and your agents are
  listed as drawn.

## Messages and spaces

- **Formatting.** Messages, replies, direct messages and agents' answers draw **bold**, *italic*, `inline code`, code blocks (with
  Copy) and lists. Ctrl/⌘ B and I work in the composer.
- **Every conversation opens where you left off**, with a quiet **New** divider above the first new message and **↓ N new** while you
  read above the end.
- **Read receipts** are small faces under your own messages (at most three and +N), with names and times on hover or tap.
- **Mute and follow.** Mute a space or a conversation from its menu (what needs you still arrives), and follow or unfollow a thread.
- **Your own order of spaces**, the same on every device: drag a space (long press on touch) or use ⋯ › Move up and Move down. Unread
  spaces are bold, and **Mark all as read** has Undo.
- **Encrypted spaces.** A new encrypted space is created only after its recovery code is downloaded. A locked one keeps its header
  and shows one card that says it waits for an admin.
- **Space icons and profile photos.** A space's admins can give it an emoji or a picture; a person can set a photo that replaces their
  initials.
- **Last active.** People lists say quietly when each person was last active. "Show when I was last active" in Settings › Account
  turns it off and erases the time.
- **Date and time fields are Flux's own** (a task's due date, a schedule's time, quiet hours): type "14 Nov" or "9 pm", or pick from a
  month or a list of half hours, as a sheet on the phone.
- **Pasting** a screenshot, a copied picture or copied files into the composer attaches them.
- The Wiki: a reload right after "Saved" no longer offers a private copy, and a page deleted while you have it open offers the text you
  typed there also with live editing off.
- **First steps.** Every new person but a guest gets a First steps card on Home (an owner or admin: name the company, invite people,
  connect AI; a member: write a first message, add a photo, turn notifications on), and one invite form invites to a space too.
- **Home, Map and Tasks, calmer.** Home shows each item once. A space with no map opens the map's own empty canvas, and the first thought
  makes the map. "Search tasks" filters the List, a new task is always To do, and Settings › Company's spaces have no second Delete.
- **Material is a Wiki page.** A saved source shows in Search as a Wiki page; the word "Material" is gone from the screens.
- **Settings keep only what the system does not decide.** Appearance has Theme and the face switch; text size and reduced motion follow
  your system. Search's Recent lists a space once.
- Buttons, switches and segmented controls look the same on every screen and are clearly visible in light and dark.

## Files, previews and video

- **Files open in a preview** from their row: plain text, logs and source code, JSON (folded, with where invalid JSON breaks), CSV and
  TSV as a table, PDF (drawn by Flux), Markdown (drawn like a message, with View source) and HTML (sandboxed: no scripts and nothing
  fetched unless you choose **Run scripts** for that one preview). A 5 MiB file opens without holding the page.
- **Videos play inside Flux.** MP4, WebM and MOV files that your browser can play show their poster in the message and play in the
  dark viewer, full screen on the phone, and seek without loading in full. A video can be up to 200 MiB (`FLUX_VIDEO_MAX_MIB`); other
  files stay at 5 MiB. In an encrypted space a video is an ordinary 5 MiB file that downloads.
- **Files, photos and videos go in direct messages** and in the chat with your agent, with the same limits, checks and previews as in a
  space.

## Phone and tablet

- A space's header on the phone is **Back**, the name and **More**; Search and Call are the first rows of More. The views
  (Conversation, Tasks, Map, Wiki) are underline tabs on every device.
- After the first direct message, Home offers once to turn notifications on; an iPhone in Safari is shown the Add to Home Screen steps
  first.
- A switch that is on keeps its shape on touch screens.

## Notifications

- **A calm card while Flux is open.** A direct message, a mention, a question, a task, a decision or a call shows one card (bottom
  right; at the top on a phone) with Open, Reply or Join. A burst from one place is one card, and it follows your level and quiet hours.
- **The tab shows (N)**, with a dot on its icon and the installed app's badge.
- **One Sounds switch** in Settings › Notifications (on by default) for the call chime and the message tone, played with the notice, so
  it follows your level and quiet hours. **Hide previews** (off by default) sends a push with only who and where.

## Accounts and passwords

- **Accounts come only from a link.** The first `./flux up` prints a setup link, and only it makes the first account, the company's
  owner; a new Flux opens on **Set up Flux**. Everyone else creates their account from an invite link (which always allows that,
  with the address filled in when the link is for one) or signs in with single sign-on. Nobody can create an account on their own,
  so a server reachable from the internet can no longer be claimed or filled with accounts by strangers.
- **A forgotten password is a reset link**, with or without email: an owner or admin makes one next to the person in
  **Settings › Company**, `./flux reset-link <email>` prints one for any account (the owner's too), and **Forgot password** mails
  one when the server has email. A link works once, for one hour, and a newer link stops it; using it signs the person out everywhere.

## Security

An agent that did not write the code reviewed this release's new surface (agent pictures and search, file previews, uploads, calls,
notifications, sessions, releases), and the [threat model](https://github.com/ColdPhase/flux/blob/main/docs/security/threat-model.md)
covers it. It is not a human audit.

- **Pictures are decoded and written again by the server** before they are stored, whoever sent them. A file that decoders would read
  as different pictures is refused: a 52-byte WebP could crash the tab of everyone who opened its conversation. A picture is at most
  8,000 pixels on a side and 40 million pixels.
- **Previews cannot reach out.** An HTML file's nested documents are sent inert (no connection to a host it names), and a link inside a
  PDF preview can no longer replace the Flux tab: it shows its address and opens a new tab only when you press Open link.
- **Names refuse direction controls** and invisible characters, so a name can no longer reorder the text beside it.
- **Agents run in a sandbox, away from your keys.** Each run has its own scratch, its shell is started by a broker and can neither listen
  nor connect over TCP, and a run reaches its model only through Flux's gateway with a token that lasts the run. The key stays sealed in Flux.
- **Bounded model lists.** A provider's model list is read up to 1 MB (OpenRouter's up to 2 MB), one at a time per person.
- **Push subscriptions.** A push endpoint held by another account moves to a new one only with the same browser keys.
- **Call notices are not repeated.** A call that the same person starts again in the same place, or an invitation sent again to the
  same person, within 5 minutes makes no new Inbox item, push or sound.

## Performance

- **Two people at once on a 2 vCPU server.** The API needs about half the CPU it did: a signed-in request reads its session in one
  statement (a sign-out or a revoked session is still refused on the very next request), access checks run prepared statements, and
  answers are compressed more lightly. With the API and the database each held to one CPU and two clients sending requests without
  pause, the p95 of all requests went from about 45 ms to 22–26 ms, measured on a host that was not quiet.
- **A space and its Conversation open in one read each:** at most 8 requests on every move (v0.2.0: about 14).
- **The first screen downloads 239 KB**, under its 250 KB budget (v0.2.0: 242 KB), and a test keeps it there. The Create window, the
  notice card and the date and time fields load with the code that needs them.
- A change whose save takes more than 2 s on a slow database is no longer answered as failed (500) after it was stored.

## Install

```sh
curl -fLO https://github.com/ColdPhase/flux/releases/download/v0.2.1/flux.tar.gz
curl -fLO https://github.com/ColdPhase/flux/releases/download/v0.2.1/SHA256SUMS
curl -fLO https://github.com/ColdPhase/flux/releases/download/v0.2.1/SHA256SUMS.sigstore.json
sha256sum --ignore-missing -c SHA256SUMS
tar -xzf flux.tar.gz && cd flux && ./flux up
```

`./flux up` prints the setup link that makes the first account, the company's owner. The
[installation guide](https://coldphase.github.io/flux/operate/install/) shows how to check the signature of `SHA256SUMS` before you
unpack, and takes a server to its domain. Built-in HTTPS, calls (`FLUX_CALLS=on`), local embeddings (`FLUX_EMBEDDINGS=on`) and the agent
runtime are switches in `docker/.env`; `./flux up` applies them. `./flux demo` adds sample data on your own computer.

## Platforms

- **Published images: `linux/amd64` (x86_64) only**: `ghcr.io/coldphase/flux`, `ghcr.io/coldphase/flux-agent-runtime` and, new,
  `ghcr.io/coldphase/flux-database`. `linux/arm64` is planned for v0.3 ([#833](https://github.com/ColdPhase/flux/issues/833)). A Flux
  developer's source checkout builds on arm64.
- **Browsers.** Phones and tablets are tested in Chromium and WebKit emulation in Docker, not on physical devices. Web Push on iPhone and
  iPad works only from the Home Screen app, on iOS or iPadOS 16.4 or later.
- Docker Engine 25 or newer with the Compose plugin; Docker Compose is the only supported install.
- **For AI: Linux 6.7 or later with `kernel.yama.ptrace_scope` of 1 or higher** (Ubuntu 24.04, Debian 13). Without it Flux runs and AI is off
  ([read this first](#read-this-first-install-and-upgrade)).

## Known issues

- **Havana's time is an hour off in two places** ([#1338](https://github.com/ColdPhase/flux/issues/1338)). Quiet hours and the day of
  "last active" are an hour off for people in `America/Havana`, because Node.js still has time-zone data 2026e and Cuba's winter time is in
  2026f (checked 2026-11-14: Node 24.22.3 and 26.13.1). PostgreSQL has 2026f. Other time zones are unaffected.
- **A page's live connection was refused once in WebKit** ([#1313](https://github.com/ColdPhase/flux/issues/1313)). It was seen once in an
  automated test and not since, and the cause is not known. If a page stops updating, reload it.
- **The concurrent speed was measured on a busy host.** The 22–26 ms above come from alternating runs on a host where other test suites
  ran; the measurement on a quiet host is part of the release acceptance.
- **Calls and screen sharing** need public media ports and a public IPv4 address (`FLUX_CALLS=on` finds the address). Phone browsers
  cannot share their screen.
- **Encrypted spaces protect a copy of the data or a server taken away switched off**, not a running, unlocked server; Flux is not
  end-to-end encrypted. Videos in an encrypted space download instead of playing.
- **AI was measured on one real key, not on live plans.** Agents on an Anthropic key answered 62 workspace questions end to end on Claude
  Haiku 5.5, 0.944 of them right, at about $0.003 a question
  ([results](https://github.com/ColdPhase/flux/blob/main/docs/product/research/evidence/1295/README.md)). Claude Code and Codex were tested
  as the real programs against a local model, and other providers' keys with mock providers in Docker; live Claude and ChatGPT plans were not
  tested as part of the release check.
- **Images for `linux/amd64` only** (above).

## Check your download

`SHA256SUMS` lists every other file of the release. `release.json` names the source commit and the exact images
(`ghcr.io/coldphase/flux@sha256:…`, `ghcr.io/coldphase/flux-agent-runtime@sha256:…` and `ghcr.io/coldphase/flux-database@sha256:…`).
`SHA256SUMS.sigstore.json` is the release workflow's keyless signature of `SHA256SUMS`; check it, the images' signatures (`cosign verify`)
and the build provenance (`gh attestation verify`) as [signatures](https://coldphase.github.io/flux/operate/upgrade/#signatures) shows.

## Full list of changes

The [changelog](https://github.com/ColdPhase/flux/blob/main/CHANGELOG.md) lists everything in this release.
