# Launch plan for v0.1

- **Status:** founder direction (Maurycy, 2026-10-06: "spisz plan wydania i ruszaj", "write the
  release plan and go"). Owner: claude-maurycy (Zamojski5). Evaluator: claude-hubert.
- **Basis:** the [delivery playbook](playbook-the-5.md), which applies Tomasz Karwatka's
  *The Five* (rules 6, 12, 13, 14, 16, 17 and 20).
- **What it does not change:**
  - **The release itself.** Packaging and publication follow
    [CI and releases](../agents/ci-and-releases.md): one explicit final workflow, run on the
    accepted candidate after the integrated acceptance pass
    ([#249](https://github.com/ColdPhase/flux/issues/249)).
  - **Public posts.** Channels, timing and every post outside this repository are the founders'
    decisions. Agents draft the material; they never post on the founders' behalf.

## Where we stand (2026-10-06)

| Book rule | Flux today |
| --- | --- |
| Open from day one, standard licences (11, 15) | The repository is public. The application is AGPL-3.0, and the SDK and contracts are Apache-2.0 ([licensing](licensing.md)). |
| Easy start (6) | `./flux up` and `./flux demo`, with the core journey as a GIF in the README. |
| Release rhythm (12) | `CHANGELOG.md` is kept per PR. The final release path is defined. |
| Community (13) | CONTRIBUTING exists, and the `good first issue` and `help wanted` labels exist. **0 good first issues are open.** |
| Show how it is built (14) | [The build log](../build-log.md) exists. It is brought up to date in the same change as this plan. |
| Time to first run measured (6, 20) | **Not measured yet.** |
| Design partners after v0.1 (16, 17) | **No plan yet.** |

## The work

Each item becomes one issue in the milestone, with these criteria.

### L-1. Measure the time to first run ([#305](https://github.com/ColdPhase/flux/issues/305))

Start from a clean clone on a machine with Docker and nothing else, and measure each step from
`git clone`:

- to the app answering at its URL (`./flux up`);
- to the demo data loaded (`./flux demo`);
- to the first message posted;
- to the first agent reply, through a person's own MCP client, following the README.

Run it twice, with a cold Docker cache and with a warm one, on macOS arm64 (Docker Desktop)
and on Linux amd64 (CI-like). Record the numbers, the machine and the revision in
`docs/development/time-to-first-run.md`. Turn every step that needed knowledge outside the
README into a fix or an issue.

**Criteria:**

- The four times are recorded for both machines.
- Each friction point found is fixed or has an issue.
- The README quick start is followed literally, with nothing added.

### L-2. A path for the first outside contributor ([#306](https://github.com/ColdPhase/flux/issues/306))

- Prepare 5–10 `good first issue` tasks. Each is small, real, outside the critical path, and has
  its acceptance criteria and a pointer to the code. Add a few `help wanted` tasks for larger
  work.
- Check CONTRIBUTING by following it on a clean clone: run one UI module and one API test file,
  and open a draft PR.
- **Response goal:** a first answer to an outside issue or PR within 2 working days. The agents
  watch for new outside activity.

**Criteria:**

- At least 5 labelled issues, each with criteria and file pointers.
- CONTRIBUTING works as written; the time it took is noted.

### L-3. The release-day kit ([#307](https://github.com/ColdPhase/flux/issues/307))

These are drafted in the repository and reviewed like code. Publication follows
[CI and releases](../agents/ci-and-releases.md).

- **Release notes for v0.1.0:**
  - what Flux is, in two sentences;
  - the quick start;
  - what works (the founder scenarios of #44, phone and PWA, AI modes over MCP);
  - known limits (live co-editing is not in v0.1, plus anything left open at #249);
  - upgrade and backup notes;
  - checksums.
- **README:**
  - refresh the demo GIF once #275 (Friendly Flux) and the phone look (F-025) are on `main`;
  - add one phone screenshot;
  - make sure the first screen answers what Flux is, who it is for, and how to try it.
- **A 60–90 s demo video of the core journey** on the demo data: a person and an agent in one
  conversation, a task, a handoff that someone resumes.
- **The story, as drafts in English and Polish for the founders:** two founders and two agents
  built Flux in public, with dated evidence from the build log. The founders choose where to
  publish it (for example Show HN, r/selfhosted, LinkedIn) and when.
  The drafts are in [launch-story.md](launch-story.md).
- **The changelog:** `[Unreleased]` moves under `0.1.0` with its date. The build log gets a
  release entry.

**Criteria:**

- Each draft is merged.
- The release notes match the accepted candidate and the #249 report.
- The video and GIF show the released revision.

### L-4. After the release: partners and one weekly review ([#308](https://github.com/ColdPhase/flux/issues/308))

- **Design partners** (rules 16 and 17): a short profile of 3–5 small teams that already work
  with coding agents, have the problem Flux solves, and will commit time. The founders choose
  and contact them. The agents prepare an onboarding guide and a feedback issue template.
- **One weekly review** (rule 20). It records a few lead measures in the build log:
  - outside installs people report;
  - issues and PRs opened by people outside the team;
  - the median time to a first answer;
  - the time to first run on the latest `main`.

  Our own enthusiasm is not a measure (rule 17).

**Criteria:**

- The partner profile and onboarding guide are merged before the release.
- The first weekly review entry is written one week after the release.

## Order

L-1 and L-2 start now; they need no other work. The L-3 drafts start now. The README, GIF and
video in L-3 wait for #275 and the F-025 phone work, and the release notes wait for #249. L-4's
partner profile and guide come before the release; the weekly review starts after it.

## Not in this plan

- **Paid or closed editions, pricing, enterprise sales, landing-page validation.** These are
  "Not applied now" in the [playbook](playbook-the-5.md).
- **Any release earlier than the final workflow.** That would need a recorded change to the
  release policy.
