# Public push-service DNS lookup (#232)

Accepted bounded correction, 2026-10-04. The actual trusted-HTTPS verification at
`73ee0a18d044a2858908d8ab95d950df6d7a9286` produced a genuine browser FCM
subscription, but the worker refused its public A/AAAA answer set before sending.
The pinned production Node diagnostic reproduced the cause: blocking the entire
IPv4-mapped IPv6 `::ffff:0:0/96` subnet also blocks ordinary public IPv4 addresses.
The [Node BlockList documentation](https://nodejs.org/api/net.html#blocklistcheckaddress-type)
corroborates equivalent IPv4/mapped classification. The independent peer accepted
the correction before implementation; the claim/evidence is on
[#232](https://github.com/ColdPhase/flux/issues/232#issuecomment-5974904325).

The sender removes that blanket mapped subnet and retains every actual denied
IPv4 range and all other existing IPv6 restrictions. A mapped address is evaluated
against its underlying IPv4 ranges, including hexadecimal mapped notation.
Public IPv4, public mapped IPv4 and public IPv6 are eligible; a DNS answer set
containing any denied address is rejected in full, in either order. Empty answers
and DNS failures never authorize a destination.

The production HTTPS agent performs this lookup at connection time, including
after DNS rebinding. Its TLS certificate verification, endpoint validation,
VAPID encryption, current session/access checks, preferences and bounded retries
are unchanged. This correction does not enable private networking, force IPv6,
allowlist a vendor or introduce a custom trust root. No dependency upgrade is
required.

Acceptance requires actual fixed-lookup positive and denial cases, both callback
shapes, mapped forms, mixed answers, empty/error results and an HTTPS connection
refusal before a protected listener receives any request. Existing push,
revocation and preference regressions must still pass. A new genuine provider
attempt records the exact clean source/image and provider result; lookup success
alone is insufficient. Physical Android/iPhone/iPad installation, OS display,
background/lock-screen delivery and authorized taps remain separate requirements
under [MOB-1–MOB-7](../product/mobile-pwa.md).

The original failed provider attempt, its separate browser-inspection timeout,
and earlier login-rate-limit/migration-startup failures remain retained evidence.
This contract does not claim an implementation, runtime or physical-device pass.

**Regression guard (takeover, 2026-10-04).** Both the existing push test and the
lookup test run the private-network override that the test stack needs for its
local push mock. So one more test in `app/tests/app/push.test.ts` exercises the
worker's own `createPushAgent` without that override. It uses Node's real
resolver on literal hosts, so it needs no outside DNS. The test checks that:

- public IPv4, public IPv6 and IPv4-mapped public answers are destinations;
- loopback, private, link-local, CGNAT, multicast, unspecified, NAT64 and the
  IPv4-mapped forms of those private ranges are refused with `EPUSHPRIVATE`.

The test uses only the API that `main` already had. Run unchanged against the
earlier guard, it fails on the first public IPv4 answer, which is the defect
above. Putting the `::ffff:0:0/96` rule back into the fixed guard makes both
tests fail again.
