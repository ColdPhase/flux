# Project comparison suggestions (#58)

The [1440×900 screenshot](project-tasks-1440.png) shows a restricted sensor
project's Tasks surface at 100% zoom with one human work item, two negative
low-light results, two collapsed, separately sourced agent suggestions and the
ordinary work/result lists. It was rendered from persisted Docker seed data
on 2026-09-29 at code commit `d7ceb15f1e9438b1e890ec9013d8759c2dda46aa`.
Each collapsed row leads with its proposed next step; the
triggering result and observed fact sit underneath as context. Opening a
suggestion reveals its fact, interpretation, next step, citations and human
actions; the collapsed state keeps ordinary work visible before review.

The browser journey in `tests/app/e2e/proactive-comparison.e2e.ts` separately
checks an exact source-message route, edit/reload, use as work, dismissal and
manual work after the suggestions are gone. The screenshot does not establish
those interactions, phone layout, accessibility or real provider behavior.

A [fresh independent visual review](review-2026-09-29.md) found no visible blocker
in this collapsed desktop state. It records two refinements and its limited
evidence scope; it is separate from the running browser journey and peer code review.
