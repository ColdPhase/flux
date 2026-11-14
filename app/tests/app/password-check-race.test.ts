import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { pool } from './support/db.js';
import { Browser, publicOrigin, register, signIn, uniqueEmail, waitForMail } from './support/http.js';
import { password, person } from './support/people.js';

// A sign-in or a password change that is already running with the old password must not survive a reset (#1088, from the review of #1068).
// Better Auth checks the password against the hash it read and then creates the session, or writes the new hash, without looking again; the
// database now refuses both if the hash is no longer the one that was accepted (migration 0042). First the database on its own, with the
// interleavings produced by hand; then the running API containers with real requests racing a reset.
if (!publicOrigin) throw new Error('FLUX_PUBLIC_ORIGIN is required');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const NEW_PASSWORD = 'the harbour lights at dawn';
const hashOf = async (userId: string) => (await pool.query<{ password: string }>(`SELECT password FROM auth_accounts WHERE user_id = $1 AND provider_id = 'credential'`, [userId])).rows[0]!.password;
const versionOf = async (userId: string) => Number((await pool.query(`SELECT password_version AS v FROM auth_accounts WHERE user_id = $1 AND provider_id = 'credential'`, [userId])).rows[0].v);
const sessionCount = async (userId: string) => Number((await pool.query('SELECT count(*) AS n FROM auth_sessions WHERE user_id = $1', [userId])).rows[0].n);
const insertSession = (userId: string, checked: number | null) => pool.query(
  'INSERT INTO auth_sessions (id, user_id, token, expires_at, password_version_checked) VALUES ($1, $2, $3, now() + interval \'1 hour\', $4)', [randomUUID(), userId, randomUUID(), checked]);
const setHash = (userId: string, hash: string, expected: number | null = null) => pool.query(
  `UPDATE auth_accounts SET password = $2, password_version_expected = $3 WHERE user_id = $1 AND provider_id = 'credential'`, [userId, hash, expected]);
const failure = (promise: Promise<unknown>) => promise.then(() => null, (error: Error) => error);

