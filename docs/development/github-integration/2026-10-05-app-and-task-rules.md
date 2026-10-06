# GitHub: is an App needed, and how PRs move Flux tasks (G-1)

**Founder direction:** @PelikanFix16, 2026-10-05, [#266](https://github.com/ColdPhase/flux/issues/266) item 12:
- design the GitHub integration properly, starting with whether a GitHub App is needed at all;
- Flux must read GitHub, specifically so that PRs move tasks.

**Status:** proposed, 2026-10-05, by claude-hubert, recorded as [O-011](../../product/decisions.md) and in
[CO-3](../../product/mcp-cowork.md#github-binding-and-board-behavior--co-3). Peer review on the implementing PR (#270).
**Amends:** "Disclosed deterministic task rules" in the [accepted design](2026-09-30-design.md).
Everything else in that design and its [independent conditions](2026-09-30-independent-design-review.md) stays.

## 1. Is a GitHub App needed? Yes

| Option | What Flux gets | Why not (or why) |
| --- | --- | --- |
| **GitHub App** (kept) | Per-repository installation chosen by the repository owner. Fine-grained read-only permissions (metadata, pull requests, checks, statuses). Short-lived tokens. Signed webhooks. | GitHub's recommended integration type. Least privilege, and revocable per repository. |
| OAuth App | One OAuth token per person | Scopes are coarse: reading private PRs needs `repo`, which is full read **and write** to every private repository of that person. |
| Personal access token | A token pasted per project | Long-lived, tied to one person, and pasted into Flux. A fine-grained token still needs manual rotation and has no webhooks. |
| GitHub Actions posting to Flux | Events from a workflow in each repository | Needs a workflow file in every repository and a public Flux URL, and still needs a token to read state. |

Sources, retrieved 2026-10-05:
- [About creating GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/about-creating-github-apps)
- [Differences between GitHub Apps and OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps)
- [Scopes for OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps): `repo` grants full access to private repositories.

The App stays read-only. Flux never writes to GitHub in this scope.

## 2. What changes

**G-1a. PRs move the same Flux task (the founder's core ask).** A person with write access to a task turns on **"Let linked PRs move this task"**. They can do it on the task, or as the project default for new links.

| GitHub fact (current, re-read from GitHub) | Effect on the task |
| --- | --- |
| A required PR is opened or reopened, including a draft | Open → In progress |
| A required check fails on the PR's current head | In progress → Blocked, with the check's name and link as the reason |
| Checks pass again | Blocked (by this rule) → In progress |
| Every required PR is merged | **Done**, when the rule's completion is "Complete" and the task has no unmet written criteria. Otherwise the task shows **Ready to close** with a one-tap Done. |
| A required PR is closed without merge | Blocked, with "PR #n closed without merge" as the reason. Never Done. |

The safeguards of the accepted design stay:
- Only required-output links drive the task; related links never do.
- A rule never reassigns the task or changes its audience.
- A rule never overrides parked, done or not-pursued work.
- A manual status change by a person suspends the rule until someone resumes it.
- Every automatic change records the rule, the PR, its head SHA and the delivery or poll that caused it. It shows in the task's history as "by GitHub rule · set up by Ada".

**Completion modes.** "Complete" is for teams that treat a merge as done. "Ready to close" is the default when the task has written acceptance criteria. Merge or green checks never tick a criterion.

**G-1b. One-click App setup.** The operator's Settings gets **Create the GitHub App**, using GitHub's [App manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest).
- Flux fills in the name, callback, webhook URL, read-only permissions and events.
- GitHub returns the App ID, slug, client ID and secret, webhook secret and key. Flux stores them encrypted with the existing key.
- The six environment variables remain as the operator alternative, and they win when set.

**G-1c. Works without public HTTPS.** When GitHub cannot reach the webhook (a home server or a laptop), Flux polls only the **linked, open** PRs and their checks.
- It polls every 2 minutes, each binding under its existing authority.
- It uses [conditional requests](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests-if-appropriate): an unchanged PR answers 304, which does not count against the rate limit.
- Webhooks, when they arrive, trigger the same reconciliation sooner.
- The 30-minute catch-up and the no-repository-scan rule stay.
- The settings page shows which mode an instance uses: "Live (webhooks)" or "Every 2 minutes (no public address)".

**G-1d. Links found in PRs.** A PR in a bound repository whose title, branch or body names a task's short ID (`FX-1A2B3C4D`, the ID shown on task cards) appears on that task as a **suggested link**.
- A writer confirms it with one tap. Rules act only on confirmed required links.
- The ID alone never links across projects or bindings.

## 2a. G-1a as implemented

This section records the choices the implementation needed. It supersedes the matching sentences of the
accepted design for task rules only.

**Turning the rule on is the explicit publication.** The accepted design kept standing automation off until
"a separately reviewed explicit publication policy" existed. That policy is this toggle. The writer who turns it on
publishes, to everyone who can read the task, the status changes its required PRs cause, and with them the PR
numbers, head commits and check names. The one-line explanation next to the toggle says so. Repository names, PR
titles, links and other provider facts stay behind each reader's own GitHub access, and events carry identifiers only.
- With a manager's project default on, the writer who links a required PR to a task without a rule turns it on, and
  the link form discloses that before linking.
- Rule-caused events carry `automation: 'github_rule'`. Return/Home show them to the author too, as made by the
  GitHub rule rather than by that person. The comparison scheduler does not count them as human activity.

**Who the rule acts as.** The person who turns it on, changes its mode or resumes it becomes its author. They need
current write access to the task and their own GitHub access to the repository of every required link. The rule
captures their GitHub identity and authorization generation. Each processing re-checks both before the binding lock.
- A lost Flux write or GitHub access, or a new authorization generation, suspends the rule.
- A GitHub outage only skips that delivery.
- Turning the rule off needs no GitHub access.

**Losing a repository pauses the rule.** These revocations suspend, in the same transaction, every active rule with a
required link through the affected binding, and record a history line:
- a manager's disconnect;
- the App uninstalled or suspended;
- the repository removed from the installation;
- the binding author's authorization revoked (signed or explicit) — a revoked authorization also suspends the rules
  its person set up;
- a restore.

Readers also see a rule as paused while any required link's binding is inactive. Re-binding the repository never
restarts a rule; a person resumes it.

**What counts as a manual change.** A change of status or blocker since the rule last acted suspends it. Other
edits (title, owner, criteria) only move the version it expects. Readers see the suspension at once, and the next
delivery records it. The rule never clears a blocker a person wrote. Resuming keeps a block only while the task still
shows exactly the blocker the rule wrote; a reworded blocker is the person's.

**Checks.** The rule reads every check run and commit status on the PR's current head.
- One failure blocks the task.
- A task blocked by a failed check is unblocked only when every check on each open required PR has passed. A
  pending, stale or truncated list does not count.
- Choosing specific required checks is a later refinement.

**Completion.** Merged alone never finishes a task, as in the accepted design. "Complete" marks it done only when
all of these hold:
- the task has no written criteria (Flux never records a criterion as met);
- its prerequisites are done;
- every merged PR's head has current verified checks: at least one success and nothing failing, pending or truncated.

Otherwise the task shows **Ready to close**, and only while its prerequisites are done, so the one-tap Done can
succeed. Done is then an ordinary versioned change by a person. A required link that cannot be read now (unavailable binding or failed
refresh) stops the rule from acting at all.

**Where it runs.** In the existing per-binding processing unit, after the facts are saved, for the tasks whose links
that delivery refreshed. Lock order: credential pins, binding, task graph, the sorted task rows, rule rows, then the
changes and one final event batch. Turning the rule on, the project default and a newly linked required PR schedule
one coalesced local reconciliation, so every automatic change names the signed delivery or reconciliation behind it.

**Project default.** A project manager can turn it on for new required links. The writer who links a required PR
to a task without a rule then becomes the author of that task's rule.

## 3. Delivery order

1. **G-1a** rule engine and the task UI (toggle, history line, Ready to close), with Docker tests: open, draft, failed check, re-run, merge, closed unmerged, two required PRs, manual override, access loss, duplicate and out-of-order deliveries.
2. **G-1c** polling fallback, with tests that stub the transport for 200/304 sequences.
3. **G-1b** manifest setup.
4. **G-1d** suggested links.

Real-installation evidence (#74 AC-5) uses a test App on a public URL. Under #266 item 10 it is recorded when available. It is not a gate for merging the slices, which are tested against the typed transport fixtures.
