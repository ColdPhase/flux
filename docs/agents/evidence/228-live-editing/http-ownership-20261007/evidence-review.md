# Independent evidence-only delta review — d5bf0be2

2026-10-07. Read-only inspection of `docs/agents/evidence/228-live-editing/http-ownership-20261007/`, currently untracked on production head `d5bf0be2a8a96c943397262add758e64c9ed4b43`. **PASS for this evidence delta; no source or GitHub edits.**

All three stored gzip files decompress byte-for-byte to their respective `/tmp/flux228-http-{baseline,baseline-files,candidate}.log` originals. Independently verified original and stored byte lengths and SHA256 against every manifest entry, plus deterministic gzip mtime0. The supplemental Compose file is byte-identical to `/tmp/flux228-http-files.compose.yaml`. Validation record: `/tmp/flux228-evidence-validation.log`.

The clean-source precondition, exact source IDs, per-run project IDs, actual build image IDs, Docker commands, complete counts and exits are supported by the control script and raw logs. The valid baseline is14 total /11 pass /3 fail / exit1. Candidate is14 total /14 pass /0 fail, cancel, skip or todo / exit0; recorded duration8148.89671ms rounds correctly to8148.897ms. Both valid logs include their project cleanup and two-tag removal; a current inventory has no matching project containers/volumes. The first missing file-store mount is correctly described as harness failure, separate from the three valid product controls.

Verified source equivalence `4034654e` → `06b8cc9d` outside the single test file. Verified the only candidate test delta is moving the real COMMIT hold's arming point until after the actual first room join. Expectations, capacity and deadlines are unchanged. The candidate runtime is attributed to its source and images rather than an unrelated old branch or a future evidence commit.

README accurately limits the result to bounded HTTP/SQL lifetime and ordinary roomless isolation. It preserves draft/default-off status, all four gates, failed older partial latency evidence, full cohort/zero-gauge obligations, current-main/dependency composition and final-design requirements. It does not claim overall live acceptance. Foundation PASS counts match my own74-test run on exact d5.

The directory is not committed at this review. After committing it, record the exact documentation SHA; source-equivalent application evidence remains pinned to d5. Main source review: `/tmp/flux228-lifetime-independent-d5.md`.