describe('the database refuses a session or a password change whose password check is out of date', () => {
  test('every write of the password bumps its version, and a write that leaves it alone does not', async () => {
    const owner = await person('pc-version');
    const first = await versionOf(owner.id);
    await pool.query(`UPDATE auth_accounts SET updated_at = now() WHERE user_id = $1 AND provider_id = 'credential'`, [owner.id]);
    assert.equal(await versionOf(owner.id), first);
    await setHash(owner.id, 'scrypt-hash-one');
    assert.equal(await versionOf(owner.id), first + 1);
    await setHash(owner.id, 'scrypt-hash-two', first + 1);
    assert.equal(await versionOf(owner.id), first + 2);
  });

  test('a session whose check is still current is created, and nothing about the check stays in the row', async () => {
    const owner = await person('pc-fresh');
    const before = await sessionCount(owner.id);
    await insertSession(owner.id, await versionOf(owner.id));
    assert.equal(await sessionCount(owner.id), before + 1);
    assert.equal((await pool.query('SELECT count(*) AS n FROM auth_sessions WHERE user_id = $1 AND password_version_checked IS NOT NULL', [owner.id])).rows[0].n, '0');
  });

  test('a session whose check is out of date is refused, and one with no check is not looked at', async () => {
    const owner = await person('pc-stale');
    const before = await sessionCount(owner.id);
    const error = await failure(insertSession(owner.id, (await versionOf(owner.id)) + 5));
    assert.match(error?.message ?? '', /flux:password_changed/);
    assert.equal(await sessionCount(owner.id), before);
    await insertSession(owner.id, null);
    assert.equal(await sessionCount(owner.id), before + 1, 'a provider sign-in carries no check');
  });

  test('a reset that is writing makes a session with the old check wait, and then refuses it', async () => {
    const owner = await person('pc-reset-first');
    const old = await versionOf(owner.id);
    const reset = await pool.connect();
    try {
      await reset.query('BEGIN');
      await reset.query(`UPDATE auth_accounts SET password = 'scrypt-hash-after-the-reset' WHERE user_id = $1 AND provider_id = 'credential'`, [owner.id]);
      const insert = failure(insertSession(owner.id, old));
      await sleep(300);
      await reset.query('COMMIT');
      assert.match((await insert)?.message ?? '', /flux:password_changed/);
      assert.equal(await sessionCount(owner.id), 0, 'the write ended the session there was, and the refused one was not created');
    } finally { reset.release(); }
  });

  test('a session that is being created makes a reset wait for it, and the reset then deletes it', async () => {
    const owner = await person('pc-insert-first');
    const old = await versionOf(owner.id);
    const creating = await pool.connect();
    try {
      await creating.query('BEGIN');
      await creating.query('INSERT INTO auth_sessions (id, user_id, token, expires_at, password_version_checked) VALUES ($1, $2, $3, now() + interval \'1 hour\', $4)', [randomUUID(), owner.id, randomUUID(), old]);
      let resetDone = false;
      const reset = setHash(owner.id, 'scrypt-hash-after-the-reset').then(() => { resetDone = true; });
      await sleep(300);
      assert.equal(resetDone, false, 'the reset waits for the session that was checked against the old version');
      await creating.query('COMMIT');
      await reset;
      await pool.query('DELETE FROM auth_sessions WHERE user_id = $1', [owner.id]);
      assert.equal(await sessionCount(owner.id), 0, 'and its revocation of the sessions then removes it');
    } finally { creating.release(); }
  });

  test('a session created after the reset deleted the sessions and before it wrote the hash is deleted by the write', async () => {
    const owner = await person('pc-between');
    const old = await versionOf(owner.id);
    const reset = await pool.connect();
    try {
      // Better Auth's reset deletes the sessions, then writes the hash.
      await reset.query('BEGIN');
      await reset.query('DELETE FROM auth_sessions WHERE user_id = $1', [owner.id]);
      await insertSession(owner.id, old);
      assert.equal(await sessionCount(owner.id), 2, 'the version was still the old one, so the session was created (the deleted one is not gone for others before the commit)');
      await reset.query(`UPDATE auth_accounts SET password = 'scrypt-hash-after-the-reset' WHERE user_id = $1 AND provider_id = 'credential'`, [owner.id]);
      await reset.query('COMMIT');
      assert.equal(await sessionCount(owner.id), 0, 'and the write that follows ended it');
    } finally { reset.release(); }
  });

  test('a password change is written only if the account is still at the version it was checked at, and a reset carries no check', async () => {
    const owner = await person('pc-change');
    const first = await hashOf(owner.id);
    const version = await versionOf(owner.id);
    const stale = await failure(setHash(owner.id, 'the old password put back', version + 3));
    assert.match(stale?.message ?? '', /flux:password_changed/);
    assert.equal(await hashOf(owner.id), first, 'a refused change leaves the hash');
    assert.equal(await versionOf(owner.id), version);
    await setHash(owner.id, 'second hash', version);
    assert.equal(await hashOf(owner.id), 'second hash');
    assert.equal(await versionOf(owner.id), version + 1);
    assert.equal((await pool.query(`SELECT password_version_expected FROM auth_accounts WHERE user_id = $1 AND provider_id = 'credential'`, [owner.id])).rows[0].password_version_expected, null, 'and keeps no check');
    assert.equal(await sessionCount(owner.id), 1, 'a change that was checked keeps the sessions (Better Auth signs the others out itself)');
    await setHash(owner.id, 'third hash');
    assert.equal(await hashOf(owner.id), 'third hash');
    assert.equal(await sessionCount(owner.id), 0, 'a write with no check ends them');
  });

  test('a password change that waits behind a reset is refused and does not put the old password back', async () => {
    const owner = await person('pc-change-behind');
    const old = await hashOf(owner.id);
    const version = await versionOf(owner.id);
    const reset = await pool.connect();
    try {
      await reset.query('BEGIN');
      await reset.query(`UPDATE auth_accounts SET password = 'scrypt-hash-after-the-reset' WHERE user_id = $1 AND provider_id = 'credential'`, [owner.id]);
      const change = failure(setHash(owner.id, old, version));
      await sleep(300);
      await reset.query('COMMIT');
      assert.match((await change)?.message ?? '', /flux:password_changed/);
      assert.equal(await hashOf(owner.id), 'scrypt-hash-after-the-reset');
    } finally { reset.release(); }
  });
});

