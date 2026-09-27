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
- The `GET /api/v1/live-sessions/capabilities` response says `configured` when
  the required media variables are present. This does not certify reachability,
  DNS/TLS, ICE, relay fallback or receiver quality.

## Required before #61 acceptance or merge

This checkpoint does **not** implement secure membership revocation for active
or reconnecting media. LiveKit's [token documentation](https://docs.livekit.io/frontends/reference/tokens-grants/)
states that self-hosted `RemoveParticipant` does not invalidate existing tokens;
refreshed reconnect tokens can outlive the initial grant. The remaining slice
must serialize Flux grant issuance with revocation, rotate each affected room's
generation, delete the retired SFU room with `room.auto_create: false`, and
recover safely across partial failures. Test both original and refreshed tokens
against the real pinned SFU. The current join route must not be exposed as a
completed access boundary until that work passes.

Also pending: a bounded session lifecycle and room count, current-audience
discovery/invitations, verified webhook or equivalent participant events,
idempotent leave/end and last-person expiry, authorized presentation delivery,
source-version checks in the same transaction as a trace, two real clients,
reconnect/media-failure tests and independent review. #62 owns the integrated
interface and [#63](https://github.com/ColdPhase/flux/issues/63) owns receiver,
network and real-device evidence.

## Reproducing this checkpoint

Use an isolated Compose project and free ports:

```sh
FLUX_TEST_PORT=18661 FLUX_TEST_MAILPIT_PORT=18662 ./scripts/check_application.sh
```

That script builds and runs the application, PostgreSQL migration, API tests,
browser access checks, restart and push checks inside Docker. The focused
`tests/app/live-store.test.ts` proves project-scoped foreign keys, idempotency,
identifier-only traces and a denied project grant at the persistence seam. The
SFU adapter was separately exercised against a pinned local Docker LiveKit
container (create room twice, issue a JWT, list connected participants and
delete the room). Neither check proves a real two-person call or revocation.
