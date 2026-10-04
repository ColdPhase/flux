# Disposable phone PWA and real-provider verification fixture (#232)

This implements the accepted [#232](https://github.com/ColdPhase/flux/issues/232)
verification slice. [#20](https://github.com/ColdPhase/flux/issues/20) retains
ownership of physical Android/iPhone/iPad acceptance under
[MOB-1–MOB-7](../product/mobile-pwa.md). #63 and #151 still need the integrated
mobile journeys. A provider's accepted HTTP send does not prove OS display.

## Real-device session (one command)

Run this on a clean checkout of `main` with Docker running. It works with the
macOS system bash and on Linux. It needs `git`, `curl` and Docker; no Node,
PostgreSQL or cloud account on the host:

```sh
git switch main && git pull --ff-only
./scripts/mobile_push_fixture.sh session          # optional loopback port, default 8232
```

The command refuses any commit that is not on `origin/main`. Merged commits have
passed the independent boundary review; other commits use the manual
[tunnel](#manual-https-for-reviewing-a-branch) steps instead. It runs these steps:

1. Creates a private `/tmp/flux-mobile-push-session-…` state directory (0700).
2. Runs the fixture tests in Docker without network.
3. Builds the commit's image.
4. Starts PostgreSQL, migrations, the API, the worker and a **closed** gateway.
5. Signs up two synthetic accounts and seeds a conversation.
6. Checks that the API refuses private endpoints and foreign origins.
7. Starts a Cloudflare Quick Tunnel to the gateway.
8. Recreates the API and worker at the tunnel's HTTPS origin and opens the gateway.
9. Verifies trusted TLS, the manifest identity, the service worker and refusal of
   anonymous users.

It then prints the origin and waits. Press **Ctrl-C** to close the tunnel and the
gateway. The fixture then saves the evidence matrix and removes its containers,
volumes and candidate image. Access ends after two hours at most.

The recipient's email and password are in the private `operator.md` (`cat` it in
a second terminal). The password is four groups of five characters, so you can
type it on a phone. Never paste it into GitHub. Everyone who reaches the API
through the tunnel shares one address, so its sign-in rate limit applies to all
devices together (about 3 attempts per 10 seconds). Sign in on one device at a
time and wait a few seconds after a refusal.

Do the following on each device:

1. **Android:** open the origin in Chrome and use *Install app*. **iPhone/iPad:**
   open it in Safari, choose Share → *Add to Home Screen*, and launch Flux from the
   icon. Web Push on iOS works only in the installed app.
2. Sign in as the recipient and open **Settings → Notifications**. Press
   **Turn on notifications** and allow them.
3. In the second terminal, run `inspect "$state"`. Each subscribed device appears
   as `device-N`.
4. Send a background, closed or locked test: put the app in that state and run
   `reply "$state" <platform>-<case>` (for example `iphone-locked`). Exactly one
   notification should appear. Tap it and compare the screen with the reply's
   `expectedTarget`.
5. Check the provider status: `worker-results "$state"` saves sanitized results.
   `inspect` shows the inbox, job and device aliases.
6. Record each observation. AirDrop or copy the photo or screen recording into
   the state directory and make it private (`chmod 600`). Then run:
   `record "$state" iphone locked-display pass IMG_0042.jpg 'MODEL; iOS X.Y; Safari X.Y'`.
   Use `fail` when the expected result does not happen. Leave a case unrecorded
   (it stays `unverified`) when you could not observe it.
7. Use `mute`, `unmute`, `unsubscribe device-N`, `revoke device-N`, `deny` and
   `restore` for the opt-out, revocation and access-removal cases (see
   [Real devices and evidence](#real-devices-and-evidence)).

The matrix has 13 cases for each platform: `installation`, `cold-launch`,
`background-display`, `locked-display`, `tap-target`, `mute`, `unsubscribe`,
`revoke`, `recovery`, `permission-denied`, `offline`, `touch` and `accessibility`.
The platforms are `android`, `iphone`, `ipad` and `desktop-provider`.

An installed PWA belongs to the tunnel's origin, and each session gets a new
origin. Finish every device case within one session. Remove the home-screen icon
afterwards. The state directory keeps the credentials and evidence; delete it
with `rm -rf` once the evidence is copied to the issue.

## Boundary to review before public use

The fixture builds the **exact clean worktree HEAD**. It labels the image with
that full SHA, records the image's immutable local ID and runs that ID in its own
Compose project. Tooling mounts come from the same clean checkout. The fixture
uses no production volume or configuration. It creates only:

- two synthetic `example.test` accounts, through ordinary sign-up;
- an ordinary workspace and project;
- a conversation started by the recipient;
- at most 40 uniquely marked replies from the producer.

Initialization runs inside a digest-pinned Node container. It generates new
database and auth secrets, two passwords and a P-256 VAPID key pair. State lives
in a private, owned, non-symlinked `/tmp/flux-mobile-push-NAME` directory (0700;
files 0600). The bind mounts use shared SELinux labels because the gateway and the
short-lived helper containers read the same state. A helper must not relabel the
state with a private container label while the gateway runs. The permissions stay
private either way. Docker Desktop on macOS passes the owner and mode through
unchanged; the helper checks both.

Never attach any of these to GitHub:

- `secrets.json`, `fixture.env` or `operator.md`;
- raw build, container or tunnel logs;
- cookies, full push endpoints or keys.

For review, use only the allowlisted `inspection.json` and
`provider-results.jsonl`, the HTTPS checks and the recorded evidence.

The API and PostgreSQL have **no published ports**. Only the gateway binds a host
port, `127.0.0.1:PORT`, and it starts closed. The tunnel container joins the
fixture's network and forwards only to `gateway:8080`. The gateway:

- accepts only the configured Host;
- refuses public sign-up, password reset, OAuth and provider routes, agent, MCP and
  GitHub routes, file and upload paths, and media;
- limits requests to 240 a minute, connections to 64, concurrent HTTP requests to
  24 and request bodies to 1 MiB, with request timeouts;
- forwards ordinary HTTP and the authenticated Flux WebSocket only.

It strips forwarding headers. Behind it, the application keeps its Origin,
current access, session and authentication rate checks. Push still resolves
provider DNS to public addresses only and verifies their TLS.

The fixture disables:

- test failure injection, test personal runs and fixture credentials;
- private push endpoints and custom TLS roots.

It configures no mail, agent or provider credentials. It deliberately does not
certify files, email, agents or the broader integrated mobile journeys.

Containers have CPU, memory, PID and log limits. Public access through the gateway
lasts at most two hours and never outlives the original four-hour fixture lease.
Closing or expiry also disconnects active HTTP and WebSocket clients. `down` (and
the end of `session` or `preflight`) removes the containers, volumes, network,
tunnel and candidate image. It keeps the private state directory for review; its
owner deletes it afterwards. If anything is exposed unexpectedly or secrets
appear in output, stop and clean up immediately.

## Closed local preflight

This runs the same build and seed on loopback only, with no public access, then
removes everything:

```sh
./scripts/mobile_push_fixture.sh preflight 8232
```

It runs these checks:

- The gateway answers 503 while it is closed.
- After `open-local`, health, the manifest and the service worker load.
- An anonymous `/api/v1/me` returns 401.
- Sign-up and file routes return 403, and a foreign Host returns 421.
- A producer reply creates the recipient's inbox item.

The individual steps are also available:

```sh
candidate=$(git rev-parse HEAD)
state=/tmp/flux-mobile-push-232-a
./scripts/mobile_push_fixture.sh check
./scripts/mobile_push_fixture.sh init "$candidate" "$state" 8232
./scripts/mobile_push_fixture.sh build "$state"
./scripts/mobile_push_fixture.sh up "$state"
./scripts/mobile_push_fixture.sh seed "$state"
./scripts/mobile_push_fixture.sh probe "$state"
./scripts/mobile_push_fixture.sh reply "$state" local-generator
./scripts/mobile_push_fixture.sh inspect "$state"
./scripts/mobile_push_fixture.sh open-local "$state"
./scripts/mobile_push_fixture.sh down "$state"
```

`probe` checks that the API refuses a private endpoint and a foreign origin, that
fixture commands have no credentials, and that VAPID is configured. The first
inspection must find the reply's event and inbox item, with a target that matches
the unique marker. There is no push job until a real browser has subscribed.
`inspect` uses parameterized **read-only** database queries. It does not publish
PostgreSQL or modify events, jobs, subscriptions or accounts. After `open-local`,
read the private `operator.md` to sign in from this computer's browser. Loopback
HTTP is for local development; it does not give phones a trusted HTTPS origin.

## Manual HTTPS for reviewing a branch

Before a change merges, its exact SHA can be exposed only after an independent
reviewer accepts that candidate and boundary. The reviewer names the SHA, and the
wrapper refuses any other. An official, digest-pinned `cloudflare/cloudflared`
container provides a temporary HTTPS origin without an account. The wrapper
accepts no mutable tag.

The pinned image is `cloudflare/cloudflared:2026.9.3`. It is an amd64/arm64 index,
read from the Docker Hub tag API on 2026-10-04. Cloudflare's
[Quick Tunnel documentation](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
(updated 2026-09-30, read 2026-10-03) says Quick Tunnels:

- give account-free temporary HTTPS that stops with the process;
- carry no uptime guarantee;
- allow 200 in-flight requests;
- do not support SSE.

Flux's stream uses a WebSocket. The testing URL makes the fixture publicly
reachable, so keep the reviewed gateway controls on. In one terminal, with the
gateway closed:

```sh
./scripts/mobile_push_fixture.sh tunnel "$state" \
  cloudflare/cloudflared@sha256:072c067d25ccbe61d46e18f0d0723255f2bb5304f7317caa95b27031520ff92c "$candidate"
```

The command stays in the foreground for at most two hours. Ctrl-C, or the end of
the lease, removes the tunnel container and closes the gateway. If the wrapper
itself is killed, `down` recovers. Gateway expiry stays an independent traffic
fence. Read the generated origin from the private `tunnel.log`, then in another
terminal:

```sh
./scripts/mobile_push_fixture.sh open-https "$state" \
  https://REPLACE_WITH_ACTUAL.trycloudflare.com "$candidate"
```

The wrapper closes the gateway, changes the API and worker public origin, and
waits for the recreated application. It then opens the gateway and verifies,
without ignoring certificate errors:

- trusted TLS and health;
- the manifest identity and start URL;
- the service worker;
- refusal of an anonymous session.

A failure closes the gateway again. Save the exact SHA, image ID, origin, tunnel
image digest, source dates and HTTPS evidence. Once devices have subscribed, a
changed tunnel hostname requires a new fixture. Do not silently move an installed
PWA to another origin.

## Real devices and evidence

For each physical device, record:

- model, OS and build, browser and version;
- the date, network and orientation;
- the consent and settings state.

Verify TLS in the supported browser. Never dismiss certificate warnings, install a
trust root or wipe a device.

```sh
./scripts/mobile_push_fixture.sh inspect "$state"
./scripts/mobile_push_fixture.sh reply "$state" android-background
./scripts/mobile_push_fixture.sh inspect "$state"
./scripts/mobile_push_fixture.sh worker-results "$state"
```

The worker results record only hashed job and subscription aliases, the outcome
and the provider's HTTP status. The inspection keeps only the provider **origin**,
statuses and timestamps, and the synthetic message and inbox targets.

Verify exactly one notification while the app is in the background, closed and
locked. Tap it and compare the actual screen with `expectedTarget`. Repeat with
the ordinary mute and unmute and with the device's **Turn off** button.

The helpers `mute`/`unmute`, `deny`/`restore`, `unsubscribe device-N` and
`revoke device-N` call normal user APIs on the fixture's records. Run `inspect`
first to find the exact device alias.

- `unsubscribe` deletes only the server row. The browser can sync its still-active
  subscription on a later launch, so this is not evidence of the UI's permanent
  opt-out. The UI opt-out must remove both the browser and the server
  subscription.
- After a revocation, delivery must stop. Tapping old activity must recheck the
  ended session and access.
- Recovery uses the real sign-in and consent UI. Do not fabricate a subscription
  or expire rows directly in PostgreSQL.

Save each observed case as a private file (0600, at most 64 MiB). Record it with
the exact versions, for example:

```sh
./scripts/mobile_push_fixture.sh record "$state" android background-display \
  pass android-background.png 'DEVICE MODEL; Android EXACT; Chrome EXACT'
./scripts/mobile_push_fixture.sh matrix "$state"
```

The matrix keeps the evidence digests. Each platform and case not recorded stays
**unverified** with a next action. A desktop browser's genuine provider
subscription and send can be extra transport evidence under `desktop-provider`.

The following cannot establish physical Android, iPhone or iPad installation,
consent or OS display:

- automated permission settings;
- headless or windowed containers;
- emulated viewports.

MOB-1–MOB-7 still require the complete independent integrated acceptance matrix.

## Optional desktop provider transport

The official [Selenium Docker project](https://github.com/SeleniumHQ/docker-selenium)
publishes Google Chrome standalone containers. The default is
`selenium/standalone-chrome:153.0` (Chrome 153.0.8010.47), pinned by its
amd64/arm64 index digest `sha256:7efe71e7e4a83bdf574b26bd354690928075e8f443223d2ced16a2c208eae1d7`
(Docker Hub tag API, 2026-10-04). This free extra software check uses the
browser's real subscription endpoint and provider. Whether registration and
outbound connectivity succeed is an observation to make, not an assumption.

The fixture limits the browser container:

- It refuses mutable tags and publishes no Grid or VNC ports.
- It runs one session with a 300-second idle timeout.
- Chrome component updates stay off, and no existing browser profile is imported.

After HTTPS verification:

```sh
./scripts/mobile_push_fixture.sh desktop-subscribe "$state"
./scripts/mobile_push_fixture.sh inspect "$state"
./scripts/mobile_push_fixture.sh reply "$state" desktop-provider
./scripts/mobile_push_fixture.sh worker-results "$state"
./scripts/mobile_push_fixture.sh desktop-notifications "$state"
./scripts/mobile_push_fixture.sh desktop-stop "$state"
```

The helper:

1. signs the synthetic recipient in through the normal browser API;
2. clicks Flux's real notification button;
3. accepts only a subscription the browser actually returns;
4. leaves the browser on `about:blank` while the ordinary producer sends.

It sets notification permission through a Chrome preference; record that the
consent was automated. It never grants certificate exceptions, replaces Push
APIs or fabricates a provider endpoint.

`desktop-notifications` checks the service worker's notification tags and
exports only hashed aliases; match them to `inspection.json`. This proves neither
a real phone nor a visible OS or lock-screen display. A failed provider
subscription stays unverified.

`desktop-stop` revokes only the fixture's browser session and closes its
WebDriver session. `down` removes the optional container with the rest of the
stack.

## Current checkpoint

Checkpoint date: 2026-10-04. The takeover branch merges `main` at `662aec62`.

**Author-reported at `6b631164` (Hubert, PR #233).** These results were not rerun
here:

- A genuine Chrome 153 FCM subscription was made over a Quick Tunnel.
- The provider returned HTTP 201 for one reply event, inbox item and push job.
- The browser's service-worker notification tag matched that inbox item.

That is desktop software evidence with automated consent. Earlier failures stay
on record:

- the provider refusal caused by the mapped-address bug, fixed in
  [public-push-lookup.md](public-push-lookup.md);
- a browser-inspection timeout;
- a login rate-limit refusal;
- a startup and migration failure.

The fixed source, the Docker tests, the macOS preflight and the takeover's
reviewer sign-off are recorded in the PR at the head they ran against. No public
tunnel was opened at that head; `session` opens one only after the merge.

**Physical devices: not verified.** No Android, iPhone or iPad session has run:
installation, display in the background and on the lock screen, taps, opt-out,
revocation and recovery are all unverified. These rows need Maurycy with the
devices, through `session` above. #20, #63 and #151 and the integrated release
acceptance stay open.
