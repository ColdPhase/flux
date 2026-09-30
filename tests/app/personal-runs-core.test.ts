import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { costMicros, parseOutput, type SuppliedSource } from '@flux/core';

// Pure output and cost rules of personal runs (#68, O-008 §3/§5). No database, no provider.

const workId = randomUUID();
const sources: SuppliedSource[] = [
  { label: 'S1', ref: { type: 'message', id: randomUUID(), revision: 1 }, text: 'Message 1' },
  { label: 'S2', ref: { type: 'work', id: workId, revision: 3 }, text: 'Open work item' },
];

describe('personal run output rules', () => {
  test('citations count only for supplied sources', () => {
    const parsed = parseOutput('Fact: A [S1]. Fact: B [S9]. Fact: C [S1].', sources, true);
    assert.deepEqual(parsed.sources, [sources[0]!.ref]);
    assert.equal(parsed.proposal, null);
  });

  test('a proposal may finish only a supplied work item and is dropped when malformed', () => {
    const block = (value: unknown) => `Answer [S2]\n<proposal>${JSON.stringify(value)}</proposal>`;
    const valid = { fact: 'f', interpretation: 'i', title: 'Result', finding: 'negative', evidence: 'e', finishes: 'S2' };
    const parsed = parseOutput(block(valid), sources, true);
    assert.equal(parsed.body, 'Answer [S2]');
    assert.deepEqual(parsed.proposal, { fact: 'f', interpretation: 'i', title: 'Result', finding: 'negative', evidence: 'e', finishesWorkId: workId });
    assert.equal(parseOutput(block({ ...valid, finishes: 'S1' }), sources, true).proposal, null, 'a message is not a work item');
    assert.equal(parseOutput(block({ ...valid, finishes: 'S7' }), sources, true).proposal, null, 'an unsupplied label');
    assert.equal(parseOutput(block({ ...valid, finding: 'maybe' }), sources, true).proposal, null);
    assert.equal(parseOutput('x <proposal>{not json</proposal>', sources, true).proposal, null);
    assert.equal(parseOutput(block(valid), sources, false).proposal, null, 'a truncated answer never proposes');
  });

  test('cost uses the O-008 rate and the nominal maximum stays under the default reservation', () => {
    assert.equal(costMicros({ inputTokens: 16_000, outputTokens: 1_500 }), 47_000);
    assert.ok(costMicros({ inputTokens: 16_000, outputTokens: 1_500 }) < 60_000);
  });
});
