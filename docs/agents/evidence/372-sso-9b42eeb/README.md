# SSO-only sign-in appearance (#372)

This evidence is rendered from PR head `9b42eeb32edc0904d7c1064c8aa5c9999571e767` in a disposable Docker Compose app with the test Keycloak provider. Chromium captured 1440×900 desktop and 390×844 phone viewports in light and dark themes, in both the normal SSO-only state and the email-collision error state. The error route used `?sso=failed&sso_reason=email_held`.

The capture asserts that the SSO-only page shows its Keycloak sign-in button and contains no email or password fields. For the error state it also asserts a visible alert. The manifest records each viewport, theme, state, button/error visibility, and document height. All captures fit the viewport without scrolling.

The independent neutral visual review passes with one non-blocking P3: the provider error text is blue/cyan while the F-026 sign-in screen is monochrome. No code change was made for this minor issue. Screenshots assess appearance only; they do not establish interaction, permissions, accessibility, or full #340 acceptance.

Compare with [desktop sign-in](../../../design/final/screens/desktop-signin.webp) and [phone sign-in](../../../design/final/screens/phone-signin.webp). See [neutral brief](neutral-brief.txt), [visual review](visual-review.md), and [capture manifest](manifest.json).
