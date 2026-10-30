# Lead measures

- **Status:** agent decision under the [delegation](autonomy.md), 2026-10-30. Part of L-4 in the
  [v0.1 launch plan](launch-v0.1.md), tracked in [#308](https://github.com/ColdPhase/flux/issues/308).
  Owner: PelikanFix16 (took over from Zamojski5 on 2026-10-30 by founder direction).
- **Basis:** rules 17 and 20 of the [delivery playbook](playbook-the-5.md). One wildly important
  goal, a few lead measures, a weekly review. Count outside adopters and observed tasks, not our
  own enthusiasm.
- **Used by:** the [weekly review](weekly-review.md), which runs `python3 scripts/lead_measures.py`.

## What a lead measure is here

The goal is a runnable v0.1 on a clean Compose install that people outside the team can use. A lag
measure, such as "how many teams use Flux in six months", only reports after the fact. A lead measure
is something we can influence this week that predicts it. Five qualify. Everything else the script
prints is a reach signal, which helps us understand a week but is never a target.

## Rules for every measure

1. **Collect only what GitHub already knows.** Issues, pull requests, discussions, stars, forks, the
   repository traffic API and the "Time to first run" workflow. We add no tracking, telemetry or
   analytics to the application, the documentation site or the launcher. People who install Flux
   without telling us are invisible by design.
2. **"Outside" means a person who is not us.** Not a login in
   [CODEOWNERS](../../.github/CODEOWNERS) (today the two founders, whose agents work through those
   accounts), not a bot, and without owner, member or collaborator rights on the repository.
   `--team LOGIN` adds a login for one run.
3. **Counts, not percentages.** The numbers are small. The review reads the items behind them.
4. **A zero is a result.** A week with no outside activity still gets an entry, and the entry says so.
5. **Names only with consent.** Issues and pull requests are public, but the build log names a partner
   only if they agreed ([design partners](design-partners.md)). Without consent it records counts.

## The five lead measures

| # | Measure | Definition | Source and how it is counted | What it tells us |
| --- | --- | --- | --- | --- |
| 1 | **Outside installs reported** | Distinct outside people who reported a working or attempted install and ticked "You may count our team as an outside install" on the [partner feedback form](../../.github/ISSUE_TEMPLATE/partner-feedback.yml). New in the window, and in total. | Issues with the `partner-feedback` label whose author is outside. The script reads the form's "Counting" answer. Installs a partner reports elsewhere (a call, a chat) go into the entry by hand, marked "by hand". | Whether anyone besides us got Flux running. Only reported installs count; a clone or a star is not an install (rule 17). |
| 2 | **Outside issues and pull requests** | Issues, PRs and discussions opened in the window by outside people, and the **first-time contributors** among them: outside authors of an issue or PR in the window who opened no issue or PR before it. | GitHub search with the team excluded, then a check of each author's earlier items. Discussions are counted, but not used for the first-time check. | Whether people care enough to write to us, and whether the path from L-2 ([#306](https://github.com/ColdPhase/flux/issues/306)) leads to a first change. |
| 3 | **Median time to a first answer** | For each outside item opened in the window, the working hours (weekends excluded, 24 per working day) from opening to the first comment or review by one of us. The median of the answered items. Items still waiting are listed with their waiting time and counted separately. | The first comment, or review, written by someone who is not the author, not a bot and not outside. A bot's greeting does not count. | Whether we meet the response goal of L-2: **a first answer within 2 working days (48 working hours)**. This is the only measure with a recorded target. |
| 4 | **Time to first run on `main`** | Seconds from `git clone` to the printed demo logins, following the [README quick start](../../README.md#quick-start) literally, on a fresh Linux amd64 runner, cold and warm Docker cache. | The latest successful run of the [Time to first run workflow](../../.github/workflows/time-to-first-run.yml), read from its `summary.json` artifact. The script shows the revision measured and how far `main` has moved, and marks a run older than the window as stale. | Whether a newcomer can still get to a working Flux quickly. Method and history: [time to first run](../development/time-to-first-run.md). |
| 5 | **Merged pull requests** | Pull requests merged to `main` in the window, with the conventional-commit type of their title (`feat`, `fix`, `test`, ...), and how many came from outside. | GitHub search for merged PRs. `feat` and `fix` are the "running code" of rule 20. The type comes from the title, so the review spot-checks it. | Whether we keep shipping while we learn. Process and tooling changes are not product progress (rule 21). |

Measure 4 is the only one that needs a run. The workflow takes up to an hour of Actions time and has
no schedule, so the [weekly review](weekly-review.md) dispatches it when the script says the last run
is stale. The macOS figures are measured by hand and recorded in the same document.

## Targets

Only measure 3 has a target today: **median at most 48 working hours, and no outside item waiting
longer than that**. The other measures start as a baseline. After the first four weekly reviews, the
review proposes a target for each from what it saw, and records it here by pull request. We do not
invent a number before we have one observation.

## Reach signals (not lead measures)

The script prints these because they explain a week, not because we steer by them.

| Signal | Why it is not a measure |
| --- | --- |
| Stars and forks, new and outside | A star is attention, not use. Counted separately for outside accounts. |
| Open `good first issue` and `help wanted` issues | An input to measure 2. L-2 asks for at least 5 `good first issue` items. |
| Repository page views, clones, top referrers (the traffic API) | Includes us, our CI and our agents. GitHub keeps 14 days, so a late review misses days, and it needs push access. The referrers show how people reach the repository page. |
| Issues and PRs opened by anyone | Mostly our own work; shown so the outside share is visible. |

## Documentation site visits

**Not collected.** The site at <https://coldphase.github.io/flux/> is hosted on GitHub Pages, which has
no analytics and no visit counts, and adding a tracker would break rule 1. The closest honest signals
are the repository referrers (people who clicked from the documentation to the repository) and the
outside installs of measure 1. If a founder wants visit counts, the privacy-preserving options are a
decision for a separate issue, not part of #308.

## Known limits

- Everything depends on people writing to us. Quiet adopters stay invisible; design partners are asked
  to report each week for that reason.
- The agents of both founders act through the two founder accounts. Their work is never "outside".
  If a third maintainer joins, add the login to CODEOWNERS.
- GitHub search returns at most 1000 results and the script reads up to 500 per query. A week with more
  merged PRs than that is under-counted by type, and the script shows the total beside the counted number.
- Time zones: windows and weekends are in UTC.
- The script only reads. It needs `gh` logged in with push access to read traffic; without it,
  traffic prints as unavailable and everything else still prints.
