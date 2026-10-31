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

### 2. Set the public address and the sign-up rule

Edit `docker/.env` (it is private, mode `600`; keep it that way):

```dotenv
FLUX_PUBLIC_ORIGIN=https://flux.example.org
# Who may create an account: open, verified (needs email below) or off (single sign-on only).
FLUX_SIGNUP=verified
FLUX_SMTP_URL=smtps://flux:app-password@mail.example.org:465
FLUX_MAIL_FROM=Flux <flux@example.org>
```

`FLUX_PUBLIC_ORIGIN` must be exactly the address people type, with `https` and no path. Flux refuses
any non-loopback `http` origin. With `FLUX_SIGNUP=open` anyone who can reach the server can create an
account; that is fine on a private network and not on the open internet. Invite links never open
closed sign-up, so with `off` people join only through [single sign-on](single-sign-on.md). Every
other setting is in the [configuration reference](configuration.md).

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
[Traefik](reverse-proxy.md#traefik) work the same way. Then
[trust only the proxy's address](reverse-proxy.md#trust-only-the-measured-proxy-peer) with
`FLUX_TRUSTED_PROXIES`, so sign-in limits and session lists see real client addresses.

### 4. Create your account and your first space

Open `https://flux.example.org` and sign up. The first project you create also creates your first
space (workspace), and you are its owner. Bring people in from **Settings → People** with an invite
link; [administration](administration.md) covers roles, the AI switch and the rest.

<!-- MEDIA SLOT (#780, after #763 round 2): short video of sign-up, first project and copying an invite link. -->

### 5. Finish the server

- **Backups.** Add the daily `./flux backup --keep 14` cron entry from the
  [operations overview](README.md#backup-schedule) and copy archives off the machine.
- **Push notifications.** `./flux up` generated VAPID keys with a placeholder contact. Set
  `FLUX_VAPID_SUBJECT=mailto:you@example.org` in `docker/.env` and run `./flux up`
  ([phones, tablets and push](mobile-and-push.md)).
- **Monitoring.** Watch `/api/v1/health` and the containers' health ([monitoring](monitoring.md)).
- **Hardening.** Go through the [hardening checklist](hardening.md).

### What the source path leaves on

`./flux up` writes a random `FLUX_FIXTURE_TOKEN`, which the source Compose file requires. It enables
the integration-fixture endpoints used by the checks, only for a caller that holds that token. Keep
`docker/.env` private; a release installation leaves the token empty.

## Kubernetes and k3s

Flux ships no Kubernetes manifests or Helm chart for its own services in this version, and Docker
Compose on one host is the only tested deployment. The design assumes one host: the `keyring` must be
exactly one per deployment and share a private network with `api` and `worker` only, the containers
need memory limits that forbid swap, and the `files` volume is shared by `api` and `worker`
([architecture](architecture.md)).

What the repository does have for k3s is the optional live-media server: values for the official
LiveKit chart in [`docker/k3s/`](../../docker/k3s/livekit-values.yaml) with a render check,
`./scripts/check_live_k3s.sh`. It checks the rendered manifests; it is not an installation test. The
[k3s media contract](../development/live-media-k3s.md) lists its inputs, ports and security rules.
