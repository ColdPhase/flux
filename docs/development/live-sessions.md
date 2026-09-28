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
  Device capture and playback remain client actions; receiving a grant never
  enables a microphone, camera or screen by itself.
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

## Required before #61 acceptance or merge

The revocation coordinator now serializes joins with access changes and rotates
rooms after deletion. Database and mock-SFU tests exercise grant/membership
revocation, admission races and recovery. A separate two-client test on the
pinned self-hosted LiveKit server confirmed that deleting a room disconnects
both clients, and neither an original JWT nor an actual SFU-refreshed JWT can
reconnect while `room.auto_create` is disabled. An end-to-end Flux API/SFU
revocation test, including the remaining member's rejoin, is still required
before calling this an accepted access boundary. LiveKit's
[token documentation](https://docs.livekit.io/frontends/reference/tokens-grants/)
states that self-hosted `RemoveParticipant` does not invalidate existing tokens;
room retirement supplies the immediate cutoff instead.

Also pending: a bounded session lifecycle and room count, invitations,
verified webhook or equivalent participant events,
idempotent leave/end and last-person expiry, authorized presentation delivery,
screen-track sharing, reconnect/media-failure tests and independent review.
The dated [lifecycle plan](live-lifecycle-plan.md) records proposed tables,
locks and failure tests; it is not an implemented acceptance result.
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
