# Documentation screens and README highlights

The images in this folder are unedited captures of the running application on the `./flux demo` data, taken by
Playwright in the Prostota look the app ships. They are cropped to the part the text is about, never drawn over or
retouched. The README highlights and the pages of the [documentation](../../README.md) use them; every page that
shows a theme-dependent screen gives the browser both themes through `prefers-color-scheme`.

The content is the fictional *Riverside Makers* workspace (Ada Kowalska and Jonas Berg), seeded through the public API
by `scripts/flux-demo.mjs`. After the README journey, `app/tests/ui/record_docs_media.py` adds two more people (Basia
Wrona, an admin, and Tomasz Lis, a guest) so that People shows all four roles, and an encrypted space, *Garden club*,
for its highlight. The addresses are `@demo.flux.test`.

| File | What it shows | Used in | Window (CSS px) |
| --- | --- | --- | --- |
| `signup-light.webp`, `signup-dark.webp` | The sign-up page of a new instance: Create your Flux account | [Installation](../../operations/install.md#4-create-your-account-and-check-mail) | 720 × 700 |
| `first-project.webp` | New project: one name, four starting points | [Installation](../../operations/install.md#4-create-your-account-and-check-mail) | 712 × 470 crop of 1440 × 900 |
| `people-computer-light.webp`, `people-computer-dark.webp` | Settings → People: the four roles and the AI row | [Administration](../../operations/administration.md) | 680 px wide crop of 1440 × 1500 |
| `people-phone-light.webp`, `people-phone-dark.webp` | The same list on a phone, scrolled to the people | [Administration](../../operations/administration.md) | 390 × 844 at device scale 2 |
| `invite-link.webp` | Invite with a link: the form and the link it made, with Copy link | [Administration](../../operations/administration.md#invite-links), [Installation](../../operations/install.md#4-create-your-account-and-check-mail) | 680 px wide crop of 1440 × 1500 |
| `join-page.webp` | The page the link opens for someone who has no account yet | [Administration](../../operations/administration.md#invite-links) | 720 × 520 |
| `highlight-task.webp` | A message becomes a task: the Create window with the message as its source | [README](../../../README.md#highlights) | crop of 1440 × 900 |
| `highlight-home.webp` | Home when Ada comes back: Needs you and Continue where you left off | [README](../../../README.md#highlights) | crop of 1440 × 900 |
| `highlight-agent.webp` | Settings → Agents and AI: Connect your MCP client, with the Claude Code commands | [README](../../../README.md#highlights) | crop of 1440 × 1300 |
| `highlight-map.webp` | The project's Map view: a sketch of linked ideas under the project's views | [README](../../../README.md#highlights) | crop of 1440 × 900 |
| `highlight-phone.webp` | The Inbox and the notification settings (Inbox, Push, Email for each kind) on a phone, side by side | [README](../../../README.md#highlights) | 2 × 390 × 560 at device scale 2, scaled to 75% |
| `highlight-encrypted.webp` | An encrypted space's People: the Encryption section and the AI row that stays off | [README](../../../README.md#highlights) | 680 px wide crop of 1440 × 1500 |

Every file is a lossless WebP, which keeps the interface's text crisp and is the smallest of PNG and WebP for these
flat greys. Each is well below the 300 KB a screenshot may have under `docs/`
([evidence size](../../agents/evaluation.md#evidence-size)).

**Recorded at:** the application at `main` `5f3d96c60` with the notification-card padding fix of [#810](https://github.com/ColdPhase/flux/pull/810), 2026-11-01, by the one command that also records the demo GIF
and the README stills:

```sh
./scripts/record_media.sh        # GIF, stills and these screens, then the launch video's scripted clips
./scripts/record_demo.sh docs/assets/demo/flux-demo.gif docs/assets/readme docs/assets/screens   # the same without the clips
```

The script needs only Docker. It starts its own Compose project on loopback ports (`FLUX_DEMO_RECORD_PORT`,
`FLUX_DEMO_RECORD_MAILPIT_PORT`), gives it a keyring for the encrypted space and throwaway VAPID keys, so the
notification settings show the Push column of a real install, and removes the project, its volumes and its images
afterwards. The app is told it is served from `https://flux.example.com` (`FLUX_DEMO_RECORD_ORIGIN` changes it), so
invite links and agent commands read like a real install instead of `127.0.0.1:<port>`; the recorder maps that name
to itself and terminates TLS with a throwaway certificate inside its own container. Record these images again, and update the revision above, when the screens they show change noticeably.
