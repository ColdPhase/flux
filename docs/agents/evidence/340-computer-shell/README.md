# Computer sidebar, rail, New and the working-agent card (#340)

The running app on `./flux demo` data at 1440 × 900, signed in as Ada.

- [Home, light](https://github.com/ColdPhase/flux/blob/b17ae9e357441e9a383eb275d1034e69ec50c98a/docs/agents/evidence/340-computer-shell/home-light.webp): the sidebar in its drawn order, with Home current as a raised pill, the
  Inbox count, Sketchbook, the project tile, Messages and the account row with Settings.
- [A project, dark](https://github.com/ColdPhase/flux/blob/b17ae9e357441e9a383eb275d1034e69ec50c98a/docs/agents/evidence/340-computer-shell/project-dark.webp): the open project is the raised pill.
- [New, light](https://github.com/ColdPhase/flux/blob/b17ae9e357441e9a383eb275d1034e69ec50c98a/docs/agents/evidence/340-computer-shell/new-light.webp) and [dark](https://github.com/ColdPhase/flux/blob/b17ae9e357441e9a383eb275d1034e69ec50c98a/docs/agents/evidence/340-computer-shell/new-dark.webp): `C` opens New inside a project, where Task is
  available.
- [The rail, light](https://github.com/ColdPhase/flux/blob/b17ae9e357441e9a383eb275d1034e69ec50c98a/docs/agents/evidence/340-computer-shell/rail-light.webp) and [dark](https://github.com/ColdPhase/flux/blob/b17ae9e357441e9a383eb275d1034e69ec50c98a/docs/agents/evidence/340-computer-shell/rail-dark.webp): `[` folds the sidebar to 64 px.

The header in these shots is still the one before #340's second part (the one-row header and focus).
The working-agent card shows only while the person's own assistant run works; the demo has no running
run, so `test_personal_assistant` covers it.

Captured with Playwright Chromium against `./flux dev`.
