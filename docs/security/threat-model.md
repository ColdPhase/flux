# Threat model

This is the threat model of Flux v0.2 as it stands on `main` at `5d22020ea` (2026-11-08). It was written
for the independent security audit [#837](https://github.com/ColdPhase/flux/issues/837) by an agent that
wrote none of the audited code. It goes with the [ASVS 4.0.3 Level 2 review](asvs-l2.md), which holds
the evidence for each requirement. Report a vulnerability as the [security policy](../SECURITY.md) says.

Related work, kept separate on purpose:

- [#838](https://github.com/ColdPhase/flux/issues/838): DAST with ZAP. Its CSP finding is [#979](https://github.com/ColdPhase/flux/issues/979).
- [#839](https://github.com/ColdPhase/flux/issues/839): the authorization and tenant-isolation pentest. This document does not repeat its
  object-by-object authorization tests.
- [#840](https://github.com/ColdPhase/flux/issues/840): image signing.
- Changes merged after this audit that change what is described here: #983 (every address asked is listed, for #953), then
  #1065/#1134 (an agent opens any public address; the server refuses one that carries private Flux text the run read, C-30)
  and #1136 (that check's cost, the pages a person named, link cards for agents' lines, the kept text deleted when the run ends);
  #984 (Focus mode goes; no security effect) and #842 (`/ai` in every conversation; it widens where an agent answers, so the
  audience rule C-12 matters more);
  #1252 (file previews: someone else's HTML and PDF in a sandboxed, opaque-origin frame with no network, C-60; the pages'
  `frame-src` goes from `'none'` to `'self'`).
- [#1270](https://github.com/ColdPhase/flux/issues/1270): the v0.2.1 audit. Part A (agent pictures and vision, agent search, message
  formatting and shown answers, model listing with API keys) was checked at `96e762b71` (2026-11-13) by an auditor who wrote none of that
  code, with real exploit attempts against a Compose stack; its rows below say so. Plan models read from the CLIs (PR #1340) were not
  merged then and are not covered.
  A delta audit at `58c10e9e4` (2026-11-13) covered what landed after `96e762b71`: plan models from the CLIs (#1340), search ranking (#1326,
  #1400), the optional local embeddings (#1341), videos (#1391, #1393), `flux_summarize` (#1327), the refused-upgrade log line (#1355),
  the COMMIT timeout (#1389) and the live media queue (#1385). See [the delta audit's section](#v021-delta-audit-1270-videos-embeddings-plan-models-summaries).

## What changed since v0.1

v0.1 was never independently reviewed. Since then:

- **One Flux is one company, with Spaces** (F-037). The data model still keeps a workspace table. The
  company is one internal workspace, and spaces are projects in it. Company owners and admins can manage
  any plain space, but their lists and agents see only the spaces they belong to (C-15).
- **Encrypted spaces** (F-030 moved per space, #976, C-24 to C-27). Each one is a hidden internal
  workspace whose keys only its own admins and a recovery code hold.
- **Agents with their owner's rights** (F-036, #855, #921, #922). There are no agent grants any more: an
  agent has exactly its owner's current rights and one "What it may do" row. Deletions and other people's
  things wait for the owner, and only the owner approves, in their own browser session.
- **Local MCP clients with one-click sign-in** (#928, #943, C-19 to C-23). OAuth 2.1 with PKCE, Client
  ID Metadata Documents, a single `offline_access` scope, and an agent of the person's own made on
  Allow.
- **Web reads** (#949). Server agents can read public pages through the link cards' SSRF guard. Since #1065 any public address,
  refused when it carries private Flux text the run read (C-30, #1136).
- **Pictures from agents** (#1217, after this audit). The server downloads a public picture an agent attaches to its `/ai` answer, through the
  same SSRF guard, and a model can be given a picture attached to a message the run may read (C-59).
- **Agents search** (F-042, #1324). `flux_search` and `flux_read_around` read everything the owner may read now, limited to the run's
  place: a space's run its space, a run in a direct message that direct message.
- **Formatted messages and shown answers** (#1247, #1222, #1232). One parser turns a small Markdown subset into React elements; an
  answer posted with Show everyone carries its agent's name and colour (`via`, `via_colour`) and is drawn as that agent's message.
- **An API key's own model list** (#1218, #1265). The API sends a key being added to its provider's fixed address to list its models;
  the worker does the same for a stored key.
- **File previews** (#1252, C-60, after this audit). Someone else's HTML and PDF open in a frame from Flux's own origin, sandboxed by
  the response's policy; text, Markdown, JSON and CSV/TSV are parsed in a Web Worker and drawn by React on Flux's page.
- **Profile photos and space icons** (#1226 F-039, #1227 F-040, after this audit). The first pictures a person uploads that everyone who
  can see them loads; the API decodes them with libvips (sharp) and keeps three WebP renditions.
- **Videos** (#1352, C-61). A video of a plain space is up to the operator's cap (`FLUX_VIDEO_MAX_MIB`, 200 MiB by default, 1,024 at
  most), streamed to disk and back by byte range, with a poster the server decodes and re-encodes.
- **Optional local embeddings** (#1294, F-042). An operator's own text-embeddings-inference container embeds every searchable row of a space
  whose AI is on, and search fuses the nearest vectors with BM25.
- **Plan models from the CLI** (#1332, #1340). The runtime's supervisor asks the signed-in Claude Code or Codex for the account's models in
  the person's own slot and stores ids, names and one-line notes.
- **`flux_summarize`** (#1292, #1327). An agent reads one place since a date as a compact digest, under the same place rules as `flux_search`.
- **Dependency upgrades** (#913) and the security scans of #834 to #836: Dependabot, Trivy and CodeQL.

## System and trust boundaries

```
 Browser (SPA, PWA, service worker)          Local Claude Code / Codex (MCP client)
        │  HTTPS, session cookie                   │  HTTPS, OAuth bearer (JWT, EdDSA)
        ▼                                          ▼
 ┌──────────── reverse proxy (operator) ─────────────────────────────┐
 │  TLS, HSTS (operator), FLUX_TRUSTED_PROXIES                       │
 └──────────────────────────────┬────────────────────────────────────┘
                                ▼  127.0.0.1:FLUX_PORT
 ┌─────────────── api (Fastify, Better Auth, MCP route) ─────────────┐
 │ origin check · session resolver · access policy · lock gate       │
 └───┬──────────────┬───────────────┬───────────────┬─────────────────┘
     │ SQL          │ keyring net   │ pg-boss jobs   │ runtime-api net (/mcp only)
     ▼              ▼               ▼                ▼
 PostgreSQL     keyring (RAM)    worker ──────► runtime-manager / runtime-1 (CLIs per uid)
 files volume                     │ push, mail,     │
                                  │ provider calls  └► runtime-egress ─► vendor hosts only
                                  ▼
                      AI providers, Web Push services, SMTP, GitHub, public web (guarded)
```

| # | Boundary | Who is on each side | What crosses it |
| --- | --- | --- | --- |
| B1 | Browser ↔ API | A person or guest; the server | Session cookie, JSON commands, WebSockets (stream, typing, live editing), file bytes |
| B2 | Reverse proxy ↔ API | Operator's proxy; the server | Client address (trusted only from `FLUX_TRUSTED_PROXIES`), TLS termination |
| B3 | MCP client ↔ API | A person's local Claude Code or Codex; the server | OAuth authorization, bearer tokens, MCP tool calls |
| B4 | API/worker ↔ PostgreSQL and files volume | Flux processes; the database and disk | All content: sealed in encrypted spaces, plain elsewhere |
| B5 | API/worker ↔ keyring | Flux processes; a RAM-only key holder | Bearer token, sealed per-space keys |
| B6 | Worker ↔ agent runtime | The worker; one runtime container with a supervisor and per-person user ids | Run requests, run-scoped MCP tokens, vendor CLI credentials on the runtime volume |
| B7 | Server ↔ AI providers | Flux; Anthropic, OpenAI, OpenRouter, Gemini, OpenAI-compatible endpoints | Prompts with the content an agent may read, API keys |
| B8 | Server ↔ public web | Flux; any host on the internet | Link-card and web-read fetches, CIMD client metadata, push endpoints |
| B9 | Server ↔ identity provider | Flux; the company's OIDC provider | Sign-in, back-channel logout, standing check (offline token) |
| B10 | Server ↔ GitHub | Flux; the GitHub App | Read-only repository data, webhooks |
| B11 | Operator ↔ host | The person running Flux; Docker, `.env`, backups | Every secret, backups, upgrades |
| B12 | Model output ↔ Flux actions | What a model writes; the tools it can call with its owner's rights | Tool calls, messages, task changes |
| B13 | Browser ↔ LiveKit SFU (calls) | A person in a call; the operator's SFU behind the API's `/media` gate | Signalling (only through the gate), a 90 s LiveKit grant, audio, video and screen over ICE/TURN |

## Assets

| Asset | Where | Why it matters |
| --- | --- | --- |
| Company content: messages, DMs, tasks, maps, Wiki, decisions, files | PostgreSQL, files volume | The product's reason to exist. DMs and private spaces carry the most sensitive text |
| Encrypted-space content and keys | Sealed columns and files, `encryption_*` tables, `workspace_unlocks`, keyring RAM | Promised to be unreadable to the company admin and the database |
| Credentials | `auth_accounts` (scrypt hashes), `auth_sessions`, OAuth tokens, `.env` secrets (`FLUX_AUTH_SECRET`, `FLUX_KEY_PIN_SECRET`, DB password, VAPID key) | Account takeover; signing invites, cursors and JWTs |
| AI credentials | API keys sealed under the background key; Claude and Codex plan credentials on the runtime volume; a key in the API's memory only while it is being added and its models listed (#1218) | Spending a person's plan or money; impersonating them at the vendor |
| Readers' browsers | Every member's tab and phone that draws a message, a picture or a shown answer | A stored message or picture that runs script, misleads about who wrote it, or crashes the tab on every visit |
| Agent identities and their "What it may do" | `agents`, `agent_connections` | An agent acts with its owner's rights |
| Company membership and roles | `workspace_members`, project grants | Who can see and manage what |
| Profile photos and space icons | Files volume (three WebP renditions each), `person_photos`, `space_icons` | A person's face and a space's sign, shown to everyone who can see them; the upload is decoded on the API, so a decoder fault is server-side |
| Availability | 2 vCPU / 4 GB target | Agents, live editing and Argon2id derivations compete for the same resources |
| Backups and exports | Operator's storage | Hold every message, the password hashes and `.env` |

## Actors and attacker profiles

| Actor | Legitimate power | What they might try |
| --- | --- | --- |
| **Outsider** on the internet | Reaches the sign-in page; in `open` mode can create an account (that account joins no company) | Guess or stuff passwords, enumerate accounts, claim a fresh server, SSRF through features that fetch URLs, phish a person into a malicious OAuth client |
| **Person** (company member) | Their spaces, DMs, their own agents and clients | Read spaces or DMs they are not in, act as someone else, raise their role, abuse agents or fetch features |
| **Guest** | Only the spaces they are added to; no AI (F-037) | Reach company-wide lists, connect AI or a client anyway (#959, #978) |
| **Space admin** | Their space's people, settings and AI switch; keys of an encrypted space | Reach another space; keep keys after removal |
| **Company admin / owner** | Every plain space, people, Restore; can delete an encrypted space | Read an encrypted space they are not in (C-4, C-24); act through agents beyond their own spaces (C-15) |
| **Agent** (server run) | Exactly its owner's current rights, limited by "What it may do" | Follow injected instructions, approve its own waiting items, exfiltrate what its owner can read |
| **Local client** | The same as an agent, over MCP, from the person's computer | Keep access after the person's rights end, act after Disconnect, reach the runtime or other people's work |
| **Another person's CLI in the runtime** | Its own user id and directory | Read another person's plan credentials or files, reach their loopback ports, exhaust shared memory and `/tmp` |
| **Content author** (any person, a web page, a GitHub issue, a document) | Writes text that an agent later reads | Indirect prompt injection |
| **Operator** | Everything on the host | Trusted. In scope only for mistakes: weak `.env` handling, exposing ports, unencrypted backups, swap |
| **Database or backup thief** | A copy of PostgreSQL or the volumes | Read content and tokens; F-030 limits this for encrypted spaces only |
| **Malicious dependency or image** | Code that runs at build or run time | Steal secrets, backdoor the release |

## Threats and controls per boundary

"Control" names what `main` does, with the evidence in the [ASVS review](asvs-l2.md). "Residual"
is what remains, and an issue number marks a finding of this audit.

### B1 Browser ↔ API

| Threat | Control on `main` | Residual |
| --- | --- | --- |
| CSRF on cookie-authenticated commands | One accepted origin (`FLUX_PUBLIC_ORIGIN`); Origin, `Sec-Fetch-Site` and Referer checked, and a cookie with none of them refused (`identity/origin.ts:59-69`); `SameSite=Lax` cookies. Probe: foreign origin, missing origin and `same-site` each answered 403 | None found |
| Cross-site WebSocket hijacking | Origin compared with the public origin on the stream, typing and editing upgrades | None found |
| Clickjacking of consent and approvals | `X-Frame-Options: DENY` and `frame-ancestors 'none'` on every response (`http/framing.ts`); the exceptions are a file preview and the PDF viewer page (below), which only a Flux page may frame (`SAMEORIGIN`, `frame-ancestors 'self'`) | None |
| Someone else's HTML or PDF previewed in Flux (C-60, [#1252](https://github.com/ColdPhase/flux/issues/1252), [#1349](https://github.com/ColdPhase/flux/issues/1349), [#1350](https://github.com/ColdPhase/flux/issues/1350)) | Never on Flux's origin: `GET /api/v1/files/:id/preview` answers only a frame of a Flux page (`Sec-Fetch-Dest: iframe`, `Sec-Fetch-Site: same-origin`; a tab, a link or the frame itself gets 403), under the download's access check, only for `.html`/`.htm`, with `Content-Security-Policy: sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`, `nosniff`, `no-store`, `no-referrer` and a Permissions-Policy that allows nothing. Every `<link>` and `<meta>` is sent inert (`<x-link>`, `<x-meta>`): WebKit opened a connection for `<link rel="preconnect">` that CSP did not stop, and DNS prefetch and preload are hints of the same kind. So is every element that can hold a document without a fetch (`<iframe>`, `<frame>`, `<object>`, `<embed>`, `<portal>`, `<fencedframe>`) and every `srcdoc=`, in the same pass: the same hint inside an `<iframe srcdoc="&lt;link rel=preconnect …&gt;">`, which the browser decodes into a nested document `frame-src` does not govern, also opened a connection in WebKit, to any depth (#1349, fixed). A UTF-16 page (byte-order mark) is decoded first and sent as UTF-8, so the rewrite sees what the browser sees. The HTML frame adds the `sandbox` attribute without `allow-same-origin` and an `allow` list of `'none'`: an opaque origin, so no cookie, storage, API, parent DOM, camera or microphone (even when Flux holds that permission for a call); no scripts, forms, popups, top navigation, downloads, modals or automatic refresh; nothing is fetched (no remote image, font, style, script, frame or connection), so opening a file tells no one it was read. **A PDF is never handed to the browser's own PDF viewer** (#1350, fixed): Chromium's runs in an extension frame the frame's policy does not govern, and a click on a link annotation navigated the whole Flux tab (an invisible, page-sized link made that one click anywhere). Flux draws the PDF itself with the pinned PDF.js in a page of its own (`/pdf-viewer/index.html`), framed with `sandbox="allow-scripts"` (opaque origin) under `sandbox allow-scripts; default-src 'none'; script-src 'self'; …` with no `connect-src` and no `'unsafe-eval'`; the page receives the bytes by message, runs no script, form or action of the file, and makes each link annotation a button: an `http(s)` address goes to the Flux page, which shows it and opens it in a new tab with `noopener noreferrer` only when the person presses Open link; a destination inside the document scrolls in the viewer; every other action and scheme (`javascript:`, `data:`, `file:`, Launch, GoToR, JavaScript, forms) is dropped, as is an address with a user name or password. The preview route serves no PDF. Negative browser tests, with a real TCP listener for the hints and the audit's page-sized link PDF in the full Chromium build and in WebKit: `tests/ui/test_file_preview.py` | **Run scripts** (a person's choice per preview): the script still has an opaque origin and no `connect-src`, but CSP does not cover WebRTC, so a script can contact the internet; the note says so. A script can also keep the tab busy, build an `<iframe srcdoc>` itself, and draw anything inside its own frame. A link a person clicks inside the preview loads nothing, and neither does a navigation of the frame by a script: a Flux page frames only its own origin (`frame-src 'self'`), Flux's pages refuse to be framed, and the preview route refuses a navigation that did not come from the Flux page. PDF.js parses and draws a hostile file in two workers of the viewer frame (from blobs): a page that is slow to draw (one path of 300,000 crossing lines took 220 s, measured by the #1388 review) keeps only its worker busy, and the Flux tab, which shares its thread with the frame in WebKit, answers (the review measured at most 45 ms of delay); a bug there reaches no Flux data. The viewer draws at most 5,000 pages, 16 million pixels and 16,384 pixels a side a page, and releases the pages it leaves. Nothing is fetched, so a file's JBIG2 images and its CJK fonts that are not embedded may draw without what PDF.js would load for them (not exercised) |
| Hostile pictures as a profile photo or a space icon (F-039, F-040; [#1226](https://github.com/ColdPhase/flux/issues/1226), [#1227](https://github.com/ColdPhase/flux/issues/1227)) | The bytes decide the type (a PNG, JPEG or WebP signature; GIF refused); libvips with only those three loaders unblocked, no cache, one thread, one picture at a time and four waiting per API process (more: 503 `PICTURES_BUSY` before the body is read); the header's 40-megapixel limit before decoding; the middle square cropped before resizing; the pixels leave libvips raw and are encoded as WebP 64, 128 and 256, so no metadata or trailing bytes survive (`pictures/render.ts`). 5 MiB for a photo, 2 MiB for an icon; a session and Flux's Origin before the body is read. Served as `image/webp`, `nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy: same-origin`, only to people who can see the person or open the space (404 otherwise, also for a replaced picture). A space icon needs `project.manage`; an encrypted space keeps its letter (409). Probes at `96e762b71` (#1270, part B): 14 spoofed or other formats refused (PNG or JPEG signature with HTML or SVG, GIF, SVG, BMP, TIFF, ICO, PDF, HEIF, AVIF, truncated); polyglots (a PNG with a script and ZIP tail, a JPEG with HTML in a comment and after its end) and EXIF GPS, a serial number, XMP, ICC, PNG text and WebP EXIF/XMP: every rendition is a plain WebP with none of it; headers of 100,000², 65,500² and 6,325² pixels refused in 1 ms (413); a real 40-megapixel PNG renders in 0.15 s, ten at once give five pictures and five 503 while `/api/v1/me` stays at 2 ms; a 12 MiB chunked upload 413; a foreign or missing Origin 403; the space icon refused to the space's contributor and guest (403), to a company member outside a restricted space and an outsider (404) and signed out (401); after removal from the company or the space, 404 | A rendition is cached by the browser for a year (`immutable` under a random id): someone who loses access keeps the pictures already in their cache. A company owner or admin may change the icon of a plain space they are not in (C-15, by design). The size in the address is read as a number (`0x40`, `64.0` serve the 64 px rendition): harmless |
| Content sniffing, header injection and ranges on downloads | `GET /api/v1/files/:id`: `application/octet-stream`, `attachment; filename="download"; filename*=UTF-8''…` with every reserved byte encoded, `nosniff`, `Content-Security-Policy: sandbox`, `no-store`; upload names with control or path characters, `.`, `..` or over 200 characters refused (CR/LF, NUL, `../`, backslash, right-to-left override probed); the preview kind follows the stored name exactly (`.HTM` is HTML; `x.html%00.txt`, `x.html.` are not). Downloads answer one `Range` with 206 (C-61: a resumed download or a video's seek; several ranges or a bad one get the whole body, 200) and pictures ignore it; the static handler serves one range and merges a 500-part request into one; encoded traversal on it (`..%2f`, `%2e%2e`, `%252e`, backslashes) answers 403 or 404 | None found |
| A video someone sends played in Flux (C-61, [#1352](https://github.com/ColdPhase/flux/issues/1352)) | A file is a video only when its name is `.mp4`, `.m4v`, `.mov` or `.webm` **and** its first bytes are that container (an ISO `ftyp` box whose brand is not a picture's or a sound's, or an EBML header whose DocType is `webm`), checked on the first chunk, so a mislabelled gigabyte is refused with 400 `NOT_A_VIDEO` after one chunk and leaves no row and no scratch bytes; no HTML, SVG or script is ever served as video. `GET /api/v1/files/:id/video` serves only a recorded video, as the type its bytes were recognised as, an attachment under `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox`, `Cross-Origin-Resource-Policy: same-origin` and `Cache-Control: private, no-store`; the page's own policy loads media only from `'self'` and `blob:`. Access (the space's read right, or the uploader's own unsent file) is read in the database **on every request, each range of a playing video included**, so a person who loses the space (#592) is refused on the next range; a response already streaming is not recalled. A range is one `bytes=` range (206/`Content-Range`, 416 past the end); several ranges, a bad one and `If-Range` get the whole file. A file up to 5 MiB keeps its SHA-256 check on every read (a range is cut from the verified bytes); a video over 5 MiB is answered from disk in 256 KiB reads with its size checked, so no request makes the API hold it in memory, and its digest, computed once as it arrived, is verified in the export. Sending a message reads no byte of its files inside the message's transaction, only each object's size on disk (#1411: hashing every video there let a few sends at once hold every database connection of an API process); files up to 5 MiB are hashed just before that transaction opens, so their changed bytes still cannot be sent, while a same-size change to a larger video is caught only by the export. An upload streams through SHA-256 into private scratch (one chunk held), within the operator's `FLUX_VIDEO_MAX_MIB` (413 from the declared length before any byte, from the count otherwise) and 20 minutes; waiting videos are bounded to one cap per person and space, and at most three of one person's videos arrive at once (429 `UPLOADS_BUSY`; a reservation can be as small as the declared length, so bytes alone would not bound slow connections). A poster is the sender's browser's picture and is treated as untrusted: only the staged video's own uploader may set it, before any decoding; PNG, JPEG or WebP by its bytes, at most 512 KiB, walked first like every stored picture (#1343: one still picture whose headers agree on one size within the bounds), decoded and re-encoded by libvips as a WebP of at most 640 px with no metadata, through the same one-at-a-time bounded queue as profile photos; it is read through the download route under the video's own access. An encrypted space gets none of this: its videos are ordinary sealed files (5 MiB, download only) because a sealed object cannot be ranged without releasing bytes before their tag is checked. API tests: `tests/app/video-files.test.ts`, `tests/app/video-core.test.ts`, `tests/app/video-send-transaction.test.ts` | The browser decodes the video: a codec bug in a browser's media stack is in the browser's hands, as for any media a site shows (the file is untrusted data; Flux never transcodes, so no ffmpeg runs on the server). A video can be a very long file of one person's choosing up to the cap: it counts against the files volume (the operator sets the cap), and one slow upload holds one connection up to 20 minutes. A stream in flight when access is lost finishes. A poster is the sender's claim of a frame: it may not match the video (a person can show a picture of their choice there). Sending used to hash each video inside the message's transaction, which let a few sends hold every pool connection ([#1411](https://github.com/ColdPhase/flux/issues/1411), P2, delta audit); fixed by [#1418](https://github.com/ColdPhase/flux/pull/1418). `UPLOADS_BUSY` counts per API process, so N processes let a person have 3 × N videos arriving. No per-person quota bounds what is sent (the operator's disk). Probes at `58c10e9e4` (delta audit, D1): a sent video, its poster, a HEAD and a ranged download refused (404) to a guest of another space, a member outside the restricted space, a person of another company and a person removed from the company (after their next range); a guest of the space and a company admin outside it (C-15) are served; nothing of an unsent video, its poster or a new poster reached anyone but the sender; a locked encrypted space answered 423 to the range, HEAD, upload and poster; 25 malformed, multiple, overflowing and suffix ranges on the streamed and the in-memory path gave 200, 206 with the exact bytes, or 416, never 5xx; six 1 GiB uploads at once took 25 s with a seventh refused (429) and kept other people's requests under 170 ms |
| Stored XSS (messages, Wiki, file names, link cards) | React escaping; Wiki Markdown rendered by markdown-it with `html:false` and sanitize-html with an allow-list (`docs/markdown.ts`); links limited to http, https and mailto; files served as `attachment` with `sandbox` CSP and `nosniff`; a preview's HTML only in a sandboxed opaque-origin frame (row below) | A script Content-Security-Policy limits the damage of a future XSS: the pages run only Flux's own scripts and the hashed inline ones, and connect nowhere but to their own origin (`http/content-security-policy.ts`, [#979](https://github.com/ColdPhase/flux/issues/979)). Styles may still be inline. |
| Script through formatted messages (#1247, #1222) | One parser (`parseMessage`, `@flux/contracts`) returns plain data and `MessageText` builds React elements from it, never HTML; only `**`, `*`, `` ` ``, fences, `- `/`1. ` lists and `>` quotes are marks; Markdown links, HTML, images and headings stay text; a link is drawn only for an `http(s)://` run of the text, with the same text as its address, `noopener noreferrer nofollow`; a fence's language is text; invented `[n]`/`【n】` marks are taken out when an answer is stored. Attempted (#1270 A-FMT-1/2/3, Chromium and WebKit on the running app): `javascript:`/`data:`/`vbscript:` links, `[x](javascript:…)`, raw `<img onerror>`/`<script>`/`<svg onload>`, quotes inside an address, marks around links and code, an HTML fence info string and quote author, `[[…]]`/`@`/`#` chips with HTML: no script ran, no `on*` attribute, every message link `https://…`; the parser and the chip regex stay linear on 100,000-character hostile bodies (at most 32 ms) | None found |
| A person passes their words off as an agent's answer (#1232) | `via` and `via_colour` are written only by Show everyone (`planShow`: the agent's name and colour) and, for `via` alone, by a person's local client; the message and edit routes drop both fields (#1270 A-FMT-4: a person's `via`/`viaColour` on send and edit were ignored, stored null); the name line always starts with the real asker's first name ("Ada's Assistant") | An agent's name is any 1–80 characters its owner types: "Assistant — shown by Lena" reads as shown by someone else (not a character rule). **Fixed in #1347 (P3):** the bidi controls (U+202A–202E, U+2066–2069, U+200E/F, U+061C) and the invisible U+200B, U+2060 and U+FEFF are refused in a name when it is typed (agent, workspace and space names, sign-up and profile names: `INVALID_NAME`) and cleaned when a name is read from the schema or comes from an identity provider or an OAuth client, so "Ada's ‮TNATSISSA S'TREBUH" can no longer draw as "Ada's HUBERT'S ASSISTANT"; the zero-width joiners stay for emoji. The `via_colour` backfill of migration 0059 marks a person's "via Claude Code" post as an agent answer when none of the author's connections still carries that label (seen in a rolled-back test; connections are revoked, never deleted, so in practice only for a deleted author) |
| Session theft or fixation | HttpOnly cookies, `Secure` with a `__Secure-` prefix on https; new token on sign-in; server-side sessions read on every request (no cookie cache; once Better Auth has accepted a signed cookie, later requests in the same API process read its session row and person in one statement and hand a session that is gone, expired or due for renewal back to Better Auth, [#1178](https://github.com/ColdPhase/flux/issues/1178)) | None found. Sessions end after 7 days unused and 30 days from sign-in, both settable ([#993](https://github.com/ColdPhase/flux/issues/993), fixed) |
| Information leak in errors | Domain errors mapped to safe bodies; every unexpected error answers a code only and logs the redacted error ([#991](https://github.com/ColdPhase/flux/issues/991), fixed) | None found |

### B1/B9 Authentication

| Threat | Control on `main` | Residual |
| --- | --- | --- |
| Password guessing and stuffing | At least 12 characters, no common or easy-to-guess password (bundled list, no network call); Better Auth limiter per address (IPv6 as /64) stored in PostgreSQL, so every API process counts together; each account backs off after five attempts, 30 s up to 15 min, whatever the address, and a browser that has signed in to the account (signed device cookie) counts in a wait of its own, so a stranger cannot lock the owner out ([#990](https://github.com/ColdPhase/flux/issues/990), fixed) | Someone who knows an address can keep a browser that never signed in to it waiting up to 15 minutes at a time; the reset mail is the way back, and the browser that finishes it is remembered. No MFA in password mode; SSO is the recommended path |
| Account enumeration | Password reset answers the same for every address; `verified` sign-up too, and mails the owner; sign-in back-off is the same for unknown addresses | `open` sign-up says an address exists, because it signs the new account in: accepted and documented ([#993](https://github.com/ColdPhase/flux/issues/993)) |
| Reset or verification token abuse | Tokens stored hashed, single use, expiring; reset redirect limited to the trusted origin (probe: `INVALID_REDIRECT_URL`); sessions revoked on reset, and the person's local clients disconnected ([#989](https://github.com/ColdPhase/flux/issues/989), fixed) | None found |
| Claiming a new server | API only on loopback until the operator adds a proxy | An operator who exposes the server before creating the owner: the install guides create it first and `./flux up` and the API log warn ([#994](https://github.com/ColdPhase/flux/issues/994), fixed) |
| SSO account takeover by email | Accounts keyed by OIDC `sub`; implicit linking off; an address held by a verified account is refused; ID token verified with PKCE; back-channel logout and standing check | Depends on the IdP. Not re-tested here (covered by the OIDC suites) |

### B3 Local MCP clients

| Threat | Control on `main` | Residual |
| --- | --- | --- |
| Malicious client phishing a person ("Claude Code" from evil.example) | No dynamic registration; clients only from CIMD over HTTPS with DNS pinning to public addresses; the consent page shows the redirect host, the client-details host and a warning for non-loopback redirects; framing refused | A person can still click Allow on a client they don't recognise. Every client gets the owner's full rights; there are no scopes, by decision (C-23) |
| Token replay after access ends | JWT audience bound to `/mcp`; live grant, connection, owner standing and space AI checked on every request and again before output (`mcp-route.ts`); company removal answers 403 (C-22) | None found. A password reset, a password change that signs out other devices and "Sign out all other devices" disconnect the person's clients ([#989](https://github.com/ColdPhase/flux/issues/989), fixed) |
| A borrowed browser session mints a lasting client | Consent needs a live session in the same browser | One click, with no re-authentication ([#993](https://github.com/ColdPhase/flux/issues/993)); the person's recovery now ends the client ([#989](https://github.com/ColdPhase/flux/issues/989), fixed) |
| A guest or non-member connects a client | C-22 | Not complete on `main`: [#978](https://github.com/ColdPhase/flux/issues/978) and [#959](https://github.com/ColdPhase/flux/issues/959), with PR #986 open |
| A client approves its own waiting changes | No approve tool exists in the MCP tool list; approvals only in the owner's browser session (F-036 point 7) | None found |

### B4 Database and files

| Threat | Control on `main` | Residual |
| --- | --- | --- |
| SQL injection | Drizzle query builder and `sql` template parameters throughout | None found by inspection |
| Path traversal in uploads | Display names validated (no control or path characters, no `.` or `..`); objects stored by UUID | None |
| Database or backup theft | Encrypted spaces seal content (AES-256-GCM, per-row keys); AI keys sealed under the background key held outside the database | Plain spaces, DMs, password hashes and OAuth rows are plaintext in the database and in backups, by design. The hardening guide says to encrypt backups |
| A compromised or faulty database extension (F-042) | The database image is built by Flux from pinned inputs: the official PostgreSQL base by digest, `pg_search` from its ParadeDB release checked by sha256, `pgvector` at an exact version; the release scans it (no fixable HIGH/CRITICAL), attests and signs it, and pins it by digest in `compose.yaml` | `pg_search` is a large native library (Rust, about 280 MB) inside the database process: a defect in it can crash the database or damage its index; the index is rebuilt from `search_documents` (`REINDEX`), and the backup is the way back for anything else |
| Text reaches the optional embedding container (F-042, #1294, #1341) | Off by default; only the operator's own container (`docker/compose.embeddings.yaml`: text-embeddings-inference pinned by digest, `cap_drop: ALL`, `no-new-privileges`, a memory limit, no published port), never a person's connection. Rows that may not be embedded are never queued and lose their vector in the writer's transaction: sealed rows of encrypted spaces, every row of a space whose AI is off, people's names, empty rows (`search_vector_eligible`, migration 0068); a vector is stored only if the row's words still hash the same and it is still eligible, under share locks. The worker's and the API's log lines name counts, kinds and HTTP statuses, never a text; the container logs timings only. Probe at `58c10e9e4` (delta audit): a marker word in a message and a video's name never appeared in the API, worker, database or container logs | Vectors are as sensitive as the text: they sit in plain columns in the database and backups beside it (B4), and an embedding can be inverted into an approximation of its text. Direct messages and private map thoughts are embedded too (no AI switch governs them). The container joins the stack's default network, so it can reach PostgreSQL's port (it holds no password) and the internet (it needs `huggingface.co` on its first start); a compromised image would read every text anyway. It has no CPU limit: on two cores the backfill kept it at 150–175 % of the CPU for hours (0.35 rows a second for messages of about 700 characters, against the 10 a second the requirements page states), and a search waits up to 1.5 s for its query's vector before falling back to BM25 for 30 s (P3, delta audit: a `cpus` limit and the measured rate in `docs/operations/requirements.md`) |
| A hostile file read for search (C-63, #1382): a zip bomb or a malformed archive in a DOCX, a PDF with a page tree nested to the stack's depth or a font that loops, a CSV with one line of megabytes, a parser exploit | The worker reads a file only in a child process that holds nothing: an empty environment, `node --permission` (no file beyond its own code and `pdfjs-dist`, no write, no child process, no worker), `sandbox.node`'s seccomp filter (no network socket, no `execve`, no `ptrace`, no `io_uring`, no x32 calls, no file opened for writing and no file created, removed, renamed, truncated or re-permissioned, no `pidfd_getfd`), Landlock where the kernel has it (reads only beneath its own code and `pdfjs-dist`, writes nowhere, no abstract Unix socket or signal outside itself) and `setrlimit` for memory, CPU time, file size and open files; the worker itself is not dumpable (`PR_SET_DUMPABLE` 0), so a child of the same user cannot read its environment (the database password, the keyring token), its memory or its descriptors through `/proc`; the child runs at a lower CPU priority; the file comes in on stdin and the text out on stdout. The worker kills it at 20 s, at 320 MiB resident and at 4 MiB of output, and keeps going; a file that fails three times is given up. A DOCX inflates one entry (`word/document.xml`, at most 24 MiB, `maxOutputLength`) of an archive of at most 1,000 entries, never nested; PDF.js runs without `eval`, fonts or images; only 100 pages and 200,000 characters of text are kept. A file of an encrypted space is never opened. Tests run crafted files (`file-text-hostile.test.ts`) | Node's permission model is enforced in JavaScript only; the kernel layer holds without it (no network, no exec, no write, no secret, the limits). Landlock binds the reads of the thread that confines itself and of every thread it starts, not of V8's own threads that already run: a parser exploit that reached native code and took over one of those, or a host without Landlock (Linux before 5.13, or a container runtime that refuses its calls; the child then reads with the rest of the sandbox only), could read what the worker's user may read, the files volume included, and return it as the file's text, searchable in the sender's own space. The sandbox is a defence in depth, not a proof (review of #1421, 2026-11-13). Text of a plain space is stored as search rows, in the database and its backups, like messages |

### B5 Keyring and encrypted spaces

| Threat | Control on `main` | Residual |
| --- | --- | --- |
| A company admin reads an encrypted space | No key for company roles (C-24); delete only; no Add me | Metadata (names, people, times, task status) stays visible by design |
| A database writer plants a key or forges a wrap | Holder MACs, AAD binding, confirmations (F-030) | Not re-proved here; covered by the encryption suites and the reviews of #655 and #976 |
| Key exposure on disk | Keyring in RAM, swap check, no core dumps, `memswap_limit` | A host with unencrypted swap and `FLUX_SWAP_ACKNOWLEDGED` set; raw-disk remnants after a rotation (stated in F-030) |
| Brute force of unlock passwords | Argon2id (64 MiB, t=3, p=4), strength rules, one limiter and semaphore | Throughput of 2 derivations at a time is also a self-inflicted DoS bound (by design) |
| Keyring impersonation | Internal network; bearer compared in constant time (`apps/keyring/src/server.ts:49`) | Single host only, by decision |

### B6 Agent runtime

| Threat | Control on `main` | Residual |
| --- | --- | --- |
| One person's CLI reads another's plan credentials | A user id per person, `0700` directories, no capabilities for CLIs, `PR_SET_DUMPABLE`, Yama ptrace scope ≥ 1 required | Shared network namespace: a person's process can reach another person's loopback ports, and can see command lines (documented in `docs/operations/agent-runtime.md`) |
| Runtime reaches internal services or the LAN | Internal networks with no host address; egress proxy allows only CONNECT to the enabled vendors' hosts on 443, with public addresses only (`apps/runtime/src/egress/server.ts:63-67`); only `/mcp` forwarded to the API | A prompt-injected CLI can still send data to an allowed vendor host, for example through an attacker's own API key at that vendor. This is accepted by design and cannot be closed by a host allow-list |
| Container escape | Read-only root, `no-new-privileges`, six capabilities for the supervisor only, no Docker socket, pids and memory limits | Not tested in this audit |
| Noisy neighbour | Shared memory and `/tmp` limits | One person can push others out (documented) |
| The plan's model list carries something hostile (#1332, #1340) | The supervisor reads the list in the person's own slot under their user id (`claude -p` initialization, Codex `model/list`), and only from the manager with its secret, for the current boot; it reads no credential and logs nothing the CLI prints. Each entry is reduced to a closed shape before it leaves the slot: an id matching `^[a-z0-9][a-z0-9.-]{0,63}$` (never a flag or a path), a name of at most 80 and a note of at most 200 characters without control characters, hidden and Fable models dropped, and for Codex only models of Flux's reviewed catalog (a run's catalog is cut from it); migration 0069 checks the same in the database. The list is shown only to its owner; one plan is read per ten-second tick, and a run of the person's ends a read in progress | Names and notes are the vendor CLI's words (direction controls are not removed; only the owner sees them). Not run with the real CLIs in the delta audit: reviewed by reading and through the suites' fake CLI |

### B7/B8 Providers, web and push

| Threat | Control on `main` | Residual |
| --- | --- | --- |
| SSRF through link cards and web reads | Default ports only; DNS resolved once by the socket's lookup with every answer checked; private, loopback, link-local, CGNAT, NAT64, IPv4-mapped and metadata ranges refused; redirects re-checked; size and time limits (`link-previews/safe-fetch.ts`, `packages/agent-runtime/src/endpoint-policy.ts`). Probe: `127.0.0.1.nip.io` and `169.254.169.254` gave no card, `example.com` did | Data exfiltration in the URL an agent asks for: the check of C-30 refuses verbatim private text (#1065, #1136); rewritten text is the founder's accepted risk. A link card (`FLUX_LINK_PREVIEWS=on`, off by default) fetches a person's link with no such check, and nothing for a line an agent that runs on the server wrote (#1136) |
| SSRF and hostile content through an agent's picture (`flux_attach_image`, #1217) | The web reads' guard unchanged (`link-previews/safe-fetch.ts`): GET, default ports, DNS resolved once and pinned, every answer and every redirect hop (at most 3) re-judged, IPv4-mapped and NAT64 forms refused, 3 s to connect and 10 s in all; C-30's private-text check on the address and each hop; every address asked listed; off with `FLUX_WEB_READS=off`; never in an encrypted space. The body is read only up to 5 MiB (a larger one is refused, not truncated) and only from an `image/*` or `application/octet-stream` answer; the bytes must be a PNG, JPEG, WebP or GIF by signature and parse to the end (SVG and anything else refused); at most 8,000 px on a side and 40 million pixels from the headers, the largest size any of them claims (decompression bombs); one picture to a file (a WebP with two image chunks, a canvas that is not its image's size, a frame outside its canvas, a second PNG header or JPEG frame is refused: decoders draw different ones, #1343); a GIF is as big as its frames' far edges, as Chromium and libvips grow it, and a JPEG of more than 100 scans is refused, as each scan makes the decoder visit every block (review of #1343); the stored file is rebuilt from its drawing chunks (the JPEG markers are an allow-list; an animation's frames bounded together) and every still picture is decoded in full by libvips under the pixel bound and written again with no metadata, so metadata, anything appended after the end (polyglots) and anything a header check and a decoder read differently are gone (`packages/core/src/files/picture.ts`, `apps/server/src/pictures/render.ts`); a person's upload goes through the same canonical form, and the web app draws inline only a file within the bounds by every header size (`drawablePictureType`). Stored through the stored-files path for the asker only, and downloaded like every file: `application/octet-stream`, `nosniff`, `Content-Disposition: attachment`, `CSP: sandbox`; the browser shows it from a blob after checking its signature again | **#1270 part A** (real sockets and the running app): every IPv4/IPv6 literal form (octal, hex, short, IPv4-mapped and -compatible, NAT64, 6to4, Teredo, ULA, link-local, metadata), names that resolve private through real DNS (`127.0.0.1.nip.io`, `localtest.me`) and a hostile resolver, mixed public and private answers, redirects to each of them, a rebinding resolver (public, then 127.0.0.1) and non-default ports were refused with 0 requests reaching a service on loopback; a slow body or slow headers stop at 10 s, an endless or 6 MiB body at 5 MiB, 12 fetches at once give 6 `busy` with the API answering in 5 ms; SVG (as `image/png`, with a BOM, gzipped) and HTML are refused; Ask me first fetched nothing before Approve, extra input keys and another space were refused, a peer's Approve answered 404; `FLUX_WEB_READS=off` answers "tool not found". **Fixed in #1343 (found by the audit as P2): a WebP with two image chunks passed the pixel bound as its last (1×1) chunk while browsers drew the first (16383×16383), 52 bytes that crashed WebKit and Firefox pages and took Chromium to 2.2 GiB; the picture is now one picture to a file and decoded and written again before it is stored, a person's upload included, and a JPEG's markers are an allow-list (the P3 of reserved segments).** C-30 refuses the private text as it was, in another case, percent-encoded and in base64; joined with `_`, `+` or dots, or reordered, it passes (the founder's accepted "rewritten" risk). A site learns the server's address and that someone asked for that picture (as for a page read). The address is checked for private text when the run asks, before anything waits; under Ask me first the run keeps its private text while the picture waits, and the owner's Approve checks the address and every redirect hop against it and lists each address asked (#1217): that text then lives longer than the run, until the picture is decided. The check reads addresses only: words drawn inside a picture, one an agent attaches or one it looks at, are not read for private text. A picture's pixels can carry text that tries to instruct a model that looks at it: data, never an instruction, like a page. Image decoders in browsers and at the model's vendor are out of Flux's reach |
| An agent looks at a picture it may not read (`flux_view_image`, #1217, C-59) | Only a file of a message (not removed) in a conversation the run reaches now (`requireObject`: a space's run its space, a private chat any space of its owner with AI on, a direct message's run none), re-read and checked by its stored hash, rebuilt by `cleanPicture`, at most 5 MB; the words with it say it is data. #1270 A-VIS-1: another space's file from a space run, a removed message's file, an unposted file (the owner's or a peer's), a random id, a space whose AI was just turned off and one the owner just lost were refused; a direct message's run has no tool | The vendor gets the picture `cleanPicture` keeps, which is one picture to a file since #1343 (the audit's two-chunk WebP is refused, where it used to reach the vendor as "1×1"); text drawn in a picture can try to instruct the model |
| An API key leaks while its models are listed (#1218, #1265, #1282) | The key goes only into its provider's own header, to the provider's fixed address (`baseUrl` refused for a named provider); the API sends it only while it is being added, the worker for a stored key (the job carries the id); answers, errors and logs carry the outcome only; the 6-hour list cache is keyed by an HMAC under a per-process secret and keeps only a listed answer; another person's key id answers 404 for Try again, price and delete. #1270 A-KEY-1..4 with marker keys (listed, refused, 5xx, timeout, malformed, wrong provider, over 512 characters, connect, Try again): no answer echoed one, no API or worker log line held one, and no text or JSON column of the database (the pg-boss jobs included) did; the stored row is sealed; an OpenAI-compatible `/models` at metadata, loopback, IPv4-mapped or Compose service addresses was refused | **Fixed in #1347 (P3):** one member with one session could ask the API for OpenAI-compatible listings of a 4 MB `/models` hundreds at a time, within the 1,200-a-minute limit: 240 at once delayed other requests by 3.5 s and peaked at 910 MiB of the API's 1.5 GiB (no crash at 450). Now one listing runs at a time for each person (the same one shares it, another is refused with 429 `MODEL_LIST_BUSY`) and a model list is read up to 1 MB (OpenRouter's 2 MB), a larger answer being "unavailable". The listing also lets a member test keys from the server's address |
| SSRF through an OpenAI-compatible endpoint | The same classifier, `FLUX_AI_PRIVATE_TARGETS` opt-in, metadata always refused, guarded lookup at connect time | Operator configuration |
| SSRF through Web Push endpoints | HTTPS DNS names only; the worker refuses non-public resolutions | None found |
| Provider sees company content | Only what the agent may read goes into a request (C-12); encrypted spaces never have AI; guests have no AI | The provider's retention policy is the person's choice of connection |
| Search returns what the caller may no longer read (F-042) | The BM25 index (`pg_search`) stores no permission: every query receives the audiences the caller may read now from the access policy (`memberFilter` / `visibleFilter`, the space's AI switch for agents) and the index applies them in the same statement, before ranking and the limit; the index follows every insert, edit and delete in the writer's transaction; sealed rows of encrypted spaces have no text and are left out of the index (`tests/app/search-bm25.test.ts`). An agent's `flux_search` and `flux_read_around` (#1324) take the audiences of its owner at the call, the run's place on top (a space's run its space, a direct message's run that direct message only, a private chat or a client every space, never a direct message), and answer one "not found" for a place or message that is missing and one it may not read. #1270 A-SRCH: `in` another space, its conversation or a direct message, `read_around` across spaces and direct messages, `from` an author of another space, operator-looking and over-long queries, AI turned off and a lost grant between calls on the same token: nothing outside the place came back | The index is plaintext on disk and in backups, like `search_documents` and the content it is built from (B4). Ranking used corpus statistics over the whole index: fixed by #1326 and #1400 (rarity and lengths counted over the caller's visible, filtered hits only; `tests/app/search-hidden-ranking.test.ts`). With the optional embeddings the nearest vectors are computed exactly among the same visible, filtered rows (no approximate index); probe at `58c10e9e4` (delta audit, D3, the real bge-m3 container through the people's search API): 30 rows nearer in meaning than anything a reader may see, added with their vectors in a space he is not in, left his answer identical, whole and in one space; a space run's `flux_search` and `flux_summarize` with vectors on stayed in the run's place (`in` another space: `PLACE_NOT_FOUND`). A video's file name is not indexed (the message's words are). An encrypted space's in-memory search weighs a word by its rarity in each visible audience's partition, which still counts a task whose creation was undone (hidden from every reader); that task's words were readable to the same people before the Undo (P3, delta audit) |

### B12 Model output ↔ actions (AI-specific)

| Threat | Control on `main` | Residual |
| --- | --- | --- |
| Indirect prompt injection makes an agent change things | Only the owner prompts (C-13: questions from other agents never change anything); "What it may do"; deletions and other people's things wait; Undo on each agent message; agents never write to GitHub or the web | Under "Do it and tell me" (the default), an injected instruction can still create, edit and move the owner's own things, and post messages where the owner can |
| An agent leaks private text into a shared place | `/ai` in a conversation reads only what that conversation's audience can see (C-12); a task's agents use only what all of the task's people can see (C-10); memory and instructions are never quoted in shared answers (C-8) | A run in the owner's **private** agent conversation can read everything the owner can and is not stopped from posting into a shared conversation. The guarantee is about reads in shared places, not writes from a private run. Not probed: it needs a model run. Worth a design note in `assistant.md` |
| Exfiltration through tools that reach outside | Server agents only read the web; the egress allow-list for CLIs; every address the server asks is listed; an address carrying verbatim private Flux text the run read is refused (C-30), and a redirect hop that adds any beyond the link a person wrote that the read began with; a run's change that writes such an address into Flux is refused (#1138), and a run's answer keeps none (`[address left out]`, #1143); the kept text exists only while the run is in flight (#1136) | What the agent rewrote can leave in an address (accepted by the founder); Codex's `web.run` `open` sends an address the model chose to OpenAI unchecked (read from its cached index, by OpenAI's description); CLIs through allowed vendor hosts (above) |
| An agent approves its own work | No approve tool; owner session only | None found |
| Runaway cost or denial of service | Capacity from memory (F-036 point 12), a daily budget for API keys, result-size bounds per run token; the address check reads a per-run index of the kept text in one pass, behind one gate per API process, yielding to the event loop, and an address or redirect hop longer than 2,048 characters as sent is not read (#1136: #1134's check could hold the API for 22 s; a long redirect `Location` and 40 parallel reads held it for 1.3 s and 2.1 s in the first fix) | Flux sets no limits of its own, by decision. A provider plan's limits are the only brake on a person's agents |
| `flux_summarize` reads beyond the caller (#1292, #1327) | The place is decided by `requireProject` on every call: the owner's current rights, the space's AI switch and the run's place (a space's run only its space, a run in a direct message only that direct message); a task's discussion only through the task's own read; a space's digest leaves out tasks' discussions; an encrypted space is another workspace and never reached. One `PLACE_NOT_FOUND` for missing and forbidden. A message's text is read only in part (2,000 characters for the 500 shown); attachments are counted, never named. Probe at `58c10e9e4` (delta audit, D3): a space run summarizing another space of its owner was refused | What the agent writes from the digest is its own (B12 rows above) |

The four sections below are v0.2.1's audit C of [#1270](https://github.com/ColdPhase/flux/issues/1270), at `96e762b71` (2026-11-13), by an
agent that wrote none of the code. Every row marked "probe" was attacked on a running stack in Docker: the API (two processes on one
database), the worker, a real LiveKit v1.13.11 behind the `/media` gate, a push mock and real Chromium LiveKit clients. The attack plan,
the exploit files and their logs are kept outside the repository with the audit's evidence; the results are on #1270.

### B13 Calls (F-041; #1223, #1230, #1244, #1289, #1299, #1300, #1303, #1330, #1331)

| Threat | Control on `main` | Residual |
| --- | --- | --- |
| Someone outside a space starts, finds, joins or reads its call | Every call route checks `project.read` and the call's place (`live/access.ts`, `requireLiveContext`): start, read, join, discovery, call lines (`/projects/:id/calls`, with `?task=` checked against the space), presentations, the call glyph list (`/live-sessions/spaces`) and invitations. Probe: a company member outside a restricted space, and a guest of another space, got 404 on all eight reads by id and saw no space in the glyph list; a space id given as another place's type, another space's id as "the space", and a task of space A read through space B were 404 | None found |
| A grant used beyond what it was issued for | The grant is a LiveKit JWT of 90 s for one room, `canPublishData`, admin, record, list and create all off; the browser never learns the SFU's address, and the gate admits a connect only with the cookie session that obtained the grant, an unrevoked admission, the same person, current access and the session's current room (`signal-gate.ts`). Probe: the claims read as stated; another person's grant from a valid cookie session was refused ("Media admission denied"); a grant with `roomAdmin` and `canPublishData` set by hand failed the signature at the gate (401); the SFU's own signalling port refused connections from the media network | Any participant, guests included, can publish any source (microphone, camera, screen): that is the feature, and every participant is listed |
| Access ends, the media does not | Removing a person from the space retires the room before the change commits and starts a new generation; sign-out revokes the session's admissions; Leave revokes this device's. Probe: removal while connected disconnected both clients and refused the original and the SFU-refreshed grant (401); sign-out disconnected within 2.3 s and refused both grants; a left admission's grant replayed at the gate got 401 | None found |
| Data or text sent into a call without the right | `canPublishData: false`. Probe: `publishData` (reliable and lossy) and `sendText` resolved in the sender's client, and the other participant received nothing | None |
| Someone told of a call they may not see | `project.live_started.v1` and `project.live_invited.v1` name the space and ids only; the worker tells each person of the event's audience who can read the space at generation time, and push rechecks at delivery. An invitation is accepted only for a recipient who can read the space and the call's place (404 `LIVE_RECIPIENT_NOT_FOUND`, the same for a random id, so it tells a member nothing they cannot see in the space's people). Probe: no notification row and no stream event about the space reached an outsider or a guest of another space; a removed member's Inbox, "Needs you" and invitations held nothing of the lost space, and a call started after the removal told them nothing; another person's invitation answered 404 to a reply | A call's notice names its place: "At “Confidential merger task”" for a call at a task, which every reader of the space may read; on a lock screen it is as private as any message notice (B14) |
| A call in an encrypted space | Its notice is content-free (C-24/F-030): "Ada started a call in Payroll", empty body; the call line holds ids and times only. Probe: a call at a task titled "Fire Bob quietly" gave exactly that title and an empty body; the call line carried no title | Audio and video are encrypted in transit (DTLS-SRTP) and readable in the operator's SFU; nothing is stored ([live media encryption](../development/live-media-encryption.md)). This is within F-030's adversary (a running server's operator) |
| A call kept open by its starter alone | A call nobody but its starter joined ends after 10 minutes, whatever number of the starter's own devices are in it (`lifecycle.ts`). Probe: the starter on two devices, the start moved 11 minutes back: both disconnected at the next sweep and the session went to `ending` | None |
| Notice flooding by a member | At most 3 open calls per starter and 8 per space; join grants 20 a minute per person and API process; one invitation per call and person. Probe: 5 starts gave 201, 201, 201, 422, 422; the space's other person got 3 call notices and 3 invitations | **Fixed in #1347 (P3):** a member's call notice about the same place, and an invitation of the same person to it, is sent once in 5 minutes (`CALL_NOTICE_PAUSE_MINUTES`, F-041); the calls themselves still start. A member can still notice different places, and @mentions, which no rate limit holds either |
| An agent's brief tells of calls in places the run may not read | Only a run in a space's main conversation or a task's discussion gets call events (a thread, a direct message and the private chat get none); people who can no longer read the space are "Former member"; encrypted spaces and guests have no AI (`brief-facts.ts` `callEvents`, `tests/app/ai-brief.test.ts`) | Read, and its suite run; no model was run |

### B14 Notifications, push, last active and read receipts (#1243, #1249, #1225, #1231; #1268, #1273, #1284, #1286, #1310)

| Threat | Control on `main` | Residual |
| --- | --- | --- |
| A notice, a push or an open-tab notice for someone who lost access | The generator checks access when it reads the event, the push job before it sends, the Inbox on every read and `GET /inbox/:id` on a tap; the open-tab notice is an event to the person alone, carrying the notification's id. Probe: with the generator held on its cursor lock, a mention was written and its person removed from the space; after release no row, no push and no notice event reached them; their Inbox was empty and the older notice by id answered 404. Another person's notification by id, its "read" and its notice event: 404, 404, none | None found |
| Muted places and quiet hours bypassed | One rule (`preferences.quiet`) for the generator, the push job and email; quiet hours hold push, email and the open-tab notice, and the Inbox row is stored. Probe: in a muted space a call start and a plain message told nothing; an invitation still arrived (as decided, #1249); in quiet hours a mention made the Inbox row and no push and no notice | None found |
| Push subscription takeover | A subscription belongs to the session that made it; listing and deleting are the owner's (404 to another account); sign-out deletes this device's. Push endpoints are public HTTPS names only: web-push 4 still sends through Flux's public-only lookup agent (probe in the worker: `pushmock`, `localhost` and `127.0.0.1.nip.io` refused as non-public) | **Fixed in #1347 (P3):** registering an endpoint another account holds moves its row only when the request carries the same `p256dh` and `auth` keys, which a shared browser's `PushManager` returns and an outsider does not know (`upsertByEndpoint`; otherwise 409 `PUSH_ENDPOINT_TAKEN`). Before, another account that knew a person's endpoint URL took it over with its own keys, and the person's next mention reached that endpoint not at all: a silent loss of push, no content leak (the endpoint is an unguessable push-service URL) |
| Lock-screen content | The title and body are sent only while the recipient can read the source, otherwise "New activity in Flux"; the payload is encrypted to the device (RFC 8291). Probe: the decrypted payload of a mention held the message's first words | **Closed by the founder's decision (Hubert, 2026-11-13, [#1346](https://github.com/ColdPhase/flux/issues/1346)).** A message's words show on a locked phone by default, as in Slack and WhatsApp, and the contract now says so ([what a notification shows](../product/mobile-pwa.md#what-a-notification-shows)). Settings › Notifications has **Hide previews**: with it on, the payload itself is `{ preview: 'hidden', notificationId, title }`, who and where in fixed words, with no body or link, for every kind of notice (`notification-hide-previews-core.test.ts`, `hide-previews.test.ts`) |
| Last active more precise, or wider, than C-58 says | Rounded by the server in every read that carries it (company people, space people, `space-shell`): probe gave `…:27:00.000Z`; a guest cannot read the company list (403) nor the people of a space they are not in (404); "Show when I was last active" off erased the stored time, later requests wrote none, and no list showed it | **Accepted by the founder (Hubert, 2026-11-13, [#1346](https://github.com/ColdPhase/flux/issues/1346)).** Read receipts tell the author when each reader read their message, also for someone who turned last active off (probe: `"at":"…:27:30.502Z"` for that reader). A receipt is about reading a message, not presence, so it keeps the exact time whatever "Show when I was last active" says; C-58 and the design README record it, and `message-receipt-faces.test.ts` pins it |
| Receipts used to enumerate or forge reading | Only the author of every message of a run may ask, only readers who can read the space now are named, and an observation needs the space (or the DM). Probe: another person's message 422 (`RECEIPT_RUN_INVALID`), an outsider 404, another space's message through one's own space 404, observing a space one cannot read 404; a reader removed from the space left the receipts; DM receipts and observations by a non-participant 404 | None found |

### Session read cache (#1191, #1264) and view-shaped reads (#1109, #1316)

| Threat | Control on `main` | Residual |
| --- | --- | --- |
| A cached session outlives sign-out or revocation | Each API process keeps a cookie value Better Auth verified for at most 5 minutes, and still reads the session row and its person on every request; a row gone, expired or due for renewal goes back to Better Auth (`identity/session.ts`). Probe with both API processes warmed: sign-out on one, the next request on each 401; one session revoked from another, `revoke-others`, and a password change that signs out the other devices, each 401 on both processes at the next request. The stream refused the signed-out cookie on both (401 instead of 101), and an open stream got close code 4401 at its next heartbeat (it revalidates before every delivery, so nothing is sent meanwhile) | None found |
| Cache poisoning | Only a cookie whose token is the session Better Auth returned is kept, keyed by its whole signed value. Probe: an altered signature, another session's token under a valid signature, the token alone and a percent-encoded value: 401; a decoy cookie before the real one resolves the decoy's own session, as Better Auth does; a quoted value resolves to the same person | None found |
| One read returns parts the reader may not see | `space-shell` and `conversation-view` read the space first (its refusal is the answer, #592) and call each part's own use case with the caller's principal; a 423 of a locked encrypted space is the whole answer. Probe: a guest of another space and a person removed from the space got 404 on both reads and on the space; another space's words were never in a view | Private-sketch parts were read, not probed: a private sketch cannot name a space |


### B10 GitHub, B11 operator, supply chain

| Threat | Control on `main` | Residual |
| --- | --- | --- |
| Forged GitHub webhooks | Webhook secret required with the App; read-only App permissions | Not re-tested in this audit |
| Leaked `.env` | Mode 600, rotation guidance, secrets in separate files for OIDC and the background key | Operator practice |
| Test switches on a server | Fixture routes need `FLUX_FIXTURE_TOKEN`; failure injection only with it set too; probe: `/api/v1/test/routes` without the token answered 401 | The source checkout's `./flux up` generates a fixture token; a server must use the release image ([hardening](../operations/hardening.md)) |
| Malicious or vulnerable dependency | Frozen lockfile, actions and base images pinned by SHA and digest, Dependabot, Trivy, CodeQL, dependency audit, SBOM and attestation in the release workflow | Image signing: [#840](https://github.com/ColdPhase/flux/issues/840). Two patched upstream packages (`app/patches`) need review on each upgrade |

### Release, upgrade and dependencies (v0.2.1 audit C; #1241, #1240)

| Threat | Control on `main` | Residual |
| --- | --- | --- |
| A workflow token or input abused | No `pull_request_target`, `workflow_run` or comment trigger; the default token is read-only; every workflow sets `contents: read` and raises only per job (`packages`/`id-token`/`attestations: write` to build and sign, `contents: write` only to draft); every input reaches a script through `env`, never `${{ }}` inside `run`; release and publish workflows are dispatched by hand from `main` and check the exact SHA, the version and an independent acceptance | Repository admins can bypass `main`'s ruleset (fast mode, by founder direction) |
| Release artifacts swapped | Published releases are immutable (GitHub's immutable releases are on; v0.1.0 and v0.2.0 are immutable, read 2026-11-13), so their tags and assets cannot change; images are signed keylessly with cosign and attested; the upgrade matrix checks each release's assets against its `SHA256SUMS` | `SHA256SUMS` is checked against the same release, not a signature: immutability is what protects it |
| A released migration edited | `scripts/release/check_released_migrations.py` compares every migration with its release tag and refuses a new one numbered at or below the last released; repository checks run it with the tags (`fetch-tags`). Run: "byte-identical to their tags (v0.2.0)". Tags of published releases are immutable | The migrator's ledger keeps names, not hashes, so only CI stands between an edited migration and an instance |
| New majors (#1240) | Anthropic SDK 1.6 sends the key as `Authorization: Bearer` to the fixed vendor base URL, with an explicit key (`authToken: null`), so no environment variable or profile is read (whether an SDK error can quote the header was read in the adapter, not probed). web-push 4 keeps the `agent` option, so the public-only lookup still applies (probe above). Playwright 1.65 and ESLint 10 are test and build tools only. `pnpm audit --prod`: 0 HIGH/CRITICAL; `pnpm audit` with dev dependencies: 2 moderate (esbuild through drizzle-kit's dev server, minimatch through typescript-eslint), neither in the running application | None found |

## v0.2.1 audit, part B (#1270): previews, pictures, downloads

An independent agent (none of the audited code was its own) attacked the candidate `96e762b71` (2026-11-13) running in Docker as a test
deployment, with real browsers (Playwright 1.65: Chromium's headless shell, Chromium with its PDF viewer, which is the build closest to
Chrome, and WebKit) and an attacker container that logged every DNS query, TCP connection and STUN packet. The rows of B1 above record
the controls and what each attempt showed. The attack plan, scripts and logs are kept outside the repository with the audit
(`~/flux-evidence/v021/audit-b/`).

| Finding | Severity | Where it is recorded |
| --- | --- | --- |
| WebKit opens a connection for a preconnect hint inside `<iframe srcdoc>` of a still HTML preview: opening a file tells the host it was read | P2 | [#1349](https://github.com/ColdPhase/flux/issues/1349) |
| A click on a link inside a PDF preview replaces the Flux tab in Chrome | P2 | [#1350](https://github.com/ColdPhase/flux/issues/1350) |
| Chrome resolves and connects (no request) for a link a person clicks in a still preview, or a frame a script navigates or adds | P3 | B1, file previews |
| Run scripts: WebRTC and (WebKit) a script-made preconnect reach the internet; a spinning script freezes the tab in WebKit | P3, known | B1, file previews; the preview's note |
| A picture already in a browser's cache stays there for a year after its reader loses access | P3, by design | B1, pictures |

Automated checks at `96e762b71`:

- **DAST** (`scripts/check_dast.sh`, ZAP 2.17.0, baseline plus active API scans signed in as the owner and a member): 312 routes listed,
  297 operations scanned, now including the previews (a real file and the frame headers), the photo, icon and file uploads (raw bytes),
  receipt readers, search, model lists and calls (the stack now runs LiveKit, without which the call routes do not exist). One new
  Medium pair, `script-src 'unsafe-inline' 'unsafe-eval'` on a preview with Run scripts, is C-60's decision and is recorded for that url
  only (`scripts/dast/zap-rules.conf`). After triage: 0 to triage.
- **CodeQL** (dispatched on `main` at the candidate): 51 results. The two new since v0.2.0 are false positives: `js/missing-origin-check`
  on the preview's dedicated worker (only the page that made it can post to it) and `js/file-access-to-http` in the runtime's test fake CLI.
- **Dependency audit** (`scripts/security_scan.py audit`): 1 advisory in production dependencies, none HIGH or CRITICAL.
- **Image scan** (`scripts/security_scan.py image --local`, Trivy, the release policy): the candidate's three release images built
  locally for amd64 (`runtime`, `agent-runtime-release`, the database image) have 0 HIGH or CRITICAL findings with a fix; the
  database image's Debian 13.7 base has 122 without a fix (reported only). The weekly scan of the published v0.2.0 images failed on
  2026-11-10 (141 fixable, before #1240's upgrades); the release workflow scans the v0.2.1 images again when it builds them.
- **Secret scan** of `v0.2.0..96e762b71` (59 commits): gitleaks 8.21.2 found none; trufflehog 3.88.0 found one unverified match, the
  throwaway `bench:bench` database address of the retrieval benchmark's compose file (`scripts/eval/retrieval/compose.yaml`), not a secret.

## v0.2.1 delta audit (#1270): videos, embeddings, plan models, summaries

An independent agent (none of the audited code was its own) audited what landed on `main` between `96e762b71` and `58c10e9e4`
(2026-11-13): #1340, #1326 and #1400, #1341, #1391 and #1393, #1327, #1355, #1389 and #1385. Every feature had had an adversarial review
when it was merged, so the audit attacked what those reviews leave out. These were: interactions between the features, the people the
suites do not try on each new route, the 2 vCPU target under load, new log lines, and the migrations on v0.2.0 data. The stack was its
own Compose project of `58c10e9e4` with the real embedding container (text-embeddings-inference with bge-m3). The database, API, worker
and that container were pinned to the same two cores, with the operator's largest video cap (1,024 MiB) and the production pool timeout.
The exploit files and logs are kept outside the repository (`~/flux-evidence/v021/audit-delta/`). The rows above record what each
attempt showed.

| Finding | Severity | Where it is recorded |
| --- | --- | --- |
| Sending videos at once holds every database connection of an API process while each whole video is hashed inside its transaction; sends and other people's requests answer 500 | P2 | [#1411](https://github.com/ColdPhase/flux/issues/1411); B1, videos |
| The embedding container has no CPU limit and its backfill is far slower than the requirements page says (0.35 rows a second on two cores for messages of about 700 characters) | P3 | B4, embeddings |
| An encrypted space's in-memory any-word search still counts an undone task in a word's rarity | P3 | B4, search |

What held, in short: the new file routes for a guest of another space, a member outside the space, another company, a removed person and a
locked encrypted space (404 or 423); 25 hostile ranges (never 5xx, bytes exact); hidden rows near in meaning, with their vectors (no
change to a reader's answer); a space run's search and summary with vectors on (only its place); video names (not indexed); log lines (no
text, no cookie value). Seeding 1,000 messages eight at a time on the two cores gave 1 answer 500 (a 2 s statement timeout) with the
embedding container busy and none with it stopped, so that difference is not counted as a finding.

Automated checks at `58c10e9e4`:

- **DAST** (`scripts/check_dast.sh`, ZAP 2.17.0: a baseline scan, then active API scans signed in as the owner and as a member): 315
  routes listed and 300 operations scanned. This now includes #1352's routes, each with a real id: a sent video's playback route and a
  stored file read with a `Range`, the poster of a staged video (raw bytes) and the file limits. #1340 adds no route; its list goes out
  through `/api/v1/personal-assistant/model`, which is scanned. After triage: **0 to triage**, 0 tracked, 1 accepted risk (`style-src
  'unsafe-inline'`), 26 low or informational. The 37 server-error instances per person are the GitHub and push routes of a stack that
  configures neither, as before; none is on a new route.
- **CodeQL** (dispatched on `main` at `58c10e9e4`, [run](https://github.com/ColdPhase/flux/actions/runs/43412260961)): 46 open alerts. They
  are the same 46 as at `96e762b71`; none is new.
- **Dependency audit** (`scripts/security_scan.py audit`): 1 advisory in production dependencies, none HIGH or CRITICAL.
- **Secret scan** of `96e762b71..58c10e9e4` (6 squashed commits): gitleaks 8.21.2 found none. trufflehog 3.88.0 (no verification)
  found one match, the password of a throwaway tuning database in a research script
  (`docs/product/research/evidence/1387/tuning/run-ranked.sh`). It is not a secret.
- **Migrations 0068, 0069 and 0071 on v0.2.0 data**: the release's upgrade matrix (`scripts/check_upgrade_matrix.sh`, run for v0.2.1 on
  2026-11-13) passed v0.2.0 to the candidate by release installation and by source checkout, with the data read back and new work
  accepted. A breaking migration numbered 0072 stopped the upgrade, and the backup restored. 0068 and 0069 only add tables, columns and
  triggers. 0071 replaces three checks of `project_files` with checks that are identical for a row without a video.

## Top risks, in plain words

1. **Recovering a stolen account** ([#989](https://github.com/ColdPhase/flux/issues/989), P2) was incomplete: a client connected from a
   borrowed browser session kept acting with all the owner's rights after a password reset. It is fixed: a reset, and signing out the other
   devices, disconnect the person's clients.
2. **Weak passwords were accepted, and guessing was only slowed per address** ([#990](https://github.com/ColdPhase/flux/issues/990), P2).
   It is fixed: 12 characters, no common password, and a per-account back-off shared by every API process that a stranger cannot use to lock the owner's browser out. A server on the internet is still
   better served by single sign-on with the identity provider's MFA.
3. **Prompt injection meets a default of "Do it and tell me".** An agent acts with its owner's rights.
   Text from other people, web pages or GitHub can steer what it does within those rights, and a private run
   can post what it read where others see it. The waiting rules and Undo limit the damage; they do not stop it.
   This is a design-level risk, not a defect.
4. **Web reads can carry data out in a URL** ([#953](https://github.com/ColdPhase/flux/issues/953)). Since the founder's direction of
   2026-11-09 (#1065, C-30) an agent may open any address; the server refuses one that carries private Flux text the run read, as it was,
   percent-encoded or in a hex, base64 or base32 run, and each redirect hop that adds any (#1136); what the agent rewrote can still leave.
   The founder accepted that risk. With `FLUX_LINK_PREVIEWS=on` a link card is fetched for a person's message without that check, and never
   for a line an agent that runs on the server wrote.
5. **A picture from the web could crash the readers' tabs** ([#1343](https://github.com/ColdPhase/flux/issues/1343), P2, found by #1270).
   A 52-byte WebP passed the picture check as 1×1 and decoded to 16383×16383; once shown to everyone, it crashed or stalled the tab of
   every member who opened that conversation. It is fixed: every stored picture, a person's upload as well, is decoded and written again by
   libvips under the 40 megapixel bound after a walk that refuses a file with more than one image or sizes that disagree, and the web app
   draws inline only a picture within the bounds by every size its headers claim.

## What this audit could not verify

- Prompt-injection behaviour of real models; no model was run. The mock providers do not exercise judgement.
- The agent runtime with real vendor CLIs and the container-escape surface. The runtime needs
  `FLUX_AGENT_RUNTIME`, vendor sign-ins and `kernel.yama.ptrace_scope ≥ 1`, which this audit host does not have.
- The GitHub App and webhooks, and OIDC back-channel logout. They were read, not run. Live media (a real LiveKit, ICE without TURN)
  and Web Push delivery (to a mock push service) were run by v0.2.1's audit C (#1270); TURN relays and real push services were not.
- The cryptography of encrypted spaces beyond reading its use of primitives. Its own suites and reviews
  cover it, and an external review is recommended below.
- Object-level authorization across all routes: [#839](https://github.com/ColdPhase/flux/issues/839).
- TLS configuration: the operator's reverse proxy terminates TLS.
- #1270 part A: the image decoders at a model vendor; Safari on a real phone (WebKit in Docker crashed on the file of #1343, now refused); plan model lists
  read from the CLIs (PR #1340, not merged at `96e762b71`); a guest's model listing (covered by the API suite of #995, not re-run).
- The v0.2.1 delta audit: plan model lists read from the real Claude Code and Codex (reviewed by reading and through the suites' fake CLI;
  the audit host has no vendor sign-in); real players' media stacks with a hostile video (the browser decodes it); a real reverse proxy's
  own timeouts in front of a 20-minute upload.
- Safari's and Firefox's own PDF viewers, and Firefox at all, for the previews of #1252: the v0.2.1 audit (#1270, part B) used
  Playwright's Chromium, Chromium with its PDF viewer and WebKit, which draws no PDF.

## External human audit (decision for #837)

**Recommendation (agent decision under the delegated authority, for the coordinator to record):**
commission an external human penetration test and cryptography review **before Flux is offered for
production use by companies (v1.0)**, not before v0.2. v0.2 is pre-release with no installations
(founder direction 2026-10-31). The automated and agent reviews (#837, #838, #839) cover the
application level well. What they cannot replace is an expert reading of F-030's key hierarchy and
an adversarial test of the agent and MCP surface with real models.

Proposed scope, about 10 to 15 person-days:

1. Encrypted spaces: key hierarchy, holder MACs, rotation, recovery code, keyring protocol (F-030, C-24 to C-27).
2. Authentication and OAuth: Better Auth configuration, the two local patches in `app/patches`,
   CIMD clients, one-click consent, refresh rotation, SSO linking and back-channel logout.
3. Agents and local clients: prompt injection with real models, exfiltration paths, the owner-only
   approval guarantee, and the runtime's per-uid isolation and egress.
4. Authorization regression across spaces, guests and company roles, starting from the results of #839.

Re-open the question if Flux gets a hosted offering, a paying customer, or a change to the cryptography.

## Keeping this document current

Update it in the change that adds a boundary (a new service, an outbound fetch, a new token type), a new
actor or role, or a new way for agents to act. Re-run the ASVS review before each release.
