# Release contract

Use this to extend a reviewed [milestone brief](milestone.md) for an application
release. Link the completed document from the milestone description; no parent
issue is required. Replace prompts with accepted decisions. An incomplete
template is not authorization to start production implementation.

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

- Docker/Compose clean installation, tooling, services, migrations and startup:
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

Record acceptance of the exact brief revision in its reviewed PR or an explicit
decision comment. Later changes need a new acceptance record. The final report
pins a candidate and accounts for every RC criterion, including parked blockers.
The milestone is the entry point and remains open until required evidence passes.
