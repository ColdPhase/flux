import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test, type TestContext } from 'node:test';
import { editingSessionRows, editingTransactions, liveEditingRows, liveMapRows, sql,
  type DbExecutor, type EditingConfirmationPolicy } from '@flux/db';
import { db, pool } from './support/db.js';

// Disposable SQL fixtures, like identity-sso-path.test.ts: these are NOT real OIDC/vendor sign-ins.
// Insert immutable session provenance once; only mutable account/standing confirmation is changed.
// The real Keycloak/live socket regression remains separate integration evidence.
const policy: EditingConfirmationPolicy = { providerId: 'oidc-editing-age-test', confirmationMaxAgeMs: 12 * 3_600_000 };
type Who = { actorId: string; sessionId: string };

async function person(t: TestContext, hours: number | null, method = policy.providerId): Promise<Who> {
  const actorId = randomUUID(); const sessionId = randomUUID();
  t.after(() => pool.query('DELETE FROM auth_users WHERE id = $1', [actorId]).then(() => undefined));
  await pool.query('INSERT INTO auth_users (id, name, email, email_verified) VALUES ($1, $2, $3, true)',
    [actorId, 'Editing age fixture', actorId + '@example.test']);
  await pool.query(`INSERT INTO auth_accounts (id, user_id, account_id, provider_id, confirmed_at)
    VALUES ($1, $2, $2, $3, CASE WHEN $4::double precision IS NULL THEN NULL
      ELSE clock_timestamp() - $4 * interval '1 hour' END)`,
    [randomUUID(), actorId, policy.providerId, hours]);
  await pool.query(`INSERT INTO auth_sessions (id, user_id, token, expires_at)
    VALUES ($1, $2, $3, clock_timestamp() + interval '1 day')`, [sessionId, actorId, randomUUID()]);
  await pool.query('INSERT INTO auth_session_identities (session_id, method) VALUES ($1, $2)', [sessionId, method]);
  return { actorId, sessionId };
}

async function finalRecipients(who: Who, allowed: boolean, confirmation: EditingConfirmationPolicy | null = policy,
  executor: DbExecutor = db) {
  // No room/body/codec is needed to exercise the actual final recipient SQL queries.
  // This bounded file does not claim populated producer delivery or socket behavior.
  const noCodec = (): never => { throw new Error('A session fence must not load a codec'); };
  const wiki = await liveEditingRows(executor, noCodec, confirmation)
    .currentPresenceFence(who, randomUUID(), randomUUID());
  const map = await liveMapRows(executor, value => value, confirmation)
    .currentTransientFence(who, randomUUID(), randomUUID());
  assert.equal(wiki.recipientAlive, allowed, 'wiki final recipient fence');
  assert.equal(map.recipientAlive, allowed, 'map final recipient fence');
}

