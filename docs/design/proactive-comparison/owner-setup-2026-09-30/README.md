# Personal background source and paused rules

Observed 2026-09-30. A signed-in contributor configures their own optional
background comparison source, sees its payer/disclosure/local allowance,
replaces or disconnects it, and selects their own agent and project for a paused
rule. Ordinary project work remains available without AI. This checkpoint does
not enable background execution or establish real provider quality/spending.

## Current renders

[Current PNGs](current-ca4a770/) were rendered from persisted Docker fixture data
at `ca4a770`, with 15 states: light/dark desktop saved connection, phone empty,
saved, replacement and consent; tablet saved/replacement/consent; desktop failed
replacement and rule creation; paused desktop/phone/tablet rules; and enlarged
desktop content. Fixture keys and payer labels are fictional; no provider was
called. Normal captures use Chromium at 1440×900 desktop, 1024×768 touch tablet
or 390×844 touch phone, DPR 1, 100%. The separate zoom2 image uses CSS zoom 200%
and a 1440×1800 capture. It does not establish browser/OS zoom or physical-device
installation, keyboard or notification behavior.

The [saved phone](current-ca4a770/background-setup-390-saved.png) keeps the
disconnect effect immediately beside its action. The
[failed replacement](current-ca4a770/background-setup-1440-error.png) explains
the cleared key at the form and repeats the format/re-entry guidance beside the
input. The [paused phone rule](current-ca4a770/background-rules-390-paused.png)
explains unavailable execution beside its status/actions.

## Independent appearance review and disposition

The three neutral, independent visual reviews and their original PNGs are
preserved separately. They cannot approve API behavior, privacy, accessibility
or the complete #58 task.

- [ee0d10b review](review-ee0d10b.md), [original renders](reviewed-ee0d10b/):
  dark action labels, remote cancellation and error placement. The dark capture
  was taken during a theme transition; subsequent captures wait for settled
  colors and measure contrast. Replacement gained top cancellation and its
  error moved into the editing section.
- [035fd29 review](review-035fd29.md), [original renders](reviewed-035fd29/):
  recovery guidance and the unavailable-action reason. Explicit key clearing /
  re-entry help and nearby paused-rule explanations were added.
- [06d07f6 review](review-06d07f6.md), [original renders](reviewed-06d07f6/):
  compact readable normal surfaces, with disconnect explanation too distant and
  a recommendation for field-specific recovery when a safe cause is known.
  The current `ca4a770` render moves the disconnect explanation beside its action;
  this final positional change was inspected by the implementer and exercised
  in the browser, rather than represented as a new independent visual pass.

The field-specific recommendation remains a point for full peer evaluation.
Native required/length/numeric/consent validation guides locally rejected
values; the captured server 400 does not identify a field. Its generic recovery
message avoids claiming an unreported cause, associates the message with the key
input and explains re-entry after clearing. This evidence does not claim that
all difficult states or visual recommendations are accepted.

## Separate running verification

- Full configured Docker application check at
  `06d07f6cbdea4d0a569b719929ec82594332406a`: exit 0; build, type check,
  lint/architecture, 288 application tests, 3 PWA checks, access-stream journey,
  3 proposal/owner/rule UI journeys, persistence after API restart, and unavailable
  push/email checks. The evidence wrapper retained screenshots; it kept the
  configured assertions and follow-up commands.
- At `ca4a770`, after moving only the disconnect paragraph: Docker build/type
  check/lint and all 3 proposal/owner/rule browser journeys passed. No API,
  schema, accounting or worker behavior changed after the full check.
- Same-volume update from protected main
  `4d9179b57b82172e7bc1c08a0a459128cc7b76f7` (schema 20) to the tested
  `06d07f6` candidate (schema 25) passed: unchanged full-row snapshots for 16
  tables, original sessions and historical sources usable, new paused rule/key,
  continued manual work, exact ledger and idempotent repeat migration/start.
- Repository setup/link checks, 8 Python foundation tests and whitespace checks
  passed. These are separate from application and GitHub protection checks.

The browser journeys separately exercise owner-only connection metadata,
save/reload, fresh consent, key clearing after success/failure, cancellation,
failed replacement preserving the saved connection, disconnect/reload, another
person's empty connection view, manual work without a key, personal agent/project
selection and paused rule creation, pause/revoke/fresh renewal with a different
identity and unchanged earlier rule. API coverage verifies concurrent renewal
and possible-charge retention across renewed rules.

Remaining acceptance includes the insufficient-evidence outcome and owner usage
surfaces, production scheduling and activation guard, changed-evidence reopening,
real provider quality/cancellation and billing observation, independent current
head functional acceptance, integrated migration/release checks, and required
physical Android/iPhone/iPad evidence. Dark narrow/error states, long labels and
actual software keyboards remain outside these renders.
