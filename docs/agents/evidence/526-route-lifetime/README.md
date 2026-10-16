# Held task response: interception lifetime (#526)

Investigation: 2026-10-15. Product source: PR #528 at
`dff538b3236cee14bb1354df5de3237cb223700e`; the repair changes the test fixture only.

## Observations

The historical failing Tasks run stored PATCH successfully but received no
subsequent `/api/v1/me` at the server during the eight-second toast assertion.
It did not capture the browser's PATCH body or session-check entry, so that run
alone does not distinguish an undelivered PATCH from a stalled follow-up request.

Temporary product traces passed five narrow probes and one full Tasks module.
After removing those traces, one full module passed (14 tests, 80.149 seconds),
as did 12 repetitions of the original scenario with passive CDP network capture.
These passing diagnostic runs are not evidence that the original race was fixed.

The installed Playwright 1.62.0 image contains Chromium/headless-shell
**151.0.7922.34**, revision **1234** (verified from its `browsers.json` and the
running browser's version).

An isolated native-fetch control, without Flux/React/session code, reproduced the
failure using the same `route.fetch()` → held `fulfill()` → immediate `unroute()`
ordering and an eight-second completion assertion:

- Removing the last route: **1 failure in 30 trials**. PATCH returned 200, its
  body was consumed, and the page issued GET `/me`. That request had no response,
  failure or completion event, and the HTTP server never received it.
- Retaining the route until context closure: **30 of 30 trials passed**.

The [captured excerpt](capture.json) contains the failing trial and both totals.
The [standalone probe](probe.py) reproduces the comparison in the pinned Docker
browser. It is diagnostic evidence, not an additional default application test:

```sh
docker build -f docker/ui-tests.Dockerfile -t flux-526-probe app
docker run --rm --name flux-526-probe \
  -v "$PWD/docs/agents/evidence/526-route-lifetime/probe.py:/tmp/probe.py:ro,z" \
  flux-526-probe python3 /tmp/probe.py
docker image rm flux-526-probe
```

No host port is published. A race need not fail on every invocation; the probe
reports all trials and never converts its failures into passing product checks.

## Upstream evidence and conclusion

Playwright's [#41802 investigation](https://github.com/microsoft/playwright/issues/41802)
identifies a Chromium CDP race: `Fetch.disable` can drop a just-issued request,
leaving only `Network.requestWillBeSent`. Its
[regression test, added 2026-08-17](https://github.com/microsoft/playwright/commit/f082caf5a3ee00f6dd65f8f6384ed586df6c99a9),
was initially disabled for Chromium. The
[Chromium fix](https://chromium-review.googlesource.com/c/chromium/src/+/8252169)
merged on 2026-08-21. Playwright
[enabled the test for Chromium 155 and later on 2026-09-25](https://github.com/microsoft/playwright/commit/28b4e74e6d4c82dc2ab9ddf6f316c390ac5a7dc5).
These are upstream observations, separate from the local control above.

The isolated control proves that the pinned browser can lose the follow-up
request under the fixture's ordering. Attributing the historical Flux failure
to this same race is a strongly supported inference, not a newly captured Flux
failure: its absent server `/me` and unchanged row match the reproduced path.
No evidence supports changing the product's session guard or toast epoch.

## Repair and acceptance

The fixture holds only its first PATCH and forwards every later matching request.
Its route stays installed until its own browser context closes; it no longer
disables interception while the PATCH completion starts the session check.
Each theme owns a separate context, route and held-response list. Normal context
cleanup removes them. The toast assertion, eight-second deadline, focus, reading
anchor, resize, view-retirement and dismissal checks are preserved. No sleep or
timeout was added, and temporary product instrumentation was removed.

Final-head five-run Tasks acceptance and the other PR #528 gates are recorded in
the PR handoff; diagnostic runs above do not replace them.
