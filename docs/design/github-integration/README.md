# Project GitHub settings evidence (#74)

Neutral review brief: a project manager explicitly selects one installed
repository and verifies an existing PR beside an existing Flux task. Keep the
forms readable and compact, identify private-source access, original authorship,
current commit and verification time, and avoid suggesting that checks/merge
complete native acceptance. Phone/tablet controls must remain usable and the
page must fit its viewport. Use the current Flux tokens and useful Studio density.

Captured 2026-10-01 against the source tree committed as
`10580f529f20e6f9d6604b48644fdb885b06f422`, after integrating accepted layout
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
installation selection, binding, verified linking, own-reader access, Flux-only
member denial, access-loss clearing and unchanged native work. The focused
Docker suite passed 30 SQL/API/work/migration/architecture checks, including raw
signatures, isolation, current-state reconciliation, revocation and the compiled
restore-maintenance command. Build, typecheck and lint passed. Full backup
round-trip was attempted but refused by its existing 20 GB free-space preflight
(15 GB available); this remains unverified. No independent runtime or visual
approval is claimed by the author.

Native standing rules/publication, #153 targeted consumption/eligible external
publication, portable source export/import, real App and integrated device/task
acceptance remain required by the unchanged whole-issue contract. PR stays draft.
