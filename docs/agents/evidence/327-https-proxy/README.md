# #327 — actual HTTPS reverse-proxy verification

2026-10-07. Author `/root` for PelikanFix16; independent evaluator `/root/kreska_fixes`.
The running Flux source was **9d54135b7b13f6c932ccf4c6e080ae4ae48d2fa5**, before the
subsequent #300 merge. This documentation task changes no application, maintained Compose
file or launcher. It does not certify a complete release or the final design.

## Actual controls

| Control | Result |
| --- | --- |
| Pinned Caddy 2.11.7 validates the recorded Caddyfile | PASS, [validation](caddy-validation.txt), [actual version](caddy-version.txt) |
| HTTPS health through the proxy | PASS on `/api/v1/health`; an earlier `/health` probe returned404 and was corrected |
| Real UI signup through HTTPS, proxy trust empty | PASS, [browser record](untrusted-browser.json) |
| Measured API socket peer | `172.27.0.1`, matching the own Docker bridge gateway, [session address](socket-peer.tsv) |
| Restart with only that peer trusted | `FLUX_TRUSTED_PROXIES=172.27.0.1/32`; [independent live inspection](independent-runtime.md) |
| Two independent browser contexts: UI signup, signout, signin | PASS, [browser record](trusted-browser.json) |
| Actual session cookies | Secure, HttpOnly, SameSite=Lax; cookie **values** never recorded |
| Browser-posted reply | HTTP201; another browser receives a real WebSocket101 and project message event, and displays the reply without document reload |
| Durable correlation | The received event ID matches the database event's project, conversation and posted message IDs; [selected SQL result](final-proof.tsv), [query](final-proof.sql) |
| Resolved client IP and spoof control | All three final sessions contain `127.0.0.1`, including ordinary signin with injected `X-Forwarded-For: 203.0.113.199` |
| Independent CA-verified discovery | Metadata200, exact HTTPS resource and authorization-server origin; [body](metadata.json), [headers](metadata-headers.txt) |
| Independent CA-verified unauthenticated MCP | POST401, exact HTTPS `WWW-Authenticate` resource-metadata URL; [body](mcp.json), [headers](mcp-headers.txt) |
| Uncaught browser errors | None in the accepted run |
| Own resources cleaned up | [Cleanup](cleanup.txt); empty [container](cleanup-containers.txt), [volume](cleanup-volumes.txt), [tagged image](cleanup-images.txt) inventories |

Actual screenshots: [sender](sender.png), [receiver](receiver.png). They corroborate the
browser observations; the screenshot alone is not the behavior or stream proof.
The current production thread refreshes its data every15seconds. The accepted probe
allowed40seconds for visible delivery, without forcing refresh, navigation or a document
reload. A real project event was independently correlated with the stored message. This
does **not** claim the frame caused an immediate UI refresh.

## Source, setup and scope

The author used a separate source worktree, project `FLUX_PROJECT=flux327-https-20261007`,
API19373, mailpit19374 and proxy19443. The actual image IDs, platform, public origin and
narrow trust are in [runtime.json](runtime.json). No shared stack, volume, host certificate
store or Docker build cache was changed. The generated own `docker/.env` and Caddy CA
volumes were removed after the checks. The public CA certificate was only used for curl.

The Caddy container used host networking, a read-only SELinux-compatible configuration
mount and separate persistent `/data` and `/config` volumes. Flux was started with `./flux up`,
its current source image built by the launcher. The browser harness was built through the
source Compose `ui-test` profile, then ran the actual [probe](browser-probe.py):

```sh
docker run --rm --network host -v /tmp/flux327-runtime:/evidence:rw,z \
  flux-ui-tests:flux327-https-20261007 python3 /evidence/browser_probe.py untrusted
docker run --rm --network host -v /tmp/flux327-runtime:/evidence:rw,z \
  flux-ui-tests:flux327-https-20261007 python3 /evidence/browser_probe.py trusted
```

The accepted runs exited0: [untrusted](browser-untrusted.txt), [trusted](browser-trusted.txt).
The ephemeral browser passwords existed only in the process. No cookie/token value,
database password, auth secret or CA private key is in this evidence. Discovery and MCP
headers contain no Cookie or Set-Cookie. [Manifest](manifest.json) pins the retained
original bytes, and both compressed and original hashes for failure logs.

Browser contexts explicitly used `ignore_https_errors=True` for the local CA and blocked
service workers. Independently executed curl used `--cacert`, never `-k`, with TLS verify0
before and after the trust restart. The [independent report](independent-runtime.md) states
which probes the evaluator actually executed and which author observations it had not
yet reviewed. [Plan review](independent-plan.md) predates runtime acceptance.

Public ACME, Internet DNS, Docker Desktop, installed browser/device CA trust, external
OAuth issuance, PWA installation, media/RTP/ICE/TURN and complete application/release
acceptance remain outside this check. The guide names their separate requirements.

## Failed attempts retained

- [Caddy validation without a SELinux bind label](caddy-selinux-failure.txt) failed with
  permission denied. Adding `:ro,z` produced the separate successful validation above.
- The first UI probe used a nonexistent `Thread` region: [failure log](browser-selector-failure.txt.gz).
- The next probe asserted an empty replies region visible; it has no visible height before
  replies: [failure log](browser-empty-region-failure.txt.gz). Readiness now uses the actual
  `Replies` heading and the filled composer.
- A15second message visibility assertion expired at the production refresh boundary:
  [failure log](browser-15s-failure.txt.gz). The fresh accepted run used40seconds and the
  production polling behavior is explicitly recorded. It also corrected the event
  correlation: stream `objectId` is the project, not the message; selected SQL correlates
  the actual event ID to the durable message without exposing an event payload to clients.

These setup/harness attempts are not passing checks and do not establish instant message
updates. The final probe and result remain distinct from each failed attempt.
