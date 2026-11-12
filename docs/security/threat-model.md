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
  audience rule C-12 matters more).

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

## Assets

| Asset | Where | Why it matters |
| --- | --- | --- |
| Company content: messages, DMs, tasks, maps, Wiki, decisions, files | PostgreSQL, files volume | The product's reason to exist. DMs and private spaces carry the most sensitive text |
| Encrypted-space content and keys | Sealed columns and files, `encryption_*` tables, `workspace_unlocks`, keyring RAM | Promised to be unreadable to the company admin and the database |
| Credentials | `auth_accounts` (scrypt hashes), `auth_sessions`, OAuth tokens, `.env` secrets (`FLUX_AUTH_SECRET`, `FLUX_KEY_PIN_SECRET`, DB password, VAPID key) | Account takeover; signing invites, cursors and JWTs |
| AI credentials | API keys sealed under the background key; Claude and Codex plan credentials on the runtime volume | Spending a person's plan or money; impersonating them at the vendor |
| Agent identities and their "What it may do" | `agents`, `agent_connections` | An agent acts with its owner's rights |
| Company membership and roles | `workspace_members`, project grants | Who can see and manage what |
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
| Clickjacking of consent and approvals | `X-Frame-Options: DENY` and `frame-ancestors 'none'` on every response (`http/framing.ts`) | None |
| Stored XSS (messages, Wiki, file names, link cards) | React escaping; Wiki Markdown rendered by markdown-it with `html:false` and sanitize-html with an allow-list (`docs/markdown.ts`); links limited to http, https and mailto; files served as `attachment` with `sandbox` CSP and `nosniff` | A script Content-Security-Policy limits the damage of a future XSS: the pages run only Flux's own scripts and the hashed inline ones, and connect nowhere but to their own origin (`http/content-security-policy.ts`, [#979](https://github.com/ColdPhase/flux/issues/979)). Styles may still be inline. |
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

### B7/B8 Providers, web and push

