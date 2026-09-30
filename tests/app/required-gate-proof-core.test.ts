import assert from 'node:assert/strict';
import { test } from 'node:test';

// Controlled #143 enforcement demonstration only; removed in the corrected head.
test('required Application validation rejects a genuine portable-test failure', () => {
  assert.fail('Intentional #143 required-check enforcement fixture; do not merge this failing head');
});
