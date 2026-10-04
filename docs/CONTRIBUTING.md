# Contributing to Flux

Flux is in early development and not yet released. The application is a
TypeScript monorepo run with Docker Compose (see the [README](../README.md) and
[architecture](development/architecture.md)); `flux-ux-v8.html` is an earlier UX
prototype with a Polish interface. Contributions to usability, accessibility,
documentation, and reproducible bug fixes are welcome.

## Choose the right place

- Use [Issues](https://github.com/ColdPhase/flux/issues/new/choose) for reproducible
  bugs and concrete feature proposals. Search existing issues first.
- Use [Discussions](https://github.com/ColdPhase/flux/discussions) for questions,
  open-ended ideas, and substantial product or architecture changes.
- Follow [SECURITY.md](SECURITY.md) to report vulnerabilities privately.

English is preferred for shared documentation and discussions. Polish reports and
questions are welcome. Be respectful, give constructive feedback, and avoid
posting personal or confidential information.

Before starting a large change, describe the problem, proposed scope, and expected
user benefit in an issue or discussion. Wait for maintainer feedback so the work
fits the direction of the project. Small, clearly scoped fixes can go straight to
a pull request.

## Follow work on the project board

The [Flux board](https://github.com/orgs/ColdPhase/projects/1) tracks repository
issues. The cards are the same issues you see in the repository, so descriptions,
assignees, labels, and conversations stay together.

GitHub Projects uses these built-in automations:

| Event | Issue status on the board |
| --- | --- |
| A new open issue is added automatically | Todo |
| A pull request is linked to resolve the issue | In Progress |
| The issue is closed, including by merging its resolving PR into `main` | Done |

Todo includes incoming reports and proposals; maintainers still decide which work
to accept and prioritize. Done reflects a closed issue, so check its closure
reason to distinguish completed work from declined proposals or duplicates.

When a PR will resolve an issue, put a closing reference in the **PR description**:

```text
Closes #123
```

Replace `123` with the actual issue number and target the `main` branch. GitHub
links the PR to the issue and closes the issue when that PR is merged into
`main`. For related work that does not resolve an issue, use `Refs #123`; that
reference does not trigger the same closing workflow.

Open a draft PR while implementing the change, then mark it ready for review
when it is ready for a maintainer. Both draft and ready PRs keep the linked issue
In Progress. The card's linked PR shows the PR state; review does not have a
separate board column. Closing a PR without merging it does not complete the
issue.

## Make a change

1. Fork [ColdPhase/flux](https://github.com/ColdPhase/flux) to your GitHub account.
2. Clone your fork and create a branch from the latest `main`:

   ```sh
   git clone https://github.com/YOUR-USERNAME/flux.git
   cd flux
   git remote add upstream https://github.com/ColdPhase/flux.git
   git fetch upstream
   git switch -c fix/short-description upstream/main
   ```

3. Start the application with `./flux up` (or `./flux dev` for hot reload) and, for
   sample data with two logins, `./flux demo`, as described in the
   [application foundation guide](development/application-foundation.md#one-command-start-flux-issue-72).
   To work on the historical prototype instead, serve it with Python 3:

   ```sh
   python3 -m http.server 8080 --bind 127.0.0.1
   ```

   Open <http://127.0.0.1:8080/flux-ux-v8.html>. If your Python 3 executable is
   named `python`, use it instead. You can also open the HTML file directly.

4. Make a focused change. Put code in the layer that owns it
   ([architecture](development/architecture.md)) and tests under `app/tests/app`.
   Prototype changes live in `flux-ux-v8.html`; avoid reformatting unrelated
   parts of that large file.
5. Run the checks below, commit your changes, and push your branch to your fork.
6. Open a PR against `ColdPhase/flux:main` and complete the PR template. Use a
   draft PR if the change is still being developed.

You do not need to join the ColdPhase organization or receive write access to
contribute through a fork.

## Verify your change

Application changes: run the Docker suite, which builds, type checks, lints and
runs the API, architecture and end-to-end tests against a disposable stack. Changes
to the web app also need the browser suite:

```sh
./scripts/check_application.sh
./scripts/check_ui.sh
```

Each script uses its own Compose project; set `FLUX_TEST_PORT`/`FLUX_TEST_MAILPIT_PORT`
or `FLUX_UI_PORT`/`FLUX_UI_MAILPIT_PORT` when the default ports are taken. Run one suite
at a time on a small machine.
[Architecture § Tests](development/architecture.md#tests) says which check runs which tests
and where a new test goes.

Repository and documentation checks:

```sh
python3 scripts/check_agent_setup.py
python3 -m unittest discover -s tests -p 'test_*.py'
git diff --check
```

GitHub Actions runs the repository checks and a fast application check (build, type
check, lint, architecture and core tests) on pull requests; it does not run the Docker
suites above, so mention which ones you ran. For UI and prototype changes, also verify
the behavior in a browser and describe your checks:

- Reproduce the issue before the fix and check the same steps afterward.
- Check the browser console for new errors.
- For UI changes, check keyboard use and both a wide and a narrow window. Attach
  screenshots showing the change.
- For changes to saved data, use disposable sample data and check export/import
  and reload behavior. Describe any compatibility impact in the PR.
- For documentation changes, check that links, file names, and commands match the
  repository.

The [prototype walkthrough](prototype/README.md) includes a manual scenario you
can follow. Mention the browser, operating system, and manual checks you used. If
you could not verify relevant behavior, state that in the PR.

## Review and project decisions

The current maintainers are [@PelikanFix16](https://github.com/PelikanFix16) and
[@Zamojski5](https://github.com/Zamojski5). Maintainers set project direction,
review proposals, and decide which changes to merge.

Changes to `main` go through pull requests. A maintainer other than the PR author
must approve the change and review conversations must be resolved. New commits
may require another review. Approved changes are merged
with squash merging.

Please keep each PR focused on one problem. Updating documentation alongside a
behavior change helps other contributors understand and maintain it. If people or
operators will notice the change, add one line under `[Unreleased]` in
[CHANGELOG.md](../CHANGELOG.md) with your PR number. [GOVERNANCE.md](../GOVERNANCE.md)
explains who decides what and how to become a maintainer.

## Working with coding agents

Codex and Claude share [AGENTS.md](../AGENTS.md) and the skills in
`.agents/skills/`. The [agent collaboration guide](agents/README.md) describes
task contracts, conversations through issues/PRs, independent evaluation, and
how each maintainer runs one `/goal` agent session. Its
[CI and release process](agents/ci-and-releases.md) also assigns agents
responsibility for validation and packaging once the stack is chosen.

Use the implementation-task issue form for planned work. Ordinary contributions
remain welcome through the existing issue and PR process; the autonomous release
protocol applies when a task is admitted to that workflow.
