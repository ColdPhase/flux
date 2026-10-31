# Security hardening

What Flux does by default, and what the operator adds. Report a vulnerability privately as
described in the [security policy](../SECURITY.md).

## Already in place

- **Only the API is published, on loopback.** PostgreSQL, the worker and the keyring have no host
  port. The keyring's network is internal to the host and joins only `api`, `worker` and `keyring`.
- **Non-root containers.** The Flux image runs as its own user; the keyring and the agent runtime
  also run read-only, with every Linux capability dropped and `no-new-privileges`. No service mounts
  the Docker socket.
- **No swap, no core dumps** for `api`, `worker` and `keyring`.
- **Pinned images.** PostgreSQL and the release image are pinned by digest.
- **One origin.** State-changing browser requests are accepted only from `FLUX_PUBLIC_ORIGIN`;
  `Host` and forwarding headers never change it. With `https`, cookies are `Secure` and `__Secure-`
  prefixed.
- **Sign-in rate limits**, single-use hashed reset tokens, sessions stored server-side and revocable
  from **Settings → Account**.
- **Agents act only with granted permission.** MCP clients sign in through OAuth with per-project
  grants, and a space's owners can turn AI off for the whole space.
- **Outbound fetches are restricted.** Link cards are off by default and never reach private
  addresses; AI endpoints reach private addresses only when you list them in
  `FLUX_AI_PRIVATE_TARGETS`; cloud metadata addresses are always refused.

## Checklist for the operator

1. **Serve HTTPS only**, through one [reverse proxy](reverse-proxy.md), with
   `FLUX_PUBLIC_ORIGIN=https://…`. Redirect port 80 to 443.
2. **Firewall** everything except 80 and 443 (and the media ports if you run
   [live media](../development/live-media.md)). Docker publishes ports past some host firewalls; Flux
   publishes only on loopback, so keep any port you add in an override on `127.0.0.1` too.
3. **Trust only your proxy.** Set `FLUX_TRUSTED_PROXIES` to the measured address of the proxy hop
   ([how](reverse-proxy.md#trust-only-the-measured-proxy-peer)); never a whole private range or
   `0.0.0.0/0`.
4. **Decide who may sign up.** `FLUX_SIGNUP=verified` with email, or `off` with
   [single sign-on](single-sign-on.md). `open` lets anyone who reaches the server create an account.
5. **Protect the settings file.** `docker/.env` (or the release `.env`) is mode `600` and holds the
   database password, `FLUX_AUTH_SECRET`, `FLUX_KEY_PIN_SECRET`, the VAPID private key and any
   provider secrets. Do not commit it, do not export its values in a shell, keep it with backups.
6. **Keep secret files out of the checkout and the database backup**: the OIDC client secret
   (`FLUX_OIDC_CLIENT_SECRET_HOST_FILE`) and the background key (`FLUX_BACKGROUND_KEY_HOST_FILE`).
7. **Encrypt backups that leave the machine.** An archive holds every message and document, password
   hashes and the settings file ([backup schedule](README.md#backup-schedule)).
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
