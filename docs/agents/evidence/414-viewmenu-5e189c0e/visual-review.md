# Independent visual review — PR #414 project view menu

**Result: scoped visual pass; no blocking visual finding.** This is an appearance-only judgment against the neutral brief, on source head `5e189c0efc26735a538f41dd54896fb231573062`. The reviewer inspected all four supplied captures at 320×568 and 390×844, light and dark. Reviewer: independent fresh-context Luna evaluator, not the capture operator.

The project title and open Tasks row are easy to locate. Conversation, Tasks, Map, Wiki, Agents, and Details are distinct and readable in all captures. At 320 px the underlying header title truncates, but the open menu repeats the full project name. The dimmed task surface and dark-theme selected-row/divider separation read clearly.

## Nonblocking observations against F-026

The menu repeats the project name, has no goal line, and has no summary beside Map, Wiki, or Agents; Tasks shows “2 open.” The accepted [`phone-viewsmenu.webp`](../../../design/final/screens/phone-viewsmenu.webp) shows a goal under the title and short per-view summaries. These differences reduce project/destination context but did not make the requested destinations hard to find or understand in this scoped task. Literal example strings/counts in the reference are not requirements by themselves.

The menu also has a “What matters” row after Details, absent from the reference. The reviewer classifies it as a **nonblocking reference deviation**: visually separated from navigation, with no demonstrated clarity problem. The image alone says nothing about its behavior.

This pass does not establish full F-026 implementation. #341 AC-3 explicitly specifies the destinations/order and excludes Decisions/chips; it does not state the goal or view summaries. The visible goal/summaries remain a design-alignment gap to disposition against the task’s scope. This report does not turn that gap into a blocking finding. Likewise the separate “What matters” deviation requires evaluator disposition under the existing #336 record.

## Evidence limits

Screenshots do not establish tap behavior, target size, keyboard access, accessibility, or responsive transitions. The open menu obscures most task content, so the captures do not judge the underlying task surface. The 44 px title-target defect closure is supported by the exact-head browser assertions, not by this visual review. Functional and accessibility acceptance remains separate.

See [neutral brief](neutral-visual-brief.md), [capture manifest](manifest.json), and the four images below. References: F-026 `phone-viewsmenu.webp` and `phone-projects.webp`.

- 390×844 light: [screenshot](screenshots/341-viewsmenu-390-light.webp)
- 390×844 dark: [screenshot](screenshots/341-viewsmenu-390-dark.webp)
- 320×568 light: [screenshot](screenshots/341-viewsmenu-320-light.webp)
- 320×568 dark: [screenshot](screenshots/341-viewsmenu-320-dark.webp)
