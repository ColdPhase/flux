# Release contract

Copy this into a release issue when the application plan is available. Replace
the prompts with actual decisions. An incomplete template is not authorization
to start the autonomous loop.

## Identity

- Version and milestone:
- Product specification (path and revision):
- Architecture and stack decisions (path and revision):
- Configuration/skill revision:
- Maintainers accepting this contract:

## Outcomes and boundaries

Describe the users, outcomes, included features, and explicit exclusions.
Record unresolved questions and their decision owner.

## Acceptance criteria

| ID | User-visible outcome | Verification scenario | Evidence required |
| --- | --- | --- | --- |
| RC-1 | Fill from the agreed application plan. | Specify an observable test. | Name the evidence. |

## Environment and verification

- Clean installation and startup:
- Required task checks and GitHub status checks:
- Required integrated release checks:
- Distributable formats, supported platforms, and installation checks:
- Version/tag convention, draft/prerelease/stable policy, and release notes:
- Test data, accounts/roles, and isolation:
- Deployment target and delivery checks, if included:

## Automation authority

- Workers and their authenticated GitHub identities:
- Allowed task creation, assignment, implementation, and evaluation:
- Whether eligible peer agents may approve and merge under existing rules:
- Allowed CI/ruleset configuration and publication to GitHub Releases/packages:
- Whether deployment is allowed and to which target:
- Run/time and provider spending limits:
- Decisions reserved for maintainers and where to report blockers:

## Acceptance record

A maintainer records acceptance of this exact contract revision in a comment.
Later changes need a new acceptance record. The final report pins a candidate
commit and accounts for every RC criterion; implementation PRs reference this
issue without using a closing keyword.
