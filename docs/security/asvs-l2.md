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
| [#989](https://github.com/ColdPhase/flux/issues/989) | **P2** | 3.3.3, 3.5.1 | A password reset or "sign out everywhere" leaves local MCP clients connected with the owner's rights (probed) |
| [#990](https://github.com/ColdPhase/flux/issues/990) | **P2** | 2.1.1, 2.1.7, 2.2.1 | 8-character and common passwords accepted; sign-in throttled only per IP and process (probed) |
| [#991](https://github.com/ColdPhase/flux/issues/991) | P3 | 7.4.1 | Unexpected errors answer their internal message outside encrypted spaces (probed) |
| [#992](https://github.com/ColdPhase/flux/issues/992) | P3 | 8.2.1, 14.4.4 to 14.4.6 | No `nosniff`, Referrer-Policy, `no-store` on API JSON, or HSTS guidance (probed) |
| [#993](https://github.com/ColdPhase/flux/issues/993) | P3 | 3.3.2, 3.7.1 | Sign-up reveals registered addresses; 7-day sliding sessions with no absolute limit (probed) |
| [#994](https://github.com/ColdPhase/flux/issues/994) | P3 | 14.1.3 | Whoever signs up first on a newly exposed server owns the company |
| [#997](https://github.com/ColdPhase/flux/issues/997) | P3 | 7.1.3, 7.2.1, 7.2.2 | No security event log for failed sign-ins, refusals and consent decisions (probed) |

These issues were already open and are referenced, not filed again:
- [#979](https://github.com/ColdPhase/flux/issues/979) (CSP, 14.4.3)
- [#953](https://github.com/ColdPhase/flux/issues/953) and PR #983 (web-read exfiltration, 12.6.1)
- [#959](https://github.com/ColdPhase/flux/issues/959) and [#978](https://github.com/ColdPhase/flux/issues/978) (guests and non-members connecting AI or clients, 4.1.3)
- [#840](https://github.com/ColdPhase/flux/issues/840) (image signing, 10.3.1, 14.2)

No P1 was found.

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
| 1.2.4 | All authentication pathways equally strong | Partial | The OAuth consent mints a lasting client from any live session without re-authentication. Password recovery does not end client grants ([#989](https://github.com/ColdPhase/flux/issues/989)) |
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
| 2.1.1 | Passwords at least 12 characters | **Fail** | No `minPasswordLength` in `identity/auth.ts:355-377`, so Better Auth's default of 8 applies. **Probe:** sign-up with `password` answered 200 ([#990](https://github.com/ColdPhase/flux/issues/990)) |
| 2.1.2 | Passwords of 64+ characters allowed | Pass | Better Auth default maximum 128 |
| 2.1.3 | No truncation | Pass | scrypt over the whole input (Better Auth) |
| 2.1.4 | Any printable Unicode allowed | Pass | No character rules (inspection) |
| 2.1.5 | Users can change their password | Pass | Settings › Account, `/api/auth/change-password` |
| 2.1.6 | Change needs the current password | Pass | Better Auth `change-password` requires `currentPassword`. Changing the address requires it too (`identity/auth.ts:274-285`) |
| 2.1.7 | Breached passwords refused | **Fail** | No check; `password` accepted (**probe**, [#990](https://github.com/ColdPhase/flux/issues/990)). zxcvbn-ts is used only for unlock passwords (`apps/server/src/encryption/adapters.ts:45`) |
| 2.1.8 | Strength meter | Partial | Only for encrypted-space unlock passwords |
| 2.1.9 | No composition rules | Pass | None |
| 2.1.10 | No forced rotation | Pass | None |
| 2.1.11 | Paste and password managers allowed | Pass | Plain `type=password` inputs (inspection) |
| 2.1.12 | Show the masked password | Not verified | UI not checked in this audit |
| 2.2.1 | Anti-automation | **Partial** | 3 tries per 10 s per IP and per process (`identity/auth.ts:381`). **Probe:** `401 401 401 429 429 429 429 429`, then 200 after 11 s. No per-account throttle ([#990](https://github.com/ColdPhase/flux/issues/990)) |
| 2.2.2 | Weak authenticators only secondary | Pass | E-mail is only for verification and recovery |
| 2.2.3 | Notification after credential changes | Fail | No e-mail on a password or address change (inspection of `identity/auth.ts`). Folded into [#997](https://github.com/ColdPhase/flux/issues/997)'s event list; an e-mail is optional |
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
| 2.5.6 | Secure recovery mechanism | **Partial** | Hashed (`storeIdentifier: 'hashed'`, `identity/auth.ts:215`), single-use, `FLUX_PASSWORD_RESET_TTL_SECONDS` (1 h default); redirect allow-listed (**probe:** `INVALID_REDIRECT_URL` for an outside URL); same answer for unknown addresses (**probe**). But client grants survive the reset (**probe**, [#989](https://github.com/ColdPhase/flux/issues/989)) |
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
| 3.3.2 | Periodic re-authentication (L2: 12 h or 30 min idle) | **Fail** | 7-day sessions that slide on use, with no absolute limit (`identity/auth.ts:212`; **probe:** `Max-Age=604800`). Operator cannot change it ([#993](https://github.com/ColdPhase/flux/issues/993)). With SSO, `FLUX_OIDC_CONFIRMATION_MAX_AGE` bounds provider sessions |
| 3.3.3 | Terminate other sessions after a password change | **Fail** | Browser sessions: yes (`revokeSessionsOnPasswordReset`, `identity/auth.ts:358`; the change form offers `revokeOtherSessions`, `apps/web/src/api/auth.ts:92`). MCP client grants: no. **Probe:** after a reset the old refresh token minted a new access token and `/mcp` answered 200 ([#989](https://github.com/ColdPhase/flux/issues/989)) |
| 3.3.4 | Users can see and end their sessions | Pass | Settings › Account lists sessions by id; Better Auth `/list-sessions` disabled because it returns raw tokens (`identity/auth.ts:380`). Clients are listed in Settings › AI with Disconnect |
| 3.4.1 | `Secure` attribute | Pass | `useSecureCookies` when `FLUX_PUBLIC_ORIGIN` is https (`identity/auth.ts:385`) |
| 3.4.2 | `HttpOnly` | Pass | `identity/auth.ts:386`; probe |
| 3.4.3 | `SameSite` | Pass | `lax`; probe |
| 3.4.4 | `__Host-` prefix | Partial | `__Secure-` on https (Better Auth). `__Host-` would also pin the host |
| 3.4.5 | Cookie path scoped | Pass | `path=/` on a dedicated origin |
| 3.5.1 | Users can revoke OAuth grants | **Partial** | Disconnect in Settings › AI revokes; admin and claim paths revoke too (`identity/admin.ts:22-28`). Password recovery does not ([#989](https://github.com/ColdPhase/flux/issues/989)) |
| 3.5.2 | Session tokens rather than static API secrets | Pass | Short-lived JWT access tokens with rotating refresh tokens (`app/patches/oauth-provider-1.7.18-flux-refresh.patch`) |
| 3.5.3 | Stateless tokens signed and checked | Pass | EdDSA JWT, audience `/mcp`, issuer checked, then a live grant check on each request (`agent-connection/mcp-route.ts:35-120`). Run tokens: single mint per nonce, bound to one run and place (`apps/server/src/personal-runs/run-tokens.ts:25-69`) |
| 3.7.1 | Re-authentication before sensitive actions | **Partial** | The address change asks for the password. Connecting a client (consent Allow), creating an encrypted space and changing AI keys do not ([#989](https://github.com/ColdPhase/flux/issues/989), [#993](https://github.com/ColdPhase/flux/issues/993)) |

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
| 5.3.3 | XSS escaping | Pass | As above. A script CSP as defence in depth is [#979](https://github.com/ColdPhase/flux/issues/979) |
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
| 7.1.1 | No credentials or tokens in logs | Pass | Query strings dropped (`apps/server/src/http/log-serializers.ts:7-15`), password fields redacted (`:33`), bodies never logged. Provider tokens never reach `auth_accounts` (`identity/auth.ts:88-95`) |
| 7.1.2 | No other sensitive data in logs | **Partial** | Sealed requests are redacted. Elsewhere an unexpected error's message is logged and answered. **Probe:** the injected error's quoted body appeared twice in `docker logs` ([#991](https://github.com/ColdPhase/flux/issues/991)) |
| 7.1.3 | Security events logged | **Fail** | Only access lines (method, path, status, IP). **Probe:** eight failed sign-ins left no account or reason ([#997](https://github.com/ColdPhase/flux/issues/997)) |
| 7.1.4 | Enough detail to investigate | Partial | Request ids (caller's `X-Request-ID` accepted when safe, `log-serializers.ts:21-32`); see 7.1.3 |
| 7.2.1 | Authentication decisions logged | Fail | [#997](https://github.com/ColdPhase/flux/issues/997). OIDC refusals are logged (`identity/backchannel.ts:109,115`) |
| 7.2.2 | Access-control failures logged | Fail | [#997](https://github.com/ColdPhase/flux/issues/997) |
| 7.3.1 | Log injection prevented | Pass | Structured JSON (pino) |
| 7.3.3 | Logs protected | N/A | Operator's Docker log driver |
| 7.3.4 | Time source synchronised | N/A | Host |
| 7.4.1 | Generic error messages | **Fail** | `useDomainErrors` re-throws unexpected errors to Fastify's default handler (`apps/server/src/http/errors.ts:53-68`), which answers `error.message`. **Probe:** `{"message":"Injected failure after {\"name\":\"secret-project-name-XYZ\"…}"}` ([#991](https://github.com/ColdPhase/flux/issues/991)) |
| 7.4.2 | Exceptions handled consistently | Pass | One error mapper for every route plugin (`errors.ts:53`) |
| 7.4.3 | Last-resort handler | Pass | Fastify's handler; the process stays up |

## V8 Data protection

| ID | Requirement | Result | Evidence |
| --- | --- | --- | --- |
| 8.1.1 | Sensitive data not cached by intermediaries | Partial | Files and exports send `private, no-store` (`files/routes.ts:46`, `export/routes.ts`). Most API JSON has no `Cache-Control` (**probe** of `/api/v1/workspaces`; [#992](https://github.com/ColdPhase/flux/issues/992)) |
| 8.1.2 | Cached copies purged | Pass | No server-side response cache |
| 8.1.3 | Minimal parameters | Pass | Schemas with `additionalProperties: false` |
| 8.1.4 | Abnormal request volumes detected | Partial | Auth rate limits, live-join limiter; no alerting ([#997](https://github.com/ColdPhase/flux/issues/997)) |
| 8.1.5 | Regular backups | Pass | `docs/operations/backup-restore.md` |
| 8.1.6 | Backups stored securely | Pass (operator) | Hardening item 7: encrypt backups that leave the machine |
| 8.2.1 | Anti-caching headers | **Fail** | As 8.1.1 ([#992](https://github.com/ColdPhase/flux/issues/992)) |
| 8.2.2 | No sensitive data in browser storage | Partial | `localStorage` holds UI preferences and the last asked conversation id; unsaved Wiki text is kept in session or local storage until sent (`apps/web/src/docs/drafts.ts:31-58`) |
| 8.2.3 | Client data cleared at sign-out | Pass | Drafts retired on confirmed sign-out (`apps/web/src/docs/drafts.ts:73-78`, `composer/draft.ts:107`) |
| 8.3.1 | Sensitive data in bodies, not URLs | Pass | Search text is in the query string but never logged (`log-serializers.ts:7-15`). Tokens are never in URLs, except the one-time reset and invite links |
| 8.3.2 | Users can export or delete their data | Pass | Space export (`apps/server/src/export/routes.ts`); account and space deletion (`docs/operations/export.md`, `administration.md`) |
| 8.3.3 | Clear language about data use | Pass | AI use line in DMs (C-2); "Ada · via Assistant"; provider named in Connect AI |
| 8.3.4 | Sensitive data identified | Pass | As 1.8.1 |
| 8.3.5 | Access to sensitive data audited | Partial | Event log of changes (`recordEvent`); no read audit ([#997](https://github.com/ColdPhase/flux/issues/997)) |
| 8.3.6 | Sensitive memory cleared | Partial | Swap refused and core dumps off for key holders (F-030, `ulimits: core: 0`); JavaScript strings cannot be wiped. Zeroing of key buffers not verified |
| 8.3.7 | Encryption with approved algorithms | Pass | As V6 |
| 8.3.8 | Retention | Partial | Push subscriptions, live webhook events (7 days, `app.ts:249-256`) and sessions expire; content is kept until deleted, by design |

## V9 Communication

| ID | Requirement | Result | Evidence |
| --- | --- | --- | --- |
| 9.1.1 | TLS for all client connections | Pass (operator) | API publishes only on `127.0.0.1` (`docker/compose.source.yaml:192`); HTTPS through the operator's proxy (hardening item 1, `docs/operations/reverse-proxy.md`). HSTS guidance missing ([#992](https://github.com/ColdPhase/flux/issues/992)) |
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
| 12.6.1 | Server-side fetches allow-listed | **Partial** | Address guard as 5.2.6 (**probe**). An agent can still choose any public URL and put data in it until #983 ([#953](https://github.com/ColdPhase/flux/issues/953)). Off by default (`FLUX_WEB_READS`, `FLUX_LINK_PREVIEWS`) |

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
| 14.4.3 | Content-Security-Policy | **Fail** | Only `frame-ancestors 'none'` (`http/framing.ts:3-19`): [#979](https://github.com/ColdPhase/flux/issues/979) |
| 14.4.4 | `X-Content-Type-Options: nosniff` | **Fail** | Only on file downloads (**probe**; [#992](https://github.com/ColdPhase/flux/issues/992)) |
| 14.4.5 | HSTS | **Fail** | Not sent and not in the proxy guide ([#992](https://github.com/ColdPhase/flux/issues/992)) |
| 14.4.6 | Referrer-Policy | **Fail** | Not sent ([#992](https://github.com/ColdPhase/flux/issues/992)) |
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
| Sign-up with `password` | 200, session set; the account became company owner (#990) |
| 8 wrong sign-ins, then the right one after 11 s | `401×3`, `429×5`, then 200 (#990) |
| Sign-up with an existing address / reset for an unknown address | 422 `USER_ALREADY_EXISTS…` / 200 generic (#993) |
| Reset with `redirectTo=https://evil.example/steal` | 403 `INVALID_REDIRECT_URL` |
| Cross-origin, origin-less and `same-site` POST with the cookie | 403 `ORIGIN_REJECTED` ×3 |
| Cookie copy after sign-out | 401 |
| `/api/auth/update-user` with `emailVerified:true` | Ignored (`emailVerified` stayed false) |
| OAuth client consent, code exchange and `/mcp tools/list`; password reset; refresh after reset | 200; reset 200 and browser 401; **refresh 200 and `/mcp` 200** (#989) |
| `x-flux-test-fail: 500` on a space creation | The error message with the request body in the response and twice in the log (#991) |
| Headers on `/`, `/api/v1/workspaces`, a 404 | Only `x-frame-options` and `frame-ancestors`; no `Cache-Control` on API JSON (#992) |
| Link cards for `127.0.0.1.nip.io`, `169.254.169.254` and `example.com` | No card, no card, card |
| `TRACE` and cross-origin `OPTIONS` | 404, 404; no CORS headers |
| `text/plain` body to a JSON route | 400 |
| `/api/v1/test/routes` without the fixture bearer | 401 |
