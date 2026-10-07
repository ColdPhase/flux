import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasMinimumTouchSize } from './support/touch-target.js';

test('44px touch measurements accept exact size and the recorded floating-point noise', () => {
  for (const size of [44, 48, 43.99997]) assert.equal(hasMinimumTouchSize(size), true, String(size));
});

test('the numerical tolerance rejects undersized and invalid measurements', () => {
  // Math.round previously accepted 43.5 and 43.75, weakening the 44px check by half a pixel.
  for (const size of [43.5, 43.75, 43.99, 43.9989, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(hasMinimumTouchSize(size), false, String(size));
  }
});
