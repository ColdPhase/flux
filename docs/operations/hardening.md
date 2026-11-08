# Security hardening

What Flux does by default, and what the operator adds. Report a vulnerability privately as
described in the [security policy](../SECURITY.md).

## Already in place

- **Only the API is published, on loopback.** PostgreSQL, the worker and the keyring have no host
  port. The keyring's network is internal to the host and joins only `api`, `worker` and `keyring`.
- **Non-root containers.** The Flux image runs as its own user; the keyring also runs read-only, with
  every Linux capability dropped and `no-new-privileges`. No service mounts the Docker socket.
- **The agent runtime keeps people apart.** It is read-only with `no-new-privileges` and starts as
  root inside its container with six capabilities, only to give each person their own user id. Their
  CLIs run under that id with none. See
  [what the runtime gets](agent-runtime.md#what-the-runtime-gets).
- **No swap, no core dumps** for `api`, `worker` and `keyring`.
- **Pinned images.** PostgreSQL and the release image are pinned by digest.
- **Response headers.** Every response carries `X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin`, API answers carry
  `Cache-Control: no-store`, and with an `https` public origin the API sends `Strict-Transport-Security: max-age=31536000` (a year), so a
  browser that has seen your address refuses `http` for it. Script policy is separate.
- **No internal messages.** An unexpected server error answers `500` with a code only; its message (a SQL or file-path text, anything it
  quotes) reaches neither the browser nor the log.
- **A security log.** One line for each failed or limited sign-in, password or session change, consent decision, refused request and space
  unlock ([security events](monitoring.md#security-events)), with no secret, address or content in it.
- **One origin.** State-changing browser requests are accepted only from `FLUX_PUBLIC_ORIGIN`;
  `Host` and forwarding headers never change it. With `https`, cookies are `Secure` and `__Secure-`
  prefixed.
- **Passwords and guessing.** A password needs 12 to 128 characters and must not be a common password
  (the list ships with the server; nothing is sent anywhere) or built from the person's name or email.
  Sign-in is limited per client address (an IPv6 address counts as its /64) and the account backs off
  by itself after five wrong passwords, 30 seconds up to 15 minutes, whatever the address. Both counts
  live in PostgreSQL, so every API process shares them. A browser that has signed in to the account
  keeps a signed `flux.device` cookie and counts in a wait of its own, so someone guessing at an address
  cannot keep its owner out of the browser they use; the cookie is not a credential. A password reset and signing out the other
  devices end every older copy of the cookie (the browser that did it keeps its own, given again; a browser with only a session gets none).
- **Single-use hashed reset tokens, sessions stored server-side** and revocable from
  **Settings → Account**. A password reset, and signing out the other devices, also disconnect the
  person's local AI clients; they connect again with one click on the consent page.
- **Agents act only with granted permission.** MCP clients sign in through OAuth with per-project
  grants, and a space's owners can turn AI off for the whole space.
- **Outbound fetches are restricted.** Link cards are off by default and never reach private
  addresses; AI endpoints reach private addresses only when you list them in
  `FLUX_AI_PRIVATE_TARGETS`; cloud metadata addresses are always refused.

## Checklist for the operator

1. **Serve HTTPS only**, through one [reverse proxy](reverse-proxy.md), with
   `FLUX_PUBLIC_ORIGIN=https://…`. Redirect port 80 to 443. Flux sends `Strict-Transport-Security` itself for an `https` origin;
   do not add `includeSubDomains` or `preload` at the proxy unless every subdomain of the name serves https too.
   **Create your own account before the address is public:** the first account to sign up becomes the company's owner
   ([install step 1](install.md#1-get-the-code-and-start-once-on-loopback)). `./flux up` and the API log warn while nobody has.
2. **Firewall** everything except 80 and 443 (and the media ports if you run
   [live media](../development/live-media.md)). Docker publishes ports past some host firewalls; Flux
   publishes only on loopback, so keep any port you add in an override on `127.0.0.1` too.
3. **Trust only your proxy.** Set `FLUX_TRUSTED_PROXIES` to the measured address of the proxy hop
   ([how](reverse-proxy.md#trust-only-the-measured-proxy-peer)); never a whole private range or
   `0.0.0.0/0`.
4. **Decide who may sign up** ([the options](install.md#5-decide-who-can-sign-up)). `open` lets anyone
   who reaches the server create an account. `verified` only proves that the person can read a
   mailbox, not that they belong to your team. For a private team on the internet, use
   [single sign-on](single-sign-on.md), or create your team's accounts and then set `FLUX_SIGNUP=off`
   (open it briefly to add someone later). A new account sees no space until someone adds it.
   Password accounts have no multi-factor sign-in. OWASP ASVS Level 2 asks for it, and the way to get
   it is single sign-on with your identity provider's MFA.
   With `open` sign-up, the sign-up page tells a person that an address already has an account (it signs the new
   account in, so it cannot answer the same way); `verified` answers every address alike and mails the owner of the
   mailbox. The page is behind the per-address limit, and the accepted risk is that someone who can reach the server
   can find out which addresses have accounts. `verified` or single sign-on removes it.
   Sessions end after 7 days unused and 30 days after sign-in; shorten them with `FLUX_SESSION_IDLE` and
   `FLUX_SESSION_MAX_AGE` (ASVS Level 2 asks for `30m` and `12h`; [configuration](configuration.md)).
5. **Protect the settings file.** `docker/.env` (or the release `.env`) is mode `600` and holds the
   database password, `FLUX_AUTH_SECRET`, `FLUX_KEY_PIN_SECRET`, the VAPID private key and any
   provider secrets. Do not commit it, do not export its values in a shell, keep it with backups.
6. **Keep secret files out of the checkout and the database backup**: the OIDC client secret
   (`FLUX_OIDC_CLIENT_SECRET_HOST_FILE`) and the background key (`FLUX_BACKGROUND_KEY_HOST_FILE`).
7. **Encrypt backups that leave the machine.** An archive holds every message and document, password
   hashes and the settings file ([backup schedule](backup-restore.md#backup-schedule)).
8. **Never run `./flux demo`** on a server, and leave `FLUX_DEMO_*_PASSWORD` empty there.
9. **Turn on only what you use.** Link cards, the AI switches, the agent runtime, the GitHub App and
   live media are all off until you set them.
10. **Keep swap off or encrypted** if anyone will use [encrypted spaces](encrypted-spaces.md#swap-and-memory).
11. **Upgrade promptly**, with a backup first ([upgrade](upgrade.md)).
12. **Rotate a leaked secret.** A new `FLUX_AUTH_SECRET` signs everyone out and voids pending invite
    links. A new database password needs the same change inside PostgreSQL first. **Never** change
    `FLUX_KEY_PIN_SECRET`: encrypted spaces would refuse to unlock.

## In a source checkout

`./flux up` generates `FLUX_FIXTURE_TOKEN`, which the source Compose file requires: it enables the
integration-fixture endpoints used by the checks, for a caller holding that token only. Test-only
switches such as `FLUX_TEST_FAILURE_INJECTION` stay off unless set; never set them on a server. The
[configuration reference](configuration.md#set-by-flux-not-by-you) lists every such name.
