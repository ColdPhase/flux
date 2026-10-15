import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema } from '@flux/db';
import { IdentityAdminError, rekeyIdentity, unlinkIdentity } from '../../apps/server/src/identity/admin.js';
import { oidcProviderId } from '../../apps/server/src/identity/config.js';
import { db, pool } from './support/db.js';

// Operator re-key and last-identity unlink (F-024 S5b, #315). Negative controls: SSO-only mode without the explicit
// flag, a subject another account holds, an email given where an account id belongs, the last sign-in method, and an
// unlink of a link that is not there. Every change that is made leaves one audit row.
const issuer = 'https://idp.example.test/realm/current';
const oldIssuer = 'https://idp.example.test/realm/previous';
const providerId = oidcProviderId(issuer);
const oldProviderId = oidcProviderId(oldIssuer);

async function person(label: string, password: boolean) {
  const id = randomUUID();
  await db.insert(schema.authUsers).values({ id, name: label, email: `${label}-${id.slice(0, 8)}@example.test` });
  if (password) await db.insert(schema.authAccounts).values({ id: randomUUID(), userId: id, accountId: id, providerId: 'credential', password: 'hash' });
  return id;
}

async function link(userId: string, subject: string, identityProviderId = providerId) {
  await db.insert(schema.authAccounts).values({ id: randomUUID(), userId, accountId: subject, providerId: identityProviderId });
}

async function subjects(userId: string) {
  return (await db.select({ accountId: schema.authAccounts.accountId }).from(schema.authAccounts)
    .where(and(eq(schema.authAccounts.userId, userId), eq(schema.authAccounts.providerId, providerId)))).map((r) => r.accountId);
}

async function session(userId: string, method: string) {
  const id = randomUUID();
  await db.insert(schema.authSessions).values({ id, userId, token: `t-${id}`, expiresAt: new Date(Date.now() + 3_600_000) });
  await db.insert(schema.authSessionIdentities).values({ sessionId: id, method });
  return id;
}

async function alive(sessionId: string) {
  return (await db.select({ id: schema.authSessions.id }).from(schema.authSessions).where(eq(schema.authSessions.id, sessionId))).length === 1;
}

async function audits(userId: string) {
  return db.select().from(schema.authIdentityAudit).where(eq(schema.authIdentityAudit.userId, userId));
}

async function refusedWith(run: Promise<unknown>, code: string) {
  await assert.rejects(run, (error: unknown) => error instanceof IdentityAdminError && error.code === code, `refused with ${code}`);
}

