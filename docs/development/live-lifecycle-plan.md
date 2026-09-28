# Live session lifecycle implementation plan

**Date:** 2026-09-28. **Status:** proposed implementation plan for [#61](https://github.com/ColdPhase/flux/issues/61), not an accepted or verified AC-2/AC-3 result. The current #61 branch has project-bound sessions, admission and room-generation revocation work in progress; it does not yet have durable last-person expiry, invitations or signed participant events.

## Evidence and boundaries

- [LiveKit webhooks](https://docs.livekit.io/intro/basics/rooms-participants-tracks/webhooks-events/) use `application/webhook+json`, an Authorization JWT that binds a SHA-256 payload hash, and an event UUID. `participant_joined` follows an active media connection. Webhook retries do not guarantee delivery. These are provider documentation claims, not Flux test results.
- The [LiveKit Room Service API](https://docs.livekit.io/reference/other/roomservice-api/) distinguishes `emptyTimeout` before a first join from `departureTimeout` after the last departure. `DeleteRoom` disconnects current participants. These settings do not update Flux's durable session state by themselves.
- [Fastify 5.6 content parsers](https://fastify.dev/docs/v5.6.x/Reference/ContentTypeParser/) support a route-scoped raw-string parser and body limit for LiveKit signature verification. Flux must pass the original body string to `WebhookReceiver` before using any payload field.
- The current code obtains actual connected people through the self-hosted LiveKit `listParticipants` adapter. A failed SFU query means **presence unknown**, never an empty room. Existing `live_access_fences` and `liveRevocationCoordinator` serialize access changes with admission and retire old room generations; lifecycle closure must share that ordering.

## Durable state and bounds

Add a follow-up migration after `0014` and matching schema types:

| Record | Proposed fields and purpose |
| --- | --- |
| `live_sessions` | `empty_since`, `last_grant_at`, `presence_digest`; add `ending` to state and an index for due available sessions. `last_grant_at` gives an issued join a short connection window without treating a token as a connected participant. |
| `live_webhook_events` | Event UUID primary key, room ID and received time for replay deduplication and bounded retention. Store no media or message content. |
| `live_invitations` | Session, workspace, project, recipient, inviter, `pending/later/text/joined/expired`, timestamps; unique `(session_id, recipient_user_id)`. Composite foreign keys bind the recipient to current workspace membership. An invitation never grants project or media access. |

Set a proposed limit of **8 non-ended sessions per project, 3 per creator**, while the existing room limit remains 16 connected participants. In `createOrGet`, acquire a project-scoped transaction advisory lock after the existing policy/guard locks, resolve an idempotent existing `clientSessionId` first, count `available`, `rotating` and `ending` rows, then insert or return a typed limit error. Expiry must free slots; adding a cap before an end path would exhaust projects permanently. Test concurrent ninth starts at the boundary and same-key replay at the cap.

## Presence, reconnect and expiry

1. Configure a proposed 300-second never-joined timeout and 90-second post-departure timeout in LiveKit. Flux uses the same 300/90-second grace periods for its own durable state. The exact values need receiver/reconnect testing before acceptance.
2. `POST /api/v1/internal/livekit/webhook` accepts only a bounded raw `application/webhook+json` body (proposed 64 KiB). Verify with the pinned SDK `WebhookReceiver` and server signing key; deduplicate the event UUID; map its room ID only to the **current** session generation. Ignore old-generation and unsupported events. The webhook requests reconciliation; it never authorizes a person or directly closes a room.
3. Reconcile `listParticipants` after join/leave and relevant webhooks, at startup, and periodically. Compare a digest of sorted current identities and connection times; when it changes, emit an identifier-only `project.live_presence_changed.v1` event with `objectId=projectId` and `{sessionId,generation}`. The existing project event policy then limits delivery. A browser in the room also uses the LiveKit client events for immediate local presence. SFU errors produce `participants:null` and postpone expiry.
4. A successful connected-person observation clears `empty_since`. When an authoritative query first finds no connected person, record `empty_since` once. A new Flux join grant resets the grace window briefly; if no media connection follows, the next reconciliation starts an empty interval again. Reconnect must recheck current Flux project/anchor access and use only the current room generation.
5. At a due empty interval, take the same workspace advisory lock as `liveRevocationCoordinator`, then the project guard `FOR NO KEY UPDATE`, then the session row `FOR UPDATE`. This waits for in-flight admissions. Query the SFU again with a bounded timeout. If occupied, cancel expiry; if unavailable, retain the current state and retry. If empty, commit durable `ending` **before** calling external `DeleteRoom`.
6. With `ending`, all admission, room creation, presentation and invite paths reject the session. Delete the old room and confirm its absence, then commit `ended` and expire invitations. Recovery at startup and during periodic maintenance retries `ending` after a crash or SFU failure. Teach the revocation coordinator to recover pending endings under its workspace lock before an access change. An old original or refreshed token cannot create the deleted room when LiveKit room auto-creation is disabled. A fresh session requires a new client session UUID.

Use a bounded periodic reconciliation batch in the API composition root (for example every 30 seconds), safe to run on multiple replicas because the database/workspace locks serialize mutations. Webhooks speed up refresh; periodic work is required because their delivery is not guaranteed. Do not claim a measured disconnect/reconnect bound before tests against the pinned SFU.

## Quiet invitations

Add `POST /api/v1/live-sessions/:id/invitations` with a recipient person ID. Under the project/session locks, require an available current generation and current project **and anchor** read access for inviter and recipient. Insert the unique invitation and one generic project-sourced in-app notification plus its optional Web Push jobs in one transaction. Repeated requests return the existing invitation without another inbox row or push. Store no LiveKit token, private title or copied content in the notification; a source-linked URL points to the Flux session and reauthorizes on opening. Current inbox filtering hides a source after grant loss. `POST /api/v1/live-invitations/:id/respond` records `later` or `text`; `text` opens ordinary project conversation, while `join` uses the existing authorized join endpoint and becomes `joined` only after confirmed media connection. An invited person still needs normal project rights, and a person with those rights can join without an invitation.

## Required regression evidence

- Out-of-scope project and revoked recipient: no session, invitation, title, count or presence leak; an existing invitation does not restore a grant.
- Duplicate/signed-invalid/replayed/stale-generation webhook; missed webhook recovered by polling; raw-body hash validation and body limit.
- Two-client join/leave/reconnect during grace; join racing with expiry; SFU outage leaves presence unknown and does not close an occupied room.
- Crash after `ending` but before `DeleteRoom`, and after deletion but before `ended`; startup recovery leaves no old-room admission.
- Original and SFU-refreshed old JWTs fail to recover media after expiry or access revocation; current authorized members receive a new generation only for an access change, and a new session after terminal expiry.
- At the cap, concurrent starts allow only the remaining slots, idempotent retry returns its existing session, and confirmed expiry releases a slot.

This plan does not certify UI, actual mobile behavior, webhook operation, invitations or expiry. The #61 implementation and independent exact-head evaluation must supply those observations; #62/#63 retain interface and deployment/device evidence.
