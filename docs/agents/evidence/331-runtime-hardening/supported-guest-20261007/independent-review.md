# Independent supported-guest evidence review: #331 / PR #359

**PASS for the mandatory bounded T3 runtime journey** at
`238fabf9f0ab5393e3ff630fce9dc9e6f700ac9d`, reviewed 2026-10-07.
The independently prereviewed seed was
`ba859169f0a906e2ab4ba92bb4a39659216385107d0577de08fc92bd24742528`.
This is source/evidence evaluation, not eligible GitHub approval or whole-release
acceptance. I read and validated actual operator artifacts; I did not rerun the VM.

## Verified provenance

- The actual serial export decodes to archive SHA256
  `149f6e6b385ac75cffeb092f49f3ebe6b16a6560622f691c0d87e899b1fca06a`.
  I independently verified the exact39-file set and every byte hash against
  `provenance/guest-evidence-manifest.json` and the extracted evidence directory.
- Recorded clean source/head and all three original script/probe hashes match
  Git238. The trusted, prereviewed wrapper changes no application source or
  acceptance script. Public022 checkout/copy permissions preserve code bytes;
  private logging/sanitization remains as reviewed. Launcher copies deliberately
  omit.git and report unknown; attribution comes from source bundle/head/script
  provenance rather than claiming those copies have a Git label.
- Genuine guest Ubuntu24.04.5, kernel6.8.0-142-generic, CONFIG_SECURITY_YAMA=y,
  active yama LSM and actual policy1 before/after rebooted verification. Docker
 29.8.2, Compose5.6.0 and pinned Node/Postgres are recorded. Signed Noble base and
  exact ISO/source pins remain independently checked; physical host policy stays0.
- Image manifest/config mappings are in the build log and operator report. The
  post-cleanup image inventory contains only remaining bases/control image and is
  not represented as the complete live application inventory.

## Observable result

The unchanged fifteen-step script exits0, and the stricter wrapper exits0. I read
the complete relevant transitions and parsed all39 network results as passing.

- Native live supervisor: uid1000 cannot open environment/memory or signal an
  inspector. The same parent→child unprotected control can do all three; native
  protection alone blocks environment/memory but leaves SIGUSR1 inspection;
  combined protection denies all three. Real Yama1 does not counterfeit this
  strongest permitted-parent negative control.
- All five actual slots use1000:1000, read-only root, cap-dropALL/NNP, pids256,
  memory2GiB/oneCPU, a single private slot network and128MiB tmpfs. Declared fifth
  slot matches the anchor. Five inspection mutations are refused; supervisor
  closed-request/secret/slot checks pass24/24.
- Ordinary same-network controls reach actual DB/API, public1.1.1.1:443 and a
  genuinely listening guest-default-bridge172.18.0.1:18009. Runtime1uid1000 gets
  ENETUNREACH to those prohibited targets, including the identical18009 service;
  open or refused would fail that control. Public guest/container reachability
  remains open before/after. Allowed vendorCONNECT really returns200, not502.
  The outer guest firewall cannot manufacture these same-endpoint comparisons.
- Actual ownerAPI bindings differ; five-slot pool fills. Release reports confirmed
  fake-CLI signout, changes boot to19361c66-a9e6-46ac-8dfa-cb235f8608e8, asserts
  empty data/tmp and restart before the same slot is reused for another owner with
  a new binding. Dirty data excludes a slot until corrected/restarted.
- Operator release, credential-excluding backup with a deliberately present fake
  marker, restore reconciliation/sign-in-again/orphan cleanup and no-marker logs
  all pass. Runtime-off keeps volumes; off→purge signs out fake Claude/Codex and
  clears bindings/volumes. Reset signs out first and removes slot volumes.
- The public same-source COPY/root-owner644 control reads correctly as uid1000.
  Private.env is observed600 without contents. Final guest containers/volumes are
  empty; QEMU868364 is absent and PID/QMP files are gone. Owned failed/successful
  disks and sanitized artifacts remain recoverable; no active VM remains.

The retained printf I/O diagnostic after step14 is from the existing tolerated
status→grep-q pipeline closing its output early. It is not hidden or called a
clean-log/full-application pass; required purge/reset assertions still run and pass.

## Acceptance scope

| #331 prerequisite | Assessment |
| --- | --- |
| M1 supervisor/process isolation | Pass with actual supported-host native positive/negative controls, prior strict startup refusal tests and source review |
| m1 runtime-off cleanup | Pass for the integrated fake-CLI off→purge/reset journey plus prior real proxy-server switch-off regression/source evidence; no actual vendor account/logout claim |
| m2 honest unconfirmed logout | Prior source and43 runtime/3SQL/six launcher regressions remain required evidence; current journey adds the confirmed successful cleanup path. Standalone T4 signOut at279 still needs its separate correction |
| m7 scope/wording | Deferred publication/operator assets are tracked in358 and installer wording corrected; tracking is satisfied, packaging is not delivered |

The previously missing supported-host journey no longer blocks technical review of
these bounded prerequisites. Normal current-head checks/resolved threads and
eligible independent GitHub review remain before merge. A subsequent evidence-only
commit needs source-equivalence/documentation assessment; no old approval is forged.

Whole331 remains open: m3/m4/m5/m6/m8/m9 and their accepted-risk/implementation
resolution are not completed by this run. #358 remains open: no published separate
runtime image, release assets/download installation, amd64/arm64 final candidate
or real installer-through-egress acceptance. No T4–T6, real vendor credentials,
all-kernel/Yama2–3/IPv6 matrix or whole release verdict is supplied. Cloud metadata
and private external targets use combined guest containment; the explicit public
and listening guest-host comparisons independently demonstrate inner denial.

Earlier failures stay failures: attempt1 migration permissions (28-file archive),
attempt2 unknown silent control predicate (25 files). Their artifacts are preserved
separately and not used as success. My previous temporary count31 for attempt1 was
incorrect; the actual manifest has28 files, and every listed hash was checked.

Next: root records the reviewed sanitized evidence and exact limitations on the
existing PR359; eligible Zamojski5 review and protected-main gates follow. Resume
the preserved279 artifact with these dependency changes and its independently
agreed operation-fence contract, without marking whole331 or the app complete.
