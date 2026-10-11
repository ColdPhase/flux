import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { schema } from '@flux/db';
import { startIdentity } from '../../apps/server/src/identity/index.js';
import { loadIdentityConfig } from '../../apps/server/src/identity/config.js';
import { mcpResourceIdentifier } from '../../apps/server/src/identity/auth.js';
import { database } from './support/db.js';

// Several API processes start against one database at once (docker/compose.test.yaml runs api and
// api2). Each one must initialize Better Auth without failing on oauth_resource's unique identifier (#316).
describe('identity startup under concurrency', () => {
  test('five API processes starting together converge on one OAuth resource row', async () => {
    // A fresh origin gives this test its own resource identifier, so the row is absent before startup.
    const origin = `https://race-${randomUUID()}.example.test`;
    const identity = loadIdentityConfig({ FLUX_PUBLIC_ORIGIN: origin, FLUX_AUTH_SECRET: randomBytes(32).toString('hex'), FLUX_AUTH_RATE_LIMIT: 'false' });
    const apps = Array.from({ length: 5 }, () => Fastify());
    try {
      await Promise.all(apps.map(async (app) => {
        await startIdentity(app, { db: database.db, config: identity, mailer: null });
        await app.ready();
      }));
    } finally {
      await Promise.all(apps.map((app) => app.close()));
    }
    const rows = await database.db.select({ id: schema.oauthResource.id }).from(schema.oauthResource)
      .where(eq(schema.oauthResource.identifier, mcpResourceIdentifier(origin)));
    assert.equal(rows.length, 1);
  });
});
