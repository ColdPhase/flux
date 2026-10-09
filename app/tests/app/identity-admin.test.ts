import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema } from '@flux/db';
import { IdentityAdminError, rekeyIdentity, unlinkIdentity } from '../../apps/server/src/identity/admin.js';
import { db } from './support/db.js';

// Operator re-key and last-identity unlink (F-024 S5b, #315). Negative controls: SSO-only mode without the explicit
// flag, a subject another account holds, an email given where an account id belongs, the last sign-in method, and an
// unlink of a link that is not there. Every change that is made leaves one audit row.
const providerId = `oidc-admin-${randomUUID().slice(0, 8)}`;

async function person(label: string, password: boolean) {
  const id = randomUUID();
  await db.insert(schema.authUsers).values({ id, name: label, email: `${label}-${id.slice(0, 8)}@example.test` });
  if (password) await db.insert(schema.authAccounts).values({ id: randomUUID(), userId: id, accountId: id, providerId: 'credential', password: 'hash' });
  return id;
}

async function link(userId: string, subject: string) {
  await db.insert(schema.authAccounts).values({ id: randomUUID(), userId, accountId: subject, providerId });
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
    await refusedWith(rekeyIdentity(db, { userId: user, providerId, subject: 'sub-sso', actor: 'op', reason: 'lost account', mode: 'sso', allowInSso: false }), 'SSO_MODE');
    assert.deepEqual(await subjects(user), []);
    assert.deepEqual(await audits(user), [], 'no audit row for a refused re-key');
  });

  test('with the flag it links the subject, audits the actor and reason, and never matches by email', async () => {
    const user = await person('rekey-ok', true);
    assert.equal(await rekeyIdentity(db, { userId: user, providerId, subject: 'sub-ok', actor: 'operator-cli', reason: 'cannot link', mode: 'sso', allowInSso: true }), 'linked');
    assert.deepEqual(await subjects(user), ['sub-ok']);
    const [row] = await audits(user);
    assert.deepEqual([row.action, row.oldSubject, row.newSubject, row.actor, row.reason, row.mode], ['rekey', null, 'sub-ok', 'operator-cli', 'cannot link', 'sso']);
    // An address is not an account id: the operator cannot name an account by its email (no email matching).
    const target = await db.select({ email: schema.authUsers.email }).from(schema.authUsers).where(eq(schema.authUsers.id, user));
    await refusedWith(rekeyIdentity(db, { userId: target[0].email, providerId, subject: 'sub-email', actor: 'op', reason: 'by email', mode: 'prepare', allowInSso: false }), 'NO_ACCOUNT');
    assert.deepEqual(await subjects(user), ['sub-ok'], 'the account named by its address was not touched');
  });

  test('a subject another account holds is refused, and nothing moves', async () => {
    const holder = await person('rekey-holder', false);
    const other = await person('rekey-other', true);
    await link(holder, 'sub-held');
    await refusedWith(rekeyIdentity(db, { userId: other, providerId, subject: 'sub-held', actor: 'op', reason: 'takeover', mode: 'prepare', allowInSso: false }), 'SUBJECT_HELD');
    assert.deepEqual(await subjects(other), []);
    assert.deepEqual(await subjects(holder), ['sub-held'], 'the holder keeps the subject');
  });

  test('a different subject replaces the old one; the account keeps its id, and its sessions end', async () => {
    const user = await person('rekey-replace', true);
    await link(user, 'sub-old');
    const live = await session(user, providerId);
    assert.equal(await rekeyIdentity(db, { userId: user, providerId, subject: 'sub-new', actor: 'op', reason: 'issuer moved', mode: 'prepare', allowInSso: false }), 'rekeyed');
    assert.deepEqual(await subjects(user), ['sub-new']);
    assert.equal(await alive(live), false, 'sessions of the old identity end');
    const [row] = await audits(user);
    assert.deepEqual([row.oldSubject, row.newSubject], ['sub-old', 'sub-new'], 'the audit names both subjects');
  });

  test('re-keying to the subject already held is a no-op and writes no audit row', async () => {
    const user = await person('rekey-same', true);
    await link(user, 'sub-same');
    assert.equal(await rekeyIdentity(db, { userId: user, providerId, subject: 'sub-same', actor: 'op', reason: 'again', mode: 'prepare', allowInSso: false }), 'unchanged');
    assert.deepEqual(await audits(user), []);
  });
});

describe('unlinking a provider identity (#315)', () => {
  test('in SSO-only mode the only sign-in cannot be removed, and the link stays', async () => {
    const user = await person('last-sso', false);
    await link(user, 'sub-last');
    const live = await session(user, providerId);
    await refusedWith(unlinkIdentity(db, { userId: user, providerId, mode: 'sso', actor: 'owner', reason: 'remove' }), 'LAST_IDENTITY');
    assert.deepEqual(await subjects(user), ['sub-last']);
    assert.equal(await alive(live), true, 'the refused unlink ends nothing');
    assert.deepEqual(await audits(user), []);
  });

  test('in prepare mode a password on the account is the way back, so the link can go and its sessions end', async () => {
    const user = await person('unlink-prepare', true);
    await link(user, 'sub-prepare');
    const viaProvider = await session(user, providerId);
    const viaPassword = await session(user, 'password');
    await unlinkIdentity(db, { userId: user, providerId, mode: 'prepare', actor: 'owner', reason: 'remove sign-in' });
    assert.deepEqual(await subjects(user), []);
    assert.equal(await alive(viaProvider), false, 'the session that signed in through the identity ends');
    assert.equal(await alive(viaPassword), true, 'the password session continues');
    const [row] = await audits(user);
    assert.deepEqual([row.action, row.oldSubject], ['unlink', null]);
  });

  test('in prepare mode without a password, the provider was the last way in and cannot be removed', async () => {
    const user = await person('unlink-no-password', false);
    await link(user, 'sub-only');
    await refusedWith(unlinkIdentity(db, { userId: user, providerId, mode: 'prepare', actor: 'owner', reason: 'remove' }), 'LAST_IDENTITY');
    assert.deepEqual(await subjects(user), ['sub-only']);
  });

  test('a link that is not there cannot be removed', async () => {
    const user = await person('unlink-missing', true);
    await refusedWith(unlinkIdentity(db, { userId: user, providerId, mode: 'prepare', actor: 'owner', reason: 'remove' }), 'NOT_LINKED');
  });
});
