import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const cases = [
  {
    name: 'Nothing delivery guard',
    file: 'packages/core/dist/notifications/summary.js',
    before: "preferences.summaryEnabled && levelOf(channelsOf(preferences)) !== 'nothing'",
    after: 'preferences.summaryEnabled',
    args: ['--test-name-pattern=nothing after admission', 'tests/app/notification-summary-native.test.ts'],
    witness: /nothing after admission suppresses delivery/,
  },
  {
    name: 'Non-anchor authorization',
    file: 'packages/core/dist/push/notifications.js',
    before: 'for (const source of sources)',
    after: 'for (const source of sources.slice(0, 1))',
    args: ['--test-name-pattern=non-anchor and total access loss', 'tests/app/notification-summary-native.test.ts'],
    witness: /non-anchor and total access loss suppress an admitted/,
  },
  {
    name: 'Midnight scheduled-day selection',
    file: 'packages/core/src/notifications/summary-schedule.ts',
    before: 'new Set([today, today - DAY, dayOf(civilMinute(formatter, instant - LATE_WINDOW))])',
    after: 'new Set([today])',
    args: ['--test-name-pattern=15-minute tick catches', 'tests/app/notification-summary-schedule.test.ts'],
    witness: /15-minute tick catches 23:46 and 23:59/,
  },
];
for (const mutation of cases) {
  const original = readFileSync(mutation.file, 'utf8');
  assert.equal(original.split(mutation.before).length, 2, `exact mutation site for ${mutation.name}`);
  try {
    writeFileSync(mutation.file, original.replace(mutation.before, mutation.after));
    const result = spawnSync('node_modules/.bin/tsx', ['--test', ...mutation.args], { encoding: 'utf8' });
    const output = `${result.stdout}\n${result.stderr}`;
    writeFileSync(`/evidence/${mutation.name.replaceAll(' ', '-').toLowerCase()}.log`, output);
    assert.equal(result.status, 1, `mutant must fail: ${mutation.name}\n${output}`);
    assert.match(output, mutation.witness);
    assert.match(output, /ERR_ASSERTION|AssertionError/);
    assert.doesNotMatch(output, /Cannot find module|SyntaxError|ECONNREFUSED/);
    console.log(`KILLED: ${mutation.name}; actual regression assertion failed`);
  } finally {
    writeFileSync(mutation.file, original);
  }
}
console.log('All 3 temporary mutations rejected; container source restored.');
