# Single sign-on

Flux can let people sign in with your organisation's OpenID Connect identity provider (Keycloak,
Google Workspace, Okta, Authentik and others). Flux supports **one** provider per instance. Its mode
is set by `FLUX_SSO_MODE`:

- `prepare` keeps email/password sign-in, sign-up and reset, and lets each existing password account
  **link** the provider before cutover (see [Moving existing accounts](#moving-existing-accounts)).
- `sso` (the default with a provider) is the cutover: email/password sign-in, sign-up and reset are refused
  by the API and hidden in the browser, and a password-only session no longer continues. Only the provider
  signs people in. To return to password mode, unset the `FLUX_OIDC_*` variables and restart.

## What it does and does not do

- **Who the person is** comes from the provider's verified ID token: the issuer and the stable
  subject (`sub`). The same subject is always the same Flux person, even when the provider changes
  their email or name; Flux updates both on the next sign-in.
- **The account email** is taken only when the provider says it is verified (`email_verified`).
  A sign-in without a verified email is refused.
- **No account takeover by email.** A provider identity is never linked to an existing Flux account
  just because the emails match. If the provider's verified email belongs to a verified Flux account,
  or to an account already linked to a provider identity, the sign-in is refused and nothing changes.
  If it belongs to an unverified account with no provider link, `prepare` offers **link first**:
  sign in to that account and link the provider in Settings → Account, keeping its existing data.
  After SSO cutover the page points to audited operator recovery instead of password sign-in.
  Both phases offer **claim the address**. Claiming releases
  the address from that account (it becomes `unverified-<id>@invalid`, its sessions and agent connections
  end, and an audit row names both accounts). The account's data stays with it and does not move to the
  new account. The claim page is open for 15 minutes after the provider sign-in.
- **Email verification of password accounts.** Accounts made before single sign-on are unverified. Once
  email is set (`FLUX_SMTP_URL`), they receive a verification mail the next time they sign in with their
  password in password or `prepare` mode, and admins can find an account by email only when its address is verified. Setting
  `FLUX_SIGNUP=verified` makes new password accounts verify by mail before they can sign in; without
  email it behaves as `off`.
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
   docker compose --env-file docker/.env -p "$(sed -n 's/^FLUX_PROJECT=//p' docker/.env)" \
     -f docker/compose.source.yaml logs --no-log-prefix api | grep 'Single sign-on is on'
   ```

   (Release: `docker compose --env-file .env -f compose.yaml logs --no-log-prefix api | grep …`.)

   The provider id is derived from the issuer URL, so changing the issuer creates a new identity
   namespace. Keep the issuer stable during normal operation; if it must change, use the explicit
   `--old-issuer` operator recovery procedure below before people sign in at the new issuer.

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
   authorizes again and `/connect-agent` offers the connection it held. Without the
   [standing check](#standing-check), this age is the offboarding bound: a person disabled at the provider keeps access at most
   this long. People with only a Flux password cannot sign in while the provider is set (see above).

5. **Restart:** `./flux up` (or `docker compose … up -d`). The sign-in page shows
   "Sign in with Acme login" once the API reads the provider's discovery document.

The API reads discovery when it starts. If the provider is unreachable then, single sign-on fails
until the next restart; password sign-in stays closed in the meantime.

## Standing check

Flux asks the provider for `offline_access` at sign-in and keeps the refresh token it returns,
sealed with a key derived from `FLUX_AUTH_SECRET`, in `auth_idp_standing`.

The sign-in takes two steps. The person signs
in with `openid email profile`. Flux then sends the browser back to the provider once more, silently,
with `prompt=none` and `scope=openid offline_access`, to the same redirect URI. You register nothing
new. The person sees only a second redirect.

The reason is Keycloak 26.1 and later: when `offline_access` is the first request of a new Keycloak
session, Keycloak deletes the browser session at the code exchange . The provider
then never sends a back-channel logout to Flux, and other applications lose single sign-on.

- **A refused silent step.** If the step answers `login_required` or another error, the sign-in is
  refused like a missing refresh token, and the API logs the provider's answer. A provider session that
  `prompt=none` cannot reuse causes this, for example when the provider's own cookies are blocked.
- **When Flux revokes a stored token.** Flux revokes the token it replaces only when no live Flux
  browser session came from that token's provider session (`sid`). Revoking a Keycloak offline token
  also takes Flux out of that browser session's logout.
- **Tokens Flux does not revoke** end at the provider's offline idle limit (Keycloak: 30 days). Until then,
  Keycloak lists them as offline sessions of the Flux client. Every
`FLUX_OIDC_STANDING_INTERVAL_SECONDS` (default 900) the API uses that token for each person with a
live session or agent connection. If the provider answers `invalid_grant` (a disabled user, a removed
offline session), the person is in *sign-in required*: their browser sessions end, MCP requests answer
`401 invalid_token` with "Sign in again with" and your label, the refresh grant answers `invalid_grant`, and
automation that acts for them stops. Nothing is revoked. A network error, timeout, 5xx or
`invalid_client` changes nothing.

- **Restoring access.** Checks continue for a suspended person. When the provider honours the token
  again (a re-enabled Keycloak user), the next check clears the state; their kept agent grants work
  again, and they sign in again in the browser.
- **The provider must return a refresh token.** Grant the Flux client the `refresh_token` grant and
  let the people use `offline_access` (Keycloak: the `offline_access` role; Okta: the Refresh Token
  grant). A sign-in that returns none is refused with a message, and the API logs
  `The identity provider returned no refresh token`. For a provider that cannot, set
  `FLUX_OIDC_STANDING=off`: then only the confirmation age and back-channel logout end access.
- **Backups and restores.** `./flux backup` keeps the table's rows out of the archive. After a
  restore, every person who signed in through the provider is in sign-in required until they sign in
  again.
- **Back-channel logout.** In the provider's client settings, set the *Backchannel logout URL* to
  `<FLUX_PUBLIC_ORIGIN>/api/v1/identity/oidc/<provider id>/backchannel-logout` (the id is in the
  `Single sign-on is on` log line and in the redirect URI) and require the session id. Flux verifies
  the signed logout token (signature from the provider's keys, issuer, audience, times, the logout
  event, no `nonce`, and a `jti` it has not seen), ends the browser sessions created from that
  provider session (or all of the person's sessions when only `sub` is sent), and asks for an
  immediate standing check. A plain logout does not stop agents; with Keycloak's *Backchannel logout
  revoke offline sessions* on, Flux also revokes the person's MCP refresh tokens and its own stored
  provider token, so agents must be authorized again. Flux answers 200, or 400 for a refused token,
  with `Cache-Control: no-store`; an unknown session id is answered 200.
- **Only the stored state is read per request;** an unreachable provider adds no latency to MCP calls.

## Tested with

`./scripts/check_oidc.sh` runs a pinned, disposable Keycloak and a deterministic mock provider in
Docker and drives the real browser flow: sign-in, a stable subject across email changes, refused
unverified, colliding, replayed, forged, wrong-nonce, wrong-key, wrong-issuer and wrong-audience
tokens, sessions across an API restart, sign-out, the confirmation age at the browser, MCP and the
refresh grant, and notification mail. With `FLUX_OIDC_CLOSEOUT=1` it also signs Codex and Claude Code
in as MCP clients through Keycloak. It uses its own Compose project and ports
(`FLUX_OIDC_TEST_PORT`, default 18095) and removes everything afterwards.

Not covered: SAML, SCIM provisioning, several providers at once, and a production provider's
own policies (MFA, conditional access), which stay the provider's responsibility.

## Agents (MCP clients) with single sign-on

The page
an agent client opens for authorization (`/login`, for example from `claude mcp login`) shows
**Sign in with** and your `FLUX_OIDC_LABEL`, the only sign-in offered while the provider is set. Flux keeps the signed authorization request through
the provider round trip and continues to the connection choice and consent afterwards; the client only
ever receives Flux's own code and tokens, and an access or ID token issued by the provider is refused at
`/mcp`. If the provider step is cancelled or fails, the page returns to `/login` with the same request
and a message. If the provider's discovery document cannot be read, the button is disabled and says
`<label> is not reachable right now`. Flux keeps retrying a provider that was unavailable at startup.
The same signed login page enables sign-in when it recovers; no API restart or page reload is needed.
Pre-registered Codex clients: register the callback that Codex displays. It is the stable
`http://127.0.0.1/callback` when the server advertises the issuer response parameter, as Flux does.

## Moving existing accounts

Accounts made with a password before the provider existed have no provider identity, so they cannot sign
in once the cutover is on. Move them first, in this order:

1. Set `FLUX_OIDC_*` and `FLUX_SSO_MODE=prepare`, then restart. Password sign-in keeps working.
2. Each person signs in with their password, opens **Settings**, and selects **Link ...**. They complete one
   provider sign-in as the same person. Flux links that provider identity to their existing account: the
   account ID, data, memberships and grants stay. Flux matches nothing by email. An identity that another
   account already holds, or an account already linked to another identity, is refused with the reason shown
   in Settings, and nothing changes. A link lasts 10 minutes and works once.
3. When everyone who needs access has linked, set `FLUX_SSO_MODE=sso` (or remove the setting) and restart.
   At startup the log says how many password-only accounts are still left. They cannot sign in until they
   are moved; there is no ordinary password fallback.

**Accounts that cannot link** (for example, the provider account was lost): the operator re-keys them with
`./flux identity link <userId> --subject <provider subject> --reason "<why>"`. It names the account by its Flux id,
never by an address, and refuses a subject another account holds. In SSO-only mode it refuses unless
`--allow-sso` is given. A re-key writes an audit row (`auth_identity_audit`) with the actor, the reason and the
old/new subjects and issuer values. For a changed issuer, pass the exact former issuer explicitly with
`--old-issuer <issuer URL>`; Flux checks that issuer's derived provider id against the sole provider mapping on
that Flux account before replacing it with the currently configured provider identity. Missing or ambiguous
mappings are refused, and historical audit rows whose issuer was never recorded remain unknown. A successful
re-key ends the account's sessions and old MCP authority/refresh credentials; its Flux data stays where it is.

**Removing a sign-in is an operator recovery action, not a Settings action.** Settings never removes the provider
sign-in, in any mode. The host operator removes it with `./flux identity unlink <userId> --reason "<why>"`, which is
refused when it is the account's last way in: always in SSO-only mode, and in prepare mode when the account has no
password. A removal ends the sessions that signed in through it and the account's MCP authority, keeps the account's
Flux data, and writes an audit row.

## Provider notes

**Claim rules.** Generic OpenID Connect providers use the verified `email_verified` claim. Microsoft Entra ID
requires the token's tenant (`tid`) to match its issuer, and an address counts as verified only with the
`xms_edov` (email domain owner verified) claim. Google requires `email_verified`. These rules are unit-tested against
documented claim shapes. **Real Entra and Google tenants have not been tested**; their compatibility stays unverified
until a recorded integration run exists.
