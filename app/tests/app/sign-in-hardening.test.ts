import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import Fastify from 'fastify';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@flux/contracts';
import { loadIdentityConfig, registerIdentity } from '../../apps/server/src/identity/index.js';
import { passwordProblem } from '../../apps/server/src/identity/password-policy.js';
import { SIGN_IN_ATTEMPTS_BEFORE_WAIT, waitAfterAttempts } from '../../apps/server/src/identity/sign-in-throttle.js';
import { database, pool } from './support/db.js';
import { Browser, publicOrigin, register, signIn, uniqueEmail, waitForMail } from './support/http.js';
import { password } from './support/people.js';

// Password rules and the account's sign-in back-off (#990), against the running API containers and, for the shared address limiter, two
// in-process servers on one database. The reset-to-client side of #989 is in oauth-sign-out.test.ts.
if (!publicOrigin) throw new Error('FLUX_PUBLIC_ORIGIN is required');

const api2Url = process.env.FLUX_API2_URL ?? 'http://api2:8080';
const code = (response: { json: unknown }) => (response.json as { code?: string } | null)?.code;

async function signUp(email: string, chosen: string, name = 'Test Person') {
  return new Browser().request('POST', '/api/auth/sign-up/email', { body: { email, password: chosen, name } });
}

async function accountsWith(email: string) {
  return Number((await pool.query('SELECT count(*)::int AS n FROM auth_users WHERE email = $1', [email])).rows[0].n);
}

describe('the password rule (#990, ASVS V2.1.1, V2.1.7)', () => {
  test('the minimum is 12 characters and the maximum 128, from one constant', async () => {
    assert.equal(PASSWORD_MIN_LENGTH, 12);
    assert.equal(PASSWORD_MAX_LENGTH, 128);
    for (const short of ['password', 'Tr0ub4dor&3', 'a'.repeat(PASSWORD_MIN_LENGTH - 1)]) {
      const email = uniqueEmail('short');
      const response = await signUp(email, short);
      assert.equal(response.status, 400, `${short.length} characters`);
      assert.equal(code(response), 'PASSWORD_TOO_SHORT');
      assert.equal(await accountsWith(email), 0, 'a refused password creates no account');
    }
    const email = uniqueEmail('long');
    const tooLong = await signUp(email, `${'correct horse battery staple '.repeat(5)}`.slice(0, PASSWORD_MAX_LENGTH + 1));
    assert.equal(tooLong.status, 400);
    assert.equal(code(tooLong), 'PASSWORD_TOO_LONG');
    const longest = await signUp(uniqueEmail('longest'), 'correct horse battery staple '.repeat(5).slice(0, PASSWORD_MAX_LENGTH));
    assert.equal(longest.status, 200, 'a passphrase of exactly 128 characters is allowed');
  });

  test('a common or easy-to-guess password of enough length is refused, with the account untouched', async () => {
    for (const weak of ['password1234', 'passwordpassword', 'qwertyuiopas', '123456789012', 'iloveyou12345', 'aaaaaaaaaaaa', 'Password1234!']) {
      const email = uniqueEmail('weak');
      const response = await signUp(email, weak);
      assert.equal(response.status, 400, weak);
      assert.equal(code(response), 'PASSWORD_TOO_WEAK', weak);
      assert.match((response.json as { message: string }).message, /too easy to guess/);
      assert.equal(await accountsWith(email), 0);
    }
  });

  test('a password built from the person\'s own name or address is refused; the same words without them are not', async () => {
    const label = 'zanzibarquixotic';
    const email = `${label}-${randomUUID()}@example.test`;
    const own = await signUp(email, `${label}2024`, 'Zanzibar Quixotic');
    assert.equal(own.status, 400);
    assert.equal(code(own), 'PASSWORD_TOO_WEAK');
    assert.equal(passwordProblem(`${label}2024`), null, 'the same text is fine for someone else');
    assert.equal((await signUp(email, `${label}2024`, 'Someone Else')).status, 400, 'the address alone is enough');
    const fine = await signUp(uniqueEmail('fine'), `${label}2024`, 'Someone Else');
    assert.equal(fine.status, 200);
  });

  test('a phrase of unrelated words is accepted, and the checker names the reason', () => {
    for (const good of ['correct horse battery staple', 'seven loud geese in a hat', 'the plane has no edge anywhere']) assert.equal(passwordProblem(good), null, good);
    assert.equal(passwordProblem('Password'), 'common');
    assert.equal(passwordProblem('LETMEIN'), 'common', 'case does not matter');
    assert.equal(passwordProblem('password1234'), 'common', 'on the list');
    assert.equal(passwordProblem('qwertyuiopas'), 'guessable', 'a keyboard walk is not on the list but is estimated at a few thousand guesses');
    assert.equal(passwordProblem('ada@example.test2024', ['Ada L', 'ada@example.test']), 'guessable', 'the address with a year');
    assert.equal(passwordProblem('Ada-Lovelace!', ['Ada Lovelace']), 'guessable', 'the name with punctuation');
    assert.equal(passwordProblem('company setup for the checks', ['Company Setup', 'company-setup@example.test']), null, 'a sentence that contains the name is left to the estimate');
    assert.equal(passwordProblem('owner-of-the-flux', ['owner-of-the-flux']), 'guessable');
  });

  test('a change of password and a reset follow the same rule', async () => {
    const email = uniqueEmail('rule');
    const { browser } = await register(email, password);
    const weak = await browser.request('POST', '/api/auth/change-password', { body: { currentPassword: password, newPassword: 'password1234', revokeOtherSessions: false } });
    assert.equal(weak.status, 400);
    assert.equal(code(weak), 'PASSWORD_TOO_WEAK');
    const short = await browser.request('POST', '/api/auth/change-password', { body: { currentPassword: password, newPassword: 'short one', revokeOtherSessions: false } });
    assert.equal(code(short), 'PASSWORD_TOO_SHORT');
    const own = await browser.request('POST', '/api/auth/change-password', { body: { currentPassword: password, newPassword: email.split('@')[0], revokeOtherSessions: false } });
    assert.equal(own.status, 400, 'the address as a password');
    assert.equal(code(own), 'PASSWORD_TOO_WEAK');
    assert.equal((await signIn(email, password)).response.status, 200, 'the password did not change');

    assert.equal((await new Browser().request('POST', '/api/auth/request-password-reset', { body: { email, redirectTo: `${publicOrigin}/reset-password` } })).status, 200);
    const token = (await waitForMail(email)).match(/reset-password\/([^?\s]+)/)?.[1];
    assert.ok(token);
    const refused = await new Browser().request('POST', '/api/auth/reset-password', { body: { token, newPassword: 'qwertyuiopas' } });
    assert.equal(refused.status, 400);
    assert.equal(code(refused), 'PASSWORD_TOO_WEAK');
    const accepted = await new Browser().request('POST', '/api/auth/reset-password', { body: { token, newPassword: 'a new passphrase for the harbour' } });
    assert.equal(accepted.status, 200, 'the refused attempt did not use the token up');
  });
});

