# Documentation screens and README highlights

The images in this folder are unedited captures of the running application on the `./flux demo` data, taken by
Playwright in the Prostota look the app ships. They are cropped to the part the text is about, never drawn over or
retouched. The README highlights and the pages of the [documentation](../../README.md) use them; every page that
shows a theme-dependent screen gives the browser both themes through `prefers-color-scheme`.

The content is the fictional *Riverside Makers* company, as in [the README screenshots](../readme/README.md): the `./flux demo` seed
(`scripts/flux-demo.mjs`) plus the scene `app/tests/ui/media_scene.py`, which adds Basia Wrona (an admin) and Tomasz Lis (a guest) so that People
shows all four roles, Ada's agents, tasks, decisions and Wiki pages. The addresses are `@demo.flux.test`. The screens are taken after the recorded
journey, with the API and worker restarted without the test provider mock, so Settings › AI shows Ada's own connection, "Ada's Anthropic key", and
not the test one. The key is made up and no model was called.

| File | What it shows | Used in | Window (CSS px) |
| --- | --- | --- | --- |
| `signup-light.webp`, `signup-dark.webp` | The sign-up page of a new instance: Create your Flux account | [Installation](../../operations/install.md#4-create-your-account-and-check-mail) | 720 × 700 |
| `first-space.webp` | New › Space: a name, the people and the AI switch that starts on | [Installation](../../operations/install.md#4-create-your-account-and-check-mail) | the dialog, from 1440 × 900 |
| `people-computer-light.webp`, `people-computer-dark.webp` | Settings › Company: the four roles and the guests line | [Administration](../../operations/administration.md#people-and-roles) | 680 px wide crop of 1440 × 1000 |
| `people-phone-light.webp`, `people-phone-dark.webp` | The same list on a phone, scrolled to the people | [Administration](../../operations/administration.md#people-and-roles) | 390 × 844 at device scale 2 |
| `invite-link.webp` | Invite with a link: the form and the link it made, with Copy link | [Administration](../../operations/administration.md#invite-links), [Installation](../../operations/install.md#4-create-your-account-and-check-mail) | 680 px wide crop of 1440 × 1300 |
| `join-page.webp` | The page the link opens for someone who has no account yet | [Administration](../../operations/administration.md#invite-links) | 720 × 560 |
| `highlight-task.webp` | The Tasks board of the space: every state, and a person, an agent or nobody as the owner | [README](../../../README.md#highlights) | crop of 1200 × 560 |
| `highlight-home.webp` | Home: Waiting for you and Continue where you left off | [README](../../../README.md#highlights) | crop of 1440 × 900 |
| `highlight-agent.webp` | Settings › AI: Connect AI, Your agents (Assistant, Planner, Reviewer) and Your agent app with Claude Code connected | [README](../../../README.md#highlights), [Administration](../../operations/administration.md#agents-and-connections) | crop of 1440 × 900 |
| `highlight-map.webp` | The space's Map: seven linked thoughts under the space's views | [README](../../../README.md#highlights) | crop of 1440 × 900 |
| `highlight-wiki.webp` | A Wiki page of the space, with its table | [README](../../../README.md#highlights) | crop of 1440 × 900 |
| `highlight-phone.webp` | The space's conversation (the task made from the shared answer, and a new answer only Ada sees), and the "+" sheet that makes a task, thought, decision, page or space, side by side on a phone | [README](../../../README.md#highlights) | 2 × 390 × 844 at device scale 2, scaled to 75% |

Every file is a lossless WebP, which keeps the interface's text crisp and is the smallest of PNG and WebP for these
flat greys. Each is well below the 300 KB a screenshot may have under `docs/`
([evidence size](../../agents/evaluation.md#evidence-size)).

**Recorded at:** the application at `main` `a8369b516` (the application after [#1187](https://github.com/ColdPhase/flux/pull/1187)), 2026-11-10, by the one command that also records the demo GIF
and the README stills:

```sh
./scripts/record_media.sh        # GIF, stills and these screens, then the launch video's scripted clips
./scripts/record_demo.sh docs/assets/demo/flux-demo.gif docs/assets/readme docs/assets/screens   # the same without the clips
```

The script needs only Docker. It starts its own Compose project on loopback ports (`FLUX_DEMO_RECORD_PORT`,
`FLUX_DEMO_RECORD_MAILPIT_PORT`), gives it a keyring and throwaway VAPID keys, so the notification settings show the Push column of a real
install, and removes the project, its volumes and its images afterwards. The app is told it is served from `https://flux.example.com`
(`FLUX_DEMO_RECORD_ORIGIN` changes it), so invite links and agent commands read like a real install instead of `127.0.0.1:<port>`; the recorder
maps that name to itself and terminates TLS with a throwaway certificate inside its own container. Record these images again, and update the
revision above, when the screens they show change noticeably.
