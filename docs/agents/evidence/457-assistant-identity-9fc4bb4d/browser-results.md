# Results for exact source 9fc4bb4d3b7310b7b8745f8de81cc2047268f54f

## Runtime

- Canonical Docker Compose build, build, typecheck, and lint completed successfully. Lint reported 0 errors and 3 warnings (the pre-existing React Hook dependency warning and two module-level directive build warnings are in the log).
- Focused assistant join E2E: 2/2 passed, 0 failed, one Chromium and one WebKit journey. Each journey covered owner Request → manager Needs You → immutable assistant/owner identity → Review/Allow; no grant before Allow; ordinary reader denial; contributor grant after Allow; failure retains pending request; keyboard Enter. WebKit viewport was 390×844 with mobile/touch emulation and checked 44px targets; Chromium was 1440×900.
- Focused API regression: 1/1 passed: join request gives no authority, is deduplicated and manager-scoped, and manager Allow uses an ordinary contributor grant.
- Both Compose runs completed cleanup, removing their project containers, volumes, networks and per-run images.
- Exact-head GitHub required checks: Agent setup and Application validation both SUCCESS (runs 38517076213 and 38517076205).

## Screenshots

There are 16 PNGs with SHA-256 verification in `SHA256SUMS`. Each engine has owner request (light); manager Needs You question, card crop, collapsed row (light); and expanded Review/Allow (light and dark). The two manifests identify source SHA, engine, viewport, zoom, themes and scenario. Fixtures are independent between engines; UUIDs are unavailable in the maintained runner output, so color comparison across engine screenshots is not a same-identity comparison.

The neutral visual evaluation is pending and is not represented as passed by this packet.
