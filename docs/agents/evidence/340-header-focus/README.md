# One-row project header and focus mode (#340, part 2)

The running app on `./flux demo` data, signed in as Ada, captured with Playwright Chromium against `./flux dev`.

- [1440 × 900, light](project-light-1440.webp) and [dark](project-dark-1440.webp): the name, the five views as
  a segmented control, the people and agents, Together and More, in one row.
- [More](more-1440.webp): Details, What matters, Focus (`F`) and Hide the sidebar (`[`), each key shown.
- [Focus](focus-1440.webp): `F` folds the sidebar to the rail and the header keeps the name, the view and
  "Focus · notifications paused until 14:00"; the server holds push and email until then.
- [768 × 1024](project-light-768.webp): a panel narrower than 900 px gives the views their own line.

No item needs Ada in the demo project, so the "N needs you" chip is absent here; `test_return_view` covers it.
