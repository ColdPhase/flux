# Single sign-on

Flux can let people sign in with your organisation's OpenID Connect identity provider (Keycloak,
Microsoft Entra ID, Google Workspace, Okta, Authentik and others), next to email and password
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
   `https://<your Flux origin>/api/auth/oauth2/callback/<provider id>`. Flux prints the exact
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
         - /etc/flux/oidc_client_secret:/run/secrets/flux_oidc_client_secret:ro
   ```

4. **Restart:** `./flux up` (or `docker compose … up -d`). The sign-in page shows
   "Sign in with Acme login" once the API reads the provider's discovery document.

The API reads discovery when it starts. If the provider is unreachable then, single sign-on fails
until the next restart; password sign-in is unaffected.

## Verified behavior

`./scripts/check_oidc.sh` runs a pinned, disposable Keycloak in Docker as the provider and drives
the real browser flow against Flux: sign-in, the same subject keeping the person, grants and
verified address across an email change, refused unverified and colliding identities, a replayed
or forged callback, a session across an API restart, and one message per actual mailbox through
Mailpit. It uses its own Compose project and ports (`FLUX_OIDC_TEST_PORT`, default 18095, and the
next port for Mailpit) and removes everything afterwards.

Not covered: SAML, SCIM provisioning, several providers at once, and a production provider's
own policies (MFA, conditional access), which stay the provider's responsibility.
