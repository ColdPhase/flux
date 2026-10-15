import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { and, eq } from 'drizzle-orm';
import { schema } from '@flux/db';
import { registerLinkRoutes } from '../../apps/server/src/identity/link-routes.js';
import { createLinkIntents } from '../../apps/server/src/identity/link.js';
import type { SessionResolver } from '../../apps/server/src/identity/session.js';
import { db } from './support/db.js';

// The owner's view of the one provider identity (F-024 S5b, #315): Settings can read whether it is linked, and the
// owner cannot detach the configured provider identity in any mode. A refused removal changes nothing: the link, the
// standing row and the audit trail stay as they were. Operator recovery is the audited command, tested in identity-admin.
const providerId = `oidc-owner-${randomUUID().slice(0, 8)}`;
const provider = { providerId, issuer: 'https://idp.test/realms/owner', label: 'Acme login' };

async function person(label: string) {
  const id = randomUUID();
  await db.insert(schema.authUsers).values({ id, name: label, email: `${label}-${id.slice(0, 8)}@example.test`, emailVerified: true });
  return id;
}

async function linksOf(userId: string) {
  return (await db.select({ accountId: schema.authAccounts.accountId }).from(schema.authAccounts)
    .where(and(eq(schema.authAccounts.userId, userId), eq(schema.authAccounts.providerId, providerId)))).map((row) => row.accountId);
}

async function standingRows(userId: string) {
  return (await db.select({ state: schema.authIdpStanding.state }).from(schema.authIdpStanding)
    .where(and(eq(schema.authIdpStanding.userId, userId), eq(schema.authIdpStanding.providerId, providerId)))).map((row) => row.state);
}

async function auditRows(userId: string) {
  return (await db.select({ id: schema.authIdentityAudit.id }).from(schema.authIdentityAudit)
    .where(eq(schema.authIdentityAudit.userId, userId))).length;
}

/** The owner's session is stubbed: the routes need only the signed-in person and the session id. */
function appFor(userId: string, ssoMode: 'prepare' | 'sso') {
  const app = Fastify();
  const sessions = {
    requirePrincipal: async () => ({ principal: { id: userId }, sessionId: `session-${userId}` }),
    resolveSession: async () => null,
  } as unknown as SessionResolver;
  registerLinkRoutes(app, { db, sessions, links: createLinkIntents(db), provider, ssoMode, publicOrigin: 'http://flux.test' });
  return app;
}

for (const ssoMode of ['prepare', 'sso'] as const) {
  describe(`the configured provider sign-in in ${ssoMode} mode`, () => {
    test('the owner cannot remove it: refused with a 403, and the link, standing row and audit are unchanged', async () => {
      const owner = await person(`owner-${ssoMode}`);
      const subject = `sub-owner-${ssoMode}-${randomUUID().slice(0, 6)}`;
      await db.insert(schema.authAccounts).values({ id: randomUUID(), userId: owner, accountId: subject, providerId });
      await db.insert(schema.authIdpStanding).values({ userId: owner, providerId, state: 'ok', refreshTokenEnc: 'sealed-token', nextCheckAt: new Date() });
      const audit = await auditRows(owner);
      const app = appFor(owner, ssoMode);
      try {
        const response = await app.inject({ method: 'DELETE', url: `/api/v1/identity/links/${providerId}` });
        assert.equal(response.statusCode, 403, response.body);
        assert.equal(response.json().code, 'PROVIDER_IDENTITY_OPERATOR_ONLY');
        assert.match(response.json().error, /host operator/, 'the refusal says who can remove it');
        assert.deepEqual(await linksOf(owner), [subject], 'the provider link stays');
        assert.deepEqual(await standingRows(owner), ['ok'], 'the standing row stays');
        assert.equal(await auditRows(owner), audit, 'no audit row is written for a refused removal');
      } finally { await app.close(); }
    });

    test('the link state is readable by the owner, and another provider id is not found', async () => {
      const linked = await person(`linked-${ssoMode}`);
      const unlinked = await person(`unlinked-${ssoMode}`);
      await db.insert(schema.authAccounts).values({ id: randomUUID(), userId: linked, accountId: `sub-state-${ssoMode}`, providerId });
      const linkedApp = appFor(linked, ssoMode);
      const unlinkedApp = appFor(unlinked, ssoMode);
      try {
        assert.deepEqual((await linkedApp.inject({ method: 'GET', url: `/api/v1/identity/links/${providerId}` })).json(), { providerId, linked: true });
        assert.deepEqual((await unlinkedApp.inject({ method: 'GET', url: `/api/v1/identity/links/${providerId}` })).json(), { providerId, linked: false });
        const other = await linkedApp.inject({ method: 'DELETE', url: '/api/v1/identity/links/oidc-someone-else' });
        assert.equal(other.statusCode, 404);
        assert.equal(other.json().code, 'NOT_LINKED');
        assert.deepEqual(await linksOf(linked), [`sub-state-${ssoMode}`], 'a removal of another provider changes nothing');
      } finally { await linkedApp.close(); await unlinkedApp.close(); }
    });
  });
}
