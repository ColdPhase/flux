# Installation

There are three ways to run Flux. All of them are Docker Compose on one host.

| Path | For | Guide |
| --- | --- | --- |
| **Try it on your computer** | Seeing Flux with sample data, at `http://127.0.0.1:8081` | [Quick start](../../README.md#quick-start) |
| **Your own server, from a source checkout** | A team instance that builds on the server, for example on `arm64` | This page |
| **Your own server, from a published release** | A team instance without the source or a build | [Install from a release](install-release.md) |

Flux v0.2 can run from the digest-pinned image of the [latest release](https://github.com/ColdPhase/flux/releases/latest). That image is
`linux/amd64` only; `linux/arm64` is planned for v0.3. A source checkout uses the `./flux` launcher,
which builds the image on the server, keeps its settings in `docker/.env`, and gives you
[backups](backup-restore.md), restores and [upgrades](upgrade.md) as single commands. The release
path runs the same services without the source or a build.

This page is a fresh installation. **v0.2 does not upgrade a v0.1 installation** (v0.1 had no users): if this host or checkout
already runs v0.1, [read why and what to do](upgrade.md#from-v01-install-v02-fresh) first.

Check the [requirements](requirements.md) first: a Linux host with Docker Engine 25 or newer and the Compose
plugin, 4 GB of memory, and a DNS name pointing at the host.

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

**Create your account now, before the server has a public address.** The first account to sign up
becomes the company's owner, with every space, and `FLUX_SIGNUP` is `open` until you change it. On a server,
open `http://127.0.0.1:8081` through an SSH tunnel (`ssh -L 8081:127.0.0.1:8081 you@server`), choose
**Sign up**, and keep this account: it is yours. It works because the address is still the loopback one; once you
set `FLUX_PUBLIC_ORIGIN` in step 2, Flux accepts sign-up only from that address. If you set it first, `./flux up` says
that nobody has signed up yet, and so does the API log at each start, until someone has.

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

### 3. HTTPS: point the DNS name at the server

HTTPS is built in ([#1471](https://github.com/ColdPhase/flux/issues/1471)). Because the origin in step 2 is
`https`, `./flux up` also starts a bundled, pinned Caddy on ports 80 and 443 that gets and renews the
certificate for `flux.example.org` itself and passes everything to the API, which stays on
`127.0.0.1:8081`. The API trusts exactly Caddy's address, so sign-in limits and session lists see real
client addresses; `./flux up` prints that address.

Your part is DNS: an A record for `flux.example.org` pointing at the server, and inbound 80/tcp and
443/tcp open to it. Add no AAAA record unless Docker on the server has IPv6 networking enabled (see the
[guide](reverse-proxy.md#built-in-https)). Caddy retries until the name resolves, so the order
does not matter. The details, and how to keep [a proxy of your own](reverse-proxy.md#your-own-proxy-instead)
instead (the same file, with its address in `FLUX_TRUSTED_PROXIES`), are in the
[reverse proxy guide](reverse-proxy.md#built-in-https).

### 4. Create your account and check mail

Open `https://flux.example.org` and sign in with the account you made in step 1 (if you did not,
sign up now: the first account sets up the company and is its owner, and nothing stops a stranger who reaches the
address first). It owns the default space **Everyone**; everyone else joins by an invite link from an admin (or
by signing in, with single sign-on). Spaces are added from **New › Space**. The password needs 12 to 128 characters.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/screens/signup-dark.webp">
    <img src="../assets/screens/signup-light.webp" width="460" alt="The sign-up page of a new instance: Create your Flux account, with Name, Email and Password fields, the hint that the password needs at least 12 characters, and a Create account button.">
  </picture>
</p>

<p align="center"><sub>The sign-up page, in the light and the dark theme your browser asks for.</sub></p>

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

One Flux is one company. The first account on the server sets it up and becomes its owner, so create
your own account first. A later account with a password belongs to no company until an owner or admin
adds it with **Add someone** or an invite link ([administration](administration.md#invite-links)): a
stranger who signs up sees nothing and can start nothing. With single sign-on, everyone your provider
lets in joins the company as a member on their first sign-in. Inside the company, a person sees only
the spaces they were added to, and the default space Everyone.

**To add someone while sign-up is `off`**: set `FLUX_SIGNUP=verified` (or `open`), run `./flux up`,
send them an invite link, and set it back to `off` with `./flux up` once they have joined.

**Locked out?** If you closed sign-up before creating your own account, set `FLUX_SIGNUP=open`, run
`./flux up`, create the account, then close it again. Flux has no command that creates an account or
sets a password.

After you sign up you are the company's owner, in the default space **Everyone**. Make your first space with
**New › Space**: a name, the people (chosen from the company) and an AI switch that starts on. To bring in the
rest of the team, open **Settings › Company** and use **Invite with a link**
([administration](administration.md#invite-links)).

<p align="center">
  <img src="../assets/screens/first-space.webp" width="42%" alt="New space: a Name field, People with Add people, an AI switch that is on, an Encrypted switch that is off and cannot be turned off later, and a Create space button.">
  <img src="../assets/screens/invite-link.webp" width="45%" alt="Invite with a link in Settings, Company: Joins as Member, Works for 7 days, the Create invite link button and the link it made, with a Copy link button.">
</p>

<p align="center"><sub>The New space window, and an invite link made in Settings › Company.</sub></p>

### 6. Finish the server

- **Backups.** Add the daily `./flux backup --keep 14` cron entry from
  [backup and restore](backup-restore.md#backup-schedule) and copy archives off the machine.
- **Push notifications.** `./flux up` generated the VAPID keys. The contact the push services get
  is your public `https://` address, so iPhone and iPad work once `FLUX_PUBLIC_ORIGIN` is that
  address and you have run `./flux up` again; there is nothing else to set
  ([phones, tablets and push](mobile-and-push.md)).
- **Monitoring.** Watch `/api/v1/health` and the containers' health ([monitoring](monitoring.md)).
- **Hardening.** Go through the [hardening checklist](hardening.md).

## Private network or home lab

Without public DNS there is no public certificate. Use an internal name (for example `flux.home.arpa`
in your router's DNS; `*.internal`, `*.local` and an IP address work the same way) and set
`FLUX_PUBLIC_ORIGIN=https://flux.home.arpa`: the bundled Caddy then issues the certificate from its own
certificate authority, with nothing else to set. Every device that opens Flux must trust that
authority's root certificate once: copy it out with
`docker cp <FLUX_PROJECT>-proxy-1:/data/caddy/pki/authorities/local/root.crt flux-root.crt` and install
it as a trusted root on each computer, phone and tablet. Phones need it trusted for the installed app
and push. A certificate from your own CA works through [your own proxy](reverse-proxy.md#your-own-proxy-instead).

## Calls and screen sharing

Set `FLUX_CALLS=on` in `docker/.env` and run `./flux up`: it starts the media server, writes its key and
secret, takes the media address from the origin's DNS name and prints the ports to open
(7881/tcp, 7882/udp, 3478/udp). See [calls](calls.md).

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
