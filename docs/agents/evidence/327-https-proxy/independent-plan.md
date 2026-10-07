# Independent implementation/verification plan — #327

2026-10-07. Evaluator `/root/kreska_fixes`; author/single owner `/root` for @PelikanFix16. Read the current five acceptance criteria and authorized claim6046709934. Prepared worktree `/home/hubert/.codex/worktrees/327-tls-proxy/flux`, branch `codex/327-tls-proxy`, clean base `9d54135b7b13f6c932ccf4c6e080ae4ae48d2fa5`. No code, branch, GitHub or runtime changes by this evaluator.

**Plan accepted with the concrete implementation details below. Final delivery and all runtime observations remain unverified.** One Caddy example, operations documentation and bounded evidence are sufficient; no second proxy or application/maintained Compose change is needed. The unrelated outside issue summary is not accepted delivery evidence.

## Concrete details to close before final review

1. **Complete Docker topology and trust configuration.** A Caddy container's default bridge-loopback is not the host Flux loopback. The tested command must explicitly use Linux Docker Engine host networking when its upstream is `127.0.0.1:<FLUX_PORT>`, and name that verified platform. Show persistent Caddy data/config mounts and the exact Caddyfile and matching Flux environment lines. Initially leave Flux proxy trust empty, make an identifiable proxied request and observe the API socket peer before trusting it. Configure that exact IP or `/32` (`/128` for IPv6), restart Flux and verify the current result. The own project's NAT gateway can be correct; it is not an identity uniquely belonging to Caddy. Keep the Flux port loopback-only; do not trust every private range or all addresses. Distinguish Flux's `FLUX_TRUSTED_PROXIES` from Caddy's similarly named option: the direct-edge example needs no trust for arbitrary client-supplied forwarding headers.

   A small real regression can verify that a signup/signin session's stored `auth_sessions.ip_address` matches the actual Caddy client address, and that an injected `X-Forwarded-For` through Caddy does not become that address. This is a meaningful check of the documented value rather than assuming `127.0.0.1`. Source confirms Fastify trusts only configured socket peers (`app.ts:65`), and the auth bridge passes `request.ip` while removing caller-controlled forwarding headers (`identity/bridge.ts`). Re-observe the peer if the project network is recreated.

2. **Packaged INSTALL portability.** `scripts/release/prepare_assets.py` copies `release-guide.md` directly to standalone `INSTALL.md`; `tests/test_release_assets.py:165` explicitly requires every guide Markdown link to start with HTTPS. The step4 link therefore needs an absolute GitHub HTTPS URL to the guide, preferably a pinned commit/tag containing it. Use relative links from repository-only install-release step5 and the operations index. The guide must distinguish source `docker/.env`/`./flux up` from release `.env`/`docker compose --env-file .env -f compose.yaml ...`; do not imply a release ships the source launcher or optional live Compose overlay.

3. **Actual auth and message proof.** Exercise UI sign-UP on `https://localhost:19443`, then actual UI signout/sign-IN. Existing API-created fixture accounts plus cookie injection alone would leave the signup path unverified. Use two independent real browser sessions in the same project, capture a real WebSocket101 and received frame corresponding to the new message, and show it in the other browser without a document reload. Check the HTTPS session cookie's Secure/HttpOnly attributes and the exact origin in discovery/challenge data. Keep passwords, session cookies/tokens and the CA private key out of tracked evidence. This does not require a new app test suite or complete OAuth issuance/media acceptance.

## Proxy semantics and dated primary research

Use the current official `caddy:2.11.7-alpine`, updated from the initial2.10.2 plan. The official release is v2.11.7 and the official image page currently lists that version. Record the actual `caddy version`, platform, immutable pull manifest digest and runtime image ID, rather than treating the mutable tag as immutable evidence. [Caddy v2.11.7](https://github.com/caddyserver/caddy/releases/tag/v2.11.7), [official Docker image](https://hub.docker.com/_/caddy).

A bare whole-origin HTTP `reverse_proxy 127.0.0.1:<FLUX_PORT>` preserves method/URI and ordinary headers, including Host. Caddy manages forwarding headers, rejects caller-supplied forwarding values by default and supports WebSocket upgrades/tunneling. Do not add `handle_path`, path rewrites, Host overrides, authorization stripping or broad buffering directives. Current docs include features added after2.10; the updated actual2.11.7 runtime avoids version ambiguity. [Caddy reverse_proxy documentation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

Public ACME guidance should state correct A/AAAA DNS, externally reachable80/443, Caddy binding/forwarding and persistent writable data. Keep this separate from the actual `localhost:19443` + `tls internal` control. Caddy internal TLS uses its local CA and does not establish public ACME; clients must trust that CA. Export only the public root certificate and verify curl with `--cacert`, not `-k`. If browser automation ignores local certificate errors, say so explicitly; that verifies routed behavior, not installed browser/device trust. [Caddy Automatic HTTPS](https://caddyserver.com/docs/automatic-https).

Name `/api/v1/stream` upgrades and the optional `/media/*` signaling paths. Existing live source exposes `/media/rtc`, `/media/rtc/v1` and their validation paths through the API; the actual RTP/ICE/TURN reachability remains the existing overlay's separate documented requirement. Proxying `/media` is not a claim of public media transport or full live-session verification.

## Criteria and exact evidence to hand off

| Criterion | Plan assessment | Final status now |
| --- | --- | --- |
| One complete tested proxy example with matching origin/trust environment | Accepted, with explicit network and measured socket-peer procedure above | Unverified |
| Install-release step5 and operations index links | Accepted; include portable release-guide step4 link | Unverified |
| WebSocket upgrades and optional `/media` named | Accepted whole-origin proxy; overlay transport distinction preserved | Unverified |
| Versioned actual HTTPS signup/signin, two-browser message, metadata200 and MCP401 | Accepted after #326 heavy slot; use real UI/frame proof and CA-verified curl | Unverified |
| No application or maintained Compose change | Clean prepared base; source-equivalence check required at final head | Unverified final head |

Run the fresh isolated Flux source stack after the coordinated #326 slot, with exact `FLUX_PUBLIC_ORIGIN=https://localhost:19443`, separate project/ports/volumes and the measured narrow proxy IP. Preserve actual metadata body200 and `POST /mcp`401 headers whose `WWW-Authenticate` names `https://localhost:19443/.well-known/oauth-protected-resource/mcp`; verify discovery uses the same public MCP resource origin. Record current source/test harness SHA, Caddyfile, harmless configuration, full command results, actual images, browser result and raw realistic screenshots. Retain any failure as a failure rather than replacing it with source-only prediction.

At final docs/evidence head run setup, full foundation tests, full-base whitespace and release-asset self-contained/link checks; validate the actual Caddyfile in its pinned official image. Prove `app`, maintained `docker`, and scripts are unchanged from9d. I ran no implementation checks or runtime at this planning stage. Final independent source/evidence review still required; no eligible approval/merge claim follows from this plan assessment.
