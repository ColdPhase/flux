# Calm like Apple's own apps: research for the Flux phone UI

- **Date:** 2026-10-06. **Author:** claude-maurycy (Zamojski5).
- **Status:** research note. It proposes contract amendments; it does not make them. Each change
  that touches an accepted or proposed contract names the clause, and needs the usual
  record-then-implement step and independent peer review.
- **Founder direction** (Maurycy, 2026-10-06, translated): the Studio 11.6 prototype "is OK, but
  terribly cluttered, too dense. Do thorough research on how Apple does its mobile apps. I think
  they give up text in favour of breathing room, cleanliness, smoothness." His earlier phone
  feedback on [#264](https://github.com/ColdPhase/flux/issues/264) (2026-10-05): overwhelming,
  unclear what to tap, nothing like Messenger.
- **Question:** how do Apple's own iPhone and iPad apps get calm, uncluttered, smooth interfaces,
  and what should the Flux phone UI change to get there?
- **Relationship to other documents.** The [HIG checklist](../apple-hig-mobile.md) (HIG-01 to
  HIG-115) stays the rulebook; this note adds the visual language behind the rules. It touches
  [Studio 11.6](../studio-v11.6.md) (F-017), [phone-first](../phone-first.md) (PF-1 to PF-7) and
  F-023 "Friendly Flux" (`docs/design/friendly-flux.md`, proposed on PR
  [#275](https://github.com/ColdPhase/flux/pull/275), not yet on `main`). Desktop density is out
  of scope.

## Contents

- [Summary](#summary)
- [Evidence labels and counting rules](#evidence-labels-and-counting-rules)
- [1. Apple's current design language](#1-apples-current-design-language)
- [2. Apple's own apps as worked examples](#2-apples-own-apps-as-worked-examples)
- [3. Practitioners and community, H2 2026](#3-practitioners-and-community-h2-2026)
- [4. What carries over to a web app](#4-what-carries-over-to-a-web-app)
- [5. Gap analysis: the Flux phone UI, screen by screen](#5-gap-analysis-the-flux-phone-ui-screen-by-screen)
- [6. Spacing, collapsing chrome, type and motion](#6-spacing-collapsing-chrome-type-and-motion)
- [7. Principles for the Flux phone UI](#7-principles-for-the-flux-phone-ui)
- [8. The 15 changes with the most effect](#8-the-15-changes-with-the-most-effect)
- [9. Open decisions and contract amendments](#9-open-decisions-and-contract-amendments)
- [10. Uncertain or unverified](#10-uncertain-or-unverified)
- [Sources](#sources)

## Summary

**How Apple does it** (details and sources in sections 1–3):

1. **Two layers.** Content fills the screen; controls sit in a thin, separate layer at the top and
   bottom edges, "floating above your content … without ever stealing focus" [A3].
2. **Apple drops chrome text, not navigation text.** Bar actions are standard symbols; tab bars
   keep one-word labels; actions with no clear symbol (Edit, Select, Done) keep words [A3, A11,
   A12]. "They give up text" holds for toolbars, not for navigation.
3. **Hierarchy from space and type, not boxes and lines.** Dividers give way to a soft fade where
   content scrolls under controls; grouping uses space [A3, A13, A14].
4. **Few bar items, grouped, one tinted.** At most three groups, the rest in a More menu,
   monochrome icons, tint only for the next step [A3, A4, A11].
5. **Metadata on demand.** Times, details and secondary actions sit behind a long press, a swipe or
   an info screen, and Apple asks that every hidden action also exist in the main interface [A20].
6. **Large, few type sizes.** Large Title 34, Body 17, Subhead 15, Footnote 13, Caption 12; never
   below 11 [A17].
7. **Chrome yields while you read.** Large titles collapse into inline titles, tab bars minimise
   on scroll down and return on scroll up, toolbars can hide in context [A4, A5, A11, A12].
8. **Search sits near the thumb**, as a tab or in the bottom toolbar [A9, A19].
9. **Side tasks in sheets** with a grabber and detents; compose sheets are full height [A18].
10. **Motion is a spring without bounce** that carries the finger's velocity; nothing animates on
    frequent actions; all of it is optional [A6, A16].
11. **"Simplicity isn't minimalism."** Apple's 2026 principles warn against burying functions to
    look minimal [A8, A10], and iOS 27 reviewers still had to explain hidden features [C3, C4].
12. **Apple pulled back on transparency, not on calm.** iOS 27 adds contrast, more tint by default
    and a slider, and search went back into the tab bar [A21, A24, C3, C4]. Flux should take the
    structure and leave the glass.

**What it means for Flux** (sections 5–9):

- The phone UI is busier than the prototype the founder already called too dense: a project
  conversation shows 31 labels and 29 controls (prototype 24 and 18), and content gets about 60 %
  of the screen (prototype about 70 %).
- Most of the noise is repetition and explanation, not function: names and "· you" on every
  message, a time on every message, a status on every announced task, permanent help sentences,
  three rules between header bands.
- The proposals cut labels by 13–86 % per screen (42 % on the conversation) without removing a
  function, and give the conversation 70–79 % of the screen.
- Three contracts would change: phone-first (PF-1, 2, 3, 5, 6), F-023 (FF-1, 2, 4, 10), and
  Studio 11.6's UI116-1 "compact typography", for phones only. Two questions are left open for the peer: the tab bar inside a
  conversation (D1) and long press for message actions (D2).

## Evidence labels and counting rules

Every finding carries one label:

| Label | Meaning |
| --- | --- |
| **vendor claim** | Apple says it: HIG, WWDC session, Newsroom, apple.com, developer docs. True of Apple's intent, not proof of effect. |
| **observed** | Something a source shows or measures, or something we measured in Flux or the prototype. |
| **reviewer observation** | A named reviewer describing an Apple app they used. |
| **community — unverified** | One person's report or opinion. |
| **community — corroborated** | Several independent sources agree; the corroborating sources are named. |
| **inference** | Our reasoning from the above. Every Flux recommendation is an inference. |

Apple's WWDC session pages do not print a date; they are cited as "WWDC25 session (June 2025)"
or "WWDC26 session (June 2026)". HIG pages are cited with the latest date in their own change
log. All web sources were retrieved on 2026-10-06.

**Counting rules for the per-screen tables (section 5).** Counts are made at 390×844 on the first
viewport, at rest, without scrolling.

- A **label** is any visible run of chrome or metadata text: titles, subtitles, button and chip
  text, tab labels, status words, counts, help sentences, timestamps, author lines, placeholders,
  privacy lines. **Content** is not counted: message bodies, task and page titles, note text, a
  project's own name inside a list row.
- A **control** is any separately tappable target visible at rest, including the tab bar.
- "Before" counts are **observed**, each pinned to a revision (see the table in section 5).
  "After" counts are **proposals** (inference) and have not been built.

## 1. Apple's current design language

### What is current on 2026-10-06

- **iOS 26 (WWDC25, June 2025) introduced Liquid Glass.** Apple's Newsroom (2025-06-09) calls it
  a translucent material that "reflects and refracts its surroundings, while dynamically
  transforming to help bring greater focus to content", and says: "In iOS 26, when users scroll,
  tab bars shrink to bring focus to the content while keeping navigation instantly accessible."
  *vendor claim* [A1]
- **iOS 27 (WWDC26, June 2026; released 2026-09-14) refines it rather than replacing it.** Apple's
  iOS page: "Updates to Liquid Glass ensure exceptional readability with more uniform refraction
  and improved contrast", and "a new slider lets you easily customize how Liquid Glass looks, from
  ultraclear to fully tinted." *vendor claim* [A21]. Apple's Newsroom announced its release on
  2026-09-14 [A24]. MacRumors' report of the WWDC26 changes (2026-06-10) adds that when content
  scrolls under floating bars, "A uniform toolbar now appears across the top in these situations,
  keeping text legible while improving contrast", and that glass gets "a darkened edge" [A22].
  *vendor claim, relayed by a secondary source.* Apple did not publish a WWDC26 session about
  Liquid Glass; its design sessions include "Principles of great design", "Design intuitive search
  experiences" and "Craft clear names for features and labels in your app". *observed* (WWDC26
  video index) [A8, A9]
- **The HIG reintroduced its design principles on 2026-06-08** [A10]: Purpose, Agency,
  Responsibility, Familiarity, Flexibility, Simplicity, Craft and Delight. Two lines matter most
  for Flux:
  - "**Simplicity isn't minimalism.** Aim for a focused, useful experience that keeps the important
    things close by and lets the others fall away." *vendor claim* [A10]
  - The WWDC26 talk puts it more bluntly: "When we say simple, we don't mean minimal. If you bury
    all your functionality inside a single place, that might make your interface look more
    minimal, but it doesn't make it simple." and "In a simple interface, every element earns its
    place." *vendor claim* [A8]
- Since 2026-06-08 the HIG pages on tab bars, search fields, menus and scroll views carry updated
  guidance [A23]. In 2026-09 Apple added a page for the folding "iPhone Duo"; we found nothing in
  it that changes the phone guidance below (*inference*).

### The principles behind the look

WWDC25's design-system session names three principles: **hierarchy, harmony and consistency**
[A3]. Read together with the 2026 principles, Apple's method for calm is:

1. **Content first, controls in a separate layer.** "Liquid Glass defines a new functional layer in
   the UI, floating above your content to bring structure and clarity, without ever stealing
   focus." "As apps become more immersive and content-focused, the UI should support interaction
   where needed, and remain unobtrusive when it's not." *vendor claim* [A3]. The HIG: "Don't use
   Liquid Glass in the content layer" and "Use Liquid Glass effects sparingly." [A15]
2. **Hierarchy from layout, not decoration.** "Instead of relying on decoration, hierarchy should be
   expressed through layout and grouping." [A3] "Clarity is built with hierarchy, using order,
   spacing, and contrast to guide people to what's most important. When your hierarchy is strong,
   the most important item on the screen is always the most obvious one." [A8] *vendor claim*
3. **Fewer, grouped bar items; the rest in a More menu.** "If your bar is feeling too crowded, use
   it as a cue to remove anything unnecessary and move secondary actions into a more menu" [A3].
   The Toolbars page (2025-12-16): "Choose items deliberately to avoid overcrowding", "Minimize the
   number of groups … aim for a maximum of three", and "Keep actions with text labels separate"
   because a text button beside a symbol reads as one control [A11]. *vendor claim*
4. **Symbols for chrome, words where a symbol is ambiguous.** "Bars now rely more on symbols than
   text, and this shift is happening across the platform, including menus." But: "A pencil might
   suggest annotate, and a checkmark can look like confirm … When there's no clear shorthand, a
   text label is always the better choice." [A3] The Toolbars page: "Prefer simple, recognizable
   symbols for items instead of text, except for actions like edit that aren't well-represented by
   symbols", and "Use the standard Back and Close buttons … don't use a text label that says Back
   or Close." [A11] Toolbar icons are monochrome: "The monochrome palette reduces visual noise …
   use [tint] to convey meaning, like a call to action or next step, but not just for visual
   effect." [A4] *vendor claim*
5. **Navigation keeps its words.** Tab bars: "Include tab labels to help with navigation … Use
   single words whenever possible." (Tab bars, 2026-06-08) [A12] *vendor claim*
6. **Progressive disclosure.** "Use progressive disclosure to make layouts cleaner and easier to
   interact with. An interface with too much content and too many choices makes it harder to find
   information quickly" (Layout, 2026-09-09) [A13]. Context menus are "hidden by default, so people
   might not know [they're] there", so "Always make context menu items available in the main
   interface, too" (Context menus) [A20]. *vendor claim*
7. **Concentricity and harmony.** "By aligning radii and margins around a shared center, shapes can
   comfortably nest within each other." Three shape types: fixed radius, capsule (half the
   height), and concentric (parent radius minus padding). [A3] *vendor claim*
8. **Dividers replaced by a soft edge.** "Scroll edge effects reinforce that boundary, replacing
   hard dividers with subtle blur to reduce clutter and keep UI legible." They "are not
   decorative" and belong only where floating controls sit over scrolling content [A3]; one per
   view (Scroll views, 2026-06-08) [A14]. *vendor claim*

### How controls float, shrink and hide

- **Tab bar.** On iPhone it "floats above content at the bottom of the screen" on Liquid Glass.
  With an accessory such as Music's MiniPlayer, an app "can choose to minimize the tab bar and move
  the accessory inline with it when a person scrolls down. A person can exit the minimized state by
  tapping a tab or scrolling to the top of the view." (Tab bars, 2026-06-08) [A12] The developer
  API is `tabBarMinimizeBehavior(.onScrollDown)`; "the tab bar re-expands when scrolling in the
  opposite direction" (TV app example) [A4, A5]. *vendor claim*
- **Large titles.** "By default, a large title transitions to a standard title as people begin
  scrolling the content, and transitions back to large when people scroll to the top, reminding
  them of their current location." [A11] In iOS 26, "Large titles are now placed at the top of the
  content scroll view, and scroll with the content underneath the bar." [A5] Mail shows its unread
  count as a navigation subtitle [A5]. *vendor claim*
- **Toolbars** can be hidden "for a distraction-free experience … contextually … and offer ways to
  reliably restore hidden interface elements." [A11] The system groups image buttons on one glass
  background; text buttons, Done/Close and prominent buttons get their own [A5]. *vendor claim*
- **Search** moved toward the thumb: a search tab at the trailing end of the tab bar, or a search
  field or button in the bottom toolbar (Mail) that "animates up over [the] keyboard"; inline
  under the title in Music's library; a prominent search tab in Phone. [A9, A19] *vendor claim*

### Sheets, materials and motion

- **Sheets.** Partial-height sheets are inset, glass and nest in the display's corners; at full
  height they become opaque and anchor to the edges [A4]. "Include a grabber in a resizable sheet",
  "consider supporting the medium detent to allow progressive disclosure", and compose sheets in
  Messages and Mail are full height only (Sheets, 2026-03-24) [A18]. Sheets can morph out of the
  button that opened them [A4]. *vendor claim*
- **Materials.** Two Liquid Glass variants: Regular, "the most versatile … provides legibility
  regardless of context", and Clear, which "should only be used" over media-rich content with a
  dimming layer. "Always avoid glass on glass." Reduce Transparency makes it "frostier", Increase
  Contrast makes elements "predominantly black or white" with a border, Reduce Motion "disables any
  elastic properties". [A2, A15] *vendor claim*
- **Motion.** "Add motion purposefully, supporting the experience without overshadowing it",
  "Aim for brevity and precision in feedback animations", "generally avoid adding motion to UI
  interactions that occur frequently", and "Let people cancel motion" (Motion, 2025-09-09) [A16].
  Liquid Glass "dynamically morphs between the controls in each context", keeping "a singular
  floating plane" [A2]. *vendor claim*
- **Springs.** Apple animates with springs because "a spring can start with any initial velocity, so
  we get a natural feeling where our animation picks up right where the gesture ends." Two
  parameters, duration and bounce; "When you're not sure, use a spring with bounce 0"; bounce suits
  "the end of a gesture" [A6]. SwiftUI's default `spring(duration: 0.5, bounce: 0.0)`; the
  `smooth`, `snappy` and `bouncy` presets also default to a 0.5 s perceptual duration, with no,
  small and higher bounce [A7]. *vendor claim*

### Type scale (iOS, default "Large" text size)

From the HIG Typography page (change log 2025-12-16) [A17]. Default 17 pt, minimum 11 pt. *vendor
claim*

| Style | Size / leading (pt) | Weight | Typical use in Apple's apps (inference) |
| --- | --- | --- | --- |
| Large Title | 34 / 41 | Regular (Bold emphasized) | Top-level screen title at rest |
| Title 1 | 28 / 34 | Regular | Rare on phones |
| Title 2 | 22 / 28 | Regular | Section heads in content |
| Title 3 | 20 / 25 | Regular | Card titles |
| Headline | 17 / 22 | Semibold | Row titles, sender names |
| Body | 17 / 22 | Regular | Messages, notes, mail text |
| Callout | 16 / 21 | Regular | Secondary paragraphs |
| Subhead | 15 / 20 | Regular | Previews, second lines of rows |
| Footnote | 13 / 18 | Regular | Section footers, metadata |
| Caption 1 | 12 / 16 | Regular | Timestamps, badges |
| Caption 2 | 11 / 13 | Regular | The floor for any text (HIG minimum 11 pt) |

## 2. Apple's own apps as worked examples

**Method.** No iPhone was used. The descriptions come from Apple's *iPhone User Guide* for iOS 27
[G1–G15], whose pages describe where each control is and include screenshot alt text; from WWDC and the
HIG; and from Federico Viticci's MacStories reviews of iOS 26 (2025-09-15, background) [R1] and
iOS 27 (2026-09-14) [C3]. iOS 27 changed no app's structure (the guide's "What's new" lists
refinements only), so iOS 26 layouts are the baseline. Control counts are *inference*,
reconstructed from the guide's text, not counted on a device.

| App | Main screen, at rest | Words kept | Symbols only | Where secondary things go |
| --- | --- | --- | --- | --- |
| **Messages** | List: Edit, Filter, search field at the bottom, Compose (about 4 controls). Conversation: Back, the person's picture and name (tap for details), FaceTime; composer: +, field, Dictate, Send | "Edit", the name, the search placeholder | Back, Filter, Compose, FaceTime, +, Send | Rows: swipe right marks unread, swipe left deletes, touch and hold pins [G11, G14]. Bubbles: swipe right replies, touch and hold gives Reply and Tapbacks; Edit and Undo Send are on their own page [G1, G12, G13]. "Swipe left on the message bubble to see timestamps for all messages in the conversation." [G1] |
| **Mail** | Bottom toolbar: Filter on the leading side, Search and Compose on the trailing side [A4]; the unread count as the title's subtitle [A5]; More at the top | "Select" stays a word [R1] | Filter, Compose, Reply, Move, Delete | Swipe left and right, user-configurable ("Settings > Apps > Mail > Swipe Options") [G15]; touch and hold previews. The inbox's context-menu items also appear in the message view's toolbar [A20]. Rows show two lines of preview by default [G2]. |
| **Notes** | List grouped by date, More (view options), Search and New Note at the bottom. Editor: no title in the bar, "the first line of content typically supplies sufficient context" [A11]; Done, Share, Actions | Folder and note names | Compose, Done (✓), Share, format tools | Swipe to pin, move, delete; touch and hold; formatting in a non-modal sheet. An empty Recently Deleted folder is not shown [G3]. |
| **Reminders** | A grid of smart lists with counts, then My Lists | List names, counts | More, Add | One More menu holds eight commands; completed items hidden until "Show Completed" [G4]; swipe to delete or indent |
| **Photos** | Two labelled tabs (Library, Collections) and Search; an edge-to-edge grid; Years, Months, All appear as a segmented control when scrolling up [R1] | Tab labels; in Edit: Adjust, Filters, Crop, Cancel, Done | Share, Favorite, Delete, More | "tap it to hide the controls onscreen"; View Options hide screenshots and shared items, in Apple's words "to reduce clutter" [G5] |
| **Freeform** | Canvas tools along the bottom (text, media, shapes, drawing); More and Share at the top | Board names | Every tool | Touch and hold on a board; no Save, "Your board is saved automatically" [G6] |
| **Files** | Three labelled tabs, Recents, Shared and Browse (from a guide screenshot description; not re-checked) | Tab labels, names | More | Touch and hold offers "Copy, Move, Compress, Duplicate, or Delete" and more [G7]; one More menu for view and sort options (not re-checked) |
| **Settings** | "a hierarchy of lists" [A20]; every row a word; in iOS 27 search sits at the bottom and an Appearance section holds the Liquid Glass slider [G8] | Every row | — | The next level down; each app's settings under Apps |
| **Music** | Labelled tabs, including Library and Search [G9]; the MiniPlayer; the tab bar minimises on scroll [A12] | Tab labels | Playback controls in Now Playing | Touch and hold on rows; "Who's going to guess that you can long-press on a minimized tab bar in the Music app to switch from Home to Library?" [R1] |
| **Phone** | iOS 26's unified list (favourites, then recents and voicemail), Calls, Contacts and Keypad at the bottom, a prominent Search [A9, G10] | "Edit", tab labels | Search, Filter | Tapping a recent call opens its details; calling on tap is opt-in [G10]. People could switch back to the Classic layout: "Apple learned its lesson" [R1]. |

**Patterns across the apps** (*inference* from the table, each row *vendor claim* or *reviewer
observation* as cited):

- **Secondary things go, in order:** a swipe on the row, then touch and hold, then one More menu per
  screen, then a details page. Nothing secondary sits on every row as a visible button.
- **Words survive in four places:** tab labels, Edit / Select / Cancel / Done, Settings rows, and the
  content itself. Toolbars and composers are symbols.
- **Metadata waits until asked:** per-message times in Messages, completed reminders, screenshots in
  Photos, empty folders in Notes. The details page (tap the name in Messages) holds what a sidebar
  would show on a Mac.
- **The content gets the edge:** an edge-to-edge photo grid, a note with no title bar, controls that
  hide on a tap.
- **Hiding has a cost Apple has had to pay back:** Music's long press on the minimised tab bar is
  undiscoverable [R1]; NN/g criticised the label-less Back and "text on top of text" in iOS 26
  (2025-10-10, background) [R2]; Phone offers its old layout again [R1]; iOS 27 put search back into
  the tab bar [C3].

## 3. Practitioners and community, H2 2026

Only items dated on or after 2026-07-01. Reddit refused automated access (search JSON, the API
and old.reddit all returned a block page), so there is no Reddit evidence here; The Verge was
also unreachable. Sources were read on 2026-10-06; the three most important (Apple Newsroom,
Six Colors, MacStories) were re-read to check the quotes.

### What Apple changed after the first year

| Date | Finding | Label |
| --- | --- | --- |
| 2026-07-22 | iOS 27 beta adds `UIBarMinimization`, so the top navigation bar can collapse on scroll too; its `.never` option is for when "minimizing would make the interface feel unstable". Anton Gubarenko [C1] | observed (beta API) |
| 2026-08-11 | Beta 5 made the clearest end of the new slider even more transparent. 9to5Mac [C2] | observed |
| 2026-09-14 | iOS 27 released: "Refinements to the software design with Liquid Glass deliver an even more focused and approachable experience", with the slider "from ultraclear to fully tinted". Apple Newsroom [A24] | vendor claim |
| 2026-09-14 | The new default "is more tinted than the 'Clear' setting of iOS 26"; in Apple's apps "the search button is back inside the tab bar instead of floating next to it"; the "focus on fluid, compact interfaces" and on minimising chrome stays. Federico Viticci, MacStories [C3] | reviewer observation, corroborated by [C4] |
| 2026-09-14 | "far easier on the eyes, dialing down the transparency in favor of legibility"; "in list views like in Messages and Mail there are now much clearer 'toolbar' areas at the top when you start scrolling", which "vastly improves the feel over iOS 26". Dan Moren, Six Colors [C4] | reviewer observation with screenshots |

No source says iOS 27 removed the tab bar's minimise-on-scroll; the HIG still describes it [A12].

### What works

- **More separation between chrome and content reads better.** Viticci: iOS 27 glass is "what
  Liquid Glass should have been all along", "more legible", and the selected tab in Music's tab
  bar is "drastically more readable" (2026-09-14) [C3]. Moren says the same (2026-09-14) [C4].
  Jared White rebuilt the iOS 27 look in CSS and welcomed its "faint dark contrasting borders"
  after a first version that made "everything feel a bit fuzzy and ghostly" (2026-07-30) [C5].
  *Community — corroborated (three reviewers).*
- **A specific button beats a catch-all.** Safari's compact toolbar replaced its "…" with an All
  Tabs button; CNET's Jason Chun singles this out (2026-09-19) [C6], as Viticci did in June.
  *Community — corroborated.*
- **More tint for reading.** CNET's Zachary McAuliffe, after months on iOS 27, uses the frosted end
  because at the clear end it is "difficult to tell menus and background items apart"
  (2026-09-19) [C6]. *Community — corroborated with [C3, C4].*
- **Some readers came round.** On the Hacker News iOS 27 thread (2026-09-14, 856 comments) three
  users said it "has grown on" them or that the backlash was "highly overblown"; they were a
  minority in a mostly critical thread [C7]. *Community — unverified.*

### What is criticised

- **Legibility over scrolling content, still.** Even Viticci: at the clearest setting you "live with
  severe legibility issues in apps that scroll content under tab bars or floating toolbars"
  (2026-09-14) [C3]. On HN, Lock Screen notifications are "still unreadable even when you go full
  opaque" (2026-09-14) [C7]. *Community — corroborated (weakly).*
- **Blur costs speed.** Three separate HN threads report lower frame rates or slower interactions
  with glass on, and smoother phones with Reduce Transparency (2026-08-05, 2026-09-14,
  2026-09-22) [C8]. Nobody measured it. *Community — corroborated, unmeasured.*
- **Chrome that moves breaks habits.** "The floating bottom nav bar that keeps shrinking to an icon
  when you least expect it, moving all elements" (HN, 2026-09-14) [C7]. Designer Ilya Birman:
  "unstable positions and shapes of elements, which make it harder to develop habits. Or
  uninformative feedback …" (2026-08-23) [C9]. *Community — corroborated (two sources).*
- **"Calm" can turn into hidden features.** Reviewers who like iOS 27 still had to explain where
  features hide: Photos star ratings need a Settings toggle and "a small star icon"; Safari's tab
  grouping is behind a Filter button (Moren, 2026-09-14) [C4]; Viticci calls Photos' "Captured by
  Me" one of the best "hidden" features (2026-09-14) [C3]. *Community — corroborated.*

### Disconfirming voices

- **Clarity over sparseness.** Gruber: "I crave clarity, and Apple's current MacOS design language
  rejects clarity … literally a guessing game" (Daring Fireball, 2026-09-25, about macOS) [C10].
  *Community — unverified; about the Mac.*
- **Stock minimalism is not enough.** Former Apple designer Louie Mantia: many apps "ship with what
  appears like the most stock, standard UI, only changing the tint color. This is not enough"
  (2026-09-14) [C11]. Brent Simmons argues users do not care whether UI is stock (2026-09-22)
  [C12]; Mantia's earlier post argues shared conventions help people "more easily comprehend how
  all apps work" (2026-07-17) [C11]. *Community — unverified; they disagree with each other.*
- **Density matters to experts.** Four HN commenters in four threads (2026-09-14 to 2026-10-03)
  object to "needless padding" and to whitespace added by designers who do not use the product,
  and one notes macOS 27 kept "the giant padding areas 26 added" [C13]. *Community — corroborated;
  not about phones.* For Flux this argues for keeping desktop density and for not padding phone
  rows beyond what touch needs.
- **Phones are the easy case.** Birman argues the Mac exposes Liquid Glass's flaws more because it
  is used for more complex tasks (2026-08-23) [C9]. *Community — unverified.*

### Web apps and icon-only controls

- **Do not copy the material on the web.** Jared White: use it "as inspirational starting point",
  not a replica, and "don't replicate the original criticism of Liquid Glass … a readability
  nightmare" (2026-07-30) [C5]. An HN thread on "tells" of AI-generated UI lists glassmorphism
  (2026-09-27) [C14]. Two HN commenters report web glass effects degrading whole pages
  (2026-07-20, 2026-07-31) [C8]. *Community — corroborated.* Inference: a web copy of glass also
  misses Apple's yearly fixes, which native apps get "for free" [C3].
- **Icon-only controls need names and must be obvious.** Jake Archibald found his icon-only button
  read by VoiceOver as "Clickable image. Bold. Command B. Button" until he fixed its labelling
  (2026-07-28) [C15]; HN commenters ask for a visible "Search" label rather than only a magnifier
  (2026-08-29) and call unlabeled toolbars "mystery meat" (2026-08-16, 2026-09-24) [C16].
  A counter-view: for well-known concepts "an icon and tooltip will do" (2026-09-27) [C16].
  *Community — corroborated that ambiguous icon-only controls hurt.*

## 4. What carries over to a web app

Flux is a web app and PWA, not a native app. The [HIG checklist](../apple-hig-mobile.md#mapping-ios-guidance-to-the-web)
already records "Flux does not imitate Liquid Glass" as a Flux decision. This research supports
keeping it, and taking the **structure** instead of the **material**:

| Take | Leave | Why |
| --- | --- | --- |
| A control layer that is visibly separate from content: few, grouped controls at the top and bottom edges, content scrolling beneath | Refraction, lensing, the "gel" motion of glass | The structure is what makes Apple's screens calm [A3]. The material is the part Apple itself had to tune: iOS 27 adds "improved contrast" and an opacity slider [A21], and the community section records the legibility complaints. *inference* |
| A soft fade under the header where content scrolls beneath it, in place of hairline dividers | Glass on glass, translucent content cards | "replacing hard dividers with subtle blur to reduce clutter" [A3]; "Don't use Liquid Glass in the content layer" [A15]. *vendor claim* |
| Solid or lightly frosted bars with a solid fallback | Translucency that the person cannot turn off | `prefers-reduced-transparency` is **not supported in Safari or iOS Safari** (MDN browser-compat-data 8.1.4, 2026-10-01; Chrome 118, Firefox 113) [W1], so a web page cannot honour iOS Reduce Transparency. `backdrop-filter` is unprefixed only from Safari 18 [W1]. *observed* (compat data) |
| Monochrome symbols in bars; tint only for the one primary action | Coloured icons as decoration | [A4]. *vendor claim* |
| Spring-like easing that keeps a gesture's velocity | Bouncy decoration | CSS `linear()` easing, which can approximate a spring curve, is supported from Safari 17.2 [W1]. Springs with bounce 0 are Apple's default [A6, A7]. *inference* |
| The iOS type scale in `rem` | Assuming Dynamic Type works | A web page cannot read the iOS text-size setting; the checklist's `rem` rule (HIG-11) stands. *inference*, already recorded in the checklist |

## 5. Gap analysis: the Flux phone UI, screen by screen

### What was looked at

| Key | Revision | Evidence |
| --- | --- | --- |
| **P** | Studio 11.6 prototype (`supplied/flux-studio-v11.6.html`) | `references/studio-v11.6/inspection/*-390*.png`: chat, tasks, map, agents (Polish UI) |
| **M** | `main` at `e68c39c6` | The #267 phone-shell review capture of 2026-10-05 (scratchpad, not committed) for Thread, Map and Wiki, plus a code inventory of `main`. That capture predates the tab bar on every page, so 4 tab-bar labels and 4 controls are added to its counts. |
| **B** | PR #275 at `af1468a9` (F-023) | `docs/agents/evidence/272-friendly-flux/phone-390-*.png` on the PR branch, plus a code inventory of `claude-hubert/296-conversation-first` at `4fa1463c` |

The founder called P itself "terribly cluttered, too dense", so an "after" has to land clearly
below P, not only below today's app. #296 adds a labelled Search to the header of top-level
places (+1 label, +1 control on Home, Projects, Inbox and Settings); the B counts below do not
include it, but the "after" counts do, so the reductions there are slightly understated. The
labelled Search stays: the community evidence below asks for a visible "Search" word, and it
costs one label. On Thread, Map and Wiki, #275 replaces the menu button with Back and moves the
state line below the chips (no change in the counts).

Findings from the code inventory that the screenshots do not show (*observed*, code reading at
the revisions above):

- There is no long press, context menu or swipe action anywhere in the web app. The only gesture is
  the drag that dismisses the drawer and bottom sheets.
- On a phone the thread sheet covers only the stream: the header, chips, state line and tab bar stay
  on screen. UI116-1 already asks for "a full-screen sheet on the phone".
- People who cannot write see a "Details" text button under **every** message.
- Gutters differ by area: header 2 px, chips 10 px, conversation 17 px, board 18 px, wiki 20 px,
  most others 16 px.
- Several sizes bypass the type tokens on phones: tab labels 11 px, chips 13 px, tool tiles 10.5 px,
  task IDs and badges 10 px.
- The thread sheet enters from the right but is dismissed by dragging down (HIG-73: "if someone
  reveals a view by sliding it down from the top, they don't expect to dismiss the view by sliding
  it to the side").
- On a phone the sketch view hides its "Sketches" link, so there seems to be no visible way back to a
  project's list of sketches (medium confidence).
- #296's code steps the chips aside after 48 px of reading back and brings them back after 48 px
  toward the newest; the issue's acceptance tests 300 px and 100 px.

### Counts

Labels and controls per the [counting rules](#evidence-labels-and-counting-rules). "After" is a
proposal.

| Screen | P labels / controls | Today labels / controls | After labels / controls | Change in labels |
| --- | --- | --- | --- | --- |
| Home | — | B 20 / 13 | 16 / 12 | −20 % |
| Projects list | — | B 8 / 8 | 7 / 9 | −13 % |
| Project Conversation | 24 / 18 | B 31 / 29 | 18 / 18 | −42 % |
| Thread | — | M 29 / 24 | 4 / 5 | −86 % |
| Tasks | 20 / 20 | B 36 / 29 | 16 / 20 | −56 % |
| Map | 15 / 25 | M 29 / 29 | 14 / 20 | −52 % |
| Wiki (a page) | — | M 23 / 22 | 14 / 15 | −39 % |
| Agents (none connected) | 34 / 29 (agents connected; not comparable) | B 26 / 18 | 16 / 14 | −38 % |
| Settings | — | B 29 / 15 | 16 / 12 | −45 % |
| Inbox | — | B 13 / 15 | 11 / 12 | −15 % |
| DM conversation | — | B 27 / 13 | 9 / 10 | −67 % |

P has no tab bar. Without the tab bar's five labels and five controls, the "after" counts are
Conversation 13 / 13, Tasks 11 / 15 and Map 9 / 15, against P's 24 / 18, 20 / 20 and 15 / 25.

**Share of the screen for content in a project conversation** (390×844, no keyboard):
P about 70 % (no tab bar); B about 60 % (504 of 844 px under a 150 px header, chips and state
line and a 191 px composer and tab bar); after: 70 % with the decision banner, 74 % without it,
and 79 % while reading back with the chips hidden (header 52 + chips 44 + banner 36 + one-row
composer 60 + tab bar 61 px). These are estimates from the screenshots, not measurements of a
build.

### Per screen: what to remove, turn into a symbol, or move

Owners: **H** claude-hubert (shell and navigation, #275 and #296), **Mz** claude-maurycy
(sending and offline #299, motion #286). "Unassigned — proposed" means no issue exists yet.

**Project Conversation** (B 31 / 29 → 18 / 18)

- *Header.* Keep Back and the title. Show the audience as the one subtitle line ("Jonas and you").
  Move the goal and "Details" out: the title itself opens Details, with a small chevron to show it
  can be tapped, as the name does at the top of a Messages conversation. Move "Together" into the
  Details sheet, and show it in the header only while a live session is on. **H.** Changes PF-2
  ("a labelled Details button") and FF-10 ("the title with its audience and goal on one line").
- *State line.* Replace "Decision needs you · 1 blocked · What matters" with one banner that shows
  only when something waits for the reader ("1 decision needs you ›"). When nothing waits, show
  nothing. "What matters" moves into Details. **H.** Changes PF-2 and FF-10's state line.
- *View chips.* Plain text segments: the current one filled, the others with no outline. Keep the
  #296 hide-on-scroll. **H.** Changes PF-1's "the others are outlined".
- *Messages.* Group consecutive messages from one person: name on the first only, never "· you" on
  your own (they sit on the right). Replace per-message times with a centred time line when the
  day changes or after a gap (Flux choice: 15 minutes); exact time on long press. "3 replies · last
  03:45 AM" plus "Reply" become one link, "3 replies", or "Reply" when there are none.
  **Unassigned — proposed: Mz** (the stream, next to #299's sending states). No contract change;
  UI116-1 keeps own messages right.
- *"…" on each message.* Becomes a long press (context menu: Reply, Task, Decision, Result,
  Details, Copy). The visible route stays: opening the thread shows the root with the same actions
  in its toolbar, and each message keeps an accessible "Actions" button for VoiceOver and keyboard,
  which keeps HIG-88 and HIG-94. Readers' per-message "Details" goes the same way. **Unassigned —
  proposed: Mz.** Open decision D2, see section 9.
- *Task announcements.* A run of announcements collapses to one row, "Ada added 5 tasks", with
  only the exceptions shown ("1 blocked"). Tapping expands it in place. **H** (FF-10 author).
  Changes FF-10's "each task … says where it stands now".
- *Composer.* One row: "+" (Attach, Cite, Ask the assistant), the field, Send. Send is tinted only
  when there is text. The audience line under the box goes, because the header subtitle says it.
  **Mz after #299**, coordinating with **H** on PF-3. Changes PF-3 ("the audience as one quiet line
  under it").

**Thread** (M 29 / 24 → 4 / 5)

- Make it the full-screen sheet UI116-1 already asks for, covering the header, chips, state line
  and tab bar (a modal is the HIG-20 exception). Grabber, Close (×), the root's first line as the
  title. **H** (#296 already adds the grabber).
- Remove "#5" sequence numbers on phones, the per-reply time and "· you"; names only when the
  author changes; one time line. **Unassigned — proposed: Mz.**
- Remove "Replying to · …" (the sheet title says it) and the audience line. Composer as in
  Conversation. **Mz after #299.**
- Enter from the bottom, so the drag down that closes it mirrors how it came (HIG-73). **Mz** (#286).

**Tasks** (B 36 / 29 → 16 / 20)

- On phones show a list grouped by status by default, as Reminders does, with the board as an
  option. The status tabs become the one filter: "Open 2 · Doing 2 · Done 1".
- Toolbar: a Search symbol, a "…" menu (Board or List, Only mine, Decisions and results) and one
  tinted "+" (accessible name "New task"). Remove the "New task" row, which repeats "+".
- Rows: the title and one caption, only when it adds something ("Blocked · waiting for the probe
  dimensions"). Your own name and initials go; another person's avatar stays. The origin link
  ("Sensor shortlist") moves into the task.
- A waiting decision shows as the project's banner (Conversation), not as a toolbar badge.
- Unassigned — proposed: **Mz**. Changes PF-6 (six labelled tools; "Search is a target as wide as its
  tile").

**Map** (M 29 / 29 → 14 / 20)

- At rest show only "+ Thought" (the one tinted action, keeping its word because "Thought" is
  Flux's noun), Undo and "…". When a thought is selected, a contextual bar brings Connect, Edit,
  Shape, Task and Remove. **Unassigned — proposed: Mz.** Changes
  PF-6's "The map's tools are one row, each an icon over its label".
- Remove "From you · 23:58" on every thought (long press or the thought's detail). Remove the
  permanent help paragraph; show it once, in an empty sketch.
- The audience line moves to Details. Map | List moves into "…". Zoom: pinch plus "Fit"; "100 %",
  "−" and "+" go on touch.
- Restore a way back to the sketch list (the sketch name as a menu). Fixes the gap noted above.

**Wiki** (M 23 / 22 → 14 / 15)

- Like Notes: a list of pages (search field, rows, a compose symbol for "New page"), then the page.
- Page toolbar: Edit (a word, per the HIG), Share (the standard share symbol, not a paper plane),
  and "…" for History, Focus, Download and Import .md.
- One meta line ("Edited 5 Oct by Ada"). Hide "Linked from" when nothing links. The privacy line
  and "Started by" move to the page's info. **Unassigned — proposed.**

**Agents, none connected** (B 26 / 18 → 16 / 14)

- Apple's empty-state shape: a symbol, a title ("No agents yet"), one sentence, two buttons ("Connect
  an agent", "Use the agent in Flux"). The lead paragraph, the two descriptions, the footnote and the
  task picker wait until an agent exists; the descriptions move behind each button's next screen.
  **H** (FF-8 author). Changes FF-8's wording, not its function.

**Home** (B 20 / 13 → 16 / 12)

- The greeting becomes the large title, with the date as a small line above it. It collapses into
  "Home" on scroll. **H.**
- Replace the menu button with the person button (Settings and sign out) on the right, next to
  Search; the tab bar already covers the places the drawer lists. **H.** Changes PF-5 and FF-4
  ("through the drawer or the person row").
- Return card: drop "Pick up where you left off" (the card's place says it), keep the title, one
  reason line, the project and one button, "Continue".
- My work: drop the permanent explanation and the Active / All switch; a "See all" in the section
  head instead. **H.** Changes FF-2.

**Projects list** (B 8 / 8 → 7 / 9)

- Large title; "New project" becomes a "+" symbol in the header (accessible name "New project").
  The sentence "Each project has one conversation, a map, tasks, a wiki and its agents." moves to
  the empty state. **H.**

**Settings** (B 29 / 15 → 16 / 12)

- Like iOS Settings: grouped rows, each one label, an optional value on the right ("System",
  "Off on this device") and a chevron; the explanations live one level down. Appearance and Accent
  go to one "Appearance" page. The sign-in expiry line goes to Account. **H** (FF-4 author).

**Inbox** (B 13 / 15 → 11 / 12)

- Like Mail: an unread dot, the title with the time on the right ("11m"), one line of preview. The
  "Direct message ·" kind words go (the icon says it). The per-row check buttons go: opening a row
  marks it read, a swipe marks it read or unread, and "…" holds "Mark all read" and notification
  settings. **Unassigned — proposed.** HIG-88: the swipe needs the "…" and accessible actions as
  alternatives.

**DM conversation** (B 27 / 13 → 9 / 10)

- Messages' layout: Back, the person's name (tap for details: Sketches, "Sketch from messages",
  who can read it). The Messages | Sketches chips go. **H.**
- No name or time on each message in a one-to-one chat; time lines at gaps; the other person's
  avatar once at the end of their run. The privacy sentence stays at the top of the history and
  in the placeholder ("Message Jonas"); the line under the composer goes. **Unassigned — proposed:
  Mz.**

## 6. Spacing, collapsing chrome, type and motion

Everything in this section is a proposal (*inference*) for phones: coarse pointer, at most
640 px wide. Desktop is unchanged.

### Spacing

| Thing | Today (observed) | Proposal | Basis |
| --- | --- | --- | --- |
| Side gutter | Differs by area: header 2, chips 10, most views 16, conversation 17, board 18, wiki 20 px | 16 px everywhere | Matches the leading inset of Apple's lists on 390-pt iPhones. *Practitioner knowledge; no primary source found.* |
| Bands between header, chips, state line | Three 1 px rules in the top 150 px of Conversation | No rules at rest. One opaque header band that gains a soft edge only while content is scrolled beneath it | "replacing hard dividers with subtle blur" [A3]; one edge effect per view [A14]; iOS 27's "uniform toolbar" when content scrolls under the bars [A22, C4] |
| Rhythm | 4 px grid tokens `--s-1`…`--s-12` | Use the 8 px steps: 8 inside a group, 16 between groups, 32 between sections | Grouping "with negative space" [A13]. Values are a Flux choice. |
| Messages from one sender in a row | Name, time, "you" and a menu on every project message | 4 px apart, name only on the first, no per-message time | Messages and Messenger group consecutive bubbles (section 2) |
| Between senders | 24 px between project messages | 12–16 px | Same |
| Rows | Varied, many three-line rows | One-line 44 px minimum; two-line rows 60–64 px; no third line on phones except Inbox previews | HIG-14, HIG-60 "Keep item text succinct" [A20] |

### Header, chips and tab bar on scroll

- **Top-level places** (Home, Projects, Messages, Inbox, Sketchbook, Settings) use a **large title**
  at the top of the content, 34/41 bold. On scroll it moves up under the header and a 17 px
  semibold inline title fades in; at the top it returns. The header row at rest holds no
  duplicate title, only the trailing controls (Search and the person button). [A5, A11]
- **Inside a place** (a project, a DM, a thread) the title is inline from the start, as in a
  Messages conversation: Back, title with one subtitle line, one trailing control.
- **View chips** hide while reading back and return on the way to the newest, as #296 does
  (48 px in its code). That matches Apple's `onScrollDown` minimise, which "re-expands when
  scrolling in the opposite direction" [A4, A5]. Hide them with `transform` and let the stream run
  beneath the header, so the content does not jump.
- **Tab bar:** an open decision; see [section 9](#9-open-decisions-and-contract-amendments).

### Type scale for phones

Today `main` uses 10/11/12/14 px for meta, names, controls and reading text; #275 raises phones to
12/13/14/16 px in `rem`. The proposal aligns the steps with iOS text styles and cuts them to six:

| Role | iOS style [A17] | px | rem | Used for |
| --- | --- | --- | --- | --- |
| Large title | Large Title, bold | 34 / 41 | 2.125 | Top-level title at rest |
| Section | Title 3, semibold | 20 / 25 | 1.25 | "My work", Settings group heads (rare) |
| Row title, name, inline title | Headline | 17 / 22 | 1.0625 | Row titles, sender names, header title |
| Reading | Body | 17 / 22 | 1.0625 | Messages, notes, wiki text, the composer field (≥ 16 px, so no focus zoom) |
| Secondary | Subhead | 15 / 20 | 0.9375 | Previews, second lines, the header subtitle |
| Meta | Footnote | 13 / 18 | 0.8125 | Time separators, status captions |
| Smallest | Caption 1 | 12 / 16 | 0.75 | Counts and badges; never below 11 px |

The difference from #275 is small: reading text goes from 16 to 17 px and the 14 px step goes.
This is claude-hubert's type-scale work in #275.

### Motion

Today (`app/apps/web/src/ui/tokens.css` on `main`): `--dur-1` 120 ms (colour), `--dur-2` 180 ms
(content), `--dur-3` 260 ms (indicators, panels, drawers), `--dur-4` 340 ms (phone sheets);
`--ease-out` `cubic-bezier(.22, 1, .36, 1)`, `--ease-sheet` `cubic-bezier(.32, .72, 0, 1)`, and
`--ease-glide` with a slight overshoot. All are 0 ms under reduced motion.

| Moment | Proposal | Basis |
| --- | --- | --- |
| Push and Back (list → conversation) | ~350 ms, no bounce; the incoming view slides from the trailing edge, the outgoing one moves a third of the way and dims | iOS navigation feel. *Inference from use; no primary source states the numbers.* |
| Sheet open and drag | Opens in ~400 ms with no bounce. While dragged it follows the finger 1:1. On release it carries the finger's velocity: a spring, approximated with CSS `linear()` | "a spring can start with any initial velocity" [A6]; bounce 0 by default [A6, A7]; `linear()` from Safari 17.2 [W1] |
| Large title and chips collapsing | Tied to scroll position, not a timer; where a timer is unavoidable, 200–250 ms ease-out, transform and opacity only | [A11]; UI116-5 "no animated layout reflow" |
| Press | The pressed look appears on touch-down in the same frame and fades out over 120 ms; no scale bounce on frequent controls | "avoid adding motion to UI interactions that occur frequently" [A16] |
| New message | Keep UI116-5: 4 px rise and fade, only for arrivals | [A16] "brevity and precision" |
| Reduce Motion | Keep: every duration 0, every state change kept | HIG-76 |

Smoothness is also the absence of jumps: no reflow when chips hide, no blank gap above the
composer (#296 item 4), and no delay between a tap and its response (HIG-17). This is
claude-maurycy's motion work after #286.

## 7. Principles for the Flux phone UI

Ten rules, each tied to evidence. They add to the HIG checklist; where one changes a contract,
section 9 names the clause.

1. **Content gets the screen; chrome is a thin layer at the edges.** At rest a conversation shows
   content in at least 70 % of a 390×844 viewport, and about 80 % while reading back. Today it is
   about 60 % (section 5). [A1, A3; HIG-02, HIG-03]
2. **Simple is not minimal: remove repetition and explanation, never functions.** Every function
   stays reachable in at most two taps from where it applies, through something visible. [A8, A10;
   F-023 "nothing may be removed"; HIG-94]
3. **Words for navigation and for ambiguous actions; standard symbols for the rest.** Tab labels
   stay, and so does the header's "Search". Back, Close, Add, More, Share, Attach and Send are
   icon-only with an accessible name. Edit, Done, Select, Connect and Flux's own nouns stay words.
   [A3, A11, A12; C15, C16; HIG-22, HIG-26, HIG-55, HIG-57]
4. **One tinted primary action per screen; everything else monochrome.** [A4; HIG-56]
5. **Say each thing once.** A screen names its place, audience, status and time in one spot each,
   not on every item. [Messages and Mail, section 2; HIG-110 "If you can use fewer words, do so"]
6. **Metadata on demand.** Exact times, sequence numbers, authorship detail and version info move
   to a long press, a swipe or Details, and each also has a visible or accessible route. [A20;
   HIG-88, HIG-94]
7. **Explain once, in empty states and Details, not on every visit.** No permanent help sentence on
   a working screen. [A10 "Be concise"; HIG-103, HIG-115]
8. **Group with space, not lines.** An 8 px rhythm, 16 px gutters, no hairlines between header
   bands; a soft fade only where content scrolls under controls. [A3, A13, A14]
9. **Chrome steps aside while reading and returns on the way back.** Large titles collapse, chips
   hide on scroll down, the keyboard hides the tab bar. [A4, A5, A11; #296]
10. **Motion follows the finger.** Springs without bounce, velocity carried over from gestures,
    nothing animated on frequent actions, all of it off under Reduce Motion. [A6, A16; HIG-73 to
    HIG-76]

## 8. The 15 changes with the most effect

Ordered by their effect on "calm and uncluttered" on the screens people use most (an
*inference*: the conversation first, because the founder's comparison is Messenger). Effort is
in agent-days: **S** under one day, **M** one to three, **L** more. Owners as in section 5.

| # | Change | Screens | Owner | Effort | Contract it changes |
| --- | --- | --- | --- | --- | --- |
| 1 | **One quiet header inside a place:** Back, the title with one audience line, the title opens Details. Goal, "Details" text and the people button leave the header. No rules between header bands; one soft fade while content is underneath. | Conversation, Tasks, Map, Wiki, Agents, DM | H | S–M | PF-2 "a labelled Details button"; FF-10 header clause |
| 2 | **Messages grouped like Messages and Messenger:** name on the first of a run, no "· you", time lines at gaps instead of per-message times, no "#n" on phones, "3 replies" as one link | Conversation, Thread, DM | Unassigned — proposed: Mz | M | none (UI116-1 kept) |
| 3 | **Message actions on long press,** with an accessible "Actions" button and the same actions in the thread; no visible "…" or per-message "Details" on phones (pending D2) | Conversation, Thread | Unassigned — proposed: Mz | M | open decision D2 |
| 4 | **One-row composer:** "+" (Attach, Cite, Ask the assistant), field, Send; no audience line under it | Conversation, Thread, DM | Mz after #299, with H | S–M | PF-3 "audience as one quiet line"; FF-7 "Attach, mention and AI are the composer's tools" (kept, behind "+") |
| 5 | **The state line becomes a banner only when something waits** ("1 decision needs you ›"); "What matters" moves into Details | Conversation | H | S | PF-2 state line; FF-10 "the state line … on Conversation" |
| 6 | **The thread is a real full-screen sheet** over header, chips and tab bar, entering from the bottom; its own meta stripped as in #2 | Thread | H (sheet), Mz (motion, meta) | M | none: implements UI116-1 "a full-screen sheet on the phone" |
| 7 | **Runs of task announcements collapse** into "Ada added 5 tasks", showing only exceptions | Conversation | H | S | FF-10 per-task status words |
| 8 | **No permanent help sentences on working screens;** they move to empty states and Details (Projects, My work, For you, map help, Agents lead, Sources tray, wiki "Linked from") | all | H, Mz | S | FF-1 "in words"; FF-2 |
| 9 | **Top-level places get large titles** that collapse on scroll; on phones the person button replaces the menu button | Home, Projects, Messages, Inbox, Sketchbook, Settings | H | M | PF-5 and FF-4 (Settings "through the drawer") |
| 10 | **Tasks on a phone:** a list grouped by status, one status filter, toolbar of Search, "…" and one "+"; rows with a title and one caption | Tasks | Unassigned — proposed: Mz | M | PF-6 six labelled tools and the "New task" row |
| 11 | **Map tools in context:** "+ Thought", Undo and "…" at rest; Connect, Edit, Shape, Task and Remove only with a selection; no meta on thoughts; a way back to the sketch list | Map | Unassigned — proposed: Mz | M | PF-6 map tool row |
| 12 | **Settings as iOS Settings rows:** one label, a value, a chevron; explanations one level down | Settings | H | S | FF-4 layout only |
| 13 | **DM like a Messages conversation:** the name opens details (Sketches, who can read), no chips, no per-message names and times | DM | H (header), Mz (stream) | S–M | PF-1 DM chips |
| 14 | **Tokens instead of one-off sizes:** the iOS-aligned scale of section 6 (reading text 17 px), one 16 px gutter, plain segments for the views without outlines | all | H | S | PF-1 "the others are outlined"; #275 scale |
| 15 | **Motion that follows the finger:** sheets and pushes with no-bounce spring easing via `linear()`, velocity carried on release, the pressed look on touch-down | all | Mz | S–M | PF-4 tokens (kept, re-tuned) |

Not in the top 15 but in section 5: Inbox rows (unassigned), the Wiki page toolbar (unassigned)
and the Agents empty state (H).

## 9. Open decisions and contract amendments

This note proposes; it does not amend. Each item below needs the clause updated first, then
independent peer review, per AGENTS.md.

### D1. The tab bar inside a conversation

The founder asks for Messenger's feel, and Messenger hides its bottom bar inside a chat. The
[HIG checklist](../apple-hig-mobile.md#tab-bars) makes HIG-20 ("Make sure the tab bar is visible
when people navigate to different sections of your app") a Must, and PF-1 keeps the bar on every
page. Apple's own Messages has no tab bar at all, so it is not evidence either way. Three options:

| Option | What it does | Contract it touches | Evidence |
| --- | --- | --- | --- |
| a. Keep it visible | Today's behaviour; costs ~61 px plus the home indicator | none | HIG-20 [A12] |
| b. Minimise on scroll | While reading back, the bar shrinks to the current place's icon; it returns on scrolling toward the newest, on reaching it, or on a tap | PF-1 "the bar stays on every page" → "visible or minimised" | Apple's `onScrollDown` behaviour and Music's minimised bar [A4, A5, A12]; but users report a bar that "keeps shrinking … when you least expect it" and positions that move as harder to learn [C7, C9] |
| c. Hide inside a conversation | Back returns to the list, as in Messenger | HIG-20 (Must) and PF-1 | Messenger and WhatsApp (practice from use, not guidance; not re-checked on a device for this note) |

The evidence leans toward (b), but it is a peer decision.

### D2. Hidden message actions

Moving "…" to a long press is the largest single declutter (one control per message), but a long
press on iOS Safari also selects text and opens link previews, and HIG-88 and HIG-94 require a
visible alternative. The proposal only holds if all three stay true: an accessible "Actions" button
on each message for VoiceOver and keyboard; the same actions in the thread's toolbar; and the long
press tested on a real iPhone (`-webkit-touch-callout` and selection behaviour). Until a device
check exists, the "…" stays.

### D3. Words or symbols in Flux's chrome

PF-2 says "No control is a bare icon whose meaning has to be guessed (#264)" and "Every header and
toolbar control shows a text label"; FF-1 asks for no "icon whose meaning must be guessed" and for
statuses explained "in words". Apple's Toolbars page (2025-12-16) says the opposite for standard
actions: "Prefer simple, recognizable symbols for items instead of text, except for actions like
edit that aren't well-represented by symbols" [A11]; WWDC25 adds that "When there's no clear
shorthand, a text label is always the better choice" [A3]. Proposed wording for both clauses: a
fixed list of standard symbols may be icon-only with an accessible name (Back, Close, Add, More,
Share, Attach, Send); every other control keeps a word; explanations live in empty states, Details
and accessible names rather than on the working screen.

### D4. Studio 11.6 density on phones

UI116-1 asks for "11.6's calm neutral surfaces, compact typography". The founder now calls the 11.6
prototype "terribly cluttered, too dense". Proposed: on phones, density follows this note (iOS text
styles, one control layer, metadata on demand); desktop keeps the 11.6 density.

### Amendments at a glance

| Clause | Says today | Proposed |
| --- | --- | --- |
| PF-1 | Chips: current filled, "the others are outlined"; the bar "stays on every page" | Plain segments; tab bar per D1 |
| PF-2 | One 52 px header with "a labelled Details button"; state line on Conversation; "Every header and toolbar control shows a text label" | Back, title with audience, title opens Details; banner only when something waits; D3 |
| PF-3 | "the audience as one quiet line under it" | Audience in the header subtitle and the placeholder |
| PF-5, FF-4 | Settings from the drawer's account row on phones | From the person button on top-level places |
| PF-6 | Six labelled Tasks tools; the "New task" row; one row of labelled map tools | Section 5's Tasks and Map |
| FF-1 | Everything explained "in words" | D3 |
| FF-2 | Permanent explanations under My work and For you; Active / All switch | Explanations in empty states; "See all" |
| FF-10 | Header: "the title with its audience and goal on one line"; each announced task says where it stands | Goal in Details; collapsed runs with exceptions only |
| UI116-1 | "compact typography" | D4 |

## 10. Uncertain or unverified

- **iOS 27 specifics.** Apple's own words are marketing-level ("improved contrast", the slider); the
  detail comes from reviewers. No WWDC26 session is about Liquid Glass.
- **Measurements of Apple's apps.** Section 2's numbers are from Apple's pages, reviewers and
  practitioner knowledge, marked as such; no iPhone was used for this note. The 16 pt margin, row
  heights and push duration have no primary source.
- **Counts.** "Before" counts come from 1× screenshots and code reading at the pinned revisions, by
  one person; another counter may differ by one or two per screen. B predates #296. "After" counts
  are proposals. The content-share figures are estimates from screenshots.
- **Long press and swipes on the web.** iOS Safari's own long-press behaviour (selection, link
  previews) and the edge swipe can collide with app gestures; this needs a real iPhone (D2,
  HIG-29).
- **Whether fewer words confuses new people.** Apple's own warning, "Simplicity isn't minimalism"
  [A10], and the reviewers' "hidden features" [C3, C4] say it can. After the first changes, watch a
  person who has never used Flux complete one task on a phone.
- **Reduce Transparency.** Safari does not support `prefers-reduced-transparency` (compat data of
  2026-10-01) [W1], so any translucency Flux adds cannot follow that setting.
- **Community coverage.** No Reddit and no X threads (blocked); Daring Fireball only from
  2026-09-24; NN/g had nothing in the window.

## Sources

All retrieved on 2026-10-06. WWDC session pages carry no date; the date given is the conference.
HIG pages are dated by the latest entry in their own change log.

**Apple (vendor claims)**

- [A1] Apple Newsroom, "Apple introduces a delightful and elegant new software design", 2025-06-09. <https://www.apple.com/newsroom/2025/06/apple-introduces-a-delightful-and-elegant-new-software-design/>
- [A2] WWDC25 session 219, "Meet Liquid Glass" (June 2025). <https://developer.apple.com/videos/play/wwdc2025/219/>
- [A3] WWDC25 session 356, "Get to know the new design system" (June 2025). <https://developer.apple.com/videos/play/wwdc2025/356/>
- [A4] WWDC25 session 323, "Build a SwiftUI app with the new design" (June 2025). <https://developer.apple.com/videos/play/wwdc2025/323/>
- [A5] WWDC25 session 284, "Build a UIKit app with the new design" (June 2025). <https://developer.apple.com/videos/play/wwdc2025/284/>
- [A6] WWDC23 session 10158, "Animate with springs" (June 2023). <https://developer.apple.com/videos/play/wwdc2023/10158/>
- [A7] SwiftUI `Animation`: `spring(duration:bounce:blendDuration:)`, `smooth`, `snappy`, `bouncy`. <https://developer.apple.com/documentation/swiftui/animation>
- [A8] WWDC26 session 250, "Principles of great design" (June 2026). <https://developer.apple.com/videos/play/wwdc2026/250/>
- [A9] WWDC26 session 292, "Design intuitive search experiences" (June 2026). <https://developer.apple.com/videos/play/wwdc2026/292/>
- [A10] HIG, Design principles, 2026-06-08. <https://developer.apple.com/design/human-interface-guidelines/design-principles>
- [A11] HIG, Toolbars, 2025-12-16. <https://developer.apple.com/design/human-interface-guidelines/toolbars>
- [A12] HIG, Tab bars, 2026-06-08. <https://developer.apple.com/design/human-interface-guidelines/tab-bars>
- [A13] HIG, Layout, 2026-09-09. <https://developer.apple.com/design/human-interface-guidelines/layout>
- [A14] HIG, Scroll views, 2026-06-08. <https://developer.apple.com/design/human-interface-guidelines/scroll-views>
- [A15] HIG, Materials, 2025-09-09. <https://developer.apple.com/design/human-interface-guidelines/materials>
- [A16] HIG, Motion, 2025-09-09. <https://developer.apple.com/design/human-interface-guidelines/motion>
- [A17] HIG, Typography, 2025-12-16 (iOS "Large (default)" Dynamic Type table). <https://developer.apple.com/design/human-interface-guidelines/typography>
- [A18] HIG, Sheets, 2026-03-24. <https://developer.apple.com/design/human-interface-guidelines/sheets>
- [A19] HIG, Search fields, 2026-06-08. <https://developer.apple.com/design/human-interface-guidelines/search-fields>
- [A20] HIG, Context menus (2023-12-05) and Lists and tables (2023-06-21). <https://developer.apple.com/design/human-interface-guidelines/context-menus>, <https://developer.apple.com/design/human-interface-guidelines/lists-and-tables>
- [A21] Apple, iOS 27 page. <https://www.apple.com/ios/>
- [A22] Hartley Charlton, MacRumors, "How Liquid Glass Is Changing in iOS 27", 2026-06-10 (secondary report of Apple's WWDC26 claims). <https://www.macrumors.com/2026/06/10/how-liquid-glass-is-changing-in-ios-27/>
- [A23] Apple Design, "What's new" (HIG and resource change list). <https://developer.apple.com/design/whats-new/>
- [A24] Apple Newsroom, "Major updates for Apple's software platforms are now available", 2026-09-14. <https://www.apple.com/newsroom/2026/09/major-updates-for-apples-software-platforms-are-now-available/>

**Web platform (observed)**

- [W1] MDN browser-compat-data 8.1.4 (2026-10-01): `css.at-rules.media.prefers-reduced-transparency`
  (no Safari, no iOS Safari; Chrome 118; Firefox 113), `css.types.easing-function.linear-function`
  (Safari 17.2), `css.properties.backdrop-filter` (Safari 18). <https://github.com/mdn/browser-compat-data>

**Practitioners and community (H2 2026)**

- [C1] Anton Gubarenko, "iOS 27: UIBarMinimization", 2026-07-22. <https://antongubarenko.substack.com/p/ios-27-uibarminimization>
- [C2] 9to5Mac, "iOS 27 beta 5 lets you make Liquid Glass more transparent than ever", 2026-08-11. <https://9to5mac.com/2026/08/11/ios-27-beta-5-lets-you-make-liquid-glass-more-transparent-than-ever/>
- [C3] Federico Viticci, MacStories, "iOS and iPadOS 27 review", 2026-09-14, pages 2 and 11. <https://www.macstories.net/stories/ios-and-ipados-27-review/2/>
- [C4] Dan Moren, Six Colors, "iOS 27 review: Little things mean a lot", 2026-09-14. <https://sixcolors.com/post/2026/09/ios-27-review-little-things-mean-a-lot/>
- [C5] Jared White, That HTML Blog, "Liquid Glass 2.0 in CSS (Aqua's Revenge)", 2026-07-30. <https://thathtml.blog/2026/07/liquid-glass-in-css-liquid-aqua/>
- [C6] Zachary McAuliffe, CNET, "I've been using iOS 27 for months", 2026-09-19. <https://www.cnet.com/tech/services-and-software/ive-been-using-ios-27-for-months-heres-whats-great-and-what-i-hope-they-change/>
- [C7] Hacker News, "iOS 27, iPadOS 27, and macOS 27", 2026-09-14, and replies of 2026-09-14 and 2026-09-21. <https://news.ycombinator.com/item?id=49701004>, <https://news.ycombinator.com/item?id=49702472>, <https://news.ycombinator.com/item?id=49790932>
- [C8] Hacker News comments on the cost of blur: <https://news.ycombinator.com/item?id=49183049> (2026-08-05), <https://news.ycombinator.com/item?id=49702524> (2026-09-14), <https://news.ycombinator.com/item?id=49795082> (2026-09-22); on web glass: <https://news.ycombinator.com/item?id=48985102> (2026-07-20), <https://news.ycombinator.com/item?id=49125355> (2026-07-31)
- [C9] Ilya Birman, "Liquid Glass and the Mac's low priority", 2026-08-23. <https://ilyabirman.net/meanwhile/all/liquid-glass-on-mac/>
- [C10] John Gruber, Daring Fireball, 2026-09-25. <https://daringfireball.net/linked/2026/09/25/stock-ui-in-macos-27-eschews-clarity>
- [C11] Louie Mantia, "Design Drought", 2026-09-14, and "Perceived Stability", 2026-07-17. <https://lmnt.me/blog/design-drought.html>, <https://lmnt.me/blog/perceived-stability.html>
- [C12] Brent Simmons, "That About Wraps It Up for Stock Mac UI", 2026-09-22. <https://inessential.com/2026/09/22/that-about-wraps-it-up-for.html>
- [C13] Hacker News comments on density: <https://news.ycombinator.com/item?id=49705657> (2026-09-14), <https://news.ycombinator.com/item?id=49914447> (2026-09-30), <https://news.ycombinator.com/item?id=49917936> (2026-10-01), <https://news.ycombinator.com/item?id=49943546> (2026-10-03)
- [C14] Hacker News, "Tells of a Slop UI", 2026-09-27 (the article itself is undated). <https://news.ycombinator.com/item?id=49867038>
- [C15] Jake Archibald, "My tooltip a11y mistake", 2026-07-28. <https://jakearchibald.com/2026/my-tooltip-a11y-mistake/>
- [C16] Hacker News comments on icon-only controls: <https://news.ycombinator.com/item?id=49316240> (2026-08-16), <https://news.ycombinator.com/item?id=49487581> (2026-08-29), <https://news.ycombinator.com/item?id=49829563> (2026-09-24); counter-view <https://news.ycombinator.com/item?id=49867389> (2026-09-27)

**Apple's apps: iPhone User Guide, iOS 27 version, and reviews**

The guide pages carry no date; they were read on 2026-10-06 with "iOS 27" selected.

- [G1] "Send and reply to messages" (Messages; includes the swipe-left timestamps tip and the list's alt text). <https://support.apple.com/guide/iphone/send-and-reply-to-messages-iph82fb73ba3/ios>
- [G2] Mail, reading email ("two lines of text for each email message by default"). <https://support.apple.com/guide/iphone/iph461684497/ios>
- [G3] "Delete and recover notes in Notes" ("If you don't see Recently Deleted, you don't have any notes in that folder"). <https://support.apple.com/guide/iphone/iph904eee369/ios>
- [G4] Reminders, completing items ("Completed items are hidden on your list"). <https://support.apple.com/guide/iphone/iph3fb74d597/ios>
- [G5] Photos, viewing ("tap it to hide the controls onscreen") and View Options ("to reduce clutter"). <https://support.apple.com/guide/iphone/iph3d267610/ios>, <https://support.apple.com/guide/iphone/iph2e66e2f2c/ios>
- [G6] Freeform, boards ("Your board is saved automatically"). <https://support.apple.com/guide/iphone/iph13127a9ed/ios>
- [G7] "Organize files and folders in Files" (touch and hold). <https://support.apple.com/guide/iphone/iphab82e0798/ios>
- [G8] Settings, the list of sections (Appearance: "Light or Dark Mode, text size, display appearance, and Liquid Glass settings"; alt text: "the search field at the bottom of the Settings screen"). <https://support.apple.com/guide/iphone/iph079e1fe9d/ios>
- [G9] "Get started with Music" (screenshot descriptions of the Search and Library tabs). <https://support.apple.com/guide/iphone/iph850be8527/ios>
- [G10] Phone, the unified and classic layouts ("Tap Recents to Call" is opt-in). <https://support.apple.com/guide/iphone/iph3c993cbc/ios>
- [G11] "Keep track of messages" ("Swipe right on a conversation to mark it as unread"; "Touch and hold a conversation, then tap Pin"). <https://support.apple.com/guide/iphone/iphe9b48b89e/ios>
- [G12] "React with Tapbacks in Messages". <https://support.apple.com/guide/iphone/iph018d3c336/ios>
- [G13] "Unsend or edit messages". <https://support.apple.com/guide/iphone/iphe67195653/ios>
- [G14] "Delete messages and attachments in Messages" ("Swipe left on the conversation"). <https://support.apple.com/guide/iphone/iph2c9c4bfcb/ios>
- [G15] "Organize email in mailboxes" ("Slowly drag a message to the left until the menu appears"; Swipe Options). <https://support.apple.com/guide/iphone/iph376ef8aa3/ios>
- [R1] Federico Viticci, MacStories, "iOS and iPadOS 26: The MacStories Review", 2025-09-15 (background, before H2 2026). <https://www.macstories.net/stories/ios-and-ipados-26-the-macstories-review/>
- [R2] Raluca Budiu, Nielsen Norman Group, on Liquid Glass in iOS 26, 2025-10-10 (background). <https://www.nngroup.com/articles/liquid-glass/>