describe('operator re-key (#315)', () => {
  test('in SSO-only mode the re-key is refused without the explicit flag, and writes nothing', async () => {
    const user = await person('rekey-sso', true);
    await refusedWith(rekeyIdentity(db, { userId: user, providerId, issuer, subject: 'sub-sso', actor: 'op', reason: 'lost account', mode: 'sso', allowInSso: false }), 'SSO_MODE');
    assert.deepEqual(await subjects(user), []);
    assert.deepEqual(await audits(user), [], 'no audit row for a refused re-key');
  });

  test('with the flag it links the subject, audits the actor and reason, and never matches by email', async () => {
    const user = await person('rekey-ok', true);
    assert.equal(await rekeyIdentity(db, { userId: user, providerId, issuer, subject: 'sub-ok', actor: 'operator-cli', reason: 'cannot link', mode: 'sso', allowInSso: true }), 'linked');
    assert.deepEqual(await subjects(user), ['sub-ok']);
    const [row] = await audits(user);
    assert.deepEqual([row.action, row.oldIssuer, row.newIssuer, row.oldSubject, row.newSubject, row.actor, row.reason, row.mode], ['rekey', null, issuer, null, 'sub-ok', 'operator-cli', 'cannot link', 'sso']);
    // An address is not an account id: the operator cannot name an account by its email (no email matching).
    const target = await db.select({ email: schema.authUsers.email }).from(schema.authUsers).where(eq(schema.authUsers.id, user));
    await refusedWith(rekeyIdentity(db, { userId: target[0].email, providerId, issuer, subject: 'sub-email', actor: 'op', reason: 'by email', mode: 'prepare', allowInSso: false }), 'NO_ACCOUNT');
    assert.deepEqual(await subjects(user), ['sub-ok'], 'the account named by its address was not touched');
  });

  test('a subject another account holds is refused, and nothing moves', async () => {
    const holder = await person('rekey-holder', false);
    const other = await person('rekey-other', true);
    await link(holder, 'sub-held');
    await refusedWith(rekeyIdentity(db, { userId: other, providerId, issuer, subject: 'sub-held', actor: 'op', reason: 'takeover', mode: 'prepare', allowInSso: false }), 'SUBJECT_HELD');
    assert.deepEqual(await subjects(other), []);
    assert.deepEqual(await subjects(holder), ['sub-held'], 'the holder keeps the subject');
  });

  test('a different subject replaces the old one; the account keeps its id, and its sessions end', async () => {
    const user = await person('rekey-replace', true);
    await link(user, 'sub-old');
    const live = await session(user, providerId);
    assert.equal(await rekeyIdentity(db, { userId: user, providerId, issuer, subject: 'sub-new', actor: 'op', reason: 'subject changed', mode: 'prepare', allowInSso: false }), 'rekeyed');
    assert.deepEqual(await subjects(user), ['sub-new']);
    assert.equal(await alive(live), false, 'sessions of the old identity end');
    const [row] = await audits(user);
    assert.deepEqual([row.oldIssuer, row.newIssuer, row.oldSubject, row.newSubject], [issuer, issuer, 'sub-old', 'sub-new'], 'the audit names both issuers and subjects');
  });

  test('an issuer change requires the exact old issuer and moves only that account mapping', async () => {
    const user = await person('rekey-issuer-change', true);
    const other = await person('rekey-issuer-other', true);
    await link(user, 'sub-before', oldProviderId);
    await db.update(schema.authAccounts).set({ accessToken: 'obsolete-access', refreshToken: 'obsolete-refresh', idToken: 'obsolete-id', scope: 'openid' })
      .where(and(eq(schema.authAccounts.userId, user), eq(schema.authAccounts.providerId, oldProviderId)));
    await db.insert(schema.authIdpStanding).values({ userId: user, providerId: oldProviderId, refreshTokenEnc: 'obsolete-sealed-refresh',
      refreshTokenSid: 'old-session', state: 'ok', nextCheckAt: new Date(Date.now() + 60_000) });
    await link(other, 'sub-new-held');
    const live = await session(user, oldProviderId);
    await refusedWith(rekeyIdentity(db, { userId: user, providerId, issuer, subject: 'sub-after', actor: 'operator-cli', reason: 'issuer migration',
      mode: 'prepare', allowInSso: false }), 'OLD_ISSUER_REQUIRED');
    await refusedWith(rekeyIdentity(db, { userId: user, providerId, issuer, oldIssuer: 'https://unrelated.example.test', subject: 'sub-after', actor: 'operator-cli',
      reason: 'wrong historic issuer', mode: 'prepare', allowInSso: false }), 'OLD_IDENTITY_MISMATCH');
    await refusedWith(rekeyIdentity(db, { userId: user, providerId, issuer, oldIssuer, subject: 'sub-new-held', actor: 'operator-cli', reason: 'held target',
      mode: 'prepare', allowInSso: false }), 'SUBJECT_HELD');
    assert.deepEqual(await subjects(user), []);
    const refusedLinks = (await db.select({ providerId: schema.authAccounts.providerId, accountId: schema.authAccounts.accountId }).from(schema.authAccounts)
      .where(eq(schema.authAccounts.userId, user))).map((row) => [row.providerId, row.accountId]).sort();
    assert.deepEqual(refusedLinks, [['credential', user], [oldProviderId, 'sub-before']].sort());
    assert.deepEqual(await audits(user), [], 'refused issuer recoveries write no audit row');
    assert.equal(await rekeyIdentity(db, { userId: user, providerId, issuer, oldIssuer: `${oldIssuer}/`, subject: 'sub-after', actor: 'operator-cli',
      reason: 'provider issuer changed', mode: 'prepare', allowInSso: false }), 'rekeyed');
    const links = await db.select({ providerId: schema.authAccounts.providerId, accountId: schema.authAccounts.accountId }).from(schema.authAccounts)
      .where(eq(schema.authAccounts.userId, user));
    assert.deepEqual(links.filter((row) => row.providerId !== 'credential'), [{ providerId, accountId: 'sub-after' }]);
    const [moved] = await db.select().from(schema.authAccounts).where(and(eq(schema.authAccounts.userId, user), eq(schema.authAccounts.providerId, providerId)));
    assert.deepEqual([moved.accessToken, moved.refreshToken, moved.idToken, moved.scope, moved.confirmedAt], [null, null, null, null, null]);
    assert.equal((await db.select().from(schema.authIdpStanding).where(eq(schema.authIdpStanding.userId, user))).length, 0,
      'an offline refresh token and its old-session state cannot survive issuer replacement');
    assert.equal(await alive(live), false, 'sessions authenticated by the old issuer end');
    const [row] = await audits(user);
    assert.deepEqual([row.oldIssuer, row.newIssuer, row.oldSubject, row.newSubject], [oldIssuer, issuer, 'sub-before', 'sub-after']);
  });

  test('a concurrent ordinary sign-in that claims the target maps to SUBJECT_HELD', async () => {
    const user = await person('rekey-race', true);
    const signer = await person('rekey-race-signer', false);
    await link(user, 'sub-race-before', oldProviderId);
    const held = await pool.connect();
    let open = true;
    try {
      await held.query('BEGIN');
      await held.query('INSERT INTO auth_accounts (id,user_id,account_id,provider_id) VALUES ($1,$2,$3,$4)',
        [randomUUID(), signer, 'sub-race-target', providerId]);
      const recovery = rekeyIdentity(db, { userId: user, providerId, issuer, oldIssuer, subject: 'sub-race-target', actor: 'operator-cli',
        reason: 'issuer migration race', mode: 'prepare', allowInSso: false }).then(
        (value) => ({ value }), (error: unknown) => ({ error }));
      let blocked = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        const waiting = await pool.query(`SELECT 1 FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query ILIKE '%update "auth_accounts"%'`);
        if (waiting.rowCount) { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(blocked, 'the recovery reached its row update while ordinary sign-in held the target unique key');
      await held.query('COMMIT');
      open = false;
      const result = await recovery;
      assert.ok('error' in result && result.error instanceof IdentityAdminError);
      assert.equal((result as { error: IdentityAdminError }).error.code, 'SUBJECT_HELD');
      assert.deepEqual(await subjects(user), [], 'a failed race must not create a current-provider mapping');
      const oldLinks = await db.select({ accountId: schema.authAccounts.accountId }).from(schema.authAccounts)
        .where(and(eq(schema.authAccounts.userId, user), eq(schema.authAccounts.providerId, oldProviderId)));
      assert.deepEqual(oldLinks.map((row) => row.accountId), ['sub-race-before'], 'a failed race leaves the old issuer mapping intact');
      assert.deepEqual(await audits(user), [], 'a failed race writes no audit row');
    } finally {
      if (open) await held.query('ROLLBACK');
      held.release();
    }
  });

  test('an account with several legacy provider links refuses issuer recovery without changing any link', async () => {
    const user = await person('rekey-ambiguous', true);
    await link(user, 'sub-current');
    await link(user, 'sub-other', oldProviderId);
    await refusedWith(rekeyIdentity(db, { userId: user, providerId, issuer, subject: `sub-ambiguous-${randomUUID()}`, actor: 'op', reason: 'ambiguous', mode: 'prepare', allowInSso: false }), 'IDENTITY_AMBIGUOUS');
    const links = await db.select({ providerId: schema.authAccounts.providerId, accountId: schema.authAccounts.accountId }).from(schema.authAccounts)
      .where(eq(schema.authAccounts.userId, user));
    assert.deepEqual(links.filter((row) => row.providerId !== 'credential').map((row) => [row.providerId, row.accountId]).sort(),
      [[oldProviderId, 'sub-other'], [providerId, 'sub-current']].sort());
  });

  test('re-keying to the subject already held is a no-op and writes no audit row', async () => {
    const user = await person('rekey-same', true);
    await link(user, 'sub-same');
    assert.equal(await rekeyIdentity(db, { userId: user, providerId, issuer, subject: 'sub-same', actor: 'op', reason: 'again', mode: 'prepare', allowInSso: false }), 'unchanged');
    assert.deepEqual(await audits(user), []);
  });
});

describe('unlinking a provider identity (#315)', () => {
  test('in SSO-only mode the only sign-in cannot be removed, and the link stays', async () => {
    const user = await person('last-sso', false);
    await link(user, 'sub-last');
    const live = await session(user, providerId);
    await refusedWith(unlinkIdentity(db, { userId: user, providerId, issuer, mode: 'sso', actor: 'owner', reason: 'remove' }), 'LAST_IDENTITY');
    assert.deepEqual(await subjects(user), ['sub-last']);
    assert.equal(await alive(live), true, 'the refused unlink ends nothing');
    assert.deepEqual(await audits(user), []);
  });

  test('in prepare mode a password on the account is the way back, so the link can go and its sessions end', async () => {
    const user = await person('unlink-prepare', true);
    await link(user, 'sub-prepare');
    const viaProvider = await session(user, providerId);
    const viaPassword = await session(user, 'password');
    await unlinkIdentity(db, { userId: user, providerId, issuer, mode: 'prepare', actor: 'owner', reason: 'remove sign-in' });
    assert.deepEqual(await subjects(user), []);
    assert.equal(await alive(viaProvider), false, 'the session that signed in through the identity ends');
    assert.equal(await alive(viaPassword), true, 'the password session continues');
    const [row] = await audits(user);
    assert.deepEqual([row.action, row.oldIssuer, row.newIssuer, row.oldSubject], ['unlink', issuer, null, 'sub-prepare']);
  });

  test('in prepare mode without a password, the provider was the last way in and cannot be removed', async () => {
    const user = await person('unlink-no-password', false);
    await link(user, 'sub-only');
    await refusedWith(unlinkIdentity(db, { userId: user, providerId, issuer, mode: 'prepare', actor: 'owner', reason: 'remove' }), 'LAST_IDENTITY');
    assert.deepEqual(await subjects(user), ['sub-only']);
  });

  test('a link that is not there cannot be removed', async () => {
    const user = await person('unlink-missing', true);
    await refusedWith(unlinkIdentity(db, { userId: user, providerId, issuer, mode: 'prepare', actor: 'owner', reason: 'remove' }), 'NOT_LINKED');
  });
});
