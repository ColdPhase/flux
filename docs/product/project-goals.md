# F-028: a project's optional goal

**Founder direction, 2026-10-16** (Hubert, [@PelikanFix16](https://github.com/PelikanFix16)), in
[#520](https://github.com/ColdPhase/flux/issues/520#issuecomment-6209595827), on the coordinator's
research and proposal of the same day (option B of four). Implemented in #520.

## Why

Prostota draws a goal in three places: the "Details, goal and people" row of the phone view menu,
the goal sentence under the project name in that menu, and the "goal reached" card with
**Keep going** (`phone-goal`). Foundation §8.8 asks that a returning person sees the current goal,
and §8.5 says that a finished model call or a merged PR does not decide that a goal is reached. The
earlier attempt in PR #545 inferred "goal reached" from finished tasks. Its review rejected that,
because a project whose only task was not pursued showed "goal reached".

## Rules

- **G-1 Optional, one current goal.** A project has zero or one current goal: one plain sentence
  of 1–120 characters on one line, trimmed. It has no date field ("by spring" stays in the words),
  no progress bar and no owner. Templates and the new-project step do not ask for one (S20).
- **G-2 Shared.** The goal belongs to the project, not to a person. Everyone who can read the
  project sees the same goal. Only whether this device has seen the reached card is stored per
  device (`flux.goal.<id>`).
- **G-3 Reached only when a person says so.** A person who can write in the project (a
  contributor or a manager, as for accepting a decision under O-009) sets, edits or removes the
  current goal and marks it reached. Viewers get 403. Agents read the goal and never change it, in
  the API and over MCP, including with a contributor grant (403 `GOAL_NEEDS_PERSON`). Closing
  every task, merging a PR, a result or an agent's message never changes goal state.
- **G-4 Who and when, and Undo.** Details shows who set the goal or marked it reached, and when.
  "Undo goal reached" reopens the latest reached goal while no other goal is current. Removing a
  current goal offers Undo in its toast.
- **G-5 The project goes on.** Reaching a goal changes nothing else about the project: no status,
  archive or read-only state. People can set the next goal or leave it empty. Reached goals stay as
  history.
- **G-6 Nothing without a goal.** A project without a goal looks exactly as before: no empty
  field, no prompt and no extra line in Details, the view menu, the conversation or the lists.
  People who can write find "Set a goal" in the Details "⋯" (Spokój rule 4).
- **G-7 No notifications.** No goal change creates a notification, an Inbox item, a badge or a
  push. People in the conversation see the change live; others see it when they return.

## Where it appears

| Place | With a current goal | After it is reached | Without a goal |
| --- | --- | --- | --- |
| Details (Spokój A07) | One quiet line under the name and people: "Goal", the sentence, "Set by … · date". The "⋯" beside the name offers Edit goal, Mark goal reached and Remove goal | "Goal reached", the sentence, "… · date" until a new goal is set. The "⋯" offers Set a new goal and Undo goal reached | Nothing. The "⋯" offers Set a goal to writers |
| Phone view menu (`phone-viewsmenu`) | The sentence under the project name | Name only | Name only |
| Conversation | Nothing | The card once per goal and device (below), then one quiet line: "Goal reached · … · who · time" | Nothing |
| Home, Inbox, notifications, sidebar, new project | Nothing | Nothing | Nothing |

This one Details line is the only addition to Spokój A07. The founder approved it together with the
goal itself; Prostota already names the row "Details, goal and people".

**The reached card** (`phone-goal`) sits in the stream at the moment the goal was reached. It shows
Kreska `celebrate`, the goal, "<project> · goal reached", **Write a wrap-up** (writers only: a new
Wiki page draft titled "Wrap-up: <goal>", through the ordinary new-page editor, with no AI text) and
**Keep going** (folds the card into the quiet line). It shows only for a goal reached within the last
7 days that this device has not seen, and it counts as seen once it is on screen. With Small moments
off it shows the same words with no face; under reduced motion it is a static frame. It never covers
content. No confetti.

## Data and contract

- Table `project_goals` (migration 0099; 0098 is #530's): `id`, `workspace_id`, `project_id`, `title`, `set_by`,
  `set_at`, `reached_at`, `reached_by`. At most one row with `reached_at IS NULL` per project.
- `Project.goal` (`@flux/contracts`): the current goal, or the most recently reached one while no
  goal is current; `null` for a project that never had one.
- `PUT /api/v1/projects/:id/goal` `{ title }` sets the current goal, or edits its title with the
  same id. `DELETE …/goal` removes the current, unreached goal. `POST …/goal/reached` marks it
  reached. `DELETE …/goal/reached` reopens the latest reached goal. Each change needs `If-Match` with
  the project's version, moves that version on, accepts `Idempotency-Key` and answers
  `{ projectId, version, goal }`. `GET …/goals` lists the current and reached goals, newest first.
- Events `project.goal_set.v1`, `project.goal_removed.v1`, `project.goal_reached.v1` and
  `project.goal_reopened.v1` carry only `{ goalId }`.
- MCP `flux_list_contexts` returns each project's `goal` (`{ title, reachedAt }` or `null`). No MCP
  tool writes a goal.

## Not part of this decision

Milestones, dates, progress bars, personal goals, a goal field in templates, and project archiving.
Possible follow-ups: the goal as the subtitle of a quiet project in the phone Projects list
(`phone-projects`), the goal in the MCP bootstrap and orientation (F-018), and the goal in the
project export (EXT-2).

**Revisit when** people ask for more than one goal at a time, or the goal needs a date.
