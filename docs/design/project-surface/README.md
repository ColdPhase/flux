# Project surface (#117)

The project page brought up to the accepted O-003 direction C ([direction.md](../direction.md)),
with `flux-ux-v8.html` as the discoverability baseline. Screenshots come from the Compose
Playwright journey `tests/ui/test_project_surface.py` on realistic seeded content (three people,
one restricted project, a cited source, work, a current rule, a negative result, a proposed
decision, a project sketch and a doc), 100% zoom, light theme.

## What changed

- **Header:** project monogram, title and its truthful audience ("Jonas, Nia and you",
  "Jonas and you · only you two") from `GET /api/v1/projects/:id/people`; faces and a labelled
  **Details** button. The audience is a button that opens the people in Details.
- **Current-state line** under the title: current rule · work in progress (owner) · latest
  result · a proposal that needs you. Each segment opens its object. On the phone it is one
  44 px row, needs-you first, that opens the Details overview.
- **Tabs:** Conversation · Tasks · Map · Docs with counts and the sliding indicator; each is a
  route under `/projects/:projectId` and shares one parent loader (project, audience, work,
  sketches, docs).
- **One reading column:** the project's conversations moved to the sidebar (as in C), sources
  moved into the composer (the document button opens saved material to cite or add), and
  messages use avatars, day lines and calm chips for the objects made from them. On a pointer,
  message actions float over the message and take no room.
- **Details overview** (Details, the phone state row, or a message's **Details** action): linked
  work, decisions and results of the conversation or the selected message, sources, sketches and
  thoughts, docs that include what is linked, the rest of the project's current state, and who
  can see it — each one step away. Direct messages stay separate and are said to.
- **Map tab:** lists and creates project sketches (`scope: project`); a sketch opens inside the
  project at `/projects/:projectId/map/:sketchId`, so the tabs and audience stay. That route is
  bound to its project: another project's sketch moves to `/projects/<its project>/map/:id`, a
  private one to `/map/:id`, so a header never names the wrong audience.

## Screenshots

| Viewport | v8 · C prototype · production |
| --- | --- |
| 1440×900 conversation | [compare-1440x900.png](compare-1440x900.png) |
| 1440×900 Details | [compare-1440x900-details.png](compare-1440x900-details.png) |
| 1280×800 conversation (C · production) | [compare-1280x800.png](compare-1280x800.png) |
| 390×844 conversation | [compare-390x844.png](compare-390x844.png) |
| 390×844 Details | [compare-390x844-details.png](compare-390x844-details.png) |

Production only: `project-*-desktop-1440.png`, `project-conversation-desktop-1280.png`,
`project-*-phone-390.png`, and `project-long-title-phone-390.png` (a long project name truncates;
the audience line stays visible and opens the people).

## Visual review

A separate reviewer with a neutral brief (no code or rationale) judged the screenshots
**accept with minor fixes**: as calm as C and more discoverable than v8. Applied: the state line
leads with what needs you and keeps it whole; the cited source is a quiet chip like the other
references; the composer's source button is labelled "Sources" with its count; the desktop
keyboard hint was dropped. After peer review (#122): the feed opens on whole messages (never mid-message at the top),
and on touch each message's actions start as one 44 px overflow button beside the author instead
of a row under every message. Kept, with reasons: "Replying to" on the phone (the conversation title has scrolled away);
"· only you two" (the accepted wording for a pair). The Map count differs between desktop and
phone shots because the journey creates a second sketch between them.

Images do not prove interaction or accessibility; the Playwright journey covers tab switching,
each state segment, overview navigation, creating a project sketch and the phone.
