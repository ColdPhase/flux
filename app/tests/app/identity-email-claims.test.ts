import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@flux/db';
import { createEmailClaims, releasedEmail } from '../../apps/server/src/identity/claim.js';
import { db } from './support/db.js';

// Email-collision takeover attempts (F-024 S5a, #313): a provider identity whose verified email belongs to another
// Flux account. Negative controls: a verified account, a different person's account, an account already linked to
// a provider identity, and a claim that arrives too late or after the holder changed. Nothing may move or link.
const providerId = `oidc-test-${randomUUID().slice(0, 8)}`;
const otherProviderId = `oidc-other-${randomUUID().slice(0, 8)}`;

async function user(email: string, verified: boolean) {
  const id = randomUUID();
  await db.insert(schema.authUsers).values({ id, name: `Person ${id.slice(0, 6)}`, email, emailVerified: verified });
  return id;
}

async function session(userId: string) {
  const id = randomUUID();
  await db.insert(schema.authSessions).values({ id, userId, token: `tok-${id}`, expiresAt: new Date(Date.now() + 3_600_000) });
  return id;
}

async function link(userId: string, provider: string, subject: string) {
  await db.insert(schema.authAccounts).values({ id: randomUUID(), userId, accountId: subject, providerId: provider });
}

async function accountsOf(userId: string) {
  return (await db.select({ providerId: schema.authAccounts.providerId, accountId: schema.authAccounts.accountId })
    .from(schema.authAccounts).where(eq(schema.authAccounts.userId, userId))).sort((a, b) => a.providerId.localeCompare(b.providerId));
}

describe('an identity whose email another account holds', () => {
  test('a verified account is refused: no claim, no link, the account keeps its address and sessions', async () => {
    const email = `verified-${randomUUID().slice(0, 8)}@acme.test`;
    const holder = await user(email, true);
    const sessionId = await session(holder);
    const claims = createEmailClaims(db);
    assert.deepEqual(await claims.holder(providerId, 'sub-new', email), { kind: 'held' });
    const [row] = await db.select({ email: schema.authUsers.email, verified: schema.authUsers.emailVerified }).from(schema.authUsers).where(eq(schema.authUsers.id, holder));
    assert.deepEqual(row, { email, verified: true });
    assert.deepEqual(await accountsOf(holder), []);
    assert.equal((await db.select({ id: schema.authSessions.id }).from(schema.authSessions).where(eq(schema.authSessions.id, sessionId))).length, 1);
  });

  test('a different person who holds the address verified is refused even when they have no password', async () => {
    const email = `someone-${randomUUID().slice(0, 8)}@acme.test`;
    const other = await user(email, true);
    await link(other, otherProviderId, 'sub-other');
    const claims = createEmailClaims(db);
    assert.deepEqual(await claims.holder(providerId, 'sub-intruder', email), { kind: 'held' });
    assert.deepEqual(await accountsOf(other), [{ providerId: otherProviderId, accountId: 'sub-other' }]);
  });

  test('an unverified account that is already linked to a provider identity is not claimable', async () => {
    const email = `linked-${randomUUID().slice(0, 8)}@acme.test`;
    const linked = await user(email, false);
    await link(linked, otherProviderId, 'sub-linked');
    const claims = createEmailClaims(db);
    assert.deepEqual(await claims.holder(providerId, 'sub-intruder', email), { kind: 'held' });
  });

  test('a claim token opened while the holder was unverified refuses once the holder is verified or linked', async () => {
    const email = `late-${randomUUID().slice(0, 8)}@acme.test`;
    const holder = await user(email, false);
    const claims = createEmailClaims(db);
    assert.deepEqual(await claims.holder(providerId, 'sub-intruder', email), { kind: 'unverified', userId: holder });
    const token = await claims.open(providerId, 'sub-intruder', email, holder);
    await db.update(schema.authUsers).set({ emailVerified: true }).where(eq(schema.authUsers.id, holder));
    assert.deepEqual(await claims.claim(token), { refused: 'held' });
    const [row] = await db.select({ email: schema.authUsers.email }).from(schema.authUsers).where(eq(schema.authUsers.id, holder));
    assert.equal(row.email, email, 'the verified address was not released');
  });

  test('a claim after the holder changed its address is refused', async () => {
    const email = `moved-${randomUUID().slice(0, 8)}@acme.test`;
    const holder = await user(email, false);
    const claims = createEmailClaims(db);
    const token = await claims.open(providerId, 'sub-intruder', email, holder);
    await db.update(schema.authUsers).set({ email: `elsewhere-${randomUUID().slice(0, 8)}@acme.test` }).where(eq(schema.authUsers.id, holder));
    assert.deepEqual(await claims.claim(token), { refused: 'changed' });
  });

  test('a claim after its 15 minutes is refused', async () => {
    const email = `stale-${randomUUID().slice(0, 8)}@acme.test`;
    const holder = await user(email, false);
    const later = createEmailClaims(db, () => new Date(Date.now() + 16 * 60_000));
    const token = await createEmailClaims(db).open(providerId, 'sub-intruder', email, holder);
    assert.equal(await later.pending(token), null);
    assert.deepEqual(await later.claim(token), { refused: 'expired' });
  });

  test('an unverified, unlinked account releases the address once, keeps its data, and loses its sessions and connections', async () => {
    const email = `claim-${randomUUID().slice(0, 8)}@acme.test`;
    const holder = await user(email, false);
    const sessionId = await session(holder);
    const claims = createEmailClaims(db);
    const token = await claims.open(providerId, 'sub-new-person', email, holder);
    assert.equal((await claims.pending(token))?.email, email);
    const result = await claims.claim(token);
    assert.deepEqual(result, { claimed: { providerId, email, releasedUserId: holder } });

    const [released] = await db.select({ name: schema.authUsers.name, email: schema.authUsers.email, verified: schema.authUsers.emailVerified })
      .from(schema.authUsers).where(eq(schema.authUsers.id, holder));
    assert.equal(released.email, releasedEmail(holder));
    assert.match(released.email, /@invalid$/, 'the released address sits under the .invalid domain');
    assert.equal(released.verified, false);
    assert.ok(released.name.startsWith('Person '), 'the released account keeps its name and data');
    assert.equal((await db.select({ id: schema.authSessions.id }).from(schema.authSessions).where(eq(schema.authSessions.id, sessionId))).length, 0,
      'the released account is signed out');
    assert.deepEqual(await accountsOf(holder), [], 'nothing was linked to the released account');

    const [audit] = await db.select().from(schema.authEmailClaims).where(eq(schema.authEmailClaims.heldBy, holder));
    assert.equal(audit.state, 'claimed');
    assert.equal(audit.releasedEmail, releasedEmail(holder));
    assert.deepEqual(await claims.claim(token), { refused: 'unknown' }, 'a second claim does nothing');
    assert.equal(await claims.pending(token), null);
  });
});
