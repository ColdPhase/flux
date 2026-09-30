import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { schema } from '@flux/db';
import { GITHUB_CALLBACK_PATH } from '@flux/contracts';
import { evaluateProject, enforce, InvalidInputError, ServiceUnavailableError, type Database } from '@flux/core';
import type { SessionContext } from '../identity/index.js';
import type { GithubConfig } from './config.js';
import type { GithubCredentials } from './credentials.js';
import type { GithubTransport } from './http.js';
import { seal, unseal } from './crypto.js';
const stateHash = (state: string) => createHash('sha256').update(state).digest('hex');
export function githubOauth(db: Database, config: GithubConfig, credentials: GithubCredentials, transport: GithubTransport) {
  const flows = schema.githubOauthFlows;
  const envelope = (session: SessionContext, projectId: string, purpose: string, flowId: string) =>
    JSON.stringify(['github-flow:v2', 'github.com', config.appId, config.clientId, config.publicOrigin, session.principal.id, session.sessionId, projectId, purpose, flowId]);
  async function guarded(tx: Parameters<Parameters<Database['transaction']>[0]>[0], session: SessionContext, projectId: string, purpose: 'authorize' | 'install') {
    const [active] = await tx.select({ id: schema.authSessions.id }).from(schema.authSessions).where(and(eq(schema.authSessions.id, session.sessionId),
      eq(schema.authSessions.userId, session.principal.id), gt(schema.authSessions.expiresAt, new Date()))).for('share');
    if (!active) throw new InvalidInputError('Authorization session expired', 'GITHUB_FLOW_INVALID');
    return enforce(await evaluateProject(session.principal, purpose === 'install' ? 'project.manage' : 'project.read', projectId, tx, { lock: true }), 'project').project!;
  }
  return {
    async start(session: SessionContext, projectId: string, purpose: 'authorize' | 'install') {
      if (purpose === 'install' && await credentials.state(session.principal.id) !== 'connected')
        throw new ServiceUnavailableError('Authorize your GitHub account first', 'GITHUB_AUTHORIZATION_REQUIRED');
      const state = randomBytes(32).toString('base64url'); const verifier = randomBytes(32).toString('base64url'); const flowId = randomUUID();
      await db.transaction(async (tx) => {
        const project = await guarded(tx, session, projectId, purpose);
        await tx.insert(flows).values({ stateHash: stateHash(state), id: flowId, userId: session.principal.id, sessionId: session.sessionId,
          workspaceId: project.workspaceId, projectId, purpose, expiresAt: new Date(Date.now() + 600_000),
          encryptedVerifier: purpose === 'authorize' ? seal(config.encryptionKey, verifier, envelope(session, projectId, purpose, flowId)) : null });
      });
      const url = new URL(purpose === 'install' ? `https://github.com/apps/${config.appSlug}/installations/new` : 'https://github.com/login/oauth/authorize');
      url.searchParams.set('state', state);
      if (purpose === 'authorize') {
        url.searchParams.set('client_id', config.clientId); url.searchParams.set('redirect_uri', `${config.publicOrigin}${GITHUB_CALLBACK_PATH}`);
        url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url')); url.searchParams.set('code_challenge_method', 'S256');
      }
      return { url: url.toString() };
    },
    async callback(session: SessionContext, query: { state?: string; code?: string; installation_id?: string }) {
      if (!query.state || !/^[A-Za-z0-9_-]{43}$/.test(query.state)) throw new InvalidInputError('Invalid authorization state', 'GITHUB_FLOW_INVALID');
      const flow = await db.transaction(async (tx) => {
        const [row] = await tx.select().from(flows).where(and(eq(flows.stateHash, stateHash(query.state!)), eq(flows.userId, session.principal.id),
          eq(flows.sessionId, session.sessionId), gt(flows.expiresAt, new Date()), isNull(flows.consumedAt))).for('update');
        if (!row) throw new InvalidInputError('Authorization state expired or was consumed', 'GITHUB_FLOW_INVALID');
        await guarded(tx, session, row.projectId, row.purpose);
        await tx.update(flows).set({ consumedAt: new Date() }).where(eq(flows.stateHash, row.stateHash));
        return row;
      }); // one-use fence commits before sending the external authorization code
      if (flow.purpose === 'authorize') {
        if (!query.code || query.code.length > 1000 || !flow.encryptedVerifier) throw new InvalidInputError('Authorization code is required', 'GITHUB_FLOW_INVALID');
        let verifier: string;
        try { verifier = unseal(config.encryptionKey, flow.encryptedVerifier, envelope(session, flow.projectId, flow.purpose, flow.id)); }
        catch { throw new InvalidInputError('Authorization settings changed; start a new GitHub authorization', 'GITHUB_FLOW_INVALID'); }
        const { data } = await transport.json('https://github.com/login/oauth/access_token', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code: query.code,
            code_verifier: verifier, redirect_uri: `${config.publicOrigin}${GITHUB_CALLBACK_PATH}` }) });
        await credentials.store(session.principal.id, data, async (tx) => { await guarded(tx, session, flow.projectId, flow.purpose); });
      } else if (!query.installation_id) throw new InvalidInputError('Installation selection is required', 'GITHUB_FLOW_INVALID');
      // Installation ID is only a hint; the route verifies it through current provider listing.
      return { projectId: flow.projectId, installationId: flow.purpose === 'install' ? query.installation_id : null };
    },
  };
}
