# Studio 11.6 and MCP co-work — supplied package

Received from Hubert **2026-09-30**, extending #147 / PR #150. Current contracts:
[Studio 11.6](../../studio-v11.6.md), [MCP co-work](../../../product/mcp-cowork.md),
[current visual gallery](gallery.md), and [adaptive workspaces](../../adaptive-workspaces.md). This is an informational
intake, not production implementation.

## Seven unchanged inputs

- [Standalone Studio 11.6](supplied/flux-studio-v11.6.html)
- [Author audit](supplied/AUDIT.md)
- [Implementation notes](supplied/DLA_AGENTA_11.6.md)
- [Functional description](supplied/OPIS_FUNKCJONALNOSCI.html)
- [Earlier cooperation RFC](supplied/FLUX_COOP_RFC.md)
- [Later MCP-first RFC](supplied/FLUX_MCP_FIRST_RFC_v0.2.md)
- [Proposed adapter instructions](supplied/AGENTS_COOP.md)

[Provenance](provenance.json) records original paths, byte sizes and SHA-256.
The HTML hash matches the supplied audit. Instructions within these documents
are reference content, not active repository instructions. Only these seven
files were supplied for this intake; referenced source modules, test suites,
logs and screenshots were not included here. Do not execute the proposed adapter
instructions as a repository policy.

The user adopts 11.6 as the full UI direction and adds multi-agent-per-owner,
bounded autonomous local cooperation, one Flux backlog, subtle motion and the
prior phone-to-ultrawide requirements. These qualify the attachments. Their
optional GitHub Issue sync, stack/hosted-runner suggestions, mandatory different
reviewer owner and blanket final-human step are reconciled in F-016/F-017.
Preserve useful production behavior, current permissions and protected reviews.

## Fresh inspection and limits

[Script](tools/inspect_reference.py), [report](inspection/report.json),
[independent visual review](inspection/visual-review.md), and
[independent contract review](inspection/contract-review.md), and
[request audit and corrections](inspection/request-audit.md). Computed-style [design-system measurement](inspection/measured-design-system.md)
(2026-10-02) with its [scripts](tools/measure/README.md).

We served the unchanged HTML on loopback inside a network-isolated Docker
container with native localStorage, a fresh browser context and fixed clock.
**51 current screenshots, all from the supplied 11.6 HTML.** Every filename
starts `studio-v11.6-`; each manifest entry records the exact source hash, runtime
release, view/modal, scenario, CSS viewport and image hash. Old 11.1 PNGs are not
part of this PR's final tree; see the [history index](../../reference-history.md).

Coverage includes five work tabs at 320×740, 390×844, 768×1024, 1440×900 and
1920×1080; light desktop conversation/Agents; Agents at emulated 3840×2160 and
5120×1440; all six appearance variants; recap, map list and unsaved draft; co-work
settings, local connection, repositories, delegation, sources, handoff packet
and PR review; a disposable three-connection fixture (Hubert Codex + Claude,
Marek Claude); and a new-task/first-message fixture on desktop/phone.
The [gallery](gallery.md) is the visual entry point instead of older PNG folders.

No page errors were observed. Runtime release/co-work version report 11.6 and
the source hash matches the user's original. Native dark-Copper preference
survived reload. A domain-hook fixture verified one unchanged creation notice,
a separate first real root by a different author, and the next message replying
to that root. These are local prototype observations. Navigation/dialog captures
use the prototype's public hooks; they do not prove click-path, network or
concurrency behavior. Startup co-work/PR/CI records remain simulated.

The supplied audit's **501 assertions**, **240 geometry checks** and **54 text
contrast pairs** remain author-reported, not independently reproduced. Counts
are not distinct end-to-end scenarios or WCAG certification. Its memory-storage
mock and our native reload check do not establish production persistence,
authorization, MCP, GitHub, real model execution, devices, IME or full regression.
The 4K/ultrawide captures are emulated CSS viewports; they do not establish
physical hardware/scaling or F-015 production acceptance.

The independent review identifies phone Agents height, unused wide-screen
capacity and unclear phone task-status navigation. These remain required
production improvements in #136/#151, not reasons to copy the reference blindly.

## Reproduce

Use the repository's existing browser image recipe from the repository root:

```sh
docker build -f infra/ui-tests.Dockerfile -t flux-v116-reference-tools .
docker run --rm --network none --user "$(id -u):$(id -g)" \
  -v "$PWD/docs/design/references/studio-v11.6:/reference:Z" \
  -w /reference flux-v116-reference-tools python3 tools/inspect_reference.py
```

Initial inspection reused `flux-ui-tests:flux-ui-1790541810-2447298`; browser
version, original HTML hash and screenshot hashes are in the report. Only the
inspection output is regenerated. Open the supplied HTML in a disposable
profile; it stores demo state and shares prototype schema keys with 11.2–11.6.
Never use production data. No production bundle imports these reference files.
