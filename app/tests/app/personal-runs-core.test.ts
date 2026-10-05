import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { tablePrice } from '@flux/contracts';
import { costMicros, parseOutput, runReservationMicros, type SuppliedSource } from '@flux/core';

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
    assert.equal(parsed.body, 'Fact: A [1]. Fact: B. Fact: C [1].', 'renumbered for the reader; an unsupplied label is removed');
    const both = parseOutput('Work [S2] then talk [S1] and work again [S2].', sources, true);
    assert.deepEqual(both.sources, [sources[1]!.ref, sources[0]!.ref]);
    assert.equal(both.body, 'Work [1] then talk [2] and work again [1].');
  });

  test('a proposal may finish only a supplied work item and is dropped when malformed', () => {
    const block = (value: unknown) => `Answer [S2]\n<proposal>${JSON.stringify(value)}</proposal>`;
    const valid = { fact: 'f', interpretation: 'i', title: 'Result', finding: 'negative', evidence: 'e', finishes: 'S2' };
    const parsed = parseOutput(block(valid), sources, true);
    assert.equal(parsed.body, 'Answer [1]');
    assert.deepEqual(parsed.proposal, { fact: 'f', interpretation: 'i', title: 'Result', finding: 'negative', evidence: 'e', finishesWorkId: workId });
    assert.equal(parseOutput(block({ ...valid, finishes: 'S1' }), sources, true).proposal, null, 'a message is not a work item');
    assert.equal(parseOutput(block({ ...valid, finishes: 'S7' }), sources, true).proposal, null, 'an unsupplied label');
    assert.equal(parseOutput(block({ ...valid, finding: 'maybe' }), sources, true).proposal, null);
    assert.equal(parseOutput('x <proposal>{not json</proposal>', sources, true).proposal, null);
    assert.equal(parseOutput(block(valid), sources, false).proposal, null, 'a truncated answer never proposes');
  });

  test('cost uses the connection price, and a run reserves its largest request (F-020 PROV-3)', () => {
    const sonnet = tablePrice('anthropic', 'claude-sonnet-5')!;
    assert.deepEqual([sonnet.inputMicrosPerMTok, sonnet.outputMicrosPerMTok, sonnet.checkedOn], [2_000_000, 10_000_000, '2026-10-02']);
    assert.equal(costMicros({ inputTokens: 16_000, outputTokens: 1_500 }, sonnet), 47_000);
    assert.equal(runReservationMicros(sonnet), 47_000, 'max input × input price + max output × output price');
    assert.ok(runReservationMicros(sonnet)! < 60_000, 'it fits the default $0.06 per-run ceiling');
    // Rounded up, never down; a provider-reported cost replaces the token estimate when present.
    assert.equal(costMicros({ inputTokens: 1, outputTokens: 0 }, { inputMicrosPerMTok: 400_000, outputMicrosPerMTok: 1_600_000 }), 1);
    assert.equal(costMicros({ inputTokens: 1_000, outputTokens: 100, reportedCostMicros: 7 }, sonnet), 7);
    assert.equal(costMicros({ inputTokens: 1_000, outputTokens: 100, reportedCostMicros: null }, sonnet), 3_000);
    // A self-hosted endpoint may cost nothing; an unknown price cannot reserve anything.
    assert.equal(runReservationMicros({ inputMicrosPerMTok: 0, outputMicrosPerMTok: 0 }), 0);
    assert.equal(runReservationMicros(null), null);
  });
});
