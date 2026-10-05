# Independent review records — native work Details

These are scoped source/image reviews, not eligible whole-PR approval or final
product acceptance. The implementation owner ran the recorded native checks.

## Source

The independent typing_contract_review agent found three concrete source issues
at dd9ed63c862aa0ec03976a6cdd59dad7634e0b62: serialized-key A→B→A command
ownership, linked objects adopting another routed project, and source links
incorrectly promising a doc section/update/version. It closed all three at
2a79c7bcfbb91ef16527299f9438b8d90d6c1da9 after captured identity ownership,
explicit project IDs, and uniform native add-or-update wording.

At60b812647489f745154e955b1dd2fd9d6dc8a2d7 it reported no new production
issue but required both sides of viewport bounds in the geometry test. The
stronger native assertions found a 2px phone header mismatch. The reviewer
closed the corrected source/fixture at 7c0fba2f5079619021c8b6dcd3a2f8216993f008:
the bounded work-choice scrollport ends before its normal-flow acceptance
footer; all element edges are checked against the actual panel body; sheet
sticky positioning uses the sheet’s 18px padding. It ran no tests and explicitly
limited this result to source agreement. Visibility checks apply after bringing
the acceptance area into view.

## Neutral visual review

A fresh details_visual reviewer received only the shared review/design guide,
neutral maker job brief, current Studio 11.6 actual reference PNGs, six renders,
CSS viewport/DPR/zoom and source pin. It did not inspect code/history/author
rationale. Desktop 1500×900/DPR1 and phone 412×915/DPR3 used 100%zoom.

Initial e23f2f887470baecb2d4de290c46e00261fb2674 review found absent pivot
acceptance while reviewing 50 choices, a clipped single-line Finding, and lost
proposal identity during scrolling. The first correction at 60b812647489f745154e955b1dd2fd9d6dc8a2d7
closed these but revealed phone work controls peeking below the sticky acceptance
footer, detached from their title. Earlier exact reviewed images are saved with
initial-/first-layout- prefixes and hashes in environment.json.

Final second correction round at 7c0fba2f5079619021c8b6dcd3a2f8216993f008
closed that concern: the choice scrollport and acceptance area have separate
boundaries, and controls do not reappear below the action. The reviewer identified
no remaining material visible issue across all six supplied images. It recommended
preserving quiet separators, compact proposal identity, primary actions and audience.

| Final supplied image | SHA-256 |
| --- | --- |
| bounded-details-work-desktop.png | `14ccf88884401297a9701e295a89da19e5477585152649a9c0de8693d50c8f9b` |
| bounded-details-work-phone.png | `00929fb0cf5f11b6738f9e5c2590a089fd98eb5efeb29109f287e071f88075c8` |
| bounded-details-result-desktop.png | `65fb0a1889d18f3cdbd507bf908649b66067fee1d6f954c14dbe8450fbf0579b` |
| bounded-details-result-phone.png | `4e8d1337f8ccdb3cb86647d9178df84261c3738a56400a1fcad8e67e91c8db33` |
| bounded-details-pivot-desktop.png | `b2103319bdd7235248c684290a83a91ebc7b97b118404de2eb38ef77d2c93fa3` |
| bounded-details-pivot-phone.png | `7d9bbb779c261b137fed9eecf3c91db997138b3246e3ae8c340ad3ea9d872b11` |

Limits: pivot captures are choice-reading states after bringing acceptance into
view. Images do not establish initial discoverability at other positions, keyboard
or virtual-keyboard operation, pagination persistence, error behavior, accessibility,
motion, responsive transitions or physical device delivery. Functional evidence is
separate; no whole-task acceptance is inferred from images.
