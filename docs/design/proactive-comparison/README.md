# Project comparison suggestions (#58)

The [1440×900 screenshot](project-tasks-1440.png) shows a restricted sensor
project's Tasks surface at 100% zoom with two negative low-light results, their
separately sourced agent suggestions and the ordinary result list. It was
rendered from persisted Docker seed data at application commit `2c51b1e` on
2026-09-28. The two result titles are intentionally distinct while the shared
interpretation and next step repeat, making scanning pressure visible.

The browser journey in `tests/app/e2e/proactive-comparison.e2e.ts` separately
checks an exact source-message route, edit/reload, use as work, dismissal and
manual work after the suggestions are gone. The screenshot does not establish
those interactions, phone layout, accessibility or real provider behavior.
