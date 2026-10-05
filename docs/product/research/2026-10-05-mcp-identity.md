# Research: MCP sign-in with external identity providers (2026-10-05)

Evidence for [F-024](../mcp-identity.md), issue
[#273](https://github.com/ColdPhase/flux/issues/273). Retrieved 2026-10-05 by
`claude-hubert`.

**Question.** How should MCP clients (Claude Code, Codex, Cursor and other MCP
clients) authenticate to a self-hosted Flux whose people sign in through an
external OpenID Connect provider? How does access end when the provider disables
a person?

**Method.**

- **MCP specification, RFCs and client docs.** Downloaded as Markdown or text with
  `curl` and searched. Some pages were read through a fetch tool that converts the
  page; those are marked [fetched].
- **Flux code.** Read at `main` `698313b3` and at #240's head `8929beb6`.
- **Better Auth 1.7.6 and Keycloak 26.8.0 source.** Read through the GitHub API at
  their release tags.
- **Not done:** no Docker stack was started, and no IdP or MCP client was run for
  this note.

**Labels.**

- **[S]** specification or RFC text;
- **[V]** vendor documentation, which is a claim about the product;
- **[C]** code read at a pinned revision;
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
- Refresh tokens: "For public clients, authorization servers **MUST** rotate refresh
  tokens".
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
- [I] Flux uses one static client at the IdP for every MCP client. That is the
  proxy shape this guidance describes, so Flux keeps its own per-client consent
  before and after the IdP step.

**Enterprise-managed authorization.** The extension is
`io.modelcontextprotocol/enterprise-managed-authorization`
([extension](https://modelcontextprotocol.io/extensions/auth/enterprise-managed-authorization)).

- [S] "**Status**: Stable".
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
- The client-credentials extension is listed as Draft.

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
- [V] The device grant request
  [anthropics/claude-code#20215](https://github.com/anthropics/claude-code/issues/20215)
  was closed as a duplicate on 2026-01-26, and the docs do not mention a device
  grant.

**Codex** ([MCP docs](https://developers.openai.com/codex/mcp)). The latest release
is 0.160.1 (2026-10-05).

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

**Cursor** ([MCP docs](https://cursor.com/docs/mcp), undated) [V]:

- "Cursor supports OAuth for servers that require it."
- Static client credentials can replace dynamic registration.
- Headers support `${env:…}`.

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
  authorization page.
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
- **Disabling a user** [V], from the 26.7.0 release notes: "When a user logs out,
  changes credentials, or gets disabled in Keycloak, downstream applications
  typically don't learn about it until the next token refresh".
- **Open issues.** Issue
  [#37981](https://github.com/keycloak/keycloak/issues/37981), "Disabling a User
  Does Not Remove Sessions, and User Deletion Does Not Trigger Logout Requests", is
  open. So is [#10228](https://github.com/keycloak/keycloak/issues/10228).
- **Keycloak as an MCP authorization server**
  ([guide](https://www.keycloak.org/securing-apps/mcp-authz-server)) [V]:
  - RFC 8707 resource indicators and CIMD are "Experimental";
  - MCP 2026-07-28 support is "Experimental";
  - "If the feature is disabled, Keycloak does not recognize the resource parameter."
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
  credentials on that request". Entra support for `max_age` is unverified.

## 8. Google

[Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect),
last updated 2026-06-15 [V]:

- **Issuer:** "Verify that the value of the iss claim in the ID token is equal to
  https://accounts.google.com or accounts.google.com."
- **`sub`:** "never reused … the sub value is never changed."
- **`hd`:** "You must check this claim when restricting access to a resource to
  only members of certain domains."
- **`prompt`:** the documented values are `none`, `consent` and `select_account`.
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

## 10. Other providers

- **Authentik** (docs 2026.8) [V]: back-channel logout fires when "A user account is
  deactivated".
- **Zitadel** (v4.19) [V]:
  - it advertises `backchannel_logout_supported`;
  - a notification is "sent once the session is terminated by a user sign out";
  - its behaviour on deactivation is unverified.
- **Okta** [V] [fetched]:
  - single logout "Requests are communicated from Okta to apps using front-channel
    logout";
  - Universal Logout requires "the Global Token Revocation specification".
- **GitLab** [V]: "The claims email and email_verified are included only if the
  application has access to the email scope and the user's public email address."
  Its discovery has no logout keys.

## Inferences for Flux

- [I] **Flux should remain the only authorization server for `/mcp`.** Making the
  IdP the authorization server would depend on experimental (Keycloak) or missing
  (Entra registration; Google and GitLab as resource issuers) features. It would
  also lose Flux's per-connection token binding.
- [I] **Back-channel logout cannot be the offboarding mechanism.**
  - Among the providers checked, only Authentik documents it on deactivation.
  - Keycloak 26.8.0 sends nothing on disable.
  - Entra, Google and Okta do not offer it.
- [I] **A server-side check with the provider's offline refresh token detects
  disabled users.** Keycloak refuses that refresh by code ("User disabled"), and
  Entra by documentation. It needs no provider-specific API.
- [I] **Better Auth's sliding refresh tokens keep an MCP grant alive indefinitely
  for an active client.** A bound tied to the provider's confirmation is therefore
  needed.
- [I] **Neither main client offers a device grant for MCP.** Claude Code's paste-back
  flow, Codex's callback options and a Flux-issued key cover headless use.

## Not verified

- **No real runs.** No Keycloak, Entra, Google, Okta, Authentik, Zitadel or GitLab
  sign-in was run for this note, and no MCP client.
- **Provider details not confirmed:**
  - Entra `max_age` support;
  - Google `max_age` and `prompt=login`;
  - whether Google, Okta and GitLab refuse an offline refresh for a suspended or
    blocked user;
  - Zitadel's behaviour on deactivation;
  - Keycloak's default for "Revoke Refresh Token".
- **Fetched pages.** Okta pages were read only through the fetch tool.
- **Default roles.** That Keycloak's default realm roles include `offline_access` is
  not confirmed from documentation here.
