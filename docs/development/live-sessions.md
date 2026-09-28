# Live sessions: implementation checkpoint (#61)

The optional self-hosted media adapter uses LiveKit server `v1.13.7` by image
digest and `livekit-server-sdk` `2.19.1`. The normal Flux application starts
without media configuration. `infra/compose.live.yaml` adds an operator-owned
SFU and injects explicit API/WSS origins and a signing key into the API. Its
signaling port is loopback-bound for the operator's TLS ingress; ICE/TURN ports
need direct network reachability. No recording, egress or transcription service
is enabled. The profile currently exposes embedded TURN/UDP only; TURN/TLS and
restrictive-network acceptance remain in [#63](https://github.com/ColdPhase/flux/issues/63).

## Current behavior

- A human can start a session at an existing project conversation, work item or
  project sketch, get it by opaque ID, request a room-scoped grant and send a
  versioned object reference without copying a title or body into the media
  trace. The API rechecks project access; durable starts and presentations have
  caller-provided idempotency IDs. Private sketches cannot anchor a project
  session. The SFU participant list is queried for actual connected people; a
  failed query appears as unknown rather than zero people.
- `POST /api/v1/live-sessions/:id/leave` disconnects that human from media.
  A repeated leave returns `204` after the SFU confirms the person is absent.
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
room retirement supplies the immediate cutoff instead.

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
original and actual SFU-refreshed old grants receive `404` from LiveKit, and
saved work remains readable. It checks signaling and room admission, not
screen-track recovery, TURN or physical devices.
The dated
[lifecycle plan](live-lifecycle-plan.md) records the intended tables, locks
and failure tests; implementation is in progress and is not an accepted result.
Source-version checks now run inside the trace transaction and have targeted
regressions. #62 owns the integrated
interface and [#63](https://github.com/ColdPhase/flux/issues/63) owns receiver,
network and real-device evidence.

## Reproducing this checkpoint

Use an isolated Compose project and free ports:

```sh
FLUX_TEST_PORT=18661 FLUX_TEST_MAILPIT_PORT=18662 ./scripts/check_application.sh
FLUX_LIVE_TEST_PORT=18771 ./scripts/check_live_sfu.sh
```

That script builds and runs the application, PostgreSQL migration, API tests,
browser access checks, restart and push checks inside Docker. The focused
`tests/app/live-store.test.ts`, `live-source.test.ts` and
`live-revocation.test.ts` cover the persistence, policy and coordinator seams.
The pinned LiveKit server was exercised with two actual Chromium clients and
an audio track. `check_live_sfu.sh` separately exercises the full Flux API,
two connected clients, an actual SFU-refreshed token, project-grant revocation,
old-room disconnection/reconnect rejection and a surviving member's new-room
join. The local proof does not establish public ingress, TURN/TLS or all device
and lifecycle cases.
