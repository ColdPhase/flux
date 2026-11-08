import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { tablePrice } from '@flux/contracts';
import { costMicros, parseOutput, runReservationMicros, withoutCitationMarks, type SuppliedSource } from '@flux/core';

// Pure output and cost rules of personal runs (#68, O-008 §3/§5). No database, no provider.

const workId = randomUUID();
const sources: Pick<SuppliedSource, 'label' | 'ref'>[] = [
  { label: 'S1', ref: { type: 'message', id: randomUUID(), revision: 1 } },
  { label: 'S2', ref: { type: 'work', id: workId, revision: 3 } },
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
    assert.equal(costMicros({ inputTokens: 32_000, outputTokens: 4_000 }, sonnet), 104_000);
    assert.equal(runReservationMicros(sonnet), 104_000, 'max input × input price + max output × output price');
    // Rounded up, never down; a provider-reported cost replaces the token estimate when present.
    assert.equal(costMicros({ inputTokens: 1, outputTokens: 0 }, { inputMicrosPerMTok: 400_000, outputMicrosPerMTok: 1_600_000 }), 1);
    assert.equal(costMicros({ inputTokens: 1_000, outputTokens: 100, reportedCostMicros: 7 }, sonnet), 7);
    assert.equal(costMicros({ inputTokens: 1_000, outputTokens: 100, reportedCostMicros: null }, sonnet), 3_000);
    // A self-hosted endpoint may cost nothing; an unknown price cannot reserve anything.
    assert.equal(runReservationMicros({ inputMicrosPerMTok: 0, outputMicrosPerMTok: 0 }), 0);
    assert.equal(runReservationMicros(null), null);
  });

  test('Show everyone takes out the marks of the sources the answer has and nothing else: not a mark of a source it lacks, not code (#842)', () => {
    assert.equal(withoutCitationMarks('Fact: it fails below 5 lux [1] and recovers at 20 lux [2].', 2), 'Fact: it fails below 5 lux and recovers at 20 lux.');
    assert.equal(withoutCitationMarks('Fact: read `items[0]` and items[1] first [1], then the list [3].', 1), 'Fact: read `items[0]` and items[1] first, then the list [3].');
    assert.equal(withoutCitationMarks('Fact: see\n```\nrows [1]\n```\nfor the table [1].', 1), 'Fact: see\n```\nrows [1]\n```\nfor the table.');
    assert.equal(withoutCitationMarks('[1]', 1), '[1]', 'an answer that is only a mark is kept whole');
    // A mark right after text, or at the start of a line, goes too, and the line break stays.
    assert.equal(withoutCitationMarks('Fact: the beds use LoRa.[1] Then Wi-Fi drops;[2] and more.\n[1] Next line.', 2), 'Fact: the beds use LoRa. Then Wi-Fi drops; and more.\nNext line.');
    const parsed = parseOutput('Fact: the beds use LoRa.\n[S1] And the hedge is wet [S1].', sources.slice(0, 1), false);
    assert.equal(parsed.body, 'Fact: the beds use LoRa.\n[1] And the hedge is wet [1].', 'the line break before a mark at the start of a line is kept');
    assert.equal(withoutCitationMarks(parsed.body, 1), 'Fact: the beds use LoRa.\nAnd the hedge is wet.');
  });
});
