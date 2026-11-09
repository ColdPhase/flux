import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, test } from 'node:test';
import { createDevices } from '../../apps/server/src/identity/devices.js';
import { readDevice } from '../../apps/server/src/identity/device-cookie.js';
import { db, pool } from './support/db.js';
import { person } from './support/people.js';

// The device generation of an account (#1031) and how it is raised (#1067): one step on the value that was seen, a cookie only for the
// generation the writer's own raise made. The steps are taken one by one here, in the orders the races between requests produce.
const SECRET = randomBytes(32).toString('hex');
const devices = createDevices(db, SECRET, false);

async function account(label: string) {
  const owner = await person(label);
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM auth_sessions WHERE user_id = $1', [owner.id]);
  return { ...owner, sessionId: rows[0]!.id };
}
const generation = async (userId: string) => Number((await pool.query('SELECT device_generation AS g FROM auth_users WHERE id = $1', [userId])).rows[0].g);

describe('raising the device generation (#1067)', () => {
  test('a raise made on a reading that is out of date changes nothing and gives no generation', async () => {
    const owner = await account('gen-stale');
    const cookie = await devices.remember(null, owner.email);
    const check = await devices.check(cookie, owner.email, owner.id);
    assert.ok(check.device, 'the cookie counts at the generation that was seen');
    assert.equal(check.seen, 0);
    // A reset (or another tab) raises it between the check and the raise.
    assert.equal(await devices.endAll(owner.id), 1);
    assert.equal(await devices.endAll(owner.id, { seen: check.seen, sessionId: owner.sessionId }), null);
    assert.equal(await generation(owner.id), 1, 'and it raised nothing more');
    assert.equal(await devices.known(cookie, owner.email), null, 'the cookie was ended by the first raise');
  });

  test('a raise on the generation that was seen returns it, and the cookie written for it counts while older copies do not', async () => {
    const owner = await account('gen-seen');
    const first = await devices.remember(null, owner.email);
    const copy = first;
    const check = await devices.check(first, owner.email, owner.id);
    const raised = await devices.endAll(owner.id, { seen: check.seen, sessionId: owner.sessionId });
    assert.equal(raised, 1);
    const second = await devices.remember(first, owner.email, raised!);
    assert.ok(await devices.known(second, owner.email));
    assert.equal(await devices.known(copy, owner.email), null);
    assert.equal(readDevice(SECRET, second)!.id, readDevice(SECRET, first)!.id, 'the same device');
    assert.equal(readDevice(SECRET, second)!.accounts.length, 1, 'the older key left the cookie');
    // Another raise follows: a cookie written for the earlier generation is not made current by it.
    assert.equal(await devices.endAll(owner.id), 2);
    assert.equal(await devices.known(second, owner.email), null);
  });

  test('a session that is gone raises nothing', async () => {
    const owner = await account('gen-revoked');
    await pool.query('DELETE FROM auth_sessions WHERE id = $1', [owner.sessionId]);
    assert.equal(await devices.endAll(owner.id, { seen: 0, sessionId: owner.sessionId }), null);
    assert.equal(await generation(owner.id), 0);
  });

  test('two raises on the same reading: exactly one matches', async () => {
    const owner = await account('gen-two');
    const answers = await Promise.all(Array.from({ length: 6 }, () => devices.endAll(owner.id, { seen: 0, sessionId: owner.sessionId })));
    assert.deepEqual(answers.filter((answer) => answer !== null), [1]);
    assert.equal(await generation(owner.id), 1);
  });

  test('raises that do not look at a reading each make their own generation', async () => {
    const owner = await account('gen-many');
    const answers = await Promise.all(Array.from({ length: 8 }, () => devices.endAll(owner.id)));
    assert.deepEqual([...answers].sort((a, b) => a! - b!), [1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
