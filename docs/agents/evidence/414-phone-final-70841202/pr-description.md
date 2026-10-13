# Phone project shell (#414)

This PR implements the phone shell slice of #341 on the current `main` base. It is a partial contribution; #341 remains open for the remaining phone acceptance work.

## Implemented in this slice

- A floating Home / Projects / Inbox capsule and round Search button; direct messages remain in Projects.
- A single floating Create action and its sheet, including selected-project text creation and persistence.
- A project-title menu for Conversation, Tasks, Map, Wiki, Agents, and Details, goal and people. “What matters” remains reachable from Details.
- Full-screen phone conversations without the bottom capsule; Back returns to the prior location.
- Phone-sized layout and touch-target checks at 320×568 and 390×844, in light and dark themes.

The desktop header breakpoint change is included. The current project shell and phone conversation/question surfaces are exercised by the selected browser journeys.

## Explicitly partial / remaining work

- Create acceptance remains partial; this PR does not claim every F-026 create path is complete.
- Phone Tasks toolbar conformance is not complete here. Current-main Task controls remain outside this PR’s source changes. #375 owns the AC-4 Tasks-screen toolbar work (current candidate `5305fd498f920a89516e866830c724961c1bc8f3`); the integrated phone Tasks surface must be rechecked after that change.
- #341 remains open for all other uncompleted acceptance criteria. This PR does not claim the entire phone experience is complete.

## Verification at the current head

Head: `7084120254f35c44ca542b29941aee873abe1938`.

- Chromium: 14/15 selected journeys passed at `46f635e9`; production source is unchanged at `70841202`. The only failure was a stale PhoneFinal09 heading expectation after `/tasks` became Home with an empty-state heading. Corrected test passed 1/1 at `70841202`.
- WebKit at `70841202`: the same 15 selected journeys passed 15/15.
- Required GitHub checks at `70841202`: Agent setup and Application validation passed.
- Fresh visual review covers the captured shell, Create, menu, conversation, question, Stop, opened project Details, and returning-user Home surfaces. The added exact-head frames and independent follow-up verdict are in the evidence packet; the phone Tasks toolbar remains pending #375.

No merge or completion of parent issue #341 is claimed by this description.
