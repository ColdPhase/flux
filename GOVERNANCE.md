# Governance

Flux is an early, pre-release project. This page says who decides what today and
how that is meant to open up. It describes current practice. It is not a promise
of a foundation, a voting body or a commercial arrangement.

## Who decides

- **Founders.** Hubert Osypowicz ([@PelikanFix16](https://github.com/PelikanFix16))
  and Maurycy ([@Zamojski5](https://github.com/Zamojski5)) own the repository and
  the product direction in the [foundation](docs/product/FLUX-FOUNDATION.md). A
  comment counts as "founder direction" only when its GitHub author is one of these
  two logins.
- **Agents under delegation.** The founders have
  [delegated delivery](docs/product/autonomy.md) to two coding agents, one running
  for each founder. Within the foundation, the agents choose scope, sequencing,
  architecture, visual direction, CI and release readiness. They record significant
  choices in the [decision register](docs/product/decisions.md), and the other agent
  reviews each choice independently. There is no founder approval queue.
- **Reviews.** Every change reaches `main` through a pull request. `main` is
  protected:
  - a code owner other than the author approves the change (see
    [CODEOWNERS](.github/CODEOWNERS));
  - review threads are resolved;
  - the required checks pass;
  - nobody bypasses the protection.
  An author can never approve or evaluate their own change. The
  [evaluation guide](docs/agents/evaluation.md) and
  [GitHub protocol](docs/agents/github-protocol.md) describe this in full.

## How you can propose a change

- **Bugs and concrete feature requests.** Open an
  [issue](https://github.com/ColdPhase/flux/issues/new/choose).
- **Questions, open-ended ideas and larger product or architecture changes.**
  Start a [discussion](https://github.com/ColdPhase/flux/discussions) first.
- **Code and documentation.** Follow [CONTRIBUTING](docs/CONTRIBUTING.md): a focused
  pull request from a fork, the Docker checks, and a
  [changelog](CHANGELOG.md) entry for user-visible changes.
- **Decisions.** A change to a recorded decision or public contract updates that
  decision first, in the same pull request or an earlier one, with the evidence
  for the change.

Maintainers answer issues and pull requests in the open. A proposal that does not
fit the foundation is closed with the reason, not left waiting.

## Becoming a maintainer

Today the only maintainers are the two founders. After the first public release,
a regular outside contributor may be invited as a maintainer. Both founders must
agree to the invitation, and it is recorded in an issue. The usual reason is a
history of reviewed, merged work and helpful reviews. A new maintainer gets review
rights for the areas they know and is added to CODEOWNERS for those paths. This
page will be updated when the first outside maintainer joins.

## Licensing

- The application is licensed under [AGPL-3.0](LICENSE). That covers `app/apps/*`,
  `app/packages/core`, `app/packages/db` and `app/packages/agent-runtime`.
- `app/packages/contracts`, `app/packages/sdk` and `app/examples/external-agent` are
  Apache-2.0, so external agents and clients can use them freely.
- The boundary is recorded in [licensing](docs/product/licensing.md).
- Contributions are accepted under the license of the files they change. There is
  no separate contributor agreement.
- Every feature is in this repository. There is no closed enterprise edition. Any
  paid services (hosting, migrations, support) would be a separate, later business
  decision ([O-006](docs/product/decisions.md)).

## Security

Report vulnerabilities privately as described in [SECURITY](docs/SECURITY.md), not
in public issues.
