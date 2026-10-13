# Capture provenance note (separate from the original E2E manifests)

Pinned final source: `813affc6d247fdfc9c27bd2a7dc1887c8f1b7c12`.

The original E2E manifests do not include a `sourceSha`; this note does not add one retroactively. The screenshots were produced by the `flux-test-457-identity` Docker Compose E2E run on 2026-10-13 around 19:37 +02:00. The generated manifest records Chromium at 1440×900 and WebKit at 390×844, CSS zoom 1, light/dark themes, fake metadata only, no model calls. E2E assertions include the Request→Inbox→Review/Allow journey, no grant before Allow, ordinary-reader denial, retry after denied Allow, persisted contributor grant, keyboard activation, and 44px phone targets.

After capture, only `app/tests/app/assistant-settings.test.ts` and `app/tests/app/assistant-settings-migration.test.ts` changed before the pinned commit. Those changes corrected regression-test expectations/query linkage and asserted the durable request-cycle marker. The production API, schema, DTO, UI/CSS, and `assistant-join.e2e.ts` were unchanged. Their pinned source file hashes are below; this is author-reported source equivalence, not a source SHA embedded by the screenshot runner.

## Pinned production and E2E source hashes

- `app/apps/server/src/assistant/joins.ts`: `e46a39abcfa54db3a03e58c882304a7ac513ac724de1b2d06a346bcab0ff7cd0`
- `app/apps/server/src/push/index.ts`: `d55cbbfa11798a9896c6cab9665433ca17d7d62be1ca0ec0a79321f3eacda70f`
- `app/apps/web/src/notifications/InboxView.tsx`: `04046e728c113156f4e31d5cbdf8f45d5a79ec0f5a3528ab3188203cee7e9faf`
- `app/apps/web/src/notifications/notifications.css`: `35a386030ac7917b5c11588930f263f8cb5d3dd226a14c23c6f76cba9d76f619`
- `app/packages/contracts/src/push.ts`: `87e0d8acc7685fb3ef839f15f96e41b663acea4da9a68455f2c4998b53f93bfb`
- `app/packages/core/src/push/ports.ts`: `75c2798b2c389a4744cc97a5249c9ba7d4ab07c00239f4a03de04d0ea07fd58b`
- `app/packages/db/src/schema.ts`: `edeb458a5b097c54958594590a0da9a5f71b109cff7568c5f383d2ce04a7749b`
- `app/packages/db/src/repositories/assistant-joins.ts`: `9dd1f849dd384a903cfe354fcd74e7b82062e4d2d27885cae46a27997d1da1e1`
- `app/packages/db/src/repositories/push.ts`: `b9df6575a5865a156c0ea7a9492efd5f234740d83a43abc6debf10b437eb64f5`
- `app/tests/app/e2e/assistant-join.e2e.ts`: `5356aa2bdcae6827e828bcf95403ee32a8f866eae830d8defcd290e657b7ac38`

## Representative screenshot checksums

- `join-chromium-manager-needs-you-light.png` (1440×900): `2ecb1bb3ab7e3832c2a292b18d9380f4fae7706fa091c424b2fde8135149dc1f`
- `join-webkit-manager-needs-you-light.png` (390×844): `80d3207ab55d403e3767b2920a26dd5628d78a0e7d123dd85c30109fad85d0f5`
- `join-chromium-manager-review-light.png` (1440×900): `02c01471983c03958a7e4ace722f48b241fb15ce4a5685917550cbf529445378`
- `join-webkit-manager-review-light.png` (390×844): `33150df6fd5bf4d039567147488587cf77a33325c50cab1ac2eb28661d0ea1ca`
