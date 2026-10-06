import { randomUUID } from 'node:crypto';
import * as schema from '../schema.js';
import type { createDatabase } from '../index.js';

type Database = Pick<ReturnType<typeof createDatabase>['db'], 'transaction'>;

export interface FixtureOauthClient {
  clientId: string;
  name: string;
  redirectUris: string[];
  scopes: string[];
  /** The protected resource the client's tokens are bound to: the deployment's `/mcp`. */
  resource: string;
}

/**
 * Test deployments only (#287): a public PKCE client linked to the MCP resource, the same rows the
 * API tests insert directly. Browser sessions cannot register clients, so the UI tests, which have
 * no database, register theirs through the integration fixture that calls this.
 */
export function fixtureOauthClientRepository(db: Database) {
  return {
    register(client: FixtureOauthClient): Promise<void> {
      return db.transaction(async (tx) => {
        const now = new Date();
        await tx.insert(schema.oauthClient).values({
          id: randomUUID(), clientId: client.clientId, name: client.name, redirectUris: client.redirectUris,
          tokenEndpointAuthMethod: 'none', grantTypes: ['authorization_code', 'refresh_token'], responseTypes: ['code'],
          scopes: client.scopes, requirePKCE: true, createdAt: now, updatedAt: now,
        });
        await tx.insert(schema.oauthClientResource).values({ id: randomUUID(), clientId: client.clientId, resourceId: client.resource, createdAt: now });
      });
    },
  };
}
