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
**Owner:** @PelikanFix16 (`claude-hubert`). **Issue:** [#273](https://github.com/ColdPhase/flux/issues/273).
**Evidence:** [research note](research/2026-10-05-mcp-identity.md), retrieved 2026-10-05;
corrections and closed items re-verified 2026-10-06 (its last section). Labels
[S] specification, [V] vendor documentation, [C] code read at a pinned revision,
[O] observed response and [I] inference are as defined there.
The [2026-10-07 necessity assessment](research/2026-10-07-single-provider-identity-scope.md)
records the amendment's source observations, primary sources, counter-evidence
and remaining limitations. The older research remains historical.

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
   action. With a provider configured, password sign-up is off or verified-only, an
   unverified account never blocks a provider identity, and a managed account does
   not sign in with a password ([MCPID-3](#mcpid-3--several-providers-and-account-linking)).
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
6. **Release position.** v0.1.0 requires S1, S4, S2, S5a, S3, the narrowed S5b
   and S6. S7 is canceled, not delivered or promised after v0.1
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

### Password sign-in on or off

New operator setting `FLUX_PASSWORD_SIGN_IN`: `on` (default) or `off`.

- **On:** the behaviour of #240. Passwords and providers sit side by side.
- **Off:**
  - Password sign-in, sign-up and reset requests are refused with
    `PASSWORD_SIGN_IN_DISABLED`.
  - `/sign-in` and `/login` show only the configured provider.
  - A password-only account has no standing, so its browser sessions, MCP grants,
    runtime run tokens and owner compute stop at their next authorization check. An account with a provider identity
    keeps working through that identity.
- **Either way,** a managed account never signs in with a password
  ([password rules](#password-sign-up-reset-and-email-collisions)).
- **Before switching off:** people link their provider identity while signed in
  ([MCPID-3](#mcpid-3--several-providers-and-account-linking)).
- **Break-glass:** set `on` and restart. Managed accounts also need their provider
  set non-authoritative (`FLUX_OIDC_AUTHORITATIVE=false`). Both are operator actions on the host, never settings in
  the web UI.
- **First owner:** signs in through the provider; creating a workspace works as
  today.

<a id="mcpid-3--several-providers-and-account-linking"></a>
## MCPID-3 — One provider and safe account migration

### One configured provider

- Keep #240's single issuer, client id, label and secret configuration. There is
  no provider-list file, simultaneous selection or multi-provider standing policy.
- The provider id remains derived from its issuer; an identity is always bound
  to that issuer and `sub`, never to its email address alone.
- `/sign-in` and `/login` offer that provider and, when the operator allows it,
  the existing password method.
- The provider's `authoritative` setting is `true` by default. A provider used
  only as a convenience login (for example gitlab.com) can be set to `false`.

### Linking: issuer and subject, never email alone

| Rule | Decision |
| --- | --- |
| Account key | (provider id, `sub`), as in #240. The same `sub` is the same person even when the email or name changes |
| Automatic linking by verified email | **Rejected.** A second provider, or a tenant admin, can assert any address. Entra's `email` "isn't guaranteed to be correct and is mutable over time". A takeover would carry the account's MCP grants, private notes and connections. #240 already refuses a new identity whose email belongs to another account; S5a narrows that to verified emails ([below](#password-sign-up-reset-and-email-collisions)) |
| Explicit conversion | A signed-in owner with recent confirmation ([step-up](#step-up-recent-sign-in-for-sensitive-actions)) attaches the sole configured provider after its verified sign-in. Preserve the same Flux account ID, private data, roles, memberships and applicable grants. Reject an identity another account already holds. The page says that an authoritative identity makes the account managed and its password stops working |
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
- **Unmanaged account:**
  - password and the sole non-authoritative identity are plain sign-in methods with no
    confirmation age;
  - an identity in sign-in required stops only the grants and sessions created
    through it;
  - with password sign-in off, a password-only account has no standing.

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
| Password sign-up | New setting `FLUX_PASSWORD_SIGN_UP`: `off` or `verified`, default `off`. With `verified`, a new password account cannot sign in, and is not found by email, until its email is verified. Without any provider the setting is not read and sign-up works as today |
| Adding a member by email | Matches only an account whose email is verified. Otherwise the answer is the same `ACCOUNT_NOT_FOUND` as for no account |
| Provider identity, email held by a **verified** account | Refused, as in #240. The page tells the person to sign in to that account and link the provider (explicit linking) |
| Provider identity, email held by an **unverified** account | The unverified account never blocks it. Flux offers two choices: sign in to the existing account and link the provider, or claim the address. Claiming releases the address from the unverified account: its email becomes `unverified-<account id>@invalid` (the `.invalid` top-level domain of RFC 2606), its sessions and MCP grants end, and an audit event names both accounts. Flux then creates the provider account. The released account keeps its data; the operator's re-key command can attach an identity to it later |
| Password reset | Never creates a password: an account without a password is refused (`NO_PASSWORD`). A managed account is refused (`MANAGED_ACCOUNT`) |
| Password sign-in on a managed account | Refused (`MANAGED_ACCOUNT`), with the provider buttons shown. Setting the provider non-authoritative (`FLUX_OIDC_AUTHORITATIVE=false` for #240's single provider) and restarting is the operator's break-glass |

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
   needs from the ID token (`sub`, `sid`, `auth_time`, the verified email and the
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
6. **A successful sign-in through that identity** clears the state. Keys work
   again, a client that kept its refresh token can refresh, and a client that
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
| Password sign-in turned off | Password-only accounts refused | Same | Next request |
| SCIM deprovisioning | — | — | Deferred |

An access token the IdP issued to Flux itself is never used for MCP, and Flux does
not keep it. Keycloak's note that "Sign out all active sessions does not revoke
outstanding access tokens" therefore does not reach MCP clients.

### Step-up: recent sign-in for sensitive actions

Only these authority-increasing actions need human authentication or the
provider's explicitly documented confirmation within the last 10 minutes:

- approving an MCP grant with `flux.action.execute`;
- creating a standing grant;
- explicitly attaching the sole configured provider to an existing account.

Ordinary reads/editing, existing agent calls/runs, token refresh, reconnect,
revocation and narrowing authority do not prompt again. Standing proves that
the IdP still serves an account; an offline refresh, a new token issue time or a
new Flux session does not prove recent human authentication. Bind the continuation
to the same account, session/action and signed OAuth request. Cancellation,
failure, stale claims or an identity substitution cannot increase authority.

| Identity | How Flux gets a recent sign-in |
| --- | --- |
| Password | The person re-enters the password |
| Provider with re-authentication (Keycloak; Entra with the `auth_time` optional claim) | Flux redirects with `prompt=login` and `max_age=600`, then requires `auth_time` in the ID token to be within 10 minutes (60 seconds tolerance). Entra documents `prompt=login` but not `max_age`; the `auth_time` check does not depend on it |
| Provider without re-authentication (Google documents only `prompt` values `none`, `consent` and `select_account`, and no `max_age`) | A fresh provider round trip, which proves the person is still active but not that credentials were re-entered. The provider profile states which of the two applies |

The confirm-only case is weaker than credential re-entry and must be disclosed
in the chosen provider's operator guidance. Do not claim equivalent protection
or silently fall back to a password for a managed account. The 10-minute policy
is Flux's narrow safeguard, not a general OIDC requirement or a complete defense
against a compromised browser.

This is separate from MCP's scope step-up. When a tool needs a scope the token
lacks, Flux keeps answering with the scope error. The client re-runs
authorization, and the consent step above applies.

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
| `FLUX_PASSWORD_SIGN_IN` | `on` | `off` allows only provider sign-in (S5) |
| `FLUX_PASSWORD_SIGN_UP` | `off` | Read only when a provider is configured: `off` or `verified` (S5a) |
| `FLUX_OIDC_AUTHORITATIVE` | `true` | For #240's single provider. `false` makes it a convenience login whose identities do not make an account managed; also the break-glass for managed accounts' passwords (S5a) |
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
   # password sign-up stays off while a provider is configured; to allow it:
   # FLUX_PASSWORD_SIGN_UP=verified
   # optional after people have linked their Acme identity:
   # FLUX_PASSWORD_SIGN_IN=off
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
- **Google Workspace.** No logout endpoint and no back-channel logout. Its
  documentation lists no `max_age` and no `prompt=login`. Use profile `google` and
  the standing check.
- **GitLab.** Its discovery has no logout keys. `email` and `email_verified` come
  only with the email scope and a public email. Usually `FLUX_OIDC_AUTHORITATIVE=false`.

## MCPID-7 — Failures and edges

| Situation | Behaviour |
| --- | --- |
| IdP down when Flux starts | #240 reads discovery only at start and leaves single sign-on off until a restart. **Change (S1):** read discovery lazily with retry and backoff, and show `<label> is not reachable right now` on the sign-in pages. Password sign-in, when on, still works |
| IdP down later | New sign-ins and new MCP authorizations fail at the browser step with the same message. Existing browser sessions, MCP tokens keep working until the confirmation age. The standing check records "unknown", not "sign-in required" |
| IdP step fails during an MCP authorization | Back to `/login` with the same signed OAuth query and a message (S1) |
| Flux's IdP client secret expired or rotated | Sign-in and standing checks fail with `invalid_client`. Flux treats this as **unknown**, not as every person needing to sign in, and logs `OIDC_CLIENT_REJECTED` for the operator |
| Lost response to a standing check | Unknown. The next check uses the previous refresh token, which the IdP still accepts unless it makes refresh tokens single-use; then sign-in required |
| Clock skew between Flux and IdP | ID-token and logout-token `iat`/`exp`/`auth_time` get 60 seconds of tolerance. Hosts must run NTP. MCP clients rely on `expires_in`; Flux verifies its own JWTs with its own clock |
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
  - a missing or old `auth_time`;
  - bad logout tokens, and logout tokens with `revoke_offline_access`;
  - `invalid_grant` versus a 503 on refresh, a lost rotation response, and no
    refresh token at all;
  - an unreachable IdP.
- **A short standing interval** in tests (for example 5 seconds), with the `api`
  running the check and the `worker` running.

| Case | Assertion |
| --- | --- |
| 1 Built-in | Existing `oauth-mcp` tests still pass. With password sign-in off, a password-only grant is refused at its next request |
| 2 OIDC on `/login` | An IdP-only person completes the scripted client's authorization from a fresh browser; the token has `aud` = `<origin>/mcp`; tools work. A tampered continuation is refused. A cancelled or failed IdP step returns to `/login` with the query, and the authorization then completes. Consent after the IdP step shows the redirect host and the `client_id` host, the loopback line or the non-loopback warning, and cannot be framed. A loopback redirect on another port is accepted as `localhost` and as `127.0.0.1`; a different path or host is refused |
| 3 Single-provider conversion and recovery | Separate Keycloak/mock configuration runs for the sole provider: preserve an existing account's data, roles and applicable grants after explicit confirmed conversion; reject duplicate identity and email auto-linking; prevent lockout/offboarding escape; audit re-key recovery and revoke old authority; test only the selected supported provider's relevant claims |
| 4 Account safety | With a provider configured: password sign-up is refused; with `verified`, an unverified account cannot sign in and is not found when adding a member by email. A provider identity whose email a verified account holds is refused with link guidance. One whose email an unverified account holds can link or claim; claiming releases the address, ends that account's sessions and MCP grants, and writes the audit event. A reset is refused for an account without a password and for a managed account. A managed account's password sign-in is refused, and works again with the provider set non-authoritative |
| 5 Canceled opaque keys | No additional key minting/storage/UI/settings are admitted. Existing OAuth issuer/audience, owner/grant/standing checks and unsupported-bearer refusals remain; this is cancellation, not successful implementation of S7 |
| 6 Headless | The scripted client completes authorization by posting the pasted redirect URL to its own loopback listener, mirroring Claude Code's paste-back |
| 7 Offboarding | Keycloak disable → within the interval: browser sessions gone, refresh `invalid_grant`, MCP 401 with the `error_description` (a label with non-ASCII characters is reduced to allowed characters), MCP requests refused, nothing revoked. Re-enable plus sign-in: a client that kept its refresh token can refresh. Removing the Flux client's offline session at Keycloak gives the same suspension. In sign-in required, an O-008 personal run (mock provider) is not dispatched, and, once F-022 run tokens exist, none is minted or accepted. Back-channel logout ends matching browser sessions and MCP continues; with "Backchannel logout revoke offline sessions" on, the MCP refresh tokens are revoked. With standing off, MCP stops at the confirmation age (shortened in the test). Step-up refuses authority-increasing execute consent/standing-grant creation/provider linking with stale or substituted proof; fresh-confirmation continuations stay bound to the same account/action. Ordinary work, revoke and narrowing remain prompt-free; confirm-only assurance is disclosed |
| 8 No passthrough and token storage | A Keycloak-issued access token or ID token sent to `/mcp` gets 401. After sign-in, `auth_accounts` holds no IdP access or ID token, and the IdP refresh token is only in its own table, encrypted. A dump made with the backup's `pg_dump` arguments has no row of that table; after restoring it, managed accounts are in sign-in required until they sign in. No IdP token appears in any MCP response, log line or export |
| 9 Failures | The mock IdP returning 503 leaves MCP working and records "unknown"; at the confirmation age it stops. A rejected client secret puts nobody in sign-in required. After a lost rotation response, the next check succeeds with the previous token. A logout token with `nonce`, a replayed `jti`, a wrong `aud` or `alg` none gets 400. Every back-channel response has `Cache-Control: no-store` |

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
  interfaces and S6's confirmation for linking. S7 has no planned implementation.

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
- **The narrow S6 gates it.** #316 requires recent authentication or explicitly
  weaker provider confirmation only when execute consent, a new standing grant
  or provider linking increases authority.
- **S7 is canceled.** #317 is `not_planned`, not implemented or deferred delivery.
  Tested personal-client SSH/paste-back/callback guidance remains in S1/#310 and
  #152. No key UI, key endpoint or unsupported fully unattended consumer is added.

All implementation and independent evidence remain required. The prior deferred
scope and its observations are preserved in the dated research and GitHub records.

### S1 — Provider sign-in on the MCP authorization path

- **AC-1.** `/login` offers each provider. The IdP round trip keeps the signed
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

- **AC-1.** `FLUX_PASSWORD_SIGN_UP` (`off` or `verified`), read when a provider is
  configured.
- **AC-2.** Adding a member by email matches only a verified email when a provider
  is configured.
- **AC-3.** The collision rules: refused with link guidance for a verified account;
  link or claim for an unverified one, with the audit event.
- **AC-4.** A reset never creates a password and is refused for a managed account; a
  managed account's password sign-in is refused. `FLUX_OIDC_AUTHORITATIVE`
  (default `true`) sets #240's single provider non-authoritative for break-glass.
- **AC-5.** Test case 4.

<a id="s5b--password-switch-several-providers-linking-and-profiles"></a>
### S5b — Password mode, safe migration and provider claim adapters

Required in v0.1 under [#315](https://github.com/ColdPhase/flux/issues/315).
Depends on S1/#310, S5a/#313 account-safety interfaces and S6/#316 for linking.

- **AC-1 — One provider and password mode.** Keep one configured issuer. Add
  `FLUX_PASSWORD_SIGN_IN` on/off, honest startup/UI states and refusal of password
  sign-in, sign-up/reset and existing password-only authority when off. Preserve
  S5a's managed-account/break-glass rules. No provider-list file, simultaneous
  provider selection or multi-authoritative aggregation.
- **AC-2 — Existing-account conversion.** An explicitly signed-in owner with
  S6's recent confirmation may attach the sole provider after its verified
  sign-in. Preserve the same account ID, private data, memberships and applicable
  grants. Reject an identity already held by another account and all automatic
  email-based linking. An authoritative identity cannot be detached to evade
  offboarding; the last usable identity cannot be removed. Compose S5a's
  link-first collision guidance. Claiming an unverified email never transfers
  that account's data.
- **AC-3 — Claims and recovery.** Retain verified issuer/subject/email rules and
  only the claim adapters required by the selected supported provider. These
  profiles are provider compatibility rules, not person-profile pages or extra
  concurrent providers. Operator re-key recovery preserves the account/history,
  audits old/new issuer and subject, and revokes old MCP authority. Entra/Google
  support stays unverified without corresponding real-provider evidence; mock
  claim tests do not establish compatibility.
- **AC-4 — Evidence.** Docker Keycloak and scripted MCP/mock-provider positive
  and negative controls prove password-off enforcement, existing-account
  conversion, duplicate-identity refusal, lockout prevention, authority
  revocation, rejected email linking, recovery and the relevant claims. Preserve
  the remaining accepted cases 1 and 3; replace simultaneous providers with
  separate single-provider configuration runs. Obtain exact-head independent
  review. Do not require every vendor profile without an admitted supported use.

### S6 — Recent sign-in for sensitive actions

- **AC-1.** The 10-minute rule for the listed actions, for password,
  re-authenticating providers and confirm-only providers, only for execute
  consent, creating a standing grant and linking the sole provider. Reads,
  editing, existing calls/runs, refresh, revocation and narrowing do not prompt.
- **AC-2.** Verify a password or, for a provider supporting re-authentication,
  use `prompt=login`/`max_age` and verify the ID token's `auth_time` within the
  window/tolerance. A refresh or new session timestamp is not human authentication.
  Bind the continuation to the same account, session/action and signed OAuth
  request; cancellation, failure, stale claims or identity substitution cannot
  increase authority.
- **AC-3.** Disclose confirm-only providers' weaker assurance. Docker Keycloak
  and mock positive/negative controls exercise case 7 plus ordinary no-prompt,
  revoke and narrow controls. No claim of a complete compromised-browser defense.

Required in v0.1 under [#316](https://github.com/ColdPhase/flux/issues/316), after
S1/#310. Canceled S7 keys are not a target of this slice.

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
