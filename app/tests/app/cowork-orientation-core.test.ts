import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { coWorkCheckpointProgress, normalizeCoWorkCheckpointDraft, parseCoWorkCheckpointProgress } from '@flux/core';

test('durable orientation preserves canonical checkpoints and visible gaps without changing old checkpoint shapes', () => {
  const original = { summary: 'Read the current plan.', nextAction: 'Compare its next revision.', blocker: null };
  assert.deepEqual(normalizeCoWorkCheckpointDraft(original), original);
  const draft = { ...original, orientation: { known: [{ kind: 'doc' as const, id: randomUUID(), version: 2 },
    { kind: 'conversation' as const, id: randomUUID(), sequence: 8 }], gaps: ['The linked repository is unavailable.'] } };
  const stored = coWorkCheckpointProgress(draft, []);
  assert.deepEqual(parseCoWorkCheckpointProgress(stored), stored);
  assert.deepEqual(parseCoWorkCheckpointProgress(coWorkCheckpointProgress(original, []))!.orientation, undefined);
  for (const orientation of [null, {}, { known: [], gaps: [], authority: 'all' },
    { known: [draft.orientation.known[0], draft.orientation.known[0]], gaps: [] },
    { known: [{ kind: 'doc', id: randomUUID(), version: 0 }], gaps: [] },
    { known: [], gaps: Array.from({ length: 11 }, () => 'missing') }, { known: [], gaps: [' '] }]) {
    assert.throws(() => normalizeCoWorkCheckpointDraft({ ...original, orientation }), { code: 'INVALID_INPUT' });
  }
  assert.equal(parseCoWorkCheckpointProgress({ ...stored, orientation: { known: [], gaps: [], prompt: 'read me' } }), null);
});
