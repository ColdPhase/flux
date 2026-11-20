# Flux v0.2.2

Flux v0.2.2 fixes what the first real installs found, on a phone and on a server. A new message at **Everything** notifies you, Home lists
the conversations with something new, and a receipt under a message no longer vanishes when you send another. The phone shows a Tasks Board
with one status at a time and a map you arrange by finger on the computer's layout, and PDFs and other documents larger than 5 MB can be sent. Agents see
the pages of a scanned PDF, read the text in scans and pictures when the operator turns OCR on, search the web on a Gemini or an OpenRouter
key, and say honestly when a tool failed. The launcher works with a quoted `docker/.env`, with split-horizon DNS for calls and on a kernel
that has Landlock built in but not active; the database no longer resets when a health check times out; the media server has memory and CPU
limits; and the keyring locks itself when its swap limit is reset under it. The upgrade from v0.2.1 is tested on real data, and from v0.2.2
on `./flux upgrade --check` shows the plan of the next one.

Also in this release: files in a direct message are found by the people in it and read by `/ai` there, anyone in a direct message can turn
AI off in it, your agent can search your direct messages from its private chat, saved sources are Wiki pages, a local llama.cpp model is
chosen by the id it names, and on the phone Back closes what sits on top first, a space's tabs are one place, no keyboard opens of its
own accord, the dark theme has dark edges and the search fields are one flat pill. And a message can be pinned in any conversation, with
one pinned list that everyone in it sees.

Documentation: <https://coldphase.github.io/flux/>. Flux is open source under the AGPL-3.0.

## Upgrading from v0.2.1

