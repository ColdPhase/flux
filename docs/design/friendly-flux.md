# Friendly Flux: every screen says what is happening and why (F-023)

Status: proposed by claude-hubert on 2026-10-05, from the founder's direction in
[#272](https://github.com/ColdPhase/flux/issues/272). It needs independent peer review.
It refines [Studio 11.6](studio-v11.6.md) and [phone-first](phone-first.md); it removes no
function.

## Direction

The founder found Flux "very unfriendly" next to the Studio 11.6 prototype, and asked for "even
better". This does not mean a 1:1 copy, and nothing may be removed or cut. Every screen should be
friendly, intuitive, fast, simple and understandable, on phones as well. A person should never have
to wonder what is happening or why.

## Rules

| ID | Rule | Acceptance |
| --- | --- | --- |
| FF-1 | **Nothing unexplained.** Every label, count and status says what it is, and why it is there, in words. A status says whether the reader needs to act. No bare counters (such as "Sources 1"), no internal vocabulary (such as "Current rule: Agreed. …" built from a copied message), and no icon whose meaning must be guessed. | A neutral reviewer, given screenshots of each place, can say for every visible label what it means and why it is shown. |
| FF-2 | **Home is the place to get back to work.** Home shows today's date and a greeting, then one return card. The card holds Flux's next step with its reason; failing that, the task you were moving; failing that, a calm "All caught up" with two starting points. Below it, **My work** (Moving / All: tasks you own in every project), **For you** (what waits for you, then other changes since your last visit, with "I have the context"), and **Your projects** (what needs you in each, and its "What matters"). Each row opens its source. On phones the same order stacks in one column. | At 1440×900 the return card, My work and For you are visible without scrolling. At 390×844 the return card's "Back to work" is visible without scrolling. |
| FF-3 | **My sketchbook is a private place.** Its header reads "My sketchbook · Only you". Its views are **Notes** (the private notes that used to be Home's conversation, at `/notes`) and **Map** (private sketches, `/map`). The sidebar has three places: Home, Inbox and My sketchbook. Clicking the Projects or Messages heading opens that full list. On phones the bottom bar holds Home, Projects, Messages, Inbox and Sketchbook. It stays on every page with its section current, as Apple's HIG Tab bars asks (updated 2026-06-08). Inside a project, a conversation or a sketch, the header's top-left control leads back to its list, as a navigation bar's back button does. | Search results for a private draft open `/notes#draft-…`. No place is titled "Home" except Home. |
| FF-4 | **Settings is a page on every size.** The person row at the foot of the sidebar opens `/settings` ("Settings and sign out"). A light/dark switch sits beside it. There is no account popover. Signing out, the session, this device, notifications and AI live on the Settings page. | From any page, Settings is one click (desktop) or two taps (phone, through the drawer or the person row). |
| FF-5 | **The sidebar can be hidden.** Beside the sheet, "Hide sidebar" (or `[`) slides the sidebar away over `--dur-3` with `--ease-out`, and the sheet takes the width. "Show sidebar" in the header brings it back. The choice is remembered on this device. Focus moves to the control that undoes it. Reduced motion changes it instantly. | The sidebar is inert while hidden. Keyboard focus never lands in it. |
| FF-6 | **Projects say what they are for.** A project's header shows its goal (one line, editable by people who can edit the project) in place of the latest decision. The current decision moves to What matters and Details, with who agreed it and when. | Slice 2. |
| FF-7 | **The composer offers only what it can do.** Attach, mention and AI are the composer's tools. Materials linked to a reply show only when present, as a labelled row ("Linked: Sensor shortlist ×") with a sentence explaining what linking does. | Slice 2. |
| FF-8 | **Working together is legible.** The Agents view shows who does what (doer → checker), the task's thread and steps, and one line saying what happens now and whether you need to act. With no agents connected it explains both AI modes (F-022) with one action each. | Slice 3. |
| FF-9 | **Motion explains change.** Places and views slide in from where they sit; sections on Home rise in once; the sidebar and Details glide. Everything stops under reduced motion. | Each animated change has a reduced-motion test. |

## Slices

1. Home, My sketchbook, the Settings page from the sidebar, a collapsible sidebar (FF-1–FF-5,
   FF-9 for these). Pull request on `claude-hubert/272-friendly-home`.
2. Project clarity: a project goal, the decision in What matters, the composer's linked materials
   and task cards (FF-6, FF-7, plus short task keys).
3. Working together (FF-8).
4. Direct messages and the demo data: realistic content, so the demo shows what Flux does.

## Rejected

- **A 1:1 copy of the prototype.** The founder rejected it explicitly. The prototype's demo internals
  do not set production architecture (AGENTS.md).
- **Folding the Inbox into Home.** For you summarises what waits; the Inbox keeps every
  notification and its settings, and Home links to it. Nothing is removed.
- **A modal "Your Flux" for settings, as in the prototype.** The founder asked for a separate page.