const deviceCookieOf = (browser: Browser) => [...browser.cookies].find(([name]) => name.endsWith('flux.device'));
async function makeAccountWait(email: string, label: string) {
  const stranger = new Browser();
  for (let attempt = 1; attempt <= 6; attempt++) await stranger.request('POST', '/api/auth/sign-in/email', { body: { email, password: `${label} stranger ${attempt}` } });
}
async function counts(name: string, value: string, email: string) {
  const probe = new Browser();
  probe.cookies.set(name, value);
  return (await probe.request('POST', '/api/auth/sign-in/email', { body: { email, password: 'a wrong guess from a probe' } })).status === 401;
}
async function resetToken(email: string, owner: Browser) {
  assert.equal((await owner.request('POST', '/api/auth/request-password-reset', { body: { email, redirectTo: `${publicOrigin}/reset-password` } })).status, 200);
  const token = (await waitForMail(email)).match(/reset-password\/([^?\s]+)/)?.[1];
  assert.ok(token);
  return token;
}
const userIdOf = async (email: string) => (await pool.query<{ id: string }>('SELECT id FROM auth_users WHERE email = $1', [email])).rows[0]!.id;

describe('real requests racing a reset (the running API containers)', () => {
  test('a sign-in or a password change that the database refuses is answered 500 without a hash (check_application.sh then looks for one in the API logs)', async () => {
    const reset = async (userId: string, whileHeld: () => Promise<{ status: number; text: string }>) => {
      const hold = await pool.connect();
      try {
        // A reset that has written the hash and not yet committed: the request below has read the old one, passes its checks, and waits on the row.
        await hold.query('BEGIN');
        await hold.query(`UPDATE auth_accounts SET password = 'scrypt-hash-after-the-reset' WHERE user_id = $1 AND provider_id = 'credential'`, [userId]);
        const answer = whileHeld();
        await sleep(1500);
        await hold.query('COMMIT');
        return await answer;
      } finally { hold.release(); }
    };
    const signInEmail = uniqueEmail('pc-refused-signin');
    await register(signInEmail, password);
    const signInUser = await userIdOf(signInEmail);
    const oldHash = await hashOf(signInUser);
    const refusedSignIn = await reset(signInUser, async () => { const { response } = await signIn(signInEmail, password); return response; });
    assert.equal(refusedSignIn.status, 500);
    assert.ok(!refusedSignIn.text.includes(oldHash) && !refusedSignIn.text.includes('scrypt-hash'), 'the answer holds no hash');
    assert.equal(await sessionCount(signInUser), 0, 'and no session was created');

    const changeEmail = uniqueEmail('pc-refused-change');
    const { browser: changer } = await register(changeEmail, password);
    const changeUser = await userIdOf(changeEmail);
    const changeOld = await hashOf(changeUser);
    const refusedChange = await reset(changeUser, () => changer.request('POST', '/api/auth/change-password',
      { body: { currentPassword: password, newPassword: 'another new passphrase here', revokeOtherSessions: false } }));
    assert.equal(refusedChange.status, 500);
    assert.ok(!refusedChange.text.includes(changeOld) && !refusedChange.text.includes('scrypt-hash'), 'the answer holds no hash');
    assert.equal(await hashOf(changeUser), 'scrypt-hash-after-the-reset', 'and the reset\'s password was not replaced');
  });

  test('sign-ins with the old password that are running when the reset commits leave no session and no cookie that counts', async () => {
    for (let round = 1; round <= 3; round++) {
      const email = uniqueEmail(`pc-signin-${round}`);
      const { browser: owner } = await register(email, password);
      const userId = await userIdOf(email);
      const token = await resetToken(email, owner);
      const won: Browser[] = [];
      const refused = new Set<number>();
      let stop = false;
      // Someone who knows the old password signs in again and again, from several requests at once, while the owner resets.
      const loop = async () => {
        while (!stop) {
          const { browser, response } = await signIn(email, password);
          if (response.status !== 200) { refused.add(response.status); return; }
          won.push(browser);
        }
      };
      const loops = Array.from({ length: 4 }, loop);
      await sleep(300);
      assert.equal((await owner.request('POST', '/api/auth/reset-password', { body: { token, newPassword: NEW_PASSWORD } })).status, 200);
      stop = true;
      await Promise.all(loops);
      assert.ok(won.length > 0, 'the sign-ins were running');
      // A sign-in that lost is answered "Invalid email or password" (401), or with the generic error when it lost inside the database statement (500).
      for (const status of refused) assert.ok(status === 401 || status === 500, `a sign-in that lost was answered ${status}`);
      assert.equal(await sessionCount(userId), 0, 'no session of the old password outlives the reset');
      for (const browser of won.slice(-8)) assert.equal((await browser.request('GET', '/api/v1/me')).status, 401);
      await makeAccountWait(email, `signin ${round}`);
      const [name, ownerCookie] = deviceCookieOf(owner)!;
      for (const browser of won.slice(-8)) {
        const cookie = deviceCookieOf(browser);
        if (cookie) assert.equal(await counts(name, cookie[1], email), false, 'a cookie of a sign-in with the old password counts after the reset');
      }
      assert.equal(await counts(name, ownerCookie, email), true, 'the cookie of the browser that reset still counts');
    }
  });

  test('a password change that is running when the reset commits does not put a password back or keep a session, and no change stops the reset link', async () => {
    for (let round = 1; round <= 3; round++) {
      const email = uniqueEmail(`pc-change-${round}`);
      const { browser: owner } = await register(email, password);
      const userId = await userIdOf(email);
      const { browser: thief, response } = await signIn(email, password);
      assert.equal(response.status, 200);
      const token = await resetToken(email, owner);
      // The thief has a session and the old password: they change it to one of their own and sign the other devices out. A change of
      // password stops no reset link (#1471, coordinator decision 2026-11-13), so the owner's link mailed before still works.
      const thiefPassword = `the thief chose this one ${round}`;
      assert.equal((await thief.request('POST', '/api/auth/change-password', { body: { currentPassword: password, newPassword: thiefPassword, revokeOtherSessions: true } })).status, 200);
      let stop = false;
      let changes = 0;
      // Then they keep changing it and signing the other devices out while the owner resets.
      const loop = async () => {
        while (!stop) {
          const out = await thief.request('POST', '/api/auth/change-password', { body: { currentPassword: thiefPassword, newPassword: thiefPassword, revokeOtherSessions: true } });
          if (out.status === 200) changes += 1; else return;
        }
      };
      const loops = Array.from({ length: 2 }, loop);
      await sleep(400);
      assert.equal((await owner.request('POST', '/api/auth/reset-password', { body: { token, newPassword: NEW_PASSWORD } })).status, 200);
      stop = true;
      await Promise.all(loops);
      assert.ok(changes > 0, 'the changes were running');
      assert.equal(await sessionCount(userId), 0, 'no session of the thief outlives the reset');
      assert.equal((await thief.request('GET', '/api/v1/me')).status, 401);
      assert.equal((await new Browser().request('POST', '/api/auth/sign-in/email', { body: { email, password } })).status, 401, 'the old password is not back');
      assert.equal((await new Browser().request('POST', '/api/auth/sign-in/email', { body: { email, password: thiefPassword } })).status, 401, 'nor the thief\'s');
      assert.equal((await signIn(email, NEW_PASSWORD)).response.status, 200, 'the owner\'s new password stands');
    }
  });
});

describe('"Sign out all other devices" from two sessions at the same moment', () => {
  test('raises the generation at least once, whichever session deletes the other first', async () => {
    for (let round = 1; round <= 6; round++) {
      const email = uniqueEmail(`pc-two-${round}`);
      const { browser: first } = await register(email, password);
      const { browser: second, response } = await signIn(email, password);
      assert.equal(response.status, 200);
      const generation = async () => Number((await pool.query('SELECT device_generation AS g FROM auth_users WHERE email = $1', [email])).rows[0].g);
      const before = await generation();
      await Promise.all([first.request('POST', '/api/v1/sessions/revoke-others'), second.request('POST', '/api/v1/sessions/revoke-others')]);
      assert.ok(await generation() > before, `round ${round}: neither sign-out raised the generation`);
    }
  });
});
