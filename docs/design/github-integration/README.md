# Project GitHub settings evidence (#74)

Neutral review brief: a project manager explicitly selects one installed
repository and verifies an existing PR beside an existing Flux task. Keep the
forms readable and compact, identify private-source access, original authorship,
current commit and verification time, and avoid suggesting that checks/merge
complete native acceptance. Phone/tablet controls must remain usable and the
page must fit its viewport. Use the current Flux tokens and useful Studio density.

Captured 2026-10-01 against the source tree committed as
`a6d7d7c9afea3bebfa94fd2c33e12e88689d55ad`, after integrating accepted layout
`7af78f29c7da3799a57bf204b343b5647516afc5`. The running web application, Flux
session, route composition and SQL are real; only the external GitHub transport
and browser provider redirects are explicit test fixtures. This is not a real
GitHub installation or physical-device/PWA acceptance claim.

| Viewport | Settings | Linked PR |
| --- | --- | --- |
| Desktop, 1440 × 900 | [Settings](github-settings-desktop.png) | [Linked view](github-settings-desktop-linked.png) |
| Tablet, 820 × 1180, touch | [Settings](github-settings-tablet.png) | [Linked view](github-settings-tablet-linked.png) |
| Phone, 390 × 844, touch/mobile | [Settings](github-settings-phone.png) | [Linked view](github-settings-phone-linked.png) |

The pane scrolls independently of the application header; pairs retain the
settings context and the lower PR projection. Screenshots support a separate
visual review; they do not prove behavior or authorization.

The Docker browser journey in
[`github.e2e.ts`](../../../app/tests/app/e2e/github.e2e.ts) passed OAuth callback,
installation selection, manager Details entry, binding, verified linking,
own-reader access, Flux-only member denial, access-loss clearing, conversation
navigation and unchanged native work. The focused
Docker suite passed 30 SQL/API/work/migration/architecture checks, including raw
signatures, isolation, current-state reconciliation, revocation and the compiled
restore-maintenance command. Build, typecheck and lint passed. The full Docker
application check passed at production-identical `93d3ecbd89050e96dd2681b07b54c3e4465bc719`:
341 app tests, PWA/access-stream/GitHub browser journeys, persisted session restart
and unavailable push/email checks. The only subsequent source change extends
the GitHub browser test to exercise the manager entry and viewer exclusion; the
focused suite and browser journey passed again at the captured source above.
The complete `scripts/check_backup.sh` passed against `93d3ecb`: backup/export,
fresh restore with real data/sessions/permissions, agent-revocation modes,
upgrade from schema 25 to 36, migration failure, post-start failure, actual source
layout rollback and re-upgrade with the original custom project. It used supported
task-owned `TMPDIR` on the spacious `/home` filesystem and the unchanged 20 GB
preflight; it did not remove shared caches or relax the gate. The focused GitHub
SQL suite separately verifies revoked restored credentials/flows/processing and
retained unavailable source facts through the compiled maintenance command.
No independent runtime or visual approval is claimed by the author.

The misleading selected Conversation tab is corrected and tested. The ordinary
header's “No decisions or work yet” beside Tasks 1 remains a shell finding handed
to [#136](https://github.com/ColdPhase/flux/issues/136#issuecomment-5920873692);
these frames preserve that actual-state discrepancy.

Native standing rules/publication, #153 targeted consumption/eligible external
publication, portable source export/import, real App and integrated device/task
acceptance remain required by the unchanged whole-issue contract. PR stays draft.
