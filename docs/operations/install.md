# Installation

There are three ways to run Flux. All of them are Docker Compose on one host.

| Path | For | Guide |
| --- | --- | --- |
| **Try it on your computer** | Seeing Flux with sample data, at `http://127.0.0.1:8081` | [Quick start](../../README.md#quick-start) |
| **Your own server, from a source checkout** | A team instance on your domain, today | This page |
| **Your own server, from a published release** | A team instance without the source or a build | [Install from a release](install-release.md) |

No Flux release has been published yet, so a server today runs from a source checkout with the
`./flux` launcher. The launcher builds the image on the server, keeps its settings in `docker/.env`,
and gives you [backups](backup-restore.md), restores and [upgrades](upgrade.md) as single commands.
When a release is published, the release path runs the same services from a signed image instead.

Check the [requirements](requirements.md) first: a Linux host with Docker Engine and the Compose
plugin, 4 GB of memory, and a DNS name pointing at the host.

<!-- MEDIA SLOT (#780, after #763 round 2): screenshot of the first sign-up page at https://flux.example.org, light and dark. -->

## Production installation from a source checkout

The example uses `/srv/flux` and `https://flux.example.org`; replace both.

### 1. Get the code and start once on loopback

```sh
sudo mkdir -p /srv/flux && sudo chown "$USER" /srv/flux
git clone --depth 1 https://github.com/ColdPhase/flux.git /srv/flux
cd /srv/flux
./flux up
```

The first `./flux up` creates `docker/.env` with new random secrets, builds the image (a few
minutes), runs the migrations, starts the services and prints `http://127.0.0.1:8081`. In a terminal
it also asks once whether people may sign in with their own ChatGPT and Claude subscriptions; the
[agent runtime guide](agent-runtime.md) explains the choice, and Enter or `n` can be changed later
with `./flux ai on`. Start with another port if 8081 is taken: `FLUX_PORT=8090 ./flux up`.

Check that it answers:

```sh
curl -fsS http://127.0.0.1:8081/api/v1/health    # {"status":"ok","schemaVersion":…}
```

Do not run `./flux demo` on a server: it creates accounts with printed passwords, and it refuses a
non-loopback origin unless forced.

### 2. Set the public address and email

Edit `docker/.env` (it is private, mode `600`; keep it that way):

```dotenv
FLUX_PUBLIC_ORIGIN=https://flux.example.org
FLUX_SMTP_URL=smtps://flux:app-password@mail.example.org:465
FLUX_MAIL_FROM=Flux <flux@example.org>
```

`FLUX_PUBLIC_ORIGIN` must be exactly the address people type, with `https` and no path. Flux refuses
any non-loopback `http` origin. Leave `FLUX_SIGNUP` as it is for now (`open`): you close sign-up in
step 5, after your own account exists. Every other setting is in the
[configuration reference](configuration.md).

Email is optional, but without it nobody can reset a forgotten password. In the SMTP URL,
percent-encode special characters of the user name and password (`@` is `%40`, `/` is `%2F`). Use
`smtps://…:465` or `smtp://…:587?requireTLS=true`; plain `smtp://` without TLS is only for a mail
relay on a trusted network.

Apply the change:

```sh
./flux up
```

`./flux up` never overwrites `docker/.env`; it recreates the containers whose settings changed.

### 3. Put HTTPS in front

Flux's API stays on `127.0.0.1:8081`. A reverse proxy on the same host terminates TLS on port 443
and forwards everything to it, WebSocket upgrades included. With [Caddy](reverse-proxy.md) the whole
configuration is:

```caddyfile
flux.example.org {
	reverse_proxy 127.0.0.1:8081
}
```

Caddy obtains and renews the certificate itself. [nginx](reverse-proxy.md#nginx) and
[Traefik](reverse-proxy.md#traefik) work the same way; on a network without public DNS see
[private network or home lab](#private-network-or-home-lab). Then
[trust only the proxy's address](reverse-proxy.md#trust-only-the-measured-proxy-peer) with
`FLUX_TRUSTED_PROXIES`, so sign-in limits and session lists see real client addresses.

### 4. Create your account and check mail

Open `https://flux.example.org` and sign up. The first project you create also creates your first
space (workspace), and you are its owner.

Check that email works:

```sh
curl -fsS https://flux.example.org/api/v1/auth/capabilities
# {"passwordReset":"available","signup":"open",…}
```

`passwordReset` must be `available`. Then sign out, choose **Forgot password** with your own address
and check that the mail arrives. A send that fails is logged by the API as `Password reset mail
failed`, with the SMTP server's answer.

### 5. Decide who can sign up

With `open`, anyone who can reach the server can create an account. Choose the rule for your
instance in `docker/.env` and apply it with `./flux up`:

| You want | Set | What happens |
| --- | --- | --- |
| Anyone who reaches the server may join | `FLUX_SIGNUP=open` | Fine on a private network; not on the open internet. |
| Anyone with a working mailbox may join | `FLUX_SIGNUP=verified` (needs email) | A new account confirms its address by mail before it can sign in. This proves a mailbox, **not membership**: any address that can receive mail can sign up. Without email, sign-up is closed. |
| Only your team, with your identity provider | [single sign-on](single-sign-on.md) | Only people your provider lets in can sign in. In `sso` mode password sign-up is closed whatever `FLUX_SIGNUP` says. |
| Only the people you add, without single sign-on | `FLUX_SIGNUP=off` after their accounts exist | Nobody can create an account, **including you**. An invite link never opens closed sign-up. |

A new account belongs to no space: it sees only the spaces someone adds it to, with **Add someone**
or an invite link ([administration](administration.md#invite-links)). A stranger who signs up sees
none of your team's work, but can still create their own projects on your server and use its storage.
For a private team on the internet, use single sign-on, or create the accounts and then set `off`.

**To add someone while sign-up is `off`**: set `FLUX_SIGNUP=verified` (or `open`), run `./flux up`,
send them an invite link, and set it back to `off` with `./flux up` once they have joined.

**Locked out?** If you closed sign-up before creating your own account, set `FLUX_SIGNUP=open`, run
`./flux up`, create the account, then close it again. Flux has no command that creates an account or
sets a password.

<!-- MEDIA SLOT (#780, after #763 round 2): short video of sign-up, first project and copying an invite link. -->

### 6. Finish the server

- **Backups.** Add the daily `./flux backup --keep 14` cron entry from
  [backup and restore](backup-restore.md#backup-schedule) and copy archives off the machine.
- **Push notifications.** `./flux up` generated VAPID keys with a placeholder contact. Set
  `FLUX_VAPID_SUBJECT=mailto:you@example.org` in `docker/.env` and run `./flux up`
  ([phones, tablets and push](mobile-and-push.md)).
- **Monitoring.** Watch `/api/v1/health` and the containers' health ([monitoring](monitoring.md)).
- **Hardening.** Go through the [hardening checklist](hardening.md).

## Private network or home lab

Without public DNS, Caddy cannot get a public certificate. Use an internal name (for example
`flux.home.arpa` in your router's DNS) and Caddy's own certificate authority:

```caddyfile
flux.home.arpa {
	tls internal
	reverse_proxy 127.0.0.1:8081
}
```

Set `FLUX_PUBLIC_ORIGIN=https://flux.home.arpa`. Every device that opens Flux must trust Caddy's
root certificate: copy it out with
`docker cp <caddy container>:/data/caddy/pki/authorities/local/root.crt flux-root.crt` (the
[Caddy example](reverse-proxy.md#local-https-example) shows the full commands) and install it as a
trusted root on each computer, phone and tablet. Phones need it trusted for the installed app and
push. A certificate from your own CA works the same way.

## What the source path leaves on

`./flux up` writes a random `FLUX_FIXTURE_TOKEN`, which the source Compose file requires. It enables
the integration-fixture endpoints used by the checks, only for a caller that holds that token. Keep
`docker/.env` private; a release installation leaves the token empty.

## Kubernetes

Kubernetes (including k3s and Helm) is not supported yet (founder decision, 2026-10-31): Docker Compose
on one host is the only supported install. The design assumes one host: the `keyring` must be
exactly one per deployment and share a private network with `api` and `worker` only, the containers
need memory limits that forbid swap, and the `files` volume is shared by `api` and `worker`
([architecture](architecture.md)).