| Threat | Control on `main` | Residual |
| --- | --- | --- |
| SSRF through link cards and web reads | Default ports only; DNS resolved once by the socket's lookup with every answer checked; private, loopback, link-local, CGNAT, NAT64, IPv4-mapped and metadata ranges refused; redirects re-checked; size and time limits (`link-previews/safe-fetch.ts`, `packages/agent-runtime/src/endpoint-policy.ts`). Probe: `127.0.0.1.nip.io` and `169.254.169.254` gave no card, `example.com` did | Data exfiltration in the URL an agent asks for: the check of C-30 refuses verbatim private text (#1065, #1136); rewritten text is the founder's accepted risk. A link card (`FLUX_LINK_PREVIEWS=on`, off by default) fetches a person's link with no such check, and nothing for a line an agent that runs on the server wrote (#1136) |
| SSRF and hostile content through an agent's picture (`flux_attach_image`, #1217) | The web reads' guard unchanged (`link-previews/safe-fetch.ts`): GET, default ports, DNS resolved once and pinned, every answer and every redirect hop (at most 3) re-judged, IPv4-mapped and NAT64 forms refused, 3 s to connect and 10 s in all; C-30's private-text check on the address and each hop; every address asked listed; off with `FLUX_WEB_READS=off`; never in an encrypted space. The body is read only up to 5 MiB (a larger one is refused, not truncated) and only from an `image/*` or `application/octet-stream` answer; the bytes must be a PNG, JPEG, WebP or GIF by signature and parse to the end (SVG and anything else refused); at most 8,000 px on a side and 40 million pixels from the header (decompression bombs); the stored file is rebuilt from its drawing chunks (a bare JFIF header, the ICC profile and Adobe's colour transform are the only JPEG APPn kept; one start-of-frame; an animation's frames bounded together), so metadata and anything appended after the end (polyglots) are gone (`packages/core/src/files/picture.ts`). Stored through the stored-files path for the asker only, and downloaded like every file: `application/octet-stream`, `nosniff`, `Content-Disposition: attachment`, `CSP: sandbox`; the browser shows it from a blob after checking its signature again | A site learns the server's address and that someone asked for that picture (as for a page read). The address is checked for private text when the run asks, before anything waits; under Ask me first the run keeps its private text while the picture waits, and the owner's Approve checks the address and every redirect hop against it and lists each address asked (#1217): that text then lives longer than the run, until the picture is decided. The check reads addresses only: words drawn inside a picture, one an agent attaches or one it looks at, are not read for private text. A picture's pixels can carry text that tries to instruct a model that looks at it: data, never an instruction, like a page. Image decoders in browsers and at the model's vendor are out of Flux's reach |
| SSRF through an OpenAI-compatible endpoint | The same classifier, `FLUX_AI_PRIVATE_TARGETS` opt-in, metadata always refused, guarded lookup at connect time | Operator configuration |
| SSRF through Web Push endpoints | HTTPS DNS names only; the worker refuses non-public resolutions | None found |
| Provider sees company content | Only what the agent may read goes into a request (C-12); encrypted spaces never have AI; guests have no AI | The provider's retention policy is the person's choice of connection |
| Search returns what the caller may no longer read (F-042) | The BM25 index (`pg_search`) stores no permission: every query receives the audiences the caller may read now from the access policy (`memberFilter` / `visibleFilter`, the space's AI switch for agents) and the index applies them in the same statement, before ranking and the limit; the index follows every insert, edit and delete in the writer's transaction; sealed rows of encrypted spaces have no text and are left out of the index (`tests/app/search-bm25.test.ts`) | The index is plaintext on disk and in backups, like `search_documents` and the content it is built from (B4) |

### B12 Model output ↔ actions (AI-specific)

| Threat | Control on `main` | Residual |
| --- | --- | --- |
| Indirect prompt injection makes an agent change things | Only the owner prompts (C-13: questions from other agents never change anything); "What it may do"; deletions and other people's things wait; Undo on each agent message; agents never write to GitHub or the web | Under "Do it and tell me" (the default), an injected instruction can still create, edit and move the owner's own things, and post messages where the owner can |
| An agent leaks private text into a shared place | `/ai` in a conversation reads only what that conversation's audience can see (C-12); a task's agents use only what all of the task's people can see (C-10); memory and instructions are never quoted in shared answers (C-8) | A run in the owner's **private** agent conversation can read everything the owner can and is not stopped from posting into a shared conversation. The guarantee is about reads in shared places, not writes from a private run. Not probed: it needs a model run. Worth a design note in `assistant.md` |
| Exfiltration through tools that reach outside | Server agents only read the web; the egress allow-list for CLIs; every address the server asks is listed; an address carrying verbatim private Flux text the run read is refused (C-30), and a redirect hop that adds any beyond the link a person wrote that the read began with; a run's change that writes such an address into Flux is refused (#1138), and a run's answer keeps none (`[address left out]`, #1143); the kept text exists only while the run is in flight (#1136) | What the agent rewrote can leave in an address (accepted by the founder); Codex's `web.run` `open` sends an address the model chose to OpenAI unchecked (read from its cached index, by OpenAI's description); CLIs through allowed vendor hosts (above) |
| An agent approves its own work | No approve tool; owner session only | None found |
| Runaway cost or denial of service | Capacity from memory (F-036 point 12), a daily budget for API keys, result-size bounds per run token; the address check reads a per-run index of the kept text in one pass, behind one gate per API process, yielding to the event loop, and an address or redirect hop longer than 2,048 characters as sent is not read (#1136: #1134's check could hold the API for 22 s; a long redirect `Location` and 40 parallel reads held it for 1.3 s and 2.1 s in the first fix) | Flux sets no limits of its own, by decision. A provider plan's limits are the only brake on a person's agents |

### B10 GitHub, B11 operator, supply chain

| Threat | Control on `main` | Residual |
| --- | --- | --- |
| Forged GitHub webhooks | Webhook secret required with the App; read-only App permissions | Not re-tested in this audit |
| Leaked `.env` | Mode 600, rotation guidance, secrets in separate files for OIDC and the background key | Operator practice |
| Test switches on a server | Fixture routes need `FLUX_FIXTURE_TOKEN`; failure injection only with it set too; probe: `/api/v1/test/routes` without the token answered 401 | The source checkout's `./flux up` generates a fixture token; a server must use the release image ([hardening](../operations/hardening.md)) |
| Malicious or vulnerable dependency | Frozen lockfile, actions and base images pinned by SHA and digest, Dependabot, Trivy, CodeQL, dependency audit, SBOM and attestation in the release workflow | Image signing: [#840](https://github.com/ColdPhase/flux/issues/840). Two patched upstream packages (`app/patches`) need review on each upgrade |

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

## What this audit could not verify

- Prompt-injection behaviour of real models; no model was run. The mock providers do not exercise judgement.
- The agent runtime with real vendor CLIs and the container-escape surface. The runtime needs
  `FLUX_AGENT_RUNTIME`, vendor sign-ins and `kernel.yama.ptrace_scope ≥ 1`, which this audit host does not have.
- Live media (LiveKit/TURN), the GitHub App and webhooks, OIDC back-channel logout, and Web Push
  delivery. They were read, not run.
- The cryptography of encrypted spaces beyond reading its use of primitives. Its own suites and reviews
  cover it, and an external review is recommended below.
- Object-level authorization across all routes: [#839](https://github.com/ColdPhase/flux/issues/839).
- TLS configuration: the operator's reverse proxy terminates TLS.

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