A folder installed from v0.2.1 upgrades to v0.2.2 with `./flux upgrade` ([upgrade](https://coldphase.github.io/flux/operate/upgrade/)). It
checks the download against `SHA256SUMS` and its signature first and refuses, changing nothing, when it cannot; takes a backup; stops API
and worker; migrates; and starts them again. Your data, files, settings, agents, encrypted spaces and sessions stay. The "Upgrades from"
line of the release page names the versions this release was tested to upgrade. **From v0.2.0 the answer has not changed: install fresh**
([installation](https://coldphase.github.io/flux/operate/install/)).

```sh
cd /srv/flux
./flux upgrade             # the upgrade itself (./flux upgrade v0.2.2 names the version)
```

- **Look at the plan first, from v0.2.2 on.** `./flux upgrade --check` is new in v0.2.2's launcher
  ([#1552](https://github.com/ColdPhase/flux/issues/1552)), so **a v0.2.1 server cannot use it for this upgrade**: its launcher refuses
  `--check` as an unknown option. On v0.2.1 run `./flux upgrade` itself. It downloads the release, checks it against `SHA256SUMS` and its
  signature and pulls its images while Flux keeps running, then prints one line ("Upgrade <project> (schema 95): back up, move to Flux v0.2.2
  (schema N), migrate and restart? ... [y/N]") and waits. Nothing is backed up or stopped until you answer `y`; Enter or `n` ends with
  "Cancelled; nothing was changed." Once v0.2.2 runs, `./flux upgrade --check` is there for every later upgrade: it downloads and checks
  the release as the upgrade does, reads its migrations from its signed image and prints the schema change, each migration (and the `DROP`
  statements in it), the size of the backup and a rough time, with Flux running. It also takes a version or `--file flux.tar.gz`. The real
  upgrade prints each migration as it is applied.
- **How long it takes.** On a copy of a real v0.2.1 installation, a small one, the upgrade took about 40 s. That is a measurement of one
  small install, not a promise: the backup dumps and compresses the database and the files, so time grows with their size (`--check` from
  v0.2.2 on estimates it at about 20 MB/s), and the PDFs that `0103` and the files that `0109` queue are read in the background after the
  upgrade, not during it. The migrations themselves took 15 s on a synthetic dataset of 400,000 messages, 70,000 files and a million events
  ([what changes for existing data](#what-changes-for-existing-data)).
- **Every long-running service now runs under an init process.** v0.2.2 adds one to `db`, `api`, `worker`, the HTTPS proxy, the
  embeddings server and the media server (`livekit`); the keyring and the agent runtime had one already. `./flux upgrade` recreates `db`,
  `api` and `worker` once on it (one clean PostgreSQL restart), the keyring as at every upgrade (so every encrypted space is locked until an
  admin of the space unlocks it) and, when they are on, the HTTPS proxy, the embeddings server and `livekit`, whose new limits apply on that
  recreate.
- **The database image moves to PostgreSQL 18.7** (security release of 2026-11-12), the same major as 18.6: your data directory starts on it
  as it is, with no dump and restore; the pins of `pgvector` and `pg_search` are unchanged. `./flux upgrade` pulls it before the downtime.
- **No setting is renamed or removed** (`docker/env-changes.txt` is unchanged), so your `docker/.env` keeps working as it is; only the
  default file limit grows, from 5 MiB to 25 MiB ([below](#new-settings-and-their-defaults)). `docker/.env` values in single or double
  quotes (`FLUX_PROJECT='flux'`) are now read as Compose reads them; before, such a line stopped every `./flux` command
  ([#1541](https://github.com/ColdPhase/flux/issues/1541)).
- **Two launcher fixes start half way through this upgrade.** `./flux upgrade` on a v0.2.1 server is started by v0.2.1's launcher, which
  checks and downloads the release, asks, takes the backup and only then hands over to v0.2.2's launcher. The quoted values above and
  `FLUX_LIVEKIT_DOMAIN` ([below](#new-settings-and-their-defaults)) are read the new way only from that hand-over on: a quoted
  `FLUX_PROJECT` still stops v0.2.1's launcher before it changes anything, so remove its quotes for this one upgrade.

### New settings and their defaults

All are optional. An old `docker/.env` that sets none of them behaves as before with one difference: the largest file grows from 5 MiB to
25 MiB, because `FLUX_FILE_MAX_MIB` is `25` when it is not set. Set `FLUX_FILE_MAX_MIB=5` to keep v0.2.1's limit.

| Setting | Default | What it does |
| --- | --- | --- |
| `FLUX_CALLS_PUBLIC_IP` | empty | **Split-horizon DNS, or a proxy on another machine** ([#1542](https://github.com/ColdPhase/flux/issues/1542)). With `FLUX_CALLS=on`, `./flux up` looked the origin's name up on the server and advertised what it found, which is the proxy's LAN address when internal DNS answers differently than the browsers' DNS. Set the public IPv4 address browsers send media to: it is kept, checked only for being IPv4, never looked up (the origin needs no A record on the server), and printed. Empty: the lookup runs as before. `FLUX_LIVEKIT_DOMAIN` set in `docker/.env` is now the media name instead of being overwritten with the origin's host; v0.2.2's launcher reads it, so it takes effect from the upgrade's hand-over on ([above](#upgrading-from-v021)). [Calls](https://github.com/ColdPhase/flux/blob/main/docs/operations/calls.md#split-horizon-dns-or-a-proxy-on-another-machine). |
| `FLUX_LIVEKIT_MEMORY` | `512m` | Memory **and swap** of the media server, so a call cannot take memory from the database and the keyring ([#1558](https://github.com/ColdPhase/flux/issues/1558)). A synthetic 16-person call (4 publishing video, 12 receiving, 60 s) measured 75 to 86 MB. |
| `FLUX_LIVEKIT_CPUS` | `1` | CPU limit of the media server (3 to 9 % of one core in that call). Docker refuses a limit above the server's cores, so one CPU also starts on a 1-core server. |
| `FLUX_FILE_MAX_MIB` | `25` (1 to 1,024) | The largest file of a plain space, a direct message or an agent's chat; a message's files together may be four times it ([#1549](https://github.com/ColdPhase/flux/issues/1549)). A picture and every file of an encrypted space stay at 5 MiB. Before, every file but a video was at most 5 MiB. |
| `FLUX_FILE_OCR` | `off` | `on` reads the text in scans and in pictures (PNG, JPEG, WebP and GIF; Polish and English), and that text is the file's text, so search and agents find it ([#1575](https://github.com/ColdPhase/flux/issues/1575)). The image grows by about 8.6 MB. **With it on, the worker gets at least 1 GiB of memory** so that the reader of up to 384 MiB fits beside it: a smaller `FLUX_WORKER_MEMORY` (the settings file's `512m`) is raised to `1g`, and `./flux up` and `./flux upgrade` say so in one line. Off, nothing changes. |

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

### What changes for existing data

v0.2.1 is at schema 95 and v0.2.2 at schema 112. The migrations below are every one of v0.2.2 (`0096`–`0099`, `0102` and `0108` are
not used: the work planned for `0096`–`0099` was renumbered to `0105`–`0107`, and the numbers `0102` and `0108` were not needed). Each
runs in its own transaction while API and worker are stopped, after the backup, and waits at most 5 s for a table's lock; none deletes a
v0.2.1 row of yours (`0107` moves saved sources to Wiki pages and keeps every one), and `tests/app/released-databases.test.ts` runs the
real migrator on a dump of the v0.2.1 database, which every pull request that changes the database must pass
([#1552](https://github.com/ColdPhase/flux/issues/1552)).

| Migration | What it does to existing rows |
| --- | --- |
| `0100_new_message_notices` ([#1550](https://github.com/ColdPhase/flux/issues/1550)) | Replaces the check on `notifications.reason` to allow the new `message` reason (the table is read once), and adds " wrote in " to the title rule of encrypted spaces' content-free notices (applies to rows written from now on). No row is converted: old notifications keep their reasons, and no `message` row exists until the first new message at Everything after the upgrade. |
| `0101_run_gateway_unreachable` ([#1556](https://github.com/ColdPhase/flux/issues/1556)) | Widens the allowed end reasons of agent runs by `gateway_unreachable`. Every existing run keeps its value. |
| `0103_pdf_page_pictures` ([#1557](https://github.com/ColdPhase/flux/issues/1557)) | Adds `project_files.no_text` (`false` for every existing file) and the table `file_page_pictures` (empty). **Queues once more every PDF of a plain space or an agent's chat that was read and found to have no text** (a scan, an exported map): once the worker is up it reads them again in the background, one file at a time, and each gets its page pictures and its "no text" mark. How long that takes depends on how many such files you have; nothing else waits for it, and until a file is read it is found by its name only. Nothing else is read again, and no file or row is changed or deleted. |
| `0104_file_ocr` ([#1575](https://github.com/ColdPhase/flux/issues/1575)) | Adds `project_files.ocr_state` (empty for every file), a small function that names the picture file types, and an index of files OCR has yet to read; replaces the two triggers that queue a new file's text job so that a picture wakes the worker. **Nothing is read while `FLUX_FILE_OCR=off`.** Turned on, the worker reads the pictures and the PDFs without text that were sent before, 50 at a time, newest first, so a large install is not flooded; encrypted spaces' files are never read. |
| `0105_file_size_setting` ([#1549](https://github.com/ColdPhase/flux/issues/1549)) | Replaces the two size checks of `project_files` with ones that allow up to 1 GiB for every file (the setting's top; the application holds the operator's cap). The checks only widen: every existing file (up to 5 MiB, a video up to 1 GiB, a reservation) satisfies them, so no row is converted. Adding a check reads `project_files` once under its lock. |
| `0106_remove_unused_schema` ([#1552](https://github.com/ColdPhase/flux/issues/1552)) | Drops the sequence `agent_thread_guard_sequence` (left behind by `0040`; it holds no data), deletes search rows of the kinds `result` and `draft` (nothing has written them since `0028` and `0044`, so none should exist) and replaces the check on the search kinds. Every other row is unchanged. |
| `0107_material_kind` ([#1508](https://github.com/ColdPhase/flux/issues/1508)) | **Moves every saved source ("material") to a Wiki page of its space, and keeps all of it:** its id, every version (title, text, link, author, time), the messages and tasks that cite a version, its search rows and its events. Its events become a page's (`project.material_created.v1` and `_updated.v1` become `project.doc_created.v1` and `_updated.v1`, with the same ids), its search rows change kind from `material` to `doc`, and the kind, the retry keys and the two rules that told a page from a material (the columns `kind`, `client_mutation_id` and `request_fingerprint`, two triggers and their functions) go. In an encrypted space the rows stay sealed as before. The old saved-source API routes are gone. |
| `0109_dm_file_search` ([#1590](https://github.com/ColdPhase/flux/issues/1590)) | Adds one trigger function and one trigger so that a file sent in a direct message gets its name as a search row when it is published, with the audience of that conversation's own messages (so only the people who can read it find it); gives the direct message files **already there** the name row they lack; and **queues the readable ones** (PDF, DOCX, Markdown, text, CSV) for the worker, which reads them in the background one at a time, as for the files of a space (a picture or a scan only when `FLUX_FILE_OCR=on`, in the bounded batches above). Nothing stored changes shape, and an encrypted workspace's files get no row and no job. |
| `0110_dm_ai_off` ([#1591](https://github.com/ColdPhase/flux/issues/1591)) | Adds the table `dm_ai_off` (empty: **no conversation has AI off after the upgrade**) and allows two more kinds of line in a conversation (`ai_off`, `ai_on`; the check only widens). Local embeddings become an index like BM25 and not AI: the rule that a space whose AI is off has no vectors (`0068`) is replaced, and **on an installation that has turned local embeddings on, the rows of spaces whose AI is off are queued** and embedded by the worker in its usual batches; on one that never did, it writes nothing. |
| `0111_model_id_paths` ([#1593](https://github.com/ColdPhase/flux/issues/1593)) | Widens the check on a model's id in three tables (`background_compute_connections`, `assistant_settings` and `api_key_checks`) so that an id may begin with `/`: a llama.cpp server started without `--alias` names its model by the file it loaded (`/models/Qwen3.8-27B-UD-Q4_K_XL.gguf`). The checks only widen, every id they held still matches, and no row changes. |
| `0112_message_pins` ([#1615](https://github.com/ColdPhase/flux/issues/1615)) | Adds the table `message_pins` for pinned messages (empty: **nothing is pinned after the upgrade**). It stores which message is pinned, by whom and when, never its words. No existing row changes. |

Measured on Flux's database image (2026-11-20), on the v0.2.1 test installation grown to 200,000 space messages, 50,000 space files, 5,000
direct conversations with 200,000 messages and 20,000 files, 10,000 saved sources, a million events and 500,000 notifications: the nine
migrations up to `0110` took 15 s together, of which `0107` 8 s, `0109` 3.5 s and `0110` 3 s, and each of the others under 0.3 s.

Everything else of this release changes no stored data: the new Home list, Seen by and the notices are computed from what v0.2.1 stored; a
map's remembered view is a per-device browser-storage convenience (a map with none opens framed by Fit, as the first time); "Tasks you gave
others" and the Spaces list's newest messages are read from rows v0.2.1 already stored.

**A downgrade is not supported.** Migrations are forward-only. The way back is the backup `./flux upgrade` took first, in `backups/`, with
the release files you ran before (`flux-files-v0.2.1-<time>.tar.gz`). **If a migration fails, the upgrade does not restore by itself:** that
file is rolled back and named, the ones before it stay applied, API and worker stay stopped, and it prints the two commands that put the old
files back and restore the backup, or the one that retries after you fix the cause ([when it fails](https://coldphase.github.io/flux/operate/upgrade/#when-it-fails)).
A migration that cannot get a table's lock within 5 s (another connection to the database holds it, such as an open `psql` session) fails
that way, with a line that says so; close the connection and retry.

## Phone and tablet

- **Back closes what sits on top first.** A message's actions sheet, the Create sheet, a menu, a picker, a panel, the photo viewer or a
  file's preview closes with Back (the arrow or the phone's gesture), and only the next Back leaves the place; before, Back with the
  actions sheet open left the conversation ([#1545](https://github.com/ColdPhase/flux/issues/1545)).
- **The views of a space are one place.** Switching between Conversation, Tasks, Map and Wiki replaces the history entry instead of adding
  one, so Back leaves the space and returns to where you came from (Spaces, Home, Inbox) instead of walking back through its tabs, on the
  phone and the computer ([#1547](https://github.com/ColdPhase/flux/issues/1547)).
- **The keyboard comes only when you tap a field.** Choosing a tab of the Create sheet, opening an agent's chat, the map's and the Wiki's
  pickers and the like no longer put the cursor in a field and open the on-screen keyboard on a touch screen
  ([#1546](https://github.com/ColdPhase/flux/issues/1546)).
- **No white strip under the app in dark mode.** The area under the app, around the system's home indicator, is the page's dark background
  (the dark theme links a dark manifest, so the installed app's navigation bar is dark too) ([#1544](https://github.com/ColdPhase/flux/issues/1544)).
- **The phone's search fields are one flat pill** ([#1609](https://github.com/ColdPhase/flux/pull/1609)): no shadow, the magnifier inside,
  a clear × while there is text and Cancel outside as plain text, in Search (which has no title: the field is its header), the Tasks
  toolbar, the Wiki's Find a page, the map's Find a map and the people and message finders. The computer and the tablet keep their own.
- **Tasks › Board shows one status at a time** on a phone: a row of the four statuses with their counts under the controls, a tap or a
  swipe moves to the next, and nothing scrolls sideways; the computer and the tablet keep four columns. An empty space shows the List's
  "No tasks yet" on the Board too ([#1560](https://github.com/ColdPhase/flux/issues/1560)).
- **Segmented controls keep their size.** Board / List, Map / List, the Create window's kinds, Model and the live stage have equal options,
  so the selected pill no longer changes size when you choose; on a narrow phone the Create window's Close moves to the line below its
  tabs instead of squeezing them ([#1561](https://github.com/ColdPhase/flux/issues/1561)).
- **Phone polish from an audit** ([#1568](https://github.com/ColdPhase/flux/issues/1568)): a thread opened from an Inbox question starts at
  the top of the question, Quiet hours and Muted spaces open into view above the tab bar, the thought chooser has no row of its own for
  Cancel and does not mention Escape on a touch screen, the "Task created" notice always stands above the task's sheet, not across its edge,
  and Settings › Appearance has the title row of the other Settings pages. **Connect AI from Home** opens over Home, so Cancel leaves you on
  Home as it was, the address no longer carries `?connect=1` and a reload never opens the window again
  ([#1567](https://github.com/ColdPhase/flux/issues/1567)).
- **A message link no longer jumps in Safari.** A conversation opened at a message, or reached with Back or Forward, keeps where you were
  instead of starting lower, going to the top of the stream and taking the focus, and snapping back when Tab reveals a control (WebKit
  scrolled to the address's fragment again after a late stylesheet and again on a Back or Forward)
  ([#1530](https://github.com/ColdPhase/flux/issues/1530)).

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
  the computer's plane, each thought where it was arranged, instead of its own column layout. One finger pans, two pinch to zoom (the phone
  has no zoom buttons), a double tap on empty space zooms in and a tap selects. **You arrange by finger**
  ([#1600](https://github.com/ColdPhase/flux/issues/1600), [#1607](https://github.com/ColdPhase/flux/pull/1607)): a thought moves after a
  400 ms press and a drag, so a pan never moves one; a drag from a selected thought's dot links it to another thought or, onto empty space,
  makes a new connected thought that takes typing; a drag within 40 px of the map's edge pans the map; and a thought moved on the phone
  stands in the same place on the computer. The view (zoom, place, selection) is remembered for each person and map on the device, and
  Fit frames a map only the first time or when you press it; a remembered view with no thought left in it opens framed. A link to a thought
  centres that thought. The thought card's "From Ada (you) · 10:48" shortens only the name, so "(you)" and the time stay whole at 360 px.
- **A new thought from a connection dot always takes typing.** The dashed frame sometimes appeared and took no typing until the dot was
  clicked again ([#1554](https://github.com/ColdPhase/flux/issues/1554)).
- **A drag from a connection dot to empty space always makes a thought** and never turns into connect mode ([#1588](https://github.com/ColdPhase/flux/issues/1588)).
  Such a drag asked for a movement lease on the thought it started from and never gave it back, so the next drag from that thought could be
  refused with a false "Another collaborator is moving a selected thought", and the dot's click then started connect mode (seen in
  WebKit). Only a drag that moves or resizes a thought takes the lease now.
- **An agent can add thoughts to a map someone has open** ([#1555](https://github.com/ColdPhase/flux/issues/1555)). Such a map has a live
  room, and every change an agent made there failed; it now works (see [AI agents](#ai-agents)).
- **Make a task** from a selected thought (the floating bar, the List's ⋯ menu and the phone's thought sheet) opens Create on Task with the
  thought's first line as the title; in a space's map the thought is linked as the task's source ([#1519](https://github.com/ColdPhase/flux/issues/1519)).

## Tasks

- **Create takes a due day.** The Task tab has Owner, **Due** and Link; Due opens the same calendar as the task panel's
  ([#1519](https://github.com/ColdPhase/flux/issues/1519)).
- **My tasks shows due days and the tasks you gave others.** Every row shows its due day on its quiet line ("Kai Berg · Due 1 May 2031"),
  and a second section, **Tasks you gave others**, lists your unfinished tasks owned by someone else, in the spaces you can read
  ([#1519](https://github.com/ColdPhase/flux/issues/1519)). It follows your access as it is now: a space you were taken out of, or a
  company you left, shows none of its tasks at once.
- **A task another tab makes reaches the Board** even when the shell's re-read answers before its loading is drawn (seen in WebKit: task 15
  of 25 stayed off the Board) ([#1583](https://github.com/ColdPhase/flux/pull/1583)).
- **The List follows the Board's order.** Tasks › List groups are To do, Doing, Blocked, Done, as the Board's columns. A task's "↓ N new" has its
  own band under the discussion and no longer lies on its words, a change line's "· Undo" no longer stands alone on the phone, and a panel
  over the Board at 200 % no longer cuts the Board's left edge ([#1581](https://github.com/ColdPhase/flux/issues/1581)).
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
  by search and read by agents like a PDF's own text (`flux_search`, the context an agent is given and `flux_read_file`, a scan's pages
  marked as OCR), with a note that OCR may contain mistakes; an agent whose model sees pictures can also look at a scanned page. Files sent
  before the switch was turned on are read 50 at a time, newest first. Never an encrypted space's files. Off by default.
- **PDFs and other documents larger than 5 MB can be sent**, up to the operator's `FLUX_FILE_MAX_MIB` (25 MiB by default, up to 1 GiB), and
  a message's files together up to four times that. A larger file is streamed to and from the disk like a video, so the server's memory
  does not grow with it: a 40 MiB PDF uploaded with the API process at 326 to 338 MiB, and a 60 MiB one against a 50 MiB limit answered
  "Files can be up to 50 MB on this server". A text or HTML preview is for files up to 5 MiB (a larger one downloads); a PDF opens in
  Flux's viewer at any size; the text for search is read from files up to 64 MiB. A picture and every file of an encrypted space stay at
  5 MiB, and the composer says so in words ([#1549](https://github.com/ColdPhase/flux/issues/1549)).
- **Files in a direct message are found by the people in it** ([#1590](https://github.com/ColdPhase/flux/issues/1590), C-64). A file follows
  its message: its name and its text (a PDF's or a document's and, with `FLUX_FILE_OCR=on`, a picture's or a scan's) are found by ⌘K and the
  search API, **only by people who can read that conversation now**: a group conversation's members, and nobody else in the company; a person
  removed from it or from the company loses the results with it. An agent finds, reads and (when its model sees pictures) looks at such a file only in a run in that conversation
  (`/ai` there or in its thread), exactly as it reads the conversation's messages, with the "used AI here" line as always, and never in a
  run in a space or for a local Claude Code or Codex. Never an encrypted space's files. The files already sent in v0.2.1's direct messages
  are read in the background after the upgrade (migration `0109`, above).
- **Two small fixes on the file screens** ([#1601](https://github.com/ColdPhase/flux/pull/1601)). The viewer's Close, in the file preview
  and the photo viewer, is a quiet icon button (no fill at rest, 44 px) instead of a filled grey circle. A picture the server could not read
  says "Can't be read" and every other refusal "Can't be sent", and the limits line under a draft names the pictures' 5 MB when the
  operator's file cap is above it; before, a 14.9 MB picture said "Can't be read" beside a line that said pictures can be 5 MB.

## AI agents

- **An agent says when a tool failed.** An unexpected error was told to the model as "Tool unavailable" and logged nowhere, so an agent
  could not say what had happened. It now says that Flux failed to do this, gives the person an **error id**, and does not guess; whoever
  runs Flux finds the id in the API log, which also has one line per tool call (tool, outcome, time; never its arguments or results)
  ([#1555](https://github.com/ColdPhase/flux/issues/1555)). The cause of the one that started it is fixed too: adding a thought to a map
  someone had open always failed.
- **An agent's task that cannot go on ends Blocked, not Done** ([#1612](https://github.com/ColdPhase/flux/issues/1612),
  [#1614](https://github.com/ColdPhase/flux/pull/1614)). An agent that replied it could not finish a task, without setting the task Blocked
  itself, had its task marked Done when the run ended. Its brief now tells it to set such a task Blocked, with a blocker that says what it
  waits for, and never to mark it Done or change its owner; the task then stays Blocked with the agent. When that change waits for the
  owner's OK (Ask me first on), the task stays as it is until the owner decides: Approve makes it Blocked, Skip ends the run as any other.
- **A run that never reached the model gateway says so.** Instead of "The AI provider didn't answer", the asker reads that Flux couldn't
  reach its model gateway, so the provider wasn't asked, and what to tell whoever runs Flux; a schedule's history says the same. Every
  run that ends without an answer logs its cause (never words or content), and a runtime started with pi checks once that it reaches the
  gateway and logs `gateway_probe` as `ok` or `unreachable` with one sentence ([#1556](https://github.com/ColdPhase/flux/issues/1556)).
- **Times an agent reads are in its owner's zone**, with the offset (`2026-11-19T15:34:00+01:00`), including the days and clock of a
  summary; a model no longer converts from UTC and tells "15:34" for 14:34 ([#1563](https://github.com/ColdPhase/flux/issues/1563)).
- **Agents on a Gemini or an OpenRouter key search the web too** ([#1585](https://github.com/ColdPhase/flux/issues/1585), C-72), as the
  v0.2.1 notes promised: through `flux_web_search`, as on an Anthropic or OpenAI key, with Google Search grounding for Gemini and OpenRouter's
  web search (Exa) for OpenRouter. Flux sends the provider one search request on the run's own key and model, with Flux's instruction and
  the agent's query and nothing else of the run. It is held against the key's daily budget before and charged after, at the provider's
  search price (Gemini 3 and newer $0.014 a query the model ran, Gemini 2.5 and older $0.035 a grounded prompt, OpenRouter $0.007 a
  search), and the agent lists what it searched. **A Gemini key says, in Connect AI and on its card in Settings › AI, that Google's Gemini
  API terms apply to its web search**: whether its use fits them is the key owner's responsibility (founder decision, 2026-11-20), and
  Flux shows no Google Search Suggestions. An endpoint of your own still has no web search, and its agent says so. `FLUX_WEB_READS=off`
  turns web search off for every key.
- **Your agent can search your direct messages from its private chat** ([#1591](https://github.com/ColdPhase/flux/issues/1591)). Asked there
  ("find the invoice Marek sent me"), it searches and reads your direct messages and their files (with OCR's text), and only there: never
  in a run in a space, nor in a schedule or a task whose answer others see, and nothing in a conversation that has AI off. Each conversation it reads from the private chat shows the line
  "Hubert used AI here (Claude)" once per run to everyone in it, so the others learn that their messages reached that AI company.
- **An agent can ask another by the name Flux shows it.** An ask that names "Asystent (Dariusz's agent)", as the agent is listed, reaches
  that owner's agent; before, Flux answered that it was not in the task. A model that filled an optional plan intent with a zero id and
  repeated the refused call up to 30 times (seen on a local Qwen3.8-27B) is now told when a plan intent belongs, so it leaves it out of an
  ordinary task ([#1603](https://github.com/ColdPhase/flux/pull/1603)).
- **A local llama.cpp model is chosen by the id it names** ([#1593](https://github.com/ColdPhase/flux/issues/1593)). A server started
  without `--alias` names its model by the file it loaded (`/models/Qwen3.8-27B-UD-Q4_K_XL.gguf`), which is the id its model list gives; an
  id may now begin with `/` (migration `0111`), and a list that was read but holds no usable model says so instead of "could not be read".
  **A key the endpoint refuses says so** ([#1594](https://github.com/ColdPhase/flux/issues/1594)): "This key was refused by the endpoint.
  Check it and try again." in Connect AI and when an agent is put on another model, with the key kept in its field; before, a refused key
  read "This model can't use tools". Connect, in the API key step, stays disabled until a key is typed, for every provider
  ([#1601](https://github.com/ColdPhase/flux/pull/1601)). **For a local model:** Flux refuses private addresses unless the operator
  allows them with `FLUX_AI_PRIVATE_TARGETS` (host names, addresses or ranges, e.g. `FLUX_AI_PRIVATE_TARGETS=10.0.0.0/8`;
  [configuration](https://github.com/ColdPhase/flux/blob/main/docs/operations/configuration.md#flux_ai_private_targets)), and the model
  server must listen where Flux's containers reach it: a server bound only to the host's `127.0.0.1` is out of their reach.

## Pinned messages

Pin a message in any conversation: a space (its stream and its threads), a direct message (a group too) and your chat with your own agent
([#1615](https://github.com/ColdPhase/flux/issues/1615), [#1616](https://github.com/ColdPhase/flux/pull/1616), C-74). A pin is the
conversation's, never one person's, so everyone in it sees the same list.

- **Pin and Unpin** are in the message's ⋯ menu, after Copy text (key `P`), and in its long-press sheet on the phone. Anyone who can write
  in the conversation can pin or unpin any of its messages; pinning notifies nobody.
- **A pinned message shows "Pinned by Ada"** above it, a quiet line on its author's side. A pin outlives the person who pinned it: a person
  removed from the company is "Ada Kowalska (removed)", as everywhere, and once their account is deleted the line reads "Pinned by a former
  member".
- **"Pinned · N" lists them**, newest pin first. The header's pin button with the count opens it beside the conversation; on the phone,
  and on a tablet whose header has no room for the button, it is ⋯ › Pinned. A click brings the message into view, and the list's Unpin
  removes it.
- **A pin goes with its message**: a deleted message, an agent's message that Undo takes back, and a removed direct message, space or agent
  take their pins; an edited message stays pinned.
- **Search and agents**: ⌘K lists a pinned match first in Messages and marks it; agents read the list with `flux_list_pinned` and see
  pinned hits first in `flux_search`, only where they may read. The project export marks a pinned message `pinned`.
- **After the upgrade nothing is pinned** (migration `0112`, [above](#what-changes-for-existing-data)). A pin stores which message, by whom
  and when, never its words.

## Messages, Inbox and spaces

- **A saved source opens inside its space**, with the space's header, its name, Conversation, Tasks, Map and Wiki (Wiki current) and its
  people, instead of a header "Wiki" with no tabs; Back returns to where you came from ([#1563](https://github.com/ColdPhase/flux/issues/1563)).
- **Saved sources are Wiki pages** ([#1508](https://github.com/ColdPhase/flux/issues/1508), C-71). Each is a page of its space's Wiki like
  any other, in the page list, searched, exported as a page and edited in place, and it keeps the link it was saved with ("Open source link"
  under its text). Your v0.2.1 sources move over on upgrade with every version, citation and search entry (migration `0107`, above); the old
  saved-source API routes are gone.
- **An Inbox Reply says what you asked** above the answer, and a discussed decision says "Discussion · N replies"
  ([#1563](https://github.com/ColdPhase/flux/issues/1563)).
- **Spaces rows say what was said last**: each space shows its newest message and when, as a conversation in Messages does ("Maja: Sent a
  file") ([#1563](https://github.com/ColdPhase/flux/issues/1563)).
- **Anyone in a direct message can turn AI off in it**, as in an encrypted space ([#1591](https://github.com/ColdPhase/flux/issues/1591)).
  "Turn off AI in this conversation" is in the conversation's details; it stays on while at least one person wants it, and each person can
  only withdraw their own choice, so nobody can override someone else's "no AI". While it is on, `/ai` there is refused with a clear line,
  no agent of anyone reads the conversation (not from a private chat, not through search, retrieval, `flux_read_file`, summaries or a local
  Claude Code or Codex over MCP), and its files' text goes to no model. People's own search, file text and OCR included, still works. The
  header says "AI off · turned off by Marek" and a line in the conversation records each change. After the upgrade no conversation has AI
  off (migration `0110`, above).
- **A space or a conversation with AI off keeps its meaning search.** Local embeddings (`FLUX_EMBEDDINGS=on`, bge-m3 on your own server)
  are an index like the word search, not an AI company, so a place with AI off is embedded like any other and people's search there stays
  hybrid; the agents are kept out by the access check of each search, not by missing vectors. In v0.2.1 a space with AI off had none. With
  embeddings on, the worker embeds those spaces in the background after the upgrade (founder decision, 2026-11-20; C-73).
- **The Inbox's toast keeps one line** ([#1601](https://github.com/ColdPhase/flux/pull/1601)). Under the two-column Inbox's open item,
  "Marked done" stood in two lines, with × beside the words and Undo below, unlike every other toast; it is one line again, and only a
  toast beside an open Details panel takes two.
- **Small fixes**: at 200 % the "Task #12 created" notice takes two lines instead of three; offline, a conversation no longer adds "Linked
  work could not be loaded" to the composer's own offline line; the Spaces page's empty states are the one centred empty state
  ([#1563](https://github.com/ColdPhase/flux/issues/1563)).

## Server and operations

- **The database no longer resets on a timed-out health check** ([#1540](https://github.com/ColdPhase/flux/issues/1540)). A probe that its
  timeout killed was taken by PostgreSQL, as PID 1, for a crashed process of its own, which reset every connection and broke the first
  migration on a busy server. `db`, `api`, `worker`, the HTTPS proxy, the embeddings server and the media server now run under an init
  process, which reaps the probe, as the keyring and the agent runtime already did.
- **The media server has limits like every other service**, and the runtime manager and egress get swap limits equal to their memory, so
  no long-running service can swap (`FLUX_LIVEKIT_MEMORY`, `FLUX_LIVEKIT_CPUS`: [above](#new-settings-and-their-defaults)).
- **`./flux` works with quoted values** in `docker/.env` ([#1541](https://github.com/ColdPhase/flux/issues/1541)), **with split-horizon DNS**
  (`FLUX_CALLS_PUBLIC_IP`) and **on a kernel without active Landlock** (a clear line and the fix): [above](#upgrading-from-v021).
- **A source build works on a host with SELinux** ([#1606](https://github.com/ColdPhase/flux/pull/1606)). An image built from a checkout in
  a home directory took the checkout's SELinux labels, and the file reader's `sandbox.node` and the runtime's `node-pty` then failed to
  load ("RELRO protection failed"): the reader failed closed and no file was read. Both are now built apart from the checkout's labels. An
  installation from the release downloads its images and builds nothing.
- **Upgrades are proved on real data** ([#1552](https://github.com/ColdPhase/flux/issues/1552), C-68). Every pull request that changes the
  database now proves that every released database upgrades to a schema equal to a fresh install's and keeps its data (messages, tasks,
  decisions, files, people, agents and Wiki versions), and that nothing in the schema is unused; the release does the same on its real
  upgrade, from a v0.2.1 installation seeded through its API. A sequence left behind by an earlier redesign and two unused search kinds are
  removed (`0106`). **`./flux upgrade --check`**, which shows the plan, is in the v0.2.2 launcher: it works for the upgrades after this
  one, not from a v0.2.1 folder ([above](#upgrading-from-v021)). Every release also proves that each feature **works on the data the
  previous release wrote**, not only that it reads back ([#1604](https://github.com/ColdPhase/flux/pull/1604)): old messages are replied to,
  edited and deleted, old files download byte for byte and are found by search (with OCR for old scans), old tasks move through their
  statuses, old decisions are accepted, old Inbox items are resolved and an old schedule fires; a pull request that adds a migration runs
  it against the newest release, and `scripts/check_backup_upgrade.sh` runs the read-only part on a copy of a real installation.
- **The real-model AI check also runs agents on an API key** ([#1603](https://github.com/ColdPhase/flux/pull/1603)): two people save an
  OpenAI-compatible key at an allowed private address and their agents (pi) run through Flux's model gateway on a local Qwen3.8-27B, with
  thoughts and links added to a map someone has open.
- **The live connection refused once in WebKit is explained** ([#1313](https://github.com/ColdPhase/flux/issues/1313), a known issue of
  v0.2.1). A WebKit browser whose network process restarts comes back with an empty cookie jar, so that page sends no session cookie at
  all, every upgrade of its stream is refused at once and the test's own calls keep working; reproduced on 2026-11-20. A real Safari keeps
  its cookies on disk, so nothing in Flux needed a fix; a refused stream upgrade is logged with whether a cookie came
  (`Refused stream upgrade: no session`, cookie names and never values).

## Security

- **The keyring locks itself when its swap limit is reset** ([#1559](https://github.com/ColdPhase/flux/issues/1559)): described under
  [checks at `./flux up`](#checks-that-run-at-flux-up). This closes a gap in v0.2.1: its keyring checked only at start, so on a host with
  swap, after a `systemctl daemon-reload`, it kept its boot key and nothing noticed.
- **Picture decoding for scanned PDFs stays in the sandbox.** The pages' pictures are decoded in the same sandboxed child as the text (no
  network, its own limits, 32 MiB of output), and only well-formed PNGs within bounds are kept; the
  [threat model](https://github.com/ColdPhase/flux/blob/main/docs/security/threat-model.md) (B4) says so. OCR, when on, adds one picture at
  a time in a child of its own with 60 s and 384 MiB limits.
- **Dependency and base-image security releases.** The Node base image moves to 24.22.3 (the 2026-11-11 security release: nine High CVEs in
  HTTP/2 and TLS) and the database image to PostgreSQL 18.7 (2026-11-12). `ws` 8.23.0 fixes a remote memory-exhaustion denial of service
  by a Ping flood (in the API and the calibration tool). Better Auth 1.7.26 (the local refresh-token patch ported by hand, the same ten
  hunks), pg-boss 12.38.2, sanitize-html 2.18.2, livekit-client 2.24.1, `@anthropic-ai/sdk` 1.10.0, vite 8.3.8 and the docs site's Astro
  and Starlight move to their current patch and minor versions; no major upgrade, and no open Dependabot security alert at the time of
  writing.

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

- **Havana's time is still an hour off in two places** ([#1338](https://github.com/ColdPhase/flux/issues/1338), planned for v0.2.3). Quiet hours and the day of
  "last active" are an hour off for people in `America/Havana`: Node.js has time-zone data 2026e and Cuba's winter time is in 2026f.
  Re-checked 2026-11-20: `node:24-alpine` is 24.22.3 with 2026e, and nodejs.org lists no newer 24.x. PostgreSQL has 2026f. Other time
  zones are unaffected.
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
- **Upgrade time was measured on a small installation only.** The upgrade of a copy of a real v0.2.1 installation took about 40 s; it was not
  measured on a large database, where the backup dominates (`./flux upgrade --check` of the next upgrade prints a rough time for it).
  The migrations took 15 s on a synthetic dataset of 400,000 messages, 70,000 files and a million events, and `0103` and `0109` queue
  files that the worker then reads in the background.
- **A model on an OpenAI-compatible endpoint is treated as not seeing pictures**, whatever the model can do, so it is not shown a picture
  or the pages of a scanned PDF (it is told a PDF with no text cannot be read).
- **An endpoint of your own has no web search**, and its agent says so; every agent can still open a public web page. Gemini's search
  follows Google's Gemini API terms, which are the key owner's to follow, and Flux shows no Google Search Suggestions.
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
