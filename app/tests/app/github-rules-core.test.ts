import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  defaultGithubRuleMode, evaluateGithubRule, githubRuleBlocker, manuallyChanged, presentGithubRule,
  type GithubRuleOutcome, type GithubRulePull, type GithubRuleRecord, type GithubRuleTask,
} from '@flux/core';

// "Let linked PRs move this task" (#74 G-1a): the deterministic rule as a pure function of the current task, the
// rule's state and the current facts of the required PR links. No delivery payload, clock or model is an input.

const SHA = 'a'.repeat(40);
const rule = (over: Partial<GithubRuleRecord> = {}): GithubRuleRecord => ({
  taskId: 't', workspaceId: 'w', projectId: 'p', mode: 'complete', state: 'active', suspendedReason: null, authorUserId: 'ada',
  authorGithubUserId: '1', authorGeneration: 'g', appId: '9', expectedVersion: 1, expectedStatus: 'open', expectedBlocker: null,
  blockedBy: null, readyToClose: false, updatedAt: new Date('2026-10-05T10:00:00Z'), ...over,
});
const task = (over: Partial<GithubRuleTask> = {}): GithubRuleTask =>
  ({ status: 'open', blocker: null, parked: false, version: 1, criteria: [], prerequisitesMet: true, ...over });
const pull = (number: number, over: Partial<GithubRulePull> = {}): GithubRulePull => ({
  linkId: `link-${number}`, number, available: true, state: 'open', merged: false, headSha: SHA,
  checks: [{ name: 'ci', state: 'success' }], truncated: false, ...over,
});
const failing = (number: number) => pull(number, { checks: [{ name: 'ci', state: 'success' }, { name: 'firmware / test', state: 'failure' }] });
const merged = (number: number) => pull(number, { state: 'closed', merged: true });
function effect(outcome: GithubRuleOutcome) {
  assert.equal(outcome.kind, 'apply', JSON.stringify(outcome));
  return (outcome as Extract<GithubRuleOutcome, { kind: 'apply' }>).effect;
}

