import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolveAsked, takeAsk, type Askable } from '@flux/core';

// One agent asks another in a task (#841, TA-3). Flux lists the agents a run may ask as "Asystent (Dariusz's agent)" (`askableLines`), and a
// real model on pi (Qwen3.8-27B, scripts/check_ai_real_model.sh, 2026-11-20) wrote that label back as the block's agent: Flux answered "I can't
// ask Asystent (Dariusz's agent) (Dariusz's agent): they are not in this task" and gave the task back, though Dariusz's agent was in it.

const people: Askable[] = [
  { id: 'a1', name: 'Asystent', ownerId: 'u1', ownerName: 'Celina Zielińska' },
  { id: 'a2', name: 'Asystent', ownerId: 'u2', ownerName: 'Dariusz Kamiński' },
];
const asked = (block: string) => takeAsk(`Pytam agenta Dariusza.\n<ask>${block}</ask>`).ask;
const found = (block: string) => { const ask = asked(block); return ask ? resolveAsked(ask, people) : null; };

describe('an <ask> block names the agent as Flux listed it', () => {
  test('the listed label, with or without the owner field, is that owner\'s agent', () => {
    for (const block of [
      '{"agent": "Asystent (Dariusz\'s agent)", "owner": "Dariusz", "question": "Jaki termin płatności?"}',
      '{"agent": "Asystent (Dariusz\'s agent)", "question": "Jaki termin płatności?"}',
      '{"agent": "Asystent (Dariusz Kamiński\'s agent)", "owner": "Dariusz Kamiński", "question": "Jaki termin płatności?"}',
    ]) {
      assert.deepEqual(asked(block), { agent: 'Asystent', owner: block.includes('"owner": "Dariusz Kamiński"') ? 'Dariusz Kamiński' : 'Dariusz', question: 'Jaki termin płatności?' }, block);
      assert.deepEqual(found(block), { found: people[1] }, block);
    }
  });

  test('the plain name and owner still work, and a label that disagrees with the owner field is not guessed', () => {
    assert.deepEqual(found('{"agent": "Asystent", "owner": "Dariusz", "question": "Jaki termin?"}'), { found: people[1] });
    assert.deepEqual(asked('{"agent": "Asystent (Dariusz\'s agent)", "owner": "Celina", "question": "Jaki termin?"}'),
      { agent: 'Asystent (Dariusz\'s agent)', owner: 'Celina', question: 'Jaki termin?' }, 'kept as written');
    assert.deepEqual(found('{"agent": "Asystent (Dariusz\'s agent)", "owner": "Celina", "question": "Jaki termin?"}'), { none: true });
    assert.deepEqual(found('{"agent": "Asystent", "question": "Jaki termin?"}'), { ambiguous: people }, 'two of that name and no owner: never a guess');
    assert.equal(asked('{"agent": " (Dariusz\'s agent)", "question": "Jaki termin?"}')?.agent, '(Dariusz\'s agent)', 'no name before the owner: not a label');
  });
});
