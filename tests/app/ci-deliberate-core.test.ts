import assert from 'node:assert/strict';
import { test } from 'node:test';

test('intentional #143 fast CI failure fixture', () => {
  assert.fail('Expected failure: prove fast CI rejects a failing test');
});
