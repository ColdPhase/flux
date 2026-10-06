# Owner standing-grant controls on the Connect page (#152, T152-a)

Tested code: `5782b72e` (tree `130f324839646c03f066c08874f2922622b94641`), branch
`claude-maurycy/152-grant-controls`, based on protected main `fdb70955`. This commit
adds only this evidence. Owner of the slice: Zamojski5, taking over from PelikanFix16.
Independent evaluation is still required. #152 stays open: real Codex and Claude Code
clients (AC-4/AC-5) are outside this slice.

## What changed

- **API:** `PATCH /api/v1/agent-connections/:id/action-grants/:grantId` narrows a live
  grant in place. This is a proposed amendment dated 2026-10-05; see
  [the contract](../../../development/agent-connection.md#narrowing--proposed-amendment-2026-10-05-peer-review-required).
  Create, list and revoke are unchanged. MCP tool names and schemas are unchanged.
- **UI:** `/connect-agent` shows each of your connections' standing grants by project.
  From there you can add (within the connection's ceiling), narrow and revoke them,
  and see ended grants. The UI code is in
  `app/apps/web/src/agent-connection/StandingGrants.tsx`.
- **Tests:**
  - `app/tests/app/agent-grant-controls.test.ts`: six API tests over a real OAuth bearer and MCP tools.
  - `app/tests/app/e2e/agent-grant-controls.e2e.ts`: a Chromium journey that ends in real MCP calls; it is added to `check_application.sh`.
  - `app/tests/ui/test_grant_controls.py`: four UI tests at desktop 1440 and phone 390.

## Targeted runs (Docker)

| Run | Code | Result |
| --- | --- | --- |
| API, `tests/app/agent-grant-controls.test.ts` | `315f1e1e`; server and API test unchanged since then | 6/6 pass |
| e2e, `tests/app/e2e/agent-grant-controls.e2e.ts` | `5782b72e` | 1/1 pass |
| UI, `check_ui.sh test_grant_controls test_app_shell` | `5782b72e` | 24/24 OK |

## Negative controls

Each patch in [negative-controls/](negative-controls/) removes guards in a scratch
copy. The tests named below then fail, and the rest still pass.

| Patch | Guards removed | Failing tests (observed) |
| --- | --- | --- |
| `negA.patch` | Action-scope ceiling on create (G1); narrow-only comparison (G3); owner filter on list, narrow and revoke (G4); expiry and revocation at execution in prepare, recheck and debit (G5+G6) | narrowing only narrows: `{"maximumUses":6}` returned 200. Expiry: the call after the end succeeded. Revocation: the call after revoke succeeded. Another member: GET returned 200. Ceiling: a read-only connection's grant returned 201. 5 fail, 1 pass |
| `negB.patch` | Operation-class ceiling (G2); live use limit in recheck and debit (G7); owner filter on the connection list (G8) | Narrowing applies: the next call failed with `MCP_TOOL_UNAVAILABLE`, a database CHECK, not a clean refusal. Narrowing only narrows: same. Another member: the owner's connection was listed. Ceiling: a review class returned 201. 4 fail, 2 pass |
| `negU1.patch` | Page shows no grant form for a read-and-suggest connection | `test_02` fails ("This connection can read and suggest only." missing); `test_04` errors on the missing grants |
| `negU2.patch` | Add form offers only the changes the class allows | `test_02` fails ("Record results" offered for Planning); `test_04` errors on the missing grants |

`negA`/`negB` ran at `315f1e1e`. `negU1`/`negU2` first ran at `73e7609a`, before the
visual polish, and are rerun at the evidence head (see the hand-off).

## Screenshots

- Desktop 1440:
  - `grant-add-desktop.png`
  - `grant-revoke-desktop.png`
  - `grant-list-desktop.png`
  - `grant-other-member-desktop.png`
- Phone 390:
  - `grant-add-phone.png`
  - `grant-list-phone.png`
  - `grant-other-member-phone.png`
- From the e2e: `grant-controls-granted-desktop.png`, `grant-controls-ended-desktop.png`
  and `grant-controls-ended-phone.png`.

An independent visual review read the first set with a neutral brief and
returned "acceptable with fixes". Its must-fix items are in `5782b72e`:
- the panel names its connection and sits under the card;
- ended grants are grouped apart, and the panel says "None active" when every grant has ended;
- add and save are clear actions;
- the revoke question is not red.

Not done: collapsing the change categories and plainer labels. Screenshots do not
prove interaction or isolation; the tests above do.
