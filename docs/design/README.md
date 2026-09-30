# Design work in Flux

Read foundation sections 10, 17 D1–D4, and 21 in
[FLUX-FOUNDATION.md](../product/FLUX-FOUNDATION.md). The later **F-013 / Studio v11**
founder direction, 2026-09-29, is now the primary visual and UX baseline:
[current direction](direction.md), [refinement contract](studio-v11-refinement.md),
and [preserved reference package](references/studio-v11/README.md). Compare real
screens at the same viewport/zoom, preserve useful repository improvements and
refine remaining friction; do not restart design exploration.

**Latest intake, 2026-09-30:** [Studio 11.1 reconciliation](studio-v11.1-refinement.md)
and [unchanged reference/audit](references/studio-v11.1/README.md) extend F-013
under F-014 / #147. Preserve the accepted #133 baseline and active #134/#135
contracts; #148 carries the reviewed Mint/Sky/Copper and separate-theme-choice
amendment, #149 draft-before-save thoughts, and #136 integrated continuity/phone
work. Further focused improvements are welcome; attached test claims are not
production evidence.

The earlier C direction remains the implementation starting point and
[historical evidence](direction-c-2026-09-27.md). Its mandatory rail/indigo choices
and the v8-only baseline yield to v11. A/B remain rejected. The [#44 journeys](https://github.com/ColdPhase/flux/issues/44),
#57 personal AI, #59 live work, accepted architecture and mobile requirements
continue to govern actual behavior. A compact messenger shell or static task
screen alone cannot fulfill those connected creative journeys.

## Live collaboration reference

The founder's [live collaboration requirements](../product/live-collaboration.md)
add contextual human audio/video/screen sessions to existing work. The supplied
[interactive reference and inspection](references/live/README.md) illustrate
join, show/follow, quiet/return and durable outcomes. Preserve the current v11
direction, personal-agent ownership and compact working surfaces while designing
this capability. The reference is simulated; it is not evidence of working media.

## Brief and continuity

Give each design task its persona, user job, surface type, main action, difficult
states, constraints, and actual reference images when available. Explain what
each reference contributes. Keep interaction references separate from aesthetic
references. A marketing hero does not set the scale of a working screen.

For initial direction compare at least two coherent alternatives on identical
realistic content and states. After acceptance, record the direction under this
directory with the corresponding tokens/components; keep them in sync. Focused
iterations retain the accepted direction unless the task reopens it.

## Compact, readable working surfaces

Use 1440×900 and 1280×800 CSS-pixel desktop viewports at 100% zoom as initial
comparison points, plus narrow layouts and enlarged text. Show long names,
meaningful conversation, project material, multiple agents, errors, and missing
sources. Record what fits, what is pushed below the fold, and whether an open
agent panel still leaves a usable workspace.

The foundation's type/control/spacing ranges are starting hypotheses, not fixed
tokens. Improve density through grouping and removing unnecessary containers;
do not fake it through global scaling, browser zoom, or shrinking all text.
Keep visible, usable controls. Check final color pairs and applicable WCAG
requirements, including focus, keyboard access, zoom, and target size. A compact
appearance is not evidence of accessibility.

## Separate visual and behavior evaluation

1. Render and inspect the whole view before handoff. Record scenario, viewport,
   zoom, revision, and screenshots.
2. Give the independent visual reviewer a neutral brief, screenshots, constraints,
   and references in a fresh context. Exclude code, iteration history, and the
   author's explanations. Use the peer or an explicitly authorized reviewer.
3. Report at most three material visual problems: location, visible symptom,
   user consequence, and improvement direction. Identify what to preserve.
   Begin with at most two focused correction rounds; further work needs a
   concrete unresolved problem, not a desired numerical score.
4. Separately exercise actual interaction, keyboard, accessibility, responsive
   behavior, and applicable data/API paths. Screenshots cannot prove these.

When an independent reviewer or browser is unavailable, label that evidence
unverified or self-assessed. Do not manufacture a passing evaluation. Capture
scope, decision status, checks, and unresolved problems in the handoff.
