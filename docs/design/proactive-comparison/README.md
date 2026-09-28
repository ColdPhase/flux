# Project comparison suggestions (#58)

The [1440×900 screenshot](project-tasks-1440.png) shows a restricted sensor
project's Tasks surface at 100% zoom with one human work item, two negative
low-light results, two collapsed, separately sourced agent suggestions and the
ordinary work/result lists. It was rendered from persisted Docker seed data
on 2026-09-28. The two result titles are intentionally distinct. Opening a
suggestion reveals its fact, interpretation, next step, citations and human
actions; the collapsed state keeps ordinary work visible before review.

The browser journey in `tests/app/e2e/proactive-comparison.e2e.ts` separately
checks an exact source-message route, edit/reload, use as work, dismissal and
manual work after the suggestions are gone. The screenshot does not establish
those interactions, phone layout, accessibility or real provider behavior.
