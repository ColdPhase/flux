# Flux v0.2.2

Flux v0.2.2 fixes what the first real installs found, on a phone and on a server. A new message at **Everything** notifies you, Home lists
the conversations with something new, and a receipt under a message no longer vanishes when you send another. Agents see the pages of a
scanned PDF and say honestly when a tool failed. The launcher works with a quoted `docker/.env`, with split-horizon DNS for calls and on a
kernel that has Landlock built in but not active; the database no longer resets when a health check times out; the media server has memory
and CPU limits; and the keyring locks itself when its swap limit is reset under it. The phone gets its own Back, a Tasks Board with one status
at a time and a map that looks like the computer's; larger files, an optional OCR switch and `./flux upgrade --check` are in too.
<!-- pending #1573 #1577 #1544 #1569 #1575 #1578: the phone, map, larger files, OCR and --check sentence of this paragraph -->

Documentation: <https://coldphase.github.io/flux/>. Flux is open source under the AGPL-3.0.

## Upgrading from v0.2.1

A folder installed from v0.2.1 upgrades to v0.2.2 with `./flux upgrade` ([upgrade](https://coldphase.github.io/flux/operate/upgrade/)). It
checks the download against `SHA256SUMS` and its signature first and refuses, changing nothing, when it cannot; takes a backup; stops API
and worker; migrates; and starts them again. Your data, files, settings, agents, encrypted spaces and sessions stay. The "Upgrades from"
line of the release page names the versions this release was tested to upgrade. **From v0.2.0 the answer has not changed: install fresh**
([installation](https://coldphase.github.io/flux/operate/install/)).

```sh
cd /srv/flux
./flux upgrade --check     # the plan: schema A to B, the migrations by name, what each removes, the backup's size. Changes nothing.
./flux upgrade             # the upgrade itself (./flux upgrade v0.2.2 names the version)
```
<!-- pending #1578: the --check line of the block above -->

- **`./flux upgrade --check` is new** ([#1552](https://github.com/ColdPhase/flux/issues/1552)). It downloads and checks the release as the
  upgrade does, reads its migrations from its signed image and prints the schema change, each migration (and the `DROP` statements in it),
  the size of the backup and a rough time; Flux keeps running. It also takes a version or `--file flux.tar.gz`. The real upgrade prints each
  migration as it is applied. <!-- pending #1578 -->
- **Every service now runs under an init process.** `./flux upgrade` recreates `db`, `api` and `worker` once on it (one clean PostgreSQL restart), the keyring as at every upgrade (so every encrypted space is locked
  until an admin of the space unlocks it) and, with calls on, `livekit`, whose new limits apply on that recreate.
- **The database image moves to PostgreSQL 18.7** (security release of 2026-11-12), the same major as 18.6: your data directory starts on it
  as it is, with no dump and restore; the pins of `pgvector` and `pg_search` are unchanged. `./flux upgrade` pulls it before the downtime.
  <!-- pending #1572 -->
- **No setting is renamed or removed** (`docker/env-changes.txt` is unchanged), so your `docker/.env` keeps working as it is. `docker/.env`
  values in single or double quotes (`FLUX_PROJECT='flux'`) are now read as Compose reads them; before, such a line stopped every `./flux`
  command ([#1541](https://github.com/ColdPhase/flux/issues/1541)).

### New settings and their defaults

All are optional; an old `docker/.env` that sets none of them behaves as before.

| Setting | Default | What it does |
| --- | --- | --- |
| `FLUX_CALLS_PUBLIC_IP` | empty | **Split-horizon DNS, or a proxy on another machine** ([#1542](https://github.com/ColdPhase/flux/issues/1542)). With `FLUX_CALLS=on`, `./flux up` looked the origin's name up on the server and advertised what it found, which is the proxy's LAN address when internal DNS answers differently than the browsers' DNS. Set the public IPv4 address browsers send media to: it is kept, checked only for being IPv4, never looked up (the origin needs no A record on the server), and printed. Empty: the lookup runs as before. `FLUX_LIVEKIT_DOMAIN` set in `docker/.env` is now the media name instead of being overwritten with the origin's host. [Calls](https://github.com/ColdPhase/flux/blob/main/docs/operations/calls.md#split-horizon-dns-or-a-proxy-on-another-machine). |
| `FLUX_LIVEKIT_MEMORY` | `512m` | Memory **and swap** of the media server, so a call cannot take memory from the database and the keyring ([#1558](https://github.com/ColdPhase/flux/issues/1558)). A synthetic 16-person call (4 publishing video, 12 receiving, 60 s) measured 75 to 86 MB. |
| `FLUX_LIVEKIT_CPUS` | `1` | CPU limit of the media server (3 to 9 % of one core in that call). Docker refuses a limit above the server's cores, so one CPU also starts on a 1-core server. |
| `FLUX_FILE_MAX_MIB` | `25` (1 to 1,024) | The largest file of a plain space, a direct message or an agent's chat; a message's files together may be four times it ([#1549](https://github.com/ColdPhase/flux/issues/1549)). A picture and every file of an encrypted space stay at 5 MiB. Before, every file but a video was at most 5 MiB. <!-- pending #1569 --> |
| `FLUX_FILE_OCR` | `off` | `on` reads the text in scans and pictures (Polish and English) so search and agents find it ([#1575](https://github.com/ColdPhase/flux/issues/1575)). The image grows by about 8.6 MB. Off, nothing changes. <!-- pending #1575 --> |

Also new, nothing to set: the media server runs with no capabilities, no new privileges, a read-only root and at most 512 processes.

### Checks that run at `./flux up`

- **Landlock must be active, not only built in** ([#1543](https://github.com/ColdPhase/flux/issues/1543)). Flux AI's runtime needs Linux 6.7
  or later **and** `landlock` in the engine's active security modules (`/sys/kernel/security/lsm`). Proxmox VE 9 (kernel `7.0.14-pve`, also
  an LXC guest running Docker, which shares the host's kernel) has the kernel and not the module, so v0.2.1 passed its host check and then
  failed at the runtime's own start. The first `./flux up` now reads the list in one more throwaway container and, when Landlock is missing,
  keeps AI off with one line:

  ```text
  Landlock is not active in the engine's kernel (active: ...). Add landlock first to its lsm= boot parameter, keeping the others, e.g. lsm=landlock,lockdown,yama,integrity,apparmor, then reboot.
  ```

  The fix is on the machine that runs the Docker engine (for an LXC guest, the host): `landlock` first in the kernel's `lsm=` boot
  parameter, a reboot, then `./flux ai on` ([agent runtime](https://coldphase.github.io/flux/operate/agent-runtime/#landlock-must-be-active)).
  When the engine does not show the list, the line says Landlock could not be checked and AI stays off. A host with Landlock active
  (Ubuntu 24.04, Debian 13, Fedora 40+, RHEL 10) is unaffected.
- **The keyring's swap check now repeats** ([#1559](https://github.com/ColdPhase/flux/issues/1559)). It matters on a host **with a disk swap
  device** (Proxmox VE, an LXC guest, many VPSs) and encrypted spaces; a host with no swap or only `zram` is unaffected. A running
  container's swap limit does not stay: `systemctl daemon-reload`, which package upgrades and most configuration tools run, sets
  `memory.swap.max` of every container back to `max`. The keyring used to check only at start; it now checks every minute and before every
  request (`api` and `worker` every 5 seconds). When swap has become possible it wipes its boot key, logs one line, answers 503 and turns
  its health check red; **every encrypted space is locked** with the reason, and `./flux up` prints the line. What to do:
  - **Restart Flux after a `systemctl daemon-reload`**: `./flux down`, then `./flux up` (Docker sets every container's swap limit again;
    restarting only the keyring is not enough), and the admins unlock their spaces again. Plan package upgrades like a host reboot.
  - Or **have no swap** on the host (or only `zram`).
  - Or, only when every swap device is encrypted with a key that is not stored on the disk, `FLUX_SWAP_ACKNOWLEDGED=encrypted-swap`
    (unchanged from v0.2.1; Flux cannot detect this, so set it only when it is true).
  Plain spaces are never affected ([encrypted spaces](https://coldphase.github.io/flux/operate/encrypted-spaces/#swap-and-memory)).
- **Your reverse proxy** needs nothing new unless you raise `FLUX_FILE_MAX_MIB` above `FLUX_VIDEO_MAX_MIB`: its body limit must be at
  least the larger of the two (nginx: `client_max_body_size`; 210m already fits the defaults) ([reverse proxy](https://coldphase.github.io/flux/operate/reverse-proxy/)).
  <!-- pending #1569 -->

### What changes for existing data

v0.2.1 is at schema 95. The migrations below are every one of v0.2.2 (`0096`–`0099` and `0102` are not used: the work planned for
`0096`–`0099` was renumbered to `0105`–`0108`). Each runs in its own transaction while API and worker are stopped, after the backup; none
deletes a v0.2.1 row of yours, and `tests/app/released-databases.test.ts` runs the real migrator on a dump of the v0.2.1 database.

| Migration | What it does to existing rows |
| --- | --- |
| `0100_new_message_notices` ([#1550](https://github.com/ColdPhase/flux/issues/1550)) | Replaces the check on `notifications.reason` to allow the new `message` reason (the table is read once), and adds " wrote in " to the title rule of encrypted spaces' content-free notices (applies to rows written from now on). No row is converted: old notifications keep their reasons, and no `message` row exists until the first new message at Everything after the upgrade. |
| `0101_run_gateway_unreachable` ([#1556](https://github.com/ColdPhase/flux/issues/1556)) | Widens the allowed end reasons of agent runs by `gateway_unreachable`. Every existing run keeps its value. |
| `0103_pdf_page_pictures` ([#1557](https://github.com/ColdPhase/flux/issues/1557)) | Adds `project_files.no_text` (`false` for every existing file) and the table `file_page_pictures` (empty). **Queues once more every PDF of a plain space or an agent's chat that was read and found to have no text** (a scan, an exported map): once the worker is up it reads them again in the background, one file at a time, and each gets its page pictures and its "no text" mark. How long that takes depends on how many such files you have; nothing else waits for it, and until a file is read it is found by its name only. Nothing else is read again, and no file or row is changed or deleted. |
| `0104_file_ocr` ([#1575](https://github.com/ColdPhase/flux/issues/1575)) | Adds `project_files.ocr_state` (empty for every file), a small function that names the picture file types, and an index of files OCR has yet to read; replaces the two triggers that queue a new file's text job so that a picture wakes the worker. **Nothing is read while `FLUX_FILE_OCR=off`.** Turned on, the worker reads the pictures and the PDFs without text that were sent before, 50 at a time, newest first, so a large install is not flooded; encrypted spaces' files are never read. <!-- pending #1575 --> |
| `0105_file_size_setting` ([#1549](https://github.com/ColdPhase/flux/issues/1549)) | Replaces the two size checks of `project_files` with ones that allow up to 1 GiB for every file (the setting's top; the application holds the operator's cap). The checks only widen: every existing file (up to 5 MiB, a video up to 1 GiB, a reservation) satisfies them, so no row is converted. Adding a check reads `project_files` once under its lock. <!-- pending #1569 --> |
| `0106_remove_unused_schema` ([#1552](https://github.com/ColdPhase/flux/issues/1552)) | Drops the sequence `agent_thread_guard_sequence` (left behind by `0040`; it holds no data), deletes search rows of the kinds `result` and `draft` (nothing has written them since `0028` and `0044`, so none should exist) and replaces the check on the search kinds. Every other row is unchanged. <!-- pending #1578 --> |
| `0107`, `0108` ([#1508](https://github.com/ColdPhase/flux/issues/1508)) | Reserved for the data rule of stored "Material" rows (convert to Wiki pages, or keep as a kind). No file yet. <!-- pending #1508 --> |

Everything else of this release changes no stored data: the new Home list, Seen by and the notices are computed from what v0.2.1 stored; a
map's remembered view is a per-device browser-storage convenience (a map with none opens framed by Fit, as the first time). <!-- pending #1577 -->

**A downgrade is not supported.** Migrations are forward-only. The way back is the backup `./flux upgrade` took first, in `backups/`, with
the release files you ran before (`flux-files-v0.2.1-<time>.tar.gz`): if the upgrade fails it stops API and worker and prints the two
commands that restore them ([when it fails](https://coldphase.github.io/flux/operate/upgrade/#when-it-fails)).

## Phone and tablet

- **Back closes what sits on top first.** A message's actions sheet, the Create sheet, a menu, a picker or a panel closes with Back (the
  arrow or the phone's gesture), and only the next Back leaves the place; before, Back with the actions sheet open left the conversation
  ([#1545](https://github.com/ColdPhase/flux/issues/1545)). <!-- pending #1545 -->
- **The views of a space are one place.** Switching between Conversation, Tasks, Map and Wiki replaces the history entry instead of adding
  one, so Back leaves the space and returns to where you came from (Spaces, Home, Inbox) instead of walking back through its tabs
  ([#1547](https://github.com/ColdPhase/flux/issues/1547)). <!-- pending #1547 -->
- **The keyboard comes only when you tap a field.** Choosing a tab of the Create sheet, opening an agent's chat and the like no longer put
  the cursor in a field and open the on-screen keyboard on a touch screen ([#1546](https://github.com/ColdPhase/flux/issues/1546)).
  <!-- pending #1546 -->
- **No white strip under the app in dark mode.** The area under the app, around the system's home indicator, is the page's dark background
  (the dark theme links a dark manifest, so the installed app's navigation bar is dark too) ([#1544](https://github.com/ColdPhase/flux/issues/1544)).
  <!-- pending #1544 -->
- **Tasks › Board shows one status at a time** on a phone: a row of the four statuses with their counts under the controls, a tap or a
  swipe moves to the next, and nothing scrolls sideways; the computer and the tablet keep four columns. An empty space shows the List's
  "No tasks yet" on the Board too ([#1560](https://github.com/ColdPhase/flux/issues/1560)). <!-- pending #1573 -->
- **Segmented controls keep their size.** Board / List, Map / List, the Create window's kinds, Model and the live stage have equal options,
  so the selected pill no longer changes size when you choose; on a narrow phone the Create window's Close moves to the line below its
  tabs instead of squeezing them ([#1561](https://github.com/ColdPhase/flux/issues/1561)). <!-- pending #1573 -->
- **Phone polish from an audit** ([#1568](https://github.com/ColdPhase/flux/issues/1568)): a thread opened from an Inbox item starts at the
  message the item is about, Quiet hours › Change and Muted › Change open in view, "Add to a thought" has no empty first row and no Escape
  hint on touch, the "Task created" notice stands above an open sheet, and Settings › Appearance has a page title like the others; and
  Connect AI from Home returns to Home on Cancel and no longer reopens on a reload ([#1567](https://github.com/ColdPhase/flux/issues/1567)).
  <!-- pending #1568 -->
- **A message link no longer jumps in Safari.** A conversation opened at a message, or reached with Back, keeps where you were instead of
  starting lower and snapping back when Tab reveals a control (WebKit scrolled to the address's fragment again after a late stylesheet)
  ([#1530](https://github.com/ColdPhase/flux/issues/1530)). <!-- pending #1530 -->

## Notifications

- **At Everything, a new message in a space notifies you** ([#1550](https://github.com/ColdPhase/flux/issues/1550), C-65). In v0.2.1 a
  message that did not name you notified nobody at Everything. Now a new message of a space you are in sends a push and the open tab's
  notice ("3 new messages in Tool library", grouped like replies), except your own. It is never an Inbox item, never an email, quiet in a
  muted space and in quiet hours, and content-free under **Hide previews** and in an encrypted space ("Ada wrote in <company>"). A message
  that names you or asks you keeps its own notice (one notification per message and person), and at **Only what needs me** and **Nothing**
  nothing is made. A reply and a decision's or a task's discussion are not "new messages in the space".
- **Home lists the conversations with something new** ([#1548](https://github.com/ColdPhase/flux/issues/1548)). A "New messages" part under
  Waiting for you (on the phone under My tasks and My map) lists the spaces and direct messages with something unread, newest first, muted
  ones left out, five and then "Show all", live as you read; nothing is shown when nothing is new. The Inbox is unchanged.
- **Seen by stays.** A reader's face stands under the newest message of yours they have read, also in the middle of a group, and moves down
  as they read on; sending another message no longer hides that the person read the earlier one
  ([#1551](https://github.com/ColdPhase/flux/issues/1551)).

## Map

- **A map looks the same on the phone as on the computer** ([#1553](https://github.com/ColdPhase/flux/issues/1553), C-67). The phone shows
  the computer's plane, each thought where it was arranged, instead of its own column layout. One finger pans, two pinch to zoom, a double
  tap on empty space zooms in, a tap selects, and a thought moves on touch only after a 400 ms press. The view (zoom, place, selection) is
  remembered for each person and map on the device, and Fit frames a map only the first time or when you press it. A link to a thought
  centres that thought. The thought card's "From Ada (you) · 10:48" shortens only the name, so "(you)" and the time stay whole at 360 px.
  <!-- pending #1577 -->
- **A new thought from a connection dot always takes typing.** The dashed frame sometimes appeared and took no typing until the dot was
  clicked again ([#1554](https://github.com/ColdPhase/flux/issues/1554)). <!-- pending #1577 -->
- **An agent can add thoughts to a map someone has open** ([#1555](https://github.com/ColdPhase/flux/issues/1555)). Such a map has a live
  room, and every change an agent made there failed; it now works (see [AI agents](#ai-agents)).
- **Make a task** from a selected thought (the floating bar, the List's ⋯ menu and the phone's thought sheet) opens Create on Task with the
  thought's first line as the title; in a space's map the thought is linked as the task's source ([#1519](https://github.com/ColdPhase/flux/issues/1519)).
  <!-- pending #1576 -->

## Tasks

- **Create takes a due day.** The Task tab has Owner, **Due** and Link; Due opens the same calendar as the task panel's
  ([#1519](https://github.com/ColdPhase/flux/issues/1519)). <!-- pending #1576 -->
- **My tasks shows due days and the tasks you gave others.** Every row shows its due day on its quiet line ("Kai Berg · Due 1 May 2031"),
  and a second section, **Tasks you gave others**, lists your unfinished tasks owned by someone else, in the spaces you can read
  ([#1519](https://github.com/ColdPhase/flux/issues/1519)). <!-- pending #1576 -->
- The phone's Board and the equal segmented controls are under [Phone and tablet](#phone-and-tablet).

## Files, PDFs and OCR

- **An agent sees the pages of a scanned or picture-only PDF** ([#1557](https://github.com/ColdPhase/flux/issues/1557), C-69). Exported
  mind maps, slides saved as pictures, screenshots saved as PDF and phone scans have no text layer, so v0.2.1 found them by name only. When
  the worker's sandboxed reader (same limits, no network) finds no text, it keeps a picture of each of the first 10 pages (at most 1,568
  px on the long side, 3.6 MB a picture, 20 MiB a file), and `flux_read_file` gives them to an agent whose model sees pictures. An agent whose
  model does not is told the PDF has no text and cannot be read, so it neither guesses nor says Flux failed. A page drawn as vector shapes
  has no picture, because Flux does not render pages on the server.
- **The file says it has no text.** Its row reads "PDF · 1 page · no text · 2.1 MB" and its preview's caption "No text in this PDF (scan
  or picture)". Your PDFs of v0.2.1 that were read and had no text are read again after the upgrade (migration `0103`, above).
- **Optional OCR finds text in scans and pictures** ([#1575](https://github.com/ColdPhase/flux/issues/1575), C-70). With
  `FLUX_FILE_OCR=on`, the same sandboxed reader runs Tesseract (Polish and English, shipped in the image) on a scan's pages and on the
  PNG, JPEG, WebP and GIF pictures sent to a space or an agent's chat, one picture at a time in a child of its own at low priority (about
  4 s of one CPU and 200 MiB for a dense A4 page, measured 2026-11-20). The text is kept only when OCR is confident (mean confidence of at
  least 60 and three words of three letters or more), so a photo of a plant keeps nothing; it is then the file's text everywhere, found
  by search and read by agents like a PDF's own text, with a note that OCR may contain mistakes. Never an encrypted space's files or
  direct messages' files. Off by default. <!-- pending #1575 -->
- **PDFs and other documents larger than 5 MB can be sent**, up to the operator's `FLUX_FILE_MAX_MIB` (25 MiB by default, up to 1 GiB), and
  a message's files together up to four times that. A larger file is streamed to and from the disk like a video, so the server's memory
  does not grow with it: a 40 MiB PDF uploaded with the API process at 326 to 338 MiB, and a 60 MiB one against a 50 MiB limit answered
  "Files can be up to 50 MB on this server". A text or HTML preview is for files up to 5 MiB (a larger one downloads); a PDF opens in
  Flux's viewer at any size; the text for search is read from files up to 64 MiB. A picture and every file of an encrypted space stay at
  5 MiB, and the composer says so in words ([#1549](https://github.com/ColdPhase/flux/issues/1549)). <!-- pending #1569 -->

## AI agents

- **An agent says when a tool failed.** An unexpected error was told to the model as "Tool unavailable" and logged nowhere, so an agent
  could not say what had happened. It now says that Flux failed to do this, gives the person an **error id**, and does not guess; whoever
  runs Flux finds the id in the API log, which also has one line per tool call (tool, outcome, time; never its arguments or results)
  ([#1555](https://github.com/ColdPhase/flux/issues/1555)). The cause of the one that started it is fixed too: adding a thought to a map
  someone had open always failed.
- **A run that never reached the model gateway says so.** Instead of "The AI provider didn't answer", the asker reads that Flux couldn't
  reach its model gateway, so the provider wasn't asked, and what to tell whoever runs Flux; a schedule's history says the same. Every
  run that ends without an answer logs its cause (never words or content), and a runtime started with pi checks once that it reaches the
  gateway and logs `gateway_probe` as `ok` or `unreachable` with one sentence ([#1556](https://github.com/ColdPhase/flux/issues/1556)).
- **Times an agent reads are in its owner's zone**, with the offset (`2026-11-19T15:34:00+01:00`), including the days and clock of a
  summary; a model no longer converts from UTC and tells "15:34" for 14:34 ([#1563](https://github.com/ColdPhase/flux/issues/1563)).
  <!-- pending #1579 -->

## Messages, Inbox and spaces

- **A saved source opens inside its space**, with the space's header, its name, Conversation, Tasks, Map and Wiki (Wiki current) and its
  people, instead of a header "Wiki" with no tabs; Back returns to where you came from ([#1563](https://github.com/ColdPhase/flux/issues/1563)).
  <!-- pending #1579 -->
- **An Inbox Reply says what you asked** above the answer, and a discussed decision says "Discussion · N replies"
  ([#1563](https://github.com/ColdPhase/flux/issues/1563)). <!-- pending #1579 -->
- **Spaces rows say what was said last**: each space shows its newest message and when, as a conversation in Messages does ("Maja: Sent a
  file") ([#1563](https://github.com/ColdPhase/flux/issues/1563)). <!-- pending #1579 -->
- **Small fixes**: at 200 % the "Task #12 created" notice takes two lines instead of three; offline, a conversation no longer adds "Linked
  work could not be loaded" to the composer's own offline line; the Spaces page's empty states are the one centred empty state
  ([#1563](https://github.com/ColdPhase/flux/issues/1563)). <!-- pending #1579 -->

## Server and operations

- **The database no longer resets on a timed-out health check** ([#1540](https://github.com/ColdPhase/flux/issues/1540)). A probe that its
  timeout killed was taken by PostgreSQL, as PID 1, for a crashed process of its own, which reset every connection and broke the first
  migration on a busy server. `db`, `api`, `worker`, the HTTPS proxy and the embeddings server now run under an init process, which reaps
  the probe.
- **The media server has limits like every other service**, and the runtime manager and egress get swap limits equal to their memory, so
  no long-running service can swap (`FLUX_LIVEKIT_MEMORY`, `FLUX_LIVEKIT_CPUS`: [above](#new-settings-and-their-defaults)).
- **`./flux` works with quoted values** in `docker/.env` ([#1541](https://github.com/ColdPhase/flux/issues/1541)), **with split-horizon DNS**
  (`FLUX_CALLS_PUBLIC_IP`) and **on a kernel without active Landlock** (a clear line and the fix): [above](#upgrading-from-v021).
- **`./flux upgrade --check`** shows the plan; every pull request that changes the database now proves that every released database
  upgrades to a schema equal to a fresh install's and keeps its data, and that nothing in the schema is unused; the release does the same on
  its real upgrade ([#1552](https://github.com/ColdPhase/flux/issues/1552), C-68). <!-- pending #1578 -->

## Security

- **The keyring locks itself when its swap limit is reset** ([#1559](https://github.com/ColdPhase/flux/issues/1559)): described under
  [checks at `./flux up`](#checks-that-run-at-flux-up). This closes a gap in v0.2.1: its keyring checked only at start, so on a host with
  swap, after a `systemctl daemon-reload`, it kept its boot key and nothing noticed.
- **Picture decoding for scanned PDFs stays in the sandbox.** The pages' pictures are decoded in the same sandboxed child as the text (no
  network, its own limits, 32 MiB of output), and only well-formed PNGs within bounds are kept; the
  [threat model](https://github.com/ColdPhase/flux/blob/main/docs/security/threat-model.md) (B4) says so. OCR, when on, adds one picture at
  a time in a child of its own with 60 s and 384 MiB limits. <!-- pending #1575 -->
- **Dependency and base-image security releases.** The Node base image moves to 24.22.3 (the 2026-11-11 security release: nine High CVEs in
  HTTP/2 and TLS) and the database image to PostgreSQL 18.7 (2026-11-12). `ws` 8.23.0 fixes a remote memory-exhaustion denial of service
  by a Ping flood (in the API and the calibration tool). Better Auth 1.7.26 (the local refresh-token patch ported by hand, the same ten
  hunks), pg-boss 12.38.2, sanitize-html 2.18.2, livekit-client 2.24.1, `@anthropic-ai/sdk` 1.10.0, vite 8.3.8 and the docs site's Astro
  and Starlight move to their current patch and minor versions; no major upgrade, and no open Dependabot security alert at the time of
  writing. <!-- pending #1572 -->

## Install

```sh
curl -fLO https://github.com/ColdPhase/flux/releases/download/v0.2.2/flux.tar.gz
curl -fLO https://github.com/ColdPhase/flux/releases/download/v0.2.2/SHA256SUMS
curl -fLO https://github.com/ColdPhase/flux/releases/download/v0.2.2/SHA256SUMS.sigstore.json
sha256sum --ignore-missing -c SHA256SUMS
tar -xzf flux.tar.gz && cd flux && ./flux up
```

`./flux up` prints the setup link that makes the first account, the company's owner. The
[installation guide](https://coldphase.github.io/flux/operate/install/) shows how to check the signature of `SHA256SUMS` before you
unpack, and takes a server to its domain. Built-in HTTPS, calls (`FLUX_CALLS=on`), local embeddings (`FLUX_EMBEDDINGS=on`) and the agent
runtime are switches in `docker/.env`; `./flux up` applies them. `./flux demo` adds sample data on your own computer. An existing
installation upgrades instead ([above](#upgrading-from-v021)).

## Platforms

- **Published images: `linux/amd64` (x86_64) only**: `ghcr.io/coldphase/flux`, `ghcr.io/coldphase/flux-agent-runtime` and
  `ghcr.io/coldphase/flux-database`. `linux/arm64` is planned for v0.3 ([#833](https://github.com/ColdPhase/flux/issues/833)).
- **Browsers.** Phones and tablets are tested in Chromium and WebKit emulation in Docker, not on physical devices. Web Push on iPhone and
  iPad works only from the Home Screen app, on iOS or iPadOS 16.4 or later.
- Docker Engine 25 or newer with the Compose plugin; Docker Compose is the only supported install.
- **For AI: Linux 6.7 or later with `kernel.yama.ptrace_scope` of 1 or higher and Landlock active** (Ubuntu 24.04, Debian 13; Proxmox VE 9
  needs a boot parameter first). Without it Flux runs and AI is off ([above](#checks-that-run-at-flux-up)).

## Known issues

- **Havana's time is still an hour off in two places** ([#1338](https://github.com/ColdPhase/flux/issues/1338)). Quiet hours and the day of
  "last active" are an hour off for people in `America/Havana`: Node.js has time-zone data 2026e and Cuba's winter time is in 2026f.
  Re-checked 2026-11-20: `node:24-alpine` is 24.22.3 with 2026e, and nodejs.org lists no newer 24.x. PostgreSQL has 2026f. Other time
  zones are unaffected.
- **A page's live connection was refused once in WebKit** ([#1313](https://github.com/ColdPhase/flux/issues/1313)). Seen once in an
  automated test in November and not reproduced since; the cause is not known. If a page stops updating, reload it.
- **A real `systemctl daemon-reload` was not tried on a host with a disk swap device.** The keyring's re-check, lock, 503, red health check
  and restart are tested with a fake cgroup and swap list through the real keyring process, and the reset itself was reproduced on 2026-11-19 on Ubuntu
  24.04 with a test container; the whole path on a Proxmox or LXC host with swap, and Docker's `unhealthy` state of the keyring after about 90 s, were not run.
- **The Landlock check was tested against a stand-in, not a Proxmox host.** It reads `/sys/kernel/security/lsm` from a throwaway
  container (read on a Fedora host with SELinux; the Proxmox case only by the issue's own observation). Rootless Docker and a remote
  engine were not tried.
- **The 16-person call was a synthetic load** from the same host (prepared video, no audio); watch `docker stats` during a real call and
  raise `FLUX_LIVEKIT_MEMORY` or `FLUX_LIVEKIT_CPUS` if it reaches the limits.
- **A scanned PDF's pages are seen only as pictures PDF.js decodes in Node** (JPEG, Flate, raw; JPX and JBIG2 through its own decoders,
  untested), and a page drawn as vector shapes gets none. What a real model says about a page was not run in the release check.
  OCR (off by default) reads Polish and English printed text only; handwriting is not read.
- **Upgrade time was not measured for this release on a large database.** `./flux upgrade --check` prints a rough time for the backup
  <!-- pending #1578 -->; the migrations of this release are short statements, except that `0103` queues files that the worker then reads in the background.
- **Gemini and OpenRouter keys have no web search**, as in v0.2.1; an endpoint of your own has none. Every agent can still open a public web page.
- **Calls and screen sharing** need public media ports and a public IPv4 address; behind split-horizon DNS or a proxy on another machine
  set `FLUX_CALLS_PUBLIC_IP`. Phone browsers cannot share their screen.
- **Encrypted spaces protect a copy of the data or a server taken away switched off**, not a running, unlocked server; Flux is not
  end-to-end encrypted. Videos in an encrypted space download instead of playing.
- **Images for `linux/amd64` only** (above).

## Check your download

`SHA256SUMS` lists every other file of the release. `release.json` names the source commit and the exact images
(`ghcr.io/coldphase/flux@sha256:…`, `ghcr.io/coldphase/flux-agent-runtime@sha256:…` and `ghcr.io/coldphase/flux-database@sha256:…`).
`SHA256SUMS.sigstore.json` is the release workflow's keyless signature of `SHA256SUMS`; check it, the images' signatures (`cosign verify`)
and the build provenance (`gh attestation verify`) as [signatures](https://coldphase.github.io/flux/operate/upgrade/#signatures) shows.

## Full list of changes

The [changelog](https://github.com/ColdPhase/flux/blob/main/CHANGELOG.md) lists everything in this release.
