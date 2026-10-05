# O-009 — who accepts a project decision

**Proposed, 2026-10-05**, for [#250](https://github.com/ColdPhase/flux/issues/250).
**Owner:** `claude-maurycy`. **Evaluator:** `codex-hubert` (independent review of the
PR that adds this record). It becomes Accepted only through that review; an
implementation or a passing test does not change its status.

Foundation [§8.6](FLUX-FOUNDATION.md#86-decyzje-i-zmiana-kierunku) asks who confirms a
decision and how, and sets the boundary: a model's suggestion never gains the team's
mandate by itself. The [#101](https://github.com/ColdPhase/flux/issues/101) slice already
separates proposed, accepted and superseded decisions and keeps the rationale, but no
record said which role may accept, or whether acceptance can be delegated with a scope
and an expiry. This decision answers both for v0.1.

## The rule

**DA-1 — Proposing.** Any principal with current write access to the project proposes:
a person, or an agent through its own project grant, including an MCP connection with
a live `decision.propose` standing grant. A proposal changes no current rule, not even
one that names a decision it would replace. In v0.1 the assistant in Flux (personal
runs, O-008/F-020) does not propose decisions. Its only consequential output is an
assistant proposal for a *result*, and a person with authority over the result decides it.

**DA-2 — Accepting.** One signed-in person accepts. At the moment of acceptance,
that person's project access level must be contributor or manager, as the
[access policy](../development/access-policy.md#rules) computes it from current rows.
That includes:

- workspace owners and admins (managers of every project, unless they hold an explicit `denied` grant);
- members on a workspace-visible project, unless a `viewer` or `denied` grant narrows them;
- any person, member or guest, with an explicit `contributor` grant.

The proposer may accept their own proposal. Flux records the person as the one who
decided.

**Refused,** with nothing changed:

| Caller | Response |
| --- | --- |
| A viewer | `403` |
| A person with no access, a `denied` grant, or who left the workspace | `404`, the same as a missing decision |
| An agent, whatever its grant or owner (a person-owned agent of a manager, or a workspace-owned agent) | `403 DECISION_NEEDS_PERSON` |
| The assistant in Flux | No path. It writes no decision rows, and a decision-shaped proposal block in its output is dropped. |
| An MCP connection | No tool and no agent operation accepts; a standing grant cannot name acceptance (`400`). |

**DA-3 — Superseding.** A decision is superseded only when a person with DA-2
authority accepts a proposal that names it. Accepting marks the earlier decision
`superseded` in the same transaction. The earlier decision keeps its title, rationale
and decider. Superseding needs the same authority as any acceptance, whoever accepted
the earlier decision. v0.1 has no other way to retire, reject or un-accept a decision:
a change of direction is a new proposal that names the current rule.

**DA-4 — No silent acceptance.** Acceptance is one explicit command
(`POST /api/v1/decisions/:id/accept` with `If-Match` or `expectedVersion`) sent by the
deciding person's own browser session, and that person is recorded as the decider.
Nothing else can set the status or the decider:

- a REST create or accept body (the API ignores fields it does not define, so a
  `status` or `decidedBy` in the body has no effect);
- an MCP tool argument (the tool schemas are strict and refuse such a field);
- model output, an assistant proposal or a standing rule;
- a notification or an idempotent replay.

A refused attempt leaves the status, version and decider unchanged and records no
`project.decision_accepted.v1` event. The database enforces the same rule: a
non-proposed decision must name a decider (`CHECK`), and that decider must be a person
account (`decided_by REFERENCES auth_users`).

**DA-5 — Delegation.** v0.1 has no delegated acceptance.

- **Agents and the assistant are excluded, not deferred.** A standing grant that let a
  model accept with a scope and an expiry would turn model output into team mandate
  without a person deciding that specific choice. That breaks §8.6, the separate
  analysis, proposal and execution permissions of §8.11, and F-019 owner authority.
  Changing this needs a new decision that supersedes O-009 and revisits §8.6.
- **Person-to-person delegation with a scope and an expiry is deferred.** In v0.1,
  authority is the same as project write access, so a delegation would grant nothing
  that a `contributor` grant does not already give. If Jo wants Ari to decide while
  she is away, Ari needs write access to the project, and that is enough. Grants have
  no expiry in v0.1; a manager narrows or removes them, and the next acceptance attempt
  is checked against the current rows.

## Why this rule

| Option | Assessment |
| --- | --- |
| **A. A person with current project write access** (chosen) | It matches the role model and the merged #101 behaviour. People can explain it ("who can edit the project decides"), and one policy computes it for the API, MCP, the worker and the UI. It needs no new object, migration or UI. |
| B. Managers only | Too narrow for the creative side projects of F-012. A two-person project whose second person is a contributor could not decide during the owner's absence, which breaks the #14 journey. |
| C. Workspace members only (no guests) | It adds a second axis beside the project grant. A guest reaches a project only through an explicit grant, and the manager already chooses `contributor` or `viewer`. Cost: a guest who should contribute but never decide cannot be expressed (see revisit). |
| D. Never the proposer (four eyes) | It blocks solo projects and small teams. The proposer and the decider are both shown, so self-acceptance is visible, not hidden. |
| E. Named decision owners with delegation (the #14/#16 vocabulary) | It needs a decision-owner role, a delegation object (scope, expiry, revocation, audit), checks at acceptance and UI to grant and show it. No v0.1 journey needs authority narrower than write access. Deferred under DA-5. |
| F. Agent acceptance under a scoped, expiring standing grant | Rejected under DA-5. |

**Costs and limits.** Any contributor can make a decision current, so a team cannot mark
some contributors as propose-only. A self-accepted decision has one human behind it.
Both are visible: the proposer and the decider are shown on the decision, in docs and to agents.

**Revisit when** a project needs authority narrower than write access, for example
named deciders, propose-only contributors or an organization's approval policy, or when
user trials show that absences need time-bounded authority. A delegation then needs a
scope (project or decision area), an expiry, revocation, an audit trail and the same
check of current rows at acceptance. Agents stay excluded.

## Evidence (observed on `main` `fdb70955`, 2026-10-05)

These are code observations, not vendor claims. No external sources were needed, because
the question is about Flux's own role model.

| Observation | Source |
| --- | --- |
| Acceptance needs project `write` through the policy with the access rows locked, then `principal.kind === 'human'` (`DECISION_NEEDS_PERSON`). Proposals need project `write`. | `app/packages/core/src/work/service.ts` (`acceptDecision`, `proposeDecision`) |
| The database ties the status to a decider (`(status = 'proposed') = (decided_by IS NULL)`), and the decider is an `auth_users` row. | `app/packages/db/migrations/0008_work.sql` |
| The REST API resolves only browser session cookies, and only to `kind: 'human'`. MCP bearers resolve to `kind: 'agent'`. | `app/apps/server/src/identity/session.ts`, `app/apps/server/src/agent-connection/context.ts` |
| MCP decision tools are `flux_list_decisions`, `flux_get_decision` and `flux_propose_decision`. `AGENT_OPERATIONS` has `decision.propose` and nothing else for decisions, and the standing-grant route validates against that list. | `app/apps/server/src/agent-connection/{domain-reads,work-actions,routes}.ts`, `app/packages/contracts/src/agent-execution.ts` |
| Assistant proposals carry only a result (`change.type: 'result'`). Accepting one records a result as the accepting person and never touches decisions. | `app/packages/core/src/personal-runs/{proposals,validation}.ts` |
| The Details panel shows Accept only when `project.access !== 'viewer'`, but before #250 it told a viewer nothing about who decides. | `app/apps/web/src/work/WorkDetails.tsx` |
| The #14 journey and the #16 specification describe Jo delegating "bounded project decision authority" to Ari, with "scope and expiry enforced". The coverage ledger lists §8.6 as a gap that includes delegation. | [journeys](journeys-and-vocabulary.md), [specification](application-specification.md), [ledger](foundation-coverage.md) |

## Effect on earlier records

- **#14 journey.** In v0.1, the *decision owner* is any person with current write
  access to the project. Ari accepts D-2 as a project contributor. "Jo delegates
  decision authority to Ari" means that Ari keeps contributor access. Time-bounded
  delegation is out of v0.1 scope (DA-5).
- **#16 specification, Decide and Change direction rows.** v0.1 checks current write
  access at acceptance (DA-2) in place of "delegation scope and expiry are enforced".
  "An agent suggestion has no acceptance authority" stands, and DA-4 strengthens it.
- **Coverage ledger §8.6.** The test "reject unauthorized or expired delegation" becomes:
  reject acceptance by viewers, people without access, people who were denied or left,
  agents and the assistant, and show that a refusal changes nothing. Expired delegation
  is out of scope under DA-5.
- **Release matrix ([#249](https://github.com/ColdPhase/flux/issues/249)).** The §8.6
  confirmation-authority row maps to O-009 and the tests below. Delegated acceptance with
  scope and expiry is a recorded v0.1 scope exclusion (DA-5), not missing functionality.

## Enforcement and tests

| Rule | Enforced in | Tests |
| --- | --- | --- |
| DA-1, DA-2, DA-3 | `acceptDecision` / `proposeDecision` over the single access policy | `app/tests/app/decision-authority.test.ts` (role matrix, narrowing after a proposal, leaving, superseding), `app/tests/app/work.test.ts` |
| DA-2, DA-5 for the agent path | No accepting tool or operation; standing-grant schema; `DECISION_NEEDS_PERSON` | `decision-authority.test.ts` (an MCP proposal, the tool list, the refused `decision.accept` grant, person-owned and workspace-owned agents) |
| DA-1, DA-4 for the assistant path | Result-only proposal parsing; proposal accept needs a person with authority | `app/tests/app/personal-runs.test.ts` ("#250 AC-3") |
| DA-4 | Server-defined status and decider (unknown REST fields ignored, strict MCP schemas); `0008_work.sql` `CHECK` and `FOREIGN KEY` | `decision-authority.test.ts` (a body naming a status or decider, raw SQL updates refused, no event on refusal) |
| DA-2 in the UI | `DecisionPanel`: Accept only with write access; otherwise a "Who decides" note | `app/tests/ui/test_decision_authority.py`, `app/tests/ui/test_work_decisions.py` |
