# Live sessions: implementation checkpoint (#61)

The optional self-hosted media adapter uses LiveKit server `v1.13.7` by image
digest and `livekit-server-sdk` `2.19.1`. The normal Flux application starts
without media configuration. `docker/compose.live.yaml` adds an operator-owned
SFU and gives the API its private address and signing key. Browsers never get
the SFU address: they signal through the Flux API at `<FLUX_PUBLIC_ORIGIN>/media`
([media admission](#media-admission-and-session-end-128)). The SFU's signaling
and room-service port is reachable only by the API over an internal network;
ICE/TURN ports need direct network reachability. No recording, egress or
transcription service is enabled. The profile currently exposes embedded TURN/UDP only; TURN/TLS and
restrictive-network acceptance remain in [#63](https://github.com/ColdPhase/flux/issues/63).

## Current behavior

- A human can start a session at an existing project conversation, work item,
  project sketch or wiki doc, get it by opaque ID, request a room-scoped grant and send a
  versioned object reference without copying a title or body into the media
  trace. The API rechecks project access; durable starts and presentations have
  caller-provided idempotency IDs. Private sketches cannot anchor a project
  session. The SFU participant list is queried for actual connected people; a
  failed query appears as unknown rather than zero people.
  A wiki doc anchor uses the existing project material ID only when its kind is
  `doc`; every admission and recipient read checks current project access and
  the anchor again. A regular project material cannot impersonate a doc.
- `POST /api/v1/live-sessions/:id/leave` disconnects this device: it revokes the admissions
  of the caller's **current** authentication session (the request's cookie session) to that
  live session and removes exactly their participants (#128). The same person's other tab
  or device stays connected; there is no all-device leave. A repeated leave returns `204`
  after the SFU confirms those participants are absent; joining again issues a new admission.
  Device capture and playback remain client actions; receiving a grant never
  enables a microphone, camera or screen by itself.
- Starts are capped at eight non-ended sessions per project and three per
  creator. A room that never gets a connected participant has a five-minute
  grace period; after everyone departs, the empty grace is 90 seconds. Durable
  `ending` state fences admission before room deletion. Signed LiveKit webhooks
  only prompt reconciliation; a periodic SFU occupancy sweep and startup
  recovery provide the independent path. A room that disappears cannot be
  recreated by an old join request or old token. If an available session's
  room is confirmed missing after an SFU restart, a join marks only that
  session rotating under a project admission fence, retires its old room ID,
  creates a fresh generation and retries
  under current project and anchor authorization. An uncertain SFU response
  leaves admission closed; startup and periodic recovery finish a durable
  fence before joins resume.
- A person may invite another authorized project reader. The invitation stores
  only identities, response choice and dates. The recipient's bounded,
  encrypted-cursor inbox rechecks project and anchor access on every page;
  replying `later` or `text` never sends a message on the person's behalf.
  A new invitation row (never a repeated invite) commits `project.live_invited.v1`
  with identifiers only; the notification worker turns it into one quiet `invitation`
  inbox item for the recipient (inbox and push by default, no email, no ringing) that
  opens `/projects/:p/live/:session?invitation=:id`. If the recipient lost project
  access, answered, or the session stopped being available before generation, nothing
  is created ([notifications](notifications.md)).
- Signing out, revoking a session and resetting a password end that session's media
  connection and make its original and SFU-refreshed grants useless; see
  [media admission and session end](#media-admission-and-session-end-128).
- `POST /api/v1/live-sessions/:id/join` allows at most 20 attempts per person per
  rolling 60 seconds **per API instance** (in-memory, created in the composition
  root; bounded to 10,000 tracked people). Beyond that it answers
  `429 LIVE_JOIN_RATE_LIMITED` with `Retry-After`. With several API replicas the
  effective limit multiplies; it guards against runaway clients, not abuse at scale.
- `GET /api/v1/projects/:projectId/live-sessions` lists currently readable,
  available sessions in bounded pages. The server rechecks each session's
  project and anchor before returning it. The response contains opaque session
  and context identifiers but no room name or source text; an SFU failure makes
  participant presence unknown.
- The `GET /api/v1/live-sessions/capabilities` response says `configured` when
  the required media variables are present. This does not certify reachability,
  DNS/TLS, ICE, relay fallback or receiver quality.
- Grant, role and membership changes affecting an active room use a durable
  admission fence. New joins stop before the old SFU room is deleted; the access
  mutation succeeds only after the old room is absent, and remaining authorized
  people receive a new room generation. A failed SFU deletion leaves admission
  fenced for retry; startup and a periodic 10-second pass reconcile the fence.
  If the API has no LiveKit configuration while a durable room is available or
  rotating, these access changes return `503 LIVE_MEDIA_UNAVAILABLE` without
  changing policy. Ordinary work and conversation endpoints remain available.

The LiveKit operator configuration must keep `room.auto_create=false`, as both
Compose profiles do. Otherwise an unexpired or SFU-refreshed old token could
recreate a retired room. Room-service calls have a five-second request timeout;
an unreachable SFU returns no grant and cannot trigger room-loss rotation.
An unrelated pending ending room can delay recovery under the workspace lock;
admission remains fenced until the SFU confirms deletion.
Other sessions in that project pause admission briefly while a missing room
rotates, but keep their room IDs and generations.

The project and anchor are checked again for GET, JOIN and presentation. A
project sketch cannot be changed into a private sketch while its live session
references it under the current schema; any future scope-change API must also
retire existing media grants before changing that scope.

## Media admission and session end (#128)

Decided in [#128](https://github.com/ColdPhase/flux/issues/128) (design comment of
2026-09-29, sources `livekit-client` v2.17.2 and `livekit-server` v1.13.7). A self-hosted
LiveKit JWT stays valid after `RemoveParticipant`, and the SFU refreshes it every five
minutes, so ending media cannot rely on the SFU alone.

**Mapping.** Each `POST …/join` creates an admission `live_admissions(id, live_session_id,
user_id, auth_session_id, issued_at, revoked_at)` bound to the caller's Better Auth
session. The SFU identity is per admission: `u_<base64url(userId)>.<admissionId>`, and the
participant metadata is the same admission id (128 random bits). Nothing else of the
session is in the grant, and `canUpdateOwnMetadata` is false. SFU-refreshed tokens keep
identity and metadata, so they carry the same admission. One person may therefore be
several participants in a room, for example a laptop and a phone; each is ended only by
its own session's end. (Until the #139 review, the identity was one per person, and a
removal addressed by person could disconnect a newer session that had taken over that
identity while the removal was pending; the mapping was changed on 2026-09-30, recorded in
[#128](https://github.com/ColdPhase/flux/issues/128).) Presence (`participants` in session
responses and discovery, and the browser's faces, roster, speaking and people count) maps
identity to person and shows each person once, and the person's other device is labelled
as theirs in diagnostics rather than unknown. Tracks stay individual: two screens shared
from two devices of one person are two choices on the stage, and every camera is its own
tile. Raw occupancy for room retirement still counts participants. Leave (above) ends only
the current session's participants; project-access revocation still retires the whole
room (reviewer amendment accepted on #128, 2026-09-30).

**Signaling gate.** The API serves `/media/rtc`, `/media/rtc/v1` (WebSocket) and
`/media/rtc/validate`, `/media/rtc/v1/validate` (HTTP), the only signaling paths of the
pinned SFU. The LiveKit client uses them for first connect, resume and full reconnect,
with the token in the query string. Before any upgrade or SFU request the gate requires:

- a JWT signed with the Flux LiveKit key (HS256, issuer = API key) and unexpired;
- an admission id as its metadata that exists and is unrevoked, and a JWT identity (`sub`)
  equal to exactly that admission's identity, so another admission's grant, even the same
  person's, does not match;
- the request's own **cookie** session equal to the admission's session and active. Another
  valid session of the same person does not qualify;
- current project and anchor access to the live session (the live use case, as for GET),
  an available session, and the JWT naming its current room generation;
- on WebSocket, `Origin` equal to `FLUX_PUBLIC_ORIGIN`.

A refusal is `401` without an upgrade (`403` for a foreign origin) and nothing is sent to
the SFU, so no participant list, metadata or media reaches that client. The LiveKit client
treats `401` from `…/validate` as final. An admitted request is proxied frame for frame to
the private signal URL (the path without `/media`, the same query, no browser headers or
cookie). Messages are bounded at 1 MiB; the Flux stream keeps its own 1 KiB bound.

**Session end.** A trigger on `auth_sessions` deletion (migration 0023) marks that
session's admissions revoked in the deleting transaction, which covers Better Auth sign-out
and password reset, `DELETE /api/v1/sessions/:id`, `revoke-others`, expiry cleanup and
user deletion. It notifies `flux_live_admissions`; each API instance then terminates its
proxied sockets of those admissions, and addresses each revoked admission's own identity:
permissions are dropped first (`UpdateParticipant` with no publish, subscribe or data),
then `RemoveParticipant`; an absent identity counts as done. No participant list is read
first, so there is no snapshot to go stale. Removal is needed because media outlives a
closed signaling socket for about 15–20 s. Other people, and the same person connected
through another session (a different identity, even in the same room and even if it joined
while the removal was pending), stay connected. The gate refuses any later connect,
resume or reconnect with the original or a
refreshed token.

**Reconciliation only.** Every 30 s and after the notification listener reconnects, each
instance closes sockets whose admission no longer stands and removes, by their exact
identity, participants of available rooms without a standing admission (unknown, or
metadata not matching the identity, revoked, or an auth session that is gone or expired). A `participant_joined` webhook runs the same check
for its room. Revoked and ended-session admissions older than a day are pruned. These
passes catch a missed notification or an API restart; they are not the admission boundary.

**Cutover from pre-#128.** Before #128 the API issued one identity per person
(`u_<base64url(userId)>`) with no admission metadata, straight to the SFU. Upgrading only the
API leaves such participants connected. Reconciliation therefore lists **every** participant
of a Flux room, whatever its identity form, and treats any participant without a standing
admission as unadmitted: the pre-#128 form, missing or malformed metadata, metadata that does
not match the identity, and foreign identities. Each is retired by its exact identity,
permissions first; a participant with a standing admission is never touched. The new API
runs this at start (the notification listener's first connection) and every 30 s, so an
upgrade retires old participants without a room drain. `check_live_sfu.sh` proves it: with
the API stopped, a client joins the pinned SFU with an old-form grant and publishes audio;
after the API starts it is removed (`PARTICIPANT_REMOVED`) while an admitted session in the
same room stays connected.

**Topology.** `docker/compose.live.yaml` attaches LiveKit to two networks: the internal
`livekit-signal` network, shared only with the API, and `livekit-media`, which carries the
published ICE/TCP, ICE/UDP and TURN/UDP ports. LiveKit binds its signaling/room-service
listener (7880) only to its `livekit-signal` address and loopback (for the health check),
so the port is neither published nor reachable from the media network or the host's other
containers. The API reaches it as `FLUX_LIVEKIT_API_URL=http://livekit:7880`; plain HTTP is
accepted only for that Compose service name (or loopback in development). An operator who
runs the SFU elsewhere sets an HTTPS `FLUX_LIVEKIT_API_URL` and must keep that listener
private in the same way. `FLUX_LIVEKIT_WS_URL` and `FLUX_LIVEKIT_SIGNAL_PORT` are gone;
the API refuses to start if `FLUX_LIVEKIT_WS_URL` is still set. The TLS ingress serves
`/media/*` from the API like any other path; it needs WebSocket upgrades enabled. This
changes the ingress plan for [#63](https://github.com/ColdPhase/flux/issues/63).

**Evidence.** `app/tests/app/live-admission.test.ts` runs Better Auth, PostgreSQL (trigger and
LISTEN), the live use cases and the gate in process against a recording WebSocket SFU:
binding, second-session/other-person/no-cookie/forged/expired/wrong-room refusals with no
SFU connection, header stripping, validate, resume with a refreshed token, lost project
access, a grant whose `sub` is another admission's identity, two sessions of one person
in one room where Leave on one removes only its participant and presence shows one person,
sign-out, session revocation
from another device, password reset, and reconciliation. It also drives the production
LiveKit adapter against a fake room service (presence per person, raw occupancy, exact-
identity revocation, leave removing every identity of the person) and holds the production
revocation after reading the participants (reconciliation) or before the SFU calls (session
end) while the person's other session joins the same room: after release the newer session
remains and is never addressed. `app/tests/app/e2e/live-sfu-signout.e2e.ts` (in `check_live_sfu.sh`) uses the
pinned SFU and Chromium with fake audio: sign-out while publishing disconnects the sender
and the receiver observes the leave (189–2624 ms after the sign-out response in local runs
on 2026-09-30); captured first-connect, resume and full-reconnect requests replayed with the
original or refreshed token and the signed-out cookie, another session's cookie or none get
`401` and zero frames; the client's own reconnects after sign-out receive no frame; a direct
connection to `livekit:7880` from the browser network is refused (`ECONNREFUSED`); the other
person, the same person's session in another room and a third session of theirs publishing
in the same room stay connected; Leave from that third session then ends only it while the
phone session in the same room keeps publishing, and the room still lists the person once;
the other session can
then join; session revocation from another device ends that device's media; ordinary resume
and full reconnect pass; a burst of 21 joins gets 20 × `200` and `429` with `Retry-After`;
saved work remains readable. Not covered: real devices, TURN/TLS, public ingress and
several API replicas (each replica closes only its own sockets; any replica removes SFU
participants).

## Presentation delivery contract

`GET /api/v1/live-sessions/:id/presentations?after=<id>&limit=1..50`
returns chronological, identifier-only committed references from the current
room generation. The `after` cursor must belong to the same currently readable
session/generation; stale or foreign cursors fail without disclosing source
metadata. Each returned reference is checked against the recipient's **current**
project, anchor and source access in one transaction, including after a room
rotation. Hidden or deleted sources consume no visible page slot and contribute
no title, body, count or preview. The browser loads the object through its
ordinary authorized API. Flux stream may carry only a project-scoped wakeup,
never the reference payload; the GET path remains sufficient to catch up.

## Required before #61 acceptance or merge

The revocation coordinator serializes joins with access changes, retires the
old room and creates the new generation before reopening admission. Database
and mock-SFU tests exercise grant/membership revocation, admission races,
ending-room recovery and the remaining member's rejoin. The isolated Flux
API/two-Chromium/real-SFU test confirmed that deleting a room disconnects
both clients, neither an original JWT nor an actual SFU-refreshed JWT can
reconnect, and the remaining authorized member joins generation 2. Repeated
leave returned `204` twice and ordinary saved work remained usable. LiveKit's
[token documentation](https://docs.livekit.io/frontends/reference/tokens-grants/)
states that self-hosted `RemoveParticipant` does not invalidate existing tokens;
room retirement supplies the immediate cutoff instead. Since #128 those
reconnects are refused earlier, by the signaling gate (`401` on
`/media/rtc/v1/validate`), because the grant no longer names the current room.

The pinned real-SFU test observed a signed LiveKit `EV_` webhook in the durable
deduplication table after two browser clients joined. The endpoint verifies the
raw signed request before mapping it to the current room generation; records
older than seven days are pruned in bounded batches. LiveKit webhook delivery
is advisory, so the periodic SFU sweep remains required. See the
[LiveKit self-hosted webhook configuration](https://docs.livekit.io/intro/basics/rooms-participants-tracks/webhooks-events/).

Also pending: screen-track sharing, media-track recovery across restart and
independent review. A real-SFU test observed natural post-departure expiry at
about 104 seconds, rejected an old join and a still-valid refreshed JWT, and
confirmed saved work remained readable. The presentation feed has a focused
Docker integration test for authorization, cursor handling, generation changes,
revocation and a bounded hidden tail. The opt-in pinned LiveKit restart test
stops the SFU after two Chromium clients connect, then proves a new join
rotates to generation 2, both remaining people reconnect to the new room,
original and actual SFU-refreshed old grants are refused (since #128 by the
Flux gate with `401`, as they no longer name the current room; before, `404`
from LiveKit), and saved work remains readable. It checks signaling and room admission, not
screen-track recovery, TURN or physical devices.
The dated
[lifecycle plan](live-lifecycle-plan.md) records the intended tables, locks
and failure tests; implementation is in progress and is not an accepted result.
Source-version checks now run inside the trace transaction and have targeted
regressions. #62 owns the integrated
interface and [#63](https://github.com/ColdPhase/flux/issues/63) owns receiver,
network and real-device evidence.

## Interface (#62)

The browser client is `app/apps/web/src/live/`. [Live sessions at the work](../design/live-ux/README.md)
describes what people see, the placement decisions and the screenshots.

- `media.ts` is the only module that imports `livekit-client` (`2.17.2`, the same version
  as the SFU proof). It turns the room into a plain snapshot: people, speaking, link
  quality, published tracks, device states and audio playback. It exposes a few verbs:
  connect, `setDevice`, hearing on or off, `startAudio`, disconnect and diagnostics.
  Devices start off. A device is `on` only after its track is published, and turning it off
  unpublishes and stops the capture.
- `LiveProvider.tsx` holds one session per tab above the routes. It handles start or join
  (start joins an existing session at the same anchor instead of opening a second),
  presentation polling every 2.5 s through the identifier-only feed, View and Follow, quiet,
  invitations and rejoin. A drop other than your own leave rejoins through `POST …/join` at
  most three times: current access is checked again and a rotated room is joined fresh.
  Every device is off afterwards. Removal (and `DUPLICATE_IDENTITY`, now only the same
  admission connecting twice) ends the local session with a notice. Another tab or device
  of the same person is a separate participant; the faces show each person once.
- Views register what they are about with `useRegisterLiveHere(anchor, presentable)`: the
  conversation, a task or result in Details, a project sketch with its selected thoughts, or
  a doc at the shown version. Nothing is published from navigation. Only **Show this** calls
  `POST …/present`.
- `/projects/:p/live/:session?invitation=:id` (the inbox link) resolves the session and
  replaces the URL with the anchor. It passes the invitation in navigation state for one
  quiet card; **Later** and **Reply in text** use `POST /api/v1/live-invitations/:id/reply`.
- `scripts/check_live_ui.sh` runs `app/tests/ui/test_live_sessions.py` against the application
  and the pinned SFU, using Chromium's fake devices. The ordinary `check_ui.sh` runs the
  same file without a media server and checks the unavailable state.

## Reproducing this checkpoint

Use an isolated Compose project and free ports:

```sh
FLUX_TEST_PORT=18661 FLUX_TEST_MAILPIT_PORT=18662 ./scripts/check_application.sh
FLUX_LIVE_TEST_PORT=18771 ./scripts/check_live_sfu.sh
FLUX_LIVE_UI_PORT=18781 ./scripts/check_live_ui.sh
```

That script builds and runs the application, PostgreSQL migration, API tests,
browser access checks, restart and push checks inside Docker. The focused
`app/tests/app/live-store.test.ts`, `live-source.test.ts` and
`live-revocation.test.ts` cover the persistence, policy and coordinator seams.
The pinned LiveKit server was exercised with two actual Chromium clients and
an audio track. `check_live_sfu.sh` separately exercises the full Flux API,
two connected clients, an actual SFU-refreshed token, project-grant revocation,
old-room disconnection/reconnect rejection and a surviving member's new-room
join. The local proof does not establish public ingress, TURN/TLS or all device
and lifecycle cases.