describe('GitHub task rule evaluation (#74 G-1a)', () => {
  test('an open or draft required PR starts open work; an unchanged state changes nothing', () => {
    const started = effect(evaluateGithubRule(rule(), task(), [pull(42)]));
    assert.deepEqual([started.code, started.status, started.blocker, started.pull?.number], ['pull_open', 'in_progress', null, 42]);
    assert.equal(effect(evaluateGithubRule(rule(), task(), [pull(42, { checks: [] })])).status, 'in_progress', 'a draft without checks starts it too');
    const again = evaluateGithubRule(rule({ expectedStatus: 'in_progress', expectedVersion: 2 }), task({ status: 'in_progress', version: 2 }), [pull(42)]);
    assert.deepEqual(again, { kind: 'none', repin: false }, 'duplicate or late deliveries re-read the same facts and do nothing');
  });

  test('a failing check on the current head blocks with a sourced reason; it clears only when every check passes again', () => {
    const blocked = effect(evaluateGithubRule(rule({ expectedStatus: 'in_progress' }), task({ status: 'in_progress' }), [failing(42)]));
    assert.deepEqual([blocked.code, blocked.status, blocked.blocker, blocked.blockedBy, blocked.checkName],
      ['check_failed', 'blocked', 'Check “firmware / test” failed on PR #42', 'check', 'firmware / test']);
    const owned = rule({ expectedStatus: 'blocked', expectedBlocker: blocked.blocker, blockedBy: 'check', expectedVersion: 2 });
    const now = task({ status: 'blocked', blocker: blocked.blocker, version: 2 });
    assert.equal(evaluateGithubRule(owned, now, [pull(42, { checks: [{ name: 'firmware / test', state: 'pending' }] })]).kind, 'none', 'a re-run in progress keeps it blocked');
    assert.equal(evaluateGithubRule(owned, now, [pull(42, { checks: [], headSha: 'b'.repeat(40) })]).kind, 'none', 'a new head without checks yet keeps it blocked');
    assert.equal(evaluateGithubRule(owned, now, [pull(42, { truncated: true })]).kind, 'none', 'a truncated check list never counts as passing');
    const cleared = effect(evaluateGithubRule(owned, now, [pull(42, { checks: [{ name: 'firmware / test', state: 'success' }, { name: 'lint', state: 'neutral' }] })]));
    assert.deepEqual([cleared.code, cleared.status, cleared.blocker, cleared.blockedBy], ['checks_passed', 'in_progress', null, null]);
    assert.equal(githubRuleBlocker('check_failed', 7, 'x'.repeat(500)).length < 260, true, 'a long check name is clipped');
  });

  test('never clears a blocker a person wrote, and never blocks over one', () => {
    const human = task({ status: 'blocked', blocker: 'Waiting for the enclosure', version: 3 });
    const pinned = rule({ expectedStatus: 'blocked', expectedBlocker: 'Waiting for the enclosure', expectedVersion: 3 });
    assert.deepEqual(evaluateGithubRule(pinned, human, [pull(42)]), { kind: 'none', repin: false });
    assert.deepEqual(evaluateGithubRule(pinned, human, [failing(42)]), { kind: 'none', repin: false });
    const ready = effect(evaluateGithubRule(pinned, human, [merged(42)]));
    assert.deepEqual([ready.code, ready.status, ready.blocker, ready.readyToClose], ['merged_ready', 'blocked', 'Waiting for the enclosure', true], 'merge only offers Ready to close');
  });

  test('every required PR must be merged; complete mode finishes only without written criteria and with prerequisites met', () => {
    const two = [merged(41), pull(42)];
    assert.equal(effect(evaluateGithubRule(rule(), task(), two)).status, 'in_progress', 'one merged of two only starts it');
    const done = effect(evaluateGithubRule(rule({ expectedStatus: 'in_progress' }), task({ status: 'in_progress' }), [merged(41), merged(42)]));
    assert.deepEqual([done.code, done.status, done.readyToClose, done.pull?.number], ['merged_done', 'done', false, 42]);
    const criteria = effect(evaluateGithubRule(rule({ expectedStatus: 'in_progress' }), task({ status: 'in_progress', criteria: ['Works at 5 lux'] }), [merged(42)]));
    assert.deepEqual([criteria.code, criteria.status, criteria.readyToClose], ['merged_ready', 'in_progress', true], 'written criteria are never checked off by a merge');
    const ready = effect(evaluateGithubRule(rule({ mode: 'ready', expectedStatus: 'in_progress' }), task({ status: 'in_progress' }), [merged(42)]));
    assert.deepEqual([ready.code, ready.status, ready.readyToClose], ['merged_ready', 'in_progress', true]);
    assert.deepEqual(evaluateGithubRule(rule(), task({ prerequisitesMet: false }), [merged(42)]), { kind: 'none', repin: false },
      'unmet prerequisites keep it from starting or finishing, and Ready to close is not offered where Done would fail');
    const reopened = evaluateGithubRule(rule({ expectedStatus: 'in_progress', readyToClose: true }), task({ status: 'in_progress', prerequisitesMet: false }), [merged(42)]);
    assert.deepEqual([effect(reopened).code, effect(reopened).readyToClose, effect(reopened).status], ['merged_ready', false, 'in_progress'], 'a prerequisite reopened later withdraws it');
    assert.deepEqual(evaluateGithubRule(rule(), task({ prerequisitesMet: false }), [pull(42)]), { kind: 'none', repin: false });
    assert.equal(defaultGithubRuleMode([]), 'complete'); assert.equal(defaultGithubRuleMode(['A criterion']), 'ready');
  });

  test('merged alone never finishes: Complete needs current verified checks on every merged head', () => {
    const inProgress = { expectedStatus: 'in_progress' as const };
    const failed = effect(evaluateGithubRule(rule(inProgress), task({ status: 'in_progress' }), [merged(41), pull(42, { state: 'closed', merged: true, checks: [{ name: 'ci', state: 'failure' }] })]));
    assert.deepEqual([failed.code, failed.status, failed.readyToClose], ['merged_ready', 'in_progress', true], 'a failed check on a merged head only offers Ready to close');
    for (const checks of [[], [{ name: 'ci', state: 'pending' as const }], [{ name: 'lint', state: 'neutral' as const }]])
      assert.equal(effect(evaluateGithubRule(rule(inProgress), task({ status: 'in_progress' }), [pull(42, { state: 'closed', merged: true, checks })])).code, 'merged_ready',
        `checks ${JSON.stringify(checks)} are not verified`);
    assert.equal(effect(evaluateGithubRule(rule(inProgress), task({ status: 'in_progress' }), [pull(42, { state: 'closed', merged: true, truncated: true })])).code, 'merged_ready');
    assert.equal(effect(evaluateGithubRule(rule(inProgress), task({ status: 'in_progress' }), [merged(42)])).code, 'merged_done');
  });

  test('closed without merge blocks and is never completion, even with another PR merged; reopening clears it', () => {
    const closed = effect(evaluateGithubRule(rule({ expectedStatus: 'in_progress' }), task({ status: 'in_progress' }), [merged(41), pull(42, { state: 'closed' })]));
    assert.deepEqual([closed.code, closed.status, closed.blocker, closed.blockedBy, closed.readyToClose], ['pull_closed', 'blocked', 'PR #42 closed without merge', 'closed', false]);
    const owned = rule({ expectedStatus: 'blocked', expectedBlocker: closed.blocker, blockedBy: 'closed', expectedVersion: 2 });
    const reopened = effect(evaluateGithubRule(owned, task({ status: 'blocked', blocker: closed.blocker, version: 2 }), [merged(41), pull(42, { checks: [{ name: 'ci', state: 'pending' }] })]));
    assert.deepEqual([reopened.code, reopened.status], ['pull_reopened', 'in_progress']);
    const refailed = effect(evaluateGithubRule(owned, task({ status: 'blocked', blocker: closed.blocker, version: 2 }), [failing(42)]));
    assert.deepEqual([refailed.code, refailed.blocker, refailed.blockedBy], ['check_failed', 'Check “firmware / test” failed on PR #42', 'check']);
  });

  test('parked, done and not-pursued work, inactive rules and unreadable links are left alone', () => {
    for (const state of [task({ parked: true }), task({ status: 'done', version: 4 }), task({ status: 'not_pursued', version: 4 })])
      assert.deepEqual(evaluateGithubRule(rule(), state, [merged(42)]), { kind: 'none', repin: false });
    for (const state of ['suspended', 'off'] as const) assert.deepEqual(evaluateGithubRule(rule({ state }), task(), [pull(42)]), { kind: 'none', repin: false });
    assert.deepEqual(evaluateGithubRule(rule(), task(), []), { kind: 'none', repin: false }, 'related-only links are not inputs');
    assert.deepEqual(evaluateGithubRule(rule(), task(), [merged(41), merged(42), pull(43, { available: false })]), { kind: 'none', repin: false }, 'one unreadable required link stops it');
  });

  test('a manual change of status or blocker suspends it; other edits only move the expected version', () => {
    assert.deepEqual(evaluateGithubRule(rule({ expectedStatus: 'in_progress' }), task({ status: 'blocked', blocker: 'Supplier', version: 2 }), [pull(42)]),
      { kind: 'suspend', reason: 'manual_change' });
    assert.deepEqual(evaluateGithubRule(rule({ expectedStatus: 'blocked', expectedBlocker: 'PR #42 closed without merge', blockedBy: 'closed' }),
      task({ status: 'blocked', blocker: 'Reworded by a person', version: 2 }), [pull(42)]), { kind: 'suspend', reason: 'manual_change' });
    assert.deepEqual(evaluateGithubRule(rule({ expectedStatus: 'in_progress' }), task({ status: 'in_progress', version: 5 }), [pull(42)]), { kind: 'none', repin: true },
      'a title, owner or criteria edit keeps the rule active');
    assert.equal(manuallyChanged(rule(), task({ status: 'done', version: 9 })), false, 'finished work is not the rule\'s to suspend over');
    const shown = presentGithubRule(rule({ readyToClose: true, expectedStatus: 'in_progress' }), task({ status: 'blocked', blocker: 'x', version: 2 }));
    assert.deepEqual([shown.state, shown.suspendedReason, shown.readyToClose], ['suspended', 'manual_change', false],
      'readers see the suspension before the next delivery, and a paused rule offers no Ready to close');
    const lost = presentGithubRule({ ...rule({ readyToClose: true }), repositoryUnavailable: true }, task());
    assert.deepEqual([lost.state, lost.suspendedReason, lost.readyToClose], ['suspended', 'repository_unavailable', false], 'an inactive required binding shows as paused');
    assert.equal(presentGithubRule({ ...rule({ state: 'off' }), repositoryUnavailable: true }, task()).state, 'off');
    assert.equal(presentGithubRule(rule({ readyToClose: true }), task({ status: 'done', version: 2 })).readyToClose, false, 'done work is not ready to close');
  });
});
