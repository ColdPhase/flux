import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { schema } from '@flux/db';
import { createLinkIntents, LINK_TTL_MS } from '../../apps/server/src/identity/link.js';
import { createConfirmation } from '../../apps/server/src/identity/confirmation.js';
import type { OidcConfig } from '../../apps/server/src/identity/config.js';
import { db } from './support/db.js';

// Explicit linking of a password account to the one provider before cutover (F-024 S5b, #315). Negative controls:
// a subject held by another account, an account already linked to another subject, a session that did not start the
// link, an expired or used intent, and an interrupted link that is resumed. Nothing is matched by email.
const providerId = `oidc-link-${randomUUID().slice(0, 8)}`;

async function account(label: string, verified = true) {
  const id = randomUUID();
  await db.insert(schema.authUsers).values({ id, name: label, email: `${label}-${id.slice(0, 8)}@example.test`, emailVerified: verified });
  return id;
}

async function linksOf(userId: string) {
  return (await db.select({ accountId: schema.authAccounts.accountId }).from(schema.authAccounts)
    .where(and(eq(schema.authAccounts.userId, userId), eq(schema.authAccounts.providerId, providerId)))).map((row) => row.accountId);
}

async function intentState(token: string) {
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256').update(token).digest('hex');
  const [row] = await db.select().from(schema.authLinkIntents).where(eq(schema.authLinkIntents.tokenHash, hash));
  return row;
}

