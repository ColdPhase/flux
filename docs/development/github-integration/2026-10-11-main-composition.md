# GitHub task rules: current main composition — 2026-10-11

Partial #74 / PR #379, branch `claude-hubert/74-github-standing-rules`.

The branch includes the already reviewed rule-pin fix and #388 dormant GitHub
export. Main `6e81027988527aa4b34e4cd7ae0f363b422d6a2b` is normally composed
at `f2d172fb32e50288bef3283c8daf5c8dea02fd43`.

Three conflicts retain both intended changes:

- CHANGELOG keeps the GitHub rule/export entries and every main entry.
- The DB index keeps main schema 72 and its morning-summary compatibility export;
  migration 0068 and its reverse file remain unchanged.
- Export tests keep the GitHub dormant-rule/repository-privacy test and main's
  quiet-hours leak checks, including their negative controls.

The GitHub source/route/repository implementations equal the reviewed `7721318a`
inputs. Main's index/0072/summary preflight and Docker/scripts/workflows are intact.
Post-composition changes are verification only: exact one manual-override history
and blocker contribution assertions, real lower-gap migration coverage, actual
browser-engine selection, and a portable external-provider page fixture.

## Actual Docker evidence

API pin **06edfe6aa62f83dbb41fccd22f13e3168be509bd**: **64/64 PASS**, no
failures/skips, 37.208s. This covers rules, core rules, GitHub, JSON/bundle/stream
export, extension contracts, migration ledger, morning-summary migration,
native work reads and the new revision-migration case.

The real migrator starts from retained schema 0072 with only 0068 absent. It
applies exactly 0068, preserves the task, suspended rule, binding/history and
morning-summary preferences/notification, and reaches the exact complete ledger.
A real restart changes none of those facts. Pre-use 0068 reversal preserves
0072 and the original data; a real re-upgrade restores revision 1. The strengthened
native retry test proves the first override appends one history and one blocker
contribution and that replay/conflict adds neither.

Browser pin **e3cc638e6ea16f06957baa0f1ec65a5c97c02b73**: both original
GitHub rules and settings/linking journeys PASS in actual Chromium and WebKit,
**1/1 per module per engine**, no skips, driver exit 0. Rules: 7.879s Chromium /
9.560s WebKit. Settings/linking: 10.685s Chromium / 17.832s WebKit. Every original
assertion remains; engine identity is checked in the fixture. The browser cases
use actual sessions/routes/SQL with an injected GitHub transport. Their original
service-worker blocking policy is retained, so this is not PWA acceptance.

The pinned WebKit interception backend refused the fixture's fulfilled 302 before
callback navigation. The external-provider stub now returns a page that navigates
to the same real callback with the original state/code/installation parameters.
The callback's own HTTP redirect and OAuth state/PKCE/cookie/SQL checks remain real.
This is fixture repair, not real GitHub authorization/installation evidence.

The later browser pin changes only that fixture. All API production/test/config
inputs equal the actual API pin; those 64 tests remain attributed to 06edfe6a.
Both actual test images matched all **1106 tracked application files**, zero
mismatches. Docker build/type/lint passed with three existing hook warnings.
Setup, 102 foundation tests and diff checks passed. Own ports 19940/19941,
IPAM 10.199.200–202, resources, per-run images and temporary secrets were isolated
and cleaned. No host application dependencies/services were installed.

Evidence: `/tmp/flux379-composition/verification-proof.json`, manifests,
`api-source-equivalence.json`, retained API/browser logs and runner scope.
Earlier failed fixtures/runs are retained separately and not relabelled PASS.

## Remaining acceptance

Fresh eligible exact-head Zamojski5 review, resolved threads and required current
checks are necessary for protected merge. This increment does not close #74:
real GitHub App installation/authorization, G-1b–G-1d and the #153 recipient,
echo-suppression and eligible external-review gates remain required work.
Private-source/import proposals remain separate and off; this increment does
not admit or complete them. No full
`check_application.sh`, broad application/release, real-provider or PWA acceptance
is claimed by these selected cohorts. Older 1103/489 counts retain their original
4335f81c pin.
