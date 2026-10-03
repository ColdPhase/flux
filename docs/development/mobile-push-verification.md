# Disposable phone PWA and real-provider verification fixture (#232)

This implements the accepted [#232](https://github.com/ColdPhase/flux/issues/232)
verification slice. [#20](https://github.com/ColdPhase/flux/issues/20) retains
ownership of physical Android/iPhone/iPad acceptance under
[MOB-1–MOB-7](../product/mobile-pwa.md). #63 and #151 still need the integrated
mobile journeys. A provider's accepted HTTP send does not prove OS display.

## Boundary to review before public use

The fixture builds the **exact clean worktree HEAD**, labels the image with that
full SHA, records its immutable local image ID and uses that ID in its separate
Compose project. Tooling mounts come from that same clean checkout. It creates
only two synthetic `example.test` accounts through ordinary sign-up, an ordinary
workspace/project, a recipient-authored conversation and at most 40 uniquely
marked producer replies. No production volume/configuration is imported.

Initialization generates new database/auth secrets, two passwords and P-256
VAPID keys inside a digest-pinned Node container. State is a private, owned,
nonsymlinked `/tmp/flux-mobile-push-NAME` directory (0700; files 0600). Bind mounts
use shared SELinux labels because the gateway and finite helper containers read
the same fixture state; a helper must not relabel it with a different private
container label while the gateway is running. Directory/file permissions remain
private. Never
attach `secrets.json`, `fixture.env`, `operator.md`, raw build/container/tunnel
logs, cookies, full push endpoints or keys to GitHub. Inspect only the allowlisted
`inspection.json`, `provider-results.jsonl`, HTTPS checks and reviewed evidence.

The API and PostgreSQL have **no published ports**. Only the closed-by-default
gateway binds `127.0.0.1:PORT`. The gateway accepts the exact configured Host,
rejects public sign-up/provider/admin/upload paths, limits requests (240/minute),
connections (64), concurrent HTTP requests (24), request bodies (1 MiB) and
timeouts. It forwards ordinary HTTP and the authenticated Flux WebSocket;
the application retains Origin, current-access/session, authentication rate and
public-only provider DNS/TLS checks. Test failure injection, test personal runs,
fixture credentials, private push endpoints and custom TLS roots are disabled.
No mail or agent/provider credentials are configured. This fixture intentionally
does not certify files, email, agent or broader integrated mobile journeys.

Containers have CPU/memory/PID/log limits. Public gateway access lasts at most
two hours, never beyond the original four-hour fixture lease, and closing/expiry
also disconnects active HTTP/WebSocket clients. Containers and volumes are removed
by `down`; private evidence is retained for review and then explicitly deleted by
its owner. Stop/clean up on any unexpected exposure or secrets in output.

## Closed local preflight (Docker slot required)

The coordinator checkpoints the completed implementation first. Do not run this
against a dirty worktree or substitute an old application's image. Choose unused
ports and a fresh state name; all commands below execute application/tooling in
Docker. Build/start logs stay private. Host `bash -n` and `git diff --check` are
structural checks, not application evidence.

```sh
candidate=$(git rev-parse HEAD)
state=/tmp/flux-mobile-push-232-a
./scripts/mobile_push_fixture.sh init "$candidate" "$state" 8232
./scripts/mobile_push_fixture.sh check "$state"
./scripts/mobile_push_fixture.sh build "$state"
./scripts/mobile_push_fixture.sh up "$state"
./scripts/mobile_push_fixture.sh seed "$state"
./scripts/mobile_push_fixture.sh probe "$state"
./scripts/mobile_push_fixture.sh reply "$state" local-generator
./scripts/mobile_push_fixture.sh inspect "$state"
./scripts/mobile_push_fixture.sh matrix "$state"
```

The gateway is still closed. Inspect the private start/build log after a failed
command without copying credentials. `probe` verifies ordinary wrong-origin and
private-endpoint rejection, unavailable fixture-command credentials and configured
VAPID. The first inspection must find the reply event and inbox item whose target
matches its unique marker/message. It has no push job until a real browser has
subscribed. Poll after worker processing; absent evidence is unverified. The
inspection uses parameterized **read-only** database queries, without publishing
PostgreSQL or modifying events, jobs, subscriptions or account records.

For local normal-browser inspection only:

```sh
./scripts/mobile_push_fixture.sh open-local "$state"
```

Read the private `operator.md` locally to sign in as the recipient. Do not reuse
its credentials elsewhere. Loopback HTTP is suitable for local development and
does not establish phone-reachable trusted HTTPS.

## Trusted HTTPS, after independent review of this boundary

Prefer an already authorized HTTPS test origin routed only to this fixture.
Otherwise an official, digest-pinned `cloudflare/cloudflared` container can provide
a temporary testing origin without purchasing an account/service. The exact image
digest must be resolved and recorded during the granted Docker session; no mutable
tag is accepted by the wrapper. On 2026-10-03 the official
[Quick Tunnel documentation](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
(updated 2026-09-30) describes account-free temporary HTTPS, stopping with the
process, no uptime guarantee, 200 in-flight requests and no SSE. Flux's stream uses
WebSocket; its behavior through the tunnel still needs live verification. The
testing URL grants public reachability; keep the reviewed gateway controls active.

The following command starts **only after the reviewer accepts the concrete
candidate/boundary**, in a separate terminal/session, while the gateway is closed:

```sh
./scripts/mobile_push_fixture.sh tunnel "$state" \
  cloudflare/cloudflared@sha256:REPLACE_WITH_VERIFIED_OFFICIAL_DIGEST "$candidate"
```

Launch the foreground tunnel in a yielded terminal/tool session, then poll that
session with waits of at most 60 seconds and continue commentary. Do not block a
tool call for its full two-hour lifetime. The gateway remains closed until the
separate origin step; the timeout terminates the attached Docker process and the
`down` command explicitly removes the named tunnel container even after an
interrupted terminal. An exit/signal trap removes the named tunnel container and
closes the gateway; `down` is the recovery path if the wrapper itself is killed.
Gateway expiry remains the independent traffic fence.

Read the generated HTTPS origin from private `tunnel.log`. The same live tunnel
remains running while another terminal prepares its origin:

```sh
./scripts/mobile_push_fixture.sh open-https "$state" \
  https://REPLACE_WITH_ACTUAL.trycloudflare.com "$candidate"
```

The wrapper closes the gateway, changes the API/worker public origin, waits for
the recreated application, then opens and verifies trusted TLS without ignoring
certificate errors, health, manifest identity/start URL, service worker and
anonymous-session rejection. Failure closes it again. Save exact SHA, image ID,
origin, tunnel image digest, source dates and HTTPS evidence. A changing tunnel
hostname requires a new fixture once devices subscribed; do not silently migrate
an installed PWA to another origin. The tunnel runner stops after two hours.

## Real devices and evidence

On each available physical Android/iPhone/iPad record device model, OS/build,
browser/version, date, network, orientation and consent/settings state. Verify TLS
in the supported browser. Install from that browser, launch standalone, sign in
as the synthetic recipient, open notification settings and press **Turn on
notifications**. On iPhone/iPad first add to Home Screen and launch from there.
Never dismiss certificate warnings, install a trust root or wipe a device.

```sh
./scripts/mobile_push_fixture.sh inspect "$state"
./scripts/mobile_push_fixture.sh reply "$state" android-background
./scripts/mobile_push_fixture.sh inspect "$state"
./scripts/mobile_push_fixture.sh worker-results "$state"
```

The worker result records only hashed job/subscription aliases, outcome and provider
HTTP status; the inspection preserves only provider **origin**, status/timestamps
and synthetic message/inbox targets. Verify exactly one notification while the
app is backgrounded, closed and locked, then tap it and compare the actual target
with `expectedTarget`. Repeat ordinary mute/unmute and device **Turn off** flows.

Helpers `mute`/`unmute`, `deny`/`restore`, `unsubscribe device-N` and `revoke
device-N` use normal user APIs on the fixture records. Inspect first to identify
the exact device alias. Server-only `unsubscribe` deletes a Flux row; the browser
can synchronize its still-existing subscription on a later launch, so this is not
evidence of the UI's permanent device opt-out. UI opt-out must remove both browser
and server subscription. Revocation must stop delivery and tapping old activity
must recheck the ended session/access. Recovery uses actual login/consent UI;
do not fabricate a subscription or expire rows directly in PostgreSQL.

Save each observable case as a private file (0600; at most 64 MiB). Record it with
exact versions, for example:

```sh
./scripts/mobile_push_fixture.sh record "$state" android background-display \
  pass android-background.png 'DEVICE MODEL; Android EXACT; Chrome EXACT'
./scripts/mobile_push_fixture.sh matrix "$state"
./scripts/mobile_push_fixture.sh close "$state"
./scripts/mobile_push_fixture.sh down "$state"
```

The matrix retains evidence digests and defaults every inaccessible platform/case
to **unverified** with a next action. A desktop browser's genuine provider
subscription/send may be additional transport evidence under `desktop-provider`;
automated permission settings, headless/windowed containers and emulated viewports
cannot establish physical Android/iPhone/iPad installation, consent or OS display.
MOB-1–MOB-7 still require the complete independent integrated acceptance matrix.

## Optional actual desktop provider transport

On 2026-10-03 the official
[Selenium Docker project](https://github.com/SeleniumHQ/docker-selenium) publishes
Google Chrome standalone containers. The browser is a possible free additional
software check, with its actual subscription endpoint and provider; successful
registration/outbound connectivity is still an observation to obtain, not an
assumption. Resolve a stable official Chrome image to a digest in the granted
Docker session. The fixture refuses mutable tags, publishes no Grid/VNC ports,
limits it to one session with a 300-second idle timeout and leaves Chrome
component updates disabled. It does not import an existing browser profile.

After HTTPS verification:

```sh
./scripts/mobile_push_fixture.sh desktop-subscribe "$state" \
  selenium/standalone-chrome@sha256:REPLACE_WITH_VERIFIED_OFFICIAL_DIGEST
./scripts/mobile_push_fixture.sh inspect "$state"
./scripts/mobile_push_fixture.sh reply "$state" desktop-provider
./scripts/mobile_push_fixture.sh worker-results "$state"
./scripts/mobile_push_fixture.sh desktop-notifications "$state"
./scripts/mobile_push_fixture.sh desktop-stop "$state"
```

The helper signs the synthetic recipient in through the normal browser API,
clicks Flux's real notification button, accepts only an actual browser-returned
subscription and then leaves the browser on `about:blank` while the ordinary
producer sends. It configures notification permission through a Chrome preference;
record that automated consent plainly. It never grants certificate exceptions,
replaces Push APIs or fabricates a provider endpoint. `desktop-notifications`
checks browser service-worker notification tags, exporting only hashed aliases;
match these to `inspection.json`. This establishes neither a real phone nor
visible OS/locked display. A failed provider subscription stays unverified. Stop
revokes only the fixture browser session and closes its WebDriver session; `down`
removes the optional container along with the stack.

## Current checkpoint

Prepared from main `085214c6c58e265d1d19b2c56a12368a370ed24f` on the #232
owner branch. No accessible attached Android/Apple phone, configured remote-device
session or approved phone-reachable origin was found in the 2026-10-03 audit.
The human device clarification and serialized Docker grant are pending. These
are remaining inputs; no fixture/application/device check is claimed here.
