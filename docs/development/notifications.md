# Notifications: inbox, preferences and email (issue #116)

This page is the contract for foundation area 8.9 as built in
[#116](https://github.com/ColdPhase/flux/issues/116). It covers the SMTP/SSO mail cases of
[#113](https://github.com/ColdPhase/flux/issues/113) and follows Hubert's founder direction on
[#44](https://github.com/ColdPhase/flux/issues/44) (email delivery, 2026-09-27). It builds on
the #41 inbox and Web Push ([mobile PWA](../product/mobile-pwa.md#lock-screen-privacy)).
Migration `0015_notifications.sql`, `FLUX_SCHEMA_VERSION` 15.

## What notifies, and why

A notification exists only for a reason a person can act on (`reason` on every row):

| Reason | Event | Who |
| --- | --- | --- |
| `mention` | `project.message_sent.v1` / `project.conversation_created.v1` | People named with `@Name` (or opened with `Name,`), as the return view (#106) matches them. |
| `question` | same | A mention that asks something (`?`). |
| `reply` | same | The conversation's starter and earlier writers, unless the message mentions them. |
| `dm` | `dm.message_sent.v1` (now carries `messageId`) | The other current participants. |
| `assigned` | `project.work_created.v1` / `project.work_updated.v1` with `assignedTo` | A person someone else made the owner. |
| `review` | `project.decision_proposed.v1`, `project.result_recorded.v1` | Owners of work the decision affects or the result is about, and the owner of the agent that produced it. |

The actor is never notified. Nothing else notifies: no digests, counts or "you have been away".

## Generation from committed events

The worker (`apps/worker/src/notifications`) runs the core use case
`generateNotifications` (`packages/core/src/notifications/generate.ts`). In one transaction it
locks `notification_cursor`, reads up to 100 events after it (events commit in `seq` order,
migration 0004), creates their notifications and advances the cursor. A LISTEN on
`flux_events` wakes it right after a commit; a 2-second poll is the backstop. Worker replicas
serialize on the cursor row. Each event runs in its own savepoint. When one fails, the cursor
stops just before it (earlier events commit), the attempt is counted in
`notification_generation_failures`, and the worker retries with backoff (2, 4 … 60 s), so a
transient error never loses an event's notifications. After 5 failed attempts the event is
dead-lettered (`dead_at` set, logged) and passed, so one poisoned event cannot block everyone.

For each candidate the generator requires, in this order:

1. the person was in the event's recorded audience (`event_audience`, decided at write time);
2. the place (project or DM) is not muted and at least one channel is on for the reason;
3. the access policy lets them read the source **now** (`policySourceReader`, which now
   includes `dm.read`); someone removed in between gets nothing.

Rows are unique per `(user_id, event_id)`, so reprocessing the log never duplicates them. The
source is the project or DM (`source_type` gains `dm`), so the #41 inbox, push preview and
tap-time rechecks apply unchanged. The URL opens the exact message
(`/projects/:p/conversations/:c#message-:m`, `/dm/:d#message-:m`) or the object in Details
(`/projects/:p/tasks?open=work:<id>`).

## Preferences

`GET/PATCH /api/v1/notification-preferences`; `PUT …/mutes` with `{ type, id, muted }`.
A `PATCH` is partial and atomic: the row is locked (`SELECT … FOR UPDATE`, created with the
defaults if missing), the given fields are merged and written in one transaction, so concurrent
edits of different fields never overwrite each other; for the same field the later request wins.
The settings page sends its saves one after another, numbered, and shows only the newest answer.

- **Channels per reason** (`inApp`, `push`, `email`). Defaults: inbox and push on for every
  reason; email on for `mention`, `question` and `dm` only. With the inbox off but push or email
  on, the row is kept (`in_inbox = false`) to back those channels and the tap-time recheck, but
  the inbox list leaves it out. All off: nothing is stored.
- **Mute a place** (a project or DM the person can read): nothing from it notifies, on any
  channel.
- **Quiet hours** (`start`/`end` as `HH:MM`, may cross midnight, IANA `timeZone`): push and
  email jobs get `startAfter` at the first real instant whose wall-clock time in the person's
  zone is past the window (daylight-saving aware: an end inside a spring-forward gap resolves to
  the first valid instant after it, a repeated end at fall-back to its first occurrence), and each
  send re-evaluates the person's *current* quiet hours: a job queued before they were turned on
  is deferred (queued again with `startAfter` at the window's end, the email row stays
  `queued`). The inbox is never held back.
- **Where email goes**: `account` (the sign-in/SSO address, default), `extra` (the verified
  extra address), `both`, or `none` (in-app only).

Push delivery (#41) rechecks the same preferences before each send (`stillWanted`): push turned
off for the reason or a muted place skips it. The payload and its lock-screen rule are unchanged.

## Delivery addresses

One extra address per person, in `notification_addresses` — not an auth table. Better Auth never
reads it, so it can never sign in, receive a password reset, or change sessions or grants, and
turning it off never changes the account. `POST /api/v1/notification-address` replaces it and
emails a single-use link (SHA-256 of the token stored, 24 hours, earlier links invalidated);
`POST …/resend`. Verification sends are bounded per person across add, replace and resend — at
least 60 s apart and at most 5 per rolling hour — by one conditional upsert on
`notification_verification_sends` (concurrent requests cannot both pass); otherwise `429
VERIFICATION_RECENTLY_SENT` with `Retry-After`; `POST …/verify` with the token, signed in as the
account that added it (anyone else, a used or an expired token get the same `400
VERIFICATION_INVALID`); `DELETE` removes it and moves `extra`→`none`, `both`→`account`, never
starting mail to the sign-in address by itself. The sign-in address cannot be added as extra.

## Email

- **Transport.** The administrator sets `FLUX_SMTP_URL` and `FLUX_MAIL_FROM` once for the
  instance (the password reset transport); links use `FLUX_PUBLIC_ORIGIN`. The worker needs all
  three. TLS: `smtps://user:pass@host:465` (implicit TLS) or
  `smtp://user:pass@host:587?requireTLS=true` (STARTTLS required; without `requireTLS`, nodemailer
  upgrades when offered). Certificates are verified; a private CA is trusted with
  `NODE_EXTRA_CA_CERTS`. Keep the password in the environment or a secret store, never in the
  repository. Both TLS modes are tested against TLS-only Mailpit instances in
  `check_application.sh`; a plain-text send to a server that requires TLS fails and is reported.
- **Unavailable.** Without `FLUX_SMTP_URL` no email rows are queued, settings show "Email
  delivery unavailable", adding an address answers `503 EMAIL_UNAVAILABLE`, and the inbox and push
  keep working (`tests/app/email-unavailable.check.ts`).
- **Outbox and no duplicates.** `notification_emails` holds one row per (notification, address
  kind), each sent by a `notification.email.v1` job carrying only the row id. The worker locks the
  row, rechecks source access, the reason's email channel, mute, destination and the address
  (the current sign-in address, or the verified extra one), marks it `sending` with a fresh
  unsubscribe token and commits — only then talks to SMTP. A row that is not `queued` is never
  sent again, so a retry, a concurrent job or a crash after SMTP accepted cannot send it twice
  (at most once). An SMTP failure puts it back to `queued` with `last_error`, pg-boss retries 5
  times (30 s … 15 min), and settings show "A recent notification email could not be delivered";
  the inbox keeps the item.
- **Calm.** At most one email per person and place in 10 minutes; the inbox holds the rest.
- **Content.** Subject is always "New activity in Flux". The body has only
  `${origin}/inbox/:id` (which rechecks access and opens the source), a settings link and an
  unsubscribe link: no project, person or message text, so nothing leaks to someone removed
  since. `Message-ID` is `<notification-<row id>@host>`.
- **Unsubscribe.** `List-Unsubscribe: <…/api/v1/notifications/unsubscribe?token=…>` and
  `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058). The token is bound to the exact
  address the email went to. The POST needs no session and removes that address kind from the
  destination (`both`→ the other one, else `none`) only while that address is still the current
  one; a link for a replaced extra address or a changed sign-in address answers `result:
  "stale"`, changes nothing, and the page says "This link no longer applies". The body
  links to `/unsubscribe?token=…`, a page with one button.

## Inbox UI

The rail has an **Inbox** button between Home and Direct messages with a quiet lime dot when
something is unread — never a count (#44 no guilt). `/inbox` lists "New" and "Earlier" items,
each with its reason, title, excerpt and time; opening one marks it read and opens the source;
"Mark all read" only quiets the dot. `/settings/notifications` holds the channel table, email
destination and extra address, quiet hours and muted places. `/inbox/:id` (email link) and
`/settings/notifications/verify` are routes of the signed-in app.

## Tests

- `tests/app/notifications.test.ts`: generation per reason, once per (person, event) after a
  cursor rewind, mute, inbox-off and all-off, generic email content through Mailpit with
  one-click unsubscribe, access recheck before email and push, push preferences, duplicate and
  concurrent sends, extra address verification and expiry, extra address never signing in or
  receiving a reset, the two-SSO-user destination matrix (#113), STARTTLS and smtps paths.
- `tests/app/email-unavailable.check.ts` after restarting API and worker without SMTP.
- `tests/ui/test_notifications.py`: inbox from the rail, opening sources, mark read, preferences,
  muting, verifying an address through Mailpit, phone layout, dark mode and the unsubscribe page.

Not verified here: real Android/iPhone/iPad push display (MOB-4/MOB-7 in #20) and delivery
through a production mail provider (SPF/DKIM/DMARC are the operator's; see the operator notes
in [containers](containers.md)).
