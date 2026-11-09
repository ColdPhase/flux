# OWASP ASVS 4.0.3 Level 2 review

The checklist of the independent security audit [#837](https://github.com/ColdPhase/flux/issues/837), run on
`main` at `5d22020ea` on 2026-11-08. It was written by an agent that did not write the audited code. The
assets, actors and boundaries it refers to are in the [threat model](threat-model.md).

## How to read it

- **Result:** **Pass**, **Fail**, **Partial** (part of the requirement holds), **N/A** (the feature does not
  exist in Flux) or **Not verified** (it applies, but this audit could not check it).
- **Evidence:** `file:line` paths are relative to `app/` unless they start with `docs/` or `docker/`.
  **Probe** marks a request made against a running stack. The stack was `docker/compose.source.yaml`
  with its own Compose project (audit-837) on port 24650. `FLUX_AUTH_RATE_LIMIT`, `FLUX_SIGNUP` and the
  other security switches kept their defaults; `FLUX_LINK_PREVIEWS=on` and `FLUX_WEB_READS=on` were set,
  and the test deployment's fixture token was present. Inspection-only results say so.
- **Out of scope here:** object-by-object authorization is the pentest of
  [#839](https://github.com/ColdPhase/flux/issues/839). Dynamic scanning is [#838](https://github.com/ColdPhase/flux/issues/838).
  This review only notes where they apply.
- Requirements that are Level 3 only, and chapters with no matching feature (V11 business logic is
  covered by the product contracts, not here), are left out. Every Fail and Partial links its issue.

## Findings of this audit

| Issue | Severity | Requirement | Summary |
| --- | --- | --- | --- |
| [#989](https://github.com/ColdPhase/flux/issues/989) | **P2** | 3.3.3, 3.5.1 | A password reset or "sign out everywhere" leaves local MCP clients connected with the owner's rights (probed). **Fixed:** both disconnect the person's clients ([how](#fixes-after-the-audit)) |
| [#990](https://github.com/ColdPhase/flux/issues/990) | **P2** | 2.1.1, 2.1.7, 2.2.1 | 8-character and common passwords accepted; sign-in throttled only per IP and process (probed). **Fixed:** 12 characters, a common-password list and a per-account back-off in PostgreSQL ([how](#fixes-after-the-audit)) |
| [#991](https://github.com/ColdPhase/flux/issues/991) | P3 | 7.4.1 | Generic error messages | Pass (fixed) | Audit finding: `useDomainErrors` re-threw unexpected errors to Fastify's default handler, which answered `error.message` (**probe:** the injected body came back). Now it answers `500 {"error":"Internal Server Error","code":…}` for every error that is not a domain refusal, a 401 or a Fastify 4xx ([#991](https://github.com/ColdPhase/flux/issues/991); `tests/app/encryption-sealed-content.test.ts`) |
| [#992](https://github.com/ColdPhase/flux/issues/992) | P3 | 8.2.1, 14.4.4 to 14.4.6 | No `nosniff`, Referrer-Policy, `no-store` on API JSON, or HSTS guidance (probed). **Fixed:** the API sends them; HSTS for an https origin |
| [#993](https://github.com/ColdPhase/flux/issues/993) | P3 | 3.3.2, 3.7.1 | Sign-up reveals registered addresses; 7-day sliding sessions with no absolute limit (probed). **Fixed in part:** limits are settable and 30 days absolute; `verified` sign-up hides the address, `open` is an accepted risk; re-authentication for risky actions is not done ([how](#fixes-after-the-audit)) |
| [#994](https://github.com/ColdPhase/flux/issues/994) | P3 | 14.1.3 | Server configuration hardened | Pass (fixed) | `docs/operations/hardening.md`; non-root, loopback-only port. Audit finding: a newly exposed server was claimable by its first sign-up. Now the install guides create the owner before the address is public, and `./flux up` and the API log warn while nobody has signed up on a public address ([#994](https://github.com/ColdPhase/flux/issues/994)) |
| [#997](https://github.com/ColdPhase/flux/issues/997) | P3 | 7.1.3, 7.2.1, 7.2.2 | No security event log for failed sign-ins, refusals and consent decisions (probed). **Fixed:** one `channel: security` line per event ([events](../operations/monitoring.md#security-events)) |

These issues were already open and are referenced, not filed again:
- [#953](https://github.com/ColdPhase/flux/issues/953) and PR #983 (web-read exfiltration, 12.6.1), since followed by #1065 and #1136 (C-30)
- [#959](https://github.com/ColdPhase/flux/issues/959) and [#978](https://github.com/ColdPhase/flux/issues/978) (guests and non-members connecting AI or clients, 4.1.3)
- [#840](https://github.com/ColdPhase/flux/issues/840) (image signing, 10.3.1, 14.2)

No P1 was found.

## Fixes after the audit

What was decided when the two P2 findings were fixed (2026-11-08). Each stays here so a later review can see why.

- **#989, a recovery ends the clients.** A password reset, a password change that signs out the other devices, and "Sign out all other devices"
  disconnect every local client of the person: each connection is revoked exactly as the Disconnect button does it, its runtime
  sessions end, and every OAuth refresh token and access token of the person is revoked. The alternative, keeping the connections so
  that a fresh sign-in finds them with no page (C-20), was refused: it would let a client made from a stolen session be re-allowed
  silently when the owner next opens a link of that client. With the connection revoked, the next sign-in of a client asks on the consent
  page (C-19) and gets the same agent back (C-20), so what was assigned to it stays. The owner's own assistant is not a client and is not
  touched. Better Auth's `/revoke-sessions` and `/revoke-other-sessions` are disabled (Flux ends sessions through `/api/v1/sessions`).
  Ending one single session does not disconnect clients: Flux does not record which session authorized a client.
- **#990, passwords.** At least 12 characters (V2.1.1) and at most 128, as before. A password on the common-password list of
  `@zxcvbn-ts/language-common` (49,233 entries, V2.1.7 asks for 3,000) or estimated under 10^8 guesses is refused, with the person's
  own name and address counted as known words. The list ships with the server: no password or hash leaves the process, unlike a call to a
  breached-password service. No composition rules (V2.1.9).
- **#990, guessing.** Better Auth's per-address limiter now uses its `database` storage, so `api` and `api2` count together, and an IPv6
  address counts as its /64 (the pinned Better Auth does this by default). Each account also backs off by itself: the first five attempts
  cost nothing, then the account refuses sign-in for 30 seconds, then 1, 2, 4 and 8 minutes, and at most 15 minutes from the tenth on,
  whatever the client address. A success, a password reset or an hour without an attempt starts the count again. Every attempt is counted
  before the password is checked, so parallel guesses cannot all pass a stale count. The same count covers the current password asked by
  change-password and change-email, so a session left open cannot be used to guess it. An address nobody holds is counted and slowed the
  same way. The refusal says "a few minutes" and sends no `Retry-After`, so the end of a wait cannot be timed.
  **A stranger cannot lock the owner out** (review finding B1 on #1011, OWASP device cookies): a browser that has signed in to the account,
  created it or finished its password reset keeps a signed `flux.device` cookie (HttpOnly, SameSite=Lax, 400 days, up to eight accounts
  as keyed hashes; `Secure` over HTTPS). That browser counts in a wait of its own (this account on this browser), so guesses from anywhere
  else never refuse it, and its own wrong guesses slow only itself. A guess without a valid cookie for that account (none, altered, or
  won on another account) counts in the account's wait. The cookie is not a credential: with it the password is still needed, and it
  is guessed at in the same five-then-wait bucket. What remains: a stranger who knows an address can keep a browser that has never
  signed in to it (a new device, cleared cookies) waiting for up to 15 minutes at a time. The reset mail is the way back, the browser
  that finishes the reset is remembered, and a reset clears the account's wait. MFA stays the identity provider's job (see 2.2.x).
  **A copied cookie does not outlive a recovery** ([#1031](https://github.com/ColdPhase/flux/issues/1031)): the cookie names an account by a keyed
  hash of its address and the account's *device generation* (`auth_users.device_generation`, migration 0036). A password reset, a password
  change that signs out the other devices and "Sign out all other devices" raise it, so a copy taken before then names an older generation and
  counts in the account's wait like any stranger. The browser that did the reset, or the password change with sign-out, is given a cookie with
  the new generation in the same answer (it proved the mailbox or the password). The browser that pressed "Sign out all other devices" keeps
  the cookie it had, given again at the new generation (same device); a browser that has only a session gets none, because a session does not
  prove the password and a cookie would give it a wait of its own to guess in (review of #1044). Older generations' keys leave the cookie when
  it is given again. The sign-out raises the generation only if it is still the value it checked (and its session is still there), and gives a
  cookie only when that raise matched; a reset raises it again once its sessions are gone and writes the cookie for that raise. So a sign-out that
  raced a reset cannot leave a cookie that counts after it ([#1067](https://github.com/ColdPhase/flux/issues/1067)). A plain password change that keeps
  the other devices leaves the cookie as it was. Two sign-outs at the same moment from two sessions raise the generation before they delete the
  other sessions, so deleting each other's session first cannot leave it unraised.
  **A password check that a reset overtakes creates nothing** ([#1088](https://github.com/ColdPhase/flux/issues/1088)): Better Auth verifies a password
  against the hash it read and then creates the session (or writes the new hash) without looking again, so a sign-in or a password change that was
  already running with the old password could outlive a reset, or put the old password back. The check now remembers the hash it accepted, in memory, for
  the rest of the request. A trigger bumps `auth_accounts.password_version` on every write of the password; the session insert and the password
  write carry the version of the row whose hash was accepted (`auth_sessions.password_version_checked`, `auth_accounts.password_version_expected`,
  migration 0042), and the triggers refuse them unless the credential account is still at that version, under the row lock, in the same
  statement. A write with no check (a reset) also ends every session of the account in that statement, because Better Auth deletes the sessions
  just before it writes. The carried value is a counter, cleared by the trigger before the row is stored: **a password hash is never a
  parameter of a statement that can fail on the check** (review of #1093: drizzle quotes a failed statement with its parameters, and Better
  Auth's router and better-call printed the error, so a refused request put the hash in the API log four times). The write of the new hash
  itself still carries it, so `onAPIError: { throw: true }` keeps every error that is not Better Auth's own out of both loggers and sends it to
  Flux's error handler, which logs only the class, the SQLSTATE and the constraint (#991). Better Auth's own log lines (a sign-up that lost a race
  with the same address logged the failed insert with its email and name) go to Flux's logger through a handler that reduces an error to those
  three and replaces an address in a line's text. A sign-in that loses to a reset after its session row was written is answered 401, like the
  other refused sign-ins. `check_application.sh` looks for a password hash (`<32 hex>:<128 hex>`, `$argon2`, `$2a$`) and for the address and name
  of the log tests in the API, API 2, worker and provider-mock logs after the named test files and after the full suite. The hook refuses
  first when the new hash is already visible, with "Invalid email or password"; a request that loses the race inside the statement gets the generic error.
- **#991, errors.** Every error that is not a domain refusal, a 401 or a Fastify 4xx answers `500` with a class code and logs only the
  redacted error. The encrypted-space rule of F-030 now holds for every space, so there is one path to keep correct, not two.
- **#992, headers.** `nosniff`, `Referrer-Policy: same-origin`, `no-store` for `/api/` answers that set no rule of their own, and HSTS
  (`max-age=31536000`, no `includeSubDomains`, no `preload`) from the API when the public origin is https. The script policy is #979.
- **#993, sessions and sign-up.** `FLUX_SESSION_IDLE` (default 7 days, as before) and `FLUX_SESSION_MAX_AGE` (default 30 days, new): the
  second is checked on the session row, so a session in daily use still ends 30 days after sign-in, and Better Auth is never handed a
  session past it. ASVS Level 2's 30 minutes and 12 hours are one setting away, and not the default for a daily work app. `verified`
  sign-up answers an address that has an account exactly like a new one (Better Auth's generic answer) and mails the owner of the mailbox
  ("You already have a Flux account", at most once a minute). `open` sign-up signs the new account in, so it cannot answer alike: the accepted
  risk is recorded in hardening, and the page is behind the per-address limit. Asking for the password again before Allow on the consent
  page, creating an encrypted space and AI key changes is not done: they sit in other work (Settings, `/ai`), and a recovery now ends a
  client made from a stolen session, which was the harm.
- **#994, the first owner.** A setup code would have changed every script and test that creates the first account. The install guides now
  create the owner while the server is still on loopback, before the address is public (the origin guard accepts sign-up only from the
  configured origin, which is the loopback one at that point), and `./flux up` and the API log warn at each start while nobody has signed up
  and the origin is public. Nothing else changes for an operator who follows the guide; one who does not is told, repeatedly.
- **#997, the security log.** One line per event with a fixed shape, in the log the operator already collects ([events](../operations/monitoring.md#security-events)).
  A failed sign-in is identified by a keyed hash of the address, never the address; refused requests carry the route template, never the URL;
  at most ten refusals a minute per person are written. No new store, no new endpoint.

## V1 Architecture, design and threat modelling

| ID | Requirement | Result | Evidence |
| --- | --- | --- | --- |
| 1.1.1 | Secure development lifecycle | Pass | Task contracts, independent review and impact-based checks (`docs/agents/workflow.md`, `docs/agents/evaluation.md`); CodeQL, Trivy and dependency audit in `.github/workflows/` |
| 1.1.2 | Threat modelling for design changes | Partial | [Threat model](threat-model.md) now exists. The workflow does not yet require updating it when a boundary changes (stated in its last section) |
| 1.1.3 | Security constraints in user stories | Pass | Contracts state the access and AI rules (F-036, F-037, C-1 to C-27 in `docs/product/decisions.md`) |
| 1.1.4 | Trust boundaries documented | Pass | [Threat model](threat-model.md), B1 to B12 |
| 1.1.5 | High-level architecture defined | Pass | `docs/development/architecture.md`, `docs/operations/architecture.md` |
| 1.1.6 | Centralised, reusable security controls | Pass | One origin check (`apps/server/src/identity/origin.ts:59`), one session resolver (`identity/session.ts:112`), one access policy (`packages/core/src/access/policy.ts:191,226,462`), one SSRF classifier (`packages/agent-runtime/src/endpoint-policy.ts:101`) |
| 1.1.7 | Secure coding checklist available | Partial | `docs/development/access-policy.md` and this checklist; no general secure-coding guide for contributors |
| 1.2.1 | Low-privilege OS accounts per component | Pass | Image runs as `node` (`docker/Dockerfile` `USER node`); keyring with `cap_drop: ALL`, read-only, `no-new-privileges` (`docs/operations/hardening.md`); runtime CLIs under per-person uids with no capabilities |
| 1.2.2 | Communication between components authenticated | Pass | Keyring bearer, constant-time compare (`apps/keyring/src/server.ts:49-50`); runtime manager and slot secrets (`docker/compose.source.yaml:315-361`); database password |
| 1.2.3 | One vetted authentication mechanism | Pass | Better Auth 1.7.18 for sessions, OAuth and OIDC (`identity/auth.ts:184-391`) |
| 1.2.4 | All authentication pathways equally strong | Partial | The OAuth consent mints a lasting client from any live session without re-authentication. Password recovery now ends client grants ([#989](https://github.com/ColdPhase/flux/issues/989), fixed) |
| 1.4.1 | Access control enforced at trusted points | Pass | Server-side `evaluateProject` and `evaluateWorkspace` in every use case; the MCP route re-checks before output (`agent-connection/mcp-route.ts:108-128`) |
| 1.4.4 | Single access-control mechanism | Pass | `packages/core/src/access/policy.ts`; `docs/development/access-policy.md` |
| 1.4.5 | Feature/attribute-based access control | Pass | Actions per resource (`project.read`, `project.manage`, …), roles, the space AI switch (`requireSpaceAi`), encrypted-space lock gate |
| 1.5.1 | Input and output requirements defined | Pass | JSON Schemas on routes, `packages/contracts` limits (e.g. `FILE_LIMITS`, `packages/contracts/src/files.ts:13`) |
| 1.5.2 | No untrusted serialisation | Pass | JSON only; no native object deserialisation found |
| 1.5.3 | Validation on the trusted service layer | Pass | Fastify schemas plus core validation (e.g. `packages/core/src/files/service.ts:21-28`) |
| 1.5.4 | Output encoding close to the interpreter | Pass | React escaping; server-side Markdown sanitisation (`apps/server/src/docs/markdown.ts:23-46`) |
| 1.6.1 | Key management policy | Pass | F-030 key hierarchy; `docs/operations/hardening.md` items 5, 6 and 12 (rotation, never rotate `FLUX_KEY_PIN_SECRET`) |
| 1.6.2 | Key material protected | Pass | Background key as a file mount outside the database (`packages/db/src/background-key-crypto.ts:5-15`); keyring holds encrypted-space keys in RAM only |
| 1.6.3 | Keys and passwords replaceable | Partial | `FLUX_AUTH_SECRET`, DB password and background key (`tooling/rotate-background-key.ts`) rotate; `FLUX_KEY_PIN_SECRET` cannot, by design (F-030) |
| 1.6.4 | No client-side secrets | Pass | The SPA holds no shared secret; VAPID public key only |
| 1.7.1 | Common logging format | Pass | pino JSON in every service |
| 1.7.2 | Logs sent to a remote system | N/A | Self-hosted: the operator's log shipping (`docs/operations/monitoring.md`) |
| 1.8.1 | Sensitive data identified | Pass | F-030 lists sealed columns (`packages/db/src/sealed-columns.ts`); threat model assets |
| 1.8.2 | Protection levels per class | Partial | Encrypted spaces are sealed; plain spaces and DMs rely on the database and backup protection (stated in the hardening guide) |
| 1.9.1 | Encrypted communications between components | Partial | Components talk over internal Docker networks on one host without TLS. The keyring is single-host by decision (F-030) |
| 1.9.2 | Authenticity of each side | Partial | Internal bearers. No mutual TLS between containers (single host) |
| 1.10.1 | Source control with review | Pass | PRs with required checks (`docs/agents/ci-and-releases.md`) |
| 1.11.1 | Business logic flows defined | Pass | Product contracts (`docs/product/assistant.md`, `cowork-workflow.md`, `mcp-cowork.md`) |
| 1.11.2 | High-value flows are thread-safe | Pass | Row locks in every command (`lock: true` throughout); idempotent command ids |
| 1.12.2 | Uploads served as downloads or from another origin | Pass | `Content-Disposition: attachment`, `application/octet-stream`, `nosniff`, `CSP: sandbox` (`apps/server/src/files/routes.ts:44-47`) |
| 1.14.1 | Segregation of components by trust | Pass | Networks: `keyring` internal, runtime networks internal with `inhibit_ipv4` (`docker/compose.source.yaml:9-10`) |
| 1.14.2 | Signed binaries / trusted connections | Partial | Images pinned by digest and attested. Signing is [#840](https://github.com/ColdPhase/flux/issues/840) |
| 1.14.3 | Build warns of vulnerable components | Pass | `dependency-audit.yml`, `image-scan.yml`, Dependabot |
| 1.14.4 | Automated build and deploy | Pass | `final-release.yml`, `publish-release.yml`, `./flux up` |
| 1.14.5 | Sandboxed deployment | Pass | Containers, read-only roots for keyring and runtime, no Docker socket anywhere |
| 1.14.6 | No unsupported client technology | Pass | No plugins, Flash or applets |

## V2 Authentication

| ID | Requirement | Result | Evidence |
| --- | --- | --- | --- |
| 2.1.1 | Passwords at least 12 characters | Pass (fixed) | Audit finding: no `minPasswordLength`, so Better Auth's default of 8 applied, and sign-up with `password` answered 200. Now `minPasswordLength: PASSWORD_MIN_LENGTH` (12) in `identity/auth.ts`; `tests/app/sign-in-hardening.test.ts` ([#990](https://github.com/ColdPhase/flux/issues/990)) |
| 2.1.2 | Passwords of 64+ characters allowed | Pass | Better Auth default maximum 128 |
| 2.1.3 | No truncation | Pass | scrypt over the whole input (Better Auth) |
| 2.1.4 | Any printable Unicode allowed | Pass | No character rules (inspection) |
| 2.1.5 | Users can change their password | Pass | Settings › Account, `/api/auth/change-password` |
| 2.1.6 | Change needs the current password | Pass | Better Auth `change-password` requires `currentPassword`. Changing the address requires it too (`identity/auth.ts:274-285`) |
| 2.1.7 | Breached passwords refused | Pass (fixed) | Audit finding: no check; `password` was accepted. Now `identity/password-policy.ts` refuses the 49,233 passwords of `@zxcvbn-ts/language-common` and anything it estimates under 10^8 guesses, including the person's own name and address; no call leaves the server ([#990](https://github.com/ColdPhase/flux/issues/990)) |
| 2.1.8 | Strength meter | Partial | Only for encrypted-space unlock passwords |
| 2.1.9 | No composition rules | Pass | None |
| 2.1.10 | No forced rotation | Pass | None |
| 2.1.11 | Paste and password managers allowed | Pass | Plain `type=password` inputs (inspection) |
| 2.1.12 | Show the masked password | Not verified | UI not checked in this audit |
| 2.2.1 | Anti-automation | Pass (fixed) | Audit finding: 3 tries per 10 s per IP and per process, no per-account throttle (**probe:** `401 401 401 429 429 429 429 429`, then 200 after 11 s). Now the per-address limiter is stored in PostgreSQL (`rateLimit.storage: 'database'`, shared by `api` and `api2`) and each account backs off after five attempts, 30 s up to 15 min, in `auth_sign_in_throttle`; a browser that has signed in to the account has a device cookie and counts in a wait of its own, so a stranger cannot lock the owner out ([#990](https://github.com/ColdPhase/flux/issues/990)) |
| 2.2.2 | Weak authenticators only secondary | Pass | E-mail is only for verification and recovery |
| 2.2.3 | Notification after credential changes | Partial | No e-mail on a password or address change (optional). Every change, reset and session revocation is now a security event in the log ([#997](https://github.com/ColdPhase/flux/issues/997)) |
| 2.2.x MFA (L2 by NIST AAL2) | Multi-factor authentication | **Partial** | No MFA in password mode. With SSO the IdP's MFA applies, and the hardening guide recommends SSO for internet-facing teams. Recorded in [#990](https://github.com/ColdPhase/flux/issues/990) |
| 2.3.1 | System-generated initial secrets | N/A | No initial passwords. Invite links are signed, expiring and single-use (`apps/server/src/access/invites.ts`) |
| 2.4.1 | Approved password hashing | Pass | Better Auth scrypt (N=16384, r=16, p=1). Unlock passwords use Argon2id 64 MiB, t=3, p=4 (F-030) |
| 2.4.2 | Salt of at least 32 bits | Pass | 16-byte random salt per hash (Better Auth) |
| 2.4.5 | Additional key derivation with a secret | N/A | Optional for L2; no pepper |
| 2.5.1 | Recovery secret not sent in clear | Pass | Reset link over the operator's SMTP, which supports STARTTLS and SMTPS (`compose.test.yaml` covers both) |
| 2.5.2 | No hints or knowledge questions | Pass | None |
| 2.5.3 | Recovery does not reveal the password | Pass | Reset sets a new password |
| 2.5.4 | No shared or default accounts | Pass | None. Demo passwords are only for `./flux demo` and are refused on servers (hardening item 8) |
| 2.5.5 | Notify when an authentication factor changes | Fail | As 2.2.3 |
| 2.5.6 | Secure recovery mechanism | Pass (fixed) | Hashed (`storeIdentifier: 'hashed'`, `identity/auth.ts:215`), single-use, `FLUX_PASSWORD_RESET_TTL_SECONDS` (1 h default); redirect allow-listed (**probe:** `INVALID_REDIRECT_URL` for an outside URL); same answer for unknown addresses (**probe**). Audit finding, now fixed: client grants survived the reset (**probe**, [#989](https://github.com/ColdPhase/flux/issues/989)); a reset now disconnects them |
| 2.6 / 2.7 / 2.8 / 2.9 | Look-up secrets, out-of-band, OTP, cryptographic authenticators | N/A | Not offered for sign-in. The encrypted-space recovery code is a key-wrapping secret, not an authenticator (F-030) |
| 2.10.1 | No unchanging intra-service secrets | Pass | `./flux up` generates the keyring token, runtime secrets and `FLUX_AUTH_SECRET` per install |
| 2.10.2 | No default service credentials | Pass | `POSTGRES_PASSWORD` is required (`docker/compose.source.yaml:62`, `:?Set POSTGRES_PASSWORD`) |
| 2.10.3 | Service passwords protected | Pass | `.env` mode 600; OIDC secret and background key as file mounts |
| 2.10.4 | No secrets in source | Pass | `.env` is generated per install and git-ignored (`.gitignore:13`); CodeQL runs on every PR. No committed secret found by inspection |

## V3 Session management

| ID | Requirement | Result | Evidence |
| --- | --- | --- | --- |
| 3.1.1 | No session token in URLs | Pass | Cookie only. The stream and editing WebSockets authenticate by cookie and Origin (`stream/routes.ts:48`, `editing/gate.ts:71`) |
| 3.2.1 | New token at authentication | Pass | **Probe:** each sign-in set a new `flux.session_token` |
| 3.2.2 | At least 64 bits of entropy | Pass | 32-character random token plus HMAC (Better Auth) |
| 3.2.3 | Tokens stored securely in the browser | Pass | HttpOnly cookie (**probe:** `Set-Cookie … HttpOnly; SameSite=Lax`) |
| 3.2.4 | Approved algorithms | Pass | HMAC-SHA-256 signed cookie |
| 3.3.1 | Logout invalidates the session | Pass | **Probe:** a copy of the cookie answered 401 after `/api/auth/sign-out` |
| 3.3.2 | Periodic re-authentication (L2: 12 h or 30 min idle) | Pass (fixed) | Audit finding: 7-day sessions that slide on use, no absolute limit, not settable (**probe:** `Max-Age=604800`). Now `FLUX_SESSION_IDLE` (default 7d) and `FLUX_SESSION_MAX_AGE` (default 30d, enforced on the session row, `identity/session.ts`) are settable; the L2 values are `30m` and `12h`, documented in [hardening](../operations/hardening.md) ([#993](https://github.com/ColdPhase/flux/issues/993)). With SSO, `FLUX_OIDC_CONFIRMATION_MAX_AGE` bounds the provider's confirmation too |
| 3.3.3 | Terminate other sessions after a password change | Pass (fixed) | Browser sessions: yes (`revokeSessionsOnPasswordReset`, `identity/auth.ts:358`; the change form offers `revokeOtherSessions`, `apps/web/src/api/auth.ts:92`). MCP client grants: audit finding, now fixed. **Probe:** after a reset the old refresh token minted a new access token and `/mcp` answered 200. Now a reset, a password change that signs out other devices and "Sign out all other devices" disconnect the person's clients ([#989](https://github.com/ColdPhase/flux/issues/989); `tests/app/oauth-sign-out.test.ts`) |
| 3.3.4 | Users can see and end their sessions | Pass | Settings › Account lists sessions by id; Better Auth `/list-sessions` disabled because it returns raw tokens (`identity/auth.ts:380`). Clients are listed in Settings › AI with Disconnect |
| 3.4.1 | `Secure` attribute | Pass | `useSecureCookies` when `FLUX_PUBLIC_ORIGIN` is https (`identity/auth.ts:385`) |
| 3.4.2 | `HttpOnly` | Pass | `identity/auth.ts:386`; probe |
| 3.4.3 | `SameSite` | Pass | `lax`; probe |
| 3.4.4 | `__Host-` prefix | Partial | `__Secure-` on https (Better Auth). `__Host-` would also pin the host |
| 3.4.5 | Cookie path scoped | Pass | `path=/` on a dedicated origin |
| 3.5.1 | Users can revoke OAuth grants | Pass (fixed) | Disconnect in Settings › AI revokes; admin and claim paths revoke too (`identity/admin.ts:22-28`). Password recovery and signing out other devices now do ([#989](https://github.com/ColdPhase/flux/issues/989)) |
| 3.5.2 | Session tokens rather than static API secrets | Pass | Short-lived JWT access tokens with rotating refresh tokens (`app/patches/oauth-provider-1.7.18-flux-refresh.patch`) |
| 3.5.3 | Stateless tokens signed and checked | Pass | EdDSA JWT, audience `/mcp`, issuer checked, then a live grant check on each request (`agent-connection/mcp-route.ts:35-120`). Run tokens: single mint per nonce, bound to one run and place (`apps/server/src/personal-runs/run-tokens.ts:25-69`) |
| 3.7.1 | Re-authentication before sensitive actions | **Partial** | The address change asks for the password. Connecting a client (consent Allow), creating an encrypted space and changing AI keys do not; a stolen session's client no longer survives the owner's recovery ([#989](https://github.com/ColdPhase/flux/issues/989), [#993](https://github.com/ColdPhase/flux/issues/993)) |

## V4 Access control

| ID | Requirement | Result | Evidence |
| --- | --- | --- | --- |
| 4.1.1 | Enforced on a trusted service layer | Pass | `packages/core/src/access/policy.ts`, called inside each transaction with row locks |
| 4.1.2 | Attributes cannot be manipulated by users | Pass | **Probe:** `createdBy` sent with a space creation was stripped (Fastify `removeAdditional`), and the creator stayed the caller. `emailVerified` in `/api/auth/update-user` was ignored |
| 4.1.3 | Least privilege | **Partial** | Agents and clients get exactly their owner's rights, by decision (F-036 point 8, C-21). Guests can still connect AI on `main` ([#959](https://github.com/ColdPhase/flux/issues/959)); the local-client company-role check is [#978](https://github.com/ColdPhase/flux/issues/978) (PR #986) |
| 4.1.5 | Fail securely | Pass | `enforce` throws; MCP route answers 403 on any grant error (`mcp-route.ts:91-96`); locked encrypted spaces answer 423 |
| 4.2.1 | Protection against IDOR | Not verified here | Pattern is consistent (`evaluateProject` by id with the principal). Object-level testing is [#839](https://github.com/ColdPhase/flux/issues/839) |
| 4.2.2 | CSRF protection | Pass | `identity/origin.ts:59-69`. **Probe:** foreign Origin, no Origin with a cookie, and `Sec-Fetch-Site: same-site` all answered 403 `ORIGIN_REJECTED` |
| 4.3.1 | Admin interfaces use MFA | Partial | Company admin uses the same sign-in. MFA only through SSO ([#990](https://github.com/ColdPhase/flux/issues/990)) |
| 4.3.2 | No directory browsing or metadata exposure | Pass | `@fastify/static` without listing. Unknown `/api/` paths answer 404 (**probe**) |
| 4.3.3 | Step-up for sensitive admin actions | Partial | As 3.7.1 |

## V5 Validation, sanitisation and encoding

| ID | Requirement | Result | Evidence |
| --- | --- | --- | --- |
| 5.1.1 | HTTP parameter pollution | Pass | Repeated headers refused (`apps/server/src/http/headers.ts:8-14`); schemas with `additionalProperties: false` |
| 5.1.2 | Mass assignment | Pass | Schemas strip unknown fields (probe above) |
| 5.1.3 | Positive input validation | Pass | JSON Schemas on routes; UUID checks before queries (e.g. `link-previews/routes.ts:23`) |
| 5.1.4 | Structured data typed and validated | Pass | Fastify AJV, zod in places |
| 5.1.5 | Redirects to allow-listed destinations | Pass | Better Auth `trustedOrigins` (**probe:** reset `redirectTo` outside the origin refused). OAuth redirect URIs come from the client's registered metadata only |
| 5.2.1 | Untrusted HTML sanitised | Pass | markdown-it `html:false` plus sanitize-html allow-list with http, https and mailto schemes (`apps/server/src/docs/markdown.ts:23,34-46`). The single `dangerouslySetInnerHTML` renders only that output (`apps/web/src/docs/DocProse.tsx:27`) |
| 5.2.2 | Unstructured data sanitised | Pass | Message URLs and material URLs limited to http and https (`packages/core/src/conversation/commands.ts:50`) |
| 5.2.3 | Mail injection | Pass | nodemailer with fixed templates; the address comes from the account |
| 5.2.4 | No `eval` or dynamic code | Pass | None found in `apps/*/src` (inspection) |
| 5.2.5 | Template injection | Pass | No server-side templates |
| 5.2.6 | SSRF protection | Pass | `link-previews/safe-fetch.ts:48-91` and `packages/agent-runtime/src/endpoint-policy.ts:15-32,101-107,176`: resolve once and pin, every answer public, default ports, redirects re-checked. **Probe:** `http://127.0.0.1.nip.io/` and `http://169.254.169.254/…` produced no card; `https://example.com/` did. CIMD client metadata uses Better Auth's pinned HTTPS fetch (`@better-auth/cimd/dist/node.mjs`). Push endpoints refuse non-public resolutions (`packages/core/src/push/config.ts:117-125`, `apps/worker/src/push/public-lookup.ts:26`) |
| 5.2.7 | SVG sanitised | Pass | Uploaded SVGs are never rendered inline: files are downloads with `CSP: sandbox` |
| 5.2.8 | Markdown and expression languages sanitised | Pass | As 5.2.1 |
| 5.3.1 | Context-aware output encoding | Pass | React; JSON responses |
| 5.3.3 | XSS escaping | Pass | As above, and a script Content-Security-Policy as defence in depth (14.4.3) |
| 5.3.4 | Parameterised queries | Pass | Drizzle and `sql` tagged templates (e.g. `apps/server/src/app.ts:183`) |
| 5.3.6 | JSON injection | Pass | `JSON.stringify` only |
| 5.3.8 | OS command injection | Pass | The API runs no shell. The runtime supervisor starts CLIs with argument arrays and passes no secret on a command line (`docs/operations/agent-runtime.md`) |
| 5.3.9 | Local or remote file inclusion | Pass | Files addressed by UUID only |
| 5.5.2 | XML external entities | N/A | No XML parsing |
| 5.5.3 | Unsafe deserialisation | Pass | JSON only |
| 5.5.4 | `JSON.parse` rather than eval | Pass | |
| 5.4.x | Memory safety | N/A | Node.js, no native code of Flux's own |

## V6 Stored cryptography

| ID | Requirement | Result | Evidence |
| --- | --- | --- | --- |
| 6.1.1 | Regulated private data encrypted at rest | Partial | Encrypted spaces seal content. Plain spaces and DMs are plaintext in PostgreSQL by design; the operator should encrypt disks and backups (hardening items 7 and 10) |
| 6.2.1 | Crypto fails securely | Pass | GCM tag verified before use (`packages/db/src/background-key-crypto.ts:29-37`); `409 ENCRYPTION_TAMPERED` (F-030) |
| 6.2.2 | Proven algorithms | Pass | AES-256-GCM, HKDF, X25519, Argon2id, Ed25519 (`packages/core/src/encryption/primitives.ts`) |
| 6.2.3 | Correct modes and IVs | Pass | 96-bit random nonces, AAD bound to owner and connection (`background-key-crypto.ts:17-25`) or to workspace, field, row and key version (F-030) |
| 6.2.4 | Algorithms replaceable | Pass | Versioned envelopes (`v1.`), key versions with rotation (F-030 S2c) |
| 6.2.5 | No insecure modes | Pass | No ECB or CBC found |
| 6.2.6 | Unique nonces | Pass | `randomBytes(12)` per seal |
| 6.3.1 | CSPRNG | Pass | `node:crypto` `randomBytes` and `randomUUID`; the browser's `crypto.getRandomValues` for the recovery code (C-25) |
| 6.3.2 | Random GUIDs | Pass | `randomUUID()` for ids (`identity/auth.ts:391`) |
| 6.4.1 | Secrets management | Partial | `.env` and file mounts, no vault. Acceptable for self-hosting and documented |
| 6.4.2 | Key material isolated | Pass | Encrypted-space keys only in RAM, sealed under the keyring's boot key. The background key is opened only by the worker (`background-key-crypto.ts:28`) |

## V7 Error handling and logging

| ID | Requirement | Result | Evidence |
| --- | --- | --- | --- |
| 7.1.1 | No credentials or tokens in logs | Pass | Query strings dropped and a link token in the path logged as `<token>` (`apps/server/src/http/log-serializers.ts`, #1030), password fields redacted (`:33`), bodies never logged. Provider tokens never reach `auth_accounts` (`identity/auth.ts:88-95`) |
| 7.1.2 | No other sensitive data in logs | Pass (fixed) | Audit finding: an unexpected error's message was logged and answered (**probe**, the injected body appeared twice in `docker logs`). Now every space logs the redacted error (class, code, SQLSTATE, constraint), tested by `scripts/check_encryption.sh` ([#991](https://github.com/ColdPhase/flux/issues/991)). Security events never hold a secret, address or content (`tests/app/security-log.test.ts`) |
| 7.1.3 | Security events logged | Pass (fixed) | Audit finding: only access lines. Now `security-log.ts` writes sign-ins, resets, changes, session and client revocations, consent decisions, refusals and space locks ([#997](https://github.com/ColdPhase/flux/issues/997)); the events are in [monitoring](../operations/monitoring.md#security-events) |
| 7.1.4 | Enough detail to investigate | Partial | Request ids (caller's `X-Request-ID` accepted when safe, `log-serializers.ts:21-32`); see 7.1.3 |
| 7.2.1 | Authentication decisions logged | Pass (fixed) | `sign_in`, `password_reset`, `password_changed`, `oauth_consent`, `oauth_token` events; OIDC refusals were logged already (`identity/backchannel.ts:109,115`) ([#997](https://github.com/ColdPhase/flux/issues/997)) |
| 7.2.2 | Access-control failures logged | Pass (fixed) | `access_denied` for a `403` of the access policy, with the person and the route template, at most ten a minute per person; `origin_refused` for a cross-origin state change ([#997](https://github.com/ColdPhase/flux/issues/997)) |
| 7.3.1 | Log injection prevented | Pass | Structured JSON (pino) |
| 7.3.3 | Logs protected | N/A | Operator's Docker log driver |
| 7.3.4 | Time source synchronised | N/A | Host |
| 7.4.1 | Generic error messages | **Fail** | `useDomainErrors` re-throws unexpected errors to Fastify's default handler (`apps/server/src/http/errors.ts:53-68`), which answers `error.message`. **Probe:** `{"message":"Injected failure after {\"name\":\"secret-project-name-XYZ\"…}"}` ([#991](https://github.com/ColdPhase/flux/issues/991)) |
| 7.4.2 | Exceptions handled consistently | Pass | One error mapper for every route plugin (`errors.ts:53`) |
| 7.4.3 | Last-resort handler | Pass | Fastify's handler; the process stays up |

## V8 Data protection

| ID | Requirement | Result | Evidence |
| --- | --- | --- | --- |
| 8.1.1 | Sensitive data not cached by intermediaries | Pass (fixed) | Files and exports send `private, no-store`; since #992 every `/api/` answer without its own rule sends `no-store` (`http/security-headers.ts`, `tests/app/security-headers.test.ts`) |
| 8.1.2 | Cached copies purged | Pass | No server-side response cache |
| 8.1.3 | Minimal parameters | Pass | Schemas with `additionalProperties: false` |
| 8.1.4 | Abnormal request volumes detected | Partial | Auth rate limits, live-join limiter; `rate_limited`, `sign_in` `limited` and `access_denied` events can be alerted on ([monitoring](../operations/monitoring.md#security-events)) |
| 8.1.5 | Regular backups | Pass | `docs/operations/backup-restore.md` |
| 8.1.6 | Backups stored securely | Pass (operator) | Hardening item 7: encrypt backups that leave the machine |
| 8.2.1 | Anti-caching headers | Pass (fixed) | As 8.1.1 ([#992](https://github.com/ColdPhase/flux/issues/992)) |
| 8.2.2 | No sensitive data in browser storage | Partial | `localStorage` holds UI preferences and the last asked conversation id; unsaved Wiki text is kept in session or local storage until sent (`apps/web/src/docs/drafts.ts:31-58`) |
| 8.2.3 | Client data cleared at sign-out | Pass | Drafts retired on confirmed sign-out (`apps/web/src/docs/drafts.ts:73-78`, `composer/draft.ts:107`) |
| 8.3.1 | Sensitive data in bodies, not URLs | Pass | Search text is in the query string but never logged (`log-serializers.ts:7-15`). Tokens are never in URLs, except the one-time reset and invite links; the reset link's token sits in the path (`GET /api/auth/reset-password/<token>`) and is logged as `<token>` ([#1030](https://github.com/ColdPhase/flux/issues/1030)), the invite token is in the fragment and never sent |
| 8.3.2 | Users can export or delete their data | Pass | Space export (`apps/server/src/export/routes.ts`); account and space deletion (`docs/operations/export.md`, `administration.md`) |
| 8.3.3 | Clear language about data use | Pass | AI use line in DMs (C-2); "Ada · via Assistant"; provider named in Connect AI |
| 8.3.4 | Sensitive data identified | Pass | As 1.8.1 |
| 8.3.5 | Access to sensitive data audited | Partial | Event log of changes (`recordEvent`); no read audit. Refused reads are `access_denied` events ([#997](https://github.com/ColdPhase/flux/issues/997)) |
| 8.3.6 | Sensitive memory cleared | Partial | Swap refused and core dumps off for key holders (F-030, `ulimits: core: 0`); JavaScript strings cannot be wiped. Zeroing of key buffers not verified |
| 8.3.7 | Encryption with approved algorithms | Pass | As V6 |
| 8.3.8 | Retention | Partial | Push subscriptions, live webhook events (7 days, `app.ts:249-256`) and sessions expire; content is kept until deleted, by design |

## V9 Communication

| ID | Requirement | Result | Evidence |
| --- | --- | --- | --- |
| 9.1.1 | TLS for all client connections | Pass (operator) | API publishes only on `127.0.0.1` (`docker/compose.source.yaml:192`); HTTPS through the operator's proxy (hardening item 1, `docs/operations/reverse-proxy.md`); the API sends HSTS for an https origin ([#992](https://github.com/ColdPhase/flux/issues/992)) |
| 9.1.2 / 9.1.3 | Strong ciphers, current TLS | Not verified | The operator's Caddy or nginx; Caddy's defaults are TLS 1.2+ |
| 9.2.1 | Trusted certificates for outbound TLS | Pass | Node's default verification; the CIMD fetch keeps the hostname as SNI and the verification identity while pinning the address |
| 9.2.2 | Encrypted outbound connections | Partial | Providers, push, CIMD and GitHub over HTTPS. Link cards and web reads may fetch `http:` public pages; SMTP depends on the operator's URL. PostgreSQL is on the internal network without TLS |
| 9.2.3 | Outbound connections authenticated | Pass | Provider keys, VAPID, GitHub App JWT |
| 9.2.5 | Backend TLS failures logged | Partial | Logged as fetch failures, without a security event |

## V10 Malicious code and supply chain

| ID | Requirement | Result | Evidence |
| --- | --- | --- | --- |
| 10.2.1 | No unwanted data collection or phone-home | Pass | Better Auth telemetry off (`identity/auth.ts:382`); no analytics |
| 10.2.2 | No unneeded permissions | Pass | PWA asks only for notifications, on request |
| 10.3.1 | Update integrity | Partial | Release images are pinned by digest and attested in `publish-release.yml`; signature verification for operators is [#840](https://github.com/ColdPhase/flux/issues/840) |
| 10.3.2 | Integrity of external code (SRI) | Pass | No third-party scripts or CDNs; fonts and icons are self-hosted (`apps/web/public`) |
| 10.3.3 | Subdomain takeover | N/A | Self-hosted; the docs site is on GitHub Pages |
| Supply chain | Pinned build inputs | Pass | Actions pinned by SHA, base images by digest (`docker/Dockerfile:3,11,66,…`), `pnpm install --frozen-lockfile` (`Dockerfile:26,49`), SBOM and attestation in release workflows. The patched Better Auth packages (`app/patches/`) need review on each upgrade |

## V12 Files and resources

| ID | Requirement | Result | Evidence |
| --- | --- | --- | --- |
| 12.1.1 | Large files refused | Pass | 5 MiB per file, `bodyLimit` and `Content-Length` checked first (`apps/server/src/files/routes.ts:15-24`); 20 MiB per message |
| 12.1.2 | Compressed files checked | N/A | Uploads are never unpacked |
| 12.1.3 | Per-user quota | Partial | Staging quota per uploader and space (`packages/core/src/files/service.ts:197`); no total quota per person |
| 12.2.1 | File type validation | Pass | Bytes are always served as `application/octet-stream` downloads. Image previews use detected types (`imageTypeOf`, `packages/contracts`) |
| 12.3.1 | Filenames not used on the filesystem | Pass | Objects stored by UUID; display name validated (`packages/core/src/files/service.ts:21-28`) |
| 12.3.4 | Reflected file download | Pass | `filename="download"` plus a UTF-8 encoded `filename*` (`files/routes.ts:45`) |
| 12.3.5 | No commands with filenames | Pass | |
| 12.4.1 | Stored outside the web root | Pass | `/data/files` volume; static root is `apps/web/dist` |
| 12.4.2 | Antivirus scanning | N/A / accepted | Not offered. Files are never rendered by Flux; recorded as an accepted risk for self-hosting |
| 12.5.1 | Web tier serves only expected types | Pass | Static assets from the build; the not-found handler serves only `index.html` |
| 12.5.2 | Uploads never executed as HTML or JS | Pass | `CSP: sandbox`, `nosniff`, `attachment` (`files/routes.ts:44-47`) |
| 12.6.1 | Server-side fetches allow-listed | **Partial** | Address guard as 5.2.6 (**probe**). By founder decision an agent may open any public address (#1065, C-30); the server refuses one that carries private Flux text the run read, and every address asked is listed (#953, #1136); what the agent rewrote can still leave (accepted). Web reads are on by default since C-29 (`FLUX_WEB_READS=off` turns them off); link cards are off by default (`FLUX_LINK_PREVIEWS`) and never fetched for a server agent's line |

## V13 API and web service

| ID | Requirement | Result | Evidence |
| --- | --- | --- | --- |
| 13.1.1 | One parser for all components | Pass | Fastify JSON for every route |
| 13.1.3 | No sensitive data in API URLs | Pass | Ids only. Search text is in the query string but never logged |
| 13.1.4 | Authorization at route and resource | Pass | Session at the route, policy in the use case; MCP bearer plus a per-call grant and space check |
| 13.1.5 | Unexpected content types refused | Pass | **Probe:** a `text/plain` body to a JSON route answered 400 `body must be object`; uploads need `application/octet-stream` (`files/routes.ts:20`) |
| 13.2.1 | Only valid HTTP methods | Pass | **Probe:** `TRACE` and cross-origin `OPTIONS` answered 404 |
| 13.2.2 | JSON schema validation | Pass | Route schemas |
| 13.2.3 | CSRF on cookie-based REST | Pass | As 4.2.2 |
| 13.2.5 | Content-Type checked | Pass | As 13.1.5 |
| 13.2.6 | Headers and payload trustworthy | Pass | Forwarding headers dropped unless from a trusted proxy (`identity/bridge.ts:14,91`); `If-Match` parsed strictly (`http/headers.ts:17-22`) |
| 13.3 / 13.4 | SOAP, GraphQL | N/A | |
| MCP | Remote MCP endpoint (not an ASVS 4.0 item) | Pass | One scope (C-23); no dynamic client registration (`identity/auth.ts:228-229`); clients only from CIMD; consent shows the redirect host and the client-details host; live checks per call (`mcp-route.ts`); no approval tool in the tool list (`agent-connection/tool-registry.ts`) |

## V14 Configuration

| ID | Requirement | Result | Evidence |
| --- | --- | --- | --- |
| 14.1.1 | Repeatable, secure build | Pass | Multi-stage Dockerfile with pinned digests and a frozen lockfile |
| 14.1.3 | Server configuration hardened | **Partial** | `docs/operations/hardening.md`; non-root, loopback-only port. A newly exposed server is claimable by its first sign-up ([#994](https://github.com/ColdPhase/flux/issues/994)) |
| 14.1.4 | Automated deploy and restore | Pass | `./flux up`, `./flux upgrade`, `docs/operations/backup-restore.md` |
| 14.2.1 | Components up to date | Pass | Dependabot and the dependency audit (#834 to #836, #913) |
| 14.2.2 | Unneeded features removed | Pass | Link cards, web reads, AI, runtime, GitHub and live media are off until set (hardening item 9); test fixtures need `FLUX_FIXTURE_TOKEN` (**probe:** `/api/v1/test/routes` without it answered 401) |
| 14.2.3 | SRI for external assets | N/A | No external assets |
| 14.2.4 | Components from trusted sources | Pass | npm with lockfile integrity; official images by digest |
| 14.2.5 | Inventory (SBOM) | Pass | `anchore/sbom-action` in the release workflows |
| 14.2.6 | Attack surface reduced by sandboxing | Pass | Runtime sandbox and egress proxy (`apps/runtime/src/egress/server.ts:63-67`) |
| 14.3.2 | Debug modes off | Pass | No debug endpoints. `FLUX_TEST_FAILURE_INJECTION` takes effect only together with the fixture token (`apps/server/src/app.ts:118`) |
| 14.3.3 | No version-revealing headers | Pass | **Probe:** no `Server` or `X-Powered-By` header |
| 14.4.1 | Content-Type with charset | Pass | `application/json; charset=utf-8`, `text/html; charset=utf-8` (**probe**) |
| 14.4.2 | API responses with safe Content-Disposition | Pass | Downloads and exports set `attachment` |
| 14.4.3 | Content-Security-Policy | Pass | The pages and the service worker carry a policy with `default-src 'self'`, no `'unsafe-inline'` or `'unsafe-eval'` for scripts (the inline ones are hashed), `object-src 'none'`, `base-uri 'self'`, `form-action 'self'` and `frame-ancestors 'none'` (`http/content-security-policy.ts`, [#979](https://github.com/ColdPhase/flux/issues/979)). `style-src` keeps `'unsafe-inline'` (React style attributes); API responses keep `frame-ancestors 'none'` only |
| 14.4.4 | `X-Content-Type-Options: nosniff` | Pass (fixed) | On every response (`http/security-headers.ts`; [#992](https://github.com/ColdPhase/flux/issues/992)) |
| 14.4.5 | HSTS | Pass (fixed) | The API sends `max-age=31536000` for an https public origin; the proxy guide says to pass it on ([#992](https://github.com/ColdPhase/flux/issues/992)) |
| 14.4.6 | Referrer-Policy | Pass (fixed) | `same-origin` on every response ([#992](https://github.com/ColdPhase/flux/issues/992)) |
| 14.4.7 | Framing prevented | Pass | `X-Frame-Options: DENY` and `frame-ancestors 'none'` on every response (**probe**) |
| 14.5.1 | Only needed HTTP methods | Pass | As 13.2.1 |
| 14.5.2 | Origin not used for authentication | Pass | Origin is only a CSRF check; authentication is the session or bearer |
| 14.5.3 | CORS allow-list | Pass | No CORS headers at all. **Probe:** no `Access-Control-Allow-Origin` for `Origin: https://evil.example` |
| 14.5.4 | Proxy-added headers authenticated | Pass | `FLUX_TRUSTED_PROXIES` only (`apps/server/src/app.ts:113`, `identity/bridge.ts:14`) |

## Probe log

The audit ran these requests on 2026-11-08 against the stack described above. The commands and outputs are
summarised in the issues they support:

| Probe | Result |
| --- | --- |
| Sign-up with `password` | 200, session set; the account became company owner (#990, fixed: 400 `PASSWORD_TOO_SHORT`) |
| 8 wrong sign-ins, then the right one after 11 s | `401×3`, `429×5`, then 200 (#990, fixed: the account waits 30 s after the fifth, whatever the address) |
| Sign-up with an existing address / reset for an unknown address | 422 `USER_ALREADY_EXISTS…` / 200 generic (#993; fixed for `verified` sign-up, which answers alike and mails the owner; `open` keeps the 422, an accepted risk) |
| Reset with `redirectTo=https://evil.example/steal` | 403 `INVALID_REDIRECT_URL` |
| Cross-origin, origin-less and `same-site` POST with the cookie | 403 `ORIGIN_REJECTED` ×3 |
| Cookie copy after sign-out | 401 |
| `/api/auth/update-user` with `emailVerified:true` | Ignored (`emailVerified` stayed false) |
| OAuth client consent, code exchange and `/mcp tools/list`; password reset; refresh after reset | 200; reset 200 and browser 401; **refresh 200 and `/mcp` 200** (#989, fixed: refresh `invalid_grant`, `/mcp` 403) |
| `x-flux-test-fail: 500` on a space creation | The error message with the request body in the response and twice in the log (#991, fixed: `500` with a code only, nothing in the log) |
| Headers on `/`, `/api/v1/workspaces`, a 404 | Only `x-frame-options` and `frame-ancestors`; no `Cache-Control` on API JSON (#992, fixed: `nosniff`, `Referrer-Policy`, `no-store` under `/api/`) |
| Link cards for `127.0.0.1.nip.io`, `169.254.169.254` and `example.com` | No card, no card, card |
| `TRACE` and cross-origin `OPTIONS` | 404, 404; no CORS headers |
| `text/plain` body to a JSON route | 400 |
| `/api/v1/test/routes` without the fixture bearer | 401 |
