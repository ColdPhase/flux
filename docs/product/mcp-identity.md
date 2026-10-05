# F-024 — MCP sign-in with built-in accounts and external identity providers

**Status: Proposed, 2026-10-05.** Awaiting independent review by @Zamojski5.
**Owner:** @PelikanFix16 (`claude-hubert`). **Issue:** [#273](https://github.com/ColdPhase/flux/issues/273).
**Evidence:** [research note](research/2026-10-05-mcp-identity.md), retrieved 2026-10-05.

**Founder direction** (Hubert / @PelikanFix16, 2026-10-05, relayed by
`claude-hubert`, recorded in [#272](https://github.com/ColdPhase/flux/issues/272)
item 6):

> "MCP musi mieć zaprojektowane jawne obejścia — co jak postawimy Fluxa w OIDC,
> Keycloak itd.? albo inny provider?"

In English: MCP needs an explicitly designed path for deployments where people
sign in to Flux through OIDC (Keycloak or another identity provider).

**Scope.** This is mode (b) of [F-022](https://github.com/ColdPhase/flux/pull/247):
Claude Code, Codex, Cursor or another MCP client on the person's computer
connects to Flux's MCP endpoint. It builds on [O-005](first-agent-path.md), the
[agent connection contract](../development/agent-connection.md) and
[F-016](mcp-cowork.md). It extends the human single sign-on of
[#240](https://github.com/ColdPhase/flux/pull/240) / [#113](https://github.com/ColdPhase/flux/issues/113),
which is not merged yet. Nothing here is implemented; the
[slices](#implementation-slices) are the plan.

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
   for a person who has only an IdP account ([MCPID-2](#mcpid-2--signing-in-during-mcp-authorization)).
3. **Accounts are keyed by issuer and subject, never by email.** Several providers
   can be configured. Linking an identity to an account is an explicit, signed-in
   action ([MCPID-3](#mcpid-3--several-providers-and-account-linking)).
4. **Header-only clients and CI use connection access keys.** A key is a short-lived,
   revocable Flux bearer for one connection, under the same checks as an OAuth
   token. Headless machines use the clients' own paste-back or callback options.
   There is no device flow yet ([MCPID-4](#mcpid-4--clients-headless-machines-and-ci)).
5. **The IdP governs a managed account's access.** Flux re-checks the person with
   the IdP every 15 minutes using an offline refresh token held only by the server.
   A refusal ends the person's browser sessions and MCP grants. Back-channel logout
   triggers an immediate check. Without any signal, access stops when the IdP's last
   confirmation is 7 days old ([MCPID-5](#mcpid-5--lifetimes-standing-and-how-access-ends)).

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
  request.

## MCPID-1 — Flux stays the MCP authorization server

### Options

| Option | How it works | Verdict |
| --- | --- | --- |
| **A. Flux is the authorization server; the IdP signs people in** | Protected-resource metadata names Flux's issuer `<origin>/api/auth`. The authorization step signs the person in through the IdP, then runs Flux's own connection choice and consent. Flux issues a JWT with `aud` = `<origin>/mcp` and a Flux refresh token | **Recommended** |
| B. The IdP is the authorization server; Flux validates IdP tokens | Protected-resource metadata names the IdP (for example the Keycloak realm). Clients register and get tokens there. Flux validates the IdP's JWT, issuer and audience | Rejected |
| C. Flux accepts IdP tokens and exchanges them | Clients send an IdP access token, or Flux trades one for its own token (RFC 8693) | Rejected |
| D. Enterprise-managed authorization (ID-JAG) | The client gets an identity assertion grant from the IdP and presents it to Flux's authorization server (RFC 7523). Flux still issues the token | Deferred; it adds to A |

### Why A

- **It meets the MCP rules with one code path.** MCP 2026-07-28 requires the
  server to "validate that access tokens were issued specifically for them as the
  intended audience". It says "MCP servers **MUST NOT** accept or transit any other
  tokens". The authorization server "may be hosted with the resource server or a
  separate entity". Under A, Flux is the issuer and the audience. The same
  discovery, CIMD/DCR, PKCE S256, `resource`, `iss` and rotating refresh tokens
  serve built-in accounts and every IdP. These are implemented and tested today
  ([agent connection](../development/agent-connection.md#identities-and-consent)).
- **Flux keeps its consent and revocation model.** The token carries a Flux
  connection id and a grant reference. The consent page names the client, the
  connection, the projects and the scopes. Revoking a connection or a standing
  grant applies at the next call. An IdP cannot express "Hubert / Codex for
  projects X and Y with execute scope", so B would need a second, Flux-side
  binding step after the IdP's consent.
- **It works with every IdP.** Under A, the IdP only has to do an ordinary OIDC
  sign-in for one confidential web client. Under B, it would also need RFC 8707,
  CIMD or DCR, and MCP-specific settings:
  - **Keycloak 26.8.0** marks resource indicators and CIMD "Experimental" and
    supports MCP 2026-07-28 only experimentally.
  - **Entra ID** publishes no RFC 7591 registration endpoint.
  - **Google and GitLab** offer no way to register Flux as a resource that
    receives their access tokens (an inference from their documentation).
- **MCP clients never contact the IdP.** The person's browser and the Flux server
  do. An IdP reachable only on a company network or VPN still works for a person
  using that network.
- **Built-in accounts need A anyway.** B would leave two authorization servers to
  build, test and explain.

### Why not B

B's one advantage is that offboarding becomes the IdP's job: refresh fails at
the IdP. [MCPID-5](#mcpid-5--lifetimes-standing-and-how-access-ends) gets the same
result under A with a server-side standing check. B's costs:

- per-IdP client registration and audience setup, much of it experimental or
  missing;
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

## MCPID-2 — Signing in during MCP authorization

### Case 1: built-in accounts (today)

1. The client calls `/mcp` without a token and gets 401 with
   `WWW-Authenticate: … resource_metadata=…`.
2. It reads `/.well-known/oauth-protected-resource/mcp`, then
   `/.well-known/oauth-authorization-server/api/auth`.
3. It registers (CIMD, else DCR) and opens the browser at
   `/api/auth/oauth2/authorize` with PKCE S256 and `resource=<origin>/mcp`.
4. Without a session, Flux shows `/login` with the signed OAuth query. The person
   signs in with email and password.
5. `/connect-agent` asks which connection this client gets. The consent page then
   shows the client, connection, projects and scopes.
6. Flux redirects to the client's loopback callback with `code` and `iss`. The
   client redeems the code for a JWT access token (1 hour) and a rotating refresh
   token.
7. Every MCP request: Flux verifies the JWT locally, then reloads the connection,
   its grants and the owner's current access.

### Case 2: operator OIDC

PR #240 adds one provider for browser sign-in. Its head `8929beb6` shows the
single sign-on button on `/sign-in` but **not on `/login`**, the page where the
MCP authorization step lands (`app/apps/web/src/auth/pages.tsx:140`). An IdP-only
person therefore cannot complete `claude mcp login` unless they first sign in to
Flux in the same browser. Slice S1 closes this gap. The flow becomes:

1. Steps 1–3 as in case 1.
2. `/login` shows `Sign in with <label>` for each provider, plus the password form
   when password sign-in is on.
3. Choosing the provider stores the signed OAuth query as the post-sign-in
   continuation. It is validated by the same `oauth_query` verifier as the password
   path, and is never an open redirect. Flux then redirects to the IdP with PKCE,
   `state`, nonce and the scopes `openid email profile offline_access`
   (`offline_access` only when the standing check is on).
4. The person signs in at the IdP. MFA and conditional access stay the IdP's job.
5. The IdP returns to `/api/auth/callback/<providerId>`. Flux verifies:
   - `state` and PKCE;
   - the ID token's signature, `iss`, `aud`, `exp` and nonce;
   - the verified-email rule ([provider profiles](#provider-profiles)).

   It finds or creates the account by (provider id, `sub`). It records the
   session's identity, IdP `sid` and confirmation time, and stores the IdP refresh
   token encrypted. It then continues to `/connect-agent` and consent.
6. Steps 6–7 as in case 1. The grant records how the person signed in (password
   or provider id) and when.

The person's IdP tokens stay on the server. The MCP client only ever sees Flux's
code and tokens.

### Password sign-in on or off

New operator setting `FLUX_PASSWORD_SIGN_IN`: `on` (default) or `off`.

- **On:** the behaviour of #240. Passwords and providers sit side by side.
- **Off:**
  - Password sign-in, sign-up and reset requests are refused with
    `PASSWORD_SIGN_IN_DISABLED`.
  - `/sign-in` and `/login` show only the provider buttons.
  - A password-only account has no standing, so its browser sessions, MCP grants
    and access keys stop at their next request. An account with a provider identity
    keeps working through that identity.
- **Before switching off:** people link their provider identity while signed in
  ([MCPID-3](#mcpid-3--several-providers-and-account-linking)).
- **Break-glass:** set `on` and restart. It is an operator action on the host,
  never a setting in the web UI.
- **First owner:** signs in through the provider; creating a workspace works as
  today.

## MCPID-3 — Several providers and account linking

### Several providers at once

- The operator lists providers in a file named by `FLUX_OIDC_PROVIDERS_FILE`.
  #240's single-provider variables stay as a shorthand for a list of one.
- Each provider has its own provider id, derived from its issuer, so two
  providers never share an identity namespace.
- `/sign-in` and `/login` show one button per provider. Routing people to a
  provider by email domain is deferred.
- Each provider has an `authoritative` setting, `true` by default. A provider used
  only as a convenience login (for example gitlab.com) can be set to `false`.

### Linking: issuer and subject, never email alone

| Rule | Decision |
| --- | --- |
| Account key | (provider id, `sub`), as in #240. The same `sub` is the same person even when the email or name changes |
| Automatic linking by verified email | **Rejected.** A second provider, or a tenant admin, can assert any address. Entra's `email` "isn't guaranteed to be correct and is mutable over time". A takeover would carry the account's MCP grants, private notes and connections. #240 already refuses a new identity whose email belongs to another account |
| Explicit linking | A signed-in person with a recent sign-in ([step-up](#step-up-recent-sign-in-for-sensitive-actions)) chooses `Link <provider>` in Settings → Account and completes that provider's sign-in. The identity is attached unless another account already holds it |
| Unlinking | Allowed while another usable identity remains. An identity at an authoritative provider cannot be unlinked by its owner, so a person cannot escape offboarding |
| Migration and recovery | An operator command re-keys an identity, for example after an issuer change or a user re-created at the IdP with a new `sub`. It records the old and new key and revokes the account's MCP grants and access keys |

### How standing combines identities

- **Managed account** (it has at least one authoritative identity):
  - every request requires that no authoritative identity has ended;
  - the newest confirmation among its authoritative identities must be within the
    confirmation age;
  - this covers sessions and grants created with a password, so a password set
    earlier is no way around offboarding.
- **Unmanaged account:**
  - password and non-authoritative identities are plain sign-in methods with no
    confirmation age;
  - an identity that ends stops only the grants and sessions created through it;
  - with password sign-in off, a password-only account has no standing.

## MCPID-4 — Clients, headless machines and CI

### Client matrix

From vendor documentation read on 2026-10-05; Flux has run only the clients noted.

| Client | OAuth to Flux | Static header | Headless / SSH | Device grant |
| --- | --- | --- | --- | --- |
| Claude Code | Yes. `/mcp` or `claude mcp login`; CIMD and DCR; `--client-id`/`--callback-port` for pre-registration. Run against Flux with versions 2.1.281 and 2.1.283 ([evidence](../development/agent-connection.md#identities-and-consent)) | `--header "Authorization: Bearer …"`, or `headersHelper` for a short-lived token | Over SSH `claude mcp login` prints the URL, and the person pastes the redirect URL back | Not documented (request #20215 closed as a duplicate) |
| Codex | Yes. `codex mcp login`; CIMD when advertised, else DCR; `--oauth-client-id` | `bearer_token_env_var`, `http_headers`, `env_http_headers` | `mcp_oauth_callback_port` or `mcp_oauth_callback_url` | Not documented |
| Cursor | Yes, with DCR or static client credentials | `headers` with `${env:…}` | Not documented | Not documented |
| Other MCP clients | Through the MCP authorization specification | Varies | Varies | Not in the MCP specification |

Under A, an IdP changes nothing for the client. Only the browser step differs.

### Connection access keys (header-only clients and CI)

For clients that only send a fixed `Authorization` header, and for CI jobs where
nobody can open a browser:

- **Creating a key.** On `/connect-agent` the owner creates a key for one of their
  own connections. This needs a [recent sign-in](#step-up-recent-sign-in-for-sensitive-actions).
  The key's scopes are a subset of the connection's scopes.
- **Showing and storing.** Flux shows the key once and stores only its SHA-256
  hash and a short public prefix. The format is `fxk_<prefix>_<secret>`, with a
  256-bit secret.
- **Where it works.** The key is valid only at `<origin>/mcp`. `/api/v1`, the
  WebSocket and `/api/auth` refuse it.
- **Checks on every request.** Flux checks the key's hash, expiry and revocation,
  then runs the same checks as for an OAuth token: connection live, grants, owner
  access, scopes and standing.
- **Lifetime.** A key expires after at most `FLUX_MCP_ACCESS_KEY_MAX_DAYS` (default
  30, allowed 1–90) and has no refresh. It also stops at once when the connection
  is revoked, the owner revokes the key, or standing ends. For a managed account it
  also stops when confirmation is older than the confirmation age.
- **The Connect page** lists each key with its prefix, scopes, creation time, last
  use and expiry, and a Revoke action.
- **Operator switch.** `FLUX_MCP_ACCESS_KEYS` is `on` by default. With `off`, no key
  can be created and existing keys are refused.
- **The MCP specification.** For HTTP transports it says implementations "SHOULD"
  conform to its OAuth flow. A key departs from that "SHOULD" only for clients that
  cannot use OAuth. It is still issued by Flux for Flux's own resource, so it is
  not token passthrough.
- **CI guidance.** Create a dedicated connection named for the job, with read-only
  scope where possible and a short expiry. Store the key in CI secrets. Anyone who
  can read that secret acts as that connection within its grants. A key never
  represents a workspace bot (F-019). Machine identities through client credentials
  wait for the MCP client-credentials extension, which is a draft.

### Headless and remote machines

Use, in order:

1. **The client's own flow.** Over SSH, `claude mcp login flux` prints the
   authorization URL. Open it on the laptop, sign in (through the IdP if
   configured), approve, and paste the full redirect URL back at the prompt.
   Codex: set `mcp_oauth_callback_port` and forward it with
   `ssh -L <port>:127.0.0.1:<port>`, or set `mcp_oauth_callback_url`. Flux needs
   nothing extra: it accepts any loopback port (RFC 8252).
2. **A connection access key** when the client cannot finish OAuth, for example
   Claude Code in non-interactive mode, or a CI job.

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
| MCP refresh token | 30 days, rotated on every use, with a new 30-day expiry each time (sliding); 30-second retry window | Unchanged for unmanaged accounts. For a managed account, refused once the confirmation is older than the confirmation age |
| Browser session | 7 days, extended on use (Better Auth default; not overridden) | Also ends with standing; back-channel logout ends the matching sessions |
| Connection access key | — | At most 30 days by default (90 maximum), no refresh |
| IdP ID and access tokens | #240 keeps Better Auth's default, which stores them in `auth_accounts` in plain text (see below) | Encrypted at rest; never used for MCP |
| IdP refresh token (offline) | — | Encrypted at rest. Used only for the standing check, only against that IdP's token endpoint. Never sent to a client, logged or exported |

**IdP tokens at rest.** `auth_accounts` has `access_token`, `refresh_token` and
`id_token` columns. Better Auth 1.7.6 documents that "By default, OAuth tokens
(access tokens, refresh tokens, ID tokens) are stored in plain text in the
database", and offers `account.encryptOAuthTokens` (AES-256-GCM). #240 at
`8929beb6` does not set it. That it stores Keycloak's tokens this way is an
inference from the code, not an observed row. S1 turns encryption on, and S4
relies on it. Backups and exports must not carry these tokens in plain text.

The access-token lifetime is not what limits revocation in Flux: each request
reloads the connection and standing from the database. Shortening the JWT would
add refreshes without ending access sooner.

### Standing check (S4)

Default `FLUX_OIDC_STANDING=refresh`, interval 15 minutes.

1. At IdP sign-in, Flux asks for `offline_access`. It keeps the newest offline
   refresh token per identity and revokes the one it replaces at the IdP, so
   offline sessions do not pile up.
2. A worker job checks each identity that has a live browser session, MCP grant or
   access key. It runs when the last check is older than the interval, one check
   per identity at a time under a row lock, so a rotating refresh token is never
   raced. Each check is a `refresh_token` grant at the IdP's token endpoint,
   authenticated as Flux's client.
3. The outcome:
   - **Success.** Confirmation becomes now, and Flux stores any rotated refresh
     token. Name and verified email update from a returned ID token.
   - **`invalid_grant`.** The identity has **ended**. Keycloak 26.8.0 refuses a
     refresh for a disabled user with `invalid_grant` "User disabled", and for a
     removed offline session with "Offline user session not found" (source read).
     Entra stops issuing tokens after an admin clears "Account enabled" and revokes
     sessions.
   - **Network error, timeout or 5xx.** The result is **unknown**. Confirmation is
     unchanged, and the confirmation age decides.
4. When an identity ends at an authoritative provider:
   - Flux deletes the account's browser sessions;
   - it revokes every MCP refresh token and access key of the account;
   - MCP requests get 401 `invalid_token` with
     `error_description="Your sign-in with <label> has ended. Sign in again."`;
   - connections and standing grants remain the owner's objects; they work again
     only after a new sign-in and a new client authorization.
5. A later successful sign-in at that provider clears the ended state.

The request path never calls the IdP. It reads the stored standing, so an IdP
outage adds no latency to MCP calls.

`FLUX_OIDC_STANDING=off` is for providers that issue no usable offline refresh
token. Then only back-channel logout and the confirmation age apply.

### Confirmation age (S2)

`FLUX_OIDC_CONFIRMATION_MAX_AGE`, default `7d`, allowed `1h`–`30d`.

- A managed account is served only while its newest authoritative confirmation is
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

### Back-channel logout (S3)

- **Endpoint.** `POST <origin>/api/auth/oidc/backchannel-logout/<providerId>`.
  It sits under `/api/auth/`, so existing proxy rules already route it.
- **Validation.** Flux validates the logout token as OIDC Back-Channel Logout 1.0
  §2.6 requires:
  - the signature, from the provider's JWKS (`alg` none refused);
  - `iss`, `aud` (Flux's client id), `iat` and `exp`, with 60 seconds of clock
    tolerance;
  - the `events` member `http://schemas.openid.net/event/backchannel-logout`;
  - a `sub` or a `sid`, and no `nonce`;
  - `jti` not seen before (kept until the token's `exp`).

  It answers 200 on success and 400 otherwise.
- **Effect:**
  - with a `sid`, Flux ends the browser sessions created from that IdP session;
  - with only a `sub`, it ends all of that identity's browser sessions;
  - either way, it **queues an immediate standing check**.
- **MCP grants are not ended by the logout itself.** They are offline grants, and
  the specification says such refresh tokens "normally SHOULD NOT be revoked". The
  immediate check ends them when the IdP no longer honours Flux's offline refresh
  token. That is the downstream logout the specification calls "desirable" when an
  RP is also an OP.
- **To make every logout end agents too**, enable Keycloak's "Backchannel logout
  revoke offline sessions" for the Flux client.
- **Support differs.** Keycloak, Authentik and Zitadel send logout tokens. Entra,
  Google, Okta and GitLab do not. Keycloak 26.8.0 sends none when an admin
  **disables** a user (open issues #37981 and #10228). The standing check, not
  back-channel logout, is the offboarding mechanism.

### When MCP access stops

| Event | Browser sessions | MCP grants and keys | When |
| --- | --- | --- | --- |
| Owner revokes the connection, a standing grant or a key in Flux | Unchanged | Refused | Next request (existing for connections and grants) |
| Workspace admin removes the person | Lose that workspace | Refused for its projects | Next request (existing) |
| User disabled or deleted at the IdP, standing check on | Ended | Refreshes revoked, requests refused | Within the 15-minute interval plus job delay |
| Back-channel logout (Keycloak, Authentik, Zitadel) | Matching sessions ended | Checked at once; continue if the IdP still honours the offline token | Seconds |
| Logout with Keycloak "revoke offline sessions" on | Ended | Ended by the immediate check | Seconds |
| No signal (standing check off, or IdP refresh unsupported) | Ended at the confirmation age | Refused at the confirmation age | ≤ 7 days by default |
| IdP unreachable | Continue | Continue | Until the confirmation age; then "sign in again" |
| Password sign-in turned off | Password-only accounts refused | Same | Next request |
| SCIM deprovisioning | — | — | Deferred |

An access token the IdP issued to Flux itself is never used for MCP. Keycloak's
note that "Sign out all active sessions does not revoke outstanding access tokens"
therefore does not reach MCP clients.

### Step-up: recent sign-in for sensitive actions

These actions need the browser session to have authenticated within the last
10 minutes:

- approving an MCP grant with `flux.action.execute`;
- creating a standing grant or an access key;
- linking or unlinking an identity.

| Identity | How Flux gets a recent sign-in |
| --- | --- |
| Password | The person re-enters the password |
| Provider with re-authentication (Keycloak; Entra with the `auth_time` optional claim) | Flux redirects with `prompt=login` and `max_age=600`, then requires `auth_time` in the ID token to be within 10 minutes (60 seconds tolerance) |
| Provider without re-authentication (Google documents only `prompt` values `none`, `consent` and `select_account`) | A fresh provider round trip, which proves the person is still active but not that credentials were re-entered. The provider profile states which of the two applies |

This is separate from MCP's scope step-up. When a tool needs a scope the token
lacks, Flux keeps answering with the scope error. The client re-runs
authorization, and the consent step above applies.

## MCPID-6 — Operator configuration

### Settings

The #240 settings are proposed in an open PR; the rest are new in F-024.

| Variable | Default | Meaning |
| --- | --- | --- |
| `FLUX_PUBLIC_ORIGIN` | required | One HTTPS origin with no path. The MCP resource is `<origin>/mcp`; the issuer is `<origin>/api/auth` |
| `FLUX_OIDC_ISSUER`, `FLUX_OIDC_CLIENT_ID`, `FLUX_OIDC_CLIENT_SECRET_FILE`, `FLUX_OIDC_LABEL` | off | One provider (#240) |
| `FLUX_OIDC_PROVIDERS_FILE` | — | Several providers: issuer, client id, secret file, label, `authoritative`, `standing`, `confirmationMaxAge`, `profile`, extra authorization parameters (S5) |
| `FLUX_PASSWORD_SIGN_IN` | `on` | `off` allows only provider sign-in (S5) |
| `FLUX_OIDC_STANDING` | `refresh` | `off` disables the offline standing check (S4) |
| `FLUX_OIDC_CONFIRMATION_MAX_AGE` | `7d` | `1h`–`30d` (S2) |
| `FLUX_MCP_ACCESS_KEYS` | `on` | `off` refuses connection access keys (S7) |
| `FLUX_MCP_ACCESS_KEY_MAX_DAYS` | `30` | 1–90 (S7) |

### Who must reach what

| From → to | Paths | Why |
| --- | --- | --- |
| MCP client → Flux | `/mcp`, `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server/api/auth`, `/.well-known/openid-configuration/api/auth`, `/api/auth/*` | Discovery, registration, token and MCP calls |
| Browser → Flux and IdP | Flux origin; the IdP's authorization endpoint | The sign-in step |
| Flux → IdP | Discovery, JWKS, token and revocation endpoints | Sign-in verification and standing checks |
| IdP → Flux | `/api/auth/oidc/backchannel-logout/<providerId>` | Only if back-channel logout is configured |
| MCP client → IdP | none | Under A the client never talks to the IdP |

The proxy must pass these paths unchanged on the one public origin, as the
[integration guide](../integrations/README.md#for-operators) already requires.

### Provider profiles

A profile fixes the claim rules a provider needs. The default `oidc` profile
follows #240:

- the subject is `sub`;
- the email counts only with `email_verified: true`;
- `iss` must match exactly;
- re-authentication uses `prompt=login` and `max_age`.

The other profiles change only what their provider needs.

| Profile | Differences |
| --- | --- |
| `entra` | Entra's claims references list no `email_verified`, so #240's rule as written would refuse every Entra sign-in (an inference, untested against Entra). The email counts as verified only when the optional claim `xms_edov` is `true`. Requires the optional claims `email`, `xms_edov` and `auth_time`. `sub` is pairwise per application, so keep the app registration (re-registering changes every `sub`; use the re-key command) |
| `google` | Accepts `iss` `https://accounts.google.com` and `accounts.google.com`. Sends `access_type=offline`, because Google returns a refresh token only then and only on the first code exchange; `prompt=consent` obtains a new one when Flux has none. Can require an `hd` (Workspace domain) value. Re-authentication is confirm-only |
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
     `https://flux.example.org/api/auth/oidc/backchannel-logout/<providerId>`.
     Backchannel logout session required **On**. "Backchannel logout revoke
     offline sessions" **Off**, unless every logout should also end agents.
2. **Offline access:** make sure users have the `offline_access` realm role (check
   the realm's default roles), so Flux can hold an offline token for the standing
   check. Keycloak's default offline session idle is 30 days; Flux's checks every
   15 minutes keep it alive.
3. **Email:** turn on "Verify email", or set `emailVerified` when you create users.
   Flux refuses unverified emails.
4. **Flux `.env`:**

   ```sh
   FLUX_PUBLIC_ORIGIN=https://flux.example.org
   FLUX_OIDC_ISSUER=https://id.example.org/realms/acme
   FLUX_OIDC_CLIENT_ID=flux
   FLUX_OIDC_CLIENT_SECRET_HOST_FILE=/etc/flux/oidc_client_secret
   FLUX_OIDC_LABEL=Acme login
   # optional after people have linked their Acme identity:
   # FLUX_PASSWORD_SIGN_IN=off
   ```

5. **MCP clients:** nothing changes. Run
   `claude mcp add --transport http --scope user flux https://flux.example.org/mcp`,
   then `claude mcp login flux`. The browser shows Flux's sign-in with "Sign in with
   Acme login", then Keycloak, then Flux's connection choice and consent.
6. **Offboarding check:** disable a test user in Keycloak. Within the standing interval
   (15 minutes) plus the worker's delay, their
   Flux tab returns to sign-in, and their Claude Code gets "Your sign-in with Acme
   login has ended".

### Worked example: Microsoft Entra ID

1. **App registrations → New registration** "Flux", single tenant. Redirect URI
   (Web): `https://flux.example.org/api/auth/callback/<providerId>`. Entra requires
   https except for localhost.
2. **Certificates & secrets:** create a client secret and save it to the secret
   file. Note its expiry: an expired secret stops sign-in and standing checks.
3. **Token configuration → Add optional claim** (ID token): `email`, `xms_edov`
   and `auth_time`.
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
   the next check ends the identity.

### Other providers

- **Authentik.** Documents back-channel logout when "A user account is
  deactivated". Configure its back-channel URL as for Keycloak.
- **Zitadel.** Advertises back-channel logout. Whether deactivation triggers it is
  unverified.
- **Okta.** Its single logout is front-channel, and its "Universal Logout" uses
  Global Token Revocation, which Flux does not implement (deferred). Rely on the
  standing check.
- **Google Workspace.** No logout endpoint and no back-channel logout. Use profile
  `google` and the standing check.
- **GitLab.** Its discovery has no logout keys. `email` and `email_verified` come
  only with the email scope and a public email. Usually `authoritative: false`.

## MCPID-7 — Failures and edges

| Situation | Behaviour |
| --- | --- |
| IdP down when Flux starts | #240 reads discovery only at start and leaves single sign-on off until a restart. **Change (S1):** read discovery lazily with retry and backoff, and show `<label> is not reachable right now` on the sign-in pages. Password sign-in, when on, still works |
| IdP down later | New sign-ins and new MCP authorizations fail at the browser step with the same message. Existing browser sessions, MCP tokens and keys keep working until the confirmation age. The standing check records "unknown", not "ended" |
| Flux's IdP client secret expired or rotated | Sign-in and standing checks fail with `invalid_client`. Flux treats this as **unknown**, not as every person ending, and logs `OIDC_CLIENT_REJECTED` for the operator |
| Clock skew between Flux and IdP | ID-token and logout-token `iat`/`exp`/`auth_time` get 60 seconds of tolerance. Hosts must run NTP. MCP clients rely on `expires_in`; Flux verifies its own JWTs with its own clock |
| Email changed at the IdP | Same `sub`, same account (#240). The email updates at the next sign-in or standing check. MCP grants are unaffected. If the new email belongs to another account, the update is skipped and logged, and the person keeps signing in with the old email. #240's current behaviour in this case is untested; S1 tests it |
| User renamed at the IdP | Name updates; nothing else changes |
| User deleted and re-created, or merged, at the IdP | The new `sub` is a new identity. The old identity ends at its next standing check, which ends its grants. #240 refuses the new identity while the old account holds the email. The operator uses the re-key command to move the identity to the existing account |
| Issuer changed (new hostname or realm) | A new provider id, so everyone appears as a new identity (#240). Plan it with the re-key command. MCP clients key credentials by Flux's issuer, so they are unaffected unless `FLUX_PUBLIC_ORIGIN` changes |
| `FLUX_PUBLIC_ORIGIN` changed | Issuer, resource and redirect URIs change. Clients must re-register (MCP 2026-07-28) and people sign in again |
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
  - registration with CIMD and with DCR;
  - PKCE S256 with `resource`, and the `iss` check;
  - the code exchange, refresh and MCP `tools/list` and tool calls;
  - receiving its callback on a loopback port.

  Chromium drives the browser step through Flux `/login` → Keycloak → Flux consent.
- **Keycloak admin actions** through its admin REST API from the test container:
  disable a user, delete a user, end a user's sessions, change an email.
- **The mock provider** from #240 (`app/tests/app/support/oidc-mock.ts`), for what
  Keycloak cannot be made to do:
  - Entra-shaped and Google-shaped claims;
  - a missing or old `auth_time`;
  - bad logout tokens;
  - `invalid_grant` versus a 503 on refresh;
  - an unreachable IdP.
- **A short standing interval** in tests (for example 5 seconds), with the worker
  running.

| Case | Assertion |
| --- | --- |
| 1 Built-in | Existing `oauth-mcp` tests still pass. With password sign-in off, a password-only grant is refused at its next request |
| 2 OIDC on `/login` | An IdP-only person completes the scripted client's authorization from a fresh browser; the token has `aud` = `<origin>/mcp`; tools work. A tampered continuation is refused |
| 3 Several providers | Keycloak plus the mock: separate identities for the same email; explicit linking needs a recent sign-in; automatic email linking never happens; an authoritative identity cannot be unlinked |
| 4 Header-only | An access key works only at `/mcp`; it is refused after expiry, revocation, connection revocation, ended standing or `FLUX_MCP_ACCESS_KEYS=off`; its hash, never the key, is in the database and logs |
| 5 Headless | The scripted client completes authorization by posting the pasted redirect URL to its own loopback listener, mirroring Claude Code's paste-back |
| 6 Offboarding | Keycloak disable → within the interval: browser sessions gone, refresh `invalid_grant`, MCP 401 with the message, keys refused. Re-enable plus sign-in restores access after a new authorization. Back-channel logout ends matching browser sessions; MCP continues unless offline sessions were revoked. With standing off, MCP stops at the confirmation age (shortened in the test). Step-up refuses `flux.action.execute` consent with an `auth_time` older than 10 minutes |
| 7 No passthrough | A Keycloak-issued access token or ID token sent to `/mcp` gets 401. No IdP token appears in any MCP response, log line or export |
| 9 Failures | The mock IdP returning 503 leaves MCP working and records "unknown"; at the confirmation age it stops. A rejected client secret does not end any identity. A logout token with `nonce`, a replayed `jti`, a wrong `aud` or `alg` none gets 400 |

Real Claude Code and Codex runs against a Keycloak-backed Flux are recorded with
their versions as integration evidence (PROV-5). Mock clients do not prove vendor
compatibility. Entra and Google are not run in Docker; their profiles are tested
against the mock and stay "untested against the real provider" until someone
records a real run.

## Implementation slices

Each slice becomes its own issue in this milestone after this decision is
accepted. S1 depends on #240 merging. S2–S6 depend on S1. S7 is independent.

### S1 — Provider sign-in on the MCP authorization path

- **AC-1.** `/login` offers each provider. The IdP round trip keeps the signed
  OAuth query, and continuing re-verifies it.
- **AC-2.** The grant and the session record the identity (password or provider
  id), the confirmation time and the IdP `sid`.
- **AC-3.** Discovery is read lazily with retry. When the IdP is unreachable, the
  sign-in pages say so.
- **AC-4.** An IdP access token or ID token at `/mcp` gets 401.
- **AC-5.** IdP tokens are encrypted at rest (`encryptOAuthTokens`), and a database,
  backup and export check finds no IdP token in plain text.
- **AC-6.** Test cases 2 and 7, and the IdP-down rows of case 9.

### S2 — Confirmation age

- **AC-1.** A managed account's browser sessions, MCP refresh grants and MCP
  requests are refused past `FLUX_OIDC_CONFIRMATION_MAX_AGE`, with the stated
  error and message.
- **AC-2.** Re-authorization preselects the client's existing connection.
- **AC-3.** Unmanaged accounts keep today's lifetimes.
- **AC-4.** The confirmation-age rows of test case 6.

### S3 — OIDC back-channel logout receiver

- **AC-1.** §2.6 validation, with a `jti` replay store.
- **AC-2.** `sid` and `sub` session ending.
- **AC-3.** The immediate standing check.
- **AC-4.** The logout rows of test cases 6 and 9 against Keycloak and the mock.

### S4 — Standing check

- **AC-1.** `offline_access` at sign-in, with encrypted storage of the IdP refresh
  token and revocation of the replaced token.
- **AC-2.** A serialized worker check with success, ended and unknown outcomes.
- **AC-3.** Ending revokes sessions, refresh tokens and keys; a new sign-in
  restores standing.
- **AC-4.** The IdP refresh token never appears outside the encrypted column (an
  export, backup and log check).
- **AC-5.** The Keycloak disable/delete rows of test case 6.

### S5 — Password switch, several providers, linking and profiles

- **AC-1.** `FLUX_PASSWORD_SIGN_IN`.
- **AC-2.** `FLUX_OIDC_PROVIDERS_FILE` with per-provider `authoritative`,
  `standing`, `confirmationMaxAge` and `profile`.
- **AC-3.** The explicit link and unlink rules.
- **AC-4.** The `entra` and `google` profiles against the mock.
- **AC-5.** The operator re-key command. Test cases 1 and 3.

### S6 — Recent sign-in for sensitive actions

- **AC-1.** The 10-minute rule for the listed actions, for password,
  re-authenticating providers and confirm-only providers.
- **AC-2.** `prompt=login` and `max_age` with an `auth_time` check.
- **AC-3.** The step-up row of test case 6.

### S7 — Connection access keys and headless guidance

- **AC-1.** Create, list and revoke keys on `/connect-agent`, with the operator
  switches.
- **AC-2.** The hash-only storage, MCP-only validity and per-request checks.
- **AC-3.** The Connect page shows the Claude Code `--header`/`headersHelper` and
  Codex `bearer_token_env_var` commands next to the OAuth commands.
- **AC-4.** Test cases 4 and 5.

Each slice also updates the operator guide (`docs/operations/single-sign-on.md`
from #240) and the [integration guide](../integrations/README.md).

## Rejected and deferred

| Option | Status | Reason / revisit when |
| --- | --- | --- |
| IdP as the MCP authorization server (B) | Rejected | [Why not B](#why-not-b). Revisit if the MCP specification requires a separate authorization server, or if supported IdPs and clients all implement RFC 8707 and CIMD, and Flux can drop per-connection tokens |
| Accepting or exchanging IdP tokens at `/mcp` (C) | Rejected | Token passthrough; it removes per-client consent |
| Automatic account linking by email | Rejected | Account takeover across providers. Revisit only with a per-provider verified-domain policy and a security review |
| Device authorization grant (RFC 8628) | Deferred | No supported client implements it for MCP. Revisit when Claude Code or Codex does |
| Enterprise-managed authorization / ID-JAG (D) | Deferred | The MCP extension is "Stable", but the IETF draft is -04 and the MCP client matrix lists neither Claude Code nor Codex. It fits A: Flux would accept the grant and still issue its own token |
| SCIM provisioning | Deferred | Better Auth 1.7.6 ships a `scim` package. Keycloak 26.8's SCIM is an inbound server for managing Keycloak's own users. Revisit when an operator needs pre-provisioning or immediate push deprovisioning; the standing check covers offboarding meanwhile |
| Shared Signals (Keycloak SSF RISC events), Okta Global Token Revocation, Entra CAE | Deferred | Experimental or vendor-specific push signals. Revisit when one is stable in a provider Flux users run |
| Path-prefix deployment | Not supported | MCPID-7. Revisit if operators cannot provide a host name |
| SAML | Out of scope | As in #240 |

## Revisit when

- An MCP specification revision changes authorization, discovery or registration.
- Claude Code or Codex adds the device grant or ID-JAG.
- A supported IdP's refresh behaviour for disabled users differs from what is
  recorded here.
- The standing check's load on an IdP proves too high at the 15-minute interval.
