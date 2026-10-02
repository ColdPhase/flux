# Flux background connection — independent visual review

**Verdict: visual changes requested.** The light layouts are compact and readable, and the optional connection does not visually take over ordinary project navigation. Three visible problems remain: unreadable dark action labels, cancellation discovery during replacement, and error placement. This verdict covers appearance only; it is not whole-task or functional approval.

Review date: 2026-09-30. Supplied source revision: `ee0d10b4bc7be5fe94eb5779e9dfd629eef606e9`. Rendering environment supplied in the brief: Docker Chromium. Review used the Flux independent visual review skill and current design guidance from `.worktrees/132-studio-v11-design/docs/design/README.md` and `direction.md`. No implementation code, Git history, previous reviews, or author rationale was read. No application or repository documents were edited.

The user is a signed-in contributor configuring their own optional background comparison source, understanding payer/data disclosures and local allowances, replacing or disconnecting it, and authorizing a personal project's paused rule. Ordinary work must remain reachable. Background execution is unavailable. Secrets and payer details must remain private to the owner.

All candidate paths below are under `reviewed-ee0d10b/` and were inspected at original image resolution:

| Evidence | Declared viewport/state |
| --- | --- |
| `background-setup-1440-saved.png`, `background-setup-1440-saved-dark.png`, `background-setup-1440-error.png`, `background-rules-1440-paused.png` | 1440×900 desktop, 100%, DPR1; light saved, dark saved, replacement error, scrolled paused rule |
| `background-setup-390-empty.png`, `background-setup-390-saved.png`, `background-setup-390-replace.png`, `background-setup-390-consent.png` | 390×844 touch phone, 100%, DPR1; initial form, saved, replacement opening, scrolled consent/actions |
| `background-setup-1024-saved.png`, `background-setup-1024-replace.png`, `background-setup-1024-consent.png` | 1024×768 touch tablet, 100%, DPR1; saved, replacement opening, scrolled consent/actions |
| `background-setup-1440-zoom2.png` | Separate CSS zoom 200% capture; supplied viewport 1440×900, image file 1440×1800 |

The three supplied Studio v11 images (`appearance-light-mint-after.png`, `appearance-dark-mint-after.png`, `chat-390-after.png`) were inspected as references for restrained type, hierarchy, readable dark surfaces, and optional controls. Their settings composition was not treated as a template.

## Material visible problems

1. **Dark saved connection actions — high priority.** In `background-setup-1440-saved-dark.png`, the labels inside **Replace connection** and **Disconnect** are almost black against the dark background, although their outlines remain visible. The project name and **New project** navigation labels are also much weaker than nearby headings. Users can miss the two connection controls or read them as unavailable, and the ordinary-work route loses clarity. Give actionable labels theme-aware foreground colors with clear separation from the dark surface; maintain a distinct appearance for genuinely unavailable actions. Verify actual color pairs and states in the application. This is an observable readability failure, not a preference for a lighter dark theme.

2. **Replacement opening on phone/tablet — moderate priority.** In `background-setup-390-replace.png` and `background-setup-1024-replace.png`, the full saved summary and its **Replace connection** button remain above the replacement section. The **Cancel** action appears only after all fields and four consent statements, visible in the separate scrolled consent captures. Users who opened replacement and change their mind have no visible cancellation route near the edit heading and must traverse a long form to find it. Add a discoverable cancel action beside the replacement heading or persistently within the editing surface. Keep the bottom cancel action and the safe saved metadata; a compact saved summary during replacement could reduce the repeated content. A long consent form is reasonable—the problem is the distance to this explicitly primary escape action.

3. **Replacement error — moderate priority.** In `background-setup-1440-error.png`, “Check the key, organization, workspace, allowance and confirmations, then try again” is placed immediately below the unavailable-execution notice, above the saved connection summary. The replacement heading and first inputs start roughly 300 pixels lower; no correction target is marked in the visible inputs. The user first encounters unchanged saved values instead of the area requiring correction, and the message names nearly the whole form without indicating where to begin. Place the error within the replacement section, near its heading or submission area, and mark specific correctable fields when known. Preserve a safe general message for failures that cannot identify a field without exposing sensitive information. Focus and error association need live verification.

## Useful elements to preserve

- The readable content width, modest heading scale, section rules, and lack of nested cards fit a working application. The light desktop saved view fits metadata, connection actions, the project selector, and a continuation link in one capture.
- The metadata pairs are easy to scan on desktop and stack into readable phone rows. The saved screen displays a key suffix rather than the full key. That visible choice is useful; it does not prove secrecy elsewhere.
- The unavailable execution message appears early and states that saving does not enable a rule. The paused rule displays **Paused · version 1** and **Enable unavailable**, with a separate revoke action.
- The payer, invoice-cap limitation, interrupted-request charges, provider destination, and project-reader audience are expressed in readable copy. The four consent statements remain separate, beside individual checkboxes, before the save action.
- The phone/tablet consent screens show clear save/cancel hierarchy and substantial visible control heights. The phone layout wraps text without horizontal clipping in the supplied states.
- The shell and continuation links retain visible routes back to work. The named project scope and exclusions on the paused rule help distinguish published evidence from private captures, DMs, and other projects.

## Missing states and live checks

No supplied image shows the paused-rule creation controls, narrow/tablet paused-rule details, dark consent/error states, pending submission, successful revocation/disconnection feedback, or another user's view. These remain outside this visual evidence.

Separately verify keyboard order and focus, checkbox label hit areas, actual touch targets, error announcements/associations, menu access back to work on phone/tablet, cancellation preserving the saved connection, and usable scrolling with enlarged text. Verify save/create/revoke/disconnect behavior and persistence, agent ownership and permissions, absence of background execution, and isolation of secrets/payer details through other users' UI and data/API paths. Those checks were not run for this visual-only review.

Screenshots demonstrate the rendered captured states, not responsive transitions, physical-device behavior, WCAG compliance, data correctness, or privacy enforcement. The CSS zoom image is neither OS/browser zoom evidence nor real phone/tablet installation evidence. Its ancillary header subtitle truncates, while the visible form and actions remain legible; no browser-zoom compliance conclusion follows.
