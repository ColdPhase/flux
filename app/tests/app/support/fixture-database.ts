import assert from 'node:assert/strict';
import type { createDatabase } from '@flux/db';

type Pool = ReturnType<typeof createDatabase>['pool'];

/**
 * #253: the error guard of a migration fixture's own pool. `createDatabase` registers no pool `error` listener, so an
 * idle client that the server terminates surfaces as an unhandled error, attributed to whichever test is running. The
 * fixture's own cleanup, `DROP DATABASE … WITH (FORCE)`, may terminate a backend that outlived `pool.end()`
 * ("terminating connection due to administrator command"): once cleanup has started that is expected and ignored.
 * An idle-client error before cleanup starts is a real failure and still fails the test.
 */
export function guardFixturePool(pool: Pool) {
  const early: unknown[] = [];
  let cleaning = false;
  pool.on('error', (error) => { if (!cleaning) early.push(error); });
  return {
    /** First thing in the fixture's `finally`, before `pool.end()` and the FORCE drop. */
    cleanup() { cleaning = true; },
    /** After the `finally`: no fixture connection failed while the test was running. */
    assertNoEarlyErrors() { assert.deepEqual(early, [], 'no fixture database connection failed before cleanup'); },
  };
}