describe('live editing uses current configured provider confirmation', () => {
  test('a fresh provider session passes input and both final recipient fences', async t => {
    const who = await person(t, 1);
    await editingTransactions(pool).run(async tx => {
      const sessions = editingSessionRows(tx, policy);
      assert.equal((await sessions.lock(who))?.id, who.actorId);
      assert.equal((await sessions.current(who))?.id, who.actorId);
      await finalRecipients(who, true, policy, tx);
    }, 'transient');
  });

  test('expired, never-confirmed and missing provider accounts refuse without deleting the session', async t => {
    for (const state of ['expired', 'null', 'missing'] as const) {
      const who = await person(t, state === 'null' ? null : 13);
      if (state === 'missing') {
        await pool.query('DELETE FROM auth_accounts WHERE user_id = $1 AND provider_id = $2', [who.actorId, policy.providerId]);
        // A standing row alone must not turn a deleted account into a valid identity.
        await pool.query('INSERT INTO auth_idp_standing (user_id, provider_id, confirmed_at) VALUES ($1, $2, clock_timestamp())',
          [who.actorId, policy.providerId]);
      }
      await editingTransactions(pool).run(async tx => {
        const sessions = editingSessionRows(tx, policy);
        assert.equal(await sessions.lock(who), null, state);
        assert.equal(await sessions.current(who), null, state);
        await finalRecipients(who, false, policy, tx);
      }, 'transient');
      assert.equal((await pool.query('SELECT 1 FROM auth_sessions WHERE id = $1', [who.sessionId])).rowCount, 1,
        'an authority fence refuses; it does not delete a held session');
    }
  });

  test('the newest account or standing confirmation counts, including a NULL account timestamp', async t => {
    const who = await person(t, null);
    await pool.query(`INSERT INTO auth_idp_standing (user_id, provider_id, confirmed_at)
      VALUES ($1, $2, clock_timestamp() - interval '1 hour')`, [who.actorId, policy.providerId]);
    assert.equal((await editingSessionRows(db, policy).current(who))?.id, who.actorId);
    await finalRecipients(who, true);
    await pool.query("UPDATE auth_idp_standing SET confirmed_at = clock_timestamp() - interval '13 hours' WHERE user_id = $1",
      [who.actorId]);
    assert.equal(await editingSessionRows(db, policy).current(who), null);
    await pool.query("UPDATE auth_accounts SET confirmed_at = clock_timestamp() - interval '1 hour' WHERE user_id = $1",
      [who.actorId]);
    assert.equal((await editingSessionRows(db, policy).current(who))?.id, who.actorId);
    await finalRecipients(who, true);
  });

  test('one fresh provider account cannot conceal another lapsed row for the same user/provider', async t => {
    const who = await person(t, 1);
    await pool.query(`INSERT INTO auth_accounts (id, user_id, account_id, provider_id, confirmed_at)
      VALUES ($1, $2, $3, $4, clock_timestamp() - interval '13 hours')`,
      [randomUUID(), who.actorId, randomUUID(), policy.providerId]);
    assert.equal(await editingSessionRows(db, policy).current(who), null, 'matches confirmation.lapsed: any lapsed row refuses');
    await finalRecipients(who, false);
  });

  test('password sessions and no configured provider retain ordinary lifetimes', async t => {
    const password = await person(t, 13, 'password');
    assert.equal((await editingSessionRows(db, policy).current(password))?.id, password.actorId);
    await finalRecipients(password, true);
    const provider = await person(t, 13);
    assert.equal((await editingSessionRows(db, null).current(provider))?.id, provider.actorId);
    await finalRecipients(provider, true, null);
    // The actor binding and ordinary expiry stay effective even when the provider fence is off.
    await finalRecipients({ ...provider, actorId: randomUUID() }, false, null);
    await pool.query("UPDATE auth_sessions SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [provider.sessionId]);
    assert.equal(await editingSessionRows(db, null).current(provider), null);
    await finalRecipients(provider, false, null);
  });

  test('current and final fences recheck the SQL clock inside the same held transaction', async t => {
    const who = await person(t, 1);
    await editingTransactions(pool).run(async tx => {
      const sessions = editingSessionRows(tx, policy);
      assert.equal((await sessions.lock(who))?.id, who.actorId);
      // Make now() demonstrably stale without a long or guessed timeout.
      await tx.execute(sql`SELECT pg_sleep(0.05)`);
      await tx.execute(sql`UPDATE auth_accounts SET confirmed_at =
        clock_timestamp() - interval '12 hours' - interval '1 millisecond' WHERE user_id = ${who.actorId}`);
      const observation = await tx.execute<{ transactionFresh: boolean; clockFresh: boolean }>(sql`
        SELECT confirmed_at >= now() - interval '12 hours' AS "transactionFresh",
          confirmed_at >= clock_timestamp() - interval '12 hours' AS "clockFresh"
        FROM auth_accounts WHERE user_id = ${who.actorId} AND provider_id = ${policy.providerId}`);
      assert.equal(observation.rows[0]?.transactionFresh, true, 'control: transaction now() would accept');
      assert.equal(observation.rows[0]?.clockFresh, false, 'current SQL time has passed the maximum age');
      assert.equal(await sessions.current(who), null);
      await finalRecipients(who, false, policy, tx);
      const retained = await tx.execute<{ method: string }>(sql`
        SELECT identity.method FROM auth_sessions session
        JOIN auth_session_identities identity ON identity.session_id = session.id WHERE session.id = ${who.sessionId}`);
      assert.equal(retained.rows[0]?.method, policy.providerId, 'session/provenance remain intact while the lock is held');
    }, 'transient');
  });
});

