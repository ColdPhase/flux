# Browser and CI results

Source head: `7084120254f35c44ca542b29941aee873abe1938`.

## Selected functional journeys

- Chromium on production-equivalent source `46f635e9234dceca5eab453d8a12754c3c74ba48`: 14/15 passed. The sole failure was PhoneFinal09 expecting the old `Your tasks` H1; under current Home routing, the heading is Home and the fixture's empty-task H2 is `Nothing is waiting for you`.
- Chromium exact head `70841202`: corrected PhoneFinal09 passed 1/1. The only intervening change is that test expectation.
- WebKit exact head `70841202`: AppShell02→03→04→04a, PhoneFinal01/03/05/07/09/10/11, and StopAndQuestions01→07→08→10 passed 15/15 in 51.841s.

The exact stdout/cleanup logs are `logs/chromium-46f635-selected.log.gz`, `logs/chromium-09.log.gz`, and `logs/webkit-15.log.gz`.

## Capture-only fixtures

The temporary PhoneFinal fixture opened project Details at 320×568 and 390×844, light/dark; the Details selector passed. HomeFinal's existing returning-user test captured the Home Continue card at 390×844 light, and the same fixture captured dark; 1/1 passed in 2.761s. The first combined attempt's Home wrapper failed before capture due to a Python binding error; its Details selector had already passed. The corrected Home wrapper passed on its own. No application assertion failed in either capture run. See `capture-run-record.md`.

## Required checks

- [Repository checks / Agent setup](https://github.com/ColdPhase/flux/actions/runs/38468634308) — PASS at `7084120254f35c44ca542b29941aee873abe1938`.
- [Application checks / Application validation](https://github.com/ColdPhase/flux/actions/runs/38468634319) — PASS at `7084120254f35c44ca542b29941aee873abe1938`.

## Scope

These results verify the selected phone-shell journeys, not the entire application or all of #341. Phone Tasks toolbar conformance is owned by #375 and must be checked after integration. The parent #341 remains open.