describe('the account\'s own sign-in back-off (#990, ASVS V2.2.1)', () => {
  test('the wait grows from 30 seconds to 15 minutes and starts after the fifth attempt', () => {
    assert.equal(SIGN_IN_ATTEMPTS_BEFORE_WAIT, 5);
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 40].map(waitAfterAttempts), [0, 0, 0, 0, 30, 60, 120, 240, 480, 900, 900]);
  });

  test('five wrong passwords in a row slow the account down for every client address and every API process, even for the right password', async () => {
    const email = uniqueEmail('throttle');
    await register(email, password);
    const second = new Browser(api2Url, publicOrigin);
    for (let attempt = 1; attempt <= 5; attempt++) {
      // Alternating API processes: the count lives in the database, not in either of them.
      const response = await (attempt % 2 ? new Browser() : second).request('POST', '/api/auth/sign-in/email', { body: { email, password: `wrong password number ${attempt}` } });
      assert.equal(response.status, 401, `attempt ${attempt}`);
    }
    for (const via of [new Browser(), second]) {
      const refused = await via.request('POST', '/api/auth/sign-in/email', { body: { email, password } });
      assert.equal(refused.status, 429, 'the right password is refused too while the account waits');
      assert.equal(code(refused), 'SIGN_IN_THROTTLED');
      const wait = Number(refused.headers.get('retry-after'));
      assert.ok(wait > 20 && wait <= 30, `Retry-After ${wait}`);
      assert.match((refused.json as { message: string }).message, /Too many sign-in attempts for this account\. Try again in \d+ seconds/);
    }
    assert.equal((await signIn(uniqueEmail('someone-else'), password)).response.status, 401, 'another address is counted on its own');
    const stored = await pool.query('SELECT failures, locked_until > now() AS locked FROM auth_sign_in_throttle');
    assert.ok(stored.rows.some((row: { failures: number; locked: boolean }) => row.failures === 5 && row.locked));
    assert.equal((await pool.query('SELECT 1 FROM auth_sign_in_throttle WHERE account_hash = $1', [email])).rowCount, 0, 'the address itself is not the key');
  });

  test('an address nobody holds is slowed exactly like a real one, so the answer says nothing about who has an account', async () => {
    const ghost = uniqueEmail('ghost');
    const answers: string[] = [];
    for (let attempt = 1; attempt <= 7; attempt++) {
      const response = await new Browser().request('POST', '/api/auth/sign-in/email', { body: { email: ghost, password: `wrong password number ${attempt}` } });
      answers.push(`${response.status} ${code(response)}`);
    }
    assert.deepEqual(answers, Array(5).fill('401 INVALID_EMAIL_OR_PASSWORD').concat(Array(2).fill('429 SIGN_IN_THROTTLED')));
  });

  test('twenty parallel guesses at one account get five answers from the password check, not twenty', async () => {
    const email = uniqueEmail('parallel');
    await register(email, password);
    const answers = await Promise.all(Array.from({ length: 20 }, (_, index) => new Browser().request('POST', '/api/auth/sign-in/email', { body: { email, password: `parallel wrong ${index}` } })));
    const counts = answers.reduce((tally, response) => ({ ...tally, [response.status]: (tally[response.status] ?? 0) + 1 }), {} as Record<number, number>);
    assert.deepEqual(counts, { 401: 5, 429: 15 });
  });

  test('when the wait is over the right password signs in and clears the count; a further failure waits longer', async () => {
    const email = uniqueEmail('recover');
    await register(email, password);
    const fail = (attempt: number) => new Browser().request('POST', '/api/auth/sign-in/email', { body: { email, password: `wrong ${attempt} for recover` } });
    for (let attempt = 1; attempt <= 5; attempt++) await fail(attempt);
    assert.equal((await fail(6)).status, 429);
    // The wait is over (time is the database's, so the test moves the row rather than sleeping).
    await pool.query("UPDATE auth_sign_in_throttle SET locked_until = now() - interval '1 second' WHERE locked_until > now() AND failures = 5");
    const sixth = await fail(7);
    assert.equal(sixth.status, 401, 'one more attempt is checked');
    const longer = await fail(8);
    assert.equal(longer.status, 429);
    const wait = Number(longer.headers.get('retry-after'));
    assert.ok(wait > 50 && wait <= 60, `the second wait is a minute, got ${wait}`);
    await pool.query("UPDATE auth_sign_in_throttle SET locked_until = now() - interval '1 second' WHERE locked_until > now()");
    const { response } = await signIn(email, password);
    assert.equal(response.status, 200, 'the right password works once the wait is over');
    const again = await Promise.all([1, 2, 3, 4].map((attempt) => fail(attempt + 8)));
    assert.deepEqual(again.map((item) => item.status), [401, 401, 401, 401], 'a success starts the count again');
  });

  test('a count is forgotten after an hour without an attempt, and a password reset clears it', async () => {
    const email = uniqueEmail('forget');
    await register(email, password);
    const fail = (attempt: number) => new Browser().request('POST', '/api/auth/sign-in/email', { body: { email, password: `wrong ${attempt} for forget` } });
    for (let attempt = 1; attempt <= 5; attempt++) await fail(attempt);
    assert.equal((await fail(6)).status, 429);
    // The mailbox's owner is never locked out for good: the reset link clears the wait at once.
    assert.equal((await new Browser().request('POST', '/api/auth/request-password-reset', { body: { email, redirectTo: `${publicOrigin}/reset-password` } })).status, 200);
    const token = (await waitForMail(email)).match(/reset-password\/([^?\s]+)/)?.[1];
    assert.equal((await new Browser().request('POST', '/api/auth/reset-password', { body: { token, newPassword: 'the harbour lights at dawn' } })).status, 200);
    assert.equal((await signIn(email, 'the harbour lights at dawn')).response.status, 200, 'signing in works at once after the reset');

    const stale = uniqueEmail('stale');
    await register(stale, password);
    for (let attempt = 1; attempt <= 5; attempt++) await new Browser().request('POST', '/api/auth/sign-in/email', { body: { email: stale, password: `wrong ${attempt} stale` } });
    await pool.query("UPDATE auth_sign_in_throttle SET last_failure_at = now() - interval '61 minutes', locked_until = now() + interval '5 minutes' WHERE failures = 5");
    // Every count is dropped an hour after its last attempt, whether or not its wait is over.
    assert.equal((await new Browser().request('POST', '/api/auth/sign-in/email', { body: { email: uniqueEmail('trigger'), password: 'wrong for trigger' } })).status, 401);
    assert.equal((await pool.query("SELECT 1 FROM auth_sign_in_throttle WHERE last_failure_at < now() - interval '1 hour'")).rowCount, 0);
    assert.equal((await signIn(stale, password)).response.status, 200);
  });

  test('guessing the current password through change-password counts for the account too, and a success clears it', async () => {
    const email = uniqueEmail('change-count');
    const { browser } = await register(email, password);
    const change = (current: string) => browser.request('POST', '/api/auth/change-password', { body: { currentPassword: current, newPassword: 'a brand new passphrase here', revokeOtherSessions: false } });
    for (let attempt = 1; attempt <= 5; attempt++) {
      const wrong = await change(`wrong current ${attempt}`);
      assert.equal(wrong.status, 400, `attempt ${attempt}`);
      assert.equal(code(wrong), 'INVALID_PASSWORD');
    }
    const refused = await change(password);
    assert.equal(refused.status, 429, 'the right current password waits too');
    assert.equal(code(refused), 'SIGN_IN_THROTTLED');
    assert.equal((await signIn(email, password)).response.status, 429, 'it is the same count as the sign-in');
    await pool.query("UPDATE auth_sign_in_throttle SET locked_until = now() - interval '1 second' WHERE locked_until > now()");
    assert.equal((await change(password)).status, 200, 'the wait is over');
    assert.equal((await signIn(email, 'a brand new passphrase here')).response.status, 200, 'and the success cleared the count');
  });

  test('single sign-on and every other route are untouched: only the password sign-in counts', async () => {
    const before = Number((await pool.query('SELECT count(*)::int AS n FROM auth_sign_in_throttle')).rows[0].n);
    const email = uniqueEmail('only-password');
    const { browser } = await register(email, password);
    for (let index = 0; index < 8; index++) assert.equal((await browser.request('GET', '/api/v1/me')).status, 200);
    assert.equal((await new Browser().request('POST', '/api/auth/sign-up/email', { body: { email: uniqueEmail('x'), password: 'short', name: 'X' } })).status, 400);
    assert.equal(Number((await pool.query('SELECT count(*)::int AS n FROM auth_sign_in_throttle')).rows[0].n), before, 'sign-up, reads and a refused password leave no count');
  });
});

