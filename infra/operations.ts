import { agentAccessOperations, createDatabase } from '@flux/db';

// Maintenance commands of ./flux restore (issue #123), run in the migrate container:
//   node infra/dist/operations.js agent-access         prints active connections and refresh tokens
//   node infra/dist/operations.js revoke-agent-access  revokes every agent connection and OAuth token

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const command = process.argv[2];
const { pool, db } = createDatabase(connectionString);
try {
  if (command === 'agent-access') {
    const status = await agentAccessOperations(db).status();
    console.log(`FLUX_AGENT_ACCESS ${status.activeConnections} ${status.liveRefreshTokens}`);
  } else if (command === 'revoke-agent-access') {
    const revoked = await db.transaction((tx) => agentAccessOperations(tx).revokeAll());
    console.log(`Revoked ${revoked.connections} agent connection(s), ${revoked.refreshTokens} refresh token(s) and ${revoked.accessTokens} access token(s).`);
  } else {
    throw new Error(`unknown operation ${command ?? ''} (use agent-access or revoke-agent-access)`);
  }
} finally {
  await pool.end();
}
