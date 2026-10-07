# Design work in Flux

**The design is decided: [final design "Prostota"](final/README.md) (F-026, founder direction
2026-10-07).** It is the only UI and UX for Flux on the computer and the phone. It covers
tokens, Kreska (logo, agent icon and mascot), structure, navigation, behaviour rules
S1–S22 and P1–P12, files and photos, and a render of every screen. Implement it as drawn and
match its renders. A change to the design itself needs a founder; agents do not re-decide it or
compare alternative directions. Epic [#336](https://github.com/ColdPhase/flux/issues/336)
tracks the implementation issues.

The design keeps the functional contracts: [F-016 local MCP co-work](../product/mcp-cowork.md),
[F-015 adaptive workspaces](adaptive-workspaces.md), PWA and Web Push
([F-010](../product/mobile-pwa.md)), personal-agent ownership, access and the accepted
architecture. Where a functional document describes appearance or placement, the final design
wins.

The feature folders in this directory (for example `conversation/`, `map-list-outline/`,
`thought-drafts/`) record behaviour contracts and the evidence of past implementation work.
Their screenshots show the application as it was then; they are not a visual target.

## Live collaboration reference

The founder's [live collaboration requirements](../product/live-collaboration.md)
add contextual human audio/video/screen sessions to existing work. The supplied
[interactive reference and inspection](references/live/README.md) illustrate
join, show/follow, quiet/return and durable outcomes as interactions only; appearance follows
the final design. The reference is simulated; it is not evidence of working media.

## Brief and continuity

Give each design task its persona, user job, surface type, main action, difficult
states, constraints, and actual reference images when available. Explain what
each reference contributes. Keep interaction references separate from aesthetic
references. A marketing hero does not set the scale of a working screen.

A design task within the final design starts from its screens and rules. When a state is
not drawn, compose it from the drawn components and rules, and show it to a founder before
it becomes a pattern.

## Compact, readable working surfaces

Compare against the final renders at 1440×900 (computer) and 390×844 (phone) CSS pixels at
100% zoom, in light and dark, plus 1280×800, narrow layouts and enlarged text. Show long names,
meaningful conversation, project material, multiple agents, errors, and missing
sources. Record what fits, what is pushed below the fold, and whether an open
agent panel still leaves a usable workspace.

The final design's tokens are fixed; use them rather than local values. Improve density through grouping and removing unnecessary containers;
do not fake it through global scaling, browser zoom, or shrinking all text.
Keep visible, usable controls. Check final color pairs and applicable WCAG
requirements, including focus, keyboard access, zoom, and target size. A compact
appearance is not evidence of accessibility.

## Adaptive workspaces from phone to ultrawide

The later [F-015 adaptive-workspace requirement](adaptive-workspaces.md),
2026-09-30, makes responsive design a product capability. Use additional space
for useful work and related context while preserving familiar navigation,
object/source identity and active work during transitions. #151 implements the
adaptive slice; #20 keeps mobile acceptance (emulation plus documented platform requirements).
Use the full CSS-viewport/scaling/input matrix and measurable wide-screen gains,
not only a desktop and phone screenshot.

## Phone and tablet: Apple HIG checklist

**Founder direction, 2026-10-05 (#266):** phone and tablet UX is judged against the
Apple Human Interface Guidelines. [The HIG checklist](apple-hig-mobile.md) turns them into
115 numbered rules (HIG-01 to HIG-115) for Flux as a web app on iPhone and iPad, each with
Apple's words, how Flux applies them on the web, and a check in emulation. Cite rule IDs
in phone and tablet issues, PRs and reviews. The final design already applies them; where a
rule and a drawn screen seem to disagree, raise it on #336 instead of changing the screen.

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
