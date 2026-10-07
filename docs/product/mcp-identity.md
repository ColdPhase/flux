# F-024 — MCP sign-in with built-in accounts and external identity providers

**Status: Accepted baseline, 2026-10-06:** @Zamojski5 approved `76ccc6ce` in
[PR #274](https://github.com/ColdPhase/flux/pull/274#pullrequestreview-5423586804),
merged as `a66bb72b240305fcf54c98f92d1634c849898c4e`, with N1–N5 carried by
#310/#311/#313. **Amended 2026-10-07:** the
[founder direction](https://github.com/ColdPhase/flux/issues/249#issuecomment-6042227715)
requires one SSO provider per installation and restores S3 to v0.1; the
[independently assessed decision](https://github.com/ColdPhase/flux/issues/360#issuecomment-6042333778)
narrows S5b/S6 and cancels S7's opaque-key feature. This is a contract, not
implementation or release acceptance.
**Later superseding amendment, 2026-10-07:** [Hubert's current direction](https://github.com/ColdPhase/flux/issues/360#issuecomment-6043340696)
replaces S6 recent-authentication with ordinary owner-controlled MCP capability
switches and selected native projects. No password re-entry, secondary SSO
challenge or ten-minute authentication-age gate. Ordinary authentication is
password-only without active SSO, or sole-IdP SSO-only with it; S5b migration is
before cutover and no longer depends on S6. The earlier assessment is historical;
[the new source assessment](research/2026-10-07-mcp-switches-and-sso-only.md)
records the accepted seams, prerequisites and still-missing implementation.

**Owner:** @PelikanFix16 (`claude-hubert`). **Issue:** [#273](https://github.com/ColdPhase/flux/issues/273).
**Evidence:** [research note](research/2026-10-05-mcp-identity.md), retrieved 2026-10-05;
corrections and closed items re-verified 2026-10-06 (its last section). Labels
[S] specification, [V] vendor documentation, [C] code read at a pinned revision,
[O] observed response and [I] inference are as defined there.
The [earlier same-day necessity assessment](research/2026-10-07-single-provider-identity-scope.md)
keeps its source facts and recommendation as history. The later founder amendment
and [current source assessment](research/2026-10-07-mcp-switches-and-sso-only.md)
govern ordinary capability controls and exclusive modes; no runtime completion is claimed.

**Founder direction** (Hubert / @PelikanFix16, 2026-10-05, relayed by
`claude-hubert`, recorded in [#272](https://github.com/ColdPhase/flux/issues/272)
item 6):

> "MCP musi mieć zaprojektowane jawne obejścia — co jak postawimy Fluxa w OIDC,
> Keycloak itd.? albo inny provider?"

In English: MCP needs an explicitly designed path for deployments where people
sign in to Flux through OIDC (Keycloak or another identity provider).

**Scope.** This is mode (b) of [F-022](ai-modes.md) (accepted 2026-10-05):
Claude Code, Codex, Cursor or another MCP client on the person's computer
connects to Flux's MCP endpoint. Standing also governs the person's automation in
mode (a) ([MCPID-5](#standing-governs-all-of-the-persons-automation)). It builds on
[O-005](first-agent-path.md), the
[agent connection contract](../development/agent-connection.md) and
[F-016](mcp-cowork.md). It extends the human single sign-on of
[#240](https://github.com/ColdPhase/flux/pull/240) / [#113](https://github.com/ColdPhase/flux/issues/113),
which is merged, and relies on the client-registration and consent rules of
[#294](https://github.com/ColdPhase/flux/pull/294) / [#287](https://github.com/ColdPhase/flux/issues/287),
also merged. These supply the existing human sign-in and consent seams; the
F-024 [slices](#implementation-slices) still require implementation and pinned
independent evidence. One SSO provider does not limit AI compute providers or
the number of owner-authorized agent connections.

**Unchanged:** F-019 owner-only use, per-connection consent, scope ceilings,
per-call rechecks of grants, the tool contract ([O-010](extension-contracts.md)),
and no provider credential in Flux.

## The decision in short

1. **Flux stays the only authorization server for its MCP endpoint.** The identity
   provider (IdP) only signs the person in, inside Flux's own authorization step.
   MCP clients get Flux tokens bound to `<origin>/mcp`. Flux never accepts an IdP
   token at `/mcp`, and an IdP token never leaves the Flux server
   ([MCPID-1](#mcpid-1--flux-stays-the-mcp-authorization-server)).
2. **The MCP sign-in page offers the IdP.** The IdP round trip keeps the client's
   signed authorization request, so `claude mcp login` or `codex mcp login` works
   for a person who has only an IdP account. Consent then shows where access goes
   (#294); with single sign-on it is the only step where the person approves a
   client ([MCPID-2](#mcpid-2--signing-in-during-mcp-authorization)).
3. **Accounts are keyed by issuer and subject, never by email.** Each installation
   configures one provider. Attaching that identity to an existing account is an explicit, signed-in
   action before SSO-only cutover, bound to the existing account/session and a
   verified provider round trip. With active SSO, ordinary password sign-in,
   sign-up/reset and password-only authority are refused; new accounts come
   through the IdP. Collision/verification/offboarding safeguards remain ([MCPID-3](#mcpid-3--several-providers-and-account-linking)).
4. **Supported personal clients use Flux OAuth.** SSH and remote machines retain
   the clients' own paste-back or callback options. S7's extra opaque-key minting,
   storage, settings and bearer surface is canceled; fully unattended CI or a
   client unable to complete supported OAuth is not an admitted v0.1 journey.
   There is no device flow yet
   ([MCPID-4](#mcpid-4--clients-headless-machines-and-ci)).
5. **The IdP governs a managed account's access, including its automation.** Flux
   re-checks the person with the IdP every 15 minutes using an offline refresh token
   held only by the server and kept out of backups. A refusal puts the identity in
   **sign-in required**: the person's browser sessions end, and their MCP grants,
   run tokens and owner compute are refused, not revoked, until they
   sign in through the IdP again.
   A back-channel logout triggers an immediate check; one that asks to revoke
   offline access revokes the identity's MCP grants. Without any signal,
   access stops when the IdP's last confirmation is 7 days old
   ([MCPID-5](#mcpid-5--lifetimes-standing-and-how-access-ends)).
6. **Owner capability controls.** S6 stores owner-only switches for real MCP
   capabilities and selected native projects in the ordinary valid session. The
   server intersects them with current owner/agent rights, bounded grants and
   the original OAuth/connection consent; a switch never creates authority.
7. **Release position.** v0.1.0 requires S1, S4, S2, S5a, S3, exclusive-mode S5b
   and capability-control S6. S7 is canceled, not delivered or promised after v0.1
   ([slices](#implementation-slices)).

**Rejected:** the IdP as the MCP authorization server, accepting or forwarding IdP
tokens, and linking accounts by email. **Deferred:** the device authorization
grant, enterprise-managed authorization (ID-JAG), SCIM, shared-signal receivers
and a path-prefix deployment ([Rejected and deferred](#rejected-and-deferred)).

## Terms

- **Account.** One Flux person (`auth_users`).
- **Identity.** One way to sign in to an account. It is either the account's
  password or one provider identity, keyed by the provider id (derived from the
  issuer, #240) and the OIDC `sub`.
- **Provider.** An OIDC identity provider configured by the operator.
- **Authoritative provider.** A provider whose decisions govern every account
  linked to it. This is the default for an operator's own IdP.
- **Managed account.** An account with an identity at an authoritative provider.
- **Connection.** One owner's named agent connection: selected projects, scopes and
  standing grants (#52, #152).
- **MCP grant.** One OAuth authorization of one client for one connection: its
  refresh-token family and the access tokens issued from it.
- **Confirmation.** The last time the provider vouched for the identity, through a
  sign-in or a successful standing check.
- **Standing.** Whether the account may be served now. Flux evaluates it on every
  request and before every start of the owner's automation.
- **Sign-in required.** The state of an identity whose IdP refused Flux's offline
  token, or for which Flux holds none. It suspends access without revoking
  anything; the next successful sign-in through that identity clears it.

## MCPID-1 — Flux stays the MCP authorization server

### Options

| Option | How it works | Verdict |
| --- | --- | --- |
| **A. Flux is the authorization server; the IdP signs people in** | Protected-resource metadata names Flux's issuer `<origin>/api/auth`. The authorization step signs the person in through the IdP, then runs Flux's own connection choice and consent. Flux issues a JWT with `aud` = `<origin>/mcp` and a Flux refresh token | **Recommended** |
| B. The IdP is the authorization server; Flux validates IdP tokens | Protected-resource metadata names the IdP (for example the Keycloak realm). Clients register and get tokens there. Flux validates the IdP's JWT, issuer and audience | Rejected |
| C. Flux accepts IdP tokens and exchanges them | Clients send an IdP access token, or Flux trades one for its own token (RFC 8693) | Rejected |
| D. Enterprise-managed authorization (ID-JAG) | The client gets an identity assertion grant from the IdP and presents it to Flux's authorization server (RFC 7523). Flux still issues the token | Deferred; it adds to A |

### Why A

The deciding reasons are the per-connection binding, Flux's consent model and
built-in accounts. B is possible with some IdPs; it is not chosen because of what
it loses.

- **Flux keeps its per-connection binding and consent.** The token carries a Flux
  connection id and a grant reference. The consent page names the client, the
  connection, the projects and the scopes, and shows where access goes (#294).
  Revoking a connection or a standing grant applies at the next call. An IdP cannot
  express "Hubert / Codex for projects X and Y with execute scope", so B would need
  a second, Flux-side binding step after the IdP's consent.
- **Built-in accounts need A anyway.** B would leave two authorization servers to
  build, test and explain.
- **It meets the MCP rules with one code path.** MCP 2026-07-28 requires the
  server to "validate that access tokens were issued specifically for them as the
  intended audience". It says "MCP servers **MUST NOT** accept or transit any other
  tokens". The authorization server "may be hosted with the resource server or a
  separate entity". Under A, Flux is the issuer and the audience. The same
  discovery, CIMD, PKCE S256, `resource`, `iss` and rotating refresh tokens serve
  built-in accounts and every IdP. These are implemented and tested today
  ([agent connection](../development/agent-connection.md#identities-and-consent)).
  RFC 7591 registration is off; #294 also removes session-created clients.
- **It asks the least of each IdP.** Under A, the IdP only has to do an ordinary
  OIDC sign-in for one confidential web client. B needs per-IdP work, and the
  standard MCP path is not available everywhere:
  - **Keycloak 26.8.0** can do B without experimental features. A client scope
    with an `Audience` mapper puts Flux's audience in the token. Its MCP guide
    says that without the resource-indicator feature "you can use OAuth 2.0's
    `scope` parameter instead of the `resource` parameter". Clients are
    pre-registered, or registered dynamically once the operator allows it
    (anonymous registration is off by default). Resource indicators, CIMD and MCP
    2026-07-28 support are marked "Experimental". So B on Keycloak works, but
    through per-client setup rather than CIMD.
  - **Entra ID** publishes no RFC 7591 registration endpoint.
  - **Google and GitLab** offer no way to register Flux as a resource that
    receives their access tokens (an inference from their documentation).
- **MCP clients never contact the IdP.** The person's browser and the Flux server
  do. An IdP reachable only on a company network or VPN still works for a person
  using that network.

### Why not B

B's one advantage is that offboarding becomes the IdP's job: refresh fails at
the IdP. [MCPID-5](#mcpid-5--lifetimes-standing-and-how-access-ends) gets the same
result under A with a server-side standing check. B's costs:

- per-IdP client registration and audience setup: pre-registration or an IdP's
  own registration policy, because CIMD and resource indicators are experimental
  (Keycloak) or missing (Entra registration);
- no Flux connection or project binding in the token;
- Flux tokens and IdP tokens at the same endpoint;
- a second consent model;
- discovery that changes whenever the operator changes the IdP. MCP 2026-07-28
  makes clients key credentials by issuer and re-register when it changes.

### Why not C

Accepting an IdP access token at `/mcp` is the token passthrough the MCP
specification forbids. An IdP token is issued for some other audience. Exchanging
any IdP token for a Flux token removes Flux's per-client consent. It also invites
the confused-deputy pattern that the MCP security guidance describes for proxies
in front of a static upstream client.

### Confused-deputy guard under A

Flux uses one static client at the IdP for every MCP client, which is the shape
the MCP security guidance warns about. Flux keeps the required per-client consent:

- the consent page appears for every new client and connection, with the signed,
  request-bound OAuth query (#52);
- an IdP session cookie only signs the person in; it never approves an MCP client;
- the IdP `state` and nonce are Flux's own and are bound to the browser.

With single sign-on the person often types nothing: the IdP session signs them in
silently. Consent is then the only step where a person approves a client, so it
must show what the MCP rules require. [#294](https://github.com/ColdPhase/flux/pull/294)
(#287) implements this for every sign-in method, and S1 requires it on the IdP path:

- **Where access goes.** The host of the signed request's `redirect_uri`. MCP
  2026-07-28 security considerations: authorization servers "**MUST** clearly
  display the redirect URI hostname during authorization". The best-practices
  consent rules ask to "Show the registered `redirect_uri` where tokens will be
  sent".
- **Who the client is.** The client name is self-asserted, so consent also shows
  the host of a CIMD `client_id`, or "Registered on this Flux server" for an
  operator pre-registered client.
- **Warnings.** A warning when the redirect is not loopback (#294). For a loopback
  redirect, the same security considerations say authorization servers "**SHOULD**
  display additional warnings for `localhost`-only redirect URIs", because a CIMD
  document cannot stop a local program from claiming another client's name. S1
  adds a line for loopback redirects: access goes to a program on this computer,
  identified by the `client_id` host shown.
- **No framing.** The best practices require to "Prevent iframing via
  `frame-ancestors` CSP directive or `X-Frame-Options: DENY`". #294 sends
  `X-Frame-Options: DENY` on every response, and `frame-ancestors 'none'` unless a
  route sets its own policy.

## MCPID-2 — Signing in during MCP authorization

### Case 1: built-in accounts (today)

1. The client calls `/mcp` without a token and gets 401 with
   `WWW-Authenticate: … resource_metadata=…`.
2. It reads `/.well-known/oauth-protected-resource/mcp`, then
   `/.well-known/oauth-authorization-server/api/auth`.
3. It identifies itself with a CIMD `client_id`, or uses a client the operator
   pre-registered (RFC 7591 registration is off; #294). It opens the browser at
   `/api/auth/oauth2/authorize` with PKCE S256 and `resource=<origin>/mcp`.
4. Without a session, Flux shows `/login` with the signed OAuth query. The person
   signs in with email and password.
5. `/connect-agent` asks which connection this client gets. The consent page then
   shows the client, connection, projects and scopes, and where access goes
   ([above](#confused-deputy-guard-under-a)).
6. Flux redirects to the client's loopback callback with `code` and `iss`. The
   client redeems the code for a JWT access token (1 hour) and a rotating refresh
   token.
7. Every MCP request: Flux verifies the JWT locally, then reloads the connection,
   its grants and the owner's current access.

### Case 2: operator OIDC

PR #240 adds one provider for browser sign-in. Its head `9aa90409` (re-read
2026-10-06) shows the single sign-on button on `/sign-in` but **not on `/login`**,
the page where the MCP authorization step lands
(`app/apps/web/src/auth/pages.tsx:143`). This is a deliberate guard: the button as
it is would return the person to `/login` signed in, without resuming the
authorization. #240's operator guide documents the interim workaround: sign in at
`/sign-in` in the same browser first, then run the client's login again. Slice S1
closes this gap. The flow becomes:

1. Steps 1–3 as in case 1.
2. `/login` shows `Sign in with <label>` for each provider, plus the password form
   when password sign-in is on.
3. Choosing the provider sends the signed OAuth query with the social sign-in
   request. Better Auth 1.7.6 carries `oauth_query` through `/sign-in/social` and
   back from the provider callback, and resumes the authorization after sign-in.
   No upstream test exercises that branch, so S1's Keycloak-backed MCP test is the
   proof. The query is checked by the same `oauth_query` verifier as the password
   path, and is never an open redirect. Flux then redirects to the IdP with PKCE,
   `state`, nonce and the scopes `openid email profile offline_access`
   (`offline_access` only when the standing check is on).
4. The person signs in at the IdP. MFA and conditional access stay the IdP's job.
5. The IdP returns to `/api/auth/callback/<providerId>`. Flux verifies:
   - `state` and PKCE;
   - the ID token's signature, `iss`, `aud`, `exp` and nonce;
   - the verified-email rule ([provider profiles](#provider-profiles)).

   It finds or creates the account by (provider id, `sub`). It records the
   session's identity, IdP `sid` and confirmation time. It keeps the IdP refresh
   token encrypted, outside backups, and discards the IdP access and ID tokens
   ([IdP tokens](#idp-tokens-at-rest-and-in-backups)). It then continues to
   `/connect-agent` and consent.
6. Steps 6–7 as in case 1. The grant records how the person signed in (password
   or provider id) and when.

**When the IdP step fails** (the person cancels, the IdP returns an error, or a
callback check fails), Flux returns to `/login` with the same signed OAuth query
and a message, so the person can try again or choose another method. #240's
browser sign-in returns to `/sign-in?sso=failed`; that address would drop the
authorization request, so S1 gives the MCP path its own error return.

The person's IdP tokens stay on the server. The MCP client only ever sees Flux's
code and tokens.

### Redirect URIs for MCP clients

Flux's redirect rules are those of Better Auth 1.7.6's OAuth provider, observed in
its source (`packages/oauth-provider/src/authorize.ts:257-262` and
`register.ts:197-222` at `v1.7.6`). They are unchanged by F-024 and stated here so
S1 tests them on the IdP path:

- **Loopback:** a registered `http` redirect to `localhost`, `127.0.0.1` or `[::1]`
  (the only hosts allowed with plain `http`) matches a request on any port; scheme,
  host and path must match exactly. RFC 8252 §7.3: "The authorization server MUST
  allow any port to be specified at the time of the request for loopback IP
  redirect URIs".
- **`localhost`:** RFC 8252 §8.3 says "the use of localhost is NOT RECOMMENDED",
  but Flux must accept it. Claude Code uses "a pre-registered redirect URI of the
  form `http://localhost:PORT/callback`", and Cursor's desktop app uses
  `http://localhost:8787/callback`. Codex uses
  `http://127.0.0.1:<port>/callback/<callback_id>`.
- **Everything else** (an `https` address or an app's private-use scheme) must
  match a registered redirect exactly. Consent warns about it (#294).
- **Flux's own redirect at the IdP** (`<origin>/api/auth/callback/<providerId>`) is
  a fixed `https` address registered at the IdP. It has nothing to do with MCP
  clients.

<a id="password-sign-in-on-or-off"></a>
### Exclusive ordinary sign-in modes

Active SSO means the operator-activated authentication mode, not the provider's
momentary health. Failed discovery or an IdP outage must not silently switch
that mode to password login.

- **Without active SSO:** password-only ordinary authentication. The existing
  password-mode account/signup/verification/reset protections apply.
- **With active sole-provider SSO:** ordinary `/sign-in` and MCP `/login` use
  that IdP alone. Refuse password sign-in/signup/reset and password-only
  session/authority continuation at the server; hiding forms is insufficient.
  New SSO accounts are created through the verified IdP flow without setting a
  Flux password. A provider outage is an honest unavailable state, not password
  fallback.
- **Migration before activation:** with the provider prepared for migration,
  the already authenticated existing account completes its verified provider
  round trip bound to the same account/session and intent. Preserve Flux IDs,
  private data, roles, memberships and applicable grants. This is a migration
  phase, not ordinary combined password/SSO login, and has no recent-auth gate.
- **Cutover/recovery:** do not silently strand required accounts. Define and test
  the audited host-operator recovery/re-key path, including obsolete-credential
  revocation and lockout handling. Recovery is not an ordinary password form,
  password reset or bypass while SSO is active. It does not auto-link by email.
- The earlier independent `FLUX_PASSWORD_SIGN_IN` on/off and verified-password-
  signup-with-active-SSO proposals are superseded. Compatibility settings cannot
  permit ordinary mixed login. Exact activation/recovery configuration requires
  the S5b implementation; no working mode switch is claimed here.

<a id="mcpid-3--several-providers-and-account-linking"></a>
## MCPID-3 — One provider and safe account migration

### One configured provider

- Keep #240's single issuer, client id, label and secret configuration. There is
  no provider-list file, simultaneous selection or multi-provider standing policy.
- The provider id remains derived from its issuer; an identity is always bound
  to that issuer and `sub`, never to its email address alone.
- `/sign-in` and `/login` use only the active provider; without active SSO they
  use password mode. Prepared-provider migration is separately bound and explicit.
- Preserve the authoritative provider's standing/offboarding rules and scoped
  operator recovery safeguards. No setting turns SSO-only into ordinary mixed
  authentication or makes a managed account bypass its provider through a password.

### Linking: issuer and subject, never email alone

| Rule | Decision |
| --- | --- |
| Account key | (provider id, `sub`), as in #240. The same `sub` is the same person even when the email or name changes |
| Automatic linking by verified email | **Rejected.** A second provider, or a tenant admin, can assert any address. Entra's `email` "isn't guaranteed to be correct and is mutable over time". A takeover would carry the account's MCP grants, private notes and connections. #240 already refuses a new identity whose email belongs to another account; S5a narrows that to verified emails ([below](#password-sign-up-reset-and-email-collisions)) |
| Explicit conversion | Before SSO-only activation, the authenticated existing-account owner completes the sole prepared provider's verified round trip bound to that same account/session and intent. Preserve Flux account ID, private data, roles, memberships and applicable grants. Reject duplicate/substituted identity and email auto-linking. No secondary password/SSO challenge, authentication-age window or S6 dependency |
| Lockout and offboarding | An authoritative identity cannot be detached by its owner to evade offboarding. The last usable sign-in method cannot be removed. Any retained removal path is confined to the sole provider and applicable password mode; this is not general multi-identity management |
| Migration and recovery | The operator can re-key the sole provider identity after an issuer or subject change. Preserve the Flux account and history; audit old/new issuer and subject, end obsolete sessions and revoke old MCP authority and refresh credentials. It is recovery of the same account, not automatic data transfer by email |

### Standing for the sole provider

- **Managed account** (linked to the authoritative configured provider):
  - every request requires that its provider identity is not in
    [sign-in required](#standing-check-s4);
  - that identity's confirmation must be within the
    confirmation age;
  - it signs in only through a provider. Its password, if it has one, is kept but
    refused while the account is managed, so a password is no way around the IdP's
    MFA or offboarding.
- **Password-mode account:** while there is no active SSO, ordinary password
  authentication follows its existing rules. After SSO-only activation, an
  account without the required provider mapping has no continuing password-only
  authority; migration or audited host recovery is required. This changes neither
  issuer/subject identity nor managed-account standing/offboarding gates.

### Password sign-up, reset and email collisions

Observed on `main` `698313b3` and #240 `9aa90409`:

- password sign-up needs no email verification (`auth.ts`, `emailAndPassword`
  without `requireEmailVerification`);
- adding a workspace member by email matches any account with that address,
  verified or not (`app/packages/core/src/access/domain.ts:245`);
- #240 refuses a provider identity whose email belongs to an existing account;
- Better Auth's `resetPassword` creates a password for an account that has none
  (`packages/better-auth/src/api/routes/password.ts` at `v1.7.6`).

Together, someone could sign up with an employee's address before that employee's
first single sign-on. The employee's sign-in would then be refused, and a member
added by that address would be the squatter. A reset could also give an IdP-only
person a password that skips the IdP's MFA. With any provider configured, these
rules apply:

| Rule | Decision |
| --- | --- |
| Password sign-up | Only in password mode, with its account/email-verification safeguards. With active SSO, ordinary password signup is refused; verified IdP signup creates SSO accounts. The old `verified` password-signup-with-active-SSO flow is superseded |
| Adding a member by email | Matches only an account whose email is verified. Otherwise the answer is the same `ACCOUNT_NOT_FOUND` as for no account |
| Provider identity, email held by a **verified** account | Refused, as in #240. The page explains explicit pre-cutover conversion or audited operator recovery; it never transfers data or offers a password fallback in SSO-only mode |
| Provider identity, email held by an **unverified** account | The unverified account never blocks it. Offer safe pre-cutover conversion/recovery or the bounded address claim, consistent with the active mode; never suggest ordinary password login with SSO. Claiming releases the address from the unverified account: its email becomes `unverified-<account id>@invalid` (the `.invalid` top-level domain of RFC 2606), its sessions and MCP grants end, and an audit event names both accounts. Flux then creates the provider account. The released account keeps its data; the operator's re-key command can attach an identity to it later |
| Password reset | Password mode only; never creates a password for an account without one. Refused for managed accounts and every ordinary SSO-only password-reset attempt |
| Password sign-in with SSO | Refused at UI/API/session boundaries while sole-provider SSO is active. Scoped host recovery is audited and separate; it cannot become ordinary password fallback or bypass offboarding |

Without any provider, adding a member by email still matches unverified accounts.
That gap predates F-024 and is outside it; it needs its own issue.

## MCPID-4 — Clients, headless machines and CI

### Client matrix

From vendor documentation read on 2026-10-05 and re-checked on 2026-10-06; Flux
has run only the clients noted. Flux offers CIMD and operator pre-registration, not
RFC 7591 registration (#294).

| Client | OAuth to Flux | Static header | Headless / SSH | Device grant |
| --- | --- | --- | --- | --- |
| Claude Code | Yes. `/mcp` or `claude mcp login`; CIMD; `--client-id`/`--callback-port` for a pre-registered client. Redirect `http://localhost:PORT/callback`. Run against Flux with versions 2.1.281 and 2.1.283 ([evidence](../development/agent-connection.md#identities-and-consent)) | `--header "Authorization: Bearer …"`, or `headersHelper` for a short-lived token | Over SSH `claude mcp login` prints the URL, and the person pastes the redirect URL back | Not documented (request #20215 closed as a duplicate) |
| Codex | Yes. `codex mcp login`; CIMD; a configured client id "always takes precedence and skips client registration". With pre-registration and Flux's advertised issuer/`authorization_response_iss_parameter_supported`, the stable loopback path is `/callback`; `/<callback_id>` applies without that support. Register the exact callback Codex displays (accepted [#310 N2](https://github.com/ColdPhase/flux/issues/310)) | `bearer_token_env_var`, `http_headers`, `env_http_headers` | `mcp_oauth_callback_port` or `mcp_oauth_callback_url` | Not documented |
| Cursor | Only with a pre-registered client: its docs offer "static OAuth client credentials" instead of dynamic registration and do not mention CIMD | `headers` with `${env:…}` | Not documented | Not documented |
| Other MCP clients | Through the MCP authorization specification | Varies | Varies | Not in the MCP specification |

Under A, an IdP changes nothing for the client. Only the browser step differs.

### Connection access keys (header-only clients and CI)

**Canceled, 2026-10-07; #317 is closed as `not_planned`.** No additional opaque
Flux key, key-management UI, key bearer handler or operator key setting is
required or implemented. The earlier proposal remains in the dated research;
O-005 continues to require Flux OAuth and owner-bound per-request checks.

Official MCP documentation and SDKs already provide client-credentials
mechanisms; the extension repository's release label differs. Their absence is
not the reason for cancellation. The reason is that no admitted current
header-only/CI consumer needs a second credential surface. See the
[assessment and counter-evidence](research/2026-10-07-single-provider-identity-scope.md).
Reconsider only a concrete consumer with bounded principal, owner/grants,
lifetime, custody, offboarding and tested compatibility. A machine principal
would need its own F-019-compatible decision, not a shared human credential.

### Headless and remote machines

For the supported personal clients, retain and test:

**The client's own flow.** Over SSH, `claude mcp login flux` prints the
authorization URL. Open it on the laptop, sign in (through the IdP if
configured), approve, and paste the full redirect URL back at the prompt.
Codex: set `mcp_oauth_callback_port` and forward it with
`ssh -L <port>:127.0.0.1:<port>`, or set `mcp_oauth_callback_url`. Preserve the
accepted loopback-port rule (RFC 8252) and the client's displayed redirect for
pre-registration; #310/#152 still require supported-client integration evidence.

An interactive owner may authorize first and then run the client non-interactively
within that existing grant. Fully unattended first authorization and clients
unable to complete supported OAuth are not advertised as v0.1-compatible. Remote
location alone does not require another bearer-key mechanism.

The device authorization grant (RFC 8628) is not offered yet:

- neither Claude Code nor Codex documents it for MCP servers;
- the MCP specification does not mention it, and SEP-2059 (device flow for stdio
  servers) was closed unmerged;
- RFC 8628 §5.4 warns that a code sent to a victim can authorize an attacker's
  device.

Better Auth 1.7.6 includes a device-code extension, so Flux can add the grant
when a supported client implements it. Its consent page must name the client and
show the code.

## MCPID-5 — Lifetimes, standing and how access ends

### Lifetimes

"Today" was observed on `main` `698313b3`, `app/apps/server/src/identity/auth.ts`,
using the defaults of Better Auth 1.7.6, whose source was read at `v1.7.6`.

| Credential | Today | With F-024 |
| --- | --- | --- |
| Authorization code | 10 minutes, one use | Unchanged |
| MCP access token (JWT, `aud` = `<origin>/mcp`) | 1 hour; every request rechecks the connection and grants | Unchanged; every request also checks standing |
| MCP refresh token | 30 days, rotated on every use, with a new 30-day expiry each time (sliding); 30-second retry window | Unchanged for unmanaged accounts. For a managed account, refused while it is in sign-in required or once the confirmation is older than the confirmation age |
| Browser session | 7 days, extended on use (Better Auth default; not overridden) | Also ends with standing; back-channel logout ends the matching sessions |
| F-022 run token | — (accepted, not built) | No longer than the run timeout ([AIM-3](ai-modes.md#agent-connection-and-permissions)); minting it and every request check standing |
| IdP ID and access tokens | #240 keeps Better Auth's default, which stores them in `auth_accounts` unencrypted (below) | Not kept: cleared after the callback; never used for MCP |
| IdP refresh token (offline) | — | Kept only for the standing check, encrypted, in its own table that backups and exports leave out. Used only against that IdP's token and revocation endpoints. Never sent to a client or logged |

### IdP tokens at rest and in backups

- **Today.** `auth_accounts` has `access_token`, `refresh_token` and `id_token`
  columns. Better Auth 1.7.6 stores OAuth tokens there unencrypted unless
  `account.encryptOAuthTokens` is set. Its documentation says only "Encrypt OAuth
  tokens before storing them in the database. Default: false". #240 at `9aa90409`
  does not set it. That it stores Keycloak's tokens this way is an inference from
  the code, not an observed row.
- **Why `encryptOAuthTokens` is not enough.** Its code encrypts the access and
  refresh tokens with XChaCha20-Poly1305 under a key that is the SHA-256 of the auth
  secret, and stores the ID token unencrypted [C]. A JSDoc comment in its options
  says AES-256-GCM; the code does not. Flux's auth secret is
  `FLUX_AUTH_SECRET`, and every backup archive holds `flux.env`, which contains it
  ([backup and restore](../operations/backup-restore.md)). Encrypted columns in the
  archive's database dump would decrypt with the archive's own secret.

F-024 therefore:

1. **Keeps only the IdP refresh token.** After the callback, Flux records what it
   needs from the ID token (`sub`, `sid`, the verified email and the
   name) on the identity and the session. It keeps neither the IdP access token nor
   the ID token. Better Auth 1.7.6 has no option to skip storing them
   (`updateAccountOnSignIn` only stops updates to an existing account), so S1 takes
   them out before the account row is written, for example in Better Auth's account
   database hooks [I].
2. **Stores the refresh token in its own table** (for example
   `auth_idp_refresh_tokens`), encrypted with a key derived from `FLUX_AUTH_SECRET`
   for this use only. The encryption protects a database copy made without
   `flux.env`, such as a hand-made dump or a replica.
3. **Leaves it out of backups and exports.** `./flux backup` dumps that table's
   definition but not its rows (`pg_dump --exclude-table-data`). No export includes
   it.
4. **Restores without it.** After a restore no identity has an IdP refresh token,
   so each managed identity whose provider uses the standing check is in
   [sign-in required](#standing-check-s4) until the person signs in through the
   provider again. This is stricter than "unknown": a person disabled at the IdP
   between the backup and the restore gets nothing back.

The access-token lifetime is not what limits revocation in Flux: each request
reloads the connection and standing from the database. Shortening the JWT would
add refreshes without ending access sooner.

### Standing check (S4)

Default `FLUX_OIDC_STANDING=refresh`, interval 15 minutes.

1. **Offline token.** At IdP sign-in, Flux asks for `offline_access`. It keeps the
   newest offline refresh token per identity and revokes the one it replaces at
   the IdP (RFC 7009), so offline sessions do not pile up.
2. **Where it runs.** In the `api` service, as a timer like its existing live
   session sweep and recovery timers (`app/apps/server/src/app.ts`). The `api`
   already holds what the check needs: the database, the provider settings, the
   OIDC client secret file that #240 mounts on `api` only, and `FLUX_AUTH_SECRET`
   for the token key. The `worker` gets no IdP secret; it reads the stored standing
   when it [starts owner compute](#standing-governs-all-of-the-persons-automation).
3. **What it checks.** Each identity that has a live browser session, MCP grant or running run, once its last check is older than the interval. It
   claims identities with `FOR UPDATE SKIP LOCKED`, so two `api` replicas never
   check one identity at once and a rotating refresh token is never raced. Each
   check is a `refresh_token` grant at the IdP's token endpoint, authenticated as
   Flux's client.
4. **Outcomes:**
   - **Success.** Confirmation becomes now. A rotated refresh token is stored in the
     same transaction that records the check; only then does Flux forget the
     previous one. Name and verified email update from a returned ID token.
   - **`invalid_grant`: sign-in required.** The IdP no longer honours Flux's
     offline token. Keycloak 26.8.0 answers this way for a disabled user ("User
     disabled") and a removed offline session ("Offline user session not found")
     [C]. Entra stops issuing tokens after an admin clears "Account enabled" and
     revokes sessions [V]. But `invalid_grant` has other causes too [C]: an IdP
     maximum on offline sessions (Keycloak's "Offline Session Max Limited", off by
     default, answers "Offline session not active"), the person removing Flux's
     access in the IdP's account console (Keycloak's "Remove access" revokes the
     offline token), or a lost response to a single-use refresh token. So it does
     not revoke anything; it suspends.
   - **Network error, timeout, 5xx or `invalid_client`: unknown.** Confirmation is
     unchanged, and the confirmation age decides. A lost response is retried with
     the previous token, which the IdP still accepts when it does not make refresh
     tokens single-use (Keycloak's realm setting "Revoke Refresh Token", off by
     default; the worked example keeps it off).
   - **No stored refresh token** (after a restore, or when the IdP returned none):
     sign-in required.
5. **Sign-in required at an authoritative provider:**
   - Flux deletes the account's browser sessions;
   - MCP requests with any bearer (OAuth token, run token) get 401
     `invalid_token`, and the refresh grant gets `invalid_grant`;
   - owner compute stops ([below](#standing-governs-all-of-the-persons-automation));
   - nothing is revoked: MCP grants, connections and standing grants
     stay the owner's and are only refused.
6. **A successful sign-in through that identity** clears the state. Retained MCP
   grants become usable again, a client that kept its refresh token can refresh, and a client that
   re-authorizes finds its connection preselected.

The 401's `error_description` names the provider: `Sign in again with <label>.`
RFC 6750 §3 allows only the characters `%x20-21 / %x23-5B / %x5D-7E` there, so Flux
drops every other character of the operator's label (including `"` and `\`). If
nothing is left, it says "your identity provider". The JSON body may carry the
label unchanged.

The request path never calls the IdP. It reads the stored standing, so an IdP
outage adds no latency to MCP calls.

`FLUX_OIDC_STANDING=off` is for providers that issue no usable offline refresh
token. Then only back-channel logout and the confirmation age apply.

### Standing governs all of the person's automation

Foundation §8.15 requires that access can be taken away effectively "również
aktywnej automatyzacji" (also from running automation). Standing is therefore part
of "owner access" wherever Flux already rechecks it:

- **Every `/mcp` request, whatever the bearer:** an OAuth access token or an F-022 mode (a) run token (`flux_run_id`), which uses the same route.
- **Minting a run token** ([AIM-3](ai-modes.md#run)): the worker mints none for an
  account without standing.
- **Owner compute in the worker:** O-007 background comparisons recheck owner access
  "before dispatch and commit", and an O-008 personal run "stops before its next
  read, dispatch or commit when the owner … loses access". F-022's `server` and
  `runtime` runs follow the same rule. Standing joins each of these rechecks.
- **A running `runtime` run:** its next MCP call is refused, and the worker stops
  the run as for a revoked connection.

The worker reads standing from the database; it never calls the IdP.

### Confirmation age (S2)

`FLUX_OIDC_CONFIRMATION_MAX_AGE`, default `7d`, allowed `1h`–`30d`.

- A managed account is served only while its sole provider identity's confirmation is
  within this age.
- With the standing check on, confirmation renews every 15 minutes, so the age only
  matters while the IdP cannot be reached.
- With the standing check off, this age is the guaranteed offboarding bound.
- When it passes:
  - browser sessions return to sign-in;
  - MCP requests get 401 `invalid_token`, and the refresh grant gets `invalid_grant`;
  - the client re-runs authorization, which goes through the IdP;
  - the `/connect-agent` step preselects the connection this client held, so the
    person does not set it up again.
- S2 lands only after S4. Without the standing check, nothing renews confirmation
  between sign-ins, and every managed account would have to re-authorize its
  clients every 7 days.

### Back-channel logout (S3)

- **Endpoint.** `POST <origin>/api/v1/identity/oidc/<providerId>/backchannel-logout`,
  a dedicated route in the server's identity module. It is not under `/api/auth/`,
  because the bridge forwards every `/api/auth/*` request to Better Auth
  (`app/apps/server/src/identity/bridge.ts`). Like the GitHub and LiveKit webhooks
  (`/api/v1/integrations/github/webhook`, `/api/v1/internal/livekit/webhook`), it
  takes no session; the logout token is its only credential.
- **Validation.** Flux validates the logout token as OIDC Back-Channel Logout 1.0
  §2.6 requires:
  - the signature, from the provider's JWKS (`alg` none refused);
  - `iss`, `aud` (Flux's client id), `iat` and `exp`, with 60 seconds of clock
    tolerance;
  - the `events` member `http://schemas.openid.net/event/backchannel-logout`;
  - a `sub` or a `sid`, and no `nonce`;
  - `jti` not seen before (kept until the token's `exp`).

  It answers 200 on success and 400 otherwise, with `Cache-Control: no-store`
  (§2.8: the response "SHOULD include the Cache-Control HTTP response header field
  with a no-store value").
- **Effect:**
  - with a `sid`, Flux ends the browser sessions created from that IdP session;
  - with only a `sub`, it ends all of that identity's browser sessions;
  - either way, it **queues an immediate standing check**.
- **A plain logout does not stop agents.** MCP grants are offline grants, and the
  specification says refresh tokens issued with `offline_access` "normally SHOULD
  NOT be revoked". Keycloak keeps the Flux client's offline session after a normal
  logout, so the immediate check succeeds and agents continue. The check stops them
  only when the IdP no longer honours Flux's offline token.
- **`revoke_offline_access`.** With the client setting "Backchannel logout revoke
  offline sessions" on, Keycloak adds `"revoke_offline_access": true` to the logout
  token's `events` object, next to the back-channel logout event [C]. Keycloak does
  not end the Flux client's offline session itself: a normal logout keeps offline
  sessions, and Keycloak's own handling of the flag applies only when it receives a
  logout token as a broker. Flux therefore honours the flag:
  - it revokes the MCP refresh tokens of the account when it is
    managed, or those created through that identity when it is not;
  - it revokes its own IdP refresh token at the IdP and deletes it, so the identity
    is in sign-in required until the next sign-in.

  This is a revocation, not a suspension: clients must be authorized again.
- **Support differs.** Keycloak, Authentik and Zitadel send logout tokens. Zitadel
  sends one only when a session is terminated or the user signs out, not when a
  user is deactivated [C]. Entra, Google, Okta (front-channel only; no
  `backchannel_logout_supported` in its discovery) and GitLab do not. Keycloak
  26.8.0 sends none when an admin **disables** a user (open issues #37981 and
  #10228). The standing check, not back-channel logout, is the offboarding
  mechanism.

### When MCP access stops

| Event | Browser sessions | MCP grants and owner compute | When |
| --- | --- | --- | --- |
| Owner revokes the connection or a standing grant in Flux | Unchanged | Revoked | Next request (existing for connections and grants) |
| Workspace admin removes the person | Lose that workspace | Refused for its projects | Next request (existing) |
| User disabled or deleted at the IdP, standing check on | Ended | Refused until a sign-in (sign-in required) | Within the 15-minute interval plus one check |
| The IdP refuses the offline token for another reason (offline maximum, access removed by the person, lost rotation) | Ended | Refused until a sign-in | Next check |
| Back-channel logout (Keycloak, Authentik, Zitadel) | Matching sessions ended | Checked at once; continue while the IdP still honours Flux's offline token, as Keycloak does after a normal logout | Seconds |
| Back-channel logout with `revoke_offline_access` (Keycloak "Backchannel logout revoke offline sessions" on) | Matching sessions ended | Revoked by Flux | Seconds |
| No signal (standing check off, or IdP refresh unsupported) | Ended at the confirmation age | Refused at the confirmation age | ≤ 7 days by default |
| IdP unreachable | Continue | Continue | Until the confirmation age; then "sign in again" |
| Restore from a backup | Ended for managed accounts | Refused until a sign-in | First check after start |
| SSO-only mode activated | Password-only accounts refused | Same | Next request |
| SCIM deprovisioning | — | — | Deferred |

An access token the IdP issued to Flux itself is never used for MCP, and Flux does
not keep it. Keycloak's note that "Sign out all active sessions does not revoke
outstanding access tokens" therefore does not reach MCP clients.

<a id="step-up-recent-sign-in-for-sensitive-actions"></a>
### Owner MCP capability controls

The latest [founder amendment](https://github.com/ColdPhase/flux/issues/360#issuecomment-6043340696)
replaces the earlier recent-authentication design. The normally authenticated
owner uses clear persisted/versioned switches on a named personal MCP connection
and selects native projects. No password replay, ten-minute/authentication-age
threshold, or secondary SSO challenge is introduced.

- Choices come from actual registered read/propose/execute capabilities and exact
  native operations/classes, not arbitrary future actions. No implied personal/DM
  access, administrator powers, decision acceptance or paid agent invocation.
- Effective authority is current owner rights ∩ actual agent project grants ∩
  original connection/OAuth consent envelope ∩ selected projects ∩ live switches.
  Effects additionally need the exact existing standing grant, runtime/binding,
  operation/class/object, uses/expiry and source/version checks where applicable.
- A committed Off/narrowing applies at the next protected read/projection/list,
  effect, queued-output or receipt replay check, including an old JWT. Serialize
  changes with authorization/effect/delivery checks and prove held-request races.
  Reject pending work truthfully. Earlier committed effects/history and bytes
  already handed to transport cannot be retroactively removed; unrelated local
  CLI work is not promised to stop.
- On restores only settings permitted by still-valid consent, rights and bounded
  grants. It does not revive revoked connections/runtime, revoked/expired/used-up
  grants or removed owner/IdP authority. Actual new grants use the existing
  disclosed owner plus `project.manage` routes; there is no hidden grant creation.
- Outside the original consented scopes/places, normal explicit owner/OAuth
  authorization and an adequate token remain necessary. Refresh cannot enlarge
  the original scope (RFC 6749 §6); OAuth scope reconsent is not password step-up.
- Keep consent and receipt identities intact with a restrictive versioned policy
  overlay or an independently reviewed equivalent. Fully disabled connections
  remain manageable by their owner. Failed/stale saves cannot show false success.
- Current `flux_bootstrap` requires Read to establish authenticated runtime.
  Actions with Read off must honestly expose that prerequisite/block, or have a
  real independently evaluated alternative. A checkbox cannot silently enable
  Read or invent an unavailable bootstrap path. Catalog/runtime cache is not a grant.

S6's [bounded acceptance](#s6--owner-mcp-capability-switches) supplies the UI/API
and replay/race evidence. Existing create/list/revoke/scopes/grants are real seams,
not proof the mutable switches are implemented. Reuse the one permissions surface
in #343/#347/#350 rather than a competing grant flow.

## MCPID-6 — Operator configuration

### Settings

The #240 settings are merged; the remaining F-024 settings require implementation. The
operator sets these in `docker/.env`, except where a row says the variable is set
inside the container.

| Variable | Default | Meaning |
| --- | --- | --- |
| `FLUX_PUBLIC_ORIGIN` | required | One HTTPS origin with no path. The MCP resource is `<origin>/mcp`; the issuer is `<origin>/api/auth` |
| `FLUX_OIDC_ISSUER`, `FLUX_OIDC_CLIENT_ID`, `FLUX_OIDC_LABEL` | off | One provider (#240) |
| `FLUX_OIDC_CLIENT_SECRET_HOST_FILE` | — | **Host** path of the client secret file (#240). Compose mounts it read-only into `api` at `/run/secrets/flux_oidc_client_secret` |
| `FLUX_OIDC_CLIENT_SECRET_FILE` | that mount | **Container** path the API reads. Compose sets it; operators do not |
| Single-provider claim adapter | `oidc` | S5b retains only the claim rules needed by the one selected supported provider; no provider collection. The implementation owner records its bounded single-provider configuration and actual compatibility evidence |
| Ordinary authentication mode | Password-only without active SSO; SSO-only with it | S5b enforces exclusive mode at UI/API/session boundaries. Compatibility flags cannot enable mixed login; exact activation/migration/recovery settings remain implementation work |
| Password signup/verification | Password mode only | S5a retains collision and verification safeguards; active SSO refuses ordinary password signup/reset |
| Authoritative IdP / operator recovery | Preserve S5a standing/offboarding defaults | An operator recovery setting does not authorize ordinary password login while SSO is active or remove the required standing/offboarding gates; explicit host recovery is separately audited |
| `FLUX_OIDC_STANDING` | `refresh` | `off` disables the offline standing check (S4) |
| `FLUX_OIDC_CONFIRMATION_MAX_AGE` | `7d` | `1h`–`30d` (S2) |

### Who must reach what

| From → to | Paths | Why |
| --- | --- | --- |
| MCP client → Flux | `/mcp`, `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server/api/auth`, `/.well-known/openid-configuration/api/auth`, `/api/auth/*` | Discovery, authorization, token and MCP calls |
| Flux → client's metadata host | The `https` `client_id` URL | Client ID metadata documents (existing) |
| Browser → Flux and IdP | Flux origin; the IdP's authorization endpoint | The sign-in step |
| Flux (`api`) → IdP | Discovery, JWKS, token and revocation endpoints | Sign-in verification and standing checks |
| IdP → Flux | `/api/v1/identity/oidc/<providerId>/backchannel-logout` | Only if back-channel logout is configured |
| MCP client → IdP | none | Under A the client never talks to the IdP |

The proxy must pass these paths unchanged on the one public origin, as the
[integration guide](../integrations/README.md#for-operators) already requires.

### Provider profiles

A profile fixes the claim rules a provider needs. The default `oidc` profile
follows #240:

- the subject is `sub`;
- the email counts only with `email_verified: true`;
- `iss` must match exactly;
- verified sign-in and migration remain bound to the configured issuer/account;
  no S6 recent-authentication or secondary provider challenge is required.

The other profiles change only what their provider needs.

| Profile | Differences |
| --- | --- |
| `entra` | Entra's claims references list no `email_verified`, so #240's rule as written would refuse every Entra sign-in (an inference, untested against Entra). The email counts as verified only when the optional claim `xms_edov` is `true`. Requires the documented verified-email compatibility claims; no authentication-age challenge is added. `sub` is pairwise per application, so keep the app registration (re-registering changes every `sub`; use the re-key command) |
| `google` | Accepts `iss` `https://accounts.google.com` and `accounts.google.com`. Sends `access_type=offline`, because Google returns a refresh token only then and only on the first code exchange; `prompt=consent` obtains a new one when Flux has none. Can require an `hd` (Workspace domain) value. Do not claim or require S6 credential re-entry |
| `oidc` | Keycloak, Authentik, Zitadel, Okta, GitLab |

### Worked example: Keycloak 26.8

1. **Realm `acme`, client `flux`** (Clients → Create client, OpenID Connect):
   - Client authentication **On** (confidential);
   - Standard flow **On**; Direct access grants **Off**; Implicit flow **Off**;
     OAuth 2.0 Device Authorization Grant **Off** for this client;
   - Valid redirect URIs: `https://flux.example.org/api/auth/callback/<providerId>`.
     The API logs the exact URI at start: `Single sign-on is on`, field
     `redirectUri` (#240);
   - Advanced → Proof Key for Code Exchange Code Challenge Method **S256**;
   - Logout settings → Backchannel logout URL:
     `https://flux.example.org/api/v1/identity/oidc/<providerId>/backchannel-logout`.
     Backchannel logout session required **On**. "Backchannel logout revoke
     offline sessions" **Off**, unless every logout should also end agents: when
     on, Keycloak adds `revoke_offline_access` to each logout token, and Flux then
     revokes the person's MCP grants (S3).
2. **Offline access:** a new realm puts the `offline_access` role in its default
   roles (`default-roles-<realm>`); check that it is still there, so Flux can hold
   an offline token for the standing check. Keycloak's default offline session
   idle is 30 days; Flux's checks every 15 minutes keep it alive. "Offline Session
   Max Limited" is off by default; if you turn it on (default maximum 60 days),
   people sign in again when it is reached.
3. **Refresh tokens:** keep Realm settings → Tokens → "Revoke Refresh Token"
   **Off**, the default. On makes refresh tokens single-use, so a lost response to
   a standing check would put the person in sign-in required.
4. **Email:** turn on "Verify email", or set `emailVerified` when you create users.
   Flux refuses unverified emails.
5. **Flux `docker/.env`:**

   ```sh
   FLUX_PUBLIC_ORIGIN=https://flux.example.org
   FLUX_OIDC_ISSUER=https://id.example.org/realms/acme
   FLUX_OIDC_CLIENT_ID=flux
   # a path on the host; Compose mounts the file into the api container
   FLUX_OIDC_CLIENT_SECRET_HOST_FILE=/etc/flux/oidc_client_secret
   FLUX_OIDC_LABEL=Acme login
   # Target: after explicit account migration, active SSO is the sole ordinary login.
   # No Flux password signup/reset or fallback with SSO.
   # Activation/recovery details require S5b implementation and evidence.
   ```

6. **MCP clients:** nothing changes. Run
   `claude mcp add --transport http --scope user flux https://flux.example.org/mcp`,
   then `claude mcp login flux`. The browser shows Flux's sign-in with "Sign in with
   Acme login", then Keycloak, then Flux's connection choice and consent.
7. **Offboarding check:** disable a test user in Keycloak. Within the standing
   interval (15 minutes) plus one check, their Flux tab returns to sign-in, and
   their Claude Code gets "Sign in again with Acme login.".

### Worked example: Microsoft Entra ID

1. **App registrations → New registration** "Flux", single tenant. Redirect URI
   (Web): `https://flux.example.org/api/auth/callback/<providerId>`. Entra requires
   https except for localhost.
2. **Certificates & secrets:** create a client secret and save it to the secret
   file. Note its expiry: an expired secret stops sign-in and standing checks.
3. **Token configuration → Add optional claim** (ID token): `email`, `xms_edov`.
   No S6 authentication-age claim or ten-minute challenge is required.
4. **API permissions:** `openid`, `email`, `profile`, `offline_access` (Microsoft
   Graph delegated); grant admin consent.
5. **Flux:**
   - `FLUX_OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0`
     (the v2.0 issuer with the tenant id, not `common`);
   - profile `entra` (S5);
   - the client id from the registration's Overview.
6. **Back-channel logout:** Entra offers front-channel logout only, so leave it
   unset. Offboarding relies on the standing check. Entra refresh tokens last
   90 days and are replaced on every use. After "Account enabled" is cleared and
   sessions are revoked, "the user can't gain new tokens for any application", so
   the next check puts the identity in sign-in required.

### Other providers

- **Authentik.** Documents back-channel logout when "A user account is
  deactivated". Configure its back-channel URL as for Keycloak.
- **Zitadel.** Sends back-channel logout only when a session is terminated or the
  user signs out, not when a user is deactivated (source read at v4.19.4). Rely on
  the standing check for deactivation.
- **Okta.** Its discovery has no `backchannel_logout_supported`, and its single
  logout is front-channel. Its "Universal Logout" uses Global Token Revocation,
  which Flux does not implement (deferred). Rely on the standing check.
- **Google Workspace.** No logout endpoint and no back-channel logout. Use its required verified-claim adapter and the standing check;
  no secondary S6 sign-in challenge is added.
- **GitLab.** Its discovery has no logout keys. `email` and `email_verified` come
  only with the email scope and a public email. Preserve the sole provider's admitted authoritative/standing policy;
  no convenience-password fallback is introduced by this amendment.

## MCPID-7 — Failures and edges

| Situation | Behaviour |
| --- | --- |
| IdP down when Flux starts | #240 reads discovery only at start and leaves single sign-on off until a restart. **Change (S1):** read discovery lazily with retry and backoff, and show `<label> is not reachable right now` on the sign-in pages. SSO-only shows honest unavailability without password fallback; password mode remains available only without active SSO |
| IdP down later | New sign-ins and new MCP authorizations fail at the browser step with the same message. Existing browser sessions, MCP tokens keep working until the confirmation age. The standing check records "unknown", not "sign-in required" |
| IdP step fails during an MCP authorization | Back to `/login` with the same signed OAuth query and a message (S1) |
| Flux's IdP client secret expired or rotated | Sign-in and standing checks fail with `invalid_client`. Flux treats this as **unknown**, not as every person needing to sign in, and logs `OIDC_CLIENT_REJECTED` for the operator |
| Lost response to a standing check | Unknown. The next check uses the previous refresh token, which the IdP still accepts unless it makes refresh tokens single-use; then sign-in required |
| Clock skew between Flux and IdP | Required ID-token and logout-token `iat`/`exp` validation retains its 60-second tolerance; no S6 authentication-age gate is added. Hosts must run NTP. MCP clients rely on `expires_in`; Flux verifies its own JWTs with its own clock |
| Email changed at the IdP | Same `sub`, same account (#240). The email updates at the next sign-in or standing check. MCP grants are unaffected. If the new email belongs to another account, the update is skipped and logged, and the person keeps signing in with the old email. #240's current behaviour in this case is untested; S1 tests it |
| Provider email held by another account | [Password rules](#password-sign-up-reset-and-email-collisions): refused with link guidance when that account's email is verified; link or claim when it is not (S5a) |
| User renamed at the IdP | Name updates; nothing else changes |
| User deleted and re-created, or merged, at the IdP | The new `sub` is a new identity. The old identity is in sign-in required after its next standing check, which stops its grants. #240 refuses the new identity while the old account holds a verified email. The operator uses the re-key command to move the identity to the existing account |
| Issuer changed (new hostname or realm) | A new provider id, so everyone appears as a new identity (#240). Plan it with the re-key command. MCP clients key credentials by Flux's issuer, so they are unaffected unless `FLUX_PUBLIC_ORIGIN` changes |
| `FLUX_PUBLIC_ORIGIN` changed | Issuer, resource and redirect URIs change. Clients must re-register (MCP 2026-07-28) and people sign in again |
| Restore from a backup | The backup holds no IdP refresh token, so managed identities are in sign-in required until each person signs in through the provider ([IdP tokens](#idp-tokens-at-rest-and-in-backups)) |
| Flux behind a path prefix (`https://example.org/flux/`) | **Not supported.** `FLUX_PUBLIC_ORIGIN` must be an origin without a path. RFC 8414 and RFC 9728 place well-known documents at the host root (`/.well-known/oauth-protected-resource/flux/mcp`), Flux's session cookies use path `/`, and the proxy would have to route root paths to Flux. Use a dedicated host name such as `flux.example.org` |
| Several Flux instances on one IdP | One IdP client per instance, each with its own redirect and back-channel URLs |
| Keycloak user federation (LDAP) | `sub` is Keycloak's user id. A re-import that changes it is a re-created user (above) |
| Two Flux tabs, or two clients authorizing at once | Request-bound consent (#52) keeps each authorization separate; the IdP round trip carries its own `state` |

## Test plan (Docker only)

Extend #240's `scripts/check_oidc.sh`. It uses its own Compose project and ports
and runs a Keycloak pinned by digest (26.7.5 in #240; move to 26.8.x) with an
imported realm, the API, Mailpit and Chromium. Add:

- **A scripted MCP client** (test code, not a vendor client). It does:
  - discovery from the 401 `resource_metadata`;
  - client identification with a CIMD `client_id` served by the test, and with a
    pre-registered client created through #294's test-only fixture route;
  - PKCE S256 with `resource`, and the `iss` check;
  - the code exchange, refresh and MCP `tools/list` and tool calls;
  - receiving its callback on a loopback port, as `localhost` and as `127.0.0.1`.

  Chromium drives the browser step through Flux `/login` → Keycloak → Flux consent.
  Better Auth has no upstream test for `oauth_query` through `/sign-in/social`, so
  this Keycloak-backed run is the proof for S1.
- **Keycloak admin actions** through its admin REST API from the test container:
  disable a user, delete a user, end a user's sessions, remove the Flux client's
  offline session, change an email, and switch the client's "Backchannel logout
  revoke offline sessions".
- **The mock provider** from #240 (`app/tests/app/support/oidc-mock.ts`), for what
  Keycloak cannot be made to do:
  - Entra-shaped and Google-shaped claims;
  - account/session/intent substitution during verified migration callbacks;
  - bad logout tokens, and logout tokens with `revoke_offline_access`;
  - `invalid_grant` versus a 503 on refresh, a lost rotation response, and no
    refresh token at all;
  - an unreachable IdP.
- **A short standing interval** in tests (for example 5 seconds), with the `api`
  running the check and the `worker` running.

| Case | Assertion |
| --- | --- |
| 1 Built-in | Existing `oauth-mcp` tests still pass. With SSO-only mode activated, a password-only grant is refused at its next request |
| 2 OIDC on `/login` | An IdP-only person completes the scripted client's authorization from a fresh browser; the token has `aud` = `<origin>/mcp`; tools work. A tampered continuation is refused. A cancelled or failed IdP step returns to `/login` with the query, and the authorization then completes. Consent after the IdP step shows the redirect host and the `client_id` host, the loopback line or the non-loopback warning, and cannot be framed. A loopback redirect on another port is accepted as `localhost` and as `127.0.0.1`; a different path or host is refused |
| 3 Single-provider migration/recovery | Before SSO-only activation, bind the authenticated existing Flux account/session and intent to a verified sole-provider round trip. Preserve Flux IDs/data/roles/grants; refuse duplicate/substituted identity and email auto-linking; prove cutover/lockout handling, audited recovery and the chosen provider claims. No second password/SSO or authentication-age gate |
| 4 Exclusive modes and account safety | Password-only without active SSO; SSO-only with it, including server refusal of password sign-in/signup/reset and password-only continuation. Fresh SSO accounts need no Flux password. Preserve migration/collision, verified-email membership, no-data-transfer claim, managed/reset/offboarding and audited recovery controls. No ordinary mixed-method fallback |
| 5 Canceled opaque keys | No additional key minting/storage/UI/settings are admitted. Existing OAuth issuer/audience, owner/grant/standing checks and unsupported-bearer refusals remain; this is cancellation, not successful implementation of S7 |
| 6 Headless | The scripted client completes authorization by posting the pasted redirect URL to its own loopback listener, mirroring Claude Code's paste-back |
| 7 Offboarding | Keycloak disable or delete → within the interval: browser sessions gone, refresh `invalid_grant`, MCP 401 with the `error_description` (a label with non-ASCII characters is reduced to allowed characters), MCP requests refused, nothing revoked. After disable, re-enable plus sign-in: a client that kept its refresh token can refresh. Removing the Flux client's offline session at Keycloak gives the same suspension. In sign-in required, an O-008 personal run (mock provider) is not dispatched, and, once F-022 run tokens exist, none is minted or accepted. Back-channel logout ends matching browser sessions and MCP continues; with "Backchannel logout revoke offline sessions" on, the MCP refresh tokens are revoked. With standing off, MCP stops at the confirmation age (shortened in the test) |
| 8 No passthrough and token storage | A Keycloak-issued access token or ID token sent to `/mcp` gets 401. After sign-in, `auth_accounts` holds no IdP access or ID token, and the IdP refresh token is only in its own table, encrypted. A dump made with the backup's `pg_dump` arguments has no row of that table; after restoring it, managed accounts are in sign-in required until they sign in. No IdP token appears in any MCP response, log line or export |
| 9 Failures | The mock IdP returning 503 leaves MCP working and records "unknown"; at the confirmation age it stops. A rejected client secret puts nobody in sign-in required. After a lost rotation response, the next check succeeds with the previous token. A logout token with `nonce`, a replayed `jti`, a wrong `aud` or `alg` none gets 400. Every back-channel response has `Cache-Control: no-store` |
| 10 Owner capability switches | Owner-only persisted/versioned controls; other owner/admin/agent denied. Old JWT, cached catalog/runtime, held projection/effect/delivery and receipt replay cannot bypass committed Off/narrowing. On is within live consent/rights/grants, never resurrects expired/revoked authority; refresh cannot widen scope. Prove all-disabled management, failed/stale saves and actual Read/bootstrap execution prerequisites without secondary authentication |

For the selected supported provider, test its relevant claim adapter against the
mock and retain negative controls. Entra/Google compatibility remains "untested
against the real provider" without a corresponding real run; mocks do not
establish it. The one-provider scope does not require every vendor adapter
without an admitted supported use.

## Implementation slices

Each slice becomes its own issue in this milestone after this decision is
accepted. Each also updates the operator guide (`docs/operations/single-sign-on.md`
from #240) and the [integration guide](../integrations/README.md).

**Order.**

- S1 depends on #240 and #294 merging.
- S4 depends on S1.
- S2 depends on S4 and must not land before it: without the standing check nothing
  renews confirmation between sign-ins, so every managed account would have to
  re-authorize its clients every 7 days.
- S3 depends on S4, because it queues standing checks and revokes the stored IdP
  refresh token.
- S5a depends only on #240.
- S6 depends on S1. The narrowed S5b also composes S5a's account-safety
  interfaces and applicable S4/S2 standing/offboarding seams; linking has no S6 challenge dependency. S7 has no planned implementation.

**Release position, amended 2026-10-07.** The v0.1.0-rc.1 acceptance matrix
([#248](https://github.com/ColdPhase/flux/pull/248),
`docs/agents/release-acceptance/v0.1.0-rc.1.md`) lists #240's single sign-on under
OPS-1 and 8.15, and MCP co-work under CO-1–CO-5. The
[founder and assessed amendment](https://github.com/ColdPhase/flux/issues/360#issuecomment-6042333778)
requires the following v0.1 outcomes with one SSO provider:

- **S1 gates it.** Without S1, an IdP-only person reaches MCP only through the
  workaround in #240's guide, and consent is untested on the IdP path.
- **S4, then S2, gate it.** Foundation §8.15 requires that access can be taken
  away "również aktywnej automatyzacji". Without S4, disabling a person at the IdP
  ends neither their Flux browser sessions (7 days, extended on use) nor their MCP
  refresh grants (30 days, sliding).
- **S5a gates it.** Without it, password sign-up lets anyone block an employee's
  first single sign-on and receive a membership meant for them.
- **S3 gates it.** Back-channel logout (#314) follows S4 (#311); its validated
  event/session effects do not replace the standing check or imply that every
  provider sends logout events.
- **The narrowed S5b gates it.** #315 supplies one-provider password mode, safe
  existing-account conversion/recovery and the selected provider's claim rules.
  There is no simultaneous-provider file, list UI or combined-standing policy.
- **Capability-control S6 gates it.** #316 supplies ordinary owner switches
  and selected-project access, enforced live within rights/grants/OAuth consent,
  without recent-authentication or secondary password/SSO challenges.
- **S7 is canceled.** #317 is `not_planned`, not implemented or deferred delivery.
  Tested personal-client SSH/paste-back/callback guidance remains in S1/#310 and
  #152. No key UI, key endpoint or unsupported fully unattended consumer is added.

All implementation and independent evidence remain required. The prior deferred
scope and its observations are preserved in the dated research and GitHub records.

### S1 — Provider sign-in on the MCP authorization path

- **AC-1.** `/login` offers the sole active provider; without active SSO it uses password mode. The IdP round trip keeps the signed
  OAuth query through Better Auth's `/sign-in/social` and callback, and continuing
  re-verifies it.
- **AC-2.** A cancelled or failed IdP step returns to `/login` with the signed query
  and a message.
- **AC-3.** The grant and the session record the identity (password or provider
  id), the confirmation time and the IdP `sid`.
- **AC-4.** Discovery is read lazily with retry. When the IdP is unreachable, the
  sign-in pages say so.
- **AC-5.** Consent after an IdP sign-in shows #294's redirect host, `client_id`
  host and non-loopback warning, adds the loopback line, and cannot be framed.
- **AC-6.** The [redirect rules](#redirect-uris-for-mcp-clients) hold on the IdP
  path.
- **AC-7.** An IdP access token or ID token at `/mcp` gets 401.
- **AC-8.** After the callback, `auth_accounts` holds no IdP access, ID or refresh
  token (S4 adds the refresh token's own table).
- **AC-9.** Test cases 2 and 8, and the IdP-down rows of case 9, against a
  Keycloak-backed Flux.
- **AC-10.** Real Claude Code and Codex runs against a Keycloak-backed Flux,
  recorded with their versions as integration evidence (PROV-5). Mock clients do
  not prove vendor compatibility.

### S2 — Confirmation age

- **AC-1.** A managed account's browser sessions, MCP refresh grants and MCP
  requests are refused past `FLUX_OIDC_CONFIRMATION_MAX_AGE`, with the stated
  error and message.
- **AC-2.** Re-authorization preselects the client's existing connection.
- **AC-3.** Unmanaged accounts keep today's lifetimes.
- **AC-4.** The confirmation-age rows of test cases 7 and 9.

### S3 — OIDC back-channel logout receiver

- **AC-1.** A dedicated route at `/api/v1/identity/oidc/<providerId>/backchannel-logout`,
  outside the Better Auth bridge, with §2.6 validation, a `jti` replay store, and
  200 or 400 with `Cache-Control: no-store`.
- **AC-2.** `sid` and `sub` session ending.
- **AC-3.** The immediate standing check.
- **AC-4.** `revoke_offline_access` in `events` revokes the MCP refresh tokens and Flux's IdP refresh token.
- **AC-5.** The logout rows of test cases 7 and 9, against Keycloak with the client
  setting on and off, and against the mock.

### S4 — Standing check

- **AC-1.** `offline_access` at sign-in. The IdP refresh token is stored encrypted in
  its own table, and the replaced token is revoked at the IdP.
- **AC-2.** The check runs in `api` and claims identities with `FOR UPDATE SKIP
  LOCKED`. It has success, sign-in required and unknown outcomes; a rotated token
  is stored before the previous one is forgotten; no stored token means sign-in
  required.
- **AC-3.** Sign-in required deletes the browser sessions, answers MCP requests with
  401 and an RFC 6750-safe `error_description`, refuses refresh, and revokes
  nothing. A new sign-in restores use of kept refresh tokens and grants.
- **AC-4.** Standing gates every `/mcp` bearer, run-token minting and the start of
  owner compute (O-007, O-008; F-022 runs when they are built).
- **AC-5.** Backups leave out the token table's rows; after a restore, managed
  identities are in sign-in required. No IdP token is in exports or logs.
- **AC-6.** The Keycloak disable, delete and offline-session rows and the
  automation row of test case 7, and the lost-rotation row of case 9.

### S5a — Account safety with a provider

- **AC-1.** Ordinary password signup/verification/reset apply only in password
  mode. Active sole-provider SSO refuses ordinary password sign-in/signup/reset
  and password-only authority continuation at UI/API/session boundaries. The old
  verified-password-signup-with-active-SSO scenario is superseded, not implemented.
- **AC-2.** Membership lookup by email under the provider/migration safety rules
  uses verified addresses; retain the prior collision/verification protections.
- **AC-3.** Refuse a provider identity held by another account. Preserve link-first
  guidance only as explicit pre-cutover conversion or audited recovery; never
  offer ordinary password fallback with SSO. An unverified-address claim keeps
  its audit/revocation behavior and never transfers the released account's data.
- **AC-4.** Reset never creates a password; managed/offboarding safeguards and
  audited host recovery remain. Recovery does not become mixed ordinary login
  or a bypass of the sole provider's authority.
- **AC-5.** Adapt case 4 to exclusive modes, migration/collision/reset/offboarding
  refusal and verified-email safeguards. The previous N4 signup-verification
  guidance remains applicable in password mode, not active SSO.

<a id="s5b--password-switch-several-providers-linking-and-profiles"></a>
### S5b — Password mode, safe migration and provider claim adapters

Required in v0.1 under [#315](https://github.com/ColdPhase/flux/issues/315).
Depends on S1/#310 and S5a/#313, with S4/S2 standing/offboarding interfaces
where applicable. S6 is capability control, not a linking reauthentication dependency.

- **AC-1 — One provider, exclusive ordinary mode.** Password-only without active
  SSO, or sole-IdP SSO-only with it. Enforce this at UI/API/session boundaries;
  refuse ordinary password sign-in/signup/reset and password-only authority
  continuation under SSO. New SSO accounts come through the verified IdP flow.
  No simultaneous-provider selector/file or ordinary password fallback. Preserve
  scoped managed-account/operator recovery safeguards.
- **AC-2 — Migration before cutover.** In the prepared-provider migration phase,
  the authenticated existing-account owner completes a verified provider round
  trip bound to the same Flux account/session and intent before SSO activation.
  Preserve Flux ID, data, memberships and applicable grants. Reject duplicate
  identity, substitution and email auto-linking. Do not silently strand required
  accounts; document and test audited host recovery. Authoritative/last-usable
  identity removal cannot evade offboarding or lockout protections. Compose S5a's
  link-first guidance; an unverified email claim never transfers old data. No
  recent-authentication, ten-minute or second password/SSO challenge.
- **AC-3 — Claims and recovery.** Preserve verified OIDC defaults and the relevant
  claim adapters for the one chosen provider; these are not concurrent providers
  or person-profile pages. Re-key recovery keeps Flux identity/history, audits
  old/new issuer and subject, and revokes obsolete MCP authority. It is not
  ordinary password login with active SSO. Real selected-provider compatibility
  stays unverified without corresponding evidence; mocks alone cannot establish it.
- **AC-4 — Evidence.** Docker Keycloak, scripted MCP/client and mock negative
  controls prove exclusive modes at UI/API/session boundaries, existing-account
  migration, duplicate/substituted identities, refused email linking, preserved
  data/rights, cutover/lockout handling, offboarding, authority revocation, audited
  recovery and relevant verified claims. Preserve the remaining accepted S5b
  cases, replacing simultaneous providers with separate single-provider runs.
  Independently evaluate the exact final head.

<a id="s6--recent-sign-in-for-sensitive-actions"></a>
### S6 — Owner MCP capability switches

Required in v0.1 under [#316](https://github.com/ColdPhase/flux/issues/316).
Depends on S1 identity/session, existing MCP/grant/runtime interfaces and final
UI #343/#347/#350. It supersedes recent-authentication; source seams are not
proof mutable switches already exist.

- **AC-1 — Honest persisted controls.** A named personal connection has owner-only,
  persisted/versioned switches for actual registered Read/Suggest/Execute
  capabilities and selected native projects. Show effective availability,
  unsupported/prerequisite/refusal reasons, reload and stale/concurrent-save
  behavior. Failed saves cannot claim success; all-disabled connections remain
  manageable. No password replay, ten-minute/authentication-age rule or secondary
  SSO prompt. Current Read-scoped bootstrap/runtime prerequisites must be explicit.
- **AC-2 — Authority intersection.** Every protected read/projection/tool/effect
  is capped by current owner rights, actual agent project grants, original
  connection/OAuth consent envelope, selected projects and live switches.
  Effects retain exact existing standing grant/runtime/binding, operation/class/
  object, uses/expiry and source/version checks. Owner labels, admin/manager
  status, agent input and frontend hiding do not bypass private connection
  ownership. No new project/admin/private/DM access, invocation/paid-run or
  decision-acceptance tool is manufactured. Outside the original scopes/places
  requires normal explicit owner/OAuth authorization and an adequate token;
  refresh never enlarges the original consent scope.
- **AC-3 — Live Off/narrowing.** After its commit, Off/narrowing is checked on the
  next protected read/projection/list/effect/queued-output or receipt replay,
  even with an old JWT. Serialize policy edits with authority/effect/delivery
  rechecks; prove held-request races and truthful refusal of pending work.
  Preserve already committed history/effects and account separately for bytes
  already handed to transport; no retroactive undo or stopping unrelated CLI work.
- **AC-4 — On preserves ceilings.** Restore only policy allowed by still-valid
  consent, rights and bounded grants. Never revive revoked connection/runtime,
  revoked/expired/used-up grants or removed owner/IdP authority. New real bounded
  grants use existing disclosed owner plus `project.manage` routes; no hidden
  grant creation. Preserve consent/receipt identities through a restrictive
  versioned policy overlay or an independently reviewed equivalent.
- **AC-5 — Integrated evidence.** Docker API/browser checks cover owner vs
  other-owner/admin/agent refusal, reload/persistence, old-token Off/On and
  refresh ceilings, failed/stale saves, held projection/effect/delivery races,
  replay/revocation/expiry, all-disabled management and ordinary no-prompt
  behavior. Actions with Read off show the real bootstrap prerequisite/block or
  use an actual independently evaluated alternative; never silently enable Read.
  Integrate one permission surface with #343/#347/#350 and review the exact head.

### S7 — Connection access keys and headless guidance

**Canceled, not implemented:** [#317](https://github.com/ColdPhase/flux/issues/317)
is closed as `not_planned`. The prior opaque-key acceptance criteria are
historical research, not promised future work. There is no new key UI,
`fxk_` bearer handler or `FLUX_MCP_ACCESS_KEYS` setting. OAuth/SSH/callback
guidance and the supported-client test case 6 remain required under S1/#310 and
#152. Reconsider a second credential surface only for an admitted, concrete
CI/header-only consumer with bounded owner/grant/custody/offboarding requirements.

## Rejected and deferred

| Option | Status | Reason / revisit when |
| --- | --- | --- |
| IdP as the MCP authorization server (B) | Rejected | [Why not B](#why-not-b). Revisit if the MCP specification requires a separate authorization server, or if supported IdPs and clients all implement RFC 8707 and CIMD, and Flux can drop per-connection tokens |
| Accepting or exchanging IdP tokens at `/mcp` (C) | Rejected | Token passthrough; it removes per-client consent |
| Automatic account linking by email | Rejected | Account takeover across providers. Revisit only with a per-provider verified-domain policy and a security review |
| Device authorization grant (RFC 8628) | Deferred | No supported client implements it for MCP. Revisit when Claude Code or Codex does |
| Enterprise-managed authorization / ID-JAG (D) | Deferred | The `ext-auth` repository marks the extension "Stable" (the modelcontextprotocol.io page shows no status), but the IETF draft is -04 and the MCP client matrix lists neither Claude Code nor Codex. It fits A: Flux would accept the grant and still issue its own token |
| SCIM provisioning | Deferred | Better Auth 1.7.6 ships a `scim` package. Keycloak 26.8's SCIM is an inbound server for managing Keycloak's own users. Revisit when an operator needs pre-provisioning or immediate push deprovisioning; the standing check covers offboarding meanwhile |
| Shared Signals (Keycloak SSF RISC events), Okta Global Token Revocation, Entra CAE | Deferred | Experimental or vendor-specific push signals. Revisit when one is stable in a provider Flux users run |
| Path-prefix deployment | Not supported | MCPID-7. Revisit if operators cannot provide a host name |
| SAML | Out of scope | As in #240 |

## Revisit when

- An MCP specification revision changes authorization, discovery or registration.
- Claude Code or Codex adds the device grant or ID-JAG, or Cursor adds CIMD.
- A supported IdP's refresh behaviour for disabled users differs from what is
  recorded here.
- The standing check's load on an IdP proves too high at the 15-minute interval.
