# Research: MCP sign-in with external identity providers (2026-10-05)

Evidence for [F-024](../mcp-identity.md), issue
[#273](https://github.com/ColdPhase/flux/issues/273). Retrieved 2026-10-05 by
`claude-hubert`. Corrected and extended on 2026-10-06 for the
[review of `f90c2350`](https://github.com/ColdPhase/flux/pull/274). Statements fixed in
place say "corrected 2026-10-06", and [section 11](#11-re-verification-2026-10-06)
lists the 2026-10-06 sources.

**Question.** How should MCP clients (Claude Code, Codex, Cursor and other MCP
clients) authenticate to a self-hosted Flux whose people sign in through an
external OpenID Connect provider? How does access end when the provider disables
a person?

**Method.**

- **MCP specification, RFCs and client docs.** Downloaded as Markdown or text with
  `curl` and searched. Some pages were read through a fetch tool that converts the
  page; those are marked [fetched].
- **Flux code.** Read at `main` `698313b3` and at #240's head `8929beb6`; #240
  re-read at `9aa90409` on 2026-10-06.
- **Better Auth 1.7.6 and Keycloak 26.8.0 source.** Read through the GitHub API at
  their release tags.
- **Not done:** no Docker stack was started, and no IdP or MCP client was run for
  this note.

**Labels.**

- **[S]** specification or RFC text;
- **[V]** vendor documentation, which is a claim about the product;
- **[C]** code read at a pinned revision;
- **[O]** a response observed from a live service (added 2026-10-06);
- **[I]** our inference.

Quotes are verbatim; whitespace is collapsed.

## 1. MCP specification

**Current revision.** [Versioning](https://modelcontextprotocol.io/specification/versioning)
[S]: "The **current** protocol version is **2026-07-28**".

- The `draft` changelog has no authorization entries.
- The draft authorization page matches the 2026-07-28 page apart from its paths.
- [I] 2026-07-28 is the revision to design against.

[Authorization, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) [S]:

- Scope:
  - "Authorization is **OPTIONAL** for MCP implementations."
  - "Implementations using an HTTP-based transport **SHOULD** conform to this
    specification."
- Roles: "The implementation details of the authorization server are beyond the
  scope of this specification. It may be hosted with the resource server or a
  separate entity."
- Protected resource metadata: "MCP servers **MUST** implement OAuth 2.0 Protected
  Resource Metadata (RFC9728). MCP clients **MUST** use OAuth 2.0 Protected
  Resource Metadata for authorization server discovery."
- Resource indicators: "MCP clients **MUST** send this parameter regardless of
  whether authorization servers support it."
- Audience: "MCP servers **MUST** validate that access tokens were issued
  specifically for them as the intended audience".
- No other tokens: "MCP servers **MUST NOT** accept or transit any other tokens."
- Tokens in URLs: "Access tokens **MUST NOT** be included in the URI query string".
- Scope challenges: 403 with `error="insufficient_scope"`, and "Clients **MUST**
  treat the scopes provided in the challenge as authoritative for the current
  operation."

[Client registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration)
[S]: "Clients supporting all options **SHOULD** use the following priority order":

1. pre-registered client information;
2. Client ID Metadata Documents "if the Authorization Server indicates that it
   supports them";
3. Dynamic Client Registration "as a fallback";
4. prompting the user.

[Security considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)
[S]:

- "The MCP server **MUST NOT** pass through the token it received from the MCP
  client."
- "MCP clients **MUST** use the `S256` code challenge method when technically
  capable".
- Refresh tokens: "For public clients, authorization servers **MUST** rotate refresh
  tokens" (section "Token Theft"). Corrected 2026-10-06: this rule is on this page,
  not on the authorization page.
- Localhost redirects (added 2026-10-06): "Client ID Metadata Documents cannot
  prevent `localhost` URL impersonation by themselves. Authorization servers:
  **SHOULD** display additional warnings for `localhost`-only redirect URIs …
  **MUST** clearly display the redirect URI hostname during authorization".

[Changelog 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/changelog) [S]:

- "Authorization servers **SHOULD** include the `iss` parameter in authorization
  responses per RFC 9207, and MCP clients **MUST** validate a present `iss`".
- "clients **MUST** key persisted credentials by the issuer identifier, **MUST NOT**
  reuse them with a different authorization server, and **MUST** re-register when
  the authorization server changes".
- "Deprecate the OAuth 2.0 Dynamic Client Registration Protocol (RFC7591) as a
  client registration mechanism in favor of Client ID Metadata Documents".

[Security best practices](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices)
[S]:

- Token passthrough: "MCP servers **MUST NOT** accept any tokens that were not
  explicitly issued for the MCP server."
- Confused deputy: "MCP proxy servers **MUST** implement per-client consent".
- Consent page (added 2026-10-06), "Consent UI Requirements": it "**MUST**: … Show
  the registered `redirect_uri` where tokens will be sent … Prevent iframing via
  `frame-ancestors` CSP directive or `X-Frame-Options: DENY` to prevent
  clickjacking".
- [I] Flux uses one static client at the IdP for every MCP client. That is the
  proxy shape this guidance describes, so Flux keeps its own per-client consent
  before and after the IdP step.

**Enterprise-managed authorization.** The extension is
`io.modelcontextprotocol/enterprise-managed-authorization`
([extension](https://modelcontextprotocol.io/extensions/auth/enterprise-managed-authorization)).

- [S] "**Status**: Stable" appears only in the `ext-auth` repository
  (`specification/stable/enterprise-managed-authorization.mdx`). The
  modelcontextprotocol.io page shows no status and links to that file (corrected
  2026-10-06).
- [S] The client "requests a special type of token from the enterprise IdP called
  an Identity Assertion JWT Authorization Grant, or ID-JAG", then "exchanges the
  ID-JAG for an access token from the MCP server's Authorization Server".
- [S] The IETF [draft](https://datatracker.ietf.org/doc/draft-ietf-oauth-identity-assertion-authz-grant/)
  is at -04 (2026-05-21), a working-group document.
- [V] The [client matrix](https://modelcontextprotocol.io/extensions/client-matrix)
  does not list Claude Code or Codex as supporting it.

**Device flow and client credentials.**

- [S] The 2026-07-28 authorization pages do not mention the device grant.
- SEP-2059 ("OAuth Device Flow for stdio MCP Servers") was closed unmerged on
  2026-01-09.
- [S] The client-credentials extension's file in the `ext-auth` repository
  (`specification/draft/oauth-client-credentials.mdx`) reads "**Protocol
  Revision**: draft". Corrected 2026-10-06; the site page shows no status.

## 2. RFCs

- **RFC 9728 (April 2025)** [S]: the well-known suffix goes "between the host
  component and the path and/or query components"; `authorization_servers` is a
  "JSON array containing a list of OAuth authorization server issuer identifiers".
- **RFC 8414 (June 2018)** [S]: for an issuer with a path, insert "/.well-known/" and
  the suffix "between the host component and the path component".
- **RFC 8707 (February 2020)** [S]: "The authorization server SHOULD
  audience-restrict issued access tokens to the resource(s) indicated by the
  "resource" parameter."
- **RFC 8252 (October 2017)** [S]: "The authorization server MUST allow any port to be
  specified at the time of the request for loopback IP redirect URIs".
- **RFC 8628 (August 2019), §5.4** [S]: "It is possible for the device flow to be
  initiated on a device in an attacker's possession."
- **RFC 9700 (January 2025)** [S]: "Refresh tokens for public clients MUST be
  sender-constrained or use refresh token rotation".
- **RFC 9068 (October 2021)** [S]: JWT access tokens carry `typ` `at+jwt`.
- **RFC 7009 (August 2013)** [S]: lets clients tell the server that "a previously
  obtained refresh or access token is no longer needed".

## 3. MCP clients

**Claude Code** ([MCP docs](https://code.claude.com/docs/en/mcp)). The page is
undated; the newest version it mentions is 2.1.285.

- [V] Static header: `claude mcp add --transport http … --header "Authorization:
  Bearer your-token"`.
- [V] CIMD: "Claude Code also supports servers that use a Client ID Metadata Document
  (CIMD) instead of Dynamic Client Registration, and discovers these automatically."
- [V] Callback port: "Use `--callback-port` to fix the port so it matches a
  pre-registered redirect URI".
- [V] Headless: `claude mcp login` "detects when no local browser is available, such
  as during an SSH session or on Linux without a display server, and prints the
  authorization URL instead of trying to open a browser. Open the URL on your local
  machine, then paste the full redirect URL from your browser's address bar back at
  the prompt."
- [V] Other schemes: `headersHelper` is for "an authentication scheme other than
  OAuth, such as Kerberos, short-lived tokens, or an internal SSO".
- [V] Non-interactive mode: "In non-interactive mode there's no `/mcp` panel, so
  Claude Code can't run the OAuth flow for you."
- [V] Redirect (added 2026-10-06): it uses "a pre-registered redirect URI of the
  form `http://localhost:PORT/callback`".
- [V] The device grant request
  [anthropics/claude-code#20215](https://github.com/anthropics/claude-code/issues/20215)
  was closed as a duplicate on 2026-01-26, and the docs do not mention a device
  grant.

**Codex** ([MCP docs](https://developers.openai.com/codex/mcp)). The latest release
is 0.160.1 (2026-10-05). On 2026-10-06 that address answers 308 to
[learn.chatgpt.com/docs/extend/mcp?surface=cli](https://learn.chatgpt.com/docs/extend/mcp?surface=cli),
which still has every quote below.

- [V] "Bearer token authentication … OAuth authentication, including Client ID
  Metadata Documents (CIMD) and Dynamic Client Registration (DCR)".
- [V] Config keys:
  - "`bearer_token_env_var` (optional): Environment variable name for a bearer
    token to send in `Authorization`."
  - `http_headers` and `env_http_headers`;
  - `mcp_oauth_callback_port`;
  - `mcp_oauth_callback_url`, "when you need a custom callback path or remote
    Devbox ingress URL".
- [V] Login: "Run `codex mcp login <server-name>` separately to start an MCP OAuth
  login."
- [V] Ports: "Authorization servers must accept variable loopback ports under RFC
  8252, Section 7.3."
- [V] Redirect (added 2026-10-06): `http://127.0.0.1:<port>/callback/<callback_id>`.
- [V] Pre-registration (added 2026-10-06): "A configured OAuth client ID always
  takes precedence and skips client registration."

**Cursor** ([MCP docs](https://cursor.com/docs/mcp), undated) [V]:

- "Cursor supports OAuth for servers that require it."
- Static client credentials can replace dynamic registration: "you can provide
  **static OAuth client credentials** in `mcp.json` instead of dynamic client
  registration".
- Headers support `${env:…}`.
- Added 2026-10-06: the page does not mention Client ID Metadata Documents. Its
  redirect addresses are `https://www.cursor.com/agents/mcp/oauth/callback` and,
  for the desktop app, `http://localhost:8787/callback`.
- [I] Flux offers no RFC 7591 registration (#294), so Cursor needs an operator
  pre-registered client.

## 4. Flux today

[C] Read at `main` `698313b3`:

- **The authorization server.** `app/apps/server/src/identity/auth.ts` configures
  Better Auth with `jwt()`, `mcp()` and `cimd()`:
  - resource `<origin>/mcp`;
  - scopes `flux.context.read`, `flux.proposal.write`, `flux.action.execute` and
    `offline_access`;
  - grant types `authorization_code` and `refresh_token`;
  - no session cookie cache;
  - email and password sign-in only.
- **The MCP route.** `app/apps/server/src/agent-connection/mcp-route.ts` verifies
  the JWT against Flux's own JWKS and the resource. It reloads the connection and
  grant reference before serving any tool.
- **Discovery.** `app/apps/server/src/identity/bridge.ts` serves
  `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/mcp`,
  `/.well-known/oauth-authorization-server/api/auth` and
  `/.well-known/openid-configuration/api/auth`.
- **The public origin.** `app/apps/server/src/identity/config.ts` refuses a
  `FLUX_PUBLIC_ORIGIN` with a path: "must be an origin without path, query or
  credentials".
- **Removal.** Removing a workspace member deletes their project grants
  (`removeMember` in `app/packages/core/src/access/domain.ts`).
- **No instance-wide suspension.** There is no instance-wide account suspension.
- **Client registration** (added 2026-10-06). [C] #294 (open, for #287) sets
  `allowDynamicClientRegistration: false` and `clientPrivileges: () => false` on the
  `mcp()` plugin, so clients arrive through CIMD or operator pre-registration. Its
  documentation says RFC 7591 registration "stays off".
- **Password accounts** (added 2026-10-06). [C] `emailAndPassword` is enabled
  without `requireEmailVerification`. `addMember` looks an account up by email
  without checking verification (`app/packages/core/src/access/domain.ts:245`).

[C] #240 at `8929beb6` (open):

- **Sign-in.** It adds `genericOAuth` for one provider:
  - PKCE;
  - `requireIdTokenVerification`;
  - scopes `openid email profile`;
  - the account keyed by the issuer-derived provider id and `sub`;
  - `disableImplicitLinking`.
- **Claims.** `oidcUser` accepts only `iss` equal to the configured issuer and
  `email_verified === true`.
- **`/login`.** `app/apps/web/src/auth/pages.tsx:140` renders the single sign-on
  button only when `location.pathname !== '/login'`, and `/login` is the OAuth
  authorization page. At `9aa90409` the line is `:143`, and the operator guide
  documents the workaround (sign in at `/sign-in` first).
- **Error return** (added 2026-10-06, `app/apps/web/src/api/auth.ts:35` at
  `9aa90409`): `errorCallbackURL: '/sign-in?sso=failed'`.
- **Secret file** (added 2026-10-06): `docker/.env` sets the host path
  `FLUX_OIDC_CLIENT_SECRET_HOST_FILE`. `compose.source.yaml` mounts it into `api`
  only, at `/run/secrets/flux_oidc_client_secret`, and sets
  `FLUX_OIDC_CLIENT_SECRET_FILE` to that path.
- **Tokens.** It does not set `account.encryptOAuthTokens` (re-checked at
  `9aa90409`).
- **Tests.** The Keycloak in its tests is pinned to 26.7.5 by digest. The redirect
  URI is `<origin>/api/auth/callback/<providerId>`.

## 5. Better Auth 1.7.6

[C] Source at `v1.7.6` (`229a02a6`):

- **Defaults.** `packages/oauth-provider/src/oauth.ts`:
  - `codeExpiresIn: 600`;
  - `accessTokenExpiresIn: 3600`;
  - `refreshTokenExpiresIn: 2592000` (30 days).
- **Retry window.** `packages/mcp/src/plugin.ts`: `refreshTokenReuseInterval`
  defaults to 30 seconds "so a retried refresh can recover the response".
- **Sliding refresh.** In `packages/oauth-provider/src/token.ts`, each issuance sets
  `iat = Math.floor(Date.now() / 1000)` and the new refresh token's expiry to
  `params.iat + refreshTokenTtl`. A rotated refresh token therefore gets a new
  30-day expiry.
- **What refresh checks.** `handleRefreshTokenGrant` checks the client, expiry,
  resource, scope and revocation, and that the user exists. It does not require the
  original browser session.
- **Metadata.** `packages/oauth-provider/src/metadata.ts` advertises
  `code_challenge_methods_supported: ["S256"]` and
  `authorization_response_iss_parameter_supported: true`.
- **Device grant.** `packages/oauth-provider/src/device-code.ts` implements the RFC
  8628 grant as an extension. Flux does not enable it.
- **Session defaults.** `packages/better-auth/src/context/create-context.ts`:
  `expiresIn: options.session?.expiresIn || 60 * 60 * 24 * 7` (7 days).
- **Logout.** `generic-oauth` supports RP-initiated provider logout and `prompt`,
  `accessType` and `authorizationUrlParams`. Neither it nor the `sso` package
  contains an OIDC back-channel logout receiver; `sso` has SAML single logout.
- **SCIM.** A `scim` package exists.

Added 2026-10-06 [C], at `v1.7.6`:

- **Token encryption.** `account.encryptOAuthTokens` encrypts through
  `symmetricEncrypt` (`packages/better-auth/src/oauth2/utils.ts:26-36`), which uses
  XChaCha20-Poly1305 with the key `SHA-256(secret)`
  (`packages/better-auth/src/crypto/index.ts:40-45`). It covers the access and
  refresh tokens; the ID token is stored as is
  (`packages/better-auth/src/oauth2/link-account.ts:127-129`). The JSDoc comment
  (`packages/core/src/types/init-options.ts:1306-1316`) says tokens "are stored in
  plain text" by default and that encryption uses "AES-256-GCM"; the code
  contradicts the algorithm. The documentation [V] says only "Encrypt OAuth tokens
  before storing them in the database. Default: `false`."
  (`docs/content/docs/reference/options.mdx:496`). Corrected 2026-10-06: F-024
  first cited the JSDoc as documentation and repeated its algorithm.
- **Storing tokens.** There is no option to skip storing provider tokens.
  `updateAccountOnSignIn` (`init-options.ts:1193-1199`) only stops updates to an
  existing account; new accounts always get the tokens
  (`link-account.ts:532-558`).
- **Loopback redirects.** `packages/oauth-provider/src/authorize.ts:257-262`
  treats `http` with a loopback IP or `localhost` as loopback; "only the port may
  vary; every other character must match" (`:299-301`). Registration allows plain
  `http` "only on the exact loopback hosts localhost, 127.0.0.1, or [::1]"
  (`register.ts:197-222`).
- **Social sign-in during authorization.** `packages/oauth-provider/src/oauth.ts:641-654`
  stores the OAuth query in the server-side OAuth state when the path is
  `/sign-in/social`, and resumes from it after sign-in (`:676-681`). Generic OAuth
  providers use the same `signIn.social` and `callback/:id`. No test in the
  package exercises this branch.
- **Password reset.** `resetPassword` creates a `credential` account with the new
  password when the user has none (`packages/better-auth/src/api/routes/password.ts:305-316`).

## 6. Keycloak 26.8.0

- **Version.** [V] The latest release is 26.8.0, published 2026-10-01 (GitHub releases).
- **Refusing disabled users.** [C] At tag `26.8.0`, the refresh grant
  (`DefaultRefreshTokenProvider` → `TokenManager.validateToken`) throws
  `INVALID_GRANT, "User disabled"` when `!user.isEnabled()`. A removed offline
  session gives "Offline user session not found".
- **Defaults.** [C] `Constants.java`:
  - `DEFAULT_ACCESS_TOKEN_LIFESPAN = 300`;
  - `DEFAULT_SESSION_IDLE_TIMEOUT = 1800`;
  - `DEFAULT_SESSION_MAX_LIFESPAN = 36000`;
  - `DEFAULT_OFFLINE_SESSION_IDLE_TIMEOUT = 2592000`.
- **Back-channel logout settings** ([server admin guide](https://www.keycloak.org/docs/latest/server_admin/index.html)) [V]:
  - "Backchannel logout revoke offline sessions": "Keycloak will revoke offline
    sessions when receiving a Logout Token with this event."
  - Offline tokens: "an offline token never expires and is not subject to the SSO
    Session Idle timeout and SSO Session Max lifespan. The offline token is valid
    after a user logout."
  - "Clicking Sign out all active sessions does not revoke outstanding access
    tokens."
- **What that setting does** [C] (corrected 2026-10-06; F-024 first read the
  quote above as Keycloak ending the Flux client's offline sessions):
  - when **sending** a logout token to a client with the setting on, Keycloak only
    adds `"revoke_offline_access": true` to the token's `events` object, next to the
    back-channel logout event (`services/src/main/java/org/keycloak/jose/jws/DefaultTokenManager.java:361-370`);
  - "when receiving" applies when Keycloak itself receives a logout token as a
    broker: it then revokes offline sessions brokered from the sender
    (`services/src/main/java/org/keycloak/protocol/oidc/endpoints/LogoutEndpoint.java:613-623`, `:693-706`);
  - a normal user logout removes the user session but not a client's offline
    session (`services/src/main/java/org/keycloak/services/managers/AuthenticationManager.java:357-371`).
  - [I] So the Flux client's offline session survives a logout, and only Flux can
    act on the flag.
- **Disabling a user** [V], from the 26.7.0 release notes: "When a user logs out,
  changes credentials, or gets disabled in Keycloak, downstream applications
  typically don't learn about it until the next token refresh".
- **Refresh-token reuse** [C] (added 2026-10-06): a new realm's
  `revokeRefreshToken` ("Revoke Refresh Token") is `false`
  (`model/jpa/src/main/java/org/keycloak/models/jpa/entities/RealmEntity.java:107-110`;
  import default in `DefaultExportImportManager.java:249-253`). Only when it is on
  does a reused refresh token get `invalid_grant` "Stale token" or "Maximum allowed
  refresh token reuse exceeded" (`TokenManager.java:323-355`,
  `AbstractRefreshTokenProvider.java:284-290`).
- **`offline_access` in default roles** [C] (added 2026-10-06): `createRealm` sets up
  `default-roles-<realm>` and then `setupOfflineTokens`, which adds the
  `offline_access` role to the default roles (`RealmManager.java:139-150`,
  `KeycloakModelUtils.java:730-737`).
- **Offline session maximum** [C] (added 2026-10-06): "Offline Session Max Limited"
  defaults to off (`RealmAdapter.java:616-618`); its default maximum is 5,184,000
  seconds, 60 days (`Constants.java:64-67`). A refresh past it gets `invalid_grant`
  "Offline session not active" (`TokenManager.java:190-197`).
- **The person can remove access** [V][C] (added 2026-10-06): "Users can view and
  revoke offline tokens that Keycloak grants them in the … User Account Console"
  (`docs/documentation/server_admin/topics/sessions/offline.adoc:19`). "Remove
  access" calls `revokeOfflineToken` (`AccountRestService.java:374-389`).
- **Open issues.** Issue
  [#37981](https://github.com/keycloak/keycloak/issues/37981), "Disabling a User
  Does Not Remove Sessions, and User Deletion Does Not Trigger Logout Requests", is
  open. So is [#10228](https://github.com/keycloak/keycloak/issues/10228).
- **Keycloak as an MCP authorization server**
  ([guide](https://www.keycloak.org/securing-apps/mcp-authz-server)) [V]:
  - RFC 8707 resource indicators and CIMD are "Experimental";
  - MCP 2026-07-28 support is "Experimental";
  - "If the feature is disabled, Keycloak does not recognize the resource parameter."
  - Added 2026-10-06, from the guide's source at `26.8.0`
    (`docs/guides/securing-apps/mcp-authz-server.adoc:129`): "In this case, you can
    use OAuth 2.0's `scope` parameter instead of the `resource` parameter." Without
    the feature, the guide adds an Optional client scope with an `Audience` mapper
    whose "Included Custom Audience" is the MCP server (`:140-149`). Dynamic Client
    Registration is listed as "Supported" and MCP 2025-03-26 as "Supported".
  - [I] So Keycloak can be the authorization server for an MCP resource without
    experimental features, through pre-registered or policy-allowed clients and an
    audience mapper. Corrected 2026-10-06: F-024 first said B depended on
    experimental features.
- **Dynamic client registration** [V]: "By default, there is not any whitelisted
  host, so anonymous client registration is de-facto disabled."
- **Shared Signals** [V], from the 26.8.0 release notes: the experimental Shared
  Signals Framework "now emits RISC account-disabled and account-enabled event
  types".
- **SCIM** [V], from the 26.8.0 release notes: "the SCIM API is promoted from preview
  to supported". It is an inbound API for Keycloak's own users.

## 7. Microsoft Entra ID

- **Claims**
  ([ID token claims](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference),
  page date 2023-05-30, updated 2026-06-15) [V]:
  - `email`: "This value isn't guaranteed to be correct and is mutable over time.
    Never use it for authorization or to save data for a user."
  - `sub`: "The subject is a pairwise identifier and is unique to an application ID."
  - `oid`: "The immutable identifier for an object".
  - The page lists no `email_verified` claim.
- **Optional claims**
  ([reference](https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims-reference),
  page date 2026-07-22) [V]:
  - `xms_edov`: "Boolean value indicating whether the user's email domain owner has
    been verified."
  - `auth_time` is optional: "Time when the user last authenticated."
  - The page lists no `email_verified`.
  - [I] #240's `email_verified === true` rule would refuse every Entra sign-in.
    Hence the `entra` profile in F-024. It is not tested against Entra.
- **Discovery** [V]:
  - `"issuer": "https://login.microsoftonline.com/{tenantid}/v2.0"`;
  - `frontchannel_logout_supported: true`;
  - no `backchannel_logout_supported` key.
- **Registration** [V] (Microsoft 365 Copilot docs): "Microsoft Entra ID doesn't
  publish an RFC 7591 registration endpoint".
- **Refresh tokens** [V] ([refresh tokens](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens)):
  - "90 days for all other scenarios";
  - "Refresh tokens replace themselves with a fresh token upon every use."
- **Revoking access** [V]: after clearing "Account enabled" and "Revoke sessions",
  "the user can't gain new tokens for any application tied to Microsoft Entra ID".
- **Continuous access evaluation** [V] lists "User Account is deleted or disabled"
  among its critical events. [I] It serves Microsoft resource APIs and pushes
  nothing to Flux.
- **Re-authentication** [V]: "The prompt=login claim forces the user to enter their
  credentials on that request". Added 2026-10-06: neither the authorization-code
  flow page nor the OpenID Connect page documents `max_age`.

## 8. Google

[Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect),
last updated 2026-06-15 [V]:

- **Issuer:** "Verify that the value of the iss claim in the ID token is equal to
  https://accounts.google.com or accounts.google.com."
- **`sub`:** "never reused … the sub value is never changed."
- **`hd`:** "You must check this claim when restricting access to a resource to
  only members of certain domains."
- **`prompt`:** the documented values are `none`, `consent` and `select_account`.
- **`max_age`** (added 2026-10-06): not documented on the page. `auth_time` is
  "Provided when the auth_time claim is included in the authentication request and
  enabled in settings".
- **Discovery:** no `end_session_endpoint`, no `backchannel_logout_supported` and
  no `registration_endpoint`.
- **Refresh tokens** ([web server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)) [V] [fetched]:
  - `offline` is for an application that "needs to refresh access tokens when the
    user is not present at the browser";
  - "the refresh token is only returned if your application set the `access_type`
    parameter to `offline` in the initial request";
  - for a new one, "you must use the `prompt=consent` parameter".

## 9. OIDC Back-Channel Logout 1.0

[Specification](https://openid.net/specs/openid-connect-backchannel-1_0.html) [S]:

- **Status.** "Final: OpenID Connect Back-Channel Logout 1.0 incorporating errata
  set 1", December 15, 2023.
- **The token.** "A Logout Token MUST contain either a sub or a sid Claim, and MAY
  contain both." "A nonce Claim MUST NOT be present."
- **Validation.** "Validate the iss, aud, iat, and exp Claims in the same way they
  are validated in ID Tokens."
- **Refresh tokens.** "Refresh tokens issued without the offline_access property to
  a session being logged out SHOULD be revoked. Refresh tokens issued with the
  offline_access property normally SHOULD NOT be revoked."
- **Downstream logout.** "In the case that the RP is also an OP serving as an
  identity provider to downstream logged-in sessions, it is desirable for the logout
  request to the RP to likewise trigger downstream logout requests."
- **Response.** "If the logout succeeded, the RP MUST respond with HTTP 200 OK."
  "If the logout request was invalid or the logout failed, the RP MUST respond with
  HTTP 400 Bad Request." Added 2026-10-06: "The RP's response SHOULD include the
  Cache-Control HTTP response header field with a no-store value" (§2.8).
- **The `events` value** (added 2026-10-06, §2.4): "The corresponding member value
  MUST be a JSON object and SHOULD be the empty JSON object {}." The specification
  says nothing about other members inside `events`, such as Keycloak's
  `revoke_offline_access`.

## 10. Other providers

- **Authentik** (docs 2026.8) [V]: back-channel logout fires when "A user account is
  deactivated".
- **Zitadel** (v4.19) [V]:
  - it advertises `backchannel_logout_supported`;
  - a notification is "sent once the session is terminated by a user sign out".
  - [C] Added 2026-10-06, at `v4.19.4`: the handler reacts only to
    `session.terminated` and `user.human.signed.out`
    (`internal/notification/handlers/back_channel_logout.go:48-68`). Deactivating,
    locking or removing a user (`internal/command/user.go`) emits neither. So
    deactivation sends no logout token.
- **Okta** [V] [fetched]:
  - single logout "Requests are communicated from Okta to apps using front-channel
    logout";
  - Universal Logout requires "the Global Token Revocation specification".
  - [O] Added 2026-10-06: the discovery documents of `login.okta.com`,
    `okta.okta.com` and `okta.okta.com/oauth2/default` have no
    `backchannel_logout_supported` key.
- **GitLab** [V]: "The claims email and email_verified are included only if the
  application has access to the email scope and the user's public email address."
  Its discovery has no logout keys.

## Inferences for Flux

- [I] **Flux should remain the only authorization server for `/mcp`.** Making the
  IdP the authorization server would lose Flux's per-connection token binding and
  consent, and built-in accounts would still need Flux's own. It also needs per-IdP
  setup: Keycloak can do it with pre-registered clients and an audience mapper,
  while CIMD and resource indicators are experimental there, Entra has no
  registration endpoint, and Google and GitLab offer no way to be a resource
  issuer for Flux. (Reworded 2026-10-06.)
- [I] **Back-channel logout cannot be the offboarding mechanism.**
  - Among the providers checked, only Authentik documents it on deactivation.
  - Keycloak 26.8.0 and Zitadel v4.19.4 send nothing on disable or deactivation.
  - Entra, Google and Okta do not offer it.
- [I] **A server-side check with the provider's offline refresh token detects
  disabled users.** Keycloak refuses that refresh by code ("User disabled"), and
  Entra by documentation. It needs no provider-specific API. But a refused refresh
  also follows an offline-session maximum, the person removing access, or a lost
  single-use rotation, so it should suspend rather than revoke (added 2026-10-06).
- [I] **Better Auth's sliding refresh tokens keep an MCP grant alive indefinitely
  for an active client.** A bound tied to the provider's confirmation is therefore
  needed.
- [I] **Neither main client offers a device grant for MCP.** Claude Code's paste-back
  flow, Codex's callback options and a Flux-issued key cover headless use.

## Not verified

- **No real runs.** No Keycloak, Entra, Google, Okta, Authentik, Zitadel or GitLab
  sign-in was run for this note, and no MCP client.
- **Provider details not confirmed:**
  - whether Google, Okta and GitLab refuse an offline refresh for a suspended or
    blocked user;
  - whether Entra honours `max_age` (it documents only `prompt=login`).
- **Fetched pages.** Okta pages were read only through the fetch tool.
- **Closed on 2026-10-06** (sources in section 11): Google documents neither
  `max_age` nor `prompt=login`; Zitadel does not send back-channel logout on
  deactivation; Keycloak's "Revoke Refresh Token" defaults to off; a new Keycloak
  realm's default roles include `offline_access`.

## 11. Re-verification, 2026-10-06

Retrieved 2026-10-06 by `claude-hubert`, for the
[review of `f90c2350`](https://github.com/ColdPhase/flux/pull/274). Code was read at
the stated tags; documentation pages were downloaded and searched.

| Item | Label | Source | Result |
| --- | --- | --- | --- |
| Refresh-token rotation rule | [S] | [MCP security considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations), "Token Theft" | On this page, not the authorization page. Corrected in section 1 |
| Redirect host and localhost warnings | [S] | Same page, "Localhost Redirect URI Risks" | "**MUST** clearly display the redirect URI hostname"; "**SHOULD** display additional warnings for `localhost`-only redirect URIs" |
| Consent page rules | [S] | [Security best practices](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices), "Consent UI Requirements" | Show the registered `redirect_uri`; prevent framing |
| Enterprise-managed authorization status | [S] | [`ext-auth` `specification/stable/enterprise-managed-authorization.mdx`](https://github.com/modelcontextprotocol/ext-auth/blob/main/specification/stable/enterprise-managed-authorization.mdx) | "Status: Stable" only there. Corrected in section 1 |
| Client-credentials extension status | [S] | [`ext-auth` `specification/draft/oauth-client-credentials.mdx`](https://github.com/modelcontextprotocol/ext-auth/blob/main/specification/draft/oauth-client-credentials.mdx) | "Protocol Revision: draft". Corrected in section 1 |
| Client matrix | [V] | [MCP client matrix](https://modelcontextprotocol.io/extensions/client-matrix) | Neither Claude Code nor Codex supports enterprise-managed authorization |
| Loopback ports and `localhost` | [S] | [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252.txt) §7.3, §8.3 | Any port for loopback IP redirects; "the use of localhost is NOT RECOMMENDED" |
| `error_description` characters | [S] | [RFC 6750](https://www.rfc-editor.org/rfc/rfc6750.txt) §3 | "MUST NOT include characters outside the set %x20-21 / %x23-5B / %x5D-7E" |
| Back-channel response and `events` | [S] | [OIDC Back-Channel Logout 1.0](https://openid.net/specs/openid-connect-backchannel-1_0.html) §2.4, §2.8 | `Cache-Control: no-store` SHOULD; 400 on failure; the event value is a JSON object |
| Codex docs address and redirect | [V] | [learn.chatgpt.com/docs/extend/mcp](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) (308 from developers.openai.com/codex/mcp) | Same keys; redirect on `127.0.0.1` |
| Claude Code redirect | [V] | [code.claude.com/docs/en/mcp](https://code.claude.com/docs/en/mcp) | `http://localhost:PORT/callback`; newest version mentioned 2.1.285 |
| Cursor registration | [V] | [cursor.com/docs/mcp](https://cursor.com/docs/mcp) | Static client credentials; no CIMD mentioned |
| Keycloak back-channel `revoke_offline_access` | [C] | [`DefaultTokenManager.java` at 26.8.0](https://github.com/keycloak/keycloak/blob/26.8.0/services/src/main/java/org/keycloak/jose/jws/DefaultTokenManager.java#L361-L370), [`LogoutEndpoint.java`](https://github.com/keycloak/keycloak/blob/26.8.0/services/src/main/java/org/keycloak/protocol/oidc/endpoints/LogoutEndpoint.java#L613-L623), [`AuthenticationManager.java`](https://github.com/keycloak/keycloak/blob/26.8.0/services/src/main/java/org/keycloak/services/managers/AuthenticationManager.java#L357-L371) | Sending only adds the flag; offline sessions survive logout. Corrected in section 6 |
| Keycloak "Revoke Refresh Token" default | [C] | [`RealmEntity.java` at 26.8.0](https://github.com/keycloak/keycloak/blob/26.8.0/model/jpa/src/main/java/org/keycloak/models/jpa/entities/RealmEntity.java#L107-L110) | Off |
| Keycloak `offline_access` default role | [C] | [`RealmManager.java` at 26.8.0](https://github.com/keycloak/keycloak/blob/26.8.0/services/src/main/java/org/keycloak/services/managers/RealmManager.java#L139-L150), [`KeycloakModelUtils.java`](https://github.com/keycloak/keycloak/blob/26.8.0/server-spi-private/src/main/java/org/keycloak/models/utils/KeycloakModelUtils.java#L730-L737) | In the default roles |
| Keycloak offline maximum and "Remove access" | [C] | [`TokenManager.java` at 26.8.0](https://github.com/keycloak/keycloak/blob/26.8.0/services/src/main/java/org/keycloak/protocol/oidc/TokenManager.java#L190-L227), [`AccountRestService.java`](https://github.com/keycloak/keycloak/blob/26.8.0/services/src/main/java/org/keycloak/services/resources/account/AccountRestService.java#L374-L389) | Both end in `invalid_grant` for Flux's offline token |
| Keycloak as MCP authorization server without experimental features | [V] | [`mcp-authz-server.adoc` at 26.8.0](https://github.com/keycloak/keycloak/blob/26.8.0/docs/guides/securing-apps/mcp-authz-server.adoc#L129) | Scope plus audience mapper instead of `resource`. Corrected in section 6 |
| Better Auth token encryption | [C] | [`crypto/index.ts` at v1.7.6](https://github.com/better-auth/better-auth/blob/v1.7.6/packages/better-auth/src/crypto/index.ts#L40-L45), [`oauth2/utils.ts`](https://github.com/better-auth/better-auth/blob/v1.7.6/packages/better-auth/src/oauth2/utils.ts#L26-L36), [`link-account.ts`](https://github.com/better-auth/better-auth/blob/v1.7.6/packages/better-auth/src/oauth2/link-account.ts#L127-L129) | XChaCha20-Poly1305, key SHA-256(secret); ID token not encrypted. Corrected in section 5 |
| Better Auth redirects, `oauth_query`, reset, sliding refresh | [C] | [`authorize.ts`](https://github.com/better-auth/better-auth/blob/v1.7.6/packages/oauth-provider/src/authorize.ts#L257-L262), [`oauth.ts`](https://github.com/better-auth/better-auth/blob/v1.7.6/packages/oauth-provider/src/oauth.ts#L641-L654), [`password.ts`](https://github.com/better-auth/better-auth/blob/v1.7.6/packages/better-auth/src/api/routes/password.ts#L305-L316), [`token.ts`](https://github.com/better-auth/better-auth/blob/v1.7.6/packages/oauth-provider/src/token.ts#L746-L759) | As stated in section 5 |
| Zitadel back-channel triggers | [C] | [`back_channel_logout.go` at v4.19.4](https://github.com/zitadel/zitadel/blob/v4.19.4/internal/notification/handlers/back_channel_logout.go#L48-L68) | Session terminated or user signed out only |
| Okta discovery | [O] | `https://login.okta.com/.well-known/openid-configuration`, `https://okta.okta.com/.well-known/openid-configuration` | No `backchannel_logout_supported` |
| Google `max_age` | [V] | [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect), last updated 2026-06-15 | Not documented |
| Entra `max_age` | [V] | [Authorization code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow), [OpenID Connect](https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc) | Not documented |
| #240 at `9aa90409` | [C] | [PR #240](https://github.com/ColdPhase/flux/pull/240) | `pages.tsx:143` guard; error return `/sign-in?sso=failed`; secret mounted on `api` only; operator guide has the MCP workaround and the Entra caveat |
| #294 | [C] | [PR #294](https://github.com/ColdPhase/flux/pull/294) | Registration locked to CIMD and pre-registration; consent shows redirect and `client_id` hosts; framing refused |