describe('the per-address limiter is shared by every API process (#990)', () => {
  test('three wrong passwords on one process make the next request on another one a 429', async () => {
    const config = loadIdentityConfig({ FLUX_PUBLIC_ORIGIN: 'https://flux.example.org', FLUX_AUTH_SECRET: randomBytes(32).toString('hex'), FLUX_AUTH_RATE_LIMIT: 'true' });
    const servers = await Promise.all([1, 2].map(async () => {
      const instance = Fastify();
      registerIdentity(instance, { db: database.db, config, mailer: null });
      await instance.ready();
      return instance;
    }));
    try {
      // A client address of this test alone (TEST-NET-2), so no other test's requests count against it.
      const remoteAddress = `198.51.100.${1 + Math.floor(Math.random() * 250)}`;
      const attempt = (server: typeof servers[number], label: string) => server.inject({ method: 'POST', url: '/api/auth/sign-in/email', remoteAddress,
        headers: { origin: 'https://flux.example.org' }, payload: { email: `${label}-${randomUUID()}@example.test`, password: 'a wrong password here' } });
      assert.deepEqual([(await attempt(servers[0]!, 'a')).statusCode, (await attempt(servers[0]!, 'b')).statusCode, (await attempt(servers[1]!, 'c')).statusCode], [401, 401, 401]);
      const limited = await attempt(servers[1]!, 'd');
      assert.equal(limited.statusCode, 429, 'the second process knows what the first one counted');
      assert.ok(limited.headers['x-retry-after'], 'Better Auth says when');
      const stored = await pool.query("SELECT count FROM auth_rate_limits WHERE key = $1", [`${remoteAddress}|/sign-in/email`]);
      assert.equal(stored.rows[0]?.count, 3, 'the count is a row in PostgreSQL');
    } finally { await Promise.all(servers.map((server) => server.close())); }
  });
});
