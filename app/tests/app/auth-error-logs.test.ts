import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { withFault } from './support/db-faults.js';
import { pool } from './support/db.js';
import { Browser, publicOrigin, register, signIn, uniqueEmail } from './support/http.js';
import { password } from './support/people.js';

// What a failing authentication request logs and answers (#1088, from the delta review of #1093), through the running API containers.
// The faults are database triggers for one address, so the failures are the same every time. check_application.sh then looks for the marker
// address and name below in the logs of both API processes: neither may be printed.
if (!publicOrigin) throw new Error('FLUX_PUBLIC_ORIGIN is required');

const faultName = (label: string) => `ael_${label}_${randomUUID().replace(/-/g, '')}`;

test('a sign-up that fails at the database is answered as a refused sign-up, and its address and name are not logged', async () => {
  const email = `log-leak-marker-${randomUUID()}@example.test`;
  await withFault(pool, { name: faultName('user'), table: 'auth_users', on: 'INSERT', when: `NEW.email = '${email}'`,
    body: `RAISE EXCEPTION 'injected user insert failure';` }, async () => {
    const answer = await new Browser().request('POST', '/api/auth/sign-up/email', { body: { email, password, name: 'Log Leak Marker Person' } });
    assert.equal(answer.status, 422);
    assert.ok(!answer.text.includes(email) && !answer.text.includes('Log Leak Marker'), 'the answer holds neither');
  });
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM auth_users WHERE email = $1', [email])).rows[0].n), 0, 'and no account was made');
});

test('a sign-in that lost to a reset after its session row was written is answered like a refused sign-in', async () => {
  const email = uniqueEmail('ael-lost');
  await register(email, password);
  // The reset ends the new session after its row was written and before the sign-in records how it signed in: here the row is gone when the
  // record is written, so the foreign key refuses it (the trigger does it for this address; its own delete is rolled back with the statement).
  await withFault(pool, { name: faultName('identity'), table: 'auth_session_identities', on: 'INSERT', when: 'true',
    body: `DELETE FROM auth_sessions WHERE id = NEW.session_id AND user_id = (SELECT id FROM auth_users WHERE email = '${email}');` }, async () => {
    const { browser, response } = await signIn(email, password);
    assert.equal(response.status, 401);
    assert.equal((response.json as { code?: string } | null)?.code, 'INVALID_EMAIL_OR_PASSWORD');
    assert.equal([...browser.cookies].some(([name]) => name.endsWith('session_token')), false, 'it set no session cookie');
  });
  assert.equal((await signIn(email, password)).response.status, 200, 'and the next sign-in works');
});
