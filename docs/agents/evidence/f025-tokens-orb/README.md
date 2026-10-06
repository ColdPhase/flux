# F-025 slices 1 and 2: phone tokens (PA-1) and the agent orb (PA-2)

Branch `claude-maurycy/f025-phone-tokens-orb`, contract [people and AI on the phone](../../../design/people-and-ai.md)
(#304). Screenshots come from `app/tests/ui/test_people_and_ai.py` in Docker (Chromium, 390×844 at 3× with touch,
and 1440×900), resized to 1000 px. Run results and counts are in the PR.

| File | What it shows |
| --- | --- |
| `people-ai-390-light-stream.png`, `people-ai-390-dark-stream.png` | The project conversation on a phone: monochrome chrome, people without orbs, the agent's root with its orb, name and AI badge |
| `people-ai-390-light-thread.png`, `people-ai-390-dark-thread.png` | A thread: a person's reply, the agent's reply, the assistant's answer with the violet orb |
| `people-ai-390-light-agents.png`, `people-ai-390-dark-agents.png` | Agents: each connection row with its agent's orb, and the task thread |
| `people-ai-1440-light-stream.png` | Desktop unchanged: Mint accent, no orbs, agents named "Claude Code · agent" |
