# Single sign-on

**Implemented #240 baseline:** the setup and verified behavior below describe
the current mixed-login implementation. The [required exclusive-mode target](#target-mode)
and [bounded F-024 contract](../product/mcp-identity.md#exclusive-ordinary-sign-in-modes)
supersede that ordinary login model; SSO-only mode and safe pre-cutover migration
remain unimplemented.

Flux can let people sign in with your organisation's OpenID Connect identity provider (Keycloak,
Google Workspace, Okta, Authentik and others), next to email and password
([#113](https://github.com/ColdPhase/flux/issues/113)). Flux supports **one** provider per
instance. Email/password sign-in keeps working, so the first owner and anyone outside the
provider can still sign in.

## What it does and does not do

- **Who the person is** comes from the provider's verified ID token: the issuer and the stable
  subject (`sub`). The same subject is always the same Flux person, even when the provider changes
  their email or name; Flux updates both on the next sign-in.
- **The account email** is taken only when the provider says it is verified (`email_verified`).
  A sign-in without a verified email is refused.
- **No account takeover by email.** A provider identity is never linked to an existing Flux account
  just because the emails match. If someone already has a Flux account with that email, the
  single sign-on attempt is refused and their account is unchanged.
- **No access from the provider.** Groups, roles and domains in the token are ignored. People join
  workspaces and projects in Flux, through invitations and project access, exactly as with
  password accounts.
- **Notification email** goes to the account email, a separately verified private address, both,
  or nowhere, as each person chooses ([notifications](../development/notifications.md#email)).
  When the two are the same mailbox, the person gets one message.

## Set it up

1. **Register Flux with your provider** as a confidential web application using the
   authorization-code flow with PKCE and the scopes `openid email profile`. The redirect URI is
   `https://<your Flux origin>/api/auth/callback/<provider id>`. Flux prints the exact
   value when the API starts with single sign-on on (`Single sign-on is on`, field `redirectUri`):

   ```sh
   ./flux logs api | grep 'Single sign-on is on'
   ```

   The provider id is derived from the issuer URL, so changing the issuer creates a new identity
   namespace (people would sign in as new accounts); keep the issuer stable.

2. **Save the client secret in a file** readable only by you, for example
   `/etc/flux/oidc_client_secret`.

3. **Add to `docker/.env`** (or the release's `.env`):

   ```sh
   FLUX_OIDC_ISSUER=https://id.example.org/realms/acme
   FLUX_OIDC_CLIENT_ID=flux
   FLUX_OIDC_CLIENT_SECRET_HOST_FILE=/etc/flux/oidc_client_secret
   FLUX_OIDC_LABEL=Acme login
   ```

   The issuer must be `https` and must be the provider's exact issuer (its
   `/.well-known/openid-configuration` is read from there). Set issuer and client id together; with
   neither, single sign-on stays off. `FLUX_OIDC_LABEL` names the button ("Sign in with Acme
   login"); it defaults to "single sign-on".

   With the release Compose file, also mount the secret into the API container with a
   `compose.override.yaml`:

   ```yaml
   services:
     api:
       volumes:
         - /etc/flux/oidc_client_secret:/run/secrets/flux_oidc_client_secret:ro,z
   ```

   `z` lets the container read the file on an SELinux host (Fedora, RHEL); elsewhere it has no effect.

4. **Optional: confirmation age.** `FLUX_OIDC_CONFIRMATION_MAX_AGE` (default `7d`; whole hours or
   days from `1h` to `30d`, such as `12h`) is how long the provider's last confirmation of a person
   keeps their access. It starts at each sign-in through the provider. After it, that person's
   provider browser sessions return to sign-in, their MCP requests get 401 `invalid_token`, and the
   refresh grant gets `invalid_grant` until they sign in through the provider again; the client then
   authorizes again and `/connect-agent` offers the connection it held. Without the standing check
   (S4), this age is the offboarding bound: a person disabled at the provider keeps access at most
   this long. People with only a Flux password are not affected.

5. **Restart:** `./flux up` (or `docker compose … up -d`). The sign-in page shows
   "Sign in with Acme login" once the API reads the provider's discovery document.

The API reads discovery when it starts. If the provider is unreachable then, single sign-on fails
until the next restart; password sign-in is unaffected.

## Standing check

Flux asks the provider for `offline_access` at sign-in and keeps the refresh token it returns,
sealed with a key derived from `FLUX_AUTH_SECRET`, in `auth_idp_standing`. Every
`FLUX_OIDC_STANDING_INTERVAL_SECONDS` (default 900) the API uses that token for each person with a
live session or agent connection. If the provider answers `invalid_grant` (a disabled user, a removed
offline session), the person is in *sign-in required*: their browser sessions end, MCP requests answer
`401 invalid_token` with "Sign in again with <label>", the refresh grant answers `invalid_grant`, and
automation that acts for them stops. Nothing is revoked. A network error, timeout, 5xx or
`invalid_client` changes nothing.

- **Restoring access.** Checks continue for a suspended person. When the provider honours the token
  again (a re-enabled Keycloak user), the next check clears the state; their kept agent grants work
  again, and they sign in again in the browser.
- **The provider must return a refresh token.** Grant the Flux client the `refresh_token` grant and
  let the people use `offline_access` (Keycloak: the `offline_access` role; Okta: the Refresh Token
  grant). A sign-in that returns none is refused with a message, and the API logs
  `The identity provider returned no refresh token`. For a provider that cannot, set
  `FLUX_OIDC_STANDING=off`: then only the confirmation age (S2) and back-channel logout end access.
- **Backups and restores.** `./flux backup` keeps the table's rows out of the archive. After a
  restore, every person who signed in through the provider is in sign-in required until they sign in
  again.
- **Only the stored state is read per request;** an unreachable provider adds no latency to MCP calls.

## Verified behavior

`./scripts/check_oidc.sh` runs a pinned, disposable Keycloak in Docker as the provider and drives
the real browser flow against Flux: sign-in, the same subject keeping the person, grants and
verified address across an email change, refused unverified and colliding identities, a replayed
or forged callback, a session across an API restart, revoking and signing out a single sign-on
session, mail to exactly the chosen mailboxes (account only, private address only, both, in-app
only) for two people whose private addresses stay their own, email links that open only while
the reader may see the source, and one message per actual mailbox through Mailpit.

Keycloak never issues a bad ID token, so the same script also starts a small deterministic mock
provider (`app/tests/app/support/oidc-mock.ts`, from the test image) and a second API replica
configured with it. Through the same browser flow and callback it returns ID tokens with a wrong
nonce, a signature by another key, another issuer or another audience; each is refused with no
session, no linked or changed account, no grants and no notification address, and a valid
token from the same mock still signs in.

The confirmation age runs against Keycloak with `FLUX_OIDC_CONFIRMATION_MAX_AGE=12h`: a person
whose last confirmation is moved back past it is refused at the browser, at MCP and on the refresh
grant; one moved back less than it is not; signing in again through Keycloak restores access.

It uses its own Compose project and ports (`FLUX_OIDC_TEST_PORT`, default 18095, and the next port
for Mailpit) and removes everything afterwards.

<a id="target-mode"></a>
**Target mode, superseding amendment 2026-10-07:**
[F-024](../product/mcp-identity.md) requires password-only ordinary login without
active SSO or SSO-only with the installation's sole IdP. Under active SSO, no
ordinary Flux password sign-in/signup/reset or password-only authority remains;
new accounts come through the verified IdP flow. This needs real backend/UI/
session enforcement; the current #240 baseline has not delivered that mode.

Existing accounts migrate explicitly before cutover: prepared provider,
authenticated existing account/session and a verified callback bound to that
account and intent, preserving Flux IDs/data/roles/memberships/applicable grants.
Duplicate identity, substitution and email auto-linking are refused. Audited host
recovery/re-key handles stranded accounts; it does not add an ordinary password
fallback under SSO. Selected-provider claims/offboarding/verification remain.
#316's ordinary per-connection capability controls have no ten-minute guard,
password replay or secondary SSO challenge; live rights/grants/OAuth ceilings
still apply. Neither these switches nor exclusive mode are claimed implemented.
#317 opaque MCP keys remain canceled; supported OAuth/SSH/callback paths stay.

Not covered: SAML, SCIM provisioning, several providers at once, and a production provider's
own policies (MFA, conditional access), which stay the provider's responsibility.

- **Microsoft Entra ID (unverified, 2026-10-06).** Flux accepts an identity only when the ID token says
  `email_verified: true`. Entra's ID token and optional-claims references and its `claims_supported`
  list don't include `email_verified`, so Entra sign-in is expected to be refused until a provider
  claim adapter for it exists (F-024 S5b, [#315](https://github.com/ColdPhase/flux/issues/315)). These
  profiles describe provider compatibility, not personal profile pages. This is an
  inference from Microsoft's documentation; it was not tested against a real Entra tenant.
- **Agent (MCP) authorization ([#310](https://github.com/ColdPhase/flux/issues/310), F-024 S1).** The
  page an agent client opens for authorization (`/login`, for example from `claude mcp login`) shows
  **Sign in with <label>** above the password form. Flux keeps the signed authorization request through
  the provider round trip and continues to the connection choice and consent afterwards; the client only
  ever receives Flux's own code and tokens, and an access or ID token issued by the provider is refused at
  `/mcp`. If the provider step is cancelled or fails, the page returns to `/login` with the same request
  and a message. If the provider's discovery document cannot be read, the button is disabled and says
  `<label> is not reachable right now`. A Flux that starts while the provider is down waits with backoff
  for about 12 seconds; if the provider is still down then, restart Flux once it is back.
  Pre-registered Codex clients: register the callback that Codex displays. It is the stable
  `http://127.0.0.1/callback` when the server advertises the issuer response parameter, as Flux does.
  Tested in `scripts/check_oidc.sh` against Keycloak with a scripted client; runs of the real Claude Code
  and Codex clients are not part of this change.
