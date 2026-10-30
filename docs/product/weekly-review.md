# Weekly review

- **Status:** agent decision under the [delegation](autonomy.md), 2026-10-30. Part of L-4 in the
  [v0.1 launch plan](launch-v0.1.md), tracked in [#308](https://github.com/ColdPhase/flux/issues/308).
- **Basis:** rule 20 of the [delivery playbook](playbook-the-5.md): one wildly important goal, a few
  lead measures, a weekly review. The measures and their limits are in [lead measures](lead-measures.md).
- **Output:** one entry at the end of the [build log](../build-log.md) every week, starting one week
  after the release (the third criterion of #308).

## What the review is for

To look at what outside people did with Flux in the last seven days, decide at most three things to
change, and write down both. It is not a status meeting, a feature wish list or a celebration. Praise,
ours or theirs, and our own use do not count (rule 17).

## Who and when

| Part | Who | Time |
| --- | --- | --- |
| **Prepare** the numbers and the draft entry | The agent of the founder who holds that review | 15 minutes, the working day before |
| **Hold** the review: read, decide, approve the entry | One founder, in turn; the other founder reads the entry and may join | 30 minutes, a fixed weekday |
| **Merge** the entry into the build log | The agent that prepared it, after the holder agrees | Right after the review |

The first review is held exactly **seven days after the release is published**, on the same weekday. The
window is the seven days before it. After that, a fixed weekday every week; the founders pick the weekday
and the time of day, and record it by changing this table. If a week is skipped, the next entry
covers both weeks, says so, and does not rewrite the earlier ones.

## Steps

### A. Prepare (the agent)

1. Update the checkout: `git fetch origin && git switch main && git pull --ff-only`. Use a worktree
   under `.worktrees/` for the entry.
2. Print the numbers. For the first review, use the release time as the start of the window:

   ```sh
   gh release list --limit 1 --json tagName,publishedAt              # first review only: the window starts there
   python3 scripts/lead_measures.py                                 # the last 7 days
   python3 scripts/lead_measures.py --since 2026-11-02 --until 2026-11-09   # an exact window
   ```

   It needs `gh` logged in with push access (traffic). A measure it cannot read prints as
   "unavailable" with the reason; say so in the entry instead of leaving it out.
3. **Time to first run.** If the script marks measure 4 as stale, dispatch the workflow and wait for it
   (it takes a few minutes to an hour of Actions time), then print the numbers again:

   ```sh
   gh workflow run time-to-first-run.yml --ref main
   gh run list --workflow time-to-first-run.yml --limit 1
   gh run watch <run-id>
   ```

   Record any new run in [time to first run](../development/time-to-first-run.md) only when it
   differs from the last one in a way worth keeping; the entry links the run either way.
4. **Read the items behind the numbers.** Open each outside issue, PR and discussion, and each
   partner feedback issue. Note what the person tried to do, where they stopped and what they did
   instead. Do not reword their problem into a feature.
5. **Add what GitHub cannot know**, marked "by hand": installs a partner told a founder about, calls
   held, partners who went quiet. Ask the founders; do not guess.
6. **Draft the entry** from the template below and open a pull request that appends it to
   `docs/build-log.md` (`docs(build-log): weekly review YYYY-MM-DD`, `Refs #308`). Do not merge it yet.

### B. Hold the review (the founder, 30 minutes)

1. **Read the entry together (5 minutes).** Are the numbers plausible? Is anything missing that only a
   founder knows?
2. **Look at the waits and the stops (10 minutes).** Which outside item waited longest? Where did an
   install or the first journey stop? Which question did two people ask? Each answer is evidence, not a
   promise ([design partners](design-partners.md)).
3. **Decide at most three actions (10 minutes).** Each one is an existing or new issue with an owner,
   aimed at measures 1 to 3: answer faster, remove an install obstacle, make a first change easier. Write
   the issue link in the entry. Anything bigger goes through the normal decision path.
4. **Check the partners (5 minutes).** For each design partner: did they send feedback this week? Who
   from the founders writes to the ones that went quiet ([outreach kit](partner-outreach.md))?
5. **Approve the entry** by a comment on the pull request, or by asking the agent to merge it.

### C. After the review (the agent)

- Merge the entry (fast mode, as in `docs/agents/workflow.md`), then comment once on
  [#308](https://github.com/ColdPhase/flux/issues/308) with the link and the three actions. Do not
  comment when nothing changed.
- When a measure has now been seen four times, propose its target in [lead measures](lead-measures.md).

## The entry

Append this to the end of [the build log](../build-log.md). Entries are dated and are not rewritten.
Keep the table; delete a row only by writing "unavailable" in it, and why.

```markdown
## YYYY-MM-DD — weekly review, week N after v0.1.0

Window: YYYY-MM-DD to YYYY-MM-DD (UTC). `main` was at `abc1234`. Numbers from
`python3 scripts/lead_measures.py` unless marked "by hand". Definitions: product/lead-measures.md.

| Lead measure | This week | Context |
| --- | --- | --- |
| Outside installs reported | N new, M in total | by hand: ... |
| Outside issues, PRs, discussions | issues N, PRs N, discussions N; first-time contributors: ... | |
| Median time to a first answer | N h (goal 48 working hours) | N answered, N waiting |
| Time to first run on `main` | cold N min, warm N s | run URL, at `abc1234` |
| Merged PRs | N | N feat, N fix, ...; N from outside |

**What outside people did.** Two to four bullets about what people did and where they stopped, each
linked to the issue or PR. Quote a partner only with their consent.

**What we do about it.** At most three actions, each an issue link and an owner.

**Not counted.** Stars +N, forks +N, repository views N: reach, not adoption.
```

If nothing outside happened, the entry still goes in: the table with its zeros, one sentence saying so,
and the action that follows ("send the follow-ups from the outreach kit", "write two more
`good first issue` items").

## What the review does not do

- It does not plan features from wishes, argue about stars, or reopen recorded decisions.
- It does not use the application's data. Flux collects none for this purpose.
- It does not contact anyone. The agent drafts; a founder sends ([outreach kit](partner-outreach.md)).
