#!/usr/bin/env python3
"""Generates the operator configuration reference, docs/operations/configuration.md, from the code.

    python3 scripts/config_reference.py            # rewrite docs/operations/configuration.md
    python3 scripts/config_reference.py --check    # fail when the page or the inventory drifts from the code

What comes from the code, on every run:

- every `FLUX_*` name in the application sources (app/apps/*/src, app/packages/*/src, app/tooling), the
  shipped Compose files, the Dockerfile, the release runtime script, the `./flux` launcher and
  docker/.env.example;
- each variable's default, or that it is required, from the Compose interpolations
  (`${NAME:-default}`, `${NAME:?message}`), the launcher's own `${NAME:-default}` and docker/.env.example;
- which Compose services receive it, and whether the release `compose.yaml`, the source checkout, an
  overlay or the launcher uses it;
- the launcher's command list, from `./flux help`.

What is written here by hand, and checked against the code: each variable's group, type, example and
effect (VARIABLES), the names that are internal wiring or test switches (INTERNAL), and names that are
not settings at all (NOT_SETTINGS). The check fails when a `FLUX_*` name appears in the code but in none
of these tables, when a table names something the code no longer has, when an operator variable has no
way in (no Compose file, launcher or template uses it and it is not marked `override`), and when the
generated page differs from the file. Standard library only, so it runs in the repository check.
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PAGE = ROOT / "docs" / "operations" / "configuration.md"
INTERNAL_PAGE = ROOT / "docs" / "development" / "configuration-internal.md"
ENV_EXAMPLE = ROOT / "docker" / ".env.example"
LAUNCHER = ROOT / "flux"

# Compose files an operator runs, and what each one is. Test-only Compose files are not scanned.
COMPOSE = {
    "docker/compose.yaml": "release",
    "docker/compose.runtime.yaml": "release runtime overlay",
    "docker/compose.source.yaml": "source",
    "docker/compose.source.runtime.yaml": "source",
    "docker/compose.dev.yaml": "dev",
    "docker/compose.live.yaml": "live-media overlay",
    "docker/compose.live.turn.yaml": "TURN overlay",
}
OTHER_DEPLOY = ["docker/Dockerfile", "docker/runtime.sh", "docker/.env.example", "flux"]
CODE_ROOTS = ["app/apps", "app/packages"]
CODE_SUFFIXES = {".ts", ".tsx", ".js", ".mjs", ".cjs"}
NAME = re.compile(r"\bFLUX_[A-Z0-9_]+")
# ${VAR}, ${VAR:-default}, ${VAR-default}, ${VAR:?message}; `$${VAR}` is a literal for the container shell.
REFERENCE = re.compile(r"(?<!\$)\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?])((?:[^{}]|\{[^{}]*\})*))?\}")


@dataclass(frozen=True)
class Var:
    group: str
    type: str
    effect: str
    example: str = ""
    # A setting the application reads that no shipped Compose file passes in: set it on the service in
    # docker/compose.override.yaml (source checkout) or your own Compose override. `services` and
    # `default` are then given here, since no Compose file states them.
    override: bool = False
    services: str = ""
    default: str = ""
    secret: bool = False


# The settings most operators change, shown first on the page.
COMMON = ["FLUX_PUBLIC_ORIGIN", "FLUX_SIGNUP", "FLUX_SMTP_URL", "FLUX_MAIL_FROM", "FLUX_TRUSTED_PROXIES",
          "FLUX_VAPID_SUBJECT", "FLUX_API_MEMORY", "FLUX_WORKER_MEMORY"]

GROUPS = [
    ("instance", "Instance and network",
     "Where Flux listens and the one address people use. Every deployment sets `FLUX_PUBLIC_ORIGIN`."),
    ("database", "Database", "PostgreSQL runs in the `db` service with the `pgdata` volume; it is never published."),
    ("identity", "Accounts, sign-up and sessions", ""),
    ("sso", "Single sign-on (OpenID Connect)",
     "Optional, one provider. The [single sign-on guide](single-sign-on.md) walks through it."),
    ("email", "Email", "Optional. Without it password reset reports unavailable; the in-app Inbox and push keep working."),
    ("push", "Web Push", "Optional, all three or none. See [phones, tablets and push](mobile-and-push.md)."),
    ("collaboration", "Collaboration, link cards and the live stream", ""),
    ("media", "Live media: LiveKit and TURN",
     "Only with the optional overlays `docker/compose.live.yaml` and `docker/compose.live.turn.yaml`, layered on the "
     "source Compose file. The release `compose.yaml` does not include live media yet."),
    ("ai", "AI providers",
     "Owners connect their own AI provider in **Settings → Agents and AI**. These switches decide what the instance allows. "
     "They are read by the source checkout's Compose file; the release `compose.yaml` does not pass them yet."),
    ("runtime", "Agent runtime: the owner's own Claude Code or Codex",
     "Off by default. See the [agent runtime guide](agent-runtime.md); `./flux ai on` writes these for you."),
    ("encryption", "Encrypted spaces and the keyring",
     "See [operating encrypted spaces](encrypted-spaces.md). `./flux up` generates the secrets."),
    ("limits", "Memory limits",
     "Memory and swap are limited to the same value, so these containers cannot write memory to a swap device."),
    ("github", "GitHub App (optional)",
     "A read-only GitHub App links pull requests to tasks. Set all six secrets together, or none."),
    ("launcher", "Source checkout, launcher and checks",
     "Read by `./flux`, the hot-reload `dev` profile, the release `runtime.sh` or the check scripts, not by the application."),
]

VARIABLES: dict[str, Var] = {
    # --- instance
    "FLUX_PROJECT": Var("instance", "name",
        "Compose project name: prefixes the containers and the `pgdata` and `files` volumes. `./flux` writes "
        "`flux-<directory>-<hash of the checkout path>` on first use. Keep it across upgrades, or the new version starts "
        "with empty volumes.", "flux"),
    "FLUX_PORT": Var("instance", "port",
        "Port of the API on the host's loopback address (`127.0.0.1`). Point the TLS reverse proxy at it. `./flux up` "
        "reads it only when it creates `docker/.env`.", "8081"),
    "FLUX_PUBLIC_ORIGIN": Var("instance", "origin URL",
        "The exact origin people open, without a path. It is the only origin accepted for state-changing browser "
        "requests, the base of mailed links, OAuth and MCP addresses. `https` makes cookies `Secure`; plain `http` is "
        "accepted only for loopback (`localhost`, `127.0.0.0/8`, `[::1]`), any other `http` origin stops the API.",
        "https://flux.example.org"),
    "FLUX_TRUSTED_PROXIES": Var("instance", "list of IPs or CIDRs",
        "Comma-separated reverse-proxy addresses whose `X-Forwarded-For` is believed. Empty trusts none, and the socket "
        "peer is the client address. Measure the proxy's address as in the [reverse proxy guide](reverse-proxy.md#trust-only-the-measured-proxy-peer); "
        "never `0.0.0.0/0`.", "172.27.0.1/32"),
    # --- database
    "POSTGRES_USER": Var("database", "name", "PostgreSQL user, also part of the database URL of every Flux service.", "flux"),
    "POSTGRES_PASSWORD": Var("database", "secret",
        "PostgreSQL password, part of the database URL: use hex (`openssl rand -hex 32`). `./flux up` generates it. "
        "Never change it on an existing volume.", secret=True),
    "POSTGRES_DB": Var("database", "name", "PostgreSQL database name.", "flux"),
    "FLUX_DB_CONNECT_TIMEOUT_MS": Var("database", "integer, 100–60000 ms",
        "How long a request waits for a database connection (pool of 10 per process) before it fails.",
        override=True, services="api, worker, migrate", default="`1500`"),
    # --- identity
    "FLUX_AUTH_SECRET": Var("identity", "secret, ≥ 32 characters",
        "Signs session cookies, invite-link tokens and cursors. Changing it signs everyone out and voids pending invite "
        "links.", secret=True),
    "FLUX_SIGNUP": Var("identity", "`open` · `verified` · `off`",
        "Who may create a password account. `open`: anyone who reaches Flux. `verified`: anyone who can confirm an "
        "address by mail; it proves a mailbox, not membership of your team (needs email; without it sign-up is closed). "
        "`off`: nobody, including you, so create your own account first. A provider in `sso` mode closes password "
        "sign-up whatever this says, and an invite link never opens closed sign-up. See "
        "[who can sign up](install.md#5-decide-who-can-sign-up).", "off"),
    "FLUX_PASSWORD_RESET_TTL_SECONDS": Var("identity", "integer, 60–86400 s",
        "Lifetime of a password reset link. Links are single use and stored hashed.", "3600"),
    "FLUX_AUTH_RATE_LIMIT": Var("identity", "`true` · `false`",
        "In-memory rate limit on sign-in, sign-up and reset. Only the test scripts turn it off.", "true"),
    # --- sso
    "FLUX_OIDC_ISSUER": Var("sso", "https URL",
        "Issuer of the OpenID Connect provider. Set it with `FLUX_OIDC_CLIENT_ID`, or neither. Must be `https` "
        "(plain `http` only for a loopback issuer). Changing it later makes a new provider: people link again.",
        "https://id.example.org/realms/team"),
    "FLUX_OIDC_CLIENT_ID": Var("sso", "string", "Client id registered at the provider.", "flux"),
    "FLUX_OIDC_CLIENT_SECRET_HOST_FILE": Var("sso", "absolute host path",
        "File on the host holding the client secret, mounted read-only into the API at "
        "`/run/secrets/flux_oidc_client_secret`. The source Compose file mounts it; with the release `compose.yaml`, "
        "mount the file at that path in an override ([how](single-sign-on.md#set-it-up)).", "/etc/flux/oidc-client-secret"),
    "FLUX_OIDC_LABEL": Var("sso", "text, ≤ 60 characters", "Name on the sign-in button. Empty shows “single sign-on”.", "Example ID"),
    "FLUX_SSO_MODE": Var("sso", "`sso` · `prepare`",
        "`prepare` keeps password sign-in while existing accounts link their provider identity; `sso` is the cutover, "
        "after which ordinary sign-in is through the provider only. `prepare` needs a provider.", "prepare"),
    "FLUX_OIDC_CONFIRMATION_MAX_AGE": Var("sso", "duration, `1h`–`30d`",
        "How long the provider's last confirmation of a person keeps their access, in whole hours or days. Empty is `7d`.", "12h"),
    "FLUX_OIDC_STANDING": Var("sso", "`refresh` · `off`",
        "`refresh` checks at the provider that each signed-in person still has an account there; `off` keeps only "
        "logout and the confirmation age.", "off"),
    "FLUX_OIDC_STANDING_INTERVAL_SECONDS": Var("sso", "integer, 5–86400 s", "How often the standing check runs per live identity.", "900"),
    # --- email
    "FLUX_SMTP_URL": Var("email", "SMTP URL",
        "Transport for password reset and notification email. TLS: `smtps://…:465` or `smtp://…:587?requireTLS=true`; "
        "certificates are verified. Percent-encode special characters in the user name and password. Needs "
        "`FLUX_MAIL_FROM`.", "smtps://flux:password@mail.example.org:465", default="empty (`./flux dev`: `smtp://mailpit:1025`)"),
    "FLUX_MAIL_FROM": Var("email", "address", "Sender of every mail. Required when `FLUX_SMTP_URL` is set.", "Flux <flux@example.org>",
        default="empty (`./flux dev`: `Flux dev <flux-dev@localhost>`)"),
    # --- push
    "FLUX_VAPID_PUBLIC_KEY": Var("push", "base64url P-256 key",
        "Public VAPID key; the API gives it to browsers. Generate the pair once (`web-push generate-vapid-keys`, "
        "see [push](mobile-and-push.md)); `./flux up` does it for a source checkout."),
    "FLUX_VAPID_PRIVATE_KEY": Var("push", "secret",
        "Private VAPID key; only the worker receives it. Changing the pair makes every device subscribe again.", secret=True),
    "FLUX_VAPID_SUBJECT": Var("push", "`mailto:` or `https:` URL",
        "Operator contact sent to the push services. Use a real, reachable address.", "mailto:ops@example.org"),
    # --- collaboration
    "FLUX_LIVE_EDITING": Var("collaboration", "`on` · `off`",
        "Shared live editing of maps and Wiki pages. `off` keeps the ordinary saved views and editors; save shared "
        "working copies before turning it off. Other values stop the API.", "off"),
    "FLUX_LINK_PREVIEWS": Var("collaboration", "`on` · `off`",
        "`on` lets the server fetch the title and description of links in messages for their cards. Only public "
        "`http(s)` addresses on default ports; never in encrypted spaces. A fetch tells the site this server's address.", "on"),
    "FLUX_STREAM_HEARTBEAT_MS": Var("collaboration", "integer, ≥ 100 ms",
        "Ping, session recheck and polling interval of the live WebSocket stream. Keep it below your proxy's idle timeout.", "25000"),
    # --- media
    "FLUX_LIVEKIT_API_KEY": Var("media", "string", "LiveKit API key, shared by the API and the SFU. Rotate with the secret.", "livekit-key-1"),
    "FLUX_LIVEKIT_API_SECRET": Var("media", "secret", "LiveKit API secret.", secret=True),
    "FLUX_LIVEKIT_PUBLIC_IP": Var("media", "IP address", "Public media address advertised to browsers in ICE candidates.", "203.0.113.20"),
    "FLUX_LIVEKIT_DOMAIN": Var("media", "DNS name", "Operator-owned media name used for STUN and TURN/UDP.", "media.example.org"),
    "FLUX_LIVEKIT_MEDIA_CIDR": Var("media", "CIDR",
        "The SFU's media interface when the host has several; the default keeps every IPv4 interface.", "203.0.113.20/32"),
    "FLUX_LIVEKIT_ICE_TCP_PORT": Var("media", "port", "Host port of ICE over TCP."),
    "FLUX_LIVEKIT_ICE_UDP_PORT": Var("media", "port", "Host port of the ICE UDP mux."),
    "FLUX_LIVEKIT_TURN_UDP_PORT": Var("media", "port", "Host port of TURN/UDP and STUN."),
    "FLUX_LIVEKIT_TURN_DOMAIN": Var("media", "DNS name", "Name dedicated to TURN/TLS; the certificate's SAN must match.", "turn.example.org"),
    "FLUX_LIVEKIT_TURN_CERT_DIR": Var("media", "absolute host path",
        "Directory with `fullchain.pem` and `privkey.pem` for the TURN name, readable by the LiveKit container.", "/etc/flux/turn-tls"),
    "FLUX_LIVEKIT_TURN_TLS_BIND": Var("media", "IP address",
        "Address for TURN/TLS on TCP/443. The default conflicts with an HTTPS proxy on the same address: use a dedicated IP.", "203.0.113.21"),
    "FLUX_LIVEKIT_TURN_TLS_HOST_PORT": Var("media", "port", "Host port of TURN/TLS. Keep 443 for a public deployment."),
    # --- ai
    "FLUX_BACKGROUND_KEY_HOST_FILE": Var("ai", "absolute host path",
        "File with 32 random bytes that seals owners' AI keys for work the worker does on their behalf. Keep it outside "
        "the checkout and the database backup. Empty leaves the assistant and background suggestions unavailable.",
        "/etc/flux/background.key"),
    "FLUX_PERSONAL_RUNS": Var("ai", "empty · `off` · `on`",
        "`on` lets owners run their assistant on their own AI connection. Needs `FLUX_BACKGROUND_KEY_HOST_FILE`.", "on"),
    "FLUX_BACKGROUND_COMPARISONS": Var("ai", "empty · `off` · `on`",
        "`on` lets owners enable background suggestions, which the worker runs on each owner's own AI connection. "
        "Needs `FLUX_BACKGROUND_KEY_HOST_FILE`.", "on"),
    "FLUX_AI_PRIVATE_TARGETS": Var("ai", "list of hosts, IPs or CIDRs",
        "Private addresses an OpenAI-compatible endpoint may use, such as a local model server. Empty allows public "
        "HTTPS endpoints only; cloud metadata addresses are always refused.", "ollama,10.0.0.0/8"),
    # --- runtime
    "FLUX_AGENT_RUNTIME": Var("runtime", "empty · `claude_code` · `codex` · `claude_code,codex`",
        "Lets people sign in with their own Claude or ChatGPT subscription and run that CLI in an isolated slot. Empty "
        "is off and no runtime service runs.", "codex"),
    "FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS": Var("runtime", "date `YYYY-MM-DD`",
        "Required with `claude_code`: the date you agreed to Anthropic's Commercial Terms with Anthropic. Recorded, not verified.",
        "2026-10-01"),
    "FLUX_AGENT_RUNTIME_IDLE_DAYS": Var("runtime", "integer, 1–365 days",
        "Release a slot from its person after this many days without a run. Empty is off.", "30"),
    "FLUX_RUNTIME_MANAGER_SECRET": Var("runtime", "secret, ≥ 32 characters",
        "Authenticates the API and worker to the runtime manager. Generated by `./flux` or `runtime.sh`.", secret=True),
    "FLUX_RUNTIME_SECRET_1": Var("runtime", "secret", "Secret of slot `runtime-1`, shared only with the manager.", secret=True),
    "FLUX_RUNTIME_SECRET_2": Var("runtime", "secret", "Secret of slot `runtime-2`.", secret=True),
    "FLUX_RUNTIME_SECRET_3": Var("runtime", "secret", "Secret of slot `runtime-3`.", secret=True),
    "FLUX_RUNTIME_SECRET_4": Var("runtime", "secret",
        "Secret of slot `runtime-4`. [More slots](agent-runtime.md#more-slots) take `FLUX_RUNTIME_SECRET_<n>` the same way.", secret=True),
    "FLUX_AGENT_RUNTIME_RECONCILE_MS": Var("runtime", "integer, 500–600000 ms",
        "How often the worker reconciles slot bindings with the runtime manager.", override=True, services="worker", default="`10000`"),
    # --- encryption
    "FLUX_KEYRING": Var("encryption", "`on` · `off`",
        "`off` disables encrypted spaces: each stays locked and none can be created.", "off"),
    "FLUX_KEYRING_TOKEN": Var("encryption", "secret",
        "Authenticates the API and worker to the keyring on its internal network. Empty leaves the keyring idle and "
        "every encrypted space locked.", secret=True),
    "FLUX_KEY_PIN_SECRET": Var("encryption", "secret, ≥ 32 characters",
        "Pins every unlock password and key version, so rows planted in the database are refused. Never change it; back "
        "it up with `docker/.env`, not with the database.", secret=True),
    "FLUX_SWAP_ACKNOWLEDGED": Var("encryption", "empty · `encrypted-swap`",
        "Declares that every swap device is encrypted with a key not stored on disk. Only then may keys be held where "
        "swap is on and not limited per container.", "encrypted-swap"),
    "FLUX_SEALED_SEARCH_MAX_BYTES": Var("encryption", "integer, bytes",
        "Largest in-memory search index of one unlocked encrypted space (estimated heap); a larger space answers that "
        "search is unavailable.", override=True, services="api", default="`268435456` (256 MiB), at most the process bound"),
    "FLUX_SEALED_SEARCH_PROCESS_MAX_BYTES": Var("encryption", "integer, bytes",
        "Bound on all encrypted-space search indexes of one API process.", override=True, services="api",
        default="a quarter of the container memory, 64–512 MiB"),
    "FLUX_SEALED_SEARCH_IDLE_MS": Var("encryption", "integer, ms",
        "An index nobody searched for this long may be evicted for another space's.", override=True, services="api", default="`300000`"),
    # --- limits
    "FLUX_API_MEMORY": Var("limits", "Compose memory size", "Memory of `api` (measured peak 431 MB in the encryption checks).", "3g"),
    "FLUX_WORKER_MEMORY": Var("limits", "Compose memory size", "Memory of `worker` (measured peak 111 MB).", "2g"),
    "FLUX_KEYRING_MEMORY": Var("limits", "Compose memory size", "Memory of `keyring` (measured peak 42 MB).", "256m"),
    # --- github
    "FLUX_GITHUB_CLIENT_ID": Var("github", "string", "The App's OAuth client id."),
    "FLUX_GITHUB_CLIENT_SECRET": Var("github", "secret", "The App's OAuth client secret. Never give it to agents or models.", secret=True),
    "FLUX_GITHUB_APP_ID": Var("github", "integer", "The App's numeric id."),
    "FLUX_GITHUB_APP_SLUG": Var("github", "slug", "The App's URL name (`a-z`, `0-9`, `-`).", "acme-team-app"),
    "FLUX_GITHUB_WEBHOOK_SECRET": Var("github", "secret, ≥ 32 characters", "Verifies webhook deliveries.", secret=True),
    "FLUX_GITHUB_DELIVERY": Var("github", "`webhook` · `poll`",
        "`poll` when GitHub cannot reach this server: open linked pull requests are read every 2 minutes.", "poll"),
    "FLUX_GITHUB_ENCRYPTION_KEY": Var("github", "64 hex characters",
        "AES key for stored GitHub credentials. Keep it with your backups to reconnect them after a restore.", secret=True),
    # --- launcher
    "FLUX_FIXTURE_TOKEN": Var("launcher", "secret",
        "Enables the integration-fixture endpoints used by smoke checks, behind this bearer token. The source Compose "
        "file requires it and `./flux up` generates it; leave it empty in a release `.env`.", secret=True),
    "FLUX_BACKUP_DIR": Var("launcher", "path", "Where `./flux backup` writes archives.", "/mnt/backup/flux",
        default="`backups/` in the checkout"),
    "FLUX_NO_CACHE": Var("launcher", "`1`", "`1` builds the image without the Docker build cache (`./flux up`, `./flux upgrade`).", "1"),
    "FLUX_WAIT_TIMEOUT": Var("launcher", "seconds", "How long `./flux` and `runtime.sh` wait for services to become healthy.", "600"),
    "FLUX_COWORK_WATCHDOG_SECONDS": Var("launcher", "seconds", "Stops a native `./flux cowork` run after this long.", "600"),
    "FLUX_ENV_FILE": Var("launcher", "path", "Settings file the release `runtime.sh` reads.", "/srv/flux/.env",
        default="`.env` beside `runtime.sh`"),
    "FLUX_DEV_PORT": Var("launcher", "port", "`./flux dev` only: port of the Vite dev server; the dev origin is `http://127.0.0.1:<port>`. Does nothing on a server."),
    "FLUX_DEV_POLL": Var("launcher", "`true` · `false`", "`./flux dev` only: watch files by polling, for file systems without change events.", "true"),
    "FLUX_MAILPIT_PORT": Var("launcher", "port", "`./flux dev` and checks: port of the local mail catcher's web page. Does nothing on a server."),
    "FLUX_DEMO_OWNER_PASSWORD": Var("launcher", "secret",
        "Password `./flux demo` gives the demo owner. Leave empty on a real deployment and never run the demo there.", secret=True),
    "FLUX_DEMO_PARTNER_PASSWORD": Var("launcher", "secret", "Password `./flux demo` gives the second demo account.", secret=True),
}

# Read by the code or set by the shipped files, but not something an operator sets. Each value says why.
INTERNAL: dict[str, str] = {
    "FLUX_FILES_DIR": "Set by Compose to `/data/files`, the `files` volume.",
    "FLUX_OIDC_CLIENT_SECRET_FILE": "Set by Compose to `/run/secrets/flux_oidc_client_secret`; the host file is `FLUX_OIDC_CLIENT_SECRET_HOST_FILE`.",
    "FLUX_KEYRING_URL": "How the API and worker reach the keyring; default `http://keyring:8090`.",
    "FLUX_KEYRING_PORT": "Port the keyring listens on inside its network; default `8090`.",
    "FLUX_API_INTERNAL_URL": "How the worker reaches the API inside Compose; default `http://api:8080`.",
    "FLUX_LIVEKIT_API_URL": "Set by the live-media overlay to `http://livekit:7880` on its internal network.",
    "FLUX_RUNTIME_MANAGER_URL": "How the API and worker reach the runtime manager; default `http://runtime-manager-control:7600`.",
    "FLUX_RUNTIME_MANAGER_LISTEN": "Listen address of the runtime manager.",
    "FLUX_RUNTIME_EGRESS_API": "Set by Compose: where the runtime egress proxy forwards `/mcp`.",
    "FLUX_RUNTIME_EGRESS_INSTALL_LISTEN": "Listen address of the runtime installer proxy.",
    "FLUX_RUNTIME_SLOT": "Set by Compose on each runtime slot to its own name.",
    "FLUX_RUNTIME_SLOT_SECRET": "Set by Compose on each slot from `FLUX_RUNTIME_SECRET_<n>`.",
    "FLUX_RUNTIME_SLOT_1": "Set by Compose on the runtime manager from `FLUX_RUNTIME_SECRET_1`.",
    "FLUX_RUNTIME_SLOT_2": "Set by Compose on the runtime manager from `FLUX_RUNTIME_SECRET_2`.",
    "FLUX_RUNTIME_SLOT_3": "Set by Compose on the runtime manager from `FLUX_RUNTIME_SECRET_3`.",
    "FLUX_RUNTIME_SLOT_4": "Set by Compose on the runtime manager from `FLUX_RUNTIME_SECRET_4`.",
    "FLUX_RUNTIME_INSTALL_SOURCE": "Test image only: install fake CLIs instead of the real ones.",
    "FLUX_RUN_TOKEN": "Per-run bearer the runtime gives the CLI it starts.",
    "FLUX_IMAGE_TAG": "Set by `./flux` to the Compose project, so each checkout builds its own image tag.",
    "FLUX_GIT_COMMIT": "Set by `./flux` from `git`; recorded as an image label and in backup manifests.",
    "FLUX_ROOT": "The launcher's own directory.",
    "FLUX_EXPORT_FILE": "Passed by `./flux export` to the export command inside the image.",
    "FLUX_DEMO_JSON": "Passed by `./flux demo` to the seed script.",
    "FLUX_COWORK_STATE_DIR": "State directory of the `./flux cowork` helper inside its container.",
    "FLUX_DEV_API_URL": "Set by the dev profile: where Vite proxies API requests.",
    "FLUX_UI_ORIGIN": "Browser-test profile only.",
    "FLUX_UI_UPSTREAM": "Browser-test profile only.",
    "FLUX_UI_SCREENSHOTS": "Browser-test profile only.",
    "FLUX_UI_SCREENSHOT_DIR": "Browser-test profile only.",
    "FLUX_API_URL": "Test profile only.",
    "FLUX_MAILPIT_URL": "Test profile only.",
    "FLUX_TEST_STATE_DIR": "Test profile only.",
    "FLUX_ANTHROPIC_MOCK_URL": "Browser-test profile only (mock provider).",
    "FLUX_OPENAI_MOCK_URL": "Browser-test profile only (mock provider).",
    "FLUX_LINK_MOCK_URL": "Browser-test profile only (mock site).",
    "FLUX_MOTION_SAMPLES": "Motion measurement in the browser-test profile only.",
    "FLUX_MOTION_WARMUPS": "Motion measurement in the browser-test profile only.",
    "FLUX_MOTION_SECONDS": "Motion measurement in the browser-test profile only.",
    "FLUX_MOTION_LAYOUT_SAMPLES": "Motion measurement in the browser-test profile only.",
    "FLUX_MOTION_LAYOUT_WARMUPS": "Motion measurement in the browser-test profile only.",
    "FLUX_LIVE_EDITING_TEST": "Test profile only.",
    "FLUX_DEVELOPMENT_LIVE_EDITING": "Isolated live-editing calibration only.",
    "FLUX_DEVELOPMENT_LIVE_EDITING_API_INSTANCE": "Isolated live-editing calibration only.",
    "FLUX_DEVELOPMENT_LIVE_EDITING_TELEMETRY": "Isolated live-editing calibration only.",
    "FLUX_LIVE_SOURCE_SHA": "Live-editing codec test tooling only.",
    "FLUX_CONTRACT_TMP": "Runtime contract test only.",
    "FLUX_TEST_FAILURE_INJECTION": "Test deployments only, together with `FLUX_FIXTURE_TOKEN`. Never in production.",
    "FLUX_TEST_PERSONAL_RUNS": "Test deployments only.",
    "FLUX_TEST_ANTHROPIC_URL": "Test deployments only.",
    "FLUX_TEST_LINK_PREVIEW_HOSTS": "Test deployments only; refused without `FLUX_TEST_FAILURE_INJECTION`.",
    "FLUX_TEST_ROTATION_HOLD_AFTER_PAGES": "Test deployments only.",
    "FLUX_TEST_ROTATION_PAGE_SIZE": "Test deployments only.",
    "FLUX_TEST_ROTATION_SWEEP_MS": "Test deployments only.",
    "FLUX_TEST_SWAP_ROOT": "Test deployments only.",
    "FLUX_KEYRING_REVEAL_BOOT_KEY": "Test deployments only; ignored without the test switches.",
    "FLUX_PUSH_ALLOW_PRIVATE_NETWORK": "Phone-emulation tests only: lets push reach a private test service.",
    "FLUX_OIDC_ALLOW_HTTP_ISSUER": "Isolated test identity provider only; never production.",
    "FLUX_LIVEKIT_ALLOW_INSECURE_LOCAL": "Development only; ignored when `NODE_ENV=production`.",
    "FLUX_REVERSE_0048_QUIESCED": "One-off operator tooling for a historical migration.",
}

# Names that look like settings but are constants, output markers or prefixes.
NOT_SETTINGS: dict[str, str] = {
    "FLUX_SCHEMA_VERSION": "constant: the schema version of this build",
    "FLUX_MCP_PROTOCOL_VERSIONS": "constant: supported MCP protocol versions",
    "FLUX_TOOL_NAME": "constant: pattern of Flux's MCP tool names",
    "FLUX_LIVE_QUEUE": "log marker",
    "FLUX_MIGRATION_GATE": "output marker of the operations tool",
    "FLUX_MIGRATIONS": "output marker of the operations tool",
    "FLUX_AGENT_ACCESS": "output marker of the operations tool",
    "FLUX_RUNTIME_PURGE": "output marker of the operations tool",
    "FLUX_RUNTIME_NOT_INSTALLED": "output marker of the runtime manager",
    "FLUX_GITHUB": "prefix in an error message",
    "FLUX_VAPID": "prefix in a message",
    "FLUX_RUNTIME_SECRET": "prefix of FLUX_RUNTIME_SECRET_<n>",
    "FLUX_LIVEKIT_WS_URL": "retired: the API refuses to start when it is set (browsers signal through `/media`)",
}

# Non-FLUX names the services read. They are listed for completeness; the check confirms each still appears.
OTHER_INTERNAL = {
    "DATABASE_URL": ("Set by Compose from `POSTGRES_USER`, `POSTGRES_PASSWORD` and `POSTGRES_DB`.", "docker/compose.yaml"),
    "PORT": ("Set by Compose to `8080`, the API's port inside its container.", "docker/compose.yaml"),
    "NODE_EXTRA_CA_CERTS": ("Node.js: extra CA certificates, for an SMTP server or provider with a private CA. Set it in an override "
                            "and mount the file.", "docs/development/containers.md"),
}


# Services of the test and browser-test profiles; they are not part of a deployment.
TEST_SERVICES = {"test", "ui-test", "anthropic-mock", "openai-mock", "link-mock", "mailpit"}


@dataclass
class Use:
    files: set[str] = field(default_factory=set)
    services: set[str] = field(default_factory=set)
    defaults: dict[str, str] = field(default_factory=dict)  # file -> default
    required: set[str] = field(default_factory=set)  # files that require it


def code_files() -> list[Path]:
    files = []
    for base in CODE_ROOTS:
        for path in sorted((ROOT / base).glob("*/src/**/*")):
            if path.is_file() and path.suffix in CODE_SUFFIXES and ".test." not in path.name:
                files.append(path)
    for path in sorted((ROOT / "app/tooling").rglob("*")):
        if (path.is_file() and path.suffix in CODE_SUFFIXES and ".test." not in path.name
                and "node_modules" not in path.parts and "dist" not in path.parts):
            files.append(path)
    return files


def scan_names() -> dict[str, set[str]]:
    """Every FLUX_* name and the files it appears in."""
    found: dict[str, set[str]] = {}
    paths = code_files() + [ROOT / name for name in [*COMPOSE, *OTHER_DEPLOY]]
    for path in paths:
        for match in NAME.finditer(path.read_text(encoding="utf-8", errors="replace")):
            found.setdefault(match.group(0).rstrip("_"), set()).add(str(path.relative_to(ROOT)))
    return found


def compose_uses() -> dict[str, Use]:
    """Interpolations in the shipped Compose files, with the service each one sits in."""
    uses: dict[str, Use] = {}
    for name, _kind in COMPOSE.items():
        top = service = None
        for line in (ROOT / name).read_text(encoding="utf-8").splitlines():
            if line.lstrip().startswith("#"):
                continue
            header = re.match(r"([A-Za-z][\w.-]*):", line)
            if header:
                top, service = header.group(1), None
            sub = re.match(r"  ([a-z][a-z0-9-]*):\s*$", line)
            if sub and top == "services":
                service = sub.group(1)
            for match in REFERENCE.finditer(line):
                var, kind, value = match.groups()
                use = uses.setdefault(var, Use())
                use.files.add(name)
                if service and service not in TEST_SERVICES:
                    use.services.add(service)
                elif top and top.startswith("x-runtime-slot"):
                    use.services.add("runtime-<n>")
                if kind and kind.endswith("?"):
                    use.required.add(name)
                elif kind and kind.endswith("-"):
                    use.defaults[name] = value
    return uses


def launcher_defaults() -> dict[str, str]:
    text = LAUNCHER.read_text(encoding="utf-8") + (ROOT / "docker/runtime.sh").read_text(encoding="utf-8")
    found = {}
    for match in REFERENCE.finditer(text):
        var, kind, value = match.groups()
        if var.startswith("FLUX_") and kind and kind.endswith("-") and value and "$" not in value:
            found.setdefault(var, value)
    return found


def env_template() -> dict[str, str]:
    entries = {}
    for line in ENV_EXAMPLE.read_text(encoding="utf-8").splitlines():
        if line.strip() and not line.lstrip().startswith("#"):
            key, _, value = line.partition("=")
            entries[key] = value
    return entries


def launcher_help() -> str:
    text = LAUNCHER.read_text(encoding="utf-8")
    match = re.search(r"\ncmd_help\(\) \{\n  cat <<EOF\n(.*?)\nEOF\n", text, re.S)
    if not match:
        raise SystemExit("config_reference: cannot find the help text of ./flux (cmd_help)")
    return match.group(1)


def code(value: str) -> str:
    return f"`{value}`" if value else "empty"


def default_of(name: str, var: Var, uses: dict[str, Use], launcher: dict[str, str], template: dict[str, str]) -> str:
    if var.default:
        return var.default
    use = uses.get(name)
    if use and use.required:
        release = "docker/compose.yaml"
        if release not in use.required and release in use.defaults:
            where = " + ".join(sorted({COMPOSE[file] for file in use.required}))
            return f"**required** ({where}); release: {code(use.defaults[release])}"
        return "**required**"
    if name == "FLUX_PROJECT":
        return (f"generated by `./flux up` (`flux-<directory>-<hash>`); release: {code(use.defaults.get('docker/compose.yaml', ''))}"
                if use else "generated by `./flux up`")
    values = sorted(set(use.defaults.values())) if use else []
    # `./…-unavailable` is an empty placeholder file mounted while the feature is off.
    values = ["" if value.startswith("./") else value for value in values]
    if name in launcher:
        values = sorted(set(values) | {launcher[name]})
    if len(values) == 1:
        text = code(values[0])
    elif values:
        text = " or ".join(code(value) for value in values)
    elif name in template:
        text = code(template[name])
    else:
        text = "empty"
    if var.secret and name in template and template[name] == "":
        text = "empty; generated by `./flux`" if name in GENERATED else text
    return text


GENERATED = {"POSTGRES_PASSWORD", "FLUX_AUTH_SECRET", "FLUX_FIXTURE_TOKEN", "FLUX_KEYRING_TOKEN", "FLUX_KEY_PIN_SECRET",
             "FLUX_RUNTIME_MANAGER_SECRET", "FLUX_RUNTIME_SECRET_1", "FLUX_RUNTIME_SECRET_2", "FLUX_RUNTIME_SECRET_3",
             "FLUX_RUNTIME_SECRET_4", "FLUX_DEMO_OWNER_PASSWORD", "FLUX_DEMO_PARTNER_PASSWORD", "FLUX_VAPID_PRIVATE_KEY"}


def where_of(name: str, var: Var, uses: dict[str, Use], launcher: dict[str, str], found: dict[str, set[str]]) -> str:
    if var.override:
        return f"{var.services} (override only)"
    use = uses.get(name)
    services = ", ".join(sorted(use.services)) if use and use.services else ""
    places: list[str] = []
    if use:
        for file in sorted(use.files, key=list(COMPOSE).index):
            if COMPOSE[file] not in places:
                places.append(COMPOSE[file])
    files = found.get(name, set())
    if "flux" in files and (not use or name in launcher or name in LAUNCHER_READS):
        places.append("`./flux`")
    if "docker/runtime.sh" in files and name in ("FLUX_ENV_FILE", "FLUX_WAIT_TIMEOUT"):
        places.append("`runtime.sh`")
    where = ", ".join(places)
    return f"{services} ({where})" if services else where


# Settings the launcher or the release runtime.sh reads from the shell environment or the settings file.
LAUNCHER_READS = {"FLUX_ENV_FILE", "FLUX_PROJECT", "FLUX_PORT", "FLUX_BACKUP_DIR", "FLUX_NO_CACHE", "FLUX_WAIT_TIMEOUT",
                  "FLUX_COWORK_WATCHDOG_SECONDS", "FLUX_DEV_PORT", "FLUX_MAILPIT_PORT", "FLUX_DEMO_OWNER_PASSWORD",
                  "FLUX_DEMO_PARTNER_PASSWORD", "FLUX_AGENT_RUNTIME"}


def cell(text: str) -> str:
    return text.replace("|", "\\|").replace("\n", " ")


def render() -> str:
    found = scan_names()
    uses = compose_uses()
    launcher = launcher_defaults()
    template = env_template()
    out = [
        "# Configuration reference",
        "",
        "<!-- Generated by scripts/config_reference.py from the Compose files, the launcher, docker/.env.example and the",
        "     application code. Do not edit by hand: change the code or the script's tables, then run",
        "     python3 scripts/config_reference.py. The repository check fails when this page drifts. -->",
        "",
        "Flux is configured with environment variables in one private file: `docker/.env` in a source checkout",
        "(`./flux up` creates it from [`docker/.env.example`](../../docker/.env.example) with new secrets) or `.env`",
        "beside a release's `compose.yaml`. Compose reads the file and passes each value to the services that need it.",
        "After a change, apply it with `./flux up` (source) or `docker compose --env-file .env -f compose.yaml up -d --wait`",
        "(release). A variable exported in your shell overrides the file, so do not export Flux variables on a server.",
        "Keep the file private (`chmod 600`) and keep it with your backups: it holds the database password and the",
        "secrets that cannot change.",
        "",
        "Each variable lists its type, its default, the services that receive it and where it applies:",
        "**release** is the release `compose.yaml`, **source** the source checkout's Compose file that `./flux` runs,",
        "an **overlay** an optional extra Compose file, and `./flux` the launcher itself. **Override only** means the",
        "application reads it but no shipped Compose file passes it in:",
        "add it under the service's `environment:` in `docker/compose.override.yaml`, which `./flux` includes when it",
        "exists. A wrong value stops the service at start with a message that names the variable.",
        "",
    ]
    titles = {key: title for key, title, _intro in GROUPS}
    anchor = lambda name: name.lower()
    out += ["## Settings you will probably change", ""]
    out += [f"- [`{name}`](#{anchor(name)}): {VARIABLES[name].type.replace(' · ', ', ')}" for name in COMMON]
    out += ["", "## All settings A–Z", "", "| Variable | Group | Default |", "| --- | --- | --- |"]
    for name in sorted(VARIABLES):
        var = VARIABLES[name]
        out.append(f"| [`{name}`](#{anchor(name)}) | {titles[var.group]} | {cell(default_of(name, var, uses, launcher, template))} |")
    out.append("")
    for key, title, intro in GROUPS:
        names = [name for name, var in VARIABLES.items() if var.group == key]
        out += [f"## {title}", ""]
        if intro:
            out += [intro, ""]
        for name in names:
            var = VARIABLES[name]
            effect = var.effect + (f" Example: `{var.example}`." if var.example else "")
            out += [f"### `{name}`", "",
                    f"**Type** {var.type.replace(' · ', ', ')} · **Default** {default_of(name, var, uses, launcher, template)} · "
                    f"**Used by** {where_of(name, var, uses, launcher, found)}", "", effect, ""]
    out += [
        "## Set by Flux, not by you",
        "",
        f"The services also read {len(INTERNAL) + len(OTHER_INTERNAL)} names that Compose, the launcher or the code sets: wiring",
        "between services and test switches. Do not set them. They are listed for developers in",
        "[internal configuration names](../development/configuration-internal.md).",
    ]
    out += [
        "",
        "## Launcher commands",
        "",
        "`./flux help` in a source checkout prints this list; it is copied here from the launcher. The",
        "[operations overview](README.md) links each command to its guide.",
        "",
        "```text",
        launcher_help().rstrip(),
        "```",
        "",
    ]
    return "\n".join(out)


def render_internal() -> str:
    out = [
        "# Internal configuration names",
        "",
        "<!-- Generated by scripts/config_reference.py. Do not edit by hand. -->",
        "",
        "Names the Flux services read that operators do not set: Compose, the launcher or the code sets them, or",
        "they turn on test behaviour. They are listed so that every `FLUX_*` name in the code is accounted for; the",
        "operator settings are in the [configuration reference](../operations/configuration.md). Changing one breaks",
        "the wiring between services or enables test-only code.",
        "",
        "| Variable | Why it exists |",
        "| --- | --- |",
    ]
    for name, (why, _source) in OTHER_INTERNAL.items():
        out.append(f"| `{name}` | {cell(why)} |")
    for name in sorted(INTERNAL):
        out.append(f"| `{name}` | {cell(INTERNAL[name])} |")
    out += ["", "Names in the code that are not settings at all:", "", "| Name | What it is |", "| --- | --- |"]
    for name in sorted(NOT_SETTINGS):
        out.append(f"| `{name}` | {cell(NOT_SETTINGS[name])} |")
    out.append("")
    return "\n".join(out)


def problems() -> list[str]:
    found = scan_names()
    uses = compose_uses()
    launcher = launcher_defaults()
    template = env_template()
    known = set(VARIABLES) | set(INTERNAL) | set(NOT_SETTINGS)
    errors = []
    for name in sorted(set(found) - known):
        errors.append(f"{name} appears in {', '.join(sorted(found[name]))} but is not in scripts/config_reference.py "
                      "(VARIABLES for an operator setting, INTERNAL or NOT_SETTINGS otherwise)")
    for name in sorted(n for n in known if n.startswith("FLUX_") and n not in found):
        errors.append(f"{name} is in scripts/config_reference.py but no longer appears in the code or the shipped files")
    for name in sorted(n for n in VARIABLES if not n.startswith("FLUX_")):
        if name not in template and name not in uses:
            errors.append(f"{name} is in scripts/config_reference.py but not in docker/.env.example or a Compose file")
    for name, (_why, source) in OTHER_INTERNAL.items():
        if name not in (ROOT / source).read_text(encoding="utf-8"):
            errors.append(f"{name} no longer appears in {source}")
    for name in sorted(template):
        if name not in VARIABLES:
            errors.append(f"{name} is in docker/.env.example but not an operator setting in scripts/config_reference.py")
    for name, use in sorted(uses.items()):
        if name in INTERNAL or name in VARIABLES or not name.startswith("FLUX_"):
            continue
        errors.append(f"{name} is interpolated in {', '.join(sorted(use.files))} but not in scripts/config_reference.py")
    for name, var in VARIABLES.items():
        reachable = name in uses or name in template or name in launcher or name in LAUNCHER_READS
        if var.override and reachable and name in uses:
            errors.append(f"{name} is marked override only, but {', '.join(sorted(uses[name].files))} passes it in now")
        if not var.override and not reachable:
            errors.append(f"{name} is read by the code, but no Compose file, launcher or template passes it in: wire it "
                          "through Compose, or mark it override=True with its services and default")
        if var.override and not (var.services and var.default):
            errors.append(f"{name} is override only and needs `services` and `default` in scripts/config_reference.py")
        if var.group not in {key for key, _title, _intro in GROUPS}:
            errors.append(f"{name} has unknown group {var.group}")
    for page, expected in ((PAGE, render()), (INTERNAL_PAGE, render_internal())):
        current = page.read_text(encoding="utf-8") if page.exists() else ""
        if current != expected:
            errors.append(f"{page.relative_to(ROOT)} is not what the code generates: run python3 scripts/config_reference.py")
    return errors


def main(argv: list[str]) -> int:
    if argv[1:] == ["--check"]:
        errors = problems()
        for error in errors:
            print(f"config_reference: {error}", file=sys.stderr)
        if not errors:
            print(f"config_reference: {PAGE.relative_to(ROOT)} matches the code ({len(VARIABLES)} settings, "
                  f"{len(INTERNAL) + len(OTHER_INTERNAL)} internal names)")
        return 1 if errors else 0
    if argv[1:]:
        print(__doc__.strip().splitlines()[0], file=sys.stderr)
        return 2
    PAGE.write_text(render(), encoding="utf-8")
    INTERNAL_PAGE.write_text(render_internal(), encoding="utf-8")
    remaining = [error for error in problems() if "is not what the code generates" not in error]
    for error in remaining:
        print(f"config_reference: {error}", file=sys.stderr)
    print(f"config_reference: wrote {PAGE.relative_to(ROOT)} and {INTERNAL_PAGE.relative_to(ROOT)}")
    return 1 if remaining else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