describe('linking a password account to the provider before cutover', () => {
  test('an intent links the subject to its own account once, and never to another', async () => {
    const pat = await account('pat');
    const links = createLinkIntents(db);
    const token = await links.open(pat, 'session-pat', providerId);
    const intent = await links.pending(token, 'session-pat', pat);
    assert.ok(intent, 'the same browser session and account may complete the link');
    assert.equal(await links.attach(intent.id, providerId, 'sub-pat'), 'linked');
    assert.deepEqual(await linksOf(pat), ['sub-pat'], 'the subject is linked to the account');
    assert.equal((await intentState(token)).state, 'used');
    assert.equal(await links.attach(intent.id, providerId, 'sub-pat'), 'link_expired', 'an intent is used once');
    assert.equal(await links.pending(token, 'session-pat', pat), null, 'a used intent is not pending');
  });

  test('a provider subject held by another account is refused, and nothing moves', async () => {
    const holder = await account('holder');
    const intruder = await account('intruder');
    const links = createLinkIntents(db);
    await db.insert(schema.authAccounts).values({ id: randomUUID(), userId: holder, accountId: 'sub-held', providerId });
    const token = await links.open(intruder, 'session-intruder', providerId);
    const intent = await links.pending(token, 'session-intruder', intruder);
    assert.ok(intent);
    assert.equal(await links.attach(intent.id, providerId, 'sub-held'), 'identity_held');
    assert.deepEqual(await linksOf(intruder), [], 'the intruder gained nothing');
    assert.deepEqual(await linksOf(holder), ['sub-held'], 'the holder keeps the subject');
    assert.equal((await intentState(token)).state, 'pending', 'the intent stays pending for a retry with another identity');
  });

  test('concurrent links of the same subject give one owner and an identity_held refusal', async () => {
    const first = await account('racing-first'); const second = await account('racing-second');
    const links = createLinkIntents(db);
    const intents = await Promise.all([first, second].map(async (userId) => {
      const token = await links.open(userId, userId, providerId);
      return (await links.pending(token, userId, userId))!;
    }));
    const outcomes = await Promise.all(intents.map((intent) => links.attach(intent.id, providerId, 'sub-racing')));
    assert.deepEqual(outcomes.sort(), ['identity_held', 'linked']);
    assert.equal((await linksOf(first)).length + (await linksOf(second)).length, 1);
  });

  test('a provider sign-in that creates the subject during the link is identity_held, not a server error (N1)', async () => {
    const linker = await account('racing-linker'); const signer = await account('racing-signer');
    const links = createLinkIntents(db);
    const token = await links.open(linker, 'session-linker', providerId);
    const intent = (await links.pending(token, 'session-linker', linker))!;
    // An ordinary provider sign-in does not take the link lock. Its uncommitted row is invisible to the link's read,
    // so the link's insert waits on the (provider, subject) unique index and fails once the sign-in commits.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const signIn = db.transaction(async (tx) => {
      await tx.insert(schema.authAccounts).values({ id: randomUUID(), userId: signer, accountId: 'sub-signing-in', providerId });
      await held;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const outcome = links.attach(intent.id, providerId, 'sub-signing-in');
    for (let i = 0; i < 200; i++) {
      const waiting = await db.execute(sql`SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE 'insert into "auth_accounts"%'`);
      if (waiting.rowCount) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const blocked = await db.execute(sql`SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE 'insert into "auth_accounts"%'`);
    assert.ok((blocked.rowCount ?? 0) >= 1, 'the link reached its insert before the sign-in committed');
    release();
    await signIn;
    assert.equal(await outcome, 'identity_held');
    assert.deepEqual(await linksOf(linker), [], 'the linker gained nothing');
    assert.deepEqual(await linksOf(signer), ['sub-signing-in']);
    assert.equal((await intentState(token)).state, 'pending', 'the intent stays pending');
  });

  test('an account already linked to a different subject at this provider is refused', async () => {
    const pat = await account('pat-two');
    const links = createLinkIntents(db);
    await db.insert(schema.authAccounts).values({ id: randomUUID(), userId: pat, accountId: 'sub-first', providerId });
    const token = await links.open(pat, 'session-two', providerId);
    const intent = await links.pending(token, 'session-two', pat);
    assert.ok(intent);
    assert.equal(await links.attach(intent.id, providerId, 'sub-second'), 'already_linked');
    assert.deepEqual(await linksOf(pat), ['sub-first'], 'no second subject is attached');
  });

  test('a link is bound to the session and account that started it', async () => {
    const pat = await account('pat-three');
    const other = await account('other');
    const links = createLinkIntents(db);
    const token = await links.open(pat, 'session-pat-three', providerId);
    assert.equal(await links.pending(token, 'session-someone-else', pat), null, 'another browser session cannot use it');
    assert.equal(await links.pending(token, 'session-pat-three', other), null, 'another account cannot use it');
    assert.equal(await links.pending('not-a-token', 'session-pat-three', pat), null);
  });

  test('an intent expires after its ten minutes', async () => {
    const pat = await account('pat-four');
    const start = new Date('2026-10-09T10:00:00Z');
    const token = await createLinkIntents(db, () => start).open(pat, 'session-pat-four', providerId);
    const later = createLinkIntents(db, () => new Date(start.getTime() + LINK_TTL_MS + 1000));
    assert.equal(await later.pending(token, 'session-pat-four', pat), null);
  });

  test('an interrupted link is resumed by a new intent, and the abandoned one stays unused', async () => {
    const pat = await account('pat-five');
    const links = createLinkIntents(db);
    const abandoned = await links.open(pat, 'session-pat-five', providerId);
    // The owner closes the provider page; a new link starts from the same session.
    const resumed = await links.open(pat, 'session-pat-five', providerId);
    const abandonedIntent = await links.pending(abandoned, 'session-pat-five', pat);
    assert.ok(abandonedIntent, 'the abandoned intent is still a pending row until it expires');
    const resumedIntent = await links.pending(resumed, 'session-pat-five', pat);
    assert.ok(resumedIntent);
    assert.equal(await links.attach(resumedIntent.id, providerId, 'sub-pat-five'), 'linked');
    assert.deepEqual(await linksOf(pat), ['sub-pat-five']);
    // Completing the abandoned one afterwards links nothing new: the account already holds this subject.
    assert.equal(await links.attach(abandonedIntent.id, providerId, 'sub-pat-five'), 'linked', 'an idempotent repeat of the same subject');
    assert.deepEqual(await linksOf(pat), ['sub-pat-five'], 'still one link');
  });

  test('a link starts the provider confirmation age, so the new link is not lapsed for its MCP connections', async () => {
    const pat = await account('pat-confirmed');
    const links = createLinkIntents(db);
    const token = await links.open(pat, 'session-pat-confirmed', providerId);
    const intent = (await links.pending(token, 'session-pat-confirmed', pat))!;
    assert.equal(await links.attach(intent.id, providerId, 'sub-pat-confirmed'), 'linked');
    const [row] = await db.select({ confirmedAt: schema.authAccounts.confirmedAt }).from(schema.authAccounts)
      .where(and(eq(schema.authAccounts.userId, pat), eq(schema.authAccounts.providerId, providerId)));
    assert.ok(row?.confirmedAt && Date.now() - row.confirmedAt.getTime() < 60_000, 'the provider just vouched for the person');
    const oidc = { providerId, confirmationMaxAgeMs: 7 * 24 * 3_600_000 } as OidcConfig;
    assert.equal(await createConfirmation(db, oidc, undefined, true).lapsed(pat), false, 'the new link is not lapsed');
  });

  test('a new link of a subject the account already holds renews its confirmation', async () => {
    const pat = await account('pat-renewed');
    const old = new Date(Date.now() - 3 * 24 * 3_600_000);
    await db.insert(schema.authAccounts).values({ id: randomUUID(), userId: pat, accountId: 'sub-renewed', providerId, confirmedAt: old });
    const links = createLinkIntents(db);
    const token = await links.open(pat, 'session-pat-renewed', providerId);
    const intent = (await links.pending(token, 'session-pat-renewed', pat))!;
    assert.equal(await links.attach(intent.id, providerId, 'sub-renewed'), 'linked');
    const [row] = await db.select({ confirmedAt: schema.authAccounts.confirmedAt }).from(schema.authAccounts)
      .where(and(eq(schema.authAccounts.userId, pat), eq(schema.authAccounts.providerId, providerId)));
    assert.ok(row?.confirmedAt && Date.now() - row.confirmedAt.getTime() < 60_000, 'the confirmation is now, not three days old');
  });
});
