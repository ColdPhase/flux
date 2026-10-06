# F-025 slice 4 (part): phone messages (PA-4) and composer (PA-7)

Branch `claude-maurycy/f025-phone-messages`, stacked on #332, contract
[people and AI on the phone](../../../design/people-and-ai.md) (#304). The phone header (PA-5) is not part of
this change. Screenshots come from `app/tests/ui/test_people_and_ai.py` (test_06, test_07) in Docker
(Chromium, 390×844 at 3× with touch), resized to 1000 px. Run results and counts are in the PR.

| File | What it shows |
| --- | --- |
| `people-ai-390-light-messages.png`, `people-ai-390-dark-messages.png` | The stream: own messages in the action colour, others' and the agent's in the bubble colour, radius 20, one name per run, the date line |
| `people-ai-390-light-composer.png`, `people-ai-390-dark-composer.png` | The composer as one pill with "+", the field and Send, and the audience line under it |
| `people-ai-390-light-composer-ask.png`, `people-ai-390-dark-composer-ask.png` | A thread with ask mode on: the assistant's violet orb pressed |
