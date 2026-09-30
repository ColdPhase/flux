# Theme-aware accents (#135)

Decision recorded 2026-09-30 under F-013 / [Studio v11](studio-v11-refinement.md#3-three-theme-aware-accent-families), before implementation. Mint is the default; Iris and Sky are the only alternatives. This is a local appearance preference, with no account, audience or organization contract change. Independent visual and current-head implementation review remain required.

The person chooses one family in Account → Accent. Each option has its name, a sample, a checkmark and `aria-checked`; keyboard arrows and Home/End move and select within that group. Theme selection remains separate. Changing theme retains the family and resolves the corresponding palette, including the system dark preference. The same browser stores `flux.accent` as `mint`, `iris` or `sky`. Missing, unknown or older values resolve to Mint before rendering; unavailable browser storage retains the choice for the current visit. Appearance preferences are device-local, not synchronized to an account.

| Family | Light accent / hover / pressed | Dark accent / hover / pressed | Light / dark soft surface |
| --- | --- | --- | --- |
| Mint | `#247358` / `#1C6049` / `#174F3D` | `#8ED8B8` / `#A6E3CA` / `#78C5A5` | `#E7F4ED` / `#1C3028` |
| Iris | `#6742A6` / `#57358F` / `#492D78` | `#B7A8EF` / `#C9BDF7` / `#A596DE` | `#EEE8F9` / `#2A2539` |
| Sky | `#2C609B` / `#245184` / `#1D426D` | `#94BCF3` / `#ACCCF8` / `#80AAE3` | `#E9F0F8` / `#202C3D` |

Shared tokens separate the roles: `--accent` primary action, `--accent-hover` and `--accent-pressed` pointer feedback, `--accent-soft` quiet surfaces, `--on-accent` labels (white in light, near-black in dark), `--accent-selected-bg/text/border` selected controls, `--link` navigation and `--focus` keyboard focus. Prose links keep an underline in every family, including their normal state, so their identity does not rely on the color difference from nearby text. Matching roles may use the same measured color; components consume semantic roles rather than copied HEX. `--map-guide` is a readable neutral relationship stroke, independent of the chosen family. It replaces the previous translucent canvas edge; selected relationships retain accent emphasis.

Status roles remain stable across families: `--danger`, `--warning`, `--ok`, `--attention` (needs-you, retaining its existing indigo) and `--resolution` (completed work/success). The v11 demo’s question-resolution marker is not a production domain/UI feature today; no demo-only marker is imported. Existing completed work consumes the stable resolution role. Resolution and task status retain text/icons; choosing Mint does not reinterpret a task or a resolved thought. Neutral surfaces, layout, type, existing rail identity and project monograms are preserved.

Verification must measure all six palettes and actual rendered states: ordinary/hover/pressed buttons, links, focus, selection, conversation composer, recap, map relationships and task/error states. Screenshots use identical persisted content at 100% zoom, with desktop, phone, tablet and enlarged text. Viewport evidence does not certify physical PWA installation or device behavior.

The [2026-09-30 production evidence](theme-accents/evidence/README.md) pins the source, full browser checks, six-family composited measurements and matched screenshots. Independent protected review remains the merge gate.
