# Delegated product delivery

**Accepted founder instruction, 27 September 2026.** The founders explicitly
asked the two agents to finish the complete Flux application, make the best
decisions themselves, create subsequent milestones/tasks, and verify one another.
They do not want to approve plans, technology, UI, PRs, transitions, or releases.
This instruction supersedes founder-acceptance requirements in the original
foundation, older task contracts and earlier process documents. Preserve the
original foundation as source material; read it together with this decision.

## Authority

The full [foundation](FLUX-FOUNDATION.md) is the accepted product direction.
Agents own segment/persona choices, implementation scope and sequencing,
architecture/stack, public technical contracts, visual direction, supported AI
paths, CI, self-hosting, packaging and release readiness within that direction.
Use evidence and judgment. Record significant choices with their rationale,
alternatives and reconsideration condition. The independent peer accepts the
decision; the owner implements it. There is no founder approval queue.

Routine, reversible details can be decided during implementation and reviewed
in the PR. Do not require proposal rewrites merely to change the identity of
the person who posted them. A coordinator may propose a task for the peer; the
peer can adopt it by reference. Limit negotiation to material correctness,
interfaces and testable outcomes, then produce the artifact. Research should
resolve the uncertainty that matters now; record unknowns and continue work
that does not depend on them.

Existing GitHub protections and independent reviews remain. Agents may submit
eligible approvals and merge passing PRs without a human button press. They must
fix actual findings and cannot approve their own changes. The existing license
and the foundation's provider/access constraints remain part of the product.
No paid infrastructure purchase or new commercial contract is needed to start.

## From decisions to code

Milestone 1 supplies decisions and reusable research. Milestone 2 starts real
application work as soon as each task's specific dependencies are satisfied.
The milestones may overlap; finishing all market research is not a prerequisite
for Docker setup, persistence, identity, access, UI components or CI.

The first architecture task selects the stack and interfaces, records a concise
decision with peer acceptance, and creates immediately executable coding tasks.
Agents create more milestones and issues as the product needs them, using the
[GitHub protocol](../agents/github-protocol.md). The runner discovers those
milestones; no founder needs to edit the manifest for every new stage.

## Finish the application

Maintain a coverage matrix for foundation areas 8.1–8.16 and the product pillars.
For each area record concrete behavior, dependencies, issues/PRs, tests and
remaining work. This matrix must cover a coherent working product with real
persistent data, people and agents, usable UI, enforced permissions and supported
self-hosting. Decide implementation details and sequence together; do not replace
the goal with a static demo or declare the application finished because one
intermediate milestone closed.

Required unknown, failing or parked outcomes remain incomplete. Both agents
verify complementary portions independently and sign the same final candidate
with actual evidence. Publication follows that integrated verification. After
delivery they verify download, installation and operation and record the final
[product acceptance](../agents/github-protocol.md#full-product-acceptance).

## Actions budget

- PRs get lightweight lint, type checks and relevant fast tests. Reuse one stable
  required gate and cancel superseded runs. Do not create broad matrices or
  duplicate push/PR runs by default.
- Run substantial application, browser, integration, install/restore and image
  build checks locally in isolated Docker/Compose environments. Record evidence.
- No release/package/image publication on each push to `main`, scheduled loop,
  research milestone, or feature merge.
- Once the complete application candidate passes independent verification,
  the agent triggers the final release workflow explicitly. It builds, verifies
  and publishes that exact candidate. The agent triggers a necessary correction
  run after a genuine failure; it does not repeatedly rebuild an unchanged success.

These are engineering gates handled by the agents. There is no human acceptance
step in this delivery path.
