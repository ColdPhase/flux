# Pending changelog entries

A pull request that changes what people or operators see adds one file here instead of
editing [CHANGELOG.md](../CHANGELOG.md). Separate files mean parallel pull requests no
longer conflict on the same changelog lines.

- Name: `<number>-<slug>.<section>.md`, where `<number>` is the PR (or issue) number and
  `<section>` is one of `added`, `changed`, `deprecated`, `removed`, `fixed`, `security`.
  Example: `468-search-projects.added.md`.
- Content: one or more lines starting with `- `, written like the existing changelog
  entries, ending with the PR link.

`python3 scripts/changelog.py check` validates the files (it also runs in the agent setup
check). `python3 scripts/changelog.py show` prints what is pending. At release time,
`python3 scripts/changelog.py release <version> <date>` moves every pending entry into
CHANGELOG.md under that version and deletes the files.
