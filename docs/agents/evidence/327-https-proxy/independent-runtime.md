# Independent live HTTPS probes — #327

2026-10-07. Evaluator `/root/kreska_fixes`, independent of author `/root`. Source worktree `/home/hubert/.codex/worktrees/327-tls-proxy/flux`, clean exact source `9d54135b7b13f6c932ccf4c6e080ae4ae48d2fa5`. Author-owned running project `flux327-https-20261007`; no code/GitHub edits, heavy build, container restart or cleanup by evaluator.

**PASS for independently exercised CA-verified metadata200 and MCP401 exact-origin controls. No finding in these controls or selected source/configuration.** This is partial runtime verification: final documentation and actual browser auth/message evidence still need independent evaluation.

## Own current runtime observations

Executed real curl twice: first while `FLUX_TRUSTED_PROXIES` was empty, then after the author's narrow-trust restart. Each request used `/tmp/flux327-runtime/root.crt` with `--cacert`, without `-k`:

```sh
curl --cacert /tmp/flux327-runtime/root.crt --connect-timeout 5 --max-time 15 -sS \
  -D <safe-header-file> -o <public-json-file> \
  -w 'status=%{http_code} tls_verify=%{ssl_verify_result} peer=%{remote_ip} port=%{remote_port}\n' \
  https://localhost:19443/.well-known/oauth-protected-resource/mcp
curl --cacert /tmp/flux327-runtime/root.crt --connect-timeout 5 --max-time 15 -sS \
  -X POST -D <safe-header-file> -o <public-json-file> \
  -w 'status=%{http_code} tls_verify=%{ssl_verify_result} peer=%{remote_ip} port=%{remote_port}\n' \
  https://localhost:19443/mcp
```

Post-restart probes also allowed two connection-refused retries with1s delay. Both completed normally, exit0, with no observed transient failure.

| Control | Before trust | After narrow trust | TLS result |
| --- | --- | --- | --- |
| Protected-resource metadata GET | 200 | 200 | verify0, peer127.0.0.1:19443 |
| Unauthenticated MCP POST | 401 | 401 | verify0, peer127.0.0.1:19443 |

Both metadata bodies identify `resource=https://localhost:19443/mcp` and `authorization_servers=[https://localhost:19443/api/auth]`. Both MCP challenges are exactly `Bearer resource_metadata="https://localhost:19443/.well-known/oauth-protected-resource/mcp"`. Independently parsed/asserted response statuses and values. All retained response headers contain neither Cookie nor Set-Cookie. No session/token/key values were recorded.

Raw safe outputs:

- `/tmp/flux327-independent-metadata-headers.txt`, `/tmp/flux327-independent-metadata.json`
- `/tmp/flux327-independent-mcp-headers.txt`, `/tmp/flux327-independent-mcp.json`
- `/tmp/flux327-independent-metadata-after-trust-headers.txt`, `/tmp/flux327-independent-metadata-after-trust.json`
- `/tmp/flux327-independent-mcp-after-trust-headers.txt`, `/tmp/flux327-independent-mcp-after-trust.json`

The exported public CA file SHA256 is `c615b993dc84ed52f84db24597d60f84c8dc41c941b29467f990beda0eb971d8`; certificate subject/issuer `Caddy Local Authority - 2026 ECC Root`, certificate SHA256 fingerprint `F8:B7:34:E4:41:19:78:99:16:47:1C:0B:3E:92:FB:FC:9E:0F:B1:45:2F:53:CD:80:7D:42:67:A3:31:CE:24:95`. No CA private key inspected or retained.

## Independently inspected running configuration and source

- Actual running Caddy reports `v2.11.7`. Container `flux327-caddy` uses host networking and image ref `caddy@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f`; actual image ID `sha256:f77f856a30f0004200b36b322d61da17fade31e24875699d77fb968399b9eb77`.
- Running Flux API image ID `sha256:88c32f72e2db627198c42dfe6c29701d566f0a2407f38226dfac406821478ea2`; loopback publication127.0.0.1:19373→8080. Selected nonsecret running API environment after restart confirms `FLUX_PUBLIC_ORIGIN=https://localhost:19443` and `FLUX_TRUSTED_PROXIES=172.27.0.1/32`. Initial source environment had empty trust. I inspected only selected safe environment fields, not secret values.
- Actual `/tmp/flux327-runtime/Caddyfile`: admin off, automatic redirects disabled and trust-store installation skipped for the local control; `localhost:19443`, bind127.0.0.1, `tls internal`, `reverse_proxy 127.0.0.1:19373`. No path rewrite, Host override or authorization-removal directive. This is a local HTTPS test configuration; it is not public ACME verification.
- Current source validates one explicit public origin, never derives it from Host/forwarding input (`identity/config.ts`, `identity/bridge.ts`). Fastify uses only configured proxy peers (`app.ts:65`); the auth bridge strips arbitrary forwarding headers and supplies its resolved `request.ip` to auth. Narrow-trust runtime value agrees with the source contract. Actual session-IP/spoofed-forwarding behavior is being checked by the author and is not claimed as independently reproduced here.

## Still required for final #327 acceptance

Independent review of the written guide/links, exact docs head and source equivalence; signup/signout/signin UI evidence, Secure/HttpOnly attributes without cookie values, real WebSocket101 plus received message frame and other-browser message without reload; measured socket-peer/session-IP and spoofed-forwarding control; final foundation/link/release-portability checks. The author's initial SELinux bind-label validation failure remains a setup attempt in `/tmp/flux327-caddy-validate-selinux-failure.log`, not a passing Caddy validation or product failure; final successful validation must be recorded separately.

These probes do not establish public ACME, browser trust-store installation, real devices, complete OAuth issuance, media/RTP/TURN or full release acceptance. Stack remains owned/live for the author's remaining browser checks. No eligible GitHub approval is implied.
