# Apple HIG checklist for Flux on iPhone and iPad

**Founder direction, 2026-10-05 22:45 (recorded on [#266](https://github.com/ColdPhase/flux/issues/266)):**
Flux's mobile UX is judged against the Apple Human Interface Guidelines, analysed
thoroughly, and every agent follows them. This checklist turns that direction into
115 numbered rules (HIG-01 to HIG-115) for Flux as an installable web app (PWA) on
iPhone and iPad.

- **Date:** 2026-10-05. Apple's pages were fetched on 2026-10-05; each page's own
  change-log date is in [Sources](#sources).
- **Author:** claude-maurycy. **Accepted 2026-10-06** by `claude-hubert`'s independent
  review of [#285](https://github.com/ColdPhase/flux/pull/285) (approved at `f2ee3d79`, merged as `4e99d223`), under the founder
  direction recorded on [#266](https://github.com/ColdPhase/flux/issues/266).
- **Scope:** phone and tablet layouts and touch input (coarse pointer), in Safari and
  as a Home Screen web app. Desktop density is unchanged.
- **Relationship to other contracts.** It adds to the [final design](final/README.md),
  [adaptive workspaces](adaptive-workspaces.md) (ADAPT-1 to ADAPT-5) and the
  [mobile PWA contract](../product/mobile-pwa.md) (MOB-1 to MOB-7); it does not replace them.
  The final design already meets these minimums on the phone; where a computer-sized token
  would fall below a HIG minimum on a touch layout, the HIG minimum applies on coarse pointers.
- **How to use it.** Cite rule IDs in phone/tablet issues, PRs and reviews. A PR that
  changes a phone or tablet screen states which rules it was checked against and how.

## Contents

- [How to read a rule](#how-to-read-a-rule)
- [Mapping iOS guidance to the web](#mapping-ios-guidance-to-the-web)
- [Emulation profile](#emulation-profile)
- [Rules by area](#rules-by-area)
- [Sources](#sources)

## How to read a rule

Each rule has four parts, kept apart because they are different kinds of evidence:

| Part | What it is |
| --- | --- |
| **ID and level** | HIG-xx. **Must** blocks phone/tablet acceptance; **Should** is fixed before release unless an exception is recorded on the issue; **May** is guidance. The level is Flux's choice, not Apple's. |
| **Apple says** | A short verbatim quote from the HIG page, with its URL. This is vendor guidance written for native apps. |
| **Flux on the web** | How Flux applies the rule in a browser. This is a Flux decision or inference, not something Apple states. |
| **Check** | How to verify it in emulation, with a measurable threshold where possible. Items emulation cannot show are marked *device*. |

Apple's guidance is written for native apps, so some rules have no exact web
equivalent. Where that happens the *Flux on the web* column says what we do instead
and why; it never claims Apple endorses a web technique.

## Mapping iOS guidance to the web

These conventions apply to every rule. Each line says whether it rests on a cited
source or is a Flux inference.

| Topic | Flux convention | Basis |
| --- | --- | --- |
| Points | 1 iOS point = 1 CSS px at 100 % zoom with `width=device-width, initial-scale=1`. The device pixel ratio (2 or 3) maps CSS px to physical pixels. So "44×44 pt" is 44×44 CSS px and "11 pt" is 11 px. | Flux inference: a 390-point-wide iPhone has a 390-CSS-px layout viewport. |
| Dynamic Type | A web page cannot read the iOS text-size setting directly. Flux sizes text in `rem`/`em` from the root so that the browser's default font size and page zoom enlarge it, and supports 200 % enlargement (HIG-11). WebKit's `font: -apple-system-body` keywords may follow the iOS setting; whether they do in a Home Screen web app is unverified. | WebKit, [Using the System Font in Web Content](https://webkit.org/blog/3709/using-the-system-font-in-web-content/) (2015-07-27) lists the keywords; their response to the text-size setting is our unverified inference. |
| Safe areas | `viewport-fit=cover` in the viewport meta, and `env(safe-area-inset-*)` padding on everything fixed to a screen edge: header, bottom bar, composer, drawers and full-height sheets, including the left and right insets in landscape. | [MDN `env()`](https://developer.mozilla.org/en-US/docs/Web/CSS/env) (modified 2026-09-12): the insets are "where it is safe to place content into without risking it being cut off". |
| On-screen keyboard | The meta `interactive-widget=resizes-content` is not supported by Safari, so on iOS only the visual viewport shrinks. The composer and focused field follow `visualViewport` (its `resize` and `scroll` events) rather than relying on `100dvh`. | [MDN VisualViewport](https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport) (modified 2026-08-12): the keyboard "can shrink the visual viewport without affecting the layout viewport". MDN browser-compat data for `interactive-widget` (2026-03-26) lists Safari as unsupported. |
| Focus zoom | Safari zooms into a focused field whose text is below 16 px and does not zoom back. Every editable control is at least 16 px on coarse pointers (HIG-41). | Widely observed WebKit behaviour, not documented by Apple; reported by the founder on [#264](https://github.com/ColdPhase/flux/issues/264). |
| Double-tap delay | `touch-action: manipulation` on interactive elements, so a tap is not held back while the browser waits for a possible double-tap zoom (HIG-17). | WebKit, [More Responsive Tapping on iOS](https://webkit.org/blog/5610/more-responsive-tapping-on-ios/) (2015-12-15). |
| Pinch zoom | Pinch zoom stays allowed: no `user-scalable=no` and no `maximum-scale` below 2. The goal is that nothing *needs* zooming (HIG-91). | [MDN viewport meta](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/meta/name/viewport) (modified 2026-09-23) warns that disabling zoom harms people with low vision; WCAG 1.4.4. |
| Edge swipe back | Flux never starts its own horizontal drag gesture near the left or right screen edge and never cancels touches there, so Safari's back swipe keeps working in a browser tab. Each pushed view is a URL with an on-screen Back (HIG-26, HIG-28). Whether a Home Screen web app offers the edge swipe is unverified. | Flux inference; device check. |
| Haptics | Safari on iOS has no web vibration API, so Flux never relies on haptics; every feedback is visible and announced (HIG-71). | Flux inference from browser-compat data; recheck at release. |
| Hover and tooltips | Touch has no hover. Tooltips (`title`, `data-tip`) never carry the only label (HIG-55). Use `(hover: none)` and `(pointer: coarse)` media queries for touch layouts; width alone does not tell us the input. | [Adaptive workspaces](adaptive-workspaces.md#viewport-and-input-verification-matrix). |
| Liquid Glass | Flux does not imitate Liquid Glass. The rules that matter on the web are separation of controls from content and legibility over scrolling content. | Flux decision. |

## Emulation profile

The founder decided on [#268](https://github.com/ColdPhase/flux/issues/268) that
emulation is enough evidence and physical devices are optional. Run checks in
Docker with Playwright Chromium, through the UI test image:

- **iPhone:** 390×844, device scale factor 3, `is_mobile`, `has_touch`; also 375×667
  (scale 2) and the landscape 844×390.
- **iPad:** 820×1180 and 1180×820, scale 2, `has_touch`.
- **Themes and settings:** light and dark (`color_scheme`); `reduced_motion="reduce"`;
  `forced_colors` where relevant.
- **Simulated keyboard:** focus the field, then shrink the viewport height to 55 % and
  check what stays visible. In Chromium this models `resizes-content`, not Safari, so
  keyboard rules also need the static `visualViewport` check.
- **Text enlargement:** double the default font size over the DevTools protocol
  (`Page.setFontSizes`, standard 32) and, separately, use a viewport half as wide to
  model 200 % zoom.
- **Screens:** Home, project Conversation, Thread, Tasks, Map, Wiki, Agents, Settings,
  Inbox and direct messages, with realistic seeded content (long names, ten or more
  messages, a thread, tasks in several states).
- **Taps:** use `page.touchscreen.tap` on the visible affordance. A `locator.click()`
  aims at the element's centre and can pass when a real finger would miss.

Emulation cannot show safe-area insets, the iOS keyboard, focus zoom, the edge swipe,
Dynamic Type or the display of a push notification. Those checks are marked
*device*; without a device they are reported as unverified, never as passed.

## Rules by area

| Area | Rules | Count |
| --- | --- | --- |
| [Layout and safe areas](#layout-and-safe-areas) | HIG-01 to HIG-07 | 7 |
| [Typography and minimum sizes](#typography-and-minimum-sizes) | HIG-08 to HIG-13 | 6 |
| [Touch targets](#touch-targets) | HIG-14 to HIG-17 | 4 |
| [Tab bars](#tab-bars) | HIG-18 to HIG-25 | 8 |
| [Navigation and back](#navigation-and-back) | HIG-26 to HIG-31 | 6 |
| [Sheets and modality](#sheets-and-modality) | HIG-32 to HIG-40 | 9 |
| [Text fields and keyboards](#text-fields-and-keyboards) | HIG-41 to HIG-49 | 9 |
| [Search](#search) | HIG-50 to HIG-54 | 5 |
| [Buttons, labels and icons](#buttons-labels-and-icons) | HIG-55 to HIG-59 | 5 |
| [Lists and scrolling](#lists-and-scrolling) | HIG-60 to HIG-64 | 5 |
| [Feedback and loading](#feedback-and-loading) | HIG-65 to HIG-71 | 7 |
| [Motion and reduced motion](#motion-and-reduced-motion) | HIG-72 to HIG-77 | 6 |
| [Dark mode, color and contrast](#dark-mode-color-and-contrast) | HIG-78 to HIG-83 | 6 |
| [Accessibility](#accessibility) | HIG-84 to HIG-89 | 6 |
| [Gestures](#gestures) | HIG-90 to HIG-94 | 5 |
| [Notifications](#notifications) | HIG-95 to HIG-100 | 6 |
| [Onboarding and launch](#onboarding-and-launch) | HIG-101 to HIG-105 | 5 |
| [Settings](#settings) | HIG-106 to HIG-109 | 4 |
| [Writing style](#writing-style) | HIG-110 to HIG-115 | 6 |
| **Total** | | **115** |

### Layout and safe areas

| ID | Apple says | Flux on the web | Check |
| --- | --- | --- | --- |
| HIG-01 · Must | **Safe areas.** "Respecting the safe area is essential to make sure system UI and hardware features like the Dynamic Island don’t obstruct content and controls." ([layout](https://developer.apple.com/design/human-interface-guidelines/layout)) | `viewport-fit=cover`, and `env(safe-area-inset-*)` padding on every element fixed to a screen edge: header (top), bottom bar and composer (bottom), drawer and sheets (left/right in landscape). | Static: every `position: fixed`/`sticky` element touching a viewport edge has padding using the matching `env(safe-area-inset-*)`; count without = 0. *Device:* nothing under the Dynamic Island or home indicator in portrait and landscape. |
| HIG-02 · Must | **Few controls, one main task.** "Help people concentrate on primary tasks and content by limiting the number of onscreen controls while making secondary details and actions discoverable with minimal interaction." ([designing for iOS](https://developer.apple.com/design/human-interface-guidelines/designing-for-ios)) | A phone screen has one main job: read and reply, or scan a list. Fixed chrome (header, bars, composer, toolbars) holds only what that job needs; the rest sits behind one labelled entry such as More or Details. | At 390×844 and 375×667: tappable controls in fixed chrome (outside the scrolling content) ≤ 10 per screen; total distinct targets above the fold reported. Exactly one prominent action (HIG-56). |
| HIG-03 · Should | **Progressive disclosure, content first.** "Use progressive disclosure to make layouts cleaner and easier to interact with." ([layout](https://developer.apple.com/design/human-interface-guidelines/layout)) | Project state, metadata, filters and explanations open on demand. The first message, task or paragraph starts high on the screen. | The first content item's top edge is in the top third of the viewport (≤ 281 px at 844 high, ≤ 222 px at 667 high). |
| HIG-04 · Should | **Reach.** "it tends to be easier and more comfortable for people to reach a control when it’s located in the middle or bottom area of the display" ([designing for iOS](https://developer.apple.com/design/human-interface-guidelines/designing-for-ios)) | On phones the main navigation and the primary action (Send, Save, New) sit in the bottom half. The top holds orientation (title, Back) and at most two secondary actions. | Primary action and navigation-bar centres are below 50 % of the viewport height on phone screens. |
| HIG-05 · Must | **Layout from available space.** "Determine layout based on size classes, not device type or orientation." ([layout](https://developer.apple.com/design/human-interface-guidelines/layout)) | Breakpoints use available width and height and input media queries, never the user agent. No page-wide sideways scroll: content wider than the viewport makes iOS pan and zoom the page ([#264](https://github.com/ColdPhase/flux/issues/264)). | At 320×568, 375×667, 390×844, 844×390, 820×1180 and 1180×820: `document.scrollingElement.scrollWidth ≤ clientWidth` and no visible element extends past the viewport outside a local horizontal scroller. Static: no layout decision reads `navigator.userAgent`. |
| HIG-06 · Must | **Same functionality at every size.** "Don’t change your app’s functionality based on the space it occupies." ([layout](https://developer.apple.com/design/human-interface-guidelines/layout)) | Every action available at 1440 is reachable on a phone, possibly in a menu, sheet or Details. Collapsing navigation may move an action; it may not remove it. | For each screen, list the actions at 1440×900 and confirm each is reachable at 390×844 within two taps; count missing = 0. |
| HIG-07 · Should | **iPad: use the large display.** "Take advantage of the large display to elevate the content people care about, minimizing modal interfaces and full-screen transitions" ([designing for iPadOS](https://developer.apple.com/design/human-interface-guidelines/designing-for-ipados)); "Prefer using a split view in a regular — not a compact — environment." ([split views](https://developer.apple.com/design/human-interface-guidelines/split-views)) | At tablet widths a thread, task or Details opens beside the work instead of covering it; on a phone it opens as a full-screen view or sheet. No side-by-side panes at phone widths. | At 820×1180 and 1180×820 an open thread or Details leaves ≥ 360 px of readable stream beside it; at 390 no two panes are visible side by side. |

### Typography and minimum sizes

| ID | Apple says | Flux on the web | Check |
| --- | --- | --- | --- |
| HIG-08 · Must | **Minimum size.** "Follow the recommended default and minimum text sizes for each platform" — iOS and iPadOS: default 17 pt, minimum 11 pt. ([typography](https://developer.apple.com/design/human-interface-guidelines/typography)) | No visible text below 11 px on touch layouts, including timestamps, badges, chips and tab labels. The final design's phone meta text is at least 12.5 px. | Visible text nodes with computed `font-size` < 11 px on coarse-pointer screens: 0. |
| HIG-09 · Should | **Readable default.** "Use font sizes that most people can read easily." ([typography](https://developer.apple.com/design/human-interface-guidelines/typography)); default 17 pt. | Reading text (messages, task titles, wiki body, list titles) is 16–17 px on coarse pointers; secondary lines at least 13 px. | Computed size of message body, list-row title and wiki paragraph ≥ 16 px at 390 and 820 with touch. |
| HIG-10 · Should | **No light weights.** "avoid Ultralight, Thin, and Light font weights, which can be difficult to see, especially when text is small" ([typography](https://developer.apple.com/design/human-interface-guidelines/typography)) | Regular (400) and heavier only. | Visible text with computed `font-weight` < 400: 0. |
| HIG-11 · Must | **Text enlargement.** "Ideally, give people the option to enlarge text by at least 200 percent" ([accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)) | Text sizes in `rem`/`em` so the browser's default font size and zoom enlarge them; no fixed-pixel text that ignores the setting. Pinch zoom stays available (HIG-91). | With the default font size doubled (`Page.setFontSizes`, 16 → 32), message body size grows by ≥ 1.9×. At 200 % zoom (half-width viewport) no content or action is lost. |
| HIG-12 · Should | **Layout at large sizes.** "Keep text truncation to a minimum as font size increases." and "consider using a stacked layout where text appears above secondary items" ([typography](https://developer.apple.com/design/human-interface-guidelines/typography)) | Rows and headers wrap or stack at large sizes; a title keeps its start visible; timestamps move below text instead of squeezing it. | At doubled font size: no horizontal overflow; header title, bar labels and buttons not clipped (`scrollWidth ≤ clientWidth` or wrapped). |
| HIG-13 · May | **Few typefaces.** "Minimize the number of typefaces you use, even in a highly customized interface." ([typography](https://developer.apple.com/design/human-interface-guidelines/typography)) | The system UI stack (SF Pro on Apple devices) and one monospace face for code. | Distinct computed `font-family` stacks on visible text ≤ 2. |

### Touch targets

| ID | Apple says | Flux on the web | Check |
| --- | --- | --- | --- |
| HIG-14 · Must | **44×44 hit region.** "a button needs a hit region of at least 44x44 pt" ([buttons](https://developer.apple.com/design/human-interface-guidelines/buttons)); iOS default control size 44x44 pt, minimum 28x28 pt ([accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)). | Every control on a coarse pointer has a 44×44 CSS px hit area (by size, padding or an enlarged hit pseudo-element). The 28 px floor applies only to links inside running text. | Above-fold controls whose sampled hit area (`elementFromPoint` grid) is < 44 in either dimension: 0; < 28: 0 including inline links. |
| HIG-15 · Should | **Spacing.** "Consider spacing between controls as important as size." and "it works well to add about 12 points of padding around elements that include a bezel" ([accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)) | Neighbouring hit areas never overlap; bezeled buttons sit at least 8 px apart, aiming for 12. | Overlapping hit areas between distinct controls: 0. Gaps between visible edges of neighbouring bezeled controls < 8 px: 0. |
| HIG-16 · Should | **Press state.** "Always include a press state for a custom button." ([buttons](https://developer.apple.com/design/human-interface-guidelines/buttons)) | `:active` changes background, opacity or scale on touch, independent of hover styles. | Force `:active` (DevTools protocol `CSS.forcePseudoState`) on each above-fold button: computed background, opacity or transform changes; count without change = 0. |
| HIG-17 · Must | **Immediate taps.** "Handle gestures as responsively as possible." ([gestures](https://developer.apple.com/design/human-interface-guidelines/gestures)) | `touch-action: manipulation` on every interactive element, so a tap is not delayed for a possible double-tap zoom and a double tap on a control does not zoom ([#264](https://github.com/ColdPhase/flux/issues/264) cause c). | Effective `touch-action` of above-fold controls (outside the map canvas) is `manipulation`: count `auto` = 0. |

### Tab bars

A tab bar is the bottom bar of top-level places on a phone. Flux's reading of
[#264](https://github.com/ColdPhase/flux/issues/264): "a bottom bar for the few main
places", with conversations first.

| ID | Apple says | Flux on the web | Check |
| --- | --- | --- | --- |
| HIG-18 · Must | **Navigation, not actions.** "Use a tab bar to support navigation, not to provide actions." ([tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars)) | Every bar item is a link to a place. Actions such as New, Compose or Attach live in toolbars or the composer. A search item is allowed because it navigates to search. | Each bar item is an `a[href]` (role link); bar buttons that open dialogs or run actions: 0. |
| HIG-19 · Must | **Top-level places, few of them.** "A tab bar lets people navigate between top-level sections of your app." and "keep in mind that it’s generally easier to navigate among fewer tabs" ([tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars)) | The phone bar holds 3–5 top-level places (Flux inference from "fewer tabs" and the iPadOS "five or fewer" default), for example Home, conversations or projects, direct messages and Inbox. A project's views (Conversation, Map, Tasks, Wiki, Agents) are a second level inside the project, not the app's tab bar. | Bar item count 3–5 on every top-level screen; items are top-level places, not views of the current place; all visible at 320 px without scrolling or a More item. |
| HIG-20 · Must | **Always there.** "Make sure the tab bar is visible when people navigate to different sections of your app." The exception is a modal view ([tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars)). | The bar shows on every top-level screen: Home, the conversation list or project, direct messages, Inbox and Settings if it is a place. It may hide on a pushed detail view, under a modal sheet and while the on-screen keyboard is open. | Bar visible on each top-level screen at 390×844: count missing = 0. |
| HIG-21 · Must | **Stable items.** "Don’t disable or hide tab bar buttons, even when their content is unavailable." ([tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars)) | Same items in the same order everywhere the bar shows; an empty place explains why it is empty. | Bar item labels and order identical across top-level screens; `aria-disabled` items: 0. |
| HIG-22 · Must | **Labels.** "Include tab labels to help with navigation." and "Use single words whenever possible." ([tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars)) | Icon above a visible one-word label, label at least 11 px (HIG-08). | Every bar item has non-empty visible text; label size ≥ 11 px; labels of one word, or two at most. |
| HIG-23 · Must | **Clear current place.** "Convey information with more than color alone." ([accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)) | The current item has `aria-current="page"` and differs by shape or fill (a pill or filled icon) as well as color. | Exactly one bar item with `aria-current`; it differs from the others in a non-color property. |
| HIG-24 · Should | **Badges for what matters.** "Reserve badges for critical information so you don’t dilute their impact and meaning." ([tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars)) | A badge counts unread mentions, replies or assigned items only, and its count is in the item's accessible name ("Inbox, 3 unread"). | Badges appear only with a matching unread count; the accessible name includes the number. |
| HIG-25 · Must | **Keep each place's state.** Tab bars let people "quickly switch between sections of the view while preserving the current navigation state within each section." ([tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars)) | Leaving a place and coming back restores its scroll position, open thread and draft. | Scroll Conversation up 600 px, switch to another bar item and back: `scrollTop` within 50 px and the draft kept. |

### Navigation and back

The navigation bar guidance now lives on the toolbars page
(`/navigation-bars` redirects to `/toolbars`).

| ID | Apple says | Flux on the web | Check |
| --- | --- | --- | --- |
| HIG-26 · Must | **Standard Back.** "Use the standard Back and Close buttons." and "Prefer the standard symbols for each, and don’t use a text label that says Back or Close." ([toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars)) | Every pushed view on a phone (thread, task, document, direct message, a Settings section) has a chevron Back at the top leading edge, 44×44, named "Back to …" for assistive technology. It returns to the parent with its scroll position. | On each pushed screen: a control at the top leading edge with an accessible name starting "Back", hit area ≥ 44; tapping it returns to the parent URL with `scrollTop` within 50 px. |
| HIG-27 · Should | **Useful title.** "Provide a useful title for each window." "Don’t title windows with your app name." "keep the title under 15 characters long so you leave enough room for other controls" ([toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars)) | The header shows the place or object name; Flux's own titles (Inbox, Settings, Tasks) are short. A long user-given name keeps its start and is available in full. `document.title` is "Place · Flux", never just "Flux". | Header title is not cut by controls: title width ≥ 50 % of the header at 390. `document.title` names the place on every screen. |
| HIG-28 · Must | **Swipe back is a shortcut.** "many apps also offer a shortcut gesture — such as swiping from the side of a window or touchscreen — while continuing to provide the Back button" ([gestures](https://developer.apple.com/design/human-interface-guidelines/gestures)); "it’s especially important let people swipe to navigate back" ([designing for iOS](https://developer.apple.com/design/human-interface-guidelines/designing-for-ios)) | Do not override the system edge swipe: no custom drag that starts within 24 px of the left or right edge, no `preventDefault` on touches there, and the drawer opens from a button. Each pushed view is a history entry. | Simulated touch drag from x = 2 to x = 200 on Thread and Tasks: the app does not react (no drawer, no content movement). Pushing a view increases `history.length`. *Device:* swipe back in Safari and in the Home Screen app. |
| HIG-29 · Must | **No conflict with system gestures.** "Avoid conflicting with gestures that access system UI." ([gestures](https://developer.apple.com/design/human-interface-guidelines/gestures)) | No custom swipe starts at the bottom edge (home indicator) or top edge (Notification Center). Bottom controls sit above the safe-area inset. | Static: no gesture handler accepts a start within 24 px of the bottom or top edge. *Device:* home-indicator swipe never activates a Flux control. |
| HIG-30 · Should | **iPad navigation stays discoverable.** "Avoid hiding the sidebar by default to ensure that it remains discoverable." ([sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars)) | At tablet widths the place navigation (sidebar or bar) is visible without opening a drawer, in portrait and landscape. | At 820×1180 and 1180×820, place navigation is visible on load. |
| HIG-31 · Must | **Uncrowded header.** "Choose items deliberately to avoid overcrowding." and "Prioritize only the most important items for inclusion in the main toolbar area." ([toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars)) | The phone header holds Back or Menu, the title and at most two actions; further actions go in a More menu. | Header controls besides the title ≤ 3 at 390 and 375. |

### Sheets and modality

| ID | Apple says | Flux on the web | Check |
| --- | --- | --- | --- |
| HIG-32 · Should | **Modal only when useful, and named.** "Present content modally only when there’s a clear benefit." and "Make it easy to identify a modal view’s task." ([modality](https://developer.apple.com/design/human-interface-guidelines/modality)) | Sheets for scoped tasks (reply, details, a picker); each has a visible title naming the task. | Each open `dialog` has a non-empty accessible name from a visible heading. |
| HIG-33 · Must | **One sheet at a time.** "Display only one sheet at a time from the main interface." ([sheets](https://developer.apple.com/design/human-interface-guidelines/sheets)) | Opening a sheet from a sheet first closes the first one. | Open overlays (modal dialogs, sheets) at any time ≤ 1. |
| HIG-34 · Must | **Obvious dismissal.** "Always give people an obvious way to dismiss a modal view." "people typically expect to find a button in the top toolbar or swipe down" ([modality](https://developer.apple.com/design/human-interface-guidelines/modality)) | A Close (×) or Cancel at the top of every sheet, 44×44; swipe down closes; Escape closes on a hardware keyboard. | Each sheet: a top control named Close or Cancel with hit area ≥ 44; Escape closes; touch drag down closes (HIG-35). |
| HIG-35 · Must | **Swipe to dismiss, keep work.** "Support swiping to dismiss a sheet." and "If people have unsaved changes in the sheet when they begin swiping to dismiss it, use an action sheet to let them confirm their action." ([sheets](https://developer.apple.com/design/human-interface-guidelines/sheets)) | A downward drag past a third of the height, or a flick, closes the sheet. A draft in the sheet is kept as a draft (Flux's alternative to the confirmation), or the person is asked. | Touch drag down 40 % closes; a typed reply is still there after closing and reopening. |
| HIG-36 · Should | **Grabber.** "Include a grabber in a resizable sheet." and "a grabber also works with VoiceOver so people can resize the sheet without seeing the screen" ([sheets](https://developer.apple.com/design/human-interface-guidelines/sheets)) | A sheet that can be dragged shows a grabber at its top; the grabber is a button with an accessible name that changes the sheet's height or closes it. | Draggable sheets show a visible grabber that is focusable and named. |
| HIG-37 · Should | **Detents.** "the compose sheets in Messages and Mail display only at full height to give people enough room to create content" ([sheets](https://developer.apple.com/design/human-interface-guidelines/sheets)) | Composing sheets (thread reply, new message) open at full height; short choices may use a half-height sheet. | Thread sheet height ≥ 90 % of the viewport at 390×844. |
| HIG-38 · Should | **Cancel and Done placement.** "the Cancel button belongs on the leading edge of the top toolbar. When present, the Done button belongs on the trailing edge." ([sheets](https://developer.apple.com/design/human-interface-guidelines/sheets)) | Edit sheets: Cancel at top left, Done or Save at top right. | In each edit sheet the Cancel control is left of the Done control in the top row. |
| HIG-39 · Should | **No popovers on phones.** "Avoid displaying popovers in compact views." ([popovers](https://developer.apple.com/design/human-interface-guidelines/popovers)) | At phone widths menus and pickers open as bottom sheets or full-width lists, never as small anchored bubbles that can clip. | At 390, every opened menu or popover lies fully inside the viewport and is full width or a bottom sheet. |
| HIG-40 · Must | **Alerts sparingly; action sheets for choices.** "Use alerts sparingly." "Avoid showing an alert when your app starts." ([alerts](https://developer.apple.com/design/human-interface-guidelines/alerts)); "Use an action sheet — not an alert — to offer choices related to an intentional action." ([action sheets](https://developer.apple.com/design/human-interface-guidelines/action-sheets)) | No browser `alert()`/`confirm()`. An irreversible action asks with a bottom action sheet (destructive choice first, Cancel last). Nothing modal appears on launch. | Instrument `window.alert`/`confirm`/`prompt`: calls 0. On a fresh load of each screen, open dialogs: 0. |

### Text fields and keyboards

| ID | Apple says | Flux on the web | Check |
| --- | --- | --- | --- |
| HIG-41 · Must | **Tapping a field focuses it.** "people expect tap to activate or select an object" ([gestures](https://developer.apple.com/design/human-interface-guidelines/gestures)) | Focusing a field must not zoom the page: every editable control (input, textarea, select, contenteditable) is at least 16 px on coarse pointers, in every screen and sheet ([#264](https://github.com/ColdPhase/flux/issues/264) cause a). | Editable controls with computed `font-size` < 16 px under `(pointer: coarse)`: 0, including hidden-until-opened fields. *Device:* no zoom on focus. |
| HIG-42 · Must | **Keyboard keeps the work visible.** "Using the layout guide also helps you keep important parts of your interface visible while the virtual keyboard is onscreen." ([virtual keyboards](https://developer.apple.com/design/human-interface-guidelines/virtual-keyboards)) | The composer is pinned above the keyboard by following `visualViewport`; the focused field and Send stay visible; the stream stays anchored if it was at the bottom; the draft survives. | Simulated keyboard (height × 0.55): focused field and Send fully inside the viewport and hit-testable; draft kept; a stream at the bottom stays within 4 px of the bottom. Static: a `visualViewport` resize handler exists. *Device:* iOS keyboard. |
| HIG-43 · Should | **Matching keyboard.** "Choose a keyboard that matches the type of content people are editing." ([virtual keyboards](https://developer.apple.com/design/human-interface-guidelines/virtual-keyboards)) | `type="email"` with `autocomplete="email"` or `username`; `type="search"`; `type="url"`; `inputmode="numeric"` for numbers; `autocapitalize` and `autocorrect` off for codes and addresses. | Audit each field: type, `inputmode` and `autocomplete` match its content; mismatches 0. |
| HIG-44 · May | **Return key.** "Consider customizing the Return key type if it helps clarify the text-entry experience." ([virtual keyboards](https://developer.apple.com/design/human-interface-guidelines/virtual-keyboards)) | `enterkeyhint="search"` on search fields; `enterkeyhint="send"` only where Return sends. In the multi-line message composer Return adds a line and Send sends. | Search fields have `enterkeyhint="search"`; no field announces "send" unless Return sends. |
| HIG-45 · Must | **Labelled fields.** "Because placeholder text disappears when people start typing, it can also be useful to include a separate label describing the field" ([text fields](https://developer.apple.com/design/human-interface-guidelines/text-fields)) | Every field has an accessible name from a label or `aria-label`; the placeholder is a hint, never the only name. | Fields whose only name source is `placeholder`: 0. |
| HIG-46 · Must | **Secure entry and autofill.** "Always use a secure text field when your app asks for sensitive data, such as a password." ([text fields](https://developer.apple.com/design/human-interface-guidelines/text-fields)); "Never prepopulate a password field." ([entering data](https://developer.apple.com/design/human-interface-guidelines/entering-data)) | `type="password"` with `autocomplete="current-password"` or `new-password` so iCloud Keychain can fill it; never prefilled. | Sign-in and sign-up: attributes as stated; password value empty on load. |
| HIG-47 · Should | **Validate early, explain next to the field.** "Dynamically validate field values." ([entering data](https://developer.apple.com/design/human-interface-guidelines/entering-data)); "Show errors right next to the field" ([writing](https://developer.apple.com/design/human-interface-guidelines/writing)) | Errors appear under the field, linked with `aria-describedby`, and say how to fix the value. | Enter an invalid email and leave the field: an adjacent message appears and is referenced by `aria-describedby`. |
| HIG-48 · Must | **A composer that grows.** "To let people input larger amounts of text, use a text-views instead." ([text fields](https://developer.apple.com/design/human-interface-guidelines/text-fields)) | The message and reply composers are multi-line, start at 44 px, grow with the text up to about 40 % of the visible height, then scroll. | Type three lines: field height grows so all three lines show (`scrollHeight ≤ clientHeight + 2`); at the cap it scrolls. |
| HIG-49 · Should | **Clear button.** "Display a Clear button in the trailing end of a text field to help people erase their input." ([text fields](https://developer.apple.com/design/human-interface-guidelines/text-fields)) | Search and filter fields show a 44×44 Clear (×) at the trailing end when they hold text. | With text entered, a Clear control is visible, ≥ 44, and empties the field. |

### Search

| ID | Apple says | Flux on the web | Check |
| --- | --- | --- | --- |
| HIG-50 · Should | **Prominent search.** "If search is important, give it a primary position in your app or view." ([searching](https://developer.apple.com/design/human-interface-guidelines/searching)); "Place search at the bottom if there’s room." ([search fields](https://developer.apple.com/design/human-interface-guidelines/search-fields)) | Global search is one tap from every top-level phone screen, as a bar item or a header button. | From Home, a project and Inbox at 390: taps to reach a focused global search field = 1. |
| HIG-51 · Should | **One place to search everything.** "Aim to make your app’s content searchable through a single location." ([searching](https://developer.apple.com/design/human-interface-guidelines/searching)) | One global search; in-view filters (tasks, wiki) are labelled as filters of that view. | One global search route; each local search field's name or placeholder names its scope. |
| HIG-52 · Must | **A tap opens the field.** Tapping search "animates into a search field above the keyboard so they can begin typing" ([search fields](https://developer.apple.com/design/human-interface-guidelines/search-fields)) | A collapsed search button's whole 44×44 area opens and focuses the field in one tap; the open field is wide enough to read a query. | `touchscreen.tap` at the magnifier's centre: field focused and ≥ 60 % of the row width. |
| HIG-53 · Should | **Scope in the placeholder.** "Use placeholder text to help people know what they can search for." and "Clearly display the current scope of a search." ([search fields](https://developer.apple.com/design/human-interface-guidelines/search-fields), [searching](https://developer.apple.com/design/human-interface-guidelines/searching)) | "Search tasks", "Search this wiki", "Search Flux". | Every search field has a placeholder naming its scope. |
| HIG-54 · Should | **Results while typing.** "If possible, start search immediately when a person types." ([search fields](https://developer.apple.com/design/human-interface-guidelines/search-fields)); "Take privacy into consideration before displaying search history." ([searching](https://developer.apple.com/design/human-interface-guidelines/searching)) | Results refine as people type (debounced); recent searches, if shown, stay on the device and can be cleared. | Typing a query updates results within 500 ms without pressing Return. |

### Buttons, labels and icons

| ID | Apple says | Flux on the web | Check |
| --- | --- | --- | --- |
| HIG-55 · Must | **Clear purpose, labels where icons are unclear.** "Ensure that each button clearly communicates its purpose." "Consider using text when a short label communicates more clearly than an icon." ([buttons](https://developer.apple.com/design/human-interface-guidelines/buttons)); "Don’t make people guess or experiment to figure out what a toolbar item does." ([toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars)) | Icon-only buttons are limited to well-known symbols: Back, Close, Send, Search, More, Attach, Menu, Add. Anything else (Details, What matters, Mine, Decisions) shows a visible text label. Tooltips do not count on touch. | Above-fold controls with no visible text whose name is outside that list: 0 on every phone screen. |
| HIG-56 · Must | **One prominent action.** "Keep the number of prominent buttons to one or two per view." ([buttons](https://developer.apple.com/design/human-interface-guidelines/buttons)); "Only specify one primary action" ([toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars)) | One filled button per screen: Send in a conversation, Save in a form, New on a list. | Visible filled (solid-background) buttons per screen ≤ 1, at most 2 with a recorded reason. |
| HIG-57 · Should | **Familiar icons.** "Try to associate familiar actions with familiar icons." ([buttons](https://developer.apple.com/design/human-interface-guidelines/buttons)); interface icons need "a consistent size, level of detail, stroke thickness (or weight), and perspective" ([icons](https://developer.apple.com/design/human-interface-guidelines/icons)) | One icon set with one stroke weight; the share, search, add, more and close glyphs look like their system counterparts. | Visual review: icons consistent in size and weight; standard actions use standard metaphors. |
| HIG-58 · Must | **Destructive actions.** "Don’t assign the primary role to a button that performs a destructive action" ([buttons](https://developer.apple.com/design/human-interface-guidelines/buttons)); list destructive items "at the end of the menu and identify them as destructive" ([context menus](https://developer.apple.com/design/human-interface-guidelines/context-menus)) | Delete, Remove and Revoke are never the filled button; in menus they come last and use the danger color plus their verb. | Filled buttons with destructive labels: 0; in each menu destructive items are last. |
| HIG-59 · Must | **Progress in the button.** "Configure a button to display an activity indicator when you need to provide feedback about an action that doesn’t instantly complete." ([buttons](https://developer.apple.com/design/human-interface-guidelines/buttons)) | Send, Save and Create show a pending state ("Sending…", spinner, `aria-busy`) at once and ignore a second tap until done. | Hold the POST: within 100 ms the button shows a pending state; a second tap sends no second request. |

### Lists and scrolling

| ID | Apple says | Flux on the web | Check |
| --- | --- | --- | --- |
| HIG-60 · Must | **Succinct rows.** "Keep item text succinct so row content is comfortable to read." and "you could list item titles only, letting people choose an item to reveal its content in a detail view" ([lists and tables](https://developer.apple.com/design/human-interface-guidelines/lists-and-tables)) | Inbox, direct messages, projects and tasks: a title and one secondary line; the whole row is one target. Like a messenger chat list. | Rows ≥ 44 px high; the row's link or button spans the row width; list rows of more than 3 lines: 0. |
| HIG-61 · Should | **Selection feedback.** "Provide appropriate feedback when people select a list item." and "a table that helps people navigate through a hierarchy persistently highlights the selected row" ([lists and tables](https://developer.apple.com/design/human-interface-guidelines/lists-and-tables)) | Pressed state on tap; at tablet widths the selected row beside its detail stays highlighted with `aria-current`. | At 820, the open item's row has `aria-current` and a non-color highlight. |
| HIG-62 · Must | **No nested scrolling in one direction.** "Avoid putting a scroll view inside another scroll view with the same orientation." ([scroll views](https://developer.apple.com/design/human-interface-guidelines/scroll-views)) | One vertical scroller per screen (plus one inside an open sheet). | Visible vertical scrollers nested in another vertical scroller: 0. |
| HIG-63 · Should | **Show that more is there.** "Make it apparent when content is scrollable." ([scroll views](https://developer.apple.com/design/human-interface-guidelines/scroll-views)) | Horizontal chips and board columns show part of the next item; a phone board also offers a labelled status jump ([adaptive workspaces](adaptive-workspaces.md#continuity-and-predictable-transitions)). | Each horizontal scroller shows ≥ 16 px of the next item, or a labelled control reaches the rest. |
| HIG-64 · Must | **Scroll only as much as needed.** "automatically scroll the content only as much as necessary to help people retain context" ([scroll views](https://developer.apple.com/design/human-interface-guidelines/scroll-views)) | A reader scrolled up is not moved by new messages; a reader at the bottom stays at the bottom, including when the keyboard opens. | Scrolled up 300 px: an arrival leaves `scrollTop` unchanged. At the bottom: after an arrival and after the simulated keyboard, distance from the bottom ≤ 4 px. |

### Feedback and loading

| ID | Apple says | Flux on the web | Check |
| --- | --- | --- | --- |
| HIG-65 · Must | **Show something at once.** "Show something as soon as possible." ([loading](https://developer.apple.com/design/human-interface-guidelines/loading)) | The shell (header, bar) and placeholders render before data arrives; never a blank screen. | With API reads held for 2 s, the header and a placeholder are visible within 300 ms of navigation. |
| HIG-66 · Must | **Status where it applies.** "Consider integrating status feedback into your interface." ([feedback](https://developer.apple.com/design/human-interface-guidelines/feedback)); "Perform automatic content updates." ([progress indicators](https://developer.apple.com/design/human-interface-guidelines/progress-indicators)) | Sending, failed and retry states sit on the message itself; new content arrives live without pull-to-refresh. | Hold a send: the message shows a pending state inline. Fail it: an inline Retry with the text kept. A message from another person appears within 2 s without reload. |
| HIG-67 · Should | **Say why something cannot happen.** "Show people when a command can’t be carried out and help them understand why." ([feedback](https://developer.apple.com/design/human-interface-guidelines/feedback)) | Offline, missing permission and unavailable actions show a short reason next to the control. | With the context set offline, a visible note appears within 2 s and a send attempt is explained, not silently lost. |
| HIG-68 · Should | **Honest progress.** "When possible, use a determinate progress indicator." and "Avoid vague terms like loading or authenticating because they seldom add value." ([progress indicators](https://developer.apple.com/design/human-interface-guidelines/progress-indicators)) | Uploads show a percentage; unknown waits use a spinner with a specific description ("Opening the thread…"). | Upload shows `aria-valuenow`; spinner text is specific. |
| HIG-69 · Should | **No routine success messages.** "because people typically expect their action or task to succeed, they only need to know when it doesn’t" ([feedback](https://developer.apple.com/design/human-interface-guidelines/feedback)) | No toast for an ordinary send or save; significant completions (task created from a message, invitation sent) may confirm. | After a routine send or save, toasts shown: 0. |
| HIG-70 · Should | **Undo instead of warnings.** "Avoid displaying alerts for common, undoable actions, even when they’re destructive." ([alerts](https://developer.apple.com/design/human-interface-guidelines/alerts)); "Show the results of an undo or redo." ([undo and redo](https://developer.apple.com/design/human-interface-guidelines/undo-and-redo)) | Deleting a draft or note offers Undo; the Undo stays until the next action or at least 10 s (HIG-89). | Delete a private note: Undo visible ≥ 10 s and restores the note in place. |
| HIG-71 · Must | **Feedback reaches everyone.** "Make sure all feedback is accessible." ([feedback](https://developer.apple.com/design/human-interface-guidelines/feedback)); "Prefer using haptics to complement other feedback" ([playing haptics](https://developer.apple.com/design/human-interface-guidelines/playing-haptics)) | No haptics on the iOS web. Every state change is visible as text or shape and announced in a polite live region; errors use `role="alert"`. | Arrivals, send failures and saved states produce text in an `aria-live` region; feedback that relies on vibration or sound alone: 0. |

### Motion and reduced motion

| ID | Apple says | Flux on the web | Check |
| --- | --- | --- | --- |
| HIG-72 · Should | **Purposeful, optional motion.** "Add motion purposefully, supporting the experience without overshadowing it." "Make motion optional." ([motion](https://developer.apple.com/design/human-interface-guidelines/motion)) | UI116-5 tokens; motion confirms a change and never carries the only signal. | Every animated state also changes text, shape or `aria-*`. |
| HIG-73 · Must | **Motion follows the gesture.** "if someone reveals a view by sliding it down from the top, they don’t expect to dismiss the view by sliding it to the side" ([motion](https://developer.apple.com/design/human-interface-guidelines/motion)) | A sheet rising from the bottom leaves downwards; the drawer from the leading edge leaves towards it; a pushed view enters from the trailing edge and Back reverses it. A dragged sheet tracks the finger. | Opening and closing transforms use the matching axis and direction; during a 100 px drag the sheet moves within ±10 px of the finger. |
| HIG-74 · Should | **Brief.** "Aim for brevity and precision in feedback animations." ([motion](https://developer.apple.com/design/human-interface-guidelines/motion)) | 120–340 ms for UI transitions. | Longest finite transition or animation on a UI element ≤ 350 ms. |
| HIG-75 · Should | **No waiting, no motion on frequent actions.** "generally avoid adding motion to UI interactions that occur frequently" and "Let people cancel motion." ([motion](https://developer.apple.com/design/human-interface-guidelines/motion)) | View switches change content at once (only a small indicator moves); taps during a transition are accepted and the latest choice wins. | Tap two views within 100 ms: the second is shown and current; no content slide on view switches. |
| HIG-76 · Must | **Reduce Motion.** "When this setting is active, ensure your app or game responds by reducing automatic and repetitive animations, including zooming, scaling, and peripheral motion." ([accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)) | `prefers-reduced-motion: reduce` sets every duration to 0 or replaces movement with a fade. | With `reduced_motion="reduce"`: running animations and transitions that change `transform`, or last longer than 0 ms: 0. |
| HIG-77 · Should | **No restless screens.** "Be cautious with fast-moving and blinking animations." ([accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)) | Loops only for real ongoing activity and paused when hidden (UI116-5). | Infinite animations on an idle screen with no live activity: 0. |

### Dark mode, color and contrast

| ID | Apple says | Flux on the web | Check |
| --- | --- | --- | --- |
| HIG-78 · Must | **Follow the system appearance.** People "generally expect all apps and games to respect their preference." "Avoid offering an app-specific appearance setting." ([dark mode](https://developer.apple.com/design/human-interface-guidelines/dark-mode)) | The default follows `prefers-color-scheme`, including the `theme-color` meta. Flux's remembered light/dark choice (#148) stays an explicit override whose first option is System. | New account in a dark context: dark theme with no setting changed; `theme-color` matches the dark surface. |
| HIG-79 · Must | **Contrast.** Text up to 17 pt needs 4.5:1 ([accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)); "For custom foreground and background colors, strive for a contrast ratio of 7:1, especially in small text." ([dark mode](https://developer.apple.com/design/human-interface-guidelines/dark-mode)) | All text ≥ 4.5:1 in both themes; text under 13 px aims for 7:1. | Sample every visible text node against its effective background in light and dark: count < 4.5:1 = 0; count of text < 13 px below 7:1 reported. |
| HIG-80 · Must | **Not color alone.** "Avoid relying solely on color to differentiate between objects, indicate interactivity, or communicate essential information." ([color](https://developer.apple.com/design/human-interface-guidelines/color)) | Current place, unread, status and errors each carry text, an icon or a shape as well as color. | For each state indicator on the phone screens, a non-color cue exists. |
| HIG-81 · Should | **Increase Contrast.** "ensure it at least provides a higher contrast color scheme when the system setting Increase Contrast is turned on" ([accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)) | `@media (prefers-contrast: more)` raises secondary text and borders, unless all text already meets 7:1. | Static: a `prefers-contrast: more` rule exists, or the HIG-79 sample shows all text ≥ 7:1. |
| HIG-82 · Should | **Elevated surfaces in dark.** "the system uses two sets of background colors — called base and elevated" ([dark mode](https://developer.apple.com/design/human-interface-guidelines/dark-mode)) | In dark, sheets and menus use a lighter surface than the page behind them; no hard-coded white surfaces. | In dark: sheet background luminance > page background luminance; visible elements with a white background: 0. |
| HIG-83 · Should | **One meaning per color.** "Avoid using the same color to mean different things." ([color](https://developer.apple.com/design/human-interface-guidelines/color)) | There is no accent colour: selection, focus and unread use shape and the inverted fill, and agent colours appear only in the Agents section (final design tokens). | Visual review against the token roles. |

### Accessibility

| ID | Apple says | Flux on the web | Check |
| --- | --- | --- | --- |
| HIG-84 · Must | **VoiceOver names and structure.** "Describe your app’s interface and content for VoiceOver." ([accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)); "Provide alternative text labels for custom interface icons." ([icons](https://developer.apple.com/design/human-interface-guidelines/icons)) | Every control has an accessible name; decorative icons are `aria-hidden`; each screen has one `h1`, a `main` and named `nav` landmarks. | Interactive elements without an accessible name: 0; `h1` count = 1; every `nav` has a name. |
| HIG-85 · Should | **Voice Control.** "To ensure a smooth experience, label interface elements appropriately." ([accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)) | A control's accessible name contains its visible label, so "Tap Send" works. | Controls with visible text whose accessible name does not contain that text: 0. |
| HIG-86 · Must | **Logical focus, no surprise moves.** "When tabbing between fields, move focus in a logical sequence." ([text fields](https://developer.apple.com/design/human-interface-guidelines/text-fields)); "Avoid changing focus without people’s interaction." ([focus and selection](https://developer.apple.com/design/human-interface-guidelines/focus-and-selection)) | Focus order follows the visual order (header, content, composer, bar). Opening a sheet moves focus into it; closing returns it to the opener; loading does not move focus. | Tab order matches top-to-bottom order; after a sheet closes, `document.activeElement` is the opener; after load, focus has not jumped to a control. |
| HIG-87 · Should | **Full Keyboard Access on iPad.** "Support Full Keyboard Access when possible." ([keyboards](https://developer.apple.com/design/human-interface-guidelines/keyboards)) | Every control is reachable with Tab and shows a visible focus ring with 3:1 contrast. | At 820 with a keyboard: every above-fold control receives focus; focus outline ≥ 2 px and ≥ 3:1. |
| HIG-88 · Must | **Alternatives to gestures.** "Offer alternatives to gestures." and "if you use a swipe gesture to dismiss a view, also make a button available" ([accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)) | Every swipe or drag (sheet dismissal, drawer, board move, map pan and zoom) has a button or menu equivalent. | For each gesture, the equivalent control exists and works by tap. |
| HIG-89 · Should | **Nothing that vanishes too soon.** "Minimize use of time-boxed interface elements." and "Prefer dismissing views with an explicit action." ([accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)) | Toasts with actions (Undo, Retry) stay at least 10 s or until dismissed; no sheet closes on a timer. | Actionable toasts visible ≥ 10 s; timer-dismissed sheets: 0. |

### Gestures

| ID | Apple says | Flux on the web | Check |
| --- | --- | --- | --- |
| HIG-90 · Must | **Standard meanings.** "Avoid using a familiar gesture like tap or swipe to perform an action that’s unique to your app" ([gestures](https://developer.apple.com/design/human-interface-guidelines/gestures)) | Tap activates; touch and hold opens a context menu; swipe down dismisses a sheet; drag moves an item. No app-specific meaning for double tap. | Handlers bound to double tap (`dblclick`) outside the map canvas: 0. |
| HIG-91 · Must | **Zoom stays available, nothing needs it.** The standard double tap and zoom gestures zoom and magnify content ([gestures](https://developer.apple.com/design/human-interface-guidelines/gestures)); "If you support zoom, set appropriate maximum and minimum scale values." ([scroll views](https://developer.apple.com/design/human-interface-guidelines/scroll-views)) | No `user-scalable=no` and no `maximum-scale` below 2 ([#264](https://github.com/ColdPhase/flux/issues/264)). `touch-action` never removes pinch zoom from page areas (use `pan-y pinch-zoom`, not `pan-y`); only the map canvas handles its own pinch. Nothing needs zooming (HIG-05, HIG-08, HIG-41). | Viewport meta check; visible elements outside the map canvas whose effective `touch-action` excludes pinch zoom and that cover > 10 % of the viewport: 0. |
| HIG-92 · Should | **Immediate, predictable gesture feedback.** "As people perform a gesture in your app, provide feedback that helps them predict its results" ([gestures](https://developer.apple.com/design/human-interface-guidelines/gestures)) | Sheets and drawers follow the finger, then settle or close past a third or on a flick measured near release. | Covered by HIG-73's drag measurement; a slow drag to 30 % settles back, a fast flick closes. |
| HIG-93 · Should | **Show what is unavailable.** "Indicate when a gesture isn’t available." ([gestures](https://developer.apple.com/design/human-interface-guidelines/gestures)) | Unavailable controls look different, have `aria-disabled` and say why nearby. | Disabled controls have a distinct style and a visible reason or accessible description. |
| HIG-94 · Should | **Context menus mirror visible actions.** "Always make context menu items available in the main interface, too." ([context menus](https://developer.apple.com/design/human-interface-guidelines/context-menus)) | Touch-and-hold menus on messages, tasks and map items repeat actions reachable from a visible More button. | Each long-press action is also reachable by taps. |

### Notifications

| ID | Apple says | Flux on the web | Check |
| --- | --- | --- | --- |
| HIG-95 · Must | **Ask in context.** "Before you can send any notifications to people, you have to get their consent" ([notifications](https://developer.apple.com/design/human-interface-guidelines/notifications)); "present a permission request when people first access the specific function that relies on private data or resources" ([onboarding](https://developer.apple.com/design/human-interface-guidelines/onboarding)) | Permission is requested only from a tap on an explained control (MOB-4); never on load or sign-in. In a Safari tab the app explains Add to Home Screen first. | Spy on `Notification.requestPermission`: calls during load and sign-in = 0; one call inside the click handler. |
| HIG-96 · Must | **Concise and private.** "Provide concise, informative notifications." and "Avoid including sensitive, personal, or confidential information in a notification." ([notifications](https://developer.apple.com/design/human-interface-guidelines/notifications)) | Lock-screen privacy as in the [mobile PWA contract](../product/mobile-pwa.md#lock-screen-privacy): who and where, not the private text, by default. | Push payload fixtures carry no private body text by default (existing #41 tests). |
| HIG-97 · Must | **One notification per thing.** "Avoid sending multiple notifications for the same thing, even if someone hasn’t responded." ([notifications](https://developer.apple.com/design/human-interface-guidelines/notifications)) | One push per event and recipient; replacement uses the same tag. | Deliveries per event and device = 1 (existing delivery tests). |
| HIG-98 · Should | **Quiet in the foreground.** "Handle notifications gracefully when your app is in the foreground." ([notifications](https://developer.apple.com/design/human-interface-guidelines/notifications)) | When the item is already on screen, no OS banner; the stream or badge updates instead. | Service worker skips `showNotification` when a visible client shows the target (code check plus test). |
| HIG-99 · Should | **Badges are unread counts.** "Use a badge only to show people how many unread notifications they have." "Keep badges up to date." ([notifications](https://developer.apple.com/design/human-interface-guidelines/notifications)) | The app icon badge (Badging API) and the Inbox badge equal unread notifications and clear when read. | Badge value equals unread count; after reading, 0. |
| HIG-100 · Must | **Settings in the app.** "you must also provide an in-app settings screen that lets people change their choice" ([managing notifications](https://developer.apple.com/design/human-interface-guidelines/managing-notifications)) | Notification settings (this device and categories) are two taps from any top-level phone screen. | Taps from Home to notification settings ≤ 2. |

### Onboarding and launch

| ID | Apple says | Flux on the web | Check |
| --- | --- | --- | --- |
| HIG-101 · Must | **Learn by using.** "Ideally, people can understand your app or game simply by experiencing it, but if onboarding is necessary, design a flow that’s fast, fun, and optional." ([onboarding](https://developer.apple.com/design/human-interface-guidelines/onboarding)) | A new account lands on Home with one obvious first action (write a note). Tips appear in context, once, and can be dismissed. | Fresh account: no blocking tour or modal; the first screen shows one prominent action. |
| HIG-102 · Should | **Postpone setup.** "Postpone nonessential setup flows or customization steps." ([onboarding](https://developer.apple.com/design/human-interface-guidelines/onboarding)) | Notifications, AI connections and appearance wait until people reach those features. | Steps required before the first note or message: 0. |
| HIG-103 · Must | **Empty states lead somewhere.** "Provide clear next steps on any blank screens." ([writing](https://developer.apple.com/design/human-interface-guidelines/writing)) | Empty Inbox, direct messages, tasks, map and wiki: one sentence and one action. | Each empty state has a sentence and a button or link. |
| HIG-104 · Should | **Instant launch, no flash.** "Launch instantly." and "Design a launch screen that’s nearly identical to the first screen of your app or game." ([launching](https://developer.apple.com/design/human-interface-guidelines/launching)) | Manifest `background_color` and `theme_color` match the first screen's surface; the app shell renders without a spinner screen. | Manifest colors equal the first screen's computed background in light. *Device:* launch in dark (the manifest cannot vary by theme). |
| HIG-105 · Must | **Restore where people were.** "Restore the previous state when your app restarts so people can continue where they left off." ([launching](https://developer.apple.com/design/human-interface-guidelines/launching)) | Reloading a URL restores the view, open thread, draft and scroll; reopening the Home Screen app returns to the last place. | Reload a thread URL: same thread open, draft kept. *Device:* relaunch from the Home Screen. |

### Settings

| ID | Apple says | Flux on the web | Check |
| --- | --- | --- | --- |
| HIG-106 · Should | **Few settings, good defaults.** "Minimize the number of settings you offer." and "Aim to provide default settings that give the best experience to the largest number of people." ([settings](https://developer.apple.com/design/human-interface-guidelines/settings)) | Defaults work without visiting Settings; each setting earns its place. | Visual review of the Settings list. |
| HIG-107 · Should | **Task options in the task.** "When possible, prefer letting people modify task-specific options without going to your settings area." ([settings](https://developer.apple.com/design/human-interface-guidelines/settings)) | Filters, view modes and per-project notification choices live on their screens. | No view filter or per-screen option appears only in Settings. |
| HIG-108 · Must | **Respect system settings.** "Respect people’s systemwide settings and avoid including redundant versions of them in your custom settings area." ([settings](https://developer.apple.com/design/human-interface-guidelines/settings)) | Reduced motion, text size and contrast come from the system; appearance defaults to System (HIG-78). | No in-app motion, text-size or contrast switches; the appearance control defaults to System. |
| HIG-109 · Should | **Clear and findable.** "Keep settings labels clear and simple." "If you need to direct someone to a setting, provide a direct link or button, rather than trying to describe its location." ([writing](https://developer.apple.com/design/human-interface-guidelines/writing)) | Settings is reachable in two taps on a phone, each section has Back, and any "turn this on" message links straight to the setting. At tablet widths the section list stays beside the open section ([split views](https://developer.apple.com/design/human-interface-guidelines/split-views)). | Taps from Home to Settings ≤ 2; messages that describe a setting's location without a link: 0; at 820 the list is visible beside a section. |

### Writing style

| ID | Apple says | Flux on the web | Check |
| --- | --- | --- | --- |
| HIG-110 · Should | **Clear, short, plain.** "Be clear." "If you can use fewer words, do so." ([writing](https://developer.apple.com/design/human-interface-guidelines/writing)); "Avoid using specialized or technical terms without defining them." ([inclusion](https://developer.apple.com/design/human-interface-guidelines/inclusion)) | Phone labels of one to three words; no unexplained jargon (MCP, sketch, grant) on primary phone screens. | Button, tab and header labels > 3 words: 0; jargon terms without an explanation nearby: listed and justified. |
| HIG-111 · Should | **Verbs on actions.** "When labeling buttons and links, it’s almost always best to use a verb." ([writing](https://developer.apple.com/design/human-interface-guidelines/writing)) | "Send", "Add task", "Open thread"; no "Click here" or vague "OK". | Review of button and link texts. |
| HIG-112 · Must | **Touch words.** "not saying “click” for a touch device like iPhone or iPad where you mean “tap.”" ([writing](https://developer.apple.com/design/human-interface-guidelines/writing)) | Copy shown on coarse pointers says tap, never click or hover; prefer wording that names no gesture. | Visible text on phone and tablet screens containing "click" or "hover": 0. |
| HIG-113 · Must | **Helpful errors.** "display it as close to the problem as possible, avoid blame, and be clear about what someone can do to fix it" and "Avoid using we altogether" ([writing](https://developer.apple.com/design/human-interface-guidelines/writing)) | Errors next to the problem, with a next step; no "we", "oops" or bare "Invalid". | Error strings without a next step, or with "we"/"oops": 0. |
| HIG-114 · Should | **Consistent language.** "Choose a style for each UI element type and use it consistently throughout your app" and "Use possessive pronouns sparingly." ([writing](https://developer.apple.com/design/human-interface-guidelines/writing)) | Sentence case throughout; the same word for the same thing on phone and desktop (ADAPT-3); "Tasks" rather than "Your tasks" unless needed for clarity. | Review of labels on the phone screens. |
| HIG-115 · Should | **Short help.** "Keep your tips to one or two sentences" and "Avoid bloating your help content by explaining how standard components or patterns work." ([offering help](https://developer.apple.com/design/human-interface-guidelines/offering-help)) | Hints and tips are one or two sentences, at most 90 characters on a phone. | Visible hint or help lines longer than 90 characters or 2 sentences: 0. |

## Sources

### Apple Human Interface Guidelines

Fetched 2026-10-05 from Apple's documentation JSON. The date is the newest entry in
each page's change log; "none" means the page shows no change log. The
`navigation-bars` address redirects to Toolbars; `haptics` returns 404, so
[playing haptics](https://developer.apple.com/design/human-interface-guidelines/playing-haptics) is used.

| Page | Change log | Page | Change log |
| --- | --- | --- | --- |
| [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility) | 2025-06-09 | [Notifications](https://developer.apple.com/design/human-interface-guidelines/notifications) | 2023-10-24 |
| [Action sheets](https://developer.apple.com/design/human-interface-guidelines/action-sheets) | none | [Offering help](https://developer.apple.com/design/human-interface-guidelines/offering-help) | 2023-12-05 |
| [Alerts](https://developer.apple.com/design/human-interface-guidelines/alerts) | 2024-02-02 | [Onboarding](https://developer.apple.com/design/human-interface-guidelines/onboarding) | 2024-06-10 |
| [Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons) | 2025-12-16 | [Playing haptics](https://developer.apple.com/design/human-interface-guidelines/playing-haptics) | 2024-05-07 |
| [Color](https://developer.apple.com/design/human-interface-guidelines/color) | 2025-12-16 | [Popovers](https://developer.apple.com/design/human-interface-guidelines/popovers) | none |
| [Context menus](https://developer.apple.com/design/human-interface-guidelines/context-menus) | 2023-12-05 | [Progress indicators](https://developer.apple.com/design/human-interface-guidelines/progress-indicators) | 2023-09-12 |
| [Dark Mode](https://developer.apple.com/design/human-interface-guidelines/dark-mode) | 2024-08-06 | [Scroll views](https://developer.apple.com/design/human-interface-guidelines/scroll-views) | 2026-06-08 |
| [Designing for iOS](https://developer.apple.com/design/human-interface-guidelines/designing-for-ios) | none | [Search fields](https://developer.apple.com/design/human-interface-guidelines/search-fields) | 2026-06-08 |
| [Designing for iPadOS](https://developer.apple.com/design/human-interface-guidelines/designing-for-ipados) | none | [Searching](https://developer.apple.com/design/human-interface-guidelines/searching) | 2026-06-08 |
| [Entering data](https://developer.apple.com/design/human-interface-guidelines/entering-data) | 2023-06-21 | [Settings](https://developer.apple.com/design/human-interface-guidelines/settings) | 2024-06-10 |
| [Feedback](https://developer.apple.com/design/human-interface-guidelines/feedback) | none | [Sheets](https://developer.apple.com/design/human-interface-guidelines/sheets) | 2026-03-24 |
| [Focus and selection](https://developer.apple.com/design/human-interface-guidelines/focus-and-selection) | 2023-10-24 | [Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars) | 2026-06-08 |
| [Gestures](https://developer.apple.com/design/human-interface-guidelines/gestures) | 2024-09-09 | [Split views](https://developer.apple.com/design/human-interface-guidelines/split-views) | 2025-06-09 |
| [Icons](https://developer.apple.com/design/human-interface-guidelines/icons) | 2025-06-09 | [Tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars) | 2026-06-08 |
| [Inclusion](https://developer.apple.com/design/human-interface-guidelines/inclusion) | none | [Text fields](https://developer.apple.com/design/human-interface-guidelines/text-fields) | 2023-06-05 |
| [Keyboards](https://developer.apple.com/design/human-interface-guidelines/keyboards) | 2025-06-09 | [Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars) | 2025-12-16 |
| [Launching](https://developer.apple.com/design/human-interface-guidelines/launching) | 2024-06-10 | [Typography](https://developer.apple.com/design/human-interface-guidelines/typography) | 2025-12-16 |
| [Layout](https://developer.apple.com/design/human-interface-guidelines/layout) | 2026-09-09 | [Undo and redo](https://developer.apple.com/design/human-interface-guidelines/undo-and-redo) | none |
| [Lists and tables](https://developer.apple.com/design/human-interface-guidelines/lists-and-tables) | 2023-06-21 | [Virtual keyboards](https://developer.apple.com/design/human-interface-guidelines/virtual-keyboards) | 2025-06-09 |
| [Loading](https://developer.apple.com/design/human-interface-guidelines/loading) | 2025-06-09 | [Writing](https://developer.apple.com/design/human-interface-guidelines/writing) | 2025-12-16 |
| [Managing notifications](https://developer.apple.com/design/human-interface-guidelines/managing-notifications) | none | [Modality](https://developer.apple.com/design/human-interface-guidelines/modality) | 2023-12-05 |
| [Motion](https://developer.apple.com/design/human-interface-guidelines/motion) | 2025-09-09 | | |

Pages read but not quoted: activity views, charting data, collections, images,
labels, menus, pickers, pointing devices, segmented controls, SF Symbols, toggles
and web views. Their guidance is either covered above or does not apply to Flux's
phone screens today; recheck them when a screen starts using that component.

### Web platform

| Source | Date | Used for |
| --- | --- | --- |
| [WebKit: More Responsive Tapping on iOS](https://webkit.org/blog/5610/more-responsive-tapping-on-ios/) | 2015-12-15 | `touch-action: manipulation` and the double-tap delay (HIG-17) |
| [WebKit: Using the System Font in Web Content](https://webkit.org/blog/3709/using-the-system-font-in-web-content/) | 2015-07-27 | `-apple-system-*` text-style keywords (HIG-11, unverified on device) |
| [MDN: VisualViewport](https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport) | modified 2026-08-12 | The keyboard shrinks the visual viewport (HIG-42) |
| [MDN: `env()`](https://developer.mozilla.org/en-US/docs/Web/CSS/env) | modified 2026-09-12 | Safe-area insets (HIG-01) |
| [MDN: viewport meta](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/meta/name/viewport) | modified 2026-09-23 | `interactive-widget` values; do not disable zoom (HIG-42, HIG-91) |

Keep this checklist current: when an Apple page's change log moves past the date
above, re-read that page, update the affected rules and record the new date here.
