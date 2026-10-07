# #331 supported-guest operator result — 2026-10-07

**Outcome:** the unchanged `scripts/check_agent_runtime.sh` completed all 15 steps at source `238fabf9f0ab5393e3ff630fce9dc9e6f700ac9d`, exit 0. The reviewed wrapper's additional controls also passed, exit 0. This is supported-host T3/native/pool/cleanup evidence, pending independent evidence evaluation; not eligible GitHub approval or release acceptance. No GitHub, application source or branch edits were performed.

## Provenance and exact pins

- Owned 0700 directory: `/home/hubert/flux-331-kvm-20261007`. Direct QEMU 9.2.4 as host uid 1000, KVM/q35/4 vCPU/8 GiB/80 GiB sparse fresh overlay. No libvirt/existing VM, host shares/socket/agent, SSH/public forwarding or host/global sysctl/firewall/service changes.
- Official readonly [Noble20260926 image](https://cloud-images.ubuntu.com/noble/20260926/noble-server-cloudimg-amd64.img), SHA256 `6a81c37564db9b1ee84e141922625e1d7c5b389b99bb3c572e0243607d5bb4d2`. Signed SHA256SUMS verified against published UEC fingerprint `D2EB44626FDDC30B513D5BB71A5D6C4C7DB87C81` ([official verification guidance](https://ubuntu.com/docs/public-images/public-images-how-to/verify-image-checksum/)); signature/provenance kept in `provenance/`.
- Single HEAD tracked-source bundle SHA256 `1c0f684fa3d79b0ae14335aa649f512103933ba23ee4a14a4457adee1dfa00b1`; clean original guest checkout at 238. Launcher test copies deliberately lack `.git` and report `unknown`; attribution is the recorded original source/head+script hashes, not a fabricated launcher label.
- Final reviewed NoCloudISO SHA256 `ba859169f0a906e2ab4ba92bb4a39659216385107d0577de08fc92bd24742528`. Exact wrapper/seed file hashes: `provenance/bootstrap-file-hashes.txt`; review and attempt ledger: `provenance/host-manifest.json`, `provenance/attempt-ledger.json`.
- Actual guest Ubuntu 24.04.5 amd64, kernel 6.8.0-142-generic, CONFIG_SECURITY_YAMA=y and active LSM yama; genuine proc Yama 1 after reboot and after testing. Docker 29.8.2 / API 1.56, containerd 2.3.6, runc 1.5.1, Compose 5.6.0, Buildx 0.37.1; exact package pins and security configuration are exported.
- Node base digest `ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1`, actual Node 24.21.0; Postgres digest `77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873`.

### Source/image/environment mapping

All following groups use the same source 238 and guest/kernel above. `runtime-sanitized.log` preserves BuildKit manifest/config/list digests and rebuilds; live tags and security fields are in `live-security-fields.json`. Cleanup removes test images, so `images.txt` is the post-cleanup inventory rather than a complete live image list.

| Evidence group | Actual image/config mapping | Environment and proof |
| --- | --- | --- |
| Core/API, worker, manager, egress | `flux-foundation:flux-8c90dc32`; manifest `2966018831fe963532a26b66fb2f42650bc9a466d70416e219fd578df7d222a8`, config `9c45903850f6aa3278466fea62e5733513b2066dc8e0c2d3c8a78bc775936f40` | Real guestDocker/API/Postgres. Testproject `FLUX_PROJECT=flux-8c90dc32`, ports 19571/19572/19573 only inside guest. Owner/negative controls step 4; original fixture `FLUX_AUTH_RATE_LIMIT=false` for repeated synthetic signins. |
| Native and five slots | `flux-agent-runtime:flux-8c90dc32`, test overlay `agent-runtime-test`; manifest `987a59c80661bf6341ab62608f760f71c700f9bf6de583a480fdcdb51e94e57d`, config `4205113e8c010385319d6a07933c6773e6bc1be89df68c994aa73927ef5d486d` | Genuine Yama 1; actual uid 1000:1000, read-only root, cap drop ALL, NNP, pids 256, 2 GiB/1 CPU each, isolated slot network without gateway, tmpfs 128 MiB. All 5 settings match; native and supervisor probes steps 5–6. |
| Live test fixtures | `flux-test-tools:flux-8c90dc32`; manifest `7e9b1d28faf79a2cb06ff27f5f1e970c52a7a52c061763c2271997d0e929cf0e`, config `6203a880f421b8009c5e1ace3b3785acef3b6e4e3b6119a2cb68ebab1767ea48` | Scripted realAPI/DB calls with generated synthetic owners, no realvendor credentials. |
| Pool/release/reuse | Same core+slot+fixture images above; installer testmanifest `4bc49157e0b897b34e4b994d2a2862ecd1373fbe351ba8a980b2042a4f981d3b` | Runtime off by default; `claude_code` + original Commercial Terms date 2026-10-05 for teston. Generated secrets stay private; observed `.env` 600, contents not read/exported. Fake CLIs only. Ready 5/pool full, signoutfalse failure flag, new boot and empty data/tmp before second owner: steps 4/7. |
| Off→purge/reset | Same contentmanifest/configs (index attestations vary on rebuild, actualvalues retained inlog) | Runtime empty in 13, vendor-specific fake sign-outs successful in 14, all bindings/volumes cleared, then original on/reset 15. No script/gate modification. |

Script SHA256 `de29d519abf025b71b8bef55c2737447482a616078c79271991cfdeb74ccd886`; processprobe `a843b0cd9c9a288f3008aab8ea2a087de34ad3c355c33bfecef16de74c56bf2e`; networkprobe `a0d666b8e2d5a8dcce7950d260be2245e02d5106084e1539bf0a341dc2d75fc6` (`unchanged-script-hashes.txt`).

## Actual results and locations

Native controls: live CLI uid cannot read supervisor environment/write memory/open inspector; unprotected env/memory + SIGUSR1 inspector accessible; native-only env/memory denied but inspector accessible; hardened all denied. Network probe 39/39 and closed supervisor 24/24. Exact statements are log 1107–1110, 1312, 1440. Ready5 andpoolfull at 1084–1104. Release `SIGN_OUT_FAILED=false`, `NEW_BOOT=19361c66-a9e6-46ac-8dfa-cb235f8608e8`, same runtime1 reused with new binding, `/data`/`/tmp`empty asserted, fake marker absent DB:1442–1455.

Additional controls: source COPY root owner 0 / mode 644 readable by actual uid 1000, same source hash. Guest+ordinaryDocker public 1.1.1.1:443 open before/after; same original runtime probe blocked. Ordinary default bridge container reaches actual DB 5432 / API 8080 and genuinely listening guest 172.18.0.1:18009; live runtime-1 uid 1000 to identical 18009 returns ENETUNREACH. Guest SSH 22 reachable from ordinary container,2375 refused (reachable host). Strict allowed proxy `CONNECT api.anthropic.com:443` returned 200, not 502. Raw script's login-marker check passed before exporter redaction. JSON control files contain actual outcomes.

| Original step | Result | Log start line |
| --- | --- | --- |
| 1. Off by default: no runtime service starts and the API reports the feature disabled | PASS | 4 |
| 2. Switch on (claude_code with the Commercial Terms date); the fifth slot gets its secret | PASS | 600 |
| 3. docker inspect: limits and security options on every slot; no engine socket anywhere | PASS | 1058 |
| 4. Two owners get two slots; no API input reaches another owner's slot; the pool fills | PASS | 1084 |
| 5. Escape attempts from inside a slot | PASS | 1106 |
| 6. The live supervisors refuse anything outside the closed set | PASS | 1315 |
| 7. Release: sign out, delete, confirm /data is empty, exit; a new boot id and an empty /tmp before the next owner | PASS | 1442 |
| 8. Bind is refused while /data holds any entry; the operator sees the slot out of the pool | PASS | 1457 |
| 9. Operator release from ./flux runtime release | PASS | 1491 |
| 10. ./flux backup contains no slot volume | PASS | 1504 |
| 11. After a restore: a binding without a directory shows Sign in again; a directory without a binding is signed out and deleted | PASS | 1539 |
| 12. Logs: no fake login marker in any service log | PASS | 1821 |
| 13. Switching off stops the runtime and keeps the slot volumes | PASS | 1824 |
| 14. ./flux runtime purge signs out and deletes every login | PASS | 2019 |
| 15. ./flux reset signs out first and removes the slot volumes | PASS | 2037 |

Final `Agent runtime check passed.` at 2602. Off→purge fake Claude/Codex signout succeeds at 2021–2022, reset at 2513. A harmless existing `printf` I/O error appears after the step 14 status-to-`grep -q` pipeline (script explicitly tolerates it); it is preserved, not hidden or classified as a failed required check.

## Retained evidence, failures and cleanup

Sanitized 39-file archive SHA256 `149f6e6b385ac75cffeb092f49f3ebe6b16a6560622f691c0d87e899b1fca06a`; exact per-file SHA256 map in `provenance/guest-evidence-manifest.json`. Artifactdirectory `evidence/` contains full 2602-line sanitized journey, wrapper/control JSONs, security fields, live/before/after firewalls, versions/kernel/Yama/source pins and empty post-cleanup inventories. Reviewed sanitizer 17 controls plus independent original 4 regressions passed; allowlisted text artifacts all sanitized. Private raw serial/base64/disks are not publication material.

1. Attempt 1 ISO c97feaaf...: genuine source 238 script failed step 1 with migration package permission denied; wrapper global umask 077 caused checkout 600/700, reproduced with identical package bytes vs 022. Preserved `first-failure/`,28-file archive SHA256 `7543f6e96e78d5f4637d8e09ff236203aabddf3108fec02683f02fc466af5c0f`. Not a product bug claim or pass.
2. Attempt 2 ISO 1a536353...: additional docker-cp control's silent uid/owner/mode/hash predicate failed before product script; exact predicate unknown. Preserved `second-precontrol-failure/`,25-file archive SHA256 `0a28d28041464f6809706068c7023b5f17f67e856ca3376d6977fcbea136a0a4`. No Docker defect or product verdict claimed.
3. Attempt 3 exact ISO above: scoped 022 public source assembly only; original private .env/backups and outer logs/export 077 retained; faithful COPY/USER control diagnosed safely, full script + wrapper PASS. Neither earlier failure is reclassified.

QEMU PID 868364 gone, qemu.pid and QMP socket absent, session 12244 exit 0. Guest post-cleanup containers 0 / volumes 0. Physical host proc Yama remains0, no physical host firewall/sysctl/service/VM manager changes. Owned read-only base, seed, source bundle, failed/successful disks and sanitized manifests remain recoverable for independent evaluation; no active VM/public listeners/shares. Do not publish raw disks.

## Limits and next actor

Only this Ubuntu/kernel/Docker/Yama 1 configuration is observed. No physical host Yama 0 running acceptance, Yama 2/3 or complete kernel/IPv6 matrix. QEMU restrict OFF plus guest external ens3 private/host denial preserves ordinary public positive controls; the outer private filter means cloud metadata/private external probe outcomes are combined containment, while identical public and genuinely listening default bridge host comparisons independently demonstrate inner network denial. Exact guest nft/iptables files retained.

No actual vendor login/logout, m9 installation through egress, packaged publication #358, T4–T6 or complete release acceptance. Source/evidence peer must independently assess the 39-file set at 238; root alone will later record reviewed evidence on its branch and update PR #359/GitHub with normal eligible protected-main gates.


## Committed handoff record

The source tested above remains `238fabf9`. This commit adds all 39 sanitized
guest artifacts in `guest/`, their extracted-file manifest and the independent
evidence review. It changes no application, launcher, runtime or test source.
The reports retain their tested source SHA and bounded scope. The local Compose
project name is presented as `FLUX_PROJECT=...` to distinguish it from a skill.

Text transcripts with progress whitespace are stored as deterministic gzip files;
decompression reproduces their original bytes exactly. `storage-map.json` maps
all original names and SHA-256 values to the committed representation. The guest
manifest describes those original extracted bytes, not compressed bytes.

Eligible GitHub approval, current-head checks and the remaining #331/#358
outcomes are still required. Original private VM disks, signed-image/bootstrap
provenance and both failed attempts are preserved locally; they are not
application artifacts.
