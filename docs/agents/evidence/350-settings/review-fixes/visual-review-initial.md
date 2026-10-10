# Independent visual review — Flux Prostota Settings

Date: 2026-10-08. Source commit supplied with the evidence: `5ff972146296a582a4ee868db1dd2cd165477b78`.

**Result: changes required before passing F-026 visual conformance.** The core Settings content is readable, and the light/dark treatments share a coherent monochrome language. The supplied phone shell and several visible Settings details do not yet match the accepted Prostota contract. This result assesses rendered appearance only; it is not a functional or accessibility approval.

## Scope and independence

I reviewed the supplied pixels in a fresh reviewer context, without implementation code, revision history, or author rationale. I read the Flux visual-review skill, the foundation, design evaluation guidance, and `docs/design/final/README.md` (especially §§1–3 and §9). The only visual targets used were the four accepted Prostota renders listed below. I did not inspect older designs, edit the application, run Docker, or write to GitHub.

Neutral job: a workspace member chooses a device theme, finds their agents/connections, adjusts notification levels, quiet hours and morning summary, and finds shortcuts on desktop and phone.

Desktop evidence is specified as 1440 × 900 CSS px at 100% zoom. Phone evidence is specified as 390 × 844 CSS px at 100% zoom; the actual phone PNGs are 1170 × 2532 pixels (3×), while the references are 780 × 1688 pixels (2×). Comparisons concern their CSS viewport composition, not their differing pixel density.

References, under `docs/design/final/screens/`:

- `desktop-appearance.webp`
- `desktop-settings.webp`
- `phone-appearance.webp`
- `phone-settings.webp`

Actual captures, under `initial-5ff97214/`:

- `settings-desktop-1440-appearance-light-chromium.png`
- `settings-desktop-1440-appearance-dark-chromium.png`
- `settings-desktop-1440-shortcuts-chromium.png`
- `notifications-desktop-1440-settings-chromium.png`
- `settings-phone-390-settings-light-chromium.png`
- `settings-phone-390-settings-dark-chromium.png`
- `settings-phone-390-notifications-light-chromium.png`
- `settings-phone-390-notifications-dark-chromium.png`

## Material findings

### 1. The phone navigation shell is visibly a different design

**Location/evidence:** the top and bottom of all four actual phone captures, compared with `phone-appearance.webp` and `phone-settings.webp`.

**Visible symptom:** the actual screens have a full-width fixed bar with Home, Inbox, Messages and Projects. The accepted renders have a floating Home, Projects, Inbox capsule plus a separate round Search control. The actual Settings entry screen also uses a hamburger and small centered title in a horizontal header; the reference uses a round Back control and a prominent left-aligned Settings title. These differences persist in dark mode.

**User consequence:** the phone gives different navigation priorities and loses the reference's always-visible Search entry. Settings does not inherit the same recognizable composition as the accepted phone experience. This is a concrete composition/navigation mismatch, not a preference for a different style.

**Direction:** integrate these routes with the accepted phone shell, including its tab membership/order, floating shapes, Search control, Back treatment and title hierarchy. Preserve the current readable content groups. The screenshots cannot establish which implementation issue owns this shell; the mismatch remains relevant to integrated visual acceptance.

### 2. Reading and motion controls drawn in the Settings references are absent

**Location/evidence:** the content immediately below the desktop theme tiles in both `settings-desktop-1440-appearance-*-chromium.png`; the This phone group in both `settings-phone-390-settings-*-chromium.png`; and the area following quiet hours/morning summary in both `settings-phone-390-notifications-*-chromium.png`.

**Visible symptom:** the desktop reference has Text size and Reduce motion rows above the Kreska row. The actual card contains only Kreska. The phone Appearance reference includes Text size / Follows phone, which is absent from the actual This phone group. The phone Notifications reference includes a Reading section with Text size, whereas the actual capture proceeds directly to the Push and email matrix.

**User consequence:** a member scanning the settings cannot discover the reading/motion adjustments or the explanation of phone text-size behavior shown in the accepted design. These are missing visible settings, rather than merely different padding or sample data.

**Direction:** restore the reference's visible reading/motion controls and grouping, retaining truthful device behavior. Preserve required notification-delivery configuration through the accepted visual language; do not remove working notification capabilities simply to shorten the screenshot. Verify the behavior of these controls separately.

### 3. Assistant rows omit the explicit Agent label

**Location/evidence:** Your assistant in both desktop Appearance captures and both phone Settings captures.

**Visible symptom:** the assistant has a colored Kreska and the words “for you · not set up,” but there is no visible “Agent” tag. The owner wording and Kreska are useful; the explicit label required by final-design §1 principle 5 and §9 Agent marking is absent.

**User consequence:** identity depends on knowing the Kreska symbol and interpreting the name “assistant.” The accepted contract requires the role to be explicit so that an agent is never mistaken for a person or ordinary connection.

**Direction:** show the Agent label alongside the name and owner within the existing row hierarchy on both devices and themes. Preserve Kreska, owner text, connection status and the restrained agent-only color.

## Useful elements to preserve

- The desktop category column has a clear selected state, sensible width, and direct entries for Appearance, Notifications, Agents and AI, and Keyboard shortcuts. The main column is compact and aligned closely to the accepted desktop references.
- The theme choices are immediately recognizable. Selection is conveyed through both an outline and a radio indicator, and remains visible in the supplied light and dark captures.
- The notification level group, quiet-hours summary and morning-summary row are readable and visible together on the phone. On desktop the expanded quiet-hours fields remain grouped with the relevant setting. Primary settings do not require searching through the delivery matrix first.
- Soft card volume, restrained dividers, pill switches and dark surfaces that become lighter as they rise give the core content the intended character. The captured UI is monochrome apart from the permitted agent color.
- The desktop shortcut table is easy to scan: keycaps form one aligned column and plain-language actions another. All listed rows fit in the supplied 900-pixel-high viewport.

## Missing evidence and live-test questions

The actual Appearance captures contain empty project/message navigation and an assistant that is not set up. They do not establish the populated multi-agent appearance required by §9's demo-data comparison. Request captures of several connected agents with owners and longer names, plus their management destination, before treating the agent-finding job as visually complete.

The phone's More heading starts at the bottom of the Settings capture, but its entries and a phone shortcut screen are not shown. It is therefore unverified whether a member can readily find shortcuts after scrolling. Verify the complete scroll range, bottom clearance and visible route to the shortcut list.

The supplied set does not show desktop dark Notifications, a phone quiet-hours editor, an enabled morning-summary editor, alternate notification levels, focus/hover/pressed states, save failure, or notification permission states beyond an unconfigured server. The desktop notification image does not expose the entire page. The reference's “When an agent finishes” row is not visible in that captured region; establish its accessible destination in the full implementation rather than inferring its absence from this crop.

In the running application, independently check:

- Theme selection, system-theme changes and persistence; phone/system text sizing, enlarged text and reduced motion.
- Keyboard traversal, radio and switch semantics, focus visibility, actual shortcut behavior, Back/history, and navigation destinations.
- Actual text/icon contrast and touch target measurements; screenshots do not certify the required ratios or 44-pixel hit areas.
- Quiet-hour and morning-summary editing, save/error feedback, time zone behavior, and notification delivery. Visible labels do not prove these values take effect.
- Permissions and ownership for connection/agent management, and long/connected/unavailable agent states.
- Chromium and WebKit emulation across the required sizes, including narrow screens and content beneath the fixed/floating navigation.

No interaction, persistence, access, contrast-ratio, WCAG or whole-task acceptance claim is made by this report.
